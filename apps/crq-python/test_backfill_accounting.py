"""Real fixture repositories exercise the explicit-line credit contract."""
import copy
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import backfill_accounting as accounting
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


class AccountingTest(unittest.TestCase):
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
