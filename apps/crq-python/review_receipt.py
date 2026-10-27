"""Merged-current subject and immutable bounded receipt API (version 1).

Caller owns the existing tick lock and queue persistence. No network or dispatch.
Receipt chunks encode canonical UTF-8 JSON bytes, including arbitrarily large
individual findings; consumers verify the whole SHA256 before acknowledging.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

VERSION = 1
KIND = "merged-current"
POLICY = "affected-current-additions-v1"
CHUNK_BYTES = 3072
SELECTORS = {"promoted-main": "origin/main", "merge-queue": "origin/merge-queue"}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def enroll(q, *, repo, pr, merge_sha, request_id, at, target_selector="promoted-main"):
    """Bind a request id permanently; equal provenance shares one pending item.

    Forge validation belongs to the authorized caller, before this pure mutation.
    Target SHA is deliberately absent until the sole natural tick dispatches.
    """
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", request_id):
        raise ValueError("invalid request id")
    if not isinstance(repo, str) or not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        raise ValueError("invalid repository")
    if type(pr) is not int or pr <= 0 or not isinstance(merge_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", merge_sha):
        raise ValueError("invalid source PR/merge SHA")
    if target_selector not in SELECTORS:
        raise ValueError("unsupported target selector")
    binding = {"repo": repo, "pr": pr, "merge_sha": merge_sha, "target_selector": target_selector,
               "policy": POLICY}
    requests = q.get("merged_current_requests", {})
    old = requests.get(request_id)
    if old and old["binding"] != binding:
        raise ValueError("request id has a different binding")
    item_id = old["item"] if old else "current-" + digest(binding)[:32]
    item = next((i for i in q["items"] if i["id"] == item_id), None)
    created = item is None
    if created:
        item = {"id": item_id, "kind": KIND, "pr": pr, "merge_commit": merge_sha,
                "subject": binding, "state": "pending", "created_at": at,
                "order": max((i.get("order", 0) for i in q["items"]), default=0) + 1,
                "cycles": [], "attempts": [], "failures": 0, "depends_on": []}
        q["items"].append(item)
    q.setdefault("merged_current_requests", {})[request_id] = {"binding": binding, "item": item_id}
    return {"version": VERSION, "created": created, "item": item}


def status(q, request_id):
    request = q.get("merged_current_requests", {}).get(request_id)
    if request is None:
        raise ValueError("unknown merged-current request")
    item = next(i for i in q["items"] if i["id"] == request["item"])
    return {"version": VERSION, "request_id": request_id, "item_id": item["id"],
            "subject": request["binding"], "state": item["state"],
            "capture": item.get("capture"), "receipt_id": item.get("receipt_id"),
            "reused_from": item.get("reused_from"), "reason": item.get("last_error") or item.get("wait_reason")}


def write_receipt(root, document):
    """Durably publish once by content identity, safe to repeat after a crash."""
    data = canonical(document)
    receipt_id = hashlib.sha256(data).hexdigest()
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".receipt-", dir=root)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        try:
            os.link(name, root / (receipt_id + ".json"))
        except FileExistsError:
            if (root / (receipt_id + ".json")).read_bytes() != data:
                raise ValueError("receipt identity collision or tampering")
        directory = os.open(root, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)
    return receipt_id


def read_receipt(root, receipt_id, cursor=None):
    """Return manifest, or a digest-bound zero-based chunk; each < 8 KiB JSON.

    Cursor is '<receipt SHA256>:<chunk index>'. It is not an authorization
    token: Q3 must verify repository/request/read authority before invoking.
    """
    if not isinstance(receipt_id, str) or not re.fullmatch(r"[0-9a-f]{64}", receipt_id):
        raise ValueError("invalid receipt id")
    data = (Path(root) / (receipt_id + ".json")).read_bytes()
    if hashlib.sha256(data).hexdigest() != receipt_id:
        raise ValueError("receipt digest mismatch")
    count = max(1, (len(data) + CHUNK_BYTES - 1) // CHUNK_BYTES)
    common = {"version": VERSION, "receipt_id": receipt_id, "sha256": receipt_id,
              "bytes": len(data), "chunks": count, "encoding": "base64-utf8-json"}
    if cursor is None:
        return {**common, "kind": "manifest", "cursor": receipt_id + ":0"}
    match = re.fullmatch(re.escape(receipt_id) + r":(0|[1-9][0-9]{0,9})", cursor)
    if not match or int(match[1]) >= count:
        raise ValueError("invalid or mixed-snapshot cursor")
    index = int(match[1])
    chunk = data[index * CHUNK_BYTES:(index + 1) * CHUNK_BYTES]
    return {**common, "kind": "chunk", "index": index,
            "chunk_sha256": hashlib.sha256(chunk).hexdigest(),
            "data": base64.b64encode(chunk).decode("ascii"),
            "next_cursor": receipt_id + ":" + str(index + 1) if index + 1 < count else None}
