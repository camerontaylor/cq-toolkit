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
import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import tempfile
from typing import Any, Callable, Dict, List

import backfill_accounting
import backfill_jobs
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
        "complete-status-other-than-review-completed-is-skipped",
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
