"""Reproducibility guard for the gitleaks discovery oracle fixture.

``gitleaks_discovery_vectors.py`` runs the PRODUCTION ``review_transport.provision`` over
throwaway local repositories. This test fails when the committed fixture no
longer matches, so a change to ``provision`` / ``clone_url`` forces the
TypeScript port and the fixture to move together.

Regenerate with ``python3 gitleaks_discovery_vectors.py --write``.
"""
from __future__ import annotations

import os
import unittest

import gitleaks_discovery_vectors as emitter


class GitleaksDiscoveryVectorsTest(unittest.TestCase):
    @unittest.skipIf(os.geteuid() == 0, "the emitter refuses to run as root")
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run gitleaks_discovery_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))


if __name__ == "__main__":
    unittest.main()
