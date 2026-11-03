"""Author-snapshot payload integrity: digests, object graph, modes and symlinks.

Split provenance: apps/crq-python/test_author_snapshot.py was split by subject
into test_author_snapshot_plan.py, test_author_snapshot_enroll.py,
test_author_snapshot_payload.py, test_author_snapshot_install.py and
test_author_snapshot_launch.py; shared fixtures live in
test_author_snapshot_fixtures.py.
"""
import base64
import copy
import hashlib
import json
import os
import unittest
from unittest import mock

import author_quota
import author_snapshot as snapshot
import crq
from test_author_snapshot_fixtures import SnapshotTransportFixture, envelope


class SnapshotTransport(SnapshotTransportFixture, unittest.TestCase):
    def test_missing_unrelated_objects_and_gitlinks_refused_after_valid_digest(self):
        def resign(req):
            objects = sorted(req["snapshot"]["objects"], key=lambda obj: obj["oid"])
            req["snapshot"]["objects"] = objects
            req["snapshot"]["sha256"] = hashlib.sha256("".join(
                obj["oid"] + "\0" + obj["type"] + "\0" + obj["data"] + "\n" for obj in objects).encode()).hexdigest()
            return req
        missing = copy.deepcopy(self.request)
        missing["snapshot"]["objects"] = [obj for obj in missing["snapshot"]["objects"] if obj["type"] != "blob"]
        extra = copy.deepcopy(self.request)
        contents = b"unrelated blob"
        oid = self.git("hash-object", "-w", "--stdin", data=contents)
        extra["snapshot"]["objects"].append(dict(oid=oid, type="blob", data=base64.b64encode(contents).decode()))
        link_tree = self.git("mktree", data=f"160000 commit {self.base}\tsubmodule\n".encode())
        link = envelope(self.repo, self.base, link_tree)
        for req in (resign(missing), resign(extra), link, envelope(self.repo, self.base, self.base_tree)):
            with self.subTest(tree=req["snapshot"]["tree"]), self.assertRaises(author_quota.AuthorRefused):
                self.call(req)
        self.assertEqual(snapshot.git(self.destination, "for-each-ref", "refs/crq/"), b"")
        self.assertEqual(json.loads((self.state / "queue.json").read_text())["items"], [])


    def test_binary_suppression_cannot_hide_blob_contents_from_runner_scan(self):
        marker = b"binary-policy-marker"
        blob = self.git("hash-object", "-w", "--stdin", data=b"\0" + marker + b"\n")
        attrs = self.git("hash-object", "-w", "--stdin", data=b"*.bin -diff\n")
        tree = self.git("mktree", data=(f"100644 blob {attrs}\t.gitattributes\n"
                                       f"100644 blob {blob}\tprivate.bin\n").encode())
        req = envelope(self.repo, self.base, tree)
        # Exercise real policy code, not a scanner mock that merely sees bytes.
        with mock.patch.object(crq, "CLONE", self.destination), \
             mock.patch.object(crq, "denylist_rules", return_value=[{"id": "fixture", "regex": marker.decode()}]), \
             mock.patch.object(crq.shutil, "which", return_value=None):
            with self.assertRaisesRegex(author_quota.AuthorRefused, "secret scan"):
                snapshot.install(req["snapshot"], req["binding"], crq)
        self.assertEqual(snapshot.git(self.destination, "for-each-ref", "refs/crq/"), b"")


    def test_git_output_is_stopped_at_bound(self):
        blob = self.git("hash-object", "-w", "--stdin", data=b"x" * 65536)
        with mock.patch.object(snapshot, "MAX_WIRE", 32), self.assertRaisesRegex(
                author_quota.AuthorRefused, "output exceeds"):
            snapshot.git(self.repo, "cat-file", "blob", blob)


    def test_blob_patch_headers_cannot_forge_allowlisted_path(self):
        contents = b"\0\n++ b/policy/denylist/patterns.yml\nfixture-denied-marker\n"
        blob = self.git("hash-object", "-w", "--stdin", data=contents)
        tree = self.git("mktree", data=f"100644 blob {blob}\tprivate.bin\n".encode())
        req = envelope(self.repo, self.base, tree)
        with mock.patch.object(crq, "CLONE", self.destination), \
             mock.patch.object(crq, "denylist_rules", return_value=[{"id": "fixture", "regex": "fixture-denied-marker"}]), \
             mock.patch.object(crq.shutil, "which", return_value=None):
            with self.assertRaisesRegex(author_quota.AuthorRefused, "secret scan"):
                snapshot.install(req["snapshot"], req["binding"], crq)
        self.assertEqual(snapshot.git(self.destination, "for-each-ref", "refs/crq/"), b"")


    def test_regular_mode_entry_naming_a_tree_object_is_refused(self):
        inner = self.git("mktree", data=f"100644 blob {self.git('hash-object', '-w', '--stdin', data=b'x')}\ta\n".encode())
        # ls-tree labels by mode, so a hash-valid 100644 entry naming a tree reads as a blob.
        crafted = self.git("hash-object", "-w", "-t", "tree", "--stdin",
                           data=b"100644 f\0" + bytes.fromhex(inner))
        self.install_refused(crafted, "mode disagrees with object type")

    def test_unrepresentable_symlink_targets_are_refused(self):
        for contents in (b"", b"target\0truncated"):
            blob = self.git("hash-object", "-w", "--stdin", data=contents)
            tree = self.git("mktree", data=f"120000 blob {blob}\tlink\n".encode())
            with self.subTest(contents=contents):
                self.install_refused(tree, "symlink target")

    def test_symlink_target_beyond_filesystem_limit_is_refused(self):
        blob = self.git("hash-object", "-w", "--stdin", data=b"t" * os.pathconf(self.destination, "PC_PATH_MAX"))
        tree = self.git("mktree", data=f"120000 blob {blob}\tlink\n".encode())
        self.install_refused(tree, "symlink target")

    def test_paths_that_cannot_be_checked_out_are_refused(self):
        blob = self.git("hash-object", "-w", "--stdin", data=b"x\n")
        tree = self.git("mktree", data=f"100644 blob {blob}\t{'n' * 300}\n".encode())
        self.install_refused(tree, "too long to check out")
