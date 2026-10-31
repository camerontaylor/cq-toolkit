"""crq integration, publication recovery and deterministic timer entry points.

Importing this module never enables dispatch. An operator-provisioned rollout
record, verified reviewer limits and durable evidence volume are prerequisites.
"""
import collections
import copy
import hashlib
import json
import re
from pathlib import Path
import subprocess

import backfill_accounting as accounting
import backfill_history as history
import backfill_inventory as inventory
import backfill_jobs as jobs
import backfill_report as reporting
import backfill_subjects as subjects
import finding_delivery
import review_ledger as ledger

ROOT = Path(__file__).resolve().parents[2]


def policies():
    return tuple(ledger.loads((ROOT / ("policy/review-" + name + ".json")).read_bytes()) for name in ("tiers", "limits", "required-list"))


def settings(state, *, dispatch=False):
    filename = Path(state) / "backfill-rollout.json"
    if not filename.exists():
        return None
    value = ledger.loads(filename.read_bytes())
    required = ("operational_ruling", "no_live_run_verification", "owner_branch_ruleset_evidence", "durable_artifact_root", "runner_identity", "publisher_spool")
    if any(not value.get(k) for k in required) or value["runner_identity"] != "crq-runner-app":
        raise ledger.IntegrityError("backfill rollout prerequisites incomplete")
    spool = value["publisher_spool"]
    key = (spool.get("ssh_key") or spool.get("key")) if isinstance(spool, dict) else None
    alias = spool.get("ssh_alias") if isinstance(spool, dict) else None
    if (not isinstance(spool, dict) or set(spool) - {"ssh_alias", "ssh_key", "key"}
            or not isinstance(alias, str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.:-]*", alias)
            or not isinstance(key, str) or not key.strip() or any(c in key for c in "\n\r\x00")):
        raise ledger.IntegrityError("backfill rollout publisher_spool incomplete or invalid")
    if dispatch and value.get("enabled") is not True:
        return None
    if dispatch:
        inventory.effective_limits(policies()[1])
    return value


def services(c, config):
    store = ledger.ArtifactStore(config["durable_artifact_root"])
    outbox = ledger.Outbox(c.STATE / "backfill/publication", store)
    repo = accounting.Repository(c.CLONE)
    publisher_spool = c.Spool(config["publisher_spool"])
    publisher = ledger.GitLedger(c.CLONE, push_commit=publisher_spool.publish_ledger)
    return repo, store, outbox, publisher


def state_event(c, queue, item, at, reason, operator=None, state=None):
    config = settings(c.STATE)
    if not config or item.get("kind") != jobs.KIND:
        return
    _, _, outbox, _ = services(c, config)
    payload = {"family": item["family"], "subject_id": item["subject_id"], "job_id": item["job_id"],
               "generation": item["generation"], "attempt": item.get("attempt", 0), "state": state or item["state"],
               "failures": item.get("family_failures", 0), "next_eligible_at": item.get("not_before"), "reason": reason}
    if operator:
        payload["operator"] = operator
    key = "job:" + item["job_id"] + ":" + ledger.digest(payload)
    saved = queue.setdefault("backfill_state_events", {}).get(key)
    if saved:
        return
    existing = next((v for v in outbox.retained() if v["source_key"] == key), None)
    value = existing or ledger.event("job-state", key, at, payload)
    outbox.spool(value)
    queue["backfill_state_events"][key] = value["id"]


def usage_context(c, queue, usage, reserved):
    """Bind a fresh usage read to existing local holds before selection."""
    # Vendor progress proves run ownership, not that the usage counter includes
    # a particular reservation. Only explicit observation evidence can do that.
    reflected = (usage or {}).get("reflected_reservations", [])
    if usage is not None:
        import datetime as dt
        window = dt.timedelta(milliseconds=usage.get("rollingWindowMs") or 3600000)
        observed = ledger.timestamp(c.iso())
        for hold in queue.get("backfill_reservations", {}).values():
            if hold.get("terminal_at") and observed >= ledger.timestamp(hold["terminal_at"]) + window:
                hold["quota_state"] = "expired"
    # Legacy/non-backfill reservations share the effective quota arithmetic.
    represented = sum(1 for i in queue.get("items", []) if i.get("attempt_id") in queue.get("backfill_reservations", {})
                      and (i.get("run") or {}).get("started_at") in reserved)
    remaining = usage["remaining"] - max(0, len(reserved) - represented) if usage else 0
    queue["backfill_usage"] = {"successful": usage is not None, "remaining": max(0, remaining),
                               "observed_at": c.iso(), "reflected_reservations": reflected}


def rank4_gate(c, queue, item, dry=False):
    observation = copy.deepcopy(queue.get("backfill_usage"))
    if observation:
        # Within one observation, ordinary admissions also spend quota. Holds
        # already represented by backfill_reservations are subtracted by jobs.
        ordinary = len(queue.get("starts", [])) - queue.get("backfill_starts_at_observation", len(queue.get("starts", [])))
        ordinary -= sum(h.get("at") >= observation["observed_at"] for h in queue.get("backfill_reservations", {}).values())
        observation["remaining"] = max(0, observation["remaining"] - max(0, ordinary))
    decision = jobs.admission(queue, item, c.iso(), observation, c.ordinary_review_eligible(queue), reserve=not dry)
    if decision["decision"] != "admit":
        item["wait_reason"] = decision["decision"]
        return False
    if not dry:
        state_event(c, queue, item, c.iso(), "atomic quota reservation before launch")
        day = queue.setdefault("backfill_daily_capacity", {}).setdefault(c.iso()[:10], {"spare_admissions": 0, "completed_partitions": 0})
        day["spare_admissions"] += 1
        c.save_queue(queue)
    return True


def select(c, queue, log, dry, only):
    if (queue.get("backfill_halted") or queue.get("backfill_publication_error")
            or (c.STATE / "backfill/publication-failure.json").exists()):
        return None, False
    config = settings(c.STATE, dispatch=True)
    if not config:
        return None, False
    # A rollout owns the rank-4 lane; the path-count-only fallback cannot launch
    # outside the ledger accounting once the new mechanism is enabled.
    items = [j for j in queue["items"] if j.get("kind") == jobs.KIND and (not only or only == j["id"])]
    items.sort(key=lambda j: (j["tier_importance"], j.get("retry", False), j["subject_kind"],
                             j.get("row") or 0 if j["subject_kind"] == "A" else -j["score"], j["subject_id"]))
    repo, store, outbox, publisher = services(c, config)
    # New publication may remove eligibility without moving the job's T.
    head, events = publisher.fetch()
    coverage_by_target = {}
    def coverage_for(target):
        if target not in coverage_by_target:
            coverage_by_target[target] = repo.coverage(target, events, store)
        return coverage_by_target[target]
    for item in items:
        covered, _, _ = coverage_for(item["target"])
        remaining = [r for r in item["scope"] if ledger.intervals(r["intervals"]) - covered.get(r["path"], set())]
        item["dispatch_tier_importance"] = min((item.get("path_tiers", {}).get(r["path"], item["tier_importance"]) for r in remaining), default=item["tier_importance"])
    items.sort(key=lambda j: (j["dispatch_tier_importance"], j.get("retry", False), j["subject_kind"],
                             j.get("row") or 0 if j["subject_kind"] == "A" else -j["score"], j["subject_id"]))
    available = False
    for item in items:
        if not jobs.eligible(queue, item, c.iso()):
            continue
        covered, _, gaps = coverage_for(item["target"])
        if gaps:
            item["wait_reason"] = "missing retained evidence; reconcile before dispatch"
            continue
        desired = ledger.scope(item["scope"])
        if all(lines <= covered.get(name, set()) for (name, _), lines in desired.items()):
            item.update(state="done", coverage_satisfied_by=head)
            continue
        available = True
        if not rank4_gate(c, queue, item, dry):
            continue
        if dry:
            log.append("DRY-RUN would admit " + item["id"])
            return None, True
        plan = {"base": item["base"], "head": item["head"], "target": item["target"], "cycle": None,
                "branch": None, "notes": [], "label": "pinned scoped backfill", "range_policy": "backfill-current-scoped-v1"}
        run_bound = False
        try:
            run_id = c.launch(queue, item, plan)
            if item.get("state") == "reviewing":
                jobs.bind_run(queue, item, run_id)
                run_bound = True
                state_event(c, queue, item, c.iso(), "vendor identity bound")
                c.save_queue(queue)
                return run_id, True
            if not item.get("run"):
                jobs.cancel_before_vendor(queue, item)
            jobs.terminal(queue, item, c.iso(), "secret-scan", vendor_terminal=not bool(item.get("run")), reason=item.get("last_error", "launch refused"))
        except Exception:
            if not run_bound:
                item.update(state="launch-unknown", vendor_state="unknown")
            c.save_queue(queue)
            raise
    return None, available


def completion_event(repo, store, item, raw, exit_code, meta, ended_at, submission=None):
    """Retain raw terminal bytes before local completion; explicit scope required."""
    raw_ref = store.put(raw)
    meta_ref = store.put(ledger.canonical(meta))
    git_ref = repo.retain(store, [item["base"], item["head"], item["target"]])
    if submission is None:
        terminal_rows = history.terminal_scope(raw, item["head"])
        submission_refs = []
    else:
        terminal_rows = history.adapted_terminal_scope(repo, raw, item, meta, submission)
        submission_refs = [store.put(ledger.canonical(submission))]
    terminal_scope = ledger.scope(terminal_rows)
    requested_scope = ledger.scope(item["scope"])
    reviewed = [{"path": name, "blob": blob, "intervals": accounting.ranges(lines & terminal_scope.get((name, blob), set()))}
                for (name, blob), lines in requested_scope.items() if lines & terminal_scope.get((name, blob), set())]
    findings = []
    entries = repo.entries(item["target"])
    for value in history.vendor_events(raw):
        if value.get("type") != "finding":
            continue
        name = value.get("fileName") or value.get("path")
        try:
            ledger.path(name)
        except (ValueError, TypeError):
            name = None
        if name not in entries:
            # Retained raw bytes remain the human-triage authority for findings
            # whose vendor anchor is absent or outside the pinned repository.
            intervals = []
        else:
            intervals = value.get("intervals", [])
        normalized = {"source_id": str(value["id"]) if value.get("id") is not None else None, "severity": value.get("severity", "info"), "path": name,
                      "blob": entries.get(name, {}).get("blob"), "intervals": intervals,
                      "title": value.get("title") or "Unverified vendor finding anchor",
                      "body": value.get("comment") or value.get("body") or json.dumps(value)}
        findings.append(finding_delivery.normalize("crq-runner-app", meta["run_id"], normalized))
    payload = {"repo": ledger.REPO, "subject_id": item["subject_id"], "job_id": item["job_id"], "attempt_id": item["attempt_id"],
               "source": {"repo": ledger.REPO, "producer": "crq-runner-app", "type": "crq-run", "id": meta["run_id"], "authenticated": True},
               "base": item["base"], "head": item["head"], "head_tree": item["head_tree"], "target": item["target"], "target_tree": item["target_tree"],
               "policy_digest": item["construction_policy_digest"], "scope_digest": item["scope_digest"], "paths": item["paths"],
               "requested_scope": item["scope"], "input_scope": terminal_rows, "reviewed_scope": reviewed,
               "completion": {"terminal": True, "skipped": False, "scope_verified": True, "exit_code": exit_code, "errors": []},
               "outcome": "completed", "artifacts": [raw_ref, meta_ref, git_ref, *submission_refs], "findings": findings}
    value = ledger.event("review", f"{ledger.REPO}:crq-runner-app:{meta['run_id']}", ended_at, payload)
    repo.verify_review(value)
    return value


def harvest(c, queue, item, rdir, meta, classification, exit_code, *, terminal_verified=False):
    config = settings(c.STATE)
    if not config:
        raise ledger.IntegrityError("cannot harvest backfill without durable rollout configuration")
    repo, store, outbox, publisher = services(c, config)
    terminal = ledger.loads((rdir / "exit.json").read_bytes())
    ended_at = terminal["ended_at"]
    # Re-harvest uses the immutable run timestamp and source key, not wall time.
    raw = (rdir / "review.ndjson").read_bytes()
    store.put(raw); exit_ref = store.put((rdir / "exit.json").read_bytes())
    if classification["counted"]:
        try:
            submission_file = rdir / "submission.json"
            submission = ledger.loads(submission_file.read_bytes()) if submission_file.exists() else None
            value = completion_event(repo, store, item, raw, exit_code, meta, ended_at, submission)
        except (ValueError, KeyError) as exc:
            jobs.terminal(queue, item, ended_at, "unsupported", vendor_terminal=True, reason="unverified scope: " + str(exc))
            state_event(c, queue, item, ended_at, "terminal scope unverified")
            c.save_queue(queue)
            if meta.get("worktree") and meta.get("wt_branch"):
                c.remove_worktree(Path(meta["worktree"]), meta["wt_branch"])
            return "backfill terminal unverified scope; quarantine and retain evidence"
        value["payload"]["artifacts"].append(exit_ref)
        value["id"] = ledger.digest({k: v for k, v in value.items() if k != "id"})
        ledger.atomic(rdir / "review-event.json", ledger.canonical(value))
        outbox.spool(value)
        item["publication_event_id"] = value["id"]
        jobs.terminal(queue, item, ended_at, "completed", vendor_terminal=True)
        finding_delivery.Inbox(c.STATE / "backfill/findings", outbox).ingest(value)
    else:
        outcome = classification["outcome"]
        causes = (classification.get("failure_provenance") or {}).get("causes") or []
        run = item.get("run") or {}
        hold = queue.get("backfill_reservations", {}).get(item.get("attempt_id")) or {}
        known_terminal = (terminal_verified is True and terminal.get("exit") == exit_code
                          and run.get("run_id") == meta.get("run_id")
                          and hold.get("item") == item.get("id")
                          and hold.get("vendor_run_id") == meta.get("run_id"))
        if (any(cause.get("category") == "vendor-rate-limited" for cause in causes)
                and any(cause.get("source") != "vendor" for cause in causes)):
            if outcome in ("auth", "action_required"):
                queue.update(paused=True, pause_reason="backfill vendor authentication/action required; operator ruling needed")
                c.save_queue(queue)
            if not known_terminal:
                return "backfill mixed quota and hard causes; retain run ownership"
            outcome = "auth" if outcome in ("auth", "action_required") else "integrity"
        if outcome == "rate_limited" and known_terminal:
            verified = c.classify(rdir / "review.ndjson", exit_code)
            provenance = verified.get("failure_provenance") or {}
            causes = provenance.get("causes") or []
            if (verified.get("outcome") != "rate_limited" or provenance.get("complete") is not True
                    or not causes or any(cause.get("source") != "vendor" or cause.get("category") != "vendor-rate-limited" for cause in causes)):
                outcome = "integrity"
        if outcome == "rate_limited":
            # Reclassify retained bytes and require exact bound terminal ownership;
            # an outcome label alone is not evidence for the Q49 exception.
            verified = c.classify(rdir / "review.ndjson", exit_code)
            provenance = verified.get("failure_provenance") or {}
            causes = provenance.get("causes") or []
            run = item.get("run") or {}
            hold = queue.get("backfill_reservations", {}).get(item.get("attempt_id")) or {}
            if (terminal_verified is not True
                    or verified.get("outcome") != "rate_limited" or provenance.get("complete") is not True
                    or not causes or any(cause.get("source") != "vendor" or cause.get("category") != "vendor-rate-limited" for cause in causes)
                    or item.get("vendor_state") != "live" or run.get("run_id") != meta.get("run_id")
                    or hold.get("item") != item.get("id") or hold.get("vendor_run_id") != meta.get("run_id")
                    or terminal.get("exit") != exit_code):
                return "backfill quota refusal unverified; retain run ownership"
            wait = verified.get("wait_seconds")
            if type(wait) is not int or wait <= 0:
                fallback = queue.get("rl_backoff_min") or c.CONFIG.get("rate_limit_default_backoff_min")
                if type(fallback) is not int or fallback <= 0:
                    return "backfill quota refusal lacks usable cooldown; retain run ownership"
                wait = fallback * 60
            c.set_rate_cooldown(queue, {**verified, "wait_seconds": wait}, rdir)
            jobs.defer_terminal_quota(queue, item, ended_at, wait)
        elif outcome in ("auth", "action_required"):
            queue.update(paused=True, pause_reason="backfill vendor authentication/action required; operator ruling needed")
            outcome = "auth"
        if outcome != "rate_limited":
            jobs.terminal(queue, item, ended_at, outcome, vendor_terminal=True,
                          retry_after=classification.get("wait_seconds") or 0, reason=classification.get("message") or outcome)
    state_event(c, queue, item, ended_at, classification["outcome"])
    counted_runs = queue.setdefault("backfill_capacity_runs", [])
    if meta["run_id"] not in counted_runs:
        counted_runs.append(meta["run_id"])
        day = queue.setdefault("backfill_daily_capacity", {}).setdefault(ended_at[:10], {"spare_admissions": 0, "completed_partitions": 0})
        day["completed_partitions"] += item["state"] == "publication-pending"
    c.save_queue(queue)
    if meta.get("worktree") and meta.get("wt_branch"):
        c.remove_worktree(Path(meta["worktree"]), meta["wt_branch"])
    return "backfill " + item["state"]


def clear_operation_halt(queue, operation):
    if queue.get("backfill_halt_operation") == operation:
        queue.pop("backfill_halted", None)
        queue.pop("backfill_halt_operation", None)


def publish(c, queue):
    """Queue a durable background request; safe under tick.lock, no Git/network."""
    if settings(c.STATE):
        import uuid
        ledger.atomic(c.STATE / "backfill/publish-request.json",
                      ledger.canonical({"request": uuid.uuid4().hex}))
        clear_operation_halt(queue, "publication-request")


def reconcile_publication(c, queue, head, ids):
    """Called with the freshly loaded queue under tick.lock after remote validation."""
    for item in queue["items"]:
        ident = item.get("publication_event_id")
        if (item.get("kind") == jobs.KIND and item.get("state") == "publication-pending"
                and not jobs.is_execution_owner(item) and ident in ids):
            value = ids[ident]
            if value["event_type"] != "review":
                raise ledger.IntegrityError("publication acknowledgement is not a review")
            jobs.published(queue, item, value["payload"]["reviewed_scope"], ident)
            state_event(c, queue, item, value["occurred_at"], "remote publication acknowledged")
    queue["review_ledger_head"] = head
    queue.pop("backfill_publication_error", None)
    clear_operation_halt(queue, "publication")
    c.save_queue(queue)


def collect_required(repo, target, required, store):
    """Read-only forge acquisition; captured bytes precede deterministic ranking."""
    paths, members = {}, {}
    for row in required["rows"]:
        pr = row["pr"]
        raw = subprocess.run(["gh", "api", f"repos/{ledger.REPO}/pulls/{pr}"], capture_output=True, check=True, timeout=60).stdout
        reference = store.put(raw); value = ledger.loads(raw)
        if value.get("number") != pr or not value.get("merged"):
            raise ledger.IntegrityError("required PR identity/merge mismatch")
        merge = repo.resolve(value["merge_commit_sha"])
        parent = repo.git("rev-parse", merge + "^1").decode().strip()
        names = repo.git("diff", "--name-only", "--no-renames", "-z", parent, merge).split(b"\0")
        source_paths, member_paths = [], []
        for raw_name in names:
            if not raw_name:
                continue
            name = raw_name.decode("utf-8")
            mapped = repo.lineage(merge, target, name)
            if mapped:
                source_paths.append({"path": mapped, "source_path": name, "source_evidence": reference})
                member_paths.append({"path": mapped, "source_path": name, "lineage_verified": True})
            elif repo.proven_deleted(merge, target, name) or (
                    name not in repo.entries(merge) and repo.proven_deleted(parent, target, name)):
                source_paths.append({"path": name, "disposition": "deleted", "deletion_evidence": {"target": target, "merge": merge, "source": reference}})
            else:
                source_paths.append({"path": name, "disposition": "ambiguous", "source_evidence": reference})
        paths[str(pr)] = source_paths
        members[str(pr)] = {"merge": merge, "paths": member_paths,
                            "pr": pr,
                            "context": {"trust": "untrusted-data-only", "title": value.get("title", ""), "body": value.get("body") or ""}}
    return paths, members


def run_inventory(c, queue, *, required_paths=None, members=None, fetch=True, enqueue=True, prepare_only=False):
    config = settings(c.STATE)
    if not config:
        raise ledger.IntegrityError("operator rollout configuration required for inventory publication")
    repo, store, outbox, publisher = services(c, config)
    repo.immutable_cache = {}  # This invocation only; keys contain immutable object IDs.
    event_items = []
    tiers, limits, required = policies()
    if fetch:
        repo.git("fetch", "--no-tags", "--no-write-fetch-head", "origin", "refs/heads/main:refs/remotes/origin/main")
    target = repo.git("rev-parse", "origin/main^{commit}").decode().strip()
    ledger_head, events = publisher.fetch()
    if required_paths is None:
        required_paths, members = collect_required(repo, target, required, store)
    manifest = inventory.capture(repo, target, ledger_head, events, store, queue, required, tiers, limits, c.iso(),
                                 required_paths, (ROOT / "policy/protected-paths.json").read_bytes(), members)
    ranked = inventory.replay(manifest, store)
    retained_queue = ledger.loads(Path(manifest["snapshots"]["queue"]["location"]).read_bytes())
    queue["backfill_scope_failures"] = retained_queue.get("backfill_scope_failures", {})
    debt = []
    if enqueue:
        inventory.effective_limits(limits)  # Unknown deployed limits never enqueue live work.
        for candidate in ranked["candidates"]:
            construction = subjects.construct(repo, candidate, limits, [members[str(p)] for p in candidate["prs"] if str(p) in (members or {})])
            for partition in construction["partitions"]:
                partition.update(tier_importance=partition["tier"], subject_kind=partition["kind"])
                item = jobs.enqueue(queue, partition, c.iso())
                event_items.append(item["id"])
                if not prepare_only:
                    state_event(c, queue, item, item["created_at"], "inventory enqueue")
            debt.extend(construction["debt"])
    queue["backfill_last_manifest"] = manifest
    queue["backfill_unsupported_construction"] = debt
    statuses = collections.Counter()
    for filename in sorted((c.STATE / "backfill/findings/triage").glob("*.json")):
        statuses[ledger.loads(filename.read_bytes())["status"]] += 1
    queue["backfill_finding_backlog"] = dict(sorted(statuses.items()))
    baseline_file = c.STATE / "backfill/baseline.json"
    original = ledger.loads(baseline_file.read_bytes()) if baseline_file.exists() else None
    report = reporting.summary(repo, ranked, queue, original)
    report["construction_debt"] = debt
    if prepare_only:
        return {"queue": queue, "manifest": manifest, "ranked": ranked, "report": report, "event_items": event_items}
    ledger.atomic(c.STATE / "backfill/latest-ranked.json", ledger.canonical(ranked))
    ledger.atomic(c.STATE / "backfill/latest-report.json", ledger.canonical(report))
    clear_operation_halt(queue, "inventory")
    c.save_queue(queue)
    return manifest, ranked, report
