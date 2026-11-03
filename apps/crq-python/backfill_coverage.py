"""Persisted per-target backfill coverage, computed off tick.lock.

Coverage is a union over independent creditable ledger reviews and the ledger
is append-only, so a snapshot taken over the first n events extends to any
later head by folding only the appended events. Most head moves append no
creditable review (state and finding events), so a snapshot stays valid
without any Git work. Selection under tick.lock only reads snapshots; the
off-lock refresher (run after ledger publication) is the only caller of the
expensive accounting.

Evidence is verified when a review is folded, not again on every selection
pass: a snapshot keeps credit whose retained artifacts were verified at fold
time. Bump VERSION whenever accounting semantics change, so existing snapshots
read as stale and are recomputed.
"""
import collections
from pathlib import Path

import backfill_jobs as jobs
import review_ledger as ledger

VERSION = 1
DIRECTORY = "backfill/coverage"
REQUEST = "backfill/coverage-request.json"
LOCK = "backfill/coverage.lock"


def _snapshot_path(state, target):
    if not isinstance(target, str) or not all(ch in "0123456789abcdef" for ch in target) or len(target) not in (40, 64):
        raise ledger.IntegrityError("coverage target must be a full object ID")
    return Path(state) / DIRECTORY / (target + ".json")


def _prefix_digest(events, count):
    return ledger.digest([value["id"] for value in events[:count]])


def _read(state, target):
    try:
        value = ledger.loads(_snapshot_path(state, target).read_bytes())
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict) or value.get("version") != VERSION or value.get("target") != target:
        return None
    if type(value.get("events")) is not int or not isinstance(value.get("covered"), dict) or not isinstance(value.get("gaps"), list):
        return None
    try:
        value["covered"] = {name: ledger.intervals(rows) for name, rows in value["covered"].items()}
    except (TypeError, ValueError):
        return None
    return value


def _extends(snapshot, events, digests=None):
    """The snapshot's events are a prefix of this ledger sequence."""
    count = snapshot["events"]
    if not 0 <= count <= len(events):
        return False
    if digests is None:
        return snapshot.get("prefix") == _prefix_digest(events, count)
    if count not in digests:
        digests[count] = _prefix_digest(events, count)
    return snapshot.get("prefix") == digests[count]


def load(state, target, events, digests=None):
    """Return (covered, gaps) valid for this ledger sequence, or None when stale.

    Cheap and Git-free: safe under tick.lock. A snapshot over a prefix remains
    exact when no appended event is a creditable review. Pass one `digests` dict
    for every target checked against the same events to hash each prefix once.
    """
    snapshot = _read(state, target)
    if snapshot is None or not _extends(snapshot, events, digests):
        return None
    if any(ledger.creditable(value) for value in events[snapshot["events"]:]):
        return None
    return snapshot["covered"], list(snapshot["gaps"])


def request(state, head, targets):
    """Ask the off-lock refresher for fresh snapshots; an atomic small write."""
    ledger.atomic(Path(state) / REQUEST, ledger.canonical({"head": head, "targets": sorted(set(targets))}))


def _ranges(lines):
    result = []
    for number in sorted(lines):
        if result and result[-1][1] == number - 1:
            result[-1][1] = number
        else:
            result.append([number, number])
    return result


def refresh(state, repo, store, events, targets, keep=()):
    """Bring each target's snapshot to this validated ledger sequence.

    Folds only the events appended since the snapshot, plus earlier reviews that
    left a gap (gaps can be transient, e.g. an unreadable artifact). A sequence
    that no longer extends the snapshot (it should not happen on an append-only
    ledger) recomputes in full, as does an unreadable snapshot. Returns
    {target: "current"|"extended"|"full"|"invalid-target"}.
    """
    ledger.validate_sequence(events)
    repo.begin_invocation()  # immutable-object cache; earlier gaps are retried
    outcome = {}
    for target in sorted(set(targets)):
        try:
            _snapshot_path(state, target)
        except ledger.IntegrityError:
            outcome[target] = "invalid-target"  # one bad target never blocks the rest
            continue
        snapshot = _read(state, target)  # unreadable/corrupt reads as None: full recompute
        if snapshot is not None and _extends(snapshot, events):
            start = snapshot["events"]
            retry = {gap.get("review") for gap in snapshot["gaps"] if isinstance(gap, dict)}
            todo = [value for value in events[:start] if value["id"] in retry] + list(events[start:])
            if not any(ledger.creditable(value) for value in todo):
                if start == len(events):
                    outcome[target] = "current"
                    continue
                todo = []
            covered = collections.defaultdict(set, snapshot["covered"])
            outcome[target] = "extended"
        else:
            todo, covered = list(events), collections.defaultdict(set)
            outcome[target] = "full"
        gaps = []
        repo.fold(target, todo, store, covered, collections.defaultdict(list), gaps)
        ledger.atomic(_snapshot_path(state, target), ledger.canonical({
            "version": VERSION, "target": target, "events": len(events),
            "prefix": _prefix_digest(events, len(events)),
            "covered": {name: _ranges(lines) for name, lines in sorted(covered.items()) if lines},
            "gaps": gaps}))
    # Snapshots for targets no live job uses are dead weight; drop them. A job
    # that is reviewing may return to pending, so its target's snapshot stays.
    directory, keep = Path(state) / DIRECTORY, set(keep)
    if directory.is_dir():
        for path in directory.glob("*.json"):
            if path.stem not in outcome and path.stem not in keep:
                path.unlink(missing_ok=True)
    return outcome


def pending_targets(queue):
    return {item["target"] for item in queue.get("items", [])
            if item.get("kind") == jobs.KIND and item.get("state") == "pending"}


def live_targets(queue):
    """Targets of every backfill job that may still need dispatch."""
    return {item["target"] for item in queue.get("items", [])
            if item.get("kind") == jobs.KIND and item.get("state") not in ("done", "quarantined")}


def run(c, *, published_head=None):
    """Off-lock refresher. Runs when selection requested a snapshot or a
    publication moved the ledger head; otherwise idle (no network)."""
    import backfill_runtime as runtime
    config = runtime.settings(c.STATE)
    if not config:
        return "disabled"
    marker = c.STATE / REQUEST
    if not marker.exists() and published_head is None:
        return "idle"
    import backfill_publisher
    with ledger.locked(c.STATE / LOCK):
        try:  # read under the refresher lock; a concurrent run may consume it
            requested = marker.read_bytes()
        except FileNotFoundError:
            requested = None
        if requested is None and published_head is None:
            return "idle"
        # A read-only snapshot of the queue: targets only, never saved here. The
        # request's own targets are added: the queue read here (without
        # tick.lock) may predate the save that enqueued them.
        queue = c.load_queue()
        targets = pending_targets(queue)
        if requested is not None:
            try:
                targets |= set(ledger.loads(requested).get("targets") or [])
            except (ValueError, AttributeError, TypeError):
                pass
        repo, store, _, _ = runtime.services(c, config)
        # Read the ledger through the publisher's private clone, so the scheduler
        # clone's validated-ledger checkpoint is only ever moved by the scheduler.
        with ledger.locked(c.STATE / "backfill/publisher.lock"):
            _, _, _, reader = backfill_publisher.worker_services(c, config)
            head, events = reader.fetch()
        outcome = refresh(c.STATE, repo, store, events, targets, keep=live_targets(queue))
        # A request written while we computed survives for the next run.
        if requested is not None and marker.exists() and marker.read_bytes() == requested:
            marker.unlink()
            ledger.fsync_dir(marker.parent)
    if any(value in ("extended", "full") for value in outcome.values()):
        # Wake the next one-minute slot instead of its quota-paced deadline, as
        # a harvest does: jobs that waited on this refresh may now admit.
        import usage_slots
        usage_slots.write_next(c.STATE / "next-review-at", ledger.timestamp(c.iso()))
    return {"head": head, "targets": outcome}
