#!/usr/bin/env python3
"""Host-side harness for the isolated unit-switch proof vehicle.

Reuses the existing ``vm-feasibility.py`` QEMU lifecycle (image verification,
fresh overlay, bounded QEMU scope, SSH, owned-process cleanup), uploads the
actual controller, proof adapter, CLI, fixture and guest driver by exact bytes,
runs the proof phases in a disposable guest, and retains the raw scripts,
guest tarball and report outside the worktree.

This is not production enablement. It does not touch a production host,
checkout, journal, credential or provider, and it does not test manager
restart or guest reboot. Those remain later bounded work.
"""
from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

OPS = pathlib.Path(__file__).resolve().parent
REPO = OPS.parents[2]
SCHEMA_VERSION = 1
KIND = "crq-unit-switch-proof"
UPLOADS = (
    "deploy-controller.py",
    "unit-switch-adapter.py",
    "unit-switch.py",
    "unit-switch-fixture.py",
    "unit-switch-fixture.mjs",
    "vm-unit-switch-guest.py",
)
RUNNER_ARCHIVE = "crq-runner-source.tar.gz"
HOST_MODULES = (
    "vm-unit-switch.py",
    "vm-feasibility.py",
)
GUEST_PHASES = ("prepare", "drain-alive", "switch-node", "drain-ambiguous",
                "switch-python", "drain-harvest", "interrupt",
                "recover-drain-alive", "recover-kill", "recover",
                "recover-repeat", "rollback-fence", "inspect", "fence")
NODE_RUNTIME = "node:" + "b" * 40
PYTHON_RUNTIME = "python"

# Restart/reboot matrix. Each case interrupts the actual controller at one
# durable boundary, the host restarts the real guest user manager or reboots
# the guest, and the guest then observes the retained journal, fence, metadata
# and owned work before invoking the actual recovery CLI twice.
MATRIX_CASES = {
    "matrix-restart-drained": {
        "kind": "manager", "boundary": "drained",
        "runtime": NODE_RUNTIME, "prior_runtime": PYTHON_RUNTIME,
        "record_dir": "records"},
    "matrix-restart-restore-staged": {
        "kind": "manager", "boundary": "restore_staged",
        "runtime": NODE_RUNTIME, "prior_runtime": PYTHON_RUNTIME,
        "record_dir": "records"},
    "matrix-restart-ambiguity": {
        "kind": "manager", "boundary": "activation_pending",
        "runtime": NODE_RUNTIME, "prior_runtime": PYTHON_RUNTIME,
        "record_dir": "records/ambiguity-manager-restart"},
    "matrix-reboot-drained": {
        "kind": "reboot", "boundary": "drained",
        "runtime": PYTHON_RUNTIME, "prior_runtime": NODE_RUNTIME,
        "record_dir": "records"},
    "matrix-reboot-restore-staged": {
        "kind": "reboot", "boundary": "restore_staged",
        "runtime": PYTHON_RUNTIME, "prior_runtime": NODE_RUNTIME,
        "record_dir": "records"},
    "matrix-reboot-ambiguity": {
        "kind": "reboot", "boundary": "activation_pending",
        "runtime": PYTHON_RUNTIME, "prior_runtime": NODE_RUNTIME,
        "record_dir": "records/ambiguity-guest-reboot"},
}
MATRIX_ORDER = tuple(MATRIX_CASES)
MATRIX_GUEST_PHASES = GUEST_PHASES[:-1] + (
    "matrix-restart-drained", "matrix-restart-drained-observe",
    "matrix-restart-restore-staged",
    "matrix-restart-restore-staged-observe",
    "matrix-restart-ambiguity", "matrix-restart-ambiguity-observe",
    "matrix-reset-python", "matrix-switch-node",
    "matrix-reboot-drained", "matrix-reboot-drained-observe",
    "matrix-reboot-restore-staged",
    "matrix-reboot-restore-staged-observe",
    "matrix-reboot-ambiguity", "matrix-reboot-ambiguity-observe",
    "matrix-reset-python-final", "fence")

ACTIVATOR_GUEST_PHASES = (
    "prepare", "activators-install", "activators-positive",
    "activators-unknown", "activators-fence", "activators-switch-back",
    "activators-interrupt", "activators-recover", "activators-repeat",
    "activators-inspect")


def phase_names(mode="base"):
    if mode == "matrix":
        return MATRIX_GUEST_PHASES
    if mode == "activators":
        return ACTIVATOR_GUEST_PHASES
    return GUEST_PHASES


HEX40 = re.compile(r"[0-9a-f]{40}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
HEX32 = re.compile(r"[0-9a-f]{32}\Z")
LIMITATIONS = [
    "One representative harmless fixture is installed under the allowlisted "
    "unit name crq-tick.service; no production template is rendered.",
    "Python and Node fixtures are fake unit-scoped completion sources. No real "
    "CRQ runtime completion exists and no CQ enablement is implied.",
    "The guest user manager is not restarted and the guest is not rebooted; "
    "that matrix remains later bounded work.",
    "The drain proof seeds real detached session-leader processes and real "
    "runner metadata. It covers recorded alive, ownership-ambiguous and "
    "completed/dead runs only: a process whose ownership is not represented "
    "by queue run metadata and a runner pidfile is not claimed as detected.",
    "No production run_liveness provider, queue-runner runtime, adapter, "
    "journal location or shared lock identity is exercised or enabled.",
    "Production journal interoperability, legacy resolution and the actual "
    "deployed record location remain unresolved and are not tested here.",
    "A guest run is not power-loss, ACL, xattr or privileged-ownership proof.",
]
MATRIX_LIMITATIONS = [
    "One representative harmless fixture is installed under the allowlisted "
    "unit name crq-tick.service; no production template is rendered.",
    "Python and Node fixtures are fake unit-scoped completion sources. No real "
    "CRQ runtime completion exists and no CQ enablement is implied.",
    "The matrix restarts the real guest user manager and reboots the real guest "
    "OS at the tested boundaries. It is not power-loss proof, and the guest is "
    "not a production host.",
    "Drain coverage is limited to recorded runs with genuine runner metadata. "
    "An ownership-ambiguous record with no live evidence is retained; an "
    "unrepresented escaped process is an explicit uncovered semantics "
    "question, not a detection claim.",
    "Activation-pending ambiguity is retained in a separate private record "
    "directory per case so independent cases do not block each other. That is "
    "test isolation, not a resolution mechanism or a fix for the known "
    "cross-directory journal interoperability gap.",
    "Production journal interoperability, legacy resolution and the actual "
    "deployed record location remain unresolved and are not tested here.",
    "A guest run is not ACL, xattr or privileged-ownership proof.",
]
ACTIVATOR_LIMITATIONS = [
    "Two declared harmless guest topologies are installed: crq-tick.service "
    "with a timer, and crq-repair.service with a timer, a path activator and "
    "one declared blocker drop-in. No production template is rendered.",
    "The inventory is an allowlisted guest topology, not exhaustive production "
    "activator discovery. Other-name dependency units, default-target links and "
    "socket units outside the exact declared paths remain a production "
    "inventory gap.",
    "Python and Node fixtures are fake unit-scoped completion sources. No real "
    "CRQ runtime completion exists and no CQ enablement is implied.",
    "The drain proof covers recorded runs with genuine runner metadata only. "
    "A process whose ownership is not represented by queue run metadata and a "
    "runner pidfile is not claimed as detected; the dispatch race remains "
    "explicitly uncovered.",
    "The queue and drain gates are point-in-time observations. The guest "
    "observes cancellation after the adapter's stop settlement, but it is not "
    "proof that no work can start in a production dispatch race.",
    "Path-topology manager restart and guest reboot are not exercised in this "
    "slice. The existing restart/reboot matrix covers the tick topology only.",
    "No production run_liveness provider, queue-runner runtime, adapter, "
    "journal location or shared lock identity is exercised or enabled.",
    "Production journal interoperability, legacy resolution and the actual "
    "deployed record location remain unresolved and are not tested here.",
    "A guest run is not power-loss, ACL, xattr or privileged-ownership proof.",
]


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vm = _load("crq_vm_feasibility", OPS / "vm-feasibility.py")
RECORDS_DIR = "/home/%s/records" % vm.GUEST_USER
FIXTURE_DIR = "/home/%s/fixture" % vm.GUEST_USER
UNIT_DIR = "/home/%s/.config/systemd/user" % vm.GUEST_USER
SERVICE_PATH = UNIT_DIR + "/crq-tick.service"
TIMER_PATH = UNIT_DIR + "/crq-tick.timer"
WANTS_PATH = UNIT_DIR + "/timers.target.wants/crq-tick.timer"
STAGED_PATH = UNIT_DIR + "/.crq-tick.service.staged"
COMPLETIONS_PATH = FIXTURE_DIR + "/completions.jsonl"
HISTORY_PATH = RECORDS_DIR + "/controller-" + "a" * 32 + ".json"
CASE_RECORD_DIRS = (RECORDS_DIR + "/ambiguity-manager-restart",
                    RECORDS_DIR + "/ambiguity-guest-reboot")
RECORD_ROOTS = (RECORDS_DIR,) + CASE_RECORD_DIRS
adapter_mod = _load("crq_unit_switch_adapter", OPS / "unit-switch-adapter.py")


def sha256_bytes(data):
    return vm.sha256_bytes(data)


def render_user_data(public_key):
    key = public_key.strip()
    if not key.startswith(("ssh-ed25519 ", "ecdsa-sha2-", "ssh-rsa ")):
        raise ValueError("public key is not an SSH key line")
    return """#cloud-config
hostname: crq-probe
manage_etc_hosts: true
users:
  - name: {user}
    groups: [sudo]
    shell: /bin/bash
    lock_passwd: true
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - {key}
ssh_pwauth: false
disable_root: true
package_update: true
package_upgrade: false
packages:
  - git
  - nodejs
runcmd:
  - [loginctl, enable-linger, {user}]
  - [mkdir, -p, /home/{user}/fixture]
  - [mkdir, -p, /home/{user}/proof-bin]
  - [mkdir, -p, /home/{user}/records]
  - [chown, {user}:{user}, /home/{user}/fixture]
  - [chown, {user}:{user}, /home/{user}/proof-bin]
  - [chown, {user}:{user}, /home/{user}/records]
""".format(user=vm.GUEST_USER, key=key)


def prepare_run(state, image, recorder, tools):
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + os.urandom(4).hex()
    run = state / "runs" / run_id
    run.mkdir(parents=True, exist_ok=False)
    key = run / vm.SSH_KEY
    recorder.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C",
                  "crq-unit-switch-" + run_id, "-f", str(key)], check=True)
    public_key = (run / (vm.SSH_KEY + ".pub")).read_text()
    (run / "user-data").write_text(render_user_data(public_key))
    (run / "meta-data").write_text(vm.render_meta_data("crq-proof-" + run_id))
    recorder.run([vm.tool("cloud-localds", tools), str(run / "seed.iso"),
                  str(run / "user-data"), str(run / "meta-data")],
                 check=True, cwd=run)
    recorder.run([vm.tool("qemu-img", tools), "create", "-f", "qcow2",
                  "-b", image["path"], "-F", "qcow2",
                  str(run / "overlay.qcow2"), vm.OVERLAY_SIZE],
                 check=True, cwd=run)
    return {"run_id": run_id, "path": str(run), "image": image,
            "port": vm.free_port(), "started_at": vm.utc_now()}


def upload_files(run, recorder):
    provenance = {}
    for name in UPLOADS:
        source = OPS / name
        data = source.read_bytes()
        local_sha = sha256_bytes(data)
        remote = ("cat > /home/%s/proof-bin/%s && chmod 700 /home/%s/proof-bin/%s"
                  % (vm.GUEST_USER, name, vm.GUEST_USER, name))
        result = vm.guest_ssh(run, remote, recorder, stdin=data,
                              max_output=2000)
        if result["rc"] != 0:
            raise RuntimeError("upload failed for %s: %s" % (name, result["stderr"]))
        check = vm.guest_ssh(
            run, "sha256sum /home/%s/proof-bin/%s" % (vm.GUEST_USER, name),
            recorder, timeout=30)
        observed = (check.get("stdout") or "").split()
        remote_sha = observed[0] if observed else ""
        if check["rc"] != 0 or remote_sha != local_sha:
            raise RuntimeError("uploaded digest mismatch for %s: %s != %s"
                               % (name, remote_sha, local_sha))
        provenance[name] = {"sha256": local_sha, "remote_sha256": remote_sha,
                            "bytes": len(data), "verified": True}
    archive = pathlib.Path(run["path"]) / RUNNER_ARCHIVE
    result = subprocess.run(
        ["git", "-C", str(REPO), "archive", "--format=tar.gz",
         "--output", str(archive), "HEAD", "apps/crq-python"],
        capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError("could not build the committed runner source archive: "
                           + (result.stderr or "").strip()[:400])
    data = archive.read_bytes()
    local_sha = sha256_bytes(data)
    remote = ("cat > /home/%s/proof-bin/%s && chmod 600 /home/%s/proof-bin/%s"
              % (vm.GUEST_USER, RUNNER_ARCHIVE, vm.GUEST_USER, RUNNER_ARCHIVE))
    uploaded = vm.guest_ssh(run, remote, recorder, stdin=data, max_output=2000)
    if uploaded["rc"] != 0:
        raise RuntimeError("runner source upload failed: "
                           + (uploaded.get("stderr") or "")[:400])
    check = vm.guest_ssh(
        run, "sha256sum /home/%s/proof-bin/%s" % (vm.GUEST_USER, RUNNER_ARCHIVE),
        recorder, timeout=30)
    observed = (check.get("stdout") or "").split()
    remote_sha = observed[0] if observed else ""
    if check["rc"] != 0 or remote_sha != local_sha:
        raise RuntimeError("runner source archive digest mismatch: %s != %s"
                           % (remote_sha, local_sha))
    provenance["runner_source"] = {
        "name": RUNNER_ARCHIVE, "sha256": local_sha,
        "remote_sha256": remote_sha, "bytes": len(data), "verified": True,
        "source": "git-archive:HEAD:apps/crq-python"}
    return provenance


def guest_phase(run, phase, recorder, extra=None, artifact=None):
    command = ("python3 /home/%s/proof-bin/vm-unit-switch-guest.py %s"
               % (vm.GUEST_USER, phase))
    if extra:
        command += " " + " ".join(extra)
    result = vm.guest_ssh(run, command, recorder, timeout=600, max_output=None)
    run_dir = pathlib.Path(run["path"])
    (run_dir / "phases").mkdir(exist_ok=True)
    name = artifact or phase
    (run_dir / "phases" / (name + ".stdout")).write_text(
        (result.get("stdout") or "") + (result.get("stderr") or ""))
    if result["rc"] != 0:
        raise RuntimeError("guest phase %s failed: %s" % (
            phase, (result.get("stdout") or result.get("stderr") or "")[-1200:]))
    try:
        payload = json.loads(result["stdout"])
    except ValueError as exc:
        raise RuntimeError("guest phase %s emitted invalid JSON" % phase) from exc
    (run_dir / "phases" / (name + ".json")).write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return payload


def host_identity(run, recorder, label):
    return guest_phase(run, "host-identity", recorder,
                       ["--label", label], artifact=label)


def restart_user_manager(run, recorder, boot, label):
    """Restart the real guest user manager; daemon-reload is not a restart."""
    before = host_identity(run, recorder, "identity-before-" + label)
    started = vm.utc_now()
    result = vm.guest_ssh(
        run, "sudo -n systemctl restart user@$(id -u).service",
        recorder, timeout=120)
    if result["rc"] != 0:
        raise RuntimeError("user manager restart failed: " + result["stderr"])
    ready = vm.wait_manager_ready(run, recorder)
    after = host_identity(run, recorder, "identity-after-" + label)
    run_dir = pathlib.Path(run["path"])
    verified = vm.process_matches(boot["pid"], boot["starttime"],
                                  str(run_dir / "overlay.qcow2"))
    if before["boot_id"] != after["boot_id"]:
        raise RuntimeError("manager restart changed the guest boot ID")
    if before["manager"]["invocation_id"] == after["manager"]["invocation_id"]:
        raise RuntimeError("manager restart did not change the manager identity")
    if not verified:
        raise RuntimeError("manager restart lost the QEMU process identity")
    return {"label": label, "kind": "user_manager_restart",
            "command": result, "started_at": started,
            "finished_at": vm.utc_now(), "ready": ready,
            "before": before, "after": after,
            "boot_id_changed": False,
            "manager_invocation_changed": True,
            "qemu_identity_verified": verified}


def reboot_guest_os(run, recorder, boot, label):
    """Reboot the guest OS and reconnect from the surviving host harness."""
    before = host_identity(run, recorder, "identity-before-" + label)
    issued = vm.guest_ssh(run, "sudo -n systemctl reboot", recorder,
                          timeout=20)
    deadline = time.time() + 300
    attempts = 0
    failures = 0
    boot_after = None
    while time.time() < deadline:
        attempts += 1
        result = vm.guest_ssh(run, "cat /proc/sys/kernel/random/boot_id",
                              recorder, timeout=15)
        observed = (result.get("stdout") or "").strip()
        if result["rc"] == 0 and observed and observed != before["boot_id"]:
            boot_after = observed
            break
        if result["rc"] != 0:
            failures += 1
        time.sleep(1)
    if not boot_after:
        raise RuntimeError("guest boot ID did not change after reboot")
    ssh_ready = vm.wait_ssh(run, recorder, timeout=300)
    manager_ready = vm.wait_manager_ready(run, recorder)
    after = host_identity(run, recorder, "identity-after-" + label)
    run_dir = pathlib.Path(run["path"])
    verified = vm.process_matches(boot["pid"], boot["starttime"],
                                  str(run_dir / "overlay.qcow2"))
    if after["boot_id"] != boot_after or after["boot_id"] == before["boot_id"]:
        raise RuntimeError("guest reboot evidence is inconsistent")
    if before["manager"]["invocation_id"] == after["manager"]["invocation_id"]:
        raise RuntimeError("guest reboot did not change the manager identity")
    if not verified:
        raise RuntimeError("guest reboot lost the QEMU process identity")
    return {"label": label, "kind": "guest_reboot", "issued": issued,
            "boot_id_before": before["boot_id"],
            "boot_id_after": boot_after, "poll_attempts": attempts,
            "failed_connections": failures, "ssh_ready": ssh_ready,
            "manager_ready": manager_ready, "before": before,
            "after": after, "boot_id_changed": True,
            "manager_invocation_changed": True,
            "qemu_identity_verified": verified}


def fetch_raw(run, recorder, mode="base"):
    run_dir = pathlib.Path(run["path"])
    extra = ""
    if mode == "activators":
        extra = (
            " records-activators "
            ".config/systemd/user/crq-repair.service "
            ".config/systemd/user/crq-repair.timer "
            ".config/systemd/user/crq-repair.path "
            ".config/systemd/user/timers.target.wants/crq-repair.timer "
            ".config/systemd/user/default.target.wants/crq-repair.path "
            ".config/systemd/user/crq-repair.service.d/10-fence-proof.conf ")
    remote = ("cd /home/%s && tar -czf - fixture records proof-bin "
              "checkout/apps/crq-python/state%s "
              ".config/systemd/user/crq-tick.service "
              ".config/systemd/user/.crq-tick.service.staged "
              ".config/systemd/user/crq-tick.timer "
              ".config/systemd/user/timers.target.wants/crq-tick.timer "
              "| base64 -w0" % (vm.GUEST_USER, extra))
    result = vm.guest_ssh(run, remote, recorder, timeout=120, max_output=None)
    if result["rc"] != 0:
        raise RuntimeError("raw guest evidence fetch failed: " + result["stderr"])
    encoded = (result.get("stdout") or "").strip()
    if not encoded:
        raise RuntimeError("raw guest evidence is empty")
    data = base64.b64decode(encoded)
    raw_path = run_dir / "raw-guest-evidence.tar.gz"
    raw_path.write_bytes(data)
    extracted = run_dir / "raw"
    extracted.mkdir(exist_ok=True)
    extract_raw_archive(raw_path, extracted)
    return {"tar_sha256": sha256_bytes(data), "tar_bytes": len(data),
            "raw_tar": raw_path.name}


def extract_raw_archive(raw_path, destination):
    """Extract retained evidence fail-closed; no unfiltered tar extraction."""
    destination = pathlib.Path(destination)
    destination.mkdir(parents=True, exist_ok=True)

    def evidence_filter(member, dest_path):
        if (member.issym()
                and member.name == ".config/systemd/user/crq-tick.service"
                and member.linkname == "/dev/null"):
            return member
        return tarfile.data_filter(member, dest_path)

    with tarfile.open(raw_path, "r:gz") as archive:
        if not hasattr(tarfile, "data_filter"):
            raise RuntimeError("tarfile extraction filters unavailable; "
                               "refusing unfiltered extraction")
        archive.extractall(destination, filter=evidence_filter)


def expected_unit(runtime):
    adapter = adapter_mod.GuestFixtureAdapter(
        unit_dir=pathlib.Path("/home/%s/.config/systemd/user" % vm.GUEST_USER),
        fixture_dir=pathlib.Path("/home/%s/fixture" % vm.GUEST_USER),
        unit="crq-tick.service",
        proof_root=pathlib.Path("/home/%s/proof-bin" % vm.GUEST_USER),
        guest_only=False)
    return adapter.render_unit(runtime)


def _sha(text):
    return sha256_bytes(text.encode())


def _ok_phase(value, label, problems):
    if not isinstance(value, dict) or value.get("error"):
        problems.append(label + " is missing or failed: " + json.dumps(value)[:300])
        return False
    return True


def _expected_staged(spec):
    if spec["boundary"] == "drained":
        return {"type": "missing"}
    if spec["boundary"] == "restore_staged":
        return {"type": "file", "runtime": spec["prior_runtime"]}
    return {"type": "file", "runtime": spec["runtime"]}


def _direct_text(value):
    direct = (value.get("fence") or {}).get("direct_start") or {}
    return ((direct.get("stdout") or "") + (direct.get("stderr") or "")).lower()


def _boot_id(value):
    if not isinstance(value, str):
        return None
    if not re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
            value):
        return None
    return value


def _manager_identity(value):
    if not isinstance(value, dict):
        return None
    pid = value.get("pid")
    invocation = value.get("invocation_id")
    if not isinstance(pid, str) or not pid.isdigit() or int(pid) <= 0:
        return None
    if not isinstance(invocation, str) \
            or re.fullmatch(r"[0-9a-f]{32}", invocation) is None:
        return None
    return {"pid": pid, "invocation_id": invocation}


def _completions(value):
    if not isinstance(value, dict):
        return None
    completions = value.get("completions")
    return completions if isinstance(completions, list) else None


def _count(value, key):
    count = value.get(key)
    return count if type(count) is int and count >= 0 else None


def _empty_jobs(value):
    jobs = value.get("jobs")
    return isinstance(jobs, list) and not jobs


def _no_owned(value):
    owned = value.get("owned")
    if not isinstance(owned, dict):
        return False
    pids = owned.get("pids")
    return (owned.get("main_pid") == 0
            and isinstance(pids, list)
            and not pids)


def _sha_present(value):
    sha = value.get("sha256") if isinstance(value, dict) else None
    return isinstance(sha, str) and HEX64.fullmatch(sha) is not None


def _host_identity_ok(host, kind):
    before = host.get("before") or {}
    after = host.get("after") or {}
    before_boot = _boot_id(before.get("boot_id"))
    after_boot = _boot_id(after.get("boot_id"))
    before_manager = _manager_identity(before.get("manager"))
    after_manager = _manager_identity(after.get("manager"))
    if (before_boot is None or after_boot is None
            or before_manager is None or after_manager is None):
        return False
    boot_changed = before_boot != after_boot
    manager_changed = (before_manager["invocation_id"]
                       != after_manager["invocation_id"])
    if host.get("boot_id_changed") is not boot_changed:
        return False
    if host.get("manager_invocation_changed") is not manager_changed:
        return False
    if kind == "manager":
        if boot_changed or not manager_changed:
            return False
    else:
        if not boot_changed or not manager_changed:
            return False
        if _boot_id(host.get("boot_id_before")) != before_boot:
            return False
        if _boot_id(host.get("boot_id_after")) != after_boot:
            return False
    return True


def _ambiguity_retained(phase):
    if not isinstance(phase, dict):
        return False
    recovery = phase.get("recovery") or {}
    repeat = phase.get("repeat") or {}
    before = recovery.get("record_before") or {}
    after = recovery.get("record_after") or {}
    repeat_after = repeat.get("record_after") or {}
    return (
        (recovery.get("cli") or {}).get("rc") == 3
        and (repeat.get("cli") or {}).get("rc") == 3
        and _sha_present(before)
        and _sha_present(after)
        and _sha_present(repeat_after)
        and after["sha256"] == before["sha256"]
        and repeat_after["sha256"] == before["sha256"]
        and after.get("outcome") == "pending"
        and after.get("phase") == "activation_pending")


def _reset_preserved(phase):
    if not isinstance(phase, dict):
        return False
    before = phase.get("record_before") or {}
    after = phase.get("record_after") or {}
    return (
        _sha_present(before)
        and _sha_present(after)
        and after["sha256"] == before["sha256"]
        and phase.get("runtime") == PYTHON_RUNTIME
        and (phase.get("service") or {}).get("LoadState") == "loaded"
        and (phase.get("service") or {}).get("ActiveState") == "inactive"
        and (phase.get("timer") or {}).get("ActiveState") == "inactive"
        and (phase.get("timer") or {}).get("UnitFileState") == "enabled")


def _matrix_checks(phases, restarts, reboots, prepared, problems):
    checks = {}
    case_no_work = {}
    restarts = restarts or {}
    reboots = reboots or {}
    service_path = "/home/%s/.config/systemd/user/crq-tick.service" % vm.GUEST_USER
    for case in MATRIX_ORDER:
        spec = MATRIX_CASES[case]
        boundary = phases.get(case)
        observe = phases.get(case + "-observe")
        if not _ok_phase(boundary, case, problems) \
                or not _ok_phase(observe, case + "-observe", problems):
            for suffix in ("_boundary", "_identity", "_journal_metadata_fence",
                           "_recovery_outcome", "_preserved_state"):
                checks[case + suffix] = False
            case_no_work[case] = False
            continue
        record = boundary.get("record") or {}
        expected_phase = ("activation_pending"
                          if spec["boundary"] == "activation_pending"
                          else "drained")
        expected_staged = _expected_staged(spec)
        staged = boundary.get("staged") or {}
        fence = boundary.get("fence") or {}
        boundary_before = boundary.get("before") or {}
        boundary_after = boundary.get("snapshot") or {}
        boundary_before_completions = _completions(boundary_before)
        boundary_after_completions = _completions(boundary_after)
        boundary_before_count = _count(boundary, "completions_before")
        boundary_after_count = _count(boundary, "completions_after")
        boundary_counts_ok = (
            boundary_before_completions is not None
            and boundary_after_completions is not None
            and boundary_before_count is not None
            and boundary_after_count is not None
            and len(boundary_before_completions) == boundary_before_count
            and len(boundary_after_completions) == boundary_after_count
            and boundary_before_count == boundary_after_count
            and boundary_before_completions == boundary_after_completions)
        boundary_jobs_ok = _empty_jobs(boundary)
        boundary_owned_ok = _no_owned(boundary)
        checks[case + "_boundary"] = (
            (boundary.get("cli") or {}).get("rc") not in (0, None)
            and (spec["boundary"] != "restore_staged"
                 or (boundary.get("recovery_kill") or {}).get("rc")
                 not in (0, None))
            and record.get("outcome") == "pending"
            and record.get("phase") == expected_phase
            and record.get("runtime") == spec["runtime"]
            and record.get("prior_runtime") == spec["prior_runtime"]
            and (fence.get("service") or {}).get("LoadState") == "masked"
            and (fence.get("timer") or {}).get("ActiveState") in (
                "inactive", "failed")
            and staged.get("type") == expected_staged["type"]
            and (expected_staged.get("runtime") is None
                 or staged.get("runtime") == expected_staged["runtime"])
            and boundary_counts_ok
            and boundary_jobs_ok
            and boundary_owned_ok)

        observe_snapshot = observe.get("snapshot") or {}
        observe_completions = _completions(observe_snapshot)
        observe_before_count = _count(observe, "completions_before")
        observe_after_count = _count(observe, "completions_after")
        observe_counts_ok = (
            observe_completions is not None
            and observe_before_count is not None
            and observe_after_count is not None
            and boundary_after_count is not None
            and boundary_after_completions is not None
            and observe.get("before") == boundary_after
            and observe_before_count == boundary_after_count
            and observe_after_count == len(observe_completions)
            and observe_before_count == observe_after_count
            and observe_completions == boundary_after_completions)
        observe_jobs_ok = _empty_jobs(observe)
        observe_owned_ok = _no_owned(observe)
        case_no_work[case] = (
            boundary_counts_ok and observe_counts_ok
            and boundary_jobs_ok and observe_jobs_ok
            and boundary_owned_ok and observe_owned_ok)

        identity = observe.get("identity") or {}
        boundary_boot = _boot_id(boundary_after.get("boot_id"))
        observe_boot = _boot_id(observe_snapshot.get("boot_id"))
        before_boot = _boot_id(boundary_before.get("boot_id"))
        boundary_manager = _manager_identity(boundary_after.get("manager"))
        observe_manager = _manager_identity(observe_snapshot.get("manager"))
        before_manager = _manager_identity(boundary_before.get("manager"))
        identity_before_boot = _boot_id(identity.get("boot_id_before"))
        identity_after_boot = _boot_id(identity.get("boot_id_after"))
        identity_before_manager = _manager_identity(
            identity.get("manager_before"))
        identity_after_manager = _manager_identity(
            identity.get("manager_after"))
        identity_consistent = (
            boundary_boot is not None and observe_boot is not None
            and before_boot is not None
            and boundary_manager is not None and observe_manager is not None
            and before_manager is not None
            and identity_before_boot is not None
            and identity_after_boot is not None
            and identity_before_manager is not None
            and identity_after_manager is not None
            and boundary_boot == before_boot
            and boundary_manager == before_manager
            and boundary_boot == identity_before_boot
            and observe_boot == identity_after_boot
            and boundary_manager == identity_before_manager
            and observe_manager == identity_after_manager)
        derived_boot_changed = (
            boundary_boot is not None and observe_boot is not None
            and boundary_boot != observe_boot)
        derived_manager_changed = (
            boundary_manager is not None and observe_manager is not None
            and boundary_manager["invocation_id"]
            != observe_manager["invocation_id"])
        flags_consistent = (
            identity.get("boot_id_changed") is derived_boot_changed
            and identity.get("manager_changed") is derived_manager_changed)
        host = (restarts if spec["kind"] == "manager" else reboots).get(case) or {}
        if spec["kind"] == "manager":
            command = " ".join((host.get("command") or {}).get("argv") or [])
            host_ok = (host.get("kind") == "user_manager_restart"
                       and _host_identity_ok(host, "manager")
                       and host.get("qemu_identity_verified") is True
                       and "restart" in command
                       and "user@" in command
                       and "daemon-reload" not in command)
        else:
            issued = " ".join((host.get("issued") or {}).get("argv") or [])
            host_ok = (host.get("kind") == "guest_reboot"
                       and _host_identity_ok(host, "reboot")
                       and host.get("qemu_identity_verified") is True
                       and "reboot" in issued
                       and isinstance(host.get("ssh_ready"), dict)
                       and isinstance(host.get("manager_ready"), dict))
        checks[case + "_identity"] = (
            identity_consistent
            and flags_consistent
            and derived_manager_changed
            and derived_boot_changed == (spec["kind"] == "reboot")
            and host_ok)

        record_before = observe.get("record_before") or {}
        record_after = observe.get("record_after") or {}
        checks[case + "_journal_metadata_fence"] = (
            _sha_present(record_before)
            and _sha_present(record_after)
            and record_after["sha256"] == record_before["sha256"]
            and record_before.get("outcome") == "pending"
            and record_before.get("phase") == expected_phase
            and record_after.get("outcome") == "pending"
            and record_after.get("phase") == expected_phase
            and observe.get("metadata_match") is True
            and (observe.get("fence") or {}).get("service", {}).get("LoadState")
            == "masked"
            and (observe.get("fence") or {}).get("timer", {}).get(
                "ActiveState") in ("inactive", "failed")
            and (observe.get("fence") or {}).get("service", {}).get("FragmentPath")
            == service_path
            and (observe.get("fence") or {}).get("direct_start", {}).get("rc")
            not in (0, None)
            and "masked" in _direct_text(observe)
            and (observe.get("staged") or {}).get("type")
            == expected_staged["type"]
            and (expected_staged.get("runtime") is None
                 or (observe.get("staged") or {}).get("runtime")
                 == expected_staged["runtime"])
            and observe_counts_ok
            and observe_jobs_ok
            and observe_owned_ok)

        recovery = observe.get("recovery") or {}
        repeat = observe.get("repeat") or {}
        recovery_before = recovery.get("record_before") or {}
        recovery_after = recovery.get("record_after") or {}
        recovery_record = recovery.get("record") or {}
        repeat_after = repeat.get("record_after") or {}
        if spec["boundary"] in ("drained", "restore_staged"):
            checks[case + "_recovery_outcome"] = (
                (recovery.get("cli") or {}).get("rc") == 0
                and _sha_present(recovery_before)
                and recovery_record.get("outcome") == "rolled_back"
                and recovery_record.get("phase")
                == "restore_activation_pending"
                and _sha_present(recovery_record)
                and (recovery.get("restored") or {}).get("runtime")
                == spec["prior_runtime"]
                and (recovery.get("restored") or {}).get("staged", {}).get("type")
                == "missing"
                and (repeat.get("cli") or {}).get("rc") == 2
                and _sha_present(repeat_after)
                and repeat_after["sha256"] == recovery_record["sha256"])
        else:
            checks[case + "_recovery_outcome"] = (
                (recovery.get("cli") or {}).get("rc") == 3
                and _sha_present(recovery_before)
                and _sha_present(recovery_after)
                and recovery_after["sha256"] == recovery_before["sha256"]
                and recovery_after.get("outcome") == "pending"
                and recovery_after.get("phase") == "activation_pending"
                and (repeat.get("cli") or {}).get("rc") == 3
                and _sha_present(repeat_after)
                and repeat_after["sha256"] == recovery_before["sha256"])
        checks[case + "_preserved_state"] = (
            (observe.get("preserved") or {}).get("state")
            == (prepared.get("state") or {})
            and (observe.get("preserved") or {}).get("history_sha256")
            == prepared.get("history_sha256"))

    checks["matrix_both_directions"] = (
        any(spec["prior_runtime"] == PYTHON_RUNTIME
            and spec["runtime"] == NODE_RUNTIME
            for spec in MATRIX_CASES.values())
        and any(spec["prior_runtime"] == NODE_RUNTIME
                and spec["runtime"] == PYTHON_RUNTIME
                for spec in MATRIX_CASES.values()))
    checks["matrix_manager_restart_is_not_reload"] = all(
        (restarts.get(case) or {}).get("kind") == "user_manager_restart"
        and _host_identity_ok(restarts.get(case) or {}, "manager")
        and (restarts.get(case) or {}).get("qemu_identity_verified") is True
        and "restart" in " ".join(
            ((restarts.get(case) or {}).get("command") or {}).get("argv") or [])
        and "user@" in " ".join(
            ((restarts.get(case) or {}).get("command") or {}).get("argv") or [])
        and "daemon-reload" not in " ".join(
            ((restarts.get(case) or {}).get("command") or {}).get("argv") or [])
        for case in MATRIX_ORDER if MATRIX_CASES[case]["kind"] == "manager")
    checks["matrix_guest_reboot_changes_boot_id"] = all(
        (reboots.get(case) or {}).get("kind") == "guest_reboot"
        and _host_identity_ok(reboots.get(case) or {}, "reboot")
        and (reboots.get(case) or {}).get("qemu_identity_verified") is True
        for case in MATRIX_ORDER if MATRIX_CASES[case]["kind"] == "reboot")
    checks["matrix_no_unrecorded_work"] = all(
        case_no_work.get(case, False) for case in MATRIX_ORDER)
    checks["matrix_ambiguity_retained"] = all(
        _ambiguity_retained(phases.get(case + "-observe"))
        for case in MATRIX_ORDER
        if MATRIX_CASES[case]["boundary"] == "activation_pending")
    checks["matrix_ambiguity_reset_preserved"] = all(
        _reset_preserved(phases.get(reset))
        for reset in ("matrix-reset-python", "matrix-reset-python-final"))
    return checks


def _cleanup_never_signalled(phase):
    cleanup = phase.get("cleanup")
    return (isinstance(cleanup, list) and bool(cleanup)
            and all(isinstance(item, dict)
                    and item.get("controller_signalled") is False
                    for item in cleanup))


def _record_path_ok(value):
    if not isinstance(value, str) or not value.endswith(".json"):
        return False
    for root in RECORD_ROOTS:
        prefix = root + "/"
        if value.startswith(prefix):
            name = value[len(prefix):]
            if "/" not in name and name.startswith("controller-"):
                return True
    return False


def _path_list_ok(value):
    return (isinstance(value, list) and bool(value)
            and all(_record_path_ok(item) for item in value))


def _record_list_ok(value, allow_empty=False):
    return (isinstance(value, list) and (allow_empty or bool(value))
            and all(isinstance(item, dict) and _sha_present(item)
                    and _record_path_ok(item.get("path"))
                    and type(item.get("bytes")) is int and item["bytes"] > 0
                    for item in value))


def _all_records_ok(value):
    if not isinstance(value, dict) or set(value) != set(RECORD_ROOTS):
        return False
    return (_record_list_ok(value.get(RECORDS_DIR))
            and all(_record_list_ok(value.get(root), allow_empty=True)
                    for root in CASE_RECORD_DIRS))


def _path_entry_ok(entry, path, allowed, expected_sha=None, *,
                   with_bytes=False, require_path=False,
                   require_xattrs=False):
    if not isinstance(entry, dict) or entry.get("type") not in allowed:
        return False
    if require_path and entry.get("path") != path:
        return False
    state = entry["type"]
    if state == "missing":
        keys = {"type", "path"} if require_path else {"type"}
        return set(entry) == keys
    if not (type(entry.get("mode")) is int and entry["mode"] >= 0
            and type(entry.get("uid")) is int and entry["uid"] >= 0
            and type(entry.get("gid")) is int and entry["gid"] >= 0):
        return False
    if require_xattrs and not (
            isinstance(entry.get("xattrs"), list)
            and all(isinstance(item, str) for item in entry["xattrs"])):
        return False
    if state == "file":
        size = entry.get("size")
        digest = entry.get("sha256")
        if not _sha256_text(digest) or type(size) is not int or size <= 0:
            return False
        if with_bytes:
            encoded = entry.get("bytes_b64")
            if not isinstance(encoded, str) or not encoded:
                return False
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError):
                return False
            if len(raw) != size or sha256_bytes(raw) != digest:
                return False
        return expected_sha is None or digest == expected_sha
    if state == "symlink":
        target = entry.get("target")
        if not isinstance(target, str) or not target:
            return False
        return target == "../crq-tick.timer" if path == WANTS_PATH else True
    return False


METADATA_TYPES = {
    SERVICE_PATH: ("file",),
    TIMER_PATH: ("file",),
    WANTS_PATH: ("symlink",),
    STAGED_PATH: ("missing", "file"),
}
FILE_TYPES = {
    SERVICE_PATH: ("file",),
    TIMER_PATH: ("file",),
    WANTS_PATH: ("symlink",),
    STAGED_PATH: ("missing", "file"),
    COMPLETIONS_PATH: ("missing", "file"),
    HISTORY_PATH: ("file",),
}


def _metadata_ok(metadata, service_sha=None):
    if not isinstance(metadata, dict) or set(metadata) != set(METADATA_TYPES):
        return False
    return all(
        _path_entry_ok(metadata[path], path, allowed,
                       service_sha if path == SERVICE_PATH else None,
                       with_bytes=True, require_xattrs=True)
        for path, allowed in METADATA_TYPES.items())


def _files_ok(files, service_sha=None):
    if not isinstance(files, dict) or set(files) != set(FILE_TYPES):
        return False
    return all(
        _path_entry_ok(files[path], path, allowed,
                       service_sha if path == SERVICE_PATH else None,
                       require_path=True)
        for path, allowed in FILE_TYPES.items())


def _views_agree(metadata, files):
    for path in (SERVICE_PATH, TIMER_PATH, WANTS_PATH, STAGED_PATH):
        meta = metadata[path]
        file = files[path]
        if meta["type"] != file["type"]:
            return False
        if meta["type"] == "missing":
            continue
        for field in ("mode", "uid", "gid"):
            if (type(meta[field]) is not int
                    or type(file[field]) is not int
                    or meta[field] != file[field]):
                return False
        if meta["type"] == "file":
            if (meta["size"] != file["size"]
                    or meta["sha256"] != file["sha256"]):
                return False
        elif meta["type"] == "symlink":
            if meta["target"] != file["target"]:
                return False
    return True


def _process_ok(value, alive):
    return (isinstance(value, dict)
            and type(value.get("pid")) is int and value["pid"] > 0
            and value.get("alive") is alive
            and isinstance(value.get("starttime"), str)
            and bool(value["starttime"]))


def _same_live_process(before, after):
    return (_process_ok(before, True) and _process_ok(after, True)
            and before["pid"] == after["pid"]
            and before["starttime"] == after["starttime"])


def _owned_alive_ok(phase):
    seeded = ((phase.get("seeded") or {}).get("process") or {})
    owned = (phase.get("processes") or {}).get("owned")
    return (_process_ok(owned, True)
            and owned["pid"] == seeded.get("pid")
            and owned["starttime"] == seeded.get("starttime"))


def _unrelated_alive_ok(phase):
    unrelated = (phase.get("processes") or {}).get("unrelated") or {}
    return _same_live_process(unrelated.get("before"), unrelated.get("after"))


def _blocked_observation_ok(value):
    return (isinstance(value, dict)
            and value.get("drained") is False
            and isinstance(value.get("blocked"), list)
            and bool(value["blocked"])
            and all(isinstance(entry, dict)
                    and entry.get("state") in ("alive", "ambiguous")
                    and isinstance(entry.get("run"), str) and bool(entry["run"])
                    and isinstance(entry.get("item"), str) and bool(entry["item"])
                    for entry in value["blocked"]))


def _liveness_ok(phase, state):
    seeded = phase.get("seeded") or {}
    liveness = phase.get("liveness")
    run_id = seeded.get("run_id")
    item = (seeded.get("item") or {}).get("id")
    return (isinstance(liveness, list) and len(liveness) == 1
            and isinstance(liveness[0], dict)
            and liveness[0].get("state") == state
            and isinstance(run_id, str) and bool(run_id)
            and isinstance(item, str) and bool(item)
            and liveness[0].get("run_id") == run_id
            and liveness[0].get("item") == item)


def _snapshot_preservation_ok(snapshot, service_sha=None):
    if not isinstance(snapshot, dict):
        return False
    state = snapshot.get("state")
    units = snapshot.get("units")
    metadata = snapshot.get("metadata")
    jobs = snapshot.get("jobs")
    records = snapshot.get("records")
    all_records = snapshot.get("all_records")
    history = snapshot.get("history")
    completions = snapshot.get("completions")
    files = snapshot.get("files")
    if not (isinstance(state, dict)
            and set(state) == {"queue.json", "heartbeat.json"}
            and _sha256_text(state.get("queue.json"))
            and _sha256_text(state.get("heartbeat.json"))):
        return False
    if not (isinstance(units, dict)
            and set(units) == {"crq-tick.service", "crq-tick.timer"}):
        return False
    for name, path, file_state in (
            ("crq-tick.service", SERVICE_PATH, "static"),
            ("crq-tick.timer", TIMER_PATH, "enabled")):
        unit = units[name]
        if not isinstance(unit, dict):
            return False
        for key in ("LoadState", "ActiveState", "SubState", "UnitFileState",
                    "FragmentPath", "Result"):
            if not isinstance(unit.get(key), str) or not unit[key]:
                return False
        if not isinstance(unit.get("InvocationID"), str):
            return False
        if (unit["FragmentPath"] != path
                or unit["UnitFileState"] != file_state):
            return False
    if not _metadata_ok(metadata, service_sha):
        return False
    if not _files_ok(files, service_sha):
        return False
    if not _views_agree(metadata, files):
        return False
    if not isinstance(jobs, list) or not _record_list_ok(records):
        return False
    if not _all_records_ok(all_records):
        return False
    if all_records[RECORDS_DIR] != records:
        return False
    if not (_sha_present(history)
            and _record_path_ok(history.get("path"))
            and any(item["path"] == history["path"]
                    and item["sha256"] == history["sha256"]
                    for item in records)):
        return False
    if files[HISTORY_PATH].get("sha256") != history["sha256"]:
        return False
    if not isinstance(completions, list):
        return False
    if not all(isinstance(entry, dict)
               and type(entry.get("sequence")) is int
               for entry in completions):
        return False
    return True


def _snapshot_preserved(before, after, service_sha=None):
    if not (_snapshot_preservation_ok(before, service_sha)
            and _snapshot_preservation_ok(after, service_sha)):
        return False
    return all(before.get(key) == after.get(key)
               for key in ("state", "units", "metadata", "jobs", "records",
                           "all_records", "history", "completions", "files"))


def _queue_restored_ok(queue, before_key, after_key=None):
    after_key = after_key or before_key
    return (_sha256_text(queue.get(before_key))
            and _sha256_text(queue.get(after_key))
            and _sha256_text(queue.get("baseline_sha256"))
            and _sha256_text(queue.get("restored_sha256"))
            and queue[before_key] == queue[after_key]
            and queue["baseline_sha256"] == queue["restored_sha256"]
            and queue[before_key] != queue["restored_sha256"])


def _count_value_ok(value, *, positive=False):
    return (type(value) is int and value >= 0
            and (value > 0 if positive else True))


def _record_pending_ok(value):
    return (_sha_present(value)
            and type(value.get("bytes")) is int and value["bytes"] > 0
            and isinstance(value.get("path"), str) and bool(value["path"])
            and value.get("outcome") == "pending"
            and value.get("phase") == "drained")


def _drain_refusal_ok(phase, kind):
    cli = phase.get("cli") or {}
    queue = phase.get("queue") or {}
    before = phase.get("before") or {}
    after = phase.get("after") or {}
    observation = phase.get("observation") or {}
    drain = phase.get("drain") or {}
    seeded_run = (phase.get("seeded") or {}).get("run_id")
    owned = (phase.get("processes") or {}).get("owned")
    runtime = phase.get("current_runtime")
    service_sha = (_sha(expected_unit(runtime))
                   if runtime in (NODE_RUNTIME, PYTHON_RUNTIME) else None)
    return (
        cli.get("rc") == 2
        and service_sha is not None
        and "queue-owned work" in (phase.get("refused") or "")
        and _blocked_observation_ok(observation)
        and _blocked_observation_ok(drain)
        and drain == observation
        and any(entry.get("state") == kind
                and entry.get("run") == seeded_run
                for entry in observation["blocked"])
        and _liveness_ok(phase, kind)
        and _queue_restored_ok(queue, "before_sha256", "after_sha256")
        and _path_list_ok(phase.get("records_before"))
        and phase.get("records_before") == phase.get("records_after")
        and _count_value_ok(phase.get("completions_before"))
        and phase.get("completions_before") == phase.get("completions_after")
        and _snapshot_preserved(before, after, service_sha)
        and (("owned" in (phase.get("processes") or {})
              and owned is None) if kind == "ambiguous"
             else _owned_alive_ok(phase))
        and _unrelated_alive_ok(phase)
        and _cleanup_never_signalled(phase)
        and phase.get("baseline_restored") is True
    )


def _completion_pair(value):
    evidence = value or {}
    sequences = evidence.get("sequences")
    invocations = evidence.get("invocations")
    return (isinstance(sequences, list) and len(sequences) == 2
            and all(type(item) is int for item in sequences)
            and sequences[0] < sequences[1]
            and isinstance(invocations, list) and len(invocations) == 2
            and all(isinstance(item, str) and HEX32.fullmatch(item)
                    for item in invocations)
            and len(set(invocations)) == 2)


def _drain_harvest_ok(phase):
    queue = phase.get("queue") or {}
    processes = phase.get("processes") or {}
    observation = phase.get("observation") or {}
    node = phase.get("node") or {}
    python = phase.get("python") or {}
    node_record = node.get("record") or {}
    python_record = python.get("record") or {}
    preserved = phase.get("preserved") or {}
    seeded = preserved.get("state") or {}
    after = phase.get("after") or {}
    seeded_process = (phase.get("seeded") or {}).get("process") or {}
    unrelated = processes.get("unrelated") or {}
    completed = processes.get("completed")
    return (
        observation == {"drained": True, "blocked": []}
        and _liveness_ok(phase, "harvest")
        and all(_sha256_text(queue.get(key)) for key in (
            "seeded_sha256", "after_node_sha256", "after_python_sha256"))
        and queue["seeded_sha256"] == queue["after_node_sha256"]
        and queue["seeded_sha256"] == queue["after_python_sha256"]
        and ((node.get("cli") or {}).get("rc") == 0)
        and ((python.get("cli") or {}).get("rc") == 0)
        and _completion_pair(node.get("completions"))
        and _completion_pair(python.get("completions"))
        and node_record.get("outcome") == "completed"
        and node_record.get("runtime") == NODE_RUNTIME
        and node_record.get("prior_runtime") == PYTHON_RUNTIME
        and python_record.get("outcome") == "completed"
        and python_record.get("runtime") == PYTHON_RUNTIME
        and python_record.get("prior_runtime") == NODE_RUNTIME
        and _same_live_process(unrelated.get("before"), unrelated.get("after"))
        and _process_ok(completed, False)
        and completed["pid"] == seeded_process.get("pid")
        and completed["starttime"] == seeded_process.get("starttime")
        and _snapshot_preservation_ok(
            after, _sha(expected_unit(PYTHON_RUNTIME)))
        and (after.get("units") or {}).get(
            "crq-tick.timer", {}).get("ActiveState") == "inactive"
        and _sha256_text(seeded.get("queue.json"))
        and _sha256_text(seeded.get("heartbeat.json"))
        and seeded["queue.json"] == queue["seeded_sha256"]
        and seeded["queue.json"] == (after.get("state") or {}).get(
            "queue.json")
        and seeded["heartbeat.json"] == (after.get("state") or {}).get(
            "heartbeat.json")
        and _sha256_text(preserved.get("history_sha256"))
        and preserved["history_sha256"] == (after.get("history") or {}).get(
            "sha256")
        and type(preserved.get("record_count")) is int
        and preserved["record_count"] > 0
        and preserved["record_count"] == len(after.get("records") or [])
        and _cleanup_never_signalled(phase)
        and phase.get("baseline_restored") is True
    )


def _recovery_drain_refusal_ok(phase, service_path, baseline_queue):
    cli = phase.get("cli") or {}
    queue = phase.get("queue") or {}
    before = phase.get("record_before") or {}
    after = phase.get("record_after") or {}
    service = phase.get("service") or {}
    timer = phase.get("timer") or {}
    observation = phase.get("observation") or {}
    drain = phase.get("drain") or {}
    service_before = service.get("before") or {}
    service_after = service.get("after") or {}
    timer_before = timer.get("before") or {}
    timer_after = timer.get("after") or {}
    return (
        cli.get("rc") == 2
        and "queue-owned work" in (phase.get("refused") or "")
        and _blocked_observation_ok(observation)
        and _blocked_observation_ok(drain)
        and drain == observation
        and _liveness_ok(phase, "alive")
        and isinstance(phase.get("record_path"), str)
        and _record_path_ok(phase["record_path"])
        and _record_pending_ok(before)
        and _record_pending_ok(after)
        and before["path"] == phase["record_path"]
        and after["path"] == phase["record_path"]
        and before.get("sha256") == after.get("sha256")
        and before["bytes"] == after["bytes"]
        and _sha256_text(queue.get("before_sha256"))
        and _sha256_text(queue.get("after_sha256"))
        and _sha256_text(queue.get("restored_sha256"))
        and _sha256_text(baseline_queue)
        and queue["before_sha256"] == queue["after_sha256"]
        and queue["restored_sha256"] == baseline_queue
        and queue["restored_sha256"] != queue["before_sha256"]
        and _count_value_ok(phase.get("completions_before"), positive=True)
        and phase.get("completions_before") == phase.get("completions_after")
        and service_before.get("LoadState") == "masked"
        and service_after.get("LoadState") == "masked"
        and service_before.get("FragmentPath") == service_path
        and service_after.get("FragmentPath") == service_path
        and isinstance(service_before.get("ActiveState"), str)
        and service_before == service_after
        and timer_before.get("ActiveState") in ("inactive", "failed")
        and timer_after.get("ActiveState") in ("inactive", "failed")
        and isinstance(timer_before.get("LoadState"), str)
        and isinstance(timer_after.get("LoadState"), str)
        and timer_before == timer_after
        and _owned_alive_ok(phase)
        and _unrelated_alive_ok(phase)
        and _cleanup_never_signalled(phase)
        and phase.get("baseline_restored") is True
    )


REPAIR_UNIT = "crq-repair.service"
REPAIR_TIMER = "crq-repair.timer"
REPAIR_PATH = "crq-repair.path"
REPAIR_RECORDS_DIR = "/home/%s/records-activators" % vm.GUEST_USER
REPAIR_PATHS = {
    "service": UNIT_DIR + "/" + REPAIR_UNIT,
    "timer": UNIT_DIR + "/" + REPAIR_TIMER,
    "timer_wants": UNIT_DIR + "/timers.target.wants/" + REPAIR_TIMER,
    "path": UNIT_DIR + "/" + REPAIR_PATH,
    "path_wants": UNIT_DIR + "/default.target.wants/" + REPAIR_PATH,
    "dropin": UNIT_DIR + "/" + REPAIR_UNIT + ".d/10-fence-proof.conf",
}
REPAIR_STAGED = UNIT_DIR + "/." + REPAIR_UNIT + ".staged"
REPAIR_TRIGGER = FIXTURE_DIR + "/repair-path-trigger"
REPAIR_PAUSE_MARKER = FIXTURE_DIR + "/activators-pause.json"


def _repair_adapter():
    module = _load("crq_proof_adapter_checks",
                   OPS / "unit-switch-adapter.py")
    return module.GuestFixtureAdapter(
        unit_dir=pathlib.Path(UNIT_DIR), fixture_dir=pathlib.Path(FIXTURE_DIR),
        unit=REPAIR_UNIT,
        proof_root=pathlib.Path("/home/%s/proof-bin" % vm.GUEST_USER),
        guest_only=True)


def _repair_expected(runtime):
    adapter = _repair_adapter()
    return {
        "service": adapter.render_unit(runtime),
        "timer": adapter.render_timer(),
        "path": adapter.render_path(),
        "dropin": adapter.render_dropin(),
    }


def _stat_file(state, text, label, problems):
    ok = (isinstance(state, dict) and state.get("type") == "file"
          and state.get("mode") == 0o644
          and state.get("uid") == 1000 and state.get("gid") == 1000
          and state.get("sha256") == _sha(text)
          and state.get("size") == len(text.encode()))
    if not ok:
        problems.append(label + " does not match the rendered file: "
                        + json.dumps(state)[:240])
    return ok


def _stat_link(state, target, label, problems):
    ok = (isinstance(state, dict) and state.get("type") == "symlink"
          and state.get("target") == target
          and state.get("mode") == 0o777
          and state.get("uid") == 1000 and state.get("gid") == 1000)
    if not ok:
        problems.append(label + " does not match the expected symlink: "
                        + json.dumps(state)[:240])
    return ok


def _inventory_file(state, text, label, problems):
    if not _stat_file(state, text, label, problems):
        return False
    if not isinstance(state, dict) or state.get("xattrs") != []:
        problems.append(label + " carries unexpected extended attributes")
        return False
    try:
        decoded = base64.b64decode(
            (state.get("bytes_b64") or "").encode("ascii"), validate=True)
    except (ValueError, TypeError):
        decoded = b""
    if decoded != text.encode():
        problems.append(label + " retained bytes do not match the rendered file")
        return False
    return True


def _inventory_link(state, target, label, problems):
    if not _stat_link(state, target, label, problems):
        return False
    if not isinstance(state, dict) or state.get("xattrs") != []:
        problems.append(label + " carries unexpected extended attributes")
        return False
    return True


def _unit_ok(units, name, fragment, active, enabled, label, problems):
    state = units.get(name) if isinstance(units, dict) else None
    ok = (isinstance(state, dict)
          and state.get("LoadState") == "loaded"
          and state.get("FragmentPath") == fragment
          and state.get("ActiveState") in active
          and state.get("UnitFileState") == enabled)
    if not ok:
        problems.append(label + " unit state is not the expected shape: "
                        + json.dumps(state)[:300])
    return ok


def _command_ok(result, label, problems, allowed=(0,)):
    ok = (isinstance(result, dict)
          and result.get("timeout") is False
          and type(result.get("rc")) is int
          and result["rc"] in allowed
          and isinstance(result.get("stdout"), str)
          and isinstance(result.get("stderr"), str))
    if not ok:
        problems.append(label + " command evidence is not a successful "
                        "typed observation: " + json.dumps(result)[:300])
    return ok


def _count_ok(value, label, problems):
    ok = type(value) is int and value >= 0
    if not ok:
        problems.append(label + " count is not a non-boolean non-negative "
                        "integer: " + json.dumps(value)[:120])
    return ok


def _job_identity(line):
    if not isinstance(line, str):
        return None
    match = re.fullmatch(r"\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s*", line)
    if match is None:
        return None
    return {"job_id": int(match.group(1)), "unit": match.group(2),
            "type": match.group(3), "state": match.group(4)}


def _job_lines_ok(lines, label, problems):
    ok = (isinstance(lines, list)
          and all(isinstance(line, str) and line.strip()
                  and _job_identity(line) is not None
                  for line in lines))
    if not ok:
        problems.append(label + " job lines are not typed list-jobs output: "
                        + json.dumps(lines)[:300])
    return ok


LIST_JOBS_ARGV = ["systemctl", "--user", "list-jobs", "--no-legend",
                  "--no-pager"]


def _job_observation_lines(observation):
    """Derive job lines from the retained raw command stdout, never a copy."""
    if not isinstance(observation, dict):
        return None
    command = observation.get("command")
    if not isinstance(command, dict):
        return None
    stdout = command.get("stdout")
    if not isinstance(stdout, str):
        return None
    return [line for line in stdout.splitlines() if line.strip()]


def _job_observation_ok(observation, label, problems, lines=None):
    command = observation.get("command") if isinstance(observation, dict) else None
    argv = command.get("argv") if isinstance(command, dict) else None
    derived = _job_observation_lines(observation)
    retained = observation.get("lines") if isinstance(observation, dict) else None
    ok = (isinstance(observation, dict)
          and _command_ok(command, label, problems)
          and argv == LIST_JOBS_ARGV
          and derived is not None
          and _job_lines_ok(derived, label, problems)
          and retained == derived
          and (lines is None or lines == derived))
    if not ok:
        problems.append(label + " list-jobs observation is incomplete or "
                        "does not bind its retained lines to the exact "
                        "list-jobs command output")
    return ok


def _record_summary_ok(item, label, problems):
    path = item.get("path") if isinstance(item, dict) else None
    name = pathlib.PurePosixPath(path).name if isinstance(path, str) else ""
    ok = (isinstance(item, dict)
          and isinstance(path, str)
          and path.startswith(REPAIR_RECORDS_DIR + "/")
          and re.fullmatch(r"controller-[0-9a-f]{32}\.json", name) is not None
          and isinstance(item.get("sha256"), str)
          and HEX64.fullmatch(item["sha256"]) is not None
          and type(item.get("bytes")) is int and item["bytes"] > 0)
    if ok and "transaction_id" in item:
        ok = (isinstance(item["transaction_id"], str)
              and HEX32.fullmatch(item["transaction_id"]) is not None)
    if ok and "schema_version" in item:
        ok = type(item["schema_version"]) is int
    if ok and "unit" in item:
        ok = item["unit"] == REPAIR_UNIT
    if not ok:
        problems.append(label + " record inventory entry is not a typed "
                        "controller record summary: "
                        + json.dumps(item)[:300])
    return ok


def _record_inventory_ok(items, label, problems):
    if not isinstance(items, list):
        problems.append(label + " record inventory is absent or not a list")
        return False
    return all(_record_summary_ok(item, label + "[" + str(index) + "]",
                                  problems)
               for index, item in enumerate(items))


def _completion_shape_ok(item, label, problems):
    ok = (isinstance(item, dict) and item.get("unit") == REPAIR_UNIT
          and item.get("runtime") in (PYTHON_RUNTIME, NODE_RUNTIME)
          and item.get("success") is True
          and type(item.get("sequence")) is int and item["sequence"] > 0
          and isinstance(item.get("invocation"), str)
          and HEX32.fullmatch(item["invocation"]) is not None)
    if not ok:
        problems.append(label + " is not a typed unit/runtime completion: "
                        + json.dumps(item)[:240])
    return ok


def _completion_list_ok(items, label, problems, runtime=None,
                        allow_empty=True):
    if not isinstance(items, list) or (not allow_empty and not items):
        problems.append(label + " completion inventory is absent, empty or "
                        "not a list")
        return False
    ok = True
    for index, item in enumerate(items):
        entry_label = label + "[" + str(index) + "]"
        shape_ok = _completion_shape_ok(item, entry_label, problems)
        runtime_ok = (runtime is None
                      or (isinstance(item, dict)
                          and item.get("runtime") == runtime))
        if shape_ok and not runtime_ok:
            problems.append(entry_label + " has the wrong runtime: "
                            + json.dumps(item.get("runtime"))[:120])
        ok = shape_ok and runtime_ok and ok
    return ok


def _completion_ok(item, runtime, label, problems):
    ok = (_completion_shape_ok(item, label, problems)
          and item.get("runtime") == runtime)
    if not ok and isinstance(item, dict) and item.get("runtime") != runtime:
        problems.append(label + " is not valid unit/runtime evidence: "
                        + json.dumps(item)[:240])
    return ok


def _completions_ok(items, runtime, label, problems):
    return (isinstance(items, list) and bool(items)
            and all(_completion_ok(item, runtime, label + "[" + str(index) + "]",
                                   problems)
                    for index, item in enumerate(items)))


def _positive_queue_ok(queue, problems):
    blocker = queue.get("blocker") or {}
    job = queue.get("job")
    jobs = queue.get("jobs")
    jobs_after = queue.get("jobs_after")
    before_count = queue.get("before_count")
    after_count = queue.get("after_count")
    identity = _job_identity(job)
    ok = (
        _command_ok(queue.get("blocker_command"), "queue blocker start",
                    problems)
        and _command_ok(queue.get("target_command"), "queue target start",
                        problems)
        and _command_ok(queue.get("stop"), "queue target stop", problems)
        and _command_ok(queue.get("blocker_stop"), "queue blocker stop",
                        problems)
        and _job_lines_ok(jobs, "queue job lines", problems)
        and _job_lines_ok(jobs_after, "queue post-stop job lines", problems)
        and _job_observation_ok(queue.get("job_observation"),
                                "queue job observation", problems, jobs)
        and _job_observation_ok(queue.get("jobs_after_observation"),
                                "queue post-stop observation", problems,
                                jobs_after)
        and identity is not None
        and identity["unit"] == REPAIR_UNIT
        and identity["type"] == "start"
        and identity["state"] == "waiting"
        and isinstance(job, str) and job in jobs
        and not any(REPAIR_UNIT in line for line in jobs_after)
        and _count_ok(before_count, "queue before", problems)
        and _count_ok(after_count, "queue after", problems)
        and before_count == after_count
        and blocker.get("ActiveState") in ("activating", "active")
        and blocker.get("MainPID") not in (None, "", "0")
        and isinstance(blocker.get("InvocationID"), str)
        and HEX32.fullmatch(blocker["InvocationID"]) is not None)
    if not ok:
        problems.append("queued-job positive control does not prove a "
                        "settled cancellation of the exact waiting job")
    return ok


def _fence_job_ok(queue_seed, during, problems):
    queue_job = _job_identity(queue_seed.get("job"))
    queue_jobs = queue_seed.get("jobs")
    during_jobs = during.get("jobs")
    queue_blocker = queue_seed.get("blocker") or {}
    during_blocker = during.get("blocker") or {}
    ok = (
        _command_ok(queue_seed.get("blocker_command"),
                    "fence queue blocker start", problems)
        and _command_ok(queue_seed.get("target_command"),
                        "fence queue target start", problems)
        and _job_lines_ok(queue_jobs, "fence queue job lines", problems)
        and _job_lines_ok(during_jobs, "fence during job lines", problems)
        and _job_observation_ok(queue_seed.get("job_observation"),
                                "fence queue job observation", problems,
                                queue_jobs)
        and _job_observation_ok(during.get("jobs_observation"),
                                "fence during job observation", problems,
                                during_jobs)
        and queue_job is not None
        and queue_job["unit"] == REPAIR_UNIT
        and queue_job["type"] == "start"
        and queue_job["state"] == "waiting"
        and queue_seed.get("job") in queue_jobs
        and any(_job_identity(line) == queue_job for line in during_jobs)
        and queue_blocker.get("ActiveState") in ("activating", "active")
        and during_blocker.get("ActiveState") in ("activating", "active")
        and queue_blocker.get("MainPID") not in (None, "", "0")
        and queue_blocker.get("MainPID") == during_blocker.get("MainPID")
        and isinstance(queue_blocker.get("InvocationID"), str)
        and HEX32.fullmatch(queue_blocker["InvocationID"]) is not None
        and queue_blocker.get("InvocationID")
        == during_blocker.get("InvocationID"))
    if not ok:
        problems.append("fence did not retain the same waiting job identity "
                        "and blocker through mask and reload")
    return ok


def _fence_completion_ok(fence, during, record, problems):
    before = fence.get("completions_before")
    after = fence.get("completions_after")
    during_before = during.get("completions_before_external")
    during_now = during.get("completions")
    inventories = (before, after, during_before, during_now)
    if not all(isinstance(items, list) for items in inventories) \
            or not all(isinstance(item, dict) for items in inventories
                       for item in items):
        problems.append("fence completion inventory is malformed")
        return False
    ok = (
        _completion_list_ok(before, "fence baseline completion", problems,
                            PYTHON_RUNTIME)
        and _completion_list_ok(after, "fence final completion", problems)
        and _completion_list_ok(during_before,
                                "fence pre-release completion", problems,
                                PYTHON_RUNTIME)
        and _completion_list_ok(during_now, "fence during completion",
                                problems, PYTHON_RUNTIME)
        and before == during_before
        and during_now == during_before
        and _count_ok(during.get("completion_count"),
                      "fence during completion count", problems)
        and _count_ok(during.get("external_completion_delta"),
                      "fence external completion delta", problems)
        and during["completion_count"] == len(during_now)
        and during["external_completion_delta"] == (
            len(during_now) - len(during_before))
        and during["external_completion_delta"] == 0)
    record_completions = record.get("completions")
    if not isinstance(record_completions, list):
        problems.append("fence record completions are absent or not a list")
        ok = False
        record_completions = []
    else:
        ok = (len(record_completions) == 2
              and all(_completion_ok(item, NODE_RUNTIME,
                                     "fence record completion", problems)
                      for item in record_completions)
              and ok)
    before_invocations = {item.get("invocation") for item in before or []}
    during_invocations = {item.get("invocation") for item in during_now or []}
    record_invocations = {item.get("invocation")
                          for item in record_completions}
    after_invocations = {item.get("invocation") for item in after or []}
    baseline = max((item.get("sequence", 0) for item in before or []),
                   default=0)
    ok = (
        ok
        and len(record_invocations) == 2
        and all(item.get("invocation") in after_invocations
                and item.get("invocation") not in before_invocations
                and item.get("invocation") not in during_invocations
                and type(item.get("sequence")) is int
                and item["sequence"] > baseline
                for item in record_completions)
        and after_invocations == before_invocations | record_invocations
        and len(after or []) == len(before or []) + 2)
    if not ok:
        problems.append("fence completion delta is not derived from the "
                        "retained baseline and during inventories")
    return ok


def _fence_records_ok(fence, problems):
    before = fence.get("records_before")
    after = fence.get("records_after")
    ok = (_record_inventory_ok(before, "fence before records", problems)
          and _record_inventory_ok(after, "fence after records", problems))
    if (not isinstance(before, list) or not isinstance(after, list)
            or not all(isinstance(item, dict) for item in before + after)):
        return False
    before_by_path = {item.get("path"): item for item in before}
    after_by_path = {item.get("path"): item for item in after}
    new_paths = set(after_by_path) - set(before_by_path)
    record = fence.get("record") or {}
    ok = (ok
          and len(after) == len(before) + 1
          and all(path in after_by_path
                  and after_by_path[path] == item
                  for path, item in before_by_path.items())
          and len(new_paths) == 1
          and record.get("path") in new_paths
          and record == after_by_path.get(record.get("path")))
    if not ok:
        problems.append("fence journal inventory is not an exact retained "
                        "one-record extension")
    return ok


def _refusal_case_ok(name, case, baseline, unknown, problems):
    expected_cases = {
        "rogue-unit": ("outside the allowlisted", "socket"),
        "unknown-link": ("outside the allowlisted", "crq-repair.timer"),
        "unknown-dropin": ("outside the allowlisted", "unexpected drop-in"),
        "unsafe-metadata": ("group- or world-writable",),
    }
    tokens = expected_cases.get(name)
    if tokens is None:
        problems.append("unknown refusal case: " + str(name))
        return False
    command = case.get("command")
    text = ((command.get("stdout") if isinstance(command, dict) else "")
            + (command.get("stderr") if isinstance(command, dict) else "")
            ).lower()
    baseline_files = baseline.get("files") or {}
    records_before = case.get("records_before")
    records_after = case.get("records_after")
    baseline_records = baseline.get("records")
    after_records = (unknown.get("after") or {}).get("records")
    units_after = case.get("units_after") or {}
    mutated = case.get("mutated_files") or {}
    ok = (
        _command_ok(command, "refusal " + name, problems, allowed=(2,))
        and all(token in text for token in tokens)
        and _record_inventory_ok(records_before,
                                 "refusal " + name + " before records",
                                 problems)
        and _record_inventory_ok(records_after,
                                 "refusal " + name + " after records",
                                 problems)
        and _record_inventory_ok(baseline_records,
                                 "refusal baseline records", problems)
        and _record_inventory_ok(after_records,
                                 "refusal final records", problems)
        and records_before == records_after
        and records_before == baseline_records
        and records_after == after_records
        and _count_ok(case.get("completions_after"),
                      "refusal " + name + " completion count", problems)
        and _count_ok(unknown.get("completions"),
                      "refusal baseline completion count", problems)
        and case.get("completions_after") == unknown.get("completions")
        and _unit_ok(units_after, REPAIR_UNIT, REPAIR_PATHS["service"],
                     ("inactive", "failed"), "static",
                     "refusal " + name + " service", problems)
        and _unit_ok(units_after, REPAIR_TIMER, REPAIR_PATHS["timer"],
                     ("inactive", "failed"), "enabled",
                     "refusal " + name + " timer", problems)
        and _unit_ok(units_after, REPAIR_PATH, REPAIR_PATHS["path"],
                     ("inactive", "failed"), "enabled",
                     "refusal " + name + " path", problems))
    if name == "unsafe-metadata":
        ok = ok and (mutated.get("dropin") or {}).get("mode") == 0o666
    else:
        ok = ok and mutated == baseline_files
    if not ok:
        problems.append("refusal case " + name
                        + " did not match the expected evidence")
    return ok


def _stable_tick(snapshot):
    keys = ("hostname", "user", "boot_id", "manager", "units", "files",
            "metadata", "state", "history", "records", "completions")
    return {key: (snapshot or {}).get(key) for key in keys}


def _tick_ok(tick, prepared, initial, label, problems):
    tick = tick or {}
    files = tick.get("files") or {}
    ok = (_stable_tick(tick) == _stable_tick(initial or {})
          and tick.get("state") == (prepared or {}).get("state")
          and (tick.get("history") or {}).get("sha256")
          == (prepared or {}).get("history_sha256")
          and [entry.get("path") for entry in (tick.get("records") or [])]
          == (prepared or {}).get("record_paths")
          and (files.get(UNIT_DIR + "/crq-tick.service") or {}).get("sha256")
          == _sha(expected_unit(PYTHON_RUNTIME)))
    if not ok:
        problems.append(label + " changed the original tick topology")
    return ok


def _preserved_ok(value, prepared, label, problems):
    value = value or {}
    ok = (value.get("state") == (prepared or {}).get("state")
          and value.get("history_sha256")
          == (prepared or {}).get("history_sha256")
          and type(value.get("record_count")) is int
          and value["record_count"] >= len((prepared or {}).get("record_paths")
                                           or []))
    if not ok:
        problems.append(label + " did not preserve queue/heartbeat/history")
    return ok


def _activator_checks(phases):
    checks = {}
    problems = []
    prepare = phases.get("prepare") or {}
    if not _ok_phase(prepare, "prepare", problems):
        return checks, problems
    snapshot = prepare.get("snapshot") or {}
    prepared = prepare.get("prepared") or {}
    if not isinstance(prepared, dict) or not prepared.get("state") \
            or not prepared.get("history_sha256"):
        problems.append("prepare evidence has no preserved state or history digest")
        checks["activator_prepared_baseline"] = False
        return checks, problems
    files = snapshot.get("files") or {}
    units = snapshot.get("units") or {}
    checks["activator_guest_isolation"] = (
        snapshot.get("hostname") == "crq-probe"
        and snapshot.get("user") == 1000
        and snapshot.get("boot_id") is not None)
    checks["activator_tick_baseline"] = (
        (files.get(UNIT_DIR + "/crq-tick.service") or {}).get("sha256")
        == _sha(expected_unit(PYTHON_RUNTIME))
        and (units.get("crq-tick.timer") or {}).get("UnitFileState")
        == "enabled"
        and (units.get("crq-tick.timer") or {}).get("ActiveState")
        == "inactive"
        and bool((snapshot.get("history") or {}).get("sha256")))
    runner_source = prepared.get("runner_source") or {}
    checks["activator_runner_source"] = (
        isinstance(runner_source.get("sha256"), str)
        and HEX64.fullmatch(runner_source["sha256"]) is not None
        and isinstance(runner_source.get("crq_sha256"), str)
        and HEX64.fullmatch(runner_source["crq_sha256"]) is not None
        and type(runner_source.get("bytes")) is int
        and runner_source["bytes"] > 0)

    install = phases.get("activators-install") or {}
    if not _ok_phase(install, "activators-install", problems):
        checks["activator_install_inventory"] = False
        checks["activator_install_files"] = False
    else:
        inventory = install.get("inventory") or {}
        paths = inventory.get("paths") or {}
        locations = inventory.get("locations") or {}
        inventory_units = inventory.get("units") or {}
        activators = inventory.get("activators") or {}
        expected = _repair_expected(PYTHON_RUNTIME)
        checks["activator_install_inventory"] = (
            inventory.get("unit") == REPAIR_UNIT
            and inventory.get("topology") == "repair"
            and set(paths) == set(REPAIR_PATHS)
            and locations == REPAIR_PATHS
            and _inventory_file(paths.get("service"), expected["service"],
                                "install inventory service", problems)
            and _inventory_file(paths.get("timer"), expected["timer"],
                                "install inventory timer", problems)
            and _inventory_file(paths.get("path"), expected["path"],
                                "install inventory path", problems)
            and _inventory_file(paths.get("dropin"), expected["dropin"],
                                "install inventory drop-in", problems)
            and _inventory_link(paths.get("timer_wants"),
                                "../" + REPAIR_TIMER,
                                "install inventory timer wants", problems)
            and _inventory_link(paths.get("path_wants"),
                                "../" + REPAIR_PATH,
                                "install inventory path wants", problems)
            and activators == {
                "timer_active": "inactive",
                "timer_unit_file_state": "enabled",
                "service_active": "inactive",
                "path_active": "inactive",
                "path_unit_file_state": "enabled"}
            and _unit_ok(inventory_units, "service",
                         REPAIR_PATHS["service"], ("inactive",), "static",
                         "install inventory service", problems)
            and _unit_ok(inventory_units, "timer",
                         REPAIR_PATHS["timer"], ("inactive",), "enabled",
                         "install inventory timer", problems)
            and _unit_ok(inventory_units, "path",
                         REPAIR_PATHS["path"], ("inactive",), "enabled",
                         "install inventory path", problems))
        install_files = install.get("files") or {}
        install_units = install.get("units") or {}
        checks["activator_install_files"] = (
            _stat_file(install_files.get("service"), expected["service"],
                       "install service", problems)
            and _stat_file(install_files.get("timer"), expected["timer"],
                           "install timer", problems)
            and _stat_file(install_files.get("path"), expected["path"],
                           "install path", problems)
            and _stat_file(install_files.get("dropin"), expected["dropin"],
                           "install drop-in", problems)
            and _stat_link(install_files.get("timer_wants"),
                           "../" + REPAIR_TIMER, "install timer wants", problems)
            and _stat_link(install_files.get("path_wants"),
                           "../" + REPAIR_PATH, "install path wants", problems)
            and (install_files.get("staged") or {}).get("type") == "missing"
            and (install_files.get("trigger") or {}).get("type") == "missing"
            and (install_files.get("completions") or {}).get("type") == "missing"
            and (install_files.get("caller") or {}).get("type") == "file"
            and (install_files.get("blocker") or {}).get("type") == "file"
            and _unit_ok(install_units, REPAIR_UNIT,
                         REPAIR_PATHS["service"], ("inactive",), "static",
                         "install service", problems)
            and _unit_ok(install_units, REPAIR_TIMER,
                         REPAIR_PATHS["timer"], ("inactive",), "enabled",
                         "install timer", problems)
            and _unit_ok(install_units, REPAIR_PATH,
                         REPAIR_PATHS["path"], ("inactive",), "enabled",
                         "install path", problems)
            and _unit_ok(install_units, "crq-probe-caller.service",
                         UNIT_DIR + "/crq-probe-caller.service",
                         ("inactive",), "static", "install caller", problems)
            and _unit_ok(install_units, "crq-probe-blocker.service",
                         UNIT_DIR + "/crq-probe-blocker.service",
                         ("inactive",), "static", "install blocker", problems)
            and install.get("completions") == []
            and _tick_ok(install.get("tick"), prepared, snapshot,
                         "install tick snapshot", problems)
            and _preserved_ok(install.get("preserved"), prepared,
                              "install", problems))
        unrelated = install.get("unrelated") or {}
        checks["activator_install_unrelated"] = (
            type(unrelated.get("pid")) is int and unrelated["pid"] > 0
            and isinstance(unrelated.get("starttime"), str)
            and "activator-unrelated" in (unrelated.get("cmdline") or []))

    positive = phases.get("activators-positive") or {}
    if not _ok_phase(positive, "activators-positive", problems):
        checks["activator_positive_controls"] = False
    else:
        controls = positive.get("controls") or {}
        timer = controls.get("timer") or {}
        path = controls.get("path") or {}
        direct = controls.get("direct") or {}
        dependency = controls.get("dependency") or {}
        queue = controls.get("queue") or {}
        checks["activator_positive_timer"] = (
            _command_ok(timer.get("command"), "timer positive start",
                        problems)
            and _command_ok(timer.get("stop"), "timer positive stop",
                            problems)
            and (timer.get("state") or {}).get("ActiveState") == "active"
            and (timer.get("state") or {}).get("UnitFileState") == "enabled"
            and _completions_ok(timer.get("new"), PYTHON_RUNTIME,
                                "timer positive completion", problems)
            and _count_ok(timer.get("before_count"),
                          "timer positive before", problems)
            and _count_ok(timer.get("after_count"),
                          "timer positive after", problems)
            and timer["after_count"] > timer["before_count"])
        checks["activator_positive_path"] = (
            _command_ok(path.get("command"), "path positive start", problems)
            and _command_ok(path.get("stop"), "path positive stop", problems)
            and (path.get("state") or {}).get("ActiveState") == "active"
            and (path.get("state") or {}).get("UnitFileState") == "enabled"
            and _completions_ok(path.get("new"), PYTHON_RUNTIME,
                                "path positive completion", problems)
            and _count_ok(path.get("before_count"),
                          "path positive before", problems)
            and _count_ok(path.get("after_count"),
                          "path positive after", problems)
            and path["after_count"] > path["before_count"])
        checks["activator_positive_direct"] = (
            _command_ok(direct.get("command"), "direct positive start",
                        problems)
            and _command_ok(direct.get("stop"), "direct positive stop",
                            problems)
            and (direct.get("state") or {}).get("Result") == "success"
            and (direct.get("state") or {}).get("UnitFileState") == "static"
            and _completions_ok(direct.get("new"), PYTHON_RUNTIME,
                                "direct positive completion", problems)
            and _count_ok(direct.get("before_count"),
                          "direct positive before", problems)
            and _count_ok(direct.get("after_count"),
                          "direct positive after", problems)
            and direct["after_count"] > direct["before_count"])
        checks["activator_positive_dependency"] = (
            _command_ok(dependency.get("command"),
                        "dependency positive start", problems)
            and _command_ok(dependency.get("stop"),
                            "dependency positive stop", problems)
            and (dependency.get("state") or {}).get("UnitFileState") == "static"
            and _completions_ok(dependency.get("new"), PYTHON_RUNTIME,
                                "dependency positive completion", problems)
            and _count_ok(dependency.get("before_count"),
                          "dependency positive before", problems)
            and _count_ok(dependency.get("after_count"),
                          "dependency positive after", problems)
            and dependency["after_count"] > dependency["before_count"])
        checks["activator_positive_queue"] = _positive_queue_ok(queue, problems)
        pre_switch = positive.get("pre_switch") or {}
        pre_units = pre_switch.get("repair_units") or {}
        pre_files = pre_switch.get("repair_files") or {}
        expected = _repair_expected(PYTHON_RUNTIME)
        checks["activator_positive_pre_switch"] = (
            _stat_file(pre_files.get("service"), expected["service"],
                       "pre-switch service", problems)
            and _stat_file(pre_files.get("timer"), expected["timer"],
                           "pre-switch timer", problems)
            and _stat_file(pre_files.get("path"), expected["path"],
                           "pre-switch path", problems)
            and _stat_file(pre_files.get("dropin"), expected["dropin"],
                           "pre-switch drop-in", problems)
            and _stat_link(pre_files.get("timer_wants"), "../" + REPAIR_TIMER,
                           "pre-switch timer wants", problems)
            and _stat_link(pre_files.get("path_wants"), "../" + REPAIR_PATH,
                           "pre-switch path wants", problems)
            and (pre_files.get("staged") or {}).get("type") == "missing"
            and _unit_ok(pre_units, REPAIR_TIMER, REPAIR_PATHS["timer"],
                         ("active",), "enabled", "pre-switch timer", problems)
            and _unit_ok(pre_units, REPAIR_PATH, REPAIR_PATHS["path"],
                         ("inactive",), "enabled", "pre-switch path", problems)
            and _unit_ok(pre_units, REPAIR_UNIT, REPAIR_PATHS["service"],
                         ("inactive",), "static", "pre-switch service", problems)
            and _completions_ok(pre_switch.get("repair_completions"),
                                PYTHON_RUNTIME, "pre-switch completion",
                                problems)
            and _preserved_ok(positive.get("preserved"), prepared,
                              "positive controls", problems))

    unknown = phases.get("activators-unknown") or {}
    if not _ok_phase(unknown, "activators-unknown", problems):
        checks["activator_refusals"] = False
    else:
        baseline = unknown.get("baseline") or {}
        after = unknown.get("after") or {}
        baseline_files = baseline.get("files") or {}
        after_files = after.get("files") or {}
        expected = _repair_expected(PYTHON_RUNTIME)
        baseline_ok = (
            _stat_file(baseline_files.get("service"), expected["service"],
                       "refusal baseline service", problems)
            and _stat_file(baseline_files.get("timer"), expected["timer"],
                           "refusal baseline timer", problems)
            and _stat_file(baseline_files.get("path"), expected["path"],
                           "refusal baseline path", problems)
            and _stat_file(baseline_files.get("dropin"), expected["dropin"],
                           "refusal baseline drop-in", problems)
            and _stat_link(baseline_files.get("timer_wants"),
                           "../" + REPAIR_TIMER, "refusal baseline timer wants",
                           problems)
            and _stat_link(baseline_files.get("path_wants"),
                           "../" + REPAIR_PATH, "refusal baseline path wants",
                           problems)
            and (baseline_files.get("staged") or {}).get("type") == "missing"
            and (baseline_files.get("trigger") or {}).get("type") == "missing"
            and baseline_files == after_files
            and _record_inventory_ok(baseline.get("records"),
                                     "refusal baseline records", problems)
            and _record_inventory_ok(after.get("records"),
                                     "refusal final records", problems)
            and baseline.get("records") == after.get("records")
            and baseline.get("tick") == after.get("tick")
            and _tick_ok(after.get("tick"), prepared, snapshot,
                         "refusal tick snapshot", problems))
        cases = unknown.get("cases") or {}
        expected_cases = ("rogue-unit", "unknown-link", "unknown-dropin",
                          "unsafe-metadata")
        case_ok = True
        for name in expected_cases:
            case = cases.get(name) or {}
            this_ok = _refusal_case_ok(name, case, baseline, unknown,
                                       problems)
            case_ok = case_ok and this_ok
        checks["activator_refusals"] = bool(baseline_ok and case_ok)

    fence = phases.get("activators-fence") or {}
    if not _ok_phase(fence, "activators-fence", problems):
        checks["activator_fence"] = False
    else:
        cli = fence.get("cli") or {}
        payload = cli.get("json") or {}
        record = fence.get("record") or {}
        cli_record = payload.get("record") or {}
        drain = payload.get("drain") or {}
        during = cli.get("during") or {}
        before = fence.get("before") or {}
        after = fence.get("after") or {}
        before_files = before.get("repair_files") or {}
        after_files = after.get("repair_files") or {}
        before_units = before.get("repair_units") or {}
        after_units = after.get("repair_units") or {}
        expected_before = _repair_expected(PYTHON_RUNTIME)
        expected_after = _repair_expected(NODE_RUNTIME)
        queue_seed = fence.get("queue_seed") or {}
        direct = drain.get("direct_start") or {}
        direct_text = ((direct.get("stdout") or "")
                       + (direct.get("stderr") or "")).lower()
        blocker_stop = fence.get("blocker_stop") or {}
        drain_jobs_observation = drain.get("jobs_observation") or {}
        external_direct = during.get("direct") or {}
        external_direct_text = ((external_direct.get("stdout") or "")
                                + (external_direct.get("stderr") or "")).lower()
        external_dependency = during.get("dependency") or {}
        external_dependency_text = (
            (external_dependency.get("stdout") or "")
            + (external_dependency.get("stderr") or "")).lower()
        checks["activator_fence"] = (
            cli.get("rc") == 0
            and cli.get("pause_reached") is True
            and cli.get("timeout") is False
            and record.get("outcome") == "completed"
            and record.get("phase") == "activation_pending"
            and record.get("unit") == REPAIR_UNIT
            and record.get("runtime") == NODE_RUNTIME
            and record.get("prior_runtime") == PYTHON_RUNTIME
            and _fence_completion_ok(fence, during, record, problems)
            and cli_record.get("transaction_id") == record.get("transaction_id")
            and cli_record.get("snapshot_runtime") == PYTHON_RUNTIME
            and set(cli_record.get("snapshot_paths") or []) == set(REPAIR_PATHS.values())
            and _fence_records_ok(fence, problems)
            and _stat_file(before_files.get("service"), expected_before["service"],
                           "fence before service", problems)
            and _stat_file(before_files.get("timer"), expected_before["timer"],
                           "fence before timer", problems)
            and _stat_file(before_files.get("path"), expected_before["path"],
                           "fence before path", problems)
            and _stat_file(before_files.get("dropin"), expected_before["dropin"],
                           "fence before drop-in", problems)
            and _stat_link(before_files.get("timer_wants"), "../" + REPAIR_TIMER,
                           "fence before timer wants", problems)
            and _stat_link(before_files.get("path_wants"), "../" + REPAIR_PATH,
                           "fence before path wants", problems)
            and (before_files.get("staged") or {}).get("type") == "missing"
            and _unit_ok(before_units, REPAIR_TIMER, REPAIR_PATHS["timer"],
                         ("active",), "enabled", "fence before timer", problems)
            and _unit_ok(before_units, REPAIR_PATH, REPAIR_PATHS["path"],
                         ("inactive",), "enabled", "fence before path", problems)
            and _stat_file(after_files.get("service"), expected_after["service"],
                           "fence after service", problems)
            and _stat_file(after_files.get("timer"), expected_after["timer"],
                           "fence after timer", problems)
            and _stat_file(after_files.get("path"), expected_after["path"],
                           "fence after path", problems)
            and _stat_file(after_files.get("dropin"), expected_after["dropin"],
                           "fence after drop-in", problems)
            and _stat_link(after_files.get("timer_wants"), "../" + REPAIR_TIMER,
                           "fence after timer wants", problems)
            and _stat_link(after_files.get("path_wants"), "../" + REPAIR_PATH,
                           "fence after path wants", problems)
            and (after_files.get("staged") or {}).get("type") == "missing"
            and _unit_ok(after_units, REPAIR_TIMER, REPAIR_PATHS["timer"],
                         ("active",), "enabled", "fence after timer", problems)
            and _unit_ok(after_units, REPAIR_PATH, REPAIR_PATHS["path"],
                         ("inactive",), "enabled", "fence after path", problems)
            and _unit_ok(after_units, REPAIR_UNIT, REPAIR_PATHS["service"],
                         ("inactive", "active", "activating"), "static",
                         "fence after service", problems)
            and _fence_job_ok(queue_seed, during, problems)
            and drain.get("jobs") == []
            and _job_observation_ok(drain_jobs_observation,
                                    "fence drain job observation", problems, [])
            and _command_ok(drain.get("service_stop"),
                            "fence service stop", problems, allowed=(0, 5))
            and _command_ok(blocker_stop, "fence blocker stop", problems)
            and (drain.get("state") or {}).get("ActiveState") == "inactive"
            and (drain.get("owned") or {}).get("pids") == []
            and (drain.get("owned") or {}).get("main_pid") == 0
            and (drain.get("activators") or {}).get(REPAIR_TIMER, {}).get(
                "ActiveState") in ("inactive", "failed")
            and (drain.get("activators") or {}).get(REPAIR_PATH, {}).get(
                "ActiveState") in ("inactive", "failed")
            and _command_ok(direct, "fence direct start", problems,
                            allowed=(1,))
            and "masked" in direct_text
            and (drain.get("queue_drain") or {}).get("drained") is True
            and _command_ok(external_direct, "fence external direct start",
                            problems, allowed=(1,))
            and "masked" in external_direct_text
            and _command_ok(external_dependency,
                            "fence external dependency start", problems,
                            allowed=(1,))
            and ("masked" in external_dependency_text
                 or "required" in external_dependency_text
                 or "dependency" in external_dependency_text)
            and (during.get("path_state") or {}).get("ActiveState")
            == "inactive"
            and (during.get("marker") or {}).get("phase") == "after-mask-reload"
            and _preserved_ok(fence.get("preserved"), prepared, "fence",
                              problems))

    switch_back = phases.get("activators-switch-back") or {}
    if not _ok_phase(switch_back, "activators-switch-back", problems):
        checks["activator_switch_back"] = False
    else:
        cli = switch_back.get("cli") or {}
        record = switch_back.get("record") or {}
        before = switch_back.get("before") or {}
        after = switch_back.get("after") or {}
        expected = _repair_expected(PYTHON_RUNTIME)
        records_before = switch_back.get("records_before") or []
        records_after = switch_back.get("records_after") or []
        completions = record.get("completions") or []
        baseline = max((item.get("sequence", 0)
                        for item in (before.get("repair_completions") or [])),
                       default=0)
        checks["activator_switch_back"] = (
            cli.get("rc") == 0
            and record.get("outcome") == "completed"
            and record.get("runtime") == PYTHON_RUNTIME
            and record.get("prior_runtime") == NODE_RUNTIME
            and record.get("unit") == REPAIR_UNIT
            and len(completions) == 2
            and all(_completion_ok(item, PYTHON_RUNTIME,
                                   "switch-back completion", problems)
                    for item in completions)
            and all(item.get("sequence", 0) > baseline
                    for item in completions)
            and len(records_after) == len(records_before) + 1
            and _stat_file((after.get("repair_files") or {}).get("service"),
                           expected["service"], "switch-back service", problems)
            and _unit_ok(after.get("repair_units") or {}, REPAIR_TIMER,
                         REPAIR_PATHS["timer"], ("active",), "enabled",
                         "switch-back timer", problems)
            and _unit_ok(after.get("repair_units") or {}, REPAIR_PATH,
                         REPAIR_PATHS["path"], ("inactive",), "enabled",
                         "switch-back path", problems)
            and _stat_link((after.get("repair_files") or {}).get("timer_wants"),
                           "../" + REPAIR_TIMER, "switch-back timer wants",
                           problems)
            and _stat_link((after.get("repair_files") or {}).get("path_wants"),
                           "../" + REPAIR_PATH, "switch-back path wants",
                           problems)
            and _preserved_ok(switch_back.get("preserved"), prepared,
                              "switch back", problems))

    interrupt = phases.get("activators-interrupt") or {}
    if not _ok_phase(interrupt, "activators-interrupt", problems):
        checks["activator_interrupt"] = False
    else:
        cli = interrupt.get("cli") or {}
        record = interrupt.get("record") or {}
        after = interrupt.get("after") or {}
        after_files = after.get("repair_files") or {}
        before = interrupt.get("before") or {}
        checks["activator_interrupt"] = (
            cli.get("rc") not in (0, None)
            and record.get("outcome") == "pending"
            and record.get("phase") == "drained"
            and record.get("runtime") == NODE_RUNTIME
            and record.get("prior_runtime") == PYTHON_RUNTIME
            and (after_files.get("service") or {}).get("type") == "symlink"
            and (after_files.get("service") or {}).get("target") == "/dev/null"
            and (after_files.get("staged") or {}).get("type") == "missing"
            and _unit_ok(after.get("repair_units") or {}, REPAIR_TIMER,
                         REPAIR_PATHS["timer"], ("inactive", "failed"),
                         "enabled", "interrupt timer", problems)
            and _unit_ok(after.get("repair_units") or {}, REPAIR_PATH,
                         REPAIR_PATHS["path"], ("inactive", "failed"),
                         "enabled", "interrupt path", problems)
            and len(after.get("repair_completions") or [])
            == len(before.get("repair_completions") or [])
            and _preserved_ok(interrupt.get("preserved"), prepared,
                              "interrupt", problems))

    recover = phases.get("activators-recover") or {}
    if not _ok_phase(recover, "activators-recover", problems):
        checks["activator_recover"] = False
    else:
        cli = recover.get("cli") or {}
        record_before = recover.get("record_before") or {}
        record_after = recover.get("record_after") or {}
        after = recover.get("after") or {}
        expected = _repair_expected(PYTHON_RUNTIME)
        after_files = after.get("repair_files") or {}
        checks["activator_recover"] = (
            cli.get("rc") == 0
            and record_before.get("outcome") == "pending"
            and record_before.get("phase") == "drained"
            and record_after.get("outcome") == "rolled_back"
            and record_after.get("phase") == "restore_activation_pending"
            and record_before.get("path") == record_after.get("path")
            and record_before.get("sha256") != record_after.get("sha256")
            and _stat_file(after_files.get("service"), expected["service"],
                           "recover service", problems)
            and (after_files.get("staged") or {}).get("type") == "missing"
            and _stat_file(after_files.get("timer"), expected["timer"],
                           "recover timer", problems)
            and _stat_file(after_files.get("path"), expected["path"],
                           "recover path", problems)
            and _stat_file(after_files.get("dropin"), expected["dropin"],
                           "recover drop-in", problems)
            and _stat_link(after_files.get("timer_wants"), "../" + REPAIR_TIMER,
                           "recover timer wants", problems)
            and _stat_link(after_files.get("path_wants"), "../" + REPAIR_PATH,
                           "recover path wants", problems)
            and _unit_ok(after.get("repair_units") or {}, REPAIR_TIMER,
                         REPAIR_PATHS["timer"], ("active",), "enabled",
                         "recover timer", problems)
            and _unit_ok(after.get("repair_units") or {}, REPAIR_PATH,
                         REPAIR_PATHS["path"], ("inactive",), "enabled",
                         "recover path", problems)
            and _preserved_ok(recover.get("preserved"), prepared, "recover",
                              problems))

    repeat = phases.get("activators-repeat") or {}
    if not _ok_phase(repeat, "activators-repeat", problems):
        checks["activator_repeat"] = False
    else:
        record_before = repeat.get("record_before") or {}
        record_after = repeat.get("record_after") or {}
        checks["activator_repeat"] = (
            (repeat.get("cli") or {}).get("rc") == 2
            and record_before.get("sha256") == record_after.get("sha256")
            and record_after.get("outcome") == "rolled_back")

    inspect = phases.get("activators-inspect") or {}
    if not _ok_phase(inspect, "activators-inspect", problems):
        checks["activator_inspect"] = False
    else:
        repair = inspect.get("repair") or {}
        tick = inspect.get("tick") or {}
        repair_files = repair.get("repair_files") or {}
        expected = _repair_expected(PYTHON_RUNTIME)
        checks["activator_inspect"] = (
            _stat_file(repair_files.get("service"), expected["service"],
                       "inspect service", problems)
            and _stat_file(repair_files.get("timer"), expected["timer"],
                           "inspect timer", problems)
            and _stat_file(repair_files.get("path"), expected["path"],
                           "inspect path", problems)
            and _stat_file(repair_files.get("dropin"), expected["dropin"],
                           "inspect drop-in", problems)
            and _stat_link(repair_files.get("timer_wants"),
                           "../" + REPAIR_TIMER, "inspect timer wants",
                           problems)
            and _stat_link(repair_files.get("path_wants"),
                           "../" + REPAIR_PATH, "inspect path wants", problems)
            and (repair_files.get("staged") or {}).get("type") == "missing"
            and (repair_files.get("trigger") or {}).get("type") == "missing"
            and _unit_ok(repair.get("repair_units") or {}, REPAIR_TIMER,
                         REPAIR_PATHS["timer"], ("active",), "enabled",
                         "inspect timer", problems)
            and _unit_ok(repair.get("repair_units") or {}, REPAIR_PATH,
                         REPAIR_PATHS["path"], ("inactive",), "enabled",
                         "inspect path", problems)
            and len(repair.get("records") or []) == 3
            and _tick_ok(tick, prepared, snapshot, "inspect tick snapshot",
                         problems)
            and (inspect.get("unrelated") or {}).get(
                "alive_before_cleanup") is True
            and (inspect.get("unrelated") or {}).get(
                "alive_after_cleanup") is False
            and _preserved_ok(inspect.get("preserved"), prepared, "inspect",
                              problems))

    for key, value in checks.items():
        if value is not True:
            problems.append(key + " is not satisfied")
    return checks, problems


def build_checks(phases, restarts=None, reboots=None, mode="base"):
    if mode == "activators":
        return _activator_checks(phases)
    checks = {}
    problems = []
    prepare = phases.get("prepare") or {}
    if not _ok_phase(prepare, "prepare", problems):
        return checks, problems
    snapshot = prepare.get("snapshot") or {}
    prepared = prepare.get("prepared") or {}
    if not isinstance(prepared, dict) or not prepared.get("state") \
            or not prepared.get("history_sha256"):
        problems.append("prepare evidence has no preserved state or history digest")
        checks["prepared_baseline_present"] = False
        return checks, problems
    service_path = "/home/%s/.config/systemd/user/crq-tick.service" % vm.GUEST_USER
    timer_path = "/home/%s/.config/systemd/user/crq-tick.timer" % vm.GUEST_USER
    wants_path = ("/home/%s/.config/systemd/user/timers.target.wants/"
                  "crq-tick.timer" % vm.GUEST_USER)
    checks["guest_isolation"] = (
        snapshot.get("hostname") == "crq-probe"
        and snapshot.get("user") == 1000
        and snapshot.get("boot_id") is not None)
    checks["initial_runtime_python"] = (
        (snapshot.get("files") or {}).get(service_path, {}).get("sha256")
        == _sha(expected_unit(PYTHON_RUNTIME)))
    checks["initial_timer_enabled_inactive"] = (
        (snapshot.get("units") or {}).get("crq-tick.timer", {}).get(
            "UnitFileState") == "enabled"
        and (snapshot.get("units") or {}).get("crq-tick.timer", {}).get(
            "ActiveState") == "inactive")
    checks["historical_record_seeded"] = bool(
        (snapshot.get("history") or {}).get("sha256"))
    runner_source = prepared.get("runner_source") or {}
    checks["runner_source_recorded"] = (
        isinstance(runner_source.get("sha256"), str)
        and HEX64.fullmatch(runner_source["sha256"]) is not None
        and isinstance(runner_source.get("crq_sha256"), str)
        and HEX64.fullmatch(runner_source["crq_sha256"]) is not None
        and type(runner_source.get("bytes")) is int
        and runner_source["bytes"] > 0)

    for name, kind in (("drain-alive", "alive"),
                       ("drain-ambiguous", "ambiguous")):
        phase = phases.get(name) or {}
        if not _ok_phase(phase, name, problems):
            checks[name.replace("-", "_") + "_refused"] = False
            continue
        checks[name.replace("-", "_") + "_refused"] = _drain_refusal_ok(
            phase, kind)

    harvest = phases.get("drain-harvest") or {}
    if not _ok_phase(harvest, "drain-harvest", problems):
        checks["drain_harvest_proceeds"] = False
    else:
        checks["drain_harvest_proceeds"] = _drain_harvest_ok(harvest)

    recovery_drain = phases.get("recover-drain-alive") or {}
    if not _ok_phase(recovery_drain, "recover-drain-alive", problems):
        checks["recovery_drain_refused"] = False
    else:
        checks["recovery_drain_refused"] = _recovery_drain_refusal_ok(
            recovery_drain, service_path,
            (prepared.get("state") or {}).get("queue.json"))

    for name, runtime, prior in (("switch-node", NODE_RUNTIME, PYTHON_RUNTIME),
                                 ("switch-python", PYTHON_RUNTIME, NODE_RUNTIME)):
        phase = phases.get(name) or {}
        if not _ok_phase(phase, name, problems):
            checks[name + "_completed"] = False
            continue
        record = phase.get("record") or {}
        evidence = phase.get("completions") or {}
        after = phase.get("after") or {}
        checks[name + "_completed"] = (
            record.get("outcome") == "completed"
            and record.get("runtime") == runtime
            and record.get("prior_runtime") == prior
            and phase.get("installed_runtime") == runtime
            and (after.get("files") or {}).get(service_path, {}).get("sha256")
            == _sha(expected_unit(runtime)))
        checks[name + "_two_advancing_distinct_completions"] = (
            len(evidence.get("sequences") or []) == 2
            and evidence["sequences"][0] < evidence["sequences"][1]
            and len(set(evidence.get("invocations") or [])) == 2)
        checks[name + "_preserved_state_and_history"] = (
            phase.get("preserved", {}).get("state")
            == prepared.get("state")
            and phase.get("preserved", {}).get("history_sha256")
            == prepared.get("history_sha256"))

    interrupt = phases.get("interrupt") or {}
    if not _ok_phase(interrupt, "interrupt", problems):
        checks["preactivation_interrupt_retained"] = False
    else:
        record = interrupt.get("record") or {}
        after = interrupt.get("after") or {}
        checks["preactivation_interrupt_retained"] = (
            record.get("outcome") == "pending"
            and record.get("phase") == "drained"
            and (after.get("files") or {}).get(service_path, {}).get("type")
            == "symlink"
            and (after.get("files") or {}).get(service_path, {}).get("target")
            == "/dev/null"
            and (after.get("units") or {}).get("crq-tick.timer", {}).get(
                "ActiveState") in ("inactive", "failed"))

    recover_kill = phases.get("recover-kill") or {}
    if not _ok_phase(recover_kill, "recover-kill", problems):
        checks["recovery_interruption_preserved_record"] = False
    else:
        before = recover_kill.get("record_before") or {}
        after = recover_kill.get("record_after") or {}
        checks["recovery_interruption_preserved_record"] = (
            _sha_present(before)
            and _sha_present(after)
            and before["sha256"] == after["sha256"]
            and after.get("outcome") == "pending"
            and after.get("phase") == "drained")

    recover = phases.get("recover") or {}
    if not _ok_phase(recover, "recover", problems):
        checks["recovery_rolled_back"] = False
    else:
        record = recover.get("record") or {}
        after = recover.get("after") or {}
        checks["recovery_rolled_back"] = (
            record.get("outcome") == "rolled_back"
            and record.get("phase") == "restore_activation_pending")
        checks["recovery_restored_exact_python_bytes"] = (
            (after.get("files") or {}).get(service_path, {}).get("sha256")
            == _sha(expected_unit(PYTHON_RUNTIME)))
        checks["recovery_restored_timer_state"] = (
            (after.get("units") or {}).get("crq-tick.timer", {}).get(
                "UnitFileState") == "enabled"
            and (after.get("units") or {}).get("crq-tick.timer", {}).get(
                "ActiveState") == "inactive")
        checks["recovery_preserved_state_and_history"] = (
            recover.get("preserved", {}).get("state") == prepared.get("state")
            and recover.get("preserved", {}).get("history_sha256")
            == prepared.get("history_sha256"))

    repeat = phases.get("recover-repeat") or {}
    if not _ok_phase(repeat, "recover-repeat", problems):
        checks["repeat_recovery_refused"] = False
    else:
        checks["repeat_recovery_refused"] = (
            (repeat.get("cli") or {}).get("rc") == 2
            and "refused" in ((repeat.get("cli") or {}).get("stdout") or "")
            and (repeat.get("record_before") or {}).get("sha256")
            == (repeat.get("record_after") or {}).get("sha256"))

    rollback = phases.get("rollback-fence") or {}
    if not _ok_phase(rollback, "rollback-fence", problems):
        checks["rollback_fence_held"] = False
        checks["rollback_fence_recovery_completed"] = False
    else:
        record = rollback.get("record") or {}
        after_kill = rollback.get("record_after_kill") or {}
        service = rollback.get("service") or {}
        staged = rollback.get("staged") or {}
        direct = rollback.get("direct_start") or {}
        direct_text = ((direct.get("stdout") or "")
                       + (direct.get("stderr") or "")).lower()
        checks["rollback_fence_held"] = (
            record.get("outcome") == "pending"
            and record.get("phase") == "drained"
            and after_kill.get("sha256") == record.get("sha256")
            and after_kill.get("outcome") == "pending"
            and after_kill.get("phase") == "drained"
            and service.get("LoadState") == "masked"
            and service.get("FragmentPath") == service_path
            and staged.get("type") == "file"
            and staged.get("runtime") == PYTHON_RUNTIME
            and direct.get("rc") not in (0, None)
            and "masked" in direct_text
            and rollback.get("completions_before")
            == rollback.get("completions_after_kill"))
        completed = rollback.get("record_completed") or {}
        after = rollback.get("after") or {}
        rollback_repeat = rollback.get("repeat") or {}
        repeated = rollback.get("record_after_repeat") or {}
        checks["rollback_fence_recovery_completed"] = (
            completed.get("outcome") == "rolled_back"
            and completed.get("phase") == "restore_activation_pending"
            and (after.get("files") or {}).get(service_path, {}).get("sha256")
            == _sha(expected_unit(PYTHON_RUNTIME))
            and (rollback.get("staged_after_completion") or {}).get("type")
            == "missing"
            and (after.get("units") or {}).get("crq-tick.timer", {}).get(
                "UnitFileState") == "enabled"
            and (after.get("units") or {}).get("crq-tick.timer", {}).get(
                "ActiveState") == "inactive"
            and rollback_repeat.get("rc") == 2
            and "refused" in (rollback_repeat.get("stdout") or "")
            and repeated.get("sha256") == completed.get("sha256")
            and rollback.get("preserved", {}).get("state")
            == prepared.get("state")
            and rollback.get("preserved", {}).get("history_sha256")
            == prepared.get("history_sha256"))

    inspect = phases.get("inspect") or {}
    if not _ok_phase(inspect, "inspect", problems):
        checks["final_state_python_and_queue_preserved"] = False
    else:
        final = inspect.get("snapshot") or {}
        checks["final_state_python_and_queue_preserved"] = (
            (final.get("files") or {}).get(service_path, {}).get("sha256")
            == _sha(expected_unit(PYTHON_RUNTIME))
            and (final.get("files") or {}).get(wants_path, {}).get("type")
            == "symlink"
            and (final.get("state") or {}).get("queue.json")
            == prepared.get("state", {}).get("queue.json")
            and (final.get("state") or {}).get("heartbeat.json")
            == prepared.get("state", {}).get("heartbeat.json"))

    fence = phases.get("fence") or {}
    if not _ok_phase(fence, "fence", problems):
        checks["activation_fence_held"] = False
    else:
        fence_record = fence.get("record") or {}
        fence_after = fence.get("after") or {}
        fence_service = (fence_after.get("files") or {}).get(service_path) or {}
        fence_units = fence_after.get("units") or {}
        direct = fence.get("direct_start") or {}
        direct_text = ((direct.get("stdout") or "")
                       + (direct.get("stderr") or "")).lower()
        checks["activation_fence_held"] = (
            (fence.get("cli") or {}).get("rc") not in (0, None)
            and fence_record.get("outcome") == "pending"
            and fence_record.get("phase") == "activation_pending"
            and fence_record.get("runtime") == NODE_RUNTIME
            and fence_record.get("prior_runtime") == PYTHON_RUNTIME
            and fence_service.get("type") == "symlink"
            and fence_service.get("target") == "/dev/null"
            and (fence_units.get("crq-tick.service") or {}).get("LoadState")
            == "masked"
            and (fence_units.get("crq-tick.timer") or {}).get("ActiveState")
            in ("inactive", "failed")
            and direct.get("rc") not in (0, None)
            and "masked" in direct_text
            and (fence.get("staged") or {}).get("runtime") == NODE_RUNTIME
            and fence.get("completions_before") == fence.get("completions_after")
            and (fence.get("recovery") or {}).get("rc") == 3
            and (fence.get("record_after_refusal") or {}).get("sha256")
            == fence_record.get("sha256"))

    if mode == "matrix":
        checks.update(_matrix_checks(phases, restarts, reboots, prepared,
                                    problems))

    for key, value in checks.items():
        if value is not True:
            problems.append(key + " is not satisfied")
    return checks, problems


def run_steps(mode="base"):
    if mode == "base":
        return [("phase", name, {}) for name in GUEST_PHASES]
    if mode == "activators":
        return [("phase", name, {}) for name in ACTIVATOR_GUEST_PHASES]
    steps = [("phase", name, {}) for name in GUEST_PHASES[:-1]]
    for case in ("matrix-restart-drained", "matrix-restart-restore-staged",
                 "matrix-restart-ambiguity"):
        steps.append(("phase", case, {}))
        steps.append(("restart_manager", case, {}))
        steps.append(("phase", case + "-observe", {"case": case}))
    steps.append(("phase", "matrix-reset-python",
                  {"after": "matrix-restart-ambiguity-observe"}))
    steps.append(("phase", "matrix-switch-node", {}))
    for case in ("matrix-reboot-drained", "matrix-reboot-restore-staged",
                 "matrix-reboot-ambiguity"):
        steps.append(("phase", case, {}))
        steps.append(("reboot", case, {}))
        steps.append(("phase", case + "-observe", {"case": case}))
    steps.append(("phase", "matrix-reset-python-final",
                  {"after": "matrix-reboot-ambiguity-observe"}))
    steps.append(("phase", "fence", {}))
    return steps


def build_report(run, boot, phases, restarts, reboots, stamps, image,
                 provenance, raw, mode="base"):
    checks, problems = build_checks(phases, restarts, reboots, mode)
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": KIND,
        "mode": mode,
        "generated_at": vm.utc_now(),
        "run": run["run_id"],
        "path": run["path"],
        "source_commit": provenance["source_commit"],
        "image": image,
        "boot": {key: boot[key] for key in ("pid", "starttime", "scope_unit",
                                            "port") if key in boot},
        "stamps": stamps,
        "provenance": provenance,
        "raw": raw,
        "phases": phases,
        "restarts": restarts,
        "reboots": reboots,
        "checks": checks,
        "problems": problems,
        "limitations": (ACTIVATOR_LIMITATIONS if mode == "activators"
                        else MATRIX_LIMITATIONS if mode == "matrix"
                        else LIMITATIONS),
    }


def source_commit_check(repo, commit):
    if not isinstance(commit, str) or len(commit) != 40:
        raise ValueError("source commit must be a full 40-character SHA")
    head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"],
                          capture_output=True, text=True, check=True).stdout.strip()
    if head != commit:
        raise ValueError("source commit is not the worktree HEAD")
    for label, names in (("uploaded proof scripts", UPLOADS),
                         ("host proof modules", HOST_MODULES)):
        status = subprocess.run(
            ["git", "-C", str(repo), "status", "--porcelain", "--"] +
            [str(OPS / name) for name in names],
            capture_output=True, text=True, check=True).stdout.strip()
        if status:
            raise ValueError(label + " have uncommitted changes")
    status = subprocess.run(
        ["git", "-C", str(repo), "status", "--porcelain", "--",
         "apps/crq-python"],
        capture_output=True, text=True, check=True).stdout.strip()
    if status:
        raise ValueError("runner source has uncommitted changes")
    return head


def cmd_run(args):
    state = pathlib.Path(args.state_dir).expanduser().resolve()
    state.mkdir(parents=True, exist_ok=True)
    commit = source_commit_check(REPO, args.source_commit)
    recorder = vm.Recorder(state)
    stamps = {"start": vm.host_stamp()}
    image = vm.fetch_image(state, recorder)
    run = prepare_run(state, image, recorder, args.tools)
    vm.save_json(pathlib.Path(run["path"]) / "run.json", run)
    try:
        run_dir = pathlib.Path(run["path"])
        host_source = pathlib.Path(__file__).resolve()
        guest_source = OPS / "vm-unit-switch-guest.py"
        host_artifact = run_dir / "executed-host-script.py"
        guest_artifact = run_dir / "executed-guest-probe.py"
        shutil.copy2(host_source, host_artifact)
        guest_artifact.write_bytes(guest_source.read_bytes())
        host_modules = {}
        for name in HOST_MODULES:
            source = host_source if name == "vm-unit-switch.py" else OPS / name
            artifact = (host_artifact if name == "vm-unit-switch.py"
                        else run_dir / ("executed-host-" + name))
            if artifact != host_artifact:
                shutil.copy2(source, artifact)
            host_modules[name] = {"artifact": artifact.name,
                                  "sha256": vm.sha256_file(artifact)}
        provenance = {
            "source_commit": commit,
            "host_script": {"artifact": host_artifact.name,
                            "sha256": vm.sha256_file(host_artifact)},
            "host_modules": host_modules,
            "guest_script": {"artifact": guest_artifact.name,
                             "sha256": vm.sha256_file(guest_artifact)},
        }
        recorder = vm.Recorder(run_dir)
        boot = vm.boot(run, recorder, args.tools, vm.host_stamp())
        boot["ssh"] = vm.wait_ssh(run, recorder)
        uploads = upload_files(run, recorder)
        provenance["uploads"] = uploads
        provenance["guest_report"] = guest_artifact.name
        phases = {}
        restarts = {}
        reboots = {}
        for kind, name, options in run_steps(args.mode):
            if kind == "phase":
                extra = []
                if name == "drain-alive":
                    extra = ["--runtime", NODE_RUNTIME, "--seed", "alive"]
                elif name == "drain-ambiguous":
                    extra = ["--runtime", PYTHON_RUNTIME, "--seed", "ambiguous"]
                elif name in ("recover-kill", "recover", "recover-repeat",
                              "recover-drain-alive"):
                    extra = ["--record", phases["interrupt"]["record_path"]]
                if options.get("case"):
                    case = options["case"]
                    extra += ["--boundary", case,
                              "--kind", MATRIX_CASES[case]["kind"]]
                if options.get("after"):
                    extra += ["--after", options["after"]]
                phases[name] = guest_phase(run, name, recorder, extra)
            elif kind == "restart_manager":
                restarts[name] = restart_user_manager(run, recorder, boot, name)
            elif kind == "reboot":
                reboots[name] = reboot_guest_os(run, recorder, boot, name)
        raw = fetch_raw(run, recorder, args.mode)
        stamps["finish"] = vm.host_stamp()
        report = build_report(run, boot, phases, restarts, reboots, stamps,
                              image, provenance, raw, args.mode)
        vm.save_json(run_dir / "report.json", report)
        problems = report["problems"]
    except BaseException:
        if not args.keep:
            try:
                vm.stop_owned_process(run, purge=False)
            except Exception as cleanup_error:
                print("cleanup after failed run did not complete: %s"
                      % cleanup_error, file=sys.stderr)
        raise
    print(json.dumps({"run": run["run_id"], "path": run["path"],
                      "problems": problems, "checks": report["checks"]},
                     indent=2, sort_keys=True))
    if args.keep:
        return 0 if not problems else 1
    cleanup = vm.stop_owned_process(run, purge=False)
    if not cleanup["stopped"]:
        print(json.dumps({"cleanup": cleanup, "problems": problems},
                         indent=2, sort_keys=True))
        return 1
    return 0 if not problems else 1


def _retained_record_problem(summary, raw_root, directory, label, problems):
    if not isinstance(summary, dict) or not summary:
        problems.append(label + " has no retained record summary")
        return
    path = summary.get("path")
    if not isinstance(path, str) or not path:
        problems.append(label + " has no retained record path")
        return
    name = pathlib.PurePosixPath(path).name
    if not name.startswith("controller-") or not name.endswith(".json"):
        problems.append(label + " record path is not a controller journal")
        return
    raw_records = pathlib.Path(raw_root) / directory
    raw_path = raw_records / name
    if raw_path.is_symlink() or not raw_path.is_file():
        problems.append(label + " retained record is missing")
        return
    data = raw_path.read_bytes()
    if summary.get("sha256") != vm.sha256_bytes(data):
        problems.append(label + " record digest does not match retained evidence")
    if summary.get("bytes") is not None and summary.get("bytes") != len(data):
        problems.append(label + " record size does not match retained evidence")
    try:
        record = json.loads(data)
    except ValueError:
        problems.append(label + " retained record is not JSON")
        return
    for key, value in summary.items():
        if key in ("path", "sha256", "bytes"):
            continue
        if record.get(key) != value:
            problems.append(label + " record field " + key
                            + " contradicts retained evidence")


def _phase_cli(phase, label, problems):
    cli = (phase or {}).get("cli")
    if not isinstance(cli, dict):
        problems.append(label + " has no retained CLI result")
        return None
    return cli


def _upload_provenance_problems(report, raw_root, phases):
    problems = []
    provenance = report.get("provenance")
    uploads = provenance.get("uploads") if isinstance(provenance, dict) else None
    if not isinstance(uploads, dict):
        problems.append("upload provenance is not an object")
        return problems
    proof_bin = raw_root / "proof-bin"
    retained = ({entry.name for entry in proof_bin.iterdir()
                 if entry.is_file() and not entry.is_symlink()}
                if proof_bin.is_dir() else set())
    if retained != set(UPLOADS) | {RUNNER_ARCHIVE}:
        problems.append("raw upload set does not match the expected "
                        "controller and fixture scripts")
    for name in UPLOADS:
        entry = uploads.get(name)
        raw_path = proof_bin / name
        if raw_path.is_symlink() or not raw_path.is_file():
            problems.append("raw upload is missing: " + name)
        elif not isinstance(entry, dict) \
                or not _sha256_text(entry.get("sha256")):
            continue
        else:
            if type(entry.get("bytes")) is not int or entry["bytes"] < 0:
                problems.append("raw upload size is invalid: " + name)
            elif raw_path.stat().st_size != entry["bytes"]:
                problems.append("raw upload size does not match: " + name)
            if vm.sha256_file(raw_path) != entry["sha256"]:
                problems.append("raw upload digest does not match: " + name)
    runner = uploads.get("runner_source")
    raw_runner = proof_bin / RUNNER_ARCHIVE
    if not isinstance(runner, dict) or not _sha256_text(runner.get("sha256")):
        problems.append("runner source provenance is missing")
    else:
        if raw_runner.is_symlink() or not raw_runner.is_file():
            problems.append("raw runner source archive is missing")
        elif type(runner.get("bytes")) is not int or runner["bytes"] < 1:
            problems.append("runner source size is invalid")
        elif raw_runner.stat().st_size != runner["bytes"]:
            problems.append("runner source size does not match")
        elif vm.sha256_file(raw_runner) != runner["sha256"]:
            problems.append("runner source digest does not match")
        prepared = ((phases.get("prepare") or {}).get("prepared") or {})
        guest_runner = prepared.get("runner_source") or {}
        if guest_runner.get("sha256") != runner.get("sha256"):
            problems.append("guest runner source digest does not match "
                            "the uploaded archive")
    return problems


def _raw_file_problem(path, text, label, problems):
    path = pathlib.Path(path)
    if path.is_symlink() or not path.is_file():
        problems.append(label + " raw file is missing")
        return False
    if vm.sha256_file(path) != _sha(text):
        problems.append(label + " raw bytes do not match the rendered file")
        return False
    return True


def _raw_link_problem(path, target, label, problems):
    path = pathlib.Path(path)
    if not path.is_symlink():
        problems.append(label + " raw link is missing")
        return False
    if os.readlink(path) != target:
        problems.append(label + " raw link target does not match")
        return False
    return True


def _record_snapshot_problems(record, runtime, label, problems):
    snapshot = record.get("snapshot") or {}
    paths = snapshot.get("paths") or {}
    activators = snapshot.get("activators") or {}
    if snapshot.get("schema_version") != 1 \
            or snapshot.get("unit") != REPAIR_UNIT \
            or snapshot.get("runtime") != runtime:
        problems.append(label + " snapshot identity is not the expected shape")
    if set(paths) != set(REPAIR_PATHS.values()):
        problems.append(label + " snapshot does not name the six owned paths")
    expected = _repair_expected(runtime)
    for key in ("service", "timer", "path", "dropin"):
        _inventory_file(paths.get(REPAIR_PATHS[key]), expected[key],
                        label + " snapshot " + key, problems)
    _inventory_link(paths.get(REPAIR_PATHS["timer_wants"]),
                    "../" + REPAIR_TIMER,
                    label + " snapshot timer wants", problems)
    _inventory_link(paths.get(REPAIR_PATHS["path_wants"]),
                    "../" + REPAIR_PATH,
                    label + " snapshot path wants", problems)
    if activators != {
            "timer_active": "active",
            "timer_unit_file_state": "enabled",
            "service_active": "inactive",
            "path_active": "inactive",
            "path_unit_file_state": "enabled"}:
        problems.append(label + " snapshot activator observation is not the "
                        "expected pre-switch shape")


def _verify_activators_raw(report, raw_root, problems, phases):
    prepared = (phases.get("prepare") or {}).get("prepared") or {}
    raw_repair = UNIT_DIR.replace("/home/%s/" % vm.GUEST_USER, "")
    expected = _repair_expected(PYTHON_RUNTIME)
    for name, text in (
            ("crq-repair.service", expected["service"]),
            ("crq-repair.timer", expected["timer"]),
            ("crq-repair.path", expected["path"]),
            ("crq-repair.service.d/10-fence-proof.conf", expected["dropin"])):
        _raw_file_problem(raw_root / raw_repair / name, text,
                          "final " + name, problems)
    _raw_link_problem(raw_root / raw_repair / "timers.target.wants"
                      / REPAIR_TIMER, "../" + REPAIR_TIMER,
                      "final timer wants", problems)
    _raw_link_problem(raw_root / raw_repair / "default.target.wants"
                      / REPAIR_PATH, "../" + REPAIR_PATH,
                      "final path wants", problems)
    for relative in (".crq-repair.service.staged",):
        path = raw_root / raw_repair / relative
        if path.exists() or path.is_symlink():
            problems.append("final evidence retains the staged repair target")
    for missing in (raw_root / FIXTURE_DIR.replace("/home/%s/" % vm.GUEST_USER, "")
                    / "repair-path-trigger",
                    raw_root / FIXTURE_DIR.replace("/home/%s/" % vm.GUEST_USER, "")
                    / "activators-pause.json"):
        if missing.exists() or missing.is_symlink():
            problems.append("final evidence retains " + missing.name)
    _raw_file_problem(raw_root / raw_repair / "crq-tick.service",
                      expected_unit(PYTHON_RUNTIME), "final tick service",
                      problems)
    tick_staged = raw_root / raw_repair / ".crq-tick.service.staged"
    if tick_staged.exists() or tick_staged.is_symlink():
        problems.append("final evidence retains the staged tick target")

    raw_records = raw_root / REPAIR_RECORDS_DIR.replace(
        "/home/%s/" % vm.GUEST_USER, "")
    record_paths = (sorted(entry for entry in raw_records.iterdir()
                           if entry.is_file() and not entry.is_symlink())
                    if raw_records.is_dir() else [])
    if len(record_paths) != 3:
        problems.append("final activator record set is not three records")
    records = []
    for path in record_paths:
        try:
            records.append(json.loads(path.read_text()))
        except (OSError, ValueError):
            problems.append("final activator record is unreadable: " + path.name)
    completed = [record for record in records
                 if record.get("outcome") == "completed"]
    rolled = [record for record in records
              if record.get("outcome") == "rolled_back"]
    node_records = [record for record in completed
                    if record.get("runtime") == NODE_RUNTIME]
    python_records = [record for record in completed
                      if record.get("runtime") == PYTHON_RUNTIME]
    if len(node_records) != 1 or len(python_records) != 1 or len(rolled) != 1:
        problems.append("final activator record outcomes are not the expected "
                        "completed Node, completed Python and rolled-back set")
    for label, record in (("fence record", node_records[0] if node_records else {}),
                          ("switch-back record", python_records[0] if python_records else {}),
                          ("recover record", rolled[0] if rolled else {})):
        if not record:
            continue
        _record_snapshot_problems(record, PYTHON_RUNTIME
                                  if label != "switch-back record"
                                  else NODE_RUNTIME, label, problems)
    for label, record in (("fence record", node_records[0] if node_records else {}),
                          ("switch-back record", python_records[0] if python_records else {})):
        if not record:
            continue
        completions = record.get("completions") or []
        if len(completions) != 2:
            problems.append(label + " does not retain two completions")
            continue
        runtime = record.get("runtime")
        for index, item in enumerate(completions):
            _completion_ok(item, runtime, label + " completion[" + str(index) + "]",
                           problems)
        if completions[0].get("sequence", 0) >= completions[1].get("sequence", 0):
            problems.append(label + " completion sequences do not advance")
        if completions[0].get("invocation") == completions[1].get("invocation"):
            problems.append(label + " completions share an invocation")

    for label, summary in (
            ("activators-fence.record",
             (phases.get("activators-fence") or {}).get("record")),
            ("activators-switch-back.record",
             (phases.get("activators-switch-back") or {}).get("record")),
            ("activators-recover.record_after",
             (phases.get("activators-recover") or {}).get("record_after")),
            ("activators-repeat.record_after",
             (phases.get("activators-repeat") or {}).get("record_after"))):
        _retained_record_problem(summary, raw_root, "records-activators",
                                 label, problems)
    inspect = phases.get("activators-inspect") or {}
    tick = inspect.get("tick") or {}
    for index, summary in enumerate(tick.get("records") or []):
        _retained_record_problem(summary, raw_root, "records",
                                 "activators-inspect.tick.records[%d]" % index,
                                 problems)
    for name, expected_sha in ((prepared.get("state") or {}).items()):
        path = raw_root / "checkout/apps/crq-python/state" / name
        if expected_sha and vm.sha256_file(path) != expected_sha:
            problems.append("raw preserved state does not match: " + name)
    problems.extend(_upload_provenance_problems(report, raw_root, phases))
    return problems


def verify_raw_evidence(report, raw_root, mode="base"):
    """Compare a report with the retained raw phases, uploads and journals."""
    problems = []
    phases = report.get("phases")
    if not isinstance(phases, dict):
        return ["report phases are not an object"]
    expected_phases = phase_names(mode)
    if set(phases) != set(expected_phases):
        problems.append("report phases do not match the proof phase set")
    raw_phases = raw_root / "fixture" / "phases"
    for name in expected_phases:
        raw_path = raw_phases / (name + ".json")
        if raw_path.is_symlink() or not raw_path.is_file():
            problems.append("raw phase is missing: " + name)
            continue
        try:
            retained = json.loads(raw_path.read_text())
        except (OSError, ValueError):
            problems.append("raw phase is unreadable: " + name)
            continue
        if retained != phases.get(name):
            problems.append("phase " + name
                            + " does not match retained raw guest evidence")
    if mode == "activators":
        return _verify_activators_raw(report, raw_root, problems, phases)

    # Only final journal states can be compared with the retained record set.
    # Earlier phase summaries are historical; their raw phase JSON is the
    # authoritative snapshot and is compared above.
    final_keys = {
        "switch-node": ("records", ("record",)),
        "switch-python": ("records", ("record",)),
        "recover": ("records", ("record",)),
        "recover-repeat": ("records", ("record_before", "record_after")),
        "rollback-fence": ("records", ("record_completed",
                                        "record_after_repeat")),
        "fence": ("records", ("record", "record_after_refusal")),
    }
    reset_expectations = {}
    if mode == "matrix":
        final_keys["matrix-switch-node"] = ("records", ("record",))
        for case in MATRIX_ORDER:
            directory = MATRIX_CASES[case]["record_dir"]
            if MATRIX_CASES[case]["boundary"] == "activation_pending":
                final_keys[case] = (directory, ("record",))
            else:
                final_keys[case] = (directory, ())
            final_keys[case + "-observe"] = (directory, ())
        for reset, after in (
                ("matrix-reset-python", "matrix-restart-ambiguity"),
                ("matrix-reset-python-final", "matrix-reboot-ambiguity")):
            reset_expectations[reset] = "/home/%s/%s" % (
                vm.GUEST_USER, MATRIX_CASES[after]["record_dir"])
            final_keys[reset] = (MATRIX_CASES[after]["record_dir"],
                                 ("record_before", "record_after"))
    for name, (directory, keys) in final_keys.items():
        phase = phases.get(name) or {}
        if name in reset_expectations:
            if phase.get("record_dir") != reset_expectations[name]:
                problems.append(name + " record directory does not match "
                                "the expected ambiguity case")
        for key in keys:
            if key in phase:
                _retained_record_problem(phase[key], raw_root, directory,
                                         name + "." + key, problems)
        if mode == "matrix" and name.endswith("-observe"):
            case = name[:-len("-observe")]
            if MATRIX_CASES[case]["boundary"] in ("drained", "restore_staged"):
                nested_keys = (("recovery", "record"),
                               ("repeat", "record_after"))
            else:
                nested_keys = (("recovery", "record_before"),
                               ("recovery", "record_after"),
                               ("repeat", "record_after"))
            for nested, key in nested_keys:
                evidence = phase.get(nested) or {}
                if key in evidence:
                    _retained_record_problem(
                        evidence[key], raw_root, directory,
                        name + "." + nested + "." + key, problems)

    inspect = phases.get("inspect") or {}
    snapshot = inspect.get("snapshot") or {}
    for index, summary in enumerate(snapshot.get("records") or []):
        _retained_record_problem(summary, raw_root, "records",
                                 "inspect.snapshot.records[%d]" % index, problems)
    if isinstance(snapshot.get("history"), dict):
        _retained_record_problem(snapshot["history"], raw_root, "records",
                                 "inspect.snapshot.history", problems)
    harvest = phases.get("drain-harvest") or {}
    for label in ("node", "python"):
        summary = (harvest.get(label) or {}).get("record")
        _retained_record_problem(summary, raw_root, "records",
                                 "drain-harvest." + label, problems)

    expected_rc = {
        "drain-alive": lambda rc: rc == 2,
        "drain-ambiguous": lambda rc: rc == 2,
        "recover-drain-alive": lambda rc: rc == 2,
        "switch-node": lambda rc: rc == 0,
        "switch-python": lambda rc: rc == 0,
        "interrupt": lambda rc: rc not in (0, None),
        "recover-kill": lambda rc: rc not in (0, None),
        "recover": lambda rc: rc == 0,
        "recover-repeat": lambda rc: rc == 2,
        "rollback-fence": lambda rc: rc not in (0, None),
        "fence": lambda rc: rc not in (0, None),
    }
    if mode == "matrix":
        expected_rc["matrix-switch-node"] = lambda rc: rc == 0
        for case in MATRIX_ORDER:
            expected_rc[case] = lambda rc: rc not in (0, None)
    for name, predicate in expected_rc.items():
        cli = _phase_cli(phases.get(name) or {}, name, problems)
        if cli is not None and not predicate(cli.get("rc")):
            problems.append(name + " CLI result contradicts the proof outcome")
    harvest = phases.get("drain-harvest") or {}
    for label in ("node", "python"):
        nested = (harvest.get(label) or {}).get("cli") or {}
        if nested.get("rc") != 0:
            problems.append("drain-harvest." + label
                            + " CLI result contradicts the proof outcome")
    if mode == "matrix":
        for case in MATRIX_ORDER:
            boundary = phases.get(case) or {}
            observe = phases.get(case + "-observe") or {}
            if MATRIX_CASES[case]["boundary"] == "restore_staged":
                killed = boundary.get("recovery_kill") or {}
                if killed.get("rc") in (0, None):
                    problems.append(case + " restore kill result is not retained")
            if MATRIX_CASES[case]["boundary"] in ("drained", "restore_staged"):
                if ((observe.get("recovery") or {}).get("cli") or {}).get("rc") != 0:
                    problems.append(case + " recovery result is not retained")
                if ((observe.get("repeat") or {}).get("cli") or {}).get("rc") != 2:
                    problems.append(case + " repeat recovery is not retained")
            else:
                for label in ("recovery", "repeat"):
                    if ((observe.get(label) or {}).get("cli") or {}).get("rc") != 3:
                        problems.append(case + " " + label
                                        + " refusal is not retained")
    fence = phases.get("fence") or {}
    recovery_cli = fence.get("recovery")
    if not isinstance(recovery_cli, dict) or recovery_cli.get("rc") != 3:
        problems.append("fence recovery refusal is not retained")
    rollback = phases.get("rollback-fence") or {}
    for key, predicate in (("recovery", lambda rc: rc == 0),
                           ("repeat", lambda rc: rc == 2)):
        cli = _phase_cli({"cli": rollback.get(key)},
                         "rollback-fence." + key, problems)
        if cli is not None and not predicate(cli.get("rc")):
            problems.append("rollback-fence." + key
                            + " CLI result contradicts the proof outcome")

    fence_service = raw_root / ".config/systemd/user/crq-tick.service"
    if not fence_service.is_symlink() or os.readlink(fence_service) != "/dev/null":
        problems.append("raw evidence does not retain the durable service mask")
    staged = raw_root / ".config/systemd/user/.crq-tick.service.staged"
    if staged.is_symlink() or not staged.is_file():
        problems.append("raw evidence does not retain the staged target")
    elif vm.sha256_file(staged) != _sha(expected_unit(NODE_RUNTIME)):
        problems.append("staged target bytes do not match the requested runtime")

    problems.extend(_upload_provenance_problems(report, raw_root, phases))
    return problems


def _sha256_text(value):
    return isinstance(value, str) and HEX64.fullmatch(value) is not None


def _commit_text(value):
    return isinstance(value, str) and HEX40.fullmatch(value) is not None


def _artifact_path(run_dir, name):
    if not isinstance(name, str) or not name:
        return None
    if pathlib.PurePosixPath(name).name != name:
        return None
    path = pathlib.Path(run_dir) / name
    if path.is_symlink() or not path.is_file():
        return None
    return path


def validate_provenance(report, run_dir):
    """Require complete, nonempty and source-bound report provenance."""
    problems = []
    raw_path = None
    declared = report.get("path")
    if not isinstance(declared, str) or not declared:
        problems.append("report path is missing")
    else:
        try:
            if pathlib.Path(declared).resolve() != pathlib.Path(run_dir).resolve():
                problems.append("report path does not name the report directory")
        except OSError:
            problems.append("report path is invalid")

    provenance = report.get("provenance")
    if not isinstance(provenance, dict):
        problems.append("report provenance is not an object")
        provenance = {}
    commit = report.get("source_commit")
    described_commit = provenance.get("source_commit")
    if not _commit_text(commit):
        problems.append("report source commit is invalid")
    if not _commit_text(described_commit):
        problems.append("provenance source commit is invalid")
    elif _commit_text(commit) and described_commit != commit:
        problems.append("provenance source commit does not match the report")

    guest_artifact = None
    for name in ("host_script", "guest_script"):
        entry = provenance.get(name)
        if not isinstance(entry, dict):
            problems.append(name + " provenance is missing")
            continue
        if set(entry) != {"artifact", "sha256"}:
            problems.append(name + " provenance has the wrong fields")
            continue
        artifact = entry["artifact"]
        digest = entry["sha256"]
        if not _sha256_text(digest):
            problems.append(name + " digest is invalid")
        path = _artifact_path(run_dir, artifact)
        if path is None:
            problems.append(name + " artifact is missing")
        elif _sha256_text(digest) and vm.sha256_file(path) != digest:
            problems.append(name + " artifact digest does not match")
        if name == "guest_script":
            guest_artifact = artifact
    if provenance.get("guest_report") != guest_artifact:
        problems.append("guest report provenance does not match the guest script")

    host_modules = provenance.get("host_modules")
    if not isinstance(host_modules, dict):
        problems.append("host module provenance is not an object")
    else:
        if set(host_modules) != set(HOST_MODULES):
            problems.append("host module provenance set does not match the "
                            "executed host modules")
        for name in HOST_MODULES:
            entry = host_modules.get(name)
            if not isinstance(entry, dict):
                problems.append("host module provenance is missing: " + name)
                continue
            if set(entry) != {"artifact", "sha256"}:
                problems.append("host module provenance fields are wrong: " + name)
                continue
            artifact = entry["artifact"]
            digest = entry["sha256"]
            if not _sha256_text(digest):
                problems.append("host module digest is invalid: " + name)
            path = _artifact_path(run_dir, artifact)
            if path is None:
                problems.append("host module artifact is missing: " + name)
            elif _sha256_text(digest) and vm.sha256_file(path) != digest:
                problems.append("host module artifact digest does not match: " + name)
        if host_modules.get("vm-unit-switch.py") != provenance.get("host_script"):
            problems.append("host script provenance does not match host_modules")

    uploads = provenance.get("uploads")
    if not isinstance(uploads, dict):
        problems.append("upload provenance is not an object")
    else:
        if set(uploads) != set(UPLOADS) | {"runner_source"}:
            problems.append("upload provenance set does not match the expected "
                            "controller and fixture scripts")
        for name in UPLOADS:
            entry = uploads.get(name)
            if not isinstance(entry, dict):
                problems.append("upload provenance is missing: " + name)
                continue
            if set(entry) != {"sha256", "remote_sha256", "bytes", "verified"}:
                problems.append("upload provenance fields are wrong: " + name)
                continue
            local, remote = entry["sha256"], entry["remote_sha256"]
            if not _sha256_text(local) or not _sha256_text(remote):
                problems.append("upload digest is invalid: " + name)
            elif local != remote:
                problems.append("upload local and remote digests differ: " + name)
            if type(entry["bytes"]) is not int or entry["bytes"] < 0:
                problems.append("upload size is invalid: " + name)
            if entry["verified"] is not True:
                problems.append("upload is not verified: " + name)
        runner = uploads.get("runner_source")
        if not isinstance(runner, dict):
            problems.append("runner source provenance is missing")
        elif (set(runner) != {"name", "sha256", "remote_sha256", "bytes",
                              "verified", "source"}):
            problems.append("runner source provenance fields are wrong")
        else:
            if runner.get("name") != RUNNER_ARCHIVE:
                problems.append("runner source provenance names the wrong file")
            if not _sha256_text(runner.get("sha256")) \
                    or not _sha256_text(runner.get("remote_sha256")):
                problems.append("runner source digest is invalid")
            elif runner["sha256"] != runner["remote_sha256"]:
                problems.append("runner source local and remote digests differ")
            if type(runner.get("bytes")) is not int or runner["bytes"] < 1:
                problems.append("runner source size is invalid")
            if runner.get("verified") is not True:
                problems.append("runner source upload is not verified")

    raw = report.get("raw")
    if not isinstance(raw, dict):
        problems.append("report raw evidence is not an object")
    elif set(raw) != {"tar_sha256", "tar_bytes", "raw_tar"}:
        problems.append("report raw evidence has the wrong fields")
    else:
        if not _sha256_text(raw["tar_sha256"]):
            problems.append("raw evidence digest is invalid")
        if type(raw["tar_bytes"]) is not int or raw["tar_bytes"] <= 0:
            problems.append("raw evidence size is invalid")
        raw_path = _artifact_path(run_dir, raw["raw_tar"])
        if raw_path is None:
            problems.append("raw guest evidence is missing")
        else:
            if _sha256_text(raw["tar_sha256"]) \
                    and vm.sha256_file(raw_path) != raw["tar_sha256"]:
                problems.append("raw guest evidence digest does not match")
            if type(raw["tar_bytes"]) is int \
                    and raw_path.stat().st_size != raw["tar_bytes"]:
                problems.append("raw guest evidence size does not match")
    return problems, raw_path


def cmd_verify(args):
    report = json.loads(pathlib.Path(args.report).read_text())
    if not isinstance(report, dict):
        print(json.dumps({"report": str(args.report),
                          "problems": ["report is not an object"]},
                         indent=2, sort_keys=True))
        return 1
    problems = []
    if report.get("schema_version") != SCHEMA_VERSION or report.get("kind") != KIND:
        problems.append("report schema or kind is not this proof")
    mode = report.get("mode", "base")
    if mode not in ("base", "matrix", "activators"):
        problems.append("report mode is not this proof mode")
        mode = "base"
    phases = report.get("phases")
    if not isinstance(phases, dict):
        problems.append("report phases are not an object")
        phases = {}
    checks, recomputed = build_checks(phases, report.get("restarts"),
                                      report.get("reboots"), mode)
    if checks != report.get("checks"):
        problems.append("stored checks do not match recomputed checks")
    if recomputed != report.get("problems"):
        problems.append("stored problems do not match recomputed problems")
    for problem in recomputed:
        if problem not in problems:
            problems.append(problem)
    if not isinstance(report.get("run"), str) or not report["run"]:
        problems.append("report has no run binding")
    if not isinstance(report.get("source_commit"), str) \
            or not re.fullmatch(r"[0-9a-f]{40}", report["source_commit"]):
        problems.append("report has no source commit binding")
    run_dir = pathlib.Path(args.report).resolve().parent
    provenance_problems, raw_path = validate_provenance(report, run_dir)
    problems.extend(provenance_problems)
    if raw_path is not None:
        try:
            with tempfile.TemporaryDirectory(prefix="crq-proof-verify-") as scratch:
                raw_root = pathlib.Path(scratch) / "raw"
                extract_raw_archive(raw_path, raw_root)
                problems.extend(verify_raw_evidence(report, raw_root, mode))
        except (OSError, tarfile.TarError, RuntimeError) as exc:
            problems.append("raw guest evidence is unreadable: " + str(exc)[:200])
    current_host = sha256_bytes(pathlib.Path(__file__).resolve().read_bytes())
    current_guest = sha256_bytes(
        (OPS / "vm-unit-switch-guest.py").read_bytes())
    provenance = report.get("provenance") or {}
    retained_host = (provenance.get("host_script") or {}).get("sha256")
    retained_guest = (provenance.get("guest_script") or {}).get("sha256")
    host_matches = isinstance(retained_host, str) and current_host == retained_host
    guest_matches = (isinstance(retained_guest, str)
                     and current_guest == retained_guest)
    if mode in ("matrix", "activators") and not guest_matches:
        problems.append("guest proof script differs from the retained "
                        + mode + " run; a fresh " + mode + " run is required")
    validator = {
        "host_script_sha256": current_host,
        "guest_script_sha256": current_guest,
        "retained_host_script_sha256": retained_host,
        "retained_guest_script_sha256": retained_guest,
        "host_matches_run": host_matches,
        "guest_matches_run": guest_matches,
        "validator_only": guest_matches and not host_matches,
        "run": report.get("run"),
        "run_source_commit": report.get("source_commit"),
        "report_sha256": sha256_bytes(pathlib.Path(args.report).read_bytes()),
        "raw_tar_sha256": (report.get("raw") or {}).get("tar_sha256"),
    }
    print(json.dumps({"report": str(args.report), "problems": problems,
                      "validator": validator},
                     indent=2, sort_keys=True))
    return 0 if not problems else 1


def cmd_destroy(args):
    run = vm.load_run(pathlib.Path(args.state_dir).expanduser().resolve(),
                      args.run_id)
    result = vm.stop_owned_process(run, purge=args.purge)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["stopped"] else 1


def build_parser():
    parser = argparse.ArgumentParser(
        description="Isolated unit-switch proof harness (not production)")
    parser.add_argument("--state-dir", default=str(
        pathlib.Path.home() / "crq-vm-feasibility"))
    parser.add_argument("--tools", type=pathlib.Path)
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--source-commit", required=True)
    run.add_argument("--mode", choices=("base", "matrix", "activators"),
                     default="base")
    run.add_argument("--keep", action="store_true")
    verify = sub.add_parser("verify")
    verify.add_argument("report", type=pathlib.Path)
    destroy = sub.add_parser("destroy")
    destroy.add_argument("--run-id")
    destroy.add_argument("--purge", action="store_true")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "run":
        return cmd_run(args)
    if args.command == "verify":
        return cmd_verify(args)
    return cmd_destroy(args)


if __name__ == "__main__":
    sys.exit(main())
