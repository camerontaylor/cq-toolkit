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
import review_receipt

MAX_BYTES = 6 * 1024 * 1024
DEADLINE_S = 120
OPERATIONS = ["capabilities", "submit", "status", "result", "cancel"]


def decode(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_BYTES:
        raise ValueError("review request exceeds 6 MiB; reduce the commit range")
    request = json.loads(raw, object_pairs_hook=queue_transport._pairs)
    return operation.validate("wire", request)


def capabilities():
    return dict(v=1, command="review-v1", operations=OPERATIONS,
                features=["original-commit-snapshot-v1", "chunked-result-v1", "repeat-generations-v1"],
                limits=dict(max_request_bytes=MAX_BYTES, max_snapshot_bytes=MAX_BYTES,
                            max_content_bytes=author_snapshot.MAX_CONTENT,
                            max_objects=author_snapshot.MAX_OBJECTS, chunk_bytes=review_receipt.CHUNK_BYTES))


def profile(config, base):
    """Server configuration is the only source of semantic revision and argv."""
    value = config.get("local_review_profile", {})
    result = dict(adapter="coderabbit-cli", revision=value.get("revision", "committed-full-diff-v1"),
                  flags=value.get("flags", ["--agent", "--deep", "--committed"]) + ["--base-commit", base])
    operation.validate("profile", result)
    return result


def resolve(runner, inputs, stored):
    """Compute all hashed facts from installed immutable objects."""
    clone = runner.CLONE
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
        if inputs["repo"] != runner.REPO or inputs["repo"] != policy["repo"]:
            return review_receipt.canonical(dict(v=1, action="observed", state="unsupported", reason="unsupported-repo"))
        if inputs["target"] not in policy.get("branches", []):
            raise ValueError("target branch denied")
        key = admission.key_digest(inputs, repeat=req.get("repeat", False))
        result = admission.retry(q, req["request_id"], key)
        if result is None:
            if "snapshot" in req:
                if req["snapshot"]["tree"] != inputs["head_tree"]:
                    raise ValueError("snapshot tree mismatch")
                author_snapshot.install(req["snapshot"], dict(base=inputs["base_commit"], head=inputs["head_commit"]), runner, original=True)
            stored = profile(runner.CONFIG, inputs["base_commit"])
            facts = resolve(runner, inputs, stored)
            import local_review_runtime
            for item in q.get("items", []):
                if (item.get("kind") == operation.KIND and admission.adequate(item)
                        and operation.equivalent(item.get("identity_inputs"), facts)
                        and local_review_runtime.retained(runner, item) is None):
                    raise ValueError("retained local review receipt is inadequate")
            result = admission.admit(q, request_id=req["request_id"], inputs=inputs,
                                     resolved=facts, profile=stored, at=runner.iso(),
                                     repeat=req.get("repeat", False), supersedes=req.get("supersedes"))
            runner.save_queue(q)
            if result["action"] == "created" and any(i.get("kind") in ("open", "delta") and i.get("cycles") for i in q["items"]):
                item = next(i for i in q["items"] if i["id"] == result["item"])
                try:
                    reused = local_review_runtime.prepare(runner, q, item, False) is None
                except runner.NotReady:
                    reused = False
                if reused:
                    result = {**admission.status(q, req["request_id"]), "action": "reused"}
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


def main():
    from author_transport import supervised
    def expired(signum, frame):
        raise ValueError("review snapshot/install deadline")
    signal.signal(signal.SIGALRM, expired)
    try:
        signal.alarm(DEADLINE_S)
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        decode(raw)
        policy = json.loads(Path(os.environ["CRQ_QUEUE_POLICY"]).read_text())
        principal = os.environ["CRQ_QUEUE_PRINCIPAL"]
        import crq
        result = supervised(lambda runner: handle(raw, runner, principal=principal, policy=policy), crq)
        if result is None:
            raise ValueError("review queue lock busy")
        sys.stdout.buffer.write(result)
        return 0
    finally:
        signal.alarm(0)
