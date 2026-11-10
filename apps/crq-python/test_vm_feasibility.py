"""Offline characterization for the disposable-VM feasibility harness.

No KVM, VM, network, SSH or production system is touched. The tests pin the
planning, bounds, evidence-shape and owned-process checks; the real guest run is
recorded separately by the harness and is not part of the unit suite.
"""
import importlib.util
import json
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
OPS = ROOT / "ops"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vm = _load("crq_vm_feasibility", OPS / "vm-feasibility.py")

DIGEST = "a" * 64
SUM = "%s  noble-server-cloudimg-amd64.img\n" % DIGEST


class SumsTests(unittest.TestCase):
    def test_single_entry(self):
        self.assertEqual(vm.sums_digest(SUM, vm.IMAGE_NAME), DIGEST)

    def test_binary_marker_is_accepted(self):
        text = "%s *noble-server-cloudimg-amd64.img\n" % DIGEST
        self.assertEqual(vm.sums_digest(text, vm.IMAGE_NAME), DIGEST)

    def test_duplicate_entry_refuses(self):
        with self.assertRaises(ValueError):
            vm.sums_digest(SUM + SUM, vm.IMAGE_NAME)

    def test_missing_entry_refuses(self):
        with self.assertRaises(ValueError):
            vm.sums_digest("b" * 64 + "  other.img\n", vm.IMAGE_NAME)

    def test_short_or_non_hex_refuses(self):
        with self.assertRaises(ValueError):
            vm.sums_digest("abc  noble-server-cloudimg-amd64.img\n", vm.IMAGE_NAME)
        with self.assertRaises(ValueError):
            vm.sums_digest("g" * 64 + "  noble-server-cloudimg-amd64.img\n",
                           vm.IMAGE_NAME)

    def test_image_mismatch_refuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "image"
            path.write_bytes(b"data")
            with self.assertRaises(ValueError):
                vm.verify_image(path, "0" * 64)
            self.assertEqual(vm.verify_image(path, vm.sha256_file(path)),
                             vm.sha256_file(path))


class CloudInitTests(unittest.TestCase):
    def test_user_data_isolated_account_and_linger(self):
        text = vm.render_user_data("ssh-ed25519 AAAA probe@host")
        self.assertIn("name: probe", text)
        self.assertIn("ssh-ed25519 AAAA probe@host", text)
        self.assertIn("[loginctl, enable-linger, probe]", text)
        self.assertIn("ssh_pwauth: false", text)
        self.assertIn("lock_passwd: true", text)

    def test_user_data_refuses_non_key(self):
        with self.assertRaises(ValueError):
            vm.render_user_data("not-a-key")

    def test_meta_data_is_one_token(self):
        self.assertEqual(vm.render_meta_data("crq-probe-1"),
                         "instance-id: crq-probe-1\nlocal-hostname: crq-probe\n")
        with self.assertRaises(ValueError):
            vm.render_meta_data("two tokens")


class BoundsTests(unittest.TestCase):
    def test_qemu_is_bounded_and_isolated(self):
        argv = vm.qemu_command(pathlib.Path("/state/runs/r1"), 2222)
        joined = " ".join(argv)
        self.assertIn("-m 2048", joined)
        self.assertIn("-smp 2", joined)
        self.assertIn("hostfwd=tcp:127.0.0.1:2222-:22", joined)
        self.assertIn("overlay.qcow2", joined)
        self.assertIn("seed.iso", joined)
        self.assertIn("-display none", joined)
        self.assertIn("-accel kvm", joined)

    def test_qemu_rejects_bad_resources(self):
        with self.assertRaises(ValueError):
            vm.qemu_command(pathlib.Path("/r"), 0)
        with self.assertRaises(ValueError):
            vm.qemu_command(pathlib.Path("/r"), 2222, ram_mb=512)

    def test_scope_carries_memory_and_no_swap(self):
        argv = vm.bounded_scope_argv(["qemu-system-x86_64"], "crq-vm-run")
        self.assertEqual(argv[:4], ["systemd-run", "--user", "--scope",
                                    "--unit=crq-vm-run"])
        self.assertIn("MemoryMax=3G", argv)
        self.assertIn("MemorySwapMax=0", argv)
        self.assertEqual(argv[-1], "qemu-system-x86_64")

    def test_memory_floor(self):
        meminfo = "MemTotal: 8000000 kB\nMemAvailable: 3000000 kB\n"
        self.assertEqual(vm.require_memory(meminfo), 3000000)
        with self.assertRaises(ValueError):
            vm.require_memory("MemTotal: 1 kB\nMemAvailable: 2047 kB\n")
        with self.assertRaises(ValueError):
            vm.mem_available_kib("MemTotal: 1 kB\n")

    def test_ssh_command_is_batch_bounded(self):
        argv = vm.ssh_argv(pathlib.Path("/k"), 2222, pathlib.Path("/kh"), "true")
        joined = " ".join(argv)
        self.assertIn("-o BatchMode=yes", joined)
        self.assertIn("-o ConnectTimeout=10", joined)
        self.assertIn("UserKnownHostsFile=/kh", joined)
        self.assertIn("StrictHostKeyChecking=accept-new", joined)
        self.assertEqual(argv[-2], "probe@127.0.0.1")


class ToolTests(unittest.TestCase):
    def test_directory_path_is_absolute(self):
        with tempfile.TemporaryDirectory() as temporary:
            candidate = pathlib.Path(temporary) / "qemu-test"
            candidate.write_text("#!/bin/sh\n")
            candidate.chmod(0o755)
            self.assertEqual(vm.tool("qemu-test", temporary),
                             str(candidate.resolve()))

    def test_missing_tool_refuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(ValueError):
                vm.tool("definitely-not-a-real-tool", temporary)


class ProcessIdentityTests(unittest.TestCase):
    def _proc(self, temporary, pid, starttime, cmdline):
        root = pathlib.Path(temporary)
        entry = root / str(pid)
        entry.mkdir()
        fields = ["S"] + ["0"] * 18 + [starttime]
        (entry / "stat").write_text("%d (qemu) %s\n" % (pid, " ".join(fields)))
        (entry / "cmdline").write_bytes(cmdline)
        return root

    def test_matching_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self._proc(temporary, 123, "4242", b"qemu\0/run/overlay.qcow2\0")
            self.assertTrue(vm.process_matches(123, "4242", "/run/overlay.qcow2", root))
            self.assertEqual(vm.process_starttime(123, root), "4242")

    def test_starttime_mismatch_refuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self._proc(temporary, 123, "4242", b"qemu\0/run/overlay.qcow2\0")
            self.assertFalse(vm.process_matches(123, "9999", "/run/overlay.qcow2", root))

    def test_wrong_overlay_refuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self._proc(temporary, 123, "4242", b"qemu\0/other/overlay.qcow2\0")
            self.assertFalse(vm.process_matches(123, "4242", "/run/overlay.qcow2", root))

    def test_dead_or_unsafe_pid_refuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self._proc(temporary, 123, "4242", b"qemu")
            self.assertFalse(vm.process_matches(1, "4242", "qemu", root))
            self.assertFalse(vm.process_matches(999, "4242", "qemu", root))


class EvidenceTests(unittest.TestCase):
    def _snapshot(self, pid, invocation, boot, load_state="masked",
                  link="/dev/null", active="active"):
        return {
            "boot_id": boot,
            "manager": {"pid": pid, "invocation_id": invocation},
            "runs": [],
            "files": {
                "/home/probe/.config/systemd/user/crq-fixture.service": {
                    "type": "symlink", "mode": "0o777", "uid": 1000, "gid": 1000,
                    "link_target": link},
                "/home/probe/fixture/record.sh": {
                    "type": "file", "mode": "0o750", "uid": 1000, "gid": 1000,
                    "sha256": "b" * 64},
            },
            "units": {
                "crq-fixture.service": {"LoadState": load_state},
                "crq-fixture.timer": {"ActiveState": active,
                                      "UnitFileState": "enabled"},
                "crq-fixture.path": {"ActiveState": active,
                                     "UnitFileState": "enabled"},
            },
        }

    def _phases(self):
        return {
            "install": {"snapshot": self._snapshot(10, "i1", "boot-1",
                                                    load_state="loaded", link="unit")},
            "activation": {"direct": {"run_delta": ["service"]},
                           "dependency": {"run_delta": ["service", "dependent"]},
                           "queued_run_delta": [],
                           "queued2_run_delta": []},
            "mask": {"native_mask": {"rc": 1},
                     "alias_native_mask": {"rc": 1},
                     "alias_direct": {"rc": 1},
                     "timer_before": {"ActiveState": "active",
                                      "UnitFileState": "enabled"},
                     "path_before": {"ActiveState": "active",
                                     "UnitFileState": "enabled"},
                     "timer_start_while_masked": {"rc": 1},
                     "path_start_while_masked": {"rc": 1},
                     "run_delta": [],
                     "direct": {"rc": 1}, "dependency": {"rc": 1},
                     "service_state": {"LoadState": "masked"},
                     "timer_state": {"ActiveState": "active",
                                     "UnitFileState": "enabled"},
                     "path_state": {"ActiveState": "active",
                                    "UnitFileState": "enabled"},
                     "snapshot": {"files": {
                         "/home/probe/.config/systemd/user/crq-fixture.service": {
                             "link_target": "/dev/null"}}}},
            "unmask": {"run_delta": ["service"],
                       "snapshot": self._snapshot(12, "i3", "boot-2",
                                                    load_state="loaded", link="unit")},
        }

    def test_all_checks_proven(self):
        phases = self._phases()
        manager = {"before": self._snapshot(10, "i1", "boot-1"),
                   "after": self._snapshot(11, "i2", "boot-1")}
        reboot = {"before": self._snapshot(11, "i2", "boot-1"),
                  "after": self._snapshot(12, "i3", "boot-2"),
                  "boot_id_before": "boot-1", "boot_id_after": "boot-2",
                  "qemu_pid_before": 99, "qemu_pid_after": 99,
                  "qemu_identity_verified": True}
        checks = vm.build_checks(phases, manager, reboot)
        for name, value in checks.items():
            if name == "metadata_changes":
                self.assertEqual(value, {})
            elif name == "mask_metadata_changes":
                self.assertEqual(value, {})
            elif name in ("queued_job_executed_after_mask",
                          "queued_job_executed_after_stop"):
                self.assertIs(value, False)
            elif name in ("timer_state_after_reboot", "path_state_after_reboot"):
                self.assertIn(value, ("active", "inactive", "failed"))
            else:
                self.assertIs(value, True, name)

    def test_report_requires_every_boundary(self):
        phases = self._phases()
        manager = {"before": self._snapshot(10, "i1", "boot-1"),
                   "after": self._snapshot(11, "i2", "boot-1")}
        reboot = {"before": self._snapshot(11, "i2", "boot-1"),
                  "after": self._snapshot(12, "i3", "boot-2"),
                  "boot_id_before": "boot-1", "boot_id_after": "boot-2",
                  "qemu_pid_before": 99, "qemu_pid_after": 99,
                  "qemu_identity_verified": True}
        report = {
            "schema_version": 1,
            "image": {"sha256": DIGEST, "sums_verified": True,
                      "signature_verified": False},
            "checks": vm.build_checks(phases, manager, reboot),
            "limitations": ["not controller acceptance"],
        }
        self.assertEqual(vm.report_problems(report), [])
        bad = json.loads(json.dumps(report))
        bad["checks"]["boot_id_changed"] = False
        self.assertIn("check not proven: boot_id_changed", vm.report_problems(bad))
        bad = json.loads(json.dumps(report))
        bad["image"]["signature_verified"] = True
        self.assertIn("checksum must not be claimed as signed authenticity",
                      vm.report_problems(bad))

    def test_same_boot_or_manager_fails(self):
        phases = self._phases()
        manager = {"before": self._snapshot(10, "i1", "boot-1"),
                   "after": self._snapshot(10, "i1", "boot-1")}
        reboot = {"before": self._snapshot(10, "i1", "boot-1"),
                  "after": self._snapshot(11, "i2", "boot-1"),
                  "qemu_pid_before": 99, "qemu_pid_after": 99,
                  "qemu_identity_verified": True}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["manager_restarted"])
        self.assertFalse(checks["boot_id_changed"])

    def test_trigger_file_does_not_count_as_metadata(self):
        phases = self._phases()
        phases["unmask"]["snapshot"]["files"][vm.TRIGGER_PATH] = {
            "type": "file", "mode": "0o664", "uid": 1000, "gid": 1000,
            "sha256": "c" * 64}
        manager = {"before": self._snapshot(10, "i1", "boot-1"),
                   "after": self._snapshot(11, "i2", "boot-1")}
        reboot = {"before": self._snapshot(11, "i2", "boot-1"),
                  "after": self._snapshot(12, "i3", "boot-2"),
                  "boot_id_before": "boot-1", "boot_id_after": "boot-2",
                  "qemu_pid_before": 99, "qemu_pid_after": 99,
                  "qemu_identity_verified": True}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertTrue(checks["metadata_equal"])
        self.assertEqual(checks["metadata_changes"], {})

    def test_restore_metadata_change_is_reported(self):
        phases = self._phases()
        phases["unmask"]["snapshot"]["files"]["/home/probe/fixture/record.sh"]["mode"] = "0o700"
        manager = {"before": self._snapshot(10, "i1", "boot-1"),
                   "after": self._snapshot(11, "i2", "boot-1")}
        reboot = {"before": self._snapshot(11, "i2", "boot-1"),
                  "after": self._snapshot(12, "i3", "boot-2"),
                  "boot_id_before": "boot-1", "boot_id_after": "boot-2",
                  "qemu_pid_before": 99, "qemu_pid_after": 99,
                  "qemu_identity_verified": True}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["metadata_equal"])
        self.assertIn("/home/probe/fixture/record.sh", checks["metadata_changes"])

    def test_reboot_metadata_change_is_reported(self):
        phases = self._phases()
        manager = {"before": self._snapshot(10, "i1", "boot-1"),
                   "after": self._snapshot(11, "i2", "boot-1")}
        after = self._snapshot(12, "i3", "boot-2")
        after["files"]["/home/probe/fixture/record.sh"]["mode"] = "0o700"
        reboot = {"before": self._snapshot(11, "i2", "boot-1"), "after": after,
                  "boot_id_before": "boot-1", "boot_id_after": "boot-2",
                  "qemu_pid_before": 99, "qemu_pid_after": 99,
                  "qemu_identity_verified": True}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["mask_metadata_equal"])
        self.assertIn("/home/probe/fixture/record.sh", checks["mask_metadata_changes"])


class PlanTests(unittest.TestCase):
    def test_plan_does_not_create_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary) / "missing"
            args = type("Args", (), {"state_dir": str(state)})()
            self.assertEqual(vm.cmd_plan(args), 0)
            self.assertFalse(state.exists())


if __name__ == "__main__":
    unittest.main()
