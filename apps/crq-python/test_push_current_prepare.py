"""Push-range prepare: include/exclude globs and the scope split.

Split provenance: moved verbatim from apps/crq-python/test_push_current.py.
Fixtures live in test_push_current_fixtures.py.
"""
import unittest
from unittest import mock

from test_push_current_fixtures import FOREIGN, PushTestBase, crq, push_current


class PushTest(PushTestBase, unittest.TestCase):
    def test_prepare_applies_exclude_globs(self):
        self.commit(self.foreign_origin, "range work", when=self.ago(2),
                    files={"code.py": "x = 1\n", "vendored/lib.py": "vendor\n", "docs/guide.md": "doc\n"})
        item = self.enroll_push(exclude=["vendored/**", "docs/*"])
        version_calls = []
        original = crq.run

        def counting(argv, **kw):
            if argv == ["coderabbit", "--version"]:
                version_calls.append(argv)
            return original(argv, **kw)

        with mock.patch.object(crq, "run", side_effect=counting):
            plan = self.prepare(item)
            again = self.prepare(item)  # capture is written once, never re-captured
        self.assertEqual(len(version_calls), 1)
        self.assertEqual(again["base"], plan["base"])
        rows = {r["path"]: r for r in item["capture"]["paths"]}
        self.assertEqual(rows["vendored/lib.py"]["disposition"], "excluded-config")
        self.assertIn(FOREIGN, rows["vendored/lib.py"]["reason"])
        self.assertEqual(rows["docs/guide.md"]["disposition"], "excluded-config")
        self.assertEqual(rows["code.py"]["disposition"], "included")
        diff = self.git(self.foreign, "diff", "--name-status", plan["base"], plan["head"])
        self.assertEqual(diff.splitlines(), ["A\tcode.py"])
        self.assertEqual(plan["review_pin"], plan["target"])

    def test_prepare_applies_include_globs(self):
        self.commit(self.foreign_origin, "range work", when=self.ago(2),
                    files={"code.py": "x = 1\n", "vendored/lib.py": "vendor\n", "docs/guide.md": "doc\n"})
        item = self.enroll_push(include=["code.py"])
        plan = self.prepare(item)
        rows = {r["path"]: r for r in item["capture"]["paths"]}
        self.assertEqual(rows["code.py"]["disposition"], "included")
        for path in ("vendored/lib.py", "docs/guide.md"):
            self.assertEqual(rows[path]["disposition"], "excluded-config")
            self.assertIn(FOREIGN, rows[path]["reason"])
        diff = self.git(self.foreign, "diff", "--name-status", plan["base"], plan["head"])
        self.assertEqual(diff.splitlines(), ["A\tcode.py"])

    def test_scope_split_enrolls_followup_with_paths_filter(self):
        big = {f"f{n}.py": "x" * 256000 + "\n" for n in range(9)}  # 8 fit; the 9th overflows 2 MiB
        c1 = self.commit(self.foreign_origin, "big range", when=self.ago(2), files=big)
        item = self.enroll_push(floor=self.iso_of(self.ago(36)))
        plan = self.prepare(item)
        rows = item["capture"]["paths"]
        self.assertEqual(sum(r["disposition"] == "included" for r in rows), 8)
        split = next(r for r in rows if r["disposition"] == "deferred-split")
        followup = next(i for i in self.q["items"] if i["id"] != item["id"])
        self.assertEqual(followup["id"], push_current.part_id(self.repos[0], self.base, c1, 2))
        self.assertEqual(followup["repo"], FOREIGN)
        self.assertEqual(followup["kind"], push_current.KIND)
        self.assertEqual(followup["depends_on"], item["id"])
        self.assertEqual(followup["subject"]["paths_filter"], [split["path"]])
        self.assertIn(followup["id"], split["reason"])
        self.assertIsNotNone(plan)
        # The follow-up part is its own full review of exactly the overflow path.
        fplan = self.prepare(followup)
        self.assertIsNotNone(fplan)
        self.assertEqual([r["path"] for r in followup["capture"]["paths"]], [split["path"]])
        fdiff = self.git(self.foreign, "diff", "--name-status", fplan["base"], fplan["head"])
        self.assertEqual(fdiff.splitlines(), ["A\t" + split["path"]])

    def test_scope_rescue_rejects_binary_overflow_content(self):
        # current_paths decides the cumulative 2 MiB cap before reading a blob,
        # so an overflow row is never content-checked. A rescued row must not
        # smuggle binary content into the projection.
        big = {f"f{n}.py": "x" * 256000 + "\n" for n in range(8)}  # they fill the 2 MiB scope
        self.commit(self.foreign_origin, "big range", when=self.ago(2), files=big)
        (self.foreign_origin / "z.bin").write_bytes(b"\x00\xff" * 128000)  # 256000 bytes, binary
        self.commit(self.foreign_origin, "binary overflow", when=self.ago(1))
        item = self.enroll_push(floor=self.iso_of(self.ago(36)))
        plan = self.prepare(item)
        rows = {r["path"]: r for r in item["capture"]["paths"]}
        self.assertEqual(rows["z.bin"]["disposition"], "unsupported")
        self.assertEqual(rows["z.bin"]["reason"], "binary or non-UTF8 current blob")
        self.assertEqual(sum(r["disposition"] == "included" for r in rows.values()), 8)
        self.assertEqual([r["path"] for r in rows.values() if r["disposition"] == "deferred-split"], [])
        self.assertEqual([i["id"] for i in self.q["items"]], [item["id"]])
        diff = self.git(self.foreign, "diff", "--name-status", plan["base"], plan["head"])
        self.assertEqual(len(diff.splitlines()), 8)


if __name__ == "__main__":
    unittest.main()
