"""Host-free characterization of the deploy driver (``ops/deploy-runbook.py``).

The driver replaced the digest-pinned runbook ceremony on 2026-11-14. These
tests pin the safety that remains: a merged main SHA is the target, admission
is held and drained, the switch is the audited helper fence, queue bytes and
the measured cq_bin pointer are verified, exactly the triggers observed active
are restarted, and a failure after the switch rolls back automatically unless
the queue no longer grants it.

No live systemd, no network, no real deployment. The helper and controller are
the real modules against a temporary git clone; systemd and liveness are
faked; the queue lives in the fixture checkout.
"""
import contextlib
import importlib.util
import io
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
rb = _load("crq_deploy_runbook", OPS / "deploy-runbook.py")

TRIGGERS = ["crq-repair.path", "crq-tick.timer", "crq-watchdog.timer"]
SERVICES = ["crq-repair.service", "crq-tick.service"]


class FakeUnits:
    """In-memory unit provider: states, stops and starts only."""

    def __init__(self, states=None):
        self.states = dict(states or {})
        for unit in TRIGGERS:
            self.states.setdefault(unit, "active")
        for unit in SERVICES:
            self.states.setdefault(unit, "inactive")
        self.stopped = []
        self.started = []

    def inventory(self):
        return list(TRIGGERS), list(SERVICES)

    def state(self, unit):
        return self.states.get(unit, "inactive")

    def stop(self, units):
        self.stopped.extend(units)
        for unit in units:
            self.states[unit] = "inactive"

    def start(self, units):
        self.started.extend(units)
        for unit in units:
            self.states[unit] = "active"


class DeployFixture(unittest.TestCase):
    """A temporary deployment clone with the real helper and controller."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crq-deploy-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "deploy"
        self.runner = self.root / "apps/crq-python"
        self.runner.mkdir(parents=True)
        shutil.copy(ROOT / "config.json", self.runner / "config.json")
        shutil.copytree(OPS / "systemd", self.runner / "ops/systemd")
        shutil.copy(OPS / "prepare-host.py", self.runner / "ops/prepare-host.py")
        shutil.copy(OPS / "deploy-controller.py",
                    self.runner / "ops/deploy-controller.py")
        (self.root / ".gitignore").write_text("apps/crq-python/state/\n")
        self.command("init", "-q")
        self.command("config", "user.email", "fixture@example.invalid")
        self.command("config", "user.name", "Fixture")
        self.command("add", ".")
        self.command("commit", "-qm", "baseline")
        self.prior = self.command("rev-parse", "HEAD").strip()
        config = json.loads((self.runner / "config.json").read_text())
        config["quiet_minutes"] = 31
        (self.runner / "config.json").write_bytes(host.encode(config))
        self.command("commit", "-qam", "next policy")
        self.target = self.command("rev-parse", "HEAD").strip()
        self.command("update-ref", "refs/remotes/origin/main", self.target)
        self.command("checkout", "-q", "--detach", self.prior)
        self.runtime = self.base / "runtime"
        (self.runtime / "dist").mkdir(parents=True)
        (self.runtime / "dist/cli.js").write_text("console.log('cq');\n")
        records = self.base / "records"
        records.mkdir(mode=0o700)
        self.overlay = {
            "schema_version": 1, "deploy_root": str(self.root),
            "record_dir": str(records),
            "fleet_reader": {"ssh_host": "queue.example.invalid",
                             "source": "/srv/state/crq/summary.json"},
            "config": {
                "clone": str(self.base / "runtime"),
                "worktree_root": str(self.base / "worktrees"),
                "timeout_bin": "/usr/bin/timeout",
                "paseo_hosts": ["worker.example.invalid:6767",
                                "127.0.0.1:6767"],
                "alerts": {
                    "alert_agent_host": "worker.example.invalid:6767"},
                "repair": {"enabled": False,
                           "cq_bin": str(self.runtime / "dist/cli.js"),
                           "paseo_host": "127.0.0.1:6767"},
            },
        }
        self.raw = host.encode(self.overlay)
        self.overlay_path = self.base / "host.json"
        self.overlay_path.write_bytes(self.raw)
        self.overlay_path.chmod(0o600)
        self.record_dir = self.base / "runrecords"
        self.record_dir.mkdir(mode=0o700)
        state = self.runner / "state"
        state.mkdir()
        self.queue_bytes = b'{"items": [], "starts": []}\n'
        (state / "queue.json").write_bytes(self.queue_bytes)
        # The live checkout carries the rendered config, pointer included.
        host.live_render(self.root, self.overlay, self.raw)
        self.original_config = (self.runner / "config.json").read_bytes()
        self.pointer = json.loads(self.original_config)["repair"]["cq_bin"]
        self.units = FakeUnits()
        # One trigger is already inactive: it must never be started.
        self.units.states["crq-repair.path"] = "inactive"
        self.original = {unit: self.units.states[unit]
                         for unit in TRIGGERS}
        self.now = [0.0]

        def clock():
            return self.now[0]

        def sleep(seconds):
            self.now[0] += seconds

        self.clock = clock
        self.sleep = sleep
        self.floor = mock.patch.object(host, "POLICY_FLOOR", self.prior)
        self.floor.start()
        self.addCleanup(self.floor.stop)
        self.stopped_units = mock.patch.object(host, "run",
                                               side_effect=self.stopped)
        self.stopped_units.start()
        self.addCleanup(self.stopped_units.stop)
        isolated = mock.patch.dict(
            os.environ,
            {"XDG_STATE_HOME": str(self.base / "xdg-state"),
             "XDG_CONFIG_HOME": str(self.base / "xdg-config")})
        isolated.start()
        self.addCleanup(isolated.stop)

    def command(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args],
                              check=True, capture_output=True,
                              text=True).stdout

    def stopped(self, argv):
        if argv[0] == "systemctl":
            if argv[2] in {"list-unit-files", "list-units"}:
                return ""
            return "inactive\n"
        return subprocess.run(argv, check=True, capture_output=True,
                              text=True).stdout

    # -- seams ---------------------------------------------------------
    def args(self, **overrides):
        argv = ["deploy",
                "--root", str(self.root),
                "--overlay", str(self.overlay_path),
                "--record-dir", str(self.record_dir),
                "--target-sha", self.target,
                "--no-fetch",
                "--service-drain-deadline-s", "5",
                "--drain-interval-s", "5",
                "--drain-deadline-s", "10",
                "--health-timeout-s", "5",
                "--health-interval-s", "5"]
        namespace = rb.build_parser().parse_args(argv)
        for key, value in overrides.items():
            setattr(namespace, key, value)
        return namespace

    def build(self, helper=None, health=None, drain=None, **overrides):
        return rb.Run(
            self.args(**overrides),
            units=self.units,
            helper=helper or host,
            controller=dc,
            health=health or (lambda: {"healthy": True,
                                       "observations": ["fixture"]}),
            drain=drain or (lambda: {"drained": True, "blocked": []}),
            clock=self.clock,
            sleep=self.sleep)

    def marker(self):
        return self.runner / "state" / "runner-disabled"

    def head(self):
        return self.command("rev-parse", "HEAD").strip()

    def record(self, run):
        return json.loads((Path(run.run_dir) / "deploy.json").read_text())


class DeployTests(DeployFixture, unittest.TestCase):
    def test_deploy_switches_health_checks_and_restarts_only_active(self):
        run = self.build()
        document = run.run()
        self.assertEqual(document["outcome"], "completed")
        self.assertTrue(document["released"])
        self.assertEqual(self.head(), self.target)
        self.assertFalse(self.marker().exists())
        self.assertEqual(self.units.started,
                         ["crq-tick.timer", "crq-watchdog.timer"])
        self.assertEqual(self.units.state("crq-repair.path"), "inactive")
        self.assertEqual(self.units.state("crq-tick.timer"), "active")
        self.assertEqual((self.runner / "state/queue.json").read_bytes(),
                         self.queue_bytes)
        live = json.loads((self.runner / "config.json").read_text())
        self.assertEqual(live["quiet_minutes"], 31)
        self.assertEqual(live["repair"]["cq_bin"], self.pointer)
        record = self.record(run)
        self.assertEqual(record["outcome"], "completed")
        self.assertTrue(record["released"])
        self.assertEqual(record["target"], self.target)
        self.assertEqual(record["prior_sha"], self.prior)
        self.assertIsNone(record["tag"])
        self.assertEqual(record["cq_bin"]["pointer"], self.pointer)
        self.assertIsNotNone(record["cq_bin"]["sha256"])
        self.assertTrue((Path(run.run_dir) / "drain.json").is_file())
        self.assertTrue((Path(run.run_dir) / "health.json").is_file())
        self.assertTrue((Path(run.run_dir) / "candidate-ops/prepare-host.py")
                        .is_file())
        # The deployment lock is released when the run ends, success included.
        probe = rb.DeployLock(self.root)
        probe.acquire()
        probe.release()

    def test_unmerged_target_refuses_before_any_mutation(self):
        self.command("commit", "--allow-empty", "-qm", "unmerged")
        unmerged = self.head()
        run = self.build(target_sha=unmerged)
        with self.assertRaisesRegex(rb.Refused, "not merged to origin/main"):
            run.run()
        self.assertEqual(self.units.stopped, [])
        self.assertFalse(self.marker().exists())
        self.assertEqual(self.head(), unmerged)

    def test_foreign_marker_refuses_and_touches_no_unit(self):
        self.marker().write_text("someone else's hold\n")
        run = self.build()
        with self.assertRaisesRegex(rb.Refused, "already held"):
            run.run()
        self.assertEqual(self.marker().read_text(), "someone else's hold\n")
        self.assertEqual(self.units.stopped, [])
        self.assertEqual(self.head(), self.prior)

    def test_drain_timeout_fail_stops_with_hold_retained(self):
        run = self.build(drain=lambda: {"drained": False,
                                        "blocked": [{"item": "q1",
                                                     "state": "alive"}]})
        with self.assertRaises(rb.RecoveryRequired) as caught:
            run.run()
        self.assertIn("drain expired", str(caught.exception))
        self.assertTrue(self.marker().exists())
        self.assertEqual(self.units.started, [])
        self.assertTrue(all(self.units.state(unit) in ("inactive", "failed")
                            for unit in TRIGGERS))
        self.assertEqual(self.head(), self.prior)
        record = self.record(run)
        self.assertEqual(record["outcome"], "recovery_required")
        self.assertEqual(record["original_triggers"], self.original)

    def test_incompatible_queue_refuses_before_hold(self):
        state = self.runner / "state/queue.json"
        state.write_text('{"schema_version": 2, "items": []}\n')
        run = self.build()
        with self.assertRaisesRegex(rb.Refused, "disables automatic rollback"):
            run.run()
        self.assertFalse(self.marker().exists())
        self.assertEqual(self.units.stopped, [])
        self.assertEqual(self.head(), self.prior)

    def test_changed_unit_templates_refuse_before_units_stop(self):
        # Nothing in the deploy flow installs unit files or reloads the user
        # manager, and rollback cannot restore prior definitions, so a target
        # that changes a crq-* template must be refused before any unit is
        # stopped, with the host untouched.
        timer = self.runner / "ops/systemd/crq-tick.timer"
        timer.write_text(timer.read_text() + "# template drift\n")
        self.command("commit", "-qm", "unit template change", "--",
                     "apps/crq-python/ops/systemd/crq-tick.timer")
        target = self.head()
        self.command("update-ref", "refs/remotes/origin/main", target)
        # Point origin/main at the template-changing commit but leave the
        # checkout on the prior SHA: if HEAD were also the target, the earlier
        # "already the checked-out HEAD" refusal would fire and the template
        # gate this test exists to exercise would never be reached.
        self.command("checkout", "-q", "--detach", self.prior)
        run = self.build(target_sha=target)
        with self.assertRaisesRegex(rb.Refused, "unit templates"):
            run.run()
        self.assertEqual(self.units.stopped, [])
        self.assertFalse(self.marker().exists())
        self.assertEqual(self.head(), self.prior)

    def test_relative_and_symlinked_roots_are_resolved_before_effects(self):
        # The controller compares the literal effects.root against the
        # resolved root crq.py writes into the heartbeat, so an unresolved
        # --root would pass root_check and then fail health after the switch.
        link = self.base / "checkout-link"
        link.symlink_to(self.root)
        self.assertEqual(self.build(root=link).root, self.root.resolve())
        previous = os.getcwd()
        os.chdir(self.base)
        try:
            self.assertEqual(self.build(root=Path("deploy")).root,
                             self.root.resolve())
        finally:
            os.chdir(previous)

    def test_restore_before_switch_revalidates_the_runtime_entry(self):
        # The checkout never moved, but the measured runtime entry was
        # replaced while the host drained. The config and queue checks still
        # pass; restarting the triggers would resume admission on unverified
        # bytes, so the restore must fail-stop with the hold retained.
        fixture = self

        class BrokenSwitch:
            def load_overlay(self, path):
                return host.load_overlay(path)

            def root_check(self, root, overlay):
                return host.root_check(root, overlay)

            def switch(self, *args, **kwargs):
                (fixture.runtime / "dist/cli.js").write_text("// replaced\n")
                raise ValueError("helper refused the switch")

        run = self.build(helper=BrokenSwitch())
        with self.assertRaises(rb.RecoveryRequired) as caught:
            run.run()
        self.assertIn("pre-switch restore failed", str(caught.exception))
        self.assertIn("not the measured entry", str(caught.exception))
        self.assertTrue(self.marker().exists())
        self.assertEqual(self.head(), self.prior)
        self.assertEqual(self.units.started, [])
        self.assertTrue(all(self.units.state(unit) in ("inactive", "failed")
                            for unit in TRIGGERS))
        self.assertEqual(self.record(run)["outcome"], "recovery_required")

    def test_rollback_drain_losing_permission_fail_stops_before_switch(self):
        # The queue was compatible before the rollback and its drain, but the
        # rollback drain itself leaves a schema marker. The pre-drain
        # permission is stale: the rollback must not switch, and the hold is
        # retained for the owner.
        calls = {"n": 0}

        def dirtying_rollback_drain():
            calls["n"] += 1
            if calls["n"] >= 2:
                (self.runner / "state/queue.json").write_text(
                    '{"schema_version": 3, "items": []}\n')
            return {"drained": True, "blocked": []}

        run = self.build(health=lambda: {"healthy": False,
                                         "reason": "no advancing tick"},
                         drain=dirtying_rollback_drain)
        with self.assertRaisesRegex(rb.RecoveryRequired,
                                    "after the rollback drain"):
            run.run()
        self.assertTrue(self.marker().exists())
        self.assertEqual(self.head(), self.target)
        self.assertTrue(all(self.units.state(unit) in ("inactive", "failed")
                            for unit in TRIGGERS))
        self.assertEqual(self.record(run)["outcome"], "recovery_required")

    def test_fail_stop_surfaces_a_storage_failure_as_recovery_required(self):
        # The recovery record cannot be written (disk full). The outcome must
        # still be recovery_required, carrying the in-memory receipt and the
        # persistence error, with the hold retained -- never an ordinary
        # refusal that claims the host was left unchanged.
        real_write = rb.durable_write

        def failing_write(path, payload):
            if Path(path).name == "deploy.json":
                raise OSError("disk full")
            return real_write(path, payload)

        run = self.build(drain=lambda: {"drained": False,
                                        "blocked": [{"item": "q1",
                                                     "state": "alive"}]})
        with mock.patch.object(rb, "durable_write", side_effect=failing_write):
            with self.assertRaises(rb.RecoveryRequired) as caught:
                run.run()
        self.assertIn("persistence_error", caught.exception.record)
        self.assertIn("disk full",
                      caught.exception.record["persistence_error"])
        self.assertEqual(caught.exception.record["outcome"],
                         "recovery_required")
        self.assertTrue(self.marker().exists())
        self.assertEqual(self.head(), self.prior)
        self.assertFalse((Path(run.run_dir) / "deploy.json").exists())

    def test_queue_that_loses_rollback_permission_during_drain_refuses(self):
        # Preflight measured a compatible queue; a tick wrote a schema marker
        # before the drain settled. Re-measuring after the drain must refuse
        # before the checkout moves, because a later health failure would have
        # no permitted rollback.
        def dirtying_drain():
            (self.runner / "state/queue.json").write_text(
                '{"schema_version": 3, "items": []}\n')
            return {"drained": True, "blocked": []}

        run = self.build(drain=dirtying_drain)
        with self.assertRaisesRegex(rb.Refused,
                                    "no longer grants automatic rollback"):
            run.run()
        self.assertEqual(self.head(), self.prior)
        self.assertFalse(self.marker().exists())
        self.assertEqual(self.units.started,
                         ["crq-tick.timer", "crq-watchdog.timer"])
        self.assertEqual(self.record(run)["outcome"], "refused")

    def test_overlapping_deploy_refuses_on_the_deployment_lock(self):
        blocker = rb.DeployLock(self.root)
        blocker.acquire()
        self.addCleanup(blocker.release)
        run = self.build()
        with self.assertRaisesRegex(rb.Refused, "another deploy holds"):
            run.run()
        self.assertFalse(self.marker().exists())
        self.assertEqual(self.head(), self.prior)
        self.assertEqual(self.units.stopped, [])

    def test_historical_target_helper_that_requires_a_tag_refuses_early(self):
        class OldHelper:
            def load_overlay(self, path):
                return host.load_overlay(path)

            def root_check(self, root, overlay):
                return host.root_check(root, overlay)

            def verify_target(self, root, target, tag):
                return None

        run = self.build(helper=OldHelper())
        with self.assertRaisesRegex(rb.Refused,
                                    "still requires an annotated tag"):
            run.run()
        self.assertFalse(self.marker().exists())
        self.assertEqual(self.head(), self.prior)
        self.assertEqual(self.units.stopped, [])

    def test_health_failure_rolls_back_to_prior_and_pointer(self):
        run = self.build(health=lambda: {"healthy": False,
                                         "reason": "no advancing tick"})
        document = run.run()
        self.assertEqual(document["outcome"], "rolled_back")
        self.assertEqual(self.head(), self.prior)
        self.assertEqual((self.runner / "config.json").read_bytes(),
                         self.original_config)
        self.assertEqual((self.runner / "state/queue.json").read_bytes(),
                         self.queue_bytes)
        self.assertFalse(self.marker().exists())
        self.assertEqual({unit: self.units.state(unit)
                          for unit in TRIGGERS}, self.original)
        self.assertEqual(self.units.state("crq-repair.path"), "inactive")
        record = self.record(run)
        self.assertEqual(record["outcome"], "rolled_back")
        self.assertTrue(record["released"])
        self.assertIn("no advancing tick", record["reason"])
        self.assertEqual(record["rollback"]["to"], self.prior)
        self.assertEqual(record["rollback"]["cq_bin"]["pointer"], self.pointer)

    def test_health_failure_after_a_completed_tick_rolls_back(self):
        # A first health tick legitimately advances the queue and heartbeat.
        # The rollback must preserve those post-tick bytes, not the pre-deploy
        # ones, or a healthy tick looks like queue corruption.
        tick_queue = (b'{"items": [], "starts": [], '
                      b'"last_tick": "2026-11-14T00:00:00Z"}\n')

        def completed_tick_then_fail():
            (self.runner / "state/queue.json").write_bytes(tick_queue)
            heartbeat = (Path(os.environ["XDG_STATE_HOME"])
                         / "crq/heartbeat.json")
            heartbeat.parent.mkdir(parents=True, exist_ok=True)
            heartbeat.write_text('{"at": "2026-11-14T00:00:00Z"}\n')
            return {"healthy": False, "reason": "second observation missing"}

        run = self.build(health=completed_tick_then_fail)
        document = run.run()
        self.assertEqual(document["outcome"], "rolled_back")
        self.assertEqual(self.head(), self.prior)
        self.assertFalse(self.marker().exists())
        self.assertEqual((self.runner / "config.json").read_bytes(),
                         self.original_config)
        self.assertEqual((self.runner / "state/queue.json").read_bytes(),
                         tick_queue)
        self.assertEqual({unit: self.units.state(unit)
                          for unit in TRIGGERS}, self.original)
        self.assertTrue((Path(run.run_dir) / "rollback-drain.json").is_file())
        self.assertEqual(self.record(run)["outcome"], "rolled_back")

    def test_rollback_disabled_after_release_holds_and_stops(self):
        # The health window runs with admission released. If the queue loses
        # rollback permission there and health fails, recovery must reacquire
        # the hold and stop the failed target before refusing to roll back.
        def tick_marks_incompatible_then_fails():
            (self.runner / "state/queue.json").write_text(
                '{"schema_version": 3, "items": []}\n')
            return {"healthy": False, "reason": "no advancing tick"}

        run = self.build(health=tick_marks_incompatible_then_fails)
        with self.assertRaisesRegex(rb.RecoveryRequired,
                                    "automatic rollback is disabled"):
            run.run()
        self.assertTrue(self.marker().exists())
        self.assertEqual(self.head(), self.target)
        self.assertTrue(all(self.units.state(unit) in ("inactive", "failed")
                            for unit in TRIGGERS))
        self.assertEqual(self.record(run)["outcome"], "recovery_required")

    def test_moved_cq_bin_pointer_is_refused_before_restart(self):
        # The pointer is measured from the live config and the target render
        # cannot move it (the overlay names it), so this is the belt-and-braces
        # assertion against a stray writer. Exercise the check directly: a
        # switch that bypassed it would restart triggers against a runtime
        # nothing measured.
        decoy = self.base / "decoy.js"
        decoy.write_text("console.log('other');\n")
        run = self.build()
        run.cq_bin = rb.measure_cq_bin(self.original_config)
        config = json.loads((self.runner / "config.json").read_text())
        config["repair"]["cq_bin"] = str(decoy)
        (self.runner / "config.json").write_bytes(host.encode(config))
        with self.assertRaisesRegex(rb.Refused, "moved repair.cq_bin"):
            run.runtime_pointer_check()

    def test_unmeasured_cq_bin_entry_is_refused(self):
        run = self.build()
        run.cq_bin = rb.measure_cq_bin(self.original_config)
        (self.runtime / "dist/cli.js").write_text("// replaced after measure\n")
        with self.assertRaisesRegex(rb.Refused, "not the measured entry"):
            run.runtime_pointer_check()

    def test_queue_byte_change_during_switch_fail_stops(self):
        real_switch = host.switch
        calls = {"n": 0}

        def mutating_switch(root, overlay, raw, target, tag=None):
            result = real_switch(root, overlay, raw, target, tag)
            calls["n"] += 1
            if calls["n"] == 1:
                (self.runner / "state/queue.json").write_text(
                    '{"items": [{"id": "rewritten"}]}\n')
            return result

        helper = mock.Mock(wraps=None)
        helper.load_overlay = host.load_overlay
        helper.root_check = host.root_check
        helper.verify_target = host.verify_target
        helper.switch = mutating_switch
        run = self.build(helper=helper)
        with self.assertRaises(rb.RecoveryRequired):
            run.run()
        self.assertTrue(self.marker().exists())
        self.assertTrue(all(self.units.state(unit) in ("inactive", "failed")
                            for unit in TRIGGERS))
        self.assertEqual(self.record(run)["outcome"], "recovery_required")

    def test_rollback_refuses_restart_when_runtime_entry_is_not_restored(self):
        real_switch = host.switch
        calls = {"n": 0}

        def replacing_switch(root, overlay, raw, target, tag=None):
            result = real_switch(root, overlay, raw, target, tag)
            calls["n"] += 1
            if calls["n"] == 1:
                (self.runtime / "dist/cli.js").write_text("// replaced\n")
            return result

        helper = mock.Mock(wraps=None)
        helper.load_overlay = host.load_overlay
        helper.root_check = host.root_check
        helper.verify_target = host.verify_target
        helper.switch = replacing_switch
        run = self.build(helper=helper)
        with self.assertRaisesRegex(rb.RecoveryRequired,
                                    "automatic rollback failed"):
            run.run()
        self.assertTrue(self.marker().exists())
        self.assertEqual(self.head(), self.prior)
        self.assertTrue(all(self.units.state(unit) in ("inactive", "failed")
                            for unit in TRIGGERS))
        self.assertEqual(self.record(run)["outcome"], "recovery_required")

    def test_keyboard_interrupt_after_release_rolls_back_and_unlocks(self):
        def interrupted():
            raise KeyboardInterrupt

        run = self.build(health=interrupted)
        with self.assertRaises(KeyboardInterrupt):
            run.run()
        self.assertEqual(self.head(), self.prior)
        self.assertFalse(self.marker().exists())
        self.assertEqual({unit: self.units.state(unit)
                          for unit in TRIGGERS}, self.original)
        self.assertEqual(self.record(run)["outcome"], "rolled_back")
        probe = rb.DeployLock(self.root)
        probe.acquire()
        probe.release()

    def test_switch_failure_before_head_moves_restores_and_releases(self):
        class BrokenSwitch:
            def load_overlay(self, path):
                return host.load_overlay(path)

            def root_check(self, root, overlay):
                return host.root_check(root, overlay)

            def switch(self, *args, **kwargs):
                raise ValueError("helper refused the switch")

        run = self.build(helper=BrokenSwitch())
        with self.assertRaisesRegex(rb.Refused, "helper refused"):
            run.run()
        self.assertEqual(self.head(), self.prior)
        self.assertFalse(self.marker().exists())
        self.assertEqual({unit: self.units.state(unit)
                          for unit in TRIGGERS}, self.original)
        self.assertEqual(self.record(run)["outcome"], "refused")

    def test_health_failure_keeps_hold_when_rollback_is_disabled(self):
        real_switch = host.switch

        def dirtying_switch(root, overlay, raw, target, tag=None):
            result = real_switch(root, overlay, raw, target, tag)
            (self.runner / "state/queue.json").write_text(
                '{"schema_version": 3, "items": []}\n')
            return result

        helper = mock.Mock(wraps=None)
        helper.load_overlay = host.load_overlay
        helper.root_check = host.root_check
        helper.verify_target = host.verify_target
        helper.switch = dirtying_switch
        run = self.build(helper=helper, health=lambda: {
            "healthy": False, "reason": "no advancing tick"})
        with self.assertRaisesRegex(rb.RecoveryRequired,
                                    "automatic rollback is disabled"):
            run.run()
        self.assertTrue(self.marker().exists())
        self.assertEqual(self.head(), self.target)
        self.assertEqual(self.record(run)["outcome"], "recovery_required")

    def test_status_reports_a_completed_record_then_drift(self):
        run = self.build()
        run.run()
        status_args = rb.build_parser().parse_args(
            ["status", "--run-dir", str(run.run_dir),
             "--root", str(self.root)])
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(rb.cmd_status(status_args, units=self.units), 0)
        document = json.loads(output.getvalue())
        self.assertTrue(document["ok"])
        self.assertEqual(document["outcome"], "completed")
        self.units.states["crq-tick.timer"] = "inactive"
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(rb.cmd_status(status_args, units=self.units), 1)
        self.assertIn("differs from the record", json.loads(
            output.getvalue())["refusal"])

    def test_status_refuses_a_marker_present_again(self):
        run = self.build()
        run.run()
        self.marker().write_text("manual hold\n")
        status_args = rb.build_parser().parse_args(
            ["status", "--run-dir", str(run.run_dir),
             "--root", str(self.root)])
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(rb.cmd_status(status_args, units=self.units), 1)
        self.assertIn("marker is present", json.loads(
            output.getvalue())["refusal"])

    def test_main_reports_an_interrupt_as_one_json_document(self):
        class Interrupted:
            def __init__(self, args):
                self.args = args

            def run(self):
                raise KeyboardInterrupt

        with contextlib.redirect_stdout(io.StringIO()) as output:
            code = rb.main(
                ["deploy", "--root", str(self.root),
                 "--overlay", str(self.overlay_path),
                 "--record-dir", str(self.record_dir)],
                run_factory=Interrupted)
        self.assertEqual(code, 130)
        document = json.loads(output.getvalue())
        self.assertEqual(document["error"]["kind"], "interrupted")

    def test_argument_errors_are_one_json_document(self):
        with contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit) as caught:
                rb.main(["deploy"])
        self.assertEqual(caught.exception.code, 2)
        document = json.loads(output.getvalue())
        self.assertEqual(document["error"]["kind"], "usage")
        self.assertEqual(document["error"]["subcommand"], "deploy")
        self.assertEqual(document["error"]["exitCode"], 2)
        self.assertIn("--root", document["error"]["message"])
        # Without --json the usage narration still goes to stderr.
        self.assertIn("usage:", errors.getvalue())
        with contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as caught:
                rb.main(["status", "--run-dir", "/tmp/x"])
        self.assertEqual(caught.exception.code, 2)
        document = json.loads(output.getvalue())
        self.assertEqual(document["error"]["kind"], "usage")
        self.assertEqual(document["error"]["subcommand"], "status")
        self.assertEqual(document["error"]["exitCode"], 2)

    def test_machine_mode_usage_errors_keep_stderr_empty(self):
        with contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit) as caught:
                rb.main(["--json", "deploy"])
        self.assertEqual(caught.exception.code, 2)
        self.assertEqual(errors.getvalue(), "")
        document = json.loads(output.getvalue())
        self.assertEqual(document["error"]["kind"], "usage")
        self.assertEqual(document["error"]["subcommand"], "deploy")
        self.assertEqual(document["error"]["exitCode"], 2)
        self.assertIn("--root", document["error"]["message"])

    def test_machine_mode_deploy_writes_no_stderr(self):
        with contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            code = rb.main([
                "--json",
                "deploy", "--root", str(self.root),
                "--overlay", str(self.overlay_path),
                "--record-dir", str(self.record_dir),
                "--target-sha", self.target, "--no-fetch",
                "--service-drain-deadline-s", "5",
                "--drain-interval-s", "5", "--drain-deadline-s", "10",
                "--health-timeout-s", "5", "--health-interval-s", "5"],
                run_factory=lambda args: rb.Run(
                    args, units=self.units, helper=host, controller=dc,
                    health=lambda: {"healthy": True, "observations": ["m"]},
                    drain=lambda: {"drained": True, "blocked": []},
                    clock=self.clock, sleep=self.sleep))
        self.assertEqual(code, 0)
        self.assertEqual(errors.getvalue(), "")
        self.assertEqual(json.loads(output.getvalue())["outcome"],
                         "completed")
        self.assertEqual(self.head(), self.target)

    def test_main_maps_rolled_back_to_exit_one(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            code = rb.main([
                "deploy", "--root", str(self.root),
                "--overlay", str(self.overlay_path),
                "--record-dir", str(self.record_dir),
                "--target-sha", self.target, "--no-fetch",
                "--service-drain-deadline-s", "5",
                "--drain-interval-s", "5", "--drain-deadline-s", "10",
                "--health-timeout-s", "5", "--health-interval-s", "5"],
                run_factory=lambda args: rb.Run(
                    args, units=self.units, helper=host, controller=dc,
                    health=lambda: {"healthy": False, "reason": "tick"},
                    drain=lambda: {"drained": True, "blocked": []},
                    clock=self.clock, sleep=self.sleep))
        self.assertEqual(code, 1)
        document = json.loads(output.getvalue())
        self.assertEqual(document["outcome"], "rolled_back", document)
        self.assertEqual(self.head(), self.prior)
        self.assertFalse(self.marker().exists())


if __name__ == "__main__":
    unittest.main()
