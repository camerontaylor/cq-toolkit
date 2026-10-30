"""Fixed-baseline removals, surviving debt and new-tip debt stay distinct."""
from pathlib import Path
import tempfile
import unittest

import backfill_report as reporting
import review_ledger as ledger
from test_backfill_accounting import Fixture


class ReportTest(unittest.TestCase):
    def test_removed_lines_are_not_reviewed_and_new_lines_remain_debt(self):
        with tempfile.TemporaryDirectory() as td:
            f = Fixture(Path(td) / "repo")
            t = f.commit({"a": b"one\ntwo\n"})
            def rank(target, lines):
                return {"target": target, "manifest_id": "m", "candidates": [], "required": [], "evidence_gaps": [],
                        "paths": [{"path": "a", "blob": f.repo.entries(target)["a"]["blob"], "tier": "T1", "lines": lines,
                                   "uncovered": [[1, lines]], "disposition": "included", "reason": "text"}]}
            original = reporting.baseline(f.repo, rank(t, 2), "p", "l", "2026-10-30T00:00:00Z")
            current = f.commit({"a": b"one\nnew\nmore\n"})
            result = reporting.summary(f.repo, rank(current, 3), {"items": []}, original)
            self.assertEqual(result["baseline"]["surviving_T1_debt"], 1)
            self.assertEqual(result["baseline"]["baseline_T1_removed_or_superseded"], 1)
            self.assertEqual(result["baseline"]["baseline_T1_reviewed_since"], 0)
            self.assertEqual(result["baseline"]["new_T1_debt"], 2)
            self.assertFalse(result["strict_T1_zero"])

    def test_unmeasurable_object_prevents_strict_zero_even_without_countable_debt(self):
        ranked = {"target": "a" * 40, "manifest_id": "m", "required": [], "evidence_gaps": [],
                  "paths": [{"path": "binary", "tier": "T1", "lines": None, "uncovered": [], "disposition": "unsupported", "reason": "binary"}]}
        result = reporting.summary(None, ranked, {"items": []})
        self.assertFalse(result["strict_T1_zero"])
        self.assertEqual(len(result["tiers"]["T1"]["unresolved_objects"]), 1)


if __name__ == "__main__":
    unittest.main()
