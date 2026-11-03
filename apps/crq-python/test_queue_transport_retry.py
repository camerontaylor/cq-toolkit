"""Transient-retry tests for queue transport.

Split provenance: apps/crq-python/test_queue_transport.py was split by subject;
shared fixtures live in test_queue_transport_fixtures.py.
"""
import unittest
import copy
import json
import builtins
import io
import os
import sys
import subprocess
from types import SimpleNamespace
from unittest import mock
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import crq
import merged_reconcile as reconcile
import queue_transport as transport
import review_receipt as receipts
import capability_dispatcher as dispatcher

from test_queue_transport_fixtures import QueueTransportFixtureMixin, setUpModule, tearDownModule


class QueueTransportTests(QueueTransportFixtureMixin, unittest.TestCase):
    def test_typed_transient_attempts_and_permanent_refusals(self):
        cases = [
            ('{"type":"error","errorType":"network_error","recoverable":true}', 1, True),
            ('{"type":"error","errorType":"transport_error","recoverable":true}', 1, True),
            ('', 124, True), ('', -9, True), ('', 137, True), ('', -15, True),
            ('{"type":"error","errorType":"permanent","recoverable":false}', 1, False),
            ('{"type":"error","errorType":"blocked-secret-scan","recoverable":true}', 1, False),
            ('not json', 124, False),
            ('{"type":"error","errorType":"network_error","recoverable":"true"}', 1, False),
            ('{"type":"error","errorType":"network_error","recoverable":false}', 1, False),
            ('', None, False), ('', True, False),
        ]
        for stream, exit_code, accepted in cases:
            with self.subTest(stream=stream, exit=exit_code):
                receipt, doc = self.failed_attempt(stream, exit_code)
                before = copy.deepcopy(self.q)
                result = self.call("retry", expectedReceiptId=receipt)
                self.assertEqual(result["accepted"], accepted)
                if not accepted:
                    self.assertEqual(self.q, before)

    def test_retry_type_proof_is_required_even_for_transient_exit(self):
        for field, value in [("retry_transient", None), ("bad_lines", True), ("exit", True),
                             ("counted", 0), ("retry_transient", {"version": True, "category": "timeout"})]:
            with self.subTest(field=field, value=value):
                receipt, doc = self.failed_attempt('', 124)
                doc["classification"][field] = value
                receipt = receipts.write_receipt(self.tmp.name, doc)
                item = self.q["items"][0]
                item["receipt_id"] = receipt
                item["attempts"][-1]["receipt_id"] = receipt
                self.assertFalse(self.call("retry", expectedReceiptId=receipt)["accepted"])

    def test_grant_retry_budget_defaults_and_override(self):
        for limit in (1, 3):
            receipt, doc = self.failed_attempt('', 124)
            grant = self.policy["transient_retries"][0]
            if limit == 1:
                grant["maxRetries"] = limit
            for attempt in range(limit + 1):
                item = self.q["items"][0]
                doc["run_id"] = str(attempt)
                receipt = receipts.write_receipt(self.tmp.name, doc)
                item.update(state="blocked", receipt_id=receipt)
                item["attempts"].append({"run_id": "run-1", "receipt_id": receipt, "counted": False})
                result = self.call("retry", expectedReceiptId=receipt)
                self.assertEqual(result["accepted"], attempt < limit)
                if attempt < limit:
                    self.assertEqual(self.call("retry", expectedReceiptId=receipt)["action"], "already-accepted")
                else:
                    self.assertEqual(result["reason"], "retry-limit")
            self.assertEqual(self.q["queue_client_requests"]["request-1"]["retry_count"], limit)
        for invalid in (True, 0, -1, "3", 101):
            self.policy["transient_retries"][0]["maxRetries"] = invalid
            with self.assertRaisesRegex(ValueError, "invalid transient retry grant"):
                self.call("retry", expectedReceiptId=receipt)

    def test_retry_refuses_receipt_consumed_through_another_alias(self):
        receipt = self.retry_fixture()
        self.q["merged_current_requests"]["alias"] = copy.deepcopy(self.q["merged_current_requests"]["request-1"])
        self.q["queue_client_requests"]["alias"] = {"consumed": receipt}
        before = copy.deepcopy(self.q)
        self.assertEqual(self.call("retry", expectedReceiptId=receipt)["reason"], "consumed")
        self.assertEqual(self.q, before)

    def test_retry_capability_is_authorized_and_never_mutates(self):
        self.retry_fixture()
        before = copy.deepcopy(self.q)
        self.assertEqual(self.call("retry-capability"), {"retry": 1})
        self.assertEqual(self.q, before)
        self.policy.pop("transient_retries")
        self.assertEqual(self.call("retry-capability"), {"denied": "no-permission"})

    def test_retry_probe_dispatcher_never_takes_lock_and_reports_denial(self):
        self.retry_fixture()
        policy_path = Path(self.tmp.name) / "policy.json"
        policy_path.write_text(json.dumps(self.policy))
        request = receipts.canonical({"v": 1, "op": "retry-capability", "requestId": "request-1", "binding": self.b})
        before = copy.deepcopy(self.q)
        for principal, expected in (("developer", {"retry": 1}), ("stranger", {"denied": "no-permission"})):
            output = io.BytesIO()
            with mock.patch.dict(sys.modules, {"crq": SimpleNamespace(REPO="owner/repo", enqueue_merged=lambda: None)}), \
                    mock.patch.dict(os.environ, {"CRQ_QUEUE_POLICY": str(policy_path), "CRQ_QUEUE_PRINCIPAL": principal}), \
                    mock.patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(request))), \
                    mock.patch.object(sys, "stdout", SimpleNamespace(buffer=output)), \
                    mock.patch("signal.signal"), mock.patch("signal.alarm"), \
                    mock.patch("author_transport.supervised", side_effect=AssertionError("must not lock")) as supervised:
                self.assertEqual(dispatcher.queue_main(), 0)
                self.assertEqual(json.loads(output.getvalue())["result"], expected)
                supervised.assert_not_called()
            self.assertEqual(self.q, before)

    def test_retry_probe_and_write_agree_on_runner_repository_gate(self):
        self.retry_fixture()
        policy_path = Path(self.tmp.name) / "policy.json"
        policy_path.write_text(json.dumps(self.policy))
        for fake in (SimpleNamespace(REPO="other/repo", enqueue_merged=lambda: None),
                     SimpleNamespace(REPO="owner/repo")):
            for op in ("retry-capability", "retry"):
                request = {"v": 1, "op": op, "requestId": "request-1", "binding": self.b}
                if op == "retry":
                    request["expectedReceiptId"] = "a" * 64
                output = io.BytesIO()
                with self.subTest(op=op, runner=fake), \
                        mock.patch.dict(sys.modules, {"crq": fake}), \
                        mock.patch.dict(os.environ, {"CRQ_QUEUE_POLICY": str(policy_path), "CRQ_QUEUE_PRINCIPAL": "developer"}), \
                        mock.patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(receipts.canonical(request)))), \
                        mock.patch.object(sys, "stdout", SimpleNamespace(buffer=output)), \
                        mock.patch("signal.signal"), mock.patch("signal.alarm"), \
                        mock.patch("author_transport.supervised", side_effect=AssertionError("must not lock")) as supervised:
                    self.assertEqual(dispatcher.queue_main(), 0)
                    self.assertIn("unsupported", json.loads(output.getvalue())["result"])
                    supervised.assert_not_called()

    def test_unknown_exits_and_unlisted_causes_never_authorize_retry(self):
        for exit_code in (2, 3, 255):
            for events in ('', '{"type":"error","errorType":"network_error","recoverable":true}'):
                with self.subTest(exit=exit_code, events=events):
                    receipt, doc = self.failed_attempt(events, exit_code)
                    self.assertEqual(doc["classification"]["outcome"], "error")
                    self.assertNotIn("retry_transient", doc["classification"])
                    # Even a forged transport tag cannot authorize an unsupported exit.
                    doc["classification"]["retry_transient"] = {"version": 1, "category": "transport"}
                    self.assert_retry_document_refused(doc)
        for code in ("auth", "scan", "permanent", "unknown", "not-a-transient"):
            receipt, doc = self.failed_attempt('{"type":"error","errorType":"network_error","recoverable":true}', 1)
            doc["classification"]["failure_provenance"]["causes"].append(
                {"source": "queue", "category": "unknown", "code": code})
            self.assert_retry_document_refused(doc)
            # The producer also refuses recoverable errors with unlisted types.
            receipt, doc = self.failed_attempt(json.dumps({"type": "error", "errorType": code, "recoverable": True}), 1)
            self.assertNotIn("retry_transient", doc["classification"])
            self.assertFalse(self.call("retry", expectedReceiptId=receipt)["accepted"])

    def test_retry_durable_replay_and_serialized_competitors(self):
        receipt = self.retry_fixture()
        before = copy.deepcopy(self.q["items"][0])
        lock = threading.Lock()
        def serialized(fn):
            with lock:
                return fn()
        self.runner.with_lock = serialized
        with ThreadPoolExecutor(max_workers=2) as callers:
            results = list(callers.map(lambda _: self.call("retry", expectedReceiptId=receipt), range(2)))
        self.assertEqual(sum(result["accepted"] for result in results), 1)
        # Lost response and the second caller both replay the same durable decision.
        for _ in range(2):
            self.assertEqual(self.call("retry", expectedReceiptId=receipt)["action"], "already-accepted")
        item = self.q["items"][0]
        self.assertEqual(item["subject"], before["subject"])
        self.assertEqual(item["attempts"], [{**before["attempts"][0], "retry_requested": True}])
        self.assertEqual(item["state"], "pending")

    def test_author_retry_never_renews_consumed_dispatch(self):
        self.call("enqueue")
        self.policy["transient_retries"] = [{"principal": "developer", "requestId": "request-1", "binding": self.b}]
        self.q["queue_client_requests"]["request-1"]["consumed"] = "a" * 64
        before = copy.deepcopy(self.q)
        result = self.call("retry", expectedReceiptId="a" * 64)
        self.assertEqual(result, {"action": "needs-human", "accepted": False, "reason": "author-dispatch"})
        self.assertEqual(self.q, before)

    def test_retry_refusals(self):
        for refusal in ("alive", "ambiguous", "consumed", "permanent", "grant"):
            with self.subTest(refusal=refusal):
                self.q = {"items": []}
                receipt = self.retry_fixture()
                if refusal in ("alive", "ambiguous"):
                    self.runner.run_liveness = lambda *args: refusal
                elif refusal == "consumed":
                    self.q["queue_client_requests"]["request-1"]["consumed"] = receipt
                elif refusal == "permanent":
                    self.q["items"][0]["state"] = "done"
                else:
                    self.policy.pop("transient_retries")
                before = copy.deepcopy(self.q)
                if refusal == "grant":
                    with self.assertRaisesRegex(ValueError, "capability denied"):
                        self.call("retry", expectedReceiptId=receipt)
                else:
                    self.assertFalse(self.call("retry", expectedReceiptId=receipt)["accepted"])
                self.assertEqual(self.q, before)
                (self.runner.RUNS / "run-1" / "exit.json").unlink()
                (self.runner.RUNS / "run-1").rmdir()
