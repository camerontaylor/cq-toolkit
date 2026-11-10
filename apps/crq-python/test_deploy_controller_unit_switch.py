"""Per-unit transaction tests: all host operations are controlled fakes."""
import json
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
        return self.runtime, self.running

    def validate_snapshot(self, unit, snapshot):
        if (not isinstance(snapshot, (list, tuple)) or len(snapshot) != 2
                or not dc._unit_runtime(snapshot[0]) or type(snapshot[1]) is not bool):
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
        self.runtime = snapshot[0]

    def restore_activation(self, unit, snapshot):
        self.running = snapshot[1]


class UnitSwitchTests(ControllerFixture):
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

    def test_activation_crash_is_not_blindly_replayed(self):
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
        with self.assertRaises(dc.RecoveryRequired):
            dc.recover_unit(self.effects, adapter, path)
        self.assertEqual(adapter.runtime, "node:" + "a" * 40)
        self.assertFalse(adapter.running)
        self.assertEqual(json.loads(path.read_text())["phase"], "activation_pending")

    def test_ambiguous_activation_drains_owned_work_in_adapter_fake(self):
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
        with self.assertRaises(dc.RecoveryRequired):
            dc.recover_unit(self.effects, adapter, path)
        self.assertEqual(adapter.owned, [])
        self.assertEqual(adapter.unrelated, ["unrelated-session"])

    def test_crash_releasing_rollback_activation_is_not_replayed(self):
        class Crash(BaseException):
            pass

        class CrashingAdapter(Adapter):
            def install(self, unit, runtime):
                raise RuntimeError("install failed")

            def restore_activation(self, unit, snapshot):
                super().restore_activation(unit, snapshot)
                raise Crash()

        adapter = CrashingAdapter("python")
        with self.assertRaises(Crash):
            dc.switch_unit(self.effects, adapter, "crq-tick.service", "node:" + "a" * 40)
        path = next(self.record_dir.glob("controller-*.json"))
        self.assertEqual(json.loads(path.read_text())["phase"], "restore_activation_pending")
        with self.assertRaises(dc.RecoveryRequired):
            dc.recover_unit(self.effects, adapter, path)
        self.assertFalse(adapter.running)

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
        with self.assertRaises(dc.RecoveryRequired):
            dc.recover_unit(self.effects, adapter, path)

    def test_pending_unit_intent_blocks_deploy_and_rollback(self):
        self.effects.journal_append({"schema_version": dc.JOURNAL_SCHEMA,
                                     "operation": "unit_switch", "outcome": "pending"})
        with self.assertRaisesRegex(dc.Refused, "unfinished unit switch"):
            dc.deploy_plan(self.effects, None, "", "", self.overlay_path)
        with self.assertRaisesRegex(dc.Refused, "unfinished unit switch"):
            dc.rollback_plan(self.effects, None, {}, self.overlay_path)

    def test_resolution_prose_cannot_clear_pending_unit_intent(self):
        path = self.effects.journal_append({"schema_version": dc.JOURNAL_SCHEMA,
                                            "operation": "unit_switch",
                                            "outcome": "pending"})
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
        retained = self.effects.journal_append({"schema_version": dc.JOURNAL_SCHEMA,
                                                "operation": "rollback_pending",
                                                "outcome": "pending"})
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

    def test_wrong_binding_requires_inspection_after_activation(self):
        adapter = Adapter("python")
        adapter.bad_evidence = True
        with self.assertRaises(dc.RecoveryRequired) as error:
            dc.switch_unit(self.effects, adapter, "crq-tick.service", "node:" + "a" * 40)
        self.assertEqual(error.exception.recovery["outcome"], "recovery_required")
        self.assertEqual(adapter.runtime, "node:" + "a" * 40)
        self.assertFalse(adapter.running)

    def test_missing_provider_refuses_before_mutation(self):
        with self.assertRaisesRegex(dc.Refused, "no runtime-bound"):
            dc.switch_unit(self.effects, None, "crq-tick.service", "node:" + "a" * 40)
        self.assertEqual(list(self.record_dir.iterdir()), [])

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
        record["snapshot"] = {"path": "../../elsewhere"}
        path.write_text(json.dumps(record))
        with self.assertRaisesRegex(dc.Refused, "invalid snapshot"):
            dc.recover_unit(self.effects, adapter, path)
        self.assertTrue(adapter.running)
        record["outcome"] = ["unexpected"]
        path.write_text(json.dumps(record))
        with self.assertRaisesRegex(dc.Refused, "invalid unit switch outcome"):
            dc.switch_unit(self.effects, Adapter("python"), "crq-slot.service",
                           "node:" + "b" * 40)
