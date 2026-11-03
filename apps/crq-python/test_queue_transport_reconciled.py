"""Reconciled-adoption tests for queue transport.

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
    def test_reconciled_read_adopts_without_enqueue_or_review_start(self):
        item = self.reconciled_fixture()
        before = copy.deepcopy(self.q)
        with mock.patch.object(receipts, "enroll", side_effect=AssertionError("no enqueue")):
            pending = self.call("status")
        self.assertEqual(pending["state"], "pending")
        self.assertFalse(pending["reviewed"] or pending["consumed"] or pending["fixed"])
        self.assertEqual(self.q["items"], before["items"])
        self.assertEqual(self.q["merged_current_requests"], before["merged_current_requests"])
        doc = {"version": 1, "request_id": self.request_id, "item_id": item["id"],
               "source": item["subject"], "capture": {}, "counted": True,
               "outcome": "terminal-with-findings", "classification": {"counted": True, "outcome": "completed"},
               "findings": [{"text": "fixture finding"}]}
        rid = receipts.write_receipt(self.tmp.name, doc)
        self.q["items"][0].update(state="done", receipt_id=rid)
        status = self.call("status")
        self.assertTrue(status["reviewed"])
        self.assertFalse(status["consumed"] or status["fixed"])
        manifest = self.call("report", receiptId=rid, cursor=None)["page"]
        for index in range(manifest["chunks"]):
            self.call("report", receiptId=rid, cursor=rid + ":" + str(index))
        ack = self.call("ack", receiptId=rid,
                        **{k: manifest[k] for k in ("sha256", "chunks", "bytes")})
        self.assertTrue(ack["consumed"])
        self.assertFalse(ack["fixed"])

    def test_reconciled_grants_do_not_replace_read_or_write_authority(self):
        self.reconciled_fixture()
        before = copy.deepcopy(self.q)
        grants = self.policy.pop("reconciled_reads")
        with self.assertRaises(ValueError):
            self.call("status")
        self.assertEqual(self.q, before)
        self.policy["reconciled_reads"] = grants
        self.policy["read"] = []
        with self.assertRaises(ValueError):
            self.call("status")
        self.assertEqual(self.q, before)
        self.policy["read"] = ["developer"]
        self.policy["write"] = []
        self.assertEqual(self.call("status")["state"], "pending")
        with self.assertRaises(ValueError):
            self.call("ack", receiptId="a" * 64, sha256="a" * 64, chunks=1, bytes=1)
        self.q["queue_client_requests"] = {self.request_id: {"principal": "other", "binding": self.b}}
        with self.assertRaisesRegex(ValueError, "principal mismatch"):
            self.call("status")

    def test_reconciled_policy_and_missing_or_duplicate_items_refuse(self):
        self.reconciled_fixture()
        policy = copy.deepcopy(self.policy)
        for grants in (None, {}, [None], [{}], [{**policy["reconciled_reads"][0], "extra": True}]):
            self.policy = {**policy, "reconciled_reads": grants}
            with self.subTest(grants=grants), self.assertRaises(ValueError):
                self.call("status")
        self.policy = policy
        valid = copy.deepcopy(self.q)
        for items in ([], self.q["items"] * 2):
            self.q = {**copy.deepcopy(valid), "items": items}
            before = copy.deepcopy(self.q)
            with self.assertRaises(ValueError):
                self.call("status")
            self.assertEqual(self.q, before)

    def test_duplicate_reconciled_grant_ids_refuse_before_queue_access(self):
        self.reconciled_fixture()
        grant = self.policy["reconciled_reads"][0]
        for principal in ("developer", "other"):
            self.policy["reconciled_reads"] = [grant, {**grant, "principal": principal}]
            with self.subTest(principal=principal), mock.patch.object(
                    self.runner, "load_queue", side_effect=AssertionError("no queue access")):
                with self.assertRaisesRegex(ValueError, "duplicate reconciled"):
                    self.call("status")

    def test_reconciled_adoption_requires_exact_stored_mapping(self):
        self.reconciled_fixture()
        valid = copy.deepcopy(self.q)
        original = valid["merged_current_requests"][self.request_id]
        for mapping in (None, {**original, "item": "wrong-item"},
                        {**original, "binding": {**original["binding"], "pr": 507}}):
            self.q = copy.deepcopy(valid)
            if mapping is None:
                del self.q["merged_current_requests"][self.request_id]
            else:
                self.q["merged_current_requests"][self.request_id] = mapping
            before = copy.deepcopy(self.q)
            with self.subTest(mapping=mapping), self.assertRaisesRegex(ValueError, "source mismatch"):
                self.call("status")
            self.assertEqual(self.q, before)

    def test_reconciled_adoption_revalidates_merge_identity(self):
        self.reconciled_fixture()
        before = copy.deepcopy(self.q)
        forge = copy.deepcopy(self.forge)
        for key, value in (("mergeSha", "e" * 40), ("state", "OPEN")):
            self.forge = {**forge, key: value}
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "forge merge mismatch"):
                self.call("status")
            self.assertEqual(self.q, before)

    def test_reconciled_adoption_malformed_queue_raises_value_error(self):
        self.reconciled_fixture()
        valid = copy.deepcopy(self.q)
        malformed = [None, [], {k: v for k, v in valid.items() if k != "items"}]
        for key, values in (("items", (None, {}, [None], ["invalid"])),
                            ("merged_current_requests", (None, [])),
                            ("queue_client_requests", (None, []))):
            malformed.extend({**valid, key: value} for value in values)
        for entry in (None, [], "invalid"):
            malformed.append({**valid, "queue_client_requests": {self.request_id: entry}})
        for queue in malformed:
            self.q = copy.deepcopy(queue)
            before = copy.deepcopy(self.q)
            with self.subTest(queue=queue), self.assertRaises(ValueError):
                self.call("status")
            self.assertEqual(self.q, before)

    def test_reconciled_adoption_is_exact_and_denials_are_atomic(self):
        self.reconciled_fixture()
        valid = copy.deepcopy(self.q)
        policy = copy.deepcopy(self.policy)
        for key, value in (("principal", "other"), ("requestId", "other"),
                           ("binding", {**self.b, "pr": 507}),
                           ("binding", {**self.b, "mergeSha": "e" * 40}),
                           ("binding", {**self.b, "targetSelector": "other"}),
                           ("binding", {**self.b, "repo": "other/repo"})):
            self.policy = copy.deepcopy(policy)
            self.policy["reconciled_reads"][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.call("status")
            self.assertEqual(self.q, valid)
        self.policy = policy
        self.forge["target"] = "unapproved"
        with self.assertRaises(ValueError):
            self.call("status")
        self.assertEqual(self.q, valid)
        self.forge["target"] = "merge-queue"
        self.q["items"][0]["subject"]["pr"] = 507
        with self.assertRaises(ValueError):
            self.call("status")
