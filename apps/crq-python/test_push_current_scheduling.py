"""Push-item scheduling and the reviewed-tip advance on counted harvest.

Split provenance: moved verbatim from apps/crq-python/test_push_current.py.
Fixtures live in test_push_current_fixtures.py.
"""
import unittest

from test_push_current_fixtures import (COMPLETE, FOREIGN, PushTestBase, crq,
                                        push_current, review_receipt)


class PushTest(PushTestBase, unittest.TestCase):
    def test_foreign_push_item_sorts_between_primary_and_backfill(self):
        self.repos[0] = self.cfg(rank_tier=3)
        current = {"id": "current-x", "kind": review_receipt.KIND, "pr": 7, "state": "pending", "order": 1}
        push = {"id": "push-infra-aaaaaaaaa0-bbbbbbbbb0", "kind": push_current.KIND, "pr": 0,
                "repo": FOREIGN, "state": "pending", "order": 2}
        backfill = {"id": "bf-1", "kind": crq.backfill_jobs.KIND, "pr": 0, "state": "pending", "order": 3}
        self.assertEqual(crq.rank(current), 2)
        self.assertEqual(crq.rank(push), 3)
        self.assertEqual(crq.rank(backfill), crq.coverage.COVERAGE_RANK)
        self.assertEqual([i["id"] for i in sorted([backfill, push, current], key=crq.sort_key)],
                         ["current-x", "push-infra-aaaaaaaaa0-bbbbbbbbb0", "bf-1"])

    def test_foreign_open_prs_precede_older_push_items_at_every_repo_rank(self):
        for tier in (2, 3, 4):
            with self.subTest(rank_tier=tier):
                self.repos[0] = self.cfg(rank_tier=tier)
                push = {"id": "push", "kind": push_current.KIND, "pr": 0,
                        "repo": FOREIGN, "state": "pending", "order": 1}
                opened = {"id": "open", "kind": "open", "pr": 1, "tier": 1,
                          "repo": FOREIGN, "state": "pending", "order": 3}
                delta = {"id": "delta", "kind": "delta", "pr": 1, "followup": "open",
                         "repo": FOREIGN, "state": "pending", "order": 2}
                merged = dict(delta, id="merged", followup="merged")
                self.assertEqual([i["id"] for i in sorted([push, delta, opened], key=crq.sort_key)],
                                 ["open", "delta", "push"])
                self.assertEqual(crq.rank(push), tier)
                self.assertEqual(crq.rank(merged), tier)

    def test_harvest_advances_reviewed_tip_only_when_counted(self):
        self.repos[0] = self.cfg(floor=self.iso_of(self.ago(36)))
        self.commit(self.foreign_origin, "mid work", when=self.ago(2), files={"b.txt": "b\n"})
        self.assertEqual(self.tick(), 0)   # floor init
        self.assertEqual(self.tick(), 1)   # enroll + launch the push item
        self.q = crq.load_queue()
        item = self.the_item()
        target = item["capture"]["target"]
        self.assertEqual(item["state"], "reviewing")
        self.terminal_artifacts(item)
        self.assertEqual(self.tick(), 0)   # third tick harvests the counted review
        self.q = crq.load_queue()
        item = next(i for i in self.q["items"] if i["id"] == item["id"])
        self.assertEqual(item["state"], "done")
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], target)
        doc = self.document(item)
        self.assertTrue(doc["counted"])
        self.assertEqual(doc["outcome"], "terminal-clean")
        self.assertEqual(doc["source"]["repo"], FOREIGN)
        # The early-returning push-current harvest still feeds status outcomes.
        finished = [e for e in self.events() if e["event"] == "review_finished"]
        self.assertEqual([(e["item"], e["outcome"]) for e in finished], [(item["id"], "completed")])
        # A failed review never advances the reviewed tip.
        c3 = self.commit(self.foreign_origin, "later work", when=self.ago(1), files={"e.txt": "e\n"})
        self.assertEqual(self.tick(), 1)   # enroll + launch the next range
        self.q = crq.load_queue()
        item2 = next(i for i in self.q["items"]
                     if i.get("kind") == push_current.KIND and i["id"] != item["id"])
        self.assertEqual((item2["subject"]["base"], item2["subject"]["head"]), (target, c3))
        self.assertEqual(item2["state"], "reviewing")
        result, remove = self.harvest(item2, [None, COMPLETE])  # malformed stream: not counted
        self.assertEqual(item2["state"], "pending")
        self.assertTrue(item2.get("not_before"))
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], target)
        self.assertFalse(self.document(item2)["counted"])
        remove.assert_called_once()


if __name__ == "__main__":
    unittest.main()
