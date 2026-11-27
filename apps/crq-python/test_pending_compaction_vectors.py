"""Reproducibility guard for the pending admission-history compaction oracle fixture.

``pending_compaction_vectors.py`` runs the PRODUCTION ``crq.load_queue`` / ``crq.save_queue``
(``crq.py:267-302``). This test fails when the committed fixture no longer matches, so a change to
those functions forces the TypeScript port and the fixture to move together.

Regenerate with ``python3 pending_compaction_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import pending_compaction_vectors as emitter


class PendingCompactionVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run pending_compaction_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))


if __name__ == "__main__":
    unittest.main()
