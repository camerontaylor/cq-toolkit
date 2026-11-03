"""Usage observation: stale readings, reprobes and unreadable observations.

Split provenance: apps/crq-python/test_backfill_runtime.py was split into
test_backfill_runtime_collector.py, test_backfill_runtime_admission.py,
test_backfill_runtime_observation.py, test_backfill_runtime_selection.py,
test_backfill_runtime_coverage.py, test_backfill_runtime_publish.py,
test_backfill_runtime_quota.py, test_backfill_runtime_events.py and
test_backfill_runtime_fixtures.py.
"""
import copy
import unittest
from unittest import mock

import backfill_jobs as jobs
import backfill_runtime as runtime
from test_backfill_jobs import AT
from test_backfill_runtime_fixtures import RuntimeTestBase


class RuntimeTest(RuntimeTestBase):
    def test_slow_selection_reprobes_usage_instead_of_refusing_as_stale(self):
        # The tick's usage read precedes ordinary selection, ledger fetch and coverage.
        self.q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": "2026-10-29T23:45:00Z",
                                    "reflected_reservations": []}
        def refresh(q):
            q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": AT, "reflected_reservations": []}
            q["backfill_starts_at_observation"] = len(q["starts"])
            return True
        self.c.refresh_backfill_usage = mock.Mock(side_effect=refresh)
        self.assertTrue(runtime.rank4_gate(self.c, self.q, self.item, dry=True))
        self.c.refresh_backfill_usage.assert_called_once_with(self.q)
        self.assertEqual(self.q["backfill_admissions"][-1]["decision"], "admit")

    def test_failed_reprobe_keeps_minutes_old_observation_and_probes_once_per_minute(self):
        self.c.refresh_backfill_usage = mock.Mock(return_value=False)
        self.q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": "2026-10-29T23:58:00Z",
                                    "reflected_reservations": []}
        self.assertTrue(runtime.rank4_gate(self.c, self.q, self.item, dry=True))  # failed probe; 2-minute reading admits
        self.assertEqual(self.c.refresh_backfill_usage.call_count, 1)
        self.q["backfill_usage"]["observed_at"] = "2026-10-29T23:45:00Z"
        self.assertFalse(runtime.rank4_gate(self.c, self.q, self.item, dry=True))
        self.assertEqual(self.item["wait_reason"], "usage-stale-or-invalid")
        self.assertFalse(runtime.rank4_gate(self.c, self.q, self.item, dry=True))
        self.assertEqual(self.c.refresh_backfill_usage.call_count, 1)  # later gates reuse the failed attempt
        self.c.iso = lambda: "2026-10-30T00:01:01Z"
        runtime.rank4_gate(self.c, self.q, self.item, dry=True)
        self.assertEqual(self.c.refresh_backfill_usage.call_count, 2)
        self.c.iso = lambda: "2026-10-30T00:03:00Z"
        self.c.ordinary_review_eligible = lambda q: True
        self.assertFalse(runtime.rank4_gate(self.c, self.q, self.item, dry=True))
        self.assertEqual(self.item["wait_reason"], "ordinary-eligible")
        self.assertEqual(self.c.refresh_backfill_usage.call_count, 2)

    def test_unreadable_observation_with_failed_reprobe_refuses_without_raising(self):
        jobs.admission(self.q, self.item, AT, {"successful": True, "remaining": 8, "observed_at": AT}, False)
        other = copy.deepcopy(self.item); other.update(id=self.item["id"] + "-other", state="pending")
        self.c.refresh_backfill_usage = mock.Mock(return_value=False)
        for observed_at in (None, "garbage"):
            self.q["backfill_usage"] = {"successful": True, "remaining": 8, "observed_at": observed_at, "reflected_reservations": []}
            self.q.pop("backfill_usage_probe_at", None)
            self.assertFalse(runtime.rank4_gate(self.c, self.q, other, dry=True))
            self.assertEqual(other["wait_reason"], "usage-stale-or-invalid")
        for corrupt in ("observed_at", "remaining"):
            self.q["backfill_usage"] = {"successful": True, "remaining": 8, "observed_at": AT, "reflected_reservations": []}
            del self.q["backfill_usage"][corrupt]
            self.q.pop("backfill_usage_probe_at", None)
            other.pop("wait_reason", None)
            self.assertFalse(runtime.rank4_gate(self.c, self.q, other, dry=True))
            self.assertEqual(other["wait_reason"], "usage-stale-or-invalid")

    def test_unreadable_observation_time_reprobes(self):
        self.q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": "garbage", "reflected_reservations": []}
        def refresh(q):
            q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": AT, "reflected_reservations": []}
        self.c.refresh_backfill_usage = mock.Mock(side_effect=refresh)
        self.assertTrue(runtime.rank4_gate(self.c, self.q, self.item, dry=True))
        self.c.refresh_backfill_usage.assert_called_once_with(self.q)

if __name__ == "__main__":
    unittest.main()
