"""Reproducibility guard for the coverage tick-seams oracle fixture.

``coverage_tick_seams_vectors.py`` drives the PRODUCTION ``crq.parse_iso``,
``crq.live_items``, ``crq.sort_key``, ``crq.deps_met`` and
``backfill_runtime.settings(state, dispatch=True)`` and stores the value each
returns or the exception class and message it raises. This test fails when
the committed fixture no longer matches that output, depends on hash seed, or
names a case twice.

Regenerate with ``python3.14 coverage_tick_seams_vectors.py --write``.
"""
from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

import coverage_tick_seams_vectors as emitter


class CoverageTickSeamsVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        self.assertTrue(emitter.FIXTURE.exists(), "run python3.14 coverage_tick_seams_vectors.py --write")
        self.assertEqual(
            emitter.FIXTURE.read_text(encoding="utf-8"), emitter.render(emitter.build())
        )

    def test_case_names_are_unique(self) -> None:
        document = emitter.build()
        settings = [case["name"] for case in document["settings"]]
        self.assertEqual(len(settings), len(set(settings)))
        pairs = [(case["queue"], case["config"]) for case in document["queues"]]
        self.assertEqual(len(pairs), len(set(pairs)))
        malformed = [case["name"] for case in document["malformed"]]
        self.assertEqual(len(malformed), len(set(malformed)))

    def test_cases_cover_success_and_error_classes(self) -> None:
        document = emitter.build()
        outcomes = [case["outcome"] for case in document["settings"]]
        self.assertTrue(any(o.get("ok") is True for o in outcomes))
        self.assertTrue(any(o.get("ok") is False for o in outcomes))
        raised = {o["raises"] for o in outcomes if "raises" in o}
        self.assertTrue(
            {"IntegrityError", "KeyError", "AttributeError", "JSONDecodeError", "FileNotFoundError",
             "UnicodeDecodeError"} <= raised
        )
        parse = [case["outcome"] for case in document["parse_iso"]]
        self.assertTrue(any("ok" in o for o in parse) and any("raises" in o for o in parse))

    def test_no_host_path_leaks_into_the_fixture(self) -> None:
        text = emitter.FIXTURE.read_text(encoding="utf-8")
        self.assertNotIn("/home/", text)
        self.assertNotIn("/tmp/", text)

    def test_output_is_independent_of_hash_seed(self) -> None:
        here = Path(__file__).parent
        outputs = set()
        for seed in ("0", "1", "12345"):
            env = dict(os.environ, PYTHONHASHSEED=seed)
            done = subprocess.run(
                [sys.executable, "coverage_tick_seams_vectors.py", "--stdout"],
                cwd=here, env=env, capture_output=True, text=True, check=True,
            )
            outputs.add(done.stdout)
        self.assertEqual(len(outputs), 1)


if __name__ == "__main__":
    unittest.main()
