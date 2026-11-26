#!/usr/bin/env python3
"""Deterministic offline oracle for the TS triage phase tail (``triagePhaseTail``).

Test tooling only. It drives the PRODUCTION ``crq_repair.triage.phase`` with a
scripted fake judge, a fake inbox over a temporary ``triage/`` directory, a fake
repository and a fake monotonic clock, and records what Python actually does:
the ordered inbox/judge/transport call trace, the returned report, and, when an
exception escapes, its class name (with the trace up to that point, since
Python applies plans one at a time).

``triage.context`` is replaced by a scripted stub (it is a separate slice) and
``triage.time.monotonic`` by a clock that only the scripted judge/context stubs
advance, so every deadline case is deterministic. No production module is
modified and no repository, queue, state, network, model, signer or host
service is touched.

Each case also records a ``boundary``: the head's products the tail consumes
(mechanical plans and the sorted judgment candidates), measured by a probe run
of the same case with a uniform judge. The TS test feeds the boundary to the
tail and compares the trace and report to the real run. Boundary plan kwargs
omit ``failure_class`` for ``superseded``/``duplicate`` plans, which the head
never sets (``inbox.triage`` call kwargs show the default applied).

Regenerate with ``python3 triage_phase_vectors.py --write`` and verify with
``--check``. Output is deterministic: sorted keys, ``ensure_ascii``.
"""
from __future__ import annotations

import argparse
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import review_ledger as ledger
from crq_repair import triage
from finding_delivery import RepairRoundCeiling

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-triage-phase" / "cases.json"
SCHEMA = "cq.crq-triage-phase-vector/v1"
SOURCE_PATH = "apps/crq-python/crq_repair/triage.py"

TIP = "b" * 40
TARGET = "a" * 40
OTHER = "e" * 40
AT = "2026-11-26T00:00:00Z"
TRANSPORT = "transport"
FIX = "d" * 40

EXCEPTIONS = {
    "TimeoutExpired": lambda m: subprocess.TimeoutExpired("judge", 1),
    "ContextScanError": lambda m: triage.ContextScanError(m),
    "OSError": lambda m: OSError(m) if m else OSError(),
    "FileNotFoundError": lambda m: FileNotFoundError(m),
    "RuntimeError": lambda m: RuntimeError(m) if m else RuntimeError(),
    "RepairRoundCeiling": lambda m: RepairRoundCeiling(m),
    "ValueError": lambda m: ValueError(m),
    "KeyError": lambda m: KeyError(m),
    "TypeError": lambda m: TypeError(m),
    "CalledProcessError": lambda m: subprocess.CalledProcessError(1, "git"),
    "IntegrityError": lambda m: ledger.IntegrityError(m),
}


def dump(value) -> str:
    return json.dumps(value, ensure_ascii=True)


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class Clock:
    def __init__(self) -> None:
        self.now = 0

    def monotonic(self):
        return self.now


class FakeRepo:
    """Only what ``phase`` and ``decision`` read for these cases."""

    def begin_invocation(self) -> None:
        pass

    def git(self, *args):
        if args[:3] == ("show", "-s", "--format=%cI"):
            return b"2026-01-01T00:00:00+00:00\n"
        if args[0] == "log":
            return (FIX + "\n").encode()
        raise AssertionError("unexpected git: %r" % (args,))

    def resolve(self, value):
        if not isinstance(value, str):
            raise TypeError("resolve needs str")
        if len(value) != 40:
            raise ledger.IntegrityError("not a full commit")
        return value

    def lineage(self, target, tip, path):
        return None if path.startswith("gone/") else path

    def proven_deleted(self, target, tip, path):
        return path.startswith("gone/")

    def entries(self, tip):
        return self._entries

    _entries: dict = {}


class FakeInbox:
    def __init__(self, root: Path, spec: dict, store: dict, reviews: list, trace: list, probe: bool) -> None:
        self.root = root
        self.spec = spec
        self.store = store
        self.reviews = reviews
        self.trace = trace
        self.probe = probe
        self.counter = 0

        class Publication:
            def retained(_self):
                return copy.deepcopy(reviews)

        self.publication = Publication()

    def recover(self, _reviews) -> None:
        pass

    def _script(self, table: str, fid: str):
        return {} if self.probe else self.spec.get(table, {}).get(fid, {})

    def context_error(self, fid, previous, error):
        self.trace.append(["context_error", fid, previous, dump(error)])
        script = self._script("context_error", fid)
        key = "clear" if error is None else "set"
        entry = script.get(key, {})
        if "raises" in entry:
            raise EXCEPTIONS[entry["raises"]](entry.get("message", ""))
        if "result" in entry:
            return entry["result"]
        return True

    def triage(self, fid, repo, tip, action, actor, reason, at, **kw):
        self.trace.append(["triage", fid, tip, action, actor, reason, at, dump(kw)])
        script = self._script("triage", fid)
        # A scripted failure applies to the nth call for this finding, 1-based.
        calls = sum(1 for e in self.trace if e[0] == "triage" and e[1] == fid)
        entry = script.get(str(calls), script.get("*", {}))
        if "raises" in entry:
            raise EXCEPTIONS[entry["raises"]](entry.get("message", ""))
        if entry.get("none"):
            return None
        recorded = entry.get("action", action)
        row = self.store[fid]
        row["status"] = recorded if isinstance(recorded, str) else action
        if recorded == "confirmed":
            row["target_current"] = tip
        self.counter += 1
        row["previous_event_id"] = "ev-%d" % self.counter
        (self.root / "triage" / (fid + ".json")).write_text(dump(row), encoding="utf-8")
        payload = {"action": recorded}
        if entry.get("no_payload"):
            return {}
        return {"payload": payload}

    def deliver(self, fid, transport, at):
        self.trace.append(["deliver", fid, transport, at])
        entry = self._script("deliver", fid)
        if "raises" in entry:
            raise EXCEPTIONS[entry["raises"]](entry.get("message", ""))
        return {"receipt": fid}


# ---------------------------------------------------------------------------
# Row construction
# ---------------------------------------------------------------------------

def build_row(spec: dict, index: int):
    """Return (row, retained_reviews) for one row spec."""
    fid = spec["id"]
    kind = spec.get("kind", "pending")
    path = spec.get("path", "src/%s.py" % fid)
    finding = {
        "id": fid,
        "severity": spec.get("severity", "major"),
        "path": path,
        "title": spec.get("title", "T " + fid),
        "body": spec.get("body", "B " + fid),
        "anchor_status": "verified",
    }
    finding.update(spec.get("finding", {}))
    status = {
        "pending": "untriaged",
        "retriage": "needs-retriage",
        "pathless": "untriaged",
        "deleted": "untriaged",
        "escalation": "needs-human",
        "investigate": "needs-human",
        "confirmed": "confirmed",
        "stale": "confirmed",
        "duplicate": "duplicate",
        "fixed": "fixed",
    }[kind]
    if kind == "pathless":
        finding["path"] = ""
    if kind == "deleted":
        finding["path"] = "gone/%s.py" % fid
    row = {
        "finding": finding,
        "status": status,
        "target": TARGET,
        "review_id": "rv-" + fid,
        "previous_event_id": "ev0-" + fid,
    }
    if kind == "confirmed":
        row["target_current"] = TIP
    if kind == "stale":
        row["target_current"] = OTHER
    row.update(spec.get("row", {}))
    reviews = [{"id": "rv-" + fid, "occurred_at": "2026-01-01T00:00:%02dZ" % index}]
    if kind in ("escalation", "investigate"):
        evidence = {"reason": "missing source context"} if kind == "investigate" else {}
        reviews.append({
            "id": "ev0-" + fid,
            "event_type": "finding-event",
            "payload": {"actor": "crq-triage/judge", "evidence": evidence},
        })
    return row, reviews


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------

def uniform_judge_report():
    return {"stop": "ok", "verdict": "invalid", "reason": "probe", "model": "probe"}


def run_phase(spec: dict, *, probe: bool) -> dict:
    clock = Clock()
    trace: list = []
    rows_spec = spec["rows"]
    store: dict = {}
    reviews: list = []
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "triage").mkdir()
        for index, row_spec in enumerate(rows_spec):
            row, retained = build_row(row_spec, index)
            store[row["finding"]["id"]] = row
            reviews.extend(retained)
            (root / "triage" / (row["finding"]["id"] + ".json")).write_text(dump(row), encoding="utf-8")
        repo = FakeRepo()
        repo._entries = {
            r["finding"]["path"]: {"blob": "c" * 40}
            for r in store.values()
            if r["finding"]["path"] and not r["finding"]["path"].startswith("gone/")
        }
        inbox = FakeInbox(root, spec, store, reviews, trace, probe)
        context_script = {} if probe else spec.get("context", {})
        judge_script = spec.get("judge", {})

        def fake_context(_repo, row, tip):
            fid = row["finding"]["id"]
            trace.append(["context", fid, bool(row.get("_escalate"))])
            entry = context_script.get(fid, {})
            clock.now += entry.get("advance", 0)
            if "raises" in entry:
                raise EXCEPTIONS[entry["raises"]](entry.get("message", ""))
            return {"packed": fid}

        def fake_judge(row, packed, remaining):
            fid = row["finding"]["id"]
            trace.append(["judge", fid, dump(packed), remaining, bool(row.get("_escalate"))])
            if probe:
                return uniform_judge_report()
            entry = judge_script.get(fid, {"report": {"stop": "ok", "verdict": "invalid", "reason": "default"}})
            clock.now += entry.get("advance", 0)
            if "raises" in entry:
                raise EXCEPTIONS[entry["raises"]](entry.get("message", ""))
            return copy.deepcopy(entry["report"])

        class FakeTime:
            monotonic = staticmethod(clock.monotonic)

        original_context, original_time = triage.context, triage.time
        triage.context, triage.time = fake_context, FakeTime
        maximum = 1000 if probe else spec.get("maximum", 6)
        seconds = 100000 if probe else spec.get("seconds", 600)
        try:
            try:
                report = triage.phase(
                    inbox, repo, TIP, fake_judge, TRANSPORT, AT,
                    maximum=maximum, seconds=seconds, dry_run=spec.get("dry_run", False),
                )
            except AssertionError:
                raise
            except Exception as exc:  # noqa: BLE001 - the class name is the recorded fact
                return {"trace": trace, "raises": type(exc).__name__}
        finally:
            triage.context, triage.time = original_context, original_time
    return {"trace": trace, "report_json": dump(report)}


def boundary_of(spec: dict) -> dict:
    """The head's products, measured by a probe run with a uniform judge."""
    probe_spec = dict(spec, dry_run=False, maximum=1000)
    result = run_phase(probe_spec, probe=True)
    assert "raises" not in result, "probe must not raise"
    candidates = [
        {"id": e[1], "escalate": e[2]} for e in result["trace"] if e[0] == "context"
    ]
    plans = []
    for e in result["trace"]:
        if e[0] != "triage" or not e[4].endswith("/deterministic"):
            continue
        kw = json.loads(e[7])
        kw.pop("expected_previous_event_id")
        if e[3] in ("superseded", "duplicate"):
            kw.pop("failure_class", None)
        plans.append({
            "id": e[1],
            "action": e[3],
            "reason": e[5],
            "kwargs_json": dump(kw),
            "escalate": "/escalation/" in e[4],
        })
    return {"candidates": candidates, "plans": plans}


def run_python(spec: dict) -> dict:
    return run_phase(spec, probe=False)


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

def ok(verdict="invalid", reason="because", **extra) -> dict:
    return {"stop": "ok", "verdict": verdict, "reason": reason, **extra}


def case(name: str, rows: list, **over) -> dict:
    return {"name": name, "rows": rows, "ts_refuses": False, **over}


def R(fid: str, kind: str = "pending", **kw) -> dict:
    return {"id": fid, "kind": kind, **kw}


def cases() -> list[dict]:
    out: list[dict] = []
    add = out.append

    add(case("verdicts", [
        R("a", severity="critical"), R("b"), R("c"), R("d"), R("e"), R("f"), R("g", severity="minor"),
        R("anchor", "fixed"),
    ], judge={
        "a": {"report": ok("unsure", "cannot tell", model="m1")},
        "b": {"report": ok("invalid", "no bug", model="m2")},
        "c": {"report": ok("duplicate-of", "same", canonical_of="anchor")},
        "d": {"report": ok("weird", "huh")},
        "e": {"report": {"stop": "ok", "verdict": "invalid", "reason": "   "}},
        "f": {"report": ok("invalid", "x", context_scan_refused=True)},
        "g": {"report": ok("fixed", "gone", fixing_commit=5)},
    }))
    for label, canonical in (
        ("self", "c"), ("unknown", "nope"), ("duplicate-row", "dup"), ("null", None),
        ("int", 5), ("list", ["anchor"]),
    ):
        add(case("canonical-" + label, [R("c"), R("anchor", "fixed"), R("dup", "duplicate")], judge={
            "c": {"report": ok("duplicate-of", "same", canonical_of=canonical)},
        }))
    add(case("canonical-absent-key", [R("c"), R("anchor", "fixed")], judge={
        "c": {"report": ok("duplicate-of", "same")},
    }))

    add(case("output-invalid-stages", [R("a"), R("b", "escalation"), R("c")], judge={
        "a": {"report": {"stop": "error", "errorClass": "output-invalid", "model": "mm"}},
        "b": {"report": {"stop": "error", "errorClass": "output-invalid"}},
        "c": {"report": ok("invalid", "tail")},
    }))
    add(case("error-other-class-stops", [R("a"), R("b"), R("c")], judge={
        "a": {"report": ok("invalid", "first", model="m")},
        "b": {"report": {"stop": "error", "errorClass": "other", "detail": "x"}},
    }))
    add(case("error-without-class-stops", [R("a"), R("b")], judge={
        "a": {"report": {"stop": "error"}},
    }))
    for label, report in (
        ("deferred", {"stop": "deferred", "errorClass": "rate-limit"}),
        ("absent", {"verdict": "invalid"}),
        ("null", {"stop": None}),
        ("list", {"stop": [1, 2]}),
        ("int", {"stop": 1}),
        ("false", {"stop": False}),
    ):
        add(case("stop-" + label, [R("a"), R("b"), R("m", "pathless")], judge={"a": {"report": report}}))
    for label, value in (("list", [1]), ("none", None), ("str", "ok")):
        add(case("report-not-object-" + label, [R("m", "pathless"), R("a")], judge={"a": {"report": value}}))

    for label, exc, message in (
        ("timeout", "TimeoutExpired", ""),
        ("context-scan", "ContextScanError", "policy   unreadable\nat /x"),
        ("os-error", "OSError", "boom \t happened"),
        ("os-error-empty", "OSError", ""),
        ("file-not-found", "FileNotFoundError", "no such file"),
        ("runtime", "RuntimeError", "bad runtime"),
        ("runtime-empty", "RuntimeError", ""),
        ("ceiling", "RepairRoundCeiling", "ceiling hit"),
        ("long-reason", "OSError", "w " * 400),
        ("uncaught-value", "ValueError", "nope"),
        ("uncaught-key", "KeyError", "nope"),
        ("uncaught-integrity", "IntegrityError", "nope"),
    ):
        add(case("judge-" + label, [R("m", "pathless"), R("a"), R("b")], judge={
            "a": {"raises": exc, "message": message},
        }))

    context_failures = (
        ("key", "KeyError"), ("type", "TypeError"), ("value", "ValueError"),
        ("integrity", "IntegrityError"), ("process", "CalledProcessError"),
        ("timeout", "TimeoutExpired"), ("os", "OSError"),
    )
    for label, exc in context_failures:
        add(case("context-error-" + label, [R("a"), R("b")], context={"a": {"raises": exc}}))
        add(case("context-error-" + label + "-dry", [R("a"), R("b")], context={"a": {"raises": exc}}, dry_run=True))
    add(case("context-uncaught-runtime", [R("m", "pathless"), R("a")], context={"a": {"raises": "RuntimeError"}}))
    add(case("context-error-write-swallowed", [R("a"), R("b")],
             context={"a": {"raises": "KeyError"}},
             context_error={"a": {"set": {"raises": "OSError"}}}))
    add(case("context-error-write-value-swallowed", [R("a"), R("b")],
             context={"a": {"raises": "KeyError"}},
             context_error={"a": {"set": {"raises": "ValueError"}}}))
    add(case("context-error-write-key-swallowed", [R("a"), R("b")],
             context={"a": {"raises": "KeyError"}},
             context_error={"a": {"set": {"raises": "KeyError"}}}))
    add(case("context-error-write-runtime-propagates", [R("a"), R("b")],
             context={"a": {"raises": "KeyError"}},
             context_error={"a": {"set": {"raises": "RuntimeError"}}}))
    add(case("context-clear-false-skips-row", [R("a"), R("b")],
             context_error={"a": {"clear": {"result": False}}}))
    add(case("context-clear-raises-skips-row", [R("a"), R("b")],
             context_error={"a": {"clear": {"raises": "ValueError"}}}))
    add(case("context-clear-os-skips-row", [R("a"), R("b")],
             context_error={"a": {"clear": {"raises": "OSError"}}}))
    add(case("context-clear-key-skips-row", [R("a"), R("b")],
             context_error={"a": {"clear": {"raises": "KeyError"}}}))
    add(case("context-clear-runtime-propagates", [R("a"), R("b")],
             context_error={"a": {"clear": {"raises": "RuntimeError"}}}))

    many = [R("c%d" % i, severity=("critical" if i == 0 else "major")) for i in range(5)]
    add(case("maximum-two", many, maximum=2))
    add(case("maximum-zero", many, maximum=0))
    add(case("maximum-with-investigation", [R("i", "investigate")] + many, maximum=3))
    add(case("maximum-investigation-fills", [R("i", "investigate"), R("j", "investigate"), R("a")], maximum=2))
    add(case("maximum-with-mechanical-not-counted", [R("p", "pathless"), R("d", "deleted")] + many, maximum=2))
    add(case("escalation-judged", [R("e", "escalation"), R("a")], judge={
        "e": {"report": ok("invalid", "second look", model="big")},
    }))
    add(case("escalation-no-model", [R("e", "escalation")]))
    add(case("stale-confirmed-judged", [R("s", "stale")], judge={
        "s": {"report": ok("unsure", "re-check", model="m")},
    }))
    add(case("retriage-judged", [R("r", "retriage")]))

    add(case("deadline-top-of-loop", [R("a"), R("b"), R("c")], seconds=10, judge={
        "a": {"report": ok("invalid", "x"), "advance": 10},
    }))
    add(case("deadline-after-context", [R("a"), R("b")], seconds=10, context={"a": {"advance": 10}}))
    add(case("deadline-remaining-passed-to-judge", [R("a"), R("b")], seconds=100, judge={
        "a": {"report": ok("invalid", "x"), "advance": 30},
        "b": {"report": ok("invalid", "y"), "advance": 5},
    }))
    add(case("deadline-judge-timeout-vs-deadline", [R("a"), R("b")], seconds=10, judge={
        "a": {"raises": "TimeoutExpired", "advance": 10},
    }))
    add(case("dry-run-deadline-after-context", [R("a"), R("b")], seconds=10, dry_run=True,
             context={"a": {"advance": 10}}))
    add(case("dry-run-candidates", many + [R("p", "pathless"), R("d", "deleted"), R("i", "investigate")],
             dry_run=True, maximum=3))
    add(case("dry-run-confirmed-not-delivered", [R("c", "confirmed")], dry_run=True))
    add(case("dry-run-no-candidates", [R("c", "fixed")], dry_run=True))
    add(case("empty-rows", []))

    add(case("mechanical-plans", [
        R("p", "pathless"), R("d", "deleted"), R("i", "investigate"),
        R("x", finding={"blob": "b1", "intervals": [[1, 2]]}, title="same", body="same"),
        R("y", finding={"blob": "b1", "intervals": [[1, 2]]}, title="same", body="same"),
    ]))
    add(case("mechanical-plans-escalation", [R("p", "pathless"), R("e", "escalation", finding={"path": ""})],
             judge={}))

    add(case("triage-none-skips", [R("a"), R("b")], triage={"a": {"*": {"none": True}}}))
    add(case("triage-event-action-overrides", [R("a"), R("b"), R("c")],
             judge={"a": {"report": ok("invalid", "x")}, "b": {"report": ok("unsure", "y")},
                    "c": {"report": ok("invalid", "z")}},
             triage={"a": {"*": {"action": "dismissed"}}, "b": {"*": {"action": "needs-human"}}}))
    add(case("triage-raises-after-earlier-applied", [R("p", "pathless"), R("a"), R("b")],
             triage={"a": {"*": {"raises": "ValueError"}}}))
    add(case("triage-raises-os", [R("a")], triage={"a": {"*": {"raises": "OSError"}}}))
    add(case("triage-event-without-payload", [R("a")], triage={"a": {"*": {"no_payload": True}}}))
    # Documented residual: Python Counters any hashable action; the port refuses.
    add(case("triage-event-action-non-string", [R("a")], triage={"a": {"*": {"action": 5}}}, ts_refuses=True))
    add(case("model-non-string", [R("p", "pathless"), R("a")], judge={"a": {"report": ok("invalid", "x", model=5)}}))
    add(case("model-null", [R("a")], judge={"a": {"report": ok("invalid", "x", model=None)}}))
    add(case("model-empty-string", [R("a")], judge={"a": {"report": ok("invalid", "x", model="")}}))
    add(case("model-output-invalid-non-string", [R("a")], judge={
        "a": {"report": {"stop": "error", "errorClass": "output-invalid", "model": 7}},
    }))
    add(case("reason-non-string", [R("a")], judge={"a": {"report": {"stop": "ok", "verdict": "invalid", "reason": 5}}}))

    add(case("delivery-confirmed", [
        R("c1", "confirmed", severity="critical"), R("c2", "confirmed", severity="major"),
        R("c3", "confirmed", severity="minor"), R("c4", "confirmed", severity="nit"),
        R("s", "stale"), R("f", "fixed"),
    ]))
    add(case("delivery-ceiling", [R("c1", "confirmed"), R("c2", "confirmed")], deliver={
        "c1": {"raises": "RepairRoundCeiling", "message": "ceiling at pin"},
    }))
    add(case("delivery-ceiling-triage-raises", [R("c1", "confirmed"), R("c2", "confirmed")],
             deliver={"c1": {"raises": "RepairRoundCeiling", "message": "ceiling at pin"}},
             triage={"c1": {"1": {"raises": "OSError"}}}))
    add(case("delivery-ceiling-triage-none-ignored", [R("c1", "confirmed")],
             deliver={"c1": {"raises": "RepairRoundCeiling", "message": "ceiling"}},
             triage={"c1": {"1": {"none": True}}}))
    for label, exc in (("runtime", "RuntimeError"), ("os", "OSError"), ("value", "ValueError"),
                       ("integrity", "IntegrityError"), ("file", "FileNotFoundError")):
        add(case("delivery-deferred-" + label, [R("c1", "confirmed"), R("c2", "confirmed")],
                 deliver={"c1": {"raises": exc, "message": "m"}}))
    add(case("delivery-uncaught-key", [R("c1", "confirmed"), R("c2", "confirmed")],
             deliver={"c1": {"raises": "KeyError", "message": "k"}}))
    add(case("delivery-uncaught-type", [R("c1", "confirmed")], deliver={"c1": {"raises": "TypeError", "message": "t"}}))
    add(case("delivery-after-judged-confirmation", [R("a"), R("b", severity="critical")],
             judge={"a": {"report": ok("unsure", "look", model="m")},
                    "b": {"report": ok("unsure", "look2", model="m")}}))
    add(case("delivery-reads-updated-previous-event", [R("a")],
             judge={"a": {"report": ok("unsure", "look", model="m")}},
             deliver={"a": {"raises": "RepairRoundCeiling", "message": "ceiling"}}))
    add(case("delivery-severity-missing", [R("c1", "confirmed", finding={"severity": "info"})]))
    add(case("delivery-with-event-action-confirmed", [R("a")],
             judge={"a": {"report": ok("invalid", "x")}},
             triage={"a": {"*": {"action": "confirmed"}}}))
    return out


# ---------------------------------------------------------------------------
# Build / render / CLI
# ---------------------------------------------------------------------------

def build() -> dict:
    built = []
    for spec in cases():
        entry = dict(spec)
        # `sort_keys` would reorder a report's keys; keep the scripted order as text.
        entry["judge"] = {
            fid: {k: v for k, v in item.items() if k != "report"}
            | ({"report_json": dump(item["report"])} if "report" in item else {})
            for fid, item in spec.get("judge", {}).items()
        }
        entry["rows_json"] = [dump(build_row(r, i)[0]) for i, r in enumerate(spec["rows"])]
        entry["boundary"] = boundary_of(spec)
        entry["expected"] = run_python(spec)
        built.append(entry)
    names = [item["name"] for item in built]
    assert len(names) == len(set(names)), "case names must be unique"
    return {"schema": SCHEMA, "source": SOURCE_PATH, "tip": TIP, "at": AT, "cases": built}


def render(document: dict) -> str:
    return json.dumps(document, ensure_ascii=True, indent=1, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--stdout", action="store_true")
    args = parser.parse_args(argv)
    text = render(build())
    if args.stdout:
        sys.stdout.write(text)
        return 0
    if args.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(text, encoding="utf-8")
        return 0
    if not FIXTURE.exists() or FIXTURE.read_text(encoding="utf-8") != text:
        sys.stderr.write("fixture is stale: run python3 triage_phase_vectors.py --write\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
