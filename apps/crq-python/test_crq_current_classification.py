"""Merged-current failure provenance: mixed causes and producer authority.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import copy
import json
import unittest
from unittest import mock
import review_receipt
import queue_transport
from test_crq_fixtures import (
    CurrentFixture,
    crq,
    setUpModule,
)

class CurrentTest(CurrentFixture, unittest.TestCase):
    def test_prose_auth_and_unknown_mixed_causes_do_not_pause_or_gain_vendor_authority(self):
        initial = copy.deepcopy(self.q)
        vendor = {"type": "error", "errorType": "rate_limit", "recoverable": True}
        for n, code in enumerate(("unknown", "AUTH", "auth_error", "scan", "budget", "cancel")):
            hard = {"type": "error", "errorType": code, "message": "auth login expired"}
            for order, events in enumerate(([vendor, hard], [hard, vendor])):
                with self.subTest(code=code, order=order), \
                     mock.patch.object(crq, "RUNS", self.state / f"not-auth-{n}-{order}"):
                    self.q = copy.deepcopy(initial)
                    crq.save_queue(self.q)
                    item = self.enroll(f"not-auth-{n}-{order}")
                    rdir = self.launch_item(item)
                    self.terminal_artifacts(item, events)
                    self.harvest(item)
                    document = self.document(item)
                    self.assertEqual(document["outcome"], "error")
                    self.assertFalse(document["counted"])
                    self.assertFalse(self.q["paused"])
                    self.assertFalse(queue_transport._vendor_rate_limit(document))
                    self.assertNotIn("cooldown_until", self.q)
                    self.assertNotIn("coverage", self.q)
                    self.assertTrue(any(c["source"] == "queue"
                        for c in document["classification"]["failure_provenance"]["causes"]))

    def test_receipt_preserves_all_classification_causes(self):
        item = self.enroll()
        rdir = self.launch_item(item)
        vendor = {"type": "error", "errorType": "rate_limit", "recoverable": True}
        (rdir / "review.ndjson").write_text(json.dumps(vendor) + "\n" +
            json.dumps({"type": "error", "errorType": "scan"}))
        self.harvest(item)
        document = self.document(item)
        self.assertEqual(document["outcome"], "error")
        self.assertFalse(document["counted"])
        self.assertEqual(document["classification"]["failure_provenance"]["causes"], [
            {"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"},
            {"source": "queue", "category": "unknown", "code": "scan"}])


    def test_persisted_producer_proof_controls_transport_vendor_authority(self):
        initial = copy.deepcopy(self.q)
        vendor = {"type": "error", "errorType": "rate_limit", "recoverable": True}
        hard = {"type": "error", "errorType": "scan"}
        launch_at = crq.now()
        for n, events in enumerate(([vendor], [vendor, hard], [hard, vendor])):
            with self.subTest(events=events), \
                 mock.patch.object(crq, "RUNS", self.state / f"runs-{n}"), \
                 mock.patch.object(crq, "now", return_value=launch_at):
                self.q = copy.deepcopy(initial)
                crq.save_queue(self.q)
                request = f"boundary-{n}"
                item = self.enroll(request)
                self.launch_item(item)
                self.terminal_artifacts(item, events)
                self.harvest(item)
                document = self.document(item)
                self.assertEqual(len(document["classification"]["failure_provenance"]["causes"]), len(events))
                binding = {"kind": "merged-current", "repo": crq.REPO, "pr": 42,
                           "mergeSha": self.merge, "targetSelector": "promoted-main"}
                policy = {"enabled": True, "repo": crq.REPO, "targets": ["promoted-main"],
                          "branches": ["merge-queue"], "read": ["developer"], "write": ["developer"]}
                forge = {"repo": crq.REPO, "pr": 42, "target": "merge-queue",
                         "state": "MERGED", "mergeSha": self.merge}
                def call(op):
                    raw = queue_transport.handle(review_receipt.canonical({"v": 1, "op": op,
                        "requestId": request, "binding": binding}), crq, principal="developer",
                        policy=policy, verify_source=lambda repo, pr: forge,
                        receipt_root=self.state / "receipts")
                    return json.loads(raw)["result"]
                call("enqueue")
                status = call("status")
                self.assertEqual(status["receiptId"], item["receipt_id"])
                self.assertTrue(status["enqueued"])
                self.assertEqual(status["state"], "blocked")
                self.assertFalse(status["reviewed"])
                self.assertFalse(status["fixed"])
                self.assertEqual(status["reason"],
                    {"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"}
                    if n == 0 else {"source": "queue", "category": "unknown", "code": "unclassified"})
