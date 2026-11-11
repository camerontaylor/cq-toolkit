"""Offline tests for the proof CLI wiring and explicit gate.

No systemd, VM, network or production journal is touched. The controller is the
real module; only the guest adapter and host effects' git/state surfaces are
temporary fixtures.
"""
import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent
OPS = ROOT / "ops"
NODE = "node:" + "b" * 40


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = _load("crq_unit_switch_cli", OPS / "unit-switch.py")


class FakeAdapter:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.calls = []
        self.commands = []
        self.sequence_number = 0
        self.instances.append(self)

    def preflight(self, unit, runtime):
        self.calls.append("preflight")
        return {"runtime": "python"}

    def snapshot(self, unit):
        self.calls.append("snapshot")
        return {"proof": True}

    def validate_snapshot(self, unit, snapshot):
        self.calls.append("validate_snapshot")

    def stop_and_drain(self, unit):
        self.calls.append("stop_and_drain")

    def sequence(self, unit):
        self.calls.append("sequence")
        return self.sequence_number

    def install(self, unit, runtime):
        self.calls.append("install")

    def start(self, unit):
        self.calls.append("start")

    def completion(self, unit, runtime, previous):
        self.calls.append("completion")
        self.sequence_number += 1
        return {"unit": unit, "runtime": runtime, "success": True,
                "sequence": self.sequence_number}

    def restore(self, unit, snapshot):
        self.calls.append("restore")

    def restore_activation(self, unit, snapshot):
        self.calls.append("restore_activation")


class TimeoutAdapter(FakeAdapter):
    run_command = cli.adapter_mod.GuestFixtureAdapter.run_command

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.runner = lambda argv, timeout: {
            "argv": list(argv), "rc": None, "timeout": True,
            "stdout": b"partial output", "stderr": b"timeout boom"}

    def refuse(self, message):
        raise cli.dc.Refused(message)

    def stop_and_drain(self, unit):
        self.calls.append("stop_and_drain")
        self.run_command(["systemctl", "--user", "stop", "crq-tick.timer"],
                         timeout=1)
        raise cli.dc.Refused("timer stop timed out")


class CliTests(unittest.TestCase):
    def setUp(self):
        FakeAdapter.instances.clear()
        self.temp = tempfile.TemporaryDirectory(prefix="crq-unit-switch-cli-")
        self.addCleanup(self.temp.cleanup)
        base = pathlib.Path(self.temp.name)
        self.root = base / "checkout"
        state = self.root / "apps/crq-python/state"
        state.mkdir(parents=True)
        (self.root / "apps/crq-python/config.json").write_text("{}\n")
        (self.root / ".gitignore").write_text("apps/crq-python/state/\n")
        (state / "queue.json").write_text('{"items": []}\n')
        (state / "heartbeat.json").write_text('{"last_tick": "2026-01-01T00:00:00Z"}\n')
        for command in (("init", "-q"), ("config", "user.email", "cli@example.invalid"),
                        ("config", "user.name", "CLI Fixture"), ("add", "."),
                        ("commit", "-qm", "baseline")):
            self._git(*command)
        self.records = base / "records"
        self.records.mkdir(mode=0o700)

    def _git(self, *args):
        import subprocess
        subprocess.run(["git", "-C", str(self.root), *args], check=True,
                       capture_output=True, text=True)

    def _run(self, argv):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status = cli.main(argv)
        return status, output.getvalue()

    def test_switch_requires_explicit_gate(self):
        status, output = self._run(["switch", "--root", str(self.root),
                                    "--record-dir", str(self.records),
                                    "--runtime", NODE])
        self.assertEqual(status, 2)
        self.assertIn("--proof-fixture", output)
        self.assertFalse(any(self.records.iterdir()))

    def test_recover_requires_explicit_gate(self):
        status, output = self._run(["recover", "--root", str(self.root),
                                    "--record-dir", str(self.records),
                                    "--record", str(self.records / "controller-x.json")])
        self.assertEqual(status, 2)
        self.assertIn("--proof-fixture", output)

    def test_record_dir_refusals_are_json_not_tracebacks(self):
        link = self.records.parent / "records-link"
        link.symlink_to(self.records, target_is_directory=True)
        cases = (
            ["switch", "--root", str(self.root), "--record-dir", str(link),
             "--runtime", NODE, "--proof-fixture"],
            ["recover", "--root", str(self.root), "--record-dir", str(link),
             "--record", str(link / "controller-x.json"), "--proof-fixture"],
        )
        for argv in cases:
            with self.subTest(command=argv[0]):
                status, output = self._run(argv)
                self.assertEqual(status, 2)
                payload = json.loads(output)
                self.assertIn("symlink", payload["refused"])

    def test_record_dir_oserror_is_json_not_traceback(self):
        with mock.patch.object(cli, "_prepare_records",
                               side_effect=OSError("permission denied")):
            for argv in (
                ["switch", "--root", str(self.root),
                 "--record-dir", str(self.records), "--runtime", NODE,
                 "--proof-fixture"],
                ["recover", "--root", str(self.root),
                 "--record-dir", str(self.records),
                 "--record", str(self.records / "controller-x.json"),
                 "--proof-fixture"],
            ):
                with self.subTest(command=argv[0]):
                    status, output = self._run(argv)
                    self.assertEqual(status, 2)
                    payload = json.loads(output)
                    self.assertIn("unusable", payload["refused"])

    def test_switch_calls_the_actual_controller_seam(self):
        with mock.patch.object(cli.adapter_mod, "GuestFixtureAdapter", FakeAdapter):
            status, output = self._run([
                "switch", "--root", str(self.root),
                "--record-dir", str(self.records), "--runtime", NODE,
                "--proof-fixture"])
        self.assertEqual(status, 0, output)
        payload = json.loads(output)
        self.assertEqual(payload["record"]["outcome"], "completed")
        self.assertEqual(payload["record"]["runtime"], NODE)
        self.assertEqual(FakeAdapter.instances[0].calls,
                         ["preflight", "snapshot", "validate_snapshot",
                          "stop_and_drain", "sequence", "install", "start",
                          "completion", "completion"])
        journal = list(self.records.glob("controller-*.json"))
        self.assertEqual(len(journal), 1)
        saved = json.loads(journal[0].read_text())
        self.assertEqual(saved["outcome"], "completed")
        self.assertEqual(len(saved["completions"]), 2)

    def test_switch_wires_the_controller_queue_drain_into_the_adapter(self):
        with mock.patch.object(cli.adapter_mod, "GuestFixtureAdapter",
                               FakeAdapter):
            status, output = self._run([
                "switch", "--root", str(self.root),
                "--record-dir", str(self.records), "--runtime", NODE,
                "--proof-fixture"])
        self.assertEqual(status, 0, output)
        adapter = FakeAdapter.instances[0]
        queue_drain = adapter.kwargs.get("queue_drain")
        self.assertTrue(callable(queue_drain))
        self.assertEqual(queue_drain(), {"drained": True, "blocked": []})

    def test_switch_queue_refusal_retains_structured_drain_evidence(self):
        run_id = "a" * 32
        state = self.root / "apps/crq-python/state"
        (state / "queue.json").write_text(json.dumps({"items": [
            {"id": "pr1", "state": "reviewing",
             "run": {"run_id": run_id, "pid": 4242}}]}))
        with mock.patch.object(cli.adapter_mod, "GuestFixtureAdapter",
                               FakeAdapter), \
                mock.patch.object(cli.dc, "_runner_liveness",
                                  return_value=lambda *args: "alive"):
            status, output = self._run([
                "switch", "--root", str(self.root),
                "--record-dir", str(self.records), "--runtime", NODE,
                "--proof-fixture"])
        self.assertEqual(status, 2, output)
        payload = json.loads(output)
        self.assertIn("queue-owned work", payload["refused"])
        self.assertEqual(payload["drain"]["blocked"], [
            {"item": "pr1", "state": "alive", "run": run_id}])
        self.assertEqual(FakeAdapter.instances[0].calls, [])
        self.assertEqual(list(self.records.glob("controller-*.json")), [])

    def test_switch_refuses_unsupported_unit_before_adapter(self):
        with mock.patch.object(cli.adapter_mod, "GuestFixtureAdapter", FakeAdapter):
            status, output = self._run([
                "switch", "--root", str(self.root),
                "--record-dir", str(self.records), "--unit", "crq-other.service",
                "--runtime", NODE, "--proof-fixture"])
        self.assertEqual(status, 2)
        self.assertIn("invalid unit or runtime", output)
        self.assertEqual(list(self.records.glob("controller-*.json")), [])

    def test_recover_refuses_record_outside_record_dir(self):
        outside = pathlib.Path(self.temp.name) / "outside.json"
        outside.write_text("{}")
        with mock.patch.object(cli.adapter_mod, "GuestFixtureAdapter", FakeAdapter):
            status, output = self._run([
                "recover", "--root", str(self.root),
                "--record-dir", str(self.records),
                "--record", str(outside), "--proof-fixture"])
        self.assertEqual(status, 2)
        self.assertIn("invalid controller transaction record path", output)

    def test_switch_timeout_keeps_structured_command_evidence(self):
        with mock.patch.object(cli.adapter_mod, "GuestFixtureAdapter",
                               TimeoutAdapter):
            status, output = self._run([
                "switch", "--root", str(self.root),
                "--record-dir", str(self.records), "--runtime", NODE,
                "--proof-fixture"])
        self.assertEqual(status, 3, output)
        payload = json.loads(output)
        self.assertTrue(payload["commands"])
        self.assertEqual(payload["commands"][0]["stdout"], "partial output")
        self.assertEqual(payload["commands"][0]["stderr"], "timeout boom")

    def test_recover_timeout_keeps_structured_command_evidence(self):
        record = self.records / ("controller-" + "a" * 32 + ".json")
        record.write_text(json.dumps({
            "schema_version": cli.dc.JOURNAL_SCHEMA,
            "transaction_id": "a" * 32,
            "operation": "unit_switch",
            "unit": "crq-tick.service",
            "runtime": NODE,
            "prior_runtime": "python",
            "outcome": "pending",
            "phase": "snapshot",
            "at": "2026-01-01T00:00:00Z",
            "snapshot": {},
            "state": None,
        }))
        with mock.patch.object(cli.adapter_mod, "GuestFixtureAdapter",
                               TimeoutAdapter):
            status, output = self._run([
                "recover", "--root", str(self.root),
                "--record-dir", str(self.records),
                "--record", str(record), "--proof-fixture"])
        self.assertEqual(status, 3, output)
        payload = json.loads(output)
        self.assertTrue(payload["commands"])
        self.assertEqual(payload["commands"][0]["stdout"], "partial output")
        self.assertEqual(payload["commands"][0]["stderr"], "timeout boom")


if __name__ == "__main__":
    unittest.main()
