"""Per-unit transaction tests: all host operations are controlled fakes."""
import contextlib
import fcntl
import io
import json
import os
from types import SimpleNamespace
from unittest import mock

from test_deploy_controller_fixtures import ControllerFixture, dc


class Adapter:
    def __init__(self, runtime):
        self.runtime = runtime
        self.running = True
        self.sequence_number = 10
        self.bad_evidence = False

    def preflight(self, unit, runtime):
        return {"runtime": self.runtime}

    def snapshot(self, unit):
        return {"runtime": self.runtime, "running": self.running}

    def validate_snapshot(self, unit, snapshot):
        if (not isinstance(snapshot, dict)
                or set(snapshot) != {"runtime", "running"}
                or not dc._unit_runtime(snapshot.get("runtime"))
                or type(snapshot.get("running")) is not bool):
            raise dc.Refused("invalid snapshot")

    def stop_and_drain(self, unit):
        self.running = False

    def sequence(self, unit):
        return self.sequence_number

    def install(self, unit, runtime):
        self.runtime = runtime

    def start(self, unit):
        self.running = True

    def completion(self, unit, runtime, previous):
        self.sequence_number += 1
        return {"unit": unit, "runtime": "python" if self.bad_evidence else runtime,
                "success": True, "sequence": self.sequence_number}

    def restore(self, unit, snapshot):
        self.runtime = snapshot["runtime"]

    def restore_activation(self, unit, snapshot):
        self.running = snapshot["running"]


def pending_unit_switch():
    return {
        "schema_version": dc.JOURNAL_SCHEMA,
        "transaction_id": "a" * 32,
        "operation": "unit_switch",
        "unit": "crq-slot.service",
        "runtime": "node:" + "b" * 40,
        "prior_runtime": "python",
        "outcome": "pending",
        "at": "2026-10-27T00:00:00Z",
        "snapshot": {},
        "state": None,
        "phase": "snapshot",
    }


def pending_checkout(operation):
    return {
        "schema_version": dc.JOURNAL_SCHEMA,
        "transaction_id": "b" * 32,
        "operation": operation,
        "outcome": "pending",
        "at": "2026-10-27T00:00:00Z",
        "intended_operation": ("rollback" if operation.startswith("rollback")
                               else "deploy"),
        "prior_state": {},
        "prior_head": "a" * 40,
        "prior_config_sha256": None,
        "prior_tag": None,
        "target": "c" * 40,
        "tag": "crq-runner/20261027-1",
        "helper_sha256": "ab" * 32,
        "automatic_rollback_permitted": False,
        "rollback_compatibility": {},
    }


class UnitSwitchTests(ControllerFixture):
    def setUp(self):
        super().setUp()
        # Unit transactions now refuse before mutation when recorded queue
        # ownership cannot be observed; the fixture's queue is genuinely empty.
        self.write_state("queue.json", {"items": [], "starts": []})
        self.write_state("heartbeat.json",
                         {"last_tick": "2026-01-01T00:00:00Z"})

    def test_preservation_baseline_is_captured_after_drain(self):
        self.write_state("queue.json", {"version": "before"})
        fixture = self

        class DrainingAdapter(Adapter):
            def stop_and_drain(self, unit):
                fixture.write_state("queue.json", {"version": "drained"})
                super().stop_and_drain(unit)

        result = dc.switch_unit(self.effects, DrainingAdapter("python"),
                                "crq-tick.service", "node:" + "a" * 40)
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["state"]["preserved/queue.json"],
                         dc._sha256(self.effects.state_dir() / "queue.json"))

    def test_activation_crash_recovers_after_a_demonstrated_fence(self):
        class Crash(BaseException):
            pass

        class CrashingAdapter(Adapter):
            def start(self, unit):
                super().start(unit)
                raise Crash()

        adapter = CrashingAdapter("python")
        with self.assertRaises(Crash):
            dc.switch_unit(self.effects, adapter, "crq-tick.service", "node:" + "a" * 40)
        path = next(self.record_dir.glob("controller-*.json"))
        self.assertEqual(json.loads(path.read_text())["phase"], "activation_pending")
        recovered = dc.recover_unit(self.effects, adapter, path)
        self.assertEqual(recovered["outcome"], "rolled_back")
        self.assertEqual(recovered["failed_phase"], "activation_pending")
        self.assertEqual(adapter.runtime, "python")
        self.assertTrue(adapter.running)
        final = json.loads(path.read_text())
        self.assertEqual(final["phase"], "restore_activation_pending")
        self.assertEqual(final["outcome"], "rolled_back")

    def test_activation_recovery_drains_owned_work_before_restoring(self):
        class Crash(BaseException):
            pass

        class OwnedWorkAdapter(Adapter):
            def __init__(self):
                super().__init__("python")
                self.owned = []
                self.unrelated = ["unrelated-session"]

            def start(self, unit):
                self.owned.append("new-unit-work")
                raise Crash()

            def stop_and_drain(self, unit):
                self.owned.clear()
                super().stop_and_drain(unit)

        adapter = OwnedWorkAdapter()
        with self.assertRaises(Crash):
            dc.switch_unit(self.effects, adapter, "crq-tick.service", "node:" + "a" * 40)
        path = next(self.record_dir.glob("controller-*.json"))
        self.assertEqual(adapter.owned, ["new-unit-work"])
        recovered = dc.recover_unit(self.effects, adapter, path)
        self.assertEqual(recovered["outcome"], "rolled_back")
        self.assertEqual(adapter.owned, [])
        self.assertEqual(adapter.unrelated, ["unrelated-session"])

    def test_recovery_retries_an_interrupted_release_after_reestablishing_the_fence(self):
        class Crash(BaseException):
            pass

        class CrashingAdapter(Adapter):
            crashed = False

            def install(self, unit, runtime):
                raise RuntimeError("install failed")

            def restore_activation(self, unit, snapshot):
                super().restore_activation(unit, snapshot)
                if not self.crashed:
                    self.crashed = True
                    raise Crash()

        adapter = CrashingAdapter("python")
        with self.assertRaises(Crash):
            dc.switch_unit(self.effects, adapter, "crq-tick.service", "node:" + "a" * 40)
        path = next(self.record_dir.glob("controller-*.json"))
        self.assertEqual(json.loads(path.read_text())["phase"], "restore_activation_pending")
        recovered = dc.recover_unit(self.effects, adapter, path)
        self.assertEqual(recovered["outcome"], "rolled_back")
        self.assertEqual(recovered["failed_phase"], "drained")
        self.assertTrue(adapter.running)
        final = json.loads(path.read_text())
        self.assertEqual(final["phase"], "restore_activation_pending")
        self.assertEqual(final["outcome"], "rolled_back")
        self.assertEqual(final["reason"], "install failed")

    def test_rollback_release_follows_restore_activation_journal(self):
        fixture = self

        class JournalingAdapter(Adapter):
            def __init__(self):
                super().__init__("python")
                self.phases = []

            def _phase(self):
                records = [json.loads(candidate.read_text())
                           for candidate in fixture.record_dir.glob("controller-*.json")]
                return records[0]["phase"]

            def install(self, unit, runtime):
                raise RuntimeError("install failed")

            def restore(self, unit, snapshot):
                self.phases.append(("restore", self._phase()))
                super().restore(unit, snapshot)

            def restore_activation(self, unit, snapshot):
                self.phases.append(("release", self._phase()))
                super().restore_activation(unit, snapshot)

        adapter = JournalingAdapter()
        with self.assertRaises(dc.RecoveryRequired):
            dc.switch_unit(self.effects, adapter, "crq-tick.service",
                           "node:" + "a" * 40)
        self.assertEqual(adapter.phases, [
            ("restore", "drained"),
            ("release", "restore_activation_pending"),
        ])
        self.assertTrue(adapter.running)

    def test_recovery_final_journal_failure_retains_ambiguous_intent(self):
        class Crash(BaseException):
            pass

        class InterruptedAdapter(Adapter):
            def install(self, unit, runtime):
                raise Crash()

        with self.assertRaises(Crash):
            dc.switch_unit(self.effects, InterruptedAdapter("python"), "crq-tick.service",
                           "node:" + "a" * 40)
        path = next(self.record_dir.glob("controller-*.json"))
        replace = self.effects.journal_replace

        def fail_final(record_path, record):
            if record.get("outcome") == "rolled_back":
                raise OSError("journal unavailable")
            return replace(record_path, record)

        adapter = Adapter("python")
        with mock.patch.object(self.effects, "journal_replace", side_effect=fail_final):
            with self.assertRaises(dc.RecoveryRequired) as failure:
                dc.recover_unit(self.effects, adapter, path)
        self.assertEqual(failure.exception.recovery["outcome"], "pending")
        self.assertEqual(json.loads(path.read_text())["phase"], "restore_activation_pending")
        retried = dc.recover_unit(self.effects, adapter, path)
        self.assertEqual(retried["outcome"], "rolled_back")
        self.assertEqual(json.loads(path.read_text())["outcome"], "rolled_back")

    def test_pending_unit_intent_blocks_deploy_and_rollback(self):
        self.effects.journal_append(pending_unit_switch())
        with self.assertRaisesRegex(dc.Refused, "unfinished unit switch"):
            dc.deploy_plan(self.effects, None, "", "", self.overlay_path)
        with self.assertRaisesRegex(dc.Refused, "unfinished unit switch"):
            dc.rollback_plan(self.effects, None, {}, self.overlay_path)

    def test_resolution_prose_cannot_clear_pending_unit_intent(self):
        path = self.effects.journal_append(pending_unit_switch())
        note = self.record_dir / "OPERATOR-RESOLUTION.md"
        for contents in ("Resolution for controller-foreign.json: done.\n",
                         path.name + "\n"):
            note.write_text(contents)
            with self.assertRaisesRegex(dc.Refused, "unfinished unit switch"):
                dc.switch_unit(self.effects, Adapter("python"), "crq-slot.service",
                               "node:" + "b" * 40)

    def test_historical_checkout_recovery_without_identity_refuses_untouched(self):
        path = self.effects.journal_append({"schema_version": dc.JOURNAL_SCHEMA,
                                            "operation": "recovery_required",
                                            "outcome": "recovery_required"})
        original = path.read_bytes()
        note = self.record_dir / "OPERATOR-RESOLUTION.md"
        note.write_text("Legacy operator resolution: no deployment change was made.\n")
        note_before = note.read_bytes()
        adapter = Adapter("python")
        with self.assertRaisesRegex(dc.Refused, "unsupported legacy checkout recovery"):
            dc.switch_unit(self.effects, adapter, "crq-tick.service", "node:" + "a" * 40)
        self.assertTrue(adapter.running)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(note.read_bytes(), note_before)

    def test_unit_recovery_refuses_other_checkout_history_without_interpreting_it(self):
        class Crash(BaseException):
            pass

        class InterruptedAdapter(Adapter):
            def install(self, unit, runtime):
                raise Crash()

        with self.assertRaises(Crash):
            dc.switch_unit(self.effects, InterruptedAdapter("python"), "crq-tick.service",
                           "node:" + "a" * 40)
        path = next(self.record_dir.glob("controller-*.json"))
        retained = self.effects.journal_append(pending_checkout("rollback_pending"))
        retained_before = retained.read_bytes()
        adapter = Adapter("python")
        with self.assertRaisesRegex(dc.Refused, "unfinished checkout switch"):
            dc.recover_unit(self.effects, adapter, path)
        self.assertTrue(adapter.running)
        self.assertEqual(retained.read_bytes(), retained_before)
        retained.unlink()
        self.assertEqual(dc.recover_unit(self.effects, adapter, path)["outcome"],
                         "rolled_back")
        self.assertTrue(adapter.running)

    def test_crash_during_initial_drain_recovers_without_stale_baseline(self):
        class Crash(BaseException):
            pass

        class CrashingAdapter(Adapter):
            def stop_and_drain(self, unit):
                raise Crash()

        with self.assertRaises(Crash):
            dc.switch_unit(self.effects, CrashingAdapter("python"), "crq-tick.service",
                           "node:" + "a" * 40)
        path = next(self.record_dir.glob("controller-*.json"))
        record = json.loads(path.read_text())
        self.assertEqual(record["phase"], "snapshot")
        self.assertIsNone(record["state"])
        self.write_state("queue.json", {"version": "during-drain"})
        adapter = Adapter("python")
        self.assertEqual(dc.recover_unit(self.effects, adapter, path)["outcome"], "rolled_back")

    def test_invalid_snapshot_refuses_before_fence(self):
        class InvalidAdapter(Adapter):
            def snapshot(self, unit):
                return {"path": "../../elsewhere"}

        adapter = InvalidAdapter("python")
        with self.assertRaisesRegex(dc.Refused, "invalid snapshot"):
            dc.switch_unit(self.effects, adapter, "crq-tick.service", "node:" + "a" * 40)
        self.assertTrue(adapter.running)
        self.assertEqual(list(self.record_dir.iterdir()), [])

    def test_interrupted_switch_can_be_recovered_from_retained_record(self):
        class Crash(BaseException):
            pass

        class InterruptedAdapter(Adapter):
            def install(self, unit, runtime):
                super().install(unit, runtime)
                raise Crash()

        adapter = InterruptedAdapter("python")
        with self.assertRaises(Crash):
            dc.switch_unit(self.effects, adapter, "crq-tick.service", "node:" + "a" * 40)
        path = next(self.record_dir.glob("controller-*.json"))
        self.assertEqual(json.loads(path.read_text())["outcome"], "pending")
        with self.assertRaisesRegex(dc.Refused, "unfinished unit switch"):
            dc.switch_unit(self.effects, Adapter("python"), "crq-slot.service",
                           "node:" + "b" * 40)
        # A new adapter has no in-memory snapshot from the interrupted call.
        restarted = Adapter(adapter.runtime)
        restarted.running = adapter.running
        record = dc.recover_unit(self.effects, restarted, path)
        self.assertEqual(record["outcome"], "rolled_back")
        self.assertEqual(restarted.runtime, "python")
        self.assertTrue(restarted.running)
        with self.assertRaises(dc.Refused):
            dc.recover_unit(self.effects, restarted, path)

    def test_both_runtime_directions(self):
        node = "node:" + "a" * 40
        adapter = Adapter("python")
        for target in (node, "python"):
            result = dc.switch_unit(self.effects, adapter, "crq-tick.service", target)
            self.assertEqual(result["outcome"], "completed")
            self.assertEqual(adapter.runtime, target)
            self.assertTrue(adapter.running)
            self.assertLess(result["completions"][0]["sequence"],
                            result["completions"][1]["sequence"])

    def test_wrong_binding_rolls_back_after_a_demonstrated_fence(self):
        adapter = Adapter("python")
        adapter.bad_evidence = True
        with self.assertRaises(dc.RecoveryRequired) as error:
            dc.switch_unit(self.effects, adapter, "crq-tick.service", "node:" + "a" * 40)
        recovery = error.exception.recovery
        self.assertEqual(recovery["outcome"], "rolled_back")
        self.assertEqual(recovery["failed_phase"], "activation_pending")
        self.assertIn("non-advancing unit completion evidence",
                      recovery["reason"])
        self.assertEqual(adapter.runtime, "python")
        self.assertTrue(adapter.running)

    def test_missing_provider_refuses_before_mutation(self):
        with self.assertRaisesRegex(dc.Refused, "no runtime-bound"):
            dc.switch_unit(self.effects, None, "crq-tick.service", "node:" + "a" * 40)
        self.assertEqual(list(self.record_dir.iterdir()), [])

    def test_switch_refuses_live_queue_before_adapter_or_journal(self):
        run_id = "a" * 32
        item = {"id": "pr1", "state": "reviewing",
                "run": {"run_id": run_id, "pid": 4242}}
        self.write_state("queue.json", {"items": [item]})
        queue_before = (self.runner / "state/queue.json").read_bytes()
        adapter = Adapter("python")
        calls = []

        def preflight(*args):
            calls.append("preflight")
            return {"runtime": "python"}

        with mock.patch.object(dc, "_runner_liveness",
                               return_value=lambda *args: "alive"), \
                mock.patch.object(adapter, "preflight", side_effect=preflight):
            with self.assertRaises(dc.QueueDrainRefused) as error:
                dc.switch_unit(self.effects, adapter, "crq-tick.service",
                               "node:" + "b" * 40)
        self.assertEqual(error.exception.drain, {
            "drained": False,
            "blocked": [{"item": "pr1", "state": "alive", "run": run_id}]})
        self.assertEqual(calls, [])
        self.assertTrue(adapter.running)
        self.assertEqual((self.runner / "state/queue.json").read_bytes(),
                         queue_before)
        self.assertEqual(list(self.record_dir.glob("controller-*.json")), [])

    def test_queue_ownership_classification_is_watchdog_only(self):
        self.assertFalse(dc.unit_issues_queue_work("crq-watchdog.service"))
        for unit in dc.UNIT_RUNTIMES - {"crq-watchdog.service"}:
            with self.subTest(unit=unit):
                self.assertTrue(dc.unit_issues_queue_work(unit))
        self.assertEqual(dc.preserved_surfaces("crq-watchdog.service"), ())
        self.assertEqual(dc.preserved_surfaces("crq-tick.service"),
                         ("heartbeat.json", "queue.json"))

    def test_watchdog_switch_is_admitted_while_unrelated_work_is_live(self):
        run_id = "9" * 32
        self.write_state("queue.json", {"items": [
            {"id": "pr-live", "run": {"run_id": run_id, "pid": 4242}}]})
        queue_before = (self.runner / "state/queue.json").read_bytes()

        class AdvancingAdapter(Adapter):
            def install(self, unit, runtime):
                # An unrelated live child harvests legitimate progress while
                # the watchdog transaction is in flight.
                fixture.write_state("queue.json", {
                    "items": [{"id": "pr-live", "state": "done"}],
                    "starts": ["progress"]})
                super().install(unit, runtime)

        fixture = self
        probe = mock.Mock(side_effect=AssertionError(
            "the watchdog queue gate must not observe unrelated work"))
        with mock.patch.object(dc, "_runner_liveness", probe):
            record = dc.switch_unit(
                self.effects, AdvancingAdapter("python"),
                "crq-watchdog.service", "node:" + "a" * 40)
        probe.assert_not_called()
        self.assertEqual(record["outcome"], "completed")
        self.assertEqual(record["unit"], "crq-watchdog.service")
        self.assertNotIn("preserved/queue.json", record["state"])
        self.assertNotIn("preserved/heartbeat.json", record["state"])
        self.assertNotEqual((self.runner / "state/queue.json").read_bytes(),
                            queue_before)
        # Progress is retained, never rolled back from a stale snapshot.
        self.assertEqual(json.loads((self.runner
                                     / "state/queue.json").read_text())["starts"],
                         ["progress"])

    def test_watchdog_reverse_switch_retains_concurrent_queue_progress(self):
        node = "node:" + "a" * 40
        records = []
        for prior, requested in (("python", node), (node, "python")):
            with self.subTest(requested=requested):
                adapter = Adapter(prior)

                def advance(unit, runtime, number=len(records) + 1):
                    self.write_state("queue.json", {
                        "items": [], "progress": number})
                    Adapter.install(adapter, unit, runtime)

                adapter.install = advance
                records.append(dc.switch_unit(
                    self.effects, adapter, "crq-watchdog.service", requested))
        self.assertEqual([record["outcome"] for record in records],
                         ["completed", "completed"])
        self.assertEqual(json.loads((self.runner
                                     / "state/queue.json").read_text()),
                         {"items": [], "progress": 2})

    def test_watchdog_own_failure_rolls_back_without_queue_equality(self):
        node = "node:" + "a" * 40

        class FailingAdapter(Adapter):
            def install(self, unit, runtime):
                fixture.write_state("queue.json", {
                    "items": [], "progress": "concurrent"})
                raise RuntimeError("watchdog install failed")

        fixture = self
        with self.assertRaises(dc.RecoveryRequired) as failure:
            dc.switch_unit(self.effects, FailingAdapter("python"),
                           "crq-watchdog.service", node)
        recovery = failure.exception.recovery
        self.assertEqual(recovery["outcome"], "rolled_back")
        self.assertIn("watchdog install failed", recovery["reason"])
        self.assertEqual(json.loads((self.runner
                                     / "state/queue.json").read_text()),
                         {"items": [], "progress": "concurrent"})
        path = next(self.record_dir.glob("controller-*.json"))
        self.assertEqual(json.loads(path.read_text())["outcome"],
                         "rolled_back")

    def test_switch_refuses_ambiguous_queue_before_mutation(self):
        run_id = "b" * 32
        self.write_state("queue.json", {"items": [
            {"id": "pr2", "run": {"run_id": run_id}}]})
        adapter = Adapter("python")
        with mock.patch.object(dc, "_runner_liveness",
                               return_value=lambda *args: "ambiguous"):
            with self.assertRaises(dc.QueueDrainRefused) as error:
                dc.switch_unit(self.effects, adapter, "crq-tick.service",
                               "node:" + "b" * 40)
        self.assertEqual(error.exception.drain["blocked"], [
            {"item": "pr2", "state": "ambiguous", "run": run_id}])
        self.assertEqual(list(self.record_dir.glob("controller-*.json")), [])

    def test_unreadable_queue_refuses_before_adapter(self):
        (self.runner / "state/queue.json").write_text("not json\n")
        adapter = Adapter("python")
        with self.assertRaisesRegex(dc.Refused, "queue unreadable"):
            dc.switch_unit(self.effects, adapter, "crq-tick.service",
                           "node:" + "b" * 40)
        self.assertEqual(list(self.record_dir.glob("controller-*.json")), [])

    def test_recovery_independently_refuses_live_owned_work(self):
        record = {
            "schema_version": dc.JOURNAL_SCHEMA,
            "transaction_id": "c" * 32,
            "operation": "unit_switch",
            "unit": "crq-tick.service",
            "runtime": "node:" + "b" * 40,
            "prior_runtime": "python",
            "outcome": "pending",
            "at": "2026-01-01T00:00:00Z",
            "snapshot": {"runtime": "python", "running": True},
            "state": None,
            "phase": "snapshot",
        }
        path = self.effects.journal_append(record)
        before = path.read_bytes()
        run_id = "d" * 32
        self.write_state("queue.json", {"items": [
            {"id": "pr3", "run": {"run_id": run_id, "pid": 5252}}]})
        adapter = Adapter("python")
        with mock.patch.object(dc, "_runner_liveness",
                               return_value=lambda *args: "alive"):
            with self.assertRaises(dc.QueueDrainRefused) as error:
                dc.recover_unit(self.effects, adapter, path)
        self.assertEqual(error.exception.drain["blocked"], [
            {"item": "pr3", "state": "alive", "run": run_id}])
        self.assertEqual(path.read_bytes(), before)
        self.assertTrue(adapter.running)

    def test_watchdog_recovery_skips_an_unrelated_live_queue(self):
        record = {
            "schema_version": dc.JOURNAL_SCHEMA,
            "transaction_id": "e" * 32,
            "operation": "unit_switch",
            "unit": "crq-watchdog.service",
            "runtime": "node:" + "b" * 40,
            "prior_runtime": "python",
            "outcome": "pending",
            "at": "2026-11-12T00:00:00Z",
            "snapshot": {"runtime": "python", "running": True},
            "state": dc.captured_state(self.effects, "crq-watchdog.service"),
            "phase": "drained",
        }
        self.assertNotIn("preserved/queue.json", record["state"])
        path = self.effects.journal_append(record)
        self.write_state("queue.json", {"items": [
            {"id": "pr-unrelated",
             "run": {"run_id": "f" * 32, "pid": 6100}}]})
        queue_before = (self.runner / "state/queue.json").read_bytes()
        probe = mock.Mock(side_effect=AssertionError(
            "watchdog recovery must not observe unrelated work"))
        adapter = Adapter("python")
        with mock.patch.object(dc, "_runner_liveness", probe):
            completed = dc.recover_unit(self.effects, adapter, path)
        probe.assert_not_called()
        self.assertEqual(completed["outcome"], "rolled_back")
        self.assertEqual((self.runner / "state/queue.json").read_bytes(),
                         queue_before)

    def test_recovery_failure_keeps_pending_record_and_reports_recovery(self):
        class Crash(BaseException):
            pass

        class InterruptedAdapter(Adapter):
            def install(self, unit, runtime):
                raise Crash()

        adapter = InterruptedAdapter("python")
        with self.assertRaises(Crash):
            dc.switch_unit(self.effects, adapter, "crq-tick.service", "node:" + "a" * 40)
        path = next(self.record_dir.glob("controller-*.json"))

        class BrokenRecovery(Adapter):
            def stop_and_drain(self, unit):
                raise RuntimeError("drain failed")

        with self.assertRaises(dc.RecoveryRequired) as failure:
            dc.recover_unit(self.effects, BrokenRecovery("python"), path)
        self.assertEqual(failure.exception.recovery["record_path"], str(path))
        self.assertEqual(json.loads(path.read_text())["outcome"], "pending")

    def test_recovery_refuses_incomplete_preservation_evidence_before_mutation(self):
        class Crash(BaseException):
            pass

        class InterruptedAdapter(Adapter):
            def install(self, unit, runtime):
                raise Crash()

        with self.assertRaises(Crash):
            dc.switch_unit(self.effects, InterruptedAdapter("python"), "crq-tick.service",
                           "node:" + "a" * 40)
        path = next(self.record_dir.glob("controller-*.json"))
        record = json.loads(path.read_text())
        del record["state"]["preserved/heartbeat.json"]
        path.write_text(json.dumps(record))
        adapter = Adapter("node:" + "a" * 40)
        with self.assertRaisesRegex(dc.Refused, "invalid unit recovery record"):
            dc.recover_unit(self.effects, adapter, path)
        self.assertTrue(adapter.running)
        self.assertEqual(adapter.runtime, "node:" + "a" * 40)
        record["state"]["preserved/heartbeat.json"] = None
        record["snapshot"] = {"runtime": "python", "path": "../../elsewhere"}
        path.write_text(json.dumps(record))
        with self.assertRaisesRegex(dc.Refused, "invalid snapshot"):
            dc.recover_unit(self.effects, adapter, path)
        self.assertTrue(adapter.running)
        record["outcome"] = ["unexpected"]
        path.write_text(json.dumps(record))
        with self.assertRaisesRegex(dc.Refused, "invalid unit switch outcome"):
            dc.switch_unit(self.effects, Adapter("python"), "crq-slot.service",
                           "node:" + "b" * 40)


class RecoverFactoryTests(ControllerFixture):
    """Recovery composition comes from the one record the controller validated.

    The controller keeps sole ownership of the lock, record validation, the
    unfinished-transaction guard, the drain gate, restoration order and journal
    writes. ``adapter_factory`` is a composition callback invoked under that
    lock with the record's own unit and prior runtime, before any snapshot
    validation or unit mutation.
    """

    def setUp(self):
        super().setUp()
        self.write_state("queue.json", {"items": [], "starts": []})
        self.write_state("heartbeat.json",
                         {"last_tick": "2026-01-01T00:00:00Z"})

    def pending_record(self, **overrides):
        record = {
            "schema_version": dc.JOURNAL_SCHEMA,
            "transaction_id": "c" * 32,
            "operation": "unit_switch",
            "unit": "crq-slot.service",
            "runtime": "node:" + "b" * 40,
            "prior_runtime": "python",
            "outcome": "pending",
            "at": "2026-11-12T00:00:00Z",
            "snapshot": {"runtime": "python", "running": True},
            "state": dc.captured_state(self.effects),
            "phase": "drained",
        }
        record.update(overrides)
        return self.effects.journal_append(record)

    def refusing_factory(self):
        return mock.Mock(
            side_effect=AssertionError("recover constructed an adapter"))

    def run_recover_cli(self, record, loader):
        stdout = io.StringIO()
        stderr = io.StringIO()
        argv = ["--root", str(self.root), "--overlay", str(self.overlay_path),
                "--record-dir", str(self.record_dir),
                "recover", "--record", str(record)]
        with mock.patch.object(dc, "_load_live_binding", loader), \
                contextlib.redirect_stdout(stdout), \
                contextlib.redirect_stderr(stderr):
            code = dc.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_recover_composes_the_adapter_from_the_validated_record(self):
        events = []
        calls = []
        path = self.pending_record()

        class RecordingAdapter(Adapter):
            def validate_snapshot(self, unit, snapshot):
                events.append("validate_snapshot")
                super().validate_snapshot(unit, snapshot)

        def factory(unit, prior_runtime):
            events.append("factory")
            calls.append((unit, prior_runtime))
            self.assertNotIn("validate_snapshot", events)
            return RecordingAdapter(prior_runtime)

        record = dc.recover_unit(self.effects, None, path,
                                 adapter_factory=factory)
        self.assertEqual(calls, [("crq-slot.service", "python")])
        self.assertEqual(events, ["factory", "validate_snapshot"])
        self.assertEqual(record["outcome"], "rolled_back")

    def test_recover_composition_does_not_require_the_abandoned_target(self):
        path = self.pending_record(runtime="node:" + "d" * 40)
        calls = []
        adapters = []

        def factory(unit, prior_runtime):
            calls.append((unit, prior_runtime))
            adapter = Adapter(prior_runtime)
            adapters.append(adapter)
            return adapter

        record = dc.recover_unit(self.effects, None, path,
                                 adapter_factory=factory)
        self.assertEqual(calls, [("crq-slot.service", "python")])
        self.assertEqual(adapters[0].runtime, "python")
        self.assertTrue(adapters[0].running)
        self.assertEqual(record["outcome"], "rolled_back")

    def test_recover_rejects_an_incoherent_snapshot_runtime(self):
        path = self.pending_record(
            snapshot={"runtime": "node:" + "e" * 40, "running": True})
        before = path.read_bytes()
        factory = self.refusing_factory()
        with self.assertRaisesRegex(dc.Refused, "invalid unit recovery record"):
            dc.recover_unit(self.effects, None, path, adapter_factory=factory)
        factory.assert_not_called()
        self.assertEqual(path.read_bytes(), before)

    def test_recover_factory_runs_under_the_controller_lock(self):
        path = self.pending_record()
        lock = self.runner / "state" / dc.LOCK_NAME
        observed = []

        def factory(unit, prior_runtime):
            descriptor = os.open(lock, os.O_RDONLY)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                observed.append("blocked")
            finally:
                os.close(descriptor)
            return Adapter(prior_runtime)

        record = dc.recover_unit(self.effects, None, path,
                                 adapter_factory=factory)
        self.assertEqual(observed, ["blocked"])
        self.assertEqual(record["outcome"], "rolled_back")

    def test_recover_factory_is_not_called_for_an_invalid_record(self):
        factory = self.refusing_factory()
        malformed = self.record_dir / "controller-malformed.json"
        malformed.write_text("not json\n")
        before = malformed.read_bytes()
        with self.assertRaisesRegex(dc.Refused,
                                    "unreadable unit recovery record"):
            dc.recover_unit(self.effects, None, malformed,
                            adapter_factory=factory)
        self.assertEqual(malformed.read_bytes(), before)
        malformed.unlink()

        wrong_schema = self.pending_record(schema_version=99)
        before = wrong_schema.read_bytes()
        with self.assertRaisesRegex(dc.Refused, "invalid unit recovery record"):
            dc.recover_unit(self.effects, None, wrong_schema,
                            adapter_factory=factory)
        self.assertEqual(wrong_schema.read_bytes(), before)
        wrong_schema.unlink()

        path = self.pending_record()
        legacy = self.effects.journal_append({
            "schema_version": dc.JOURNAL_SCHEMA,
            "operation": "recovery_required",
            "outcome": "recovery_required"})
        before = legacy.read_bytes()
        with self.assertRaisesRegex(
                dc.Refused, "unsupported legacy checkout recovery record"):
            dc.recover_unit(self.effects, None, path,
                            adapter_factory=factory)
        factory.assert_not_called()
        self.assertEqual(legacy.read_bytes(), before)

    def test_recover_factory_is_not_called_when_another_record_blocks(self):
        factory = self.refusing_factory()
        path = self.pending_record()
        unit_original = path.read_bytes()
        other = self.effects.journal_append(pending_unit_switch())
        other_original = other.read_bytes()
        with self.assertRaisesRegex(dc.Refused, "unfinished unit switch"):
            dc.recover_unit(self.effects, None, path, adapter_factory=factory)
        self.assertEqual(path.read_bytes(), unit_original)
        self.assertEqual(other.read_bytes(), other_original)
        other.unlink()

        checkout = self.effects.journal_append(
            pending_checkout("deploy_pending"))
        checkout_original = checkout.read_bytes()
        with self.assertRaisesRegex(dc.Refused, "unfinished checkout switch"):
            dc.recover_unit(self.effects, None, path, adapter_factory=factory)
        factory.assert_not_called()
        self.assertEqual(path.read_bytes(), unit_original)
        self.assertEqual(checkout.read_bytes(), checkout_original)

    def test_recover_factory_is_not_called_when_the_queue_is_live(self):
        for state, transaction in (("alive", "d"), ("ambiguous", "e")):
            with self.subTest(state=state):
                path = self.pending_record(transaction_id=transaction * 32)
                before = path.read_bytes()
                self.write_state("queue.json", {"items": [
                    {"id": "pr9",
                     "run": {"run_id": "f" * 32, "pid": 6100}}]})
                factory = self.refusing_factory()
                with mock.patch.object(
                        dc, "_runner_liveness",
                        return_value=lambda *args: state):
                    with self.assertRaises(dc.QueueDrainRefused):
                        dc.recover_unit(self.effects, None, path,
                                        adapter_factory=factory)
                factory.assert_not_called()
                self.assertEqual(path.read_bytes(), before)
                path.unlink()

    def test_recover_factory_error_is_a_refusal(self):
        path = self.pending_record()
        before = path.read_bytes()
        for name in ("LiveBindingRefused", "FactoryRefused", "CompletionError"):
            with self.subTest(error=name):
                error = type(name, (RuntimeError,), {})
                binding = SimpleNamespace(
                    LiveBindingRefused=error,
                    factory=SimpleNamespace(FactoryRefused=error),
                    completion=SimpleNamespace(CompletionError=error),
                    production_adapter=mock.Mock(
                        side_effect=error("compose failed")))
                code, stdout, stderr = self.run_recover_cli(
                    path, mock.Mock(return_value=binding))
                self.assertEqual(code, 2)
                artifact = json.loads(stdout)["error"]
                self.assertEqual(artifact["kind"], "refused")
                self.assertEqual(artifact["subcommand"], "recover")
                self.assertIn("compose failed", artifact["message"])
                self.assertIn("refused:", stderr)
                self.assertEqual(path.read_bytes(), before)

    def test_recover_factory_path_rolls_back_a_demonstrably_fenced_activation(self):
        path = self.pending_record(phase="activation_pending")

        class OwnedWorkAdapter(Adapter):
            def __init__(self):
                super().__init__("python")
                self.owned = ["work-launched-after-activation"]
                self.drains = 0

            def stop_and_drain(self, unit):
                self.drains += 1
                self.owned.clear()
                super().stop_and_drain(unit)

        adapters = []

        def factory(unit, prior_runtime):
            adapter = OwnedWorkAdapter()
            adapters.append(adapter)
            return adapter

        recovered = dc.recover_unit(self.effects, None, path,
                                    adapter_factory=factory)
        self.assertEqual(len(adapters), 1)
        self.assertEqual(adapters[0].drains, 1)
        self.assertEqual(adapters[0].owned, [])
        self.assertEqual(recovered["outcome"], "rolled_back")
        self.assertEqual(recovered["failed_phase"], "activation_pending")
        final = json.loads(path.read_text())
        self.assertEqual(final["phase"], "restore_activation_pending")
        self.assertEqual(final["outcome"], "rolled_back")
        self.assertEqual(final["failed_phase"], "activation_pending")
        self.assertIsNone(final["fence"])

    def test_recover_factory_path_refuses_when_the_fence_cannot_be_demonstrated(self):
        path = self.pending_record(phase="activation_pending")
        before = path.read_bytes()

        class UndrainedAdapter(Adapter):
            def __init__(self):
                super().__init__("python")
                self.drains = 0
                self.restores = 0

            def stop_and_drain(self, unit):
                self.drains += 1
                raise RuntimeError("owned process remains")

            def restore(self, unit, snapshot):
                self.restores += 1
                super().restore(unit, snapshot)

        adapters = []

        def factory(unit, prior_runtime):
            adapter = UndrainedAdapter()
            adapters.append(adapter)
            return adapter

        with self.assertRaises(dc.RecoveryRequired) as failure:
            dc.recover_unit(self.effects, None, path, adapter_factory=factory)
        self.assertIn("owned process remains", str(failure.exception))
        self.assertEqual(len(adapters), 1)
        self.assertEqual(adapters[0].drains, 1)
        self.assertEqual(adapters[0].restores, 0)
        self.assertEqual(path.read_bytes(), before)


class ControllerLockModeTests(ControllerFixture):
    """The controller lock's mode never depends on the ambient umask."""

    def lock_path(self):
        return self.runner / "state" / dc.LOCK_NAME

    @staticmethod
    def mode_of(path):
        return path.stat().st_mode & 0o777

    def test_lock_is_created_0600_under_a_permissive_umask(self):
        path = self.lock_path()
        self.assertFalse(path.exists())
        previous = os.umask(0o002)
        try:
            with self.effects.controller_lock():
                self.assertEqual(self.mode_of(path), 0o600)
        finally:
            os.umask(previous)
        # The guest proof saw an 0664 lock from exactly this umask.
        self.assertEqual(self.mode_of(path), 0o600)

    def test_a_preexisting_group_readable_lock_is_normalised_to_0600(self):
        path = self.lock_path()
        path.parent.mkdir(parents=True)
        path.write_text("")
        path.chmod(0o664)
        with self.effects.controller_lock():
            self.assertEqual(self.mode_of(path), 0o600)
        self.assertEqual(self.mode_of(path), 0o600)

    def test_a_second_acquisition_is_refused_with_the_busy_lock_text(self):
        with self.effects.controller_lock():
            with self.assertRaisesRegex(dc.Refused, "controller lock busy"):
                with self.effects.controller_lock():
                    self.fail("a second acquisition must be refused")

    def test_context_manager_contract_is_unchanged(self):
        path = self.lock_path()
        path.parent.mkdir(parents=True)
        path.write_text("retained\n")
        path.chmod(0o600)
        with self.assertRaises(RuntimeError):
            with self.effects.controller_lock():
                descriptor = os.open(path, os.O_RDONLY)
                try:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(descriptor)
                raise RuntimeError("block failed")
        descriptor = os.open(path, os.O_RDONLY)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(descriptor)
        self.assertEqual(path.read_text(), "retained\n")
        self.assertEqual(self.mode_of(path), 0o600)
