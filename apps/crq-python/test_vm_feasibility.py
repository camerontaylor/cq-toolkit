"""Offline characterization for the disposable-VM feasibility harness.

No KVM, VM, network, SSH or production system is touched. The tests pin the
planning, bounds, evidence-shape and owned-process checks; the real guest run is
recorded separately by the harness and is not part of the unit suite.
"""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
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
guest = _load("crq_vm_guest_probe", OPS / "vm-guest-probe.py")

DIGEST = "a" * 64
SUM = "%s  noble-server-cloudimg-amd64.img\n" % DIGEST

GUEST_HOME = pathlib.Path("/home/probe")
GUEST_UNIT_DIR = GUEST_HOME / ".config/systemd/user"
GUEST_FIXTURE = GUEST_HOME / "fixture"
SNAPSHOT_PATHS = (
    GUEST_UNIT_DIR / "crq-fixture.service",
    GUEST_UNIT_DIR / "crq-fixture.timer",
    GUEST_UNIT_DIR / "crq-fixture.path",
    GUEST_UNIT_DIR / "crq-dependent.service",
    GUEST_UNIT_DIR / "crq-alias.service",
    GUEST_UNIT_DIR / "crq-blocker.service",
    GUEST_UNIT_DIR / "crq-queued.service",
    GUEST_UNIT_DIR / "crq-queued-fixture.service",
    GUEST_UNIT_DIR / "timers.target.wants/crq-fixture.timer",
    GUEST_UNIT_DIR / "default.target.wants/crq-fixture.path",
    GUEST_FIXTURE / "crq-alias.service.unit",
    GUEST_FIXTURE / "original-crq-fixture.service",
    GUEST_FIXTURE / "original-crq-alias.service.link",
    GUEST_FIXTURE / "record.sh",
)


def DRIVE(overlay):
    """A QEMU command line (NUL-delimited) whose drive file is `overlay`."""
    return (b"qemu\0-drive\0file=" + str(overlay).encode()
            + b",if=virtio,format=qcow2\0")


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


class StopOwnedProcessTests(unittest.TestCase):
    def _stop(self, active_state, *, purge=True, stop_rc=0, show_rc=0,
              load_state="loaded", run_id="r1"):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = pathlib.Path(tmp).resolve() / "runs" / "r1"
            run_dir.mkdir(parents=True)
            (run_dir / "overlay.qcow2").write_text("disk")

            self.dispatched = []
            self.derived_unit = vm.run_scope_unit(run_dir, run_id) + ".scope"

            def fake_run(argv, **kwargs):
                self.dispatched.append(argv)
                if "show" in argv:
                    # Only the derived unit exists; the legacy name is absent.
                    state = load_state if argv[-1] == self.derived_unit else "not-found"
                    out = ("ActiveState=%s\nLoadState=%s\nControlGroup=/user.slice/%s\n"
                           % (active_state, state, argv[-1]))
                    return mock.Mock(returncode=show_rc, stdout=out, stderr="")
                return mock.Mock(returncode=stop_rc, stdout="", stderr="")

            # The loaded scope holds one member owned by this run (its cmdline
            # carries the overlay path), so a populated scope still dispatches
            # the stop and the post-stop query sees the scope emptied.
            members = iter([[4242], []])
            with mock.patch.object(vm.subprocess, "run", side_effect=fake_run), \
                 mock.patch.object(vm, "_cgroup_pids",
                                   side_effect=lambda *_: next(members)), \
                 mock.patch.object(pathlib.Path, "read_bytes",
                                   return_value=DRIVE(run_dir / "overlay.qcow2")):
                result = vm.stop_owned_process(
                    {"path": str(run_dir), "run_id": run_id}, purge=purge)
            return result, (run_dir / "overlay.qcow2").exists()

    def test_inactive_scope_is_stopped_and_purged(self):
        result, still_there = self._stop("inactive")
        self.assertTrue(result["stopped"])
        self.assertFalse(still_there)
        show = ["systemctl", "--user", "show", "-p", "ActiveState", "-p", "LoadState",
                "-p", "ControlGroup", self.derived_unit]
        stop = ["systemctl", "--user", "stop", self.derived_unit]
        # Ownership proof first, then the stop, then the post-stop state query.
        legacy = ["systemctl", "--user", "show", "-p", "ActiveState", "-p", "LoadState",
                  "-p", "ControlGroup", "crq-vm-r1.scope"]
        # The legacy-named scope is checked last and found absent.
        self.assertEqual(self.dispatched, [show, stop, show, legacy])

    def test_failed_scope_is_stopped(self):
        result, _ = self._stop("failed")
        self.assertTrue(result["stopped"])

    def test_unloaded_unit_is_counted_stopped_without_a_stop_command(self):
        result, _ = self._stop("inactive", stop_rc=5, load_state="not-found")
        self.assertTrue(result["stopped"])
        # An absent scope is never given a stop command: another launch could
        # register a scope with the same name between the check and the stop.
        self.assertFalse(any("stop" in argv for argv in self.dispatched))

    def test_failed_scope_query_never_dispatches_stop(self):
        with self.assertRaises(RuntimeError):
            self._stop("", show_rc=1)
        self.assertFalse(any("stop" in argv for argv in self.dispatched))

    def test_indeterminate_membership_never_dispatches_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = pathlib.Path(tmp).resolve() / "runs" / "r1"
            run_dir.mkdir(parents=True)
            calls = []

            def fake_run(argv, **kwargs):
                calls.append(argv)
                out = ("ActiveState=failed\nLoadState=loaded\n"
                       "ControlGroup=/user.slice/crq-vm-r1.scope\n")
                return mock.Mock(returncode=0, stdout=out, stderr="")

            with mock.patch.object(vm.subprocess, "run", side_effect=fake_run), \
                 mock.patch.object(vm, "_cgroup_pids", return_value=None):
                with self.assertRaises(RuntimeError):
                    vm.stop_owned_process(
                        {"path": str(run_dir), "run_id": "r1"}, purge=True)
            self.assertFalse(any("stop" in argv for argv in calls))

    def test_deactivating_scope_is_not_stopped(self):
        result, still_there = self._stop("deactivating", stop_rc=1)
        self.assertFalse(result["stopped"])
        self.assertTrue(still_there)

    def test_failed_stop_command_blocks_purge_even_when_inactive(self):
        result, still_there = self._stop("inactive", stop_rc=1)
        self.assertFalse(result["stopped"])
        self.assertTrue(still_there)

    def test_active_scope_is_not_stopped(self):
        result, still_there = self._stop("active")
        self.assertFalse(result["stopped"])
        self.assertTrue(still_there)

    def test_glob_run_id_never_reaches_systemctl(self):
        with self.assertRaises(RuntimeError):
            self._stop("inactive", run_id="*")
        self.assertEqual(self.dispatched, [])

    def _scoped(self, *, members, owned, cgroup_after, load_state="loaded"):
        """Derived-scope stop where the cgroup holds `members` before and
        `cgroup_after` after the stop; `owned` says if their cmdline matches."""
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = pathlib.Path(tmp).resolve() / "runs" / "r1"
            run_dir.mkdir(parents=True)
            (run_dir / "overlay.qcow2").write_text("disk")
            calls = []
            unit = vm.run_scope_unit(run_dir, "r1") + ".scope"

            def fake_run(argv, **kwargs):
                calls.append(argv)
                if "show" in argv:
                    state = load_state if argv[-1] == unit else "not-found"
                    out = ("ActiveState=failed\nLoadState=%s\n"
                           "ControlGroup=/user.slice/%s\n" % (state, argv[-1]))
                    return mock.Mock(returncode=0, stdout=out, stderr="")
                return mock.Mock(returncode=0, stdout="", stderr="")

            pids = iter([members, cgroup_after])
            command = DRIVE(run_dir / "overlay.qcow2") if owned else b"other"
            with mock.patch.object(vm.subprocess, "run", side_effect=fake_run), \
                 mock.patch.object(vm, "_cgroup_pids", side_effect=lambda *_: next(pids)), \
                 mock.patch.object(pathlib.Path, "read_bytes", return_value=command):
                try:
                    result = vm.stop_owned_process(
                        {"path": str(run_dir), "run_id": "r1"}, purge=True)
                except RuntimeError as exc:
                    return exc, calls, (run_dir / "overlay.qcow2").exists(), unit
            return result, calls, (run_dir / "overlay.qcow2").exists(), unit

    def test_scope_with_foreign_members_is_never_stopped(self):
        error, calls, still_there, unit = self._scoped(members=[4242], owned=False,
                                                       cgroup_after=[])
        self.assertIsInstance(error, RuntimeError)
        self.assertFalse(any("stop" in argv for argv in calls))
        self.assertEqual(
            calls, [["systemctl", "--user", "show", "-p", "ActiveState", "-p", "LoadState",
                     "-p", "ControlGroup", unit]])
        self.assertTrue(still_there)

    def test_failed_scope_with_populated_cgroup_keeps_files(self):
        result, _, still_there, _ = self._scoped(members=[4242], owned=True,
                                                 cgroup_after=[4242])
        self.assertFalse(result["stopped"])
        self.assertTrue(still_there)

    def test_failed_scope_with_empty_cgroup_is_purged(self):
        result, _, still_there, _ = self._scoped(members=[4242], owned=True,
                                                 cgroup_after=[])
        self.assertTrue(result["stopped"])
        self.assertFalse(still_there)

    def test_unknown_cgroup_state_keeps_files(self):
        result, _, still_there, _ = self._scoped(members=[4242], owned=True,
                                                 cgroup_after=None)
        self.assertFalse(result["stopped"])
        self.assertTrue(still_there)

    def test_absent_scope_is_never_stopped(self):
        result, calls, still_there, unit = self._scoped(
            members=[], owned=True, cgroup_after=[], load_state="not-found")
        self.assertTrue(result["stopped"])
        self.assertFalse(any("stop" in argv for argv in calls))
        self.assertEqual(
            calls, [["systemctl", "--user", "show", "-p", "ActiveState", "-p", "LoadState",
                     "-p", "ControlGroup", unit],
                     ["systemctl", "--user", "show", "-p", "ActiveState", "-p", "LoadState",
                      "-p", "ControlGroup", "crq-vm-r1.scope"]])
        self.assertFalse(still_there)

    def test_empty_scope_is_never_stopped(self):
        result, calls, still_there, unit = self._scoped(
            members=[], owned=True, cgroup_after=[])
        self.assertTrue(result["stopped"])
        self.assertFalse(any("stop" in argv for argv in calls))
        self.assertEqual(
            calls, [["systemctl", "--user", "show", "-p", "ActiveState", "-p", "LoadState",
                     "-p", "ControlGroup", unit],
                     ["systemctl", "--user", "show", "-p", "ActiveState", "-p", "LoadState",
                      "-p", "ControlGroup", "crq-vm-r1.scope"]])
        self.assertFalse(still_there)

    def test_busy_run_lock_blocks_stop_before_any_systemctl(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = pathlib.Path(tmp).resolve() / "runs" / "r1"
            run_dir.mkdir(parents=True)
            with vm.run_lock(run_dir):
                with mock.patch.object(vm.subprocess, "run") as dispatch:
                    with self.assertRaises(RuntimeError):
                        vm.stop_owned_process(
                            {"path": str(run_dir), "run_id": "r1"}, purge=True)
                dispatch.assert_not_called()

    def test_load_run_rejects_a_missing_run_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            (pathlib.Path(tmp) / "runs" / "r1").mkdir(parents=True)
            with self.assertRaises(ValueError):
                vm.load_run(pathlib.Path(tmp), "r2", require_process=False)

    def test_load_run_rejects_unsafe_run_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            (pathlib.Path(tmp) / "runs" / "r1").mkdir(parents=True)
            for bad in ("*", "..", "a/b", "", "-x"):
                with self.assertRaises(ValueError):
                    vm.load_run(pathlib.Path(tmp), bad, require_process=False)

class LegacyScopeTests(unittest.TestCase):
    """Interrupted launches from before the scope name bound the run directory."""

    def _destroy(self, *, new, legacy, alias=False, owned_cmdline=True, foreign=None):
        """`new`/`legacy`: (members before the stop, members after) or None for
        an absent scope. Nothing real runs: systemctl and /proc are faked."""
        with tempfile.TemporaryDirectory() as tmp:
            real = pathlib.Path(tmp).resolve() / "runs" / "r1"
            real.mkdir(parents=True)
            (real / "overlay.qcow2").write_text("disk")
            path = real
            if alias:
                path = pathlib.Path(tmp).resolve() / "runs" / "alias"
                path.symlink_to(real)
            new_unit = vm.run_scope_unit(real, "r1") + ".scope"
            units = {new_unit: new, "crq-vm-r1.scope": legacy}
            stopped_units = set()
            calls = []

            def fake_run(argv, **kwargs):
                calls.append(argv)
                unit = argv[-1]
                if "stop" in argv:
                    stopped_units.add(unit)
                    return mock.Mock(returncode=0, stdout="", stderr="")
                state = units[unit]
                load = "not-found" if state is None else "loaded"
                return mock.Mock(returncode=0, stderr="", stdout=(
                    "ActiveState=failed\nLoadState=%s\nControlGroup=/user.slice/%s\n"
                    % (load, unit)))

            def pids(group):
                unit = str(group).rsplit("/", 1)[-1]
                state = units[unit]
                if state is None:
                    return []
                return state[1] if unit in stopped_units else state[0]

            cmdline = DRIVE(real / "overlay.qcow2") if owned_cmdline else b"other"
            if foreign:  # another run's overlay path extending this one
                cmdline = DRIVE(str(real / "overlay.qcow2") + foreign + str(real / "overlay.qcow2"))
            with mock.patch.object(vm.subprocess, "run", side_effect=fake_run), \
                 mock.patch.object(vm, "_cgroup_pids", side_effect=pids), \
                 mock.patch.object(pathlib.Path, "read_bytes", return_value=cmdline):
                result = vm.stop_owned_process(
                    {"path": str(path), "run_id": "r1"}, purge=True)
            return result, calls, stopped_units, (real / "overlay.qcow2").exists(), new_unit

    def test_owned_legacy_scope_is_stopped_before_reporting_stopped(self):
        result, calls, stopped, still_there, _ = self._destroy(
            new=None, legacy=([4242], []))
        self.assertEqual(stopped, {"crq-vm-r1.scope"})
        self.assertTrue(result["stopped"])
        self.assertFalse(still_there)

    def test_owned_legacy_scope_that_stays_populated_keeps_the_files(self):
        result, _, stopped, still_there, _ = self._destroy(
            new=None, legacy=([4242], [4242]))
        self.assertEqual(stopped, {"crq-vm-r1.scope"})
        self.assertFalse(result["stopped"])
        self.assertTrue(still_there)

    def test_unrelated_legacy_scope_is_left_untouched(self):
        # Another state directory owns the shared legacy name.
        result, calls, stopped, still_there, _ = self._destroy(
            new=None, legacy=([4242], [4242]), owned_cmdline=False)
        self.assertEqual(stopped, set())
        self.assertTrue(result["stopped"])
        self.assertFalse(still_there)

    def test_foreign_overlay_extending_the_selected_path_is_not_owned(self):
        # `file=<run>/overlay.qcow2-backup/<run>/overlay.qcow2` merely contains
        # this run's overlay path; the legacy scope stays untouched, no stop.
        result, calls, stopped, still_there, _ = self._destroy(
            new=None, legacy=([4242], [4242]), foreign="-backup")
        self.assertEqual(stopped, set())
        self.assertFalse(any("stop" in c for c in calls))
        self.assertTrue(result["stopped"])
        self.assertFalse(still_there)

    def test_hashed_scope_behaviour_is_preserved(self):
        result, _, stopped, _, new_unit = self._destroy(
            new=([4242], []), legacy=None)
        self.assertEqual(stopped, {new_unit})
        self.assertTrue(result["stopped"])

    def test_hashed_scope_with_foreign_members_still_refuses(self):
        with self.assertRaises(RuntimeError):
            self._destroy(new=([4242], [4242]), legacy=None, owned_cmdline=False)

    def test_run_path_alias_is_proven_against_the_canonical_overlay(self):
        # QEMU's command line carries the resolved overlay path, never the
        # symlinked run directory, so the ownership needle must be resolved.
        result, _, stopped, still_there, new_unit = self._destroy(
            new=([4242], []), legacy=None, alias=True)
        self.assertEqual(stopped, {new_unit})
        self.assertTrue(result["stopped"])
        self.assertFalse(still_there)



class DownloadTests(unittest.TestCase):
    def test_failed_transfer_removes_the_partial_file(self):
        class Broken:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self, size):
                raise OSError("connection reset")

        with tempfile.TemporaryDirectory() as tmp:
            destination = pathlib.Path(tmp) / "image.img"
            with mock.patch.object(vm.urllib.request, "urlopen",
                                   return_value=Broken()):
                with self.assertRaises(OSError):
                    vm.download("https://example.invalid/x", destination)
            self.assertEqual(list(pathlib.Path(tmp).iterdir()), [])


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

    def test_recorder_failure_removes_the_downloaded_manifest_part(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            images = state / "images"
            images.mkdir()
            recorder = vm.Recorder(state)
            with mock.patch.object(
                    vm, "download",
                    side_effect=self._download("1" * 64, b"x", [])), \
                    mock.patch.object(recorder, "append",
                                      side_effect=OSError("ledger full")):
                with self.assertRaisesRegex(OSError, "ledger full"):
                    vm.fetch_sums(images / vm.SUMS_NAME, recorder)
            self.assertEqual(list(images.glob("*.part")), [])

    def test_cleanup_failure_never_masks_the_original_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            images = state / "images"
            images.mkdir()
            recorder = vm.Recorder(state)
            with mock.patch.object(
                    vm, "download",
                    side_effect=self._download("1" * 64, b"x", [])), \
                    mock.patch.object(recorder, "append",
                                      side_effect=OSError("ledger full")), \
                    mock.patch.object(pathlib.Path, "unlink",
                                      side_effect=OSError("read-only")):
                with self.assertRaisesRegex(OSError, "ledger full"):
                    vm.fetch_sums(images / vm.SUMS_NAME, recorder)

    def test_fetch_holds_an_exclusive_lock_on_the_images_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)

            def check_lock(images, recorder):
                # Assert from inside the fetch: the lock must already be held
                # exclusively on the images-directory lock file and must not
                # have been released while the fetch runs.
                self.assertEqual(flock.call_count, 1)
                fd, mode = flock.call_args.args
                self.assertEqual(mode, vm.fcntl.LOCK_EX)
                locked = os.fstat(fd)
                expected = (images / ".fetch.lock").stat()
                self.assertEqual((locked.st_dev, locked.st_ino),
                                 (expected.st_dev, expected.st_ino))
                return {"ok": 1}

            with mock.patch.object(vm.fcntl, "flock") as flock, \
                    mock.patch.object(vm, "_fetch_image_locked",
                                      side_effect=check_lock):
                self.assertEqual(vm.fetch_image(state, vm.Recorder(state)),
                                 {"ok": 1})

    def test_digest_mismatch_removes_the_unverified_partial_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            images = state / "images"
            images.mkdir()
            calls = []
            with mock.patch.object(
                    vm, "download",
                    side_effect=self._download("1" * 64, b"wrong bytes", calls)):
                with self.assertRaises(ValueError):
                    vm.fetch_image(state, vm.Recorder(state))
            self.assertFalse((images / vm.IMAGE_NAME).exists())
            self.assertEqual(list(images.glob("*.part")), [])

    def test_failed_promotion_removes_the_verified_partial_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            images = state / "images"
            images.mkdir()
            data = b"verified bytes"
            inner = self._download(vm.sha256_bytes(data), data, [])

            def fake(url, destination, timeout=120):
                part = inner(url, destination, timeout)
                if url.endswith(vm.IMAGE_NAME):
                    # The destination becomes a directory mid-download, so the
                    # promotion rename fails after verification succeeded.
                    destination.mkdir()
                return part

            with mock.patch.object(vm, "download", side_effect=fake):
                with self.assertRaises(OSError):
                    vm.fetch_image(state, vm.Recorder(state))
            self.assertEqual(list(images.glob("*.part")), [])

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
            # The stale checksum matches the downloaded bytes, so a fetch that
            # skips the refresh and trusts this manifest would promote the
            # image instead of failing.
            (images / vm.SUMS_NAME).write_text(
                "%s  %s\n" % (vm.sha256_bytes(b"unexpected"), vm.IMAGE_NAME))
            calls = []
            with mock.patch.object(
                    vm, "download",
                    side_effect=self._download("3" * 64, b"unexpected", calls)):
                with self.assertRaises(ValueError):
                    vm.fetch_image(state, vm.Recorder(state))
            self.assertFalse((images / vm.IMAGE_NAME).exists())


class GuestJobObservationTests(unittest.TestCase):
    def test_failed_list_jobs_is_an_explicit_failure(self):
        with mock.patch.object(guest, "systemctl", return_value={
                "rc": 1, "stdout": "", "stderr": "manager unavailable"}):
            observation = guest.jobs()
            self.assertFalse(observation["ok"])
            self.assertEqual(observation["lines"], [])
            self.assertFalse(guest.wait_jobs("crq-x.service", False, 0)["ok"])
            settled = guest.wait_jobs_settle(("crq-x.service",), 0)
            self.assertFalse(settled["settled"])
            self.assertFalse(settled["query_ok"])

    def test_successful_list_jobs_observes_the_queue(self):
        with mock.patch.object(guest, "systemctl", return_value={
                "rc": 0, "stdout": "7 crq-x.service start waiting\n",
                "stderr": ""}):
            observation = guest.jobs()
            self.assertTrue(observation["ok"])
            self.assertEqual(observation["lines"],
                             ["7 crq-x.service start waiting"])
            self.assertTrue(guest.wait_jobs("crq-x.service", True, 0)["ok"])
            settled = guest.wait_jobs_settle(("crq-x.service",), 0)
            self.assertFalse(settled["settled"])
            self.assertTrue(settled["query_ok"])


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
        self.assertEqual(argv[argv.index("-m") + 1], "2048")
        self.assertEqual(argv[argv.index("-smp") + 1], "2")
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

    def test_scope_name_binds_the_canonical_run_directory(self):
        with tempfile.TemporaryDirectory() as first, \
                tempfile.TemporaryDirectory() as second:
            one = vm.run_scope_unit(pathlib.Path(first) / "runs" / "r1", "r1")
            two = vm.run_scope_unit(pathlib.Path(second) / "runs" / "r1", "r1")
            # The same run id under two state directories must derive two
            # different scopes: the run id alone does not prove ownership.
            self.assertNotEqual(one, two)
            self.assertNotEqual(one, "crq-vm-r1")
            self.assertEqual(one,
                             vm.run_scope_unit(pathlib.Path(first) / "runs" / "r1", "r1"))
            self.assertTrue(one.startswith("crq-vm-r1-"))

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
            root = self._proc(temporary, 123, "4242", DRIVE("/run/overlay.qcow2"))
            self.assertTrue(vm.process_matches(123, "4242", "/run/overlay.qcow2", root))
            self.assertEqual(vm.process_starttime(123, root), "4242")

    def test_starttime_mismatch_refuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self._proc(temporary, 123, "4242", DRIVE("/run/overlay.qcow2"))
            self.assertFalse(vm.process_matches(123, "9999", "/run/overlay.qcow2", root))

    def test_wrong_overlay_refuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self._proc(temporary, 123, "4242", DRIVE("/other/overlay.qcow2"))
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
            inactive = mock.Mock(returncode=0,
                                 stdout="ActiveState=inactive\nLoadState=loaded\n",
                                 stderr="")
            with mock.patch.object(vm.subprocess, "run", return_value=inactive):
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
            with mock.patch.object(vm, "boot", return_value={"pid": 1, "starttime": "5"}) as boot, \
                 mock.patch.object(vm, "wait_ssh", return_value={}), \
                 mock.patch.object(vm, "upload_guest_probe"):
                self.assertEqual(vm.cmd_boot(args), 0)
                boot.assert_called_once()

    def test_cmd_boot_cleans_up_when_readiness_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            args = type("Args", (), {"state_dir": str(state), "run_id": "r1",
                                     "tools": None})()
            with mock.patch.object(vm, "boot", return_value={"pid": 1, "starttime": "5"}), \
                 mock.patch.object(vm, "wait_ssh",
                                   side_effect=RuntimeError("SSH never ready")), \
                 mock.patch.object(vm, "stop_owned_process",
                                   return_value={"stopped": True}) as stop:
                with self.assertRaises(RuntimeError):
                    vm.cmd_boot(args)
                stop.assert_called_once()

    def test_cmd_boot_rejected_by_busy_lock_never_cleans_up(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            args = type("Args", (), {"state_dir": str(state), "run_id": "r1",
                                     "tools": None})()
            with vm.run_lock(run):
                with mock.patch.object(vm, "boot") as boot, \
                     mock.patch.object(vm, "stop_owned_process") as stop:
                    with self.assertRaises(RuntimeError):
                        vm.cmd_boot(args)
                    boot.assert_not_called()
                    stop.assert_not_called()

    def test_cmd_boot_cleans_up_when_upload_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            args = type("Args", (), {"state_dir": str(state), "run_id": "r1",
                                     "tools": None})()
            with mock.patch.object(vm, "boot", return_value={"pid": 1, "starttime": "5"}), \
                 mock.patch.object(vm, "wait_ssh", return_value={}), \
                 mock.patch.object(vm, "upload_guest_probe",
                                   side_effect=RuntimeError("upload failed")), \
                 mock.patch.object(vm, "stop_owned_process",
                                   return_value={"stopped": True}) as stop:
                with self.assertRaises(RuntimeError):
                    vm.cmd_boot(args)
                stop.assert_called_once()

    def test_cmd_boot_cleanup_failure_keeps_stderr_empty_in_machine_mode(self):
        import contextlib
        import io
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            args = type("Args", (), {"state_dir": str(state), "run_id": "r1",
                                     "tools": None, "json": True})()
            err = io.StringIO()
            with mock.patch.object(vm, "boot", return_value={"pid": 1, "starttime": "5"}), \
                 mock.patch.object(vm, "wait_ssh",
                                   side_effect=RuntimeError("SSH never ready")), \
                 mock.patch.object(vm, "stop_owned_process",
                                   side_effect=RuntimeError("scope gone")):
                with contextlib.redirect_stderr(err):
                    with self.assertRaises(RuntimeError) as raised:
                        vm.cmd_boot(args)
            self.assertEqual(err.getvalue(), "")
            self.assertIn("scope gone", vm._error_message(raised.exception))

    def test_cleanup_failure_narrates_outside_machine_mode(self):
        import contextlib
        import io
        args = type("Args", (), {"json": False})()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            message = vm._cleanup_diagnostic(args, "cleanup after run",
                                             RuntimeError("scope gone"))
        self.assertIn(message, err.getvalue())

    def test_destroy_refuses_mismatched_live_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            (run / "overlay.qcow2").write_text("evidence")
            (run / "process.json").write_text(json.dumps(
                {"pid": os.getpid(), "starttime": "0",
                 "scope_unit": "crq-vm-test.scope"}))
            with mock.patch.object(vm.subprocess, "run") as run_cmd:
                with self.assertRaises(RuntimeError):
                    vm.stop_owned_process(
                        {"run_id": "r1", "path": str(run)}, purge=False)
            run_cmd.assert_not_called()

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
                 mock.patch.object(vm, "verify_source_scripts"), \
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
                     "started_at": "now"}, purge=False,
                    launched={"pid": 1, "starttime": "1"})

    def test_cmd_run_refuses_a_live_run_before_launching(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            args = type("Args", (), {"state_dir": str(state), "tools": None,
                                     "keep": True,
                                     "source_commit": "a" * 40})()
            image = {"name": "image", "path": "/image", "sha256": DIGEST,
                     "sums_sha256": DIGEST, "sums_verified": True,
                     "signature_verified": False, "downloaded": False}
            with mock.patch.object(vm, "fetch_image", return_value=image), \
                 mock.patch.object(vm, "prepare_run", return_value={
                     "run_id": "r1", "path": str(run), "port": 2222,
                     "started_at": "now"}), \
                 mock.patch.object(vm, "verify_source_scripts"), \
                 mock.patch.object(vm, "host_stamp",
                                   return_value={"kvm_writable": True}), \
                 mock.patch.object(vm, "live_identity",
                                   return_value={"pid": 42}), \
                 mock.patch.object(vm, "boot") as boot:
                with self.assertRaisesRegex(ValueError, "already owns a live VM"):
                    vm.cmd_run(args)
                boot.assert_not_called()

    def test_cmd_run_refusal_with_keep_false_skips_cleanup(self):
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
                 mock.patch.object(vm, "verify_source_scripts"), \
                 mock.patch.object(vm, "host_stamp",
                                   return_value={"kvm_writable": True}), \
                 mock.patch.object(vm, "live_identity",
                                   return_value={"pid": 42}), \
                 mock.patch.object(vm, "boot") as boot, \
                 mock.patch.object(vm, "stop_owned_process") as stop:
                with self.assertRaisesRegex(ValueError, "already owns a live VM"):
                    vm.cmd_run(args)
            boot.assert_not_called()
            stop.assert_not_called()

    def test_cmd_run_requires_a_source_commit(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, _run = self._prepared(temporary)
            args = type("Args", (), {"state_dir": str(state), "tools": None,
                                     "keep": False, "source_commit": None})()
            with mock.patch.object(vm, "fetch_image") as fetch:
                with self.assertRaises(ValueError):
                    vm.cmd_run(args)
            fetch.assert_not_called()

    def test_cmd_run_refuses_bytes_outside_the_source_commit(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            args = type("Args", (), {"state_dir": str(state), "tools": None,
                                     "keep": False,
                                     "source_commit": "a" * 40})()
            with mock.patch.object(vm, "fetch_image"), \
                 mock.patch.object(vm, "prepare_run", return_value={
                     "run_id": "r1", "path": str(run), "port": 2222,
                     "started_at": "now"}), \
                 mock.patch.object(vm, "commit_blob",
                                   return_value=b"committed bytes"), \
                 mock.patch.object(vm, "boot") as boot, \
                 mock.patch.object(vm, "stop_owned_process",
                                   return_value={"stopped": True}) as stop:
                with self.assertRaises(ValueError):
                    vm.cmd_run(args)
            boot.assert_not_called()
            stop.assert_called_once()
            self.assertFalse((run / "executed-host-script.py").exists())
            self.assertFalse((run / "executed-guest-probe.py").exists())

    def _committed_probe_repo(self, repo, host_bytes):
        """Commit the two scripts (``host_bytes`` is the host content) and
        return the commit id whose blobs a run must match."""
        repo = pathlib.Path(repo)
        repo.mkdir(parents=True, exist_ok=True)
        (repo / "vm-feasibility.py").write_bytes(host_bytes)
        (repo / "vm-guest-probe.py").write_bytes(
            (OPS / "vm-guest-probe.py").read_bytes())

        def git(*argv):
            subprocess.run(["git", *argv], cwd=str(repo), check=True,
                           capture_output=True)
        git("init", "-q")
        git("-c", "user.email=probe@example.com",
            "-c", "user.name=probe", "add", ".")
        git("-c", "user.email=probe@example.com",
            "-c", "user.name=probe", "commit", "-q", "--no-verify",
            "-m", "probe")
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(repo),
                              check=True, capture_output=True).stdout.decode().strip()

    def _run_probe_cli(self, script, state, commit):
        return subprocess.run(
            [sys.executable, str(script), "--source-commit", commit,
             "--state-dir", str(state), "--json", "run"],
            capture_output=True, text=True, timeout=120)

    def test_run_refuses_modified_bytes_before_any_preparation(self):
        # A modified host script must be refused at launch, before the
        # pipeline it carries can run: the launcher verifies the buffer it
        # is about to execute against the stated commit first.
        source = (OPS / "vm-feasibility.py").read_bytes()
        modified = source.replace(
            b'    recorder = Recorder(state)\n'
            b'    stamps = {"start": host_stamp()}\n',
            b'    raise RuntimeError("verified-launch-reached-pipeline")\n')
        self.assertNotEqual(modified, source)
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            repo = root / "repo"
            commit = self._committed_probe_repo(repo, source)
            (repo / "vm-feasibility.py").write_bytes(modified)
            state = root / "state"
            result = self._run_probe_cli(repo / "vm-feasibility.py", state,
                                         commit)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["kind"], "thrown")
        self.assertIn("vm-feasibility.py differs from its blob",
                      payload["error"]["message"])
        self.assertNotIn("verified-launch-reached-pipeline",
                         payload["error"]["message"])
        self.assertFalse((state / "runs").exists())

    def test_run_pipeline_executes_from_the_verified_host_buffer(self):
        # The executed pipeline must be the verified buffer itself, not the
        # bytes the interpreter happened to load: the launcher hands the
        # buffer to the relaunched module, which carries it in its namespace.
        source = (OPS / "vm-feasibility.py").read_bytes()
        modified = source.replace(
            b'    recorder = Recorder(state)\n'
            b'    stamps = {"start": host_stamp()}\n',
            b'    if "_VERIFIED_HOST_BUFFER" not in globals():\n'
            b'        raise SystemExit(9)\n'
            b'    raise RuntimeError("verified-buffer-ran-the-pipeline")\n')
        self.assertNotEqual(modified, source)
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            repo = root / "repo"
            commit = self._committed_probe_repo(repo, modified)
            result = self._run_probe_cli(repo / "vm-feasibility.py",
                                         root / "state", commit)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["kind"], "thrown")
        self.assertEqual(payload["error"]["message"],
                         "verified-buffer-ran-the-pipeline")

    def test_verify_source_scripts_against_a_real_commit(self):
        def git(cwd, *argv):
            subprocess.run(["git", *argv], cwd=str(cwd), check=True,
                           capture_output=True)

        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            host = root / "vm-feasibility.py"
            guest = root / "vm-guest-probe.py"
            host.write_bytes(b"host bytes\n")
            guest.write_bytes(b"guest bytes\n")
            git(root, "init", "-q")
            git(root, "-c", "user.email=probe@example.com",
                "-c", "user.name=probe", "add", ".")
            git(root, "-c", "user.email=probe@example.com",
                "-c", "user.name=probe", "commit", "-q", "--no-verify",
                "--no-gpg-sign", "-m", "probe")
            commit = subprocess.run(["git", "rev-parse", "HEAD"],
                                    cwd=str(root), check=True,
                                    capture_output=True).stdout.decode().strip()
            vm.verify_source_scripts(commit, host, guest,
                                     b"host bytes\n", b"guest bytes\n")
            with self.assertRaises(ValueError):
                vm.verify_source_scripts(commit, host, guest,
                                         b"host bytes\n", b"modified\n")
            with self.assertRaises(ValueError):
                vm.commit_blob("b" * 40, "./vm-feasibility.py", root)

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

    def test_cmd_boot_refuses_a_live_run_before_launching_or_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            (run / "process.json").write_text(json.dumps(
                {"pid": os.getpid(), "starttime": "1",
                 "scope_unit": "crq-vm-r1.scope"}))
            args = type("Args", (), {"state_dir": str(state), "run_id": "r1",
                                     "tools": None})()
            with mock.patch.object(vm, "process_matches", return_value=True), \
                 mock.patch.object(vm, "boot") as boot, \
                 mock.patch.object(vm, "stop_owned_process") as stop:
                with self.assertRaises(ValueError):
                    vm.cmd_boot(args)
            boot.assert_not_called()
            stop.assert_not_called()

    def _run_args(self, state, keep):
        return type("Args", (), {"state_dir": str(state), "tools": None,
                                 "keep": keep, "source_commit": "a" * 40})()

    def _patched_run(self, run):
        image = {"name": "image", "path": "/image", "sha256": DIGEST,
                 "sums_sha256": DIGEST, "sums_verified": True,
                 "signature_verified": False, "downloaded": False}
        return (mock.patch.object(vm, "fetch_image", return_value=image),
                mock.patch.object(vm, "prepare_run", return_value={
                    "run_id": "r1", "path": str(run), "port": 2222,
                    "started_at": "now"}),
                mock.patch.object(vm, "host_stamp",
                                  return_value={"kvm_writable": True}))

    def test_cmd_boot_cleanup_skips_a_replacement_vm(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            args = type("Args", (), {"state_dir": str(state), "run_id": "r1",
                                     "tools": None})()

            def boot(*_args):
                (run / "process.json").write_text(json.dumps(
                    {"pid": 111, "starttime": "5",
                     "scope_unit": "crq-vm-r1.scope"}))
                return {"pid": 111, "starttime": "5"}

            def wait_ssh(*_args):
                # After the lock is released another boot replaces the VM.
                (run / "process.json").write_text(json.dumps(
                    {"pid": 222, "starttime": "9",
                     "scope_unit": "crq-vm-r1.scope"}))
                raise RuntimeError("ssh down")
            with mock.patch.object(vm, "boot", side_effect=boot), \
                 mock.patch.object(vm, "wait_ssh", side_effect=wait_ssh), \
                 mock.patch.object(vm, "process_matches", return_value=True), \
                 mock.patch.object(vm, "_stop_owned_process") as stop:
                with self.assertRaisesRegex(RuntimeError, "ssh down"):
                    vm.cmd_boot(args)
            stop.assert_not_called()

    def test_cmd_boot_cleanup_stops_the_vm_it_launched(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            args = type("Args", (), {"state_dir": str(state), "run_id": "r1",
                                     "tools": None})()

            def boot(*_args):
                (run / "process.json").write_text(json.dumps(
                    {"pid": 111, "starttime": "5",
                     "scope_unit": "crq-vm-r1.scope"}))
                return {"pid": 111, "starttime": "5"}
            with mock.patch.object(vm, "boot", side_effect=boot), \
                 mock.patch.object(vm, "wait_ssh",
                                   side_effect=RuntimeError("ssh down")), \
                 mock.patch.object(vm, "process_matches", return_value=True), \
                 mock.patch.object(vm, "_stop_owned_process",
                                   return_value={"stopped": True}) as stop:
                with self.assertRaisesRegex(RuntimeError, "ssh down"):
                    vm.cmd_boot(args)
            stop.assert_called_once()

    def test_launched_guard_leaves_a_replacement_in_its_spawn_window_alone(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            self.assertFalse((run / "process.json").exists())
            with mock.patch.object(vm, "_stop_owned_process") as stop:
                result = vm.stop_owned_process(
                    {"run_id": "r1", "path": str(run)}, purge=False,
                    launched={"pid": 111, "starttime": "5"})
            stop.assert_not_called()
            self.assertTrue(result["replaced"])

    def test_purge_with_launched_is_rejected_and_leaves_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            overlay = run / "overlay.qcow2"
            overlay.write_text("x")
            with mock.patch.object(vm, "_stop_owned_process") as stop:
                with self.assertRaisesRegex(ValueError, "purge cannot be combined"):
                    vm.stop_owned_process(
                        {"run_id": "r1", "path": str(run)}, purge=True,
                        launched={"pid": 111, "starttime": "5"})
            stop.assert_not_called()
            self.assertTrue(overlay.exists())

    def test_cmd_run_cleanup_skips_a_replacement_vm(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            boot_info = {"pid": 111, "starttime": "5",
                         "scope_unit": "crq-vm-r1.scope"}

            def boot(*_args):
                # Another invocation replaced the VM after this launch.
                (run / "process.json").write_text(json.dumps(
                    {"pid": 222, "starttime": "9",
                     "scope_unit": "crq-vm-r1.scope"}))
                return boot_info
            patches = self._patched_run(run)
            with patches[0], patches[1], patches[2], \
                 mock.patch.object(vm, "verify_source_scripts"), \
                 mock.patch.object(vm, "process_matches", return_value=True), \
                 mock.patch.object(vm, "boot", side_effect=boot), \
                 mock.patch.object(vm, "wait_ssh",
                                   side_effect=RuntimeError("ssh down")), \
                 mock.patch.object(vm, "_stop_owned_process") as stop:
                with self.assertRaisesRegex(RuntimeError, "ssh down"):
                    vm.cmd_run(self._run_args(state, False))
            stop.assert_not_called()

    def test_cmd_run_cleanup_stops_the_vm_it_launched(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            boot_info = {"pid": 111, "starttime": "5",
                         "scope_unit": "crq-vm-r1.scope"}

            def boot(*_args):
                (run / "process.json").write_text(json.dumps(
                    {"pid": 111, "starttime": "5",
                     "scope_unit": "crq-vm-r1.scope"}))
                return boot_info
            patches = self._patched_run(run)
            with patches[0], patches[1], patches[2], \
                 mock.patch.object(vm, "verify_source_scripts"), \
                 mock.patch.object(vm, "process_matches", return_value=True), \
                 mock.patch.object(vm, "boot", side_effect=boot), \
                 mock.patch.object(vm, "wait_ssh",
                                   side_effect=RuntimeError("ssh down")), \
                 mock.patch.object(vm, "_stop_owned_process",
                                   return_value={"stopped": True}) as stop:
                with self.assertRaisesRegex(RuntimeError, "ssh down"):
                    vm.cmd_run(self._run_args(state, False))
            stop.assert_called_once()

    def test_cmd_run_busy_lock_skips_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, run = self._prepared(temporary)
            patches = self._patched_run(run)
            with patches[0], patches[1], patches[2], \
                 mock.patch.object(vm, "verify_source_scripts"), \
                 mock.patch.object(vm, "run_lock",
                                   side_effect=RuntimeError("run is busy")), \
                 mock.patch.object(vm, "boot") as boot, \
                 mock.patch.object(vm, "stop_owned_process") as stop:
                with self.assertRaisesRegex(RuntimeError, "busy"):
                    vm.cmd_run(self._run_args(state, False))
            boot.assert_not_called()
            stop.assert_not_called()

    def test_boot_drops_stale_identity_from_a_stopped_run(self):
        class ExitedProcess:
            pid = 4321

            def poll(self):
                return 1

        with tempfile.TemporaryDirectory() as temporary:
            run = pathlib.Path(temporary) / "r1"
            run.mkdir()
            (run / "qemu.pid").write_text("999999\n")
            (run / "process.json").write_text(json.dumps(
                {"pid": 999999, "starttime": "1",
                 "scope_unit": "crq-vm-r1.scope"}))
            recorder = vm.Recorder(run)
            with mock.patch.object(vm, "require_memory"), \
                 mock.patch.object(vm, "tool", return_value="/bin/true"), \
                 mock.patch.object(vm.subprocess, "Popen",
                                   return_value=ExitedProcess()):
                with self.assertRaises(RuntimeError):
                    vm.boot({"run_id": "r1", "path": str(run), "port": 2222},
                            recorder, None, {"kvm_writable": True})
            self.assertFalse((run / "qemu.pid").exists())
            self.assertFalse((run / "process.json").exists())

    def _boot_with(self, run_dir, run, ports, held, popen=None):
        """Drive vm.boot with free_port/port_held stubbed; returns (result, popen)."""
        class Exited:
            pid = 4321

            def poll(self):
                return 1

        launcher = popen or mock.Mock(side_effect=lambda *a, **k: Exited())
        recorder = vm.Recorder(run_dir)
        with mock.patch.object(vm, "require_memory"), \
             mock.patch.object(vm, "tool", return_value="/bin/true"), \
             mock.patch.object(vm, "free_port", side_effect=ports), \
             mock.patch.object(vm, "port_held", side_effect=held), \
             mock.patch.object(vm.subprocess, "Popen", launcher):
            try:
                outcome = vm.boot(run, recorder, None, {"kvm_writable": True})
            except RuntimeError as error:
                outcome = error
        return outcome, launcher

    def test_boot_bounds_retries_by_launches_not_distinct_ports(self):
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = pathlib.Path(temporary) / "r1"
            run_dir.mkdir()
            run = {"run_id": "r1", "path": str(run_dir), "port": None}
            outcome, popen = self._boot_with(
                run_dir, run, [2222] * 100, lambda port: True)
            self.assertIsInstance(outcome, RuntimeError)
            self.assertEqual(popen.call_count, vm.PORT_ATTEMPTS)
            self.assertIn("%d launches" % vm.PORT_ATTEMPTS, str(outcome))

    def test_boot_retries_a_lost_bind_on_a_fresh_port_and_keeps_first_log(self):
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = pathlib.Path(temporary) / "r1"
            run_dir.mkdir()
            run = {"run_id": "r1", "path": str(run_dir), "port": None}
            ports = iter([2222, 2223])
            held = iter([True, False])

            class Process:
                pid = 4321

                def __init__(self, ok):
                    self.ok = ok

                def poll(self):
                    return None if self.ok else 1

            launches = []

            def popen(argv, cwd, stdout, stderr, start_new_session):
                launches.append(argv)
                stdout.write(b"launch %d\n" % len(launches))
                if len(launches) == 2:
                    (run_dir / "qemu.pid").write_text("4321\n")
                return Process(len(launches) == 2)

            recorder = vm.Recorder(run_dir)
            with mock.patch.object(vm, "require_memory"), \
                 mock.patch.object(vm, "tool", return_value="/bin/true"), \
                 mock.patch.object(vm, "free_port", side_effect=lambda: next(ports)), \
                 mock.patch.object(vm, "port_held", side_effect=lambda p: next(held)), \
                 mock.patch.object(vm, "process_starttime", return_value="9"), \
                 mock.patch.object(vm.subprocess, "Popen", side_effect=popen):
                result = vm.boot(run, recorder, None, {"kvm_writable": True})
            self.assertEqual(len(launches), 2)
            self.assertEqual(result["port"], 2223)
            self.assertIn("2223-:22", " ".join(launches[1]))
            self.assertEqual(json.loads((run_dir / "run.json").read_text())["port"], 2223)
            self.assertEqual((run_dir / "qemu.log").read_bytes(), b"launch 1\n")
            self.assertEqual((run_dir / "qemu.log.1").read_bytes(), b"launch 2\n")

    def test_boot_does_not_retry_when_the_port_is_free(self):
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = pathlib.Path(temporary) / "r1"
            run_dir.mkdir()
            run = {"run_id": "r1", "path": str(run_dir), "port": 2222}
            outcome, popen = self._boot_with(
                run_dir, run, [], lambda port: False)
            self.assertIsInstance(outcome, RuntimeError)
            self.assertEqual(popen.call_count, 1)
            self.assertFalse((run_dir / "run.json").exists())

    def test_boot_keeps_a_prepared_port_without_persisting(self):
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = pathlib.Path(temporary) / "r1"
            run_dir.mkdir()
            run = {"run_id": "r1", "path": str(run_dir), "port": 2250}
            with mock.patch.object(vm, "free_port") as chooser:
                outcome, popen = self._boot_with(
                    run_dir, run, [], lambda port: False)
            chooser.assert_not_called()
            self.assertIn("2250-:22", " ".join(popen.call_args[0][0]))

    def test_port_held_reports_both_outcomes(self):
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
            self.assertTrue(vm.port_held(port))
        self.assertFalse(vm.port_held(port))

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
        files = {}
        for path in SNAPSHOT_PATHS:
            key = str(path)
            if key == str(GUEST_UNIT_DIR / "crq-fixture.service"):
                if link is None:
                    files[key] = {"type": "file", "mode": "0o640", "uid": 1000,
                                  "gid": 1000, "sha256": "b" * 64}
                else:
                    files[key] = {"type": "symlink", "mode": "0o777", "uid": 1000,
                                  "gid": 1000, "link_target": link}
            elif key.endswith(("crq-alias.service", ".wants/crq-fixture.timer",
                               ".wants/crq-fixture.path")):
                files[key] = {"type": "symlink", "mode": "0o777", "uid": 1000,
                              "gid": 1000, "link_target": "target"}
            elif key.endswith("original-crq-fixture.service"):
                files[key] = None
            elif key.endswith("original-crq-alias.service.link"):
                files[key] = None
            else:
                files[key] = {"type": "file", "mode": "0o640", "uid": 1000,
                              "gid": 1000, "sha256": "b" * 64}
        return {
            "boot_id": boot,
            "manager": {"pid": pid, "invocation_id": invocation},
            "runs": [],
            "files": files,
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

    def _boundaries(self):
        return ({"before": self._snapshot(10, "i1", "boot-1"),
                 "after": self._snapshot(11, "i2", "boot-1"),
                 "after_phase": self._refusals()},
                {"before": self._snapshot(11, "i2", "boot-1"),
                 "after": self._snapshot(12, "i3", "boot-2"),
                 "after_phase": self._refusals(),
                 "boot_id_before": "boot-1", "boot_id_after": "boot-2",
                 "qemu_pid_before": 99, "qemu_pid_after": 99,
                 "qemu_identity_verified": True})

    def _jobs(self, *lines):
        return {"ok": True, "rc": 0, "timeout": False,
                "lines": list(lines), "stdout": "\n".join(lines),
                "stderr": ""}

    def _phases(self):
        return {
            "install": {"snapshot": self._snapshot(10, "i1", "boot-1",
                                                    load_state="loaded", link=None)},
            "activation": {"direct": {"run_delta": ["service"]},
                           "dependency": {"run_delta": ["service", "dependent"]},
                           "queue_blocker": {"rc": 0},
                           "queue_start": {"rc": 0},
                           "jobs_before_mask": self._jobs(
                               "77 crq-queued.service start waiting",
                               "96 crq-queued-fixture.service start waiting"),
                           "queue2_blocker": {"rc": 0},
                           "queue2_start": {"rc": 0},
                           "jobs2_before_stop": self._jobs(
                               "116 crq-queued.service start waiting",
                               "135 crq-queued-fixture.service start waiting"),
                           "stop_queued_fixture": {"rc": 0},
                           "jobs2_after_stop": self._jobs(),
                           "queued_jobs_after_release": {
                               "settled": True, "query_ok": True,
                               "rc": 0, "jobs": []},
                           "queued_jobs2_after_release": {
                               "settled": True, "query_ok": True,
                               "rc": 0, "jobs": []},
                           "queued_run_delta": ["queued"],
                           "queued2_run_delta": ["queued"],
                           "reload": {"rc": 0},
                           "masked_state": {"LoadState": "masked"},
                           "reload2": {"rc": 0},
                           "masked_state2": {"LoadState": "masked"}},
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
                                                    load_state="loaded", link=None)},
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
        phases["activation"]["queue_start"] = {"rc": 0}
        phases["activation"]["jobs_before_mask"] = self._jobs()
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
        phases["activation"]["jobs2_after_stop"] = self._jobs()
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["queued_stop_proven"])
        phases["activation"]["jobs2_after_stop"] = self._jobs(
            "135 crq-queued-fixture.service start waiting")
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

    def test_stop_round_requires_a_successful_job_query(self):
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
        phases["activation"]["jobs2_after_stop"] = []
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["queued_stop_proven"])
        report = {"schema_version": vm.REPORT_SCHEMA,
                  "image": {"sha256": DIGEST, "sums_verified": True,
                            "signature_verified": False},
                  "checks": checks, "limitations": ["limited"]}
        self.assertIn("check not proven: queued_stop_proven",
                      vm.report_problems(report))
        phases["activation"]["jobs2_after_stop"] = {
            "ok": False, "rc": 1, "lines": [], "stdout": "",
            "stderr": "Failed to list jobs"}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["queued_stop_proven"])

    def test_settlement_requires_a_successful_job_query(self):
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
                        ["queued_jobs_settled_after_mask"])
        phases["activation"]["queued_jobs_after_release"] = {
            "settled": True, "query_ok": False, "rc": 1, "jobs": []}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["queued_jobs_settled_after_mask"])

    def test_queued_rounds_require_reload_and_masked_state(self):
        phases = self._phases()
        manager, reboot = self._boundaries()
        self.assertTrue(vm.build_checks(phases, manager, reboot)
                        .get("queued_mask_proven"))
        phases["activation"]["reload"] = {"rc": 1}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks.get("queued_mask_proven"))
        report = {"schema_version": vm.REPORT_SCHEMA,
                  "image": {"sha256": DIGEST, "sums_verified": True,
                            "signature_verified": False},
                  "checks": checks, "limitations": ["limited"]}
        self.assertIn("check not proven: queued_mask_proven",
                      vm.report_problems(report))
        phases["activation"]["reload"] = {"rc": 0}
        phases["activation"]["masked_state"] = {"LoadState": "loaded"}
        self.assertFalse(vm.build_checks(phases, manager, reboot)
                         .get("queued_mask_proven"))
        phases["activation"]["masked_state"] = {"LoadState": "masked"}
        phases["activation"]["reload2"] = {"rc": 1}
        self.assertFalse(vm.build_checks(phases, manager, reboot)
                         .get("queued_mask_proven"))
        phases["activation"]["reload2"] = {"rc": 0}
        phases["activation"].pop("masked_state2")
        self.assertFalse(vm.build_checks(phases, manager, reboot)
                         .get("queued_mask_proven"))

    def test_metadata_preservation_requires_expected_paths(self):
        phases = self._phases()
        manager, reboot = self._boundaries()
        checks = vm.build_checks(phases, manager, reboot)
        self.assertTrue(checks["metadata_observed"])
        phases["install"]["snapshot"]["files"] = {}
        phases["unmask"]["snapshot"]["files"] = {}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["metadata_observed"])
        self.assertTrue(checks["metadata_equal"])
        report = {"schema_version": vm.REPORT_SCHEMA,
                  "image": {"sha256": DIGEST, "sums_verified": True,
                            "signature_verified": False},
                  "checks": checks, "limitations": ["limited"]}
        self.assertIn("check not proven: metadata_observed",
                      vm.report_problems(report))

    def test_reboot_preservation_requires_alias_and_enablement_paths(self):
        phases = self._phases()
        manager, reboot = self._boundaries()
        self.assertTrue(vm.build_checks(phases, manager, reboot)
                        ["metadata_observed"])
        for snapshot in (manager["before"], manager["after"],
                         reboot["before"], reboot["after"]):
            for path in (
                    GUEST_UNIT_DIR / "crq-alias.service",
                    GUEST_UNIT_DIR / "default.target.wants/crq-fixture.path",
                    GUEST_FIXTURE / "crq-alias.service.unit",
                    GUEST_FIXTURE / "original-crq-fixture.service"):
                snapshot["files"].pop(str(path))
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["metadata_observed"])
        self.assertTrue(checks["mask_metadata_equal"])

    def test_metadata_preservation_rejects_all_absent_required_paths(self):
        phases = self._phases()
        manager, reboot = self._boundaries()
        self.assertTrue(vm.build_checks(phases, manager, reboot)
                        ["metadata_observed"])
        for snapshot in (phases["install"]["snapshot"],
                         phases["unmask"]["snapshot"]):
            for path in list(snapshot["files"]):
                snapshot["files"][path] = None
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["metadata_observed"])
        self.assertTrue(checks["metadata_equal"])
        report = {"schema_version": vm.REPORT_SCHEMA,
                  "image": {"sha256": DIGEST, "sums_verified": True,
                            "signature_verified": False},
                  "checks": checks, "limitations": ["limited"]}
        self.assertIn("check not proven: metadata_observed",
                      vm.report_problems(report))

    def test_metadata_preservation_requires_expected_path_types(self):
        phases = self._phases()
        manager, reboot = self._boundaries()
        self.assertTrue(vm.build_checks(phases, manager, reboot)
                        ["metadata_observed"])
        service = str(GUEST_UNIT_DIR / "crq-fixture.service")
        for snapshot in (phases["install"]["snapshot"],
                         phases["unmask"]["snapshot"]):
            snapshot["files"][service] = {
                "type": "symlink", "mode": "0o777", "uid": 1000,
                "gid": 1000, "link_target": "target"}
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["metadata_observed"])
        self.assertTrue(checks["metadata_equal"])

    def test_metadata_preservation_requires_applicable_fields(self):
        phases = self._phases()
        manager, reboot = self._boundaries()
        self.assertTrue(vm.build_checks(phases, manager, reboot)
                        ["metadata_observed"])
        record = str(GUEST_FIXTURE / "record.sh")
        phases["install"]["snapshot"]["files"][record].pop("sha256")
        phases["unmask"]["snapshot"]["files"][record].pop("sha256")
        checks = vm.build_checks(phases, manager, reboot)
        self.assertFalse(checks["metadata_observed"])
        self.assertTrue(checks["metadata_equal"])

    def test_queued_jobs_must_settle_before_sampling_runs(self):
        phases = self._phases()
        phases["activation"]["queued_jobs_after_release"] = {
            "settled": False, "query_ok": True, "rc": 0,
            "jobs": ["96 crq-queued-fixture.service start running"]}
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
        stamp = {"at": "2024-01-01T00:00:00Z", "hostname": "probe-host",
                 "kernel": "6.8.0-40-generic", "uptime_seconds": 3600.0,
                 "load1": 0.05, "load5": 0.1, "load15": 0.15,
                 "mem_available_kib": 4194304, "kvm_writable": True}
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
            "host_stamps": {name: dict(stamp) for name in vm.REQUIRED_STAMPS},
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

    def test_verify_requires_host_load_stamps(self):
        with tempfile.TemporaryDirectory() as temporary:
            report = self._bound_report(temporary)
            self.assertEqual(vm.verify_report(report, pathlib.Path(temporary)), [])
            stripped = json.loads(json.dumps(report))
            del stripped["host_stamps"]
            self.assertIn("host_stamps missing",
                          vm.verify_report(stripped, pathlib.Path(temporary)))
            partial = json.loads(json.dumps(report))
            del partial["host_stamps"]["finish"]
            self.assertIn("host stamp missing: finish",
                          vm.verify_report(partial, pathlib.Path(temporary)))
            fieldless = json.loads(json.dumps(report))
            del fieldless["host_stamps"]["start"]["load1"]
            self.assertIn("host stamp start lacks load1",
                          vm.verify_report(fieldless, pathlib.Path(temporary)))

    def test_post_boundary_activation_refusal_is_required(self):
        phases = self._phases()
        manager, reboot = self._boundaries()
        self.assertTrue(vm.build_checks(phases, manager, reboot)
                        ["mask_persisted"])
        for boundary, activator in (("manager_restart", "direct"),
                                    ("manager_restart", "dependency"),
                                    ("reboot", "direct"),
                                    ("reboot", "dependency")):
            manager, reboot = self._boundaries()
            observed = manager if boundary == "manager_restart" else reboot
            observed["after_phase"][activator]["rc"] = 0
            checks = vm.build_checks(phases, manager, reboot)
            self.assertFalse(checks["mask_persisted"],
                             "%s %s succeeds" % (boundary, activator))

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

    def test_json_mode_serializes_operating_system_failures(self):
        import contextlib
        import io
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = vm.main(["--json", "verify", "/definitely-missing-crq-report.json"])
        self.assertEqual(code, 1)
        self.assertEqual(err.getvalue(), "")
        artifact = json.loads(out.getvalue())
        self.assertEqual(artifact["error"]["kind"], "thrown")

    def test_json_mode_serializes_malformed_report_containers(self):
        import contextlib
        import io
        with tempfile.TemporaryDirectory() as temporary:
            report = pathlib.Path(temporary) / "report.json"
            # A non-object report is refused (exit 2) as a structured error; a
            # report whose containers are lists answers with problems (exit 1).
            # Neither may produce an AttributeError traceback.
            for payload, expected in (([], 2), ({"image": []}, 1),
                                      ({"image": {}, "checks": []}, 1)):
                report.write_text(json.dumps(payload))
                out, err = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    code = vm.main(["--json", "verify", str(report)])
                self.assertEqual(code, expected)
                self.assertEqual(err.getvalue(), "")
                artifact = json.loads(out.getvalue())
                if expected == 2:
                    self.assertEqual(artifact["error"]["kind"], "usage")
                else:
                    self.assertTrue(artifact["problems"])


if __name__ == "__main__":
    unittest.main()
