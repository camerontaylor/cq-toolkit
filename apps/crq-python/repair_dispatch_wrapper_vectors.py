#!/usr/bin/env python3
"""Deterministic offline oracle for the TS port of the ``dispatch()`` wrapper.

Test tooling only. It runs the PRODUCTION ``crq_repair.dispatch`` (and through it
``_dispatch``, ``review_diff_sections``, ``fallback_roles``, ``role_provider`` and
``correlation``; ``crq_repair.py:193-461``) over a throwaway directory and records,
per scenario:

* the TRACE of every injected seam call, in order, with its arguments (the clock,
  git, the cooldown state, provider readiness, ``remember_provider_limit``,
  ``blocked``, the retention call, the scans, the snapshot reads and the driver
  entry points, each with the CQ_* environment it ran under);
* the value ``dispatch`` returned, or the exception class (and message, where the
  code under test authored it) that escaped it;
* the directories ``dispatch`` created and the CQ_* environment afterwards.

Only effects are replaced: ``time.monotonic`` and ``datetime.now`` (scripted),
``git``, ``retain_preserving_nested``, ``provider_cooldowns``, ``provider_ready``,
``remember_provider_limit``, ``blocked``, ``utc``, ``require_canonical_delivery``,
``source_snapshot``, ``triage_context_safe``, ``atomic`` and the three driver
modules. ``dispatch`` / ``_dispatch`` / ``review_diff_sections`` / ``fallback_roles``
/ ``role_provider`` / ``correlation`` and the directory creation are the real
production code. Scenario paths start with ``/T``; the oracle substitutes its
temporary directory and substitutes it back in every recorded value, so the
fixture is host independent. No provider, queue, signer, network or host service
is touched.

Regenerate with ``python3 repair_dispatch_wrapper_vectors.py --write`` and verify
with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import copy
import datetime as real_dt
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time as real_time
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-dispatch-wrapper" / "cases.json"
SCHEMA = "cq.crq-dispatch-wrapper-vector/v1"
MESSAGE_KINDS = ["ValueError", "KeyError", "RuntimeError", "OSError"]
EXC = {"ValueError": ValueError, "KeyError": KeyError, "RuntimeError": RuntimeError, "OSError": OSError,
       "TypeError": TypeError}
ENV_KEYS = ("CQ_WORK_ID", "CQ_RUN_ID", "CQ_ROLE", "CQ_TASK", "CQ_PARENT_WORK_ID")
BASE = "b" * 40
NOW = "2026-01-01T00:00:00.500000+00:00"
STAMP = "2026-01-01T00:00:00Z"


def _service():
    """Load the production repair service module, not a copy of it."""
    sys.path.insert(0, str(HERE))
    spec = importlib.util.spec_from_file_location("repair_dispatch_wrapper_oracle", HERE / "crq_repair.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


service = _service()


class Exhausted(BaseException):
    """A scenario ran out of scripted answers: never caught by ``except Exception``."""


def raising(kind, message):
    return {"raise": {"kind": kind, "message": message}}


CQ = {"driver": "cq", "model": "zai/glm-5.1"}


def cfg(fallback=("deepseek/ds-1",), minutes=10, **repair):
    repair_cfg = {"budget": {"wall_clock_min": minutes}, "roles": {"fixer": CQ}}
    if fallback is not None:
        repair_cfg["fallback_models"] = list(fallback) if isinstance(fallback, tuple) else fallback
    repair_cfg.update(repair)
    return {"repair": repair_cfg}


def job(**extra):
    base = {"job": "crq-R-F1", "run": "R", "review_diff": ""}
    base.update(extra)
    return base


SCENARIOS: list[dict] = []


def scenario(name, *, config=None, role=None, job_=None, judge=False, **seams):
    spec = {"name": name, "config": cfg(None) if config is None else config, "role": CQ if role is None else role,
            "job": job() if job_ is None else job_, "judge": judge,
            "seams": {key: (value if isinstance(value, (str, dict)) or value is None else list(value))
                      for key, value in seams.items()}}
    SCENARIOS.append(spec)
    return spec


def fb(name, *, fallback=("deepseek/ds-1",), minutes=10, role=None, **kw):
    """A fallback-path scenario: ``fallback_models`` configured."""
    return scenario(name, config=cfg(fallback, minutes), role=role, **kw)


def drv(report=None, **extra):
    base = {"stop": "ok"} if report is None else report
    return {**base, **extra}


RL = {"stop": "rate-limit", "summary": "429"}


def build_scenarios() -> None:
    # --- no fallback_models: one _dispatch under the job's identity ----------------------------
    scenario("plain: a cq fixer runs the full preparation then cq.invoke", monotonic=[], driver=[drv()])
    scenario("plain: a cq judge calls cq.judge", judge=True, driver=[drv()])
    scenario("plain: a codex fixer calls codex.invoke", role={"driver": "codex", "model": "gpt-5.2"},
             driver=[drv()])
    scenario("plain: a codex judge passes judge=True", role={"driver": "codex", "model": "gpt-5.2"},
             judge=True, driver=[drv()])
    scenario("plain: a paseo judge calls paseo.invoke", role={"driver": "paseo", "model": "codex/x"},
             judge=True, driver=[drv()])
    scenario("plain: a paseo fixer is unsupported", role={"driver": "paseo", "model": "codex/x"})
    scenario("plain: an unknown driver is unsupported", role={"driver": "mystery", "model": "m"})
    scenario("plain: a role without a driver is a KeyError", role={"model": "m"})
    scenario("plain: a null driver is unsupported", role={"driver": None, "model": "m"})
    for label, value in (("absent", None), ("empty list", []), ("empty string", ""), ("null", "NULL"), ("empty dict", {}), ("zero", 0)):
        repair = {"budget": {"wall_clock_min": 10}, "roles": {"fixer": CQ}}
        if label != "absent":
            repair["fallback_models"] = None if value == "NULL" else value
        scenario(f"plain: a falsy fallback_models ({label}) takes the single path",
                 config={"repair": repair}, driver=[drv()])
    scenario("plain: an unbounded config reaches the driver untouched",
             config={"repair": {"budget": {"wall_clock_min": 7.5}, "x": 1}}, driver=[drv()])
    scenario("plain: a config without a budget is never consulted", config={"repair": {}}, driver=[drv()])
    scenario("plain: a config without repair gets an empty repair for the blackout check",
             config={}, driver=[drv()])
    scenario("plain: a list config is an AttributeError", config=[1])
    scenario("plain: a null repair is an AttributeError", config={"repair": None})
    scenario("plain: a list repair is an AttributeError", config={"repair": [1]})
    scenario("plain: blackout at the last boundary stops before any driver", blocked=[True])
    scenario("plain: a truthy blackout value stops", blocked=["yes"])
    scenario("plain: a falsy blackout value proceeds", blocked=[0], driver=[drv()])
    scenario("plain: a driver failure escapes and the environment is restored",
             driver=[raising("RuntimeError", "provider exploded")])
    scenario("plain: a canonical-delivery refusal escapes before the snapshot",
             canonical=[raising("ValueError", "not canonical")])
    scenario("plain: a driver report is returned as is, not updated", driver=[["not", "a", "dict"]])

    # --- the triage_context fast path -------------------------------------------------------------
    scenario("triage: a triage_context job goes straight to cq.judge", role={"driver": "codex", "model": "m"},
             job_=job(triage_context={"finding": {"path": "a"}}), driver=[drv()])
    scenario("triage: it skips the scans and the blackout check", blocked=[True],
             job_=job(triage_context={"k": 1}, review_diff="diff --git a/x b/x\n+ secret"), scan=[False],
             driver=[drv()])
    scenario("triage: a falsy non-null triage_context still takes the fast path",
             job_=job(triage_context=""), driver=[drv()])
    scenario("triage: an explicit null triage_context falls through", job_=job(triage_context=None),
             driver=[drv()])
    scenario("triage: a fallback dispatch hands the unbounded identity to cq.judge under a deadline",
             config=cfg(("deepseek/ds-1",), 10), job_=job(triage_context={"k": 1}), monotonic=[100.0, 160.0],
             driver=[drv()])

    # --- the identity (correlation) ---------------------------------------------------------------
    scenario("identity: a missing run is a KeyError before any directory is made", job_={"job": "j"})
    scenario("identity: a missing job is a KeyError", job_={"run": "R"})
    scenario("identity: a list job is a TypeError", job_=[1])
    scenario("identity: an int run is stringified", job_=job(run=5), driver=[drv()])
    scenario("identity: a null run is stringified", job_=job(run=None), driver=[drv()])
    scenario("identity: a bool job is stringified", job_=job(job=True), driver=[drv()])
    scenario("identity: a judge flag selects the judge role", judge=True, driver=[drv()])

    # --- the source snapshot scan ----------------------------------------------------------------
    scenario("snapshot: an unclean excerpt is refused before the review diff", scan=[False])
    for label, verdict in (("empty string", ""), ("zero", 0), ("null", None), ("empty list", [])):
        scenario(f"snapshot: a falsy scan verdict ({label}) refuses", scan=[verdict])
    scenario("snapshot: a truthy non-bool verdict proceeds", scan=["yes", "yes"], driver=[drv()])
    scenario("snapshot: a falsy path falls back to the generic path", snapshot=[{"path": "", "source": "s"}],
             driver=[drv()])
    scenario("snapshot: a null path falls back to the generic path", snapshot=[{"path": None, "source": "s"}],
             driver=[drv()])
    scenario("snapshot: a missing source defaults to empty", snapshot=[{"path": "p.py"}], driver=[drv()])
    scenario("snapshot: a null source is passed through", snapshot=[{"path": "p.py", "source": None}],
             driver=[drv()])
    scenario("snapshot: a non-string truthy path is passed through", snapshot=[{"path": 7, "source": "s"}],
             driver=[drv()])
    scenario("snapshot: a list snapshot is an AttributeError", snapshot=[[1]])
    scenario("snapshot: a null snapshot is an AttributeError", snapshot=[None])
    scenario("snapshot: the snapshot is attached to the job handed to the driver",
             snapshot=[{"path": "p.py", "source": "s", "n": 1}], driver=[drv()])
    scenario("snapshot: a source_snapshot failure escapes", snapshot=[raising("OSError", "disk")])

    # --- the review diff scan ---------------------------------------------------------------------
    one = "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n+hello"
    scenario("diff: an empty diff is one empty section", job_=job(review_diff=""), driver=[drv()])
    scenario("diff: a missing review_diff defaults to one empty section", job_={"job": "j", "run": "R"},
             driver=[drv()])
    scenario("diff: a null review_diff is the text None", job_=job(review_diff=None), driver=[drv()])
    scenario("diff: an int review_diff is its decimal text", job_=job(review_diff=5), driver=[drv()])
    scenario("diff: a list review_diff is its repr", job_=job(review_diff=[1, "a"]), driver=[drv()])
    scenario("diff: a dict review_diff is its repr", job_=job(review_diff={"k": [True, None]}), driver=[drv()])
    scenario("diff: a single file section is scanned under its path", job_=job(review_diff=one),
             driver=[drv()])
    scenario("diff: text before the first header keeps the generic path",
             job_=job(review_diff="preamble\nmore\n" + one), driver=[drv()])
    scenario("diff: two sections are scanned under their own paths",
             job_=job(review_diff=one + "\ndiff --git a/k.env b/k.env\n+KEY=1\n"), driver=[drv()])
    scenario("diff: an unclean second section is refused after the first passes",
             job_=job(review_diff=one + "\ndiff --git a/k.env b/k.env\n+KEY=1\n"),
             scan=[True, True, False])
    scenario("diff: an unclean first section is refused", job_=job(review_diff=one), scan=[True, False])
    scenario("diff: a header without ' b/' is scanned under the whole header line",
             job_=job(review_diff='diff --git "a/\\303\\251" "b/\\303\\251"\n+x'), driver=[drv()])
    scenario("diff: a bare header scans under the stripped header",
             job_=job(review_diff="diff --git \n+x"), driver=[drv()])
    scenario("diff: an empty tail after ' b/' falls back to the generic path",
             job_=job(review_diff="diff --git a/x b/ \n+x"), driver=[drv()])
    scenario("diff: the last ' b/' wins", job_=job(review_diff="diff --git a/x b/y b/z\n+x"),
             driver=[drv()])
    scenario("diff: unicode whitespace around the tail is stripped",
             job_=job(review_diff="diff --git a/x b/ p.py \n+x"), driver=[drv()])
    scenario("diff: CRLF and the other universal line breaks split lines",
             job_=job(review_diff="a\r\nb\x0bc\x0cd\x1ce\x1df\x1eg\x85h i j\n"), driver=[drv()])
    scenario("diff: a header after a CR is a new section",
             job_=job(review_diff="a\rdiff --git a/x b/x\r\n+y\r\n"), driver=[drv()])
    scenario("diff: blank lines are kept and the trailing newline is not a line",
             job_=job(review_diff=one + "\n\n\n"), driver=[drv()])
    scenario("diff: a header line alone is a section", job_=job(review_diff="diff --git a/x b/x"),
             driver=[drv()])
    scenario("diff: a diff of only a line break is one empty-line section", job_=job(review_diff="\n"),
             driver=[drv()])
    scenario("diff: a line starting with a header prefix mid-line is not a header",
             job_=job(review_diff=" diff --git a/x b/x\nplain"), driver=[drv()])

    # --- directories ------------------------------------------------------------------------------
    scenario("dirs: the output directory is created with its parents",
             directory="/T/deep/er/out", driver=[drv()])

    # --- fallback: the deadline and the budget ----------------------------------------------------
    fb("budget: one provider succeeds with the remaining time as the budget",
       monotonic=[100.0, 160.0, 280.0], driver=[drv()])
    scenario("budget: a missing budget still reads the clock first",
             config={"repair": {"fallback_models": ["a/b"], "roles": {}}}, monotonic=[100.0])
    scenario("budget: a missing wall_clock_min is a KeyError after the clock read",
             config={"repair": {"fallback_models": ["a/b"], "budget": {}}}, monotonic=[100.0])
    scenario("budget: a string wall_clock_min is a TypeError after the clock read",
             config=cfg(("a/b",), "10"), monotonic=[100.0])
    scenario("budget: a null wall_clock_min is a TypeError", config=cfg(("a/b",), None), monotonic=[100.0])
    scenario("budget: a list wall_clock_min is a TypeError", config=cfg(("a/b",), [1]), monotonic=[100.0])
    scenario("budget: a null budget is a TypeError", config={"repair": {"fallback_models": ["a/b"], "budget": None}},
             monotonic=[100.0])
    scenario("budget: a bool wall_clock_min counts as a number", config=cfg(("a/b",), True),
             monotonic=[100.0, 130.0, 159.0], git=[BASE], driver=[drv()])
    scenario("budget: an int minutes value is scaled to seconds", config=cfg(("a/b",), 2),
             monotonic=[100.0, 120.0, 200.0], driver=[drv()])
    scenario("budget: a negative budget stops at the first candidate", config=cfg(("a/b",), -1),
             monotonic=[100.0, 100.5])
    scenario("budget: remaining just under a millisecond stops", config=cfg(("a/b",), 0),
             monotonic=[100.0, 99.9995])
    scenario("budget: remaining of exactly a millisecond launches", config=cfg(("a/b",), 0),
             monotonic=[100.0, 99.999, 99.999], driver=[drv()])
    scenario("budget: the deadline can lapse during the last-boundary preparation",
             config=cfg(("a/b",), 1), monotonic=[100.0, 110.0, 161.0])
    scenario("budget: retention and reset can consume the shared budget",
             config=cfg(("deepseek/ds-1",), 1), monotonic=[100.0, 110.0, 150.0, 190.0],
             driver=[drv(RL)], remember=[STAMP], blocked=[False])
    scenario("budget: remaining shrinks across launches", config=cfg(("deepseek/ds-1",), 2),
             monotonic=[100.0, 110.0, 130.0, 150.0, 160.0, 190.0, 200.0, 210.0],
             driver=[drv(RL), drv()], remember=["2026-01-01T00:20:00Z"])

    # --- fallback: provider selection and cooldowns -----------------------------------------------
    fb("select: the first ready provider is launched and its report tagged",
       monotonic=[0.0, 1.0, 2.0], driver=[drv(summary="done")])
    fb("select: a report that is not a rate-limit is returned without trying the next",
       monotonic=[0.0, 1.0, 2.0], driver=[drv({"stop": "budget"})])
    fb("select: a report with no stop is returned", monotonic=[0.0, 1.0, 2.0], driver=[{"verdict": "ok"}])
    fb("select: a report that is not an object is an AttributeError", monotonic=[0.0, 1.0, 2.0],
       driver=[["x"]])
    fb("select: a string report is an AttributeError", monotonic=[0.0, 1.0, 2.0], driver=["done"])
    fb("select: a provider whose environment is not ready is skipped", ready=[False, True],
       monotonic=[0.0, 1.0, 2.0], driver=[drv()])
    fb("select: no ready provider is a configuration stop", ready=[False, False])
    fb("select: a duplicate provider is skipped without a readiness read",
       fallback=("zai/glm-5.2",),
       monotonic=[0.0, 1.0, 2.0, 3.0, 4.0], driver=[drv(RL)], remember=["2026-01-01T00:10:00Z"])
    fb("select: a codex-prefixed model shares the openai cooldown", fallback=("codex/x", "openai/y"),
       role={"driver": "cq", "model": "openai/z"}, monotonic=[0.0, 1.0, 2.0], driver=[drv()])
    fb("select: an unprefixed model falls back to its driver as the provider",
       fallback=("gpt-5.2",), role={"driver": "cq", "model": "gpt-5.1"}, monotonic=[0.0, 1.0, 2.0],
       driver=[drv()])
    fb("select: the role itself is not duplicated as its own fallback", fallback=("zai/glm-5.1",),
       monotonic=[0.0, 1.0, 2.0], driver=[drv()])
    fb("select: a string fallback_models iterates its characters", fallback="ab",
       monotonic=[0.0, 1.0, 2.0], driver=[drv()])
    fb("select: a dict fallback_models iterates its keys", fallback={"deepseek/k": 1},
       monotonic=[0.0, 1.0, 2.0], driver=[drv()])
    fb("select: a numeric fallback_models is not iterable", fallback=5, monotonic=[0.0])
    fb("select: a null fallback model is an AttributeError in role_provider", fallback=[None],
       monotonic=[0.0, 1.0, 2.0, 3.0, 4.0], driver=[drv(RL)], remember=["2026-01-01T00:10:00Z"])
    fb("select: a non-string model is an AttributeError", fallback=[7],
       monotonic=[0.0, 1.0, 2.0, 3.0, 4.0], driver=[drv(RL)], remember=["2026-01-01T00:10:00Z"])
    fb("select: a role without a model is a KeyError", role={"driver": "cq"}, monotonic=[0.0])
    fb("select: a role without a driver is a KeyError", role={"model": "zai/x"}, monotonic=[0.0])
    fb("select: an empty prefix keeps the provider directory", fallback=("/x",),
       role={"driver": "cq", "model": "/y"}, monotonic=[0.0, 1.0, 2.0], driver=[drv()])
    fb("select: a dot provider keeps the provider directory", fallback=("./x",),
       role={"driver": "cq", "model": "./y"}, monotonic=[0.0, 1.0, 2.0], driver=[drv()])
    fb("select: a non-string driver without a model prefix is the provider", role={"driver": 5, "model": "m"},
       fallback=("x",), monotonic=[0.0, 1.0, 2.0], driver=[drv()])
    fb("select: an unhashable driver is a TypeError", role={"driver": [1], "model": "m"}, fallback=("x",),
       monotonic=[0.0])
    fb("select: a persisted cooldown in the future defers without a launch", cooldowns=[{"zai": "2026-01-01T01:00:00Z"}],
       monotonic=[0.0, 1.0, 2.0], driver=[drv()])
    fb("select: a cooldown equal to now is expired", cooldowns=[{"zai": STAMP}],
       monotonic=[0.0, 1.0, 2.0], driver=[drv()])
    fb("select: every provider cooling is a rate-limit with the earliest end",
       cooldowns=[{"zai": "2026-01-01T00:10:00Z"}, {"deepseek": "2026-01-01T00:05:00Z"}], monotonic=[0.0])
    fb("select: a cooldown under a minute floors the wait at 1000 ms",
       cooldowns=[{"zai": "2026-01-01T00:00:00Z"}, {"deepseek": "2026-01-01T00:00:00Z"}], utc="2025-12-31T23:59:59Z",
       monotonic=[0.0], driver=[drv(RL)], remember=["2026-01-01T00:00:00Z"])
    fb("select: corrupt cooldown state escapes", cooldowns=[raising("ValueError", "provider-cooldowns.json is unreadable")],
       monotonic=[0.0])
    fb("select: a codex role is also a fallback lane under its own cooldown",
       role={"driver": "codex", "model": "gpt-5.2"}, cooldowns=[{"openai": "2026-01-01T00:30:00Z"}],
       monotonic=[0.0])
    fb("select: a codex fixer rate-limit waits and surfaces the retry",
       role={"driver": "codex", "model": "gpt-5.2"}, monotonic=[0.0, 1.0, 2.0], driver=[drv(RL)],
       remember=["2026-01-01T00:10:00Z"])
    fb("select: a paseo judge honours its provider cooldown", role={"driver": "paseo", "model": "codex/x"},
       judge=True, cooldowns=[{"openai": "2026-01-01T00:30:00Z"}], monotonic=[0.0])
    fb("select: a paseo judge launches when ready", role={"driver": "paseo", "model": "codex/x"},
       judge=True, monotonic=[0.0, 1.0, 2.0], driver=[drv()])
    fb("select: a cq fallback next to a cooled codex role is not blocked by it",
       role={"driver": "codex", "model": "gpt-5.2"}, fallback=("zai/g",),
       cooldowns=[{"openai": "2026-01-01T00:30:00Z"}], monotonic=[0.0])

    # --- fallback: the rate-limit loop ------------------------------------------------------------
    scenario("loop: a rate-limit on the first provider falls through to the next after cleanup",
             config=cfg(("deepseek/ds-1",), 10), monotonic=[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
             driver=[drv(RL, retry_after_ms=5), drv(summary="fixed")], remember=["2026-01-01T00:10:00Z"])
    scenario("loop: a judge falls through without retention or reset", judge=True,
             config=cfg(("deepseek/ds-1",), 10), monotonic=[0.0, 1.0, 2.0, 3.0, 4.0],
             driver=[drv(RL), drv()], remember=["2026-01-01T00:10:00Z"])
    scenario("loop: a retention failure escapes before any reset",
             config=cfg(("deepseek/ds-1",), 10), monotonic=[0.0, 1.0, 2.0, 3.0],
             driver=[drv(RL)], remember=["2026-01-01T00:10:00Z"], retain=[raising("OSError", "disk full")])
    scenario("loop: a reset failure escapes before the clean",
             config=cfg(("deepseek/ds-1",), 10), monotonic=[0.0, 1.0, 2.0, 3.0],
             driver=[drv(RL)], remember=["2026-01-01T00:10:00Z"], git=[BASE, raising("RuntimeError", "reset failed")])
    scenario("loop: a baseline failure escapes before the identity is set",
             config=cfg(("deepseek/ds-1",), 10), monotonic=[0.0], git=[raising("RuntimeError", "no HEAD")])
    scenario("loop: the second launch is deferred when its window reaches the blackout",
             config=cfg(("deepseek/ds-1",), 10), monotonic=[0.0, 1.0, 2.0, 3.0, 4.0],
             driver=[drv(RL)], remember=["2026-01-01T00:10:00Z"], blocked=[True])
    scenario("loop: the first launch is not rechecked by the wrapper", config=cfg(("deepseek/ds-1",), 10),
             monotonic=[0.0, 1.0, 2.0], blocked=[True, True], driver=[drv()])
    scenario("loop: a blackout during preparation of the first launch is returned and tagged",
             config=cfg(("deepseek/ds-1",), 10), monotonic=[0.0, 1.0, 2.0], blocked=[True])
    scenario("loop: every provider rate-limited reports the earliest recorded end",
             config=cfg(("deepseek/ds-1",), 10), monotonic=[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
             driver=[drv(RL), drv(RL)], remember=["2026-01-01T00:10:00Z", "2026-01-01T00:05:00Z"])
    scenario("loop: the retry floor is one second", config=cfg(("deepseek/ds-1",), 10),
             monotonic=[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0], driver=[drv(RL), drv(RL)],
             remember=["2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z"])
    scenario("loop: an unzoned recorded end is a TypeError", config=cfg(("a/b",)),
             monotonic=[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0], driver=[drv(RL), drv(RL)],
             remember=["2026-01-01T00:10:00", "2026-01-01T00:10:00Z"])
    scenario("loop: an unparsable recorded end is a ValueError", config=cfg(("a/b",)),
             monotonic=[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0], driver=[drv(RL), drv(RL)], remember=["soon", "soon"])
    scenario("loop: remember_provider_limit sees the tagged report", config=cfg(("a/b",)),
             monotonic=[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
             driver=[drv(RL, retry_after_ms=10, providerSignals={"retryAfterMs": 4}), drv(RL)],
             remember=["2026-01-01T00:10:00Z", "2026-01-01T00:12:00Z"])
    scenario("loop: a remember failure escapes", config=cfg(("a/b",)), monotonic=[0.0, 1.0, 2.0],
             driver=[drv(RL)], remember=[raising("OSError", "lock")])
    scenario("loop: the first provider cooled and the second launches without cleanup",
             config=cfg(("deepseek/ds-1",), 10), cooldowns=[{"zai": "2026-01-01T01:00:00Z"}, {}],
             monotonic=[0.0, 1.0, 2.0], driver=[drv()])
    scenario("loop: a launch after a skipped provider still cleans nothing (attempted stays false)",
             config=cfg(("deepseek/ds-1",), 10), ready=[False, True],
             monotonic=[0.0, 1.0, 2.0], driver=[drv()])
    scenario("loop: three providers carry the previous directory forward",
             config=cfg(("deepseek/ds-1", "opencode-go/kimi"), 30),
             monotonic=[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0],
             driver=[drv(RL), drv(RL), drv()], remember=["2026-01-01T00:10:00Z", "2026-01-01T00:11:00Z"])
    scenario("loop: a driver failure on a later provider escapes and the identity is restored",
             config=cfg(("deepseek/ds-1",), 10), monotonic=[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
             driver=[drv(RL), raising("RuntimeError", "boom")], remember=["2026-01-01T00:10:00Z"])
    scenario("loop: a scan refusal on the first provider escapes the whole dispatch",
             config=cfg(("deepseek/ds-1",), 10), monotonic=[0.0, 1.0, 2.0], scan=[False])
    scenario("loop: the stale parent identity is cleared under the fallback path",
             config=cfg(("a/b",)), monotonic=[0.0, 1.0, 2.0], driver=[drv()])
    scenario("loop: a missing run is a KeyError after the baseline read",
             config=cfg(("a/b",)), job_={"job": "j"}, monotonic=[0.0])


class FakeDT(real_dt.datetime):
    scripted = NOW

    @classmethod
    def now(cls, tz=None):
        return real_dt.datetime.fromisoformat(cls.scripted)


def _run(spec: dict) -> dict:
    tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dispatch-wrapper-")))
    prefix = str(tmp)
    trace: list = []

    def scrub(value):
        text = json.dumps(value, default=str, ensure_ascii=True)
        return json.loads(text.replace(prefix, "/T"))

    def unscrub(value):
        return json.loads(json.dumps(value).replace("/T", prefix))

    spec = unscrub(spec)
    seams = copy.deepcopy(spec["seams"])

    def env_view():
        return {key: os.environ.get(key) for key in ENV_KEYS}

    def answer(name, default=Exhausted):
        items = seams.get(name)
        if not items:
            if default is Exhausted:
                raise Exhausted(name)
            return copy.deepcopy(default)
        item = items.pop(0)
        if isinstance(item, dict) and set(item) == {"raise"}:
            info = item["raise"]
            raise EXC[info["kind"]](info["message"])
        return item

    stamp = seams.get("utc", STAMP)
    now = seams.get("now", NOW)

    ticks = [0.0]

    def monotonic():
        scripted = seams.get("monotonic")
        value = scripted.pop(0) if scripted else ticks[0] + 1.0
        ticks[0] = value
        trace.append(["monotonic", value])
        return value

    def utc():
        trace.append(["utc"])
        return stamp

    def git(wt, *args):
        trace.append(["git", scrub(str(wt)), *args])
        return answer("git", BASE if args[:1] == ("rev-parse",) else "")

    def retain_preserving_nested(wt, base, directory):
        trace.append(["retain", scrub(str(wt)), base, scrub(str(directory)), env_view()])
        return answer("retain", None)

    def provider_cooldowns():
        trace.append(["cooldowns"])
        return answer("cooldowns", {})

    def provider_ready(role):
        trace.append(["ready", scrub(role)])
        return answer("ready", True)

    def remember_provider_limit(provider, report):
        trace.append(["remember", provider, scrub(report)])
        return answer("remember")

    def blocked(repair, now_=None):
        trace.append(["blocked", scrub(repair)])
        return answer("blocked", False)

    def require_canonical_delivery(root, job_):
        trace.append(["canonical", scrub(job_)])
        return answer("canonical", None)

    def source_snapshot(config, job_):
        trace.append(["snapshot", scrub(job_), budget(config)])
        return answer("snapshot", {"path": "src/a.py", "source": "x"})

    def triage_context_safe(c, context, output):
        trace.append(["scan", scrub(context), scrub(str(output))])
        return answer("scan", True)

    def atomic(path, value):
        trace.append(["atomic", scrub(str(path)), scrub(value)])

    def budget(config):
        repair = config.get("repair") if isinstance(config, dict) else None
        section = repair.get("budget") if isinstance(repair, dict) else None
        return section.get("wall_clock_min") if isinstance(section, dict) else None

    def driver_call(name):
        def call(config, role, job_, wt, directory, **kw):
            trace.append(["driver", name, budget(config), scrub(role), scrub(job_), scrub(str(wt)),
                          scrub(str(directory)), kw.get("judge"), env_view()])
            return answer("driver", {"stop": "ok"})
        return call

    fake_cq = types.SimpleNamespace(judge=driver_call("cq.judge"), invoke=driver_call("cq.invoke"))
    fake_codex = types.SimpleNamespace(invoke=driver_call("codex.invoke"))
    fake_paseo = types.SimpleNamespace(invoke=driver_call("paseo.invoke"))
    fake_time = types.SimpleNamespace(monotonic=monotonic)
    FakeDT.scripted = now
    fake_dt = types.SimpleNamespace(datetime=FakeDT, timezone=real_dt.timezone, timedelta=real_dt.timedelta)

    patches = {"git": git, "retain_preserving_nested": retain_preserving_nested,
               "provider_cooldowns": provider_cooldowns, "provider_ready": provider_ready,
               "remember_provider_limit": remember_provider_limit, "blocked": blocked, "utc": utc,
               "require_canonical_delivery": require_canonical_delivery, "source_snapshot": source_snapshot,
               "triage_context_safe": triage_context_safe, "atomic": atomic, "cq": fake_cq, "codex": fake_codex,
               "paseo": fake_paseo, "time": fake_time, "dt": fake_dt}
    saved = {name: getattr(service, name) for name in patches}
    saved_crq = sys.modules.get("crq")
    saved_env = {key: os.environ.get(key) for key in ENV_KEYS}
    os.environ.pop("CQ_WORK_ID", None)
    os.environ.pop("CQ_RUN_ID", None)
    os.environ.pop("CQ_ROLE", None)
    os.environ.pop("CQ_TASK", None)
    os.environ["CQ_PARENT_WORK_ID"] = "stale-parent"
    before_env = env_view()
    directory = Path(seams["directory"]) if isinstance(seams.get("directory"), str) else tmp / "out"
    try:
        for name, value in patches.items():
            setattr(service, name, value)
        sys.modules["crq"] = types.ModuleType("crq")
        try:
            try:
                returned = service.dispatch(copy.deepcopy(spec["config"]), copy.deepcopy(spec["role"]),
                                            copy.deepcopy(spec["job"]), str(tmp / "wt"), directory,
                                            spec["judge"])
            except Exhausted as gap:
                GAPS.append(f"{spec['name']!r}: ran out of scripted {gap} answers")
                return {"trace": trace, "gap": str(gap)}
            outcome = {"returned": scrub(returned)}
        except Exception as exc:  # the recorded subject: what escapes dispatch()
            name = type(exc).__name__
            outcome = {"raises": name}
            if name in MESSAGE_KINDS:
                outcome["message"] = scrub(str(exc))
        outcome["env_after"] = env_view()
        outcome["env_restored"] = env_view() == before_env
        dirs = sorted(str(p.relative_to(tmp)) for p in tmp.rglob("*") if p.is_dir())
        outcome["dirs"] = dirs
    finally:
        for name, value in saved.items():
            setattr(service, name, value)
        if saved_crq is None:
            sys.modules.pop("crq", None)
        else:
            sys.modules["crq"] = saved_crq
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(tmp, ignore_errors=True)
    return {"trace": trace, **outcome}


GAPS: list[str] = []


def build() -> dict:
    SCENARIOS.clear()
    GAPS.clear()
    build_scenarios()
    names = [s["name"] for s in SCENARIOS]
    assert len(names) == len(set(names)), "duplicate scenario names"
    cases = [{"name": s["name"], "scenario": s, "expected": _run(copy.deepcopy(s))} for s in SCENARIOS]
    if GAPS:
        raise SystemExit("scenario scripting gaps:\n  " + "\n  ".join(GAPS))
    return {"schema": SCHEMA, "cases": cases}


def render(document: dict) -> str:
    head = {key: value for key, value in document.items() if key != "cases"}
    lines = [json.dumps(case, ensure_ascii=True, separators=(",", ":")) for case in document["cases"]]
    return json.dumps(head, ensure_ascii=True)[:-1] + ',"cases":[\n' + ",\n".join(lines) + "\n]}\n"


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
        print("dispatch-wrapper fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
