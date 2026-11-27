"""Reproducibility guard for the exemption-base oracle fixture.

``exemption_base_vectors.py`` drives the PRODUCTION ``crq.exemption_base`` and
stores the revision it resolves or the exception class it raises. This test
fails when the committed fixture no longer matches that output.

Regenerate with ``python3 exemption_base_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import exemption_base_vectors as emitter


class ExemptionBaseVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run python3 exemption_base_vectors.py --write")
        self.assertEqual(
            emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build())
        )

    def test_cases_cover_every_outcome(self) -> None:
        results = [case["result"] for case in emitter.build()["cases"]]
        self.assertTrue(any(r.get("spec") for r in results))
        self.assertTrue(any(r == {"spec": None} for r in results))
        self.assertEqual({r["raises"] for r in results if "raises" in r}, {"TypeError", "AttributeError"})
