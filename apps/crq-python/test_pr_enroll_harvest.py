"""Counted foreign harvest: PR-review delivery (never coverage/repair), the debt
record and the bounded post-harvest upload, plus the legacy issue-request
fallback.

Split provenance: moved verbatim from apps/crq-python/test_pr_enroll.py.
Fixtures live in test_pr_enroll_fixtures.py.
"""
import unittest
from pathlib import Path
from unittest import mock

from test_pr_enroll_fixtures import COMPLETE, FOREIGN, PRIMARY, PrTestBase, crq


class PrTest(PrTestBase, unittest.TestCase):
    def test_counted_foreign_open_harvest_posts_review_without_coverage_or_repair(self):
        h1 = self.foreign_commit("pr work", {"a.txt": "a\n"})
        self.enroll([self.pr_row(5, h1)])
        item = self.q["items"][0]
        plan = crq.plan_open(item, self.pr_view(5, h1), False)
        self.launch(item, plan)
        self.assertEqual(item["state"], "reviewing")
        finding = {"type": "finding", "severity": "major", "fileName": "a.txt", "comment": "fix this"}
        self.terminal_artifacts(item, [finding, COMPLETE])
        posted = {"state": "created", "review_id": 3, "review_url": f"https://github.com/{FOREIGN}/pull/5#review-3"}
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False), \
             mock.patch.object(crq, "remove_worktree") as remove, \
             mock.patch.object(crq.repair_tick, "enqueue") as repair, \
             mock.patch.object(crq.coverage, "record_review") as record, \
             mock.patch.object(crq.finding_issues, "file_issue") as file_issue:
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
        self.assertEqual(item["pr_review_request"]["base"], self.base)
        self.assertEqual(item["pr_review_request"]["head"], h1)
        self.assertTrue(item["pr_review_pending"])
        self.assertNotIn("issue", item)
        self.assertEqual(file_issue.call_args, None)
        self.assertEqual(result, f"{item['id']}: completed (1 findings)")
        crq.save_queue(self.q)
        with self.fake_gh(), \
             mock.patch.object(crq.pr_review_findings, "deliver", return_value=posted) as deliver, \
             mock.patch.object(crq.finding_issues, "file_issue") as file_issue:
            _, _, log = self.tick()
            item = crq.load_queue()["items"][0]
        self.assertIn("findings review on PR #5 (created)", log)
        self.assertEqual(item["pr_review"], posted)
        self.assertFalse(item["pr_review_pending"])
        file_issue.assert_not_called()
        deliver.assert_called_once()
        repo, pr, meta, ndjson = deliver.call_args.args
        self.assertEqual((repo, pr, meta["base"], meta["head"]), (FOREIGN, 5, self.base, h1))
        self.assertEqual(ndjson.name, "review.ndjson")
        self.assertIn("pr_review_attempt_at", item)
        remove.assert_called_once()
        self.assertEqual(remove.call_args.kwargs["clone"], Path(self.foreign))

    def test_primary_case_variant_launch_and_harvest_uses_primary_policy(self):
        head = self.git(self.repo, "rev-parse", "HEAD")
        item = {"id": "case-pr5", "repo": PRIMARY.upper(), "kind": "open", "pr": 5,
                "state": "pending", "cycles": [], "tier": 1, "prior_cycles": 0}
        self.q["items"].append(item)
        plan = {"base": head, "head": head, "cycle": 1, "label": "review", "target": "main", "branch": "feature"}
        with mock.patch.object(crq, "secret_scan", return_value=(True, {})) as scan, \
             mock.patch.object(crq, "make_worktree", return_value=(self.root / "wt", "fixture")), \
             self.fake_spawn():
            crq.launch(self.q, item, plan)
        self.assertIsNone(scan.call_args.kwargs["clone"])
        self.assertIsNone(scan.call_args.kwargs["classes"])
        self.terminal_artifacts(item, [COMPLETE])
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False), \
             mock.patch.object(crq, "remove_worktree") as remove, \
             mock.patch.object(crq.repair_tick, "enqueue", return_value=False) as repair, \
             mock.patch.object(crq.coverage, "record_review", return_value={}) as record:
            crq.harvest_review(self.q, item, False)
        self.assertIsNone(remove.call_args.kwargs["clone"])
        record.assert_called_once()
        repair.assert_called_once()
        self.assertEqual(item["state"], "done")

    def test_unconfigured_foreign_launch_is_rejected(self):
        item = {"id": "unknown", "repo": "unknown/repo", "kind": "open"}
        with self.assertRaisesRegex(RuntimeError, "unconfigured repo"):
            crq.launch(self.q, item, {"base": "a", "head": "b"})

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
