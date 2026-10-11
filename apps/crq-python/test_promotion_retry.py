"""Retry-path gate selection for the promotion tick (C2 cutover step 8).

Drives promotion_tick() on a minimal crafted queue whose open item is in
state "promoting" past the dispatch threshold. All git/gh/network access is
mocked out: no real CLONE, spool, or state is touched.
"""
import datetime as dt
import importlib.machinery
import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
loader = importlib.machinery.SourceFileLoader("crq_under_test", str(ROOT / "crq.py"))
spec = importlib.util.spec_from_loader(loader.name, loader)
assert spec is not None
crq = importlib.util.module_from_spec(spec)
loader.exec_module(crq)

BATCH = "a" * 40
BASE = "b" * 40
MAIN = "c" * 40


def success_at(minutes_ago=30):
    return (crq.now() - dt.timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def make_queue(**item_overrides):
    item = {"id": "promo-test", "kind": "promotion", "state": "promoting",
            "base_sha": BASE, "batch_sha": BATCH, "success_at": success_at()}
    item.update(item_overrides)
    return {"items": [item],
            "promotion": {"enabled": True, "last_promoted_at": success_at(120)}}


def ok_run(**kw):
    return SimpleNamespace(returncode=0, stdout="", stderr="", **kw)


def fail_run(code=1, err="oh no"):
    return SimpleNamespace(returncode=code, stdout="", stderr=err)


class PromotionRetryTest(unittest.TestCase):
    def setUp(self):
        promo = {"enabled": True, "post_status": True, "dispatch_after_min": 20}
        self.promo_patch = mock.patch.dict(crq.PROMO, promo, clear=True)
        self.promo_patch.start()
        self.addCleanup(self.promo_patch.stop)

        self.run_patcher = mock.patch.object(crq, "run")
        self.mock_run = self.run_patcher.start()
        self.addCleanup(self.run_patcher.stop)
        self.mock_run.return_value = ok_run()

        self.wf = mock.patch.object(crq, "workflow_at")
        self.mock_wf = self.wf.start()
        self.addCleanup(self.wf.stop)

        self.gate = mock.patch.object(crq, "promotion_gate_live", return_value=True)
        self.gate.start()
        self.addCleanup(self.gate.stop)

        self.mode = mock.patch.object(crq, "promotion_mode", return_value="user")
        self.mode.start()
        self.addCleanup(self.mode.stop)

        self.sha = mock.patch.object(crq, "main_sha", return_value=MAIN)
        self.sha.start()
        self.addCleanup(self.sha.stop)

        def ancestor(a, b):
            if a == BATCH and b == MAIN:
                return False  # batch not yet promoted
            if a == BASE and b == MAIN:
                return True  # review base still on main
            raise AssertionError(f"unexpected is_ancestor({a[:8]}, {b[:8]})")

        self.anc = mock.patch.object(crq, "is_ancestor", side_effect=ancestor)
        self.anc.start()
        self.addCleanup(self.anc.stop)

        self.evt = mock.patch.object(crq, "event")
        self.mock_event = self.evt.start()
        self.addCleanup(self.evt.stop)

        self.alert = mock.patch.object(crq, "signer_alert")
        self.mock_alert = self.alert.start()
        self.addCleanup(self.alert.stop)

    def gh_calls(self):
        return [c for c in self.mock_run.call_args_list if c.args[0][0] == "gh"]

    def test_old_workflow_present_keeps_old_shape(self):
        self.mock_wf.side_effect = lambda rev, name: name == "merge-queue-gate.yml"
        q = make_queue()
        log = crq.promotion_tick(q, False)
        gh = self.gh_calls()
        self.assertEqual(len(gh), 1)
        self.assertEqual(gh[0].args[0],
                         ["gh", "workflow", "run", "merge-queue-gate.yml", "--repo", crq.REPO,
                          "--ref", "main", "-f", f"sha={BATCH}"])
        self.assertIn("dispatched", q["items"][0])
        kinds = [c.args[0] for c in self.mock_event.call_args_list]
        self.assertIn("promotion_dispatch", kinds)
        self.assertTrue(any("merge-queue-gate.yml" in line and "dispatched" in line for line in log))

    def test_gate_yml_without_sha(self):
        self.mock_wf.side_effect = lambda rev, name: name == "gate.yml"
        q = make_queue()
        log = crq.promotion_tick(q, False)
        gh = self.gh_calls()
        self.assertEqual(len(gh), 1)
        cmd = gh[0].args[0]
        self.assertEqual(cmd[:6], ["gh", "workflow", "run", "gate.yml", "--repo", crq.REPO])
        self.assertIn("--ref", cmd)
        self.assertEqual(cmd[cmd.index("--ref") + 1], "main")
        self.assertFalse(any("sha=" in part for part in cmd),
                         f"gate.yml dispatch must carry no sha input: {cmd}")
        self.assertIn("dispatched", q["items"][0])
        kinds = [c.args[0] for c in self.mock_event.call_args_list]
        self.assertIn("promotion_dispatch", kinds)
        self.assertTrue(any("gate.yml" in line and "dispatched" in line for line in log))

    def test_neither_present_alerts_once_and_refuses(self):
        self.mock_wf.return_value = False
        q = make_queue()
        log = crq.promotion_tick(q, False)
        self.assertEqual(self.gh_calls(), [])
        self.assertNotIn("dispatched", q["items"][0])
        self.assertEqual(self.mock_alert.call_count, 1)
        self.assertTrue(any("refusing" in line for line in log))
        # Second tick: no repeat alert.
        log2 = crq.promotion_tick(q, False)
        self.assertEqual(self.mock_alert.call_count, 1)
        self.assertNotIn("dispatched", q["items"][0])
        self.assertTrue(any("refusing" in line for line in log2))
        # A workflow found again clears the flag, so a later outage re-alerts.
        self.assertIn("gate_absent_alerted", q["promotion"])
        self.mock_wf.side_effect = lambda rev, name: name == "gate.yml"
        crq.promotion_tick(q, False)
        self.assertNotIn("gate_absent_alerted", q["promotion"])
        self.mock_wf.side_effect = None
        self.mock_wf.return_value = False
        del q["items"][0]["dispatched"]  # fresh outage on a new item below
        q2 = make_queue()
        q2["promotion"] = q["promotion"]
        crq.promotion_tick(q2, False)
        self.assertEqual(self.mock_alert.call_count, 2)

    def test_dispatch_failure_retries_without_dispatched(self):
        self.mock_wf.side_effect = lambda rev, name: name == "merge-queue-gate.yml"
        self.mock_run.return_value = fail_run(1, "workflow not found")
        q = make_queue()
        log = crq.promotion_tick(q, False)
        self.assertNotIn("dispatched", q["items"][0])
        kinds = [c.args[0] for c in self.mock_event.call_args_list]
        self.assertIn("promotion_dispatch_failed", kinds)
        self.assertNotIn("promotion_dispatch", kinds)
        self.assertTrue(any("failed" in line for line in log))
        self.assertTrue(all("dispatched" not in line for line in log),
                        f"failed dispatch must never log a success line: {log}")
        self.assertEqual(self.mock_alert.call_count, 1)
        # Next tick retries gh but does not re-alert.
        log2 = crq.promotion_tick(q, False)
        self.assertEqual(len(self.gh_calls()), 2)
        self.assertNotIn("dispatched", q["items"][0])
        self.assertEqual(self.mock_alert.call_count, 1)
        self.assertTrue(all("dispatched" not in line for line in log2))

    def test_dispatch_success_sets_dispatched_and_event(self):
        self.mock_wf.side_effect = lambda rev, name: name == "gate.yml"
        q = make_queue()
        log = crq.promotion_tick(q, False)
        self.assertIn("dispatched", q["items"][0])
        kinds = [c.args[0] for c in self.mock_event.call_args_list]
        self.assertIn("promotion_dispatch", kinds)
        dispatched_events = [c for c in self.mock_event.call_args_list
                             if c.args[0] == "promotion_dispatch"]
        self.assertEqual(dispatched_events[0].kwargs.get("workflow"), "gate.yml")
        self.assertTrue(any("gate.yml" in line and "dispatched" in line for line in log))

    def test_dry_run_calls_no_gh(self):
        self.mock_wf.side_effect = lambda rev, name: name == "merge-queue-gate.yml"
        q = make_queue()
        before = {"promotion": dict(q["promotion"]), "item": dict(q["items"][0])}
        log = crq.promotion_tick(q, True)
        self.assertEqual(self.gh_calls(), [])
        self.assertEqual(self.mock_run.call_count, 0)
        self.assertNotIn("dispatched", q["items"][0])
        self.assertEqual(q["promotion"], before["promotion"])
        self.assertEqual(q["items"][0], before["item"])
        self.assertTrue(any("would dispatch" in line for line in log),
                        f"dry run should log what would happen: {log}")

    def test_post_status_off_no_gh_truthful_log(self):
        crq.PROMO["post_status"] = False
        self.mock_wf.side_effect = lambda rev, name: name == "merge-queue-gate.yml"
        q = make_queue()
        log = crq.promotion_tick(q, False)
        self.assertEqual(self.gh_calls(), [])
        self.assertNotIn("dispatched", q["items"][0])
        self.assertTrue(any("post_status off" in line for line in log), f"log: {log}")
        self.assertTrue(all("dispatched" not in line for line in log),
                        f"must not claim a dispatch happened: {log}")


if __name__ == "__main__":
    unittest.main()
