"""Emit the A1 status/summary differential fixtures from the Python oracle.

Test tooling only: `crq` never imports this module. Group-P (`fixtures/group-p`)
is the shared foundation and stays untouched; this family carries the cases the
A1 port needs beyond it, plus receipt-bound `merged_current` inputs whose
receipt ids are produced by the real writer.

    cd apps/crq-python
    python3 fixtures/a1-status/emit.py --write   # regenerate every file
    python3 fixtures/a1-status/emit.py --check   # fail when a file is stale
    python3 fixtures/a1-status/emit.py --stdout  # print the documents

Determinism: fixed timestamps only, sorted receipt maps, `indent=2` with
`ensure_ascii=True` and one trailing newline. No host, path or clock is
recorded. `--check` byte-identity holds on every host running CPython >=
3.14.7 (or 3.15+): the `fractional-zero-offset-is-applied` case below pins
gh-152079 behavior, so pre-3.14.7 interpreters (e.g. 3.14.4) disagree on that
one synthetic case and `--check` fails there by design.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import shutil
import sys
import tempfile
import unittest.mock
from pathlib import Path
from typing import Any, Dict, List

HERE = Path(__file__).resolve().parent
CRQ = HERE.parent.parent
sys.path.insert(0, str(CRQ))

import client_health  # noqa: E402
import coverage  # noqa: E402
import queue_time  # noqa: E402
import review_receipt  # noqa: E402
import status_summary  # noqa: E402

SCHEMA = "cq.crq-a1-status-vector/v1"
TARGET = "a" * 40
TREE = "b" * 40
SUBJECT = {"repo": "owner/repo", "pr": 1}
PROJECTION = "current-affected-files/full-file-addition-projection"
REVIEWER = "coderabbit-review-agent-committed-v1"
BIG = 9007199254740993
NEIGHBOR = 9007199254740992


def _capture(
    name: str, source: str, inputs: Dict[str, Any], call, *, reserialize: bool = False
) -> Dict[str, Any]:
    try:
        value = call()
    except Exception as exc:  # the oracle refusal is part of the contract
        expect = {"ok": False, "error": type(exc).__name__, "message": str(exc)}
    else:
        expect = {"ok": True, "value": _a1_keys(value)}
        if reserialize:
            expect["bytes"] = _compact(_a1_keys(value))
    return {"name": name, "source": source, "input": inputs, "expect": expect}


def _compact(value: Any) -> str:
    """The exact `status_summary.publish` reserialisation (compact, ASCII)."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True)


def _a1_keys(value: Any) -> Any:
    """Project a summary to the A1-scoped shared-oracle keys.

    The a1-status fixtures are the byte oracle for the TypeScript summary-core
    port (`src/policy/crq/statusSummary.ts`), which mirrors the summary as of
    slice A1. The S3c `review_metrics` block is additive and Python-only: it
    has no TS counterpart yet, so these fixtures strip it (with this
    documented reason) instead of carrying a key the TS port silently
    ignores. review_metrics stays snapshotted for the Python replay in
    fixtures/group-p/summary.json.
    """
    if isinstance(value, dict):
        return {key: _a1_keys(item) for key, item in value.items() if key != "review_metrics"}
    if isinstance(value, list):
        return [_a1_keys(item) for item in value]
    return value


def _utc_iso(epoch: float) -> str:
    """`datetime.fromtimestamp(epoch, utc).strftime("%Y-%m-%dT%H:%M:%SZ")`."""
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _epoch(value: str) -> float:
    return queue_time.parse_utc(value).timestamp()


def _capture_document(paths: List[Dict[str, Any]], **overrides: Any) -> Dict[str, Any]:
    capture = {
        "target": TARGET,
        "tree": TREE,
        "paths": paths,
        "scope_digest": review_receipt.digest(paths),
        "policy": review_receipt.POLICY,
        "projection": PROJECTION,
        "reviewer": REVIEWER,
        "reviewer_version": "fixture",
    }
    # Overrides land before the equivalence identity: the equivalence binds
    # the FINAL capture (target/tree/scope included), not the template. The
    # bounded case below overrides only `target` and expects every receipt to
    # verify; computing equivalence first made each receipt self-inconsistent
    # (equivalence of target-only fields vs. identity of TARGET) and merged_current
    # demoted all 34 receipts to unverified instead of 32 captured + 2 omitted.
    capture.update(overrides)
    capture["equivalence"] = review_receipt.current_equivalence(capture)
    return capture


def _receipt(root: Path, document: Dict[str, Any]) -> str:
    return review_receipt.write_receipt(root, document)


# ---------------------------------------------------------------- summarize


def summarize_family() -> Dict[str, Any]:
    cases = []

    def summarize(
        name: str,
        *,
        queue: Dict[str, Any],
        config: Dict[str, Any] | None = None,
        heartbeat: Dict[str, Any] | None = None,
        events: List[Dict[str, Any]] | None = None,
        generated_at: str = "2026-11-09T11:55:00Z",
        now: str = "2026-11-09T12:00:00Z",
    ) -> Dict[str, Any]:
        inputs = {
            "status": {"generated_at": generated_at},
            "queue": queue,
            "heartbeat": heartbeat or {},
            "config": config or {"repo": "owner/repo", "max_starts_per_hour": 8},
            "events": events or [],
            "now": _epoch(now),
        }
        return _capture(
            name,
            "status_summary.summarize",
            inputs,
            lambda: status_summary.summarize(
                inputs["status"],
                inputs["queue"],
                inputs["heartbeat"],
                inputs["config"],
                inputs["events"],
                inputs["now"],
            ),
        )

    aging_queue = {
        "items": [
            {
                "id": "repeat",
                "kind": "local-review",
                "generation": 1,
                "repeat_requested": True,
                "created_at": "1970-01-01T00:00:00Z",
                "state": "pending",
                "wait_reason": "capacity",
                "order": 1,
            },
            {"id": "first", "kind": "local-review", "generation": 1, "state": "pending", "order": 2},
        ]
    }
    cases.append(
        summarize(
            "local-review-aging-before-deadline",
            queue=aging_queue,
            generated_at="1970-01-01T01:00:00Z",
            now="1970-01-01T00:59:59Z",
        )
    )
    cases.append(
        summarize(
            "local-review-aging-at-deadline",
            queue=aging_queue,
            generated_at="1970-01-01T01:00:00Z",
            now="1970-01-01T01:00:00Z",
        )
    )
    cases.append(
        summarize(
            "local-review-aging-minutes-from-config",
            queue=aging_queue,
            config={
                "repo": "owner/repo",
                "max_starts_per_hour": 8,
                "local_review_aging_minutes": 30,
            },
            generated_at="1970-01-01T00:30:00Z",
            now="1970-01-01T00:30:00Z",
        )
    )
    cases.append(
        summarize(
            "invalid-local-review-age-does-not-break-preview",
            queue={
                "items": [
                    {
                        "kind": "local-review",
                        "generation": 2,
                        "created_at": "invalid",
                        "state": "pending",
                        "order": 1,
                    },
                    {"kind": "local-review", "generation": 1, "state": "pending", "order": 2},
                ]
            },
            generated_at="1970-01-01T01:00:00Z",
            now="1970-01-01T01:00:00Z",
        )
    )
    cases.append(
        summarize(
            "foreign-open-pr-before-repository-rank",
            queue={
                "items": [
                    {
                        "id": "foreign",
                        "repo": "owner/foreign",
                        "kind": "open",
                        "state": "pending",
                        "order": 0,
                    },
                    {"id": "primary", "kind": "merged-current", "state": "pending", "order": 1},
                    {
                        "id": "push",
                        "repo": "owner/foreign",
                        "kind": "push-current",
                        "state": "pending",
                        "order": 2,
                    },
                ]
            },
            config={
                "repo": "owner/primary",
                "max_starts_per_hour": 8,
                "repos": [{"repo": "owner/foreign", "rank_tier": 3}],
            },
            generated_at="1970-01-01T00:00:02Z",
            now="1970-01-01T00:00:02Z",
        )
    )
    kinds = ["open", "delta", "merged-current", "merged", "coverage", "backfill"]
    completion_items = [
        {"id": str(n), "kind": k, "state": "pending", "pr": n + 1, "order": n}
        for n, k in enumerate(kinds)
    ]
    completion_items += [
        {"id": str(n), "kind": "backfill", "state": "pending"} for n in range(6, 20)
    ]
    completion_events = [
        {
            "event": "review_finished",
            "item": str(n),
            "outcome": "completed",
            "at": "1970-01-01T00:00:01Z",
        }
        for n in range(6)
    ]
    cases.append(
        summarize(
            "completion-groups-and-bounded-preview",
            queue={"items": completion_items},
            events=completion_events,
            generated_at="1970-01-01T00:00:02Z",
            now="1970-01-01T00:00:02Z",
        )
    )
    priority_items = [
        {"id": f"n{n}", "kind": "open", "state": "pending", "pr": n + 1, "order": n}
        for n in range(11)
    ]
    priority_items.append(
        {
            "id": "priority",
            "kind": "open",
            "state": "pending",
            "pr": 99,
            "operator_priority": True,
            "order": 99,
        }
    )
    cases.append(
        summarize(
            "operator-priority-precedes-ordinary-items",
            queue={"items": priority_items},
            generated_at="2026-11-09T11:55:00Z",
            now="2026-11-09T12:00:00Z",
        )
    )
    for usage, label in (
        ({"limit": 8}, "account-limit-overrides-fallback-cap"),
        ({"limit": 0}, "usage-limit-zero-falls-back"),
        ({"limit": True}, "usage-limit-bool-falls-back"),
        ({"limit": "8"}, "usage-limit-string-falls-back"),
        ({"remaining": 2}, "usage-remaining-only-falls-back"),
        (None, "usage-missing-falls-back"),
    ):
        queue = {"items": []} if usage is None else {"items": [], "usage": usage}
        cases.append(
            summarize(
                label,
                queue=queue,
                config={"max_starts_per_hour": 5},
                generated_at="2026-10-31T00:00:00Z",
                now="2026-10-31T00:00:00Z",
            )
        )
    for usage, label in (
        ({"limit": 3}, "usage-limit-int-three-is-kept"),
        ({"limit": 3.0}, "usage-limit-integral-float-falls-back"),
    ):
        cases.append(
            summarize(
                label,
                queue={"items": [], "usage": usage},
                config={"max_starts_per_hour": 10},
                generated_at="2026-10-31T00:00:00Z",
                now="2026-10-31T00:00:00Z",
            )
        )
    for usage, label in (
        ({"limit": 9007199254740991}, "usage-limit-safe-neighbor-is-kept"),
        ({"limit": -9007199254740993}, "usage-limit-large-negative-falls-back"),
        ({"limit": 9007199254740992}, "usage-limit-large-exact-int-is-kept"),
        ({"limit": 9007199254740993}, "usage-limit-large-unrepresentable-int-is-kept"),
        ({"limit": 9007199254740992.0}, "usage-limit-large-exact-float-falls-back"),
        ({"limit": 9007199254740993.0}, "usage-limit-large-integral-float-falls-back"),
    ):
        cases.append(
            summarize(
                label,
                queue={"items": [], "usage": usage},
                config={"max_starts_per_hour": 10},
                generated_at="2026-10-31T00:00:00Z",
                now="2026-10-31T00:00:00Z",
            )
        )
    cases.append(
        summarize(
            "local-review-generation-bool-is-one",
            queue={
                "items": [
                    {
                        "id": "generation-bool",
                        "kind": "local-review",
                        "generation": True,
                        "state": "pending",
                        "order": 1,
                    }
                ]
            },
            generated_at="1970-01-01T01:00:00Z",
            now="1970-01-01T01:00:00Z",
        )
    )
    cases.append(
        summarize(
            "optional-open-cycles-are-not-review-debt",
            queue={
                "items": [
                    {"kind": "open", "state": "pending", "cycles": [{}]},
                    {
                        "kind": "open",
                        "state": "pending",
                        "prior_cycles": 1,
                        "prior_base": "a" * 40,
                    },
                    {"kind": "open", "state": "pending", "cycles": []},
                ]
            },
            config={"max_starts_per_hour": 5},
            generated_at="2026-10-28T00:00:00Z",
            now="2026-10-28T00:00:00Z",
        )
    )
    cases.append(
        summarize(
            "reharvested-run-counts-once",
            queue={"items": []},
            config={"max_starts_per_hour": 5},
            events=[
                {
                    "event": "review_finished",
                    "at": "2026-11-06T00:00:00Z",
                    "run": "r1",
                    "outcome": "error",
                },
                {
                    "event": "review_finished",
                    "at": "2026-11-06T00:01:00Z",
                    "run": "r1",
                    "outcome": "completed",
                },
                {
                    "event": "review_finished",
                    "at": "2026-11-06T00:02:00Z",
                    "run": "r1",
                    "outcome": "completed",
                },
                {
                    "event": "review_finished",
                    "at": "2026-11-06T00:03:00Z",
                    "run": "r2",
                    "outcome": "interrupted",
                },
                {"event": "review_finished", "at": "2026-11-06T00:04:00Z", "outcome": "completed"},
                {"event": "review_finished", "at": "2026-11-06T00:05:00Z", "outcome": "completed"},
            ],
            generated_at="2026-11-06T01:00:00Z",
            now="2026-11-06T01:00:00Z",
        )
    )
    base_event = {"event": "review_finished", "outcome": "completed"}
    cases.append(
        summarize(
            "review-finished-garbage-timestamp-refused",
            queue={"items": []},
            config={"max_starts_per_hour": 5},
            events=[{**base_event, "at": "garbage"}],
            generated_at="2026-11-06T01:00:00Z",
            now="2026-11-06T01:00:00Z",
        )
    )
    cases.append(
        summarize(
            "review-finished-missing-timestamp-accepted",
            queue={"items": []},
            config={"max_starts_per_hour": 5},
            events=[base_event],
            generated_at="2026-11-06T01:00:00Z",
            now="2026-11-06T01:00:00Z",
        )
    )
    cases.append(
        summarize(
            "review-finished-empty-timestamp-accepted",
            queue={"items": []},
            config={"max_starts_per_hour": 5},
            events=[{**base_event, "at": ""}],
            generated_at="2026-11-06T01:00:00Z",
            now="2026-11-06T01:00:00Z",
        )
    )
    cases.append(
        summarize(
            "starts-window-includes-both-boundaries",
            queue={
                "items": [],
                "starts": [
                    "2026-11-09T11:00:00Z",
                    "2026-11-09T11:30:00Z",
                    "2026-11-09T12:00:00Z",
                    "2026-11-09T12:00:01Z",
                ],
            },
            generated_at="2026-11-09T12:00:00Z",
            now="2026-11-09T12:00:00Z",
        )
    )
    cases.append(
        summarize(
            "in-flight-is-global-across-repos",
            queue={
                "items": [
                    {"kind": "open", "state": "reviewing", "repo": "owner/repo"},
                    {"kind": "push-current", "state": "reviewing", "repo": "owner/other"},
                    {"kind": "open", "state": "pending", "repo": "owner/repo", "cycles": []},
                ]
            },
            config={"repo": "owner/repo", "max_starts_per_hour": 5},
            generated_at="2026-11-03T00:00:00Z",
            now="2026-11-03T00:00:00Z",
        )
    )
    cases.append(
        summarize(
            "repos-configured-stay-visible-before-first-item",
            queue={"items": []},
            config={
                "repo": "owner/primary",
                "max_starts_per_hour": 5,
                "repos": [
                    {"repo": "owner/dotfiles"},
                    {"repo": "owner/encoding"},
                ],
            },
            generated_at="2026-11-03T00:00:00Z",
            now="2026-11-03T00:00:00Z",
        )
    )
    return _family("summarize", cases, "cases beyond the shared group-p summary vectors")


# ------------------------------------------------------------ merged-current


def merged_current_family() -> Dict[str, Any]:
    cases = []

    def case(
        name: str,
        documents: List[Dict[str, Any]],
        item: Dict[str, Any],
        *,
        extra_items: List[Dict[str, Any]] | None = None,
        queue_extra: Dict[str, Any] | None = None,
    ) -> Dict[str, Any]:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            receipts: Dict[str, Any] = {}
            item = dict(item)
            for document in documents:
                rid = _receipt(root, document)
                receipts[rid] = document
                if "receipt_id" not in item:
                    item["receipt_id"] = rid
            queue = {"items": [item, *(extra_items or [])], **(queue_extra or {})}
            inputs = {"queue": queue, "receipts": receipts}
            return _capture(
                name,
                "status_summary.merged_current",
                inputs,
                lambda: status_summary.merged_current(queue, root),
            )

    deleted = [{"path": "gone.py", "disposition": "deleted"}]
    capture = _capture_document(deleted)
    no_current = {
        "version": 1,
        "source": SUBJECT,
        "capture": capture,
        "outcome": "no-current-code",
        "counted": False,
        "classification": None,
    }
    cases.append(
        case(
            "verified-no-current-code-counts-deleted-exclusion",
            [no_current],
            {
                "kind": "merged-current",
                "state": "no-current-code",
                "subject": SUBJECT,
                "capture": capture,
            },
        )
    )
    partial_capture = _capture_document(deleted)
    partial = {
        "version": 1,
        "source": SUBJECT,
        "capture": partial_capture,
        "outcome": "partial-scope",
        "counted": True,
        "classification": {"counted": True, "outcome": "completed"},
    }
    cases.append(
        case(
            "verified-partial-scope",
            [partial],
            {
                "kind": "merged-current",
                "state": "done",
                "subject": SUBJECT,
                "capture": partial_capture,
            },
        )
    )
    terminal_capture = _capture_document(
        [{"path": "kept.py", "disposition": "included"}]
    )
    terminal = {
        "version": 1,
        "source": SUBJECT,
        "capture": terminal_capture,
        "outcome": "terminal-with-findings",
        "counted": True,
        "classification": {"counted": True, "outcome": "completed"},
    }
    cases.append(
        case(
            "verified-terminal-with-findings",
            [terminal],
            {
                "kind": "merged-current",
                "state": "done",
                "subject": SUBJECT,
                "capture": terminal_capture,
            },
        )
    )
    def captured_case(
        name: str,
        root: Path,
        queue: Dict[str, Any],
        receipts: Dict[str, Any],
    ) -> Dict[str, Any]:
        inputs = {"queue": queue, "receipts": receipts}
        return _capture(
            name,
            "status_summary.merged_current",
            inputs,
            lambda: status_summary.merged_current(queue, root),
        )

    # A readable file whose bytes do not hash to its name: the digest check
    # refuses it even though the document itself is well formed.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        rid = _receipt(root, terminal)
        tampered_id = "e" * 64
        shutil.copyfile(root / f"{rid}.json", root / f"{tampered_id}.json")
        tampered_queue = {
            "items": [
                {
                    "kind": "merged-current",
                    "state": "done",
                    "subject": SUBJECT,
                    "capture": terminal_capture,
                    "receipt_id": tampered_id,
                }
            ]
        }
        cases.append(
            captured_case(
                "tampered-receipt-is-unverified",
                root,
                tampered_queue,
                {tampered_id: terminal},
            )
        )

    # No file at the expected content id: the read fails before verification.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        missing_id = review_receipt.digest(terminal)
        missing_queue = {
            "items": [
                {
                    "kind": "merged-current",
                    "state": "done",
                    "subject": SUBJECT,
                    "capture": terminal_capture,
                    "receipt_id": missing_id,
                }
            ]
        }
        cases.append(
            captured_case("missing-receipt-is-unverified", root, missing_queue, {})
        )
    reused = {
        **terminal_capture,
        "captured_at": "later",
        "base": "c" * 40,
    }
    # `equivalence` must stay the identity of the retained content.
    reused["equivalence"] = review_receipt.current_equivalence(reused)
    original_item = {
        "id": "original",
        "kind": "merged-current",
        "state": "done",
        "receipt_id": "f" * 64,
        "subject": SUBJECT,
        "capture": terminal_capture,
    }

    def reused_case(name: str, overrides: Dict[str, Any]) -> Dict[str, Any]:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rid = _receipt(root, terminal)
            original = {**original_item, "receipt_id": rid}
            item = {
                **original,
                "id": "reused",
                "subject": {"repo": "owner/repo", "pr": 2},
                "capture": reused,
                "reused_from": "original",
                **overrides,
            }
            queue = {"items": [original, item]}
            inputs = {"queue": queue, "receipts": {rid: terminal}}
            return _capture(
                name,
                "status_summary.merged_current",
                inputs,
                lambda: status_summary.merged_current(queue, root),
            )

    cases.append(reused_case("reused-lineage-verified", {}))
    cases.append(reused_case("reused-lineage-missing-parent", {"reused_from": "missing"}))
    cases.append(reused_case("reused-lineage-cycle", {"reused_from": "reused"}))
    cases.append(
        reused_case(
            "reused-lineage-capture-target-mismatch",
            {"capture": {**reused, "target": "d" * 40}},
        )
    )
    unsupported_capture = _capture_document(deleted)
    unsupported = {
        "version": 1,
        "source": SUBJECT,
        "capture": unsupported_capture,
        "outcome": "unsupported",
        "counted": False,
        "classification": None,
    }
    cases.append(
        case(
            "verified-unsupported-terminal",
            [unsupported],
            {
                "kind": "merged-current",
                "state": "unsupported",
                "subject": SUBJECT,
                "capture": unsupported_capture,
            },
        )
    )
    empty_capture = _capture_document([])
    empty_document = {
        "version": 1,
        "source": SUBJECT,
        "capture": empty_capture,
        "outcome": "no-current-code",
        "counted": False,
        "classification": None,
    }
    cases.append(
        case(
            "empty-path-list-is-no-current-code",
            [empty_document],
            {
                "kind": "merged-current",
                "state": "no-current-code",
                "subject": SUBJECT,
                "capture": empty_capture,
            },
        )
    )
    excluded_capture = _capture_document(
        [{"path": "blank.py", "disposition": "excluded-with-reason", "reason": "empty current file"}]
    )
    excluded_document = {
        "version": 1,
        "source": SUBJECT,
        "capture": excluded_capture,
        "outcome": "no-current-code",
        "counted": False,
        "classification": None,
    }
    cases.append(
        case(
            "excluded-empty-current-file-is-no-current-code",
            [excluded_document],
            {
                "kind": "merged-current",
                "state": "no-current-code",
                "subject": SUBJECT,
                "capture": excluded_capture,
            },
        )
    )

    # 34 distinct captured targets: the preview keeps the first 32 sorted and
    # reports the remainder.
    bounded_items: List[Dict[str, Any]] = []
    bounded_receipts: Dict[str, Any] = {}
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for index in range(34):
            target = f"{index:040x}"
            path_rows = [{"path": "kept.py", "disposition": "included"}]
            bounded_capture = _capture_document(path_rows, target=target)
            document = {
                "version": 1,
                "source": {"repo": "owner/repo", "pr": 1000 + index},
                "capture": bounded_capture,
                "outcome": "terminal-with-findings",
                "counted": True,
                "classification": {"counted": True, "outcome": "completed"},
            }
            rid = _receipt(root, document)
            bounded_receipts[rid] = document
            bounded_items.append(
                {
                    "kind": "merged-current",
                    "state": "done",
                    "subject": document["source"],
                    "capture": bounded_capture,
                    "receipt_id": rid,
                }
            )
        bounded_queue = {
            "items": bounded_items,
            "merged_discovery": {
                "after": "2026-11-08T00:00:00Z",
                "before": "2026-11-09T00:00:00Z",
                "complete": False,
                "error": "transient",
                "reason": "budget",
            },
            "merged_reconcile": {
                "after": "2026-11-08T00:00:00Z",
                "before": "2026-11-09T00:00:00Z",
                "complete": True,
                "reason": "budget-exhausted",
                "pages_read": 0,
                "transient_failures": 2,
            },
            "merged_watermark": "2026-11-09T00:00:00Z",
        }
        bounded_inputs = {"queue": bounded_queue, "receipts": bounded_receipts}
        cases.append(
            _capture(
                "captured-targets-are-sorted-and-bounded",
                "status_summary.merged_current",
                bounded_inputs,
                lambda: status_summary.merged_current(bounded_queue, root),
            )
        )
    return _family("merged-current", cases, "receipt-bound merged-current projection")


# --------------------------------------------------------------- client health


class _FrozenDateTime(dt.datetime):
    """`client_health.snapshot` reads the wall clock; freeze it for the fixture."""

    frozen: dt.datetime = dt.datetime(2026, 11, 9, 12, 0, 0, tzinfo=dt.timezone.utc)

    @classmethod
    def now(cls, tz=None):  # noqa: N805 - mirrors datetime's classmethod
        if tz is None:
            return cls.frozen.replace(tzinfo=None)
        return cls.frozen.astimezone(tz)


def client_health_family() -> Dict[str, Any]:
    cases = []

    def case(name: str, queue: Dict[str, Any]) -> Dict[str, Any]:
        inputs = {"queue": queue, "now": _epoch("2026-11-09T12:00:00Z")}
        with unittest.mock.patch.object(client_health.dt, "datetime", _FrozenDateTime):
            return _capture(
                name,
                "client_health.snapshot",
                inputs,
                lambda: client_health.snapshot(queue),
            )

    health = {
        "completed_at": "2026-11-09T11:50:00Z",
        "complete": True,
        "incomplete_ticks": 2,
        "sha": "f" * 40,
    }
    cases.append(
        case(
            "complete-and-aged",
            {
                "client_health": health,
                "items": [
                    {"state": "pending"},
                    {"state": "pending"},
                    {"state": "blocked"},
                    {"state": "reviewing"},
                ],
            },
        )
    )
    cases.append(
        case(
            "missing-health-record",
            {"items": [{"state": "pending"}]},
        )
    )
    cases.append(
        case(
            "empty-completed-at-has-no-age",
            {"client_health": {"completed_at": "", "complete": False}, "items": []},
        )
    )
    cases.append(
        case(
            "invalid-completed-at-is-refused",
            {"client_health": {"completed_at": "garbage"}, "items": []},
        )
    )
    cases.append(
        case(
            "non-string-completed-at-is-refused",
            {"client_health": {"completed_at": 123}, "items": []},
        )
    )
    cases.append(
        case(
            "health-not-object-is-refused",
            {"client_health": [], "items": []},
        )
    )
    cases.append(
        case(
            "item-not-object-is-refused",
            {"client_health": {}, "items": [1]},
        )
    )
    cases.append(case("items-missing-default-empty", {"client_health": {}}))
    return _family("client-health", cases, "advisory runner health snapshot")


# --------------------------------------------------------------- utilization


def utilization_family() -> Dict[str, Any]:
    """`coverage.utilization_digest` edges the shared group-P family skips."""
    cases = []

    def case(
        name: str,
        *,
        queue: Dict[str, Any] | None = None,
        ledger: Dict[str, Any] | None = None,
        now: Any = "2026-11-09T12:00:00Z",
        cap: Any = 5,
    ) -> Dict[str, Any]:
        queue = {"starts": []} if queue is None else queue
        ledger = coverage.new_ledger() if ledger is None else ledger
        inputs = {
            "queue": queue,
            "ledger": ledger,
            "now": now,
            "max_starts_per_hour": cap,
        }
        return _capture(
            name,
            "coverage.utilization_digest",
            inputs,
            lambda: coverage.utilization_digest(
                queue, ledger, now=now, max_starts_per_hour=cap
            ),
        )

    def row(**overrides: Any) -> Dict[str, Any]:
        value = {
            "started": False,
            "pending": True,
            "candidate_exists": True,
            "blocked_reason": None,
        }
        value.update(overrides)
        return value

    cases.append(
        case(
            "float-cap-keeps-float-tag",
            queue={"starts": [], "cooldown_until": "2026-11-09T12:15:00Z"},
            cap=5.0,
        )
    )
    cases.append(case("bool-cap-is-python-int", cap=True))
    cases.append(
        case(
            "huge-int-cap-stays-exact",
            queue={"starts": ["2026-11-09T11:00:00Z"]},
            cap=10**400,
        )
    )
    cases.append(
        case(
            "max-double-int-cap-stays-exact",
            queue={"starts": ["2026-11-09T11:00:00Z"]},
            cap=2**1024 - 2**971,
        )
    )
    cases.append(
        case(
            "huge-float-cap-overflows-to-infinity",
            queue={"starts": ["2026-11-09T11:00:00Z"]},
            cap=1e308,
        )
    )
    cases.append(
        case(
            "tiny-float-cap-overflows-utilization",
            queue={"starts": ["2026-11-09T11:00:00Z"]},
            cap=1e-323,
        )
    )
    cases.append(case("nan-cap-propagates", cap=float("nan")))
    cases.append(case("false-cap-refused", cap=False))
    cases.append(case("string-cap-type-error", cap="5"))
    cases.append(case("none-cap-type-error", cap=None))
    cases.append(
        case(
            "cutoff-and-now-boundaries",
            queue={
                "starts": ["2026-11-08T12:00:00Z", "2026-11-09T12:00:00Z"],
            },
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-08T12:00:00Z": row(),
                    "2026-11-09T12:00:00Z": row(candidate_exists=False),
                },
            },
        )
    )
    cases.append(
        case(
            "numeric-now-rounds-half-even",
            now=1.0000005,
            queue={
                "starts": [
                    "1970-01-01T00:00:01Z",
                    "1970-01-01T00:00:01.000001Z",
                    "1970-01-01T00:00:01.000002Z",
                ],
            },
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "1970-01-01T00:00:01.000001Z": row(),
                    "1970-01-01T00:00:01.000002Z": row(),
                },
            },
        )
    )
    cases.append(
        case(
            "float-start-half-even-tie",
            now="1970-01-01T00:00:00.000002Z",
            queue={"starts": [0.0000025]},
        )
    )
    cases.append(
        case(
            "float-start-half-even-cutoff-tie",
            now="1970-01-02T00:00:00.000002Z",
            queue={"starts": [0.0000025]},
        )
    )
    cases.append(
        case(
            # Interpreter requirement: this case pins CPython gh-152079
            # (commit 6f9c76d8d869, first released in 3.14.7; present in
            # 3.15+). Before 3.14.7, fromisoformat dropped the fraction of a
            # zero-whole-second offset ("+00:00:00.5" collapsed to UTC), so
            # 3.14.4 computes starts_24h=0 here instead of 1. CI's floating
            # '3.14' pin observed 3.14.10; the fixture was generated on
            # 3.15.0. Not a reachable production input: the queue writes only
            # second-granularity strftime("%Y-%m-%dT%H:%M:%SZ") timestamps.
            "fractional-zero-offset-is-applied",
            now="2026-11-09T12:00:00+00:00:00.5",
            queue={"starts": ["2026-11-08T12:00:00Z"]},
        )
    )
    cases.append(case("invalid-month-message", now="2026-13-01T00:00:00Z"))
    cases.append(case("invalid-day-message", now="2026-02-30T00:00:00Z"))
    cases.append(case("invalid-hour-message", now="2026-01-01T25:00:00Z"))
    cases.append(case("invalid-year-message", now="0000-01-01T00:00:00Z"))
    cases.append(
        case(
            "bool-now-is-epoch-second",
            now=True,
            queue={
                "starts": [
                    "1970-01-01T00:00:00Z",
                    "1970-01-01T00:00:01Z",
                    "1970-01-01T00:00:01.000001Z",
                ],
            },
        )
    )
    cases.append(
        case(
            "cooldown-exactly-now-is-int-zero",
            queue={"starts": [], "cooldown_until": "2026-11-09T12:00:00Z"},
        )
    )
    cases.append(
        case(
            "cooldown-subsecond-is-positive-float",
            queue={
                "starts": [],
                "cooldown_until": "2026-11-09T12:00:00.000001Z",
            },
        )
    )
    cases.append(
        case(
            "cooldown-microseconds-use-timedelta-rounding",
            queue={
                "starts": [],
                "cooldown_until": "2026-11-09T12:00:14.380204Z",
            },
        )
    )
    cases.append(
        case(
            "cooldown-over-one-day",
            queue={
                "starts": [],
                "cooldown_until": "2026-11-10T13:00:00Z",
            },
        )
    )
    cases.append(
        case(
            "large-cooldown-total-seconds",
            queue={
                "starts": [],
                "cooldown_until": "2400-01-01T00:00:00.000001Z",
            },
        )
    )
    cases.append(
        case("empty-cooldown-string-is-falsy", queue={"starts": [], "cooldown_until": ""})
    )
    cases.append(
        case(
            "nonempty-list-cooldown-invalid",
            queue={"starts": [], "cooldown_until": ["x"]},
        )
    )
    cases.append(
        case(
            "non-bmp-inputs",
            ledger={
                "schema_version": 1,
                "paths": {"src/😀.py": {"review_count": 1, "last_reviewed_at": None}},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": row(blocked_reason="paused 😀"),
                    "2026-11-09T11:10:00Z": row(blocked_reason=""),
                },
            },
        )
    )
    cases.append(case("missing-observations-key", ledger={"paths": {}}))
    cases.append(case("missing-paths-key", ledger={"observations": {}}))
    cases.append(
        case(
            "missing-blocked-reason",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": {
                        "started": False,
                        "pending": True,
                        "candidate_exists": True,
                    }
                },
            },
        )
    )
    cases.append(
        case(
            "pending-string-sum-type-error",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {"2026-11-09T11:00:00Z": row(pending="x")},
            },
        )
    )
    cases.append(
        case(
            "float-idle-sums-keep-float-tag",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": row(pending=1.0, candidate_exists=2.0),
                },
            },
        )
    )
    cases.append(
        case(
            "mixed-bool-and-float-idle-sum",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": row(pending=True),
                    "2026-11-09T11:10:00Z": row(pending=2.0, candidate_exists=False),
                },
            },
        )
    )
    cases.append(
        case(
            "huge-int-idle-sum-stays-exact",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": row(pending=10**30),
                },
            },
        )
    )
    cases.append(
        case(
            "compensated-float-idle-sum",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    f"2026-11-09T11:{minute:02d}:00Z": row(pending=0.1)
                    for minute in range(10)
                },
            },
        )
    )
    cases.append(
        case(
            "compensated-cancellation-idle-sum",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": row(pending=1e16),
                    "2026-11-09T11:10:00Z": row(pending=1.0),
                    "2026-11-09T11:20:00Z": row(pending=-1e16),
                },
            },
        )
    )
    cases.append(
        case(
            "generic-sum-after-int-overflow",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": row(pending=2**64),
                    "2026-11-09T11:10:00Z": row(pending=-(2**64)),
                    "2026-11-09T11:20:00Z": row(pending=1e16),
                    "2026-11-09T11:30:00Z": row(pending=1.0),
                    "2026-11-09T11:40:00Z": row(pending=-1e16),
                },
            },
        )
    )
    cases.append(
        case(
            "generic-sum-after-int-overflow-float-second",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": row(pending=2**63),
                    "2026-11-09T11:10:00Z": row(pending=0.0),
                    "2026-11-09T11:20:00Z": row(pending=-(2**63) * 1.0),
                    "2026-11-09T11:30:00Z": row(pending=1e16),
                    "2026-11-09T11:40:00Z": row(pending=1.0),
                    "2026-11-09T11:50:00Z": row(pending=-1e16),
                },
            },
        )
    )
    cases.append(
        case(
            "generic-sum-after-operand-overflow",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": row(pending=-1),
                    "2026-11-09T11:10:00Z": row(pending=2**63),
                    "2026-11-09T11:20:00Z": row(pending=-(2**63) + 1),
                    "2026-11-09T11:30:00Z": row(pending=1e16),
                    "2026-11-09T11:40:00Z": row(pending=1.0),
                    "2026-11-09T11:50:00Z": row(pending=-1e16),
                },
            },
        )
    )
    cases.append(
        case(
            "mixed-large-int-float-idle-sum",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": row(pending=10**30),
                    "2026-11-09T11:10:00Z": row(pending=0.5),
                },
            },
        )
    )
    cases.append(
        case(
            "mixed-float-large-int-idle-sum",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": row(pending=0.5),
                    "2026-11-09T11:10:00Z": row(pending=10**30),
                },
            },
        )
    )
    cases.append(
        case(
            "huge-int-float-idle-overflow",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": row(pending=10**400),
                    "2026-11-09T11:10:00Z": row(pending=0.5),
                },
            },
        )
    )
    cases.append(
        case(
            "float-huge-int-idle-overflow",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": row(pending=0.5),
                    "2026-11-09T11:10:00Z": row(pending=10**400),
                },
            },
        )
    )
    cases.append(
        case(
            "bool-int-idle-sum-stays-int",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": row(pending=True),
                    "2026-11-09T11:10:00Z": row(pending=2),
                },
            },
        )
    )
    cases.append(
        case(
            "float-bool-idle-sum",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": row(pending=0.5, candidate_exists=False),
                    "2026-11-09T11:10:00Z": row(pending=False, candidate_exists=True),
                },
            },
        )
    )
    cases.append(case("utc-conversion-overflow-high", now="9999-12-31T23:00:00-05:00"))
    cases.append(case("utc-conversion-overflow-low", now="0001-01-01T00:00:00+01:00"))
    cases.append(case("utc-conversion-valid-high", now="9999-12-31T23:00:00Z"))
    cases.append(case("cutoff-underflow-low", now="0001-01-01T00:00:00Z"))
    cases.append(
        case(
            "cutoff-valid-boundary",
            now="0001-01-02T00:00:00Z",
            queue={
                "starts": ["0001-01-01T00:00:00Z", "0001-01-02T00:00:00Z"],
            },
        )
    )
    cases.append(
        case(
            "start-timestamp-overflow",
            queue={"starts": ["9999-12-31T23:00:00-05:00"]},
        )
    )
    cases.append(
        case(
            "observation-timestamp-overflow",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {"9999-12-31T23:00:00-05:00": row()},
            },
        )
    )
    cases.append(
        case(
            "observation-timestamp-valid-high",
            now="9999-12-31T23:00:00Z",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {"9999-12-31T23:00:00Z": row()},
            },
        )
    )
    cases.append(
        case(
            "cooldown-utc-overflow",
            queue={"starts": [], "cooldown_until": "9999-12-31T23:00:00-05:00"},
        )
    )
    cases.append(
        case(
            "missing-blocked-reason-with-invalid-timestamp",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": {
                        "started": False,
                        "pending": True,
                        "candidate_exists": True,
                    },
                    "junk": row(),
                },
            },
        )
    )
    cases.append(
        case(
            "invalid-pending-with-invalid-cooldown",
            queue={"starts": [], "cooldown_until": "junk"},
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {"2026-11-09T11:00:00Z": row(pending="x")},
            },
        )
    )
    cases.append(
        case(
            "invalid-candidate-before-invalid-pending",
            ledger={
                "schema_version": 1,
                "paths": {},
                "runs": {},
                "observations": {
                    "2026-11-09T11:00:00Z": row(pending=True, candidate_exists="x"),
                    "2026-11-09T11:10:00Z": row(pending="x", candidate_exists=True),
                },
            },
        )
    )
    cases.append(case("naive-now-refused", now="2026-11-09T12:00:00"))
    cases.append(case("arbitrary-separator-is-zoned", now="2026-11-09X12:00:00Z"))
    cases.append(case("naive-arbitrary-separator-refused", now="2026-11-09X12:00:00"))
    cases.append(case("date-only-with-offset-is-naive", now="2026-11-09+00:00"))
    cases.append(case("week-date-with-zone-is-naive", now="2026-W45-1Z"))
    cases.append(case("malformed-now-refused", now="junk"))
    cases.append(case("date-only-with-zone-is-naive", now="2026-11-09Z"))
    cases.append(case("infinity-now-overflow", now=float("inf")))
    cases.append(case("nan-now-value-error", now=float("nan")))
    cases.append(case("year-out-of-range", now=1e15))
    # fromtimestamp(1e18) fails inside the libc gmtime call, so str(OSError)
    # is the host errno text (glibc records "[Errno 75] Value too large for
    # defined data type"; other libcs report a different string). Record the
    # exception class only; the differential runner skips the message for
    # this case, keeping --check byte-identical on every host.
    platform_time_error = case("platform-time-error", now=1e18)
    del platform_time_error["expect"]["message"]
    cases.append(platform_time_error)
    return _family(
        "utilization",
        cases,
        # Interpreter requirement for fractional-zero-offset-is-applied:
        # CPython gh-152079 (commit 6f9c76d8d869, first released in
        # 3.14.7; present in 3.15+). Pre-3.14.7 fromisoformat drops the
        # fraction of a zero-whole-second offset, so 3.14.4 computes
        # starts_24h=0 for that case instead of 1. CI's floating '3.14'
        # pin observed 3.14.10; generated on 3.15.0.
        "coverage utilization digest edges; the "
        "fractional-zero-offset-is-applied case requires CPython >= 3.14.7 "
        "(gh-152079, commit 6f9c76d8d869) or >= 3.15; pre-3.14.7 fromisoformat "
        "drops the fraction of a zero-whole-second offset. "
        "CI observed 3.14.10; generated on 3.15.0",
    )


# ------------------------------------------------------------ publish sections


def publish_sections_family() -> Dict[str, Any]:
    """`status_summary.publish` utilization/schedule assembly and its refusals.

    The real publisher runs with its effect seams patched: the systemd probe,
    the repair digest, finding triage, the previous-summary read and the `gh`
    title lookup. The `utilization` and `schedule` values therefore come from
    the unmodified module, and a refusal is the publisher's own exception.

    `input.core` is the publisher's prelude after the receipt-aware
    `merged_current` replacement: the same document the TypeScript
    `readSummaryCore` returns. `expect.bytes` is the exact compact
    reserialisation of the two sections in publish order, and
    `expect.full_bytes` appends them to that core.
    """
    cases: List[Dict[str, Any]] = []
    fixed_now = _epoch("2026-11-09T12:00:00Z")

    def prelude(queue, config, events, at):
        generated = _utc_iso(at)
        base = status_summary.summarize(
            {"generated_at": generated},
            queue,
            {"last_tick": queue.get("last_tick")},
            config,
            events,
            at,
        )
        core = dict(base)
        core["schema_version"] = 2
        core["generated_at"] = generated
        return core

    def observation(**overrides: Any) -> Dict[str, Any]:
        value = {
            "started": False,
            "pending": True,
            "candidate_exists": True,
            "blocked_reason": None,
        }
        value.update(overrides)
        return value

    def case(
        name: str,
        *,
        queue: Dict[str, Any],
        config: Dict[str, Any] | None = None,
        schedule: Dict[str, Any] | None = None,
        events: List[Dict[str, Any]] | None = None,
        now: float = fixed_now,
    ) -> Dict[str, Any]:
        config = (
            {"repo": "owner/repo", "max_starts_per_hour": 8} if config is None else config
        )
        schedule = {"status": "systemd"} if schedule is None else schedule
        events = list(events or [])
        inputs = {
            "core": prelude(queue, config, events, now),
            "queue": queue,
            "config": config,
            "schedule": schedule,
            "now": now,
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "state").mkdir()
            with (root / "state/events.jsonl").open("w") as fh:
                for event in events:
                    fh.write(json.dumps(event) + "\n")
            try:
                with unittest.mock.patch.object(
                    status_summary, "systemd_activity", return_value=({}, {})
                ), unittest.mock.patch.object(
                    status_summary.repair_tick, "digest", return_value={}
                ), unittest.mock.patch.object(
                    status_summary, "finding_triage", return_value={}
                ), unittest.mock.patch.object(
                    status_summary, "read", side_effect=OSError("no previous summary")
                ), unittest.mock.patch.object(
                    status_summary, "command", side_effect=OSError("no gh")
                ), unittest.mock.patch.dict(
                    os.environ, {"XDG_STATE_HOME": str(root)}
                ):
                    data = status_summary.publish(
                        root, queue, config, schedule, home=root, now=now
                    )
            except Exception as exc:  # the oracle refusal is part of the contract
                expect = {"ok": False, "error": type(exc).__name__, "message": str(exc)}
            else:
                # Keep the publisher's own core in its own key order; on success
                # `data` carries the receipt-aware `merged_current` replacement.
                core = {key: data[key] for key in inputs["core"]}
                # Strip the S3c review_metrics block from the A1-scoped core
                # (see _a1_keys); the TS summary-core oracle predates it.
                core.pop("review_metrics", None)
                inputs["core"] = core
                sections = {
                    "utilization": data["utilization"],
                    "schedule": data["schedule"],
                }
                full = {key: core[key] for key in core}
                full["utilization"] = sections["utilization"]
                full["schedule"] = sections["schedule"]
                expect = {
                    "ok": True,
                    "value": sections,
                    "bytes": _compact(sections),
                    "full_bytes": _compact(full),
                }
        return {
            "name": name,
            "source": "status_summary.publish",
            "input": inputs,
            "expect": expect,
        }

    ledger = {
        "schema_version": 1,
        "paths": {
            "src/a.py": {"review_count": 1, "last_reviewed_at": None},
            "src/b.py": {"review_count": 2, "last_reviewed_at": None},
        },
        "runs": {},
        "observations": {
            "2026-11-09T11:00:00Z": observation(blocked_reason="paused"),
            "2026-11-09T11:12:00Z": observation(),
            "2026-11-09T11:24:00Z": observation(
                started=True, pending=False, candidate_exists=True
            ),
            "2026-11-08T11:00:00Z": observation(),
        },
    }
    queue = {
        "items": [],
        "last_tick": "2026-11-09T11:55:00Z",
        "starts": [
            "2026-11-09T11:00:00Z",
            "2026-11-09T11:10:00Z",
            "2026-11-08T11:00:00Z",
        ],
        "cooldown_until": "2026-11-09T12:30:00Z",
        "usage": {"limit": 5},
        "coverage": ledger,
    }
    cases.append(case("utilization-and-schedule", queue=queue))
    cases.append(
        case(
            "pending-item-title-lookup-stays-unresolved",
            queue={
                **queue,
                "items": [
                    {
                        "id": "open",
                        "kind": "open",
                        "state": "pending",
                        "pr": 7,
                        "order": 1,
                    }
                ],
            },
        )
    )
    cases.append(
        case(
            "usage-limit-is-the-utilization-cap",
            queue={**queue, "usage": {"limit": 3}},
        )
    )
    cases.append(
        case(
            "float-config-cap-keeps-float-tag",
            queue={**queue, "usage": {}},
            config={"repo": "owner/repo", "max_starts_per_hour": 5.0},
        )
    )
    cases.append(
        case(
            "default-ledger-when-coverage-missing",
            queue={key: value for key, value in queue.items() if key != "coverage"},
        )
    )
    cases.append(case("default-ledger-when-coverage-empty", queue={**queue, "coverage": {}}))
    cases.append(case("default-ledger-when-coverage-null", queue={**queue, "coverage": None}))
    cases.append(case("default-ledger-when-coverage-empty-list", queue={**queue, "coverage": []}))
    cases.append(
        case(
            "schedule-unknown-adds-error",
            queue=queue,
            schedule={"status": "unknown", "nextRunAt": "2026-11-09T12:12:00Z"},
        )
    )
    cases.append(case("schedule-empty-status-falls-back", queue=queue, schedule={"status": ""}))
    cases.append(case("schedule-null-status-falls-back", queue=queue, schedule={"status": None}))
    cases.append(case("schedule-false-status-falls-back", queue=queue, schedule={"status": False}))
    cases.append(
        case(
            "schedule-missing-status-falls-back",
            queue=queue,
            schedule={"nextRunAt": "2026-11-09T12:12:00Z"},
        )
    )
    cases.append(
        case(
            "custom-schedule-id",
            queue=queue,
            config={
                "repo": "owner/repo",
                "max_starts_per_hour": 8,
                "schedule_id": "other-tick.timer",
            },
        )
    )
    cases.append(
        case(
            "null-schedule-id-is-kept",
            queue=queue,
            config={"repo": "owner/repo", "max_starts_per_hour": 8, "schedule_id": None},
        )
    )
    cases.append(
        case(
            "truthy-string-coverage-is-refused",
            queue={**queue, "coverage": "x"},
        )
    )
    cases.append(
        case(
            "truthy-list-coverage-is-refused",
            queue={**queue, "coverage": [1]},
        )
    )
    cases.append(
        case(
            "no-completed-tick-is-refused",
            queue={key: value for key, value in queue.items() if key != "last_tick"},
        )
    )
    cases.append(
        case(
            "no-completed-tick-precedes-ledger-errors",
            queue={
                key: value
                for key, value in {**queue, "coverage": [1]}.items()
                if key != "last_tick"
            },
        )
    )
    return _family(
        "publish-sections",
        cases,
        "status_summary.publish utilization/schedule sections and refusals",
    )


# ------------------------------------------------------- passthrough summary


def passthrough_summarize_family() -> Dict[str, Any]:
    """Numbers that the lossless reader must pass through unchanged."""
    cases = []

    def case(
        name: str,
        queue: Dict[str, Any],
        *,
        config: Dict[str, Any] | None = None,
        events: List[Dict[str, Any]] | None = None,
        generated_at: str = "2026-11-09T11:55:00Z",
        now: str = "2026-11-09T12:00:00Z",
        core_only: bool = False,
    ) -> Dict[str, Any]:
        inputs = {
            "status": {"generated_at": generated_at},
            "queue": queue,
            "heartbeat": {},
            "config": config or {"repo": "owner/repo", "max_starts_per_hour": 8},
            "events": events or [],
            "now": _epoch(now),
        }
        captured = _capture(
            name,
            "status_summary.summarize",
            inputs,
            lambda: status_summary.summarize(
                inputs["status"],
                inputs["queue"],
                inputs["heartbeat"],
                inputs["config"],
                inputs["events"],
                inputs["now"],
            ),
            reserialize=True,
        )
        if captured["expect"].get("ok"):
            generated = _utc_iso(inputs["now"])
            core = dict(captured["expect"]["value"])
            core["status_as_of"] = generated
            core["schema_version"] = 2
            core["generated_at"] = generated
            captured["expect"]["core_bytes"] = _compact(core)
        if core_only:
            captured["expect"]["core_only"] = True
        return captured

    cases.append(
        case(
            "item-pr-and-generation-bigints",
            {
                "items": [
                    {
                        "id": "big",
                        "kind": "merged",
                        "state": "pending",
                        "pr": BIG,
                        "generation": BIG,
                        "order": 1,
                        "title": "BIG",
                    }
                ]
            },
            generated_at="2026-11-09T11:55:00Z",
        )
    )
    cases.append(
        case(
            "subject-pr-bigint-with-zero-item-pr",
            {
                "items": [
                    {
                        "id": "subject-big",
                        "kind": "merged",
                        "state": "pending",
                        "pr": 0,
                        "subject": {"repo": "owner/repo", "pr": BIG},
                        "order": 1,
                        "title": "SUBJECT",
                    }
                ]
            }
        )
    )
    cases.append(
        case(
            "zero-item-pr-falls-back-to-float-subject",
            {
                "items": [
                    {
                        "id": "float-subject",
                        "kind": "merged",
                        "state": "pending",
                        "pr": 0,
                        "subject": {"repo": "owner/repo", "pr": 5.0},
                        "order": 1,
                    }
                ]
            }
        )
    )
    cases.append(
        case(
            "zero-item-pr-without-subject-is-null",
            {
                "items": [
                    {
                        "id": "zero-pr",
                        "kind": "merged",
                        "state": "pending",
                        "pr": 0,
                        "order": 1,
                    }
                ]
            }
        )
    )
    cases.append(
        case(
            "zero-subject-pr-stays-zero",
            {
                "items": [
                    {
                        "id": "zero-subject",
                        "kind": "merged",
                        "state": "pending",
                        "subject": {"repo": "owner/repo", "pr": 0},
                        "order": 1,
                    }
                ]
            }
        )
    )
    cases.append(
        case(
            "adjacent-bigint-order-sorts-exactly",
            {
                "items": [
                    {
                        "id": "high",
                        "kind": "merged",
                        "state": "pending",
                        "order": BIG,
                        "title": "HIGH",
                    },
                    {
                        "id": "low",
                        "kind": "merged",
                        "state": "pending",
                        "order": NEIGHBOR,
                        "title": "LOW",
                    },
                ]
            }
        )
    )
    cases.append(
        case(
            "local-review-float-generation",
            {
                "items": [
                    {
                        "id": "local",
                        "kind": "local-review",
                        "state": "pending",
                        "generation": 2.0,
                        "created_at": "1970-01-01T00:00:00Z",
                        "order": 1,
                    }
                ]
            },
            generated_at="1970-01-01T01:00:00Z",
            now="1970-01-01T01:00:00Z",
        )
    )
    cases.append(
        case(
            "mixed-order-types-raise-type-error",
            {
                "items": [
                    {"id": "int", "kind": "merged", "state": "pending", "order": 1},
                    {"id": "str", "kind": "merged", "state": "pending", "order": "1"},
                ]
            }
        )
    )
    cases.append(
        case(
            "numeric-title-passthrough",
            {
                "items": [
                    {
                        "id": "title",
                        "kind": "merged",
                        "state": "pending",
                        "title": BIG,
                        "order": 1,
                    }
                ]
            }
        )
    )
    cases.append(
        case(
            "discovery-and-repo-numbers-passthrough",
            {
                "items": [],
                "merged_reconcile": {
                    "represented": BIG,
                    "transient_failures": 2.0,
                    "pages_read": 1,
                },
                "merged_discovery": {"complete": True, "after": "2026-11-08T00:00:00Z"},
                "push_discovery": {
                    "owner/foreign": {"reviewed_tip": BIG},
                },
            },
            config={
                "repo": "owner/repo",
                "max_starts_per_hour": 5,
                "repos": [{"repo": "owner/foreign"}],
            },
        )
    )
    cases.append(
        case(
            "usage-limit-bigint-passthrough",
            {"items": [], "usage": {"limit": BIG}},
            config={"repo": "owner/repo", "max_starts_per_hour": 10},
            generated_at="2026-10-31T00:00:00Z",
            now="2026-10-31T00:00:00Z",
        )
    )
    cases.append(
        case(
            "usage-limit-float-falls-back-to-float-config-cap",
            {"items": [], "usage": {"limit": 5.0}},
            config={"repo": "owner/repo", "max_starts_per_hour": 5.0},
            generated_at="2026-10-31T00:00:00Z",
            now="2026-10-31T00:00:00Z",
            core_only=True,
        )
    )
    return _family("passthrough-summarize", cases, "lossless numeric passthrough cases")


# ------------------------------------------------------- passthrough receipt


def passthrough_receipt_family() -> Dict[str, Any]:
    """Receipt bytes and digests produced by the real Python writer."""
    cases = []

    def terminal(capture: Dict[str, Any], **overrides: Any) -> Dict[str, Any]:
        document = {
            "version": 1,
            "source": SUBJECT,
            "capture": capture,
            "outcome": "terminal-with-findings",
            "counted": True,
            "classification": {"counted": True, "outcome": "completed"},
        }
        document.update(overrides)
        return document

    def case(
        name: str,
        queue_capture: Dict[str, Any],
        receipt_document: Dict[str, Any],
    ) -> Dict[str, Any]:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rid = _receipt(root, receipt_document)
            raw = (root / f"{rid}.json").read_bytes()
            queue = {
                "items": [
                    {
                        "kind": "merged-current",
                        "state": "done",
                        "subject": SUBJECT,
                        "capture": queue_capture,
                        "receipt_id": rid,
                    }
                ]
            }
            inputs = {
                "queue": queue,
                "receipt_bytes": {rid: base64.b64encode(raw).decode("ascii")},
            }
            return _capture(
                name,
                "status_summary.merged_current",
                inputs,
                lambda: status_summary.merged_current(queue, root),
                reserialize=True,
            )

    float_paths = [{"path": "x.py", "disposition": "included", "bytes": 5.0}]
    float_capture = _capture_document(float_paths)
    cases.append(
        case("float-path-bytes-verified", float_capture, terminal(float_capture))
    )
    int_paths = [{"path": "x.py", "disposition": "included", "bytes": BIG}]
    int_capture = _capture_document(int_paths)
    cases.append(case("bigint-path-bytes-verified", int_capture, terminal(int_capture)))
    equal_capture = _capture_document(float_paths, extra=1.0)
    cases.append(
        case("extra-float-equal-verified", equal_capture, terminal(equal_capture))
    )
    queue_extra = _capture_document(float_paths, extra=BIG)
    receipt_extra = _capture_document(float_paths, extra=NEIGHBOR)
    cases.append(
        case(
            "extra-adjacent-bigints-unverified",
            queue_extra,
            terminal(receipt_extra),
        )
    )
    queue_lexeme = _capture_document(
        [{"path": "x.py", "disposition": "included", "bytes": 5}]
    )
    receipt_lexeme = _capture_document(float_paths)
    cases.append(
        case(
            "queue-path-lexeme-differs-unverified",
            queue_lexeme,
            terminal(receipt_lexeme),
        )
    )
    cases.append(
        case(
            "version-float-is-equal-verified",
            float_capture,
            terminal(float_capture, version=1.0),
        )
    )
    cases.append(
        case(
            "version-bool-is-equal-verified",
            float_capture,
            terminal(float_capture, version=True),
        )
    )
    cases.append(
        case(
            "version-string-is-unverified",
            float_capture,
            terminal(float_capture, version="1"),
        )
    )
    cases.append(
        _capture(
            "current-equivalence-float-digest",
            "review_receipt.current_equivalence",
            {"capture": float_capture},
            lambda: {"digest": review_receipt.current_equivalence(float_capture)},
        )
    )
    cases.append(
        _capture(
            "current-equivalence-bigint-digest",
            "review_receipt.current_equivalence",
            {"capture": int_capture},
            lambda: {"digest": review_receipt.current_equivalence(int_capture)},
        )
    )
    cases.append(
        _capture(
            "path-digests-distinguish-int-and-float",
            "review_receipt.digest",
            {"float_paths": float_paths, "bigint_paths": int_paths},
            lambda: {
                "float": review_receipt.digest(float_paths),
                "bigint": review_receipt.digest(int_paths),
            },
        )
    )
    return _family("passthrough-receipt", cases, "real receipt bytes and numeric identity")


# ------------------------------------------------------------ numeric lineage


def numeric_lineage_family() -> Dict[str, Any]:
    """Pure `merged_current` reuse lineage with Python numeric dict keys."""
    paths = [{"path": "x.py", "disposition": "included"}]
    capture = _capture_document(paths)
    document = {
        "version": 1,
        "source": SUBJECT,
        "capture": capture,
        "outcome": "terminal-with-findings",
        "counted": True,
        "classification": {"counted": True, "outcome": "completed"},
    }
    reused = {**capture, "captured_at": "later", "base": "c" * 40}
    reused["equivalence"] = review_receipt.current_equivalence(reused)
    reused_capture = reused
    cases = []

    def item(item_id: Any, reused_from: Any = None, *, reused: bool = False) -> Dict[str, Any]:
        value = {
            "id": item_id,
            "kind": "merged-current",
            "state": "done",
            "subject": SUBJECT,
            "capture": reused_capture if reused else capture,
        }
        if reused_from is not None:
            value["reused_from"] = reused_from
        return value

    def case(name: str, items: List[Dict[str, Any]]) -> Dict[str, Any]:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rid = _receipt(root, document)
            queue = {
                "items": [
                    {"receipt_id": rid, **entry}
                    for entry in items
                ]
            }
            raw = (root / f"{rid}.json").read_bytes()
            inputs = {
                "queue": queue,
                "receipt_bytes": {rid: base64.b64encode(raw).decode("ascii")},
            }
            return _capture(
                name,
                "status_summary.merged_current",
                inputs,
                lambda: status_summary.merged_current(queue, root),
                reserialize=True,
            )

    cases.append(
        case(
            "numeric-int-id-and-reused-from",
            [item(1), item("reused", 1, reused=True)],
        )
    )
    cases.append(
        case(
            "numeric-int-float-equivalent-id",
            [item(1), item("reused", 1.0, reused=True)],
        )
    )
    cases.append(
        case(
            "numeric-bool-equivalent-id",
            [item(True), item("reused", 1, reused=True)],
        )
    )
    cases.append(
        case(
            "numeric-adjacent-bigint-lineage",
            [
                item(BIG),
                item(NEIGHBOR, BIG, reused=True),
                item("reused", NEIGHBOR, reused=True),
            ],
        )
    )
    cases.append(
        case(
            "numeric-unhashable-reused-from-is-unverified",
            [item(1), item("reused", [1], reused=True)],
        )
    )
    return _family("numeric-lineage", cases, "numeric reuse lineage dict-key parity")


# --------------------------------------------------------------------- numeric


def numeric_family() -> Dict[str, Any]:
    """Python `==`, `<` and `>` over JSON numeric texts, including specials."""
    cases = []

    def case(name: str, a_text: str, b_text: str) -> Dict[str, Any]:
        a = json.loads(a_text)
        b = json.loads(b_text)
        try:
            compare = int(a > b) - int(a < b)
            expect = {"equal": a == b, "compare": compare}
        except TypeError:
            expect = {"equal": a == b, "compare": None, "error": "TypeError"}
        return _capture(
            name,
            "python.numeric_compare",
            {"a": a_text, "b": b_text},
            lambda: expect,
        )

    cases.append(case("int-float-equal", "1", "1.0"))
    cases.append(case("bigint-float-exact", str(NEIGHBOR), f"{NEIGHBOR}.0"))
    cases.append(case("adjacent-bigint-float-greater", str(BIG), f"{NEIGHBOR}.0"))
    cases.append(case("adjacent-bigint-sort-reverse", str(NEIGHBOR), str(BIG)))
    cases.append(case("bool-int-equal", "true", "1"))
    cases.append(case("bool-float-equal", "false", "0.0"))
    cases.append(case("negative-zero-equal", "-0.0", "0"))
    cases.append(case("float-equal", "0.1", "0.1"))
    cases.append(case("float-less", "0.1", "0.2"))
    cases.append(case("infinity-pair", "1e400", "1e400"))
    cases.append(case("infinity-greater-than-bigint", "1e400", str(BIG)))
    cases.append(case("negative-infinity-less-than-bigint", "-1e400", f"-{BIG}"))
    cases.append(case("negative-infinity-less-than-infinity", "-1e400", "1e400"))
    cases.append(case("nan-never-equal", "NaN", "NaN"))
    cases.append(case("nan-vs-int", "NaN", "1"))
    cases.append(case("string-vs-int-type-error", '"x"', "1"))
    cases.append(case("bool-vs-string-type-error", "true", '"1"'))
    cases.append(case("none-vs-int-type-error", "null", "0"))
    return _family("numeric", cases, "Python numeric comparison edges")


def _family(family: str, cases: List[Dict[str, Any]], note: str) -> Dict[str, Any]:
    return {"schema": SCHEMA, "family": family, "note": note, "cases": cases}


def documents() -> Dict[str, Dict[str, Any]]:
    return {
        "summarize": summarize_family(),
        "merged-current": merged_current_family(),
        "client-health": client_health_family(),
        "utilization": utilization_family(),
        "publish-sections": publish_sections_family(),
        "passthrough-summarize": passthrough_summarize_family(),
        "passthrough-receipt": passthrough_receipt_family(),
        "numeric-lineage": numeric_lineage_family(),
        "numeric": numeric_family(),
    }


def _encode(document: Dict[str, Any]) -> str:
    return json.dumps(document, indent=2, ensure_ascii=True) + "\n"


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true", help="regenerate fixtures")
    group.add_argument("--check", action="store_true", help="fail when stale")
    group.add_argument("--stdout", action="store_true", help="print every document")
    args = parser.parse_args(argv)
    docs = documents()
    status = 0
    for family, document in docs.items():
        text = _encode(document)
        path = HERE / f"{family}.json"
        if args.stdout:
            sys.stdout.write(text)
        elif args.write:
            path.write_text(text)
        elif not path.exists() or path.read_text() != text:
            print(f"stale fixture: {path}", file=sys.stderr)
            status = 1
    return status


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
