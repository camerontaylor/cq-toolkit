"""Reproducibility guard for the triage dry-run planning oracle fixture.

``triage_plan_vectors.py`` drives the PRODUCTION
``crq_repair.triage.phase(..., dry_run=True)`` with every effect injected and
records the dry-run report, the Git read order, the ``recovered_anchor`` and
``context`` calls and the monotonic-clock read count. This test fails when the
committed fixture no longer matches that output, so a change to ``triage.py``
forces the TypeScript port and the fixture to move together.

Regenerate with ``python3 triage_plan_vectors.py --write``.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import triage_plan_vectors as emitter


class TriagePlanVectorsTest(unittest.TestCase):
    def test_committed_fixture_is_current(self) -> None:
        fixture = (
            Path(emitter.__file__).resolve().parent
            / "fixtures"
            / "crq-triage-plan"
            / "cases.json"
        )
        self.assertTrue(fixture.exists(), "run python3 triage_plan_vectors.py --write")
        self.assertEqual(fixture.read_text(encoding="utf-8"), emitter.render(emitter.build()))

    def test_cases_are_named_and_cover_every_outcome(self) -> None:
        cases = emitter.build()["cases"]
        names = [case["name"] for case in cases]
        self.assertEqual(len(names), len(set(names)))
        actions = set()
        for case in cases:
            if "result" in case:
                actions.update(outcome["action"] for outcome in case["result"]["outcomes"])
        self.assertEqual(actions, {"confirmed", "needs-human", "superseded", "duplicate"})
        results = [case["result"] for case in cases if "result" in case]
        self.assertTrue(any(result["stopped"] == "deadline" for result in results))
        self.assertTrue(any(result["context_errors"] for result in results))
        self.assertTrue(any(result["judgment_candidates"] for result in results))
        self.assertTrue(any("raises" in case for case in cases))
        self.assertTrue(any(case["ts_refuses"] for case in cases))

    def test_every_forbidden_effect_trips_the_oracle_trap(self) -> None:
        # The traps raise AssertionError, which run_python does not swallow, so
        # a call from the dry run would abort build() instead of being recorded.
        # Prove each trap really propagates, so a green build means the dry run
        # reached none of them.
        spec = next(case for case in emitter.cases() if case["kind"] == "plan")
        callers = {
            "judge": lambda inbox, judge, transport: judge(),
            "transport": lambda inbox, judge, transport: transport(),
            "recover": lambda inbox, judge, transport: inbox.recover([]),
            "triage": lambda inbox, judge, transport: inbox.triage(),
            "context_error": lambda inbox, judge, transport: inbox.context_error(),
            "deliver": lambda inbox, judge, transport: inbox.deliver(),
        }
        for name, call in callers.items():
            def phase(inbox, repo, tip, judge, transport, *_args, _call=call, **_kwargs):
                return _call(inbox, judge, transport)

            with self.subTest(effect=name), mock.patch.object(emitter.triage, "phase", phase):
                with self.assertRaisesRegex(AssertionError, "dry run must not call " + name):
                    emitter.run_python(spec)
        # And the real build completed: no case swallowed such an assertion.
        for case in emitter.build()["cases"]:
            self.assertNotEqual(case.get("raises"), "AssertionError", case["name"])

    def test_fixture_contains_no_host_paths(self) -> None:
        text = emitter.render(emitter.build())
        self.assertNotIn(tempfile.gettempdir(), text)
        self.assertNotIn("/tmp/", text)


if __name__ == "__main__":
    unittest.main()
