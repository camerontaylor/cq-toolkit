"""Offline destination validation and durable, bounded publisher delivery."""
import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import crq
import review_notify as notify
import review_transport as transport
from test_review_admission_execution import ExecutionTests

DEST = dict(paseo_agent_id="12345678-1234-1234-1234-123456789abc", paseo_host="triton:6767")
CONFIG = dict(notify=dict(hosts=["triton:6767", None]), error_backoff_min=5)


class AdmissionTests(ExecutionTests):
    def test_rejected_destination_still_admits_and_owner_controls_update(self):
        self.c.CONFIG = CONFIG
        self.c.load_queue = lambda: self.q
        policy = dict(v=1, enabled=True, repo=crq.REPO, write=["owner", "other"], branches=["main"])
        req = dict(v=1, op="submit", request_id="invalid-notify", inputs=self.inputs,
                   notify={**DEST, "paseo_agent_id": "$(touch /tmp/injected)"})
        reply = json.loads(transport.handle(json.dumps(req).encode(), self.c, principal="owner", policy=policy))
        self.assertEqual(reply["notify"], dict(state="error", reason="unsupported-destination"))
        self.assertIn(reply["action"], ("created", "joined"))
        req = dict(v=1, op="notify-update", request_id="invalid-notify", notify=DEST)
        with self.assertRaisesRegex(ValueError, "owner denied"):
            transport.handle(json.dumps(req).encode(), self.c, principal="other", policy=policy)
        reply = json.loads(transport.handle(json.dumps(req).encode(), self.c, principal="owner", policy=policy))
        self.assertEqual(reply["notify"]["state"], "pending")

    def test_a14_pending_restart_keeps_status_and_result_available(self):
        self.c.CONFIG = CONFIG
        self.q["review_requests"]["one"]["notify"] = DEST
        self.finish()
        self.q = json.loads(json.dumps(self.q))
        self.c.load_queue = lambda: copy.deepcopy(self.q)
        self.c.save_queue = lambda q: setattr(self, "q", copy.deepcopy(q))
        self.c.with_lock = lambda fn, **kw: fn()
        self.c.notify = mock.Mock(side_effect=OSError("unavailable"))
        now = datetime(2026, 11, 8, tzinfo=timezone.utc)
        notify.drain(self.c, now)
        policy = dict(enabled=True, repo=crq.REPO, write=["owner"], branches=["main"])
        for op in ("status", "result"):
            reply = json.loads(transport.handle(json.dumps(dict(v=1, op=op, request_id="one")).encode(), self.c,
                                               principal="owner", policy=policy))
            self.assertIn("receipt_id", reply)
        self.c.notify = mock.Mock(return_value=dict(paseo_send=0))
        notify.drain(self.c, now + timedelta(minutes=5))
        self.assertEqual(self.q["review_requests"]["one"]["notify_status"]["state"], "sent")


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.q = dict(items=[], review_requests={"r1":dict(item="item", notify=DEST)},
                      review_events={"event":dict(item="item", state="completed", receipt_id="result")})
        notify.update(self.q, "r1", DEST, CONFIG)
        self.held = False
        def lock(fn, **kwargs):
            self.assertFalse(self.held)
            self.held = True
            try:
                return fn()
            finally:
                self.held = False
        self.sent = []
        self.ok = False
        def send(destination, text):
            self.assertFalse(self.held)
            self.sent.append((destination, text))
            if not self.ok:
                raise OSError("runtime unavailable")
            return dict(paseo_send=0)
        self.c = SimpleNamespace(STATE=Path(self.tmp.name), CONFIG=CONFIG,
            load_queue=lambda: copy.deepcopy(self.q), save_queue=self.save, with_lock=lock, notify=send)
        self.now = datetime(2026, 11, 8, tzinfo=timezone.utc)

    def save(self, q):
        self.assertTrue(self.held)
        self.q = copy.deepcopy(q)

    def test_no_rows_is_idle_without_notification_config_or_send(self):
        for outbox in (None, {}):
            self.q.pop("review_notify_outbox", None)
            if outbox is not None:
                self.q["review_notify_outbox"] = outbox
            self.c.CONFIG = {}
            self.c.notify = mock.Mock(side_effect=AssertionError("idle must not send"))
            self.assertEqual(notify.drain(self.c, self.now), 0)
            self.c.notify.assert_not_called()

    def test_restart_transient_backoff_duplicate_and_fetchable_state(self):
        notify.drain(self.c, self.now)
        self.assertEqual(notify.drain(self.c, self.now + timedelta(minutes=1)), 0)
        self.q = json.loads(json.dumps(self.q))  # queue reload after restart
        self.ok = True
        notify.drain(self.c, self.now + timedelta(minutes=5))
        self.assertEqual(self.sent[0], self.sent[1])
        self.assertIn("event_id=event", self.sent[1][1])
        self.assertEqual(self.q["review_requests"]["r1"]["notify_status"]["state"], "sent")
        self.assertEqual(self.q["review_events"]["event"]["receipt_id"], "result")
        self.assertEqual(notify.drain(self.c, self.now + timedelta(days=1)), 0)

    def test_crash_after_send_repeats_same_event(self):
        self.ok = True
        self.c.save_queue = lambda q: None  # lost acknowledgement on process death
        notify.drain(self.c, self.now)
        self.c.save_queue = self.save
        notify.drain(self.c, self.now)
        self.assertEqual(self.sent[0], self.sent[1])
        self.assertEqual(len(self.sent), 2)

    def test_permanent_failure(self):
        for n in range(notify.MAX_ATTEMPTS):
            notify.drain(self.c, self.now + timedelta(days=n))
        self.assertEqual(self.q["review_requests"]["r1"]["notify_status"]["state"], "error")

    def test_repeated_destination_keeps_sent_rows_and_rearms_retryable_rows(self):
        self.ok = True
        notify.drain(self.c, self.now)
        self.assertEqual(len(self.sent), 1)
        notify.update(self.q, "r1", DEST, CONFIG)
        self.assertEqual(self.q["review_requests"]["r1"]["notify_status"]["state"], "sent")
        self.assertEqual(notify.drain(self.c, self.now + timedelta(minutes=1)), 0)
        self.assertEqual(len(self.sent), 1)
        self.q["review_notify_outbox"] = {k: dict(v, state="error")
                                          for k, v in self.q["review_notify_outbox"].items()}
        notify.update(self.q, "r1", DEST, CONFIG)
        row = next(iter(self.q["review_notify_outbox"].values()))
        self.assertEqual(row["state"], "pending")
        notify.drain(self.c, self.now + timedelta(minutes=2))
        self.assertEqual(len(self.sent), 2)

    def test_replace_withdraw_and_bound(self):
        replacement = {**DEST, "paseo_host": None}
        notify.update(self.q, "r1", replacement, CONFIG)
        notify.update(self.q, "r1", None, CONFIG)
        self.assertEqual(notify.drain(self.c, self.now), 0)
        for n in range(12):
            rid = f"r{n}"
            self.q["review_requests"][rid] = dict(item="item")
            notify.update(self.q, rid, DEST, CONFIG)
        self.ok = True
        self.assertEqual(notify.drain(self.c, self.now), notify.LIMIT)
        self.assertEqual(len(self.sent), notify.LIMIT)

    def test_withdraw_later_row_while_first_send_blocks(self):
        self.q['review_requests']['r2'] = dict(item='item')
        notify.update(self.q, 'r2', DEST, CONFIG)
        def send(destination, text):
            self.sent.append(text)
            notify.update(self.q, 'r2', None, CONFIG)
            return dict(paseo_send=0)
        self.c.notify = send
        notify.drain(self.c, self.now)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.q['review_requests']['r2']['notify_status']['state'], 'withdrawn')

    def test_injection_and_argv_only(self):
        for bad in ({**DEST, "paseo_agent_id": "--help"}, {**DEST, "paseo_host": "$(id)"}, {**DEST, "paseo_host": "unknown"}):
            self.assertIsNone(notify.destination(bad, CONFIG))
        with mock.patch.object(crq, "run", return_value=SimpleNamespace(returncode=0)) as run:
            crq.notify(DEST, "fixed text")
            self.assertEqual(run.call_args.args[0], ["paseo", "send", "--no-wait", "--host", "triton:6767", DEST["paseo_agent_id"], "fixed text"])
            self.assertNotIn("shell", run.call_args.kwargs)
