"""Threadless findings, explicit duplicates, transport retry and crash recovery."""
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import finding_delivery as delivery
import review_ledger as ledger
from test_backfill_accounting import Fixture
from test_review_ledger import rehash

AT = "2026-10-30T00:00:00Z"


class FindingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.f = Fixture(self.root / "repo")
        self.t = self.f.commit({"a": b"one\ntwo\n"})
        self.value = self.f.full_review(self.t, "a", [[1, 2]])
        finding = delivery.normalize("crq-runner-app", "run-1", {"severity": "major", "path": "a", "blob": self.f.repo.entries(self.t)["a"]["blob"],
                                       "intervals": [[1, 1]], "title": "Issue", "body": "Details"})
        self.value["payload"]["findings"] = [finding]; rehash(self.value)
        self.fid = finding["id"]
        self.out = ledger.Outbox(self.root / "outbox", self.f.store)
        self.inbox = delivery.Inbox(self.root / "findings", self.out)
        self.inbox.ingest(self.value)

    def test_confirmed_cannot_override_canonical_identity(self):
        self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "reviewer", "valid", AT, canonical_id="foreign")
        row = ledger.loads((self.root / "findings/triage" / (self.fid + ".json")).read_bytes())
        self.assertEqual(row["canonical_id"], self.fid)

    def test_occurrences_never_silently_merge_by_title_path(self):
        finding = self.value["payload"]["findings"][0]
        self.assertNotEqual(delivery.occurrence("crq-runner-app", "run-2", finding), self.fid)
        self.inbox.ingest(self.value)
        self.assertEqual(len(list((self.root / "findings/triage").glob("*.json"))), 1)

    def test_stale_anchor_needs_human_and_fixed_requires_evidence(self):
        current = self.f.commit({"a": b"edited\ntwo\n"})
        event = self.inbox.triage(self.fid, self.f.repo, current, "confirmed", "reviewer", "rechecked", AT)
        self.assertEqual(event["payload"]["action"], "needs-human")
        with self.assertRaises(ledger.IntegrityError):
            self.inbox.deliver(self.fid, lambda *_: {}, AT)
        with self.assertRaises(ledger.IntegrityError):
            self.inbox.triage(self.fid, self.f.repo, current, "fixed", "reviewer", "delivery was acknowledged", AT)

    def test_delivery_transport_retry_and_crash_after_ack_creates_one_task(self):
        self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "reviewer", "still valid at promoted tip", AT)
        tasks = {}
        def transport(key, request):
            tasks.setdefault(key, {"acknowledgement": "receipt", "repair_task": "repair-1"})
            return tasks[key]
        with mock.patch.object(self.out, "spool", side_effect=OSError("crash after receipt persisted")):
            with self.assertRaises(OSError):
                self.inbox.deliver(self.fid, transport, AT)
        receipt = self.inbox.deliver(self.fid, transport, "2026-10-30T01:00:00Z")
        self.assertEqual(len(tasks), 1); self.assertEqual(receipt["repair_task"], "repair-1")
        self.assertEqual(self.inbox.deliver(self.fid, transport, AT), receipt)
        events = [self.value] + sorted(self.out.pending(), key=lambda v: v["occurred_at"])
        ledger.validate_sequence(events)
        row = ledger.loads((self.root / "findings/triage" / (self.fid + ".json")).read_bytes())
        self.assertEqual(row["status"], "delivered")  # acknowledgement never means fixed

    def test_adapter_creates_tick_owned_existing_repair_contract_idempotently(self):
        self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "reviewer", "still valid", AT)
        queue = {"items": []}; saved = []
        transport = delivery.repair_transport(self.root, queue, lambda q: saved.append(ledger.canonical(q)), lambda *_: True)
        receipt = self.inbox.deliver(self.fid, transport, AT)
        self.assertEqual(len(queue["items"]), 1)
        filename = self.root / "state/repair/inbox" / (receipt["repair_task"] + ".json")
        job = ledger.loads(filename.read_bytes())
        self.assertNotIn("thread_id", job)
        self.assertEqual(job["repair_base"], self.t)
        self.assertEqual(job["canonical_finding_id"], self.fid)

    def test_reverse_order_acknowledged_chain_recovers_after_local_state_loss(self):
        filename = self.root / "findings/triage" / (self.fid + ".json")
        before = filename.read_bytes()
        confirmed = self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "reviewer", "still valid", AT)
        self.inbox.deliver(self.fid, lambda *_: {"acknowledgement": "ack", "repair_task": "task"}, AT)
        events = self.out.retained()
        delivered = next(v for v in events if v["payload"]["action"] == "delivered")
        for event in events:
            self.out.acknowledge(event, {v["id"] for v in events})
        ledger.atomic(filename, before)
        self.inbox.recover([delivered, confirmed])
        self.assertEqual(ledger.loads(filename.read_bytes())["status"], "delivered")
        self.assertEqual(self.inbox.deliver(self.fid, lambda *_: self.fail("must reuse receipt"), AT)["repair_task"], "task")


if __name__ == "__main__":
    unittest.main()
