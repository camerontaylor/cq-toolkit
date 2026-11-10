"""Baseline/current debt and capacity reports; removals never mean reviewed."""
import collections
from pathlib import Path

import review_ledger as ledger


def finding_triage(root, *, strict=True, limit=None):
    """Read atomic rows; status may expose partial counts with explicit errors."""
    counts = collections.Counter()
    needs_human = []
    owner_decisions = []
    operator_attention = []
    owner_count = operator_count = 0
    context_failures = []
    human_count = error_count = context_failure_count = 0
    errors = []
    for filename in sorted((Path(root) / "triage").glob("*.json")):
        try:
            row = ledger.loads(filename.read_bytes())
            status = row["status"]
            finding = row["finding"]
            for value in (status, row["canonical_id"], row["target"],
                          finding["id"], finding["title"], finding["severity"]):
                if not isinstance(value, str) or not value:
                    raise ValueError("invalid finding row")
            detail = {"id": finding["id"], "canonical_id": row["canonical_id"],
                      "path": row.get("mapped_path") or finding.get("path"),
                      "title": finding["title"], "severity": finding["severity"],
                      "target": row.get("target_current", row["target"]),
                      "event_id": row.get("previous_event_id")}
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            if strict:
                raise
            error_count += 1
            if len(errors) < 32:
                errors.append({"file": filename.name, "error": type(exc).__name__})
            continue
        counts[status] += 1
        if isinstance(row.get("context_error"), dict):
            context_failure_count += 1
            if limit is None or len(context_failures) < limit:
                context_failures.append({**detail, "status": status, "context_error": row["context_error"]})
        if status == "needs-human":
            human_count += 1
            failure_class = row.get("failure_class") or "owner-decision"
            target = owner_decisions if failure_class == "owner-decision" else operator_attention
            if failure_class == "owner-decision":
                owner_count += 1
            else:
                operator_count += 1
            if limit is None or len(target) < limit:
                target.append({**detail, "failure_class": failure_class})
            if limit is None or len(needs_human) < limit:
                needs_human.append(detail)
    result = {"counts": dict(sorted(counts.items())), "needs_human": needs_human}
    if human_count:
        result.update(owner_decisions=owner_decisions, operator_attention=operator_attention,
                      owner_decisions_count=owner_count, operator_attention_count=operator_count)
    if context_failure_count:
        result["context_failures"] = context_failures
        result["context_failures_count"] = context_failure_count
        result["context_failures_omitted"] = context_failure_count - len(context_failures)
    if not strict or limit is not None:
        result.update(counts_complete=error_count == 0, error_count=error_count,
                      errors=errors, errors_omitted=error_count - len(errors),
                      needs_human_count=human_count,
                      needs_human_omitted=human_count - len(needs_human))
    return result


def baseline(repo, ranked, policy_digest, ledger_head, at):
    rows = []
    for row in ranked["paths"]:
        rows.append({"path": row["path"], "blob": row["blob"], "tier": row["tier"], "lines": row["lines"],
                     "uncovered": row["uncovered"], "disposition": row["disposition"], "reason": row["reason"]})
    value = {"schema": "cq.backfill-baseline/v1", "target": ranked["target"], "tree": repo.tree(ranked["target"]),
             "manifest_id": ranked["manifest_id"], "ledger_head": ledger_head, "policy_digest": policy_digest,
             "pinned_at": at, "paths": rows, "bounded_partitions": len(ranked["candidates"])}
    value["id"] = ledger.digest(value)
    return value


def summary(repo, ranked, queue, original=None, *, findings_root=None):
    totals = {tier: {"covered_lines": 0, "uncovered_lines": 0, "unresolved_objects": [], "empty_files": 0} for tier in ("T1", "T2", "T3", "T4")}
    current = {r["path"]: r for r in ranked["paths"]}
    for row in current.values():
        group = totals[row["tier"]]
        debt = len(ledger.intervals(row["uncovered"]))
        group["uncovered_lines"] += debt
        group["covered_lines"] += max(0, (row["lines"] or 0) - debt)
        if row["disposition"] in ("unsupported", "ambiguous") or row["lines"] is None:
            group["unresolved_objects"].append({"path": row["path"], "reason": row["reason"], "countable_lines": row["lines"]})
        group["empty_files"] += row["disposition"] == "empty"
    baseline_result = None
    if original:
        if original["id"] != ledger.digest({k: v for k, v in original.items() if k != "id"}):
            raise ledger.IntegrityError("baseline hash mismatch")
        baseline_result = {"id": original["id"], "target": original["target"], "surviving_T1_debt": 0,
                           "baseline_T1_reviewed_since": 0, "baseline_T1_removed_or_superseded": 0,
                           "new_T1_debt": 0, "unresolved_baseline_objects": []}
        surviving_all = collections.defaultdict(set)
        for row in original["paths"]:
            if row["tier"] != "T1":
                continue
            old_debt = ledger.intervals(row["uncovered"])
            name = repo.lineage(original["target"], ranked["target"], row["path"])
            if name is None:
                if repo.proven_deleted(original["target"], ranked["target"], row["path"]):
                    baseline_result["baseline_T1_removed_or_superseded"] += len(old_debt)
                else:
                    baseline_result["unresolved_baseline_objects"].append({**row, "reason": "unverified baseline lineage"})
                continue
            present = current.get(name)
            unmeasurable = not present or present["lines"] is None or present["disposition"] in ("unsupported", "ambiguous")
            unmeasured_baseline = row["lines"] is None or row["disposition"] in ("unsupported", "ambiguous")
            _, mapped_all = repo.carry(original["target"], ranked["target"], row["path"], set(range(1, (row["lines"] or 0) + 1))) if row["lines"] else (None, set())
            _, mapped_debt = repo.carry(original["target"], ranked["target"], row["path"], old_debt) if old_debt else (None, set())
            if name:
                surviving_all[name].update(mapped_all)
            if unmeasurable:
                # Current coverage is unverified for an unmeasurable object,
                # even when the inventory retains countable lines.
                if unmeasured_baseline or mapped_debt:
                    baseline_result["unresolved_baseline_objects"].append({**row, "reason": "unmeasurable current object"})
            else:
                remaining = mapped_debt & ledger.intervals(present.get("uncovered", []))
                baseline_result["surviving_T1_debt"] += len(remaining)
                baseline_result["baseline_T1_reviewed_since"] += len(mapped_debt - remaining)
                if unmeasured_baseline and present["uncovered"]:
                    baseline_result["unresolved_baseline_objects"].append(row)
            baseline_result["baseline_T1_removed_or_superseded"] += len(old_debt) - len(mapped_debt)
        for name, row in current.items():
            if row["tier"] == "T1":
                baseline_result["new_T1_debt"] += len(ledger.intervals(row["uncovered"]) - surviving_all[name])
        daily = queue.get("backfill_daily_capacity", {})
        start = ledger.timestamp(original["pinned_at"]).date()
        end = ledger.timestamp(ranked.get("evaluated_at", original["pinned_at"])).date()
        observed_days = max(1, (end - start).days + 1)
        observed = {date: day for date, day in daily.items() if start.isoformat() <= date <= end.isoformat()}
        completed = sum(day.get("completed_partitions", 0) for day in observed.values())
        remaining_partitions = sum(c["tier"] == "T1" for c in ranked.get("candidates", []))
        baseline_result["remaining_eligible_T1_partitions"] = remaining_partitions
        baseline_result["estimated_days_at_observed_capacity"] = ((remaining_partitions * observed_days + completed - 1) // completed) if completed and len(observed) == observed_days else None
        baseline_result["capacity_estimate_limit"] = "eligible partitions only; missing daily observations prevent an estimate; held work and unresolved objects remain separately visible"
        age = (ledger.timestamp(ranked.get("evaluated_at", original["pinned_at"])) - ledger.timestamp(original["pinned_at"])).days
        pending = baseline_result["surviving_T1_debt"] or baseline_result["unresolved_baseline_objects"]
        baseline_result["target_status"] = "missed-capacity-or-exclusions" if age >= 14 and pending else "pending" if pending else "baseline-zero"
    triage = finding_triage(findings_root) if findings_root is not None else None
    states = collections.Counter(j.get("state", "unknown") for j in queue.get("items", []) if j.get("kind") in ("backfill", "coverage"))
    return {"manifest_id": ranked["manifest_id"], "target": ranked["target"], "tiers": totals,
            "baseline": baseline_result, "required": ranked["required"], "states": dict(sorted(states.items())),
            "publication_pending": states["publication-pending"], "quarantined_families": sum(bool(f.get("quarantined")) for f in queue.get("backfill_families", {}).values()),
            "finding_triage": triage or {"status": "not-collected"},
            "finding_delivery_backlog": triage["counts"] if triage is not None else queue.get("backfill_finding_backlog", {"status": "not-collected"}),
            "spare_quota_admissions": queue.get("backfill_admissions", []),
            "daily_capacity": queue.get("backfill_daily_capacity", {}),
            "idle_with_coverage_candidate": queue.get("backfill_idle_with_candidate", 0),
            "strict_T1_zero": totals["T1"]["uncovered_lines"] == 0 and not totals["T1"]["unresolved_objects"] and not ranked["evidence_gaps"],
            "operational_target": "zero surviving baseline T1 debt within 14 days, conditional on spare included quota and no unresolved exclusions"}
