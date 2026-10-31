#!/usr/bin/env python3
"""Deterministic inventory/operator CLI. Never launches a vendor review."""
import argparse
import copy
import hashlib
import json
from pathlib import Path

import backfill_jobs as jobs
import coverage as coverage_policy
import backfill_report as reporting
import backfill_runtime as runtime
import finding_delivery
import review_ledger as ledger


def queue_digest_v1(queue):
    """Bind evidence to the complete queue using the release JSON encoding."""
    raw = json.dumps(queue, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def execute(c, args):
    queue = c.load_queue()
    config = runtime.settings(c.STATE)
    if args.command == "release":
        evidence = ledger.loads(Path(args.evidence).read_bytes())
        item = next(i for i in queue["items"] if i["id"] == args.item)
        if evidence.get("item") != item["id"] or evidence.get("vendor_state") != "terminal" or not evidence.get("exact_no_live_run"):
            raise ledger.IntegrityError("evidence must bind this item and exact no-live-run verification")
        if evidence.get("queue_digest") != queue_digest_v1(queue):
            raise ledger.IntegrityError("no-live-run evidence must bind the current queue snapshot")
        checked = ledger.timestamp(evidence.get("checked_at"))
        age = (ledger.timestamp(c.iso()) - checked).total_seconds()
        if age < 0 or age > 60:
            raise ledger.IntegrityError("no-live-run verification must be at most 60 seconds old")
        # Existing run records must be independently reconciled by crq before
        # this command; a text assertion cannot override a live/unknown owner.
        jobs.release(queue, item, c.iso(), args.operator, args.reason, evidence)
        c.save_queue(queue)
        return {"released": item["id"], "operational_ruling": args.reason}
    if not config:
        raise ledger.IntegrityError("owner-provisioned rollout configuration is absent")
    repo, store, outbox, publisher = runtime.services(c, config)
    if args.command == "inventory":
        return runtime.run_inventory(c, queue, enqueue=not args.report_only)[2]
    if args.command == "publish":
        runtime.publish(c, queue)
        return {"ledger_head": queue.get("review_ledger_head")}
    if args.command == "baseline":
        filename = c.STATE / "backfill/baseline.json"
        if filename.exists():
            raise ledger.IntegrityError("baseline already pinned; never overwrite T0")
        ranked = ledger.loads((c.STATE / "backfill/latest-ranked.json").read_bytes())
        manifest = queue["backfill_last_manifest"]
        value = reporting.baseline(repo, ranked, manifest["snapshots"]["tiers"]["sha256"], manifest["ledger_head"], c.iso())
        ledger.atomic(filename, ledger.canonical(value))
        store.put(ledger.canonical(value))
        return value
    if args.command == "quarantine-release":
        if args.family.startswith("legacy-coverage:"):
            if not getattr(args, "evidence", None):
                raise ledger.IntegrityError("legacy release requires scoped no-live evidence")
            evidence = ledger.loads(Path(args.evidence).read_bytes())
            if (evidence.get("family") != args.family or evidence.get("queue_digest") != queue_digest_v1(queue)
                    or evidence.get("exact_no_live_run") is not True):
                raise ledger.IntegrityError("legacy evidence must bind this family and current queue")
            age = (ledger.timestamp(c.iso()) - ledger.timestamp(evidence.get("checked_at"))).total_seconds()
            if age < 0 or age > 60:
                raise ledger.IntegrityError("legacy no-live verification must be at most 60 seconds old")
            parts = args.family.split(":", 2)
            try:
                pr = int(parts[1])
                if pr <= 0 or str(pr) != parts[1] or len(parts) != 3:
                    raise ValueError("invalid legacy family")
                restored = coverage_policy.restore_legacy_quota_deadlines(queue, pr, parts[2], c.iso(), args.operator, args.reason, evidence)
                view = coverage_policy.legacy_retry_view(queue, pr, parts[2], c.iso())
                if not restored or view["reasons"]:
                    coverage_policy.release_legacy_quarantine(queue, pr, parts[2], c.iso(), args.operator, args.reason, evidence)
            except (ValueError, IndexError) as exc:
                raise ledger.IntegrityError(str(exc)) from exc
        else:
            jobs.release_quarantine(queue, args.family, c.iso(), args.operator, args.reason)
        for item in queue["items"]:
            if item.get("family") == args.family:
                runtime.state_event(c, queue, item, c.iso(), args.reason, args.operator, "quarantine-released")
        c.save_queue(queue)
        return {"family": args.family, "released": True}
    if args.command == "reconcile-no-launch":
        evidence = ledger.loads(Path(args.evidence).read_bytes())
        store.verify(evidence["vendor_query"])
        item = next(i for i in queue["items"] if i["id"] == args.item)
        jobs.reconcile_absent(queue, item, c.iso(), args.operator, args.reason, evidence)
        runtime.state_event(c, queue, item, c.iso(), args.reason, args.operator)
        c.save_queue(queue)
        return {"item": args.item, "reconciled": True}
    if args.command == "import-history":
        from backfill_history import import_catalog
        head, existing = publisher.fetch()
        catalog_doc = ledger.loads(Path(args.catalog).read_bytes())
        catalog = []
        for row in catalog_doc["sources"] if isinstance(catalog_doc, dict) else catalog_doc:
            store.verify(row["raw_artifact"])
            catalog.append({"class": row["class"], "id": row["id"], "raw": Path(row["raw_artifact"]["location"]).read_bytes(), "envelope": row["envelope"]})
        # Include unpublished and acknowledged local records so retries retain
        # the original source disposition even before the next publication.
        events, report = import_catalog(repo, store, catalog, c.iso(), existing + outbox.retained())
        for value in events:
            outbox.spool(value)
        return {"previous_ledger_head": head, "imports": report, "publication_pending": len(events)}
    if args.command == "collect-history":
        from backfill_history import collect_sources, github_sources
        value = collect_sources(queue, c.STATE, store, github=(lambda: github_sources(store)) if args.github else None)
        ledger.atomic(args.output, ledger.canonical(value))
        return {"catalog": args.output, "sources": len(value["sources"]), "acquisition": value["acquisition"]}
    inbox = finding_delivery.Inbox(c.STATE / "backfill/findings", outbox)
    if args.command == "triage":
        repo.git("fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main")
        tip = repo.git("rev-parse", "origin/main^{commit}").decode().strip()
        return inbox.triage(args.finding, repo, tip, args.action, args.operator, args.reason, c.iso(),
                            fixing_commit=args.fixing_commit, canonical_id=args.canonical_id)
    if args.command == "deliver":
        def scan(target, name):
            base, head = runtime.subjects.projection(repo, target, [name])
            return c.secret_scan(base, head, c.STATE / "backfill/repair-scan.json")[0]
        transport = finding_delivery.repair_transport(c.ROOT, queue, c.save_queue, scan)
        return inbox.deliver(args.finding, transport, c.iso())
    raise ledger.IntegrityError("unknown command")


def inventory_guard(queue):
    # Scope owners, generation and failure lineage affect planning. Ordinary
    # review diagnostics and harvests without scoped ownership do not.
    fields = ("id", "kind", "target", "scope", "scope_digest", "path_lineages", "state",
              "vendor_state", "run", "job_id", "inventory_subject_id", "subject_id", "generation")
    guarded = {k: queue.get(k) for k in ("backfill_families", "backfill_scope_failures",
               "backfill_path_lineages", "backfill_last_manifest", "legacy_coverage_releases")}
    guarded["items"] = [{k: item[k] for k in fields if k in item}
                        for item in queue.get("items", [])
                        if item.get("scope") or item.get("subject_id") or item.get("kind") == "backfill"]
    return guarded


def inventory_unlocked(c, args):
    def snapshot():
        return copy.deepcopy(c.load_queue()), runtime.settings(c.STATE)
    original, config = c.with_lock(snapshot, lock_wait=30)
    prepared = runtime.run_inventory(c, copy.deepcopy(original), enqueue=not args.report_only, prepare_only=True)

    def merge():
        current = c.load_queue()
        if inventory_guard(current) != inventory_guard(original) or runtime.settings(c.STATE) != config:
            raise ledger.IntegrityError("inventory snapshot stale; retry inventory")
        # Apply only inventory's delta to the freshly loaded queue. Never save
        # the snapshot over scheduler changes made during slow Git/provider I/O.
        for key, value in prepared["queue"].items():
            if key == "items":
                old_ids = {i["id"] for i in original.get("items", [])}
                current_ids = {i["id"] for i in current.get("items", [])}
                additions = [i for i in value if i["id"] not in old_ids]
                if any(i["id"] in current_ids for i in additions):
                    raise ledger.IntegrityError("inventory job identity collision; retry inventory")
                current.setdefault("items", []).extend(additions)
            elif key not in original or value != original[key]:
                current[key] = value
        for ident in prepared["event_items"]:
            item = next(i for i in current["items"] if i["id"] == ident)
            runtime.state_event(c, current, item, item["created_at"], "inventory enqueue")
        ledger.atomic(c.STATE / "backfill/latest-ranked.json", ledger.canonical(prepared["ranked"]))
        ledger.atomic(c.STATE / "backfill/latest-report.json", ledger.canonical(prepared["report"]))
        c.save_queue(current)
        return prepared["report"]
    return c.with_lock(merge, lock_wait=30)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("inventory"); p.add_argument("--report-only", action="store_true")
    sub.add_parser("publish"); sub.add_parser("baseline")
    p = sub.add_parser("import-history"); p.add_argument("catalog")
    p = sub.add_parser("collect-history"); p.add_argument("output"); p.add_argument("--github", action="store_true")
    p = sub.add_parser("release"); p.add_argument("item"); p.add_argument("--evidence", required=True)
    p.add_argument("--operator", required=True); p.add_argument("--reason", required=True)
    p = sub.add_parser("quarantine-release"); p.add_argument("family"); p.add_argument("--evidence")
    p.add_argument("--operator", required=True); p.add_argument("--reason", required=True)
    p = sub.add_parser("reconcile-no-launch"); p.add_argument("item"); p.add_argument("--evidence", required=True)
    p.add_argument("--operator", required=True); p.add_argument("--reason", required=True)
    p = sub.add_parser("triage"); p.add_argument("finding")
    p.add_argument("action", choices=["confirmed", "already-fixed", "superseded", "dismissed", "needs-human", "duplicate", "fixed"])
    p.add_argument("--operator", required=True); p.add_argument("--reason", required=True)
    p.add_argument("--fixing-commit"); p.add_argument("--canonical-id")
    p = sub.add_parser("deliver"); p.add_argument("finding")
    args = parser.parse_args()
    import crq
    try:
        result = (inventory_unlocked(crq, args) if args.command == "inventory"
                  else crq.with_lock(execute, crq, args, lock_wait=30))
        print(json.dumps(result, sort_keys=True))
    except (ValueError, OSError, KeyError) as exc:
        print(json.dumps({"error": str(exc)}))
        raise SystemExit(3)


if __name__ == "__main__":
    main()
