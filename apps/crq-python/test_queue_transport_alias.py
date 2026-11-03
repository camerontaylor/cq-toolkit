"""Cross-source reuse and authenticated-alias tests for queue transport.

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
    def test_cross_source_reuse_requires_q1_exact_current_identity(self):
        rid, doc = self.receipt()
        paths = [{"source_path": "src/a.ts", "path": "src/a.ts",
                  "resolution": "same-path-current", "disposition": "included"}]
        capture = {"target": "c" * 40, "tree": "d" * 40, "paths": paths,
                   "scope_digest": receipts.digest(paths), "policy": receipts.POLICY,
                   "projection": "current-affected-files/full-file-addition-projection",
                   "reviewer": "coderabbit-review-agent-committed-v1", "reviewer_version": "fixture"}
        capture["equivalence"] = receipts.current_equivalence(capture)
        doc["capture"] = capture
        doc["source"] = {**doc["source"], "pr": 99, "merge_sha": "f" * 40}
        self.q["items"][0].update(receipt_id=receipts.write_receipt(self.tmp.name, doc),
                                   capture=copy.deepcopy(capture), reused_from="original-item")
        self.assertEqual(self.call("status")["state"], "reused")
        self.q["items"][0]["capture"]["tree"] = "e" * 40
        with self.assertRaisesRegex(ValueError, "equivalent"): self.call("status")

    def test_cross_source_noncounted_receipts_can_be_consumed_without_credit(self):
        _, template = self.receipt()
        for outcome in ('no-current-code', 'unsupported'):
            with self.subTest(outcome=outcome):
                doc = copy.deepcopy(template)
                paths = []
                capture = dict(target='c' * 40, tree='d' * 40, paths=paths,
                               scope_digest=receipts.digest(paths), policy=receipts.POLICY,
                               projection='current-affected-files/full-file-addition-projection',
                               reviewer='coderabbit-review-agent-committed-v1', reviewer_version='fixture')
                capture['equivalence'] = receipts.current_equivalence(capture)
                doc.update(capture=capture, outcome=outcome, counted=False,
                           classification=None, independent_acceptance=False)
                doc['source'] = {**doc['source'], 'pr': 99, 'merge_sha': 'f' * 40}
                rid = receipts.write_receipt(self.tmp.name, doc)
                self.q['items'][0].update(receipt_id=rid, capture=copy.deepcopy(capture),
                                          reused_from='original-item')
                status = self.call('status')
                self.assertEqual(status['state'], outcome)
                self.assertIsNone(status['reason'])
                self.assertFalse(status['reviewed'])
                self.assertFalse(status['fixed'])
                manifest = self.call('report', receiptId=rid, cursor=None)['page']
                for index in range(manifest['chunks']):
                    self.call('report', receiptId=rid, cursor=f'{rid}:{index}')
                result = self.call('ack', receiptId=rid,
                                   **{k: manifest[k] for k in ('sha256', 'chunks', 'bytes')})
                self.assertTrue(result['consumed'])
                self.assertEqual(result['state'], outcome)
                self.assertIsNone(result['reason'])
                self.assertFalse(result['reviewed'])
                self.assertEqual(result['receiptSource']['pr'], 99)
                self.q['items'][0]['capture']['tree'] = 'e' * 40
                with self.assertRaisesRegex(ValueError, 'equivalent'):
                    self.call('status')

    def test_authenticated_alias_original_q1_principal_and_request_specific_delivery(self):
        doc = self.alias_fixture()
        result = self.call("status")
        proof = result["requestAlias"]
        self.assertEqual(proof["reference"], {"requestId": "request-1", "binding": self.b})
        self.assertEqual(proof["originalRequestId"], "original-1")
        self.assertEqual(proof["itemId"], doc["item_id"])
        self.assertEqual(proof["receiptId"], self.q["items"][0]["receipt_id"])
        self.assertEqual(proof["receiptEquivalence"], receipts.current_equivalence(doc["capture"]))
        self.assertNotIn("original-1", self.q["queue_client_requests"])
        manifest = self.call("report", receiptId=proof["receiptId"], cursor=None)["page"]
        ack = {"receiptId": proof["receiptId"], **{k: manifest[k] for k in ("sha256", "chunks", "bytes")}}
        with self.assertRaisesRegex(ValueError, "complete"): self.call("ack", **ack)
        for index in range(manifest["chunks"]):
            self.call("report", receiptId=proof["receiptId"], cursor=proof["receiptId"] + ":" + str(index))
        consumed = self.call("ack", **ack)
        self.assertTrue(consumed["consumed"])
        self.assertEqual(consumed["requestAlias"], proof)
        self.assertEqual(self.call("ack", **ack)["requestAlias"], proof)
        self.assertEqual(doc["request_id"], "original-1")

    def test_alias_proof_rejects_malformed_mapping_item_source_and_capture(self):
        doc = self.alias_fixture()
        valid = copy.deepcopy(self.q)
        def original(q): del q["merged_current_requests"]["original-1"]
        def alias_binding(q): q["merged_current_requests"]["request-1"]["binding"]["pr"] = 99
        def original_binding(q): q["merged_current_requests"]["original-1"]["binding"]["policy"] = "other"
        def other_item(q): q["merged_current_requests"]["original-1"]["item"] = "other-item"
        def duplicate(q): q["items"].append(copy.deepcopy(q["items"][0]))
        def nondeterministic(q):
            q["items"][0]["id"] = "arbitrary-item"
            for value in q["merged_current_requests"].values(): value["item"] = "arbitrary-item"
        def wrong_kind(q): q["items"][0]["kind"] = "author"
        def wrong_pr(q): q["items"][0]["pr"] = 99
        def wrong_merge(q): q["items"][0]["merge_commit"] = "f" * 40
        def wrong_original(q): q["items"][0]["request_id"] = None
        def wrong_subject(q): q["items"][0]["subject"]["policy"] = "other"
        def stale_capture(q): q["items"][0]["capture"]["tree"] = "f" * 40
        def stale_retained(q): q["items"][0]["capture"]["equivalence"] = "f" * 64
        for mutate in (original, alias_binding, original_binding, other_item, duplicate,
                       nondeterministic, wrong_kind, wrong_pr, wrong_merge, wrong_original,
                       wrong_subject, stale_capture, stale_retained):
            self.q = copy.deepcopy(valid)
            mutate(self.q)
            before = copy.deepcopy(self.q)
            with self.subTest(fault=mutate.__name__), self.assertRaises(ValueError): self.call("status")
            self.assertEqual(self.q, before)
        for field, value in (("request_id", "forged-original"), ("item_id", "other-item"),
                             ("source", {**doc["source"], "policy": "other"})):
            self.q = copy.deepcopy(valid)
            changed = {**doc, field: value}
            self.q["items"][0]["receipt_id"] = receipts.write_receipt(self.tmp.name, changed)
            with self.subTest(document=field), self.assertRaises(ValueError): self.call("status")
        self.q = copy.deepcopy(valid)
        changed = copy.deepcopy(doc)
        changed["capture"]["equivalence"] = "f" * 64
        self.q["items"][0]["receipt_id"] = receipts.write_receipt(self.tmp.name, changed)
        with self.assertRaises(ValueError): self.call("status")

    def test_alias_authorization_identity_pause_and_noncounted_do_not_gain_credit(self):
        doc = self.alias_fixture()
        self.policy["read"] = []
        with self.assertRaisesRegex(ValueError, "denied"): self.call("status")
        self.policy["read"] = ["developer"]
        self.b["head"] = "f" * 40
        with self.assertRaisesRegex(ValueError, "binding"): self.call("status")
        self.b["head"] = "a" * 40
        self.q["queue_client_requests"]["request-1"]["reason"] = {
            "source": "queue", "category": "identity", "code": "forge-identity"}
        blocked = self.call("status")
        self.assertIsNone(blocked.get("requestAlias"))
        self.assertFalse(blocked["reviewed"])
        self.q["queue_client_requests"]["request-1"].pop("reason")
        doc.update(outcome="no-current-code", counted=False, classification={"counted": False})
        self.q["items"][0]["receipt_id"] = receipts.write_receipt(self.tmp.name, doc)
        result = self.call("status")
        self.assertIsNotNone(result["requestAlias"])
        self.assertFalse(result["reviewed"])
        self.assertFalse(result["consumed"])
        self.assertEqual(result["state"], "no-current-code")
