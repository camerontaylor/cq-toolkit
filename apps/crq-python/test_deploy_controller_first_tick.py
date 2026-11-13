"""Q7 deployment controller characterization: preflight, probe and first tick.

Split provenance: pure move out of ``test_deploy_controller.py`` (see
``test_deploy_controller_fixtures.py`` for the shared offline fixtures).

No live systemd, no network, no real deployment. The accepted helper is
exercised against temporary detached git clones exactly as
``test_host_config_*`` modules does; process liveness is faked; units are never
started; the controller never signals a process.
"""
import os
import subprocess
import sys
import unittest
from unittest import mock

from test_deploy_controller_fixtures import ControllerFixture, dc


class FirstTickWaitTest(unittest.TestCase):
    def run_wait(self, observations, timeout):
        now = [0]
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            now[0] += seconds

        with mock.patch.object(dc, 'health_observation', side_effect=observations) as observe:
            result = dc.wait_for_first_tick(object(), 'prior', timeout,
                                            sleep=sleep, clock=lambda: now[0])
        return result, sleeps, observe.call_count

    def test_waits_for_first_completed_tick(self):
        result, sleeps, calls = self.run_wait(
            [{'advanced': False}, {'advanced': False}, {'advanced': True}], 12)
        self.assertTrue(result['advanced'])
        self.assertEqual(sleeps, [5, 5])
        self.assertEqual(calls, 3)

    def test_timeout_returns_last_unhealthy_observation(self):
        result, sleeps, calls = self.run_wait([{'advanced': False}] * 3, 7)
        self.assertFalse(result['advanced'])
        self.assertEqual(sleeps, [5, 2])
        self.assertEqual(calls, 3)

    def test_zero_timeout_samples_once(self):
        result, sleeps, calls = self.run_wait([{'advanced': False}], 0)
        self.assertFalse(result['advanced'])
        self.assertEqual(sleeps, [])
        self.assertEqual(calls, 1)


class PreflightTests(ControllerFixture):
    def test_valid_target_and_tag_pass_and_capture_state(self):
        self.write_state("queue.json", {"items": [], "last_tick": "2026-10-28T00:00:00Z"})
        pre = dc.preflight(self.effects, self.target, self.tag)
        self.assertEqual(pre["target"], self.target)
        self.assertEqual(pre["state"]["prior_head"], self.before)
        self.assertIsNotNone(pre["state"]["prior_config_sha256"])
        self.assertEqual(pre["state"]["preserved/queue.json"],
                         dc._sha256(self.runner / "state/queue.json"))
        self.assertIsNone(pre["state"]["preserved/heartbeat.json"])

    def test_sha_tag_shape_and_annotated_binding_refused_before_any_mutation(self):
        before_status = self.command("status", "--porcelain", "--untracked-files=all")
        for target, tag in [("short", self.tag), ("A" * 40, self.tag),
                            (self.before, "20261028-1"),
                            (self.before, "crq-runner/not-a-date"),
                            (self.before, "refs/tags/" + self.tag)]:
            with self.subTest(target=target, tag=tag):
                with self.assertRaises(dc.Refused):
                    dc.preflight(self.effects, target, tag)
        # lightweight tag refused: annotation is the owner-approval artifact
        self.command("tag", "crq-runner/20261028-2", self.before)
        with self.assertRaisesRegex(dc.Refused, "annotated"):
            dc.preflight(self.effects, self.before, "crq-runner/20261028-2")
        # annotated tag naming a different commit refused
        self.command("tag", "-a", "crq-runner/20261028-3", self.target, "-m", "x")
        with self.assertRaisesRegex(dc.Refused, "peels to"):
            dc.preflight(self.effects, self.before, "crq-runner/20261028-3")
        self.assertEqual(self.command("status", "--porcelain", "--untracked-files=all"),
                         before_status)


class RunnerProbeTests(ControllerFixture):
    def write_probe(self, source):
        (self.runner / "crq.py").write_text(source)

    def test_checkout_runner_and_dependency_ignore_ambient_modules_and_pythonpath(self):
        (self.runner / "probe_dependency.py").write_text('STATE = "alive"\n')
        self.write_probe('import probe_dependency\n'
                         'def run_liveness(*args): return probe_dependency.STATE\n')
        poison = self.base / "ambient"
        poison.mkdir()
        (poison / "probe_dependency.py").write_text('STATE = "harvest"\n')
        with mock.patch.dict(sys.modules, {"crq": mock.Mock(),
                                          "probe_dependency": mock.Mock()}):
            with mock.patch.dict(os.environ, {"PYTHONPATH": str(poison)}):
                probe = dc._runner_liveness(self.effects)
                self.assertEqual(probe(self.runner / "state/runs/run", {}, {}, True), "alive")
        self.assertEqual(list(self.runner.rglob("__pycache__")), [])

    def test_missing_or_broken_checkout_import_and_probe_fail_closed(self):
        probe = dc._runner_liveness(self.effects)
        self.assertEqual(probe(self.runner / "state/runs/run", {}, {}, True), "ambiguous")
        for source in ('import missing_checkout_dependency_xyz\n',
                       'def run_liveness(*args): raise RuntimeError("probe failed")\n',
                       'def run_liveness(*args): return "unknown"\n',
                       'def run_liveness(*args): return "harvest"\nprint("noise")\n'):
            with self.subTest(source=source):
                self.write_probe(source)
                self.assertEqual(probe(self.runner / "state/runs/run", {}, {}, True), "ambiguous")

    def test_probe_timeout_and_spawn_failure_are_ambiguous(self):
        for error in (subprocess.TimeoutExpired("probe", 30), OSError("cannot spawn")):
            with self.subTest(error=type(error).__name__):
                with mock.patch.object(dc.subprocess, "run", side_effect=error):
                    self.assertEqual(dc._runner_liveness(self.effects)(
                        self.runner / "state/runs/run", {}, {}, True), "ambiguous")


class PreservationTests(ControllerFixture):
    def test_identical_bytes_pass(self):
        self.write_state("queue.json", {"items": []})
        before = {"preserved/queue.json": dc._sha256(self.runner / "state/queue.json"),
                  "preserved/heartbeat.json": None}
        self.assertEqual(dc.preservation_check(self.effects, before)["preserved"], True)

    def test_changed_or_vanished_surface_refuses_with_names(self):
        self.write_state("queue.json", {"items": []})
        before = {"preserved/queue.json": "0" * 64,
                  "preserved/heartbeat.json": "2" * 64}
        with self.assertRaisesRegex(dc.Refused, "queue.json, heartbeat.json"):
            dc.preservation_check(self.effects, before)

    def test_completion_heartbeat_is_hashed_where_the_runner_writes_it(self):
        # The preserved heartbeat is the completion heartbeat the runner
        # actually replaces (WATCHDOG_HOME/heartbeat.json, isolated here),
        # never a state-directory copy nothing writes.
        self.write_state("queue.json", {"items": []})
        path = self.effects.completion_heartbeat_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"last_tick": "2026-10-28T00:00:00Z"}\n')
        before = dc.captured_state(self.effects)
        self.assertEqual(before["preserved/heartbeat.json"], dc._sha256(path))
        # A state-directory heartbeat copy is not the runner surface.
        self.write_state("heartbeat.json", {"last_tick": "2026-01-01T00:00:00Z"})
        self.assertNotEqual(dc.captured_state(self.effects)["preserved/heartbeat.json"],
                            dc._sha256(self.runner / "state/heartbeat.json"))
        path.write_text('{"last_tick": "2026-10-28T00:05:00Z"}\n')
        with self.assertRaisesRegex(dc.Refused, "heartbeat.json"):
            dc.preservation_check(self.effects, before)
