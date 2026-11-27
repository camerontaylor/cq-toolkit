"""Reproducibility guard for the backfill-harvest effect oracle fixture.

``backfill_harvest_effect_vectors.py`` runs the PRODUCTION
``backfill_runtime.harvest`` with the real ``crq.classify`` and cooldown over a
temp state root. This test fails when the committed fixture no longer matches,
so a change to that function forces the TypeScript port and the fixture to
move together.

Regenerate with ``python3.14 backfill_harvest_effect_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import backfill_harvest_effect_vectors as emitter


class BackfillHarvestEffectVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run backfill_harvest_effect_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))


if __name__ == "__main__":
    unittest.main()
