"""Reproducibility guard for the build_synthetic oracle fixture.

``build_synthetic_vectors.py`` drives the PRODUCTION ``crq.build_synthetic`` over
throwaway git repositories (fixed identity and dates) and stores the returned
ids, every ``refs/crq`` ref, the written commits and the raised exception class
and message. This test fails when the committed fixture no longer matches that
output, depends on hash seed, or names a case twice.

Regenerate with ``python3.14 build_synthetic_vectors.py --write``.
"""
from __future__ import annotations

import os
import subprocess
import sys
import unittest
from unittest import mock
from pathlib import Path

import build_synthetic_vectors as emitter


class BuildSyntheticVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run python3.14 build_synthetic_vectors.py --write")
        self.assertEqual(
            emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build())
        )

    def test_case_names_are_unique(self) -> None:
        names = [case["name"] for case in emitter.build()["cases"]]
        self.assertEqual(len(names), len(set(names)))

    def test_cases_cover_success_and_error_classes(self) -> None:
        outcomes = [r["outcome"] for c in emitter.build()["cases"] for r in c["results"]]
        self.assertTrue(any("ok" in o for o in outcomes))
        self.assertTrue(
            {"KeyError", "TypeError", "AttributeError", "RuntimeError"}
            <= {o["raises"] for o in outcomes if "raises" in o}
        )

    def test_environment_is_restored_after_import_and_run(self) -> None:
        poisoned = {"GIT_INDEX_FILE": "/nonexistent/index", "GIT_DIR": "/nonexistent/dir", "LC_ALL": "fr_FR.UTF-8"}
        with mock.patch.dict(os.environ, poisoned):
            before = dict(os.environ)
            emitter.build()
            self.assertEqual(dict(os.environ), before)
        done = subprocess.run(
            [sys.executable, "-c",
             "import os; b = dict(os.environ); import build_synthetic_vectors; "
             "assert dict(os.environ) == b, 'import changed os.environ'"],
            cwd=Path(__file__).parent, capture_output=True, text=True,
        )
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_run_ignores_caller_git_location(self) -> None:
        with mock.patch.dict(os.environ, {"GIT_INDEX_FILE": "/nonexistent/index", "GIT_DIR": "/nonexistent/dir"}):
            self.assertEqual(
                emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build())
            )

    def test_output_is_independent_of_hash_seed(self) -> None:
        here = Path(__file__).parent
        outputs = set()
        for seed in ("0", "1", "12345"):
            env = dict(os.environ, PYTHONHASHSEED=seed)
            done = subprocess.run(
                [sys.executable, "build_synthetic_vectors.py", "--stdout"],
                cwd=here, env=env, capture_output=True, text=True, check=True,
            )
            outputs.add(done.stdout)
        self.assertEqual(len(outputs), 1)


if __name__ == "__main__":
    unittest.main()
