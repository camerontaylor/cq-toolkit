"""Interval and page-budget bounds for merged reconciliation.

Split provenance: moved verbatim from test_merged_reconcile.py;
test_merged_reconcile_fixtures.py holds the shared offline fixtures.
"""
import unittest

from test_merged_reconcile_fixtures import A, B, mr


class IntervalTests(unittest.TestCase):
    def test_interval_shape_and_order_refused(self):
        for after, before in [("bad", B), (A, "2026-10-27 00:00:00"),
                              (A, A), (B, A), (None, B), (A, 17)]:
            with self.subTest(after=after, before=before):
                with self.assertRaises(mr.ReconcileRefused):
                    mr.normalize_interval(after, before)
        self.assertEqual(mr.normalize_interval(A, B), {"after": A, "before": B})

    def test_page_budget_is_bounded_positive_integer(self):
        for budget in [0, -1, True, "3", 3.0, None, mr.MAX_PAGE_BUDGET + 1]:
            with self.subTest(budget=budget):
                with self.assertRaises(mr.ReconcileRefused):
                    mr.normalize_page_budget(budget)
        self.assertEqual(mr.normalize_page_budget(1), 1)
        self.assertEqual(mr.normalize_page_budget(mr.MAX_PAGE_BUDGET),
                         mr.MAX_PAGE_BUDGET)
