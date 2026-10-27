"""Q3 fixtures use fake forge/runner effects only; no vendor or credentials."""
import unittest
import copy
import json
import tempfile
from pathlib import Path

import queue_transport as transport
import review_receipt as receipts


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
               "classification": {"counted": True, "outcome": "completed"},
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
