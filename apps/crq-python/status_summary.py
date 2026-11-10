"""Atomic, allow-listed fleet summary; no review launches or git fetches."""
import datetime as dt
from queue_time import parse_utc
import coverage
import backfill_report
import review_receipt
import repo_registry
import repair_tick
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def finding_triage(root):
    """Bound status previews and report malformed rows without stopping ticks."""
    return backfill_report.finding_triage(root, strict=False, limit=32)


def timestamp(value):
    parsed = parse_utc(value)
    return parsed.timestamp() if parsed is not None else None


def read(path):
    """Plain JSON read for documents with no digest of their own.

    Receipts go through read_receipt_document: their digest covers the exact
    bytes that get parsed.
    """
    return json.loads(Path(path).read_text())


def read_receipt_document(root, receipt_id):
    """Parse the receipt bytes the digest covers, from a single snapshot.

    read_receipt verifies one snapshot but returns only a manifest, so a
    second read here could parse different bytes than the ones verified.
    """
    if not isinstance(receipt_id, str) or not re.fullmatch(r"[0-9a-f]{64}", receipt_id):
        raise ValueError("invalid receipt id")
    data = (Path(root) / (receipt_id + ".json")).read_bytes()
    if hashlib.sha256(data).hexdigest() != receipt_id:
        raise ValueError("receipt digest mismatch")
    return json.loads(data)


def command(argv, timeout):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{Path(argv[0]).name} probe exited {result.returncode}")
    return result.stdout


def merged_current(queue, receipt_root=None):
    """Discovery truth and verified receipt truth remain separate, at retained T."""
    counts = {key: 0 for key in ("pending", "reviewing", "blocked", "unverified",
        "proven_terminal", "no_current_code", "partial_scope", "unsupported")}
    exclusions = {}
    targets = set()
    for item in queue["items"]:
        if item["kind"] != review_receipt.KIND:
            continue
        state = item["state"]
        if state in ("pending", "reviewing", "blocked"):
            counts[state] += 1
            continue
        try:
            receipt_id = item["receipt_id"]
            if receipt_root is None:
                raise ValueError("receipt bytes unavailable")
            document = read_receipt_document(receipt_root, receipt_id)
            capture = document["capture"]
            # Follow only retained queue lineage with matching receipt/state;
            # reject dangling/cyclic links and verify the original source binding.
            origin = item
            visited = set()
            while origin.get("reused_from"):
                parent_id = origin["reused_from"]
                if parent_id in visited:
                    raise ValueError("receipt reuse lineage cycles")
                visited.add(parent_id)
                matches = [candidate for candidate in queue["items"]
                           if candidate.get("id") == parent_id]
                if len(matches) != 1:
                    raise ValueError("receipt reuse lineage missing or ambiguous")
                parent = matches[0]
                if (parent.get("kind") != review_receipt.KIND or
                        parent.get("receipt_id") != receipt_id or parent.get("state") != state):
                    raise ValueError("receipt reuse lineage mismatch")
                origin = parent
            if (document.get("source") != origin.get("subject") or
                    capture != origin.get("capture") or
                    capture.get("equivalence") != review_receipt.current_equivalence(capture) or
                    review_receipt.current_equivalence(item["capture"]) !=
                    review_receipt.current_equivalence(capture)):
                raise ValueError("receipt binding mismatch")
            outcome = document["outcome"]
            if state == "done" and review_receipt.reusable_current(document, capture):
                category = "partial_scope" if outcome == "partial-scope" else "proven_terminal"
            elif (state == "no-current-code" and outcome == "no-current-code" and
                  all(p.get("disposition") == "deleted" or
                      p.get("disposition") == "excluded-with-reason" and p.get("reason") == "empty current file"
                      for p in capture["paths"])):
                category = "no_current_code"
            elif state == "unsupported" and outcome == "unsupported":
                category = "unsupported"
            else:
                raise ValueError("terminal state lacks proof")
            counts[category] += 1
            targets.add(capture["target"])
            for path in capture["paths"]:
                disposition = path.get("disposition", "unknown")
                if disposition not in ("included", "renamed"):
                    exclusions[disposition] = exclusions.get(disposition, 0) + 1
        except (KeyError, TypeError, ValueError, AttributeError, OSError):
            counts["unverified"] += 1
    discovery = queue.get("merged_reconcile") or {}
    allowed = ("after", "before", "complete", "complete_through", "next_cursor", "represented",
               "intents", "unsupported", "duplicates_seen", "records_read", "inventory_digest", "reason", "pages_read", "transient_failures")
    natural = queue.get("merged_discovery") or {}
    return {"natural_discovery": {key: natural[key] for key in ("after", "before", "complete", "error", "reason") if key in natural},
            "discovery": {key: discovery[key] for key in allowed if key in discovery},
            "watermark": queue.get("merged_watermark"), "receipts": counts,
            "path_exclusions": exclusions, "captured_targets": sorted(targets)[:32],
            "additional_captured_targets": max(0, len(targets) - 32),
            "coverage_at_today_target": "unverified", "legacy_done_is_review_proof": False}



def repos_summary(queue, primary, configured=()):
    """Additive per-repo counts for non-primary repos (docs/multi-repo.md)."""
    out = {}
    zero = {"pending": 0, "reviewing": 0, "blocked": 0, "other": 0}
    # Every configured repo stays visible before its first item or push state:
    # the deploy checklist reads this block to confirm what is enrolled.
    for entry in configured:
        slug = entry.get("repo") if isinstance(entry, dict) else entry
        if isinstance(slug, str) and slug != primary:
            out.setdefault(slug, dict(zero))
    # Repos with push state but no queued item stay visible (idle ≠ absent).
    for slug in (queue.get("push_discovery") or {}):
        if slug != primary:
            out.setdefault(slug, dict(zero))
    for item in queue["items"]:
        slug = item.get("repo") or primary
        if slug == primary:
            continue
        entry = out.setdefault(slug, dict(zero))
        state = item.get("state")
        if state in entry:
            entry[state] += 1
        else:
            entry["other"] += 1
    for slug, state in (queue.get("push_discovery") or {}).items():
        if slug in out:
            out[slug]["reviewed_tip"] = state.get("reviewed_tip")
    return out


def summarize(status, queue, heartbeat, config, events, now):
    primary = config.get("repo")
    # Retired promotion records remain in state/queue.json; keep them out of
    # capacity, backlog and completed-work counts until they are removed.
    items = [i for i in queue["items"] if i.get("kind") != "promotion"]
    primary_items = [i for i in items if (i.get("repo") or primary) == primary]
    backlog = {kind: sum(i["kind"] == kind and i["state"] == "pending"
                         and not (kind == "open" and
                                  len(i.get("cycles", [])) >= 1)
                         for i in primary_items)
               for kind in ("open", "delta", "merged", "coverage",
                            review_receipt.KIND, "backfill")}
    outcomes = {key: 0 for key in ("completed", "interrupted", "error")}
    completed = dict(open=0, recent_merge=0, backfill=0, other=0)
    by_id = {i.get("id"): i for i in items if i.get("id")}
    def category(item):
        kind = item.get("kind") or item.get("work_kind")
        if kind == "open" or kind == "delta" and item.get("followup") != "merged":
            return "open"
        if kind == "merged-current" or kind == "delta" and item.get("followup") == "merged" or item.get("source") == "followup":
            return "recent_merge"
        return "backfill" if kind in ("merged", "coverage", "backfill") else "other"
    other = 0
    # A run can be harvested more than once (crash recovery re-harvests; a backfill
    # harvest that retains run ownership is retried every slot pass), so count each
    # run id once, by its latest outcome. Events without a run id count individually.
    finished = {}
    for index, event in enumerate(events):
        at = timestamp(event.get("at"))
        # A completed record with an unparsable `at` must fail visibly instead of
        # silently counting as zero outcomes; a missing or empty `at` stays accepted.
        if event.get("event") == "review_finished" and event.get("at") and at is None:
            raise ValueError("invalid review_finished timestamp")
        if event.get("event") == "review_finished" and at is not None and now - 86400 <= at <= now:
            finished[event.get("run") or ("anonymous", index)] = event
    for event in finished.values():
        outcome = event.get("outcome")
        if outcome in outcomes:
            outcomes[outcome] += 1
            if outcome == "completed":
                completed[category(by_id.get(event.get("item"), event))] += 1
        else:
            other += 1
    last_tick = heartbeat.get("last_tick") or queue.get("last_tick")
    # Freshness must follow completed ticks, never status-file writes or probes.
    if last_tick is not None and timestamp(last_tick) is None:
        raise ValueError("invalid last_tick")
    # The configured cap is a conservative scheduler fallback, not an account quota.
    usage = queue.get("usage") or {}
    limit = usage.get("limit") if isinstance(usage, dict) else None
    starts_cap = limit if type(limit) is int and limit > 0 else config["max_starts_per_hour"]
    ranks = [{**entry, "rank_tier": entry.get("rank_tier", repo_registry.DEFAULT_RANK)}
             for entry in config.get("repos", [])]
    def aging_deadline(item):
        if item.get("kind") == "local-review" and (item.get("generation", 1) > 1 or item.get("repeat_requested") is True) and item.get("created_at"):
            created = timestamp(item["created_at"])
            if created is not None:
                return created + config.get("local_review_aging_minutes", 60) * 60
        return None
    def pending_key(item):
        rank = {"open": 0, "recent_merge": 2, "backfill": 3, "other": 4}[category(item)]
        if item.get("kind") in ("coverage", "backfill"):
            rank = 4
        elif item.get("kind") == "delta" and category(item) == "open":
            rank = 1
        if item.get("kind") == "local-review":
            deadline = aging_deadline(item)
            rank = 0 if (item.get("generation", 1) == 1 and item.get("repeat_requested") is not True) or deadline is not None and now >= deadline else 1
        repo_rank = repo_registry.rank_for(item, primary, ranks)
        # Open PRs/deltas now outrank repository tiers across all repos (#1177).
        if repo_rank is not None and category(item) != "open" and item.get("kind") != "local-review":
            rank = repo_rank
        return (not item.get("operator_priority", False), rank, item.get("order", 999))
    pending = [i for i in items if i.get("state") == "pending"
               and not (i.get("kind") == "open" and i.get("cycles"))]
    return {
        "backfill_reserved_slots": 1,
        "completed_24h_by_work": completed,
        "pending_items": [{"repo": i.get("repo") or (i.get("subject") or {}).get("repo") or config.get("repo"),
                           "pr": i.get("pr") or (i.get("subject") or {}).get("pr"),
                           "title": i.get("title"), "kind": i.get("kind"),
                           "band": "interactive" if pending_key(i)[1] < 2 else "background",
                           "generation": i.get("generation"), "aging_deadline": aging_deadline(i),
                           "reason": i.get("wait_reason") or i.get("last_error"),
                           "approximate_position": position}
                          for position, i in enumerate(sorted(pending, key=pending_key)[:10], 1)],
        "merged_current": merged_current(queue),
        "last_tick": last_tick, "status_as_of": status["generated_at"],
        "paused": bool(queue.get("paused")), "cooldown_until": queue.get("cooldown_until"),
        "starts_60m": sum(at is not None and now - 3600 <= at <= now
                          for at in (timestamp(s) for s in queue.get("starts", []))),
        "starts_cap": starts_cap,
        "in_flight": sum(i["state"] == "reviewing" for i in items),
        "outcomes_24h": outcomes, "other_outcomes_24h": other, "backlog": backlog,
        # Additive multi-repo block: schema stays 2; readers ignore unknown keys.
        "repos": repos_summary(queue, primary, config.get("repos") or ()),
    }


def read_events(path):
    with Path(path).open() as fh:
        for line in fh:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                if line.endswith("\n"):
                    raise  # a complete corrupt record must never become zero outcomes


def systemd_activity():
    """Observe user units, independently of the configured scheduling backend."""
    timers = ("crq-tick.timer", "crq-watchdog.timer", "crq-slot.timer",
              "crq-backfill.timer", "crq-repair.timer")
    services = ()
    units = timers + services
    activity = {unit: {"active": None, "active_state": None, "load_state": None}
                for unit in units}
    for unit in timers:
        activity[unit].update(last_trigger=None, next_elapse=None)
    try:
        output = command(["systemctl", "--user", "show", "--timestamp=unix",
                          "--property=Id,LoadState,ActiveState,LastTriggerUSec,"
                          "NextElapseUSecRealtime,NextElapseUSecMonotonic", *units], 5)
    except (OSError, RuntimeError, subprocess.TimeoutExpired):
        for entry in activity.values():
            entry["error"] = "systemctl user show unavailable"
        return {unit: activity[unit] for unit in timers}, {unit: activity[unit] for unit in services}

    realtime, monotonic = time.time(), time.clock_gettime(time.CLOCK_MONOTONIC)

    def unix_time(value):
        if not value or value in ("0", "infinity", "n/a"):
            return None
        if not value.startswith("@"):
            raise ValueError("unexpected systemd timestamp")
        return float(value[1:]) or None

    def iso_time(value):
        return (dt.datetime.fromtimestamp(value, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                if value is not None else None)

    def monotonic_time(value):
        if not value or value in ("0", "infinity", "n/a"):
            return None
        scales = {"y": 31557600, "month": 2629800, "w": 604800, "d": 86400, "h": 3600,
                  "min": 60, "s": 1, "ms": .001, "us": .000001, "µs": .000001}
        units = "y|month|min|ms|us|µs|w|d|h|s"
        parts = re.findall(rf"(\d+(?:\.\d+)?)({units})", value)
        if not parts or re.sub(rf"\d+(?:\.\d+)?(?:{units})\s*", "", value).strip():
            raise ValueError("unexpected systemd timespan")
        return realtime + sum(float(n) * scales[unit] for n, unit in parts) - monotonic

    for block in output.strip().split("\n\n"):
        properties = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
        unit = properties.get("Id")
        if unit not in activity:
            continue
        entry = activity[unit]
        entry.update(active_state=properties.get("ActiveState"), load_state=properties.get("LoadState"))
        if entry["active_state"] is not None:
            entry["active"] = entry["active_state"] == "active"
        if entry["load_state"] != "loaded":
            entry["error"] = "systemd unit not loaded"
        if unit in timers:
            try:
                entry["last_trigger"] = iso_time(unix_time(properties.get("LastTriggerUSec")))
                next_elapse = unix_time(properties.get("NextElapseUSecRealtime"))
                if next_elapse is None:
                    next_elapse = monotonic_time(properties.get("NextElapseUSecMonotonic"))
                entry["next_elapse"] = iso_time(next_elapse)
            except (ValueError, OverflowError, OSError):
                entry["error"] = "systemd timer timestamp unavailable"
    for entry in activity.values():
        if entry["active_state"] is None:
            entry["error"] = "systemd unit observation unavailable"
    return {unit: activity[unit] for unit in timers}, {unit: activity[unit] for unit in services}


def publish(root, queue, config, schedule, home=None, now=None):
    """Write the shared XDG state summary atomically.

    Call after persisting a completed tick. Administrative summary refreshes
    retain the queue's last_tick, so they cannot hide a stopped schedule.
    """
    root, home = Path(root), Path(home or Path.home())
    now = time.time() if now is None else now
    generated = dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    data = summarize({"generated_at": generated}, queue, {"last_tick": queue.get("last_tick")},
                     config, read_events(root / "state/events.jsonl"), now)
    if not data["last_tick"]:
        raise ValueError("no completed tick to publish")
    # Only the bounded public preview is resolved; queue internals stay private.
    target = Path(os.environ.get("XDG_STATE_HOME", str(home / ".local/state"))) / "crq/summary.json"
    try:
        titles = {(i["repo"], i["pr"]): i.get("title") for i in read(target).get("pending_items", [])
                  if type(i["pr"]) is int and i["pr"] > 0}
    except (OSError, ValueError, KeyError, TypeError):
        titles = {}
    for item in data["pending_items"]:
        repo, pr = item["repo"], item["pr"]
        if type(pr) is int and pr > 0:
            item["title"] = item["title"] or titles.get((repo, pr))
        if not item["title"] and repo and type(pr) is int and pr > 0:
            try:
                item["title"] = command(["gh", "api", f"repos/{repo}/pulls/{pr}",
                                         "--jq", ".title"], 3).strip() or None
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                pass
    data.update(schema_version=2, generated_at=generated)
    data["systemd_timers"], data["systemd_services"] = systemd_activity()
    data["merged_current"] = merged_current(queue, root / "state/receipts")
    data["repair"] = repair_tick.digest(root, queue)
    data["finding_triage"] = finding_triage(root / "state/backfill/findings")
    data["utilization"] = coverage.utilization_digest(queue, queue.get("coverage") or coverage.new_ledger(),
        now=now, max_starts_per_hour=data["starts_cap"])
    data["schedule"] = {"id": config.get("schedule_id", "crq-tick.timer"), "state": schedule.get("status") or "systemd"}
    if data["schedule"]["state"] == "unknown":
        data["schedule"]["error"] = "schedule probe unavailable"
    target = Path(os.environ.get("XDG_STATE_HOME", str(home / ".local/state"))) / "crq/summary.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".summary-", dir=target.parent)
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh, separators=(",", ":"))
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, target)  # mkstemp supplies 0600; no partially visible file
    finally:
        Path(tmp).unlink(missing_ok=True)
    return data
