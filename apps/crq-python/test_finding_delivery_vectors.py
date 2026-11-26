"""Checks for the checked-in finding-delivery oracle vectors.

``finding_delivery_vectors.py`` drives the real ``finding_delivery.Inbox.deliver``,
``canonical_rounds``, ``repair_transport`` and ``configured_repair_transport``
inside a throwaway sandbox. This test only proves the committed file is the
current deterministic output, stays public/synthetic and that every case left
the area outside its sandbox untouched; the TypeScript test
``test/ops/crq/findingDelivery.test.ts`` replays it for behavioural parity.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

import finding_delivery_vectors as vectors

METHODS = ("deliver", "accept", "canonical_rounds")


class FindingDeliveryVectorTest(unittest.TestCase):
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
        used = {step["method"] for case in document["cases"] for step in case["spec"]["steps"]}
        self.assertEqual(used, set(METHODS))
        text = vectors.FIXTURE.read_text(encoding="utf-8")
        for private in ("/home/", "/tmp/", "/Users/"):
            self.assertNotIn(private, text)
        for case in document["cases"]:
            self.assertEqual(len(case["spec"]["steps"]), len(case["result"]["steps"]), case["name"])

    def test_nothing_outside_the_sandbox_is_touched(self):
        document = json.loads(vectors.FIXTURE.read_text(encoding="utf-8"))
        for case in document["cases"]:
            for step in case["result"]["steps"]:
                self.assertTrue(step["outside_untouched"], case["name"])

    def test_python_exceptions_are_pinned_as_recorded_refusals(self):
        document = json.loads(vectors.FIXTURE.read_text(encoding="utf-8"))
        raised = {step["raises"] for case in document["cases"] for step in case["result"]["steps"] if "raises" in step}
        self.assertTrue({"IntegrityError", "KeyError", "AttributeError", "TypeError", "RepairRoundCeiling",
                         "ValueError", "FileNotFoundError", "StubError"} <= raised)


if __name__ == "__main__":
    unittest.main()
