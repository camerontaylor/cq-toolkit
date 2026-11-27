"""Reproducibility guard for the harvest-review effects oracle fixture.

``harvest_review_effects_vectors.py`` runs the PRODUCTION ``crq.findings_md``,
``crq.current_document`` + ``review_receipt.write_receipt`` and
``crq._request_pr_review`` over a temp state root. This test fails when the
committed fixture no longer matches, so a change to those functions forces the
TypeScript port and the fixture to move together.

Regenerate with ``python3 harvest_review_effects_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import harvest_review_effects_vectors as emitter


class HarvestReviewEffectsVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run harvest_review_effects_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))


if __name__ == "__main__":
    unittest.main()
