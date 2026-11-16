#!/usr/bin/env python3
"""Deterministic B1 vectors for the publisher's two daemon phases.

Test tooling only: importing this module has no runtime effect and crq never
imports it. It drives the real ``review_notify`` decisions and the real
``backfill_coverage`` refresh/run control flow with injected fakes, then records
the exact selected rows, delivered messages, queue documents, snapshot
outcomes and refresher results. The TypeScript replay
(``src/policy/crq/notifyDrain.ts``, ``src/policy/crq/coverageSnapshot.ts``,
``src/ops/crq/notifyDrain.ts``, ``src/ops/crq/coverageRefresh.ts``) compares
against this oracle at the same commit.

Every value is public and synthetic. No filesystem path, host, credential,
process id or wall-clock instant is recorded: the drain clock is a fixed
instant, git is never invoked, and the tokenizer never emits a path. Both the
notify and the coverage phases run in ``tempfile`` directories whose names never
enter a vector, so regeneration is byte-identical on every host and Python
patch level.

Regenerate with ``python3 notify_coverage_vector_emit_b1.py --write`` and verify
with ``--check``. ``--stdout`` prints the whole document for the determinism
test.
"""
from __future__ import annotations

import argparse
import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tempfile
from typing import Any, Dict, List, Optional

import backfill_coverage as coverage
import backfill_jobs as jobs
import backfill_publisher
import backfill_runtime as runtime
import ledger_vector_emit_b1 as base
import review_notify
import usage_slots

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "crq-notify-coverage-b1" / "vectors.json"
SCHEMA = "cq.crq-notify-coverage-b1-vector/v1"

NOW = datetime(2026, 11, 14, 12, 0, 0, tzinfo=timezone.utc)
NOW_ISO = NOW.isoformat()
TARGET = base.SHA
TARGET_OTHER = "b" * 40
HEAD = "d" * 40
AGENT = "11111111-2222-3333-4444-555555555555"
CONFIG = {"notify": {"hosts": ["alpha", "beta", None]}, "error_backoff_min": 5}


def review(event_id: str, *, target: Optional[str] = None, lines: Optional[List[List[int]]] = None) -> Dict[str, Any]:
    """A schema-valid creditable review record, built by the ledger oracle."""
    rows = [{"path": "src/app.ts", "blob": base.SHA, "intervals": lines or [[1, 2]]}]
    overrides: Dict[str, Any] = {
        "requested_scope": copy.deepcopy(rows),
        "input_scope": copy.deepcopy(rows),
        "reviewed_scope": copy.deepcopy(rows),
        "scope_digest": base.ledger.digest(rows),
        "paths": [{"path": "src/app.ts", "blob": base.SHA, "mode": "100644",
                   "disposition": "included", "reason": "verified", "baseline": {}}],
    }
    if target is not None:
        overrides["target"] = target
    return base._review(source=event_id, **overrides)


def state_event(event_id: str) -> Dict[str, Any]:
    """A schema-valid, non-creditable job-state record."""
    return base._job_state(job_id="fixture:" + event_id)


def outbox_row(key: str, **overrides: Any) -> Dict[str, Any]:
    row = {
        "v": 1,
        "request_id": "req-1",
        "event_id": "ev-1",
        "destination": {"paseo_agent_id": AGENT, "paseo_host": "alpha"},
        "state": "pending",
        "receipt_id": "r-ev-1",
    }
    row.update(overrides)
    return {key: row}


def queue_of(outbox: Dict[str, Any], events: Optional[Dict[str, Any]] = None,
             requests: Optional[Dict[str, Any]] = None,
             items: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    request = {"item": "item", "notify": {"paseo_agent_id": AGENT, "paseo_host": "alpha"}}
    request.update(requests or {})
    return {
        "items": items if items is not None else [{"id": "item", "observers": []}],
        "review_requests": {"req-1": request},
        "review_events": events if events is not None else {"ev-1": {
            "item": "item", "state": "reviewed", "receipt_id": "r-ev-1"}},
        "review_notify_outbox": outbox,
    }


class NotifyCtx:
    """Python's ``crq`` context, reduced to what ``review_notify.drain`` reads."""

    def __init__(self, root: Path, queue: Dict[str, Any], config: Dict[str, Any],
                 replies: Optional[List[Any]] = None, busy: Optional[List[str]] = None):
        self.STATE = root
        self.CONFIG = config
        self.queue = copy.deepcopy(queue)
        self.replies = list(replies or [])
        self.busy = list(busy or [])
        self.sent: List[Dict[str, Any]] = []
        self.saves = 0

    def load_queue(self) -> Dict[str, Any]:
        return copy.deepcopy(self.queue)

    def save_queue(self, q: Dict[str, Any]) -> None:
        self.saves += 1
        self.queue = copy.deepcopy(q)

    def with_lock(self, fn, lock_wait=0):
        # Scripted contention: one entry per lock acquisition ("fn" runs the
        # callback, "busy" is Python's None), in the drain's own order: select,
        # then each row's still-current check, then its reconcile.
        if self.busy and self.busy.pop(0) == "busy":
            return None
        return fn()

    def notify(self, destination, text):
        self.sent.append({"destination": copy.deepcopy(destination), "message": text})
        reply = self.replies.pop(0) if self.replies else {"paseo_send": 0}
        if isinstance(reply, Exception):
            raise reply
        return reply


def notify_case(name: str, source: str, queue: Dict[str, Any], config: Dict[str, Any],
                replies: Optional[List[Any]] = None, busy: Optional[List[str]] = None) -> Dict[str, Any]:
    with tempfile.TemporaryDirectory() as directory:
        ctx = NotifyCtx(Path(directory), queue, config, replies, busy)
        selected = review_notify.drain(ctx, now=NOW)
        return {
            "input": {"queue": queue, "config": config,
                      "replies": [r if not isinstance(r, Exception) else {"raised": True} for r in (replies or [])],
                      "busy": busy or []},
            "expect": {
                "selected": selected,
                "sent": ctx.sent,
                "queue": ctx.queue,
                "saves": ctx.saves,
            },
            "name": name,
            "source": source,
        }


def notify_family() -> List[Dict[str, Any]]:
    cases: List[Dict[str, Any]] = []
    accepted = {"paseo_agent_id": AGENT, "paseo_host": "alpha"}
    for name, value, config in [
        ("listed-host", accepted, CONFIG),
        ("listed-null-host", {"paseo_agent_id": AGENT, "paseo_host": None}, CONFIG),
        ("unlisted-host", {"paseo_agent_id": AGENT, "paseo_host": "gamma"}, CONFIG),
        ("extra-key", {**accepted, "extra": 1}, CONFIG),
        ("missing-host-key", {"paseo_agent_id": AGENT}, CONFIG),
        ("uppercase-agent", {"paseo_agent_id": AGENT.upper(), "paseo_host": "alpha"}, CONFIG),
        ("dash-host", {"paseo_agent_id": AGENT, "paseo_host": "-alpha"}, {"notify": {"hosts": ["-alpha"]}}),
        ("bad-host-grammar", {"paseo_agent_id": AGENT, "paseo_host": "alpha beta"}, {"notify": {"hosts": ["alpha beta"]}}),
        ("malformed-section", accepted, {"notify": []}),
        ("hosts-not-list", accepted, {"notify": {"hosts": "alpha"}}),
        ("not-object", [], CONFIG),
    ]:
        cases.append({
            "name": name,
            "source": "review_notify.destination/review_notify.validation",
            "input": {"value": value, "config": config},
            "expect": {
                "destination": review_notify.destination(value, config),
                "validation": review_notify.validation(value, config),
                "validation_optional": review_notify.validation(value, config, required=False),
            },
        })
    row = {"request_id": "req-1", "event_id": "ev-1", "receipt_id": "r-ev-1"}
    event = {"item": "item", "state": "reviewed"}
    cases.append({
        "name": "message-shape",
        "source": "review_notify.message",
        "input": {"row": row, "event": event},
        "expect": {"message": review_notify.message(row, event)},
    })
    due = outbox_row("k-due")
    cases.append(notify_case(
        "drain-delivers",
        "review_notify.drain",
        queue_of({**due, **outbox_row("k-pending-later", next_at=(NOW + timedelta(minutes=1)).isoformat()),
                  **outbox_row("k-sent", state="sent")}),
        CONFIG,
    ))
    cases.append(notify_case(
        "drain-failure-backoff",
        "review_notify.drain",
        queue_of(outbox_row("k-due")),
        CONFIG,
        replies=[{"paseo_send": "1: boom"}],
    ))
    cases.append(notify_case(
        "drain-terminal-attempt",
        "review_notify.drain",
        queue_of(outbox_row("k-due", attempts=4)),
        CONFIG,
        replies=[{"paseo_send": "1: boom"}],
    ))
    cases.append(notify_case(
        "drain-unsupported-destination",
        "review_notify.drain",
        queue_of(outbox_row("k-due")),
        {"notify": {"hosts": []}, "error_backoff_min": 5},
    ))
    cases.append(notify_case(
        "drain-transport-raises",
        "review_notify.drain",
        queue_of(outbox_row("k-due")),
        CONFIG,
        replies=[RuntimeError("transport down")],
    ))
    many = {}
    for index in range(6):
        many.update(outbox_row(f"k-{index}"))
    cases.append(notify_case("drain-limit", "review_notify.drain", queue_of(many), CONFIG))
    cases.append(notify_case(
        "drain-busy-selection",
        "review_notify.drain",
        queue_of(outbox_row("k-due")),
        CONFIG,
        busy=["busy"],
    ))
    cases.append(notify_case(
        "drain-busy-reconcile",
        "review_notify.drain",
        queue_of(outbox_row("k-due")),
        CONFIG,
        busy=["fn", "fn", "busy"],
    ))
    cases.append(notify_case(
        "drain-backoff-fractional",
        "review_notify.drain",
        queue_of(outbox_row("k-due")),
        {"notify": {"hosts": ["alpha"]}, "error_backoff_min": 0.0000001},
        replies=[{"paseo_send": 1}],
    ))
    cases.append(notify_case(
        "drain-backoff-cap",
        "review_notify.drain",
        queue_of(outbox_row("k-due", attempts=7)),
        {"notify": {"hosts": ["alpha"]}, "error_backoff_min": 60},
        replies=[{"paseo_send": 1}],
    ))
    return cases


class FakeRepo:
    """``backfill_accounting.Repository``'s coverage surface, scripted."""

    def __init__(self, script: Optional[Dict[str, Any]] = None, gap: Optional[Dict[str, Any]] = None):
        self.script = script or {}
        self.gap = gap
        self.calls: List[Any] = []

    def begin_invocation(self):
        self.calls.append(["begin"])

    def fold(self, target, todo, store, covered, evidence, gaps):
        self.calls.append(["fold", target, [value["id"] for value in todo]])
        action = self.script.get(target, "ok")
        if action == "raise":
            raise RuntimeError("boom")
        for value in todo:
            if not value.get("event_type") == "review":
                continue
            if self.gap is not None and value["id"] == self.gap["skip"]:
                gaps.append({"review": value["id"], "reason": "artifact missing"})
                continue
            for row in value["payload"]["reviewed_scope"]:
                for pair in row["intervals"]:
                    covered[row["path"]].update(range(pair[0], pair[1] + 1))


def refresh_case(name: str, events: List[Dict[str, Any]], targets: List[Any],
                 snapshot: Optional[Dict[str, Any]] = None, keep: Optional[List[str]] = None,
                 script: Optional[Dict[str, Any]] = None, gap: Optional[Dict[str, Any]] = None,
                 stale_snapshot_prefix: bool = False, extra_files: Optional[List[str]] = None) -> Dict[str, Any]:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / coverage.DIRECTORY).mkdir(parents=True)
        if snapshot is not None:
            document = copy.deepcopy(snapshot)
            if stale_snapshot_prefix:
                document["prefix"] = "0" * 64
            (root / coverage.DIRECTORY / (document["target"] + ".json")).write_bytes(
                json.dumps(document, sort_keys=True).encode())
        for extra in extra_files or []:
            (root / coverage.DIRECTORY / (extra + ".json")).write_bytes(b"{}")
        repo = FakeRepo(script, gap)
        outcome = coverage.refresh(root, repo, None, events, targets, keep=tuple(keep or ()))
        remaining = sorted(path.name for path in (root / coverage.DIRECTORY).glob("*.json"))
        written = None
        for path in (root / coverage.DIRECTORY).glob(TARGET + ".json"):
            written = json.loads(path.read_bytes())
        return {
            "input": {"events": events, "targets": targets, "keep": keep or [],
                      "snapshot": snapshot, "stale_prefix": stale_snapshot_prefix,
                      "extra_files": extra_files or [], "script": script or {},
                      "gap": gap},
            "expect": {"outcome": outcome, "calls": repo.calls, "remaining": remaining, "written": written},
            "name": name,
            "source": "backfill_coverage.refresh",
        }


def snapshot_of(events: List[Dict[str, Any]], covered: Dict[str, Any],
                gaps: Optional[List[Any]] = None) -> Dict[str, Any]:
    return {
        "version": coverage.VERSION,
        "target": TARGET,
        "events": len(events),
        "prefix": coverage._prefix_digest(events, len(events)),
        "covered": covered,
        "gaps": gaps or [],
    }


def load_case(name: str, events: List[Dict[str, Any]], appended: List[Dict[str, Any]],
              covered: Dict[str, Any]) -> Dict[str, Any]:
    """``backfill_coverage.load`` for a snapshot over ``events`` seen against
    ``events + appended``: credit stands only when nothing creditable was
    appended."""
    import shutil
    directory = tempfile.mkdtemp()
    root = Path(directory)
    try:
        (root / coverage.DIRECTORY).mkdir(parents=True)
        (root / coverage.DIRECTORY / (TARGET + ".json")).write_bytes(
            json.dumps(snapshot_of(events, covered), sort_keys=True).encode())
        loaded = coverage.load(root, TARGET, events + appended)
    finally:
        shutil.rmtree(directory, ignore_errors=True)
    return {
        "name": name,
        "source": "backfill_coverage.load",
        "input": {"events": events, "appended": appended, "covered": covered},
        "expect": {"load": None if loaded is None else {
            "covered": {key: coverage._ranges(lines)
                        for key, lines in sorted(loaded[0].items()) if lines},
            "gaps": list(loaded[1]),
        }},
    }


def coverage_family() -> List[Dict[str, Any]]:
    events = [review("e1", lines=[[1, 2]]), state_event("e2")]
    cases: List[Dict[str, Any]] = []
    cases.append(refresh_case("refresh-full", events, [TARGET]))
    cases.append(refresh_case(
        "refresh-current", events, [TARGET], snapshot=snapshot_of(events, {"src/app.ts": [[1, 2]]})))
    cases.append(refresh_case(
        "refresh-unchanged",
        events + [state_event("e3")],
        [TARGET],
        snapshot=snapshot_of(events, {"src/app.ts": [[1, 2]]}),
    ))
    cases.append(refresh_case(
        "refresh-extended",
        events + [review("e3", lines=[[3, 4]])],
        [TARGET],
        snapshot=snapshot_of(events, {"src/app.ts": [[1, 2]]}),
    ))
    cases.append(refresh_case(
        "refresh-stale-prefix",
        events + [review("e3", lines=[[3, 4]])],
        [TARGET],
        snapshot=snapshot_of(events, {"src/app.ts": [[1, 2]]}),
        stale_snapshot_prefix=True,
    ))
    gap = [{"review": events[0]["id"], "reason": "artifact missing"}]
    cases.append(refresh_case(
        "refresh-gap-cleared",
        events,
        [TARGET],
        snapshot=snapshot_of(events, {"src/app.ts": [[1, 2]]}, gaps=gap),
    ))
    cases.append(refresh_case(
        "refresh-gap-still-failing",
        events,
        [TARGET],
        snapshot=snapshot_of(events, {"src/app.ts": [[1, 2]]}, gaps=gap),
        gap={"skip": events[0]["id"]},
    ))
    cases.append(refresh_case(
        "refresh-error-isolation",
        events,
        [TARGET, TARGET_OTHER],
        script={TARGET: "raise"},
    ))
    cases.append(refresh_case(
        "refresh-invalid-target", events, ["not-an-object-id", TARGET]))
    cases.append(refresh_case(
        "refresh-prunes-dead", [review("e1", lines=[[1, 2]])], [TARGET],
        keep=[TARGET_OTHER], extra_files=["d" * 40, "gone"]))
    cases.append(refresh_case("refresh-no-targets", events, []))
    cases.append(load_case("load-state-only-append", events, [state_event("e3")],
                           {"src/app.ts": [[1, 2]]}))
    cases.append(load_case("load-creditable-append", events, [review("e3", lines=[[3, 4]])],
                           {"src/app.ts": [[1, 2]]}))
    cases.append({
        "name": "coverage-failed",
        "source": "backfill_publisher.coverage_failed",
        "input": {"values": ["disabled", "idle", "failed: boom",
                             {"head": HEAD, "targets": {TARGET: "extended"}},
                             {"head": HEAD, "targets": {TARGET: "invalid-target"}},
                             {"head": HEAD, "targets": {TARGET: "error: boom"}},
                             {"head": HEAD, "targets": {}}]},
        "expect": {"failed": [backfill_publisher.coverage_failed({"coverage": value})
                              for value in ["disabled", "idle", "failed: boom",
                                            {"head": HEAD, "targets": {TARGET: "extended"}},
                                            {"head": HEAD, "targets": {TARGET: "invalid-target"}},
                                            {"head": HEAD, "targets": {TARGET: "error: boom"}},
                                            {"head": HEAD, "targets": {}}]]},
    })
    queue_items = [
        {"kind": jobs.KIND, "state": "pending", "target": TARGET},
        {"kind": jobs.KIND, "state": "reviewing", "target": TARGET_OTHER},
        {"kind": jobs.KIND, "state": "done", "target": "e" * 40},
        {"kind": jobs.KIND, "state": "quarantined", "target": "f" * 40},
        {"kind": "review", "state": "pending", "target": "9" * 40},
    ]
    cases.append({
        "name": "pending-and-live-targets",
        "source": "backfill_coverage.pending_targets/live_targets",
        "input": {"queue": {"items": queue_items}},
        "expect": {
            "pending": sorted(coverage.pending_targets({"items": queue_items})),
            "live": sorted(coverage.live_targets({"items": queue_items})),
        },
    })
    return cases


class FakeReader:
    def __init__(self, head: str, events: List[Dict[str, Any]]):
        self.head = head
        self.events = events

    def fetch(self):
        return self.head, self.events


def run_case(name: str, *, settings: Optional[Dict[str, Any]], queue: Dict[str, Any],
             events: List[Dict[str, Any]], request: Optional[Dict[str, Any]] = None,
             published_head: Optional[str] = None, rewrite_request: bool = False,
             fold_script: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """``backfill_coverage.run`` with its three collaborators replaced by fakes.

    The control flow under test is the real one: the marker read, the queue
    snapshot, the publisher-owned fetch under its lock, the request's own
    targets, the byte-equality marker removal and the wake decision.
    """
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / "backfill").mkdir(parents=True)
        marker = root / coverage.REQUEST
        if request is not None:
            marker.write_bytes(coverage.ledger.canonical(request))
        wakes: List[str] = []

        repo = FakeRepo(fold_script)
        store = object()

        def fake_services(c, config):
            return repo, store, None, None

        def fake_worker_services(c, config):
            return None, store, None, FakeReader(HEAD, events)

        def fake_write_next(path, deadline):
            wakes.append(path.name + ":" + deadline.strftime("%Y-%m-%dT%H:%M:%SZ"))

        def fake_settings(state):
            return copy.deepcopy(settings)

        original = (runtime.settings, runtime.services, backfill_publisher.worker_services,
                    usage_slots.write_next, coverage.ledger.locked)
        runtime.settings = fake_settings
        runtime.services = fake_services
        backfill_publisher.worker_services = fake_worker_services
        usage_slots.write_next = fake_write_next

        class Ctx:
            STATE = root
            CONFIG = CONFIG

            def load_queue(self):
                return copy.deepcopy(queue)

            def iso(self):
                return NOW.strftime("%Y-%m-%dT%H:%M:%SZ")

        if rewrite_request:
            # A request written while the refresh computed must survive: the
            # fake fold rewrites the marker behind the refresher's back.
            real_fold = repo.fold

            def fold_then_rewrite(target, todo, store, covered, evidence, gaps):
                (root / coverage.REQUEST).write_bytes(coverage.ledger.canonical(
                    {"head": HEAD, "targets": [TARGET_OTHER]}))
                return real_fold(target, todo, store, covered, evidence, gaps)

            repo.fold = fold_then_rewrite
        try:
            result = coverage.run(Ctx(), published_head=published_head)
        finally:
            (runtime.settings, runtime.services, backfill_publisher.worker_services,
             usage_slots.write_next, coverage.ledger.locked) = original
        remaining = sorted(path.name for path in (root / "backfill").glob("*.json"))
        marker_bytes = marker.read_bytes() if marker.exists() else None
        return {
            "input": {"settings": settings, "queue": queue, "events": events,
                      "request": request, "published_head": published_head,
                      "rewrite_request": rewrite_request},
            "expect": {
                "result": result,
                "wakes": wakes,
                "remaining": remaining,
                "marker": None if marker_bytes is None else json.loads(marker_bytes),
                "calls": repo.calls,
            },
            "name": name,
            "source": "backfill_coverage.run",
        }


def run_family() -> List[Dict[str, Any]]:
    events = [review("e1", lines=[[1, 2]])]
    pending_queue = {"items": [{"id": "item", "kind": jobs.KIND, "state": "pending", "target": TARGET}]}
    idle_queue = {"items": []}
    return [
        run_case("run-disabled", settings=None, queue=idle_queue, events=events),
        run_case("run-idle", settings={"durable_artifact_root": "/synthetic"}, queue=idle_queue, events=events),
        run_case("run-request-consumed", settings={"durable_artifact_root": "/synthetic"},
                 queue=pending_queue, events=events,
                 request={"head": HEAD, "targets": [TARGET]}),
        run_case("run-published-head-only", settings={"durable_artifact_root": "/synthetic"},
                 queue=pending_queue, events=events, published_head=HEAD),
        run_case("run-no-targets", settings={"durable_artifact_root": "/synthetic"},
                 queue=idle_queue, events=events, published_head=HEAD),
        run_case("run-request-preserved", settings={"durable_artifact_root": "/synthetic"},
                 queue=pending_queue, events=events,
                 request={"head": HEAD, "targets": [TARGET]}, rewrite_request=True),
        run_case("run-current-no-wake", settings={"durable_artifact_root": "/synthetic"},
                 queue=idle_queue, events=[], published_head=HEAD),
    ]


def document() -> Dict[str, Any]:
    notify = notify_family()
    coverage_cases = coverage_family()
    run = run_family()
    closing = [
        {
            "name": "destination-unknown-config",
            "source": "review_notify.destination",
            "input": {"value": {"paseo_agent_id": AGENT, "paseo_host": "alpha"}, "config": {}},
            "expect": {"destination": None},
        },
    ]
    return {
        "schema": SCHEMA,
        "source": "apps/crq-python/notify_coverage_vector_emit_b1.py",
        "clock": NOW_ISO,
        "families": [
            {"family": "notify", "cases": notify + closing},
            {"family": "coverage", "cases": coverage_cases},
            {"family": "run", "cases": run},
        ],
    }


def render(value: Any) -> str:
    return json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true", help="regenerate the fixture")
    group.add_argument("--check", action="store_true", help="verify the fixture matches")
    group.add_argument("--stdout", action="store_true", help="print the document")
    options = parser.parse_args(argv)
    text = render(document())
    if options.stdout:
        sys.stdout.write(text)
        return 0
    if options.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(text, encoding="utf-8")
        return 0
    if not FIXTURE.exists() or FIXTURE.read_text(encoding="utf-8") != text:
        sys.stderr.write("fixture is stale; run --write\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
