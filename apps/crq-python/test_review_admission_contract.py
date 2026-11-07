"""Shared Python/TypeScript canonical review-operation vectors."""
import copy
import base64
import hashlib
import json
from pathlib import Path
import unittest

import review_operation as operation


class ContractTests(unittest.TestCase):
    def test_original_snapshot_and_chunk_bytes(self):
        vectors = json.loads((Path(__file__).parent / "fixtures/review-operation/vectors.json").read_text())
        values = {r["name"]: r["value"] for r in vectors}
        submit = values["unpublished-original-submit"]
        snapshot = submit["snapshot"]
        objects = snapshot["objects"]
        self.assertEqual([o["oid"] for o in objects], sorted({o["oid"] for o in objects}))
        checksum = hashlib.sha256()
        for obj in objects:
            data = base64.b64decode(obj["data"], validate=True)
            header = obj["type"].encode() + b" " + str(len(data)).encode() + b"\0"
            self.assertEqual(hashlib.sha1(header + data).hexdigest(), obj["oid"])
            checksum.update((obj["oid"] + "\0" + obj["type"] + "\0" + obj["data"] + "\n").encode())
        self.assertEqual(checksum.hexdigest(), snapshot["sha256"])
        head = next(o for o in objects if o["oid"] == submit["inputs"]["head_commit"])
        self.assertEqual(head["type"], "commit")
        self.assertTrue(base64.b64decode(head["data"]).startswith(
            ("tree " + submit["inputs"]["head_tree"] + "\n").encode()))
        chunk = values["result-chunk"]
        data = base64.b64decode(chunk["data"], validate=True)
        self.assertEqual(len(data), chunk["bytes"])
        self.assertEqual(hashlib.sha256(data).hexdigest(), chunk["sha256"])
        self.assertEqual(chunk["receipt_id"], chunk["sha256"])

    def test_shared_vectors(self):
        vectors = json.loads((Path(__file__).parent / "fixtures/review-operation/vectors.json").read_text())
        for row in vectors:
            with self.subTest(row["name"]):
                if not row["valid"]:
                    with self.assertRaises(ValueError):
                        operation.validate(row["type"], row["value"])
                    continue
                operation.validate(row["type"], row["value"])
                if row["type"] == "identity":
                    self.assertEqual(operation.canonical(row["value"]).decode(), row["canonical"])
                    self.assertEqual(operation.identity(row["value"]), row["sha256"])

    def test_equivalence_requires_known_profile_and_pinned_facts(self):
        rows = json.loads((Path(__file__).parent / "fixtures/review-operation/vectors.json").read_text())
        facts = rows[0]["value"]
        self.assertTrue(operation.equivalent(facts, copy.deepcopy(facts)))
        for field in ("repo", "base_commit", "head_commit", "projection", "config_digest"):
            changed = copy.deepcopy(facts)
            changed[field] = "other/repo" if field == "repo" else "f" * len(changed[field])
            self.assertFalse(operation.equivalent(facts, changed), field)
        changed = copy.deepcopy(facts)
        changed["profile"]["revision"] = "next"
        self.assertFalse(operation.equivalent(facts, changed))
        del changed["profile"]
        self.assertFalse(operation.equivalent(facts, changed))
