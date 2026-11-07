"""Receipt snapshot/report/ack and wire-decode tests for queue transport.

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
    def test_large_receipt_restart_order_snapshot_and_ack(self):
        rid, doc = self.receipt()
        status = self.call("status")
        self.assertEqual(status["state"], "terminal-with-findings")
        self.assertFalse(status["consumed"])
        manifest = self.call("report", receiptId=rid, cursor=None)["page"]
        ack = {"receiptId": rid, **{k: manifest[k] for k in ("sha256", "chunks", "bytes")}}
        with self.assertRaisesRegex(ValueError, "complete"): self.call("ack", **ack)
        with self.assertRaisesRegex(ValueError, "order"): self.call("report", receiptId=rid, cursor=rid + ":1")
        chunks = []
        for i in range(manifest["chunks"]):
            page = self.call("report", receiptId=rid, cursor=f"{rid}:{i}")["page"]
            self.call("report", receiptId=rid, cursor=f"{rid}:{i}")  # reconnect/replay
            chunks.append(transport.base64.b64decode(page["data"]))
        self.assertEqual(json.loads(b"".join(chunks)), doc)
        self.assertTrue(self.call("ack", **ack)["consumed"])
        self.assertFalse(self.call("status")["fixed"])
        with self.assertRaises(ValueError): self.call("report", receiptId=rid, cursor="f" * 64 + ":0")
        Path(self.tmp.name, rid + ".json").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "digest"): self.call("status")

    def test_receipt_request_reads_once_bounded_and_matches_q1_pages(self):
        rid, doc = self.receipt()
        path = Path(self.tmp.name, rid + ".json")
        data = path.read_bytes()
        manifest = receipts.read_receipt(self.tmp.name, rid)
        first = receipts.read_receipt(self.tmp.name, rid, rid + ":0")
        self.assertGreater(manifest["chunks"], 10)
        # Each request gets a fresh verified snapshot, not one full read per page.
        for op, extra, expected in [("status", {}, None),
                ("report", {"receiptId": rid, "cursor": None}, manifest),
                ("report", {"receiptId": rid, "cursor": rid + ":0"}, first)]:
            stream = mock.MagicMock(wraps=io.BytesIO(data))
            stream.__enter__.return_value = stream
            original_open = Path.open
            def open_selected(path, *args, **kwargs):
                return stream if path == Path(self.tmp.name, rid + ".json") else original_open(path, *args, **kwargs)
            with mock.patch.object(Path, "open", autospec=True, side_effect=open_selected) as opened, \
                    mock.patch.object(receipts, "read_receipt", side_effect=AssertionError("per-page reread")):
                result = self.call(op, **extra)
            self.assertEqual(sum(call.args == (Path(self.tmp.name, rid + ".json"), "rb") for call in opened.call_args_list), 1)
            stream.read.assert_called_once_with(transport.MAX_RECEIPT_BYTES + 1)
            if expected is not None:
                self.assertEqual(result["page"], expected)

    def test_snapshot_pages_stay_bound_and_next_request_rejects_tampering(self):
        rid, doc = self.receipt()
        expected = receipts.read_receipt(self.tmp.name, rid, rid + ":0")
        self.call("report", receiptId=rid, cursor=None)
        original = transport._ReceiptSnapshot.page
        def replace_after_verification(snapshot, cursor=None):
            Path(self.tmp.name, rid + ".json").write_bytes(b"tampered")
            return original(snapshot, cursor)
        with mock.patch.object(transport._ReceiptSnapshot, "page", replace_after_verification):
            self.assertEqual(self.call("report", receiptId=rid, cursor=rid + ":0")["page"], expected)
        with self.assertRaisesRegex(ValueError, "digest"):
            self.call("status")

    def test_snapshot_capacity_and_authorization_fail_before_consumption(self):
        rid, doc = self.receipt()
        before = copy.deepcopy(self.q)
        with mock.patch.object(transport, "MAX_RECEIPT_BYTES", 32):
            with self.assertRaisesRegex(ValueError, "capacity"):
                self.call("report", receiptId=rid, cursor=None)
        self.assertEqual(self.q, before)
        self.policy["read"] = []
        with mock.patch.object(transport, "_ReceiptSnapshot") as snapshot:
            with self.assertRaisesRegex(ValueError, "denied"):
                self.call("report", receiptId=rid, cursor=None)
            snapshot.assert_not_called()
        self.policy["read"] = ["developer"]
        self.b["head"] = "f" * 40
        with mock.patch.object(transport, "_ReceiptSnapshot") as snapshot:
            with self.assertRaisesRegex(ValueError, "binding"):
                self.call("status")
            snapshot.assert_not_called()
        self.assertEqual(self.q, before)

    def test_strict_decode_wire_and_author_protocol_separation(self):
        for raw in [b'{"v":1,"v":1}', b"x" * 8193, b'{"v":2}', b'{"v":1,"op":"fallback"}',
                    b'{"v":1,"op":[],"requestId":"request-1","binding":{}}',
                    b'{"v":1,"op":{"kind":"status"}}',
                    b"[" * 4000 + b"]" * 4000]:  # nesting, not a caller-visible RecursionError
            with self.assertRaises(ValueError): transport.decode(raw)
        for binding in ({"kind": "merged-current", "repo": "owner/repo", "targetSelector": [],
                         "pr": 1, "mergeSha": "b" * 40},
                        {"kind": [], "repo": "owner/repo", "targetSelector": "promoted-main",
                         "pr": 1, "mergeSha": "b" * 40}):
            with self.assertRaises(ValueError): transport.binding(binding)
