"""Capability-dispatcher tests for queue transport.

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
    def test_dispatcher_real_permission_failure_remains_nonzero(self):
        with mock.patch.object(dispatcher, "queue_main", side_effect=ValueError("denied")), \
                mock.patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": "queue-v1"}), \
                mock.patch.object(sys, "argv", ["dispatcher"]), \
                mock.patch.object(sys, "stderr", new_callable=io.StringIO) as stderr:
            self.assertEqual(dispatcher.main(), 2)
            self.assertEqual(stderr.getvalue(), "queue capability refused; no permission\n")

    def test_dispatcher_refuses_malformed_policy_before_runner_import(self):
        policy_path = Path(self.tmp.name, "policy.json")
        request = receipts.canonical({"v": 1, "op": "enqueue", "requestId": "request-1", "binding": self.b})
        original_import = builtins.__import__
        def offline_import(name, *args, **kwargs):
            if name == "crq":
                raise AssertionError("runner must not be imported")
            return original_import(name, *args, **kwargs)
        for policy in self.malformed_policies():
            policy_path.write_text(json.dumps(policy))
            output = io.BytesIO()
            with self.subTest(policy=policy), mock.patch.dict(os.environ, {
                    "CRQ_QUEUE_POLICY": str(policy_path), "CRQ_QUEUE_PRINCIPAL": "developer",
                    "SSH_ORIGINAL_COMMAND": "queue-v1"}), \
                    mock.patch.object(sys, "argv", ["capability_dispatcher.py"]), \
                    mock.patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(request))), \
                    mock.patch.object(sys, "stdout", SimpleNamespace(buffer=output)), \
                    mock.patch.object(sys, "stderr", io.StringIO()), \
                    mock.patch("signal.signal"), mock.patch("signal.alarm"), \
                    mock.patch("builtins.__import__", side_effect=offline_import) as imports, \
                    mock.patch.object(transport, "handle") as handle:
                self.assertEqual(dispatcher.main(), 2)
                self.assertEqual(output.getvalue(), b"")
                handle.assert_not_called()
                self.assertNotIn("crq", [call.args[0] for call in imports.call_args_list])
        # Well-formed missing/false activation returns bounded unsupported without importing crq.
        for enabled in (False, None):
            policy = {**self.policy, "enabled": False}
            if enabled is None:
                del policy["enabled"]
            policy_path.write_text(json.dumps(policy))
            output = io.BytesIO()
            with mock.patch.dict(os.environ, {"CRQ_QUEUE_POLICY": str(policy_path),
                    "CRQ_QUEUE_PRINCIPAL": "developer"}), \
                    mock.patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(request))), \
                    mock.patch.object(sys, "stdout", SimpleNamespace(buffer=output)), \
                    mock.patch("signal.signal"), mock.patch("signal.alarm"), \
                    mock.patch("builtins.__import__", side_effect=offline_import) as imports:
                self.assertEqual(dispatcher.queue_main(), 0)
                self.assertIn("unsupported", json.loads(output.getvalue())["result"])
                self.assertNotIn("crq", [call.args[0] for call in imports.call_args_list])

    def test_dispatcher_outer_lock_busy_is_typed_and_denied_before_lock(self):
        policy_path = Path(self.tmp.name) / "policy.json"
        policy_path.write_text(json.dumps(self.policy))
        request = receipts.canonical({"v": 1, "op": "status", "requestId": "request-1", "binding": self.b})
        self.call("enqueue")
        fake = SimpleNamespace(REPO="owner/repo", STATE=Path(self.tmp.name), enqueue_merged=lambda: None, verify_deferred_source=lambda repo, pr: {},
                               load_queue=self.runner.load_queue)
        for principal in ("developer", "stranger"):
            output = io.BytesIO()
            with mock.patch.dict(os.environ, {"CRQ_QUEUE_POLICY": str(policy_path),
                    "CRQ_QUEUE_PRINCIPAL": principal}), \
                    mock.patch.dict(sys.modules, {"crq": fake}), \
                    mock.patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(request))), \
                    mock.patch.object(sys, "stdout", SimpleNamespace(buffer=output)), \
                    mock.patch("signal.signal"), mock.patch("signal.alarm"), \
                    mock.patch("author_transport.supervised", return_value=None) as supervised:
                if principal == "stranger":
                    with self.assertRaisesRegex(ValueError, "denied"):
                        dispatcher.queue_main()
                    supervised.assert_not_called()
                else:
                    self.assertEqual(dispatcher.queue_main(), 0)
                    self.assertEqual(json.loads(output.getvalue())["result"]["state"], "awaiting-pr")
                    supervised.assert_not_called()

    def test_exact_command_dispatch_only(self):
        calls = []
        self.assertEqual(dispatcher.dispatch("author-v1", lambda: calls.append("author") or 0, lambda: 1), 0)
        self.assertEqual(dispatcher.dispatch("queue-v1", lambda: 0, lambda: calls.append("queue") or 1), 1)
        for command in [None, "queue-v1 ", "author-v1; id", "queue-v1 --path=/tmp", "sh"]:
            with self.assertRaises(ValueError): dispatcher.dispatch(command, lambda: 0, lambda: 0)
        self.assertEqual(calls, ["author", "queue"])
