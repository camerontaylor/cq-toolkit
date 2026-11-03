"""Status-reason and vendor-provenance tests for queue transport.

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
    def test_structured_vendor_reason_and_unknown_fail_closed(self):
        rid, doc = self.receipt()
        for outcome, category in [("rate_limited", "unknown"), ("auth", "unknown"), ("action_required", "unknown"), ("error", "unknown"), ("blocked-secret-scan", "scan")]:
            doc.update(outcome=outcome, counted=False)
            self.q["items"][0]["receipt_id"] = receipts.write_receipt(self.tmp.name, doc)
            result = self.call("status")
            self.assertEqual(result["state"], "blocked")
            self.assertEqual(result["reason"]["category"], category)
            self.assertFalse(result["reviewed"])

    def test_legacy_outcomes_and_prose_never_grant_vendor_provenance(self):
        rid, doc = self.receipt()
        for outcome in ("rate_limited", "auth", "action_required", "error", "cancelled", "budget"):
            for classification in (None, {"outcome": outcome, "message": "rate limit login unavailable"},
                    {"outcome": outcome, "errors": [{"errorType": "rate_limit"}, {"errorType": "unknown"}]}):
                with self.subTest(outcome=outcome, classification=classification):
                    doc.update(outcome=outcome, counted=False, classification=classification)
                    self.q["items"][0]["receipt_id"] = receipts.write_receipt(self.tmp.name, doc)
                    result = self.call("status")
                    self.assertEqual(result["state"], "blocked")
                    self.assertEqual(result["reason"]["source"], "queue")
                    self.assertEqual(result["reason"]["category"], "unknown")
                    self.assertFalse(result["reviewed"])

    def test_vendor_provenance_requires_complete_all_causes_proof(self):
        rid, doc = self.receipt()
        vendor = {"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"}
        proof = {"version": 1, "complete": True, "causes": [vendor]}
        cls = {"outcome": "rate_limited", "counted": False, "exit": 1, "bad_lines": 0,
               "failure_provenance": proof}
        doc.update(outcome="rate_limited", counted=False, classification=cls)
        def status():
            self.q["items"][0]["receipt_id"] = receipts.write_receipt(self.tmp.name, doc)
            return self.call("status")
        for exit_code in (0, 1):
            for count in (1, 2, 50):
                with self.subTest(exit=exit_code, causes=count):
                    cls.update(exit=exit_code, failure_provenance={**proof, "causes": [vendor] * count})
                    result = status()
                    self.assertEqual(result["reason"], vendor)
                    self.assertFalse(result["reviewed"])
                    self.assertFalse(result["consumed"])
        # Both cause orders must refuse: no first-error authorization.
        hard_causes = [None, "rate_limit", {}, {**vendor, "extra": True},
            {**vendor, "source": "queue"}, {**vendor, "code": "rate_limit_unknown"},
            {**vendor, "category": "vendor-needs-action"},
        ]
        hard_causes.extend({"source": "queue", "category": "unknown", "code": code}
                           for code in ("unknown", "scan", "budget", "cancel", "auth", "action_required"))
        for hard in hard_causes:
            for causes in ([vendor, hard], [hard, vendor]):
                with self.subTest(causes=causes):
                    cls["failure_provenance"] = {**proof, "causes": causes}
                    self.assertEqual(status()["reason"]["source"], "queue")
        malformed = [None, [], {}, {**proof, "version": True}, {**proof, "version": 2},
            {**proof, "complete": False}, {**proof, "complete": 1},
            {**proof, "extra": True}, {**proof, "causes": []},
            {**proof, "causes": vendor}, {**proof, "causes": "rate_limit"}]
        for value in malformed:
            with self.subTest(proof=value):
                cls["failure_provenance"] = value
                self.assertEqual(status()["reason"]["source"], "queue")
        cls["failure_provenance"] = proof
        for key, values in (("exit", [None, True, 2, -15]), ("bad_lines", [None, True, 1]),
                            ("counted", [None, True, 0]), ("outcome", ["error", "auth", "completed"])):
            original = cls[key]
            for value in values:
                with self.subTest(field=key, value=value):
                    cls[key] = value
                    self.assertEqual(status()["reason"]["source"], "queue")
            cls[key] = original
        for outcome in ("error", "auth", "action_required", "cancelled", "budget", "blocked-secret-scan"):
            doc["outcome"] = outcome
            self.assertEqual(status()["reason"]["source"], "queue")
        doc.update(outcome="rate_limited", counted=True)
        self.assertEqual(status()["reason"]["source"], "queue")
        doc["counted"] = False
        reason = {"source": "queue", "category": "identity", "code": "forge-identity"}
        self.q["queue_client_requests"]["request-1"]["reason"] = reason
        self.assertEqual(status()["reason"], reason)
        self.assertFalse(status()["reviewed"])

    def test_persisted_identity_block_survives_reads_and_exact_revalidation_clears(self):
        self.call("enqueue")
        reason = {"source": "queue", "category": "identity", "code": "forge-identity"}
        self.q["queue_client_requests"]["request-1"]["reason"] = reason
        self.assertEqual(self.call("status")["reason"], reason)
        self.assertEqual(self.call("status")["state"], "blocked")
        self.forge["head"] = "e" * 40
        with self.assertRaises(ValueError): self.call("bind", pr=12, mergeSha=None)
        self.assertEqual(self.call("status")["reason"], reason)
        self.forge["head"] = self.b["head"]
        self.assertIsNone(self.call("bind", pr=12, mergeSha=None)["reason"])
        self.assertEqual(self.call("status")["state"], "awaiting-merge")
