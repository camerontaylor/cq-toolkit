"""Post-harvest findings delivery: bounded retries and gh failure handling.

Split provenance: moved verbatim from apps/crq-python/test_push_current.py.
Fixtures live in test_push_current_fixtures.py.
"""
import unittest
from unittest import mock

from test_push_current_fixtures import (COMPLETE, FOREIGN, PushTestBase, crq,
                                        push_current)


class PushTest(PushTestBase, unittest.TestCase):
    def _reviewing_item_with_findings(self, finding):
        """Floor-init tick, enroll+launch tick, then terminal artifacts with findings."""
        self.repos[0] = self.cfg(floor=self.iso_of(self.ago(36)))
        self.commit(self.foreign_origin, "mid work", when=self.ago(2), files={"b.txt": "b\n"})
        self.assertEqual(self.tick(), 0)   # floor init
        self.assertEqual(self.tick(), 1)   # enroll + launch the push item
        self.q = crq.load_queue()
        item = self.the_item()
        self.assertEqual(item["state"], "reviewing")
        self.terminal_artifacts(item, [finding, COMPLETE])
        return item

    def test_pending_delivery_retries_rotate_within_the_cap(self):
        # A permanently failing delivery must not starve later ones: the cap
        # picks the least recently attempted items, never the same head forever.
        base_item = {"repo": FOREIGN, "kind": push_current.KIND, "pr": 0, "state": "done",
                     "subject": {"type": "push-range", "repo": FOREIGN}, "issue_pending": True}
        for item_id, stamp in (("push-infra-a0-b0", "2026-11-03T01:00:00Z"),
                               ("push-infra-a1-b1", "2026-11-03T02:00:00Z")):
            self.q["items"].append({**base_item, "id": item_id, "issue_attempt_at": stamp})
        never = {**base_item, "id": "push-infra-c0-d0"}
        self.q["items"].append(never)
        crq.save_queue(self.q)
        attempted = []
        with mock.patch.object(crq, "_deliver_push_findings",
                               side_effect=lambda q, i: attempted.append(i["id"])), \
             self.fake_spawn():
            self.tick()
        self.assertEqual(attempted, [never["id"], "push-infra-a0-b0"])

    def test_counted_findings_file_a_repo_issue_after_the_receipt(self):
        finding = {"type": "finding", "severity": "major", "path": "b.txt",
                   "blob": "0" * 40, "intervals": [[1, 2]], "title": "t", "body": "b"}
        item = self._reviewing_item_with_findings(finding)
        filed = {"issue_url": "https://github.com/camerontaylor/infra/issues/3",
                 "issue_number": 3, "created": True}
        with mock.patch.object(crq.finding_issues, "file_issue", return_value=filed) as file_issue:
            self.assertEqual(self.tick(), 0)   # harvests the counted review
        self.q = crq.load_queue()
        done = next(i for i in self.q["items"] if i["id"] == item["id"])
        self.assertEqual(done["state"], "done")
        self.assertEqual(done["issue"], filed)
        self.assertFalse(done.get("issue_pending"))
        meta = file_issue.call_args.kwargs["meta"]
        self.assertEqual(meta["repo"], FOREIGN)
        self.assertEqual(meta["base"], done["subject"]["base"])
        self.assertEqual(meta["head"], done["subject"]["head"])
        self.assertEqual(meta["receipt_id"], done["receipt_id"])
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], done["capture"]["target"])

    def test_gh_failure_keeps_the_review_terminal_and_the_delivery_pending(self):
        finding = {"type": "finding", "severity": "critical", "path": "b.txt",
                   "blob": "0" * 40, "intervals": [[1, 2]], "title": "t", "body": "b"}
        item = self._reviewing_item_with_findings(finding)
        target = item["capture"]["target"]
        with mock.patch.object(crq.finding_issues, "file_issue",
                               side_effect=RuntimeError("gh … exit 1: denied")):
            self.assertEqual(self.tick(), 0)   # harvest stays counted; delivery fails
        self.q = crq.load_queue()
        done = next(i for i in self.q["items"] if i["id"] == item["id"])
        self.assertEqual(done["state"], "done")  # the review stays terminal
        self.assertTrue(done["issue_pending"])
        self.assertIn("denied", done["issue_error"])
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], target)


if __name__ == "__main__":
    unittest.main()
