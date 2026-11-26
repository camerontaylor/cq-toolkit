#!/usr/bin/env python3
"""Deterministic offline oracle for the TS coverage effects.

Test tooling only. It drives the PRODUCTION ``coverage._legacy_origins``,
``coverage.legacy_retry_view`` / ``_legacy_retry_allowed``,
``coverage.coverage_candidate`` and ``crq.measure_merged`` (with its helpers
``pr_commit_set``, ``rename_map``, ``synth_paths`` and ``path_exists``) and
records what Python actually does: the return value, or the exception class
and message where Python lets one escape. ``crq.git`` is replaced by a table
lookup keyed by argv (a missing fact raises ``Trap``, a bug in the vector), and
``crq.run`` serves only the ``git cat-file -e`` probe from a fact table.
Nothing touches a real repository, queue, network or host service.

The TypeScript test (``test/queue-runner/coverageEffects.test.ts``) replays the
same specs through ``src/queue-runner/coverageEffects.ts`` and compares the
results and, for ``measure``, the ordered git calls.

Regenerate with ``python3.14 coverage_effects_vectors.py --write`` and verify
with ``--check``. Output is deterministic: sorted keys, ``ensure_ascii``, no
timestamps or host paths.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List
from unittest import mock

import coverage
import crq

SCHEMA = "crq-coverage-effects-oracle/1"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "crq-coverage-effects" / "cases.json"
SOURCE_PATH = "apps/crq-python/coverage.py"
AT = "2026-11-20T12:00:00Z"
MQ = "a" * 40
MERGE = "b" * 40
PARENT = "c" * 40
HEAD2 = "d" * 40


class Trap(AssertionError):
    """A vector referenced a fact the spec never supplied: a bug in the vector."""


# ----------------------------------------------------------------- helpers


def file_row(path: str, now: str | None = None, added: int = 10, surviving: int = 5,
             synthetic_added: int = 12) -> dict:
    return {"path": path, "now": path if now is None else now, "added": added,
            "surviving": surviving, "synthetic_added": synthetic_added}


def merged(item_id: str = "pr-1", pr: Any = 1, files: list | None = None, mq: str = MQ,
           merge: str = MERGE, **extra: Any) -> dict:
    out = {"id": item_id, "kind": "merged", "pr": pr, "state": "done", "merge_commit": merge,
           "measure": {"merge_queue": mq, "synthetic_paths": [],
                       "files": files if files is not None else [file_row("src/a.py")]}}
    out.update(extra)
    return out


def cov_item(item_id: str = "coverage-x", source: Any = "pr-1", paths: list | None = None,
             **extra: Any) -> dict:
    out = {"id": item_id, "kind": "coverage", "state": "pending", "pr": 1, "tier": 4,
           "coverage_source": source, "coverage_paths": paths if paths is not None else ["src/a.py"],
           "cycles": [], "attempts": [], "notes": []}
    out.update(extra)
    return out


def attempt(run_id: str, outcome: str, at: str, counted: bool = False, **extra: Any) -> dict:
    out = {"run_id": run_id, "outcome": outcome, "at": at, "counted": counted,
           "base": "1" * 40, "head": "2" * 40}
    out.update(extra)
    return out


def queue_of(*items: dict, **extra: Any) -> dict:
    out = {"items": list(items)}
    out.update(extra)
    return out


FAMILY = "legacy-coverage:1:src/a.py"


def outcome(fn, *args: Any, **kwargs: Any) -> dict:
    try:
        return {"ok": fn(*args, **kwargs)}
    except Exception as exc:  # noqa: BLE001 - the class name is the oracle
        if isinstance(exc, Trap):
            raise
        return {"raises": type(exc).__name__, "message": str(exc)}


def origins_result(queue: dict, item: dict, reviewed: Any) -> Any:
    source, origins = coverage._legacy_origins(queue, item, reviewed)
    return {"source": source["id"], "origins": sorted(origins)}


# ------------------------------------------------------------ origins specs


def origins_cases() -> list:
    out: list = []

    def add(name: str, queue: dict, item: dict, reviewed: Any = None) -> None:
        out.append({"name": "origins: " + name,
                    "spec": {"fn": "origins", "queue": queue, "item": item, "reviewed": reviewed}})

    src = merged()
    add("explicit source, one path", queue_of(src), cov_item())
    add("explicit source with now different from path",
        queue_of(merged(files=[file_row("old/a.py", now="new/a.py")])),
        cov_item(paths=["new/a.py"]))
    add("measure synthetic_paths join the names",
        queue_of(merged(files=[file_row("src/a.py"), file_row("src/b.py")])),
        cov_item(paths=["src/a.py"], measure={"synthetic_paths": ["src/b.py"]}))
    add("reviewed paths intersect the names",
        queue_of(merged(files=[file_row("src/a.py"), file_row("src/b.py")])),
        cov_item(paths=["src/a.py", "src/b.py"]), ["src/b.py", "other.py"])
    add("reviewed paths empty list gives no origins",
        queue_of(src), cov_item(), [])
    add("no source and no coverage_source: unique inference",
        queue_of(src), cov_item(source=None))
    add("no source field: unique inference",
        queue_of(src), {k: v for k, v in cov_item().items() if k != "coverage_source"})
    add("inference needs every name in one merged item",
        queue_of(merged("pr-1", 1, [file_row("src/a.py")]),
                 merged("pr-2", 2, [file_row("src/a.py")])), cov_item(source=None))
    add("inference ignores a merged item with a null pr",
        queue_of(merged("pr-1", None)), cov_item(source=None))
    add("inference with no names raises", queue_of(src), cov_item(source=None, paths=[]))
    add("unknown coverage_source raises", queue_of(src), cov_item(source="missing"))
    add("a name with two path matches raises",
        queue_of(merged(files=[file_row("x/a.py", now="y/a.py"), file_row("z/a.py", now="y/a.py")])),
        cov_item(paths=["y/a.py"]))
    add("a name matching no file raises", queue_of(src), cov_item(paths=["nope.py"]))
    add("a matching file path with a parent segment raises ValueError",
        queue_of(merged(files=[file_row("../a.py", now="a.py")])), cov_item(paths=["a.py"]))
    add("a matching file path that is empty is skipped, so no match raises",
        queue_of(merged(files=[file_row("", now="a.py")])), cov_item(paths=["a.py"]))
    add("a file without a path key is skipped",
        queue_of(merged(files=[{"now": "a.py"}])), cov_item(paths=["a.py"]))
    add("coverage_paths as a string iterates characters",
        queue_of(merged(files=[file_row("a")])), cov_item(paths="a"))
    add("coverage_paths as an object iterates keys",
        queue_of(merged(files=[file_row("a")])), cov_item(paths={"a": 1}))
    add("coverage_paths null raises TypeError", queue_of(src), cov_item(paths=None))
    add("coverage_paths number raises TypeError", queue_of(src), cov_item(paths=7))
    add("coverage_paths with an unhashable name raises TypeError", queue_of(src), cov_item(paths=[["a"]]))
    add("measure null falls back to empty", queue_of(src), cov_item(paths=[], measure=None))
    add("measure synthetic_paths null raises TypeError", queue_of(src),
        cov_item(paths=[], measure={"synthetic_paths": None}))
    add("source measure null has no files", queue_of(merged(files=[], **{"measure": None})), cov_item())
    add("source files null raises TypeError", queue_of({**src, "measure": {"files": None}}), cov_item())
    add("source files row that is not an object raises",
        queue_of({**src, "measure": {"files": ["x"]}}), cov_item())
    add("queue items null raises TypeError", {"items": None}, cov_item())
    add("queue without items has no source", {}, cov_item())
    add("duplicate source ids pick the first",
        queue_of(merged("dup", 1, [file_row("src/a.py")]), merged("dup", 2, [file_row("src/a.py")])),
        cov_item(source="dup"))
    add("a source with a null merged kind is still a source",
        queue_of({"id": "pr-1", "pr": 5, "measure": {"files": [file_row("src/a.py")]}}), cov_item())
    add("a path that normalizes: double slash and dot",
        queue_of(merged(files=[file_row("src//./a.py", now="src/a.py")])), cov_item(paths=["src/a.py"]))
    add("reviewed paths as a string intersects characters", queue_of(merged(files=[file_row("a")])),
        cov_item(paths="a"), "ab")
    add("reviewed paths number raises TypeError", queue_of(src), cov_item(), 3)
    return out


# ------------------------------------------------------------- retry specs


def retry_cases() -> list:
    out: list = []

    def add(name: str, queue: dict, at: str = AT, pr: Any = 1, path: str = "src/a.py") -> None:
        out.append({"name": "retry: " + name,
                    "spec": {"fn": "retry", "queue": queue, "pr": pr, "path": path, "at": at}})

    src = merged()

    def hist(failures: int = 0, **extra: Any) -> dict:
        return {"failures": failures, **extra}

    add("clean queue is allowed", queue_of(src))
    add("no items at all", {"items": []})
    add("global cooldown in the future", queue_of(src, cooldown_until="2026-11-20T13:00:00Z"))
    add("global cooldown in the past", queue_of(src, cooldown_until="2026-11-20T11:00:00Z"))
    add("global cooldown exactly at", queue_of(src, cooldown_until=AT))
    add("global cooldown invalid string", queue_of(src, cooldown_until="garbage"))
    add("global cooldown naive string", queue_of(src, cooldown_until="2026-11-20T11:00:00"))
    add("global cooldown wrong type", queue_of(src, cooldown_until=5))
    add("global cooldown epoch number is a TypeError path",
        queue_of(src, cooldown_until=[1]))
    add("family next_eligible_at in the future",
        queue_of(src, backfill_families={FAMILY: hist(next_eligible_at="2026-11-21T00:00:00Z")}))
    add("scope next_eligible_at invalid",
        queue_of(src, backfill_scope_failures={FAMILY: hist(next_eligible_at="nope")}))
    add("persisted quarantine blocks",
        queue_of(src, backfill_families={FAMILY: hist(quarantined=True)}))
    add("scope quarantine blocks",
        queue_of(src, backfill_scope_failures={FAMILY: hist(quarantined=True)}))
    add("other family history is ignored",
        queue_of(src, backfill_families={"legacy-coverage:1:other.py": hist(quarantined=True)}))
    add("history with non-int failures",
        queue_of(src, backfill_families={FAMILY: hist("x")}))
    add("history with float failures",
        queue_of(src, backfill_families={FAMILY: {"failures": 1.5}}))
    add("history with a bool failures counts as int-less",
        queue_of(src, backfill_families={FAMILY: {"failures": True}}))
    add("coverage item error attempt backs off one hour",
        queue_of(src, cov_item(attempts=[attempt("r1", "error", "2026-11-20T11:30:00Z")], failures=1,
                               state="blocked")))
    add("one error attempt long ago is allowed",
        queue_of(src, cov_item(attempts=[attempt("r1", "error", "2026-11-19T00:00:00Z")], failures=1,
                               state="blocked")))
    add("three failures back off 4 hours",
        queue_of(src, cov_item(attempts=[attempt("r1", "error", "2026-11-19T01:00:00Z"),
                                         attempt("r2", "interrupted", "2026-11-19T10:00:00Z"),
                                         attempt("r3", "malformed", "2026-11-20T10:00:00Z")],
                               failures=3, state="blocked")))
    add("six failures hit the family limit",
        queue_of(src, cov_item(attempts=[attempt("r%d" % n, "error", "2026-11-1%dT00:00:00Z" % n)
                                         for n in range(1, 7)], failures=6, state="blocked")))
    add("failure aggregate mismatch",
        queue_of(src, cov_item(attempts=[attempt("r1", "error", "2026-11-19T00:00:00Z")], failures=3,
                               state="blocked")))
    add("failure aggregate not an int is ignored",
        queue_of(src, cov_item(attempts=[attempt("r1", "error", "2026-11-19T00:00:00Z")], failures="x",
                               state="blocked")))
    add("failure with unparsable time",
        queue_of(src, cov_item(attempts=[attempt("r1", "error", "bad")], state="blocked", failures=1)))
    add("failure missing run id",
        queue_of(src, cov_item(attempts=[{"outcome": "error", "at": "2026-11-19T00:00:00Z",
                                          "counted": False, "base": "1", "head": "2"}],
                               state="blocked", failures=1)))
    add("failure counted true is incomplete",
        queue_of(src, cov_item(attempts=[attempt("r1", "error", "2026-11-19T00:00:00Z", counted=True)],
                               state="blocked", failures=1)))
    add("failure missing base",
        queue_of(src, cov_item(attempts=[{"run_id": "r1", "outcome": "error", "at": "2026-11-19T00:00:00Z",
                                          "counted": False, "head": "2"}], state="blocked", failures=1)))
    add("unknown attempt outcome",
        queue_of(src, cov_item(attempts=[attempt("r1", "exploded", "2026-11-19T00:00:00Z")])))
    add("attempts null is a TypeError",
        queue_of(src, cov_item(attempts=None)))
    add("terminal state without history",
        queue_of(src, cov_item(state="failed")))
    add("terminal state backed by an adapter run record",
        queue_of(src, cov_item(state="failed"),
                 legacy_coverage_failure_runs={"r9": {"item": "coverage-x", "outcome": "error",
                                                      "origins": ["src/a.py"], "at": "2026-11-19T00:00:00Z"}}))
    add("rate limited with its own deadline",
        queue_of(src, cov_item(attempts=[attempt("r1", "rate_limited", "2026-11-20T10:00:00Z",
                                                 deadline="2026-11-20T14:00:00Z")])))
    add("rate limited deadline in the past",
        queue_of(src, cov_item(attempts=[attempt("r1", "rate_limited", "2026-11-20T10:00:00Z",
                                                 deadline="2026-11-20T11:00:00Z")])))
    add("rate limited without a deadline",
        queue_of(src, cov_item(attempts=[attempt("r1", "rate_limited", "2026-11-20T10:00:00Z")])))
    add("rate limited deadline restored from a quota release",
        queue_of(src, cov_item(attempts=[attempt("r1", "rate_limited", "2026-11-20T10:00:00Z")]),
                 legacy_coverage_quota_releases=[{"family": FAMILY,
                                                  "deadlines": {"r1": "2026-11-20T09:00:00Z"}}]))
    add("rate limited deadline invalid",
        queue_of(src, cov_item(attempts=[attempt("r1", "rate_limited", "2026-11-20T10:00:00Z",
                                                 deadline="garbage")])))
    add("item not_before in the future",
        queue_of(src, cov_item(not_before="2026-11-20T18:00:00Z")))
    add("item not_before invalid",
        queue_of(src, cov_item(not_before="x")))
    add("execution owner state reviewing", queue_of(src, cov_item(state="reviewing")))
    add("execution owner with a run", queue_of(src, cov_item(run={"id": "r"})))
    add("execution owner with unknown vendor state", queue_of(src, cov_item(vendor_state="unknown")))
    add("item without lineage on the same pr",
        queue_of(src, cov_item(source="missing")))
    add("item without lineage on another pr",
        queue_of(src, cov_item(source="missing", pr=2)))
    add("item without lineage and null pr",
        queue_of(src, cov_item(source="missing", pr=None)))
    add("a different pr's source does not matter",
        queue_of(src, merged("pr-2", 2, [file_row("src/a.py")]),
                 cov_item("coverage-y", source="pr-2", pr=2, state="failed")))
    add("a different path on the same pr is ignored",
        queue_of(merged(files=[file_row("src/a.py"), file_row("src/b.py")]),
                 cov_item("coverage-b", paths=["src/b.py"], state="failed")))
    add("non coverage items are skipped", queue_of(src, {"id": "x", "kind": "pr", "state": "failed"}))
    add("verified success cycle resets earlier failures",
        queue_of(src,
                 cov_item(attempts=[attempt("r1", "error", "2026-11-18T00:00:00Z"),
                                    attempt("r2", "completed", "2026-11-19T00:00:00Z", counted=True)],
                          cycles=[{"run_id": "r2", "completed_at": "2026-11-19T00:00:00Z",
                                   "base": "1" * 40, "head": "2" * 40}], failures=1, state="done"),
                 coverage={"runs": {"r2": {"completed_at": "2026-11-19T00:00:00Z",
                                           "paths": ["src/a.py"]}}}))
    add("success cycle without credit is unresolved",
        queue_of(src, cov_item(attempts=[attempt("r2", "completed", "2026-11-19T00:00:00Z", counted=True)],
                               cycles=[{"run_id": "r2", "completed_at": "2026-11-19T00:00:00Z",
                                        "base": "1" * 40, "head": "2" * 40}], state="done")))
    add("success credit time mismatch",
        queue_of(src, cov_item(attempts=[attempt("r2", "completed", "2026-11-19T00:00:00Z", counted=True)],
                               cycles=[{"run_id": "r2", "completed_at": "2026-11-19T00:00:00Z",
                                        "base": "1" * 40, "head": "2" * 40}], state="done"),
                 coverage={"runs": {"r2": {"completed_at": "2026-11-19T00:00:01Z",
                                           "paths": ["src/a.py"]}}}))
    add("success attempt after completion is a chronology conflict",
        queue_of(src, cov_item(attempts=[attempt("r2", "completed", "2026-11-19T00:00:05Z", counted=True)],
                               cycles=[{"run_id": "r2", "completed_at": "2026-11-19T00:00:00Z",
                                        "base": "1" * 40, "head": "2" * 40}], state="done"),
                 coverage={"runs": {"r2": {"completed_at": "2026-11-19T00:00:00Z",
                                           "paths": ["src/a.py"]}}}))
    add("success cycle head mismatch",
        queue_of(src, cov_item(attempts=[attempt("r2", "completed", "2026-11-19T00:00:00Z", counted=True)],
                               cycles=[{"run_id": "r2", "completed_at": "2026-11-19T00:00:00Z",
                                        "base": "1" * 40, "head": "9" * 40}], state="done"),
                 coverage={"runs": {"r2": {"completed_at": "2026-11-19T00:00:00Z",
                                           "paths": ["src/a.py"]}}}))
    add("success credit for a different path does not reset",
        queue_of(merged(files=[file_row("src/a.py"), file_row("src/b.py")]),
                 cov_item(paths=["src/a.py", "src/b.py"],
                          attempts=[attempt("r1", "error", "2026-11-18T00:00:00Z"),
                                    attempt("r2", "completed", "2026-11-19T00:00:00Z", counted=True)],
                          cycles=[{"run_id": "r2", "completed_at": "2026-11-19T00:00:00Z",
                                   "base": "1" * 40, "head": "2" * 40}], failures=1, state="done"),
                 coverage={"runs": {"r2": {"completed_at": "2026-11-19T00:00:00Z",
                                           "paths": ["src/b.py"]}}}))
    add("failure at the same instant as the success is ambiguous",
        queue_of(src,
                 cov_item(attempts=[attempt("r1", "error", "2026-11-19T00:00:00Z"),
                                    attempt("r2", "completed", "2026-11-19T00:00:00Z", counted=True)],
                          cycles=[{"run_id": "r2", "completed_at": "2026-11-19T00:00:00Z",
                                   "base": "1" * 40, "head": "2" * 40}], failures=0, state="done"),
                 coverage={"runs": {"r2": {"completed_at": "2026-11-19T00:00:00Z",
                                           "paths": ["src/a.py"]}}}))
    add("conflicting run identity across attempts",
        queue_of(src, cov_item(attempts=[attempt("r1", "error", "2026-11-19T00:00:00Z"),
                                         attempt("r1", "interrupted", "2026-11-19T01:00:00Z")],
                               state="blocked", failures=2)))
    add("adapter run record matching an item attempt",
        queue_of(src, cov_item(attempts=[attempt("r1", "error", "2026-11-19T00:00:00Z")],
                               state="blocked", failures=1),
                 legacy_coverage_failure_runs={"r1": {"item": "coverage-x", "outcome": "error",
                                                      "origins": ["src/a.py"], "at": "2026-11-19T00:00:00Z"}}))
    add("adapter run record conflicting with the item attempt",
        queue_of(src, cov_item(attempts=[attempt("r1", "error", "2026-11-19T00:00:00Z")],
                               state="blocked", failures=1),
                 legacy_coverage_failure_runs={"r1": {"item": "coverage-x", "outcome": "interrupted",
                                                      "origins": ["src/a.py"], "at": "2026-11-19T00:00:00Z"}}))
    add("adapter run record for an item that is gone",
        queue_of(src, legacy_coverage_failure_runs={"r1": {"item": "ghost", "outcome": "error",
                                                           "origins": ["src/a.py"], "at": AT}}))
    add("adapter run record for another path is skipped",
        queue_of(src, legacy_coverage_failure_runs={"r1": {"item": "ghost", "outcome": "error",
                                                           "origins": ["other.py"], "at": AT}}))
    add("adapter run record whose item has no lineage",
        queue_of(src, cov_item(source="missing"),
                 legacy_coverage_failure_runs={"r1": {"item": "coverage-x", "outcome": "error",
                                                      "origins": ["src/a.py"], "at": AT}}))
    add("adapter run record with a bad time",
        queue_of(src, cov_item(),
                 legacy_coverage_failure_runs={"r1": {"item": "coverage-x", "outcome": "error",
                                                      "origins": ["src/a.py"], "at": "bad"}}))
    add("adapter run record for another pr is skipped",
        queue_of(src, merged("pr-2", 2, [file_row("src/a.py")]),
                 cov_item("coverage-y", source="pr-2", pr=2),
                 legacy_coverage_failure_runs={"r1": {"item": "coverage-y", "outcome": "error",
                                                      "origins": ["src/a.py"], "at": AT}}))
    add("adapter run record origins not a list",
        queue_of(src, legacy_coverage_failure_runs={"r1": {"item": "x", "outcome": "error",
                                                           "origins": "src/a.py", "at": AT}}))

    release_runs = {"r1": ["coverage-x", "error", "2026-11-19T00:00:00Z"]}
    failing = cov_item(attempts=[attempt("r1", "error", "2026-11-19T00:00:00Z")], state="blocked", failures=1)
    add("a matching release clears its failure",
        queue_of(src, failing,
                 backfill_families={FAMILY: hist(1, quarantined=True)},
                 legacy_coverage_releases=[{"family": FAMILY, "at": "2026-11-19T06:00:00Z", "runs": release_runs,
                                            "floors": [1, 0]}]))
    add("a release whose proof no longer matches",
        queue_of(src, failing,
                 legacy_coverage_releases=[{"family": FAMILY, "at": "2026-11-19T06:00:00Z",
                                            "runs": {"r1": ["coverage-x", "interrupted", "2026-11-19T00:00:00Z"]},
                                            "floors": [0, 0]}]))
    add("a release without proofs",
        queue_of(src, failing,
                 legacy_coverage_releases=[{"family": FAMILY, "at": "2026-11-19T06:00:00Z", "runs": {},
                                            "floors": [0, 0]}]))
    add("a release with invalid floors",
        queue_of(src, failing,
                 legacy_coverage_releases=[{"family": FAMILY, "at": "2026-11-19T06:00:00Z", "runs": release_runs,
                                            "floors": [1]}]))
    add("a release with a negative floor",
        queue_of(src, failing,
                 legacy_coverage_releases=[{"family": FAMILY, "at": "2026-11-19T06:00:00Z", "runs": release_runs,
                                            "floors": [-1, 0]}]))
    add("a release with an invalid time",
        queue_of(src, failing,
                 legacy_coverage_releases=[{"family": FAMILY, "at": "x", "runs": release_runs,
                                            "floors": [1, 0]}]))
    add("two releases out of order",
        queue_of(src, failing,
                 legacy_coverage_releases=[
                     {"family": FAMILY, "at": "2026-11-19T06:00:00Z", "runs": release_runs, "floors": [1, 0]},
                     {"family": FAMILY, "at": "2026-11-19T05:00:00Z", "runs": {"r1": release_runs["r1"]},
                      "floors": [1, 0]}]))
    add("a release while counters dropped under the floor",
        queue_of(src, failing,
                 backfill_families={FAMILY: hist(0)},
                 legacy_coverage_releases=[{"family": FAMILY, "at": "2026-11-19T06:00:00Z", "runs": release_runs,
                                            "floors": [1, 0]}]))
    add("a failure older than the release but unproven",
        queue_of(src,
                 cov_item(attempts=[attempt("r1", "error", "2026-11-19T00:00:00Z"),
                                    attempt("r0", "error", "2026-11-18T00:00:00Z")],
                          state="blocked", failures=2),
                 legacy_coverage_releases=[{"family": FAMILY, "at": "2026-11-19T06:00:00Z", "runs": release_runs,
                                            "floors": [1, 0]}]))
    add("an unproven failure coinciding with the release instant",
        queue_of(src,
                 cov_item(attempts=[attempt("r1", "error", "2026-11-19T00:00:00Z"),
                                    attempt("r0", "error", "2026-11-19T06:00:00Z")],
                          state="blocked", failures=2),
                 legacy_coverage_releases=[{"family": FAMILY, "at": "2026-11-19T06:00:00Z", "runs": release_runs,
                                            "floors": [1, 0]}]))
    add("releases of another family are ignored",
        queue_of(src, failing,
                 legacy_coverage_releases=[{"family": "legacy-coverage:1:other.py", "at": AT, "runs": {},
                                            "floors": [0]}]))
    add("quota releases list with a malformed row",
        queue_of(src, legacy_coverage_quota_releases=[{"family": FAMILY}]))
    add("at is a datetime string with an offset", queue_of(src), at="2026-11-20T20:00:00+08:00")
    add("at is naive and raises", queue_of(src), at="2026-11-20T12:00:00")
    add("at is garbage and raises", queue_of(src), at="soon")
    add("pr as a string differs from the source pr", queue_of(src), pr="1")
    add("path with a dot segment is rejected", queue_of(src), path="a/../b.py")
    add("path that is not a string is rejected", queue_of(src), path=None)
    return out


# --------------------------------------------------------- candidate specs


def candidate_cases() -> list:
    out: list = []

    def ledger(paths: dict | None = None, runs: dict | None = None) -> dict:
        return {"schema_version": 1, "paths": paths or {}, "runs": runs or {}, "observations": {}}

    def add(name: str, queue: dict, led: dict | None = None, **kwargs: Any) -> None:
        params = {"merge_queue_sha": MQ, "ordinary_eligible": False, "now": AT}
        params.update(kwargs)
        out.append({"name": "candidate: " + name,
                    "spec": {"fn": "candidate", "queue": queue,
                             "ledger": led if led is not None else ledger(), "params": params}})

    two = merged(files=[file_row("src/a.py"), file_row("src/b.py"), file_row("lib/c.py")])
    add("one merged source, region cut", queue_of(two))
    add("ordinary eligible returns none", queue_of(two), ordinary_eligible=True)
    add("max_paths below 1 raises", queue_of(two), max_paths=0)
    add("negative min_age_hours raises", queue_of(two), min_age_hours=-1)
    add("max_paths bounds the region", queue_of(two), max_paths=1)
    add("never-reviewed beats reviewed",
        queue_of(two), ledger({"src/a.py": {"review_count": 1, "last_reviewed_at": "2026-11-01T00:00:00Z"}}))
    add("oldest review beats newer",
        queue_of(merged(files=[file_row("src/a.py"), file_row("lib/b.py")])),
        ledger({"src/a.py": {"review_count": 1, "last_reviewed_at": "2026-11-10T00:00:00Z"},
                "lib/b.py": {"review_count": 5, "last_reviewed_at": "2026-11-01T00:00:00Z"}}))
    add("fewest reviews breaks a tie on time",
        queue_of(merged(files=[file_row("src/a.py"), file_row("lib/b.py")])),
        ledger({"src/a.py": {"review_count": 4, "last_reviewed_at": "2026-11-01T00:00:00Z"},
                "lib/b.py": {"review_count": 2, "last_reviewed_at": "2026-11-01T00:00:00Z"}}))
    add("path name breaks a full tie",
        queue_of(merged(files=[file_row("src/b.py"), file_row("lib/a.py")])),
        ledger({"src/b.py": {"review_count": 1, "last_reviewed_at": "2026-11-01T00:00:00Z"},
                "lib/a.py": {"review_count": 1, "last_reviewed_at": "2026-11-01T00:00:00Z"}}))
    add("recently reviewed path is skipped by min age",
        queue_of(merged(files=[file_row("src/a.py")])),
        ledger({"src/a.py": {"review_count": 1, "last_reviewed_at": "2026-11-20T00:00:00Z"}}))
    add("review exactly at the age boundary is eligible",
        queue_of(merged(files=[file_row("src/a.py")])),
        ledger({"src/a.py": {"review_count": 1, "last_reviewed_at": "2026-11-19T12:00:00Z"}}))
    add("zero min age allows a fresh review",
        queue_of(merged(files=[file_row("src/a.py")])),
        ledger({"src/a.py": {"review_count": 1, "last_reviewed_at": AT}}), min_age_hours=0)
    add("excluded path by current name", queue_of(two), excluded_paths=["src/a.py"])
    add("excluded path by original name",
        queue_of(merged(files=[file_row("old/a.py", now="new/a.py")])), excluded_paths=["old/a.py"])
    add("invalid excluded path raises", queue_of(two), excluded_paths=["../x"])
    add("stale measure for another merge queue is ignored",
        queue_of(merged(mq="e" * 40)))
    add("a merged item without a merge commit is ignored",
        queue_of(merged(merge=None)))
    add("a file without now is skipped",
        queue_of(merged(files=[{"path": "a.py", "now": None, "synthetic_added": 4}])))
    add("a file without synthetic_added is skipped",
        queue_of(merged(files=[{"path": "a.py", "now": "a.py", "synthetic_added": 0}])))
    add("an outstanding pending coverage item holds the slot",
        queue_of(two, cov_item(state="pending")))
    add("a reviewing coverage item holds the slot", queue_of(two, cov_item(state="reviewing")))
    add("a done coverage item does not hold", queue_of(two, cov_item(state="done")))
    add("a skipped coverage item does not hold", queue_of(two, cov_item(state="skipped")))
    add("a blocked coverage item releases capacity", queue_of(two, cov_item(state="blocked")))
    add("a blocked item that still owns execution holds",
        queue_of(two, cov_item(state="blocked", vendor_state="live")))
    add("a failed item with a run holds", queue_of(two, cov_item(state="failed", run={"id": "x"})))
    add("a quarantined item releases", queue_of(two, cov_item(state="quarantined")))
    add("an unknown state holds", queue_of(two, cov_item(state="weird")))
    repair_cycle = {"run_id": "r1", "completed_at": AT}
    add("repair debt excludes its paths but does not hold",
        queue_of(two, cov_item(state="repairing", cycles=[repair_cycle], coverage_paths=["src/a.py"])),
        ledger(runs={"r1": {"completed_at": AT, "paths": ["src/a.py"]}}))
    add("repair debt excludes measure synthetic paths too",
        queue_of(two, cov_item(state="repair_failed", cycles=[repair_cycle], coverage_paths=[],
                               measure={"synthetic_paths": ["src/b.py"]})),
        ledger(runs={"r1": {"completed_at": AT, "paths": ["src/b.py"]}}))
    add("repair state without ledger credit holds the slot",
        queue_of(two, cov_item(state="repairing", cycles=[repair_cycle])))
    add("repair cycle without completed_at holds the slot",
        queue_of(two, cov_item(state="repairing", cycles=[{"run_id": "r1"}])),
        ledger(runs={"r1": {"completed_at": AT, "paths": []}}))
    add("legacy retry cooldown filters the path",
        queue_of(two, cooldown_until="2026-11-21T00:00:00Z"))
    add("legacy retry unresolved item filters the path",
        queue_of(two, cov_item("coverage-q", source="missing", state="failed")))
    add("a generated id avoids collisions",
        queue_of(two, {"id": "coverage-" + "0" * 16, "kind": "pr", "state": "done"}))
    add("order follows the largest order",
        queue_of({**two, "order": 4}, {"id": "z", "kind": "pr", "state": "done", "order": 9}))
    add("order with a missing order key", queue_of(two))
    add("the same path from two merged sources picks the lower id",
        queue_of(merged("pr-2", 2, [file_row("src/a.py")], merge="9" * 40),
                 merged("pr-1", 1, [file_row("src/a.py")])))
    add("a region keeps only the winning source's paths",
        queue_of(merged("pr-1", 1, [file_row("src/a.py")]),
                 merged("pr-2", 2, [file_row("src/a.py"), file_row("src/b.py")])),
        ledger({"src/a.py": {"review_count": 1, "last_reviewed_at": "2026-11-01T00:00:00Z"}}))
    add("aliases of a renamed path join synthetic paths",
        queue_of(merged(files=[file_row("old/a.py", now="new/a.py"), file_row("older/a.py", now="new/a.py")])))
    add("a root file has the region dot",
        queue_of(merged(files=[file_row("README.md")])))
    add("now as an ISO with offset", queue_of(two), now="2026-11-20T20:00:00+08:00")
    add("now naive raises", queue_of(two), now="2026-11-20T12:00:00")
    add("now as an epoch number", queue_of(two), now=1763640000)
    add("now as bool true is an int", queue_of(two), now=True)
    add("now as a float epoch", queue_of(two), now=1763640000.5)
    add("ledger last_reviewed_at invalid raises",
        queue_of(two), ledger({"src/a.py": {"review_count": 1, "last_reviewed_at": "bad"}}))
    add("ledger entry without count defaults to zero",
        queue_of(merged(files=[file_row("src/a.py"), file_row("lib/b.py")])),
        ledger({"src/a.py": {"last_reviewed_at": "2026-11-01T00:00:00Z"},
                "lib/b.py": {"review_count": 1, "last_reviewed_at": "2026-11-01T00:00:00Z"}}))
    add("measure files null raises TypeError",
        queue_of({**merged(), "measure": {"merge_queue": MQ, "files": None}}))
    add("measure null is skipped", queue_of({**merged(), "measure": None}))
    add("file path with parent segment raises",
        queue_of(merged(files=[file_row("../x.py", now="x.py")])))
    add("file now that is empty is skipped",
        queue_of(merged(files=[{"path": "a.py", "now": "", "synthetic_added": 4}])))
    add("queue without items", {})
    add("ledger without runs raises KeyError when repair debt is checked",
        queue_of(two, cov_item(state="repairing", cycles=[repair_cycle])), {"paths": {}})
    add("ledger without paths raises KeyError when a choice is scored",
        queue_of(two), {"runs": {}})
    add("excluded_paths as a string iterates characters", queue_of(two), excluded_paths="a")
    add("many files bound by max_paths 8",
        queue_of(merged(files=[file_row("d/f%02d.py" % n) for n in range(12)])))
    add("merge queue sha drives the token", queue_of(two), merge_queue_sha="f" * 40)
    add("unicode path hashes as utf-8",
        queue_of(merged(files=[file_row("src/é.py"), file_row("src/ü.py")])))
    return out


# -------------------------------------------------------------- measure specs


def repo(**over: Any) -> dict:
    """A fake repository model; every git answer is derived from it."""
    base = {
        "default_ref_sha": MQ,
        "pr_commits": ["1" * 40, "2" * 40],
        "merge_sha": MERGE,
        "numstat": [["10", "2", "src/a.py"], ["4", "0", "docs/x.md"]],
        "namestatus": [["M", "src/a.py"], ["A", "docs/x.md"]],
        "renames": [],
        "exists": {"src/a.py": True, "docs/x.md": True},
        "blame": {"src/a.py": ["1" * 40, "2" * 40, "9" * 40], "docs/x.md": ["1" * 40]},
        "synth": {"src/a.py": "20", "docs/x.md": "4"},
        "raw": {},
        "fail": [],
    }
    base.update(over)
    return base


def measure_cases() -> list:
    out: list = []

    def add(name: str, model: dict, target: Any = MQ, item: dict | None = None,
            config: dict | None = None) -> None:
        out.append({"name": "measure: " + name,
                    "spec": {"fn": "measure", "item": item if item is not None else {"id": "pr-1", "merge_commit": MERGE},
                             "target": target, "repo": model, "config": config or {}}})

    add("baseline survival and focus", repo())
    add("explicit default target uses rev-parse", repo(), target=None)
    add("a removed file with no rename has no survivors", repo(exists={"src/a.py": False, "docs/x.md": True}))
    add("a renamed file is blamed at its new path",
        repo(exists={"src/a.py": False, "docs/x.md": True}, renames=[["R90", "src/a.py", "src/z.py"]],
             blame={"src/z.py": ["1" * 40, "1" * 40], "docs/x.md": ["1" * 40]},
             synth={"src/z.py": "5", "docs/x.md": "4"}))
    add("binary and zero-add numstat rows are dropped",
        repo(numstat=[["-", "-", "img.png"], ["0", "3", "gone.py"]], namestatus=[["M", "img.png"], ["D", "gone.py"]],
             synth={}))
    add("an empty diff has no survival ratio", repo(numstat=[], namestatus=[], synth={}))
    add("a binary synthetic row counts as zero", repo(synth={"src/a.py": "-", "docs/x.md": "4"}))
    add("low focus excludes the path", repo(synth={"src/a.py": "100", "docs/x.md": "4"}))
    add("custom merged_min_file_focus", repo(), config={"merged_min_file_focus": 0.9})
    add("zero focus threshold", repo(), config={"merged_min_file_focus": 0})
    add("surviving is clamped to added",
        repo(numstat=[["1", "0", "src/a.py"]], namestatus=[["M", "src/a.py"]], synth={"src/a.py": "3"}))
    add("a non-numeric added count raises ValueError", repo(numstat=[["x", "1", "src/a.py"]]))
    add("a numstat row with two fields raises ValueError", repo(raw={"numstat": "10\tsrc/a.py"}))
    add("a path containing a tab keeps its tail",
        repo(numstat=[["10", "2", "src/a b\tc.py"]], namestatus=[["M", "src/a b\tc.py"]],
             exists={"src/a b\tc.py": True}, blame={"src/a b\tc.py": ["1" * 40]}, synth={"src/a b\tc.py": "1"}))
    add("rename rows with the wrong field count are ignored",
        repo(raw={"renames": "R100\tsrc/a.py\tsrc/z.py\nbroken\nR1\ta\tb\tc"}, synth={"src/a.py": "20", "src/z.py": "5", "docs/x.md": "4"}))
    add("a name-status row without a tab raises IndexError", repo(raw={"namestatus": "M\tsrc/a.py\n\tbad".replace("\n\tbad", "\nbad")}))
    add("a git failure propagates", repo(fail=["rev-list"]))
    add("an empty blame yields zero survivors", repo(blame={"src/a.py": [], "docs/x.md": []}))
    add("blame header regex is strict",
        repo(raw={"blame:src/a.py": "\n".join(["1" * 40 + " 1 1", ("1" * 40).upper() + " 2 2", "1" * 39 + " 3 3",
                                               "1" * 40 + "x 4 4", " " + "1" * 40 + " 5 5", "2" * 40 + " 6 7",
                                               "1" * 40 + " 8"])}))
    add("an empty PR commit list keeps the merge commit only", repo(pr_commits=[]))
    add("a duplicated path appears twice in files",
        repo(numstat=[["10", "2", "src/a.py"], ["10", "2", "src/a.py"]], namestatus=[["M", "src/a.py"]]))
    add("documents only",
        repo(numstat=[["10", "2", "docs/x.md"], ["3", "0", "notes.txt"]],
             namestatus=[["M", "docs/x.md"], ["A", "notes.txt"]], exists={"docs/x.md": True, "notes.txt": True},
             blame={"docs/x.md": ["1" * 40], "notes.txt": ["1" * 40]}, synth={"docs/x.md": "4", "notes.txt": "3"}))
    add("is_doc: docs prefix and mdx suffix with files gone",
        repo(numstat=[["10", "2", "docs/x.py"], ["3", "0", "y.mdx"]], namestatus=[["M", "docs/x.py"], ["A", "y.mdx"]],
             exists={"docs/x.py": False, "y.mdx": False}, synth={}))
    add("a non-ascii path",
        repo(numstat=[["7", "0", "src/\u00e9.py"]], namestatus=[["M", "src/\u00e9.py"]], exists={"src/\u00e9.py": True},
             blame={"src/\u00e9.py": ["1" * 40]}, synth={"src/\u00e9.py": "7"}))
    add("item without merge_commit raises KeyError", repo(), item={"id": "x"})
    add("a rename target also present as a changed name",
        repo(renames=[["R100", "src/a.py", "docs/x.md"]], exists={"src/a.py": False, "docs/x.md": True}))
    return out


# ------------------------------------------------------------------ driver


class Recorder:
    """Answers git/cat-file from a repository model and records ordered calls."""

    def __init__(self, model: dict) -> None:
        self.m = model
        self.calls: List[List[str]] = []

    def _rows(self, rows: list) -> str:
        return "\n".join("\t".join(r) for r in rows)

    def git(self, *args: str, **kwargs: Any) -> str:
        self.calls.append(list(args))
        m = self.m
        if args[0] in m["fail"]:
            raise RuntimeError("git " + args[0] + " failed")
        if args[0] == "rev-parse":
            return m["default_ref_sha"] if args[1] != m["merge_sha"] else m["merge_sha"]
        if args[0] == "rev-list":
            return "\n".join(m["pr_commits"])
        if args[:2] == ("diff", "-M50%"):
            return m["raw"]["renames"] if "renames" in m["raw"] else self._rows(m["renames"])
        if args[:3] == ("diff", "--name-status", "--no-renames"):
            return m["raw"]["namestatus"] if "namestatus" in m["raw"] else self._rows(m["namestatus"])
        if args[:3] == ("diff", "--numstat", "--no-renames"):
            if args[4] == m["merge_sha"] and len(args) == 5:
                return m["raw"]["numstat"] if "numstat" in m["raw"] else self._rows(m["numstat"])
            paths = list(args[args.index("--") + 1:])
            return "\n".join("\t".join([m["synth"][p], "0", p]) for p in paths if p in m["synth"])
        if args[0] == "blame":
            path = args[-1]
            key = "blame:" + path
            if key in m["raw"]:
                return m["raw"][key]
            return "".join("%s %d %d\n\tline\n" % (sha, n + 1, n + 1) for n, sha in enumerate(m["blame"].get(path, [])))
        raise Trap("unexpected git " + json.dumps(list(args)))

    def run(self, cmd: List[str], **kwargs: Any) -> subprocess.CompletedProcess:
        if cmd[:3] != ["git", "cat-file", "-e"]:
            raise Trap("unexpected run " + json.dumps(cmd))
        path = cmd[3].partition(":")[2]
        self.calls.append(["cat-file", cmd[3]])
        if path not in self.m["exists"]:
            raise Trap("no exists fact for " + path)
        return subprocess.CompletedProcess(cmd, 0 if self.m["exists"][path] else 128, "", "")


def run_spec(spec: dict) -> dict:
    fn = spec["fn"]
    spec = copy.deepcopy(spec)
    if fn == "origins":
        return outcome(origins_result, spec["queue"], spec["item"], spec["reviewed"])
    if fn == "retry":
        return outcome(lambda: coverage.legacy_retry_view(spec["queue"], spec["pr"], spec["path"], spec["at"]))
    if fn == "candidate":
        params = spec["params"]
        result = outcome(lambda: coverage.coverage_candidate(spec["queue"], spec["ledger"], **params))
        return result
    if fn == "measure":
        rec = Recorder(spec["repo"])
        patches = [mock.patch.object(crq, "git", rec.git), mock.patch.object(crq, "run", rec.run),
                   mock.patch.object(crq, "iso", lambda t=None: "2026-11-20T12:00:00Z")]
        config = dict(crq.CONFIG)
        config.pop("merged_min_file_focus", None)
        config.update(spec["config"])
        patches.append(mock.patch.object(crq, "CONFIG", config))
        for p in patches:
            p.start()
        try:
            result = outcome(crq.measure_merged, spec["item"], spec["target"])
        finally:
            for p in reversed(patches):
                p.stop()
        result["calls"] = rec.calls
        return result
    raise Trap("unknown fn " + fn)


def build() -> dict:
    cases = origins_cases() + retry_cases() + candidate_cases() + measure_cases()
    names = [c["name"] for c in cases]
    if len(names) != len(set(names)):
        raise Trap("duplicate case names")
    return {"schema": SCHEMA, "source": SOURCE_PATH,
            "cases": [{**case, "result": run_spec(case["spec"])} for case in cases]}


def render(document: dict) -> str:
    return json.dumps(document, ensure_ascii=True, indent=1, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit the crq coverage-effects oracle fixture")
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
        print("coverage-effects fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
