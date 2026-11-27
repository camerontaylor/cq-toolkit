"""Reproducibility guard for the coverage select oracle fixture.

``coverage_select_vectors.py`` drives the PRODUCTION ``backfill_runtime.select``
(with the real ``backfill_jobs``, ``review_ledger`` and ``rank4_gate``; the live
collaborators scripted) and stores the return value, the queue and log left
behind, the ordered collaborator trace, or the exception class and message. This
test fails when the committed fixture no longer matches that output, depends on
hash seed, or names a case twice.

Regenerate with ``python3.14 coverage_select_vectors.py --write``.
"""
from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

import coverage_select_vectors as emitter


class CoverageSelectVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run python3.14 coverage_select_vectors.py --write")
        self.assertEqual(
            emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build())
        )

    def test_case_names_are_unique(self) -> None:
        names = [case["name"] for case in emitter.build()["cases"]]
        self.assertEqual(len(names), len(set(names)))

    def test_cases_cover_every_outcome(self) -> None:
        results = [c["result"] for c in emitter.build()["cases"]]
        oks = [r["ok"] for r in results if "ok" in r]
        self.assertTrue(any(o["started"] for o in oks))
        self.assertTrue(any(o["available"] is True for o in oks))
        self.assertTrue(any(o["available"] is False for o in oks))
        self.assertTrue({"KeyError", "TypeError", "AttributeError", "IntegrityError", "OSError"} <= {
            r["raises"] for r in results if "raises" in r
        })
        traces = [t[0] for r in results for t in r["trace"]]
        self.assertTrue({"fetch", "load", "request", "launch", "save", "state_event"} <= set(traces))
        self.assertTrue(any(
            "coverage refresh request not written" in line for r in results for line in r["log"]
        ))

    def test_output_is_independent_of_hash_seed(self) -> None:
        here = Path(__file__).parent
        outputs = set()
        for seed in ("0", "1", "12345"):
            env = dict(os.environ, PYTHONHASHSEED=seed)
            done = subprocess.run(
                [sys.executable, "coverage_select_vectors.py", "--stdout"],
                cwd=here, env=env, capture_output=True, text=True, check=True,
            )
            outputs.add(done.stdout)
        self.assertEqual(len(outputs), 1)


if __name__ == "__main__":
    unittest.main()
