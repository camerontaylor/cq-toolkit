#!/usr/bin/env python3
"""Deterministic offline oracle for the TS coverage backfill seams.

Test tooling only. It drives the PRODUCTION ``backfill_runtime.rank4_gate``,
``backfill_jobs.bind_run`` and ``backfill_jobs.cancel_before_vendor`` and
records what Python does: the return value and the queue and item it leaves
behind, or the exception class and message where one escapes. The collaborators
``rank4_gate`` reaches through ``c`` (``iso``, ``ordinary_review_eligible``,
``refresh_backfill_usage``, ``save_queue``) and the module's ``state_event`` are
recording stubs, so the ordered side effects are part of the result. Nothing
touches a real queue, clock, network or host service.

The TypeScript test (``test/adapters/crq/coverageBackfillOracle.test.ts``)
replays the same specs through ``src/adapters/crq/coverageBackfillSeams.ts``.

Regenerate with ``python3.14 coverage_backfill_vectors.py --write`` and verify
with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``, no
timestamps or host paths.
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List
from unittest import mock

import backfill_jobs
import backfill_runtime

SCHEMA = "crq-coverage-backfill-oracle/1"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "crq-coverage-backfill" / "cases.json"
SOURCE_PATH = "apps/crq-python/backfill_runtime.py"
AT = "2026-11-20T12:00:00Z"
OBS_FRESH = "2026-11-20T11:59:30Z"
OBS_STALE = "2026-11-20T11:58:00Z"
OBS_EXPIRED = "2026-11-20T11:55:00Z"


class Trap(AssertionError):
    """A vector referenced something the spec never supplied: a bug in the vector."""


def outcome(fn, *args: Any) -> dict:
    try:
        return {"ok": fn(*args)}
    except Exception as exc:  # noqa: BLE001 - the class name is the oracle
        if isinstance(exc, Trap):
            raise
        return {"raises": type(exc).__name__, "message": str(exc)}


# ------------------------------------------------------------------ builders


def job(item_id: str = "job-a", **extra: Any) -> dict:
    out = {"id": item_id, "job_id": item_id, "kind": "backfill", "state": "pending", "attempt": 0}
    out.update(extra)
    return out


def usage(remaining: Any = 5, observed_at: Any = OBS_FRESH, successful: Any = True, **extra: Any) -> dict:
    out = {"successful": successful, "remaining": remaining, "observed_at": observed_at,
           "reflected_reservations": []}
    out.update(extra)
    return out


def queue(items: list | None = None, **extra: Any) -> dict:
    out: Dict[str, Any] = {"items": items if items is not None else [job()], "starts": []}
    out.update(extra)
    return out


def rank4(name: str, q: dict, *, dry: bool = False, ordinary: bool = False, refresh: Any = None,
          event_mutates: bool = False, index: int = 0) -> dict:
    return {"name": name, "spec": {"fn": "rank4", "queue": q, "index": index, "dry": dry,
                                   "ordinary": ordinary, "refresh": refresh, "now": AT,
                                   "event_mutates": event_mutates}}


def refresh_ok(remaining: Any = 5, observed_at: Any = AT, **extra: Any) -> dict:
    return {"success": True, "usage": usage(remaining, observed_at, **extra)}


REFRESH_FAIL = {"success": False, "usage": None}


# --------------------------------------------------------------------- cases


def rank4_cases() -> List[dict]:
    out: List[dict] = []
    add = out.append
    add(rank4("admits on a fresh observation", queue(backfill_usage=usage(), backfill_reservations={})))
    add(rank4("a dry run admits without reserving", queue(backfill_usage=usage()), dry=True))
    add(rank4("no observation and no refresher is usage-unknown", queue()))
    add(rank4("a refresher that succeeds admits", queue(), refresh=refresh_ok()))
    add(rank4("a refresher that fails keeps no observation", queue(), refresh=REFRESH_FAIL))
    add(rank4("a failed refresh keeps the older observation", queue(backfill_usage=usage(observed_at=OBS_STALE)),
              refresh=REFRESH_FAIL))
    add(rank4("an observation just inside the refresh age is not re-read",
              queue(backfill_usage=usage(observed_at="2026-11-20T11:59:00Z")), refresh=refresh_ok(9)))
    add(rank4("an observation 61 seconds old is re-read",
              queue(backfill_usage=usage(observed_at="2026-11-20T11:58:59Z")), refresh=refresh_ok(9)))
    add(rank4("a probe exactly 60 seconds old still suppresses a refresh",
              queue(backfill_usage_probe_at="2026-11-20T11:59:00Z"), refresh=refresh_ok()))
    add(rank4("a probe 61 seconds old allows a refresh",
              queue(backfill_usage_probe_at="2026-11-20T11:58:59Z"), refresh=refresh_ok()))
    add(rank4("an observation exactly 180 seconds old still admits",
              queue(backfill_usage=usage(observed_at="2026-11-20T11:57:00Z"))))
    add(rank4("an observation 181 seconds old is stale",
              queue(backfill_usage=usage(observed_at="2026-11-20T11:56:59Z"))))
    add(rank4("an observation past the refresh age is re-read",
              queue(backfill_usage=usage(observed_at=OBS_STALE)), refresh=refresh_ok(9)))
    add(rank4("an observation past the admission age is stale",
              queue(backfill_usage=usage(observed_at=OBS_EXPIRED))))
    add(rank4("a recent probe suppresses another refresh",
              queue(backfill_usage_probe_at="2026-11-20T11:59:30Z"), refresh=refresh_ok()))
    add(rank4("an old probe allows a refresh",
              queue(backfill_usage_probe_at="2026-11-20T11:58:00Z"), refresh=refresh_ok()))
    add(rank4("a probe in the future allows a refresh", queue(backfill_usage_probe_at="2026-11-20T12:05:00Z"),
              refresh=refresh_ok()))
    add(rank4("an unparseable probe allows a refresh", queue(backfill_usage_probe_at="not a time"),
              refresh=refresh_ok()))
    add(rank4("a non-string probe allows a refresh", queue(backfill_usage_probe_at=7), refresh=refresh_ok()))
    add(rank4("an unsuccessful observation is re-read", queue(backfill_usage=usage(successful=False)),
              refresh=refresh_ok(8)))
    add(rank4("an empty observation is re-read", queue(backfill_usage={}), refresh=refresh_ok(8)))
    add(rank4("a null observation is re-read", queue(backfill_usage=None), refresh=refresh_ok(8)))
    add(rank4("an unreadable observed_at counts as stale", queue(backfill_usage=usage(observed_at="soon")),
              refresh=refresh_ok(8)))
    add(rank4("an unreadable observed_at without a refresher is invalid",
              queue(backfill_usage=usage(observed_at="soon"))))
    add(rank4("an observation with a missing observed_at is invalid",
              queue(backfill_usage={"successful": True, "remaining": 5})))
    add(rank4("an ordinary eligible queue never refreshes", queue(), ordinary=True, refresh=refresh_ok()))
    add(rank4("ordinary eligibility refuses the rank 4 start", queue(backfill_usage=usage()), ordinary=True))
    add(rank4("one remaining is the one-slot reserve", queue(backfill_usage=usage(remaining=1))))
    add(rank4("two remaining admits", queue(backfill_usage=usage(remaining=2))))
    add(rank4("zero remaining is the one-slot reserve", queue(backfill_usage=usage(remaining=0))))
    add(rank4("a negative remaining is invalid", queue(backfill_usage=usage(remaining=-1))))
    add(rank4("a boolean remaining is invalid", queue(backfill_usage=usage(remaining=True))))
    add(rank4("a string remaining is invalid", queue(backfill_usage=usage(remaining="5"))))
    add(rank4("a float remaining is invalid", queue(backfill_usage=usage(remaining=5.5))))
    add(rank4("ordinary starts since the observation reduce remaining",
              queue(backfill_usage=usage(remaining=4), starts=["a", "b", "c"], backfill_starts_at_observation=1)))
    add(rank4("ordinary starts that exhaust remaining refuse",
              queue(backfill_usage=usage(remaining=3), starts=["a", "b", "c"], backfill_starts_at_observation=1)))
    add(rank4("a checkpoint beyond the starts count never adds quota",
              queue(backfill_usage=usage(remaining=3), starts=["a"], backfill_starts_at_observation=5)))
    add(rank4("a missing checkpoint counts no ordinary starts",
              queue(backfill_usage=usage(remaining=3), starts=["a", "b"])))
    add(rank4("reservations at or after the observation are not ordinary starts",
              queue(backfill_usage=usage(remaining=4, observed_at=OBS_FRESH), starts=["a", "b", "c"],
                    backfill_starts_at_observation=0,
                    backfill_reservations={"x": {"item": "x", "at": OBS_FRESH, "quota_state": "released",
                                                 "vendor_run_id": None},
                                           "y": {"item": "y", "at": "2026-11-20T11:59:45Z",
                                                 "quota_state": "released", "vendor_run_id": None}})))
    add(rank4("an older reservation is still an ordinary start",
              queue(backfill_usage=usage(remaining=4), starts=["a", "b"], backfill_starts_at_observation=0,
                    backfill_reservations={"x": {"item": "x", "at": "2026-11-20T11:00:00Z",
                                                 "quota_state": "released", "vendor_run_id": None}})))
    add(rank4("an unreflected hold spends the effective remaining",
              queue(backfill_usage=usage(remaining=3),
                    backfill_reservations={"x": {"item": "x", "at": "2026-11-20T11:00:00Z",
                                                 "quota_state": "reserved", "vendor_run_id": None}})))
    add(rank4("a reflected hold does not",
              queue(backfill_usage=usage(remaining=3, reflected_reservations=["x"]),
                    backfill_reservations={"x": {"item": "x", "at": "2026-11-20T11:00:00Z",
                                                 "quota_state": "reserved", "vendor_run_id": None}})))
    add(rank4("two in-flight rank 4 jobs hit the cap",
              queue([job(), job("job-b", state="reviewing"), job("job-c", vendor_state="live")],
                    backfill_usage=usage())))
    add(rank4("a coverage item in flight counts towards the cap",
              queue([job(), {"id": "cov", "kind": "coverage", "state": "reviewing"},
                     job("job-c", run={"id": "r"})], backfill_usage=usage())))
    add(rank4("one in-flight job still admits",
              queue([job(), job("job-b", state="launch-unknown")], backfill_usage=usage())))
    add(rank4("a non-rank-4 in-flight item is not counted",
              queue([job(), {"id": "p", "kind": "review", "state": "reviewing"},
                     {"id": "q", "kind": "review", "state": "reviewing"}], backfill_usage=usage())))
    add(rank4("an item with no job_id uses its id", queue([{"id": "plain", "kind": "backfill", "state": "pending"}],
                                                          backfill_usage=usage())))
    add(rank4("the attempt counter continues", queue([job(attempt=3)], backfill_usage=usage())))
    add(rank4("an item with no attempt starts at one",
              queue([{"id": "j", "kind": "backfill", "state": "pending"}], backfill_usage=usage())))
    add(rank4("a second job is admitted by index",
              queue([job(), job("job-b")], backfill_usage=usage()), index=1))
    add(rank4("a state event that records on the queue survives",
              queue(backfill_usage=usage()), event_mutates=True))
    add(rank4("daily capacity increments an existing day",
              queue(backfill_usage=usage(),
                    backfill_daily_capacity={"2026-11-20": {"spare_admissions": 2, "completed_partitions": 1}})))
    add(rank4("daily capacity keeps another day",
              queue(backfill_usage=usage(),
                    backfill_daily_capacity={"2026-11-19": {"spare_admissions": 4, "completed_partitions": 0}})))
    add(rank4("a refresh that succeeds checkpoints the starts count",
              queue(starts=["a", "b"]), refresh=refresh_ok(6)))
    add(rank4("a refresh that succeeds with no starts checkpoints zero", queue(), refresh=refresh_ok(6)))
    add(rank4("a refresh with a probe records the probe time",
              queue(), refresh=REFRESH_FAIL, dry=True))
    add(rank4("admission history is appended", queue(backfill_usage=usage(),
                                                     backfill_admissions=[{"at": "x", "decision": "admit"}])))
    for label, rows in (("a null row", [None]), ("scalar and list rows", [5, [2]]),
                        ("a row object without a decision", [{"at": "t"}])):
        add(rank4(f"admission history with {label} is appended to", queue(backfill_usage=usage(),
                                                                         backfill_admissions=rows)))
    add(rank4("a refusal marks wait_reason and appends history", queue(backfill_usage=usage(remaining=1))))
    add(rank4("a refusal on a dry run leaves no reservation", queue(backfill_usage=usage(remaining=1)), dry=True))
    add(rank4("an item without an id raises KeyError", queue([{"kind": "backfill", "state": "pending"}],
                                                            backfill_usage=usage())))
    add(rank4("a reservation without at raises TypeError",
              queue(backfill_usage=usage(), backfill_reservations={"x": {"item": "x", "quota_state": "released"}})))
    add(rank4("a reservation with a non-string at raises TypeError",
              queue(backfill_usage=usage(), backfill_reservations={"x": {"at": 4, "quota_state": "released"}})))
    add(rank4("reflected_reservations that is not a list is read as a set",
              queue(backfill_usage={"successful": True, "remaining": 5, "observed_at": OBS_FRESH,
                                    "reflected_reservations": "x"},
                    backfill_reservations={"x": {"item": "x", "at": "2026-11-20T11:00:00Z",
                                                 "quota_state": "reserved", "vendor_run_id": None}})))
    add(rank4("a non-dict reservation table raises",
              queue(backfill_usage=usage(), backfill_reservations=[])))
    add(rank4("a refusal on an ordinary eligible dry run", queue(backfill_usage=usage()), ordinary=True, dry=True))
    return out


def vendor_hold(run: Any = None, state: str = "reserved") -> dict:
    return {"item": "job-a", "at": AT, "quota_state": state, "vendor_run_id": run}


def bind_cases() -> List[dict]:
    def case(name: str, q: dict, run_id: Any = "run-1", index: int = 0) -> dict:
        return {"name": name, "spec": {"fn": "bind", "queue": q, "index": index, "run_id": run_id}}

    reserved = job(attempt_id="job-a:1", state="launch-unknown", vendor_state="unknown")
    return [
        case("binds a reserved attempt", queue([reserved], backfill_reservations={"job-a:1": vendor_hold()})),
        case("rebinding the same run is idempotent",
             queue([reserved], backfill_reservations={"job-a:1": vendor_hold("run-1")})),
        case("a different run id conflicts",
             queue([reserved], backfill_reservations={"job-a:1": vendor_hold("run-0")})),
        case("an empty vendor_run_id is rebound",
             queue([reserved], backfill_reservations={"job-a:1": vendor_hold("")})),
        case("a missing reservation table raises KeyError", queue([reserved])),
        case("a missing hold raises KeyError", queue([reserved], backfill_reservations={})),
        case("an item with no attempt_id raises KeyError",
             queue([job()], backfill_reservations={"job-a:1": vendor_hold()})),
        case("a hold with no vendor_run_id raises KeyError",
             queue([reserved], backfill_reservations={"job-a:1": {"item": "job-a", "quota_state": "reserved"}})),
        case("a non-string attempt_id raises KeyError",
             queue([job(attempt_id=7)], backfill_reservations={"job-a:1": vendor_hold()})),
        case("a list attempt_id raises TypeError",
             queue([job(attempt_id=["x"])], backfill_reservations={"job-a:1": vendor_hold()})),
        case("a list attempt_id with no reservation table raises KeyError",
             queue([job(attempt_id=["x"])])),
        case("an object attempt_id with no reservation table raises KeyError",
             queue([job(attempt_id={"k": 1})])),
        case("an object attempt_id raises TypeError",
             queue([job(attempt_id={"k": 1})], backfill_reservations={"job-a:1": vendor_hold()})),
        case("an equal integer run id is idempotent",
             queue([reserved], backfill_reservations={"job-a:1": vendor_hold(5)}), run_id=5),
        case("an equal float run id is idempotent",
             queue([reserved], backfill_reservations={"job-a:1": vendor_hold(5)}), run_id=5.0),
        case("a true run id equals an existing 1",
             queue([reserved], backfill_reservations={"job-a:1": vendor_hold(1)}), run_id=True),
        case("an unequal integer run id conflicts",
             queue([reserved], backfill_reservations={"job-a:1": vendor_hold(5)}), run_id=6),
        case("a null reservation table raises TypeError",
             queue([reserved], backfill_reservations=None)),
        case("binds the second item",
             queue([job(), job("job-b", attempt_id="job-b:1")],
                   backfill_reservations={"job-b:1": {"item": "job-b", "at": AT, "quota_state": "reserved",
                                                      "vendor_run_id": None}}), index=1),
        case("other holds are untouched",
             queue([reserved], backfill_reservations={"job-a:1": vendor_hold(),
                                                      "other": vendor_hold("run-9", "released")})),
        case("an existing run id of any truthy type conflicts",
             queue([reserved], backfill_reservations={"job-a:1": vendor_hold(5)})),
        case("a zero vendor_run_id is rebound",
             queue([reserved], backfill_reservations={"job-a:1": vendor_hold(0)})),
    ]


def cancel_cases() -> List[dict]:
    def case(name: str, q: dict, index: int = 0) -> dict:
        return {"name": name, "spec": {"fn": "cancel", "queue": q, "index": index}}

    held = job(attempt_id="job-a:1", state="launch-unknown", vendor_state="unknown")
    return [
        case("releases the hold and marks the vendor terminal",
             queue([held], backfill_reservations={"job-a:1": vendor_hold()})),
        case("a recorded run refuses", queue([job(attempt_id="job-a:1", run={"id": "r"})],
                                             backfill_reservations={"job-a:1": vendor_hold()})),
        case("an empty run does not refuse", queue([job(attempt_id="job-a:1", run={})],
                                                   backfill_reservations={"job-a:1": vendor_hold()})),
        case("a null run does not refuse", queue([job(attempt_id="job-a:1", run=None)],
                                                 backfill_reservations={"job-a:1": vendor_hold()})),
        case("no reservation table still marks terminal", queue([held])),
        case("an unknown attempt id marks terminal only",
             queue([held], backfill_reservations={"other": vendor_hold()})),
        case("an item with no attempt_id marks terminal only",
             queue([job()], backfill_reservations={"job-a:1": vendor_hold()})),
        case("an empty hold is left untouched", queue([held], backfill_reservations={"job-a:1": {}})),
        case("a non-string attempt id marks terminal only",
             queue([job(attempt_id=7)], backfill_reservations={"job-a:1": vendor_hold()})),
        case("a list attempt id raises TypeError",
             queue([job(attempt_id=["x"])], backfill_reservations={"job-a:1": vendor_hold()})),
        case("a null reservation table raises AttributeError", queue([held], backfill_reservations=None)),
        case("a list reservation table raises AttributeError", queue([held], backfill_reservations=[])),
        case("a string hold raises TypeError",
             queue([held], backfill_reservations={"job-a:1": "reserved"})),
        case("a non-empty list hold raises TypeError",
             queue([held], backfill_reservations={"job-a:1": ["x"]})),
        case("an already released hold stays released",
             queue([held], backfill_reservations={"job-a:1": vendor_hold(None, "released")})),
        case("cancels the second item only",
             queue([job(), job("job-b", attempt_id="job-b:1")],
                   backfill_reservations={"job-b:1": {"item": "job-b", "at": AT, "quota_state": "reserved",
                                                      "vendor_run_id": None}}), index=1),
    ]


# ------------------------------------------------------------------ driver


def run_rank4(spec: dict) -> dict:
    q = spec["queue"]
    item = q["items"][spec["index"]]
    trace: List[list] = []
    refresh = spec["refresh"]

    def refresh_backfill_usage(queue_: dict) -> bool:
        trace.append(["refresh"])
        if refresh["success"]:
            queue_["backfill_usage"] = copy.deepcopy(refresh["usage"])
            queue_["backfill_starts_at_observation"] = len(queue_.get("starts", []))
            return True
        return False

    def save_queue(queue_: dict) -> None:
        trace.append(["save", copy.deepcopy(queue_)])

    def state_event(c: Any, queue_: dict, item_: dict, at: str, reason: str, **_: Any) -> None:
        trace.append(["state_event", item_["id"], at, reason, copy.deepcopy(item_)])
        if spec["event_mutates"]:
            queue_.setdefault("backfill_state_events", {})["k"] = "e1"

    c = SimpleNamespace(iso=lambda: spec["now"], ordinary_review_eligible=lambda queue_: spec["ordinary"],
                        save_queue=save_queue)
    if refresh is not None:
        c.refresh_backfill_usage = refresh_backfill_usage
    with mock.patch.object(backfill_runtime, "state_event", state_event):
        result = outcome(backfill_runtime.rank4_gate, c, q, item, spec["dry"])
    if "ok" in result:
        result = {"ok": {"admitted": result["ok"], "queue": q}}
    result["trace"] = trace
    return result


def run_jobs(spec: dict) -> dict:
    q = spec["queue"]
    item = q["items"][spec["index"]]
    if spec["fn"] == "bind":
        result = outcome(backfill_jobs.bind_run, q, item, spec["run_id"])
    else:
        result = outcome(backfill_jobs.cancel_before_vendor, q, item)
    if "ok" in result:
        result = {"ok": {"queue": q}}
    return result


def run_spec(spec: dict) -> dict:
    spec = copy.deepcopy(spec)
    if spec["fn"] == "rank4":
        return run_rank4(spec)
    if spec["fn"] in ("bind", "cancel"):
        return run_jobs(spec)
    raise Trap("unknown fn " + spec["fn"])


def build() -> dict:
    cases = rank4_cases() + bind_cases() + cancel_cases()
    names = [c["name"] for c in cases]
    if len(names) != len(set(names)):
        raise Trap("duplicate case names")
    return {"schema": SCHEMA, "source": SOURCE_PATH,
            "cases": [{**case, "result": run_spec(case["spec"])} for case in cases]}


def render(document: dict) -> str:
    return json.dumps(document, ensure_ascii=True, indent=1, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit the crq coverage backfill-seam oracle fixture")
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
        print("coverage-backfill fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
