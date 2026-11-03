"""Open/range planning: enrollment recovery and full-range dispatch.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import copy
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock
from test_crq_fixtures import (
    CurrentFixture,
    crq,
    setUpModule,
)

class CurrentTest(CurrentFixture, unittest.TestCase):
    def test_open_main_and_stacked_main_prs_enroll(self):
        opened = [{"number": n, "isDraft": False, "baseRefName": base,
                   "headRefName": head, "headRefOid": self.merge}
                  for n, base, head in [(750, "main", "feature"),
                      (751, "feature", "stacked"), (752, "merge-queue", "legacy")]]
        with mock.patch.object(crq, "gh_json", return_value=opened):
            crq.enroll(self.q, False)
        self.assertEqual({i["pr"] for i in self.q["items"]}, {750, 751, 752})

    def test_once_per_range_preserves_restacked_cycles_and_refuses_same_head_shortcut(self):
        info = {"state": "OPEN", "isDraft": False, "headRefOid": self.merge,
                "baseRefName": "merge-queue", "headRefName": "fixture"}
        item = {"pr": 42, "cycles": [{"run_id": "legacy", "base": self.pre, "head": self.merge,
                                    "findings": 2}], "prior_cycles": 1, "pinned_base": self.pre}
        saved = copy.deepcopy(item["cycles"])
        plan = crq.plan_open(item, info, False)
        self.assertEqual(item["cycles"], saved)
        self.assertEqual(plan["label"], "one review of captured range")
        # Same-head legacy credit has no scope policy; full review is still owed.
        self.assertEqual(crq.plan_delta(item, info, False)["base"], self.merge)
        item["cycles"].append({"run_id": "proven", "base": self.merge, "head": self.merge,
                              "dirty_diff": "clean tree", "range_policy": "full-range-once-v1"})
        with self.assertRaises(crq.NothingToReview):
            crq.plan_open(item, info, False)
        crq.advance_open(item)
        self.assertEqual(item["state"], "done")

    def test_future_bound_refuses_before_forge_and_full_range_dispatch_is_committed(self):
        with mock.patch.object(crq, "gh_json") as forge:
            with self.assertRaises(crq.merged_reconcile.ReconcileRefused):
                crq.reconcile_merged(self.q, after="2026-10-01T00:00:00Z",
                                     before="2099-01-01T00:00:00Z", page_budget=1)
            forge.assert_not_called()
        self.g("update-ref", "refs/remotes/origin/merge-queue", self.pre)
        item = {"id": "open-range", "kind": "open", "pr": 42, "state": "pending", "cycles": [],
                "attempts": [], "failures": 0}
        self.q["items"].append(item)
        info = {"state": "OPEN", "isDraft": False, "headRefOid": self.merge,
                "baseRefName": "merge-queue", "headRefName": "fixture"}
        plan = crq.plan_open(item, info, False)
        guarded_popen = subprocess.Popen
        def fake_child(argv, **kwargs):
            expected = [sys.executable, str(Path(crq.__file__).resolve()), "_review",
                        (item.get("run") or {}).get("run_id")]
            if argv == expected:
                return SimpleNamespace(pid=919191)
            return guarded_popen(argv, **kwargs)
        with mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
             mock.patch.object(crq, "make_worktree", return_value=(self.root / "wt", "fixture")), \
             mock.patch.object(crq.subprocess, "Popen", side_effect=fake_child):
            crq.launch(self.q, item, plan)
        meta = json.loads((crq.RUNS / item["run"]["run_id"] / "meta.json").read_text())
        self.assertIn("--committed", meta["cmd"])
        self.assertEqual(meta["range_policy"], "full-range-once-v1")


    def test_range_enrollment_recovers_heads_and_isolates_unavailable_prs(self):
        opened = [{"number": n, "headRefOid": self.merge, "baseRefName": "merge-queue",
                   "headRefName": f"fixture-{n}", "isDraft": False} for n in (42, 43, 44, 45)]
        self.q["items"] = [{"id": f"pr{n}", "pr": n, "kind": "open", "state": "done",
                            "cycles": [], "order": n} for n in (42, 43, 44, 45)]
        real_git = crq.git
        reads = 0
        def merge_base(*args, **kwargs):
            nonlocal reads
            if args[0] == "merge-base":
                reads += 1
                if reads == 2:
                    raise RuntimeError("head moved after recovery")
            return real_git(*args, **kwargs)
        with mock.patch.object(crq, "gh_json", return_value=opened), \
             mock.patch.object(crq, "ensure_commit", side_effect=[False, True, True, True]) as recover, \
             mock.patch.object(crq, "git", side_effect=merge_base):
            log = crq.enroll(self.q, False)
        self.assertEqual([call.args[0] for call in recover.call_args_list], [42, 43, 44, 45])
        self.assertEqual([item["pr"] for item in self.q["items"] if item["kind"] == "delta"], [43, 45])
        self.assertEqual(sum("enrollment deferred" in line for line in log), 2)
        # Same frozen range is represented once across enrollment replay.
        with mock.patch.object(crq, "gh_json", return_value=opened[1:2]), \
             mock.patch.object(crq, "ensure_commit", return_value=True):
            crq.enroll(self.q, False)
        self.assertEqual(sum(item["kind"] == "delta" and item["pr"] == 43 for item in self.q["items"]), 1)
