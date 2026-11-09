"""review-v1 on the queue identity. No author environment or inline dispatch."""
import base64
import hashlib
import json
import os
from pathlib import Path
import signal
import sys

import author_snapshot
import queue_transport
import review_admission as admission
import review_operation as operation
import review_notify
import review_receipt
import repo_registry

MAX_BYTES = 6 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024
DEADLINE_S = 120
OPERATIONS = ["capabilities", "submit", "status", "result", "cancel", "notify-update"]


def decode(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_BYTES:
        raise ValueError("review request exceeds 6 MiB; reduce the commit range")
    request = json.loads(raw, object_pairs_hook=queue_transport._pairs)
    operation.validate("wire", request)
    if "snapshot" in request and len(review_receipt.canonical(request["snapshot"])) > MAX_SNAPSHOT_BYTES:
        raise ValueError("snapshot exceeds 5 MiB; reduce the commit range or use reachable objects")
    return request


def capabilities():
    return dict(v=1, command="review-v1", operations=OPERATIONS,
                features=["original-commit-snapshot-v1", "chunked-result-v1", "repeat-generations-v1"],
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
    q = runner.load_queue()
    op = req["op"]
    if op == "submit":
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
            if not repo_registry.same_repo(inputs["repo"], runner.REPO):
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
            import local_review_runtime
            result = admission.admit(q, request_id=req["request_id"], inputs=inputs,
                                     resolved=facts, profile=stored, at=runner.iso(),
                                     repeat=req.get("repeat", False), supersedes=req.get("supersedes"),
                                     notify=review_notify.destination(req.get("notify"), runner.CONFIG), verify_receipt=lambda item: retained(runner, item))
            binding = q["review_requests"][req["request_id"]]
            binding["principal"] = principal
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
                except runner.NotReady:
                    reused = False
                if reused:
                    result = {**admission.status(q, req["request_id"]), "action": "reused"}
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
    operation.validate("response", result)
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
        result = work(crq) if req["op"] in ("capabilities", "status", "result") else supervised(work, crq, lock_wait=2)
        if result is None:
            result = error("busy", "review queue lock busy; retry the same request id", True)
        sys.stdout.buffer.write(result)
        return 0
    finally:
        signal.alarm(0)
