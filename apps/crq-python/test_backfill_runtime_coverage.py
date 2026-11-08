"""Coverage refresh: off-lock requests, retries and the publisher pass.

Split provenance: apps/crq-python/test_backfill_runtime.py was split into
test_backfill_runtime_collector.py, test_backfill_runtime_admission.py,
test_backfill_runtime_observation.py, test_backfill_runtime_selection.py,
test_backfill_runtime_coverage.py, test_backfill_runtime_publish.py,
test_backfill_runtime_quota.py, test_backfill_runtime_events.py and
test_backfill_runtime_fixtures.py.
"""
import copy
import unittest
from types import SimpleNamespace
from unittest import mock

import backfill_jobs as jobs
import backfill_runtime as runtime
import review_ledger as ledger
from test_backfill_jobs import AT
from test_backfill_runtime_fixtures import RuntimeTestBase


class RuntimeTest(RuntimeTestBase):
    def test_transient_gap_is_requested_retried_off_lock_and_then_admits(self):
        from test_backfill_coverage import FakeRepo, event
        import backfill_coverage
        self.q["items"] = [self.item]
        self.q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": AT, "reflected_reservations": []}
        events = [event("r1", True)]
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head", events)))
        self.c.launch = mock.Mock(return_value="vendor-1", side_effect=lambda q, item, plan: item.update(state="reviewing") or "vendor-1")
        _, store, outbox, _ = runtime.services(self.c, self.config)  # admission spools a real state event
        with mock.patch.object(backfill_coverage.ledger, "creditable", side_effect=lambda v: v.get("review", False)), \
             mock.patch.object(backfill_coverage.ledger, "validate_sequence", return_value={}):
            backfill_coverage.refresh(self.state, FakeRepo(fail={"r1"}), None, events, {self.t})
            with mock.patch.object(runtime, "services", return_value=(None, store, outbox, publisher)), \
                 mock.patch.object(jobs, "eligible", side_effect=lambda q, item, at: item["state"] == "pending"):
                self.assertEqual(runtime.select(self.c, self.q, [], True, None), (None, False))  # dry run
                self.assertFalse((self.state / backfill_coverage.REQUEST).exists())
                self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
                self.assertEqual(self.item["wait_reason"], runtime.MISSING_EVIDENCE)
                self.assertTrue((self.state / backfill_coverage.REQUEST).exists())
                # The off-lock refresher retries only the gap review; it now succeeds.
                repo = FakeRepo()
                self.assertEqual(backfill_coverage.refresh(self.state, repo, None, events, {self.t}), {self.t: "extended"})
                self.assertEqual(repo.folded, [(self.t, "r1")])
                self.assertEqual(runtime.select(self.c, self.q, [], False, None), ("vendor-1", True))
        self.c.launch.assert_called_once()

    def test_publisher_journals_publication_when_the_refresh_fails(self):
        import backfill_coverage
        import backfill_publisher
        import review_notify
        self.c.with_lock = lambda fn, **kwargs: fn()
        self.c.load_queue = lambda: self.q
        self.assertNotIn("review_notify_outbox", self.q)
        self.assertEqual(review_notify.drain(self.c), 0)
        with mock.patch.object(backfill_publisher, "run", return_value={"publication": "idle"}), \
             mock.patch.object(backfill_coverage, "run", side_effect=OSError("snapshot volume full")):
            result = backfill_publisher.main(self.c)
        self.assertEqual(result, {"publication": "idle", "coverage": "failed: snapshot volume full"})
        self.assertTrue(backfill_publisher.coverage_failed(result))
        self.assertTrue(backfill_publisher.coverage_failed({"coverage": {"targets": {self.t: "error: boom"}}}))
        self.assertFalse(backfill_publisher.coverage_failed({"coverage": {"targets": {self.t: "unchanged"}}}))
        self.assertFalse(backfill_publisher.coverage_failed({"coverage": "idle"}))

    def test_launch_still_requests_targets_seen_stale_earlier_in_the_pass(self):
        stale = copy.deepcopy(self.item); stale["id"] += "-stale"; stale["target"] = "c" * 40
        stale["score"] = self.item["score"] + 1  # higher score sorts before the launchable job
        self.q["items"] = [stale, self.item]
        self.q["backfill_usage"] = {"successful": True, "remaining": 5, "observed_at": AT, "reflected_reservations": []}
        load = self.snapshots()
        load.side_effect = lambda state, target, events, digests=None: None if target == "c" * 40 else ({}, [])
        _, store, outbox, _ = runtime.services(self.c, self.config)
        publisher = SimpleNamespace(fetch=mock.Mock(return_value=("head", [])))
        self.c.launch = mock.Mock(side_effect=lambda q, item, plan: item.update(state="reviewing") or "vendor-1")
        with mock.patch.object(runtime, "services", return_value=(None, store, outbox, publisher)), \
             mock.patch.object(jobs, "eligible", side_effect=lambda q, item, at: item["state"] == "pending"):
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), ("vendor-1", True))
        self.assertEqual(stale["wait_reason"], runtime.COVERAGE_PENDING)
        request = ledger.loads((self.state / runtime.coverage.REQUEST).read_bytes())
        self.assertEqual(request["targets"], ["c" * 40])
        # A marker write failure after the bound launch is logged, never raised.
        stale.update(state="pending"); self.item.update(state="pending"); self.item.pop("run", None)
        log = []
        with mock.patch.object(runtime, "services", return_value=(None, store, outbox, publisher)), \
             mock.patch.object(jobs, "eligible", side_effect=lambda q, item, at: item["state"] == "pending"), \
             mock.patch.object(jobs, "bind_run"), \
             mock.patch.object(runtime.coverage, "request", side_effect=OSError("no space left")):
            self.assertEqual(runtime.select(self.c, self.q, log, False, None), ("vendor-1", True))
        self.assertIn("coverage refresh request not written: no space left", log)

    def test_refresher_adds_requested_targets_and_keeps_a_request_written_meanwhile(self):
        import backfill_coverage
        self.c.load_queue = lambda: {"items": []}  # the unlocked read predates the enqueue
        backfill_coverage.request(self.state, "head", [self.t])
        marker = self.state / backfill_coverage.REQUEST
        def refresh(state, repo, store, events, targets, keep=()):
            self.assertEqual(targets, {self.t})
            self.assertEqual(set(keep), set())  # no live job: nothing protected from pruning
            backfill_coverage.request(self.state, "newer", [self.t])  # a pass during the refresh
            return {self.t: "full"}
        with mock.patch.object(backfill_coverage, "refresh", side_effect=refresh):
            self.assertEqual(backfill_coverage.run(self.c)["targets"], {self.t: "full"})
        self.assertEqual(ledger.loads(marker.read_bytes())["head"], "newer")
        # A changed snapshot wakes the next one-minute slot, as a harvest does.
        self.assertEqual((self.state / "next-review-at").read_text().strip(), AT)
        (self.state / "next-review-at").unlink()
        with mock.patch.object(backfill_coverage, "refresh", return_value={self.t: "unchanged"}):
            backfill_coverage.run(self.c)  # the next run consumes the surviving request
        self.assertFalse(marker.exists())
        self.assertFalse((self.state / "next-review-at").exists())  # nothing changed: no wake
        self.assertEqual(backfill_coverage.run(self.c), "idle")

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
        (self.state / "next-review-at").unlink()  # the cold refresh woke the slot
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
        self.assertEqual(moved["coverage"]["targets"], {self.t: "unchanged"})  # state event: no new credit
        self.assertFalse((self.state / "next-review-at").exists())  # so no wake either
        self.item.pop("wait_reason", None)
        with under_lock:  # a second fresh process at the moved head admits from the snapshot
            self.assertEqual(runtime.select(fresh(), self.q, [], False, None), ("vendor-1", True))

if __name__ == "__main__":
    unittest.main()
