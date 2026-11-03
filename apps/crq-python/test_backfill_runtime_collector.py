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
