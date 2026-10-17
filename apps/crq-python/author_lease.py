"""Opt-in author lease arbitration. All mutations require crq's tick.lock.

No processes or IO here. A queue grant is persisted with the existing launch
reservation; an agent grant is persisted before returning a one-shot dispatch
permission. Neither grant expires or changes issuer after the decision.
"""
import datetime as dt

from author_quota import AuthorRefused, _timestamp, _iso, binding_of


def new_lease(policy, reviewer, *, at):
    review = policy.get("review") if isinstance(policy, dict) else None
    timeout = review.get("reviewerTimeoutMin") if isinstance(review, dict) else None
    if type(timeout) is not int or timeout <= 0:
        raise AuthorRefused("review.reviewerTimeoutMin must be a positive integer")
    if not isinstance(reviewer, str) or not reviewer.strip() or len(reviewer) > 256 or any(
            ord(c) < 32 for c in reviewer):
        raise AuthorRefused("fallback reviewer must be configured explicitly")
    requested = _timestamp("requested_at", at)
    try:
        deadline = requested + dt.timedelta(minutes=timeout)
    except OverflowError as exc:
        raise AuthorRefused("review.reviewerTimeoutMin is out of range") from exc
    return {"v": 1, "state": "waiting", "requested_at": at,
            "deadline_at": _iso(deadline), "reviewerTimeoutMin": timeout,
            "reviewer": reviewer}


def read(item):
    """Absent means legacy; malformed/present or unknown versions refuse."""
    if "author_lease" not in item:
        return None
    lease = item["author_lease"]
    if not isinstance(lease, dict) or type(lease.get("v")) is not int or lease["v"] != 1:
        raise AuthorRefused("unsupported author_lease version")
    expected = new_lease({"review": {"reviewerTimeoutMin": lease.get("reviewerTimeoutMin")}},
                         lease.get("reviewer"), at=lease.get("requested_at"))
    if lease.get("deadline_at") != expected["deadline_at"]:
        raise AuthorRefused("author_lease deadline does not match its policy")
    if lease.get("state") not in ("waiting", "queue", "agent"):
        raise AuthorRefused("unknown author_lease state")
    if "secret_scan_blocked" in lease and lease["secret_scan_blocked"] is not True:
        raise AuthorRefused("invalid author_lease secret-scan marker")
    if lease["state"] != "waiting":
        decided = _timestamp("decided_at", lease.get("decided_at"))
        deadline = _timestamp("deadline_at", lease["deadline_at"])
        if decided < _timestamp("requested_at", lease["requested_at"]) or (
                lease["state"] == "queue" and decided >= deadline) or (
                lease["state"] == "agent" and decided < deadline):
            raise AuthorRefused("invalid author_lease decision time")
    return lease


def check_queue(item, *, at):
    lease = read(item)
    if lease is None:
        return
    if lease.get("secret_scan_blocked"):
        raise AuthorRefused("author lease permanently blocked by secret scan")
    if item.get("state") != "pending" or item.get("run") or item.get("attempts"):
        raise AuthorRefused("author request is not an unstarted pending admission")
    current = _timestamp("at", at)
    if current < _timestamp("requested_at", lease["requested_at"]):
        raise AuthorRefused("author lease clock moved backwards")
    if lease["state"] != "waiting":
        raise AuthorRefused("author lease already assigned; no replay")
    if current >= _timestamp("deadline_at", lease["deadline_at"]):
        raise AuthorRefused("author lease deadline passed; queue grant refused")


def grant_queue(item, *, at):
    check_queue(item, at=at)
    if "author_lease" in item:
        item["author_lease"].update(state="queue", decided_at=at)


def find(q, request_id):
    entry = q.get("author_requests", {}).get(request_id)
    if not isinstance(entry, dict):
        raise AuthorRefused("unknown author request")
    item = next((i for i in q.get("items", []) if i.get("id") == entry.get("item")), None)
    if item is None or item.get("kind") != "author" or (
            item.get("author", {}).get("request_id") != request_id or
            binding_of(item.get("author", {})) != binding_of(entry)):
        raise AuthorRefused("author request/item binding mismatch")
    if read(item) is None:
        raise AuthorRefused("legacy author request has no lease")
    return item


def decision(item, *, dispatch=False):
    lease = read(item)
    return {"v": 1, "request_id": item["author"]["request_id"],
            "binding": dict(item["author"]), "issuer": lease["state"],
            "reviewer": lease["reviewer"] if lease["state"] == "agent" else None,
            "deadline_at": lease["deadline_at"], "decided_at": lease.get("decided_at"),
            "dispatch": dispatch}


def fallback(q, request_id, *, at):
    """Return dispatch=True only for the first waiting -> agent transition.

    Caller MUST persist before exposing the permission. A repeated/lost response
    is never another dispatch permission. A waiting status alone is not consent.
    """
    item = find(q, request_id)
    lease = read(item)
    if lease.get("secret_scan_blocked"):
        raise AuthorRefused("author lease permanently blocked by secret scan")
    if lease["state"] != "waiting":
        return decision(item)
    if _timestamp("at", at) < _timestamp("deadline_at", lease["deadline_at"]):
        raise AuthorRefused("author fallback before lease deadline")
    if item.get("state") != "pending" or item.get("run") or item.get("attempts"):
        raise AuthorRefused("author request is not an unstarted pending admission")
    lease.update(state="agent", decided_at=at)
    # Tombstone the queue item as well as the lease. Manual requeue cannot bypass
    # check_queue: issuer decisions are permanent, including after restart.
    item["state"] = "skipped"
    return decision(item, dispatch=True)
