#!/usr/bin/env python3
"""In-guest driver for the partial release/restore interruption proof.

This driver is intentionally separate from ``vm-unit-switch-guest.py`` so the
retained base, matrix and activators guest script stays byte-identical and their
old reports can still be rechecked with the new host as validator-only runs.

It imports the base guest module and adds one fixture-only mode: the actual
controller is interrupted at six release effect points and two restore effect
points, the host performs a real guest user-manager restart or guest OS reboot,
and the guest then observes the retained record, exact file metadata, the actual
activation states and the actual recovery ambiguity branch before invoking the
actual recovery CLI twice.

No production adapter, journal, store or runtime completion is exercised. The
Python and Node fixtures remain fake unit-scoped completion sources.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import pathlib
import sys
import time

BASE_PATH = pathlib.Path(__file__).with_name("vm-unit-switch-guest.py")
_SPEC = importlib.util.spec_from_file_location("crq_partial_base", BASE_PATH)
base = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(base)

HOME = base.HOME
UNIT_DIR = base.UNIT_DIR
FIXTURE = base.FIXTURE
PROOF_BIN = base.PROOF_BIN
CHECKOUT = base.CHECKOUT
STATE = base.STATE
PHASE_DIR = base.PHASE_DIR
RUNNER_ARCHIVE = base.RUNNER_ARCHIVE
REPAIR_UNIT = base.REPAIR_UNIT
REPAIR_TIMER = base.REPAIR_TIMER
REPAIR_PATH_UNIT = base.REPAIR_PATH_UNIT
REPAIR_SERVICE = base.REPAIR_SERVICE
REPAIR_TIMER_PATH = base.REPAIR_TIMER_PATH
REPAIR_PATH_PATH = base.REPAIR_PATH_PATH
REPAIR_TIMER_WANTS = base.REPAIR_TIMER_WANTS
REPAIR_PATH_WANTS = base.REPAIR_PATH_WANTS
REPAIR_DROPIN_DIR = base.REPAIR_DROPIN_DIR
REPAIR_DROPIN = base.REPAIR_DROPIN
REPAIR_STAGED = base.REPAIR_STAGED
REPAIR_TRIGGER = base.REPAIR_TRIGGER
REPAIR_PAUSE_MARKER = base.REPAIR_PAUSE_MARKER
REPAIR_COMPLETIONS = base.REPAIR_COMPLETIONS
CALLER_PATH = base.CALLER_PATH
BLOCKER_PATH = base.BLOCKER_PATH
ACTIVATOR_UNITS = base.ACTIVATOR_UNITS
NODE_RUNTIME = base.NODE_RUNTIME
PYTHON_RUNTIME = base.PYTHON_RUNTIME
require = base.require
run = base.run
systemctl = base.systemctl
show = base.show
snapshot = base.snapshot
record_summary = base.record_summary
records_in = base.records_in
sha256_bytes = base.sha256_bytes
sha256_file = base.sha256_file
repair_adapter = base.repair_adapter
repair_files = base.repair_files
repair_units = base.repair_units
read_completions = base.read_completions
settle_service = base.settle_service
check_preserved = base.check_preserved
jobs = base.jobs
_write = base._write

PERSISTENCE = ("restart", "reboot")
RELEASE_HOOKS = ("service", "timer", "path")
PARTIAL_CASES = {}
for _regime in PERSISTENCE:
    for _hook in RELEASE_HOOKS:
        PARTIAL_CASES["activation-%s-%s" % (_hook, _regime)] = {
            "family": "activation",
            "hook": "start-after-" + _hook,
            "regime": _regime,
            "runtime": NODE_RUNTIME,
            "prior_runtime": PYTHON_RUNTIME,
        }
    PARTIAL_CASES["restore-service-%s" % _regime] = {
        "family": "restore",
        "hook": "restore-activation-after-service",
        "regime": _regime,
        "runtime": NODE_RUNTIME,
        "prior_runtime": PYTHON_RUNTIME,
    }
PARTIAL_ORDER = tuple(PARTIAL_CASES)


def phase_names():
    names = ["prepare", "partial-install"]
    for regime in PERSISTENCE:
        for hook in RELEASE_HOOKS:
            case = "activation-%s-%s" % (hook, regime)
            names.append("partial-" + case)
            names.append("partial-" + case + "-observe")
        case = "restore-service-%s" % regime
        names.append("partial-" + case)
        names.append("partial-" + case + "-observe")
    names.append("partial-inspect")
    return tuple(names)


def case_dir(case):
    return HOME / ("records-partial-" + case)


def partial_dirs():
    return [case_dir(case) for case in PARTIAL_ORDER]


def source_manifest():
    paths = {
        "adapter": PROOF_BIN / "unit-switch-adapter.py",
        "controller": PROOF_BIN / "deploy-controller.py",
        "cli": PROOF_BIN / "unit-switch.py",
        "guest": pathlib.Path(__file__),
        "runner_source": RUNNER_ARCHIVE,
    }
    return {name: sha256_file(path) for name, path in paths.items()}


def partial_metadata():
    adapter = repair_adapter()
    paths = {
        "service": REPAIR_SERVICE,
        "timer": REPAIR_TIMER_PATH,
        "timer_wants": REPAIR_TIMER_WANTS,
        "path": REPAIR_PATH_PATH,
        "path_wants": REPAIR_PATH_WANTS,
        "dropin": REPAIR_DROPIN,
        "staged": REPAIR_STAGED,
        "trigger": REPAIR_TRIGGER,
    }
    return {name: adapter._path_state(path) for name, path in paths.items()}


def owned_files(value):
    keys = ("service", "timer", "timer_wants", "path", "path_wants",
            "dropin", "staged", "trigger")
    return {key: (value or {}).get(key) for key in keys}


def partial_snapshot(directory):
    data = snapshot(directory)
    data["repair_units"] = repair_units()
    data["repair_files"] = repair_files()
    data["repair_completions"] = read_completions(REPAIR_COMPLETIONS)
    data["partial_metadata"] = partial_metadata()
    data["tick"] = snapshot()
    data["partial_records"] = {
        str(path): [record_summary(item) for item in records_in(path)]
        for path in partial_dirs()}
    return data


def partial_cli(command, directory, extra=None, extra_env=None, timeout=180):
    argv = [sys.executable, str(PROOF_BIN / "unit-switch.py"), command,
            "--root", str(CHECKOUT), "--record-dir", str(directory),
            "--unit", REPAIR_UNIT, "--fixture-dir", str(FIXTURE),
            "--proof-root", str(PROOF_BIN), "--proof-fixture"]
    if extra:
        argv.extend(extra)
    result = run(argv, timeout=timeout, extra_env=extra_env, max_output=60000)
    parsed = None
    if (result.get("stdout") or "").strip():
        try:
            parsed = json.loads(result["stdout"])
        except ValueError:
            parsed = None
    result["json"] = parsed
    return result


def partial_reset_repair():
    """Reset the repair topology without touching any retained record or log."""
    UNIT_DIR.mkdir(parents=True, exist_ok=True)
    REPAIR_TIMER_WANTS.parent.mkdir(parents=True, exist_ok=True)
    REPAIR_PATH_WANTS.parent.mkdir(parents=True, exist_ok=True)
    adapter = repair_adapter()
    for path in (REPAIR_SERVICE, REPAIR_TIMER_PATH, REPAIR_PATH_PATH,
                 REPAIR_DROPIN, REPAIR_TIMER_WANTS, REPAIR_PATH_WANTS,
                 CALLER_PATH, BLOCKER_PATH, REPAIR_STAGED, REPAIR_TRIGGER,
                 REPAIR_PAUSE_MARKER):
        if path.is_symlink() or path.exists():
            path.unlink()
    for rogue in (UNIT_DIR / "crq-repair.socket",
                  UNIT_DIR / "default.target.wants" / REPAIR_TIMER,
                  REPAIR_DROPIN_DIR / "20-rogue.conf"):
        if rogue.is_symlink() or rogue.exists():
            rogue.unlink()
    _write(REPAIR_SERVICE, adapter.render_unit(PYTHON_RUNTIME), 0o644)
    _write(REPAIR_TIMER_PATH, adapter.render_timer(), 0o644)
    _write(REPAIR_PATH_PATH, adapter.render_path(), 0o644)
    _write(REPAIR_DROPIN, adapter.render_dropin(), 0o644)
    _write(CALLER_PATH, (
        "[Unit]\n"
        "Description=CRQ proof dependency caller\n"
        "Requires=crq-repair.service\n"
        "After=crq-repair.service\n"
        "\n"
        "[Service]\n"
        "Type=oneshot\n"
        "ExecStart=/bin/true\n"), 0o644)
    _write(BLOCKER_PATH, (
        "[Unit]\n"
        "Description=CRQ proof queued-job blocker\n"
        "\n"
        "[Service]\n"
        "Type=oneshot\n"
        "ExecStart=/bin/sleep 10\n"), 0o644)
    REPAIR_TIMER_WANTS.symlink_to("../" + REPAIR_TIMER)
    REPAIR_PATH_WANTS.symlink_to("../" + REPAIR_PATH_UNIT)
    base.repair_clean()
    result = systemctl("daemon-reload")
    require(result["rc"] == 0, "daemon-reload after partial reset failed")
    settle_service()
    require(show(REPAIR_UNIT, ["ActiveState"])["ActiveState"] == "inactive",
            "partial reset service did not settle to inactive")
    require(show(REPAIR_TIMER, ["ActiveState"])["ActiveState"] == "active",
            "partial reset timer did not become active")
    require(show(REPAIR_PATH_UNIT, ["ActiveState"])["ActiveState"] == "inactive",
            "partial reset path is not inactive")
    require(not REPAIR_STAGED.exists() and not REPAIR_STAGED.is_symlink(),
            "partial reset retains a staged target")
    require(not REPAIR_TRIGGER.exists(),
            "partial reset retains the path trigger")
    require(not REPAIR_PAUSE_MARKER.exists(),
            "partial reset retains the pause marker")


def require_pending_record(records, phase, runtime, prior, label):
    require(len(records) == 1, label + " does not retain exactly one record")
    record = records[0]
    require(record.get("outcome") == "pending", label + " record is not pending")
    require(record.get("phase") == phase,
            label + " record is not at " + phase)
    require(record.get("runtime") == runtime,
            label + " record names another runtime")
    require(record.get("prior_runtime") == prior,
            label + " record names another prior runtime")
    require("completions" not in record,
            label + " record wrongly carries completions")
    return record


def require_fence(cli, label, expected_count=None):
    require(cli.get("rc") == 3, label + " recovery did not return rc 3")
    payload = cli.get("json") or {}
    required = payload.get("recovery_required") or {}
    reason = required.get("reason") or ""
    require("activation may have occurred" in reason,
            label + " did not retain the activation-ambiguity branch")
    drain = payload.get("drain")
    require(isinstance(drain, dict), label + " has no drain evidence")
    queue = drain.get("queue_drain")
    require(isinstance(queue, dict) and queue.get("drained") is True,
            label + " queue drain is not a successful bounded observation")
    require(drain.get("jobs") == [], label + " retained a systemd job")
    owned = drain.get("owned") or {}
    require(owned.get("pids") == [] and owned.get("main_pid") == 0,
            label + " retained an owned process")
    require((drain.get("state") or {}).get("ActiveState") == "inactive",
            label + " service did not settle inactive")
    activators = drain.get("activators") or {}
    require(activators and all(
        (item or {}).get("ActiveState") in ("inactive", "failed")
        for item in activators.values()),
        label + " activator did not settle inactive")
    baseline = drain.get("completion_baseline")
    require(isinstance(baseline, dict), label + " has no completion baseline")
    require(type(baseline.get("count")) is int and baseline["count"] >= 0,
            label + " completion baseline count is invalid")
    require(isinstance(baseline.get("sequences"), list)
            and all(type(item) is int for item in baseline["sequences"]),
            label + " completion baseline sequences are invalid")
    require(isinstance(baseline.get("invocations"), list)
            and len(baseline["invocations"]) == baseline["count"],
            label + " completion baseline invocations are invalid")
    if expected_count is not None:
        require(baseline["count"] == expected_count,
                label + " completion baseline count changed")
    return baseline


def require_fenced_state(snapshot_value, label):
    files = snapshot_value.get("repair_files") or {}
    units = snapshot_value.get("repair_units") or {}
    service = files.get("service") or {}
    require(service.get("type") == "symlink"
            and service.get("target") == "/dev/null",
            label + " did not retain the durable service mask")
    require((files.get("staged") or {}).get("type") == "missing",
            label + " retained a staged target")
    require((units.get(REPAIR_UNIT) or {}).get("LoadState") == "masked",
            label + " service is not masked at the fence")
    require((units.get(REPAIR_TIMER) or {}).get("ActiveState")
            in ("inactive", "failed"),
            label + " timer is active at the fence")
    require((units.get(REPAIR_PATH_UNIT) or {}).get("ActiveState")
            in ("inactive", "failed"),
            label + " path is active at the fence")


def require_source(payload):
    payload["source"] = source_manifest()
    return payload


def wait_completions(minimum, label):
    deadline = time.time() + 60
    while len(read_completions(REPAIR_COMPLETIONS)) < minimum:
        require(time.time() < deadline,
                label + " produced no released-runtime completion in the bound")
        time.sleep(0.2)


def partial_prepare(args):
    prepared = base.phase_prepare(args)
    for directory in partial_dirs():
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        require(not list(directory.iterdir()),
                "partial case record directory is not empty: " + directory.name)
    return require_source({"phase": "prepare", "prepared": prepared["prepared"],
                           "snapshot": prepared["snapshot"]})


def partial_install(args):
    for directory in partial_dirs():
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(not list(directory.iterdir()),
                "partial case record directory is not empty: " + directory.name)
    REPAIR_COMPLETIONS.unlink(missing_ok=True)
    pathlib.Path(str(REPAIR_COMPLETIONS) + ".lock").unlink(missing_ok=True)
    partial_reset_repair()
    adapter = repair_adapter()
    inventory = adapter.inventory()
    require(inventory.get("topology") == "repair",
            "partial inventory did not report the repair topology")
    require(inventory["activators"] == {
        "timer_active": "active",
        "timer_unit_file_state": "enabled",
        "service_active": "inactive",
        "path_active": "inactive",
        "path_unit_file_state": "enabled",
    }, "partial inventory activator states are not the supported shape")
    files = repair_files()
    units = repair_units()
    require((files.get("staged") or {}).get("type") == "missing",
            "partial install retains a staged target")
    require((files.get("trigger") or {}).get("type") == "missing",
            "partial install retains the path trigger")
    require(len(read_completions(REPAIR_COMPLETIONS)) >= 1
            and all(item.get("runtime") == PYTHON_RUNTIME
                    for item in read_completions(REPAIR_COMPLETIONS)),
            "partial install did not retain the settled Python completion")
    for path in partial_dirs():
        require(path.is_dir() and not path.is_symlink(),
                "partial case record directory is not a real directory")
    return require_source({
        "phase": "partial-install",
        "inventory": inventory,
        "files": files,
        "units": units,
        "repair_completions": read_completions(REPAIR_COMPLETIONS),
        "case_dirs": [str(path) for path in partial_dirs()],
        "tick": snapshot(),
        "preserved": check_preserved({"phase": "partial-install"}),
    })


def partial_activation_boundary(args):
    case = args.case
    spec = PARTIAL_CASES.get(case) or {}
    require(spec.get("family") == "activation", "unknown activation case")
    directory = case_dir(case)
    require(not list(directory.iterdir()),
            "activation case record directory is not empty")
    partial_reset_repair()
    before = partial_snapshot(directory)
    require(before["records"] == [], "activation boundary saw a record")
    require((before["repair_units"].get(REPAIR_TIMER) or {}).get("ActiveState")
            == "active", "activation boundary timer is not active")
    require((before["repair_units"].get(REPAIR_PATH_UNIT) or {}).get("ActiveState")
            == "inactive", "activation boundary path is not inactive")
    cli = partial_cli("switch", directory, ["--runtime", spec["runtime"]],
                      {"CRQ_PROOF_KILL_ON": spec["hook"]})
    require(cli.get("rc") == -9,
            "activation boundary was not killed by exact SIGKILL: "
            + json.dumps(cli.get("rc")))
    if spec["hook"] != "start-after-service":
        wait_completions(len(before["repair_completions"]) + 1,
                         "activation " + case)
    after = partial_snapshot(directory)
    record = require_pending_record(after["records"], "activation_pending",
                                    spec["runtime"], spec["prior_runtime"],
                                    case)
    expected_service = repair_adapter().render_unit(spec["runtime"])
    require((after["repair_files"].get("service") or {}).get("sha256")
            == sha256_bytes(expected_service.encode()),
            "activation boundary service bytes are not the requested runtime")
    require((after["repair_units"].get(REPAIR_UNIT) or {}).get("LoadState")
            == "loaded", "activation boundary service is not loaded")
    require(owned_files(after["repair_files"])["staged"].get("type") == "missing",
            "activation boundary retains a staged target")
    for key in ("timer", "timer_wants", "path", "path_wants", "dropin",
                "trigger"):
        require(after["repair_files"].get(key) == before["repair_files"].get(key),
                "activation boundary changed the " + key + " path")
    timer_state = (after["repair_units"].get(REPAIR_TIMER) or {}).get(
        "ActiveState")
    path_state = (after["repair_units"].get(REPAIR_PATH_UNIT) or {}).get(
        "ActiveState")
    if spec["hook"] == "start-after-service":
        require(timer_state == "inactive",
                "after-service boundary timer was released")
        require(after["jobs"] == [], "after-service boundary retained a job")
        require((after["repair_units"].get(REPAIR_UNIT) or {}).get("MainPID")
                in ("0", ""), "after-service boundary retained a service pid")
        expected_delta = 1
    else:
        require(timer_state == "active",
                "released timer is not active at the boundary")
        expected_delta = None
    require(path_state == "inactive",
            "after-path boundary path is not inactive")
    new = after["repair_completions"][len(before["repair_completions"]):]
    require(all(item.get("runtime") == spec["runtime"] for item in new),
            "activation boundary produced a non-requested runtime completion")
    if expected_delta is not None:
        require(len(new) == expected_delta,
                "after-service boundary completion delta is not exactly one")
    else:
        require(len(new) >= 1,
                "activation boundary produced no completion")
    return require_source({
        "phase": "partial-" + case,
        "case": case,
        "family": "activation",
        "hook": spec["hook"],
        "regime": spec["regime"],
        "record_dir": str(directory),
        "before": before,
        "after": after,
        "cli": cli,
        "record": record,
        "completion_delta": new,
        "preserved": check_preserved({"phase": "partial-" + case}),
    })


def partial_restore_boundary(args):
    case = args.case
    spec = PARTIAL_CASES.get(case) or {}
    require(spec.get("family") == "restore", "unknown restore case")
    directory = case_dir(case)
    require(not list(directory.iterdir()),
            "restore case record directory is not empty")
    partial_reset_repair()
    kill_cli = partial_cli("switch", directory, ["--runtime", spec["runtime"]],
                           {"CRQ_PROOF_KILL_ON": "install"})
    require(kill_cli.get("rc") == -9,
            "restore precondition switch was not killed by exact SIGKILL")
    drained = partial_snapshot(directory)
    drained_record = require_pending_record(
        drained["records"], "drained", spec["runtime"], spec["prior_runtime"],
        case + " precondition")
    record_path = drained_record["path"]
    recovery_cli = partial_cli("recover", directory, ["--record", record_path],
                               {"CRQ_PROOF_KILL_ON": spec["hook"]})
    require(recovery_cli.get("rc") == -9,
            "restore boundary was not killed by exact SIGKILL")
    wait_completions(len(drained["repair_completions"]) + 1,
                     "restore " + case)
    after = partial_snapshot(directory)
    record = require_pending_record(after["records"],
                                    "restore_activation_pending",
                                    spec["runtime"], spec["prior_runtime"],
                                    case)
    require(record["sha256"] != drained_record["sha256"],
            "restore boundary did not advance the retained record")
    expected_service = repair_adapter().render_unit(spec["prior_runtime"])
    require((after["repair_files"].get("service") or {}).get("sha256")
            == sha256_bytes(expected_service.encode()),
            "restore boundary service bytes are not the prior runtime")
    require((after["repair_units"].get(REPAIR_UNIT) or {}).get("LoadState")
            == "loaded", "restore boundary service is not loaded")
    require(owned_files(after["repair_files"])["staged"].get("type") == "missing",
            "restore boundary retains a staged target")
    require((after["repair_units"].get(REPAIR_TIMER) or {}).get("ActiveState")
            == "active", "restore boundary timer is not active")
    require((after["repair_units"].get(REPAIR_PATH_UNIT) or {}).get("ActiveState")
            == "inactive", "restore boundary path is not inactive")
    new = after["repair_completions"][len(drained["repair_completions"]):]
    require(all(item.get("runtime") == spec["prior_runtime"] for item in new),
            "restore boundary produced a non-prior runtime completion")
    require(len(new) >= 1, "restore boundary produced no completion")
    return require_source({
        "phase": "partial-" + case,
        "case": case,
        "family": "restore",
        "hook": spec["hook"],
        "regime": spec["regime"],
        "record_dir": str(directory),
        "before": drained,
        "before_recovery": drained,
        "drained_record": drained_record,
        "after": after,
        "switch_cli": kill_cli,
        "recovery_cli": recovery_cli,
        "record": record,
        "completion_delta": new,
        "preserved": check_preserved({"phase": "partial-" + case}),
    })


def _boundary_phase(case):
    return PHASE_DIR / ("partial-" + case + ".json")


def partial_activation_observe(args):
    case = args.case
    spec = PARTIAL_CASES.get(case) or {}
    require(spec.get("family") == "activation", "unknown activation case")
    boundary = json.loads(_boundary_phase(case).read_text())
    directory = case_dir(case)
    before = partial_snapshot(directory)
    record = require_pending_record(before["records"], "activation_pending",
                                    spec["runtime"], spec["prior_runtime"],
                                    case + " observe")
    require(record["sha256"] == (boundary.get("record") or {}).get("sha256"),
            "activation observe record bytes changed across the boundary")
    require(owned_files(before["repair_files"])
            == owned_files((boundary.get("after") or {}).get("repair_files")),
            "activation observe file states changed across the boundary")
    require(before["partial_metadata"]
            == (boundary.get("after") or {}).get("partial_metadata"),
            "activation observe file metadata changed across the boundary")
    new = before["repair_completions"][
        len((boundary.get("after") or {}).get("repair_completions") or []):]
    require(all(item.get("runtime") == spec["runtime"] for item in new),
            "activation observe saw a non-requested runtime completion")
    recovery = partial_cli("recover", directory, ["--record", record["path"]])
    baseline = require_fence(recovery, case + " recovery")
    after_recovery = partial_snapshot(directory)
    record_after = require_pending_record(
        after_recovery["records"], "activation_pending", spec["runtime"],
        spec["prior_runtime"], case + " recovery")
    require(record_after["sha256"] == record["sha256"],
            "activation recovery changed the retained record bytes")
    require(baseline["count"] == len(after_recovery["repair_completions"]),
            "activation recovery produced a completion after the settled fence")
    require(baseline["invocations"] == [
        item.get("invocation")
        for item in after_recovery["repair_completions"]],
        "activation recovery completion log is not the baseline prefix")
    require_fenced_state(after_recovery, case + " recovery")
    repeat = partial_cli("recover", directory, ["--record", record["path"]])
    baseline_repeat = require_fence(repeat, case + " repeat",
                                    expected_count=baseline["count"])
    after_repeat = partial_snapshot(directory)
    record_repeat = require_pending_record(
        after_repeat["records"], "activation_pending", spec["runtime"],
        spec["prior_runtime"], case + " repeat")
    require(record_repeat["sha256"] == record["sha256"],
            "activation repeat changed the retained record bytes")
    require(len(after_repeat["repair_completions"])
            == baseline_repeat["count"],
            "activation repeat produced a completion after the settled fence")
    require_fenced_state(after_repeat, case + " repeat")
    return require_source({
        "phase": "partial-" + case + "-observe",
        "case": case,
        "family": "activation",
        "hook": spec["hook"],
        "regime": spec["regime"],
        "record_dir": str(directory),
        "before": before,
        "record": record,
        "record_after": record_after,
        "record_after_repeat": record_repeat,
        "new_completions": new,
        "recovery": recovery,
        "repeat": repeat,
        "after_recovery": after_recovery,
        "after_repeat": after_repeat,
        "preserved": check_preserved(
            {"phase": "partial-" + case + "-observe"}),
    })


def partial_restore_observe(args):
    case = args.case
    spec = PARTIAL_CASES.get(case) or {}
    require(spec.get("family") == "restore", "unknown restore case")
    boundary = json.loads(_boundary_phase(case).read_text())
    directory = case_dir(case)
    before = partial_snapshot(directory)
    record = require_pending_record(
        before["records"], "restore_activation_pending", spec["runtime"],
        spec["prior_runtime"], case + " observe")
    require(record["sha256"] == (boundary.get("record") or {}).get("sha256"),
            "restore observe record bytes changed across the boundary")
    require(owned_files(before["repair_files"])
            == owned_files((boundary.get("after") or {}).get("repair_files")),
            "restore observe file states changed across the boundary")
    require(before["partial_metadata"]
            == (boundary.get("after") or {}).get("partial_metadata"),
            "restore observe file metadata changed across the boundary")
    new = before["repair_completions"][
        len((boundary.get("after") or {}).get("repair_completions") or []):]
    require(all(item.get("runtime") == spec["prior_runtime"] for item in new),
            "restore observe saw a non-prior runtime completion")
    recovery = partial_cli("recover", directory, ["--record", record["path"]])
    baseline = require_fence(recovery, case + " recovery")
    after_recovery = partial_snapshot(directory)
    record_after = require_pending_record(
        after_recovery["records"], "restore_activation_pending",
        spec["runtime"], spec["prior_runtime"], case + " recovery")
    require(record_after["sha256"] == record["sha256"],
            "restore recovery changed the retained record bytes")
    require(baseline["count"] == len(after_recovery["repair_completions"]),
            "restore recovery produced a completion after the settled fence")
    require(baseline["invocations"] == [
        item.get("invocation")
        for item in after_recovery["repair_completions"]],
        "restore recovery completion log is not the baseline prefix")
    require_fenced_state(after_recovery, case + " recovery")
    require((after_recovery["repair_files"].get("service") or {}).get("type")
            == "symlink",
            "restore recovery restored the prior service again")
    repeat = partial_cli("recover", directory, ["--record", record["path"]])
    baseline_repeat = require_fence(repeat, case + " repeat",
                                    expected_count=baseline["count"])
    after_repeat = partial_snapshot(directory)
    record_repeat = require_pending_record(
        after_repeat["records"], "restore_activation_pending", spec["runtime"],
        spec["prior_runtime"], case + " repeat")
    require(record_repeat["sha256"] == record["sha256"],
            "restore repeat changed the retained record bytes")
    require(len(after_repeat["repair_completions"])
            == baseline_repeat["count"],
            "restore repeat produced a completion after the settled fence")
    require_fenced_state(after_repeat, case + " repeat")
    return require_source({
        "phase": "partial-" + case + "-observe",
        "case": case,
        "family": "restore",
        "hook": spec["hook"],
        "regime": spec["regime"],
        "record_dir": str(directory),
        "before": before,
        "record": record,
        "record_after": record_after,
        "record_after_repeat": record_repeat,
        "new_completions": new,
        "recovery": recovery,
        "repeat": repeat,
        "after_recovery": after_recovery,
        "after_repeat": after_repeat,
        "preserved": check_preserved(
            {"phase": "partial-" + case + "-observe"}),
    })


def partial_inspect(args):
    partial_reset_repair()
    files = repair_files()
    units = repair_units()
    expected_service = repair_adapter().render_unit(PYTHON_RUNTIME)
    require((files.get("service") or {}).get("sha256")
            == sha256_bytes(expected_service.encode()),
            "final partial service bytes are not the prior runtime")
    require((files.get("staged") or {}).get("type") == "missing",
            "final partial state retains a staged target")
    require((files.get("trigger") or {}).get("type") == "missing",
            "final partial state retains the path trigger")
    require(not REPAIR_PAUSE_MARKER.exists(),
            "final partial state retains the pause marker")
    require((units.get(REPAIR_TIMER) or {}).get("ActiveState") == "active",
            "final partial timer is not active")
    require((units.get(REPAIR_PATH_UNIT) or {}).get("ActiveState")
            == "inactive", "final partial path is not inactive")
    require((units.get(REPAIR_PATH_UNIT) or {}).get("UnitFileState")
            == "enabled", "final partial path is not enabled")
    for rogue in (UNIT_DIR / "crq-repair.socket",
                  REPAIR_DROPIN_DIR / "20-rogue.conf",
                  UNIT_DIR / "default.target.wants" / REPAIR_TIMER):
        require(not rogue.exists() and not rogue.is_symlink(),
                "final partial state retains a rogue entry: " + str(rogue))
    case_records = {}
    for case in PARTIAL_ORDER:
        records = [record_summary(path)
                   for path in records_in(case_dir(case))]
        phase = ("restore_activation_pending"
                 if PARTIAL_CASES[case]["family"] == "restore"
                 else "activation_pending")
        case_records[case] = require_pending_record(
            records, phase, PARTIAL_CASES[case]["runtime"],
            PARTIAL_CASES[case]["prior_runtime"], case + " inspect")
    completions = read_completions(REPAIR_COMPLETIONS)
    require(all(item.get("unit") == REPAIR_UNIT
                and item.get("success") is True
                and item.get("runtime") in (PYTHON_RUNTIME, NODE_RUNTIME)
                and type(item.get("sequence")) is int
                and item["sequence"] > 0
                for item in completions),
            "final partial completion log is not valid unit/runtime evidence")
    sequences = [item["sequence"] for item in completions]
    require(sequences == sorted(sequences)
            and len(sequences) == len(set(sequences)),
            "final partial completion sequences are not strictly advancing")
    require(len({item["invocation"] for item in completions})
            == len(completions),
            "final partial completion invocations are not unique")
    tick = snapshot()
    saved = base.baseline()
    require(tick["state"] == saved["state"],
            "final partial tick state changed the preserved queue/heartbeat")
    require((tick.get("history") or {}).get("sha256")
            == saved["history_sha256"],
            "final partial tick state changed the historical record")
    require([item["path"] for item in tick.get("records") or []]
            == saved["record_paths"],
            "final partial tick state changed the original record set")
    require((tick.get("files") or {}).get(
        str(base.SERVICE), {}).get("sha256")
        == sha256_bytes(expected_unit_bytes(PYTHON_RUNTIME)),
        "final partial tick service bytes changed")
    require(not (UNIT_DIR / ".crq-tick.service.staged").exists(),
            "final partial state retains the staged tick target")
    require(jobs() == [], "final partial state retains a systemd job")
    return require_source({
        "phase": "partial-inspect",
        "files": files,
        "units": units,
        "case_dirs": [str(path) for path in partial_dirs()],
        "case_records": case_records,
        "completions": completions,
        "tick": tick,
        "preserved": check_preserved({"phase": "partial-inspect"}),
    })


def expected_unit_bytes(runtime):
    return repair_adapter().render_unit(runtime)


def main(argv=None):
    phases = phase_names() + ("host-identity",)
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=phases)
    parser.add_argument("--case", choices=PARTIAL_ORDER)
    parser.add_argument("--label")
    parser.add_argument("--boundary")
    parser.add_argument("--kind", choices=("manager", "reboot"))
    parser.add_argument("--after")
    args = parser.parse_args(argv)
    if args.phase == "host-identity":
        return base.main(["host-identity", "--label", args.label or "identity"])
    try:
        if args.phase == "prepare":
            payload = partial_prepare(args)
        elif args.phase == "partial-install":
            payload = partial_install(args)
        elif args.phase == "partial-inspect":
            payload = partial_inspect(args)
        elif args.phase.endswith("-observe"):
            if not args.case:
                raise RuntimeError("partial observe phase requires --case")
            if PARTIAL_CASES[args.case]["family"] == "activation":
                payload = partial_activation_observe(args)
            else:
                payload = partial_restore_observe(args)
        else:
            if args.phase not in ("partial-" + case for case in PARTIAL_ORDER):
                raise RuntimeError("unknown partial phase: " + args.phase)
            if not args.case:
                raise RuntimeError("partial boundary phase requires --case")
            if PARTIAL_CASES[args.case]["family"] == "activation":
                payload = partial_activation_boundary(args)
            else:
                payload = partial_restore_boundary(args)
        PHASE_DIR.mkdir(parents=True, exist_ok=True)
        name = args.label or args.phase
        (PHASE_DIR / (name + ".json")).write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n")
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0
    except Exception as exc:  # noqa: BLE001 - the harness must see the failure
        print(json.dumps({"phase": args.phase, "error": type(exc).__name__,
                          "detail": str(exc)[:1000]}, sort_keys=True))
        return 1


if __name__ == "__main__":
    sys.exit(main())
