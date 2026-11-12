#!/usr/bin/env python3
"""Deterministic offline oracle for the TS repair-harvest outcome slice.

Test tooling only. It drives the PRODUCTION ``repair_tick.harvest`` loop and
therefore the production ``repair_tick.mark_finding_outcome`` and
``finding_delivery.Inbox.repair_outcome``. Every external effect is faked: the
backfill rollout settings (``backfill_runtime.settings``), canonical delivery
(``repair_tick.require_canonical_delivery``), the worktree/verify/publish path
(only FIXED reaches it, and these cases do not), and the clock. The publication
outbox, artifact store, triage row and inbox job are real production objects
rooted in a temp directory.

This records what Python actually writes for each typed worker outcome:
action, failure class, exact canonical event bytes, exact canonical row bytes,
the retry bound, owner-decision vs retriable FAILED, dismissal only with
source evidence, pre-merge FIXED writing nothing, and idempotent replay after
a caller crash between spool and row write.

Regenerate with ``python3 repair_harvest_vectors.py --write`` and verify with
``python3 repair_harvest_vectors.py --check``. Output is deterministic
(ensure_ascii, sorted case order, no timestamps or host paths).
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import repair_tick
import review_ledger as ledger

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "repair-harvest" / "cases.json"
SCHEMA = "cq.crq-repair-harvest-vector/v1"

FINDING = "a" * 64
REVIEW = "b" * 64
JOB = "crq-repair-F1"
ITEM = "pr1-merged"
BASE = "c" * 40
COMMIT = "d" * 40
AT = "2026-11-12T00:00:00Z"
MAX_RETRIES = 2


def _row(status="delivered", repair_task=JOB, previous="event-1"):
    return {
        "review_id": REVIEW,
        "finding": {"id": FINDING},
        "canonical_id": FINDING,
        "previous_event_id": previous,
        "status": status,
        "receipt": {"repair_task": repair_task} if repair_task is not None else {},
    }


def _job_doc():
    return {
        "job": JOB,
        "item": ITEM,
        "canonical_finding_id": FINDING,
        "review_id": REVIEW,
        "repair_base": BASE,
        "finding": {"id": "thread-1", "path": "src/a.ts"},
    }


def _prior_event(previous, action, failure_class, number, actor="crq-repair"):
    payload = {
        "finding_id": FINDING,
        "review_id": REVIEW,
        "previous_event_id": previous,
        "action": action,
        "evidence": {
            "repair_task": "crq-prior-" + str(number),
            "reason": "prior outcome",
            "fix_pr": None,
            "failure_class": failure_class,
        },
        "actor": actor,
    }
    return ledger.event("finding-event", "repair-outcome:seed-" + str(number), AT, payload)


def _seed_chain(specs):
    """A real confirmed root plus prior outcomes, in chain order."""
    events = [ledger.event("finding-event", "confirmed:seed-root", AT, {
        "finding_id": FINDING, "review_id": REVIEW, "previous_event_id": None,
        "action": "confirmed", "evidence": {"target": "promoted-main", "anchor_verified": True},
        "actor": "cq-review"})]
    previous = events[0]["id"]
    for number, (action, failure_class, actor) in enumerate(specs, start=1):
        value = _prior_event(previous, action, failure_class, number, actor)
        events.append(value)
        previous = value["id"]
    return events, previous


def _state(root):
    state = root / "state"
    triage = state / "backfill/findings/triage"
    inbox = state / "repair/inbox"
    job = state / "repair" / JOB
    for directory in (triage, inbox, job, state / "backfill/publication/pending",
                      state / "artifacts"):
        directory.mkdir(parents=True, exist_ok=True)
    return state


def _write(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def _row_bytes(path):
    return ledger.canonical(ledger.loads(path.read_bytes())).decode("utf-8")


def _harvest_case(name, outcome, *, row=None, seeds=(), replay=False,
                  delivery_error=None, max_retries=MAX_RETRIES):
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary).resolve()
        state = _state(root)
        row_path = state / "backfill/findings/triage" / (FINDING + ".json")
        row_value = row if row is not None else _row()
        _write(row_path, row_value)
        _write(state / "repair/inbox" / (JOB + ".json"), _job_doc())
        _write(state / "repair" / JOB / "result.json",
               {"job": JOB, "item": ITEM, "repair_base": BASE, **outcome})

        store = ledger.ArtifactStore(root / "artifacts")
        outbox = ledger.Outbox(state / "backfill/publication", store)
        prior, latest = _seed_chain(seeds)
        for value in prior:
            outbox.spool(value)
        row_value = copy.deepcopy(row_value)
        row_value["previous_event_id"] = latest
        _write(row_path, row_value)

        queue_path = root / "queue.json"
        queue_order = []

        def outcome_events():
            return [value for value in outbox.retained()
                    if value["source_key"].startswith("repair-outcome:")
                    and not value["source_key"].startswith("repair-outcome:seed-")]

        def save_queue(value):
            # Ordering evidence for the invalid-result path: queue identity is
            # durable before the terminal ledger outcome exists.
            queue_order.append(len(outcome_events()))
            queue_path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")

        c = SimpleNamespace(
            STATE=state,
            CONFIG={"repair": {"max_finding_retries": max_retries}},
            iso=lambda: AT,
            WT_ROOT=root / "worktrees",
            CLONE=root / "clone",
            save_queue=save_queue,
        )
        item = {
            "id": ITEM,
            "kind": "merged",
            "state": "repairing",
            "repair_runs": {
                "run-1": {"jobs": [JOB], "base": BASE, "state": "queued"}
            },
        }

        def delivery(_root, _expected):
            if delivery_error is not None:
                raise ValueError(delivery_error)

        def settings(_state, **_kwargs):
            return {"durable_artifact_root": str(root / "artifacts")}

        row_before = _row_bytes(row_path)
        with mock.patch.object(repair_tick, "require_canonical_delivery", delivery), \
                mock.patch("backfill_runtime.settings", settings):
            repair_tick.harvest(c, {}, item, dry=False)
            events_after = outcome_events()
            row_after = _row_bytes(row_path)
            if replay:
                # Simulate a caller crash after spool and before the row write:
                # restore the identical input row and re-run the same harvest.
                row_path.write_text(row_before + "\n", encoding="utf-8")
                item["repair_runs"]["run-1"]["state"] = "queued"
                repair_tick.harvest(c, {}, item, dry=False)
                events_after = outcome_events()
                row_replayed = _row_bytes(row_path)
            else:
                row_replayed = None
        return {
            "name": name,
            "row_before": json.loads(row_before),
            "row_after": json.loads(row_after),
            "retained_before": prior,
            "events_added": events_after,
            "row_replayed": None if row_replayed is None else json.loads(row_replayed),
            # A deterministic artifact defect persists queue identity before
            # the ledger write (repair_tick.harvest invalid-result path).
            "queue_saved": queue_path.exists(),
            "queue_saved_before_outcome": None if not queue_order else queue_order[0] == 0,
            "outcome": outcome,
        }


def _mark_case(name, outcome, *, merge, repair_task=JOB):
    """Drive `mark_finding_outcome` directly for the FIXED/merge distinction."""
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary).resolve()
        state = _state(root)
        row_path = state / "backfill/findings/triage" / (FINDING + ".json")
        row_value = _row(repair_task=repair_task)
        _write(row_path, row_value)
        store = ledger.ArtifactStore(root / "artifacts")
        outbox = ledger.Outbox(state / "backfill/publication", store)
        c = SimpleNamespace(
            STATE=state,
            CONFIG={"repair": {"max_finding_retries": MAX_RETRIES}},
            iso=lambda: AT,
        )

        def settings(_state, **_kwargs):
            return {"durable_artifact_root": str(root / "artifacts")}

        row_before = _row_bytes(row_path)
        with mock.patch("backfill_runtime.settings", settings):
            repair_tick.mark_finding_outcome(c, _job_doc(), outcome, merge=merge, fix_pr=7)
        return {
            "name": name,
            "row_before": json.loads(row_before),
            "row_after": json.loads(_row_bytes(row_path)),
            "retained_before": [],
            "events_added": [value for value in outbox.retained()
                             if value["source_key"].startswith("repair-outcome:")],
            "outcome": outcome,
            "merge": merge,
        }


def build():
    harvest = [
        _harvest_case("failed-exhausted",
                      {"verdict": "FAILED", "failure_class": "exhausted",
                       "reason": "driver budget exhausted"}),
        _harvest_case("failed-transient",
                      {"verdict": "FAILED", "failure_class": "transient",
                       "reason": "provider unavailable"}),
        _harvest_case("failed-evidence",
                      {"verdict": "FAILED", "failure_class": "evidence",
                       "reason": "contract carried no usable evidence"}),
        _harvest_case("failed-protected-path",
                      {"verdict": "FAILED", "failure_class": "protected-path",
                       "reason": "worker may not edit workflows"}),
        _harvest_case("failed-owner-decision",
                      {"verdict": "FAILED", "failure_class": "owner-decision",
                       "reason": "architectural choice required"}),
        _harvest_case("failed-unknown-class-normalizes",
                      {"verdict": "FAILED", "failure_class": "bogus",
                       "reason": "unclassified stop"}),
        _harvest_case("not-fixed-with-evidence",
                      {"verdict": "NOT-FIXED", "reason": "already fixed upstream",
                       "unchanged_evidence": [{"path": "src/a.ts", "line": 2}]}),
        _harvest_case("not-fixed-without-evidence",
                      {"verdict": "NOT-FIXED", "reason": "no source read",
                       "unchanged_evidence": []}),
        _harvest_case("not-fixed-without-evidence-owner",
                      {"verdict": "NOT-FIXED", "failure_class": "owner-decision",
                       "reason": "substantial architectural change"}),
        _harvest_case("stale-delivery",
                      {"verdict": "STALE", "reason": "source moved"}),
        _harvest_case("invalid-fixed-without-commits",
                      {"verdict": "FIXED", "reason": "claimed fixed"}),
        _harvest_case("retry-bound-reached",
                      {"verdict": "FAILED", "failure_class": "exhausted",
                       "reason": "third bounded attempt"},
                      seeds=[("needs-retriage", "exhausted", "crq-repair"),
                             ("needs-human", "evidence", "crq-repair")]),
        _harvest_case("retry-bound-owner-prior-not-counted",
                      {"verdict": "FAILED", "failure_class": "evidence",
                       "reason": "another evidence gap"},
                      seeds=[("needs-human", "owner-decision", "crq-repair")]),
        _harvest_case("retry-bound-non-crq-actors-not-counted",
                      {"verdict": "FAILED", "failure_class": "exhausted",
                       "reason": "operator retried twice"},
                      seeds=[("needs-human", "exhausted", "cq-review"),
                             ("needs-retriage", "exhausted", "operator")]),
        _harvest_case("idempotent-replay-after-spool",
                      {"verdict": "FAILED", "failure_class": "exhausted",
                       "reason": "bounded deferral"},
                      replay=True),
        _harvest_case("preserved-newer-generation",
                      {"verdict": "FAILED", "failure_class": "exhausted",
                       "reason": "old job finished late"},
                      row=_row(repair_task="crq-newer-F2")),
        _harvest_case("row-not-delivered-preserved",
                      {"verdict": "FAILED", "failure_class": "exhausted",
                       "reason": "operator moved the row"},
                      row=_row(status="confirmed")),
    ]
    mark = [
        _mark_case("pre-merge-fixed-writes-nothing",
                   {"verdict": "FIXED", "commits": [COMMIT], "reason": "fix ready"},
                   merge=None),
        _mark_case("merged-fixed-writes-fixed",
                   {"verdict": "FIXED", "commits": [COMMIT], "reason": "verified merge"},
                   merge=COMMIT),
    ]
    return {
        "schema": SCHEMA,
        "at": AT,
        "finding_id": FINDING,
        "job": JOB,
        "max_finding_retries": MAX_RETRIES,
        "repair_base": BASE,
        "harvest_cases": harvest,
        "mark_cases": mark,
    }


def render(document):
    return json.dumps(document, ensure_ascii=True, indent=2, sort_keys=False) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Emit the repair-harvest oracle fixture")
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
        print("repair-harvest fixture is stale; run --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
