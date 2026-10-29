"""Offline generic promotion-error retries: synthetic state, no child processes."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


_process_boundary_active = False
_module_resources = None
crq = None


def _deny_processes(event, args):
    if _process_boundary_active and event in {
            "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn",
            "os.spawn", "os.fork", "os.forkpty", "pty.spawn"}:
        raise AssertionError("offline promotion fixture forbids child processes")


sys.addaudithook(_deny_processes)


def _close_module():
    global _process_boundary_active
    try:
        if _module_resources is not None:
            _module_resources.close()
    finally:
        _process_boundary_active = False


def setUpModule():
    global _process_boundary_active, _module_resources, crq
    _process_boundary_active = True
    unittest.addModuleCleanup(_close_module)
    _module_resources = contextlib.ExitStack()
    root = Path(_module_resources.enter_context(tempfile.TemporaryDirectory()))
    source = Path(__file__).resolve().with_name("crq.py")
    config_path = source.with_name("config.json")
    config = {"clone": str(root / "clone"), "worktree_root": str(root / "worktrees"),
              "worktree_prefix": "offline", "repo": "owner/repo", "max_item_failures": 3,
              "error_backoff_min": 2, "rate_limit_default_backoff_min": 5,
              "promotion": {"enabled": True}}
    original_read_text = Path.read_text

    def synthetic_config(path, *args, **kwargs):
        if path == config_path:
            return json.dumps(config)
        return original_read_text(path, *args, **kwargs)

    spec = importlib.util.spec_from_file_location("promotion_error_retry_fixture_crq", source)
    crq = importlib.util.module_from_spec(spec)
    _module_resources.enter_context(mock.patch.dict(sys.modules, {spec.name: crq}))
    with mock.patch.object(Path, "read_text", synthetic_config), \
            mock.patch.dict(os.environ, {"CQ_WORK_RECORDS": str(root / "work.jsonl")}):
        spec.loader.exec_module(crq)


def tearDownModule():
    _close_module()


class PromotionErrorRetryTests(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.root = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        for name, path in (("STATE", self.root), ("RUNS", self.root / "runs"),
                           ("QUEUE", self.root / "queue.json"), ("EVENTS", self.root / "events.jsonl")):
            stack.enter_context(mock.patch.object(crq, name, path))
        stack.enter_context(mock.patch.object(crq, "run_liveness", return_value="harvest"))
        self.remove = stack.enter_context(mock.patch.object(crq, "remove_worktree"))
        for name in ("run", "git", "gh_json", "paseo_json", "notify_owner", "fetch", "make_worktree"):
            stack.enter_context(mock.patch.object(crq, name, side_effect=AssertionError("unexpected external effect")))
        self.launch = stack.enter_context(mock.patch.object(crq, "launch"))
        self.repair = stack.enter_context(mock.patch.object(crq.repair_tick, "enqueue"))
        self.clock = crq.dt.datetime(2026, 10, 30, tzinfo=crq.dt.timezone.utc)
        stack.enter_context(mock.patch.object(crq, "now", side_effect=lambda: self.clock))
        self.q = {"items": [], "starts": [], "paused": False}

    def item(self, failures=0):
        item = {"id": "promotion-fixture", "kind": "promotion", "state": "pending",
                "failures": failures, "run": None, "attempts": [],
                "base_sha": "a" * 40, "batch_sha": "b" * 40,
                "not_before": crq.iso(self.clock)}
        self.q = {"items": [item], "starts": [], "paused": False}
        return item

    def harvest(self, item, events, exit_code=1):
        run_id = "fixture-" + str(len(item["attempts"]) + 1)
        rdir = crq.RUNS / run_id
        rdir.mkdir(parents=True)
        item.update(state="reviewing", run={"run_id": run_id})
        meta = {"item_id": item["id"], "label": "offline promotion", "run_id": run_id,
                "base": item["base_sha"], "head": item["batch_sha"],
                "worktree": str(self.root / "fake-worktree"), "wt_branch": "fixture"}
        (rdir / "meta.json").write_text(json.dumps(meta))
        (rdir / "exit.json").write_text(json.dumps({"exit": exit_code, "ended_at": crq.iso()}))
        (rdir / "review.ndjson").write_text("\n".join(json.dumps(event) for event in events) + "\n")
        crq.harvest_review(self.q, item, False)
        return json.loads((rdir / "classification.json").read_text())

    def restart(self, item):
        crq.save_queue(self.q)
        self.q = crq.load_queue()
        return next(value for value in self.q["items"] if value["id"] == item["id"])

    def test_process_boundary_denies_absolute_shell_and_local_git_aliases(self):
        run_alias = subprocess.run
        for command, kwargs in (([sys.executable, "-c", "pass"], {}),
                ("true", {"shell": True, "executable": "/bin/sh"}),
                (["/usr/bin/git", "status"], {"cwd": str(self.root)})):
            with self.subTest(command=command), self.assertRaisesRegex(AssertionError, "forbids child"):
                run_alias(command, **kwargs)
        system_alias = os.system
        with self.assertRaisesRegex(AssertionError, "forbids child"):
            system_alias("true")

    def test_generic_errors_exhaust_persisted_retries_and_retain_promotion_slot(self):
        hard = {"type": "error", "errorType": "unknown"}
        vendor = {"type": "error", "errorType": "rate_limit", "recoverable": True}
        limit = crq.CONFIG["max_item_failures"]
        for events in ([hard], [hard, vendor], [vendor, hard]):
            with self.subTest(events=events):
                item = self.item()
                # Each stream gets its own artifact directory, without invoking launch.
                with mock.patch.object(crq, "RUNS", self.root / ("runs-" + str(len(events)) + "-" + events[0]["errorType"])):
                    for failure in range(1, limit + 1):
                        self.clock += crq.dt.timedelta(hours=2)
                        cls = self.harvest(item, events)
                        self.assertEqual(cls["outcome"], "error")
                        self.assertFalse(cls["counted"])
                        self.assertEqual([cause["code"] for cause in cls["failure_provenance"]["causes"]],
                                         [event["errorType"] for event in events] + ["unexpected-exit"])
                        self.assertFalse(crq.queue_transport._vendor_rate_limit({
                            "outcome": cls["outcome"], "counted": False, "classification": cls}))
                        self.assertEqual(item["failures"], failure)
                        self.assertEqual(len(item["attempts"]), failure)
                        self.assertTrue(all(a["outcome"] == "error" and not a["counted"] for a in item["attempts"]))
                        self.assertIsNone(item["run"])
                        self.assertEqual(item.get("cycles", []), [])
                        self.assertNotIn("coverage", self.q)
                        self.assertFalse(self.q["paused"])
                        self.assertNotIn("cooldown_until", self.q)
                        self.assertEqual(item["base_sha"], "a" * 40)
                        self.assertEqual(item["batch_sha"], "b" * 40)
                        if failure < limit:
                            self.assertEqual(item["state"], "pending")
                            self.assertEqual(item["not_before"], crq.iso(self.clock + crq.dt.timedelta(
                                minutes=min(60, crq.CONFIG["error_backoff_min"] * 2 ** (failure - 1)))))
                        else:
                            self.assertEqual(item["state"], "blocked")
                            self.assertIsNone(item["not_before"])
                        item = self.restart(item)
                self.assertEqual(item["state"], "blocked")
                self.assertEqual(item["last_error"], "error: " + cls["message"])
                # No hourly cap or pause can mask the blocked admission refusal.
                self.assertEqual(self.q["starts"], [])
                with mock.patch.object(crq, "coverage_fallback", return_value=(None, False)):
                    crq.start_one(self.q, [], False, None, False)
                self.launch.assert_not_called()
                with mock.patch.object(crq, "promotion_gate_live", return_value=True), \
                        mock.patch.object(crq, "promotion_mode", return_value="user"), \
                        mock.patch.object(crq, "main_sha", return_value="a" * 40), \
                        mock.patch.object(crq, "is_ancestor", return_value=False), \
                        mock.patch.object(crq, "cut_promotion") as cut, \
                        mock.patch.object(crq, "split_promotion") as split:
                    self.q["promotion"] = {"last_promoted_at": crq.iso()}
                    self.assertEqual(crq.promotion_tick(self.q, False), [])
                    self.assertIs(crq.open_promotion(self.q), item)
                    cut.assert_not_called()
                    split.assert_not_called()
                self.repair.assert_not_called()

    def test_already_exhausted_generic_error_blocks_immediately(self):
        limit = crq.CONFIG["max_item_failures"]
        item = self.item(failures=limit)
        cls = self.harvest(item, [{"type": "error", "errorType": "unknown"}])
        item = self.restart(item)
        self.assertEqual(item["state"], "blocked")
        self.assertEqual(item["failures"], limit + 1)
        self.assertIsNone(item["not_before"])
        self.assertFalse(cls["counted"])

    def test_skipped_keeps_split_precedence_even_at_retry_limit(self):
        item = self.item(failures=crq.CONFIG["max_item_failures"])
        cls = self.harvest(item, [{"type": "complete", "status": "review_skipped"}], exit_code=0)
        self.assertEqual(cls["outcome"], "skipped")
        self.assertFalse(cls["counted"])
        self.assertEqual(self.restart(item)["state"], "split_needed")

    def test_auth_and_vendor_rate_limit_keep_existing_operational_stops(self):
        limit = crq.CONFIG["max_item_failures"]
        for event, outcome in (({"type": "error", "errorType": "auth"}, "auth"),
                ({"type": "error", "errorType": "rate_limit", "recoverable": True}, "rate_limited")):
            with self.subTest(outcome=outcome), mock.patch.object(crq, "RUNS", self.root / outcome):
                item = self.item(failures=limit)
                cls = self.harvest(item, [event])
                item = self.restart(item)
                self.assertEqual(cls["outcome"], outcome)
                self.assertFalse(cls["counted"])
                self.assertEqual(item["state"], "pending")
                self.assertEqual(item["failures"], limit)
                if outcome == "auth":
                    self.assertTrue(self.q["paused"])
                else:
                    self.assertFalse(self.q["paused"])
                    self.assertIn("cooldown_until", self.q)
