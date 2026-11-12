"""Q7 deployment controller characterization: end-to-end CLI invocations.

Split provenance: pure move out of ``test_deploy_controller.py`` (see
``test_deploy_controller_fixtures.py`` for the shared offline fixtures).

No live systemd, no network, no real deployment. The accepted helper is
exercised against temporary detached git clones exactly as
``test_host_config_*`` modules does; process liveness is faked; units are never
started; the controller never signals a process.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

from test_deploy_controller_fixtures import OPS, ROOT, ControllerFixture, dc, host

# Generous bound: far above any first-tick wait plus interval the CLI tests use.
CLI_TIMEOUT_SECONDS = 120


class CliTests(ControllerFixture):
    """End-to-end CLI invocations with faked systemctl; JSON on stdout."""

    def run_cli(self, *args, env=None):
        merged = dict(os.environ)
        merged.pop("PYTHONPATH", None)
        if env:
            merged.update(env)
        # The copied helper is imported from the fixture checkout. Prevent
        # that import from creating untracked bytecode beside reviewed source;
        # the production "only rendered config modified" fence stays strict.
        return subprocess.run(
            ["python3", "-B", str(OPS / "deploy-controller.py"),
             "--root", str(self.root), "--overlay", str(self.overlay_path),
             "--record-dir", str(self.record_dir), *args],
            capture_output=True, text=True, env=merged,
            timeout=CLI_TIMEOUT_SECONDS)

    def test_switch_cli_succeeds_with_fake_systemctl_and_emits_json(self):
        self.switch_cli_fixture()

    def test_switch_cli_drains_real_runner_without_pythonpath(self):
        self.switch_cli_fixture(recorded_run=True)

    def test_switch_cli_with_matching_pinned_helper_digest_succeeds(self):
        self.switch_cli_fixture(pin_helper=True)

    def test_switch_cli_creates_a_0600_lock_under_a_permissive_umask(self):
        # The guest proof's umask is 002: a lock opened 0666 becomes 0664 and
        # the live binding refuses group-writable locks.
        previous = os.umask(0o002)
        try:
            self.switch_cli_fixture()
        finally:
            os.umask(previous)
        lock = self.runner / "state" / dc.LOCK_NAME
        self.assertEqual(lock.stat().st_mode & 0o777, 0o600)

    def test_helper_digest_mismatch_refuses_before_import_lock_or_preflight(self):
        self.write_state("queue.json", {"items": [], "starts": []})
        lock = self.runner / "state" / dc.LOCK_NAME
        for expected in ("0" * 64, "ABC", "0" * 63):
            with self.subTest(expected=expected):
                # A bad --sha would refuse in preflight; the identity check
                # must refuse first, with the helper never imported.
                result = self.run_cli("--expect-helper-sha256", expected,
                                      "switch", "--sha", "nothex", "--tag", self.tag)
                self.assertEqual(result.returncode, 2)
                self.assertIn("refused:", result.stderr)
                self.assertIn("helper", result.stderr)
                self.assertNotIn("--sha", result.stderr)
                error = json.loads(result.stdout)["error"]
                self.assertEqual(error["kind"], "refused")
                self.assertEqual(error["subcommand"], "switch")
                self.assertEqual(error["exitCode"], 2)
                self.assertFalse(lock.exists())
                self.assertEqual(list(self.record_dir.iterdir()), [])
                self.assertEqual(self.command("rev-parse", "HEAD").strip(), self.before)


    def switch_cli_fixture(self, recorded_run=False, pin_helper=False):
        self.write_state("queue.json", {"items": [], "starts": []})
        if recorded_run:
            # Real probe and dependencies, tracked before the helper clean guard.
            # Copy the checkout's production modules, including dependencies
            # added by a composed target, rather than freezing an old import list.
            for source in sorted(ROOT.glob("*.py")):
                if not source.name.startswith("test_"):
                    shutil.copy(source, self.runner / source.name)
            shutil.copytree(ROOT / "crq_repair", self.runner / "crq_repair",
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            child = subprocess.Popen([sys.executable, "-I", "-B", "-c", "pass"],
                                     start_new_session=True)
            self.assertEqual(child.wait(timeout=10), 0)
            run_id = "pr611-20261028T012345Z"
            (self.runner / "state/runs" / run_id).mkdir(parents=True)
            self.write_state("runs/" + run_id + "/exit.json", {"exit": 0})
            self.write_state("runs/" + run_id + "/review.pid", {
                "pid": child.pid, "pgid": child.pid, "sid": child.pid,
                "run_id": run_id, "group_owner": "foreground-v1"})
            self.write_state("queue.json", {"items": [
                {"id": "pr611", "run": {"run_id": run_id, "pid": child.pid}}],
                "starts": []})

        # The subprocess cannot inherit this module's POLICY_FLOOR mock, so the
        # fixture copy of the helper pins the fixture baseline directly. The
        # pin commit must contain UNRENDERED committed config, so the helper's
        # post-switch "only rendered config modified" contract still holds.
        self.command("restore", "--", host.CONFIG)
        helper = self.runner / "ops/prepare-host.py"
        original = helper.read_text()
        pin = "POLICY_FLOOR = 'f748fd43e75505f4e89098a4ffe28fa2a179a50c'"
        self.assertEqual(original.count(pin), 1,
                         "prepare-host.py POLICY_FLOOR literal changed; update fixture pin")
        helper.write_text(original.replace(pin, "POLICY_FLOOR = '" + self.before + "'"))
        # The edited helper bytes must not look like checkout drift: commit the
        # pinned copy into the fixture clone (same content, new commit).
        self.command("add", "apps/crq-python")
        self.command("commit", "-qam", "fixture floor pin")
        pinned = self.command("rev-parse", "HEAD").strip()
        self.command("update-ref", "refs/remotes/origin/main", pinned)
        self.command("tag", "-a", "crq-runner/20261028-2", pinned, "-m", "cli fixture")
        # Render AFTER the pin commit: the rendered config must differ from the
        # committed one for the helper's post-switch status contract to hold.
        self.rendered()
        # No systemd on the test host either: fake systemctl for the subprocess
        # through a PATH shim that reports every CRQ unit inactive.
        shim = self.base / "bin"
        shim.mkdir(exist_ok=True)
        (shim / "systemctl").write_text(
            '#!/bin/sh\n'
            'if [ "$1" = "--user" ] && { [ "$2" = "list-unit-files" ] || [ "$2" = "list-units" ]; }; then\n'
            '  exit 0\n'
            'fi\n'
            'echo inactive\n'
            'exit 0\n')
        (shim / "systemctl").chmod(0o755)
        # Do not let host-global excludes hide generated fixture files.
        self.command("config", "core.excludesFile", os.devnull)
        expected_status = [" M " + host.CONFIG]
        before_cli = self.command("status", "--porcelain", "--untracked-files=all").splitlines()
        self.assertEqual(before_cli, expected_status, before_cli[:10])
        helper_digest = hashlib.sha256(helper.read_bytes()).hexdigest()
        pin = ["--expect-helper-sha256", helper_digest] if pin_helper else []
        result = self.run_cli(*pin, "switch", "--sha", pinned, "--tag", "crq-runner/20261028-2",
                              env={"PATH": str(shim) + ":" + os.environ["PATH"],
                                   # Exercise -B even when inherited env does
                                   # not suppress bytecode (as in CI discovery).
                                   "PYTHONDONTWRITEBYTECODE": ""})
        after_cli = self.command("status", "--porcelain", "--untracked-files=all").splitlines()
        self.assertEqual(result.returncode, 0,
                         result.stderr[-1000:] + "\nfixture status: " + repr(after_cli[:10]))
        self.assertEqual(after_cli, expected_status, after_cli[:10])
        artifact = json.loads(result.stdout)
        self.assertEqual(artifact["operation"], "switch")
        self.assertEqual(artifact["target"], pinned)
        self.assertTrue(artifact["automatic_rollback_permitted"])
        self.assertEqual(artifact["helper_sha256"], helper_digest)
        journals = [json.loads(p.read_text())
                    for p in self.record_dir.glob("controller-*.json")]
        self.assertEqual([j["helper_sha256"] for j in journals], [helper_digest])

    def test_health_cli_missing_heartbeat_refuses_with_isolated_env(self):
        # The CLI subprocess resolves WATCHDOG_HOME from its own environment:
        # an isolated XDG_STATE_HOME means the actual user heartbeat is never
        # consulted, and no queue tick can substitute for it.
        self.write_state("queue.json", {"last_tick": "2026-10-28T00:00:00Z"})
        result = self.run_cli("health", "--interval-seconds", "0",
                              env={"XDG_STATE_HOME": str(self.base / "cli-xdg")})
        self.assertEqual(result.returncode, 2)
        self.assertIn("refused:", result.stderr)
        self.assertIn("completion heartbeat", result.stderr)
        error = json.loads(result.stdout)["error"]
        self.assertEqual(error["kind"], "refused")
        self.assertEqual(error["subcommand"], "health")
        self.assertEqual(error["exitCode"], 2)

    def test_health_cli_stale_heartbeat_is_unhealthy_with_unchanged_shape(self):
        xdg = self.base / "cli-xdg"
        (xdg / "crq").mkdir(parents=True)
        payload = {"last_tick": "2026-10-28T00:00:00Z", "stale_alarm_min": 36,
                   "schedule_id": None, "root": str(self.runner),
                   "alert_agent_id": None, "alert_agent_host": None}
        (xdg / "crq/heartbeat.json").write_text(json.dumps(payload) + "\n")
        # An advancing queue save must not mask the stale completion slot.
        self.write_state("queue.json", {"last_tick": "2026-10-28T00:20:00Z"})
        result = self.run_cli("health", "--interval-seconds", "0",
                              "--first-tick-timeout-seconds", "0",
                              env={"XDG_STATE_HOME": str(xdg)})
        self.assertEqual(result.returncode, 1)
        artifact = json.loads(result.stdout)
        self.assertEqual(artifact["operation"], "health")
        self.assertFalse(artifact["healthy"])
        self.assertIn("first observation", artifact["reason"])
        first = artifact["observations"][0]
        self.assertEqual(first["observed_tick"], "2026-10-28T00:00:00Z")
        self.assertFalse(first["advanced"])
        self.assertIn("receipts", first)

    def test_refusal_exits_2_with_json_error_artifact_and_stderr_reason(self):
        result = self.run_cli("switch", "--sha", "nothex", "--tag", self.tag)
        self.assertEqual(result.returncode, 2)
        self.assertIn("refused:", result.stderr)
        error = json.loads(result.stdout)["error"]
        self.assertEqual(error["kind"], "refused")
        self.assertEqual(error["subcommand"], "switch")
        self.assertEqual(error["message"], result.stderr.split("refused: ", 1)[1].strip())
        self.assertEqual(error["exitCode"], 2)

    def test_pre_helper_failure_exits_2_with_refused_artifact(self):
        # A malformed prior record fails before helper entry: the helper made no
        # change, so this is a refusal (exit 2), never a health failure (exit 1).
        record = self.base / "prior.json"
        record.write_text("{not json")
        result = self.run_cli("rollback", "--prior-record", str(record))
        self.assertEqual(result.returncode, 2)
        self.assertIn("refused:", result.stderr)
        error = json.loads(result.stdout)["error"]
        self.assertEqual(error["kind"], "refused")
        self.assertEqual(error["subcommand"], "rollback")
        self.assertEqual(error["exitCode"], 2)

    def test_health_requires_interval_seconds(self):
        # The default 0 could never observe a second advancing tick; the caller
        # must choose the later-observation delay instead.
        result = self.run_cli("health",
                              env={"XDG_STATE_HOME": str(self.base / "cli-xdg")})
        self.assertEqual(result.returncode, 2)
        self.assertIn("--interval-seconds", result.stderr)


class RecordDirResolutionTests(unittest.TestCase):
    """--record-dir spelling must survive into record_preflight() unchanged."""

    def test_dotdot_after_a_symlinked_ancestor_keeps_its_filesystem_meaning(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = pathlib.Path(tmp) / "real"
            nested = real / "nested"
            records = real / "records"
            nested.mkdir(parents=True)
            records.mkdir()
            link = pathlib.Path(tmp) / "link"
            link.symlink_to(nested, target_is_directory=True)
            # The kernel opens link -> real/nested, then '..' -> real, then
            # records: real/records. A lexical abspath would name tmp/records.
            spelled = link / ".." / "records"
            self.assertEqual(dc.absolute_record_dir(spelled), records)
            self.assertNotEqual(pathlib.Path(os.path.abspath(spelled)), records)

    def test_a_final_symlink_is_still_visible_to_preflight(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "records"
            target.mkdir()
            target.chmod(0o700)
            link = pathlib.Path(tmp) / "link"
            link.symlink_to(target, target_is_directory=True)
            resolved = dc.absolute_record_dir(link)
            self.assertTrue(resolved.is_symlink())
            effects = dc.Effects(pathlib.Path(tmp) / "root", resolved)
            with self.assertRaises(dc.Refused):
                effects.record_preflight()


if __name__ == "__main__":
    unittest.main()
