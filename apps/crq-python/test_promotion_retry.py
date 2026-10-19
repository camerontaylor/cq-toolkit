"""Retry-path gate selection for the promotion tick (C2 cutover step 8).

Drives promotion_tick() on a minimal crafted queue whose open item is in
state "promoting" past the dispatch threshold. All git/gh/network access is
mocked out: no real CLONE, spool, or state is touched.
"""
import datetime as dt
import importlib.machinery
import importlib.util
import json
import sys
import tempfile
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

        self.notify = mock.patch.object(crq, "notify_owner", return_value={"paseo_send": 0})
        self.mock_notify = self.notify.start()
        self.addCleanup(self.notify.stop)

        self.clock = mock.patch.object(crq, "now", return_value=dt.datetime(2026, 10, 19, tzinfo=dt.timezone.utc))
        self.mock_now = self.clock.start()
        self.addCleanup(self.clock.stop)

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

    def test_both_workflows_present_prefers_old_gate(self):
        self.mock_wf.side_effect = lambda rev, name: True
        q = make_queue()
        log = crq.promotion_tick(q, False)
        gh = self.gh_calls()
        self.assertEqual(len(gh), 1)
        self.assertEqual(gh[0].args[0],
                         ["gh", "workflow", "run", "merge-queue-gate.yml", "--repo", crq.REPO,
                          "--ref", "main", "-f", f"sha={BATCH}"])
        self.assertIn("dispatched", q["items"][0])
        dispatched_events = [c for c in self.mock_event.call_args_list
                             if c.args[0] == "promotion_dispatch"]
        self.assertEqual(len(dispatched_events), 1)
        self.assertEqual(dispatched_events[0].kwargs.get("workflow"), "merge-queue-gate.yml")
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

    def test_stall_boundary_escalates_once_across_restart_without_dispatch(self):
        # Gate refusals/needs-human may never yield a usable result. The clock
        # still bounds silence, independently of dispatch time or gate attempts.
        q = make_queue(success_at=success_at(59), dispatched=success_at(1))
        crq.promotion_tick(q, False)
        self.mock_notify.assert_not_called()
        q["items"][0]["success_at"] = success_at(60)
        log = crq.promotion_tick(q, False)
        self.assertTrue(any("GATE NEEDS HUMAN" in line for line in log))
        item = q["items"][0]
        self.assertEqual(item["state"], "promoting")
        self.assertEqual(item["gate_stalled_at"], crq.iso())
        self.assertIn("refused/needs-human", item["last_error"])
        alert = q["promotion"]["gate_alerts"][0]
        self.assertEqual((alert["item"], alert["sha"], alert["base"]), (item["id"], BATCH, BASE))
        self.assertIsNone(alert["acked"])
        self.mock_notify.assert_called_once()
        self.assertIn("PROMOTION GATE NEEDS HUMAN", self.mock_notify.call_args.args[0])
        self.assertEqual(self.gh_calls(), [])
        q = json.loads(json.dumps(q))  # durable state survives a process restart
        del q["items"][0]["dispatched"]
        crq.promotion_tick(q, False)
        self.assertEqual(len(q["promotion"]["gate_alerts"]), 1)
        self.mock_notify.assert_called_once()
        self.assertEqual(self.gh_calls(), [])

    def test_long_stall_escalates_without_gate_or_status_configuration(self):
        crq.PROMO["post_status"] = False
        self.mock_wf.return_value = False
        q = make_queue(success_at=success_at(23 * 60))
        crq.promotion_tick(q, False)
        self.assertIn("gate_stalled_at", q["items"][0])
        self.assertEqual(len(q["promotion"]["gate_alerts"]), 1)
        self.mock_notify.assert_called_once()
        self.mock_wf.assert_not_called()
        self.assertEqual(self.gh_calls(), [])

    def test_failed_or_unconfigured_notification_retries_with_backoff_without_gate_retry(self):
        for result in ({"paseo_send": "1: daemon unavailable"}, {}):
            with self.subTest(result=result):
                self.mock_notify.reset_mock()
                self.mock_notify.return_value = result
                q = make_queue(success_at=success_at(60))
                crq.promotion_tick(q, False)
                alert = q["promotion"]["gate_alerts"][0]
                self.assertNotIn("notified_at", alert)
                self.assertEqual(alert["notification"], result)
                self.assertEqual(alert["notify_after"], crq.iso(crq.now() + dt.timedelta(minutes=15)))
                q = json.loads(json.dumps(q))
                crq.promotion_tick(q, False)
                self.mock_notify.assert_called_once()
                self.mock_now.return_value += dt.timedelta(minutes=15)
                self.mock_notify.return_value = {"paseo_send": 0}
                crq.promotion_tick(q, False)
                alert = q["promotion"]["gate_alerts"][0]
                self.assertEqual(alert["notified_at"], crq.iso())
                self.assertEqual(self.mock_notify.call_count, 2)
                self.mock_now.return_value += dt.timedelta(minutes=30)
                crq.promotion_tick(q, False)
                self.assertEqual(self.mock_notify.call_count, 2)
                self.assertEqual(len(q["promotion"]["gate_alerts"]), 1)
                self.assertEqual(self.gh_calls(), [])

    def test_ack_cancels_failed_notification_retry_but_not_stall(self):
        self.mock_notify.return_value = {"paseo_send": "error: timeout"}
        q = make_queue(success_at=success_at(60))
        crq.promotion_tick(q, False)
        q["promotion"]["gate_alerts"][0]["acked"] = crq.iso()
        self.mock_now.return_value += dt.timedelta(minutes=15)
        crq.promotion_tick(q, False)
        self.mock_notify.assert_called_once()
        self.assertIn("gate_stalled_at", q["items"][0])
        self.assertEqual(self.gh_calls(), [])

    def test_stall_dry_run_only_describes_escalation(self):
        q = make_queue(success_at=success_at(61))
        before = json.dumps(q, sort_keys=True)
        log = crq.promotion_tick(q, True)
        self.assertTrue(any("would escalate" in line for line in log))
        self.assertEqual(json.dumps(q, sort_keys=True), before)
        self.mock_notify.assert_not_called()
        self.mock_event.assert_not_called()
        self.assertEqual(self.gh_calls(), [])

    def test_ack_keeps_stall_visible_and_does_not_retry(self):
        q = make_queue(success_at=success_at(60))
        crq.promotion_tick(q, False)
        with mock.patch.object(crq, "load_queue", return_value=q), \
             mock.patch.object(crq, "save_queue"), mock.patch.object(crq, "write_status"):
            crq.admin("promotion-ack", None, f"{BATCH[:10]} investigating gate refusal")
        self.assertIn("investigating gate refusal", q["promotion"]["gate_alerts"][0]["acked"])
        crq.promotion_tick(q, False)
        self.assertIn("gate_stalled_at", q["items"][0])
        self.mock_notify.assert_called_once()
        self.assertEqual(self.gh_calls(), [])

    def test_authorized_progress_closes_stalled_promotion(self):
        q = make_queue(success_at=success_at(60))
        crq.promotion_tick(q, False)
        with mock.patch.object(crq, "is_ancestor", return_value=True), \
             mock.patch.object(crq, "git", return_value="0"):
            crq.promotion_tick(q, False)
        self.assertEqual(q["items"][0]["state"], "done")
        self.assertEqual(q["promotion"]["last_promoted_sha"], BATCH)
        self.mock_notify.assert_called_once()
        self.assertEqual(self.gh_calls(), [])

    def test_stall_persists_in_status_until_acknowledged(self):
        q = make_queue(success_at=success_at(60))
        crq.promotion_tick(q, False)
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(crq, "STATE", Path(tmp)), \
             mock.patch.object(crq, "EVENTS", Path(tmp) / "events.jsonl"), \
             mock.patch.dict(crq.CONFIG, {"schedule_id": None}), \
             mock.patch.object(crq, "promotion_record", return_value=None), \
             mock.patch.object(crq.repair_tick, "digest", return_value={}), \
             mock.patch.object(crq.coverage, "utilization_digest", return_value={}), \
             mock.patch.object(crq.status_summary, "publish"):
            crq.write_status(q)
            self.assertIn("ALERT — PROMOTION GATE NEEDS HUMAN", (Path(tmp) / "status.md").read_text())
            data = json.loads((Path(tmp) / "status.json").read_text())
            self.assertEqual(data["promotion_gate_alerts"], q["promotion"]["gate_alerts"])
            self.assertEqual(data["items"][0]["gate_stalled_at"], crq.iso())
            q["promotion"]["gate_alerts"][0]["acked"] = crq.iso()
            crq.write_status(q)
            self.assertNotIn("ALERT — PROMOTION GATE NEEDS HUMAN", (Path(tmp) / "status.md").read_text())
            self.assertIn("Owner intervention required", (Path(tmp) / "status.md").read_text())
            data = json.loads((Path(tmp) / "status.json").read_text())
            self.assertEqual(data["promotion_gate_alerts"], [])
            self.assertEqual(data["items"][0]["gate_stalled_at"], crq.iso())


if __name__ == "__main__":
    unittest.main()
