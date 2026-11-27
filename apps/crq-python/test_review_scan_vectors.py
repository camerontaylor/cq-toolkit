"""Reproducibility guard for the review scan header oracle fixture.

``review_scan_vectors.py`` runs the PRODUCTION ``crq.secret_scan_diff`` over hand-built patch
text. This test fails when the committed fixture no longer matches, so a change to the scan
forces the TypeScript port and the fixture to move together.

Regenerate with ``python3 review_scan_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import review_scan_vectors as emitter


class ReviewScanVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run review_scan_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))


if __name__ == "__main__":
    unittest.main()
