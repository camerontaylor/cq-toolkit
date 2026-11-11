"""Offline tests for the guest-only unit-switch proof adapter.

No systemd, VM, network or controller journal is touched. A fake command runner
models the finite host effects; real temporary files exercise snapshot,
validation and restoration.
"""
import base64
import copy
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import uuid
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent
OPS = ROOT / "ops"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


adapter_mod = _load("crq_unit_switch_adapter", OPS / "unit-switch-adapter.py")

UNIT = "crq-tick.service"
TIMER = "crq-tick.timer"
WANTS_REL = "timers.target.wants/crq-tick.timer"
NODE = "node:" + "b" * 40


class FakeSystemd:
    def __init__(self, service, timer, wants, completions):
        self.service = service
        self.timer = timer
        self.wants = wants
        self.completions = completions
        self.masked = False
        self.timer_active = False
        self.service_active = False
        self.invocation = ""
        self.calls = []

    def runtime(self):
        try:
            text = self.service.read_text()
        except OSError:
            return None
        for line in text.splitlines():
            if line.startswith("ExecStart=") and "--runtime" in line:
                parts = line.split()
                return parts[parts.index("--runtime") + 1]
        return None

    def _write_completion(self):
        runtime = self.runtime()
        if runtime is None:
            return
        records = []
        if self.completions.exists():
            for line in self.completions.read_text().splitlines():
                if line.strip():
                    records.append(json.loads(line))
        sequence = max((item["sequence"] for item in records), default=0) + 1
        self.invocation = uuid.uuid4().hex
        record = {"unit": UNIT, "runtime": runtime, "success": True,
                  "sequence": sequence, "invocation": self.invocation,
                  "at": "2026-01-01T00:00:00Z",
                  "boot_id": "00000000-0000-0000-0000-000000000000"}
        with self.completions.open("a") as out:
            out.write(json.dumps(record, sort_keys=True) + "\n")

    def show(self, unit, props):
        service = unit == UNIT
        values = {
            "LoadState": "masked" if service and self.masked else "loaded",
            "ActiveState": ("active" if ((service and self.service_active)
                                         or (not service and self.timer_active))
                            else "inactive"),
            "SubState": "dead",
            "UnitFileState": ("disabled" if service
                              else ("enabled" if self.wants.is_symlink()
                                    else "disabled")),
            "FragmentPath": str(self.service if service else self.timer),
            "MainPID": "0",
            "ControlGroup": "",
            "InvocationID": self.invocation,
            "Result": "success",
        }
        return "\n".join("%s=%s" % (prop, values[prop]) for prop in props) + "\n"

    def run(self, argv, timeout):
        self.calls.append(list(argv))
        if argv[:2] == ["systemctl", "--user"]:
            rest = argv[2:]
            if rest[0] == "show":
                return {"argv": argv, "rc": 0,
                        "stdout": self.show(rest[1], rest[3].split(",")),
                        "stderr": "", "timeout": False}
            if rest[0] == "list-jobs":
                return {"argv": argv, "rc": 0, "stdout": "", "stderr": "",
                        "timeout": False}
            if rest[0] == "daemon-reload":
                self.masked = self.service.is_symlink()
                return {"argv": argv, "rc": 0, "stdout": "", "stderr": "",
                        "timeout": False}
            if rest[0] == "stop":
                if rest[1] == UNIT:
                    self.service_active = False
                else:
                    self.timer_active = False
                return {"argv": argv, "rc": 0, "stdout": "", "stderr": "",
                        "timeout": False}
            if rest[0] == "reset-failed":
                return {"argv": argv, "rc": 0, "stdout": "", "stderr": "",
                        "timeout": False}
            if rest[0] == "start":
                if self.masked:
                    return {"argv": argv, "rc": 1, "stdout": "",
                            "stderr": "Unit %s is masked." % rest[1],
                            "timeout": False}
                if rest[1] == UNIT:
                    self._write_completion()
                    self.service_active = False
                else:
                    self.timer_active = True
                    self._write_completion()
                return {"argv": argv, "rc": 0, "stdout": "", "stderr": "",
                        "timeout": False}
        if argv[0].endswith("python3") and argv[1:] == ["--version"]:
            return {"argv": argv, "rc": 0, "stdout": "Python 3.12.0\n",
                    "stderr": "", "timeout": False}
        if argv[0].endswith("node") and argv[1:] == ["--version"]:
            return {"argv": argv, "rc": 0, "stdout": "v18.19.1\n",
                    "stderr": "", "timeout": False}
        return {"argv": argv, "rc": 1, "stdout": "", "stderr": "unexpected",
                "timeout": False}


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crq-unit-switch-")
        self.addCleanup(self.temp.cleanup)
        base = pathlib.Path(self.temp.name)
        self.unit_dir = base / "user"
        self.fixture_dir = base / "fixture"
        self.proof_root = base / "proof-bin"
        self.unit_dir.mkdir()
        (self.unit_dir / "timers.target.wants").mkdir()
        self.fixture_dir.mkdir()
        self.proof_root.mkdir()
        for name in ("unit-switch-fixture.py", "unit-switch-fixture.mjs"):
            (self.proof_root / name).write_text("#!/bin/sh\n")
        self.service = self.unit_dir / UNIT
        self.timer = self.unit_dir / TIMER
        self.wants = self.unit_dir / WANTS_REL
        self.completions = self.fixture_dir / "completions.jsonl"
        self.adapter = adapter_mod.GuestFixtureAdapter(
            self.unit_dir, self.fixture_dir, proof_root=self.proof_root,
            guest_only=False, completion_timeout=0.5, drain_timeout=0.5,
            sleep=lambda _seconds: None)
        self.fake = FakeSystemd(self.service, self.timer, self.wants,
                                self.completions)
        self.adapter.runner = self.fake.run
        self.service.write_text(self.adapter.render_unit("python"))
        self.service.chmod(0o644)
        self.timer.write_text(self.adapter.render_timer())
        self.timer.chmod(0o644)
        self.wants.symlink_to("../" + TIMER)

    def _snapshot(self):
        snapshot = self.adapter.snapshot(UNIT)
        self.adapter.validate_snapshot(UNIT, snapshot)
        return snapshot

    def _repair_adapter(self):
        repair = adapter_mod.GuestFixtureAdapter(
            self.unit_dir, self.fixture_dir, unit=adapter_mod.REPAIR_UNIT,
            proof_root=self.proof_root, guest_only=False,
            completion_timeout=0.5, drain_timeout=0.5,
            sleep=lambda _seconds: None)
        repair.runner = self.fake.run
        paths = {
            "service": self.unit_dir / adapter_mod.REPAIR_UNIT,
            "timer": self.unit_dir / adapter_mod.REPAIR_TIMER,
            "path": self.unit_dir / adapter_mod.REPAIR_PATH,
            "timer_wants": self.unit_dir / adapter_mod.REPAIR_TIMER_WANTS,
            "path_wants": self.unit_dir / adapter_mod.REPAIR_PATH_WANTS,
            "dropin": self.unit_dir / adapter_mod.REPAIR_DROPIN,
        }
        paths["timer_wants"].parent.mkdir(parents=True, exist_ok=True)
        paths["path_wants"].parent.mkdir(parents=True, exist_ok=True)
        paths["dropin"].parent.mkdir(parents=True, exist_ok=True)
        paths["service"].write_text(repair.render_unit("python"))
        paths["timer"].write_text(repair.render_timer())
        paths["path"].write_text(repair.render_path())
        paths["dropin"].write_text(repair.render_dropin())
        for key in ("service", "timer", "path", "dropin"):
            paths[key].chmod(0o644)
        paths["timer_wants"].symlink_to("../" + adapter_mod.REPAIR_TIMER)
        paths["path_wants"].symlink_to("../" + adapter_mod.REPAIR_PATH)
        return repair, paths

    def test_preflight_reads_installed_runtime(self):
        result = self.adapter.preflight(UNIT, NODE)
        self.assertEqual(result["runtime"], "python")
        inventory = result["inventory"]
        self.assertEqual(inventory["unit"], UNIT)
        self.assertEqual(inventory["topology"], "tick")
        self.assertEqual(set(inventory["paths"]),
                         {"service", "timer", "wants"})
        self.assertEqual(inventory["activators"]["timer_active"], "inactive")
        self.assertEqual(inventory["activators"]["timer_unit_file_state"],
                         "enabled")

    def test_repair_topology_inventory_and_rendering(self):
        repair, paths = self._repair_adapter()
        service = paths["service"]
        timer = paths["timer"]
        path = paths["path"]
        timer_wants = paths["timer_wants"]
        path_wants = paths["path_wants"]
        dropin = paths["dropin"]
        inventory = repair.inventory()
        self.assertEqual(inventory["topology"], "repair")
        self.assertEqual(set(inventory["paths"]),
                         {"service", "timer", "timer_wants", "path",
                          "path_wants", "dropin"})
        self.assertEqual(inventory["locations"]["dropin"], str(dropin))
        self.assertEqual(inventory["activators"]["path_active"], "inactive")
        self.assertIn("PathExists=" + str(
            self.fixture_dir / "repair-path-trigger"), repair.render_path())
        self.assertIn("OnUnitInactiveSec=5s", repair.render_timer())
        self.assertIn("Requires=crq-probe-blocker.service",
                      repair.render_dropin())
        snapshot = repair.snapshot(adapter_mod.REPAIR_UNIT)
        repair.validate_snapshot(adapter_mod.REPAIR_UNIT, snapshot)
        tampered = copy.deepcopy(snapshot)
        tampered["activators"]["path_active"] = "activating"
        with self.assertRaises(RuntimeError):
            repair.validate_snapshot(adapter_mod.REPAIR_UNIT, tampered)

    def test_repair_inventory_allows_the_exact_topology(self):
        repair, paths = self._repair_adapter()
        inventory = repair.preflight(adapter_mod.REPAIR_UNIT, "python")["inventory"]
        self.assertEqual(inventory["topology"], "repair")
        self.assertEqual(set(inventory["paths"]),
                         {"service", "timer", "timer_wants", "path",
                          "path_wants", "dropin"})
        self.assertIsNotNone(repair.last_inventory)
        self.assertTrue(paths["dropin"].is_file())

    def test_repair_inventory_refuses_rogue_unit_before_mutation(self):
        repair, paths = self._repair_adapter()
        rogue = self.unit_dir / "crq-repair.socket"
        rogue.write_text("[Socket]\nListenStream=%t/crq-repair-proof.sock\n")
        with self.assertRaisesRegex(RuntimeError, "outside the allowlisted"):
            repair.preflight(adapter_mod.REPAIR_UNIT, "python")
        self.assertTrue(rogue.is_file())
        self.assertIsNone(repair.last_inventory)
        self.assertTrue(paths["service"].is_file())

    def test_repair_inventory_refuses_unknown_wants_link_before_mutation(self):
        repair, paths = self._repair_adapter()
        rogue = self.unit_dir / "default.target.wants" / adapter_mod.REPAIR_TIMER
        rogue.parent.mkdir(parents=True, exist_ok=True)
        rogue.symlink_to("../" + adapter_mod.REPAIR_TIMER)
        with self.assertRaisesRegex(RuntimeError, "outside the allowlisted"):
            repair.preflight(adapter_mod.REPAIR_UNIT, "python")
        self.assertTrue(rogue.is_symlink())
        self.assertIsNone(repair.last_inventory)
        self.assertTrue(paths["service"].is_file())

    def test_repair_inventory_refuses_unknown_dropin_before_mutation(self):
        repair, paths = self._repair_adapter()
        rogue = paths["dropin"].parent / "20-rogue.conf"
        rogue.write_text("[Unit]\nDescription=rogue\n")
        with self.assertRaisesRegex(RuntimeError, "outside the allowlisted"):
            repair.preflight(adapter_mod.REPAIR_UNIT, "python")
        self.assertTrue(rogue.is_file())
        self.assertIsNone(repair.last_inventory)
        self.assertTrue(paths["dropin"].is_file())

    def test_repair_inventory_refuses_unsafe_metadata_before_mutation(self):
        repair, paths = self._repair_adapter()
        paths["dropin"].chmod(0o666)
        with self.assertRaisesRegex(RuntimeError, "group- or world-writable"):
            repair.preflight(adapter_mod.REPAIR_UNIT, "python")
        self.assertEqual(paths["dropin"].stat().st_mode & 0o777, 0o666)
        self.assertIsNone(repair.last_inventory)
        self.assertTrue(paths["service"].is_file())

    def test_tick_topology_refuses_path_rendering(self):
        with self.assertRaises(RuntimeError):
            self.adapter.render_path()
        with self.assertRaises(RuntimeError):
            self.adapter.render_dropin()

    def test_preflight_refuses_unknown_unit(self):
        with self.assertRaises(RuntimeError):
            self.adapter.preflight("crq-other.service", NODE)

    def test_timer_accuracy_is_bounded(self):
        # The default 1min accuracy can outlast the completion bound; the
        # proof timer must fire promptly after the oneshot becomes inactive.
        text = self.adapter.render_timer()
        self.assertIn("OnUnitInactiveSec=1s", text)
        self.assertIn("AccuracySec=1s", text)

    def test_snapshot_rejects_mask_as_prior_state(self):
        snapshot = self._snapshot()
        tampered = copy.deepcopy(snapshot)
        state = tampered["paths"][str(self.service)]
        mode = state["mode"]
        uid, gid = state["uid"], state["gid"]
        state.clear()
        state.update({"type": "symlink", "mode": mode, "uid": uid,
                      "gid": gid, "target": "/dev/null",
                      "xattrs": []})
        with self.assertRaises(RuntimeError):
            self.adapter.validate_snapshot(UNIT, tampered)

    def test_snapshot_rejects_non_restorable_activator_state(self):
        snapshot = self._snapshot()
        tampered = copy.deepcopy(snapshot)
        tampered["activators"]["service_active"] = "failed"
        with self.assertRaises(RuntimeError):
            self.adapter.validate_snapshot(UNIT, tampered)

    def test_snapshot_rejects_digest_mismatch(self):
        snapshot = self._snapshot()
        tampered = copy.deepcopy(snapshot)
        state = tampered["paths"][str(self.service)]
        data = base64.b64decode(state["bytes_b64"])
        state["bytes_b64"] = base64.b64encode(data + b"x").decode()
        with self.assertRaises(RuntimeError):
            self.adapter.validate_snapshot(UNIT, tampered)

    def test_snapshot_rejects_unowned_path(self):
        snapshot = self._snapshot()
        tampered = copy.deepcopy(snapshot)
        tampered["paths"]["/tmp/outside.service"] = tampered["paths"].pop(
            str(self.service))
        with self.assertRaises(RuntimeError):
            self.adapter.validate_snapshot(UNIT, tampered)

    def test_stop_drain_install_and_restore_round_trip(self):
        snapshot = self._snapshot()
        self.adapter.stop_and_drain(UNIT)
        self.assertTrue(self.service.is_symlink())
        self.assertEqual(self.fake.masked, True)
        self.adapter.install(UNIT, NODE)
        self.assertTrue(self.service.is_symlink())
        self.assertEqual(os.readlink(self.service), "/dev/null")
        self.assertEqual(self.fake.masked, True)
        self.assertIsNone(self.fake.runtime())
        staged = self.unit_dir / (".crq-tick.service.staged")
        self.assertTrue(staged.is_file())
        self.adapter.start(UNIT)
        self.assertFalse(self.service.is_symlink())
        self.assertFalse(staged.exists())
        self.assertEqual(self.fake.runtime(), NODE)
        first = self.adapter.completion(UNIT, NODE, 0)
        second = self.adapter.completion(UNIT, NODE, first["sequence"])
        self.assertLess(first["sequence"], second["sequence"])
        self.assertNotEqual(first["invocation"], second["invocation"])
        self.adapter.stop_and_drain(UNIT)
        self.adapter.restore(UNIT, snapshot)
        self.assertTrue(self.service.is_symlink())
        self.assertEqual(os.readlink(self.service), "/dev/null")
        self.assertTrue(staged.is_file())
        self.assertEqual(staged.read_text(), self.adapter.render_unit("python"))
        self.assertIsNone(self.fake.runtime())
        self.adapter.restore_activation(UNIT, snapshot)
        self.assertEqual(self.service.read_text(), self.adapter.render_unit("python"))
        self.assertEqual(self.service.stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.fake.runtime(), "python")
        self.assertFalse(self.fake.timer_active)

    def test_stop_drain_combines_systemd_and_queue_observation(self):
        self._snapshot()
        self.adapter.queue_drain = lambda: {"drained": True, "blocked": []}
        drain = self.adapter.stop_and_drain(UNIT)
        self.assertEqual(drain["queue_drain"],
                         {"drained": True, "blocked": []})
        self.assertTrue(self.fake.masked)
        self.assertEqual(drain["owned"],
                         {"main_pid": 0, "pids": [], "cgroup": ""})
        self.assertEqual(drain["service_stop"]["rc"], 0)
        self.assertFalse(drain["service_stop"]["timeout"])
        self.assertEqual(drain["jobs_observation"]["command"]["rc"], 0)
        self.assertEqual(drain["jobs_observation"]["lines"], [])

    def test_stop_drain_refuses_when_queue_work_is_alive(self):
        self._snapshot()
        blocked = [{"item": "pr1", "state": "alive", "run": "a" * 32}]
        self.adapter.queue_drain = lambda: {"drained": False,
                                            "blocked": blocked}
        with self.assertRaisesRegex(RuntimeError, "queue-owned work"):
            self.adapter.stop_and_drain(UNIT)
        self.assertTrue(self.fake.masked)
        self.assertEqual(self.adapter.last_drain["queue_drain"],
                         {"drained": False, "blocked": blocked})

    def test_stop_drain_treats_probe_failure_as_ambiguous(self):
        self._snapshot()

        def broken():
            raise RuntimeError("probe subsystem failed")

        self.adapter.queue_drain = broken
        with self.assertRaisesRegex(RuntimeError, "ownership is unknown"):
            self.adapter.stop_and_drain(UNIT)
        self.assertTrue(self.fake.masked)

    def test_stop_drain_refuses_malformed_queue_observation(self):
        self._snapshot()
        self.adapter.queue_drain = lambda: {"drained": "yes", "blocked": []}
        with self.assertRaisesRegex(RuntimeError, "malformed"):
            self.adapter.stop_and_drain(UNIT)
        self.assertTrue(self.fake.masked)

    def test_install_keeps_direct_start_fenced_until_release(self):
        snapshot = self._snapshot()
        self.adapter.stop_and_drain(UNIT)
        self.adapter.install(UNIT, NODE)
        direct = self.fake.run(
            ["systemctl", "--user", "start", UNIT], 60)
        self.assertNotEqual(direct["rc"], 0)
        self.assertIn("masked", direct["stderr"].lower())
        self.assertFalse(self.completions.exists())
        self.assertTrue((self.unit_dir / (".crq-tick.service.staged")).is_file())
        self.adapter.stop_and_drain(UNIT)
        self.adapter.restore(UNIT, snapshot)
        staged = self.unit_dir / ".crq-tick.service.staged"
        self.assertTrue(staged.is_file())
        self.assertTrue(self.service.is_symlink())
        self.assertEqual(os.readlink(self.service), "/dev/null")
        direct = self.fake.run(["systemctl", "--user", "start", UNIT], 60)
        self.assertNotEqual(direct["rc"], 0)
        self.assertIn("masked", direct["stderr"].lower())
        self.adapter.restore_activation(UNIT, snapshot)
        self.assertFalse(staged.exists())
        self.assertFalse(self.service.is_symlink())
        self.assertEqual(self.fake.runtime(), "python")

    def test_restore_keeps_prior_service_fenced_until_activation(self):
        snapshot = self._snapshot()
        self.adapter.stop_and_drain(UNIT)
        self.adapter.install(UNIT, NODE)
        self.adapter.start(UNIT)
        self.adapter.stop_and_drain(UNIT)
        restored = self.adapter.restore(UNIT, snapshot)
        self.assertEqual(restored["runtime"], "python")
        self.assertEqual(restored["masked"]["LoadState"], "masked")
        self.assertIsNone(self.fake.runtime())
        staged = self.unit_dir / ".crq-tick.service.staged"
        self.assertTrue(staged.is_file())
        self.assertTrue(self.service.is_symlink())
        self.assertEqual(os.readlink(self.service), "/dev/null")
        direct = self.fake.run(["systemctl", "--user", "start", UNIT], 60)
        self.assertNotEqual(direct["rc"], 0)
        self.assertIn("masked", direct["stderr"].lower())
        self.assertIsNone(self.fake.runtime())
        self.adapter.restore_activation(UNIT, snapshot)
        self.assertFalse(self.service.is_symlink())
        self.assertEqual(self.service.read_text(), self.adapter.render_unit("python"))

    def test_timeout_output_is_decoded_and_json_serializable(self):
        expired = subprocess.TimeoutExpired(["systemctl", "--user", "start", UNIT], 1)
        expired.stdout = b"partial output \xff"
        expired.stderr = b"timeout boom"
        with mock.patch.object(adapter_mod.subprocess, "run", side_effect=expired):
            self.adapter.runner = self.adapter._subprocess_runner
            switch = self.adapter.run_command(
                ["systemctl", "--user", "start", UNIT], timeout=1)
            recovery = self.adapter.run_command(
                ["systemctl", "--user", "stop", TIMER], timeout=1)
        self.assertTrue(switch["timeout"])
        self.assertTrue(recovery["timeout"])
        self.assertIsInstance(switch["stdout"], str)
        self.assertIsInstance(recovery["stderr"], str)
        self.assertIn("partial output", switch["stdout"])
        self.assertIn("timeout boom", recovery["stderr"])
        json.dumps({"commands": self.adapter.commands})

    def test_stop_drain_refuses_unsafe_service_mode(self):
        self._snapshot()
        self.service.chmod(0o666)
        with self.assertRaises(RuntimeError):
            self.adapter.stop_and_drain(UNIT)

    def test_completion_refuses_wrong_runtime(self):
        snapshot = self._snapshot()
        self.adapter.stop_and_drain(UNIT)
        self.adapter.install(UNIT, "python")
        self.adapter.start(UNIT)
        with self.assertRaises(RuntimeError):
            self.adapter.completion(UNIT, NODE, 0)
        self.adapter.stop_and_drain(UNIT)
        self.adapter.restore(UNIT, snapshot)

    def test_guest_gate_refuses_non_guest_layout(self):
        gated = adapter_mod.GuestFixtureAdapter(
            self.unit_dir, self.fixture_dir, proof_root=self.proof_root,
            guest_only=True, runner=self.fake.run)
        with self.assertRaises(RuntimeError):
            gated.preflight(UNIT, NODE)

    def test_validate_snapshot_enforces_guest_gate(self):
        snapshot = self._snapshot()
        gated = adapter_mod.GuestFixtureAdapter(
            self.unit_dir, self.fixture_dir, proof_root=self.proof_root,
            guest_only=True, runner=self.fake.run)
        with self.assertRaises(RuntimeError):
            gated.validate_snapshot(UNIT, snapshot)

    def test_sequence_rejects_malformed_log(self):
        self.completions.write_text("{not json}\n")
        with self.assertRaises(RuntimeError):
            self.adapter.sequence(UNIT)


if __name__ == "__main__":
    unittest.main()
