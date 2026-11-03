"""Shared fixture surface for the split backfill-runtime scheduler suite.

End-to-end offline scheduler, vendor artifact harvest and remote publication.
Every test runs against a real temporary git repository and a plain queue dict;
vendor, publisher and coverage effects are patched. One class copies the runner
process shape to prove no coverage work happens under ``tick.lock``.

Split provenance: apps/crq-python/test_backfill_runtime.py was split into
test_backfill_runtime_collector.py, test_backfill_runtime_admission.py,
test_backfill_runtime_observation.py, test_backfill_runtime_selection.py,
test_backfill_runtime_coverage.py, test_backfill_runtime_publish.py,
test_backfill_runtime_quota.py and test_backfill_runtime_events.py. This module
holds the shared repository/config/queue fixture bootstrap; it defines no tests.
"""
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import backfill_jobs as jobs
import backfill_runtime as runtime
import backfill_subjects as subjects
import review_ledger as ledger
from test_backfill_accounting import Fixture
from test_backfill_jobs import AT


class RuntimeTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.f = Fixture(self.root / "repo")
        self.t = self.f.commit({"a": b"one\ntwo\n"})
        self.state = self.root / "state"; self.state.mkdir()
        self.config = {"enabled": True, "durable_artifact_root": str(self.root / "durable"), "runner_identity": "crq-runner-app",
                       "operational_ruling": "offline-fixture", "no_live_run_verification": "fixture", "owner_branch_ruleset_evidence": "fixture",
                       "publisher_spool": {"ssh_alias": "publisher@127.0.0.1", "ssh_key": "/fixture/publisher-key"}}
        ledger.atomic(self.state / "backfill-rollout.json", ledger.canonical(self.config))
        self.policy = {"max_files": 8, "max_file_bytes": 262144, "max_total_bytes": 2097152,
                       "reviewer": {"verified": True, "evidence": "fixture", "max_files": 8, "max_diff_bytes": 2097152}}
        self.patch = mock.patch.object(runtime, "policies", return_value=({}, self.policy, {})); self.patch.start(); self.addCleanup(self.patch.stop)
        remote = self.root / "remote.git"
        subprocess.run(["git", "init", "--bare", "-q", str(remote)], capture_output=True, check=True)
        self.f.git("remote", "add", "origin", str(remote))
        tree = self.f.git("mktree", input=b"")
        genesis = self.f.git("commit-tree", tree, "-m", "Owner-created ledger")
        self.f.git("push", "origin", genesis + ":refs/heads/cq/review-ledger")
        scope = [{"path": "a", "blob": self.f.repo.entries(self.t)["a"]["blob"], "intervals": [[1, 2]]}]
        candidate = {"target": self.t, "kind": "B", "scope": scope, "scope_digest": ledger.digest(scope), "subject_id": "d" * 64,
                     "generation": 0, "prs": [], "tier": "T1", "family": "family", "partition": 0, "score": 2, "row": None,
                     "construction_policy_digest": "e" * 64}
        part = subjects.construct(self.f.repo, candidate, self.policy)["partitions"][0]
        self.q = {"items": [], "starts": []}; self.item = jobs.enqueue(self.q, part, AT)
        self.saved = []
        self.c = SimpleNamespace(STATE=self.state, CLONE=self.f.root, ROOT=self.root, iso=lambda: AT,
                                 save_queue=lambda q: self.saved.append(ledger.canonical(q)), ordinary_review_eligible=lambda q: False)
        self.c.SPOOL = SimpleNamespace(publish_ledger=lambda base, head, bundle:
                                      self.f.git("push", "origin", head + ":refs/heads/cq/review-ledger"))
        self.c.Spool = lambda config: self.c.SPOOL

    def refresh_snapshots(self):
        """What crq-publisher does off-lock before selection can admit."""
        import backfill_coverage
        self.c.load_queue = lambda: self.q
        _, _, _, reader = runtime.services(self.c, self.config)
        backfill_coverage.request(self.state, reader.fetch()[0], [self.t])
        return backfill_coverage.run(self.c)

    def snapshots(self, value=({}, [])):
        """Patch the snapshot reader; selection never runs coverage itself."""
        load = mock.Mock(return_value=value)
        patcher = mock.patch.object(runtime.coverage, "load", load)
        patcher.start(); self.addCleanup(patcher.stop)
        return load
