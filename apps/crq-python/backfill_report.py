"""Baseline/current debt and capacity reports; removals never mean reviewed."""
import collections

import review_ledger as ledger


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


def summary(repo, ranked, queue, original=None):
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
            if row["lines"] is None or row["disposition"] in ("unsupported", "ambiguous"):
                present = current.get(name)
                if not present or present["lines"] is None or present["disposition"] in ("unsupported", "ambiguous") or present["uncovered"]:
                    baseline_result["unresolved_baseline_objects"].append(row)
            _, mapped_all = repo.carry(original["target"], ranked["target"], row["path"], set(range(1, (row["lines"] or 0) + 1))) if row["lines"] else (None, set())
            _, mapped_debt = repo.carry(original["target"], ranked["target"], row["path"], old_debt) if old_debt else (None, set())
            if name:
                surviving_all[name].update(mapped_all)
            remaining = mapped_debt & ledger.intervals(current.get(name, {}).get("uncovered", []))
            baseline_result["surviving_T1_debt"] += len(remaining)
            baseline_result["baseline_T1_reviewed_since"] += len(mapped_debt - remaining)
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
    states = collections.Counter(j.get("state", "unknown") for j in queue.get("items", []) if j.get("kind") in ("backfill", "coverage"))
    return {"manifest_id": ranked["manifest_id"], "target": ranked["target"], "tiers": totals,
            "baseline": baseline_result, "required": ranked["required"], "states": dict(sorted(states.items())),
            "publication_pending": states["publication-pending"], "quarantined_families": sum(bool(f.get("quarantined")) for f in queue.get("backfill_families", {}).values()),
            "finding_delivery_backlog": queue.get("backfill_finding_backlog", {"status": "not-collected"}),
            "spare_quota_admissions": queue.get("backfill_admissions", []),
            "daily_capacity": queue.get("backfill_daily_capacity", {}),
            "idle_with_coverage_candidate": queue.get("backfill_idle_with_candidate", 0),
            "strict_T1_zero": totals["T1"]["uncovered_lines"] == 0 and not totals["T1"]["unresolved_objects"] and not ranked["evidence_gaps"],
            "operational_target": "zero surviving baseline T1 debt within 14 days, conditional on spare included quota and no unresolved exclusions"}
