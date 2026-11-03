"""Summary buckets, scope blindness, and the pure-module no-side-effect guard.

Split provenance: moved verbatim from test_merged_reconcile.py;
test_merged_reconcile_fixtures.py holds the shared offline fixtures.
"""
import unittest

from test_merged_reconcile_fixtures import A, B, FakeForge, cursor_page, mr, pr, sha, ROOT


class SummaryTests(unittest.TestCase):
    def test_totals_reconcile_to_the_inventory_with_honest_buckets(self):
        pages = {
            None: cursor_page([pr(1, "2026-10-02T00:00:00Z"),
                               {**pr(2, "2026-10-03T00:00:00Z"), "mergeCommit": None},
                               {"number": 3, "mergedAt": "nope",
                                "mergeCommit": {"oid": sha(3)}, "headRefOid": sha(4)}],
                              None)}
        result = mr.reconcile(None, FakeForge(pages).fetch, repo="org/repo", after=A, before=B,
                              page_budget=1)
        summary = result["summary"]
        self.assertEqual(summary["represented"], 3)
        self.assertEqual(summary["intents"], 1)
        self.assertEqual(summary["unsupported"], 2)
        self.assertEqual(summary["represented"],
                         summary["intents"] + summary["unsupported"])
        # pending/skip is never counted as reviewed
        self.assertEqual(summary["reviewed"], 0)
        self.assertEqual(summary["pending_review"], summary["intents"])
        self.assertTrue(summary["complete"])

    def test_deletion_only_small_and_docs_changes_still_become_intents(self):
        # discovery is scope-blind: path knowledge belongs to the tick's
        # capture, not the inventory
        pages = {None: cursor_page([pr(10, "2026-10-07T00:00:00Z"),
                                    pr(11, "2026-10-07T00:00:01Z"),
                                    pr(12, "2026-10-07T00:00:02Z")], None)}
        result = mr.reconcile(None, FakeForge(pages).fetch, repo="org/repo", after=A, before=B,
                              page_budget=1)
        self.assertEqual(result["summary"]["intents"], 3)


class NoSideEffectTests(unittest.TestCase):
    def test_pure_module_never_touches_queue_or_claims_review(self):
        source = (ROOT / "merged_reconcile.py").read_text()
        for forbidden in ("gh_json", "subprocess", "save_queue", "load_queue",
                          "repair_tick", "author_quota", "run([", "requests."):
            self.assertNotIn(forbidden, source)
        # no vendor call happened in these tests: every page was a fake
