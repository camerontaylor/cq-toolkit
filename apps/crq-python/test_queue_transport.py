"""Q3 fixtures use fake forge/runner effects only; no vendor or credentials."""
import unittest
import copy
import json
import builtins
import io
import os
import sys
import subprocess
from types import SimpleNamespace
from unittest import mock
import tempfile
from pathlib import Path

# This entire fixture module needs no child processes, including local Git.
# Audit events cover absolute executables, shell/executable kwargs and aliases
# captured before a mock could replace subprocess.Popen or os process helpers.
_process_boundary_active = False


def _deny_processes(event, args):
    if _process_boundary_active and event in {
            "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn",
            "os.spawn", "os.fork", "os.forkpty", "pty.spawn"}:
        raise AssertionError("offline queue fixture forbids child processes")


sys.addaudithook(_deny_processes)


def setUpModule():
    global _process_boundary_active
    _process_boundary_active = True


def tearDownModule():
    global _process_boundary_active
    _process_boundary_active = False


import merged_reconcile as reconcile
import queue_transport as transport
import review_receipt as receipts
import capability_dispatcher as dispatcher


class QueueTransportTests(unittest.TestCase):
    def test_process_boundary_denies_absolute_shell_and_local_git_aliases(self):
        run_alias = subprocess.run
        for command, kwargs in (([sys.executable, "-c", "pass"], {}),
                ("true", {"shell": True, "executable": "/bin/sh"}),
                (["/usr/bin/git", "status"], {"cwd": self.tmp.name})):
            with self.subTest(command=command), self.assertRaisesRegex(AssertionError, "forbids child"):
                run_alias(command, **kwargs)
        system_alias = os.system
        with self.assertRaisesRegex(AssertionError, "forbids child"):
            system_alias("true")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.q = {"items": []}
        self.b = {"kind": "deferred-author", "repo": "owner/repo", "producer": "cycle-1",
                  "head": "a" * 40, "target": "merge-queue", "targetSelector": "promoted-main"}
        self.policy = {"enabled": True, "repo": "owner/repo", "targets": ["promoted-main"],
                       "branches": ["merge-queue"], "read": ["developer"], "write": ["developer"]}
        self.forge = {"repo": "owner/repo", "pr": 12, "producer": "cycle-1", "head": "a" * 40,
                      "target": "merge-queue", "state": "MERGED", "mergeSha": "b" * 40}
        class Runner:
            def load_queue(inner): return copy.deepcopy(self.q)
            def save_queue(inner, q): self.q = copy.deepcopy(q)
            def iso(inner): return "2026-10-28T00:00:00Z"
            def with_lock(inner, fn): return fn()
        self.runner = Runner()

    def call(self, op, **extra):
        req = {"v": 1, "op": op, "requestId": getattr(self, "request_id", "request-1"), "binding": self.b, **extra}
        raw = transport.handle(receipts.canonical(req), self.runner, principal="developer",
                               policy=self.policy, verify_source=lambda repo, pr: self.forge,
                               receipt_root=self.tmp.name)
        self.assertLessEqual(len(raw), 8192)
        return json.loads(raw)["result"]

    def merged(self):
        self.call("enqueue")
        self.call("bind", pr=12, mergeSha="b" * 40)
        return self.q["items"][0]

    def receipt(self):
        item = self.merged()
        doc = {"version": 1, "source": item["subject"], "capture": {"target_sha": "c" * 40,
               "target_tree": "d" * 40, "paths": [{"path": "src/a.ts", "disposition": "included"}]},
               "classification": {"counted": True, "outcome": "completed"}, "counted": True, "outcome": "terminal-with-findings",
               "findings": [{"text": "large finding " * 3000}], "artifacts": {},
               "remediation": {"enabled": False}}
        rid = receipts.write_receipt(self.tmp.name, doc)
        item.update(state="done", receipt_id=rid)
        return rid, doc

    def reconciled_fixture(self):
        # Synthetic PR #506 in the Oct27-Oct30 inventory; no live queue data.
        self.b = {"kind": "merged-current", "repo": "owner/repo", "pr": 506,
                  "mergeSha": "b" * 40, "targetSelector": "promoted-main"}
        self.forge["pr"] = 506
        inventory = reconcile.reconcile(None, lambda cursor: {
            "records": [{"number": 506, "mergedAt": "2026-10-28T00:00:00Z",
                         "mergeCommit": {"oid": "b" * 40}, "headRefOid": "a" * 40}],
            "has_next_page": False, "next_cursor": None}, repo="owner/repo",
            after="2026-10-27T00:00:00Z", before="2026-10-30T00:00:00Z", page_budget=1)
        self.request_id = reconcile.enrollment_plan(inventory, repo="owner/repo")["entries"][0]["request_id"]
        item = receipts.enroll(self.q, repo="owner/repo", pr=506, merge_sha="b" * 40,
                               request_id=self.request_id, at="2026-10-28T00:00:00Z")["item"]
        self.policy["reconciled_reads"] = [
            {"principal": "developer", "requestId": self.request_id, "binding": copy.deepcopy(self.b)}]
        return item

    def test_reconciled_read_adopts_without_enqueue_or_review_start(self):
        item = self.reconciled_fixture()
        before = copy.deepcopy(self.q)
        with mock.patch.object(receipts, "enroll", side_effect=AssertionError("no enqueue")):
            pending = self.call("status")
        self.assertEqual(pending["state"], "pending")
        self.assertFalse(pending["reviewed"] or pending["consumed"] or pending["fixed"])
        self.assertEqual(self.q["items"], before["items"])
        self.assertEqual(self.q["merged_current_requests"], before["merged_current_requests"])
        doc = {"version": 1, "request_id": self.request_id, "item_id": item["id"],
               "source": item["subject"], "capture": {}, "counted": True,
               "outcome": "terminal-with-findings", "classification": {"counted": True, "outcome": "completed"},
               "findings": [{"text": "fixture finding"}]}
        rid = receipts.write_receipt(self.tmp.name, doc)
        self.q["items"][0].update(state="done", receipt_id=rid)
        status = self.call("status")
        self.assertTrue(status["reviewed"])
        self.assertFalse(status["consumed"] or status["fixed"])
        manifest = self.call("report", receiptId=rid, cursor=None)["page"]
        for index in range(manifest["chunks"]):
            self.call("report", receiptId=rid, cursor=rid + ":" + str(index))
        ack = self.call("ack", receiptId=rid,
                        **{k: manifest[k] for k in ("sha256", "chunks", "bytes")})
        self.assertTrue(ack["consumed"])
        self.assertFalse(ack["fixed"])

    def test_reconciled_grants_do_not_replace_read_or_write_authority(self):
        self.reconciled_fixture()
        before = copy.deepcopy(self.q)
        grants = self.policy.pop("reconciled_reads")
        with self.assertRaises(ValueError):
            self.call("status")
        self.assertEqual(self.q, before)
        self.policy["reconciled_reads"] = grants
        self.policy["read"] = []
        with self.assertRaises(ValueError):
            self.call("status")
        self.assertEqual(self.q, before)
        self.policy["read"] = ["developer"]
        self.policy["write"] = []
        self.assertEqual(self.call("status")["state"], "pending")
        with self.assertRaises(ValueError):
            self.call("ack", receiptId="a" * 64, sha256="a" * 64, chunks=1, bytes=1)
        self.q["queue_client_requests"][self.request_id]["principal"] = "other"
        with self.assertRaisesRegex(ValueError, "principal mismatch"):
            self.call("status")

    def test_reconciled_policy_and_missing_or_duplicate_items_refuse(self):
        self.reconciled_fixture()
        policy = copy.deepcopy(self.policy)
        for grants in (None, {}, [None], [{}], [{**policy["reconciled_reads"][0], "extra": True}]):
            self.policy = {**policy, "reconciled_reads": grants}
            with self.subTest(grants=grants), self.assertRaises(ValueError):
                self.call("status")
        self.policy = policy
        valid = copy.deepcopy(self.q)
        for items in ([], self.q["items"] * 2):
            self.q = {**copy.deepcopy(valid), "items": items}
            before = copy.deepcopy(self.q)
            with self.assertRaises(ValueError):
                self.call("status")
            self.assertEqual(self.q, before)

    def test_duplicate_reconciled_grant_ids_refuse_before_queue_access(self):
        self.reconciled_fixture()
        grant = self.policy["reconciled_reads"][0]
        for principal in ("developer", "other"):
            self.policy["reconciled_reads"] = [grant, {**grant, "principal": principal}]
            with self.subTest(principal=principal), mock.patch.object(
                    self.runner, "load_queue", side_effect=AssertionError("no queue access")):
                with self.assertRaisesRegex(ValueError, "duplicate reconciled"):
                    self.call("status")

    def test_reconciled_adoption_requires_exact_stored_mapping(self):
        self.reconciled_fixture()
        valid = copy.deepcopy(self.q)
        original = valid["merged_current_requests"][self.request_id]
        for mapping in (None, {**original, "item": "wrong-item"},
                        {**original, "binding": {**original["binding"], "pr": 507}}):
            self.q = copy.deepcopy(valid)
            if mapping is None:
                del self.q["merged_current_requests"][self.request_id]
            else:
                self.q["merged_current_requests"][self.request_id] = mapping
            before = copy.deepcopy(self.q)
            with self.subTest(mapping=mapping), self.assertRaisesRegex(ValueError, "source mismatch"):
                self.call("status")
            self.assertEqual(self.q, before)

    def test_reconciled_adoption_revalidates_merge_identity(self):
        self.reconciled_fixture()
        before = copy.deepcopy(self.q)
        forge = copy.deepcopy(self.forge)
        for key, value in (("mergeSha", "e" * 40), ("state", "OPEN")):
            self.forge = {**forge, key: value}
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "forge merge mismatch"):
                self.call("status")
            self.assertEqual(self.q, before)

    def test_reconciled_adoption_malformed_queue_raises_value_error(self):
        self.reconciled_fixture()
        valid = copy.deepcopy(self.q)
        malformed = [None, [], {k: v for k, v in valid.items() if k != "items"}]
        for key, values in (("items", (None, {}, [None], ["invalid"])),
                            ("merged_current_requests", (None, [])),
                            ("queue_client_requests", (None, []))):
            malformed.extend({**valid, key: value} for value in values)
        for entry in (None, [], "invalid"):
            malformed.append({**valid, "queue_client_requests": {self.request_id: entry}})
        for queue in malformed:
            self.q = copy.deepcopy(queue)
            before = copy.deepcopy(self.q)
            with self.subTest(queue=queue), self.assertRaises(ValueError):
                self.call("status")
            self.assertEqual(self.q, before)

    def test_reconciled_adoption_is_exact_and_denials_are_atomic(self):
        self.reconciled_fixture()
        valid = copy.deepcopy(self.q)
        policy = copy.deepcopy(self.policy)
        for key, value in (("principal", "other"), ("requestId", "other"),
                           ("binding", {**self.b, "pr": 507}),
                           ("binding", {**self.b, "mergeSha": "e" * 40}),
                           ("binding", {**self.b, "targetSelector": "other"}),
                           ("binding", {**self.b, "repo": "other/repo"})):
            self.policy = copy.deepcopy(policy)
            self.policy["reconciled_reads"][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.call("status")
            self.assertEqual(self.q, valid)
        self.policy = policy
        self.forge["target"] = "unapproved"
        with self.assertRaises(ValueError):
            self.call("status")
        self.assertEqual(self.q, valid)
        self.forge["target"] = "merge-queue"
        self.q["items"][0]["subject"]["pr"] = 507
        with self.assertRaises(ValueError):
            self.call("status")

    def test_durable_pre_pr_binding_replay_and_lost_response(self):
        self.assertEqual(self.call("enqueue")["state"], "awaiting-pr")
        self.assertEqual(self.call("enqueue")["state"], "awaiting-pr")
        self.assertEqual(self.call("bind", pr=12, mergeSha=None)["state"], "awaiting-merge")
        self.assertEqual(self.call("bind", pr=12, mergeSha="b" * 40)["state"], "pending")
        self.call("bind", pr=12, mergeSha="b" * 40)
        self.assertEqual(len(self.q["items"]), 1)
        self.assertEqual(self.q["items"][0]["attempts"], [])

    def test_original_pr_only_replay_after_merged_recovery_preserves_ready_state(self):
        self.call("enqueue")
        self.call("bind", pr=12, mergeSha=None)
        self.call("bind", pr=12, mergeSha="b" * 40)
        before = copy.deepcopy(self.q)
        self.assertEqual(before["queue_client_requests"]["request-1"]["state"], "ready-current")
        # Round-trip durable state and re-import the handler to model a restart.
        self.q = json.loads(json.dumps(self.q))
        import importlib
        importlib.reload(transport)
        for _ in range(2):
            result = self.call("bind", pr=12, mergeSha=None)
            self.assertEqual(result["state"], "pending")
            self.assertEqual(result["mergeSha"], "b" * 40)
            self.assertEqual(self.q, before)

    def test_merged_pr_only_replay_revalidates_identity_without_mutation(self):
        self.merged()
        before = copy.deepcopy(self.q)
        original_forge = copy.deepcopy(self.forge)
        for key, value in (("repo", "foreign/repo"), ("pr", 99),
                ("producer", "foreign-author"), ("head", "e" * 40),
                ("target", "main"), ("mergeSha", "e" * 40), ("state", "OPEN")):
            self.forge = {**original_forge, key: value}
            with self.subTest(forge_field=key), self.assertRaises(ValueError):
                self.call("bind", pr=12, mergeSha=None)
            self.assertEqual(self.q, before)
        self.forge = original_forge
        for pr, sha in ((99, None), (12, "e" * 40)):
            with self.subTest(pr=pr, mergeSha=sha), self.assertRaisesRegex(ValueError, "conflicting"):
                self.call("bind", pr=pr, mergeSha=sha)
            self.assertEqual(self.q, before)
        self.policy["write"].append("other-developer")
        raw = receipts.canonical({"v": 1, "op": "bind", "requestId": "request-1",
                                  "binding": self.b, "pr": 12, "mergeSha": None})
        with self.assertRaisesRegex(ValueError, "principal mismatch"):
            transport.handle(raw, self.runner, principal="other-developer", policy=self.policy,
                             verify_source=lambda repo, pr: self.forge, receipt_root=self.tmp.name)
        self.assertEqual(self.q, before)
        for key, value in (("producer", "other-cycle"), ("head", "f" * 40),
                           ("target", "other-target")):
            if key == "target":
                self.policy["branches"].append(value)
            original = self.b[key]
            self.b[key] = value
            with self.subTest(binding_field=key), self.assertRaisesRegex(ValueError, "binding"):
                self.call("bind", pr=12, mergeSha=None)
            self.b[key] = original
            self.assertEqual(self.q, before)

    def test_unauthorized_and_wrong_forge_refuse_without_mutation(self):
        self.policy["write"] = []
        with self.assertRaisesRegex(ValueError, "denied"): self.call("enqueue")
        self.assertEqual(self.q, {"items": []})
        self.policy["write"] = ["developer"]
        self.call("enqueue")
        self.forge["head"] = "e" * 40
        with self.assertRaisesRegex(ValueError, "mismatch"): self.call("bind", pr=12, mergeSha=None)
        self.assertEqual(self.call("status")["state"], "awaiting-pr")

    def test_binding_conflict_cancellation_and_disabled_capability(self):
        self.call("enqueue")
        self.b["head"] = "e" * 40
        with self.assertRaisesRegex(ValueError, "binding"): self.call("status")
        self.b["head"] = "a" * 40
        self.assertEqual(self.call("cancel")["state"], "cancelled")
        with self.assertRaises(ValueError): self.call("bind", pr=12, mergeSha=None)
        self.policy["enabled"] = False
        self.assertIn("unsupported", self.call("status"))

    def malformed_policies(self):
        for enabled in ("false", "true", 1, -1, 0, 1.0, None, {}, {"enabled": True}, [], [True]):
            yield {**self.policy, "enabled": enabled}
        for key in ("read", "write", "targets", "branches"):
            for value in ("developer", {"developer": True}, True, 1, None, [None], [1], [[]], [""]):
                yield {**self.policy, key: value}
        for value in (None, [], "policy", True, 1):
            yield value
        for patch in ({"repo": ["owner/repo"]}, {"targets": ["HEAD"]},
                      {"max_requests": True}, {"max_requests": "10000"}):
            yield {**self.policy, **patch}

    def test_malformed_policy_refuses_before_transport_lock_or_mutation(self):
        policies = list(self.malformed_policies())
        with mock.patch.object(self.runner, "with_lock") as locked:
            for policy in policies:
                self.policy = policy
                for op in ("enqueue", "status"):
                    with self.subTest(policy=policy, op=op), self.assertRaisesRegex(ValueError, "policy"):
                        self.call(op)
                self.assertEqual(self.q, {"items": []})
            locked.assert_not_called()

    def test_only_boolean_true_activates_transport(self):
        self.policy["enabled"] = False
        self.assertIn("unsupported", self.call("enqueue"))
        del self.policy["enabled"]
        self.assertIn("unsupported", self.call("enqueue"))
        self.assertEqual(self.q, {"items": []})
        self.policy["enabled"] = True
        self.assertEqual(self.call("enqueue")["state"], "awaiting-pr")

    def test_dispatcher_refuses_malformed_policy_before_runner_import(self):
        policy_path = Path(self.tmp.name, "policy.json")
        request = receipts.canonical({"v": 1, "op": "enqueue", "requestId": "request-1", "binding": self.b})
        original_import = builtins.__import__
        def offline_import(name, *args, **kwargs):
            if name == "crq":
                raise AssertionError("runner must not be imported")
            return original_import(name, *args, **kwargs)
        for policy in self.malformed_policies():
            policy_path.write_text(json.dumps(policy))
            output = io.BytesIO()
            with self.subTest(policy=policy), mock.patch.dict(os.environ, {
                    "CRQ_QUEUE_POLICY": str(policy_path), "CRQ_QUEUE_PRINCIPAL": "developer",
                    "SSH_ORIGINAL_COMMAND": "queue-v1"}), \
                    mock.patch.object(sys, "argv", ["capability_dispatcher.py"]), \
                    mock.patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(request))), \
                    mock.patch.object(sys, "stdout", SimpleNamespace(buffer=output)), \
                    mock.patch.object(sys, "stderr", io.StringIO()), \
                    mock.patch("signal.signal"), mock.patch("signal.alarm"), \
                    mock.patch("builtins.__import__", side_effect=offline_import) as imports, \
                    mock.patch.object(transport, "handle") as handle:
                self.assertEqual(dispatcher.main(), 2)
                self.assertEqual(output.getvalue(), b"")
                handle.assert_not_called()
                self.assertNotIn("crq", [call.args[0] for call in imports.call_args_list])
        # Well-formed missing/false activation returns bounded unsupported without importing crq.
        for enabled in (False, None):
            policy = {**self.policy, "enabled": False}
            if enabled is None:
                del policy["enabled"]
            policy_path.write_text(json.dumps(policy))
            output = io.BytesIO()
            with mock.patch.dict(os.environ, {"CRQ_QUEUE_POLICY": str(policy_path),
                    "CRQ_QUEUE_PRINCIPAL": "developer"}), \
                    mock.patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(request))), \
                    mock.patch.object(sys, "stdout", SimpleNamespace(buffer=output)), \
                    mock.patch("signal.signal"), mock.patch("signal.alarm"), \
                    mock.patch("builtins.__import__", side_effect=offline_import) as imports:
                self.assertEqual(dispatcher.queue_main(), 0)
                self.assertIn("unsupported", json.loads(output.getvalue())["result"])
                self.assertNotIn("crq", [call.args[0] for call in imports.call_args_list])

    def test_large_receipt_restart_order_snapshot_and_ack(self):
        rid, doc = self.receipt()
        status = self.call("status")
        self.assertEqual(status["state"], "terminal-with-findings")
        self.assertFalse(status["consumed"])
        manifest = self.call("report", receiptId=rid, cursor=None)["page"]
        ack = {"receiptId": rid, **{k: manifest[k] for k in ("sha256", "chunks", "bytes")}}
        with self.assertRaisesRegex(ValueError, "complete"): self.call("ack", **ack)
        with self.assertRaisesRegex(ValueError, "order"): self.call("report", receiptId=rid, cursor=rid + ":1")
        chunks = []
        for i in range(manifest["chunks"]):
            page = self.call("report", receiptId=rid, cursor=f"{rid}:{i}")["page"]
            self.call("report", receiptId=rid, cursor=f"{rid}:{i}")  # reconnect/replay
            chunks.append(transport.base64.b64decode(page["data"]))
        self.assertEqual(json.loads(b"".join(chunks)), doc)
        self.assertTrue(self.call("ack", **ack)["consumed"])
        self.assertFalse(self.call("status")["fixed"])
        with self.assertRaises(ValueError): self.call("report", receiptId=rid, cursor="f" * 64 + ":0")
        Path(self.tmp.name, rid + ".json").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "digest"): self.call("status")

    def test_receipt_request_reads_once_bounded_and_matches_q1_pages(self):
        rid, doc = self.receipt()
        path = Path(self.tmp.name, rid + ".json")
        data = path.read_bytes()
        manifest = receipts.read_receipt(self.tmp.name, rid)
        first = receipts.read_receipt(self.tmp.name, rid, rid + ":0")
        self.assertGreater(manifest["chunks"], 10)
        # Each request gets a fresh verified snapshot, not one full read per page.
        for op, extra, expected in [("status", {}, None),
                ("report", {"receiptId": rid, "cursor": None}, manifest),
                ("report", {"receiptId": rid, "cursor": rid + ":0"}, first)]:
            stream = mock.MagicMock(wraps=io.BytesIO(data))
            stream.__enter__.return_value = stream
            with mock.patch.object(Path, "open", return_value=stream) as opened, \
                    mock.patch.object(receipts, "read_receipt", side_effect=AssertionError("per-page reread")):
                result = self.call(op, **extra)
            opened.assert_called_once_with("rb")
            stream.read.assert_called_once_with(transport.MAX_RECEIPT_BYTES + 1)
            if expected is not None:
                self.assertEqual(result["page"], expected)

    def test_snapshot_pages_stay_bound_and_next_request_rejects_tampering(self):
        rid, doc = self.receipt()
        expected = receipts.read_receipt(self.tmp.name, rid, rid + ":0")
        self.call("report", receiptId=rid, cursor=None)
        original = transport._ReceiptSnapshot.page
        def replace_after_verification(snapshot, cursor=None):
            Path(self.tmp.name, rid + ".json").write_bytes(b"tampered")
            return original(snapshot, cursor)
        with mock.patch.object(transport._ReceiptSnapshot, "page", replace_after_verification):
            self.assertEqual(self.call("report", receiptId=rid, cursor=rid + ":0")["page"], expected)
        with self.assertRaisesRegex(ValueError, "digest"):
            self.call("status")

    def test_snapshot_capacity_and_authorization_fail_before_consumption(self):
        rid, doc = self.receipt()
        before = copy.deepcopy(self.q)
        with mock.patch.object(transport, "MAX_RECEIPT_BYTES", 32):
            with self.assertRaisesRegex(ValueError, "capacity"):
                self.call("report", receiptId=rid, cursor=None)
        self.assertEqual(self.q, before)
        self.policy["read"] = []
        with mock.patch.object(transport, "_ReceiptSnapshot") as snapshot:
            with self.assertRaisesRegex(ValueError, "denied"):
                self.call("report", receiptId=rid, cursor=None)
            snapshot.assert_not_called()
        self.policy["read"] = ["developer"]
        self.b["head"] = "f" * 40
        with mock.patch.object(transport, "_ReceiptSnapshot") as snapshot:
            with self.assertRaisesRegex(ValueError, "binding"):
                self.call("status")
            snapshot.assert_not_called()
        self.assertEqual(self.q, before)

    def test_strict_decode_wire_and_author_protocol_separation(self):
        for raw in [b'{"v":1,"v":1}', b"x" * 8193, b'{"v":2}', b'{"v":1,"op":"fallback"}']:
            with self.assertRaises(ValueError): transport.decode(raw)

    def test_exact_command_dispatch_only(self):
        calls = []
        self.assertEqual(dispatcher.dispatch("author-v1", lambda: calls.append("author") or 0, lambda: 1), 0)
        self.assertEqual(dispatcher.dispatch("queue-v1", lambda: 0, lambda: calls.append("queue") or 1), 1)
        for command in [None, "queue-v1 ", "author-v1; id", "queue-v1 --path=/tmp", "sh"]:
            with self.assertRaises(ValueError): dispatcher.dispatch(command, lambda: 0, lambda: 0)
        self.assertEqual(calls, ["author", "queue"])

    def test_read_write_capabilities_repository_target_and_request_caps(self):
        self.call("enqueue")
        self.policy["read"] = []
        with self.assertRaisesRegex(ValueError, "denied"): self.call("status")
        self.policy["read"] = ["developer"]
        self.policy["targets"] = ["merge-queue"]
        with self.assertRaisesRegex(ValueError, "denied"): self.call("status")
        self.policy["targets"] = ["promoted-main"]
        self.policy["repo"] = "another/repo"
        with self.assertRaisesRegex(ValueError, "denied"): self.call("status")
        self.policy["repo"] = "owner/repo"
        self.policy["branches"] = ["main"]
        with self.assertRaisesRegex(ValueError, "denied"): self.call("status")

    def test_structured_vendor_reason_and_unknown_fail_closed(self):
        rid, doc = self.receipt()
        for outcome, category in [("rate_limited", "unknown"), ("auth", "unknown"), ("action_required", "unknown"), ("error", "unknown"), ("blocked-secret-scan", "scan")]:
            doc.update(outcome=outcome, counted=False)
            self.q["items"][0]["receipt_id"] = receipts.write_receipt(self.tmp.name, doc)
            result = self.call("status")
            self.assertEqual(result["state"], "blocked")
            self.assertEqual(result["reason"]["category"], category)
            self.assertFalse(result["reviewed"])

    def test_legacy_outcomes_and_prose_never_grant_vendor_provenance(self):
        rid, doc = self.receipt()
        for outcome in ("rate_limited", "auth", "action_required", "error", "cancelled", "budget"):
            for classification in (None, {"outcome": outcome, "message": "rate limit login unavailable"},
                    {"outcome": outcome, "errors": [{"errorType": "rate_limit"}, {"errorType": "unknown"}]}):
                with self.subTest(outcome=outcome, classification=classification):
                    doc.update(outcome=outcome, counted=False, classification=classification)
                    self.q["items"][0]["receipt_id"] = receipts.write_receipt(self.tmp.name, doc)
                    result = self.call("status")
                    self.assertEqual(result["state"], "blocked")
                    self.assertEqual(result["reason"]["source"], "queue")
                    self.assertEqual(result["reason"]["category"], "unknown")
                    self.assertFalse(result["reviewed"])

    def test_vendor_provenance_requires_complete_all_causes_proof(self):
        rid, doc = self.receipt()
        vendor = {"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"}
        proof = {"version": 1, "complete": True, "causes": [vendor]}
        cls = {"outcome": "rate_limited", "counted": False, "exit": 1, "bad_lines": 0,
               "failure_provenance": proof}
        doc.update(outcome="rate_limited", counted=False, classification=cls)
        def status():
            self.q["items"][0]["receipt_id"] = receipts.write_receipt(self.tmp.name, doc)
            return self.call("status")
        for exit_code in (0, 1):
            for count in (1, 2, 50):
                with self.subTest(exit=exit_code, causes=count):
                    cls.update(exit=exit_code, failure_provenance={**proof, "causes": [vendor] * count})
                    result = status()
                    self.assertEqual(result["reason"], vendor)
                    self.assertFalse(result["reviewed"])
                    self.assertFalse(result["consumed"])
        # Both cause orders must refuse: no first-error authorization.
        hard_causes = [None, "rate_limit", {}, {**vendor, "extra": True},
            {**vendor, "source": "queue"}, {**vendor, "code": "rate_limit_unknown"},
            {**vendor, "category": "vendor-needs-action"},
        ]
        hard_causes.extend({"source": "queue", "category": "unknown", "code": code}
                           for code in ("unknown", "scan", "budget", "cancel", "auth", "action_required"))
        for hard in hard_causes:
            for causes in ([vendor, hard], [hard, vendor]):
                with self.subTest(causes=causes):
                    cls["failure_provenance"] = {**proof, "causes": causes}
                    self.assertEqual(status()["reason"]["source"], "queue")
        malformed = [None, [], {}, {**proof, "version": True}, {**proof, "version": 2},
            {**proof, "complete": False}, {**proof, "complete": 1},
            {**proof, "extra": True}, {**proof, "causes": []},
            {**proof, "causes": vendor}, {**proof, "causes": "rate_limit"}]
        for value in malformed:
            with self.subTest(proof=value):
                cls["failure_provenance"] = value
                self.assertEqual(status()["reason"]["source"], "queue")
        cls["failure_provenance"] = proof
        for key, values in (("exit", [None, True, 2, -15]), ("bad_lines", [None, True, 1]),
                            ("counted", [None, True, 0]), ("outcome", ["error", "auth", "completed"])):
            original = cls[key]
            for value in values:
                with self.subTest(field=key, value=value):
                    cls[key] = value
                    self.assertEqual(status()["reason"]["source"], "queue")
            cls[key] = original
        for outcome in ("error", "auth", "action_required", "cancelled", "budget", "blocked-secret-scan"):
            doc["outcome"] = outcome
            self.assertEqual(status()["reason"]["source"], "queue")
        doc.update(outcome="rate_limited", counted=True)
        self.assertEqual(status()["reason"]["source"], "queue")
        doc["counted"] = False
        reason = {"source": "queue", "category": "identity", "code": "forge-identity"}
        self.q["queue_client_requests"]["request-1"]["reason"] = reason
        self.assertEqual(status()["reason"], reason)
        self.assertFalse(status()["reviewed"])

    def test_cross_source_reuse_requires_q1_exact_current_identity(self):
        rid, doc = self.receipt()
        paths = [{"source_path": "src/a.ts", "path": "src/a.ts",
                  "resolution": "same-path-current", "disposition": "included"}]
        capture = {"target": "c" * 40, "tree": "d" * 40, "paths": paths,
                   "scope_digest": receipts.digest(paths), "policy": receipts.POLICY,
                   "projection": "current-affected-files/full-file-addition-projection",
                   "reviewer": "coderabbit-review-agent-committed-v1", "reviewer_version": "fixture"}
        capture["equivalence"] = receipts.current_equivalence(capture)
        doc["capture"] = capture
        doc["source"] = {**doc["source"], "pr": 99, "merge_sha": "f" * 40}
        self.q["items"][0].update(receipt_id=receipts.write_receipt(self.tmp.name, doc),
                                   capture=copy.deepcopy(capture), reused_from="original-item")
        self.assertEqual(self.call("status")["state"], "reused")
        self.q["items"][0]["capture"]["tree"] = "e" * 40
        with self.assertRaisesRegex(ValueError, "equivalent"): self.call("status")

    def test_persisted_identity_block_survives_reads_and_exact_revalidation_clears(self):
        self.call("enqueue")
        reason = {"source": "queue", "category": "identity", "code": "forge-identity"}
        self.q["queue_client_requests"]["request-1"]["reason"] = reason
        self.assertEqual(self.call("status")["reason"], reason)
        self.assertEqual(self.call("status")["state"], "blocked")
        self.forge["head"] = "e" * 40
        with self.assertRaises(ValueError): self.call("bind", pr=12, mergeSha=None)
        self.assertEqual(self.call("status")["reason"], reason)
        self.forge["head"] = self.b["head"]
        self.assertIsNone(self.call("bind", pr=12, mergeSha=None)["reason"])
        self.assertEqual(self.call("status")["state"], "awaiting-merge")


    def alias_fixture(self):
        # The original is enrolled directly by Q1, without a queue-client principal.
        item = receipts.enroll(self.q, repo="owner/repo", pr=12, merge_sha="b" * 40,
                               request_id="original-1", at=self.runner.iso())["item"]
        paths = [{"source_path": "a.ts", "path": "a.ts", "resolution": "same-path-current",
                  "disposition": "included", "blob": "a" * 40, "mode": "100644", "bytes": 20}]
        capture = {"target": "c" * 40, "tree": "d" * 40, "paths": paths,
                   "scope_digest": receipts.digest(paths), "policy": receipts.POLICY,
                   "projection": "current-affected-files/full-file-addition-projection",
                   "reviewer": "coderabbit-review-agent-committed-v1", "reviewer_version": "fixture"}
        capture["equivalence"] = receipts.current_equivalence(capture)
        doc = {"version": 1, "item_id": item["id"], "request_id": "original-1",
               "source": copy.deepcopy(item["subject"]), "capture": copy.deepcopy(capture),
               "outcome": "terminal-with-findings", "counted": True,
               "classification": {"counted": True, "outcome": "completed"},
               "findings": [{"severity": "major", "text": "retained " * 1500}]}
        item.update(state="done", capture=capture, receipt_id=receipts.write_receipt(self.tmp.name, doc))
        self.call("enqueue")
        self.call("bind", pr=12, mergeSha="b" * 40)
        return doc

    def test_authenticated_alias_original_q1_principal_and_request_specific_delivery(self):
        doc = self.alias_fixture()
        result = self.call("status")
        proof = result["requestAlias"]
        self.assertEqual(proof["reference"], {"requestId": "request-1", "binding": self.b})
        self.assertEqual(proof["originalRequestId"], "original-1")
        self.assertEqual(proof["itemId"], doc["item_id"])
        self.assertEqual(proof["receiptId"], self.q["items"][0]["receipt_id"])
        self.assertEqual(proof["receiptEquivalence"], receipts.current_equivalence(doc["capture"]))
        self.assertNotIn("original-1", self.q["queue_client_requests"])
        manifest = self.call("report", receiptId=proof["receiptId"], cursor=None)["page"]
        ack = {"receiptId": proof["receiptId"], **{k: manifest[k] for k in ("sha256", "chunks", "bytes")}}
        with self.assertRaisesRegex(ValueError, "complete"): self.call("ack", **ack)
        for index in range(manifest["chunks"]):
            self.call("report", receiptId=proof["receiptId"], cursor=proof["receiptId"] + ":" + str(index))
        consumed = self.call("ack", **ack)
        self.assertTrue(consumed["consumed"])
        self.assertEqual(consumed["requestAlias"], proof)
        self.assertEqual(self.call("ack", **ack)["requestAlias"], proof)
        self.assertEqual(doc["request_id"], "original-1")

    def test_alias_proof_rejects_malformed_mapping_item_source_and_capture(self):
        doc = self.alias_fixture()
        valid = copy.deepcopy(self.q)
        def original(q): del q["merged_current_requests"]["original-1"]
        def alias_binding(q): q["merged_current_requests"]["request-1"]["binding"]["pr"] = 99
        def original_binding(q): q["merged_current_requests"]["original-1"]["binding"]["policy"] = "other"
        def other_item(q): q["merged_current_requests"]["original-1"]["item"] = "other-item"
        def duplicate(q): q["items"].append(copy.deepcopy(q["items"][0]))
        def nondeterministic(q):
            q["items"][0]["id"] = "arbitrary-item"
            for value in q["merged_current_requests"].values(): value["item"] = "arbitrary-item"
        def wrong_kind(q): q["items"][0]["kind"] = "author"
        def wrong_pr(q): q["items"][0]["pr"] = 99
        def wrong_merge(q): q["items"][0]["merge_commit"] = "f" * 40
        def wrong_original(q): q["items"][0]["request_id"] = None
        def wrong_subject(q): q["items"][0]["subject"]["policy"] = "other"
        def stale_capture(q): q["items"][0]["capture"]["tree"] = "f" * 40
        def stale_retained(q): q["items"][0]["capture"]["equivalence"] = "f" * 64
        for mutate in (original, alias_binding, original_binding, other_item, duplicate,
                       nondeterministic, wrong_kind, wrong_pr, wrong_merge, wrong_original,
                       wrong_subject, stale_capture, stale_retained):
            self.q = copy.deepcopy(valid)
            mutate(self.q)
            before = copy.deepcopy(self.q)
            with self.subTest(fault=mutate.__name__), self.assertRaises(ValueError): self.call("status")
            self.assertEqual(self.q, before)
        for field, value in (("request_id", "forged-original"), ("item_id", "other-item"),
                             ("source", {**doc["source"], "policy": "other"})):
            self.q = copy.deepcopy(valid)
            changed = {**doc, field: value}
            self.q["items"][0]["receipt_id"] = receipts.write_receipt(self.tmp.name, changed)
            with self.subTest(document=field), self.assertRaises(ValueError): self.call("status")
        self.q = copy.deepcopy(valid)
        changed = copy.deepcopy(doc)
        changed["capture"]["equivalence"] = "f" * 64
        self.q["items"][0]["receipt_id"] = receipts.write_receipt(self.tmp.name, changed)
        with self.assertRaises(ValueError): self.call("status")

    def test_alias_authorization_identity_pause_and_noncounted_do_not_gain_credit(self):
        doc = self.alias_fixture()
        self.policy["read"] = []
        with self.assertRaisesRegex(ValueError, "denied"): self.call("status")
        self.policy["read"] = ["developer"]
        self.b["head"] = "f" * 40
        with self.assertRaisesRegex(ValueError, "binding"): self.call("status")
        self.b["head"] = "a" * 40
        self.q["queue_client_requests"]["request-1"]["reason"] = {
            "source": "queue", "category": "identity", "code": "forge-identity"}
        blocked = self.call("status")
        self.assertIsNone(blocked.get("requestAlias"))
        self.assertFalse(blocked["reviewed"])
        self.q["queue_client_requests"]["request-1"].pop("reason")
        doc.update(outcome="no-current-code", counted=False, classification={"counted": False})
        self.q["items"][0]["receipt_id"] = receipts.write_receipt(self.tmp.name, doc)
        result = self.call("status")
        self.assertIsNotNone(result["requestAlias"])
        self.assertFalse(result["reviewed"])
        self.assertFalse(result["consumed"])
        self.assertEqual(result["state"], "no-current-code")


def bridge(root, raw):
    """Cross-language offline SDK fixture; each request restarts the server process.

    fixture-tick is a test-only natural-runner stand-in; never a wire operation.
    It publishes Q1 receipt bytes without a provider or remote host.
    """
    root = Path(root)
    queue_path = root / "queue.json"
    q = json.loads(queue_path.read_text()) if queue_path.exists() else {"items": []}
    if raw == b"fixture-tick":
        document = json.loads((root / "fixture-document.json").read_text())
        receipt_id = receipts.write_receipt(root / "receipts", document)
        q["items"][0].update(state="done", receipt_id=receipt_id)
        queue_path.write_bytes(receipts.canonical(q))
        return b"{}"
    class Runner:
        def load_queue(self): return q
        def save_queue(self, value): queue_path.write_bytes(receipts.canonical(value))
        def iso(self): return "2026-10-28T00:00:00Z"
        def with_lock(self, fn):
            import fcntl
            with (root / "tick.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                return fn()
    policy = {"enabled": True, "repo": "owner/repo", "targets": ["promoted-main"],
              "branches": ["merge-queue"], "read": ["developer"], "write": ["developer"]}
    return transport.handle(raw, Runner(), principal="developer", policy=policy,
        verify_source=lambda repo, pr: {"repo": repo, "pr": pr, "target": "merge-queue", "state": "MERGED", "mergeSha": "b" * 40},
        receipt_root=root / "receipts")


class BranchTargetGrammarTests(unittest.TestCase):
    """The deferred target is a git branch, not a request token (PR #580 r4394484110).

    The vectors come from test/fixtures/refname-vectors.json, the same file the
    TypeScript suite reads, so the canonical grammar and this mirror cannot drift.
    """

    VECTORS = json.loads(
        (Path(__file__).resolve().parents[2] / "test" / "fixtures" / "refname-vectors.json")
        .read_text())["vectors"]

    def binding(self, target="merge-queue", producer="cycle-1"):
        return {"kind": "deferred-author", "repo": "owner/repo", "producer": producer,
                "head": "a" * 40, "target": target, "targetSelector": "promoted-main"}

    def test_vector_table_matches_shared_fixture(self):
        for vector in self.VECTORS:
            with self.subTest(rule=vector["rule"], value=vector["value"]):
                fault = transport.branch_fault(vector["value"])
                self.assertEqual(fault is None, vector["accept"],
                                 f"{vector['rule']}: {vector['value']!r} -> {fault}")

    def test_binding_accepts_approved_branch_targets(self):
        accepted = [v for v in self.VECTORS if v["accept"]]
        self.assertTrue(accepted)
        for vector in accepted:
            with self.subTest(value=vector["value"]):
                self.assertEqual(transport.binding(self.binding(target=vector["value"]))["target"],
                                 vector["value"])

    def test_binding_rejects_invalid_branch_targets(self):
        rejected = [v for v in self.VECTORS if not v["accept"]]
        self.assertTrue(rejected)
        for vector in rejected:
            with self.subTest(rule=vector["rule"], value=vector["value"]):
                with self.assertRaises(ValueError):
                    transport.binding(self.binding(target=vector["value"]))

    def test_producer_keeps_token_grammar(self):
        # No request-token widening: the producer keeps the strict QueueToken grammar.
        for producer in ("release/1.4", "a b", "cycle@1"):
            with self.subTest(producer=producer):
                with self.assertRaises(ValueError):
                    transport.binding(self.binding(producer=producer))
        self.assertEqual(transport.binding(self.binding(producer="cycle-1"))["producer"], "cycle-1")

    def test_unapproved_branch_fails_at_allowlist_not_grammar(self):
        # A structurally valid refname that policy does not approve still fails closed,
        # and it fails at the branch allowlist, not at the token grammar.
        binding = self.binding(target="release/1.4")
        self.assertIsNone(transport.branch_fault(binding["target"]))
        self.assertEqual(transport.binding(binding)["target"], "release/1.4")
        request = receipts.canonical({"v": 1, "op": "status", "requestId": "request-1",
                                      "binding": binding})
        policy = {"enabled": True, "repo": "owner/repo", "targets": ["promoted-main"],
                  "branches": ["merge-queue"], "read": ["developer"], "write": ["developer"]}
        with tempfile.TemporaryDirectory() as root:
            def run(inner):
                return inner()
            runner = SimpleNamespace(load_queue=lambda: {"items": []},
                                     save_queue=lambda q: None, iso=lambda: "2026-10-28T00:00:00Z",
                                     with_lock=run)
            with self.assertRaises(ValueError) as caught:
                transport.handle(request, runner, principal="developer", policy=policy,
                                 verify_source=lambda repo, pr: self.fail("must not reach forge"),
                                 receipt_root=root)
        self.assertIn("target branch denied", str(caught.exception))

    def test_unicode_whitespace_parity(self):
        r"""The P2 fix: JS and Python `\s` disagree, so the rule is explicit instead.

        Python's Unicode `\s` matches U+0085 and ECMAScript's matches U+FEFF; neither
        character is forbidden by the shared rule, so both must accept them, while the
        literal space and C0 controls stay refused.
        """
        for value in ("a\u0085b", "a\ufeffb", "a\u00a0b"):
            with self.subTest(accepted=value):
                self.assertIsNone(transport.branch_fault(value))
                self.assertEqual(transport.binding(self.binding(target=value))["target"], value)
        for value in ("a b", "a\u001fb", "a\u007fb", "a\tb"):
            with self.subTest(rejected=value):
                self.assertIsNotNone(transport.branch_fault(value))
                with self.assertRaises(ValueError):
                    transport.binding(self.binding(target=value))
