"""Pinned local-review execution and reconciliation; caller owns tick.lock.

Exact reuse is receipt-based. Ledger line-scope credit is deliberately separate:
the full-range CLI adapter cannot prove per-line coverage.
"""
import copy
import datetime as dt
import hashlib
import json
import subprocess
from pathlib import Path

import repo_registry
import review_admission as admission
import review_operation as operation
import review_receipt as receipts
import review_transport as transport
import review_ledger as ledger
from queue_transport import _ReceiptSnapshot
from author_quota import AuthorRefused

KIND = operation.KIND


def facts(c, base, head, profile, repo=None):
    repo = repo or c.REPO
    kwargs = {} if repo_registry.same_repo(repo, c.REPO) else dict(cwd=transport.clone_for(c, repo))
    inputs = dict(repo=repo, target="main", base_commit=base, head_commit=head,
                  base_tree=c.git("rev-parse", base + "^{tree}", **kwargs),
                  head_tree=c.git("rev-parse", head + "^{tree}", **kwargs), projection="full-diff")
    return transport.resolve(c, inputs, profile)


def retained(c, item):
    if not admission.adequate(item):
        return None
    try:
        doc = _ReceiptSnapshot(c.STATE / "receipts", item["receipt_id"]).document
        operation.validate("receipt", doc)
    except (OSError, ValueError, KeyError):
        return None
    if (doc["identity"] != item["identity"] or doc["identity_inputs"] != item["identity_inputs"]
            or not doc["scope_adequate"] or doc["outcome"] not in ("clean", "findings")):
        return None
    return doc


def cycle_facts(c, item, record):
    profile = record.get("profile")
    if not profile or record.get("range_policy") != "full-range-once-v1":
        return None
    return facts(c, record["base"], record["head"], profile, item.get("repo", c.REPO))


def reconcile_pr(c, q, item, plan, dry):
    stored = transport.profile(c.CONFIG, plan["base"])
    wanted = facts(c, plan["base"], plan["head"], stored, item.get("repo", c.REPO))
    plan.update(profile=stored, config_digest=wanted["config_digest"])
    for local in q["items"]:
        if local.get("kind") != KIND or not operation.equivalent(local.get("identity_inputs"), wanted):
            continue
        doc = retained(c, local)
        if doc:
            if not dry:
                record = dict(base=plan["base"], head=plan["head"], pr_head=plan["head"],
                              range_policy="full-range-once-v1", dirty_diff="clean tree",
                              run_id=doc["run_id"], ndjson=str(c.RUNS / doc["run_id"] / "review.ndjson"),
                              config_digest=doc["identity_inputs"]["config_digest"],
                              profile=doc["profile"], receipt_id=local["receipt_id"],
                              source=KIND, completed_at=local["completed_at"], cycle=plan.get("cycle"),
                              findings=len(doc["findings"]),
                              severity_counts=doc["observed"].get("classification", {}).get("severity_counts", {}))
                if not any(r.get("receipt_id") == local["receipt_id"] for r in item.get("cycles", [])):
                    item.setdefault("cycles", []).append(record)
            raise c.NothingToReview("equivalent local full-diff receipt already reviewed")
        if local["state"] in admission.ACTIVE:
            raise c.NotReady("equivalent-local-review")
    return plan


def prepare(c, q, item, dry, *, completed_only=False):
    wanted = item["identity_inputs"]
    if not repo_registry.same_repo(wanted["repo"], c.REPO):
        clone = transport.clone_for(c, wanted["repo"])
        if not all(c.object_present(wanted[end + "_commit"], clone=clone) for end in ("base", "head")):
            c.fetch(clone=clone)
    # Re-resolve pinned objects/config but never today's profile flags.
    if facts(c, wanted["base_commit"], wanted["head_commit"], item["profile"], wanted["repo"]) != wanted:
        raise c.NotReady("pinned-local-review-facts-mismatch")
    for pr in q["items"]:
        if pr.get("kind") not in ("open", "delta") or pr.get("repo", c.REPO) != wanted["repo"]:
            continue
        for record in reversed(pr.get("cycles", [])):
            if item.get("repeat_requested", item["generation"] > 1):
                continue  # an explicit repeat requires a fresh invocation, even at generation 1
            if record.get("base") != wanted["base_commit"] or record.get("head") != wanted["head_commit"]:
                continue
            if operation.equivalent(cycle_facts(c, pr, record), wanted):
                if not dry:
                    rdir = c.RUNS / record["run_id"]
                    cls = c.classify(Path(record["ndjson"]), 0)
                    if not cls.get("counted") or cls.get("outcome") != "completed":
                        continue
                    complete(c, q, item, rdir, record["run_id"], cls,
                             record.get("completed_at") or c.iso(), 0)
                return None
        run = None if completed_only else pr.get("run")
        if run:
            meta = json.loads((c.RUNS / run["run_id"] / "meta.json").read_text())
            if (meta.get("base") == wanted["base_commit"] and meta.get("head") == wanted["head_commit"]
                    and operation.equivalent(cycle_facts(c, pr, meta), wanted)):
                raise c.NotReady("equivalent-pr-review")
    return dict(base=wanted["base_commit"], head=wanted["head_commit"],
                target=wanted["base_commit"], label="local full-diff review",
                cycle=item["generation"], branch=None, notes=[],
                review_pin=wanted["base_commit"], range_policy="full-range-once-v1",
                profile=item["profile"], config_digest=wanted["config_digest"])


def reconcile_completed(c, q):
    """Receipt-only completion spends no quota, even during pause or cooldown."""
    for item in list(q["items"]):
        if item.get("kind") != KIND or item.get("state") != "pending":
            continue
        at = dt.datetime.fromisoformat(c.iso().replace("Z", "+00:00"))
        try:
            if item.get("not_before") and dt.datetime.fromisoformat(item["not_before"].replace("Z", "+00:00")) > at:
                continue
            prepare(c, q, item, False, completed_only=True)
            item.pop("reconcile_failures", None)
            item.pop("not_before", None)
            if (item.get("wait_reason") or "").startswith("completed-evidence-unavailable:"):
                item["wait_reason"] = None
        except (OSError, RuntimeError, subprocess.SubprocessError, ValueError, KeyError, c.NotReady, AuthorRefused) as exc:
            failures = item.get("reconcile_failures", 0) + 1
            minutes = min(240, c.CONFIG.get("error_backoff_min", 5) * 2 ** min(failures - 1, 8))
            item["reconcile_failures"] = failures
            item["not_before"] = (at + dt.timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
            item["wait_reason"] = f"completed-evidence-unavailable: {type(exc).__name__}: {exc}"[:300]


def complete(c, q, item, rdir, run_id, cls, ended_at, exit_code):
    """Content-stable publication before terminal queue mutation; safe to replay."""
    findings = []
    raw_bytes = (rdir / "review.ndjson").read_bytes()
    raw = raw_bytes.decode("utf-8", errors="replace")
    for line in raw.splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and value.get("type") == "finding":
            findings.append(value)
    adequate = cls.get("counted") is True and cls.get("outcome") == "completed"
    document = dict(v=1, kind=operation.RECEIPT_KIND, identity=item["identity"],
                    identity_inputs=item["identity_inputs"], profile=item["profile"], run_id=run_id,
                    outcome=("findings" if findings else "clean") if adequate else "no-verdict",
                    scope_adequate=adequate, findings=findings,
                    report=(rdir / "findings.md").read_text(errors="replace") if (rdir / "findings.md").exists() else raw,
                    observed={"cli_version": None, "model_version": None, "reason": "not-observed",
                              "classification": cls, "exit_code": exit_code,
                              "artifacts": {"review.ndjson": hashlib.sha256(raw_bytes).hexdigest()}},
                    independent_acceptance=False)
    operation.validate("receipt", document)
    receipt_id = receipts.write_receipt(c.STATE / "receipts", document)
    event_id = receipts.digest(dict(item=item["id"], run=run_id, receipt=receipt_id))
    # Event and notification bookkeeping share the terminal queue transaction.
    q.setdefault("review_events", {})[event_id] = dict(item=item["id"], run_id=run_id,
        receipt_id=receipt_id, occurred_at=ended_at, state="completed" if adequate else "failed")
    for request_id in item.get("observers", []):
        destination = q.get("review_requests", {}).get(request_id, {}).get("notify")
        if destination:
            key = receipts.digest([request_id, event_id, destination])
            q.setdefault("review_notify_outbox", {}).setdefault(key, dict(v=1, request_id=request_id,
                event_id=event_id, destination=copy.deepcopy(destination), state="pending", receipt_id=receipt_id))
    run = item.get("run") or {}
    item.update(state="done" if adequate else "failed", scope_adequate=adequate,
                receipt_id=receipt_id, run=None, publication_pending=True,
                local_run_id=run_id, completed_at=ended_at, last_error=cls.get("message"), wait_reason=None)
    item.pop("not_before", None)
    item.pop("reconcile_failures", None)
    if not any(a.get("run_id") == run_id for a in item.get("attempts", [])):
        item.setdefault("attempts", []).append(dict(run_id=run_id, outcome=cls["outcome"],
            counted=adequate, at=ended_at, receipt_id=receipt_id,
            band=run.get("band", "background"), started_at=run.get("started_at")))
    c.save_queue(q)
    republish(c, q, item)
    return f"{item['id']}: {item['state']}; receipt {receipt_id}"


def republish(c, q, item):
    """Remote publication is independent of local completion and exact reuse."""
    if not repo_registry.same_repo(item["identity_inputs"]["repo"], c.REPO):
        item.update(publication_pending=False, publication_reason="multi-repo publication unsupported")
        c.save_queue(q)
        return
    try:
        import backfill_runtime
        config = backfill_runtime.settings(c.STATE)
        if not config:
            item["publication_reason"] = "publication-disabled"
            c.save_queue(q)
            return
        _, store, outbox, _ = backfill_runtime.services(c, config)
        document = _ReceiptSnapshot(c.STATE / "receipts", item["receipt_id"]).document
        reference = store.put(receipts.canonical(document))
        reference["kind"] = operation.RECEIPT_KIND
        facts = item["identity_inputs"]
        payload = dict(repo=c.REPO, subject_id=item["identity"], job_id=item["local_run_id"],
            attempt_id=item["local_run_id"],
            source=dict(repo=c.REPO, producer="author-queue", type="author-queue",
                        id=item["local_run_id"], authenticated=True),
            base=facts["base_commit"], head=facts["head_commit"], head_tree=facts["head_tree"],
            target=facts["head_commit"], target_tree=facts["head_tree"],
            policy_digest=facts["config_digest"], scope_digest=ledger.digest([]),
            paths=[], requested_scope=[], input_scope=[], reviewed_scope=[],
            completion=dict(terminal=True, skipped=False, scope_verified=False,
                            exit_code=document["observed"]["exit_code"],
                            errors=["per-line scope unverified: full-diff adapter supplies no line-scope proof"]),
            outcome="unverified", artifacts=[reference], findings=[])
        value = ledger.event("review", f"{c.REPO}:author-queue:{item['local_run_id']}",
                             item["completed_at"], payload)
        outbox.spool(value)
        pending = (outbox.root / "ack" / (value["id"] + ".json")).exists() is False
        item.update(publication_pending=pending, publication_event_id=value["id"],
                    publication_reason="publication-spooled" if pending else None)
        if pending:
            backfill_runtime.publish(c, q)
    except Exception as exc:
        item.update(publication_pending=True, publication_reason=str(exc)[:300])
    c.save_queue(q)
