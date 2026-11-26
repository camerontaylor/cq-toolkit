"""Checks for the checked-in retained-records oracle vectors.

``retained_records_vectors.py`` drives the real
``review_transport._retained_records``; this test proves the committed file is
the current deterministic output. The TypeScript test
``test/adapters/crq/retainedRecordsParity.test.ts`` replays it.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

import retained_records_vectors as vectors


class RetainedRecordsVectorTest(unittest.TestCase):
    def test_checked_in_vectors_are_current(self):
        self.assertEqual(vectors.FIXTURE.read_text(encoding="utf-8"), vectors.render(vectors.build()))

    def test_regeneration_is_byte_identical_across_hash_seeds(self):
        path = Path(vectors.__file__).resolve()
        outputs = []
        for seed in ("0", "12345"):
            result = subprocess.run([sys.executable, str(path), "--stdout"], check=True,
                                    capture_output=True, env={**os.environ, "PYTHONHASHSEED": seed})
            outputs.append(result.stdout)
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(outputs[0].decode("utf-8"), vectors.FIXTURE.read_text(encoding="utf-8"))

    def test_cases_are_unique_and_cover_records_and_escapes(self):
        document = json.loads(vectors.FIXTURE.read_text(encoding="utf-8"))
        names = [case["name"] for case in document["cases"]]
        self.assertEqual(len(names), len(set(names)))
        errors = {case["expect"].get("error") for case in document["cases"]}
        self.assertTrue({"AttributeError", "KeyError", "TypeError"} <= errors)
        self.assertTrue(any(case["expect"].get("records") for case in document["cases"]))


if __name__ == "__main__":
    unittest.main()
