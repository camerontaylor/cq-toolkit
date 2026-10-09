"""Atomic, allow-listed fleet summary; no review launches or git fetches."""
import datetime as dt
import coverage
import repair_tick
import json
import os
from pathlib import Path
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


def summarize(status, queue, heartbeat, config, events, now):
    items = queue["items"]
    backlog = {kind: sum(i["kind"] == kind and i["state"] == "pending" for i in items)
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
    return {
        "last_tick": last_tick, "status_as_of": status["generated_at"],
        "paused": bool(queue.get("paused")), "cooldown_until": queue.get("cooldown_until"),
        "starts_60m": sum(now - 3600 <= timestamp(s) <= now for s in queue.get("starts", [])),
        "starts_cap": config["max_starts_per_hour"],
        "in_flight": sum(i["state"] == "reviewing" or
                         (i["kind"] == "promotion" and i["state"] in
                          ("requested", "signer_running")) for i in items),
        "outcomes_24h": outcomes, "other_outcomes_24h": other, "backlog": backlog,
        "promotion": {
            "state": "disabled" if not enabled else "blocked" if blockers else
                     ", ".join(sorted({i["state"] for i in promotions})) or "idle",
            "last_promoted_sha": promotion.get("last_promoted_sha"),
            "last_promoted_at": promotion.get("last_promoted_at"), "blockers": blockers,
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


def publish(root, queue, config, schedule, home=None, now=None):
    """Write only ~/Library/Application Support/crq/summary.json atomically.

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
    data["repair"] = repair_tick.digest(root, queue)
    data["utilization"] = coverage.utilization_digest(queue, queue.get("coverage") or coverage.new_ledger(),
        now=now, max_starts_per_hour=config["max_starts_per_hour"])
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
