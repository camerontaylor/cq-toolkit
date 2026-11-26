"""Reproducibility guard for the launch bindings oracle fixture.

``launch_bindings_vectors.py`` runs the PRODUCTION author lease, clone_for, secret scans and save_queue
over throwaway repositories. This test fails when the
committed fixture no longer matches, so a change to those functions forces the
TypeScript port and the fixture to move together.

Regenerate with ``python3 launch_bindings_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import launch_bindings_vectors as emitter


class LaunchBindingsVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run launch_bindings_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))


if __name__ == "__main__":
    unittest.main()
