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
import shutil
import subprocess
import sys
import tarfile
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
GUEST_PHASES = ("prepare", "switch-node", "switch-python", "interrupt",
                "recover-kill", "recover", "recover-repeat", "inspect")
NODE_RUNTIME = "node:" + "b" * 40
PYTHON_RUNTIME = "python"
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
    with tarfile.open(raw_path, "r:gz") as archive:
        if not hasattr(tarfile, "data_filter"):
            raise RuntimeError("tarfile extraction filters unavailable; "
                               "refusing unfiltered extraction")
        archive.extractall(extracted, filter="data")
    return {"tar_sha256": sha256_bytes(data), "tar_bytes": len(data),
            "raw_tar": raw_path.name}


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
    status = subprocess.run(
        ["git", "-C", str(repo), "status", "--porcelain", "--"] +
        [str(OPS / name) for name in UPLOADS],
        capture_output=True, text=True, check=True).stdout.strip()
    if status:
        raise ValueError("uploaded proof scripts have uncommitted changes")
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


def cmd_verify(args):
    report = json.loads(pathlib.Path(args.report).read_text())
    problems = []
    if report.get("schema_version") != SCHEMA_VERSION or report.get("kind") != KIND:
        problems.append("report schema or kind is not this proof")
    checks, recomputed = build_checks(report.get("phases") or {})
    if checks != report.get("checks"):
        problems.append("stored checks do not match recomputed checks")
    if recomputed != report.get("problems"):
        problems.append("stored problems do not match recomputed problems")
    for problem in recomputed:
        if problem not in problems:
            problems.append(problem)
    run_dir = pathlib.Path(report.get("path") or args.report)
    provenance = report.get("provenance") or {}
    for name, expected in (("host_script", report.get("provenance", {}).get(
            "host_script", {}).get("artifact")),
                           ("guest_script", report.get("provenance", {}).get(
                               "guest_script", {}).get("artifact"))):
        entry = provenance.get(name) or {}
        artifact = run_dir / (expected or "")
        if not expected or not artifact.is_file():
            problems.append(name + " artifact is missing")
        elif vm.sha256_file(artifact) != entry.get("sha256"):
            problems.append(name + " artifact digest does not match")
    raw = report.get("raw") or {}
    raw_path = run_dir / (raw.get("raw_tar") or "")
    if not raw.get("raw_tar") or not raw_path.is_file():
        problems.append("raw guest evidence is missing")
    elif vm.sha256_file(raw_path) != raw.get("tar_sha256"):
        problems.append("raw guest evidence digest does not match")
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
