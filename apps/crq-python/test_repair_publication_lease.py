"""recover_publication leases the retried push on the verified tip, offline."""
import unittest
from unittest import mock

import repair_tick

HEAD, TARGET, STALE = "a" * 40, "b" * 40, "c" * 40
BRANCH = "crq/fix-run"


class FakeClient:
    """Records git calls; no network, no real repository."""

    REPO = "owner/repo"

    def __init__(self, *, remote=None, pr=None, ancestors=()):
        self.remote, self.pr, self.ancestors = remote, pr, set(ancestors)
        self.pushes = []

    def git(self, *args, **kwargs):
        if args[0] == "ls-remote":
            return (self.remote + "\trefs/heads/" + BRANCH) if self.remote else ""
        if args[0] == "push":
            self.pushes.append(args)
            return ""
        raise AssertionError(args)

    def gh_json(self, args):
        return []

    def pr_info(self, number):
        return self.pr

    def is_ancestor(self, older, newer):
        return (older, newer) in self.ancestors


def run(c, *, open_pr):
    publication = {"head": HEAD, "target": TARGET, "branch": BRANCH, "open_pr": open_pr,
                   "commits": [HEAD]}
    record = {}
    with mock.patch.object(repair_tick, "finalize_publication") as finalize:
        repair_tick.recover_publication(c, {}, {"pr": 7}, "run", record, publication)
    return finalize, record


class RecoverPublicationLeaseTest(unittest.TestCase):
    def test_open_pr_push_leases_on_the_journaled_target_not_the_stale_remote_read(self):
        # ls-remote reports a maintainer-reset ancestor; the PR head is the journaled target.
        pr = {"state": "OPEN", "headRefName": BRANCH, "headRefOid": TARGET}
        c = FakeClient(remote=STALE, pr=pr, ancestors={(TARGET, HEAD), (STALE, HEAD)})
        finalize, _ = run(c, open_pr=True)
        self.assertEqual(c.pushes, [("push", "origin", "--force-with-lease=refs/heads/" + BRANCH + ":" + TARGET,
                                     HEAD + ":refs/heads/" + BRANCH)])
        finalize.assert_called_once()

    def test_open_pr_target_that_is_not_an_ancestor_of_head_refuses_without_pushing(self):
        pr = {"state": "OPEN", "headRefName": BRANCH, "headRefOid": TARGET}
        c = FakeClient(remote=STALE, pr=pr, ancestors=())
        with self.assertRaisesRegex(ValueError, "would not fast-forward"):
            run(c, open_pr=True)
        self.assertEqual(c.pushes, [])

    def test_open_pr_already_at_head_finalizes_without_pushing(self):
        pr = {"state": "OPEN", "headRefName": BRANCH, "headRefOid": HEAD}
        c = FakeClient(remote=STALE, pr=pr)
        finalize, _ = run(c, open_pr=True)
        self.assertEqual(c.pushes, [])
        finalize.assert_called_once()

    def test_non_pr_branch_that_differs_from_the_prepared_head_refuses(self):
        c = FakeClient(remote=STALE, ancestors={(STALE, HEAD)})
        with self.assertRaisesRegex(ValueError, "existing fix branch differs"):
            run(c, open_pr=False)
        self.assertEqual(c.pushes, [])

    def test_non_pr_missing_remote_pushes_with_an_empty_lease(self):
        c = FakeClient(remote=None)
        finalize, _ = run(c, open_pr=False)
        self.assertEqual(c.pushes[0][2], "--force-with-lease=refs/heads/" + BRANCH + ":")
        finalize.assert_called_once()

    def test_open_pr_closed_marks_the_record_stale_without_pushing(self):
        pr = {"state": "CLOSED", "headRefName": BRANCH, "headRefOid": TARGET}
        finalize, record = run(FakeClient(remote=TARGET, pr=pr), open_pr=True)
        self.assertEqual(record, {"state": "stale", "error": "PR no longer publishable"})
        finalize.assert_not_called()

    def test_open_pr_head_moved_past_the_target_marks_the_record_stale(self):
        pr = {"state": "OPEN", "headRefName": BRANCH, "headRefOid": STALE}
        c = FakeClient(remote=STALE, pr=pr)
        finalize, record = run(c, open_pr=True)
        self.assertEqual(record["state"], "stale")
        self.assertEqual(c.pushes, [])
        finalize.assert_not_called()

    def test_non_pr_branch_with_a_mismatching_fix_pr_refuses(self):
        c = FakeClient(remote=HEAD)
        c.gh_json = lambda args: [{"headRefOid": STALE}]
        with self.assertRaisesRegex(ValueError, "fix PR identity"):
            run(c, open_pr=False)
        self.assertEqual(c.pushes, [])

    def test_non_pr_branch_with_one_fix_pr_at_the_prepared_head_finalizes(self):
        c = FakeClient(remote=HEAD)
        c.gh_json = lambda args: [{"headRefOid": HEAD}]
        finalize, _ = run(c, open_pr=False)
        self.assertEqual(c.pushes, [])
        finalize.assert_called_once()


if __name__ == "__main__":
    unittest.main()
