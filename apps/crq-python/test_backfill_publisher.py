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
