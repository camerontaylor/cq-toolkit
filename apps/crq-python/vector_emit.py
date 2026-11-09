#!/usr/bin/env python3
"""Deterministic group-P vectors for the crq Python/TypeScript differential.

Test tooling only. Importing this module has no runtime effect, and it is never
imported by crq itself. Vectors record JSON arguments and the exact JSON result
of a pure function, including expected failures. Phase 1 runs the same files in
vitest so a ported implementation is compared against this Python oracle.

Regenerate with ``python3 vector_emit.py --write``, verify with
``python3 vector_emit.py --check``. ``--stdout`` prints all families in one
object and exists so a test can compare bytes from separate processes.

Vector files are written with ``ensure_ascii=True`` and no trailing whitespace,
so regeneration is byte-identical on every host and Python 3.14+ patch level.
No timestamp, host, path or Python version is recorded.
"""
from __future__ import annotations

import argparse
import base64
import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import tempfile
from typing import Any, Callable, Dict, List

import backfill_accounting
import backfill_inventory
import backfill_jobs
import backfill_report
import coverage
import crq
import crq_repair
import merged_reconcile
import queue_time
import review_ledger
import review_receipt
import status_summary
import usage_slots


HERE = Path(__file__).resolve().parent
FIXTURE_ROOT = HERE / "fixtures" / "group-p"
SCHEMA = "cq.crq-group-p-vector/v1"


def _utc(value: dt.datetime | None) -> str | None:
    return None if value is None else value.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _case(name: str, source: str, inputs: Dict[str, Any], *,
          value: Any = None, error: str | None = None, message: str | None = None) -> Dict[str, Any]:
    expect: Dict[str, Any] = {"ok": error is None}
    if error is None:
        expect["value"] = value
    else:
        expect["error"] = error
        if message:
            expect["message"] = message
    return {"name": name, "source": source, "input": inputs, "expect": expect}


def _capture(name: str, source: str, inputs: Dict[str, Any],
             call: Callable[[], Any]) -> Dict[str, Any]:
    try:
        value = call()
    except Exception as exc:  # the vector records the oracle's refusal
        return _case(name, source, inputs, error=type(exc).__name__, message=str(exc))
    return _case(name, source, inputs, value=value)


def _family(family: str, cases: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"schema": SCHEMA, "family": family, "cases": cases}


# --------------------------------------------------------------- canonical


def canonical_vectors() -> Dict[str, Any]:
    def receipt(name: str, value: Any) -> Dict[str, Any]:
        def call():
            raw = review_receipt.canonical(value)
            return {"canonical": raw.decode("ascii"),
                    "sha256": hashlib.sha256(raw).hexdigest()}
        return _capture("receipt-" + name, "review_receipt.canonical+digest",
                        {"value": value}, call)

    def ledger(name: str, value: Any) -> Dict[str, Any]:
        def call():
            raw = review_ledger.canonical(value)
            return {"canonical": raw.decode("utf-8"),
                    "sha256": hashlib.sha256(raw).hexdigest()}
        return _capture("ledger-" + name, "review_ledger.canonical+digest",
                        {"value": value}, call)

    cases = [
        receipt("sorted-keys-and-scalars", {"b": 1, "a": [True, False, None], "c": {"z": "x", "y": 2}}),
        receipt("ascii-escapes-unicode", {"unicode": "雪", "emoji": "😀"}),
        receipt("escapes-controls", {"text": "quote\" backslash\\ newline\n tab\t"}),
        receipt("python-float-repr-is-preserved", {"float": 1.0, "small": 0.1,
                                                   "negative_zero": -0.0, "exponent": 1e20}),
        receipt("large-integers-are-written-in-full", {"safe": 9007199254740991,
                                                       "unsafe": 9007199254740993,
                                                       "wide": 2 ** 63}),
        receipt("empty-containers", {"object": {}, "array": [], "string": ""}),
        receipt("lone-high-surrogate-round-trips-as-an-escape", {"value": "\ud800"}),
        ledger("sorted-keys-and-scalars", {"b": 1, "a": [True, False, None], "c": {"z": "x", "y": 2}}),
        ledger("utf8-without-escapes", {"unicode": "雪", "emoji": "😀", "control": "\u0001"}),
        ledger("utf16be-key-order", {"\uffff": 1, "\U00010000": 2, "a": 3, "\u00e9": 4}),
        ledger("integer-bounds", {"maximum": 9007199254740991, "minimum": -9007199254740991}),
        ledger("float-is-refused", {"bad": 1.5}),
        ledger("integer-beyond-json-range-is-refused", {"bad": 9007199254740992}),
        ledger("non-scalar-unicode-is-refused", {"bad": "\udfff"}),
    ]
    return _family("canonical", cases)


# --------------------------------------------------------------- time


def time_vectors() -> Dict[str, Any]:
    values = [
        ("zulu-seconds", "2026-11-08T00:00:00Z"),
        ("zulu-fraction", "2026-11-08T00:00:00.500Z"),
        ("numeric-offset", "2026-11-08T10:00:00.500+10:00"),
        ("naive-means-utc", "2026-11-08T00:00:00.500"),
        ("compact-run-suffix", "20261108T000000.500Z"),
        ("negative-offset", "2026-11-07T19:00:00-05:00"),
        ("microseconds", "2026-11-08T00:00:00.123456Z"),
        ("non-string", 123),
        ("empty", ""),
        ("garbage", "garbage"),
        ("impossible-month", "2026-13-08T00:00:00Z"),
        ("offset-overflow", "0001-01-01T00:00:00+10:00"),
    ]
    cases = []
    for name, value in values:
        cases.append(_capture(name, "queue_time.parse_utc", {"value": value},
                              lambda value=value: {"utc": _utc(queue_time.parse_utc(value))}))
    for name, value in [
        ("iso-exact-seconds", "2026-11-08T00:00:00Z"),
        ("iso-strips-zero-milliseconds", "2026-11-08T00:00:00.000Z"),
        ("iso-nonzero-fraction-raises", "2026-11-08T00:00:00.500Z"),
        ("iso-six-digit-fraction-raises", "2026-11-08T00:00:00.000000Z"),
        ("iso-offset-raises", "2026-11-08T10:00:00+10:00"),
        ("iso-date-only-raises", "2026-11-08"),
        ("iso-none-is-none", None),
        ("iso-empty-is-none", ""),
    ]:
        cases.append(_capture(name, "crq.parse_iso", {"value": value},
                              lambda value=value: {"utc": _utc(crq.parse_iso(value))}))
    return _family("time", cases)


# --------------------------------------------------------------- usage slots


def usage_vectors() -> Dict[str, Any]:
    streams = [
        ("complete-observation", '{"includedReviews":{"state":"available","limit":10,'
                                 '"remaining":2,"rollingWindowMs":3600000,'
                                 '"fullCapacityInMs":50000,"repository":"owner/repo"}}'),
        ("partial-observation", '{"includedReviews":{"remaining":0}}'),
        ("available-without-limit", '{"includedReviews":{"remaining":10,"limit":10}}'),
        ("unavailable-state", '{"includedReviews":{"state":"unavailable","remaining":3}}'),
        ("boolean-remaining-is-refused", '{"includedReviews":{"remaining":true}}'),
        ("negative-remaining-is-refused", '{"includedReviews":{"remaining":-1}}'),
        ("string-remaining-is-refused", '{"includedReviews":{"remaining":"2"}}'),
        ("limit-below-remaining-is-refused", '{"includedReviews":{"limit":1,"remaining":2}}'),
        ("non-object-event-is-skipped", "null\n[]\n{}"),
        ("bad-line-then-valid-event", 'bad line\n{"includedReviews":{"remaining":4}}'),
        ("empty-stream", ""),
    ]
    cases = []
    for name, stream in streams:
        cases.append(_capture(name, "usage_slots.parse_usage", {"stream": stream},
                              lambda stream=stream: usage_slots.parse_usage(stream)))

    def next_slot(name: str, starts: List[str], at: str, usage: Any) -> Dict[str, Any]:
        inputs = {"starts": starts, "at": at, "usage": usage}

        def call():
            parsed_starts = [queue_time.parse_utc(s) for s in starts]
            parsed_at = queue_time.parse_utc(at)
            return {"utc": _utc(usage_slots.next_slot(parsed_starts, parsed_at, usage))}
        return _capture(name, "usage_slots.next_slot", inputs, call)

    cases += [
        next_slot("no-known-starts-falls-back-to-one-minute", [], "2026-10-28T01:01:00Z", None),
        next_slot("oldest-known-start-rolls-out-first",
                  ["2026-10-28T00:00:00Z", "2026-10-28T00:00:17Z"], "2026-10-28T01:01:00Z",
                  {"remaining": 0, "fullCapacityInMs": 300000, "rollingWindowMs": 3600000}),
        next_slot("vendor-full-capacity-is-not-the-next-slot",
                  ["2026-10-28T01:00:17Z"], "2026-10-28T01:01:00Z", None),
        next_slot("vendor-reservation-lag-waits-one-minute",
                  ["2026-10-28T00:01:00Z"] + ["2026-10-28T00:31:00Z"] * 9,
                  "2026-10-28T01:01:00Z",
                  {"limit": 10, "remaining": 0, "fullCapacityInMs": 1800000}),
        next_slot("usage-just-starts-window", ["2026-10-28T00:01:00Z"],
                  "2026-10-28T01:01:00Z", {"limit": 10, "remaining": 9}),
    ]
    return _family("usage", cases)


# --------------------------------------------------------------- classify


def _classify(name: str, ndjson: str | None, exit_code: int | None) -> Dict[str, Any]:
    inputs = {"ndjson": ndjson, "exit_code": exit_code}

    def call():
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "review.ndjson"
            if ndjson is not None:
                path.write_text(ndjson)
            return crq.classify(path, exit_code)
    return _capture(name, "crq.classify", inputs, call)


def classify_vectors() -> Dict[str, Any]:
    completed = ('{"type":"status","status":"reviewing"}\n'
                 '{"type":"complete","status":"review_completed","reviewedFiles":["a.py","b.py"]}\n')
    cases = [
        _classify("completed-with-reviewed-file-list", completed, 0),
        _classify("completed-with-reviewed-file-count",
                  '{"type":"complete","status":"review_completed","reviewedFiles":3}\n', 0),
        _classify("blocking-finding-is-recorded-with-completion",
                  '{"type":"finding","severity":"major","comment":"fix"}\n'
                  '{"type":"complete","status":"review_completed","reviewedFiles":1}\n', 0),
        _classify("affirmative-no-fresh-completion-is-skipped",
                  '{"type":"complete","status":"review_completed",'
                  '"message":"no fresh detailed review was performed"}\n', 0),
        _classify("complete-status-other-than-review-completed-is-skipped",
                  '{"type":"complete","status":"review_skipped"}\n', 0),
        _classify("recoverable-rate-limit-reports-wait-seconds",
                  '{"type":"error","errorType":"rate_limit","recoverable":true,'
                  '"metadata":{"waitTime":"2 minutes"}}\n', 1),
        _classify("recoverable-rate-limit-without-a-complete-event",
                  '{"type":"error","errorType":"rate_limit","recoverable":true}\n', 0),
        _classify("recoverable-transport-error-is-transient",
                  '{"type":"error","errorType":"network_error","recoverable":true}\n', 1),
        _classify("auth-error-is-an-owner-stop",
                  '{"type":"error","errorType":"auth"}\n', 1),
        _classify("structured-action-required",
                  '{"type":"action_required","status":"awaiting_confirmation"}\n', 0),
        _classify("malformed-line-is-not-proof", '{"type":"finding"}\n{"type":"complete",'
                  '"status":"review_completed"}\n', 0),
        _classify("unparseable-json-is-a-bad-line", '{"type":"complete"\n', 0),
        _classify("missing-exit-is-interrupted",
                  '{"type":"complete","status":"review_completed","reviewedFiles":1}\n', None),
        _classify("nonterminal-last-event-is-interrupted",
                  '{"type":"complete","status":"review_completed","reviewedFiles":1}\n'
                  '{"type":"status","status":"reviewing"}\n', 0),
        _classify("unknown-status-invalidates-completion",
                  '{"type":"status","status":"mystery"}\n'
                  '{"type":"complete","status":"review_completed","reviewedFiles":1}\n', 0),
        _classify("error-plus-complete-conflicts",
                  '{"type":"error","errorType":"network_error","recoverable":true}\n'
                  '{"type":"complete","status":"review_completed"}\n', 1),
        _classify("timeout-exit-is-transient", "", 124),
        _classify("sighup-exit-is-transient", "", 129),
        _classify("empty-existing-stream-is-interrupted", "", 0),
        _classify("absent-stream-is-interrupted", None, 0),
        _classify("unknown-severity-is-counted-under-its-name",
                  '{"type":"finding","severity":"nit","comment":"x"}\n'
                  '{"type":"complete","status":"review_completed","reviewedFiles":1}\n', 0),
    ]
    d2_whitelist = {
        "affirmative-no-fresh-completion-is-skipped",
    }
    for case in cases:
        if case["name"] in d2_whitelist:
            case["note"] = ("D2: the TypeScript port records blocked/retriable "
                            "skipped:no-fresh instead of Python's terminal skipped")
    return _family("classify", cases)


# --------------------------------------------------------------- promotion filter


def promotion_filter_vectors() -> Dict[str, Any]:
    def live(name: str, items: List[Dict[str, Any]]) -> Dict[str, Any]:
        inputs = {"queue": {"items": items}}

        def call() -> Dict[str, Any]:
            return {"live_ids": [item["id"] for item in
                                  crq.live_items({"items": items})]}
        case = _capture(name, "crq.live_items", inputs, call)
        case["note"] = ("Historical promotion records stay on disk but never "
                        "become live scheduling work")
        return case

    cases = [
        live("mixed-queue-excludes-every-promotion-state", [
            {"id": "promotion-done", "kind": "promotion", "state": "done"},
            {"id": "open-1", "kind": "open", "state": "pending"},
            {"id": "promotion-promoting", "kind": "promotion", "state": "promoting"},
            {"id": "merged-1", "kind": "merged", "state": "pending"},
            {"id": "promotion-rejected", "kind": "promotion", "state": "rejected"},
            {"id": "delta-1", "kind": "delta", "state": "pending"},
        ]),
        live("only-promotion-items-are-empty", [
            {"id": "promotion-1", "kind": "promotion", "state": "promoting"},
            {"id": "promotion-2", "kind": "promotion", "state": "done"},
        ]),
        live("missing-kind-is-live", [
            {"id": "legacy", "state": "pending"},
            {"id": "promotion-1", "kind": "promotion", "state": "done"},
        ]),
        live("only-the-exact-kind-is-excluded", [
            {"id": "promotion-final", "kind": "promotion-final", "state": "pending"},
            {"id": "promotion", "kind": "promotion", "state": "pending"},
        ]),
    ]
    return _family("promotion-filter", cases)


# --------------------------------------------------------------- queue bytes


def queue_bytes_vectors() -> Dict[str, Any]:
    def encoded(name: str, value: Any = None, raw: str | None = None) -> Dict[str, Any]:
        inputs = {"raw": raw} if raw is not None else {"value": value}

        def call() -> Dict[str, Any]:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "queue.json"
                crq_repair.atomic(path, json.loads(raw) if raw is not None else value)
                data = path.read_bytes()
            return {"text": data.decode("utf-8"),
                    "sha256": hashlib.sha256(data).hexdigest()}
        return _capture(name, "crq_repair.atomic", inputs, call)

    realistic = {
        "created_at": "2026-11-09T00:00:00Z",
        "items": [{"id": "open-101", "pr": 101, "kind": "open",
                   "state": "pending", "order": 1, "cycles": [],
                   "notes": [], "repair_runs": {}}],
        "starts": ["2026-11-09T11:30:00Z"],
        "paused": False,
        "last_tick": "2026-11-09T11:50:00Z",
        "pause_reason": None,
        "cooldown_until": "2026-11-09T12:15:00Z",
        "rl_backoff_min": 15,
    }
    canonical = json.dumps(realistic, indent=2) + "\n"
    cases = [
        encoded("insertion-order-is-preserved", {"z": 1, "a": 2, "m": {"b": 1, "a": 2}}),
        encoded("ascii-escaping-is-the-default", {"emoji": "😀", "unicode": "雪",
                                                    "control": "\u0001"}),
        encoded("python-float-repr-is-preserved", {"one": 1.0, "tenth": 0.1,
                                                    "negative_zero": -0.0, "exponent": 1e20}),
        encoded("large-integers-are-written-in-full", {"safe": 9007199254740991,
                                                       "wide": 2 ** 63}),
        encoded("empty-containers-and-scalars", {"array": [], "object": {},
                                                 "none": None, "false": False}),
        encoded("realistic-queue-shape", realistic),
        encoded("round-trip-keeps-python-formatted-text", raw=canonical),
        encoded("round-trip-normalizes-compact-input", raw='{"b":1,"a":[1,2]}\n'),
        encoded("lone-surrogate-is-escaped", {"value": "\ud800"}),
        encoded("empty-object", {}),
    ]
    return _family("queue-bytes", cases)


# --------------------------------------------------------------- merged reconcile


def merged_reconcile_vectors() -> Dict[str, Any]:
    cases: List[Dict[str, Any]] = []

    for name, after, before in [
        ("valid-window", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"),
        ("equal-endpoints-refused", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"),
        ("reversed-endpoints-refused", "2026-10-02T00:00:00Z", "2026-10-01T00:00:00Z"),
        ("fractional-seconds-refused", "2026-10-01T00:00:00.5Z", "2026-10-02T00:00:00Z"),
        ("unicode-digits-refused", "２０２６-10-01T00:00:00Z", "2026-10-02T00:00:00Z"),
        ("impossible-date-refused", "2026-02-30T00:00:00Z", "2026-03-01T00:00:00Z"),
        ("non-string-refused", 1, "2026-10-02T00:00:00Z"),
    ]:
        cases.append(_capture(name, "merged_reconcile.normalize_interval",
                              {"after": after, "before": before},
                              lambda after=after, before=before: merged_reconcile.normalize_interval(after, before)))

    for name, budget in [("minimum", 1), ("maximum", 200), ("zero-refused", 0),
                         ("over-maximum-refused", 201), ("boolean-refused", True),
                         ("float-refused", 1.0)]:
        cases.append(_capture(name, "merged_reconcile.normalize_page_budget", {"budget": budget},
                              lambda budget=budget: merged_reconcile.normalize_page_budget(budget)))

    def identity(name: str, record: Any) -> Dict[str, Any]:
        return _capture(name, "merged_reconcile.record_identity", {"record": record},
                        lambda record=record: merged_reconcile.record_identity(record))

    good = {"number": 7, "mergedAt": "2026-10-01T12:00:00Z",
            "mergeCommit": {"oid": "a" * 40}, "headRefOid": "b" * 40}
    cases += [
        identity("valid-record-is-an-intent", good),
        identity("non-object-is-unsupported", []),
        identity("boolean-pr-is-unsupported", {**good, "number": True}),
        identity("zero-pr-is-unsupported", {**good, "number": 0}),
        identity("missing-merged-at-is-unsupported",
                 {k: v for k, v in good.items() if k != "mergedAt"}),
        identity("malformed-merge-commit-is-unsupported", {**good, "mergeCommit": {}}),
        identity("malformed-head-is-unsupported", {**good, "headRefOid": "not-a-sha"}),
        identity("incidental-fields-are-ignored", {**good, "title": "ignored", "author": {"login": "x"}}),
    ]

    digest_value = {"schema_version": 2, "after": "2026-10-01T00:00:00Z",
                    "before": "2026-10-02T00:00:00Z", "cursor": None,
                    "nested": {"b": 1, "a": [2, 3]}}
    cases.append(_capture("digest-excludes-own-field", "merged_reconcile.checkpoint_digest",
                          {"checkpoint": {**digest_value, "digest": "f" * 64}},
                          lambda: merged_reconcile.checkpoint_digest({**digest_value, "digest": "f" * 64})))

    interval = {"after": "2026-10-01T00:00:00Z", "before": "2026-10-02T00:00:00Z"}

    def new_checkpoint() -> Dict[str, Any]:
        return merged_reconcile.new_checkpoint(interval, 10, repo="camerontaylor/cq-toolkit",
                                               base="origin/main")

    cases.append(_capture("new-checkpoint", "merged_reconcile.new_checkpoint",
                          {"interval": interval, "page_budget": 10,
                           "repo": "camerontaylor/cq-toolkit", "base": "origin/main"},
                          new_checkpoint))

    page = [
        {**good, "number": 9, "mergedAt": "2026-10-01T13:00:00Z"},
        {**good, "number": 9, "mergedAt": "2026-10-01T13:00:00Z"},
        {**good, "number": 3, "mergedAt": "2026-09-01T00:00:00Z"},
        {"number": 4, "mergedAt": "2026-10-01T14:00:00Z"},
        {**good, "number": 5, "mergedAt": "2026-10-01T15:00:00Z",
         "mergeCommit": {"oid": "c" * 40}},
        {**good, "number": 6, "mergedAt": "2026-10-01T16:00:00Z",
         "headRefOid": "d" * 40},
        {**good, "number": 8, "mergedAt": "2026-10-01T17:00:00Z",
         "mergeCommit": {"oid": "e" * 40}},
    ]

    def folded() -> Dict[str, Any]:
        checkpoint = new_checkpoint()
        checkpoint = merged_reconcile.reconcile_page(checkpoint, page)
        return merged_reconcile.reconcile_page(checkpoint, [page[0]])

    cases.append(_capture("page-fold-sorts-filters-and-dedupes",
                          "merged_reconcile.reconcile_page",
                          {"checkpoint": new_checkpoint(), "pages": [page, [page[0]]]},
                          folded))

    def built(pages: Dict[Any, Any], budget: int) -> Dict[str, Any]:
        def fetch(cursor):
            return pages[cursor]
        return merged_reconcile.reconcile(None, fetch, repo="camerontaylor/cq-toolkit",
                                          after=interval["after"], before=interval["before"],
                                          page_budget=budget, base="origin/main")

    open_pages = {None: {"records": page, "has_next_page": True,
                         "next_cursor": "cursor-1"}}
    complete_pages = {None: {"records": page, "has_next_page": False,
                             "next_cursor": None}}

    def load(name: str, checkpoint: Dict[str, Any], *, allow_complete: bool = False,
             interval_value: Dict[str, str] = interval) -> Dict[str, Any]:
        return _capture(name, "merged_reconcile.load_checkpoint",
                        {"checkpoint": checkpoint, "interval": interval_value,
                         "page_budget": 1, "repo": "camerontaylor/cq-toolkit",
                         "base": "origin/main", "allow_complete": allow_complete},
                        lambda: merged_reconcile.load_checkpoint(
                            checkpoint, interval_value, 1, repo="camerontaylor/cq-toolkit",
                            base="origin/main", allow_complete=allow_complete))

    open_checkpoint = built(open_pages, 1)
    complete_checkpoint = built(complete_pages, 1)
    cases += [
        load("valid-open-checkpoint", open_checkpoint),
        load("complete-checkpoint-refused-without-flag", complete_checkpoint),
        load("complete-checkpoint-allowed-with-flag", complete_checkpoint, allow_complete=True),
        load("digest-mismatch-refused", {**open_checkpoint, "digest": "0" * 64}),
        load("different-interval-refused", open_checkpoint,
             interval_value={"after": "2026-09-01T00:00:00Z",
                             "before": "2026-10-02T00:00:00Z"}),
    ]
    return _family("merged-reconcile", cases)


# --------------------------------------------------------------- coverage


def coverage_vectors() -> Dict[str, Any]:
    base_ledger = coverage.new_ledger()
    now = "2026-11-09T12:00:00Z"
    queue = {"starts": ["2026-11-09T11:00:00Z", "2026-11-08T11:59:00Z",
                        "2026-11-07T11:00:00Z"],
             "cooldown_until": "2026-11-09T12:15:00Z"}
    ledger = coverage.new_ledger()
    ledger["paths"] = {"a.py": {"review_count": 2, "last_reviewed_at": "2026-11-01T00:00:00Z"}}
    ledger["observations"] = {
        "2026-11-09T10:00:00Z": {"started": True, "pending": True,
                                 "candidate_exists": True, "blocked_reason": None},
        "2026-11-09T10:10:00Z": {"started": False, "pending": True,
                                 "candidate_exists": True, "blocked_reason": None},
        "2026-11-09T10:20:00Z": {"started": False, "pending": True,
                                 "candidate_exists": False, "blocked_reason": "paused"},
        "2026-11-07T10:00:00Z": {"started": False, "pending": True,
                                 "candidate_exists": True, "blocked_reason": None},
    }
    cases = [
        _capture("observed-window-and-cooldown", "coverage.utilization_digest",
                 {"queue": queue, "ledger": ledger, "now": now, "max_starts_per_hour": 5},
                 lambda: coverage.utilization_digest(queue, ledger, now=now, max_starts_per_hour=5)),
        _capture("no-observations-stay-unknown", "coverage.utilization_digest",
                 {"queue": {"starts": []}, "ledger": base_ledger, "now": now,
                  "max_starts_per_hour": 5},
                 lambda: coverage.utilization_digest({"starts": []}, base_ledger, now=now,
                                                    max_starts_per_hour=5)),
        _capture("expired-cooldown-floors-at-zero", "coverage.utilization_digest",
                 {"queue": {"starts": [], "cooldown_until": "2026-11-09T11:00:00Z"},
                  "ledger": base_ledger, "now": now, "max_starts_per_hour": 5},
                 lambda: coverage.utilization_digest(
                     {"starts": [], "cooldown_until": "2026-11-09T11:00:00Z"},
                     base_ledger, now=now, max_starts_per_hour=5)),
        _capture("non-positive-cap-refused", "coverage.utilization_digest",
                 {"queue": queue, "ledger": base_ledger, "now": now,
                  "max_starts_per_hour": 0},
                 lambda: coverage.utilization_digest(queue, base_ledger, now=now,
                                                    max_starts_per_hour=0)),
    ]

    candidate_queue = {
        "items": [
            {"id": "merged-1", "pr": 11, "kind": "merged", "state": "done",
             "merge_commit": "c" * 40, "order": 3,
             "measure": {"merge_queue": "d" * 40,
                         "files": [{"path": "src/a.py", "now": "src/a.py",
                                    "synthetic_added": 2},
                                   {"path": "src/a.py", "now": "src/a.py",
                                    "synthetic_added": 4},
                                   {"path": "src/deep/b.py", "now": "src/deep/b.py",
                                    "synthetic_added": 1}]}},
            {"id": "merged-2", "pr": 12, "kind": "merged", "state": "done",
             "merge_commit": "e" * 40, "order": 4,
             "measure": {"merge_queue": "d" * 40,
                         "files": [{"path": "lib/c.py", "now": "lib/c.py",
                                    "synthetic_added": 1}]}},
        ]
    }
    aged_ledger = coverage.new_ledger()
    aged_ledger["paths"] = {"src/a.py": {"review_count": 1,
                                        "last_reviewed_at": "2026-10-01T00:00:00Z"}}
    cases += [
        _capture("ordinary-eligible-has-no-coverage-candidate",
                 "coverage.coverage_candidate",
                 {"queue": candidate_queue, "ledger": coverage.new_ledger(),
                  "merge_queue_sha": "d" * 40, "ordinary_eligible": True,
                  "now": now, "max_paths": 8, "min_age_hours": 24,
                  "excluded_paths": []},
                 lambda: coverage.coverage_candidate(
                     candidate_queue, coverage.new_ledger(), merge_queue_sha="d" * 40,
                     ordinary_eligible=True, now=now)),
        _capture("oldest-unreviewed-region-is-selected",
                 "coverage.coverage_candidate",
                 {"queue": candidate_queue, "ledger": aged_ledger,
                  "merge_queue_sha": "d" * 40, "ordinary_eligible": False,
                  "now": now, "max_paths": 1, "min_age_hours": 24,
                  "excluded_paths": ["lib"]},
                 lambda: coverage.coverage_candidate(
                     candidate_queue, aged_ledger, merge_queue_sha="d" * 40,
                     ordinary_eligible=False, now=now, max_paths=1,
                     excluded_paths=["lib"])),
        _capture("active-coverage-item-blocks-a-second",
                 "coverage.coverage_candidate",
                 {"queue": {"items": [{"id": "coverage-1", "kind": "coverage",
                                       "state": "reviewing"}]},
                  "ledger": coverage.new_ledger(), "merge_queue_sha": "d" * 40,
                  "ordinary_eligible": False, "now": now, "max_paths": 8,
                  "min_age_hours": 24, "excluded_paths": []},
                 lambda: coverage.coverage_candidate(
                     {"items": [{"id": "coverage-1", "kind": "coverage",
                                 "state": "reviewing"}]},
                     coverage.new_ledger(), merge_queue_sha="d" * 40,
                     ordinary_eligible=False, now=now)),
    ]

    def opportunity() -> Dict[str, Any]:
        return coverage.record_opportunity(base_ledger, at=now, started=False,
                                           pending=True, candidate_exists=True,
                                           blocked_reason=None)

    cases.append(_capture("record-opportunity-is-keyed-by-utc-time",
                          "coverage.record_opportunity",
                          {"ledger": base_ledger, "now": now, "started": False,
                           "pending": True, "candidate_exists": True,
                           "blocked_reason": None}, opportunity))
    return _family("coverage", cases)


# --------------------------------------------------------------- backfill


def backfill_vectors() -> Dict[str, Any]:
    cases: List[Dict[str, Any]] = [
        _capture("empty", "backfill_accounting.ranges", {"lines": []},
                 lambda: backfill_accounting.ranges([])),
        _capture("dedupes-and-coalesces", "backfill_accounting.ranges",
                 {"lines": [5, 1, 2, 2, 9, 10, 11]},
                 lambda: backfill_accounting.ranges([5, 1, 2, 2, 9, 10, 11])),
        _capture("separate-ranges", "backfill_accounting.ranges",
                 {"lines": [1, 3, 5]}, lambda: backfill_accounting.ranges([1, 3, 5])),
        _capture("booleans-sort-with-integers", "backfill_accounting.ranges",
                 {"lines": [True, False, 2]},
                 lambda: backfill_accounting.ranges([True, False, 2])),
    ]

    decision = {
        "at": "2026-11-09T00:00:00Z", "item": "job-1", "ordinary_eligible": False,
        "effective_remaining": 2, "decision": "one-slot-reserve",
        "observation": {"successful": True, "observed_at": "2026-11-08T23:59:00Z",
                        "remaining": 3, "reflected_reservations": [], "extra": "ignored"},
        "reservations": {
            "a": {"quota_state": "reserved", "item": "job-1"},
            "b": {"quota_state": "released", "item": "job-2"},
            "c": {"item": "job-3"},
        },
    }
    cases.append(_capture("summarize-drops-unbounded-fields", "admission_history.summarize",
                          {"decision": decision},
                          lambda: __import__("admission_history").summarize(decision)))

    def admission(name: str, *, ordinary_eligible: bool, observation: Any,
                  reserve: bool = True) -> Dict[str, Any]:
        queue = {"items": [], "backfill_reservations": {}}
        item = {"id": "job-1", "job_id": "job-1", "kind": "backfill", "state": "pending",
                "attempt": 0, "scope": [], "path_lineages": {}}
        inputs = {"queue": queue, "item": item, "at": "2026-11-09T00:00:00Z",
                  "observation": observation, "ordinary_eligible": ordinary_eligible,
                  "reserve": reserve}

        def call():
            local_queue = copy.deepcopy(queue)
            local_item = copy.deepcopy(item)
            result = backfill_jobs.admission(local_queue, local_item, inputs["at"],
                                             observation, ordinary_eligible,
                                             reserve=reserve)
            return {"decision": result, "queue": local_queue, "item": local_item}
        return _capture(name, "backfill_jobs.admission", inputs, call)

    cases += [
        admission("ordinary-work-outranks-rank-4", ordinary_eligible=True,
                  observation=None, reserve=False),
        admission("missing-observation-is-usage-unknown", ordinary_eligible=False,
                  observation=None, reserve=False),
        admission("one-slot-reserve-refuses", ordinary_eligible=False,
                  observation={"successful": True, "observed_at": "2026-11-08T23:59:00Z",
                               "remaining": 1, "reflected_reservations": []}, reserve=False),
        admission("stale-observation-refuses", ordinary_eligible=False,
                  observation={"successful": True, "observed_at": "2026-11-08T20:00:00Z",
                               "remaining": 9, "reflected_reservations": []}, reserve=False),
        admission("admit-and-reserve", ordinary_eligible=False,
                  observation={"successful": True, "observed_at": "2026-11-08T23:59:00Z",
                               "remaining": 5, "reflected_reservations": ["job-1:0"]}),
    ]
    return _family("backfill", cases)


# --------------------------------------------------------------- backfill inventory


INVENTORY_REPO = "example/primary"
INVENTORY_TARGET = "1" * 40
INVENTORY_EVALUATED = "2026-11-09T00:00:00Z"


def _inventory_blob(path: str) -> str:
    return review_ledger.digest({"path": path})[:40]


def _row(path: str, *, tier: str = "T3", lines: int = 1, covered=(),
         bytes_: int = 10, disposition: str = "included", reason: str = "",
         churn: int = 0, findings: int = 0, evidence=()) -> Dict[str, Any]:
    return {"path": path, "blob": _inventory_blob(path), "mode": "100644",
            "bytes": bytes_, "lines": lines, "disposition": disposition,
            "reason": reason, "covered": [list(row) for row in covered],
            "evidence": list(evidence), "churn": churn, "findings": findings,
            "tier": tier}


def _inventory_limits(*, files: int = 8, file_bytes: int = 1000,
                      total: int = 2000) -> Dict[str, Any]:
    return {"version": 1, "construction_version": "fixture-v1",
            "scoring_version": "fixture-v1", "max_files": files,
            "max_file_bytes": file_bytes, "max_total_bytes": total,
            "reviewer": {"verified": True, "evidence": "fixture",
                         "max_files": files, "max_diff_bytes": 2000}}


def _inventory_inputs(objects: List[Dict[str, Any]], *, queue=None,
                      required=None, required_paths=None, limits=None) -> Dict[str, Any]:
    return {"queue": queue if queue is not None else {"items": []},
            "required": required if required is not None else
            {"version": 1, "rows": [], "explicit_unions": []},
            "tiers": {"version": 1},
            "limits": limits if limits is not None else _inventory_limits(),
            "objects": objects,
            "required_paths": required_paths if required_paths is not None else {},
            "ledger": [], "required_members": {}, "evidence_gaps": {},
            "protected_policy": "{}"}


def _inventory_manifest(inputs: Dict[str, Any]) -> Dict[str, Any]:
    snapshots = {key: {"sha256": review_ledger.digest(value), "location": f"fixture/{key}"}
                 for key, value in inputs.items()}
    manifest = {
        "version": backfill_inventory.VERSION, "repo": INVENTORY_REPO,
        "target": INVENTORY_TARGET, "tree": "2" * 40, "ledger_head": "3" * 40,
        "evaluated_at": INVENTORY_EVALUATED, "snapshots": snapshots,
        "git_version": "git version 2.43.0",
        "blame_options": backfill_accounting.BLAME_OPTIONS,
        "construction_version": inputs["limits"]["construction_version"],
        "scoring_version": inputs["limits"]["scoring_version"],
        "limits_version": inputs["limits"]["version"],
        "tiers_version": inputs["tiers"]["version"],
        "git_bundle": {"sha256": "4" * 64, "location": "fixture/git.bundle"},
        "raw_queue": {"sha256": "5" * 64, "location": "fixture/raw-queue"},
        "queue_encoding": "legacy-number-tag/v1",
    }
    manifest["id"] = review_ledger.digest(manifest)
    return manifest


def _inventory_build(objects: List[Dict[str, Any]], **kwargs):
    inputs = _inventory_inputs(objects, **kwargs)
    manifest = _inventory_manifest(inputs)
    return manifest, inputs, backfill_inventory.rank(manifest, inputs)


def _inventory_family(kind: str, names=(), prs=()) -> str:
    source = {"repo": INVENTORY_REPO, "kind": kind, "prs": sorted(prs)}
    if kind == "B":
        source["lineage"] = sorted(names)
    return review_ledger.digest(source)


def _inventory_case(name: str, objects: List[Dict[str, Any]], **kwargs) -> Dict[str, Any]:
    manifest, inputs, _ = _inventory_build(objects, **kwargs)
    return _capture(name, "backfill_inventory.rank",
                    {"manifest": manifest, "inputs": inputs},
                    lambda: backfill_inventory.rank(manifest, inputs))


def backfill_inventory_vectors() -> Dict[str, Any]:
    objects_ordering = [
        _row("apps/crq-python/a.py", tier="T1", lines=2,
             covered=[[1, 1]], bytes_=10),
        _row("src/kernel/b.ts", tier="T2", lines=3, bytes_=20),
        _row("src/new.ts", tier="T3", lines=1, bytes_=5),
    ]
    required_ordering = {"version": 1, "rows": [{"row": 1, "pr": 10}],
                         "explicit_unions": []}
    required_paths_ordering = {"10": [{"path": "src/kernel/b.ts"}]}

    objects_score = [
        _row("alpha/a.py", lines=4),
        _row("beta/b.py", lines=2),
        _row("gamma/c.py", lines=3),
    ]
    gamma_family = _inventory_family("B", ["gamma/c.py"])

    objects_owned = [_row("src/a.py", lines=6, covered=[[1, 2]]),
                     _row("src/b.py", lines=3)]
    owned_queue = {
        "items": [{"id": "active", "state": "reviewing",
                   "target": INVENTORY_TARGET,
                   "scope": [{"path": "src/a.py", "blob": _inventory_blob("src/a.py"),
                              "intervals": [[3, 3]]}]}],
        "backfill_mapped_ownership": [
            {"target": INVENTORY_TARGET, "path": "src/a.py",
             "blob": _inventory_blob("src/a.py"), "intervals": [[4, 5]]},
            {"target": INVENTORY_TARGET, "path": "src/b.py",
             "blob": _inventory_blob("src/b.py"), "intervals": [[1, 3]]},
        ],
    }

    objects_quarantine = [_row("alpha/a.py"), _row("beta/b.py"),
                          _row("gamma/c.py"), _row("delta/d.py")]
    quarantine_queue = {
        "items": [],
        "backfill_families": {
            _inventory_family("B", ["alpha/a.py"]): {"quarantined": True},
            _inventory_family("B", ["beta/b.py"]): {
                "next_eligible_at": "2026-12-01T00:00:00Z"},
            _inventory_family("B", ["delta/d.py"]): {
                "next_eligible_at": "2026-10-01T00:00:00Z"},
        },
        "backfill_scope_failures": {"gamma/c.py": {"quarantined": True}},
    }

    objects_files = [_row("src/a.py"), _row("src/b.py"),
                     _row("src/c.py"), _row("src/huge.py", bytes_=60)]
    objects_bytes = [_row("src/a.py", bytes_=60), _row("src/b.py", bytes_=60),
                     _row("src/c.py", bytes_=30)]

    required_union = {"version": 1,
                      "rows": [{"row": 1, "pr": 10}, {"row": 2, "pr": 11},
                               {"row": 3, "pr": 12}],
                      "explicit_unions": [[10, 11]]}
    required_paths_union = {
        "10": [{"path": "src/a.py"},
               {"path": "docs/deleted.md", "disposition": "deleted",
                "deletion_evidence": ["commit:fixture"]}],
        "11": [{"path": "src/b.py"}, {"path": "src/c.py"}],
    }
    objects_union = [_row("src/a.py", lines=2),
                     _row("src/b.py", lines=0, bytes_=0, disposition="empty"),
                     _row("src/c.py", disposition="unsupported")]

    generation_objects = [_row("src/a.py", lines=2)]
    manifest_one, inputs_one, first = _inventory_build(generation_objects)
    del manifest_one, inputs_one
    candidate = first["candidates"][0]
    generation_queue = {
        "items": [{"id": "old-job", "state": "blocked",
                   "inventory_subject_id": candidate["subject_id"],
                   "generation": 0}],
        "backfill_families": {candidate["family"]: {"failures": 1}},
    }
    generation_manifest, generation_inputs, generation_result = _inventory_build(
        generation_objects, queue=generation_queue)

    cases = [
        _inventory_case("ordering-tier-before-required", objects_ordering,
                        required=required_ordering,
                        required_paths=required_paths_ordering),
        _inventory_case("ordering-score-then-retry", objects_score,
                        queue={"items": [],
                               "backfill_families": {gamma_family: {"failures": 2}}}),
        _inventory_case("ownership-subtracts-active-and-mapped-scope", objects_owned,
                        queue=owned_queue),
        _inventory_case("quarantine-and-future-eligibility-suppress", objects_quarantine,
                        queue=quarantine_queue),
        _inventory_case("partition-file-limit-skips-oversize-file", objects_files,
                        limits=_inventory_limits(files=2, file_bytes=50, total=1000)),
        _inventory_case("partition-byte-limit-splits-cluster", objects_bytes,
                        limits=_inventory_limits(files=8, file_bytes=1000, total=100)),
        _inventory_case("required-union-evidence-outcomes-and-missing", objects_union,
                        required=required_union,
                        required_paths=required_paths_union),
        _case("previous-job-increments-generation",
              "backfill_inventory.rank",
              {"manifest": generation_manifest, "inputs": generation_inputs},
              value=generation_result),
    ]
    return _family("backfill-inventory", cases)


# --------------------------------------------------------------- backfill accounting


def _b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def backfill_accounting_vectors() -> Dict[str, Any]:
    cases: List[Dict[str, Any]] = []

    for name, data in [
        ("empty", b""),
        ("single-newline", b"\n"),
        ("one-line-trailing-newline", b"a\n"),
        ("one-line-without-newline", b"a"),
        ("blank-line-preserved", b"a\n\n"),
        ("crlf-keeps-carriage-return", b"a\r\n"),
        ("non-utf8-bytes", b"\xff\n"),
    ]:
        cases.append(_capture(name, "backfill_accounting.line_bytes",
                              {"base64": _b64(data)},
                              lambda data=data: [_b64(row) for row in
                                                 backfill_accounting.line_bytes(data)]))

    for name, value, low in [
        ("zero-is-int", 0, 0), ("one-is-int", 1, 0), ("negative-is-not", -1, 0),
        ("boolean-is-not-int", True, 0), ("float-is-not-int", 1.0, 0),
        ("string-is-not-int", "1", 0), ("none-is-not-int", None, 0),
        ("low-bound-is-inclusive", 2, 2), ("below-low-bound", 1, 2),
    ]:
        cases.append(_capture(name, "backfill_accounting._int",
                              {"value": value, "low": low},
                              lambda value=value, low=low: backfill_accounting._int(value, low)))

    for name, value in [("none-is-optional", None), ("string-is-optional", "x"),
                        ("number-is-not", 1), ("boolean-is-not", True),
                        ("list-is-not", [])]:
        cases.append(_capture(name, "backfill_accounting._opt_str", {"value": value},
                              lambda value=value: backfill_accounting._opt_str(value)))

    for name, value in [
        ("valid-rows", [[1, 2], [3, 5]]), ("zero-start-invalid", [[0, 1]]),
        ("zero-end-invalid", [[1, 0]]), ("three-columns-invalid", [[1, 2, 3]]),
        ("boolean-invalid", [[True, 2]]), ("not-a-list-invalid", "x"),
        ("empty-is-valid", []),
    ]:
        cases.append(_capture(name, "backfill_accounting._rows", {"value": value},
                              lambda value=value: backfill_accounting._rows(value)))

    for name, value in [("empty-hex-is-valid", ""), ("one-byte-hex", "00"),
                        ("two-byte-hex", "abcd"), ("odd-length-invalid", "abc"),
                        ("uppercase-invalid", "ABCD"), ("non-hex-invalid", "zz"),
                        ("space-invalid", "ab cd")]:
        cases.append(_capture(name, "backfill_accounting._hexstr", {"value": value},
                              lambda value=value: backfill_accounting._hexstr(value)))

    def fact(name: str, kind: str, value: Any) -> Dict[str, Any]:
        return _capture(name, "backfill_accounting.FACT_SHAPES",
                        {"kind": kind, "value": value},
                        lambda kind=kind, value=value:
                        backfill_accounting.FACT_SHAPES[kind](value))

    cases += [
        fact("blame-valid", "blame", [["a" * 40, 1, "abcd", "ef01"]]),
        fact("blame-wrong-width", "blame", [["a" * 40, 1, "abcd"]]),
        fact("blame-boolean-line", "blame", [["a" * 40, True, "abcd", "ef01"]]),
        fact("blame-odd-hex", "blame", [["a" * 40, 1, "abc", "ef01"]]),
        fact("lineage-step-valid", "lineage_step",
             {"parent": "a" * 40, "changes": [["R100", "old.py", "new.py"],
                                              ["D", "gone.py", None]]}),
        fact("lineage-step-extra-key", "lineage_step",
             {"parent": "a" * 40, "changes": [], "extra": 1}),
        fact("lineage-step-bad-change", "lineage_step",
             {"parent": "a" * 40, "changes": [["D", "gone.py"]]}),
        fact("lineage-null-valid", "lineage", {"path": None}),
        fact("lineage-string-valid", "lineage", {"path": "src/a.py"}),
        fact("lineage-extra-key", "lineage", {"path": "src/a.py", "extra": 1}),
        fact("carry-valid", "carry",
             {"path": "src/a.py", "old_lines": 3, "matches": [[1, 2], [3, 4]]}),
        fact("carry-start-beyond-old-lines", "carry",
             {"path": "src/a.py", "old_lines": 2, "matches": [[3, 4]]}),
        fact("carry-boolean-line", "carry",
             {"path": "src/a.py", "old_lines": 3, "matches": [[True, 2]]}),
        fact("coverage-valid", "coverage",
             {"covered": {"src/a.py": [[1, 2]]},
              "evidence": {"src/a.py": ["finding-1"]}}),
        fact("coverage-bad-interval", "coverage",
             {"covered": {"src/a.py": [[0, 2]]}, "evidence": {}}),
        fact("coverage-bad-evidence", "coverage",
             {"covered": {}, "evidence": {"src/a.py": [1]}}),
        fact("verified-review-valid", "verified_review", {"src/a.py": [[1, 2]]}),
        fact("verified-review-bad-row", "verified_review", {"src/a.py": [[1]]}),
    ]
    return _family("backfill-accounting", cases)


# --------------------------------------------------------------- backfill report


class _ReportRepo:
    """Deterministic repository stub for report vector inputs.

    The vector carries the answers the report needs, so the report's pure
    accounting can be replayed without Git. Real capture and repository effects
    remain Group E.
    """

    def __init__(self, spec: Dict[str, Any]):
        self.trees = dict(spec.get("tree", {}))
        self.lineages = {(row["old"], row["new"], row["path"]): row.get("result")
                         for row in spec.get("lineage", [])}
        self.deleted = {(row["old"], row["new"], row["path"]): bool(row.get("result"))
                        for row in spec.get("proven_deleted", [])}
        self.carries = {(row["old"], row["new"], row["path"]):
                        (row.get("result"), {int(k): int(v) for k, v in row.get("mapped", [])})
                        for row in spec.get("carry", [])}

    def tree(self, target: str) -> str:
        return self.trees[target]

    def lineage(self, old: str, new: str, path: str):
        return self.lineages.get((old, new, path))

    def proven_deleted(self, old: str, new: str, path: str) -> bool:
        return self.deleted.get((old, new, path), False)

    def carry(self, old: str, new: str, path: str, lines):
        found = self.carries.get((old, new, path))
        if found is None:
            return None, set()
        mapped, matches = found
        return mapped, {matches[number] for number in lines if number in matches}


def _report_baseline(ranked: Dict[str, Any], *, tree: str, policy_digest: str,
                     ledger_head: str, at: str) -> Dict[str, Any]:
    repo = _ReportRepo({"tree": {ranked["target"]: tree}})
    return backfill_report.baseline(repo, ranked, policy_digest, ledger_head, at)


def backfill_report_vectors() -> Dict[str, Any]:
    baseline_ranked = {
        "manifest_id": "a" * 64, "target": "1" * 40,
        "evaluated_at": "2026-11-09T00:00:00Z",
        "candidates": [{"tier": "T1"}, {"tier": "T2"}],
        "required": [{"prs": [10], "row": 1, "missing_source_evidence": [],
                      "paths": []}],
        "evidence_gaps": {},
        "paths": [
            {"path": "src/a.py", "blob": "b" * 40, "tier": "T1",
             "lines": 4, "uncovered": [[1, 2]], "disposition": "included",
             "reason": "tracked regular UTF8 text"},
            {"path": "src/c.py", "blob": "c" * 40, "tier": "T2",
             "lines": 3, "uncovered": [], "disposition": "included",
             "reason": "tracked regular UTF8 text"},
        ],
    }
    baseline_case = _capture(
        "baseline-projects-row-shape-and-digest", "backfill_report.baseline",
        {"ranked": baseline_ranked, "policy_digest": "d" * 64,
         "ledger_head": "e" * 40, "at": "2026-11-09T00:00:00Z",
         "tree": "2" * 40},
        lambda: _report_baseline(baseline_ranked, tree="2" * 40,
                                 policy_digest="d" * 64, ledger_head="e" * 40,
                                 at="2026-11-09T00:00:00Z"))

    mixed_ranked = {
        "manifest_id": "f" * 64, "target": "1" * 40,
        "evaluated_at": "2026-11-09T00:00:00Z",
        "candidates": [{"tier": "T1"}, {"tier": "T2"}],
        "required": [], "evidence_gaps": {},
        "paths": [
            {"path": "src/a.py", "tier": "T1", "lines": 4,
             "uncovered": [[1, 2]], "disposition": "included",
             "reason": "tracked"},
            {"path": "src/b.py", "tier": "T2", "lines": 3,
             "uncovered": [], "disposition": "included", "reason": "tracked"},
            {"path": "src/c.py", "tier": "T1", "lines": 2,
             "uncovered": [[1, 1]], "disposition": "unsupported",
             "reason": "binary"},
            {"path": "src/d.py", "tier": "T3", "lines": 0,
             "uncovered": [], "disposition": "empty", "reason": "empty"},
        ],
    }
    mixed_queue = {
        "items": [
            {"kind": "backfill", "state": "pending"},
            {"kind": "backfill", "state": "publication-pending"},
            {"kind": "coverage", "state": "quarantined"},
            {"kind": "open", "state": "pending"},
        ],
        "backfill_families": {"f1": {"quarantined": True},
                              "f2": {"quarantined": False}},
        "backfill_finding_backlog": {"untriaged": 2},
        "backfill_admissions": [{"at": "2026-11-09T00:00:00Z", "decision": "admit"}],
        "backfill_daily_capacity": {"2026-11-09": {"completed_partitions": 2}},
        "backfill_idle_with_candidate": 1,
    }
    mixed_case = _capture(
        "summary-mixed-tiers-and-operational-counts", "backfill_report.summary",
        {"ranked": mixed_ranked, "queue": mixed_queue, "original": None,
         "repo": {"tree": {}}},
        lambda: backfill_report.summary(_ReportRepo({"tree": {}}), mixed_ranked,
                                        mixed_queue, None))

    original_target = "1" * 40
    current_target = "5" * 40
    original_paths = [
        {"path": "src/a.py", "blob": "b" * 40, "tier": "T1", "lines": 4,
         "uncovered": [[1, 2]], "disposition": "included", "reason": "tracked"},
        {"path": "src/old.py", "blob": "c" * 40, "tier": "T1", "lines": 2,
         "uncovered": [[1, 2]], "disposition": "included", "reason": "tracked"},
        {"path": "src/gone.py", "blob": "d" * 40, "tier": "T1", "lines": 1,
         "uncovered": [[1, 1]], "disposition": "included", "reason": "tracked"},
        {"path": "src/unknown.py", "blob": "e" * 40, "tier": "T1", "lines": 1,
         "uncovered": [[1, 1]], "disposition": "included", "reason": "tracked"},
        {"path": "src/bad.py", "blob": "f" * 40, "tier": "T1", "lines": None,
         "uncovered": [], "disposition": "unsupported", "reason": "binary"},
    ]
    original_ranked = {"manifest_id": "a" * 64, "target": original_target,
                       "evaluated_at": "2026-11-08T00:00:00Z",
                       "candidates": [], "required": [], "evidence_gaps": {},
                       "paths": original_paths}
    original = _report_baseline(original_ranked, tree="7" * 40,
                                policy_digest="8" * 64, ledger_head="9" * 40,
                                at="2026-11-08T00:00:00Z")

    baseline_ranked = {
        "manifest_id": "a" * 64, "target": current_target,
        "evaluated_at": "2026-11-09T00:00:00Z",
        "candidates": [{"tier": "T1"}, {"tier": "T1"}, {"tier": "T2"}],
        "required": [], "evidence_gaps": {},
        "paths": [
            {"path": "src/a.py", "tier": "T1", "lines": 4,
             "uncovered": [[2, 3]], "disposition": "included", "reason": "tracked"},
            {"path": "src/renamed.py", "tier": "T1", "lines": 2,
             "uncovered": [[1, 2]], "disposition": "included", "reason": "tracked"},
            {"path": "src/new.py", "tier": "T1", "lines": 2,
             "uncovered": [[1, 2]], "disposition": "included", "reason": "tracked"},
            {"path": "src/bad.py", "tier": "T1", "lines": None,
             "uncovered": [], "disposition": "unsupported", "reason": "binary"},
        ],
    }
    report_repo = {
        "tree": {current_target: "6" * 40},
        "lineage": [
            {"old": original_target, "new": current_target, "path": "src/a.py",
             "result": "src/a.py"},
            {"old": original_target, "new": current_target, "path": "src/old.py",
             "result": "src/renamed.py"},
            {"old": original_target, "new": current_target, "path": "src/gone.py",
             "result": None},
            {"old": original_target, "new": current_target, "path": "src/unknown.py",
             "result": None},
            {"old": original_target, "new": current_target, "path": "src/bad.py",
             "result": "src/bad.py"},
        ],
        "proven_deleted": [
            {"old": original_target, "new": current_target, "path": "src/gone.py",
             "result": True},
            {"old": original_target, "new": current_target, "path": "src/unknown.py",
             "result": False},
        ],
        "carry": [
            {"old": original_target, "new": current_target, "path": "src/a.py",
             "result": "src/a.py",
             "mapped": [[1, 1], [2, 2], [3, 3], [4, 4]]},
            {"old": original_target, "new": current_target, "path": "src/old.py",
             "result": "src/renamed.py", "mapped": [[1, 1], [2, 2]]},
            {"old": original_target, "new": current_target, "path": "src/bad.py",
             "result": "src/bad.py", "mapped": []},
        ],
    }
    baseline_queue = {
        "items": [{"kind": "backfill", "state": "pending"}],
        "backfill_daily_capacity": {
            "2026-11-08": {"completed_partitions": 2},
            "2026-11-09": {"completed_partitions": 2},
        },
    }
    baseline_case_two = _capture(
        "summary-baseline-surviving-reviewed-removed-and-new",
        "backfill_report.summary",
        {"ranked": baseline_ranked, "queue": baseline_queue,
         "original": original, "repo": report_repo},
        lambda: backfill_report.summary(_ReportRepo(report_repo), baseline_ranked,
                                        baseline_queue, original))

    return _family("backfill-report", [baseline_case, mixed_case, baseline_case_two])


# --------------------------------------------------------------- status helpers


def status_helpers_vectors() -> Dict[str, Any]:
    cases: List[Dict[str, Any]] = []
    for name, value in [("exact-utc", "2026-11-09T00:00:00Z"),
                        ("fraction-accepted", "2026-11-09T00:00:00.5Z"),
                        ("offset-accepted", "2026-11-09T10:00:00+10:00"),
                        ("none-invalid", None), ("number-invalid", 1)]:
        cases.append(_capture(name, "status_summary.timestamp", {"value": value},
                              lambda value=value: {"epoch": status_summary.timestamp(value)}))

    merged_cases = {
        "pending-reviewing-blocked": {
            "items": [
                {"kind": "merged-current", "state": "pending"},
                {"kind": "merged-current", "state": "reviewing"},
                {"kind": "merged-current", "state": "blocked"},
                {"kind": "open", "state": "pending"},
            ],
            "merged_discovery": {"after": "2026-11-08T00:00:00Z",
                                 "before": "2026-11-09T00:00:00Z",
                                 "complete": True},
            "merged_reconcile": {"after": "2026-11-08T00:00:00Z",
                                 "before": "2026-11-09T00:00:00Z",
                                 "complete": True, "pages_read": 2,
                                 "inventory_digest": "a" * 64},
            "merged_watermark": "2026-11-09T00:00:00Z",
        },
        "terminal-without-retained-receipts": {
            "items": [
                {"kind": "merged-current", "state": "done", "receipt_id": "b" * 64},
                {"kind": "merged-current", "state": "no-current-code",
                 "receipt_id": "c" * 64},
                {"kind": "merged-current", "state": "unsupported",
                 "receipt_id": "d" * 64},
            ],
            "merged_discovery": {"complete": False, "reason": "budget"},
        },
    }
    for name, queue in merged_cases.items():
        cases.append(_capture("merged-" + name, "status_summary.merged_current",
                              {"queue": queue},
                              lambda queue=queue: status_summary.merged_current(queue)))

    repos_queue = {
        "items": [
            {"id": "a", "repo": "example/primary", "state": "pending"},
            {"id": "b", "repo": "example/other", "state": "pending"},
            {"id": "c", "repo": "example/other", "state": "reviewing"},
            {"id": "d", "repo": "example/other", "state": "blocked"},
            {"id": "e", "repo": "example/other", "state": "done"},
            {"id": "f", "repo": "example/other", "state": "mystery"},
            {"id": "g", "repo": "example/third", "state": "pending"},
        ],
        "push_discovery": {"example/pushonly": {"reviewed_tip": "a" * 40},
                          "example/primary": {"reviewed_tip": "b" * 40}},
    }
    cases.append(_capture(
        "repos-counts-configured-push-and-other-states", "status_summary.repos_summary",
        {"queue": repos_queue, "primary": "example/primary",
         "configured": [{"repo": "example/other"},
                        {"repo": "example/primary"},
                        {"repo": "example/configured"}]},
        lambda: status_summary.repos_summary(
            repos_queue, "example/primary",
            [{"repo": "example/other"}, {"repo": "example/primary"},
             {"repo": "example/configured"}])))
    return _family("status-helpers", cases)


# --------------------------------------------------------------- ledger


def ledger_vectors() -> Dict[str, Any]:
    cases: List[Dict[str, Any]] = []
    for name, value in [("exact-utc", "2026-11-09T00:00:00Z"),
                        ("fraction-refused", "2026-11-09T00:00:00.5Z"),
                        ("offset-refused", "2026-11-09T10:00:00+10:00"),
                        ("non-string-refused", 1)]:
        cases.append(_capture(name, "review_ledger.timestamp", {"value": value},
                              lambda value=value: review_ledger.timestamp(value).isoformat()))

    for name, value in [("nested-path", "src/ops/crq/tick.ts"),
                        ("unicode-path", "docs/雪.md"),
                        ("absolute-refused", "/etc/passwd"),
                        ("parent-refused", "../outside"),
                        ("backslash-refused", "src\\win.py"),
                        ("empty-refused", "")]:
        cases.append(_capture(name, "review_ledger.path", {"value": value},
                              lambda value=value: review_ledger.path(value)))

    for name, rows in [("single-range", [[1, 3]]),
                       ("adjacent-ranges-merge-into-one-set", [[1, 2], [3, 4]]),
                       ("overlap-refused", [[1, 3], [3, 5]]),
                       ("reversed-refused", [[3, 2]]),
                       ("zero-start-refused", [[0, 1]]),
                       ("boolean-refused", [[True, 2]])]:
        cases.append(_capture(name, "review_ledger.intervals", {"rows": rows},
                              lambda rows=rows: sorted(review_ledger.intervals(rows))))

    scope_rows = [{"path": "a.py", "blob": "a" * 40, "intervals": [[1, 2]]},
                  {"path": "b.py", "blob": "b" * 40, "intervals": [[5, 5]]}]
    cases.append(_capture("scope-keyed-by-path-and-blob", "review_ledger.scope",
                          {"rows": scope_rows},
                          lambda: sorted([list(k) + [sorted(v)] for k, v in
                                          review_ledger.scope(scope_rows).items()])))
    cases.append(_capture("duplicate-scope-refused", "review_ledger.scope",
                          {"rows": scope_rows + [scope_rows[0]]},
                          lambda: review_ledger.scope(scope_rows + [scope_rows[0]])))

    payload = {"family": "job", "subject_id": "subject-1", "job_id": "job-1",
               "generation": 0, "attempt": 0, "state": "pending", "failures": 0,
               "next_eligible_at": None, "reason": "inventory enqueue"}

    def raw_event(kind: str, source_key: str, occurred_at: str,
                  body: Dict[str, Any]) -> Dict[str, Any]:
        value = {"schema": "cq.review-ledger/v1", "event_type": kind,
                 "source_key": source_key, "occurred_at": occurred_at,
                 "payload": body}
        value["id"] = review_ledger.digest(value)
        return value

    good_event = review_ledger.event("job-state", "job:job-1", "2026-11-09T00:00:00Z", payload)
    second_event = review_ledger.event(
        "job-state", "job:job-2", "2026-11-09T00:01:00Z",
        {**payload, "job_id": "job-2", "subject_id": "subject-2"})
    invalid_quarantine = raw_event(
        "job-state", "job:job-2", "2026-11-09T00:00:00Z",
        {**payload, "state": "quarantine-released",
         "job_id": "job-2", "subject_id": "subject-2"})
    conflicting_event = review_ledger.event(
        "job-state", "job:job-1", "2026-11-09T00:01:00Z",
        {**payload, "state": "reviewing"})
    cases += [
        _capture("valid-job-state-event", "review_ledger.validate",
                 {"event": good_event}, lambda: review_ledger.validate(copy.deepcopy(good_event))),
        _capture("tampered-event-id-is-refused", "review_ledger.validate",
                 {"event": {**good_event, "id": "0" * 64}},
                 lambda: review_ledger.validate({**good_event, "id": "0" * 64})),
        _capture("quarantine-release-needs-operator", "review_ledger.validate",
                 {"event": invalid_quarantine},
                 lambda: review_ledger.validate(copy.deepcopy(invalid_quarantine))),
        _capture("sequence-accepts-distinct-events", "review_ledger.validate_sequence",
                 {"events": [good_event, second_event]},
                 lambda: sorted(review_ledger.validate_sequence([good_event, second_event]))),
        _capture("sequence-refuses-source-conflict", "review_ledger.validate_sequence",
                 {"events": [good_event, conflicting_event]},
                 lambda: review_ledger.validate_sequence([good_event, conflicting_event])),
    ]

    creditable = {"event_type": "review", "payload": {
        "outcome": "completed",
        "source": {"type": "crq-run", "producer": "crq-runner-app", "authenticated": True},
        "completion": {"terminal": True, "skipped": False, "scope_verified": True,
                       "exit_code": 0, "errors": []}}}
    cases += [
        _capture("credited-crq-run", "review_ledger.creditable", {"value": creditable},
                 lambda: review_ledger.creditable(creditable)),
        _capture("unauthenticated-review-is-not-credited", "review_ledger.creditable",
                 {"value": {**creditable, "payload": {
                     **creditable["payload"],
                     "source": {**creditable["payload"]["source"], "authenticated": False}}}},
                 lambda: review_ledger.creditable({**creditable, "payload": {
                     **creditable["payload"],
                     "source": {**creditable["payload"]["source"], "authenticated": False}}})),
        _capture("non-review-event-is-not-credited", "review_ledger.creditable",
                 {"value": {"event_type": "job-state", "payload": {}}},
                 lambda: review_ledger.creditable({"event_type": "job-state", "payload": {}})),
    ]
    return _family("ledger", cases)


# --------------------------------------------------------------- summary


def _summary_inputs() -> Dict[str, Any]:
    queue = {
        "items": [
            {"id": "open-1", "repo": "camerontaylor/cq-toolkit", "pr": 101,
             "kind": "open", "state": "pending", "order": 1, "cycles": [],
             "created_at": "2026-11-09T09:00:00Z"},
            {"id": "delta-1", "repo": "camerontaylor/cq-toolkit", "pr": 102,
             "kind": "delta", "state": "pending", "order": 2, "cycles": [],
             "since": "2026-11-09T08:00:00Z"},
            {"id": "merged-1", "repo": "camerontaylor/cq-toolkit", "pr": 103,
             "kind": "merged", "state": "pending", "order": 3, "cycles": []},
            {"id": "current-1", "repo": "camerontaylor/cq-toolkit", "pr": 104,
             "kind": "merged-current", "state": "pending", "order": 4, "cycles": []},
            {"id": "review-1", "repo": "camerontaylor/other", "pr": 7,
             "kind": "local-review", "state": "pending", "order": 5, "cycles": [],
             "generation": 2, "repeat_requested": True,
             "created_at": "2026-11-09T08:30:00Z"},
            {"id": "promotion-1", "repo": "camerontaylor/cq-toolkit", "pr": 105,
             "kind": "promotion", "state": "pending", "order": 6, "cycles": []},
        ],
        "starts": ["2026-11-09T11:30:00Z", "2026-11-09T10:00:00Z"],
        "paused": False,
        "cooldown_until": "2026-11-09T12:15:00Z",
        "last_tick": "2026-11-09T11:50:00Z",
        "usage": {"limit": 6},
        "merged_watermark": "2026-11-08T00:00:00Z",
        "merged_reconcile": {"after": "2026-11-08T00:00:00Z",
                             "before": "2026-11-09T00:00:00Z", "complete": True,
                             "pages_read": 4, "duplicates_seen": 1,
                             "inventory_digest": "f" * 64},
        "push_discovery": {"camerontaylor/other": {"reviewed_tip": "a" * 40}},
    }
    config = {"repo": "camerontaylor/cq-toolkit", "max_starts_per_hour": 5,
              "local_review_aging_minutes": 60,
              "repos": [{"repo": "camerontaylor/other", "rank_tier": 3}]}
    heartbeat = {"last_tick": "2026-11-09T11:50:00Z"}
    events = [
        {"at": "2026-11-09T10:00:00Z", "event": "review_finished",
         "run": "run-1", "item": "open-1", "outcome": "completed"},
        {"at": "2026-11-09T10:05:00Z", "event": "review_finished",
         "run": "run-1", "item": "open-1", "outcome": "completed"},
        {"at": "2026-11-09T10:10:00Z", "event": "review_finished",
         "run": "run-2", "item": "merged-1", "outcome": "error"},
        {"at": "2026-11-09T10:15:00Z", "event": "review_finished",
         "run": "run-3", "item": "unknown", "outcome": "weird"},
    ]
    status = {"generated_at": "2026-11-09T11:55:00Z"}
    return {"status": status, "queue": queue, "heartbeat": heartbeat,
            "config": config, "events": events, "now": 1794225600}


def summary_vectors() -> Dict[str, Any]:
    inputs = _summary_inputs()

    def call() -> Dict[str, Any]:
        return status_summary.summarize(inputs["status"], inputs["queue"],
                                        inputs["heartbeat"], inputs["config"],
                                        inputs["events"], inputs["now"])

    cases = [_capture("mixed-queue-renders-stable-summary",
                      "status_summary.summarize", inputs, call)]

    def invalid_tick() -> Dict[str, Any]:
        queue = copy.deepcopy(inputs["queue"])
        heartbeat = {"last_tick": "not-a-timestamp"}
        return status_summary.summarize(inputs["status"], queue, heartbeat,
                                        inputs["config"], [], inputs["now"])

    cases.append(_capture("invalid-last-tick-is-refused", "status_summary.summarize",
                          {**inputs, "heartbeat": {"last_tick": "not-a-timestamp"}},
                          invalid_tick))

    promotion_inputs = {
        "status": {"generated_at": "2026-11-09T11:55:00Z"},
        "queue": {"items": [
            {"id": "promotion-done", "kind": "promotion", "state": "done",
             "order": 0, "cycles": []},
            {"id": "promotion-promoting", "kind": "promotion", "state": "promoting",
             "order": 1, "cycles": []},
            {"id": "open-1", "repo": "example/primary", "pr": 101,
             "kind": "open", "state": "pending", "order": 2, "cycles": []},
        ], "starts": [], "paused": False,
           "last_tick": "2026-11-09T11:50:00Z"},
        "heartbeat": {"last_tick": "2026-11-09T11:50:00Z"},
        "config": {"repo": "example/primary", "max_starts_per_hour": 5},
        "events": [],
        "now": 1794225600,
    }

    def promotion_summary() -> Dict[str, Any]:
        return status_summary.summarize(
            promotion_inputs["status"], promotion_inputs["queue"],
            promotion_inputs["heartbeat"], promotion_inputs["config"],
            promotion_inputs["events"], promotion_inputs["now"])

    promotion_case = _capture(
        "historical-promotion-items-stay-out-of-summary",
        "status_summary.summarize", promotion_inputs, promotion_summary)
    promotion_case["note"] = (
        "Ceres retains 70 historical promotion items; none may appear as "
        "pending scheduling work or backlog")
    cases.append(promotion_case)
    return _family("summary", cases)


# --------------------------------------------------------------- assembly


BUILDERS: Dict[str, Callable[[], Dict[str, Any]]] = {
    "canonical": canonical_vectors,
    "queue-bytes": queue_bytes_vectors,
    "time": time_vectors,
    "usage": usage_vectors,
    "classify": classify_vectors,
    "promotion-filter": promotion_filter_vectors,
    "merged-reconcile": merged_reconcile_vectors,
    "coverage": coverage_vectors,
    "backfill": backfill_vectors,
    "backfill-inventory": backfill_inventory_vectors,
    "backfill-accounting": backfill_accounting_vectors,
    "backfill-report": backfill_report_vectors,
    "status-helpers": status_helpers_vectors,
    "ledger": ledger_vectors,
    "summary": summary_vectors,
}


def build() -> Dict[str, Any]:
    return {family: builder() for family, builder in BUILDERS.items()}


def encode(document: Dict[str, Any]) -> str:
    return json.dumps(document, indent=2, ensure_ascii=True) + "\n"


def filenames() -> Dict[str, Path]:
    return {family: FIXTURE_ROOT / f"{family}.json" for family in BUILDERS}


def write() -> int:
    FIXTURE_ROOT.mkdir(parents=True, exist_ok=True)
    for family, path in filenames().items():
        path.write_text(encode(build()[family]))
    return 0


def check() -> int:
    failures = 0
    document = build()
    for family, path in filenames().items():
        expected = encode(document[family])
        try:
            actual = path.read_text()
        except OSError as exc:
            print(f"missing vector file {path}: {exc}", flush=True)
            failures += 1
            continue
        if actual != expected:
            print(f"stale vector file {path}", flush=True)
            failures += 1
    return 1 if failures else 0


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--write", action="store_true", help="regenerate fixtures/group-p")
    group.add_argument("--check", action="store_true", help="fail if fixtures are stale")
    group.add_argument("--stdout", action="store_true", help="print all families as one object")
    args = parser.parse_args(argv)
    if args.write:
        return write()
    if args.check:
        return check()
    print(encode(build()), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
