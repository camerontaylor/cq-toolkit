"""PR enrollment: open-PR items, the target-branch chain, delta evidence and the
pre-read head fetch.

Split provenance: moved verbatim from apps/crq-python/test_pr_enroll.py.
Fixtures live in test_pr_enroll_fixtures.py.
"""
import unittest
from pathlib import Path
from unittest import mock

from test_pr_enroll_fixtures import FOREIGN, PrTestBase, crq


class PrTest(PrTestBase, unittest.TestCase):
    def test_open_pr_enrollment_target_chain_and_drafts(self):
        h5 = self.foreign_commit("pr work", {"a.txt": "a\n"})
        rows = [self.pr_row(5, h5),
                self.pr_row(6, self.base, base="other-branch"),
                self.pr_row(7, h5, draft=True)]
        log = self.enroll(rows)
        item = next(i for i in self.q["items"] if i["id"] == "infra-pr5")
        self.assertEqual(item["repo"], FOREIGN)
        self.assertEqual(item["pr"], 5)
        self.assertEqual(item["kind"], "open")
        self.assertEqual(item["tier"], 1)
        self.assertEqual(item["prior_cycles"], 0)
        self.assertEqual(item["state"], "pending")
        self.assertEqual(crq.item_repo(item), FOREIGN)
        # A PR targeting another branch is logged and skipped; drafts skip quietly.
        self.assertTrue(any("PR #6 targets other-branch, not main" in line for line in log), log)
        self.assertEqual([i["id"] for i in self.q["items"]], ["infra-pr5"])
        # Re-enrollment is idempotent (ids are sticky).
        self.enroll(rows)
        self.assertEqual([i["id"] for i in self.q["items"]], ["infra-pr5"])

    def test_delta_evidence_after_a_captured_cycle(self):
        h1 = self.foreign_commit("pr work", {"a.txt": "a\n"})
        self.enroll([self.pr_row(5, h1)])
        item = self.q["items"][0]
        pin = self.git(self.foreign, "merge-base", "origin/main", h1)
        item["state"] = "done"
        item["cycles"] = [{"run_id": "run-1", "cycle": 1, "base": pin, "head": h1, "pr_head": h1,
                           "dirty_diff": "clean tree", "range_policy": "full-range-once-v1",
                           "completed_at": crq.iso()}]
        # An unchanged head with equivalent captured evidence enrolls nothing.
        log = self.enroll([self.pr_row(5, h1)])
        self.assertEqual([i["id"] for i in self.q["items"]], ["infra-pr5"])
        self.assertTrue(all("enrolled" not in line for line in log), log)
        # A new head owes exactly one delta item with the repo-prefixed range id.
        h2 = self.foreign_commit("more pr work", {"a.txt": "a\nb\n"})
        self.enroll([self.pr_row(5, h2)])
        delta = next(i for i in self.q["items"] if i["kind"] == "delta")
        self.assertEqual(delta["id"], f"infra-pr5-range-{pin[:10]}-{h2[:10]}")
        self.assertEqual(delta["repo"], FOREIGN)
        self.assertEqual(delta["followup"], "open")
        self.assertEqual(delta["state"], "pending")

    def test_pr_heads_are_fetched_before_local_reads(self):
        # The quiet window reads the head locally before planning, so every
        # enrollable PR's head must be fetched first, even on first enrollment.
        h1 = self.foreign_commit("pr work", {"a.txt": "a\n"})
        calls = mock.Mock()
        with mock.patch.object(crq, "fetch") as fetch, \
             mock.patch.object(crq, "ensure_commit", return_value=True) as ensure, \
             mock.patch.object(crq, "git", wraps=crq.git) as git:
            calls.attach_mock(fetch, "fetch")
            calls.attach_mock(ensure, "ensure")
            calls.attach_mock(git, "git")
            self.enroll([self.pr_row(5, h1)])
        fetch.assert_called_once()
        self.assertEqual(fetch.call_args.kwargs["clone"], Path(self.foreign))
        self.assertIn("refs/heads/main", fetch.call_args.kwargs["refspec"])
        ensure.assert_called_once()
        self.assertEqual(ensure.call_args.args[:2], (5, h1))
        self.assertEqual(ensure.call_args.kwargs["clone"], Path(self.foreign))
        self.assertEqual(calls.mock_calls, [
            mock.call.fetch(clone=Path(self.foreign),
                            refspec="+refs/heads/main:refs/remotes/origin/main"),
            mock.call.ensure(5, h1, clone=Path(self.foreign)),
            mock.call.git("merge-base", "origin/main", h1, cwd=Path(self.foreign)),
        ])


if __name__ == "__main__":
    unittest.main()
