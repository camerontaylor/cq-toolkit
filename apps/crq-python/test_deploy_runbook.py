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
        # Repo-local config isolates the fixture from the developer's git
        # configuration before the first commit: an inherited
        # commit.gpgSign=true without a key fails setup, and an inherited
        # core.hooksPath would run developer hooks on fixture commits and
        # helper checkouts. Being repo-local, the same settings also govern
        # every git call the real helper and controller make against this
        # clone.
        self.empty_hooks = self.base / "empty-hooks"
        self.empty_hooks.mkdir()
        self.command("config", "commit.gpgSign", "false")
        self.command("config", "core.hooksPath", str(self.empty_hooks))
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
            if argv[2] in {"list-unit-files", "list-units", "list-jobs"}:
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
    def test_compatibility_is_judged_against_the_prior_sha_throughout(self):
        # Pre-hold and post-drain checks, and the post-switch check, must ask
        # about the PRIOR (live) sha, never the deploy target.
        shas = []
        real = dc.compatibility_record

        def spy(effects, sha):
            shas.append(sha)
            return real(effects, sha)

        with mock.patch.object(dc, "compatibility_record", side_effect=spy):
            document = self.build().run()
        self.assertEqual(document["outcome"], "completed")
        self.assertGreaterEqual(len(shas), 3)
        self.assertEqual(set(shas), {self.prior})
        self.assertNotEqual(self.prior, self.target)

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

    def test_unfinished_record_in_record_dir_refuses_before_switch(self):
        (self.record_dir / "controller-unfinished.json").write_text("{}\n")
        run = self.build()
        with self.assertRaisesRegex(rb.Refused, "unfinished controller"):
            run.run()
        self.assertEqual(self.head(), self.prior)

    def test_unfinished_record_in_overlay_record_dir_refuses_before_switch(self):
        (Path(self.overlay["record_dir"])
         / "controller-unfinished.json").write_text("{}\n")
        run = self.build()
        with self.assertRaisesRegex(rb.Refused, "unfinished controller"):
            run.run()
        self.assertEqual(self.head(), self.prior)

    def test_head_moved_before_controller_lock_refuses(self):
        real_lock = dc.Effects.controller_lock
        fixture = self

        def moving_lock(effects):
            fixture.command("commit", "--allow-empty", "-qm", "controller moved")
            return real_lock(effects)

        run = self.build()
        with mock.patch.object(dc.Effects, "controller_lock", moving_lock):
            with self.assertRaisesRegex(rb.Refused, "live HEAD changed"):
                run.run()
        self.assertEqual(self.units.stopped, [])

    def test_unremovable_unprovable_marker_is_recovery_required(self):
        hold = rb.Hold(self.root)
        full = OSError(28, "No space left on device")
        with mock.patch.object(rb.os, "fsync", side_effect=full), \
                mock.patch.object(rb.Path, "unlink",
                                  side_effect=OSError(13, "permission")):
            with self.assertRaises(rb.RecoveryRequired):
                hold.acquire()
        self.assertTrue(hold.path.exists())

    def test_unmerged_target_refuses_before_any_mutation(self):
        self.command("commit", "--allow-empty", "-qm", "unmerged")
        unmerged = self.head()
        run = self.build(target_sha=unmerged)
        with self.assertRaisesRegex(rb.Refused, "not merged to origin/main"):
            run.run()
        self.assertEqual(self.units.stopped, [])
        self.assertFalse(self.marker().exists())
        self.assertEqual(self.head(), unmerged)

    def local_only_prior(self):
        self.command("commit", "--allow-empty", "-qm", "local only")
        local = self.head()
        self.assertNotEqual(
            subprocess.run(["git", "-C", str(self.root), "merge-base",
                            "--is-ancestor", local,
                            "refs/remotes/origin/main"]).returncode, 0)
        return local

    def test_older_target_helper_refuses_before_admission(self):
        local = self.local_only_prior()
        live = (self.runner / "config.json").read_bytes()
        with mock.patch.object(host, "switch", lambda root, overlay, raw, target, tag=None: None):
            run = self.build(target_sha=self.target)
            with self.assertRaisesRegex(rb.Refused, "rollback_config support"):
                run.run()
        self.assertEqual(self.head(), local)
        self.assertEqual((self.runner / "config.json").read_bytes(), live)
        self.assertEqual(self.units.stopped, [])
        self.assertFalse(self.marker().exists())

    def test_local_only_prior_is_not_refused_and_deploys(self):
        # The live prior SHA may be a local merge that is not on origin/main
        # (a ceres deploy of main from a local wip merge). Only the target is
        # verified as a deploy target; a prior that fails the target rule must
        # not refuse admission.
        local = self.local_only_prior()
        run = self.build(target_sha=self.target)
        document = run.run()
        self.assertEqual(document["outcome"], "completed")
        self.assertEqual(self.head(), self.target)

    def test_local_only_prior_still_rolls_back_by_recorded_sha(self):
        local = self.local_only_prior()
        live = (self.runner / "config.json").read_bytes()
        run = self.build(target_sha=self.target,
                         health=lambda: {"healthy": False,
                                         "reason": "no advancing tick"})
        document = run.run()
        self.assertEqual(document["outcome"], "rolled_back")
        self.assertEqual(self.head(), local)
        self.assertEqual((self.runner / "config.json").read_bytes(), live)

    def test_clone_on_a_branch_is_not_refused(self):
        # The 2026-11-21 operator found the clone on `main` refused; the
        # switch checks the target out detached, so a branch is deployable.
        self.command("checkout", "-q", "-B", "main", self.prior)
        self.assertEqual(
            self.command("rev-parse", "--abbrev-ref", "HEAD").strip(), "main")
        run = self.build(target_sha=self.target)
        document = run.run()
        self.assertEqual(document["outcome"], "completed")
        self.assertEqual(self.head(), self.target)
        self.assertEqual(
            self.command("rev-parse", "--abbrev-ref", "HEAD").strip(), "HEAD")

    def edit_live_config(self):
        live = json.loads((self.runner / "config.json").read_text())
        live["repair"]["enabled"] = True
        data = host.encode(live)
        (self.runner / "config.json").write_bytes(data)
        return data

    def test_drifted_live_config_is_backed_up_not_refused(self):
        # A host edit (repair.enabled) makes the live config differ from the
        # overlay's render of HEAD. That is not a refusal: the bytes are
        # backed up before the switch and rollback reinstalls them verbatim.
        edited = self.edit_live_config()
        run = self.build(target_sha=self.target)
        self.assertEqual(run.run()["outcome"], "completed")
        backups = list(Path(self.overlay["record_dir"])
                       .glob("config-before-switch-*"))
        self.assertEqual([path.read_bytes() for path in backups], [edited])

    def test_drifted_live_config_is_restored_exactly_on_rollback(self):
        edited = self.edit_live_config()
        run = self.build(target_sha=self.target,
                         health=lambda: {"healthy": False,
                                         "reason": "no advancing tick"})
        self.assertEqual(run.run()["outcome"], "rolled_back")
        self.assertEqual(self.head(), self.prior)
        self.assertEqual((self.runner / "config.json").read_bytes(), edited)

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

    def test_drain_expiry_survives_a_failed_diagnostic_write(self):
        # The drain expires against the real controller poll and drain.json
        # cannot be written (disk full). The I/O error must not replace the
        # FailStop: an escaping error would be an ordinary refusal whose
        # pre-switch restore restarts the triggers and releases admission
        # while live work may still be running against this checkout.
        (self.runner / "state/queue.json").write_text(
            '{"items": [{"id": "q1", "run": {"run_id": 7}}], "starts": []}\n')
        real_write = rb.durable_write

        def failing_write(path, payload):
            if Path(path).name == "drain.json":
                raise OSError("disk full")
            return real_write(path, payload)

        run = self.build()
        run.drain_fn = None
        with mock.patch.object(rb, "durable_write", side_effect=failing_write):
            with self.assertRaises(rb.RecoveryRequired) as caught:
                run.run()
        self.assertIn("drain expired", str(caught.exception))
        self.assertTrue(self.marker().exists())
        self.assertEqual(self.units.started, [])
        self.assertTrue(all(self.units.state(unit) in ("inactive", "failed")
                            for unit in TRIGGERS))
        self.assertEqual(self.head(), self.prior)
        self.assertFalse((Path(run.run_dir) / "drain.json").exists())
        record = self.record(run)
        self.assertEqual(record["outcome"], "recovery_required")
        self.assertEqual(record["original_triggers"], self.original)

    def test_drain_expiry_survives_failed_diagnostic_write_and_narration(self):
        (self.runner / "state/queue.json").write_text(
            '{"items": [{"id": "q1", "run": {"run_id": 7}}], "starts": []}\n')
        real_write = rb.durable_write

        def failing_write(path, payload):
            if Path(path).name == "drain.json":
                raise OSError("disk full")
            return real_write(path, payload)

        real_narrate = rb.narrate

        def failing_narrate(message):
            if "drain.json" in message:
                raise OSError(28, "No space left")
            return real_narrate(message)

        run = self.build()
        run.drain_fn = None
        with mock.patch.object(rb, "durable_write", side_effect=failing_write), \
                mock.patch.object(rb, "narrate", side_effect=failing_narrate):
            with self.assertRaises(rb.RecoveryRequired) as caught:
                run.run()
        self.assertIn("drain expired", str(caught.exception))
        self.assertTrue(self.marker().exists())
        self.assertEqual(self.units.started, [])

    def test_drain_deadline_rejects_success_observed_after_expiry(self):
        # With --drain-deadline-s 10 --drain-interval-s 600, a blocked first
        # poll must not buy a 600s wait past the deadline, and a queue that
        # settles only after the deadline must not be accepted: expiry fails
        # closed even on a clean answer, and the hold stays.
        (self.runner / "state/queue.json").write_text(
            '{"items": [{"id": "q1", "run": {"run_id": 7}}], "starts": []}\n')
        real_check = dc.drain_check

        def settles_late(effects, liveness, deadline=None, clock=None):
            if self.clock() >= 10:
                return {"drained": True, "blocked": []}
            return real_check(effects, liveness)

        run = self.build(drain_interval_s=600)
        run.drain_fn = None
        with mock.patch.object(dc, "drain_check", side_effect=settles_late):
            with self.assertRaises(rb.RecoveryRequired) as caught:
                run.run()
        self.assertIn("drain expired", str(caught.exception))
        # The sleep was capped at the remaining deadline, not the 600s
        # interval: the late poll lands exactly at the deadline.
        self.assertEqual(self.now[0], 10.0)
        record = json.loads(
            (Path(run.run_dir) / "drain.json").read_text())
        self.assertFalse(record["drained"])
        # The late clean answer is named so an operator does not read the
        # final poll's empty blocked list as "still blocked".
        self.assertTrue(record["drained_after_deadline"])
        self.assertIn("only after the deadline", str(caught.exception))
        self.assertNotIn("[]", str(caught.exception))
        self.assertTrue(self.marker().exists())
        self.assertEqual(self.units.started, [])
        self.assertEqual(self.head(), self.prior)
        self.assertEqual(self.record(run)["outcome"], "recovery_required")

    def test_drain_deadline_crossed_between_clock_reads_never_sleeps_negative(self):
        # The deadline can pass between two clock reads (a descheduled
        # process). The loop must read the clock once per iteration so the
        # remaining time is never negative: production time.sleep raises
        # ValueError on a negative value, which would escape FailStop.
        (self.runner / "state/queue.json").write_text(
            '{"items": [{"id": "q1", "run": {"run_id": 7}}], "starts": []}\n')
        real_check = dc.drain_check
        armed = []

        def stepped_clock():
            # Before the first poll the clock is the fixture clock, so the
            # deadline is base + 10. After it, reads step 5s then 11s past
            # base: inside the deadline, then beyond it.
            if not armed:
                return self.now[0]
            if len(armed) > 1:
                return armed[0] + 11.0
            armed.append(armed[0])
            return armed[0] + 5.0

        def arming_check(effects, liveness, deadline=None, clock=None):
            if not armed:
                armed.append(self.now[0])
            return real_check(effects, liveness)

        def strict_sleep(seconds):
            if seconds < 0:
                raise ValueError("sleep length must be non-negative")

        run = self.build(drain_interval_s=600)
        run.drain_fn = None
        run.clock = stepped_clock
        run.sleep = strict_sleep
        with mock.patch.object(dc, "drain_check", side_effect=arming_check):
            with self.assertRaises(rb.RecoveryRequired) as caught:
                run.run()
        self.assertIn("drain expired", str(caught.exception))
        self.assertTrue(self.marker().exists())
        self.assertEqual(self.units.started, [])

    def test_drain_first_poll_success_stays_immediate(self):
        # A queue already drained succeeds on the first poll even when the
        # interval is longer than the deadline: no sleep precedes the verdict.
        (self.runner / "state/queue.json").write_text(
            '{"items": [], "starts": []}\n')
        run = self.build(drain_interval_s=600)
        run.drain_fn = None
        document = run.run()
        self.assertEqual(document["outcome"], "completed")
        self.assertEqual(self.now[0], 0.0)
        record = json.loads(
            (Path(run.run_dir) / "drain.json").read_text())
        self.assertTrue(record["drained"])

    def test_drain_poll_enforces_deadline_inside_the_scan(self):
        # The deadline must bound the scan itself, not only the loop around
        # it: six recorded runs whose probes each run to their 30s timeout
        # would otherwise spend ~180s inside one poll before this loop
        # checked its clock. The poll carries the absolute deadline and the
        # run clock into drain_check, which caps each probe to the time
        # left and reports work it never observed as unresolved.
        (self.runner / "state/queue.json").write_text(
            '{"items": [], "starts": []}\n')
        real_check = dc.drain_check
        seen = []

        def spying_check(effects, liveness, deadline=None, clock=None):
            seen.append({"deadline": deadline, "clock": clock})
            return real_check(effects, liveness)

        run = self.build()
        run.drain_fn = None
        with mock.patch.object(dc, "drain_check", side_effect=spying_check):
            document = run.run()
        self.assertEqual(document["outcome"], "completed")
        self.assertEqual(seen, [{"deadline": 10.0, "clock": self.clock}])

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

            def switch(self, *args, rollback_config=None):
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

    def test_missing_cq_bin_entry_refuses_at_preflight(self):
        # A pointer whose entry is already missing must be rejected before
        # the admission hold: after the switch the same refusal would also
        # fail the rollback's runtime check, leaving nothing to restart.
        (self.runtime / "dist/cli.js").unlink()
        run = self.build()
        with self.assertRaisesRegex(rb.Refused, "points at a missing entry"):
            run.run()
        self.assertEqual(self.head(), self.prior)
        self.assertFalse(self.marker().exists())
        self.assertEqual(self.units.stopped, [])

    def test_cq_bin_entry_deleted_after_measure_still_refuses(self):
        # The later checks stay: deleting the measured entry after preflight
        # must refuse the restart (and any rollback restart) exactly like a
        # content change does.
        run = self.build()
        run.cq_bin = rb.measure_cq_bin(self.original_config)
        (self.runtime / "dist/cli.js").unlink()
        with self.assertRaisesRegex(rb.Refused, "points at a missing entry"):
            run.runtime_pointer_check()

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

        def mutating_switch(root, overlay, raw, target, tag=None, rollback_config=None):
            result = real_switch(root, overlay, raw, target, tag, rollback_config=rollback_config)
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

        def replacing_switch(root, overlay, raw, target, tag=None, rollback_config=None):
            result = real_switch(root, overlay, raw, target, tag, rollback_config=rollback_config)
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

            def switch(self, *args, rollback_config=None):
                raise ValueError("helper refused the switch")

        run = self.build(helper=BrokenSwitch())
        with self.assertRaisesRegex(rb.Refused, "helper refused"):
            run.run()
        self.assertEqual(self.head(), self.prior)
        self.assertFalse(self.marker().exists())
        self.assertEqual({unit: self.units.state(unit)
                          for unit in TRIGGERS}, self.original)
        self.assertEqual(self.record(run)["outcome"], "refused")

    def test_interrupt_after_first_config_restore_reinstalls_live_config(self):
        # The first ``git restore -- CONFIG`` replaces the host-edited live
        # bytes with committed ones. An interrupt landing right after it
        # returns must still reinstall the saved bytes (the restore sits
        # inside the recovery block), with HEAD untouched.
        real_git = host.git
        restored = []

        def interrupted_after_restore(root, *args):
            result = real_git(root, *args)
            if args[:1] == ("restore",) and not restored:
                restored.append(1)
                self.assertNotEqual(
                    (self.runner / "config.json").read_bytes(),
                    self.original_config)
                raise KeyboardInterrupt
            return result

        with mock.patch.object(host, "git", interrupted_after_restore):
            with self.assertRaises(KeyboardInterrupt):
                host.switch(self.root, self.overlay, self.raw, self.target)
        self.assertEqual(restored, [1])
        self.assertEqual(self.head(), self.prior)
        self.assertEqual((self.runner / "config.json").read_bytes(),
                         self.original_config)

    def test_failed_checkout_leaving_head_at_previous_still_rolls_back(self):
        # A failed checkout can write the worktree before it moves HEAD, so
        # HEAD == previous must not skip the git rollback: with HEAD.lock
        # held the rollback checkout fails too, and the switch reports an
        # unrecovered rollback instead of reinstalling config over the
        # target's source files.
        lock = self.root / ".git/HEAD.lock"
        real_git = host.git

        def lock_before_checkout(root, *args):
            if args[:1] == ("checkout",) and not lock.exists():
                lock.write_text("")
            return real_git(root, *args)

        with mock.patch.object(host, "git", lock_before_checkout):
            with self.assertRaisesRegex(
                    ValueError, "failed; live config left unrecovered"):
                host.switch(self.root, self.overlay, self.raw, self.target)
        lock.unlink()
        self.assertEqual(self.head(), self.prior)
        self.assertNotEqual((self.runner / "config.json").read_bytes(),
                            self.original_config)

    def test_refusal_restore_with_lost_hold_recreate_reacquires_admission(self):
        class BrokenSwitch:
            def load_overlay(self, path):
                return host.load_overlay(path)

            def root_check(self, root, overlay):
                return host.root_check(root, overlay)

            def switch(self, *args, rollback_config=None):
                raise ValueError("helper refused the switch")

        real_sync = rb.Hold.sync_directory

        def sync_fails_once_marker_is_gone(hold):
            if not hold.path.exists():
                raise OSError(5, "I/O error")
            return real_sync(hold)

        run = self.build(helper=BrokenSwitch())
        with mock.patch.object(rb.Hold, "sync_directory",
                               sync_fails_once_marker_is_gone), \
                mock.patch.object(rb.Hold, "_write_marker",
                                  side_effect=OSError(28, "full")):
            with self.assertRaises(rb.RecoveryRequired):
                run.run()
        # fail-stop must have re-acquired the hold and reported it truthfully
        self.assertTrue(self.marker().exists())
        self.assertTrue(run.hold.owns())
        self.assertTrue(self.record(run)["admission_held"])

    def test_refusal_restore_with_foreign_hold_planted_keeps_it(self):
        class BrokenSwitch:
            def load_overlay(self, path):
                return host.load_overlay(path)

            def root_check(self, root, overlay):
                return host.root_check(root, overlay)

            def switch(self, *args, rollback_config=None):
                raise ValueError("helper refused the switch")

        real_sync = rb.Hold.sync_directory
        planted = []

        def sync(hold):
            if not hold.path.exists() and not planted:
                planted.append(1)
                hold.path.write_bytes(b"operator\n")
                raise OSError(5, "I/O error")
            return real_sync(hold)

        run = self.build(helper=BrokenSwitch())
        with mock.patch.object(rb.Hold, "sync_directory", sync):
            with self.assertRaises(rb.RecoveryRequired):
                run.run()
        self.assertEqual(self.marker().read_bytes(), b"operator\n")
        self.assertFalse(run.hold.acquired)
        self.assertFalse(self.record(run)["admission_held"])
        self.assertIn("admission_reacquire_refusal", self.record(run))

    def _refusal_run_with_lost_hold(self, plant, unreadable):
        class BrokenSwitch:
            def load_overlay(self, path):
                return host.load_overlay(path)

            def root_check(self, root, overlay):
                return host.root_check(root, overlay)

            def switch(self, *args, rollback_config=None):
                raise ValueError("helper refused the switch")

        real_sync = rb.Hold.sync_directory
        real_ownership = rb.Hold.ownership
        state = {"gone": False}

        def sync(hold):
            if not hold.path.exists() and not state["gone"]:
                state["gone"] = True
                if plant:
                    hold.path.write_bytes(b"operator\n")
                raise OSError(5, "I/O error")
            return real_sync(hold)

        def ownership(hold):
            if unreadable and state["gone"] and (
                    unreadable == "always" or not state.get("hid")):
                state["hid"] = True
                return None
            return real_ownership(hold)

        run = self.build(helper=BrokenSwitch())
        patches = [mock.patch.object(rb.Hold, "sync_directory", sync),
                   mock.patch.object(rb.Hold, "ownership", ownership)]
        if not plant:
            patches.append(mock.patch.object(rb.Hold, "_write_marker",
                                             side_effect=OSError(28, "full")))
        with contextlib.ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            with self.assertRaises(rb.RecoveryRequired):
                run.run()
        return run

    def test_unreadable_foreign_marker_still_records_reacquire_refusal(self):
        run = self._refusal_run_with_lost_hold(plant=True, unreadable=True)
        self.assertEqual(self.marker().read_bytes(), b"operator\n")
        self.assertIn("admission_reacquire_refusal", self.record(run))
        self.assertFalse(self.record(run)["admission_held"])

    def test_marker_absent_with_reads_failing_is_restored_by_fail_stop(self):
        # Every read after the fault returns unknown, so ownership can never
        # be confirmed; fail_stop must treat unknown as not owned and put
        # this run's token back rather than leave no marker on disk.
        run = self._refusal_run_with_lost_hold(plant=False,
                                               unreadable="always")
        self.assertTrue(self.marker().exists())
        self.assertEqual(self.marker().read_bytes(), run.hold.token)
        self.assertTrue(run.hold.acquired)

    def test_unreadable_missing_marker_is_reacquired_by_fail_stop(self):
        run = self._refusal_run_with_lost_hold(plant=False, unreadable=True)
        self.assertTrue(self.marker().exists())
        self.assertTrue(run.hold.owns())
        self.assertTrue(self.record(run)["admission_held"])

    def test_forward_release_sync_failure_is_recorded_and_exits_3(self):
        real_sync = rb.Hold.sync_directory
        state = {"failed": False}

        def sync(hold):
            if not hold.path.exists() and not state["failed"]:
                state["failed"] = True
                raise OSError(5, "I/O error")
            return real_sync(hold)

        runs = []

        def factory(args):
            runs.append(self.build())
            return runs[0]

        with mock.patch.object(rb.Hold, "sync_directory", sync), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            code = rb.main(
                ["deploy", "--root", str(self.root),
                 "--overlay", str(self.overlay_path),
                 "--record-dir", str(self.record_dir),
                 "--target-sha", self.target, "--no-fetch"],
                run_factory=factory)
        self.assertEqual(code, 3)
        error = json.loads(output.getvalue())["error"]
        run = runs[0]
        self.assertEqual(error["kind"], "recovery_required")
        self.assertEqual(error["run_dir"], str(run.run_dir))
        self.assertEqual(error["outcome"], "recovery_required")
        self.assertEqual(self.record(run)["outcome"], "recovery_required")
        self.assertEqual(self.marker().read_bytes(), run.hold.token)
        self.assertTrue(run.hold.acquired)

    def test_rollback_release_sync_failure_is_recorded_and_exits_3(self):
        real_sync = rb.Hold.sync_directory
        absent_syncs = []

        def sync(hold):
            if not hold.path.exists():
                absent_syncs.append(1)
                # the forward release syncs first; fail the rollback's
                if len(absent_syncs) == 2:
                    raise OSError(5, "I/O error")
            return real_sync(hold)

        runs = []

        def factory(args):
            runs.append(self.build(
                health=lambda: {"healthy": False, "observations": ["bad"]}))
            return runs[0]

        with mock.patch.object(rb.Hold, "sync_directory", sync), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            code = rb.main(
                ["deploy", "--root", str(self.root),
                 "--overlay", str(self.overlay_path),
                 "--record-dir", str(self.record_dir),
                 "--target-sha", self.target, "--no-fetch"],
                run_factory=factory)
        self.assertEqual(code, 3)
        error = json.loads(output.getvalue())["error"]
        run = runs[0]
        self.assertEqual(len(absent_syncs), 2)
        self.assertEqual(error["run_dir"], str(run.run_dir))
        self.assertEqual(error["outcome"], "recovery_required")
        self.assertEqual(self.record(run)["outcome"], "recovery_required")
        self.assertEqual(self.marker().read_bytes(), run.hold.token)

    def _main_failing_nth_present_sync(self, nth, health=None):
        """Run main() with the nth directory sync issued while the marker
        exists failing: 1 is the forward acquire, 2 the rollback re-acquire."""
        real_sync = rb.Hold.sync_directory
        present = []

        def sync(hold):
            if hold.path.exists():
                present.append(1)
                if len(present) == nth:
                    raise OSError(5, "I/O error")
            return real_sync(hold)

        runs = []

        def factory(args):
            kwargs = {} if health is None else {"health": health}
            runs.append(self.build(**kwargs))
            return runs[0]

        with mock.patch.object(rb.Hold, "sync_directory", sync), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            code = rb.main(
                ["deploy", "--root", str(self.root),
                 "--overlay", str(self.overlay_path),
                 "--record-dir", str(self.record_dir),
                 "--target-sha", self.target, "--no-fetch"],
                run_factory=factory)
        self.assertGreaterEqual(len(present), nth)
        return code, json.loads(output.getvalue())["error"], runs[0]

    def _assert_recorded_recovery(self, code, error, run):
        self.assertEqual(code, 3)
        self.assertIsNotNone(error["run_dir"])
        self.assertEqual(error["run_dir"], str(run.run_dir))
        self.assertEqual(error["outcome"], "recovery_required")
        self.assertEqual(self.record(run)["outcome"], "recovery_required")
        self.assertEqual(self.marker().read_bytes(), run.hold.token)

    def test_forward_acquire_sync_failure_is_recorded_and_exits_3(self):
        code, error, run = self._main_failing_nth_present_sync(1)
        self._assert_recorded_recovery(code, error, run)

    def test_rollback_reacquire_sync_failure_is_recorded_and_exits_3(self):
        code, error, run = self._main_failing_nth_present_sync(
            2, health=lambda: {"healthy": False, "observations": ["bad"]})
        self._assert_recorded_recovery(code, error, run)

    def test_switch_dirtied_queue_refuses_before_health_when_rollback_is_disabled(self):
        # A switch that dirties the shared queue is refused by the
        # post-switch verification while the hold is still owned, before
        # admission is released and before the health window runs. The
        # dirtied queue also lost rollback permission, so the rollback
        # fails into recovery_required and the health callback is never
        # invoked.
        health_calls = []

        def health():
            health_calls.append(1)
            return {"healthy": False, "reason": "no advancing tick"}

        real_switch = host.switch

        def dirtying_switch(root, overlay, raw, target, tag=None, rollback_config=None):
            result = real_switch(root, overlay, raw, target, tag, rollback_config=rollback_config)
            (self.runner / "state/queue.json").write_text(
                '{"schema_version": 3, "items": []}\n')
            return result

        helper = mock.Mock(wraps=None)
        helper.load_overlay = host.load_overlay
        helper.root_check = host.root_check
        helper.verify_target = host.verify_target
        helper.switch = dirtying_switch
        run = self.build(helper=helper, health=health)
        with self.assertRaisesRegex(rb.RecoveryRequired,
                                    "automatic rollback is disabled"):
            run.run()
        self.assertEqual(health_calls, [])
        self.assertIn("shared queue state changed during the switch",
                      self.record(run)["reason"])
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

    def test_status_refuses_while_a_deploy_holds_the_deploy_lock(self):
        run = self.build()
        run.run()
        status_args = rb.build_parser().parse_args(
            ["status", "--run-dir", str(run.run_dir),
             "--root", str(self.root)])
        holder = rb.DeployLock(self.root)
        holder.acquire()
        try:
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(
                    rb.cmd_status(status_args, units=self.units), 1)
        finally:
            holder.release()
        document = json.loads(output.getvalue())
        self.assertFalse(document["ok"])
        self.assertIn("cannot be verified during a deployment transition",
                      document["refusal"])
        self.assertIn("deployment lock", document["refusal"])
        self.assertIsNone(document["live_head"])
        self.assertIsNone(document["live_triggers"])

    def test_status_refuses_while_a_controller_run_holds_the_lock(self):
        run = self.build()
        run.run()
        status_args = rb.build_parser().parse_args(
            ["status", "--run-dir", str(run.run_dir),
             "--root", str(self.root)])
        effects = dc.Effects(self.root, Path(run.run_dir))
        with effects.controller_lock():
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(
                    rb.cmd_status(status_args, units=self.units), 1)
        document = json.loads(output.getvalue())
        self.assertFalse(document["ok"])
        self.assertIn("cannot be verified during a deployment transition",
                      document["refusal"])
        self.assertIn("controller lock", document["refusal"])
        # The refused probe released the deploy lock it had already taken.
        probe = rb.DeployLock(self.root)
        probe.acquire()
        probe.release()

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
        self.assertEqual(code, 1)
        document = json.loads(output.getvalue())
        self.assertEqual(document["error"]["kind"], "interrupted")

    def recovery_required_error(self, record):
        class Failing:
            def __init__(self, args):
                self.args = args

            def run(self):
                raise rb.RecoveryRequired("x", record)

        with contextlib.redirect_stdout(io.StringIO()) as output:
            code = rb.main(
                ["deploy", "--root", str(self.root),
                 "--overlay", str(self.overlay_path),
                 "--record-dir", str(self.record_dir)],
                run_factory=Failing)
        self.assertEqual(code, 3)
        return json.loads(output.getvalue())["error"]

    def test_main_embeds_the_record_only_when_it_could_not_be_persisted(self):
        # deploy.json was not written, so the JSON error is the only artifact
        # holding the record; embed it with the structured storage error.
        error = self.recovery_required_error(
            {"run_dir": "/run", "outcome": "recovery_required",
             "persistence_error": "disk full"})
        self.assertEqual(error["kind"], "recovery_required")
        self.assertEqual(error["recovery_record"]["persistence_error"],
                         "disk full")
        # An ordinary recovery record is on disk already: no embed.
        error = self.recovery_required_error(
            {"run_dir": "/run", "outcome": "recovery_required"})
        self.assertNotIn("recovery_record", error)

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

    def test_negative_timing_arguments_are_a_usage_error_before_the_run(self):
        # A negative delay must fail as usage before Run() exists: a negative
        # --health-interval-s would otherwise surface as time.sleep(-1) in the
        # post-switch second observation and roll back an otherwise healthy
        # deploy. Zero stays valid (no delay before the second observation).
        factory_runs = []

        class Recording:
            def __init__(self, args):
                factory_runs.append(args)

            def run(self):
                return {"outcome": "completed"}

        with contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit) as caught:
                rb.main(["deploy", "--root", str(self.root),
                         "--overlay", str(self.overlay_path),
                         "--record-dir", str(self.record_dir),
                         "--health-interval-s", "-1"],
                        run_factory=Recording)
        self.assertEqual(caught.exception.code, 2)
        self.assertEqual(factory_runs, [])
        document = json.loads(output.getvalue())
        self.assertEqual(document["error"]["kind"], "usage")
        self.assertEqual(document["error"]["subcommand"], "deploy")
        self.assertEqual(document["error"]["message"],
                         "deploy timing arguments must be nonnegative")
        self.assertEqual(document["error"]["exitCode"], 2)
        self.assertIn("usage:", errors.getvalue())
        with contextlib.redirect_stdout(io.StringIO()) as output:
            code = rb.main(["deploy", "--root", str(self.root),
                            "--overlay", str(self.overlay_path),
                            "--record-dir", str(self.record_dir),
                            "--health-interval-s", "0"],
                           run_factory=Recording)
        self.assertEqual(code, 0)
        self.assertEqual(len(factory_runs), 1)
        self.assertEqual(json.loads(output.getvalue())["outcome"],
                         "completed")

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


class HoldPersistenceTest(unittest.TestCase):
    """A marker that exists but whose token never persisted is acquired
    admission: the run must not report an unchanged-host refusal while
    admission stays disabled."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crq-hold-")
        self.addCleanup(self.temp.cleanup)
        self.hold = rb.Hold(Path(self.temp.name))

    def test_ownership_distinguishes_unreadable_from_not_owned(self):
        self.hold.acquire()
        self.assertIs(self.hold.ownership(), True)
        with mock.patch.object(Path, "read_bytes", side_effect=PermissionError(13, "denied")):
            self.assertIsNone(self.hold.ownership())
            self.assertFalse(self.hold.owns())
        self.hold.path.write_bytes(b"foreign\n")
        self.assertIs(self.hold.ownership(), False)
        self.hold.path.unlink()
        self.assertIs(self.hold.ownership(), False)

    def test_fragment_token_demands_recovery_and_keeps_the_marker(self):
        # Only a fragment of the token lands before storage gives up, so the
        # marker's bytes cannot prove this run's ownership. The marker must
        # stay (it holds admission) and the failure must be recovery
        # required carrying the retained marker identity -- never a plain
        # refusal that claims the host is unchanged.
        class FragmentingHandle:
            def __init__(self, descriptor):
                self.descriptor = descriptor

            def __enter__(self):
                return self

            def __exit__(self, *exception):
                os.close(self.descriptor)
                return False

            def write(self, data):
                os.write(self.descriptor, data[:4])
                raise OSError(28, "No space left on device")

            def flush(self):
                pass

            def fileno(self):
                return self.descriptor

        def fragmenting_fdopen(descriptor, mode):
            return FragmentingHandle(descriptor)

        with mock.patch.object(rb.os, "fdopen",
                               side_effect=fragmenting_fdopen):
            with self.assertRaises(rb.RecoveryRequired) as caught:
                self.hold.acquire()
        self.assertIn(str(self.hold.path), str(caught.exception))
        self.assertIn("admission stays disabled", str(caught.exception))
        self.assertTrue(self.hold.path.exists())
        self.assertNotEqual(self.hold.path.read_bytes(), self.hold.token)
        self.assertTrue(self.hold.created)
        self.assertFalse(self.hold.acquired)

    def test_proven_ownership_removes_an_unsyncable_marker(self):
        # The token bytes landed but the fsync failed. The marker's bytes
        # still prove this run's ownership, so the run removes it; the
        # removal's directory sync fails too, so the transition is reported
        # as unverifiable -- the marker may reappear after a reboot and
        # hold admission -- rather than a refusal that claims the host is
        # unchanged.
        full = OSError(28, "No space left on device")
        with mock.patch.object(rb.os, "fsync", side_effect=full):
            with self.assertRaises(rb.RecoveryRequired):
                self.hold.acquire()
        self.assertFalse(self.hold.path.exists())
        self.assertTrue(self.hold.created)
        self.assertFalse(self.hold.acquired)

    def test_release_resyncs_hold_when_removal_sync_fails(self):
        # The unlink succeeds but the directory fsync fails: admission must
        # not be left open, so the hold is re-established and stays acquired.
        self.hold.acquire()
        outcomes = [OSError(5, "I/O error"), None]
        with mock.patch.object(rb.Hold, "sync_directory",
                               side_effect=outcomes):
            with self.assertRaises(rb.RecoveryRequired) as caught:
                self.hold.release()
        self.assertIn("re-established", str(caught.exception))
        self.assertTrue(self.hold.acquired)
        self.assertEqual(self.hold.path.read_bytes(), self.hold.token)

    def test_release_reports_open_admission_when_hold_cannot_return(self):
        self.hold.acquire()
        with mock.patch.object(rb.Hold, "sync_directory",
                               side_effect=OSError(5, "I/O error")), \
                mock.patch.object(rb.Hold, "_write_marker",
                                  side_effect=OSError(28, "full")):
            with self.assertRaises(rb.RecoveryRequired) as caught:
                self.hold.release()
        self.assertIn("admission may be open", str(caught.exception))
        self.assertFalse(self.hold.path.exists())
        self.assertFalse(self.hold.acquired)

    def _sync_failing_after_planting(self, content):
        real = rb.Hold.sync_directory
        state = {"first": True}

        def sync(hold):
            if state["first"]:
                state["first"] = False
                hold.path.write_bytes(content)
                raise OSError(5, "I/O error")
            return real(hold)

        return sync

    def test_foreign_marker_planted_before_recreate_is_preserved(self):
        self.hold.acquire()
        with mock.patch.object(rb.Hold, "sync_directory",
                               self._sync_failing_after_planting(b"operator\n")):
            with self.assertRaises(rb.RecoveryRequired) as caught:
                self.hold.release()
        self.assertEqual(self.hold.path.read_bytes(), b"operator\n")
        self.assertFalse(self.hold.acquired)
        self.assertFalse(self.hold.owns())
        self.assertIn("foreign hold", str(caught.exception))

    def test_unreadable_marker_after_collision_is_unknown_not_foreign(self):
        self.hold.acquire()
        sync = self._sync_failing_after_planting(self.hold.token)
        real_ownership = rb.Hold.ownership
        calls = []

        def ownership(hold):
            # readable while the release verifies ownership, unreadable
            # once the re-create collides with the planted marker
            calls.append(1)
            return real_ownership(hold) if len(calls) == 1 else None

        with mock.patch.object(rb.Hold, "sync_directory", sync), \
                mock.patch.object(rb.Hold, "ownership", ownership):
            with self.assertRaises(rb.RecoveryRequired) as caught:
                self.hold.release()
        message = str(caught.exception)
        self.assertNotIn("foreign", message)
        self.assertIn("unknown", message)
        self.assertTrue(self.hold.acquired)
        self.assertEqual(self.hold.path.read_bytes(), self.hold.token)

    def test_failed_recreate_with_unreadable_marker_keeps_acquired(self):
        # No marker could be written and reads keep failing: the state is
        # unknown, so ``acquired`` is not cleared on a guess.
        self.hold.acquire()
        outcomes = [OSError(5, "I/O error"), None]
        calls = []
        real_ownership = rb.Hold.ownership

        def ownership(hold):
            calls.append(1)
            return real_ownership(hold) if len(calls) == 1 else None

        with mock.patch.object(rb.Hold, "sync_directory",
                               side_effect=outcomes), \
                mock.patch.object(rb.Hold, "_write_marker",
                                  side_effect=OSError(28, "full")), \
                mock.patch.object(rb.Hold, "ownership", ownership):
            with self.assertRaises(rb.RecoveryRequired):
                self.hold.release()
        self.assertTrue(self.hold.acquired)

    def test_same_token_marker_already_present_is_tolerated(self):
        self.hold.acquire()
        with mock.patch.object(rb.Hold, "sync_directory",
                               self._sync_failing_after_planting(
                                   self.hold.token)):
            with self.assertRaises(rb.RecoveryRequired) as caught:
                self.hold.release()
        self.assertNotIn("foreign", str(caught.exception))
        self.assertTrue(self.hold.acquired)
        self.assertTrue(self.hold.owns())

    def test_acquire_collision_text_matches_verified_ownership(self):
        self.hold.path.parent.mkdir(parents=True)
        self.hold.path.write_bytes(b"operator\n")
        with self.assertRaises(rb.Refused) as foreign:
            self.hold.acquire()
        self.assertIn("another deploy or a manual hold owns it",
                      str(foreign.exception))
        with mock.patch.object(rb.Hold, "ownership", return_value=None):
            with self.assertRaises(rb.Refused) as unknown:
                self.hold.acquire()
        self.assertIn("could not be read", str(unknown.exception))
        self.assertNotIn("another deploy", str(unknown.exception))
        self.assertEqual(self.hold.path.read_bytes(), b"operator\n")
        self.hold.path.write_bytes(self.hold.token)
        with self.assertRaises(rb.Refused) as ours:
            self.hold.acquire()
        self.assertIn("this run's token", str(ours.exception))
        self.assertNotIn("another deploy", str(ours.exception))

    def test_acquire_collision_with_vanished_marker_is_not_called_foreign(self):
        real_open = os.open

        def vanishing_open(path, *args, **kwargs):
            if str(path) == str(self.hold.path):
                self.hold.path.unlink()
                raise FileExistsError(17, "File exists", str(path))
            return real_open(path, *args, **kwargs)

        self.hold.path.parent.mkdir(parents=True)
        self.hold.path.write_bytes(b"operator\n")
        with mock.patch.object(rb.os, "open", vanishing_open):
            with self.assertRaises(rb.Refused) as raised:
                self.hold.acquire()
        self.assertIn("no longer present", str(raised.exception))
        self.assertIn("retry is fine", str(raised.exception))
        self.assertNotIn("another deploy", str(raised.exception))
        self.assertFalse(self.hold.path.exists())

    def test_unsynced_recreated_hold_is_reported_as_present(self):
        self.hold.acquire()
        with mock.patch.object(rb.Hold, "sync_directory",
                               side_effect=OSError(5, "I/O error")):
            with self.assertRaises(rb.RecoveryRequired) as caught:
                self.hold.release()
        message = str(caught.exception)
        self.assertNotIn("admission may be open", message)
        self.assertIn("is present", message)
        self.assertTrue(self.hold.acquired)
        self.assertTrue(self.hold.owns())

    def test_recreated_hold_syncs_its_directory(self):
        self.hold.acquire()
        calls = []

        def failing_then_recording():
            calls.append(1)
            if len(calls) == 1:
                raise OSError(5, "I/O error")

        with mock.patch.object(rb.Hold, "sync_directory",
                               side_effect=failing_then_recording):
            with self.assertRaises(rb.RecoveryRequired):
                self.hold.release()
        # one failed removal sync, then one sync of the recreated entry
        self.assertEqual(len(calls), 2)

    def test_acquire_syncs_parent_of_each_created_directory(self):
        root = Path(self.temp.name)
        synced = []
        real = rb.Hold._sync_path

        def record(path):
            synced.append(Path(path))
            return real(path)

        with mock.patch.object(rb.Hold, "_sync_path",
                               side_effect=record):
            self.hold.acquire()
        state = self.hold.path.parent
        self.assertIn(state, synced)
        self.assertIn(state.parent, synced)
        self.assertTrue(state.parent.is_relative_to(root))

    def test_acquire_syncs_marker_dir_parent_when_dir_pre_exists(self):
        self.hold.path.parent.mkdir(parents=True)
        synced = []
        real = rb.Hold._sync_path

        def record(path):
            synced.append(Path(path))
            return real(path)

        with mock.patch.object(rb.Hold, "_sync_path",
                               side_effect=record):
            self.hold.acquire()
        self.assertIn(self.hold.path.parent.parent, synced)

    def test_acquire_recovery_when_new_directory_parent_sync_fails(self):
        real = rb.Hold._sync_path
        marker_dir = self.hold.path.parent

        def fail_parent(path):
            if Path(path) != marker_dir:
                raise OSError(5, "I/O error")
            return real(path)

        with mock.patch.object(rb.Hold, "_sync_path",
                               side_effect=fail_parent):
            with self.assertRaises(rb.RecoveryRequired):
                self.hold.acquire()
        self.assertFalse(self.hold.acquired)
        self.assertTrue(self.hold.path.exists())


if __name__ == "__main__":
    unittest.main()
