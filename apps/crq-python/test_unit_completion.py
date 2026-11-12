"""Focused offline tests for the read-only systemd completion provider.

Every systemd and journal fact is injected. Installed unit files are real
temporary files so runtime parsing and service hashing are real. No
``systemctl``, ``journalctl``, live unit, VM, provider or network is touched.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from unittest import mock

ROOT = Path(__file__).resolve().parent
OPS = ROOT / "ops"
BOOT = "a" * 32
SOURCE_SHA = "c" * 40
TEMPLATE_BLOB = "d" * 40
NODE_SHA = "b" * 40
UNIT = "crq-tick.service"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


completion = _load("crq_unit_completion", OPS / "unit-completion.py")


def _sha256(value):
    return hashlib.sha256(value).hexdigest()


def _python_unit():
    return (
        "[Service]\n"
        "Type=oneshot\n"
        "ExecStart=/usr/bin/env python3 /checkout/apps/crq-python/crq.py tick\n"
    ).encode()


def _node_unit(sha=NODE_SHA):
    return (
        "[Service]\n"
        "Type=oneshot\n"
        "ExecStart=/usr/bin/env node /home/probe/.local/opt/crq-"
        + sha + "/dist/queue-runner/crq.js tick\n"
    ).encode()


class FakeSource:
    def __init__(self, unit_path, boot=BOOT):
        self.unit_path = Path(unit_path)
        self.boot = boot
        self.state = {
            "LoadState": "loaded",
            "ActiveState": "inactive",
            "SubState": "dead",
            "InvocationID": "",
            "Result": "success",
            "ExecMainStatus": "0",
            "ExecMainExitTimestampMonotonic": "0",
            "FragmentPath": str(self.unit_path),
        }
        self.records_data = []
        self.records_boot = boot
        self.records_calls = 0
        self.records_error = None
        self.show_calls = 0

    def complete(self, invocation, exit_monotonic, *,
                 result="success", status="0",
                 active="inactive", sub="dead", load="loaded"):
        self.state.update({
            "LoadState": load,
            "ActiveState": active,
            "SubState": sub,
            "InvocationID": invocation,
            "Result": result,
            "ExecMainStatus": status,
            "ExecMainExitTimestampMonotonic": str(exit_monotonic),
        })

    def show(self, unit, props):
        self.show_calls += 1
        if not unit == UNIT:
            raise AssertionError("unexpected unit " + unit)
        return {prop: self.state.get(prop, "") for prop in props}

    def records(self, unit, *, after_monotonic):
        self.records_calls += 1
        if self.records_error is not None:
            raise self.records_error
        return {"boot_id": self.records_boot,
                "records": list(self.records_data)}

    def boot_id(self):
        return self.boot


class CompletionFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.unit_dir = Path(self.temp.name)
        self.unit_path = self.unit_dir / UNIT
        self.unit_path.write_bytes(_python_unit())
        self.source = FakeSource(self.unit_path)

    def identity(self, *, runtime="python", unit=UNIT,
                 service_sha256=None, **extra):
        return completion.ExpectedIdentity(
            unit=unit,
            runtime=runtime,
            service_sha256=service_sha256 or _sha256(self.unit_path.read_bytes()),
            source_sha=SOURCE_SHA,
            template_blob_oid=TEMPLATE_BLOB,
            **extra,
        )

    def port(self, *, runtime="python", require_journal_witness=False,
             max_records=256, unit=UNIT, service_sha256=None):
        port = completion.SystemdJournalCompletionPort(
            unit_dir=self.unit_dir,
            source=self.source,
            expected=self.identity(
                runtime=runtime, unit=unit, service_sha256=service_sha256),
            max_records=max_records,
            require_journal_witness=require_journal_witness,
        )
        self._last_port = port
        return port

    def baseline(self, *, invocation="", exit_monotonic=0, **state):
        port = getattr(self, "_last_port", None) or self.port()
        self.source.state.update({
            "InvocationID": invocation,
            "ExecMainExitTimestampMonotonic": str(exit_monotonic),
        })
        self.source.state.update(state)
        port.sequence(UNIT)
        return port


class SequenceTests(CompletionFixture):
    def test_zero_without_completed_invocation(self):
        self.assertEqual(self.port().sequence(UNIT), 0)

    def test_masked_service_has_zero_baseline(self):
        self.unit_path.write_bytes(_python_unit())
        self.source.complete("", 0, load="masked")
        self.assertEqual(self.port().sequence(UNIT), 0)

    def test_masked_reread_does_not_credit_the_prior_invocation(self):
        self.source.complete("1" * 32, 100)
        port = self.port()
        self.assertEqual(port.sequence(UNIT), 100)
        # The controller re-reads after its drain/mask. The established
        # baseline must survive so the prior runtime's invocation cannot be
        # returned as a completion of the selected runtime.
        self.source.complete("", 0, load="masked")
        baseline = port.sequence(UNIT)
        self.assertEqual(baseline, 100)
        self.source.complete("1" * 32, 100)
        self.assertIsNone(port.read(UNIT, "python", baseline))

    def test_a_newer_prior_invocation_raises_the_baseline(self):
        self.source.complete("1" * 32, 100)
        port = self.port()
        self.assertEqual(port.sequence(UNIT), 100)
        self.source.complete("2" * 32, 130)
        self.assertEqual(port.sequence(UNIT), 130)

    def test_a_stale_prior_invocation_does_not_lower_the_baseline(self):
        self.source.complete("a" * 32, 940)
        port = self.port()
        self.assertEqual(port.sequence(UNIT), 940)
        # A later observation of an older successful prior invocation must not
        # replace the established baseline. Otherwise the prior runtime's
        # invocation could be credited to the selected runtime. The M15-only
        # mutant that accepts a lower monotonic value sets 700 here.
        self.source.complete("c" * 32, 700)
        self.assertEqual(port.sequence(UNIT), 940)
        self.assertIsNone(port.read(UNIT, "python", 940))

    def test_completed_invocation_is_baseline(self):
        self.source.complete("1" * 32, 100)
        self.assertEqual(self.port().sequence(UNIT), 100)

    def test_active_unit_refuses_baseline(self):
        self.source.complete("1" * 32, 100, active="active", sub="start")
        with self.assertRaises(completion.CompletionRefused):
            self.port().sequence(UNIT)

    def test_deactivating_unit_refuses_baseline(self):
        self.source.complete("1" * 32, 100, active="deactivating",
                             sub="stop-sigterm")
        with self.assertRaises(completion.CompletionRefused):
            self.port().sequence(UNIT)

    def test_transitional_states_refuse_baseline(self):
        for active in ("activating", "reloading", "deactivating"):
            with self.subTest(active=active):
                self.source.complete("1" * 32, 100, active=active)
                with self.assertRaises(completion.CompletionRefused):
                    self.port().sequence(UNIT)

    def test_failed_prior_invocation_refuses_baseline(self):
        self.source.complete("1" * 32, 100, result="exit-code", status="1",
                             active="failed", sub="failed")
        with self.assertRaises(completion.CompletionRefused):
            self.port().sequence(UNIT)

    def test_malformed_invocation_refuses_baseline(self):
        self.source.complete("not-hex", 100)
        with self.assertRaises(completion.CompletionRefused):
            self.port().sequence(UNIT)

    def test_malformed_exit_timestamp_refuses_baseline(self):
        self.source.state["ExecMainExitTimestampMonotonic"] = "soon"
        with self.assertRaises(completion.CompletionRefused):
            self.port().sequence(UNIT)


class ReadTests(CompletionFixture):
    def test_read_without_baseline_refuses(self):
        port = self.port()
        with self.assertRaises(completion.CompletionRefused):
            port.read(UNIT, "python", 0)

    def test_two_advancing_distinct_invocations(self):
        port = self.port()
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("2" * 32, 200)
        first = port.read(UNIT, "python", 100)
        self.assertIsNotNone(first)
        self.assertEqual(first["invocation"], "2" * 32)
        self.assertEqual(first["sequence"], 200)
        self.source.complete("3" * 32, 300)
        second = port.read(UNIT, "python", 200)
        self.assertIsNotNone(second)
        self.assertEqual(second["invocation"], "3" * 32)
        self.assertEqual(second["sequence"], 300)

    def test_same_invocation_not_returned_twice(self):
        port = self.port()
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("2" * 32, 200)
        self.assertIsNotNone(port.read(UNIT, "python", 100))
        self.assertIsNone(port.read(UNIT, "python", 200))

    def test_baseline_invocation_is_not_a_completion(self):
        port = self.port()
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("1" * 32, 100)
        self.assertIsNone(port.read(UNIT, "python", 100))

    def test_active_invocation_returns_none(self):
        port = self.port()
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("2" * 32, 200, active="active", sub="start")
        self.assertIsNone(port.read(UNIT, "python", 100))

    def test_non_advancing_sequence_returns_none(self):
        port = self.port()
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("2" * 32, 100)
        self.assertIsNone(port.read(UNIT, "python", 100))

    def test_failed_result_refuses(self):
        port = self.port()
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("2" * 32, 200, result="exit-code", status="1",
                             active="failed", sub="failed")
        with self.assertRaises(completion.CompletionRefused):
            port.read(UNIT, "python", 100)

    def test_nonzero_exit_status_refuses(self):
        port = self.port()
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("2" * 32, 200, status="1")
        with self.assertRaises(completion.CompletionRefused):
            port.read(UNIT, "python", 100)

    def test_unknown_active_state_returns_none(self):
        port = self.port()
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("2" * 32, 200, active="deactivating", sub="stop")
        self.assertIsNone(port.read(UNIT, "python", 100))

    def test_selected_service_digest_mismatch_refuses(self):
        port = self.port()
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("2" * 32, 200)
        self.unit_path.write_bytes(_python_unit() + b"# changed\n")
        with self.assertRaises(completion.CompletionRefused):
            port.read(UNIT, "python", 100)

    def test_runtime_mismatch_refuses(self):
        port = self.port()
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.unit_path.write_bytes(_node_unit())
        self.source.complete("2" * 32, 200)
        with self.assertRaises(completion.CompletionRefused):
            port.read(UNIT, "python", 100)

    def test_unit_identity_mismatch_refuses(self):
        port = self.port()
        with self.assertRaises(completion.CompletionRefused):
            port.read("crq-slot.service", "python", 0)

    def test_runtime_identity_mismatch_refuses(self):
        port = self.port()
        with self.assertRaises(completion.CompletionRefused):
            port.read(UNIT, "node:" + NODE_SHA, 0)

    def test_boot_change_refuses(self):
        port = self.port()
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("2" * 32, 200)
        self.source.boot = "b" * 32
        with self.assertRaises(completion.CompletionRefused):
            port.read(UNIT, "python", 100)

    def test_journal_boot_mismatch_refuses(self):
        port = self.port()
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("2" * 32, 200)
        self.source.records_data = [{
            "_BOOT_ID": "b" * 32,
            "__MONOTONIC_TIMESTAMP": "150",
            "USER_UNIT": UNIT,
            "USER_INVOCATION_ID": "2" * 32,
        }]
        self.source.records_boot = "b" * 32
        with self.assertRaises(completion.CompletionRefused):
            port.read(UNIT, "python", 100)

    def test_evidence_carries_selected_identity(self):
        port = self.port()
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("2" * 32, 200)
        evidence = port.read(UNIT, "python", 100)
        self.assertEqual(evidence["source_sha"], SOURCE_SHA)
        self.assertEqual(evidence["template_blob_oid"], TEMPLATE_BLOB)
        self.assertEqual(evidence["service_sha256"], _sha256(_python_unit()))
        self.assertEqual(evidence["boot_id"], BOOT)


class WitnessTests(CompletionFixture):
    def read_with_records(self, records, *, require=False):
        port = self.port(require_journal_witness=require)
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("2" * 32, 200)
        self.source.records_data = records
        return port.read(UNIT, "python", 100)

    def test_manager_witness_accepted(self):
        evidence = self.read_with_records([{
            "_BOOT_ID": BOOT,
            "__MONOTONIC_TIMESTAMP": "150",
            "USER_UNIT": UNIT,
            "USER_INVOCATION_ID": "2" * 32,
        }])
        self.assertEqual(evidence["witness"], "manager")

    def test_unit_process_witness_accepted(self):
        evidence = self.read_with_records([{
            "_BOOT_ID": BOOT,
            "__MONOTONIC_TIMESTAMP": "150",
            "_SYSTEMD_USER_UNIT": UNIT,
            "_SYSTEMD_INVOCATION_ID": "2" * 32,
        }])
        self.assertEqual(evidence["witness"], "unit-process")

    def test_system_manager_witness_accepted(self):
        evidence = self.read_with_records([{
            "_BOOT_ID": BOOT,
            "__MONOTONIC_TIMESTAMP": "150",
            "UNIT": UNIT,
            "INVOCATION_ID": "2" * 32,
        }])
        self.assertEqual(evidence["witness"], "manager")

    def test_quiet_oneshot_without_witness_is_show_only(self):
        evidence = self.read_with_records([])
        self.assertEqual(evidence["witness"], "none")

    def test_strict_mode_refuses_missing_witness(self):
        with self.assertRaises(completion.CompletionRefused):
            self.read_with_records([], require=True)

    def test_strict_mode_propagates_journal_unavailable(self):
        port = self.port(require_journal_witness=True)
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("2" * 32, 200)
        self.source.records_error = completion.CompletionUnavailable(
            "journal unavailable")
        with self.assertRaises(completion.CompletionUnavailable):
            port.read(UNIT, "python", 100)

    def test_foreign_unit_witness_is_ignored(self):
        evidence = self.read_with_records([{
            "_BOOT_ID": BOOT,
            "__MONOTONIC_TIMESTAMP": "250",
            "USER_UNIT": "crq-other.service",
            "USER_INVOCATION_ID": "2" * 32,
        }])
        self.assertEqual(evidence["witness"], "none")

    def test_strict_mode_refuses_foreign_witness(self):
        with self.assertRaises(completion.CompletionRefused):
            self.read_with_records([{
                "_BOOT_ID": BOOT,
                "__MONOTONIC_TIMESTAMP": "250",
                "USER_UNIT": "crq-other.service",
                "USER_INVOCATION_ID": "2" * 32,
            }], require=True)

    def test_witness_after_exit_timestamp_is_accepted(self):
        evidence = self.read_with_records([{
            "_BOOT_ID": BOOT,
            "__MONOTONIC_TIMESTAMP": "999",
            "USER_UNIT": UNIT,
            "USER_INVOCATION_ID": "2" * 32,
        }])
        self.assertEqual(evidence["witness"], "manager")

    def test_later_invocation_witness_is_ignored(self):
        evidence = self.read_with_records([{
            "_BOOT_ID": BOOT,
            "__MONOTONIC_TIMESTAMP": "999",
            "USER_UNIT": UNIT,
            "USER_INVOCATION_ID": "3" * 32,
        }])
        self.assertEqual(evidence["witness"], "none")

    def test_malformed_monotonic_timestamp_refuses(self):
        with self.assertRaises(completion.CompletionRefused):
            self.read_with_records([{
                "_BOOT_ID": BOOT,
                "__MONOTONIC_TIMESTAMP": "soon",
                "USER_UNIT": UNIT,
                "USER_INVOCATION_ID": "2" * 32,
            }])

    def test_missing_monotonic_timestamp_refuses(self):
        with self.assertRaises(completion.CompletionRefused):
            self.read_with_records([{
                "_BOOT_ID": BOOT,
                "USER_UNIT": UNIT,
                "USER_INVOCATION_ID": "2" * 32,
            }])

    def test_oversized_journal_refuses(self):
        port = self.port(max_records=2)
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("2" * 32, 200)
        self.source.records_data = [{}, {}, {}]
        with self.assertRaises(completion.CompletionRefused):
            port.read(UNIT, "python", 100)


class IdentityTests(CompletionFixture):
    def test_identity_from_python_render(self):
        identity = completion.ExpectedIdentity.from_render(
            unit=UNIT, runtime="python",
            render={"unit": UNIT, "runtime": "python",
                    "sha256": _sha256(_python_unit()),
                    "source_sha": SOURCE_SHA,
                    "template_blob_oid": TEMPLATE_BLOB,
                    "artifact": None})
        identity.validate()
        self.assertEqual(identity.service_sha256, _sha256(_python_unit()))
        self.assertIsNone(identity.artifact_content_sha256)

    def test_identity_from_node_render(self):
        identity = completion.ExpectedIdentity.from_render(
            unit=UNIT, runtime="node:" + NODE_SHA,
            render={"unit": UNIT, "runtime": "node:" + NODE_SHA,
                    "sha256": _sha256(_node_unit()),
                    "source_sha": SOURCE_SHA,
                    "template_blob_oid": TEMPLATE_BLOB,
                    "artifact": {"declared_content_sha256": "e" * 64,
                                 "observed_content_sha256": "e" * 64,
                                 "source_sha": NODE_SHA,
                                 "crq_js_sha256": "1" * 64}})
        identity.validate()
        self.assertEqual(identity.artifact_content_sha256, "e" * 64)
        self.assertEqual(identity.artifact_source_sha, NODE_SHA)
        self.assertEqual(identity.crq_js_sha256, "1" * 64)

    def test_identity_from_render_requires_service_digest(self):
        with self.assertRaises(completion.CompletionRefused):
            completion.ExpectedIdentity.from_render(
                unit=UNIT, runtime="python",
                render={"unit": UNIT, "runtime": "python",
                        "source_sha": SOURCE_SHA,
                        "template_blob_oid": TEMPLATE_BLOB})

    def test_identity_from_render_requires_observed_artifact_digest(self):
        with self.assertRaises(completion.CompletionRefused):
            completion.ExpectedIdentity.from_render(
                unit=UNIT, runtime="node:" + NODE_SHA,
                render={"unit": UNIT, "runtime": "node:" + NODE_SHA,
                        "sha256": _sha256(_node_unit()),
                        "source_sha": SOURCE_SHA,
                        "template_blob_oid": TEMPLATE_BLOB,
                        "artifact": {"content_sha256": "e" * 64,
                                     "source_sha": NODE_SHA,
                                     "crq_js_sha256": "1" * 64}})

    def test_identity_from_render_rejects_disagreeing_artifact_digests(self):
        with self.assertRaises(completion.CompletionRefused):
            completion.ExpectedIdentity.from_render(
                unit=UNIT, runtime="node:" + NODE_SHA,
                render={"unit": UNIT, "runtime": "node:" + NODE_SHA,
                        "sha256": _sha256(_node_unit()),
                        "source_sha": SOURCE_SHA,
                        "template_blob_oid": TEMPLATE_BLOB,
                        "artifact": {"declared_content_sha256": "d" * 64,
                                     "observed_content_sha256": "e" * 64,
                                     "source_sha": NODE_SHA,
                                     "crq_js_sha256": "1" * 64}})

    def test_identity_from_render_rejects_a_different_selection(self):
        with self.assertRaises(completion.CompletionRefused):
            completion.ExpectedIdentity.from_render(
                unit=UNIT, runtime="python",
                render={"unit": "crq-slot.service", "runtime": "python",
                        "sha256": _sha256(_python_unit()),
                        "source_sha": SOURCE_SHA,
                        "template_blob_oid": TEMPLATE_BLOB})

    def test_python_identity_requires_source_and_template(self):
        with self.assertRaises(completion.CompletionRefused):
            completion.ExpectedIdentity(
                unit=UNIT, runtime="python",
                service_sha256=_sha256(_python_unit()),
                source_sha="", template_blob_oid=TEMPLATE_BLOB).validate()

    def test_node_identity_requires_artifact_identity(self):
        with self.assertRaises(completion.CompletionRefused):
            completion.ExpectedIdentity(
                unit=UNIT, runtime="node:" + NODE_SHA,
                service_sha256=_sha256(_node_unit()),
                source_sha=SOURCE_SHA,
                template_blob_oid=TEMPLATE_BLOB).validate()

    def test_node_identity_source_must_match_pointer(self):
        with self.assertRaises(completion.CompletionRefused):
            completion.ExpectedIdentity(
                unit=UNIT, runtime="node:" + NODE_SHA,
                service_sha256=_sha256(_node_unit()),
                source_sha=SOURCE_SHA,
                template_blob_oid=TEMPLATE_BLOB,
                artifact_content_sha256="e" * 64,
                artifact_source_sha="f" * 40,
                crq_js_sha256="1" * 64).validate()

    def test_node_identity_accepts_matching_artifact(self):
        identity = completion.ExpectedIdentity(
            unit=UNIT, runtime="node:" + NODE_SHA,
            service_sha256=_sha256(_node_unit()),
            source_sha=SOURCE_SHA,
            template_blob_oid=TEMPLATE_BLOB,
            artifact_content_sha256="e" * 64,
            artifact_source_sha=NODE_SHA,
            crq_js_sha256="1" * 64)
        identity.validate()

    def test_selected_digest_is_required(self):
        port = self.port(service_sha256="0" * 64)
        self.baseline(invocation="1" * 32, exit_monotonic=100)
        self.source.complete("2" * 32, 200)
        with self.assertRaises(completion.CompletionRefused):
            port.read(UNIT, "python", 100)

    def test_service_identity_still_refuses_a_timer_unit(self):
        with self.assertRaises(completion.CompletionRefused) as raised:
            self.identity(unit="crq-tick.timer").validate()
        self.assertEqual(str(raised.exception),
                         "expected identity names an invalid unit")


class ParserTests(unittest.TestCase):
    def test_show_output_parses_values_and_empty_strings(self):
        parsed = completion.parse_show_output(
            "LoadState=loaded\nInvocationID=\nResult=success\n")
        self.assertEqual(parsed["LoadState"], "loaded")
        self.assertEqual(parsed["InvocationID"], "")

    def test_show_output_rejects_missing_equals(self):
        with self.assertRaises(completion.CompletionRefused):
            completion.parse_show_output("LoadState loaded\n")

    def test_show_output_rejects_duplicate_property(self):
        with self.assertRaises(completion.CompletionRefused):
            completion.parse_show_output("Result=success\nResult=success\n")

    def test_journal_json_parses_records(self):
        records = completion.parse_journal_json(
            json.dumps({"_BOOT_ID": BOOT}) + "\n", max_records=2)
        self.assertEqual(records[0]["_BOOT_ID"], BOOT)

    def test_journal_json_rejects_non_json(self):
        with self.assertRaises(completion.CompletionRefused):
            completion.parse_journal_json("not-json\n", max_records=2)

    def test_journal_json_rejects_record_bound(self):
        text = "\n".join([json.dumps({}), json.dumps({})]) + "\n"
        with self.assertRaises(completion.CompletionRefused):
            completion.parse_journal_json(text, max_records=1)

    def test_runtime_parser_accepts_python(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / UNIT
            path.write_bytes(_python_unit())
            self.assertEqual(completion.parse_runtime_from_unit(path), "python")

    def test_runtime_parser_accepts_node_pointer(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / UNIT
            path.write_bytes(_node_unit())
            self.assertEqual(completion.parse_runtime_from_unit(path),
                             "node:" + NODE_SHA)

    def test_runtime_parser_rejects_multiple_exec_start(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / UNIT
            path.write_bytes(_python_unit()
                             + b"ExecStart=/usr/bin/env python3 /other\n")
            with self.assertRaises(completion.CompletionRefused):
                completion.parse_runtime_from_unit(path)

    def test_runtime_parser_rejects_unknown_interpreter(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / UNIT
            path.write_bytes(b"ExecStart=/usr/bin/env perl /checkout/x\n")
            with self.assertRaises(completion.CompletionRefused):
                completion.parse_runtime_from_unit(path)

    def popen_for(self, script, *, calls=None, processes=None):
        def popen(command, **kwargs):
            if calls is not None:
                calls.append((command, kwargs))
            process = subprocess.Popen(
                [sys.executable, "-c", script], **kwargs)
            if processes is not None:
                processes.append(process)
            return process
        return popen

    def source_for(self, script, *, calls=None, processes=None,
                   max_bytes=256 * 1024, timeout=2.0):
        return completion.SystemdJournalSource(
            popen=self.popen_for(script, calls=calls, processes=processes),
            max_bytes=max_bytes, timeout=timeout)

    def test_source_show_builds_read_only_command(self):
        calls = []
        source = self.source_for(
            "import sys; sys.stdout.write('LoadState=loaded\\n')",
            calls=calls)
        self.assertEqual(source.show(UNIT, ["LoadState"]),
                         {"LoadState": "loaded"})
        command = calls[0][0]
        self.assertIn("show", command)
        self.assertIn("--user", command)
        self.assertNotIn("start", command)
        self.assertNotIn("stop", command)
        self.assertNotIn("mask", command)

    def test_source_records_builds_read_only_user_unit_command(self):
        calls = []
        source = self.source_for("pass", calls=calls)
        with mock.patch.object(completion, "read_boot_id", return_value=BOOT):
            response = source.records(UNIT, after_monotonic=1)
        self.assertEqual(response["records"], [])
        command = calls[0][0]
        self.assertIn("--user-unit", command)
        self.assertIn("--output=json", command)
        self.assertNotIn("start", command)
        self.assertNotIn("stop", command)
        self.assertNotIn("mask", command)

    def test_source_rejects_nonzero_exit_without_echoing_stderr(self):
        processes = []
        source = self.source_for(
            "import sys; sys.stderr.write('secret\\n'); sys.exit(1)",
            processes=processes)
        with self.assertRaises(completion.CompletionUnavailable) as raised:
            source.show(UNIT, ["LoadState"])
        self.assertNotIn("secret", str(raised.exception))
        self.assertIsNotNone(processes[0].poll())

    def test_source_rejects_invalid_unit_name(self):
        source = completion.SystemdJournalSource(
            popen=lambda *a, **k: self.fail("invalid unit must not run"))
        with self.assertRaises(completion.CompletionRefused):
            source.show("--help", ["LoadState"])

    def test_source_accepts_activator_unit_reads(self):
        source = self.source_for(
            "import sys; sys.stdout.write('ActiveState=active\\n')")
        for unit in ("crq-tick.timer", "crq-tick.path", "crq-tick.socket"):
            self.assertEqual(source.show(unit, ["ActiveState"]),
                             {"ActiveState": "active"})

    def test_source_refuses_unsupported_unit_types(self):
        source = completion.SystemdJournalSource(
            popen=lambda *a, **k: self.fail("invalid unit must not run"))
        for unit in ("crq-tick.mount", "crq-tick.swap", "crq-tick.slice",
                     "crq-tick"):
            with self.assertRaises(completion.CompletionRefused) as raised:
                source.show(unit, ["LoadState"])
            self.assertEqual(str(raised.exception), "invalid unit name")

    def test_source_accepts_output_at_the_exact_bound(self):
        source = self.source_for(
            "import sys; sys.stdout.write('A=12345\\n')", max_bytes=8)
        self.assertEqual(source.show(UNIT, ["A"]), {"A": "12345"})

    def test_source_refuses_stdout_over_the_bound(self):
        processes = []
        source = self.source_for(
            "import sys; sys.stdout.write('A=123456\\n')",
            processes=processes, max_bytes=8)
        with self.assertRaises(completion.CompletionRefused):
            source.show(UNIT, ["A"])
        self.assertIsNotNone(processes[0].poll())

    def test_source_refuses_stderr_over_the_bound(self):
        processes = []
        source = self.source_for(
            "import sys; sys.stderr.write('x' * 9)",
            processes=processes, max_bytes=8)
        with self.assertRaises(completion.CompletionRefused):
            source.show(UNIT, ["A"])
        self.assertIsNotNone(processes[0].poll())

    def test_source_drains_both_streams_without_deadlock(self):
        source = self.source_for(
            "import sys; sys.stderr.write('e' * 65536); "
            "sys.stdout.write('A=1\\n')",
            max_bytes=128 * 1024)
        self.assertEqual(source.show(UNIT, ["A"]), {"A": "1"})

    def test_source_timeout_refuses_and_reaps(self):
        processes = []
        source = self.source_for(
            "import time; time.sleep(5)", processes=processes, timeout=0.2)
        with self.assertRaises(completion.CompletionUnavailable):
            source.show(UNIT, ["A"])
        self.assertIsNotNone(processes[0].poll())

    def test_source_refuses_invalid_utf8(self):
        processes = []
        source = self.source_for(
            "import sys; sys.stdout.buffer.write(b'\\xff')",
            processes=processes)
        with self.assertRaises(completion.CompletionRefused) as raised:
            source.show(UNIT, ["A"])
        self.assertIn("UTF-8", str(raised.exception))
        self.assertIsNotNone(processes[0].poll())


if __name__ == "__main__":
    unittest.main()
