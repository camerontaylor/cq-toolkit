"""Inventory (reconciled-read projection) tests for queue transport.

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
    def test_inventory_stale_cursor_and_snapshot_identity(self):
        self.inventory_fixture()
        first = self.inventory_call()
        self.q["snapshot-change"] = True
        changed = self.inventory_call()
        self.assertEqual(first["snapshot"], changed["snapshot"])
        self.assertIn("entries", self.inventory_call(cursor=first["nextCursor"]))
        self.q["queue_client_requests"] = {self.request_id: {"principal": "other", "binding": self.b}}
        self.assertEqual(self.inventory_call(cursor=first["nextCursor"])["error"],
                         {"code": "stale-cursor", "retryable": False, "restart": True})
        self.assertEqual(self.inventory_call(cursor="invalid")["error"]["code"], "stale-cursor")

    def test_filtered_inventory_ignores_changes_outside_selected_rows(self):
        self.inventory_fixture()
        first = self.inventory_call(states=["missing"])
        self.q["items"][0]["last_error"] = "unrelated pending detail"
        second = self.inventory_call(states=["missing"], cursor=first["nextCursor"])
        self.assertEqual(first["snapshot"], second["snapshot"])
        self.assertTrue(second["terminal"])

    def test_inventory_saved_queue_read_while_real_tick_lock_held(self):
        self.inventory_fixture()
        queue = Path(self.tmp.name) / "queue.json"
        queue.write_bytes(receipts.canonical(self.q))
        self.runner.QUEUE = queue
        with (Path(self.tmp.name) / "tick.lock").open("a") as tick:
            transport.fcntl.flock(tick, transport.fcntl.LOCK_EX | transport.fcntl.LOCK_NB)
            with mock.patch.object(self.runner, "load_queue", side_effect=lambda: json.loads(queue.read_text())), \
                    mock.patch.object(self.runner, "with_lock", side_effect=AssertionError("tick held")):
                first = self.inventory_call()
                self.assertEqual(first["proof"]["count"], 3)
                cursor = first["nextCursor"]
                for _ in range(2):
                    for revision in range(20):
                        unrelated = {**self.q, "unrelated": revision}
                        replacement = queue.with_suffix(".new")
                        replacement.write_bytes(receipts.canonical(unrelated))
                        replacement.replace(queue)
                    page = self.inventory_call(cursor=cursor)
                    self.assertEqual(page["snapshot"], first["snapshot"])
                    cursor = page["nextCursor"]
                self.assertTrue(page["terminal"])

    def test_queue_access_time_change_does_not_return_busy(self):
        self.inventory_fixture()
        queue = Path(self.tmp.name) / "queue.json"
        queue.write_bytes(receipts.canonical(self.q))
        self.runner.QUEUE = queue
        def load():
            stat = queue.stat()
            os.utime(queue, ns=(stat.st_atime_ns + 1000000000, stat.st_mtime_ns))
            return json.loads(queue.read_text())
        with mock.patch.object(self.runner, "load_queue", side_effect=load):
            self.assertEqual(self.inventory_call()["proof"]["count"], 3)

    def test_checkpoint_replacement_during_projection_returns_busy(self):
        path = self.inventory_fixture()
        original = receipts.status
        def replace(q, rid):
            result = original(q, rid)
            path.write_text("{}")
            return result
        with mock.patch.object(receipts, "status", side_effect=replace):
            self.assertEqual(self.inventory_call()["error"], {"code": "busy", "retryable": True})

    def test_inventory_missing_pagination_digest_and_read_only(self):
        self.inventory_fixture()
        before = copy.deepcopy(self.q)
        first = self.inventory_call()
        self.assertEqual(first["entries"][0]["pr"], 504)
        self.assertEqual(first["entries"][0]["state"], "missing")
        self.assertFalse(first["terminal"])
        second = self.inventory_call(cursor=first["nextCursor"])
        self.assertEqual(second["entries"][0]["state"], "pending")
        last = self.inventory_call(cursor=second["nextCursor"])
        self.assertTrue(last["terminal"])
        self.assertIsNone(last["nextCursor"])
        self.assertEqual(first["proof"], last["proof"])
        self.assertEqual(first, self.inventory_call())
        self.assertEqual(before, self.q)
        pending = self.inventory_call(states=["pending", "blocked"])
        self.assertEqual(pending["proof"]["selectedCount"], 1)
        self.assertTrue(pending["terminal"])

    def test_fixed_status_and_inventory_share_exact_receipt_evidence(self):
        self.runner.CONFIG = {"queue": {"project_fixed": True}}
        self.inventory_fixture()
        item = self.q["items"][0]
        item["capture"] = {}
        doc = dict(source=item["subject"], capture={}, findings=[{"comment": "fixture"}],
                   counted=True, outcome="terminal-with-findings",
                   classification={"counted": True, "outcome": "completed"})
        rid = receipts.write_receipt(self.tmp.name, doc)
        item.update(state="done", receipt_id=rid)
        self.call("enqueue")
        self.assertFalse(self.call("status")["fixed"])
        self.assertEqual(self.inventory_call(states=["fixed"])["entries"], [])
        item = self.q["items"][0]
        item["remediation"] = dict(receipt_id=rid, subject=item["subject"], capture_digest=receipts.digest({}),
                                   findings=[receipts.digest(doc["findings"][0])], fix_pr=8,
                                   merge="a" * 40, head="b" * 40, target="c" * 40)
        for config in ({}, {"queue": None}, {"queue": {"project_fixed": False}}):
            self.runner.CONFIG = config
            status = self.call("status")
            self.assertFalse(status["fixed"])
            self.assertNotIn("remediation", status)
            report = self.call("report", receiptId=rid, cursor=None)
            self.assertEqual(set(report) - {"snapshot"}, {"page"})
            self.assertNotIn("remediation", report)
            rows = self.inventory_call(states=["reviewed"])["entries"]
            self.assertEqual(rows[0]["state"], "reviewed")
            self.assertEqual(set(rows[0]), {"pr", "mergeSha", "requestId", "itemId", "state", "reason"})
            self.assertEqual(self.inventory_call(states=["fixed"])["entries"], [])
            self.assertIn("remediation", self.q["items"][0])
        self.runner.CONFIG = {"queue": {"project_fixed": True}}
        status = self.call("status")
        self.assertEqual(status["state"], "terminal-with-findings")
        self.assertTrue(status["fixed"] and status["reviewed"])
        self.assertFalse(status["consumed"])
        self.assertEqual(self.inventory_call(states=["fixed"])["entries"][0]["state"], "fixed")
        self.q["queue_client_requests"][self.request_id]["consumed"] = rid
        row = self.inventory_call(states=["consumed"])["entries"][0]
        self.assertEqual(row["state"], "consumed")
        self.assertTrue(row["fixed"] and row["consumed"] and row["reviewed"])
        self.assertEqual(self.inventory_call(states=["fixed"])["entries"][0]["state"], "consumed")
        self.assertEqual(self.call("status")["remediation"]["captureDigest"], receipts.digest({}))
        self.runner.CONFIG = {"queue": {"project_fixed": False}}
        legacy = self.inventory_call(states=["consumed"])["entries"][0]
        self.assertEqual(legacy["state"], "consumed")
        self.assertEqual(set(legacy), {"pr", "mergeSha", "requestId", "itemId", "state", "reason"})
        self.assertEqual(self.inventory_call(states=["fixed"])["entries"], [])
        self.assertEqual(self.inventory_call(states=["reviewed"])["entries"], [])
        self.assertFalse(self.call("status")["fixed"])
        self.runner.CONFIG = {"queue": {"project_fixed": True}}
        self.q["queue_client_requests"][self.request_id]["reason"] = {
            "source": "queue", "category": "identity", "code": "forge-identity"}
        blocked = self.call("status")
        self.assertEqual(blocked["state"], "blocked")
        self.assertFalse(blocked["fixed"])
        self.assertNotIn("remediation", blocked)
        self.q["queue_client_requests"][self.request_id].pop("reason")
        self.assertTrue(self.call("status")["fixed"])
        self.q["items"][0]["remediation"]["receipt_id"] = "0" * 64
        self.assertFalse(self.call("status")["fixed"])
        self.assertEqual(self.inventory_call(states=["fixed"])["entries"], [])
        doc['outcome'] = 'partial-scope'
        self.q['items'][0]['receipt_id'] = receipts.write_receipt(self.tmp.name, doc)
        status = self.call('status')
        self.assertEqual(status['state'], 'partial-scope')
        self.assertFalse(status['fixed'])
        self.assertEqual(self.inventory_call(states=['fixed'])['entries'], [])

    def test_inventory_verified_review_consumed_and_blocked(self):
        self.inventory_fixture()
        item = self.q["items"][0]
        doc = {"source": item["subject"], "counted": True, "outcome": "terminal-with-findings",
               "classification": {"counted": True, "outcome": "completed"}}
        receipt_id = receipts.write_receipt(self.tmp.name, doc)
        item.update(state="done", receipt_id=receipt_id)
        self.assertEqual(self.inventory_call(states=["reviewed"])["entries"][0]["pr"], 506)
        with mock.patch.object(transport, "MAX_RECEIPT_BYTES", 1):
            blocked = self.inventory_call(states=["blocked"])["entries"][0]
            self.assertEqual(blocked["reason"]["code"], "inventory-receipt-budget")
        self.call("status")
        self.call("enqueue")
        self.q["queue_client_requests"][self.request_id]["consumed"] = receipt_id
        self.q["merged_current_requests"]["aaa-unowned"] = copy.deepcopy(
            self.q["merged_current_requests"][self.request_id])
        self.assertEqual(self.inventory_call(states=["consumed"])["entries"][0]["pr"], 506)
        self.q["queue_client_requests"][self.request_id]["reason"] = {
            "source": "queue", "category": "identity", "code": "forge-identity"}
        blocked = self.inventory_call(states=["blocked"])["entries"][0]
        self.assertEqual(blocked["reason"]["code"], "forge-identity")

    def test_inventory_reused_and_no_current_code_are_not_blocked(self):
        retained = self.alias_fixture()
        self.q = {"items": []}
        self.inventory_fixture()
        item = self.q["items"][0]
        item["capture"] = retained["capture"]
        retained["source"] = {**item["subject"], "pr": 505}
        item.update(state="done", reused_from="original-review",
                    receipt_id=receipts.write_receipt(self.tmp.name, retained))
        self.assertEqual(self.inventory_call(states=["reused"])["entries"][0]["state"], "reused")
        self.assertEqual(self.inventory_call(states=["pending", "blocked"])["entries"], [])
        self.q["queue_client_requests"] = {self.request_id: {
            "principal": "developer", "binding": self.b, "state": "ready-current",
            "pr": 506, "mergeSha": "b" * 40, "consumed": item["receipt_id"]}}
        self.assertEqual(self.inventory_call(states=["consumed"])["entries"][0]["state"], "consumed")
        retained["capture"]["tree"] = "f" * 40
        item["receipt_id"] = receipts.write_receipt(self.tmp.name, retained)
        self.assertEqual(self.inventory_call(states=["blocked"])["entries"][0]["reason"]["code"], "receipt-source")
        doc = {"source": item["subject"], "outcome": "no-current-code", "counted": False,
               "classification": {"outcome": "no-current-code", "counted": False}}
        item.pop("reused_from")
        item["receipt_id"] = receipts.write_receipt(self.tmp.name, doc)
        self.assertEqual(self.inventory_call(states=["no-current-code"])["entries"][0]["state"], "no-current-code")
        doc["outcome"] = "unsupported"
        item["receipt_id"] = receipts.write_receipt(self.tmp.name, doc)
        unsupported = self.inventory_call(states=["unsupported"])["entries"][0]
        self.assertEqual(unsupported["state"], "unsupported")
        self.assertIsNone(unsupported["reason"])
        self.assertEqual(self.inventory_call(states=["pending", "blocked"])["entries"], [])

    def test_inventory_scan_block_matches_status(self):
        self.inventory_fixture()
        item = self.q["items"][0]
        self.call("status")
        doc = {"source": item["subject"], "counted": False, "outcome": "blocked-secret-scan",
               "classification": {"counted": False, "outcome": "blocked-secret-scan"}}
        item.update(state="blocked", receipt_id=receipts.write_receipt(self.tmp.name, doc))
        row = self.inventory_call(states=["blocked"])["entries"][0]
        scan_reason = {"source": "queue", "category": "scan", "code": "blocked-secret-scan"}
        self.assertEqual((row["state"], row["reason"]), ("blocked", scan_reason))
        self.assertEqual(self.call("status")["reason"], scan_reason)

    def test_inventory_real_wrapper_refuses_incomplete_dry_run_and_corruption(self):
        path = self.inventory_fixture()
        valid = json.loads(path.read_text())
        self.assertEqual(self.inventory_call()["proof"]["count"], 3)
        for fault in ("incomplete", "dry_run", "source", "wrapper_digest"):
            wrapper = copy.deepcopy(valid)
            cp = wrapper["checkpoint"]
            if fault == "incomplete":
                cp.update(complete=False, cursor="next", cursor_history=["next"])
            elif fault == "dry_run":
                cp["dry_run"] = True
            elif fault == "source":
                wrapper["source"]["repo"] = "other/repo"
            cp["summary"] = reconcile.summarize(cp)
            cp["digest"] = reconcile.checkpoint_digest(cp)
            wrapper["digest"] = receipts.digest({k: v for k, v in wrapper.items() if k != "digest"})
            if fault == "wrapper_digest":
                wrapper["digest"] = "0" * 64
            path.write_text(json.dumps(wrapper))
            with self.subTest(fault=fault), self.assertRaises((ValueError, reconcile.ReconcileRefused)):
                self.inventory_call()

    def test_inventory_validates_unowned_mapping_and_item(self):
        self.inventory_fixture()
        valid = copy.deepcopy(self.q)
        def mapping(q): q["merged_current_requests"][self.request_id]["item"] = "other"
        def subject(q): q["items"][0]["subject"] = {**q["items"][0]["subject"], "policy": "wrong"}
        def kind(q): q["items"][0]["kind"] = "promotion"
        def pr(q): q["items"][0]["pr"] = 999
        def merge(q): q["items"][0]["merge_commit"] = "f" * 40
        def duplicate(q): q["items"].append(copy.deepcopy(q["items"][0]))
        for fault in (mapping, subject, kind, pr, merge, duplicate):
            self.q = copy.deepcopy(valid)
            fault(self.q)
            with self.subTest(fault=fault.__name__), self.assertRaisesRegex(ValueError, "mismatch"):
                self.inventory_call()

    def test_inventory_filter_order_and_duplicates_preserve_cursor(self):
        self.inventory_fixture()
        first = self.inventory_call(states=["pending", "missing", "pending"])
        canonical = self.inventory_call(states=["missing", "pending"])
        self.assertEqual(first, canonical)
        second = self.inventory_call(states=["pending", "missing"], cursor=first["nextCursor"])
        self.assertEqual(second["entries"][0]["pr"], 506)

    def test_inventory_isolation_denied_interval_busy_and_incomplete(self):
        path = self.inventory_fixture()
        self.call("enqueue")
        self.q["queue_client_requests"][self.request_id]["principal"] = "someone-else"
        result = self.inventory_call(states=["pending"])
        self.assertEqual(result["entries"], [])
        self.assertNotIn(self.request_id, json.dumps(self.inventory_call(limit=10)))
        with self.assertRaisesRegex(ValueError, "denied"):
            self.inventory_call(binding={**self.inventory_scope, "before": "2026-11-01T00:00:00Z"})
        with mock.patch.object(self.runner, "with_lock", return_value=None):
            self.assertEqual(self.inventory_call()["proof"]["count"], 3)
        doc = json.loads(path.read_text())
        doc["checkpoint"]["digest"] = "0" * 64
        path.write_text(json.dumps(doc))
        with self.assertRaises(reconcile.ReconcileRefused):
            self.inventory_call()
