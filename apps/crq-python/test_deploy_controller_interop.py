"""Checkout/unit journal interoperability: one symmetric unfinished guard.

All host operations are controlled fakes; the controller is the real module.
The records here reproduce the shapes the current producer writes and the
representative shapes earlier producer versions wrote. Pre-existing record
bytes must never change.
"""
import json
import uuid

from test_deploy_controller_fixtures import DeployPlanFixture, dc
from test_deploy_controller_unit_switch import Adapter

NODE = "node:" + "b" * 40


class Crash(BaseException):
    pass


class InterruptedAdapter(Adapter):
    def install(self, unit, runtime):
        raise Crash()


class TrackingAdapter(Adapter):
    def __init__(self, runtime):
        super().__init__(runtime)
        self.calls = []

    def stop_and_drain(self, unit):
        self.calls.append("stop_and_drain")
        super().stop_and_drain(unit)


def record_path(record_dir):
    return record_dir / ("controller-" + uuid.uuid4().hex + ".json")


class InteropTests(DeployPlanFixture):
    def pending(self, operation):
        return self.effects.journal_append({
            "schema_version": dc.JOURNAL_SCHEMA,
            "transaction_id": uuid.uuid4().hex,
            "operation": operation,
            "outcome": "pending",
            "at": "2026-10-27T00:00:00Z",
        })

    def recovery(self, state):
        return self.effects.journal_append({
            "schema_version": dc.JOURNAL_SCHEMA,
            "transaction_id": uuid.uuid4().hex,
            "operation": "recovery_required",
            "outcome": "recovery_required",
            "intended_operation": "deploy",
            "at": "2026-10-27T00:00:00Z",
            "prior_state": state,
            "prior_head": state["prior_head"],
            "prior_config_sha256": state["prior_config_sha256"],
            "prior_tag": None,
            "target": self.target,
            "tag": self.tag,
            "helper_sha256": "ab" * 32,
            "automatic_rollback_permitted": False,
            "rollback_compatibility": {},
            "failed_phase": "helper",
            "reason": "ValueError: pre-refused_no_change helper failure",
            "record_path": "",
            "record_persisted": True,
        })

    def test_pending_checkout_intents_block_unit_switch_before_adapter(self):
        for operation in ("deploy_pending", "rollback_pending"):
            with self.subTest(operation=operation):
                path = self.pending(operation)
                original = path.read_bytes()
                adapter = TrackingAdapter("python")
                with self.assertRaisesRegex(dc.Refused, "unfinished checkout switch"):
                    dc.switch_unit(self.effects, adapter, "crq-tick.service", NODE)
                self.assertEqual(adapter.calls, [])
                self.assertTrue(adapter.running)
                self.assertEqual(path.read_bytes(), original)
                path.unlink()

    def test_pending_checkout_intents_block_deploy_and_rollback(self):
        for operation in ("deploy_pending", "rollback_pending"):
            with self.subTest(operation=operation):
                path = self.pending(operation)
                original = path.read_bytes()
                with self.assertRaisesRegex(dc.Refused, "unfinished checkout switch"):
                    dc.deploy_plan(self.effects, None, "", "", self.overlay_path)
                with self.assertRaisesRegex(dc.Refused, "unfinished checkout switch"):
                    dc.rollback_plan(self.effects, None, {}, self.overlay_path)
                self.assertEqual(path.read_bytes(), original)
                path.unlink()

    def test_unresolved_checkout_recovery_blocks_unit_switch(self):
        state = dc.captured_state(self.effects)
        path = self.recovery(state)
        self.write_state("queue.json", {"items": [], "starts": [], "changed": True})
        original = path.read_bytes()
        adapter = TrackingAdapter("python")
        with self.assertRaisesRegex(dc.Refused, "unresolved checkout recovery"):
            dc.switch_unit(self.effects, adapter, "crq-tick.service", NODE)
        self.assertEqual(adapter.calls, [])
        self.assertEqual(path.read_bytes(), original)

    def test_unresolved_checkout_recovery_blocks_deploy_and_rollback(self):
        state = dc.captured_state(self.effects)
        self.recovery(state)
        self.write_state("queue.json", {"items": [], "starts": [], "changed": True})
        with self.assertRaisesRegex(dc.Refused, "unresolved checkout recovery"):
            dc.deploy_plan(self.effects, None, "", "", self.overlay_path)
        with self.assertRaisesRegex(dc.Refused, "unresolved checkout recovery"):
            dc.rollback_plan(self.effects, None, {}, self.overlay_path)

    def test_verifiably_unchanged_recovery_is_history_not_a_blocker(self):
        state = dc.captured_state(self.effects)
        path = self.recovery(state)
        original = path.read_bytes()
        note = self.record_dir / "OPERATOR-RESOLUTION.md"
        note.write_text("Operator prose that the controller must not consume.\n")
        note_before = note.read_bytes()
        adapter = Adapter("python")
        result = dc.switch_unit(self.effects, adapter, "crq-tick.service", NODE)
        self.assertEqual(result["outcome"], "completed")
        self.assertTrue(adapter.running)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(note.read_bytes(), note_before)

    def test_legacy_recovery_without_identity_refuses_and_keeps_bytes(self):
        path = self.effects.journal_append({
            "schema_version": dc.JOURNAL_SCHEMA,
            "operation": "recovery_required",
            "outcome": "recovery_required",
        })
        original = path.read_bytes()
        note = self.record_dir / "OPERATOR-RESOLUTION.md"
        note.write_text("Legacy operator resolution: no deployment change was made.\n")
        note_before = note.read_bytes()
        adapter = TrackingAdapter("python")
        with self.assertRaisesRegex(dc.Refused, "unsupported legacy checkout recovery"):
            dc.switch_unit(self.effects, adapter, "crq-tick.service", NODE)
        self.assertEqual(adapter.calls, [])
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(note.read_bytes(), note_before)

    def test_completed_and_refused_history_does_not_block(self):
        entries = [
            # Initial producer: completed checkout journals had no outcome.
            {"schema_version": 1, "operation": "deploy",
             "at": "2026-10-27T00:00:00Z", "plan": {}},
            {"schema_version": 1, "operation": "rollback",
             "at": "2026-10-27T00:00:00Z", "to": "a" * 40,
             "tag": "crq-runner/20261027-1"},
            # Current producer: completed and refused outcomes.
            {"schema_version": 1, "operation": "deploy", "outcome": "completed",
             "at": "2026-10-27T00:00:00Z", "plan": {}},
            {"schema_version": 1, "operation": "deploy_refused",
             "outcome": "refused_no_change", "at": "2026-10-27T00:00:00Z"},
            {"schema_version": 1, "operation": "rollback_refused",
             "outcome": "refused_no_change", "at": "2026-10-27T00:00:00Z"},
        ]
        paths = [self.effects.journal_append(entry) for entry in entries]
        originals = {path: path.read_bytes() for path in paths}
        adapter = Adapter("python")
        result = dc.switch_unit(self.effects, adapter, "crq-tick.service", NODE)
        self.assertEqual(result["outcome"], "completed")
        for path, original in originals.items():
            self.assertEqual(path.read_bytes(), original)

    def test_completed_unit_history_does_not_block(self):
        for outcome in ("completed", "rolled_back"):
            with self.subTest(outcome=outcome):
                path = self.effects.journal_append({
                    "schema_version": 1, "operation": "unit_switch",
                    "outcome": outcome, "unit": "crq-tick.service",
                    "runtime": NODE, "prior_runtime": "python",
                    "at": "2026-10-27T00:00:00Z", "snapshot": {},
                    "state": None, "phase": "activation_pending",
                })
                original = path.read_bytes()
                adapter = Adapter("python")
                result = dc.switch_unit(self.effects, adapter,
                                        "crq-slot.service", NODE)
                self.assertEqual(result["outcome"], "completed")
                self.assertEqual(path.read_bytes(), original)
                path.unlink()

    def test_unit_recovery_excludes_its_own_intent_but_not_other_intents(self):
        with self.assertRaises(Crash):
            dc.switch_unit(self.effects, InterruptedAdapter("python"),
                           "crq-tick.service", NODE)
        path = next(self.record_dir.glob("controller-*.json"))
        unit_original = path.read_bytes()
        other = self.pending("deploy_pending")
        other_original = other.read_bytes()
        adapter = TrackingAdapter("python")
        with self.assertRaisesRegex(dc.Refused, "unfinished checkout switch"):
            dc.recover_unit(self.effects, adapter, path)
        self.assertEqual(adapter.calls, [])
        self.assertEqual(path.read_bytes(), unit_original)
        self.assertEqual(other.read_bytes(), other_original)
        other.unlink()
        self.assertEqual(
            dc.recover_unit(self.effects, adapter, path)["outcome"],
            "rolled_back")

    def test_unit_recovery_blocks_on_another_unit_intent(self):
        with self.assertRaises(Crash):
            dc.switch_unit(self.effects, InterruptedAdapter("python"),
                           "crq-tick.service", NODE)
        path = next(self.record_dir.glob("controller-*.json"))
        unit_original = path.read_bytes()
        other = self.effects.journal_append({
            "schema_version": 1, "operation": "unit_switch",
            "outcome": "pending", "unit": "crq-slot.service",
            "runtime": NODE, "prior_runtime": "python",
            "at": "2026-10-27T00:00:00Z", "snapshot": {},
            "state": None, "phase": "snapshot",
        })
        other_original = other.read_bytes()
        adapter = TrackingAdapter("python")
        with self.assertRaisesRegex(dc.Refused, "unfinished unit switch"):
            dc.recover_unit(self.effects, adapter, path)
        self.assertEqual(adapter.calls, [])
        self.assertEqual(path.read_bytes(), unit_original)
        self.assertEqual(other.read_bytes(), other_original)
        other.unlink()
        self.assertEqual(
            dc.recover_unit(self.effects, adapter, path)["outcome"],
            "rolled_back")

    def test_malformed_or_unknown_records_refuse_honestly(self):
        cases = [
            ("invalid-json", "not json\n"),
            ("list-root", "[]\n"),
            ("empty-object", "{}\n"),
            ("wrong-schema", json.dumps({"schema_version": 2,
                                         "operation": "deploy",
                                         "outcome": "completed"}) + "\n"),
            ("unknown-operation", json.dumps({
                "schema_version": 1, "operation": "mystery",
                "outcome": "completed"}) + "\n"),
            ("invalid-unit-outcome", json.dumps({
                "schema_version": 1, "operation": "unit_switch",
                "outcome": ["unexpected"]}) + "\n"),
            ("invalid-pending-outcome", json.dumps({
                "schema_version": 1, "operation": "deploy_pending",
                "outcome": "completed"}) + "\n"),
        ]
        for label, text in cases:
            with self.subTest(label=label):
                path = record_path(self.record_dir)
                path.write_text(text)
                adapter = TrackingAdapter("python")
                with self.assertRaises(dc.Refused):
                    dc.switch_unit(self.effects, adapter, "crq-tick.service", NODE)
                self.assertEqual(adapter.calls, [])
                path.unlink()

    def test_prepare_host_render_intent_records_are_not_transaction_intents(self):
        path = self.record_dir / (uuid.uuid4().hex + ".json")
        path.write_text(json.dumps({
            "schema_version": 1, "operation": "switch-before",
            "record_type": "render-intent", "at": "2026-10-27T00:00:00Z",
        }) + "\n")
        original = path.read_bytes()
        adapter = Adapter("python")
        result = dc.switch_unit(self.effects, adapter, "crq-tick.service", NODE)
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(path.read_bytes(), original)
