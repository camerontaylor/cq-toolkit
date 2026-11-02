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
        super().__init__(recovery["reason"])
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
        with path.open("a") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise Refused("controller lock busy: another controller run holds "
                              + LOCK_NAME + " (" + str(exc) + ")") from None
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
        return {"schema_source": "deployment:apps/crq-python/review_receipt.py",
                "policy": policy, "version": version, "targets": targets}
    except (OSError, SyntaxError, ValueError, KeyError, TypeError) as exc:
        return {"schema_source": "builtin (deployment constants unavailable: "
                                 + type(exc).__name__ + ": " + str(exc)[:80] + ")",
                "policy": RECEIPT_POLICY, "version": RECEIPT_VERSION,
                "targets": RECEIPT_TARGETS}


def receipt_problem(name: str, data: bytes, schema: dict | None = None) -> str | None:
    """Why a retained receipt is not a valid v1 review receipt, or None.

    Mirrors the stable receipt contract read-only and offline: the immutable
    content identity (review_receipt.read_receipt), the TS QueueReceiptSchema
    (src/ops/review/internal/queueEvidence.ts) and its scope-digest check.
    Groups: run identity, captured target, terminal outcome. Never imports
    runner code and never grants review credit. ``schema`` is
    ``receipt_schema()`` output; the builtin copy when omitted.
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
    if not (isinstance(source, dict)
            and _text(source.get("repo"))
            and re.fullmatch(r"[\w.-]+/[\w.-]+", source["repo"])
            and type(source.get("pr")) is int and source["pr"] > 0
            and _hex(_HEX40, source.get("merge_sha"))
            and source.get("target_selector") in schema["targets"]
            and source.get("policy") == schema["policy"]):
        return "target: source binding is not a v1 merged-current subject"
    if not (isinstance(capture, dict)
            and _hex(_HEX40, capture.get("target"))
            and _hex(_HEX40, capture.get("tree"))):
        return "target: captured target/tree is not a pinned 40-hex SHA"
    paths = capture.get("paths")
    if not (isinstance(paths, list) and all(
            isinstance(entry, dict) and _text(entry.get("source_path"))
            and _text(entry.get("path"))
            and entry.get("resolution") in RECEIPT_RESOLUTIONS
            and entry.get("disposition") in RECEIPT_DISPOSITIONS for entry in paths)):
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
    invalid = []
    for name in names:
        try:
            problem = receipt_problem(name, (root / name).read_bytes(), schema)
        except OSError as exc:
            problem = "unreadable: " + str(exc)[:80]
        if problem:
            invalid.append({"receipt": name[:-5], "reason": problem})
    return {"sampled": len(names), "valid_count": len(names) - len(invalid),
            "invalid": invalid, "valid": (not invalid) if names else None,
            "schema_source": schema["schema_source"]}


def health_observation(effects: Effects, prior_tick: str) -> dict:
    """One health observation against the requested prior tick.

    Advancement is lexicographic on the strict UTC timestamps (they sort
    chronologically), never a wall-clock delta. Two independent receipt
    verdicts ride along: ``receipts_readable`` (state/runs/*/meta.json parse)
    and ``receipts_valid`` (state/receipts schema sample). Neither affects
    advancement; neither grants review credit.
    """
    _parse_iso(prior_tick)
    current = _tick_value(effects)
    _parse_iso(current)
    advanced = current > prior_tick
    receipts = effects.state_dir() / "runs"
    receipt_sample = None
    if receipts.is_dir():
        entries = _newest(list(receipts.iterdir()), RECEIPT_SAMPLE)
        readable = 0
        for entry in entries:
            meta = entry / "meta.json"
            if meta.is_file():
                try:
                    json.loads(meta.read_text())
                    readable += 1
                except (ValueError, OSError):
                    pass
        receipt_sample = {"sampled": len(entries), "readable": readable}
    validation = receipt_validation(effects)
    return {"observed_tick": current, "advanced": advanced,
            "receipts": receipt_sample,
            "receipts_readable": (receipt_sample["readable"] == receipt_sample["sampled"]
                                  if receipt_sample and receipt_sample["sampled"] else None),
            "receipt_validation": validation,
            "receipts_valid": validation["valid"] if validation else None}


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


def deploy_plan(effects: Effects, helper_module, target: str, tag: str,
                overlay_path: Path, helper_sha256: str | None = None) -> dict:
    """Preflight -> drain -> durable intent -> helper -> proofs -> completion.

    Failures after helper entry require owner recovery; they never claim the
    deployment was unchanged. Units are started only by the owner.
    """
    with effects.controller_lock():
        pre = preflight(effects, target, tag)
        effects.record_preflight()
        prior_tag = prior_tag_for(effects, pre["state"]["prior_head"])
        plan = {"preflight": pre, "steps": [], "helper_sha256": helper_sha256}
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


def prior_tag_for(effects: Effects, sha: str) -> str | None:
    """The annotated crq-runner/ tag that peels to ``sha`` in this checkout,
    or None when no such tag exists. Read-only; used to record the prior
    target's own approval tag in the deploy journal."""
    listing = effects.git("tag", "--list", "crq-runner/*",
                          "--format=%(refname:short) %(objecttype)")
    candidates = []
    for line in listing.splitlines():
        parts = line.split()
        if len(parts) != 2 or parts[1] != "tag":
            continue  # lightweight tags are not owner-approval artifacts
        tag = parts[0]
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
        drain = drain_check(effects, _runner_liveness(effects))
        if not drain["drained"]:
            raise Refused("cannot roll back with live/ambiguous reviews: "
                          + json.dumps(drain["blocked"])[:400])
        effects.record_preflight()
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
    switch.add_argument("--sha", required=True)
    switch.add_argument("--tag", required=True)
    rollback = sub.add_parser("rollback",
                              help="owner-approved rollback to the recorded prior target")
    rollback.add_argument("--prior-record", required=True, type=Path,
                          help="a controller journal entry naming the prior target")
    health = sub.add_parser("health",
                            help="two advancing completed-tick observations")
    health.add_argument("--interval-seconds", type=int, default=0,
                        help="seconds between observations (caller-timed)")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    helper_path = args.helper or (root / "apps/crq-python/ops/prepare-host.py")
    effects = Effects(root, args.record_dir.resolve())

    try:
        # Identity first, then the controller lock, then preflight (#549).
        helper_module, helper_sha256 = _load_helper(helper_path,
                                                    args.expect_helper_sha256)
        if args.operation == "switch":
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
    except RecoveryRequired as exc:
        print(json.dumps(exc.recovery, indent=2, sort_keys=True))
        print("recovery required: " + str(exc), file=sys.stderr)
        return 3
    except NoChangeRefused as exc:
        print(json.dumps(exc.record, indent=2, sort_keys=True))
        print("refused: " + str(exc), file=sys.stderr)
        return 2
    except Refused as exc:
        print("refused: " + str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(str(exc)) from None
