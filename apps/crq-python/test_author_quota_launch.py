"""Author launch admission: committed range, shared caps and terminal failures.

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
from types import SimpleNamespace
from unittest import mock

from test_author_quota_fixtures import BASE, HEAD, REQ, author_item, author_quota, crq, empty_queue


class LaunchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state = self.root / "state"
        self.runs = self.state / "runs"
        self.runs.mkdir(parents=True)
        for name, value in (("ROOT", self.root), ("STATE", self.state), ("RUNS", self.runs),
                            ("QUEUE", self.state / "queue.json"),
                            ("CONFIG", {"max_starts_per_hour": 5, "max_inflight": 2, "repair": {}})):
            p = mock.patch.object(crq, name, value)
            p.start()
            self.addCleanup(p.stop)
        for name in ("save_queue", "event"):
            p = mock.patch.object(crq, name)
            p.start()
            self.addCleanup(p.stop)
        self.worktree = mock.patch.object(crq, "make_worktree",
                                          return_value=(self.root / "wt", "crq/wt"))
        self.worktree.start()
        self.addCleanup(self.worktree.stop)

    def _launch(self, q, item, popen):
        with mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
             mock.patch.object(crq.subprocess, "Popen", **popen):
            crq.launch(q, item, author_quota.plan(item))

    def test_author_launch_uses_committed_and_shares_starts_inflight(self):
        q = empty_queue()
        item = author_item(q)
        self._launch(q, item, {"return_value": SimpleNamespace(pid=4242)})
        self.assertEqual(item["state"], "reviewing")
        self.assertEqual(len(q["starts"]), 1)
        self.assertEqual(crq.starts_last_hour(q), 1)
        self.assertEqual(len(crq.inflight(q)), 1)
        meta = json.loads((self.runs / item["run"]["run_id"] / "meta.json").read_text())
        self.assertEqual(meta["author"], {"request_id": REQ, "base": BASE, "head": HEAD,
                                          "target": "origin/merge-queue", "cycle": 1})
        self.assertEqual(meta["cmd"],
                         ["coderabbit", "review", "--agent", "--deep", "--committed", "--base-commit", BASE])
        self.assertNotIn("--use-credits", meta["cmd"])
        self.assertNotIn("--credits", meta["cmd"])

    def test_natural_launch_cmd_is_unchanged(self):
        q = empty_queue()
        item = {"id": "pr1", "pr": 1, "kind": "open", "state": "pending", "cycles": [], "attempts": []}
        q["items"].append(item)
        plan = {"base": BASE, "head": HEAD, "target": "origin/merge-queue", "cycle": 1,
                "branch": "b", "notes": [], "label": "l"}
        with mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
             mock.patch.object(crq.subprocess, "Popen", return_value=SimpleNamespace(pid=7)):
            crq.launch(q, item, plan)
        meta = json.loads((self.runs / item["run"]["run_id"] / "meta.json").read_text())
        self.assertEqual(meta["cmd"], ["coderabbit", "review", "--agent", "--deep", "--base-commit", BASE])

    def test_secret_scan_refusal_blocks_before_spawn_and_consumes_no_start(self):
        q = empty_queue()
        item = author_item(q)
        with mock.patch.object(crq, "secret_scan",
                               return_value=(False, {"denylist_hits": [1], "gitleaks_hits": []})), \
             mock.patch.object(crq.subprocess, "Popen") as popen:
            crq.launch(q, item, author_quota.plan(item))
        self.assertEqual(item["state"], "blocked")
        self.assertEqual(q["starts"], [])
        popen.assert_not_called()

    def test_failed_spawn_is_a_consumed_terminal_with_no_retry(self):
        q = empty_queue()
        item = author_item(q)
        self._launch(q, item, {"side_effect": OSError("cannot fork")})
        self.assertEqual(item["state"], author_quota.AUTHOR_FAILED)
        self.assertNotEqual(item["state"], "pending")  # never auto-retried
        self.assertEqual(len(q["starts"]), 1)  # admission consumed
        self.assertFalse(item["run"]["launch_pending"])
        self.assertIn("no retry", item["last_error"])

    def test_non_author_spawn_failure_still_raises(self):
        q = empty_queue()
        item = {"id": "pr1", "pr": 1, "kind": "open", "state": "pending", "cycles": [], "attempts": []}
        q["items"].append(item)
        plan = {"base": BASE, "head": HEAD, "target": "origin/merge-queue", "cycle": 1,
                "branch": "b", "notes": [], "label": "l"}
        with mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
             mock.patch.object(crq.subprocess, "Popen", side_effect=OSError("no fork")):
            with self.assertRaises(OSError):
                crq.launch(q, item, plan)


if __name__ == "__main__":
    unittest.main()
