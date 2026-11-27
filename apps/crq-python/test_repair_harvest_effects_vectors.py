"""Reproducibility guard for the repair-harvest effects oracle fixture.

``repair_harvest_effects_vectors.py`` runs the PRODUCTION
``crq_repair.retain.cleanup_harvested`` over a real Git worktree and the
PRODUCTION ``repair_tick.mark_finding_outcome`` / ``record_unpublished_siblings``
over a real inbox and outbox. This test fails when the committed fixture no
longer matches, so a change to those functions forces the TypeScript port and
the fixture to move together.

Regenerate with ``python3 repair_harvest_effects_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import repair_harvest_effects_vectors as emitter


class RepairHarvestEffectsVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run repair_harvest_effects_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))


if __name__ == "__main__":
    unittest.main()
