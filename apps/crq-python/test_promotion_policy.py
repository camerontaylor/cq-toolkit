"""Every-green-tip promotion regressions; no GitHub, scan or model calls."""
import json
import unittest
from pathlib import Path
from unittest import mock

from test_promotion_retry import crq

BASE = "b" * 40
TIP = "a" * 40


class PromotionPolicyTest(unittest.TestCase):
    def test_committed_policy_has_immediate_triggers(self):
        policy = json.loads(Path(__file__).with_name("config.json").read_text())["promotion"]
        self.assertEqual(policy["merges_trigger"], 1)
        self.assertEqual(policy["dispatch_after_min"], 0)

    def test_single_unpromoted_green_merge_cuts_without_age_or_demand(self):
        q = {"items": [], "promotion": {"last_promoted_at": crq.iso()}}
        with mock.patch.object(crq, "promotion_gate_live", return_value=True), \
             mock.patch.object(crq, "promotion_mode", return_value="user"), \
             mock.patch.object(crq, "main_sha", return_value=BASE), \
             mock.patch.object(crq, "git", return_value="1"), \
             mock.patch.object(crq, "newest_green_tip", return_value=TIP), \
             mock.patch.object(crq, "is_ancestor", return_value=False), \
             mock.patch.object(crq, "cut_promotion") as cut:
            crq.promotion_tick(q, False)
        cut.assert_called_once()
        self.assertEqual(cut.call_args.args[3:5], (BASE, TIP))
        self.assertEqual(cut.call_args.args[5], "1 merges since last promotion")

    def scan_fixture(self, tips, green=None):
        def rev_list(*args):
            self.assertEqual(args[:2], ("rev-list", "--first-parent"))
            self.assertEqual(args[2], "--max-count")
            base, resume = args[-1].split("..")
            self.assertEqual(base, BASE)
            start = 0 if resume == "origin/merge-queue" else tips.index(resume)
            return "\n".join(tips[start:start + int(args[3])])
        return (mock.patch.object(crq, "git", side_effect=rev_list),
                mock.patch.object(crq, "is_ancestor", return_value=True),
                mock.patch.object(crq, "checks_verdict", side_effect=lambda sha: "pass" if sha == green else "pending"))

    def test_green_tip_behind_sixteen_non_green_tips_is_found_after_restart(self):
        tips = [f"{n:040x}" for n in range(22, 0, -1)]
        green = tips[16]
        state = {}
        patches = self.scan_fixture(tips, green)
        with patches[0], patches[1], patches[2] as checks:
            for tick in range(4):
                before = checks.call_count
                found = crq.newest_green_tip(BASE, [], state)
                self.assertLessEqual(checks.call_count - before, crq.PROMOTION_TIP_CHECKS_PER_TICK)
                state = json.loads(json.dumps(state))  # persisted queue across restart
                if tick < 3:
                    self.assertIsNone(found)
                else:
                    self.assertEqual(found, green)
            self.assertEqual([c.args[0] for c in checks.call_args_list], tips[:17])
            self.assertNotIn("tip_scan", state)

    def test_no_green_sweep_is_bounded_and_restarts_after_exhaustion(self):
        tips = [f"{n:040x}" for n in range(12, 0, -1)]
        state = {}
        patches = self.scan_fixture(tips)
        with patches[0], patches[1], patches[2] as checks:
            for _ in range(3):
                crq.newest_green_tip(BASE, [], state)
            self.assertEqual(checks.call_count, len(tips))
            self.assertNotIn("tip_scan", state)
            crq.newest_green_tip(BASE, [], state)
            self.assertEqual(checks.call_args_list[len(tips)].args[0], tips[0])

    def test_new_commits_do_not_starve_an_existing_scan(self):
        tips = [f"{n:040x}" for n in range(12, 0, -1)]
        state = {}
        patches = self.scan_fixture(tips, tips[7])
        with patches[0], patches[1], patches[2]:
            self.assertIsNone(crq.newest_green_tip(BASE, [], state))
            tips.insert(0, "f" * 40)
            self.assertEqual(crq.newest_green_tip(BASE, [], state), tips[8])

    def test_stale_base_or_schema_and_rewound_queue_restart_at_newest(self):
        tips = [f"{n:040x}" for n in range(12, 0, -1)]
        patches = self.scan_fixture(tips, tips[0])
        with patches[0], patches[1], patches[2] as checks:
            for cursor in [{"schema_version": 2, "base": BASE, "next": tips[8]},
                           {"schema_version": 1, "base": "c" * 40, "next": tips[8]}]:
                self.assertEqual(crq.newest_green_tip(BASE, [], {"tip_scan": cursor}), tips[0])
            with mock.patch.object(crq, "is_ancestor", return_value=False):
                self.assertEqual(crq.newest_green_tip(BASE, [], {"tip_scan": {
                    "schema_version": 1, "base": BASE, "next": tips[8]}}), tips[0])
            self.assertEqual([c.args[0] for c in checks.call_args_list], [tips[0]] * 3)

    def test_remote_error_retries_only_the_unfinished_candidate(self):
        tips = [f"{n:040x}" for n in range(12, 0, -1)]
        state = {}
        patches = self.scan_fixture(tips)
        with patches[0], patches[1], patches[2] as checks:
            checks.side_effect = ["pending", RuntimeError("offline")]
            with self.assertRaises(RuntimeError):
                crq.newest_green_tip(BASE, [], state)
            self.assertEqual(state["tip_scan"]["next"], tips[1])
            checks.side_effect = lambda sha: "pass"
            self.assertEqual(crq.newest_green_tip(BASE, [], state), tips[1])
