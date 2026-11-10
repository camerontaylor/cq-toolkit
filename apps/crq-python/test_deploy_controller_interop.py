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
    def checkout_identity(self, operation, *, state=None, **overrides):
        record = {
            "schema_version": dc.JOURNAL_SCHEMA,
            "transaction_id": uuid.uuid4().hex,
            "at": "2026-10-27T00:00:00Z",
            "intended_operation": ("rollback" if operation.startswith("rollback")
                                   else "deploy"),
            "prior_state": {} if state is None else state,
            "prior_head": "a" * 40,
            "prior_config_sha256": None,
            "prior_tag": None,
            "target": self.target,
            "tag": self.tag,
            "helper_sha256": "ab" * 32,
            "automatic_rollback_permitted": False,
            "rollback_compatibility": {},
        }
        record.update(overrides)
        return record

    def pending(self, operation):
        return self.effects.journal_append({
            **self.checkout_identity(operation),
            "operation": operation,
            "outcome": "pending",
        })

    def recovery(self, state):
        return self.effects.journal_append({
            **self.checkout_identity("recovery_required", state=state),
            "operation": "recovery_required",
            "outcome": "recovery_required",
            "failed_phase": "helper",
            "reason": "ValueError: pre-refused_no_change helper failure",
            "record_path": "",
            "record_persisted": True,
        })

    def refused(self, operation):
        return self.effects.journal_append({
            **self.checkout_identity(operation),
            "operation": operation,
            "outcome": "refused_no_change",
            "failed_phase": "helper",
            "reason": "no observable change",
            "observations": {},
            "record_path": "",
            "record_persisted": True,
        })

    def completed_deploy(self):
        return self.effects.journal_append({
            "schema_version": dc.JOURNAL_SCHEMA,
            "transaction_id": uuid.uuid4().hex,
            "operation": "deploy",
            "outcome": "completed",
            "at": "2026-10-27T00:00:00Z",
            "prior_head": "a" * 40,
            "prior_config_sha256": None,
            "prior_tag": None,
            "target": self.target,
            "tag": self.tag,
            "helper_sha256": "ab" * 32,
            "rollback_compatibility": {},
            "automatic_rollback_permitted": False,
            "plan": {"preflight": {}, "steps": []},
        })

    def completed_rollback(self):
        return self.effects.journal_append({
            "schema_version": dc.JOURNAL_SCHEMA,
            "transaction_id": uuid.uuid4().hex,
            "operation": "rollback",
            "outcome": "completed",
            "at": "2026-10-27T00:00:00Z",
            "to": "a" * 40,
            "tag": self.tag,
            "helper_sha256": "ab" * 32,
        })

    def completed_unit_switch(self, outcome):
        record = {
            "schema_version": dc.JOURNAL_SCHEMA,
            "transaction_id": uuid.uuid4().hex,
            "operation": "unit_switch",
            "outcome": outcome,
            "unit": "crq-tick.service",
            "runtime": NODE,
            "prior_runtime": "python",
            "at": "2026-10-27T00:00:00Z",
            "snapshot": {"proof": True},
            "state": {},
            "phase": "activation_pending",
        }
        if outcome == "completed":
            record["completions"] = [
                {"unit": "crq-tick.service", "runtime": NODE,
                 "success": True, "sequence": 1},
                {"unit": "crq-tick.service", "runtime": NODE,
                 "success": True, "sequence": 2},
            ]
        else:
            record["phase"] = "restore_activation_pending"
            record["reason"] = "restored prior activation"
        return record

    def pending_unit_switch(self):
        return self.effects.journal_append({
            "schema_version": dc.JOURNAL_SCHEMA,
            "transaction_id": uuid.uuid4().hex,
            "operation": "unit_switch",
            "outcome": "pending",
            "unit": "crq-slot.service",
            "runtime": NODE,
            "prior_runtime": "python",
            "at": "2026-10-27T00:00:00Z",
            "snapshot": {"proof": True},
            "state": None,
            "phase": "snapshot",
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

    def test_recovery_required_is_not_resolved_by_matching_digests(self):
        state = dc.captured_state(self.effects)
        path = self.recovery(state)
        original = path.read_bytes()
        note = self.record_dir / "OPERATOR-RESOLUTION.md"
        note.write_text("Operator prose that the controller must not consume.\n")
        note_before = note.read_bytes()
        # The stored digests still match, but that observation covers only file
        # bytes and link targets: it cannot prove unit metadata, activation or
        # live work survived the interruption, so it is not resolution.
        self.assertTrue(dc.no_change_observation(self.effects, state)["unchanged"])
        adapter = TrackingAdapter("python")
        with self.assertRaisesRegex(dc.Refused, "unresolved checkout recovery"):
            dc.switch_unit(self.effects, adapter, "crq-tick.service", NODE)
        self.assertEqual(adapter.calls, [])
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(note.read_bytes(), note_before)

    def test_recovery_classification_is_stable_across_unrelated_state(self):
        state = dc.captured_state(self.effects)
        path = self.recovery(state)
        original = path.read_bytes()
        with self.assertRaisesRegex(dc.Refused, "unresolved checkout recovery"):
            dc.refuse_unfinished_transactions(self.effects)
        self.write_state("queue.json", {"items": [], "starts": [], "changed": True})
        with self.assertRaisesRegex(dc.Refused, "unresolved checkout recovery"):
            dc.refuse_unfinished_transactions(self.effects)
        self.assertEqual(path.read_bytes(), original)

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
             "at": "2026-10-27T00:00:00Z",
             "plan": {"preflight": {}, "steps": []}},
            {"schema_version": 1, "operation": "rollback",
             "at": "2026-10-27T00:00:00Z", "to": "a" * 40,
             "tag": "crq-runner/20261027-1"},
        ]
        paths = [self.effects.journal_append(entry) for entry in entries]
        paths.append(self.completed_deploy())
        paths.append(self.completed_rollback())
        paths.append(self.refused("deploy_refused"))
        paths.append(self.refused("rollback_refused"))
        originals = {path: path.read_bytes() for path in paths}
        adapter = Adapter("python")
        result = dc.switch_unit(self.effects, adapter, "crq-tick.service", NODE)
        self.assertEqual(result["outcome"], "completed")
        for path, original in originals.items():
            self.assertEqual(path.read_bytes(), original)

    def test_completed_unit_history_does_not_block(self):
        for outcome in ("completed", "rolled_back"):
            with self.subTest(outcome=outcome):
                path = self.effects.journal_append(
                    self.completed_unit_switch(outcome))
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
        history = [self.completed_deploy(), self.completed_rollback(),
                   self.refused("deploy_refused")]
        history_originals = {entry: entry.read_bytes() for entry in history}
        self.assertEqual(
            dc.recover_unit(self.effects, adapter, path)["outcome"],
            "rolled_back")
        for entry, original in history_originals.items():
            self.assertEqual(entry.read_bytes(), original)

    def test_unit_recovery_blocks_on_another_unit_intent(self):
        with self.assertRaises(Crash):
            dc.switch_unit(self.effects, InterruptedAdapter("python"),
                           "crq-tick.service", NODE)
        path = next(self.record_dir.glob("controller-*.json"))
        unit_original = path.read_bytes()
        other = self.pending_unit_switch()
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
            ("invalid-json", "not json\n", "unreadable"),
            ("list-root", "[]\n", "invalid controller journal entry"),
            ("empty-object", "{}\n", "unsupported controller journal schema"),
            ("wrong-schema", json.dumps({"schema_version": 2,
                                         "operation": "deploy",
                                         "outcome": "completed"}) + "\n",
             "unsupported controller journal schema"),
            ("unknown-operation", json.dumps({
                "schema_version": 1, "operation": "mystery",
                "outcome": "completed"}) + "\n",
             "unknown controller journal operation"),
            ("invalid-unit-outcome", json.dumps({
                "schema_version": 1, "operation": "unit_switch",
                "outcome": ["unexpected"]}) + "\n",
             "invalid unit switch outcome"),
            ("incomplete-completed-unit", json.dumps({
                "schema_version": 1, "operation": "unit_switch",
                "outcome": "completed"}) + "\n",
             "invalid unit switch journal"),
            ("invalid-pending-outcome", json.dumps({
                "schema_version": 1, "operation": "deploy_pending",
                "outcome": "completed"}) + "\n",
             "invalid pending checkout journal"),
            ("incomplete-pending", json.dumps({
                "schema_version": 1, "operation": "deploy_pending",
                "outcome": "pending"}) + "\n",
             "invalid pending checkout journal"),
            ("incomplete-legacy-deploy", json.dumps({
                "schema_version": 1, "operation": "deploy"}) + "\n",
             "invalid completed checkout journal"),
            ("incomplete-completed-deploy", json.dumps({
                "schema_version": 1, "operation": "deploy",
                "outcome": "completed"}) + "\n",
             "invalid completed checkout journal"),
            ("incomplete-legacy-rollback", json.dumps({
                "schema_version": 1, "operation": "rollback"}) + "\n",
             "invalid completed checkout journal"),
            ("incomplete-refused", json.dumps({
                "schema_version": 1, "operation": "deploy_refused",
                "outcome": "refused_no_change"}) + "\n",
             "invalid refused checkout journal"),
            ("incomplete-recovery", json.dumps({
                "schema_version": 1, "operation": "recovery_required",
                "outcome": "recovery_required"}) + "\n",
             "unsupported legacy checkout recovery"),
        ]
        for label, text, pattern in cases:
            with self.subTest(label=label):
                path = record_path(self.record_dir)
                path.write_text(text)
                try:
                    adapter = TrackingAdapter("python")
                    with self.assertRaisesRegex(dc.Refused, pattern):
                        dc.switch_unit(self.effects, adapter,
                                       "crq-tick.service", NODE)
                    self.assertEqual(adapter.calls, [])
                finally:
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
