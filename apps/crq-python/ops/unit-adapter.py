#!/usr/bin/env python3
"""Unwired, fail-closed production per-unit systemd adapter.

This module implements the exact seam that ``deploy-controller.switch_unit`` and
``recover_unit`` inject. It is deliberately unwired: no CLI constructs it, and
it contains no live systemd binding, production factory or default host path.
Every host observation and command goes through an injected port.

The adapter reuses ``prepare-host.render_service`` for source-bound rendering and
derives its declared unit inventory from the pinned template tree. It does not
claim exhaustive installed-host activation discovery, root coverage or caller
coverage. Injected discovery evidence must enumerate the supported topology and
reject foreign entries. Unknown or failed observations refuse before mutation.

The snapshot payload reuses the guest adapter's schema version 1 top-level keys,
path-state shapes and activator key names. The owned path set and activator key
set are derived from the production topology. The controller stores the payload
opaquely and does not read its internals.
"""
from __future__ import annotations

import base64
import errno
import hashlib
import importlib.util
import json
import os
import re
import shlex
import stat
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Protocol

SCHEMA_VERSION = 1
TEMPLATE_DIR = "apps/crq-python/ops/systemd/"
MAX_UNIT_BYTES = 1 << 20
RUNTIME_RE = re.compile(r"node:[0-9a-f]{40}")
SHA_RE = re.compile(r"[0-9a-f]{40}")
HEX64_RE = re.compile(r"[0-9a-f]{64}")
NODE_SCRIPT_RE = re.compile(
    r"(?P<root>.*/\.local/opt/crq-(?P<sha>[0-9a-f]{40}))"
    r"/dist/queue-runner/crq\.js")
DURATION_RE = re.compile(r"(?P<value>\d+)(?P<unit>ms|s|min|h)?")
UNIT_FILE_STATES = {"enabled", "disabled", "static", "masked", "alias",
                    "indirect", "generated", "transient", "bad"}
RESTORABLE_ACTIVE = {"active", "inactive"}
DEFAULT_COMPLETION_WINDOW = 1800.0
COMPLETION_MARGIN_SECONDS = 60


class SystemdPort(Protocol):
    """Injected host observation and command port. No implementation here."""

    def discover(self, unit: str, declared_paths: tuple[str, ...]) -> dict: ...

    def run(self, *args: str, timeout: float = 60) -> dict: ...

    def show(self, unit: str, props: list[str]) -> dict: ...

    def jobs(self) -> list[str]: ...

    def cgroup_pids(self, unit: str) -> dict: ...


class IdentityPort(Protocol):
    """Injected ownership and extended-attribute policy port."""

    @property
    def uid(self) -> int: ...

    @property
    def gid(self) -> int: ...

    def xattrs(self, path: Path) -> list[str]: ...


class CapabilityPort(Protocol):
    """Injected runtime command availability. ``None`` means unproven."""

    def commands(self, runtime: str) -> frozenset[str] | None: ...


class CompletionPort(Protocol):
    """Injected per-unit completion stream.

    Evidence must bind the unit, exact runtime, a distinct invocation, an
    advancing integer sequence and the installed service file digest.
    """

    def sequence(self, unit: str) -> int: ...

    def read(self, unit: str, runtime: str, previous: int) -> dict | None: ...


class DeclaredCapabilities:
    """Conservative static capability policy, not a runtime probe.

    The Python checkout is the current production runtime, so its declared
    unit commands are accepted only after the rendered script path is checked.
    No machine-readable Node artifact capability declaration exists. Node
    therefore has no declared commands and every Node preflight refuses.
    """

    def commands(self, runtime: str) -> frozenset[str] | None:
        if runtime == "python":
            return frozenset(_prepare_host().UNIT_COMMANDS.values())
        if isinstance(runtime, str) and RUNTIME_RE.fullmatch(runtime):
            return frozenset()
        return None


_PREPARE = None


def _prepare_host():
    global _PREPARE
    if _PREPARE is None:
        path = Path(__file__).with_name("prepare-host.py")
        spec = importlib.util.spec_from_file_location(
            "crq_prepare_host_adapter", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _PREPARE = module
    return _PREPARE


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _valid_runtime(value) -> bool:
    return value == "python" or (
        isinstance(value, str) and RUNTIME_RE.fullmatch(value) is not None)


def _valid_template_name(name: str) -> None:
    path = Path(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError("template name escapes the template directory: " + name)
    if len(path.parts) > 2:
        raise ValueError("nested template is not declared: " + name)
    for part in path.parts:
        if re.fullmatch(r"[A-Za-z0-9_.@:-]+", part) is None:
            raise ValueError("unrecognized template name: " + name)


def _read_template(prepare, root: Path, source_sha: str, name: str):
    source = TEMPLATE_DIR + name
    oid = prepare.git(root, "rev-parse", source_sha + ":" + source)
    if SHA_RE.fullmatch(oid) is None:
        raise ValueError("template object id is invalid: " + name)
    raw = prepare.run_bytes(["git", "-C", str(root), "cat-file", "blob", oid])
    expected = hashlib.sha1(
        b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
    if expected != oid:
        raise ValueError("template bytes do not match the pinned Git blob: " + name)
    return oid, raw, raw.decode("utf-8")


def _section_values(text: str, section: str, key: str) -> list[str]:
    values = []
    current = None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            current = stripped[1:-1].strip()
            continue
        if current == section and stripped.startswith(key + "="):
            values.append(stripped.split("=", 1)[1].strip())
    return values


def _duration_seconds(text: str) -> int | None:
    match = DURATION_RE.fullmatch(text.strip())
    if match is None:
        return None
    value = int(match.group("value"))
    unit = match.group("unit") or "s"
    factor = {"ms": 0.001, "s": 1, "min": 60, "h": 3600}[unit]
    seconds = value * factor
    if seconds <= 0:
        return None
    return int(seconds) if seconds >= 1 else 1


def _calendar_interval_seconds(text: str) -> int | None:
    value = text.strip()
    cadence = re.fullmatch(r"\*:0/(\d+)", value)
    if cadence is not None:
        value = int(cadence.group(1))
        return value * 60 if value > 0 else None
    if re.fullmatch(r"\*-\*-\* \*:\*:00", value):
        return 60
    daily = re.fullmatch(
        r"\*-\*-\* ([0-9,]+):([0-9]{2}):([0-9]{2})(?: \S+)?", value)
    if daily is None:
        return None
    hours = [int(item) for item in daily.group(1).split(",") if item]
    minute = int(daily.group(2))
    second = int(daily.group(3))
    if (not hours or any(hour < 0 or hour > 23 for hour in hours)
            or minute > 59 or second > 59):
        return None
    points = sorted({hour * 60 + minute for hour in hours})
    if len(points) == 1:
        return 24 * 60 * 60
    gaps = [right - left for left, right in zip(points, points[1:])]
    gaps.append(24 * 60 - points[-1] + points[0])
    return max(gaps) * 60


def _timer_bound_seconds(text: str) -> int | None:
    intervals = []
    for value in _section_values(text, "Timer", "OnCalendar"):
        parsed = _calendar_interval_seconds(value)
        if parsed is None:
            return None
        intervals.append(parsed)
    for key in ("OnUnitActiveSec", "OnUnitInactiveSec"):
        for value in _section_values(text, "Timer", key):
            parsed = _duration_seconds(value)
            if parsed is None:
                return None
            intervals.append(parsed)
    accuracies = []
    for value in _section_values(text, "Timer", "AccuracySec"):
        parsed = _duration_seconds(value)
        if parsed is None:
            return None
        accuracies.append(parsed)
    # systemd defaults AccuracySec to 1min when a timer declares none, so a
    # timer without the key can fire up to 60 s after its interval.
    accuracy = max(accuracies, default=60)
    if not intervals:
        return None
    return max(intervals) + accuracy


def _single_value(values: list[str], name: str, default=None):
    if len(values) > 1:
        raise ValueError("template declares multiple " + name)
    return values[0] if values else default


def declared_inventory(root: Path, source_sha: str) -> dict:
    """The declared six-unit inventory at one pinned commit.

    A committed ``crq-*`` file that is not a declared service, timer or path
    template refuses. This is template inventory, not installed-host
    discovery, and it proves nothing about arbitrary dependency, wants or
    drop-in entries outside the scanned unit directory.
    """
    root = Path(root)
    if not isinstance(source_sha, str) or SHA_RE.fullmatch(source_sha) is None:
        raise ValueError("source commit must be a full 40-hex SHA")
    prepare = _prepare_host()
    head = prepare.git(root, "rev-parse", source_sha + "^{commit}")
    if head != source_sha:
        raise ValueError("source commit does not resolve to itself")
    listing = prepare.git(root, "ls-tree", "-r", "--name-only", source_sha,
                          TEMPLATE_DIR)
    committed = set()
    for line in listing.splitlines():
        if line.startswith(TEMPLATE_DIR):
            name = line[len(TEMPLATE_DIR):]
            if name:
                committed.add(name)
    if not committed:
        raise ValueError("pinned commit lacks CRQ unit templates")
    declared = {}
    declared_templates = set()
    for unit in prepare.UNIT_COMMANDS:
        _valid_template_name(unit)
        if unit not in committed:
            raise ValueError("pinned commit lacks the service template: " + unit)
        service_oid, _service_raw, service_text = _read_template(
            prepare, root, source_sha, unit)
        prepare.validate_unit_template(unit, service_text)
        exec_starts = [line for line in service_text.splitlines()
                       if line.startswith("ExecStart=")]
        if len(exec_starts) != 1:
            raise ValueError("service template must have exactly one ExecStart: " + unit)
        service_type = _single_value(
            _section_values(service_text, "Service", "Type"),
            "service Type", "simple")
        if service_type not in {"oneshot", "simple"}:
            raise ValueError("service template has an unsupported Type: " + unit)
        explicit_timeout = _section_values(
            service_text, "Service", "TimeoutStartSec")
        if explicit_timeout:
            service_timeout = _duration_seconds(_single_value(
                explicit_timeout, "service TimeoutStartSec"))
            if service_timeout is None:
                raise ValueError(
                    "service template has an invalid TimeoutStartSec: " + unit)
        elif service_type == "oneshot":
            # systemd disables the start timeout for oneshot by default, so the
            # declared topology does not bound completion for these units.
            service_timeout = None
        else:
            service_timeout = 90
        stem = unit[:-len(".service")]
        timer = stem + ".timer"
        path_unit = stem + ".path"
        if timer not in committed:
            raise ValueError("pinned commit lacks the timer template: " + timer)
        timer_wants = None
        path_wants = None
        timer_bound = None
        timer_sha256 = None
        blobs = {unit: service_oid}
        declared_templates.add(unit)
        if timer in committed:
            timer_oid, timer_raw, timer_text = _read_template(
                prepare, root, source_sha, timer)
            prepare.validate_unit_template(timer, timer_text)
            wanted = _section_values(timer_text, "Install", "WantedBy")
            if len(wanted) != 1 or not wanted[0]:
                raise ValueError(
                    "timer template must declare exactly one WantedBy: " + timer)
            units = _section_values(timer_text, "Timer", "Unit")
            if len(units) > 1 or (units and units[0] != unit):
                raise ValueError("timer template names another unit: " + timer)
            timer_wants = wanted[0] + ".wants/" + timer
            _valid_template_name(timer_wants)
            timer_bound = _timer_bound_seconds(timer_text)
            timer_sha256 = hashlib.sha256(timer_raw).hexdigest()
            blobs[timer] = timer_oid
            declared_templates.add(timer)
        if path_unit in committed:
            path_oid, _path_raw, path_text = _read_template(
                prepare, root, source_sha, path_unit)
            prepare.validate_unit_template(path_unit, path_text)
            wanted = _section_values(path_text, "Install", "WantedBy")
            if len(wanted) != 1 or not wanted[0]:
                raise ValueError(
                    "path template must declare exactly one WantedBy: " + path_unit)
            units = _section_values(path_text, "Path", "Unit")
            if len(units) > 1 or (units and units[0] != unit):
                raise ValueError("path template names another unit: " + path_unit)
            path_wants = wanted[0] + ".wants/" + path_unit
            _valid_template_name(path_wants)
            blobs[path_unit] = path_oid
            declared_templates.add(path_unit)
        declared[unit] = {
            "service": unit,
            "timer": timer if timer in committed else None,
            "path": path_unit if path_unit in committed else None,
            "timer_wants": timer_wants,
            "path_wants": path_wants,
            "service_type": service_type,
            "service_timeout_seconds": service_timeout,
            "timer_bound_seconds": timer_bound,
            "timer_sha256": timer_sha256,
            "blobs": blobs,
        }
    extra = sorted(committed - declared_templates)
    if extra:
        raise ValueError("undeclared committed template: " + ", ".join(extra))
    missing = sorted(declared_templates - committed)
    if missing:
        raise ValueError(
            "declared template is absent from the pinned commit: "
            + ", ".join(missing))
    return declared


class ProductionUnitAdapter:
    """Strict seam implementation. Construct only with injected ports."""

    def __init__(self, *, root, source_sha, unit_dir, artifact_root,
                 systemd, identity, capability, completion, queue_drain,
                 error_type=RuntimeError, drain_timeout=30.0,
                 completion_timeout=DEFAULT_COMPLETION_WINDOW,
                 max_completion_window=DEFAULT_COMPLETION_WINDOW,
                 clock=time.monotonic, sleep=time.sleep):
        if systemd is None or identity is None or capability is None:
            raise TypeError("systemd, identity and capability ports are required")
        if (not isinstance(completion_timeout, (int, float))
                or isinstance(completion_timeout, bool)
                or completion_timeout <= 0
                or not isinstance(max_completion_window, (int, float))
                or isinstance(max_completion_window, bool)
                or max_completion_window <= 0):
            raise TypeError("completion window must be a positive number")
        self.root = Path(root)
        self.source_sha = source_sha
        self.unit_dir = Path(unit_dir)
        self.artifact_root = (Path(artifact_root)
                              if artifact_root is not None else None)
        self.systemd = systemd
        self.identity = identity
        self.capability = capability
        self._completion_port = completion
        self.queue_drain = queue_drain
        self.error = error_type
        self.drain_timeout = drain_timeout
        self.completion_timeout = completion_timeout
        self.max_completion_window = max_completion_window
        self._completion_window = None
        self.clock = clock
        self.sleep = sleep
        self._declared = None
        self._rendered = {}
        self._requested_runtime = None
        self._snapshot = None
        self._snapshot_unit = None
        self._install = None
        self._restore = None
        self._returned_invocations = set()
        self.last_drain = None
        self.last_release_order = None
        self.last_restore_order = None

    # -- refusal and validation helpers ---------------------------------
    def refuse(self, message):
        raise self.error(message)

    def _inventory(self):
        if self._declared is None:
            try:
                self._declared = declared_inventory(self.root, self.source_sha)
            except (ValueError, OSError, subprocess.CalledProcessError) as exc:
                self.refuse("declared template inventory refused: "
                            + str(exc)[:300])
        return self._declared

    def _validate_unit(self, unit):
        if unit not in _prepare_host().UNIT_COMMANDS:
            self.refuse("unit is not in the declared runtime inventory: "
                        + str(unit))

    def _validate_runtime(self, runtime):
        if not _valid_runtime(runtime):
            self.refuse("runtime must be python or node:<40-hex>")

    def _unit_paths(self, unit, inventory):
        entry = inventory[unit]
        paths = {"service": self.unit_dir / entry["service"],
                 "timer": self.unit_dir / entry["timer"]}
        if entry["timer_wants"] is not None:
            paths["timer_wants"] = self.unit_dir / entry["timer_wants"]
        if entry["path"] is not None:
            paths["path"] = self.unit_dir / entry["path"]
        if entry["path_wants"] is not None:
            paths["path_wants"] = self.unit_dir / entry["path_wants"]
        return paths

    def _activator_units(self, unit, inventory):
        pairs = [("timer", inventory[unit]["timer"])]
        if inventory[unit]["path"] is not None:
            pairs.append(("path", inventory[unit]["path"]))
        return pairs

    def _validate_layout(self, unit, inventory):
        self._validate_unit(unit)
        if not self.root.is_absolute() or not self.root.is_dir():
            self.refuse("deployment root must be an absolute directory")
        if not self.unit_dir.is_absolute() or self.unit_dir.is_symlink() \
                or not self.unit_dir.is_dir():
            self.refuse("unit directory must be an absolute regular directory")
        if not isinstance(self.source_sha, str) \
                or SHA_RE.fullmatch(self.source_sha) is None:
            self.refuse("source commit must be a full 40-hex SHA")
        for path in self._unit_paths(unit, inventory).values():
            try:
                path.relative_to(self.unit_dir)
            except ValueError:
                self.refuse("unit path escapes the unit directory")

    # -- filesystem state ------------------------------------------------
    def _xattrs(self, path):
        try:
            names = self.identity.xattrs(Path(path))
        except OSError as exc:
            if exc.errno in (errno.ENOTSUP, errno.EOPNOTSUPP, errno.ENODATA):
                return []
            self.refuse("xattr observation failed for " + str(path) + ": "
                        + str(exc)[:160])
        if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
            self.refuse("xattr observation is malformed for " + str(path))
        return list(names)

    def _path_state(self, path):
        path = Path(path)
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
                self.refuse("unit file exceeds the adapter bound")
            state.update({"type": "file",
                          "bytes_b64": base64.b64encode(data).decode("ascii"),
                          "sha256": _sha256_bytes(data), "size": len(data)})
        else:
            state.update({"type": "other"})
        return state

    def _validate_state_shape(self, path, state):
        if not isinstance(state, dict) or "type" not in state:
            self.refuse("snapshot path entry is not an object")
        kind = state["type"]
        if kind not in {"missing", "file", "symlink"}:
            self.refuse("unsupported snapshot path type: " + str(kind))
        if kind == "missing":
            if set(state) != {"type"}:
                self.refuse("missing snapshot entry has extra keys")
            return
        allowed = {"type", "mode", "uid", "gid", "xattrs"}
        if kind == "file":
            allowed |= {"bytes_b64", "sha256", "size"}
        else:
            allowed |= {"target"}
        if set(state) != allowed:
            self.refuse("snapshot path entry has the wrong keys")
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
        if state["uid"] != self.identity.uid or state["gid"] != self.identity.gid:
            self.refuse("snapshot ownership is not the adapter identity")
        if state["xattrs"] != []:
            self.refuse("snapshot metadata contains unsupported extended attributes")
        if kind == "file":
            try:
                data = base64.b64decode(state["bytes_b64"].encode("ascii"),
                                        validate=True)
            except (ValueError, UnicodeEncodeError):
                self.refuse("file snapshot bytes are not valid base64")
            if len(data) > MAX_UNIT_BYTES:
                self.refuse("snapshot file exceeds the adapter bound")
            if state["size"] != len(data) \
                    or state["sha256"] != _sha256_bytes(data):
                self.refuse("snapshot file digest or size does not match its bytes")
        else:
            target = state["target"]
            if not isinstance(target, str) or not target:
                self.refuse("symlink snapshot target is invalid")
            if path == self._unit_paths(self._snapshot_unit,
                                        self._inventory())["service"] \
                    and target == "/dev/null":
                self.refuse("refusing to snapshot a durable mask as prior state")
            resolved = (Path(path).parent / target).resolve()
            if not resolved.is_relative_to(self.unit_dir.resolve()):
                self.refuse("symlink snapshot target escapes the unit directory")

    def _validate_path_allowed(self, path, paths):
        path = Path(path)
        if not path.is_absolute():
            self.refuse("snapshot path is not absolute")
        if str(path) not in {str(value) for value in paths.values()}:
            self.refuse("snapshot contains an unowned path: " + str(path))
        try:
            path.parent.resolve().relative_to(self.unit_dir.resolve())
        except ValueError:
            self.refuse("snapshot path parent escapes the unit directory")

    def _installed_entries(self, unit, inventory):
        paths = self._unit_paths(unit, inventory)
        allowed = {str(path) for path in paths.values()}
        prefix = unit.split(".")[0]
        unexpected = {}
        for path in sorted(self.unit_dir.glob(prefix + "*")):
            if str(path) not in allowed:
                unexpected[str(path)] = "unexpected installed entry"
        for wants in sorted(self.unit_dir.glob("*.wants")):
            if wants.is_symlink() or not wants.is_dir():
                continue
            for path in sorted(wants.glob(prefix + "*")):
                if str(path) not in allowed:
                    unexpected[str(path)] = "unexpected enablement link"
        for name in (unit, inventory[unit]["timer"], inventory[unit]["path"]):
            if name is None:
                continue
            dropin = self.unit_dir / (name + ".d")
            if dropin.exists() or dropin.is_symlink():
                unexpected[str(dropin)] = "undeclared drop-in directory"
        if unexpected:
            self.refuse("installed topology is outside the declared inventory: "
                        + json.dumps(unexpected, sort_keys=True)[:500])

    # -- port wrappers ---------------------------------------------------
    def _run(self, *args, timeout=60):
        try:
            result = self.systemd.run(*args, timeout=timeout)
        except Exception as exc:
            self.refuse("systemd command failed: "
                        + (str(exc) or type(exc).__name__)[:200])
        if not isinstance(result, dict) or "rc" not in result:
            self.refuse("systemd command returned an unreadable result: "
                        + " ".join(str(arg) for arg in args))
        if not isinstance(result.get("stdout"), str) \
                or not isinstance(result.get("stderr"), str):
            self.refuse("systemd command returned non-text output: "
                        + " ".join(str(arg) for arg in args))
        result.setdefault("timeout", False)
        return result

    def _ok(self, result, what):
        if result.get("timeout") or result.get("rc") != 0:
            detail = (result.get("stderr") or result.get("stdout") or "").strip()
            self.refuse(what + " failed: "
                        + (detail[:300] or "rc " + str(result.get("rc"))))

    def _show(self, unit, props):
        try:
            values = self.systemd.show(unit, list(props))
        except Exception as exc:
            self.refuse("systemd show failed for " + unit + ": "
                        + (str(exc) or type(exc).__name__)[:200])
        if not isinstance(values, dict):
            self.refuse("systemd show returned an unreadable result for " + unit)
        for prop in props:
            if prop not in values or not isinstance(values[prop], str):
                self.refuse("systemd show omitted " + prop + " for " + unit)
        return values

    def _jobs(self):
        try:
            lines = self.systemd.jobs()
        except Exception as exc:
            self.refuse("systemd list-jobs failed: "
                        + (str(exc) or type(exc).__name__)[:200])
        if not isinstance(lines, list) or not all(isinstance(line, str)
                                                  for line in lines):
            self.refuse("systemd list-jobs returned an unreadable result")
        for line in lines:
            if not line.strip():
                continue
            fields = line.split()
            if len(fields) < 4 or not fields[0].isdigit():
                self.refuse("systemd list-jobs observation is malformed: "
                            + line[:160])
        return lines

    def _cgroup(self, unit):
        try:
            value = self.systemd.cgroup_pids(unit)
        except Exception as exc:
            self.refuse("cgroup observation failed for " + unit + ": "
                        + (str(exc) or type(exc).__name__)[:200])
        if (not isinstance(value, dict)
                or type(value.get("main_pid")) is not int
                or value["main_pid"] < 0
                or not isinstance(value.get("pids"), list)
                or not all(type(pid) is int and pid > 0
                           for pid in value["pids"])
                or not isinstance(value.get("cgroup"), str)):
            self.refuse("cgroup observation is malformed for " + unit)
        return value

    def _observe_queue(self):
        if self.queue_drain is None:
            self.refuse("no recorded queue drain observation provider")
        try:
            observation = self.queue_drain()
        except Exception as exc:
            self.refuse("queue drain observation failed; ownership is "
                        "unknown: " + (str(exc) or type(exc).__name__)[:200])
        if (not isinstance(observation, dict)
                or not isinstance(observation.get("drained"), bool)
                or not isinstance(observation.get("blocked"), list)):
            self.refuse("queue drain observation is malformed")
        return observation

    # -- discovery evidence ----------------------------------------------
    def _discover(self, unit, inventory, paths):
        try:
            evidence = self.systemd.discover(
                unit, tuple(str(path) for path in paths.values()))
        except Exception as exc:
            self.refuse("injected discovery failed: "
                        + (str(exc) or type(exc).__name__)[:200])
        if not isinstance(evidence, dict):
            self.refuse("injected discovery evidence is not an object")
        if evidence.get("complete") is not True \
                or evidence.get("supported") is not True:
            self.refuse("injected discovery did not establish a complete "
                        "supported topology")
        if evidence.get("error") is not None:
            self.refuse("injected discovery failed: "
                        + str(evidence.get("error"))[:200])
        foreign = evidence.get("foreign")
        if not isinstance(foreign, list) or foreign:
            self.refuse("injected discovery names foreign activators: "
                        + json.dumps(foreign, sort_keys=True)[:300])
        observed = evidence.get("paths")
        if not isinstance(observed, dict) \
                or set(observed) != {str(path) for path in paths.values()}:
            self.refuse("injected discovery did not enumerate the exact "
                        "declared paths")
        for path in paths.values():
            entry = observed[str(path)]
            if not isinstance(entry, dict) \
                    or entry.get("type") not in {"file", "symlink", "missing"}:
                self.refuse("injected discovery path entry is malformed: "
                            + str(path))
            if entry["type"] != self._path_state(path)["type"]:
                self.refuse("injected discovery disagrees with the filesystem: "
                            + str(path))
        units = evidence.get("units")
        expected = {inventory[unit]["service"]}
        expected.update(name for _role, name
                        in self._activator_units(unit, inventory))
        if not isinstance(units, dict) or set(units) != expected:
            self.refuse("injected discovery did not enumerate the exact "
                        "declared units")
        jobs = evidence.get("jobs")
        if not isinstance(jobs, list) or not all(isinstance(line, str)
                                                 for line in jobs):
            self.refuse("injected discovery jobs are malformed")
        return evidence

    # -- render and runtime identity -------------------------------------
    def _render(self, unit, runtime):
        try:
            rendered = _prepare_host().render_service(
                self.root, unit, runtime, sha=self.source_sha,
                artifact_root=(str(self.artifact_root)
                               if self.artifact_root is not None else None))
        except (ValueError, OSError, subprocess.CalledProcessError) as exc:
            self.refuse("production render refused: " + str(exc)[:300])
        if rendered.get("unit") != unit or rendered.get("runtime") != runtime:
            self.refuse("render identity does not match the request")
        if rendered.get("source_sha") != self.source_sha:
            self.refuse("render source does not match the pinned commit")
        if runtime != "python":
            artifact = rendered.get("artifact")
            if not isinstance(artifact, dict) \
                    or artifact.get("source_sha") != runtime[5:]:
                self.refuse("node artifact source does not match the pointer")
            if artifact.get("verification") != "whole-artifact-inventory-matched":
                self.refuse("node artifact integrity was not established")
            if artifact.get("authenticity") != "not-established":
                self.refuse("node artifact authenticity must not be claimed")
            exec_start = rendered.get("exec_start")
            if not isinstance(exec_start, str):
                self.refuse("rendered node ExecStart is absent")
            try:
                parts = shlex.split(exec_start)
            except ValueError as exc:
                self.refuse("rendered node ExecStart cannot be parsed: "
                            + str(exc)[:160])
            if len(parts) < 3 or Path(parts[0]).name != "env":
                self.refuse("rendered node ExecStart is not the expected shape")
            match = NODE_SCRIPT_RE.fullmatch(str(Path(parts[2])))
            if match is None:
                self.refuse("rendered node ExecStart is not the canonical "
                            "artifact pointer")
            canonical_root = Path(match.group("root"))
            verified_root = (self.artifact_root
                             if self.artifact_root is not None
                             else Path.home() / ".local/opt"
                             / ("crq-" + runtime[5:]))
            try:
                same_tree = (canonical_root.resolve()
                             == verified_root.resolve())
            except OSError:
                same_tree = False
            if not same_tree:
                self.refuse("verified node artifact tree is not the rendered "
                            "executable tree")
        return rendered

    def _check_python_entry(self, rendered):
        try:
            parts = shlex.split(rendered["exec_start"])
        except (KeyError, ValueError) as exc:
            self.refuse("python ExecStart cannot be parsed: " + str(exc)[:160])
        if len(parts) < 3 or Path(parts[0]).name != "env" \
                or Path(parts[1]).name != "python3":
            self.refuse("python ExecStart is not the declared interpreter shape")
        script = Path(parts[2])
        try:
            script.resolve().relative_to(
                (self.root / "apps/crq-python").resolve())
        except (OSError, ValueError):
            self.refuse("python ExecStart script escapes the deployment checkout")
        if not script.is_file():
            self.refuse("python ExecStart script is absent: " + str(script))

    def _runtime_from_unit(self, path):
        path = Path(path)
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
            self.refuse("installed unit ExecStart cannot be parsed: "
                        + str(exc)[:160])
        if len(parts) < 3 or Path(parts[0]).name != "env":
            self.refuse("installed unit ExecStart is not the expected shape")
        interpreter = Path(parts[1]).name
        script = Path(parts[2])
        if interpreter == "python3":
            try:
                script.resolve().relative_to(
                    (self.root / "apps/crq-python").resolve())
            except (OSError, ValueError):
                self.refuse("installed python script escapes the checkout")
            return "python"
        if interpreter == "node":
            match = NODE_SCRIPT_RE.fullmatch(str(script))
            if match is None:
                self.refuse("installed node pointer is not the canonical artifact")
            return "node:" + match.group("sha")
        self.refuse("installed unit interpreter is unsupported")

    def _observe_activators(self, unit, inventory):
        paths = self._unit_paths(unit, inventory)
        observed = {}
        service = self._show(inventory[unit]["service"],
                             ["LoadState", "ActiveState", "UnitFileState",
                              "FragmentPath"])
        if service["LoadState"] != "loaded" \
                or service["FragmentPath"] != str(paths["service"]):
            self.refuse("installed service is not loaded from the expected path")
        if service["ActiveState"] not in RESTORABLE_ACTIVE:
            self.refuse("service active state is not restorable: "
                        + service["ActiveState"])
        observed["service_active"] = service["ActiveState"]
        for role, name in self._activator_units(unit, inventory):
            props = self._show(name, ["LoadState", "ActiveState",
                                      "UnitFileState", "FragmentPath"])
            if props["LoadState"] != "loaded" \
                    or props["FragmentPath"] != str(paths[role]):
                self.refuse(role + " activator is not loaded from the "
                            "expected path")
            if props["ActiveState"] not in RESTORABLE_ACTIVE:
                self.refuse(role + " activator active state is not restorable: "
                            + props["ActiveState"])
            if props["UnitFileState"] not in UNIT_FILE_STATES:
                self.refuse(role + " activator enablement state is unknown")
            if role == "timer":
                timer_state = self._path_state(paths[role])
                self._validate_state_shape(paths[role], timer_state)
                if timer_state["type"] != "file":
                    self.refuse("installed timer is not a regular file")
                try:
                    timer_bytes = paths[role].read_bytes()
                except OSError as exc:
                    self.refuse("installed timer is unreadable: "
                                + str(exc)[:160])
                if (_sha256_bytes(timer_bytes)
                        != inventory[unit]["timer_sha256"]):
                    self.refuse("installed timer does not match the pinned "
                                "schedule")
            observed[role + "_active"] = props["ActiveState"]
            observed[role + "_unit_file_state"] = props["UnitFileState"]
        return observed

    # -- seam: preflight -------------------------------------------------
    def preflight(self, unit, runtime):
        self._validate_unit(unit)
        self._validate_runtime(runtime)
        self._snapshot_unit = unit
        inventory = self._inventory()
        self._validate_layout(unit, inventory)
        paths = self._unit_paths(unit, inventory)
        self._installed_entries(unit, inventory)
        discovery = self._discover(unit, inventory, paths)
        service_state = self._path_state(paths["service"])
        self._validate_state_shape(paths["service"], service_state)
        if service_state["type"] != "file":
            self.refuse("prior installed service is not a regular file")
        prior = self._runtime_from_unit(paths["service"])
        if prior == runtime:
            self.refuse("unit already selects requested runtime")
        observed = self._observe_activators(unit, inventory)
        completion_window = self._completion_budget(unit, inventory, observed)
        try:
            commands = self.capability.commands(runtime)
        except Exception as exc:
            self.refuse("runtime capability observation failed: "
                        + (str(exc) or type(exc).__name__)[:200])
        if not isinstance(commands, (set, frozenset)):
            self.refuse("runtime command capability is not declared")
        command = _prepare_host().UNIT_COMMANDS[unit]
        if command not in commands:
            self.refuse("runtime does not implement the unit command: " + command)
        rendered = self._render(unit, runtime)
        if runtime == "python":
            self._check_python_entry(rendered)
        self._rendered[(unit, runtime)] = rendered
        if self.queue_drain is None:
            self.refuse("no recorded queue drain observation provider")
        sequence = self.sequence(unit)
        self._requested_runtime = runtime
        return {
            "runtime": prior,
            "inventory": inventory,
            "activators": observed,
            "capability": {"runtime": runtime, "command": command,
                           "commands": sorted(commands)},
            "render": {"source_sha": rendered["source_sha"],
                       "template_blob_oid": rendered["template_blob_oid"],
                       "sha256": rendered["sha256"]},
            "completion_sequence": sequence,
            "completion_window": completion_window,
            "discovery": {"scope": "declared-template-paths",
                          "exhaustive": False,
                          "complete": discovery["complete"]},
        }

    def _completion_budget(self, unit, inventory, observed):
        """Derive a completion bound from the declared timer topology.

        The controller requires two strictly advancing completions after one
        ``start``. The first is produced by the started service; the second is
        produced by the restored timer. An inactive timer cannot produce it
        without spawning unrecorded work, and a schedule whose worst-case
        interval exceeds the supported maximum is refused before mutation.
        """
        timer = inventory[unit]["timer"]
        if timer is None:
            self.refuse("unit has no declared timer activator")
        if observed.get("timer_active") != "active":
            self.refuse("prior timer activator is inactive; no bounded second "
                        "invocation is available")
        bound = inventory[unit]["timer_bound_seconds"]
        if type(bound) is not int or bound <= 0:
            self.refuse("declared timer schedule has no bounded repeat interval")
        if inventory[unit]["service_type"] == "simple":
            self.refuse("simple service completion has no declared execution "
                        "bound; preflight refuses this topology")
        service_timeout = inventory[unit]["service_timeout_seconds"]
        if type(service_timeout) is not int or service_timeout <= 0:
            self.refuse("declared service start timeout is not bounded")
        required = float(service_timeout + bound + COMPLETION_MARGIN_SECONDS)
        if required > self.max_completion_window:
            self.refuse(
                "declared completion bound %.0fs exceeds the supported "
                "maximum %.0fs; no switch was attempted"
                % (required, self.max_completion_window))
        if self.completion_timeout < required:
            self.refuse(
                "completion deadline %.0fs is below the declared bound %.0fs; "
                "no switch was attempted"
                % (self.completion_timeout, required))
        self._completion_window = required
        return required

    def _service_start_timeout(self, unit, inventory):
        declared = inventory[unit]["service_timeout_seconds"]
        if type(declared) is int and declared > 0:
            return declared + COMPLETION_MARGIN_SECONDS
        return 60

    # -- seam: snapshot and validation ----------------------------------
    def snapshot(self, unit):
        self._validate_unit(unit)
        inventory = self._inventory()
        self._validate_layout(unit, inventory)
        paths = self._unit_paths(unit, inventory)
        self._installed_entries(unit, inventory)
        self._discover(unit, inventory, paths)
        self._snapshot_unit = unit
        path_states = {}
        for path in paths.values():
            state = self._path_state(path)
            self._validate_state_shape(path, state)
            path_states[str(path)] = state
        activators = self._observe_activators(unit, inventory)
        snapshot = {
            "schema_version": SCHEMA_VERSION,
            "unit": unit,
            "runtime": self._runtime_from_unit(paths["service"]),
            "paths": path_states,
            "activators": activators,
        }
        self._snapshot = snapshot
        return snapshot

    def validate_snapshot(self, unit, snapshot):
        self._validate_unit(unit)
        inventory = self._inventory()
        self._validate_layout(unit, inventory)
        paths = self._unit_paths(unit, inventory)
        if not isinstance(snapshot, dict) or set(snapshot) != {
                "schema_version", "unit", "runtime", "paths", "activators"}:
            self.refuse("snapshot does not match the guest payload contract")
        if type(snapshot["schema_version"]) is not int \
                or snapshot["schema_version"] != SCHEMA_VERSION:
            self.refuse("snapshot schema version is unsupported")
        if snapshot["unit"] != unit or not _valid_runtime(snapshot["runtime"]):
            self.refuse("snapshot unit or runtime is invalid")
        observed_paths = snapshot["paths"]
        if not isinstance(observed_paths, dict) \
                or set(observed_paths) != {str(path) for path in paths.values()}:
            self.refuse("snapshot does not name the exact owned paths")
        self._snapshot_unit = unit
        for path in paths.values():
            self._validate_path_allowed(path, paths)
            self._validate_state_shape(path, observed_paths[str(path)])
        if observed_paths[str(paths["service"])]["type"] != "file":
            self.refuse("snapshot service must be a regular file")
        if observed_paths[str(paths["timer"])]["type"] != "file":
            self.refuse("snapshot timer must be a regular file")
        if "timer_wants" in paths:
            if observed_paths[str(paths["timer_wants"])]["type"] \
                    not in ("symlink", "missing"):
                self.refuse("snapshot timer enablement has an unsupported type")
        if "path" in paths:
            if observed_paths[str(paths["path"])]["type"] != "file":
                self.refuse("snapshot path unit must be a regular file")
        if "path_wants" in paths:
            if observed_paths[str(paths["path_wants"])]["type"] \
                    not in ("symlink", "missing"):
                self.refuse("snapshot path enablement has an unsupported type")
        activators = snapshot["activators"]
        expected = {"timer_active", "timer_unit_file_state", "service_active"}
        if "path" in paths:
            expected |= {"path_active", "path_unit_file_state"}
        if not isinstance(activators, dict) or set(activators) != expected:
            self.refuse("snapshot activator observation is incomplete")
        if activators["timer_active"] not in RESTORABLE_ACTIVE \
                or activators["service_active"] not in RESTORABLE_ACTIVE:
            self.refuse("snapshot activator state is not restorable")
        if activators["timer_unit_file_state"] not in UNIT_FILE_STATES:
            self.refuse("snapshot timer enablement is unknown")
        if "path" in paths:
            if activators["path_active"] not in RESTORABLE_ACTIVE:
                self.refuse("snapshot path activator state is not restorable")
            if activators["path_unit_file_state"] not in UNIT_FILE_STATES:
                self.refuse("snapshot path enablement is unknown")
        self._snapshot = snapshot

    def _snapshot_required(self):
        if self._snapshot is None:
            self.refuse("adapter has no validated snapshot")
        return self._snapshot

    # -- seam: fence and drain ------------------------------------------
    def _usable_current_service(self, path):
        state = self._path_state(path)
        if state["type"] not in ("file", "symlink"):
            self.refuse("service path is neither a regular file nor a mask symlink")
        if state["uid"] != self.identity.uid or state["gid"] != self.identity.gid:
            self.refuse("service path ownership is not the adapter identity")
        if state["xattrs"]:
            self.refuse("service path has unsupported extended attributes")
        if state["type"] == "file":
            if state["mode"] & 0o7000 or state["mode"] & 0o022:
                self.refuse("service file mode is unsafe to fence")
        elif state["target"] != "/dev/null":
            self.refuse("service path is an unexpected symlink")
        return state

    def _wait_drain(self, unit, inventory):
        deadline = self.clock() + self.drain_timeout
        names = [inventory[unit]["service"]]
        names.extend(name for _role, name
                     in self._activator_units(unit, inventory))
        attempts = 0
        while True:
            attempts += 1
            jobs = self._jobs()
            matching = [line for line in jobs if any(
                re.search(r"(?:^|\s)" + re.escape(name) + r"(?:\s|$)", line)
                for name in names)]
            owned = self._cgroup(inventory[unit]["service"])
            state = self._show(inventory[unit]["service"],
                               ["ActiveState", "SubState", "LoadState"])
            activators = {name: self._show(name, ["ActiveState", "LoadState"])
                          for name in names[1:]}
            if (not matching and not owned["pids"] and owned["main_pid"] == 0
                    and state["ActiveState"] == "inactive"
                    and all(item["ActiveState"] in ("inactive", "failed")
                            for item in activators.values())):
                return {"jobs": matching, "owned": owned, "state": state,
                        "activators": activators, "attempts": attempts}
            if self.clock() >= deadline:
                if matching:
                    self.refuse("queued or running systemd job remains: "
                                + json.dumps(matching, sort_keys=True)[:400])
                if owned["pids"] or owned["main_pid"] > 0:
                    self.refuse("owned process remains: "
                                + json.dumps(owned, sort_keys=True)[:400])
                if state["ActiveState"] != "inactive":
                    self.refuse("service remains active: "
                                + str(state["ActiveState"]))
                active = sorted(name for name, item in activators.items()
                                if item["ActiveState"]
                                not in ("inactive", "failed"))
                if active:
                    self.refuse("activator remains active: "
                                + ", ".join(active))
                self.refuse("drain did not establish absence within the bound")
            self.sleep(0.25)

    def stop_and_drain(self, unit):
        self._validate_unit(unit)
        snapshot = self._snapshot_required()
        if snapshot["unit"] != unit:
            self.refuse("snapshot unit does not match the drain request")
        inventory = self._inventory()
        self._validate_layout(unit, inventory)
        paths = self._unit_paths(unit, inventory)
        self._installed_entries(unit, inventory)
        self._discover(unit, inventory, paths)
        self._usable_current_service(paths["service"])
        expected = snapshot["paths"][str(paths["service"])]
        actual = self._path_state(paths["service"])
        if actual["type"] == "file":
            if self._requested_runtime is not None:
                current_runtime = self._runtime_from_unit(paths["service"])
                if current_runtime == snapshot["runtime"]:
                    self._compare_state(paths["service"], expected,
                                        "service file")
                elif current_runtime == self._requested_runtime:
                    rendered = self._rendered.get(
                        (unit, self._requested_runtime))
                    if rendered is None:
                        self.refuse("released service has no verified render")
                    try:
                        released = paths["service"].read_bytes()
                    except OSError as exc:
                        self.refuse("released service is unreadable: "
                                    + str(exc)[:160])
                    if released != rendered["bytes"]:
                        self.refuse("released service bytes do not match the "
                                    "verified render")
                else:
                    self.refuse("service runtime is neither the snapshot nor "
                                "the requested runtime")
        elif actual["type"] != "symlink" or actual.get("target") != "/dev/null":
            self.refuse("service path is neither the snapshot file nor a mask")
        for _role, name in self._activator_units(unit, inventory):
            result = self._run("stop", name, timeout=60)
            if result.get("timeout") or result.get("rc") not in (0, 5):
                self.refuse("activator stop did not complete: " + name)
            result = self._run("reset-failed", name, timeout=60)
            if result.get("timeout") or result.get("rc") not in (0, 5):
                self.refuse("activator reset-failed did not complete: " + name)
            observed = self._show(name, ["ActiveState", "LoadState"])
            if observed["ActiveState"] not in ("inactive", "failed"):
                self.refuse("activator is still active during fence: " + name)
        service = paths["service"]
        state = self._path_state(service)
        if not (state["type"] == "symlink" and state["target"] == "/dev/null"):
            if state["type"] != "file":
                self.refuse("service path is neither a regular file nor a mask")
            temporary = service.with_name("." + service.name + ".mask")
            temporary.unlink(missing_ok=True)
            temporary.symlink_to("/dev/null")
            os.replace(temporary, service)
            self._fsync_dir(service.parent)
        self._ok(self._run("daemon-reload", timeout=60),
                 "daemon reload after mask")
        masked = self._show(unit, ["LoadState", "FragmentPath"])
        if masked["LoadState"] != "masked" \
                or masked["FragmentPath"] != str(service):
            self.refuse("durable service replacement did not reach masked state")
        refusal = self._run("start", unit, timeout=60)
        if refusal.get("rc") == 0:
            self.refuse("masked service still accepted a direct start")
        text = ((refusal.get("stdout") or "")
                + (refusal.get("stderr") or "")).lower()
        if "masked" not in text:
            self.refuse("direct start failed for an unknown reason while fenced")
        result = self._run("stop", unit, timeout=60)
        if result.get("timeout") or result.get("rc") not in (0, 5):
            self.refuse("service stop did not complete during fence")
        self._run("reset-failed", unit, timeout=60)
        drained = self._wait_drain(unit, inventory)
        queue = self._observe_queue()
        if not queue["drained"]:
            self.refuse("queue-owned work is alive or ambiguous after the "
                        "systemd fence: "
                        + json.dumps(queue["blocked"], sort_keys=True)[:400])
        masked = self._show(unit, ["LoadState", "FragmentPath"])
        state = self._path_state(service)
        if masked["LoadState"] != "masked" \
                or masked["FragmentPath"] != str(service) \
                or state["type"] != "symlink" or state["target"] != "/dev/null":
            self.refuse("durable service mask did not persist through the drain")
        self.last_drain = {"masked": masked, "service": state, **drained,
                           "queue": queue}
        return self.last_drain

    # -- seam: completion sequence and install --------------------------
    def sequence(self, unit):
        self._validate_unit(unit)
        if self._completion_port is None:
            self.refuse("no runtime-bound completion provider")
        try:
            value = self._completion_port.sequence(unit)
        except Exception as exc:
            self.refuse("completion sequence failed: "
                        + (str(exc) or type(exc).__name__)[:200])
        if type(value) is not int or value < 0:
            self.refuse("completion provider returned an invalid sequence")
        return value

    def install(self, unit, runtime):
        self._validate_unit(unit)
        self._validate_runtime(runtime)
        snapshot = self._snapshot_required()
        inventory = self._inventory()
        self._validate_layout(unit, inventory)
        paths = self._unit_paths(unit, inventory)
        service = paths["service"]
        self._installed_entries(unit, inventory)
        self._discover(unit, inventory, paths)
        rendered = self._render(unit, runtime)
        cached = self._rendered.get((unit, runtime))
        if not isinstance(cached, dict):
            self.refuse("install requires a render established by preflight")
        for key in ("source_sha", "template_blob_oid", "sha256"):
            if rendered[key] != cached[key]:
                self.refuse("render changed between preflight and install: " + key)
        masked = self._show(unit, ["LoadState", "FragmentPath"])
        if masked["LoadState"] != "masked" \
                or masked["FragmentPath"] != str(service):
            self.refuse("install requires an established durable service mask")
        fenced = self._path_state(service)
        if fenced["type"] != "symlink" or fenced["target"] != "/dev/null":
            self.refuse("install requires the durable /dev/null service fence")
        for key, path in paths.items():
            if key == "service":
                continue
            if self._path_state(path) != snapshot["paths"][str(path)]:
                self.refuse("activator path changed during the fenced "
                            "interval: " + key)
        mode = snapshot["paths"][str(service)]["mode"]
        if mode & 0o7000 or mode & 0o022:
            self.refuse("prior service mode is unsafe for the staged unit")
        staged = service.with_name("." + service.name + ".staged")
        self._write_bytes(staged, rendered["bytes"])
        self._apply_mode_owner(staged, mode, self.identity.uid, self.identity.gid)
        self._fsync_dir(staged.parent)
        state = self._path_state(staged)
        if state["type"] != "file" or state["mode"] != mode \
                or state["uid"] != self.identity.uid \
                or state["gid"] != self.identity.gid \
                or state["xattrs"] != [] \
                or state["sha256"] != rendered["sha256"] \
                or state["size"] != len(rendered["bytes"]):
            self.refuse("staged unit metadata does not match the rendered unit")
        if self._runtime_from_unit(staged) != runtime:
            self.refuse("staged unit runtime marker does not match the request")
        fenced = self._path_state(service)
        if fenced["type"] != "symlink" or fenced["target"] != "/dev/null":
            self.refuse("install released the durable service fence")
        masked = self._show(unit, ["LoadState", "FragmentPath"])
        if masked["LoadState"] != "masked" \
                or masked["FragmentPath"] != str(service):
            self.refuse("staged install changed the masked service state")
        for key, path in paths.items():
            if key == "service":
                continue
            if self._path_state(path) != snapshot["paths"][str(path)]:
                self.refuse("install changed an activator path: " + key)
        self._install = {
            "unit": unit, "runtime": runtime, "staged": str(staged),
            "sha256": rendered["sha256"], "size": len(rendered["bytes"]),
            "source_sha": rendered["source_sha"],
            "template_blob_oid": rendered["template_blob_oid"],
            "mode": mode,
        }
        return self._install

    def _install_required(self):
        if self._install is None:
            self.refuse("adapter has no staged install")
        return self._install

    def start(self, unit):
        self._validate_unit(unit)
        install = self._install_required()
        if install["unit"] != unit:
            self.refuse("staged install names another unit")
        snapshot = self._snapshot_required()
        inventory = self._inventory()
        self._validate_layout(unit, inventory)
        paths = self._unit_paths(unit, inventory)
        service = paths["service"]
        staged = Path(install["staged"])
        self._installed_entries(unit, inventory)
        self._discover(unit, inventory, paths)
        masked = self._show(unit, ["LoadState", "FragmentPath"])
        if masked["LoadState"] != "masked" \
                or masked["FragmentPath"] != str(service):
            self.refuse("start requires the service to remain masked")
        fenced = self._path_state(service)
        if fenced["type"] != "symlink" or fenced["target"] != "/dev/null":
            self.refuse("start requires the durable /dev/null service fence")
        staged_state = self._path_state(staged)
        if staged_state["type"] != "file" \
                or staged_state["mode"] != install["mode"] \
                or staged_state["uid"] != self.identity.uid \
                or staged_state["gid"] != self.identity.gid \
                or staged_state["xattrs"] != [] \
                or staged_state["sha256"] != install["sha256"] \
                or staged_state["size"] != install["size"] \
                or self._runtime_from_unit(staged) != install["runtime"]:
            self.refuse("staged target changed before release")
        os.replace(staged, service)
        self._fsync_dir(service.parent)
        self._ok(self._run("daemon-reload", timeout=60),
                 "daemon reload after release")
        loaded = self._show(unit, ["LoadState", "FragmentPath"])
        if loaded["LoadState"] != "loaded" \
                or loaded["FragmentPath"] != str(service):
            self.refuse("released unit did not load from the expected path")
        released = self._path_state(service)
        if released["type"] != "file" \
                or released["mode"] != install["mode"] \
                or released["uid"] != self.identity.uid \
                or released["gid"] != self.identity.gid \
                or released["xattrs"] != [] \
                or released["sha256"] != install["sha256"] \
                or released["size"] != install["size"] \
                or self._runtime_from_unit(service) != install["runtime"]:
            self.refuse("released unit metadata does not match the staged target")
        self._ok(self._run(
            "start", unit, timeout=self._service_start_timeout(unit, inventory)),
            "service release")
        release_order = ["service"]
        for role, name in self._activator_units(unit, inventory):
            desired = snapshot["activators"][role + "_active"]
            if desired == "active":
                self._ok(self._run("start", name, timeout=60),
                         role + " activator release")
            elif desired == "inactive":
                result = self._run("stop", name, timeout=60)
                if result.get("timeout") or result.get("rc") not in (0, 5):
                    self.refuse(role + " activator stop did not complete")
                self._run("reset-failed", name, timeout=60)
            else:
                self.refuse(role + " activator desired state is unsupported")
            observed = self._show(name, ["ActiveState", "UnitFileState",
                                         "LoadState"])
            expected = ("active",) if desired == "active" \
                else ("inactive", "failed")
            if observed["ActiveState"] not in expected:
                self.refuse(role + " activator release state does not match "
                            "the snapshot policy")
            if observed["UnitFileState"] != snapshot["activators"][
                    role + "_unit_file_state"]:
                self.refuse(role + " activator enablement changed during release")
            release_order.append(role)
        self.last_release_order = release_order
        return {"service_start": True, "release_order": release_order}

    def completion(self, unit, runtime, previous):
        self._validate_unit(unit)
        self._validate_runtime(runtime)
        if self._completion_port is None:
            self.refuse("no runtime-bound completion provider")
        if self._completion_window is None:
            self.refuse("completion budget was not established by preflight")
        if type(previous) is not int or previous < 0:
            self.refuse("invalid completion sequence")
        inventory = self._inventory()
        service = self._unit_paths(unit, inventory)["service"]
        deadline = self.clock() + self._completion_window
        while True:
            try:
                evidence = self._completion_port.read(unit, runtime, previous)
            except Exception as exc:
                self.refuse("completion provider failed: "
                            + (str(exc) or type(exc).__name__)[:200])
            if evidence is not None:
                if not isinstance(evidence, dict):
                    self.refuse("completion evidence is not an object")
                if evidence.get("unit") != unit \
                        or evidence.get("runtime") != runtime \
                        or evidence.get("success") is not True:
                    self.refuse("completion evidence does not bind the unit "
                                "and runtime")
                if type(evidence.get("sequence")) is not int \
                        or evidence["sequence"] <= previous:
                    self.refuse("completion sequence is not advancing")
                invocation = evidence.get("invocation")
                if not isinstance(invocation, str) or not invocation \
                        or invocation in self._returned_invocations:
                    self.refuse("completion invocation is not distinct")
                service_sha = evidence.get("service_sha256")
                if not isinstance(service_sha, str) \
                        or HEX64_RE.fullmatch(service_sha) is None:
                    self.refuse("completion evidence does not bind the "
                                "installed file identity")
                try:
                    actual = _sha256_bytes(service.read_bytes())
                except OSError as exc:
                    self.refuse("installed service is unreadable: "
                                + str(exc)[:160])
                if service_sha != actual:
                    self.refuse("completion evidence names another installed file")
                if self._runtime_from_unit(service) != runtime:
                    self.refuse("installed unit changed before completion evidence")
                self._returned_invocations.add(invocation)
                return evidence
            if self.clock() >= deadline:
                self.refuse("no advancing completion arrived within the bound")
            self.sleep(0.25)

    # -- restore ---------------------------------------------------------
    def _compare_state(self, path, expected, what="restored path"):
        actual = self._path_state(path)
        keys = {"type"}
        if expected["type"] == "file":
            keys |= {"mode", "uid", "gid", "sha256", "size", "xattrs"}
        elif expected["type"] == "symlink":
            keys |= {"mode", "uid", "gid", "target", "xattrs"}
        mismatched = sorted(key for key in keys
                            if actual.get(key) != expected.get(key))
        if mismatched:
            self.refuse(what + " does not match its snapshot: "
                        + str(path) + " (" + ", ".join(mismatched) + ")")

    def _restore_path(self, path, state):
        path = Path(path)
        if state["type"] == "missing":
            if path.is_symlink() or path.exists():
                path.unlink()
                self._fsync_dir(path.parent)
            return
        if state["type"] == "file":
            data = base64.b64decode(state["bytes_b64"].encode("ascii"),
                                    validate=True)
            self._write_bytes(path, data)
            self._apply_mode_owner(path, state["mode"],
                                   state["uid"], state["gid"])
            return
        if state["type"] == "symlink":
            if path.is_symlink() or path.exists():
                path.unlink()
            path.symlink_to(state["target"])
            self._apply_mode_owner(path, state["mode"],
                                   state["uid"], state["gid"], symlink=True)
            self._fsync_dir(path.parent)
            return
        self.refuse("unsupported restore state")

    def restore(self, unit, snapshot):
        self.validate_snapshot(unit, snapshot)
        inventory = self._inventory()
        self._validate_layout(unit, inventory)
        paths = self._unit_paths(unit, inventory)
        service = paths["service"]
        staged = service.with_name("." + service.name + ".staged")
        self._installed_entries(unit, inventory)
        self._discover(unit, inventory, paths)
        for _role, name in self._activator_units(unit, inventory):
            result = self._run("stop", name, timeout=60)
            if result.get("timeout") or result.get("rc") not in (0, 5):
                self.refuse("restore activator stop did not complete: " + name)
            self._run("reset-failed", name, timeout=60)
        masked = self._show(unit, ["LoadState", "FragmentPath"])
        fenced = self._path_state(service)
        if masked["LoadState"] != "masked" \
                or masked["FragmentPath"] != str(service) \
                or fenced["type"] != "symlink" \
                or fenced["target"] != "/dev/null":
            self.refuse("restore requires the durable service mask")
        staged.unlink(missing_ok=True)
        self._fsync_dir(service.parent)
        for key, path in paths.items():
            if key == "service":
                continue
            self._restore_path(path, snapshot["paths"][str(path)])
        self._restore_path(staged, snapshot["paths"][str(service)])
        self._ok(self._run("daemon-reload", timeout=60),
                 "daemon reload after restore")
        for key, path in paths.items():
            if key == "service":
                continue
            self._compare_state(path, snapshot["paths"][str(path)])
        self._compare_state(staged, snapshot["paths"][str(service)])
        masked = self._show(unit, ["LoadState", "FragmentPath"])
        if masked["LoadState"] != "masked" \
                or masked["FragmentPath"] != str(service):
            self.refuse("restore must keep the service masked until activation")
        if self._runtime_from_unit(staged) != snapshot["runtime"]:
            self.refuse("staged restore runtime does not match the snapshot")
        service_state = snapshot["paths"][str(service)]
        self._restore = {"unit": unit, "staged": str(staged),
                         "sha256": service_state["sha256"],
                         "size": service_state["size"],
                         "runtime": snapshot["runtime"]}
        return self._restore

    def _restore_required(self):
        if self._restore is None:
            self.refuse("adapter has no staged restore")
        return self._restore

    def restore_activation(self, unit, snapshot):
        self.validate_snapshot(unit, snapshot)
        restore = self._restore_required()
        if restore["unit"] != unit:
            self.refuse("staged restore names another unit")
        inventory = self._inventory()
        self._validate_layout(unit, inventory)
        paths = self._unit_paths(unit, inventory)
        service = paths["service"]
        staged = Path(restore["staged"])
        service_state = snapshot["paths"][str(service)]
        self._installed_entries(unit, inventory)
        self._discover(unit, inventory, paths)
        self._compare_state(staged, service_state)
        if self._runtime_from_unit(staged) != snapshot["runtime"]:
            self.refuse("staged restore runtime changed before activation")
        masked = self._show(unit, ["LoadState", "FragmentPath"])
        fenced = self._path_state(service)
        if masked["LoadState"] != "masked" \
                or masked["FragmentPath"] != str(service) \
                or fenced["type"] != "symlink" \
                or fenced["target"] != "/dev/null":
            self.refuse("restore activation requires the durable service mask")
        os.replace(staged, service)
        self._fsync_dir(service.parent)
        self._ok(self._run("daemon-reload", timeout=60),
                 "daemon reload after restore release")
        loaded = self._show(unit, ["LoadState", "FragmentPath"])
        if loaded["LoadState"] != "loaded" \
                or loaded["FragmentPath"] != str(service):
            self.refuse("restored service did not load from the expected path")
        self._compare_state(service, service_state)
        if self._runtime_from_unit(service) != snapshot["runtime"]:
            self.refuse("restored service runtime does not match the snapshot")
        restore_order = []
        desired_service = snapshot["activators"]["service_active"]
        if desired_service == "active":
            self._ok(
                self._run("start", unit,
                          timeout=self._service_start_timeout(unit, inventory)),
                "restore service activation")
        elif desired_service == "inactive":
            result = self._run("stop", unit, timeout=60)
            if result.get("timeout") or result.get("rc") not in (0, 5):
                self.refuse("restore service stop did not complete")
            self._run("reset-failed", unit, timeout=60)
        else:
            self.refuse("snapshot service active state is unsupported")
        service_observed = self._show(unit, ["ActiveState", "LoadState"])
        if desired_service == "active":
            if service_observed["LoadState"] != "loaded":
                self.refuse("restored service did not remain loaded")
            if service_observed["ActiveState"] == "failed":
                self.refuse("restored service is failed")
            if inventory[unit]["service_type"] == "simple":
                if service_observed["ActiveState"] != "active":
                    self.refuse("restored simple service is not active: "
                                + str(service_observed["ActiveState"]))
            elif service_observed["ActiveState"] not in ("active", "inactive"):
                self.refuse("restored service active state is not a running "
                            "or completed state: "
                            + str(service_observed["ActiveState"]))
        elif service_observed["ActiveState"] not in ("inactive", "failed"):
            self.refuse("restored service active state does not match the snapshot")
        restore_order.append("service")
        for role, name in self._activator_units(unit, inventory):
            desired = snapshot["activators"][role + "_active"]
            desired_enabled = snapshot["activators"][role + "_unit_file_state"]
            if desired == "active":
                self._ok(self._run("start", name, timeout=60),
                         "restore " + role + " activation")
            elif desired == "inactive":
                result = self._run("stop", name, timeout=60)
                if result.get("timeout") or result.get("rc") not in (0, 5):
                    self.refuse("restore " + role + " stop did not complete")
                self._run("reset-failed", name, timeout=60)
            else:
                self.refuse(role + " snapshot active state is unsupported")
            observed = self._show(name, ["ActiveState", "UnitFileState",
                                         "LoadState"])
            if observed["ActiveState"] != desired:
                self.refuse("restored " + role
                            + " active state does not match the snapshot")
            if observed["UnitFileState"] != desired_enabled:
                self.refuse("restored " + role
                            + " enablement does not match the snapshot")
            restore_order.append(role)
        self.last_restore_order = restore_order
        return {"service": service_observed, "restore_order": restore_order}

    # -- small filesystem effects ---------------------------------------
    def _fsync_dir(self, path):
        handle = os.open(str(path), os.O_RDONLY)
        try:
            os.fsync(handle)
        finally:
            os.close(handle)

    def _write_bytes(self, path, data):
        path = Path(path)
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
            Path(temporary).unlink(missing_ok=True)

    def _apply_mode_owner(self, path, mode, uid, gid, *, symlink=False):
        path = Path(path)
        if not symlink:
            os.chmod(path, mode)
        if uid != os.getuid() or gid != os.getgid():
            try:
                os.chown(path, uid, gid, follow_symlinks=not symlink)
            except OSError as exc:
                self.refuse("cannot restore ownership for " + str(path) + ": "
                            + str(exc)[:160])
        if not symlink:
            handle = os.open(str(path), os.O_RDONLY)
            try:
                os.fsync(handle)
            finally:
                os.close(handle)
        self._fsync_dir(path.parent)
