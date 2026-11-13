"""Pure local-review admission. Caller holds tick.lock and persists before reply.

Git resolution and receipt integrity checks belong to the caller. In particular,
completed PR cycles supplied here must already have verified scope and profile.
"""
import copy
import re

import review_operation as operation
from review_receipt import digest

ACTIVE = {"pending", "reviewing"}
STATES = {"pending": "queued", "reviewing": "running", "done": "completed",
          "cancelled": "cancelled"}


def key_digest(inputs, *, repeat=False):
    operation.validate("submit_inputs", inputs)
    if type(repeat) is not bool:
        raise ValueError("repeat must be boolean")
    return digest({"inputs": inputs, "repeat": repeat})


def retry(q, request_id, key):
    """Must run before resolving objects or today's installed profile."""
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", request_id):
        raise ValueError("invalid request id")
    old = q.get("review_requests", {}).get(request_id)
    if old is None:
        return None
    if old["key_digest"] != key:
        raise ValueError("request id has different inputs")
    return status(q, request_id)


def adequate(item):
    return (item.get("state") == "done" and item.get("scope_adequate") is True
            and bool(item.get("receipt_id")))


def status(q, request_id):
    request = q.get("review_requests", {}).get(request_id)
    if request is None:
        raise ValueError("unknown review request")
    result = {"v": 1, "request_id": request_id, "action": "observed",
              "identity": request["identity"]}
    if "notify_status" in request:
        result["notify"] = copy.deepcopy(request["notify_status"])
    item = next(i for i in q["items"] if i["id"] == request["item"])
    if item.get("outcome") == "no-changes":
        return {**result, "action": "no-changes", "state": "completed"}
    result.update(item=item["id"], generation=item["generation"],
                  state=STATES.get(item["state"], "failed"))
    if item.get("receipt_id"):
        result["receipt_id"] = item["receipt_id"]
    if item["state"] not in ACTIVE and not adequate(item):
        result["next_action"] = "resubmit"
    if item.get("wait_reason") or item.get("last_error"):
        result["reason"] = item.get("wait_reason") or item["last_error"]
    if item.get("receipt_unavailable"):
        result.update(next_action="resubmit", reason="receipt-unavailable")
    return result


def admit(q, *, request_id, inputs, resolved, profile, at, repeat=False,
          supersedes=None, notify=None, ancestry_repeat=False,
          verify_receipt=lambda item: True):
    key = key_digest(inputs, repeat=repeat)
    old = retry(q, request_id, key)
    if old is not None:
        return old
    identity = operation.identity(resolved)
    operation.validate("profile", profile)
    if {k: profile[k] for k in ("adapter", "revision")} != resolved["profile"]:
        raise ValueError("stored profile differs from identity")
    candidates = [i for i in q.get("items", []) if i.get("kind") == operation.KIND
                  and operation.equivalent(i.get("identity_inputs"), resolved)]
    generation = max((i["generation"] for i in candidates), default=0) + 1
    binding = dict(v=1, key_digest=key, identity=identity, created_at=at)
    for name, value in (("supersedes", supersedes), ("notify", notify)):
        if value is not None:
            binding[name] = copy.deepcopy(value)
    operation.validate("request", {**binding, "item": "not-yet-assigned"})
    item, action = None, "created"
    if not repeat:
        item = next((i for i in reversed(candidates) if adequate(i) and verify_receipt(i)), None)
        if item:
            action = "reused"
            # The receipt verifies again, so a persisted receipt-unavailable
            # condition from an earlier observed admission is stale.
            item.pop("receipt_unavailable", None)
        else:
            item = next((i for i in reversed(candidates) if i["state"] in ACTIVE), None)
            if item:
                action = "joined"
            elif candidates:
                item, action = candidates[-1], "observed"
    if item is None:
        item = dict(id=f"lr-{identity[:12]}-g{generation}", kind=operation.KIND,
                    repo=resolved["repo"], identity=identity,
                    target=inputs.get("target"),
                    identity_inputs=copy.deepcopy(resolved), profile=copy.deepcopy(profile),
                    generation=generation, repeat_requested=repeat,
                    ancestry_repeat=bool(ancestry_repeat),
                    observers=[], notify=[], state="pending", pr=None,
                    created_at=at, order=max((i.get("order", 0) for i in q.get("items", [])), default=0) + 1,
                    cycles=[], attempts=[], failures=0, depends_on=[])
        q.setdefault("items", []).append(item)
        if resolved["base_tree"] == resolved["head_tree"]:
            item.update(state="done", outcome="no-changes")
    binding["item"] = item["id"]
    # Retain the admission decision so metrics never re-derive create/join/
    # reuse/observed from timestamps (a same-second create ties its item).
    binding["admission_action"] = action
    operation.validate("request", binding)
    q.setdefault("review_requests", {})[request_id] = binding
    if item["state"] in ACTIVE:
        item["observers"].append(request_id)
    if action == "observed" and adequate(item) and not verify_receipt(item):
        # Persist the failed verification: adequate() trusts the stored receipt
        # id, so later status() and retry() responses must keep the recovery cue.
        item["receipt_unavailable"] = True
    result = status(q, request_id)
    return result if result["action"] == "no-changes" else {**result, "action": action}


def cancel(q, request_id):
    request = q.get("review_requests", {}).get(request_id)
    if request is None:
        raise ValueError("unknown review request")
    item = next(i for i in q["items"] if i["id"] == request["item"])
    item["observers"] = [r for r in item.get("observers", []) if r != request_id]
    if "notify_status" in request or "notify" in request:
        import review_notify
        review_notify.update(q, request_id, None, {})
    if not item["observers"] and item["state"] == "pending":
        item["state"] = "cancelled"
    return status(q, request_id)
