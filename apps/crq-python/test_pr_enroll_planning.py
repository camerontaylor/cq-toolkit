"""PR planning: the merge-base pin computed in the repo's own clone and the
foreign item's repo-tier rank.

Split provenance: moved verbatim from apps/crq-python/test_pr_enroll.py.
Fixtures live in test_pr_enroll_fixtures.py.
"""
import unittest

from test_pr_enroll_fixtures import FOREIGN, PrTestBase, crq


class PrTest(PrTestBase, unittest.TestCase):
    def test_plan_computes_the_merge_base_in_the_repo_clone(self):
        h1 = self.foreign_commit("pr work", {"a.txt": "a\n"})
        self.enroll([self.pr_row(5, h1)])
        item = self.q["items"][0]
        plan = crq.plan_open(item, self.pr_view(5, h1), False)
        # The primary clone lacks these commits entirely: only the repo's own
        # clone can produce this pin.
        self.assertEqual(plan["base"], self.base)
        self.assertEqual(plan["target"], "origin/main")
        self.assertEqual(plan["head"], h1)
        self.assertEqual(plan["range_policy"], "full-range-once-v1")
        self.assertEqual(item["pinned_base"], self.base)
        self.assertEqual(item["target_ref"], "origin/main")
        # The delta plan runs in the same clone. A delta only enrolls once the
        # owed open review is terminal (a pending open item re-plans instead).
        item["state"] = "done"
        h2 = self.foreign_commit("more pr work", {"a.txt": "a\nb\n"})
        self.enroll([self.pr_row(5, h2)])
        delta = next(i for i in self.q["items"] if i["kind"] == "delta")
        dplan = crq.plan_delta(delta, self.pr_view(5, h2), False)
        self.assertEqual(dplan["base"], self.base)
        self.assertEqual(dplan["target"], "origin/main")
        self.assertEqual(dplan["head"], h2)

    def test_foreign_open_item_ranks_at_repo_tier(self):
        primary_open = {"id": "pr1", "pr": 1, "kind": "open", "state": "pending", "order": 2}
        foreign_open = {"id": "infra-pr1", "pr": 1, "kind": "open", "repo": FOREIGN,
                        "state": "pending", "order": 3}
        self.assertEqual(crq.rank(primary_open), 0)
        self.assertEqual(crq.rank(foreign_open), 3)
        self.assertEqual([i["id"] for i in sorted([foreign_open, primary_open], key=crq.sort_key)],
                         ["pr1", "infra-pr1"])


if __name__ == "__main__":
    unittest.main()
