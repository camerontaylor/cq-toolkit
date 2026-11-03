"""Cursor paging: bounded budgets, stable order, transient-failure honesty.

Split provenance: moved verbatim from test_merged_reconcile.py;
test_merged_reconcile_fixtures.py holds the shared offline fixtures.
"""
import unittest

from test_merged_reconcile_fixtures import A, B, FakeForge, cursor_page, mr, pr


class PagingTests(unittest.TestCase):
    def test_over_100_prs_across_many_pages_all_represented(self):
        total = 250
        page_size = 40
        pages, records = {}, []
        for index in range(total):
            records.append(pr(index + 1, "2026-10-%02dT12:00:00Z" % (1 + index // 25)))
        for start in range(0, total, page_size):
            chunk = records[start:start + page_size]
            more = start + page_size < total
            pages[None if start == 0 else "c%d" % start] = cursor_page(
                chunk, "c%d" % (start + page_size) if more else None)
        forge = FakeForge(pages)
        result = mr.reconcile(None, forge.fetch, repo="org/repo", after=A, before=B,
                              page_budget=mr.MAX_PAGE_BUDGET)
        self.assertTrue(result["complete"])
        self.assertEqual(result["summary"]["intents"], total)
        self.assertEqual(result["summary"]["unsupported"], 0)
        self.assertEqual(len(forge.calls), total // page_size + 1)

    def test_page_budget_stops_honestly_incomplete_with_next_cursor(self):
        pages = {None: cursor_page([pr(1, "2026-10-02T00:00:00Z"),
                                    pr(2, "2026-10-03T00:00:00Z")], "c1"),
                 "c1": cursor_page([pr(3, "2026-10-04T00:00:00Z")], None)}
        forge = FakeForge(pages)
        result = mr.reconcile(None, forge.fetch, repo="org/repo", after=A, before=B, page_budget=1)
        self.assertFalse(result["complete"])
        self.assertEqual(result["cursor"], "c1")
        self.assertEqual(result["summary"]["intents"], 2)
        self.assertEqual(result["summary"]["pending_review"], 2)

    def test_same_time_merges_have_stable_order(self):
        forge = FakeForge({None: cursor_page([pr(9, A[:11] + "05:00:00Z"),
                                              pr(7, A[:11] + "05:00:00Z"),
                                              pr(8, A[:11] + "05:00:00Z")], None)})
        result = mr.reconcile(None, forge.fetch, repo="org/repo", after=A, before=B, page_budget=1)
        order = [entry["pr"] for entry in result["inventory"]]
        self.assertEqual(order, [7, 8, 9])

    def test_prs_merged_outside_the_frozen_window_are_never_represented(self):
        def fetch(cursor):
            if cursor is None:
                return cursor_page([pr(1, "2026-09-30T23:59:59Z"),
                                    pr(2, "2026-10-28T00:00:00Z"),  # after 'before'
                                    pr(3, B)], "next")
            return cursor_page([])
        result = mr.reconcile(None, fetch, repo="org/repo", after=A, before=B, page_budget=2)
        self.assertEqual([entry["pr"] for entry in result["inventory"]], [3])

    def test_transient_page_failure_never_advances_the_watermark(self):
        attempts = {"count": 0}

        def fetch(cursor):
            attempts["count"] += 1
            raise mr.PageFailed("gh: HTTP 502")

        result = mr.reconcile(None, fetch, repo="org/repo", after=A, before=B, page_budget=4)
        self.assertFalse(result["complete"])
        self.assertEqual(result["pages_read"], 0)
        self.assertEqual(result["transient_failures"], 1)
        self.assertFalse(result["steps"][-1]["watermark_advanced"])

    def test_transient_failure_after_progress_resumes_from_checkpoint(self):
        state = {"mode": "flaky"}

        def fetch(cursor):
            if state["mode"] == "flaky" and cursor == "c1":
                raise mr.PageFailed("rate limited")
            if cursor is None:
                return cursor_page([pr(1, "2026-10-02T00:00:00Z")], "c1")
            return cursor_page([pr(2, "2026-10-03T00:00:00Z")], None)

        first = mr.reconcile(None, fetch, repo="org/repo", after=A, before=B, page_budget=5)
        self.assertFalse(first["complete"])
        self.assertEqual(first["transient_failures"], 1)
        self.assertEqual(first["summary"]["intents"], 1)
        state["mode"] = "ok"  # transient condition cleared
        second = mr.reconcile(None, fetch, repo="org/repo", after=A, before=B, page_budget=5,
                              checkpoint_raw=first)
        self.assertTrue(second["complete"])
        self.assertEqual(second["summary"]["intents"], 2)
        self.assertEqual(second["transient_failures"], 1)  # history retained

    def test_interrupted_page_read_leaves_honest_incomplete(self):
        class HalfPage(FakeForge):
            def fetch(self, cursor):
                if cursor == "c1":
                    raise mr.PageFailed("connection reset mid-page")
                return super().fetch(cursor)

        forge = HalfPage({None: cursor_page([pr(1, "2026-10-02T00:00:00Z")], "c1"),
                          "c1": []})
        result = mr.reconcile(None, forge.fetch, repo="org/repo", after=A, before=B, page_budget=3)
        self.assertFalse(result["complete"])
        self.assertEqual(result["cursor"], "c1")
        self.assertEqual(result["summary"]["intents"], 1)
