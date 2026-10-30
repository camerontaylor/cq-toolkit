"""Rank-4 lifecycle under the ordinary scheduler lock, with durable families.

Unknown vendor ownership survives all failure/quarantine transitions. Publication
owns scope but no execution slot. Failure counters are per canonical path lineage,
so target/partition changes and successful siblings cannot erase failing debt.
"""
import copy
import datetime as dt
from pathlib import Path

import review_ledger as ledger

KIND = "backfill"
RANK4 = ("coverage", KIND)


def is_execution_owner(item):
    return (item.get("vendor_state") in ("live", "unknown") or bool(item.get("run"))
            or item.get("state") in ("reviewing", "launch-unknown"))


def scope_owner(item):
    return is_execution_owner(item) or item.get("state") in ("pending", "publication-pending")


def units(item):
    # Stable canonical lineage IDs may be supplied by verified rename evidence.
    lineage = item.get("path_lineages", {})
    return sorted({lineage.get(r["path"], r["path"]) for r in item.get("scope", [])})


def history(queue, item):
    families = queue.setdefault("backfill_families", {})
    family = families.setdefault(item["family"], {"failures": 0, "quarantined": False, "next_eligible_at": None})
    scopes = queue.setdefault("backfill_scope_failures", {})
    for unit in units(item):
        scopes.setdefault(unit, {"failures": 0, "quarantined": False, "next_eligible_at": None})
    return [family] + [scopes[u] for u in units(item)]


def enqueue(queue, partition, at):
    ledger.timestamp(at)
    jid = partition["job_id"]
    for item in queue.setdefault("items", []):
        if item.get("job_id") == jid:
            if item.get("scope_digest") != partition["scope_digest"]:
                raise ledger.IntegrityError("job generation scope conflict")
            return item
        if scope_owner(item) and item.get("target") == partition["target"] and item.get("scope_digest") == partition["scope_digest"]:
            return item
    job = {**copy.deepcopy(partition), "id": "backfill-" + partition["subject_id"] + "-g" + str(partition["generation"]), "kind": KIND, "tier": 4,
           "subject_kind": partition.get("subject_kind", partition["kind"]),
           "tier_importance": partition.get("tier_importance", partition.get("tier", "T4")),
           "state": "pending", "vendor_state": "none", "attempt": 0, "failures": 0,
           "created_at": at, "cycles": [], "attempts": [], "notes": [], "pr": (partition.get("prs") or [0])[0]}
    histories = history(queue, job)
    job["family_failures"] = max(h["failures"] for h in histories)
    if any(h["quarantined"] for h in histories):
        job["state"] = "quarantined"
    queue["items"].append(job)
    return job


def eligible(queue, item, at):
    if item.get("state") != "pending" or is_execution_owner(item):
        return False
    current = ledger.timestamp(at)
    try:
        if any(deadline and ledger.timestamp(deadline) > current for deadline in (item.get("not_before"), queue.get("cooldown_until"))):
            return False
    except ValueError:
        return False
    for h in history(queue, item):
        try:
            if h["quarantined"] or h.get("next_eligible_at") and ledger.timestamp(h["next_eligible_at"]) > current:
                return False
        except ValueError:
            return False
    return True


def defer_terminal_quota(queue, item, at, retry_seconds):
    """Q49: retain consumed quota and prior failures while deferring a verified refusal."""
    delay = retry_seconds if type(retry_seconds) is int and retry_seconds > 0 else 3600
    deadline = (ledger.timestamp(at) + dt.timedelta(seconds=delay)).strftime("%Y-%m-%dT%H:%M:%SZ")
    histories = history(queue, item)
    deadlines = [deadline, item.get("not_before"), queue.get("cooldown_until")]
    deadlines += [h.get("next_eligible_at") for h in histories]
    for value in deadlines:
        if value:
            ledger.timestamp(value)
    deadline = max((value for value in deadlines if value), key=ledger.timestamp)
    hold = queue.get("backfill_reservations", {}).get(item.get("attempt_id"))
    if not hold:
        raise ledger.IntegrityError("quota refusal requires retained reservation")
    hold["terminal_at"] = at
    for h in histories:
        h["next_eligible_at"] = deadline
    item.update(vendor_state="terminal", run=None, state="pending", not_before=deadline, last_error="verified quota refusal")
    return deadline


def admission(queue, item, at, observation, ordinary_eligible, *, reserve=True):
    """Caller holds tick.lock; persist reservation before any launch is attempted."""
    now = ledger.timestamp(at)
    reason, effective = None, None
    holds = queue.setdefault("backfill_reservations", {})
    if ordinary_eligible:
        reason = "ordinary-eligible"
    elif not observation or not observation.get("successful"):
        reason = "usage-unknown"
    else:
        age = (now - ledger.timestamp(observation["observed_at"])).total_seconds()
        remaining = observation.get("remaining")
        if age < 0 or age > 60 or type(remaining) is not int or remaining < 0:
            reason = "usage-stale-or-invalid"
        else:
            reflected = set(observation.get("reflected_reservations", []))
            unreflected = [key for key, hold in holds.items() if key not in reflected and hold.get("quota_state") not in ("released", "expired")]
            effective = remaining - len(unreflected)
            if effective < 2:
                reason = "one-slot-reserve"
    inflight = [i for i in queue.get("items", []) if i.get("kind") in RANK4 and is_execution_owner(i)]
    if not reason and len(inflight) >= 2:
        reason = "rank4-inflight-cap"
    decision = {"at": at, "item": item["id"], "ordinary_eligible": bool(ordinary_eligible),
                "observation": copy.deepcopy(observation), "reservations": copy.deepcopy(holds),
                "effective_remaining": effective, "decision": reason or "admit"}
    queue.setdefault("backfill_admissions", []).append(decision)
    if reason or not reserve:
        return decision
    item["attempt"] = item.get("attempt", 0) + 1
    aid = item.get("job_id", item["id"]) + ":" + str(item["attempt"])
    item.update(attempt_id=aid, vendor_state="unknown", state="launch-unknown")
    holds[aid] = {"item": item["id"], "at": at, "quota_state": "reserved", "vendor_run_id": None}
    return decision


def bind_run(queue, item, vendor_run_id):
    hold = queue["backfill_reservations"][item["attempt_id"]]
    if hold["vendor_run_id"] and hold["vendor_run_id"] != vendor_run_id:
        raise ledger.IntegrityError("vendor identity conflict")
    hold["vendor_run_id"] = vendor_run_id
    item.update(vendor_state="live", state="reviewing")


def cancel_before_vendor(queue, item):
    """Positive local evidence: scanning/preparation refused before vendor spawn."""
    if item.get("run"):
        raise ledger.IntegrityError("cannot cancel a run with recorded ownership")
    hold = queue.get("backfill_reservations", {}).get(item.get("attempt_id"))
    if hold:
        hold["quota_state"] = "released"
    item["vendor_state"] = "terminal"


def reconcile_absent(queue, item, at, operator, reason, evidence):
    ledger.timestamp(at)
    if (not operator or not reason or evidence.get("attempt_id") != item.get("attempt_id")
            or evidence.get("verdict") != "vendor-confirmed-not-started" or not evidence.get("vendor_query")
            or item.get("run")):
        raise ledger.IntegrityError("unknown launch requires exact authenticated vendor absence evidence")
    item["vendor_state"] = "terminal"
    cancel_before_vendor(queue, item)
    if item.get("kind") == "coverage":
        item.update(state="pending", run=None, last_error=reason)
    else:
        terminal(queue, item, at, "error", vendor_terminal=True, reason=reason)
    queue.setdefault("backfill_operator_events", []).append({"at": at, "item": item["id"], "operator": operator,
                                                              "reason": reason, "reconciliation": evidence})


def terminal(queue, item, at, outcome, *, vendor_terminal, retry_after=0, reason=""):
    if not vendor_terminal:
        item.update(vendor_state="unknown", state="launch-unknown")
        return
    item["vendor_state"] = "terminal"
    item["run"] = None
    hold = queue.get("backfill_reservations", {}).get(item.get("attempt_id"))
    if hold:
        hold["terminal_at"] = at
    if outcome == "completed":
        # No success reset until validated remote coverage is acknowledged.
        item["state"] = "publication-pending"
        return
    item["retry"] = True
    item["failures"] = item.get("failures", 0) + 1
    histories = history(queue, item)
    immediate = outcome in ("auth", "integrity", "unsupported", "secret-scan")
    for h in histories:
        h["failures"] += 1
        delay = max(retry_after, min(86400, 3600 * 2 ** min(h["failures"] - 1, 5)))
        h["next_eligible_at"] = (ledger.timestamp(at) + dt.timedelta(seconds=delay)).strftime("%Y-%m-%dT%H:%M:%SZ")
        h["quarantined"] = h["quarantined"] or immediate or h["failures"] >= 6
    item["family_failures"] = max(h["failures"] for h in histories)
    item["state"] = "quarantined" if any(h["quarantined"] for h in histories) else "blocked" if item["failures"] >= 3 else "pending"
    item["not_before"] = max(h["next_eligible_at"] for h in histories)
    item["last_error"] = reason or outcome


def published(queue, item, credited_scope, remote_event_id):
    if item["state"] != "publication-pending" or not remote_event_id:
        raise ledger.IntegrityError("missing acknowledged completion")
    credited = ledger.scope(credited_scope)
    requested = ledger.scope(item["scope"])
    completed_units = []
    for key, lines in requested.items():
        if lines <= credited.get(key, set()):
            completed_units.append(item.get("path_lineages", {}).get(key[0], key[0]))
    for unit in completed_units:
        queue.get("backfill_scope_failures", {}).pop(unit, None)
    # A sibling's completion cannot reset another unit's failure history.
    if all(lines <= credited.get(key, set()) for key, lines in requested.items()):
        siblings = [j for j in queue["items"] if j.get("family") == item["family"] and j is not item
                    and j.get("state") not in ("done", "skipped")
                    and not (j.get("state") in ("blocked", "failed") and not is_execution_owner(j)
                             and j.get("scope_digest") == item.get("scope_digest")
                             and j.get("generation", 0) < item.get("generation", 0))]
        if not siblings:
            queue["backfill_families"].pop(item["family"], None)
        item["state"] = "done"
    else:
        item["state"] = "partial"
    item["published_event_id"] = remote_event_id


def release(queue, item, at, operator, reason, no_live_evidence):
    ledger.timestamp(at)
    if not operator or not reason or not no_live_evidence or is_execution_owner(item):
        raise ledger.IntegrityError("release requires operator reason and exact no-live-run verification")
    item.update(state="skipped", last_error=reason)
    queue.setdefault("backfill_operator_events", []).append({"at": at, "item": item["id"], "operator": operator,
                                                              "reason": reason, "no_live_evidence": no_live_evidence})


def release_quarantine(queue, family, at, operator, reason):
    if not operator or not reason:
        raise ledger.IntegrityError("quarantine release requires operator and reason")
    ledger.timestamp(at)
    affected = [j for j in queue["items"] if j.get("family") == family]
    if not affected:
        raise ledger.IntegrityError("quarantine family has no affected items")
    if any(is_execution_owner(j) for j in affected):
        raise ledger.IntegrityError("unknown/live vendor run still owns family")
    for item in affected:
        for h in history(queue, item):
            h.update(failures=0, quarantined=False, next_eligible_at=None)
    queue.setdefault("backfill_operator_events", []).append({"at": at, "family": family, "operator": operator, "reason": reason})


class Journal:
    """Public transactional entry point for timer/operator/offline concurrency tests."""
    def __init__(self, filename, lock):
        self.filename, self.lock = Path(filename), Path(lock)

    def transact(self, operation):
        with ledger.locked(self.lock):
            queue = ledger.loads(self.filename.read_bytes()) if self.filename.exists() else {"items": []}
            result = operation(queue)
            ledger.atomic(self.filename, ledger.canonical(queue))
            return result
