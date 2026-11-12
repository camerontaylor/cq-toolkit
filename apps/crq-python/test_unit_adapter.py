"""Focused tests for the unwired, fail-closed production unit adapter.

All host effects are injected fakes. Installed units, snapshots, masks, staged
files and restored files are real temporary files. No systemd command, live
unit, VM, production host or network is touched. The controller integration
tests use the shared offline controller fixture and an empty recorded queue.
"""
import base64
import copy
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pathlib
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

from test_deploy_controller_fixtures import ControllerFixture, dc
import test_host_config_fixtures as host_fixtures

ROOT = Path(__file__).resolve().parent
OPS = ROOT / "ops"
host = host_fixtures.host
NODE_SHA = "b" * 40
NODE_RUNTIME = "node:" + NODE_SHA


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


adapter_mod = _load("crq_unit_adapter", OPS / "unit-adapter.py")


def _elf_header():
    header = bytearray(20)
    header[:5] = b"\x7fELF\x02"
    header[5] = 1
    header[18:20] = b"\x3e\x00"
    return bytes(header)


def _node_artifact(base, sha):
    """A minimally packageable extracted Node artifact under ``base``."""
    package = host._package_runner()
    root = Path(base) / ".local/opt" / ("crq-" + sha)
    (root / "dist/queue-runner").mkdir(parents=True)
    (root / "dist/queue-runner/crq.js").write_bytes(b"runner")
    (root / "package.json").write_text(
        json.dumps({"name": "crq-runner", "version": "0.0.0"}))
    fs_ext = root / "node_modules/fs-ext"
    (fs_ext / "build/Release").mkdir(parents=True)
    (fs_ext / "package.json").write_text(
        json.dumps({"name": "fs-ext", "version": package.FS_EXT_VERSION}))
    (fs_ext / "build/Release/fs_ext.node").write_bytes(_elf_header())
    files = package.inventory(root)
    facts = package.staging_facts(root)
    provenance = {
        "schema_version": package.PROVENANCE_VERSION,
        "source_sha": sha,
        "lockfile_sha256": "1" * 64,
        "runtime": {
            "node_version": "v24.0.0",
            "node_major": package.NODE_MAJOR,
            "node_abi": "137",
            "platform": package.PLATFORM,
            "arch": package.ARCH,
        },
        "toolchain": {
            "pnpm_version": "9.0.0",
            "install_command": "pnpm install",
            "build_command": "pnpm build",
            "deploy_command": "pnpm deploy",
        },
        "dependencies": facts["dependencies"],
        "fs_ext": facts["fs_ext"],
    }
    manifest = {
        "schema_version": package.SCHEMA_VERSION,
        "source_sha": sha,
        "content_sha256": package.content_digest(files),
        "provenance": provenance,
        "files": files,
    }
    package.validate_manifest(manifest)
    package.validate_provenance(provenance, sha=sha, staging=root)
    (root / package.MANIFEST_NAME).write_text(json.dumps(manifest))
    return root


def _write(path, data, mode):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    path.chmod(mode)


def _tree(root):
    """A stable observation of the real unit directory for no-mutation checks."""
    root = Path(root)
    result = {}
    for path in sorted(root.rglob("*")):
        rel = str(path.relative_to(root))
        if path.is_symlink():
            result[rel] = ("symlink", os.readlink(path))
        elif path.is_file():
            result[rel] = ("file", path.stat().st_mode & 0o7777,
                           hashlib.sha256(path.read_bytes()).hexdigest())
        else:
            result[rel] = ("other",)
    return result


class Ticker:
    """A monotonic clock that advances on every read, so bound loops terminate."""

    def __init__(self):
        self.now = 0.0

    def __call__(self):
        self.now += 1.0
        return self.now


class LiveIdentity:
    @property
    def uid(self):
        return os.getuid()

    @property
    def gid(self):
        return os.getgid()

    def xattrs(self, path):
        try:
            return os.listxattr(path, follow_symlinks=False)
        except OSError as exc:
            if exc.errno in (errno.ENOTSUP, errno.EOPNOTSUPP, errno.ENODATA):
                return []
            raise


class FakeCapability:
    def __init__(self, mapping):
        self.mapping = mapping
        self.fail = None

    def commands(self, runtime):
        if self.fail == "commands":
            raise RuntimeError("capability unavailable")
        return self.mapping.get(runtime)


class FakeCompletion:
    def __init__(self, unit_dir):
        self.unit_dir = Path(unit_dir)
        self.sequence_value = 0
        self.records = []
        self.fail = None
        self.override = None
        self.read_delay = 0

    def sequence(self, unit):
        if self.fail == "sequence":
            raise RuntimeError("sequence unavailable")
        return self.sequence_value

    def read(self, unit, runtime, previous):
        if self.fail == "read":
            raise RuntimeError("completion unavailable")
        if self.read_delay:
            self.read_delay -= 1
            return None
        if self.override is not None:
            return copy.deepcopy(self.override)
        service = self.unit_dir / unit
        try:
            digest = hashlib.sha256(service.read_bytes()).hexdigest()
        except OSError:
            return None
        self.sequence_value += 1
        record = {
            "unit": unit,
            "runtime": runtime,
            "success": True,
            "sequence": self.sequence_value,
            "invocation": "inv-" + str(self.sequence_value),
            "service_sha256": digest,
        }
        self.records.append(record)
        return record


class FakeSystemd:
    """Injected systemd port over real temporary unit files."""

    def __init__(self, unit_dir, inventory):
        self.unit_dir = Path(unit_dir)
        self.inventory = inventory
        self.active = {}
        self.jobs_lines = []
        self.cgroup = {}
        self.foreign = []
        self.fail = None
        self.fail_commands = set()
        self.incomplete_discovery = False
        self.calls = []
        self.service_start_delay = 0
        self.activator_starts_service = False
        self.post_start_state = {}
        self._services = {entry["service"] for entry in inventory.values()}
        for entry in inventory.values():
            self.active[entry["service"]] = "inactive"
            self.active[entry["timer"]] = "inactive"
            if entry["path"]:
                self.active[entry["path"]] = "inactive"
            self.cgroup[entry["service"]] = {
                "main_pid": 0, "pids": [], "cgroup": ""}

    def _kind(self, path):
        try:
            info = Path(path).lstat()
        except FileNotFoundError:
            return "missing"
        if stat.S_ISLNK(info.st_mode):
            return "symlink"
        if stat.S_ISREG(info.st_mode):
            return "file"
        return "other"

    def _units(self):
        names = set()
        for entry in self.inventory.values():
            names.add(entry["service"])
            names.add(entry["timer"])
            if entry["path"]:
                names.add(entry["path"])
        return names

    def _unit_names(self, unit):
        entry = self.inventory[unit]
        names = {entry["service"], entry["timer"]}
        if entry["path"]:
            names.add(entry["path"])
        return names

    def _unit_file_state(self, unit):
        for entry in self.inventory.values():
            if entry["timer"] == unit:
                rel = entry["timer_wants"]
                return ("enabled" if rel and (self.unit_dir / rel).is_symlink()
                        else "disabled")
            if entry["path"] == unit:
                rel = entry["path_wants"]
                return ("enabled" if rel and (self.unit_dir / rel).is_symlink()
                        else "disabled")
        return "static"

    def _masked(self, unit):
        if unit not in self._services:
            return False
        path = self.unit_dir / unit
        return path.is_symlink() and os.readlink(path) == "/dev/null"

    def discover(self, unit, declared_paths):
        if self.fail == "discover":
            raise RuntimeError("discovery unavailable")
        if self.incomplete_discovery:
            return {"complete": False, "supported": True, "paths": {},
                    "units": {}, "foreign": [], "jobs": [],
                    "error": "incomplete"}
        paths = {path: {"type": self._kind(Path(path))}
                 for path in declared_paths}
        units = {name: {} for name in self._unit_names(unit)}
        return {"complete": True, "supported": True, "paths": paths,
                "units": units, "foreign": list(self.foreign),
                "jobs": list(self.jobs_lines), "error": None}

    def run(self, *args, timeout=60):
        self.calls.append(list(args))
        if args and args[0] in self.fail_commands:
            return {"argv": list(args), "rc": 1, "stdout": "",
                    "stderr": "injected command failure", "timeout": False}
        if args and args[0] == "start" and len(args) > 1:
            unit = args[1]
            if self._masked(unit):
                return {"argv": list(args), "rc": 1, "stdout": "",
                        "stderr": "Unit is masked.", "timeout": False}
            if unit in self._services and timeout < self.service_start_delay:
                return {"argv": list(args), "rc": None, "stdout": "",
                        "stderr": "", "timeout": True}
            if unit in self.active:
                self.active[unit] = self.post_start_state.get(unit, "active")
            if self.activator_starts_service:
                service = self._service_for_activator(unit)
                if service is not None:
                    self.active[service] = self.post_start_state.get(
                        service, "active")
            return {"argv": list(args), "rc": 0, "stdout": "",
                    "stderr": "", "timeout": False}
        if args and args[0] == "stop":
            for unit in args[1:]:
                if unit in self.active:
                    self.active[unit] = "inactive"
            return {"argv": list(args), "rc": 0, "stdout": "",
                    "stderr": "", "timeout": False}
        if args and args[0] in {"reset-failed", "daemon-reload"}:
            return {"argv": list(args), "rc": 0, "stdout": "",
                    "stderr": "", "timeout": False}
        return {"argv": list(args), "rc": 1, "stdout": "",
                "stderr": "unsupported command", "timeout": False}

    def show(self, unit, props):
        if self.fail == "show":
            raise RuntimeError("show unavailable")
        if unit not in self._units():
            return {}
        path = self.unit_dir / unit
        masked = self._masked(unit)
        values = {}
        for prop in props:
            if prop == "LoadState":
                values[prop] = "masked" if masked else "loaded"
            elif prop == "FragmentPath":
                values[prop] = str(path)
            elif prop == "ActiveState":
                values[prop] = ("inactive" if masked
                                else self.active.get(unit, "inactive"))
            elif prop == "SubState":
                values[prop] = "dead"
            elif prop == "UnitFileState":
                values[prop] = self._unit_file_state(unit)
            else:
                values[prop] = ""
        return values

    def jobs(self):
        if self.fail == "jobs":
            raise RuntimeError("jobs unavailable")
        return list(self.jobs_lines)

    def _service_for_activator(self, unit):
        for entry in self.inventory.values():
            if entry.get("timer") == unit or entry.get("path") == unit:
                return entry["service"]
        return None

    def cgroup_pids(self, unit):
        if self.fail == "cgroup":
            raise RuntimeError("cgroup unavailable")
        return self.cgroup.get(unit, {"main_pid": 0, "pids": [], "cgroup": ""})


class AdapterFixture(ControllerFixture):
    """A real temporary deployment clone, real units, injected systemd."""

    def setUp(self):
        super().setUp()
        for name in ("crq.py", "crq_slot.py", "crq_repair.py", "backfill.py",
                     "backfill_publisher.py", "ops/crq-watchdog.py"):
            source = ROOT / name
            destination = self.runner / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(source, destination)
        self.inventory = adapter_mod.declared_inventory(self.root, self.before)
        self.unit_dir = self.units_home
        shutil.rmtree(self.unit_dir)
        self.unit_dir.mkdir(parents=True)
        self.artifact = _node_artifact(self.base, NODE_SHA)
        self.home_patch = mock.patch.object(
            pathlib.Path, "home", return_value=self.base)
        self.home_patch.start()
        self.addCleanup(self.home_patch.stop)
        self.prior_modes = {}
        for unit, entry in self.inventory.items():
            rendered = host.render_service(
                self.root, unit, "python", sha=self.before)
            mode = 0o600 if unit == "crq-tick.service" else 0o644
            self.prior_modes[unit] = mode
            _write(self.unit_dir / unit, rendered["bytes"], mode)
            timer_bytes = subprocess.run(
                ["git", "-C", str(self.root), "cat-file", "blob",
                 self.before + ":apps/crq-python/ops/systemd/"
                 + entry["timer"]],
                check=True, capture_output=True).stdout
            _write(self.unit_dir / entry["timer"], timer_bytes, 0o644)
            if entry["timer_wants"]:
                self._link(entry["timer_wants"], entry["timer"])
            if entry["path"]:
                path_text = host.git(
                    self.root, "show",
                    self.before + ":apps/crq-python/ops/systemd/"
                    + entry["path"])
                path_text = path_text.replace("@CRQ_ROOT@", str(self.runner))
                _write(self.unit_dir / entry["path"], path_text.encode(), 0o644)
            if entry["path_wants"] and unit != "crq-repair.service":
                self._link(entry["path_wants"], entry["path"])
        self.fake = FakeSystemd(self.unit_dir, self.inventory)
        self.fake.active["crq-tick.timer"] = "active"
        self.fake.active["crq-slot.timer"] = "active"
        self.fake.active["crq-repair.timer"] = "active"
        self.fake.active["crq-repair.path"] = "active"
        self.fake.active["crq-publisher.path"] = "active"
        self.identity = LiveIdentity()
        self.capability = FakeCapability({
            "python": frozenset(host.UNIT_COMMANDS.values()),
            NODE_RUNTIME: frozenset(host.UNIT_COMMANDS.values()),
        })
        self.completion = FakeCompletion(self.unit_dir)
        self.queue = {"drained": True, "blocked": []}
        self.adapter = self.make_adapter()
        self.write_state("queue.json", {"items": [], "starts": []})
        self.write_state("heartbeat.json", {"beat": "2026-11-12T00:00:00Z"})

    def _link(self, rel, target):
        path = self.unit_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to("../" + target)

    def make_adapter(self, **overrides):
        options = {
            "root": self.root,
            "source_sha": self.before,
            "unit_dir": self.unit_dir,
            "artifact_root": self.artifact,
            "systemd": self.fake,
            "identity": self.identity,
            "capability": self.capability,
            "completion": self.completion,
            "queue_drain": lambda: self.queue,
            "error_type": dc.Refused,
            "drain_timeout": 3.0,
            "completion_timeout": 3600.0,
            "clock": Ticker(),
            "sleep": lambda _seconds: None,
        }
        options.update(overrides)
        return adapter_mod.ProductionUnitAdapter(**options)

    def node_service(self, unit):
        return host.render_service(
            self.root, unit, NODE_RUNTIME, sha=self.before,
            artifact_root=str(self.artifact))

    def python_service(self, unit):
        return host.render_service(
            self.root, unit, "python", sha=self.before)

    def switch_ready(self, unit, runtime):
        current = self.make_adapter()
        prior = current.preflight(unit, runtime)
        snapshot = current.snapshot(unit)
        current.validate_snapshot(unit, snapshot)
        return current, prior, snapshot


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crq-inv-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "deploy"
        runner = self.root / "apps/crq-python"
        runner.mkdir(parents=True)
        shutil.copytree(OPS / "systemd", runner / "ops/systemd")
        (self.root / ".gitignore").write_text("")
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Fixture")
        self.git("add", ".")
        self.git("commit", "-qm", "baseline")
        self.sha = self.git("rev-parse", "HEAD").strip()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args],
                              check=True, capture_output=True,
                              text=True).stdout

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-qm", "change")
        return self.git("rev-parse", "HEAD").strip()

    def template(self, name):
        return self.root / "apps/crq-python/ops/systemd" / name

    def test_declared_inventory_matches_committed_templates(self):
        inventory = adapter_mod.declared_inventory(self.root, self.sha)
        self.assertEqual(set(inventory), set(host.UNIT_COMMANDS))
        self.assertEqual(sum(1 for e in inventory.values() if e["timer"]), 6)
        self.assertEqual(sum(1 for e in inventory.values() if e["path"]), 2)
        for entry in inventory.values():
            self.assertIsNotNone(entry["timer"])
            self.assertTrue(entry["timer_wants"])
            self.assertIn(entry["service"], entry["blobs"])

    def test_declared_inventory_parses_schedules(self):
        inventory = adapter_mod.declared_inventory(self.root, self.sha)
        self.assertEqual(inventory["crq-tick.service"]["timer_bound_seconds"],
                         12 * 60 + 60)
        self.assertEqual(inventory["crq-slot.service"]["timer_bound_seconds"],
                         61)
        self.assertEqual(
            inventory["crq-backfill.service"]["timer_bound_seconds"],
            6 * 3600 + 60)
        self.assertEqual(
            inventory["crq-publisher.service"]["timer_bound_seconds"], 65)
        self.assertEqual(inventory["crq-repair.service"]["service_type"],
                         "simple")
        self.assertIsNone(
            inventory["crq-watchdog.service"]["service_timeout_seconds"])

    def test_undeclared_template_refuses(self):
        (self.template("crq-extra.service")).write_text(
            "[Service]\nExecStart=/bin/true\n")
        sha = self.commit()
        with self.assertRaisesRegex(ValueError, "undeclared committed template"):
            adapter_mod.declared_inventory(self.root, sha)

    def test_missing_timer_refuses(self):
        self.template("crq-tick.timer").unlink()
        sha = self.commit()
        with self.assertRaisesRegex(ValueError, "lacks the timer template"):
            adapter_mod.declared_inventory(self.root, sha)

    def test_multiple_wanted_by_refuses(self):
        path = self.template("crq-tick.timer")
        path.write_text(path.read_text() + "WantedBy=multi-user.target\n")
        sha = self.commit()
        with self.assertRaisesRegex(ValueError, "exactly one WantedBy"):
            adapter_mod.declared_inventory(self.root, sha)

    def test_foreign_unit_relation_refuses(self):
        path = self.template("crq-tick.timer")
        path.write_text(path.read_text().replace(
            "[Timer]\n", "[Timer]\nUnit=crq-other.service\n"))
        sha = self.commit()
        with self.assertRaisesRegex(ValueError, "names another unit"):
            adapter_mod.declared_inventory(self.root, sha)

    def test_nested_dropin_template_refuses(self):
        dropin = self.template("crq-tick.service.d/10.conf")
        dropin.parent.mkdir()
        dropin.write_text("[Service]\nEnvironment=X=1\n")
        sha = self.commit()
        with self.assertRaisesRegex(ValueError, "undeclared committed template"):
            adapter_mod.declared_inventory(self.root, sha)

    def test_missing_placeholder_refuses(self):
        path = self.template("crq-tick.service")
        path.write_text(path.read_text().replace("@CRQ_ROOT@", "/tmp/other"))
        sha = self.commit()
        with self.assertRaisesRegex(ValueError, "placeholder"):
            adapter_mod.declared_inventory(self.root, sha)

    def test_bad_source_refuses(self):
        with self.assertRaises((ValueError, subprocess.CalledProcessError)):
            adapter_mod.declared_inventory(self.root, "f" * 40)


class AdapterTests(AdapterFixture):
    def test_preflight_refuses_same_runtime(self):
        with self.assertRaisesRegex(dc.Refused, "already selects"):
            self.adapter.preflight("crq-tick.service", "python")

    def test_preflight_node_from_python_succeeds(self):
        prior = self.adapter.preflight("crq-tick.service", NODE_RUNTIME)
        self.assertEqual(prior["runtime"], "python")
        self.assertEqual(prior["render"]["source_sha"], self.before)
        self.assertFalse(prior["discovery"]["exhaustive"])

    def test_preflight_python_from_node_succeeds(self):
        rendered = self.node_service("crq-tick.service")
        _write(self.unit_dir / "crq-tick.service", rendered["bytes"], 0o600)
        prior = self.adapter.preflight("crq-tick.service", "python")
        self.assertEqual(prior["runtime"], NODE_RUNTIME)

    def test_preflight_node_with_default_artifact_root(self):
        current = self.make_adapter(artifact_root=None)
        prior = current.preflight("crq-tick.service", NODE_RUNTIME)
        self.assertEqual(prior["runtime"], "python")

    def test_preflight_refuses_alternate_artifact_tree(self):
        alternate = self.base / "alternate"
        shutil.copytree(self.artifact, alternate)
        current = self.make_adapter(artifact_root=alternate)
        before = _tree(self.unit_dir)
        with self.assertRaisesRegex(dc.Refused,
                                    "not the rendered executable tree"):
            current.preflight("crq-tick.service", NODE_RUNTIME)
        self.assertEqual(_tree(self.unit_dir), before)

    def test_preflight_refuses_completion_deadline_below_schedule(self):
        current = self.make_adapter(completion_timeout=600.0)
        before = _tree(self.unit_dir)
        with self.assertRaisesRegex(dc.Refused,
                                    "completion deadline .* below the "
                                    "declared bound"):
            current.preflight("crq-tick.service", NODE_RUNTIME)
        self.assertEqual(_tree(self.unit_dir), before)

    def test_preflight_refuses_completion_schedule_beyond_maximum(self):
        self.fake.active["crq-backfill.timer"] = "active"
        current = self.make_adapter(completion_timeout=36000.0)
        before = _tree(self.unit_dir)
        with self.assertRaisesRegex(dc.Refused,
                                    "exceeds the supported maximum"):
            current.preflight("crq-backfill.service", NODE_RUNTIME)
        self.assertEqual(_tree(self.unit_dir), before)

    def test_preflight_refuses_inactive_timer_completion(self):
        self.fake.active["crq-tick.timer"] = "inactive"
        before = _tree(self.unit_dir)
        with self.assertRaisesRegex(dc.Refused,
                                    "prior timer activator is inactive"):
            self.adapter.preflight("crq-tick.service", NODE_RUNTIME)
        self.assertEqual(_tree(self.unit_dir), before)

    def test_preflight_refuses_unbounded_oneshot_timeout(self):
        self.fake.active["crq-watchdog.timer"] = "active"
        before = _tree(self.unit_dir)
        with self.assertRaisesRegex(dc.Refused,
                                    "start timeout is not bounded"):
            self.adapter.preflight("crq-watchdog.service", NODE_RUNTIME)
        self.assertEqual(_tree(self.unit_dir), before)

    def test_preflight_refuses_installed_timer_schedule_drift(self):
        timer = self.unit_dir / "crq-tick.timer"
        timer.write_text(timer.read_text().replace(
            "OnCalendar=*:0/12", "OnCalendar=*-*-* *:00:00"))
        before = _tree(self.unit_dir)
        with self.assertRaisesRegex(
                dc.Refused,
                "installed timer does not match the pinned schedule"):
            self.adapter.preflight("crq-tick.service", NODE_RUNTIME)
        self.assertEqual(_tree(self.unit_dir), before)

    def test_preflight_refuses_simple_service_completion(self):
        before = _tree(self.unit_dir)
        with self.assertRaisesRegex(
                dc.Refused,
                "simple service completion has no declared execution bound"):
            self.adapter.preflight("crq-repair.service", NODE_RUNTIME)
        self.assertEqual(_tree(self.unit_dir), before)

    def test_preflight_refuses_capability_port_failure(self):
        self.capability.fail = "commands"
        before = _tree(self.unit_dir)
        with self.assertRaisesRegex(dc.Refused,
                                    "runtime capability observation failed"):
            self.adapter.preflight("crq-tick.service", NODE_RUNTIME)
        self.assertEqual(_tree(self.unit_dir), before)

    def test_preflight_refuses_completion_sequence_port_failure(self):
        self.completion.fail = "sequence"
        before = _tree(self.unit_dir)
        with self.assertRaisesRegex(dc.Refused,
                                    "completion sequence failed"):
            self.adapter.preflight("crq-tick.service", NODE_RUNTIME)
        self.assertEqual(_tree(self.unit_dir), before)

    def test_default_node_capability_is_empty_and_refuses(self):
        capability = adapter_mod.DeclaredCapabilities()
        self.assertEqual(capability.commands(NODE_RUNTIME), frozenset())
        self.assertEqual(capability.commands("python"),
                         frozenset(host.UNIT_COMMANDS.values()))
        current = self.make_adapter(capability=capability)
        with self.assertRaisesRegex(dc.Refused, "does not implement"):
            current.preflight("crq-tick.service", NODE_RUNTIME)

    def test_preflight_without_completion_refuses_before_mutation(self):
        before = _tree(self.unit_dir)
        current = self.make_adapter(completion=None)
        with self.assertRaisesRegex(dc.Refused, "completion provider"):
            current.preflight("crq-tick.service", NODE_RUNTIME)
        self.assertEqual(_tree(self.unit_dir), before)

    def test_preflight_without_queue_drain_refuses_before_mutation(self):
        before = _tree(self.unit_dir)
        current = self.make_adapter(queue_drain=None)
        with self.assertRaisesRegex(dc.Refused, "queue drain"):
            current.preflight("crq-tick.service", NODE_RUNTIME)
        self.assertEqual(_tree(self.unit_dir), before)

    def test_preflight_refuses_unknown_installed_entry(self):
        (self.unit_dir / "crq-tick.socket").write_text("[Socket]\n")
        with self.assertRaisesRegex(dc.Refused, "outside the declared inventory"):
            self.adapter.preflight("crq-tick.service", NODE_RUNTIME)

    def test_preflight_refuses_foreign_activator(self):
        self.fake.foreign = ["crq-other.timer"]
        with self.assertRaisesRegex(dc.Refused, "foreign activators"):
            self.adapter.preflight("crq-tick.service", NODE_RUNTIME)

    def test_preflight_refuses_incomplete_discovery(self):
        self.fake.incomplete_discovery = True
        with self.assertRaisesRegex(dc.Refused, "complete supported topology"):
            self.adapter.preflight("crq-tick.service", NODE_RUNTIME)

    def test_preflight_refuses_port_failure(self):
        self.fake.fail = "show"
        with self.assertRaisesRegex(dc.Refused, "show failed"):
            self.adapter.preflight("crq-tick.service", NODE_RUNTIME)

    def test_snapshot_round_trip(self):
        snapshot = self.adapter.snapshot("crq-tick.service")
        self.assertEqual(set(snapshot), {
            "schema_version", "unit", "runtime", "paths", "activators"})
        self.assertEqual(snapshot["schema_version"], 1)
        self.assertEqual(snapshot["runtime"], "python")
        self.assertEqual(snapshot["activators"]["timer_active"], "active")
        self.assertEqual(snapshot["activators"]["service_active"], "inactive")
        service = snapshot["paths"][str(self.unit_dir / "crq-tick.service")]
        self.assertEqual(service["type"], "file")
        self.assertEqual(service["mode"], 0o600)
        self.assertEqual(
            service["sha256"],
            hashlib.sha256((self.unit_dir / "crq-tick.service").read_bytes())
            .hexdigest())
        self.adapter.validate_snapshot("crq-tick.service", snapshot)

    def test_snapshot_negative_cases(self):
        snapshot = self.adapter.snapshot("crq-tick.service")
        service = str(self.unit_dir / "crq-tick.service")
        timer = str(self.unit_dir / "crq-tick.timer")
        wants = str(self.unit_dir / "timers.target.wants/crq-tick.timer")

        def mutated(change):
            value = copy.deepcopy(snapshot)
            change(value)
            return value

        cases = {
            "top-level key": lambda s: s.update(extra=True),
            "schema": lambda s: s.update(schema_version=2),
            "unit": lambda s: s.update(unit="crq-slot.service"),
            "runtime": lambda s: s.update(runtime="node:short"),
            "path set": lambda s: s["paths"].pop(service),
            "extra path": lambda s: s["paths"].update({"/tmp/x": {"type": "missing"}}),
            "path type": lambda s: s["paths"][timer].update(type="other"),
            "bytes": lambda s: s["paths"][service].update(bytes_b64=base64.b64encode(b"x").decode()),
            "size": lambda s: s["paths"][service].update(size=1),
            "mode": lambda s: s["paths"][service].update(mode=0o666),
            "uid": lambda s: s["paths"][service].update(uid=1),
            "xattrs": lambda s: s["paths"][service].update(xattrs=["user.x"]),
            "symlink escape": lambda s: s["paths"][wants].update(target="../../etc/passwd"),
            "service mask": lambda s: s["paths"].update({
                service: {"type": "symlink", "mode": 0o777,
                          "uid": os.getuid(), "gid": os.getgid(),
                          "xattrs": [], "target": "/dev/null"}}),
            "activator key": lambda s: s["activators"].pop("timer_active"),
            "activator state": lambda s: s["activators"].update(timer_active="activating"),
            "enablement": lambda s: s["activators"].update(timer_unit_file_state="weird"),
        }
        for name, change in cases.items():
            with self.subTest(name=name), self.assertRaises(dc.Refused):
                self.adapter.validate_snapshot("crq-tick.service",
                                               mutated(change))

    def test_stop_and_drain_refuses_live_job(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        self.fake.jobs_lines = ["42 crq-tick.service start running"]
        with self.assertRaisesRegex(dc.Refused,
                                    "queued or running systemd job remains"):
            current.stop_and_drain("crq-tick.service")
        self.assertTrue((self.unit_dir / "crq-tick.service").is_symlink())

    def test_stop_and_drain_refuses_live_cgroup(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        self.fake.cgroup["crq-tick.service"] = {
            "main_pid": 123, "pids": [123], "cgroup": "/user.slice/crq"}
        with self.assertRaisesRegex(dc.Refused, "owned process remains"):
            current.stop_and_drain("crq-tick.service")

    def test_stop_and_drain_refuses_jobs_failure(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        self.fake.fail = "jobs"
        with self.assertRaisesRegex(dc.Refused, "list-jobs failed"):
            current.stop_and_drain("crq-tick.service")

    def test_stop_and_drain_refuses_queue_ambiguity(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        self.queue = {"drained": False, "blocked": ["pr1"]}
        with self.assertRaisesRegex(dc.Refused, "queue-owned work"):
            current.stop_and_drain("crq-tick.service")

    def test_stop_and_drain_refuses_command_failure(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        self.fake.fail_commands = {"stop"}
        with self.assertRaisesRegex(dc.Refused, "stop did not complete"):
            current.stop_and_drain("crq-tick.service")

    def test_stop_and_drain_refuses_stale_service_bytes_before_fence(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        other = self.python_service("crq-slot.service")["bytes"]
        _write(self.unit_dir / "crq-tick.service", other, 0o600)
        before = _tree(self.unit_dir)
        with self.assertRaisesRegex(dc.Refused,
                                    "service file does not match its snapshot"):
            current.stop_and_drain("crq-tick.service")
        self.assertEqual(_tree(self.unit_dir), before)

    def test_stop_and_drain_refuses_malformed_job_observation(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        self.fake.jobs_lines = ["not-a-systemd-job"]
        with self.assertRaisesRegex(dc.Refused,
                                    "list-jobs observation is malformed"):
            current.stop_and_drain("crq-tick.service")
        self.assertTrue((self.unit_dir / "crq-tick.service").is_symlink())

    def test_stop_and_drain_refuses_unsafe_service_before_mutation(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        (self.unit_dir / "crq-tick.service").chmod(0o666)
        before = _tree(self.unit_dir)
        with self.assertRaisesRegex(dc.Refused, "unsafe to fence"):
            current.stop_and_drain("crq-tick.service")
        self.assertEqual(_tree(self.unit_dir), before)

    def test_stop_and_drain_masks_and_persists(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        evidence = current.stop_and_drain("crq-tick.service")
        service = self.unit_dir / "crq-tick.service"
        self.assertTrue(service.is_symlink())
        self.assertEqual(os.readlink(service), "/dev/null")
        self.assertEqual(evidence["masked"]["LoadState"], "masked")
        self.assertEqual(evidence["queue"]["drained"], True)
        self.assertEqual(self.fake.active["crq-tick.timer"], "inactive")

    def test_install_uses_render_bytes_and_preserves_mode(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        current.stop_and_drain("crq-tick.service")
        calls = len(self.fake.calls)
        install = current.install("crq-tick.service", NODE_RUNTIME)
        staged = Path(install["staged"])
        rendered = self.node_service("crq-tick.service")
        self.assertEqual(staged.read_bytes(), rendered["bytes"])
        self.assertEqual(staged.stat().st_mode & 0o7777, 0o600)
        self.assertTrue((self.unit_dir / "crq-tick.service").is_symlink())
        self.assertEqual(os.readlink(self.unit_dir / "crq-tick.service"),
                         "/dev/null")
        later = self.fake.calls[calls:]
        self.assertFalse([call for call in later if call and call[0] == "start"])

    def test_install_refuses_render_change(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        current.stop_and_drain("crq-tick.service")
        current._rendered[("crq-tick.service", NODE_RUNTIME)]["sha256"] = "0" * 64
        with self.assertRaisesRegex(dc.Refused, "render changed"):
            current.install("crq-tick.service", NODE_RUNTIME)

    def test_install_refuses_foreign_activator_after_drain(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        current.stop_and_drain("crq-tick.service")
        self.fake.foreign = ["crq-other.timer"]
        with self.assertRaisesRegex(dc.Refused, "foreign activators"):
            current.install("crq-tick.service", NODE_RUNTIME)

    def test_start_releases_and_preserves_activator_policy(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        current.stop_and_drain("crq-tick.service")
        current.install("crq-tick.service", NODE_RUNTIME)
        result = current.start("crq-tick.service")
        rendered = self.node_service("crq-tick.service")
        service = self.unit_dir / "crq-tick.service"
        self.assertEqual(service.read_bytes(), rendered["bytes"])
        self.assertEqual(service.stat().st_mode & 0o7777, 0o600)
        self.assertFalse((self.unit_dir / ".crq-tick.service.staged").exists())
        self.assertEqual(self.fake.active["crq-tick.timer"], "active")
        self.assertEqual(result["release_order"], ["service", "timer"])

    def test_start_command_timeout_covers_service_budget(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        current.stop_and_drain("crq-tick.service")
        current.install("crq-tick.service", NODE_RUNTIME)
        self.fake.service_start_delay = 120
        current.start("crq-tick.service")
        self.assertEqual(self.fake.active["crq-tick.service"], "active")
        self.assertEqual(self.fake.active["crq-tick.timer"], "active")

    def test_start_refuses_without_install(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        current.stop_and_drain("crq-tick.service")
        with self.assertRaisesRegex(dc.Refused, "no staged install"):
            current.start("crq-tick.service")

    def test_start_refuses_tampered_staged_metadata_before_release(self):
        current, _prior, snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        current.stop_and_drain("crq-tick.service")
        current.install("crq-tick.service", NODE_RUNTIME)
        staged = self.unit_dir / ".crq-tick.service.staged"
        staged.chmod(0o666)
        calls = len(self.fake.calls)
        with self.assertRaisesRegex(dc.Refused,
                                    "staged target changed before release"):
            current.start("crq-tick.service")
        service = self.unit_dir / "crq-tick.service"
        self.assertTrue(service.is_symlink())
        self.assertEqual(os.readlink(service), "/dev/null")
        self.assertFalse(any(call and call[0] in {"daemon-reload", "start"}
                             for call in self.fake.calls[calls:]))
        # The adapter's rollback path can now drain the mask and restore the
        # prior service; the unsafe staged file never reaches the service path.
        current.stop_and_drain("crq-tick.service")
        restored = current.restore("crq-tick.service", snapshot)
        current.restore_activation("crq-tick.service", snapshot)
        prior = self.python_service("crq-tick.service")
        self.assertEqual(service.read_bytes(), prior["bytes"])
        self.assertEqual(service.stat().st_mode & 0o7777, 0o600)
        self.assertFalse(Path(restored["staged"]).exists())

    def test_completion_binds_file_identity_and_sequence(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        current.stop_and_drain("crq-tick.service")
        current.install("crq-tick.service", NODE_RUNTIME)
        current.start("crq-tick.service")
        first = current.completion("crq-tick.service", NODE_RUNTIME, 0)
        second = current.completion("crq-tick.service", NODE_RUNTIME,
                                    first["sequence"])
        self.assertGreater(second["sequence"], first["sequence"])
        self.assertNotEqual(first["invocation"], second["invocation"])
        service = self.unit_dir / "crq-tick.service"
        self.assertEqual(first["service_sha256"],
                         hashlib.sha256(service.read_bytes()).hexdigest())

    def test_completion_waits_for_a_delayed_provider(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        current.stop_and_drain("crq-tick.service")
        current.install("crq-tick.service", NODE_RUNTIME)
        current.start("crq-tick.service")
        self.completion.read_delay = 2
        record = current.completion("crq-tick.service", NODE_RUNTIME, 0)
        self.assertEqual(record["unit"], "crq-tick.service")
        self.assertEqual(self.completion.read_delay, 0)

    def test_completion_refuses_foreign_evidence(self):
        current, _prior, _snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        current.stop_and_drain("crq-tick.service")
        current.install("crq-tick.service", NODE_RUNTIME)
        current.start("crq-tick.service")
        service = self.unit_dir / "crq-tick.service"
        good = hashlib.sha256(service.read_bytes()).hexdigest()
        cases = {
            "unit": {"unit": "crq-slot.service", "runtime": NODE_RUNTIME,
                     "success": True, "sequence": 1, "invocation": "x",
                     "service_sha256": good},
            "runtime": {"unit": "crq-tick.service", "runtime": "python",
                        "success": True, "sequence": 1, "invocation": "x",
                        "service_sha256": good},
            "success": {"unit": "crq-tick.service", "runtime": NODE_RUNTIME,
                        "success": False, "sequence": 1, "invocation": "x",
                        "service_sha256": good},
            "sequence": {"unit": "crq-tick.service", "runtime": NODE_RUNTIME,
                         "success": True, "sequence": 0, "invocation": "x",
                         "service_sha256": good},
            "invocation": {"unit": "crq-tick.service", "runtime": NODE_RUNTIME,
                           "success": True, "sequence": 1, "invocation": "",
                           "service_sha256": good},
            "digest": {"unit": "crq-tick.service", "runtime": NODE_RUNTIME,
                       "success": True, "sequence": 1, "invocation": "x",
                       "service_sha256": "0" * 64},
            "missing digest": {"unit": "crq-tick.service",
                               "runtime": NODE_RUNTIME, "success": True,
                               "sequence": 1, "invocation": "x"},
        }
        for name, evidence in cases.items():
            with self.subTest(name=name):
                self.completion.override = evidence
                with self.assertRaises(dc.Refused):
                    current.completion("crq-tick.service", NODE_RUNTIME, 0)

    def test_restore_stages_behind_mask_and_releases_only_after_journal(self):
        current, _prior, snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        current.stop_and_drain("crq-tick.service")
        current.install("crq-tick.service", NODE_RUNTIME)
        current.start("crq-tick.service")
        # A recovery starts from a fresh adapter and a new snapshot of the
        # pre-switch state; the controller always re-observes.
        recovery = self.make_adapter()
        recovered_snapshot = snapshot
        recovery.validate_snapshot("crq-tick.service", recovered_snapshot)
        recovery.stop_and_drain("crq-tick.service")
        staged = recovery.restore("crq-tick.service", recovered_snapshot)
        service = self.unit_dir / "crq-tick.service"
        self.assertTrue(service.is_symlink())
        self.assertEqual(os.readlink(service), "/dev/null")
        self.assertTrue(Path(staged["staged"]).is_file())
        self.assertEqual(self.fake.active["crq-tick.timer"], "inactive")
        recovery.restore_activation("crq-tick.service", recovered_snapshot)
        prior = self.python_service("crq-tick.service")
        self.assertEqual(service.read_bytes(), prior["bytes"])
        self.assertEqual(service.stat().st_mode & 0o7777, 0o600)
        self.assertFalse(Path(staged["staged"]).exists())
        self.assertEqual(self.fake.active["crq-tick.timer"], "active")
        self.assertEqual(recovery.last_restore_order, ["service", "timer"])

    def test_restore_activation_applies_service_policy_before_timer(self):
        current = self.make_adapter()
        snapshot = current.snapshot("crq-tick.service")
        current.validate_snapshot("crq-tick.service", snapshot)
        current.stop_and_drain("crq-tick.service")
        current.restore("crq-tick.service", snapshot)
        self.fake.activator_starts_service = True
        calls = len(self.fake.calls)
        result = current.restore_activation("crq-tick.service", snapshot)
        self.assertEqual(result["restore_order"], ["service", "timer"])
        self.assertEqual(self.fake.active["crq-tick.service"], "active")
        after = self.fake.calls[calls:]
        timer_start = next(
            index for index, call in enumerate(after)
            if call[:2] == ["start", "crq-tick.timer"])
        service_stops = [
            index for index, call in enumerate(after)
            if call[:2] == ["stop", "crq-tick.service"]]
        self.assertTrue(service_stops)
        self.assertLess(max(service_stops), timer_start)
        self.assertFalse(any(
            call[:2] == ["stop", "crq-tick.service"]
            for call in after[timer_start:]))

    def test_restore_activation_applies_service_policy_before_path(self):
        current = self.make_adapter()
        snapshot = current.snapshot("crq-publisher.service")
        current.validate_snapshot("crq-publisher.service", snapshot)
        current.stop_and_drain("crq-publisher.service")
        current.restore("crq-publisher.service", snapshot)
        self.fake.activator_starts_service = True
        calls = len(self.fake.calls)
        result = current.restore_activation("crq-publisher.service", snapshot)
        self.assertEqual(result["restore_order"],
                         ["service", "timer", "path"])
        self.assertEqual(self.fake.active["crq-publisher.service"], "active")
        after = self.fake.calls[calls:]
        path_start = next(
            index for index, call in enumerate(after)
            if call[:2] == ["start", "crq-publisher.path"])
        service_stops = [
            index for index, call in enumerate(after)
            if call[:2] == ["stop", "crq-publisher.service"]]
        self.assertTrue(service_stops)
        self.assertLess(max(service_stops), path_start)
        self.assertFalse(any(
            call[:2] == ["stop", "crq-publisher.service"]
            for call in after[path_start:]))

    def test_restore_refuses_without_mask(self):
        current, _prior, snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        with self.assertRaisesRegex(dc.Refused, "durable service mask"):
            current.restore("crq-tick.service", snapshot)

    def test_restore_activation_refuses_without_restore(self):
        current, _prior, snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        with self.assertRaisesRegex(dc.Refused, "no staged restore"):
            current.restore_activation("crq-tick.service", snapshot)

    def test_restore_activation_refuses_failed_simple_service(self):
        self.fake.active["crq-repair.service"] = "active"
        current = self.make_adapter()
        snapshot = current.snapshot("crq-repair.service")
        current.validate_snapshot("crq-repair.service", snapshot)
        current.stop_and_drain("crq-repair.service")
        current.restore("crq-repair.service", snapshot)
        self.fake.post_start_state["crq-repair.service"] = "failed"
        with self.assertRaisesRegex(dc.Refused, "restored service is failed"):
            current.restore_activation("crq-repair.service", snapshot)

    def test_restore_activation_command_timeout_covers_service_budget(self):
        self.fake.active["crq-tick.service"] = "active"
        current, _prior, snapshot = self.switch_ready(
            "crq-tick.service", NODE_RUNTIME)
        current.stop_and_drain("crq-tick.service")
        current.install("crq-tick.service", NODE_RUNTIME)
        current.start("crq-tick.service")
        recovery = self.make_adapter()
        recovery.validate_snapshot("crq-tick.service", snapshot)
        recovery.stop_and_drain("crq-tick.service")
        recovery.restore("crq-tick.service", snapshot)
        self.fake.service_start_delay = 120
        recovery.restore_activation("crq-tick.service", snapshot)
        self.assertEqual(self.fake.active["crq-tick.service"], "active")
        self.assertEqual(self.fake.active["crq-tick.timer"], "active")

    def test_forward_and_recovery_for_both_runtimes(self):
        cases = [
            ("crq-tick.service", NODE_RUNTIME, "python", 0o600),
            ("crq-slot.service", "python", NODE_RUNTIME, 0o644),
        ]
        for unit, requested, prior_runtime, mode in cases:
            with self.subTest(unit=unit, requested=requested):
                if prior_runtime == NODE_RUNTIME:
                    rendered = self.node_service(unit)
                    _write(self.unit_dir / unit, rendered["bytes"], mode)
                else:
                    rendered = self.python_service(unit)
                    _write(self.unit_dir / unit, rendered["bytes"], mode)
                current = self.make_adapter()
                preflight = current.preflight(unit, requested)
                self.assertEqual(preflight["runtime"], prior_runtime)
                snapshot = current.snapshot(unit)
                current.validate_snapshot(unit, snapshot)
                current.stop_and_drain(unit)
                current.install(unit, requested)
                current.start(unit)
                first = current.completion(unit, requested, 0)
                current.completion(unit, requested, first["sequence"])
                expected = (self.node_service(unit) if requested == NODE_RUNTIME
                            else self.python_service(unit))
                self.assertEqual((self.unit_dir / unit).read_bytes(),
                                 expected["bytes"])
                recovery = self.make_adapter()
                recovery.validate_snapshot(unit, snapshot)
                recovery.stop_and_drain(unit)
                recovery.restore(unit, snapshot)
                recovery.restore_activation(unit, snapshot)
                self.assertEqual((self.unit_dir / unit).read_bytes(),
                                 rendered["bytes"])
                self.assertEqual((self.unit_dir / unit).stat().st_mode & 0o7777,
                                 mode)


class ControllerIntegrationTests(AdapterFixture):
    def setUp(self):
        super().setUp()
        self.rendered()

    def records(self):
        return sorted(self.record_dir.glob("controller-*.json"))

    def test_switch_unit_completes_with_injected_ports(self):
        record = dc.switch_unit(self.effects, self.adapter,
                                "crq-tick.service", NODE_RUNTIME)
        self.assertEqual(record["outcome"], "completed")
        self.assertEqual(record["runtime"], NODE_RUNTIME)
        self.assertEqual(record["prior_runtime"], "python")
        self.assertEqual(len(record["completions"]), 2)
        self.assertGreater(record["completions"][1]["sequence"],
                           record["completions"][0]["sequence"])
        service = self.unit_dir / "crq-tick.service"
        self.assertEqual(service.read_bytes(),
                         self.node_service("crq-tick.service")["bytes"])
        self.assertEqual(service.stat().st_mode & 0o7777, 0o600)
        self.assertEqual(self.fake.active["crq-tick.timer"], "active")
        journal = [json.loads(path.read_text()) for path in self.records()]
        self.assertEqual(len(journal), 1)
        self.assertEqual(journal[0]["phase"], "activation_pending")
        self.assertEqual(journal[0]["outcome"], "completed")

    def test_switch_unit_refuses_before_journal_without_completion(self):
        before = _tree(self.unit_dir)
        current = self.make_adapter(completion=None)
        with self.assertRaises(dc.Refused):
            dc.switch_unit(self.effects, current, "crq-tick.service",
                           NODE_RUNTIME)
        self.assertEqual(self.records(), [])
        self.assertEqual(_tree(self.unit_dir), before)

    def test_switch_unit_leaves_safe_mask_on_tampered_staged_file(self):
        current = self.make_adapter()
        install = current.install

        def install_then_tamper(unit, runtime):
            result = install(unit, runtime)
            (self.unit_dir / ("." + unit + ".staged")).chmod(0o666)
            return result

        current.install = install_then_tamper
        with self.assertRaises(dc.RecoveryRequired) as failure:
            dc.switch_unit(self.effects, current, "crq-tick.service",
                           NODE_RUNTIME)
        recovery = failure.exception.recovery
        self.assertEqual(recovery["outcome"], "recovery_required")
        path = Path(recovery["record_path"])
        service = self.unit_dir / "crq-tick.service"
        self.assertTrue(service.is_symlink())
        self.assertEqual(os.readlink(service), "/dev/null")
        # The controller refuses to auto-restore from activation_pending; the
        # durable mask remains the safe recovery anchor rather than an unsafe
        # installed service.
        with self.assertRaises(dc.RecoveryRequired) as blocked:
            dc.recover_unit(self.effects, self.make_adapter(), path)
        self.assertIn("activation may have occurred",
                      str(blocked.exception))
        self.assertTrue(service.is_symlink())
        self.assertEqual(os.readlink(service), "/dev/null")

    def test_recover_unit_restores_prior_service(self):
        current = self.make_adapter()
        snapshot = current.snapshot("crq-tick.service")
        current.validate_snapshot("crq-tick.service", snapshot)
        # Simulate an interrupted switch that reached the drained phase.
        current.stop_and_drain("crq-tick.service")
        state = dc.captured_state(self.effects)
        txid = "a" * 32
        record = {
            "schema_version": dc.JOURNAL_SCHEMA,
            "transaction_id": txid,
            "operation": "unit_switch",
            "unit": "crq-tick.service",
            "runtime": NODE_RUNTIME,
            "prior_runtime": "python",
            "outcome": "pending",
            "at": "2026-11-12T00:00:00Z",
            "snapshot": snapshot,
            "state": state,
            "phase": "drained",
        }
        path = self.record_dir / ("controller-" + txid + ".json")
        path.write_text(json.dumps(record))
        recovery = self.make_adapter()
        completed = dc.recover_unit(self.effects, recovery, path)
        self.assertEqual(completed["outcome"], "rolled_back")
        service = self.unit_dir / "crq-tick.service"
        self.assertEqual(service.read_bytes(),
                         self.python_service("crq-tick.service")["bytes"])
        self.assertEqual(service.stat().st_mode & 0o7777, 0o600)
        self.assertEqual(self.fake.active["crq-tick.timer"], "active")
        self.assertFalse(
            (self.unit_dir / ".crq-tick.service.staged").exists())
        final = json.loads(path.read_text())
        self.assertEqual(final["phase"], "restore_activation_pending")
        self.assertEqual(final["outcome"], "rolled_back")


if __name__ == "__main__":
    unittest.main()
