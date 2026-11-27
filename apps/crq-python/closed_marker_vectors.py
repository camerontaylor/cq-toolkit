#!/usr/bin/env python3
"""Deterministic offline oracle for the bounded closed-PR marker recheck.

Test tooling only. It drives the PRODUCTION ``repair_tick.closed_marker_due``,
``repair_tick.reconcile_fix_prs`` (the ``fix_closed`` lane) and
``repair_tick.reconcile_current_fix`` (the ``not_fixed`` lane) under a frozen
clock and records what Python actually does: the due decision, the final
record, the counters and how many forge reads were made.

Every effect is injected: the forge answers from a recorded sequence, git
resolves to a fixed tip and ``merge_head_evidence`` is replaced by a recorder.
No production module is modified and no production queue, state, network,
model, signer or host service is touched.

The TypeScript test (``test/ops/crq/closedMarker.test.ts``) replays the same
specs through ``closedMarkerDue``, ``runReconcileFixPrs`` +
``reconcileFixRun`` and ``reconcileCurrentRepair``.

Regenerate with ``python3.14 closed_marker_vectors.py --write`` and verify with
``--check``. Output is deterministic: sorted keys, ``ensure_ascii``, no
timestamps or host paths.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List
from unittest import mock

import repair_tick
import review_receipt

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "crq-closed-marker" / "cases.json"
NOW = dt.datetime(2026, 11, 27, 3, 4, 5, tzinfo=dt.timezone.utc)
NOW_ISO = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
HOUR = dt.timedelta(hours=1)
DAY = dt.timedelta(hours=24)
TIP = "d" * 40
HEAD = "b" * 40
CAPTURE = "a" * 40
MERGE = "c" * 40


def _ago(delta: dt.timedelta, fmt: str = "%Y-%m-%dT%H:%M:%SZ") -> str:
    return (NOW - delta).strftime(fmt)


class _Frozen(dt.datetime):
    @classmethod
    def now(cls, tz=None):  # noqa: D401 - the production call is now(timezone.utc)
        return NOW if tz is None else NOW.astimezone(tz)


FROZEN_DT = SimpleNamespace(datetime=_Frozen, timezone=dt.timezone, timedelta=dt.timedelta)


def _frozen():
    return mock.patch.object(repair_tick, "dt", FROZEN_DT)


# ---------------------------------------------------------------------------
# closed_marker_due


def due_markers() -> List[Dict[str, Any]]:
    stale = _ago(DAY)
    fresh = _ago(DAY - dt.timedelta(seconds=1))
    named = [
        ("stale string", stale),
        ("one second short of the window", fresh),
        ("exactly the window", _ago(DAY)),
        ("one second over the window", _ago(DAY + dt.timedelta(seconds=1))),
        ("fresh string", _ago(HOUR)),
        ("future string", (NOW + HOUR).strftime("%Y-%m-%dT%H:%M:%SZ")),
        ("naive means UTC, stale", _ago(DAY, "%Y-%m-%dT%H:%M:%S")),
        ("naive means UTC, fresh", _ago(HOUR, "%Y-%m-%dT%H:%M:%S")),
        ("explicit offset keeps the instant", _ago(HOUR - dt.timedelta(hours=10), "%Y-%m-%dT%H:%M:%S") + "+10:00"),
        ("offset that crosses the window", _ago(DAY - dt.timedelta(hours=10), "%Y-%m-%dT%H:%M:%S") + "+10:00"),
        ("compact stamp", _ago(HOUR, "%Y%m%dT%H%M%SZ")),
        ("date only is midnight, stale", "2026-11-25"),
        ("date only is midnight, fresh", "2026-11-27"),
        ("microseconds", _ago(HOUR, "%Y-%m-%dT%H:%M:%S.123456Z")),
        ("empty string", ""),
        ("whitespace", " "),
        ("garbage string", "yes"),
        ("lowercase z is not an offset", _ago(HOUR, "%Y-%m-%dT%H:%M:%Sz")),
        ("year overflow through offset", "9999-12-31T23:59:59-01:00"),
        ("year 0001 underflow through offset", "0001-01-01T00:00:00+01:00"),
        ("integer", 5),
        ("zero", 0),
        ("float", 1.5),
        ("true", True),
        ("false", False),
        ("null", None),
        ("list", [_ago(HOUR)]),
        ("empty list", []),
        ("dict with stale at", {"at": stale}),
        ("dict with fresh at", {"at": _ago(HOUR)}),
        ("dict with future at", {"at": (NOW + HOUR).strftime("%Y-%m-%dT%H:%M:%SZ")}),
        ("dict with integer at", {"at": 7}),
        ("dict with null at", {"at": None}),
        ("dict with garbage at", {"at": "never"}),
        ("empty dict", {}),
        ("dict without at", {"pr": 9, "state": "CLOSED"}),
        ("dict with nested at dict", {"at": {"at": _ago(HOUR)}}),
    ]
    out = []
    with _frozen():
        for name, marker in named:
            out.append({"name": name, "marker": marker, "due": repair_tick.closed_marker_due(marker)})
    return out


# ---------------------------------------------------------------------------
# reconcile_fix_prs (the fix_closed lane)


def _fix_pr_cases() -> List[Dict[str, Any]]:
    open_pr = {"state": "OPEN"}
    closed = {"state": "CLOSED"}
    merged_no_merge_commit = {"state": "MERGED", "number": 99, "headRefOid": HEAD}
    merged_not_ancestor = {"state": "MERGED", "number": 99, "headRefOid": HEAD, "mergeCommit": {"oid": MERGE}}
    base = {"fix_pr": {"number": 99, "url": "https://github.com/example/repo/pull/99"}}
    stale = _ago(DAY)
    specs = [
        ("first close stamps the marker", base, [closed]),
        ("a fresh marker costs no forge call", {**base, "fix_closed": _ago(HOUR)}, [closed]),
        ("a marker one second short of the window is skipped", {**base, "fix_closed": _ago(DAY - dt.timedelta(seconds=1))}, [closed]),
        ("a marker at exactly the window is rechecked and restamped", {**base, "fix_closed": stale}, [closed]),
        ("a stale marker that reopened is popped", {**base, "fix_closed": stale}, [open_pr]),
        ("a stale marker that merged with no merge commit is popped", {**base, "fix_closed": stale}, [merged_no_merge_commit]),
        ("a stale marker that merged off the default tip is popped", {**base, "fix_closed": stale}, [merged_not_ancestor], {"ancestor": False}),
        ("an unreadable marker is due", {**base, "fix_closed": "yes"}, [closed]),
        ("an integer marker is due", {**base, "fix_closed": 5}, [open_pr]),
        ("a true marker is due", {**base, "fix_closed": True}, [open_pr]),
        ("a future marker is not due", {**base, "fix_closed": (NOW + HOUR).strftime("%Y-%m-%dT%H:%M:%SZ")}, [closed]),
        ("an empty marker is falsy and examined as a first close", {**base, "fix_closed": ""}, [closed]),
        ("a zero marker is falsy and examined as a first close", {**base, "fix_closed": 0}, [open_pr]),
        ("a dict marker with a stale at is due", {**base, "fix_closed": {"at": stale}}, [open_pr]),
        ("a dict marker with a fresh at is not due", {**base, "fix_closed": {"at": _ago(HOUR)}}, [open_pr]),
        ("a merged run is never rechecked", {**base, "fix_closed": stale, "fix_merged": "t"}, [open_pr]),
        ("a run without a fix pr is never examined", {"fix_closed": stale}, [open_pr]),
        ("a forge failure leaves a stale marker untouched", {**base, "fix_closed": stale}, [{"raise": "boom"}]),
        ("a stale marker is restamped while still closed, then skipped when fresh", {**base, "fix_closed": stale}, [closed, closed]),
    ]
    cases = []
    for entry in specs:
        name, record, forge = entry[0], entry[1], entry[2]
        facts = entry[3] if len(entry) > 3 else {}
        cases.append({"name": name, "record": record, "forge": forge, "ancestor": facts.get("ancestor", True),
                      "passes": 2 if name.endswith("when fresh") else 1})
    return cases


def run_fix_prs(spec: Dict[str, Any]) -> Dict[str, Any]:
    record = copy.deepcopy(spec["record"])
    item = {"id": "item-1", "kind": "other", "repair_runs": {"run1": record}}
    queue = {"items": [item]}
    answers = list(spec["forge"])
    calls: List[Any] = []

    def pr_info(number):
        calls.append(number)
        answer = answers.pop(0) if answers else {"state": "CLOSED"}
        if "raise" in answer:
            raise RuntimeError(answer["raise"])
        return copy.deepcopy(answer)

    c = SimpleNamespace(iso=lambda: NOW_ISO, pr_info=pr_info, git=lambda *args: TIP,
                        is_ancestor=lambda *args: spec["ancestor"])
    stats = []
    with _frozen():
        for _ in range(spec["passes"]):
            stats.append(repair_tick.reconcile_fix_prs(c, queue))
    return {"stats": stats, "record": record, "forge_calls": calls}


# ---------------------------------------------------------------------------
# reconcile_current_fix (the not_fixed lane)

DOC = dict(source={"repo": "o/r", "target_selector": "promoted-main"}, capture={"target": CAPTURE},
           findings=[{"type": "finding", "severity": "major", "comment": "fix"}], counted=True,
           classification={"counted": True, "outcome": "completed"}, outcome="terminal-with-findings")
NORMALIZED = {"severity": "major", "body": "fix"}


def _current_record(rid: str, **extra: Any) -> Dict[str, Any]:
    return dict(state="published", receipt_id=rid, jobs=["j"],
                verdicts=[dict(job="j", verdict="FIXED", finding=NORMALIZED)],
                receipt_findings=[review_receipt.digest(DOC["findings"][0])],
                repair_findings=[review_receipt.digest(NORMALIZED)], fix_pr={"number": 9},
                publication={"head": HEAD, "target": CAPTURE}, **extra)


def _current_cases() -> List[Dict[str, Any]]:
    stale = _ago(DAY)
    merged = {"number": 9, "state": "MERGED", "baseRefName": "main", "headRefOid": HEAD, "mergeCommit": {"oid": MERGE}}
    other_head = {**merged, "headRefOid": "e" * 40}
    closed = {"number": 9, "state": "CLOSED", "baseRefName": "main", "headRefOid": HEAD}
    opened = {"number": 9, "state": "OPEN", "baseRefName": "main", "headRefOid": HEAD}
    old_marker = {"pr": 9, "state": "CLOSED", "head": HEAD, "reason": "closed-or-head-mismatch"}
    specs = [
        ("a closed PR is stamped with at", {}, closed),
        ("a head mismatch is stamped with at", {}, other_head),
        ("a fresh marker is skipped without a forge call", {"not_fixed": {**old_marker, "at": _ago(HOUR)}}, merged),
        ("a stale marker that is still closed is restamped", {"not_fixed": {**old_marker, "at": stale}}, closed),
        ("a stale marker that merged at head is credited and popped", {"not_fixed": {**old_marker, "at": stale}}, merged),
        ("a stale marker that reopened is popped without credit", {"not_fixed": {**old_marker, "at": stale}}, opened),
        ("a pre-cadence marker without at is due", {"not_fixed": old_marker}, merged),
        ("a marker with an integer at is due", {"not_fixed": {**old_marker, "at": 7}}, merged),
        ("a marker with a garbage at is due", {"not_fixed": {**old_marker, "at": "never"}}, opened),
        ("a marker with a future at is not due", {"not_fixed": {**old_marker, "at": (NOW + HOUR).strftime("%Y-%m-%dT%H:%M:%SZ")}}, merged),
        ("an empty marker is falsy and examined", {"not_fixed": {}}, closed),
        ("a legacy truthy string marker that parses as a stale stamp is due", {"not_fixed": stale}, opened),
        ("a legacy truthy string marker that parses as a fresh stamp is not due", {"not_fixed": _ago(HOUR)}, merged),
        ("a legacy truthy string marker that does not parse is due", {"not_fixed": "legacy"}, opened),
        ("a true marker is due", {"not_fixed": True}, opened),
        ("a forge failure leaves a stale marker untouched", {"not_fixed": {**old_marker, "at": stale}}, {"raise": "boom"}),
        ("a cached merged_fix replaces the forge read for a stale marker", {"not_fixed": {**old_marker, "at": stale}, "merged_fix": merged}, {"raise": "unused"}),
    ]
    return [{"name": n, "extra": e, "forge": f} for n, e, f in specs]


def run_current(spec: Dict[str, Any]) -> Dict[str, Any]:
    with tempfile.TemporaryDirectory() as td:
        rid = review_receipt.write_receipt(Path(td) / "receipts", DOC)
        record = _current_record(rid, **copy.deepcopy(spec["extra"]))
        item = dict(kind=review_receipt.KIND, state="done", receipt_id=rid, subject=DOC["source"],
                    capture=DOC["capture"], remediation_state="fixed", remediation={"old": True},
                    repair_runs={"run": record})
        calls: List[Any] = []
        evidence: List[Any] = []

        def pr_info(number):
            calls.append(number)
            if "raise" in spec["forge"]:
                raise RuntimeError(spec["forge"]["raise"])
            return copy.deepcopy(spec["forge"])

        c = SimpleNamespace(STATE=Path(td), pr_info=pr_info, git=lambda *args: TIP,
                            is_ancestor=lambda *args: True, iso=lambda: NOW_ISO)
        with _frozen(), mock.patch.object(repair_tick, "merge_head_evidence",
                                          side_effect=lambda *a, **k: evidence.append(k.get("merge"))):
            counts = repair_tick.reconcile_current_fix(c, item)
        return {"counts": counts, "item": item, "forge_calls": calls, "evidence_merges": evidence, "receipt_id": rid}


# ---------------------------------------------------------------------------


def build() -> Dict[str, Any]:
    return {
        "now": NOW_ISO,
        "doc": DOC,
        "due": due_markers(),
        "fix_prs": [{"spec": s, "result": run_fix_prs(s)} for s in _fix_pr_cases()],
        "current": [{"spec": s, "result": run_current(s)} for s in _current_cases()],
    }


def render(document: Dict[str, Any]) -> str:
    return json.dumps(document, indent=1, sort_keys=True, ensure_ascii=True) + "\n"


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    group.add_argument("--stdout", action="store_true")
    args = parser.parse_args(argv)
    text = render(build())
    if args.stdout:
        sys.stdout.write(text)
    elif args.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(text, encoding="utf-8")
    else:
        if FIXTURE.read_text(encoding="utf-8") != text:
            print("closed-marker vectors are stale; rerun with --write", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
