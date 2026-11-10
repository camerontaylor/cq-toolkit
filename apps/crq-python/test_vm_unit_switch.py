"""Offline characterization for the isolated unit-switch proof harness.

No KVM, VM, network, SSH, systemd or production host is touched. The tests pin
the evidence checks, provenance binding and fail-closed report verification.
The real guest run is recorded separately and is not part of the unit suite.
"""
import importlib.util
import json
import pathlib
import tempfile
import unittest
import hashlib

ROOT = pathlib.Path(__file__).resolve().parent
OPS = ROOT / "ops"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


harness = _load("crq_vm_unit_switch", OPS / "vm-unit-switch.py")

NODE = harness.NODE_RUNTIME
PYTHON = harness.PYTHON_RUNTIME
SERVICE = "/home/probe/.config/systemd/user/crq-tick.service"
WANTS = "/home/probe/.config/systemd/user/timers.target.wants/crq-tick.timer"
STATE = {"queue.json": "q" * 64, "heartbeat.json": "h" * 64}
HISTORY = "a" * 64


def _sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def phases():
    python_sha = _sha(harness.expected_unit(PYTHON))
    node_sha = _sha(harness.expected_unit(NODE))
    preserved = {"state": STATE, "history_sha256": HISTORY}
    prepare = {
        "prepared": {"state": STATE, "history_sha256": HISTORY},
        "snapshot": {
            "hostname": "crq-probe", "user": 1000,
            "boot_id": "00000000-0000-0000-0000-000000000000",
            "files": {SERVICE: {"type": "file", "sha256": python_sha},
                      WANTS: {"type": "symlink"}},
            "units": {"crq-tick.timer": {"UnitFileState": "enabled",
                                         "ActiveState": "inactive"}},
            "history": {"sha256": HISTORY},
        },
    }
    node_phase = {
        "record": {"outcome": "completed", "runtime": NODE,
                   "prior_runtime": PYTHON},
        "completions": {"sequences": [1, 2], "invocations": ["a" * 32, "b" * 32]},
        "installed_runtime": NODE,
        "after": {"files": {SERVICE: {"type": "file", "sha256": node_sha}}},
        "preserved": preserved,
    }
    python_phase = {
        "record": {"outcome": "completed", "runtime": PYTHON,
                   "prior_runtime": NODE},
        "completions": {"sequences": [3, 4], "invocations": ["c" * 32, "d" * 32]},
        "installed_runtime": PYTHON,
        "after": {"files": {SERVICE: {"type": "file", "sha256": python_sha}}},
        "preserved": preserved,
    }
    interrupt = {
        "record": {"outcome": "pending", "phase": "drained", "runtime": NODE,
                   "prior_runtime": PYTHON},
        "after": {"files": {SERVICE: {"type": "symlink", "target": "/dev/null"}},
                  "units": {"crq-tick.timer": {"ActiveState": "inactive"}}},
        "preserved": preserved,
    }
    recover_kill = {
        "record_before": {"sha256": "1" * 64, "outcome": "pending",
                          "phase": "drained"},
        "record_after": {"sha256": "1" * 64, "outcome": "pending",
                         "phase": "drained"},
    }
    recover = {
        "record": {"outcome": "rolled_back",
                   "phase": "restore_activation_pending"},
        "after": {"files": {SERVICE: {"type": "file", "sha256": python_sha}},
                  "units": {"crq-tick.timer": {"UnitFileState": "enabled",
                                               "ActiveState": "inactive"}}},
        "preserved": preserved,
    }
    repeat = {
        "cli": {"rc": 2, "stdout": "{\"refused\": \"invalid record\"}"},
        "record_before": {"sha256": "2" * 64},
        "record_after": {"sha256": "2" * 64},
    }
    inspect = {"snapshot": {
        "files": {SERVICE: {"type": "file", "sha256": python_sha},
                  WANTS: {"type": "symlink"}},
        "state": STATE,
    }}
    return {"prepare": prepare, "switch-node": node_phase,
            "switch-python": python_phase, "interrupt": interrupt,
            "recover-kill": recover_kill, "recover": recover,
            "recover-repeat": repeat, "inspect": inspect}


class HarnessCheckTests(unittest.TestCase):
    def test_complete_evidence_passes(self):
        checks, problems = harness.build_checks(phases())
        self.assertEqual(problems, [])
        self.assertTrue(checks)
        self.assertTrue(all(value is True for value in checks.values()))

    def test_missing_phase_fails_closed(self):
        value = phases()
        del value["switch-python"]
        checks, problems = harness.build_checks(value)
        self.assertTrue(problems)
        self.assertFalse(checks.get("switch-python_completed", False))

    def test_wrong_completion_runtime_fails(self):
        value = phases()
        value["switch-node"]["record"]["runtime"] = PYTHON
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["switch-node_completed"])
        self.assertTrue(problems)

    def test_duplicate_completion_invocations_fail(self):
        value = phases()
        value["switch-node"]["completions"]["invocations"] = ["a" * 32, "a" * 32]
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["switch-node_two_advancing_distinct_completions"])
        self.assertTrue(problems)

    def test_interrupted_record_must_be_drained(self):
        value = phases()
        value["interrupt"]["record"]["phase"] = "activation_pending"
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["preactivation_interrupt_retained"])
        self.assertTrue(problems)

    def test_repeat_recovery_must_refuse_and_preserve(self):
        value = phases()
        value["recover-repeat"]["record_after"]["sha256"] = "3" * 64
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["repeat_recovery_refused"])
        self.assertTrue(problems)

    def test_expected_runtimes_are_distinct(self):
        self.assertNotEqual(harness.expected_unit(PYTHON),
                            harness.expected_unit(NODE))

    def test_guest_cloud_init_provisions_git_and_node(self):
        text = harness.render_user_data("ssh-ed25519 AAAA fixture")
        self.assertIn("hostname: crq-probe", text)
        self.assertIn("packages:", text)
        self.assertIn("- git", text)
        self.assertIn("- nodejs", text)
        self.assertIn("enable-linger", text)


class VerifyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crq-proof-verify-")
        self.addCleanup(self.temp.cleanup)
        self.run_dir = pathlib.Path(self.temp.name)
        self.host = self.run_dir / "executed-host-script.py"
        self.guest = self.run_dir / "executed-guest-probe.py"
        self.raw = self.run_dir / "raw-guest-evidence.tar.gz"
        self.host.write_bytes(b"host")
        self.guest.write_bytes(b"guest")
        self.raw.write_bytes(b"raw")
        self.report = {
            "schema_version": harness.SCHEMA_VERSION,
            "kind": harness.KIND,
            "path": str(self.run_dir),
            "phases": phases(),
            "checks": {},
            "problems": [],
            "provenance": {
                "host_script": {"artifact": self.host.name,
                                "sha256": harness.sha256_bytes(b"host")},
                "guest_script": {"artifact": self.guest.name,
                                 "sha256": harness.sha256_bytes(b"guest")},
            },
            "raw": {"raw_tar": self.raw.name,
                    "tar_sha256": harness.sha256_bytes(b"raw")},
        }
        checks, problems = harness.build_checks(self.report["phases"])
        self.report["checks"] = checks
        self.report["problems"] = problems

    def _write(self):
        path = self.run_dir / "report.json"
        path.write_text(json.dumps(self.report))
        return path

    def _verify(self):
        report = self._write()
        output = []
        # cmd_verify prints JSON; capture it without changing its logic.
        import contextlib
        import io
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            status = harness.cmd_verify(type("Args", (), {"report": report})())
        output.append(json.loads(stream.getvalue()))
        return status, output[0]

    def test_consistent_report_verifies(self):
        status, payload = self._verify()
        self.assertEqual(status, 0, payload)
        self.assertEqual(payload["problems"], [])

    def test_tampered_artifact_is_rejected(self):
        self.host.write_bytes(b"tampered")
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("host_script" in item for item in payload["problems"]))

    def test_stored_check_mismatch_is_rejected(self):
        self.report["checks"]["switch-node_completed"] = False
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("checks" in item for item in payload["problems"]))

    def test_missing_raw_evidence_is_rejected(self):
        self.raw.unlink()
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("raw" in item for item in payload["problems"]))


if __name__ == "__main__":
    unittest.main()
