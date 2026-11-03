"""End-to-end offline scheduler, vendor artifact harvest and remote publication."""
import collections
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
    def test_required_collector_rejects_ambiguous_rename_as_deletion(self):
        self.f.commit({"unrelated": b"before\n"})
        merge = self.f.commit({"old": b"same\n"})
        target = self.f.commit({"old": None, "copy-one": b"same\n", "copy-two": b"same\n"})
        original = subprocess.run
        response = ledger.canonical({"number": 7, "merged": True, "merge_commit_sha": merge})
        def offline(command, *args, **kwargs):
            return SimpleNamespace(stdout=response) if command[0] == "gh" else original(command, *args, **kwargs)
        with mock.patch.object(runtime.subprocess, "run", side_effect=offline):
            paths, _ = runtime.collect_required(self.f.repo, target, {"rows": [{"pr": 7}]}, self.f.store)
        self.assertEqual(paths["7"][0]["disposition"], "ambiguous")
        self.assertNotIn("deletion_evidence", paths["7"][0])

    def test_required_collector_proves_deletion_in_required_pr(self):
        self.f.commit({"old": b"unique\n", "unrelated": b"before\n"})
        merge = self.f.commit({"old": None})
        target = self.f.commit({"unrelated": b"after\n"})
        original = subprocess.run
        response = ledger.canonical({"number": 7, "merged": True, "merge_commit_sha": merge})
        def offline(command, *args, **kwargs):
            return SimpleNamespace(stdout=response) if command[0] == "gh" else original(command, *args, **kwargs)
        with mock.patch.object(runtime.subprocess, "run", side_effect=offline):
            paths, _ = runtime.collect_required(self.f.repo, target, {"rows": [{"pr": 7}]}, self.f.store)
        self.assertEqual(paths["7"][0]["disposition"], "deleted")

    def test_required_collector_proves_deletion_with_unrelated_edit(self):
        self.f.commit({"unrelated": b"before\n"})
        merge = self.f.commit({"old": b"unique\n"})
        target = self.f.commit({"old": None, "unrelated": b"after\n"})
        original = subprocess.run
        response = ledger.canonical({"number": 7, "merged": True, "merge_commit_sha": merge})
        def offline(command, *args, **kwargs):
            return SimpleNamespace(stdout=response) if command[0] == "gh" else original(command, *args, **kwargs)
        with mock.patch.object(runtime.subprocess, "run", side_effect=offline):
            paths, _ = runtime.collect_required(self.f.repo, target, {"rows": [{"pr": 7}]}, self.f.store)
        self.assertEqual(paths["7"][0]["disposition"], "deleted")

    def test_modified_rename_is_not_proven_deletion(self):
        old = self.f.commit({"old": b"one\ntwo\nthree\nfour\nfive\n"})
        target = self.f.commit({"old": None, "new": b"one\ntwo\nthree\nfour\nchanged\n"})
        self.assertFalse(self.f.repo.proven_deleted(old, target, "old"))

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

    def test_missing_rollout_and_unknown_deployed_limits_never_enable_dispatch(self):
        self.assertIsNone(runtime.settings(self.root / "absent", dispatch=True))
        self.policy["reviewer"]["verified"] = False
        with self.assertRaises(ledger.IntegrityError):
            runtime.settings(self.state, dispatch=True)

    def test_malformed_publisher_transport_refuses_before_dispatch(self):
        for spool in ("truthy", ["truthy"], {"ssh_alias": "publisher@127.0.0.1"},
                      {"ssh_alias": "bad host", "ssh_key": "/fixture/key"},
                      {"ssh_alias": "publisher@127.0.0.1", "ssh_key": "\n"},
                      {"ssh_alias": "publisher@127.0.0.1", "ssh_key": "/fixture/key", "legacy_shell": True}):
            with self.subTest(spool=spool):
                ledger.atomic(self.state / "backfill-rollout.json", ledger.canonical({**self.config, "publisher_spool": spool}))
                with self.assertRaisesRegex(ledger.IntegrityError, "publisher_spool"):
                    runtime.settings(self.state, dispatch=True)

    def test_slow_selection_reprobes_usage_instead_of_refusing_as_stale(self):
        # The tick's usage read precedes ordinary selection, ledger fetch and coverage.
        self.q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": "2026-10-29T23:45:00Z",
                                    "reflected_reservations": []}
        def refresh(q):
            q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": AT, "reflected_reservations": []}
            q["backfill_starts_at_observation"] = len(q["starts"])
            return True
        self.c.refresh_backfill_usage = mock.Mock(side_effect=refresh)
        self.assertTrue(runtime.rank4_gate(self.c, self.q, self.item, dry=True))
        self.c.refresh_backfill_usage.assert_called_once_with(self.q)
        self.assertEqual(self.q["backfill_admissions"][-1]["decision"], "admit")

    def test_failed_reprobe_keeps_minutes_old_observation_and_probes_once_per_minute(self):
        self.c.refresh_backfill_usage = mock.Mock(return_value=False)
        self.q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": "2026-10-29T23:58:00Z",
                                    "reflected_reservations": []}
        self.assertTrue(runtime.rank4_gate(self.c, self.q, self.item, dry=True))  # failed probe; 2-minute reading admits
        self.assertEqual(self.c.refresh_backfill_usage.call_count, 1)
        self.q["backfill_usage"]["observed_at"] = "2026-10-29T23:45:00Z"
        self.assertFalse(runtime.rank4_gate(self.c, self.q, self.item, dry=True))
        self.assertEqual(self.item["wait_reason"], "usage-stale-or-invalid")
        self.assertFalse(runtime.rank4_gate(self.c, self.q, self.item, dry=True))
        self.assertEqual(self.c.refresh_backfill_usage.call_count, 1)  # later gates reuse the failed attempt
        self.c.iso = lambda: "2026-10-30T00:01:01Z"
        runtime.rank4_gate(self.c, self.q, self.item, dry=True)
        self.assertEqual(self.c.refresh_backfill_usage.call_count, 2)
        self.c.iso = lambda: "2026-10-30T00:03:00Z"
        self.c.ordinary_review_eligible = lambda q: True
        self.assertFalse(runtime.rank4_gate(self.c, self.q, self.item, dry=True))
        self.assertEqual(self.item["wait_reason"], "ordinary-eligible")
        self.assertEqual(self.c.refresh_backfill_usage.call_count, 2)

    def test_unreadable_observation_with_failed_reprobe_refuses_without_raising(self):
        jobs.admission(self.q, self.item, AT, {"successful": True, "remaining": 8, "observed_at": AT}, False)
        other = copy.deepcopy(self.item); other.update(id=self.item["id"] + "-other", state="pending")
        self.c.refresh_backfill_usage = mock.Mock(return_value=False)
        for observed_at in (None, "garbage"):
            self.q["backfill_usage"] = {"successful": True, "remaining": 8, "observed_at": observed_at, "reflected_reservations": []}
            self.q.pop("backfill_usage_probe_at", None)
            self.assertFalse(runtime.rank4_gate(self.c, self.q, other, dry=True))
            self.assertEqual(other["wait_reason"], "usage-stale-or-invalid")
        for corrupt in ("observed_at", "remaining"):
            self.q["backfill_usage"] = {"successful": True, "remaining": 8, "observed_at": AT, "reflected_reservations": []}
            del self.q["backfill_usage"][corrupt]
            self.q.pop("backfill_usage_probe_at", None)
            other.pop("wait_reason", None)
            self.assertFalse(runtime.rank4_gate(self.c, self.q, other, dry=True))
            self.assertEqual(other["wait_reason"], "usage-stale-or-invalid")

    def test_unreadable_observation_time_reprobes(self):
        self.q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": "garbage", "reflected_reservations": []}
        def refresh(q):
            q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": AT, "reflected_reservations": []}
        self.c.refresh_backfill_usage = mock.Mock(side_effect=refresh)
        self.assertTrue(runtime.rank4_gate(self.c, self.q, self.item, dry=True))
        self.c.refresh_backfill_usage.assert_called_once_with(self.q)

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

    def test_select_records_one_refusal_for_all_pending_jobs(self):
        items = []
        for n in range(4):
            job = copy.deepcopy(self.item); job["id"] += "-" + str(n); items.append(job)
        self.q["items"] = items
        self.q["backfill_usage"] = {"successful": True, "remaining": 1, "observed_at": AT, "reflected_reservations": []}
        load = self.snapshots()
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head", [])))
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", return_value=True):
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, True))
        self.assertEqual(len(self.q["backfill_admissions"]), 1)
        self.assertEqual({job["wait_reason"] for job in items}, {"one-slot-reserve"})
        self.assertEqual(load.call_count, 1)  # first pass reads the one shared target once
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", return_value=True):
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, True))
        # Same head and job set: a refusal skips the snapshot pass entirely.
        self.assertEqual(load.call_count, 1)
        self.assertEqual(len(self.q["backfill_admissions"]), 2)

    def test_refusal_still_marks_jobs_done_when_ledger_head_or_jobs_change(self):
        job = copy.deepcopy(self.item); self.q["items"] = [job]
        self.q["backfill_usage"] = {"successful": True, "remaining": 1, "observed_at": AT, "reflected_reservations": []}
        load = self.snapshots()
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head1", [])))
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", side_effect=lambda q, item, at: item["state"] == "pending"):
            runtime.select(self.c, self.q, [], False, None)
            self.assertEqual(job["state"], "pending")
            full = {r["path"]: ledger.intervals(r["intervals"]) for r in job["scope"]}
            load.return_value = (full, [])
            publisher.fetch.return_value = ("head2", [])  # publication covered the job
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
            self.assertEqual(job["state"], "done")
            added = copy.deepcopy(self.item); added["id"] += "-added"; self.q["items"].append(added)
            runtime.select(self.c, self.q, [], False, None)  # a new job is reconciled under the same head
            self.assertEqual(added["state"], "done")
            calls = load.call_count
            # Nothing dispatchable remains: an unchanged refusal pass reports no candidate.
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
            self.assertEqual(load.call_count, calls)

    def test_refusal_reconciles_when_a_job_becomes_eligible_and_ignores_selective_starts(self):
        first = copy.deepcopy(self.item); second = copy.deepcopy(self.item); second["id"] += "-later"
        self.q["items"] = [first, second]
        self.q["backfill_usage"] = {"successful": True, "remaining": 1, "observed_at": AT, "reflected_reservations": []}
        load = self.snapshots()
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head", [])))
        backoff = {second["id"]}
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", side_effect=lambda q, item, at: item["state"] == "pending" and item["id"] not in backoff):
            runtime.select(self.c, self.q, [], False, None)
            recorded = self.q["backfill_coverage_reconciled"]
            runtime.select(self.c, self.q, [], False, first["id"])  # selective start: record untouched
            self.assertEqual(self.q["backfill_coverage_reconciled"], recorded)
            calls = load.call_count
            backoff.clear()  # the backoff expired under the same head and job set
            full = {r["path"]: ledger.intervals(r["intervals"]) for r in second["scope"]}
            load.return_value = (full, [])
            runtime.select(self.c, self.q, [], False, None)
        self.assertGreater(load.call_count, calls)
        self.assertEqual(second["state"], "done")

    def test_job_eligible_only_after_the_loop_passed_it_forces_a_full_pass(self):
        first = copy.deepcopy(self.item); second = copy.deepcopy(self.item); second["id"] += "-mid"
        self.q["items"] = [first, second]
        self.q["backfill_usage"] = {"successful": True, "remaining": 1, "observed_at": AT, "reflected_reservations": []}
        load = self.snapshots()
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head", [])))
        checks = {"n": 0}
        def eligible(q, item, at):
            if item["id"] != second["id"]:
                return True
            checks["n"] += 1
            return checks["n"] > 2  # ineligible for pending and the loop; its backoff expires afterwards
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", side_effect=eligible):
            runtime.select(self.c, self.q, [], False, None)
            calls = load.call_count
            runtime.select(self.c, self.q, [], False, None)
        self.assertGreater(load.call_count, calls)  # not skipped: the eligible set changed
        self.assertEqual(second["wait_reason"], "one-slot-reserve")

    def test_refusal_keeps_missing_evidence_reason(self):
        job = copy.deepcopy(self.item); self.q["items"] = [job]
        self.q["backfill_usage"] = {"successful": True, "remaining": 1, "observed_at": AT, "reflected_reservations": []}
        load = self.snapshots(({}, ["gap"]))
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head", [])))
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", return_value=True):
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
        self.assertEqual(job["wait_reason"], runtime.MISSING_EVIDENCE)
        self.assertEqual(load.call_count, 1)

    def test_open_gate_dry_run_admits_without_reserving(self):
        self.q["items"] = [self.item]
        self.q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": AT, "reflected_reservations": []}
        self.snapshots()
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head", [])))
        log = []
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", return_value=True):
            self.assertEqual(runtime.select(self.c, self.q, log, True, None), (None, True))
        self.assertEqual(log, ["DRY-RUN would admit " + self.item["id"]])
        self.assertEqual([row["decision"] for row in self.q["backfill_admissions"]], ["admit", "admit"])
        self.assertFalse(self.q.get("backfill_reservations"))

    def test_stale_snapshot_waits_requests_refresh_and_records_no_reconciliation(self):
        first = copy.deepcopy(self.item)
        other = copy.deepcopy(self.item); other["id"] += "-other"; other["target"] = "c" * 40
        self.q["items"] = [first, other]
        self.q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": AT, "reflected_reservations": []}
        self.snapshots(None)
        self.c.launch = mock.Mock()
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head1", [])))
        with mock.patch.object(runtime, "services", return_value=(None, object(), object(), publisher)), \
             mock.patch.object(jobs, "eligible", return_value=True):
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
        self.c.launch.assert_not_called()
        self.assertEqual({first["wait_reason"], other["wait_reason"]}, {runtime.COVERAGE_PENDING})
        self.assertNotIn("backfill_coverage_reconciled", self.q)
        request = ledger.loads((self.state / runtime.coverage.REQUEST).read_bytes())
        self.assertEqual(request, {"head": "head1", "targets": sorted({self.t, "c" * 40})})

    def test_fresh_slot_passes_never_compute_coverage_under_lock_across_head_moves(self):
        """Regression (crq-runner/20261103-5): every one-minute crq_slot process
        recomputed backfill coverage under tick.lock whenever the ledger head
        moved, overrunning its 10 min timeout and starving ticks."""
        import backfill_coverage
        import backfill_publisher
        self.q["items"] = [self.item]
        self.c.load_queue = lambda: self.q
        self.c.with_lock = lambda fn, **kwargs: fn()
        runtime.usage_context(self.c, self.q, {"remaining": 2}, [])
        self.q["backfill_starts_at_observation"] = 0
        def launch(queue, item, plan):
            item.update(state="reviewing", run={"run_id": "vendor-1", "started_at": AT})
            queue["starts"].append(AT)
            return "vendor-1"
        under_lock = mock.patch.multiple(runtime.accounting.Repository,
                                         coverage=mock.Mock(side_effect=AssertionError("coverage under tick.lock")),
                                         fold=mock.Mock(side_effect=AssertionError("coverage under tick.lock")))
        def fresh():  # one crq_slot process: no state beyond the queue and disk
            return SimpleNamespace(**{k: v for k, v in vars(self.c).items() if not k.startswith("_")}, launch=launch)
        with under_lock:
            self.assertEqual(runtime.select(fresh(), self.q, [], False, None), (None, False))
        self.assertEqual(self.item["wait_reason"], runtime.COVERAGE_PENDING)
        # Off-lock refresher (crq-publisher) answers the request with one full pass.
        self.assertEqual(backfill_publisher.main(self.c)["coverage"]["targets"], {self.t: "full"})
        self.assertFalse((self.state / backfill_coverage.REQUEST).exists())
        # The ledger head moves (a state event is published); no review was appended.
        def root_publish(base, head, bundle):
            filename = self.root / "submission.bundle"
            filename.write_bytes(bundle)
            self.f.git("bundle", "unbundle", str(filename))
            self.f.git("push", "origin", head + ":refs/heads/cq/review-ledger")
        self.c.SPOOL.publish_ledger = root_publish
        _, _, _, publisher = runtime.services(self.c, self.config)
        before, _ = publisher.fetch()
        runtime.state_event(self.c, self.q, self.item, AT, "fixture head move")
        moved = backfill_publisher.main(self.c)
        self.assertNotEqual(moved["ledger_head"], before)
        self.assertEqual(moved["coverage"]["targets"], {self.t: "extended"})
        self.item.pop("wait_reason", None)
        with under_lock:  # a second fresh process at the moved head admits from the snapshot
            self.assertEqual(runtime.select(fresh(), self.q, [], False, None), ("vendor-1", True))

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

    def test_vendor_terminal_hold_is_not_subtracted_twice_after_a_successful_probe(self):
        jobs.admission(self.q, self.item, AT, {"successful": True, "remaining": 2, "observed_at": AT}, False)
        key = self.item["attempt_id"]
        jobs.terminal(self.q, self.item, AT, "completed", vendor_terminal=True)
        self.c.iso = lambda: "2026-10-30T00:10:00Z"
        runtime.usage_context(self.c, self.q, {"remaining": 3, "rollingWindowMs": 3600000}, [])
        self.assertEqual(self.q["backfill_usage"]["reflected_reservations"], [key])
        self.assertEqual(self.q["backfill_reservations"][key]["quota_state"], "reserved")
        decision = jobs.admission(self.q, self.item, "2026-10-30T00:10:00Z", self.q["backfill_usage"], False, reserve=False)
        self.assertEqual(decision["effective_remaining"], 3)
        runtime.usage_context(self.c, self.q, None, [])
        self.assertEqual(self.q["backfill_usage"]["reflected_reservations"], [])

    def test_released_or_later_terminal_holds_are_not_reflected(self):
        jobs.admission(self.q, self.item, AT, {"successful": True, "remaining": 2, "observed_at": AT}, False)
        key = self.item["attempt_id"]
        hold = self.q["backfill_reservations"][key]
        hold["terminal_at"] = "2026-10-30T00:05:00Z"
        self.c.iso = lambda: "2026-10-30T00:04:00Z"  # probe precedes the terminal time
        runtime.usage_context(self.c, self.q, {"remaining": 2, "rollingWindowMs": 3600000}, [])
        self.assertEqual(self.q["backfill_usage"]["reflected_reservations"], [])
        hold["quota_state"] = "released"
        self.c.iso = lambda: "2026-10-30T00:10:00Z"
        runtime.usage_context(self.c, self.q, {"remaining": 2, "rollingWindowMs": 3600000}, [])
        self.assertEqual(self.q["backfill_usage"]["reflected_reservations"], [])

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
        refused = runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": "wrong-run"},
                                  crq.classify(rdir / "review.ndjson", 1), 1, terminal_verified=True)
        self.assertIn("retain run ownership", refused)
        self.assertTrue(jobs.is_execution_owner(self.item))
        runtime.harvest(self.c, self.q, self.item, rdir, {"run_id": "run-mixed"},
                        crq.classify(rdir / "review.ndjson", 1), 1, terminal_verified=True)
        self.assertFalse(jobs.is_execution_owner(self.item))
        self.assertEqual(self.item["state"], "quarantined")
        self.assertEqual(self.item["failures"], 1)

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
        self.assertEqual(self.refresh_snapshots()["targets"], {self.t: "full"})
        started, available = runtime.select(self.c, self.q, [], False, None)
        self.assertEqual(started, "vendor-1"); self.assertTrue(available)
        # The real gate sequence: a non-reserving pre-coverage check, then one reservation.
        self.assertEqual([row["decision"] for row in self.q["backfill_admissions"]], ["admit", "admit"])
        self.assertEqual(len(self.q["backfill_reservations"]), 1)
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
        self.assertEqual(self.item["state"], "publication-pending")
        import backfill_publisher
        self.c.load_queue = lambda: self.q
        self.c.with_lock = lambda fn, **kwargs: fn()
        def root_publish(base, head, bundle):
            filename = self.root / "submission.bundle"
            filename.write_bytes(bundle)
            self.f.git("bundle", "unbundle", str(filename))
            self.f.git("push", "origin", head + ":refs/heads/cq/review-ledger")
        self.c.SPOOL.publish_ledger = root_publish
        backfill_publisher.run(self.c)
        self.assertEqual(self.item["state"], "done")
        repo, store, _, publisher = runtime.services(self.c, self.config)
        head, records = publisher.fetch()
        covered, evidence, gaps = repo.coverage(self.t, records, store)
        self.assertEqual(covered, {"a": {1, 2}}); self.assertFalse(gaps)
        self.assertEqual(len(launches), 1)
        # One refresh over several targets restores/verifies each review once.
        later = self.f.commit({"b": b"unrelated\n"})
        repo.immutable_cache = {}
        with mock.patch.object(repo, "restore", wraps=repo.restore) as restore:
            for target in (self.t, later):
                folded = collections.defaultdict(set)
                repo.fold(target, records, store, folded, collections.defaultdict(list), [])
        self.assertEqual(restore.call_count, 1)
        self.assertEqual(dict(folded), {"a": {1, 2}})  # carried to the later target

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
        self.refresh_snapshots()
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
        self.refresh_snapshots()
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
