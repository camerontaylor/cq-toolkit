"""Per-unit transaction tests: all host operations are controlled fakes."""
import json

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

    def test_wrong_binding_restores_previous_runtime(self):
        adapter = Adapter("python")
        adapter.bad_evidence = True
        with self.assertRaises(dc.RecoveryRequired) as error:
            dc.switch_unit(self.effects, adapter, "crq-tick.service", "node:" + "a" * 40)
        self.assertEqual(error.exception.recovery["outcome"], "rolled_back")
        self.assertEqual(adapter.runtime, "python")
        self.assertTrue(adapter.running)

    def test_missing_provider_refuses_before_mutation(self):
        with self.assertRaisesRegex(dc.Refused, "no runtime-bound"):
            dc.switch_unit(self.effects, None, "crq-tick.service", "node:" + "a" * 40)
        self.assertEqual(list(self.record_dir.iterdir()), [])
