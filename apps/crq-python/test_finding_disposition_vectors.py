"""Checks for the checked-in finding-disposition oracle vectors.

``finding_disposition_vectors.py`` drives the real ``finding_delivery.Inbox``
(``context_error``, ``recovered_anchor``, ``triage``, ``repair_outcome``) over a
temporary root. This test only proves the committed file is the current
deterministic output and stays public/synthetic; the TypeScript test
``test/ops/crq/findingDisposition.test.ts`` replays it for behavioural parity.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

import finding_disposition_vectors as vectors

METHODS = ("context_error", "recovered_anchor", "triage", "repair_outcome")


class FindingDispositionVectorTest(unittest.TestCase):
    def test_checked_in_vectors_are_current(self):
        self.assertEqual(vectors.FIXTURE.read_text(encoding="utf-8"), vectors.render(vectors.build()))

    def test_regeneration_is_byte_identical_across_hash_seeds(self):
        path = Path(vectors.__file__).resolve()
        outputs = []
        for seed in ("0", "12345"):
            result = subprocess.run(
                [sys.executable, str(path), "--stdout"],
                check=True,
                capture_output=True,
                env={**os.environ, "PYTHONHASHSEED": seed},
            )
            outputs.append(result.stdout)
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(outputs[0].decode("utf-8"), vectors.FIXTURE.read_text(encoding="utf-8"))

    def test_cases_are_unique_public_and_cover_every_method(self):
        document = json.loads(vectors.FIXTURE.read_text(encoding="utf-8"))
        names = [case["name"] for case in document["cases"]]
        self.assertEqual(len(names), len(set(names)))
        used = {step["method"] for case in document["cases"] for step in case["spec"]["steps"] if "method" in step}
        self.assertEqual(used, set(METHODS))
        text = vectors.FIXTURE.read_text(encoding="utf-8")
        for private in ("/home/", "/tmp/", "/Users/"):
            self.assertNotIn(private, text)
        for case in document["cases"]:
            self.assertEqual(len(case["spec"]["steps"]), len(case["result"]["steps"]), case["name"])

    def test_python_exceptions_are_pinned_as_recorded_refusals(self):
        document = json.loads(vectors.FIXTURE.read_text(encoding="utf-8"))
        raised = {step["raises"] for case in document["cases"] for step in case["result"]["steps"] if "raises" in step}
        self.assertTrue({"FileNotFoundError", "CalledProcessError", "IntegrityError", "KeyError"} <= raised)


if __name__ == "__main__":
    unittest.main()
