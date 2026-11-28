#!/usr/bin/env python3
"""The CRQ deploy driver: merged main in, health-checked, auto-rollback.

One command deploys a merged main SHA to a CRQ host:

    resolve a merged main SHA  ->  hold admission and drain
    ->  switch the checkout and render config  ->  verify queue bytes,
    runtime pointer and rollback compatibility  ->  restart the triggers
    that were active  ->  two-slot health check  ->  done, or automatic
    rollback to the measured prior SHA and pointer.

What this replaces. The previous runbook (crq-efficiency slice 4) added a
per-deploy invariant manifest, a digest-pinned runbook revision, a
digest-pinned schema and helper, an operator GO, an annotated-tag
requirement, a baseline controller journal assertion, a rehearsal mode with
its own fake controller journal, and a released-flag gate over five durable
artifacts. That ceremony was written for a freeze/nomination process the
owner retired on 2026-11-14: CRQ is a dogfooded alpha, code is reviewed once
at PR merge, and any merged main SHA shipping the tagless helper contract is
deployable. None of it made a deploy safer than the properties below, which
are kept:

* **Shared queue bytes are never written.** ``state/queue.json`` and the
  completion heartbeat are hashed before and after the switch and after a
  rollback; any difference is a failed deploy, never a migration.
* **Whole deploys are serialized.** An advisory ``state/deploy.lock`` is held
  from before the first measurement through the released health window and
  recovery, so two runs cannot switch the checkout under each other. The
  controller's own ``controller.lock`` is held for the same window through
  ``Effects.controller_lock`` (every controller mutation — checkout deploy
  or rollback, a ``--unit`` switch, recovery — serializes on it), so a
  controller transaction cannot overlap the switches or the health window:
  controller transactions read neither ``deploy.lock`` nor the admission
  marker.
* **Admission is held and work is drained.** The ``state/runner-disabled``
  marker is claimed with ``O_EXCL`` and run-unique bytes before any unit is
  stopped. Triggers stop, services settle, and the controller's own
  read-only ``drain_check`` (owned-run liveness, nothing signalled) polls to
  a bounded deadline. An expired drain is a fail-stop: hold retained,
  nothing killed.
* **The switch is the audited helper fence.** ``prepare-host.switch``
  re-checks root/overlay binding, merged-main ancestry, the checkout's
  cleanliness and the tick lock, and renders the target config atomically.
  No second renderer or switcher lives here.
* **Runtime compatibility and rollback are measured, not declared.** Before
  the switch, the controller's ``compatibility_record`` must grant automatic
  rollback (no queue schema marker, no ``author_*`` state keys). The live
  ``repair.cq_bin`` pointer and its entry bytes are measured before the
  deploy; the target render must keep both. Rollback switches back to the
  measured prior SHA with the same helper (the prior SHA is not re-verified as a deploy target; the measured config bytes are restored verbatim), requires the live config
  bytes to equal the pre-deploy bytes (pointer included), requires the queue
  bytes to survive the rollback switch (re-measured after its own drain when
  a completed health tick may have advanced them), and restarts exactly the
  triggers observed active before the run.

The target's own helper and controller are extracted and executed. A target
whose helper still requires an annotated tag or lacks exact-byte rollback
support is refused before the hold.

Only a failure *after* the switch triggers automatic rollback: a failed
verification or a failed health check. A failure before the switch restarts
what this run stopped and releases its own marker. A failed rollback keeps
the hold and exits 3 (recovery required) rather than pretend the host is
back. Nothing here drives a per-unit TypeScript cutover; ``--unit`` switches
stay with the controller.

Every invocation writes exactly one JSON document to stdout, including
argument errors and refusals (the machine-mode contract R1/R5 carried before
this simplification). Narration goes to stderr. Under ``--json`` (machine
mode) narration is suppressed, stderr stays empty, and a usage error is one
``{"error": {"kind": "usage", "subcommand": ..., "message": ..., "exitCode":
2}}`` artifact. Exit codes: 0 completed, 1 deploy failed but rolled back
cleanly, 2 refused with the host unchanged, 3 recovery required (rollback
failed or the drain expired; hold retained).

Python stdlib only.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import inspect
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

sys.dont_write_bytecode = True

OPS_DIR = Path(__file__).resolve().parent
MARKER_RELPATH = "apps/crq-python/state/runner-disabled"
CONFIG_RELPATH = "apps/crq-python/config.json"
SHA_RE = re.compile(r"[0-9a-f]{40}\Z")
PLACEHOLDER = "@HOST_CQ_BIN@"
# States an observation may report at the start of a run. A transient state
# (activating/reloading/deactivating) means another actor is moving units;
# refuse rather than guess which way it settles.
SETTLED_STATES = ("active", "inactive", "failed")
DEAD_STATES = ("inactive", "failed")


class Refused(Exception):
    """Terminal refusal. The exception text is the operator-facing reason."""


class FailStop(Refused):
    """A refusal that must keep the hold: recovery is an owner operation."""


class RecoveryRequired(Exception):
    """The host could not be returned to a verified state; hold retained."""

    def __init__(self, message, record=None):
        super().__init__(message)
        self.record = record or {}


def narrate(message):
    print("deploy-runbook: " + message, file=sys.stderr)


def require(condition, message):
    if not condition:
        raise Refused(message)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def durable_write(path, payload):
    """Atomically replace ``path`` with canonical JSON, fsyncing file and
    directory. The records are the only way to reconstruct a failed run."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode()
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + ".",
                                             dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def load_json(path):
    try:
        with Path(path).open() as handle:
            return json.load(handle)
    except OSError as exc:
        raise Refused("cannot read " + str(path) + ": " + str(exc)) from exc
    except ValueError as exc:
        raise Refused("invalid JSON in " + str(path) + ": " + str(exc)) from exc


def load_module(name, path):
    try:
        spec = importlib.util.spec_from_file_location(name, Path(path))
        if spec is None or spec.loader is None:
            raise Refused("cannot load " + name + " from " + str(path))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except OSError as exc:
        raise Refused("unreadable module " + name + ": " + str(exc)) from exc


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    return sha256_bytes(Path(path).read_bytes())


# ------------------------------------------------------------------- git


def git(root, *args, check=True):
    completed = subprocess.run(["git", "-C", str(root), *args],
                               capture_output=True, text=True)
    if check and completed.returncode != 0:
        detail = (completed.stderr or "").strip().splitlines()
        raise Refused("git " + " ".join(args) + " failed: "
                      + (detail[-1] if detail else "exit "
                         + str(completed.returncode)))
    return completed.stdout.strip()


def git_bytes(root, *args):
    completed = subprocess.run(["git", "-C", str(root), *args],
                               capture_output=True)
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip().splitlines()
        raise Refused("git " + " ".join(args) + " failed: "
                      + (detail[-1] if detail else "exit "
                         + str(completed.returncode)))
    return completed.stdout


def materialize_ops(root, sha, names, destination):
    """Extract the target revision's ops modules into a private directory.

    The switch and the drain/health helpers must be the code that revision
    ships, and importing them from the checkout after the switch would read
    code from a tree this run has already changed. The extracted bytes are
    written 0600 outside the checkout and their digests are recorded.
    """
    destination = Path(destination)
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    digests = {}
    for name in names:
        data = git_bytes(root, "show", sha + ":apps/crq-python/ops/" + name)
        path = destination / name
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        digests[name] = sha256_bytes(data)
    return digests


def resolve_target(root, requested, fetch):
    """Resolve the merged main SHA this deploy will apply.

    A tag is optional and, when supplied, is verified by the helper's own
    fence. The deployable predicate is the merged-main one: the target is a
    full commit already contained in ``refs/remotes/origin/main``.
    """
    if fetch:
        git(root, "fetch", "--quiet", "origin", "main")
    if requested is None:
        target = git(root, "rev-parse", "--verify",
                     "refs/remotes/origin/main^{commit}")
    else:
        require(SHA_RE.match(requested or ""),
                "--target-sha must be a full 40-hex commit SHA")
        target = requested
    exists = subprocess.run(
        ["git", "-C", str(root), "cat-file", "-e", target + "^{commit}"],
        capture_output=True, text=True)
    require(exists.returncode == 0,
            "target " + target + " is not a commit in this checkout; fetch "
            "or pass a SHA that exists")
    on_main = subprocess.run(
        ["git", "-C", str(root), "merge-base", "--is-ancestor", target,
         "refs/remotes/origin/main"], capture_output=True, text=True)
    require(on_main.returncode == 0,
            "target " + target + " is not merged to origin/main; only a "
            "merged main SHA is deployable")
    return target


# --------------------------------------------------------------- live state


def read_config(root):
    path = Path(root) / CONFIG_RELPATH
    try:
        return path.read_bytes()
    except OSError as exc:
        raise Refused("cannot read live config " + str(path) + ": "
                      + str(exc)) from exc


def measure_cq_bin(config_bytes):
    """Measure the live runtime pointer, including the entry's own bytes.

    The configuration string alone does not prove what the runner executes;
    the measured entry does. A placeholder is recorded as such (the overlay
    did not render a runtime) and compared as a string. A non-placeholder
    pointer must name an existing entry: a missing one is refused here so
    preflight rejects it before the admission hold, while the later
    pre-restart checks still detect deletion after preflight.
    """
    try:
        config = json.loads(config_bytes.decode("utf-8"))
    except ValueError as exc:
        raise Refused("live config is not valid JSON: " + str(exc)) from exc
    pointer = (config.get("repair") or {}).get("cq_bin")
    record = {"pointer": pointer if isinstance(pointer, str) else None,
              "placeholder": (isinstance(pointer, str)
                              and PLACEHOLDER in pointer),
              "exists": False, "sha256": None, "mode": None,
              "resolved": None}
    if record["placeholder"]:
        return record
    require(isinstance(pointer, str) and pointer,
            "live config carries no repair.cq_bin pointer; the runtime this "
            "deploy would execute is unknown")
    entry = Path(pointer)
    require(entry.is_absolute(),
            "live repair.cq_bin is not an absolute path: " + repr(pointer))
    record["exists"] = entry.is_file()
    require(record["exists"],
            "live repair.cq_bin points at a missing entry: " + repr(pointer)
            + "; the runtime this deploy would execute cannot be measured")
    record["sha256"] = sha256_file(entry)
    record["mode"] = oct(entry.stat().st_mode & 0o777)
    record["resolved"] = str(entry.resolve())
    return record


def command_failure(args, exc):
    """One operator-facing reason for a failed child command.

    stderr is captured, never inherited: in machine mode (--json) stderr
    must stay empty, so the diagnostic travels inside the refusal artifact.
    """
    detail = (exc.stderr or "").strip().splitlines()
    return (" ".join(args) + " failed: "
            + (detail[-1] if detail else "exit " + str(exc.returncode)))


class RealUnits:
    """The live systemd user-unit provider; the only host-mutating seam."""

    def _run(self, *args):
        try:
            return subprocess.check_output(args, text=True,
                                           stderr=subprocess.PIPE).strip()
        except subprocess.CalledProcessError as exc:
            raise Refused(command_failure(args, exc)) from exc

    def state(self, unit):
        return self._run("systemctl", "--user", "show", unit,
                         "-pActiveState", "--value")

    def _names(self, command):
        args = ["systemctl", "--user", command, "--no-legend", "--no-pager",
                "--plain"]
        if command == "list-units":
            args.append("--all")
        args.append("crq-*")
        try:
            output = subprocess.check_output(args, text=True,
                                             stderr=subprocess.PIPE)
        except subprocess.CalledProcessError as exc:
            # A unit-file pattern that matches nothing exits 1 with no
            # diagnostic; an unavailable bus or any other failure raises
            # with the captured diagnostic, not on inherited stderr.
            if (command == "list-unit-files" and exc.returncode == 1
                    and not (exc.stderr or "").strip()):
                return set()
            raise Refused(command_failure(args, exc)) from exc
        names = set()
        for line in output.splitlines():
            fields = line.split()
            if fields:
                names.add(fields[0])
        return names

    def inventory(self):
        names = self._names("list-unit-files") | self._names("list-units")
        triggers = sorted(name for name in names
                          if name.endswith((".timer", ".path")))
        services = sorted(name for name in names if name.endswith(".service"))
        return triggers, services

    def stop(self, units):
        if units:
            self._run("systemctl", "--user", "stop", *units)

    def start(self, units):
        if units:
            self._run("systemctl", "--user", "start", *units)


class Hold:
    """The admission marker, owned by this run's unique bytes."""

    def __init__(self, root):
        self.path = Path(root) / MARKER_RELPATH
        self.token = (uuid.uuid4().hex + "-" + str(os.getpid()) + "\n").encode()
        # ``created`` tracks a marker that exists on disk; ``acquired``
        # additionally requires this run's token to be persisted and the
        # marker's directory entry synced.
        self.created = False
        self.acquired = False

    def acquire(self):
        # Directories this call creates: each one's entry lives in its
        # parent, so every such parent must be synced before the hold counts
        # as durable.
        created_dirs = []
        probe = self.path.parent
        while not os.path.lexists(probe) and probe != probe.parent:
            created_dirs.append(probe)
            probe = probe.parent
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL
                                 | os.O_WRONLY, 0o600)
        except FileExistsError as exc:
            owner = self.ownership()
            if owner is None:
                raise Refused(
                    "admission is already held by " + str(self.path)
                    + "; its ownership could not be read, so it may be "
                    "this run's own marker or another's, and it was left "
                    "untouched") from exc
            if owner is True:
                raise Refused(
                    "admission is already held by " + str(self.path)
                    + " with this run's token; it was left untouched"
                ) from exc
            if not os.path.lexists(self.path):
                raise Refused(
                    "the admission marker " + str(self.path)
                    + " was no longer present when it was read back; this "
                    "run wrote nothing, and a retry is fine") from exc
            raise Refused(
                "admission is already held by " + str(self.path)
                + "; another deploy or a manual hold owns it") from exc
        # From here the marker exists even if the token never lands.
        self.created = True
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(self.token)
                handle.flush()
                os.fsync(handle.fileno())
        except OSError as exc:
            if not self.owns():
                # The bytes cannot prove this run's ownership, so the
                # marker must stay: it holds admission, and only the owner
                # may verify and remove it. Report recovery with the
                # retained identity rather than a refusal that claims the
                # host is unchanged.
                raise RecoveryRequired(
                    "the admission marker " + str(self.path)
                    + " was created but its token could not be persisted ("
                    + repr(exc)[:200] + "); the marker is retained and "
                    "admission stays disabled; remove it only after "
                    "verifying its contents are "
                    + self.token.decode().strip()) from exc
            # The persisted bytes match this run's token, so ownership is
            # proven: remove the marker durably, as release() does, and
            # refuse with the host genuinely unchanged.
            try:
                self._remove_durably()
            except OSError as removal:
                raise RecoveryRequired(
                    "the admission marker " + str(self.path)
                    + " could not be persisted (" + repr(exc)[:200]
                    + ") and could not be verifiably removed ("
                    + repr(removal)[:200] + "); the marker is retained or "
                    "its removal may not survive a reboot, and admission "
                    "stays held by this run's token "
                    + self.token.decode().strip()) from removal
            raise Refused(
                "the admission marker " + str(self.path)
                + " could not be persisted (" + repr(exc)[:200]
                + "); its bytes matched this run's token, so ownership was "
                "proven and the marker was removed with a synced directory "
                "entry; the host is unchanged"
            ) from exc
        # The token bytes are durable, but a created file's directory entry
        # is not until the directory itself is synced: without it a power
        # loss can reboot the host without the admission hold. A failed
        # sync leaves the transition unverifiable, so the marker stays and
        # the run reports recovery instead of proceeding.
        try:
            self.sync_directory()
            # The marker directory may have been created by another step
            # (the deploy lock), so its own parent is always synced too.
            parents = {created.parent for created in created_dirs}
            parents.add(self.path.parent.parent)
            for parent in sorted(parents):
                self._sync_path(parent)
        except OSError as exc:
            raise RecoveryRequired(
                "the admission marker " + str(self.path)
                + " was created but its directory entry could not be "
                "synced (" + repr(exc)[:200] + "); the admission transition "
                "could not be verified: the marker is retained with this "
                "run's token " + self.token.decode().strip() + " and "
                "admission stays disabled") from exc
        self.acquired = True

    def sync_directory(self):
        """fsync the marker's directory so its entry — the creation or the
        removal — survives a power loss; raises OSError when it cannot."""
        self._sync_path(self.path.parent)

    @staticmethod
    def _sync_path(path):
        directory = os.open(path, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def _remove_durably(self):
        """Remove the marker and sync its directory entry so the removal
        cannot resurrect as a stale hold after a reboot; raises OSError
        when either step fails."""
        self.path.unlink()
        self.sync_directory()

    def owns(self):
        return self.ownership() is True

    def ownership(self):
        """True when the marker holds this run's token, False when it verifiably
        does not (absent or foreign), None when a read failure leaves it unknown."""
        try:
            return self.path.read_bytes() == self.token
        except FileNotFoundError:
            return False
        except OSError:
            return None

    def release(self):
        require(self.owns(),
                "cannot release the admission marker: it is not this run's")
        try:
            self.path.unlink()
        except OSError as exc:
            raise RecoveryRequired(
                "the admission marker " + str(self.path)
                + " could not be verifiably removed (" + repr(exc)[:200]
                + "); the admission release could not be verified: the "
                "marker is still present and holds admission"
            ) from exc
        try:
            self.sync_directory()
        except OSError as exc:
            # The unlink took effect but is not durable, and the caller is
            # about to terminate in recovery: admission must not be left
            # open. Put this run's hold back so the recovery outcome, the
            # on-disk state and ``acquired`` all agree.
            try:
                self._write_marker()
            except FileExistsError:
                # Something took the path between the unlink and now. The
                # bytes decide whose it is; a foreign hold is never touched.
                present = self.ownership()
                if present is None:
                    # The marker exists but cannot be read back, so it may
                    # be this run's own: leave ``acquired`` as it is (the
                    # marker holds admission either way) and say the
                    # ownership is unknown rather than call it foreign.
                    raise RecoveryRequired(
                        "the admission marker " + str(self.path)
                        + " was removed but its removal could not be synced ("
                        + repr(exc)[:200] + "); a marker is present at the "
                        "path but could not be read back, so whether it is "
                        "this run's token "
                        + self.token.decode().strip() + " is unknown; it "
                        "was left untouched and admission stays disabled "
                        "under it") from exc
                if present is False:
                    self.acquired = False
                    raise RecoveryRequired(
                        "the admission marker " + str(self.path)
                        + " was removed but its removal could not be synced ("
                        + repr(exc)[:200] + "); a foreign hold is now "
                        "present at the path and was preserved untouched: "
                        "admission stays disabled under that hold, which "
                        "this run does not own") from exc
            except OSError as again:
                # ``acquired`` mirrors a marker that carries this run's
                # token: without one, fail-stop must re-acquire (or report
                # the refusal) rather than skip it and record a hold that
                # is not there.
                self.acquired = self.ownership() is not False
                raise RecoveryRequired(
                    "the admission marker " + str(self.path)
                    + " was removed but its removal could not be synced ("
                    + repr(exc)[:200] + ") and the hold could not be "
                    "re-created (" + repr(again)[:200] + "); admission may "
                    "be open: re-create the marker with this run's "
                    "token " + self.token.decode().strip()) from exc
            try:
                self.sync_directory()
            except OSError as again:
                raise RecoveryRequired(
                    "the admission marker " + str(self.path)
                    + " was removed but its removal could not be synced ("
                    + repr(exc)[:200] + "); the hold was re-created with "
                    "this run's token " + self.token.decode().strip()
                    + " and is present, but its directory entry could not "
                    "be synced (" + repr(again)[:200] + "), so it may not "
                    "survive a power loss; admission stays disabled "
                    "until then") from exc
            raise RecoveryRequired(
                "the admission marker " + str(self.path)
                + " was removed but its removal could not be synced ("
                + repr(exc)[:200] + "); the hold was re-established with "
                "this run's token " + self.token.decode().strip()
                + " and admission stays disabled") from exc
        self.acquired = False

    def _write_marker(self):
        descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL
                             | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(self.token)
            handle.flush()
            os.fsync(handle.fileno())


class DeployLock:
    """A host-wide advisory lock for the whole deploy, health window and
    recovery.

    The admission marker cannot be this lock: it must be released for the
    runner to advance a tick, and two overlapping deploys must not switch the
    checkout under each other while the first waits for its health
    observations. The lock file lives in the ignored state directory, is held
    from before the first measurement, and is released by the kernel if the
    process dies.
    """

    def __init__(self, root):
        self.path = Path(root) / "apps/crq-python/state/deploy.lock"
        self.handle = None

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            handle.close()
            raise Refused(
                "another deploy holds the deployment lock " + str(self.path)
                + "; wait for it to finish before starting another") from exc
        self.handle = handle

    def release(self):
        if self.handle is None:
            return
        try:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        finally:
            self.handle.close()
            self.handle = None


# ------------------------------------------------------------------- driver


class Run:
    """One deploy. ``units``/``helper``/``controller``/``health``/``drain``
    are injectable so tests run host-free; production builds real ones."""

    def __init__(self, args, units=None, helper=None, controller=None,
                 health=None, drain=None, clock=time.monotonic,
                 sleep=time.sleep):
        self.args = args
        # Resolve once, before anything constructs Effects. The controller's
        # heartbeat check compares ``str(effects.root / "apps/crq-python")``
        # literally against the root crq.py writes via
        # ``Path(__file__).resolve().parent``; root_check resolves both sides,
        # so an unresolved relative or symlinked --root would pass preflight
        # and then deterministically fail health after the switch.
        self.root = Path(args.root).resolve()
        self.units = units
        self.helper = helper
        self.controller = controller
        self.health_fn = health
        self.drain_fn = drain
        self.clock = clock
        self.sleep = sleep
        self.hold = None
        self.lock = DeployLock(self.root)
        self.controller_guard = None
        self.run_dir = None
        self.target = None
        self.prior_sha = None
        self.original = None
        self.original_config = None
        self.cq_bin = None
        self.preserved = None
        self.switch_attempted = False
        self.switched = False
        self.released = False
        self.final_triggers = None
        self.rollback = None

    # -- records -------------------------------------------------------
    def git(self, *args, **kwargs):
        return git(self.root, *args, **kwargs)

    def narrate(self, message):
        """Narration is stderr-only, and silent in machine mode (--json)."""
        if not getattr(self.args, "json", False):
            narrate(message)

    def phase(self, name, **extra):
        durable_write(Path(self.run_dir) / "phase.json",
                      {"operation": "deploy", "phase": name, "at": now_iso(),
                       "target": self.target, "prior_sha": self.prior_sha,
                       **extra})

    def persist_recovery_receipt(self):
        """Persist the immutable recovery receipt before admission.

        ``phase.json`` is rewritten by every later phase, so once the flow
        moves past ``prepared`` the only durable copy of the pre-deploy
        measurements is this receipt. It carries everything recovering a
        stuck host needs: the measured prior SHA, the triggers observed
        before any stop, the runtime measurement, the config digest and the
        preserved-state digests. ``durable_write`` fsyncs file and directory
        into the private run record outside the checkout, so the receipt
        survives a process that dies in the drain or the switch, and nothing
        in this flow rewrites or removes it. A rewrite attempt must match
        the existing bytes (modulo the wall-clock stamp) or this run refuses
        rather than mutate its own evidence.
        """
        path = Path(self.run_dir) / "recovery-receipt.json"
        receipt = {
            "operation": "deploy",
            "written_at": now_iso(),
            "target": self.target,
            "prior_sha": self.prior_sha,
            "original_triggers": self.original,
            "cq_bin": self.cq_bin,
            "config_sha256": sha256_bytes(self.original_config),
            "preserved": self.preserved,
        }
        if path.exists():
            existing = load_json(path)
            existing.pop("written_at", None)
            expected = dict(receipt)
            expected.pop("written_at")
            require(existing == expected,
                    "the recovery receipt in " + str(self.run_dir)
                    + " already exists with different content; refusing to "
                    "mutate the recorded evidence")
            return
        durable_write(path, receipt)

    def claim_run_dir(self):
        base = Path(self.args.record_dir)
        resolved = base.resolve()
        root = self.root.resolve()
        require(resolved != root and root not in resolved.parents,
                "--record-dir must be outside the deployment checkout")
        base.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(not base.stat().st_mode & 0o077,
                "private record directory must have mode 0700: " + str(base))
        name = ("run-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
                + "-" + uuid.uuid4().hex[:6])
        self.run_dir = base / name
        self.run_dir.mkdir(mode=0o700)
        return self.run_dir

    # -- validation ----------------------------------------------------
    def assert_clean(self):
        # Read the raw status: the two-column XY prefix distinguishes a
        # modified tracked config from an untracked file of the same name, and
        # stripping the output would erase the leading column.
        completed = subprocess.run(
            ["git", "-C", str(self.root), "status", "--porcelain",
             "--untracked-files=all"], capture_output=True, text=True)
        require(completed.returncode == 0,
                "git status failed: " + (completed.stderr or "").strip()[:200])
        changes = [line for line in completed.stdout.splitlines() if line.strip()]
        # The live checkout carries the overlay's render of HEAD, so that one
        # tracked file is expected to differ; anything else is a refusal.
        allowed = {" M " + CONFIG_RELPATH, "M  " + CONFIG_RELPATH}
        unexpected = [line for line in changes if line not in allowed]
        require(not unexpected,
                "deployment checkout has changes other than the rendered "
                "config: " + "; ".join(unexpected[:5]))

    def resolve_modules(self, ops_dir):
        digests = materialize_ops(self.root, self.target,
                                  ("prepare-host.py", "deploy-controller.py"),
                                  ops_dir)
        self.module_digests = digests
        if self.helper is None:
            self.helper = load_module("crq_deploy_runbook_helper",
                                      ops_dir / "prepare-host.py")
        if self.controller is None:
            self.controller = load_module("crq_deploy_runbook_controller",
                                          ops_dir / "deploy-controller.py")
        verify = getattr(self.helper, "verify_target", None)
        if verify is not None:
            parameter = inspect.signature(verify).parameters.get("tag")
            require(parameter is not None
                    and parameter.default is not inspect.Parameter.empty,
                    "the target revision's prepare-host.verify_target still "
                    "requires an annotated tag, so a tagless deploy and its "
                    "automatic rollback are impossible with it; deploy a "
                    "target that contains the tagless-helper change first. "
                    "Nothing has been switched.")

        require("rollback_config" in inspect.signature(
                    self.helper.switch).parameters,
                "the target revision's prepare-host.switch cannot restore "
                "recorded rollback config bytes. Choose a target with "
                "rollback_config support. Nothing has been switched.")

        # The drain loop passes deadline= and clock= to the TARGET
        # controller's drain_check. A target that predates them would raise
        # TypeError mid-drain; run()'s catch-all recovery would restore the
        # hold and triggers and re-raise as Refused, but only after one
        # avoidable stop/restart of the live triggers and with a confusing
        # "unexpected keyword argument" message. Refuse before anything is
        # switched. Like the checks above, this tests literal parameter
        # names, so a **kwargs-only or undecorated-wrapper signature is
        # refused (the safe direction).
        drain_parameters = inspect.signature(
            self.controller.drain_check).parameters
        require("deadline" in drain_parameters
                and "clock" in drain_parameters,
                "the target revision's deploy-controller.drain_check cannot "
                "bound the queue drain by deadline. Choose a target with "
                "drain deadline support. Nothing has been switched.")

    # -- steps ---------------------------------------------------------
    def refuse_unfinished_controller_transactions(self):
        """Run the controller's unfinished-transaction guard before admission.

        deploy_plan runs this guard before its own switch; this runbook
        bypasses deploy_plan, so it runs the same guard itself, under the
        controller lock this run holds. The forward call runs before the hold
        is claimed: an unresolved journal must refuse the deploy before this
        run stops triggers and starts a drain it cannot finish, not after.
        Controller journals
        (``controller-*.json``) live in ``--record-dir`` and, for unit
        transactions, in the overlay's ``record_dir``; the run's private
        directory never holds them, so both real directories are scanned.
        """
        directories = [Path(self.args.record_dir)]
        overlay_dir = (self.overlay or {}).get("record_dir")
        if overlay_dir is not None and Path(overlay_dir) not in directories:
            directories.append(Path(overlay_dir))
        for directory in directories:
            try:
                self.controller.refuse_unfinished_transactions(
                    self.controller.Effects(self.root, directory))
            except self.controller.Refused as exc:
                raise Refused("unfinished controller transaction in "
                              + str(directory) + "; recover it before "
                              "switching: " + str(exc)) from exc

    def _run(self):
        require(self.args.root and Path(self.args.root).is_dir(),
                "--root must name the deployment checkout")
        require(self.args.overlay and Path(self.args.overlay).is_file(),
                "--overlay must name the private host overlay")
        self.lock.acquire()
        self.prior_sha = self.git("rev-parse", "HEAD")
        require(SHA_RE.match(self.prior_sha),
                "live HEAD is not a full commit SHA: " + repr(self.prior_sha))
        self.assert_clean()
        self.target = resolve_target(self.root, self.args.target_sha,
                                     fetch=not self.args.no_fetch)
        require(self.target != self.prior_sha,
                "target " + self.target + " is already the checked-out HEAD")
        if self.args.tag is not None:
            require(re.match(r"crq-runner/[0-9]{8}-[0-9]+\Z", self.args.tag),
                    "--tag must be crq-runner/YYYYMMDD-N")
        self.claim_run_dir()
        self.phase("resolved")
        self.resolve_modules(Path(self.run_dir) / "candidate-ops")
        self.overlay, self.overlay_raw = self.helper.load_overlay(
            Path(self.args.overlay))
        self.helper.root_check(self.root, self.overlay)
        self.effects = self.controller.Effects(self.root, self.run_dir)
        # One shared exclusion with controller transactions, entered before
        # any mutation: every controller mutation (checkout deploy or
        # rollback, a --unit switch, recovery) holds this same controller
        # lock through Effects.controller_lock, and this driver is the only
        # other checkout/unit mutator. deploy.lock cannot provide this:
        # controller transactions read neither it nor the admission marker.
        # Held through the switches, the released health window and any
        # rollback; released in run().
        self.controller_guard = contextlib.ExitStack()
        self.controller_guard.enter_context(self.effects.controller_lock())
        # prior_sha was read before the lock; a controller switch may have
        # moved HEAD in between. Refuse before any switch so the rollback
        # target and the measured baseline describe the same checkout.
        require(self.git("rev-parse", "HEAD") == self.prior_sha,
                "live HEAD changed before the controller lock was acquired; "
                "nothing has been switched. Retry the deploy.")
        if self.units is None:
            self.units = RealUnits()
        self.original_config = read_config(self.root)
        self.cq_bin = measure_cq_bin(self.original_config)
        self.preserved = self.controller.preserved_digests(self.effects)
        compatibility = self.controller.compatibility_record(self.effects,
                                                             self.prior_sha)
        require(self.controller.rollback_compatible(compatibility),
                "the live queue disables automatic rollback, so this deploy "
                "would have no fallback: " + compatibility_reason(compatibility)
                + ". Drain or reconcile the queue with the owner first.")
        self.triggers, self.services = self.units.inventory()
        require(self.triggers,
                "no installed crq-*.timer or crq-*.path units found; refusing "
                "to deploy against an empty inventory")
        self.original = {unit: self.units.state(unit)
                         for unit in self.triggers}
        unsettled = {unit: state for unit, state in self.original.items()
                     if state not in SETTLED_STATES}
        require(not unsettled,
                "trigger state is unsettled; refusing to guess: "
                + json.dumps(unsettled, sort_keys=True))
        self.phase("prepared", triggers=self.original,
                   cq_bin=self.cq_bin)
        # The switch fence renders config only: nothing in this flow installs
        # or verifies unit files, reloads the user manager, or restores prior
        # definitions on rollback. A target that changes rendered unit
        # templates would restart triggers against stale installed
        # definitions, so detect the delta here and refuse before any unit
        # is stopped.
        self.require_unchanged_unit_templates()

        # The unfinished-transaction guard runs here, under the controller lock
        # and before the hold is claimed: an unresolved journal would otherwise
        # be detected only after the hold and trigger stop, so a drain that
        # never settles would keep this run's own hold and never reach the
        # check. A clear journal still permits the normal drain and switch.
        self.refuse_unfinished_controller_transactions()

        # The held phase rewrites phase.json, so the pre-admission evidence
        # must be copied to its own immutable receipt first: if this process
        # dies in the drain or the switch, the receipt is what recovery reads.
        self.persist_recovery_receipt()
        self.acquire_hold(Hold(self.root))
        self.phase("held")
        self.narrate("hold acquired; stopping triggers")
        self.stop_triggers()
        self.phase("stopped", triggers=self.original)
        self.drain_services()
        self.drain_queue()
        self.recheck_baseline()
        self.phase("drained")

        self.narrate("switching to " + self.target)
        self.switch_attempted = True
        self.helper.switch(self.root, self.overlay, self.overlay_raw,
                           self.target, self.args.tag)
        self.switched = True
        require(self.git("rev-parse", "HEAD") == self.target,
                "helper returned but HEAD is not the target")
        self.phase("switched")
        self.verify_after_switch()
        # The marker stops the runner before it can advance a tick, so
        # health cannot be observed while it is held. Everything the deploy
        # had to prove has now been proven; release admission immediately
        # before the restart and re-acquire a hold if health fails.
        self.release_admission()
        self.restart_triggers()
        self.phase("restarted", triggers=self.final_triggers)

        health = self.check_health()
        durable_write(Path(self.run_dir) / "health.json", health)
        if not health.get("healthy"):
            raise HealthFailed("health check failed: "
                               + str(health.get("reason") or "not healthy"))
        self.complete()
        return self.document("completed")

    def stop_triggers(self):
        require(self.hold.owns(), "hold lost before trigger stop")
        self.units.stop(sorted(self.triggers))
        observed = {unit: self.units.state(unit) for unit in self.triggers}
        require(all(state in DEAD_STATES for state in observed.values()),
                "trigger stop did not settle: "
                + json.dumps(observed, sort_keys=True))

    def drain_services(self):
        deadline = self.clock() + self.args.service_drain_deadline_s
        while True:
            observed = {unit: self.units.state(unit) for unit in self.services}
            if all(state in DEAD_STATES for state in observed.values()):
                return
            if self.clock() >= deadline:
                raise FailStop(
                    "service drain expired after "
                    + str(self.args.service_drain_deadline_s)
                    + "s; hold retained, nothing killed: "
                    + json.dumps(observed, sort_keys=True))
            self.sleep(5)

    def drain_queue(self, record_name="drain.json"):
        if self.drain_fn is not None:
            polls = [self.drain_fn()]
            result = polls[0]
            durable_write(Path(self.run_dir) / record_name,
                          {"polls": polls,
                           "drained": bool(result.get("drained")),
                           "deadline_s": None})
            if not result.get("drained"):
                # The injected drain is a single observation; anything but a
                # clean answer is treated exactly like an expired deadline.
                raise FailStop(
                    "queue drain expired; hold retained, nothing killed: "
                    + json.dumps(result.get("blocked"), sort_keys=True))
        else:
            liveness = self.controller._runner_liveness(self.effects)
            polls = []
            deadline = self.clock() + self.args.drain_deadline_s
            while True:
                # The deadline is enforced inside the scan, not only around
                # it: the controller caps each probe to the time left and
                # reports work it never observed before expiry as
                # unresolved, so a poll whose probes all run to their own
                # timeout cannot spend minutes past the deadline before
                # this loop reads the clock again.
                result = self.controller.drain_check(self.effects, liveness,
                                                     deadline=deadline,
                                                     clock=self.clock)
                polls.append(result)
                # A drained answer only counts while the deadline holds: an
                # observation taken at or after expiry fails closed, even if
                # the queue settled while an over-long interval slept.
                # One clock read decides both branches and the sleep, so a
                # deadline that passes between reads cannot yield a negative
                # sleep (time.sleep raises ValueError on one).
                now = self.clock()
                if result["drained"] and now < deadline:
                    break
                if now >= deadline:
                    late_clean = bool(result["drained"])
                    record = {"polls": polls,
                              "drained": False,
                              "deadline_s": self.args.drain_deadline_s}
                    if late_clean:
                        record["drained_after_deadline"] = True
                    try:
                        durable_write(Path(self.run_dir) / record_name,
                                      record)
                    except OSError as exc:
                        # A diagnostic that cannot be recorded must not
                        # replace the FailStop: live work may still be
                        # running against this checkout, and an escaping
                        # I/O error would reach recovery as an ordinary
                        # refusal that restarts the triggers and releases
                        # admission.
                        try:
                            self.narrate("drain.json could not be written ("
                                         + repr(exc)[:200] + ")")
                        except OSError:
                            # Narration shares the failing filesystem; it
                            # must not replace the FailStop either.
                            pass
                    raise FailStop(
                        "queue drain expired after "
                        + str(self.args.drain_deadline_s)
                        + "s; hold retained, nothing killed: "
                        + ("the queue reported drained only after the "
                           "deadline, so the answer was not accepted"
                           if late_clean else
                           json.dumps(result.get("blocked"), sort_keys=True)))
                # Never wait past the deadline this loop enforces: cap the
                # interval at the time that remains.
                self.sleep(min(self.args.drain_interval_s,
                               deadline - now))
        result = polls[-1]
        if self.drain_fn is None:
            durable_write(Path(self.run_dir) / record_name,
                          {"polls": polls,
                           "drained": bool(result.get("drained")),
                           "deadline_s": self.args.drain_deadline_s})
            require(result.get("drained"),
                    "queue drain reported live or ambiguous work: "
                    + json.dumps(result.get("blocked"), sort_keys=True))

    def recheck_baseline(self):
        """Re-measure the preserved state once the host is quiescent.

        Preflight measures before admission is held, so a tick can still run
        in between. After the drain nothing should be moving: this is the
        baseline the switch must preserve, and rollback permission is proven
        again here, immediately before the checkout moves.

        The immutable recovery receipt keeps the pre-admission measurements,
        so this re-measurement is persisted as its own durable checkpoint
        before the switch: a tick that finished during the drain may have
        moved the queue and heartbeat away from the receipt's digests, and a
        process that dies in the switch must still leave the operator the
        digests the switch was actually required to preserve. ``phase.json``
        is not that evidence: every later phase rewrites it.
        """
        live_config = read_config(self.root)
        require(live_config == self.original_config,
                "live config changed while admission was being held; "
                "nothing was switched")
        require(measure_cq_bin(live_config) == self.cq_bin,
                "the runtime pointer changed while admission was being held; "
                "nothing was switched")
        self.preserved = self.controller.preserved_digests(self.effects)
        compatibility = self.controller.compatibility_record(self.effects,
                                                             self.prior_sha)
        require(self.controller.rollback_compatible(compatibility),
                "the queue no longer grants automatic rollback after the "
                "drain: " + compatibility_reason(compatibility)
                + "; nothing was switched")
        durable_write(Path(self.run_dir) / "post-drain-baseline.json",
                      {"operation": "deploy", "written_at": now_iso(),
                       "target": self.target, "prior_sha": self.prior_sha,
                       "preserved": self.preserved})
        self.phase("remeasured", preserved=sorted(self.preserved))

    def require_unchanged_unit_templates(self):
        """Refuse a target that changes the rendered unit templates.

        Unit installation is owner ceremony (prepare --units-output into the
        user manager), not part of this flow: the switch fence renders the
        config only, so a changed crq-* template (added, removed or
        rewritten) would leave the restarted triggers running stale
        installed definitions, and a rollback could not restore the prior
        ones. The rendered bytes are the template bytes with the fixed
        checkout root and no runtime override, so comparing the committed
        template blobs is exact; any delta must be installed and verified
        by the owner first, and this deploy refuses before stopping units.
        """
        source_dir = "apps/crq-python/ops/systemd/"

        def templates(sha):
            listing = self.git("ls-tree", "-r", "--name-only", sha,
                               source_dir)
            return {name: self.git("rev-parse", sha + ":" + name)
                    for name in sorted(listing.splitlines())
                    if Path(name).name.startswith("crq-")}

        prior = templates(self.prior_sha)
        target = templates(self.target)
        changed = sorted(name for name in set(prior) | set(target)
                         if prior.get(name) != target.get(name))
        require(not changed,
                "target " + self.target[:12] + " changes rendered unit "
                "templates this flow cannot reconcile: it installs no unit "
                "files, verifies none with the user manager, and rollback "
                "cannot restore the prior definitions. This runbook cannot "
                "deploy a template-changing target from the current "
                "checkout: installing the unit files changes neither Git "
                "tree, so a retry finds the same delta and refuses again. "
                "Complete the template change through the separate owner "
                "ceremony documented in apps/crq-python/ops/HOST-DEPLOY.md "
                "(\"Owner procedure for any template-changing target\": "
                "prepare --units-output into the user manager); changed "
                "templates: " + ", ".join(changed))

    def verify_after_switch(self):
        """The three facts a switch must not change: queue bytes, runtime
        pointer and rollback permission."""
        self.runtime_pointer_check()
        observed = self.controller.preserved_digests(self.effects)
        changed = sorted(key for key in self.preserved
                         if observed.get(key) != self.preserved[key])
        require(not changed,
                "shared queue state changed during the switch: "
                + ", ".join(changed) + "; this deploy is failed")
        compatibility = self.controller.compatibility_record(
            self.effects, self.prior_sha)
        self.post_compatibility = compatibility
        # Refuse while the hold is still owned: releasing admission and
        # starting the target's triggers without rollback permission would
        # admit work on the target this run cannot undo. The refusal routes
        # to rollback_to_prior, whose compatibility checks then retain the
        # hold for the owner instead.
        require(self.controller.rollback_compatible(compatibility),
                "the switch left the queue without automatic rollback "
                "permission: " + compatibility_reason(compatibility)
                + "; refusing before admission is released and the target's "
                "triggers are started")

    def runtime_pointer_check(self):
        live = measure_cq_bin(read_config(self.root))
        require(live["pointer"] == self.cq_bin["pointer"],
                "the switch moved repair.cq_bin from "
                + repr(self.cq_bin["pointer"]) + " to " + repr(live["pointer"])
                + "; a runtime pointer move is a separate, measured decision")
        if not self.cq_bin["placeholder"]:
            require(live["exists"] and live["sha256"] == self.cq_bin["sha256"],
                    "the runtime at " + str(live["pointer"]) + " is not the "
                    "measured entry (" + str(self.cq_bin["sha256"]) + "); "
                    "refusing to restart against unverified bytes")

    def restart_triggers(self):
        active = sorted(unit for unit, state in self.original.items()
                        if state == "active")
        self.units.start(active)
        observed = {unit: self.units.state(unit) for unit in self.triggers}
        require(observed == self.original,
                "trigger restart mismatch: observed "
                + json.dumps(observed, sort_keys=True) + " expected "
                + json.dumps(self.original, sort_keys=True))
        verified = {unit: self.units.state(unit) for unit in self.triggers}
        require(verified == self.original,
                "trigger restart verification mismatch: second read "
                + json.dumps(verified, sort_keys=True))
        self.final_triggers = verified

    def check_health(self):
        if self.health_fn is not None:
            return self.health_fn()
        first = [True]

        def observe(prior_tick):
            if first[0]:
                first[0] = False
                return self.controller.wait_for_first_tick(
                    self.effects, prior_tick, self.args.health_timeout_s,
                    sleep=self.sleep, clock=self.clock)
            if self.args.health_interval_s:
                self.sleep(self.args.health_interval_s)
            return self.controller.health_observation(self.effects, prior_tick)

        result = self.controller.two_slot_health(self.effects, observe)
        states = {unit: self.units.state(unit) for unit in self.triggers}
        expected_active = {unit for unit, state in self.original.items()
                           if state == "active"}
        stopped = {unit: state for unit, state in states.items()
                   if unit in expected_active and state != "active"}
        result["unit_states"] = states
        if stopped:
            result["healthy"] = False
            result["reason"] = ("restarted trigger(s) not active: "
                                + json.dumps(stopped, sort_keys=True))
        return result

    def acquire_hold(self, hold):
        """Acquire ``hold`` as this run's. A bare RecoveryRequired (the marker
        exists but its durability could not be verified) goes through
        fail_stop so deploy.json carries the receipt and the run id; the
        marker is retained, never deleted. A Refused still propagates."""
        self.hold = hold
        try:
            hold.acquire()
        except RecoveryRequired as exc:
            if exc.record:
                raise
            self.fail_stop(str(exc))

    def release_hold(self):
        """Release the marker; a recovery-required failure from the hold
        carries no run record, so fail-stop records it (run_dir, outcome,
        trigger map) and keeps the hold instead of letting recover() re-raise
        a bare exception that main() cannot describe."""
        try:
            self.hold.release()
        except RecoveryRequired as exc:
            if exc.record:
                raise
            self.fail_stop(str(exc))

    # -- terminal states ----------------------------------------------
    def release_admission(self):
        require(self.hold is not None and self.hold.owns(),
                "cannot release admission: the marker is not this run's")
        self.release_hold()
        self.released = True
        self.phase("admission_released")

    def complete(self):
        compatibility = self.controller.compatibility_record(
            self.effects, self.prior_sha)
        self.rollback = {
            "permitted": self.controller.rollback_compatible(compatibility),
            "to": self.prior_sha,
            "cq_bin": self.cq_bin,
            "statement": "rollback is available while the queue carries no "
                         "schema marker or author_* keys; this run invoked it "
                         "only on failure",
        }
        self.write_record("completed", released=True)
        self.phase("released", triggers=self.final_triggers)
        self.narrate("deployed " + self.target[:12] + " (was "
                     + self.prior_sha[:12] + "); health ok")

    def rollback_to_prior(self, reason):
        """Automatic rollback after a failed switch, verification or health
        check. Refuses when the queue no longer grants it."""
        # Admission was released for the health window. Reclaim it before any
        # refusal can fail-stop, or a disabled rollback would leave the failed
        # target's triggers running with no marker holding them.
        if self.hold is None or not getattr(self.hold, "acquired", False):
            hold = Hold(self.root)
            try:
                self.acquire_hold(hold)
            except Refused as exc:
                self.fail_stop(
                    "cannot reacquire admission for rollback: " + str(exc)
                    + "; the failed target is still installed and its triggers "
                    "may be running (after: " + reason[:200] + ")")
        require(self.hold.owns(), "hold lost before rollback")
        record = getattr(self, "post_compatibility", None)
        if record is None:
            record = self.controller.compatibility_record(self.effects,
                                                          self.prior_sha)
        if not self.controller.rollback_compatible(record):
            self.fail_stop(
                "automatic rollback is disabled: " + compatibility_reason(record)
                + "; the hold is retained and the owner must recover (after: "
                + reason[:200] + ")")
        compatibility = self.controller.compatibility_record(self.effects,
                                                             self.prior_sha)
        if not self.controller.rollback_compatible(compatibility):
            self.fail_stop(
                "automatic rollback is disabled by the queue's current shape: "
                + compatibility_reason(compatibility) + "; the hold is retained"
                + " (after: " + reason[:200] + ")")
        self.narrate("rolling back to " + self.prior_sha[:12] + ": " + reason)
        self.units.stop(sorted(self.triggers))
        observed = {unit: self.units.state(unit) for unit in self.triggers}
        require(all(state in DEAD_STATES for state in observed.values()),
                "rollback trigger stop did not settle: "
                + json.dumps(observed, sort_keys=True))
        self.drain_services()
        self.drain_queue(record_name="rollback-drain.json")
        # If admission was released, a completed health tick legitimately
        # advanced the queue and heartbeat. Re-measure after the rollback
        # drain and require the rollback switch to preserve those bytes;
        # before release, the pre-deploy baseline is still the invariant.
        baseline = (self.controller.preserved_digests(self.effects)
                    if self.released else self.preserved)
        # The rollback drain itself can change the queue's shape, so the
        # permission proven before it is stale: re-measure the state the
        # completed drains left and refuse the switch if it is incompatible.
        compatibility = self.controller.compatibility_record(self.effects,
                                                             self.prior_sha)
        if not self.controller.rollback_compatible(compatibility):
            self.fail_stop(
                "automatic rollback is disabled after the rollback drain: "
                + compatibility_reason(compatibility) + "; the hold is retained"
                + " (after: " + reason[:200] + ")")
        # The rollback switch is fenced by the same unfinished-transaction
        # guard as the forward switch; a refusal keeps the hold and is
        # surfaced as recovery_required.
        self.refuse_unfinished_controller_transactions()
        # Rollback restores the recorded prior SHA and the exact measured
        # pre-deploy config bytes; the prior revision ran live, so it is not
        # re-verified as a deploy target (it may be a local merge that is not
        # on origin/main). A helper without the keyword cannot do this.
        self.helper.switch(self.root, self.overlay, self.overlay_raw,
                           self.prior_sha, None,
                           rollback_config=self.original_config)
        self.switched = False
        require(self.git("rev-parse", "HEAD") == self.prior_sha,
                "helper returned but HEAD is not the prior SHA")
        live_config = read_config(self.root)
        require(live_config == self.original_config,
                "rolled-back config bytes differ from the measured pre-deploy "
                "bytes; the cq_bin pointer was not restored exactly")
        observed = self.controller.preserved_digests(self.effects)
        changed = sorted(key for key in baseline
                         if observed.get(key) != baseline[key])
        require(not changed,
                "shared queue state changed during rollback: "
                + ", ".join(changed))
        # The checkout switch does not restore an external runtime entry. The
        # entry that failed the forward check is still the entry these
        # triggers would execute, so re-verify it before starting anything.
        self.runtime_pointer_check()
        active = sorted(unit for unit, state in self.original.items()
                        if state == "active")
        self.units.start(active)
        observed = {unit: self.units.state(unit) for unit in self.triggers}
        require(observed == self.original,
                "rollback trigger restart mismatch: observed "
                + json.dumps(observed, sort_keys=True) + " expected "
                + json.dumps(self.original, sort_keys=True))
        self.final_triggers = observed
        self.rollback = {"permitted": True, "to": self.prior_sha,
                         "reason": reason[:400], "cq_bin": self.cq_bin,
                         "restored_config_sha256": sha256_bytes(live_config)}
        if self.hold.acquired:
            self.release_hold()
            self.released = True
        self.write_record("rolled_back", released=True, reason=reason[:400])
        self.phase("rolled_back", triggers=self.final_triggers)
        self.narrate("rolled back to " + self.prior_sha[:12]
                     + "; triggers restored")

    def admission_held(self):
        """Whether admission is held by this run right now (None: marker
        unreadable, so ownership is unknown).

        A failed rollback reacquires admission and can fail again before
        releasing it, leaving the hold retained while ``released`` is still
        True: ``released`` records the earlier health-window release (and
        selects the rollback digest baseline), so the recovery record must
        report the current admission state separately."""
        if self.hold is None:
            return False
        return self.hold.ownership()

    def document(self, outcome, **extra):
        return {
            "operation": "deploy",
            "outcome": outcome,
            "released": self.released,
            "admission_held": self.admission_held(),
            "target": self.target,
            "prior_sha": self.prior_sha,
            "tag": self.args.tag,
            "run_dir": str(self.run_dir) if self.run_dir else None,
            "cq_bin": self.cq_bin,
            "original_triggers": self.original,
            "final_triggers": self.final_triggers,
            "rollback": self.rollback,
            **extra,
        }

    def write_record(self, outcome, **extra):
        document = self.document(outcome, **extra)
        document["written_at"] = now_iso()
        document["module_digests"] = getattr(self, "module_digests", None)
        durable_write(Path(self.run_dir) / "deploy.json", document)
        return document

    # -- failure paths -------------------------------------------------
    def fail_stop(self, reason):
        """Keep the hold (reacquiring it if this run released admission)
        and leave the host inert; owner recovery."""
        reacquire_refusal = None
        if self.hold is not None and (
                not getattr(self.hold, "acquired", False)
                or self.hold.ownership() is not True):
            # ``acquired`` can be stale or unverifiable (an unreadable or
            # missing marker): re-check ownership here. acquire() creates
            # the marker exclusively, so a foreign or unreadable marker is
            # never touched and surfaces as the reacquire refusal.
            # Admission was released for the health window: reclaim this
            # run's marker before stopping triggers so the host stays inert
            # behind it. A refusal (typically a foreign marker) still holds
            # admission, so keep it and report it below rather than hide it;
            # triggers are only ever stopped under a hold this run owns.
            try:
                self.hold.acquire()
            except Exception as exc:
                reacquire_refusal = repr(exc)
                self.narrate("fail-stop could not reacquire admission: "
                             + repr(exc))
        if self.hold is not None and self.hold.owns():
            try:
                self.units.stop(sorted(self.triggers))
            except Exception as exc:  # the hold is what matters
                self.narrate("fail-stop could not stop triggers: " + repr(exc))
        record = self.document("recovery_required", reason=str(reason)[:400])
        if reacquire_refusal is not None:
            record["admission_reacquire_refusal"] = reacquire_refusal[:400]
        record["written_at"] = now_iso()
        if self.run_dir is not None:
            try:
                durable_write(Path(self.run_dir) / "deploy.json", record)
                self.phase("recovery_required", reason=str(reason)[:400],
                           triggers=self.original)
            except OSError as exc:
                # A storage failure here must not escape fail-stop: surface
                # the in-memory receipt and the persistence error through
                # RecoveryRequired so the owner learns nothing was written.
                record["persistence_error"] = repr(exc)[:400]
                raise RecoveryRequired(
                    str(reason) + "; the recovery record could not be "
                    "persisted (" + repr(exc)[:200] + ")", record) from exc
        raise RecoveryRequired(str(reason), record)

    def restore_before_switch(self, reason):
        """Nothing live was switched: verify the pre-switch measurements
        still hold, then restart what this run stopped and release this
        run's own marker. A restore failure is a fail-stop."""
        if self.hold is None or not getattr(self.hold, "acquired", False):
            return
        try:
            # Nothing was switched, so the live config and the preserved
            # queue identity must still match what was measured before the
            # switch. Changed or unreadable state keeps the hold and falls
            # through to the fail-stop below; only surfaces verified
            # unchanged may restart triggers and release admission.
            require(read_config(self.root) == self.original_config,
                    "live config no longer matches the pre-switch "
                    "measurement")
            require(self.controller.preserved_digests(self.effects)
                    == self.preserved,
                    "preserved queue identity no longer matches the "
                    "pre-switch measurement")
            # The checkout never moved, but the runtime entry these triggers
            # would execute could have been deleted or replaced during the
            # drain. The config and queue checks cannot see that, and
            # rollback_to_prior revalidates before its restart: this path
            # must match or a restore resumes admission on unverified bytes.
            self.runtime_pointer_check()
            # ``acquired`` only records that this run once persisted its
            # token; the operator may have replaced the marker with a manual
            # hold since the triggers stopped. Restarting triggers under a
            # foreign marker would resume admission the operator blocked and
            # would exit as if the hold were restored, so ownership is
            # re-proven here and again by ``release`` below; a lost hold
            # falls through to the fail-stop, which leaves the operator's
            # marker in place and reports recovery required.
            require(self.hold.owns(),
                    "the admission marker is no longer this run's; refusing "
                    "to restart triggers under a foreign hold")
            active = sorted(unit for unit, state in (self.original or {}).items()
                            if state == "active")
            if self.original:
                self.units.start(active)
                observed = {unit: self.units.state(unit)
                            for unit in self.triggers or []}
                require(observed == self.original,
                        "pre-switch restore mismatch: observed "
                        + json.dumps(observed, sort_keys=True))
            self.hold.release()
        except Exception as exc:
            self.fail_stop("pre-switch restore failed after refusal ("
                           + str(reason)[:200] + "): " + repr(exc))
            return
        if self.run_dir is not None:
            try:
                self.write_record("refused", reason=str(reason)[:400])
                self.phase("refused", reason=str(reason)[:400])
            except OSError as exc:
                # The host was restored but the refusal cannot be recorded;
                # a storage failure must not end the run unrecorded, so it
                # fail-stops into RecoveryRequired with the receipt.
                self.fail_stop("the refused record could not be persisted ("
                               + repr(exc)[:200] + ") after: "
                               + str(reason)[:200])
                return

    def recover(self, exc):
        """Route a failure to the safe terminal state."""
        if isinstance(exc, RecoveryRequired):
            raise exc
        reason = str(exc) or type(exc).__name__
        if isinstance(exc, FailStop) and not self.switched:
            # A drain that expired means work may still be running against
            # this checkout; restarting the triggers would resume admission
            # on top of it. Keep the hold and leave recovery to the owner.
            self.fail_stop(reason)
        if self.switched:
            try:
                self.rollback_to_prior(reason)
            except RecoveryRequired:
                raise
            except Exception as rollback_error:
                self.fail_stop("automatic rollback failed (" + repr(
                    rollback_error) + ") after: " + reason[:200])
            return "rolled_back"
        if self.switch_attempted:
            try:
                head = self.git("rev-parse", "HEAD")
            except Exception as exc:
                # A switch was attempted, so an unreadable HEAD means the
                # checkout cannot be proven unchanged; it may have moved.
                # That is recovery required, never an unchanged-host
                # refusal: keep the hold and leave recovery to the owner.
                self.fail_stop("the post-switch HEAD could not be observed ("
                               + repr(exc)[:200] + "): " + reason[:200])
            if head == self.target:
                try:
                    self.rollback_to_prior(reason)
                except RecoveryRequired:
                    raise
                except Exception as rollback_error:
                    self.fail_stop("automatic rollback failed (" + repr(
                        rollback_error) + ") after: " + reason[:200])
                return "rolled_back"
            if head != self.prior_sha:
                self.fail_stop("switch failed and HEAD is neither the prior "
                               "nor the target SHA (" + head + "): " + reason)
        self.restore_before_switch(reason)
        return "refused"

    def run(self):
        try:
            return self._run()
        except HealthFailed as exc:
            self.recover(exc)
            return self.document("rolled_back", reason=str(exc)[:400])
        except (Refused, RecoveryRequired) as exc:
            outcome = self.recover(exc)
            if outcome == "rolled_back":
                return self.document("rolled_back", reason=str(exc)[:400])
            raise Refused(str(exc)) from exc
        except KeyboardInterrupt:
            # BaseException is not caught by the branch above, but an
            # interrupted health window still owns a switched checkout and a
            # released admission marker. Recover, then surface the interrupt.
            self.recover(Refused("interrupted by the operator"))
            raise
        except Exception as exc:
            # Any host or helper failure must reach the safe terminal state,
            # not escape with the hold, units or checkout half-moved. A
            # programming error is still reported, but only after recovery.
            outcome = self.recover(exc)
            if outcome == "rolled_back":
                return self.document("rolled_back", reason=str(exc)[:400])
            raise Refused(str(exc)) from exc
        finally:
            if self.controller_guard is not None:
                self.controller_guard.close()
            self.lock.release()


class HealthFailed(Refused):
    """A health check failed after the switch: roll back, do not fail-stop."""


def compatibility_reason(record):
    """Name the evidence that denied automatic rollback, without paraphrase."""
    if not isinstance(record, dict) or record.get("checked") is not True:
        return "the compatibility record was not checked"
    if record.get("schema_marker_present") is not False:
        schema = record.get("queue_schema")
        if isinstance(schema, str) and schema.startswith("unreadable: "):
            return ("the state queue could not be read ("
                    + schema[len("unreadable: "):] + ")")
        return ("the queue carries an explicit schema marker ("
                + repr(schema) + ") the prior target was never proven to read")
    observed = record.get("schema_observations")
    if observed:
        return ("the queue carries state keys the prior target was never "
                "proven to read: " + ", ".join(map(str, observed)))
    return "the compatibility record is not the clean shape"


# --------------------------------------------------------------------- status


def cmd_status(args, units=None):
    """Report whether the host still matches a run's recorded outcome."""
    run_dir = Path(args.run_dir)
    deploy = load_json(run_dir / "deploy.json")
    require(isinstance(deploy, dict), "deploy.json must be a JSON object")
    outcome = deploy.get("outcome")
    require(outcome in ("completed", "rolled_back"),
            "this run did not finish (" + repr(outcome) + "); it is not a "
            "released record")
    expected_head = (deploy.get("target") if outcome == "completed"
                     else deploy.get("prior_sha"))
    require(isinstance(expected_head, str) and SHA_RE.match(expected_head),
            "record does not name an expected HEAD")
    root = Path(args.root)
    units = units or RealUnits()
    final = deploy.get("final_triggers")
    live_head = None
    live = None
    refused = None
    # HEAD, the marker and the trigger states must describe one deployment.
    # A deploy holds deploy.lock and the controller lock from before its
    # first measurement through its released health window, so claiming both
    # here fences these observations against a concurrent deploy or
    # controller transaction. A busy lock means a transition is in flight and
    # the answer would mix two deployments, so report that status cannot be
    # verified instead of answering from observations that straddle it.
    with contextlib.ExitStack() as guard:
        try:
            controller = load_module("crq_deploy_runbook_status_controller",
                                     OPS_DIR / "deploy-controller.py")
        except Refused as exc:
            refused = ("status cannot be verified during a deployment "
                       "transition: " + str(exc))
        else:
            try:
                deploy_lock = DeployLock(root)
                deploy_lock.acquire()
                guard.callback(deploy_lock.release)
                guard.enter_context(
                    controller.Effects(root, run_dir).controller_lock())
            except (Refused, controller.Refused) as exc:
                refused = ("status cannot be verified during a deployment "
                           "transition: " + str(exc))
            else:
                live_head = git(root, "rev-parse", "HEAD")
                marker = root / MARKER_RELPATH
                if marker.exists():
                    refused = "the admission marker is present: units are held"
                elif live_head != expected_head:
                    refused = ("live HEAD " + live_head + " is not the recorded "
                               + expected_head)
                elif not isinstance(final, dict) or not final:
                    refused = "record carries no trigger map to compare"
                else:
                    live = {unit: units.state(unit) for unit in sorted(final)}
                    drifted = {unit: {"live": state, "recorded": final.get(unit)}
                               for unit, state in live.items()
                               if final.get(unit) != state}
                    if drifted:
                        refused = ("live trigger state differs from the record: "
                                   + json.dumps(drifted, sort_keys=True))
    print(json.dumps({"operation": "status",
                      "ok": refused is None,
                      "outcome": outcome,
                      "refusal": refused,
                      "run_dir": str(run_dir),
                      "expected_head": expected_head,
                      "live_head": live_head,
                      "final_triggers": final,
                      "live_triggers": live}, indent=2, sort_keys=True))
    return 0 if refused is None else 1


# ------------------------------------------------------------------------ CLI


def error_artifact(kind, subcommand, message, exit_code):
    """The one JSON artifact for an error with no result (doctrine I1)."""
    return {"error": {"kind": kind, "subcommand": subcommand,
                      "message": message, "exitCode": exit_code}}


class JsonArgumentParser(argparse.ArgumentParser):
    """argparse parser that answers argument failures with the I1 artifact.

    Machine mode (--json) is shared with the subparsers argparse derives from
    this class, so every usage error -- on this parser or a subparser --
    writes one error object to stdout with exit code 2 and keeps stderr
    empty. Without --json, the same artifact still goes to stdout (I1:
    stdout is always one JSON artifact) and the usage narration goes to
    stderr.
    """

    json_mode = False
    subcommand = None

    def error(self, message):
        print(json.dumps(error_artifact("usage", self.subcommand,
                                        str(message)[:400], 2),
                         indent=2, sort_keys=True))
        if not self.json_mode:
            print("usage: " + str(message), file=sys.stderr)
        raise SystemExit(2)


def build_parser():
    parser = JsonArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true",
                        help="machine mode: narration stays off stderr; every "
                             "error is one JSON artifact on stdout")
    sub = parser.add_subparsers(dest="operation", required=True)

    deploy = sub.add_parser("deploy", help="merged main SHA in, health-checked")
    deploy.add_argument("--root", required=True, type=Path)
    deploy.add_argument("--overlay", required=True, type=Path)
    deploy.add_argument("--record-dir", required=True, type=Path)
    deploy.add_argument("--target-sha", metavar="SHA40", default=None,
                        help="merged main commit; default: origin/main")
    deploy.add_argument("--tag", metavar="TAG", default=None,
                        help="optional annotated runner tag; omitted for a "
                             "merged main SHA")
    deploy.add_argument("--no-fetch", action="store_true",
                        help="do not fetch origin/main first")
    deploy.add_argument("--service-drain-deadline-s", type=int, default=180)
    deploy.add_argument("--drain-interval-s", type=int, default=15)
    deploy.add_argument("--drain-deadline-s", type=int, default=900)
    deploy.add_argument("--health-timeout-s", type=int, default=1500,
                        help="first completed-tick wait (default: 12-minute "
                             "cadence plus slack)")
    deploy.add_argument("--health-interval-s", type=int, default=900,
                        help="delay before the second tick observation; must "
                             "exceed one runner cadence")

    status = sub.add_parser("status",
                            help="does the host still match a run's record?")
    status.add_argument("--run-dir", required=True, type=Path)
    status.add_argument("--root", required=True, type=Path)
    return parser


def main(argv=None, run_factory=Run) -> int:
    if argv is None:
        argv = sys.argv[1:]
    parser = build_parser()
    # Machine mode is needed before the parse, because a usage error is the
    # one failure that never produces a namespace to read --json from.
    parser.json_mode = "--json" in argv
    for name, child in parser._subparsers._group_actions[0].choices.items():
        child.json_mode = parser.json_mode
        child.subcommand = name
    args = parser.parse_args(argv)
    parser.subcommand = args.operation
    # A negative timing argument is a usage error, never a mid-run failure:
    # a negative --health-interval-s would otherwise surface as
    # time.sleep(-1) in the post-switch second observation and roll back an
    # otherwise healthy deploy. Zero stays valid (--health-interval-s 0
    # means no delay before the second observation; a zero deadline simply
    # expires immediately). This answers as the I1 usage artifact with exit
    # code 2, before Run() is constructed and anything touches the host.
    if args.operation == "deploy" and min(args.service_drain_deadline_s,
                                          args.drain_interval_s,
                                          args.drain_deadline_s,
                                          args.health_timeout_s,
                                          args.health_interval_s) < 0:
        parser.error("deploy timing arguments must be nonnegative")
    try:
        if args.operation == "status":
            return cmd_status(args)
        run = run_factory(args)
        document = run.run()
        print(json.dumps(document, indent=2, sort_keys=True))
        return 0 if document.get("outcome") == "completed" else 1
    except RecoveryRequired as exc:
        record = exc.record or {}
        error = {"kind": "recovery_required",
                 "operation": args.operation,
                 "message": str(exc)[:400],
                 "run_dir": record.get("run_dir"),
                 "outcome": record.get("outcome")}
        if record.get("persistence_error") is not None:
            # deploy.json could not be written, so this JSON error is the
            # only artifact holding the trigger map, runtime measurement
            # and structured storage error; embed the whole record.
            error["recovery_record"] = record
        print(json.dumps({"error": error}, indent=2, sort_keys=True))
        return 3
    except Refused as exc:
        if args.operation == "status":
            # cmd_status prints its own document; this only covers refusals
            # raised before it could (unreadable record, bad root).
            print(json.dumps({"operation": "status", "ok": False,
                              "refusal": str(exc)[:400]},
                             indent=2, sort_keys=True))
            return 1
        print(json.dumps({"error": {"kind": "refused",
                                    "operation": args.operation,
                                    "message": str(exc)[:400]}},
                         indent=2, sort_keys=True))
        return 2
    except KeyboardInterrupt:
        print(json.dumps({"error": {"kind": "interrupted",
                                    "operation": args.operation,
                                    "message": "interrupted; recovery ran if "
                                               "a deploy was in progress"}},
                         indent=2, sort_keys=True))
        # An interrupt is a thrown error, so it stays inside the I1 exit-code
        # contract (0/1/2/3) rather than inventing a signal-style code.
        return 1
    except (OSError, subprocess.CalledProcessError, ValueError) as exc:
        print(json.dumps({"error": {"kind": "refused",
                                    "operation": args.operation,
                                    "message": (str(exc) or type(exc).__name__)[:400]}},
                         indent=2, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
