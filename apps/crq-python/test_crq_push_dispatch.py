"""Push lane: prepare-step dispatch and counted findings delivery.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import tempfile
from pathlib import Path
import unittest
from unittest import mock
import push_current
import repo_registry
from test_crq_fixtures import (
    crq,
    setUpModule,
)

class PushDispatchTest(unittest.TestCase):
    """start_one dispatches kind push-current through push_current.prepare (PR2);
    the rest of the push lane lives in test_push_current.py."""

    def test_start_one_dispatches_push_current_to_prepare(self):
        plan = {"base": "b" * 40, "head": "h" * 40, "target": "t" * 40, "review_pin": "t" * 40,
                "cycle": None, "branch": None, "label": "fixture push", "notes": []}
        item = {"id": "push-infra-aaaaaaaaa0-bbbbbbbbb0", "repo": "camerontaylor/infra",
                "kind": "push-current", "pr": 0, "state": "pending", "order": 1,
                "subject": {"type": "push-range", "repo": "camerontaylor/infra",
                            "base": "b" * 40, "head": "h" * 40,
                            "policy": "affected-current-additions-v1"},
                "cycles": [], "attempts": [], "failures": 0, "notes": []}
        q = {"items": [item], "starts": [], "paused": False}
        with mock.patch.object(push_current, "prepare", return_value=plan) as prepare, \
                mock.patch.object(crq, "launch") as launch, \
                mock.patch.object(crq.usage_slots, "read_usage", return_value=None):
            crq.start_one(q, [], False, None, False)
        prepare.assert_called_once()
        self.assertEqual(prepare.call_args.args, (crq, q, item, False))
        launch.assert_called_once_with(q, item, plan)
        # A dry run plans through the same seam and never launches.
        with mock.patch.object(push_current, "prepare", return_value=plan) as prepare, \
                mock.patch.object(crq, "launch") as launch:
            crq.start_one(q, [], True, None, False)
        prepare.assert_called_once()
        self.assertEqual(prepare.call_args.args, (crq, q, item, True))
        launch.assert_not_called()


class PushFindingsDeliveryTests(unittest.TestCase):
    """Findings-issue delivery for counted push reviews (docs/multi-repo.md)."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "state"
        self.state.mkdir()
        self.findings = Path(self.temp.name) / "findings.md"
        self.findings.write_text("# findings\n- major: x\n")
        for name, value in (("STATE", self.state), ("RUNS", self.state / "runs"),
                            ("EVENTS", self.state / "events.jsonl"), ("WORK_RECORDS", self.state / "work.jsonl")):
            patch = mock.patch.object(crq, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.repos = repo_registry.parse({"repo": crq.REPO, "repos": [
            {"repo": "camerontaylor/infra", "clone": "/srv/crq/infra"},
            {"repo": "camerontaylor/hart", "clone": "/srv/crq/hart", "findings": "none"}]})
        self.item = {"id": "push-infra-a-b", "repo": "camerontaylor/infra", "kind": "push-current",
                     "pr": 0, "state": "done", "cycles": [],
                     "subject": {"type": "push-range", "repo": "camerontaylor/infra",
                                 "base": "a" * 40, "head": "b" * 40},
                     "receipt_id": "r" * 64, "issue_pending": True,
                     "issue_request": {"run_id": "run-1", "severity_counts": {"major": 1},
                                       "findings_md": str(self.findings),
                                       "base": "a" * 40, "head": "b" * 40}}

    def deliver(self):
        with mock.patch.object(crq, "REPOS", self.repos):
            return crq._deliver_push_findings({"items": []}, self.item)

    def test_counted_findings_file_one_issue_and_never_refile(self):
        filed = {"issue_url": "https://github.com/camerontaylor/infra/issues/7",
                 "issue_number": 7, "created": True}
        with mock.patch.object(crq.finding_issues, "file_issue", return_value=filed) as file_issue:
            self.assertIn("findings issue #7 (created)", self.deliver())
            # the configured repo, the pinned range, and the identity meta
            self.assertEqual(file_issue.call_args.args[0]["repo"], "camerontaylor/infra")
            self.assertEqual((file_issue.call_args.kwargs["base"], file_issue.call_args.kwargs["head"]),
                             ("a" * 40, "b" * 40))
            self.assertEqual(file_issue.call_args.kwargs["meta"]["run_id"], "run-1")
        self.assertEqual(self.item["issue"], filed)
        self.assertFalse(self.item["issue_pending"])
        with mock.patch.object(crq.finding_issues, "file_issue") as again:
            self.assertIsNone(self.deliver())
            again.assert_not_called()

    def test_delivery_failure_is_recorded_and_retried(self):
        with mock.patch.object(crq.finding_issues, "file_issue",
                               side_effect=RuntimeError("gh issue create … exit 1: refused")):
            self.assertIsNone(self.deliver())
        self.assertIn("refused", self.item["issue_error"])
        self.assertTrue(self.item["issue_pending"])
        ok = {"issue_url": "u", "issue_number": 9, "created": False}
        with mock.patch.object(crq.finding_issues, "file_issue", return_value=ok):
            self.assertIn("findings issue #9 (existing)", self.deliver())
        self.assertNotIn("issue_error", self.item)
        self.assertFalse(self.item["issue_pending"])

    def test_disabled_findings_mode_is_not_debt(self):
        self.item["repo"] = "camerontaylor/hart"
        self.item["subject"]["repo"] = "camerontaylor/hart"
        with mock.patch.object(crq.finding_issues, "file_issue") as file_issue:
            self.assertIsNone(self.deliver())
            file_issue.assert_not_called()
        self.assertFalse(self.item["issue_pending"])

    def test_missing_markdown_keeps_the_retry_debt(self):
        self.item["issue_request"]["findings_md"] = str(self.state / "gone.md")
        self.assertIsNone(self.deliver())
        self.assertIn("findings markdown unavailable", self.item["issue_error"])
        self.assertTrue(self.item["issue_pending"])
