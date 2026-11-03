"""Numeric-source windows: frozen universe, slot errors, capped inventory.

Split provenance: moved verbatim from test_merged_reconcile.py;
test_merged_reconcile_fixtures.py holds the shared offline fixtures.
"""
import json
import unittest

from test_merged_reconcile_fixtures import A, B, mr, pr


class NumericSourceTests(unittest.TestCase):
    def response(self, **fields):
        return {"data": {"repository": {"id": "R", "nameWithOwner": "owner/repo", **fields}}}

    def source(self, ceiling=125):
        return mr.freeze_source(lambda query: self.response(
            issues={"totalCount": 0, "nodes": []},
            pullRequests={"totalCount": ceiling, "nodes": [{"number": ceiling}]}),
            repo="owner/repo", base="merge-queue")

    def test_numeric_windows_survive_mutable_merge_order_and_new_prs(self):
        import re
        source = self.source()
        seen = []
        def forge(query):
            fields = {}
            for value in re.findall(r"issueOrPullRequest\(number:(\d+)\)", query):
                number = int(value)
                seen.append(number)
                fields["n" + value] = {"__typename": "PullRequest", "baseRefName": "merge-queue",
                    **pr(number, "2026-10-02T00:00:00Z" if number < 80 else "2026-10-28T00:00:00Z")}
            return self.response(**fields)
        cursor = None
        rows = []
        for _ in range(3):
            page = mr.number_page(forge, source, cursor, repo="owner/repo", base="merge-queue")
            rows.extend(page["records"])
            cursor = page["next_cursor"]
        self.assertEqual(seen, list(range(1, 126)))
        self.assertIsNone(cursor)
        self.assertEqual(len(rows), 125)
        # New number126 is outside frozen universe; merges after before filter out.
        result = mr.reconcile(None,
            lambda cursor: mr.number_page(forge, source, cursor, repo="owner/repo", base="merge-queue"),
            repo="owner/repo", after=A, before=B, page_budget=4)
        self.assertEqual(result["summary"]["intents"], 79)
        self.assertEqual(result["summary"]["outside_window"], 46)

    def test_missing_slot_errors_repo_drift_and_cursor_query_drift_refuse(self):
        source = self.source(1)
        for response in (self.response(n1=None), self.response(n1={"number": 1, "__typename": "Unknown"}),
                         {**self.response(), "errors": [{"message": "partial"}]},
                         self.response(id="replaced"), {**self.response(), "truncated": True}):
            with self.subTest(response=response), self.assertRaises(mr.ReconcileRefused):
                mr.number_page(lambda query: response, source, None, repo="owner/repo", base="merge-queue")
        source = self.source()
        wrong = json.dumps({"source": "0" * 64, "next": 51})
        with self.assertRaises(mr.ReconcileRefused):
            mr.number_page(lambda query: self.fail("must not fetch"), source, wrong,
                           repo="owner/repo", base="merge-queue")

    def test_ceiling_requires_all_state_counts_and_inventory_growth_is_capped(self):
        for fields in (
            {"issues": {"nodes": []}, "pullRequests": {"nodes": [{"number": 1}]}},
            {"issues": {"totalCount": 0, "nodes": []},
             "pullRequests": {"totalCount": 2, "nodes": [{"number": 1}]}}):
            with self.assertRaises(mr.ReconcileRefused):
                mr.freeze_source(lambda query: self.response(**fields), repo="owner/repo", base="merge-queue")
        from unittest import mock
        checkpoint = mr.new_checkpoint({"after": A, "before": B}, 1, repo="owner/repo", base="merge-queue")
        with mock.patch.object(mr, "MAX_INVENTORY", 1), self.assertRaises(mr.ReconcileRefused):
            mr.reconcile_page(checkpoint, [pr(1, "2026-10-02T00:00:00Z"), pr(2, "2026-10-02T00:00:00Z")])
        self.assertEqual(checkpoint["inventory"], [])
