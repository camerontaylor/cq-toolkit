"""Resumable bounded outage-interval reconciliation (Q2, version 1).

Pure inventory over a frozen interval: page the merged-PR list between
``after`` and a frozen ``before`` upper bound, dedupe by Q1 subject identity,
checkpoint after every page, and report honest totals. This module never
reviews, dispatches, retries vendor work, or mutates the queue: it PROPOSES
merged-current intents (the exact ``review_receipt.enroll`` binding shape)
and the operator/sole-tick applies them.

Invariants:

  * the upper bound (``before``) is frozen at reconcile start; PRs merged
    after it belong to the NEXT interval, never this one's watermark;
  * a page budget is a budget, not a completeness assertion: stopping with
    pages remaining reports ``complete: false`` plus a ``next_cursor``;
  * page boundaries are resumable: the checkpoint (cursor + accumulated
    inventory digest) restarts exactly where the previous run stopped, and
    an overlapping replay window re-reads already-seen PRs without double
    counting (dedupe by source PR number + merge SHA);
  * PRs merged while paging are visible in a later page only if their
    ``mergedAt`` is <= the frozen ``before``; otherwise they are outside
    this interval entirely;
  * transient page failures are retried without advancing the completeness
    watermark; a page that stays unreadable leaves the interval explicitly
    ``incomplete``;
  * every PR is REPRESENTED: ``intent`` (a proposed merged-current subject),
    ``already-covered`` (an equivalent Q1 request exists), or an explicit
    ``unsupported`` reason (empty/missing merge identity, source head gone,
    malformed record) — never silent loss;
  * no historical replay, no vendor calls, no scheduler, no repair.

The page source is injected: production passes a callable that shells to
``gh pr list --state merged``; tests pass fake pages. The callable returns
one page of PR records (dicts with at least number/mergedAt/mergeCommit)
and raises ``PageFailed`` for a transient failure.
"""
from __future__ import annotations

import datetime as dt
import json
import re
from typing import Any, Callable, Dict, List, Optional

VERSION = 1
CHECKPOINT_SCHEMA = 1

# A reconcile checkpoint file records exactly where a bounded run stopped.
CHECKPOINT_NAME = "reconcile-checkpoint.json"

TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")

MAX_PAGE_BUDGET = 200


class ReconcileRefused(Exception):
    """A refused reconcile run: nothing recorded, the reason is terminal."""


class PageFailed(Exception):
    """A transient page read failure; the watermark must not advance."""


# ------------------------------------------------------------- validation


def _timestamp(name: str, value: Any) -> str:
    if not isinstance(value, str) or not TS_RE.match(value):
        raise ReconcileRefused(f"{name} must be an exact UTC timestamp "
                               "YYYY-MM-DDTHH:MM:SSZ")
    try:
        dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        raise ReconcileRefused(f"{name} is not a valid UTC timestamp") from None
    return value


def normalize_interval(after: Any, before: Any) -> Dict[str, str]:
    """Validate and FREEZE the interval. ``before`` is the upper bound for
    the whole run; PRs merged after it are a different interval."""
    after = _timestamp("after", after)
    before = _timestamp("before", before)
    if after >= before:
        raise ReconcileRefused("after must be strictly earlier than before")
    return {"after": after, "before": before}


def normalize_page_budget(budget: Any) -> int:
    if isinstance(budget, bool) or not isinstance(budget, int) or budget < 1:
        raise ReconcileRefused("page budget must be a positive integer")
    if budget > MAX_PAGE_BUDGET:
        raise ReconcileRefused(f"page budget is capped at {MAX_PAGE_BUDGET}")
    return budget


# ------------------------------------------------------- record inspection


def record_identity(page_record: Any) -> Dict[str, Any]:
    """Classify one forge page record into an inventory entry.

    Every record gets exactly one disposition:
      ``intent``      — a well-formed merged PR: proposed merged-current subject
                        (the review_receipt.enroll binding shape, minus request
                        id, which the operator assigns);
      ``unsupported`` — a record that cannot name a source intent (missing/
                        empty merge identity, missing head, malformed number);
    Both are represented in the inventory; nothing is dropped.
    """
    if not isinstance(page_record, dict):
        return {"disposition": "unsupported", "reason": "page record is not an object"}
    pr = page_record.get("number")
    merged_at = page_record.get("mergedAt")
    merge = page_record.get("mergeCommit")
    head = page_record.get("headRefOid")
    if type(pr) is not int or pr <= 0:
        return {"disposition": "unsupported", "reason": "malformed PR number"}
    if not isinstance(merged_at, str) or not TS_RE.match(merged_at):
        return {"disposition": "unsupported", "pr": pr,
                "reason": "missing or malformed mergedAt"}
    if not isinstance(merge, dict) or not SHA_RE.match(merge.get("oid") or ""):
        return {"disposition": "unsupported", "pr": pr,
                "reason": "missing or malformed merge commit identity"}
    if not isinstance(head, str) or not SHA_RE.match(head):
        return {"disposition": "unsupported", "pr": pr,
                "reason": "source head gone or malformed"}
    return {"disposition": "intent", "pr": pr, "merged_at": merged_at,
            "merge_sha": merge["oid"], "head": head,
            "subject": {"repo": None, "pr": pr, "merge_sha": merge["oid"],
                        "target_selector": "promoted-main",
                        "policy": "affected-current-additions-v1"}}


# -------------------------------------------------------------- checkpoint


def new_checkpoint(interval: Dict[str, str], page_budget: int) -> Dict[str, Any]:
    return {"schema_version": CHECKPOINT_SCHEMA,
            "after": interval["after"], "before": interval["before"],
            "page_budget": page_budget,
            "cursor": None, "pages_read": 0,
            "seen": {},           # pr number -> {"merge_sha","merged_at"} dedupe registry
            "inventory": [],      # represented entries in stable order
            "transient_failures": 0,
            "complete": False}


def checkpoint_digest(checkpoint: Dict[str, Any]) -> str:
    import hashlib

    payload = json.dumps(checkpoint, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def load_checkpoint(raw: Any, interval: Dict[str, str], page_budget: int) -> Dict[str, Any]:
    """Validate a resumed checkpoint against the CURRENT run's frozen
    interval. A checkpoint from a different interval or budget is refused
    (start a fresh reconcile instead of silently mixing windows)."""
    if not isinstance(raw, dict) or raw.get("schema_version") != CHECKPOINT_SCHEMA:
        raise ReconcileRefused("checkpoint is not a version "
                               + str(CHECKPOINT_SCHEMA) + " reconcile checkpoint")
    if raw.get("after") != interval["after"] or raw.get("before") != interval["before"]:
        raise ReconcileRefused("checkpoint belongs to a different frozen interval")
    if raw.get("page_budget") != page_budget:
        raise ReconcileRefused("checkpoint was taken with a different page budget")
    for field in ("cursor", "pages_read", "seen", "inventory", "transient_failures",
                  "complete"):
        if field not in raw:
            raise ReconcileRefused("checkpoint missing field: " + field)
    if not isinstance(raw["seen"], dict) or not isinstance(raw["inventory"], list):
        raise ReconcileRefused("checkpoint registry/inventory malformed")
    if raw["complete"]:
        raise ReconcileRefused("checkpoint is already complete; nothing to resume")
    return raw


# ----------------------------------------------------------------- paging


def _stable_page_sort(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Stable order inside one page: mergedAt, then PR number as tie-break
    (same-time merges get a deterministic order)."""
    def key(record):
        merged = record.get("mergedAt") if isinstance(record, dict) else None
        pr = record.get("number") if isinstance(record, dict) else None
        return (merged if isinstance(merged, str) else "", pr if type(pr) is int else 0)
    return sorted(records, key=key)


def _in_window(merged_at: str, interval: Dict[str, str]) -> bool:
    """The frozen upper bound decides membership: a PR merged after
    ``before`` is outside THIS interval even if a page happened to return it
    (clock skew, concurrent merge during paging)."""
    return interval["after"] < merged_at <= interval["before"]


def reconcile_page(checkpoint: Dict[str, Any], page_records: Any) -> Dict[str, Any]:
    """Fold one fetched page into the checkpoint. Pure: returns a NEW
    checkpoint (input is never mutated, so a crashed fold leaves the
    on-disk checkpoint intact for resume).

    Records already in the ``seen`` registry (an overlapping replay window)
    are counted as duplicates, not new intents. Records outside the frozen
    window are ignored for the inventory but do not fail the page.
    """
    if not isinstance(page_records, list):
        raise ReconcileRefused("a page must be a list of PR records")
    updated = json.loads(json.dumps(checkpoint))  # deep copy via canonical shape
    for record in _stable_page_sort(page_records):
        identity = record_identity(record)
        pr = identity.get("pr")
        # Registry keys are STRINGS: the checkpoint round-trips through JSON,
        # which stringifies int keys. Looking up with a raw int would silently
        # miss every previously seen PR after a resume (a real double-count).
        registry_key = None if pr is None else str(pr)
        if identity["disposition"] == "unsupported":
            if registry_key is not None and registry_key in updated["seen"]:
                continue  # duplicate of an already-represented record
            updated["inventory"].append(identity)
            if registry_key is not None:
                updated["seen"][registry_key] = {"unsupported": identity["reason"]}
            continue
        merged_at = identity["merged_at"]
        if not _in_window(merged_at, updated):
            continue  # outside the frozen interval: never this watermark
        seen = updated["seen"].get(registry_key)
        if seen is not None:
            if seen.get("merge_sha") == identity["merge_sha"]:
                continue  # exact duplicate across pages/replay: one intent
            # Same PR, different recorded merge: represent the conflict, never
            # silently prefer one identity.
            updated["inventory"].append({"disposition": "unsupported", "pr": pr,
                                         "reason": "conflicting merge identity for one PR",
                                         "prior": seen, "observed": {"merge_sha": identity["merge_sha"],
                                                                     "merged_at": merged_at}})
            continue
        updated["seen"][registry_key] = {"merge_sha": identity["merge_sha"], "merged_at": merged_at}
        updated["inventory"].append(identity)
    updated["pages_read"] += 1
    return updated


def reconcile(effects, page_fetch: Callable[[Optional[str]], List[Dict[str, Any]]],
             *, after: str, before: str, page_budget: int,
             checkpoint_raw: Any = None) -> Dict[str, Any]:
    """Resumable bounded reconcile of one frozen interval.

    ``page_fetch(cursor)`` returns the next page of merged-PR records
    (``cursor`` None = first page) and raises ``PageFailed`` on a transient
    read failure. The caller owns persistence: save the returned checkpoint
    after each fold (it is returned after every page via ``steps``).

    The completeness watermark advances ONLY on a successfully read page.
    A budget that runs out with pages remaining, or a page that stays
    unreadable, reports ``complete: false`` plus ``next_cursor`` — an honest
    incomplete inventory. Total reconciliation across restarts is proven by
    the final ``complete: true`` with no next cursor.
    """
    interval = normalize_interval(after, before)
    budget = normalize_page_budget(page_budget)
    if checkpoint_raw is not None:
        checkpoint = load_checkpoint(checkpoint_raw, interval, budget)
    else:
        checkpoint = new_checkpoint(interval, budget)

    steps = []
    cursor = checkpoint["cursor"]
    for _ in range(budget):
        if cursor is None and checkpoint["pages_read"] > 0:
            break  # previous run finished the interval; nothing to resume
        try:
            page = page_fetch(cursor)
        except PageFailed as exc:
            checkpoint["transient_failures"] += 1
            steps.append({"page": checkpoint["pages_read"] + 1,
                          "outcome": "transient-failure", "reason": str(exc)[:200],
                          "watermark_advanced": False})
            break  # stop WITHOUT advancing completeness; resume retried the page
        checkpoint = reconcile_page(checkpoint, page)
        cursor = _next_cursor(page)
        checkpoint["cursor"] = cursor
        advanced = {"page": checkpoint["pages_read"],
                    "records": len(page), "outcome": "read",
                    "watermark_advanced": True,
                    "inventory_total": len(checkpoint["inventory"])}
        steps.append(advanced)
        if cursor is None:
            checkpoint["complete"] = True
            break
    checkpoint["steps"] = steps
    checkpoint["complete"] = checkpoint.get("complete", False) and cursor is None
    checkpoint["summary"] = summarize(checkpoint)
    return checkpoint


def _next_cursor(page: List[Dict[str, Any]]) -> Optional[str]:
    """The forge cursor for the next page, derived from the LAST record by
    the injected fetcher's own convention; None means no more pages. The
    pure module treats the fetcher's cursor contract as opaque: pages carry
    an optional trailing ``__next_cursor`` marker the fetcher may set."""
    if isinstance(page, dict):
        return page.get("__next_cursor")
    for record in reversed(page):
        if isinstance(record, dict) and "__next_cursor" in record:
            return record["__next_cursor"]
    return None


# ---------------------------------------------------------------- summary


def summarize(checkpoint: Dict[str, Any]) -> Dict[str, Any]:
    """Honest totals that reconcile against the inventory list: pending
    intents, explicit unsupported entries, and duplicates are counted
    separately. Nothing here asserts review completion — pending is pending."""
    inventory = checkpoint.get("inventory", [])
    intents = [e for e in inventory if e.get("disposition") == "intent"]
    unsupported = [e for e in inventory if e.get("disposition") == "unsupported"]
    return {"version": VERSION,
            "after": checkpoint["after"], "before": checkpoint["before"],
            "pages_read": checkpoint["pages_read"],
            "transient_failures": checkpoint.get("transient_failures", 0),
            "complete": checkpoint.get("complete", False),
            "next_cursor": checkpoint.get("cursor"),
            "represented": len(inventory),
            "intents": len(intents),
            "unsupported": len(unsupported),
            "duplicates_seen": len(checkpoint.get("seen", {})) - len(intents),
            # review counts are NOT discovery counts: pending is never reviewed
            "reviewed": 0, "pending_review": len(intents)}
