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
