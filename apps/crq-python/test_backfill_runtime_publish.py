"""Launch, harvest and publication lifecycle, including crash replay.

Split provenance: apps/crq-python/test_backfill_runtime.py was split into
test_backfill_runtime_collector.py, test_backfill_runtime_admission.py,
test_backfill_runtime_observation.py, test_backfill_runtime_selection.py,
test_backfill_runtime_coverage.py, test_backfill_runtime_publish.py,
test_backfill_runtime_quota.py, test_backfill_runtime_events.py and
test_backfill_runtime_fixtures.py.
"""
import collections
import copy
import unittest
from unittest import mock

import backfill_jobs as jobs
import backfill_runtime as runtime
import review_ledger as ledger
from test_backfill_jobs import AT
from test_backfill_runtime_fixtures import RuntimeTestBase


class RuntimeTest(RuntimeTestBase):
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

    def test_refusal_event_failure_preserves_quarantine_and_replays_after_reload(self):
        runtime.usage_context(self.c, self.q, {"remaining": 2}, [])
        self.q["backfill_starts_at_observation"] = 0
        self.c.launch = mock.Mock(return_value=None)
        self.refresh_snapshots()
        original_event = runtime.state_event
        reason = "launch refused before vendor binding"
        def failing_event(c, queue, item, at, event_reason):
            if event_reason == reason:
                raise OSError("publication unavailable")
            return original_event(c, queue, item, at, event_reason)
        with mock.patch.object(runtime, "state_event", side_effect=failing_event):
            with self.assertRaisesRegex(OSError, "publication unavailable"):
                runtime.select(self.c, self.q, [], False, None)
        self.q = ledger.loads(self.saved[-1])
        self.item = self.q["items"][0]
        self.assertEqual(self.item["state"], "quarantined")
        self.assertEqual(self.item["vendor_state"], "terminal")
        self.assertFalse(jobs.is_execution_owner(self.item))
        self.assertEqual(self.item["failures"], 1)
        self.assertEqual(self.item["refusal_state_event"]["reason"], reason)
        self.assertTrue(all(h["quota_state"] == "released"
                            for h in self.q["backfill_reservations"].values()))
        runtime.select(self.c, self.q, [], True, None)
        self.assertIn("refusal_state_event", self.item)
        runtime.select(self.c, self.q, [], False, None)
        self.assertNotIn("refusal_state_event", self.item)
        self.assertEqual(self.item["state"], "quarantined")
        self.assertEqual(self.item["failures"], 1)
        self.c.launch.assert_called_once()
        _, _, outbox, _ = runtime.services(self.c, self.config)
        events = [e for e in outbox.retained() if e["payload"].get("reason") == reason]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["payload"]["state"], "quarantined")

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
