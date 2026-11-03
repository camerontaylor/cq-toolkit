"""Health-grant and offline-process-boundary tests for queue transport.

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
    def test_health_requires_explicit_grant_and_snapshot_slot(self):
        self.b = {"repo": "owner/repo", "targetSelector": "promoted-main"}
        self.policy["branches"] = []
        with self.assertRaisesRegex(ValueError, "health capability denied"):
            self.call("health")
        self.policy["health_reads"] = [{"principal": "developer", "binding": self.b}]
        self.q["client_health"] = {"complete": False, "incomplete_ticks": 4}
        with mock.patch.object(self.runner, "with_lock", side_effect=AssertionError("tick lock")):
            result = self.call("health")
        self.assertEqual(result["incompleteTicks"], 4)
        with mock.patch.object(transport, "_read_slot") as slot:
            slot.return_value.__enter__.return_value = False
            self.assertEqual(self.call("health")["error"]["code"], "busy")

    def test_health_grant_cannot_authorize_other_operations(self):
        health_binding = {"repo": "owner/repo", "targetSelector": "promoted-main"}
        self.policy["health_reads"] = [{"principal": "developer", "binding": health_binding}]
        self.b = health_binding
        for op in ("enqueue", "bind", "status", "report"):
            with self.subTest(op=op), self.assertRaises(ValueError):
                self.call(op)
        self.b = {**health_binding, "kind": "deferred-author", "producer": "health-client",
                  "head": "a" * 40, "target": "main"}
        with self.assertRaises(ValueError):
            self.call("health")

    def test_process_boundary_denies_absolute_shell_and_local_git_aliases(self):
        run_alias = subprocess.run
        for command, kwargs in (([sys.executable, "-c", "pass"], {}),
                ("true", {"shell": True, "executable": "/bin/sh"}),
                (["/usr/bin/git", "status"], {"cwd": self.tmp.name})):
            with self.subTest(command=command), self.assertRaisesRegex(AssertionError, "forbids child"):
                run_alias(command, **kwargs)
        system_alias = os.system
        with self.assertRaisesRegex(AssertionError, "forbids child"):
            system_alias("true")
