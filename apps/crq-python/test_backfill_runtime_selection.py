"""Selection: one-slot refusals, reconciliation passes and stale snapshots.

Split provenance: apps/crq-python/test_backfill_runtime.py was split into
test_backfill_runtime_collector.py, test_backfill_runtime_admission.py,
test_backfill_runtime_observation.py, test_backfill_runtime_selection.py,
test_backfill_runtime_coverage.py, test_backfill_runtime_publish.py,
test_backfill_runtime_quota.py, test_backfill_runtime_events.py and
test_backfill_runtime_fixtures.py.
"""
import copy
import unittest
from types import SimpleNamespace
from unittest import mock

import backfill_jobs as jobs
import backfill_runtime as runtime
import review_ledger as ledger
from test_backfill_jobs import AT
from test_backfill_runtime_fixtures import RuntimeTestBase


class RuntimeTest(RuntimeTestBase):
    def test_select_records_one_refusal_for_all_pending_jobs(self):
        items = []
        for n in range(4):
            job = copy.deepcopy(self.item); job["id"] += "-" + str(n); items.append(job)
        self.q["items"] = items
        self.q["backfill_usage"] = {"successful": True, "remaining": 1, "observed_at": AT, "reflected_reservations": []}
        load = self.snapshots()
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head", [])))
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", return_value=True):
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, True))
        self.assertEqual(len(self.q["backfill_admissions"]), 1)
        self.assertEqual({job["wait_reason"] for job in items}, {"one-slot-reserve"})
        self.assertEqual(load.call_count, 1)  # first pass reads the one shared target once
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", return_value=True):
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, True))
        # Same head and job set: a refusal skips the snapshot pass entirely.
        self.assertEqual(load.call_count, 1)
        self.assertEqual(len(self.q["backfill_admissions"]), 2)

    def test_refusal_still_marks_jobs_done_when_ledger_head_or_jobs_change(self):
        job = copy.deepcopy(self.item); self.q["items"] = [job]
        self.q["backfill_usage"] = {"successful": True, "remaining": 1, "observed_at": AT, "reflected_reservations": []}
        load = self.snapshots()
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head1", [])))
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", side_effect=lambda q, item, at: item["state"] == "pending"):
            runtime.select(self.c, self.q, [], False, None)
            self.assertEqual(job["state"], "pending")
            full = {r["path"]: ledger.intervals(r["intervals"]) for r in job["scope"]}
            load.return_value = (full, [])
            publisher.fetch.return_value = ("head2", [])  # publication covered the job
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
            self.assertEqual(job["state"], "done")
            added = copy.deepcopy(self.item); added["id"] += "-added"; self.q["items"].append(added)
            runtime.select(self.c, self.q, [], False, None)  # a new job is reconciled under the same head
            self.assertEqual(added["state"], "done")
            calls = load.call_count
            # Nothing dispatchable remains: an unchanged refusal pass reports no candidate.
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
            self.assertEqual(load.call_count, calls)

    def test_refusal_reconciles_when_a_job_becomes_eligible_and_ignores_selective_starts(self):
        first = copy.deepcopy(self.item); second = copy.deepcopy(self.item); second["id"] += "-later"
        self.q["items"] = [first, second]
        self.q["backfill_usage"] = {"successful": True, "remaining": 1, "observed_at": AT, "reflected_reservations": []}
        load = self.snapshots()
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head", [])))
        backoff = {second["id"]}
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", side_effect=lambda q, item, at: item["state"] == "pending" and item["id"] not in backoff):
            runtime.select(self.c, self.q, [], False, None)
            recorded = self.q["backfill_coverage_reconciled"]
            runtime.select(self.c, self.q, [], False, first["id"])  # selective start: record untouched
            self.assertEqual(self.q["backfill_coverage_reconciled"], recorded)
            calls = load.call_count
            backoff.clear()  # the backoff expired under the same head and job set
            full = {r["path"]: ledger.intervals(r["intervals"]) for r in second["scope"]}
            load.return_value = (full, [])
            runtime.select(self.c, self.q, [], False, None)
        self.assertGreater(load.call_count, calls)
        self.assertEqual(second["state"], "done")

    def test_job_eligible_only_after_the_loop_passed_it_forces_a_full_pass(self):
        first = copy.deepcopy(self.item); second = copy.deepcopy(self.item); second["id"] += "-mid"
        self.q["items"] = [first, second]
        self.q["backfill_usage"] = {"successful": True, "remaining": 1, "observed_at": AT, "reflected_reservations": []}
        load = self.snapshots()
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head", [])))
        checks = {"n": 0}
        def eligible(q, item, at):
            if item["id"] != second["id"]:
                return True
            checks["n"] += 1
            return checks["n"] > 2  # ineligible for pending and the loop; its backoff expires afterwards
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", side_effect=eligible):
            runtime.select(self.c, self.q, [], False, None)
            calls = load.call_count
            runtime.select(self.c, self.q, [], False, None)
        self.assertGreater(load.call_count, calls)  # not skipped: the eligible set changed
        self.assertEqual(second["wait_reason"], "one-slot-reserve")

    def test_refusal_keeps_missing_evidence_reason(self):
        job = copy.deepcopy(self.item); self.q["items"] = [job]
        self.q["backfill_usage"] = {"successful": True, "remaining": 1, "observed_at": AT, "reflected_reservations": []}
        load = self.snapshots(({}, ["gap"]))
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head", [])))
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", return_value=True):
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
        self.assertEqual(job["wait_reason"], runtime.MISSING_EVIDENCE)
        # A gap is retried off-lock: each pass re-reads the snapshot and re-requests.
        self.assertEqual(load.call_count, 2)
        self.assertNotIn("backfill_coverage_reconciled", self.q)
        request = ledger.loads((self.state / runtime.coverage.REQUEST).read_bytes())
        self.assertEqual(request["targets"], [self.t])

    def test_stale_snapshot_waits_requests_refresh_and_records_no_reconciliation(self):
        first = copy.deepcopy(self.item)
        other = copy.deepcopy(self.item); other["id"] += "-other"; other["target"] = "c" * 40
        self.q["items"] = [first, other]
        self.q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": AT, "reflected_reservations": []}
        self.snapshots(None)
        self.c.launch = mock.Mock()
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head1", [])))
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", return_value=True):
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
        self.c.launch.assert_not_called()
        self.assertEqual({first["wait_reason"], other["wait_reason"]}, {runtime.COVERAGE_PENDING})
        self.assertNotIn("backfill_coverage_reconciled", self.q)
        request = ledger.loads((self.state / runtime.coverage.REQUEST).read_bytes())
        self.assertEqual(request, {"head": "head1", "targets": sorted({self.t, "c" * 40})})

if __name__ == "__main__":
    unittest.main()
