#!/usr/bin/env python3
"""Extract a publishable schema provenance from a private crq state directory.

The output is deliberately not a redacted state snapshot. It contains only
allowlisted schema keys, JSON value types, code-enum item states and bucketed
counts. Exact zero is kept for unknown-key diagnostics; nonzero counts are
bucketed. `events.jsonl` and `work.jsonl` are scanned end to end, never
sampled, so a key that first appears in the tail is still reported. No scalar
value from the source is written: no repository slug, PR or commit identifier,
path, host, timestamp, free text, credential or config entry. That makes the
projection safe to publish and lets the checked-in synthetic fixture be
validated against the real schema.

Run it against a deployed state tree, or against a synthetic tree in tests:

    python3 state_fixture_provenance.py --queue state/queue.json \
        --summary ~/.local/state/crq/summary.json \
        --heartbeat ~/.local/state/crq/heartbeat.json \
        --status state/status.json --events state/events.jsonl \
        --work state/work.jsonl --cooldowns state/repair/provider-cooldowns.json \
        --run-dir state/runs/<one-run> --observed-on 2026-11-09 --out provenance.json

``--check`` compares the generated projection with a checked-in file. It is an
operator command, not a CI gate, because it needs the private source tree.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any, Dict, Iterable, List


SCHEMA = "cq.crq-state-provenance/v1"

QUEUE_TOP_LEVEL = frozenset({
    "archived_tick_runs", "author_requests", "backfill_admission_history_version",
    "backfill_admissions", "backfill_capacity_runs", "backfill_coverage_reconciled",
    "backfill_daily_capacity", "backfill_families", "backfill_finding_backlog",
    "backfill_halt_operation", "backfill_halted", "backfill_history_import",
    "backfill_last_manifest", "backfill_operator_events", "backfill_ordinary_exhausted",
    "backfill_publication_error", "backfill_reservations", "backfill_scope_failures",
    "backfill_starts_at_observation", "backfill_state_events",
    "backfill_unsupported_construction", "backfill_usage", "backfill_usage_probe_at",
    "cleanup_backlog", "client_health", "cooldown_until", "coverage", "created_at",
    "items", "last_tick", "legacy_repair_backfilled", "legacy_repair_missing",
    "merged_current_requests", "merged_discovery", "merged_reconcile",
    "merged_watermark", "merged_wrappers_pruned_at", "pause_reason", "paused",
    "promotion", "promotion_audit", "push_discovery", "queue_client_requests",
    "repair_own_commits", "review_events", "review_ledger_head",
    "review_notify_outbox", "review_pr_links", "review_pr_outbox",
    "review_requests", "rl_backoff_min", "starts", "usage",
})

ITEM_KINDS = frozenset({
    "author", "backfill", "coverage", "delta", "local-review", "merged",
    "merged-current", "open", "promotion", "push-current",
})

ITEM_STATES = frozenset({
    "blocked", "cancelled", "done", "failed", "launch-unknown",
    "no-current-code", "pending", "promoting", "publication-pending",
    "quarantined", "rejected", "repair_failed", "retried", "reviewing",
    "skipped", "unsupported",
})

ITEM_KEYS = frozenset({
    "addressing", "attempt", "attempt_id", "attempts", "author", "author_cycles",
    "base", "base_sha", "batch_sha", "blocking", "capture", "completed_at",
    "construction_policy_digest", "context", "coverage_paths", "coverage_region",
    "coverage_sha", "coverage_satisfied_by", "coverage_source", "created_at",
    "cycles", "depends_on", "diff_bytes", "dispatch_tier_importance", "dispatched",
    "failures", "family", "family_failures", "followup", "gate_stalled_at",
    "generation", "head", "head_tree", "id", "identity", "identity_inputs",
    "inventory_subject_id", "issue", "issue_attempt_at", "issue_pending",
    "issue_request", "job_id", "kind", "last_error", "last_push", "local_run_id",
    "measure", "merge_commit", "merged_at", "merges", "notes", "not_before",
    "notify", "observers", "operator_priority", "order", "owed_per_audit",
    "partition", "path_lineages", "path_scores", "path_tiers", "paths",
    "pinned_base", "pr", "pr_branch", "pr_head", "pr_observers", "pr_review",
    "pr_review_attempt_at", "pr_review_attempts", "pr_review_pending",
    "pr_review_request", "prior_base", "prior_cycles", "profile", "prs",
    "publication_event_id", "publication_pending", "publication_reason",
    "published_event_id", "receipt_id", "refs", "remediation_state", "repair_origin",
    "repair_runs", "repeat_requested", "repo", "request", "request_id",
    "requested_at", "residual", "retry", "reviewed_sha", "reviewed_tip",
    "reused_from", "row", "run", "scope", "scope_adequate", "scope_digest",
    "score", "signer", "signer_result", "since", "source", "state", "statuses",
    "subject", "subject_id", "subject_kind", "success_at", "tier",
    "tier_importance", "target", "target_ref", "target_tree", "vendor_state",
    "voided_cycles", "voided_prior_cycles", "wait_reason",
})

SUMMARY_KEYS = frozenset({
    "backfill_reserved_slots", "backlog", "completed_24h_by_work", "cooldown_until",
    "finding_triage", "generated_at", "in_flight", "last_tick", "merged_current",
    "other_outcomes_24h", "outcomes_24h", "paused", "pending_items", "repair",
    "repos", "schedule", "schema_version", "starts_60m", "starts_cap",
    "status_as_of", "systemd_services", "systemd_timers", "utilization",
})

STATUS_KEYS = frozenset({"cooldown_until", "finding_triage", "generated_at",
                         "items", "paused"})

HEARTBEAT_KEYS = frozenset({"alert_agent_host", "alert_agent_id", "last_tick",
                            "root", "schedule_id", "stale_alarm_min"})

EVENT_KEYS = frozenset({
    "acknowledged_at", "agent", "at", "audit_at", "base", "batch", "blocking",
    "body_only", "cycle", "description", "error", "event", "finding_id",
    "findings", "from", "gap_min", "head", "inline", "issue", "item", "job",
    "label", "last_tick", "mode", "notes", "notified", "ordinary_gate",
    "origin_job", "outcome", "posted_state", "pr", "reason", "reasons", "repo",
    "request", "review", "reviewed_tip", "run", "severity", "sha", "source_sha",
    "state", "status", "target", "text", "tip", "to", "verdict", "workflow",
})

WORK_KEYS = frozenset({"at", "harness", "head", "host", "pr", "repo", "role",
                       "runId", "source", "task", "type", "workId"})

RUN_FILE_KEYS = {
    "classification.json": frozenset({
        "bad_lines", "counted", "events", "exit", "failure_provenance", "findings",
        "message", "outcome", "reviewed_files", "severity_counts"}),
    "exit.json": frozenset({"ended_at", "exit", "timed_out"}),
    "meta.json": frozenset({
        "author", "base", "cmd", "coverage_paths", "coverage_sha", "cycle",
        "dirty_diff", "head", "item_id", "kind", "label", "planned_paths", "pr",
        "pr_branch", "pr_head", "range_policy", "repo", "review_pin", "reviewed_tip",
        "run_id", "started_at", "target", "workId", "worktree", "wt_branch"}),
    "secret-scan.json": frozenset({
        "base", "denylist_hits", "denylist_rules", "diff_bytes", "gitleaks",
        "gitleaks_hits", "head"}),
}

RUN_TEXT_FILES = frozenset({"findings.md", "review.ndjson", "review.pid",
                            "runner.log", "stderr.log"})

SAFE_MARKERS = ("/home/", "/Users/", "ctaylor", "camerontaylor", "ghp_",
                "github_pat_", "BEGIN OPENSSH", "BEGIN RSA", "AKIA",
                "-----BEGIN", "ssh-rsa", "ssh-ed25519")


def type_name(value: Any) -> str:
    if value is None:
        return "null"
    if type(value) is bool:
        return "bool"
    if type(value) is int:
        return "int"
    if type(value) is float:
        return "float"
    if isinstance(value, str):
        return "str"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "object"
    return "other"


def bucket(count: int) -> str:
    for limit, label in ((0, "0"), (9, "1-9"), (99, "10-99"), (999, "100-999")):
        if count <= limit:
            return label
    return "1000+"


def unknown_count(count: int) -> Any:
    """Keep an exact zero diagnostic; bucket every nonzero count."""
    return 0 if count == 0 else bucket(count)


def _types(found: Dict[str, set], unknown: int) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for key in sorted(found):
        kinds = sorted(found[key])
        result[key] = kinds[0] if len(kinds) == 1 else kinds
    result["_unknown_key_count"] = unknown_count(unknown)
    return result


def key_types(objects: Iterable[Any], allowed: frozenset) -> Dict[str, Any]:
    found: Dict[str, set] = collections.defaultdict(set)
    unknown = 0
    for value in objects:
        if not isinstance(value, dict):
            continue
        for key, item in value.items():
            if key in allowed:
                found[key].add(type_name(item))
            else:
                unknown += 1
    return _types(found, unknown)


def read_json(path: str | None) -> Any:
    if not path:
        return None
    return json.loads(Path(path).read_text())


def scan_jsonl(path: str | None, allowed: frozenset,
               event_field: str | None = None) -> tuple[Dict[str, Any], set]:
    """Aggregate key/type shape across the whole log, retaining no values."""
    found: Dict[str, set] = collections.defaultdict(set)
    unknown = 0
    event_types = set()
    if path:
        with Path(path).open(errors="replace") as stream:
            for line in stream:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(row, dict):
                    continue
                for key, item in row.items():
                    if key in allowed:
                        found[key].add(type_name(item))
                    else:
                        unknown += 1
                if event_field and isinstance(row.get(event_field), str):
                    event_types.add(row[event_field])
    return _types(found, unknown), event_types


def project(args: argparse.Namespace) -> Dict[str, Any]:
    queue = read_json(args.queue)
    queue = queue if isinstance(queue, dict) else {}
    items = queue.get("items") if isinstance(queue.get("items"), list) else []

    by_kind: Dict[str, List[Any]] = collections.defaultdict(list)
    unknown_kinds = 0
    for item in items:
        kind = item.get("kind") if isinstance(item, dict) else None
        if kind in ITEM_KINDS:
            by_kind[kind].append(item)
        else:
            unknown_kinds += 1

    item_keys = {}
    item_states = {}
    all_states = set()
    for kind in sorted(by_kind):
        rows = by_kind[kind]
        item_keys[kind] = key_types(rows, ITEM_KEYS)
        states = set()
        for row in rows:
            state = row.get("state")
            if state in ITEM_STATES:
                states.add(state)
                all_states.add(state)
            elif state is not None:
                states.add("other")
                all_states.add("other")
        item_states[kind] = sorted(states)

    summary = read_json(args.summary)
    status = read_json(args.status)
    heartbeat = read_json(args.heartbeat)
    event_keys, event_types = scan_jsonl(args.events, EVENT_KEYS, "event")
    work_keys, _ = scan_jsonl(args.work, WORK_KEYS)
    cooldowns = read_json(args.cooldowns)

    cooldown_shape = None
    if isinstance(cooldowns, dict):
        key_types_seen = {type_name(key) for key in cooldowns}
        value_types_seen = {type_name(value) for value in cooldowns.values()}
        cooldown_shape = {
            "key_type": sorted(key_types_seen)[0] if len(key_types_seen) == 1 else sorted(key_types_seen),
            "value_type": sorted(value_types_seen)[0] if len(value_types_seen) == 1 else sorted(value_types_seen),
            "entry_count_bucket": bucket(len(cooldowns)),
        }

    run_files = {}
    unknown_run_files = 0
    if args.run_dir:
        root = Path(args.run_dir)
        for path in sorted(root.iterdir()) if root.is_dir() else []:
            if not path.is_file() or path.name.startswith("._"):
                continue
            if path.name in RUN_FILE_KEYS:
                value = read_json(str(path))
                run_files[path.name] = key_types([value], RUN_FILE_KEYS[path.name])
            elif path.name in RUN_TEXT_FILES:
                run_files[path.name] = {"type": "text"}
            else:
                unknown_run_files += 1

    provenance: Dict[str, Any] = {
        "schema": SCHEMA,
        "observed_on": args.observed_on,
        "source": "deployed crq state, read-only schema inspection",
        "policy": (
            "Only allowlisted schema keys, JSON value types, code-enum item states "
            "and bucketed counts are retained. Exact zero is retained for "
            "unknown-key diagnostics; nonzero counts are bucketed. No scalar "
            "value, identifier, path, host, timestamp, free text, credential or "
            "config entry is written."
        ),
        "queue": {
            "top_level_keys": key_types([queue], QUEUE_TOP_LEVEL),
            "item_kinds": sorted(by_kind),
            "unknown_kind_count": unknown_count(unknown_kinds),
            "item_states": sorted(all_states),
            "item_keys_by_kind": item_keys,
            "item_states_by_kind": item_states,
            "item_count_bucket": bucket(len(items)),
        },
        "summary_keys": key_types([summary], SUMMARY_KEYS) if isinstance(summary, dict) else None,
        "status_keys": key_types([status], STATUS_KEYS) if isinstance(status, dict) else None,
        "heartbeat_keys": key_types([heartbeat], HEARTBEAT_KEYS) if isinstance(heartbeat, dict) else None,
        "event_keys": event_keys,
        "event_type_count_bucket": bucket(len(event_types)),
        "work_keys": work_keys,
        "repair_cooldowns": cooldown_shape,
        "run_files": run_files,
        "unknown_run_file_count": unknown_count(unknown_run_files),
        "redaction": {
            "dropped_value_classes": [
                "repository slugs", "PR numbers", "commit and tree object IDs",
                "item, request, run and job IDs", "file paths and worktree paths",
                "finding titles and bodies", "notes and operator messages",
                "host names and absolute paths", "alert endpoints",
                "provider credentials and cooldown names", "config overlays",
            ],
            "retained_value_classes": [
                "allowlisted schema key names", "JSON type names",
                "code-enum item kinds and states",
                "bucketed counts and exact-zero unknown-key diagnostics",
            ],
        },
    }
    canonical = json.dumps(provenance, sort_keys=True, separators=(",", ":"),
                           ensure_ascii=True)
    provenance["projection_sha256"] = hashlib.sha256(canonical.encode()).hexdigest()
    return provenance


def assert_safe(text: str) -> None:
    for marker in SAFE_MARKERS:
        if marker in text:
            raise SystemExit("provenance refused: output contains a private marker")
    if re.search(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b", text):
        raise SystemExit("provenance refused: output contains a token-like value")


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--queue", required=True)
    parser.add_argument("--summary")
    parser.add_argument("--heartbeat")
    parser.add_argument("--status")
    parser.add_argument("--events")
    parser.add_argument("--work")
    parser.add_argument("--cooldowns")
    parser.add_argument("--run-dir")
    parser.add_argument("--observed-on", required=True)
    parser.add_argument("--out")
    parser.add_argument("--check")
    args = parser.parse_args(argv)
    text = json.dumps(project(args), indent=2, sort_keys=True) + "\n"
    assert_safe(text)
    if args.check:
        expected = Path(args.check).read_text()
        if expected != text:
            print(f"provenance differs from {args.check}", file=sys.stderr)
            return 1
        return 0
    if args.out:
        Path(args.out).write_text(text)
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
