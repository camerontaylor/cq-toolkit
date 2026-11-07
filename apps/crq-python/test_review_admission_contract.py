"""Shared Python/TypeScript canonical review-operation vectors."""
import copy
import json
from pathlib import Path
import unittest

import review_operation as operation


class ContractTests(unittest.TestCase):
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
