"""review-v1 on the queue identity. No author environment or inline dispatch."""
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

import author_snapshot
import backfill_runtime
import queue_transport
import review_admission as admission
import review_operation as operation
import review_history
import review_notify
import review_receipt
import repo_registry

MAX_BYTES = 6 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024
DEADLINE_S = 120
OPERATIONS = ["capabilities", "submit", "status", "result", "cancel", "notify-update",
              "review-history", "record"]
FEATURES = ["original-commit-snapshot-v1", "chunked-result-v1", "repeat-generations-v1",
            "review-history-v1", "review-record-v1"]


def decode(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_BYTES:
        raise ValueError("review request exceeds 6 MiB; reduce the commit range")
    request = json.loads(raw, object_pairs_hook=queue_transport._pairs)
    operation.validate("wire", request)
    if "snapshot" in request and len(review_receipt.canonical(request["snapshot"])) > MAX_SNAPSHOT_BYTES:
        raise ValueError("snapshot exceeds 5 MiB; reduce the commit range or use reachable objects")
    return request


def capabilities():
    return dict(v=1, command="review-v1", operations=OPERATIONS, features=FEATURES,
                limits=dict(max_request_bytes=MAX_BYTES, max_snapshot_bytes=MAX_SNAPSHOT_BYTES,
                            max_content_bytes=author_snapshot.MAX_ORIGINAL_CONTENT,
                            max_objects=author_snapshot.MAX_OBJECTS, chunk_bytes=review_receipt.CHUNK_BYTES))


def profile(config, base):
    """Server configuration is the only source of semantic revision and argv."""
    value = config.get("local_review_profile", {})
    result = dict(adapter="coderabbit-cli", revision=value.get("revision", "committed-full-diff-v1"),
                  flags=value.get("flags", ["--agent", "--deep", "--committed"]) + ["--base-commit", base])
    operation.validate("profile", result)
    return result


def clone_for(runner, repo):
    """Clone configuration locates objects; policy authorization is separate."""
    if repo_registry.same_repo(repo, runner.REPO):
        return Path(runner.CLONE)
    cfg = repo_registry.by_repo(getattr(runner, "REPOS", []), repo)
    if cfg is None:
        raise ValueError("unconfigured review repository")
    return Path(cfg["clone"])


def history_git(clone):
    """Advisory Git adapter: an unreadable object is unknown, never zero."""
    def run(*args):
        try:
            return author_snapshot.git(clone, *args)
        except author_snapshot.AuthorRefused as exc:
            raise review_history.GitUnavailable(str(exc)) from exc
    return run


def history_projection(q, runner, *, repo, target, head_commit=None, head_tree=None,
                       task=None, branch=None, predecessor=None, observed=None,
                       limit=review_history.DEFAULT_LIMIT, cursor=0, exclude_item=None):
    """Resolve advisory history; any failure is degraded, never admission-blocking."""
    try:
        clone = clone_for(runner, repo)
        return review_history.project(q, repo=repo, target=target, head_commit=head_commit,
                                      head_tree=head_tree, task=task, branch=branch,
                                      predecessor=predecessor, observed=observed,
                                      limit=limit, cursor=cursor, git=history_git(clone),
                                      exclude_item=exclude_item)
    except Exception as exc:  # advisory index only: exact reuse stays unaffected
        return review_history.degraded(str(exc) or exc.__class__.__name__)


def history_query(q, binding):
    """Stored request/item facts are the only query a status poll may use."""
    item = next(i for i in q["items"] if i["id"] == binding["item"])
    inputs = item["identity_inputs"]
    task = binding.get("task") or item.get("task")
    branch = binding.get("branch") or item.get("branch")
    return dict(repo=inputs["repo"], target=item.get("target"),
                head_commit=inputs["head_commit"], head_tree=inputs["head_tree"],
                task=task, branch=branch, predecessor=binding.get("predecessor"),
                observed=binding.get("observed"), exclude_item=item["id"])


def history_cue(projection):
    """Compact cue carried by submit/status; material dedupe is the caller's."""
    result = dict(v=1, digest=projection["digest"], status=projection["status"])
    for key in ("cue", "reason"):
        if projection.get(key) is not None:
            result[key] = projection[key]
    return result


def resolve(runner, inputs, stored):
    """Compute all hashed facts from installed immutable objects."""
    clone = clone_for(runner, inputs["repo"])
    facts = {k: inputs[k] for k in ("repo", "base_commit", "head_commit", "projection")}
    for end in ("base", "head"):
        commit = author_snapshot.git(clone, "rev-parse", "--verify", inputs[end + "_commit"] + "^{commit}").decode().strip()
        tree = author_snapshot.git(clone, "rev-parse", "--verify", commit + "^{tree}").decode().strip()
        if commit != inputs[end + "_commit"] or tree != inputs[end + "_tree"]:
            raise ValueError("claimed commit/tree mismatch")
        facts[end + "_tree"] = tree
    # Missing config is a distinct deterministic configuration, not a shell error.
    entries = author_snapshot.git(clone, "ls-tree", inputs["head_commit"], "--", ".coderabbit.yaml").split()
    blob = author_snapshot.git(clone, "cat-file", "blob", entries[2].decode()) if entries else b""
    facts.update(v=1, scope="full-diff", config_digest=hashlib.sha256(blob).hexdigest(),
                 profile={k: stored[k] for k in ("adapter", "revision")})
    operation.identity(facts)
    return facts


def record_import(q, req, req_principal, runner):
    """S3b review-record: normalize one import, retain and publish it.

    The import is idempotent on (producer, source id, report digest); one
    malformed import quarantines alone with a readable reason and never stops
    queue scheduling. The authenticated submitter is the server-authenticated
    principal, never client input. Events spool into the publication worker's
    outbox (backfill_runtime.services) so the next publication drains them into
    the shared ledger; without a rollout configuration the disposition still
    answers honestly with a publication-disabled marker and nothing is
    dispatched and no vendor capacity is reserved.
    """
    import review_ledger
    import review_record
    submitted = {
        "producer": req["producer"],
        "id": req["source_id"],
        "report_bytes": req["report"]["data"].encode("utf-8"),
        "repo": req.get("repo"),
        "head": req.get("head_commit"),
        "base": req.get("base_commit"),
        "head_tree": req.get("head_tree"),
        "target": req.get("target"),
        "reviewer": req.get("reviewer"),
        # Provenance split: the trusted principal is the authenticated
        # submitter; the claimed reviewer is client metadata that earns no
        # credit. Client-supplied submitter identity is ignored.
        "authenticated_submitter": req_principal,
        "verdict": req.get("verdict"),
        "claimed_scope": req.get("claimed_scope"),
        "independence": req.get("independence"),
        "supersedes": req.get("supersedes"),
        "forge_evidence": req.get("forge_evidence"),
    }
    if req.get("repo") is not None and not repo_registry.same_repo(req["repo"], runner.REPO) \
            and repo_registry.by_repo(getattr(runner, "REPOS", []), req["repo"]) is None:
        return dict(v=1, op="record", action="refused", record_digest=None,
                    duplicate_of=None, supersedes=req.get("supersedes"),
                    reason="unsupported-repo")
    retained = _retained_records(runner)
    events, action = review_record.import_record(submitted, runner.iso(), retained)
    kind, _, detail = action.partition(":")
    result = dict(v=1, op="record", action="recorded" if kind == "record" else kind,
                  record_digest=None, duplicate_of=None, supersedes=req.get("supersedes"),
                  publication="disabled")
    if events:
        # Publication shares the durable rollout: the record lands in the same
        # outbox the backfill publisher drains, with artifacts in the configured
        # durable store. Rehashing with the durable reference changes the record
        # id, so the response carries the retained (published) id, not the
        # import preview. The spooled marker moves to the code paths that
        # actually spool: oversized quarantine reuse answers disabled.
        config = backfill_runtime.settings(runner.STATE)
        if config:
            # services() builds the publisher transport too; the record path
            # needs only the shared durable store and outbox, so construct
            # them directly from the rollout configuration exactly as
            # backfill_runtime.services does, without touching the publisher
            # (no Git, no SSH from the import path).
            store = review_ledger.ArtifactStore(config["durable_artifact_root"])
            box = review_ledger.Outbox(runner.STATE / "backfill/publication", store)
        else:
            store = review_ledger.ArtifactStore(runner.STATE / "record-artifacts")
            box = review_ledger.Outbox(runner.STATE / "record-outbox", store)
        retained_ref = store.put(req["report"]["data"].encode("utf-8"))
        for value in events:
            value = copy.deepcopy(value)
            value["payload"]["artifacts"] = [dict(retained_ref, kind="report")]
            value["id"] = review_ledger.digest({k: v for k, v in value.items() if k != "id"})
            review_ledger.validate(value)
            if len(review_ledger.canonical(value)) > review_record.MAX_EVENT_BYTES:
                # The publisher refuses events above its validation bound while
                # building publication groups, which would block the shared
                # outbox for every queued event; quarantine the oversized
                # import at the door instead of spooling a poison event.
                return _oversize_quarantine(runner, submitted, retained_ref,
                                            retained, box, result, config)
            if value["event_type"] == "review":
                detail = value["id"]
                retained.append(value)
            box.spool(value)
        if config:
            result["publication"] = "spooled"
            # The durable background request makes the next publisher pass
            # drain the spooled record; safe under tick.lock, no Git/network.
            backfill_runtime.publish(runner, q)
    if kind == "record":
        result["record_digest"] = detail
    elif kind == "duplicate":
        result["duplicate_of"] = detail
    elif kind in ("quarantined", "refused"):
        result["reason"] = detail
    return result


def _oversize_quarantine(runner, submitted, retained_ref, retained, box, result, config):
    """Quarantine an import whose serialized event exceeds the publisher bound.

    The report bytes stay retained in the durable store (the disposition
    references them, so the outbox can verify) and the oversized review event
    itself never enters the shared outbox to block other queued evidence. A
    repeated identical oversize import reuses the retained disposition (same
    source key, same id): minting a second event would collide in
    validate_sequence and block all publication. The response answers
    quarantined honestly, spooled only when a new event actually spooled.
    """
    import review_ledger
    import review_record
    reason = "serialized event exceeds the 1 MiB publisher bound"
    digest_hex = hashlib.sha256(submitted["report_bytes"]).hexdigest()
    quarantine_key = review_record.quarantine_source_key(reason=reason,
                                                         digest_hex=digest_hex)
    previous = next((v for v in retained if v.get("event_type") == "import-result"
                     and v.get("source_key") == quarantine_key), None)
    if previous is not None:
        result["action"] = "quarantined"
        result["reason"] = reason
        # The retained disposition is already in the publication outbox (the
        # first import spooled it); under a rollout the answer stays honest
        # about that instead of claiming publication is disabled.
        if config:
            result["publication"] = "spooled"
        return result
    quarantine = review_record._quarantine_event(
        reason=reason, digest_hex=digest_hex, submitted=submitted, at=runner.iso())
    if quarantine is None:
        result["action"] = "refused"
        result["reason"] = reason
        return result
    quarantine["payload"]["artifacts"] = [dict(retained_ref, kind="report")]
    quarantine["id"] = review_ledger.digest({k: v for k, v in quarantine.items() if k != "id"})
    review_ledger.validate(quarantine)
    box.spool(quarantine)
    result["action"] = "quarantined"
    result["reason"] = reason
    result["publication"] = "spooled" if config else result["publication"]
    return result


def _retained_records(runner):
    """Retained record events for idempotency; an unreadable one is skipped.

    Idempotency consults both spool locations: with a durable rollout the
    record lives in the publication worker's outbox (pending side; ack files
    carry only ids, so acknowledged events are read from pending, which the
    publisher keeps as recovery authority), otherwise in the legacy local
    record-outbox. A ledger read failure never blocks scheduling.
    """
    import review_ledger
    records = []
    roots = [runner.STATE / "backfill/publication", runner.STATE / "record-outbox"]
    seen = set()
    for root in roots:
        directory = root / "pending"
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.json")):
            try:
                value = review_ledger.loads(path.read_bytes())
            except (review_ledger.IntegrityError, OSError):
                continue
            if value.get("event_type") == "review" and value.get("id") not in seen:
                seen.add(value["id"])
                records.append(value)
            elif (value.get("event_type") == "import-result"
                  and str(value.get("source_key", "")).startswith("record:")
                  and value.get("id") not in seen):
                # Retained quarantine dispositions participate in import
                # idempotency: a repeated identical malformed import reuses the
                # original event instead of minting a colliding duplicate.
                seen.add(value["id"])
                records.append(value)
    return records


def retained(runner, item):
    """Disk bytes, not queue metadata, authorize completed-result reuse."""
    try:
        doc = queue_transport._ReceiptSnapshot(runner.STATE / "receipts", item["receipt_id"]).document
        operation.validate("receipt", doc)
        return (doc["kind"] == operation.RECEIPT_KIND and doc["identity"] == item["identity"]
                and doc["identity_inputs"] == item["identity_inputs"] and doc["scope_adequate"] is True
                and doc["outcome"] in ("clean", "findings"))
    except (OSError, ValueError, KeyError):
        return False


def handle(raw, runner, *, principal, policy):
    req = decode(raw)
    policy = queue_transport.validate_policy(policy)
    if principal not in policy.get("write", []):
        raise ValueError("review principal denied")
    if req["op"] == "capabilities":
        return review_receipt.canonical(capabilities())
    if policy.get("enabled") is not True:
        return review_receipt.canonical(dict(v=1, action="observed", state="unsupported", reason="review-disabled"))
    op = req["op"]
    if op == "record":
        # The operator's policy repository allowlist applies to record
        # imports exactly as to submit: configuration alone is not
        # authorization, so a configured clone for another repo cannot
        # publish evidence the policy never allowed. The effective repo is
        # resolved first (normalize_record defaults an omitted repo to the
        # runner's own), so omitting repo cannot bypass the allowlist.
        effective_repo = req.get("repo") or runner.REPO
        allowed = [policy["repo"], *policy.get("repos", [])]
        # Compare like submit: identity equality (owner/name casing), not
        # exact string, so an alternate spelling of an allowed repo is
        # accepted instead of falling through to a misleading quarantine.
        if not any(repo_registry.same_repo(effective_repo, a) for a in allowed):
            return review_receipt.canonical(dict(v=1, op="record", action="refused",
                                                 record_digest=None, duplicate_of=None,
                                                 supersedes=req.get("supersedes"),
                                                 reason="unsupported-repo"))
    q = runner.load_queue()
    if op == "record":
        result = record_import(q, req, principal, runner)
    elif op == "submit":
        inputs = req["inputs"]
        allowed = [policy["repo"], *policy.get("repos", [])]
        configured = repo_registry.same_repo(inputs["repo"], runner.REPO) or repo_registry.by_repo(getattr(runner, "REPOS", []), inputs["repo"]) is not None
        if inputs["repo"] not in allowed or not configured:
            return review_receipt.canonical(dict(v=1, action="observed", state="unsupported", reason="unsupported-repo"))
        if inputs["target"] not in policy.get("branches", []):
            raise ValueError("target branch denied")
        key = admission.key_digest(inputs, repeat=req.get("repeat", False))
        result = admission.retry(q, req["request_id"], key)
        if result is None:
            clone = clone_for(runner, inputs["repo"])
            # Snapshot bundles supply the unpublished head; only the base must be fetched.
            needed = [inputs["base_commit"]] if "snapshot" in req else [inputs["base_commit"], inputs["head_commit"]]
            try:
                for commit in needed:
                    author_snapshot.git(clone, "cat-file", "-e", commit + "^{commit}")
            except author_snapshot.AuthorRefused:
                runner.fetch(clone=clone)
            if "snapshot" in req:
                if req["snapshot"]["tree"] != inputs["head_tree"]:
                    raise ValueError("snapshot tree mismatch")
                cfg = repo_registry.by_repo(getattr(runner, "REPOS", []), inputs["repo"])
                classes = (runner.UNIVERSAL_SCAN_CLASSES | set(cfg.get("scan_extra_classes", []))
                           if not repo_registry.same_repo(inputs["repo"], runner.REPO) else None)
                author_snapshot.install(req["snapshot"], dict(base=inputs["base_commit"], head=inputs["head_commit"]),
                                        runner, original=True, clone=clone, classes=classes)
            stored = profile(runner.CONFIG, inputs["base_commit"])
            facts = resolve(runner, inputs, stored)
            repeat_history = history_projection(
                q, runner, repo=inputs["repo"], target=inputs["target"],
                head_commit=inputs["head_commit"], head_tree=inputs["head_tree"],
                task=req.get("task"), branch=req.get("branch"),
                predecessor=req.get("predecessor"), observed=req.get("observed"))
            import local_review_runtime
            result = admission.admit(q, request_id=req["request_id"], inputs=inputs,
                                     resolved=facts, profile=stored, at=runner.iso(),
                                     repeat=req.get("repeat", False), supersedes=req.get("supersedes"),
                                     ancestry_repeat=repeat_history["repeat"],
                                     notify=review_notify.destination(req.get("notify"), runner.CONFIG), verify_receipt=lambda item: retained(runner, item))
            binding = q["review_requests"][req["request_id"]]
            # Admission may reuse/join an item with this exact head. The response
            # cue describes the queue without that matched item: exact reuse is
            # not a repeat and must not claim it will wait behind first reviews.
            history = history_projection(
                q, runner, repo=inputs["repo"], target=inputs["target"],
                head_commit=inputs["head_commit"], head_tree=inputs["head_tree"],
                task=req.get("task"), branch=req.get("branch"),
                predecessor=req.get("predecessor"), observed=req.get("observed"),
                exclude_item=binding["item"])
            binding["principal"] = principal
            for key in ("task", "branch", "predecessor", "observed"):
                if key in req:
                    binding[key] = copy.deepcopy(req[key])
            if result.get("action") == "created":
                item = next(i for i in q["items"] if i["id"] == binding["item"])
                for key in ("task", "branch"):
                    if key in req:
                        item[key] = copy.deepcopy(req[key])
            if "notify" in req:
                binding["notify_status"] = review_notify.validation(req["notify"], runner.CONFIG,
                    required=any(req["request_id"] in i.get("observers", []) for i in q["items"]))
            if "notify_status" in binding:
                result["notify"] = binding["notify_status"]
            runner.save_queue(q)
            if result["action"] == "created" and any(i.get("kind") in ("open", "delta") and i.get("cycles") for i in q["items"]):
                item = next(i for i in q["items"] if i["id"] == result["item"])
                try:
                    reused = local_review_runtime.prepare(runner, q, item, False) is None
                except Exception:  # admission is persisted; the reuse probe is best-effort
                    reused = False
                if reused:
                    result = {**admission.status(q, req["request_id"]), "action": "reused"}
            result["history"] = history_cue(history)
        else:
            binding = q["review_requests"][req["request_id"]]
            result["history"] = history_cue(history_projection(
                q, runner, **history_query(q, binding)))
    elif op == "notify-update":
        binding = q.get("review_requests", {}).get(req["request_id"])
        if binding is None or binding.get("principal") != principal:
            raise ValueError("notification request owner denied")
        review_notify.update(q, req["request_id"], req["notify"], runner.CONFIG)
        runner.save_queue(q)
        result = admission.status(q, req["request_id"])
    elif op == "cancel":
        result = admission.cancel(q, req["request_id"])
        runner.save_queue(q)
    elif op == "review-history":
        if req.get("request_id"):
            binding = q.get("review_requests", {}).get(req["request_id"])
            if binding is None:
                raise ValueError("unknown review request")
            query = history_query(q, binding)
        else:
            if not req.get("repo") or not req.get("target"):
                raise ValueError("review-history requires repo and target")
            query = dict(repo=req["repo"], target=req["target"],
                         head_commit=req.get("head_commit"), head_tree=req.get("head_tree"),
                         task=req.get("task"), branch=req.get("branch"),
                         predecessor=req.get("predecessor"), observed=req.get("observed"))
        result = history_projection(
            q, runner, limit=req.get("limit", review_history.DEFAULT_LIMIT),
            cursor=req.get("cursor", 0), **query)
    else:
        result = admission.status(q, req["request_id"])
        if op == "result" and result.get("receipt_id"):
            receipt_id = result["receipt_id"]
            snap = queue_transport._ReceiptSnapshot(runner.STATE / "receipts", receipt_id)
            index = req.get("index", 0)
            if index >= snap.count:
                raise ValueError("result index out of bounds")
            data = snap.data[index * review_receipt.CHUNK_BYTES:(index + 1) * review_receipt.CHUNK_BYTES]
            result = dict(v=1, receipt_id=receipt_id, index=index, chunks=snap.count,
                          bytes=len(snap.data), sha256=receipt_id, encoding="base64-utf8-json",
                          data=base64.b64encode(data).decode(), chunk_sha256=hashlib.sha256(data).hexdigest(),
                          next_index=index + 1 if index + 1 < snap.count else None)
        elif op == "status":
            binding = q["review_requests"][req["request_id"]]
            result["history"] = history_cue(history_projection(
                q, runner, **history_query(q, binding)))
    operation.validate("history" if op == "review-history" else "response", result)
    return review_receipt.canonical(result)


def error(code, message, retryable=False):
    document = dict(v=1, error=dict(code=code, message=message, retryable=retryable))
    operation.validate("response", document)
    return review_receipt.canonical(document)


def safe_handle(raw, runner, *, principal, policy):
    # Runs inside supervision for writes: typed failures must cross its pipe.
    from author_quota import AuthorRefused
    try:
        return handle(raw, runner, principal=principal, policy=policy)
    except AuthorRefused as exc:
        return error("snapshot-refused", str(exc) + "; check required objects and snapshot limits")
    except ValueError as exc:
        return error("invalid-input", str(exc))
    except FileNotFoundError:
        return error("result-unavailable", "retained result unavailable; submit an explicit repeat")


def main():
    from author_transport import supervised
    from author_quota import AuthorRefused
    def expired(signum, frame):
        raise ValueError("review snapshot/install deadline")
    signal.signal(signal.SIGALRM, expired)
    try:
        signal.alarm(DEADLINE_S)
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        try:
            req = decode(raw)
        except ValueError as exc:
            sys.stdout.buffer.write(error("invalid-input", str(exc)))
            return 0
        policy = json.loads(Path(os.environ["CRQ_QUEUE_POLICY"]).read_text())
        principal = os.environ["CRQ_QUEUE_PRINCIPAL"]
        import crq
        work = lambda runner: safe_handle(raw, runner, principal=principal, policy=policy)
        try:
            read_only = ("capabilities", "status", "result", "review-history")
            result = work(crq) if req["op"] in read_only else supervised(work, crq, lock_wait=2)
        except (AuthorRefused, ValueError):
            # Supervision failures do not prove whether a write committed.
            # Keep the request id so retry can recover its durable receipt.
            result = error("unavailable", "review worker outcome unavailable; retry the same request id", True)
        if result is None:
            result = error("busy", "review queue lock busy; retry the same request id", True)
        sys.stdout.buffer.write(result)
        return 0
    finally:
        signal.alarm(0)
