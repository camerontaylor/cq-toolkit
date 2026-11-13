"""Fixed-baseline removals, surviving debt and new-tip debt stay distinct."""
from pathlib import Path
import tempfile
import unittest

import backfill_report as reporting
import review_ledger as ledger
from test_backfill_accounting import Fixture


class ReportTest(unittest.TestCase):
    def test_triage_uses_current_occurrences_and_keeps_human_evidence_link(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.assertEqual(reporting.finding_triage(root), {"counts": {}, "needs_human": []})
            rows = root / "triage"
            rows.mkdir()
            def write(fid, status):
                row = {"status": status, "canonical_id": "canonical", "target": "old",
                       "target_current": "new", "mapped_path": "moved.py", "previous_event_id": "event",
                       "finding": {"id": fid, "path": "old.py", "title": "Problem", "severity": "major"}}
                ledger.atomic(rows / (fid + ".json"), ledger.canonical(row))
            write("a", "needs-human")
            write("b", "duplicate")
            write("c", "needs-retriage")
            for status in ("untriaged", "confirmed", "delivered", "fixed"):
                write(status, status)
            result = reporting.finding_triage(root)
            self.assertEqual(result['owner_decisions_count'], 0)
            self.assertEqual(result['operator_attention_count'], 1)
            self.assertEqual(result['unknown_failure_class_count'], 1)
            self.assertEqual(result['unknown_failure_class'][0]['failure_class'], None)
            self.assertIn('unknown_failure_class_note', result)
            self.assertEqual(result['owner_decisions'], [])
            self.assertEqual(result['operator_attention'], [])
            row_path = rows / 'a.json'
            classified = ledger.loads(row_path.read_bytes())
            classified['failure_class'] = 'exhausted'
            ledger.atomic(row_path, ledger.canonical(classified))
            split = reporting.finding_triage(root)
            self.assertEqual(split['owner_decisions_count'], 0)
            self.assertEqual(split['operator_attention_count'], 1)
            self.assertEqual(split['operator_attention'][0]['failure_class'], 'exhausted')
            self.assertEqual(split['unknown_failure_class_count'], 0)
            classified['failure_class'] = 'owner-decision'
            ledger.atomic(row_path, ledger.canonical(classified))
            owned = reporting.finding_triage(root)
            self.assertEqual(owned['owner_decisions_count'], 1)
            self.assertEqual(owned['owner_decisions'][0]['failure_class'], 'owner-decision')
            self.assertEqual(owned['operator_attention_count'], 0)
            classified['failure_class'] = 'not-a-class'
            ledger.atomic(row_path, ledger.canonical(classified))
            foreign = reporting.finding_triage(root)
            self.assertEqual(foreign['owner_decisions_count'], 0)
            self.assertEqual(foreign['owner_decisions'], [])
            self.assertEqual(foreign['operator_attention_count'], 1)
            self.assertEqual(foreign['unknown_failure_class_count'], 1)
            self.assertEqual(foreign['unknown_failure_class'][0]['failure_class'], 'not-a-class')
            classified.pop('failure_class')
            ledger.atomic(row_path, ledger.canonical(classified))
            self.assertEqual(result["counts"], {"needs-human": 1, "duplicate": 1, "needs-retriage": 1,
                "untriaged": 1, "confirmed": 1, "delivered": 1, "fixed": 1})
            self.assertEqual(result["needs_human"], [{"id": "a", "canonical_id": "canonical",
                "path": "moved.py", "title": "Problem", "severity": "major", "target": "new", "event_id": "event"}])
            ranked = {"manifest_id": "m", "target": "new", "paths": [], "required": [], "evidence_gaps": []}
            report = reporting.summary(None, ranked, {"backfill_finding_backlog": {"untriaged": 99}}, findings_root=root)
            self.assertEqual(report["finding_triage"], result)
            self.assertEqual(report["finding_delivery_backlog"], result["counts"])
            write("a", "fixed")
            self.assertEqual(reporting.finding_triage(root)["needs_human"], [])

    def test_legacy_row_without_failure_class_is_never_an_owner_decision(self):
        """D7 fail-before regression: a needs-human row written before typed
        failure classes existed (d41 repair_outcome rows carry none) must not
        be reported as an owner decision, with or without a limit."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            rows = root / "triage"
            rows.mkdir()

            def write(fid):
                row = {"status": "needs-human", "canonical_id": "canonical", "target": "old",
                       "target_current": "new", "mapped_path": "moved.py", "previous_event_id": "event",
                       "finding": {"id": fid, "path": "old.py", "title": "Problem", "severity": "major"}}
                ledger.atomic(rows / (fid + ".json"), ledger.canonical(row))

            write("legacy-a")
            write("legacy-b")
            result = reporting.finding_triage(root)
            self.assertEqual(result["counts"], {"needs-human": 2})
            self.assertEqual(result["owner_decisions_count"], 0)
            self.assertEqual(result["operator_attention_count"], 2)
            self.assertEqual(result["unknown_failure_class_count"], 2)
            self.assertEqual([r["failure_class"] for r in result["unknown_failure_class"]], [None, None])
            self.assertIn("unknown_failure_class_note", result)
            limited = reporting.finding_triage(root, strict=False, limit=1)
            self.assertEqual(limited["owner_decisions_count"], 0)
            self.assertEqual(limited["operator_attention_count"], 2)
            self.assertEqual(limited["unknown_failure_class"], [r for r in result["unknown_failure_class"]][:1])
            self.assertEqual(limited["unknown_failure_class_omitted"], 1)

    def test_non_string_failure_class_is_unknown_and_never_blocks_publication(self):
        """Regression for the critic P2: an unhashable JSON failure_class (list,
        object, boolean, number) must land in the unknown bucket without raising,
        under strict=True and strict=False alike, and must never count as an
        owner decision."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            rows = root / "triage"
            rows.mkdir()

            def write(fid, klass):
                row = {"status": "needs-human", "canonical_id": "canonical", "target": "old",
                       "target_current": "new", "mapped_path": "moved.py", "previous_event_id": "event",
                       "failure_class": klass,
                       "finding": {"id": fid, "path": "old.py", "title": "Problem", "severity": "major"}}
                ledger.atomic(rows / (fid + ".json"), ledger.canonical(row))

            values = [["x"], {"kind": "weird"}, True, 3, None]
            for index, klass in enumerate(values):
                write(f"odd-{index}", klass)
            for strict, limit in ((True, None), (False, 32), (False, 2)):
                result = reporting.finding_triage(root, strict=strict, limit=limit)
                self.assertEqual(result["owner_decisions_count"], 0, (strict, limit))
                self.assertEqual(result["operator_attention_count"], 5, (strict, limit))
                self.assertEqual(result["unknown_failure_class_count"], 5, (strict, limit))
            whole = reporting.finding_triage(root)
            self.assertEqual([r["failure_class"] for r in whole["unknown_failure_class"]], values)
            bounded = reporting.finding_triage(root, strict=False, limit=2)
            self.assertEqual(len(bounded["unknown_failure_class"]), 2)
            self.assertEqual(bounded["unknown_failure_class_omitted"], 3)
            self.assertEqual(bounded["needs_human_omitted"], 3)

    def test_corrupt_triage_is_not_reported_as_zero(self):
        with tempfile.TemporaryDirectory() as td:
            rows = Path(td) / "triage"
            rows.mkdir()
            (rows / "bad.json").write_text("not json")
            with self.assertRaises(ValueError):
                reporting.finding_triage(Path(td))

    def test_ambiguous_rename_stays_unresolved_but_pure_deletion_is_removed(self):
        with tempfile.TemporaryDirectory() as td:
            f = Fixture(Path(td) / "repo")
            old = f.commit({"a": b"one\n", "duplicate": b"one\n"})
            row = {"path": "a", "blob": f.repo.entries(old)["a"]["blob"], "tier": "T1", "lines": 1, "uncovered": [[1, 1]], "disposition": "included", "reason": "text"}
            def rank(target, paths):
                return {"target": target, "manifest_id": "m", "paths": paths, "candidates": [], "required": [], "evidence_gaps": []}
            original = reporting.baseline(f.repo, rank(old, [row]), "p", "l", "2026-10-30T00:00:00Z")
            moved = f.commit({"a": None, "renamed": b"one\n"})
            renamed = {**row, "path": "renamed", "blob": f.repo.entries(moved)["renamed"]["blob"]}
            result = reporting.summary(f.repo, rank(moved, [renamed]), {"items": []}, original)["baseline"]
            self.assertTrue(result["unresolved_baseline_objects"])
            self.assertEqual(result["baseline_T1_removed_or_superseded"], 0)
            self.assertNotEqual(result["target_status"], "baseline-zero")
            pure = Fixture(Path(td) / "pure")
            base = pure.commit({"a": b"one\n"})
            row["blob"] = pure.repo.entries(base)["a"]["blob"]
            pure_original = reporting.baseline(pure.repo, rank(base, [row]), "p", "l", "2026-10-30T00:00:00Z")
            deleted = pure.commit({"a": None})
            result = reporting.summary(pure.repo, rank(deleted, []), {"items": []}, pure_original)["baseline"]
            self.assertEqual(result["baseline_T1_removed_or_superseded"], 1)
            self.assertFalse(result["unresolved_baseline_objects"])

    def test_unsupported_baseline_can_resolve_at_verified_current_path(self):
        with tempfile.TemporaryDirectory() as td:
            f = Fixture(Path(td) / "repo")
            old = f.commit({"a": b"\x00binary"})
            row = {"path": "a", "blob": f.repo.entries(old)["a"]["blob"], "tier": "T1", "lines": None, "uncovered": [], "disposition": "unsupported", "reason": "binary"}
            def rank(target, paths):
                return {"target": target, "manifest_id": "m", "paths": paths, "candidates": [], "required": [], "evidence_gaps": []}
            original = reporting.baseline(f.repo, rank(old, [row]), "p", "l", "2026-10-30T00:00:00Z")
            head = f.commit({"a": b"text\n"})
            current = {**row, "blob": f.repo.entries(head)["a"]["blob"], "lines": 1, "disposition": "included", "uncovered": []}
            result = reporting.summary(f.repo, rank(head, [current]), {"items": []}, original)["baseline"]
            self.assertFalse(result["unresolved_baseline_objects"])
            self.assertEqual(result["target_status"], "baseline-zero")

    def test_unmeasurable_current_object_keeps_baseline_debt_unresolved(self):
        with tempfile.TemporaryDirectory() as td:
            f = Fixture(Path(td) / "repo")
            old = f.commit({"a": b"one\ntwo\n"})
            row = {"path": "a", "blob": f.repo.entries(old)["a"]["blob"], "tier": "T1", "lines": 2,
                   "uncovered": [[1, 2]], "disposition": "included", "reason": "text"}
            def rank(target, paths):
                return {"target": target, "manifest_id": "m", "paths": paths, "candidates": [], "required": [], "evidence_gaps": []}
            original = reporting.baseline(f.repo, rank(old, [row]), "p", "l", "2026-10-30T00:00:00Z")
            # Unreadable and oversized current objects both leave coverage unverified.
            head = f.commit({"a": b"one\ntwo\n", "other": b"x\n"})
            for lines, uncovered, reason in ((None, [], "unreadable blob"),
                    (2, [[1, 2]], "current content exceeds per-file limit")):
                with self.subTest(lines=lines):
                    current = {**row, "blob": f.repo.entries(head)["a"]["blob"], "lines": lines,
                               "uncovered": uncovered, "disposition": "unsupported", "reason": reason}
                    result = reporting.summary(f.repo, rank(head, [current]), {"items": []}, original)["baseline"]
                    self.assertEqual(result["unresolved_baseline_objects"],
                                     [{**row, "reason": "unmeasurable current object"}])
                    self.assertEqual(result["surviving_T1_debt"], 0)
                    self.assertEqual(result["baseline_T1_reviewed_since"], 0)
                    self.assertEqual(result["baseline_T1_removed_or_superseded"], 0)
                    self.assertEqual(result["new_T1_debt"], 0)
                    self.assertEqual(result["target_status"], "pending")

    def test_nonancestor_baseline_lineage_remains_unknown(self):
        with tempfile.TemporaryDirectory() as td:
            f = Fixture(Path(td) / "repo")
            root = f.commit({"a": b"one\n"})
            old = f.commit({"a": b"baseline\n"})
            row = {"path": "a", "blob": f.repo.entries(old)["a"]["blob"], "tier": "T1", "lines": 1, "uncovered": [[1, 1]], "disposition": "included", "reason": "text"}
            def rank(target, paths):
                return {"target": target, "manifest_id": "m", "paths": paths, "candidates": [], "required": [], "evidence_gaps": []}
            original = reporting.baseline(f.repo, rank(old, [row]), "p", "l", "2026-10-30T00:00:00Z")
            f.git("checkout", "--detach", root)
            head = f.commit({"a": b"other\n"})
            current = {**row, "blob": f.repo.entries(head)["a"]["blob"]}
            result = reporting.summary(f.repo, rank(head, [current]), {"items": []}, original)["baseline"]
            self.assertTrue(result["unresolved_baseline_objects"])
            self.assertEqual(result["baseline_T1_removed_or_superseded"], 0)

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

    def test_a_baseline_without_an_id_is_integrity_evidence_not_a_key_error(self):
        # `original` present but empty is provided evidence: it must report
        # through IntegrityError, the type callers already handle, never KeyError.
        ranked = {"target": "a" * 40, "manifest_id": "m", "required": [], "evidence_gaps": [],
                  "paths": []}
        for original in ({}, {"target": "a" * 40, "paths": []}):
            with self.subTest(original=original):
                with self.assertRaises(ledger.IntegrityError):
                    reporting.summary(None, ranked, {"items": []}, original)


if __name__ == "__main__":
    unittest.main()
