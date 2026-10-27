"""Offline contract tests for the Q1/Q3 receipt seam."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import review_receipt as receipt


class ReceiptTest(unittest.TestCase):
    def test_binding_idempotence_and_conflict(self):
        q = {"items": []}
        args = dict(repo="owner/repo", pr=42, merge_sha="a" * 40, request_id="r1", at="now")
        first = receipt.enroll(q, **args)
        again = receipt.enroll(q, **{**args, "request_id": "r2"})
        self.assertFalse(again["created"])
        self.assertIs(first["item"], again["item"])
        before = copy.deepcopy(q)
        with self.assertRaises(ValueError):
            receipt.enroll(q, **{**args, "merge_sha": "b" * 40})
        self.assertEqual(q, before)
        self.assertEqual(receipt.status(q, "r2")["state"], "pending")

    def test_large_finding_restart_complete_bytes_and_tamper(self):
        with tempfile.TemporaryDirectory() as td:
            doc = {"version": 1, "findings": [{"comment": "é" * 15000}], "paths": ["a"]}
            identity = receipt.write_receipt(td, doc)
            self.assertEqual(identity, receipt.write_receipt(td, doc))
            manifest = receipt.read_receipt(td, identity)
            cursor = manifest["cursor"]
            data = b""
            while cursor:
                page = receipt.read_receipt(Path(td), identity, cursor)
                self.assertLess(len(json.dumps(page).encode()), 8192)
                chunk = base64.b64decode(page["data"])
                self.assertEqual(hashlib.sha256(chunk).hexdigest(), page["chunk_sha256"])
                data += chunk
                cursor = page["next_cursor"]
            self.assertEqual(json.loads(data), doc)
            self.assertEqual(hashlib.sha256(data).hexdigest(), identity)
            with self.assertRaises(ValueError):
                receipt.read_receipt(td, identity, "b" * 64 + ":0")
            (Path(td) / (identity + ".json")).write_text("tampered")
            with self.assertRaises(ValueError):
                receipt.read_receipt(td, identity)
