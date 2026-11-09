"""Unchanged primary behavior: primary-only enrollment reads, no-op enrollment
without pr repos, and the repair guards that reject foreign items.

Split provenance: moved verbatim from apps/crq-python/test_pr_enroll.py.
Fixtures live in test_pr_enroll_fixtures.py.
"""
import unittest
from unittest import mock

from test_pr_enroll_fixtures import FOREIGN, PRIMARY, PrTestBase, crq, pr_enroll


class PrTest(PrTestBase, unittest.TestCase):
    def test_primary_enrollment_reads_only_primary_items(self):
        self.repos[0] = self.cfg()
        foreign_cycle = {"run_id": "foreign", "head": "f" * 40,
                         "completed_at": "2026-11-02T00:00:00Z"}
        self.q["items"].append({"id": "infra-pr7", "repo": FOREIGN, "kind": "open", "pr": 7,
                                "state": "done", "cycles": [foreign_cycle]})
        self.assertIsNone(crq.last_reviewed(self.q, 7))
        primary_cycle = {"run_id": "primary", "head": "a" * 40,
                         "completed_at": "2026-11-01T00:00:00Z"}
        self.q["items"].append({"id": "pr7", "kind": "open", "pr": 7,
                                "state": "done", "cycles": [primary_cycle]})
        self.assertEqual(crq.last_reviewed(self.q, 7), primary_cycle)

    def test_repair_enqueue_rejects_foreign_items_before_reading_findings(self):
        for kind in ("open", "delta", "push-current"):
            with self.subTest(kind=kind):
                item = {"id": "infra-pr7", "repo": FOREIGN, "kind": kind, "pr": 7}
                q = {"items": [item]}
                with mock.patch.object(crq.repair_tick, "findings") as findings, \
                     mock.patch.object(crq.repair_tick, "atomic") as atomic, \
                     mock.patch.object(crq, "git") as git:
                    self.assertFalse(crq.repair_tick.enqueue(crq, q, item, {}, self.root))
                findings.assert_not_called()
                atomic.assert_not_called()
                git.assert_not_called()
                self.assertEqual(item, {"id": "infra-pr7", "repo": FOREIGN, "kind": kind, "pr": 7})
                self.assertFalse((crq.STATE / "repair").exists())

    def test_primary_case_variant_is_seen_by_enrollment_and_repair(self):
        cycle = {"run_id": "primary", "head": "a" * 40, "completed_at": "2026-11-01T00:00:00Z", "findings": 1}
        item = {"id": "pr7", "repo": PRIMARY.upper(), "kind": "open", "pr": 7,
                "state": "done", "cycles": [cycle]}
        q = {"items": [item]}
        self.assertEqual(crq.last_reviewed(q, 7), cycle)
        with mock.patch.object(crq.repair_tick, "findings", return_value=[]) as findings:
            self.assertFalse(crq.repair_tick.enqueue(crq, q, item, {"run_id": "primary"}, self.root))
        findings.assert_called_once()
        crq.repair_tick.backfill(crq, q)
        self.assertEqual(q["legacy_repair_missing"], [{"item": "pr7", "run": "primary"}])

    def test_legacy_repair_backfill_ignores_foreign_cycles(self):
        q = {"items": [{"id": "push-infra-legacy", "repo": FOREIGN, "kind": "push-current",
                        "cycles": [{"run_id": "run-missing", "findings": 1}]}]}
        crq.repair_tick.backfill(crq, q)
        self.assertEqual(q.get("legacy_repair_missing"), [])
        self.assertTrue(q.get("legacy_repair_backfilled"))

    def test_primary_enrollment_unchanged_without_pr_repos(self):
        # An empty repos list (or no pr flag) keeps pr enrollment a no-op:
        # no forge read, no items, no log.
        with mock.patch.object(crq, "REPOS", []), \
             mock.patch.object(crq, "gh_json", side_effect=AssertionError("no forge call")) as gh:
            self.assertEqual(pr_enroll.enroll(crq, self.q, False), [])
        gh.assert_not_called()
        self.assertEqual(self.q["items"], [])
        self.repos[0] = self.cfg(discovery={"push": False, "pr": False})
        with mock.patch.object(crq, "gh_json", side_effect=AssertionError("no forge call")) as gh:
            self.assertEqual(pr_enroll.enroll(crq, self.q, False), [])
        gh.assert_not_called()
        # The primary repo's own enrollment keeps its exact item ids and shape.
        head = self.git(self.repo, "rev-parse", "HEAD")
        opened = [{"number": 42, "isDraft": False, "baseRefName": "main",
                   "headRefName": "fixture-42", "headRefOid": head}]
        with mock.patch.object(crq, "gh_json", return_value=opened):
            log = crq.enroll(self.q, False)
        item = self.q["items"][0]
        self.assertEqual(item["id"], "pr42")
        self.assertEqual(item["kind"], "open")
        self.assertEqual(item["tier"], 1)
        self.assertEqual(item["prior_cycles"], 0)
        self.assertNotIn("repo", item)
        self.assertEqual(crq.item_repo(item), PRIMARY)
        self.assertIn("enrolled pr42 (open PR not yet enrolled)", "\n".join(log))


if __name__ == "__main__":
    unittest.main()
