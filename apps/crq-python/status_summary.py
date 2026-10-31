"""Atomic, allow-listed fleet summary; no review launches or git fetches."""
import datetime as dt
import coverage
import review_receipt
import repair_tick
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def timestamp(value):
    if not value:
        return None
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def read(path):
    return json.loads(Path(path).read_text())


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
            review_receipt.read_receipt(receipt_root, receipt_id)
            document = read(Path(receipt_root) / (receipt_id + ".json"))
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
        except (KeyError, TypeError, ValueError, OSError):
            counts["unverified"] += 1
    discovery = queue.get("merged_reconcile") or {}
    allowed = ("after", "before", "complete", "complete_through", "next_cursor", "represented",
               "intents", "unsupported", "duplicates_seen", "records_read", "inventory_digest")
    natural = queue.get("merged_discovery") or {}
    return {"natural_discovery": {key: natural[key] for key in ("after", "before", "complete", "error") if key in natural},
            "discovery": {key: discovery[key] for key in allowed if key in discovery},
            "watermark": queue.get("merged_watermark"), "receipts": counts,
            "path_exclusions": exclusions, "captured_targets": sorted(targets)[:32],
            "additional_captured_targets": max(0, len(targets) - 32),
            "coverage_at_today_target": "unverified", "legacy_done_is_review_proof": False}



def summarize(status, queue, heartbeat, config, events, now):
    items = queue["items"]
    backlog = {kind: sum(i["kind"] == kind and i["state"] == "pending"
                         and not (kind == "open" and
                                  len(i.get("cycles", [])) >= 1)
                         for i in items)
               for kind in ("open", "delta", "merged", "promotion", "coverage")}
    outcomes = {key: 0 for key in ("completed", "interrupted", "error")}
    other = 0
    for event in events:
        at = timestamp(event.get("at"))
        if event.get("event") == "review_finished" and at is not None and now - 86400 <= at <= now:
            outcome = event.get("outcome")
            if outcome in outcomes:
                outcomes[outcome] += 1
            else:
                other += 1
    promotions = [i for i in items if i["kind"] == "promotion" and i["state"] not in ("done", "skipped")]
    blockers = []
    for item in promotions:
        counts = {}
        for finding in item.get("blocking", []):
            if not finding.get("resolution"):
                severity = finding.get("severity", "unknown")
                counts[severity] = counts.get(severity, 0) + 1
        if counts:
            blockers.append({"item": item["id"], "counts": counts})
    promotion = queue.get("promotion") or {}
    enabled = bool(config.get("promotion", {}).get("enabled"))
    last_tick = heartbeat.get("last_tick") or queue.get("last_tick")
    # Freshness must follow completed ticks, never status-file writes or probes.
    timestamp(last_tick)
    # The configured cap is a conservative scheduler fallback, not an account quota.
    usage = queue.get("usage") or {}
    limit = usage.get("limit") if isinstance(usage, dict) else None
    starts_cap = limit if type(limit) is int and limit > 0 else config["max_starts_per_hour"]
    return {
        "merged_current": merged_current(queue),
        "last_tick": last_tick, "status_as_of": status["generated_at"],
        "paused": bool(queue.get("paused")), "cooldown_until": queue.get("cooldown_until"),
        "starts_60m": sum(now - 3600 <= timestamp(s) <= now for s in queue.get("starts", [])),
        "starts_cap": starts_cap,
        "in_flight": sum(i["state"] == "reviewing" or
                         (i["kind"] == "promotion" and i["state"] in
                          ("requested", "signer_running")) for i in items),
        "outcomes_24h": outcomes, "other_outcomes_24h": other, "backlog": backlog,
        "promotion": {
            "state": "disabled" if not enabled else
                     "needs-human" if any(i.get("gate_stalled_at") for i in promotions) else "blocked" if blockers else
                     ", ".join(sorted({i["state"] for i in promotions})) or "idle",
            "last_promoted_sha": promotion.get("last_promoted_sha"),
            "last_promoted_at": promotion.get("last_promoted_at"), "blockers": blockers,
            "gate_alerts": [{key: alert.get(key) for key in ("at", "item", "sha", "base")}
                            for alert in promotion.get("gate_alerts", []) if not alert.get("acked")],
        },
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
    timers = ("crq-tick.timer", "crq-watchdog.timer", "crq-records.timer")
    services = ("crq-records.service",)
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
        scales = {"w": 604800, "d": 86400, "h": 3600, "min": 60,
                  "s": 1, "ms": .001, "us": .000001, "µs": .000001}
        parts = re.findall(r"(\d+(?:\.\d+)?)(min|ms|us|µs|w|d|h|s)", value)
        if not parts or re.sub(r"\d+(?:\.\d+)?(?:min|ms|us|µs|w|d|h|s)\s*", "", value).strip():
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


def publish(root, queue, config, schedule, home=None, now=None, *, promotion_mode=None):
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
    data.update(schema_version=2, generated_at=generated)
    data["promotion"]["mode"] = promotion_mode
    data["systemd_timers"], data["systemd_services"] = systemd_activity()
    data["merged_current"] = merged_current(queue, root / "state/receipts")
    data["repair"] = repair_tick.digest(root, queue)
    data["utilization"] = coverage.utilization_digest(queue, queue.get("coverage") or coverage.new_ledger(),
        now=now, max_starts_per_hour=data["starts_cap"])
    data["schedule"] = {"id": config.get("schedule_id", "crq-tick.timer"), "state": schedule.get("status") or "systemd"}
    if data["schedule"]["state"] == "unknown":
        data["schedule"]["error"] = "schedule probe unavailable"
    data["promotion"]["merges_waiting"] = None
    try:
        count = command(["/usr/bin/git", "-C", str(config["clone"]), "rev-list", "--count", "--merges",
                         "--first-parent", "origin/main..origin/merge-queue"], 5)
        data["promotion"]["merges_waiting"] = int(count.strip())
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired):
        data["promotion"]["merges_error"] = "cached merge refs unavailable"
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
