"""Counted foreign harvest: issue delivery (never coverage/repair), the debt
record and the bounded post-harvest upload, plus the legacy issue-request
fallback.

Split provenance: moved verbatim from apps/crq-python/test_pr_enroll.py.
Fixtures live in test_pr_enroll_fixtures.py.
"""
import unittest
from pathlib import Path
from unittest import mock

from test_pr_enroll_fixtures import COMPLETE, FOREIGN, PrTestBase, crq


class PrTest(PrTestBase, unittest.TestCase):
    def test_counted_foreign_open_harvest_files_issue_without_coverage_or_repair(self):
        h1 = self.foreign_commit("pr work", {"a.txt": "a\n"})
        self.enroll([self.pr_row(5, h1)])
        item = self.q["items"][0]
        plan = crq.plan_open(item, self.pr_view(5, h1), False)
        self.launch(item, plan)
        self.assertEqual(item["state"], "reviewing")
        finding = {"type": "finding", "severity": "major", "fileName": "a.txt", "comment": "fix this"}
        self.terminal_artifacts(item, [finding, COMPLETE])
        filed = {"issue_url": f"https://github.com/{FOREIGN}/issues/3", "issue_number": 3, "created": True}
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False), \
             mock.patch.object(crq, "remove_worktree") as remove, \
             mock.patch.object(crq.repair_tick, "enqueue") as repair, \
             mock.patch.object(crq.coverage, "record_review") as record, \
             mock.patch.object(crq.finding_issues, "file_issue", return_value=filed) as file_issue:
            result = crq.harvest_review(self.q, item, False)
        # NO cq coverage and NO repair enqueue for a foreign open review.
        repair.assert_not_called()
        record.assert_not_called()
        self.assertEqual(item["state"], "done")
        self.assertEqual(len(item["cycles"]), 1)
        cycle = item["cycles"][0]
        self.assertEqual((cycle["base"], cycle["head"]), (self.base, h1))
        self.assertEqual(cycle["range_policy"], "full-range-once-v1")
        # Debt only at harvest: the bounded post-harvest pass performs the upload.
        self.assertEqual(item["issue_request"]["base"], self.base)
        self.assertEqual(item["issue_request"]["head"], h1)
        self.assertTrue(item["issue_pending"])
        self.assertNotIn("issue", item)
        self.assertEqual(file_issue.call_args, None)
        self.assertEqual(result, f"{item['id']}: completed (1 findings)")
        crq.save_queue(self.q)
        with self.fake_gh(), \
             mock.patch.object(crq.finding_issues, "file_issue", return_value=filed) as file_issue:
            _, _, log = self.tick()
            item = crq.load_queue()["items"][0]
        self.assertEqual([message for message in log if message.startswith("findings issue")],
                         ["findings issue #3 (created)"])
        self.assertEqual(item["issue"], filed)
        self.assertFalse(item["issue_pending"])
        file_issue.assert_called_once()
        self.assertIn("issue_attempt_at", item)
        self.assertEqual(file_issue.call_args.kwargs["base"], self.base)
        self.assertEqual(file_issue.call_args.kwargs["head"], h1)
        self.assertEqual(file_issue.call_args.kwargs["meta"]["repo"], FOREIGN)
        self.assertEqual(file_issue.call_args.kwargs["meta"]["base"], self.base)
        remove.assert_called_once()
        self.assertEqual(remove.call_args.kwargs["clone"], Path(self.foreign))

    def test_legacy_issue_request_without_range_falls_back_to_the_subject(self):
        (self.root / "findings.md").write_text("- finding\n")
        item = {"id": "push-infra-legacy", "repo": FOREIGN, "kind": "push-current",
                "state": "done", "issue_pending": True,
                "subject": {"type": "push-range", "repo": FOREIGN, "base": "b" * 40, "head": "h" * 40},
                "issue_request": {"run_id": "r-legacy", "severity_counts": {"major": 1},
                                  "findings_md": str(self.root / "findings.md")}}
        filed = {"issue_url": f"https://github.com/{FOREIGN}/issues/9",
                 "issue_number": 9, "created": True}
        with mock.patch.object(crq.finding_issues, "file_issue", return_value=filed) as file_issue:
            self.assertEqual(crq._deliver_push_findings(self.q, item), "findings issue #9 (created)")
        self.assertEqual(file_issue.call_args.kwargs["base"], "b" * 40)
        self.assertEqual(file_issue.call_args.kwargs["head"], "h" * 40)


if __name__ == "__main__":
    unittest.main()
