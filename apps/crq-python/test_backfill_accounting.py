"""Real fixture repositories exercise the explicit-line credit contract."""
import collections
import copy
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import backfill_accounting as accounting
import backfill_cache
import review_ledger as ledger
from test_review_ledger import review, rehash


class Fixture:
    def __init__(self, root):
        self.root = Path(root); self.root.mkdir(parents=True)
        self.repo = accounting.Repository(self.root)
        self.git("init", "-q")
        self.git("config", "user.name", "fixture"); self.git("config", "user.email", "fixture@localhost")
        self.store = ledger.ArtifactStore(self.root.parent / "artifacts")

    def git(self, *args, input=None):
        env = dict(os.environ, GIT_AUTHOR_DATE="2026-10-29T00:00:00Z", GIT_COMMITTER_DATE="2026-10-29T00:00:00Z")
        return subprocess.run(["git", *args], cwd=self.root, env=env, input=input, capture_output=True, check=True).stdout.decode().strip()

    def commit(self, files):
        for name, content in files.items():
            p = self.root / name
            if content is None:
                p.unlink()
            else:
                p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(content)
        self.git("add", "-A"); self.git("commit", "-qm", "Fixture change")
        return self.git("rev-parse", "HEAD")

    def projection(self, target, names):
        # Fixture uses a private index and real Git objects; production builder
        # is tested independently. Current projection's head is exactly T.
        with tempfile.TemporaryDirectory() as td:
            env = dict(os.environ, GIT_INDEX_FILE=str(Path(td) / "index"))
            self.repo.git("read-tree", target, env=env)
            for name in names:
                self.repo.git("update-index", "--force-remove", "--", name, env=env)
            tree = self.repo.git("write-tree", env=env).decode().strip()
            base = self.git("commit-tree", tree, "-p", target, "-m", "Removed files")
            head = self.git("commit-tree", self.repo.tree(target), "-p", base, "-m", "Restored files")
        return base, head

    def evidence(self, target, base, head, scopes):
        ref = self.store.put(b"authenticated retained fixture evidence")
        value = review([ref])
        p = value["payload"]
        p.update(base=base, head=head, head_tree=self.repo.tree(head), target=target, target_tree=self.repo.tree(target),
                 requested_scope=scopes, input_scope=copy.deepcopy(scopes), reviewed_scope=copy.deepcopy(scopes), scope_digest=ledger.digest(scopes))
        p["paths"] = [{"path": s["path"], "blob": s["blob"], "mode": "100644", "disposition": "included", "reason": "verified fixture", "baseline": {}} for s in scopes]
        return rehash(value)

    def full_review(self, target, name, lines):
        base, head = self.projection(target, [name])
        scope = [{"path": name, "blob": self.repo.entries(target)[name]["blob"], "intervals": lines}]
        return self.evidence(target, base, head, scope)


class ImmutableCacheTest(unittest.TestCase):
    def test_long_lineage_only_reads_endpoint_trees_without_public_copies(self):
        # Exceeds the tree-cache capacity. Unrelated history must not churn it.
        commits = [format(i + 1, "040x") for i in range(1100)]
        raw = b"".join(("100644 blob " + "a" * 40 + "\tfile" + str(i) + "\0").encode() for i in range(800))
        repo = accounting.Repository("unused")
        repo.immutable_cache = {}
        def git(*args, **kwargs):
            if args[0] == "ls-tree":
                return raw
            if args[:2] == ("rev-list", "--first-parent"):
                return ("\n".join(reversed(commits)) + "\n").encode()
            if args[0] == "rev-parse":
                return commits[commits.index(args[1][:-2]) - 1].encode()
            if args[0] == "diff":
                return b"M\0file799\0"
            self.fail(str(args))
        with mock.patch.object(repo, "resolve", side_effect=lambda c: c), \
             mock.patch.object(repo, "git", side_effect=git), \
             mock.patch.object(repo, "entries", side_effect=AssertionError("internal tree copied")), \
             mock.patch.object(ledger, "path", wraps=ledger.path) as parse:
            self.assertEqual(repo.lineage(commits[0], commits[-1], "file0"), "file0")
            parsed = parse.call_count
            self.assertEqual(parsed, 2 * 800)
            git_calls = repo.git.call_count
            self.assertEqual(repo.lineage(commits[0], commits[-1], "file799"), "file799")
            self.assertEqual(repo.git.call_count, git_calls + 1)  # Cached chain read only.
            self.assertEqual(parse.call_count, parsed)
            self.assertEqual(list(repo._entry_cache), [commits[0], commits[-1]])

    def test_parsed_lineage_cache_is_bounded_and_resets_per_invocation(self):
        with tempfile.TemporaryDirectory() as td:
            fixture = Fixture(Path(td) / "repo")
            old = fixture.commit({"a": b"one\n"})
            target = fixture.commit({"a": b"two\n"})
            repo = fixture.repo
            repo.begin_invocation()
            self.assertEqual(repo.lineage(old, target, "a"), "a")
            self.assertIn(target, repo._lineage_steps)
            repo.begin_invocation()
            self.assertFalse(repo._lineage_steps)
            self.assertEqual(repo._lineage_bytes, 0)
            with mock.patch.object(accounting, "LINEAGE_CACHE_BYTES", 1):
                self.assertEqual(repo.lineage(old, target, "a"), "a")
                self.assertFalse(repo._lineage_steps)

    def test_parsed_lineage_cache_evicts_on_overflow(self):
        with tempfile.TemporaryDirectory() as td:
            fixture = Fixture(Path(td) / "repo")
            old = fixture.commit({"a": b"one\n"})
            middle = fixture.commit({"a": b"two\n"})
            target = fixture.commit({"a": b"six\n"})  # Same change shape, same step size.
            repo = fixture.repo
            repo.begin_invocation()
            repo._lineage_step(middle)
            one_step = repo._lineage_bytes
            repo.begin_invocation()
            with mock.patch.object(accounting, "LINEAGE_CACHE_BYTES", one_step):
                self.assertEqual(repo.lineage(old, target, "a"), "a")
                self.assertEqual(list(repo._lineage_steps), [target])
                self.assertLessEqual(repo._lineage_bytes, one_step)

    def test_private_trees_are_immutable_and_lru_bounds_evict_one(self):
        with tempfile.TemporaryDirectory() as td:
            fixture = Fixture(Path(td) / "repo")
            commits = [fixture.commit({"a.py": str(i).encode()}) for i in range(3)]
            repo = fixture.repo
            repo.immutable_cache = {}
            with mock.patch.object(accounting, "ENTRY_CACHE_TREES", 2):
                tree = repo._entries(commits[0])
                with self.assertRaises(TypeError):
                    tree["a.py"]["blob"] = "poison"
                with self.assertRaises(TypeError):
                    tree["injected"] = {}
                repo._entries(commits[1])
                repo._entries(commits[0])  # Refresh the oldest entry.
                repo._entries(commits[2])
                self.assertEqual(list(repo._entry_cache), [commits[0], commits[2]])
                self.assertEqual(repo._entry_bytes, sum(v[1] for v in repo._entry_cache.values()))
            fresh = accounting.Repository(fixture.root)
            fresh.immutable_cache = {}
            with mock.patch.object(accounting, "ENTRY_CACHE_BYTES", 1):
                self.assertIn("a.py", fresh._entries(commits[0]))
                self.assertFalse(fresh._entry_cache)
                self.assertEqual(fresh._entry_bytes, 0)

    def test_cache_is_per_instance_and_only_immutable_reads(self):
        with tempfile.TemporaryDirectory() as td:
            fixture = Fixture(Path(td) / "repo")
            old = fixture.commit({"a.py": b"one\n"})
            new = fixture.commit({"a.py": b"two\n"})
            repo = fixture.repo
            repo.immutable_cache = {}
            with mock.patch.object(accounting.subprocess, "run", wraps=subprocess.run) as calls:
                first = repo.entries(old)
                count = calls.call_count
                self.assertEqual(repo.entries(old), first)
                self.assertEqual(calls.call_count, count)
                first["a.py"]["blob"] = "poison"
                self.assertNotEqual(repo.entries(old)["a.py"]["blob"], "poison")
                self.assertNotEqual(repo.entries(new), first)
                repo.git("rev-parse", "HEAD")
                count = calls.call_count
                repo.git("rev-parse", "HEAD")
                self.assertEqual(calls.call_count, count + 1)
                fresh = accounting.Repository(fixture.root)
                count = calls.call_count
                fresh.entries(old)
                self.assertGreater(calls.call_count, count)
            self.assertEqual(repo.lineage(old, new, "a.py"), "a.py")


class FactCacheTest(unittest.TestCase):
    """Cross-run facts must reproduce uncached accounting and skip repeated Git work."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.f = Fixture(Path(self.tmp.name) / "repo")
        self.index = Path(self.tmp.name) / "index"

    def fresh(self):
        repo = accounting.Repository(self.f.root)
        repo.begin_invocation()
        repo.disk_cache = backfill_cache.Cache(self.index, self.f.store)
        return repo

    def history(self):
        old = self.f.commit({"a": b"one\ntwo\nthree\nfour\n", "other": b"x\n"})
        value = self.f.full_review(old, "a", [[1, 4]])
        self.f.commit({"a": b"one\nchanged\nthree\nfour\n"})
        self.f.git("mv", "a", "renamed"); self.f.commit({})
        middle = self.f.commit({"other": b"y\n"})
        return old, value, middle

    def test_cached_coverage_matches_uncached_across_runs_and_targets(self):
        old, value, middle = self.history()
        expected = accounting.Repository(self.f.root).coverage(middle, [value], self.f.store)
        self.assertEqual(expected[0], {"renamed": {1, 3, 4}})
        self.assertEqual(self.fresh().coverage(middle, [value], self.f.store), expected)
        warm = self.fresh()
        with mock.patch.object(accounting.subprocess, "run", wraps=subprocess.run) as calls:
            self.assertEqual(warm.coverage(middle, [value], self.f.store), expected)
            self.assertFalse([c for c in calls.call_args_list if c.args[0][:2] == ["git", "blame"]])
        # A new target recomputes coverage but reuses old-side blame and parsed steps.
        target = self.f.commit({"other": b"z\n"})
        expected = accounting.Repository(self.f.root).coverage(target, [value], self.f.store)
        later = self.fresh()
        with mock.patch.object(accounting.subprocess, "run", wraps=subprocess.run) as calls:
            self.assertEqual(later.coverage(target, [value], self.f.store), expected)
            blamed = [c.args[0] for c in calls.call_args_list if c.args[0][:2] == ["git", "blame"]]
            diffs = [c.args[0] for c in calls.call_args_list if c.args[0][:3] == ["git", "diff", "--name-status"]]
        self.assertEqual([b[-3] for b in blamed], [target])
        self.assertEqual(len(diffs), 1)  # Only the new first-parent step.

    def test_cached_carry_keeps_python_index_semantics(self):
        old, value, middle = self.history()
        uncached = accounting.Repository(self.f.root)
        for lines in ([1, 3, 4], [0, -1], [5, 9]):
            expected = uncached.carry(old, middle, "a", lines)
            self.assertEqual(self.fresh().carry(old, middle, "a", lines), expected)
            self.assertEqual(self.fresh().carry(old, middle, "a", lines), expected)
        with self.assertRaises(IndexError):
            uncached.carry(old, middle, "a", [-4])
        with self.assertRaises(IndexError):
            self.fresh().carry(old, middle, "a", [-4])

    def test_verified_credit_hit_restores_a_missing_review_target(self):
        old, value, middle = self.history()
        self.fresh().coverage(middle, [value], self.f.store)
        warm = self.fresh()
        with mock.patch.object(warm, "_has_commit", return_value=False), \
             mock.patch.object(warm, "restore") as restore, \
             mock.patch.object(warm, "verify_review", side_effect=AssertionError("re-verified")):
            warm.fold(self.f.git("rev-parse", "HEAD"), [value], self.f.store, *([collections.defaultdict(set), collections.defaultdict(list), []]))
        restore.assert_called_once()

    def test_failed_verification_is_never_persisted(self):
        t = self.f.commit({"a": b"one\n"})
        value = self.f.full_review(t, "a", [[1, 1]])
        Path(value["payload"]["artifacts"][0]["location"]).unlink()
        self.assertEqual(len(self.fresh().coverage(t, [value], self.f.store)[2]), 1)
        self.assertFalse((self.index / "facts/verified_review").exists())
        self.assertFalse((self.index / "facts/coverage").exists())


class AccountingTest(unittest.TestCase):
    def test_space_in_filename_preserves_changed_intervals(self):
        with tempfile.TemporaryDirectory() as td:
            f = Fixture(Path(td) / "repo")
            base = f.commit({"my file.ts": b"before\n"})
            head = f.commit({"my file.ts": b"after\n"})
            self.assertEqual(f.repo.changed_intervals(base, head), {"my file.ts": {1}})

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.f = Fixture(Path(self.tmp.name) / "repo")

    def test_projection_exact_blob_and_explicit_partial_scope(self):
        t = self.f.commit({"a": b"one\ntwo\nthree\n", "excluded": b"not reviewed\n"})
        value = self.f.full_review(t, "a", [[1, 2]])
        covered, _, gaps = self.f.repo.coverage(t, [value], self.f.store)
        self.assertEqual(covered, {"a": {1, 2}}); self.assertFalse(gaps)
        self.assertNotIn("excluded", covered)
        value["payload"]["reviewed_scope"][0]["blob"] = "c" * 40
        with self.assertRaises(ledger.IntegrityError):
            self.f.repo.verify_review(rehash(value))

    def test_patch_content_cannot_forge_changed_intervals(self):
        old = self.f.commit({"a": b"first\nsecond\nthird\n", "other": b"unchanged\n"})
        head = self.f.commit({"a": b"first\n++ b/other\nthird\n"})
        intervals = self.f.repo.changed_intervals(old, head)
        self.assertEqual(intervals.get("a"), {2})
        self.assertNotIn("other", intervals)
        old = head
        head = self.f.commit({"a": b"first\ncontent\x0c@@ -1 +1,100 @@\nthird\n"})
        intervals = self.f.repo.changed_intervals(old, head)
        self.assertEqual(intervals.get("a"), {2})
        blob = self.f.repo.entries(head)["a"]["blob"]
        value = self.f.evidence(head, old, head, [{"path": "a", "blob": blob, "intervals": [[1, 3]]}])
        with self.assertRaisesRegex(ledger.IntegrityError, "changed intervals"):
            self.f.repo.verify_review(value)

    def test_changed_intervals_handles_multiple_hunks_and_no_final_newline(self):
        old = self.f.commit({"a": b"one\ntwo\nthree\nfour\nfive"})
        head = self.f.commit({"a": b"ONE\ntwo\nthree\nfour\nFIVE"})
        self.assertEqual(self.f.repo.changed_intervals(old, head)["a"], {1, 5})

    def test_quoted_path_cannot_inherit_the_previous_file(self):
        old = self.f.commit({"a": b"one\ntwo\nthree\n", "é": b"one\ntwo\nthree\n"})
        head = self.f.commit({"a": b"ONE\ntwo\nthree\n", "é": b"one\ntwo\nTHREE\n"})
        self.assertEqual(self.f.repo.changed_intervals(old, head)["a"], {1})

    def test_diff_context_and_unchanged_lines_are_not_credit(self):
        old = self.f.commit({"a": b"one\ntwo\nthree\n"})
        t = self.f.commit({"a": b"one\nchanged\nthree\n"})
        blob = self.f.repo.entries(t)["a"]["blob"]
        value = self.f.evidence(t, old, t, [{"path": "a", "blob": blob, "intervals": [[2, 2]]}])
        self.assertEqual(self.f.repo.verify_review(value), {"a": {2}})
        for key in ("requested_scope", "input_scope", "reviewed_scope"):
            value["payload"][key][0]["intervals"] = [[1, 3]]
        value["payload"]["scope_digest"] = ledger.digest(value["payload"]["requested_scope"])
        with self.assertRaisesRegex(ledger.IntegrityError, "changed intervals"):
            self.f.repo.verify_review(rehash(value))

    def test_unchanged_lines_survive_edits_but_reverted_line_does_not(self):
        t = self.f.commit({"a": b"one\ntwo\nthree\n"})
        value = self.f.full_review(t, "a", [[1, 3]])
        self.f.commit({"a": b"one\nchanged\nthree\n"})
        current = self.f.commit({"a": b"one\ntwo\nthree\nnew\n"})
        covered, _, _ = self.f.repo.coverage(current, [value], self.f.store)
        self.assertEqual(covered, {"a": {1, 3}})

    def test_exact_unique_rename_and_copy_ambiguity(self):
        t = self.f.commit({"a": b"one\ntwo\n"})
        value = self.f.full_review(t, "a", [[1, 2]])
        self.f.git("mv", "a", "renamed"); current = self.f.commit({})
        covered, _, _ = self.f.repo.coverage(current, [value], self.f.store)
        self.assertEqual(covered, {"renamed": {1, 2}})
        copied = self.f.commit({"copy": b"one\ntwo\n"})
        covered, _, _ = self.f.repo.coverage(copied, [value], self.f.store)
        self.assertNotIn("copy", covered)

    def test_lineage_rejects_duplicate_blob_at_intermediate_rename(self):
        old = self.f.commit({"a": b"unique\n"})
        self.f.commit({"duplicate": b"unique\n"})
        self.f.git("mv", "a", "renamed")
        self.f.commit({})
        target = self.f.commit({"duplicate": None})
        # Endpoint trees alone are insufficient for rename uniqueness.
        self.assertIsNone(self.f.repo.lineage(old, target, "a"))

    def test_multiple_deletions_reuse_immutable_diff_results(self):
        old = self.f.commit({"a": b"unique-a\n", "b": b"unique-b\n", "other": b"keep\n"})
        target = self.f.commit({"a": None, "b": None})
        self.f.repo.begin_invocation()
        with mock.patch.object(accounting.subprocess, "run", wraps=subprocess.run) as calls:
            self.assertTrue(self.f.repo.proven_deleted(old, target, "a"))
            self.assertTrue(self.f.repo.proven_deleted(old, target, "b"))
            diffs = [call for call in calls.call_args_list if call.args[0][1] == "diff"]
            self.assertEqual(len(diffs), 2)  # One plain and one rename-aware diff.

    def test_delete_recreate_move_reformat_and_nonancestor_are_uncovered(self):
        t = self.f.commit({"a": b"one\ntwo\nthree\n"})
        value = self.f.full_review(t, "a", [[1, 3]])
        self.f.commit({"a": None})
        recreated = self.f.commit({"a": b"one\ntwo\nthree\n"})
        self.assertFalse(self.f.repo.coverage(recreated, [value], self.f.store)[0])
        self.f.git("checkout", "-q", t)
        moved = self.f.commit({"a": b"three\none\ntwo\n"})
        inherited = self.f.repo.coverage(moved, [value], self.f.store)[0]
        self.assertNotIn(1, inherited.get("a", set()))
        reformatted = self.f.commit({"a": b" one\n two\n three\n"})
        self.assertFalse(self.f.repo.coverage(reformatted, [value], self.f.store)[0])
        tree = self.f.repo.tree(t)
        squash = self.f.git("commit-tree", tree, "-m", "Unrelated squash")
        self.assertFalse(self.f.repo.coverage(squash, [value], self.f.store)[0])

    def test_skipped_partition_and_missing_artifact_never_credit(self):
        t = self.f.commit({"a": b"one\n", "b": b"two\n"})
        value = self.f.full_review(t, "a", [[1, 1]])
        value["payload"]["completion"]["skipped"] = True
        value["payload"]["outcome"] = "skipped"
        self.assertFalse(self.f.repo.coverage(t, [rehash(value)], self.f.store)[0])
        value = self.f.full_review(t, "a", [[1, 1]])
        Path(value["payload"]["artifacts"][0]["location"]).unlink()
        covered, _, gaps = self.f.repo.coverage(t, [value], self.f.store)
        self.assertFalse(covered); self.assertEqual(len(gaps), 1)

    def test_every_object_including_oversize_binary_empty_and_symlink_is_visible(self):
        t = self.f.commit({"a": b"one\ntwo\n", "empty": b"", "binary": b"\0x", "oversize": b"x" * 20})
        os.symlink("a", self.f.root / "link"); t = self.f.commit({})
        rows = {r["path"]: r for r in self.f.repo.inventory(t, 10)}
        self.assertEqual(set(rows), {"a", "empty", "binary", "oversize", "link"})
        self.assertEqual(rows["empty"]["disposition"], "empty")
        self.assertEqual(rows["oversize"]["lines"], 1)
        for name in ("binary", "oversize", "link"):
            self.assertEqual(rows[name]["disposition"], "unsupported")


if __name__ == "__main__":
    unittest.main()
