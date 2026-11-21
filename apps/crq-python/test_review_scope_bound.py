"""The per-record scope-entry bound is enforced from interval arithmetic, not set size."""
import unittest

import ledger_vector_emit_b1 as base
import review_ledger as ledger


def _rows(*intervals):
    return [{"path": "src/a.ts", "blob": base.SHA, "intervals": [list(i) for i in intervals]}]


def _payload(requested, input_scope, reviewed):
    return {"requested_scope": requested, "input_scope": input_scope, "reviewed_scope": reviewed}


class ScopeEntryBoundTest(unittest.TestCase):
    def test_scope_entries_sums_decoded_entries_across_all_three_scopes(self):
        p = _payload(_rows((1, 10), (20, 30)), _rows((5, 5)), _rows((1, 3)))
        self.assertEqual(ledger.scope_entries(p), 10 + 11 + 1 + 3)

    def test_scope_entries_counts_exactly_at_the_bound_without_materializing(self):
        p = _payload(_rows((1, 400_000)), _rows((1, 400_000)), _rows((1, 200_000)))
        self.assertEqual(ledger.scope_entries(p), ledger.SCOPE_ENTRIES)

    def test_interval_crossing_the_range_ceiling_keeps_the_interval_error(self):
        p = _payload(_rows((1, 1_000_001)), _rows((1, 1)), _rows((1, 1)))
        with self.assertRaisesRegex(ledger.IntegrityError, "invalid or overlapping intervals"):
            ledger.scope_entries(p)

    def test_validate_rejects_a_record_one_entry_over_the_bound(self):
        # Two wide intervals plus one: 400000 + 400000 + 200001, never decoded to sets.
        over = dict(requested_scope=_rows((1, 400_000)), input_scope=_rows((1, 400_000)),
                    reviewed_scope=_rows((1, 200_001)))
        with self.assertRaisesRegex(ledger.IntegrityError, "scope entries exceed record bound"):
            base._review(scope_digest=ledger.digest(over["requested_scope"]), **over)

    def test_validate_accepts_a_record_exactly_at_the_bound(self):
        at = dict(requested_scope=_rows((1, 400_000)), input_scope=_rows((1, 400_000)),
                  reviewed_scope=_rows((1, 200_000)))
        event = base._review(scope_digest=ledger.digest(at["requested_scope"]), **at)
        self.assertEqual(event["event_type"], "review")


if __name__ == "__main__":
    unittest.main()
