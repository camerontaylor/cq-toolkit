"""Offline queue-identity admission and original snapshot transport."""
import base64
import copy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

import author_snapshot
import capability_dispatcher
import review_receipt
import review_transport as transport
from test_author_snapshot_fixtures import SnapshotTransportFixture


class ReviewTransportTests(SnapshotTransportFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.policy = dict(repo="camerontaylor/cq-toolkit", enabled=True,
                           write=["queue-client"], branches=["main"])
        self.saved = copy.deepcopy(self.q)
        self.runner = SimpleNamespace(CLONE=self.destination, STATE=self.state,
            WT_ROOT=self.state / "worktrees", REPO=self.policy["repo"], CONFIG={},
            ALLOWLIST_PATHS=[], denylist_rules=lambda: [{"regex": "(?!)"}],
            secret_scan_diff=lambda *a, **kw: (True, {}),
            load_queue=lambda: copy.deepcopy(self.saved),
            save_queue=self.save, iso=lambda: "2026-11-08T00:00:00Z")
        ids = sorted(self.git("rev-list", "--objects", "--no-object-names", self.head, "^" + self.base).split())
        objects, digest = [], hashlib.sha256()
        for oid in ids:
            kind = self.git("cat-file", "-t", oid)
            data = base64.b64encode(author_snapshot.git(self.repo, "cat-file", kind, oid)).decode()
            objects.append(dict(oid=oid, type=kind, data=data))
            digest.update((oid + "\0" + kind + "\0" + data + "\n").encode())
        self.review = dict(v=1, op="submit", request_id="local-1",
            inputs=dict(repo=self.policy["repo"], target="main", base_commit=self.base,
                        base_tree=self.base_tree, head_commit=self.head,
                        head_tree=self.changed_tree, projection="full-diff"),
            snapshot=dict(v=1, tree=self.changed_tree, objects=objects, sha256=digest.hexdigest()))

    def save(self, q):
        self.saved = copy.deepcopy(q)

    def call_review(self, req):
        return json.loads(transport.handle(json.dumps(req).encode(), self.runner,
                                          principal="queue-client", policy=self.policy))

    def test_original_commit_install_retry_before_new_profile_and_result(self):
        result = self.call_review(self.review)
        self.assertEqual(result["action"], "created")
        self.assertEqual(self.saved["items"][0]["identity_inputs"]["head_commit"], self.head)
        self.assertEqual(author_snapshot.git(self.destination, "cat-file", "commit", self.head),
                         author_snapshot.git(self.repo, "cat-file", "commit", self.head))
        self.runner.CONFIG = {"local_review_profile": {"revision": "new-profile"}}
        self.review.pop("snapshot")
        again = self.call_review(self.review)
        self.assertEqual(again["identity"], result["identity"])
        self.assertEqual(len(self.saved["items"]), 1)
        item = self.saved["items"][0]
        item.update(state="done", scope_adequate=True,
                    receipt_id=review_receipt.write_receipt(self.state / "receipts", {"report": "a" * 7000}))
        parts = []
        index = 0
        while index is not None:
            chunk = self.call_review(dict(v=1, op="result", request_id="local-1", index=index))
            parts.append(base64.b64decode(chunk["data"]))
            index = chunk["next_index"]
        self.assertEqual(hashlib.sha256(b"".join(parts)).hexdigest(), item["receipt_id"])

    def test_queue_policy_and_primary_repo_only(self):
        self.policy["write"] = []
        with self.assertRaisesRegex(ValueError, "principal"):
            self.call_review(self.review)
        self.policy["write"] = ["queue-client"]
        self.review["inputs"]["repo"] = "other/repo"
        self.assertEqual(self.call_review(self.review)["reason"], "unsupported-repo")
        self.assertEqual(self.saved["items"], [])

    def test_six_mib_reader_and_additive_dispatch(self):
        raw = b'{"v":1,"op":"capabilities"}'
        self.assertEqual(transport.decode(raw + b" " * (transport.MAX_BYTES - len(raw)))["op"], "capabilities")
        with self.assertRaisesRegex(ValueError, "6 MiB"):
            transport.decode(raw + b" " * transport.MAX_BYTES)
        self.assertEqual(capability_dispatcher.dispatch("review-v1", None, None, lambda: "review"), "review")
        self.assertEqual(capability_dispatcher.dispatch("author-v1", lambda: "legacy", None), "legacy")

    def test_conflicting_retry_and_tamper_refuse_without_queue_mutation(self):
        self.call_review(self.review)
        before = copy.deepcopy(self.saved)
        self.review["inputs"]["head_tree"] = "f" * 40
        with self.assertRaisesRegex(ValueError, "different inputs"):
            self.call_review(self.review)
        self.assertEqual(before, self.saved)
