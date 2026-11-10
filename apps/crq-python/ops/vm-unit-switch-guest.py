#!/usr/bin/env python3
"""In-guest driver for the bounded unit-switch proof vehicle.

Runs as the isolated ``probe`` account in a disposable guest. It prepares a
throwaway git checkout, a private controller record directory, a completed
historical record, and one harmless fixture installed under the allowlisted
unit name ``crq-tick.service``. It then invokes the proof CLI, which calls the
actual controller ``switch_unit``/``recover_unit`` functions.

No production checkout, credential, provider or host configuration is touched.
The driver is not a production adapter and makes no CQ runtime completion
claim; the Python and Node fixtures are fake, unit-scoped completion sources.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

HOME = pathlib.Path.home()
UNIT_DIR = HOME / ".config/systemd/user"
FIXTURE = HOME / "fixture"
PROOF_BIN = HOME / "proof-bin"
CHECKOUT = HOME / "checkout"
RECORDS = HOME / "records"
CASE_RECORDS = {
    "manager": RECORDS / "ambiguity-manager-restart",
    "reboot": RECORDS / "ambiguity-guest-reboot",
}
STATE = CHECKOUT / "apps/crq-python/state"
COMPLETIONS = FIXTURE / "completions.jsonl"
BASELINE = FIXTURE / "baseline.json"
HISTORY_ID = "a" * 32
HISTORY_PATH = RECORDS / ("controller-" + HISTORY_ID + ".json")
UNIT = "crq-tick.service"
TIMER = "crq-tick.timer"
WANTS = UNIT_DIR / "timers.target.wants" / TIMER
SERVICE = UNIT_DIR / UNIT
STAGED_SERVICE = UNIT_DIR / ("." + UNIT + ".staged")
TIMER_PATH = UNIT_DIR / TIMER
INVOCATION = re.compile(r"[0-9a-f]{32}\Z")
NODE_RUNTIME = "node:" + "b" * 40
PYTHON_RUNTIME = "python"
PHASE_DIR = FIXTURE / "phases"

# The restart/reboot matrix deliberately keeps activation-pending ambiguity in
# a separate private record directory per case. An unresolved intent blocks new
# switches only in the supplied directory, so this is test isolation of
# independent cases, not a resolution mechanism or a fix for the known
# cross-directory interoperability gap.
MATRIX_CASES = {
    "matrix-restart-drained": {
        "kind": "manager", "boundary": "drained",
        "runtime": NODE_RUNTIME, "prior_runtime": PYTHON_RUNTIME,
        "record_dir": RECORDS},
    "matrix-restart-restore-staged": {
        "kind": "manager", "boundary": "restore_staged",
        "runtime": NODE_RUNTIME, "prior_runtime": PYTHON_RUNTIME,
        "record_dir": RECORDS},
    "matrix-restart-ambiguity": {
        "kind": "manager", "boundary": "activation_pending",
        "runtime": NODE_RUNTIME, "prior_runtime": PYTHON_RUNTIME,
        "record_dir": CASE_RECORDS["manager"]},
    "matrix-reboot-drained": {
        "kind": "reboot", "boundary": "drained",
        "runtime": PYTHON_RUNTIME, "prior_runtime": NODE_RUNTIME,
        "record_dir": RECORDS},
    "matrix-reboot-restore-staged": {
        "kind": "reboot", "boundary": "restore_staged",
        "runtime": PYTHON_RUNTIME, "prior_runtime": NODE_RUNTIME,
        "record_dir": RECORDS},
    "matrix-reboot-ambiguity": {
        "kind": "reboot", "boundary": "activation_pending",
        "runtime": PYTHON_RUNTIME, "prior_runtime": NODE_RUNTIME,
        "record_dir": CASE_RECORDS["reboot"]},
}


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    return sha256_bytes(pathlib.Path(path).read_bytes())


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def env():
    values = dict(os.environ)
    values["XDG_RUNTIME_DIR"] = "/run/user/%d" % os.getuid()
    return values


def run(argv, timeout=120, extra_env=None):
    values = env()
    if extra_env:
        values.update(extra_env)
    try:
        result = subprocess.run(argv, capture_output=True, text=True,
                                timeout=timeout, env=values)
        return {"argv": [str(item) for item in argv], "rc": result.returncode,
                "stdout": result.stdout[-12000:],
                "stderr": result.stderr[-12000:], "timeout": False}
    except subprocess.TimeoutExpired as exc:
        return {"argv": [str(item) for item in argv], "rc": None,
                "stdout": _text_output(exc.stdout)[-12000:],
                "stderr": _text_output(exc.stderr)[-12000:], "timeout": True}


def _text_output(value):
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value if isinstance(value, str) else str(value)


def systemctl(*args, timeout=90):
    return run(["systemctl", "--user", *args], timeout=timeout)


def show(unit, props):
    result = run(["systemctl", "--user", "show", unit,
                  "-p", ",".join(props)], timeout=30)
    require(not result["timeout"] and result["rc"] == 0,
            "unit observation failed for %s: %s" % (unit, result["stderr"][:300]))
    values = {}
    for line in result["stdout"].splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values


def jobs():
    result = run(["systemctl", "--user", "list-jobs", "--no-legend",
                  "--no-pager"], timeout=30)
    require(not result["timeout"] and result["rc"] == 0,
            "list-jobs failed; job absence is unknown")
    return [line for line in result["stdout"].splitlines() if line.strip()]


def file_state(path):
    path = pathlib.Path(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return {"path": str(path), "type": "missing"}
    state = {"path": str(path), "mode": info.st_mode & 0o7777,
             "uid": info.st_uid, "gid": info.st_gid}
    if path.is_symlink():
        state.update({"type": "symlink", "target": os.readlink(path)})
    elif path.is_file():
        state.update({"type": "file", "sha256": sha256_file(path),
                      "size": info.st_size})
    else:
        state.update({"type": "other"})
    return state


def manager_identity():
    uid = os.getuid()
    result = run(["sudo", "-n", "systemctl", "show", "user@%d.service" % uid,
                  "-p", "MainPID", "-p", "InvocationID"], timeout=30)
    values = {}
    for line in (result.get("stdout") or "").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    require(not result["timeout"] and result["rc"] == 0,
            "user-manager identity observation failed")
    require(values.get("MainPID") not in (None, "")
            and values.get("InvocationID") not in (None, ""),
            "user-manager identity observation is incomplete")
    return {"pid": values["MainPID"], "invocation_id": values["InvocationID"]}


def records_in(directory):
    found = []
    for path in sorted(pathlib.Path(directory).glob("controller-*.json")):
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("invalid controller record entry: " + path.name)
        found.append(path)
    return found


def records():
    return records_in(RECORDS)


def record_dirs():
    return [RECORDS, *CASE_RECORDS.values()]


def record_summary(path):
    path = pathlib.Path(path)
    raw = path.read_bytes()
    try:
        record = json.loads(raw)
    except ValueError as exc:
        raise RuntimeError("controller record is not JSON: " + path.name) from exc
    keys = ("schema_version", "transaction_id", "operation", "unit", "runtime",
            "prior_runtime", "outcome", "phase", "reason", "completions",
            "record_path")
    summary = {key: record[key] for key in keys if key in record}
    summary["path"] = str(path)
    summary["sha256"] = sha256_bytes(raw)
    summary["bytes"] = len(raw)
    return summary


def baseline():
    data = json.loads(BASELINE.read_text())
    return data


def state_hashes():
    return {"queue.json": sha256_file(STATE / "queue.json") if (STATE / "queue.json").exists() else None,
            "heartbeat.json": sha256_file(STATE / "heartbeat.json") if (STATE / "heartbeat.json").exists() else None}


def check_preserved(phase):
    saved = baseline()
    observed = state_hashes()
    require(observed == saved["state"], "preserved queue/heartbeat bytes changed")
    require(HISTORY_PATH.exists(), "historical completed record disappeared")
    require(sha256_file(HISTORY_PATH) == saved["history_sha256"],
            "historical completed record bytes changed")
    require([str(path) for path in records()] == saved["record_paths"] or
            set(str(path) for path in records()) >= set(saved["record_paths"]),
            "historical record set is incomplete")
    return {"state": observed, "history_sha256": sha256_file(HISTORY_PATH),
            "record_count": len(records())}


def completions():
    if not COMPLETIONS.exists():
        return []
    entries = []
    for number, line in enumerate(COMPLETIONS.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            entries.append(json.loads(line))
        except ValueError as exc:
            raise RuntimeError("completion log line %d is not JSON" % number) from exc
    return entries


def metadata_state():
    adapter = load_adapter().GuestFixtureAdapter(
        unit_dir=UNIT_DIR, fixture_dir=FIXTURE, unit=UNIT,
        proof_root=PROOF_BIN, guest_only=True)
    return {str(path): adapter._path_state(path)
            for path in (SERVICE, TIMER_PATH, WANTS, STAGED_SERVICE)}


def snapshot(record_dir=None):
    directory = pathlib.Path(record_dir) if record_dir else RECORDS
    return {
        "at": datetime.datetime.now(datetime.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"),
        "hostname": os.uname().nodename,
        "user": os.getuid(),
        "boot_id": pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        "manager": manager_identity(),
        "systemd": (run(["systemctl", "--version"]).get("stdout") or "").splitlines()[:1],
        "python": (run(["python3", "--version"]).get("stdout") or "").strip(),
        "node": (run(["node", "--version"]).get("stdout") or "").strip(),
        "units": {name: show(name, ["LoadState", "ActiveState", "SubState",
                                    "UnitFileState", "FragmentPath",
                                    "InvocationID", "Result"])
                  for name in (UNIT, TIMER)},
        "files": {str(path): file_state(path)
                  for path in (SERVICE, TIMER_PATH, WANTS, STAGED_SERVICE,
                               COMPLETIONS, HISTORY_PATH)},
        "metadata": metadata_state(),
        "state": state_hashes(),
        "history": record_summary(HISTORY_PATH) if HISTORY_PATH.exists() else None,
        "records": [record_summary(path) for path in records_in(directory)],
        "all_records": {str(path): [record_summary(item)
                                    for item in records_in(path)]
                        for path in record_dirs()},
        "completions": completions(),
        "jobs": jobs(),
    }


def _write(path, text, mode=0o644):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


def git(*args):
    result = run(["git", "-C", str(CHECKOUT), *args], timeout=60)
    require(not result["timeout"] and result["rc"] == 0,
            "git %s failed: %s" % (" ".join(args), result["stderr"][:300]))
    return result["stdout"].strip()


def load_adapter():
    spec = importlib.util.spec_from_file_location(
        "crq_unit_switch_adapter", PROOF_BIN / "unit-switch-adapter.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prepare_fixture(adapter):
    UNIT_DIR.mkdir(parents=True, exist_ok=True)
    WANTS.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.mkdir(parents=True, exist_ok=True)
    PHASE_DIR.mkdir(parents=True, exist_ok=True)
    for path in (SERVICE, TIMER_PATH, WANTS, STAGED_SERVICE):
        if path.is_symlink() or path.exists():
            path.unlink()
    _write(SERVICE, adapter.render_unit(PYTHON_RUNTIME), 0o644)
    _write(TIMER_PATH, adapter.render_timer(), 0o644)
    WANTS.symlink_to("../" + TIMER)
    COMPLETIONS.unlink(missing_ok=True)
    pathlib.Path(str(COMPLETIONS) + ".lock").unlink(missing_ok=True)
    shutil.rmtree(str(COMPLETIONS) + ".lockdir", ignore_errors=True)
    result = systemctl("daemon-reload")
    require(result["rc"] == 0, "daemon-reload after fixture install failed")
    systemctl("stop", TIMER)
    systemctl("reset-failed", TIMER)
    service = show(UNIT, ["LoadState", "ActiveState", "UnitFileState"])
    timer = show(TIMER, ["LoadState", "ActiveState", "UnitFileState"])
    require(service["LoadState"] == "loaded", "fixture service did not load")
    require(service["ActiveState"] == "inactive", "fixture service started unexpectedly")
    require(timer["ActiveState"] == "inactive", "fixture timer started unexpectedly")
    require(timer["UnitFileState"] == "enabled", "fixture timer is not enabled")
    return {"service": service, "timer": timer}


def prepare_checkout():
    if CHECKOUT.exists():
        shutil.rmtree(CHECKOUT)
    (CHECKOUT / "apps/crq-python/state").mkdir(parents=True)
    _write(CHECKOUT / ".gitignore", "apps/crq-python/state/\n")
    _write(CHECKOUT / "apps/crq-python/config.json",
           json.dumps({"proof_vehicle": True}, indent=2) + "\n")
    _write(STATE / "queue.json",
           json.dumps({"items": [], "version": "proof-vehicle"}, indent=2) + "\n")
    _write(STATE / "heartbeat.json",
           json.dumps({"last_tick": "2026-01-01T00:00:00Z"}, indent=2) + "\n")
    for command in (("init", "-q"), ("config", "user.email", "proof@example.invalid"),
                    ("config", "user.name", "Proof Fixture"), ("add", "."),
                    ("commit", "-qm", "isolated proof baseline")):
        git(*command)
    return git("rev-parse", "HEAD")


def prepare_history():
    RECORDS.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(RECORDS, 0o700)
    record = {
        "schema_version": 1,
        "transaction_id": HISTORY_ID,
        "operation": "unit_switch",
        "unit": UNIT,
        "runtime": NODE_RUNTIME,
        "prior_runtime": PYTHON_RUNTIME,
        "outcome": "completed",
        "at": "2026-01-01T00:00:00Z",
        "snapshot": {},
        "state": None,
        "phase": "activation_pending",
        "completions": [],
    }
    _write(HISTORY_PATH, json.dumps(record, indent=2, sort_keys=True) + "\n",
           0o600)
    return record_summary(HISTORY_PATH)


def phase_prepare(args):
    require(os.uname().nodename == "crq-probe",
            "proof driver only runs on the disposable crq-probe guest")
    require(not (HOME / "repos").exists(),
            "a production checkout directory is present in the guest")
    opt = HOME / ".local/opt"
    if opt.exists():
        require(not list(opt.glob("crq-*")),
                "a production crq artifact directory is present in the guest")
    required = ["deploy-controller.py", "unit-switch-adapter.py",
                "unit-switch.py", "unit-switch-fixture.py",
                "unit-switch-fixture.mjs"]
    for name in required:
        path = PROOF_BIN / name
        require(path.is_file() and not path.is_symlink(),
                "missing uploaded proof script: " + name)
    require(shutil.which("git") is not None,
            "git is required for the isolated checkout")
    require(shutil.which("node") is not None,
            "node is required for the Node fixture")
    require(shutil.which("python3") is not None,
            "python3 is required for the Python fixture")
    commit = prepare_checkout()
    history = prepare_history()
    for label, path in CASE_RECORDS.items():
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(path, 0o700)
        require(not list(path.iterdir()), "case record directory is not empty: " + label)
    adapter = load_adapter().GuestFixtureAdapter(
        unit_dir=UNIT_DIR, fixture_dir=FIXTURE, unit=UNIT,
        proof_root=PROOF_BIN, guest_only=True)
    fixture = prepare_fixture(adapter)
    initial = snapshot()
    baseline_value = {
        "commit": commit,
        "node_runtime": NODE_RUNTIME,
        "python_runtime": PYTHON_RUNTIME,
        "history_path": str(HISTORY_PATH),
        "history_sha256": history["sha256"],
        "record_paths": [str(path) for path in records()],
        "case_records": {label: str(path) for label, path in CASE_RECORDS.items()},
        "state": state_hashes(),
        "initial_snapshot": initial,
    }
    _write(BASELINE, json.dumps(baseline_value, indent=2, sort_keys=True) + "\n")
    return {"prepared": baseline_value, "fixture": fixture, "snapshot": initial}


def cli(command, extra, kill=None, record_dir=RECORDS):
    argv = [sys.executable, str(PROOF_BIN / "unit-switch.py"), command,
            "--root", str(CHECKOUT), "--record-dir", str(record_dir),
            "--unit", UNIT, "--fixture-dir", str(FIXTURE),
            "--proof-root", str(PROOF_BIN), "--proof-fixture"]
    argv.extend(extra)
    extra_env = {"CRQ_PROOF_KILL_ON": kill} if kill else None
    return run(argv, timeout=180, extra_env=extra_env)


def new_records(before_paths, record_dir=RECORDS):
    return [path for path in records_in(record_dir)
            if str(path) not in set(before_paths)]


def validate_completed(record, runtime, prior):
    require(record["outcome"] == "completed", "switch did not complete")
    require(record["phase"] == "activation_pending",
            "completed record has the wrong phase")
    require(record["unit"] == UNIT and record["runtime"] == runtime,
            "completed record runtime or unit mismatch")
    require(record["prior_runtime"] == prior,
            "completed record prior runtime mismatch")
    evidence = record.get("completions")
    require(isinstance(evidence, list) and len(evidence) == 2,
            "completed record does not carry exactly two completions")
    sequences = [item.get("sequence") for item in evidence]
    require(all(type(item) is int for item in sequences)
            and sequences[0] < sequences[1],
            "completion sequences are not strictly advancing")
    invocations = [item.get("invocation") for item in evidence]
    require(all(isinstance(item, str) and INVOCATION.fullmatch(item)
                for item in invocations), "completion invocation is invalid")
    require(len(set(invocations)) == 2, "completion invocations are not distinct")
    require(all(item.get("unit") == UNIT and item.get("runtime") == runtime
                and item.get("success") is True for item in evidence),
            "completion evidence is not unit/runtime bound")
    return {"sequences": sequences, "invocations": invocations}


def switch_phase(runtime):
    saved = baseline()
    before = snapshot()
    before_paths = [str(path) for path in records()]
    prior = saved["python_runtime"] if runtime == NODE_RUNTIME else saved["node_runtime"]
    result = cli("switch", ["--runtime", runtime])
    require(result["rc"] == 0,
            "switch CLI failed: " + (result["stderr"] or result["stdout"])[:800])
    try:
        payload = json.loads(result["stdout"])
    except ValueError as exc:
        raise RuntimeError("switch CLI did not emit JSON") from exc
    created = new_records(before_paths)
    require(len(created) == 1, "switch did not create exactly one journal record")
    record_path = created[0]
    record = json.loads(record_path.read_text())
    evidence = validate_completed(record, runtime, prior)
    systemctl("stop", TIMER)
    systemctl("reset-failed", TIMER)
    time.sleep(0.5)
    after = snapshot()
    check_preserved("switch")
    installed = load_adapter().GuestFixtureAdapter(
        unit_dir=UNIT_DIR, fixture_dir=FIXTURE, unit=UNIT,
        proof_root=PROOF_BIN, guest_only=True)._runtime_from_unit(SERVICE)
    require(installed == runtime, "installed unit runtime does not match the switch")
    records_after = [entry for entry in completions()
                     if entry.get("unit") == UNIT]
    require(records_after and records_after[-1].get("runtime") == runtime,
            "fixture completion log does not end at the requested runtime")
    return {"cli": {"rc": result["rc"],
                    "command": payload.get("command"),
                    "record": payload.get("record")},
            "record_path": str(record_path),
            "record": record_summary(record_path),
            "completions": evidence,
            "before": before, "after": after,
            "preserved": check_preserved("switch"),
            "installed_runtime": installed,
            "completions_seen": records_after}


def interrupt_phase(args):
    saved = baseline()
    before_paths = [str(path) for path in records()]
    before = snapshot()
    result = cli("switch", ["--runtime", NODE_RUNTIME], kill="install")
    require(result["rc"] not in (0, None),
            "interrupted switch unexpectedly returned success")
    created = new_records(before_paths)
    require(len(created) == 1, "interrupted switch did not leave one journal record")
    record_path = created[0]
    record = json.loads(record_path.read_text())
    require(record["outcome"] == "pending" and record["phase"] == "drained",
            "interrupted switch is not a preactivation drained record")
    require(record["runtime"] == NODE_RUNTIME
            and record["prior_runtime"] == saved["python_runtime"],
            "interrupted switch runtime identity is wrong")
    after = snapshot()
    check_preserved("interrupt")
    require(SERVICE.is_symlink() and os.readlink(SERVICE) == "/dev/null",
            "interrupted switch did not leave the durable service mask")
    timer = show(TIMER, ["ActiveState"])
    require(timer["ActiveState"] in ("inactive", "failed"),
            "interrupted switch left the timer activator active")
    return {"cli": result, "record_path": str(record_path),
            "record": record_summary(record_path),
            "before": before, "after": after,
            "preserved": check_preserved("interrupt")}


def recover_phase(args, kill=None, record_dir=RECORDS, label="recover"):
    record_path = pathlib.Path(args.record)
    before = record_summary(record_path)
    result = cli("recover", ["--record", str(record_path)], kill=kill,
                 record_dir=record_dir)
    after = record_summary(record_path)
    return {"cli": result, "record_before": before, "record_after": after,
            "preserved": check_preserved(label)}


def recover_kill_phase(args):
    payload = recover_phase(args, kill="drain")
    require(payload["cli"]["rc"] not in (0, None),
            "interrupted recovery unexpectedly returned success")
    require(payload["record_after"]["sha256"] == payload["record_before"]["sha256"],
            "interrupted recovery changed the retained record")
    require(payload["record_after"]["outcome"] == "pending"
            and payload["record_after"]["phase"] == "drained",
            "interrupted recovery did not retain the drained intent")
    return payload


def recovery_complete(record_path, record_dir, expected_prior, label):
    record_path = pathlib.Path(record_path)
    payload = recover_phase(type("Args", (), {"record": str(record_path)})(),
                            record_dir=record_dir, label=label)
    require(payload["cli"]["rc"] == 0,
            "recovery CLI failed: " + (payload["cli"]["stderr"] or
                                       payload["cli"]["stdout"])[:800])
    record = json.loads(record_path.read_text())
    require(record["outcome"] == "rolled_back"
            and record["phase"] == "restore_activation_pending",
            "completed recovery did not roll back")
    require(record["snapshot"]["runtime"] == expected_prior,
            "recovery snapshot does not name the expected prior runtime")
    state = file_state(SERVICE)
    expected = record["snapshot"]["paths"][str(SERVICE)]
    require(state["type"] == "file" and state["sha256"] == expected["sha256"]
            and state["mode"] == expected["mode"]
            and state["uid"] == expected["uid"] and state["gid"] == expected["gid"],
            "recovery did not restore exact service bytes and metadata")
    adapter = load_adapter().GuestFixtureAdapter(
        unit_dir=UNIT_DIR, fixture_dir=FIXTURE, unit=UNIT,
        proof_root=PROOF_BIN, guest_only=True)
    require(adapter._runtime_from_unit(SERVICE) == expected_prior,
            "recovery did not restore the prior runtime")
    staged = file_state(STAGED_SERVICE)
    require(staged["type"] == "missing",
            "completed recovery retained the staged service")
    timer = show(TIMER, ["ActiveState", "UnitFileState", "LoadState"])
    expected_timer = record["snapshot"]["activators"]
    require(timer["ActiveState"] == expected_timer["timer_active"]
            and timer["UnitFileState"] == expected_timer["timer_unit_file_state"],
            "recovery did not restore timer activation and enablement")
    return {"cli": payload["cli"], "record_before": payload["record_before"],
            "record_after": payload["record_after"],
            "record": record_summary(record_path),
            "restored": {"service": state, "runtime": expected_prior,
                         "timer": timer, "staged": staged},
            "after": snapshot(record_dir),
            "preserved": check_preserved(label)}


def recovery_repeat(record_path, record_dir, label):
    payload = recover_phase(type("Args", (), {"record": str(record_path)})(),
                            record_dir=record_dir, label=label)
    require(payload["cli"]["rc"] == 2,
            "repeated recovery did not refuse a rolled_back record")
    require("refused" in (payload["cli"].get("stdout") or ""),
            "repeated recovery refusal is not explicit")
    require(payload["record_after"]["sha256"] == payload["record_before"]["sha256"],
            "repeated recovery changed a rolled_back record")
    return payload


def recovery_refuse(record_path, record_dir, label):
    payload = recover_phase(type("Args", (), {"record": str(record_path)})(),
                            record_dir=record_dir, label=label)
    require(payload["cli"]["rc"] == 3,
            "ambiguous activation recovery did not require investigation")
    require(payload["record_after"]["sha256"] == payload["record_before"]["sha256"],
            "ambiguous activation recovery changed the retained record")
    require(payload["record_after"]["outcome"] == "pending"
            and payload["record_after"]["phase"] == "activation_pending",
            "ambiguous activation recovery did not retain the pending intent")
    return payload


def recover_complete_phase(args):
    saved = baseline()
    return recovery_complete(pathlib.Path(args.record), RECORDS,
                             saved["python_runtime"], "recover")


def recover_repeat_phase(args):
    return recovery_repeat(pathlib.Path(args.record), RECORDS, "recover")


def _observe_masked_service(label):
    require(SERVICE.is_symlink() and os.readlink(SERVICE) == "/dev/null",
            label + " lost the durable service mask")
    service = show(UNIT, ["LoadState", "ActiveState", "FragmentPath"])
    require(service["LoadState"] == "masked"
            and service["FragmentPath"] == str(SERVICE),
            label + " did not keep the service masked")
    direct = systemctl("start", UNIT)
    require(direct["rc"] not in (0, None),
            label + " accepted a direct start while masked")
    direct_text = ((direct.get("stdout") or "")
                   + (direct.get("stderr") or "")).lower()
    require("masked" in direct_text,
            label + " direct start refusal was not an explicit mask refusal: "
            + direct_text[:300])
    return service, direct


def rollback_fence_phase(args):
    saved = baseline()
    before = snapshot()
    before_paths = [str(path) for path in records()]
    switched = cli("switch", ["--runtime", NODE_RUNTIME], kill="install")
    require(switched["rc"] not in (0, None),
            "rollback fence switch unexpectedly returned success")
    created = new_records(before_paths)
    require(len(created) == 1,
            "rollback fence switch did not leave one journal record")
    record_path = created[0]
    record = json.loads(record_path.read_text())
    require(record["outcome"] == "pending" and record["phase"] == "drained",
            "rollback fence switch is not a preactivation drained record")
    require(record["runtime"] == NODE_RUNTIME
            and record["prior_runtime"] == saved["python_runtime"],
            "rollback fence switch runtime identity is wrong")
    record_before = record_summary(record_path)

    killed = cli("recover", ["--record", str(record_path)], kill="restore_staged")
    require(killed["rc"] not in (0, None),
            "rollback fence recovery unexpectedly returned success")
    record_after_kill = record_summary(record_path)
    require(record_after_kill["sha256"] == record_before["sha256"],
            "rollback fence kill changed the retained record")
    require(record_after_kill["outcome"] == "pending"
            and record_after_kill["phase"] == "drained",
            "rollback fence kill advanced beyond the drained intent")
    service, direct = _observe_masked_service("rollback fence")
    staged_state = file_state(STAGED_SERVICE)
    require(staged_state["type"] == "file",
            "rollback fence did not stage the prior service")
    adapter = load_adapter().GuestFixtureAdapter(
        unit_dir=UNIT_DIR, fixture_dir=FIXTURE, unit=UNIT,
        proof_root=PROOF_BIN, guest_only=True)
    staged_runtime = adapter._runtime_from_unit(STAGED_SERVICE)
    require(staged_runtime == saved["python_runtime"],
            "rollback fence staged the wrong prior runtime")
    after_kill = snapshot()
    require(len(after_kill["completions"]) == len(before["completions"]),
            "rollback fence released the staged service before the journal")

    completed = cli("recover", ["--record", str(record_path)])
    require(completed["rc"] == 0,
            "rollback fence completion failed: "
            + (completed.get("stderr") or completed.get("stdout") or "")[:800])
    record_completed = record_summary(record_path)
    require(record_completed["outcome"] == "rolled_back"
            and record_completed["phase"] == "restore_activation_pending",
            "rollback fence completion did not roll back")
    completed_record = json.loads(record_path.read_text())
    expected = completed_record["snapshot"]["paths"][str(SERVICE)]
    state = file_state(SERVICE)
    require(state["type"] == "file" and state["sha256"] == expected["sha256"]
            and state["mode"] == expected["mode"]
            and state["uid"] == expected["uid"] and state["gid"] == expected["gid"],
            "rollback fence completion did not restore exact service bytes")
    require(adapter._runtime_from_unit(SERVICE) == saved["python_runtime"],
            "rollback fence completion did not restore the prior runtime")
    staged_after_completion = file_state(STAGED_SERVICE)
    require(staged_after_completion["type"] == "missing",
            "rollback fence completion retained the staged service")
    timer = show(TIMER, ["ActiveState", "UnitFileState", "LoadState"])
    expected_timer = completed_record["snapshot"]["activators"]
    require(timer["ActiveState"] == expected_timer["timer_active"]
            and timer["UnitFileState"] == expected_timer["timer_unit_file_state"],
            "rollback fence completion did not restore timer state")
    after = snapshot()
    require(len(after["completions"]) == len(before["completions"]),
            "rollback fence completion started unexpected work")

    repeated = cli("recover", ["--record", str(record_path)])
    require(repeated["rc"] == 2,
            "rollback fence repeated recovery did not refuse")
    require("refused" in (repeated.get("stdout") or ""),
            "rollback fence repeated recovery refusal is not explicit")
    record_after_repeat = record_summary(record_path)
    require(record_after_repeat["sha256"] == record_completed["sha256"],
            "rollback fence repeated recovery changed the completed record")
    return {"cli": killed,
            "switch": switched,
            "record_path": str(record_path),
            "record": record_before,
            "record_after_kill": record_after_kill,
            "service": service,
            "direct_start": direct,
            "staged": {"path": str(STAGED_SERVICE),
                       "type": staged_state["type"],
                       "sha256": staged_state.get("sha256"),
                       "runtime": staged_runtime},
            "staged_after_completion": staged_after_completion,
            "completions_before": len(before["completions"]),
            "completions_after_kill": len(after_kill["completions"]),
            "recovery": completed,
            "record_completed": record_completed,
            "after": after,
            "repeat": repeated,
            "record_after_repeat": record_after_repeat,
            "preserved": check_preserved("rollback-fence")}


def fence_phase(args):
    saved = baseline()
    before = snapshot()
    before_paths = [str(path) for path in records()]
    result = cli("switch", ["--runtime", NODE_RUNTIME], kill="start")
    require(result["rc"] not in (0, None),
            "fence probe switch unexpectedly returned success")
    created = new_records(before_paths)
    require(len(created) == 1, "fence probe did not leave one journal record")
    record_path = created[0]
    record = json.loads(record_path.read_text())
    require(record["outcome"] == "pending"
            and record["phase"] == "activation_pending",
            "fence probe did not retain activation ambiguity")
    require(record["runtime"] == NODE_RUNTIME
            and record["prior_runtime"] == saved["python_runtime"],
            "fence probe runtime identity is wrong")
    after = snapshot()
    require(SERVICE.is_symlink() and os.readlink(SERVICE) == "/dev/null",
            "fence probe lost the durable service mask before release")
    service = show(UNIT, ["LoadState", "ActiveState", "FragmentPath"])
    require(service["LoadState"] == "masked"
            and service["FragmentPath"] == str(SERVICE),
            "fence probe did not leave the service masked")
    timer = show(TIMER, ["ActiveState", "LoadState"])
    require(timer["LoadState"] == "loaded"
            and timer["ActiveState"] in ("inactive", "failed"),
            "fence probe left the timer activator active")
    direct = systemctl("start", UNIT)
    require(direct["rc"] not in (0, None),
            "masked service accepted a direct start during activation ambiguity")
    direct_text = ((direct.get("stdout") or "") + (direct.get("stderr") or "")).lower()
    require("masked" in direct_text,
            "direct start refusal was not an explicit mask refusal: "
            + direct_text[:300])
    require(STAGED_SERVICE.is_file() and not STAGED_SERVICE.is_symlink(),
            "fence probe did not stage the target behind the mask")
    adapter = load_adapter().GuestFixtureAdapter(
        unit_dir=UNIT_DIR, fixture_dir=FIXTURE, unit=UNIT,
        proof_root=PROOF_BIN, guest_only=True)
    require(adapter._runtime_from_unit(STAGED_SERVICE) == NODE_RUNTIME,
            "fence probe staged the wrong target runtime")
    require(len(after["completions"]) == len(before["completions"]),
            "fence probe target ran behind the durable mask")
    record_before = record_summary(record_path)
    recovered = cli("recover", ["--record", str(record_path)])
    require(recovered["rc"] == 3,
            "ambiguous fence recovery did not require investigation")
    record_after = record_summary(record_path)
    require(record_after["sha256"] == record_before["sha256"],
            "refused ambiguous recovery changed the retained record")
    return {"cli": result, "record_path": str(record_path),
            "record": record_before, "record_after_refusal": record_after,
            "recovery": recovered, "direct_start": direct,
            "service": service, "timer": timer,
            "staged": {"path": str(STAGED_SERVICE),
                       "runtime": adapter._runtime_from_unit(STAGED_SERVICE)},
            "completions_before": len(before["completions"]),
            "completions_after": len(after["completions"]),
            "before": before, "after": after,
            "preserved": check_preserved("fence")}


def host_identity_phase(args):
    return {"hostname": os.uname().nodename, "uid": os.getuid(),
            "boot_id": pathlib.Path(
                "/proc/sys/kernel/random/boot_id").read_text().strip(),
            "manager": manager_identity()}


def _matrix_adapter():
    return load_adapter().GuestFixtureAdapter(
        unit_dir=UNIT_DIR, fixture_dir=FIXTURE, unit=UNIT,
        proof_root=PROOF_BIN, guest_only=True)


def _expected_staged(spec):
    if spec["boundary"] == "drained":
        return {"type": "missing"}
    if spec["boundary"] == "restore_staged":
        return {"type": "file", "runtime": spec["prior_runtime"]}
    return {"type": "file", "runtime": spec["runtime"]}


def _assert_staged(spec, label):
    staged = file_state(STAGED_SERVICE)
    expected = _expected_staged(spec)
    require(staged["type"] == expected["type"],
            label + " staged service type is wrong: " + staged["type"])
    if expected["type"] == "file":
        runtime = _matrix_adapter()._runtime_from_unit(STAGED_SERVICE)
        require(runtime == expected["runtime"],
                label + " staged the wrong runtime: " + runtime)
        return {**staged, "runtime": runtime}
    return staged


def _owned_work(label):
    adapter = _matrix_adapter()
    owned = adapter._cgroup_pids(UNIT)
    require(owned["main_pid"] == 0 and not owned["pids"],
            label + " left owned unit work alive")
    return {"owned": owned, "jobs": adapter._jobs_for([UNIT, TIMER])}


def matrix_boundary_phase(args):
    spec = MATRIX_CASES[args.phase]
    record_dir = spec["record_dir"]
    adapter = _matrix_adapter()
    require(adapter._runtime_from_unit(SERVICE) == spec["prior_runtime"],
            args.phase + " fixture is not at the expected prior runtime")
    before = snapshot(record_dir)
    before_paths = [str(path) for path in records_in(record_dir)]
    kill_at = "start" if spec["boundary"] == "activation_pending" else "install"
    switched = cli("switch", ["--runtime", spec["runtime"]], kill=kill_at,
                   record_dir=record_dir)
    require(switched["rc"] not in (0, None),
            args.phase + " switch unexpectedly returned success")
    created = new_records(before_paths, record_dir)
    require(len(created) == 1,
            args.phase + " did not leave exactly one journal record")
    record_path = created[0]
    record = json.loads(record_path.read_text())
    expected_phase = ("activation_pending"
                      if spec["boundary"] == "activation_pending"
                      else "drained")
    require(record["outcome"] == "pending"
            and record["phase"] == expected_phase,
            args.phase + " did not retain the expected preactivation intent")
    require(record["runtime"] == spec["runtime"]
            and record["prior_runtime"] == spec["prior_runtime"],
            args.phase + " runtime identity is wrong")
    killed = None
    if spec["boundary"] == "restore_staged":
        killed = cli("recover", ["--record", str(record_path)],
                     kill="restore_staged", record_dir=record_dir)
        require(killed["rc"] not in (0, None),
                args.phase + " restore unexpectedly returned success")
        record = json.loads(record_path.read_text())
        require(record["outcome"] == "pending"
                and record["phase"] == "drained",
                args.phase + " restore kill advanced beyond the drained intent")
    after = snapshot(record_dir)
    service, direct = _observe_masked_service(args.phase)
    timer = show(TIMER, ["ActiveState", "LoadState"])
    require(timer["ActiveState"] in ("inactive", "failed"),
            args.phase + " left the timer activator active")
    staged = _assert_staged(spec, args.phase)
    require(len(after["completions"]) == len(before["completions"]),
            args.phase + " released work behind the durable mask")
    owned = _owned_work(args.phase)
    return {"case": args.phase, "kind": spec["kind"],
            "boundary": spec["boundary"], "runtime": spec["runtime"],
            "prior_runtime": spec["prior_runtime"],
            "record_dir": str(record_dir),
            "record_path": str(record_path),
            "record": record_summary(record_path), "cli": switched,
            "recovery_kill": killed, "snapshot": after, "before": before,
            "metadata": metadata_state(),
            "fence": {"service": service, "direct_start": direct,
                      "timer": timer},
            "staged": staged, "owned": owned["owned"], "jobs": owned["jobs"],
            "completions_before": len(before["completions"]),
            "completions_after": len(after["completions"]),
            "preserved": check_preserved(args.phase)}


def matrix_observe_phase(args):
    spec = MATRIX_CASES[args.boundary]
    record_dir = spec["record_dir"]
    boundary = json.loads((PHASE_DIR / (args.boundary + ".json")).read_text())
    require(boundary.get("case") == args.boundary,
            "boundary phase evidence does not match the requested case")
    after = snapshot(record_dir)
    before_snapshot = boundary["snapshot"]
    identity = {
        "boot_id_before": before_snapshot["boot_id"],
        "boot_id_after": after["boot_id"],
        "boot_id_changed": before_snapshot["boot_id"] != after["boot_id"],
        "manager_before": before_snapshot["manager"],
        "manager_after": after["manager"],
        "manager_changed": (before_snapshot["manager"]["invocation_id"]
                            != after["manager"]["invocation_id"]),
    }
    if spec["kind"] == "manager":
        require(not identity["boot_id_changed"],
                args.phase + " observed a boot ID change across a manager restart")
    else:
        require(identity["boot_id_changed"],
                args.phase + " did not observe a changed boot ID across reboot")
    require(identity["manager_changed"],
            args.phase + " did not observe a changed user-manager identity")
    record_path = pathlib.Path(boundary["record_path"])
    record_before = boundary["record"]
    record_after = record_summary(record_path)
    require(record_after["sha256"] == record_before["sha256"],
            args.phase + " changed the retained journal record")
    require(record_after["outcome"] == record_before["outcome"]
            and record_after["phase"] == record_before["phase"],
            args.phase + " advanced the retained journal phase")
    metadata_after = metadata_state()
    metadata_match = metadata_after == boundary["metadata"]
    require(metadata_match,
            args.phase + " changed retained path bytes or metadata")
    service, direct = _observe_masked_service(args.phase)
    staged = _assert_staged(spec, args.phase)
    require(staged == boundary["staged"],
            args.phase + " changed the staged service across the boundary")
    require(len(after["completions"]) == boundary["completions_after"],
            args.phase + " observed unrecorded completion work")
    owned = _owned_work(args.phase)
    preserved = check_preserved(args.phase)
    if spec["boundary"] in ("drained", "restore_staged"):
        recovery = recovery_complete(record_path, record_dir,
                                     spec["prior_runtime"], args.phase)
        repeat = recovery_repeat(record_path, record_dir, args.phase)
    else:
        recovery = recovery_refuse(record_path, record_dir, args.phase)
        repeat = recovery_refuse(record_path, record_dir, args.phase)
    return {"case": args.boundary, "kind": spec["kind"],
            "boundary": spec["boundary"], "runtime": spec["runtime"],
            "prior_runtime": spec["prior_runtime"],
            "record_dir": str(record_dir),
            "record_path": str(record_path),
            "record_before": record_before, "record_after": record_after,
            "snapshot": after, "before": before_snapshot,
            "identity": identity, "metadata": metadata_after,
            "metadata_match": metadata_match,
            "fence": {"service": service, "direct_start": direct},
            "staged": staged, "owned": owned["owned"], "jobs": owned["jobs"],
            "completions_before": boundary["completions_after"],
            "completions_after": len(after["completions"]),
            "preserved": preserved,
            "recovery": recovery, "repeat": repeat}


def reset_fixture_phase(args):
    observe = json.loads((PHASE_DIR / (args.after + ".json")).read_text())
    record_path = pathlib.Path(observe["record_path"])
    record_before = record_summary(record_path)
    require(record_before["sha256"] == observe["record_after"]["sha256"],
            args.phase + " found a changed ambiguity record before reset")
    runtime = args.runtime or PYTHON_RUNTIME
    adapter = _matrix_adapter()
    before = snapshot(RECORDS)
    systemctl("stop", TIMER)
    systemctl("reset-failed", TIMER)
    systemctl("stop", UNIT)
    systemctl("reset-failed", UNIT)
    for path in (SERVICE, TIMER_PATH, WANTS, STAGED_SERVICE):
        if path.is_symlink() or path.exists():
            path.unlink()
    _write(SERVICE, adapter.render_unit(runtime), 0o644)
    _write(TIMER_PATH, adapter.render_timer(), 0o644)
    WANTS.symlink_to("../" + TIMER)
    result = systemctl("daemon-reload")
    require(result["rc"] == 0,
            args.phase + " fixture reset daemon-reload failed")
    service = show(UNIT, ["LoadState", "ActiveState"])
    timer = show(TIMER, ["LoadState", "ActiveState", "UnitFileState"])
    require(service["LoadState"] == "loaded"
            and service["ActiveState"] == "inactive",
            args.phase + " fixture reset did not load an inactive service")
    require(timer["ActiveState"] == "inactive"
            and timer["UnitFileState"] == "enabled",
            args.phase + " fixture reset did not restore an enabled inactive timer")
    after = snapshot(RECORDS)
    require(len(after["completions"]) == len(before["completions"]),
            args.phase + " fixture reset started work")
    record_after = record_summary(record_path)
    require(record_after["sha256"] == record_before["sha256"],
            args.phase + " fixture reset changed the retained ambiguity record")
    return {"after_phase": args.after, "record_path": str(record_path),
            "record_dir": observe.get("record_dir"),
            "record_before": record_before, "record_after": record_after,
            "runtime": runtime, "service": service, "timer": timer,
            "before": before, "after": after,
            "preserved": check_preserved(args.phase)}


def main(argv=None):
    phases = ("prepare", "switch-node", "switch-python", "interrupt",
              "recover-kill", "recover", "recover-repeat", "rollback-fence",
              "inspect", "fence", "host-identity", "matrix-switch-node",
              "matrix-reset-python", "matrix-reset-python-final",
              *MATRIX_CASES.keys(),
              *(name + "-observe" for name in MATRIX_CASES))
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=phases)
    parser.add_argument("--record")
    parser.add_argument("--boundary")
    parser.add_argument("--kind", choices=("manager", "reboot"))
    parser.add_argument("--after")
    parser.add_argument("--runtime", choices=(PYTHON_RUNTIME, NODE_RUNTIME))
    parser.add_argument("--label")
    args = parser.parse_args(argv)
    try:
        if args.phase == "prepare":
            payload = phase_prepare(args)
        elif args.phase == "switch-node":
            payload = switch_phase(NODE_RUNTIME)
        elif args.phase == "switch-python":
            payload = switch_phase(PYTHON_RUNTIME)
        elif args.phase == "interrupt":
            payload = interrupt_phase(args)
        elif args.phase == "recover-kill":
            payload = recover_kill_phase(args)
        elif args.phase == "recover":
            payload = recover_complete_phase(args)
        elif args.phase == "recover-repeat":
            payload = recover_repeat_phase(args)
        elif args.phase == "rollback-fence":
            payload = rollback_fence_phase(args)
        elif args.phase == "fence":
            payload = fence_phase(args)
        elif args.phase == "host-identity":
            payload = host_identity_phase(args)
        elif args.phase == "matrix-switch-node":
            payload = switch_phase(NODE_RUNTIME)
        elif args.phase in ("matrix-reset-python", "matrix-reset-python-final"):
            payload = reset_fixture_phase(args)
        elif args.phase in MATRIX_CASES:
            payload = matrix_boundary_phase(args)
        elif args.phase.endswith("-observe") \
                and args.phase[:-len("-observe")] in MATRIX_CASES:
            payload = matrix_observe_phase(args)
        else:
            payload = {"snapshot": snapshot()}
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
