"""Reproducible inventory: all external state is captured before ranking.

rank() consumes JSON only. No clock, Git, queue mutation or provider call can
alter a replay. Unsupported objects remain in debt reports and required rows.
"""
import collections
import copy
import json
import math
import fnmatch
import re

import review_ledger as ledger
from backfill_accounting import BLAME_OPTIONS, ranges

VERSION = "cq.backfill-inventory/v1"


def queue_snapshot(value):
    """Versioned encoding for legacy, non-scoring floating point diagnostics.

    Review events remain in the integer-only JCS domain. Raw queue JSON is also
    retained, so a tagged diagnostic can never replace source provenance.
    """
    if type(value) is float:
        if not math.isfinite(value):
            raise ledger.IntegrityError("non-finite queue diagnostic")
        return {"cq.legacy-number/v1": repr(value)}
    if isinstance(value, dict):
        return {k: queue_snapshot(v) for k, v in value.items()}
    if isinstance(value, list):
        return [queue_snapshot(v) for v in value]
    return value


def tier(name, policy):
    if any(re.search(pattern, name) for pattern in policy["protected_patterns"]):
        return "T1"
    for importance in ("T1", "T2", "T3", "T4"):
        if any(fnmatch.fnmatchcase(name, glob) for glob in policy["tiers"][importance]):
            return importance
    raise ledger.IntegrityError("path has no importance tier")


def effective_limits(policy, require_verified=True):
    reviewer = policy["reviewer"]
    if require_verified and (reviewer.get("verified") is not True or not reviewer.get("evidence")):
        raise ledger.IntegrityError("deployed reviewer limits not verified; go-live blocked")
    files = min(8, policy["max_files"], reviewer.get("max_files") or 8)
    per_file = min(256 * 1024, policy["max_file_bytes"])
    total = min(2 * 1024 * 1024, policy["max_total_bytes"])
    diff = reviewer.get("max_diff_bytes")
    if files < 1 or per_file < 1 or total < 1 or require_verified and (type(diff) is not int or diff < 1):
        raise ledger.IntegrityError("invalid construction limits")
    return {"files": files, "per_file": per_file, "total": total, "diff": diff}


def required_groups(required):
    rows = required["rows"]
    by_pr = {r["pr"]: r for r in rows}
    if len(by_pr) != len(rows) or len({r["row"] for r in rows}) != len(rows):
        raise ledger.IntegrityError("duplicate required-list row")
    member, result = set(), []
    for union in required["explicit_unions"]:
        if not union or set(union) - by_pr.keys() or member.intersection(union):
            raise ledger.IntegrityError("invalid explicit PR union")
        member.update(union)
        result.append({"prs": sorted(union), "row": min(by_pr[p]["row"] for p in union)})
    result.extend({"prs": [r["pr"]], "row": r["row"]} for r in rows if r["pr"] not in member)
    return sorted(result, key=lambda g: g["row"])


def confirmed_counts(events):
    status, paths, canonical = {}, {}, {}
    for value in events:
        if value["event_type"] == "review":
            for finding in value["payload"]["findings"]:
                fid = finding["id"]
                status[fid], paths[fid], canonical[fid] = "untriaged", finding["path"], fid
        elif value["event_type"] == "finding-event":
            p = value["payload"]; fid = p["finding_id"]
            if p["action"] == "duplicate":
                canonical[fid] = p["evidence"]["canonical_id"]
            elif p["action"] in ("confirmed", "fixed", "already-fixed", "dismissed", "needs-human", "superseded"):
                status[fid] = p["action"]
    counts = collections.defaultdict(set)
    for fid, state in status.items():
        if state in ("confirmed", "fixed", "already-fixed"):
            counts[paths[fid]].add(canonical[fid])
    return {name: len(ids) for name, ids in counts.items()}


def capture(repo, target, ledger_head, events, artifacts, queue, required, tiers, limits,
            evaluated_at, required_paths, protected_bytes, members=None):
    """required_paths are retained forge/path-lineage evidence, never LLM output."""
    repo.resolve(target); ledger.timestamp(evaluated_at)
    ledger.validate_sequence(events)
    import hashlib
    if hashlib.sha256(protected_bytes).hexdigest() != tiers["protected_policy_sha256"]:
        raise ledger.IntegrityError("tier policy does not match protected-path snapshot")
    bounds = effective_limits(limits, require_verified=False)
    rows = repo.inventory(target, bounds["per_file"])
    covered, evidence, gaps = repo.coverage(target, events, artifacts)
    churn, findings = repo.churn(target, evaluated_at), confirmed_counts(events)
    for row in rows:
        name = row["path"]
        row.update(tier=tier(name, tiers), covered=ranges(covered.get(name, set())),
                   evidence=sorted(evidence.get(name, [])), churn=churn.get(name, 0), findings=findings.get(name, 0))
    raw_queue = artifacts.put(json.dumps(queue, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())
    queue = queue_snapshot(copy.deepcopy(queue))
    mapped_ownership = []
    by_name = {r["path"]: r for r in rows}
    lineages = {}
    failures = queue.get("backfill_scope_failures", {})
    for job in queue.get("items", []):
        if not job.get("target"):
            continue
        for scope in job.get("scope", []):
            unit = job.get("path_lineages", {}).get(scope["path"], scope["path"])
            if unit not in failures:
                continue
            name = repo.lineage(job["target"], target, scope["path"])
            if name in by_name:
                lineages.setdefault(name, set()).add(unit)
    # A verified rename keeps its failure lineage. Multiple histories mapping
    # to one current path are conservatively joined, never reset by regrouping.
    for name, units in lineages.items():
        canonical = min(units)
        values = [failures[u] for u in units]
        failures[canonical] = {"failures": max(v["failures"] for v in values),
                               "quarantined": any(v.get("quarantined") for v in values),
                               "next_eligible_at": max((v.get("next_eligible_at") for v in values if v.get("next_eligible_at")), default=None)}
        lineages[name] = canonical
    queue["backfill_path_lineages"] = lineages
    for job in queue.get("items", []):
        if not (job.get("state") in ("pending", "reviewing", "launch-unknown", "publication-pending") or job.get("vendor_state") in ("live", "unknown")):
            continue
        for owned in job.get("scope", []):
            if job.get("target") == target:
                continue
            name, lines = repo.carry(job["target"], target, owned["path"], ledger.intervals(owned["intervals"]))
            if name in by_name and lines:
                mapped_ownership.append({"target": target, "path": name, "blob": by_name[name]["blob"], "intervals": ranges(lines)})
            elif owned["path"] in by_name:
                # Uncertain ownership mapping conservatively holds this path.
                row = by_name[owned["path"]]
                mapped_ownership.append({"target": target, "path": row["path"], "blob": row["blob"], "intervals": [[1, row["lines"]]] if row["lines"] else []})
    queue["backfill_mapped_ownership"] = mapped_ownership
    snapshots = {"queue": queue, "required": required, "tiers": tiers, "limits": limits,
                 "objects": rows, "required_paths": required_paths, "ledger": events,
                 "required_members": members or {},
                 "evidence_gaps": gaps, "protected_policy": protected_bytes.decode("utf-8")}
    refs = {key: artifacts.put(ledger.canonical(value)) for key, value in snapshots.items()}
    manifest = {"version": VERSION, "repo": ledger.REPO, "target": target, "tree": repo.tree(target),
                "ledger_head": ledger_head, "evaluated_at": evaluated_at,
                "snapshots": refs, "git_version": repo.git("--version").decode().strip(),
                "blame_options": BLAME_OPTIONS, "construction_version": limits["construction_version"],
                "scoring_version": limits["scoring_version"], "limits_version": limits["version"],
                "tiers_version": tiers["version"]}
    manifest["git_bundle"] = repo.retain(artifacts, [target])
    manifest["raw_queue"] = raw_queue
    manifest["queue_encoding"] = "legacy-number-tag/v1"
    manifest["id"] = ledger.digest(manifest)
    artifacts.put(ledger.canonical(manifest))
    return manifest


def replay(manifest, artifacts):
    if manifest["id"] != ledger.digest({k: v for k, v in manifest.items() if k != "id"}) or manifest["version"] != VERSION:
        raise ledger.IntegrityError("inventory manifest mismatch")
    from pathlib import Path
    artifacts.verify(manifest["git_bundle"])
    artifacts.verify(manifest["raw_queue"])
    inputs = {}
    for key, reference in manifest["snapshots"].items():
        artifacts.verify(reference)
        inputs[key] = ledger.loads(Path(reference["location"]).read_bytes())
    return rank(manifest, inputs)


def _owned(queue):
    owned = collections.defaultdict(set)
    for row in queue.get("backfill_mapped_ownership", []):
        owned[(row["target"], row["path"], row["blob"])].update(ledger.intervals(row["intervals"]))
    for job in queue.get("items", []):
        if (job.get("state") in ("pending", "reviewing", "launch-unknown", "publication-pending")
                or job.get("vendor_state") in ("live", "unknown")):
            for row in job.get("scope", []):
                owned[(job.get("target"), row["path"], row["blob"])].update(ledger.intervals(row["intervals"]))
    return owned


def rank(manifest, inputs):
    if manifest["version"] != VERSION or manifest["blame_options"] != BLAME_OPTIONS:
        raise ledger.IntegrityError("unsupported inventory policy")
    for key, value in inputs.items():
        if ledger.digest(value) != manifest["snapshots"][key]["sha256"]:
            raise ledger.IntegrityError("inventory snapshot digest mismatch")
    limits = effective_limits(inputs["limits"], require_verified=False)
    rows = {r["path"]: dict(r) for r in inputs["objects"]}
    owned = _owned(inputs["queue"])
    target = manifest["target"]
    for name, row in rows.items():
        maximum = row["lines"]
        uncovered = set(range(1, (maximum or 0) + 1)) - ledger.intervals(row["covered"])
        row["uncovered"] = ranges(uncovered)
        row["eligible"] = ranges(uncovered - owned[(target, name, row["blob"])])
        row["score"] = len(uncovered) * (1 + row["churn"] + row["findings"])
    candidates, assigned, progress = [], set(), []
    families = inputs["queue"].get("backfill_families", {})
    jobs = inputs["queue"].get("items", [])
    path_lineages = inputs["queue"].get("backfill_path_lineages", {})

    def partitions(kind, names, prs=(), order=None):
        source = {"repo": manifest["repo"], "kind": kind, "prs": sorted(prs)}
        if kind == "B":
            source["lineage"] = sorted(names)  # Individual path failures are also checked at admission.
        family = ledger.digest(source)
        history = families.get(family, {})
        next_at = history.get("next_eligible_at")
        if history.get("quarantined") or next_at and next_at > manifest["evaluated_at"]:
            return
        current, size = [], 0
        groups = []
        for name in names:
            row = rows[name]
            unit_history = inputs["queue"].get("backfill_scope_failures", {}).get(path_lineages.get(name, name), {})
            if unit_history.get("quarantined") or unit_history.get("next_eligible_at") and unit_history["next_eligible_at"] > manifest["evaluated_at"]:
                continue
            if row["disposition"] not in ("included", "renamed") or not row["eligible"]:
                continue
            if current and (len(current) == limits["files"] or size + row["bytes"] > limits["total"]):
                groups.append(current); current, size = [], 0
            if row["bytes"] > min(limits["per_file"], limits["total"]):
                continue
            current.append(name); size += row["bytes"]
        if current:
            groups.append(current)
        for partition, nameset in enumerate(groups):
            scope = [{"path": n, "blob": rows[n]["blob"], "intervals": rows[n]["eligible"]} for n in nameset]
            identity = {"repo": manifest["repo"], "kind": kind, "prs": sorted(prs), "paths": sorted(nameset),
                        "target": target, "scope_digest": ledger.digest(scope),
                        "construction_policy_digest": manifest["snapshots"]["limits"]["sha256"], "partition": partition}
            subject = ledger.digest(identity)
            previous = [j for j in jobs if j.get("inventory_subject_id", j.get("subject_id")) == subject]
            generation = max((j.get("generation", 0) for j in previous), default=-1) + 1
            retry = bool(history.get("failures") or previous or any(inputs["queue"].get("backfill_scope_failures", {}).get(path_lineages.get(n, n), {}).get("failures") for n in nameset))
            candidates.append({**identity, "subject_id": subject, "family": family, "generation": generation,
                               "retry": retry, "row": order, "tier": min(rows[n]["tier"] for n in nameset),
                               "score": sum(rows[n]["score"] for n in nameset), "scope": scope,
                               "job_id": subject + ":" + str(generation),
                               "path_lineages": {n: path_lineages.get(n, n) for n in nameset},
                               "path_tiers": {n: rows[n]["tier"] for n in nameset},
                               "path_scores": {n: rows[n]["score"] for n in nameset}})

    for group in required_groups(inputs["required"]):
        evidence_rows = [row for pr in group["prs"] for row in inputs["required_paths"].get(str(pr), [])]
        names = sorted({r["path"] for r in evidence_rows if r["path"] in rows}, key=lambda n: (rows[n]["tier"], n.encode()))
        # Missing source evidence is pending, never silently no-current-code.
        missing = [p for p in group["prs"] if str(p) not in inputs["required_paths"]]
        outcomes = []
        for row in evidence_rows:
            name = row["path"]
            if row.get("disposition") == "ambiguous":
                outcomes.append({"path": name, "outcome": "accounted-with-exceptions", "reason": "ambiguous source lineage", "evidence": row.get("source_evidence")})
                continue
            if name in rows:
                current = rows[name]
                outcome = "accounted-with-exceptions" if current["disposition"] in ("unsupported", "ambiguous") else "still-pending" if current["uncovered"] else "no-current-code" if current["disposition"] == "empty" else "covered"
                outcomes.append({"path": name, "outcome": outcome, "evidence": current["evidence"], "reason": current["reason"]})
            elif row.get("disposition") == "deleted" and row.get("deletion_evidence"):
                outcomes.append({"path": name, "outcome": "no-current-code", "evidence": row["deletion_evidence"]})
            else:
                outcomes.append({"path": name, "outcome": "still-pending", "reason": "unverified lineage/deletion"})
        progress.append({**group, "missing_source_evidence": missing, "paths": outcomes})
        available_names = [n for n in names if n not in assigned]
        assigned.update(names)  # Including cooldown/quarantined A scope: B never bypasses it.
        partitions("A", available_names, group["prs"], group["row"])
    clusters = collections.defaultdict(list)
    for name, row in rows.items():
        if name not in assigned and row["eligible"]:
            clusters[(name.rpartition("/")[0], row["tier"])].append(name)
    for key in sorted(clusters):
        names = sorted(clusters[key], key=lambda n: (-rows[n]["score"], n.encode()))
        partitions("B", names)
    candidates.sort(key=lambda c: (c["tier"], c["retry"], c["kind"], c["row"] if c["kind"] == "A" else -c["score"], c["subject_id"].encode()))
    return {"manifest_id": manifest["id"], "target": target, "evaluated_at": manifest["evaluated_at"], "candidates": candidates,
            "paths": [rows[n] for n in sorted(rows, key=lambda n: n.encode())], "required": progress,
            "evidence_gaps": inputs["evidence_gaps"]}
