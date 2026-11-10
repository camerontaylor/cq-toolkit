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
HOST_MODULES = (
    "vm-unit-switch.py",
    "vm-feasibility.py",
)
GUEST_PHASES = ("prepare", "switch-node", "switch-python", "interrupt",
                "recover-kill", "recover", "recover-repeat", "inspect", "fence")
NODE_RUNTIME = "node:" + "b" * 40
PYTHON_RUNTIME = "python"
HEX40 = re.compile(r"[0-9a-f]{40}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
LIMITATIONS = [
    "One representative harmless fixture is installed under the allowlisted "
    "unit name crq-tick.service; no production template is rendered.",
    "Python and Node fixtures are fake unit-scoped completion sources. No real "
    "CRQ runtime completion exists and no CQ enablement is implied.",
    "The guest user manager is not restarted and the guest is not rebooted; "
    "that matrix remains later bounded work.",
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
    return provenance


def guest_phase(run, phase, recorder, extra=None):
    command = ("python3 /home/%s/proof-bin/vm-unit-switch-guest.py %s"
               % (vm.GUEST_USER, phase))
    if extra:
        command += " " + " ".join(extra)
    result = vm.guest_ssh(run, command, recorder, timeout=300, max_output=None)
    run_dir = pathlib.Path(run["path"])
    (run_dir / "phases").mkdir(exist_ok=True)
    (run_dir / "phases" / (phase + ".stdout")).write_text(
        (result.get("stdout") or "") + (result.get("stderr") or ""))
    if result["rc"] != 0:
        raise RuntimeError("guest phase %s failed: %s" % (
            phase, (result.get("stdout") or result.get("stderr") or "")[-1200:]))
    try:
        payload = json.loads(result["stdout"])
    except ValueError as exc:
        raise RuntimeError("guest phase %s emitted invalid JSON" % phase) from exc
    (run_dir / "phases" / (phase + ".json")).write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return payload


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


def build_checks(phases):
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

    for key, value in checks.items():
        if value is not True:
            problems.append(key + " is not satisfied")
    return checks, problems


def build_report(run, boot, phases, stamps, image, provenance, raw):
    checks, problems = build_checks(phases)
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": KIND,
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
        "checks": checks,
        "problems": problems,
        "limitations": LIMITATIONS,
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
        provenance = {
            "source_commit": commit,
            "host_script": {"artifact": host_artifact.name,
                            "sha256": vm.sha256_file(host_artifact)},
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
        for phase in GUEST_PHASES:
            extra = []
            if phase in ("recover-kill", "recover", "recover-repeat"):
                extra = ["--record", phases["interrupt"]["record_path"]]
            phases[phase] = guest_phase(run, phase, recorder, extra)
        raw = fetch_raw(run, recorder)
        stamps["finish"] = vm.host_stamp()
        report = build_report(run, boot, phases, stamps, image, provenance, raw)
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


def _retained_record_problem(summary, raw_records, label, problems):
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


def verify_raw_evidence(report, raw_root):
    """Compare a report with the retained raw phases, uploads and journals."""
    problems = []
    phases = report.get("phases")
    if not isinstance(phases, dict):
        return ["report phases are not an object"]
    if set(phases) != set(GUEST_PHASES):
        problems.append("report phases do not match the proof phase set")
    raw_phases = raw_root / "fixture" / "phases"
    for name in GUEST_PHASES:
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

    raw_records = raw_root / "records"
    # Only final journal states can be compared with the retained record set.
    # Earlier phase summaries are historical; their raw phase JSON is the
    # authoritative snapshot and is compared above.
    final_keys = {
        "switch-node": ("record",),
        "switch-python": ("record",),
        "recover": ("record",),
        "recover-repeat": ("record_before", "record_after"),
        "fence": ("record", "record_after_refusal"),
    }
    for name, keys in final_keys.items():
        phase = phases.get(name) or {}
        for key in keys:
            if key in phase:
                _retained_record_problem(phase[key], raw_records,
                                         name + "." + key, problems)

    inspect = phases.get("inspect") or {}
    snapshot = inspect.get("snapshot") or {}
    for index, summary in enumerate(snapshot.get("records") or []):
        _retained_record_problem(summary, raw_records,
                                 "inspect.snapshot.records[%d]" % index, problems)
    if isinstance(snapshot.get("history"), dict):
        _retained_record_problem(snapshot["history"], raw_records,
                                 "inspect.snapshot.history", problems)

    expected_rc = {
        "switch-node": lambda rc: rc == 0,
        "switch-python": lambda rc: rc == 0,
        "interrupt": lambda rc: rc not in (0, None),
        "recover-kill": lambda rc: rc not in (0, None),
        "recover": lambda rc: rc == 0,
        "recover-repeat": lambda rc: rc == 2,
        "fence": lambda rc: rc not in (0, None),
    }
    for name, predicate in expected_rc.items():
        cli = _phase_cli(phases.get(name) or {}, name, problems)
        if cli is not None and not predicate(cli.get("rc")):
            problems.append(name + " CLI result contradicts the proof outcome")
    fence = phases.get("fence") or {}
    recovery_cli = fence.get("recovery")
    if not isinstance(recovery_cli, dict) or recovery_cli.get("rc") != 3:
        problems.append("fence recovery refusal is not retained")

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
        if retained != set(UPLOADS):
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
            elif vm.sha256_file(raw_path) != entry["sha256"]:
                problems.append("raw upload digest does not match: " + name)
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

    uploads = provenance.get("uploads")
    if not isinstance(uploads, dict):
        problems.append("upload provenance is not an object")
    else:
        if set(uploads) != set(UPLOADS):
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
            if type(entry["bytes"]) is not int or entry["bytes"] <= 0:
                problems.append("upload size is invalid: " + name)
            if entry["verified"] is not True:
                problems.append("upload is not verified: " + name)

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
    phases = report.get("phases")
    if not isinstance(phases, dict):
        problems.append("report phases are not an object")
        phases = {}
    checks, recomputed = build_checks(phases)
    if checks != report.get("checks"):
        problems.append("stored checks do not match recomputed checks")
    if recomputed != report.get("problems"):
        problems.append("stored problems do not match recomputed problems")
    for problem in recomputed:
        if problem not in problems:
            problems.append(problem)
    run_dir = pathlib.Path(args.report).resolve().parent
    provenance_problems, raw_path = validate_provenance(report, run_dir)
    problems.extend(provenance_problems)
    if raw_path is not None:
        try:
            with tempfile.TemporaryDirectory(prefix="crq-proof-verify-") as scratch:
                raw_root = pathlib.Path(scratch) / "raw"
                extract_raw_archive(raw_path, raw_root)
                problems.extend(verify_raw_evidence(report, raw_root))
        except (OSError, tarfile.TarError, RuntimeError) as exc:
            problems.append("raw guest evidence is unreadable: " + str(exc)[:200])
    print(json.dumps({"report": str(args.report), "problems": problems},
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
