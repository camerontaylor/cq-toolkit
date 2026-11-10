"""Offline characterization for the disposable-VM feasibility harness.

No KVM, VM, network, SSH or production system is touched. The tests pin the
planning, bounds, evidence-shape and owned-process checks; the real guest run is
recorded separately by the harness and is not part of the unit suite.
"""
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest import mock

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


class FetchImageTests(unittest.TestCase):
    def _download(self, digest, data, calls, *, fail_image=False):
        def fake(url, destination, timeout=120):
            calls.append(url)
            part = pathlib.Path(str(destination) + ".part")
            if url.endswith(vm.SUMS_NAME):
                part.write_text("%s  %s\n" % (digest, vm.IMAGE_NAME))
            elif fail_image:
                raise RuntimeError("interrupted image download")
            else:
                part.write_bytes(data)
            return str(part)
        return fake

    def test_orphaned_manifest_is_refreshed_before_retrying_an_image(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            images = state / "images"
            images.mkdir()
            sums_path = images / vm.SUMS_NAME
            sums_path.write_text("%s  %s\n" % ("0" * 64, vm.IMAGE_NAME))
            data = b"fresh image bytes"
            digest = vm.sha256_bytes(data)
            calls = []
            with mock.patch.object(
                    vm, "download",
                    side_effect=self._download(digest, data, calls)):
                image = vm.fetch_image(state, vm.Recorder(state))
            self.assertEqual(calls, [vm.IMAGE_URL + vm.SUMS_NAME,
                                     vm.IMAGE_URL + vm.IMAGE_NAME])
            self.assertEqual(image["sha256"], digest)
            self.assertTrue(image["downloaded"])
            self.assertEqual((images / vm.IMAGE_NAME).read_bytes(), data)
            self.assertIn(digest, sums_path.read_text())

    def test_interrupted_fetch_retries_with_a_new_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            images = state / "images"
            images.mkdir()
            stale = images / vm.SUMS_NAME
            stale.write_text("%s  %s\n" % ("0" * 64, vm.IMAGE_NAME))
            first = []
            with mock.patch.object(
                    vm, "download",
                    side_effect=self._download(
                        "1" * 64, b"first image", first, fail_image=True)):
                with self.assertRaises(RuntimeError):
                    vm.fetch_image(state, vm.Recorder(state))
            self.assertFalse((images / vm.IMAGE_NAME).exists())
            self.assertIn("1" * 64, stale.read_text())
            data = b"second image bytes"
            digest = vm.sha256_bytes(data)
            second = []
            with mock.patch.object(
                    vm, "download",
                    side_effect=self._download(digest, data, second)):
                image = vm.fetch_image(state, vm.Recorder(state))
            self.assertEqual(second, [vm.IMAGE_URL + vm.SUMS_NAME,
                                      vm.IMAGE_URL + vm.IMAGE_NAME])
            self.assertEqual(image["sha256"], digest)
            self.assertEqual((images / vm.IMAGE_NAME).read_bytes(), data)

    def test_cached_image_is_verified_without_redownloading(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            images = state / "images"
            images.mkdir()
            data = b"cached image"
            digest = vm.sha256_bytes(data)
            (images / vm.IMAGE_NAME).write_bytes(data)
            (images / vm.SUMS_NAME).write_text(
                "%s  %s\n" % (digest, vm.IMAGE_NAME))
            with mock.patch.object(vm, "download") as download:
                image = vm.fetch_image(state, vm.Recorder(state))
            download.assert_not_called()
            self.assertFalse(image["downloaded"])
            self.assertEqual(image["sha256"], digest)

    def test_new_image_must_match_the_refreshed_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            images = state / "images"
            images.mkdir()
            (images / vm.SUMS_NAME).write_text(
                "%s  %s\n" % ("2" * 64, vm.IMAGE_NAME))
            calls = []
            with mock.patch.object(
                    vm, "download",
                    side_effect=self._download("3" * 64, b"unexpected", calls)):
                with self.assertRaises(ValueError):
                    vm.fetch_image(state, vm.Recorder(state))
            self.assertFalse((images / vm.IMAGE_NAME).exists())


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


class LifecycleTests(unittest.TestCase):
    def _prepared(self, temporary):
        state = pathlib.Path(temporary)
        run = state / "runs" / "r1"
        run.mkdir(parents=True)
        (run / "run.json").write_text(json.dumps(
            {"run_id": "r1", "path": str(run), "port": 2222}))
        return state, run

    def test_prepared_run_loads_without_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            loaded = vm.load_run(state, "r1", require_process=False)
            self.assertEqual(loaded["port"], 2222)
            self.assertEqual(loaded["path"], str(run))
            with self.assertRaises(ValueError):
                vm.load_run(state, "r1")

    def test_destroy_purges_stopped_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            (run / "overlay.qcow2").write_text("evidence")
            payload = vm.stop_owned_process(
                {"run_id": "r1", "path": str(run)}, purge=True)
            self.assertTrue(payload["stopped"])
            self.assertFalse((run / "overlay.qcow2").exists())
            self.assertTrue(pathlib.Path(payload["trash"]).is_dir())
            again = vm.stop_owned_process(
                {"run_id": "r1", "path": str(run)}, purge=True)
            self.assertTrue(again["stopped"])
            self.assertIsNone(again["trash"])

    def test_destroy_purges_a_dead_recorded_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            (run / "overlay.qcow2").write_text("evidence")
            (run / "process.json").write_text(json.dumps(
                {"pid": 999999, "starttime": "1",
                 "scope_unit": "crq-vm-test.scope"}))
            with mock.patch.object(vm.subprocess, "run") as subprocess_run:
                payload = vm.stop_owned_process(
                    {"run_id": "r1", "path": str(run)}, purge=True)
            subprocess_run.assert_not_called()
            self.assertTrue(payload["stopped"])
            self.assertFalse((run / "overlay.qcow2").exists())

    def test_cmd_boot_accepts_a_prepared_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            args = type("Args", (), {"state_dir": str(state), "run_id": "r1",
                                     "tools": None})()
            with mock.patch.object(vm, "boot", return_value={"pid": 1}) as boot, \
                 mock.patch.object(vm, "wait_ssh", return_value={}), \
                 mock.patch.object(vm, "upload_guest_probe"):
                self.assertEqual(vm.cmd_boot(args), 0)
                boot.assert_called_once()

    def test_cmd_boot_cleans_up_when_readiness_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            args = type("Args", (), {"state_dir": str(state), "run_id": "r1",
                                     "tools": None})()
            with mock.patch.object(vm, "boot", return_value={"pid": 1}), \
                 mock.patch.object(vm, "wait_ssh",
                                   side_effect=RuntimeError("SSH never ready")), \
                 mock.patch.object(vm, "stop_owned_process",
                                   return_value={"stopped": True}) as stop:
                with self.assertRaises(RuntimeError):
                    vm.cmd_boot(args)
                stop.assert_called_once()

    def test_cmd_boot_cleans_up_when_upload_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            args = type("Args", (), {"state_dir": str(state), "run_id": "r1",
                                     "tools": None})()
            with mock.patch.object(vm, "boot", return_value={"pid": 1}), \
                 mock.patch.object(vm, "wait_ssh", return_value={}), \
                 mock.patch.object(vm, "upload_guest_probe",
                                   side_effect=RuntimeError("upload failed")), \
                 mock.patch.object(vm, "stop_owned_process",
                                   return_value={"stopped": True}) as stop:
                with self.assertRaises(RuntimeError):
                    vm.cmd_boot(args)
                stop.assert_called_once()

    def test_destroy_refuses_mismatched_live_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            (run / "overlay.qcow2").write_text("evidence")
            (run / "process.json").write_text(json.dumps(
                {"pid": os.getpid(), "starttime": "0",
                 "scope_unit": "crq-vm-test.scope"}))
            with self.assertRaises(RuntimeError):
                vm.stop_owned_process(
                    {"run_id": "r1", "path": str(run)}, purge=False)

    def test_destroy_treats_a_changed_process_as_stopped(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            (run / "process.json").write_text(json.dumps(
                {"pid": os.getpid(), "starttime": "0",
                 "scope_unit": "crq-vm-test.scope"}))
            with mock.patch.object(vm, "process_matches",
                                   side_effect=[True, False, False]), \
                 mock.patch.object(vm.subprocess, "run",
                                   return_value=mock.Mock(returncode=0)):
                payload = vm.stop_owned_process(
                    {"run_id": "r1", "path": str(run)}, purge=False)
            self.assertTrue(payload["stopped"])

    def test_cmd_run_cleans_up_after_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            args = type("Args", (), {"state_dir": str(state), "tools": None,
                                     "keep": False,
                                     "source_commit": "a" * 40})()
            image = {"name": "image", "path": "/image", "sha256": DIGEST,
                     "sums_sha256": DIGEST, "sums_verified": True,
                     "signature_verified": False, "downloaded": False}
            with mock.patch.object(vm, "fetch_image", return_value=image), \
                 mock.patch.object(vm, "prepare_run", return_value={
                     "run_id": "r1", "path": str(run), "port": 2222,
                     "started_at": "now"}), \
                 mock.patch.object(vm, "host_stamp",
                                   return_value={"kvm_writable": True}), \
                 mock.patch.object(vm, "boot", return_value={
                     "pid": 1, "starttime": "1", "scope_unit": "s.scope"}), \
                 mock.patch.object(vm, "wait_ssh",
                                   side_effect=RuntimeError("SSH never ready")), \
                 mock.patch.object(vm, "stop_owned_process",
                                   return_value={"stopped": True}) as stop:
                with self.assertRaises(RuntimeError):
                    vm.cmd_run(args)
                stop.assert_called_once_with(
                    {"run_id": "r1", "path": str(run), "port": 2222,
                     "started_at": "now"}, purge=False)

    def test_cmd_run_requires_a_source_commit(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, _run = self._prepared(temporary)
            args = type("Args", (), {"state_dir": str(state), "tools": None,
                                     "keep": False, "source_commit": None})()
            with mock.patch.object(vm, "fetch_image") as fetch:
                with self.assertRaises(ValueError):
                    vm.cmd_run(args)
            fetch.assert_not_called()

    def test_boot_failure_does_not_stop_an_unverified_scope(self):
        class ExitedProcess:
            pid = 4321

            def poll(self):
                return 1

        with tempfile.TemporaryDirectory() as temporary:
            run = pathlib.Path(temporary) / "r1"
            run.mkdir()
            recorder = vm.Recorder(run)
            with mock.patch.object(vm, "require_memory"), \
                 mock.patch.object(vm, "tool", return_value="/bin/true"), \
                 mock.patch.object(vm.subprocess, "Popen",
                                   return_value=ExitedProcess()), \
                 mock.patch.object(vm.subprocess, "run") as subprocess_run:
                with self.assertRaises(RuntimeError):
                    vm.boot({"run_id": "r1", "path": str(run), "port": 2222},
                            recorder, None, {"kvm_writable": True})
            subprocess_run.assert_not_called()

    def test_timeout_output_is_text_and_json_safe(self):
        with tempfile.TemporaryDirectory() as temporary:
            recorder = vm.Recorder(pathlib.Path(temporary))
            timed_out = vm.subprocess.TimeoutExpired(["probe"], 1,
                                                     output=b"partial")
            with mock.patch.object(vm.subprocess, "run", side_effect=timed_out):
                entry = recorder.run(["probe"], timeout=1)
            self.assertEqual(entry["stdout"], "partial")
            self.assertTrue(entry["timeout"])
            json.dumps(entry)

    def test_upload_refuses_a_guest_digest_mismatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = pathlib.Path(temporary) / "r1"
            run.mkdir()
            recorder = vm.Recorder(run)
            with mock.patch.object(
                    vm, "guest_ssh",
                    side_effect=[{"rc": 0}, {"rc": 0,
                                             "stdout": "deadbeef  /tmp/probe.py\n"}]):
                with self.assertRaises(RuntimeError):
                    vm.upload_guest_probe(
                        {"run_id": "r1", "path": str(run)}, recorder,
                        source=b"exact bytes")

    def test_uptime_is_not_a_pid(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "uptime"
            path.write_text("123.45 678.90\n")
            self.assertEqual(vm.read_uptime(str(path)), 123.45)
            self.assertIsNone(vm.read_uptime(str(path) + ".missing"))


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

    def _refusals(self):
        return {"direct": {"rc": 1}, "dependency": {"rc": 1}}

    def _phases(self):
        return {
            "install": {"snapshot": self._snapshot(10, "i1", "boot-1",
                                                    load_state="loaded", link="unit")},
            "activation": {"direct": {"run_delta": ["service"]},
                           "dependency": {"run_delta": ["service", "dependent"]},
                           "queue_blocker": {"rc": 0},
                           "queue_start": {"rc": 0},
                           "jobs_before_mask": [
                               "77 crq-queued.service start waiting",
                               "96 crq-queued-fixture.service start waiting"],
                           "queue2_blocker": {"rc": 0},
                           "queue2_start": {"rc": 0},
                           "jobs2_before_stop": [
                               "116 crq-queued.service start waiting",
                               "135 crq-queued-fixture.service start waiting"],
                           "stop_queued_fixture": {"rc": 0},
                           "jobs2_after_stop": [],
                           "queued_jobs_after_release": {
                               "settled": True, "jobs": []},
                           "queued_jobs2_after_release": {
                               "settled": True, "jobs": []},
                           "queued_run_delta": ["queued"],
                           "queued2_run_delta": ["queued"]},
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
                   "after": self._snapshot(11, "i2", "boot-1"),
                   "after_phase": self._refusals()}
        reboot = {"before": self._snapshot(11, "i2", "boot-1"),
                  "after": self._snapshot(12, "i3", "boot-2"),
                  "after_phase": self._refusals(),
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
                   "after": self._snapshot(11, "i2", "boot-1"),
                   "after_phase": self._refusals()}
        reboot = {"before": self._snapshot(11, "i2", "boot-1"),
                  "after": self._snapshot(12, "i3", "boot-2"),
                  "after_phase": self._refusals(),
                  "boot_id_before": "boot-1", "boot_id_after": "boot-2",
                  "qemu_pid_before": 99, "qemu_pid_after": 99,
                  "qemu_identity_verified": True}
        report = {
            "schema_version": vm.REPORT_SCHEMA,
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

    def test_missing_observations_fail_closed(self):
        phases = self._phases()
        del phases["mask"]["run_delta"]
        phases["activation"].pop("queued_run_delta")
        phases["activation"].pop("queued2_run_delta")
        manager = {"before": self._snapshot(10, "i1", "boot-1"),
                   "after": self._snapshot(11, "i2", "boot-1"),
                   "after_phase": self._refusals()}
        reboot = {"before": self._snapshot(11, "i2", "boot-1"),
                  "after": self._snapshot(12, "i3", "boot-2"),
                  "after_phase": self._refusals(),
                  "boot_id_before": "boot-1", "boot_id_after": "boot-2",
                  "qemu_pid_before": 99, "qemu_pid_after": 99,
                  "qemu_identity_verified": True}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["run_after_trigger_observed"])
        self.assertFalse(checks["no_run_after_trigger"])
        self.assertFalse(checks["queued_observations_present"])
        self.assertIsNone(checks["queued_job_executed_after_mask"])
        self.assertIsNone(checks["queued_job_executed_after_stop"])
        report = {"schema_version": vm.REPORT_SCHEMA,
                  "image": {"sha256": DIGEST, "sums_verified": True,
                            "signature_verified": False},
                  "checks": checks, "limitations": ["limited"]}
        problems = vm.report_problems(report)
        self.assertIn("check not proven: run_after_trigger_observed", problems)
        self.assertIn("check not proven: queued_observations_present", problems)

    def test_queued_setup_requires_success_and_a_waiting_fixture(self):
        phases = self._phases()
        phases["activation"]["queue_start"] = {"rc": 1}
        phases["activation"]["jobs_before_mask"] = []
        manager = {"before": self._snapshot(10, "i1", "boot-1"),
                   "after": self._snapshot(11, "i2", "boot-1"),
                   "after_phase": self._refusals()}
        reboot = {"before": self._snapshot(11, "i2", "boot-1"),
                  "after": self._snapshot(12, "i3", "boot-2"),
                  "after_phase": self._refusals(),
                  "boot_id_before": "boot-1", "boot_id_after": "boot-2",
                  "qemu_pid_before": 99, "qemu_pid_after": 99,
                  "qemu_identity_verified": True}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["queued_setup_proven"])

    def test_stop_round_requires_a_successful_stop_and_cancelled_job(self):
        phases = self._phases()
        manager = {"before": self._snapshot(10, "i1", "boot-1"),
                   "after": self._snapshot(11, "i2", "boot-1"),
                   "after_phase": self._refusals()}
        reboot = {"before": self._snapshot(11, "i2", "boot-1"),
                  "after": self._snapshot(12, "i3", "boot-2"),
                  "after_phase": self._refusals(),
                  "boot_id_before": "boot-1", "boot_id_after": "boot-2",
                  "qemu_pid_before": 99, "qemu_pid_after": 99,
                  "qemu_identity_verified": True}
        self.assertTrue(vm.build_checks(phases, manager, reboot)
                        ["queued_stop_proven"])
        phases["activation"]["stop_queued_fixture"] = {"rc": 1}
        phases["activation"]["jobs2_after_stop"] = [
            "135 crq-queued-fixture.service start waiting"]
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["queued_stop_proven"])
        report = {"schema_version": vm.REPORT_SCHEMA,
                  "image": {"sha256": DIGEST, "sums_verified": True,
                            "signature_verified": False},
                  "checks": checks, "limitations": ["limited"]}
        self.assertIn("check not proven: queued_stop_proven",
                      vm.report_problems(report))
        phases["activation"]["stop_queued_fixture"] = {"rc": 0}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["queued_stop_proven"])

    def test_queued_jobs_must_settle_before_sampling_runs(self):
        phases = self._phases()
        phases["activation"]["queued_jobs_after_release"] = {
            "settled": False, "jobs": ["96 crq-queued-fixture.service start running"]}
        manager = {"before": self._snapshot(10, "i1", "boot-1"),
                   "after": self._snapshot(11, "i2", "boot-1"),
                   "after_phase": self._refusals()}
        reboot = {"before": self._snapshot(11, "i2", "boot-1"),
                  "after": self._snapshot(12, "i3", "boot-2"),
                  "after_phase": self._refusals(),
                  "boot_id_before": "boot-1", "boot_id_after": "boot-2",
                  "qemu_pid_before": 99, "qemu_pid_after": 99,
                  "qemu_identity_verified": True}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["queued_jobs_settled_after_mask"])

    def test_manager_restart_run_log_detects_a_new_service(self):
        phases = self._phases()
        before = self._snapshot(10, "i1", "boot-1")
        after = self._snapshot(11, "i2", "boot-1")
        after["runs"] = [{"label": "service"}]
        manager = {"before": before, "after": after,
                   "after_phase": self._refusals()}
        reboot = {"before": after, "after": self._snapshot(12, "i3", "boot-2"),
                  "after_phase": self._refusals(),
                  "boot_id_before": "boot-1", "boot_id_after": "boot-2",
                  "qemu_pid_before": 99, "qemu_pid_after": 99,
                  "qemu_identity_verified": True}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["no_new_service_after_manager_restart"])

    def _bound_report(self, base):
        phases = self._phases()
        manager = {"before": self._snapshot(10, "i1", "boot-1"),
                   "after": self._snapshot(11, "i2", "boot-1"),
                   "after_phase": self._refusals()}
        reboot = {"before": self._snapshot(11, "i2", "boot-1"),
                  "after": self._snapshot(12, "i3", "boot-2"),
                  "after_phase": self._refusals(),
                  "boot_id_before": "boot-1", "boot_id_after": "boot-2",
                  "qemu_pid_before": 99, "qemu_pid_after": 99,
                  "qemu_identity_verified": True}
        host = pathlib.Path(base) / "executed-host-script.py"
        guest = pathlib.Path(base) / "executed-guest-probe.py"
        host.write_bytes(b"host bytes")
        guest.write_bytes(b"guest bytes")
        return {
            "schema_version": vm.REPORT_SCHEMA,
            "image": {"sha256": DIGEST, "sums_verified": True,
                      "signature_verified": False},
            "provenance": {
                "source_commit": "a" * 40,
                "host_script": {"artifact": host.name,
                                "sha256": vm.sha256_file(host)},
                "guest_script": {"artifact": guest.name,
                                 "sha256": vm.sha256_file(guest),
                                 "remote_sha256": vm.sha256_file(guest),
                                 "verified": True}},
            "phases": phases,
            "manager_restart": manager,
            "reboot": reboot,
            "checks": vm.build_checks(phases, manager, reboot),
            "limitations": ["not controller acceptance"],
        }

    def test_verify_recomputes_checks_from_raw_observations(self):
        with tempfile.TemporaryDirectory() as temporary:
            report = self._bound_report(temporary)
            report["manager_restart"]["after_phase"]["direct"]["rc"] = 0
            report["reboot"]["boot_id_after"] = report["reboot"]["boot_id_before"]
            problems = vm.verify_report(report, pathlib.Path(temporary))
            self.assertIn("stored checks do not match recomputed evidence", problems)
            self.assertIn("check not proven: mask_persisted", problems)
            self.assertIn("check not proven: boot_id_changed", problems)

    def test_verify_rejects_changed_executed_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            report = self._bound_report(temporary)
            self.assertEqual(vm.verify_report(report, pathlib.Path(temporary)), [])
            (pathlib.Path(temporary) / "executed-host-script.py").write_bytes(
                b"changed")
            problems = vm.verify_report(report, pathlib.Path(temporary))
            self.assertIn(
                "provenance host_script artifact digest does not match", problems)

    def test_post_boundary_activation_refusal_is_required(self):
        phases = self._phases()
        manager = {"before": self._snapshot(10, "i1", "boot-1"),
                   "after": self._snapshot(11, "i2", "boot-1"),
                   "after_phase": {"direct": {"rc": 0},
                                   "dependency": {"rc": 1}}}
        reboot = {"before": self._snapshot(11, "i2", "boot-1"),
                  "after": self._snapshot(12, "i3", "boot-2"),
                  "after_phase": {"direct": {"rc": 1},
                                  "dependency": {"rc": 0}},
                  "boot_id_before": "boot-1", "boot_id_after": "boot-2",
                  "qemu_pid_before": 99, "qemu_pid_after": 99,
                  "qemu_identity_verified": True}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["mask_persisted"])

    def test_same_boot_or_manager_fails(self):
        phases = self._phases()
        manager = {"before": self._snapshot(10, "i1", "boot-1"),
                   "after": self._snapshot(10, "i1", "boot-1"),
                   "after_phase": self._refusals()}
        reboot = {"before": self._snapshot(10, "i1", "boot-1"),
                  "after": self._snapshot(11, "i2", "boot-1"),
                  "after_phase": self._refusals(),
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
                   "after": self._snapshot(11, "i2", "boot-1"),
                   "after_phase": self._refusals()}
        reboot = {"before": self._snapshot(11, "i2", "boot-1"),
                  "after": self._snapshot(12, "i3", "boot-2"),
                  "after_phase": self._refusals(),
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
                   "after": self._snapshot(11, "i2", "boot-1"),
                   "after_phase": self._refusals()}
        reboot = {"before": self._snapshot(11, "i2", "boot-1"),
                  "after": self._snapshot(12, "i3", "boot-2"),
                  "after_phase": self._refusals(),
                  "boot_id_before": "boot-1", "boot_id_after": "boot-2",
                  "qemu_pid_before": 99, "qemu_pid_after": 99,
                  "qemu_identity_verified": True}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["metadata_equal"])
        self.assertIn("/home/probe/fixture/record.sh", checks["metadata_changes"])

    def test_reboot_metadata_change_is_reported(self):
        phases = self._phases()
        manager = {"before": self._snapshot(10, "i1", "boot-1"),
                   "after": self._snapshot(11, "i2", "boot-1"),
                   "after_phase": self._refusals()}
        after = self._snapshot(12, "i3", "boot-2")
        after["files"]["/home/probe/fixture/record.sh"]["mode"] = "0o700"
        reboot = {"before": self._snapshot(11, "i2", "boot-1"), "after": after,
                  "after_phase": self._refusals(),
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
