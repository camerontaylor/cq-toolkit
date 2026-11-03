"""Author-admission plan: existing objects are used without fetch or mutation.

Split provenance: apps/crq-python/test_author_snapshot.py was split by subject
into test_author_snapshot_plan.py, test_author_snapshot_enroll.py,
test_author_snapshot_payload.py, test_author_snapshot_install.py and
test_author_snapshot_launch.py; shared fixtures live in
test_author_snapshot_fixtures.py.
"""
import copy
import unittest
from unittest import mock

import author_quota
import crq
from test_author_snapshot_fixtures import SnapshotGitFixture


class SnapshotBaseline(SnapshotGitFixture, unittest.TestCase):
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
