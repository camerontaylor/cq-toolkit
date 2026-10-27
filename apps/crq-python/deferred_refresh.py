"""Bounded recovery for explicitly enrolled deferred author intents (Q6).

Call under the sole runner's existing lock, then save the queue atomically before
dispatch. No interval discovery, scheduler, vendor calls or grant renewal.
Forge adapters return trusted API metadata; caller JSON is never an adapter.
"""
import copy
import re

import review_receipt as receipts


def _verified(actual, binding, pr=None):
    if not isinstance(actual, dict):
        raise ValueError("forge metadata missing")
    if any(actual.get(k) != binding[k] for k in ("repo", "producer", "head", "target")):
        raise ValueError("forge producer/head/target mismatch")
    number = actual.get("pr")
    if type(number) is not int or number <= 0 or pr is not None and number != pr:
        raise ValueError("forge PR mismatch")
    if actual.get("state") not in {"OPEN", "CLOSED", "MERGED"}:
        raise ValueError("forge state unsupported")
    if actual["state"] == "MERGED" and not re.fullmatch(r"[0-9a-f]{40}", actual.get("mergeSha") or ""):
        raise ValueError("forge merge identity missing")
    return actual


def refresh_deferred(q, *, verify_source, find_source, at, limit=20, may_continue=lambda: True):
    """Refresh at most limit intents, fairly across ticks, without Q2 discovery.

    verify_source(repo, pr) and find_source(repo, producer, head, target, limit)
    return forge metadata. find_source must bound its result to limit (2 here),
    including closed/merged PRs, and refuse incomplete/ambiguous searches.
    Unpublished intents remain inspectable; multiple matches fail closed.
    The caller persists this result even when a remote publication reply was lost.
    """
    if type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError("refresh limit must be between 1 and 50")
    entries = q.get("queue_client_requests", {})
    ids = sorted(rid for rid, entry in entries.items()
                 if entry.get("binding", {}).get("kind") == "deferred-author"
                 and entry.get("state") in {"awaiting-pr", "awaiting-merge"})
    cursor = q.get("deferred_refresh_cursor", "")
    ordered = [rid for rid in ids if rid > cursor] + [rid for rid in ids if rid <= cursor]
    refreshed = []
    for rid in ordered[:limit]:
        if not may_continue():
            break  # aggregate deadline/request cap: leave cursor and debt untouched
        entry = entries[rid]
        b = entry["binding"]
        q["deferred_refresh_cursor"] = rid
        entry["refreshedAt"] = at
        try:
            if entry.get("pr") is None:
                matches = find_source(b["repo"], b["producer"], b["head"], b["target"], 2)
                if not isinstance(matches, list) or len(matches) > 1:
                    raise ValueError("forge publication recovery ambiguous")
                if not matches:
                    entry.pop("refreshError", None)
                    refreshed.append(rid)
                    continue
                actual = _verified(matches[0], b)
            else:
                actual = _verified(verify_source(b["repo"], entry["pr"]), b, entry["pr"])
            entry["pr"] = actual["pr"]
            if actual["state"] == "CLOSED":
                entry.update(state="cancelled", cancellationReason="forge PR closed without merge")
            elif actual["state"] == "OPEN":
                entry["state"] = "awaiting-merge"
            else:
                # enroll itself is idempotent and validates the immutable request.
                # Stage the mutation so a refused enrollment cannot leave half a link.
                staged = copy.deepcopy(q)
                receipts.enroll(staged, repo=b["repo"], pr=actual["pr"],
                                merge_sha=actual["mergeSha"], request_id=rid, at=at,
                                target_selector=b["targetSelector"])
                q["items"] = staged["items"]
                q["merged_current_requests"] = staged["merged_current_requests"]
                entry.update(state="ready-current", mergeSha=actual["mergeSha"])
            entry.pop("refreshError", None)
            entry.pop("reason", None)
        except ValueError:
            # Identity/ambiguity is a real blocker, never vendor availability.
            entry["reason"] = {"source": "queue", "category": "identity", "code": "forge-identity"}
        except (OSError, RuntimeError):
            # Preserve debt and retry next natural tick; don't persist API payloads.
            entry["refreshError"] = "forge refresh unavailable; debt retained"
        refreshed.append(rid)
    return refreshed
