#!/usr/bin/env python3
"""Unwired live host binding for one per-unit switch transaction.

This module is the mechanical host side of the composition in
``unit-switch-factory.py``. It is deliberately not a CLI, not imported by
``deploy-controller.py`` at import time, and not a production enablement path.
The controller loads it lazily only for ``switch --unit --runtime`` so a
checkout or release switch never depends on host observation:

* ``SubprocessSystemd`` implements the adapter's injected ``SystemdPort`` with
  bounded, read-only commands. Its command runner can be injected for tests.
* ``ProcessIdentity`` implements the adapter's ``IdentityPort`` from the
  current process and real extended attributes.
* ``HostLayout`` binds the deployment root and record directory to the existing
  private overlay validation and observes the existing controller lock inode.
  It never creates a lock or a second store.
* ``production_adapter`` composes the real renderer, adapter, journal source
  and queue drain. It does not call the controller; the controller CLI supplies
  the already-loaded overlay and the bound effects record directory.

Discovery is scoped and truthful. ``complete`` is true only when every
required filesystem and manager observation succeeded. ``supported`` is true
only when the observed topology is within the declared shapes: no foreign
prefix entries, enablement links, drop-ins, dependency references, or
unexpected manager units. The examined scope is the user unit directory plus
the user manager's installed and loaded lists. A non-CRQ unit that names a CRQ
unit only in memory, transient or generated state, another namespace, or an
activation created between the scan and the fence is outside this scope and
is not claimed by ``supported``. Production enablement still requires actual
topology evidence; the module stays unwired until then.
"""
from __future__ import annotations

import errno
import importlib.util
import math
import os
import re
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

OPS = Path(__file__).resolve().parent


def _load(name, path):
    module = sys.modules.get(name)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


host = _load("crq_unit_live_binding_host", OPS / "prepare-host.py")
dc = _load("crq_unit_live_binding_controller", OPS / "deploy-controller.py")
completion = _load("crq_unit_live_binding_completion",
                   OPS / "unit-completion.py")
factory = _load("crq_unit_live_binding_factory", OPS / "unit-switch-factory.py")

MAX_UNIT_ENTRIES = 4096
MAX_SCAN_ENTRIES = 512
MAX_UNIT_BYTES = 1 << 20
MAX_PIDS = 4096
ARG_RE = re.compile(r"[A-Za-z0-9_.@:/-]+")
PROPERTY_RE = re.compile(r"[A-Za-z][A-Za-z0-9]*")
PID_RE = re.compile(r"[0-9]+")
CRQ_NAME_RE = re.compile(r"crq-[A-Za-z0-9_.@:-]+")
DEPENDENCY_RE = re.compile(
    r"(?P<directive>Wants|Requires|Requisite|BindsTo|PartOf|Conflicts|"
    r"WantedBy|RequiredBy|Also|Upholds|OnFailure|OnSuccess|Triggers|"
    r"TriggersBy|Unit)\s*=\s*(?P<value>.*)")
UNIT_SUFFIXES = {".service", ".timer", ".path"}


class LiveBindingRefused(RuntimeError):
    """The live binding cannot establish a safe host observation."""


def _text(value: bytes, what: str) -> str:
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise LiveBindingRefused(what + " is not valid UTF-8") from exc


def _read_file(path: Path, *, max_bytes: int) -> bytes:
    try:
        with path.open("rb") as handle:
            data = handle.read(max_bytes + 1)
    except OSError as exc:
        raise LiveBindingRefused(
            "cannot read " + str(path) + ": " + str(exc)[:160]) from exc
    if len(data) > max_bytes:
        raise LiveBindingRefused("file exceeds the byte bound: " + str(path))
    return data


def _controller_module(effects):
    """Return the loaded controller module that owns ``effects`` when possible.

    Loading ``deploy-controller.py`` here creates a second module object when a
    caller imported it under another name. The adapter's ``error_type`` and
    queue drain must come from the caller's module so a raised refusal keeps
    its identity at the controller seam.
    """
    module = sys.modules.get(type(effects).__module__)
    if module is not None and hasattr(module, "Refused") \
            and hasattr(module, "runner_queue_drain"):
        return module
    for candidate in list(sys.modules.values()):
        for owner in (candidate, getattr(candidate, "dc", None)):
            if owner is not None and getattr(owner, "Effects", None) is type(effects) \
                    and hasattr(owner, "Refused") \
                    and hasattr(owner, "runner_queue_drain"):
                return owner
    return dc


class SubprocessSystemd:
    """Live ``SystemdPort`` over bounded ``systemctl --user`` commands."""

    def __init__(self, *, user=True, systemctl="systemctl", unit_dir=None,
                 cgroup_root=Path("/sys/fs/cgroup"), runner=None,
                 timeout=60.0, max_bytes=256 * 1024):
        if not isinstance(systemctl, str) or not systemctl or any(
                char.isspace() for char in systemctl):
            raise LiveBindingRefused("systemctl path is invalid")
        self.user = bool(user)
        self.systemctl = systemctl
        self.unit_dir = Path(unit_dir) if unit_dir is not None else None
        self.cgroup_root = Path(cgroup_root)
        self.runner = runner
        if runner is not None and not callable(runner):
            raise LiveBindingRefused("systemd runner is not callable")
        self.timeout = self._duration(timeout)
        self.max_bytes = int(max_bytes)
        if self.max_bytes <= 0:
            raise LiveBindingRefused("systemd byte bound must be positive")

    @staticmethod
    def _duration(value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise LiveBindingRefused("timeout must be a finite positive number")
        try:
            number = float(value)
        except OverflowError as exc:
            raise LiveBindingRefused(
                "timeout must be a finite positive number") from exc
        if not math.isfinite(number) or number <= 0:
            raise LiveBindingRefused("timeout must be a finite positive number")
        return number

    def _unit(self, unit):
        if not isinstance(unit, str) or completion.UNIT_RE.fullmatch(unit) is None:
            raise LiveBindingRefused("invalid unit name")

    def _execute(self, command, *, timeout):
        if self.runner is not None:
            result = self.runner(list(command), timeout=timeout)
            if not isinstance(result, dict) or "rc" not in result:
                raise LiveBindingRefused("systemd runner returned an unreadable result")
            if not isinstance(result.get("stdout"), str) \
                    or not isinstance(result.get("stderr"), str):
                raise LiveBindingRefused("systemd runner returned non-text output")
            if type(result["rc"]) is not int:
                raise LiveBindingRefused("systemd runner returned a non-integer rc")
            result.setdefault("timeout", False)
            if type(result["timeout"]) is not bool:
                raise LiveBindingRefused("systemd runner returned an invalid timeout flag")
            return result
        process = None
        try:
            process = subprocess.Popen(
                command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE)
        except OSError as exc:
            raise LiveBindingRefused(
                "systemctl is unavailable: " + str(exc)[:160]) from exc
        timed_out = False
        try:
            out, err = completion._read_bounded(
                process, timeout=timeout, max_bytes=self.max_bytes)
        except subprocess.TimeoutExpired:
            timed_out = True
            out, err = b"", b""
        except completion.CompletionError as exc:
            raise LiveBindingRefused(str(exc)[:300]) from exc
        except OSError as exc:
            raise LiveBindingRefused(
                "systemctl read failed: " + str(exc)[:160]) from exc
        finally:
            completion._stop_process(process)
            for stream in (process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
        rc = process.returncode if process.returncode is not None else -1
        return {"rc": rc, "stdout": _text(out, "systemctl stdout"),
                "stderr": _text(err, "systemctl stderr"),
                "timeout": timed_out}

    def _command(self, verb, *args, pager=True):
        command = [self.systemctl]
        if self.user:
            command.append("--user")
        if pager:
            command.append("--no-pager")
        command.append(verb)
        command.extend(args)
        return command

    def run(self, *args, timeout=None):
        if not args:
            raise LiveBindingRefused("systemctl verb is required")
        for value in args:
            if not isinstance(value, str) or ARG_RE.fullmatch(value) is None:
                raise LiveBindingRefused("invalid systemctl argument")
        command = self._command(args[0], *args[1:])
        return self._execute(
            command, timeout=self.timeout if timeout is None
            else self._duration(timeout))

    def show(self, unit, props):
        self._unit(unit)
        if not isinstance(props, (list, tuple)) or not props:
            raise LiveBindingRefused("systemd show properties are required")
        cleaned = []
        for prop in props:
            if not isinstance(prop, str) or PROPERTY_RE.fullmatch(prop) is None:
                raise LiveBindingRefused("invalid systemd property")
            if prop in cleaned:
                raise LiveBindingRefused("duplicate systemd property")
            cleaned.append(prop)
        command = self._command("show", unit)
        for prop in cleaned:
            command.extend(["--property", prop])
        result = self._execute(command, timeout=self.timeout)
        if result["timeout"] or result["rc"] != 0:
            detail = (result["stderr"] or result["stdout"]).strip()
            raise LiveBindingRefused(
                "systemctl show failed: "
                + (detail[:300] or "rc " + str(result["rc"])))
        try:
            values = completion.parse_show_output(result["stdout"])
        except completion.CompletionError as exc:
            raise LiveBindingRefused(str(exc)[:300]) from exc
        missing = [prop for prop in cleaned if prop not in values]
        if missing:
            raise LiveBindingRefused(
                "systemctl show omitted " + ", ".join(missing))
        return values

    def jobs(self):
        result = self._execute(
            self._command("list-jobs", "--no-legend"), timeout=self.timeout)
        if result["timeout"] or result["rc"] != 0:
            detail = (result["stderr"] or result["stdout"]).strip()
            raise LiveBindingRefused(
                "systemctl list-jobs failed: "
                + (detail[:300] or "rc " + str(result["rc"])))
        return result["stdout"].splitlines()

    def cgroup_pids(self, unit):
        values = self.show(unit, ["MainPID", "ControlGroup"])
        main_pid = values["MainPID"]
        if PID_RE.fullmatch(main_pid) is None:
            raise LiveBindingRefused("MainPID is not an integer")
        main_pid = int(main_pid, 10)
        cgroup = values["ControlGroup"]
        if not isinstance(cgroup, str):
            raise LiveBindingRefused("ControlGroup is not text")
        if cgroup == "":
            if main_pid != 0:
                raise LiveBindingRefused(
                    "ControlGroup is empty for a running main process")
            return {"main_pid": main_pid, "pids": [], "cgroup": cgroup}
        if not cgroup.startswith("/") or "\x00" in cgroup:
            raise LiveBindingRefused("ControlGroup is not an absolute cgroup path")
        parts = [part for part in cgroup.split("/") if part]
        if not parts or any(part in (".", "..") for part in parts):
            raise LiveBindingRefused("ControlGroup contains an unsafe component")
        root = self.cgroup_root.resolve()
        candidate = (root / Path(*parts)).resolve()
        if candidate == root or not candidate.is_relative_to(root):
            raise LiveBindingRefused("ControlGroup escapes the cgroup root")
        procs = candidate / "cgroup.procs"
        if procs.is_symlink():
            raise LiveBindingRefused("cgroup.procs must not be a symlink")
        if not procs.exists():
            if main_pid != 0:
                raise LiveBindingRefused(
                    "cgroup.procs is absent for a running main process")
            return {"main_pid": main_pid, "pids": [], "cgroup": cgroup}
        data = _read_file(procs, max_bytes=self.max_bytes)
        pids = []
        for line in _text(data, "cgroup.procs").splitlines():
            line = line.strip()
            if not line:
                continue
            if PID_RE.fullmatch(line) is None or int(line, 10) <= 0:
                raise LiveBindingRefused("cgroup.procs contains a non-PID line")
            pid = int(line, 10)
            if pid not in pids:
                pids.append(pid)
            if len(pids) > MAX_PIDS:
                raise LiveBindingRefused("cgroup.procs exceeds the PID bound")
        return {"main_pid": main_pid, "pids": pids, "cgroup": cgroup}

    @staticmethod
    def _path_type(path):
        try:
            if path.is_symlink():
                return "symlink"
            if path.is_file():
                return "file"
            if path.exists():
                return "other"
            return "missing"
        except OSError as exc:
            raise LiveBindingRefused(
                "cannot observe " + str(path) + ": " + str(exc)[:160]) from exc

    @staticmethod
    def _expected_units(unit, declared):
        by_suffix = {suffix: set() for suffix in UNIT_SUFFIXES}
        for path in declared:
            if path.suffix in by_suffix:
                by_suffix[path.suffix].add(path.name)
        if len(by_suffix[".service"]) != 1:
            return None, "declared paths do not name exactly one service"
        if len(by_suffix[".timer"]) != 1:
            return None, "declared paths do not name exactly one timer"
        if len(by_suffix[".path"]) > 1:
            return None, "declared paths name more than one path unit"
        service = next(iter(by_suffix[".service"]))
        if service != unit:
            return None, "declared service is not the requested unit"
        return set().union(*by_suffix.values()), None

    @staticmethod
    def _parse_listing(result, verb):
        if result["timeout"]:
            return None, verb + " timed out"
        if result["rc"] == 1 and not result["stderr"].strip():
            return [], None
        if result["rc"] != 0:
            detail = (result["stderr"] or result["stdout"]).strip()
            return None, verb + " failed: " + (detail[:300] or "rc " + str(result["rc"]))
        names = []
        for line in result["stdout"].splitlines():
            fields = line.split()
            if not fields:
                continue
            name = fields[0].lstrip("*\u25cf").strip()
            if name:
                names.append(name)
        return names, None

    def _list_names(self, verb, *args):
        return self._parse_listing(
            self._execute(self._command(verb, *args), timeout=self.timeout),
            verb)

    @staticmethod
    def _parse_jobs(result):
        if result["timeout"]:
            return None, "list-jobs timed out"
        if result["rc"] != 0:
            detail = (result["stderr"] or result["stdout"]).strip()
            return None, "list-jobs failed: " + (
                detail[:300] or "rc " + str(result["rc"]))
        return result["stdout"].splitlines(), None

    def _scan_dependencies(self, base, expected, declared, foreign):
        root = base.resolve()
        declared_paths = {str(path) for path in declared}
        declared_resolved = set()
        for path in declared:
            try:
                declared_resolved.add(path.resolve())
            except (OSError, RuntimeError):
                declared_resolved.add(path)
        stack = [Path(base)]
        seen = 0
        while stack:
            current = stack.pop()
            try:
                with os.scandir(current) as scan:
                    for entry in scan:
                        seen += 1
                        if seen > MAX_SCAN_ENTRIES:
                            return "unit directory exceeds the dependency scan bound"
                        path = Path(entry.path)
                        if entry.is_symlink():
                            try:
                                target = path.resolve(strict=False)
                            except (OSError, RuntimeError) as exc:
                                return ("dependency scan cannot resolve a symlink: "
                                        + str(path) + ": " + str(exc)[:120])
                            if target == path:
                                return ("dependency scan cannot resolve a symlink: "
                                        + str(path))
                            try:
                                if target == Path(os.devnull):
                                    continue
                                target.relative_to(root)
                            except ValueError:
                                return ("dependency scan found a symlink outside "
                                        "the unit directory: " + str(path))
                            try:
                                info = path.stat()
                            except (OSError, RuntimeError) as exc:
                                return ("dependency scan cannot resolve a symlink: "
                                        + str(path) + ": " + str(exc)[:120])
                            if not stat.S_ISREG(info.st_mode):
                                continue
                        elif entry.is_dir(follow_symlinks=False):
                            stack.append(path)
                            continue
                        elif not entry.is_file(follow_symlinks=False):
                            continue
                        if path.suffix not in {".service", ".timer", ".path",
                                               ".socket", ".target", ".conf"}:
                            continue
                        try:
                            data = _read_file(path, max_bytes=MAX_UNIT_BYTES)
                        except LiveBindingRefused as exc:
                            return str(exc)
                        source_declared = str(path) in declared_paths
                        if not source_declared:
                            try:
                                source_declared = path.resolve() in declared_resolved
                            except (OSError, RuntimeError):
                                source_declared = False
                        text = _text(data, str(path))
                        for number, line in enumerate(text.splitlines(), 1):
                            stripped = line.strip()
                            if not stripped or stripped.startswith(("#", ";")):
                                continue
                            match = DEPENDENCY_RE.match(stripped)
                            if match is None:
                                continue
                            for name in CRQ_NAME_RE.findall(match.group("value")):
                                if name not in expected or not source_declared:
                                    foreign.append(
                                        "%s:%d: %s names %s"
                                        % (path, number,
                                           match.group("directive"), name))
            except OSError as exc:
                return "unit directory is unreadable: " + str(exc)[:160]
        return None

    def discover(self, unit, declared_paths):
        self._unit(unit)
        if self.unit_dir is None:
            raise LiveBindingRefused("unit directory is required for discovery")
        if not isinstance(declared_paths, (list, tuple)) or not declared_paths:
            raise LiveBindingRefused("declared paths are required")
        declared = []
        for raw in declared_paths:
            if not isinstance(raw, str):
                raise LiveBindingRefused("declared path is not text")
            path = Path(raw)
            if not path.is_absolute():
                raise LiveBindingRefused("declared path is not absolute")
            if ".." in path.parts:
                raise LiveBindingRefused("declared path contains parent traversal")
            try:
                path.relative_to(self.unit_dir)
            except ValueError as exc:
                raise LiveBindingRefused(
                    "declared path escapes the unit directory") from exc
            if path not in declared:
                declared.append(path)

        paths = {}
        for path in declared:
            paths[str(path)] = {"type": self._path_type(path)}
        units, units_error = self._expected_units(unit, declared)
        units = units or set()
        foreign = []
        unsupported = []
        error = units_error

        if not self.unit_dir.is_absolute() or self.unit_dir.is_symlink() \
                or not self.unit_dir.is_dir():
            return {"complete": False, "supported": False,
                    "error": "unit directory is not an absolute regular directory",
                    "paths": paths, "units": {name: {} for name in sorted(units)},
                    "foreign": foreign, "jobs": []}

        for path in declared:
            if path.parent == self.unit_dir:
                continue
            if path.parent.parent == self.unit_dir \
                    and path.parent.name.endswith((".wants", ".requires")):
                continue
            unsupported.append("declared path is outside the supported layout: "
                               + str(path))
        for path, entry in paths.items():
            if entry["type"] == "other":
                unsupported.append("declared path is not a file or symlink: " + path)

        entries = []
        try:
            with os.scandir(self.unit_dir) as scan:
                for entry in scan:
                    entries.append(Path(entry.path))
                    if len(entries) > MAX_UNIT_ENTRIES:
                        return {
                            "complete": False, "supported": False,
                            "error": "unit directory exceeds the scan bound",
                            "paths": paths,
                            "units": {name: {} for name in sorted(units)},
                            "foreign": foreign, "jobs": []}
        except OSError as exc:
            return {"complete": False, "supported": False,
                    "error": "unit directory is unreadable: " + str(exc)[:160],
                    "paths": paths, "units": {name: {} for name in sorted(units)},
                    "foreign": foreign, "jobs": []}
        declared_set = {str(path) for path in declared}
        prefix = unit.split(".")[0]
        for entry in sorted(entries):
            name = entry.name
            if name.startswith(prefix) and str(entry) not in declared_set:
                foreign.append("unexpected installed entry: " + str(entry))
            if entry.is_dir(follow_symlinks=False) \
                    and name.endswith(".d") and name[:-2] in units:
                foreign.append("undeclared drop-in directory: " + str(entry))
            if entry.is_dir(follow_symlinks=False) \
                    and name.endswith((".wants", ".requires")):
                try:
                    children = list(entry.iterdir())
                except OSError as exc:
                    error = error or ("enablement directory is unreadable: "
                                      + str(exc)[:160])
                    continue
                for child in sorted(children):
                    if child.name.startswith(prefix) \
                            and str(child) not in declared_set:
                        foreign.append("unexpected enablement link: "
                                       + str(child))

        scan_error = self._scan_dependencies(
            self.unit_dir, units, declared, foreign)
        if scan_error is not None:
            error = error or scan_error

        for verb in ("list-unit-files", "list-units"):
            args = ["--no-legend", "--plain"]
            if verb == "list-units":
                args.append("--all")
            args.append(prefix + "*")
            names, listing_error = self._list_names(verb, *args)
            if listing_error is not None:
                error = error or listing_error
                continue
            for name in names:
                if name.startswith(prefix) and name not in units:
                    foreign.append(verb + " names unexpected unit " + name)

        jobs_result = self._execute(
            self._command("list-jobs", "--no-legend"),
            timeout=self.timeout)
        jobs, jobs_error = self._parse_jobs(jobs_result)
        if jobs_error is not None:
            error = error or jobs_error
            jobs = []
        else:
            for line in jobs:
                fields = line.split()
                if len(fields) < 4 or not fields[0].isdigit():
                    error = error or ("list-jobs observation is malformed: "
                                      + line[:160])
                    break
                for field in fields[1:]:
                    if field.startswith(prefix + ".") and field not in units:
                        foreign.append("list-jobs names unexpected unit " + field)

        complete = error is None
        supported = complete and not foreign and not unsupported
        if not supported and error is None:
            error = (foreign or unsupported or ["topology is not supported"])[0]
        return {"complete": complete, "supported": supported,
                "error": None if complete and supported else error,
                "paths": paths,
                "units": {name: {} for name in sorted(units)},
                "foreign": foreign, "jobs": jobs}


class ProcessIdentity:
    """Live ``IdentityPort`` for the current process and filesystem."""

    @property
    def uid(self):
        return os.getuid()

    @property
    def gid(self):
        return os.getgid()

    def xattrs(self, path):
        try:
            names = os.listxattr(path, follow_symlinks=False)
        except OSError as exc:
            if exc.errno in (errno.ENOTSUP, errno.EOPNOTSUPP, errno.ENODATA):
                return []
            raise
        return sorted(names)


@dataclass(frozen=True)
class HostLayout:
    """The existing overlay-bound root, unit directory and record directory."""

    root: Path
    unit_dir: Path
    record_dir: Path
    overlay: Mapping[str, Any]

    @classmethod
    def from_overlay(cls, root, overlay):
        if not isinstance(overlay, Mapping):
            raise LiveBindingRefused("overlay is not an object")
        raw = dict(overlay)
        try:
            host.validate(raw)
        except ValueError as exc:
            raise LiveBindingRefused("overlay refused: " + str(exc)[:300]) from exc
        unit_dir = (Path(os.environ.get(
            "XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "systemd/user")
        return cls(root=Path(root), unit_dir=unit_dir,
                   record_dir=Path(raw["record_dir"]), overlay=raw)

    def state_dir(self):
        return self.root / "apps/crq-python/state"

    def record_identity(self):
        path = self.record_dir
        try:
            info = os.stat(path, follow_symlinks=False)
        except OSError as exc:
            raise LiveBindingRefused(
                "record directory is unavailable: " + str(exc)[:160]) from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise LiveBindingRefused("record directory must be a regular directory")
        mode = stat.S_IMODE(info.st_mode)
        if mode != 0o700:
            raise LiveBindingRefused("record directory must have mode 0700")
        return {"path": str(path), "dev": info.st_dev, "ino": info.st_ino,
                "mode": mode, "uid": info.st_uid, "gid": info.st_gid}

    def lock_identity(self):
        state = self.state_dir()
        lock = state / dc.LOCK_NAME
        root = self.root.resolve()
        try:
            resolved_state = state.resolve()
        except OSError as exc:
            raise LiveBindingRefused(
                "controller state directory is unavailable: "
                + str(exc)[:160]) from exc
        if state.is_symlink() or resolved_state != root / "apps/crq-python/state":
            raise LiveBindingRefused("controller state directory leaves the root")
        try:
            info = os.stat(lock, follow_symlinks=False)
        except FileNotFoundError:
            return {"path": str(lock), "exists": False,
                    "state_dir": str(state), "root": str(root)}
        except OSError as exc:
            raise LiveBindingRefused(
                "controller lock is unavailable: " + str(exc)[:160]) from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise LiveBindingRefused("controller lock must be a regular file")
        mode = stat.S_IMODE(info.st_mode)
        if mode & 0o022:
            raise LiveBindingRefused("controller lock must not be group or world writable")
        if info.st_uid != os.geteuid():
            raise LiveBindingRefused("controller lock owner is not the effective uid")
        return {"path": str(lock), "exists": True, "dev": info.st_dev,
                "ino": info.st_ino, "mode": mode, "uid": info.st_uid,
                "gid": info.st_gid, "nlink": info.st_nlink,
                "state_dir": str(state), "root": str(root)}

    def validate(self, *, require_lock=False):
        try:
            host.root_check(self.root, dict(self.overlay))
        except (ValueError, OSError, subprocess.CalledProcessError) as exc:
            raise LiveBindingRefused(
                "deployment root refused: " + str(exc)[:300]) from exc
        if not self.unit_dir.is_absolute() or self.unit_dir.is_symlink() \
                or not self.unit_dir.is_dir():
            raise LiveBindingRefused(
                "unit directory must be an absolute regular directory")
        if self.record_dir.is_symlink():
            raise LiveBindingRefused("record directory must not be a symlink")
        try:
            expected = Path(self.overlay["record_dir"])
            if self.record_dir.resolve() != expected.resolve():
                raise LiveBindingRefused(
                    "record directory is not the overlay record directory")
        except OSError as exc:
            raise LiveBindingRefused(
                "record directory is unavailable: " + str(exc)[:160]) from exc
        record = self.record_identity()
        lock = self.lock_identity()
        if require_lock and not lock["exists"]:
            raise LiveBindingRefused("controller lock is absent")
        return {"root": str(self.root.resolve()),
                "unit_dir": str(self.unit_dir),
                "record": record, "lock": lock}


def production_adapter(effects, overlay, *, unit, runtime, artifact_root=None,
                       systemd=None, journal_source=None, identity=None,
                       queue_drain=None, require_journal_witness=True,
                       **options):
    """Compose one live adapter over the existing overlay and controller seams.

    The adapter is returned with its selected identity. This function never
    calls ``switch_unit``, ``recover_unit`` or the CLI, and never mutates a
    host surface.
    """
    layout = HostLayout.from_overlay(effects.root, overlay)
    try:
        if Path(effects.record_dir).resolve() != layout.record_dir.resolve():
            raise LiveBindingRefused(
                "record directory is not the overlay record directory")
    except OSError as exc:
        raise LiveBindingRefused(
            "record directory is unavailable: " + str(exc)[:160]) from exc
    layout.validate()
    controller = _controller_module(effects)
    try:
        source_sha = effects.git("rev-parse", "HEAD")
    except controller.Refused as exc:
        raise LiveBindingRefused(
            "deployment HEAD is unavailable: " + str(exc)[:300]) from exc
    systemd = systemd or SubprocessSystemd(unit_dir=layout.unit_dir)
    journal_source = journal_source or completion.SystemdJournalSource(user=True)
    identity = identity or ProcessIdentity()
    queue_drain = queue_drain or (lambda: controller.runner_queue_drain(effects))
    options.setdefault("error_type", controller.Refused)
    return factory.compose(
        root=effects.root, unit=unit, runtime=runtime,
        source_sha=source_sha, artifact_root=artifact_root,
        unit_dir=layout.unit_dir, systemd=systemd, identity=identity,
        journal_source=journal_source, queue_drain=queue_drain,
        require_journal_witness=require_journal_witness, **options)
