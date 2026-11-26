#!/usr/bin/env python3
"""Deterministic offline oracle for the TS port of the ``process()`` rung machine.

Test tooling only. It runs the PRODUCTION ``crq_repair.process``
(``crq_repair.py:486-789``) over a throwaway directory and records, per
scenario, exactly what Python does:

* the TRACE of every injected seam call, in order, with its arguments
  (``blocked``, ``retain``, ``retain_preserving_nested``, ``git``, the
  ``git cat-file blob`` read, ``dispatch``, ``mechanical``,
  ``rate_limit_pause``, ``random.random``);
* every file SAVE (``atomic``), in order, as the text it wrote;
* the value ``process`` returned, or the exception class (and message, where
  the code under test authored it) that escaped it.

Only effects are replaced: ``dispatch``, ``mechanical``, ``retain``,
``retain_preserving_nested``, ``blocked``, ``rate_limit_pause``, ``git``, the
``git cat-file`` ``command`` call, ``random.random`` and the clock. Everything
else (``selection`` of result/progress, ``resume_worktree``, the file reads, the
loop, the judge, ``failure_class_for_stop``) is the real production code, run
against real files and directories under a temporary root.

Scenario paths start with ``/T``; the oracle substitutes its temporary
directory and substitutes it back in every recorded value, so the fixture is
host independent. Nothing outside the temporary directory is read or written
and no provider, queue, signer, network or host service is touched.

Regenerate with ``python3 repair_rung_machine_vectors.py --write`` and verify
with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-rung-machine" / "cases.json"
SCHEMA = "cq.crq-rung-machine-vector/v1"
NOW = "2026-11-26T12:00:00Z"
BASE = "a" * 40
JOB_ID = "crq-R-F1"
MESSAGE_KINDS = ["ValueError", "KeyError", "RuntimeError", "OSError", "DetectorUnavailable"]


def _service():
    """Load the production repair service module, not a copy of it."""
    sys.path.insert(0, str(HERE))
    spec = importlib.util.spec_from_file_location("repair_rung_machine_oracle", HERE / "crq_repair.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


service = _service()


class Exhausted(BaseException):
    """A scenario ran out of scripted answers: never caught by ``except Exception``."""


# ---------------------------------------------------------------------------
# scenario builders
# ---------------------------------------------------------------------------

def roles():
    return {
        "fixer": {"driver": "cq", "model": "m-fixer"},
        "fixer_escalation": {"driver": "cq", "model": "m-escalation"},
        "judge": {"driver": "cq", "model": "m-judge"},
        "judge_critical": {"driver": "cq", "model": "m-judge-critical"},
    }


def job(**extra):
    base = {"job": JOB_ID, "item": "item-1", "repair_base": BASE, "source_sha": "b" * 40,
            "finding_sha256": "c" * 64, "origin_job": None, "run": "R",
            "finding": {"severity": "major", "path": "src/a.py"}}
    base.update(extra)
    return base


def config(**repair_extra):
    repair = {"roles": roles()}
    repair.update(repair_extra)
    return {"repair": repair, "clone": "/T/clone"}


def raising(kind, message):
    return {"raise": {"kind": kind, "message": message}}


def ok(summary="fixed it", commits=("d" * 40,), **extra):
    report = {"stop": "ok", "changed": True, "summary": summary, "commits": list(commits)}
    report.update(extra)
    return report


def unchanged(summary="nothing to change", **extra):
    report = {"stop": "ok", "changed": False, "summary": summary, "worker_disposition": "unchanged_with_reason"}
    report.update(extra)
    return report


def noop(summary="no change"):
    return {"stop": "ok", "changed": False, "summary": summary}


def judged(verdict, reason="because", stop="ok", **extra):
    report = {"stop": stop, "verdict": verdict, "reason": reason}
    report.update(extra)
    return report


def attempt(rung, stop="error", **extra):
    record = {"rung": rung, "role": "fixer", "driver": "cq", "model": "m-fixer", "stop": stop, "changed": False}
    record.update(extra)
    return record


def prior(**extra):
    """A saved result/progress document, as ``process`` itself writes it."""
    document = {"job": JOB_ID, "item": "item-1", "repair_base": BASE, "source_sha": "b" * 40,
                "finding_sha256": "c" * 64, "origin_job": None, "verdict": "FAILED", "reason": "",
                "commits": [], "attempts": [], "judge": None, "worktree": "/T/wt",
                "started_at": "2026-11-26T11:00:00Z"}
    document.update(extra)
    return document


SCENARIOS: list[dict] = []
GAPS: list[str] = []


def scenario(name, *, job_=None, config_=None, wt="/T/wt", result=None, progress=None, newer=True,
             trees=(), plain_dirs=(), git=None, cat_file=None, final=False, **seams):
    if isinstance(result, dict) and not final and "retry_after" not in result:
        result = {**result, "retry_after": "2026-11-26T11:00:00Z"}
    SCENARIOS.append({
        "name": name,
        "job": job() if job_ is None else job_,
        "config": config() if config_ is None else config_,
        "wt": wt,
        "files": {"result": result, "progress": progress, "progress_newer": newer},
        "trees": list(trees),
        "plain_dirs": list(plain_dirs),
        "git": CLEAN_GIT if git is None else git,
        "cat_file": cat_file or {},
        "seams": {key: list(value) for key, value in seams.items()},
    })


CLEAN_GIT = {"status --porcelain": "", "rev-parse HEAD": BASE}


def build_scenarios() -> None:
    # ---- A0 / A1 / A2 success paths ------------------------------------
    scenario("A0 success: fixer changes, mechanical passes, FIXED",
             dispatch=[ok()], mechanical=[{"verdict": "pass"}])
    scenario("A0 success with a falsy-but-present summary default",
             dispatch=[ok(summary="")], mechanical=[{"verdict": "pass"}])
    scenario("A0 success: changed is a truthy integer",
             dispatch=[ok(changed=1)], mechanical=[{"verdict": "pass"}])
    scenario("A0 success: report names its own driver and model",
             dispatch=[ok(driver="codex", model="m-x")], mechanical=[{"verdict": "pass"}])
    scenario("A0 success: report driver null wins over the role default",
             dispatch=[ok(driver=None, model=None)], mechanical=[{"verdict": "pass"}])
    scenario("A0 success: report omits summary", dispatch=[{"stop": "ok", "changed": True, "commits": ["e" * 40]}],
             mechanical=[{"verdict": "pass"}])
    scenario("A0 success: report omits commits raises KeyError inside the try",
             dispatch=[{"stop": "ok", "changed": True, "summary": "s"}, ok()], mechanical=[{"verdict": "pass"}, {"verdict": "pass"}],
             git=CLEAN_GIT)
    scenario("A0 then A1 success after a driver error",
             dispatch=[{"stop": "error", "summary": "boom"}, ok()], mechanical=[{"verdict": "pass"}])
    scenario("A0 and A1 fail, A2 success in a fresh worktree",
             dispatch=[{"stop": "error", "summary": "one"}, {"stop": "error", "summary": "two"}, ok()],
             mechanical=[{"verdict": "pass"}])
    scenario("A2 reuses an existing worktree",
             dispatch=[ok()], mechanical=[{"verdict": "pass"}], progress=prior(next_rung=2), newer=True,
             plain_dirs=["/T/wt-A2"])
    scenario("A2 fresh worktree from a saved next_rung",
             dispatch=[ok()], mechanical=[{"verdict": "pass"}], progress=prior(next_rung=2))
    scenario("all three rungs fail: FAILED with the last reason and a final snapshot",
             dispatch=[{"stop": "error", "summary": "one"}, {"stop": "error", "summary": "two"},
                       {"stop": "error", "summary": "three"}])
    scenario("next_rung 3 skips the loop and snapshots",
             result=prior(next_rung=3, reason="earlier", attempts=[attempt("A2")]))

    # ---- stop / timeout / budget / configuration -------------------------
    scenario("stop timeout is a ValueError and advances the rung",
             dispatch=[{"stop": "timeout", "summary": "slow"}, ok()], mechanical=[{"verdict": "pass"}])
    scenario("stop timeout without a summary says no detail",
             dispatch=[{"stop": "timeout"}, ok()], mechanical=[{"verdict": "pass"}])
    scenario("stop null is not ok",
             dispatch=[{"stop": None, "summary": "x"}, ok()], mechanical=[{"verdict": "pass"}])
    scenario("stop budget is exhausted, not transient",
             dispatch=[{"stop": "budget", "summary": "spent"}, ok()], mechanical=[{"verdict": "pass"}])
    scenario("stop configuration ends the job with the report summary",
             dispatch=[{"stop": "configuration", "summary": "no driver binary"}])
    scenario("stop configuration without a summary uses the default",
             dispatch=[{"stop": "configuration"}])
    scenario("stop configuration with a null summary keeps null",
             dispatch=[{"stop": "configuration", "summary": None}])
    scenario("truncated context fails the rung",
             dispatch=[ok(truncated=True), ok()], mechanical=[{"verdict": "pass"}])
    scenario("truncated is a truthy list",
             dispatch=[ok(truncated=["x"]), ok()], mechanical=[{"verdict": "pass"}])
    scenario("truncated zero is falsy", dispatch=[ok(truncated=0)], mechanical=[{"verdict": "pass"}])
    scenario("driver summary longer than 600 code points is clipped by code point",
             dispatch=[{"stop": "error", "summary": "\U0001F600" * 700}, ok()], mechanical=[{"verdict": "pass"}])
    scenario("container stop renders as a Python list in the reason",
             dispatch=[{"stop": ["x"], "summary": "q"}, ok()], mechanical=[{"verdict": "pass"}])
    scenario("numeric summary renders as a Python int",
             dispatch=[{"stop": "timeout", "summary": 5}, ok()], mechanical=[{"verdict": "pass"}])
    scenario("float summary renders as a Python float",
             dispatch=[{"stop": "timeout", "summary": 1.5}, ok()], mechanical=[{"verdict": "pass"}])
    scenario("mapping summary renders as a Python dict repr",
             dispatch=[{"stop": "error", "summary": {"k": ["v", 1, None, True, 2.0]}}, ok()],
             mechanical=[{"verdict": "pass"}])
    scenario("float stop renders as a Python float",
             dispatch=[{"stop": 2.5, "summary": "q"}, ok()], mechanical=[{"verdict": "pass"}])
    scenario("pending_mechanical container rung: the eager max() ValueErrors on the A['x'] attempt before any comparison",
             progress=prior(next_rung=0, attempts=[attempt("A['x']", "ok")],
                            pending_mechanical={"rung": ["x"], "commits": [], "fixer_reason": "r"}),
             mechanical=[{"verdict": "pass"}], trees=["/T/wt"])
    scenario("mechanical failure message longer than 1000 code points is clipped",
             dispatch=[ok(), ok()],
             mechanical=[raising("ValueError", "é" * 1100), {"verdict": "pass"}])

    # ---- rate limit -------------------------------------------------------
    scenario("rate limit defers with the pause stamp",
             dispatch=[{"stop": "rate-limit", "summary": "429"}], rate_limit_pause=["2026-11-26T13:00:00Z"])
    scenario("rate limit at A1 keeps the rung",
             dispatch=[{"stop": "error", "summary": "x"}, {"stop": "rate-limit"}],
             rate_limit_pause=["2026-11-26T13:30:00Z"])
    scenario("rate limit preserving retain failure is caught and the rung advances",
             dispatch=[{"stop": "rate-limit"}, ok()], mechanical=[{"verdict": "pass"}],
             retain_preserving_nested=[raising("OSError", "disk full")])

    # ---- blackout ----------------------------------------------------------
    scenario("blackout before the rung defers without a dispatch", blocked=[True])
    scenario("blackout reported by the dispatch defers the rung", dispatch=[{"stop": "blackout"}])
    scenario("blackout at A1 keeps next_rung",
             dispatch=[{"stop": "error", "summary": "x"}, {"stop": "blackout"}])

    # ---- needs_human / unchanged -------------------------------------------
    scenario("needs_human with a summary ends the job",
             dispatch=[{"stop": "ok", "worker_disposition": "needs_human", "summary": "pick one"}])
    scenario("needs_human via disposition, stop error",
             dispatch=[{"stop": "error", "disposition": "needs_human", "summary": "pick one"}])
    scenario("needs_human with a whitespace summary is not owner-decision",
             dispatch=[{"stop": "ok", "worker_disposition": "needs_human", "summary": "  \n ", "changed": False},
                       ok()], git=CLEAN_GIT, mechanical=[{"verdict": "pass"}])
    scenario("needs_human with a falsy zero summary is not owner-decision",
             dispatch=[{"stop": "ok", "worker_disposition": "needs_human", "summary": 0, "changed": False},
                       ok()], git=CLEAN_GIT, mechanical=[{"verdict": "pass"}])
    scenario("needs_human with a numeric summary is owner-decision",
             dispatch=[{"stop": "ok", "worker_disposition": "needs_human", "summary": 7}])
    scenario("needs_human with stop timeout is not owner-decision",
             dispatch=[{"stop": "timeout", "disposition": "needs_human", "summary": "x"}, ok()],
             mechanical=[{"verdict": "pass"}])
    scenario("worker_disposition null falls back to disposition",
             dispatch=[{"stop": "ok", "worker_disposition": None, "disposition": "needs_human", "summary": "x"}])
    scenario("unchanged without disposition: NOT-FIXED, no judge",
             dispatch=[{"stop": "ok", "changed": False, "summary": "all good"}], git=CLEAN_GIT)
    scenario("unchanged without summary: NOT-FIXED with the default reason",
             dispatch=[{"stop": "ok", "changed": False}], git=CLEAN_GIT)
    scenario("unchanged with a falsy summary list",
             dispatch=[{"stop": "ok", "changed": False, "summary": []}], git=CLEAN_GIT)
    scenario("unchanged left repository changes",
             dispatch=[{"stop": "ok", "changed": False, "summary": "x"}, ok()],
             git={"status --porcelain": " M a.py", "rev-parse HEAD": BASE}, mechanical=[{"verdict": "pass"}])
    scenario("unchanged but HEAD moved",
             dispatch=[{"stop": "ok", "changed": False, "summary": "x"}, ok()],
             git={"status --porcelain": "", "rev-parse HEAD": "f" * 40}, mechanical=[{"verdict": "pass"}])
    scenario("unchanged git status raises RuntimeError and is caught",
             dispatch=[{"stop": "ok", "changed": False, "summary": "x"}, ok()],
             git={"status --porcelain": raising("RuntimeError", "git status failed: boom"), "rev-parse HEAD": BASE},
             mechanical=[{"verdict": "pass"}])
    scenario("no_outcome with no evidence is exhausted",
             dispatch=[{"stop": "ok", "changed": False, "summary": "?", "worker_disposition": "no_outcome"}],
             git=CLEAN_GIT)
    scenario("unchanged_with_reason cites verified evidence",
             dispatch=[unchanged(evidence=[{"path": "src/a.py", "line": 2}])], git=CLEAN_GIT,
             cat_file={BASE + ":src/a.py": {"returncode": 0, "stdout": "one\ntwo\nthree\n"}})
    scenario("unchanged evidence line splitting follows splitlines",
             dispatch=[unchanged(evidence=[{"path": "src/a.py", "line": 3}, {"path": "src/a.py", "line": 1}])],
             git=CLEAN_GIT,
             cat_file={BASE + ":src/a.py": {"returncode": 0,
                                            "stdout": "one\r\ntwo three\x0cfour\u0085five"}})
    scenario("unchanged evidence with no citations",
             dispatch=[unchanged(evidence=[]), ok()], git=CLEAN_GIT, mechanical=[{"verdict": "pass"}])
    scenario("unchanged evidence that is not a list",
             dispatch=[unchanged(evidence="src/a.py:1"), ok()], git=CLEAN_GIT, mechanical=[{"verdict": "pass"}])
    for label, citation in [
        ("absolute path", {"path": "/etc/passwd", "line": 1}),
        ("dotdot segment", {"path": "a/../b", "line": 1}),
        ("dotdot is a segment only", {"path": "a/..b/c", "line": 1}),
        ("line zero", {"path": "a.py", "line": 0}),
        ("line bool", {"path": "a.py", "line": True}),
        ("line float", {"path": "a.py", "line": 1.0}),
        ("line string", {"path": "a.py", "line": "1"}),
        ("path not a string", {"path": 5, "line": 1}),
        ("path missing", {"line": 1}),
        ("line missing", {"path": "a.py"}),
        ("citation not an object", "a.py:1"),
        ("line beyond the file", {"path": "a.py", "line": 9}),
        ("huge line", {"path": "a.py", "line": 10 ** 30}),
    ]:
        scenario("unchanged evidence anchor: " + label,
                 dispatch=[unchanged(evidence=[citation]), ok()], git=CLEAN_GIT, mechanical=[{"verdict": "pass"}],
                 cat_file={BASE + ":a.py": {"returncode": 0, "stdout": "x\ny\n"}})
    scenario("unchanged evidence blob absent",
             dispatch=[unchanged(evidence=[{"path": "gone.py", "line": 1}]), ok()], git=CLEAN_GIT,
             mechanical=[{"verdict": "pass"}])

    # ---- mechanical / DetectorUnavailable -----------------------------------
    scenario("mechanical ValueError fails the rung and annotates the attempt",
             dispatch=[ok(), ok()], mechanical=[raising("ValueError", "tests failed"), {"verdict": "pass"}])
    scenario("mechanical RuntimeError fails the rung",
             dispatch=[ok(), ok()], mechanical=[raising("RuntimeError", "git diff failed: x"), {"verdict": "pass"}])
    scenario("detector unavailable defers with pending_mechanical",
             dispatch=[ok()], mechanical=[raising("DetectorUnavailable", "detector down")])
    scenario("detector unavailable then retain fails in the handler",
             dispatch=[ok()], mechanical=[raising("DetectorUnavailable", "detector down")],
             retain=[None, raising("OSError", "no space")])
    scenario("detector unavailable with a long message is clipped in the attempt",
             dispatch=[ok()], mechanical=[raising("DetectorUnavailable", "d" * 1500)])
    scenario("detector unavailable on a report without commits raises KeyError instead",
             dispatch=[{"stop": "ok", "changed": True, "summary": "s"}, ok()],
             mechanical=[raising("DetectorUnavailable", "down"), {"verdict": "pass"}])
    scenario("pending_mechanical resumes mechanical verification only",
             progress=prior(next_rung=0, attempts=[attempt("A0", "ok", changed=True)],
                            pending_mechanical={"rung": 0, "commits": ["d" * 40], "fixer_reason": "fixed it"},
                            dispatch_pending=None),
             mechanical=[{"verdict": "pass"}], trees=["/T/wt"])
    scenario("pending_mechanical at A1 resumes in the recorded A1 tree",
             progress=prior(next_rung=1, attempts=[attempt("A0"), attempt("A1", "ok", changed=True)],
                            pending_mechanical={"rung": 1, "commits": ["d" * 40], "fixer_reason": "r"}),
             mechanical=[{"verdict": "pass"}], trees=["/T/wt"])
    scenario("pending_mechanical rung given as a numeric string still matches",
             progress=prior(next_rung=0, attempts=[attempt("A0", "ok")],
                            pending_mechanical={"rung": "0", "commits": [], "fixer_reason": "r"}),
             mechanical=[{"verdict": "pass"}], trees=["/T/wt"])
    scenario("pending_mechanical rung given as a float never matches",
             progress=prior(next_rung=0, attempts=[attempt("A0", "ok")],
                            pending_mechanical={"rung": 0.0, "commits": [], "fixer_reason": "r"}),
             trees=["/T/wt"])
    scenario("pending_mechanical rung mismatch fails closed",
             progress=prior(next_rung=1, attempts=[attempt("A0", "ok")],
                            pending_mechanical={"rung": 1, "commits": [], "fixer_reason": "r"}),
             trees=["/T/wt"])
    scenario("pending_mechanical without any attempt fails closed",
             progress=prior(next_rung=0, attempts=[],
                            pending_mechanical={"rung": 0, "commits": [], "fixer_reason": "r"}),
             trees=["/T/wt"])
    scenario("pending_mechanical missing fixer_reason raises KeyError into the handler",
             progress=prior(next_rung=0, attempts=[attempt("A0", "ok")],
                            pending_mechanical={"rung": 0, "commits": []}),
             dispatch=[ok()], mechanical=[{"verdict": "pass"}], trees=["/T/wt"])
    scenario("pending_mechanical resumed mechanical raises DetectorUnavailable again",
             progress=prior(next_rung=0, attempts=[attempt("A0", "ok")],
                            pending_mechanical={"rung": 0, "commits": ["d" * 40], "fixer_reason": "r"}),
             mechanical=[raising("DetectorUnavailable", "still down")], trees=["/T/wt"])
    scenario("pending_mechanical resumed mechanical raises ValueError and advances",
             progress=prior(next_rung=0, attempts=[attempt("A0", "ok")],
                            pending_mechanical={"rung": 0, "commits": ["d" * 40], "fixer_reason": "r"}),
             mechanical=[raising("ValueError", "rejected"), {"verdict": "pass"}], dispatch=[ok()],
             trees=["/T/wt"])
    scenario("pending_mechanical in a worktree that no longer exists is refused",
             progress=prior(next_rung=0, attempts=[attempt("A0", "ok")], worktree="/T/gone",
                            pending_mechanical={"rung": 0, "commits": [], "fixer_reason": "r"}))
    scenario("pending_mechanical adopts the recorded A2 tree",
             wt="/T/wt",
             progress=prior(next_rung=2, attempts=[attempt("A0"), attempt("A1"), attempt("A2", "ok")],
                            worktree="/T/wt-A2",
                            pending_mechanical={"rung": 2, "commits": ["d" * 40], "fixer_reason": "r"}),
             mechanical=[{"verdict": "pass"}], trees=["/T/wt-A2"])

    # ---- judge --------------------------------------------------------------
    critical = job(finding={"severity": "critical", "path": "src/a.py"})
    scenario("critical finding judged valid at A0 escalates to A2",
             job_=critical, dispatch=[noop(), judged("valid", "real bug"), ok()],
             mechanical=[{"verdict": "pass"}, {"verdict": "pass"}])
    scenario("critical finding judged invalid ends NOT-FIXED",
             job_=critical, dispatch=[noop(), judged("invalid", "not a bug")], mechanical=[{"verdict": "pass"}])
    scenario("critical finding judged unsure with a reason escalates",
             job_=critical, dispatch=[noop(), judged("unsure", "cannot tell"), noop()],
             mechanical=[{"verdict": "pass"}], git=CLEAN_GIT)
    scenario("critical finding judged unsure with no reason fails with evidence class",
             job_=critical, dispatch=[noop(), judged("unsure", "")], mechanical=[{"verdict": "pass"}])
    scenario("critical finding judge stop error fails exhausted",
             job_=critical, dispatch=[noop(), judged("valid", "x", stop="error")], mechanical=[{"verdict": "pass"}])
    scenario("critical finding judge stop configuration is transient",
             job_=critical, dispatch=[noop(), judged("invalid", "x", stop="configuration")],
             mechanical=[{"verdict": "pass"}])
    scenario("critical judge uses the judge_critical role",
             job_=critical, dispatch=[noop(), judged("invalid", "x")], mechanical=[{"verdict": "pass"}])
    scenario("non-critical recurrence engages the judge with the judge role",
             job_=job(recurrence=["R-1"], review_diff="diff --git"),
             dispatch=[noop(), judged("invalid", "nope")], mechanical=[{"verdict": "pass"}])
    scenario("recurrence false draws randomness; rate 1 samples",
             job_=job(recurrence=0), config_=config(judge_sample_rate=1),
             dispatch=[noop(), judged("invalid", "nope")], mechanical=[{"verdict": "pass"}], random=[0.5])
    scenario("sample draw above the rate skips the judge",
             config_=config(judge_sample_rate=0.25), dispatch=[noop()], mechanical=[{"verdict": "pass"}],
             random=[0.75])
    scenario("sample rate null raises TypeError after the draw inside the try",
             config_=config(judge_sample_rate=None), dispatch=[noop(), ok()], mechanical=[{"verdict": "pass"}],
             random=[0.1, 0.1, 0.1])
    scenario("judge valid at A2 exhausts escalation",
             job_=critical, progress=prior(next_rung=2), dispatch=[noop(), judged("valid", "still")],
             mechanical=[{"verdict": "pass"}])
    scenario("judge blackout before dispatch defers without repeating the fixer",
             job_=critical, dispatch=[noop()], mechanical=[{"verdict": "pass"}], blocked=[False, True])
    scenario("judge dispatch reports blackout",
             job_=critical, dispatch=[noop(), {"stop": "blackout"}], mechanical=[{"verdict": "pass"}])
    scenario("judge dispatch reports rate limit",
             job_=critical, dispatch=[noop(), {"stop": "rate-limit", "summary": "429"}],
             mechanical=[{"verdict": "pass"}], rate_limit_pause=["2026-11-26T14:00:00Z"])
    scenario("judge dispatch raises: unknown outcome needs a human",
             job_=critical, dispatch=[noop(), raising("RuntimeError", "paseo died")],
             mechanical=[{"verdict": "pass"}])
    scenario("judge dispatch raises OSError",
             job_=critical, dispatch=[noop(), raising("OSError", "pipe")], mechanical=[{"verdict": "pass"}])
    scenario("pending_judge resumes the judge without the fixer",
             job_=critical,
             progress=prior(next_rung=0, attempts=[attempt("A0", "ok", changed=True)],
                            pending_judge={"fixer_reason": "fixed it", "rung": 0}),
             dispatch=[judged("invalid", "not real")], trees=["/T/wt"])
    scenario("pending_judge resumes and escalates on valid",
             progress=prior(next_rung=0, attempts=[attempt("A0", "ok", changed=True)],
                            pending_judge={"fixer_reason": "fixed it", "rung": 0}),
             dispatch=[judged("valid", "real"), ok()], mechanical=[{"verdict": "pass"}], trees=["/T/wt"])
    scenario("pending_judge resumed judge raising drops the pending marker",
             progress=prior(next_rung=0, attempts=[attempt("A0", "ok", changed=True)],
                            pending_judge={"fixer_reason": "fixed it", "rung": 0}),
             dispatch=[raising("ValueError", "judge exploded")], trees=["/T/wt"])
    scenario("pending_judge without fixer_reason raises KeyError into the handler",
             progress=prior(next_rung=0, attempts=[attempt("A0", "ok")], pending_judge={"rung": 0}),
             trees=["/T/wt"])
    scenario("pending_judge in a missing worktree is refused",
             progress=prior(next_rung=0, worktree="/T/gone", pending_judge={"fixer_reason": "r", "rung": 0}))
    scenario("a judge verdict already recorded skips the judge and finalises valid",
             result=prior(next_rung=2, judge=judged("valid", "x"), attempts=[attempt("A0"), attempt("A1")]),
             dispatch=[noop()])
    scenario("a judge verdict already recorded as unsure finalises FAILED evidence",
             result=prior(next_rung=2, judge=judged("unsure", "x"), attempts=[attempt("A0"), attempt("A1")]),
             dispatch=[noop()])
    scenario("a judge verdict already recorded as invalid finalises NOT-FIXED",
             result=prior(next_rung=2, judge=judged("invalid", "x"), attempts=[attempt("A0"), attempt("A1")]),
             dispatch=[noop("")], git=CLEAN_GIT)
    scenario("a falsy empty judge dict has no verdict",
             result=prior(next_rung=2, judge={}, attempts=[attempt("A0"), attempt("A1")]),
             dispatch=[noop()])
    scenario("a truthy non-object judge raises AttributeError into the handler",
             result=prior(next_rung=2, judge="valid", attempts=[attempt("A0"), attempt("A1")]),
             dispatch=[noop()])
    scenario("result without a judge key raises KeyError into the handler",
             job_=critical, result={k: v for k, v in prior(next_rung=0).items() if k != "judge"},
             dispatch=[noop(), ok()], mechanical=[{"verdict": "pass"}])

    # ---- dispatch_pending (interrupted worker) --------------------------------
    scenario("interrupted rung in the same tree is retained then fails closed",
             progress=prior(next_rung=0, dispatch_pending={"rung": "A0", "role": {}}), trees=["/T/wt"])
    scenario("interrupted rung in the same tree: retain failure is recorded",
             progress=prior(next_rung=0, dispatch_pending={"rung": "A0", "role": {}}), trees=["/T/wt"],
             retain=[raising("OSError", "x" * 700)])
    scenario("interrupted rung whose recorded tree is another existing tree adopts it and retains it",
             progress=prior(next_rung=2, dispatch_pending={"rung": "A2", "role": {}}, worktree="/T/wt-A2"),
             trees=["/T/wt", "/T/wt-A2"])
    scenario("interrupted rung whose recorded tree is gone is not retained",
             progress=prior(next_rung=0, dispatch_pending={"rung": "A0", "role": {}}, worktree="/T/gone"))
    scenario("interrupted rung with no recorded worktree key resolves to the cwd",
             progress={k: v for k, v in prior(dispatch_pending={"rung": "A0"}).items() if k != "worktree"})
    scenario("interrupted rung with a null worktree is a TypeError",
             progress=prior(dispatch_pending={"rung": "A0"}, worktree=None))
    scenario("interrupted rung with a numeric worktree is a TypeError",
             progress=prior(dispatch_pending={"rung": "A0"}, worktree=5))
    scenario("an older progress file with dispatch_pending is ignored in favour of result.json",
             result=prior(next_rung=1, attempts=[attempt("A0")]),
             progress=prior(dispatch_pending={"rung": "A0"}), newer=False,
             dispatch=[ok()], mechanical=[{"verdict": "pass"}])
    scenario("dispatch_pending in result.json (not progress) is adopted but not treated as interrupted",
             result=prior(next_rung=0, dispatch_pending={"rung": "A0"}), progress=None, trees=["/T/wt"],
             dispatch=[ok()], mechanical=[{"verdict": "pass"}])
    scenario("falsy dispatch_pending empty dict is not interrupted",
             progress=prior(next_rung=0, dispatch_pending={}), dispatch=[ok()], mechanical=[{"verdict": "pass"}])

    # ---- retention / save failures --------------------------------------------
    scenario("pre-rung retain failure is recorded by the handler and the rung is retried via the next",
             dispatch=[ok()], mechanical=[{"verdict": "pass"}],
             retain=[raising("RuntimeError", "git add failed: x"), None, None])
    scenario("handler retain failure stops the machine",
             dispatch=[{"stop": "error", "summary": "e"}],
             retain=[None, raising("OSError", "y" * 700)])
    scenario("final retain failure turns the verdict FAILED",
             dispatch=[ok()], mechanical=[{"verdict": "pass"}], retain=[None, raising("OSError", "z")])
    scenario("final retain is called with include_clean",
             dispatch=[ok()], mechanical=[{"verdict": "pass"}])

    # ---- selection and resume preamble -----------------------------------------
    scenario("a final prior result is returned untouched", result=prior(verdict="FIXED", reason="done"), final=True)
    scenario("a deferred prior result past its retry_after resumes",
             result=prior(next_rung=1, attempts=[attempt("A0")], retry_after="2026-11-26T11:00:00Z",
                          reason="deferred"),
             dispatch=[ok()], mechanical=[{"verdict": "pass"}])
    scenario("a deferred prior result before retry_after is preserved",
             result=prior(retry_after="2026-11-26T13:00:00Z"))
    scenario("fallback models resume a deferred result even before retry_after",
             config_=config(fallback_models=["x"]),
             result=prior(next_rung=1, attempts=[attempt("A0")], retry_after="2026-11-26T13:00:00Z"),
             dispatch=[ok()], mechanical=[{"verdict": "pass"}])
    scenario("a malformed retry_after escapes as a ValueError",
             result=prior(retry_after="tomorrow"))
    scenario("missing job key escapes as a KeyError", job_={"item": "i"})
    scenario("missing repair config escapes as a KeyError", config_={"clone": "/T/clone"})
    scenario("missing roles escapes as a KeyError", config_={"repair": {}, "clone": "/T/clone"})
    scenario("missing job fields escape as a KeyError", job_={"job": JOB_ID})
    scenario("missing repair_base escapes as a KeyError",
             job_={k: v for k, v in job().items() if k != "repair_base"})

    # ---- fidelity traps ------------------------------------------------------------
    scenario("eager max(): malformed attempts raise even when next_rung is recorded",
             result=prior(next_rung=1, attempts=[{"rung": "Ax"}]))
    scenario("eager max(): attempts missing raises KeyError even when next_rung is recorded",
             result={k: v for k, v in prior(next_rung=1).items() if k != "attempts"})
    scenario("eager max(): an attempt without a rung is a KeyError",
             result=prior(next_rung=1, attempts=[{"stop": "error"}]))
    scenario("eager max(): attempts of rung strings derive the next rung",
             result=prior(attempts=[attempt("A0"), attempt("A1")]),
             dispatch=[ok()], mechanical=[{"verdict": "pass"}])
    scenario("eager max(): the largest rung wins regardless of order",
             result=prior(attempts=[attempt("A1"), attempt("A0")]),
             dispatch=[ok()], mechanical=[{"verdict": "pass"}])
    scenario("eager max(): rung suffix accepts surrounding whitespace and a sign",
             result=prior(attempts=[{"rung": "A +1 "}]), dispatch=[ok()], mechanical=[{"verdict": "pass"}])
    scenario("eager max(): rung suffix accepts underscores between digits",
             result=prior(attempts=[{"rung": "A1_0"}]))
    scenario("eager max(): rung A3 derives next rung 4 and skips the loop",
             result=prior(attempts=[{"rung": "A3"}]))
    scenario("eager max(): negative suffix derives a rung below zero",
             result=prior(attempts=[{"rung": "A-5"}]), dispatch=[ok()], mechanical=[{"verdict": "pass"}])
    scenario("eager max(): rung not a string raises TypeError",
             result=prior(next_rung=1, attempts=[{"rung": 3}]))
    scenario("eager max(): empty rung string raises ValueError",
             result=prior(next_rung=1, attempts=[{"rung": ""}]))
    scenario("eager max(): attempts not a list but an object iterates its keys",
             result=prior(next_rung=1, attempts={"A0": 1}))
    scenario("next_rung explicit null is not an int",
             result=prior(next_rung=None, attempts=[attempt("A0")]))
    scenario("next_rung string is not comparable to an int",
             result=prior(next_rung="1", attempts=[attempt("A0")]))
    scenario("next_rung negative runs fixer rungs from below zero",
             result=prior(next_rung=-1), dispatch=[ok()], mechanical=[{"verdict": "pass"}])
    scenario("next_rung huge integer skips the loop",
             result=prior(next_rung=10 ** 30))
    scenario("fixer_escalation role missing at A2 escapes outside the try",
             config_={"repair": {"roles": {"fixer": roles()["fixer"]}}, "clone": "/T/clone"},
             result=prior(next_rung=2))
    scenario("fixer role without driver fails eagerly for a report that names its own",
             config_={"repair": {"roles": {**roles(), "fixer": {"model": "m"}}}, "clone": "/T/clone"},
             dispatch=[ok(driver="cq", model="m")])
    scenario("fixer role without driver: the handler's own role lookup escapes",
             config_={"repair": {"roles": {**roles(), "fixer": {"model": "m"}}}, "clone": "/T/clone"},
             dispatch=[ok(driver="cq", model="m")], git=CLEAN_GIT)
    scenario("dispatch report that is not an object raises AttributeError into the handler",
             dispatch=["oops", ok()], mechanical=[{"verdict": "pass"}])
    scenario("dispatch report null raises AttributeError into the handler",
             dispatch=[None, ok()], mechanical=[{"verdict": "pass"}])
    scenario("dispatch raising ValueError is caught and recorded",
             dispatch=[raising("ValueError", "launch failed"), ok()], mechanical=[{"verdict": "pass"}])
    scenario("dispatch raising DetectorUnavailable without pending_mechanical is an ordinary failure",
             dispatch=[raising("DetectorUnavailable", "down"), ok()], mechanical=[{"verdict": "pass"}])
    scenario("blocked raising is caught by the handler",
             blocked=[raising("OSError", "pause file")], dispatch=[ok()], mechanical=[{"verdict": "pass"}])
    scenario("git reset failing is caught and advances",
             dispatch=[ok()], mechanical=[{"verdict": "pass"}],
             git={"reset --hard " + BASE: raising("RuntimeError", "git reset failed: locked")})
    scenario("clone worktree add failing at A2",
             result=prior(next_rung=2), dispatch=[],
             git={"worktree add --detach /T/wt-A2 " + BASE: raising("RuntimeError", "git worktree failed: x")})
    scenario("non-ASCII reason survives the saved JSON",
             dispatch=[{"stop": "error", "summary": "café ☃ \U0001F600"}, ok()],
             mechanical=[{"verdict": "pass"}])
    scenario("job directory name taken from an absolute-looking job id",
             job_=job(job="crq-R-F1/../x"), dispatch=[ok()], mechanical=[{"verdict": "pass"}])
    scenario("job id that is not a string is a TypeError", job_=job(job=5))
    scenario("repair that is not an object",
             config_={"repair": [], "clone": "/T/clone"})
    # An empty non-list ``attempts`` passes the eager max() and `not attempts`,
    # then `.append` raises AttributeError at either append site.
    for label, empty in (("mapping", {}), ("string", "")):
        scenario("empty attempts " + label + " cannot take the dispatch append",
                 progress=prior(next_rung=0, attempts=empty), dispatch=[ok()], mechanical=[{"verdict": "pass"}])
        scenario("empty attempts " + label + " cannot take the handler append",
                 progress=prior(next_rung=0, attempts=empty),
                 dispatch=[raising("RuntimeError", "provider down")])


# ---------------------------------------------------------------------------
# running a scenario against the production process()
# ---------------------------------------------------------------------------

EXC = {"ValueError": ValueError, "RuntimeError": RuntimeError, "OSError": OSError, "TypeError": TypeError,
       "DetectorUnavailable": service.DetectorUnavailable}


class FixedDatetime(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        stamp = dt.datetime(2026, 11, 26, 12, 0, 0, tzinfo=dt.timezone.utc)
        return stamp if tz is not None else stamp.replace(tzinfo=None)


def _prepare(spec: dict, tmp: Path) -> None:
    def real(path: str) -> Path:
        return tmp / path.removeprefix("/T/")

    for path in spec["trees"]:
        (real(path) / ".git").mkdir(parents=True, exist_ok=True)
    for path in spec["plain_dirs"]:
        real(path).mkdir(parents=True, exist_ok=True)
    directory = tmp / "root" / "state" / "repair"
    job_id = spec["job"].get("job") if isinstance(spec["job"], dict) else None
    if isinstance(job_id, str) and "/" not in job_id:
        directory = directory / job_id
        directory.mkdir(parents=True, exist_ok=True)
        files = spec["files"]
        written = []
        for key in ("result", "progress"):
            if files[key] is not None:
                path = directory / (key + ".json")
                path.write_text(json.dumps(files[key]), encoding="utf-8")
                written.append((key, path))
        for key, path in written:
            newer = files["progress_newer"]
            stamp = 2_000_000_000 if (key == "progress") == newer else 1_000_000_000
            os.utime(path, ns=(stamp, stamp))


def _run(spec: dict) -> dict:
    tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="rung-machine-")))
    prefix = str(tmp)
    trace: list = []
    writes: list = []

    def scrub(value):
        text = json.dumps(value, default=str, ensure_ascii=True)
        return json.loads(text.replace(prefix, "/T"))

    def unscrub(value):
        return json.loads(json.dumps(value).replace("/T", prefix))

    spec = unscrub(spec)
    seams = copy.deepcopy(spec["seams"])

    def next_answer(name):
        queue = seams.get(name) or []
        if not queue:
            raise Exhausted(name)
        item = queue.pop(0)
        if isinstance(item, dict) and set(item) == {"raise"}:
            info = item["raise"]
            raise EXC[info["kind"]](info["message"])
        return item

    def blocked(repair, now=None):
        trace.append(["blocked"])
        return next_answer("blocked") if seams.get("blocked") else False

    def retain(wt, base, directory, include_clean=False):
        trace.append(["retain", scrub(str(wt)), base, scrub(str(directory)), bool(include_clean)])
        return next_answer("retain") if seams.get("retain") else None

    def retain_nested(wt, base, directory):
        trace.append(["retain_preserving_nested", scrub(str(wt)), base, scrub(str(directory))])
        return next_answer("retain_preserving_nested") if seams.get("retain_preserving_nested") else None

    def git(cwd, *args):
        trace.append(["git", scrub(str(cwd)), *[scrub(str(a)) for a in args]])
        key = " ".join(args)
        answers = spec["git"]
        if key in answers:
            answer = answers[key]
            if isinstance(answer, dict) and "raise" in answer:
                info = answer["raise"]
                raise EXC[info["kind"]](info["message"])
            return answer
        return ""

    def command(argv, cwd=None, **kwargs):
        assert argv[:3] == ["git", "cat-file", "blob"], argv
        trace.append(["cat_file", scrub(str(cwd)), scrub(argv[3])])
        entry = spec["cat_file"].get(argv[3], {"returncode": 128, "stdout": ""})
        return types.SimpleNamespace(returncode=entry["returncode"], stdout=entry["stdout"], stderr="")

    def dispatch(config_, role, current, wt, directory, judge=False):
        trace.append(["dispatch", scrub(role), scrub(copy.deepcopy(current)), scrub(str(wt)),
                      scrub(str(directory)), bool(judge)])
        return next_answer("dispatch")

    def mechanical(config_, wt, base, commits, job_id, directory):
        trace.append(["mechanical", scrub(str(wt)), base, scrub(commits), job_id, scrub(str(directory))])
        return next_answer("mechanical")

    def rate_limit_pause(report, job_id):
        trace.append(["rate_limit_pause", scrub(report), job_id])
        return next_answer("rate_limit_pause")

    real_atomic = service.atomic

    def atomic(path, value):
        real_atomic(path, value)
        writes.append({"path": scrub(str(path)), "text": scrub(Path(path).read_text(encoding="utf-8"))})

    draws = list(spec["seams"].get("random", []))

    def rand():
        trace.append(["random"])
        return draws.pop(0) if draws else 0.99

    patches = {
        "ROOT": tmp / "root", "blocked": blocked, "retain": retain, "retain_preserving_nested": retain_nested,
        "git": git, "command": command, "dispatch": dispatch, "mechanical": mechanical,
        "rate_limit_pause": rate_limit_pause, "atomic": atomic, "utc": lambda: NOW,
        "dt": types.SimpleNamespace(datetime=FixedDatetime, timezone=dt.timezone, timedelta=dt.timedelta),
        "random": types.SimpleNamespace(random=rand),
    }
    saved = {name: getattr(service, name) for name in patches}
    os.environ["LANG"] = "C.UTF-8"
    try:
        for name, value in patches.items():
            setattr(service, name, value)
        _prepare(spec, tmp)
        outcome: dict
        try:
            try:
                returned = service.process(copy.deepcopy(spec["config"]), copy.deepcopy(spec["job"]), Path(spec["wt"]))
            except Exhausted as gap:
                GAPS.append(f"{spec['name']!r}: ran out of scripted {gap} answers")
                outcome = {"gap": str(gap)}
                return {"trace": trace, "writes": writes, **outcome}
            outcome = {"returned": scrub(returned)}
        except Exception as exc:  # the recorded subject: what escapes process()
            name = type(exc).__name__
            outcome = {"raises": name}
            if name in MESSAGE_KINDS:
                outcome["message"] = scrub(str(exc))
            outcome["is_value_error"] = isinstance(exc, ValueError)
    finally:
        for name, value in saved.items():
            setattr(service, name, value)
        shutil.rmtree(tmp, ignore_errors=True)
    return {"trace": trace, "writes": writes, **outcome}


def build() -> dict:
    SCENARIOS.clear()
    build_scenarios()
    names = [s["name"] for s in SCENARIOS]
    assert len(names) == len(set(names)), "duplicate scenario names"
    cases = []
    for spec in SCENARIOS:
        cases.append({"name": spec["name"], "scenario": spec, "expected": _run(copy.deepcopy(spec))})
    if GAPS:
        raise SystemExit("scenario scripting gaps:\n  " + "\n  ".join(GAPS))
    return {"schema": SCHEMA, "now": NOW, "base": BASE, "cases": cases}


def render(document: dict) -> str:
    head = {key: value for key, value in document.items() if key != "cases"}
    lines = [json.dumps(case, ensure_ascii=True, separators=(",", ":")) for case in document["cases"]]
    return (json.dumps(head, ensure_ascii=True)[:-1] + ',"cases":[\n' + ",\n".join(lines) + "\n]}\n")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    text = render(build())
    if args.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(text, encoding="utf-8")
        return 0
    if not FIXTURE.exists() or FIXTURE.read_text(encoding="utf-8") != text:
        print("rung-machine fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
