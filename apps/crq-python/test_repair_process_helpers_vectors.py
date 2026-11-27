"""Reproducibility guard for the ``process()`` helpers oracle fixture.

``repair_process_helpers_vectors.py`` runs the PRODUCTION
``failure_class_for_stop``, the inline ``judge_required`` expression,
``bounded.validate_revalidation``, ``verify``, ``retain`` and
``retain_preserving_nested`` and records what they do. This test fails when the
committed fixture no longer matches, so a change to those functions forces the
TypeScript ports and the fixture to move together.

Regenerate with ``python3 repair_process_helpers_vectors.py --write``.
"""
from __future__ import annotations

import unittest

import repair_process_helpers_vectors as emitter


class RepairProcessHelpersVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run repair_process_helpers_vectors.py --write")
        self.assertEqual(emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build()))

    def test_case_names_are_unique_per_section(self) -> None:
        document = emitter.build()
        for section in ("failure_class", "judge_required", "revalidation", "verify", "retain", "nested"):
            names = [case["name"] for case in document[section]]
            self.assertEqual(len(names), len(set(names)), section)

    def test_judge_required_is_extracted_exactly_once(self) -> None:
        self.assertGreater(emitter.JUDGE_LINE, 0)


if __name__ == "__main__":
    unittest.main()
