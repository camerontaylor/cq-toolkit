"""Production controller CLI wiring for one per-unit switch.

The controller's ``switch --unit --runtime`` path loads the private overlay,
composes the real ``unit-live-binding.production_adapter`` with the existing
root/record/lock binding, and calls the real ``switch_unit`` seam. Tests use
the shared real-Git fixture; only the systemd and journal ports are replaced,
so no host manager is contacted. The production adapter is real, the
controller lock is real, and refusal happens before any unit or journal write.

The checkout ``switch --sha --tag`` path is a compatibility guard: it must keep
working without loading the live binding at all.
"""
import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

from test_deploy_controller_fixtures import OPS, dc, host
from test_unit_adapter import _node_artifact
from test_unit_switch_factory import BOOT, FactoryFixture, NODE_RUNTIME, UNIT


def _load(name, path):
    import importlib.util

    module = sys.modules.get(name)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


live = _load("crq_unit_switch_cli_wiring_live", OPS / "unit-live-binding.py")


class ControllerUnitSwitchWiringTests(FactoryFixture):
    def setUp(self):
        super().setUp()
        self.overlay_records = Path(self.overlay["record_dir"])
        self.overlay_records.mkdir(mode=0o700, exist_ok=True)
        self.overlay_records.chmod(0o700)
        self.effects = dc.Effects(self.root, self.overlay_records)
        self.lock = self.runner / "state" / dc.LOCK_NAME

    def make_loader(self, module=None):
        return mock.Mock(return_value=module or live)

    def run_cli(self, *, overlay_path=None, record_dir=None, args=None,
                systemd=None, loader=None, journal=None):
        stdout = io.StringIO()
        stderr = io.StringIO()
        argv = [
            "--root", str(self.root),
            "--overlay", str(overlay_path or self.overlay_path),
            "--record-dir", str(record_dir or self.overlay_records),
            *(args or ("switch", "--unit", UNIT, "--runtime", "python")),
        ]
        with mock.patch.object(dc, "_load_live_binding",
                               loader or self.make_loader()), \
                mock.patch.object(
                    live, "SubprocessSystemd",
                    side_effect=lambda **_options: systemd or self.fake), \
                mock.patch.object(
                    live.completion, "SystemdJournalSource",
                    side_effect=lambda **_options: journal or self.source), \
                contextlib.redirect_stdout(stdout), \
                contextlib.redirect_stderr(stderr):
            code = dc.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def write_lock(self, mode):
        self.lock.parent.mkdir(parents=True, exist_ok=True)
        if self.lock.exists() or self.lock.is_symlink():
            self.lock.unlink()
        self.lock.write_text("")
        self.lock.chmod(mode)
        return self.lock.stat()

    def records(self):
        return [json.loads(path.read_text())
                for path in self.overlay_records.glob("controller-*.json")]

    def pending_record(self, *, phase="drained", drain=False):
        """A retained pending record written from real adapter observations."""
        adapter, _selection = self.compose()
        snapshot = adapter.snapshot(UNIT)
        adapter.validate_snapshot(UNIT, snapshot)
        if drain:
            adapter.stop_and_drain(UNIT)
        record = {
            "schema_version": dc.JOURNAL_SCHEMA,
            "transaction_id": "b" * 32,
            "operation": "unit_switch",
            "unit": UNIT,
            "runtime": "python",
            "prior_runtime": NODE_RUNTIME,
            "outcome": "pending",
            "at": "2026-11-12T00:00:00Z",
            "snapshot": snapshot,
            "state": dc.captured_state(self.effects),
            "phase": phase,
        }
        return self.effects.journal_append(record), snapshot

    def test_cli_composes_the_live_adapter_and_refuses_foreign_discovery(self):
        self.fake.foreign = ["injected foreign activator"]
        before = (self.unit_dir / UNIT).read_bytes()
        code, stdout, stderr = self.run_cli()
        self.assertEqual(code, 2)
        self.assertIn("refused:", stderr)
        error = json.loads(stdout)["error"]
        self.assertEqual(error["kind"], "refused")
        self.assertEqual(error["subcommand"], "switch")
        self.assertIn("foreign", error["message"])
        self.assertEqual(list(self.overlay_records.iterdir()), [])
        self.assertTrue(self.lock.exists(), "controller lock must exist")
        self.assertEqual((self.unit_dir / UNIT).read_bytes(), before)

    def test_cli_refuses_a_root_not_named_by_the_private_overlay(self):
        overlay = json.loads(json.dumps(self.overlay))
        overlay["deploy_root"] = str(self.base / "other-deploy")
        other_overlay = self.base / "other-overlay.json"
        other_overlay.write_text(json.dumps(overlay))
        other_overlay.chmod(0o600)
        code, stdout, stderr = self.run_cli(overlay_path=other_overlay)
        self.assertEqual(code, 2)
        self.assertIn("deployment root refused", stderr)
        self.assertEqual(json.loads(stdout)["error"]["kind"], "refused")
        self.assertFalse(self.lock.exists())
        self.assertEqual(list(self.overlay_records.iterdir()), [])

    def test_cli_refuses_a_record_directory_not_named_by_the_overlay(self):
        other_records = self.base / "other-records"
        other_records.mkdir(mode=0o700)
        other_records.chmod(0o700)
        code, stdout, stderr = self.run_cli(record_dir=other_records)
        self.assertEqual(code, 2)
        self.assertIn("record directory is not the overlay record directory",
                      stderr)
        self.assertEqual(json.loads(stdout)["error"]["kind"], "refused")
        self.assertFalse(self.lock.exists())
        self.assertEqual(list(other_records.iterdir()), [])
        self.assertEqual(list(self.overlay_records.iterdir()), [])

    def test_cli_refuses_an_existing_lock_with_unsafe_permissions(self):
        self.write_lock(0o666)
        before = (self.unit_dir / UNIT).read_bytes()
        code, stdout, stderr = self.run_cli()
        self.assertEqual(code, 2)
        self.assertIn("controller lock must not be group or world writable",
                      stderr)
        self.assertEqual(json.loads(stdout)["error"]["kind"], "refused")
        self.assertEqual(self.records(), [])
        self.assertEqual((self.unit_dir / UNIT).read_bytes(), before)

    def test_cli_completes_a_real_prior_node_to_python_switch(self):
        observed = self.write_lock(0o600)
        code, stdout, stderr = self.run_cli(systemd=self.systemd)
        self.assertEqual(code, 0, stderr)
        self.assertEqual(stderr, "")
        artifact = json.loads(stdout)
        records = self.records()
        self.assertEqual(len(records), 1)
        self.assertEqual(artifact, records[0],
                         "stdout must be exactly the persisted record")
        self.assertEqual(artifact["schema_version"], 1)
        self.assertRegex(artifact["transaction_id"], r"^[0-9a-f]{32}$")
        self.assertIsInstance(artifact["at"], str)
        self.assertEqual(artifact["operation"], "unit_switch")
        self.assertEqual(artifact["outcome"], "completed")
        self.assertEqual(artifact["phase"], "activation_pending")
        self.assertEqual(artifact["unit"], UNIT)
        self.assertEqual(artifact["runtime"], "python")
        self.assertEqual(artifact["prior_runtime"], NODE_RUNTIME)
        self.assertIsInstance(artifact["state"], dict)
        self.assertEqual(artifact["snapshot"]["unit"], UNIT)
        self.assertEqual(artifact["snapshot"]["runtime"], NODE_RUNTIME)
        expected = self.python_service(UNIT)
        completions = artifact["completions"]
        self.assertEqual(len(completions), 2)
        self.assertLess(completions[0]["sequence"],
                        completions[1]["sequence"])
        self.assertGreater(completions[0]["sequence"], 900)
        for evidence in completions:
            self.assertEqual(evidence["unit"], UNIT)
            self.assertEqual(evidence["runtime"], "python")
            self.assertTrue(evidence["success"])
            self.assertEqual(evidence["service_sha256"], expected["sha256"])
            self.assertEqual(evidence["source_sha"], self.before)
            self.assertEqual(evidence["template_blob_oid"],
                             expected["template_blob_oid"])
            self.assertEqual(evidence["witness"], "manager")
            self.assertEqual(evidence["boot_id"], BOOT)
        self.assertEqual((self.unit_dir / UNIT).read_bytes(),
                         expected["bytes"])
        current = self.lock.stat()
        self.assertEqual((current.st_dev, current.st_ino),
                         (observed.st_dev, observed.st_ino),
                         "the controller must reuse its existing shared lock")
        self.assertEqual(current.st_mode & 0o777, 0o600)

    def test_cli_completes_a_real_python_to_node_watchdog_switch(self):
        unit = "crq-watchdog.service"
        sha = "c" * 40
        runtime = "node:" + sha
        artifact = _node_artifact(self.base, sha, capabilities=["watchdog"])
        self.systemd.active[unit] = "inactive"
        self.systemd.active["crq-watchdog.timer"] = "active"
        self.systemd.prior(unit, "c" * 32, 900)
        observed = self.write_lock(0o600)
        code, stdout, stderr = self.run_cli(
            systemd=self.systemd,
            args=("switch", "--unit", unit, "--runtime", runtime))
        self.assertEqual(code, 0, stderr)
        self.assertEqual(stderr, "")
        record = json.loads(stdout)
        self.assertEqual(record, self.records()[0],
                         "stdout must be exactly the persisted record")
        self.assertEqual(record["unit"], unit)
        self.assertEqual(record["runtime"], runtime)
        self.assertEqual(record["prior_runtime"], "python")
        self.assertEqual(record["outcome"], "completed")
        expected = host.render_service(
            self.root, unit, runtime, sha=self.before,
            artifact_root=str(artifact))
        self.assertEqual((self.unit_dir / unit).read_bytes(),
                         expected["bytes"])
        completions = record["completions"]
        self.assertEqual(len(completions), 2)
        self.assertLess(completions[0]["sequence"],
                        completions[1]["sequence"])
        for evidence in completions:
            self.assertEqual(evidence["unit"], unit)
            self.assertEqual(evidence["runtime"], runtime)
            self.assertTrue(evidence["success"])
            self.assertEqual(evidence["service_sha256"], expected["sha256"])
            self.assertEqual(evidence["source_sha"], self.before)
            self.assertEqual(evidence["template_blob_oid"],
                             expected["template_blob_oid"])
            self.assertEqual(evidence["artifact_source_sha"], sha)
            self.assertEqual(
                evidence["artifact_content_sha256"],
                expected["artifact"]["observed_content_sha256"])
            self.assertEqual(
                evidence["crq_js_sha256"],
                expected["artifact"]["crq_js_sha256"])
            self.assertEqual(evidence["witness"], "manager")
            self.assertEqual(evidence["boot_id"], BOOT)
        current = self.lock.stat()
        self.assertEqual((current.st_dev, current.st_ino),
                         (observed.st_dev, observed.st_ino),
                         "the controller must reuse its existing shared lock")
        self.assertEqual(current.st_mode & 0o777, 0o600)

    def test_checkout_switch_never_loads_the_live_binding(self):
        loader = mock.Mock(
            side_effect=AssertionError("checkout switch loaded the binding"))
        plan = {"preflight": {"target": self.before},
                "automatic_rollback_permitted": False, "steps": []}
        stdout = io.StringIO()
        with mock.patch.object(dc, "_load_live_binding", loader), \
                mock.patch.object(dc, "deploy_plan", return_value=plan), \
                contextlib.redirect_stdout(stdout):
            code = dc.main([
                "--root", str(self.root),
                "--overlay", str(self.overlay_path),
                "--record-dir", str(self.overlay_records),
                "switch", "--sha", self.before, "--tag", self.tag,
            ])
        self.assertEqual(code, 0)
        loader.assert_not_called()
        artifact = json.loads(stdout.getvalue())
        self.assertEqual(artifact["operation"], "switch")
        self.assertEqual(artifact["target"], self.before)
        self.assertEqual(list(self.overlay_records.iterdir()), [])

    def test_unit_switch_loads_the_live_binding_once(self):
        self.fake.foreign = ["injected foreign activator"]
        loader = self.make_loader()
        code, _stdout, _stderr = self.run_cli(loader=loader)
        self.assertEqual(code, 2)
        self.assertEqual(loader.call_count, 1)

    def test_cli_recover_completes_a_pending_record(self):
        path, _snapshot = self.pending_record(drain=True)
        transaction = json.loads(path.read_text())["transaction_id"]
        expected = self.node_service(UNIT)
        code, stdout, stderr = self.run_cli(
            args=("recover", "--record", str(path)), systemd=self.systemd)
        self.assertEqual(code, 0, stderr)
        self.assertEqual(stderr, "")
        artifact = json.loads(stdout)
        self.assertEqual(artifact, self.records()[0],
                         "stdout must be exactly the persisted record")
        self.assertEqual(artifact["transaction_id"], transaction)
        self.assertEqual(artifact["operation"], "unit_switch")
        self.assertEqual(artifact["outcome"], "rolled_back")
        self.assertEqual(artifact["phase"], "restore_activation_pending")
        self.assertEqual(artifact["unit"], UNIT)
        self.assertEqual(artifact["runtime"], "python")
        self.assertEqual(artifact["prior_runtime"], NODE_RUNTIME)
        service = self.unit_dir / UNIT
        self.assertEqual(service.read_bytes(), expected["bytes"])
        self.assertEqual(service.stat().st_mode & 0o7777, 0o600)
        self.assertEqual(self.systemd.active["crq-tick.timer"], "active")
        self.assertFalse(
            (self.unit_dir / ("." + UNIT + ".staged")).exists())

    def test_cli_recover_refuses_a_record_outside_the_record_dir(self):
        outside = self.base / "controller-outside.json"
        outside.write_text(json.dumps({"schema_version": dc.JOURNAL_SCHEMA}))
        loader = self.make_loader()
        code, stdout, stderr = self.run_cli(
            args=("recover", "--record", str(outside)), loader=loader)
        self.assertEqual(code, 2)
        self.assertIn("invalid controller transaction record path", stderr)
        artifact = json.loads(stdout)["error"]
        self.assertEqual(artifact["kind"], "refused")
        self.assertEqual(artifact["subcommand"], "recover")
        loader.assert_not_called()

    def test_cli_recover_rolls_back_a_demonstrably_fenced_activation(self):
        path, _snapshot = self.pending_record(phase="activation_pending",
                                              drain=True)
        code, stdout, stderr = self.run_cli(
            args=("recover", "--record", str(path)), systemd=self.systemd)
        self.assertEqual(code, 0, stderr)
        recorded = json.loads(stdout)
        self.assertEqual(recorded["outcome"], "rolled_back")
        self.assertEqual(recorded["failed_phase"], "activation_pending")
        final = json.loads(path.read_text())
        self.assertEqual(final["outcome"], "rolled_back")
        self.assertEqual(final["phase"], "restore_activation_pending")

    def test_cli_recover_loads_the_live_binding_once(self):
        path, _snapshot = self.pending_record(drain=True)
        loader = self.make_loader()
        code, _stdout, stderr = self.run_cli(
            args=("recover", "--record", str(path)), loader=loader,
            systemd=self.systemd)
        self.assertEqual(code, 0, stderr)
        self.assertEqual(loader.call_count, 1)

    def test_health_never_loads_the_live_binding(self):
        loader = mock.Mock(
            side_effect=AssertionError("health loaded the binding"))
        stdout = io.StringIO()
        with mock.patch.object(dc, "_load_live_binding", loader), \
                mock.patch.object(dc, "two_slot_health",
                                  return_value={"healthy": True}), \
                contextlib.redirect_stdout(stdout):
            code = dc.main([
                "--root", str(self.root),
                "--overlay", str(self.overlay_path),
                "--record-dir", str(self.overlay_records),
                "health", "--interval-seconds", "0",
            ])
        self.assertEqual(code, 0)
        loader.assert_not_called()
        self.assertEqual(json.loads(stdout.getvalue())["operation"], "health")

    def test_live_binding_loader_caches_the_default_binding(self):
        first = dc._load_live_binding()
        second = dc._load_live_binding()
        self.assertIs(first, second)
        self.assertIs(sys.modules.get("crq_unit_live_binding_cli"), first)

    def test_live_binding_loader_reports_a_missing_file_as_refused(self):
        with self.assertRaises(dc.Refused):
            dc._load_live_binding(self.base / "missing-live-binding.py")

    def test_live_binding_loader_does_not_reuse_a_module_for_another_path(self):
        dc._load_live_binding()
        with self.assertRaises(dc.Refused):
            dc._load_live_binding(self.base / "another-missing-live.py")

    def test_live_binding_loader_reports_a_directory_as_refused(self):
        with self.assertRaises(dc.Refused):
            dc._load_live_binding(self.base)

    def test_live_binding_loader_reports_an_import_error_as_refused(self):
        broken = self.base / "broken-live-binding.py"
        broken.write_text("import definitely_missing_crq_binding_dependency\n")
        with self.assertRaises(dc.Refused):
            dc._load_live_binding(broken)

    def test_live_binding_loader_reports_a_syntax_error_as_refused(self):
        broken = self.base / "syntax-live-binding.py"
        broken.write_text("def broken(:\n")
        with self.assertRaises(dc.Refused):
            dc._load_live_binding(broken)


if __name__ == "__main__":
    unittest.main()
