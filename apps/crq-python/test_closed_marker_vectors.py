"""Checks for the checked-in closed-marker oracle vectors.

``closed_marker_vectors.py`` drives the real ``repair_tick.closed_marker_due``,
``reconcile_fix_prs`` and ``reconcile_current_fix`` under a frozen clock. This
test proves the committed file is the current deterministic output and stays
public/synthetic; ``test/ops/crq/closedMarker.test.ts`` replays it for parity.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

import closed_marker_vectors as vectors


class ClosedMarkerVectorTest(unittest.TestCase):
    def test_checked_in_vectors_are_current(self):
        self.assertEqual(vectors.FIXTURE.read_text(encoding="utf-8"), vectors.render(vectors.build()))

    def test_regeneration_is_byte_identical_across_hash_seeds(self):
        path = Path(vectors.__file__).resolve()
        outputs = []
        for seed in ("0", "12345"):
            result = subprocess.run([sys.executable, str(path), "--stdout"], check=True, capture_output=True,
                                    env={**os.environ, "PYTHONHASHSEED": seed})
            outputs.append(result.stdout)
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(outputs[0].decode("utf-8"), vectors.FIXTURE.read_text(encoding="utf-8"))

    def test_cases_are_unique_public_and_cover_both_outcomes(self):
        document = json.loads(vectors.FIXTURE.read_text(encoding="utf-8"))
        for lane, key in (("due", None), ("fix_prs", "spec"), ("current", "spec")):
            names = [(case[key] if key else case)["name"] for case in document[lane]]
            self.assertEqual(len(names), len(set(names)), lane)
        self.assertEqual({case["due"] for case in document["due"]}, {True, False})
        text = vectors.FIXTURE.read_text(encoding="utf-8")
        for private in ("/home/", "/tmp/", "/Users/"):
            self.assertNotIn(private, text)


if __name__ == "__main__":
    unittest.main()
