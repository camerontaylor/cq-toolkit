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

from test_deploy_controller_fixtures import OPS, dc
from test_unit_switch_factory import FactoryFixture, NODE_RUNTIME, UNIT


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
        code, _stdout, stderr = self.run_cli(systemd=self.systemd)
        self.assertEqual(code, 0, stderr)
        records = self.records()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["operation"], "unit_switch")
        self.assertEqual(records[0]["outcome"], "completed")
        self.assertEqual(records[0]["unit"], UNIT)
        self.assertEqual(records[0]["runtime"], "python")
        self.assertEqual(records[0]["prior_runtime"], NODE_RUNTIME)
        self.assertEqual(len(records[0]["completions"]), 2)
        self.assertEqual((self.unit_dir / UNIT).read_bytes(),
                         self.python_service(UNIT)["bytes"])
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
