"""Author-snapshot launch: an admitted head the clone cannot check out waits.

Split provenance: apps/crq-python/test_author_snapshot.py was split by subject
into test_author_snapshot_plan.py, test_author_snapshot_enroll.py,
test_author_snapshot_payload.py, test_author_snapshot_install.py and
test_author_snapshot_launch.py; shared fixtures live in
test_author_snapshot_fixtures.py.
"""
import json
import unittest
from unittest import mock

import author_quota
import author_snapshot as snapshot
import crq
from test_author_snapshot_fixtures import SnapshotTransportFixture, envelope


class SnapshotTransport(SnapshotTransportFixture, unittest.TestCase):
    def test_admitted_head_the_clone_cannot_check_out_waits_without_a_start(self):
        # A runner-configured required smudge filter that fails: admission accepts the
        # snapshot, but launch must leave it ungranted (deadline fallback), not crash the tick.
        attrs = self.git("hash-object", "-w", "--stdin", data=b"* filter=strict\n")
        blob = self.git("hash-object", "-w", "--stdin", data=b"filtered\n")
        tree = self.git("mktree", data=f"100644 blob {attrs}\t.gitattributes\n100644 blob {blob}\tfile.txt\n".encode())
        self.request = envelope(self.repo, self.base, tree)
        self.call()
        for key, value in (("filter.strict.smudge", "false"), ("filter.strict.required", "true")):
            snapshot.git(self.destination, "config", key, value)
        q = json.loads((self.state / "queue.json").read_text())
        item = q["items"][0]
        worktrees = self.repo / "worktrees"
        with mock.patch.multiple(crq, CLONE=self.destination, WT_ROOT=worktrees, RUNS=self.state / "runs"), \
             mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
             mock.patch.object(crq, "save_queue") as save:
            with self.assertRaisesRegex(author_quota.AuthorRefused, "cannot be checked out"):
                crq.launch(q, item, crq.plan_author(item, False))
        self.assertEqual((item["state"], item["author_lease"]["state"], q["starts"]), ("pending", "waiting", []))
        self.assertIsNone(item.get("run"))
        save.assert_not_called()
        self.assertEqual(snapshot.git(self.destination, "for-each-ref", "refs/heads/crq/"), b"")
        self.assertEqual(list(worktrees.glob("*")), [])
