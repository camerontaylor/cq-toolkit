"""Q7 deployment controller characterization: completion-heartbeat health.

Split provenance: pure move out of ``test_deploy_controller.py`` (see
``test_deploy_controller_fixtures.py`` for the shared offline fixtures).

No live systemd, no network, no real deployment. The accepted helper is
exercised against temporary detached git clones exactly as
``test_host_config_*`` modules does; process liveness is faked; units are never
started; the controller never signals a process.
"""
import hashlib
import json
import os
import shutil
import unittest
from unittest import mock

import review_receipt

from test_deploy_controller_fixtures import ROOT, _MISSING_ROOT, ControllerFixture, dc


class HealthTests(ControllerFixture):
    """Causal completion-heartbeat fixtures under an isolated WATCHDOG_HOME.

    crq.py persists queue.last_tick before status publication and replaces
    the completion heartbeat only after it. These fixtures reproduce that
    producer order against the controller's real WATCHDOG_HOME resolution —
    never a mocked read seam, never the actual user's heartbeat.
    """

    def setUp(self):
        super().setUp()
        self.xdg = self.base / "xdg-state"
        self.watchdog = self.xdg / "crq"
        self.watchdog.mkdir(parents=True)
        isolated = mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(self.xdg)})
        isolated.start()
        self.addCleanup(isolated.stop)

    def complete_tick(self, tick, root=_MISSING_ROOT):
        """Atomically replace the completion heartbeat exactly as crq.py
        write_heartbeat() does: producer-shaped JSON, tmp + replace.
        root is written verbatim (None/other values included) so fixtures
        can prove root binding; only _MISSING_ROOT means this checkout."""
        payload = {"last_tick": tick, "stale_alarm_min": 36,
                   "schedule_id": "crq-tick",
                   "root": str(self.runner) if root is _MISSING_ROOT else root,
                   "alert_agent_id": None, "alert_agent_host": None}
        tmp = self.watchdog / ".heartbeat.json.tmp"
        tmp.write_text(json.dumps(payload) + "\n")
        tmp.replace(self.watchdog / "heartbeat.json")

    def write_raw_heartbeat(self, raw):
        (self.watchdog / "heartbeat.json").write_text(raw)

    def observe_after(self, ticks):
        """Complete the given ticks between observations (the real producer
        runs between wall-clock slots; the controller only ever reads)."""
        remaining = iter(ticks)

        def observe(prior):
            self.complete_tick(next(remaining))
            return dc.health_observation(self.effects, prior)

        return observe

    def observe_fixtures(self):
        runs = self.runner / "state/runs"
        runs.mkdir(parents=True, exist_ok=True)
        (runs / "run-a").mkdir(exist_ok=True)
        (runs / "run-a/meta.json").write_text('{"head": "%s"}\n' % self.before)
        (runs / "run-b").mkdir(exist_ok=True)
        (runs / "run-b/meta.json").write_bytes(b"{broken")

    def test_two_completed_replacements_are_healthy_with_receipt_sample(self):
        self.observe_fixtures()
        self.complete_tick("2026-10-28T00:00:00Z")
        result = dc.two_slot_health(self.effects, self.observe_after(
            ["2026-10-28T00:05:00Z", "2026-10-28T00:10:00Z"]))
        self.assertTrue(result["healthy"])
        first, second = result["observations"]
        self.assertEqual(first["observed_tick"], "2026-10-28T00:05:00Z")
        self.assertEqual(second["observed_tick"], "2026-10-28T00:10:00Z")
        self.assertEqual(first["receipts"], {
            "sampled": 2, "readable": 1, "prelaunch": 0, "ignored_entries": 0,
            "unreadable": [{"run": "run-b", "reason": "corrupt: unparseable meta.json"}]})
        # Readability is its own verdict and never a tick failure (#550).
        self.assertIs(first["receipts_readable"], False)
        self.assertIs(result["receipts_readable"], False)
        self.assertIsNone(first["receipts_valid"])  # no state/receipts sampled
        self.assertIsNone(result["receipts_valid"])

    def receipt_document(self, **overrides):
        """A v1 merged-current receipt shaped exactly like crq.current_document."""
        paths = [{"source_path": "src/a.ts", "path": "src/a.ts",
                  "resolution": "same-path-current", "disposition": "included"}]
        capture = {"target": "a" * 40, "tree": "b" * 40, "paths": paths,
                   "scope_digest": review_receipt.digest(paths),
                   "policy": review_receipt.POLICY,
                   "projection": "current-affected-files/full-file-addition-projection",
                   "reviewer": "coderabbit-review-agent-committed-v1",
                   "reviewer_version": "0.3.4", "captured_at": "2026-10-28T00:00:00Z"}
        capture["equivalence"] = review_receipt.current_equivalence(capture)
        document = {"version": 1, "item_id": "current-0123", "request_id": "req-1",
                    "source": {"repo": "o/r", "pr": 7, "merge_sha": "c" * 40,
                               "target_selector": "promoted-main",
                               "policy": review_receipt.POLICY},
                    "capture": capture, "outcome": "terminal-clean",
                    "classification": {"counted": True, "outcome": "completed"},
                    "counted": True, "findings": [],
                    "run_id": "current-0123-20261028T000000Z",
                    "started_at": "2026-10-28T00:00:00Z",
                    "artifacts": {"meta.json": "d" * 64},
                    "remediation": "disabled/deferred",
                    "independent_acceptance": False,
                    "cli_functional_acceptance": "pending-D1"}
        document.update(overrides)
        return document

    def write_receipt(self, document):
        return review_receipt.write_receipt(self.runner / "state/receipts", document)

    def write_raw_receipt(self, data):
        root = self.runner / "state/receipts"
        root.mkdir(parents=True, exist_ok=True)
        name = hashlib.sha256(data).hexdigest()
        (root / (name + ".json")).write_bytes(data)
        return name

    def test_receipt_fixtures_valid_wrong_target_terminal_missing_malformed(self):
        valid = self.receipt_document()
        # The fixture is a real reusable v1 receipt under the runner's own API.
        self.assertTrue(review_receipt.reusable_current(valid, valid["capture"]))
        wrong_target = self.receipt_document(
            capture={**valid["capture"], "target": "main"})
        unknown_selector = self.receipt_document(
            source={**valid["source"], "target_selector": "feature/x"})
        missing_outcome = self.receipt_document()
        del missing_outcome["outcome"]
        counted_unfinished = self.receipt_document(
            classification={"counted": False, "outcome": "failed"})
        no_run = self.receipt_document(run_id=None)
        cases = {
            "valid": (valid, None),
            "uncounted": (self.receipt_document(
                outcome="no-current-code", counted=False, classification=None,
                run_id=None, started_at=None, artifacts={}), None),
            "wrong-target": (wrong_target, "target"),
            "unknown-selector": (unknown_selector, "target"),
            "missing-terminal-outcome": (missing_outcome, "terminal outcome"),
            "counted-unfinished": (counted_unfinished, "terminal outcome"),
            "counted-without-run": (no_run, "terminal outcome"),
            "missing-item": (self.receipt_document(item_id=""), "run identity"),
            "scope-digest": (self.receipt_document(
                capture={**valid["capture"], "scope_digest": "e" * 64}), "scope digest"),
        }
        for label, (document, expected) in cases.items():
            with self.subTest(label=label):
                data = review_receipt.canonical(document)
                name = hashlib.sha256(data).hexdigest() + ".json"
                problem = dc.receipt_problem(name, data)
                if expected is None:
                    self.assertIsNone(problem)
                else:
                    self.assertIn(expected, problem)
        for raw, expected in ((b"{broken", "not valid JSON"), (b"[1]", "not a JSON object")):
            with self.subTest(raw=raw):
                name = hashlib.sha256(raw).hexdigest() + ".json"
                self.assertIn(expected, dc.receipt_problem(name, raw))
        data = review_receipt.canonical(valid)
        self.assertIn("content identity", dc.receipt_problem("0" * 64 + ".json", data))

    def test_invalid_receipt_sample_is_a_distinct_verdict_not_a_tick_failure(self):
        good = self.write_receipt(self.receipt_document())
        bad = self.write_receipt(self.receipt_document(
            capture={**self.receipt_document()["capture"], "target": "main"}))
        broken = self.write_raw_receipt(b"{broken")
        missing = self.receipt_document()
        del missing["outcome"]
        terminal = self.write_receipt(missing)
        # In-flight temporaries are not receipts and are never sampled.
        (self.runner / "state/receipts/.receipt-tmp").write_bytes(b"partial")
        self.complete_tick("2026-10-28T00:00:00Z")
        result = dc.two_slot_health(self.effects, self.observe_after(
            ["2026-10-28T00:05:00Z", "2026-10-28T00:10:00Z"]))
        self.assertTrue(result["healthy"])
        self.assertIs(result["receipts_valid"], False)
        first = result["observations"][0]
        self.assertIs(first["receipts_valid"], False)
        validation = first["receipt_validation"]
        self.assertEqual(validation["sampled"], 4)
        self.assertEqual(validation["valid_count"], 1)
        self.assertEqual(sorted(i["receipt"] for i in validation["invalid"]),
                         sorted([bad, broken, terminal]))
        self.assertNotIn(good, [i["receipt"] for i in validation["invalid"]])

    def age(self, path, seconds_ago):
        stamp = 1_800_000_000 - seconds_ago
        os.utime(path, (stamp, stamp))

    def test_receipt_sample_is_the_newest_by_mtime_not_lowest_hash(self):
        root = self.runner / "state/receipts"
        for index in range(dc.RECEIPT_SAMPLE + 2):
            name = self.write_receipt(self.receipt_document(item_id="current-%d" % index))
            self.age(root / (name + ".json"), 1000 + index)
        bad = self.write_raw_receipt(b"{broken")
        # Newest: written after the switch, so it must be sampled whatever its name.
        self.age(root / (bad + ".json"), 0)
        validation = dc.receipt_validation(self.effects)
        self.assertEqual(validation["sampled"], dc.RECEIPT_SAMPLE)
        self.assertEqual([i["receipt"] for i in validation["invalid"]], [bad])
        # The same bad receipt, oldest of all, falls outside the bounded sample.
        self.age(root / (bad + ".json"), 10**6)
        validation = dc.receipt_validation(self.effects)
        self.assertEqual(validation["sampled"], dc.RECEIPT_SAMPLE)
        self.assertIs(validation["valid"], True)

    def test_run_readability_sample_is_the_newest_by_mtime(self):
        runs = self.runner / "state/runs"
        for index in range(dc.RECEIPT_SAMPLE + 2):
            run = runs / ("aaaa%04d-20261028T000000Z" % index)
            run.mkdir(parents=True)
            (run / "meta.json").write_text("{}\n")
            self.age(run, 1000 + index)
        broken = runs / "zzzz-20261028T000500Z"  # sorts last by name
        broken.mkdir()
        (broken / "meta.json").write_bytes(b"{broken")
        self.age(broken, 0)
        self.complete_tick("2026-10-28T00:05:00Z")
        observation = dc.health_observation(self.effects, "2026-10-28T00:00:00Z")
        self.assertEqual(observation["receipts"]["sampled"], dc.RECEIPT_SAMPLE)
        self.assertEqual(observation["receipts"]["readable"], dc.RECEIPT_SAMPLE - 1)
        self.assertEqual(observation["receipts"]["unreadable"],
                         [{"run": broken.name, "reason": "corrupt: unparseable meta.json"}])
        self.assertIs(observation["receipts_readable"], False)
        self.age(broken, 10**6)
        observation = dc.health_observation(self.effects, "2026-10-28T00:00:00Z")
        self.assertIs(observation["receipts_readable"], True)

    def test_prelaunch_stops_are_expected_and_real_gaps_are_named(self):
        """crq.launch() writes secret-scan artifacts before meta.json; a
        blocked scan or refused checkout leaves only those. Other gaps, and
        non-run entries such as AppleDouble copies, are reported distinctly."""
        runs = self.runner / "state/runs"
        layout = {
            "ok-20261108T000000Z": {"meta.json": "{}"},
            "scan-blocked-20261108T000001Z": {"secret-scan.json": '{"ok": false}'},
            "backfill-blocked-20261108T000002Z": {"secret-scan.json": "{}",
                                                  "context-secret-scan.json": "{}"},
            "lost-meta-20261108T000003Z": {"secret-scan.json": "{}",
                                           "review.ndjson": ""},
            "corrupt-scan-20261108T000004Z": {"secret-scan.json": "{broken"},
            "empty-20261108T000005Z": {},
        }
        for name, files in layout.items():
            (runs / name).mkdir(parents=True)
            for child, text in files.items():
                (runs / name / child).write_text(text)
        (runs / "._ok-20261108T000000Z").write_bytes(b"\x00\x05\x16\x07")
        sample = dc.run_metadata_sample(self.effects)
        self.assertEqual(sample["sampled"], 6)
        self.assertEqual(sample["readable"], 1)
        self.assertEqual(sample["prelaunch"], 2)
        self.assertEqual(sample["ignored_entries"], 1)
        self.assertEqual(
            {row["run"]: row["reason"] for row in sample["unreadable"]},
            {"lost-meta-20261108T000003Z":
                 "missing meta.json alongside review.ndjson,secret-scan.json",
             "corrupt-scan-20261108T000004Z": "corrupt: unparseable pre-launch artifact",
             "empty-20261108T000005Z": "missing meta.json: empty run directory"})
        self.complete_tick("2026-10-28T00:05:00Z")
        observation = dc.health_observation(self.effects, "2026-10-28T00:00:00Z")
        self.assertIs(observation["receipts_readable"], False)
        for name in ("lost-meta-20261108T000003Z", "corrupt-scan-20261108T000004Z",
                     "empty-20261108T000005Z"):
            shutil.rmtree(runs / name)
        # Only expected pre-launch stops remain: readable, not hidden.
        observation = dc.health_observation(self.effects, "2026-10-28T00:00:00Z")
        self.assertIs(observation["receipts_readable"], True)
        self.assertEqual(observation["receipts"]["prelaunch"], 2)

    def push_document(self, **overrides):
        """A push-range receipt shaped like push_current._enroll's subject and
        crq.current_document, including a scope-cap split and a byte-cap row."""
        paths = [{"source_path": "src/a.rs", "path": "src/a.rs",
                  "resolution": "same-path-current", "disposition": "included"},
                 {"source_path": "src/big.rs", "path": "src/big.rs",
                  "resolution": "same-path-current", "disposition": "unsupported",
                  "reason": "current content exceeds scope byte cap"},
                 {"source_path": "src/b.rs", "path": "src/b.rs",
                  "resolution": "same-path-current", "disposition": "deferred-split",
                  "reason": "deferred to follow-up review push-x-p2 (review scope cap)"},
                 {"source_path": "vendor/x.rs", "path": "vendor/x.rs",
                  "resolution": "same-path-current", "disposition": "excluded-config",
                  "reason": "excluded by repos config for o/jcode"}]
        document = self.receipt_document(
            item_id="push-jcode-ae0f09de39-a047a0c07b", outcome="partial-scope",
            run_id="push-jcode-ae0f09de39-a047a0c07b-20261108T053626Z",
            source={"type": "push-range", "repo": "o/jcode", "base": "e" * 40,
                    "head": "f" * 40, "policy": review_receipt.POLICY})
        capture = {**document["capture"], "paths": paths,
                   "scope_digest": review_receipt.digest(paths)}
        capture["equivalence"] = review_receipt.current_equivalence(capture)
        document["capture"] = capture
        document.update(overrides)
        return document

    def test_push_range_receipts_validate_as_their_own_family(self):
        valid = self.push_document()
        split_part = self.push_document(source={**valid["source"], "pin": "a" * 40,
                                                "paths_filter": ["src/b.rs"]})
        merged = self.receipt_document()
        cases = {
            "valid": (valid, None),
            "split-part": (split_part, None),
            "short-head": (self.push_document(source={**valid["source"], "head": "f" * 12}),
                           "push-range subject"),
            "foreign-policy": (self.push_document(source={**valid["source"], "policy": "x"}),
                               "push-range subject"),
            "bad-pin": (self.push_document(source={**valid["source"], "pin": "main"}),
                        "pin"),
            "empty-filter": (self.push_document(source={**valid["source"], "paths_filter": []}),
                             "paths_filter"),
            "counted-unfinished": (self.push_document(
                classification={"counted": False, "outcome": "failed"}), "terminal outcome"),
            # Shared checks still apply to the push family.
            "scope-digest": (self.push_document(
                capture={**valid["capture"], "scope_digest": "e" * 64}), "scope digest"),
            # deferred-split and excluded-config are push-only dispositions.
            "merged-deferred-split": (self.receipt_document(capture={
                **merged["capture"], "paths": valid["capture"]["paths"][:3],
                "scope_digest": review_receipt.digest(valid["capture"]["paths"][:3])}),
                "path manifest"),
            "merged-excluded-config": (self.receipt_document(capture={
                **merged["capture"], "paths": valid["capture"]["paths"][3:],
                "scope_digest": review_receipt.digest(valid["capture"]["paths"][3:])}),
                "path manifest"),
            "unknown-disposition": (self.push_document(capture={
                **valid["capture"],
                "paths": [{**valid["capture"]["paths"][0], "disposition": "skipped"}],
                "scope_digest": review_receipt.digest(
                    [{**valid["capture"]["paths"][0], "disposition": "skipped"}])}),
                "path manifest"),
            # A merged subject missing its PR is still not a push receipt.
            "merged-no-pr": (self.receipt_document(source={**merged["source"], "pr": 0}),
                             "merged-current subject"),
        }
        for label, (document, expected) in cases.items():
            with self.subTest(label=label):
                data = review_receipt.canonical(document)
                problem = dc.receipt_problem(hashlib.sha256(data).hexdigest() + ".json", data)
                if expected is None:
                    self.assertIsNone(problem)
                else:
                    self.assertIn(expected, problem)

    def install_local_review_schema(self):
        target = self.root / dc.LOCAL_REVIEW_SCHEMA
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT.parent.parent / dc.LOCAL_REVIEW_SCHEMA, target)

    def local_document(self, **overrides):
        """A receipt shaped exactly like local_review_runtime.complete()."""
        inputs = {"v": 1, "repo": "o/r", "base_commit": "a" * 40, "base_tree": "b" * 40,
                  "head_commit": "c" * 40, "head_tree": "d" * 40, "scope": "full-diff",
                  "projection": "git-diff-full", "config_digest": "e" * 64,
                  "profile": {"adapter": "coderabbit-cli", "revision": "1"}}
        document = {"v": 1, "kind": "local-review-full-diff",
                    "identity": review_receipt.digest(inputs), "identity_inputs": inputs,
                    "profile": {"adapter": "coderabbit-cli", "revision": "1",
                                "flags": ["--agent"]},
                    "run_id": "local-1-20261108T000000Z", "outcome": "findings",
                    "scope_adequate": True, "findings": [{"type": "finding"}],
                    "report": "# findings", "observed": {"exit_code": 0},
                    "independent_acceptance": False}
        document.update(overrides)
        return document

    def test_local_review_receipts_use_the_deployment_schema(self):
        import review_operation
        self.install_local_review_schema()
        schema = dc.receipt_schema(self.effects)
        self.assertEqual(schema["local_review_source"],
                         "deployment:" + dc.LOCAL_REVIEW_SCHEMA)
        valid = self.local_document()
        # The fixture is a real receipt under the runner's own contract.
        review_operation.validate("receipt", valid)
        cases = {
            "valid": (valid, None),
            "no-verdict": (self.local_document(outcome="no-verdict", scope_adequate=False,
                                               findings=[]), None),
            "extra-field": (self.local_document(extra=1), "unknown extra"),
            "wrong-v": (self.local_document(v=2), "local-review schema: v"),
            "bad-head": (self.local_document(identity_inputs={
                **valid["identity_inputs"], "head_commit": "main"}), "head_commit"),
            "identity-unbound": (self.local_document(identity="0" * 64), "identity"),
            "contradicting-outcome": (self.local_document(outcome="clean"), "contradicts"),
            "verdict-without-scope": (self.local_document(scope_adequate=False),
                                      "without adequate scope"),
            "unknown-family": ({**valid, "kind": "other-kind"}, "family: other-kind"),
        }
        for label, (document, expected) in cases.items():
            with self.subTest(label=label):
                data = review_receipt.canonical(document)
                problem = dc.receipt_problem(hashlib.sha256(data).hexdigest() + ".json",
                                             data, schema)
                if expected is None:
                    self.assertIsNone(problem)
                else:
                    self.assertIn(expected, problem)

    def test_local_review_without_deployment_schema_is_unverified_not_accepted(self):
        schema = dc.receipt_schema(self.effects)  # fixture root has no policy/
        self.assertTrue(schema["local_review_source"].startswith("unavailable"))
        data = review_receipt.canonical(self.local_document())
        problem = dc.receipt_problem(hashlib.sha256(data).hexdigest() + ".json", data, schema)
        self.assertIn("unverified", problem)

    def test_mixed_family_sample_reports_family_per_receipt(self):
        self.install_local_review_schema()
        self.write_receipt(self.receipt_document())
        self.write_receipt(self.push_document())
        self.write_receipt(self.local_document())
        bad_push = self.write_receipt(self.push_document(
            source={**self.push_document()["source"], "base": "nope"}))
        validation = dc.receipt_validation(self.effects)
        self.assertEqual(validation["families"],
                         {"merged-current": 1, "push-range": 2, "local-review-full-diff": 1})
        self.assertEqual(validation["invalid"], [{
            "receipt": bad_push, "family": "push-range",
            "reason": "target: source binding is not a v1 push-range subject"}])
        self.assertEqual(validation["local_review_schema_source"],
                         "deployment:" + dc.LOCAL_REVIEW_SCHEMA)

    def install_receipt_sources(self, selectors=None):
        shutil.copy(ROOT / "runtime_target.py", self.runner / "runtime_target.py")
        source = (ROOT / "review_receipt.py").read_text()
        if selectors is not None:
            old = 'SELECTORS = {"promoted-main": DEFAULT_REF, LEGACY_BRANCH: DEFAULT_REF}'
            self.assertIn(old, source)
            source = source.replace(old, selectors)
        (self.runner / "review_receipt.py").write_text(source)

    def test_schema_constants_come_from_the_deployment_tree_read_only(self):
        self.install_receipt_sources(
            'SELECTORS = {"promoted-main": DEFAULT_REF, LEGACY_BRANCH: DEFAULT_REF,'
            ' "release-train": DEFAULT_REF}')
        sentinel = self.base / "executed"
        with (self.runner / "review_receipt.py").open("a") as out:
            out.write("\nopen(%r, 'w').write('ran')\n" % str(sentinel))
        schema = dc.receipt_schema(self.effects)
        self.assertEqual(schema["schema_source"],
                         "deployment:apps/crq-python/review_receipt.py")
        self.assertEqual(schema["targets"], ("promoted-main", "merge-queue", "release-train"))
        self.assertEqual((schema["policy"], schema["version"]),
                         (review_receipt.POLICY, review_receipt.VERSION))
        self.assertFalse(sentinel.exists())  # parsed, never executed
        document = self.receipt_document(
            source={**self.receipt_document()["source"], "target_selector": "release-train"})
        self.write_receipt(document)
        validation = dc.receipt_validation(self.effects)
        self.assertIs(validation["valid"], True, validation["invalid"])
        self.assertEqual(validation["schema_source"], schema["schema_source"])
        # The builtin copy would have reported the new selector as invalid.
        data = review_receipt.canonical(document)
        self.assertIn("target", dc.receipt_problem(
            hashlib.sha256(data).hexdigest() + ".json", data))

    def test_unusable_deployment_sources_fall_back_to_recorded_builtin(self):
        # Fixture checkouts carry no review_receipt.py: missing source.
        schema = dc.receipt_schema(self.effects)
        self.assertTrue(schema["schema_source"].startswith("builtin"), schema)
        self.assertIn("FileNotFoundError", schema["schema_source"])
        self.assertEqual(schema["targets"], dc.RECEIPT_TARGETS)
        for broken in ("def (:\n", 'POLICY = 7\nVERSION = 1\nSELECTORS = {"a": 1}\n',
                       "VERSION = 1\nSELECTORS = {UNKNOWN: 1}\n"):
            with self.subTest(broken=broken):
                self.install_receipt_sources()
                (self.runner / "review_receipt.py").write_text(broken)
                schema = dc.receipt_schema(self.effects)
                self.assertTrue(schema["schema_source"].startswith("builtin"), schema)
                self.assertEqual(schema["policy"], dc.RECEIPT_POLICY)
        self.write_receipt(self.receipt_document())
        validation = dc.receipt_validation(self.effects)
        self.assertIs(validation["valid"], True)
        self.assertTrue(validation["schema_source"].startswith("builtin"))

    def test_later_non_literal_rebinding_makes_a_constant_unresolved(self):
        for rebinding in ('POLICY = "-".join(["x", "y"])\n',
                          'POLICY: str = "affected-current-additions-v1"\n',
                          "POLICY += ''\n", "from os import sep as POLICY\n",
                          "def POLICY():\n    pass\n",
                          "if True:\n    POLICY = 'other'\n",
                          "for POLICY in ():\n    pass\n", "del POLICY\n"):
            with self.subTest(rebinding=rebinding):
                self.install_receipt_sources()
                with (self.runner / "review_receipt.py").open("a") as out:
                    out.write("\n" + rebinding)
                schema = dc.receipt_schema(self.effects)
                self.assertTrue(schema["schema_source"].startswith("builtin"), schema)
                self.assertIn("POLICY", schema["schema_source"])
        # The same for an imported selector key rebound in runtime_target.
        self.install_receipt_sources()
        with (self.runner / "runtime_target.py").open("a") as out:
            out.write("\nLEGACY_BRANCH = DEFAULT_BRANCH.upper()\n")
        schema = dc.receipt_schema(self.effects)
        self.assertTrue(schema["schema_source"].startswith("builtin"), schema)
        self.assertIn("LEGACY_BRANCH", schema["schema_source"])

    def test_only_the_needed_constants_are_resolved(self):
        self.install_receipt_sources()
        with (self.runner / "review_receipt.py").open("a") as out:
            out.write("\nUNRELATED = {UNKNOWN_NAME: 1, f'{POLICY}': 2, (1, 2): 3}\n"
                      "OTHER = compute()\nLATER = {**SELECTORS}\n"
                      "def helper():\n    POLICY = 'local only'\n    return POLICY\n")
        with (self.runner / "runtime_target.py").open("a") as out:
            out.write("\nUNRELATED_TARGETS = {object(): 1}\n")
        schema = dc.receipt_schema(self.effects)
        self.assertEqual(schema["schema_source"],
                         "deployment:apps/crq-python/review_receipt.py")
        self.assertEqual(schema["targets"], ("promoted-main", "merge-queue"))
        self.assertEqual(schema["policy"], review_receipt.POLICY)

    def test_valid_bounded_receipt_sample_and_stalled_tick_stay_independent(self):
        for index in range(dc.RECEIPT_SAMPLE + 2):
            self.write_receipt(self.receipt_document(item_id="current-%d" % index))
        self.complete_tick("2026-10-28T00:00:00Z")
        result = dc.two_slot_health(self.effects, self.observe_after(
            ["2026-10-28T00:00:00Z"]))
        self.assertFalse(result["healthy"])  # tick stalled
        self.assertIs(result["receipts_valid"], True)  # receipts still valid
        validation = result["observations"][0]["receipt_validation"]
        self.assertEqual((validation["sampled"], validation["valid_count"]),
                         (dc.RECEIPT_SAMPLE, dc.RECEIPT_SAMPLE))

    def test_advancing_queue_saves_cannot_substitute_for_completion(self):
        self.complete_tick("2026-10-28T00:00:00Z")
        self.write_state("queue.json", {"last_tick": "2026-10-28T00:00:00Z"})
        queue_ticks = iter(["2026-10-28T00:05:00Z", "2026-10-28T00:10:00Z"])

        def observe(prior):
            # The queue keeps saving advancing ticks (crq.py persists
            # last_tick before completion) while no tick ever completes.
            self.write_state("queue.json", {"last_tick": next(queue_ticks)})
            return dc.health_observation(self.effects, prior)

        result = dc.two_slot_health(self.effects, observe)
        self.assertFalse(result["healthy"])
        self.assertIn("first observation", result["reason"])
        queue = json.loads((self.runner / "state/queue.json").read_text())
        self.assertEqual(queue["last_tick"], "2026-10-28T00:05:00Z")
        self.assertEqual(result["observations"][0]["observed_tick"],
                         "2026-10-28T00:00:00Z")

    def test_queue_tick_alone_never_satisfies_the_baseline(self):
        self.write_state("queue.json", {"last_tick": "2026-10-28T00:10:00Z"})
        with self.assertRaisesRegex(dc.Refused, "no completion heartbeat"):
            dc._tick_value(self.effects)

    def test_same_completed_tick_seen_twice_is_one_slot_not_two(self):
        self.complete_tick("2026-10-28T00:00:00Z")
        result = dc.two_slot_health(self.effects, self.observe_after(
            ["2026-10-28T00:00:00Z"]))
        self.assertFalse(result["healthy"])
        self.assertIn("first observation", result["reason"])

    def test_second_observation_stalled_is_unhealthy(self):
        self.complete_tick("2026-10-28T00:00:00Z")
        result = dc.two_slot_health(self.effects, self.observe_after(
            ["2026-10-28T00:05:00Z", "2026-10-28T00:05:00Z"]))
        self.assertFalse(result["healthy"])
        self.assertIn("second observation", result["reason"])

    def test_regressing_completion_is_not_advancement(self):
        self.complete_tick("2026-10-28T00:05:00Z")
        result = dc.two_slot_health(self.effects, self.observe_after(
            ["2026-10-28T00:10:00Z", "2026-10-28T00:00:00Z"]))
        self.assertFalse(result["healthy"])
        self.assertIn("second observation", result["reason"])

    def test_missing_baseline_heartbeat_refuses(self):
        with self.assertRaisesRegex(dc.Refused, "no completion heartbeat"):
            dc._tick_value(self.effects)

    def test_observation_stage_corruption_refuses(self):
        self.complete_tick("2026-10-28T00:00:00Z")

        def observe(prior):
            self.write_raw_heartbeat("{broken")
            return dc.health_observation(self.effects, prior)

        with self.assertRaisesRegex(dc.Refused, "not valid JSON"):
            dc.two_slot_health(self.effects, observe)

    def test_invalid_json_heartbeat_refuses(self):
        self.write_raw_heartbeat("{broken")
        with self.assertRaisesRegex(dc.Refused, "not valid JSON"):
            dc._tick_value(self.effects)

    def test_non_object_heartbeat_refuses(self):
        for raw in ['["2026-10-28T00:00:00Z"]\n', '"2026-10-28T00:00:00Z"\n',
                    "7\n"]:
            with self.subTest(raw=raw):
                self.write_raw_heartbeat(raw)
                with self.assertRaisesRegex(dc.Refused, "not a JSON object"):
                    dc._tick_value(self.effects)

    def test_heartbeat_not_bound_to_this_checkout_refuses(self):
        other = self.base / "other-deploy/apps/crq-python"
        for root in [None, str(other), 12345]:
            with self.subTest(root=root):
                self.complete_tick("2026-10-28T00:00:00Z", root=root)
                with self.assertRaisesRegex(dc.Refused, "runner directory"):
                    dc._tick_value(self.effects)

    def test_calendar_invalid_timestamp_refuses(self):
        for tick in ["2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z",
                     "2026-10-28T24:00:00Z", "2026-10-28T00:60:00Z"]:
            with self.subTest(tick=tick):
                self.complete_tick(tick)
                with self.assertRaisesRegex(dc.Refused, "strict UTC"):
                    dc._tick_value(self.effects)

    def test_non_strict_timestamp_shape_refuses(self):
        for tick in ["2026-10-28T00:00:00+00:00", "2026-10-28 00:00:00Z",
                     "2026-1-28T00:00:00Z", "2026-10-28T00:00:00",
                     "2026-10-28T00:00:00.000Z", "yesterday-ish"]:
            with self.subTest(tick=tick):
                self.complete_tick(tick)
                with self.assertRaisesRegex(dc.Refused, "strict UTC"):
                    dc._tick_value(self.effects)

    def test_non_string_last_tick_refuses(self):
        self.complete_tick(20261028)  # the producer only ever writes strings
        with self.assertRaisesRegex(dc.Refused, "strict UTC"):
            dc._tick_value(self.effects)

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0,
                     "root ignores file permission bits")
    def test_unreadable_heartbeat_refuses(self):
        self.complete_tick("2026-10-28T00:00:00Z")
        (self.watchdog / "heartbeat.json").chmod(0o000)
        with self.assertRaisesRegex(dc.Refused, "unreadable"):
            dc._tick_value(self.effects)
