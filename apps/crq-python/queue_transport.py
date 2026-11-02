"""Authorized queue-v1 capability. Caller supplies identity/policy, never JSON.

No reviewer starts, credentials, shell commands or author-grant mutations.
Runner owns tick lock/load/save; Q1 owns immutable receipt storage.
"""
import base64
import contextlib
import copy
import io
import hashlib
from pathlib import Path
import json
import re

import review_receipt as receipts

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
READ = {"status", "report"}
WRITE = {"enqueue", "bind", "cancel", "ack"}


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
    def __init__(self, root, receipt_id):
        if not _match(r"[0-9a-f]{64}", receipt_id):
            raise ValueError("invalid receipt id")
        with (Path(root) / (receipt_id + ".json")).open("rb") as stream:
            self.data = stream.read(MAX_RECEIPT_BYTES + 1)
        if len(self.data) > MAX_RECEIPT_BYTES:
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
    for key in ("read", "write", "targets", "branches"):
        values = policy.get(key, [])
        if type(values) is not list or any(type(value) is not str or not value for value in values):
            raise ValueError("invalid queue policy allowlist")
    if any(target not in receipts.SELECTORS for target in policy.get("targets", [])):
        raise ValueError("invalid queue policy target")
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
    if set(value) != common | fields or value.get("kind") not in {"deferred-author", "merged-current"}:
        raise ValueError("invalid binding fields")
    if not _match(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", value["repo"]) or value["targetSelector"] not in receipts.SELECTORS:
        raise ValueError("invalid repository or target selector")
    if value["kind"] == "deferred-author":
        if (not _match(TOKEN, value["producer"]) or not _match(SHA, value["head"])
                or branch_fault(value["target"]) is not None):
            raise ValueError("invalid producer/head/target")
    elif type(value["pr"]) is not int or value["pr"] <= 0 or not _match(SHA, value["mergeSha"]):
        raise ValueError("invalid merged source")
    return value


def decode(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_BYTES:
        raise ValueError("queue request exceeds bound")
    request = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs)
    if not isinstance(request, dict) or type(request.get("v")) is not int or request["v"] != 1:
        raise ValueError("unsupported queue protocol")
    op = request.get("op")
    extra = {"bind": {"pr", "mergeSha"}, "report": {"receiptId", "cursor"},
             "ack": {"receiptId", "sha256", "chunks", "bytes"}}.get(op, set())
    if op not in READ | WRITE or set(request) != {"v", "op", "requestId", "binding"} | extra:
        raise ValueError("invalid queue operation/fields")
    if not _match(TOKEN, request["requestId"]):
        raise ValueError("invalid request id")
    binding(request["binding"])
    if op == "bind" and (type(request["pr"]) is not int or request["pr"] <= 0 or
                         request["mergeSha"] is not None and not _match(SHA, request["mergeSha"])):
        raise ValueError("invalid PR binding")
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


def handle(raw, runner, *, principal, policy, verify_source, receipt_root):
    policy = validate_policy(policy)
    req = decode(raw)
    b, op, rid = req["binding"], req["op"], req["requestId"]
    allowed = policy.get("write" if op in WRITE else "read", [])
    if principal not in allowed or b["repo"] != policy.get("repo") or b["targetSelector"] not in policy.get("targets", []):
        raise ValueError("queue capability denied")
    if b["kind"] == "deferred-author" and b["target"] not in policy.get("branches", []):
        raise ValueError("target branch denied")
    if policy.get("enabled") is not True:
        return _encode(req, {"unsupported": "Reviewed D1C queue-v1 activation required"})

    def locked():
        # Work on a copy so rejected requests cannot leak partial mutations to test runners.
        q = copy.deepcopy(runner.load_queue())
        if type(q) is not dict:
            raise ValueError("invalid queue object")
        entries = q.setdefault("queue_client_requests", {})
        if type(entries) is not dict:
            raise ValueError("invalid queue client requests")
        entry = entries.get(rid)
        if rid in entries and type(entry) is not dict:
            raise ValueError("invalid queue client entry")
        if entry is not None and (entry.get("binding") != b or entry.get("principal") != principal):
            raise ValueError("request binding or principal mismatch")
        if op in READ and entry is None and any(
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
            _forge(verify_source, b, b["pr"], b["mergeSha"], policy)
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
            item = receipts.status(q, rid)
            # Bounded status excludes capture/paths/findings. Full document goes through chunks.
            snapshot = _ReceiptSnapshot(receipt_root, receipt_id)
            document = snapshot.document
            source = document.get("source", {})
            if source.get("repo") != b["repo"] or source.get("target_selector") != b["targetSelector"]:
                raise ValueError("receipt source repository/target mismatch")
            if source.get("pr") != entry.get("pr") or source.get("merge_sha") != entry.get("mergeSha"):
                if not item.get("reused_from") or not receipts.reusable_current(document, item.get("capture")):
                    raise ValueError("receipt source mismatch without proven equivalent reuse")
            result["receiptSource"] = {"kind": "merged-current", "repo": source["repo"], "pr": source["pr"],
                                       "mergeSha": source["merge_sha"], "targetSelector": source["target_selector"]}
            result["receiptEquivalence"] = document.get("capture", {}).get("equivalence")
            outcome = document.get("outcome")
            counted = document.get("counted", False)
            classification = document.get("classification")
            result["reviewed"] = counted is True and isinstance(classification, dict) and classification.get("counted") is True and classification.get("outcome") == "completed" and outcome in {"terminal-clean", "terminal-with-findings", "partial-scope"}
            result["state"] = ("reused" if item.get("reused_from") else outcome) if result["reviewed"] else {
                "no-current-code": "no-current-code", "partial-scope": "partial-scope"}.get(outcome, "blocked")
            if result["state"] == "blocked":
                # Never upgrade a lossy first-error outcome into vendor authority.
                result["reason"] = ({"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"}
                                    if _vendor_rate_limit(document) else
                                    {"source": "queue", "category": "unknown", "code": "unclassified"})
        elif result["state"] == "blocked" and result["reason"] is None:
            result["reason"] = {"source": "queue", "category": "unknown", "code": "no-receipt"}
        if entry.get("reason") is not None:
            persisted = _status(q, rid, entry)
            result.update(state="blocked", reviewed=False, reason=persisted["reason"])
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
            if op == "report":
                page = snapshot.page(req["cursor"])
                if page["kind"] == "manifest":
                    progress["manifest"] = True
                else:
                    if not progress["manifest"] or page["index"] > progress["next"]:
                        raise ValueError("out-of-order receipt delivery")
                    progress["next"] = max(progress["next"], page["index"] + 1)
                result = {"page": page}
            else:
                if not progress["manifest"] or progress["next"] != manifest["chunks"] or any(req[k] != manifest[k] for k in ("sha256", "chunks", "bytes")):
                    raise ValueError("complete verified receipt required before acknowledgement")
                entry["consumed"] = receipt_id
                result["consumed"] = True
        encoded = _encode(req, result)
        runner.save_queue(q)
        return encoded

    with contextlib.redirect_stdout(io.StringIO()):
        result = runner.with_lock(locked)
    if not isinstance(result, bytes):
        raise ValueError("queue lock busy; delivery unknown")
    return result


def _encode(req, result):
    raw = receipts.canonical({"v": 1, "requestId": req["requestId"], "binding": req["binding"], "result": result}) + b"\n"
    if len(raw) > MAX_BYTES:
        raise ValueError("queue response exceeds wire bound")
    return raw
