"""Bounded merged-interval inventory; no queue mutation or review dispatch.

The caller binds an authorized repository/base and frozen (after, before] to its
page fetcher. It must supply complete forge pages, never search-capped results:
``{records: [...], has_next_page: bool, next_cursor: str | None}``. Cursors are
opaque, stable within that frozen query, and independent of record ordering.

``checkpoint_save`` atomically persists a JSON snapshot before the next fetch;
errors propagate so a failed save cannot advance persisted progress. A page read
failure returns incomplete and retries that same cursor on resume. Dry runs fetch
and inventory normally but never call the persistence callback. The unused first
argument preserves the retained checkpoint's call shape; no effects are invoked.

``enrollment_plan`` only proposes Q1 enroll arguments. It refuses incomplete
inventories and conflicting identities, grants no review credit, and never
modifies a queue. Integration, repository/forge verification and the sole tick
remain caller responsibilities. Legacy synthetic/skipped/done state is not proof
of current coverage. Schema 1 checkpoints are refused: they cannot prove complete
page metadata or accurate deduplication counts.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
from typing import Any, Callable, Dict, List, Optional

VERSION = 1
CHECKPOINT_SCHEMA = 2
CHECKPOINT_NAME = "reconcile-checkpoint.json"
TS_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
SHA_RE = re.compile(r"[0-9a-f]{40}")
MAX_PAGE_BUDGET = 200
MAX_PAGE_RECORDS = 100
MAX_CURSOR_BYTES = 4096
MAX_INVENTORY = 5000
MAX_PAGES = 1000
MAX_REPOSITORY_NUMBER = 20000
NUMBER_WINDOW = 50


class ReconcileRefused(Exception):
    """Invalid input; no successful complete-inventory claim is possible."""


class PageFailed(Exception):
    """Retryable page read failure; resume without advancing its cursor."""


def _copy(value):
    return json.loads(json.dumps(value, allow_nan=False))


def checkpoint_digest(checkpoint: Dict[str, Any]) -> str:
    """Digest of a JSON snapshot, excluding its own digest field.

    Detects accidental corruption, not authorization or authenticity. Checkpoint
    files must remain in the caller's trusted state directory.
    """
    payload = {k: v for k, v in checkpoint.items() if k != "digest"}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"),
                                    ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def _seal(checkpoint):
    result = _copy(checkpoint)
    result["summary"] = summarize(result)
    result["digest"] = checkpoint_digest(result)
    return result


def _timestamp(name: str, value: Any) -> str:
    if not isinstance(value, str) or not TS_RE.fullmatch(value):
        raise ReconcileRefused(f"{name} must be an exact UTC timestamp YYYY-MM-DDTHH:MM:SSZ")
    try:
        dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        raise ReconcileRefused(f"{name} is not a valid UTC timestamp") from None
    return value


def normalize_interval(after: Any, before: Any) -> Dict[str, str]:
    after = _timestamp("after", after)
    before = _timestamp("before", before)
    if after >= before:
        raise ReconcileRefused("after must be strictly earlier than before")
    return {"after": after, "before": before}


def normalize_page_budget(budget: Any) -> int:
    if type(budget) is not int or not 1 <= budget <= MAX_PAGE_BUDGET:
        raise ReconcileRefused(f"page budget must be a positive integer capped at {MAX_PAGE_BUDGET}")
    return budget


def _cursor(value):
    return value is None or (isinstance(value, str) and 0 < len(value.encode()) <= MAX_CURSOR_BYTES)


def record_identity(page_record: Any) -> Dict[str, Any]:
    if not isinstance(page_record, dict):
        return {"disposition": "unsupported", "reason": "page record is not an object"}
    pr = page_record.get("number")
    if type(pr) is not int or pr <= 0:
        return {"disposition": "unsupported", "reason": "malformed PR number"}
    merged_at = page_record.get("mergedAt")
    try:
        _timestamp("mergedAt", merged_at)
    except ReconcileRefused:
        return {"disposition": "unsupported", "pr": pr,
                "reason": "missing or malformed mergedAt"}
    merge = page_record.get("mergeCommit")
    oid = merge.get("oid") if isinstance(merge, dict) else None
    if not isinstance(oid, str) or not SHA_RE.fullmatch(oid):
        return {"disposition": "unsupported", "pr": pr, "merged_at": merged_at,
                "reason": "missing or malformed merge commit identity"}
    head = page_record.get("headRefOid")
    if not isinstance(head, str) or not SHA_RE.fullmatch(head):
        return {"disposition": "unsupported", "pr": pr, "merged_at": merged_at,
                "reason": "source head gone or malformed"}
    return {"disposition": "intent", "pr": pr, "merged_at": merged_at,
            "merge_sha": oid, "head": head,
            "subject": {"repo": None, "pr": pr, "merge_sha": oid,
                        "target_selector": "promoted-main",
                        "policy": "affected-current-additions-v1"}}


def new_checkpoint(interval: Dict[str, str], page_budget: int, *, repo: str, base: str) -> Dict[str, Any]:
    return {"schema_version": CHECKPOINT_SCHEMA, **normalize_interval(**interval),
            "page_budget": normalize_page_budget(page_budget), "repo": repo, "base": base,
            "cursor": None, "pages_read": 0, "seen": {}, "inventory": [],
            "record_keys": [], "cursor_history": [], "duplicates_seen": 0,
            "outside_window": 0, "records_read": 0, "transient_failures": 0,
            "complete": False, "steps": [], "dry_run": False}


def load_checkpoint(raw: Any, interval: Dict[str, str], page_budget: int,
                    *, repo: str, base: str, allow_complete=False) -> Dict[str, Any]:
    if not isinstance(raw, dict) or type(raw.get("schema_version")) is not int or raw["schema_version"] != CHECKPOINT_SCHEMA:
        raise ReconcileRefused("checkpoint schema unsupported; restart inventory")
    if raw.get("after") != interval["after"] or raw.get("before") != interval["before"]:
        raise ReconcileRefused("checkpoint belongs to a different frozen interval")
    if type(raw.get("page_budget")) is not int or raw["page_budget"] != page_budget:
        raise ReconcileRefused("checkpoint was taken with a different page budget")
    if raw.get("repo") != repo or raw.get("base") != base:
        raise ReconcileRefused("checkpoint belongs to a different repository/base query")
    required = new_checkpoint(interval, page_budget, repo=repo, base=base)
    if any(k not in raw for k in required):
        raise ReconcileRefused("checkpoint missing required fields")
    try:
        if raw.get("digest") != checkpoint_digest(raw):
            raise ReconcileRefused("checkpoint digest mismatch")
        checkpoint = _copy(raw)
    except (TypeError, ValueError):
        raise ReconcileRefused("checkpoint is not canonical JSON") from None
    for field in ("pages_read", "duplicates_seen", "outside_window", "records_read", "transient_failures"):
        if type(raw[field]) is not int or raw[field] < 0:
            raise ReconcileRefused("checkpoint counter malformed: " + field)
    if (type(raw["complete"]) is not bool or type(raw["dry_run"]) is not bool or
            not _cursor(raw["cursor"]) or not isinstance(raw["seen"], dict) or
            any(not isinstance(raw[k], list) for k in ("inventory", "record_keys", "cursor_history", "steps"))):
        raise ReconcileRefused("checkpoint state malformed")
    if len(raw["inventory"]) > MAX_INVENTORY or raw["pages_read"] > MAX_PAGES:
        raise ReconcileRefused("checkpoint resource cap exceeded; partition the interval")
    keys, history = raw["record_keys"], raw["cursor_history"]
    if (any(not isinstance(k, str) or not re.fullmatch(r"[0-9a-f]{64}", k) for k in keys) or
            len(set(keys)) != len(keys) or len(keys) != len(raw["inventory"]) or
            any(c is None or not _cursor(c) for c in history) or
            len(set(history)) != len(history) or len(history) != raw["pages_read"] - int(raw["complete"]) or
            (raw["cursor"] != (history[-1] if history else None)) and not raw["complete"] or
            raw["complete"] and (raw["cursor"] is not None or raw["pages_read"] == 0) or
            raw["records_read"] != len(keys) + raw["duplicates_seen"] + raw["outside_window"]):
        raise ReconcileRefused("checkpoint progress inconsistent")
    expected_seen = {}
    for entry in raw["inventory"]:
        if not isinstance(entry, dict) or entry.get("disposition") not in ("intent", "unsupported"):
            raise ReconcileRefused("checkpoint inventory malformed")
        if entry["disposition"] == "intent":
            reconstructed = record_identity({"number": entry.get("pr"), "mergedAt": entry.get("merged_at"),
                                             "mergeCommit": {"oid": entry.get("merge_sha")},
                                             "headRefOid": entry.get("head")})
            if entry != reconstructed or not interval["after"] < entry["merged_at"] <= interval["before"]:
                raise ReconcileRefused("checkpoint intent malformed")
            expected_seen[str(entry["pr"])] = {"merge_sha": entry["merge_sha"], "merged_at": entry["merged_at"]}
        elif not isinstance(entry.get("reason"), str) or not entry["reason"]:
            raise ReconcileRefused("checkpoint unsupported reason missing")
    if raw["seen"] != expected_seen or raw.get("summary") != summarize(raw):
        raise ReconcileRefused("checkpoint registry/summary inconsistent")
    if raw["complete"] and not allow_complete:
        raise ReconcileRefused("checkpoint is already complete; nothing to resume")
    return checkpoint


def _stable_page_sort(records):
    def key(record):
        merged = record.get("mergedAt") if isinstance(record, dict) else None
        pr = record.get("number") if isinstance(record, dict) else None
        return (merged if isinstance(merged, str) else "", pr if type(pr) is int else 0)
    return sorted(records, key=key)


def reconcile_page(checkpoint: Dict[str, Any], page_records: Any) -> Dict[str, Any]:
    """Pure page fold. Cursor validation/persistence belongs to reconcile."""
    if not isinstance(page_records, list) or len(page_records) > MAX_PAGE_RECORDS:
        raise ReconcileRefused("a page must be a bounded list of PR records")
    updated = _copy(checkpoint)
    keys = set(updated["record_keys"])
    for record in _stable_page_sort(page_records):
        updated["records_read"] += 1
        # Filter even unsupported source identities when their timestamp is known.
        at = record.get("mergedAt") if isinstance(record, dict) else None
        try:
            _timestamp("mergedAt", at)
        except ReconcileRefused:
            at = None
        if at is not None and not updated["after"] < at <= updated["before"]:
            updated["outside_window"] += 1
            continue
        identity = record_identity(record)
        # Valid source identity ignores incidental page fields/head churn. Invalid
        # records dedupe by their canonical payload so distinct failures survive.
        source = ({"pr": identity["pr"], "merge_sha": identity["merge_sha"]}
                  if identity["disposition"] == "intent" else {"unsupported_record": record})
        try:
            key = checkpoint_digest(source)
        except (TypeError, ValueError):
            raise ReconcileRefused("page record is not canonical JSON") from None
        if key in keys:
            updated["duplicates_seen"] += 1
            continue
        keys.add(key)
        updated["record_keys"].append(key)
        if identity["disposition"] == "intent":
            prior = updated["seen"].get(str(identity["pr"]))
            if prior and prior["merge_sha"] != identity["merge_sha"]:
                identity = {"disposition": "unsupported", "pr": identity["pr"],
                            "reason": "conflicting merge identity for one PR",
                            "prior": prior, "observed": {"merge_sha": identity["merge_sha"], "merged_at": at}}
            else:
                updated["seen"][str(identity["pr"])] = {"merge_sha": identity["merge_sha"], "merged_at": at}
        if len(updated["inventory"]) >= MAX_INVENTORY:
            raise ReconcileRefused("inventory cap reached; partition the interval")
        updated["inventory"].append(identity)
    updated["inventory"].sort(key=lambda e: (e.get("merged_at", ""), e.get("pr", 0), e.get("reason", "")))
    updated["pages_read"] += 1
    return updated


def _page(value, cursor, history):
    # Forge search/GraphQL may return usable-looking rows alongside an explicit
    # incomplete/error indication. Neither a terminal cursor nor exit 0 cures it.
    if isinstance(value, dict) and (
            value.get("incomplete_results", False) is not False or
            value.get("truncated", False) is not False or value.get("errors")):
        raise ReconcileRefused("incomplete, truncated or errored forge result")
    if (not isinstance(value, dict) or not isinstance(value.get("records"), list) or
            type(value.get("has_next_page")) is not bool or "next_cursor" not in value or
            not _cursor(value["next_cursor"])):
        raise ReconcileRefused("page requires records, has_next_page and next_cursor")
    next_cursor = value["next_cursor"]
    if value["has_next_page"] != (next_cursor is not None):
        raise ReconcileRefused("inconsistent page completeness metadata")
    if next_cursor is not None and (next_cursor == cursor or next_cursor in history):
        raise ReconcileRefused("page cursor did not advance or cycled")
    return value["records"], next_cursor


def reconcile(effects, page_fetch: Callable[[Optional[str]], Dict[str, Any]],
              *, repo: str, after: str, before: str, page_budget: int, base="merge-queue", checkpoint_raw: Any = None,
              checkpoint_save=None, dry_run=False) -> Dict[str, Any]:
    """Inventory up to page_budget reads per invocation over immutable bounds.

    Save snapshots include their digest and summary and are independent copies.
    A callback failure aborts before any further page reads. Save the initial
    snapshot as well: a crash during page one retains the original upper bound.
    The caller must reuse the SAME repository/base query on resume, never a new
    live 'now'. This module does not call the unused effects argument.
    """
    if (not isinstance(repo, str) or not re.fullmatch(r"[\w.-]+/[\w.-]+", repo) or
            not isinstance(base, str) or not re.fullmatch(r"[A-Za-z0-9_. /-]+", base) or
            not base or base.strip() != base or " " in base):
        raise ReconcileRefused("invalid repository/base query")
    interval = normalize_interval(after, before)
    budget = normalize_page_budget(page_budget)
    if type(dry_run) is not bool or checkpoint_save is not None and not callable(checkpoint_save):
        raise ReconcileRefused("invalid dry-run or checkpoint callback")
    checkpoint = (load_checkpoint(checkpoint_raw, interval, budget, repo=repo, base=base) if checkpoint_raw is not None
                  else new_checkpoint(interval, budget, repo=repo, base=base))
    checkpoint["dry_run"] = dry_run
    checkpoint["steps"] = []

    def persist():
        snapshot = _seal(checkpoint)
        if checkpoint_save is not None and not dry_run:
            checkpoint_save(_copy(snapshot))
        return snapshot

    persist()
    for _ in range(budget):
        if checkpoint["pages_read"] >= MAX_PAGES:
            raise ReconcileRefused("page cap reached; restart with a smaller repository universe")
        cursor = checkpoint["cursor"]
        try:
            page = page_fetch(cursor)
        except PageFailed as exc:
            checkpoint["transient_failures"] += 1
            checkpoint["steps"].append({"page": checkpoint["pages_read"] + 1,
                                         "outcome": "transient-failure", "reason": str(exc)[:200],
                                         "watermark_advanced": False})
            persist()
            break
        records, next_cursor = _page(page, cursor, checkpoint["cursor_history"])
        checkpoint = reconcile_page(checkpoint, records)
        checkpoint["cursor"] = next_cursor
        checkpoint["complete"] = next_cursor is None
        if next_cursor is not None:
            checkpoint["cursor_history"].append(next_cursor)
        checkpoint["steps"].append({"page": checkpoint["pages_read"], "records": len(records),
                                     "outcome": "read", "watermark_advanced": False})
        persist()
        if checkpoint["complete"]:
            break
    return _seal(checkpoint)


def summarize(checkpoint: Dict[str, Any]) -> Dict[str, Any]:
    inventory = checkpoint["inventory"]
    intents = sum(e.get("disposition") == "intent" for e in inventory)
    return {"version": VERSION, "after": checkpoint["after"], "before": checkpoint["before"],
            "pages_read": checkpoint["pages_read"], "transient_failures": checkpoint["transient_failures"],
            "complete": checkpoint["complete"], "next_cursor": checkpoint["cursor"],
            # Only complete discovery permits advancing the interval watermark.
            "complete_through": checkpoint["before"] if checkpoint["complete"] else None,
            "represented": len(inventory), "intents": intents, "unsupported": len(inventory) - intents,
            "duplicates_seen": checkpoint["duplicates_seen"], "outside_window": checkpoint["outside_window"],
            "records_read": checkpoint["records_read"], "reviewed": 0, "pending_review": intents}


def enrollment_plan(result, *, repo, existing_requests=(), dry_run=True):
    """Return deterministic Q1 enroll bindings, never invoke or mutate Q1.

    Existing requests are verified Q1 binding dictionaries (not old PR states or
    receipts). Equal bindings are already-enrolled, never counted as reviewed.
    Caller adds `at` and persists Q1 enrolls under the existing lock; repeat after
    a crash is idempotent by request ID and binding. No Q3 transport dependency.
    """
    if not isinstance(result, dict):
        raise ReconcileRefused("invalid inventory")
    result = load_checkpoint(result, normalize_interval(result.get("after"), result.get("before")),
                             normalize_page_budget(result.get("page_budget")), repo=repo, base=result.get("base"), allow_complete=True)
    if not result["complete"]:
        raise ReconcileRefused("incomplete inventory cannot authorize enrollment or watermark advancement")
    if type(dry_run) is not bool or not isinstance(repo, str) or not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        raise ReconcileRefused("invalid repository or dry-run")
    if any(e.get("reason") == "conflicting merge identity for one PR" for e in result["inventory"]):
        raise ReconcileRefused("conflicting source identity prevents enrollment")
    entries = []
    for entry in result["inventory"]:
        if entry["disposition"] != "intent":
            entries.append(_copy(entry))
            continue
        binding = {**entry["subject"], "repo": repo}
        # Q1 uses this canonical JSON identity for equivalent pending subjects.
        request_id = "reconcile-" + checkpoint_digest(binding)[:64]
        disposition = "already-enrolled" if binding in existing_requests else "intent"
        entries.append({"disposition": disposition, "binding": binding, "request_id": request_id})
    return {"version": VERSION, "dry_run": dry_run, "after": result["after"], "before": result["before"],
            "inventory_digest": result["digest"], "entries": entries, "reviewed": 0}


# Numeric keysets over ALL issue/PR slots: merging, closing and appending cannot
# shift an existing number. Missing/invisible/deleted slots refuse completeness.
# Assumptions: immutable monotonically allocated repository numbers and truthful
# mergedAt metadata. Administrative history rewrites/eventual consistency require
# operator overlap replay; this is not a snapshot of mutable GitHub search.
def _repository(response, repo):
    if (not isinstance(response, dict) or response.get("errors") or
            response.get("incomplete_results", False) is not False or
            response.get("truncated", False) is not False):
        raise ReconcileRefused("forge returned errors or incomplete data")
    data = response.get("data")
    repository = data.get("repository") if isinstance(data, dict) else None
    if (not isinstance(repository, dict) or repository.get("nameWithOwner") != repo or
            not isinstance(repository.get("id"), str) or not repository["id"]):
        raise ReconcileRefused("forge repository identity missing or changed")
    return repository


def _query(repo, body):
    owner, name = repo.split("/")
    return "query { repository(owner: " + json.dumps(owner) + ", name: " + json.dumps(name) + ") { id nameWithOwner " + body + " } }"


def freeze_source(forge, *, repo, base):
    """Pin a finite all-state universe, never a merged/search result offset."""
    body = ("issues(last:1, states:[OPEN,CLOSED], orderBy:{field:CREATED_AT,direction:ASC}) { totalCount nodes { number } } "
            "pullRequests(last:1, states:[OPEN,CLOSED,MERGED], orderBy:{field:CREATED_AT,direction:ASC}) { totalCount nodes { number } }")
    repository = _repository(forge(_query(repo, body)), repo)
    numbers = []
    total = 0
    for field in ("issues", "pullRequests"):
        connection = repository.get(field)
        nodes = connection.get("nodes") if isinstance(connection, dict) else None
        count = connection.get("totalCount") if isinstance(connection, dict) else None
        if type(count) is not int or count < 0:
            raise ReconcileRefused("forge ceiling count missing")
        total += count
        if not isinstance(nodes, list) or len(nodes) > 1 or bool(nodes) != bool(count):
            raise ReconcileRefused("forge ceiling connection incomplete")
        for node in nodes:
            number = node.get("number") if isinstance(node, dict) else None
            if type(number) is not int or number <= 0:
                raise ReconcileRefused("forge ceiling number malformed")
            numbers.append(number)
    ceiling = max(numbers, default=0)
    if total != ceiling:
        raise ReconcileRefused("ceiling/count mismatch; repository universe not proven")
    if ceiling > MAX_REPOSITORY_NUMBER:
        raise ReconcileRefused("repository number cap exceeded; operator partition required")
    return {"version": 1, "method": "all-number-slots-v1", "repo": repo, "base": base,
            "repository_id": repository["id"], "ceiling": ceiling, "window": NUMBER_WINDOW}


def number_page(forge, source, cursor, *, repo, base):
    """Validate every slot; cursor binds the repository/ceiling/query identity."""
    if (not isinstance(source, dict) or source.get("version") != 1 or
            source.get("method") != "all-number-slots-v1" or source.get("repo") != repo or
            source.get("base") != base or source.get("window") != NUMBER_WINDOW or
            not isinstance(source.get("repository_id"), str) or
            type(source.get("ceiling")) is not int or not 0 <= source["ceiling"] <= MAX_REPOSITORY_NUMBER):
        raise ReconcileRefused("source query identity changed")
    start = 1
    if cursor is not None:
        try:
            decoded = json.loads(cursor)
            start = decoded["next"]
            if (decoded != {"source": checkpoint_digest(source), "next": start} or
                    type(start) is not int or not 1 < start <= source["ceiling"] or
                    (start - 1) % NUMBER_WINDOW):
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise ReconcileRefused("numeric cursor does not bind this source") from None
    stop = min(source["ceiling"], start + NUMBER_WINDOW - 1)
    fields = []
    for number in range(start, stop + 1):
        fields.append("n%d: issueOrPullRequest(number:%d) { __typename ... on Issue { number } "
                      "... on PullRequest { number baseRefName mergedAt headRefOid mergeCommit { oid } } }"
                      % (number, number))
    repository = _repository(forge(_query(repo, " ".join(fields))), repo)
    if repository["id"] != source["repository_id"]:
        raise ReconcileRefused("repository was replaced")
    records = []
    for number in range(start, stop + 1):
        node = repository.get("n" + str(number))
        if (not isinstance(node, dict) or type(node.get("number")) is not int or
                node["number"] != number or node.get("__typename") not in ("Issue", "PullRequest")):
            raise ReconcileRefused("missing or mismatched numeric slot; completeness unavailable")
        if node["__typename"] == "PullRequest":
            if not isinstance(node.get("baseRefName"), str) or "mergedAt" not in node:
                raise ReconcileRefused("PR state metadata incomplete")
            if node["mergedAt"] is not None and node["baseRefName"] == base:
                records.append(node)
    following = stop + 1 if stop < source["ceiling"] else None
    return {"records": records, "has_next_page": following is not None,
            "next_cursor": json.dumps({"source": checkpoint_digest(source), "next": following},
                                      sort_keys=True) if following is not None else None}
