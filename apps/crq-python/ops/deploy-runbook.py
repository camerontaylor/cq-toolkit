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
  recovery, so two runs cannot switch the checkout under each other.
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
  measured prior SHA with the same helper fence, requires the live config
  bytes to equal the pre-deploy bytes (pointer included), requires the queue
  bytes to survive the rollback switch (re-measured after its own drain when
  a completed health tick may have advanced them), and restarts exactly the
  triggers observed active before the run.

The target's own helper and controller are extracted and executed. A target
whose ``verify_target`` still requires an annotated tag is refused before the
hold: it cannot support a tagless switch or the tagless automatic rollback.

Only a failure *after* the switch triggers automatic rollback: a failed
verification or a failed health check. A failure before the switch restarts
what this run stopped and releases its own marker. A failed rollback keeps
the hold and exits 3 (recovery required) rather than pretend the host is
back. Nothing here drives a per-unit TypeScript cutover; ``--unit`` switches
stay with the controller.

Every invocation writes exactly one JSON document to stdout, including
argument errors and refusals (the machine-mode contract R1/R5 carried before
this simplification). Narration goes to stderr. Exit codes: 0 completed,
1 deploy failed but rolled back cleanly, 2 refused with the host unchanged,
3 recovery required (rollback failed or the drain expired; hold retained).

Python stdlib only.
"""
from __future__ import annotations

import argparse
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
    did not render a runtime) and compared as a string.
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
    if record["exists"]:
        record["sha256"] = sha256_file(entry)
        record["mode"] = oct(entry.stat().st_mode & 0o777)
        record["resolved"] = str(entry.resolve())
    return record


class RealUnits:
    """The live systemd user-unit provider; the only host-mutating seam."""

    def _run(self, *args):
        return subprocess.check_output(args, text=True).strip()

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
            output = subprocess.check_output(args, text=True)
        except subprocess.CalledProcessError as exc:
            # A unit-file pattern that matches nothing exits 1 with no
            # diagnostic; an unavailable bus or any other failure raises.
            if (command == "list-unit-files" and exc.returncode == 1
                    and not (exc.stderr or "").strip()):
                return set()
            raise
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
        self.acquired = False

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL
                                 | os.O_WRONLY, 0o600)
        except FileExistsError as exc:
            raise Refused(
                "admission is already held by " + str(self.path)
                + "; another deploy or a manual hold owns it") from exc
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(self.token)
            handle.flush()
            os.fsync(handle.fileno())
        self.acquired = True

    def owns(self):
        try:
            return self.path.read_bytes() == self.token
        except OSError:
            return False

    def release(self):
        require(self.owns(),
                "cannot release the admission marker: it is not this run's")
        self.path.unlink()
        self.acquired = False


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
        self.root = Path(args.root)
        self.units = units
        self.helper = helper
        self.controller = controller
        self.health_fn = health
        self.drain_fn = drain
        self.clock = clock
        self.sleep = sleep
        self.hold = None
        self.lock = DeployLock(self.root)
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

    def phase(self, name, **extra):
        durable_write(Path(self.run_dir) / "phase.json",
                      {"operation": "deploy", "phase": name, "at": now_iso(),
                       "target": self.target, "prior_sha": self.prior_sha,
                       **extra})

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

    # -- steps ---------------------------------------------------------
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
        if self.units is None:
            self.units = RealUnits()
        self.original_config = read_config(self.root)
        self.cq_bin = measure_cq_bin(self.original_config)
        self.preserved = self.controller.preserved_digests(self.effects)
        compatibility = self.controller.compatibility_record(self.effects,
                                                             self.target)
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

        self.hold = Hold(self.root)
        self.hold.acquire()
        self.phase("held")
        narrate("hold acquired; stopping triggers")
        self.stop_triggers()
        self.phase("stopped", triggers=self.original)
        self.drain_services()
        self.drain_queue()
        self.recheck_baseline()
        self.phase("drained")

        narrate("switching to " + self.target)
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
                result = self.controller.drain_check(self.effects, liveness)
                polls.append(result)
                if result["drained"]:
                    break
                if self.clock() >= deadline:
                    durable_write(Path(self.run_dir) / record_name,
                                  {"polls": polls,
                                   "drained": False,
                                   "deadline_s": self.args.drain_deadline_s})
                    raise FailStop(
                        "queue drain expired after "
                        + str(self.args.drain_deadline_s)
                        + "s; hold retained, nothing killed: "
                        + json.dumps(result.get("blocked"), sort_keys=True))
                self.sleep(self.args.drain_interval_s)
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
                                                             self.target)
        require(self.controller.rollback_compatible(compatibility),
                "the queue no longer grants automatic rollback after the "
                "drain: " + compatibility_reason(compatibility)
                + "; nothing was switched")
        self.phase("remeasured", preserved=sorted(self.preserved))

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
        if not self.controller.rollback_compatible(compatibility):
            self.rollback_disabled = compatibility_reason(compatibility)

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

    # -- terminal states ----------------------------------------------
    def release_admission(self):
        require(self.hold is not None and self.hold.owns(),
                "cannot release admission: the marker is not this run's")
        self.hold.release()
        self.released = True
        self.phase("admission_released")

    def complete(self):
        self.rollback = {
            "permitted": True,
            "to": self.prior_sha,
            "cq_bin": self.cq_bin,
            "statement": "rollback is available while the queue carries no "
                         "schema marker or author_* keys; this run invoked it "
                         "only on failure",
        }
        self.write_record("completed", released=True)
        self.phase("released", triggers=self.final_triggers)
        narrate("deployed " + self.target[:12] + " (was "
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
                hold.acquire()
            except Refused as exc:
                self.fail_stop(
                    "cannot reacquire admission for rollback: " + str(exc)
                    + "; the failed target is still installed and its triggers "
                    "may be running (after: " + reason[:200] + ")")
            self.hold = hold
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
        narrate("rolling back to " + self.prior_sha[:12] + ": " + reason)
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
        self.helper.switch(self.root, self.overlay, self.overlay_raw,
                           self.prior_sha, None)
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
            self.hold.release()
            self.released = True
        self.write_record("rolled_back", released=True, reason=reason[:400])
        self.phase("rolled_back", triggers=self.final_triggers)
        narrate("rolled back to " + self.prior_sha[:12] + "; triggers restored")

    def document(self, outcome, **extra):
        return {
            "operation": "deploy",
            "outcome": outcome,
            "released": self.released,
            "target": self.target,
            "prior_sha": self.prior_sha,
            "tag": self.args.tag,
            "run_dir": str(self.run_dir) if self.run_dir else None,
            "cq_bin": self.cq_bin,
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
        """Keep the hold and leave the host inert; owner recovery."""
        if self.hold is not None and self.hold.owns():
            try:
                self.units.stop(sorted(self.triggers))
            except Exception as exc:  # the hold is what matters
                narrate("fail-stop could not stop triggers: " + repr(exc))
        record = self.document("recovery_required", reason=str(reason)[:400])
        record["written_at"] = now_iso()
        if self.run_dir is not None:
            durable_write(Path(self.run_dir) / "deploy.json", record)
            self.phase("recovery_required", reason=str(reason)[:400])
        raise RecoveryRequired(str(reason), record)

    def restore_before_switch(self, reason):
        """Nothing live was switched: restart what this run stopped and
        release this run's own marker. A restore failure is a fail-stop."""
        if self.hold is None or not getattr(self.hold, "acquired", False):
            return
        try:
            active = sorted(unit for unit, state in (self.original or {}).items()
                            if state == "active")
            if self.original:
                self.units.start(active)
                observed = {unit: self.units.state(unit)
                            for unit in self.triggers or []}
                require(observed == self.original,
                        "pre-switch restore mismatch: observed "
                        + json.dumps(observed, sort_keys=True))
            if self.hold.owns():
                self.hold.release()
        except Exception as exc:
            self.fail_stop("pre-switch restore failed after refusal ("
                           + str(reason)[:200] + "): " + repr(exc))
            return
        if self.run_dir is not None:
            self.write_record("refused", reason=str(reason)[:400])
            self.phase("refused", reason=str(reason)[:400])

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
            head = self.git("rev-parse", "HEAD")
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
        except Exception as exc:
            # Any host or helper failure must reach the safe terminal state,
            # not escape with the hold, units or checkout half-moved. A
            # programming error is still reported, but only after recovery.
            outcome = self.recover(exc)
            if outcome == "rolled_back":
                return self.document("rolled_back", reason=str(exc)[:400])
            raise Refused(str(exc)) from exc
        finally:
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
    live_head = git(root, "rev-parse", "HEAD")
    marker = root / MARKER_RELPATH
    units = units or RealUnits()
    final = deploy.get("final_triggers")
    live = None
    refused = None
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


class JsonArgumentParser(argparse.ArgumentParser):
    """Every argument error is one JSON document on stdout (exit 2)."""

    json_mode = True
    operation = None

    def error(self, message):
        print(json.dumps({"error": {"kind": "argument_error",
                                    "operation": self.operation,
                                    "message": str(message)[:400]}},
                         indent=2, sort_keys=True))
        print("usage: " + str(message), file=sys.stderr)
        raise SystemExit(2)


def build_parser():
    parser = JsonArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true",
                        help="accepted for interface parity; output is JSON")
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
    deploy.operation = "deploy"
    status.operation = "status"
    return parser


def main(argv=None, run_factory=Run) -> int:
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    parser.operation = args.operation
    for name, child in parser._subparsers._group_actions[0].choices.items():
        child.operation = "status" if name == "status" else "deploy"
    try:
        if args.operation == "status":
            return cmd_status(args)
        run = run_factory(args)
        document = run.run()
        print(json.dumps(document, indent=2, sort_keys=True))
        return 0 if document.get("outcome") == "completed" else 1
    except RecoveryRequired as exc:
        record = exc.record or {}
        print(json.dumps({"error": {"kind": "recovery_required",
                                    "operation": args.operation,
                                    "message": str(exc)[:400],
                                    "run_dir": record.get("run_dir"),
                                    "outcome": record.get("outcome")}},
                         indent=2, sort_keys=True))
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
    except (OSError, subprocess.CalledProcessError, ValueError) as exc:
        print(json.dumps({"error": {"kind": "refused",
                                    "operation": args.operation,
                                    "message": (str(exc) or type(exc).__name__)[:400]}},
                         indent=2, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
