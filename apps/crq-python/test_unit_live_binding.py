"""Tests for the unwired live host binding.

Real bounded subprocess reads, real temporary unit directories, real cgroup
files, real Git roots and real controller lock files are used. Only the
``systemctl`` process runner is injected, because no test may talk to the host
manager. The final test drives the real ``ProductionUnitAdapter`` through the
actual ``deploy_controller.switch_unit`` seam and asserts a discovery refusal
before any journal or unit mutation.
"""
import importlib.util
import os
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from test_deploy_controller_fixtures import ControllerFixture, dc
from test_unit_adapter import LiveIdentity, _write
from test_unit_switch_factory import FactoryFixture, UNIT

ROOT = Path(__file__).resolve().parent
OPS = ROOT / "ops"


def _load(name, path):
    module = sys.modules.get(name)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


live = _load("crq_unit_live_binding_test", OPS / "unit-live-binding.py")


def empty_result(command):
    return {"rc": 0, "stdout": "", "stderr": "", "timeout": False}


class PortFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.unit_dir = self.base / "systemd/user"
        self.unit_dir.mkdir(parents=True)
        self.calls = []

    def port(self, handler=None, **options):
        handler = handler or empty_result

        def runner(command, timeout):
            self.calls.append((list(command), timeout))
            return handler(command)

        return live.SubprocessSystemd(
            unit_dir=self.unit_dir, runner=runner, **options)

    def write(self, name, text, mode=0o644):
        path = self.unit_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        path.chmod(mode)
        return path

    def link(self, rel, target):
        path = self.unit_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(target)
        return path


class CommandTests(PortFixture):
    def test_run_uses_the_actual_command_shape(self):
        port = self.port()
        result = port.run("stop", "crq-tick.service", timeout=5)
        self.assertEqual(self.calls, [([
            "systemctl", "--user", "--no-pager", "stop",
            "crq-tick.service"], 5.0)])
        self.assertEqual(result, {"rc": 0, "stdout": "", "stderr": "",
                                  "timeout": False})

    def test_run_refuses_an_unsafe_argument(self):
        port = self.port()
        with self.assertRaises(live.LiveBindingRefused):
            port.run("stop", "crq-tick.service; rm -rf /")

    def test_timeout_must_be_finite_positive_and_numeric(self):
        invalid = (True, False, "5", 0, -1, float("nan"),
                   float("inf"), float("-inf"), 10 ** 1000)
        for value in invalid:
            with self.subTest(value=repr(value)):
                with self.assertRaises(live.LiveBindingRefused):
                    live.SubprocessSystemd(timeout=value)
                with self.assertRaises(live.LiveBindingRefused):
                    self.port().run("stop", "crq-tick.service", timeout=value)
        with self.assertRaises(live.LiveBindingRefused):
            live.SubprocessSystemd(timeout=None)
        self.assertEqual(
            live.SubprocessSystemd(timeout=5).timeout, 5.0)
        self.assertEqual(
            live.SubprocessSystemd(timeout=0.2).timeout, 0.2)

    def test_run_refuses_an_unreadable_runner_result(self):
        port = self.port(lambda command: {"stdout": ""})
        with self.assertRaises(live.LiveBindingRefused):
            port.run("daemon-reload")

    def test_show_parses_properties_and_command_shape(self):
        port = self.port(lambda command: {
            "rc": 0, "stdout": "ActiveState=inactive\nSubState=dead\n",
            "stderr": "", "timeout": False})
        values = port.show("crq-tick.service", ["ActiveState", "SubState"])
        self.assertEqual(values, {"ActiveState": "inactive",
                                  "SubState": "dead"})
        self.assertEqual(self.calls[0][0], [
            "systemctl", "--user", "--no-pager", "show",
            "crq-tick.service", "--property", "ActiveState",
            "--property", "SubState"])

    def test_show_refuses_a_missing_property(self):
        port = self.port(lambda command: {
            "rc": 0, "stdout": "ActiveState=inactive\n",
            "stderr": "", "timeout": False})
        with self.assertRaises(live.LiveBindingRefused):
            port.show("crq-tick.service", ["ActiveState", "SubState"])

    def test_show_refuses_a_duplicate_property(self):
        port = self.port(lambda command: {
            "rc": 0, "stdout": "ActiveState=inactive\nActiveState=inactive\n",
            "stderr": "", "timeout": False})
        with self.assertRaises(live.LiveBindingRefused):
            port.show("crq-tick.service", ["ActiveState"])

    def test_show_refuses_a_failed_command(self):
        port = self.port(lambda command: {
            "rc": 1, "stdout": "", "stderr": "user bus is unavailable",
            "timeout": False})
        with self.assertRaises(live.LiveBindingRefused) as caught:
            port.show("crq-tick.service", ["ActiveState"])
        self.assertIn("user bus is unavailable", str(caught.exception))

    def test_show_accepts_activator_units(self):
        port = self.port(lambda command: {
            "rc": 0, "stdout": "ActiveState=active\n",
            "stderr": "", "timeout": False})
        for unit in ("crq-tick.timer", "crq-tick.path", "crq-tick.socket"):
            self.assertEqual(port.show(unit, ["ActiveState"]),
                             {"ActiveState": "active"})
        self.assertEqual([call[0][4] for call in self.calls],
                         ["crq-tick.timer", "crq-tick.path",
                          "crq-tick.socket"])

    def test_show_refuses_unsupported_unit_types(self):
        port = self.port()
        for unit in ("crq-tick.mount", "crq-tick.swap", "crq-tick.slice",
                     "crq-tick"):
            with self.assertRaises(live.LiveBindingRefused) as raised:
                port.show(unit, ["ActiveState"])
            self.assertEqual(str(raised.exception), "invalid unit name")
        self.assertEqual(self.calls, [])

    def test_jobs_returns_list_jobs_lines(self):
        port = self.port(lambda command: {
            "rc": 0, "stdout": "17 crq-tick.service start running\n",
            "stderr": "", "timeout": False})
        self.assertEqual(port.jobs(),
                         ["17 crq-tick.service start running"])
        self.assertEqual(self.calls[0][0], [
            "systemctl", "--user", "--no-pager", "list-jobs",
            "--no-legend"])

    def test_default_runner_uses_the_real_bounded_reader(self):
        script = self.base / "fake-systemctl"
        script.write_text("#!/bin/sh\necho out\necho err >&2\nexit 3\n")
        script.chmod(0o755)
        port = live.SubprocessSystemd(systemctl=str(script))
        result = port.run("stop", "crq-tick.service")
        self.assertEqual(result["rc"], 3)
        self.assertEqual(result["stdout"], "out\n")
        self.assertEqual(result["stderr"], "err\n")
        self.assertIs(result["timeout"], False)

    def test_default_runner_refuses_oversized_output(self):
        script = self.base / "noisy-systemctl"
        script.write_text("#!/bin/sh\nexec head -c 4096 /dev/zero\n")
        script.chmod(0o755)
        port = live.SubprocessSystemd(systemctl=str(script), max_bytes=128)
        with self.assertRaises(live.LiveBindingRefused):
            port.run("daemon-reload")

    def test_default_runner_refuses_non_utf8_output(self):
        script = self.base / "binary-systemctl"
        script.write_text("#!/bin/sh\nprintf '\\377'\n")
        script.chmod(0o755)
        port = live.SubprocessSystemd(systemctl=str(script))
        with self.assertRaises(live.LiveBindingRefused):
            port.run("daemon-reload")

    def test_default_runner_marks_a_timeout(self):
        script = self.base / "slow-systemctl"
        script.write_text("#!/bin/sh\nexec sleep 5\n")
        script.chmod(0o755)
        port = live.SubprocessSystemd(systemctl=str(script), timeout=0.2)
        result = port.run("daemon-reload")
        self.assertIs(result["timeout"], True)
        self.assertNotEqual(result["rc"], 0)


class CgroupTests(PortFixture):
    def setUp(self):
        super().setUp()
        self.cgroup_root = self.base / "cgroup"
        self.cgroup_root.mkdir()

    def cgroup(self, rel, pids):
        path = self.cgroup_root / rel
        path.mkdir(parents=True, exist_ok=True)
        (path / "cgroup.procs").write_text(
            "".join("%d\n" % pid for pid in pids))
        return path

    def show(self, main_pid, control_group):
        def handler(command):
            self.assertEqual(command[3], "show")
            return {"rc": 0,
                    "stdout": "MainPID=%d\nControlGroup=%s\n"
                              % (main_pid, control_group),
                    "stderr": "", "timeout": False}
        return handler

    def test_reads_and_deduplicates_real_cgroup_procs(self):
        self.cgroup("user.slice/crq-tick.service", [123, 456, 123])
        port = self.port(self.show(123, "/user.slice/crq-tick.service"),
                         cgroup_root=self.cgroup_root)
        self.assertEqual(
            port.cgroup_pids("crq-tick.service"),
            {"main_pid": 123, "pids": [123, 456],
             "cgroup": "/user.slice/crq-tick.service"})

    def test_empty_control_group_has_no_pids(self):
        port = self.port(self.show(0, ""), cgroup_root=self.cgroup_root)
        self.assertEqual(port.cgroup_pids("crq-tick.service"),
                         {"main_pid": 0, "pids": [], "cgroup": ""})

    def test_empty_control_group_for_a_running_main_process_refuses(self):
        port = self.port(self.show(123, ""), cgroup_root=self.cgroup_root)
        with self.assertRaises(live.LiveBindingRefused):
            port.cgroup_pids("crq-tick.service")

    def test_missing_procs_for_an_empty_group_is_empty(self):
        port = self.port(self.show(0, "/user.slice/empty.service"),
                         cgroup_root=self.cgroup_root)
        self.assertEqual(port.cgroup_pids("crq-tick.service"),
                         {"main_pid": 0, "pids": [],
                          "cgroup": "/user.slice/empty.service"})

    def test_missing_procs_for_a_running_main_process_refuses(self):
        port = self.port(self.show(123, "/user.slice/empty.service"),
                         cgroup_root=self.cgroup_root)
        with self.assertRaises(live.LiveBindingRefused):
            port.cgroup_pids("crq-tick.service")

    def test_parent_traversal_in_control_group_refuses(self):
        port = self.port(self.show(123, "/../../etc"),
                         cgroup_root=self.cgroup_root)
        with self.assertRaises(live.LiveBindingRefused):
            port.cgroup_pids("crq-tick.service")

    def test_symlinked_cgroup_escape_refuses(self):
        outside = self.base / "outside"
        outside.mkdir()
        (self.cgroup_root / "user.slice").symlink_to(outside)
        port = self.port(self.show(123, "/user.slice/crq-tick.service"),
                         cgroup_root=self.cgroup_root)
        with self.assertRaises(live.LiveBindingRefused):
            port.cgroup_pids("crq-tick.service")

    def test_non_pid_line_refuses(self):
        path = self.cgroup("user.slice/crq-tick.service", [])
        (path / "cgroup.procs").write_text("not-a-pid\n")
        port = self.port(self.show(123, "/user.slice/crq-tick.service"),
                         cgroup_root=self.cgroup_root)
        with self.assertRaises(live.LiveBindingRefused):
            port.cgroup_pids("crq-tick.service")


class DiscoveryTests(PortFixture):
    def declare(self):
        service = self.write("crq-tick.service",
                             "[Service]\nExecStart=/bin/true\n")
        timer = self.write("crq-tick.timer",
                           "[Timer]\nOnCalendar=*:0/12\n")
        wants = self.link("timers.target.wants/crq-tick.timer",
                          self.unit_dir / "crq-tick.timer")
        return [service, timer, wants]

    def discover(self, declared, handler=None):
        port = self.port(handler)
        return port.discover("crq-tick.service",
                             [str(path) for path in declared])

    def test_clean_declared_topology_is_complete_and_supported(self):
        declared = self.declare()
        evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], True)
        self.assertEqual(evidence["supported"], True)
        self.assertIsNone(evidence["error"])
        self.assertEqual(evidence["foreign"], [])
        self.assertEqual(evidence["jobs"], [])
        self.assertEqual(set(evidence["units"]),
                         {"crq-tick.service", "crq-tick.timer"})
        self.assertEqual(set(evidence["paths"]),
                         {str(path) for path in declared})
        self.assertEqual(evidence["paths"][str(declared[0])]["type"], "file")
        self.assertEqual(evidence["paths"][str(declared[2])]["type"],
                         "symlink")
        self.assertEqual(self.calls[0][0], [
            "systemctl", "--user", "--no-pager", "list-unit-files",
            "--no-legend", "--plain", "crq-tick*"])

    def test_undeclared_units_of_another_crq_group_are_supported(self):
        declared = self.declare()
        self.write("crq-publisher.timer",
                   "[Timer]\nUnit=crq-publisher.service\n")
        self.write("crq-publisher.path",
                   "[Path]\nWants=crq-publisher.service\n")
        evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], True)
        self.assertEqual(evidence["supported"], True)
        self.assertEqual(evidence["foreign"], [])

    def test_declared_foreign_dependency_reference_is_unsupported(self):
        declared = self.declare()
        declared.append(self.write("crq-tick.path",
                                   "[Path]\nWants=crq-slot.service\n"))
        evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], True)
        self.assertEqual(evidence["supported"], False)
        self.assertIn("crq-slot.service", " ".join(evidence["foreign"]))
        self.assertIn("crq-tick.path", evidence["error"])

    def test_dropin_directory_is_unsupported(self):
        declared = self.declare()
        dropin = self.unit_dir / "crq-tick.service.d"
        dropin.mkdir()
        (dropin / "override.conf").write_text("[Service]\nNice=5\n")
        evidence = self.discover(declared)
        self.assertEqual(evidence["supported"], False)
        self.assertIn("drop-in", " ".join(evidence["foreign"]))

    def test_dash_prefix_dropin_directory_is_unsupported(self):
        declared = self.declare()
        dropin = self.unit_dir / "crq-.service.d"
        dropin.mkdir()
        (dropin / "override.conf").write_text("[Service]\nNice=5\n")
        evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], True)
        self.assertEqual(evidence["supported"], False)
        self.assertIn("drop-in", " ".join(evidence["foreign"]))

    def test_type_wide_dropin_directory_is_unsupported(self):
        declared = self.declare()
        dropin = self.unit_dir / "service.d"
        dropin.mkdir()
        (dropin / "override.conf").write_text("[Service]\nNice=5\n")
        evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], True)
        self.assertEqual(evidence["supported"], False)
        self.assertIn("drop-in", " ".join(evidence["foreign"]))

    def test_symlinked_shared_dropin_directory_is_unsupported(self):
        declared = self.declare()
        held = self.unit_dir / "held-shared-dropin"
        held.mkdir()
        (held / "override.conf").write_text("[Service]\nNice=5\n")
        (self.unit_dir / "crq-.service.d").symlink_to(held)
        evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], True)
        self.assertEqual(evidence["supported"], False)
        self.assertIn("drop-in", " ".join(evidence["foreign"]))

    def test_symlinked_dropin_directory_is_not_scanned_as_a_dropin(self):
        declared = self.declare()
        held = self.unit_dir / "held-dropin"
        held.mkdir()
        (held / "override.conf").write_text("[Service]\nNice=5\n")
        (self.unit_dir / "crq-tick.service.d").symlink_to(held)
        evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], True)
        self.assertNotIn("drop-in", " ".join(evidence["foreign"]))

    def test_dangling_symlink_entry_is_not_a_dropin_directory(self):
        declared = self.declare()
        (self.unit_dir / "crq-tick.service.d").symlink_to("gone")
        evidence = self.discover(declared)
        self.assertNotIn("drop-in", " ".join(evidence["foreign"]))
        self.assertEqual(evidence["complete"], False)
        self.assertIn("cannot resolve a symlink", evidence["error"])

    def test_unreadable_enablement_entry_is_incomplete(self):
        declared = self.declare()
        wants = self.unit_dir / "timers.target.wants"
        real_stat = os.stat

        def failing_stat(path, *args, **kwargs):
            if path == wants:
                raise OSError("injected stat failure")
            return real_stat(path, *args, **kwargs)

        with mock.patch.object(live.os, "stat", failing_stat):
            evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], False)
        self.assertIn("unreadable", evidence["error"])
        self.assertIn(str(wants), evidence["error"])

    def test_unreadable_unrelated_entry_is_not_reported(self):
        declared = self.declare()
        unrelated = self.write("other.service", "[Service]\n")
        real_stat = os.stat

        def failing_stat(path, *args, **kwargs):
            if path == unrelated:
                raise OSError("injected stat failure")
            return real_stat(path, *args, **kwargs)

        with mock.patch.object(live.os, "stat", failing_stat):
            evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], True)
        self.assertIsNone(evidence["error"])
        self.assertEqual(evidence["foreign"], [])

    def test_extra_prefix_entry_is_unsupported(self):
        declared = self.declare()
        self.write("crq-tick.socket", "[Socket]\n")
        evidence = self.discover(declared)
        self.assertEqual(evidence["supported"], False)
        self.assertIn("crq-tick.socket", " ".join(evidence["foreign"]))

    def test_listing_failure_is_incomplete(self):
        declared = self.declare()

        def handler(command):
            if "list-unit-files" in command:
                return {"rc": 1, "stdout": "",
                        "stderr": "user bus is unavailable", "timeout": False}
            return empty_result(command)

        evidence = self.discover(declared, handler)
        self.assertEqual(evidence["complete"], False)
        self.assertEqual(evidence["supported"], False)
        self.assertIn("user bus is unavailable", evidence["error"])

    def test_unit_directory_scan_bound_is_incomplete(self):
        declared = self.declare()
        with mock.patch.object(live, "MAX_UNIT_ENTRIES", 1):
            evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], False)
        self.assertEqual(evidence["supported"], False)
        self.assertIn("scan bound", evidence["error"])

    def test_foreign_unit_directives_are_unsupported(self):
        declared = self.declare()
        self.write("crq-tick.timer",
                   "[Timer]\nOnCalendar=*:0/12\nUnit=crq-slot.service\n")
        self.write("crq-tick.service",
                   "[Service]\nExecStart=/bin/true\nPartOf=crq-slot.service\n")
        evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], True)
        self.assertEqual(evidence["supported"], False)
        foreign = " ".join(evidence["foreign"])
        self.assertIn("Unit names crq-slot.service", foreign)
        self.assertIn("PartOf names crq-slot.service", foreign)

    def test_foreign_unit_targeting_the_declared_service_is_unsupported(self):
        declared = self.declare()
        self.write("evil.timer", "[Timer]\nUnit=crq-tick.service\n")
        self.write("evil.service", "[Unit]\nPartOf=crq-tick.service\n")
        evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], True)
        self.assertEqual(evidence["supported"], False)
        foreign = " ".join(evidence["foreign"])
        self.assertIn("Unit names crq-tick.service", foreign)
        self.assertIn("PartOf names crq-tick.service", foreign)

    def test_declared_source_may_name_expected_units(self):
        declared = self.declare()
        self.write("crq-tick.timer",
                   "[Timer]\nOnCalendar=*:0/12\nUnit=crq-tick.service\n")
        evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], True)
        self.assertEqual(evidence["supported"], True)
        self.assertEqual(evidence["foreign"], [])

    def test_unreadable_directory_is_incomplete(self):
        if os.geteuid() == 0:
            self.skipTest("root can read a mode-000 directory")
        declared = self.declare()
        hidden = self.unit_dir / "hidden.d"
        hidden.mkdir()
        hidden.chmod(0o000)
        self.addCleanup(hidden.chmod, 0o700)
        evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], False)
        self.assertEqual(evidence["supported"], False)
        self.assertIn("unreadable", evidence["error"])

    def test_dependency_scan_bound_is_incomplete(self):
        declared = self.declare()
        for index in range(3):
            self.write("other%d.service" % index, "[Service]\n")
        with mock.patch.object(live, "MAX_SCAN_ENTRIES", 1):
            evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], False)
        self.assertEqual(evidence["supported"], False)
        self.assertIn("dependency scan bound", evidence["error"])

    def test_symlink_outside_the_unit_directory_is_incomplete(self):
        declared = self.declare()
        outside = self.base / "outside.service"
        outside.write_text("[Unit]\nWants=crq-slot.service\n")
        (self.unit_dir / "foreign.service").symlink_to(outside)
        evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], False)
        self.assertEqual(evidence["supported"], False)
        self.assertIn("symlink outside", evidence["error"])

    def test_symlink_loop_is_incomplete(self):
        declared = self.declare()
        (self.unit_dir / "loop.service").symlink_to("loop.service")
        evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], False)
        self.assertEqual(evidence["supported"], False)
        self.assertIn("cannot resolve a symlink", evidence["error"])

    def test_dev_null_mask_is_not_a_dependency_source(self):
        declared = self.declare()
        (self.unit_dir / "foreign.service").symlink_to(os.devnull)
        evidence = self.discover(declared)
        self.assertEqual(evidence["complete"], True)
        self.assertEqual(evidence["supported"], True)

    def test_malformed_job_line_is_incomplete(self):
        declared = self.declare()

        def handler(command):
            if "list-jobs" in command:
                return {"rc": 0, "stdout": "not a job line\n",
                        "stderr": "", "timeout": False}
            return empty_result(command)

        evidence = self.discover(declared, handler)
        self.assertEqual(evidence["complete"], False)
        self.assertIn("malformed", evidence["error"])

    def test_declared_path_outside_the_unit_directory_refuses(self):
        with self.assertRaises(live.LiveBindingRefused):
            self.port().discover("crq-tick.service", ["/etc/passwd"])

    def test_missing_timer_makes_the_topology_unsupported(self):
        service = self.write("crq-tick.service", "[Service]\n")
        evidence = self.port().discover(
            "crq-tick.service", [str(service)])
        self.assertEqual(evidence["complete"], False)
        self.assertEqual(evidence["supported"], False)
        self.assertIn("timer", evidence["error"])

    def test_directory_at_a_declared_path_is_unsupported(self):
        service = self.write("crq-tick.service", "[Service]\n")
        timer = self.unit_dir / "crq-tick.timer"
        timer.mkdir()
        evidence = self.port().discover(
            "crq-tick.service", [str(service), str(timer)])
        self.assertEqual(evidence["paths"][str(timer)]["type"], "other")
        self.assertEqual(evidence["supported"], False)
        self.assertIn("not a file or symlink", evidence["error"])


class IdentityTests(unittest.TestCase):
    def test_reports_the_effective_identity(self):
        identity = live.ProcessIdentity()
        self.assertEqual(identity.uid, os.getuid())
        self.assertEqual(identity.gid, os.getgid())

    def test_xattrs_are_sorted_and_unsupported_is_empty(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "unit"
            path.write_text("x")
            names = live.ProcessIdentity().xattrs(path)
            self.assertEqual(names, sorted(names))


class LayoutTests(ControllerFixture):
    def setUp(self):
        super().setUp()
        self.overlay_records = Path(self.overlay["record_dir"])
        self.overlay_records.mkdir(mode=0o700)
        self.overlay_records.chmod(0o700)
        self.layout = live.HostLayout.from_overlay(self.root, self.overlay)

    def test_binds_root_unit_directory_and_record_inode(self):
        observed = self.layout.validate()
        self.assertEqual(observed["root"], str(self.root.resolve()))
        self.assertEqual(observed["unit_dir"], str(self.units_home))
        self.assertEqual(observed["record"]["ino"],
                         self.overlay_records.stat().st_ino)
        self.assertEqual(observed["lock"]["exists"], False)

    def test_refuses_a_record_directory_not_named_by_the_overlay(self):
        broken = replace(self.layout, record_dir=self.record_dir)
        with self.assertRaises(live.LiveBindingRefused):
            broken.validate()

    def test_refuses_a_record_directory_with_the_wrong_mode(self):
        self.overlay_records.chmod(0o755)
        with self.assertRaises(live.LiveBindingRefused):
            self.layout.validate()

    def test_refuses_a_symlinked_record_directory(self):
        real = self.base / "real-records"
        self.overlay_records.rename(real)
        self.overlay_records.symlink_to(real)
        with self.assertRaises(live.LiveBindingRefused):
            self.layout.validate()

    def test_accepts_a_lock_created_under_a_permissive_umask(self):
        # The writer and this reader must agree under an operator umask 002,
        # not only under systemd's 022 (guest proof 20261112T214654Z).
        previous = os.umask(0o002)
        try:
            with self.effects.controller_lock():
                pass
        finally:
            os.umask(previous)
        observed = self.layout.lock_identity()
        self.assertEqual(observed["exists"], True)
        self.assertEqual(observed["mode"], 0o600)

    def test_accepts_a_normalised_preexisting_group_readable_lock(self):
        state = self.root / "apps/crq-python/state"
        state.mkdir(parents=True, exist_ok=True)
        lock = state / dc.LOCK_NAME
        lock.write_text("")
        lock.chmod(0o664)
        with self.effects.controller_lock():
            pass
        observed = self.layout.lock_identity()
        self.assertEqual(observed["exists"], True)
        self.assertEqual(observed["mode"], 0o600)

    def test_lock_identity_is_stable_for_one_root_and_differs_for_another(self):
        with self.effects.controller_lock():
            pass
        first = self.layout.lock_identity()
        self.assertEqual(first["exists"], True)
        second = live.HostLayout.from_overlay(
            self.root, self.overlay).lock_identity()
        self.assertEqual((first["dev"], first["ino"]),
                         (second["dev"], second["ino"]))
        other_root = self.base / "other-root"
        state = other_root / "apps/crq-python/state"
        state.mkdir(parents=True)
        (state / dc.LOCK_NAME).write_text("")
        other = live.HostLayout(
            root=other_root, unit_dir=self.units_home,
            record_dir=self.overlay_records, overlay=self.overlay)
        observed = other.lock_identity()
        self.assertNotEqual((first["dev"], first["ino"]),
                            (observed["dev"], observed["ino"]))

    def test_an_absent_lock_is_reported_without_being_created(self):
        other_root = self.base / "unlocked-root"
        other_root.mkdir()
        layout = live.HostLayout(
            root=other_root, unit_dir=self.units_home,
            record_dir=self.overlay_records, overlay=self.overlay)
        observed = layout.lock_identity()
        self.assertEqual(observed["exists"], False)
        self.assertFalse((other_root / "apps/crq-python/state"
                          / dc.LOCK_NAME).exists())

    def test_refuses_a_symlinked_lock(self):
        state = self.root / "apps/crq-python/state"
        state.mkdir(parents=True, exist_ok=True)
        lock = state / dc.LOCK_NAME
        if lock.exists() or lock.is_symlink():
            lock.unlink()
        lock.symlink_to("/dev/null")
        with self.assertRaises(live.LiveBindingRefused):
            self.layout.lock_identity()

    def test_refuses_a_group_or_world_writable_lock(self):
        state = self.root / "apps/crq-python/state"
        state.mkdir(parents=True, exist_ok=True)
        lock = state / dc.LOCK_NAME
        if lock.exists() or lock.is_symlink():
            lock.unlink()
        lock.write_text("")
        lock.chmod(0o666)
        with self.assertRaises(live.LiveBindingRefused):
            self.layout.lock_identity()

    def test_refuses_a_state_directory_that_leaves_the_root(self):
        other_root = self.base / "state-escape-root"
        (other_root / "apps/crq-python").mkdir(parents=True)
        outside = self.base / "outside-state"
        outside.mkdir()
        (other_root / "apps/crq-python/state").symlink_to(outside)
        layout = live.HostLayout(
            root=other_root, unit_dir=self.units_home,
            record_dir=self.overlay_records, overlay=self.overlay)
        with self.assertRaises(live.LiveBindingRefused):
            layout.lock_identity()


class ProductionAdapterTests(FactoryFixture):
    def setUp(self):
        super().setUp()
        self.overlay_records = Path(self.overlay["record_dir"])
        self.overlay_records.mkdir(mode=0o700)
        self.overlay_records.chmod(0o700)
        self.effects = dc.Effects(self.root, self.overlay_records)
        self.calls = []

    def run_systemctl(self, command, timeout):
        self.calls.append((list(command), timeout))
        return empty_result(command)

    def make_live_adapter(self, **options):
        return live.production_adapter(
            self.effects, self.overlay, unit=UNIT, runtime="python",
            journal_source=self.source, identity=LiveIdentity(),
            queue_drain=self.queue, **options)

    def records(self):
        return sorted(self.effects.record_dir.glob("controller-*.json"))

    def test_defaults_construct_the_live_ports_without_a_command(self):
        adapter, selection = live.production_adapter(
            self.effects, self.overlay, unit=UNIT, runtime="python",
            journal_source=self.source, queue_drain=self.queue)
        self.assertIsInstance(adapter.systemd, live.SubprocessSystemd)
        self.assertIsInstance(adapter.identity, live.ProcessIdentity)
        self.assertEqual(adapter.systemd.unit_dir, self.unit_dir)
        self.assertEqual(selection.source_sha, self.before)
        self.assertEqual(self.calls, [])

    def test_unsupported_discovery_refuses_before_mutation(self):
        self.write("other.service",
                   "[Unit]\nDescription=Other\nWants=crq-tick.service\n")
        before = (self.unit_dir / UNIT).read_bytes()
        adapter, _selection = self.make_live_adapter(
            systemd=live.SubprocessSystemd(
                unit_dir=self.unit_dir, runner=self.run_systemctl))
        with self.assertRaises(dc.Refused) as caught:
            dc.switch_unit(self.effects, adapter, UNIT, "python")
        self.assertIn("supported", str(caught.exception))
        self.assertEqual(self.records(), [])
        self.assertEqual((self.unit_dir / UNIT).read_bytes(), before)

    def write(self, name, text, mode=0o644):
        _write(self.unit_dir / name, text.encode(), mode)


if __name__ == "__main__":
    unittest.main()
