"""Open-review cycle policy: one completed cycle, optional cycles, admin actions.

Split provenance: apps/crq-python/test_author_quota.py was split into
test_author_quota_admission.py, test_author_quota_launch.py,
test_author_quota_runner.py, test_author_quota_crash_recovery.py,
test_author_quota_harvest.py, test_author_quota_tick.py,
test_author_quota_observation.py and test_author_quota_open_cycle.py.
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_author_quota_fixtures import BASE, HEAD, author_quota, crq


class OpenCyclePolicyTest(unittest.TestCase):
    def item(self, **over):
        return dict(dict(id="pr1", pr=1, kind="open", state="pending", cycles=[], order=1), **over)

    def test_one_completed_cycle_finishes_and_removes_boost(self):
        item = self.item(cycles=[dict(head=HEAD)], boost=True)
        crq.advance_open(item)
        self.assertEqual(item["state"], "done")
        self.assertNotIn("boost", item)
        empty = self.item()
        crq.advance_open(empty)
        self.assertEqual(empty["state"], "pending")

    def test_fix_prs_cannot_claim_synthetic_prior_credit(self):
        q = dict(items=[])
        item = crq.new_item(q, [], True, id="pr1", pr=1, kind="open", prior_cycles=1)
        self.assertEqual(crq.completed_open_cycles(item), 0)
        self.assertEqual(item["prior_cycles"], 0)
        self.assertEqual(crq.completed_open_cycles(self.item(prior_cycles=1)), 0)
        self.assertEqual(crq.completed_open_cycles(self.item(prior_cycles=1, prior_base=BASE)), 0)

    def test_required_and_optional_labels(self):
        info = dict(state="OPEN", isDraft=False, headRefOid=HEAD,
                    baseRefName="merge-queue", headRefName="topic")
        with mock.patch.object(crq, "git", return_value=BASE):
            self.assertEqual(crq.plan_open(self.item(), info, False)["label"], "one review of captured range")
            self.assertEqual(crq.plan_open(self.item(cycles=[{}]), info, False)["label"],
                             "one review of captured range")

    def test_existing_one_of_two_migrates_idempotently_without_touching_inflight(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "queue.json"
            old = [self.item(cycles=[{}], boost=True), self.item(id="empty"),
                   self.item(id="blocked", cycles=[{}], state="blocked"),
                   self.item(id="inflight", cycles=[{}], state="reviewing"),
                   self.item(id="optional", cycles=[{}], optional_cycle=True),
                   self.item(id="synthetic", prior_cycles=1)]
            path.write_text(json.dumps(dict(items=old)))
            with mock.patch.object(crq, "QUEUE", path):
                q = crq.load_queue()
                self.assertEqual([i["state"] for i in q["items"]],
                                 ["done", "pending", "done", "reviewing", "pending", "pending"])
                path.write_text(json.dumps(q))
                self.assertEqual(crq.load_queue(), q)
                self.assertTrue(all("boost" not in i for i in q["items"]))

    def test_migration_preserves_incomplete_items_for_admission_validation(self):
        q = dict(items=[
            {"id": "author-snapshot-1"},
            {"id": "no-state", "kind": "open", "cycles": [{}]},
            {"id": "no-cycles", "kind": "open", "state": "pending"},
            {"id": "no-kind", "state": "pending", "cycles": [{}]},
        ])
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "queue.json"
            before = json.dumps(q).encode()
            path.write_bytes(before)
            with mock.patch.object(crq, "QUEUE", path):
                self.assertEqual(crq.load_queue(), q)
            self.assertEqual(path.read_bytes(), before)

    def test_optional_cycle_lowest_rank_and_never_a_dependency_blocker(self):
        optional = self.item(cycles=[{}], optional_cycle=True)
        for kind in ("open", "delta", "merged", "coverage", crq.review_receipt.KIND,
                     author_quota.AUTHOR_KIND):
            with self.subTest(kind=kind):
                self.assertLess(crq.rank(self.item(kind=kind)), crq.rank(optional))
        self.assertTrue(crq.deps_met(dict(items=[optional]), dict(depends_on="pr1")))
        self.assertFalse(crq.optional_wait(dict(items=[optional]), optional))

    def test_operator_priority_order_and_admin_events_for_any_pending_kind(self):
        for kind in ("open", "merged", "delta", "coverage", crq.review_receipt.KIND, author_quota.AUTHOR_KIND):
            with self.subTest(kind=kind):
                item = self.item(kind=kind, order=99)
                q = dict(items=[item])
                with mock.patch.object(crq, "load_queue", return_value=q), \
                     mock.patch.object(crq, "save_queue") as save, \
                     mock.patch.object(crq, "write_status"), mock.patch.object(crq, "event") as event:
                    crq.admin("prioritize", "pr1", "urgent")
                    self.assertTrue(item["operator_priority"])
                    self.assertLess(crq.sort_key(item), crq.sort_key(self.item(order=0)))
                    event.assert_called_with("admin_prioritize", item="pr1", reason="urgent")
                    save.assert_called_with(q)
                    crq.admin("deprioritize", "pr1", "normal")
                    self.assertNotIn("operator_priority", item)
                    event.assert_called_with("admin_deprioritize", item="pr1", reason="normal")

    def test_requeue_completed_open_is_optional_and_survives_reload(self):
        item = self.item(cycles=[{}], state="done")
        with mock.patch.object(crq, "load_queue", return_value=dict(items=[item])), \
             mock.patch.object(crq, "save_queue"), mock.patch.object(crq, "write_status"), \
             mock.patch.object(crq, "event"):
            crq.admin("requeue", "pr1", "extra review")
        self.assertTrue(item["optional_cycle"])
        self.assertEqual(item["state"], "pending")
        self.assertEqual(crq.rank(item), 5)

    def test_merged_current_ranks_with_new_followups_before_backlog(self):
        current = self.item(kind=crq.review_receipt.KIND)
        self.assertEqual(crq.rank(current), 2)
        self.assertEqual(crq.rank(current), crq.rank(self.item(kind="merged", source="followup")))
        self.assertLess(crq.rank(self.item()), crq.rank(current))
        self.assertLess(crq.rank(current), crq.rank(self.item(kind="merged")))


if __name__ == "__main__":
    unittest.main()
