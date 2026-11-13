"""Integration tests for the internal unit-switch factory composition.

Real ``ProductionUnitAdapter``, real ``SystemdJournalCompletionPort`` and the
real production renderer run through the actual
``deploy-controller.switch_unit`` and ``recover_unit`` seams. Unit files,
symlinks, modes, snapshots and records are real temporary files.

Only the host boundary is injected: a structured systemd port over the real
unit directory and a journal source that returns actual systemd invocation and
record fields. There is no fixture completion log, no fabricated evidence
record, no systemctl, no VM, no live unit, no network and no production host.
"""
import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path

from test_deploy_controller_fixtures import dc
from test_unit_adapter import (
    AdapterFixture,
    FakeSystemd,
    LiveIdentity,
    NODE_RUNTIME,
    Ticker,
    _node_artifact,
    _tree,
    _write,
)

ROOT = Path(__file__).resolve().parent
OPS = ROOT / "ops"
UNIT = "crq-tick.service"
BOOT = "1" * 32
REBOOT_BOOT = "2" * 32


def _load(name, path):
    module = sys.modules.get(name)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


factory = _load("crq_unit_switch_factory", OPS / "unit-switch-factory.py")


class RecordingSystemd(FakeSystemd):
    """Injected systemd port with actual invocation facts for one unit.

    The port keeps a bounded per-unit invocation history (ID, exit monotonic
    timestamp, result, status) and a corresponding manager journal record. A
    service start completes one invocation immediately; a released timer fires
    exactly one further invocation, which becomes visible only on the second
    subsequent ``show`` of the service so two advancing completions are
    observable without inventing evidence.
    """

    def __init__(self, unit_dir, inventory):
        super().__init__(unit_dir, inventory)
        self.boot = BOOT
        self.invocations = {service: self._blank()
                            for service in self._services}
        self.journal = {}
        self.pending = set()
        self.service_shows = {}
        self.tick = 900
        self.after_service_start = None

    @staticmethod
    def _blank():
        return {"id": "", "exit": 0, "result": "success", "status": "0"}

    def prior(self, service, invocation, exit_monotonic):
        """Record a completed prior invocation as the installed baseline."""
        self.tick = max(self.tick, exit_monotonic)
        self.invocations[service] = {
            "id": invocation, "exit": exit_monotonic,
            "result": "success", "status": "0"}
        self._record(service, invocation, exit_monotonic)

    def _record(self, service, invocation, exit_monotonic):
        self.journal.setdefault(service, []).append({
            "_BOOT_ID": self.boot,
            "UNIT": service,
            "INVOCATION_ID": invocation,
            "__MONOTONIC_TIMESTAMP": str(exit_monotonic + 1),
            "MESSAGE": "Succeeded.",
        })

    def _complete(self, service):
        self.tick += 10
        invocation = "%032x" % self.tick
        self.invocations[service] = {
            "id": invocation, "exit": self.tick,
            "result": "success", "status": "0"}
        self._record(service, invocation, self.tick)
        self.active[service] = "inactive"

    def run(self, *args, timeout=60):
        result = super().run(*args, timeout=timeout)
        if args and args[0] == "start" and result.get("rc") == 0 \
                and len(args) > 1:
            name = args[1]
            if name in self._services:
                self._complete(name)
                if self.after_service_start is not None:
                    self.after_service_start(name)
            else:
                service = self._service_for_activator(name)
                if service is not None:
                    self.pending.add(service)
                    self.service_shows[service] = 0
        return result

    def show(self, unit, props):
        values = super().show(unit, props)
        if unit in self._services:
            invocation = self.invocations[unit]
            if unit in self.pending:
                count = self.service_shows.get(unit, 0) + 1
                self.service_shows[unit] = count
                if count >= 2:
                    self.pending.discard(unit)
                    self._complete(unit)
                    invocation = self.invocations[unit]
            values["InvocationID"] = invocation["id"]
            values["Result"] = invocation["result"]
            values["ExecMainStatus"] = invocation["status"]
            values["ExecMainExitTimestampMonotonic"] = str(invocation["exit"])
        return {prop: values.get(prop, "") for prop in props}


class StructuredJournalSource:
    """Read-only journal over the same structured systemd facts."""

    def __init__(self, systemd):
        self.systemd = systemd
        self.boot = systemd.boot

    def reboot(self):
        self.boot = REBOOT_BOOT

    def show(self, unit, props):
        return self.systemd.show(unit, list(props))

    def records(self, unit, *, after_monotonic):
        return {"boot_id": self.boot,
                "records": [dict(record) for record
                            in self.systemd.journal.get(unit, [])]}

    def boot_id(self):
        return self.boot


class QueueProbe:
    """The controller's queue drain shape with a bounded fault schedule.

    Call 1 drifts the installed timer so the real adapter refuses at install;
    call 2 reports live work so the automatic rollback refuses too, leaving a
    genuine ``recovery_required`` record at the drained phase. Later calls are
    drained, so the actual ``recover_unit`` seam can finish.
    """

    def __init__(self, timer_path):
        self.timer_path = Path(timer_path)
        self.original = self.timer_path.read_bytes()
        self.calls = 0

    def __call__(self):
        self.calls += 1
        if self.calls == 1:
            self.timer_path.write_bytes(self.original + b"\n# drifted\n")
            return {"drained": True, "blocked": []}
        if self.calls == 2:
            return {"drained": False,
                    "blocked": [{"item": "job-1", "state": "alive"}]}
        return {"drained": True, "blocked": []}


class FactoryFixture(AdapterFixture):
    def setUp(self):
        super().setUp()
        self.systemd = RecordingSystemd(self.unit_dir, self.inventory)
        self.source = StructuredJournalSource(self.systemd)
        self.queue = lambda: dc.runner_queue_drain(self.effects)
        _write(self.unit_dir / UNIT, self.node_service(UNIT)["bytes"], 0o600)
        self.systemd.active[UNIT] = "inactive"
        self.systemd.active["crq-tick.timer"] = "active"
        self.systemd.prior(UNIT, "a" * 32, 900)

    def compose(self, unit=UNIT, runtime="python", **options):
        settings = {"queue_drain": self.queue, "error_type": dc.Refused,
                    "clock": Ticker(), "sleep": lambda _seconds: None}
        settings.update(options)
        return factory.compose(
            root=self.root, unit=unit, runtime=runtime,
            source_sha=self.before, unit_dir=self.unit_dir,
            systemd=self.systemd, identity=LiveIdentity(),
            journal_source=self.source, **settings)

    def records(self):
        return [json.loads(path.read_text())
                for path in self.record_dir.glob("controller-*.json")]


class FactorySelectionTests(FactoryFixture):
    def test_select_binds_the_rendered_python_identity(self):
        selection = factory.select(root=self.root, unit=UNIT, runtime="python",
                                   source_sha=self.before)
        rendered = self.python_service(UNIT)
        self.assertEqual(selection.render["bytes"], rendered["bytes"])
        self.assertEqual(selection.identity.service_sha256,
                         rendered["sha256"])
        self.assertEqual(selection.identity.source_sha, self.before)
        self.assertEqual(selection.identity.template_blob_oid,
                         rendered["template_blob_oid"])

    def test_select_refuses_an_unresolvable_source(self):
        with self.assertRaises(factory.FactoryRefused):
            factory.select(root=self.root, unit=UNIT, runtime="python",
                           source_sha="f" * 40)

    def test_select_refuses_an_undeclared_unit(self):
        with self.assertRaises(factory.FactoryRefused):
            factory.select(root=self.root, unit="crq-unknown.service",
                           runtime="python", source_sha=self.before)

    def test_select_refuses_a_malformed_runtime(self):
        with self.assertRaises(factory.FactoryRefused):
            factory.select(root=self.root, unit=UNIT, runtime="node:short",
                           source_sha=self.before)

    def test_artifact_capability_flows_into_the_existing_check(self):
        sha = "c" * 40
        _node_artifact(self.base, sha, capabilities=["tick"])
        runtime = "node:" + sha
        adapter, selection = self.compose(runtime=runtime)
        self.assertEqual(selection.render["artifact"]["capabilities"], ["tick"])
        prior = adapter.preflight(UNIT, runtime)
        self.assertEqual(prior["capability"]["command"], "tick")
        self.assertEqual(prior["capability"]["commands"], ["tick"])

    def test_empty_artifact_declaration_refuses_the_node_target(self):
        sha = "d" * 40
        _node_artifact(self.base, sha, capabilities=[])
        runtime = "node:" + sha
        adapter, selection = self.compose(runtime=runtime)
        self.assertEqual(selection.render["artifact"]["capabilities"], [])
        with self.assertRaisesRegex(dc.Refused, "does not implement"):
            adapter.preflight(UNIT, runtime)

    def test_other_artifact_declaration_refuses_the_node_target(self):
        sha = "e" * 40
        _node_artifact(self.base, sha, capabilities=["slot"])
        runtime = "node:" + sha
        adapter, _selection = self.compose(runtime=runtime)
        with self.assertRaisesRegex(dc.Refused, "does not implement"):
            adapter.preflight(UNIT, runtime)

    def test_select_refuses_a_tampered_capability_declaration(self):
        sha = "f" * 40
        artifact = _node_artifact(self.base, sha, capabilities=["tick"])
        (artifact / "dist/queue-runner/capabilities.json").write_text("{")
        with self.assertRaisesRegex(factory.FactoryRefused, "inventory"):
            factory.select(root=self.root, unit=UNIT, runtime="node:" + sha,
                           source_sha=self.before)

    def test_build_refuses_an_identity_that_does_not_bind_the_render(self):
        selection = factory.select(root=self.root, unit=UNIT,
                                   runtime="python", source_sha=self.before)
        identity = selection.identity
        broken = factory.Selection(
            root=selection.root, source_sha=selection.source_sha,
            unit=selection.unit, runtime=selection.runtime,
            artifact_root=selection.artifact_root, render=selection.render,
            identity=type(identity)(
                unit=identity.unit, runtime=identity.runtime,
                service_sha256="0" * 64, source_sha=identity.source_sha,
                template_blob_oid=identity.template_blob_oid,
                artifact_content_sha256=identity.artifact_content_sha256,
                artifact_source_sha=identity.artifact_source_sha,
                crq_js_sha256=identity.crq_js_sha256))
        with self.assertRaises(factory.FactoryRefused):
            factory.build(broken, unit_dir=self.unit_dir,
                          systemd=self.systemd, identity=LiveIdentity(),
                          journal_source=self.source,
                          queue_drain=self.queue)

    def test_build_refuses_a_render_digest_that_does_not_match_its_bytes(self):
        selection = factory.select(root=self.root, unit=UNIT,
                                   runtime="python", source_sha=self.before)
        identity = selection.identity
        broken = factory.Selection(
            root=selection.root, source_sha=selection.source_sha,
            unit=selection.unit, runtime=selection.runtime,
            artifact_root=selection.artifact_root,
            render={**selection.render, "sha256": "0" * 64},
            identity=type(identity)(
                unit=identity.unit, runtime=identity.runtime,
                service_sha256="0" * 64, source_sha=identity.source_sha,
                template_blob_oid=identity.template_blob_oid,
                artifact_content_sha256=identity.artifact_content_sha256,
                artifact_source_sha=identity.artifact_source_sha,
                crq_js_sha256=identity.crq_js_sha256))
        with self.assertRaises(factory.FactoryRefused) as caught:
            factory.build(broken, unit_dir=self.unit_dir,
                          systemd=self.systemd, identity=LiveIdentity(),
                          journal_source=self.source,
                          queue_drain=self.queue)
        self.assertEqual(str(caught.exception),
                         "selected render digest does not match its bytes")

    def test_build_refuses_a_missing_journal_source(self):
        selection = factory.select(root=self.root, unit=UNIT,
                                   runtime="python", source_sha=self.before)
        with self.assertRaises(factory.FactoryRefused):
            factory.build(selection, unit_dir=self.unit_dir,
                          systemd=self.systemd, identity=LiveIdentity(),
                          journal_source=None, queue_drain=self.queue)


class FactorySwitchTests(FactoryFixture):
    def test_preflight_reads_the_prior_runtime_baseline_before_install(self):
        adapter, _selection = self.compose()
        prior = adapter.preflight(UNIT, "python")
        self.assertEqual(prior["runtime"], NODE_RUNTIME)
        self.assertEqual(prior["completion_sequence"], 900)
        self.assertEqual((self.unit_dir / UNIT).read_bytes(),
                         self.node_service(UNIT)["bytes"])
        self.assertEqual(self.records(), [])

    def test_real_composition_completes_with_two_advancing_invocations(self):
        adapter, selection = self.compose(require_journal_witness=True)
        record = dc.switch_unit(self.effects, adapter, UNIT, "python")
        self.assertEqual(record["outcome"], "completed")
        self.assertEqual(record["prior_runtime"], NODE_RUNTIME)
        expected = self.python_service(UNIT)
        service = self.unit_dir / UNIT
        self.assertEqual(service.read_bytes(), expected["bytes"])
        self.assertEqual(service.stat().st_mode & 0o7777, 0o600)
        completions = record["completions"]
        self.assertEqual(len(completions), 2)
        self.assertNotEqual(completions[0]["invocation"],
                            completions[1]["invocation"])
        self.assertLess(completions[0]["sequence"],
                        completions[1]["sequence"])
        self.assertGreater(completions[0]["sequence"], 0)
        self.assertGreater(completions[0]["sequence"], 900)
        self.assertNotIn("a" * 32,
                         [item["invocation"] for item in completions])
        for evidence in completions:
            self.assertEqual(evidence["unit"], UNIT)
            self.assertEqual(evidence["runtime"], "python")
            self.assertTrue(evidence["success"])
            self.assertEqual(evidence["service_sha256"],
                             selection.render["sha256"])
            self.assertEqual(evidence["source_sha"], self.before)
            self.assertEqual(evidence["template_blob_oid"],
                             selection.render["template_blob_oid"])
            self.assertEqual(evidence["witness"], "manager")
            self.assertEqual(evidence["boot_id"], BOOT)
        journal = self.records()
        self.assertEqual(len(journal), 1)
        self.assertEqual(journal[0]["outcome"], "completed")
        self.assertEqual(journal[0]["phase"], "activation_pending")
        self.assertIn(["start", UNIT], self.systemd.calls)
        self.assertIn(["start", "crq-tick.timer"], self.systemd.calls)
        self.assertEqual(self.systemd.active["crq-tick.timer"], "active")

    def test_node_target_refuses_before_journal(self):
        _write(self.unit_dir / UNIT,
               self.python_service(UNIT)["bytes"], 0o600)
        before = _tree(self.unit_dir)
        adapter, selection = self.compose(runtime=NODE_RUNTIME)
        self.assertEqual(selection.runtime, NODE_RUNTIME)
        with self.assertRaises(dc.Refused) as failure:
            dc.switch_unit(self.effects, adapter, UNIT, NODE_RUNTIME)
        self.assertIn("does not implement", str(failure.exception))
        self.assertEqual(self.records(), [])
        self.assertEqual(_tree(self.unit_dir), before)

    def test_simple_service_refuses_before_journal(self):
        unit = "crq-repair.service"
        _write(self.unit_dir / unit, self.node_service(unit)["bytes"], 0o644)
        self.systemd.active["crq-repair.timer"] = "active"
        self.systemd.active["crq-repair.path"] = "active"
        before = _tree(self.unit_dir)
        adapter, _selection = self.compose(unit=unit)
        with self.assertRaises(dc.Refused) as failure:
            dc.switch_unit(self.effects, adapter, unit, "python")
        self.assertIn("simple service", str(failure.exception))
        self.assertEqual(self.records(), [])
        self.assertEqual(_tree(self.unit_dir), before)

    def test_long_schedule_refuses_before_journal(self):
        unit = "crq-backfill.service"
        _write(self.unit_dir / unit, self.node_service(unit)["bytes"], 0o644)
        self.systemd.active["crq-backfill.timer"] = "active"
        before = _tree(self.unit_dir)
        adapter, _selection = self.compose(unit=unit)
        with self.assertRaises(dc.Refused) as failure:
            dc.switch_unit(self.effects, adapter, unit, "python")
        self.assertIn("exceeds the supported maximum", str(failure.exception))
        self.assertEqual(self.records(), [])
        self.assertEqual(_tree(self.unit_dir), before)

    def test_watchdog_declared_timeout_bounds_completion(self):
        unit = "crq-watchdog.service"
        self.assertEqual(self.inventory[unit]["service_timeout_seconds"], 300)
        # 12 min OnUnitActiveSec plus systemd's 1 min default AccuracySec.
        self.assertEqual(self.inventory[unit]["timer_bound_seconds"], 780)
        _write(self.unit_dir / unit, self.node_service(unit)["bytes"], 0o644)
        self.systemd.active["crq-watchdog.timer"] = "active"
        self.systemd.prior(unit, "c" * 32, 900)
        adapter, _selection = self.compose(unit=unit)
        prior = adapter.preflight(unit, "python")
        self.assertEqual(prior["completion_window"], 1140)

    def test_changed_installed_bytes_refuse_completion(self):
        alternate = self.python_service("crq-slot.service")

        def tamper(_service):
            _write(self.unit_dir / UNIT, alternate["bytes"], 0o600)

        self.systemd.after_service_start = tamper
        adapter, _selection = self.compose()
        with self.assertRaises(dc.RecoveryRequired) as failure:
            dc.switch_unit(self.effects, adapter, UNIT, "python")
        recovery = failure.exception.recovery
        self.assertEqual(recovery["outcome"], "recovery_required")
        self.assertEqual(recovery["phase"], "activation_pending")
        self.assertIn("digest", recovery["reason"])

    def test_reboot_during_completion_is_recovery_required(self):
        self.systemd.after_service_start = \
            lambda _service: self.source.reboot()
        adapter, _selection = self.compose()
        with self.assertRaises(dc.RecoveryRequired) as failure:
            dc.switch_unit(self.effects, adapter, UNIT, "python")
        recovery = failure.exception.recovery
        self.assertEqual(recovery["outcome"], "recovery_required")
        self.assertEqual(recovery["phase"], "activation_pending")
        self.assertIn("boot ID changed", recovery["reason"])
        service = self.unit_dir / UNIT
        self.assertTrue(service.is_symlink())
        self.assertEqual(os.readlink(service), "/dev/null")

    def test_rollback_and_recovery_restore_the_prior_runtime(self):
        timer = self.unit_dir / "crq-tick.timer"
        original_timer = timer.read_bytes()
        probe = QueueProbe(timer)
        adapter, _selection = self.compose(queue_drain=probe)
        with self.assertRaises(dc.RecoveryRequired) as failure:
            dc.switch_unit(self.effects, adapter, UNIT, "python")
        recovery = failure.exception.recovery
        self.assertEqual(recovery["outcome"], "recovery_required")
        self.assertEqual(recovery["phase"], "drained")
        self.assertEqual(probe.calls, 2)
        record_path = Path(recovery["record_path"])
        service = self.unit_dir / UNIT
        self.assertTrue(service.is_symlink())
        self.assertEqual(os.readlink(service), "/dev/null")
        self.assertNotEqual(timer.read_bytes(), original_timer)

        prior = self.node_service(UNIT)
        recovering, _selection = self.compose(queue_drain=probe)
        completed = dc.recover_unit(self.effects, recovering, record_path)
        self.assertEqual(completed["outcome"], "rolled_back")
        self.assertEqual(service.read_bytes(), prior["bytes"])
        self.assertEqual(service.stat().st_mode & 0o7777, 0o600)
        self.assertEqual(timer.read_bytes(), original_timer)
        self.assertFalse((self.unit_dir
                          / ("." + UNIT + ".staged")).exists())
        self.assertEqual(self.systemd.active["crq-tick.timer"], "active")
        final = json.loads(record_path.read_text())
        self.assertEqual(final["outcome"], "rolled_back")
        self.assertEqual(final["phase"], "restore_activation_pending")


if __name__ == "__main__":
    unittest.main()
