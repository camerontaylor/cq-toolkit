"""Quota reflection, terminal holds and verified quota refusals.

Split provenance: apps/crq-python/test_backfill_runtime.py was split into
test_backfill_runtime_collector.py, test_backfill_runtime_admission.py,
test_backfill_runtime_observation.py, test_backfill_runtime_selection.py,
test_backfill_runtime_coverage.py, test_backfill_runtime_publish.py,
test_backfill_runtime_quota.py, test_backfill_runtime_events.py and
test_backfill_runtime_fixtures.py.
"""
import unittest
from unittest import mock

import backfill_jobs as jobs
import backfill_runtime as runtime
import review_ledger as ledger
from test_backfill_jobs import AT
from test_backfill_runtime_fixtures import RuntimeTestBase


class RuntimeTest(RuntimeTestBase):
    def test_vendor_progress_alone_does_not_prove_usage_reflection_and_terminal_window_expires(self):
        jobs.admission(self.q, self.item, AT, {"successful": True, "remaining": 2, "observed_at": AT}, False)
        self.item["run"] = {"started_at": AT, "vendor_observed": True}
        runtime.usage_context(self.c, self.q, {"remaining": 2}, [])
        self.assertEqual(self.q["backfill_usage"]["reflected_reservations"], [])
        jobs.terminal(self.q, self.item, AT, "error", vendor_terminal=True)
        self.c.iso = lambda: "2026-10-30T01:00:00Z"
        runtime.usage_context(self.c, self.q, {"remaining": 8, "rollingWindowMs": 3600000}, [])
        self.assertEqual(self.q["backfill_reservations"][self.item["attempt_id"]]["quota_state"], "expired")

    def test_vendor_terminal_hold_is_not_subtracted_twice_after_a_successful_probe(self):
        jobs.admission(self.q, self.item, AT, {"successful": True, "remaining": 2, "observed_at": AT}, False)
        key = self.item["attempt_id"]
        jobs.terminal(self.q, self.item, AT, "completed", vendor_terminal=True)
        self.c.iso = lambda: "2026-10-30T00:10:00Z"
        runtime.usage_context(self.c, self.q, {"remaining": 3, "rollingWindowMs": 3600000}, [])
        self.assertEqual(self.q["backfill_usage"]["reflected_reservations"], [key])
        self.assertEqual(self.q["backfill_reservations"][key]["quota_state"], "reserved")
        decision = jobs.admission(self.q, self.item, "2026-10-30T00:10:00Z", self.q["backfill_usage"], False, reserve=False)
        self.assertEqual(decision["effective_remaining"], 3)
        runtime.usage_context(self.c, self.q, None, [])
        self.assertEqual(self.q["backfill_usage"]["reflected_reservations"], [])

    def test_released_or_later_terminal_holds_are_not_reflected(self):
        jobs.admission(self.q, self.item, AT, {"successful": True, "remaining": 2, "observed_at": AT}, False)
        key = self.item["attempt_id"]
        hold = self.q["backfill_reservations"][key]
        hold["terminal_at"] = "2026-10-30T00:05:00Z"
        self.c.iso = lambda: "2026-10-30T00:04:00Z"  # probe precedes the terminal time
        runtime.usage_context(self.c, self.q, {"remaining": 2, "rollingWindowMs": 3600000}, [])
        self.assertEqual(self.q["backfill_usage"]["reflected_reservations"], [])
        hold["quota_state"] = "released"
        self.c.iso = lambda: "2026-10-30T00:10:00Z"
        runtime.usage_context(self.c, self.q, {"remaining": 2, "rollingWindowMs": 3600000}, [])
        self.assertEqual(self.q["backfill_usage"]["reflected_reservations"], [])

    def test_verified_quota_refusals_keep_prior_failures_and_reservations(self):
        import crq
        self.c.classify = crq.classify
        self.c.set_rate_cooldown = crq.set_rate_cooldown
        self.item["failures"] = 2
        histories = jobs.history(self.q, self.item)
        for entry in histories:
            entry.update(failures=2, next_eligible_at="2026-10-30T02:00:00Z")
        raw = b'{"type":"error","errorType":"rate_limit","recoverable":true,"metadata":{"waitTime":"30 minutes"}}\n'
        for index, at in enumerate((AT, "2026-10-30T03:00:00Z")):
            self.c.iso = lambda at=at: at
            decision = jobs.admission(self.q, self.item, at, {"successful": True, "remaining": 8, "observed_at": at}, False)
            self.assertEqual(decision["decision"], "admit")
            run = "quota-" + str(index)
            jobs.bind_run(self.q, self.item, run)
            self.item["run"] = {"run_id": run, "started_at": at}
            rdir = self.root / run; rdir.mkdir()
            (rdir / "review.ndjson").write_bytes(raw)
            (rdir / "exit.json").write_bytes(ledger.canonical({"exit": 1, "ended_at": at}))
            classification = crq.classify(rdir / "review.ndjson", 1)
            if index == 0:
                result = runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": run, "head": self.item["head"]}, classification, 1)
                self.assertIn("retain run ownership", result)
                self.assertTrue(jobs.is_execution_owner(self.item))
            runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": run, "head": self.item["head"]}, classification, 1, terminal_verified=True)
            self.assertEqual(self.item["state"], "pending")
            self.assertEqual(self.item["failures"], 2)
            self.assertTrue(all(entry["failures"] == 2 and not entry["quarantined"] for entry in histories))
            self.assertFalse(jobs.eligible(self.q, self.item, at))
            self.assertEqual(self.q["backfill_reservations"][self.item["attempt_id"]]["quota_state"], "reserved")
            self.assertNotIn("publication_event_id", self.item)
            self.c.launch = mock.Mock()
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
            self.c.launch.assert_not_called()
        self.assertEqual(len(self.q["backfill_reservations"]), 2)
        self.assertEqual(histories[0]["next_eligible_at"], "2026-10-30T03:30:00Z")

    def test_unverified_quota_label_retains_bound_run(self):
        self.c.classify = lambda path, code: {"outcome": "error", "failure_provenance": {"complete": False, "causes": []}}
        jobs.admission(self.q, self.item, AT, {"successful": True, "remaining": 8, "observed_at": AT}, False)
        jobs.bind_run(self.q, self.item, "run-mixed")
        self.item["run"] = {"run_id": "run-mixed", "started_at": AT}
        rdir = self.root / "run-mixed"; rdir.mkdir()
        (rdir / "review.ndjson").write_bytes(b'{"type":"error","errorType":"auth"}\n')
        (rdir / "exit.json").write_bytes(ledger.canonical({"exit": 1, "ended_at": AT}))
        result = runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": "run-mixed"}, {"counted": False, "outcome": "rate_limited"}, 1)
        self.assertIn("retain run ownership", result)
        self.assertTrue(jobs.is_execution_owner(self.item))

    def test_mixed_quota_and_hard_cause_keeps_bound_run(self):
        import crq
        jobs.admission(self.q, self.item, AT, {"successful": True, "remaining": 8, "observed_at": AT}, False)
        jobs.bind_run(self.q, self.item, "run-mixed")
        self.item["run"] = {"run_id": "run-mixed", "started_at": AT}
        rdir = self.root / "run-mixed"; rdir.mkdir()
        raw = b'{"type":"error","errorType":"rate_limit","recoverable":true}\n{"type":"error","errorType":"auth"}\n'
        (rdir / "review.ndjson").write_bytes(raw)
        (rdir / "exit.json").write_bytes(ledger.canonical({"exit": 1, "ended_at": AT}))
        result = runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": "run-mixed"}, crq.classify(rdir / "review.ndjson", 1), 1)
        self.assertIn("mixed quota", result)
        self.assertTrue(jobs.is_execution_owner(self.item))
        self.assertEqual(self.item["failures"], 0)
        refused = runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": "wrong-run"},
                                  crq.classify(rdir / "review.ndjson", 1), 1, terminal_verified=True)
        self.assertIn("retain run ownership", refused)
        self.assertTrue(jobs.is_execution_owner(self.item))
        runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": "run-mixed"},
                        crq.classify(rdir / "review.ndjson", 1), 1, terminal_verified=True)
        self.assertFalse(jobs.is_execution_owner(self.item))
        self.assertEqual(self.item["state"], "quarantined")
        self.assertEqual(self.item["failures"], 1)

if __name__ == "__main__":
    unittest.main()
