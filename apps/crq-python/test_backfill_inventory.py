"""Deterministic manifest replay and ordering, using approved policy fixtures."""
import copy
import hashlib
from pathlib import Path
import tempfile
import unittest

import backfill_inventory as inventory
import review_ledger as ledger
from test_backfill_accounting import Fixture

ROOT = Path(__file__).resolve().parents[2]
AT = "2026-10-30T00:00:00Z"


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.f = Fixture(Path(self.tmp.name) / "repo")
        self.tiers = ledger.loads((ROOT / "policy/review-tiers.json").read_bytes())
        self.limits = ledger.loads((ROOT / "policy/review-limits.json").read_bytes())
        self.protected = (ROOT / "policy/protected-paths.json").read_bytes()
        self.required = {"version": 1, "rows": [{"row": 1, "pr": 1}, {"row": 2, "pr": 2}], "explicit_unions": [[1, 2]]}

    def capture(self, target, queue=None, paths=None):
        return inventory.capture(self.f.repo, target, "a" * 40, [], self.f.store,
                                 queue or {"items": []}, self.required, self.tiers, self.limits, AT,
                                 paths or {"1": [{"path": "src/kernel/a.ts"}], "2": []}, self.protected)

    def test_replay_bytes_equal_despite_clock_and_order_and_explicit_union(self):
        target = self.f.commit({"src/kernel/a.ts": b"a\n", "apps/crq-python/z.py": b"z\n", "docs/x": b"x\n"})
        manifest = self.capture(target)
        first = inventory.replay(manifest, self.f.store)
        second = inventory.replay(ledger.loads(ledger.canonical(manifest)), self.f.store)
        self.assertEqual(ledger.canonical(first), ledger.canonical(second))
        self.assertEqual(first["candidates"][0]["kind"], "B")  # T1 B precedes T2 A.
        a = next(c for c in first["candidates"] if c["kind"] == "A")
        self.assertEqual(a["prs"], [1, 2]); self.assertEqual(a["row"], 1)
        self.assertEqual(len(first["paths"]), 3)
        # Mutating a retained input is rejected rather than changing replay.
        ref = manifest["snapshots"]["queue"]
        Path(ref["location"]).write_bytes(b'{"items":[{}]}')
        with self.assertRaises(ledger.IntegrityError):
            inventory.replay(manifest, self.f.store)

    def test_protected_overlapping_test_paths_and_catchall(self):
        self.assertEqual(inventory.tier("apps/crq-python/test_crq.py", self.tiers), "T1")
        self.assertEqual(inventory.tier("src/selfhost/test/docs.md", self.tiers), "T2")
        self.assertEqual(inventory.tier("src/new.ts", self.tiers), "T3")
        self.assertEqual(inventory.tier("unknown/future", self.tiers), "T4")
        self.assertEqual(inventory.tier("policy/protected-paths.json", self.tiers), "T1")

    def test_no_implicit_unions_and_real_required_rows(self):
        required = ledger.loads((ROOT / "policy/review-required-list.json").read_bytes())
        groups = inventory.required_groups(required)
        self.assertEqual(len(required["rows"]), 128)
        self.assertEqual(len(groups), 125)
        self.assertIn({"prs": [641, 649, 653], "row": 16}, groups)
        self.assertIn({"prs": [262, 263], "row": 13}, groups)
        self.assertIn({"prs": [213], "row": 125}, groups)

    def test_owned_A_scope_not_duplicated_by_B_and_missing_evidence_pending(self):
        t = self.f.commit({"src/kernel/a.ts": b"a\nb\n"})
        blob = self.f.repo.entries(t)["src/kernel/a.ts"]["blob"]
        queue = {"items": [{"state": "publication-pending", "target": t,
                            "scope": [{"path": "src/kernel/a.ts", "blob": blob, "intervals": [[1, 2]]}]}]}
        result = inventory.replay(self.capture(t, queue), self.f.store)
        self.assertFalse(result["candidates"])
        self.assertEqual(result["paths"][0]["uncovered"], [[1, 2]])
        self.assertEqual(result["required"][0]["paths"][0]["outcome"], "still-pending")
        missing = inventory.replay(self.capture(t, paths={"1": []}), self.f.store)
        self.assertEqual(missing["required"][0]["missing_source_evidence"], [2])

    def test_retry_work_follows_fresh_within_tier_and_bounds(self):
        self.required["rows"] = [] ; self.required["explicit_unions"] = []
        t = self.f.commit({f"apps/crq-python/{i}/a.py": b"a\n" for i in range(3)})
        first = inventory.replay(self.capture(t), self.f.store)
        retried = first["candidates"][0]
        queue = {"items": [{**retried, "state": "blocked"}], "backfill_families": {retried["family"]: {"failures": 3}}}
        result = inventory.replay(self.capture(t, queue), self.f.store)
        self.assertEqual(result["candidates"][-1]["subject_id"], retried["subject_id"])
        self.assertEqual(result["candidates"][-1]["generation"], 1)
        self.assertTrue(result["candidates"][-1]["retry"])

    def test_unknown_reviewer_limits_block_live_and_policy_tamper_is_rejected(self):
        with self.assertRaisesRegex(ledger.IntegrityError, "not verified"):
            inventory.effective_limits(self.limits)
        t = self.f.commit({"a": b"a\n"})
        self.tiers["protected_policy_sha256"] = "0" * 64
        with self.assertRaisesRegex(ledger.IntegrityError, "protected-path"):
            self.capture(t)


if __name__ == "__main__":
    unittest.main()
