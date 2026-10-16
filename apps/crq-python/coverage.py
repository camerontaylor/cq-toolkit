"""Pure stdlib coverage policy. The tick owns persistence, Git and dispatch.

Do not import crq here: importing it loads configuration and couples policy to
runtime services. All returned structures are JSON serializable.
"""
import datetime as dt
import hashlib
from pathlib import PurePosixPath


COVERAGE_RANK = 4


def _time(value):
    if isinstance(value, dt.datetime):
        result = value
    elif isinstance(value, (int, float)):
        result = dt.datetime.fromtimestamp(value, dt.timezone.utc)
    else:
        result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("timestamps must have a timezone")
    return result.astimezone(dt.timezone.utc)


def _iso(value):
    return _time(value).isoformat().replace("+00:00", "Z")


def _path(value):
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError("expected a repository-relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or str(path) == ".":
        raise ValueError("expected a repository-relative path")
    return str(path)


def new_ledger():
    """Store as queue['coverage']; only the locked tick should modify it."""
    return {"schema_version": 1, "paths": {}, "runs": {}, "observations": {}}


def record_review(ledger, *, run_id, completed_at, reviewed_paths,
                  review_sha, counted, outcome, focus_paths=None):
    """Credit explicit terminal reviewedFiles, once per run and path.

    focus_paths optionally restricts a merged synthetic review to its planned
    scope. A measurement or a launch alone never earns review credit. Path
    strings must be extracted by the caller from CodeRabbit reviewedFiles.
    Returns a copy; failure outcomes leave the ledger unchanged.
    """
    import copy
    result = copy.deepcopy(ledger)
    if not counted or outcome != "completed" or run_id in result["runs"]:
        return result
    if not run_id or not review_sha:
        raise ValueError("run_id and review_sha are required")
    at = _iso(completed_at)
    paths = {_path(p) for p in reviewed_paths}
    if focus_paths is not None:
        paths &= {_path(p) for p in focus_paths}
    for path in sorted(paths):
        entry = result["paths"].setdefault(path, {"review_count": 0,
                                                 "last_reviewed_at": None})
        entry["review_count"] += 1
        if entry["last_reviewed_at"] is None or _time(at) >= _time(entry["last_reviewed_at"]):
            entry.update(last_reviewed_at=at, last_run=run_id, reviewed_sha=review_sha)
    result["runs"][run_id] = {"completed_at": at, "paths": sorted(paths)}
    return result


def coverage_candidate(queue, ledger, *, merge_queue_sha, ordinary_eligible,
                       now, max_paths=8, min_age_hours=24, excluded_paths=()):
    """Return one lowest-priority pending item, or None; never enroll it.

    Caller evaluates ordinary planning/quiet/dependency gates first. Measurements
    must be refreshed against the supplied tip. Prefer never-reviewed paths,
    then oldest review, then fewest reviews. Cut a bounded region (parent dir)
    from one merged source so build_synthetic can use its pre-merge tree.
    """
    if max_paths < 1 or min_age_hours < 0:
        raise ValueError("invalid coverage bounds")
    if ordinary_eligible:
        return None
    at = _time(now)
    excluded = {_path(p) for p in excluded_paths}
    outstanding = [i for i in queue.get("items", []) if i.get("kind") == "coverage"
                   and i.get("state") not in ("done", "skipped")]
    # A counted cycle is persisted only after terminal review success. Repair
    # debt must retain its own paths without holding the global review slot.
    # Missing completion evidence and unknown states remain fail-closed.
    repair_debt = [i for i in outstanding
                   if i.get("state") in ("repairing", "repair_failed")
                   and any(c.get("run_id") in ledger["runs"] and c.get("completed_at")
                           for c in i.get("cycles", []))]
    for item in repair_debt:
        excluded.update(_path(p) for p in item.get("coverage_paths", []))
        excluded.update(_path(p) for p in (item.get("measure") or {}).get("synthetic_paths", []))
    active = [i for i in outstanding if i not in repair_debt]
    # One outstanding coverage item prevents repeated enrollment and respects
    # backoff/blocked work. Completed repair debt is retained, not resolved here.
    if active:
        return None
    choices = []
    for item in queue.get("items", []):
        measure = item.get("measure") or {}
        if (item.get("kind") != "merged" or not item.get("merge_commit")
                or measure.get("merge_queue") != merge_queue_sha):
            continue
        by_current = {}
        for file in measure.get("files", []):
            if not file.get("now") or not file.get("synthetic_added"):
                continue
            path = _path(file["now"])
            if path in excluded or _path(file["path"]) in excluded:
                continue
            entry = ledger["paths"].get(path, {})
            last = entry.get("last_reviewed_at")
            if last and (at - _time(last)).total_seconds() < min_age_hours * 3600:
                continue
            score = (0 if last is None else 1,
                     _time(last).timestamp() if last else 0,
                     entry.get("review_count", 0), path)
            by_current.setdefault(path, []).append(_path(file["path"]))
            choices.append((score, str(item["id"]), path, item, by_current))
    if not choices:
        return None
    choices.sort(key=lambda c: (c[0], c[1]))
    _, _, oldest, source, aliases = choices[0]
    region = str(PurePosixPath(oldest).parent)
    selected = []
    for _, _, path, item, _ in choices:
        if (item["id"] == source["id"] and str(PurePosixPath(path).parent) == region
                and path not in selected):
            selected.append(path)
            if len(selected) == max_paths:
                break
    synthetic = sorted(set(selected) | {p for path in selected for p in aliases[path]})
    token = hashlib.sha256((merge_queue_sha + "\0" + source["id"] + "\0"
                            + "\0".join(selected)).encode()).hexdigest()[:16]
    stem = f"coverage-{token}"
    existing = {i["id"] for i in queue.get("items", [])}
    iid, suffix = stem, 1
    while iid in existing:
        iid = f"{stem}-{suffix}"
        suffix += 1
    return {"id": iid, "pr": source["pr"], "kind": "coverage", "tier": COVERAGE_RANK,
            "order": max((i.get("order", 0) for i in queue.get("items", [])), default=0) + 1,
            "state": "pending", "cycles": [], "attempts": [], "notes": [],
            "merge_commit": source["merge_commit"], "coverage_source": source["id"],
            "coverage_sha": merge_queue_sha, "coverage_paths": selected,
            "coverage_region": region, "created_at": _iso(now),
            "measure": {"merge_queue": merge_queue_sha, "synthetic_paths": synthetic}}


def record_opportunity(ledger, *, at, started, pending, candidate_exists, blocked_reason=None):
    """Record one actual tick opportunity, keyed by its timestamp (idempotent).

    blocked_reason: paused/cooldown/hourly_cap/inflight/only, or another gate.
    started must mean a real CLI/signer start, never a failed secret scan or dry run.
    """
    import copy
    result = copy.deepcopy(ledger)
    result["observations"][_iso(at)] = {
        "started": bool(started), "pending": bool(pending),
        "candidate_exists": bool(candidate_exists), "blocked_reason": blocked_reason}
    return result


def utilization_digest(queue, ledger, *, now, max_starts_per_hour):
    """24h starts vs nominal cap, remaining cooldown, observed idle opportunities.

    Unknown history stays unknown: absence of observations never implies zero
    idle opportunities. This measures ticks, not hypothetical quota slots.
    """
    if max_starts_per_hour <= 0:
        raise ValueError("max_starts_per_hour must be positive")
    at = _time(now)
    cutoff = at - dt.timedelta(hours=24)
    starts = sum(cutoff < _time(s) <= at for s in queue.get("starts", []))
    observations = [v for k, v in ledger["observations"].items() if cutoff < _time(k) <= at]
    available = [v for v in observations if not v["blocked_reason"]]
    idle = [v for v in available if not v["started"]]
    cooldown = queue.get("cooldown_until")
    return {"starts_24h": starts, "nominal_cap_24h": 24 * max_starts_per_hour,
            "nominal_utilization": starts / (24 * max_starts_per_hour),
            "cooldown_minutes": max(0, (_time(cooldown) - at).total_seconds() / 60)
            if cooldown else 0,
            "observed_ticks_24h": len(observations),
            "available_start_opportunities_24h": len(available),
            "idle_while_pending_24h": sum(v["pending"] for v in idle) if observations else None,
            "idle_with_coverage_candidate_24h": sum(v["candidate_exists"] for v in idle)
            if observations else None,
            "coverage_reviewed_paths": len(ledger["paths"])}
