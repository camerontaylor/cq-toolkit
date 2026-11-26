"""Unit tests for tick_shadow_compare: input refusal, the disabled plan and diffing.

The cross-implementation differential (TypeScript plan vs this oracle on seeded
roots) lives in test/queue-runner/tickShadowDifferential.test.ts.
"""
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path

import tick_shadow_compare as compare

HERE = Path(__file__).resolve().parent
NOW = "2026-11-20T03:00:00Z"


def runner_root(tmp: Path, queue: dict, disabled: bool = False) -> Path:
    root = tmp / "runner"
    (root / "state" / "runs").mkdir(parents=True)
    (root / "config.json").write_text(json.dumps({
        "repo": "acme/widgets", "clone": str(tmp / "clone-absent"),
        "worktree_root": str(tmp / "wt"), "worktree_prefix": "crq-"}))
    (root / "state" / "queue.json").write_text(json.dumps(queue))
    if disabled:
        (root / "state" / "runner-disabled").write_text("")
    return root


def plan_file(tmp: Path, value: dict, mutations=None) -> Path:
    path = tmp / "plan.json"
    path.write_text(json.dumps({"command": "tick", "value": value, "mutations": mutations or []}))
    return path


def oracle(root: Path, tmp: Path) -> dict:
    with compare._oracle(HERE, root, tmp / "scratch") as crq:
        now = dt.datetime(2026, 11, 20, 3, tzinfo=dt.timezone.utc)
        return compare.python_plan(crq, now, usage_override=None, use_override=True)


class TickShadowCompareTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_identical_plan_compares_clean_and_leaves_the_frozen_queue_untouched(self):
        queue = {"items": [{"id": "d", "kind": "delta", "state": "pending", "order": 1}], "starts": []}
        root = runner_root(self.tmp, queue)
        before = (root / "state" / "queue.json").read_bytes()
        expected = oracle(root, self.tmp)
        value = {"complete": False, "reason": compare.INCOMPLETE_PREFIX + "a; b", **expected}
        mutations = [{"operation": "set", "target": "queue.json#/last_tick", "value": NOW}]
        result = compare.run(HERE, root, plan_file(self.tmp, value, mutations), self.tmp / "s2")
        self.assertEqual(result["diffs"], [])
        self.assertTrue(result["identical"])
        self.assertEqual(result["missing_effects"], ["a", "b"])
        self.assertEqual(result["pinned_now"], NOW)
        self.assertEqual((root / "state" / "queue.json").read_bytes(), before)
        self.assertNotIn("events.jsonl", {p.name for p in (root / "state").iterdir()})

    def test_oracle_ignores_an_already_imported_crq_and_restores_it(self):
        # CI imports the real crq in the same process before this test runs.
        sys.path.insert(0, str(HERE))
        try:
            import crq as resident
        finally:
            sys.path.remove(str(HERE))
        root = runner_root(self.tmp, {"items": [], "starts": []})
        with compare._oracle(HERE, root, self.tmp / "scratch") as crq:
            self.assertIsNot(crq, resident)
            self.assertEqual(crq.QUEUE.resolve(), (root / "state" / "queue.json").resolve())
        self.assertIs(sys.modules["crq"], resident)

    def test_every_differing_field_is_reported(self):
        python = {"admission": {"slots": 2, "gate": None}, "candidates": [], "backgroundTurn": False}
        ts = {"admission": {"slots": 3, "gate": None}, "candidates": [{"id": "x"}], "backgroundTurn": False}
        diffs = compare.compare(python, ts)
        self.assertEqual([d["field"] for d in diffs], ["admission.slots", "candidates"])

    def test_disabled_plan_matches_only_when_the_marker_exists(self):
        value = {"complete": False, "disabled": True, "reason": "runner disabled for host handover"}
        on = runner_root(self.tmp / "on", {"items": []}, disabled=True)
        self.assertTrue(compare.run(HERE, on, plan_file(self.tmp, value), self.tmp / "s1")["identical"])
        off = runner_root(self.tmp / "off", {"items": []})
        result = compare.run(HERE, off, plan_file(self.tmp, value), self.tmp / "s3")
        self.assertFalse(result["identical"])

    def test_disabled_marker_is_compared_even_when_the_ts_plan_is_a_normal_pass(self):
        root = runner_root(self.tmp, {"items": [], "starts": []}, disabled=True)
        value = {"complete": False, "reason": compare.INCOMPLETE_PREFIX + "a"}
        mutations = [{"operation": "set", "target": "queue.json#/last_tick", "value": NOW}]
        result = compare.run(HERE, root, plan_file(self.tmp, value, mutations), self.tmp / "s4")
        self.assertFalse(result["identical"])
        self.assertEqual(result["diffs"], [{"field": "disabled", "python": True, "ts": False}])

    def test_refuses_unusable_plans(self):
        root = runner_root(self.tmp, {"items": []})
        cases = [
            {"command": "slot", "value": {"complete": False}},
            {"command": "tick", "value": {"complete": True}},
            {"command": "tick", "value": {"complete": False, "reason": "other"}},
            {"command": "tick", "value": {"complete": False, "reason": compare.INCOMPLETE_PREFIX}},
        ]
        for index, plan in enumerate(cases):
            path = self.tmp / f"bad{index}.json"
            path.write_text(json.dumps(plan))
            with self.subTest(plan=plan), self.assertRaises(compare.CompareError):
                compare.run(HERE, root, path, self.tmp / f"s{index + 10}")

    def test_main_refuses_comparing_against_the_live_python_root(self):
        self.assertEqual(compare.main(["--python-root", str(HERE), "--runner-root", str(HERE),
                                       "--ts-plan", str(self.tmp / "absent.json")]), 2)


if __name__ == "__main__":
    unittest.main()
