#!/usr/bin/env python3
"""Harmless guest fixtures for the CRQ unit-switch VM feasibility probe.

This script runs inside a disposable guest as the isolated probe user. It
installs only *fixture* units named ``crq-fixture-*``/``crq-queued-*`` and never
touches a real CRQ checkout, controller, journal, credential or provider. It
records what it observes as JSON on stdout; the host-side harness stores that
output outside the repository.

The probe distinguishes two mask mechanisms:

* ``systemctl --user mask`` refuses a unit file that is already installed in
  the same user config directory; the command result and the unchanged load
  state are recorded as evidence.
* Replacing that installed path with a symlink to ``/dev/null`` after retaining
  the original is the durable fence the design actually needs. It is the
  mechanism exercised across a real manager restart and a guest reboot.

Phases:
    install    write the fixture units, reload, enable timer/path, snapshot
    activation direct, dependency and queued-job activation before masking
    mask       native-mask refusal, durable replacement, refusal and activator
    inspect    re-observe an already-masked guest (after manager restart/reboot)
    unmask     restore the installed units and prove the fixture runs again

This is feasibility evidence only. It does not implement, validate or enable a
production host adapter, and a green result here is not controller acceptance.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time

HOME = pathlib.Path.home()
FIXTURE = HOME / "fixture"
UNIT_DIR = HOME / ".config/systemd/user"
RUNS = FIXTURE / "runs.jsonl"
RECORD = FIXTURE / "record.sh"
TRIGGER = FIXTURE / "trigger"
UNITS = [
    "crq-fixture.service",
    "crq-fixture.timer",
    "crq-fixture.path",
    "crq-dependent.service",
    "crq-alias.service",
    "crq-blocker.service",
    "crq-queued.service",
    "crq-queued-fixture.service",
]
SNAPSHOT_PATHS = [
    UNIT_DIR / "crq-fixture.service",
    UNIT_DIR / "crq-fixture.timer",
    UNIT_DIR / "crq-fixture.path",
    UNIT_DIR / "crq-dependent.service",
    UNIT_DIR / "crq-alias.service",
    UNIT_DIR / "crq-blocker.service",
    UNIT_DIR / "crq-queued.service",
    UNIT_DIR / "crq-queued-fixture.service",
    UNIT_DIR / "timers.target.wants/crq-fixture.timer",
    UNIT_DIR / "default.target.wants/crq-fixture.path",
    FIXTURE / "crq-alias.service.unit",
    FIXTURE / "original-crq-fixture.service",
    FIXTURE / "original-crq-alias.service.link",
    RECORD,
    TRIGGER,
]
ACTIONS = []


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(argv, timeout=60):
    """Run one observable command and record its exact result."""
    started = time.time()
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        record = {"argv": argv, "rc": result.returncode,
                  "stdout": result.stdout[-4000:], "stderr": result.stderr[-4000:],
                  "seconds": round(time.time() - started, 3)}
    except subprocess.TimeoutExpired as exc:
        record = {"argv": argv, "rc": None, "timeout": True,
                  "stdout": (exc.stdout or "")[-4000:],
                  "stderr": (exc.stderr or "")[-4000:],
                  "seconds": round(time.time() - started, 3)}
    ACTIONS.append(record)
    return record


def systemctl(*args, timeout=60):
    return run(["systemctl", "--user", *args], timeout=timeout)


def boot_id():
    return pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def manager_identity():
    """The real user-manager identity from the system manager's view."""
    uid = os.getuid()
    result = run(["sudo", "-n", "systemctl", "show", "user@%d.service" % uid,
                  "-p", "MainPID", "-p", "InvocationID",
                  "-p", "ActiveEnterTimestampMonotonic"])
    props = {}
    for line in (result.get("stdout") or "").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            props[key] = value
    pid = int(props.get("MainPID") or 0)
    start_time = None
    if pid > 0:
        try:
            fields = pathlib.Path("/proc/%d/stat" % pid).read_text().rsplit(") ", 1)[1].split()
            start_time = fields[19]
        except (OSError, IndexError):
            start_time = None
    return {"pid": pid, "invocation_id": props.get("InvocationID"),
            "active_enter_monotonic": props.get("ActiveEnterTimestampMonotonic"),
            "proc_starttime": start_time}


def file_state(path):
    path = pathlib.Path(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    data = {"path": str(path), "mode": oct(info.st_mode & 0o7777),
            "uid": info.st_uid, "gid": info.st_gid, "size": info.st_size}
    if path.is_symlink():
        data["type"] = "symlink"
        data["link_target"] = os.readlink(path)
    elif path.is_file():
        data["type"] = "file"
        data["sha256"] = sha256(path)
    else:
        data["type"] = "other"
    return data


def unit_state(name):
    result = systemctl("show", name, "-p",
                       "LoadState,ActiveState,SubState,UnitFileState,FragmentPath,"
                       "InvocationID,Result,CanStart,CanReload,NeedDaemonReload")
    props = {}
    for line in (result.get("stdout") or "").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            props[key] = value
    return props


def jobs():
    result = systemctl("list-jobs", "--no-legend", "--no-pager")
    lines = [line for line in (result.get("stdout") or "").splitlines() if line.strip()]
    return lines


def runs():
    if not RUNS.exists():
        return []
    entries = []
    for line in RUNS.read_text().splitlines():
        if line.strip():
            try:
                entries.append(json.loads(line))
            except ValueError:
                entries.append({"malformed": line[:200]})
    return entries


def snapshot():
    return {
        "phase_at": time.time(),
        "boot_id": boot_id(),
        "manager": manager_identity(),
        "units": {name: unit_state(name) for name in UNITS},
        "files": {str(path): file_state(path) for path in SNAPSHOT_PATHS},
        "jobs": jobs(),
        "runs": runs(),
        "systemd_version": (run(["systemctl", "--version"]).get("stdout") or "").splitlines()[:1],
    }


def write(path, text, mode=0o644):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


def unit_text(label):
    return """[Unit]
Description=CRQ VM probe fixture service
[Service]
Type=oneshot
ExecStart=/home/probe/fixture/record.sh %s
""" % label


def alias_text():
    return """[Unit]
Description=CRQ VM probe alias-installed fixture
[Service]
Type=oneshot
ExecStart=/home/probe/fixture/record.sh alias
"""


def queued_text():
    return """[Unit]
Description=CRQ VM probe unit whose start is queued behind a blocker
After=crq-blocker.service
[Service]
Type=oneshot
ExecStart=/home/probe/fixture/record.sh queued-fixture
"""


def install_units():
    FIXTURE.mkdir(parents=True, exist_ok=True)
    UNIT_DIR.mkdir(parents=True, exist_ok=True)
    write(RECORD, """#!/bin/sh
set -eu
printf '{"label":"%s","at":%s,"boot_id":"%s","invocation":"%s","manager":"%s"}\\n' \\
  "$1" "$(date +%s.%N)" "$(cat /proc/sys/kernel/random/boot_id)" \\
  "${INVOCATION_ID:-}" "$(ps -u "$(id -u)" -o pid=,args= | sed -n 's#^ *\\([0-9]*\\) .*systemd --user#\\1#p' | head -1)" \\
  >> "$HOME/fixture/runs.jsonl"
""", 0o750)
    # The main fixture is a regular installed file, matching prepare-host's
    # atomic write. A separate alias case exercises a symlink-installed unit.
    write(UNIT_DIR / "crq-fixture.service", unit_text("service"), 0o640)
    write(FIXTURE / "crq-alias.service.unit", alias_text())
    (FIXTURE / "crq-alias.service.unit").chmod(0o640)
    alias = UNIT_DIR / "crq-alias.service"
    if alias.is_symlink() or alias.exists():
        alias.unlink()
    alias.symlink_to("../../../fixture/crq-alias.service.unit")
    write(UNIT_DIR / "crq-fixture.timer", """[Unit]
Description=CRQ VM probe fixture timer

[Timer]
OnBootSec=1h
OnUnitActiveSec=1h
Unit=crq-fixture.service

[Install]
WantedBy=timers.target
""")
    write(UNIT_DIR / "crq-fixture.path", """[Unit]
Description=CRQ VM probe fixture path

[Path]
PathChanged=%h/fixture/trigger
Unit=crq-fixture.service

[Install]
WantedBy=default.target
""")
    write(UNIT_DIR / "crq-dependent.service", """[Unit]
Description=CRQ VM probe dependency-activated fixture
Requires=crq-fixture.service
After=crq-fixture.service

[Service]
Type=oneshot
ExecStart=/home/probe/fixture/record.sh dependent
""")
    write(UNIT_DIR / "crq-blocker.service", """[Unit]
Description=CRQ VM probe bounded job blocker

[Service]
Type=oneshot
ExecStart=/bin/sleep 20
TimeoutStartSec=60
""")
    write(UNIT_DIR / "crq-queued.service", """[Unit]
Description=CRQ VM probe queued start behind a blocker
After=crq-blocker.service
Wants=crq-queued-fixture.service

[Service]
Type=oneshot
ExecStart=/home/probe/fixture/record.sh queued
""")
    write(UNIT_DIR / "crq-queued-fixture.service", queued_text())
    result = {
        "install": {"daemon_reload": systemctl("daemon-reload"),
                    "enable": systemctl("enable", "crq-fixture.timer", "crq-fixture.path")},
        "snapshot": snapshot(),
    }
    return result


def start_ok(label, unit):
    before = len(runs())
    result = systemctl("start", unit)
    after = runs()[before:]
    return {"label": label, "unit": unit, "result": result,
            "run_delta": [entry.get("label") for entry in after]}


def mask_unit(name):
    """Replace an installed unit path with /dev/null, retaining the original.

    ``systemctl mask`` cannot do this for a unit file already installed in the
    same config directory; the caller records that refusal separately.
    """
    path = UNIT_DIR / name
    before = file_state(path)
    backup = FIXTURE / ("original-" + name)
    if path.is_symlink():
        backup = FIXTURE / ("original-" + name + ".link")
        backup.write_text(os.readlink(path))
    elif path.is_file():
        shutil.copy2(path, backup)
        backup.chmod(path.stat().st_mode & 0o777)
    else:
        raise FileNotFoundError("fixture unit is not installed: " + str(path))
    path.unlink()
    path.symlink_to("/dev/null")
    return {"unit": name, "before": before, "mask_target": "/dev/null",
            "backup": str(backup)}


def restore_unit(name):
    path = UNIT_DIR / name
    link_backup = FIXTURE / ("original-" + name + ".link")
    file_backup = FIXTURE / ("original-" + name)
    path.unlink(missing_ok=True)
    if link_backup.exists():
        path.symlink_to(link_backup.read_text())
        link_backup.unlink()
    elif file_backup.exists():
        shutil.copy2(file_backup, path)
        file_backup.unlink()
    else:
        raise FileNotFoundError("no retained original for " + name)


def wait_jobs(unit, present, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        lines = jobs()
        if any(unit in line for line in lines) == present:
            return lines
        time.sleep(0.25)
    return jobs()


def wait_jobs_settle(units, timeout):
    """Wait until none of the queued wrapper/fixture jobs remain."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        lines = jobs()
        if not any(unit in line for line in lines for unit in units):
            return {"settled": True, "jobs": lines}
        time.sleep(0.25)
    return {"settled": False, "jobs": jobs()}


def activation():
    result = {"direct": start_ok("direct", "crq-fixture.service"),
              "dependency": start_ok("dependency", "crq-dependent.service")}

    # Round 1: queue both the wrapper and its wanted fixture behind the
    # blocker, then replace the fixture's installed path with /dev/null while
    # the job is still queued. This is the design's durable fence, not
    # systemctl mask (which cannot replace a local unit file).
    before = len(runs())
    result["queued_native_mask"] = systemctl("mask", "crq-queued-fixture.service")
    result["queue_blocker"] = systemctl("start", "--no-block", "crq-blocker.service")
    result["jobs_waiting_blocker"] = wait_jobs("crq-blocker.service", True, 15)
    result["queue_start"] = systemctl("start", "--no-block", "crq-queued.service")
    result["jobs_before_mask"] = wait_jobs("crq-queued-fixture.service", True, 15)
    result["mask"] = mask_unit("crq-queued-fixture.service")
    result["reload"] = systemctl("daemon-reload")
    result["masked_state"] = unit_state("crq-queued-fixture.service")
    result["jobs_after_mask"] = jobs()
    result["jobs_after_release"] = wait_jobs("crq-blocker.service", False, 40)
    result["queued_jobs_after_release"] = wait_jobs_settle(
        ("crq-queued.service", "crq-queued-fixture.service"), 40)
    result["queued_run_delta"] = [entry.get("label") for entry in runs()[before:]]
    result["queued_state"] = unit_state("crq-queued.service")
    result["queued_fixture_state"] = unit_state("crq-queued-fixture.service")
    result["restore_queued_fixture"] = restore_unit("crq-queued-fixture.service")
    result["reload_after_restore"] = systemctl("daemon-reload")

    # Round 2: same queue, but explicitly stop the pending unit before
    # replacing the path and releasing the blocker.
    before = len(runs())
    result["queue2_blocker"] = systemctl("start", "--no-block", "crq-blocker.service")
    wait_jobs("crq-blocker.service", True, 15)
    result["queue2_start"] = systemctl("start", "--no-block", "crq-queued.service")
    result["jobs2_before_stop"] = wait_jobs("crq-queued-fixture.service", True, 15)
    result["stop_queued_fixture"] = systemctl("stop", "crq-queued-fixture.service")
    result["jobs2_after_stop"] = jobs()
    result["mask2"] = mask_unit("crq-queued-fixture.service")
    result["reload2"] = systemctl("daemon-reload")
    result["jobs2_after_release"] = wait_jobs("crq-blocker.service", False, 40)
    result["queued_jobs2_after_release"] = wait_jobs_settle(
        ("crq-queued.service", "crq-queued-fixture.service"), 40)
    result["queued2_run_delta"] = [entry.get("label") for entry in runs()[before:]]
    result["restore_queued_fixture2"] = restore_unit("crq-queued-fixture.service")
    result["reload2_after_restore"] = systemctl("daemon-reload")
    return result


def mask():
    before = len(runs())
    result = {}
    # Start the real activators first, as they would be on a live host.
    result["timer_start_before"] = systemctl("start", "crq-fixture.timer")
    result["path_start_before"] = systemctl("start", "crq-fixture.path")
    result["timer_before"] = unit_state("crq-fixture.timer")
    result["path_before"] = unit_state("crq-fixture.path")
    # Negative observation: the native mask cannot replace a local unit file.
    result["native_mask"] = systemctl("mask", "crq-fixture.service")
    result["native_mask_state"] = unit_state("crq-fixture.service")
    result["durable_mask"] = mask_unit("crq-fixture.service")
    result["daemon_reload"] = systemctl("daemon-reload")
    result["service_state"] = unit_state("crq-fixture.service")
    result["timer_after_mask"] = unit_state("crq-fixture.timer")
    result["path_after_mask"] = unit_state("crq-fixture.path")
    result["direct"] = systemctl("start", "crq-fixture.service")
    result["dependency"] = systemctl("start", "crq-dependent.service")
    # Leave the path active across the mask and trigger it: the watched path
    # must not start the masked service.
    TRIGGER.write_text("trigger\n")
    time.sleep(3)
    result["timer_after_trigger"] = unit_state("crq-fixture.timer")
    result["path_after_trigger"] = unit_state("crq-fixture.path")
    # Adapter step: stop the activators after the fence is established.
    result["stop_activators"] = systemctl("stop", "crq-fixture.timer",
                                          "crq-fixture.path")
    result["timer_after_stop"] = unit_state("crq-fixture.timer")
    result["path_after_stop"] = unit_state("crq-fixture.path")
    result["timer_start_while_masked"] = systemctl("start", "crq-fixture.timer")
    result["path_start_while_masked"] = systemctl("start", "crq-fixture.path")
    # Alias-installed unit: the same native refusal, then the durable
    # replacement, then restore so the snapshot retains the alias metadata.
    result["alias_native_mask"] = systemctl("mask", "crq-alias.service")
    result["alias_native_state"] = unit_state("crq-alias.service")
    result["alias_durable_mask"] = mask_unit("crq-alias.service")
    result["alias_reload"] = systemctl("daemon-reload")
    result["alias_masked_state"] = unit_state("crq-alias.service")
    result["alias_direct"] = systemctl("start", "crq-alias.service")
    result["alias_restore"] = restore_unit("crq-alias.service")
    result["alias_reload_restore"] = systemctl("daemon-reload")
    result["run_delta"] = [entry.get("label") for entry in runs()[before:]]
    result["snapshot"] = snapshot()
    return result


def inspect():
    result = {"direct": systemctl("start", "crq-fixture.service"),
              "dependency": systemctl("start", "crq-dependent.service"),
              "snapshot": snapshot()}
    return result


def unmask():
    before = len(runs())
    result = {"restore": restore_unit("crq-fixture.service"),
              "daemon_reload": systemctl("daemon-reload"),
              "service_state": unit_state("crq-fixture.service")}
    result["direct"] = systemctl("start", "crq-fixture.service")
    result["run_delta"] = [entry.get("label") for entry in runs()[before:]]
    result["snapshot"] = snapshot()
    return result


PHASES = {"install": install_units, "activation": activation, "mask": mask,
          "inspect": inspect, "unmask": unmask}


def main(argv):
    if len(argv) != 2 or argv[1] not in PHASES:
        print("usage: vm-guest-probe.py " + "|".join(PHASES), file=sys.stderr)
        return 2
    output = PHASES[argv[1]]()
    output["phase"] = argv[1]
    output["actions"] = ACTIONS
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
