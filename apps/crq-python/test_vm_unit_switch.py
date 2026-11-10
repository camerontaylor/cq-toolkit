"""Offline characterization for the isolated unit-switch proof harness.

No KVM, VM, network, SSH, systemd or production host is touched. The tests pin
the evidence checks, provenance binding and fail-closed report verification.
The real guest run is recorded separately and is not part of the unit suite.
"""
import importlib.util
import io
import json
import pathlib
import subprocess
import tempfile
import tarfile
import unittest
import hashlib
from unittest import mock

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
SOURCE_COMMIT = "c" * 40
RECORDS = {}


def _sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def _record(name, fields, raw_fields=None):
    raw = json.dumps(raw_fields if raw_fields is not None else fields,
                     sort_keys=True).encode()
    RECORDS[name] = raw
    data = json.dumps(fields, sort_keys=True).encode()
    return {**fields,
            "path": "/home/probe/records/controller-"
                    + hashlib.md5(name.encode()).hexdigest() + ".json",
            "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def phases():
    RECORDS.clear()
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
        "cli": {"rc": 0},
        "record": _record("switch-node", {
            "outcome": "completed", "phase": "activation_pending",
            "runtime": NODE, "prior_runtime": PYTHON}),
        "completions": {"sequences": [1, 2], "invocations": ["a" * 32, "b" * 32]},
        "installed_runtime": NODE,
        "after": {"files": {SERVICE: {"type": "file", "sha256": node_sha}}},
        "preserved": preserved,
    }
    python_phase = {
        "cli": {"rc": 0},
        "record": _record("switch-python", {
            "outcome": "completed", "phase": "activation_pending",
            "runtime": PYTHON, "prior_runtime": NODE}),
        "completions": {"sequences": [3, 4], "invocations": ["c" * 32, "d" * 32]},
        "installed_runtime": PYTHON,
        "after": {"files": {SERVICE: {"type": "file", "sha256": python_sha}}},
        "preserved": preserved,
    }
    pending = {"outcome": "pending", "phase": "drained", "runtime": NODE,
               "prior_runtime": PYTHON}
    rolled_back = {"outcome": "rolled_back",
                   "phase": "restore_activation_pending",
                   "runtime": NODE, "prior_runtime": PYTHON}
    pending_record = _record("recover-transaction", pending,
                             raw_fields=rolled_back)
    final_record = _record("recover-transaction", rolled_back)
    interrupt = {
        "cli": {"rc": -9},
        "record": dict(pending_record),
        "after": {"files": {SERVICE: {"type": "symlink", "target": "/dev/null"}},
                  "units": {"crq-tick.timer": {"ActiveState": "inactive"}}},
        "preserved": preserved,
    }
    recover_kill = {
        "cli": {"rc": -9},
        "record_before": dict(pending_record),
        "record_after": dict(pending_record),
    }
    recover = {
        "cli": {"rc": 0},
        "record": dict(final_record),
        "record_before": dict(pending_record),
        "after": {"files": {SERVICE: {"type": "file", "sha256": python_sha}},
                  "units": {"crq-tick.timer": {"UnitFileState": "enabled",
                                               "ActiveState": "inactive"}}},
        "preserved": preserved,
    }
    repeat = {
        "cli": {"rc": 2, "stdout": "{\"refused\": \"invalid record\"}"},
        "record_before": dict(final_record),
        "record_after": dict(final_record),
    }
    rollback_pending = _record("rollback-transaction", pending,
                               raw_fields=rolled_back)
    rollback_completed = _record("rollback-transaction", rolled_back)
    rollback = {
        "cli": {"rc": -9},
        "switch": {"rc": -9},
        "record": dict(rollback_pending),
        "record_after_kill": dict(rollback_pending),
        "service": {"LoadState": "masked", "FragmentPath": SERVICE},
        "direct_start": {"rc": 1,
                         "stderr": "Unit crq-tick.service is masked."},
        "staged": {"type": "file", "runtime": PYTHON, "sha256": python_sha},
        "staged_after_completion": {"type": "missing"},
        "completions_before": 4, "completions_after_kill": 4,
        "recovery": {"rc": 0},
        "record_completed": dict(rollback_completed),
        "after": {"files": {SERVICE: {"type": "file", "sha256": python_sha}},
                  "units": {"crq-tick.timer": {"UnitFileState": "enabled",
                                               "ActiveState": "inactive"}}},
        "repeat": {"rc": 2, "stdout": "{\"refused\": \"invalid record\"}"},
        "record_after_repeat": dict(rollback_completed),
        "preserved": preserved,
    }
    fence_record = _record("fence", {
        "outcome": "pending", "phase": "activation_pending",
        "runtime": NODE, "prior_runtime": PYTHON})
    fence = {
        "cli": {"rc": -9},
        "record": dict(fence_record),
        "record_after_refusal": dict(fence_record),
        "recovery": {"rc": 3},
        "direct_start": {"rc": 1,
                         "stderr": "Unit crq-tick.service is masked."},
        "staged": {"runtime": NODE},
        "completions_before": 4, "completions_after": 4,
        "after": {
            "files": {SERVICE: {"type": "symlink", "target": "/dev/null"}},
            "units": {"crq-tick.service": {"LoadState": "masked"},
                      "crq-tick.timer": {"ActiveState": "inactive"}},
        },
        "preserved": preserved,
    }
    inspect = {"snapshot": {
        "files": {SERVICE: {"type": "file", "sha256": python_sha},
                  WANTS: {"type": "symlink"}},
        "state": STATE,
        "records": [node_phase["record"], python_phase["record"],
                    final_record, rollback_completed, fence_record],
    }}
    return {"prepare": prepare, "switch-node": node_phase,
            "switch-python": python_phase, "interrupt": interrupt,
            "recover-kill": recover_kill, "recover": recover,
            "recover-repeat": repeat, "rollback-fence": rollback,
            "inspect": inspect, "fence": fence}


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

    def test_missing_prepared_baseline_fails_closed(self):
        value = phases()
        value["prepare"]["prepared"].pop("state")
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["prepared_baseline_present"])
        self.assertTrue(problems)

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

    def test_rollback_fence_must_stage_the_prior_runtime(self):
        value = phases()
        value["rollback-fence"]["staged"]["runtime"] = NODE
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["rollback_fence_held"])
        self.assertTrue(problems)

    def test_rollback_fence_must_not_advance_before_release(self):
        value = phases()
        value["rollback-fence"]["record_after_kill"]["sha256"] = "3" * 64
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["rollback_fence_held"])
        self.assertTrue(problems)

    def test_rollback_fence_must_complete_and_clear_staged_service(self):
        value = phases()
        value["rollback-fence"]["staged_after_completion"] = {
            "type": "file", "runtime": PYTHON}
        checks, problems = harness.build_checks(value)
        self.assertFalse(checks["rollback_fence_recovery_completed"])
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
        self.feasibility = self.run_dir / "executed-host-vm-feasibility.py"
        self.guest = self.run_dir / "executed-guest-probe.py"
        self.raw = self.run_dir / "raw-guest-evidence.tar.gz"
        self.host.write_bytes(b"host")
        self.feasibility.write_bytes(b"feasibility")
        self.guest.write_bytes(b"guest")
        self.upload_data = {name: ("upload:" + name).encode()
                            for name in harness.UPLOADS}
        self.report = {
            "schema_version": harness.SCHEMA_VERSION,
            "kind": harness.KIND,
            "path": str(self.run_dir),
            "source_commit": SOURCE_COMMIT,
            "phases": phases(),
            "checks": {},
            "problems": [],
            "provenance": {
                "source_commit": SOURCE_COMMIT,
                "host_script": {"artifact": self.host.name,
                                "sha256": harness.sha256_bytes(b"host")},
                "host_modules": {
                    "vm-unit-switch.py": {
                        "artifact": self.host.name,
                        "sha256": harness.sha256_bytes(b"host")},
                    "vm-feasibility.py": {
                        "artifact": self.feasibility.name,
                        "sha256": harness.sha256_bytes(b"feasibility")},
                },
                "guest_script": {"artifact": self.guest.name,
                                 "sha256": harness.sha256_bytes(b"guest")},
                "guest_report": self.guest.name,
                "uploads": {
                    name: {"sha256": harness.sha256_bytes(data),
                           "remote_sha256": harness.sha256_bytes(data),
                           "bytes": len(data), "verified": True}
                    for name, data in self.upload_data.items()},
            },
            "raw": {"raw_tar": self.raw.name},
        }
        self._rebuild_raw()
        checks, problems = harness.build_checks(self.report["phases"])
        self.report["checks"] = checks
        self.report["problems"] = problems

    def _add(self, archive, name, data, mode=0o644):
        info = tarfile.TarInfo(name)
        info.size = len(data)
        info.mode = mode
        archive.addfile(info, io.BytesIO(data))

    def _rebuild_raw(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            for name in harness.GUEST_PHASES:
                data = (json.dumps(self.report["phases"][name], indent=2,
                                   sort_keys=True) + "\n").encode()
                self._add(archive, "fixture/phases/" + name + ".json", data)
            for name, data in RECORDS.items():
                filename = ("controller-"
                            + hashlib.md5(name.encode()).hexdigest() + ".json")
                self._add(archive, "records/" + filename, data, mode=0o600)
            for name, data in self.upload_data.items():
                self._add(archive, "proof-bin/" + name, data)
            mask = tarfile.TarInfo(
                ".config/systemd/user/crq-tick.service")
            mask.type = tarfile.SYMTYPE
            mask.linkname = "/dev/null"
            archive.addfile(mask)
            self._add(archive, ".config/systemd/user/.crq-tick.service.staged",
                      harness.expected_unit(NODE).encode())
        data = buffer.getvalue()
        self.raw.write_bytes(data)
        self.report["raw"]["tar_sha256"] = harness.sha256_bytes(data)
        self.report["raw"]["tar_bytes"] = len(data)

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

    def test_failed_checks_are_rejected_even_when_stored_problems_match(self):
        self.report["phases"]["switch-node"]["installed_runtime"] = PYTHON
        checks, problems = harness.build_checks(self.report["phases"])
        self.report["checks"] = checks
        self.report["problems"] = problems
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("switch-node_completed" in item
                            for item in payload["problems"]))

    def test_missing_raw_evidence_is_rejected(self):
        self.raw.unlink()
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("raw" in item for item in payload["problems"]))

    def test_phase_contradicting_raw_cli_is_rejected(self):
        self.report["phases"]["recover"]["cli"]["rc"] = 1
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("does not match retained raw guest evidence" in item
                            for item in payload["problems"]))

    def test_phase_contradicting_retained_journal_is_rejected(self):
        self.report["phases"]["recover"]["record"]["outcome"] = "completed"
        # Keep the phase JSON consistent with the tampered report so only the
        # raw controller journal can expose the contradiction.
        self._rebuild_raw()
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("contradicts retained evidence" in item
                            for item in payload["problems"]))

    def test_empty_upload_provenance_is_rejected(self):
        self.report["provenance"]["uploads"] = {}
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("upload provenance set" in item
                            or "raw upload is missing" in item
                            for item in payload["problems"]))

    def test_partial_upload_provenance_is_rejected(self):
        self.report["provenance"]["uploads"].pop(harness.UPLOADS[0])
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("upload provenance" in item
                            for item in payload["problems"]))

    def test_extra_upload_provenance_is_rejected(self):
        entry = dict(next(iter(self.report["provenance"]["uploads"].values())))
        self.report["provenance"]["uploads"]["extra.py"] = entry
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("upload provenance set" in item
                            for item in payload["problems"]))

    def test_empty_upload_digest_is_rejected(self):
        entry = self.report["provenance"]["uploads"][harness.UPLOADS[0]]
        entry["sha256"] = ""
        entry["remote_sha256"] = ""
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("upload digest is invalid" in item
                            for item in payload["problems"]))

    def test_unverified_upload_is_rejected(self):
        entry = self.report["provenance"]["uploads"][harness.UPLOADS[0]]
        entry["verified"] = False
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("upload is not verified" in item
                            for item in payload["problems"]))

    def test_remote_upload_digest_mismatch_is_rejected(self):
        entry = self.report["provenance"]["uploads"][harness.UPLOADS[0]]
        entry["remote_sha256"] = "d" * 64
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("local and remote digests differ" in item
                            for item in payload["problems"]))

    def test_upload_size_mismatch_is_rejected(self):
        entry = self.report["provenance"]["uploads"][harness.UPLOADS[0]]
        entry["bytes"] = 1
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("raw upload size does not match" in item
                            for item in payload["problems"]))

    def test_upload_size_must_be_nonnegative(self):
        entry = self.report["provenance"]["uploads"][harness.UPLOADS[0]]
        entry["bytes"] = -1
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("upload size is invalid" in item
                            for item in payload["problems"]))

    def test_missing_provenance_is_rejected(self):
        del self.report["provenance"]
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("provenance is not an object" in item
                            for item in payload["problems"]))

    def test_source_commit_mismatch_is_rejected(self):
        self.report["provenance"]["source_commit"] = "d" * 40
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("does not match the report" in item
                            for item in payload["problems"]))

    def test_report_path_mismatch_is_rejected(self):
        self.report["path"] = str(self.run_dir / "elsewhere")
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("does not name the report directory" in item
                            for item in payload["problems"]))

    def test_raw_size_mismatch_is_rejected(self):
        self.report["raw"]["tar_bytes"] += 1
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("raw guest evidence size does not match" in item
                            for item in payload["problems"]))

    def test_missing_host_module_provenance_is_rejected(self):
        del self.report["provenance"]["host_modules"]
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("host module provenance" in item
                            for item in payload["problems"]))

    def test_host_module_digest_mismatch_is_rejected(self):
        self.report["provenance"]["host_modules"]["vm-feasibility.py"][
            "sha256"] = "d" * 64
        status, payload = self._verify()
        self.assertEqual(status, 1)
        self.assertTrue(any("host module artifact digest does not match" in item
                            for item in payload["problems"]))


class SourceCommitTests(unittest.TestCase):
    def _run(self, status, match=None):
        calls = []

        def fake(argv, **kwargs):
            calls.append(list(argv))
            dirty = match is not None and any(match in arg for arg in argv)
            stdout = SOURCE_COMMIT if "rev-parse" in argv else (status if dirty else "")
            return subprocess.CompletedProcess(argv, 0, stdout, "")

        return calls, mock.patch.object(harness.subprocess, "run", side_effect=fake)

    def test_dirty_host_module_is_rejected(self):
        calls, patcher = self._run(" M apps/crq-python/ops/vm-feasibility.py\n",
                                   match="vm-feasibility.py")
        with patcher:
            with self.assertRaisesRegex(ValueError, "host proof modules"):
                harness.source_commit_check(pathlib.Path("/repo"), SOURCE_COMMIT)
        checked = {word for call in calls for word in call}
        self.assertIn(str(OPS / "vm-unit-switch.py"), checked)
        self.assertIn(str(OPS / "vm-feasibility.py"), checked)

    def test_clean_checkout_is_accepted(self):
        calls, patcher = self._run("")
        with patcher:
            self.assertEqual(
                harness.source_commit_check(pathlib.Path("/repo"), SOURCE_COMMIT),
                SOURCE_COMMIT)
        self.assertEqual(len(calls), 3)


if __name__ == "__main__":
    unittest.main()
