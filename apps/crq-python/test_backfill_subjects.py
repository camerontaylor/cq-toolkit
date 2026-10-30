"""Pinned current subjects, residual projections, limits and stack fallbacks."""
import copy
from pathlib import Path
import tempfile
import unittest

import backfill_subjects as subjects
import review_ledger as ledger
from test_backfill_accounting import Fixture


class SubjectsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.f = Fixture(Path(self.tmp.name) / "repo")
        self.policy = {"max_files": 8, "max_file_bytes": 262144, "max_total_bytes": 2097152,
                       "reviewer": {"verified": True, "evidence": "offline-fixture-only", "max_files": 8, "max_diff_bytes": 2097152}}

    def candidate(self, t, names, kind="B"):
        entries = self.f.repo.entries(t)
        scope = [{"path": n, "blob": entries[n]["blob"], "intervals": [[1, len(self.f.repo.git("cat-file", "blob", entries[n]["blob"]).splitlines())]]} for n in names]
        return {"target": t, "kind": kind, "scope": scope, "scope_digest": ledger.digest(scope), "subject_id": "b" * 64,
                "job_id": "b" * 64 + ":0", "generation": 0, "prs": [1], "tier": "T1", "family": "family", "partition": 0}

    def test_current_projection_tree_and_immutable_ref_survive_tip_move(self):
        t = self.f.commit({"a": b"one\ntwo\n"})
        result = subjects.construct(self.f.repo, self.candidate(t, ["a"]), self.policy)
        self.assertFalse(result["debt"])
        partition = result["partitions"][0]
        self.assertEqual(self.f.repo.tree(partition["head"]), self.f.repo.tree(t))
        self.f.commit({"a": b"later\n"})
        self.assertEqual(self.f.git("rev-parse", partition["refs"] + "/target"), t)
        replay = subjects.construct(self.f.repo, self.candidate(t, ["a"]), self.policy)
        self.assertEqual(replay, result)
        with self.assertRaisesRegex(ledger.IntegrityError, "pin conflict"):
            subjects.pin(self.f.repo, partition["subject_id"], 0, 0, partition["head"], partition["head"], t)

    def test_linear_stack_earliest_baseline_and_residual_full_file_projection(self):
        self.f.commit({"a": b"same\nold\n"})
        first = self.f.commit({"a": b"same\nnew\n"})
        target = self.f.commit({"a": b"same\nnewer\n"})
        members = [{"merge": target, "paths": [{"path": "a", "source_path": "a", "lineage_verified": True}]},
                   {"merge": first, "paths": [{"path": "a", "source_path": "a", "lineage_verified": True}]}]
        result = subjects.construct(self.f.repo, self.candidate(target, ["a"], "A"), self.policy, members)
        self.assertEqual(len(result["partitions"]), 2)
        initial, residual = result["partitions"]
        self.assertEqual(initial["paths"][0]["baseline"]["merge"], first)
        self.assertEqual(initial["scope"][0]["intervals"], [[2, 2]])
        self.assertTrue(residual["residual"])
        self.assertEqual(residual["scope"][0]["intervals"], [[1, 2]])

    def test_empty_synthetic_diff_projects_unchanged_uncovered_file(self):
        pre = self.f.commit({"a": b"same\n"})
        merge = self.f.commit({"other": b"changed\n"})
        members = [{"merge": merge, "paths": [{"path": "a", "source_path": "a", "lineage_verified": True}]}]
        result = subjects.construct(self.f.repo, self.candidate(merge, ["a"], "A"), self.policy, members)
        self.assertEqual(len(result["partitions"]), 1)
        self.assertTrue(result["partitions"][0]["residual"])

    def test_nonlinear_members_fall_back_and_oversize_does_not_block_peers(self):
        root = self.f.commit({"a": b"old\n"})
        left = self.f.commit({"a": b"left\n"})
        self.f.git("checkout", "-q", root)
        right = self.f.commit({"a": b"right\n", "big": b"x" * 50})
        members = [{"merge": m, "paths": [{"path": "a", "source_path": "a", "lineage_verified": True}]} for m in [left, right]]
        self.policy["max_file_bytes"] = 20
        result = subjects.construct(self.f.repo, self.candidate(right, ["a", "big"], "A"), self.policy, members)
        self.assertEqual(len(result["partitions"]), 1)
        self.assertEqual(result["partitions"][0]["paths"][0]["baseline"]["reason"], "nonlinear stack baselines")
        self.assertEqual(result["debt"][0]["path"], "big")

    def test_file_count_total_and_actual_diff_limits_split_without_truncation(self):
        names = [f"p/{n:02}" for n in range(11)]
        target = self.f.commit({name: b"one\n" for name in names})
        self.policy["max_files"] = 3
        result = subjects.construct(self.f.repo, self.candidate(target, names), self.policy)
        self.assertEqual(set(n for p in result["partitions"] for n in p["paths"] for n in [n["path"]]), set(names))
        self.assertTrue(all(len(p["paths"]) <= 3 for p in result["partitions"]))
        self.policy["reviewer"]["max_diff_bytes"] = 1
        unsupported = subjects.construct(self.f.repo, self.candidate(target, names), self.policy)
        self.assertFalse(unsupported["partitions"]); self.assertEqual(len(unsupported["debt"]), 11)


if __name__ == "__main__":
    unittest.main()
