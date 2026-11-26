#!/usr/bin/env python3
"""Deterministic offline oracle for the TS triage judge bridge and gate closure.

Test tooling only. It drives the PRODUCTION Python and records what it does:

* ``judge`` (``crq_repair/drivers/cq.py:306-360``): the request it writes to
  ``judge-request.json`` (exact text), the ``node judge-cq.mjs`` command line
  and kill timeout it hands to ``command``, the invocation log it appends, and
  the report it returns for a scripted process outcome (timeout, non-zero exit,
  ok, malformed, non-object). ``command`` and ``_log_invocation`` are replaced
  by recorders, so no process is spawned and no model is reached.
* the judge closure of ``triage_phase`` (``crq_repair.py:900-960``): the real
  ``triage_phase`` is run with ``crq_repair.triage.phase`` replaced by a stub
  that calls the closure it is handed once, and every collaborator the closure
  consults (``triage_context_scan``, ``runner_disabled``, ``narrate``,
  ``publish_refusal``, ``blocked``, ``dispatch_paused``, ``time.monotonic``,
  ``dispatch``, ``Path.mkdir``) replaced by a recorder, so the fixture holds the
  ordered effect trace of each gate state plus the returned report or the
  escaping exception class.

No production module is modified and no repository, queue, state, network,
model, signer or host service is touched; state lives in a temporary directory.

Recorded exceptions: the Python class name, plus the message where the code
under test authors it (``ValueError`` from ``triage_phase``, ``KeyError`` key).
Interpreter messages are pinned by class only.

Regenerate with ``python3 triage_judge_vectors.py --write`` and verify with
``--check``. Output is deterministic: sorted keys, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import types
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-triage-judge" / "cases.json"
SCHEMA = "cq.crq-triage-judge-vector/v1"
sys.path.insert(0, str(HERE))

import backfill_runtime  # noqa: E402
import finding_delivery  # noqa: E402
from crq_repair import triage as triage_module  # noqa: E402
from crq_repair.drivers import cq as cq_driver  # noqa: E402


def _service():
    """Load the production repair service module, not a copy of it."""
    spec = importlib.util.spec_from_file_location("triage_judge_oracle", HERE / "crq_repair.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


service = _service()
BRIDGE = str(Path(cq_driver.__file__).resolve().parents[1] / "judge-cq.mjs")

# Messages the code under test authors; everything else is pinned by class.
AUTHORED = {"KeyError", "ValueError_authored"}


def roundtrip(value):
    return json.loads(json.dumps(value))


def exception_record(exc: BaseException) -> dict:
    name = type(exc).__name__
    record = {"raises": name}
    if name == "KeyError":
        record["message"] = str(exc)
    if name == "ValueError" and str(exc) == "triage requires cq structured judge bridge":
        record["message"] = str(exc)
    return record


# ---------------------------------------------------------------------------
# cq.judge: request builder, output parser
# ---------------------------------------------------------------------------

def base_config(**budget):
    return {"repair": {"cq_bin": "/cq/cli.js", "budget": {"wall_clock_min": 5, **budget}}}


ROLE = {"driver": "cq", "model": "opencode-go/deepseek-v4.1-flash"}
JOB = {"job": "crq-triage-F1", "run": "R1", "finding": {"id": "F1", "path": "a.py", "body": "b"}}
TRIAGE_JOB = {**JOB, "triage_context": {"finding": {"id": "F1"}, "current_contract": "cé \U0001f600"}}
OK = {"kind": "completed", "returncode": 0, "stdout": json.dumps({"stop": "ok", "verdict": "valid", "reason": "r"}), "stderr": ""}


def completed(stdout, returncode=0, stderr=""):
    return {"kind": "completed", "returncode": returncode, "stdout": stdout, "stderr": stderr}


def judge_specs():
    cfg = base_config
    out = []

    def add(name, config=None, role=None, job=None, process=None, precreate=False):
        out.append({"name": name, "config": config if config is not None else cfg(),
                    "role": role if role is not None else ROLE,
                    "job": job if job is not None else JOB,
                    "process": process if process is not None else OK})

    add("plain judge request, ok report")
    add("triage context selects the triage schema", job=TRIAGE_JOB)
    add("empty triage context is still not None", job={**JOB, "triage_context": {}})
    add("falsy list triage context is still not None", job={**JOB, "triage_context": []})
    add("falsy string triage context is still not None", job={**JOB, "triage_context": ""})
    add("zero triage context is still not None", job={**JOB, "triage_context": 0})
    add("null triage context is the plain judge", job={**JOB, "triage_context": None})
    add("model with several slashes splits once", role={**ROLE, "model": "a/b/c"})
    add("model without a slash", role={**ROLE, "model": "nomodel"})
    add("empty model", role={**ROLE, "model": ""})
    add("model only a slash", role={**ROLE, "model": "/"})
    add("model null", role={**ROLE, "model": None})
    add("model a list", role={**ROLE, "model": ["a/b"]})
    add("role without model", role={"driver": "cq"})
    add("role is a list", role=["model"])
    add("role budget overrides both token caps",
        role={**ROLE, "budget": {"max_output_tokens": 7, "max_context_tokens": 9}})
    add("base budget overrides the defaults", config=cfg(max_output_tokens=11, max_context_tokens=13))
    add("role budget wins over base budget", config=cfg(max_output_tokens=11, max_context_tokens=13),
        role={**ROLE, "budget": {"max_output_tokens": 7}})
    add("explicit null caps pass through", role={**ROLE, "budget": {"max_output_tokens": None, "max_context_tokens": None}})
    add("string caps pass through", role={**ROLE, "budget": {"max_output_tokens": "9", "max_context_tokens": [1]}})
    add("role budget is null", role={**ROLE, "budget": None})
    add("role budget is a list", role={**ROLE, "budget": []})
    add("role budget is a string", role={**ROLE, "budget": "x"})
    add("role budget is an empty dict", role={**ROLE, "budget": {}})
    add("float wall clock truncates", config=cfg(wall_clock_min=2.5))
    add("tiny float wall clock is zero", config=cfg(wall_clock_min=1e-9))
    add("half a minute is a float timeout", config=cfg(wall_clock_min=0.5))
    add("negative wall clock", config=cfg(wall_clock_min=-1))
    add("negative fractional wall clock truncates toward zero", config=cfg(wall_clock_min=-0.00001))
    add("zero wall clock", config=cfg(wall_clock_min=0))
    add("true wall clock counts as one", config=cfg(wall_clock_min=True))
    add("false wall clock counts as zero", config=cfg(wall_clock_min=False))
    add("huge integer wall clock", config=cfg(wall_clock_min=10**30))
    add("huge float wall clock", config=cfg(wall_clock_min=1e300))
    add("float wall clock past the float range", config=cfg(wall_clock_min=1e305))
    add("infinite wall clock", config=cfg(wall_clock_min=float("inf")))
    add("NaN wall clock", config=cfg(wall_clock_min=float("nan")))
    add("string wall clock", config=cfg(wall_clock_min="5"))
    add("empty string wall clock", config=cfg(wall_clock_min=""))
    add("null wall clock", config=cfg(wall_clock_min=None))
    add("list wall clock", config=cfg(wall_clock_min=[1]))
    add("dict wall clock", config=cfg(wall_clock_min={}))
    add("missing wall clock", config={"repair": {"cq_bin": "/cq/cli.js", "budget": {}}})
    add("missing budget", config={"repair": {"cq_bin": "/cq/cli.js"}})
    add("missing cq_bin", config={"repair": {"budget": {"wall_clock_min": 5}}})
    add("missing repair", config={})
    add("config is a list", config=[])
    add("cq_bin null passes through", config={"repair": {"cq_bin": None, "budget": {"wall_clock_min": 5}}})
    add("job with unicode and astral text", job={**JOB, "finding": {"body": "café \U0001f600   \"q\" \\ \n"}})
    add("job with a lone surrogate", job={**JOB, "finding": {"body": "\ud800"}})
    add("job with floats and big integers", job={**JOB, "n": [1.0, 1e22, 1e-7, 2**70, -0.0, float("nan"), float("inf")]})
    add("job is an empty dict", job={})
    add("job is a list", job=[])
    add("job is a string", job="x")
    add("timeout expires with partial output",
        process={"kind": "timeout", "stdout": "partial", "stderr": "err"})
    add("timeout expires with no output", process={"kind": "timeout", "stdout": None, "stderr": None})
    add("timeout expires with empty output", process={"kind": "timeout", "stdout": "", "stderr": ""})
    add("timeout under a fractional budget", config=cfg(wall_clock_min=0.5),
        process={"kind": "timeout", "stdout": "o", "stderr": "e"})
    add("spawn failure escapes", process={"kind": "raise", "error": "FileNotFoundError"})
    add("non-zero exit hides a valid report", process=completed(OK["stdout"], returncode=1, stderr="bad"))
    add("non-zero exit with no output", process=completed("", returncode=2))
    add("negative exit", process=completed(OK["stdout"], returncode=-9))
    add("ok report passes through whole", process=completed(json.dumps(
        {"stop": "ok", "verdict": "valid", "reason": "r", "usage": {"n": 1}, "extra": [1, 2.5, None]})))
    add("rate-limit report passes through", process=completed(json.dumps(
        {"stop": "rate-limit", "errorClass": "quota", "reason": "slow down"})))
    add("report with no stop passes through", process=completed(json.dumps({"verdict": "unsure"})))
    add("report keeps key order", process=completed('{"b": 1, "a": 2, "b": 3}'))
    add("report with NaN and Infinity", process=completed('{"stop": "ok", "x": NaN, "y": -Infinity, "z": Infinity}'))
    add("report with big and float numbers", process=completed('{"i": 123456789012345678901234567890, "f": 1E5, "g": -0.0}'))
    add("report surrounded by whitespace", process=completed('  \n\t{"stop": "ok"}\r\n '))
    add("report with a BOM is malformed", process=completed('﻿{"stop": "ok"}'))
    add("report with a vertical tab is malformed", process=completed('\x0b{"stop": "ok"}'))
    add("report with trailing text is malformed", process=completed('{"stop": "ok"} x'))
    add("two reports are malformed", process=completed('{"stop": "ok"}{"stop": "ok"}'))
    add("log noise before the report is malformed", process=completed('log\n{"stop": "ok"}'))
    add("empty stdout is malformed", process=completed(""))
    add("whitespace stdout is malformed", process=completed("  \n"))
    add("truncated report is malformed", process=completed('{"stop": "ok", "reason": "r'))
    add("single-quoted report is malformed", process=completed("{'stop': 'ok'}"))
    add("report as a list is not an object", process=completed('[{"stop": "ok"}]'))
    add("report as a string is not an object", process=completed('"ok"'))
    add("report as null is not an object", process=completed("null"))
    add("report as a number is not an object", process=completed("1"))
    add("report as true is not an object", process=completed("true"))
    add("report as empty object passes through", process=completed("{}"))
    add("report with a lone-surrogate escape", process=completed('{"reason": "\\ud800"}'))
    add("report with unicode", process=completed(json.dumps({"stop": "ok", "reason": "café \U0001f600"}, ensure_ascii=False)))
    return out


def run_judge(spec: dict) -> dict:
    recorded: dict = {"logged": [], "command": None, "request_text": None}
    with tempfile.TemporaryDirectory(prefix="judge-oracle-") as scratch:
        directory = Path(scratch) / "dir"
        directory.mkdir()
        worktree = Path(scratch) / "wt"
        request_path = directory / "judge-request.json"

        def scrub(text):
            return text.replace(str(request_path), "REQUEST").replace(BRIDGE, "BRIDGE").replace(str(worktree), "WT")

        def fake_command(argv, cwd=None, env=None, timeout=1200):
            recorded["request_text"] = request_path.read_text() if request_path.exists() else None
            recorded["command"] = {"argv": [scrub(str(part)) for part in argv], "cwd": scrub(str(cwd)),
                                   "env": env, "timeout": timeout}
            process = spec["process"]
            if process["kind"] == "timeout":
                raise subprocess.TimeoutExpired(argv, timeout, output=process["stdout"], stderr=process["stderr"])
            if process["kind"] == "raise":
                raise {"FileNotFoundError": FileNotFoundError}[process["error"]]("node")
            return subprocess.CompletedProcess(argv, process["returncode"], process["stdout"], process["stderr"])

        def fake_log(directory_arg, stdout_text, stderr_text):
            recorded["logged"].append({"directory": "DIR" if Path(directory_arg) == directory else str(directory_arg),
                                       "stdout": stdout_text, "stderr": stderr_text})

        try:
            with mock.patch.object(cq_driver, "command", fake_command), \
                    mock.patch.object(cq_driver, "_log_invocation", fake_log):
                result = cq_driver.judge(copy.deepcopy(spec["config"]), copy.deepcopy(spec["role"]),
                                         copy.deepcopy(spec["job"]), worktree, directory)
            recorded["result"] = result
            recorded["result_text"] = json.dumps(result)
        except BaseException as exc:  # noqa: BLE001 - the oracle records every escape
            recorded.update(exception_record(exc))
        # The request text is recorded from inside command(); a failure before
        # the write leaves it None, and so does an unreadable file.
        if recorded["request_text"] is None and request_path.exists():
            recorded["request_text"] = request_path.read_text()
    return recorded


def judge_cases() -> list[dict]:
    cases = []
    for spec in judge_specs():
        recorded = run_judge(spec)
        # `job` is dumped into the prompt in insertion order, which the sorted
        # fixture would lose: keep the authored order as text beside the value.
        cases.append({"name": spec["name"], "config": spec["config"], "role": spec["role"], "job": spec["job"],
                      "job_json": json.dumps(spec["job"]), "process": spec["process"], "expected": recorded})
    return cases


# ---------------------------------------------------------------------------
# triage_phase: the judge closure and its gates
# ---------------------------------------------------------------------------

CONFIG = {
    "clone": "CLONE",
    "repo": "R",
    "repair": {
        "cq_bin": "/cq/cli.js",
        "budget": {"wall_clock_min": 5},
        "roles": {"judge_critical": {"driver": "cq", "model": "p/critical"}},
        "triage": {},
    },
}
ROW = {"review_id": "R1", "finding": {"id": "F1", "path": "a.py"}}
CONTEXT = {"finding": {"id": "F1"}, "current_path": "a.py"}
DISPATCH_OK = {"stop": "ok", "verdict": "valid", "reason": "r"}


def with_repair(**changes):
    config = copy.deepcopy(CONFIG)
    config["repair"].update(changes)
    return config


def gate_specs():
    out = []

    def add(name, **kw):
        spec = {"name": name, "config": copy.deepcopy(CONFIG), "row": copy.deepcopy(ROW), "context": copy.deepcopy(CONTEXT),
                "remaining": 120.0, "scan": True, "runner_disabled": False, "blocked": False, "paused": None,
                "monotonic": [1000.0, 1010.0], "dispatch": DISPATCH_OK, "precreate_file": False}
        spec.update(kw)
        out.append(spec)

    add("clean pass dispatches with the remaining budget")
    add("remaining shrinks across the scan", monotonic=[1000.0, 1030.0], remaining=60.0)
    add("remaining exactly spent is a deadline", monotonic=[1000.0, 1120.0])
    add("remaining overspent is a deadline", monotonic=[1000.0, 1500.0])
    add("remaining of a hair above zero dispatches", monotonic=[1000.0, 1119.999999])
    add("zero remaining on entry is a deadline", remaining=0.0, monotonic=[1000.0, 1000.0])
    add("negative remaining on entry is a deadline", remaining=-5.0, monotonic=[1000.0, 1000.0])
    add("integer remaining", remaining=90, monotonic=[1000, 1000])
    add("NaN remaining slips past the deadline test", remaining=float("nan"))
    add("infinite remaining", remaining=float("inf"))
    add("remaining recomputed to NaN by an infinite clock", monotonic=[float("inf"), float("inf")])
    add("a refused scan answers without a gate", scan=False, runner_disabled=True, blocked=True, paused="x")
    for label, value in (("zero", 0), ("empty string", ""), ("None", None), ("empty list", []), ("empty dict", {})):
        add("a falsy scan result (%s) refuses" % label, scan=value)
    for label, value in (("one", 1), ("string", "clean"), ("list", [0]), ("dict", {"a": 1})):
        add("a truthy scan result (%s) passes" % label, scan=value)
    add("scan error escapes", scan={"raise": "ContextScanError"})
    add("scan OSError escapes", scan={"raise": "OSError"})
    add("runner disabled defers before the blackout", runner_disabled=True, blocked=True, paused="x")
    add("runner disabled alone defers", runner_disabled=True)
    add("runner disabled with a truthy non-bool", runner_disabled="yes")
    add("blackout defers before the pause", blocked=True, paused="2026-01-01T00:00:00Z")
    add("blackout alone defers", blocked=True)
    add("blackout with a truthy non-bool", blocked=1)
    add("provider pause defers", paused="2026-11-26T12:00:00Z")
    add("empty pause string proceeds", paused="")
    add("non-string truthy pause is a TypeError", paused=5)
    add("list pause is a TypeError", paused=["x"])
    add("falsy non-string pause proceeds", paused=0)
    add("escalated row selects the default critical role", row={**ROW, "_escalate": True})
    add("escalated row selects the configured escalation role",
        row={**ROW, "_escalate": True},
        config=with_repair(triage={"escalation_role": {"driver": "cq", "model": "p/esc"}}))
    add("escalation role is read lazily when the row is not escalated",
        config=with_repair(triage={"escalation_role": {"driver": "cq", "model": "p/esc"}}))
    add("escalation role is not consulted for a falsy flag",
        row={**ROW, "_escalate": 0}, config=with_repair(triage={"escalation_role": None}))
    add("escalation role null passes through as the role",
        row={**ROW, "_escalate": True}, config=with_repair(triage={"escalation_role": None}))
    add("escalation default is read eagerly: no judge_critical is a KeyError even when escalation_role is set",
        row={**ROW, "_escalate": True},
        config=with_repair(roles={}, triage={"escalation_role": {"driver": "cq", "model": "p/esc"}}))
    add("escalation with no roles key is a KeyError", row={**ROW, "_escalate": True},
        config={**CONFIG, "repair": {k: v for k, v in CONFIG["repair"].items() if k != "roles"}})
    add("escalation with null roles is a TypeError", row={**ROW, "_escalate": True}, config=with_repair(roles=None))
    add("escalation with list roles is a TypeError", row={**ROW, "_escalate": True}, config=with_repair(roles=[]))
    add("a missing roles key is not read without escalation",
        config={**CONFIG, "repair": {k: v for k, v in CONFIG["repair"].items() if k != "roles"}})
    add("clone missing is a KeyError before the phase starts", config={k: v for k, v in CONFIG.items() if k != "clone"})
    add("clone of any type passes through", config={**CONFIG, "clone": [1, {"a": None}]})
    add("a truthy string escalate flag escalates", row={**ROW, "_escalate": "no"})
    add("a role override selects the triage role",
        config=with_repair(triage={"role": {"driver": "cq", "model": "p/triage"}}))
    add("non-cq role is refused before any judgment", config=with_repair(triage={"role": {"driver": "codex", "model": "x/y"}}))
    add("role without a driver is refused", config=with_repair(triage={"role": {"model": "x/y"}}))
    add("role as a list is an AttributeError", config=with_repair(triage={"role": []}))
    add("role as null is an AttributeError", config=with_repair(triage={"role": None}))
    add("triage options as a list is an AttributeError", config=with_repair(triage=[]))
    add("triage options as null is an AttributeError", config=with_repair(triage=None))
    add("no triage key uses the default role", config={**CONFIG, "repair": {k: v for k, v in CONFIG["repair"].items() if k != "triage"}})
    add("wall clock minutes are replaced by remaining/60 in the copy", remaining=300.0, monotonic=[0.0, 0.0])
    add("fractional minutes", remaining=100.0, monotonic=[0.0, 7.0])
    add("extra budget fields survive the copy", config=with_repair(budget={"wall_clock_min": 5, "max_output_tokens": 3}))
    add("dispatch result is returned untouched", dispatch={"stop": "rate-limit", "retry_after_ms": 5, "x": [1, 2.5]})
    add("dispatch non-dict result is returned untouched", dispatch=[1, 2])
    add("dispatch None result is returned untouched", dispatch=None)
    add("dispatch timeout escapes", dispatch={"raise": "TimeoutExpired"})
    add("dispatch RuntimeError escapes", dispatch={"raise": "RuntimeError"})
    add("row without a finding is a KeyError", row={"review_id": "R1"})
    add("row finding as a list is a TypeError", row={"review_id": "R1", "finding": []})
    add("row finding as null is a TypeError", row={"review_id": "R1", "finding": None})
    add("finding without an id is a KeyError", row={"review_id": "R1", "finding": {}})
    add("finding id as an integer is a TypeError", row={"review_id": "R1", "finding": {"id": 5}})
    add("finding id as null is a TypeError", row={"review_id": "R1", "finding": {"id": None}})
    add("row without a review id is a KeyError", row={"finding": {"id": "F1"}})
    add("review id of any type passes through", row={"review_id": [1, {"a": None}], "finding": {"id": "F1"}})
    add("row as a list is a TypeError", row=[])
    add("row as null is a TypeError", row=None)
    add("empty finding id", row={"review_id": "R1", "finding": {"id": ""}})
    add("finding id with a dot-dot segment", row={"review_id": "R1", "finding": {"id": "../x"}})
    add("finding id with repeated and dot segments", row={"review_id": "R1", "finding": {"id": "a//./b/"}})
    add("finding id with unicode", row={"review_id": "R1", "finding": {"id": "fé\U0001f600"}})
    add("directory already a file escapes mkdir", precreate_file=True)
    add("context of any type passes through", context=[1, "x", {"a": None}])
    add("context None passes through", context=None)
    add("context with floats passes through", context={"n": 1.0, "m": [1e22]})
    return out


def run_gate(spec: dict) -> dict:
    events: list = []
    scripted = {"calls": 0}
    clock = list(spec["monotonic"])

    def raising(kind):
        return {"TimeoutExpired": lambda: subprocess.TimeoutExpired("dispatch", 1),
                "ContextScanError": lambda: triage_module.ContextScanError(RuntimeError("scan")),
                "OSError": lambda: OSError("scan"),
                "RuntimeError": lambda: RuntimeError("dispatch")}[kind]()

    def value_of(script):
        if isinstance(script, dict) and "raise" in script:
            raise raising(script["raise"])
        return script

    with tempfile.TemporaryDirectory(prefix="judge-gate-oracle-") as scratch:
        root = Path(scratch)
        state = root / "state"
        (state / "backfill/findings/triage").mkdir(parents=True)
        finding = spec["row"].get("finding") if isinstance(spec["row"], dict) else None
        identifier = finding.get("id") if isinstance(finding, dict) else None
        if spec["precreate_file"]:
            (state / "repair/triage").mkdir(parents=True)
            (state / "repair/triage" / identifier).write_text("not a directory")

        def rel(path):
            text = str(path)
            return text.replace(str(state), "STATE")

        def fake_scan(c, context, output):
            events.append({"effect": "scan", "path": rel(output), "context": roundtrip(context)})
            return value_of(spec["scan"])

        def fake_runner_disabled():
            events.append({"effect": "runner_disabled"})
            return spec["runner_disabled"]

        def fake_narrate(message):
            events.append({"effect": "narrate", "message": message})

        def fake_publish_refusal():
            events.append({"effect": "publish_refusal"})

        def fake_blocked(repair, now=None):
            events.append({"effect": "blocked", "repair": roundtrip(repair)})
            return spec["blocked"]

        def fake_paused(config):
            events.append({"effect": "dispatch_paused", "config": roundtrip(config)})
            return spec["paused"]

        def fake_monotonic():
            events.append({"effect": "monotonic"})
            return clock.pop(0)

        def fake_dispatch(config, role, job, wt, directory, judge=False):
            events.append({"effect": "dispatch", "config": roundtrip(config), "role": roundtrip(role),
                           "job": roundtrip(job), "wt": wt, "directory": rel(directory), "judge": judge})
            return value_of(spec["dispatch"])

        original_mkdir = Path.mkdir
        depth = {"n": 0}

        def recording_mkdir(self, *args, **kwargs):
            # parents=True recurses into parent.mkdir; keep the outermost call only.
            outermost = depth["n"] == 0
            if outermost and str(self).startswith(str(state / "repair/triage")):
                events.append({"effect": "mkdir", "path": rel(self), "kwargs": kwargs})
            depth["n"] += 1
            try:
                return original_mkdir(self, *args, **kwargs)
            finally:
                depth["n"] -= 1

        outcome: dict = {}

        def fake_phase(inbox, repo, tip, judge, transport, now, maximum, seconds, dry_run):
            events.clear()
            try:
                outcome["result"] = judge(copy.deepcopy(spec["row"]), copy.deepcopy(spec["context"]), spec["remaining"])
            except BaseException as exc:  # noqa: BLE001
                outcome.update(exception_record(exc))
            return {}

        fake_time = types.SimpleNamespace(monotonic=fake_monotonic, sleep=lambda s: None)
        config = copy.deepcopy(spec["config"])
        patches = [
            mock.patch.object(service, "ROOT", root),
            mock.patch.object(service, "time", fake_time),
            mock.patch.object(service, "git", lambda wt, *args: "TIP"),
            mock.patch.object(service, "utc", lambda: "2026-11-26T00:00:00Z"),
            mock.patch.object(service, "triage_context_scan", fake_scan),
            mock.patch.object(service, "runner_disabled", fake_runner_disabled),
            mock.patch.object(service, "narrate", fake_narrate),
            mock.patch.object(service, "publish_refusal", fake_publish_refusal),
            mock.patch.object(service, "blocked", fake_blocked),
            mock.patch.object(service, "dispatch_paused", fake_paused),
            mock.patch.object(service, "dispatch", fake_dispatch),
            mock.patch.object(backfill_runtime, "settings", lambda s: {"x": 1}),
            mock.patch.object(backfill_runtime, "services", lambda c, r: ("REPO", None, "OUTBOX", None)),
            mock.patch.object(finding_delivery, "Inbox", lambda root_, outbox: "INBOX"),
            mock.patch.object(triage_module, "phase", fake_phase),
            mock.patch.object(Path, "mkdir", recording_mkdir),
        ]
        construction: dict = {}
        with contextlib.ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            try:
                service.triage_phase(config)
            except BaseException as exc:  # noqa: BLE001
                construction.update(exception_record(exc))
        # The closure never runs when triage_phase itself refuses.
        if construction:
            outcome = {**construction, "construction": True}
        # Directory events other than the closure's own mkdir are not recorded.
        return {"events": events, "outcome": outcome, "config_after": roundtrip(config)}


def gate_cases() -> list[dict]:
    cases = []
    for spec in gate_specs():
        recorded = run_gate(spec)
        public = {k: v for k, v in spec.items() if k != "name"}
        cases.append({"name": spec["name"], "spec": public, "expected": recorded})
    return cases


def build() -> dict:
    return {
        "schema": SCHEMA,
        "source": {
            "judge": "apps/crq-python/crq_repair/drivers/cq.py:306-360",
            "judge_bridge": "apps/crq-python/crq_repair/judge-cq.mjs",
            "triage_phase": "apps/crq-python/crq_repair.py:895-970",
        },
        "bridge": "BRIDGE",
        "judge": judge_cases(),
        "gate": gate_cases(),
    }


def render(document: dict) -> str:
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


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
        print("triage judge fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
