"""Q3 fixtures use fake forge/runner effects only; no vendor or credentials."""
import unittest
import copy
import json
import builtins
import io
import os
import sys
from types import SimpleNamespace
from unittest import mock
import tempfile
from pathlib import Path

import queue_transport as transport
import review_receipt as receipts
import capability_dispatcher as dispatcher


class QueueTransportTests(unittest.TestCase):
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
        req = {"v": 1, "op": op, "requestId": "request-1", "binding": self.b, **extra}
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

    def test_durable_pre_pr_binding_replay_and_lost_response(self):
        self.assertEqual(self.call("enqueue")["state"], "awaiting-pr")
        self.assertEqual(self.call("enqueue")["state"], "awaiting-pr")
        self.assertEqual(self.call("bind", pr=12, mergeSha=None)["state"], "awaiting-merge")
        self.assertEqual(self.call("bind", pr=12, mergeSha="b" * 40)["state"], "pending")
        self.call("bind", pr=12, mergeSha="b" * 40)
        self.assertEqual(len(self.q["items"]), 1)
        self.assertEqual(self.q["items"][0]["attempts"], [])

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
