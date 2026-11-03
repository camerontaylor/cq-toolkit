"""Author enrollment identity, idempotence and admission priority.

Split provenance: apps/crq-python/test_author_quota.py was split into
test_author_quota_admission.py, test_author_quota_launch.py,
test_author_quota_runner.py, test_author_quota_crash_recovery.py,
test_author_quota_harvest.py, test_author_quota_tick.py,
test_author_quota_observation.py and test_author_quota_open_cycle.py.
"""
import copy
import unittest

from test_author_quota_fixtures import BASE, HEAD, REQ, author_item, author_quota, binding, crq, empty_queue


class EnrollTest(unittest.TestCase):
    def test_enroll_creates_pending_item_only_and_never_dispatches(self):
        q = empty_queue()
        res = author_quota.enroll(q, **binding(), at=crq.iso())
        self.assertTrue(res["created"])
        item = res["item"]
        self.assertEqual((item["state"], item["kind"], item["pr"]), ("pending", "author", 0))
        self.assertEqual(item["cycles"], [])
        self.assertEqual(item["author_cycles"], [])
        self.assertEqual(item["author"]["base"], BASE)
        self.assertEqual(item["author"]["head"], HEAD)
        self.assertEqual(q["author_requests"][REQ]["item"], item["id"])
        self.assertEqual(q["starts"], [])  # enrollment only queues; the tick launches

    def test_identical_request_is_idempotent(self):
        q = empty_queue()
        first = author_item(q)["id"]
        again = author_quota.enroll(q, **binding(), at=crq.iso())
        self.assertFalse(again["created"])
        self.assertEqual(again["item"]["id"], first)
        self.assertEqual(len(q["items"]), 1)

    def test_conflicting_binding_refuses_without_mutation(self):
        q = empty_queue()
        author_item(q)
        before = copy.deepcopy(q)
        with self.assertRaisesRegex(author_quota.AuthorRefused, "different binding"):
            author_quota.enroll(q, **binding(head="d" * 40), at=crq.iso())
        self.assertEqual(q, before)

    def test_duplicate_binding_under_second_request_id_refuses(self):
        q = empty_queue()
        author_item(q)
        before = copy.deepcopy(q)
        with self.assertRaisesRegex(author_quota.AuthorRefused, "already"):
            author_quota.enroll(q, **binding(request_id="other-id"), at=crq.iso())
        self.assertEqual(q, before)

    def test_malformed_identity_refuses(self):
        for bad in (dict(base="short"), dict(head=BASE), dict(cycle=3), dict(cycle=0),
                    dict(cycle="1"), dict(target="bad target"), dict(request_id=""),
                    dict(request_id="../escape"), dict(request_id="a" * 81)):
            with self.subTest(bad=bad), self.assertRaises(author_quota.AuthorRefused):
                author_quota.enroll(empty_queue(), **binding(**bad), at=crq.iso())


class PriorityTest(unittest.TestCase):
    def test_author_ranks_after_ordinary_and_before_coverage(self):
        author = {"id": "author-x", "kind": "author", "order": 0}
        for kind, order in (("open", 9), ("delta", 9), ("merged", 9), ("promotion", 9)):
            with self.subTest(kind=kind):
                self.assertLess(crq.sort_key({"id": "n", "kind": kind, "order": order}),
                                crq.sort_key(author))
        coverage = {"id": "coverage-x", "kind": "coverage", "order": 5, "state": "pending"}
        self.assertLess(crq.sort_key(author), crq.sort_key(coverage))


if __name__ == "__main__":
    unittest.main()
