"""Multi-repo queue identity: legacy defaults, rank and status.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import json
import tempfile
from pathlib import Path
import unittest
from unittest import mock
import repo_registry
from test_crq_fixtures import (
    crq,
    setUpModule,
)

class MultiRepoIdentityTests(unittest.TestCase):
    """Per-repo item identity: legacy migration, rank tier, status carry (docs/multi-repo.md)."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "state"
        self.state.mkdir()
        self.queue_path = self.state / "queue.json"
        for name, value in (("STATE", self.state), ("RUNS", self.state / "runs"),
                            ("QUEUE", self.queue_path), ("EVENTS", self.state / "events.jsonl"),
                            ("WORK_RECORDS", self.state / "work.jsonl")):
            patch = mock.patch.object(crq, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.repos = repo_registry.parse({"repo": crq.REPO, "repos": [
            {"repo": "camerontaylor/infra", "clone": "/srv/crq/infra",
             "floor": "2026-11-10T00:00:00Z"}]})

    def write_legacy_queue(self):
        item = {"id": "pr12", "pr": 12, "kind": "open", "state": "done", "cycles": []}
        self.queue_path.write_text(json.dumps({"items": [item], "starts": [], "paused": False}))
        return item

    def test_legacy_items_default_to_primary_at_every_reader(self):
        self.write_legacy_queue()
        q = crq.load_queue()
        # Legacy items keep working without the field: no load-time or
        # save-time rewriting (exact queue equality is a tested contract);
        # every reader normalizes instead.
        self.assertNotIn("repo", q["items"][0])
        crq.save_queue(q)
        self.assertNotIn("repo", json.loads(self.queue_path.read_text())["items"][0])
        self.assertEqual(crq.item_repo(q["items"][0]), crq.REPO)
        self.assertEqual(crq.rank({"kind": "open"}), 0)
        with mock.patch.object(crq, "REPOS", self.repos), \
                mock.patch.object(crq.status_summary, "publish"), \
                mock.patch.object(crq.repair_tick, "digest", return_value={}):
            crq.write_status(q)
        data = json.loads((self.state / "status.json").read_text())
        self.assertEqual(data["items"][0]["repo"], crq.REPO)
        text = (self.state / "status.md").read_text()
        self.assertIn(f"| pr12 |  | open |", text)

    def test_foreign_repo_rank_sits_between_ordinary_and_backfill(self):
        with mock.patch.object(crq, "REPOS", self.repos):
            ordinary = crq.rank({"kind": "merged-current", "repo": crq.REPO})
            foreign = crq.rank({"kind": "push-current", "repo": "camerontaylor/infra"})
            backfill = crq.rank({"kind": "backfill", "repo": crq.REPO})
            self.assertLess(ordinary, foreign)
            self.assertLess(foreign, backfill)
            self.assertEqual(foreign, 3)
            # legacy items without a repo field keep their kind rank
            self.assertEqual(crq.rank({"kind": "open"}), 0)
            # optional additional cycles still wait behind every configured tier
            self.assertEqual(crq.rank({"kind": "open", "repo": "camerontaylor/infra",
                                       "optional_cycle": True, "cycles": [{}]}), 5)
            # selection order: primary open first, foreign before backfill
            q = {"items": [
                {"id": "b", "kind": "backfill", "repo": crq.REPO, "state": "pending", "order": 1},
                {"id": "f", "kind": "push-current", "repo": "camerontaylor/infra",
                 "state": "pending", "order": 2},
                {"id": "o", "kind": "open", "repo": crq.REPO, "state": "pending", "order": 3}]}
            self.assertEqual([i["id"] for i in sorted(q["items"], key=crq.sort_key)], ["o", "f", "b"])

    def test_write_status_carries_repo(self):
        rows = self.state / "backfill/findings/triage"
        rows.mkdir(parents=True)
        (rows / "bad.json").write_text("broken")
        self.write_legacy_queue()
        q = crq.load_queue()
        q["items"].append({"id": "push-infra-aaaa000000-bbbb000000", "repo": "camerontaylor/infra",
                           "pr": 0, "kind": "push-current", "state": "pending",
                           "cycles": [], "order": 2})
        with mock.patch.object(crq, "REPOS", self.repos), \
                mock.patch.object(crq.status_summary, "publish"), \
                mock.patch.object(crq.repair_tick, "digest", return_value={}):
            crq.write_status(q)
        text = (self.state / "status.md").read_text()
        self.assertIn("| push-infra-aaaa000000-bbbb000000 | camerontaylor/infra | push-current |", text)
        self.assertIn("repo camerontaylor/infra: 1 item(s) (1 pending, 0 reviewing, 0 blocked)", text)
        self.assertIn("push reviewed_tip uninitialized", text)
        self.assertIn("## Backfill finding triage", text)
        self.assertIn('"needs_human": []', text)
        data = json.loads((self.state / "status.json").read_text())
        self.assertEqual(data["finding_triage"]["counts"], {})
        self.assertFalse(data["finding_triage"]["counts_complete"])
        self.assertEqual(data["finding_triage"]["error_count"], 1)
        by_id = {i["id"]: i for i in data["items"]}
        self.assertEqual(by_id["push-infra-aaaa000000-bbbb000000"]["repo"], "camerontaylor/infra")
        self.assertEqual(by_id["pr12"]["repo"], crq.REPO)
