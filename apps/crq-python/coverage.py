"""Pure stdlib coverage policy. The tick owns persistence, Git and dispatch.

Do not import crq here: importing it loads configuration and couples policy to
runtime services. All returned structures are JSON serializable.
"""
import datetime as dt
import hashlib
from pathlib import PurePosixPath
import backfill_jobs
from backfill_jobs import is_execution_owner


COVERAGE_RANK = 4


def _time(value):
    if isinstance(value, dt.datetime):
        result = value
    elif isinstance(value, (int, float)):
        result = dt.datetime.fromtimestamp(value, dt.timezone.utc)
    elif isinstance(value, str):
        result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    else:
        raise ValueError("invalid timestamp")
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


def _legacy_family(pr, original_path):
    return "legacy-coverage:" + str(pr) + ":" + _path(original_path)


def _legacy_origins(queue, item, reviewed_paths=None):
    names = set(item.get("coverage_paths", [])) | set((item.get("measure") or {}).get("synthetic_paths", []))
    if reviewed_paths is not None:
        names &= set(reviewed_paths)
    source = next((i for i in queue.get("items", []) if i.get("id") == item.get("coverage_source")), None)
    if not source and not item.get("coverage_source") and names:
        possible = [i for i in queue.get("items", []) if i.get("kind") == "merged" and i.get("pr") is not None
                    and all(any(name in (f.get("path"), f.get("now")) for f in (i.get("measure") or {}).get("files", []))
                            for name in names)]
        if len(possible) == 1:
            source = possible[0]
    if not source:
        raise ValueError("legacy coverage source is required for retry identity")
    files = (source.get("measure") or {}).get("files", [])
    origins = set()
    for name in names:
        matches = {_path(f["path"]) for f in files if f.get("path")
                   and name in (f.get("path"), f.get("now"))}
        if len(matches) != 1:
            raise ValueError("legacy coverage path lacks unambiguous source lineage")
        origins.update(matches)
    return source, origins


def record_legacy_failure(queue, item, at, outcome, run_id):
    """Retain legacy failure budgets across coverage item generations."""
    source, origins = _legacy_origins(queue, item)
    if not origins:
        raise ValueError("legacy coverage paths lack source lineage")
    if not run_id:
        raise ValueError("legacy coverage failure requires run identity")
    identity = {"item": item["id"], "outcome": outcome, "origins": sorted(origins), "at": at}
    seen = queue.setdefault("legacy_coverage_failure_runs", {})
    if run_id in seen:
        if seen[run_id] != identity:
            raise ValueError("legacy coverage run identity conflict")
        return
    for origin in sorted(origins):
        family = _legacy_family(source["pr"], origin)
        adapter = {"family": family, "scope": [{"path": family}], "failures": 0}
        backfill_jobs.terminal(queue, adapter, at, outcome, vendor_terminal=True)
    seen[run_id] = identity


def record_legacy_success(queue, item, reviewed_paths):
    source, origins = _legacy_origins(queue, item, reviewed_paths)
    for origin in origins:
        family = _legacy_family(source["pr"], origin)
        family_history = queue.get("backfill_families", {}).get(family, {})
        scope_history = queue.get("backfill_scope_failures", {}).get(family, {})
        if not family_history.get("quarantined") and not scope_history.get("quarantined"):
            queue.get("backfill_families", {}).pop(family, None)
            queue.get("backfill_scope_failures", {}).pop(family, None)


def legacy_retry_view(queue, pr, original_path, at):
    """Derive restrictions from retained guarded-harvest records without mutation."""
    family = _legacy_family(pr, original_path)
    histories = [queue.get("backfill_families", {}).get(family, {}), queue.get("backfill_scope_failures", {}).get(family, {})]
    reasons, runs, deadlines, resets = [], {}, [], []
    if queue.get("cooldown_until"):
        try:
            deadlines.append(_time(queue["cooldown_until"]))
        except (TypeError, ValueError):
            reasons.append("invalid global deadline")
    for h in histories:
        if h.get("next_eligible_at"):
            try:
                deadlines.append(_time(h["next_eligible_at"]))
            except (TypeError, ValueError):
                reasons.append("invalid persisted deadline")
    seen = queue.get("legacy_coverage_failure_runs", {})
    for item in queue.get("items", []):
        if item.get("kind") != "coverage":
            continue
        try:
            source, origins = _legacy_origins(queue, item)
        except ValueError:
            # Without lineage we cannot prove a same-PR item disjoint. A
            # missing PR identity is also potentially relevant to this scope.
            if item.get("pr") in (None, pr):
                reasons.append("unresolved legacy source or lineage")
            continue
        if source.get("pr") != pr or original_path not in origins:
            continue
        if item.get("not_before"):
            try:
                deadlines.append(_time(item["not_before"]))
            except (TypeError, ValueError):
                reasons.append("invalid item deadline")
        if any(a.get("outcome") not in ("error", "interrupted", "skipped", "too_large", "malformed", "completed", "rate_limited")
               for a in item.get("attempts", [])):
            reasons.append("unknown attempt outcome")
        for attempt in item.get("attempts", []):
            if attempt.get("outcome") == "rate_limited":
                try:
                    if _time(queue["cooldown_until"]) <= _time(attempt["at"]):
                        raise ValueError("deadline predates refusal")
                except (KeyError, TypeError, ValueError):
                    reasons.append("historical vendor deadline unavailable")
        failures = [a for a in item.get("attempts", []) if a.get("outcome") in ("error", "interrupted", "skipped", "too_large", "malformed")]
        if item.get("state") in ("blocked", "failed", "quarantined") and not failures and not any(v.get("item") == item.get("id") for v in seen.values()):
            reasons.append("terminal history missing")
        item_resets = []
        for cycle in item.get("cycles", []):
            run_id = cycle.get("run_id")
            attempt = next((a for a in item.get("attempts", []) if a.get("run_id") == run_id), None)
            credit = (queue.get("coverage") or {}).get("runs", {}).get(run_id)
            try:
                if (not attempt or attempt.get("outcome") != "completed" or attempt.get("counted") is not True
                        or attempt.get("head") != cycle.get("head") or attempt.get("base") != cycle.get("base")
                        or not credit or not credit.get("paths")):
                    raise ValueError("unverified success")
                _, credited_origins = _legacy_origins(queue, item, credit["paths"])
                completed = _time(cycle["completed_at"])
                if original_path in credited_origins:
                    if _time(attempt["at"]) > completed or _time(credit["completed_at"]) != completed:
                        raise ValueError("conflicting success chronology")
                    resets.append(completed)
                    item_resets.append(completed)
            except (KeyError, TypeError, ValueError):
                reasons.append("success scope or ordering unresolved")
        if is_execution_owner(item):
            reasons.append("live or unknown legacy ownership")
        for attempt in failures:
            run_id, timestamp = attempt.get("run_id"), attempt.get("at")
            if not run_id or not timestamp or attempt.get("counted") is not False or not attempt.get("head") or not attempt.get("base"):
                reasons.append("incomplete guarded harvest attempt")
                continue
            try:
                when = _time(timestamp)
            except (ValueError, TypeError):
                reasons.append("invalid attempt time")
                continue
            key = (item.get("id"), attempt.get("outcome"), when)
            if run_id in runs and runs[run_id] != key:
                reasons.append("conflicting run identity")
            runs[run_id] = key
        if type(item.get("failures")) is int:
            try:
                cutoff = max(item_resets, default=None)
                expected = sum(not cutoff or _time(a["at"]) > cutoff for a in failures)
                if item["failures"] != expected:
                    reasons.append("unexplained item failure aggregate")
            except (KeyError, TypeError, ValueError):
                reasons.append("unexplained item failure aggregate")
    for run_id, record in seen.items():
        if original_path not in record.get("origins", []):
            continue
        item = next((i for i in queue.get("items", []) if i.get("id") == record.get("item")), None)
        if not item:
            reasons.append("orphan adapter run")
            continue
        try:
            source, origins = _legacy_origins(queue, item)
            if source.get("pr") != pr or original_path not in origins:
                continue
            when = _time(record["at"])
        except (ValueError, TypeError, KeyError):
            reasons.append("incomplete adapter run")
            continue
        if run_id in runs:
            if runs[run_id][:2] != (record.get("item"), record.get("outcome")):
                reasons.append("conflicting run identity")
        else:
            runs[run_id] = (record.get("item"), record.get("outcome"), when)
    baseline = [0, 0]
    released = False
    last_release = None
    for event in queue.get("legacy_coverage_releases", []):
        if event.get("family") != family:
            continue
        proofs = event.get("runs") or {}
        if not proofs or any(key not in runs or list(runs[key][:2]) + [_iso(runs[key][2])] != value
                             for key, value in proofs.items()):
            reasons.append("released history no longer matches")
            continue
        if (type(event.get("floors")) is not list or len(event["floors"]) != len(histories)
                or any(type(n) is not int or n < 0 for n in event["floors"])):
            reasons.append("invalid release accounting")
            continue
        try:
            release_at = _time(event["at"])
            if last_release and release_at <= last_release:
                raise ValueError("release order")
        except (KeyError, TypeError, ValueError):
            reasons.append("invalid release chronology")
            continue
        baseline = event["floors"]
        runs = {key: value for key, value in runs.items() if key not in proofs}
        released = True
        last_release = release_at
    reset = max(resets, default=None)
    # The authorized release captures immutable counter floors. Check those
    # before a later scoped success derives its additional effective floor.
    if any(type(h.get("failures", 0)) is not int or h.get("failures", 0) < floor
           for h, floor in zip(histories, baseline)):
        reasons.append("released counter floor missing or reduced")
    if reset:
        if any(value[2] == reset for value in runs.values()):
            reasons.append("failure and success chronology ambiguous")
        if released:
            # The persisted counters intentionally retain pre-release and
            # subsequent failures. A proven scoped success starts a new
            # effective streak, without changing those historical counters.
            if any(value[2] == last_release and value[2] < reset for value in runs.values()):
                reasons.append("failure and release chronology ambiguous")
            consumed = sum(key in seen and last_release < value[2] < reset for key, value in runs.items())
            baseline = [min(h.get("failures", 0), floor + consumed)
                        if type(h.get("failures", 0)) is int else floor
                        for h, floor in zip(histories, baseline)]
        runs = {key: value for key, value in runs.items() if value[2] > reset}
    if last_release and any(value[2] <= last_release for value in runs.values()):
        reasons.append("failure predates or coincides with release but lacks release proof")
    ordered = sorted(runs.values(), key=lambda value: value[2])
    for index, (_, _, when) in enumerate(ordered, 1):
        deadlines.append(when + dt.timedelta(seconds=min(86400, 3600 * 2 ** min(index - 1, 5))))
    count = len(ordered)
    if any(type(h.get("failures", 0)) is not int or h.get("failures", 0) < floor
           or h.get("failures", 0) - floor > count for h, floor in zip(histories, baseline)):
        reasons.append("unreconciled family aggregate")
    if any(h.get("quarantined") for h in histories) and not released:
        reasons.append("persisted quarantine")
    if count >= 6:
        reasons.append("family failure limit")
    deadline = max(deadlines, default=None)
    return {"allowed": not reasons and (deadline is None or deadline <= _time(at)),
            "failures": count, "deadline": _iso(deadline) if deadline else None, "reasons": reasons,
            "runs": sorted(runs), "run_proofs": {key: list(value[:2]) + [_iso(value[2])] for key, value in runs.items()}}


def release_legacy_quarantine(queue, pr, original_path, at, operator, reason, evidence):
    """Record a scope-bound release without rewriting retained failure history."""
    family = _legacy_family(pr, original_path)
    if not operator or not reason or not evidence:
        raise ValueError("legacy release requires operator, reason and no-live evidence")
    view = legacy_retry_view(queue, pr, original_path, _time(at))
    if not view["runs"] or any(r not in ("persisted quarantine", "family failure limit") for r in view["reasons"]):
        raise ValueError("legacy release has missing or unresolved scoped history")
    if not any(r in ("persisted quarantine", "family failure limit") for r in view["reasons"]):
        raise ValueError("legacy scope is not quarantined")
    if set(evidence.get("checked_runs", [])) != set(view["runs"]):
        raise ValueError("legacy release evidence must bind all scoped run identities")
    histories = [queue.get("backfill_families", {}).get(family, {}), queue.get("backfill_scope_failures", {}).get(family, {})]
    floors = [h.get("failures", 0) for h in histories]
    event = {"family": family, "at": _iso(at), "operator": operator, "reason": reason,
             "runs": view["run_proofs"], "floors": floors, "evidence": evidence}
    queue.setdefault("legacy_coverage_releases", []).append(event)
    return event


def _legacy_retry_allowed(queue, pr, original_path, at):
    return legacy_retry_view(queue, pr, original_path, at)["allowed"]


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
    active = [i for i in outstanding if i not in repair_debt
              and (i.get("state") not in ("blocked", "failed", "quarantined")
                   or is_execution_owner(i))]
    # Spec 2026-10-30 §7: terminal blocked/failed debt releases execution
    # capacity. Unknown/live vendor ownership remains held independently.
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
            if not _legacy_retry_allowed(queue, item["pr"], file["path"], at):
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
