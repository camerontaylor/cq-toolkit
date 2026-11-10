#!/usr/bin/env python3
"""Bounded disposable-VM feasibility probe for the CRQ per-unit switch design.

The probe answers one narrow question on a *disposable guest*: can a real
systemd user manager, its units and a service mask survive the boundaries the
unit-switch design treats as unproven -- a full user-manager restart and an OS
reboot -- and does the guest have the activation sources the design must
account for (direct, dependency, queued, timer, path)?

It deliberately does not implement, import or enable a host adapter, touch a
real CRQ checkout/journal, or claim controller acceptance. The guest is an
isolated cloud image with a dedicated ``probe`` account, harmless fixture units
and no credentials. Everything it downloads, boots and writes stays under an
owned state directory; the base image is read-only and shared, each boot gets a
fresh qcow2 overlay, and ``destroy`` stops only the recorded QEMU process after
checking its start identity.

Host requirements: Linux with a writable ``/dev/kvm``, Python 3.11+, QEMU and
``cloud-localds`` on PATH (or ``--tools DIR``), and at least 2 GiB of available
memory. The QEMU process runs in a transient user scope with ``MemoryMax=3G``
and ``MemorySwapMax=0``. Timing evidence must carry the load stamp that the
report records.

See ``VM-FEASIBILITY.md`` for the recorded evidence and its limits.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import uuid

IMAGE_URL = "https://cloud-images.ubuntu.com/noble/current/"
IMAGE_NAME = "noble-server-cloudimg-amd64.img"
SUMS_NAME = "SHA256SUMS"
DEFAULT_STATE = pathlib.Path.home() / "crq-vm-feasibility"
GUEST_USER = "probe"
GUEST_HOME = pathlib.Path("/home/%s" % GUEST_USER)
UNIT_DIR = GUEST_HOME / ".config/systemd/user"
FIXTURE_DIR = GUEST_HOME / "fixture"
TRIGGER_PATH = str(FIXTURE_DIR / "trigger")
SNAPSHOT_PATHS = (
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
    FIXTURE_DIR / "crq-alias.service.unit",
    FIXTURE_DIR / "original-crq-fixture.service",
    FIXTURE_DIR / "original-crq-alias.service.link",
    FIXTURE_DIR / "record.sh",
)
GUEST_RAM_MB = 2048
GUEST_VCPUS = 2
OVERLAY_SIZE = "8G"
MIN_AVAILABLE_KIB = 2 * 1024 * 1024
SCOPE_MEMORY = "3G"
SSH_KEY = "id_ed25519"
REPORT_SCHEMA = 2
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")

LIMITATIONS = [
    "Checksum verification proves download integrity against the published "
    "SHA256SUMS file; it is not signed authenticity.",
    "A guest OS reboot is not a power-loss or filesystem-corruption test.",
    "This is feasibility evidence for one isolated user manager and fixture "
    "units; it is not controller, journal or adapter acceptance.",
    "Observed queued-job behavior is recorded for one systemd version and "
    "fixture shape, not generalized into a masking guarantee.",
    "No production host, ceres, signer, credential or CRQ checkout is touched.",
]


# ------------------------------------------------------------------ pure


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with pathlib.Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sums_digest(text: str, name: str) -> str:
    """Return the single SHA-256 the sums file publishes for ``name``."""
    matches = []
    for line in text.splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[1].lstrip("*") == name:
            matches.append(fields[0].lower())
    if len(matches) != 1:
        raise ValueError("checksum file must name %s exactly once" % name)
    digest = matches[0]
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError("checksum is not 64 lowercase hex")
    return digest


def verify_image(path: pathlib.Path, expected: str) -> str:
    actual = sha256_file(path)
    if actual != expected:
        raise ValueError("image digest mismatch: expected %s, got %s"
                         % (expected, actual))
    return actual


def render_user_data(public_key: str, *, user: str = GUEST_USER) -> str:
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
package_update: false
package_upgrade: false
runcmd:
  - [loginctl, enable-linger, {user}]
  - [mkdir, -p, /home/{user}/fixture]
  - [chown, {user}:{user}, /home/{user}/fixture]
""".format(user=user, key=key)


def render_meta_data(instance_id: str) -> str:
    if not instance_id or any(c.isspace() for c in instance_id):
        raise ValueError("instance id must be one token")
    return "instance-id: %s\nlocal-hostname: crq-probe\n" % instance_id


def qemu_command(run: pathlib.Path, port: int, *, ram_mb: int = GUEST_RAM_MB,
                 vcpus: int = GUEST_VCPUS) -> list[str]:
    if not 1 <= port <= 65535:
        raise ValueError("invalid forwarded port")
    if ram_mb < 1024:
        raise ValueError("guest RAM must be at least 1024 MiB")
    if not 1 <= vcpus <= 8:
        raise ValueError("guest vCPU count out of range")
    run = pathlib.Path(run).resolve()
    return [
        "qemu-system-x86_64",
        "-name", "crq-vm-" + run.name,
        "-accel", "kvm", "-cpu", "host",
        "-smp", str(vcpus), "-m", str(ram_mb),
        "-drive", "file=%s,if=virtio,format=qcow2" % (run / "overlay.qcow2"),
        "-drive", "file=%s,if=virtio,format=raw,readonly=on" % (run / "seed.iso"),
        "-netdev", "user,id=net0,hostfwd=tcp:127.0.0.1:%d-:22" % port,
        "-device", "virtio-net-pci,netdev=net0",
        "-display", "none",
        "-serial", "file:%s" % (run / "serial.log"),
        "-monitor", "unix:%s,server=on,wait=off" % (run / "monitor.sock"),
        "-pidfile", str(run / "qemu.pid"),
    ]


def bounded_scope_argv(qemu: list[str], unit: str,
                       memory: str = SCOPE_MEMORY) -> list[str]:
    if not unit or any(c.isspace() for c in unit):
        raise ValueError("scope unit must be one token")
    return ["systemd-run", "--user", "--scope", "--unit=" + unit,
            "-p", "MemoryMax=" + memory, "-p", "MemorySwapMax=0", "--", *qemu]


def mem_available_kib(meminfo: str) -> int:
    for line in meminfo.splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1])
    raise ValueError("MemAvailable missing from /proc/meminfo")


def require_memory(meminfo: str, minimum_kib: int = MIN_AVAILABLE_KIB) -> int:
    available = mem_available_kib(meminfo)
    if available < minimum_kib:
        raise ValueError("only %d KiB MemAvailable, need %d KiB"
                         % (available, minimum_kib))
    return available


def ssh_argv(key: pathlib.Path, port: int, known_hosts: pathlib.Path,
             remote: str, *, user: str = GUEST_USER) -> list[str]:
    return [
        "ssh", "-i", str(key), "-p", str(port),
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=5",
        "-o", "ServerAliveCountMax=3",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "UserKnownHostsFile=" + str(known_hosts),
        "%s@127.0.0.1" % user, remote,
    ]


def free_port(start: int = 2222, end: int = 2299) -> int:
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise ValueError("no free forwarded port in range")


def process_starttime(pid: int, proc: pathlib.Path = pathlib.Path("/proc")):
    text = (proc / str(pid) / "stat").read_text()
    return text.rsplit(") ", 1)[1].split()[19]


def process_matches(pid: int, starttime: str, needle: str,
                    proc: pathlib.Path = pathlib.Path("/proc")) -> bool:
    """Prove a PID is the process this run started, without killing anything."""
    if not isinstance(pid, int) or pid <= 1:
        return False
    try:
        if process_starttime(pid, proc) != starttime:
            return False
        command = (proc / str(pid) / "cmdline").read_bytes()
    except OSError:
        return False
    return needle.encode() in command


def compare_files(before: dict, after: dict, ignore=(), content_keys=True):
    """Return per-path differences between two file snapshots."""
    changes = {}
    for path, old in before.items():
        if path in ignore:
            continue
        new = after.get(path)
        if old is None or new is None:
            if old is not new:
                changes[path] = {"before": old, "after": new}
            continue
        keys = ["type", "mode", "uid", "gid", "link_target"]
        if content_keys:
            keys.append("sha256")
        difference = {key: [old.get(key), new.get(key)]
                      for key in keys if old.get(key) != new.get(key)}
        if difference:
            changes[path] = difference
    for path in set(after) - set(before):
        if path in ignore:
            continue
        changes.setdefault(path, {"before": None, "after": after[path]})
    return changes


def recompute_checks(report: dict) -> tuple[dict | None, str | None]:
    """Derive checks from raw observations, never from the stored booleans."""
    phases = report.get("phases")
    manager = report.get("manager_restart")
    reboot = report.get("reboot")
    if not all(isinstance(value, dict) for value in (phases, manager, reboot)):
        return None, "raw observations are missing; checks cannot be recomputed"
    try:
        return build_checks(phases, manager, reboot), None
    except (AttributeError, KeyError, TypeError, ValueError) as exc:
        return None, "raw observations are malformed: %s" % exc


def provenance_problems(report: dict) -> list[str]:
    problems = []
    provenance = report.get("provenance")
    if not isinstance(provenance, dict):
        return ["provenance missing"]
    source_commit = provenance.get("source_commit")
    if not isinstance(source_commit, str) or not COMMIT_RE.fullmatch(source_commit):
        problems.append("source_commit must be a full lowercase git commit")
    for key in ("host_script", "guest_script"):
        item = provenance.get(key)
        if not isinstance(item, dict):
            problems.append("provenance %s missing" % key)
            continue
        digest = item.get("sha256")
        if not isinstance(digest, str) or not DIGEST_RE.fullmatch(digest):
            problems.append("provenance %s sha256 missing" % key)
        artifact = item.get("artifact")
        if (not isinstance(artifact, str) or not artifact
                or pathlib.PurePath(artifact).name != artifact):
            problems.append("provenance %s artifact must be a local filename" % key)
        if key == "guest_script":
            if item.get("remote_sha256") != digest:
                problems.append("guest script upload digest does not match")
            if item.get("verified") is not True:
                problems.append("guest script upload not verified")
    return problems


def verify_report(report: dict, base_dir: pathlib.Path) -> list[str]:
    """Verify a saved report against its raw evidence and retained bytes."""
    problems = report_problems(report, require_evidence=True)
    provenance = report.get("provenance")
    if not isinstance(provenance, dict):
        return problems
    for key in ("host_script", "guest_script"):
        item = provenance.get(key)
        if not isinstance(item, dict):
            continue
        artifact = item.get("artifact")
        if (not isinstance(artifact, str) or not artifact
                or pathlib.PurePath(artifact).name != artifact):
            continue
        path = pathlib.Path(base_dir) / artifact
        try:
            digest = sha256_file(path)
        except OSError:
            problems.append("provenance %s artifact missing: %s" % (key, artifact))
            continue
        if digest != item.get("sha256"):
            problems.append("provenance %s artifact digest does not match" % key)
    return problems


def report_problems(report: dict, *, require_evidence: bool = False) -> list[str]:
    """Validate the evidence shape and the claims it is allowed to make."""
    problems = []
    if report.get("schema_version") != REPORT_SCHEMA:
        problems.append("schema_version must be %d" % REPORT_SCHEMA)
    image = report.get("image") or {}
    if not isinstance(image.get("sha256"), str) or len(image["sha256"]) != 64:
        problems.append("image sha256 missing")
    if image.get("sums_verified") is not True:
        problems.append("image checksum not verified")
    if image.get("signature_verified") is not False:
        problems.append("checksum must not be claimed as signed authenticity")
    checks = report.get("checks") or {}
    if require_evidence:
        computed, error = recompute_checks(report)
        if error:
            problems.append(error)
        if computed is not None:
            if report.get("checks") != computed:
                problems.append("stored checks do not match recomputed evidence")
            checks = computed
        problems.extend(provenance_problems(report))
    for name in ("boot_id_changed", "manager_restarted", "mask_persisted",
                 "direct_refused", "dependency_refused", "timer_active",
                 "path_active", "unmask_started", "metadata_equal",
                 "mask_metadata_equal", "direct_start_ran",
                 "dependency_start_ran", "mask_load_state",
                 "mask_link_target", "timer_enabled", "path_enabled",
                 "install_timer_enabled", "install_path_enabled",
                 "native_mask_refused", "alias_native_mask_refused",
                 "alias_durable_mask_refused", "qemu_pid_unchanged",
                 "timer_refused_while_masked", "path_refused_while_masked",
                 "run_after_trigger_observed", "no_run_after_trigger",
                 "activator_states_after_reboot", "run_log_observed_after_reboot",
                 "metadata_observed", "queued_observations_present",
                 "queued_setup_proven", "queued_mask_proven", "queued_stop_proven",
                 "queued_jobs_settled_after_mask",
                 "queued_jobs_settled_after_stop",
                 "queued_wrapper_ran_after_mask",
                 "queued_wrapper_ran_after_stop",
                 "run_log_observed_after_manager_restart",
                 "no_new_service_after_manager_restart",
                 "no_new_service_after_reboot"):
        if checks.get(name) is not True:
            problems.append("check not proven: " + name)
    if checks.get("queued_job_executed_after_mask") is None:
        problems.append("queued-job behavior not recorded")
    if checks.get("queued_job_executed_after_stop") is None:
        problems.append("queued-job stop behavior not recorded")
    if not report.get("limitations"):
        problems.append("limitations missing")
    return problems


# --------------------------------------------------------------- recorder


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def text_output(value) -> str:
    """Decode captured command output regardless of text/bytes mode."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


class Recorder:
    def __init__(self, run_dir: pathlib.Path):
        self.run_dir = run_dir
        self.path = run_dir / "commands.jsonl"
        self.entries = 0

    def append(self, entry: dict) -> None:
        with self.path.open("a") as handle:
            handle.write(json.dumps(entry, sort_keys=True) + "\n")
        self.entries += 1

    def run(self, argv: list[str], *, timeout: float | None = None,
            check: bool = False, stdin: bytes | None = None,
            cwd: pathlib.Path | None = None, max_output: int | None = 8000) -> dict:
        started = time.time()
        try:
            result = subprocess.run(argv, input=stdin, cwd=cwd, capture_output=True,
                                    timeout=timeout)
            stdout = text_output(result.stdout)
            stderr = text_output(result.stderr)
            entry = {"at": utc_now(), "argv": argv, "rc": result.returncode,
                     "stdout": stdout if max_output is None else stdout[-max_output:],
                     "stderr": stderr if max_output is None else stderr[-max_output:],
                     "seconds": round(time.time() - started, 3)}
        except subprocess.TimeoutExpired as exc:
            stdout = text_output(exc.stdout)
            stderr = text_output(exc.stderr)
            entry = {"at": utc_now(), "argv": argv, "rc": None, "timeout": True,
                     "stdout": stdout if max_output is None else stdout[-max_output:],
                     "stderr": stderr if max_output is None else stderr[-max_output:],
                     "seconds": round(time.time() - started, 3)}
        self.append(entry)
        if check and entry["rc"] != 0:
            raise RuntimeError("command failed: %s\n%s"
                               % (" ".join(argv), entry["stderr"]))
        return entry


def read_uptime(path: str = "/proc/uptime") -> float | None:
    try:
        return float(pathlib.Path(path).read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def host_stamp() -> dict:
    load = pathlib.Path("/proc/loadavg").read_text().split()
    meminfo = pathlib.Path("/proc/meminfo").read_text()
    return {
        "at": utc_now(),
        "hostname": socket.gethostname(),
        "kernel": os.uname().release,
        "uptime_seconds": read_uptime(),
        "load1": float(load[0]), "load5": float(load[1]), "load15": float(load[2]),
        "mem_available_kib": mem_available_kib(meminfo),
        "kvm_writable": os.access("/dev/kvm", os.W_OK),
    }


# ------------------------------------------------------------------ tools


def tool(name: str, directory: pathlib.Path | None) -> str:
    if directory is not None:
        candidate = pathlib.Path(directory).expanduser().resolve() / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    found = shutil.which(name)
    if not found:
        raise ValueError("required tool not on PATH: " + name)
    return found


# ------------------------------------------------------------- lifecycle


def download(url: str, destination: pathlib.Path, timeout: float = 120) -> str:
    """Download to a sibling ``.part`` and fsync before replacing."""
    part = destination.with_name(destination.name + ".part")
    with urllib.request.urlopen(url, timeout=timeout) as response, \
            part.open("wb") as handle:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            handle.write(chunk)
        handle.flush()
        os.fsync(handle.fileno())
    return str(part)


def fetch_sums(sums_path: pathlib.Path, recorder: Recorder) -> None:
    started = time.time()
    part = download(IMAGE_URL + SUMS_NAME, sums_path)
    recorder.append({"at": utc_now(), "argv": ["download", IMAGE_URL + SUMS_NAME],
                     "rc": 0, "bytes": pathlib.Path(part).stat().st_size,
                     "seconds": round(time.time() - started, 3)})
    pathlib.Path(part).replace(sums_path)


def fetch_image(state: pathlib.Path, recorder: Recorder) -> dict:
    images = state / "images"
    images.mkdir(parents=True, exist_ok=True)
    sums_path = images / SUMS_NAME
    image_path = images / IMAGE_NAME
    if image_path.exists():
        if not sums_path.exists():
            fetch_sums(sums_path, recorder)
        text = sums_path.read_text()
        expected = sums_digest(text, IMAGE_NAME)
        actual = verify_image(image_path, expected)
        return {"name": IMAGE_NAME, "path": str(image_path), "sha256": actual,
                "sums_sha256": sha256_file(sums_path),
                "sums_verified": True, "signature_verified": False,
                "downloaded": False}
    # There is no verified image to pair with a cached manifest. Refreshing it
    # on every retry prevents an interrupted image download from pinning a
    # stale checksum while ``current/`` moves on. The manifest and image are
    # each installed atomically, and the image is still verified before it is
    # promoted, so a failed or incoherent fetch cannot overwrite a base image
    # that existing overlays reference.
    fetch_sums(sums_path, recorder)
    text = sums_path.read_text()
    expected = sums_digest(text, IMAGE_NAME)
    started = time.time()
    part = download(IMAGE_URL + IMAGE_NAME, image_path, timeout=1800)
    actual = verify_image(pathlib.Path(part), expected)
    pathlib.Path(part).replace(image_path)
    recorder.append({"at": utc_now(), "argv": ["download", IMAGE_URL + IMAGE_NAME],
                     "rc": 0, "bytes": image_path.stat().st_size,
                     "seconds": round(time.time() - started, 3)})
    return {"name": IMAGE_NAME, "path": str(image_path), "sha256": actual,
            "sums_sha256": sha256_file(sums_path), "sums_verified": True,
            "signature_verified": False, "downloaded": True}


def prepare_run(state: pathlib.Path, image: dict, recorder: Recorder,
                tools: pathlib.Path | None) -> dict:
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:8]
    run = state / "runs" / run_id
    run.mkdir(parents=True, exist_ok=False)
    key = run / SSH_KEY
    recorder.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C",
                  "crq-vm-probe-" + run_id, "-f", str(key)], check=True)
    public_key = (run / (SSH_KEY + ".pub")).read_text()
    (run / "user-data").write_text(render_user_data(public_key))
    (run / "meta-data").write_text(render_meta_data("crq-probe-" + run_id))
    recorder.run([tool("cloud-localds", tools), str(run / "seed.iso"),
                  str(run / "user-data"), str(run / "meta-data")],
                 check=True, cwd=run)
    recorder.run([tool("qemu-img", tools), "create", "-f", "qcow2",
                  "-b", image["path"], "-F", "qcow2",
                  str(run / "overlay.qcow2"), OVERLAY_SIZE],
                 check=True, cwd=run)
    return {"run_id": run_id, "path": str(run), "image": image,
            "port": free_port(), "started_at": utc_now()}


def boot(run: dict, recorder: Recorder, tools: pathlib.Path | None,
         stamp: dict) -> dict:
    require_memory(pathlib.Path("/proc/meminfo").read_text())
    if not stamp["kvm_writable"]:
        raise ValueError("/dev/kvm is not writable; no KVM acceleration")
    run_dir = pathlib.Path(run["path"])
    unit = "crq-vm-" + run["run_id"]
    scope_unit = unit + ".scope"
    qemu = qemu_command(run_dir, run["port"])
    qemu[0] = tool("qemu-system-x86_64", tools)
    argv = bounded_scope_argv(qemu, unit)
    log = (run_dir / "qemu.log").open("wb")
    process = subprocess.Popen(argv, cwd=run_dir, stdout=log, stderr=subprocess.STDOUT,
                               start_new_session=True)
    recorder.append({"at": utc_now(), "argv": argv, "spawned_pid": process.pid,
                     "scope_unit": scope_unit})
    try:
        deadline = time.time() + 30
        pid_path = run_dir / "qemu.pid"
        while time.time() < deadline and not pid_path.exists():
            if process.poll() is not None:
                raise RuntimeError("QEMU exited before writing its pid file; see qemu.log")
            time.sleep(0.25)
        if not pid_path.exists():
            raise RuntimeError("QEMU did not write a pid file")
        pid = int(pid_path.read_text().strip())
        starttime = process_starttime(pid)
        (run_dir / "process.json").write_text(json.dumps(
            {"pid": pid, "starttime": starttime, "scope_unit": scope_unit},
            indent=2) + "\n")
    except BaseException:
        identity_ok = False
        identity_path = run_dir / "process.json"
        if identity_path.exists():
            try:
                identity = json.loads(identity_path.read_text())
                pid = identity.get("pid")
                identity_ok = (
                    isinstance(pid, int)
                    and identity.get("scope_unit") == scope_unit
                    and process_matches(pid, identity.get("starttime"),
                                        str(run_dir / "overlay.qcow2")))
            except (OSError, ValueError):
                identity_ok = False
        if identity_ok:
            subprocess.run(["systemctl", "--user", "stop", scope_unit],
                           capture_output=True, text=True)
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        raise
    finally:
        log.close()
    return {"pid": pid, "starttime": starttime, "scope_unit": scope_unit,
            "spawned_pid": process.pid, "qemu": argv, "port": run["port"]}


def guest_ssh(run: dict, remote: str, recorder: Recorder,
              timeout: float = 120, stdin: bytes | None = None,
              max_output: int | None = 8000) -> dict:
    run_dir = pathlib.Path(run["path"])
    argv = ssh_argv(run_dir / SSH_KEY, run["port"], run_dir / "known_hosts", remote)
    return recorder.run(argv, timeout=timeout, stdin=stdin, max_output=max_output)


def wait_ssh(run: dict, recorder: Recorder, timeout: float = 240) -> dict:
    deadline = time.time() + timeout
    attempts = 0
    while time.time() < deadline:
        attempts += 1
        result = guest_ssh(run, "true", recorder, timeout=15)
        if result["rc"] == 0:
            done = guest_ssh(run, "cloud-init status --wait", recorder, timeout=240)
            if done["rc"] == 0:
                return {"attempts": attempts, "at": utc_now()}
            status = guest_ssh(run, "cloud-init status", recorder, timeout=15)
            if "status: error" in (status.get("stdout") or ""):
                raise RuntimeError("cloud-init reported an error: "
                                   + (status.get("stdout") or ""))
        time.sleep(2)
    raise RuntimeError("guest SSH/cloud-init did not become ready")


def upload_guest_probe(run: dict, recorder: Recorder,
                       source: bytes | None = None) -> dict:
    if source is None:
        source = pathlib.Path(__file__).with_name("vm-guest-probe.py").read_bytes()
    local_sha256 = sha256_bytes(source)
    remote = ("mkdir -p /home/%s/probe-bin && cat > /home/%s/probe-bin/vm-guest-probe.py "
              "&& chmod 700 /home/%s/probe-bin/vm-guest-probe.py"
              % (GUEST_USER, GUEST_USER, GUEST_USER))
    result = guest_ssh(run, remote, recorder, stdin=source)
    if result["rc"] != 0:
        raise RuntimeError("guest probe upload failed: " + result["stderr"])
    check = guest_ssh(run, "sha256sum /home/%s/probe-bin/vm-guest-probe.py" % GUEST_USER,
                      recorder, timeout=30)
    observed = (check.get("stdout") or "").split()
    remote_sha256 = observed[0] if observed else ""
    if check["rc"] != 0 or remote_sha256 != local_sha256:
        raise RuntimeError("guest probe upload digest mismatch: %s != %s"
                           % (remote_sha256, local_sha256))
    return {"sha256": local_sha256, "remote_sha256": remote_sha256,
            "verified": True}


def guest_phase(run: dict, phase: str, recorder: Recorder) -> dict:
    result = guest_ssh(run, "python3 /home/%s/probe-bin/vm-guest-probe.py %s"
                       % (GUEST_USER, phase), recorder, timeout=180, max_output=None)
    if result["rc"] != 0:
        raise RuntimeError("guest phase %s failed: %s" % (phase, result["stderr"]))
    try:
        payload = json.loads(result["stdout"])
    except ValueError as exc:
        raise RuntimeError("guest phase %s emitted invalid JSON" % phase) from exc
    run_dir = pathlib.Path(run["path"])
    (run_dir / "phases").mkdir(exist_ok=True)
    (run_dir / "phases" / (phase + ".json")).write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return payload


def wait_manager_ready(run: dict, recorder: Recorder, timeout: float = 90) -> dict:
    deadline = time.time() + timeout
    attempts = 0
    while time.time() < deadline:
        attempts += 1
        result = guest_ssh(run, "systemctl --user is-system-running; "
                           "sudo -n systemctl show user@$(id -u).service "
                           "-p MainPID -p InvocationID", recorder, timeout=20)
        if result["rc"] == 0 and result["stdout"].splitlines():
            state = result["stdout"].splitlines()[0].strip()
            if state in ("running", "degraded"):
                return {"attempts": attempts, "state": state,
                        "identity": result["stdout"].strip()}
        time.sleep(1)
    raise RuntimeError("user manager did not become ready")


def restart_manager(run: dict, recorder: Recorder) -> dict:
    before_phase = guest_phase(run, "inspect", recorder)
    before = before_phase.get("snapshot") or {}
    started = utc_now()
    result = guest_ssh(run, "sudo -n systemctl restart user@$(id -u).service",
                       recorder, timeout=60)
    if result["rc"] != 0:
        raise RuntimeError("user manager restart failed: " + result["stderr"])
    ready = wait_manager_ready(run, recorder)
    after_phase = guest_phase(run, "inspect", recorder)
    after = after_phase.get("snapshot") or {}
    return {"started_at": started, "finished_at": utc_now(),
            "command": result, "ready": ready,
            "before": before, "after": after,
            "before_phase": before_phase, "after_phase": after_phase}


def wait_tcp(port: int, reachable: bool, timeout: float) -> dict:
    deadline = time.time() + timeout
    attempts = 0
    while time.time() < deadline:
        attempts += 1
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(2)
            state = sock.connect_ex(("127.0.0.1", port)) == 0
        if state == reachable:
            return {"attempts": attempts, "at": utc_now(), "reachable": state}
        time.sleep(1)
    raise RuntimeError("TCP port %d did not become %s" %
                       (port, "reachable" if reachable else "unreachable"))


def reboot_guest(run: dict, recorder: Recorder) -> dict:
    before_phase = guest_phase(run, "inspect", recorder)
    before = before_phase.get("snapshot") or {}
    run_dir = pathlib.Path(run["path"])
    identity = json.loads((run_dir / "process.json").read_text())
    issued = guest_ssh(run, "sudo -n systemctl reboot", recorder, timeout=15)
    deadline = time.time() + 240
    attempts = 0
    failures = 0
    boot_after = None
    while time.time() < deadline:
        attempts += 1
        result = guest_ssh(run, "cat /proc/sys/kernel/random/boot_id",
                           recorder, timeout=15)
        observed = (result.get("stdout") or "").strip()
        if result["rc"] == 0 and observed:
            if observed != before.get("boot_id"):
                boot_after = observed
                break
        else:
            failures += 1
        time.sleep(1)
    if not boot_after:
        raise RuntimeError("guest boot_id did not change after reboot")
    ready = wait_ssh(run, recorder, timeout=240)
    manager_ready = wait_manager_ready(run, recorder)
    after_phase = guest_phase(run, "inspect", recorder)
    after = after_phase.get("snapshot") or {}
    verified = process_matches(identity["pid"], identity["starttime"],
                               str(run_dir / "overlay.qcow2"))
    return {"before": before, "issued": issued, "boot_id_before": before.get("boot_id"),
            "boot_id_after": boot_after, "poll_attempts": attempts,
            "failed_connections": failures, "ssh_ready": ready,
            "manager_ready": manager_ready, "after": after,
            "before_phase": before_phase, "after_phase": after_phase,
            "qemu_pid_before": identity["pid"], "qemu_pid_after": identity["pid"],
            "qemu_identity_verified": verified}


# ---------------------------------------------------------------- evidence


def masked_state(snapshot: dict) -> dict:
    unit = (snapshot.get("units") or {}).get("crq-fixture.service") or {}
    path = (snapshot.get("files") or {}).get(
        str(pathlib.Path("/home/%s/.config/systemd/user/crq-fixture.service" % GUEST_USER))) or {}
    return {"unit": unit, "path": path}


def snapshot_entry_observed(entry) -> bool:
    """A snapshot entry must carry the metadata its own type promises."""
    if entry is None:
        return True
    if not isinstance(entry, dict):
        return False
    if entry.get("type") not in ("file", "symlink"):
        return False
    if not isinstance(entry.get("mode"), str):
        return False
    if not isinstance(entry.get("uid"), int) or not isinstance(entry.get("gid"), int):
        return False
    if entry["type"] == "file":
        digest = entry.get("sha256")
        return isinstance(digest, str) and DIGEST_RE.fullmatch(digest) is not None
    target = entry.get("link_target")
    return isinstance(target, str) and bool(target)


def snapshot_files_observed(snapshot: dict) -> bool:
    """A snapshot that omits an expected path cannot prove preservation."""
    files = snapshot.get("files")
    if not isinstance(files, dict):
        return False
    return all(str(path) in files and snapshot_entry_observed(files[str(path)])
               for path in SNAPSHOT_PATHS)


def build_checks(phases: dict, manager: dict, reboot: dict) -> dict:
    install = phases.get("install") or {}
    activation = phases.get("activation") or {}
    mask = phases.get("mask") or {}
    unmask = phases.get("unmask") or {}
    after_restart = masked_state(manager.get("after") or {})
    after_reboot = masked_state(reboot.get("after") or {})
    mask_path = mask.get("snapshot", {}).get("files", {}).get(
        str(pathlib.Path("/home/%s/.config/systemd/user/crq-fixture.service" % GUEST_USER))) or {}
    install_files = (install.get("snapshot") or {}).get("files") or {}
    unmask_files = (unmask.get("snapshot") or {}).get("files") or {}
    restore_changes = compare_files(install_files, unmask_files,
                                    ignore=(TRIGGER_PATH,))
    files_before = (reboot.get("before") or {}).get("files") or {}
    files_after = (reboot.get("after") or {}).get("files") or {}
    reboot_changes = compare_files(files_before, files_after,
                                   ignore=(TRIGGER_PATH,))
    def job_query_ok(observation):
        return (isinstance(observation, dict)
                and observation.get("ok") is True
                and observation.get("rc") == 0
                and isinstance(observation.get("lines"), list))

    def waiting(observation, unit):
        return (job_query_ok(observation)
                and any(unit in str(line) and "start waiting" in str(line)
                        for line in observation["lines"]))

    def succeeded(result):
        return isinstance(result, dict) and result.get("rc") == 0

    def settled(result):
        return (isinstance(result, dict)
                and result.get("settled") is True
                and result.get("query_ok") is True
                and result.get("rc") == 0
                and isinstance(result.get("jobs"), list))

    queued_setup_proven = (
        succeeded(activation.get("queue_blocker"))
        and succeeded(activation.get("queue_start"))
        and succeeded(activation.get("queue2_blocker"))
        and succeeded(activation.get("queue2_start"))
        and waiting(activation.get("jobs_before_mask"), "crq-queued-fixture.service")
        and waiting(activation.get("jobs2_before_stop"), "crq-queued-fixture.service"))
    queued_mask_proven = (
        succeeded(activation.get("reload"))
        and succeeded(activation.get("reload2"))
        and (activation.get("masked_state") or {}).get("LoadState") == "masked"
        and (activation.get("masked_state2") or {}).get("LoadState") == "masked")
    stop_jobs = activation.get("jobs2_after_stop")
    queued_stop_proven = (
        succeeded(activation.get("stop_queued_fixture"))
        and job_query_ok(stop_jobs)
        and not any("crq-queued-fixture.service" in str(line)
                    for line in stop_jobs["lines"]))
    checks = {
        "direct_start_ran": "service" in (activation.get("direct", {}).get("run_delta") or []),
        "dependency_start_ran": "dependent" in
        (activation.get("dependency", {}).get("run_delta") or []),
        "direct_refused": (mask.get("direct") or {}).get("rc") not in (0, None),
        "dependency_refused": (mask.get("dependency") or {}).get("rc") not in (0, None),
        "mask_load_state": (mask.get("service_state") or {}).get("LoadState") == "masked",
        "mask_link_target": mask_path.get("link_target") == "/dev/null",
        "timer_active": (mask.get("timer_before") or {}).get("ActiveState") == "active",
        "path_active": (mask.get("path_before") or {}).get("ActiveState") == "active",
        "timer_enabled": (mask.get("timer_before") or {}).get("UnitFileState") == "enabled",
        "path_enabled": (mask.get("path_before") or {}).get("UnitFileState") == "enabled",
        "timer_refused_while_masked": (mask.get("timer_start_while_masked") or {}).get("rc")
        not in (0, None),
        "path_refused_while_masked": (mask.get("path_start_while_masked") or {}).get("rc")
        not in (0, None),
        "run_after_trigger_observed": isinstance(mask.get("run_delta"), list),
        "no_run_after_trigger": (isinstance(mask.get("run_delta"), list)
                                 and not mask["run_delta"]),
        "timer_state_after_reboot":
        ((reboot.get("after") or {}).get("units", {}).get("crq-fixture.timer") or {})
        .get("ActiveState"),
        "path_state_after_reboot":
        ((reboot.get("after") or {}).get("units", {}).get("crq-fixture.path") or {})
        .get("ActiveState"),
        "activator_states_after_reboot": bool(
            ((reboot.get("after") or {}).get("units", {}).get("crq-fixture.timer") or {})
            .get("ActiveState")
            and ((reboot.get("after") or {}).get("units", {}).get("crq-fixture.path") or {})
            .get("ActiveState")),
        "run_log_observed_after_reboot": (
            isinstance((reboot.get("before") or {}).get("runs"), list)
            and isinstance((reboot.get("after") or {}).get("runs"), list)),
        "metadata_observed": bool(
            snapshot_files_observed(install.get("snapshot") or {})
            and snapshot_files_observed(unmask.get("snapshot") or {})
            and snapshot_files_observed(reboot.get("before") or {})
            and snapshot_files_observed(reboot.get("after") or {})),
        "queued_observations_present": (
            isinstance(activation.get("queued_run_delta"), list)
            and isinstance(activation.get("queued2_run_delta"), list)),
        "queued_setup_proven": queued_setup_proven,
        "queued_mask_proven": queued_mask_proven,
        "queued_stop_proven": queued_stop_proven,
        "queued_jobs_settled_after_mask": settled(
            activation.get("queued_jobs_after_release")),
        "queued_jobs_settled_after_stop": settled(
            activation.get("queued_jobs2_after_release")),
        "queued_wrapper_ran_after_mask":
        "queued" in (activation.get("queued_run_delta") or []),
        "queued_wrapper_ran_after_stop":
        "queued" in (activation.get("queued2_run_delta") or []),
        "queued_job_executed_after_mask": None,
        "queued_job_executed_after_stop": None,
        "native_mask_refused": (mask.get("native_mask") or {}).get("rc") not in (0, None),
        "alias_native_mask_refused": (mask.get("alias_native_mask") or {}).get("rc")
        not in (0, None),
        "alias_durable_mask_refused": (mask.get("alias_direct") or {}).get("rc")
        not in (0, None),
        "qemu_pid_unchanged": (reboot.get("qemu_pid_before") == reboot.get("qemu_pid_after")
                               and reboot.get("qemu_identity_verified") is True),
        "mask_persisted": (
            after_restart["unit"].get("LoadState") == "masked"
            and after_reboot["unit"].get("LoadState") == "masked"
            and after_restart["path"].get("link_target") == "/dev/null"
            and after_reboot["path"].get("link_target") == "/dev/null"
            and (manager.get("after_phase") or {}).get("direct", {}).get("rc")
            not in (0, None)
            and (manager.get("after_phase") or {}).get("dependency", {}).get("rc")
            not in (0, None)
            and (reboot.get("after_phase") or {}).get("direct", {}).get("rc")
            not in (0, None)
            and (reboot.get("after_phase") or {}).get("dependency", {}).get("rc")
            not in (0, None)),
        "manager_restarted": (
            (manager.get("before") or {}).get("manager", {}).get("pid")
            != (manager.get("after") or {}).get("manager", {}).get("pid")
            and (manager.get("after") or {}).get("manager", {}).get("pid", 0) > 0
            and (manager.get("before") or {}).get("manager", {}).get("invocation_id")
            != (manager.get("after") or {}).get("manager", {}).get("invocation_id")),
        "boot_id_changed": (
            reboot.get("boot_id_before") != reboot.get("boot_id_after")
            and bool(reboot.get("boot_id_after"))),
        "metadata_equal": not restore_changes,
        "metadata_changes": restore_changes,
        "mask_metadata_equal": not reboot_changes,
        "mask_metadata_changes": reboot_changes,
        "unmask_started": "service" in (unmask.get("run_delta") or []),
        "install_timer_enabled": ((install.get("snapshot", {}).get("units", {})
                                   .get("crq-fixture.timer") or {})
                                  .get("UnitFileState") == "enabled"),
        "install_path_enabled": ((install.get("snapshot", {}).get("units", {})
                                  .get("crq-fixture.path") or {})
                                 .get("UnitFileState") == "enabled"),
    }
    delta = activation.get("queued_run_delta")
    if isinstance(delta, list):
        checks["queued_job_executed_after_mask"] = "queued-fixture" in delta
    delta2 = activation.get("queued2_run_delta")
    if isinstance(delta2, list):
        checks["queued_job_executed_after_stop"] = "queued-fixture" in delta2
    for label, before_snapshot, after_snapshot in (
            ("manager_restart", manager.get("before"), manager.get("after")),
            ("reboot", reboot.get("before"), reboot.get("after"))):
        before_runs = (before_snapshot or {}).get("runs")
        after_runs = (after_snapshot or {}).get("runs")
        if isinstance(before_runs, list) and isinstance(after_runs, list):
            observed = len(after_runs) >= len(before_runs)
            new_runs = after_runs[len(before_runs):] if observed else after_runs
            checks["run_log_observed_after_" + label] = observed
            checks["no_new_service_after_" + label] = not any(
                entry.get("label") in ("service", "dependent", "alias")
                for entry in new_runs)
    return checks


def build_report(run: dict, boot: dict, phases: dict, manager: dict,
                 reboot: dict, stamps: dict, image: dict,
                 provenance: dict) -> dict:
    checks = build_checks(phases, manager, reboot)
    return {
        "schema_version": REPORT_SCHEMA,
        "kind": "crq-unit-switch-vm-feasibility",
        "run_id": run["run_id"],
        "started_at": run["started_at"],
        "finished_at": utc_now(),
        "image": image,
        "provenance": provenance,
        "guest": {
            "port": run["port"], "pid": boot["pid"], "scope_unit": boot["scope_unit"],
            "boot_id_before_manager_restart": (manager.get("before") or {}).get("boot_id"),
            "boot_id_after_reboot": (reboot.get("after") or {}).get("boot_id"),
            "boot_id_poll": {"attempts": reboot.get("poll_attempts"),
                             "failed_connections": reboot.get("failed_connections")},
            "qemu_pid": reboot.get("qemu_pid_after"),
            "qemu_identity_verified": reboot.get("qemu_identity_verified"),
            "manager_before": (manager.get("before") or {}).get("manager"),
            "manager_after_restart": (manager.get("after") or {}).get("manager"),
            "manager_after_reboot": (reboot.get("after") or {}).get("manager"),
            "systemd_version": (phases.get("install", {}).get("snapshot", {})
                                .get("systemd_version")),
        },
        "host_stamps": stamps,
        "phases": phases,
        "manager_restart": manager,
        "reboot": reboot,
        "checks": checks,
        "limitations": LIMITATIONS,
    }


def save_json(path: pathlib.Path, value) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


# -------------------------------------------------------------------- cli


def load_run(state: pathlib.Path, run_id: str | None, *,
             require_process: bool = True) -> dict:
    runs = sorted((state / "runs").glob("*")) if (state / "runs").is_dir() else []
    if not runs:
        raise ValueError("no runs under " + str(state / "runs"))
    run = runs[-1] if run_id is None else state / "runs" / run_id
    if require_process and not (run / "process.json").exists():
        raise ValueError("run has no retained process identity: " + str(run))
    meta = {}
    if (run / "run.json").exists():
        try:
            meta = json.loads((run / "run.json").read_text())
        except (OSError, ValueError) as exc:
            raise ValueError("unreadable run metadata: " + str(run / "run.json")) from exc
    return {"run_id": run.name, "path": str(run), "port": meta.get("port")}


def cmd_plan(args) -> int:
    state = pathlib.Path(args.state_dir).expanduser().resolve()
    print(json.dumps({
        "state_dir": str(state),
        "image": IMAGE_URL + IMAGE_NAME,
        "checksum": IMAGE_URL + SUMS_NAME,
        "integrity": "SHA256SUMS checksum only; not signed authenticity",
        "guest": {"user": GUEST_USER, "ram_mb": GUEST_RAM_MB,
                  "vcpus": GUEST_VCPUS, "overlay": OVERLAY_SIZE},
        "host_bounds": {"scope_memory": SCOPE_MEMORY, "scope_swap": "0",
                        "minimum_available_kib": MIN_AVAILABLE_KIB},
        "phases": ["fetch", "prepare", "boot", "install", "activation", "mask",
                   "restart-manager", "reboot", "unmask", "collect"],
        "qemu": qemu_command(state / "runs" / "<run>", 2222),
        "ssh": ssh_argv(state / "runs" / "<run>" / SSH_KEY, 2222,
                        state / "runs" / "<run>" / "known_hosts", "<remote>"),
    }, indent=2, sort_keys=True))
    return 0


def cmd_fetch(args) -> int:
    state = pathlib.Path(args.state_dir).expanduser().resolve()
    state.mkdir(parents=True, exist_ok=True)
    recorder = Recorder(state)
    image = fetch_image(state, recorder)
    print(json.dumps(image, indent=2, sort_keys=True))
    return 0


def cmd_prepare(args) -> int:
    state = pathlib.Path(args.state_dir).expanduser().resolve()
    state.mkdir(parents=True, exist_ok=True)
    recorder = Recorder(state)
    image = fetch_image(state, recorder)
    run = prepare_run(state, image, recorder, args.tools)
    save_json(pathlib.Path(run["path"]) / "run.json", run)
    print(json.dumps(run, indent=2, sort_keys=True))
    return 0


def cmd_boot(args) -> int:
    state = pathlib.Path(args.state_dir).expanduser().resolve()
    run = load_run(state, args.run_id, require_process=False)
    if not run["port"]:
        run["port"] = free_port()
        save_json(pathlib.Path(run["path"]) / "run.json", run)
    recorder = Recorder(pathlib.Path(run["path"]))
    stamp = host_stamp()
    try:
        info = boot(run, recorder, args.tools, stamp)
        info["ssh"] = wait_ssh(run, recorder)
        upload_guest_probe(run, recorder)
    except BaseException:
        try:
            stop_owned_process(run, purge=False)
        except Exception as cleanup_error:
            print("cleanup after failed boot did not complete: %s"
                  % cleanup_error, file=sys.stderr)
        raise
    print(json.dumps(info, indent=2, sort_keys=True))
    return 0


def cmd_phase(args) -> int:
    state = pathlib.Path(args.state_dir).expanduser().resolve()
    run = load_run(state, args.run_id)
    recorder = Recorder(pathlib.Path(run["path"]))
    payload = guest_phase(run, args.name, recorder)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def cmd_restart_manager(args) -> int:
    state = pathlib.Path(args.state_dir).expanduser().resolve()
    run = load_run(state, args.run_id)
    recorder = Recorder(pathlib.Path(run["path"]))
    payload = restart_manager(run, recorder)
    save_json(pathlib.Path(run["path"]) / "phases" / "manager-restart.json", payload)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def cmd_reboot(args) -> int:
    state = pathlib.Path(args.state_dir).expanduser().resolve()
    run = load_run(state, args.run_id)
    recorder = Recorder(pathlib.Path(run["path"]))
    payload = reboot_guest(run, recorder)
    save_json(pathlib.Path(run["path"]) / "phases" / "reboot.json", payload)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def cmd_run(args) -> int:
    state = pathlib.Path(args.state_dir).expanduser().resolve()
    state.mkdir(parents=True, exist_ok=True)
    source_commit = (getattr(args, "source_commit", None)
                     or os.environ.get("CRQ_VM_SOURCE_COMMIT"))
    if not isinstance(source_commit, str) or not COMMIT_RE.fullmatch(source_commit):
        raise ValueError("run requires --source-commit with the full git commit "
                         "whose tree produced the executed scripts")
    recorder = Recorder(state)
    stamps = {"start": host_stamp()}
    image = fetch_image(state, recorder)
    run = prepare_run(state, image, recorder, args.tools)
    save_json(pathlib.Path(run["path"]) / "run.json", run)
    try:
        run_dir = pathlib.Path(run["path"])
        host_source = pathlib.Path(__file__).resolve()
        guest_source = host_source.with_name("vm-guest-probe.py")
        guest_bytes = guest_source.read_bytes()
        host_artifact = run_dir / "executed-host-script.py"
        guest_artifact = run_dir / "executed-guest-probe.py"
        shutil.copy2(host_source, host_artifact)
        guest_artifact.write_bytes(guest_bytes)
        provenance = {
            "source_commit": source_commit,
            "host_script": {"artifact": host_artifact.name,
                            "sha256": sha256_file(host_artifact)},
            "guest_script": {"artifact": guest_artifact.name,
                             "sha256": sha256_file(guest_artifact)},
        }
        recorder = Recorder(pathlib.Path(run["path"]))
        stamp = host_stamp()
        boot_info = boot(run, recorder, args.tools, stamp)
        boot_info["ssh"] = wait_ssh(run, recorder)
        upload = upload_guest_probe(run, recorder, source=guest_bytes)
        provenance["guest_script"].update(upload)
        phases = {"install": guest_phase(run, "install", recorder),
                  "activation": guest_phase(run, "activation", recorder),
                  "mask": guest_phase(run, "mask", recorder)}
        stamps["after_mask"] = host_stamp()
        manager = restart_manager(run, recorder)
        phases["manager_restart"] = manager
        save_json(pathlib.Path(run["path"]) / "phases" / "manager-restart.json", manager)
        stamps["after_manager_restart"] = host_stamp()
        reboot = reboot_guest(run, recorder)
        phases["reboot"] = reboot
        save_json(pathlib.Path(run["path"]) / "phases" / "reboot.json", reboot)
        stamps["after_reboot"] = host_stamp()
        phases["unmask"] = guest_phase(run, "unmask", recorder)
        stamps["finish"] = host_stamp()
        report = build_report(run, boot_info, phases, manager, reboot, stamps, image,
                              provenance)
        save_json(pathlib.Path(run["path"]) / "report.json", report)
        problems = report_problems(report, require_evidence=True)
    except BaseException:
        if not args.keep:
            try:
                stop_owned_process(run, purge=False)
            except Exception as cleanup_error:
                print("cleanup after failed run did not complete: %s"
                      % cleanup_error, file=sys.stderr)
        raise
    print(json.dumps({"run": run["run_id"], "path": run["path"],
                      "problems": problems, "checks": report["checks"]},
                     indent=2, sort_keys=True))
    if args.keep:
        return 0 if not problems else 1
    cleanup = stop_owned_process(run, purge=False)
    if not cleanup["stopped"]:
        print(json.dumps({"cleanup": cleanup, "problems": problems},
                         indent=2, sort_keys=True))
        return 1
    return 0 if not problems else 1


def stop_owned_process(run: dict, *, purge: bool) -> dict:
    run_dir = pathlib.Path(run["path"])
    identity_path = run_dir / "process.json"
    identity = None
    if identity_path.exists():
        try:
            identity = json.loads(identity_path.read_text())
        except (OSError, ValueError) as exc:
            raise RuntimeError("unreadable process identity: " + str(identity_path)) from exc
    pid = identity.get("pid") if isinstance(identity, dict) else None
    scope_unit = identity.get("scope_unit") if isinstance(identity, dict) else None
    if identity is not None and (not isinstance(pid, int)
                                 or not isinstance(scope_unit, str)
                                 or not scope_unit):
        raise RuntimeError("invalid process identity: " + str(identity_path))
    if scope_unit and not scope_unit.endswith(".scope"):
        scope_unit += ".scope"
    needle = str(run_dir / "overlay.qcow2")
    stopped = True
    stop_rc = None
    if identity is not None:
        alive = pathlib.Path("/proc/%d" % pid).exists()
        if alive:
            if not process_matches(pid, identity.get("starttime"), needle):
                raise RuntimeError("refusing to stop an unverified process: %s" % pid)
            if scope_unit:
                result = subprocess.run(["systemctl", "--user", "stop", scope_unit],
                                        capture_output=True, text=True)
                stop_rc = result.returncode
            deadline = time.time() + 30
            def owned_alive():
                return (pathlib.Path("/proc/%d" % pid).exists()
                        and process_matches(pid, identity.get("starttime"), needle))

            while time.time() < deadline and owned_alive():
                time.sleep(0.5)
            stopped = not owned_alive()
    trashed = None
    if purge and stopped:
        trash = (run_dir.parent.parent / "trash"
                 / (run["run_id"] + "-" + utc_now().replace(":", "")
                    + "-" + uuid.uuid4().hex[:8]))
        trash.mkdir(parents=True, exist_ok=False)
        moved = False
        for name in ("overlay.qcow2", "seed.iso", SSH_KEY, SSH_KEY + ".pub",
                     "known_hosts"):
            source = run_dir / name
            if source.exists() or source.is_symlink():
                shutil.move(str(source), str(trash / name))
                moved = True
        if moved:
            trashed = str(trash)
        else:
            trash.rmdir()
    return {"scope_unit": scope_unit, "pid": pid,
            "stop_rc": stop_rc, "stopped": stopped, "trash": trashed}


def cmd_destroy(args) -> int:
    state = pathlib.Path(args.state_dir).expanduser().resolve()
    run = load_run(state, args.run_id, require_process=False)
    payload = stop_owned_process(run, purge=args.purge)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if payload["stopped"] else 1


def cmd_verify(args) -> int:
    report_path = pathlib.Path(args.report).resolve()
    report = json.loads(report_path.read_text())
    problems = verify_report(report, report_path.parent)
    print(json.dumps({"problems": problems}, indent=2, sort_keys=True))
    return 0 if not problems else 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", default=str(DEFAULT_STATE))
    parser.add_argument("--tools", type=pathlib.Path,
                        help="directory holding qemu, qemu-img and cloud-localds")
    parser.add_argument("--source-commit", default=None,
                        help="full git commit whose tree produced the executed scripts")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("plan")
    sub.add_parser("fetch")
    sub.add_parser("prepare")
    boot_parser = sub.add_parser("boot")
    boot_parser.add_argument("--run-id")
    phase = sub.add_parser("phase")
    phase.add_argument("name", choices=["install", "activation", "mask", "inspect", "unmask"])
    phase.add_argument("--run-id")
    restart = sub.add_parser("restart-manager")
    restart.add_argument("--run-id")
    reboot = sub.add_parser("reboot")
    reboot.add_argument("--run-id")
    run = sub.add_parser("run")
    run.add_argument("--keep", action="store_true",
                     help="leave the bounded guest running for inspection")
    destroy = sub.add_parser("destroy")
    destroy.add_argument("--run-id")
    destroy.add_argument("--purge", action="store_true",
                         help="move this run's overlay/seed/key into state/trash")
    verify = sub.add_parser("verify")
    verify.add_argument("report")
    args = parser.parse_args(argv)
    commands = {"plan": cmd_plan, "fetch": cmd_fetch, "prepare": cmd_prepare,
                "boot": cmd_boot, "phase": cmd_phase,
                "restart-manager": cmd_restart_manager, "reboot": cmd_reboot,
                "run": cmd_run, "destroy": cmd_destroy, "verify": cmd_verify}
    try:
        return commands[args.command](args)
    except (ValueError, RuntimeError) as exc:
        print("refused: " + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
