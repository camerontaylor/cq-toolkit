"""State-event replay and vendor metadata harvest.

Split provenance: apps/crq-python/test_backfill_runtime.py was split into
test_backfill_runtime_collector.py, test_backfill_runtime_admission.py,
test_backfill_runtime_observation.py, test_backfill_runtime_selection.py,
test_backfill_runtime_coverage.py, test_backfill_runtime_publish.py,
test_backfill_runtime_quota.py, test_backfill_runtime_events.py and
test_backfill_runtime_fixtures.py.
"""
import unittest

import backfill_jobs as jobs
import backfill_runtime as runtime
import review_ledger as ledger
from test_backfill_jobs import AT
from test_backfill_runtime_fixtures import RuntimeTestBase


class RuntimeTest(RuntimeTestBase):
    def test_acknowledged_state_event_replay_preserves_identity_after_queue_cache_loss(self):
        runtime.state_event(self.c, self.q, self.item, AT, "created")
        _, _, out, _ = runtime.services(self.c, self.config)
        original = out.pending()[0]
        out.acknowledge(original, {original["id"]})
        self.q.pop("backfill_state_events")
        runtime.state_event(self.c, self.q, self.item, "2026-10-30T01:00:00Z", "created")
        self.assertEqual(out.retained(), [original])
        self.assertFalse(out.pending())

    def test_harvest_accepts_blank_lines_and_float_only_in_vendor_metadata(self):
        jobs.admission(self.q, self.item, AT, {"successful": True, "remaining": 2, "observed_at": AT}, False)
        self.item.update(state="reviewing", run={"run_id": "vendor-meta", "started_at": AT})
        rdir = self.root / "run-meta"; rdir.mkdir()
        terminal = ledger.canonical({"type": "complete", "status": "review_completed", "head": self.item["head"], "reviewedFiles": self.item["scope"]})
        (rdir / "review.ndjson").write_bytes(b'{"type":"heartbeat","duration":1.5}\n\n' + terminal + b'\n')
        (rdir / "exit.json").write_bytes(ledger.canonical({"exit": 0, "ended_at": AT}))
        runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": "vendor-meta", "head": self.item["head"]}, {"counted": True, "outcome": "completed"}, 0)
        self.assertEqual(self.item["state"], "publication-pending")

if __name__ == "__main__":
    unittest.main()
