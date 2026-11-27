"""Offline contract tests for ops/fleet-reader.py (doctrine I1). No SSH, no live calls."""
import contextlib
import importlib.util
import io
import json
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_host_config_fixtures import HostConfigFixture, host

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("fleet_reader_contract", ROOT / "ops/fleet-reader.py")
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
SETTINGS = dict(ssh_host="fixture", source="/fixture/summary.json")


def run(argv, stdout_text=None):
    out, err = io.StringIO(), io.StringIO()
    code = 0
    ssh = mock.Mock(returncode=0, stdout=stdout_text or "")
    with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(reader, "source_settings", return_value=SETTINGS), \
            mock.patch.object(reader.subprocess, "run", return_value=ssh) as run_, \
            mock.patch.object(reader.Path, "home", return_value=Path(tmp)), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            reader.main(argv)
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue(), err.getvalue(), run_


class FleetReaderContractTests(unittest.TestCase):
    def test_usage_error_emits_json_on_stdout_in_both_modes(self):
        for argv, machine in ((["--json"], True), ([], False)):
            with self.subTest(machine=machine):
                code, out, err, ssh = run(argv)
                self.assertEqual(code, 2)
                artifact = json.loads(out)["error"]
                self.assertEqual((artifact["kind"], artifact["exitCode"]), ("usage", 2))
                self.assertEqual(bool(err), not machine)
                ssh.assert_not_called()

    def test_operation_failure_emits_json_on_stdout_in_both_modes(self):
        for argv, machine in ((["--overlay", "o", "--json"], True), (["--overlay", "o"], False)):
            with self.subTest(machine=machine):
                code, out, err, _ = run(argv, "{not json")
                self.assertEqual(code, 1)
                artifact = json.loads(out)["error"]
                self.assertEqual((artifact["kind"], artifact["exitCode"]), ("failed", 1))
                self.assertEqual(bool(err), not machine)

    def test_non_string_last_tick_is_a_value_error_artifact(self):
        for tick in (123, [1], {"a": 1}, True):
            with self.subTest(last_tick=tick):
                body = json.dumps({"schema_version": 2, "last_tick": tick})
                code, out, err, _ = run(["--overlay", "o", "--json"], body)
                self.assertEqual((code, err), (1, ""))
                self.assertIn("valid completed tick", json.loads(out)["error"]["message"])

    def test_json_help_is_one_json_artifact(self):
        code, out, err, ssh = run(["--json", "--help"])
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(json.loads(out)["help"]["subcommand"], "fleet-reader")
        self.assertIn("--overlay", json.loads(out)["help"]["usage"])
        ssh.assert_not_called()

    def test_plain_help_stays_text(self):
        code, out, err, _ = run(["--help"])
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("usage:"))
        with self.assertRaises(ValueError):
            json.loads(out)


class InstalledLayoutTests(HostConfigFixture, unittest.TestCase):
    """The launchd job runs only the files copied to Application Support/crq."""

    def install(self, names):
        home = self.base / "home"
        installed = home / "Library/Application Support/crq"
        installed.mkdir(parents=True)
        for name in names:
            shutil.copy(ROOT / "ops" / name, installed / name)
        return home, installed

    def load_installed(self, installed):
        spec = importlib.util.spec_from_file_location("installed_reader", installed / "fleet-reader.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_plist_target_runs_from_the_two_copied_files_alone(self):
        home, installed = self.install(["fleet-reader.py", "prepare-host.py"])
        self.assertEqual(sorted(p.name for p in installed.iterdir()),
                         ["fleet-reader.py", "prepare-host.py"])
        output = self.base / "launchd"
        with mock.patch.object(Path, "home", return_value=home):
            host.render_plists(self.root, output, self.overlay_path)
        args = plistlib.loads((output / "com.crq.fleet-reader.plist").read_bytes())["ProgramArguments"]
        self.assertEqual(Path(args[1]), installed / "fleet-reader.py")
        self.assertTrue(Path(args[1]).is_file())
        self.assertEqual(args[2:], ["--overlay", str(self.overlay_path)])
        self.assertEqual(self.load_installed(installed).source_settings(args[3]),
                         self.overlay["fleet_reader"])
        done = subprocess.run([sys.executable, "-I", args[1], "--help"],
                              capture_output=True, text=True, cwd=installed)
        self.assertEqual((done.returncode, done.stdout[:6]), (0, "usage:"))

    def test_reader_copied_alone_cannot_load_its_settings(self):
        _, installed = self.install(["fleet-reader.py"])
        with self.assertRaises(FileNotFoundError):
            self.load_installed(installed).source_settings(self.overlay_path)


if __name__ == "__main__":
    unittest.main()
