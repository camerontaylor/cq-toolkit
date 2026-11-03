"""Read-slot, forge-cache and read-only-discipline tests for queue transport.

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
    def test_read_slots_refuse_before_queue_load_and_release_after_error(self):
        self.call("enqueue")
        with transport._read_slot(self.tmp.name) as first, transport._read_slot(self.tmp.name) as second:
            self.assertTrue(first and second)
            with mock.patch.object(self.runner, "load_queue", side_effect=AssertionError("capacity")):
                self.assertEqual(self.call("status"), {"error": {"code": "busy", "retryable": True}})
        with mock.patch.object(self.runner, "load_queue", side_effect=ValueError("bad queue")):
            with self.assertRaisesRegex(ValueError, "bad queue"):
                self.call("status")
        self.assertIn("snapshot", self.call("status"))

    def test_reconciled_forge_cache_survives_reads_expires_and_is_principal_scoped(self):
        item = self.reconciled_fixture()
        doc = {"version": 1, "source": item["subject"], "capture": {}, "counted": False,
               "outcome": "no-current-code", "classification": {"counted": False, "outcome": "no-current-code"}}
        rid = receipts.write_receipt(self.tmp.name, doc)
        item.update(state="done", receipt_id=rid)
        with mock.patch.object(transport, "_forge", wraps=transport._forge) as forge, \
                mock.patch.object(transport.time, "time", return_value=1000):
            for _ in range(3):
                self.call("status")
                manifest = self.call("report", receiptId=rid, cursor=None)["page"]
                for index in range(manifest["chunks"]):
                    self.call("report", receiptId=rid, cursor=f"{rid}:{index}")
            self.assertEqual(forge.call_count, 1)
            self.policy["read"] = []
            with self.assertRaisesRegex(ValueError, "denied"):
                self.call("status")
            self.assertEqual(forge.call_count, 1)
            self.policy["read"] = ["developer"]
            with mock.patch.object(transport.time, "time", return_value=1301):
                self.call("status")
            self.assertEqual(forge.call_count, 2)
            transport._cached_forge(self.tmp.name, "other", self.request_id, self.b,
                                    lambda repo, pr: self.forge, self.policy)
            self.assertEqual(forge.call_count, 3)
        self.assertEqual(len(list(Path(self.tmp.name, "deliveries").glob("*.lock"))), 1)
        self.assertEqual(self.q.get("queue_client_requests", {}), {})

    def test_forge_cache_releases_lock_during_fetch_and_preserves_other_insert(self):
        self.reconciled_fixture()
        def fetch(repo, pr):
            with Path(self.tmp.name, "read-forge-cache.lock").open("a") as lock:
                transport.fcntl.flock(lock, transport.fcntl.LOCK_EX | transport.fcntl.LOCK_NB)
            transport._cached_forge(self.tmp.name, "developer", "other-request", self.b,
                                    lambda repo, pr: self.forge, self.policy)
            return self.forge
        transport._cached_forge(self.tmp.name, "developer", self.request_id, self.b, fetch, self.policy)
        cache = json.loads(Path(self.tmp.name, "read-forge-cache.json").read_text())
        self.assertEqual(len(cache), 2)
        with mock.patch.object(transport, "_forge", side_effect=AssertionError("cached")):
            for rid in (self.request_id, "other-request"):
                transport._cached_forge(self.tmp.name, "developer", rid, self.b, fetch, self.policy)

    def test_forge_cache_capacity_is_bounded(self):
        self.reconciled_fixture()
        with mock.patch.object(transport, "FORGE_CACHE_LIMIT", 2):
            for index in range(5):
                transport._cached_forge(self.tmp.name, "developer", f"request-{index}", self.b,
                                        lambda repo, pr: self.forge, self.policy)
        cache = json.loads(Path(self.tmp.name, "read-forge-cache.json").read_text())
        self.assertEqual(len(cache), 2)

    def test_reads_do_not_lock_or_save_queue(self):
        rid, _ = self.receipt()
        before = copy.deepcopy(self.q)
        with mock.patch.object(self.runner, "with_lock", side_effect=AssertionError("tick held")), \
                mock.patch.object(self.runner, "save_queue", side_effect=AssertionError("read wrote queue")):
            self.assertIn("snapshot", self.call("status"))
            self.assertIn("snapshot", self.call("report", receiptId=rid, cursor=None))
        self.assertEqual(self.q, before)
