"""Reproducibility guard for the coverage backfill-seam oracle fixture.

``coverage_backfill_vectors.py`` drives the PRODUCTION
``backfill_runtime.rank4_gate``, ``backfill_jobs.bind_run`` and
``backfill_jobs.cancel_before_vendor`` and stores the result, the queue left
behind, the ordered collaborator trace, or the exception class and message. This
test fails when the committed fixture no longer matches that output, depends on
hash seed, or names a case twice.

Regenerate with ``python3.14 coverage_backfill_vectors.py --write``.
"""
from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

import coverage_backfill_vectors as emitter


class CoverageBackfillVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run python3.14 coverage_backfill_vectors.py --write")
        self.assertEqual(
            emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build())
        )

    def test_case_names_are_unique(self) -> None:
        names = [case["name"] for case in emitter.build()["cases"]]
        self.assertEqual(len(names), len(set(names)))

    def test_cases_cover_every_function_and_outcome(self) -> None:
        cases = emitter.build()["cases"]
        self.assertEqual({c["spec"]["fn"] for c in cases}, {"rank4", "bind", "cancel"})
        results = [c["result"] for c in cases]
        self.assertTrue(any("ok" in r for r in results))
        self.assertTrue(any(r.get("ok", {}).get("admitted") is True for r in results))
        self.assertTrue(any(r.get("ok", {}).get("admitted") is False for r in results))
        self.assertTrue({"KeyError", "TypeError", "AttributeError", "IntegrityError"} <= {
            r["raises"] for r in results if "raises" in r
        })

    def test_output_is_independent_of_hash_seed(self) -> None:
        here = Path(__file__).parent
        outputs = set()
        for seed in ("0", "1", "12345"):
            env = dict(os.environ, PYTHONHASHSEED=seed)
            done = subprocess.run(
                [sys.executable, "coverage_backfill_vectors.py", "--stdout"],
                cwd=here, env=env, capture_output=True, text=True, check=True,
            )
            outputs.add(done.stdout)
        self.assertEqual(len(outputs), 1)


if __name__ == "__main__":
    unittest.main()
