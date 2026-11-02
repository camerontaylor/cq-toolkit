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
        c = SimpleNamespace(CONFIG={}, ROOT=crq.ROOT, REPO="owner/repo", ForgeBudget=crq.ForgeBudget,
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
        self.assertIsNone(q["client_health"]["complete"])
        self.assertEqual(q["client_health"]["incomplete_ticks"], 2)
        health.record(c, q, discovery_enabled=True)
        self.assertTrue(q["client_health"]["issue_open"])

    def test_existing_issue_updated_once(self):
        c = self.runner()
        c.CONFIG["discovery_incomplete_ticks"] = 1
        c.gh_json.side_effect = [[{"number": 42, "title": health.TITLE, "body": health.MARKER}], {}]
        q = {"merged_discovery": {"complete": False}}
        health.record(c, q, discovery_enabled=True)
        health.record(c, q, discovery_enabled=True)
        self.assertEqual(c.gh_json.call_count, 2)
        self.assertIn("PATCH", c.gh_json.call_args.args[0])

    def test_budget_exhaustion_advisory_only(self):
        c = self.runner()
        c.CONFIG["discovery_incomplete_ticks"] = 1
        q = {"merged_discovery": {"complete": False}}
        health.record(c, q, discovery_enabled=True, budget=crq.ForgeBudget(requests=0))
        c.gh_json.assert_not_called()
        self.assertEqual(q["client_health"]["incomplete_ticks"], 1)
        self.assertNotIn("issue_open", q["client_health"])
        c.gh_json.side_effect = RuntimeError("offline")
        health.record(c, q, discovery_enabled=True)
        self.assertEqual(q["client_health"]["incomplete_ticks"], 2)
