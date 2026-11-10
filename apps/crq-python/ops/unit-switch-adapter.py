#!/usr/bin/env python3
"""Guest-only unit-switch adapter for the bounded proof vehicle.

This module implements the seam that ``deploy-controller.switch_unit`` and
``deploy-controller.recover_unit`` inject. It is deliberately narrow:

* one allowlisted controller unit, ``crq-tick.service``, installed in an
  isolated disposable guest as a harmless fixture;
* real ``systemctl --user`` fencing, installation and activation;
* exact path/type/bytes/mode/uid/gid snapshot validation and restoration;
* a fake unit/runtime-bound completion provider that reads records emitted by
  the fixture's real systemd invocations.

It is not a production adapter. There is no default wiring, no production
provider and no real CRQ runtime completion. The CLI that constructs it
requires an explicit ``--proof-fixture`` flag, and the adapter refuses any
layout other than the disposable guest's when ``guest_only`` is true.

No journal, lock, pointer store or approval mechanism lives here. The
controller owns the private fsynced journal and checkout lock; the adapter only
performs host effects and reports evidence.
"""
from __future__ import annotations

import base64
import errno
import hashlib
import json
import os
import pathlib
import re
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time

UNIT = "crq-tick.service"
TIMER = "crq-tick.timer"
WANTS = "timers.target.wants/crq-tick.timer"
SUPPORTED_UNITS = {UNIT: {"timer": TIMER, "wants": WANTS}}
SCHEMA_VERSION = 1
RUNTIME_RE = re.compile(r"python|node:[0-9a-f]{40}\Z")
INVOCATION_RE = re.compile(r"[0-9a-f]{32}\Z")
MAX_UNIT_BYTES = 64 * 1024
MAX_COMPLETION_BYTES = 256 * 1024
DRAIN_TIMEOUT = 15.0
COMPLETION_TIMEOUT = 45.0
ACTIVE_STATES = {"active", "inactive", "activating", "deactivating", "failed"}
UNIT_FILE_STATES = {"enabled", "disabled", "static", "masked", "alias",
                    "indirect", "generated", "transient", "bad"}
PATH_KEYS = {"type", "mode", "uid", "gid", "bytes_b64", "sha256", "size",
             "target", "xattrs"}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _text_output(value) -> str:
    """Normalize captured command output; TimeoutExpired may retain bytes."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value if isinstance(value, str) else str(value)


def valid_runtime(value) -> bool:
    return isinstance(value, str) and RUNTIME_RE.fullmatch(value) is not None


class GuestFixtureAdapter:
    """Real host effects for one isolated harmless fixture unit."""

    def __init__(self, unit_dir, fixture_dir, unit=UNIT,
                 proof_root=None, runner=None, error_type=RuntimeError,
                 guest_only=True, completion_timeout=COMPLETION_TIMEOUT,
                 drain_timeout=DRAIN_TIMEOUT, sleep=time.sleep,
                 clock=time.monotonic):
        self.unit = unit
        self.unit_dir = pathlib.Path(unit_dir)
        self.fixture_dir = pathlib.Path(fixture_dir)
        self.proof_root = pathlib.Path(proof_root or self.fixture_dir.parent
                                       / "proof-bin")
        self.runner = runner or self._subprocess_runner
        self.error = error_type
        self.guest_only = guest_only
        self.completion_timeout = completion_timeout
        self.drain_timeout = drain_timeout
        self.sleep = sleep
        self.clock = clock
        self.commands = []
        self._snapshot = None
        self._returned = []
        self.last_drain = None
        self.last_install = None
        self.last_restore = None

    # -- refusal and process helpers ------------------------------------
    def refuse(self, message):
        raise self.error(message)

    def _subprocess_runner(self, argv, timeout):
        try:
            result = subprocess.run(argv, capture_output=True, text=True,
                                    timeout=timeout)
            return {"argv": list(argv), "rc": result.returncode,
                    "stdout": result.stdout[-8000:],
                    "stderr": result.stderr[-8000:], "timeout": False}
        except subprocess.TimeoutExpired as exc:
            return {"argv": list(argv), "rc": None, "timeout": True,
                    "stdout": _text_output(exc.stdout)[-8000:],
                    "stderr": _text_output(exc.stderr)[-8000:]}

    def run_command(self, argv, timeout=60):
        result = self.runner([str(item) for item in argv], timeout)
        if not isinstance(result, dict) or "rc" not in result:
            self.refuse("command runner returned an unreadable result")
        result.setdefault("timeout", False)
        result["stdout"] = _text_output(result.get("stdout"))
        result["stderr"] = _text_output(result.get("stderr"))
        self.commands.append({"argv": result["argv"], "rc": result["rc"],
                              "timeout": bool(result["timeout"]),
                              "stdout": result["stdout"][-2000:],
                              "stderr": result["stderr"][-2000:]})
        return result

    def systemctl(self, *args, timeout=60):
        return self.run_command(["systemctl", "--user", *args], timeout=timeout)

    def _ok(self, result, what):
        if result.get("timeout") or result.get("rc") != 0:
            detail = (result.get("stderr") or result.get("stdout") or "").strip()
            self.refuse(what + " failed: " + (detail[:300] or "rc "
                                              + str(result.get("rc"))))
        return result

    def _show(self, unit, props):
        result = self.run_command(["systemctl", "--user", "show", unit,
                                   "-p", ",".join(props)], timeout=30)
        if result.get("timeout") or result.get("rc") != 0:
            detail = (result.get("stderr") or result.get("stdout") or "").strip()
            self.refuse("unit observation failed for " + unit + ": "
                        + (detail[:300] or "rc " + str(result.get("rc"))))
        values = {}
        for line in (result.get("stdout") or "").splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                values[key] = value
        for prop in props:
            if prop not in values:
                self.refuse("unit observation omitted " + prop + " for " + unit)
        return values

    def _jobs(self):
        result = self.run_command(["systemctl", "--user", "list-jobs",
                                   "--no-legend", "--no-pager"], timeout=30)
        if result.get("timeout") or result.get("rc") != 0:
            self.refuse("systemctl list-jobs failed; job absence is unknown")
        stdout = result.get("stdout")
        if not isinstance(stdout, str):
            self.refuse("systemctl list-jobs returned no text")
        return [line for line in stdout.splitlines() if line.strip()]

    def _jobs_for(self, names):
        return [line for line in self._jobs()
                if any(re.search(r"(?:^|\s)" + re.escape(name) + r"(?:\s|$)", line)
                       for name in names)]

    def _cgroup_pids(self, unit):
        props = self._show(unit, ["MainPID", "ControlGroup", "ActiveState"])
        main = props.get("MainPID", "0")
        if not main.isdigit():
            self.refuse("unit MainPID is not an integer for " + unit)
        if int(main) > 0:
            return {"main_pid": int(main), "pids": [int(main)],
                    "cgroup": props.get("ControlGroup", "")}
        cgroup = props.get("ControlGroup", "")
        if not cgroup:
            return {"main_pid": 0, "pids": [], "cgroup": ""}
        root = pathlib.Path("/sys/fs/cgroup")
        procs = root / cgroup.lstrip("/") / "cgroup.procs"
        try:
            text = procs.read_text()
        except FileNotFoundError:
            return {"main_pid": 0, "pids": [], "cgroup": cgroup}
        except OSError as exc:
            self.refuse("cgroup observation failed for " + unit + ": "
                        + str(exc)[:160])
        pids = [int(line) for line in text.split() if line.strip().isdigit()]
        return {"main_pid": 0, "pids": pids, "cgroup": cgroup}

    # -- filesystem observations ----------------------------------------
    def _unit_paths(self):
        return {
            "service": self.unit_dir / self.unit,
            "timer": self.unit_dir / SUPPORTED_UNITS[self.unit]["timer"],
            "wants": self.unit_dir / SUPPORTED_UNITS[self.unit]["wants"],
        }

    def _staged_service_path(self, service):
        service = pathlib.Path(service)
        return service.with_name("." + service.name + ".staged")

    def _validate_layout(self):
        if self.unit not in SUPPORTED_UNITS:
            self.refuse("unit is not supported by this proof adapter: "
                        + str(self.unit))
        if not self.unit_dir.is_absolute() or not self.fixture_dir.is_absolute():
            self.refuse("adapter paths must be absolute")
        if self.unit_dir.is_symlink():
            self.refuse("unit directory must not be a symlink")
        for path in self._unit_paths().values():
            try:
                path.relative_to(self.unit_dir)
            except ValueError:
                self.refuse("unit path escapes the unit directory")
        if self.fixture_dir.is_symlink():
            self.refuse("fixture directory must not be a symlink")

    def _check_guest(self):
        if not self.guest_only:
            return
        home = pathlib.Path.home()
        if socket.gethostname() != "crq-probe":
            self.refuse("proof adapter only runs on the disposable crq-probe guest")
        expected = {"unit_dir": home / ".config/systemd/user",
                    "fixture_dir": home / "fixture",
                    "proof_root": home / "proof-bin"}
        observed = {"unit_dir": self.unit_dir.resolve(),
                    "fixture_dir": self.fixture_dir.resolve(),
                    "proof_root": self.proof_root.resolve()}
        for name, path in expected.items():
            if observed[name] != path.resolve():
                self.refuse("proof adapter layout is not the isolated guest layout")
        if (home / "repos").exists():
            self.refuse("a production checkout directory is present in the guest")
        opt = home / ".local/opt"
        if opt.exists() and list(opt.glob("crq-*")):
            self.refuse("a production crq artifact directory is present in the guest")
        for path in self.unit_dir.glob("crq-*"):
            if path.is_symlink() or not path.is_file():
                continue
            try:
                text = path.read_text(errors="replace")
            except OSError as exc:
                self.refuse("installed unit is unreadable: " + str(exc)[:160])
            if "crq.py" in text or "dist/queue-runner" in text:
                self.refuse("a production CRQ unit is installed in the guest")

    def _xattrs(self, path):
        try:
            names = os.listxattr(path, follow_symlinks=False)
        except OSError as exc:
            if exc.errno in (errno.ENOTSUP, errno.EOPNOTSUPP, errno.ENODATA):
                return []
            self.refuse("xattr observation failed for " + str(path) + ": "
                        + str(exc)[:160])
        return list(names)

    def _path_state(self, path):
        path = pathlib.Path(path)
        try:
            info = path.lstat()
        except FileNotFoundError:
            return {"type": "missing"}
        state = {"mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid,
                 "gid": info.st_gid, "xattrs": self._xattrs(path)}
        if stat.S_ISLNK(info.st_mode):
            state.update({"type": "symlink", "target": os.readlink(path)})
        elif stat.S_ISREG(info.st_mode):
            try:
                data = path.read_bytes()
            except OSError as exc:
                self.refuse("unit file is unreadable: " + str(exc)[:160])
            if len(data) > MAX_UNIT_BYTES:
                self.refuse("unit file exceeds the proof adapter bound")
            state.update({"type": "file",
                          "bytes_b64": base64.b64encode(data).decode("ascii"),
                          "sha256": sha256_bytes(data), "size": len(data)})
        else:
            state.update({"type": "other"})
        return state

    def _fsync_dir(self, path):
        handle = os.open(str(path), os.O_RDONLY)
        try:
            os.fsync(handle)
        finally:
            os.close(handle)

    def _write_bytes(self, path, data):
        path = pathlib.Path(path)
        if not path.parent.is_dir() or path.parent.is_symlink():
            self.refuse("destination directory is missing or a symlink: "
                        + str(path.parent))
        fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".",
                                         dir=str(path.parent))
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, path)
            self._fsync_dir(path.parent)
        finally:
            pathlib.Path(temporary).unlink(missing_ok=True)

    def _apply_mode_owner(self, path, mode, uid, gid, *, symlink=False):
        path = pathlib.Path(path)
        if not symlink:
            os.chmod(path, mode)
        if uid != os.getuid() or gid != os.getgid():
            try:
                os.chown(path, uid, gid, follow_symlinks=not symlink)
            except OSError as exc:
                self.refuse("cannot restore ownership for " + str(path) + ": "
                            + str(exc)[:160])

    def _validate_state_shape(self, path, state):
        if not isinstance(state, dict) or "type" not in state:
            self.refuse("snapshot path entry is not an object")
        kind = state["type"]
        allowed = {"missing"} if kind == "missing" else PATH_KEYS
        if kind not in {"missing", "file", "symlink"}:
            self.refuse("unsupported snapshot path type: " + str(kind))
        if set(state) - allowed:
            self.refuse("snapshot path entry has unknown keys")
        if kind == "missing":
            if set(state) != {"type"}:
                self.refuse("missing snapshot entry has extra keys")
            return
        for key in ("mode", "uid", "gid", "xattrs"):
            if key not in state:
                self.refuse("snapshot path entry is missing " + key)
        if type(state["mode"]) is not int or state["mode"] < 0 \
                or state["mode"] > 0o7777:
            self.refuse("snapshot mode is not a permission mask")
        if kind == "file":
            if state["mode"] & 0o7000:
                self.refuse("snapshot mode has unsupported special bits")
            if state["mode"] & 0o022:
                self.refuse("snapshot mode is group- or world-writable")
        elif state["mode"] != 0o777:
            self.refuse("symlink snapshot mode is not the platform symlink mode")
        if type(state["uid"]) is not int or type(state["gid"]) is not int \
                or state["uid"] < 0 or state["gid"] < 0:
            self.refuse("snapshot ownership is invalid")
        if state["uid"] != os.getuid() or state["gid"] != os.getgid():
            self.refuse("snapshot ownership is not the isolated guest account")
        if state["xattrs"] != []:
            self.refuse("snapshot metadata contains unsupported extended attributes")
        if kind == "file":
            required = {"type", "mode", "uid", "gid", "bytes_b64", "sha256",
                        "size", "xattrs"}
            if set(state) != required:
                self.refuse("file snapshot entry has the wrong keys")
            if not isinstance(state["bytes_b64"], str) \
                    or not isinstance(state["sha256"], str):
                self.refuse("file snapshot bytes are not encoded")
            try:
                data = base64.b64decode(state["bytes_b64"].encode("ascii"),
                                        validate=True)
            except (ValueError, UnicodeEncodeError):
                self.refuse("file snapshot bytes are not valid base64")
            if len(data) > MAX_UNIT_BYTES:
                self.refuse("snapshot file exceeds the proof adapter bound")
            if sha256_bytes(data) != state["sha256"] \
                    or len(data) != state["size"]:
                self.refuse("snapshot file digest or size does not match its bytes")
        elif kind == "symlink":
            required = {"type", "mode", "uid", "gid", "target", "xattrs"}
            if set(state) != required:
                self.refuse("symlink snapshot entry has the wrong keys")
            target = state["target"]
            if not isinstance(target, str) or not target:
                self.refuse("symlink snapshot target is invalid")
            if path == self._unit_paths()["service"] and target == "/dev/null":
                self.refuse("refusing to snapshot a durable mask as prior state")
            resolved = (path.parent / target).resolve()
            root = self.unit_dir.resolve()
            if not resolved.is_relative_to(root):
                self.refuse("symlink snapshot target escapes the unit directory")

    def _validate_path_allowed(self, path):
        path = pathlib.Path(path)
        if not path.is_absolute():
            self.refuse("snapshot path is not absolute")
        paths = {str(value): key for key, value in self._unit_paths().items()}
        if str(path) not in paths:
            self.refuse("snapshot contains an unowned path: " + str(path))
        try:
            path.parent.resolve().relative_to(self.unit_dir.resolve())
        except ValueError:
            self.refuse("snapshot path parent escapes the unit directory")

    def validate_snapshot(self, unit, snapshot):
        self._validate_layout()
        self._check_guest()
        if unit != self.unit:
            self.refuse("snapshot unit does not match the adapter unit")
        if not isinstance(snapshot, dict) or set(snapshot) != {
                "schema_version", "unit", "runtime", "paths", "activators"}:
            self.refuse("snapshot is not a complete proof snapshot object")
        if snapshot["schema_version"] != SCHEMA_VERSION \
                or type(snapshot["schema_version"]) is not int:
            self.refuse("snapshot schema version is unsupported")
        if snapshot["unit"] != unit or not valid_runtime(snapshot["runtime"]):
            self.refuse("snapshot runtime or unit is invalid")
        paths = snapshot["paths"]
        if not isinstance(paths, dict) \
                or set(paths) != {str(path) for path in self._unit_paths().values()}:
            self.refuse("snapshot does not name the exact owned paths")
        for path, state in paths.items():
            self._validate_path_allowed(path)
            self._validate_state_shape(pathlib.Path(path), state)
        service = paths[str(self._unit_paths()["service"])]
        timer = paths[str(self._unit_paths()["timer"])]
        wants = paths[str(self._unit_paths()["wants"])]
        if service["type"] != "file" or timer["type"] != "file":
            self.refuse("proof snapshot requires regular service and timer files")
        if wants["type"] not in ("symlink", "missing"):
            self.refuse("proof snapshot wants path has an unsupported type")
        activators = snapshot["activators"]
        if not isinstance(activators, dict) or set(activators) != {
                "timer_active", "timer_unit_file_state", "service_active"}:
            self.refuse("snapshot activator observation is incomplete")
        if activators["timer_active"] not in ACTIVE_STATES \
                or activators["service_active"] not in ACTIVE_STATES \
                or activators["timer_unit_file_state"] not in UNIT_FILE_STATES:
            self.refuse("snapshot activator observation is unknown")
        if activators["timer_active"] not in ("active", "inactive") \
                or activators["service_active"] not in ("active", "inactive"):
            self.refuse("snapshot activator state is not restorable")
        self._snapshot = snapshot

    def _snapshot_required(self):
        if self._snapshot is None:
            self.refuse("adapter has no validated snapshot")
        return self._snapshot

    def _runtime_from_unit(self, path):
        path = pathlib.Path(path)
        try:
            text = path.read_text()
        except OSError as exc:
            self.refuse("installed unit is unreadable: " + str(exc)[:160])
        lines = [line for line in text.splitlines()
                 if line.startswith("ExecStart=")]
        if len(lines) != 1:
            self.refuse("installed unit must contain exactly one ExecStart")
        try:
            parts = shlex.split(lines[0][len("ExecStart="):])
        except ValueError as exc:
            self.refuse("installed unit ExecStart cannot be parsed: " + str(exc)[:160])
        expected = {
            "python": str(self.proof_root / "unit-switch-fixture.py"),
            "node": str(self.proof_root / "unit-switch-fixture.mjs"),
        }
        if len(parts) < 6:
            self.refuse("installed unit ExecStart is incomplete")
        if "--runtime" not in parts or "--unit" not in parts \
                or "--completions" not in parts:
            self.refuse("installed unit ExecStart lacks proof fixture bindings")
        runtime = parts[parts.index("--runtime") + 1]
        unit = parts[parts.index("--unit") + 1]
        completions = parts[parts.index("--completions") + 1]
        if not valid_runtime(runtime):
            self.refuse("installed unit runtime marker is invalid")
        if unit != self.unit:
            self.refuse("installed unit ExecStart names another unit")
        if completions != str(self.completions_path()):
            self.refuse("installed unit ExecStart names another completion log")
        script = expected["python" if runtime == "python" else "node"]
        if script not in parts:
            self.refuse("installed unit ExecStart names the wrong fixture script")
        interpreter = parts[0]
        if runtime == "python" and pathlib.Path(interpreter).name != "python3":
            self.refuse("installed unit does not use the Python fixture interpreter")
        if runtime != "python" and pathlib.Path(interpreter).name != "node":
            self.refuse("installed unit does not use the Node fixture interpreter")
        return runtime

    def completions_path(self):
        return self.fixture_dir / "completions.jsonl"

    def render_unit(self, runtime):
        if not valid_runtime(runtime):
            self.refuse("invalid proof runtime")
        if runtime == "python":
            argv = ["/usr/bin/python3",
                    str(self.proof_root / "unit-switch-fixture.py")]
        else:
            argv = ["/usr/bin/node",
                    str(self.proof_root / "unit-switch-fixture.mjs")]
        argv.extend(["--unit", self.unit, "--runtime", runtime,
                     "--completions", str(self.completions_path())])
        return ("[Unit]\n"
                "Description=CRQ proof fixture under " + self.unit + "\n"
                "\n"
                "[Service]\n"
                "Type=oneshot\n"
                "ExecStart=" + " ".join(shlex.quote(item) for item in argv) + "\n"
                "TimeoutStartSec=30\n")

    def render_timer(self):
        return ("[Unit]\n"
                "Description=CRQ proof timer under " + TIMER + "\n"
                "\n"
                "[Timer]\n"
                "OnUnitInactiveSec=1s\n"
                "AccuracySec=1s\n"
                "Unit=" + self.unit + "\n"
                "\n"
                "[Install]\n"
                "WantedBy=timers.target\n")

    def _render_wants_target(self):
        return "../" + TIMER

    # -- seam: preflight -------------------------------------------------
    def preflight(self, unit, runtime):
        if unit != self.unit:
            self.refuse("unit is not supported by this proof adapter")
        self._validate_layout()
        self._check_guest()
        if not valid_runtime(runtime):
            self.refuse("invalid requested runtime")
        paths = self._unit_paths()
        service = self._path_state(paths["service"])
        if service["type"] != "file":
            self.refuse("prior installed service is not a regular file")
        timer = self._path_state(paths["timer"])
        if timer["type"] != "file":
            self.refuse("prior installed timer is not a regular file")
        wants = self._path_state(paths["wants"])
        if wants["type"] not in ("symlink", "missing"):
            self.refuse("prior timer enablement is not a symlink or absent")
        if service["xattrs"] or timer["xattrs"] or wants.get("xattrs"):
            self.refuse("prior installed unit metadata is unsupported")
        fixture = self.proof_root / ("unit-switch-fixture.py"
                                     if runtime == "python"
                                     else "unit-switch-fixture.mjs")
        state = self._path_state(fixture)
        if state["type"] != "file" or state["xattrs"]:
            self.refuse("fixture provider executable is unavailable: " + str(fixture))
        interpreter = "python3" if runtime == "python" else "node"
        found = shutil.which(interpreter)
        if not found:
            self.refuse("fixture interpreter is unavailable: " + interpreter)
        version = self.run_command([found, "--version"], timeout=30)
        self._ok(version, interpreter + " version observation")
        prior = self._runtime_from_unit(paths["service"])
        return {"runtime": prior}

    # -- seam: snapshot and validation ----------------------------------
    def snapshot(self, unit):
        if unit != self.unit:
            self.refuse("unit is not supported by this proof adapter")
        self._validate_layout()
        self._check_guest()
        paths = self._unit_paths()
        observations = {
            "service": self._show(self.unit,
                                  ["ActiveState", "LoadState", "FragmentPath"]),
            "timer": self._show(TIMER,
                                ["ActiveState", "UnitFileState", "LoadState"]),
        }
        snapshot = {
            "schema_version": SCHEMA_VERSION,
            "unit": unit,
            "runtime": self._runtime_from_unit(paths["service"]),
            "paths": {str(path): self._path_state(path)
                      for path in paths.values()},
            "activators": {
                "timer_active": observations["timer"]["ActiveState"],
                "timer_unit_file_state": observations["timer"]["UnitFileState"],
                "service_active": observations["service"]["ActiveState"],
            },
        }
        self._snapshot = snapshot
        return snapshot

    # -- seam: fence and drain ------------------------------------------
    def _usable_current_service(self, path):
        state = self._path_state(path)
        if state["type"] not in ("file", "symlink"):
            self.refuse("service path is neither a file nor a mask symlink")
        if state["uid"] != os.getuid() or state["gid"] != os.getgid():
            self.refuse("service path ownership is not the isolated guest account")
        if state["xattrs"]:
            self.refuse("service path has unsupported extended attributes")
        if state["type"] == "file":
            if state["mode"] & 0o7000 or state["mode"] & 0o022:
                self.refuse("service file mode is unsafe to fence")
        elif state["target"] != "/dev/null":
            self.refuse("service path is an unexpected symlink")
        return state

    def _wait_drain(self):
        deadline = self.clock() + self.drain_timeout
        attempts = 0
        while True:
            attempts += 1
            jobs = self._jobs_for([self.unit, TIMER])
            owned = self._cgroup_pids(self.unit)
            state = self._show(self.unit, ["ActiveState", "SubState", "LoadState"])
            if (not jobs and not owned["pids"] and owned["main_pid"] == 0
                    and state["ActiveState"] == "inactive"):
                return {"jobs": jobs, "owned": owned, "state": state,
                        "attempts": attempts}
            if self.clock() >= deadline:
                self.refuse("drain did not establish absence within the bound: "
                            + json.dumps({"jobs": jobs, "owned": owned,
                                          "state": state}, sort_keys=True)[:500])
            self.sleep(0.25)

    def stop_and_drain(self, unit):
        if unit != self.unit:
            self.refuse("unit is not supported by this proof adapter")
        self._snapshot_required()
        self._maybe_kill("drain")
        paths = self._unit_paths()
        before = self._usable_current_service(paths["service"])
        result = self.systemctl("stop", TIMER, timeout=60)
        if result.get("timeout") or result.get("rc") not in (0, 5):
            self.refuse("timer stop did not complete")
        self.systemctl("reset-failed", TIMER)
        timer = self._show(TIMER, ["ActiveState", "LoadState"])
        if timer["ActiveState"] not in ("inactive", "failed"):
            self.refuse("timer activator is still active during fence")
        if not (paths["service"].is_symlink()
                and os.readlink(paths["service"]) == "/dev/null"):
            temporary = paths["service"].with_name(
                "." + paths["service"].name + ".mask")
            temporary.unlink(missing_ok=True)
            temporary.symlink_to("/dev/null")
            os.replace(temporary, paths["service"])
            self._fsync_dir(paths["service"].parent)
        self._ok(self.systemctl("daemon-reload"), "daemon reload after mask")
        masked = self._show(self.unit, ["LoadState", "FragmentPath"])
        if masked["LoadState"] != "masked" \
                or masked["FragmentPath"] != str(paths["service"]):
            self.refuse("durable service replacement did not reach masked state")
        refusal = self.systemctl("start", self.unit, timeout=60)
        if refusal.get("rc") == 0:
            self.refuse("masked service still accepted a direct start")
        text = ((refusal.get("stdout") or "") + (refusal.get("stderr") or "")).lower()
        if "masked" not in text:
            self.refuse("direct start failed for an unknown reason while fenced")
        self.systemctl("stop", self.unit)
        self.systemctl("reset-failed", self.unit)
        drained = self._wait_drain()
        self.last_drain = {"before": before, "masked": masked,
                           "direct_start": {"rc": refusal.get("rc"),
                                            "stdout": refusal.get("stdout"),
                                            "stderr": refusal.get("stderr")},
                           **drained}
        return self.last_drain

    # -- seam: completion sequence and install --------------------------
    def _read_completions(self):
        path = self.completions_path()
        try:
            raw = path.read_text()
        except FileNotFoundError:
            return []
        except OSError as exc:
            self.refuse("completion log is unreadable: " + str(exc)[:160])
        if len(raw.encode()) > MAX_COMPLETION_BYTES:
            self.refuse("completion log exceeds the proof adapter bound")
        records = []
        for number, line in enumerate(raw.splitlines(), 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except ValueError:
                self.refuse("completion log line " + str(number) + " is not JSON")
            if not isinstance(record, dict):
                self.refuse("completion log line " + str(number) + " is not an object")
            if record.get("unit") != self.unit \
                    or not valid_runtime(record.get("runtime")) \
                    or record.get("success") is not True \
                    or type(record.get("sequence")) is not int \
                    or record["sequence"] < 1 \
                    or not isinstance(record.get("invocation"), str) \
                    or INVOCATION_RE.fullmatch(record["invocation"]) is None:
                self.refuse("completion log line " + str(number)
                            + " is not valid unit/runtime evidence")
            records.append(record)
        return records

    def sequence(self, unit):
        if unit != self.unit:
            self.refuse("unit is not supported by this proof adapter")
        records = self._read_completions()
        return max((record["sequence"] for record in records), default=0)

    def install(self, unit, runtime):
        if unit != self.unit or not valid_runtime(runtime):
            self.refuse("invalid install request")
        self._snapshot_required()
        self._maybe_kill("install")
        paths = self._unit_paths()
        current = self._show(self.unit, ["LoadState"])
        if current["LoadState"] != "masked":
            self.refuse("install requires an established durable service mask")
        fenced = self._usable_current_service(paths["service"])
        if fenced["type"] != "symlink" or fenced["target"] != "/dev/null":
            self.refuse("install requires the durable /dev/null service fence")
        snapshot = self._snapshot
        for key in ("timer", "wants"):
            path = paths[key]
            if self._path_state(path) != snapshot["paths"][str(path)]:
                self.refuse("activator path changed during the fenced interval: "
                            + key)
        text = self.render_unit(runtime)
        staged = self._staged_service_path(paths["service"])
        self._write_bytes(staged, text.encode())
        os.chmod(staged, 0o644)
        self._fsync_dir(staged.parent)
        state = self._path_state(staged)
        if state["type"] != "file" or state["mode"] != 0o644 \
                or state["uid"] != os.getuid() or state["xattrs"]:
            self.refuse("staged unit metadata is not the isolated proof shape")
        observed = self._runtime_from_unit(staged)
        if observed != runtime:
            self.refuse("staged unit runtime marker does not match the request")
        fenced = self._usable_current_service(paths["service"])
        if fenced["type"] != "symlink" or fenced["target"] != "/dev/null":
            self.refuse("install released the durable service fence")
        current = self._show(self.unit, ["LoadState", "FragmentPath"])
        if current["LoadState"] != "masked" \
                or current["FragmentPath"] != str(paths["service"]):
            self.refuse("staged install changed the masked service state")
        for key in ("timer", "wants"):
            path = paths[key]
            if self._path_state(path) != snapshot["paths"][str(path)]:
                self.refuse("install changed an activator path: " + key)
        self.last_install = {"runtime": runtime, "staged": str(staged),
                             "sha256": state["sha256"]}
        return self.last_install

    # -- seam: release and completion -----------------------------------
    def start(self, unit):
        if unit != self.unit:
            self.refuse("unit is not supported by this proof adapter")
        self._maybe_kill("start")
        paths = self._unit_paths()
        staged = self._staged_service_path(paths["service"])
        installed = self.last_install
        if not isinstance(installed, dict) \
                or installed.get("staged") != str(staged) \
                or not valid_runtime(installed.get("runtime")):
            self.refuse("start requires a staged target from this adapter")
        fenced = self._usable_current_service(paths["service"])
        if fenced["type"] != "symlink" or fenced["target"] != "/dev/null":
            self.refuse("start requires the durable /dev/null service fence")
        state = self._show(self.unit, ["LoadState", "FragmentPath"])
        if state["LoadState"] != "masked" \
                or state["FragmentPath"] != str(paths["service"]):
            self.refuse("start requires the service to remain masked")
        staged_state = self._path_state(staged)
        if staged_state["type"] != "file" \
                or staged_state["sha256"] != installed["sha256"] \
                or self._runtime_from_unit(staged) != installed["runtime"]:
            self.refuse("staged target changed before release")
        os.replace(staged, paths["service"])
        self._fsync_dir(paths["service"].parent)
        self._ok(self.systemctl("daemon-reload"), "daemon reload after release")
        loaded = self._show(self.unit, ["LoadState", "FragmentPath"])
        if loaded["LoadState"] != "loaded" \
                or loaded["FragmentPath"] != str(paths["service"]):
            self.refuse("released unit did not load from the expected path")
        released = self._path_state(paths["service"])
        if released["type"] != "file" or released["mode"] != 0o644 \
                or released["uid"] != os.getuid() or released["xattrs"] \
                or released["sha256"] != installed["sha256"] \
                or self._runtime_from_unit(paths["service"]) != installed["runtime"]:
            self.refuse("released unit metadata does not match the staged target")
        self._ok(self.systemctl("start", self.unit, timeout=60),
                 "fixture service release")
        self._ok(self.systemctl("start", TIMER, timeout=60),
                 "timer activator release")
        timer = self._show(TIMER, ["ActiveState", "LoadState"])
        if timer["ActiveState"] != "active" or timer["LoadState"] != "loaded":
            self.refuse("timer activator did not become active")
        return {"service_start": True, "timer": timer}

    def completion(self, unit, runtime, previous):
        if unit != self.unit or not valid_runtime(runtime) \
                or type(previous) is not int or previous < 0:
            self.refuse("invalid completion request")
        deadline = self.clock() + self.completion_timeout
        observed_sequences = []
        while True:
            records = self._read_completions()
            observed_sequences = sorted(record["sequence"] for record in records)
            candidate = next((record for record in sorted(
                records, key=lambda item: item["sequence"])
                if record["sequence"] > previous), None)
            if candidate is not None:
                if candidate["runtime"] != runtime:
                    self.refuse("completion runtime does not match the installed unit")
                if candidate["invocation"] in {item["invocation"]
                                               for item in self._returned}:
                    self.refuse("completion invocation is not distinct")
                installed = self._runtime_from_unit(
                    self._unit_paths()["service"])
                if installed != runtime:
                    self.refuse("installed unit changed before completion evidence")
                self._returned.append(candidate)
                return {"unit": unit, "runtime": runtime, "success": True,
                        "sequence": candidate["sequence"],
                        "invocation": candidate["invocation"],
                        "at": candidate.get("at"),
                        "boot_id": candidate.get("boot_id")}
            if self.clock() >= deadline:
                self.refuse("no advancing completion arrived within the bound: "
                            + json.dumps({"previous": previous,
                                          "sequences": observed_sequences})[:300])
            self.sleep(0.25)

    # -- seam: restore ---------------------------------------------------
    def _compare_state(self, path, expected):
        actual = self._path_state(path)
        keys = {"type"}
        if expected["type"] == "file":
            keys |= {"mode", "uid", "gid", "sha256", "size", "xattrs"}
        elif expected["type"] == "symlink":
            keys |= {"mode", "uid", "gid", "target", "xattrs"}
        mismatched = sorted(key for key in keys
                            if actual.get(key) != expected.get(key))
        if mismatched:
            self.refuse("restored path does not match its snapshot: " + str(path)
                        + " (" + ", ".join(mismatched) + ")")

    def _restore_path(self, path, state):
        path = pathlib.Path(path)
        if state["type"] == "missing":
            if path.is_symlink() or path.exists():
                path.unlink()
                self._fsync_dir(path.parent)
            return
        if state["type"] == "file":
            data = base64.b64decode(state["bytes_b64"].encode("ascii"),
                                    validate=True)
            self._write_bytes(path, data)
            self._apply_mode_owner(path, state["mode"], state["uid"], state["gid"])
            return
        if state["type"] == "symlink":
            if path.is_symlink() or path.exists():
                path.unlink()
            path.symlink_to(state["target"])
            self._apply_mode_owner(path, state["mode"], state["uid"], state["gid"],
                                   symlink=True)
            self._fsync_dir(path.parent)
            return
        self.refuse("unsupported restore state")

    def restore(self, unit, snapshot):
        if unit != self.unit:
            self.refuse("unit is not supported by this proof adapter")
        self.validate_snapshot(unit, snapshot)
        self._maybe_kill("restore")
        paths = self._unit_paths()
        staged = self._staged_service_path(paths["service"])
        staged.unlink(missing_ok=True)
        self._fsync_dir(paths["service"].parent)
        self.systemctl("stop", TIMER)
        self.systemctl("reset-failed", TIMER)
        fenced = self._usable_current_service(paths["service"])
        if fenced["type"] != "symlink" or fenced["target"] != "/dev/null":
            self.refuse("restore requires the durable /dev/null service fence")
        for key in ("timer", "wants"):
            path = paths[key]
            self._restore_path(path, snapshot["paths"][str(path)])
        self._restore_path(staged, snapshot["paths"][str(paths["service"])])
        self._ok(self.systemctl("daemon-reload"), "daemon reload after restore")
        for key in ("timer", "wants"):
            path = paths[key]
            self._compare_state(path, snapshot["paths"][str(path)])
        self._compare_state(staged, snapshot["paths"][str(paths["service"])])
        masked = self._show(self.unit, ["LoadState", "FragmentPath"])
        if masked["LoadState"] != "masked" \
                or masked["FragmentPath"] != str(paths["service"]):
            self.refuse("restore must keep the service masked until activation")
        runtime = self._runtime_from_unit(staged)
        if runtime != snapshot["runtime"]:
            self.refuse("staged restore runtime does not match the snapshot")
        self.last_restore = {"runtime": runtime, "paths": list(snapshot["paths"]),
                             "staged": str(staged), "masked": masked}
        return self.last_restore

    def restore_activation(self, unit, snapshot):
        if unit != self.unit:
            self.refuse("unit is not supported by this proof adapter")
        self.validate_snapshot(unit, snapshot)
        self._maybe_kill("restore_activation")
        paths = self._unit_paths()
        staged = self._staged_service_path(paths["service"])
        service_state = snapshot["paths"][str(paths["service"])]
        self._compare_state(staged, service_state)
        if self._runtime_from_unit(staged) != snapshot["runtime"]:
            self.refuse("staged restore runtime changed before activation")
        fenced = self._usable_current_service(paths["service"])
        if fenced["type"] != "symlink" or fenced["target"] != "/dev/null":
            self.refuse("restore activation requires the durable /dev/null service fence")
        os.replace(staged, paths["service"])
        self._fsync_dir(paths["service"].parent)
        self._ok(self.systemctl("daemon-reload"), "daemon reload after restore release")
        loaded = self._show(self.unit, ["LoadState", "FragmentPath"])
        if loaded["LoadState"] != "loaded" \
                or loaded["FragmentPath"] != str(paths["service"]):
            self.refuse("restored service did not load from the expected path")
        self._compare_state(paths["service"], service_state)
        if self._runtime_from_unit(paths["service"]) != snapshot["runtime"]:
            self.refuse("restored service runtime does not match the snapshot")
        expected = snapshot["activators"]
        if expected["timer_active"] == "active":
            self._ok(self.systemctl("start", TIMER), "restore timer activation")
        elif expected["timer_active"] == "inactive":
            self.systemctl("stop", TIMER)
            self.systemctl("reset-failed", TIMER)
        else:
            self.refuse("snapshot timer active state is unsupported")
        if expected["service_active"] == "active":
            self._ok(self.systemctl("start", self.unit), "restore service activation")
        elif expected["service_active"] == "inactive":
            self.systemctl("stop", self.unit)
            self.systemctl("reset-failed", self.unit)
        else:
            self.refuse("snapshot service active state is unsupported")
        timer = self._show(TIMER, ["ActiveState", "UnitFileState", "LoadState"])
        service = self._show(self.unit, ["ActiveState", "LoadState"])
        if timer["ActiveState"] != expected["timer_active"]:
            self.refuse("restored timer active state does not match the snapshot")
        if timer["UnitFileState"] != expected["timer_unit_file_state"]:
            self.refuse("restored timer enablement does not match the snapshot")
        if service["ActiveState"] != expected["service_active"]:
            self.refuse("restored service active state does not match the snapshot")
        return {"timer": timer, "service": service}

    def _maybe_kill(self, phase):
        """Proof-only interruption hook; never reachable for a production caller."""
        if not self.guest_only:
            return
        if os.environ.get("CRQ_PROOF_KILL_ON") == phase:
            os.kill(os.getpid(), signal.SIGKILL)


def main(argv=None):
    """Refuse direct use: this module is an injected seam, not a provider."""
    print(json.dumps({"refused": "unit-switch-adapter is a proof-only seam; "
                                 "use unit-switch.py --proof-fixture"},
                     sort_keys=True))
    return 2


if __name__ == "__main__":
    sys.exit(main())
