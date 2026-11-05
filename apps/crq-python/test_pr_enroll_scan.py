"""Foreign open-PR scan classes: the universal class set runs over the range,
publish-only vocabulary does not, and an inline secret blocks the launch.

Split provenance: moved verbatim from apps/crq-python/test_pr_enroll.py.
Fixtures live in test_pr_enroll_fixtures.py.
"""
import json
import unittest
from unittest import mock

from test_pr_enroll_fixtures import _FLEET_PROSE, PrTestBase, crq


class PrTest(PrTestBase, unittest.TestCase):
    def test_foreign_open_scan_fleet_prose_does_not_block(self):
        prose = self.foreign_commit("fleet prose", {"notes.md": _FLEET_PROSE})
        self.enroll([self.pr_row(5, prose)])
        item = self.q["items"][0]
        plan = crq.plan_open(item, self.pr_view(5, prose), False)
        with mock.patch.object(crq.shutil, "which", return_value=None), \
             mock.patch.object(crq, "make_worktree", return_value=(self.root / "wt", "fixture")) as wt, \
             self.fake_spawn():
            crq.launch(self.q, item, plan)
        self.assertEqual(item["state"], "reviewing")
        wt.assert_called_once()  # the worktree was cut from the repo clone path
        scan = self.scan_result(item)
        # Only the four universal secret-shape classes ran over the PR range:
        # publish vocabulary is primary-only, so fleet prose is clean.
        self.assertEqual(scan["denylist_rules"], 4)
        self.assertEqual(scan["denylist_hits"], [])

    def test_foreign_open_scan_inline_secret_blocks(self):
        leak = self.foreign_commit("leaked value", {"deploy.sh": "password = supersecretvalue\n"})
        self.enroll([self.pr_row(5, leak)])
        item = self.q["items"][0]
        plan = crq.plan_open(item, self.pr_view(5, leak), False)
        with mock.patch.object(crq.shutil, "which", return_value=None):
            run_id = crq.launch(self.q, item, plan)  # a blocked launch never reaches worktree/spawn
        self.assertEqual(item["state"], "blocked")
        self.assertEqual(self.q["starts"], [])
        scan = json.loads((crq.RUNS / run_id / "secret-scan.json").read_text())
        self.assertEqual([h["rule"] for h in scan["denylist_hits"]], ["class:inline-secret-assignments"])


if __name__ == "__main__":
    unittest.main()
