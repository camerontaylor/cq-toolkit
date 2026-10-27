"""Q7 deployment controller: wrap the accepted host helper in observable,
fail-stopped operations (#395).

Owns the operator seam AROUND ``ops/prepare-host.py`` — never a second
renderer, switcher or scheduler. The controller's additions:

  * a single controller lock distinct from the runner's tick lock, so a
    controller run cannot collide with itself;
  * preflight: pinned full 40-hex target SHA + owner-approved annotated
    ``crq-runner/`` tag, reachability/drift/stopped-unit checks (all delegated
    to the helper's own ``switch`` path), retained prior-SHA/config hashes;
  * exact owned-PID drain: every queue item with a live review process is
    probed through the same fail-closed liveness the runner uses
    (``crq.run_liveness`` semantics). Nothing is signalled or killed —
    ``alive``/``ambiguous`` items block the controller and require the owner
    to drain them through the documented author-recovery path;
  * preservation invariants verified before and after the helper runs:
    queue.json, receipts/claims, author quota history and the heartbeat are
    byte-identical (never restored, rewritten or migrated by the controller);
  * operator-approved activation: the controller renders/installs nothing and
    starts nothing; the runbook's owner steps start units;
  * two advancing-tick health observations AFTER owner activation, plus
    representative receipt readability (distinct checks);
  * fail-stopped, owner-approved automatic rollback, only to a recorded
    compatible previous target: same helper path, same drift/stopped-unit
    fence. A queue/receipt schema the prior target cannot read disables
    automatic rollback before anything is written (recorded by the controller
    during preflight);
  * a schema-versioned controller journal in the private record directory;
    every refusal names its reason.

Fake process/filesystem effects in tests only: no live systemd, no network,
no deployment, no signer or credential operations.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


def _load_helper(path: Path):
    """Load the accepted helper as a module; never reimplement it."""
    spec = importlib.util.spec_from_file_location("crq_prepare_host", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LOCK_NAME = "controller.lock"
JOURNAL_SCHEMA = 1

TAG_RE = re.compile(r"crq-runner/[0-9]{8}-[0-9]+")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")

# Queue surfaces the controller must observe and preserve (never rewrite).
# The queue file is the single ledger: items, starts, author_requests and
# author_observations all persist inside queue.json; the heartbeat mirrors the
# completed-tick timestamp for the watchdog. Keys are state-relative names.
PRESERVED = {
    "queue.json": "queue, reservations, author quota history",
    "heartbeat.json": "completed-tick heartbeat",
}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Refused(Exception):
    """A controller refusal: nothing was changed; the reason is terminal."""


class Effects:
    """Host effects seam. Tests substitute fakes; production uses real paths.

    Only observation and small private-record writes live here. Deployment
    mutations (checkout/config/units) belong to the accepted helper alone.
    """

    def __init__(self, root: Path, record_dir: Path):
        self.root = root
        self.record_dir = record_dir

        self.config_path = root / "apps/crq-python/config.json"

    # -- observation -----------------------------------------------------
    def state_dir(self) -> Path:
        return self.root / "apps/crq-python/state"

    def read_json(self, rel: str):
        return json.loads((self.state_dir() / rel).read_text())

    def exists(self, rel: str) -> bool:
        return (self.state_dir() / rel).exists()

    def git(self, *args: str) -> str:
        result = subprocess.run(["git", "-C", str(self.root), *args],
                                capture_output=True, text=True)
        if result.returncode != 0:
            raise Refused("git " + args[0] + " failed: " + result.stderr.strip()[:200])
        return result.stdout.strip()

    # -- controller lock --------------------------------------------------
    @contextlib.contextmanager
    def controller_lock(self):
        import fcntl

        self.state_dir().mkdir(parents=True, exist_ok=True)
        path = self.state_dir() / LOCK_NAME
        with path.open("a") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise Refused("controller lock busy: another controller run holds "
                              + LOCK_NAME + " (" + str(exc) + ")") from None
            yield

    # -- journal ----------------------------------------------------------
    def journal_append(self, entry: dict) -> None:
        self.record_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.record_dir.stat().st_mode & 0o077:
            raise Refused("controller record directory must have mode 0700")
        name = "controller-" + uuid.uuid4().hex + ".json"
        data = (json.dumps(entry, indent=2, sort_keys=True) + "\n").encode()
        fd, tmp = tempfile.mkstemp(prefix="." + name, dir=self.record_dir)
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            os.replace(tmp, self.record_dir / name)
        finally:
            Path(tmp).unlink(missing_ok=True)


# ---------------------------------------------------------------- preflight


def captured_state(effects: Effects) -> dict:
    """Retained prior identity + preservation digests, read before any helper
    invocation. The digests are what the post-checks compare byte-for-byte."""
    state = {"prior_head": effects.git("rev-parse", "HEAD")}
    try:
        state["prior_config_sha256"] = _sha256(effects.config_path)
    except OSError:
        state["prior_config_sha256"] = None
    for rel in PRESERVED:
        state["preserved/" + rel] = (_sha256(effects.state_dir() / rel)
                                     if effects.exists(rel) else None)
    return state


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def compatibility_record(effects: Effects, target_sha: str) -> dict:
    """Read-only rollback-compatibility evidence for the CURRENT->TARGET move.

    The controller cannot execute the prior target's parser, so it records
    observable state-shape facts an owner needs: queue schema markers and the
    state keys the current queue carries. Any key the controller cannot
    classify as readable by the recorded prior target disables automatic
    rollback (owner decision, never a silent restore). Receipts under
    state/runs are append-only artifacts both versions read defensively.
    """
    record = {"checked": True, "schema_observations": []}
    if effects.exists("queue.json"):
        try:
            queue = effects.read_json("queue.json")
            record["queue_schema"] = queue.get("schema_version", "unmarked")
            for key in sorted(queue):
                if key.startswith("author_"):
                    record["schema_observations"].append(key)
        except (ValueError, OSError) as exc:
            record["queue_schema"] = "unreadable: " + str(exc)[:120]
    record["target_sha"] = target_sha
    return record


def preflight(effects: Effects, target: str, tag: str) -> dict:
    """Everything checked before the helper is invoked. No mutation."""
    if not SHA_RE.match(target or ""):
        raise Refused("--sha must be a full 40-hex commit SHA")
    if not TAG_RE.match(tag or ""):
        raise Refused("--tag must be an owner-approved annotated runner tag "
                      "like crq-runner/20261028-1")
    ref = "refs/tags/" + tag
    if effects.git("cat-file", "-t", ref) != "tag":
        raise Refused("tag must be annotated: " + tag)
    peeled = effects.git("rev-parse", ref + "^{commit}")
    if peeled != target:
        raise Refused("tag " + tag + " peels to " + peeled + ", not " + target)
    return {
        "at": now_iso(),
        "target": target,
        "tag": tag,
        "state": captured_state(effects),
        "rollback_compatibility": compatibility_record(effects, target),
    }


# -------------------------------------------------------------------- drain


def drain_check(effects: Effects, liveness) -> dict:
    """Exact owned-PID drain observation. The controller NEVER signals or
    kills a process; it observes liveness and refuses while any queue-owned
    review is alive or ambiguous.

    ``liveness(rdir, item, r, has_exit)`` is the runner's own fail-closed
    probe (crq.run_liveness); supplying it keeps the controller's ownership
    semantics identical to the runner's.
    """
    try:
        queue = effects.read_json("queue.json")
    except (ValueError, OSError) as exc:
        raise Refused("queue unreadable, refusing to reason about drain: "
                      + str(exc)[:160]) from None
    runs = effects.state_dir() / "runs"
    blocked = []
    for item in queue.get("items", []):
        r = item.get("run")
        if not isinstance(r, dict):
            continue
        run_id = r.get("run_id")
        if not isinstance(run_id, str) or not re.fullmatch(r"[0-9a-f-]{8,64}", run_id):
            blocked.append({"item": item.get("id"), "state": "ambiguous",
                            "reason": "malformed run id"})
            continue
        rdir = runs / run_id
        has_exit = (rdir / "exit.json").exists()
        try:
            state = liveness(rdir, item, r, has_exit)
        except Exception as exc:  # probe failure is ambiguous, never an absence proof
            blocked.append({"item": item.get("id"), "state": "ambiguous",
                            "reason": "liveness probe failed: " + str(exc)[:120]})
            continue
        if state in ("alive", "ambiguous"):
            blocked.append({"item": item.get("id"), "state": state,
                            "run": run_id})
    return {"blocked": blocked, "drained": not blocked}


# ------------------------------------------------------------- preservation


def preservation_check(effects: Effects, before: dict) -> dict:
    """Byte-identical verification of queue/quota history and heartbeat across
    the helper invocation. Any difference is a refused deployment (fail
    stopped, reason recorded)."""
    diffs = []
    for rel in PRESERVED:
        after = _sha256(effects.state_dir() / rel) if effects.exists(rel) else None
        if after != before.get("preserved/" + rel):
            diffs.append(rel)
    if diffs:
        raise Refused("preserved surfaces changed during deployment: "
                      + ", ".join(diffs)
                      + "; fail stopped, owner recovery required")
    return {"preserved": True, "checked": sorted(PRESERVED)}


# ------------------------------------------------------------------- health


def _parse_iso(value):
    """Strict runner timestamps only; anything else is not a tick value."""
    return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


def _tick_value(effects: Effects) -> str:
    if effects.exists("queue.json"):
        queue = effects.read_json("queue.json")
        value = queue.get("last_tick")
        if isinstance(value, str) and value:
            return value
    if effects.exists("heartbeat.json"):
        heartbeat = effects.read_json("heartbeat.json")
        value = heartbeat.get("last_tick")
        if isinstance(value, str) and value:
            return value
    raise Refused("no last_tick observed in queue or heartbeat; cannot assess health")


def health_observation(effects: Effects, prior_tick: str) -> dict:
    """One health observation against the requested prior tick.

    Advancement is lexicographic on the strict UTC timestamps (they sort
    chronologically), never a wall-clock delta; receipts are sampled only for
    readability, never for review credit.
    """
    _parse_iso(prior_tick)
    current = _tick_value(effects)
    _parse_iso(current)
    advanced = current > prior_tick
    receipts = effects.state_dir() / "runs"
    receipt_sample = None
    if receipts.is_dir():
        entries = sorted(receipts.iterdir())
        readable = 0
        for entry in entries[:10]:
            meta = entry / "meta.json"
            if meta.is_file():
                try:
                    json.loads(meta.read_text())
                    readable += 1
                except (ValueError, OSError):
                    pass
        receipt_sample = {"sampled": len(entries[:10]), "readable": readable}
    return {"observed_tick": current, "advanced": advanced,
            "receipts": receipt_sample}


def two_slot_health(effects: Effects, observe) -> dict:
    """Two advancing-tick observations via the injected ``observe`` callable
    (wall-clock sleeping belongs to the caller, never the controller).

    Each observation must be strictly later than the previous one; two equal
    timestamps are one slot seen twice, never two slots.
    """
    first_tick = _tick_value(effects)
    first = observe(first_tick)
    if not first.get("advanced"):
        return {"healthy": False, "reason": "first observation did not advance past "
                                            + first_tick,
                "observations": [first]}
    second_tick = first["observed_tick"]
    second = observe(second_tick)
    if not second.get("advanced"):
        return {"healthy": False, "reason": "second observation did not advance past "
                                            + second_tick,
                "observations": [first, second]}
    return {"healthy": True, "observations": [first, second]}


# ----------------------------------------------------------------- rollback


def rollback_compatible(record: dict) -> bool:
    """Automatic rollback is permitted only when the preflight compatibility
    record shows no schema-advancing marker the prior target cannot read.
    Any observation the controller cannot classify disables automatic
    rollback: the operator decides instead."""
    if not record.get("checked"):
        return False
    return not record.get("schema_observations")


# --------------------------------------------------------------------- plan


def deploy_plan(effects: Effects, helper_module, target: str, tag: str,
                overlay_path: Path) -> dict:
    """The full sequence, executed or refused as a whole (fail stopped).

    Order: lock -> preflight -> drain -> helper switch -> preservation ->
    compatibility record -> journal. Units are started by the owner per
    HOST-DEPLOY.md; the controller never starts or enables anything.
    """
    with effects.controller_lock():
        pre = preflight(effects, target, tag)
        plan = {"preflight": pre, "steps": []}
        drain = drain_check(effects, _runner_liveness(helper_module))
        plan["steps"].append({"step": "drain", **drain})
        if not drain["drained"]:
            raise Refused("queue-owned reviews alive/ambiguous; drain through the "
                          "documented author-recovery path first: "
                          + json.dumps(drain["blocked"])[:400])
        overlay, raw = helper_module.load_overlay(overlay_path)
        helper_module.switch(effects.root, overlay, raw, target, tag)
        post = preservation_check(effects, pre["state"])
        plan["steps"].append({"step": "preservation", **post})
        record = compatibility_record(effects, target)
        plan["rollback_compatibility_after"] = record
        plan["automatic_rollback_permitted"] = rollback_compatible(
            {**pre["rollback_compatibility"], **record})
        effects.journal_append({"schema_version": JOURNAL_SCHEMA,
                                "operation": "deploy", "at": now_iso(),
                                "plan": plan})
        return plan


def _runner_liveness(helper_module):
    """The runner's fail-closed probe (crq.run_liveness), imported from the
    same checkout as the helper so probe semantics match the deployed runner.
    Importing crq.py evaluates its deployment config; if that is impossible,
    drain conservatively refuses: an unverifiable probe is ambiguous by
    definition, and the operator drains via the documented recovery path."""
    helper_dir = Path(getattr(helper_module, "__file__", "")).resolve().parent
    if str(helper_dir) not in sys.path:
        sys.path.insert(0, str(helper_dir))
    try:
        import crq
    except Exception:  # a broken deployment import must never fake a verdict
        return _refusing_liveness
    return crq.run_liveness


def _refusing_liveness(*_args, **_kwargs):
    return "ambiguous"


def rollback_plan(effects: Effects, helper_module, prior: dict,
                  overlay_path: Path) -> dict:
    """Owner-approved rollback to the recorded prior target, through the SAME
    helper fence. Refuses when the compatibility record disables automatic
    rollback (schema-incompatible prior target)."""
    with effects.controller_lock():
        target = prior.get("prior_head")
        if not target or not SHA_RE.match(target):
            raise Refused("no recorded prior target SHA; refusing blind rollback")
        record = prior.get("rollback_compatibility", {})
        if not rollback_compatible(record):
            raise Refused("rollback disabled: schema-advancing queue state observed; "
                          "operator recovery required (never restore old queue "
                          "snapshots or start incompatible binaries)")
        drain = drain_check(effects, _runner_liveness(helper_module))
        if not drain["drained"]:
            raise Refused("cannot roll back with live/ambiguous reviews: "
                          + json.dumps(drain["blocked"])[:400])
        overlay, raw = helper_module.load_overlay(overlay_path)
        helper_module.switch(effects.root, overlay, raw, target, prior["tag"])
        effects.journal_append({"schema_version": JOURNAL_SCHEMA,
                                "operation": "rollback", "at": now_iso(),
                                "to": target, "tag": prior["tag"]})
        return {"rolled_back_to": target, "tag": prior["tag"]}


# --------------------------------------------------------------------- main


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path,
                        help="deployment checkout root (full monorepo)")
    parser.add_argument("--overlay", required=True, type=Path,
                        help="private overlay path (outside Git)")
    parser.add_argument("--record-dir", required=True, type=Path,
                        help="private controller record directory (outside Git)")
    parser.add_argument("--helper", type=Path,
                        help="path to prepare-host.py (default: <root>/apps/crq-python/ops)")
    sub = parser.add_subparsers(dest="operation", required=True)
    switch = sub.add_parser("switch", help="preflight, drain, switch, verify, journal")
    switch.add_argument("--sha", required=True)
    switch.add_argument("--tag", required=True)
    rollback = sub.add_parser("rollback",
                              help="owner-approved rollback to the recorded prior target")
    rollback.add_argument("--prior-record", required=True, type=Path,
                          help="a controller journal entry naming the prior target")
    health = sub.add_parser("health", help="two advancing-tick observations")
    health.add_argument("--interval-seconds", type=int, default=0,
                        help="seconds between observations (caller-timed)")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    helper_path = args.helper or (root / "apps/crq-python/ops/prepare-host.py")
    helper_module = _load_helper(helper_path)
    effects = Effects(root, args.record_dir.resolve())

    try:
        if args.operation == "switch":
            plan = deploy_plan(effects, helper_module, args.sha, args.tag,
                               args.overlay)
            print(json.dumps({"operation": "switch", "target": plan["preflight"]["target"],
                              "automatic_rollback_permitted":
                                  plan["automatic_rollback_permitted"],
                              "steps": plan["steps"]}, indent=2, sort_keys=True))
        elif args.operation == "rollback":
            prior = json.loads(args.prior_record.read_text())
            result = rollback_plan(effects, helper_module, prior, args.overlay)
            print(json.dumps({"operation": "rollback", **result}, indent=2,
                             sort_keys=True))
        else:
            def observe(prior_tick):
                if args.interval_seconds:
                    time.sleep(args.interval_seconds)
                return health_observation(effects, prior_tick)

            result = two_slot_health(effects, observe)
            print(json.dumps({"operation": "health", **result}, indent=2,
                             sort_keys=True))
            if not result["healthy"]:
                return 1
    except Refused as exc:
        print("refused: " + str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(str(exc)) from None
