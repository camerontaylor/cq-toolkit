"""Offline health history and advisory transition fixtures."""
import json
import tempfile
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest import mock

import client_health as health
import crq


class HealthTests(unittest.TestCase):
    def test_checkout_metadata_without_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            git = root / ".git"
            git.mkdir()
            (git / "HEAD").write_text("a" * 40)
            self.assertEqual(health.checkout_sha(root), "a" * 40)
            (git / "HEAD").write_text("ref: refs/heads/main")
            (git / "packed-refs").write_text("b" * 40 + " refs/heads/main\n")
            self.assertEqual(health.checkout_sha(root), "b" * 40)
            worktree = root / "linked"
            worktree.mkdir()
            metadata = git / "worktrees" / "linked"
            metadata.mkdir(parents=True)
            (worktree / ".git").write_text("gitdir: " + str(metadata))
            (metadata / "HEAD").write_text("ref: refs/heads/main")
            (metadata / "commondir").write_text("../..")
            self.assertEqual(health.checkout_sha(worktree), "b" * 40)

    def runner(self):
        c = SimpleNamespace(CONFIG={}, ROOT=crq.ROOT, RUNNER_ROOT=crq.RUNNER_ROOT, save_queue=mock.Mock(), REPO="owner/repo", ForgeBudget=crq.ForgeBudget,
            forge_window=crq.forge_window, iso=lambda: "2026-11-02T00:00:00Z",
            run=mock.Mock(return_value=SimpleNamespace(stdout="a" * 40)), gh_json=mock.Mock())
        c.gh_json.side_effect = [[], {"number": 42}, {}, {}, {}, {}]
        return c

    def test_restart_streak_and_recovery(self):
        c = self.runner()
        q = {"merged_discovery": {"complete": False}, "items": [{"state": "pending"}, {"state": "blocked"}]}
        for n in range(1, 5):
            q = json.loads(json.dumps(q))  # simulate restart from durable queue
            health.record(c, q, discovery_enabled=True)
            self.assertEqual(q["client_health"]["incomplete_ticks"], n)
        self.assertEqual(c.gh_json.call_count, 2)
        self.assertEqual(health.snapshot(q)["pending"], 1)
        self.assertEqual(health.snapshot(q)["blocked"], 1)
        self.assertRegex(health.snapshot(q)["deployedSha"], r"^[0-9a-f]{40}$")
        q["merged_discovery"]["complete"] = True
        health.record(c, q, discovery_enabled=True)
        health.record(c, q, discovery_enabled=True)
        self.assertEqual(c.gh_json.call_count, 4)
        self.assertEqual(q["client_health"]["incomplete_ticks"], 0)
        q["merged_discovery"]["complete"] = False
        for _ in range(3):
            health.record(c, q, discovery_enabled=True)
        self.assertEqual(c.gh_json.call_count, 5)  # reopen stored issue, no new issue

    def test_skipped_discovery_preserves_streak(self):
        c = self.runner()
        q = {"merged_discovery": {"complete": False}}
        for _ in range(2):
            health.record(c, q, discovery_enabled=True)
        health.record(c, q, discovery_enabled=False)
        self.assertFalse(q["client_health"]["complete"])
        self.assertEqual(q["client_health"]["incomplete_ticks"], 2)
        health.record(c, q, discovery_enabled=True)
        self.assertTrue(q["client_health"]["issue_open"])

    def test_existing_issue_updated_once(self):
        c = self.runner()
        c.CONFIG["discovery_incomplete_ticks"] = 3
        c.gh_json.side_effect = [[{"number": 42, "title": health.TITLE, "body": health.MARKER}], {}]
        q = {"merged_discovery": {"complete": False}, "client_health": {"incomplete_ticks": 2}}
        health.record(c, q, discovery_enabled=True)
        health.record(c, q, discovery_enabled=True)
        self.assertEqual(c.gh_json.call_count, 2)
        self.assertIn("PATCH", c.gh_json.call_args.args[0])

    def test_exhausted_discovery_budget_does_not_starve_advisory(self):
        c = self.runner()
        q = {"merged_discovery": {"complete": False}, "client_health": {"incomplete_ticks": 3}}
        exhausted = crq.ForgeBudget(requests=0)
        with crq.forge_window(exhausted):
            self.assertEqual(health.record(c, q, discovery_enabled=True), [])
        self.assertTrue(q["client_health"]["issue_open"])
        self.assertEqual(q["client_health"]["issue_number"], 42)
        self.assertEqual(exhausted.remaining, 0)

    def test_advisory_budget_exhaustion_logged(self):
        c = self.runner()
        c.CONFIG["discovery_incomplete_ticks"] = 1
        c.ForgeBudget = lambda **kw: crq.ForgeBudget(requests=0)
        q = {"merged_discovery": {"complete": False}}
        self.assertIn("skipped or failed", health.record(c, q, discovery_enabled=True)[0])
        c.gh_json.assert_not_called()

    def test_ambiguous_create_is_not_repeated_after_restart(self):
        c = self.runner()
        c.CONFIG["discovery_incomplete_ticks"] = 1
        c.gh_json.side_effect = [[], RuntimeError("lost create response")]
        q = {"merged_discovery": {"complete": False}}
        persisted = []
        c.save_queue.side_effect = lambda q: persisted.append(json.loads(json.dumps(q)))
        self.assertIn("failed", health.record(c, q, discovery_enabled=True)[0])
        q = persisted[-1]
        self.assertTrue(q["client_health"]["opening"])
        c.gh_json.reset_mock(side_effect=True)
        c.gh_json.side_effect = [[], [{"number": 42, "title": health.TITLE, "body": health.MARKER}], {}]
        self.assertIn("skipped", health.record(c, q, discovery_enabled=True)[0])
        health.record(c, q, discovery_enabled=True)
        self.assertTrue(q["client_health"]["issue_open"])
        self.assertEqual(c.gh_json.call_count, 3)  # list, list, update; never a second create
        self.assertNotIn("--search", c.gh_json.call_args_list[0].args[0])

    def test_recovery_reconciles_an_ambiguous_opening(self):
        c = self.runner()
        q = {"merged_discovery": {"complete": True},
             "client_health": {"opening": True, "incomplete_ticks": 5}}
        c.gh_json.side_effect = [[{"number": 42, "title": health.TITLE, "body": health.MARKER}], {}, {}]
        self.assertEqual(health.record(c, q, discovery_enabled=True), [])
        self.assertFalse(q["client_health"]["issue_open"])
        self.assertFalse(q["client_health"]["opening"])
        self.assertEqual(c.gh_json.call_count, 3)

    def test_issue_updates_only_at_threshold_multiples(self):
        c = self.runner()
        q = {"merged_discovery": {"complete": False}}
        for _ in range(8):
            health.record(c, q, discovery_enabled=True)
        self.assertEqual(c.gh_json.call_count, 3)  # list/create at 3, update at 6
        self.assertIn("6 ticks", c.gh_json.call_args.args[0][-1])
        health.record(c, q, discovery_enabled=True)
        self.assertEqual(c.gh_json.call_count, 4)

    def test_checkout_does_not_search_parent_directories(self):
        self.assertIsNone(health.checkout_sha(crq.ROOT))
