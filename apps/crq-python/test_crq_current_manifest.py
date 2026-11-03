"""Current source manifest: path caps, rename dispositions and non-UTF-8 names.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import os
import subprocess
import unittest
from unittest import mock
from test_crq_fixtures import (
    CurrentFixture,
    crq,
    setUpModule,
)

class CurrentTest(CurrentFixture, unittest.TestCase):
    def source_names(self):
        out = subprocess.run(["git", "diff", "--name-only", "--no-renames", "-z", self.merge + "^1", self.merge],
                             cwd=self.repo, check=True, capture_output=True).stdout
        return sorted(name.decode("utf-8", "surrogateescape") for name in out.rstrip(b"\0").split(b"\0"))

    def new_source(self, message):
        self.merge = self.commit(message)
        self.info["mergeCommit"]["oid"] = self.merge
        self.g("update-ref", "refs/remotes/origin/main", self.merge)
        return self.source_names()

    def oversized_source(self):
        """Source of 9 cheap paths: empty, deleted, symlinked and unsupported names."""
        for n in range(4):
            self.write(f"empty-{n}.py", "")
        self.write("tab\tname.py", "x\n")
        os.symlink("unrelated.py", self.repo / "link.py")
        (self.repo / "affected.py").unlink()
        (self.repo / "rename.py").unlink()
        self.write("unrelated.py", "")
        return self.new_source("many tiny, empty, deleted and unsupported paths")

    def assert_oversized_without_per_path_work(self, item, cap):
        real_git, real_git_z = crq.git, crq.git_z
        def no_per_path_git(*args, **kw):
            self.assertFalse(args[0] == "rev-parse" and ":" in args[-1], args)
            return real_git(*args, **kw)
        def source_listing_only(*args, **kw):
            self.assertEqual(args[:4], ("diff", "--name-only", "--no-renames", "-z"),
                             "rename diff and ls-tree are skipped for an oversized source")
            return real_git_z(*args, **kw)
        with mock.patch.object(crq, "CURRENT_PATH_CAP", cap), \
             mock.patch.object(crq, "git", side_effect=no_per_path_git), \
             mock.patch.object(crq, "git_z", side_effect=source_listing_only) as listing, \
             mock.patch.object(crq, "path_exists", side_effect=AssertionError("per-path work")):
            self.assertIsNone(self.plan_item(item))
        self.assertEqual(listing.call_count, 1)
        self.assertEqual(item["state"], "unsupported")
        self.assertEqual(self.document(item)["outcome"], "unsupported")
        self.assertFalse(self.document(item)["counted"])
        self.assertNotIn("base", item["capture"])
        self.assertEqual(self.q["starts"], [])
        self.assertFalse((self.repo / ".git" / "refs" / "crq").exists())
        self.assertEqual(item["capture"]["scope_digest"], crq.review_receipt.digest(item["capture"]["paths"]))
        self.assertEqual(item["capture"]["equivalence"], crq.review_receipt.current_equivalence(item["capture"]))
        return item["capture"]["paths"]

    def oversized_rows(self, names, cap):
        first = (f"source path count {len(names)} exceeds cap {cap}; not scanned; first {cap} sorted "
                 "source paths listed; all-source-paths sha256 " + crq.review_receipt.digest(names))
        rest = "source path count exceeds cap; not scanned; see first manifest row"
        return [{"source_path": n, "path": n, "resolution": "same-path-current",
                 "disposition": "unsupported", "reason": rest if i else first} for i, n in enumerate(names[:cap])]

    def test_oversized_source_path_count_is_unsupported_before_per_path_work(self):
        names = self.oversized_source()
        self.assertEqual(len(names), 9)
        rows = self.assert_oversized_without_per_path_work(self.enroll(), 4)
        self.assertEqual(rows, self.oversized_rows(names, 4))

    def test_carriage_return_and_newline_path_variants_count_exactly_against_cap(self):
        for name in ("crlf\r.py", "crlf\n.py", "crlf\r\n.py", "plain.py"):
            self.write(name, "distinct path\n")
        names = self.new_source("paths differing only by CR/LF")
        self.assertEqual(names, sorted(["crlf\n.py", "crlf\r.py", "crlf\r\n.py", "plain.py"]))
        # Text-mode decoding collapsed these to two names, under a cap of 3, and dispatched plain.py.
        rows = self.assert_oversized_without_per_path_work(self.enroll(), 3)
        self.assertEqual(rows, self.oversized_rows(names, 3))
        with mock.patch.object(crq, "CURRENT_PATH_CAP", 4):
            exact = crq.current_paths(self.merge, self.merge)
        self.assertEqual([r["source_path"] for r in exact], names)
        self.assertEqual([r["disposition"] for r in exact], ["unsupported"] * 3 + ["included"])

    def test_git_z_has_run_timeout_and_propagates_expiry(self):
        expired = subprocess.TimeoutExpired(["git", "diff"], 600)
        with mock.patch.object(crq.subprocess, "run", side_effect=expired) as launch:
            with self.assertRaises(subprocess.TimeoutExpired):
                crq.git_z("diff", "--name-only", "--no-renames", "-z", self.pre, self.merge)
        self.assertEqual(launch.call_args.kwargs["timeout"], 600)

    def test_non_utf8_path_names_are_unsupported_with_exact_stable_rows(self):
        raw = os.fsencode(self.repo) + b"/latin1-\xe9.py"
        with open(raw, "w") as handle:
            handle.write("not reviewed\n")
        self.write("plain.py", "reviewed\n")
        names = self.new_source("non-UTF-8 path name")
        odd = b"latin1-\xe9.py".decode("utf-8", "surrogateescape")
        self.assertEqual(names, [odd, "plain.py"])
        item = self.enroll()
        plan = self.plan_item(item)
        rows = item["capture"]["paths"]
        self.assertEqual(rows[0], {"source_path": odd, "path": odd, "resolution": "same-path-current",
                                   "disposition": "unsupported", "reason": "path name is not valid UTF-8; never reviewed"})
        self.assertEqual(rows[1]["disposition"], "included")
        self.assertEqual(self.g("diff", "--name-status", plan["base"], plan["head"]).splitlines(), ["A\tplain.py"])
        reloaded = crq.load_queue()["items"][-1]["capture"]
        self.assertEqual(reloaded["paths"], rows)
        self.assertEqual(crq.review_receipt.current_equivalence(reloaded), item["capture"]["equivalence"])
        self.assertEqual(crq.current_paths(self.merge, self.merge), rows)

    def test_rename_to_non_utf8_target_name_is_unsupported_with_exact_rows(self):
        item = self.enroll()
        os.rename(self.repo / "rename.py", os.fsencode(self.repo) + b"/renamed-\xe9.py")
        target = self.commit("rename valid UTF-8 source path to a non-UTF-8 name")
        odd = b"renamed-\xe9.py".decode("utf-8", "surrogateescape")
        self.g("update-ref", "refs/remotes/origin/main", target)
        plan = self.plan_item(item)
        rows = {r["source_path"]: r for r in item["capture"]["paths"]}
        self.assertEqual(rows["rename.py"], {"source_path": "rename.py", "path": odd,
                                             "resolution": "git-rename-M50", "disposition": "unsupported",
                                             "reason": "path name is not valid UTF-8; never reviewed"})
        self.assertEqual(rows["affected.py"]["disposition"], "included")
        self.assertEqual(self.g("diff", "--name-status", plan["base"], plan["head"]).splitlines(), ["A\taffected.py"])
        self.assertEqual(crq.current_paths(self.merge, target), item["capture"]["paths"])
        reloaded = next(i for i in crq.load_queue()["items"] if i["id"] == item["id"])["capture"]
        self.assertEqual(reloaded["paths"], item["capture"]["paths"])
        self.assertEqual(crq.review_receipt.current_equivalence(reloaded), item["capture"]["equivalence"])

    def test_source_at_path_count_cap_is_scanned_normally(self):
        names = self.oversized_source()
        with mock.patch.object(crq, "CURRENT_PATH_CAP", len(names)):
            rows = crq.current_paths(self.merge, self.merge)
        self.assertEqual([r["source_path"] for r in rows], names)
        self.assertFalse(any("exceeds cap" in r.get("reason", "") for r in rows))
        by_path = {r["source_path"]: r["disposition"] for r in rows}
        self.assertEqual(by_path["empty-0.py"], "excluded-with-reason")
        self.assertEqual(by_path["affected.py"], "deleted")
        self.assertEqual(by_path["link.py"], "unsupported")
        self.assertEqual(by_path["tab\tname.py"], "unsupported")

    def test_normal_manifest_shape_is_unchanged_by_path_count_cap(self):
        blob = lambda path: self.g("rev-parse", self.merge + ":" + path)
        self.assertEqual(crq.current_paths(self.merge, self.merge), [
            {"source_path": "affected.py", "path": "affected.py", "resolution": "same-path-current",
             "blob": blob("affected.py"), "mode": "100644", "bytes": 38, "disposition": "included"},
            {"source_path": "gone.py", "path": "gone.py", "resolution": "same-path-current",
             "disposition": "deleted", "reason": "no current path or evidenced rename"},
            {"source_path": "rename.py", "path": "rename.py", "resolution": "same-path-current",
             "blob": blob("rename.py"), "mode": "100644", "bytes": 160, "disposition": "included"}])

    def test_ambiguous_rename_keeps_explicit_partial_scope(self):
        self.write("duplicate.py", "rename survives\n" * 10)
        self.merge = self.commit("source includes identical rename candidates")
        self.info["mergeCommit"]["oid"] = self.merge
        item = self.enroll()
        self.g("mv", "rename.py", "new-one.py")
        self.g("mv", "duplicate.py", "new-two.py")
        target = self.commit("ambiguous identical renames")
        self.g("update-ref", "refs/remotes/origin/main", target)
        self.plan_item(item)
        rows = item["capture"]["paths"]
        self.assertEqual(next(r for r in rows if r["source_path"] == "duplicate.py")["disposition"], "ambiguous")
        # No other affected current code remains: ambiguity cannot become clean.
        self.assertEqual(item["state"], "unsupported")
        self.assertFalse(self.document(item)["counted"])
