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

    def test_green_tip_behind_sixteen_non_green_tips_is_found(self):
        tips = [f"{n:040x}" for n in range(18, 0, -1)]
        green = tips[16]
        def rev_list(*args):
            self.assertEqual(args[0:2], ("rev-list", "--first-parent"))
            self.assertEqual(args[-1], f"{BASE}..origin/merge-queue")
            # Model the former depth cap so this regression fails on old code.
            chosen = tips[:int(args[args.index("-n") + 1])] if "-n" in args else tips
            return "\n".join(chosen)
        with mock.patch.object(crq, "git", side_effect=rev_list), \
             mock.patch.object(crq, "checks_verdict", side_effect=lambda sha: "pass" if sha == green else "pending"):
            log = []
            self.assertEqual(crq.newest_green_tip(BASE, log), green)
        self.assertEqual(len(log), 16)
