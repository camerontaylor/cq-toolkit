"""Required collector: deletion evidence in required PRs.

Split provenance: apps/crq-python/test_backfill_runtime.py was split into
test_backfill_runtime_collector.py, test_backfill_runtime_admission.py,
test_backfill_runtime_observation.py, test_backfill_runtime_selection.py,
test_backfill_runtime_coverage.py, test_backfill_runtime_publish.py,
test_backfill_runtime_quota.py, test_backfill_runtime_events.py and
test_backfill_runtime_fixtures.py.
"""
import subprocess
import unittest
from types import SimpleNamespace
from unittest import mock

import backfill_runtime as runtime
import review_ledger as ledger
from test_backfill_runtime_fixtures import RuntimeTestBase


class RuntimeTest(RuntimeTestBase):
    def cached_collection(self, target, response, repo=None):
        original = subprocess.run
        def offline(command, *args, **kwargs):
            return SimpleNamespace(stdout=ledger.canonical(response)) if command[0] == "gh" else original(command, *args, **kwargs)
        with mock.patch.object(runtime.subprocess, "run", side_effect=offline):
            return runtime.collect_required(repo or self.f.repo, target, {"rows": [{"pr": 7}]}, self.f.store,
                                            cache_dir=self.state / "required-cache")

    def test_unchanged_second_collection_performs_no_git_or_lineage_work(self):
        merge = self.f.commit({"new": b"unique\n"})
        target = self.f.commit({"a": b"changed\n"})
        response = {"number": 7, "merged": True, "merge_commit_sha": merge}
        first = self.cached_collection(target, response)
        # A fresh repository instance models a later timer process, not a warm
        # in-memory cache. Even deletions/diffs/resolve must be skipped.
        repo = type(self.f.repo)(self.f.root)
        with mock.patch.object(repo, "git", side_effect=AssertionError("Git recomputed")), \
             mock.patch.object(repo, "lineage", side_effect=AssertionError("lineage recomputed")):
            self.assertEqual(self.cached_collection(target, response, repo), first)

    def test_changed_target_and_forge_context_invalidate_cache(self):
        merge = self.f.commit({"new": b"unique\n"})
        response = {"number": 7, "merged": True, "merge_commit_sha": merge, "title": "before"}
        self.cached_collection(merge, response)
        target = self.f.commit({"new": None})
        with mock.patch.object(self.f.repo, "lineage", wraps=self.f.repo.lineage) as lineage:
            paths, _ = self.cached_collection(target, response)
            self.assertGreater(lineage.call_count, 0)
        self.assertEqual(paths["7"][0]["disposition"], "deleted")
        with mock.patch.object(self.f.repo, "lineage", wraps=self.f.repo.lineage) as lineage:
            _, members = self.cached_collection(target, {**response, "title": "after"})
            self.assertGreater(lineage.call_count, 0)
        self.assertEqual(members["7"]["context"]["title"], "after")
        with self.assertRaises(ledger.IntegrityError):
            self.cached_collection(target, {**response, "merged": False})

    def test_invalid_or_wrong_target_cache_pointer_recomputes(self):
        merge = self.f.commit({"new": b"unique\n"})
        response = {"number": 7, "merged": True, "merge_commit_sha": merge}
        expected = self.cached_collection(merge, response)
        filename = self.state / "required-cache/7.json"
        old_pointer = filename.read_bytes()
        target = self.f.commit({"a": b"different\n"})
        newer = self.cached_collection(target, response)
        wrong_target = filename.read_bytes()
        for pointer in (b"not-json", b"null", b"{}", wrong_target):
            with self.subTest(pointer=pointer):
                filename.write_bytes(pointer)
                with mock.patch.object(self.f.repo, "lineage", wraps=self.f.repo.lineage) as lineage:
                    self.assertEqual(self.cached_collection(merge, response), expected)
                    self.assertGreater(lineage.call_count, 0)
        filename.write_bytes(old_pointer)
        with mock.patch.object(self.f.repo, "lineage", wraps=self.f.repo.lineage) as lineage:
            self.assertEqual(self.cached_collection(target, response), newer)
            self.assertGreater(lineage.call_count, 0)

    def test_cache_pointer_write_failure_does_not_block_inventory(self):
        merge = self.f.commit({"new": b"unique\n"})
        response = {"number": 7, "merged": True, "merge_commit_sha": merge}
        filename = self.state / "required-cache/7.json"
        original = ledger.atomic
        def readonly_index(path, data):
            if path == filename:
                raise OSError("read-only cache index")
            return original(path, data)
        with mock.patch.object(ledger, "atomic", side_effect=readonly_index):
            first = self.cached_collection(merge, response)
            self.assertFalse(filename.exists())
            with mock.patch.object(self.f.repo, "lineage", wraps=self.f.repo.lineage) as lineage:
                self.assertEqual(self.cached_collection(merge, response), first)
                self.assertGreater(lineage.call_count, 0)
        with mock.patch.object(self.f.store, "put", side_effect=OSError("durable artifact failure")):
            with self.assertRaisesRegex(OSError, "durable artifact failure"):
                self.cached_collection(merge, response)

    def test_required_collector_rejects_ambiguous_rename_as_deletion(self):
        self.f.commit({"unrelated": b"before\n"})
        merge = self.f.commit({"old": b"same\n"})
        target = self.f.commit({"old": None, "copy-one": b"same\n", "copy-two": b"same\n"})
        original = subprocess.run
        response = ledger.canonical({"number": 7, "merged": True, "merge_commit_sha": merge})
        def offline(command, *args, **kwargs):
            return SimpleNamespace(stdout=response) if command[0] == "gh" else original(command, *args, **kwargs)
        with mock.patch.object(runtime.subprocess, "run", side_effect=offline):
            paths, _ = runtime.collect_required(self.f.repo, target, {"rows": [{"pr": 7}]}, self.f.store)
        self.assertEqual(paths["7"][0]["disposition"], "ambiguous")
        self.assertNotIn("deletion_evidence", paths["7"][0])

    def test_required_collector_proves_deletion_in_required_pr(self):
        self.f.commit({"old": b"unique\n", "unrelated": b"before\n"})
        merge = self.f.commit({"old": None})
        target = self.f.commit({"unrelated": b"after\n"})
        original = subprocess.run
        response = ledger.canonical({"number": 7, "merged": True, "merge_commit_sha": merge})
        def offline(command, *args, **kwargs):
            return SimpleNamespace(stdout=response) if command[0] == "gh" else original(command, *args, **kwargs)
        with mock.patch.object(runtime.subprocess, "run", side_effect=offline):
            paths, _ = runtime.collect_required(self.f.repo, target, {"rows": [{"pr": 7}]}, self.f.store)
        self.assertEqual(paths["7"][0]["disposition"], "deleted")

    def test_required_collector_proves_deletion_with_unrelated_edit(self):
        self.f.commit({"unrelated": b"before\n"})
        merge = self.f.commit({"old": b"unique\n"})
        target = self.f.commit({"old": None, "unrelated": b"after\n"})
        original = subprocess.run
        response = ledger.canonical({"number": 7, "merged": True, "merge_commit_sha": merge})
        def offline(command, *args, **kwargs):
            return SimpleNamespace(stdout=response) if command[0] == "gh" else original(command, *args, **kwargs)
        with mock.patch.object(runtime.subprocess, "run", side_effect=offline):
            paths, _ = runtime.collect_required(self.f.repo, target, {"rows": [{"pr": 7}]}, self.f.store)
        self.assertEqual(paths["7"][0]["disposition"], "deleted")

    def test_modified_rename_is_not_proven_deletion(self):
        old = self.f.commit({"old": b"one\ntwo\nthree\nfour\nfive\n"})
        target = self.f.commit({"old": None, "new": b"one\ntwo\nthree\nfour\nchanged\n"})
        self.assertFalse(self.f.repo.proven_deleted(old, target, "old"))

if __name__ == "__main__":
    unittest.main()
