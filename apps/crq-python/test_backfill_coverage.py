"""Persisted off-lock coverage snapshots: incremental folds and staleness."""
import collections
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import backfill_coverage as coverage
import review_ledger as ledger

T1, T2 = "a" * 40, "b" * 40


def event(ident, review=False):
    return {"id": ident, "review": review}


class FakeRepo:
    """fold() credits line N of path 'p' for each creditable review 'rN'."""
    def __init__(self, fail=()):
        self.folded, self.fail = [], set(fail)
        self.immutable_cache = None

    def begin_invocation(self):
        self.immutable_cache = {}

    def fold(self, target, reviews, artifacts, covered, evidence, gaps):
        for value in reviews:
            if not value["review"]:
                continue
            self.folded.append((target, value["id"]))
            if value["id"] in self.fail:
                gaps.append({"review": value["id"], "reason": "artifact unreadable"})
                continue
            covered["p"].add(int(value["id"][1:]))


class CoverageSnapshotTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name)
        for name, fake in (("creditable", lambda value: value["review"]), ("validate_sequence", lambda values: {})):
            patcher = mock.patch.object(coverage.ledger, name, side_effect=fake)
            patcher.start(); self.addCleanup(patcher.stop)

    def test_missing_snapshot_is_stale_and_full_refresh_persists_it(self):
        events = [event("s0"), event("r1", True), event("r3", True)]
        self.assertIsNone(coverage.load(self.state, T1, events))
        repo = FakeRepo()
        self.assertEqual(coverage.refresh(self.state, repo, None, events, {T1}), {T1: "full"})
        self.assertEqual(repo.immutable_cache, {})  # the accidental per-call Git cost is cached
        self.assertEqual(coverage.load(self.state, T1, events), ({"p": {1, 3}}, []))

    def test_appended_non_review_events_keep_the_snapshot_valid_without_git(self):
        events = [event("r1", True)]
        coverage.refresh(self.state, FakeRepo(), None, events, {T1})
        moved = events + [event("state-1"), event("finding-1")]
        self.assertEqual(coverage.load(self.state, T1, moved), ({"p": {1}}, []))
        repo = FakeRepo()
        self.assertEqual(coverage.refresh(self.state, repo, None, moved, {T1}), {T1: "extended"})
        self.assertEqual(repo.folded, [])
        self.assertEqual(coverage.refresh(self.state, repo, None, moved, {T1}), {T1: "current"})

    def test_appended_review_makes_it_stale_and_refresh_folds_only_the_suffix(self):
        events = [event("r1", True), event("r2", True)]
        coverage.refresh(self.state, FakeRepo(), None, events, {T1})
        moved = events + [event("r5", True)]
        self.assertIsNone(coverage.load(self.state, T1, moved))
        repo = FakeRepo()
        self.assertEqual(coverage.refresh(self.state, repo, None, moved, {T1}), {T1: "extended"})
        self.assertEqual(repo.folded, [(T1, "r5")])
        self.assertEqual(coverage.load(self.state, T1, moved), ({"p": {1, 2, 5}}, []))

    def test_a_sequence_that_is_not_an_extension_recomputes_in_full(self):
        coverage.refresh(self.state, FakeRepo(), None, [event("r1", True), event("r2", True)], {T1})
        rewritten = [event("r1", True), event("r4", True)]
        self.assertIsNone(coverage.load(self.state, T1, rewritten))
        repo = FakeRepo()
        self.assertEqual(coverage.refresh(self.state, repo, None, rewritten, {T1}), {T1: "full"})
        self.assertEqual(repo.folded, [(T1, "r1"), (T1, "r4")])
        self.assertEqual(coverage.load(self.state, T1, rewritten)[0], {"p": {1, 4}})

    def test_gap_reviews_are_retried_on_the_next_refresh(self):
        events = [event("r1", True), event("r2", True)]
        coverage.refresh(self.state, FakeRepo(fail={"r2"}), None, events, {T1})
        self.assertEqual(coverage.load(self.state, T1, events)[1], [{"review": "r2", "reason": "artifact unreadable"}])
        repo = FakeRepo()
        self.assertEqual(coverage.refresh(self.state, repo, None, events, {T1}), {T1: "extended"})
        self.assertEqual(repo.folded, [(T1, "r2")])
        self.assertEqual(coverage.load(self.state, T1, events), ({"p": {1, 2}}, []))

    def test_unused_targets_are_pruned_and_corrupt_snapshots_are_stale(self):
        events = [event("r1", True)]
        coverage.refresh(self.state, FakeRepo(), None, events, {T1, T2})
        coverage.refresh(self.state, FakeRepo(), None, events, {T2})
        self.assertIsNone(coverage.load(self.state, T1, events))
        path = self.state / coverage.DIRECTORY / (T2 + ".json")
        path.write_bytes(b"{not json")
        self.assertIsNone(coverage.load(self.state, T2, events))
        ledger.atomic(path, ledger.canonical({"version": coverage.VERSION, "target": T1, "events": 1,
                                              "prefix": "x", "covered": {}, "gaps": []}))
        self.assertIsNone(coverage.load(self.state, T2, events))  # names another target
        self.assertIsNone(coverage.load(self.state, "../escape", events))  # read side: stale, never a path

    def test_corrupt_rows_recompute_and_a_bad_target_never_blocks_the_rest(self):
        events = [event("r1", True)]
        coverage.refresh(self.state, FakeRepo(), None, events, {T1})
        path = self.state / coverage.DIRECTORY / (T1 + ".json")
        value = ledger.loads(path.read_bytes()); value["covered"] = {"p": [[3, 1]]}
        ledger.atomic(path, ledger.canonical(value))
        self.assertIsNone(coverage.load(self.state, T1, events))
        repo = FakeRepo()
        self.assertEqual(coverage.refresh(self.state, repo, None, events, {"../escape", T1}),
                         {"../escape": "invalid-target", T1: "full"})
        self.assertEqual(coverage.load(self.state, T1, events), ({"p": {1}}, []))

    def test_prune_keeps_snapshots_of_targets_with_live_jobs(self):
        events = [event("r1", True)]
        coverage.refresh(self.state, FakeRepo(), None, events, {T1, T2})
        coverage.refresh(self.state, FakeRepo(), None, events, {T2}, keep={T1})
        self.assertIsNotNone(coverage.load(self.state, T1, events))
        queue = {"items": [{"kind": "backfill", "state": "reviewing", "target": T1},
                           {"kind": "backfill", "state": "done", "target": T2},
                           {"kind": "open", "state": "pending", "target": "c" * 40}]}
        self.assertEqual(coverage.live_targets(queue), {T1})
        self.assertEqual(coverage.pending_targets(queue), set())

    def test_one_prefix_digest_is_shared_by_every_target_in_a_pass(self):
        events = [event("r1", True), event("s1")]
        coverage.refresh(self.state, FakeRepo(), None, events, {T1, T2})
        digests = {}
        with mock.patch.object(coverage, "_prefix_digest", wraps=coverage._prefix_digest) as digest:
            for target in (T1, T2):
                self.assertIsNotNone(coverage.load(self.state, target, events, digests))
        self.assertEqual(digest.call_count, 1)


class VerificationOutcomeCacheTest(unittest.TestCase):
    def test_failed_restore_is_reused_across_targets_and_retried_next_invocation(self):
        import backfill_accounting as accounting
        repo = accounting.Repository(tempfile.gettempdir())
        review = {"id": "r1", "event_type": "review", "payload": {"artifacts": [{"location": "x"}], "target": T1}}
        artifacts = mock.Mock(verify=mock.Mock(side_effect=OSError("artifact volume unreadable")))
        with mock.patch.object(accounting.ledger, "creditable", return_value=True):
            repo.begin_invocation()
            for target in (T1, T2):
                gaps = []
                repo.fold(target, [review], artifacts, collections.defaultdict(set), collections.defaultdict(list), gaps)
                self.assertEqual(gaps, [{"review": "r1", "reason": "artifact volume unreadable"}])
            self.assertEqual(artifacts.verify.call_count, 1)
            repo.begin_invocation()  # the next refresher run retries the gap
            repo.fold(T1, [review], artifacts, collections.defaultdict(set), collections.defaultdict(list), [])
        self.assertEqual(artifacts.verify.call_count, 2)


if __name__ == "__main__":
    unittest.main()
