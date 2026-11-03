"""Dispatch gating: rollout settings, publisher transport and dry runs.

Split provenance: apps/crq-python/test_backfill_runtime.py was split into
test_backfill_runtime_collector.py, test_backfill_runtime_admission.py,
test_backfill_runtime_observation.py, test_backfill_runtime_selection.py,
test_backfill_runtime_coverage.py, test_backfill_runtime_publish.py,
test_backfill_runtime_quota.py, test_backfill_runtime_events.py and
test_backfill_runtime_fixtures.py.
"""
import unittest
from types import SimpleNamespace
from unittest import mock

import backfill_jobs as jobs
import backfill_runtime as runtime
import review_ledger as ledger
from test_backfill_jobs import AT
from test_backfill_runtime_fixtures import RuntimeTestBase


class RuntimeTest(RuntimeTestBase):
    def test_missing_rollout_and_unknown_deployed_limits_never_enable_dispatch(self):
        self.assertIsNone(runtime.settings(self.root / "absent", dispatch=True))
        self.policy["reviewer"]["verified"] = False
        with self.assertRaises(ledger.IntegrityError):
            runtime.settings(self.state, dispatch=True)

    def test_malformed_publisher_transport_refuses_before_dispatch(self):
        for spool in ("truthy", ["truthy"], {"ssh_alias": "publisher@127.0.0.1"},
                      {"ssh_alias": "bad host", "ssh_key": "/fixture/key"},
                      {"ssh_alias": "publisher@127.0.0.1", "ssh_key": "\n"},
                      {"ssh_alias": "publisher@127.0.0.1", "ssh_key": "/fixture/key", "legacy_shell": True}):
            with self.subTest(spool=spool):
                ledger.atomic(self.state / "backfill-rollout.json", ledger.canonical({**self.config, "publisher_spool": spool}))
                with self.assertRaisesRegex(ledger.IntegrityError, "publisher_spool"):
                    runtime.settings(self.state, dispatch=True)

    def test_open_gate_dry_run_admits_without_reserving(self):
        self.q["items"] = [self.item]
        self.q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": AT, "reflected_reservations": []}
        self.snapshots()
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head", [])))
        log = []
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", return_value=True):
            self.assertEqual(runtime.select(self.c, self.q, log, True, None), (None, True))
        self.assertEqual(log, ["DRY-RUN would admit " + self.item["id"]])
        self.assertEqual([row["decision"] for row in self.q["backfill_admissions"]], ["admit", "admit"])
        self.assertFalse(self.q.get("backfill_reservations"))

if __name__ == "__main__":
    unittest.main()
