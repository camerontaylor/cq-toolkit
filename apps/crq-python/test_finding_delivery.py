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

    def test_retry_chain_terminates_and_replays_without_extra_jobs(self):
        queue = {"items": []}
        transport = delivery.repair_transport(self.root, queue, lambda q: None, lambda *_: True,
                                              max_rounds_per_pin=4, scan_instructions=lambda *_: True)
        for attempt in range(3):
            self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "crq-triage/judge", "valid", AT,
                              failure_class="evidence")
            receipt = self.inbox.deliver(self.fid, transport, AT)
            self.assertEqual(self.inbox.deliver(self.fid, transport, AT), receipt)
            self.inbox.repair_outcome(self.fid, receipt["repair_task"], "needs-retriage", "attempt failed", AT,
                                      failure_class="exhausted", max_finding_retries=2)
            row = ledger.loads((self.inbox.root / "triage" / (self.fid + ".json")).read_bytes())
            self.assertEqual(row["status"], "needs-human" if attempt == 2 else "needs-retriage")
        self.assertEqual(len(queue["items"]), 3)
        self.assertEqual(row["failure_class"], "exhausted")

    def test_per_pin_ceiling_and_existing_job_replay(self):
        queue = {"items": []}
        transport = delivery.repair_transport(self.root, queue, lambda q: None, lambda *_: True,
                                              max_rounds_per_pin=2, scan_instructions=lambda *_: True)
        self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "judge", "valid", AT)
        first = self.inbox.deliver(self.fid, transport, AT)
        first_request = ledger.loads((self.inbox.root / "delivery" / (self.fid + ".json")).read_bytes())
        self.inbox.repair_outcome(self.fid, first["repair_task"], "needs-retriage", "failed", AT,
                                  failure_class="exhausted")
        self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "judge", "valid", AT)
        second = self.inbox.deliver(self.fid, transport, AT)
        self.assertEqual(transport(self.fid, first_request), first)
        self.inbox.repair_outcome(self.fid, second["repair_task"], "needs-retriage", "failed again", AT,
                                  failure_class="exhausted")
        self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "judge", "valid", AT)
        with self.assertRaises(delivery.RepairRoundCeiling):
            self.inbox.deliver(self.fid, transport, AT)
        self.assertEqual(len(queue["items"]), 2)
        other = {**first_request, "canonical_id": "f" * 64, "finding_id": "f" * 64}
        self.assertTrue(transport("other", other)["repair_task"])
        new_pin = {**first_request, "target": "a" * 40}
        self.assertTrue(transport("new-pin", new_pin)["repair_task"])

    def test_retry_guidance_scan_refusal_does_not_create_job(self):
        queue = {"items": []}
        transport = delivery.repair_transport(self.root, queue, lambda q: None, lambda *_: True,
                                              scan_instructions=lambda *_: False)
        self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "judge", "valid", AT)
        first = self.inbox.deliver(self.fid, transport, AT)
        self.inbox.repair_outcome(self.fid, first["repair_task"], "needs-retriage", "prior attempt", AT,
                                  failure_class="exhausted")
        self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "judge", "valid", AT)
        with self.assertRaisesRegex(ledger.IntegrityError, "instructions secret scan"):
            self.inbox.deliver(self.fid, transport, AT)
        self.assertEqual(len(list((self.root / "state/repair/inbox").glob("*.json"))), 1)

    def test_retry_rejects_retained_manifest_with_wrong_source(self):
        import hashlib
        import json
        self.inbox = delivery.Inbox(self.root / 'state/backfill/findings', self.out)
        self.inbox.ingest(self.value)
        queue = {"items": []}
        transport = delivery.repair_transport(self.root, queue, lambda q: None, lambda *_: True,
                                              scan_instructions=lambda *_: True)
        self.inbox.triage(self.fid, self.f.repo, self.t, 'confirmed', 'judge', 'valid', AT)
        job = self.inbox.deliver(self.fid, transport, AT)['repair_task']
        self.inbox.repair_outcome(self.fid, job, 'needs-retriage', 'failed', AT,
                                  failure_class='exhausted', repair_base=self.t)
        manifest = {'base': 'f' * 40, 'commits': [], 'untracked': [], 'sha256': {}}
        token = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        path = self.root / 'state/repair' / job / ('retained-' + token) / 'manifest.json'
        ledger.atomic(path, ledger.canonical(manifest))
        self.inbox.triage(self.fid, self.f.repo, self.t, 'confirmed', 'judge', 'valid', AT)
        with self.assertRaisesRegex(ledger.IntegrityError, 'source binding'):
            self.inbox.deliver(self.fid, transport, AT)

    def test_unchanged_source_evidence_survives_event_replay(self):
        evidence = [{"path": "a", "line": 1, "quoted_text": "one", "target": self.t}]
        self.inbox.repair_outcome(self.fid, "unchanged", "dismissed", "not a defect", AT,
                                  source_evidence=evidence)
        event = next(v for v in self.out.retained() if v["event_type"] == "finding-event")
        self.assertEqual(event["payload"]["evidence"]["source_evidence"], evidence)
        before = self.out.retained()
        self.inbox.repair_outcome(self.fid, "unchanged", "dismissed", "not a defect", AT,
                                  source_evidence=evidence)
        self.assertEqual(self.out.retained(), before)

    def test_repair_outcome_is_durable_idempotent_and_recoverable(self):
        filename = self.root / "findings/triage" / (self.fid + ".json")
        chain = [self.value]
        for action in ("needs-retriage", "needs-human", "dismissed", "fixed"):
            before = filename.read_bytes()
            self.inbox.repair_outcome(self.fid, "job-" + action, action, "repair evidence", AT,
                                      fixing_commit=self.t if action == "fixed" else None,
                                      fix_pr="https://github.com/example/repo/pull/1")
            events = self.out.retained()
            count = len(events)
            chain.append(next(v for v in events if v["id"] == ledger.loads(filename.read_bytes())["previous_event_id"]))
            ledger.atomic(filename, before)
            self.inbox.repair_outcome(self.fid, "job-" + action, action, "repair evidence", AT,
                                      fixing_commit=self.t if action == "fixed" else None,
                                      fix_pr="https://github.com/example/repo/pull/1")
            self.assertEqual(len(self.out.retained()), count)
            self.assertEqual(ledger.loads(filename.read_bytes())["status"], action)
        ledger.validate_sequence(chain)

    def test_retriage_delivery_creates_fresh_job_preserving_canonical_provenance(self):
        self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "judge", "valid", AT)
        queue = {"items": []}
        transport = delivery.repair_transport(self.root, queue, lambda q: None, lambda *_: True,
                                              scan_instructions=lambda *_: True)
        first = self.inbox.deliver(self.fid, transport, AT)
        self.inbox.repair_outcome(self.fid, first["repair_task"], "needs-retriage", "stale", AT)
        self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "judge", "valid again", AT)
        second = self.inbox.deliver(self.fid, transport, AT)
        self.assertNotEqual(first["repair_task"], second["repair_task"])
        self.assertEqual(self.inbox.deliver(self.fid, transport, AT), second)
        job = ledger.loads((self.root / "state/repair/inbox" / (second["repair_task"] + ".json")).read_bytes())
        self.assertEqual(job["canonical_finding_id"], self.fid)
        self.assertIn("Prior attempt reason: stale", job["fix_instructions"])
        self.assertIn("Retained diff summary:", job["fix_instructions"])
        self.assertEqual(job["prior_repair_task"], first["repair_task"])
        self.assertEqual(len(queue["items"]), 2)
        self.assertEqual(next(iter(queue["items"][0]["repair_runs"].values()))["state"], "stale")
        before = self.out.retained()
        self.inbox.repair_outcome(self.fid, first["repair_task"], "needs-human", "late old failure", AT)
        self.assertEqual(self.out.retained(), before)

    def test_changed_request_without_receipt_preserves_possibly_accepted_task(self):
        self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "judge", "valid", AT)
        queue = {"items": []}
        transport = delivery.repair_transport(self.root, queue, lambda q: None, lambda *_: True)
        def interrupted(key, request):
            transport(key, request)
            raise OSError("crash after durable task before receipt")
        with self.assertRaises(OSError):
            self.inbox.deliver(self.fid, interrupted, AT)
        original = (self.root / "findings/delivery" / (self.fid + ".json")).read_bytes()
        tip = self.f.commit({"a": b"one\ntwo\n", "b": b"new tip\n"})
        self.inbox.triage(self.fid, self.f.repo, tip, "confirmed", "judge", "still valid at new tip", AT)
        receipt = self.inbox.deliver(self.fid, transport, AT)
        self.assertNotEqual(receipt["repair_task"], "crq-backfill-" + self.fid)
        self.assertEqual((self.root / "findings/delivery" / (self.fid + ".json")).read_bytes(), original)
        self.assertEqual(len(queue["items"]), 2)
        self.assertEqual(next(iter(queue["items"][0]["repair_runs"].values()))["state"], "stale")
        self.assertEqual(queue["items"][0]["state"], "done")
        self.assertEqual(self.inbox.deliver(self.fid, transport, AT), receipt)

    def test_replacement_retires_prepared_publication_but_preserves_known_pr(self):
        import repair_tick
        from types import SimpleNamespace
        queue = {"items": []}
        transport = delivery.repair_transport(self.root, queue, lambda q: None, lambda *_: True)
        request = {"canonical_id": self.fid, "target": self.t, "path": "a", "intervals": [[1, 1]],
                   "finding": self.value["payload"]["findings"][0], "review_id": self.value["id"]}
        receipt = transport("old-generation", request)
        old_item = queue["items"][0]
        old_run = next(iter(old_item["repair_runs"].values()))
        publication = {"head": self.t, "open_pr": False}
        old_run.update(state="publish_failed", publication=publication)
        journal = self.root / "state/repair" / receipt["repair_task"] / "publication.json"
        ledger.atomic(journal, ledger.canonical(publication))
        before = journal.read_bytes()
        transport("new-generation", request)
        self.assertEqual(old_run["state"], "stale")
        self.assertEqual(old_item["state"], "done")
        self.assertEqual(journal.read_bytes(), before)
        self.assertEqual(next(iter(queue["items"][1]["repair_runs"].values()))["state"], "queued")
        with mock.patch.object(repair_tick, "publish") as publish:
            repair_tick.harvest(SimpleNamespace(STATE=self.root / "state"), queue, old_item)
            publish.assert_not_called()
        old_run.update(state="publish_failed", fix_pr={"number": 9})
        old_item["state"] = "repairing"
        transport("new-generation", request)
        self.assertEqual(old_run["state"], "publish_failed")
        self.assertEqual(old_item["state"], "repairing")

    def legacy_finding(self, events):
        finding = self.value["payload"]["findings"][0]
        finding.update(intervals=[], anchor_status="unverified")
        self.value["payload"]["artifacts"] = [self.f.store.put(
            b"\n".join(ledger.canonical(v) for v in events))]
        rehash(self.value)
        filename = self.root / "findings/triage" / (self.fid + ".json")
        row = ledger.loads(filename.read_bytes())
        row.update(review_id=self.value["id"], finding=finding)
        ledger.atomic(filename, ledger.canonical(row))
        return filename, filename.read_bytes()

    def raw_finding(self, **changes):
        return dict(type="finding", fileName="a", title="Issue", comment="Details",
                    **changes)

    def test_recovered_anchor_replay_repeated_triage_and_delivery_keep_identity(self):
        filename, before = self.legacy_finding([self.raw_finding(startLine=2, endLine=2)])
        original = ledger.canonical(self.value)
        event = self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "reviewer", "valid", AT,
                                  reviews=[self.value])
        self.assertEqual(event["payload"]["action"], "confirmed")
        evidence = event["payload"]["evidence"]
        self.assertEqual(evidence["anchor_recovered_from"], self.value["payload"]["artifacts"][0]["sha256"])
        ledger.atomic(filename, before)  # Crash after event spool, before row write.
        self.inbox.recover([event])
        self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "reviewer", "again", AT)
        row = ledger.loads(filename.read_bytes())
        self.assertEqual(row["mapped_intervals"], [[2, 2]])
        self.assertEqual(row["finding"]["intervals"], [])
        self.assertEqual(row["finding"]["id"], self.fid)
        self.assertEqual(ledger.canonical(self.value), original)
        requests = []
        self.inbox.deliver(self.fid, lambda key, request: requests.append(request) or
                           {"acknowledgement": "ack", "repair_task": "task"}, AT)
        self.assertEqual(requests[0]["intervals"], [[2, 2]])
        self.inbox.ingest(self.value)

    def test_missing_ambiguous_mismatched_or_out_of_bounds_anchor_needs_human(self):
        raw = self.raw_finding(startLine=1)
        for events in ([], [raw, raw], [dict(raw, comment="Different")],
                       [dict(raw, startLine=3)], [dict(raw, startLine=True)],
                       [dict(raw, startLine="1", endLine=2)],
                       [dict(raw, startLine=-1, endLine=2)],
                       [dict(raw, startLine=1, endLine=None)]):
            with self.subTest(events=events):
                filename, _ = self.legacy_finding(events)
                event = self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "reviewer", "valid", AT,
                                          reviews=[self.value])
                self.assertEqual(event["payload"]["action"], "needs-human")
                self.assertNotIn("recovered_anchor", ledger.loads(filename.read_bytes()))

    def test_corrupt_or_missing_raw_artifact_needs_human(self):
        for missing in (False, True):
            filename, _ = self.legacy_finding([self.raw_finding(startLine=1)])
            reference = self.value["payload"]["artifacts"][0]
            artifact = Path(reference["location"])
            if missing:
                artifact.unlink()
            else:
                artifact.write_bytes(b"corrupted")
            event = self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "reviewer", "valid", AT,
                                      reviews=[self.value])
            self.assertEqual(event["payload"]["action"], "needs-human")
            if artifact.exists():
                artifact.unlink()

    def test_prepared_handoff_is_durable_and_rejects_obsolete_origin(self):
        self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "judge", "valid", AT)
        self.inbox.deliver(self.fid, lambda *_: {"acknowledgement": "ack", "repair_task": "old-task"}, AT)
        filename = self.inbox.root / "triage" / (self.fid + ".json")
        before = filename.read_bytes()
        job = {"job": "prepared-task", "canonical_finding_id": self.fid, "origin_job": "old-task"}
        with self.assertRaisesRegex(ledger.IntegrityError, "identity mismatch"):
            self.inbox.handoff(self.fid, "old-task", {**job, "canonical_finding_id": "other"}, AT)
        with self.assertRaisesRegex(ledger.IntegrityError, "identity mismatch"):
            self.inbox.handoff(self.fid, "old-task", {**job, "origin_job": "other"}, AT)
        self.inbox.handoff(self.fid, "old-task", job, AT)
        count = len(self.out.retained())
        ledger.atomic(filename, before)
        self.inbox.handoff(self.fid, "old-task", job, AT)
        self.assertEqual(len(self.out.retained()), count)
        self.assertEqual(ledger.loads(filename.read_bytes())["receipt"]["repair_task"], "prepared-task")
        self.inbox.repair_outcome(self.fid, "old-task", "needs-human", "obsolete", AT)
        self.assertEqual(len(self.out.retained()), count)
        self.inbox.repair_outcome(self.fid, "prepared-task", "needs-human", "current result", AT)
        self.assertEqual(ledger.loads(filename.read_bytes())["status"], "needs-human")
        with self.assertRaisesRegex(ledger.IntegrityError, "no longer owns"):
            self.inbox.handoff(self.fid, "old-task", {**job, "job": "obsolete-successor"}, AT)

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

    def test_outcome_events_without_target_replay_preserving_current_anchor(self):
        filename = self.root / "findings/triage" / (self.fid + ".json")
        confirmed = self.inbox.triage(self.fid, self.f.repo, self.t, "confirmed", "reviewer", "valid", AT)
        before = filename.read_bytes()
        for action in ("needs-retriage", "fixed", "dismissed", "needs-human"):
            with self.subTest(action=action):
                ledger.atomic(filename, before)
                evidence = {"reason": "repair outcome", "fixing_commit": self.t, "verification": "merged"}
                event = ledger.event("finding-event", "outcome:" + action, AT,
                                     {"finding_id": self.fid, "review_id": self.value["id"],
                                      "previous_event_id": confirmed["id"], "action": action,
                                      "evidence": evidence, "actor": "crq-repair"})
                self.inbox.recover([event])
                row = ledger.loads(filename.read_bytes())
                self.assertEqual(row["status"], action)
                self.assertEqual(row["previous_event_id"], event["id"])
                self.assertEqual(row["target_current"], self.t)
                self.assertEqual(row["mapped_path"], "a")
                self.assertEqual(row["mapped_intervals"], [[1, 1]])
                self.inbox.recover([event])
                self.assertEqual(ledger.loads(filename.read_bytes()), row)

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
