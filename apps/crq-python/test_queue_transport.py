"""Q3 fixtures use fake forge/runner effects only; no vendor or credentials."""
import unittest
import copy
import json
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
        for outcome, category in [("rate_limited", "vendor-rate-limited"), ("auth", "vendor-needs-action"), ("error", "unknown"), ("blocked-secret-scan", "scan")]:
            doc.update(outcome=outcome, counted=False)
            self.q["items"][0]["receipt_id"] = receipts.write_receipt(self.tmp.name, doc)
            result = self.call("status")
            self.assertEqual(result["state"], "blocked")
            self.assertEqual(result["reason"]["category"], category)
            self.assertFalse(result["reviewed"])

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
