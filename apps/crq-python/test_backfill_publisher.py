"""Real offline publication, crash replay and queue-lock isolation."""
import copy
import unittest
from unittest import mock

import backfill_publisher as worker
import backfill_runtime as runtime
import review_ledger as ledger
import test_backfill_runtime as runtime_tests
from test_backfill_jobs import AT


class PublisherTest(unittest.TestCase):
    setUp = runtime_tests.RuntimeTest.setUp

    def prepare(self):
        self.held = False
        def lock(fn, **kwargs):
            self.assertFalse(self.held)
            self.held = True
            try:
                return fn()
            finally:
                self.held = False
        self.c.with_lock = lock
        self.c.load_queue = lambda: copy.deepcopy(self.q)
        def save(queue):
            self.assertTrue(self.held)
            self.q = copy.deepcopy(queue)
        self.c.save_queue = save
        self.pushes = []
        def push(base, head, bundle):
            self.assertFalse(self.held)
            self.assertEqual(self.q["items"][0]["state"], "pending")
            self.q["tick_diagnostic"] = "changed during network"
            filename = self.root / "submission.bundle"
            filename.write_bytes(bundle)
            self.f.git("bundle", "unbundle", str(filename))
            self.f.git("push", "origin", head + ":refs/heads/cq/review-ledger")
            self.pushes.append(head)
        self.c.SPOOL.publish_ledger = push
        runtime.state_event(self.c, self.q, self.item, AT, "inventory enqueue")
        return runtime.services(self.c, self.config)[2]

    def test_tick_only_requests_and_worker_preserves_current_queue(self):
        outbox = self.prepare()
        with mock.patch.object(runtime, "services", side_effect=AssertionError("tick created Git publisher")):
            self.c.with_lock(lambda: runtime.publish(self.c, self.q))
        real_git = ledger.GitLedger.git
        def git(publisher, *args, **kwargs):
            self.assertFalse(self.held)
            self.assertNotEqual(publisher.repo, self.c.CLONE)
            return real_git(publisher, *args, **kwargs)
        with mock.patch.object(ledger.GitLedger, "git", git):
            result = worker.run(self.c)
        self.assertEqual(result["publication"], "reconciled")
        self.assertEqual(self.q["tick_diagnostic"], "changed during network")
        self.assertEqual(self.q["items"][0]["state"], "pending")
        self.assertFalse(outbox.pending())
        self.assertEqual(len(self.pushes), 1)

    def test_failure_retains_pending_and_retry_acknowledges_remote(self):
        outbox = self.prepare()
        push = self.c.SPOOL.publish_ledger
        with mock.patch.object(self.c.SPOOL, "publish_ledger", side_effect=OSError("network down")):
            with self.assertRaises(ledger.IntegrityError):
                worker.run(self.c)
        self.assertEqual(len(outbox.pending()), 1)
        self.assertEqual(self.q["items"][0]["state"], "pending")
        self.assertIn("backfill_publication_error", self.q)
        self.c.SPOOL.publish_ledger = push
        worker.run(self.c)
        self.assertFalse(outbox.pending())
        self.assertNotIn("backfill_publication_error", self.q)

    def test_crash_after_remote_ack_reconciles_without_duplicate_push(self):
        outbox = self.prepare()
        # Timer pending scan also persists reconciliation intent before ack.
        with mock.patch.object(runtime, "reconcile_publication", side_effect=OSError("crash before queue save")):
            with self.assertRaises(OSError):
                worker.run(self.c)
        self.assertFalse(outbox.pending())
        self.assertTrue((self.state / "backfill/publish-request.json").exists())
        worker.run(self.c)
        self.assertEqual(len(self.pushes), 1)
        self.assertEqual(self.q["review_ledger_head"], self.pushes[0])

    def test_busy_queue_lock_never_claims_reconciled_and_retries(self):
        outbox = self.prepare()
        lock = self.c.with_lock
        self.c.with_lock = lambda fn, **kwargs: None
        with self.assertRaisesRegex(ledger.IntegrityError, "queue lock busy"):
            worker.run(self.c)
        self.assertFalse(outbox.pending())  # Remote ack is not queue reconciliation.
        self.assertTrue((self.state / "backfill/publish-request.json").exists())
        self.assertTrue((self.state / "backfill/publication-failure.json").exists())
        with mock.patch.object(runtime, "services", side_effect=AssertionError("admission passed halt")):
            self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
        self.c.with_lock = lock
        self.q["backfill_halted"] = "unrelated operator halt"
        worker.run(self.c)
        self.assertEqual(len(self.pushes), 1)
        self.assertFalse((self.state / "backfill/publication-failure.json").exists())
        self.assertEqual(self.q["backfill_halted"], "unrelated operator halt")

    def test_integrity_failure_blocks_admission_without_releasing_owner(self):
        self.prepare()
        with mock.patch.object(ledger.GitLedger, "fetch", side_effect=ledger.IntegrityError("tampered ledger")):
            with self.assertRaisesRegex(ledger.IntegrityError, "tampered ledger"):
                worker.run(self.c)
        self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
        self.assertEqual(self.q["items"][0]["state"], "pending")

    def test_marker_write_failure_records_queue_halt_and_preserves_original(self):
        self.prepare()
        original = ledger.IntegrityError("original tampered ledger")
        atomic = ledger.atomic
        def marker_fault(filename, data):
            if filename.name == "publication-failure.json":
                raise OSError("marker volume unavailable")
            return atomic(filename, data)
        with mock.patch.object(ledger.GitLedger, "fetch", side_effect=original), \
             mock.patch.object(ledger, "atomic", side_effect=marker_fault):
            with self.assertRaises(ledger.IntegrityError) as raised:
                worker.run(self.c)
        self.assertIs(raised.exception, original)
        self.assertFalse((self.state / "backfill/publication-failure.json").exists())
        self.assertEqual(self.q["backfill_halt_operation"], "publication")
        self.assertEqual(self.q["backfill_halted"], str(original))
        self.assertEqual(runtime.select(self.c, self.q, [], False, None), (None, False))
        self.assertEqual(self.q["items"][0]["state"], "pending")
        self.c.with_lock(lambda: runtime.publish(self.c, self.q))
        self.assertIn("backfill_halted", self.q)  # Requesting is not recovery.
        worker.run(self.c)
        self.assertNotIn("backfill_halted", self.q)
        self.assertNotIn("backfill_halt_operation", self.q)
        self.assertNotIn("backfill_publication_error", self.q)

    def test_marker_fault_preserves_unrelated_halt_through_recovery(self):
        self.prepare()
        self.q.update(backfill_halted="inventory failure", backfill_halt_operation="inventory")
        atomic = ledger.atomic
        def marker_fault(filename, data):
            if filename.name == "publication-failure.json":
                raise OSError("marker failure")
            return atomic(filename, data)
        with mock.patch.object(ledger.GitLedger, "fetch", side_effect=ledger.IntegrityError("bad ledger")), \
             mock.patch.object(ledger, "atomic", side_effect=marker_fault):
            with self.assertRaises(ledger.IntegrityError):
                worker.run(self.c)
        current = copy.deepcopy(self.q)
        runtime.clear_operation_halt(current, "inventory")
        self.assertEqual(runtime.select(self.c, current, [], False, None), (None, False))
        worker.run(self.c)
        self.assertEqual(self.q["backfill_halted"], "inventory failure")
        self.assertEqual(self.q["backfill_halt_operation"], "inventory")

    def test_failure_reporting_errors_never_replace_publication_exception(self):
        for busy in (False, True):
            with self.subTest(busy=busy):
                self.prepare()
                original = ledger.IntegrityError("original integrity failure")
                atomic = ledger.atomic
                def marker_fault(filename, data):
                    if filename.name == "publication-failure.json":
                        raise OSError("marker failure")
                    return atomic(filename, data)
                with mock.patch.object(ledger.GitLedger, "fetch", side_effect=original), \
                     mock.patch.object(ledger, "atomic", side_effect=marker_fault), \
                     mock.patch.object(self.c, "with_lock", return_value=None, side_effect=None if busy else OSError("queue failure")):
                    with self.assertRaises(ledger.IntegrityError) as raised:
                        worker.run(self.c)
                self.assertIs(raised.exception, original)
                self.assertEqual(len(original.__notes__), 2)
                self.assertTrue((self.state / "backfill/publish-request.json").exists())

    def test_only_successful_operation_clears_its_owned_halt(self):
        queue = {"backfill_halted": "inventory transient", "backfill_halt_operation": "inventory"}
        runtime.clear_operation_halt(queue, "publication-request")
        self.assertIn("backfill_halted", queue)
        runtime.clear_operation_halt(queue, "inventory")
        self.assertNotIn("backfill_halted", queue)
        queue["backfill_halted"] = "unclassified legacy halt"
        runtime.clear_operation_halt(queue, "inventory")
        self.assertIn("backfill_halted", queue)

    def test_templates_render_worker_outside_tick_entrypoint(self):
        from pathlib import Path
        root = Path(__file__).parent / "ops/systemd"
        service = (root / "crq-publisher.service").read_text()
        self.assertIn("@CRQ_ROOT@/backfill_publisher.py", service)
        self.assertIn("KillMode=control-group", service)
        self.assertIn("OnUnitInactiveSec=1min", (root / "crq-publisher.timer").read_text())

    def test_live_owner_is_never_completed_by_reconciliation(self):
        self.prepare()
        item = self.q["items"][0]
        item.update(state="publication-pending", vendor_state="live", publication_event_id="event")
        with mock.patch.object(runtime.jobs, "published") as published:
            self.c.with_lock(lambda: runtime.reconcile_publication(self.c, self.q, "a" * 40, {"event": {}}))
        published.assert_not_called()
        self.assertEqual(self.q["items"][0]["state"], "publication-pending")


if __name__ == "__main__":
    unittest.main()
