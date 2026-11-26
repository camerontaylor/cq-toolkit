"""Reproducibility guard for the repair-tick parity oracle fixture.

``repair_tick_parity_vectors.py`` runs the PRODUCTION ``repair_tick.backfill``,
``archive_legacy`` and ``harvest`` over seeded on-disk state. This test fails
when the committed fixture no longer matches, so a change to those passes
forces the TypeScript port and the fixture to move together.

Regenerate with ``python3.14 repair_tick_parity_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import repair_tick_parity_vectors as emitter


class RepairTickParityVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run repair_tick_parity_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))


if __name__ == "__main__":
    unittest.main()
