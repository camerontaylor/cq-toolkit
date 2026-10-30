"""End-to-end offline scheduler, vendor artifact harvest and remote publication."""
import copy
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import backfill_jobs as jobs
import backfill_runtime as runtime
import backfill_subjects as subjects
import review_ledger as ledger
from test_backfill_accounting import Fixture
from test_backfill_jobs import AT


class RuntimeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.f = Fixture(self.root / "repo")
        self.t = self.f.commit({"a": b"one\ntwo\n"})
        self.state = self.root / "state"; self.state.mkdir()
        self.config = {"enabled": True, "durable_artifact_root": str(self.root / "durable"), "runner_identity": "crq-runner-app",
                       "operational_ruling": "offline-fixture", "no_live_run_verification": "fixture", "owner_branch_ruleset_evidence": "fixture"}
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

    def test_missing_rollout_and_unknown_deployed_limits_never_enable_dispatch(self):
        self.assertIsNone(runtime.settings(self.root / "absent", dispatch=True))
        self.policy["reviewer"]["verified"] = False
        with self.assertRaises(ledger.IntegrityError):
            runtime.settings(self.state, dispatch=True)

    def test_select_reuses_coverage_only_within_one_ledger_snapshot(self):
        first = copy.deepcopy(self.item)
        second = copy.deepcopy(self.item); second["id"] += "-second"
        third = copy.deepcopy(self.item); third["id"] += "-third"; third["target"] = "c" * 40
        self.q["items"] = [first, second, third]
        repo = SimpleNamespace(coverage=mock.Mock(return_value=({}, [], [])))
        publisher = SimpleNamespace(fetch=mock.Mock(side_effect=[("head1", ["first"]), ("head2", ["second"])]))
        with mock.patch.object(runtime, "services", return_value=(repo, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", return_value=True), \
             mock.patch.object(runtime, "rank4_gate", return_value=False):
            runtime.select(self.c, self.q, [], False, None)
            self.assertEqual(repo.coverage.call_count, 2)
            runtime.select(self.c, self.q, [], False, None)
        self.assertEqual(repo.coverage.call_count, 4)
        self.assertEqual([call.args[1] for call in repo.coverage.call_args_list], [["first"], ["first"], ["second"], ["second"]])

    def test_acknowledged_state_event_replay_preserves_identity_after_queue_cache_loss(self):
        runtime.state_event(self.c, self.q, self.item, AT, "created")
        _, _, out, _ = runtime.services(self.c, self.config)
        original = out.pending()[0]
        out.acknowledge(original, {original["id"]})
        self.q.pop("backfill_state_events")
        runtime.state_event(self.c, self.q, self.item, "2026-10-30T01:00:00Z", "created")
        self.assertEqual(out.retained(), [original])
        self.assertFalse(out.pending())

    def test_vendor_progress_alone_does_not_prove_usage_reflection_and_terminal_window_expires(self):
        jobs.admission(self.q, self.item, AT, {"successful": True, "remaining": 2, "observed_at": AT}, False)
        self.item["run"] = {"started_at": AT, "vendor_observed": True}
        runtime.usage_context(self.c, self.q, {"remaining": 2}, [])
        self.assertEqual(self.q["backfill_usage"]["reflected_reservations"], [])
        jobs.terminal(self.q, self.item, AT, "error", vendor_terminal=True)
        self.c.iso = lambda: "2026-10-30T01:00:00Z"
        runtime.usage_context(self.c, self.q, {"remaining": 8, "rollingWindowMs": 3600000}, [])
        self.assertEqual(self.q["backfill_reservations"][self.item["attempt_id"]]["quota_state"], "expired")

    def test_harvest_accepts_blank_lines_and_float_only_in_vendor_metadata(self):
        jobs.admission(self.q, self.item, AT, {"successful": True, "remaining": 2, "observed_at": AT}, False)
        self.item.update(state="reviewing", run={"run_id": "vendor-meta", "started_at": AT})
        rdir = self.root / "run-meta"; rdir.mkdir()
        terminal = ledger.canonical({"type": "complete", "status": "review_completed", "head": self.item["head"], "reviewedFiles": self.item["scope"]})
        (rdir / "review.ndjson").write_bytes(b'{"type":"heartbeat","duration":1.5}\n\n' + terminal + b'\n')
        (rdir / "exit.json").write_bytes(ledger.canonical({"exit": 0, "ended_at": AT}))
        runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": "vendor-meta", "head": self.item["head"]}, {"counted": True, "outcome": "completed"}, 0)
        self.assertEqual(self.item["state"], "publication-pending")

    def test_verified_quota_refusals_keep_prior_failures_and_reservations(self):
        import crq
        self.c.classify = crq.classify
        self.c.set_rate_cooldown = crq.set_rate_cooldown
        self.item["failures"] = 2
        histories = jobs.history(self.q, self.item)
        for entry in histories:
            entry.update(failures=2, next_eligible_at="2026-10-30T02:00:00Z")
        raw = b'{"type":"error","errorType":"rate_limit","recoverable":true,"metadata":{"waitTime":"30 minutes"}}\n'
        for index, at in enumerate((AT, "2026-10-30T03:00:00Z")):
            self.c.iso = lambda at=at: at
            decision = jobs.admission(self.q, self.item, at, {"successful": True, "remaining": 8, "observed_at": at}, False)
            self.assertEqual(decision["decision"], "admit")
            run = "quota-" + str(index)
            jobs.bind_run(self.q, self.item, run)
            self.item["run"] = {"run_id": run, "started_at": at}
            rdir = self.root / run; rdir.mkdir()
            (rdir / "review.ndjson").write_bytes(raw)
            (rdir / "exit.json").write_bytes(ledger.canonical({"exit": 1, "ended_at": at}))
            classification = crq.classify(rdir / "review.ndjson", 1)
            if index == 0:
                result = runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": run, "head": self.item["head"]}, classification, 1)
                self.assertIn("retain run ownership", result)
                self.assertTrue(jobs.is_execution_owner(self.item))
            runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": run, "head": self.item["head"]}, classification, 1, terminal_verified=True)
            self.assertEqual(self.item["state"], "pending")
            self.assertEqual(self.item["failures"], 2)
            self.assertTrue(all(entry["failures"] == 2 and not entry["quarantined"] for entry in histories))
            self.assertFalse(jobs.eligible(self.q, self.item, at))
            self.assertEqual(self.q["backfill_reservations"][self.item["attempt_id"]]["quota_state"], "reserved")
            self.assertNotIn("publication_event_id", self.item)
            self.c.launch = mock.Mock()
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
            self.c.launch.assert_not_called()
        self.assertEqual(len(self.q["backfill_reservations"]), 2)
        self.assertEqual(histories[0]["next_eligible_at"], "2026-10-30T03:30:00Z")

    def test_unverified_quota_label_retains_bound_run(self):
        self.c.classify = lambda path, code: {"outcome": "error", "failure_provenance": {"complete": False, "causes": []}}
        jobs.admission(self.q, self.item, AT, {"successful": True, "remaining": 8, "observed_at": AT}, False)
        jobs.bind_run(self.q, self.item, "run-mixed")
        self.item["run"] = {"run_id": "run-mixed", "started_at": AT}
        rdir = self.root / "run-mixed"; rdir.mkdir()
        (rdir / "review.ndjson").write_bytes(b'{"type":"error","errorType":"auth"}\n')
        (rdir / "exit.json").write_bytes(ledger.canonical({"exit": 1, "ended_at": AT}))
        result = runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": "run-mixed"}, {"counted": False, "outcome": "rate_limited"}, 1)
        self.assertIn("retain run ownership", result)
        self.assertTrue(jobs.is_execution_owner(self.item))

    def test_mixed_quota_and_hard_cause_keeps_bound_run(self):
        import crq
        jobs.admission(self.q, self.item, AT, {"successful": True, "remaining": 8, "observed_at": AT}, False)
        jobs.bind_run(self.q, self.item, "run-mixed")
        self.item["run"] = {"run_id": "run-mixed", "started_at": AT}
        rdir = self.root / "run-mixed"; rdir.mkdir()
        raw = b'{"type":"error","errorType":"rate_limit","recoverable":true}\n{"type":"error","errorType":"auth"}\n'
        (rdir / "review.ndjson").write_bytes(raw)
        (rdir / "exit.json").write_bytes(ledger.canonical({"exit": 1, "ended_at": AT}))
        result = runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": "run-mixed"}, crq.classify(rdir / "review.ndjson", 1), 1)
        self.assertIn("mixed quota", result)
        self.assertTrue(jobs.is_execution_owner(self.item))
        self.assertEqual(self.item["failures"], 0)

    def test_select_harvest_crash_replay_publish_and_lost_coverage_cache(self):
        runtime.usage_context(self.c, self.q, {"remaining": 2}, [])
        self.q["backfill_starts_at_observation"] = 0
        launches = []
        def launch(queue, item, plan):
            launches.append(plan)
            item.update(state="reviewing", run={"run_id": "vendor-1", "started_at": AT})
            queue["starts"].append(AT)
            return "vendor-1"
        self.c.launch = launch
        started, available = runtime.select(self.c, self.q, [], False, None)
        self.assertEqual(started, "vendor-1"); self.assertTrue(available)
        raw = ledger.canonical({"type": "complete", "status": "review_completed", "head": self.item["head"], "reviewedFiles": self.item["scope"]})
        rdir = self.root / "run"; rdir.mkdir()
        (rdir / "review.ndjson").write_bytes(raw)
        (rdir / "exit.json").write_bytes(ledger.canonical({"exit": 0, "ended_at": AT}))
        meta = {"run_id": "vendor-1", "head": self.item["head"]}
        cls = {"counted": True, "outcome": "completed"}
        # Crash after vendor completion before durable spool: run remains owned.
        original = copy.deepcopy(self.item)
        with mock.patch.object(ledger.Outbox, "spool", side_effect=OSError("spool interrupted")):
            with self.assertRaises(OSError):
                runtime.harvest(self.c, self.q, self.item, rdir, meta, cls, 0)
        self.assertEqual(self.item, original)
        runtime.harvest(self.c, self.q, self.item, rdir, meta, cls, 0)
        self.assertEqual(self.item["state"], "publication-pending")
        self.assertFalse(jobs.is_execution_owner(self.item))
        runtime.publish(self.c, self.q)
        self.assertEqual(self.item["state"], "done")
        repo, store, _, publisher = runtime.services(self.c, self.config)
        head, records = publisher.fetch()
        covered, evidence, gaps = repo.coverage(self.t, records, store)
        self.assertEqual(covered, {"a": {1, 2}}); self.assertFalse(gaps)
        self.assertEqual(len(launches), 1)

    def test_publication_error_after_bound_launch_remains_harvestable(self):
        runtime.usage_context(self.c, self.q, {"remaining": 2}, [])
        self.q["backfill_starts_at_observation"] = 0
        launches = []
        def launch(queue, item, plan):
            launches.append(plan)
            item.update(state="reviewing", run={"run_id": "vendor-1", "started_at": AT})
            queue["starts"].append(AT)
            return "vendor-1"
        self.c.launch = launch
        original_event = runtime.state_event
        def failing_event(c, queue, item, at, reason):
            if reason == "vendor identity bound":
                raise OSError("publication unavailable")
            return original_event(c, queue, item, at, reason)
        with mock.patch.object(runtime, "state_event", side_effect=failing_event):
            with self.assertRaisesRegex(OSError, "publication unavailable"):
                runtime.select(self.c, self.q, [], False, None)
        self.assertEqual(self.item["state"], "reviewing")
        self.assertEqual(self.item["vendor_state"], "live")
        self.assertEqual(self.item["run"]["run_id"], "vendor-1")
        self.assertTrue(jobs.is_execution_owner(self.item))
        runtime.select(self.c, self.q, [], False, None)
        self.assertEqual(len(launches), 1)
        rdir = self.root / "run"; rdir.mkdir()
        raw = ledger.canonical({"type": "complete", "status": "review_completed", "head": self.item["head"], "reviewedFiles": self.item["scope"]})
        (rdir / "review.ndjson").write_bytes(raw)
        (rdir / "exit.json").write_bytes(ledger.canonical({"exit": 0, "ended_at": AT}))
        runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": "vendor-1", "head": self.item["head"]}, {"counted": True, "outcome": "completed"}, 0)
        self.assertEqual(self.item["state"], "publication-pending")

    def test_exception_before_run_binding_still_holds_unknown_launch(self):
        runtime.usage_context(self.c, self.q, {"remaining": 2}, [])
        self.q["backfill_starts_at_observation"] = 0
        self.c.launch = mock.Mock(side_effect=OSError("launch outcome unknown"))
        with self.assertRaisesRegex(OSError, "launch outcome unknown"):
            runtime.select(self.c, self.q, [], False, None)
        self.assertEqual(self.item["state"], "launch-unknown")
        self.assertEqual(self.item["vendor_state"], "unknown")
        self.assertTrue(jobs.is_execution_owner(self.item))
        runtime.select(self.c, self.q, [], False, None)
        self.c.launch.assert_called_once()

    def test_completed_path_only_vendor_output_is_visible_unverified_debt(self):
        self.item.update(attempt_id="attempt-1", run={"run_id": "vendor-1"}, state="reviewing", vendor_state="live")
        rdir = self.root / "run"; rdir.mkdir()
        (rdir / "review.ndjson").write_bytes(ledger.canonical({"type": "complete", "status": "review_completed", "head": self.item["head"], "reviewedFiles": ["a"]}))
        (rdir / "exit.json").write_bytes(ledger.canonical({"exit": 0, "ended_at": AT}))
        result = runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": "vendor-1"}, {"counted": True, "outcome": "completed"}, 0)
        self.assertIn("unverified", result)
        self.assertEqual(self.item["state"], "quarantined")
        self.assertFalse(jobs.is_execution_owner(self.item))


if __name__ == "__main__":
    unittest.main()
