"""Pure coverage slot regressions. No queue, repository, process or model writes."""
import copy
import datetime as dt
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("coverage_policy", Path(__file__).with_name("coverage.py"))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

TIP = "a" * 40
NOW = dt.datetime(2026, 10, 12, tzinfo=dt.timezone.utc)
COMPLETED = "2026-10-10T12:48:05Z"
RUN = "coverage-old-run"
AFFECTED = ".github/PULL_REQUEST_TEMPLATE.md"
UNRELATED = "src/safe.ts"


def queue(state="repairing"):
    return {"items": [
        {"id": "source", "pr": 1, "kind": "merged", "merge_commit": "b" * 40,
         "measure": {"merge_queue": TIP, "files": [
             {"path": AFFECTED, "now": AFFECTED, "synthetic_added": 10},
             {"path": UNRELATED, "now": UNRELATED, "synthetic_added": 10}]}},
        {"id": "coverage-old", "kind": "coverage", "state": state,
         "coverage_paths": [AFFECTED],
         "cycles": [{"run_id": RUN, "completed_at": COMPLETED}]}]}


def ledger(counted=True, outcome="completed"):
    return policy.record_review(policy.new_ledger(), run_id=RUN,
                                completed_at=COMPLETED, reviewed_paths=[AFFECTED],
                                review_sha=TIP, counted=counted, outcome=outcome)


def candidate(q, credit=None, **overrides):
    args = dict(merge_queue_sha=TIP, ordinary_eligible=False, now=NOW,
                max_paths=8, min_age_hours=24)
    args.update(overrides)
    return policy.coverage_candidate(q, credit if credit is not None else ledger(), **args)


class CoverageRepairDebtTest(unittest.TestCase):
    def test_legacy_unexplained_aggregate_and_missing_terminal_fields_hold(self):
        q = queue("blocked")
        old = q["items"][1]
        old.update(coverage_source="source", pr=1, cycles=[], failures=2,
                   attempts=[{"run_id": "r1", "outcome": "error", "counted": False,
                              "at": policy._iso(NOW), "head": "a" * 40, "base": "b" * 40}])
        view = policy.legacy_retry_view(q, 1, AFFECTED, NOW + dt.timedelta(days=2))
        self.assertFalse(view["allowed"])
        self.assertIn("unexplained item failure aggregate", view["reasons"])
        old["failures"] = 1
        del old["attempts"][0]["base"]
        view = policy.legacy_retry_view(q, 1, AFFECTED, NOW + dt.timedelta(days=2))
        self.assertFalse(view["allowed"])
        self.assertIn("incomplete guarded harvest attempt", view["reasons"])
        old["attempts"].append({"run_id": "quota", "outcome": "rate_limited", "at": policy._iso(NOW)})
        self.assertIn("historical vendor deadline unavailable",
                      policy.legacy_retry_view(q, 1, AFFECTED, NOW + dt.timedelta(days=2))["reasons"])

    def test_stored_legacy_attempts_union_with_new_run_without_migration(self):
        q = queue("blocked")
        old = q["items"][1]
        old.update(coverage_source="source", pr=1, cycles=[], failures=5,
                   attempts=[{"run_id": f"old-{i}", "outcome": "error", "counted": False,
                              "at": policy._iso(NOW - dt.timedelta(days=10-i)),
                              "head": "a" * 40, "base": "b" * 40} for i in range(5)])
        before = copy.deepcopy(q)
        view = policy.legacy_retry_view(q, 1, AFFECTED, NOW)
        self.assertTrue(view["allowed"])
        self.assertEqual(view["failures"], 5)
        self.assertEqual(q, before)
        self.assertEqual(policy.legacy_retry_view(q, 1, AFFECTED, NOW), view)
        policy.record_legacy_failure(q, old, policy._iso(NOW), "error", "new-1")
        old["attempts"].append({"run_id": "new-1", "outcome": "error", "counted": False,
                                "at": policy._iso(NOW), "head": "a" * 40, "base": "b" * 40})
        old["failures"] = 6
        view = policy.legacy_retry_view(q, 1, AFFECTED, NOW + dt.timedelta(days=3))
        self.assertEqual(view["failures"], 6)
        self.assertFalse(view["allowed"])
        self.assertIn("family failure limit", view["reasons"])
        q["legacy_coverage_failure_runs"]["new-1"]["outcome"] = "interrupted"
        self.assertIn("conflicting run identity", policy.legacy_retry_view(q, 1, AFFECTED, NOW)["reasons"])

    def test_partial_or_ambiguous_legacy_lineage_is_not_admissible(self):
        q = queue("blocked")
        old = q["items"][1]
        old.update(coverage_source="source", coverage_paths=[AFFECTED, "unmapped.py"])
        with self.assertRaises(ValueError):
            policy._legacy_origins(q, old)
        old["coverage_paths"] = [AFFECTED]
        q["items"][0]["measure"]["files"].append({"path": "another.py", "now": AFFECTED})
        with self.assertRaises(ValueError):
            policy._legacy_origins(q, old)

    def test_legacy_failed_scope_cools_down_then_quarantines_across_generations(self):
        q = queue("blocked")
        old = q["items"][1]; old.update(coverage_source="source", pr=1, cycles=[])
        at = NOW
        for number in range(6):
            policy.record_legacy_failure(q, old, policy._iso(at), "error", "run-" + str(number))
            policy.record_legacy_failure(q, old, policy._iso(at), "error", "run-" + str(number))
            during = candidate(q, policy.new_ledger(), now=at)
            self.assertEqual(during["coverage_paths"], [UNRELATED])
            at += dt.timedelta(days=2)
            later = candidate(q, policy.new_ledger(), now=at)
            if number < 5:
                self.assertIn(AFFECTED, later["coverage_paths"])
            else:
                self.assertEqual(later["coverage_paths"], [UNRELATED])
        family = policy._legacy_family(1, AFFECTED)
        self.assertEqual(q["backfill_families"][family]["failures"], 6)
        self.assertTrue(q["backfill_families"][family]["quarantined"])
        policy.record_legacy_success(q, old, [AFFECTED])
        self.assertTrue(q["backfill_families"][family]["quarantined"])

    def test_legacy_retry_history_follows_verified_source_alias(self):
        q = queue("blocked")
        old = q["items"][1]; old.update(coverage_source="source", pr=1, cycles=[])
        policy.record_legacy_failure(q, old, policy._iso(NOW), "error", "run-1")
        q["items"][0]["measure"]["files"][0]["now"] = "moved/template.md"
        result = candidate(q, policy.new_ledger(), now=NOW)
        self.assertEqual(result["coverage_paths"], [UNRELATED])
        result = candidate(q, policy.new_ledger(), now=NOW + dt.timedelta(hours=2))
        self.assertEqual(result["coverage_paths"], ["moved/template.md"])

    def test_unreconciled_historical_failure_holds_only_its_scope(self):
        q = queue("blocked")
        q["items"][1].update(coverage_source="source", pr=1, cycles=[], attempts=[{"run_id": "old", "at": policy._iso(NOW), "outcome": "error"}])
        result = candidate(q, policy.new_ledger(), now=NOW + dt.timedelta(days=10))
        self.assertEqual(result["coverage_paths"], [UNRELATED])
        self.assertNotIn("backfill_families", q)

    def test_terminal_counted_review_allows_unrelated_coverage(self):
        for state in ("repairing", "repair_failed"):
            with self.subTest(state=state):
                result = candidate(queue(state))
                self.assertEqual(result["coverage_paths"], [UNRELATED])
                self.assertEqual(result["tier"], policy.COVERAGE_RANK)

    def test_repair_paths_remain_excluded_even_after_freshness_expires(self):
        q = queue()
        q["items"][0]["measure"]["files"] = q["items"][0]["measure"]["files"][:1]
        self.assertIsNone(candidate(q, min_age_hours=0))

    def test_pending_active_deferred_and_unknown_states_hold_slot(self):
        for state in ("pending", "reviewing", "deferred", "unknown"):
            with self.subTest(state=state):
                self.assertIsNone(candidate(queue(state)))

    def test_approved_backfill_spec_releases_terminal_blocked_failed_capacity(self):
        # Approved revised protocol §7 and Stage1 deadlock acceptance supersede
        # the old global blocked-item guard; independent oracle acceptance is
        # required on the final head before merge (Q32).
        for state in ("blocked", "failed", "quarantined"):
            q = queue(state)
            q["items"][1].update(cycles=[], attempts=[{"outcome": "error"}] * 3)
            self.assertIsNotNone(candidate(q, policy.new_ledger()))
            for ownership in ({"vendor_state": "unknown"}, {"run": {"run_id": "unreconciled"}}):
                held = copy.deepcopy(q)
                held["items"][1].update(ownership)
                self.assertIsNone(candidate(held, policy.new_ledger()))

    def test_repair_path_cannot_reenter_as_a_synthetic_rename_alias(self):
        q = queue()
        q["items"][0]["measure"]["files"] = [
            {"path": AFFECTED, "now": UNRELATED, "synthetic_added": 10}]
        self.assertIsNone(candidate(q, min_age_hours=0))

    def test_stored_repair_rename_alias_remains_reserved(self):
        old_alias = "legacy/template.md"
        for old_path, current in ((old_alias, UNRELATED), (UNRELATED, old_alias)):
            with self.subTest(old_path=old_path, current=current):
                q = queue()
                q["items"][1]["measure"] = {"synthetic_paths": [AFFECTED, old_alias]}
                q["items"][0]["measure"]["files"] = [
                    {"path": old_path, "now": current, "synthetic_added": 10}]
                self.assertIsNone(candidate(q, min_age_hours=0))

    def test_uncounted_failed_and_interrupted_reviews_do_not_release_slot(self):
        for counted, outcome in ((False, "completed"), (True, "error"),
                                 (True, "interrupted"), (True, "failed")):
            with self.subTest(counted=counted, outcome=outcome):
                credit = ledger(counted=counted, outcome=outcome)
                self.assertNotIn(RUN, credit["runs"])
                self.assertIsNone(candidate(queue(), credit))

    def test_missing_cycle_completion_or_run_credit_holds_slot(self):
        for field in ("completed_at", "run_id"):
            q = queue()
            q["items"][1]["cycles"][0].pop(field)
            with self.subTest(field=field):
                self.assertIsNone(candidate(q))
        self.assertIsNone(candidate(queue(), policy.new_ledger()))

    def test_other_review_gate_remains_authoritative(self):
        self.assertIsNone(candidate(queue(), ordinary_eligible=True))
        self.assertIsNone(candidate(queue(), merge_queue_sha="c" * 40))
        self.assertIsNone(candidate(queue(), excluded_paths=[UNRELATED]))

    def test_does_not_mutate_queue_or_ledger_or_resolve_repair_debt(self):
        q, credit = queue(), ledger()
        before = copy.deepcopy((q, credit))
        candidate(q, credit)
        self.assertEqual((q, credit), before)
        self.assertEqual(q["items"][1]["state"], "repairing")

    def test_new_pending_slice_blocks_further_enrollment(self):
        q = queue()
        result = candidate(q)
        q["items"].append(result)
        self.assertIsNone(candidate(q))

    def test_bounded_region_does_not_pull_in_affected_path(self):
        q = queue()
        other = ".github/other.md"
        q["items"][0]["measure"]["files"].append(
            {"path": other, "now": other, "synthetic_added": 10})
        result = candidate(q, min_age_hours=0, max_paths=1)
        self.assertEqual(result["coverage_paths"], [other])
        self.assertNotIn(AFFECTED, result["measure"]["synthetic_paths"])


if __name__ == "__main__":
    unittest.main()
