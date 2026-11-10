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


def phase_names(mode="base"):
    return MATRIX_GUEST_PHASES if mode == "matrix" else GUEST_PHASES


HEX40 = re.compile(r"[0-9a-f]{40}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
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


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vm = _load("crq_vm_feasibility", OPS / "vm-feasibility.py")
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


def fetch_raw(run, recorder):
    run_dir = pathlib.Path(run["path"])
    remote = ("cd /home/%s && tar -czf - fixture records proof-bin "
              "checkout/apps/crq-python/state "
              ".config/systemd/user/crq-tick.service "
              ".config/systemd/user/.crq-tick.service.staged "
              ".config/systemd/user/crq-tick.timer "
              ".config/systemd/user/timers.target.wants/crq-tick.timer "
              "| base64 -w0" % vm.GUEST_USER)
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


def _drain_refusal_ok(phase, kind):
    cli = phase.get("cli") or {}
    queue = phase.get("queue") or {}
    before = phase.get("before") or {}
    after = phase.get("after") or {}
    liveness = phase.get("liveness") or [{}]
    processes = phase.get("processes") or {}
    owned = processes.get("owned")
    unrelated = (processes.get("unrelated") or {}).get("after") or {}
    observation = phase.get("observation") or {}
    drain = phase.get("drain") or {}
    return (
        cli.get("rc") == 2
        and "queue-owned work" in (phase.get("refused") or "")
        and observation.get("drained") is False
        and drain.get("blocked") == observation.get("blocked")
        and any(entry.get("state") == kind
                and entry.get("run") == (phase.get("seeded") or {}).get("run_id")
                for entry in observation.get("blocked") or [])
        and liveness[0].get("state") == kind
        and queue.get("before_sha256") == queue.get("after_sha256")
        and isinstance(queue.get("restored_sha256"), str)
        and (phase.get("records_before") or [])
        == (phase.get("records_after") or [])
        and phase.get("completions_before") == phase.get("completions_after")
        and (before.get("metadata") == after.get("metadata"))
        and (before.get("units") == after.get("units"))
        and (before.get("jobs") == after.get("jobs"))
        and (owned is None or owned.get("alive") is True)
        and unrelated.get("alive") is True
        and _cleanup_never_signalled(phase)
        and phase.get("baseline_restored") is True
    )


def _completion_pair(value):
    evidence = value or {}
    sequences = evidence.get("sequences") or []
    invocations = evidence.get("invocations") or []
    return (len(sequences) == 2 and sequences[0] < sequences[1]
            and len(set(invocations)) == 2)


def _drain_harvest_ok(phase):
    queue = phase.get("queue") or {}
    processes = phase.get("processes") or {}
    observation = phase.get("observation") or {}
    liveness = phase.get("liveness") or [{}]
    node = phase.get("node") or {}
    python = phase.get("python") or {}
    node_record = node.get("record") or {}
    python_record = python.get("record") or {}
    preserved = phase.get("preserved") or {}
    seeded = preserved.get("state") or {}
    return (
        observation == {"drained": True, "blocked": []}
        and liveness[0].get("state") == "harvest"
        and queue.get("seeded_sha256") == queue.get("after_node_sha256")
        and queue.get("seeded_sha256") == queue.get("after_python_sha256")
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
        and (processes.get("unrelated") or {}).get("after", {}).get(
            "alive") is True
        and (processes.get("completed") or {}).get("alive") is False
        and seeded.get("queue.json") == queue.get("seeded_sha256")
        and _cleanup_never_signalled(phase)
        and phase.get("baseline_restored") is True
    )


def _recovery_drain_refusal_ok(phase, service_path):
    cli = phase.get("cli") or {}
    queue = phase.get("queue") or {}
    before = phase.get("record_before") or {}
    after = phase.get("record_after") or {}
    service = phase.get("service") or {}
    timer = phase.get("timer") or {}
    observation = phase.get("observation") or {}
    drain = phase.get("drain") or {}
    processes = phase.get("processes") or {}
    unrelated = (processes.get("unrelated") or {}).get("after") or {}
    return (
        cli.get("rc") == 2
        and "queue-owned work" in (phase.get("refused") or "")
        and observation.get("drained") is False
        and drain.get("blocked") == observation.get("blocked")
        and (phase.get("liveness") or [{}])[0].get("state") == "alive"
        and before.get("sha256") == after.get("sha256")
        and after.get("outcome") == "pending"
        and after.get("phase") == "drained"
        and queue.get("before_sha256") == queue.get("after_sha256")
        and isinstance(queue.get("restored_sha256"), str)
        and phase.get("completions_before") == phase.get("completions_after")
        and (service.get("before") or {}).get("LoadState") == "masked"
        and (service.get("after") or {}).get("LoadState") == "masked"
        and (service.get("before") or {}).get("FragmentPath") == service_path
        and service.get("before") == service.get("after")
        and timer.get("before") == timer.get("after")
        and (processes.get("owned") or {}).get("alive") is True
        and unrelated.get("alive") is True
        and _cleanup_never_signalled(phase)
        and phase.get("baseline_restored") is True
    )


def build_checks(phases, restarts=None, reboots=None, mode="base"):
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
            recovery_drain, service_path)

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
            before.get("sha256") == after.get("sha256")
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
        "limitations": (MATRIX_LIMITATIONS if mode == "matrix"
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
        raw = fetch_raw(run, recorder)
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

    provenance = report.get("provenance")
    uploads = provenance.get("uploads") if isinstance(provenance, dict) else None
    if not isinstance(uploads, dict):
        problems.append("upload provenance is not an object")
    else:
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
    if mode not in ("base", "matrix"):
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
    if mode == "matrix" and not guest_matches:
        problems.append("guest proof script differs from the retained matrix run; "
                        "a fresh matrix run is required")
    validator = {
        "host_script_sha256": current_host,
        "guest_script_sha256": current_guest,
        "retained_host_script_sha256": retained_host,
        "retained_guest_script_sha256": retained_guest,
        "host_matches_run": host_matches,
        "guest_matches_run": guest_matches,
        "validator_only": mode == "matrix" and guest_matches and not host_matches,
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
    run.add_argument("--mode", choices=("base", "matrix"), default="base")
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
