"""Reproducibility guard for the coverage-effects oracle fixture.

``coverage_effects_vectors.py`` drives the PRODUCTION ``coverage._legacy_origins``,
``coverage.legacy_retry_view``, ``coverage.coverage_candidate`` and
``crq.measure_merged`` and stores the value each returns or the exception class
and message it raises. This test fails when the committed fixture no longer
matches that output, depends on hash seed, or names a case twice.

Regenerate with ``python3.14 coverage_effects_vectors.py --write``.
"""
from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

import coverage_effects_vectors as emitter


class CoverageEffectsVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run python3.14 coverage_effects_vectors.py --write")
        self.assertEqual(
            emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build())
        )

    def test_case_names_are_unique(self) -> None:
        names = [case["name"] for case in emitter.build()["cases"]]
        self.assertEqual(len(names), len(set(names)))

    def test_cases_cover_every_function_and_outcome(self) -> None:
        cases = emitter.build()["cases"]
        self.assertEqual({c["spec"]["fn"] for c in cases}, {"origins", "retry", "candidate", "measure"})
        results = [c["result"] for c in cases]
        self.assertTrue(any("ok" in r for r in results))
        self.assertTrue({"ValueError", "KeyError", "TypeError", "AttributeError"} <= {
            r["raises"] for r in results if "raises" in r
        })

    def test_output_is_independent_of_hash_seed(self) -> None:
        here = Path(__file__).parent
        outputs = set()
        for seed in ("0", "1", "12345"):
            env = dict(os.environ, PYTHONHASHSEED=seed)
            done = subprocess.run(
                [sys.executable, "coverage_effects_vectors.py", "--stdout"],
                cwd=here, env=env, capture_output=True, text=True, check=True,
            )
            outputs.add(done.stdout)
        self.assertEqual(len(outputs), 1)


if __name__ == "__main__":
    unittest.main()
