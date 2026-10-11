"""Author-review quota admission (supported author enrollment).

The shared-quota design (toolkit-research plans/crq-priority-20261012.md,
"Separate shared-quota admission design", authorized 16:23Z) routes a supported
author CLI review through the SAME locked natural tick/launch/_review path — not
a second scheduler. This module is the pure policy; the tick owns Git, process
dispatch and persistence. Invariants:

  * a unique request id immutably binds base/head/target/cycle; enrollment only
    creates a PENDING author item (it never dispatches);
  * an identical request is idempotent; a conflicting identity refuses, and a
    binding is admitted once (no duplicate enrollment, no double spend);
  * author items are selected after the promotion/ordinary classes and before
    the lowest-priority coverage fallback, and never bypass pause/cooldown/hourly/
    inflight gates or the pre-upload secret scan;
  * author harvesting keeps genuine cycle evidence but never creates repair debt
    and never credits branch-only paths as promoted coverage;
  * crash recovery is fail-closed: a live or unverifiable run retains its
    capacity and needs owner disposition (never a TTL release), and a provably
    terminated run without terminal evidence is a distinct terminal with no
    automatic retry;
  * a separate, explicitly ``reserved=false`` external observation can charge a
    genuinely evidenced historical invocation against the rolling hour without
    fabricating a counted cycle or rewriting history. Its exact use requires desk
    approval; this module only provides the mechanism.

Do not import crq here: importing it loads configuration and couples policy to
runtime services. Every returned structure is JSON serializable.
"""
from __future__ import annotations

import datetime as dt
import re
from typing import Any, Callable, Dict, List, Optional

AUTHOR_KIND = "author"

# Selection class: after every ordinary class (open 0, delta 1-2, merged follow-up
# 2, seeded merged 3) and level with the lowest-priority coverage fallback
# (coverage.COVERAGE_RANK == 4). The tick's selection loop dispatches author
# items; the coverage fallback runs only when no ordinary/author item starts, so
# author work is chosen after ordinary demand and before coverage.
AUTHOR_RANK = 4

# Terminal states for an author item. Only "pending" is dispatchable, so both
# failure states are consumed admissions with no automatic retry.
AUTHOR_FAILED = "author_failed"  # failed spawn, or a run provably gone with no exit evidence

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
# A ref/revstring a reviewer may name. Deliberately not the full git rev-parse
# grammar: the tick verifies resolvability against the clone before launching.
TARGET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
# Strict UTC timestamp: exactly YYYY-MM-DDTHH:MM:SSZ. No fractional seconds, no
# offset, and no silent truncation of a longer value.
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
MAX_CYCLE = 2
OBSERVATION_WINDOW = dt.timedelta(hours=1)


class AuthorRefused(Exception):
    """A refused author request or observation. Nothing was written."""


# ------------------------------------------------------------------ bindings


def _sha(name: str, value: Any) -> str:
    if not isinstance(value, str) or not SHA_RE.match(value):
        raise AuthorRefused(f"{name} must be a 40-hex immutable commit sha")
    return value


def _timestamp(name: str, value: Any) -> dt.datetime:
    if not isinstance(value, str) or not TS_RE.match(value):
        raise AuthorRefused(f"{name} must be an exact ISO-8601 UTC timestamp YYYY-MM-DDTHH:MM:SSZ "
                            f"(no fractional seconds or offset)")
    try:
        t = dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        raise AuthorRefused(f"{name} is not a valid UTC timestamp")
    return t.replace(tzinfo=dt.timezone.utc)


def _iso(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_binding(*, request_id: Any, base: Any, head: Any, target: Any, cycle: Any) -> Dict[str, Any]:
    """Validate and normalize the immutable identity of an author request."""
    if not isinstance(request_id, str) or not REQUEST_ID_RE.match(request_id):
        raise AuthorRefused("request_id must match [A-Za-z0-9][A-Za-z0-9._-]{0,79}")
    base = _sha("base", base)
    head = _sha("head", head)
    if base == head:
        raise AuthorRefused("base and head are the same commit")
    if not isinstance(target, str) or not TARGET_RE.match(target):
        raise AuthorRefused("target must be a ref name like origin/merge-queue")
    if isinstance(cycle, bool) or not isinstance(cycle, int) or not (1 <= cycle <= MAX_CYCLE):
        raise AuthorRefused(f"cycle must be an integer 1..{MAX_CYCLE}")
    return {"request_id": request_id, "base": base, "head": head, "target": target, "cycle": cycle}


def binding_of(entry: Dict[str, Any]) -> Dict[str, Any]:
    return {k: entry.get(k) for k in ("base", "head", "target", "cycle")}


def _find_item(q: Dict[str, Any], item_id: str) -> Optional[Dict[str, Any]]:
    return next((i for i in q.get("items", []) if i.get("id") == item_id), None)


# ------------------------------------------------------------------ enrollment


def enroll(q: Dict[str, Any], *, request_id: Any, base: Any, head: Any, target: Any, cycle: Any,
           at: str) -> Dict[str, Any]:
    """Create (or return) the pending author item for a binding.

    Pure: mutates ``q`` in place and returns a result dict; the caller persists
    and emits events. Idempotent for an identical request id + binding; refuses a
    request id whose binding changed, and refuses a second request id for a
    binding already enrolled (a binding may be admitted once)."""
    binding = normalize_binding(request_id=request_id, base=base, head=head, target=target, cycle=cycle)
    requests = q.setdefault("author_requests", {})
    seen = requests.get(binding["request_id"])
    if seen is not None:
        if binding_of(seen) != binding_of(binding):
            raise AuthorRefused(
                f"request_id {binding['request_id']!r} is already enrolled with a different binding "
                f"({binding_of(seen)}); refusing to mutate an immutable request")
        item = _find_item(q, seen.get("item", ""))
        if item is None:
            raise AuthorRefused(
                f"request_id {binding['request_id']!r} is recorded but its item is missing; refusing")
        return {"item": item, "created": False,
                "message": f"author {item['id']}: idempotent (already enrolled cycle {binding['cycle']})"}
    clash = next((r for r in requests.values() if binding_of(r) == binding_of(binding)), None)
    if clash is not None:
        raise AuthorRefused(
            f"binding {binding['base'][:10]}..{binding['head'][:10]} cycle {binding['cycle']} is already "
            f"enrolled as {clash.get('item')} (request_id {clash.get('request_id')!r}); refusing a duplicate")
    item_id = f"author-{binding['request_id']}"
    if _find_item(q, item_id) is not None:
        raise AuthorRefused(f"item {item_id} already exists without a matching request record; refusing")
    item = {"id": item_id, "pr": 0, "kind": AUTHOR_KIND,
            "order": max((i.get("order", 0) for i in q.get("items", [])), default=0) + 1,
            "state": "pending", "cycles": [], "author_cycles": [], "attempts": [],
            "requested_at": at, "author": binding,
            "notes": [f"{at} author-enrolled (request {binding['request_id']}): cycle {binding['cycle']}, "
                      f"{binding['base'][:10]}..{binding['head'][:10]} → {binding['target']}"]}
    q.setdefault("items", []).append(item)
    requests[binding["request_id"]] = {**binding, "item": item_id, "created_at": at, "state": "enrolled"}
    return {"item": item, "created": True,
            "message": f"author {item_id}: enrolled cycle {binding['cycle']} "
                       f"({binding['base'][:12]}..{binding['head'][:12]} → {binding['target']})"}


def plan(item: Dict[str, Any]) -> Dict[str, Any]:
    """The launch plan for a pending author item. The binding is immutable; the
    caller verifies both objects exist in the clone before a worktree is cut."""
    a = item.get("author") or {}
    binding = normalize_binding(request_id=a.get("request_id"), base=a.get("base"), head=a.get("head"),
                                target=a.get("target"), cycle=a.get("cycle"))
    return {"base": binding["base"], "head": binding["head"], "target": binding["target"],
            "cycle": binding["cycle"], "branch": None, "notes": [],
            "label": f"author review — cycle {binding['cycle']} "
                     f"{binding['base'][:12]}..{binding['head'][:12]} → {binding['target']}"}


def record_cycle(item: Dict[str, Any], record: Dict[str, Any]) -> None:
    """Keep genuine author cycle evidence WITHOUT creating repair debt.

    Stored under ``author_cycles``, never under ``cycles``: repair_tick.backfill
    scans ``item['cycles']`` and would otherwise enqueue repair jobs for a
    supported author review (which must never create repair debt)."""
    item.setdefault("author_cycles", []).append(record)


# ----------------------------------------------------------- crash recovery


def _valid_identity(pidfile: Any) -> bool:
    """A run-bound identity: a dict with positive integer pid AND pgid. Anything
    else ({}, a bare pid, strings, a non-dict) is unverifiable, never evidence of
    absence."""
    if not isinstance(pidfile, dict):
        return False
    def positive(value: Any) -> bool:
        return isinstance(value, int) and not isinstance(value, bool) and value > 0
    return positive(pidfile.get("pid")) and positive(pidfile.get("pgid"))


def run_state(*, has_exit: bool, pidfile: Optional[Dict[str, Any]], runner_alive: bool,
              cli_alive: bool, group_alive: bool) -> str:
    """Fail-closed liveness decision for a detached review (author AND natural).

      ``alive``     — a matching runner/CLI process or a non-empty recorded
                      process group is live. This is checked even when a terminal
                      exit artifact exists, so a lingering detached/reused group
                      keeps its capacity (terminal artifact + live group waits).
      ``harvest``   — terminal exit evidence present and nothing alive.
      ``gone``      — no terminal evidence, a VALID run-bound pid+pgid identity,
                      and nothing alive.
      ``ambiguous`` — no terminal evidence and no valid identity (missing,
                      empty, malformed, or missing pgid): retain capacity and
                      require owner disposition. NEVER a TTL release.
    """
    if runner_alive or cli_alive or group_alive:
        return "alive"
    if has_exit:
        return "harvest"
    return "gone" if _valid_identity(pidfile) else "ambiguous"


# ------------------------------------------------------- external observation


def normalize_observation(manifest: Any, *, now: dt.datetime) -> Dict[str, Any]:
    """Validate an external-observation manifest for a genuinely evidenced
    historical author invocation. Pure; artifact bytes are checked separately."""
    if not isinstance(manifest, dict):
        raise AuthorRefused("observation manifest must be a JSON object")
    binding = normalize_binding(request_id=manifest.get("request_id"), base=manifest.get("base"),
                                head=manifest.get("head"), target=manifest.get("target"),
                                cycle=manifest.get("cycle"))
    if manifest.get("reserved") not in (None, False):
        raise AuthorRefused("an external observation can never be reserved (reserved must be false)")
    started = _timestamp("started_at", manifest.get("started_at"))
    if started > now:
        raise AuthorRefused("started_at is in the future")
    if now - started > OBSERVATION_WINDOW:
        raise AuthorRefused("started_at is older than the rolling one-hour window; an observation "
                            "cannot charge the current hour")
    arts = manifest.get("artifacts")
    if not isinstance(arts, list) or not arts:
        raise AuthorRefused("artifacts must be a non-empty list of {path, sha256}")
    seen = set()
    norm_arts: List[Dict[str, str]] = []
    for a in arts:
        if not isinstance(a, dict) or not isinstance(a.get("path"), str) or not a["path"]:
            raise AuthorRefused("each artifact needs a non-empty path")
        if not isinstance(a.get("sha256"), str) or not DIGEST_RE.match(a["sha256"]):
            raise AuthorRefused("each artifact needs a 64-hex sha256")
        if a["sha256"] in seen:
            raise AuthorRefused("duplicate artifact digest")
        seen.add(a["sha256"])
        norm_arts.append({"path": a["path"], "sha256": a["sha256"]})
    note = manifest.get("note")
    if note is not None and not isinstance(note, str):
        raise AuthorRefused("note must be a string")
    return {**binding, "started_at": _iso(started), "artifacts": norm_arts,
            "reserved": False, "note": (note or "")[:300]}


def verify_artifacts(observation: Dict[str, Any], *, is_regular: Callable[[str], bool],
                     digest_of: Callable[[str], str]) -> None:
    """Confirm every declared artifact exists as a regular file whose bytes hash
    to the declared digest. Never records file contents."""
    for a in observation["artifacts"]:
        if not is_regular(a["path"]):
            raise AuthorRefused(f"artifact {a['path']!r} is not a regular file")
        got = digest_of(a["path"])
        if got != a["sha256"]:
            raise AuthorRefused(f"artifact {a['path']!r} digest mismatch "
                                f"({str(got)[:12]} != {a['sha256'][:12]})")


def charge_observation(q: Dict[str, Any], observation: Dict[str, Any], *, at: str) -> Dict[str, Any]:
    """Charge a genuinely evidenced historical invocation against the rolling
    hour, explicitly ``reserved=false``.

    Append-only: it never fabricates a counted cycle and never touches items or
    history. An identical (request_id, started_at) is idempotent; the SAME key
    with a DIFFERENT binding or artifacts refuses (never a silent overwrite)."""
    log = q.setdefault("author_observations", [])
    key = (observation["request_id"], observation["started_at"])
    for o in log:
        if (o.get("request_id"), o.get("started_at")) != key:
            continue
        same = (all(o.get(k) == observation[k] for k in ("base", "head", "target", "cycle"))
                and o.get("artifacts") == observation["artifacts"])
        if same:
            return {"charged": False,
                    "message": f"observation {observation['request_id']} at {observation['started_at']} "
                               f"already recorded (idempotent)"}
        raise AuthorRefused(
            f"observation {observation['request_id']} at {observation['started_at']} is already recorded "
            f"with a different binding/artifacts; refusing to overwrite history")
    log.append({"observed_at": at, "reserved": False, "request_id": observation["request_id"],
                "base": observation["base"], "head": observation["head"],
                "target": observation["target"], "cycle": observation["cycle"],
                "started_at": observation["started_at"], "note": observation["note"],
                "artifacts": observation["artifacts"]})
    q.setdefault("starts", []).append(observation["started_at"])
    return {"charged": True,
            "message": f"charged external observation {observation['request_id']} at "
                       f"{observation['started_at']} to the rolling hour (reserved=false; no counted cycle)"}
