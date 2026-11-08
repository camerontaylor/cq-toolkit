"""Authorized queue-v1 capability. Caller supplies identity/policy, never JSON.

No reviewer starts, credentials, shell commands or author-grant mutations.
Runner owns tick lock/load/save; Q1 owns immutable receipt storage.
With queue.project_fixed enabled, inventory state filters use OR semantics:
an exact row state matches, as does
any requested true reviewed/consumed/fixed fact. Thus reviewed includes reused,
consumed and fixed rows with review credit; fixed includes consumed repairs.
Other names match only the row state. Filtering, cursor digest and proof all use
the same selected rows; these are fact filters, not disjoint lifecycle buckets.
By default projection is off: status fixed is false, remediation is omitted, and
inventory retains its original row shape and exact-state filters (fixed matches
nothing). Internal receipt-bound evidence recording is independent of this gate.
"""
import base64
import contextlib
import copy
import io
import hashlib
import fcntl
import os
import tempfile
import time
from pathlib import Path
import json
import re

import review_receipt as receipts
import merged_reconcile as reconcile
from runtime_target import DISCOVERY_SELECTOR

MAX_BYTES = 8192
MAX_RECEIPT_BYTES = 64 * 1024 * 1024
TOKEN = r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}"
SHA = r"[0-9a-f]{40}"
# A deferred target is a git BRANCH, not a request token. This is the Python mirror of
# src/shared/refname.ts (the canonical grammar shared with the dev ledger and the TS
# wire/origin schemas); queue_transport.py cannot import it, so the rules are restated
# here verbatim and pinned to the shared vector table by test_queue_transport.py.
# The space rule is explicit (C0 + DEL + literal U+0020), never a `\s` class: Python's
# Unicode `\s` matches U+0085 while JavaScript's matches U+FEFF, so a shared `\s`
# would let one implementation accept a target the other rejects. Neither U+0085 nor
# U+FEFF is forbidden.
REFNAME_FORBIDDEN = re.compile(r"[~^:?*\[\]\\]")
READ = {"status", "report", "health"}
WRITE = {"enqueue", "bind", "cancel", "ack", "retry", "retry-capability"}


def _pairs(pairs):
    value = {}
    for k, v in pairs:
        if k in value:
            raise ValueError("duplicate JSON key")
        value[k] = v
    return value


def _match(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


class _ReceiptSnapshot:
    """Verify once per authorized request; never trust verification across requests.

    Keep the exact verified bytes for both source checks and Q1-compatible pages.
    A cursor selects bytes from this snapshot and grants no read authority.
    """
    def __init__(self, root, receipt_id, max_bytes=None):
        if max_bytes is None:
            max_bytes = MAX_RECEIPT_BYTES
        if not _match(r"[0-9a-f]{64}", receipt_id):
            raise ValueError("invalid receipt id")
        with (Path(root) / (receipt_id + ".json")).open("rb") as stream:
            self.data = stream.read(max_bytes + 1)
        if len(self.data) > max_bytes:
            raise ValueError("receipt exceeds supported client capacity")
        if hashlib.sha256(self.data).hexdigest() != receipt_id:
            raise ValueError("receipt digest mismatch")
        self.document = json.loads(self.data, object_pairs_hook=_pairs)
        if not isinstance(self.document, dict):
            raise ValueError("invalid receipt document")
        self.receipt_id = receipt_id
        self.count = max(1, (len(self.data) + receipts.CHUNK_BYTES - 1) // receipts.CHUNK_BYTES)

    def page(self, cursor=None):
        common = {"version": receipts.VERSION, "receipt_id": self.receipt_id,
                  "sha256": self.receipt_id, "bytes": len(self.data),
                  "chunks": self.count, "encoding": "base64-utf8-json"}
        if cursor is None:
            return {**common, "kind": "manifest", "cursor": self.receipt_id + ":0"}
        if not isinstance(cursor, str):
            raise ValueError("invalid or mixed-snapshot cursor")
        match = re.fullmatch(re.escape(self.receipt_id) + r":(0|[1-9][0-9]{0,9})", cursor)
        if not match or int(match[1]) >= self.count:
            raise ValueError("invalid or mixed-snapshot cursor")
        index = int(match[1])
        chunk = self.data[index * receipts.CHUNK_BYTES:(index + 1) * receipts.CHUNK_BYTES]
        return {**common, "kind": "chunk", "index": index,
                "chunk_sha256": hashlib.sha256(chunk).hexdigest(),
                "data": base64.b64encode(chunk).decode("ascii"),
                "next_cursor": self.receipt_id + ":" + str(index + 1) if index + 1 < self.count else None}


def validate_policy(policy):
    """Operator policy is typed configuration, never truthy activation or substring ACLs."""
    if type(policy) is not dict:
        raise ValueError("invalid queue policy object")
    if "enabled" in policy and type(policy["enabled"]) is not bool:
        raise ValueError("invalid queue policy enabled boolean")
    if not _match(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", policy.get("repo")):
        raise ValueError("invalid queue policy repository")
    if "repos" in policy:
        repos = policy["repos"]
        if (type(repos) is not list or any(not _match(
                r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", repo) for repo in repos)):
            raise ValueError("invalid queue policy repositories")
    for key in ("read", "write", "targets", "branches"):
        values = policy.get(key, [])
        if type(values) is not list or any(type(value) is not str or not value for value in values):
            raise ValueError("invalid queue policy allowlist")
    if any(target not in receipts.SELECTORS for target in policy.get("targets", [])):
        raise ValueError("invalid queue policy target")
    grants = policy.get("transient_retries", [])
    if type(grants) is not list:
        raise ValueError("invalid transient retry grants")
    for grant in grants:
        if (type(grant) is not dict or not {"principal", "requestId", "binding"} <= set(grant)
                or set(grant) - {"principal", "requestId", "binding", "maxRetries"}
                or type(grant.get("maxRetries", 3)) is not int or not 1 <= grant.get("maxRetries", 3) <= 100
                or not isinstance(grant["principal"], str) or not grant["principal"]
                or not _match(TOKEN, grant["requestId"])
                or binding(grant["binding"])["repo"] != policy["repo"]):
            raise ValueError("invalid transient retry grant")
    grants = policy.get("reconciled_reads", [])
    if type(grants) is not list:
        raise ValueError("invalid reconciled read grants")
    granted_ids = set()
    for grant in grants:
        if (type(grant) is not dict or set(grant) != {"principal", "requestId", "binding"}
                or not isinstance(grant["principal"], str) or not grant["principal"]
                or not _match(TOKEN, grant["requestId"])):
            raise ValueError("invalid reconciled read grant")
        if grant["requestId"] in granted_ids:
            raise ValueError("duplicate reconciled read request id")
        granted_ids.add(grant["requestId"])
        b = binding(grant["binding"])
        if b["kind"] != "merged-current" or b["repo"] != policy["repo"]:
            raise ValueError("invalid reconciled read binding")
    grants = policy.get("inventory_reads", [])
    if type(grants) is not list:
        raise ValueError("invalid inventory grants")
    for grant in grants:
        if (type(grant) is not dict or set(grant) != {"principal", "binding"}
                or not isinstance(grant["principal"], str) or not grant["principal"]):
            raise ValueError("invalid inventory grant")
        scope = _inventory_binding(grant["binding"])
        if scope["repo"] != policy["repo"]:
            raise ValueError("inventory repository denied")
    grants = policy.get("health_reads", [])
    if type(grants) is not list:
        raise ValueError("invalid health grants")
    for grant in grants:
        if (type(grant) is not dict or set(grant) != {"principal", "binding"}
                or not isinstance(grant["principal"], str) or not grant["principal"]
                or _health_binding(grant["binding"])["repo"] != policy["repo"]):
            raise ValueError("invalid health grant")
    limit = policy.get("max_requests", 10000)
    if type(limit) is not int or not 1 <= limit <= 100000:
        raise ValueError("invalid queue policy capacity")
    return policy


def branch_fault(branch):
    """Mirror of src/shared/refname.ts branchPathFault; None means a valid branch."""
    if not isinstance(branch, str):
        return "branch must be a string"
    if branch == "" or branch.startswith("/") or branch.endswith("/"):
        return "branch must be a non-empty relative refname"
    if branch == "@":
        return "branch is the single character '@'"
    for char in branch:
        if ord(char) < 0x20 or ord(char) == 0x7f or ord(char) == 0x20:
            return "branch contains a space or control character"
    if branch.endswith("."):
        return "branch must not end with '.'"
    if "@{" in branch:
        return "branch contains the forbidden '@{' sequence"
    for segment in branch.split("/"):
        if (segment == "" or segment.startswith(".") or segment.endswith(".lock")
                or ".." in segment or REFNAME_FORBIDDEN.search(segment)):
            return "branch is not a path-safe refname"
    return None


def binding(value):
    if not isinstance(value, dict):
        raise ValueError("invalid binding")
    common = {"kind", "repo", "targetSelector"}
    fields = {"producer", "head", "target"} if value.get("kind") == "deferred-author" else {"pr", "mergeSha"}
    if (set(value) != common | fields or type(value.get("kind")) is not str
            or value.get("kind") not in {"deferred-author", "merged-current"}):
        raise ValueError("invalid binding fields")
    if (not _match(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", value["repo"])
            or not isinstance(value["targetSelector"], str)
            or value["targetSelector"] not in receipts.SELECTORS):
        raise ValueError("invalid repository or target selector")
    if value["kind"] == "deferred-author":
        if (not _match(TOKEN, value["producer"]) or not _match(SHA, value["head"])
                or branch_fault(value["target"]) is not None):
            raise ValueError("invalid producer/head/target")
    elif type(value["pr"]) is not int or value["pr"] <= 0 or not _match(SHA, value["mergeSha"]):
        raise ValueError("invalid merged source")
    return value



def _health_binding(value):
    if (type(value) is not dict or set(value) != {"repo", "targetSelector"}
            or not _match(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", value.get("repo"))
            or not isinstance(value.get("targetSelector"), str)
            or value.get("targetSelector") not in receipts.SELECTORS):
        raise ValueError("invalid health binding")
    return value


def _inventory_binding(value):
    if type(value) is not dict or set(value) != {"repo", "targetSelector", "after", "before"}:
        raise ValueError("invalid inventory binding")
    if (not _match(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", value["repo"])
            or not isinstance(value["targetSelector"], str)
            or value["targetSelector"] not in receipts.SELECTORS):
        raise ValueError("invalid inventory repository/selector")
    reconcile.normalize_interval(value["after"], value["before"])
    return value


def _inventory(req, runner, q, principal, receipt_root, *, project_fixed=False):
    b = req["binding"]
    interval = {k: b[k] for k in ("after", "before")}
    key = receipts.digest({"repo": b["repo"], "base": DISCOVERY_SELECTOR, **interval})
    path = runner.STATE / "reconcile" / (key + ".json")
    # Trusted runner validates the stored wrapper, source identity and checkpoint.
    raw = json.loads(path.read_text())
    checkpoint = raw.get("checkpoint")
    if not isinstance(checkpoint, dict):
        raise ValueError("inventory checkpoint unavailable")
    wrapper = runner._read_reconcile_wrapper(path, interval, checkpoint.get("page_budget"))
    if json.loads(path.read_text()) != raw:
        return {"error": {"code": "busy", "retryable": True}}
    cp = wrapper["checkpoint"]
    if not cp["complete"] or cp["dry_run"]:
        raise ValueError("complete durable inventory required")
    rows = []
    entries = q.get("queue_client_requests", {})
    queue_items = q.get("items")
    if (type(entries) is not dict or type(q.get("merged_current_requests", {})) is not dict
            or type(queue_items) is not list or any(type(item) is not dict for item in queue_items)):
        raise ValueError("invalid reconciled queue mappings/items")
    mapped = sorted(q.get("merged_current_requests", {}).items(),
                    key=lambda pair: (entries.get(pair[0], {}).get("principal") != principal, pair[0]))
    by_subject = {}
    for rid, mapping in mapped:
        by_subject.setdefault(receipts.digest(mapping["binding"]), []).append((rid, mapping))
    items = {}
    for item in queue_items:
        items.setdefault(item.get("id"), []).append(item)
    receipt_budget = MAX_RECEIPT_BYTES
    for source in cp["inventory"]:
        row = {"pr": source.get("pr"), "mergeSha": source.get("merge_sha"),
               "requestId": None, "itemId": None, "state": "missing", "reason": None}
        if project_fixed:
            row.update(reviewed=False, consumed=False, fixed=False)
        subject = {"repo": b["repo"], "pr": row["pr"], "merge_sha": row["mergeSha"],
                   "target_selector": b["targetSelector"], "policy": receipts.POLICY}
        for rid, mapping in by_subject.get(receipts.digest(subject), []):
            if mapping.get("binding") != subject:
                continue
            entry = entries.get(rid)
            if entry is not None and entry.get("principal") != principal:
                continue
            item_id = "current-" + receipts.digest(subject)[:32]
            matches = items.get(item_id, [])
            if (mapping != {"binding": subject, "item": item_id} or len(matches) != 1
                    or matches[0].get("subject") != subject or matches[0].get("kind") != receipts.KIND
                    or matches[0].get("pr") != subject["pr"]
                    or matches[0].get("merge_commit") != subject["merge_sha"]):
                raise ValueError("reconciled request/source mismatch")
            item = matches[0]
            status = receipts.status({**q, "items": [item]}, rid)
            row.update(requestId=rid, itemId=status["item_id"], state="pending")
            if entry and entry.get("reason"):
                row.update(state="blocked", reason=_status(q, rid, entry)["reason"])
            elif status.get("receipt_id"):
                if not _match(r"[0-9a-f]{64}", status["receipt_id"]):
                    raise ValueError("invalid receipt id")
                if (Path(receipt_root) / (status["receipt_id"] + ".json")).stat().st_size > receipt_budget:
                    row.update(state="blocked", reason={"source": "queue", "category": "capacity", "code": "inventory-receipt-budget"})
                    break
                snapshot = _ReceiptSnapshot(receipt_root, status["receipt_id"], receipt_budget)
                receipt_budget -= len(snapshot.data)
                doc = snapshot.document
                receipt_source = doc.get("source", {})
                source_matches = (receipt_source.get("repo") == subject["repo"]
                                  and receipt_source.get("target_selector") == subject["target_selector"])
                equivalent = (status.get("reused_from")
                              and (receipts.reusable_current(doc, status.get("capture"))
                                   or receipts.reusable_noncounted_terminal(doc, status.get("capture"))))
                if not source_matches or doc.get("source") != subject and not equivalent:
                    row.update(state="blocked", reason={"source": "queue", "category": "identity", "code": "receipt-source"})
                elif (doc.get("counted") is True and doc.get("classification", {}).get("counted") is True
                      and doc.get("classification", {}).get("outcome") == "completed"
                      and doc.get("outcome") in {"terminal-clean", "terminal-with-findings", "partial-scope"}):
                    row["state"] = "consumed" if entry and entry.get("consumed") == status["receipt_id"] else ("reused" if status.get("reused_from") else "reviewed")
                    if project_fixed:
                        row.update(reviewed=True, consumed=bool(entry and entry.get("consumed") == status["receipt_id"]),
                                   fixed=receipts.remediation_fixed(item, doc, status["receipt_id"]))
                        if row["fixed"]:
                            row["remediation"] = receipts.remediation_summary(item)
                            if not row["consumed"]:
                                row["state"] = "fixed"
                elif doc.get("outcome") in {"no-current-code", "partial-scope", "unsupported"}:
                    row["state"] = doc["outcome"]
                elif doc.get("outcome") == "blocked-secret-scan":
                    # Same row facts as status: a scan block outranks the
                    # vendor/unclassified fallback below.
                    row.update(state="blocked", reason={"source": "queue", "category": "scan",
                                                        "code": "blocked-secret-scan"})
                else:
                    row.update(state="blocked", reason={"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"}
                               if _vendor_rate_limit(doc) else {"source": "queue", "category": "unknown", "code": "unclassified"})
            elif status["state"] not in {"pending", "reviewing"}:
                row.update(state="blocked", reason={"source": "queue", "category": "unknown", "code": "no-receipt"})
            break
        rows.append(row)
    rows.sort(key=lambda row: (row["pr"] or 0, row["mergeSha"] or ""))
    selected = [row for row in rows if req["states"] is None or row["state"] in req["states"]
                or any(row.get(fact) is True and fact in req["states"] for fact in ("reviewed", "consumed", "fixed"))]
    digest = receipts.digest({"principal": principal, "binding": b, "checkpoint": cp["digest"],
                              "states": req["states"], "entries": selected})
    start = 0
    if req["cursor"] is not None:
        match = re.fullmatch(re.escape(digest) + r":(0|[1-9][0-9]{0,5})", req["cursor"])
        if not match or int(match[1]) >= len(selected):
            return {"error": {"code": "stale-cursor", "retryable": False, "restart": True}}
        start = int(match[1])
    end = min(start + req["limit"], len(selected))
    if json.loads(path.read_text()) != raw:
        return {"error": {"code": "busy", "retryable": True}}
    return {"entries": selected[start:end], "terminal": end == len(selected),
            "nextCursor": None if end == len(selected) else digest + ":" + str(end),
            "snapshot": digest,
            "proof": {"checkpoint": cp["digest"], "completeThrough": cp["before"],
                      "count": len(rows), "digest": digest, "selectedCount": len(selected),
                      "intervalConvention": "(after,before]"}}

def decode(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_BYTES:
        raise ValueError("queue request exceeds bound")
    try:
        request = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs)
    except RecursionError:
        # Deeply nested JSON: a malformed request, not a caller-visible crash.
        raise ValueError("queue request nesting exceeds bound") from None
    if not isinstance(request, dict) or type(request.get("v")) is not int or request["v"] != 1:
        raise ValueError("unsupported queue protocol")
    op = request.get("op")
    if type(op) is not str:
        # An unhashable op would otherwise reach the `extra` dict lookup as a
        # TypeError; direct callers see one exception type for malformed input.
        raise ValueError("invalid queue operation/fields")
    if op == "health":
        if set(request) != {"v", "op", "requestId", "binding"} or not _match(TOKEN, request["requestId"]):
            raise ValueError("invalid health fields")
        _health_binding(request["binding"])
        return request
    if op == "inventory":
        if set(request) != {"v", "op", "requestId", "binding", "cursor", "limit", "states"}:
            raise ValueError("invalid inventory fields")
        _inventory_binding(request["binding"])
        if (not _match(TOKEN, request["requestId"]) or type(request["limit"]) is not int
                or not 1 <= request["limit"] <= 10
                or request["cursor"] is not None and not isinstance(request["cursor"], str)
                or request["states"] is not None and (type(request["states"]) is not list
                    or any(state not in {"pending", "reviewed", "reused", "no-current-code", "partial-scope", "unsupported", "consumed", "fixed", "blocked", "missing"}
                           for state in request["states"]))):
            raise ValueError("invalid inventory pagination/filter")
        if request["states"] is not None:
            request["states"] = sorted(set(request["states"]))
        return request
    extra = {"retry": {"expectedReceiptId"}, "bind": {"pr", "mergeSha"}, "report": {"receiptId", "cursor"},
             "ack": {"receiptId", "sha256", "chunks", "bytes"}}.get(op, set())
    if op not in READ | WRITE or set(request) != {"v", "op", "requestId", "binding"} | extra:
        raise ValueError("invalid queue operation/fields")
    if not _match(TOKEN, request["requestId"]):
        raise ValueError("invalid request id")
    binding(request["binding"])
    if op == "bind" and (type(request["pr"]) is not int or request["pr"] <= 0 or
                         request["mergeSha"] is not None and not _match(SHA, request["mergeSha"])):
        raise ValueError("invalid PR binding")
    if op == "retry" and not _match(r"[0-9a-f]{64}", request["expectedReceiptId"]):
        raise ValueError("retry requires expected receipt")
    return request


def _forge(verify_source, b, pr, merge_sha, policy):
    """Trusted adapter fetches forge metadata; compare every authorization binding."""
    actual = verify_source(b["repo"], pr)
    if not isinstance(actual, dict) or actual.get("repo") != b["repo"] or actual.get("pr") != pr:
        raise ValueError("forge repository/PR mismatch")
    if actual.get("target") not in policy.get("branches", []):
        raise ValueError("forge target branch denied")
    if b["kind"] == "deferred-author" and any(actual.get(k) != b[k] for k in ("producer", "head", "target")):
        raise ValueError("forge producer/head/target mismatch")
    if merge_sha is not None and (actual.get("mergeSha") != merge_sha or actual.get("state") != "MERGED"):
        raise ValueError("forge merge mismatch")


def _queue_generation(path):
    stat = path.stat()
    return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns]


READ_SLOTS = 2
FORGE_CACHE_TTL = 300
FORGE_CACHE_LIMIT = 128


@contextlib.contextmanager
def _read_slot(root):
    """Cross-process admission before queue loading; never acquire tick.lock."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    with contextlib.ExitStack() as stack:
        for index in range(READ_SLOTS):
            slot = stack.enter_context((root / f"read-slot-{index}.lock").open("a"))
            try:
                fcntl.flock(slot, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            yield True
            return
        yield False


def _atomic_json(path, value):
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(receipts.canonical(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _cached_forge(root, principal, rid, b, verify_source, policy):
    """Cache only successful exact-binding checks; ACL and queue checks precede this."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    path = root / "read-forge-cache.json"
    key = receipts.digest({"principal": principal, "requestId": rid, "binding": b,
                           "branches": policy.get("branches", [])})
    def current():
        now = time.time()
        cache = json.loads(path.read_text()) if path.exists() else {}
        return now, {k: stamp for k, stamp in cache.items() if 0 <= now - stamp < FORGE_CACHE_TTL}

    lock_path = root / "read-forge-cache.lock"
    with lock_path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        _, cache = current()
        if key in cache:
            return
    # Network latency must not hold up unrelated reconciled reads. Concurrent
    # misses may fetch the same binding; only successful checks are inserted.
    _forge(verify_source, b, b["pr"], b["mergeSha"], policy)
    with lock_path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        now, cache = current()
        if key in cache:
            return
        if len(cache) >= FORGE_CACHE_LIMIT:
            del cache[min(cache, key=cache.get)]
        cache[key] = now
        _atomic_json(path, cache)


def _enroll(q, b, request_id, pr, merge_sha, at):
    receipts.enroll(q, repo=b["repo"], pr=pr, merge_sha=merge_sha, request_id=request_id,
                    at=at, target_selector=b["targetSelector"])


def _status(q, request_id, entry):
    current = q.get("merged_current_requests", {}).get(request_id)
    item = receipts.status(q, request_id) if current else None
    state = entry["state"]
    receipt_id = item["receipt_id"] if item else None
    if item:
        state = {"pending": "pending", "reviewing": "reviewing", "blocked": "blocked"}.get(item["state"], "blocked")
        if item.get("reused_from"):
            state = "reused"
        # Terminal truth is read from the immutable receipt in handle, never a done label.
    reason = entry.get("reason")
    if reason is not None:
        reason = ({"source": "queue", "category": "identity", "code": "forge-identity"}
                  if reason == {"source": "queue", "category": "identity", "code": "forge-identity"}
                  else {"source": "queue", "category": "unknown", "code": "persisted-reason"})
        state = "blocked"
    return {"state": state, "pr": entry.get("pr"), "mergeSha": entry.get("mergeSha"),
            "itemId": item["item_id"] if item else None, "receiptId": receipt_id,
            "consumed": receipt_id is not None and entry.get("consumed") == receipt_id,
            "reviewed": False, "fixed": False, "reason": reason, "enqueued": item is not None,
            "reusedFrom": item.get("reused_from") if item else None,
            "receiptSource": None, "receiptEquivalence": None}


def _vendor_rate_limit(document):
    """Only a complete all-causes proof can authorize vendor-only continuation.

    The producer sources rate_limit only from exact errorType + recoverable=True.
    Legacy outcomes/messages and missing or mixed causes convey no authority.
    """
    cls = document.get("classification")
    if (document.get("outcome") != "rate_limited" or document.get("counted") is not False
            or type(cls) is not dict or cls.get("outcome") != "rate_limited"
            or cls.get("counted") is not False or type(cls.get("exit")) is not int
            or cls["exit"] not in (0, 1) or type(cls.get("bad_lines")) is not int
            or cls["bad_lines"] != 0):
        return False
    proof = cls.get("failure_provenance")
    if (type(proof) is not dict or set(proof) != {"version", "complete", "causes"}
            or type(proof.get("version")) is not int or proof["version"] != 1
            or proof.get("complete") is not True or type(proof.get("causes")) is not list
            or not proof["causes"]):
        return False
    allowed = {"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"}
    return all(type(cause) is dict and cause == allowed for cause in proof["causes"])


def _retry_transient(document):
    if _vendor_rate_limit(document):
        return "vendor-rate-limited"
    cls = document.get("classification")
    if (type(cls) is not dict or document.get("counted") is not False
            or cls.get("counted") is not False or document.get("outcome") != cls.get("outcome")
            or cls.get("outcome") not in {"error", "interrupted"}
            or type(cls.get("bad_lines")) is not int or cls["bad_lines"] != 0
            or type(cls.get("exit")) is not int):
        return None
    typed = cls.get("retry_transient")
    if (type(typed) is not dict or set(typed) != {"version", "category"}
            or type(typed.get("version")) is not int or typed["version"] != 1):
        return None
    category = typed.get("category")
    allowed = {"transport": (0, 1), "timeout": (124,), "interrupted": (-2, -9, -15, 130, 137, 143)}
    if type(category) is not str or category not in allowed or cls["exit"] not in allowed[category]:
        return None
    proof = cls.get("failure_provenance")
    if (type(proof) is not dict or type(proof.get("version")) is not int or proof["version"] != 1
            or proof.get("complete") is not True or type(proof.get("causes")) is not list
            or not proof["causes"]):
        return None
    codes = {"network_error", "transport_error", "unexpected-exit"} if category == "transport" else {"unexpected-exit", "nonterminal-review"}
    if not all(type(c) is dict and set(c) == {"source", "category", "code"}
               and c["source"] == "queue" and c["category"] == "unknown" and type(c["code"]) is str and c["code"] in codes
               for c in proof["causes"]):
        return None
    if category == "transport" and not any(c["code"] in {"network_error", "transport_error"} for c in proof["causes"]):
        return None
    return category


def _request_alias(q, req, entry, document, receipt_id):
    """Project identity only from authenticated locked state and verified bytes.

    Original requests and explicit equivalent reuse keep their separate paths.
    No principal comparison for the original: it may have been enrolled by Q1.
    """
    maps = q.get("merged_current_requests")
    if type(maps) is not dict:
        raise ValueError("invalid alias request mappings")
    alias = maps.get(req["requestId"])
    if type(alias) is not dict or set(alias) != {"binding", "item"}:
        raise ValueError("missing alias request mapping")
    items = [item for item in q["items"] if item.get("id") == alias["item"]]
    if len(items) != 1:
        raise ValueError("alias requires unique item")
    item = items[0]
    if item.get("reused_from"):
        return None
    if item.get("request_id") == req["requestId"]:
        return None
    subject = alias.get("binding")
    b = req["binding"]
    expected = {"repo": b["repo"], "pr": entry.get("pr"), "merge_sha": entry.get("mergeSha"),
                "target_selector": b["targetSelector"], "policy": receipts.POLICY}
    original = item.get("request_id")
    if (not _match(TOKEN, original) or original == req["requestId"] or subject != expected
            or maps.get(original) != alias or item.get("subject") != subject
            or item.get("kind") != receipts.KIND
            or item.get("id") != "current-" + receipts.digest(subject)[:32]
            or item.get("pr") != subject["pr"] or item.get("merge_commit") != subject["merge_sha"]
            or document.get("request_id") != original or document.get("item_id") != item["id"]
            or document.get("source") != subject or item.get("receipt_id") != receipt_id):
        raise ValueError("invalid alias item/source/original binding")
    retained = document.get("capture")
    capture = item.get("capture")
    equivalence = receipts.current_equivalence(retained)
    if (receipts.current_equivalence(capture) != equivalence
            or retained.get("equivalence") != equivalence or capture.get("equivalence") != equivalence):
        raise ValueError("alias capture equivalence mismatch")
    return {"v": 1, "reference": {"requestId": req["requestId"], "binding": b},
            "originalRequestId": original, "itemId": item["id"],
            "source": {"kind": "merged-current", "repo": subject["repo"], "pr": subject["pr"],
                       "mergeSha": subject["merge_sha"], "targetSelector": subject["target_selector"]},
            "policy": receipts.POLICY, "receiptId": receipt_id, "receiptEquivalence": equivalence}


def authorize(req, principal, policy):
    b, op, rid = req["binding"], req["op"], req["requestId"]
    allowed = policy.get("write" if op in WRITE else "read", [])
    if principal not in allowed or b["repo"] != policy.get("repo") or b["targetSelector"] not in policy.get("targets", []):
        raise ValueError("queue capability denied")
    if op == "health" and {"principal": principal, "binding": b} not in policy.get("health_reads", []):
        raise ValueError("health capability denied")

    if op in {"retry", "retry-capability"} and not any(g["principal"] == principal and g["requestId"] == rid and g["binding"] == b for g in policy.get("transient_retries", [])):
        raise ValueError("transient retry capability denied")
    if op == "inventory" and {"principal": principal, "binding": b} not in policy.get("inventory_reads", []):
        raise ValueError("inventory capability denied")
    if op not in {"inventory", "health"} and b["kind"] == "deferred-author" and b["target"] not in policy.get("branches", []):
        raise ValueError("target branch denied")


def handle(raw, runner, *, principal, policy, verify_source, receipt_root):
    policy = validate_policy(policy)
    req = decode(raw)
    try:
        authorize(req, principal, policy)
    except ValueError:
        if req["op"] == "retry-capability":
            return _encode(req, {"denied": "no-permission"})
        raise
    b, op, rid = req["binding"], req["op"], req["requestId"]
    if policy.get("enabled") is not True:
        return _encode(req, {"unsupported": "Reviewed D1C queue-v1 activation required"})

    if op == "retry-capability":
        return _encode(req, {"retry": 1})

    project_fixed = (getattr(runner, "CONFIG", {}).get("queue") or {}).get("project_fixed") is True
    read_only = op in READ or op == "inventory"

    def locked():
        # Work on a copy so rejected requests cannot leak partial mutations to test runners.
        queue_path = getattr(runner, "QUEUE", None)
        generation = _queue_generation(queue_path) if read_only and queue_path is not None else None
        q = runner.load_queue()
        if not read_only:
            q = copy.deepcopy(q)
        if type(q) is not dict:
            raise ValueError("invalid queue object")
        snapshot_id = receipts.digest({"principal": principal, "queue":
            generation if generation is not None else q}) if read_only else None
        def encode(result):
            if read_only:
                result = {"snapshot": snapshot_id, **result}
            if generation is not None and _queue_generation(queue_path) != generation:
                return _encode(req, {"error": {"code": "busy", "retryable": True}})
            return _encode(req, result)
        if op == "health":
            import client_health
            return encode(client_health.snapshot(q))
        if op == "inventory":
            return encode(_inventory(req, runner, q, principal, receipt_root, project_fixed=project_fixed))
        entries = q.setdefault("queue_client_requests", {})
        if type(entries) is not dict:
            raise ValueError("invalid queue client requests")
        entry = entries.get(rid)
        if rid in entries and type(entry) is not dict:
            raise ValueError("invalid queue client entry")
        if entry is not None and (entry.get("binding") != b or entry.get("principal") != principal):
            raise ValueError("request binding or principal mismatch")
        if op in READ | {"ack"} and principal in policy.get("read", []) and entry is None and any(
                grant == {"principal": principal, "requestId": rid, "binding": b}
                for grant in policy.get("reconciled_reads", [])):
            # Adopt only an existing exact subject; never call enroll or dispatch.
            subject = {"repo": b["repo"], "pr": b["pr"], "merge_sha": b["mergeSha"],
                       "target_selector": b["targetSelector"], "policy": receipts.POLICY}
            mappings = q.get("merged_current_requests", {})
            queue_items = q.get("items")
            if (type(mappings) is not dict or type(queue_items) is not list
                    or any(type(item) is not dict for item in queue_items)):
                raise ValueError("invalid reconciled queue mappings/items")
            mapping = mappings.get(rid)
            item_id = "current-" + receipts.digest(subject)[:32]
            items = [item for item in queue_items if item.get("id") == item_id]
            if (mapping != {"binding": subject, "item": item_id} or len(items) != 1
                    or items[0].get("subject") != subject or items[0].get("kind") != receipts.KIND
                    or items[0].get("pr") != b["pr"] or items[0].get("merge_commit") != b["mergeSha"]):
                raise ValueError("reconciled request/source mismatch")
            if len(entries) >= policy.get("max_requests", 10000):
                raise ValueError("queue request capacity refused")
            _cached_forge(receipt_root, principal, rid, b, verify_source, policy)
            entry = {"binding": b, "principal": principal, "state": "ready-current",
                     "pr": b["pr"], "mergeSha": b["mergeSha"], "createdAt": runner.iso()}
            entries[rid] = entry
        if op == "enqueue" and entry is None:
            limit = policy.get("max_requests", 10000)
            if type(limit) is not int or not 1 <= limit <= 100000 or len(entries) >= limit:
                raise ValueError("queue request capacity refused")
            entry = {"binding": b, "principal": principal, "state": "awaiting-pr", "createdAt": runner.iso()}
            if b["kind"] == "merged-current":
                _forge(verify_source, b, b["pr"], b["mergeSha"], policy)
                _enroll(q, b, rid, b["pr"], b["mergeSha"], runner.iso())
                entry.update(pr=b["pr"], mergeSha=b["mergeSha"], state="ready-current")
            entries[rid] = entry
        if entry is None:
            raise ValueError("unknown queue request")
        if op == "retry":
            expected = req["expectedReceiptId"]
            result = {"action": "needs-human", "accepted": False, "reason": "not-transient"}
            mapping = q.get("merged_current_requests", {}).get(rid, {})
            items = [i for i in q.get("items", []) if i.get("id") == mapping.get("item")]
            if b["kind"] == "deferred-author":
                result["reason"] = "author-dispatch"
            elif len(items) == 1:
                item = items[0]
                if any(a.get("receipt_id") == expected and a.get("retry_requested") is True
                       for a in item.get("attempts", [])):
                    result = {"action": "already-accepted", "accepted": False, "reason": "durable-replay"}
                elif entry.get("retry_count", 0) >= next(g.get("maxRetries", 3) for g in policy["transient_retries"]
                        if g["principal"] == principal and g["requestId"] == rid and g["binding"] == b):
                    result["reason"] = "retry-limit"
                elif (entry.get("consumed") or item.get("consumed") or any(
                        entries.get(alias_id, {}).get("consumed")
                        for alias_id, alias in q.get("merged_current_requests", {}).items()
                        if alias.get("item") == item.get("id"))):
                    result["reason"] = "consumed"
                elif (item.get("receipt_id") == expected and item.get("kind") == receipts.KIND
                      and item.get("state") == "blocked" and not entry.get("reason")):
                    document = _ReceiptSnapshot(receipt_root, expected).document
                    run = item.get("run")
                    attempts = item.get("attempts", [])
                    if not attempts or attempts[-1].get("receipt_id") != expected:
                        return _encode(req, {**result, "reason": "ambiguous-lineage"})
                    if run is None and attempts and attempts[-1].get("receipt_id") == expected:
                        run = {"run_id": attempts[-1].get("run_id")}
                        if _match(TOKEN, run["run_id"]) and hasattr(runner, "RUNS") and hasattr(runner, "read_pidfile"):
                            identity = runner.read_pidfile(runner.RUNS / run["run_id"]) or {}
                            run["pid"] = identity.get("pid")
                    transient = _retry_transient(document)
                    if document.get("source") != item.get("subject") or not transient:
                        result["reason"] = "not-transient"
                    elif (not isinstance(run, dict) or not _match(TOKEN, run.get("run_id"))
                          or not hasattr(runner, "RUNS") or not hasattr(runner, "run_liveness")):
                        result["reason"] = "ambiguous-owner"
                    else:
                        rdir = runner.RUNS / run["run_id"]
                        if not (rdir / "exit.json").is_file() or runner.run_liveness(rdir, item, run, True) != "harvest":
                            result["reason"] = "live-or-ambiguous-owner"
                        else:
                            attempts[-1]["retry_requested"] = True
                            entry["retry_count"] = entry.get("retry_count", 0) + 1
                            item.update(state="pending", run=None)
                            item.pop("receipt_id", None)
                            result = {"action": "accepted", "accepted": True, "reason": transient}
            runner.save_queue(q)
            return _encode(req, result)
        if op == "bind":
            if b["kind"] != "deferred-author" or entry["state"] == "cancelled":
                raise ValueError("intent cannot be bound")
            pr, merge_sha = req["pr"], req["mergeSha"]
            if entry.get("pr", pr) != pr or (merge_sha is not None and entry.get("mergeSha") not in (None, merge_sha)):
                raise ValueError("conflicting PR/merge binding")
            # A lost PR-only response may be replayed after merged recovery.
            # Revalidate the established merge without downgrading durable state.
            _forge(verify_source, b, pr, merge_sha or entry.get("mergeSha"), policy)
            entry.pop("reason", None)
            if entry.get("mergeSha") is None:
                entry.update(pr=pr, state="awaiting-merge")
            if merge_sha is not None:
                _enroll(q, b, rid, pr, merge_sha, runner.iso())
                entry.update(mergeSha=merge_sha, state="ready-current")
        if op == "cancel":
            if rid in q.get("merged_current_requests", {}):
                raise ValueError("enrolled current work cannot be cancelled through deferred intent")
            entry["state"] = "cancelled"
        result = _status(q, rid, entry)
        receipt_id = result["receiptId"]
        if receipt_id:
            item = receipts.status(q, rid, project_fixed=project_fixed)
            # Bounded status excludes capture/paths/findings. Full document goes through chunks.
            snapshot = _ReceiptSnapshot(receipt_root, receipt_id)
            document = snapshot.document
            source = document.get("source", {})
            if source.get("repo") != b["repo"] or source.get("target_selector") != b["targetSelector"]:
                raise ValueError("receipt source repository/target mismatch")
            if source.get("pr") != entry.get("pr") or source.get("merge_sha") != entry.get("mergeSha"):
                if not item.get("reused_from") or not (receipts.reusable_current(document, item.get("capture"))
                                                      or receipts.reusable_noncounted_terminal(document, item.get("capture"))):
                    raise ValueError("receipt source mismatch without proven equivalent reuse")
            result["receiptSource"] = {"kind": "merged-current", "repo": source["repo"], "pr": source["pr"],
                                       "mergeSha": source["merge_sha"], "targetSelector": source["target_selector"]}
            result["receiptEquivalence"] = document.get("capture", {}).get("equivalence")
            outcome = document.get("outcome")
            counted = document.get("counted", False)
            classification = document.get("classification")
            result["reviewed"] = counted is True and isinstance(classification, dict) and classification.get("counted") is True and classification.get("outcome") == "completed" and outcome in {"terminal-clean", "terminal-with-findings", "partial-scope"}
            result["state"] = ("reused" if item.get("reused_from") else outcome) if result["reviewed"] else {
                "no-current-code": "no-current-code", "partial-scope": "partial-scope", "unsupported": "unsupported"}.get(outcome, "blocked")
            result["fixed"] = project_fixed and receipts.remediation_fixed(item, document, receipt_id)
            if result["fixed"]:
                result["remediation"] = receipts.remediation_summary(item)
            if result["state"] == "blocked":
                # Never upgrade a lossy first-error outcome into vendor authority.
                result["reason"] = ({"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"}
                                    if _vendor_rate_limit(document) else
                                    {"source": "queue", "category": "unknown", "code": "unclassified"})
        elif result["state"] == "blocked" and result["reason"] is None:
            result["reason"] = {"source": "queue", "category": "unknown", "code": "no-receipt"}
        if entry.get("reason") is not None:
            persisted = _status(q, rid, entry)
            result.update(state="blocked", reviewed=False, fixed=False, reason=persisted["reason"])
            result.pop("remediation", None)
            if op in {"report", "ack"}:
                raise ValueError("source revalidation required before receipt consumption")
        elif receipt_id and result["state"] == "blocked" and document.get("outcome") == "blocked-secret-scan":
            result["reason"] = {"source": "queue", "category": "scan", "code": "blocked-secret-scan"}
        if receipt_id and entry.get("reason") is None:
            alias = _request_alias(q, req, entry, document, receipt_id)
            if alias is not None:
                result["requestAlias"] = alias
        if op in {"report", "ack"}:
            if not receipt_id or req["receiptId"] != receipt_id:
                raise ValueError("receipt/request mismatch")
            manifest = snapshot.page()
            progress = entry.setdefault("deliveries", {}).setdefault(receipt_id, {"manifest": False, "next": 0})
            journal = Path(receipt_root) / "deliveries" / (receipts.digest(
                {"principal": principal, "requestId": rid, "binding": b, "receiptId": receipt_id}) + ".json")
            journal.parent.mkdir(exist_ok=True)
            if journal.exists():
                progress = json.loads(journal.read_text())
            if op == "report":
                page = snapshot.page(req["cursor"])
                if page["kind"] == "manifest":
                    progress["manifest"] = True
                else:
                    if not progress["manifest"] or page["index"] > progress["next"]:
                        raise ValueError("out-of-order receipt delivery")
                    progress["next"] = max(progress["next"], page["index"] + 1)
                # A separate, short journal lock never acquires or blocks tick.lock.
                with (journal.parent / "delivery.lock").open("a") as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX)
                    if journal.exists():
                        previous = json.loads(journal.read_text())
                        progress["manifest"] |= previous["manifest"]
                        progress["next"] = max(progress["next"], previous["next"])
                    _atomic_json(journal, progress)
                result = {"page": page}
            else:
                if not progress["manifest"] or progress["next"] != manifest["chunks"] or any(req[k] != manifest[k] for k in ("sha256", "chunks", "bytes")):
                    raise ValueError("complete verified receipt required before acknowledgement")
                entry["consumed"] = receipt_id
                result["consumed"] = True
        encoded = encode(result)
        if not read_only:
            runner.save_queue(q)
        return encoded

    with contextlib.redirect_stdout(io.StringIO()):
        if read_only:
            with _read_slot(receipt_root) as admitted:
                result = locked() if admitted else None
        else:
            result = runner.with_lock(locked)
    if not isinstance(result, bytes):
        return _encode(req, {"error": {"code": "busy", "retryable": True}})
    return result


def _encode(req, result):
    raw = receipts.canonical({"v": 1, "requestId": req["requestId"], "binding": req["binding"], "result": result}) + b"\n"
    if len(raw) > MAX_BYTES:
        raise ValueError("queue response exceeds wire bound")
    return raw
