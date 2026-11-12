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
import tarfile
import time

HOME = pathlib.Path.home()
UNIT_DIR = HOME / ".config/systemd/user"
FIXTURE = HOME / "fixture"
PROOF_BIN = HOME / "proof-bin"
CHECKOUT = HOME / "checkout"
RUNNER_ROOT = CHECKOUT / "apps/crq-python"
RUNNER_ARCHIVE = PROOF_BIN / "crq-runner-source.tar.gz"
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
GROUP_OWNER_MARKER = "foreground-v1"
DRAIN_RUN_IDS = {
    "alive": "e" * 32,
    "ambiguous": "f" * 32,
    "harvest": "1" * 32,
}
DRAIN_ITEM_IDS = {
    "alive": "drain-alive",
    "ambiguous": "drain-ambiguous",
    "harvest": "drain-harvest",
}

# Second harmless fixture topology for the activation-inventory fence proof.
# It is a declared guest topology, not exhaustive production activator
# discovery.
REPAIR_UNIT = "crq-repair.service"
REPAIR_TIMER = "crq-repair.timer"
REPAIR_PATH_UNIT = "crq-repair.path"
REPAIR_COMPLETIONS = FIXTURE / "completions-crq-repair.jsonl"
REPAIR_SERVICE = UNIT_DIR / REPAIR_UNIT
REPAIR_TIMER_PATH = UNIT_DIR / REPAIR_TIMER
REPAIR_PATH_PATH = UNIT_DIR / REPAIR_PATH_UNIT
REPAIR_TIMER_WANTS = UNIT_DIR / "timers.target.wants" / REPAIR_TIMER
REPAIR_PATH_WANTS = UNIT_DIR / "default.target.wants" / REPAIR_PATH_UNIT
REPAIR_DROPIN_DIR = UNIT_DIR / (REPAIR_UNIT + ".d")
REPAIR_DROPIN = REPAIR_DROPIN_DIR / "10-fence-proof.conf"
REPAIR_STAGED = UNIT_DIR / ("." + REPAIR_UNIT + ".staged")
REPAIR_TRIGGER = FIXTURE / "repair-path-trigger"
REPAIR_RECORDS = HOME / "records-activators"
REPAIR_PAUSE_MARKER = FIXTURE / "activators-pause.json"
CALLER_UNIT = "crq-probe-caller.service"
BLOCKER_UNIT = "crq-probe-blocker.service"
CALLER_PATH = UNIT_DIR / CALLER_UNIT
BLOCKER_PATH = UNIT_DIR / BLOCKER_UNIT
ACTIVATOR_UNITS = (REPAIR_UNIT, REPAIR_TIMER, REPAIR_PATH_UNIT,
                   CALLER_UNIT, BLOCKER_UNIT)
ACTIVATOR_PHASES = ("activators-install", "activators-positive",
                    "activators-unknown", "activators-fence",
                    "activators-switch-back", "activators-interrupt",
                    "activators-recover", "activators-repeat",
                    "activators-inspect")

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


def _starttime(pid):
    try:
        text = (pathlib.Path("/proc") / str(pid) / "stat").read_text()
    except OSError:
        return None
    # The comm field may contain spaces and parentheses; fields after the
    # final ')' begin at state (field 3), so starttime (field 22) is index 19.
    tail = text.rsplit(")", 1)[1].split()
    return tail[19] if len(tail) > 19 else None


def process_state(pid):
    """Observed identity/liveness for one guest PID, by exact /proc identity."""
    state = {"pid": pid, "alive": False, "cmdline": "", "starttime": None}
    if not isinstance(pid, int) or pid <= 0:
        return state
    try:
        raw = (pathlib.Path("/proc") / str(pid) / "cmdline").read_bytes()
    except OSError:
        return state
    state["alive"] = True
    state["cmdline"] = raw.replace(b"\0", b" ").decode("utf-8", "replace").strip()
    state["starttime"] = _starttime(pid)
    try:
        state["pgid"] = os.getpgid(pid)
        state["sid"] = os.getsid(pid)
    except OSError:
        state["pgid"] = None
        state["sid"] = None
    return state


def spawn_detached(marker, seconds=600):
    """Spawn a harmless detached session leader whose argv carries the marker.

    ``setsid`` runs in the Popen child (not a process-group leader), so the
    child becomes its own session and process group: pid == pgid == sid. That
    is the managed identity shape the runner records for a detached review.
    Python, not ``sleep``, carries the marker: ``sleep 600 marker`` would treat
    the marker as a second interval and exit immediately.
    """
    require(shutil.which("setsid") is not None, "setsid is required")
    proc = subprocess.Popen(
        ["setsid", sys.executable, "-c",
         "import time; time.sleep(%s)" % seconds, marker],
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    deadline = time.time() + 5
    state = process_state(proc.pid)
    while time.time() < deadline and not (
            state["alive"] and marker in state["cmdline"]
            and state["pgid"] == proc.pid and state["sid"] == proc.pid):
        time.sleep(0.02)
        state = process_state(proc.pid)
    require(state["alive"] and marker in state["cmdline"],
            "detached process did not start with the marker")
    require(state["pgid"] == proc.pid and state["sid"] == proc.pid,
            "detached process did not become its own session/group leader")
    return proc, state


def spawn_exited(marker):
    """Spawn and reap a harmless detached process; return its recorded identity."""
    proc = subprocess.Popen(
        ["setsid", sys.executable, "-c",
         "import time; time.sleep(0.2)", marker],
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    deadline = time.time() + 5
    state = process_state(proc.pid)
    while time.time() < deadline and not state["alive"]:
        time.sleep(0.01)
        state = process_state(proc.pid)
    require(state["alive"], "harvest process did not start")
    starttime = state.get("starttime")
    proc.wait(timeout=10)
    state = process_state(proc.pid)
    require(not state["alive"], "detached harvest process did not exit")
    try:
        os.killpg(proc.pid, 0)
    except ProcessLookupError:
        pass
    else:
        raise RuntimeError("harvest process group survived its process")
    return {"pid": proc.pid, "starttime": starttime}


def stop_process(proc):
    """Harness cleanup only. The controller never signals any process."""
    if proc is None:
        return {"terminated": True, "controller_signalled": False}
    before = process_state(proc.pid)
    if before["alive"]:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
    after = process_state(proc.pid)
    require(not after["alive"], "harness cleanup did not stop a seeded process")
    return {"before": before, "after": after, "terminated": True,
            "controller_signalled": False}


def load_controller():
    spec = importlib.util.spec_from_file_location(
        "crq_deploy_controller", PROOF_BIN / "deploy-controller.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def runner_effects():
    return load_controller().Effects(CHECKOUT, RECORDS)


def write_run_identity(run_id, pid, *, group_owner=GROUP_OWNER_MARKER,
                       has_exit=False, starttime=None):
    rdir = STATE / "runs" / run_id
    rdir.mkdir(parents=True, exist_ok=True)
    identity = {"run_id": run_id, "pid": pid, "ppid": os.getpid(),
                "pgid": pid, "sid": pid, "group_owner": group_owner,
                "starttime": starttime}
    (rdir / "review.pid").write_text(
        json.dumps(identity, sort_keys=True) + "\n")
    if has_exit:
        (rdir / "exit.json").write_text(
            json.dumps({"exit": 0, "ended_at": "2026-01-01T00:00:00Z"},
                       sort_keys=True) + "\n")
    return {"path": str(rdir), "identity": identity,
            "exit": has_exit}


def item_liveness(item):
    """The actual controller/runner liveness result for one recorded item."""
    run = item.get("run")
    require(isinstance(run, dict) and isinstance(run.get("run_id"), str),
            "liveness evidence requires a recorded run")
    effects = runner_effects()
    rdir = effects.state_dir() / "runs" / run["run_id"]
    has_exit = (rdir / "exit.json").exists()
    state = load_controller()._runner_liveness(effects)(
        rdir, item, run, has_exit)
    return {"item": item.get("id"), "run_id": run["run_id"],
            "has_exit": has_exit, "state": state}


def queue_bytes():
    return (STATE / "queue.json").read_bytes()


def seed_drain_work(kind):
    """Create one recorded run with genuinely shaped runner metadata."""
    require(kind in DRAIN_RUN_IDS, "unknown drain seed kind")
    run_id = DRAIN_RUN_IDS[kind]
    marker = "crq-drain-" + run_id
    proc = None
    if kind == "alive":
        proc, state = spawn_detached(marker)
        identity = write_run_identity(run_id, proc.pid,
                                      starttime=state.get("starttime"))
        run = {"run_id": run_id, "pid": proc.pid}
    elif kind == "ambiguous":
        # The queue records a run but the ownership evidence is incomplete:
        # no pidfile, no recorded pid and no terminal artifact. The runner's
        # fail-closed liveness retains it as ambiguous. A process whose
        # ownership is not represented by metadata is deliberately NOT claimed
        # as detected here (see the report limitations).
        rdir = STATE / "runs" / run_id
        rdir.mkdir(parents=True, exist_ok=True)
        state = {"pid": None, "starttime": None}
        identity = {"path": str(rdir), "identity": None, "exit": False}
        run = {"run_id": run_id}
    else:
        state = spawn_exited(marker)
        identity = write_run_identity(run_id, state["pid"], has_exit=True,
                                      starttime=state.get("starttime"))
        run = {"run_id": run_id}
    item = {"id": DRAIN_ITEM_IDS[kind], "state": "reviewing", "run": run}
    return {"kind": kind, "run_id": run_id, "item": item, "process": proc,
            "process_state": process_state(proc.pid) if proc else state,
            "identity": identity,
            "expected_kind": {"alive": "alive", "ambiguous": "ambiguous",
                              "harvest": "harvest"}[kind]}


def seed_queue(items):
    saved = queue_bytes()
    queue = json.loads(saved)
    require(isinstance(queue, dict), "queue root is not an object")
    queue["items"] = list(queue.get("items", [])) + list(items)
    _write(STATE / "queue.json", json.dumps(queue, indent=2, sort_keys=True) + "\n")
    return saved


def restore_queue(saved):
    (STATE / "queue.json").write_bytes(saved)


def remove_drain_runs():
    for run_id in DRAIN_RUN_IDS.values():
        shutil.rmtree(STATE / "runs" / run_id, ignore_errors=True)


def drain_observation():
    """The actual controller drain_check bound to the actual runner liveness."""
    dc = load_controller()
    return dc.runner_queue_drain(dc.Effects(CHECKOUT, RECORDS))


def extract_runner_source(archive):
    """Extract the exact committed runner source into the throwaway checkout."""
    archive = pathlib.Path(archive)
    require(archive.is_file() and not archive.is_symlink(),
            "runner source archive is missing or a symlink")
    digest = sha256_file(archive)
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        require(members, "runner source archive is empty")
        for member in members:
            parts = pathlib.PurePosixPath(member.name).parts
            if member.name == "apps" and member.isdir():
                continue  # git archive's parent directory entry
            require(parts and parts[0] == "apps" and len(parts) > 1,
                    "runner archive member escapes apps/: " + member.name)
            require(".." not in parts and not member.name.startswith("/"),
                    "runner archive contains an unsafe path")
            require(member.isfile() or member.isdir(),
                    "runner archive contains a non-file member: " + member.name)
        tar.extractall(CHECKOUT, filter="data")
    require((RUNNER_ROOT / "crq.py").is_file(),
            "runner archive did not provide crq.py")
    require((RUNNER_ROOT / "author_quota.py").is_file(),
            "runner archive did not provide author_quota.py")
    return {"sha256": digest, "bytes": archive.stat().st_size,
            "crq_sha256": sha256_file(RUNNER_ROOT / "crq.py")}


def env():
    values = dict(os.environ)
    values["XDG_RUNTIME_DIR"] = "/run/user/%d" % os.getuid()
    return values


def run(argv, timeout=120, extra_env=None, max_output=12000):
    values = env()
    if extra_env:
        values.update(extra_env)
    try:
        result = subprocess.run(argv, capture_output=True, text=True,
                                timeout=timeout, env=values)
        return {"argv": [str(item) for item in argv], "rc": result.returncode,
                "stdout": result.stdout[-max_output:],
                "stderr": result.stderr[-max_output:], "timeout": False}
    except subprocess.TimeoutExpired as exc:
        return {"argv": [str(item) for item in argv], "rc": None,
                "stdout": _text_output(exc.stdout)[-max_output:],
                "stderr": _text_output(exc.stderr)[-max_output:], "timeout": True}


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


def jobs_observation():
    result = run(["systemctl", "--user", "list-jobs", "--no-legend",
                  "--no-pager"], timeout=30)
    lines = [line for line in (result.get("stdout") or "").splitlines()
             if line.strip()]
    return {"command": result, "lines": lines}


def jobs():
    observation = jobs_observation()
    result = observation["command"]
    require(not result["timeout"] and result["rc"] == 0,
            "list-jobs failed; job absence is unknown")
    return observation["lines"]


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
    return [RECORDS, *CASE_RECORDS.values(), REPAIR_RECORDS]


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


def check_preserved_expected(expected_state, label):
    """Preservation against a phase-local seeded queue, not the prepare baseline."""
    observed = state_hashes()
    require(observed == expected_state,
            label + " changed the seeded queue/heartbeat bytes")
    saved = baseline()
    require(HISTORY_PATH.exists()
            and sha256_file(HISTORY_PATH) == saved["history_sha256"],
            label + " changed the historical completed record")
    require(set(str(path) for path in records()) >= set(saved["record_paths"]),
            label + " lost a historical record")
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
    STATE.mkdir(parents=True)
    _write(CHECKOUT / ".gitignore", "apps/crq-python/state/\n")
    runner_source = extract_runner_source(RUNNER_ARCHIVE)
    _write(STATE / "queue.json",
           json.dumps({"items": [], "version": "proof-vehicle"}, indent=2) + "\n")
    _write(STATE / "heartbeat.json",
           json.dumps({"last_tick": "2026-01-01T00:00:00Z"}, indent=2) + "\n")
    for command in (("init", "-q"), ("config", "user.email", "proof@example.invalid"),
                    ("config", "user.name", "Proof Fixture"), ("add", "."),
                    ("commit", "-qm", "isolated proof baseline")):
        git(*command)
    return git("rev-parse", "HEAD"), runner_source


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
        "snapshot": {"proof": "historical"},
        "state": {
            "prior_head": "0" * 40,
            "prior_config_sha256": None,
            "checkout_status": "clean",
            "units": {UNIT: PYTHON_RUNTIME},
            "preserved/queue.json": "0" * 64,
            "preserved/heartbeat.json": "0" * 64,
        },
        "phase": "activation_pending",
        "completions": [
            {"unit": UNIT, "runtime": NODE_RUNTIME,
             "success": True, "sequence": 1},
            {"unit": UNIT, "runtime": NODE_RUNTIME,
             "success": True, "sequence": 2},
        ],
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
                "unit-switch-fixture.mjs", "crq-runner-source.tar.gz"]
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
    commit, runner_source = prepare_checkout()
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
        "runner_source": runner_source,
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


def completion_baseline(entries):
    """Completion-log state already recorded before a switch runs."""
    return {"max_sequence": max((item.get("sequence", 0) for item in entries),
                                default=0),
            "invocations": set(item.get("invocation") for item in entries)}


def validate_completed(record, runtime, prior, baseline):
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
            and sequences[0] < sequences[1]
            and min(sequences) > baseline["max_sequence"],
            "completion sequences are not strictly advancing")
    invocations = [item.get("invocation") for item in evidence]
    require(all(isinstance(item, str) and INVOCATION.fullmatch(item)
                for item in invocations), "completion invocation is invalid")
    require(len(set(invocations)) == 2, "completion invocations are not distinct")
    require(not set(invocations) & baseline["invocations"],
            "completion invocations were already recorded before the switch")
    require(all(item.get("unit") == UNIT and item.get("runtime") == runtime
                and item.get("success") is True for item in evidence),
            "completion evidence is not unit/runtime bound")
    return {"sequences": sequences, "invocations": invocations}


def switch_phase(runtime):
    saved = baseline()
    before = snapshot()
    completions_baseline = completion_baseline(before["completions"])
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
    evidence = validate_completed(record, runtime, prior, completions_baseline)
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


def drain_refuse_phase(args):
    """Attempt a real switch with live/ambiguous recorded work and require refusal."""
    kind = args.seed
    require(kind in ("alive", "ambiguous"),
            "drain refusal seed must be alive or ambiguous")
    target = args.runtime
    saved = baseline()
    adapter = load_adapter().GuestFixtureAdapter(
        unit_dir=UNIT_DIR, fixture_dir=FIXTURE, unit=UNIT,
        proof_root=PROOF_BIN, guest_only=True)
    current = adapter._runtime_from_unit(SERVICE)
    require(target in (PYTHON_RUNTIME, NODE_RUNTIME) and target != current,
            "drain refusal target must differ from the installed runtime")
    saved_queue = queue_bytes()
    before_paths = [str(path) for path in records()]
    seeded = seed_drain_work(kind)
    unrelated, unrelated_state = spawn_detached("crq-drain-unrelated")
    cleanup = []
    try:
        seed_queue([seeded["item"],
                    {"id": "drain-terminal", "state": "done"}])
        seeded_sha = sha256_file(STATE / "queue.json")
        liveness = item_liveness(seeded["item"])
        require(liveness["state"] == seeded["expected_kind"],
                "seeded run has unexpected liveness: " + liveness["state"])
        observation = drain_observation()
        require(observation["drained"] is False,
                "drain erroneously reported the seeded run absent")
        blocked = {entry.get("run"): entry
                   for entry in observation["blocked"] if entry.get("run")}
        require(blocked.get(seeded["run_id"], {}).get("state")
                == seeded["expected_kind"],
                "drain did not classify the seeded run as expected")
        before_cli = snapshot()
        result = cli("switch", ["--runtime", target])
        require(result["rc"] == 2,
                "drain refusal switch did not refuse: "
                + (result.get("stdout") or result.get("stderr") or "")[:800])
        try:
            payload = json.loads(result["stdout"])
        except ValueError as exc:
            raise RuntimeError("drain refusal CLI did not emit JSON") from exc
        require("queue-owned work" in (payload.get("refused") or ""),
                "drain refusal message is not explicit")
        require(payload.get("drain", {}).get("blocked") == observation["blocked"],
                "CLI drain evidence does not match the controller observation")
        after_cli = snapshot()
        require(sha256_file(STATE / "queue.json") == seeded_sha,
                "refused switch changed the seeded queue bytes")
        require([str(path) for path in records()] == before_paths,
                "refused switch created a journal record")
        require(after_cli["completions"] == before_cli["completions"],
                "refused switch ran work")
        require(after_cli["metadata"] == before_cli["metadata"],
                "refused switch changed installed unit metadata")
        require(after_cli["units"] == before_cli["units"],
                "refused switch changed unit activation state")
        owned_after = (process_state(seeded["process"].pid)
                       if seeded["process"] is not None else None)
        if owned_after is not None:
            require(owned_after["alive"],
                    "controller signalled the alive seeded process")
            require(owned_after["starttime"]
                    == seeded["process_state"].get("starttime"),
                    "alive seeded process identity changed")
        unrelated_after = process_state(unrelated.pid)
        require(unrelated_after["alive"],
                "controller signalled unrelated guest work")
        require(unrelated_after["starttime"] == unrelated_state.get("starttime"),
                "unrelated guest process identity changed")
        result = {
            "kind": kind, "target_runtime": target,
            "current_runtime": current,
            "cli": {"rc": result["rc"],
                    "stdout": result["stdout"],
                    "stderr": result["stderr"]},
            "refused": payload.get("refused"),
            "drain": payload.get("drain"),
            "observation": observation,
            "liveness": [liveness],
            "seeded": {"run_id": seeded["run_id"],
                       "item": seeded["item"],
                       "identity": seeded["identity"],
                       "process": seeded["process_state"]},
            "queue": {"before_sha256": seeded_sha,
                      "after_sha256": sha256_file(STATE / "queue.json"),
                      "baseline_sha256": sha256_bytes(saved_queue)},
            "records_before": before_paths,
            "records_after": [str(path) for path in records()],
            "completions_before": len(before_cli["completions"]),
            "completions_after": len(after_cli["completions"]),
            "before": before_cli, "after": after_cli,
            "processes": {"owned": owned_after,
                          "unrelated": {"before": unrelated_state,
                                        "after": unrelated_after}},
        }
    finally:
        cleanup.append(stop_process(seeded["process"]))
        cleanup.append(stop_process(unrelated))
        restore_queue(saved_queue)
        remove_drain_runs()
    require(state_hashes() == saved["state"],
            "drain refusal cleanup did not restore the baseline queue")
    result["cleanup"] = cleanup
    result["queue"]["restored_sha256"] = sha256_file(STATE / "queue.json")
    result["baseline_restored"] = state_hashes() == saved["state"]
    return result


def drain_harvest_phase(args):
    """Proceed through real switches with only completed/dead and terminal work."""
    saved = baseline()
    saved_queue = queue_bytes()
    before_paths = [str(path) for path in records()]
    seeded = seed_drain_work("harvest")
    unrelated, unrelated_state = spawn_detached("crq-drain-unrelated")
    cleanup = []
    try:
        seed_queue([seeded["item"],
                    {"id": "drain-terminal", "state": "done"}])
        seeded_sha = sha256_file(STATE / "queue.json")
        seeded_hashes = state_hashes()
        liveness = item_liveness(seeded["item"])
        require(liveness["state"] == "harvest",
                "completed/dead run is not harvest: " + liveness["state"])
        observation = drain_observation()
        require(observation == {"drained": True, "blocked": []},
                "drain did not accept completed/dead work: "
                + json.dumps(observation, sort_keys=True)[:400])
        adapter = load_adapter().GuestFixtureAdapter(
            unit_dir=UNIT_DIR, fixture_dir=FIXTURE, unit=UNIT,
            proof_root=PROOF_BIN, guest_only=True)
        current = adapter._runtime_from_unit(SERVICE)
        require(current == PYTHON_RUNTIME,
                "harvest proof must start from the Python fixture runtime")
        before = snapshot()
        node_baseline = completion_baseline(before["completions"])
        node_result = cli("switch", ["--runtime", NODE_RUNTIME])
        require(node_result["rc"] == 0,
                "harvest switch to Node failed: "
                + (node_result.get("stderr") or node_result.get("stdout") or "")[:800])
        node_records = new_records(before_paths)
        require(len(node_records) == 1,
                "harvest switch did not create exactly one record")
        node_record = json.loads(node_records[0].read_text())
        node_completions = validate_completed(
            node_record, NODE_RUNTIME, PYTHON_RUNTIME, node_baseline)
        # Match switch_phase's post-switch baseline: the proof adapter starts
        # the fixture timer on release, and the timer must not keep triggering
        # a oneshot service into the next phase's snapshot.
        systemctl("stop", TIMER)
        systemctl("reset-failed", TIMER)
        time.sleep(0.5)
        require(sha256_file(STATE / "queue.json") == seeded_sha,
                "harvest switch changed the seeded queue bytes")
        require(process_state(unrelated.pid)["alive"],
                "harvest switch signalled unrelated guest work")
        require(not process_state(seeded["process_state"]["pid"])["alive"],
                "completed/dead run unexpectedly came alive")
        check_preserved_expected(seeded_hashes, "drain-harvest-node")
        node_paths = [str(path) for path in records()]
        python_baseline = completion_baseline(completions())
        python_result = cli("switch", ["--runtime", PYTHON_RUNTIME])
        require(python_result["rc"] == 0,
                "harvest switch back to Python failed: "
                + (python_result.get("stderr") or python_result.get("stdout") or "")[:800])
        python_records = new_records(node_paths)
        require(len(python_records) == 1,
                "harvest return switch did not create exactly one record")
        python_record = json.loads(python_records[0].read_text())
        python_completions = validate_completed(
            python_record, PYTHON_RUNTIME, NODE_RUNTIME, python_baseline)
        systemctl("stop", TIMER)
        systemctl("reset-failed", TIMER)
        time.sleep(0.5)
        require(sha256_file(STATE / "queue.json") == seeded_sha,
                "harvest return switch changed the seeded queue bytes")
        require(process_state(unrelated.pid)["alive"],
                "harvest return switch signalled unrelated guest work")
        after = snapshot()
        require(len(after["completions"]) > len(before["completions"]),
                "harvest proof did not observe fixture completions")
        preserved = check_preserved_expected(seeded_hashes, "drain-harvest")
        result = {
            "observation": observation,
            "liveness": [liveness],
            "seeded": {"run_id": seeded["run_id"],
                       "item": seeded["item"],
                       "identity": seeded["identity"],
                       "process": seeded["process_state"]},
            "queue": {"seeded_sha256": seeded_sha,
                      "after_node_sha256": seeded_sha,
                      "after_python_sha256": sha256_file(STATE / "queue.json")},
            "node": {"cli": {"rc": node_result["rc"],
                             "stdout": node_result["stdout"]},
                     "record_path": str(node_records[0]),
                     "record": record_summary(node_records[0]),
                     "completions": node_completions},
            "python": {"cli": {"rc": python_result["rc"],
                               "stdout": python_result["stdout"]},
                       "record_path": str(python_records[0]),
                       "record": record_summary(python_records[0]),
                       "completions": python_completions},
            "processes": {"unrelated": {"before": unrelated_state,
                                        "after": process_state(unrelated.pid)},
                          "completed": {**seeded["process_state"],
                                        "alive": False}},
            "after": after,
            "completions_before": len(before["completions"]),
            "completions_after": len(after["completions"]),
            "preserved": preserved,
        }
    finally:
        cleanup.append(stop_process(unrelated))
        restore_queue(saved_queue)
        remove_drain_runs()
    require(state_hashes() == saved["state"],
            "harvest proof cleanup did not restore the baseline queue")
    result["cleanup"] = cleanup
    result["baseline_restored"] = state_hashes() == saved["state"]
    return result


def recover_drain_refuse_phase(args):
    """Recovery independently re-observes ownership before its own fence."""
    record_path = pathlib.Path(args.record)
    saved = baseline()
    saved_queue = queue_bytes()
    record_before = record_summary(record_path)
    record = json.loads(record_path.read_text())
    require(record["outcome"] == "pending" and record["phase"] == "drained",
            "recovery drain proof requires a retained drained intent")
    seeded = seed_drain_work("alive")
    unrelated, unrelated_state = spawn_detached("crq-drain-unrelated")
    cleanup = []
    try:
        seed_queue([seeded["item"],
                    {"id": "drain-terminal", "state": "done"}])
        seeded_sha = sha256_file(STATE / "queue.json")
        liveness = item_liveness(seeded["item"])
        require(liveness["state"] == "alive",
                "recovery seeded run is not alive: " + liveness["state"])
        observation = drain_observation()
        require(observation["drained"] is False,
                "recovery drain erroneously reported owned work absent")
        before = snapshot()
        service_before = show(UNIT, ["LoadState", "ActiveState", "FragmentPath"])
        timer_before = show(TIMER, ["ActiveState", "LoadState"])
        result = cli("recover", ["--record", str(record_path)])
        require(result["rc"] == 2,
                "recovery did not refuse live owned work: "
                + (result.get("stdout") or result.get("stderr") or "")[:800])
        try:
            payload = json.loads(result["stdout"])
        except ValueError as exc:
            raise RuntimeError("recovery refusal CLI did not emit JSON") from exc
        require("queue-owned work" in (payload.get("refused") or ""),
                "recovery refusal message is not explicit")
        require(payload.get("drain", {}).get("blocked") == observation["blocked"],
                "recovery drain evidence does not match the observation")
        after = snapshot()
        service_after = show(UNIT, ["LoadState", "ActiveState", "FragmentPath"])
        timer_after = show(TIMER, ["ActiveState", "LoadState"])
        require(record_summary(record_path)["sha256"] == record_before["sha256"],
                "refused recovery changed the retained record")
        require(record_summary(record_path)["outcome"] == "pending"
                and record_summary(record_path)["phase"] == "drained",
                "refused recovery advanced the retained intent")
        require(sha256_file(STATE / "queue.json") == seeded_sha,
                "refused recovery changed the seeded queue bytes")
        require(after["completions"] == before["completions"],
                "refused recovery released activation")
        require(service_after == service_before,
                "refused recovery changed the service fence")
        require(timer_after == timer_before,
                "refused recovery changed timer activation")
        require(SERVICE.is_symlink() and os.readlink(SERVICE) == "/dev/null",
                "refused recovery released the durable service mask")
        require(not STAGED_SERVICE.exists() and not STAGED_SERVICE.is_symlink(),
                "refused recovery created an unexpected staging path")
        owned_after = process_state(seeded["process"].pid)
        unrelated_after = process_state(unrelated.pid)
        require(owned_after["alive"],
                "refused recovery signalled the alive seeded process")
        require(unrelated_after["alive"],
                "refused recovery signalled unrelated guest work")
        result = {
            "record_path": str(record_path),
            "record_before": record_before,
            "record_after": record_summary(record_path),
            "cli": {"rc": result["rc"], "stdout": result["stdout"],
                    "stderr": result["stderr"]},
            "refused": payload.get("refused"),
            "drain": payload.get("drain"),
            "observation": observation,
            "liveness": [liveness],
            "seeded": {"run_id": seeded["run_id"],
                       "item": seeded["item"],
                       "identity": seeded["identity"],
                       "process": seeded["process_state"]},
            "queue": {"before_sha256": seeded_sha,
                      "after_sha256": sha256_file(STATE / "queue.json")},
            "service": {"before": service_before, "after": service_after},
            "timer": {"before": timer_before, "after": timer_after},
            "completions_before": len(before["completions"]),
            "completions_after": len(after["completions"]),
            "processes": {"owned": owned_after,
                          "unrelated": {"before": unrelated_state,
                                        "after": unrelated_after}},
        }
    finally:
        cleanup.append(stop_process(seeded["process"]))
        cleanup.append(stop_process(unrelated))
        restore_queue(saved_queue)
        remove_drain_runs()
    require(state_hashes() == saved["state"],
            "recovery drain proof cleanup did not restore the baseline queue")
    result["cleanup"] = cleanup
    result["queue"]["restored_sha256"] = sha256_file(STATE / "queue.json")
    result["baseline_restored"] = state_hashes() == saved["state"]
    return result


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
    try:
        refusal = json.loads(switched.get("stdout") or "").get("refused")
    except (TypeError, ValueError):
        refusal = None
    require(len(created) == 1,
            "rollback fence switch did not leave one journal record: rc=%r "
            "created=%r refused=%r stderr=%s"
            % (switched["rc"], [path.name for path in created],
               (refusal or (switched.get("stdout") or ""))[:600],
               (switched.get("stderr") or "")[:800]))
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
    timer = show(TIMER, ["ActiveState", "LoadState"])
    require(timer["ActiveState"] in ("inactive", "failed"),
            args.phase + " left the timer activator active after the boundary")
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
            "fence": {"service": service, "direct_start": direct,
                      "timer": timer},
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


# ------------------------------------------------------------------ activators
# A second declared guest topology. This proves the allowlisted inventory and
# the service/timer/path/drop-in fence shape. It is not exhaustive production
# activator discovery: other-name dependency units, default-target links and
# socket units outside these exact paths remain a production inventory gap.

def read_completions(path):
    path = pathlib.Path(path)
    if not path.exists():
        return []
    entries = []
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            entries.append(json.loads(line))
        except ValueError as exc:
            raise RuntimeError(
                "completion log line %d is not JSON" % number) from exc
    return entries


def repair_adapter():
    return load_adapter().GuestFixtureAdapter(
        unit_dir=UNIT_DIR, fixture_dir=FIXTURE, unit=REPAIR_UNIT,
        proof_root=PROOF_BIN, guest_only=True)


def repair_files():
    return {
        "service": file_state(REPAIR_SERVICE),
        "timer": file_state(REPAIR_TIMER_PATH),
        "timer_wants": file_state(REPAIR_TIMER_WANTS),
        "path": file_state(REPAIR_PATH_PATH),
        "path_wants": file_state(REPAIR_PATH_WANTS),
        "dropin": file_state(REPAIR_DROPIN),
        "staged": file_state(REPAIR_STAGED),
        "trigger": file_state(REPAIR_TRIGGER),
        "completions": file_state(REPAIR_COMPLETIONS),
        "caller": file_state(CALLER_PATH),
        "blocker": file_state(BLOCKER_PATH),
    }


def repair_units():
    common = ["LoadState", "ActiveState", "SubState", "UnitFileState",
              "FragmentPath"]
    service = common + ["MainPID", "ControlGroup", "InvocationID", "Result"]
    return {
        name: show(name, service if name.endswith(".service") else common)
        for name in ACTIVATOR_UNITS
    }


def repair_snapshot():
    data = snapshot(REPAIR_RECORDS)
    data["repair_units"] = repair_units()
    data["repair_files"] = repair_files()
    data["repair_completions"] = read_completions(REPAIR_COMPLETIONS)
    data["tick"] = snapshot()
    return data


def stable_snapshot(data):
    keys = ("hostname", "user", "boot_id", "manager", "units", "files",
            "metadata", "state", "history", "records", "completions")
    return {key: data.get(key) for key in keys}


def repair_clean():
    for name in ACTIVATOR_UNITS:
        systemctl("stop", name)
        systemctl("reset-failed", name)
    REPAIR_TRIGGER.unlink(missing_ok=True)
    REPAIR_PAUSE_MARKER.unlink(missing_ok=True)


def settle_service():
    """Leave the service inactive with a fresh inactive timestamp.

    ``OnUnitInactiveSec`` counts from the service's last inactive entry, so a
    timer started while the service has been inactive for longer than the
    interval fires immediately. A real start followed by a stop forces the
    fresh inactive transition; the completed fixture run is part of the
    baseline the switch-back takes afterwards.
    """
    systemctl("stop", REPAIR_TIMER)
    systemctl("stop", REPAIR_UNIT)
    systemctl("stop", BLOCKER_UNIT)
    systemctl("reset-failed", REPAIR_UNIT)
    started = systemctl("start", REPAIR_UNIT, timeout=60)
    require(not started["timeout"] and started["rc"] == 0,
            "failed to create a fresh inactive transition")
    systemctl("stop", REPAIR_UNIT)
    systemctl("reset-failed", REPAIR_UNIT)
    systemctl("stop", BLOCKER_UNIT)
    systemctl("reset-failed", BLOCKER_UNIT)
    started = systemctl("start", REPAIR_TIMER)
    require(started["rc"] == 0, "failed to start timer after settling")
    require(show(REPAIR_UNIT, ["ActiveState"])["ActiveState"] == "inactive",
            "service did not settle to inactive")


def wait_until(predicate, timeout, label):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.1)
    raise RuntimeError(label + " did not settle within the bound")


def wait_job(unit_name, timeout=15):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        observation = jobs_observation()
        result = observation["command"]
        require(not result["timeout"] and result["rc"] == 0,
                "list-jobs failed; job identity is unknown")
        last = observation["lines"]
        for line in last:
            if unit_name in line:
                return line, observation
        time.sleep(0.1)
    raise RuntimeError("no job for " + unit_name + " within the bound: "
                       + json.dumps(last)[:300])


def wait_job_absent(unit_name, timeout=15):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        observation = jobs_observation()
        result = observation["command"]
        require(not result["timeout"] and result["rc"] == 0,
                "list-jobs failed; job absence is unknown")
        last = observation["lines"]
        if not any(unit_name in line for line in last):
            return observation
        time.sleep(0.1)
    raise RuntimeError("job for " + unit_name + " survived the bound: "
                       + json.dumps(last)[:300])


def wait_completion(path, previous, timeout=30):
    deadline = time.time() + timeout
    entries = read_completions(path)
    while time.time() < deadline:
        entries = read_completions(path)
        new = entries[previous:]
        if new:
            return new, entries
        time.sleep(0.1)
    raise RuntimeError("no completion within the bound: "
                       + json.dumps({"previous": previous,
                                     "observed": len(entries)})[:300])


def blocker_running():
    state = show(BLOCKER_UNIT, ["ActiveState", "SubState", "MainPID",
                                "InvocationID"])
    if state["ActiveState"] in ("activating", "active") \
            and state.get("MainPID") not in (None, "", "0"):
        return state
    return None


def write_repair_fixture():
    adapter = repair_adapter()
    UNIT_DIR.mkdir(parents=True, exist_ok=True)
    REPAIR_TIMER_WANTS.parent.mkdir(parents=True, exist_ok=True)
    REPAIR_PATH_WANTS.parent.mkdir(parents=True, exist_ok=True)
    REPAIR_RECORDS.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(REPAIR_RECORDS, 0o700)
    for path in (REPAIR_SERVICE, REPAIR_TIMER_PATH, REPAIR_PATH_PATH,
                 REPAIR_DROPIN, REPAIR_TIMER_WANTS, REPAIR_PATH_WANTS,
                 CALLER_PATH, BLOCKER_PATH, REPAIR_STAGED, REPAIR_TRIGGER):
        if path.is_symlink() or path.exists():
            path.unlink()
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
    REPAIR_COMPLETIONS.unlink(missing_ok=True)
    pathlib.Path(str(REPAIR_COMPLETIONS) + ".lock").unlink(missing_ok=True)
    shutil.rmtree(str(REPAIR_COMPLETIONS) + ".lockdir", ignore_errors=True)
    result = systemctl("daemon-reload")
    require(result["rc"] == 0, "daemon-reload after repair install failed")
    repair_clean()
    return adapter


def cli_argv(command, extra=None):
    argv = [sys.executable, str(PROOF_BIN / "unit-switch.py"), command,
            "--root", str(CHECKOUT), "--record-dir", str(REPAIR_RECORDS),
            "--unit", REPAIR_UNIT, "--fixture-dir", str(FIXTURE),
            "--proof-root", str(PROOF_BIN), "--proof-fixture"]
    if extra:
        argv.extend(extra)
    return argv


def cli_activators(command, extra=None, extra_env=None, timeout=180):
    result = run(cli_argv(command, extra), timeout=timeout, extra_env=extra_env,
                 max_output=60000)
    parsed = None
    if (result.get("stdout") or "").strip():
        try:
            parsed = json.loads(result["stdout"])
        except ValueError:
            parsed = None
    result["json"] = parsed
    return result


def terminate_process(proc):
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def cli_paused(extra, callback, timeout=180):
    REPAIR_PAUSE_MARKER.unlink(missing_ok=True)
    values = env()
    values["CRQ_PROOF_PAUSE_ON"] = "after-mask-reload"
    values["CRQ_PROOF_PAUSE_MARKER"] = str(REPAIR_PAUSE_MARKER)
    proc = subprocess.Popen(cli_argv("switch", extra), stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, env=values,
                            start_new_session=True)
    deadline = time.time() + 60
    while time.time() < deadline:
        if REPAIR_PAUSE_MARKER.exists() or proc.poll() is not None:
            break
        time.sleep(0.05)
    if not REPAIR_PAUSE_MARKER.exists():
        terminate_process(proc)
        out, err = proc.communicate()
        return {"argv": cli_argv("switch", extra), "rc": proc.returncode,
                "stdout": out[-60000:], "stderr": err[-60000:],
                "timeout": False, "pause_reached": False, "during": None,
                "json": None}
    during = callback()
    timed_out = False
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        terminate_process(proc)
        out, err = proc.communicate()
    parsed = None
    if (out or "").strip():
        try:
            parsed = json.loads(out)
        except ValueError:
            parsed = None
    return {"argv": cli_argv("switch", extra), "rc": proc.returncode,
            "stdout": out[-60000:], "stderr": err[-60000:],
            "timeout": timed_out, "pause_reached": True, "during": during,
            "json": parsed}


def activators_install(args):
    require(os.uname().nodename == "crq-probe",
            "proof driver only runs on the disposable crq-probe guest")
    for path in (REPAIR_SERVICE, REPAIR_TIMER_PATH, REPAIR_PATH_PATH,
                 REPAIR_TIMER_WANTS, REPAIR_PATH_WANTS, REPAIR_DROPIN,
                 REPAIR_STAGED, REPAIR_TRIGGER, CALLER_PATH, BLOCKER_PATH):
        if path.is_symlink() or path.exists():
            path.unlink()
    shutil.rmtree(REPAIR_DROPIN_DIR, ignore_errors=True)
    shutil.rmtree(REPAIR_RECORDS, ignore_errors=True)
    adapter = write_repair_fixture()
    inventory = adapter.inventory()
    require(inventory["topology"] == "repair",
            "repair inventory did not report the repair topology")
    require(inventory["activators"]["timer_active"] == "inactive",
            "repair timer started unexpectedly at install")
    require(inventory["activators"]["path_active"] == "inactive",
            "repair path started unexpectedly at install")
    require(inventory["activators"]["service_active"] == "inactive",
            "repair service started unexpectedly at install")
    unrelated, unrelated_state = spawn_detached("activator-unrelated")
    unrelated_path = FIXTURE / "activators-unrelated.json"
    _write(unrelated_path, json.dumps({
        "pid": unrelated.pid, "starttime": unrelated_state.get("starttime"),
        "cmdline": unrelated_state.get("cmdline")}, sort_keys=True) + "\n", 0o600)
    return {"phase": "activators-install", "inventory": inventory,
            "files": repair_files(), "units": repair_units(),
            "completions": read_completions(REPAIR_COMPLETIONS),
            "records": [record_summary(path)
                        for path in records_in(REPAIR_RECORDS)],
            "tick": snapshot(),
            "state": state_hashes(),
            "unrelated": {"pid": unrelated.pid,
                          "starttime": unrelated_state.get("starttime"),
                          "cmdline": unrelated_state.get("cmdline")},
            "preserved": check_preserved({"phase": "activators-install"})}


def activators_positive(args):
    repair_clean()
    require(show(REPAIR_UNIT, ["ActiveState"])["ActiveState"] == "inactive",
            "direct control requires an inactive service")
    require(show(REPAIR_TIMER, ["UnitFileState"])["UnitFileState"] == "enabled",
            "timer control requires an enabled timer")
    require(show(REPAIR_PATH_UNIT, ["UnitFileState"])["UnitFileState"]
            == "enabled", "path control requires an enabled path unit")
    controls = {}

    before = read_completions(REPAIR_COMPLETIONS)
    blocker = systemctl("start", "--no-block", BLOCKER_UNIT)
    require(blocker["rc"] == 0, "queue blocker failed to start")
    blocker_state = wait_until(blocker_running, 15, "queue blocker")
    target = systemctl("start", "--no-block", REPAIR_UNIT)
    require(target["rc"] == 0, "queued target failed to queue")
    job_line, job_observation = wait_job(REPAIR_UNIT, timeout=15)
    require("start" in job_line, "queued target job is not a start job")
    require(REPAIR_UNIT in job_line, "queued target job names another unit")
    queued_entries = read_completions(REPAIR_COMPLETIONS)
    require(len(queued_entries) == len(before),
            "queued target completed before cancellation")
    stopped = systemctl("stop", REPAIR_UNIT)
    require(not stopped["timeout"] and stopped["rc"] == 0,
            "queued target stop did not complete")
    jobs_after_observation = wait_job_absent(REPAIR_UNIT, timeout=15)
    after_entries = read_completions(REPAIR_COMPLETIONS)
    require(len(after_entries) == len(before),
            "queued target completed after cancellation")
    blocker_stop = systemctl("stop", BLOCKER_UNIT)
    require(not blocker_stop["timeout"] and blocker_stop["rc"] == 0,
            "queue blocker stop did not complete")
    systemctl("reset-failed", BLOCKER_UNIT)
    controls["queue"] = {
        "blocker_command": blocker, "blocker": blocker_state,
        "target_command": target, "job": job_line,
        "job_observation": job_observation,
        "jobs": job_observation["lines"],
        "stop": stopped, "jobs_after": jobs_after_observation["lines"],
        "jobs_after_observation": jobs_after_observation,
        "blocker_stop": blocker_stop, "before_count": len(before),
        "after_count": len(after_entries), "bounded_wait_seconds": 15}

    # Run the service once before the timer control: OnUnitInactiveSec counts
    # from a real inactive transition, and a never-activated oneshot has no
    # such timestamp to elapse from.
    before = read_completions(REPAIR_COMPLETIONS)
    started = systemctl("start", REPAIR_UNIT, timeout=60)
    require(started["rc"] == 0, "direct positive control failed to start")
    service_state = show(REPAIR_UNIT, ["ActiveState", "SubState",
                                       "UnitFileState", "Result"])
    new, entries = wait_completion(REPAIR_COMPLETIONS, len(before), timeout=30)
    stopped = systemctl("stop", REPAIR_UNIT)
    systemctl("reset-failed", REPAIR_UNIT)
    controls["direct"] = {
        "command": started, "state": service_state, "stop": stopped,
        "before_count": len(before), "after_count": len(entries),
        "new": new, "bounded_wait_seconds": 30}

    before = read_completions(REPAIR_COMPLETIONS)
    started = systemctl("start", REPAIR_TIMER)
    require(started["rc"] == 0, "timer positive control failed to start")
    timer_state = show(REPAIR_TIMER, ["ActiveState", "UnitFileState"])
    require(timer_state["ActiveState"] == "active",
            "timer positive control is not active")
    new, entries = wait_completion(REPAIR_COMPLETIONS, len(before), timeout=30)
    stopped = systemctl("stop", REPAIR_TIMER)
    systemctl("reset-failed", REPAIR_TIMER)
    systemctl("stop", REPAIR_UNIT)
    systemctl("stop", BLOCKER_UNIT)
    require(show(REPAIR_TIMER, ["ActiveState"])["ActiveState"]
            in ("inactive", "failed"), "timer control did not stop")
    controls["timer"] = {
        "command": started, "state": timer_state, "stop": stopped,
        "before_count": len(before), "after_count": len(entries),
        "new": new, "bounded_wait_seconds": 30}

    before = read_completions(REPAIR_COMPLETIONS)
    started = systemctl("start", REPAIR_PATH_UNIT)
    require(started["rc"] == 0, "path positive control failed to start")
    path_state = show(REPAIR_PATH_UNIT, ["ActiveState", "UnitFileState"])
    require(path_state["ActiveState"] == "active",
            "path positive control is not active")
    REPAIR_TRIGGER.write_text("proof\n")
    new, entries = wait_completion(REPAIR_COMPLETIONS, len(before), timeout=30)
    REPAIR_TRIGGER.unlink(missing_ok=True)
    stopped = systemctl("stop", REPAIR_PATH_UNIT)
    systemctl("reset-failed", REPAIR_PATH_UNIT)
    systemctl("stop", REPAIR_UNIT)
    systemctl("stop", BLOCKER_UNIT)
    require(show(REPAIR_PATH_UNIT, ["ActiveState"])["ActiveState"]
            in ("inactive", "failed"), "path control did not stop")
    controls["path"] = {
        "command": started, "state": path_state, "stop": stopped,
        "before_count": len(before), "after_count": len(entries),
        "new": new, "bounded_wait_seconds": 30}

    before = read_completions(REPAIR_COMPLETIONS)
    started = systemctl("start", CALLER_UNIT, timeout=60)
    require(started["rc"] == 0, "dependency positive control failed to start")
    caller_state = show(CALLER_UNIT, ["ActiveState", "UnitFileState"])
    new, entries = wait_completion(REPAIR_COMPLETIONS, len(before), timeout=30)
    stopped = systemctl("stop", CALLER_UNIT)
    systemctl("reset-failed", CALLER_UNIT)
    systemctl("stop", REPAIR_UNIT)
    systemctl("reset-failed", REPAIR_UNIT)
    controls["dependency"] = {
        "command": started, "state": caller_state, "stop": stopped,
        "before_count": len(before), "after_count": len(entries),
        "new": new, "bounded_wait_seconds": 30}

    systemctl("stop", REPAIR_UNIT)
    systemctl("reset-failed", REPAIR_UNIT)
    timer = systemctl("start", REPAIR_TIMER)
    require(timer["rc"] == 0, "failed to restore timer before the fence")
    require(show(REPAIR_TIMER, ["ActiveState"])["ActiveState"] == "active",
            "timer is not active before the fence")
    path_final = show(REPAIR_PATH_UNIT, ["ActiveState", "UnitFileState"])
    require(path_final["ActiveState"] == "inactive",
            "path is not inactive before the fence")
    require(path_final["UnitFileState"] == "enabled",
            "path is not enabled before the fence")
    return {"phase": "activators-positive", "controls": controls,
            "pre_switch": repair_snapshot(),
            "preserved": check_preserved({"phase": "activators-positive"})}


def activators_unknown(args):
    repair_clean()
    baseline_files = repair_files()
    baseline_tick = stable_snapshot(snapshot())
    baseline_records = [record_summary(path)
                        for path in records_in(REPAIR_RECORDS)]
    baseline_completions = read_completions(REPAIR_COMPLETIONS)
    cases = {}

    def run_case(name, mutate, cleanup, tokens):
        mutate()
        mutated_files = repair_files()
        records_before = [record_summary(path)
                          for path in records_in(REPAIR_RECORDS)]
        result = cli_activators("switch", ["--runtime", NODE_RUNTIME])
        text = ((result.get("stdout") or "")
                + (result.get("stderr") or "")).lower()
        records_after = [record_summary(path)
                         for path in records_in(REPAIR_RECORDS)]
        completions_after = read_completions(REPAIR_COMPLETIONS)
        units_after = repair_units()
        cleanup()
        require(result["rc"] == 2, name + " refusal did not exit 2")
        require(all(token in text for token in tokens),
                name + " refusal text does not name the inventory defect")
        require([item["sha256"] for item in records_before]
                == [item["sha256"] for item in records_after],
                name + " wrote a controller record before refusing")
        require(len(completions_after) == len(baseline_completions),
                name + " completed fixture work before refusing")
        cases[name] = {
            "command": result, "mutated_files": mutated_files,
            "records_before": records_before,
            "records_after": records_after,
            "completions_after": len(completions_after),
            "units_after": units_after}

    rogue = UNIT_DIR / "crq-repair.socket"
    run_case("rogue-unit",
             lambda: _write(rogue,
                            "[Socket]\nListenStream=%t/crq-repair-proof.sock\n"),
             lambda: rogue.unlink(missing_ok=True),
             ("outside the allowlisted", "socket"))

    rogue_link = UNIT_DIR / "default.target.wants" / REPAIR_TIMER
    run_case("unknown-link",
             lambda: rogue_link.symlink_to("../" + REPAIR_TIMER),
             lambda: rogue_link.unlink(missing_ok=True),
             ("outside the allowlisted", "crq-repair.timer"))

    rogue_dropin = REPAIR_DROPIN_DIR / "20-rogue.conf"
    run_case("unknown-dropin",
             lambda: _write(rogue_dropin, "[Unit]\nDescription=rogue\n"),
             lambda: rogue_dropin.unlink(missing_ok=True),
             ("outside the allowlisted", "unexpected drop-in"))

    original_mode = REPAIR_DROPIN.stat().st_mode & 0o7777
    run_case("unsafe-metadata",
             lambda: os.chmod(REPAIR_DROPIN, 0o666),
             lambda: os.chmod(REPAIR_DROPIN, original_mode),
             ("group- or world-writable",))

    after_files = repair_files()
    after_tick = stable_snapshot(snapshot())
    after_records = [record_summary(path)
                     for path in records_in(REPAIR_RECORDS)]
    require(after_files == baseline_files,
            "refusal cases changed a fixture path")
    require(after_records == baseline_records,
            "refusal cases changed the controller journal inventory")
    require(after_tick == baseline_tick,
            "refusal cases changed the original tick topology")
    return {"phase": "activators-unknown", "cases": cases,
            "baseline": {"files": baseline_files, "tick": baseline_tick,
                         "records": baseline_records},
            "after": {"files": after_files, "tick": after_tick,
                      "records": after_records},
            "completions": len(baseline_completions)}


def activators_fence(args):
    repair_clean()
    require(show(REPAIR_TIMER, ["UnitFileState"])["UnitFileState"] == "enabled",
            "timer is not enabled before the fence")
    require(show(REPAIR_PATH_UNIT, ["UnitFileState"])["UnitFileState"]
            == "enabled", "path is not enabled before the fence")
    blocker = systemctl("start", "--no-block", BLOCKER_UNIT)
    require(blocker["rc"] == 0, "failed to start queue blocker")
    blocker_state = wait_until(blocker_running, 15, "queue blocker")
    target = systemctl("start", "--no-block", REPAIR_UNIT)
    require(target["rc"] == 0, "failed to queue the target before the fence")
    job_line, job_observation = wait_job(REPAIR_UNIT, timeout=15)
    require("start" in job_line and REPAIR_UNIT in job_line,
            "queued target job is not the expected start job")
    started = systemctl("start", REPAIR_TIMER)
    require(started["rc"] == 0, "failed to start timer before the fence")
    require(show(REPAIR_TIMER, ["ActiveState"])["ActiveState"] == "active",
            "timer is not active before the fence")
    before = repair_snapshot()
    completions_before = read_completions(REPAIR_COMPLETIONS)
    records_before = [record_summary(path)
                      for path in records_in(REPAIR_RECORDS)]
    queue_seed = {
        "blocker": blocker_state, "blocker_command": blocker,
        "target_command": target, "job": job_line,
        "job_observation": job_observation,
        "jobs": job_observation["lines"]}

    def during():
        completions_before_external = read_completions(REPAIR_COMPLETIONS)
        direct = systemctl("start", REPAIR_UNIT)
        dependency = systemctl("start", CALLER_UNIT)
        REPAIR_TRIGGER.write_text("proof\n")
        path_state = show(REPAIR_PATH_UNIT, ["ActiveState", "UnitFileState"])
        blocker_now = show(BLOCKER_UNIT, ["ActiveState", "SubState", "MainPID",
                                          "InvocationID"])
        jobs_now = jobs_observation()
        completions_now = read_completions(REPAIR_COMPLETIONS)
        marker = json.loads(REPAIR_PAUSE_MARKER.read_text())
        trigger_state = file_state(REPAIR_TRIGGER)
        return {"direct": direct, "dependency": dependency,
                "path_state": path_state, "blocker": blocker_now,
                "jobs": jobs_now["lines"], "jobs_observation": jobs_now,
                "completions_before_external": completions_before_external,
                "completions": completions_now,
                "completion_count": len(completions_now),
                "external_completion_delta":
                    len(completions_now) - len(completions_before_external),
                "marker": marker, "trigger": trigger_state}

    cli = cli_paused(["--runtime", NODE_RUNTIME], during)
    REPAIR_TRIGGER.unlink(missing_ok=True)
    REPAIR_PAUSE_MARKER.unlink(missing_ok=True)
    blocker_stop = systemctl("stop", BLOCKER_UNIT)
    require(not blocker_stop["timeout"] and blocker_stop["rc"] == 0,
            "fence blocker stop did not complete")
    systemctl("reset-failed", BLOCKER_UNIT)
    systemctl("stop", REPAIR_UNIT)
    systemctl("reset-failed", REPAIR_UNIT)
    after = repair_snapshot()
    completions_after = read_completions(REPAIR_COMPLETIONS)
    records_after = [record_summary(path)
                     for path in records_in(REPAIR_RECORDS)]
    require(cli["rc"] == 0, "paused switch did not complete")
    require(cli["pause_reached"] is True, "paused switch did not reach the pause")
    payload = cli.get("json") or {}
    record = payload.get("record") or {}
    drain = payload.get("drain") or {}
    require(record.get("outcome") == "completed",
            "paused switch record is not completed")
    require(record.get("runtime") == NODE_RUNTIME,
            "paused switch record names another runtime")
    require(record.get("prior_runtime") == PYTHON_RUNTIME,
            "paused switch record names another prior runtime")
    completions = record.get("completions") or []
    require(len(completions) == 2,
            "paused switch record does not retain two completions")
    require(len({item.get("invocation") for item in completions}) == 2,
            "paused switch completions share an invocation")
    baseline = max((item.get("sequence", 0) for item in completions_before),
                   default=0)
    require(all(type(item.get("sequence")) is int
                and item["sequence"] > baseline for item in completions),
            "paused switch completions do not advance past the baseline")
    after_by_invocation = {item.get("invocation"): item
                           for item in completions_after}
    baseline_invocations = {item.get("invocation")
                            for item in completions_before}
    during_invocations = {item.get("invocation")
                          for item in (cli["during"] or {}).get(
                              "completions", [])}
    for item in completions:
        require(item.get("invocation") in after_by_invocation,
                "paused switch completion is absent from the final log")
        require(item.get("invocation") not in baseline_invocations,
                "paused switch completion was attributed to pre-switch work")
        require(item.get("invocation") not in during_invocations,
                "paused switch completion was attributed to pre-release work")
    require(len(records_after) == len(records_before) + 1,
            "paused switch did not retain exactly one new record")
    new_paths = ({item["path"] for item in records_after}
                 - {item["path"] for item in records_before})
    require(len(new_paths) == 1,
            "paused switch record set difference is not one record")
    record_after = [item for item in records_after
                    if item["path"] in new_paths][0]
    require(record_after.get("transaction_id") == record.get("transaction_id"),
            "paused switch record summary is not the retained record")
    require(record_after.get("outcome") == "completed",
            "paused switch record on disk is not completed")
    require(isinstance(drain, dict) and drain.get("jobs") == [],
            "paused switch drain retains a service or activator job")
    require(drain.get("state", {}).get("ActiveState") == "inactive",
            "paused switch drain did not settle the service")
    require(drain.get("owned", {}).get("pids") == [],
            "paused switch drain retains owned pids")
    require(drain.get("owned", {}).get("main_pid") == 0,
            "paused switch drain retains a main pid")
    activators = drain.get("activators") or {}
    for unit in (REPAIR_TIMER, REPAIR_PATH_UNIT):
        require(activators.get(unit, {}).get("ActiveState")
                in ("inactive", "failed"),
                "paused switch drain leaves " + unit + " active")
    direct = drain.get("direct_start") or {}
    direct_text = ((direct.get("stdout") or "")
                   + (direct.get("stderr") or "")).lower()
    require(direct.get("rc") not in (0, None) and "masked" in direct_text,
            "paused switch did not refuse a direct start while masked")
    require((drain.get("queue_drain") or {}).get("drained") is True,
            "paused switch queue drain is not established")
    external = cli["during"] or {}
    direct_text = ((external.get("direct", {}).get("stdout") or "")
                   + (external.get("direct", {}).get("stderr") or "")).lower()
    require(external.get("direct", {}).get("rc") not in (0, None)
            and "masked" in direct_text,
            "external direct start was not refused by the durable mask")
    dependency_text = ((external.get("dependency", {}).get("stdout") or "")
                       + (external.get("dependency", {}).get("stderr")
                          or "")).lower()
    require(external.get("dependency", {}).get("rc") not in (0, None),
            "external dependency start unexpectedly succeeded")
    require("masked" in dependency_text or "required" in dependency_text
            or "dependency" in dependency_text,
            "external dependency start failed for an unknown reason")
    require(external.get("path_state", {}).get("ActiveState") == "inactive",
            "external path activation was not fenced")
    require(external.get("external_completion_delta") == 0,
            "external activation produced a completion before release")
    require(any(REPAIR_UNIT in line for line in external.get("jobs", [])),
            "queued target job was not retained through mask and reload")
    require(external.get("marker", {}).get("phase") == "after-mask-reload",
            "pause marker does not record the expected phase")
    require(after["repair_files"]["service"]["type"] == "file",
            "released service is not a regular file")
    expected_service = repair_adapter().render_unit(NODE_RUNTIME)
    require(after["repair_files"]["service"]["sha256"]
            == sha256_bytes(expected_service.encode()),
            "released service bytes do not match the requested runtime")
    require(after["repair_files"]["staged"]["type"] == "missing",
            "released switch retains a staged target")
    require(after["repair_units"][REPAIR_TIMER]["ActiveState"] == "active",
            "timer was not released after the switch")
    require(after["repair_units"][REPAIR_PATH_UNIT]["ActiveState"]
            == "inactive", "path was activated after the switch")
    require(after["repair_units"][REPAIR_PATH_UNIT]["UnitFileState"]
            == "enabled", "path enablement was lost after the switch")
    require(after["repair_units"][REPAIR_UNIT]["LoadState"] == "loaded",
            "released service did not load")
    for key in ("timer", "timer_wants", "path", "path_wants", "dropin"):
        require(after["repair_files"][key] == before["repair_files"][key],
                "switch changed the " + key + " path")
    require(before["repair_units"][REPAIR_TIMER]["ActiveState"] == "active",
            "pre-switch timer was not active")
    require(before["repair_units"][REPAIR_PATH_UNIT]["ActiveState"]
            == "inactive", "pre-switch path was not inactive")
    return {"phase": "activators-fence", "queue_seed": queue_seed,
            "before": before, "after": after,
            "completions_before": completions_before,
            "completions_after": completions_after,
            "records_before": records_before, "records_after": records_after,
            "record": record_after, "cli": cli,
            "blocker_stop": blocker_stop,
            "preserved": check_preserved({"phase": "activators-fence"})}


def activators_switch_back(args):
    settle_service()
    require(show(REPAIR_TIMER, ["ActiveState"])["ActiveState"] == "active",
            "timer is not active before the switch back")
    require(show(REPAIR_PATH_UNIT, ["ActiveState"])["ActiveState"]
            == "inactive", "path is not inactive before the switch back")
    records_before = [record_summary(path)
                      for path in records_in(REPAIR_RECORDS)]
    before = repair_snapshot()
    cli = cli_activators("switch", ["--runtime", PYTHON_RUNTIME])
    after = repair_snapshot()
    records_after = [record_summary(path)
                     for path in records_in(REPAIR_RECORDS)]
    require(cli["rc"] == 0, "switch back did not complete")
    payload = cli.get("json") or {}
    record = payload.get("record") or {}
    require(record.get("outcome") == "completed",
            "switch back record is not completed")
    require(record.get("runtime") == PYTHON_RUNTIME,
            "switch back record names another runtime")
    require(record.get("prior_runtime") == NODE_RUNTIME,
            "switch back record names another prior runtime")
    completions = record.get("completions") or []
    require(len(completions) == 2,
            "switch back record does not retain two completions")
    baseline = max((item.get("sequence", 0)
                    for item in before["repair_completions"]), default=0)
    require(all(type(item.get("sequence")) is int
                and item["sequence"] > baseline for item in completions),
            "switch back completions do not advance past the baseline")
    expected_service = repair_adapter().render_unit(PYTHON_RUNTIME)
    require(after["repair_files"]["service"]["sha256"]
            == sha256_bytes(expected_service.encode()),
            "switch back service bytes do not match the requested runtime")
    require(after["repair_units"][REPAIR_TIMER]["ActiveState"] == "active",
            "timer was not released after the switch back")
    require(after["repair_units"][REPAIR_PATH_UNIT]["ActiveState"]
            == "inactive", "path was activated after the switch back")
    new_paths = ({item["path"] for item in records_after}
                 - {item["path"] for item in records_before})
    require(len(new_paths) == 1,
            "switch back record set difference is not one record")
    record_summary_value = [item for item in records_after
                            if item["path"] in new_paths][0]
    return {"phase": "activators-switch-back", "before": before,
            "after": after, "cli": cli,
            "records_before": records_before, "records_after": records_after,
            "record": record_summary_value,
            "preserved": check_preserved({"phase": "activators-switch-back"})}


def activators_interrupt(args):
    require(show(REPAIR_TIMER, ["ActiveState"])["ActiveState"] == "active",
            "timer is not active before the interrupt")
    require(show(REPAIR_PATH_UNIT, ["ActiveState"])["ActiveState"]
            == "inactive", "path is not inactive before the interrupt")
    before = repair_snapshot()
    records_before = [record_summary(path)
                      for path in records_in(REPAIR_RECORDS)]
    cli = cli_activators("switch", ["--runtime", NODE_RUNTIME],
                         extra_env={"CRQ_PROOF_KILL_ON": "install"})
    after = repair_snapshot()
    records_after = [record_summary(path)
                     for path in records_in(REPAIR_RECORDS)]
    require(cli["rc"] not in (0, None), "interrupt did not kill the switch")
    require(len(records_after) == len(records_before) + 1,
            "interrupt did not retain exactly one new record")
    pending = [item for item in records_after
               if item.get("outcome") == "pending"]
    require(len(pending) == 1, "interrupt record is not uniquely pending")
    record = pending[0]
    require(record.get("phase") == "drained",
            "interrupt record is not at the drained boundary")
    require(record.get("runtime") == NODE_RUNTIME,
            "interrupt record names another runtime")
    require(record.get("prior_runtime") == PYTHON_RUNTIME,
            "interrupt record names another prior runtime")
    require(after["repair_files"]["service"]["type"] == "symlink"
            and after["repair_files"]["service"].get("target") == "/dev/null",
            "interrupt did not leave the durable service mask")
    require(after["repair_files"]["staged"]["type"] == "missing",
            "interrupt left a staged target")
    for unit in (REPAIR_TIMER, REPAIR_PATH_UNIT):
        require(after["repair_units"][unit]["ActiveState"]
                in ("inactive", "failed"),
                "interrupt left " + unit + " active")
    require(len(after["repair_completions"])
            == len(before["repair_completions"]),
            "interrupt produced a completion")
    return {"phase": "activators-interrupt", "before": before,
            "after": after, "cli": cli,
            "records_before": records_before, "records_after": records_after,
            "record": record, "record_path": record["path"],
            "preserved": check_preserved({"phase": "activators-interrupt"})}


def activators_recover(args):
    pending = [record_summary(path)
               for path in records_in(REPAIR_RECORDS)
               if record_summary(path).get("outcome") == "pending"]
    require(len(pending) == 1, "recovery requires one pending record")
    path = pending[0]["path"]
    before = repair_snapshot()
    record_before = record_summary(path)
    cli = cli_activators("recover", ["--record", path])
    record_after = record_summary(path)
    after = repair_snapshot()
    require(cli["rc"] == 0, "recovery did not complete")
    require(record_after.get("outcome") == "rolled_back",
            "recovered record is not rolled back")
    require(record_after.get("phase") == "restore_activation_pending",
            "recovered record is not at the restore activation boundary")
    require(record_before.get("sha256") != record_after.get("sha256"),
            "recovery did not advance the retained record")
    expected_service = repair_adapter().render_unit(PYTHON_RUNTIME)
    require(after["repair_files"]["service"]["sha256"]
            == sha256_bytes(expected_service.encode()),
            "recovery did not restore the prior service bytes")
    require(after["repair_files"]["staged"]["type"] == "missing",
            "recovery left a staged target")
    require(after["repair_units"][REPAIR_TIMER]["ActiveState"] == "active",
            "recovery did not restore the active timer")
    require(after["repair_units"][REPAIR_PATH_UNIT]["ActiveState"]
            == "inactive", "recovery activated the inactive path")
    require(after["repair_units"][REPAIR_PATH_UNIT]["UnitFileState"]
            == "enabled", "recovery lost the path enablement")
    for key in ("timer", "timer_wants", "path", "path_wants", "dropin"):
        require(after["repair_files"][key] == before["repair_files"][key],
                "recovery changed the " + key + " path")
    return {"phase": "activators-recover", "before": before,
            "after": after, "record_before": record_before,
            "record_after": record_after, "cli": cli,
            "preserved": check_preserved({"phase": "activators-recover"})}


def activators_repeat(args):
    rolled = [record_summary(path) for path in records_in(REPAIR_RECORDS)
              if record_summary(path).get("outcome") == "rolled_back"]
    require(len(rolled) == 1, "repeat requires one rolled-back record")
    path = rolled[0]["path"]
    before = record_summary(path)
    cli = cli_activators("recover", ["--record", path])
    after = record_summary(path)
    require(cli["rc"] == 2, "repeated recovery did not refuse")
    require(before.get("sha256") == after.get("sha256"),
            "repeated recovery changed the retained record")
    return {"phase": "activators-repeat", "record_before": before,
            "record_after": after, "cli": cli}


def activators_inspect(args):
    repair = repair_snapshot()
    tick = snapshot()
    expected_service = repair_adapter().render_unit(PYTHON_RUNTIME)
    require(repair["repair_files"]["service"]["sha256"]
            == sha256_bytes(expected_service.encode()),
            "final repair service bytes do not match the prior runtime")
    require(repair["repair_units"][REPAIR_TIMER]["ActiveState"] == "active",
            "final repair timer is not active")
    require(repair["repair_units"][REPAIR_PATH_UNIT]["ActiveState"]
            == "inactive", "final repair path is not inactive")
    require(repair["repair_units"][REPAIR_PATH_UNIT]["UnitFileState"]
            == "enabled", "final repair path is not enabled")
    require(repair["repair_files"]["staged"]["type"] == "missing",
            "final repair state retains a staged target")
    require(repair["repair_files"]["trigger"]["type"] == "missing",
            "final repair state retains the path trigger")
    require(not REPAIR_PAUSE_MARKER.exists(),
            "final repair state retains the pause marker")
    for rogue in (UNIT_DIR / "crq-repair.socket",
                  REPAIR_DROPIN_DIR / "20-rogue.conf",
                  UNIT_DIR / "default.target.wants" / REPAIR_TIMER):
        require(not rogue.exists() and not rogue.is_symlink(),
                "final repair state retains a rogue inventory entry: "
                + str(rogue))
    saved = baseline()
    require(tick["state"] == saved["state"],
            "final tick state changed the preserved queue/heartbeat bytes")
    require(tick["history"]["sha256"] == saved["history_sha256"],
            "final tick state changed the historical record")
    require([item["path"] for item in tick["records"]]
            == saved["record_paths"],
            "final tick state changed the original record set")
    require(tick["units"][TIMER]["ActiveState"] == "inactive",
            "final tick timer is not inactive")
    require(tick["units"][TIMER]["UnitFileState"] == "enabled",
            "final tick timer is not enabled")
    unrelated_path = FIXTURE / "activators-unrelated.json"
    require(unrelated_path.is_file(), "unrelated process identity is missing")
    unrelated = json.loads(unrelated_path.read_text())
    state = process_state(unrelated["pid"])
    require(state["alive"], "the switch signalled the unrelated process")
    require(state.get("starttime") == unrelated.get("starttime"),
            "the unrelated process identity changed")
    try:
        os.killpg(unrelated["pid"], 15)
    except ProcessLookupError:
        pass
    deadline = time.time() + 5
    while time.time() < deadline and process_state(unrelated["pid"])["alive"]:
        time.sleep(0.1)
    require(not process_state(unrelated["pid"])["alive"],
            "harness cleanup did not stop the unrelated process")
    unrelated_path.unlink(missing_ok=True)
    return {"phase": "activators-inspect", "repair": repair, "tick": tick,
            "unrelated": {"pid": unrelated["pid"],
                          "starttime": unrelated.get("starttime"),
                          "alive_before_cleanup": True,
                          "alive_after_cleanup": False},
            "preserved": check_preserved({"phase": "activators-inspect"})}


def main(argv=None):
    phases = ("prepare", "drain-alive", "switch-node", "drain-ambiguous",
              "switch-python", "drain-harvest", "interrupt",
              "recover-drain-alive", "recover-kill", "recover",
              "recover-repeat", "rollback-fence", "inspect", "fence",
              "host-identity", "matrix-switch-node",
              "matrix-reset-python", "matrix-reset-python-final",
              *MATRIX_CASES.keys(),
              *(name + "-observe" for name in MATRIX_CASES),
              *ACTIVATOR_PHASES)
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=phases)
    parser.add_argument("--record")
    parser.add_argument("--boundary")
    parser.add_argument("--kind", choices=("manager", "reboot"))
    parser.add_argument("--after")
    parser.add_argument("--runtime", choices=(PYTHON_RUNTIME, NODE_RUNTIME))
    parser.add_argument("--seed", choices=("alive", "ambiguous", "harvest"))
    parser.add_argument("--label")
    args = parser.parse_args(argv)
    try:
        if args.phase == "prepare":
            payload = phase_prepare(args)
        elif args.phase in ("drain-alive", "drain-ambiguous"):
            payload = drain_refuse_phase(args)
        elif args.phase == "switch-node":
            payload = switch_phase(NODE_RUNTIME)
        elif args.phase == "switch-python":
            payload = switch_phase(PYTHON_RUNTIME)
        elif args.phase == "drain-harvest":
            payload = drain_harvest_phase(args)
        elif args.phase == "interrupt":
            payload = interrupt_phase(args)
        elif args.phase == "recover-drain-alive":
            payload = recover_drain_refuse_phase(args)
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
        elif args.phase == "activators-install":
            payload = activators_install(args)
        elif args.phase == "activators-positive":
            payload = activators_positive(args)
        elif args.phase == "activators-unknown":
            payload = activators_unknown(args)
        elif args.phase == "activators-fence":
            payload = activators_fence(args)
        elif args.phase == "activators-switch-back":
            payload = activators_switch_back(args)
        elif args.phase == "activators-interrupt":
            payload = activators_interrupt(args)
        elif args.phase == "activators-recover":
            payload = activators_recover(args)
        elif args.phase == "activators-repeat":
            payload = activators_repeat(args)
        elif args.phase == "activators-inspect":
            payload = activators_inspect(args)
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
