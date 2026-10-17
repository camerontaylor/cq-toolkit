"""P5 pre-change characterization at promoted P3 57220fd7.

Offline Git objects only: no reviewer, network, signer or real state access.
A tree OID passes legacy shape admission but cannot yet produce a review plan.
"""
import copy
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import author_quota
import crq

AT = "2026-10-17T00:00:00Z"


class SnapshotBaseline(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "-q")
        self.base_tree = self.tree(b"baseline\n")
        self.base = self.commit(self.base_tree)
        self.changed_tree = self.tree(b"working tree edit\n")
        self.head = self.commit(self.changed_tree, self.base)
        self.q = {"items": [], "starts": [], "unknown": {"preserve": True}}

    def git(self, *args, data=None):
        return subprocess.run(
            ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", *args],
            cwd=self.repo, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=True).stdout.decode().strip()

    def tree(self, contents):
        blob = self.git("hash-object", "-w", "--stdin", data=contents)
        return self.git("mktree", data=f"100644 blob {blob}\tfile.txt\n".encode())

    def commit(self, tree, parent=None):
        return self.git("commit-tree", tree, *(["-p", parent] if parent else []), data=b"fixture\n")

    def enroll(self, head):
        return author_quota.enroll(self.q, request_id="snapshot-baseline", base=self.base,
                                  head=head, target="origin/merge-queue", cycle=1, at=AT)["item"]

    def test_commit_plan_uses_existing_objects_without_fetch_or_mutation(self):
        item = self.enroll(self.head)
        before = copy.deepcopy(self.q)
        with mock.patch.object(crq, "CLONE", self.repo), mock.patch.object(crq, "fetch") as fetch:
            plan = crq.plan_author(item, False)
        self.assertEqual((plan["base"], plan["head"]), (self.base, self.head))
        fetch.assert_not_called()
        self.assertEqual(self.q, before)
        self.assertEqual(self.q["starts"], [])

    def test_raw_tree_is_shape_admitted_but_waits_instead_of_dispatching(self):
        item = self.enroll(self.changed_tree)
        before = copy.deepcopy(self.q)
        with mock.patch.object(crq, "CLONE", self.repo), mock.patch.object(crq, "fetch") as fetch:
            self.assertFalse(crq.object_present(self.changed_tree))
            with self.assertRaises(crq.NotReady):
                crq.plan_author(item, False)
        fetch.assert_called_once_with()
        self.assertEqual(self.q, before)
        self.assertEqual(item["state"], "pending")
        self.assertEqual(self.q["starts"], [])

    def test_tree_identity_cannot_replace_an_enrolled_commit_binding(self):
        self.enroll(self.head)
        before = copy.deepcopy(self.q)
        with self.assertRaises(author_quota.AuthorRefused):
            self.enroll(self.changed_tree)
        self.assertEqual(self.q, before)
