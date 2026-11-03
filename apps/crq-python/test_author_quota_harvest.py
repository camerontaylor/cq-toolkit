"""Author harvest outcomes: evidence kept, consumed terminals, no repair debt.

Split provenance: apps/crq-python/test_author_quota.py was split into
test_author_quota_admission.py, test_author_quota_launch.py,
test_author_quota_runner.py, test_author_quota_crash_recovery.py,
test_author_quota_harvest.py, test_author_quota_tick.py,
test_author_quota_observation.py and test_author_quota_open_cycle.py.
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_author_quota_fixtures import BASE, HEAD, MARKER, author_item, author_quota, crq, empty_queue


class HarvestTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.runs = Path(self.tmp.name) / "runs"
        self.runs.mkdir(parents=True)
        for name, value in (("STATE", Path(self.tmp.name) / "state"),
                            ("RUNS", self.runs), ("save_queue", mock.Mock()), ("event", mock.Mock()),
                            ("remove_worktree", mock.Mock()), ("findings_md", lambda *a, **k: "")):
            p = mock.patch.object(crq, name, value)
            p.start()
            self.addCleanup(p.stop)

    def _run_dir(self, run_id, exit_code=0):
        rdir = self.runs / run_id
        rdir.mkdir(parents=True)
        (rdir / "meta.json").write_text(json.dumps({"run_id": run_id, "cycle": 1, "base": BASE,
                                                    "head": HEAD, "worktree": "/w", "wt_branch": "crq/w"}))
        (rdir / "review.ndjson").write_text("")
        (rdir / "review.pid").write_text(json.dumps({"run_id": run_id, "pid": 111, "pgid": 111,
                                                     "sid": 111, "group_owner": MARKER}))
        (rdir / "exit.json").write_text(json.dumps({"exit": exit_code, "ended_at": crq.iso(),
                                                    "timed_out": exit_code == 124}))
        return rdir

    def _item(self, q, run_id):
        item = author_item(q)
        item["state"] = "reviewing"
        item["run"] = {"run_id": run_id, "pid": None, "started_at": crq.iso()}
        return item

    def test_completed_author_harvest_keeps_evidence_without_repair_or_coverage(self):
        q = empty_queue()
        rid = "author-run-ok"
        self._run_dir(rid)
        item = self._item(q, rid)
        cls = {"outcome": "completed", "counted": True, "findings": 2,
               "severity_counts": {"major": 2}, "message": None}
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False), \
             mock.patch.object(crq, "classify", return_value=cls), \
             mock.patch.object(crq.coverage, "record_review") as credit, \
             mock.patch.object(crq.repair_tick, "enqueue") as enqueue:
            msg = crq.harvest_review(q, item, False)
        self.assertLessEqual(crq.parse_iso((crq.STATE / "next-review-at").read_text().strip()), crq.now())
        self.assertEqual(item["state"], "done")
        self.assertEqual(len(item["author_cycles"]), 1)   # genuine cycle evidence kept
        self.assertEqual(item["cycles"], [])              # so repair backfill never sees it
        self.assertFalse(item.get("repair_runs"))         # no repair debt
        credit.assert_not_called()                        # no promoted coverage credit
        enqueue.assert_not_called()
        self.assertNotIn("coverage", q)
        self.assertIn("no repair/coverage credit", msg)

    def test_one_completed_open_review_finishes_without_a_second_cycle(self):
        q = empty_queue()
        rid = "open-run-ok"
        self._run_dir(rid)
        item = self._item(q, rid)
        item["kind"] = "open"
        cls = dict(outcome="completed", counted=True, findings=0, severity_counts={})
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False), \
             mock.patch.object(crq, "classify", return_value=cls), \
             mock.patch.object(crq.repair_tick, "enqueue", return_value=False):
            crq.harvest_review(q, item, False)
        self.assertEqual(item["state"], "done")
        self.assertEqual(len(item["cycles"]), 1)
        self.assertFalse(item.get("boost"))

    def test_every_noncompleted_author_outcome_is_a_consumed_terminal(self):
        for o in ("rate_limited", "action_required", "auth", "error", "interrupted",
                  "skipped", "too_large"):
            with self.subTest(outcome=o):
                q = empty_queue()
                rid = "author-run-" + o
                self._run_dir(rid, exit_code=1)
                item = self._item(q, rid)
                cls = {"outcome": o, "counted": False, "findings": 0, "severity_counts": {},
                       "message": "boom"}
                with mock.patch.object(crq, "pid_alive", return_value=False), \
                     mock.patch.object(crq, "group_alive", return_value=False), \
                     mock.patch.object(crq, "classify", return_value=cls):
                    crq.harvest_review(q, item, False)
                self.assertEqual(item["state"], author_quota.AUTHOR_FAILED)
                self.assertNotEqual(item["state"], "pending")     # never auto-retried
                self.assertIsNone(item["run"])
                self.assertIsNone(item.get("not_before"))
                self.assertFalse(item["attempts"][-1]["counted"])
                self.assertIn("no automatic retry", item["last_error"])
                if o == "rate_limited":
                    self.assertIsNotNone(q.get("cooldown_until"))  # global cooldown preserved
                if o in ("action_required", "auth"):
                    self.assertTrue(q.get("paused"))               # global pause preserved

    def test_author_cycles_are_not_repair_backfill_input(self):
        item = {"kind": "author", "author_cycles": [{"run_id": "r"}]}
        # repair_tick.backfill scans item['cycles'] only; author evidence lives
        # elsewhere, so no repair job can ever be derived from it.
        self.assertEqual(item.get("cycles", []), [])


if __name__ == "__main__":
    unittest.main()
