"""Bounded at-least-once completion delivery; no network under tick.lock."""
import copy
from datetime import datetime, timedelta, timezone
import re

import review_ledger as ledger

UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
LIMIT = 4
MAX_ATTEMPTS = 5


def destination(value, config):
    if not isinstance(value, dict) or set(value) != {"paseo_agent_id", "paseo_host"}:
        return None
    agent, host = value["paseo_agent_id"], value["paseo_host"]
    section = config.get("notify")
    hosts = section.get("hosts", []) if isinstance(section, dict) else []
    if not isinstance(hosts, list):
        return None
    if (not isinstance(agent, str) or not UUID.fullmatch(agent)
            or (host is not None and (not isinstance(host, str) or host.startswith("-")
                                      or not re.fullmatch(r"[A-Za-z0-9_.:-]+", host)))
            or host not in hosts):
        return None
    return copy.deepcopy(value)


def validation(value, config, required=True):
    return ({"state": "pending" if required else "not-required"} if destination(value, config) else
            {"state": "error", "reason": "unsupported-destination"})


def update(q, request_id, value, config):
    request = q["review_requests"][request_id]
    for row in q.get("review_notify_outbox", {}).values():
        if row["request_id"] == request_id and row["state"] == "pending":
            row["state"] = "withdrawn"
    request.pop("notify", None)
    request["notify_status"] = {"state": "withdrawn"} if value is None else validation(value, config)
    accepted = destination(value, config)
    if accepted:
        request["notify"] = accepted
        delivered = False
        for event_id, event in q.get("review_events", {}).items():
            if event["item"] == request["item"]:
                key = ledger.digest([request_id, event_id, accepted])
                outbox = q.setdefault("review_notify_outbox", {})
                # A repeated destination keeps completed rows; re-sending is not idempotent.
                if outbox.get(key, {}).get("state") == "sent":
                    delivered = True
                    continue
                outbox[key] = dict(v=1, request_id=request_id,
                    event_id=event_id, destination=accepted, state="pending", receipt_id=event["receipt_id"])
        item = next((i for i in q.get("items", []) if i["id"] == request["item"]), None)
        pending = any(row["request_id"] == request_id and row["state"] == "pending"
                      for row in q.get("review_notify_outbox", {}).values())
        if not pending and delivered:
            request["notify_status"] = {"state": "sent"}
        elif item is not None and not pending and request_id not in item.get("observers", []):
            request["notify_status"] = {"state": "not-required"}


def message(row, event):
    return (f"Review request {row['request_id']}: item {event['item']}, state {event['state']}, "
            f"result {row['receipt_id']}. event_id={row['event_id']}. "
            f"cq review.result --requestId {row['request_id']}")


def drain(c, now=None):
    now = now or datetime.now(timezone.utc)
    # Serializes publisher/manual retries independently of the scheduler lock.
    with ledger.locked(c.STATE / "review-notify.lock"):
        selected = []
        def select():
            q = c.load_queue()
            for key, row in q.get("review_notify_outbox", {}).items():
                if len(selected) >= LIMIT:
                    break
                if row["state"] != "pending" or row.get("next_at", "") > now.isoformat():
                    continue
                event = q.get("review_events", {}).get(row["event_id"])
                if event:
                    selected.append((key, copy.deepcopy(row), copy.deepcopy(event)))
            return True
        if c.with_lock(select, lock_wait=1) is not True:
            return 0
        for key, row, event in selected:
            def still_current():
                return c.load_queue().get("review_notify_outbox", {}).get(key) == row
            if c.with_lock(still_current, lock_wait=1) is not True:
                continue
            accepted = destination(row["destination"], c.CONFIG)
            try:
                success = accepted is not None and c.notify(accepted, message(row, event)).get("paseo_send") == 0
            except Exception:
                success = False
            def reconcile():
                q = c.load_queue()
                current = q.get("review_notify_outbox", {}).get(key)
                if current != row:
                    return True
                attempts = row.get("attempts", 0) + 1
                state = "sent" if success else "error" if attempts >= MAX_ATTEMPTS or accepted is None else "pending"
                current.update(state=state, attempts=attempts,
                    next_at=(now + timedelta(minutes=min(240, c.CONFIG.get("error_backoff_min", 5) * 2 ** (attempts - 1)))).isoformat())
                request = q["review_requests"][row["request_id"]]
                if request.get("notify") == row["destination"]:
                    request["notify_status"] = {"state": state}
                    if not success:
                        request["notify_status"]["reason"] = "delivery-failed" if accepted else "unsupported-destination"
                c.save_queue(q)
                return True
            c.with_lock(reconcile, lock_wait=1)
        return len(selected)
