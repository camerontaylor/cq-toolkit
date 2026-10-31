"""Offline publisher batching, observation and dependency boundaries."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import review_ledger as ledger
from test_review_ledger import AT, rehash, review


class LedgerBatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.remote = self.root / "remote.git"
        subprocess.run(["git", "init", "--bare", "-q", str(self.remote)], check=True, capture_output=True)
        self.git("init", "-q")
        self.git("config", "user.name", "fixture")
        self.git("config", "user.email", "fixture@localhost")
        self.git("remote", "add", "origin", str(self.remote))
        tree = self.git("mktree", input=b"")
        self.genesis = self.git("commit-tree", tree, "-m", "Genesis")
        self.git("push", "origin", self.genesis + ":refs/heads/cq/review-ledger")
        self.publisher = ledger.GitLedger(self.repo)
        self.store = ledger.ArtifactStore(self.root / "artifacts")
        self.ref = self.store.put(b"fixture evidence")
        self.out = ledger.Outbox(self.root / "outbox", self.store)

    def git(self, *args, **kwargs):
        return subprocess.run(["git", *args], cwd=self.repo, capture_output=True,
                              check=True, **kwargs).stdout.decode().strip()

    def imported(self, ident, reason="No authenticated scope", **overrides):
        return ledger.event("import-result", "import:" + str(ident), AT, {
            "source": {"repo": ledger.REPO, "producer": "fixture", "type": "author-cli",
                       "id": str(ident), "authenticated": False},
            "source_digest": self.ref["sha256"], "result": "unverified", "reason": reason,
            "review_id": None, "duplicate_id": None, "artifacts": [self.ref], **overrides})

    def commits(self, head):
        return self.git("rev-list", "--reverse", self.genesis + ".." + head).splitlines()

    def counts(self, head):
        return [len(self.git("diff-tree", "--no-commit-id", "--name-only", "-r", c).splitlines())
                for c in self.commits(head)]

    def test_65_records_use_two_commits_and_ack_every_observed_id(self):
        values = [self.imported(i, result="rejected" if i % 2 else "unverified") for i in range(65)]
        for value in values:
            self.out.spool(value)
        head = self.publisher.publish(self.out)
        self.assertEqual(self.counts(head), [64, 1])
        self.assertFalse(self.out.pending())
        self.assertEqual({v["id"] for v in self.publisher.read(head)}, {v["id"] for v in values})

    def test_aggregate_bytes_split_before_four_mib(self):
        values = [self.imported(i, reason="x" * (900 * 1024)) for i in range(5)]
        for value in values:
            self.out.spool(value)
        head = self.publisher.publish(self.out)
        self.assertEqual(self.counts(head), [4, 1])
        for commit in self.commits(head):
            added = self.git("diff-tree", "--no-commit-id", "--name-only", "-r", commit).splitlines()
            total = sum(int(self.git("cat-file", "-s", commit + ":" + name)) for name in added)
            self.assertLessEqual(total, ledger.IMPORT_BATCH_BYTES)

    def test_lost_push_response_reconciles_whole_batch_without_duplicate_commit(self):
        values = [self.imported(i) for i in range(3)]
        for value in values:
            self.out.spool(value)
        push = self.publisher.push
        calls = []
        def response_lost(base, head):
            push(base, head)
            calls.append(head)
            raise OSError("response lost after remote accepted")
        with mock.patch.object(self.publisher, "push", side_effect=response_lost):
            head = self.publisher.publish(self.out)
        self.assertEqual(calls, [head])
        self.assertEqual(self.counts(head), [3])
        self.assertFalse(self.out.pending())

    def test_unobserved_batch_keeps_all_ids_pending(self):
        for i in range(3):
            self.out.spool(self.imported(i))
        with mock.patch.object(self.publisher, "push"):
            with self.assertRaisesRegex(ledger.IntegrityError, "remote acknowledgement"):
                self.publisher.publish(self.out)
        self.assertEqual(len(self.out.pending()), 3)
        self.assertEqual(self.publisher.fetch()[0], self.genesis)

    def test_dependency_records_remain_serial_and_missing_dependency_refused(self):
        original = review([self.ref])
        original["payload"]["outcome"] = "unverified"
        rehash(original)
        linked = self.imported("linked", result="duplicate", duplicate_id=original["id"])
        self.out.spool(linked)
        with self.assertRaisesRegex(ledger.IntegrityError, "dependencies"):
            self.publisher.publish(self.out)
        self.assertEqual(self.publisher.fetch()[0], self.genesis)
        self.out.spool(original)
        head = self.publisher.publish(self.out)
        self.assertEqual(self.counts(head), [1, 1])
        self.assertEqual([v["id"] for v in self.publisher.read(head)], [original["id"], linked["id"]])

    def test_source_conflict_prevents_batch_push(self):
        self.out.spool(self.imported("same", reason="first"))
        self.out.spool(self.imported("same", reason="second"))
        with mock.patch.object(self.publisher, "push") as push:
            with self.assertRaisesRegex(ledger.IntegrityError, "source evidence conflict"):
                self.publisher.publish(self.out)
        push.assert_not_called()
        self.assertEqual(len(self.out.pending()), 2)


if __name__ == "__main__":
    unittest.main()
