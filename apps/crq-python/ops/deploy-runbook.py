#!/usr/bin/env python3
"""The tracked deploy runbook (crq-efficiency plan slice 4).

One entry point for the hold/drain/switch/restore sequence every deploy
wrapper since 2026-11-10 reimplemented by hand on the deploy host. This file
is the reviewed, digest-pinned revision the operator names in a production
GO; the arguments and the per-deploy invariant manifest carry what differs,
so a deploy needs a manifest and arguments, not a new script.

The runbook does not reimplement switching. It imports
``deploy-controller.py`` (``Effects``, ``drain_check``, ``preflight``,
``switch`` CLI) and ``prepare-host.py`` (``load_overlay``, ``render``,
``changed_fields``, ``live_render``, ``inactive``) from the candidate
artifact root exactly as the audited wrappers do, and owns only the
sequence and the assertions.

The two defects the sequence must not inherit (measured, programme lead
2026-11-13):

* **F4 — restore target.** The executed ac13 wrapper's ``restore()`` started
  and asserted against the post-split map: circular, and it left the three
  long triggers stopped. The rule: restore and assert against
  ``self.original``, the states observed before the run; record
  ``final_triggers`` at release; remove the marker last.
* **Quiescence.** The drain must have grace for a run dispatched during
  preflight: a bounded poll of the controller's read-only ``drain_check``
  (owned-run liveness — it must see dispatched runs, not two service names)
  at 15 s interval, 900 s deadline, failing safe on expiry (hold retained,
  nothing killed). The 180-second service-name drain stays as the first
  bound.

Rollback policy (D7) is the controller's own semantics, asserted for
coherence rather than against a fixed answer. ``deploy_plan`` computes
``automatic_rollback_permitted = rollback_compatible({**pre, **post})``:
the permission follows the evidence in BOTH compatibility records. The
runbook asserts four facts of one journal:

* the PRE-switch record lives at
  ``journal["plan"]["preflight"]["rollback_compatibility"]`` and proves the
  queue this deploy started from was readable by the prior target
  (``checked`` true, marker ABSENT, no observations);
* the top-level ``rollback_compatibility`` is the POST-switch record:
  ``checked`` true, ``schema_marker_present`` a real boolean, and
  ``schema_observations`` a list;
* ``automatic_rollback_permitted`` is True, which is the only value the
  controller can record beside those clean records: ``rollback_compatible()``
  grants True exactly on a marker-free, author-free queue;
* that True is made safe BEFORE the switch, from host truth: preflight calls
  the controller's own ``compatibility_record``/``rollback_compatible`` on the
  live queue and refuses, naming the marker or ``author_*`` keys, when the
  permission would be denied. A host where the controller would deny
  automatic rollback therefore never reaches the switch, so the journal's
  True is evidence rather than hope. The refusal is also a runbook policy
  statement: this runbook never invokes rollback, and a host whose queue the
  prior target is not proven to read is not deployable by it.

The release records the granted permission and the operator is told: the
controller's automatic rollback remains available after this deploy, and it
is this runbook's sequence (no rollback call, owner-only recovery) that does
not exercise it. Because the controller both records and consumes this
pair, the rehearsal journal is built by the controller's own
``compatibility_record``/``deploy_journal`` code over a real queue, so a
rehearsal exercises the assertion set on controller-shaped input.

Fail-stop structure kept from the audited wrappers: record intent before
systemctl; restart only what was stopped; never remove a foreign marker;
hold admission until every prior trigger state is verified; acquisition
history stays a distinct terminal state from release.

Python stdlib only.
"""
from __future__ import annotations

import argparse
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

sys.dont_write_bytecode = True

OPS_DIR = Path(__file__).resolve().parent
if str(OPS_DIR) not in sys.path:
    sys.path.insert(0, str(OPS_DIR))

import digests  # noqa: E402  (sibling module, stdlib only)

RUNBOOK_SCHEMA_VERSION = 1
RUNBOOK_SELF_DIGEST = digests.file_digest(Path(__file__).resolve())
HEX40_RE = re.compile(r"[0-9a-f]{40}")
HEX64_RE = re.compile(r"[0-9a-f]{64}")
ANCESTRY_MODES = ("must", "must_not", "either")
RELEASE_ORDER = ("start_original_active", "assert_original",
                 "record_final_triggers", "remove_marker")
DRAIN_MODE = "controller_drain_check_owned_runs"
RESTORE_TARGET = "original_observed"
SCHEMA_PATH = OPS_DIR / "deploy-invariants.schema.json"
LONG_SERVICES = ("crq-repair.service", "crq-backfill.service")
ACTIVE_STATES = ("active", "inactive")
DEAD_STATES = ("inactive", "failed")
DEFAULT_SERVICE_DRAIN_S = 180
DEFAULT_POLL_INTERVAL_S = 15
DEFAULT_DRAIN_DEADLINE_S = 900
# The one admission marker file, relative to the checkout's apps/crq-python
# root: exactly the file the tick reads (crq.py ``STATE / "runner-disabled"``
# with ``STATE = ROOT / "state"`` and ``ROOT = apps/crq-python``). The manifest
# restates this path for review, and execute() refuses any other value so the
# two can never drift.
MARKER_RELPATH = "state/runner-disabled"
# The host placeholder a committed config carries for the runner's cq_bin.
# Only the overlay's render names a real runtime, so any check of the live
# pointer must run after live_render and refuse this token explicitly rather
# than resolving it against the checkout's parent.
PLACEHOLDER = "@HOST_CQ_BIN@"


def marker_path(root) -> Path:
    """The admission marker for a deployment checkout ``root``: the same
    file the tick's own ROOT/STATE constants resolve to, derived once here
    instead of at each call site."""
    return Path(root) / "apps" / "crq-python" / MARKER_RELPATH


class Refused(Exception):
    """A runbook refusal: nothing was changed; the reason is terminal."""


def require(condition, message):
    if not condition:
        raise Refused(message)


def narrate(message):
    """Operator-facing narration on stderr. Stdout stays machine-readable:
    the status subcommand's one JSON document is the only stdout write."""
    print(message, file=sys.stderr)


# ------------------------------------------------------------ schema checker
# A small stdlib validator for the exact vocabulary the checked-in
# deploy-invariants.schema.json uses (like prepare-host.validate for the
# overlay): required keys, exact types, hex shapes via pattern, const/enum,
# additionalProperties false, and the trigger list lengths derived from the
# trigger map rather than hard-coded counts.


def _schema_type_name(value):
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, list):
        return "array"
    if isinstance(value, str):
        return "string"
    if isinstance(value, int):
        return "integer"
    return type(value).__name__


def _rule_type_ok(value, expected):
    names = expected if isinstance(expected, list) else [expected]
    checks = {"object": lambda v: isinstance(v, dict),
              "array": lambda v: isinstance(v, list),
              "string": lambda v: isinstance(v, str),
              "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
              "boolean": lambda v: isinstance(v, bool)}
    return any(checks[name](value) for name in names if name in checks)


def schema_problem(value, rule, at=""):
    """The first violation of ``rule`` at location ``at``, or None.

    Supports the schema vocabulary this manifest actually uses; an unknown
    keyword refuses (fail closed) so a schema/document mismatch can never
    silently disable an assertion.
    """
    where = at or "manifest"
    supported = {"type", "const", "enum", "required", "properties",
                 "additionalProperties", "items", "minItems", "maxItems",
                 "minimum", "minLength", "minProperties", "pattern",
                 "description", "title", "$id"}
    unknown = set(rule) - supported
    if unknown:
        return where + ": unsupported schema keyword " + ",".join(sorted(unknown))
    if "type" in rule and not _rule_type_ok(value, rule["type"]):
        return where + ": type mismatch"
    if "const" in rule and value != rule["const"]:
        return where + ": value mismatch"
    if "enum" in rule and value not in rule["enum"]:
        return where + ": value mismatch"
    if isinstance(value, str):
        if len(value) < rule.get("minLength", 0):
            return where + ": string bound"
        if "pattern" in rule and re.fullmatch(rule["pattern"], value) is None:
            return where + ": pattern mismatch"
    if isinstance(value, dict):
        missing = sorted(set(rule.get("required", [])) - value.keys())
        if missing:
            return where + ": missing " + ",".join(missing)
        if len(value) < rule.get("minProperties", 0):
            return where + ": object bound"
        properties = rule.get("properties", {})
        if rule.get("additionalProperties") is False:
            unknown_keys = sorted(set(value) - set(properties))
            if unknown_keys:
                return where + ": unknown " + ",".join(unknown_keys)
        for key in sorted(set(value) & set(properties)):
            problem = schema_problem(value[key], properties[key],
                                     (at + "." if at else "") + key)
            if problem:
                return problem
    if isinstance(value, list):
        if len(value) < rule.get("minItems", 0):
            return where + ": array bound"
        if len(value) > rule.get("maxItems", len(value)):
            return where + ": array bound"
        item_rule = rule.get("items")
        if item_rule:
            for index, item in enumerate(value):
                problem = schema_problem(item, item_rule,
                                         where + "[" + str(index) + "]")
                if problem:
                    return problem
    if (_rule_type_ok(value, "integer") and "minimum" in rule
            and value < rule["minimum"]):
        return where + ": below minimum"
    return None


def manifest_problem(manifest, schema):
    """Validate a parsed manifest against the parsed schema; None or reason."""
    return schema_problem(manifest, schema)


def load_json(path: Path):
    try:
        return json.loads(Path(path).read_bytes())
    except OSError as exc:
        raise Refused("unreadable: " + str(path) + ": " + str(exc)[:120]) from exc
    except ValueError as exc:
        raise Refused("invalid JSON in " + str(path) + ": " + str(exc)[:120]) from exc


# ------------------------------------------------------------- unit provider


class RealUnits:
    """The live systemd user-unit provider (the only host-mutating seam).

    Every unit observation and every stop/start goes through this class, so
    a rehearsal substitutes a fake provider and touches no host state.
    """

    def __init__(self, marker_path: Path):
        self.marker = Path(marker_path)

    def _run(self, *args):
        return subprocess.check_output(args, text=True).strip()

    def state(self, unit):
        return self._run("systemctl", "--user", "show", unit,
                         "-pActiveState", "--value")

    def listing(self):
        return self._run("systemctl", "--user", "list-unit-files", "crq-*",
                         "--no-legend", "--no-pager")

    def inventory(self):
        names = [line.split()[0] for line in self.listing().splitlines()
                 if line.split()]
        triggers = sorted(n for n in names if n.endswith((".timer", ".path")))
        services = sorted(n for n in names if n.endswith(".service"))
        return triggers, services

    def stop(self, units):
        if units:
            self._run("systemctl", "--user", "stop", *units)

    def start(self, units):
        if units:
            self._run("systemctl", "--user", "start", *units)


class RehearsalUnits:
    """The host-free unit provider ``--rehearsal`` binds: the inventory comes
    from the manifest's reviewed trigger/service lists and all state lives in
    memory. It never executes systemctl, so a rehearsal cannot touch the
    host's units."""

    def __init__(self, marker_path, expected_triggers, expected_services):
        self.marker = Path(marker_path)
        self._triggers = sorted(expected_triggers)
        self._services = sorted(expected_services)
        self.states = {unit: "active" for unit in self._triggers}
        self.started = []
        self.stopped = []

    def state(self, unit):
        return self.states.get(unit, "inactive")

    def listing(self):
        return "\n".join(sorted(self._triggers + self._services)) + "\n"

    def inventory(self):
        return list(self._triggers), list(self._services)

    def stop(self, units):
        self.stopped.extend(units)
        for unit in units:
            self.states[unit] = "inactive"

    def start(self, units):
        self.started.extend(units)
        for unit in units:
            self.states[unit] = "active"


# ---------------------------------------------------------------- effects


class RunEffects:
    """The construction seam between the CLI and the host: ``units``,
    ``host_effects`` (the controller's Effects instance) and an optional
    ``prepare_run`` hook applied to the Run before it starts.

    ``main`` builds one through the injectable ``effects_factory`` so tests
    and rehearsals can prove which providers a CLI invocation constructs;
    production supplies ``RealUnits``, the controller module's ``Effects``
    and no hook. The rehearsal's hook binds the controller-shaped journal
    (``deploy_journal``) and performs the real target checkout, so no
    rehearsal can spawn the real switch subprocess."""

    def __init__(self, units, host_effects, prepare_run=None):
        self.units = units
        self.host_effects = host_effects
        self.prepare_run = prepare_run


def real_units_factory(marker_path):
    return RealUnits(marker_path)


def default_effects_factory(marker_path, effects_builder):
    """Production: live systemd unit provider plus the controller's
    Effects. A rehearsal must never select this factory."""
    return RunEffects(real_units_factory(marker_path), effects_builder())


def load_module(name, path: Path):
    try:
        raw = Path(path).read_bytes()
    except OSError as exc:
        raise Refused("unreadable module " + name + ": " + str(path)) from exc
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise Refused("cannot load module " + name + " from " + str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digests_module():
    return digests  # imported at module load from this file's directory




def durable_write(path: Path, payload) -> None:
    """Atomically replace ``path`` with canonical JSON, fsyncing file and
    directory (the controller's journal_replace shape, stdlib copy)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode()
    descriptor, temp = tempfile.mkstemp(prefix="." + path.name + ".",
                                        dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temp).unlink(missing_ok=True)


def release_state(output_dir: Path):
    """Read release.json and phase.json back from disk, or raise."""
    release = load_json(Path(output_dir) / "release.json")
    phase = load_json(Path(output_dir) / "phase.json")
    if not isinstance(release, dict) or not isinstance(phase, dict):
        raise Refused("release/phase artifacts must be JSON objects")
    return release, phase


# ----------------------------------------------------------------- run state


class Run:
    """One runbook execution: sequence, assertions and durable records.

    ``units`` is the unit provider (RealUnits in production; a fake in
    tests/rehearsal), ``host`` and ``controller`` the modules loaded from
    the candidate artifact root, ``host_effects`` the controller Effects
    seam, ``clock`` and ``sleep`` the injected time seam.
    """

    def __init__(self, args, units, host, controller, host_effects, manifest,
                 clock=time.monotonic, sleep=time.sleep):
        self.args = args
        self.units = units
        self.host = host
        self.controller = controller
        self.effects = host_effects
        self.manifest = manifest
        self.clock = clock
        self.sleep = sleep
        self.output_dir = Path(args.output_dir)
        self.triggers = []
        self.services = []
        self.original = {}
        self.split_map = {}
        self.stopped_pre = {}
        self.acquired = False
        self.released = False
        self.final_triggers = None
        self.journal = None
        # The D7 rollback evidence the release records (assert_journal).
        self.rollback = None
        self.pre_hold_restored = False
        self.pre_hold_restore_error = None
        self.preflight_passed = False
        self._current_phase = "started"
        self.run_id = uuid.uuid4().hex
        self.marker = Path(units.marker)

    # -- durable intent --------------------------------------------------
    def phase(self, name, **extra):
        durable_write(self.output_dir / "phase.json",
                      {"phase": name,
                       "released": self.released,
                       "run_id": self.run_id,
                       "rehearsal": bool(getattr(self.args, "rehearsal", False)),
                       "runbook_sha256": self.args.runbook_sha256,
                       "final_triggers": self.final_triggers,
                       "journal": self.journal,
                       "original": self.original or None,
                       "stopped_pre": sorted(self.stopped_pre) or None,
                       "error": extra.pop("error", None),
                       **extra})

    def annotate(self, **extra):
        self.phase(self._current_phase, **extra)

    # -- markers ---------------------------------------------------------
    def marker_bytes(self):
        # Run-unique bytes (crq F4): two runs of the same pinned revision
        # must never claim each other's marker; ownership is exact-byte.
        return ("runbook admission hold; runbook_sha256="
                + self.args.runbook_sha256 + "; run_id=" + self.run_id
                + "\n").encode()

    def owns_marker(self):
        if self.marker.is_symlink() or not self.marker.exists():
            return False
        try:
            return self.marker.read_bytes() == self.marker_bytes()
        except OSError:
            return False

    def acquire(self):
        # The hold is claimed before any observation or split, so a run that
        # loses the race to a foreign marker refuses here having read and
        # stopped nothing, and has nothing of its own to restore. The pre-hold
        # owner check also refuses a marker whose bytes are not ours (a
        # concurrent acquisition), and the O_EXCL create below closes the
        # remaining check-to-create window; acquired stays false on that
        # failure.
        if self.marker.exists() and not self.owns_marker():
            raise Refused(
                "admission marker already exists (foreign hold); refusing "
                "to proceed beneath another run's hold")
        self.marker.parent.mkdir(parents=True, exist_ok=True)
        payload = self.marker_bytes()
        try:
            descriptor = os.open(self.marker,
                                 os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            # The window between the check above and this create: whatever
            # landed is not ours, so the loser still refuses as a foreign
            # hold rather than surfacing a raw errno.
            raise Refused(
                "admission marker already exists (foreign hold); refusing "
                "to proceed beneath another run's hold") from None
        self.acquired = True
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        directory = os.open(self.marker.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        require(self.owns_marker(), "marker ownership failed after acquire")

    def release_marker(self):
        require(self.owns_marker(),
                "refusing to remove a marker whose bytes are not ours")
        self.marker.unlink()
        directory = os.open(self.marker.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        require(not self.marker.exists(), "marker reappeared after unlink")
        # Acquisition history stays true; release is the distinct terminal
        # state the released-flag gate reads.
        self.released = True

    # -- result ---------------------------------------------------------------
    def result_document(self):
        """The run's machine-readable result: exactly one stdout artifact
        per invocation (repo contract). Narration and the process-level
        error envelope stay on stderr; this document is what automation
        reads instead of scrollback. A released completed run prints
        outcome completed/released true; every earlier terminal state
        prints the phase it stopped in with released false."""
        return {"operation": "deploy",
                "outcome": "completed" if self.released else "refused",
                "released": bool(self.released),
                "rehearsal": bool(getattr(self.args, "rehearsal", False)),
                "output_dir": str(self.output_dir),
                "runbook_sha256": self.args.runbook_sha256,
                "target": self.args.target_sha,
                "target_tag": self.args.target_tag,
                "prior_sha": self.args.prior_sha,
                "marker_path": str(self.marker),
                "journal": (self.journal or {}).get("transaction_id"),
                "cq_bin_entry": getattr(self, "cq_bin_entry", None),
                "final_triggers": self.final_triggers}

    # -- sequence --------------------------------------------------------
    def run(self):
        # A retry into a reused --output-dir would destroy the previous run's
        # durable recovery evidence (phase.json's original/stopped_pre map)
        # before observing any trigger state: the retry's first phase write
        # replaces the map with its own, or with nulls when it fails before
        # the split. Recovering a previous run is an owner operation on its
        # own records, so a directory that already holds a run's map refuses;
        # only a bare directory (no phase.json) may be reused.
        existing_phase = self.output_dir / "phase.json"
        if existing_phase.exists() or existing_phase.is_symlink():
            raise Refused(
                "output-dir already holds a run's map (phase.json exists); "
                "refusing to overwrite recovery evidence. Use a fresh "
                "--output-dir; recovering the old run is an owner operation "
                "on its existing records")
        # Finding (post-merge Codex P2): two invocations given the same fresh
        # --output-dir both passed the check above, and the loser's
        # _release_own_refusal() then overwrote the winner's phase.json after
        # the winner had stopped triggers. The directory is claimed
        # atomically before ANY record is written, so exactly one invocation
        # owns it and the loser refuses with nothing observed.
        claim = self.output_dir / ".claim"
        try:
            self.output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            claim_fd = os.open(claim, os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                               0o600)
        except FileExistsError as exc:
            raise Refused(
                "output-dir is claimed by another invocation (" + str(claim)
                + " exists); refusing to share a run directory. Use a unique "
                "fresh --output-dir per invocation; removing the claim is an "
                "owner operation on the run that holds it") from exc
        os.close(claim_fd)
        try:
            return self._run_body()
        except BaseException as exc:
            self._refusal_cleanup(exc)
            raise
        finally:
            claim.unlink(missing_ok=True)

    def _refusal_cleanup(self, exc):
        """Terminal cleanup for a failure, split by what the host can prove.

        Before this run's preflight has passed, nothing has left a state the
        owner must recover by hand: the only mutations are this run's own
        recorded split stops. So restore exactly the units this run's own
        intent recorded stopped, verify them, and remove only this run's own
        marker. Once preflight has passed the sequence has locked admission
        and is draining or switching, where releasing the hold would be the
        unsafe act: keep the hold (recovery_required) exactly as before.
        """
        if not self.preflight_passed:
            self._release_own_refusal(exc)
            return
        self._fail_stop(exc)

    def _release_own_refusal(self, exc):
        """Undo this run's pre-switch intent and release this run's hold.

        Ownership is exact: only units in this run's durable ``stopped_pre``
        map are started (a long trigger already inactive before the run was
        never started and is never taken for one this run stopped), and only
        a marker whose bytes are this run's own is removed. A restore failure
        keeps the hold and records recovery_required instead; it never
        pretends the host is back.
        """
        error = None
        try:
            if self.stopped_pre:
                owned = [unit for unit in sorted(self.stopped_pre)
                         if self.units.state(unit) == "inactive"]
                skipped = sorted(set(self.stopped_pre) - set(owned))
                require(not skipped,
                        "units this run stopped are no longer inactive; "
                        "refusing to act on them: " + ", ".join(skipped))
                self.units.start(owned)
                observed = {unit: self.units.state(unit) for unit in owned}
                require(observed == {unit: "active" for unit in owned},
                        "pre-switch restore mismatch: observed "
                        + repr(observed))
            if self.acquired and self.owns_marker():
                self.release_marker()
        except BaseException as failure:
            error = repr(failure)
        if error is not None:
            self.pre_hold_restore_error = error
            self.phase("recovery_required", error=repr(exc),
                       restore_error=self.pre_hold_restore_error,
                       pre_hold_restored=False,
                       stopped_pre=sorted(self.stopped_pre))
            return
        if self.acquired and not self.released:
            self.pre_hold_restore_error = (
                "refusal cleanup could not release this run's own marker")
            self.phase("recovery_required", error=repr(exc),
                       restore_error=self.pre_hold_restore_error,
                       pre_hold_restored=False,
                       stopped_pre=sorted(self.stopped_pre))
            return
        self.pre_hold_restored = bool(self.stopped_pre)
        self.phase("refused_released" if self.acquired else "refused",
                   error=repr(exc), stopped_pre=sorted(self.stopped_pre),
                   pre_hold_restored=self.pre_hold_restored)

    def _run_body(self):
        durable_write(self.output_dir / "marker.path",
                      {"path": str(self.marker.resolve())})
        # Claim the hold BEFORE any observation or split. The split and the
        # inventory read both mutate or judge admission state, so doing them
        # unheld let a second run find no marker in that window. With the
        # hold first, the loser refuses at acquire having observed and
        # stopped nothing, so there is no ownership hazard to guard: it
        # cannot restore a unit it never stopped or release a hold it never
        # took.
        self.acquire()
        self.phase("held")
        self.observe_and_preflight()
        self.phase("preflight_ok", triggers=self.split_map,
                   stopped_pre=sorted(self.stopped_pre))
        self.stop_triggers(self.triggers)
        self.phase("draining", triggers=self.split_map)
        self.drain_services()
        self.drain_controller()
        self.assert_hold()
        self.assert_queue_rollback_compatible()
        self.phase("controller_pending", triggers=self.split_map)
        self.journal = self.switch()
        self.assert_hold()
        self.phase("controller_completed", triggers=self.split_map)
        self.point()
        self.assert_hold()
        self.phase("restore_pending", triggers=self.split_map)
        self.restore()
        self.phase("released", triggers=self.split_map)
        self.write_release()
        self.write_range_note()
        self.phase("completed", triggers=self.split_map)
        return self.result_document()

    def observe_and_preflight(self):
        """Observation, conditional split, quiescence and preflight, all
        inside this run's hold."""
        require(self.owns_marker(), "hold lost before observation")
        inventory = self.observe_inventory()
        self.assert_inventory(inventory)
        self.split_long_triggers()
        self.wait_services_settle()
        self.preflight()
        self.preflight_passed = True

    # -- step 1: validate and inventory ----------------------------------
    def observe_inventory(self):
        triggers, services = self.units.inventory()
        return {"triggers": triggers, "services": services}

    def assert_inventory(self, inventory):
        expected = sorted(self.manifest["triggers"]["expected"])
        services = sorted(self.manifest["triggers"]["services"])
        long = sorted(self.manifest["triggers"]["long"])
        require(inventory["triggers"] == expected,
                "unexpected trigger inventory: observed "
                + repr(inventory["triggers"]) + " expected " + repr(expected))
        require(set(long) <= set(expected),
                "manifest long triggers must be a subset of expected")
        require(inventory["services"] == services,
                "unexpected service inventory")
        self.triggers = inventory["triggers"]
        self.services = inventory["services"]
        hostname = self.args.hostname or self.manifest.get("hostname")
        if hostname:
            observed = subprocess.check_output(["hostname"], text=True).strip()
            require(observed == hostname, "wrong host: " + observed)
        # The hold was claimed before this read: what must hold now is
        # ownership of it, not its absence.
        require(self.owns_marker(), "hold lost before inventory")
        self.verify_target_tag()

    def verify_target_tag(self):
        tag = self.args.target_tag
        sha = self.args.target_sha
        require(self.host.git(self.args.root, "cat-file", "-t",
                              "refs/tags/" + tag) == "tag",
                "target tag must be annotated: " + tag)
        peeled = self.host.git(self.args.root, "rev-parse",
                               "refs/tags/" + tag + "^{commit}")
        require(peeled == sha, "tag does not peel to target: " + tag)

    # -- step 2: observe, then split -------------------------------------
    def split_long_triggers(self):
        # Observe all triggers first: restore always targets this map (F4).
        self.original = {unit: self.units.state(unit)
                         for unit in self.triggers}
        require(all(state in ACTIVE_STATES
                    for state in self.original.values()),
                "unstable trigger state in original observation")
        long = sorted(self.manifest["triggers"]["long"])
        # Conditional split: a long trigger already inactive is recorded
        # inactive and must NOT be started on restore. Record intent BEFORE
        # systemctl: a failed multi-unit stop may have stopped a subset.
        self.stopped_pre = {unit: state for unit, state in self.original.items()
                            if unit in long and state == "active"}
        self.split_map = {**self.original,
                          **{unit: "inactive" for unit in self.stopped_pre}}
        # Finding 7: the original map and this run's stop intent are durable
        # before the first unit mutation, so recovery after a crash during
        # the stop, the settle wait or preflight can tell triggers this run
        # stopped from triggers that were already inactive.
        self.phase("split_intent", triggers=self.split_map,
                   original=self.original,
                   stopped_pre=sorted(self.stopped_pre))
        # Stop only while this run holds admission: another run cannot be
        # beneath the same marker, and a lost hold must not stop units.
        require(self.owns_marker(), "hold lost before the split stop")
        self.units.stop(sorted(self.stopped_pre))
        observed = {unit: self.units.state(unit) for unit in self.triggers}
        require(observed == self.split_map, "split mismatch: observed "
                + repr(observed) + " expected " + repr(self.split_map))

    def wait_services_settle(self):
        deadline = self.clock() + 60 * 60
        while any(self.units.state(unit) not in DEAD_STATES
                  for unit in LONG_SERVICES):
            if self.clock() >= deadline:
                raise TimeoutError("long services did not settle naturally "
                                   "within one hour; abort before hold")
            self.sleep(5)

    # -- step 3: preflight ------------------------------------------------
    def preflight(self):
        identity = self.manifest["identity"]
        ancestry = self.manifest["ancestry"]
        config = self.manifest["config"]
        artifacts = self.manifest["artifacts"]
        root = Path(self.args.root)
        candidate = Path(self.args.candidate_root)
        prior = Path(self.args.prior_root)
        require(self.host.git(root, "rev-parse", "HEAD") == identity["prior_sha"],
                "live HEAD is not the prior SHA")
        require(digests.file_digest(candidate / "apps/crq-python/config.json")
                == config["candidate_config_sha256"],
                "candidate config digest mismatch")
        require(digests.file_digest(candidate / "apps/crq-python/ops/deploy-controller.py")
                == identity["controller_file_sha256"],
                "candidate controller file digest mismatch")
        self.assert_config_relations(candidate, prior)
        require(digests.tree_digest(prior / "dist") == artifacts["running_dist_sha256"],
                "running_dist digest mismatch")
        require(digests.tree_digest(candidate / "dist") == artifacts["candidate_dist_sha256"],
                "candidate_dist digest mismatch")
        require(digests.deps_digest(prior / "node_modules") == artifacts["running_deps_sha256"],
                "running_deps digest mismatch")
        require(digests.deps_digest(candidate / "node_modules") == artifacts["candidate_deps_sha256"],
                "candidate_deps digest mismatch")
        self.assert_ancestry(root, ancestry)
        self.assert_cq_bin_policy(candidate)
        require(self.owns_marker(), "marker ownership lost during preflight")
        require({unit: self.units.state(unit) for unit in self.triggers}
                == self.split_map, "preflight trigger drift")
        self.assert_baseline_journal()
        # D7 from host truth, last so every earlier refusal keeps its order:
        # the controller's own compatibility computation on the LIVE queue.
        # The journal assertion then demands the permission True the
        # controller records, which is only sound because a host where it
        # would be denied never reaches the switch.
        self.assert_queue_rollback_compatible()

    def assert_queue_rollback_compatible(self):
        compatibility = self.controller.compatibility_record(
            self.effects, self.args.target_sha)
        require(self.controller.rollback_compatible(compatibility),
                "D7: the live queue denies the controller's automatic "
                "rollback, so this runbook will not deploy against it: "
                + self.compatibility_reason(compatibility))

    @staticmethod
    def compatibility_reason(record):
        """The evidence that denied automatic rollback, named for the
        operator. Never paraphrases a value it did not read."""
        if not isinstance(record, dict) or record.get("checked") is not True:
            return "the compatibility record was not checked"
        if record.get("schema_marker_present") is not False:
            schema = record.get("queue_schema")
            if isinstance(schema, str) and schema.startswith("unreadable: "):
                return ("the state queue could not be read ("
                        + schema[len("unreadable: "):]
                        + "), so the controller never proved the prior "
                        "target can read it")
            return ("the queue carries an explicit schema marker ("
                    + repr(schema) + ") that the prior "
                    "target's reader was never proven against")
        observed = record.get("schema_observations")
        if observed:
            return ("the queue carries state keys the prior target was never "
                    "proven to read: " + ", ".join(map(str, observed)))
        return "the compatibility record is not the clean shape"

    def assert_config_relations(self, candidate, prior):
        config = self.manifest["config"]
        overlay, raw = self.host.load_overlay(self.args.overlay)
        live_bytes = (Path(self.args.root) / "apps/crq-python/config.json").read_bytes()
        live_digest = digests.file_digest(Path(self.args.root) / "apps/crq-python/config.json")
        require(live_digest == config["running_config_sha256"],
                "live config digest mismatch (running_config)")
        if config["render_at_prior_reproduces_live"]:
            rendered = self.host.render(Path(self.args.root), overlay,
                                        self.manifest["identity"]["prior_sha"])
            require(rendered == live_bytes,
                    "render at prior does not reproduce live config (drift)")
        target_committed = subprocess.run(
            ["git", "-C", str(self.args.root), "show",
             self.manifest["identity"]["target_sha"]
             + ":apps/crq-python/config.json"],
            check=True, capture_output=True).stdout
        committed_digest = hashlib.sha256(target_committed).hexdigest()
        require(committed_digest == config["committed_config_sha256"],
                "committed config at target mismatch")
        target_rendered = self.host.render(Path(self.args.root), overlay,
                                           self.manifest["identity"]["target_sha"])
        # Finding 6: the rendered target config is compared against the
        # pinned target-state digest unconditionally, so an incorrect overlay
        # can never release an unapproved target configuration.
        require(hashlib.sha256(target_rendered).hexdigest()
                == config["target_state_config_sha256"],
                "target rendered config digest mismatch (target_state)")
        left = json.loads(self.host.render(Path(self.args.root), overlay,
                                           self.manifest["identity"]["prior_sha"]))
        right = json.loads(target_rendered)
        diffs = sorted(self.host.changed_fields(left, right))
        if config["head_invariance"]:
            require(diffs == [], "head invariance refused: " + repr(diffs))
        else:
            require(diffs != [], "head invariance false but no config delta")
        if config["target_state_config_sha256"] == config["running_config_sha256"]:
            require(target_rendered == live_bytes,
                    "target render must equal live bytes (config invariant)")

    def assert_ancestry(self, root, ancestry):
        prior = self.manifest["identity"]["prior_sha"]
        target = self.manifest["identity"]["target_sha"]
        check = subprocess.run(
            ["git", "-C", str(root), "merge-base", "--is-ancestor", prior, target],
            capture_output=True, text=True)
        require(check.returncode == 0 or ancestry["prior_is_ancestor_of_target"] is False,
                "prior is not an ancestor of target but the manifest asserts it is")
        if ancestry["prior_is_ancestor_of_target"] is False:
            require(check.returncode != 0,
                    "prior is an ancestor of target but the manifest asserts it is not")
        mode = ancestry["target_on_origin_main"]
        on_main = subprocess.run(
            ["git", "-C", str(root), "merge-base", "--is-ancestor", target,
             "refs/remotes/origin/main"], capture_output=True, text=True)
        on_main = on_main.returncode == 0
        if mode == "must":
            require(on_main, "target must be on origin/main")
        elif mode == "must_not":
            # The deployment contract cannot serve an off-main target: the
            # helper's verify_target (invoked by the controller's precheck)
            # unconditionally requires the target inside origin/main
            # history. Accepting the mode here would acquire the hold and
            # stop every trigger before the switch inevitably fails. Refuse
            # before any unit mutation until that contract changes.
            require(False,
                    "target_on_origin_main must_not is not deployable: the "
                    "helper's verify_target requires the target on "
                    "origin/main; refusing before the hold")

    def assert_cq_bin_policy(self, candidate):
        config = self.manifest["config"]
        overlay, _raw = self.host.load_overlay(self.args.overlay)
        # Compare RENDERED pointers, not committed text: the candidate bytes
        # normally carry the @HOST_CQ_BIN@ placeholder, which the overlay
        # resolves on the host. Comparing placeholder against live would
        # refuse every ordinary overlay without an actual pointer move.
        left = json.loads(self.host.render(Path(self.args.root), overlay,
                                           self.manifest["identity"]["prior_sha"]))
        right = json.loads(self.host.render(Path(self.args.root), overlay,
                                            self.manifest["identity"]["target_sha"]))
        moved = (left.get("repair", {}).get("cq_bin")
                 != right.get("repair", {}).get("cq_bin"))
        require(not moved or config["cq_bin_pointer_may_move"],
                "cq_bin pointer moved without authorization")

    def assert_baseline_journal(self):
        identity = self.manifest["identity"]
        journal = load_json(self.args.baseline_journal)
        require(digests.file_digest(Path(self.args.baseline_journal))
                == identity["baseline_journal_sha256"],
                "baseline journal digest mismatch")
        for key, expected in identity["baseline_journal_fields"].items():
            require(journal.get(key) == expected,
                    "baseline journal field mismatch: " + key)

    # -- step 4: hold -------------------------------------------------------
    def stop_triggers(self, units):
        """Stop ALL the triggers inside the hold, after the marker exists:
        hold admission precedes every unit stop, so a stop can never race an
        unheld host. The split already stopped the long triggers; this stops
        the rest (a repeat stop of an inactive unit is a no-op)."""
        require(self.owns_marker(), "hold lost before trigger stop")
        self.units.stop(sorted(units))
        observed = {unit: self.units.state(unit) for unit in self.triggers}
        require(all(state in DEAD_STATES for state in observed.values()),
                "trigger stop did not settle: " + repr(observed))

    # -- step 5: drain ------------------------------------------------------
    def drain_services(self, clock=None, sleep=None):
        clock = clock or self.clock
        sleep = sleep or self.sleep
        deadline = self.args.service_drain_deadline_s
        if deadline is None:
            deadline = self.manifest["quiescence"]["service_drain_deadline_s"]
        end = clock() + deadline
        while any(self.units.state(unit) not in DEAD_STATES
                  for unit in self.services):
            if clock() >= end:
                raise TimeoutError("service drain expired after "
                                   + str(deadline) + "s; hold retained, "
                                   "nothing killed")
            sleep(5)

    def drain_controller(self, poll_interval=None, deadline_s=None,
                         clock=None, sleep=None):
        """Bounded poll of the controller's read-only drain_check.

        Second quiescence bound: it sees dispatched runs through owned-PID
        liveness, not two service names. Fails safe on expiry: TimeoutError,
        marker retained, nothing signalled or killed. Every poll lands in
        ``output-dir/drain.json``. ``clock``/``sleep`` are injectable so a
        rehearsal and the tests run the same poll loop without wall time.
        """
        clock = clock or self.clock
        sleep = sleep or self.sleep
        if poll_interval is None:
            poll_interval = self.manifest["quiescence"]["poll_interval_s"]
        if deadline_s is None:
            deadline_s = self.manifest["quiescence"]["deadline_s"]
        end = clock() + deadline_s
        liveness = self.controller._runner_liveness(self.effects)
        polls = []
        result = None
        while True:
            result = self.controller.drain_check(self.effects, liveness)
            polls.append({**result, "at": clock()})
            durable_write(self.output_dir / "drain.json",
                          {"polls": polls,
                           "mode": DRAIN_MODE,
                           "poll_interval_s": poll_interval,
                           "deadline_s": deadline_s,
                           "drained": result["drained"]})
            if result["drained"]:
                return result
            if clock() >= end:
                raise TimeoutError(
                    "controller drain_check deadline expired after "
                    + str(deadline_s) + "s; hold retained, nothing killed")
            sleep(poll_interval)

    def assert_hold(self):
        require(self.owns_marker(), "hold lost: marker ownership")
        observed = {unit: self.units.state(unit) for unit in self.triggers}
        require(all(state in DEAD_STATES for state in observed.values()),
                "hold lost: triggers not inactive: " + repr(observed))
        if not getattr(self.args, "rehearsal", False):
            # Production only: the helper's real-unit inventory check talks
            # to the actual systemd user manager. A rehearsal binds this
            # verification to the injected provider above and must finish
            # host-free even where no user bus exists.
            self.host.inactive(Path(self.args.root))

    # -- step 6: switch -----------------------------------------------------
    def assert_live_dist_is_candidate(self):
        """Bind the executed runtime to the verified candidate artifact.

        dist/ is gitignored, so the controller's checkout switch leaves the
        existing live dist in place; the cq_bin config string alone cannot
        prove the runner will execute the verified bytes. The live cq_bin
        path (after the pointer render) must resolve to a tree whose
        digest equals candidate_dist_sha256, or the release refuses before
        any trigger restarts.

        Only meaningful AFTER ``point()`` rendered the target config: a
        commit normally carries the ``@HOST_CQ_BIN@`` placeholder, so the
        committed bytes name no runtime at all and comparing them here (at
        the end of the switch, before the render) refused a correct deploy
        after the drain with HEAD already moved."""
        live = json.loads(
            (Path(self.args.root) / "apps/crq-python/config.json").read_text())
        pointer = (live.get("repair") or {}).get("cq_bin")
        require(not (isinstance(pointer, str) and PLACEHOLDER in pointer),
                "rendered config still carries the " + PLACEHOLDER
                + " placeholder: the overlay did not render repair.cq_bin, "
                "so the executed runtime cannot be bound to the verified "
                "candidate artifact")
        require(isinstance(pointer, str) and pointer,
                "rendered config carries no cq_bin pointer")
        live_dist = Path(pointer).resolve().parent
        require(live_dist.is_dir(),
                "live cq_bin directory does not exist: " + str(live_dist)
                + " (the rendered pointer names no runtime to bind)")
        require(digests.tree_digest(live_dist)
                == self.manifest["artifacts"]["candidate_dist_sha256"],
                "live dist digest mismatch: the executed runtime at "
                + str(live_dist) + " is not the verified candidate "
                "artifact (candidate_dist_sha256)")
        # Finding (post-merge Codex P2): a matching dist digest says nothing
        # about the NAME the overlay chose inside it. A pointer to
        # dist/cli-typo.js in an otherwise pinned tree passed, and every
        # later repair invocation then ran Node against a missing script
        # while the release reported success. The entrypoint itself must be
        # an existing regular file that resolves inside the approved tree.
        entry = Path(pointer)
        require(entry.is_file(),
                "rendered cq_bin does not name an existing entrypoint file: "
                + str(entry) + " (the dist tree may match the candidate, but "
                "the pointer must name the script the release will execute)")
        # A pointer cannot escape the tree: tree_digest refuses a symlink
        # anywhere in dist, and a parent-traversing name digests a different
        # root. The resolved path is recorded, not gated.
        resolved = entry.resolve()
        # Record the identity the GO checklist asks for: exact path, resolved
        # path, bytes and mode, and the invocation contract the repair roles
        # use. Recorded, not probed: nothing is executed here.
        self.cq_bin_entry = {
            "path": str(entry),
            "resolved": str(resolved),
            "sha256": digests.file_digest(entry),
            "mode": oct(entry.stat().st_mode & 0o777),
            "invocation": "node " + str(entry),
        }
        # Review finding: the controller's checkout never installs
        # dependencies, and build.mjs emits unbundled output, so an
        # approved dist over stale node_modules can be inert where cq_bin
        # points here. The live runtime's dependency graph must equal the
        # candidate_deps_sha256 pin before anything restarts.
        live_deps = live_dist.parent / "node_modules"
        require(digests.deps_digest(live_deps)
                == self.manifest["artifacts"]["candidate_deps_sha256"],
                "live deps digest mismatch: node_modules at " + str(live_deps)
                + " is not the verified candidate dependency graph "
                "(candidate_deps_sha256)")

    def switch(self):
        record_dir = self.output_dir / "controller-records"
        record_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.run_controller_switch(record_dir)
        journals = sorted(record_dir.glob("controller-*.json"))
        require(len(journals) == 1, "expected exactly one controller journal")
        journal = load_json(journals[0])
        self.assert_journal(journal)
        return {"path": str(journals[0]),
                "transaction_id": journal.get("transaction_id")}

    def run_controller_switch(self, record_dir):
        """The production controller invocation: a deploy-controller.py
        subprocess at the candidate artifact, bound to the candidate helper
        with the pinned helper digest, stdout/stderr captured to the record
        directory. The path is resolved explicitly (finding 4): an omitted
        ``--controller`` must never reach the subprocess as ``None``. Tests
        and rehearsals override this with a fake controller journal; the
        journal assertions below still run on whatever lands."""
        identity = self.manifest["identity"]
        stdout_path = record_dir / "controller.stdout"
        stderr_path = record_dir / "controller.stderr"
        with stdout_path.open("x") as out, stderr_path.open("x") as err:
            os.chmod(out.name, 0o600)
            os.chmod(err.name, 0o600)
            completed = subprocess.run(
                [sys.executable, "-B", str(resolve_controller_path(self.args)),
                 "--root", str(self.args.root),
                 "--overlay", str(self.args.overlay),
                 "--record-dir", str(record_dir),
                 "--helper", str(Path(self.args.candidate_root)
                                 / "apps/crq-python/ops/prepare-host.py"),
                 "--expect-helper-sha256", identity["helper_sha256"],
                 "switch", "--sha", self.args.target_sha,
                 "--tag", self.args.target_tag],
                stdout=out, stderr=err)
        require(completed.returncode == 0,
                "controller switch failed with exit " + str(completed.returncode))

    def assert_journal(self, journal):
        """The full assertion set, not a subset (binding addition 3).

        D7 is the controller's own semantics, asserted in its shape: a
        clean pre-switch queue (no schema marker, no ``author_*`` keys)
        is exactly the record ``rollback_compatible()`` grants, so the
        completed deploy journal must carry permission True beside clean
        evidence. A False there is a journal no controller run can
        produce and refuses. The runbook's own policy — the permission is
        never exercised; rollback stays an owner operation — is a
        sequence fact, not a journal flag, and is stated in the module
        docstring and docs."""
        identity = self.manifest["identity"]
        require(journal.get("operation") == "deploy", "journal operation mismatch")
        require(journal.get("outcome") == "completed", "journal outcome not completed")
        require(journal.get("prior_head") == identity["prior_sha"],
                "journal prior_head mismatch")
        require(journal.get("target") == self.args.target_sha,
                "journal target mismatch")
        require(journal.get("tag") == self.args.target_tag, "journal tag mismatch")
        require(journal.get("helper_sha256") == identity["helper_sha256"],
                "journal helper_sha256 mismatch")
        require(journal.get("automatic_rollback_permitted") is True,
                "D7: a clean pre-switch queue grants the controller's "
                "automatic rollback; a journal claiming False beside "
                "compatibility evidence is not one the controller writes "
                "(assert automatic_rollback_permitted is True)")
        # The permission is sound because preflight already ran the
        # controller's own compatibility computation on the live queue and
        # refused when it would deny rollback. The journal must then carry
        # BOTH records the controller's decision consumes: the pre-switch
        # record (evidence the prior target could read the queue this deploy
        # started from) and the post-switch record (permission True beside
        # clean evidence, the only pair the controller can emit).
        pre = (((journal.get("plan") or {}).get("preflight") or {})
               .get("rollback_compatibility"))
        require(isinstance(pre, dict) and pre.get("checked") is True
                and pre.get("schema_marker_present") is False
                and not pre.get("schema_observations"),
                "D7: the journal must record the pre-switch queue as "
                "readable by the prior target (checked, no schema marker, "
                "no author_* keys)")
        compatibility = journal.get("rollback_compatibility") or {}
        require(compatibility.get("checked") is True,
                "D7: post-switch rollback_compatibility must be checked")
        require(isinstance(compatibility.get("schema_marker_present"), bool),
                "D7: post-switch schema_marker_present must be a boolean")
        require(isinstance(compatibility.get("schema_observations"), list),
                "D7: post-switch schema_observations must be a list")
        require(compatibility.get("schema_marker_present") is False
                and not compatibility.get("schema_observations"),
                "D7: the post-switch queue must still be the clean shape "
                "that grants automatic rollback (no schema marker, no "
                "author_* keys); a permission True beside dirty evidence "
                "is not a journal the controller writes")
        # The release records the granted permission and the operator is
        # told: this runbook never invokes rollback, but the controller's
        # automatic rollback stays available after this deploy.
        self.rollback = {
            "automatic_rollback_permitted": True,
            "statement": ("automatic rollback remains available: the "
                          "post-switch queue carries no schema marker and "
                          "no author_* keys, so the controller's own "
                          "compatibility check still grants it. This runbook "
                          "never invokes rollback; recovery stays an owner "
                          "operation.")}
        narrate("D7: " + self.rollback["statement"])
        require(journal.get("prior_tag") == self.args.prior_tag,
                "journal prior_tag mismatch")
        require(journal.get("prior_config_sha256")
                == self.manifest["config"]["running_config_sha256"],
                "journal prior_config_sha256 mismatch")
        require(journal.get("schema_version") == RUNBOOK_SCHEMA_VERSION,
                "journal schema_version mismatch")
        transaction = journal.get("transaction_id")
        require(isinstance(transaction, str) and bool(transaction),
                "journal transaction_id must be nonempty")

    # -- step 7: pointer -----------------------------------------------------
    def point(self):
        config = self.manifest["config"]
        overlay, raw = self.host.load_overlay(self.args.overlay)
        self.host.live_render(Path(self.args.root), overlay, raw)
        # Verify WHAT WAS WRITTEN, not just one leaf: the live bytes must
        # hash to the approved target-state digest after live_render, so an
        # overlay that changed after preflight cannot smuggle unapproved
        # configuration into the release (finding: cq_bin was the only
        # remaining check).
        live_bytes = (Path(self.args.root)
                      / "apps/crq-python/config.json").read_bytes()
        require(digests.file_digest(
                    Path(self.args.root) / "apps/crq-python/config.json")
                == config["target_state_config_sha256"],
                "released config digest mismatch: live bytes after "
                "live_render do not hash to the pinned target_state digest")
        # The runtime the release will execute is only knowable once the
        # render above exists: a commit carries the @HOST_CQ_BIN@ placeholder,
        # so this check belongs here and nowhere earlier.
        self.assert_live_dist_is_candidate()
        # The pointer-level check remains as the authorization boundary:
        # the released live pointer must equal the approved target render.
        live = json.loads(live_bytes)
        approved = json.loads(self.host.render(
            Path(self.args.root), overlay,
            self.manifest["identity"]["target_sha"]))
        moved = (live.get("repair", {}).get("cq_bin")
                 != approved.get("repair", {}).get("cq_bin"))
        require(not moved or config["cq_bin_pointer_may_move"],
                "pointer moved the cq_bin without authorization")

    # -- step 8: restore (F4) -------------------------------------------------
    def restore(self):
        """Restore to self.original, the pre-run observed map.

        F4 rule: the post-split map is an intermediate, never a restore
        target. Start exactly the units self.original recorded active; a
        long trigger already inactive at observation is never started.
        Assert the full original map, verify the recorded final observation
        against it, persist final_triggers durably, then remove the marker
        last. A second observation that disagrees with the first refuses
        before the hold is released: an unstable restore is never waved
        through on one read.
        """
        require(self.owns_marker(), "marker ownership lost before restore")
        active = sorted(unit for unit, state in self.original.items()
                        if state == "active")
        self.units.start(active)
        observed = {unit: self.units.state(unit) for unit in self.triggers}
        require(observed == self.original,
                "trigger restore mismatch: observed " + repr(observed)
                + " expected original " + repr(self.original))
        # Second, independent read: the map recorded as final must equal
        # original too, or the release refuses before the marker is removed.
        verified = {unit: self.units.state(unit) for unit in self.triggers}
        require(verified == self.original,
                "trigger restore verification mismatch: second read "
                + repr(verified) + " expected original "
                + repr(self.original))
        self.final_triggers = verified
        self.phase("final_triggers", triggers=self.split_map,
                   original=self.original,
                   final_triggers=self.final_triggers)
        require(self.owns_marker(), "marker ownership lost during restore")
        self.release_marker()

    # -- step 9: record --------------------------------------------------------
    def write_release(self):
        require(self.released, "release.json requires a released run")
        require(self.rollback is not None,
                "release requires the D7 journal evidence")
        durable_write(self.output_dir / "release.json",
                      {"released_at": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                                     time.gmtime()),
                       "final_triggers": self.final_triggers,
                       "rehearsal": bool(getattr(self.args, "rehearsal", False)),
                       "rollback": self.rollback,
                       "runbook_sha256": self.args.runbook_sha256})
        narrate("released " + self.args.target_sha[:10] + " "
                + self.args.target_tag + "; automatic rollback "
                + ("available (owner-only, never invoked by this runbook)"
                   if self.rollback["automatic_rollback_permitted"]
                   else "unavailable"))

    def write_range_note(self):
        annotations = {}
        if self.args.annotations:
            annotations = load_json(self.args.annotations)
            require(isinstance(annotations, dict),
                    "annotations must be a JSON object")
        durable_write(
            self.output_dir / "range-note.json",
            {"manifest_sha256": self.args.manifest_sha256,
             "runbook_sha256": self.args.runbook_sha256,
             "wrapper_sha256": self.args.runbook_sha256,
             "candidate_dist": self.manifest["artifacts"]["candidate_dist_sha256"],
             "candidate_deps": self.manifest["artifacts"]["candidate_deps_sha256"],
             "running_dist": self.manifest["artifacts"]["running_dist_sha256"],
             "running_deps": self.manifest["artifacts"]["running_deps_sha256"],
             "target": self.args.target_sha,
             "tag": self.args.target_tag,
             "prior_sha": self.args.prior_sha,
             "prior_tag": self.args.prior_tag,
             "range": self.manifest["range_note"],
             "annotations": annotations,
             "annotations_sha256": digests.file_digest(Path(self.args.annotations))
             if self.args.annotations else None})

    # -- failure ------------------------------------------------------------
    def _fail_stop(self, exc):
        stop_error = None
        try:
            if self.acquired and not self.released:
                self.units.stop(self.triggers)
                if not self.owns_marker() and not self.marker.exists():
                    self.acquire()
                require(self.owns_marker(),
                        "owned marker unavailable; manual recovery required")
        except BaseException as failure:
            stop_error = repr(failure)
        try:
            self.phase("released_report_failed" if self.released
                       else "recovery_required",
                       error=repr(exc),
                       fail_stop_error=stop_error,
                       pre_hold_restored=self.pre_hold_restored,
                       pre_hold_restore_error=self.pre_hold_restore_error)
        except BaseException:
            pass


# ------------------------------------------------------------- orchestration


def build_arg_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    # Deploy arguments are declared without argparse-level required=True so
    # the status subcommand parses standalone (the documented gate invocation
    # passes only --output-dir/--require-released); main() enforces the
    # deploy set explicitly and exits 2 on a missing one, preserving the
    # argparse error shape for deploy invocations.
    parser.add_argument("--target-sha", metavar="SHA40")
    parser.add_argument("--target-tag", metavar="TAG")
    parser.add_argument("--candidate-root", type=Path)
    parser.add_argument("--prior-root", type=Path)
    parser.add_argument("--prior-sha", metavar="SHA40")
    parser.add_argument("--prior-tag", metavar="TAG")
    parser.add_argument("--root", type=Path,
                        help="deployment checkout root (full monorepo)")
    parser.add_argument("--overlay", type=Path)
    parser.add_argument("--baseline-journal", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--manifest-sha256", metavar="HEX64")
    parser.add_argument("--runbook-sha256", metavar="HEX64")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--annotations", type=Path, default=None)
    parser.add_argument("--rehearsal", action="store_true",
                        help="run against a throwaway clone with a fake unit "
                             "provider; refuses live host units without it")
    parser.add_argument("--operator-go", action="store_true",
                        help="operator authorization for a production run on "
                             "a host with active trigger units: the runbook "
                             "observes, splits and restores the original "
                             "states itself; without it, active triggers "
                             "refuse before any host read", default=None)
    parser.add_argument("--controller", type=Path, default=None,
                        help="deploy-controller.py path (default: the "
                             "candidate artifact root's copy)")
    parser.add_argument("--hostname", default=None,
                        help="expected deploy host; recorded in the manifest")
    parser.add_argument("--service-drain-deadline-s", type=int, default=None)
    return parser


def validate_manifest_document(manifest, manifest_path, manifest_sha256):
    require(isinstance(manifest, dict), "manifest must be a JSON object")
    require(manifest.get("schema_version") == RUNBOOK_SCHEMA_VERSION,
            "unsupported manifest schema_version")
    actual = digests.file_digest(manifest_path)
    require(actual == manifest_sha256,
            "manifest digest mismatch: file " + actual + " pinned "
            + manifest_sha256)
    # Finding 2: the message exists only when validation failed; a valid
    # manifest never concatenates a None problem into an error string.
    schema_problem_text = manifest_problem(manifest, load_json(SCHEMA_PATH))
    if schema_problem_text is not None:
        require(False, "manifest schema: " + schema_problem_text)
    return manifest


def check_pinned_revision(args):
    self_digest = RUNBOOK_SELF_DIGEST
    require(self_digest == args.runbook_sha256,
            "runbook digest mismatch: this file is " + self_digest
            + " but --runbook-sha256 pins " + args.runbook_sha256
            + "; refusing before any host read")


def check_active_trigger_authorization(args):
    """Authorization gate BEFORE any effect construction: a production run
    (no --rehearsal) needs --operator-go when the host carries active crq
    trigger units. The state read goes through one guarded systemctl probe
    so an unauthorized invocation touches nothing else."""
    if args.rehearsal or args.operator_go:
        return
    listing = subprocess.run(
        ["systemctl", "--user", "list-units", "--no-legend", "--no-pager",
         "--plain", "--all", "crq-*.timer", "crq-*.path"],
        capture_output=True, text=True)
    if listing.returncode != 0:
        return  # no user manager/bus: production run is operator-side; the
        # preflight inventory assertion will refuse with full context.
    active = [line.split()[0] for line in listing.stdout.splitlines()
              if line.strip().startswith("active")]
    require(not active,
            "live crq trigger units are active; production runs are operator-"
            "executed only. Pass --rehearsal for a throwaway clone or "
            "--operator-go to authorize this production run: "
            + ", ".join(active))


def check_no_live_units_without_rehearsal(args, units):
    if args.rehearsal or args.operator_go:
        return
    triggers, _services = units.inventory()
    active = [unit for unit in triggers if units.state(unit) == "active"]
    require(not active,
            "live crq trigger units are active; production runs are operator-"
            "executed only. Pass --rehearsal for a throwaway clone or "
            "--operator-go to authorize this production run: "
            + ", ".join(active))


def resolve_controller_path(args):
    """The explicit resolution finding 4 requires: the switch subprocess
    gets a real path, never ``None`` because ``--controller`` was omitted."""
    candidate_ops = Path(args.candidate_root) / "apps/crq-python/ops"
    return args.controller or (candidate_ops / "deploy-controller.py")


def rehearsal_effects_factory(marker_path, effects_builder):
    """Rehearsal selection when no test factory was injected: refuse instead
    of constructing live effects. The rehearsal flag promises a host-free
    run; it must never be able to reach systemd."""
    raise Refused("rehearsal requires injected effects: refusing to "
                  "construct live systemd unit providers")


def execute(args, effects_factory=None) -> dict:
    """Validate, build the run, execute it. Any Refused propagates.

    ``effects_factory`` is the injectable construction seam: a test or
    rehearsal passes a factory returning ``RunEffects`` with fake providers,
    and the test asserts on the factory's argument, proving no real effects
    were constructed. Production (factory None) builds ``RealUnits`` and the
    controller's ``Effects``. Returns the run's result document (the caller
    prints it; ``main`` maps it to an exit status)."""
    # The authorization guard runs first: a production invocation without
    # --operator-go must not import candidate code, construct effects or
    # touch record directories when active triggers sit on the host.
    check_active_trigger_authorization(args)
    check_pinned_revision(args)
    manifest = validate_manifest_document(load_json(args.manifest),
                                          args.manifest, args.manifest_sha256)
    candidate_ops = Path(args.candidate_root) / "apps/crq-python/ops"
    # Digest-pin the candidate modules BEFORE importing them: an import is
    # arbitrary code execution, so a stale or substituted helper or
    # controller must never run ahead of the reviewed pins.
    require(digests.file_digest(candidate_ops / "prepare-host.py")
            == manifest["identity"]["helper_sha256"],
            "helper digest mismatch (candidate prepare-host.py)")
    controller_path = resolve_controller_path(args)
    require(digests.file_digest(controller_path)
            == manifest["identity"]["controller_file_sha256"],
            "controller digest mismatch")
    host = load_module("runbook_prepare_host",
                       candidate_ops / "prepare-host.py")
    controller = load_module("runbook_deploy_controller",
                             controller_path)
    # Finding 5: the CLI target is the manifest's target before any host
    # observation, mutation or effect construction; a different tagged commit
    # with compatible config must not inherit the manifest's reviewed
    # assertions.
    require(args.target_sha == manifest["identity"]["target_sha"],
            "--target-sha must equal the manifest identity target_sha: "
            "command line " + str(args.target_sha) + " manifest "
            + str(manifest["identity"]["target_sha"]))
    # The manifest restates the marker path for review; the executable value
    # is derived from --root (``marker_path``) so the two are the same file
    # the tick reads. Any other manifest value is refused rather than kept as
    # a second, unchecked source of truth.
    require(manifest["marker"]["path"] == MARKER_RELPATH,
            "manifest marker.path must be exactly " + MARKER_RELPATH
            + " (the tick's own marker); got "
            + repr(manifest["marker"]["path"]))
    if args.rehearsal:
        # Finding 3, defense in depth: even a direct execute() call with
        # --rehearsal must not fall through to the live factory.
        require(effects_factory is not None,
                "rehearsal requires injected effects: refusing to construct "
                "live systemd unit providers")
    effects_factory = effects_factory or default_effects_factory

    def effects_builder():
        return controller.Effects(Path(args.root),
                                  Path(args.output_dir) / "controller-records")

    # The active-trigger guard ran at the top; this provider-level check
    # re-verifies against the bound provider's inventory before the Run
    # starts. A production invocation without authorization must not build
    # providers, journals or record directories.
    check_active_trigger_authorization(args)
    effects = effects_factory(
        marker_path(args.root),
        effects_builder)
    check_no_live_units_without_rehearsal(args, effects.units)
    run = Run(args, effects.units, host, controller, effects.host_effects,
              manifest)
    if effects.prepare_run is not None:
        effects.prepare_run(run)
    return run.run()


def read_observed_triggers(units, manifest):
    """One read per trigger of the live unit states (requirement 2)."""
    return {unit: units.state(unit)
            for unit in sorted(manifest["triggers"]["expected"])}


def print_result_document(args, payload):
    """Print the deploy path's one machine-readable result document to
    stdout. The repo contract: every operation invocation writes
    machine-readable JSON to stdout; narration and error envelopes stay
    on stderr. Called for the completed run and for terminal refusals, so
    automation reads the outcome from the artifact either way."""
    document = {"output_dir": str(args.output_dir),
                "rehearsal": bool(getattr(args, "rehearsal", False)),
                "runbook_sha256": args.runbook_sha256,
                **payload}
    print(json.dumps(document, indent=2, sort_keys=True))


def cmd_status(args, units=None) -> int:
    """The released-flag gate (binding additions 1 and 4).

    Independent artifact re-read: release.json and phase.json are re-read
    from disk and must agree; the run's recorded marker path (marker.path,
    written by the run) must exist-and-be-absent on disk — a marker present
    again refuses; the recorded runbook digest must equal the digest of THIS
    file (resolved through realpath so a copied gate at another path is
    still pinned to the recorded revision), so a stale copy never reports on
    a run it did not perform. Refusals report in a fixed order: artifacts,
    digest, marker. Requirement 2: the gate answers "does the host still
    match the release record" too — it prints released_at, final_triggers
    AND the live observed state of every trigger, and refuses when any live
    state differs from final_triggers. Exit 0 is the only permitted basis
    for starting units; one read per trigger, no new state.
    """
    self_digest = RUNBOOK_SELF_DIGEST
    output_dir = Path(args.output_dir)
    release = phase = None
    live_triggers = None
    artifact_refusal = None
    try:
        release, phase = release_state(output_dir)
        if phase.get("phase") != "completed" or phase.get("released") is not True:
            artifact_refusal = "phase.json does not record a released completed run"
        elif release.get("runbook_sha256") != phase.get("runbook_sha256"):
            artifact_refusal = "release.json and phase.json disagree on runbook_sha256"
        elif release.get("final_triggers") != phase.get("final_triggers"):
            artifact_refusal = "release.json and phase.json disagree on final_triggers"
        elif not isinstance(release.get("released_at"), str):
            artifact_refusal = "release.json lacks released_at"
    except Refused as exc:
        artifact_refusal = str(exc)
    digest_refusal = None
    if artifact_refusal is None and release.get("runbook_sha256") != self_digest:
        digest_refusal = ("runbook digest mismatch: this status check executes at "
                          + self_digest + " but the run recorded "
                          + str(release.get("runbook_sha256"))
                          + "; a stale copy must not report on a run it did "
                            "not perform")
    marker_refusal = None
    marker_record = output_dir / "marker.path"
    marker_path = None
    if marker_record.is_file():
        try:
            marker_path = Path(json.loads(marker_record.read_text())["path"])
        except (OSError, ValueError, KeyError) as exc:
            marker_refusal = "marker.path unreadable: " + str(exc)[:120]
    else:
        marker_refusal = ("run recorded no marker.path; the gate cannot "
                          "verify the hold is released")
    if marker_refusal is None and marker_path is not None and marker_path.exists():
        marker_refusal = "runner-disabled marker is present again after release"
    live_refusal = None
    final_triggers = release.get("final_triggers") if release else None
    rehearsal_run = bool(phase.get("rehearsal")) if phase else False
    triggers_record = (phase.get("triggers") or {}) if phase else {}
    if artifact_refusal is None and digest_refusal is None \
            and marker_refusal is None:
        # Requirement 2: live comparison against the release record. The unit
        # provider is injectable (tests); production re-reads the live
        # systemd states, one read per trigger, no new state.
        # A rehearsal run is never an authorizing released answer: its
        # result is rehearsal-only and exits non-zero under
        # --require-released.
        if rehearsal_run:
            live_refusal = ("rehearsal run: this record describes a "
                            "rehearsal, not a production release; the "
                            "authorizing released gate refuses it")
        elif not isinstance(final_triggers, dict) or not final_triggers:
            live_refusal = "release.json lacks a nonempty final_triggers map"
        elif not isinstance(triggers_record, dict) or not triggers_record \
                or sorted(triggers_record) != sorted(final_triggers):
            live_refusal = ("phase.json trigger inventory missing or does "
                            "not match final_triggers; refusing to compare "
                            "live states against an unverified inventory")
    if artifact_refusal is None and digest_refusal is None \
            and marker_refusal is None and live_refusal is None:
        provider = units
        if provider is None:
            provider = RealUnits(marker_path.parent)
        live_triggers = read_observed_triggers(provider, live_document(phase))
        drifted = {unit: {"live": state, "released_as": final_triggers.get(unit)}
                   for unit, state in live_triggers.items()
                   if final_triggers.get(unit) != state}
        if drifted:
            live_refusal = ("live trigger state differs from the released "
                            "final_triggers: " + json.dumps(drifted,
                                                            sort_keys=True))
    refused = (artifact_refusal or digest_refusal or marker_refusal
               or live_refusal)
    print(json.dumps({
        "operation": "status",
        "released": refused is None,
        "refusal": refused,
        "output_dir": str(output_dir),
        "released_at": release.get("released_at") if release else None,
        "final_triggers": final_triggers,
        "live_triggers": live_triggers,
        "marker_path": str(marker_path) if marker_path else None,
        "runbook_sha256": self_digest,
    }, indent=2, sort_keys=True))
    return 0 if refused is None else 1


def live_document(phase):
    """The trigger list the live comparison reads: the recorded expectation
    is the run's own phase record (triggers); the manifest is not re-read by
    the gate. Callers must have verified the inventory matches
    final_triggers before invoking this."""
    triggers = sorted((phase.get("triggers") or {}).keys())
    return {"triggers": {"expected": triggers}}


def main(argv=None, effects_factory=None, status_units=None) -> int:
    """The CLI entry point (testable: inject an effects factory for deploy
    runs and a unit provider for status, assert on the factory argument).

    Finding 1: ``require_released`` exists at parser level with a default,
    so a deploy invocation never reads a missing attribute; the status
    subcommand keeps its own explicit flag. Finding 3: ``--rehearsal``
    selects the in-memory provider and the controller-shaped rehearsal
    journal — a rehearsal constructs no real effects and cannot reach
    systemd. The deploy path prints exactly one result document to stdout
    (success or terminal refusal); narration and the process error
    envelope stay on stderr."""
    parser = build_arg_parser()
    parser.add_argument("--json", action="store_true",
                        help="accepted for interface parity; output is always JSON")
    parser.add_argument("--require-released", action="store_true",
                        default=False,
                        help="status only: refuse unless the run is released")
    sub = parser.add_subparsers(dest="operation")
    status = sub.add_parser("status", help="released-flag gate")
    status.add_argument("--output-dir", required=True, type=Path)
    status.add_argument("--require-released", action="store_true",
                        dest="status_require_released", default=False)

    def parser_error(message):
        # Machine-mode boundary for argparse itself: argument errors used to
        # bypass the JSON envelope entirely (usage text on stderr, empty
        # stdout). The envelope goes to stdout; the narration and the
        # argparse exit status stay on stderr/2.
        print(json.dumps({"error": {"kind": "argument_error",
                                     "message": str(message)[:400]}},
                         indent=2, sort_keys=True))
        parser.exit(2, "deploy-runbook: error: " + str(message) + "\n")

    parser.error = parser_error
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if args.operation == "status":
        return cmd_status(args, units=status_units)
    # Deploy path (the subparser leaves operation None).
    if args.require_released:
        parser.error("--require-released belongs to the status subcommand")
    deploy_required = {
        "--target-sha": args.target_sha, "--target-tag": args.target_tag,
        "--candidate-root": args.candidate_root,
        "--prior-root": args.prior_root, "--prior-sha": args.prior_sha,
        "--prior-tag": args.prior_tag, "--root": args.root,
        "--overlay": args.overlay,
        "--baseline-journal": args.baseline_journal,
        "--manifest": args.manifest,
        "--manifest-sha256": args.manifest_sha256,
        "--runbook-sha256": args.runbook_sha256,
        "--output-dir": args.output_dir}
    missing = sorted(flag for flag, value in deploy_required.items()
                     if value is None)
    if missing:
        parser.error("the following arguments are required for a deploy run: "
                     + ", ".join(missing))
    if args.rehearsal and effects_factory is None:
        effects_factory = make_rehearsal_effects_factory(args)
    try:
        result = execute(args, effects_factory)
    except Refused as exc:
        print_result_document(args, {"operation": "deploy",
                                     "outcome": "refused",
                                     "released": False,
                                     "reason": str(exc)[:400]})
        raise
    except TimeoutError as exc:
        print_result_document(args, {"operation": "deploy",
                                     "outcome": "timeout",
                                     "released": False,
                                     "reason": str(exc)[:400]})
        raise
    print_result_document(args, result)
    if result.get("outcome") == "completed" and result.get("released") is True:
        return 0
    return 2


def make_rehearsal_effects_factory(args):
    """The rehearsal binding: in-memory unit provider, the controller's
    Effects against the throwaway clone, and a prepare_run hook that binds
    the rehearsal controller journal (shaped by the controller's own
    ``deploy_journal``) and the real target checkout in place of the real
    switch subprocess. Returns a factory whose marker argument the execute
    seam supplies; the rehearsal therefore cannot construct real effects
    or run systemctl."""
    manifest_document = load_json(args.manifest)
    triggers = sorted(manifest_document["triggers"]["expected"])
    services = sorted(manifest_document["triggers"]["services"])

    def factory(marker_path, effects_builder):
        def prepare_run(run):
            install_rehearsal_journal(run)

        return RunEffects(
            RehearsalUnits(marker_path, triggers, services),
            effects_builder(), prepare_run)

    return factory


def rehearsal_journal(run, pre_record=None):
    """The rehearsal controller journal, shaped by the controller's own
    journal schema: ``compatibility_record`` reads the rehearsal queue
    through the real Effects seam and ``deploy_journal`` shapes the document
    exactly as ``deploy_plan`` writes it, including
    ``plan["automatic_rollback_permitted"] = rollback_compatible(pre+post)``
    — the key the controller's decision actually reads. The pre-switch record
    is passed in when the caller captured it BEFORE the emulated checkout;
    otherwise it is read from the same live queue, which the emulated
    checkout does not touch. A rehearsal journal is therefore not
    hand-written: its D7 pair is the one a controller run produces."""
    identity = run.manifest["identity"]
    pre = pre_record if pre_record is not None else \
        run.controller.compatibility_record(run.effects, run.args.target_sha)
    post = run.controller.compatibility_record(run.effects,
                                               run.args.target_sha)
    prior_state = {"prior_head": identity["prior_sha"],
                   "prior_config_sha256":
                       run.manifest["config"]["running_config_sha256"]}
    plan = {"helper_sha256": identity["helper_sha256"],
            "preflight": {"rollback_compatibility": pre},
            "rollback_compatibility_after": post,
            "automatic_rollback_permitted":
                run.controller.rollback_compatible({**pre, **post})}
    journal = run.controller.deploy_journal(
        prior_state, run.args.target_sha, run.args.target_tag, plan,
        prior_tag=run.args.prior_tag)
    journal["outcome"] = "completed"
    journal["transaction_id"] = "rehearsal-" + run.run_id
    return journal


def install_rehearsal_journal(run):
    """Bind the rehearsal journal writer over the real controller subprocess
    invocation. The journal assertions in switch() still run on what lands.
    The rehearsal switch also performs the real target checkout (tracked
    config restore + detach) exactly as the production controller does, so an
    approved-delta rehearsal exercises the same post-switch live render the
    production run sees; the later point() pins verify against what the
    rehearsal itself wrote. The pre-switch compatibility record is captured
    BEFORE the checkout, as the controller's preflight captures it."""
    original_switch = run.run_controller_switch

    def rehearsed_switch(record_dir):
        pre = run.controller.compatibility_record(run.effects,
                                                  run.args.target_sha)
        # The production controller's helper restores the tracked config
        # and detaches HEAD at the target; emulate both here.
        subprocess.run(["git", "-C", str(run.args.root), "checkout", "-q",
                        "--", "apps/crq-python/config.json"],
                       check=True, capture_output=True)
        subprocess.run(["git", "-C", str(run.args.root), "checkout", "-q",
                        "--detach", run.args.target_sha],
                       check=True, capture_output=True)
        record_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        payload = rehearsal_journal(run, pre)
        (record_dir / "controller-rehearsal.json").write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n")

    run.run_controller_switch = rehearsed_switch
    return original_switch


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Refused as exc:
        print(json.dumps({"error": {"kind": "refused", "message": str(exc)[:400]}},
                         indent=2, sort_keys=True), file=sys.stderr)
        raise SystemExit(2) from None
    except TimeoutError as exc:
        print(json.dumps({"error": {"kind": "timeout", "message": str(exc)[:400]}},
                         indent=2, sort_keys=True), file=sys.stderr)
        raise SystemExit(3) from None
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        raise SystemExit(str(exc)[:400]) from None
