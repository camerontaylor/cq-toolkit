#!/usr/bin/env python3
"""Deterministic offline oracle for the TS inbox triage dry-run planner.

Test tooling only. It runs the PRODUCTION ``crq_repair.triage.phase`` with
``dry_run=True`` and records what Python actually decides: the dry-run report,
the ordered Git reads, the ``recovered_anchor`` and ``context`` calls, and how
many times the monotonic clock was read.

Every external effect is injected: the repository answers from recorded facts,
the inbox is a throwaway temp directory of ``triage/*.json`` rows plus an
in-memory retained-review list, ``triage.context`` is replaced by a recorder
that raises a named exception on request, ``time.monotonic`` is a deterministic
step clock, and the judge and transport raise if they are ever called. No
production module is modified and no production repository, queue, state,
network, model, signer or host service is touched.

The TypeScript test (``test/policy/crq/triagePlan.test.ts``) replays the same
facts through ``planTriageDryRun`` and compares the report, the Git read
order, the seam calls and the clock read count. Cases where Python raises an
uncaught ``KeyError``/``TypeError``/``AttributeError`` record the exception
name and the port must refuse; cases flagged ``ts_refuses`` are ones where
Python is lenient about a type the ledger schema never produces and the port
is deliberately stricter.

Regenerate with ``python3 triage_plan_vectors.py --write`` and verify with
``python3 triage_plan_vectors.py --check``. Output is deterministic: sorted
keys, ``ensure_ascii``, no timestamps or host paths.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import review_ledger as ledger
from crq_repair import triage

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-triage-plan" / "cases.json"
SCHEMA = "cq.crq-triage-plan-vector/v1"
SOURCE_PATH = "apps/crq-python/crq_repair/triage.py"

TIP = "b" * 40
TARGET = "a" * 40
BLOB = "c" * 40
OLD = "2026-01-01T00:00:00Z"
NEW = "2026-02-01T00:00:00Z"

CONTEXT_EXCEPTIONS = {
    "KeyError": lambda: KeyError("x"),
    "TypeError": lambda: TypeError("x"),
    "ValueError": lambda: ValueError("x"),
    "IntegrityError": lambda: ledger.IntegrityError("x"),
    "CalledProcessError": lambda: subprocess.CalledProcessError(1, "git"),
    "TimeoutExpired": lambda: subprocess.TimeoutExpired("git", 1),
    "OSError": lambda: OSError("x"),
}


def raise_named(name: str) -> None:
    if name in CONTEXT_EXCEPTIONS:
        raise CONTEXT_EXCEPTIONS[name]()
    raise type(name, (ValueError,), {})("x")


# ---------------------------------------------------------------------------
# Case construction
# ---------------------------------------------------------------------------

def finding(fid: str, **over) -> dict:
    value = {
        "id": fid, "severity": "major", "path": "src/a.py", "title": "Title",
        "body": "Body", "anchor_status": "verified", "blob": BLOB, "intervals": [[1, 2]],
    }
    value.update(over)
    return {k: v for k, v in value.items() if v is not ABSENT}


class _Absent:
    pass


ABSENT = _Absent()


def row(fid: str, status: str = "untriaged", file: str | None = None, *,
        review: str = "r1", target: str = TARGET, previous=ABSENT, current=ABSENT,
        recovered=ABSENT, drop=(), **finding_over) -> dict:
    value = {
        "finding": finding(fid, **finding_over), "status": status, "review_id": review,
        "target": target, "previous_event_id": previous, "target_current": current,
        "recovered_anchor": recovered,
    }
    value = {k: v for k, v in value.items() if v is not ABSENT}
    for key in drop:
        value.pop(key, None)
    return {"file": file or fid + ".json", "row": value}


def review(rid: str, at: str = OLD) -> dict:
    return {"id": rid, "event_type": "review", "occurred_at": at, "payload": {}}


def event(eid: str, actor: str = "crq-triage/model", reason: str | None = None, *,
          failure_class: str | None = None, at: str = OLD, payload=ABSENT, evidence=ABSENT) -> dict:
    if payload is ABSENT:
        ev = {} if reason is None else {"reason": reason}
        if failure_class is not None:
            ev["failure_class"] = failure_class
        if evidence is not ABSENT:
            ev = evidence
        payload = {"actor": actor, "evidence": ev}
    return {"id": eid, "event_type": "finding-event", "occurred_at": at, "payload": payload}


def case(name: str, rows: list, *, reviews=None, kind="plan", ts_refuses=False, **over) -> dict:
    spec = {
        "name": name, "kind": kind, "rows": rows, "tip": TIP,
        "reviews": [review("r1")] if reviews is None else reviews,
        "maximum": 6, "seconds": 600, "clock": {"start": 1000, "step": 0},
        "entries": ["src/a.py"], "commit_dates": {TARGET: OLD, "t2": NEW}, "lineage": [],
        "proven_deleted": [], "deleting": [], "recovery": {"enabled": False, "anchors": {}},
        "context_errors": {}, "ts_refuses": ts_refuses,
    }
    spec.update(over)
    return spec


# ---------------------------------------------------------------------------
# Running Python
# ---------------------------------------------------------------------------

class Recorder:
    def __init__(self, spec: dict) -> None:
        self.spec = spec
        self.calls: list[list] = []
        self.recover: list[str] = []
        self.context: list[dict] = []
        self.reads = 0

    def monotonic(self) -> float:
        clock = self.spec["clock"]
        value = clock["start"] + self.reads * clock["step"]
        self.reads += 1
        return value


class FakeRepo:
    def __init__(self, recorder: Recorder) -> None:
        self.r = recorder
        self.spec = recorder.spec

    def begin_invocation(self) -> None:
        self.r.calls.append(["begin"])

    def git(self, *args, check=True):
        if args[:3] == ("show", "-s", "--format=%cI"):
            self.r.calls.append(["commit_date", args[3]])
            return (self.spec["commit_dates"][args[3]] + "\n").encode()
        if args[:3] == ("log", "-1", "--format=%H") and args[3] == "--diff-filter=D":
            tip, path = args[4], args[6]
            assert args[5] == "--" and tip == TIP
            self.r.calls.append(["deleting", tip, path])
            for item in self.spec["deleting"]:
                if item["path"] == path:
                    return (item["commit"] + "\n").encode()
            return b"\n"
        raise AssertionError("unexpected git read: %r" % (args,))

    def entries(self, tip):
        assert tip == TIP
        self.r.calls.append(["entries", tip])
        return {path: {"blob": BLOB} for path in self.spec["entries"]}

    def lineage(self, target, tip, path):
        assert tip == TIP
        self.r.calls.append(["lineage", target, tip, path])
        for item in self.spec["lineage"]:
            if item["target"] == target and item["path"] == path:
                return item["result"]
        return None

    def proven_deleted(self, target, tip, path):
        assert tip == TIP
        self.r.calls.append(["proven_deleted", target, tip, path])
        return any(i["target"] == target and i["path"] == path for i in self.spec["proven_deleted"])


def unexpected(name):
    def refuse(*_args, **_kwargs):
        raise AssertionError("dry run must not call " + name)
    return refuse


def make_inbox(root: Path, recorder: Recorder):
    spec = recorder.spec
    reviews = spec["reviews"]
    names = {
        "root": root,
        "publication": SimpleNamespace(retained=lambda: json.loads(json.dumps(reviews))),
        "recover": unexpected("recover"),
        "triage": unexpected("triage"),
        "context_error": unexpected("context_error"),
        "deliver": unexpected("deliver"),
    }
    if spec["recovery"]["enabled"]:
        anchors = spec["recovery"]["anchors"]

        def recovered_anchor(row, repo, retained):
            recorder.recover.append(row["finding"]["id"])
            value = anchors.get(row["finding"]["id"])
            return json.loads(json.dumps(value)) if value is not None else None
        names["recovered_anchor"] = recovered_anchor
    return SimpleNamespace(**names)


def run_python(spec: dict) -> dict:
    recorder = Recorder(spec)
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "triage").mkdir()
        for item in spec["rows"]:
            (root / "triage" / item["file"]).write_text(
                json.dumps(item["row"], sort_keys=True), encoding="utf-8")
        inbox = make_inbox(root, recorder)

        def context(repo, row, tip):
            recorder.context.append({
                "finding_id": row["finding"]["id"], "tip": tip,
                "escalate": bool(row.get("_escalate")),
                "recovered": bool(row.get("recovered_anchor")),
            })
            name = spec["context_errors"].get(row["finding"]["id"])
            if name is not None:
                raise_named(name)
            return {}

        clock = SimpleNamespace(monotonic=recorder.monotonic)
        try:
            with mock.patch.object(triage, "time", clock), mock.patch.object(triage, "context", context):
                result = triage.phase(
                    inbox, FakeRepo(recorder), TIP, unexpected("judge"), unexpected("transport"),
                    "2026-03-01T00:00:00Z", maximum=spec["maximum"], seconds=spec["seconds"],
                    dry_run=True)
        except (KeyError, TypeError, AttributeError, ValueError) as exc:
            return {"raises": type(exc).__name__}
    return {
        "result": result,
        "repo_calls": normalize(recorder.calls),
        "recover_calls": recorder.recover,
        "context_calls": recorder.context,
        "clock_reads": recorder.reads,
    }


def normalize(calls: list[list]) -> list[list]:
    """Sort each run of commit-date reads: Python asks in set order."""
    result: list[list] = []
    run: list[list] = []
    for call in calls:
        if call[0] == "commit_date":
            run.append(call)
            continue
        result.extend(sorted(run))
        run = []
        result.append(call)
    result.extend(sorted(run))
    return result


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

def cases() -> list[dict]:
    out: list[dict] = []
    add = out.append

    add(case("empty-inbox", []))
    add(case("single-pending-is-a-candidate", [row("f1")]))

    # --- age ordering --------------------------------------------------------
    add(case("age-then-id-ordering", [
        row("f-b", review="r2"), row("f-a", review="r2"), row("f-c", review="r1"),
    ], reviews=[review("r1", NEW), review("r2", OLD)]))
    add(case("id-compare-is-by-code-point", [
        row("x", review="r1"), row("x\U0001d49c", review="r1"),
    ]))
    add(case("age-falls-back-to-target-commit-date", [
        row("f-new", review="missing", target="t2"), row("f-old", review="missing"),
        row("f-empty", review="r-empty", target="t2"),
    ], reviews=[review("r-empty", "")]))
    add(case("equal-keys-keep-file-order", [
        row("same", file="z.json", title="Second"), row("same", file="a.json", title="First"),
    ]))
    add(case("target-date-requested-once-per-target", [
        row("f1", review="x1"), row("f2", review="x2"), row("f3", review="x3", target="t2"),
    ]))

    # --- eligible status -----------------------------------------------------
    add(case("status-eligibility", [
        row("s-untriaged", "untriaged", title="1"), row("s-retriage", "needs-retriage", title="2"),
        row("s-confirmed-current", "confirmed", current=TIP, title="3"),
        row("s-confirmed-stale", "confirmed", current="d" * 40, title="4"),
        row("s-confirmed-unset", "confirmed", title="5"),
        row("s-needs-human-bare", "needs-human", title="6"),
        row("s-dismissed", "dismissed", title="7"), row("s-fixed", "fixed", title="8"),
        row("s-already-fixed", "already-fixed", title="9"),
        row("s-superseded", "superseded", title="10"), row("s-duplicate", "duplicate", title="11"),
        row("s-other", "something-else", title="12"),
    ]))

    # --- exact duplicates ----------------------------------------------------
    dup = dict(title="Same title", body="Same body")
    add(case("exact-duplicates-point-at-first", [
        row("d1", **dup), row("d2", **dup), row("d3", **dup),
    ]))
    add(case("duplicate-key-parts-each-distinguish", [
        row("k0", **dup), row("k-sev", severity="minor", **dup), row("k-path", path="src/b.py", **dup),
        row("k-body", title="Same title", body="Other"), row("k-blob", blob="e" * 40, **dup),
        row("k-iv", intervals=[[3, 4]], **dup), row("k-title", title="Other title", body="Same body"),
    ], entries=["src/a.py", "src/b.py"]))
    add(case("duplicate-needs-an-anchor", [
        row("n1", blob=ABSENT, **dup), row("n2", blob=ABSENT, **dup),
        row("n3", intervals=[], title="x", body="y"), row("n4", intervals=[], title="x", body="y"),
        row("n5", blob="", title="p", body="q"), row("n6", blob="", title="p", body="q"),
    ]))
    add(case("title-is-whitespace-and-case-normalised", [
        row("w1", title="Mixed  Case\ttitle", body="b"),
        row("w2", title="  mixed case  TITLE ", body="b"),
        row("w3", title="mixed\u001ccase\u0085title", body="b"),
        row("w4", title="mixed​case title", body="b"),
    ]))
    add(case("title-casefold-matches-cpython", [
        row("c1", title="Straße", body="b"), row("c2", title="STRASSE", body="b"),
        row("c3", title="STRAẞE", body="b"), row("c4", title="ſtrasse", body="b"),
        row("c5", title="ıi", body="b"), row("c6", title="Ii", body="b"),
        row("c7", title="İ", body="b"), row("c8", title="i̇", body="b"),
        row("c9", title="ΟΔΟΣ", body="b"), row("c10", title="οδος", body="b"),
        row("c11", title="οδοσ", body="b"), row("c12", title="ﬁle", body="b"),
        row("c13", title="FILE", body="b"), row("c14", title="Ꭰ", body="b"),
        row("c15", title="ꭰ", body="b"), row("c16", title="Ꮈ", body="b"),
    ]))
    add(case("settled-status-is-never-canonical", [
        row("p1", "dismissed", **dup), row("p2", "fixed", **dup), row("p3", "superseded", **dup),
        row("p4", "already-fixed", **dup), row("p5", **dup), row("p6", **dup),
    ]))
    add(case("non-pending-earlier-row-is-canonical", [
        row("q1", "confirmed", current=TIP, **dup), row("q2", **dup),
        row("q3", "needs-human", **dup), row("q4", **dup),
    ]))
    # An unsettled row seeds the canonical id even when it is itself skipped, so
    # a later exact copy names it. Each vector fails if its status were settled.
    add(case("canonical-seed-needs-human-escalated", [
        row("n1", "needs-human", previous="e-j", **dup), row("n2", **dup),
    ], reviews=[review("r1"), event("e-j", "crq-triage/judge", "owner")]))
    add(case("canonical-seed-needs-human-skipped", [
        row("n1", "needs-human", **dup), row("n2", **dup),
    ]))
    add(case("canonical-seed-unknown-status", [
        row("n1", "parked", **dup), row("n2", **dup),
    ]))
    add(case("duplicate-status-row-never-seeds-or-plans", [
        row("r1x", "duplicate", **dup), row("r2x", **dup),
    ]))
    add(case("empty-id-canonical-is-falsy", [
        row("", **dup, file="empty.json"), row("zz", **dup),
    ], reviews=[review("r1")]))

    # --- recovered anchors ---------------------------------------------------
    anchor = {"blob": "9" * 40, "intervals": [[5, 6]], "path": "src/a.py"}
    add(case("recovered-anchor-enables-duplicate", [
        row("a1", blob=ABSENT, intervals=ABSENT, anchor_status="unverified", **dup),
        row("a2", blob=ABSENT, intervals=ABSENT, anchor_status="unverified", **dup),
    ], recovery={"enabled": True, "anchors": {"a1": anchor, "a2": anchor}}))
    add(case("recovery-is-skipped-when-it-cannot-apply", [
        row("v1", "untriaged", **dup), row("v2", "needs-human", anchor_status="unverified", title="t2"),
        row("v3", "dismissed", anchor_status="unverified", title="t3"),
        row("v4", "confirmed", anchor_status="unverified", current=TIP, title="t4"),
        row("v5", "needs-retriage", anchor_status="unverified", title="t5"),
    ], recovery={"enabled": True, "anchors": {"v5": anchor, "v4": anchor}}))
    add(case("recovery-seam-absent", [
        row("m1", anchor_status="unverified", **dup), row("m2", anchor_status="unverified", **dup),
    ], recovery={"enabled": False, "anchors": {}}))
    add(case("recovery-returning-empty-or-none-changes-nothing", [
        row("e1", anchor_status="unverified", **dup), row("e2", anchor_status="unverified", **dup),
    ], recovery={"enabled": True, "anchors": {"e1": {}}}))
    add(case("persisted-recovered-anchor-is-read", [
        row("g1", blob=ABSENT, intervals=ABSENT, recovered=anchor, **dup),
        row("g2", blob=ABSENT, intervals=ABSENT, recovered=anchor, **dup),
        row("g3", blob=ABSENT, intervals=ABSENT, recovered={}, **dup),
    ]))
    add(case("recovered-anchor-reaches-context", [
        row("h1", anchor_status="unverified", title="h1"), row("h2", recovered=anchor, title="h2"),
        row("h3", "needs-human", previous="ev-h3", title="h3"),
    ], reviews=[review("r1"), event("ev-h3", "crq-triage/judge", "owner ambiguity")],
        recovery={"enabled": True, "anchors": {"h1": anchor}}))

    # --- mechanical plans ----------------------------------------------------
    add(case("pathless-finding-needs-human", [
        row("p-null", path=None, title="1"), row("p-empty", path="", title="2"),
        row("p-null-needs-human", "needs-human", path=None, previous="ev-1", title="3"),
    ], reviews=[review("r1"), event("ev-1", "crq-triage/m", "n")]))
    add(case("pathless-consumes-the-maximum", [
        row("n1", path=None, title="1"), row("n2", path=None, title="2"),
        row("n3", path=None, title="3"),
    ], maximum=2))
    add(case("deleted-path-is-superseded", [
        row("del1", path="gone/x.py", title="1"), row("del2", path="gone/y.py", title="2"),
        row("del3", path="gone/z.py", title="3"),
    ], proven_deleted=[
        {"target": TARGET, "path": "gone/x.py"}, {"target": TARGET, "path": "gone/y.py"}],
        deleting=[{"path": "gone/x.py", "commit": "f" * 40}]))
    add(case("deleted-path-needs-every-condition", [
        row("c-mapped", path="gone/a.py", title="1"), row("c-present", path="src/a.py", title="2"),
        row("c-unproven", path="gone/b.py", title="3"),
    ], lineage=[{"target": TARGET, "path": "gone/a.py", "result": "renamed/a.py"}],
        proven_deleted=[
            {"target": TARGET, "path": "gone/a.py"}, {"target": TARGET, "path": "src/a.py"}]))
    add(case("deletion-beats-duplicate", [
        row("x1", path="gone/x.py", **dup), row("x2", path="gone/x.py", **dup),
    ], proven_deleted=[{"target": TARGET, "path": "gone/x.py"}]))

    # --- missing evidence ----------------------------------------------------
    reasons = {
        "me-pos1": "missing source evidence", "me-pos2": "Insufficient CONTEXT provided",
        "me-pos3": "the evidence is unavailable", "me-pos4": "need more context here",
        "me-pos5": "lack of source", "me-pos6": "source was not provided",
        "me-neg-secret": "missing source: secret found", "me-neg-timeout": "missing context, timeout",
        "me-neg-timed": "evidence missing after timed out", "me-neg-rate": "missing evidence rate limit",
        "me-neg-rate-dash": "missing evidence rate-limit", "me-neg-provider": "provider lacks context",
        "me-neg-scan": "context scan failed", "me-neg-dispatch": "dispatch missing source",
        "me-neg-invalid": "invalid, missing context", "me-neg-budget": "budget: missing source",
        "me-neg-prefix": "fixer investigation: missing source evidence",
        "me-neg-newline": "missing\nsource", "me-neg-nothing": "owner decision required",
        "me-pos-line-sep": "missing source", "me-neg-long-s": "ſecret missing source",
        "me-pos-kelvin": "lac\u212A of source", "me-pos-long-s": "mi\u017fsing source", "me-neg-rate-newline": "missing source rate\nlimit",
        "me-pos-rate-sep": "missing source rate limit",
        "me-neg-notstr": 7, "me-neg-empty": "",
        # Python's re.I folds ASCII i with U+0130 and U+0131; JS iu does not.
        "me-pos-dotted-i": "m\u0130ssing source", "me-pos-dotless-i": "m\u0131ssing source",
        "me-pos-dotless-i-need": "need more context, not prov\u0131ded",
        "me-pos-dotted-i-wanted": "insuffic\u0130ent evidence", "me-pos-dotless-i-unavailable": "context unava\u0131lable",
        "me-neg-dotless-invalid": "\u0131nvalid, missing context", "me-neg-dotted-dispatch": "d\u0130spatch missing source",
        "me-neg-dotless-provider": "prov\u0131der lacks context", "me-neg-dotted-timed-out": "missing source, t\u0130med out",
        "me-neg-dotless-timeout": "missing source, t\u0131meout", "me-neg-dotted-rate-limit": "missing source rate l\u0130m\u0130t",
    }
    me_rows, me_events = [], []
    for fid, reason in reasons.items():
        me_rows.append(row(fid, "needs-human", previous="ev-" + fid, title=fid))
        payload_reason = reason
        me_events.append({"id": "ev-" + fid, "event_type": "finding-event", "occurred_at": OLD,
                          "payload": {"actor": "crq-triage/model", "evidence": {"reason": payload_reason}}})
    add(case("missing-evidence-regexes", me_rows, reviews=[review("r1"), *me_events], maximum=100))
    add(case("missing-evidence-actor-and-class", [
        row("a-model", "needs-human", previous="e-model", title="1"),
        row("a-operator", "needs-human", previous="e-operator", title="2"),
        row("a-delivery", "needs-human", previous="e-delivery", title="3"),
        row("a-escalation", "needs-human", previous="e-escalation", title="4"),
        row("a-class", "needs-human", previous="e-class", title="5"),
        row("a-class-empty", "needs-human", previous="e-class-empty", title="6"),
        row("a-no-evidence", "needs-human", previous="e-noev", title="7"),
        row("a-no-reason", "needs-human", previous="e-noreason", title="8"),
        row("a-no-previous", "needs-human", title="9"),
        row("a-unknown-previous", "needs-human", previous="e-nope", title="10"),
        row("a-not-needs-human", "untriaged", previous="e-model", title="11"),
        row("a-int-previous", "needs-human", previous=5, title="12"),
    ], reviews=[
        review("r1"), event("e-model", "crq-triage/model", "missing source"),
        event("e-operator", "operator", "missing source"),
        event("e-delivery", "crq-triage/delivery", "missing source"),
        event("e-escalation", "crq-triage/escalation/m", "missing source"),
        event("e-class", "crq-triage/m", "missing source", failure_class="exhausted"),
        event("e-class-empty", "crq-triage/m", "missing source", failure_class=""),
        event("e-noev", payload={"actor": "crq-triage/m"}),
        event("e-noreason", "crq-triage/m", None),
    ], maximum=100))
    add(case("escalation-routing", [
        row("esc-judge", "needs-human", previous="e-judge", title="1"),
        row("esc-class", "needs-human", previous="e-class", title="2"),
        row("esc-delivery", "needs-human", previous="e-delivery", title="3"),
        row("esc-twice", "needs-human", previous="e-twice", title="4"),
        row("esc-operator", "needs-human", previous="e-operator", title="5"),
        row("esc-missing", "needs-human", previous="e-missing", title="6"),
    ], reviews=[
        review("r1"), event("e-judge", "crq-triage/judge", "owner ambiguity"),
        event("e-class", "crq-triage/judge", "owner", failure_class="exhausted"),
        event("e-delivery", "crq-triage/delivery", "owner"),
        event("e-twice", "crq-triage/escalation/judge", "owner"),
        event("e-operator", "operator", "owner"),
        event("e-missing", "crq-triage/judge", "missing source"),
    ], maximum=100))

    # --- limits and the deadline --------------------------------------------
    limit_rows = [
        row("L1", severity="minor", title="1"), row("L2", severity="critical", title="2"),
        row("L3", severity="major", title="3"), row("L4", severity="info", title="4"),
        row("L5", severity="critical", title="5"), row("L6", severity="weird", title="6"),
    ]
    for maximum in (0, 1, 2, 3, 6):
        add(case("maximum-limits-judged-candidates-%d" % maximum, limit_rows, maximum=maximum))
    add(case("severity-rank-then-age-then-id", limit_rows, reviews=[review("r1")], maximum=100))
    mixed = [
        row("M-inv1", "needs-human", previous="ev-m1", title="1"),
        row("M-inv2", "needs-human", previous="ev-m2", title="2"),
        row("M-inv3", "needs-human", previous="ev-m3", title="3"),
        row("M-path", path=None, title="4"),
        row("M-del", path="gone/x.py", title="5"),
        row("M-c1", title="6"), row("M-c2", title="7"), row("M-c3", title="8"),
    ]
    mixed_reviews = [review("r1")] + [event("ev-m%d" % i, "crq-triage/m", "missing source") for i in (1, 2, 3)]
    for maximum in (0, 1, 2, 3, 4, 5, 6, 8):
        add(case("maximum-counts-plans-and-investigations-%d" % maximum, mixed, reviews=mixed_reviews,
                 maximum=maximum, proven_deleted=[{"target": TARGET, "path": "gone/x.py"}],
                 deleting=[{"path": "gone/x.py", "commit": "f" * 40}]))
    for seconds in list(range(0, 24)) + [24, 30, 100]:
        add(case("deadline-sweep-%03d" % seconds, mixed, reviews=mixed_reviews, maximum=100,
                 seconds=seconds, clock={"start": 1000, "step": 1},
                 proven_deleted=[{"target": TARGET, "path": "gone/x.py"}],
                 deleting=[{"path": "gone/x.py", "commit": "f" * 40}],
                 recovery={"enabled": True, "anchors": {}}))
    add(case("deadline-fractional-clock", mixed, reviews=mixed_reviews, maximum=100, seconds=7,
             clock={"start": 5.5, "step": 0.5}))

    # --- context errors ------------------------------------------------------
    ctx_rows = [row("X%d" % i, title=str(i)) for i in range(1, 12)]
    add(case("context-errors-leave-rows-pending", ctx_rows, maximum=100, context_errors={
        "X1": "KeyError", "X2": "TypeError", "X3": "ValueError", "X4": "IntegrityError",
        "X5": "CalledProcessError", "X6": "TimeoutExpired", "X7": "OSError"}))
    add(case("context-error-does-not-consume-the-maximum", ctx_rows, maximum=3,
             context_errors={"X1": "KeyError", "X2": "OSError"}))
    add(case("context-error-class-name-is-truncated", ctx_rows[:2], maximum=100,
             context_errors={"X1": "E" * 100, "X2": "é" * 90}))
    add(case("context-error-under-deadline", ctx_rows, maximum=100, seconds=8,
             clock={"start": 0, "step": 1}, context_errors={"X1": "KeyError"}))
    add(case("context-sees-escalation", [
        row("esc", "needs-human", previous="e-j", title="1"), row("plain", title="2"),
    ], reviews=[review("r1"), event("e-j", "crq-triage/judge", "owner")]))

    # --- damaged inboxes: Python raises, the port refuses --------------------
    refused = {
        "refuses-row-without-finding": row("bad", drop=("finding",)),
        "refuses-row-without-status": row("bad", drop=("status",)),
        "refuses-row-without-review-id": row("bad", drop=("review_id",)),
        "refuses-undated-row-without-target": row("bad", review="nope", drop=("target",)),
        "refuses-finding-without-id": row("bad", id=ABSENT),
        "refuses-finding-without-severity": row("bad", severity=ABSENT),
        "refuses-finding-without-path-key": row("bad", path=ABSENT),
        "refuses-finding-without-title": row("bad", title=ABSENT),
        "refuses-finding-without-body": row("bad", body=ABSENT),
        "refuses-non-string-title": row("bad", title=5),
    }
    for name, bad in refused.items():
        add(case(name, [row("good"), bad], kind="refusal"))
    add(case("tolerates-undated-nothing-but-target-less-dated-row",
             [row("ok", "dismissed", drop=("target",))]))
    add(case("refuses-non-object-retained-review", [row("good")], kind="refusal",
             reviews=[review("r1"), "nope"]))
    add(case("refuses-retained-review-without-id", [row("good")], kind="refusal",
             reviews=[review("r1"), {"event_type": "review"}]))
    add(case("refuses-non-object-payload-for-needs-human", [
        row("nh", "needs-human", previous="ev"),
    ], kind="refusal", reviews=[review("r1"), event("ev", payload=["x"])]))
    add(case("refuses-non-object-evidence-for-needs-human", [
        row("nh", "needs-human", previous="ev"),
    ], kind="refusal", reviews=[review("r1"), event("ev", evidence="text")]))
    add(case("tolerates-non-object-payload-off-needs-human", [
        row("ok", "untriaged", previous="ev"),
    ], reviews=[review("r1"), event("ev", payload=["x"])]))
    # Python hashes the duplicate key only for an anchored row (truthy intervals
    # and blob), and before the duplicate-status skip.
    for name, blob in {"list": ["x"], "int-list": [1], "dict": {"k": "v"}}.items():
        add(case("refuses-container-blob-" + name, [row("good"), row("bad", blob=blob)], kind="refusal"))
    add(case("refuses-container-blob-on-duplicate-status", [
        row("good"), row("bad", "duplicate", blob=["x"]),
    ], kind="refusal"))
    add(case("refuses-container-blob-in-recovered-anchor", [
        row("a1", blob=ABSENT, intervals=ABSENT, anchor_status="unverified"),
    ], kind="refusal", recovery={"enabled": True, "anchors": {
        "a1": {"blob": ["x"], "intervals": [[5, 6]], "path": "src/a.py"}}}))
    add(case("tolerates-container-blob-with-falsy-intervals", [
        row("f1", blob=["x"], intervals=[], title="t1"),
        row("f2", blob={"k": "v"}, intervals=None, title="t2"),
        row("f3", blob=["x"], intervals=ABSENT, title="t3"),
    ]))
    add(case("tolerates-empty-container-blob", [
        row("e1", blob=[], title="t1"), row("e2", blob={}, title="t2"),
    ]))
    add(case("refuses-container-previous-event-id", [
        row("nh", "untriaged", previous=["ev"]),
    ], kind="refusal"))

    # --- Python is lenient, the port is stricter -----------------------------
    add(case("ts-stricter-numeric-path", [row("num", path=5)], ts_refuses=True))
    add(case("ts-stricter-null-severity", [row("num", severity=None)], ts_refuses=True))
    add(case("ts-stricter-numeric-review-id", [row("num", review=5)], ts_refuses=True,
             reviews=[review("r1")]))
    return out


def run_case(spec: dict) -> dict:
    out = run_python(spec)
    expected = {"name": spec["name"], "input": {k: v for k, v in spec.items() if k not in ("name", "kind", "ts_refuses")},
                "ts_refuses": spec["ts_refuses"]}
    expected.update(out)
    if spec["kind"] == "refusal" and "raises" not in out:
        raise AssertionError("%s: expected Python to raise, got a result" % spec["name"])
    if spec["kind"] == "plan" and "raises" in out and not spec["ts_refuses"]:
        raise AssertionError("%s: Python unexpectedly raised %s" % (spec["name"], out["raises"]))
    return expected


def build() -> dict:
    results = [run_case(spec) for spec in cases()]
    names = [item["name"] for item in results]
    if len(names) != len(set(names)):
        raise AssertionError("duplicate vector case names")
    return {
        "schema": SCHEMA, "source": SOURCE_PATH,
        "constants": {"tip": TIP, "target": TARGET, "blob": BLOB},
        "cases": results,
    }


def render(document: dict) -> str:
    return json.dumps(document, ensure_ascii=True, indent=1, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit the crq triage-plan oracle fixture")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    group.add_argument("--stdout", action="store_true")
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
        print("triage-plan fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
