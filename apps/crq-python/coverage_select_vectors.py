#!/usr/bin/env python3
"""Deterministic offline oracle for the TS ``CoverageEffects.select``.

Test tooling only. It drives the PRODUCTION ``backfill_runtime.select`` with the
real ``backfill_jobs`` (eligibility, admission, bind, cancel, terminal),
``review_ledger`` (digest, intervals, scope) and ``rank4_gate``. What Python's
``select`` reaches through live collaborators is replaced with scripted fakes:

* ``settings`` (the rollout file): returns a truthy config or ``None``;
* ``services(...).fetch()`` (the real ArtifactStore/Outbox/Spool/GitLedger):
  returns a scripted ``(head, events)`` or raises;
* ``coverage.load`` / ``coverage.request`` (the file-backed snapshot reader and
  request writer): scripted per target, recorded;
* ``c.launch`` (the reviewer process spawn): scripted, recorded;
* ``state_event`` and ``c.save_queue``: recording stubs.

The ``publication-failure.json`` probe runs for real against a temp directory.
The result records the return value, the queue and log left behind, the ordered
collaborator trace, or the exception class (the queue state is recorded too).
Nothing touches a real queue, clock, network, repository or host service.

Numbers beyond JSON's safe range are tagged ``{"$int": "..."}`` and
``{"$float": "..."}`` in the fixture so a JavaScript reader can rebuild them.

The TypeScript test (``test/adapters/crq/coverageSelectOracle.test.ts``) replays
the same specs through ``src/adapters/crq/coverageSelect.ts``.

Regenerate with ``python3.14 coverage_select_vectors.py --write`` and verify with
``--check``. Output is deterministic: sorted keys, ``ensure_ascii``, no
timestamps or host paths.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List
from unittest import mock

import backfill_runtime
import review_ledger as ledger

SCHEMA = "crq-coverage-select-oracle/1"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "crq-coverage-select" / "cases.json"
SOURCE_PATH = "apps/crq-python/backfill_runtime.py"
AT = "2026-11-20T12:00:00Z"
OBS_FRESH = "2026-11-20T11:59:30Z"
CREATED = "2026-11-20T10:00:00Z"
HEAD = "head-1"
SAFE = 2**53 - 1


class Trap(AssertionError):
    """A vector referenced something the spec never supplied: a bug in the vector."""


# ------------------------------------------------------- number tagging


def enc(value: Any) -> Any:
    """Tag numbers a JavaScript JSON reader would round; leave the rest alone."""
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, int):
        return {"$int": str(value)} if abs(value) > SAFE else value
    if isinstance(value, float):
        if not math.isfinite(value) or (value == int(value) and abs(value) > SAFE):
            return {"$float": repr(value)}
        return value
    if isinstance(value, (list, tuple)):
        return [enc(v) for v in value]
    if isinstance(value, dict):
        return {k: enc(v) for k, v in value.items()}
    raise Trap("cannot encode " + type(value).__name__)


# ------------------------------------------------------------------ builders


def job(item_id: str = "job-a", target: str = "t1", **extra: Any) -> dict:
    out = {"id": item_id, "job_id": item_id, "kind": "backfill", "state": "pending", "attempt": 0,
           "family": "fam-" + item_id, "subject_id": item_id, "subject_kind": "B", "score": 1,
           "tier_importance": "T4", "target": target, "base": "base-" + item_id, "head": "tip-" + item_id,
           "created_at": CREATED, "scope": [{"path": "a.py", "blob": "x", "intervals": [[1, 3]]}]}
    out.update(extra)
    return out


def usage(remaining: Any = 5, observed_at: str = OBS_FRESH) -> dict:
    return {"successful": True, "remaining": remaining, "observed_at": observed_at,
            "reflected_reservations": []}


def queue(items: list | None = None, **extra: Any) -> dict:
    out: Dict[str, Any] = {"items": items if items is not None else [job()], "starts": [],
                           "backfill_usage": usage()}
    out.update(extra)
    return out


def cov(covered: dict | None = None, gaps: list | None = None) -> dict:
    return {"covered": covered if covered is not None else {}, "gaps": gaps or []}


FULL = cov({"a.py": [1, 2, 3]})
PART = cov({"a.py": [1]})
NONE: Any = None


def digest(head: str, jobs: list, eligible: list) -> str:
    return ledger.digest({"head": head, "jobs": sorted(jobs), "eligible": sorted(eligible)})


def sel(name: str, q: dict, *, coverage: dict | None = None, dry: bool = False, only: Any = None,
        pubfail: bool = False, dispatch: bool = True, ordinary: bool = False, head: str = HEAD,
        events: list | None = None, fetch_raises: str | None = None, load_raises: dict | None = None,
        request_raises: dict | None = None, launch: dict | None = None, event_raises: str | None = None,
        digest_prefixes: bool = False) -> dict:
    return {"name": name, "spec": {
        "queue": q, "now": AT, "dry": dry, "only": only, "pubfail": pubfail, "dispatch": dispatch,
        "ordinary": ordinary, "head": head, "events": events if events is not None else ["e1", "e2"],
        "fetch_raises": fetch_raises, "coverage": coverage if coverage is not None else {"t1": FULL},
        "load_raises": load_raises or {}, "request_raises": request_raises, "launch": launch,
        "event_raises": event_raises}}


def reviewing(run_id: str = "run-1", **extra: Any) -> dict:
    return {"mode": "reviewing", "run_id": run_id, **extra}


def refused(**extra: Any) -> dict:
    return {"mode": "refused", "run_id": "ignored", **extra}


# --------------------------------------------------------------------- cases


def early_cases() -> List[dict]:
    two = [job("job-a"), job("job-b")]
    return [
        sel("a halted queue does nothing", queue(backfill_halted=True), launch=reviewing()),
        sel("a publication error does nothing", queue(backfill_publication_error="x"), launch=reviewing()),
        sel("a truthy non-bool halt does nothing", queue(backfill_halted=1), launch=reviewing()),
        sel("a falsy halt does not stop it", queue(backfill_halted=0, backfill_publication_error=""),
            coverage={"t1": PART}, launch=reviewing()),
        sel("a publication-failure file does nothing", queue(), pubfail=True, launch=reviewing()),
        sel("a missing dispatch config does nothing", queue(), dispatch=False, launch=reviewing()),
        sel("an empty item list does nothing", queue([])),
        sel("only non-backfill items does nothing", queue([{"id": "cov", "kind": "coverage", "state": "pending"}])),
        sel("a non-backfill item is skipped among backfill ones",
            queue([{"id": "cov", "kind": "coverage", "state": "pending"}, job()]), coverage={"t1": PART},
            dry=True),
        sel("an item without a kind is skipped", queue([{"id": "x", "state": "pending"}, job()]),
            coverage={"t1": PART}, dry=True),
        sel("a non-dict item raises AttributeError", queue([None])),
        sel("a reviewing item is never selected", queue([job(state="reviewing")])),
        sel("an unlaunchable future not_before nothing eligible", queue([job(not_before="2026-11-21T00:00:00Z")])),
        sel("a cooldown queue has nothing eligible", queue(cooldown_until="2026-11-21T00:00:00Z")),
        sel("an expired pending job is not eligible", queue([job(created_at="2026-11-18T00:00:00Z")])),
        sel("a quarantined family is not eligible",
            queue(backfill_families={"fam-job-a": {"failures": 6, "quarantined": True, "next_eligible_at": None}})),
        sel("a family retry later is not eligible",
            queue(backfill_families={"fam-job-a": {"failures": 1, "quarantined": False,
                                                   "next_eligible_at": "2026-11-21T00:00:00Z"}})),
        sel("a scope failure retry later is not eligible",
            queue(backfill_scope_failures={"a.py": {"failures": 1, "quarantined": False,
                                                    "next_eligible_at": "2026-11-21T00:00:00Z"}})),
        sel("a past retry time is eligible",
            queue(backfill_families={"fam-job-a": {"failures": 1, "quarantined": False,
                                                   "next_eligible_at": "2026-11-19T00:00:00Z"}}),
            coverage={"t1": PART}, dry=True),
        sel("an unreadable not_before makes it ineligible", queue([job(not_before="soon")])),
        sel("an unreadable created_at expires it", queue([job(created_at="whenever")])),
        sel("a missing family raises KeyError", queue([{k: v for k, v in job().items() if k != "family"}])),
        sel("only selects the matching job", queue(two), coverage={"t1": PART}, only="job-b", dry=True),
        sel("only with no match does nothing", queue(two), only="job-z"),
        sel("an empty only selects every job", queue(two), coverage={"t1": PART}, only="", dry=True),
        sel("only does not record a reconciliation", queue(), coverage={"t1": FULL}, only="job-a"),
        sel("an item without an id raises KeyError under only",
            queue([{k: v for k, v in job().items() if k != "id"}]), only="job-a"),
        sel("a missing id with no only raises KeyError", queue([{k: v for k, v in job().items() if k != "id"}])),
    ]


def preflush_cases() -> List[dict]:
    pending = {"at": "2026-11-20T11:00:00Z", "reason": "launch refused before vendor binding"}
    return [
        sel("a pending refusal event is flushed", queue([job(refusal_state_event=pending)]), coverage={"t1": FULL}),
        sel("a dry run leaves a pending refusal event", queue([job(refusal_state_event=pending)]),
            coverage={"t1": FULL}, dry=True),
        sel("a falsy refusal event is ignored", queue([job(refusal_state_event={})]), coverage={"t1": FULL}),
        sel("a refusal event without a time raises KeyError", queue([job(refusal_state_event={"reason": "r"})])),
        sel("a failing refusal event publication propagates", queue([job(refusal_state_event=pending)]),
            event_raises="launch refused before vendor binding"),
        sel("every job's refusal event is flushed in order",
            queue([job("job-b", refusal_state_event=pending), job("job-a", refusal_state_event=pending)]),
            coverage={"t1": FULL}),
        sel("a flushed event on a non-matching only is left", queue([job(refusal_state_event=pending)]),
            only="job-z"),
    ]


def sort_cases() -> List[dict]:
    def pick(name: str, items: list, **kw: Any) -> dict:
        return sel(name, queue(items), coverage={"t1": PART}, dry=True, **kw)

    return [
        pick("a lower tier importance sorts first", [job("job-a", tier_importance="T4"), job("job-b", tier_importance="T2")]),
        pick("a higher score sorts first",
             [job("job-a", score=1), job("job-b", score=5), job("job-c", score=3)]),
        pick("a fractional score sorts", [job("job-a", score=2.5), job("job-b", score=2.75)]),
        pick("a retry job sorts after a fresh one", [job("job-a", retry=True), job("job-b")]),
        pick("retry numerics compare as numbers", [job("job-a", retry=1), job("job-b", retry=True, score=9)]),
        pick("subject kind A sorts before B", [job("job-a"), job("job-b", subject_kind="A", row=4)]),
        pick("A rows sort by row", [job("job-a", subject_kind="A", row=9), job("job-b", subject_kind="A", row=2)]),
        pick("an A row of zero or none ties at zero",
             [job("job-a", subject_kind="A", row=3), job("job-b", subject_kind="A", row=None),
              job("job-c", subject_kind="A", row=0)]),
        pick("an A row needs no score", [job("job-a", subject_kind="A", row=1,
                                              **{}), job("job-b", subject_kind="A", row=1)]),
        pick("equal keys fall to subject id",
             [job("job-b", subject_id="zz"), job("job-a", subject_id="aa")]),
        pick("subject ids compare by code point",
             [job("job-a", subject_id="\U0001F600"), job("job-b", subject_id="～")]),
        pick("integer, float and bool scores tie and fall to subject id",
             [job("job-a", score=1, subject_id="s2"), job("job-b", score=1.0, subject_id="s1"),
              job("job-c", score=True, subject_id="s0")]),
        pick("a boolean score negates as an integer", [job("job-a", score=True), job("job-b", score=0)]),
        pick("an unsafe integer score keeps exact order",
             [job("job-a", score=SAFE + 2), job("job-b", score=SAFE + 1)]),
        pick("an unsafe integer score equals the same float",
             [job("job-a", score=SAFE + 1, subject_id="s2"), job("job-b", score=float(SAFE + 1), subject_id="s1")]),
        pick("a huge float score sorts by magnitude",
             [job("job-a", score=1e20), job("job-b", score=1e19)]),
        pick("stable order on full ties is queue order",
             [job("job-a", subject_id="same"), job("job-b", subject_id="same")]),
        pick("a string score raises TypeError",
             [job("job-a", score="5"), job("job-b", score=3)]),
        pick("a null score raises TypeError", [job("job-a", score=None), job("job-b")]),
        pick("a list score raises TypeError", [job("job-a", score=[1]), job("job-b")]),
        pick("a missing score raises KeyError",
             [{k: v for k, v in job("job-a").items() if k != "score"}, job("job-b")]),
        pick("a missing tier raises KeyError",
             [{k: v for k, v in job("job-a").items() if k != "tier_importance"}, job("job-b")]),
        pick("a missing subject kind raises KeyError",
             [{k: v for k, v in job("job-a").items() if k != "subject_kind"}, job("job-b")]),
        pick("a missing subject id raises KeyError",
             [{k: v for k, v in job("job-a").items() if k != "subject_id"}, job("job-b")]),
        pick("mixed tier types raise TypeError", [job("job-a", tier_importance=3), job("job-b", tier_importance="T4")]),
        pick("a single mixed-type item sorts without comparing",
             [job("job-a", tier_importance=3, score="x")]),
        pick("a null tier against a string raises TypeError",
             [job("job-a", tier_importance=None), job("job-b", tier_importance="T4")]),
        pick("equal null tiers do not compare", [job("job-a", tier_importance=None, subject_id="s2"),
                                                job("job-b", tier_importance=None, subject_id="s1")]),
        pick("a non-string subject kind among strings raises TypeError",
             [job("job-a", subject_kind=5), job("job-b")]),
        pick("a numeric tier sorts numerically",
             [job("job-a", tier_importance=10), job("job-b", tier_importance=9)]),
        pick("a tier of true and one tie as numbers",
             [job("job-a", tier_importance=True, subject_id="s2"), job("job-b", tier_importance=1, subject_id="s1")]),
        pick("an A row that is a string raises TypeError against a number",
             [job("job-a", subject_kind="A", row="x"), job("job-b", subject_kind="A", row=2)]),
        pick("a B job with a non-A kind uses the negated score",
             [job("job-a", subject_kind="C", score=1), job("job-b", subject_kind="C", score=9)]),
    ]


def gate_cases() -> List[dict]:
    two = [job("job-a"), job("job-b")]
    pend = ["job-a", "job-b"]
    return [
        sel("an exhausted quota refuses without coverage reads and records no snapshot",
            queue(backfill_usage=usage(remaining=1)), coverage={"t1": PART}),
        sel("a refusal marks every pending job and keeps available",
            queue(two, backfill_usage=usage(remaining=1)), coverage={"t1": PART}),
        sel("an ordinary eligible queue refuses rank 4", queue(), ordinary=True, coverage={"t1": PART}),
        sel("a refusal with covered jobs still marks done",
            queue(two, backfill_usage=usage(remaining=1)), coverage={"t1": FULL}),
        sel("a refusal digest match short-circuits with the old availability",
            queue(two, backfill_usage=usage(remaining=1),
                  backfill_coverage_reconciled={"digest": digest(HEAD, pend, pend), "available": True}),
            coverage={"t1": PART}),
        sel("a refusal digest match with a falsy availability returns false",
            queue(two, backfill_usage=usage(remaining=1),
                  backfill_coverage_reconciled={"digest": digest(HEAD, pend, pend), "available": 0}),
            coverage={"t1": PART}),
        sel("a short circuit keeps a missing evidence reason",
            queue([job("job-a", wait_reason=backfill_runtime.MISSING_EVIDENCE), job("job-b")],
                  backfill_usage=usage(remaining=1),
                  backfill_coverage_reconciled={"digest": digest(HEAD, pend, pend), "available": True}),
            coverage={"t1": PART}),
        sel("a different head defeats the short circuit",
            queue(two, backfill_usage=usage(remaining=1),
                  backfill_coverage_reconciled={"digest": digest("head-0", pend, pend), "available": True}),
            coverage={"t1": PART}),
        sel("a different eligible set defeats the short circuit",
            queue(two, backfill_usage=usage(remaining=1),
                  backfill_coverage_reconciled={"digest": digest(HEAD, pend, ["job-a"]), "available": True}),
            coverage={"t1": PART}),
        sel("a non-dict reconciliation record is ignored",
            queue(two, backfill_usage=usage(remaining=1), backfill_coverage_reconciled=[1]), coverage={"t1": PART}),
        sel("a matching digest without a refusal still runs",
            queue(two, backfill_coverage_reconciled={"digest": digest(HEAD, pend, pend), "available": True}),
            coverage={"t1": PART}, dry=True),
        sel("a prior wait reason is restored after the probe",
            queue([job(wait_reason="earlier")], backfill_usage=usage(remaining=1)), coverage={"t1": PART}),
        sel("a null wait reason is restored after the probe",
            queue([job(wait_reason=None)], backfill_usage=usage(remaining=1)), coverage={"t1": PART}),
        sel("an empty wait reason is restored after the probe",
            queue([job(wait_reason="")], backfill_usage=usage(remaining=1)), coverage={"t1": PART}),
        sel("a stale usage observation refuses",
            queue(backfill_usage=usage(observed_at="2026-11-20T11:40:00Z")), coverage={"t1": PART}),
        sel("no usage observation refuses", {"items": [job()], "starts": []}, coverage={"t1": PART}),
        sel("a dry run admits and logs", queue(), coverage={"t1": PART}, dry=True),
        sel("a dry run gate refusal marks the pending jobs", queue(two, backfill_usage=usage(remaining=1)),
            coverage={"t1": PART}, dry=True),
        sel("an in-flight cap refuses", queue([job("job-a"), job("job-b", state="reviewing"),
                                               job("job-c", state="reviewing")]), coverage={"t1": PART}),
        sel("a gate refusal on the second job after the first launch is refused",
            queue(two), coverage={"t1": PART}, launch=refused()),
    ]


def coverage_cases() -> List[dict]:
    two = [job("job-a"), job("job-b")]
    return [
        sel("a missing snapshot leaves the job waiting and asks for a refresh", queue(), coverage={}),
        sel("a null snapshot leaves the job waiting", queue(), coverage={"t1": NONE}),
        sel("a missing snapshot on a dry run asks for nothing", queue(), coverage={}, dry=True),
        sel("a missing snapshot under only records nothing", queue(), coverage={}, only="job-a"),
        sel("two targets are requested sorted", queue([job("job-a", "t2"), job("job-b", "t1")]), coverage={}),
        sel("a repeated target loads once", queue(two), coverage={}),
        sel("one covered and one missing target", queue([job("job-a", "t1"), job("job-b", "t2")]),
            coverage={"t1": FULL}),
        sel("a gap waits for evidence and requests a refresh",
            queue(), coverage={"t1": cov({"a.py": [1]}, [{"path": "a.py"}])}),
        sel("gaps never block a covered record check order", queue(),
            coverage={"t1": cov({"a.py": [1, 2, 3]}, ["g"])}),
        sel("full coverage marks done and records the head", queue(), coverage={"t1": FULL}),
        sel("full coverage under only does not record a reconciliation", queue(), coverage={"t1": FULL},
            only="job-a"),
        sel("covered lines beyond the scope still satisfy", queue(), coverage={"t1": cov({"a.py": [1, 2, 3, 4]})}),
        sel("a covered path of another name does not satisfy", queue(), coverage={"t1": cov({"b.py": [1, 2, 3]})},
            dry=True),
        sel("an empty scope is satisfied by anything", queue([job(scope=[])]), coverage={"t1": cov()}),
        sel("two paths need both covered",
            queue([job(scope=[{"path": "a.py", "blob": "x", "intervals": [[1, 2]]},
                              {"path": "b.py", "blob": "y", "intervals": [[1, 1]]}])]),
            coverage={"t1": cov({"a.py": [1, 2], "b.py": []})}, dry=True),
        sel("the same path with two blobs is a duplicate raising IntegrityError",
            queue([job(scope=[{"path": "a.py", "blob": "x", "intervals": [[1, 2]]},
                              {"path": "a.py", "blob": "x", "intervals": [[3, 4]]}])]),
            coverage={"t1": cov({"a.py": [1, 2]})}),
        sel("the same path with two blobs needs the union",
            queue([job(scope=[{"path": "a.py", "blob": "x", "intervals": [[1, 2]]},
                              {"path": "a.py", "blob": "y", "intervals": [[3, 4]]}])]),
            coverage={"t1": cov({"a.py": [1, 2, 3]})}, dry=True),
        sel("overlapping intervals raise IntegrityError",
            queue([job(scope=[{"path": "a.py", "blob": "x", "intervals": [[1, 3], [2, 4]]}])]),
            coverage={"t1": cov({"a.py": [1]})}),
        sel("a non canonical path raises IntegrityError in the scope check",
            queue([job(scope=[{"path": "../a.py", "blob": "x", "intervals": [[1, 2]]}])]),
            coverage={"t1": cov({"a.py": [1, 2]})}),
        sel("an unreadable interval row raises", queue([job(scope=[{"path": "a.py", "blob": "x",
                                                                    "intervals": [[1.5, 2]]}])]),
            coverage={"t1": cov({"a.py": [1]})}),
        sel("a scope row without a path raises KeyError",
            queue([job(scope=[{"blob": "x", "intervals": [[1, 2]]}])]), coverage={"t1": cov({"a.py": [1]})}),
        sel("a scope row without intervals raises KeyError",
            queue([job(scope=[{"path": "a.py", "blob": "x"}])]), coverage={"t1": cov({"a.py": [1]})}),
        sel("a scope row without a blob raises KeyError when satisfied",
            queue([job(scope=[{"path": "a.py", "intervals": [[1, 2]]}])]), coverage={"t1": cov({"a.py": [1, 2]})}),
        sel("a missing scope raises KeyError", queue([{k: v for k, v in job().items() if k != "scope"}]),
            coverage={"t1": PART}),
        sel("a missing target raises KeyError", queue([{k: v for k, v in job().items() if k != "target"}])),
        sel("a non-pending item keeps its tier as the dispatch tier",
            queue([job("job-a", state="reviewing"), job("job-b")]), coverage={"t1": PART}, dry=True),
        sel("a non-pending item with a dispatch tier keeps it",
            queue([job("job-a", state="done", dispatch_tier_importance="T1"), job("job-b")]),
            coverage={"t1": PART}, dry=True),
        sel("a pending item overwrites its earlier dispatch tier",
            queue([job("job-a", dispatch_tier_importance="T9", tier_importance="T4")]), coverage={"t1": PART},
            dry=True),
        sel("path tiers lower the dispatch tier of an uncovered path",
            queue([job("job-a", tier_importance="T4", path_tiers={"a.py": "T1"}), job("job-b", tier_importance="T3")]),
            coverage={"t1": PART}, dry=True),
        sel("a covered path's tier is ignored",
            queue([job("job-a", tier_importance="T4", path_tiers={"a.py": "T1"}), job("job-b", tier_importance="T3")]),
            coverage={"t1": FULL}),
        sel("the minimum tier of several uncovered paths wins",
            queue([job("job-a", tier_importance="T9",
                       scope=[{"path": "a.py", "blob": "x", "intervals": [[1, 2]]},
                              {"path": "b.py", "blob": "y", "intervals": [[1, 2]]}],
                       path_tiers={"a.py": "T3", "b.py": "T2"}),
                   job("job-b", tier_importance="T4")]),
            coverage={"t1": cov()}, dry=True),
        sel("an unmapped uncovered path uses the job tier",
            queue([job("job-a", tier_importance="T2", path_tiers={"other.py": "T9"}), job("job-b", tier_importance="T3")]),
            coverage={"t1": PART}, dry=True),
        sel("all-covered scope gives the job tier",
            queue([job("job-a", tier_importance="T2", path_tiers={"a.py": "T9"})]), coverage={"t1": FULL}),
        sel("a path tier of a different type raises TypeError",
            queue([job("job-a", path_tiers={"a.py": 3}), job("job-b", tier_importance="T3")]),
            coverage={"t1": PART}),
        sel("a list path_tiers raises AttributeError when a path is uncovered",
            queue([job("job-a", path_tiers=[1])]), coverage={"t1": PART}),
        sel("a list path_tiers is unread when the scope is covered",
            queue([job("job-a", path_tiers=[1])]), coverage={"t1": FULL}),
        sel("a null path_tiers raises AttributeError when uncovered",
            queue([job("job-a", path_tiers=None)]), coverage={"t1": PART}),
        sel("the dispatch tier re-sorts the jobs",
            queue([job("job-a", tier_importance="T1", scope=[{"path": "z.py", "blob": "x", "intervals": [[1, 1]]}],
                       path_tiers={"z.py": "T9"}), job("job-b", tier_importance="T5")]),
            coverage={"t1": cov()}, dry=True),
        sel("a numeric dispatch tier sorts after the first sort",
            queue([job("job-a", tier_importance=2), job("job-b", tier_importance=1)]),
            coverage={"t1": PART}, dry=True),
        sel("a load that raises propagates", queue(), load_raises={"t1": "ValueError"}),
        sel("a load that raises OSError propagates", queue(), load_raises={"t1": "OSError"}),
        sel("a ledger fetch that raises propagates", queue(), fetch_raises="OSError"),
        sel("a ledger fetch that raises a runtime error propagates", queue(), fetch_raises="RuntimeError"),
        sel("a final request that raises OSError propagates", queue(), coverage={}, request_raises={"cls": "OSError", "message": "disk full"}),
        sel("a final request that raises another class propagates", queue(), coverage={},
            request_raises={"cls": "ValueError", "message": "bad"}),
        sel("a final request that raises a missing-file error propagates", queue(), coverage={},
            request_raises={"cls": "FileNotFoundError", "message": "gone"}),
        sel("the ledger events reach the loader and shared digests", queue([job("job-a", "t1"), job("job-b", "t2"),
                                                                           job("job-c", "t3")]),
            coverage={"t1": FULL, "t2": PART, "t3": NONE}, events=["e1", "e2", "e3"], dry=True),
        sel("an empty ledger", queue(), coverage={"t1": FULL}, events=[], head="h0"),
        sel("a reconciliation is keyed on every backfill job and the unfinished eligible ones",
            queue([job("job-a"), job("job-b", state="reviewing"), job("job-c", "t2")]),
            coverage={"t1": FULL, "t2": cov({"a.py": [1, 2, 3]})}),
        sel("an unsafe integer in an untouched field survives",
            queue([job("job-a", note=SAFE + 5, ratio=1e20)]), coverage={"t1": FULL}),
    ]


def launch_cases() -> List[dict]:
    two = [job("job-a"), job("job-b")]
    return [
        sel("a reviewing launch binds the run and returns it", queue(), coverage={"t1": PART}, launch=reviewing()),
        sel("a reviewing launch also asks for stale targets",
            queue([job("job-a", "t1"), job("job-b", "t2")]), coverage={"t1": PART},
            launch=reviewing()),
        sel("a reviewing launch survives an OSError on the stale request",
            queue([job("job-a", "t1"), job("job-b", "t2")]), coverage={"t1": PART}, launch=reviewing(),
            request_raises={"cls": "OSError", "message": "disk full"}),
        sel("a reviewing launch truncates a long OSError message",
            queue([job("job-a", "t1"), job("job-b", "t2")]), coverage={"t1": PART}, launch=reviewing(),
            request_raises={"cls": "OSError", "message": "x" * 200}),
        sel("a reviewing launch survives a missing-file error on the stale request",
            queue([job("job-a", "t1"), job("job-b", "t2")]), coverage={"t1": PART}, launch=reviewing(),
            request_raises={"cls": "PermissionError", "message": "denied"}),
        sel("a reviewing launch propagates another request error after binding",
            queue([job("job-a", "t1"), job("job-b", "t2")]), coverage={"t1": PART}, launch=reviewing(),
            request_raises={"cls": "ValueError", "message": "bad"}),
        sel("a reviewing launch reaches the second target job after a covered first",
            queue([job("job-a", "t1"), job("job-b", "t2")]), coverage={"t1": FULL, "t2": PART}, launch=reviewing()),
        sel("a bind conflict leaves the job launch-unknown",
            queue(), coverage={"t1": PART}, launch=reviewing(hold_run="other")),
        sel("a state event failure after binding keeps the bound run",
            queue(), coverage={"t1": PART}, launch=reviewing(), event_raises="vendor identity bound"),
        sel("a launch that raises marks launch-unknown", queue(), coverage={"t1": PART},
            launch={"mode": "raises", "cls": "RuntimeError", "message": "spawn failed"}),
        sel("a launch that raises OSError marks launch-unknown", queue(), coverage={"t1": PART},
            launch={"mode": "raises", "cls": "OSError", "message": "spawn failed"}),
        sel("a launch that raises KeyError marks launch-unknown", queue(), coverage={"t1": PART},
            launch={"mode": "raises", "cls": "KeyError", "message": "k"}),
        sel("a refused launch records a secret-scan terminal", queue(), coverage={"t1": PART}, launch=refused()),
        sel("a refused launch keeps its last error as the reason", queue(), coverage={"t1": PART},
            launch=refused(last_error="scan hit")),
        sel("a refused launch with an empty last error uses the outcome", queue(), coverage={"t1": PART},
            launch=refused(last_error="")),
        sel("a refused launch with a null last error uses the outcome", queue(), coverage={"t1": PART},
            launch=refused(last_error=None)),
        sel("a refused launch with a zero last error uses the outcome", queue(), coverage={"t1": PART},
            launch=refused(last_error=0)),
        sel("a refused launch keeps a truthy non-string last error", queue(), coverage={"t1": PART},
            launch=refused(last_error=5)),
        sel("a refused launch keeps a list last error", queue(), coverage={"t1": PART},
            launch=refused(last_error=["x"])),
        sel("a refused launch with a run recorded stays launch-unknown", queue(), coverage={"t1": PART},
            launch=refused(run={"id": "r-9"})),
        sel("a refused launch moves on to the next job", queue(two), coverage={"t1": PART}, launch=refused()),
        sel("a refused launch followed by a launch that binds", queue(two), coverage={"t1": PART},
            launch={"mode": "sequence", "steps": [refused(), reviewing("run-2")]}),
        sel("a refused launch whose event publication fails keeps the pending event",
            queue(), coverage={"t1": PART}, launch=refused(), event_raises="launch refused before vendor binding"),
        sel("a refused launch repeated enough quarantines the family",
            queue([job(failures=2)], backfill_families={"fam-job-a": {"failures": 5, "quarantined": False,
                                                                       "next_eligible_at": None}}),
            coverage={"t1": PART}, launch=refused()),
        sel("a refused launch on the third failure blocks the job",
            queue([job(failures=2)]), coverage={"t1": PART}, launch=refused()),
        sel("a refused launch finishes by recording the reconciliation", queue(), coverage={"t1": PART},
            launch=refused()),
        sel("a refused launch with a stale target requests it at the end",
            queue([job("job-a", "t1"), job("job-b", "t2")]), coverage={"t1": PART}, launch=refused()),
        sel("a launch run under only still launches", queue(two), coverage={"t1": PART}, only="job-b",
            launch=reviewing()),
        sel("a dry run never launches", queue(two), coverage={"t1": PART}, launch=reviewing(), dry=True),
        sel("a launch plan is built from the job", queue([job("job-a", base="b9", head="h9", target="t1")]),
            coverage={"t1": PART}, launch=reviewing()),
        sel("a job missing its base raises KeyError after admission",
            queue([{k: v for k, v in job().items() if k != "base"}]), coverage={"t1": PART}, launch=reviewing()),
        sel("a job missing its head raises KeyError after admission",
            queue([{k: v for k, v in job().items() if k != "head"}]), coverage={"t1": PART}, launch=reviewing()),
        sel("a reviewing job never consulted by the launch path", queue([job(state="reviewing"), job("job-b")]),
            coverage={"t1": PART}, launch=reviewing()),
    ]


# ------------------------------------------------------------------ driver


class Fetched:
    def __init__(self, spec: dict, trace: List[list]) -> None:
        self.spec, self.trace = spec, trace

    def fetch(self) -> Any:
        self.trace.append(["fetch"])
        if self.spec["fetch_raises"]:
            raise exception(self.spec["fetch_raises"], "ledger fetch failed")
        return self.spec["head"], list(self.spec["events"])


def exception(cls: str, message: str) -> Exception:
    table = {"OSError": OSError, "FileNotFoundError": FileNotFoundError, "PermissionError": PermissionError,
             "ValueError": ValueError, "RuntimeError": RuntimeError, "KeyError": KeyError,
             "TypeError": TypeError}
    if cls not in table:
        raise Trap("unknown exception " + cls)
    return table[cls](message)


def run_select(spec: dict) -> dict:
    q = spec["queue"]
    trace: List[list] = []
    log: List[str] = []
    launches = list(spec["launch"]["steps"]) if spec["launch"] and spec["launch"]["mode"] == "sequence" else None

    def save_queue(queue_: dict) -> None:
        trace.append(["save", copy.deepcopy(queue_)])

    def state_event(c: Any, queue_: dict, item: dict, at: str, reason: str, **_: Any) -> None:
        trace.append(["state_event", item["id"], at, reason, copy.deepcopy(item)])
        if spec["event_raises"] is not None and reason == spec["event_raises"]:
            raise RuntimeError("state event failed")

    def launch(queue_: dict, item: dict, plan: dict) -> str:
        trace.append(["launch", copy.deepcopy(item), copy.deepcopy(plan)])
        step = launches.pop(0) if launches is not None else spec["launch"]
        if step is None:
            raise Trap("select launched but the spec scripted no launch")
        if step["mode"] == "raises":
            raise exception(step["cls"], step["message"])
        if "run" in step:
            item["run"] = copy.deepcopy(step["run"])
        if "last_error" in step:
            item["last_error"] = step["last_error"]
        if step["mode"] == "reviewing":
            if "hold_run" in step:
                queue_["backfill_reservations"][item["attempt_id"]]["vendor_run_id"] = step["hold_run"]
            item.update(state="reviewing", run={"id": step["run_id"]})
        return step["run_id"]

    def settings(state: Any, *, dispatch: bool = False) -> Any:
        return {"enabled": True} if spec["dispatch"] else None

    def services(c: Any, config: Any) -> tuple:
        return None, None, None, Fetched(spec, trace)

    def load(state: Any, target: str, events: list, digests: dict | None = None) -> Any:
        trace.append(["load", target, len(events), sorted(digests or {})])
        if target in spec["load_raises"]:
            raise exception(spec["load_raises"][target], "load failed")
        entry = spec["coverage"].get(target)
        if entry is None:
            return None
        digests[len(events)] = "digest-" + str(len(events))
        return {path: set(lines) for path, lines in entry["covered"].items()}, list(entry["gaps"])

    def request(state: Any, head: str, targets: Any) -> None:
        trace.append(["request", head, sorted(targets)])
        raised = spec["request_raises"]
        if raised:
            raise exception(raised["cls"], raised["message"])

    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp)
        if spec["pubfail"]:
            (state / "backfill").mkdir()
            (state / "backfill" / "publication-failure.json").write_text("{}")
        c = SimpleNamespace(STATE=state, iso=lambda: spec["now"], save_queue=save_queue, launch=launch,
                            ordinary_review_eligible=lambda queue_: spec["ordinary"])
        with mock.patch.object(backfill_runtime, "state_event", state_event), \
                mock.patch.object(backfill_runtime, "settings", settings), \
                mock.patch.object(backfill_runtime, "services", services), \
                mock.patch.object(backfill_runtime.coverage, "load", load), \
                mock.patch.object(backfill_runtime.coverage, "request", request):
            try:
                started, available = backfill_runtime.select(c, q, log, spec["dry"], spec["only"])
                result: Dict[str, Any] = {"ok": {"started": started, "available": available}}
            except Exception as exc:  # noqa: BLE001 - the class name is the oracle
                if isinstance(exc, Trap):
                    raise
                result = {"raises": type(exc).__name__, "message": str(exc)}
    result["queue"] = q
    result["log"] = log
    result["trace"] = trace
    return result


def run_spec(spec: dict) -> dict:
    return run_select(copy.deepcopy(spec))


def all_cases() -> List[dict]:
    return early_cases() + preflush_cases() + sort_cases() + gate_cases() + coverage_cases() + launch_cases()


def build() -> dict:
    cases = all_cases()
    names = [c["name"] for c in cases]
    if len(names) != len(set(names)):
        raise Trap("duplicate case names")
    return {"schema": SCHEMA, "source": SOURCE_PATH,
            "cases": [{"name": case["name"], "spec": enc(case["spec"]), "result": enc(run_spec(case["spec"]))}
                      for case in cases]}


def render(document: dict) -> str:
    return json.dumps(document, ensure_ascii=True, indent=1, sort_keys=True, allow_nan=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit the crq coverage select oracle fixture")
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
        print("coverage-select fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
