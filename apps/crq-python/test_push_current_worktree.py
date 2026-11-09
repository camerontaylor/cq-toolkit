"""Review worktree construction: LFS smudge skips and checkout failures.

Split provenance: moved verbatim from apps/crq-python/test_push_current.py.
Fixtures live in test_push_current_fixtures.py.
"""
import unittest
import subprocess
from unittest import mock

from test_push_current_fixtures import PushTestBase, crq


class PushTest(PushTestBase, unittest.TestCase):
    def test_checkout_timeout_cleans_partial_worktree(self):
        with mock.patch.object(crq, 'remove_worktree') as remove, \
             mock.patch.object(crq, 'git', side_effect=subprocess.TimeoutExpired('git', 10)):
            with self.assertRaises(subprocess.TimeoutExpired):
                crq.make_worktree('wt-review', 'abc123', clone=self.foreign)
        self.assertEqual(remove.call_count, 2)

    def test_checkout_timeout_blocks_item(self):
        self.commit(self.foreign_origin, 'range work', when=self.ago(2), files={'code.py': 'x = 1\n'})
        item = self.enroll_push(floor=self.iso_of(self.ago(36)))
        plan = self.prepare(item)
        with mock.patch.object(crq, 'make_worktree', side_effect=subprocess.TimeoutExpired('git', 10)), \
             self.fake_spawn() as child:
            crq.launch(self.q, item, plan)
        self.assertEqual(self.spawns(child), [])
        self.assertEqual(item['state'], 'blocked')
        self.assertIn('checkout failed', item['last_error'])

    def test_review_worktree_skips_smudging_filters(self):
        with mock.patch.object(crq, "remove_worktree"), \
             mock.patch.object(crq, "git") as git:
            path, branch = crq.make_worktree("wt-review", "abc123", clone=self.foreign)
        self.assertEqual(branch, "crq/wt-review")
        self.assertEqual(path, crq.WT_ROOT / f"{crq.WT_PREFIX}wt-review")
        args, kwargs = git.call_args
        self.assertEqual(args[:6], ("-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=",
                                    "worktree", "add"))
        self.assertEqual(kwargs["env"]["GIT_LFS_SKIP_SMUDGE"], "1")
        self.assertEqual(kwargs["cwd"], self.foreign)

    def test_review_worktree_checkout_failure_blocks_cleanly(self):
        # A reviewed repository whose checkout fails (broken smudge/LFS filter,
        # #347) blocks that item; the tick itself survives.
        self.commit(self.foreign_origin, "range work", when=self.ago(2), files={"code.py": "x = 1\n"})
        item = self.enroll_push(floor=self.iso_of(self.ago(36)))
        plan = self.prepare(item)
        with mock.patch.object(crq, "make_worktree",
                               side_effect=RuntimeError("filter 'lfs' smudge failed")), \
             self.fake_spawn() as child:
            run_id = crq.launch(self.q, item, plan)
        self.assertEqual(self.spawns(child), [])
        self.assertTrue(run_id)
        self.assertEqual(item["state"], "blocked")
        self.assertIn("review worktree checkout failed", item["last_error"])
        self.assertIn("smudge failed", item["last_error"])
        self.assertEqual(self.q["starts"], [])
        blocked = [e for e in self.events() if e.get("event") == "blocked"]
        self.assertEqual([e["item"] for e in blocked], [item["id"]])


if __name__ == "__main__":
    unittest.main()
