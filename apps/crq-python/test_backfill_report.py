"""Fixed-baseline removals, surviving debt and new-tip debt stay distinct."""
from pathlib import Path
import tempfile
import unittest

import backfill_report as reporting
import review_ledger as ledger
from test_backfill_accounting import Fixture


class ReportTest(unittest.TestCase):
    def test_capacity_requires_observations_including_zero_days(self):
        with tempfile.TemporaryDirectory() as td:
            f = Fixture(Path(td) / "repo")
            target = f.commit({"a": b"one\n"})
            ranked = {"target": target, "manifest_id": "m", "candidates": [{"tier": "T1"}], "required": [], "evidence_gaps": [], "paths": [], "evaluated_at": "2026-10-14T00:00:00Z"}
            original = reporting.baseline(f.repo, ranked, "p", "l", "2026-10-01T00:00:00Z")
            days = {f"2026-10-{day:02d}": {"completed_partitions": int(day == 1)} for day in range(1, 15)}
            incomplete = dict(days); del incomplete["2026-10-02"]
            self.assertIsNone(reporting.summary(f.repo, ranked, {"items": [], "backfill_daily_capacity": incomplete}, original)["baseline"]["estimated_days_at_observed_capacity"])
            self.assertEqual(reporting.summary(f.repo, ranked, {"items": [], "backfill_daily_capacity": days}, original)["baseline"]["estimated_days_at_observed_capacity"], 14)

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
