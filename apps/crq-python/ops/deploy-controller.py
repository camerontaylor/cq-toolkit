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
  * two advancing completed-tick health observations AFTER owner activation,
    read only from the runner's completion heartbeat (crq.py replaces it
    after status publication; the earlier queue saves prove nothing), plus
    bounded receipt readability and receipt-schema validity samples (three
    distinct verdicts);
  * the helper's sha256 is computed from the exact bytes executed, recorded
    in every journal, and optionally pinned by the owner before the lock;
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
import ast
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


def _load_helper(path: Path, expected_sha256: str | None = None):
    """Load the accepted helper as a module; never reimplement it.

    The helper's bytes are read ONCE and hashed before anything executes;
    exactly those bytes are compiled, so the recorded digest is the code
    that ran (#549). An owner-pinned ``expected_sha256`` that disagrees
    refuses before any import, lock or preflight. Returns (module, digest).
    """
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise Refused("helper unreadable: " + str(exc)[:200]) from exc
    digest = hashlib.sha256(data).hexdigest()
    if expected_sha256 is not None:
        if not HELPER_SHA_RE.fullmatch(expected_sha256):
            raise Refused("--expect-helper-sha256 must be 64 lowercase hex")
        if digest != expected_sha256:
            raise Refused("helper " + str(path) + " sha256 " + digest
                          + " does not match the owner-pinned "
                          + expected_sha256 + "; nothing imported or run")
    spec = importlib.util.spec_from_file_location("crq_prepare_host", path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(data, str(path), "exec"), module.__dict__)  # noqa: S102 - bound bytes
    return module, digest


def _load_live_binding(path: Path | None = None):
    """Load the live binding only when a production unit switch runs.

    The module imports this controller under a private name for its injected
    port types. ``production_adapter`` recovers the loaded controller module
    from the supplied ``Effects`` object, so refusal identity stays at this
    seam. Nothing here creates a lock, a store, a capability flag or a gate.

    The production call site passes no path and gets one cached module for the
    binding beside this file. An explicit path is a distinct cache entry, so a
    caller cannot be handed a stale module for a path it did not ask to load;
    an unreadable, missing or unresolvable binding refuses as this seam.
    """
    if path is None:
        path = Path(__file__).with_name("unit-live-binding.py")
        name = "crq_unit_live_binding_cli"
    else:
        path = Path(path)
        name = "crq_unit_live_binding_cli_" + hashlib.sha256(
            str(path).encode("utf-8", "surrogateescape")).hexdigest()[:16]
    module = sys.modules.get(name)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise Refused("live unit binding is unavailable: " + str(path)[:200])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except (OSError, ImportError, SyntaxError) as exc:
        sys.modules.pop(name, None)
        raise Refused("live unit binding is unavailable: " + str(exc)[:200]) from exc
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


LOCK_NAME = "controller.lock"
JOURNAL_SCHEMA = 1

TAG_RE = re.compile(r"crq-runner/[0-9]{8}-[0-9]+")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
HELPER_SHA_RE = re.compile(r"[0-9a-f]{64}")
# launch(): item ID + UTC timestamp; author IDs add ._ and promotion retries +.
# Retain legacy hex IDs, but accept only bounded ASCII filesystem components.
RUN_ID_RE = re.compile(
    r"(?:[0-9a-f-]{8,64}|[A-Za-z0-9][A-Za-z0-9._+-]*-[0-9]{8}T[0-9]{6}Z)")

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


class QueueDrainRefused(Refused):
    """A fail-closed queue ownership refusal before any unit mutation.

    ``drain`` is the exact observation the controller acted on so the caller
    can retain the blocked item identities without parsing prose. The
    controller never signals or kills a process.
    """

    def __init__(self, message: str, drain: dict):
        super().__init__(message)
        self.drain = drain


class NoChangeRefused(Refused):
    """A helper refusal with every deployment surface observed unchanged.

    ``record`` is the ``refused_no_change`` evidence (with its observations),
    emitted on stdout as well so it survives a failed journal write.
    """

    def __init__(self, message: str, record: dict):
        super().__init__(message)
        self.record = record


class RecoveryRequired(Exception):
    """The helper was entered: mutation occurred or cannot be excluded.

    recovery always retains the pre-helper identity, even if updating the
    durable intent failed. This is never a no-change refusal or rollback grant.
    """

    def __init__(self, recovery: dict):
        super().__init__(recovery.get("reason", "unit recovery required"))
        self.recovery = recovery


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

    def read_completion_heartbeat(self):
        """The runner's completion heartbeat (crq.py write_heartbeat), read
        from its actual WATCHDOG_HOME — $XDG_STATE_HOME/crq or
        ~/.local/state/crq — never from the checkout's queue/state saves.

        Returns None only when no heartbeat exists yet; one that is present
        but unreadable or not a JSON object refuses assessment.
        """
        home = Path(os.environ.get("XDG_STATE_HOME",
                                   str(Path.home() / ".local/state"))) / "crq"
        try:
            raw = (home / "heartbeat.json").read_text()
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise Refused("completion heartbeat unreadable: "
                          + str(exc)[:120]) from exc
        try:
            payload = json.loads(raw)
        except ValueError as exc:
            raise Refused("completion heartbeat is not valid JSON: "
                          + str(exc)[:120]) from exc
        if not isinstance(payload, dict):
            raise Refused("completion heartbeat is not a JSON object")
        return payload

    def unit_digests(self) -> dict:
        """Read-only observation of installed CRQ user units and their
        enablement links ($XDG_CONFIG_HOME/systemd/user, default
        ~/.config): file digests and link targets, never systemctl."""
        home = Path(os.environ.get("XDG_CONFIG_HOME",
                                   str(Path.home() / ".config"))) / "systemd/user"
        units = {}
        if not home.is_dir():
            return units
        for path in sorted([*home.glob("crq-*"), *home.glob("*.wants/crq-*")]):
            name = str(path.relative_to(home))
            if path.is_symlink():
                units[name] = "link:" + os.readlink(path)
            elif path.is_file():
                units[name] = _sha256(path)
            else:
                units[name] = "other"
        return units

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
        # An explicit mode, never the ambient umask: the live binding refuses
        # a group- or world-writable lock, so a writer that trusts a 002 umask
        # can create a lock its own reader rejects.
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(descriptor, "a") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise Refused("controller lock busy: another controller run holds "
                              + LOCK_NAME + " (" + str(exc) + ")") from None
            # O_CREAT never narrows an existing file: normalise a lock this
            # controller owns (a former 0664 umask artefact) to 0600.
            os.chmod(path, 0o600)
            yield

    # -- journal ----------------------------------------------------------
    def record_preflight(self) -> None:
        """Check deterministic storage failures before entering the helper."""
        try:
            if self.record_dir.is_symlink():
                raise Refused("controller record directory must not be a symlink")
            if not self.record_dir.is_dir():
                raise Refused("controller record directory must already exist as a directory")
            if self.record_dir.stat().st_mode & 0o777 != 0o700:
                raise Refused("controller record directory must have mode 0700")
        except OSError as exc:
            raise Refused("controller record directory unavailable: " + str(exc)) from exc

    def journal_append(self, entry: dict) -> Path:
        path = self.record_dir / ("controller-" + uuid.uuid4().hex + ".json")
        self.journal_replace(path, entry)
        return path

    def journal_replace(self, path: Path, entry: dict) -> None:
        """Atomically advance one transaction's private, retained record."""
        self.record_preflight()
        if path.parent != self.record_dir or path.is_symlink():
            raise Refused("invalid controller transaction record path")
        data = (json.dumps(entry, indent=2, sort_keys=True) + "\n").encode()
        fd, tmp = tempfile.mkstemp(prefix="." + path.name, dir=self.record_dir)
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            os.replace(tmp, path)
            directory = os.open(self.record_dir, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
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
    state["checkout_status"] = effects.git("status", "--porcelain",
                                           "--untracked-files=all")
    state["units"] = effects.unit_digests()
    return state


def no_change_observation(effects: Effects, before: dict) -> dict:
    """Re-observe every deployment surface the helper's switch can change.

    ``unchanged`` is True only when HEAD, the rendered config bytes, the
    checkout status, the installed units and the preserved state all equal
    the retained pre-helper identity. Observation errors propagate: an
    unobservable surface is never proof of no change.
    """
    try:
        config = _sha256(effects.config_path)
    except FileNotFoundError:
        config = None
    observed = {"head": effects.git("rev-parse", "HEAD"),
                "config_sha256": config,
                "checkout_status": effects.git("status", "--porcelain",
                                               "--untracked-files=all"),
                "units": effects.unit_digests()}
    for rel in PRESERVED:
        observed["preserved/" + rel] = (_sha256(effects.state_dir() / rel)
                                        if effects.exists(rel) else None)
    expected = {"head": before.get("prior_head"),
                "config_sha256": before.get("prior_config_sha256"),
                "checkout_status": before.get("checkout_status"),
                "units": before.get("units")}
    expected.update({"preserved/" + rel: before.get("preserved/" + rel)
                     for rel in PRESERVED})
    changed = sorted(key for key in expected if observed[key] != expected[key])
    return {"unchanged": not changed, "changed": changed, "observed": observed}


def helper_precheck(helper_module, root: Path, overlay: dict, target: str,
                    tag: str) -> None:
    """The helper's own pure input validation (root/overlay binding, target
    SHA, annotated-tag pattern and binding, destination config render),
    run BEFORE the durable intent so a bad input is a plain no-change
    refusal. Calls the accepted helper's functions; never re-implements
    its patterns. Read-only: git reads and an in-memory render."""
    try:
        helper_module.root_check(root, overlay)
        helper_module.verify_target(root, target, tag)
        helper_module.render(root, overlay, target)
    except (ValueError, KeyError, TypeError, AttributeError, OSError,
            subprocess.CalledProcessError) as exc:
        detail = str(exc) or type(exc).__name__
        if isinstance(exc, subprocess.CalledProcessError):
            detail = "git check failed: " + " ".join(map(str, exc.cmd[3:6]))
        raise Refused("helper input validation refused before any change: "
                      + detail[:300]) from exc


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_queue(effects: Effects) -> dict:
    """The queue ledger's JSON-object root, or ValueError/OSError.

    The single read both drain and rollback compatibility reason from: a
    missing file (FileNotFoundError), invalid JSON or a non-object root
    (``null``, a list, a bare string) is unreadable for both, never empty.
    """
    queue = effects.read_json("queue.json")
    if not isinstance(queue, dict):
        raise ValueError("queue.json root is " + type(queue).__name__
                         + ", not a JSON object")
    if not isinstance(queue.get("items", []), list):
        raise ValueError("queue.json items is not a JSON array")
    return queue


def compatibility_record(effects: Effects, target_sha: str) -> dict:
    """Read-only rollback-compatibility evidence for the CURRENT->TARGET move.

    The controller cannot execute the prior target's parser, so it records
    observable state-shape facts an owner needs: the queue schema marker and
    the state keys the current queue carries. Any observation the controller
    cannot prove readable by the recorded prior target (an explicit schema
    marker, an ``author_*`` state key, an unreadable queue) disables
    automatic rollback (owner decision, never a silent restore). Receipts
    under state/runs are append-only artifacts both versions read
    defensively.
    """
    record = {"checked": True, "schema_observations": [],
              "schema_marker_present": False, "queue_schema": None}
    try:
        # A missing queue or a non-object root is evidence never read: it is
        # unreadable here exactly as drain_check refuses it (#548).
        queue = read_queue(effects)
    except (ValueError, OSError) as exc:
        record["queue_schema"] = "unreadable: " + str(exc)[:120]
        record["schema_marker_present"] = True  # unprovable: fail closed
    else:
        if "schema_version" in queue:
            # Presence is recorded separately from the value: ANY explicit
            # marker (including the literal string "unmarked" or another
            # unknown value) disables automatic rollback, because the
            # prior target's reader was never proven against it.
            record["schema_marker_present"] = True
            record["queue_schema"] = queue["schema_version"]
        for key in sorted(queue):
            if key.startswith("author_"):
                record["schema_observations"].append(key)
    record["target_sha"] = target_sha
    return record


def preflight(effects: Effects, target: str, tag: str) -> dict:
    """Everything checked before the helper is invoked. No mutation."""
    if not SHA_RE.match(target or ""):
        raise Refused("--sha must be a full 40-hex commit SHA")
    if not TAG_RE.fullmatch(tag or ""):
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
        queue = read_queue(effects)
    except (ValueError, OSError) as exc:
        raise Refused("queue unreadable, refusing to reason about drain: "
                      + str(exc)[:160]) from None
    runs = effects.state_dir() / "runs"
    blocked = []
    for item in queue.get("items", []):
        if not isinstance(item, dict):
            blocked.append({"item": None, "state": "ambiguous",
                            "reason": "malformed queue item"})
            continue
        if item.get("run") is None and "run" not in item:
            continue  # genuinely unstarted: no recorded run to probe
        r = item.get("run")
        if r is None:
            continue  # the runner's own terminal/consumed marker: run is gone
        if not isinstance(r, dict):
            # A damaged record proves nothing about the process; the drain is
            # fail closed: block as ambiguous until the owner disposes it.
            blocked.append({"item": item.get("id"), "state": "ambiguous",
                            "reason": "malformed recorded run metadata"})
            continue
        run_id = r.get("run_id")
        if (not isinstance(run_id, str) or len(run_id) > 255
                or not RUN_ID_RE.fullmatch(run_id)):
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


def runner_queue_drain(effects: Effects) -> dict:
    """The controller's queue drain bound to the runner's own liveness probe.

    This is the existing ``drain_check`` driven by ``_runner_liveness`` (which
    executes the checkout's actual ``crq.run_liveness``), never a second
    ownership model. It only observes; no process or state is signalled.
    """
    return drain_check(effects, _runner_liveness(effects))


def queue_drain_gate(effects: Effects) -> dict:
    """Refuse a unit transaction while recorded queue work is live/ambiguous.

    Callers invoke this before any unit mutation or journal write, so a
    refusal leaves installed units, activation, preserved queue bytes and
    retained records unchanged. Both the switch and recovery entry points call
    it independently; the guest adapter observes the same queue again after its
    systemd fence. That second point-in-time observation narrows the dispatch
    window but does not close it.
    """
    drain = runner_queue_drain(effects)
    if not drain["drained"]:
        raise QueueDrainRefused(
            "queue-owned work is alive or ambiguous; refusing unit "
            "transaction before activation: "
            + json.dumps(drain["blocked"], sort_keys=True)[:400], drain)
    return drain


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


# crq.py iso() shape exactly: zero-padded calendar fields, UTC Z, no
# subsecond digits and no offset. Matching the shape is not calendar
# validation; _strict_tick adds that.
TICK_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")


def _strict_tick(value: str) -> bool:
    """Producer-shaped AND calendar-real: strptime rejects 2026-02-30,
    month 13, hour 24 — shapes that merely look like timestamps never pass."""
    if not TICK_RE.match(value):
        return False
    try:
        _parse_iso(value)
    except ValueError:
        return False
    return True


def _tick_value(effects: Effects) -> str:
    """The last COMPLETED tick, read only from the runner's completion
    heartbeat.

    crq.py assigns queue.last_tick before dispatch and save_queue persists
    it before write_status; write_heartbeat atomically replaces the
    completion heartbeat only after status publication. Advancing queue
    saves therefore prove nothing about completed ticks and are never read
    here, and a heartbeat that does not name this checkout's runner
    directory is some other deployment's completion, not this one's.
    """
    heartbeat = effects.read_completion_heartbeat()
    if heartbeat is None:
        raise Refused("no completion heartbeat observed under the runner's "
                      "WATCHDOG_HOME; cannot assess health")
    expected_root = str(effects.root / "apps/crq-python")
    root = heartbeat.get("root")
    if root != expected_root:
        raise Refused("completion heartbeat root " + repr(root)[:80]
                      + " is not this checkout's runner directory "
                      + repr(expected_root))
    value = heartbeat.get("last_tick")
    if not isinstance(value, str) or not _strict_tick(value):
        raise Refused("completion heartbeat last_tick " + repr(value)[:80]
                      + " is not a strict UTC YYYY-MM-DDTHH:MM:SSZ timestamp")
    return value


RECEIPT_SAMPLE = 10
RECEIPT_NAME_RE = re.compile(r"[0-9a-f]{64}\.json")
# Builtin fallback only: the deployment's own review_receipt.py constants are
# preferred (receipt_schema); this copy is used, and recorded as such, when
# they cannot be read statically.
RECEIPT_POLICY = "affected-current-additions-v1"
RECEIPT_TARGETS = ("promoted-main", "merge-queue")
RECEIPT_VERSION = 1
RECEIPT_COUNTED_OUTCOMES = ("terminal-clean", "terminal-with-findings", "partial-scope")
RECEIPT_RESOLUTIONS = ("same-path-current", "git-rename-M50")
RECEIPT_DISPOSITIONS = ("included", "renamed", "deleted", "unsupported",
                        "ambiguous", "excluded-with-reason")
# Receipt families sharing state/receipts. merged-current and push-range are
# crq.current_document() receipts (``version``); push items differ only in
# their source subject (push_current._enroll) and may defer overflow paths to
# a follow-up part. Local reviews (local_review_runtime.complete) are a
# separate ``v``/``kind`` document checked against the deployment's
# policy/review-operation.schema.json, read as data and never executed.
FAMILY_MERGED = "merged-current"
FAMILY_PUSH = "push-range"
FAMILY_LOCAL = "local-review-full-diff"
# push_current.prepare: out-of-repo-scope rows stay in the manifest as
# excluded-config; scope-cap overflow is deferred-split to a follow-up part.
PUSH_DISPOSITIONS = RECEIPT_DISPOSITIONS + ("excluded-config", "deferred-split")
LOCAL_REVIEW_SCHEMA = "policy/review-operation.schema.json"
_REPO_RE = re.compile(r"[\w.-]+/[\w.-]+")
_HEX40 = re.compile(r"[0-9a-f]{40}")
_HEX64 = re.compile(r"[0-9a-f]{64}")


def _hex(pattern, value) -> bool:
    return isinstance(value, str) and bool(pattern.fullmatch(value))


def _text(value) -> bool:
    return isinstance(value, str) and bool(value)


def _newest(entries, limit: int) -> list:
    """The ``limit`` most recently modified entries (ties by name), so a
    sample taken after a switch covers what the new runner wrote."""
    def key(entry):
        try:
            mtime = entry.stat().st_mtime_ns
        except OSError:
            mtime = -1  # unstattable: still sampleable, never preferred
        return (-mtime, entry.name)
    return sorted(entries, key=key)[:limit]


_NOT_LITERAL = ("not-literal",)


def _store_names(node) -> list:
    """Names a statement binds at module scope, without entering nested
    function/class bodies (whose own names are bound, their locals not)."""
    names, stack = [], [node]
    while stack:
        current = stack.pop()
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.append(current.name)
            continue
        if isinstance(current, (ast.Import, ast.ImportFrom)):
            names.extend((alias.asname or alias.name).split(".")[0]
                         for alias in current.names)
            continue
        if isinstance(current, ast.Name) and isinstance(current.ctx, (ast.Store, ast.Del)):
            names.append(current.id)
        stack.extend(ast.iter_child_nodes(current))
    return names


def _module_bindings(path: Path) -> dict:
    """The FINAL module-level binding of every name, read statically (never
    executed): a literal assignment node, a ``from runtime_target import``,
    or _NOT_LITERAL for anything else (a later non-literal rebinding makes an
    earlier literal unresolved). Raises OSError/SyntaxError if unusable."""
    tree = ast.parse(path.read_text(), filename=str(path))
    bindings = {}
    for node in tree.body:
        if (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
                and isinstance(node.value, (ast.Constant, ast.Dict))):
            bindings[node.targets[0].id] = ("literal", node.value)
            continue
        if (isinstance(node, ast.ImportFrom) and node.level == 0
                and node.module == "runtime_target"):
            for alias in node.names:
                bindings[alias.asname or alias.name] = ("runtime_target", alias.name)
            continue
        for name in _store_names(node):
            bindings[name] = _NOT_LITERAL
    return bindings


class _Constants:
    """Lazily resolve only the requested names, so an unrelated module-level
    value the parser cannot evaluate never affects the schema."""

    def __init__(self, runner: Path):
        self.runner = runner
        self.modules = {}

    def bindings(self, module: str) -> dict:
        if module not in self.modules:
            self.modules[module] = _module_bindings(self.runner / (module + ".py"))
        return self.modules[module]

    def resolve(self, module: str, name: str, depth: int = 0):
        if depth > 8:
            raise ValueError("constant resolution too deep at " + name)
        binding = self.bindings(module).get(name)
        if binding is None:
            raise ValueError(module + "." + name + " is not defined")
        if binding is _NOT_LITERAL:
            raise ValueError(module + "." + name + " is not a module-level literal")
        if binding[0] == "runtime_target":
            return self.resolve("runtime_target", binding[1], depth + 1)
        value = binding[1]
        if isinstance(value, ast.Constant):
            return value.value
        keys = []
        for key in value.keys:
            if isinstance(key, ast.Constant):
                keys.append(key.value)
            elif isinstance(key, ast.Name):
                keys.append(self.resolve(module, key.id, depth + 1))
            else:
                raise ValueError("unresolvable key in " + module + "." + name)
        return {"keys": keys}


def receipt_schema(effects: Effects) -> dict:
    """Receipt policy/version/target selectors from THIS deployment's
    review_receipt.py (and runtime_target.py), parsed read-only with ast so
    nothing from the checkout executes outside the controller lock. Falls
    back to the builtin copy with the reason recorded in ``schema_source``.
    """
    runner = effects.root / "apps/crq-python"
    try:
        constants = _Constants(runner)
        policy = constants.resolve("review_receipt", "POLICY")
        version = constants.resolve("review_receipt", "VERSION")
        selectors = constants.resolve("review_receipt", "SELECTORS")
        if not isinstance(selectors, dict):
            raise ValueError("review_receipt.SELECTORS is not a dict literal")
        targets = tuple(selectors["keys"])
        if (not isinstance(policy, str) or type(version) is not int or not targets
                or not all(isinstance(t, str) for t in targets)):
            raise ValueError("unexpected constant types")
        schema = {"schema_source": "deployment:apps/crq-python/review_receipt.py",
                  "policy": policy, "version": version, "targets": targets}
    except (OSError, SyntaxError, ValueError, KeyError, TypeError) as exc:
        schema = {"schema_source": "builtin (deployment constants unavailable: "
                                   + type(exc).__name__ + ": " + str(exc)[:80] + ")",
                  "policy": RECEIPT_POLICY, "version": RECEIPT_VERSION,
                  "targets": RECEIPT_TARGETS}
    return {**schema, **local_review_schema(effects.root)}


def local_review_schema(root: Path) -> dict:
    """The deployment's local-review receipt rule, read as JSON data.

    There is no builtin copy: when the file or its ``receipt`` variant is
    unusable, ``local_review`` is None and every local-review receipt in the
    sample is reported as unverified rather than silently accepted.
    """
    try:
        document = json.loads((root / LOCAL_REVIEW_SCHEMA).read_text())
        rules = [variant["properties"]["value"] for variant in document["oneOf"]
                 if variant["properties"]["type"].get("const") == "receipt"]
        if len(rules) != 1 or not isinstance(rules[0], dict):
            raise ValueError("expected exactly one receipt variant")
        return {"local_review": rules[0],
                "local_review_source": "deployment:" + LOCAL_REVIEW_SCHEMA}
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        return {"local_review": None,
                "local_review_source": "unavailable: " + type(exc).__name__
                                       + ": " + str(exc)[:80]}


_SCHEMA_KEYWORDS = {"$schema", "oneOf", "type", "const", "enum", "required", "properties",
                    "additionalProperties", "items", "minItems", "maxItems", "minimum",
                    "minLength", "pattern"}
_SCHEMA_TYPES = {"object": dict, "array": list, "string": str, "integer": int,
                 "boolean": bool, "null": type(None)}


def schema_problem(value, rule: dict, at: str = "") -> str | None:
    """Evaluate the checked-in schema vocabulary exactly as
    review_ledger._schema does (fail closed on any other keyword), returning
    the first violation with its location instead of raising."""
    where = at or "receipt"
    if set(rule) - _SCHEMA_KEYWORDS:
        return where + ": unsupported schema keyword"
    if "oneOf" in rule:
        matches = sum(schema_problem(value, branch, at) is None for branch in rule["oneOf"])
        return None if matches == 1 else where + ": does not match exactly one variant"
    expected = rule.get("type")
    if expected and type(value) not in [_SCHEMA_TYPES[t] for t in (
            expected if isinstance(expected, list) else [expected])]:
        return where + ": type mismatch"
    if "const" in rule and value != rule["const"] or "enum" in rule and value not in rule["enum"]:
        return where + ": value mismatch"
    if isinstance(value, dict):
        missing = sorted(set(rule.get("required", [])) - value.keys())
        if missing:
            return where + ": missing " + ",".join(missing)
        properties = rule.get("properties", {})
        unknown = sorted(value.keys() - properties.keys())
        if rule.get("additionalProperties") is False and unknown:
            return where + ": unknown " + ",".join(unknown)
        for key in sorted(value.keys() & properties.keys()):
            problem = schema_problem(value[key], properties[key], (at + "." if at else "") + key)
            if problem:
                return problem
    if isinstance(value, list):
        if len(value) < rule.get("minItems", 0) or len(value) > rule.get("maxItems", len(value)):
            return where + ": array bound"
        for index, item in enumerate(value):
            problem = schema_problem(item, rule.get("items", {}), where + "[" + str(index) + "]")
            if problem:
                return problem
    if isinstance(value, str):
        if len(value) < rule.get("minLength", 0) or (
                "pattern" in rule and not re.fullmatch(rule["pattern"], value)):
            return where + ": string bound"
    if type(value) is int and "minimum" in rule and value < rule["minimum"]:
        return where + ": below minimum"
    return None


def receipt_family(doc: dict) -> str:
    """Which writer produced a parsed receipt (never a validity verdict)."""
    if "kind" in doc or "v" in doc:
        kind = doc.get("kind")
        return kind if isinstance(kind, str) and kind else "unknown"
    source = doc.get("source")
    if isinstance(source, dict) and source.get("type") == FAMILY_PUSH:
        return FAMILY_PUSH
    return FAMILY_MERGED


def _canonical_digest(value) -> str:
    """review_receipt.digest: sha256 of the canonical JSON encoding."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=True).encode("utf-8")).hexdigest()


def local_review_problem(doc: dict, rule: dict | None) -> str | None:
    """A local-review-full-diff receipt against the deployment schema plus
    the bindings local_review_runtime.complete() always writes."""
    if rule is None:
        return "local-review: unverified, deployment receipt schema unavailable"
    problem = schema_problem(doc, rule)
    if problem:
        return "local-review schema: " + problem
    if doc["identity"] != _canonical_digest(doc["identity_inputs"]):
        return "local-review identity: identity is not the digest of identity_inputs"
    if doc["scope_adequate"] and doc["outcome"] != ("findings" if doc["findings"] else "clean"):
        return "local-review outcome: adequate scope with an outcome that contradicts findings"
    if not doc["scope_adequate"] and doc["outcome"] in ("clean", "findings"):
        return "local-review outcome: verdict recorded without adequate scope"
    return None


def _push_source_problem(source, schema: dict) -> str | None:
    """push_current._enroll's subject: a pinned (base, head] range."""
    if not (isinstance(source, dict) and source.get("type") == FAMILY_PUSH
            and _text(source.get("repo")) and _REPO_RE.fullmatch(source["repo"])
            and _hex(_HEX40, source.get("base")) and _hex(_HEX40, source.get("head"))
            and source.get("policy") == schema["policy"]):
        return "target: source binding is not a v1 push-range subject"
    paths_filter = source.get("paths_filter")
    if paths_filter is not None and not (isinstance(paths_filter, list) and paths_filter
                                         and all(_text(p) for p in paths_filter)):
        return "target: malformed push-range paths_filter"
    if "pin" in source and not _hex(_HEX40, source["pin"]):
        return "target: push-range pin is not a 40-hex SHA"
    return None


def receipt_problem(name: str, data: bytes, schema: dict | None = None) -> str | None:
    """Why a retained receipt is not a valid receipt of its family, or None.

    Every family first proves its immutable content identity
    (review_receipt.read_receipt). merged-current and push-range receipts
    then mirror the stable receipt contract read-only and offline: the TS
    QueueReceiptSchema (src/ops/review/internal/queueEvidence.ts) and its
    scope-digest check, grouped as run identity, captured target and terminal
    outcome; they differ only in the source binding. local-review receipts are
    checked by local_review_problem. Never imports runner code and never
    grants review credit. ``schema`` is ``receipt_schema()`` output; the
    builtin copy (with no local-review rule) when omitted.
    """
    schema = schema or {"policy": RECEIPT_POLICY, "version": RECEIPT_VERSION,
                        "targets": RECEIPT_TARGETS}
    if hashlib.sha256(data).hexdigest() + ".json" != name:
        return "content identity: sha256 does not match the receipt name"
    try:
        doc = json.loads(data)
    except ValueError:
        return "malformed: not valid JSON"
    if not isinstance(doc, dict):
        return "malformed: not a JSON object"
    family = receipt_family(doc)
    if family == FAMILY_LOCAL:
        return local_review_problem(doc, schema.get("local_review"))
    if family not in (FAMILY_MERGED, FAMILY_PUSH):
        return "unsupported receipt family: " + family[:60]
    if doc.get("version") != schema["version"]:
        return "unsupported receipt version"
    # Run identity: the queue item, and the run when one was launched.
    run_id = doc.get("run_id")
    if not _text(doc.get("item_id")):
        return "run identity: missing item_id"
    if run_id is not None and not (_text(run_id) and len(run_id) <= 255
                                   and RUN_ID_RE.fullmatch(run_id)):
        return "run identity: malformed run_id"
    if not (doc.get("request_id") is None or isinstance(doc.get("request_id"), str)):
        return "run identity: malformed request_id"
    if not (doc.get("started_at") is None or isinstance(doc.get("started_at"), str)):
        return "run identity: malformed started_at"
    # Captured target: the bound source and the pinned capture it reviewed.
    source, capture = doc.get("source"), doc.get("capture")
    if family == FAMILY_PUSH:
        problem = _push_source_problem(source, schema)
        if problem:
            return problem
    elif not (isinstance(source, dict)
              and _text(source.get("repo"))
              and _REPO_RE.fullmatch(source["repo"])
              and type(source.get("pr")) is int and source["pr"] > 0
              and _hex(_HEX40, source.get("merge_sha"))
              and source.get("target_selector") in schema["targets"]
              and source.get("policy") == schema["policy"]):
        return "target: source binding is not a v1 merged-current subject"
    dispositions = PUSH_DISPOSITIONS if family == FAMILY_PUSH else RECEIPT_DISPOSITIONS
    if not (isinstance(capture, dict)
            and _hex(_HEX40, capture.get("target"))
            and _hex(_HEX40, capture.get("tree"))):
        return "target: captured target/tree is not a pinned 40-hex SHA"
    paths = capture.get("paths")
    if not (isinstance(paths, list) and all(
            isinstance(entry, dict) and _text(entry.get("source_path"))
            and _text(entry.get("path"))
            and entry.get("resolution") in RECEIPT_RESOLUTIONS
            and entry.get("disposition") in dispositions for entry in paths)):
        return "target: malformed captured path manifest"
    canonical = json.dumps(paths, sort_keys=True, separators=(",", ":"),
                           ensure_ascii=True).encode("utf-8")
    if capture.get("scope_digest") != hashlib.sha256(canonical).hexdigest():
        return "target: scope digest does not match the path manifest"
    if not (_hex(_HEX64, capture.get("equivalence"))
            and capture.get("policy") == schema["policy"]
            and capture.get("projection")
            == "current-affected-files/full-file-addition-projection"
            and capture.get("reviewer") == "coderabbit-review-agent-committed-v1"
            and _text(capture.get("reviewer_version"))
            and isinstance(capture.get("captured_at"), str)):
        return "target: unsupported capture policy/reviewer"
    # Terminal outcome: a recorded verdict; counted credit needs a completed run.
    outcome, counted, cls = doc.get("outcome"), doc.get("counted"), doc.get("classification")
    if not _text(outcome) or outcome in ("pending", "reviewing"):
        return "terminal outcome: missing or non-terminal outcome"
    if not isinstance(counted, bool):
        return "terminal outcome: counted is not a boolean"
    if not (cls is None or isinstance(cls, dict)):
        return "terminal outcome: malformed classification"
    if counted and not (outcome in RECEIPT_COUNTED_OUTCOMES and run_id is not None
                        and isinstance(cls, dict) and cls.get("counted") is True
                        and cls.get("outcome") == "completed"):
        return "terminal outcome: counted without a completed classified run"
    artifacts = doc.get("artifacts")
    if not (isinstance(doc.get("findings"), list)
            and all(isinstance(f, dict) for f in doc["findings"])
            and isinstance(artifacts, dict)
            and all(_hex(_HEX64, v) for v in artifacts.values())
            and doc.get("remediation") == "disabled/deferred"
            and doc.get("independent_acceptance") is False
            and doc.get("cli_functional_acceptance") == "pending-D1"):
        return "malformed: findings/artifacts/acceptance fields"
    return None


def receipt_validation(effects: Effects) -> dict | None:
    """Validate a bounded sample of retained receipts (state/receipts).

    ``valid`` is its own verdict: None when nothing was sampled, never a
    tick failure and never review credit.
    """
    root = effects.state_dir() / "receipts"
    if not root.is_dir():
        return None
    names = [entry.name for entry in _newest(
        [e for e in root.iterdir() if RECEIPT_NAME_RE.fullmatch(e.name)], RECEIPT_SAMPLE)]
    schema = receipt_schema(effects)
    invalid, families = [], {}
    for name in names:
        family = "unreadable"
        try:
            data = (root / name).read_bytes()
            problem = receipt_problem(name, data, schema)
            try:
                doc = json.loads(data)
                family = receipt_family(doc) if isinstance(doc, dict) else "malformed"
            except ValueError:
                family = "malformed"
        except OSError as exc:
            problem = "unreadable: " + str(exc)[:80]
        families[family] = families.get(family, 0) + 1
        if problem:
            invalid.append({"receipt": name[:-5], "family": family, "reason": problem})
    return {"sampled": len(names), "valid_count": len(names) - len(invalid),
            "invalid": invalid, "valid": (not invalid) if names else None,
            "families": families, "schema_source": schema["schema_source"],
            "local_review_schema_source": schema["local_review_source"]}


# Artifacts crq.launch() writes before meta.json: a run directory holding only
# these is a review that never launched (secret scan blocked, or worktree
# checkout refused), not lost metadata.
PRELAUNCH_ARTIFACTS = frozenset({"secret-scan.json", "context-secret-scan.json"})


def run_metadata_problem(entry: Path) -> str | None:
    """Why a run directory's metadata is unusable; None when meta.json
    parses, or when the run is an expected pre-launch stop (``"prelaunch"``
    is returned for that case so callers can count it separately)."""
    meta = entry / "meta.json"
    try:
        if meta.is_file():
            json.loads(meta.read_text())
            return None
        names = {child.name for child in entry.iterdir()}
        if not names:
            return "missing meta.json: empty run directory"
        if names <= PRELAUNCH_ARTIFACTS and "secret-scan.json" in names:
            for name in sorted(names):
                if not isinstance(json.loads((entry / name).read_text()), dict):
                    return "corrupt pre-launch artifact: " + name
            return "prelaunch"
        return "missing meta.json alongside " + ",".join(sorted(names))[:120]
    except ValueError:
        return "corrupt: unparseable " + (meta.name if meta.is_file() else "pre-launch artifact")
    except OSError as exc:
        return "unreadable: " + str(exc)[:80]


def run_metadata_sample(effects: Effects) -> dict | None:
    """The newest run directories' metadata (state/runs). Non-directory
    entries (e.g. AppleDouble ``._*`` copies) are not runs: they are counted
    under ``ignored_entries`` and never sampled."""
    runs = effects.state_dir() / "runs"
    if not runs.is_dir():
        return None
    entries, ignored = [], 0
    for entry in runs.iterdir():
        if entry.is_dir():
            entries.append(entry)
        else:
            ignored += 1
    readable, prelaunch, unreadable = 0, 0, []
    for entry in _newest(entries, RECEIPT_SAMPLE):
        problem = run_metadata_problem(entry)
        if problem is None:
            readable += 1
        elif problem == "prelaunch":
            prelaunch += 1
        else:
            unreadable.append({"run": entry.name, "reason": problem})
    return {"sampled": readable + prelaunch + len(unreadable), "readable": readable,
            "prelaunch": prelaunch, "unreadable": unreadable, "ignored_entries": ignored}


def health_observation(effects: Effects, prior_tick: str) -> dict:
    """One health observation against the requested prior tick.

    Advancement is lexicographic on the strict UTC timestamps (they sort
    chronologically), never a wall-clock delta. Two independent receipt
    verdicts ride along: ``receipts_readable`` (state/runs/*/meta.json parse;
    pre-launch stops are expected, named missing/corrupt entries are not)
    and ``receipts_valid`` (state/receipts family schema sample). Neither
    affects advancement; neither grants review credit.
    """
    _parse_iso(prior_tick)
    current = _tick_value(effects)
    _parse_iso(current)
    advanced = current > prior_tick
    receipt_sample = run_metadata_sample(effects)
    validation = receipt_validation(effects)
    return {"observed_tick": current, "advanced": advanced,
            "receipts": receipt_sample,
            "receipts_readable": (not receipt_sample["unreadable"]
                                  if receipt_sample and receipt_sample["sampled"] else None),
            "receipt_validation": validation,
            "receipts_valid": validation["valid"] if validation else None}


def wait_for_first_tick(effects: Effects, prior_tick: str, timeout: float,
                        *, sleep=time.sleep, clock=time.monotonic) -> dict:
    """Bounded polling for a completed tick; no deployment mutations."""
    deadline = clock() + timeout
    while True:
        observation = health_observation(effects, prior_tick)
        remaining = deadline - clock()
        if observation["advanced"] or remaining <= 0:
            return observation
        sleep(min(5, remaining))


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
                "observations": [first], **_receipt_verdicts([first])}
    second_tick = first["observed_tick"]
    second = observe(second_tick)
    if not second.get("advanced"):
        return {"healthy": False, "reason": "second observation did not advance past "
                                            + second_tick,
                "observations": [first, second], **_receipt_verdicts([first, second])}
    return {"healthy": True, "observations": [first, second],
            **_receipt_verdicts([first, second])}


def _verdict(values) -> bool | None:
    """False if any observation failed, None if none observed, else True."""
    seen = [value for value in values if value is not None]
    if not seen:
        return None
    return all(value is True for value in seen)


def _receipt_verdicts(observations) -> dict:
    """Receipt verdicts, distinct from ``healthy`` (tick advancement only)."""
    return {key: _verdict(o.get(key) for o in observations)
            for key in ("receipts_readable", "receipts_valid")}


# ----------------------------------------------------------------- rollback


def rollback_compatible(record: dict) -> bool:
    """Automatic rollback is permitted only against a queue with NO explicit
    schema_version marker and no ``author_*`` state keys: the one shape the
    recorded prior target is known to read.

    The marker's PRESENCE is a boolean recorded by ``compatibility_record``;
    its VALUE is never interpreted (an explicit ``"unmarked"`` string or any
    other unknown marker is still an explicit marker). Fail closed: a
    missing/unchecked/malformed record, a truthy observation list, a present
    marker of any value, or a non-boolean presence field all disable
    automatic rollback; the operator decides instead."""
    if not isinstance(record, dict) or not record.get("checked"):
        return False
    if record.get("schema_observations"):
        return False
    present = record.get("schema_marker_present")
    if present is not False:  # only a literal boolean False proves absence
        return False
    return True


# --------------------------------------------------------------------- plan


@contextlib.contextmanager
def mutation_record(effects: Effects, operation: str, state: dict, target: str,
                    tag: str, prior_tag: str | None, helper_sha256: str | None = None):
    """Persist recovery identity BEFORE calling the mutating helper.

    Exception translation is confined to this mutation boundary: every failure
    after entry, including an unexpected exception or interruption, is surfaced
    with recovery evidence rather than a false no-change refusal. Updating that
    evidence may also fail; retain the prewritten intent and report both errors.
    """
    identity = {"schema_version": JOURNAL_SCHEMA, "at": now_iso(),
                "transaction_id": uuid.uuid4().hex,
                "intended_operation": operation, "prior_state": state,
                "prior_head": state["prior_head"],
                "prior_config_sha256": state["prior_config_sha256"],
                "prior_tag": prior_tag, "target": target, "tag": tag,
                "helper_sha256": helper_sha256,
                "automatic_rollback_permitted": False,
                "rollback_compatibility": {}}
    intent = {**identity, "operation": operation + "_pending", "outcome": "pending"}
    try:
        path = effects.journal_append(intent)
    except (Refused, OSError, ValueError) as exc:
        raise Refused("cannot persist pre-switch recovery intent: " + str(exc)) from exc
    transaction = {"path": path, "id": identity["transaction_id"], "phase": "helper"}
    try:
        yield transaction
    except (Exception, KeyboardInterrupt) as exc:
        if transaction["phase"] == "helper" and isinstance(exc, Exception):
            _refuse_if_unchanged(effects, identity, state, path, exc)
        recovery = {**identity, "operation": "recovery_required",
                    "outcome": "recovery_required", "failed_phase": transaction["phase"],
                    "reason": type(exc).__name__ + ": " + str(exc)[:400],
                    "record_path": str(path), "record_persisted": False}
        try:
            recovery["observed_head"] = effects.git("rev-parse", "HEAD")
        except (Exception, KeyboardInterrupt) as observation_error:
            recovery["head_observation_error"] = (type(observation_error).__name__ + ": "
                                                  + str(observation_error)[:400])
        try:
            effects.journal_replace(path, {**recovery, "record_persisted": True})
            recovery["record_persisted"] = True
        except (Exception, KeyboardInterrupt) as record_error:
            # Not suppressed: the CLI includes this second failure and the
            # durable intent path so an owner can recover without a journal lie.
            recovery["record_write_error"] = (type(record_error).__name__ + ": "
                                               + str(record_error)[:400])
        raise RecoveryRequired(recovery) from exc


def _refuse_if_unchanged(effects: Effects, identity: dict, state: dict,
                         path: Path, exc: Exception) -> None:
    """A helper exception with every surface observed unchanged is a
    no-change refusal (#832): record ``refused_no_change`` with the
    observations and raise Refused. Returns (so the caller reports
    recovery_required) on any observed change or observation failure."""
    try:
        observation = no_change_observation(effects, state)
    except Exception:  # unobservable: never an absence proof
        return
    if not observation["unchanged"]:
        return
    reason = type(exc).__name__ + ": " + str(exc)[:400]
    refused = {**identity, "operation": identity["intended_operation"] + "_refused",
               "outcome": "refused_no_change", "failed_phase": "helper",
               "reason": reason, "observations": observation["observed"],
               "record_path": str(path), "record_persisted": False}
    try:
        effects.journal_replace(path, {**refused, "record_persisted": True})
        refused["record_persisted"] = True
        where = "recorded refused_no_change at " + str(path)
    except (Exception, KeyboardInterrupt) as record_error:
        refused["record_write_error"] = (type(record_error).__name__ + ": "
                                         + str(record_error)[:200])
        where = ("could not record refused_no_change (" + refused["record_write_error"]
                 + "); pending intent retained at " + str(path))
    raise NoChangeRefused("helper refused with HEAD, config, checkout, units and "
                          "preserved state observed unchanged: " + reason + "; "
                          + where, refused) from exc


def runner_units_stopped(helper_module, root):
    """Freeze new dispatch before observing the drain, using the helper's check."""
    try:
        helper_module.inactive(root)
    except Exception as exc:
        raise Refused("runner units must be stopped before checking drain: "
                      + (str(exc) or type(exc).__name__)[:200]) from exc


def deploy_plan(effects: Effects, helper_module, target: str, tag: str,
                overlay_path: Path, helper_sha256: str | None = None) -> dict:
    """Preflight -> drain -> durable intent -> helper -> proofs -> completion.

    Failures after helper entry require owner recovery; they never claim the
    deployment was unchanged. Units are started only by the owner.
    """
    with effects.controller_lock():
        effects.record_preflight()
        refuse_unfinished_transactions(effects)
        pre = preflight(effects, target, tag)
        prior_tag = prior_tag_for(effects, pre["state"]["prior_head"])
        plan = {"preflight": pre, "steps": [], "helper_sha256": helper_sha256}
        runner_units_stopped(helper_module, effects.root)
        drain = drain_check(effects, _runner_liveness(effects))
        plan["steps"].append({"step": "drain", **drain})
        if not drain["drained"]:
            raise Refused("queue-owned reviews alive/ambiguous; drain through the "
                          "documented author-recovery path first: "
                          + json.dumps(drain["blocked"])[:400])
        overlay, raw = helper_module.load_overlay(overlay_path)
        helper_precheck(helper_module, effects.root, overlay, target, tag)
        with mutation_record(effects, "deploy", pre["state"], target, tag, prior_tag,
                             helper_sha256) as tx:
            helper_module.switch(effects.root, overlay, raw, target, tag)
            tx["phase"] = "preservation"
            post = preservation_check(effects, pre["state"])
            plan["steps"].append({"step": "preservation", **post})
            tx["phase"] = "compatibility"
            record = compatibility_record(effects, target)
            plan["rollback_compatibility_after"] = record
            plan["automatic_rollback_permitted"] = rollback_compatible(
                {**pre["rollback_compatibility"], **record})
            journal = deploy_journal(pre["state"], target, tag, plan, prior_tag=prior_tag)
            journal.update(outcome="completed", transaction_id=tx["id"])
            tx["phase"] = "journal"
            effects.journal_replace(tx["path"], journal)
        return plan


# Per-unit adapters are deliberately unavailable in production until a provider
# can bind successful completions to both the unit and its exact runtime.
UNIT_RUNTIMES = frozenset({"crq-tick.service", "crq-slot.service", "crq-repair.service",
                           "crq-publisher.service", "crq-backfill.service",
                           "crq-watchdog.service"})


def _unit_runtime(value):
    return value == "python" or (isinstance(value, str) and
                                  re.fullmatch(r"node:[0-9a-f]{40}", value) is not None)


def _completion(adapter, unit, runtime, previous):
    evidence = adapter.completion(unit, runtime, previous)
    if (not isinstance(evidence, dict) or evidence.get("unit") != unit
            or evidence.get("runtime") != runtime or evidence.get("success") is not True
            or type(evidence.get("sequence")) is not int
            or evidence["sequence"] <= previous):
        raise ValueError("invalid or non-advancing unit completion evidence")
    return evidence


def recover_unit(effects, adapter, path, *, adapter_factory=None):
    """Restore a pre-activation intent; activation ambiguity requires investigation.

    ``adapter_factory(unit, prior_runtime)`` is a composition callback used by
    the production CLI. It is invoked under the controller lock with values the
    controller validated from the one retained record, after the read-only
    queue-drain gate and before snapshot validation, so composition cannot race
    a second record read. Recovery composes for the record's OWN prior runtime:
    the snapshot is authoritative for bytes, modes, ownership and activation,
    and the abandoned target's artifact need not still be installed.
    """
    if adapter is None and adapter_factory is None:
        raise Refused("no unit recovery adapter")
    path = Path(path)
    with effects.controller_lock():
        effects.record_preflight()
        if path.parent != effects.record_dir or path.is_symlink():
            raise Refused("invalid controller transaction record path")
        refuse_unfinished_transactions(effects, exclude=path)
        try:
            record = json.loads(path.read_text())
        except (OSError, ValueError) as exc:
            raise Refused("unreadable unit recovery record") from exc
        if (not isinstance(record, dict) or record.get("operation") != "unit_switch"
                or record.get("outcome") not in ("pending", "recovery_required")
                or type(record.get("schema_version")) is not int
                or record["schema_version"] != JOURNAL_SCHEMA
                or not isinstance(record.get("transaction_id"), str)
                or not re.fullmatch(r"[0-9a-f]{32}", record["transaction_id"])
                or not isinstance(record.get("unit"), str)
                or record["unit"] not in UNIT_RUNTIMES
                or not _unit_runtime(record.get("runtime"))
                or not _unit_runtime(record.get("prior_runtime"))
                or record["runtime"] == record["prior_runtime"]
                or not isinstance(record.get("snapshot"), dict)
                or record["snapshot"].get("runtime") != record["prior_runtime"]
                or "state" not in record
                or record.get("phase") not in ("snapshot", "drained", "activation_pending", "restore_activation_pending")
                or (record["phase"] == "snapshot" and record.get("state") is not None)
                or (record["phase"] in ("drained", "activation_pending") and not isinstance(record.get("state"), dict))
                or (record["phase"] == "restore_activation_pending" and record.get("state") is not None and not isinstance(record["state"], dict))
                or (isinstance(record.get("state"), dict) and any("preserved/" + rel not in record["state"]
                       or (record["state"]["preserved/" + rel] is not None
                           and not _hex(_HEX64, record["state"]["preserved/" + rel]))
                       for rel in PRESERVED))):
            raise Refused("invalid unit recovery record")
        # Recovery re-observes ownership itself; it never assumes the switch's
        # drain or a prior crash left the queue empty. Refusal happens before
        # re-fencing, restore or any journal rewrite.
        queue_drain_gate(effects)
        if adapter_factory is not None:
            adapter = adapter_factory(record["unit"], record["prior_runtime"])
        if adapter is None:
            raise Refused("no unit recovery adapter")
        adapter.validate_snapshot(record["unit"], record["snapshot"])
        try:
            adapter.stop_and_drain(record["unit"])
            if record["phase"] in ("activation_pending", "restore_activation_pending"):
                raise ValueError("activation may have occurred; inspect runtime evidence before recovery")
            adapter.restore(record["unit"], record["snapshot"])
            if record["state"] is not None:
                preservation_check(effects, record["state"])
            record["phase"] = "restore_activation_pending"
            effects.journal_replace(path, record)
            adapter.restore_activation(record["unit"], record["snapshot"])
            completed = {**record, "outcome": "rolled_back"}
            effects.journal_replace(path, completed)
        except (Exception, KeyboardInterrupt) as exc:
            raise RecoveryRequired({**record, "record_path": str(path),
                                    "reason": type(exc).__name__ + ": " + str(exc)[:400]}) from exc
        return completed


_TX_RE = re.compile(r"[0-9a-f]{32}")
_PHASES = ("snapshot", "drained", "activation_pending",
           "restore_activation_pending")
_UNIT_TERMINAL_PHASES = {"completed": "activation_pending",
                         "rolled_back": "restore_activation_pending"}


def _tx_id(value):
    return _hex(_TX_RE, value)


def _tag(value):
    return isinstance(value, str) and TAG_RE.fullmatch(value) is not None


def _tag_or_none(value):
    return value is None or _tag(value)


def _hex64_or_none(value):
    return value is None or _hex(_HEX64, value)


def _plan_shape(value):
    return (isinstance(value, dict)
            and isinstance(value.get("preflight"), dict)
            and isinstance(value.get("steps"), list))


def _checkout_identity(record):
    """The minimum identity every checkout intent/outcome writer emits."""
    return (
        _tx_id(record.get("transaction_id"))
        and _text(record.get("at"))
        and record.get("intended_operation") in ("deploy", "rollback")
        and isinstance(record.get("prior_state"), dict)
        and _hex(SHA_RE, record.get("prior_head"))
        and _hex64_or_none(record.get("prior_config_sha256"))
        and _tag_or_none(record.get("prior_tag"))
        and _hex(SHA_RE, record.get("target"))
        and _tag(record.get("tag"))
        and _hex64_or_none(record.get("helper_sha256"))
        and record.get("automatic_rollback_permitted") is False
        and isinstance(record.get("rollback_compatibility"), dict)
    )


def _checkout_refusal_shape(record):
    return (
        _checkout_identity(record)
        and _text(record.get("failed_phase"))
        and _text(record.get("reason"))
        and isinstance(record.get("observations"), dict)
        and isinstance(record.get("record_path"), str)
        and isinstance(record.get("record_persisted"), bool)
    )


def _checkout_recovery_shape(record):
    return (
        _checkout_identity(record)
        and _text(record.get("failed_phase"))
        and _text(record.get("reason"))
        and isinstance(record.get("record_path"), str)
        and isinstance(record.get("record_persisted"), bool)
        and ("observed_head" not in record
             or _hex(SHA_RE, record["observed_head"]))
        and ("head_observation_error" not in record
             or isinstance(record["head_observation_error"], str))
        and ("record_write_error" not in record
             or isinstance(record["record_write_error"], str))
    )


def _completed_deploy_shape(record):
    return (
        _tx_id(record.get("transaction_id"))
        and _text(record.get("at"))
        and _hex(SHA_RE, record.get("prior_head"))
        and _hex64_or_none(record.get("prior_config_sha256"))
        and _tag_or_none(record.get("prior_tag"))
        and _hex(SHA_RE, record.get("target"))
        and _tag(record.get("tag"))
        and _hex64_or_none(record.get("helper_sha256"))
        and isinstance(record.get("rollback_compatibility"), dict)
        and isinstance(record.get("automatic_rollback_permitted"), bool)
        and _plan_shape(record.get("plan"))
    )


def _legacy_completed_deploy_shape(record):
    return _text(record.get("at")) and _plan_shape(record.get("plan"))


def _completed_rollback_shape(record):
    return (
        _tx_id(record.get("transaction_id"))
        and _text(record.get("at"))
        and _hex(SHA_RE, record.get("to"))
        and _tag(record.get("tag"))
        and _hex64_or_none(record.get("helper_sha256"))
    )


def _legacy_completed_rollback_shape(record):
    return (
        _text(record.get("at"))
        and _hex(SHA_RE, record.get("to"))
        and _tag(record.get("tag"))
    )


def _completion_shape(value):
    return (
        isinstance(value, dict)
        and isinstance(value.get("unit"), str)
        and _unit_runtime(value.get("runtime"))
        and value.get("success") is True
        and type(value.get("sequence")) is int
    )


def _unit_switch_identity(record):
    state = record.get("state")
    phase = record.get("phase")
    return (
        _tx_id(record.get("transaction_id"))
        and _text(record.get("at"))
        and isinstance(record.get("unit"), str)
        and record["unit"] in UNIT_RUNTIMES
        and _unit_runtime(record.get("runtime"))
        and _unit_runtime(record.get("prior_runtime"))
        and record["runtime"] != record["prior_runtime"]
        and "snapshot" in record
        and (state is None or isinstance(state, dict))
        and phase in _PHASES
        and ((phase == "snapshot" and state is None)
             or (phase in ("drained", "activation_pending")
                 and isinstance(state, dict))
             or (phase == "restore_activation_pending"
                 and (state is None or isinstance(state, dict))))
    )


def _unit_switch_shape(record, outcome):
    if not _unit_switch_identity(record):
        return False
    terminal_phase = _UNIT_TERMINAL_PHASES.get(outcome)
    if terminal_phase is not None and record.get("phase") != terminal_phase:
        return False
    if outcome == "pending":
        return True
    if outcome == "completed":
        completions = record.get("completions")
        return (
            isinstance(completions, list)
            and len(completions) == 2
            and all(_completion_shape(item) for item in completions)
            and all(item["unit"] == record["unit"] for item in completions)
            and all(item["runtime"] == record["runtime"] for item in completions)
            and completions[0]["sequence"] < completions[1]["sequence"]
        )
    if outcome == "rolled_back":
        # switch_unit's rollback path records a reason (possibly empty for a
        # bare KeyboardInterrupt); recover_unit's successful recovery path
        # writes the same identity without one.
        return "reason" not in record or isinstance(record.get("reason"), str)
    if outcome == "recovery_required":
        return (_text(record.get("reason"))
                and isinstance(record.get("record_path"), str))
    return False


def _classify_record(path):
    """Classify one retained controller record by its producer-specific shape.

    Classification depends only on the retained record, never on later host
    state: a record cannot become a blocker (or cease to be one) because an
    unrelated transaction changed a unit or the checkout. Pending intents and
    unresolved recovery records are unfinished. Completed/refused history is
    finished only when it matches the minimum identity its producer wrote.
    Unreadable, malformed, unknown, unsupported-schema and unsupported-legacy
    records raise ``Refused`` naming the record; prose notes are never read.
    """
    if path.is_symlink() or not path.is_file():
        raise Refused("invalid controller journal entry: " + path.name)
    try:
        record = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise Refused("unreadable controller journal entry: " + path.name) from exc
    if not isinstance(record, dict):
        raise Refused("invalid controller journal entry: " + path.name)
    if (type(record.get("schema_version")) is not int
            or record["schema_version"] != JOURNAL_SCHEMA):
        raise Refused("unsupported controller journal schema: " + path.name)
    operation = record.get("operation")
    outcome = record.get("outcome")
    if operation == "unit_switch":
        if outcome not in ("pending", "completed", "rolled_back",
                          "recovery_required"):
            raise Refused("invalid unit switch outcome: " + path.name)
        if not _unit_switch_shape(record, outcome):
            raise Refused("invalid unit switch journal: " + path.name)
        if outcome in ("pending", "recovery_required"):
            return "unfinished", operation
        return "finished", operation
    if operation == "deploy":
        if outcome is None:
            if not _legacy_completed_deploy_shape(record):
                raise Refused("invalid completed checkout journal: " + path.name)
            return "finished", operation
        if outcome == "completed":
            if not _completed_deploy_shape(record):
                raise Refused("invalid completed checkout journal: " + path.name)
            return "finished", operation
        raise Refused("invalid checkout journal outcome: " + path.name)
    if operation == "rollback":
        if outcome is None:
            if not _legacy_completed_rollback_shape(record):
                raise Refused("invalid completed checkout journal: " + path.name)
            return "finished", operation
        if outcome == "completed":
            if not _completed_rollback_shape(record):
                raise Refused("invalid completed checkout journal: " + path.name)
            return "finished", operation
        raise Refused("invalid checkout journal outcome: " + path.name)
    if operation in ("deploy_pending", "rollback_pending"):
        if outcome != "pending" or not _checkout_identity(record):
            raise Refused("invalid pending checkout journal: " + path.name)
        return "unfinished", operation
    if operation in ("deploy_refused", "rollback_refused"):
        if outcome != "refused_no_change" or not _checkout_refusal_shape(record):
            raise Refused("invalid refused checkout journal: " + path.name)
        return "finished", operation
    if operation == "recovery_required":
        if outcome != "recovery_required":
            raise Refused("invalid checkout recovery journal: " + path.name)
        if not _checkout_recovery_shape(record):
            raise Refused("unsupported legacy checkout recovery record "
                          "(no verifiable producer identity): " + path.name)
        return "unfinished", operation
    raise Refused("unknown controller journal operation: " + path.name)


def refuse_unfinished_transactions(effects, exclude=None):
    """Symmetric unfinished-transaction guard for both controller seams.

    A pending or unresolved checkout transaction blocks unit switch/recovery,
    and a pending or unresolved unit transaction blocks checkout deploy/
    rollback. ``exclude`` names exactly the record the caller is about to
    recover, so a legitimate recovery does not block itself. Completed,
    refused/no-change and completed/rolled-back unit history does not block.
    A ``recovery_required`` record is never resolved from stored digests: those
    do not cover unit metadata, activation or live work. It remains unfinished
    (or unsupported legacy when its producer identity is incomplete). The guard
    only reads records; record bytes are unchanged.
    """
    for path in sorted(effects.record_dir.glob("controller-*.json")):
        if exclude is not None and path.resolve() == exclude.resolve():
            continue
        status, operation = _classify_record(path)
        if status == "finished":
            continue
        if operation == "unit_switch":
            raise Refused("unfinished unit switch requires recovery: " + path.name)
        if operation in ("deploy_pending", "rollback_pending"):
            raise Refused("unfinished checkout switch requires recovery: " + path.name)
        if operation == "recovery_required":
            raise Refused("unresolved checkout recovery requires out-of-band "
                          "reconciliation: " + path.name)
        raise Refused("unfinished controller transaction: " + path.name)


def switch_unit(effects, adapter, unit, runtime):
    """Execute one unit transaction using a trusted, injected host adapter.

    Adapter preflight must establish artifact identity, provider availability and
    the current pointer without mutation. Its stop/drain fence must prevent new
    work until start. Snapshot/restore retain exact installed unit bytes and
    activation state. validate_snapshot rejects invalid types and paths before
    any mutation. Completion sequences are monotonic for each unit.
    """
    if unit not in UNIT_RUNTIMES or not _unit_runtime(runtime):
        raise Refused("invalid unit or runtime")
    if adapter is None:
        raise Refused("no runtime-bound completion evidence provider for unit")
    with effects.controller_lock():
        effects.record_preflight()
        refuse_unfinished_transactions(effects)
        # No journal entry, snapshot or unit mutation precedes this gate: an
        # alive/ambiguous recorded run refuses the transaction as-is.
        queue_drain_gate(effects)
        prior = adapter.preflight(unit, runtime)
        if not isinstance(prior, dict) or not _unit_runtime(prior.get("runtime")):
            raise Refused("invalid prior runtime")
        if prior["runtime"] == runtime:
            raise Refused("unit already selects requested runtime")
        snapshot = adapter.snapshot(unit)
        adapter.validate_snapshot(unit, snapshot)
        identity = {"schema_version": JOURNAL_SCHEMA, "transaction_id": uuid.uuid4().hex,
                    "operation": "unit_switch", "unit": unit, "runtime": runtime,
                    "prior_runtime": prior["runtime"], "outcome": "pending", "at": now_iso(),
                    "snapshot": snapshot, "state": None, "phase": "snapshot"}
        path = effects.journal_append(identity)
        try:
            adapter.stop_and_drain(unit)
            identity = {**identity, "state": captured_state(effects), "phase": "drained"}
            effects.journal_replace(path, identity)
            baseline = adapter.sequence(unit)
            if type(baseline) is not int or baseline < 0:
                raise ValueError("invalid completion baseline")
            adapter.install(unit, runtime)
            preservation_check(effects, identity["state"])
            identity = {**identity, "phase": "activation_pending"}
            effects.journal_replace(path, identity)
            adapter.start(unit)
            first = _completion(adapter, unit, runtime, baseline)
            second = _completion(adapter, unit, runtime, first["sequence"])
            record = {**identity, "outcome": "completed", "completions": [first, second]}
            effects.journal_replace(path, record)
            return record
        except (Exception, KeyboardInterrupt) as exc:
            try:
                adapter.stop_and_drain(unit)
                if identity["phase"] == "activation_pending":
                    raise ValueError("activation may have occurred; inspect runtime evidence before recovery")
                adapter.restore(unit, snapshot)
                if identity["state"] is not None:
                    preservation_check(effects, identity["state"])
                identity = {**identity, "phase": "restore_activation_pending"}
                effects.journal_replace(path, identity)
                adapter.restore_activation(unit, snapshot)
                record = {**identity, "outcome": "rolled_back", "reason": str(exc)[:400]}
                effects.journal_replace(path, record)
            except (Exception, KeyboardInterrupt) as rollback_exc:
                recovery = {**identity, "outcome": "recovery_required", "record_path": str(path),
                            "reason": str(exc)[:200] + "; rollback: " + str(rollback_exc)[:200]}
                try:
                    effects.journal_replace(path, recovery)
                except Exception:
                    pass  # retained pending intent remains the recovery anchor
                raise RecoveryRequired(recovery) from rollback_exc
            raise RecoveryRequired({**record, "record_path": str(path)}) from exc


def prior_tag_for(effects: Effects, sha: str) -> str | None:
    """The annotated crq-runner/ tag matching ``TAG_RE`` that peels to
    ``sha`` in this checkout, or None when no such tag exists. Read-only;
    used to record the prior target's own approval tag in the deploy
    journal."""
    listing = effects.git("tag", "--list", "crq-runner/*",
                          "--format=%(refname:short) %(objecttype)")
    candidates = []
    for line in listing.splitlines():
        parts = line.split()
        if len(parts) != 2 or parts[1] != "tag":
            continue  # lightweight tags are not owner-approval artifacts
        tag = parts[0]
        if not TAG_RE.fullmatch(tag):
            continue  # off-shape names are not recordable prior_tag values
        if effects.git("rev-parse", "refs/tags/" + tag + "^{commit}") == sha:
            candidates.append(tag)
    if len(candidates) == 1:
        return candidates[0]
    if candidates:
        raise Refused("multiple annotated runner tags name the prior target "
                      + sha[:10] + ": " + ", ".join(sorted(candidates)))
    return None


def deploy_journal(prior_state: dict, target: str, tag: str, plan: dict,
                   prior_tag: str | None = None) -> dict:
    """The journal schema (version 1) and the ONLY validated rollback input:
    the prior identity and compatibility evidence live at the TOP LEVEL so a
    rollback can consume the file this controller wrote, with the full step
    detail retained under ``plan``. ``prior_tag`` is the prior target's own
    annotated approval tag; a rollback refuses without it rather than guess."""
    return {"schema_version": JOURNAL_SCHEMA,
            "operation": "deploy",
            "at": now_iso(),
            "prior_head": prior_state.get("prior_head"),
            "prior_config_sha256": prior_state.get("prior_config_sha256"),
            "prior_tag": prior_tag,
            "target": target,
            "tag": tag,
            "helper_sha256": plan.get("helper_sha256"),
            "rollback_compatibility": plan.get("rollback_compatibility_after") or {},
            "automatic_rollback_permitted": plan.get("automatic_rollback_permitted"),
            "plan": plan}


def rollback_target(prior: dict) -> dict:
    """Validate a rollback input (a controller deploy journal) and return its
    prior identity. Refuses anything this controller did not write."""
    if not isinstance(prior, dict) or prior.get("schema_version") != JOURNAL_SCHEMA:
        raise Refused("prior record must be a controller journal with schema_version "
                      + str(JOURNAL_SCHEMA))
    if prior.get("operation") != "deploy":
        raise Refused("prior record must be a completed deploy journal")
    if prior.get("outcome", "completed") != "completed":
        raise Refused("prior record must be a completed deploy journal")
    target = prior.get("prior_head")
    if not target or not SHA_RE.match(target):
        raise Refused("no recorded prior target SHA; refusing blind rollback")
    tag = prior.get("prior_tag")
    if not tag or not TAG_RE.fullmatch(tag):
        raise Refused("prior record lacks the prior target's own annotated runner "
                      "tag (prior_tag); owner must approve and supply it")
    compat = prior.get("rollback_compatibility")
    if not isinstance(compat, dict):
        raise Refused("prior record lacks its rollback compatibility evidence")
    deployed = prior.get("target")
    if not isinstance(deployed, str) or not SHA_RE.fullmatch(deployed):
        raise Refused("prior record lacks a valid deployed target SHA")
    return {"prior_head": target, "tag": tag, "deployed": deployed,
            "rollback_compatibility": compat}


_RUNNER_PROBE = """import importlib.util, json, sys
from pathlib import Path
runner = Path(sys.argv[1])
sys.path.insert(0, str(runner.parent))
spec = importlib.util.spec_from_file_location("crq", runner)
module = importlib.util.module_from_spec(spec)
sys.modules["crq"] = module
spec.loader.exec_module(module)
request = json.load(sys.stdin)
print(json.dumps(module.run_liveness(Path(request["rdir"]), request["item"],
                                    request["run"], request["has_exit"])))
"""


def _runner_liveness(effects):
    # A fresh -I interpreter ignores ambient PYTHONPATH, cwd and user site.
    # Explicit runner source + its directory bind sibling imports without
    # cached modules. -B preserves the helper's checkout cleanliness fence.
    runner = effects.root / "apps/crq-python/crq.py"

    def probe(rdir, item, run, has_exit):
        try:
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-c", _RUNNER_PROBE, str(runner)],
                input=json.dumps({"rdir": str(rdir), "item": item,
                                  "run": run, "has_exit": has_exit}),
                capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                return "ambiguous"
            state = json.loads(result.stdout)
            return state if state in ("alive", "ambiguous", "harvest") else "ambiguous"
        except (OSError, ValueError, subprocess.SubprocessError):
            return "ambiguous"

    return probe


def _refusing_liveness(*_args, **_kwargs):
    return "ambiguous"


def rollback_plan(effects: Effects, helper_module, prior: dict,
                  overlay_path: Path, helper_sha256: str | None = None) -> dict:
    """Owner-approved rollback to the recorded prior target, through the SAME
    helper fence. Consumes exactly the journal ``deploy_plan`` wrote.
    Refuses when the compatibility record disables automatic rollback
    (schema-incompatible prior target)."""
    with effects.controller_lock():
        effects.record_preflight()
        refuse_unfinished_transactions(effects)
        record = rollback_target(prior)
        if effects.git("rev-parse", "HEAD") != record["deployed"]:
            raise Refused("prior record does not describe the current deployment")
        if not rollback_compatible(record["rollback_compatibility"]):
            raise Refused("rollback disabled: queue state the prior target cannot "
                          "provably read (explicit schema marker or author_* state "
                          "keys); operator recovery required (never restore old queue "
                          "snapshots or start incompatible binaries)")
        # The journal predates any state written by the newly deployed runner.
        # Recheck the live queue for the recorded prior reader under this lock.
        live_compatibility = compatibility_record(effects, record["prior_head"])
        if not rollback_compatible(live_compatibility):
            raise Refused("rollback disabled: current queue state the prior target "
                          "cannot provably read; operator recovery required "
                          "(never restore old queue snapshots or start "
                          "incompatible binaries)")
        runner_units_stopped(helper_module, effects.root)
        drain = drain_check(effects, _runner_liveness(effects))
        if not drain["drained"]:
            raise Refused("cannot roll back with live/ambiguous reviews: "
                          + json.dumps(drain["blocked"])[:400])
        state = captured_state(effects)
        prior_tag = prior_tag_for(effects, state["prior_head"])
        overlay, raw = helper_module.load_overlay(overlay_path)
        helper_precheck(helper_module, effects.root, overlay, record["prior_head"],
                        record["tag"])
        with mutation_record(effects, "rollback", state, record["prior_head"],
                             record["tag"], prior_tag, helper_sha256) as tx:
            helper_module.switch(effects.root, overlay, raw, record["prior_head"],
                                 record["tag"])
            tx["phase"] = "preservation"
            preservation_check(effects, state)
            tx["phase"] = "journal"
            effects.journal_replace(tx["path"], {
                "schema_version": JOURNAL_SCHEMA, "operation": "rollback",
                "outcome": "completed", "transaction_id": tx["id"], "at": now_iso(),
                "to": record["prior_head"], "tag": record["tag"],
                "helper_sha256": helper_sha256})
        return {"rolled_back_to": record["prior_head"], "tag": record["tag"],
                "helper_sha256": helper_sha256}


# --------------------------------------------------------------------- main


def _error_artifact(kind: str, subcommand: str, message: str, exit_code: int) -> dict:
    """The one JSON artifact for an error with no result (doctrine I1)."""
    return {"error": {"kind": kind, "subcommand": subcommand,
                      "message": message, "exitCode": exit_code}}


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
    parser.add_argument("--expect-helper-sha256", metavar="HEX64",
                        help="owner-pinned sha256 of the helper; a mismatch refuses "
                             "before import, lock and preflight")
    sub = parser.add_subparsers(dest="operation", required=True)
    switch = sub.add_parser("switch", help="preflight, drain, switch, verify, journal")
    switch.add_argument("--unit", choices=sorted(UNIT_RUNTIMES))
    switch.add_argument("--runtime")
    switch.add_argument("--sha")
    switch.add_argument("--tag")
    rollback = sub.add_parser("rollback",
                              help="owner-approved rollback to the recorded prior target")
    rollback.add_argument("--prior-record", required=True, type=Path,
                          help="a controller journal entry naming the prior target")
    recover = sub.add_parser(
        "recover", help="restore one retained pre-activation unit intent")
    recover.add_argument("--record", required=True, type=Path,
                         help="retained controller unit record to recover")
    health = sub.add_parser("health",
                            help="two advancing completed-tick observations")
    health.add_argument("--interval-seconds", type=int, required=True,
                        help="required delay before each later observation; choose at "
                             "least one runner cadence plus slack (the first observation "
                             "polls --first-tick-timeout-seconds instead)")
    health.add_argument("--first-tick-timeout-seconds", type=int, default=1500,
                        help="first completed-tick wait (default: 20-minute cadence plus 5-minute slack)")
    args = parser.parse_args(argv)
    if args.operation == "health" and (args.first_tick_timeout_seconds < 0 or args.interval_seconds < 0):
        parser.error("health wait intervals must be nonnegative")

    root = args.root.resolve()
    helper_path = args.helper or (root / "apps/crq-python/ops/prepare-host.py")
    effects = Effects(root, args.record_dir.resolve())

    try:
        # Identity first, then the controller lock, then preflight (#549).
        helper_module, helper_sha256 = _load_helper(helper_path,
                                                    args.expect_helper_sha256)
        if args.operation == "switch" and (args.unit or args.runtime):
            if not args.unit or not args.runtime or args.sha or args.tag:
                raise Refused("unit switch requires --unit and --runtime only")
            overlay, _raw = helper_module.load_overlay(args.overlay)
            live = _load_live_binding()
            try:
                adapter, _selection = live.production_adapter(
                    effects, overlay, unit=args.unit, runtime=args.runtime)
            except (live.LiveBindingRefused, live.factory.FactoryRefused,
                    live.completion.CompletionError) as exc:
                raise Refused(str(exc)[:400]) from exc
            record = switch_unit(effects, adapter, args.unit, args.runtime)
            print(json.dumps(record, indent=2, sort_keys=True))
        elif args.operation == "switch":
            if not args.sha or not args.tag:
                raise Refused("checkout switch requires --sha and --tag")
            plan = deploy_plan(effects, helper_module, args.sha, args.tag,
                               args.overlay, helper_sha256)
            print(json.dumps({"operation": "switch", "target": plan["preflight"]["target"],
                              "automatic_rollback_permitted":
                                  plan["automatic_rollback_permitted"],
                              "helper_sha256": helper_sha256,
                              "steps": plan["steps"]}, indent=2, sort_keys=True))
        elif args.operation == "rollback":
            prior = json.loads(args.prior_record.read_text())
            result = rollback_plan(effects, helper_module, prior, args.overlay,
                                   helper_sha256)
            print(json.dumps({"operation": "rollback", **result}, indent=2,
                             sort_keys=True))
        elif args.operation == "recover":
            overlay, _raw = helper_module.load_overlay(args.overlay)

            def adapter_factory(unit, prior_runtime):
                live = _load_live_binding()
                try:
                    adapter, _selection = live.production_adapter(
                        effects, overlay, unit=unit, runtime=prior_runtime)
                except (live.LiveBindingRefused, live.factory.FactoryRefused,
                        live.completion.CompletionError) as exc:
                    raise Refused(str(exc)[:400]) from exc
                return adapter

            record = recover_unit(effects, None, args.record,
                                  adapter_factory=adapter_factory)
            print(json.dumps(record, indent=2, sort_keys=True))
        else:
            first_observation = True

            def observe(prior_tick):
                nonlocal first_observation
                if first_observation:
                    first_observation = False
                    return wait_for_first_tick(effects, prior_tick, args.first_tick_timeout_seconds)
                if args.interval_seconds:
                    time.sleep(args.interval_seconds)
                return health_observation(effects, prior_tick)

            result = two_slot_health(effects, observe)
            print(json.dumps({"operation": "health", **result}, indent=2,
                             sort_keys=True))
            if not result["healthy"]:
                return 1
    except RecoveryRequired as exc:
        print(json.dumps(exc.recovery, indent=2, sort_keys=True))
        print("recovery required: " + str(exc), file=sys.stderr)
        return 3
    except NoChangeRefused as exc:
        print(json.dumps(exc.record, indent=2, sort_keys=True))
        print("refused: " + str(exc), file=sys.stderr)
        return 2
    except Refused as exc:
        print(json.dumps(_error_artifact("refused", args.operation, str(exc), 2),
                         indent=2, sort_keys=True))
        print("refused: " + str(exc), file=sys.stderr)
        return 2
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        if args.operation == "health":
            raise  # keep the health observation exit-1 contract
        # Escaped outside mutation_record: the helper was never entered, so the
        # deployment surfaces are unchanged and this is a refusal (exit 2).
        message = str(exc)[:400] or type(exc).__name__
        print(json.dumps(_error_artifact("refused", args.operation, message, 2),
                         indent=2, sort_keys=True))
        print("refused: " + message, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(str(exc)) from None
