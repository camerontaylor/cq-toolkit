"""Q7 deployment controller characterization: shared offline fixtures only.

Split provenance: ``test_deploy_controller.py`` was split by subject into
``test_deploy_controller_cli.py``, ``test_deploy_controller_decisions.py``,
``test_deploy_controller_deploy_plan.py``,
``test_deploy_controller_deploy_plan_recovery.py``,
``test_deploy_controller_drain.py``, ``test_deploy_controller_first_tick.py``,
``test_deploy_controller_health.py`` and
``test_deploy_controller_rollback_plan.py``. Test bodies are unchanged; this
module carries the fixtures they share and defines no tests.

No live systemd, no network, no real deployment. The accepted helper is
exercised against temporary detached git clones exactly as
``test_host_config_*`` modules does; process liveness is faked; units are never
started; the controller never signals a process.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
OPS = ROOT / "ops"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dc = _load("crq_deploy_controller", OPS / "deploy-controller.py")
host = _load("crq_prepare_host", OPS / "prepare-host.py")

# Sentinel distinguishing "no root argument" from an explicit None root.
_MISSING_ROOT = object()


class ControllerFixture(unittest.TestCase):
    """A temporary deployment clone with a real helper, fake systemctl."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crq-q7-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "deploy"
        self.runner = self.root / "apps/crq-python"
        self.runner.mkdir(parents=True)
        shutil.copy(ROOT / "config.json", self.runner / "config.json")
        shutil.copytree(OPS / "systemd", self.runner / "ops/systemd")
        shutil.copy(OPS / "prepare-host.py", self.runner / "ops/prepare-host.py")
        shutil.copy(OPS / "deploy-controller.py", self.runner / "ops/deploy-controller.py")
        (self.root / ".gitignore").write_text("apps/crq-python/state/\n")
        self.command("init", "-q")
        self.command("config", "user.email", "fixture@example.invalid")
        self.command("config", "user.name", "Fixture")
        self.command("add", ".")
        self.command("commit", "-qm", "baseline")
        self.before = self.command("rev-parse", "HEAD").strip()
        config = json.loads((self.runner / "config.json").read_text())
        config["quiet_minutes"] = 31
        (self.runner / "config.json").write_bytes(host.encode(config))
        self.command("commit", "-qam", "next policy")
        self.target = self.command("rev-parse", "HEAD").strip()
        self.command("update-ref", "refs/remotes/origin/main", self.target)
        self.tag = "crq-runner/20261028-1"
        self.command("tag", "-a", self.tag, "-m", "owner fixture approval")
        self.command("checkout", "-q", "--detach", self.before)
        self.overlay = {
            "schema_version": 1, "deploy_root": str(self.root),
            "record_dir": str(self.base / "records"),
            "fleet_reader": {"ssh_host": "queue.example.invalid",
                             "source": "/srv/state/crq/summary.json"},
            "config": {
                "clone": str(self.base / "runtime"),
                "worktree_root": str(self.base / "worktrees"),
                "timeout_bin": "/usr/bin/timeout",
                "paseo_hosts": ["worker.example.invalid:6767", "127.0.0.1:6767"],
                "alerts": {"alert_agent_host": "worker.example.invalid:6767"},
                "repair": {"enabled": False,
                           "cq_bin": str(self.base / "runtime/dist/cli.js"),
                           "paseo_host": "127.0.0.1:6767"},
            },
        }
        self.raw = host.encode(self.overlay)
        self.overlay_path = self.base / "host.json"
        self.overlay_path.write_bytes(self.raw)
        self.overlay_path.chmod(0o600)
        self.record_dir = self.base / "controller-records"
        self.record_dir.mkdir(mode=0o700)
        self.floor = mock.patch.object(host, "POLICY_FLOOR", self.before)
        self.floor.start()
        self.addCleanup(self.floor.stop)
        stopped_units = mock.patch.object(host, "run", side_effect=self.stopped)
        stopped_units.start()
        self.addCleanup(stopped_units.stop)
        self.effects = dc.Effects(self.root, self.record_dir)
        # Installed-unit observation reads an isolated user config, never the
        # real one; the CLI subprocess inherits the same environment.
        self.units_home = self.base / "xdg-config/systemd/user"
        self.units_home.mkdir(parents=True)
        (self.units_home / "crq-tick.timer").write_text("[Timer]\n")
        (self.units_home / "timers.target.wants").mkdir()
        (self.units_home / "timers.target.wants/crq-tick.timer").symlink_to(
            self.units_home / "crq-tick.timer")
        isolated = mock.patch.dict(os.environ,
                                   {"XDG_CONFIG_HOME": str(self.base / "xdg-config")})
        isolated.start()
        self.addCleanup(isolated.stop)

    def command(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True,
                              capture_output=True, text=True).stdout

    def stopped(self, argv):
        """Fake systemctl: every CRQ unit reports inactive; git really runs."""
        if argv[0] == "systemctl":
            if argv[2] in {"list-unit-files", "list-units"}:
                return ""
            return "inactive\n"
        return subprocess.run(argv, check=True, capture_output=True, text=True).stdout

    def write_state(self, rel, payload):
        state = self.runner / "state"
        state.mkdir(exist_ok=True)
        (state / rel).write_text(json.dumps(payload) + "\n")

    def rendered(self):
        data = host.render(self.root, self.overlay)
        (self.runner / "config.json").write_bytes(data)
        return data


class DeployPlanFixture(ControllerFixture):
    """Deploy-plan helpers shared by the two ``DeployPlanTests`` modules."""

    def setUp(self):
        super().setUp()
        self.write_state("queue.json", {"items": [
            {"id": "pr1", "kind": "merged", "state": "done"}], "starts": []})
        self.rendered()

    def fake_switch(self):
        """The helper's switch, with systemctl faked inactive (no live units)."""
        def run(argv):
            if argv[0] == "systemctl":
                return self.stopped(argv)
            return subprocess.run(argv, check=True, capture_output=True, text=True).stdout
        return mock.patch.object(host, "run", side_effect=run)

    def assert_recovery(self, failure, phase):
        recovery = failure.recovery
        self.assertEqual(recovery["outcome"], "recovery_required")
        self.assertEqual(recovery["failed_phase"], phase)
        self.assertEqual(recovery["prior_head"], self.before)
        self.assertEqual(recovery["target"], self.target)
        self.assertFalse(recovery["automatic_rollback_permitted"])
        self.assertEqual(recovery["rollback_compatibility"], {})
        self.assertIn("preserved/queue.json", recovery["prior_state"])
        self.assertIsNotNone(recovery["prior_config_sha256"])
        record = json.loads(Path(recovery["record_path"]).read_text())
        with self.assertRaises(dc.Refused):
            dc.rollback_target(record)
        return recovery, record

    def records(self):
        return [json.loads(p.read_text()) for p in self.record_dir.glob("controller-*.json")]
