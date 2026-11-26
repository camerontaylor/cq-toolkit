#!/usr/bin/env python3
"""Compare a TypeScript `crq.js tick --dry-run` plan with the Python oracle.

Read-only shadow for the S6 tick/slot port (docs/crq/tick-slot-shadow-procedure.md).
The TypeScript dry run implements only the scheduling pass, so this compares
exactly what that pass reports: the admission gate, detached-run liveness,
load-time normalization, the pending start order and the background turn.

Both sides read the SAME frozen runner root (a copy of `config.json` and
`state/`). The Python side imports the given `crq.py` tree from a scratch copy
whose `state` is a symlink to the frozen state, so nothing it could write can
reach live state. The clock is pinned to the TypeScript plan's `last_tick`, and
by default the vendor usage observation is the one the TypeScript run read, so
a difference is a decision difference, not a timing one.

Exit codes: 0 identical, 1 differences found, 2 usage or input error.
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import datetime as dt
import hashlib
import importlib
import json
import shutil
import sys
import tempfile
from pathlib import Path

CANDIDATE_LIMIT = 50
INCOMPLETE_PREFIX = "tick effects not implemented: "


class CompareError(Exception):
    """An unusable input: the comparison cannot run."""


def _digest(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def _load_plan(path: Path) -> dict:
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise CompareError(f"unreadable TypeScript plan: {exc}") from exc
    if not isinstance(plan, dict) or plan.get("command") != "tick":
        raise CompareError("not a tick shadow plan")
    value = plan.get("value")
    if not isinstance(value, dict) or value.get("complete") is not False:
        raise CompareError("plan value must be the incomplete scheduling plan")
    return plan


def _pinned_now(plan: dict) -> dt.datetime:
    for mutation in plan.get("mutations") or []:
        if isinstance(mutation, dict) and mutation.get("target") == "queue.json#/last_tick":
            stamp = mutation.get("value")
            try:
                return dt.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
            except (TypeError, ValueError) as exc:
                raise CompareError(f"malformed last_tick mutation: {stamp!r}") from exc
    raise CompareError("plan has no last_tick mutation to pin the clock")


@contextlib.contextmanager
def _oracle(python_root: Path, runner_root: Path, scratch: Path):
    """Import `crq` from a scratch copy whose config and state are the frozen root's."""
    shim = scratch / "py"
    shim.mkdir(parents=True)
    for source in python_root.iterdir():
        if source.suffix == ".py" and source.is_file():
            shutil.copy2(source, shim / source.name)
        elif source.is_dir() and (source / "__init__.py").is_file():
            shutil.copytree(source, shim / source.name,
                            ignore=shutil.ignore_patterns("__pycache__", "test_*"))
    shutil.copy2(runner_root / "config.json", shim / "config.json")
    (shim / "state").symlink_to((runner_root / "state").resolve(), target_is_directory=True)
    # A process that already imported crq (or any module the shim shadows) would
    # hand back that cached copy, bound to ITS root and state. Hide every shadowed
    # module for the import and restore them afterwards.
    shadowed = {path.stem if path.suffix == ".py" else path.name for path in shim.iterdir()}
    hidden = {name: sys.modules.pop(name) for name in list(sys.modules)
              if name.split(".")[0] in shadowed}
    saved_path = list(sys.path)
    saved_modules = set(sys.modules)
    sys.path.insert(0, str(shim))
    try:
        crq = importlib.import_module("crq")
        if Path(crq.__file__).resolve().parent != shim.resolve():
            raise CompareError(f"crq imported from {crq.__file__}, not the shim")
        yield crq
    finally:
        sys.path[:] = saved_path
        for name in set(sys.modules) - saved_modules:
            del sys.modules[name]
        sys.modules.update(hidden)


def python_plan(crq, now: dt.datetime, usage_override=None, use_override: bool = False) -> dict:
    """The scheduling-pass fields `buildTickPlan` reports, from the Python runner."""
    crq.now = lambda: now
    raw = json.loads(crq.QUEUE.read_text(encoding="utf-8"))
    boosts = sum(1 for item in raw.get("items", []) if isinstance(item, dict)
                 and item.get("kind") != "promotion" and "boost" in item)
    q = crq.load_queue()
    # load_queue retires superseded open-cycle debt to `done`; match by id so an
    # in-memory admission-history compaction cannot misalign the comparison.
    states = {item.get("id"): item.get("state") for item in raw.get("items", [])
              if isinstance(item, dict)}
    retired = [item["id"] for item in crq.live_items(q)
               if item.get("state") == "done" and states.get(item.get("id")) in ("pending", "blocked")]

    harvest = {"alive": [], "ambiguous": [], "harvestable": []}
    for item in crq.live_items(q):
        if item["state"] != "reviewing" or not item.get("run"):
            continue
        run = item["run"]
        rdir = crq.RUNS / run["run_id"]
        state = crq.run_liveness(rdir, item, run, (rdir / "exit.json").exists())
        harvest["harvestable" if state == "harvest" else state].append(item["id"])

    if use_override:
        crq.usage_slots.read_usage = lambda clone: copy.deepcopy(usage_override)
    probe = copy.deepcopy(q)
    usage, reserved = crq.read_slot_usage(probe)

    # The gate and its log come from Python's own admit_available, with the
    # launch and backfill accounting stubbed out: no start can happen.
    crq.start_one = lambda *a, **kw: (None, False)
    crq.backfill_runtime.usage_context = lambda *a, **kw: None
    log: list = []
    _, gate, slots = crq.admit_available(copy.deepcopy(probe), usage, log, dry=True, reserved=reserved)
    inflight = len(crq.inflight(probe))
    admissions = min(slots, crq.CONFIG.get("max_starts_per_tick", 10),
                     max(0, crq.CONFIG.get("max_inflight", 10) - inflight))

    pending = sorted((i for i in crq.live_items(q) if i["state"] == "pending"), key=crq.sort_key)
    candidates = [{"id": i.get("id", ""), "kind": i.get("kind"), "rank": crq.rank(i),
                   "order": i.get("order", 999), "operatorPriority": bool(i.get("operator_priority"))}
                  for i in pending[:CANDIDATE_LIMIT]]
    return {
        "admission": {"usage": usage, "reserved": list(reserved), "slots": slots,
                      "admissions": admissions, "gate": gate, "inflight": inflight,
                      "startsLastHour": crq.starts_last_hour(probe), "log": log},
        "harvest": harvest,
        "normalized": {"retired": retired, "boostsDropped": boosts},
        "candidates": candidates,
        "backgroundTurn": crq.background_turn(q),
    }


FIELDS = (
    ("admission", "usage"), ("admission", "reserved"), ("admission", "slots"),
    ("admission", "admissions"), ("admission", "gate"), ("admission", "inflight"),
    ("admission", "startsLastHour"), ("admission", "log"),
    ("harvest", "alive"), ("harvest", "ambiguous"), ("harvest", "harvestable"),
    ("normalized", "retired"), ("normalized", "boostsDropped"),
    ("candidates",), ("backgroundTurn",),
)


def _field(value: dict, path: tuple):
    for key in path:
        value = value.get(key) if isinstance(value, dict) else None
    return value


def compare(python: dict, ts: dict) -> list:
    return [{"field": ".".join(path), "python": _field(python, path), "ts": _field(ts, path)}
            for path in FIELDS if _field(python, path) != _field(ts, path)]


def run(python_root: Path, runner_root: Path, plan_path: Path, scratch: Path,
        live_usage: bool = False) -> dict:
    plan = _load_plan(plan_path)
    ts = plan["value"]
    queue = runner_root / "state" / "queue.json"
    before = _digest(queue)
    # The marker is read before anything else and compared with the TypeScript
    # result either way: Python's tick() returns at once when it exists.
    marker = (runner_root / "state" / "runner-disabled").exists()
    ts_disabled = ts.get("disabled") is True
    if marker or ts_disabled:
        diffs = [] if marker == ts_disabled else [{"field": "disabled", "python": marker, "ts": ts_disabled}]
        return {"identical": not diffs, "disabled": marker, "diffs": diffs}
    if not str(ts.get("reason", "")).startswith(INCOMPLETE_PREFIX):
        raise CompareError("plan reason is not the incomplete-effects reason")
    now = _pinned_now(plan)
    usage = (ts.get("admission") or {}).get("usage")
    with _oracle(python_root, runner_root, scratch) as crq:
        python = python_plan(crq, now, usage_override=usage, use_override=not live_usage)
    if _digest(queue) != before:
        raise CompareError("frozen queue.json changed during the comparison")
    diffs = compare(python, ts)
    return {"identical": not diffs, "pinned_now": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "usage_source": "live" if live_usage else "ts-plan",
            "missing_effects": ts["reason"][len(INCOMPLETE_PREFIX):].split("; "),
            "diffs": diffs}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="tick_shadow_compare", description=__doc__.splitlines()[0])
    parser.add_argument("--python-root", required=True, type=Path,
                        help="the deployed crq-python tree whose crq.py is the oracle (read only)")
    parser.add_argument("--runner-root", required=True, type=Path,
                        help="the FROZEN runner root copy: config.json and state/")
    parser.add_argument("--ts-plan", required=True, type=Path,
                        help="the shadow/<uuid>.json the TypeScript dry run wrote")
    parser.add_argument("--live-usage", action="store_true",
                        help="probe vendor usage again instead of reusing the plan's observation")
    args = parser.parse_args(argv)
    if args.python_root.resolve() == args.runner_root.resolve():
        print(json.dumps({"error": "runner root must be a frozen copy, not the python root"}))
        return 2
    with tempfile.TemporaryDirectory(prefix="tick-shadow-") as scratch:
        try:
            result = run(args.python_root, args.runner_root, args.ts_plan, Path(scratch),
                         live_usage=args.live_usage)
        except CompareError as exc:
            print(json.dumps({"error": str(exc)}))
            return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["identical"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
