"""Reproducibility and Python-oracle tests for the group-P vector fixtures."""
import copy
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import admission_history
import backfill_accounting
import backfill_inventory
import backfill_jobs
import backfill_report
import author_quota
import coverage
import crq
import crq_repair
import merged_reconcile
import queue_time
import review_ledger
import review_operation
import review_receipt
import status_summary
import usage_slots
import vector_emit


HERE = Path(__file__).resolve().parent
FIXTURE_ROOT = HERE / "fixtures" / "group-p"
STATE_FIXTURE = HERE / "fixtures" / "state-20261109"
FAMILIES = list(vector_emit.BUILDERS)


def utc(value):
    return None if value is None else value.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class _ReportRepo:
    """Minimal replay stub matching the documented report vector inputs."""

    def __init__(self, spec):
        self.trees = dict(spec.get("tree", {}))
        self.lineages = {(row["old"], row["new"], row["path"]): row.get("result")
                         for row in spec.get("lineage", [])}
        self.deleted = {(row["old"], row["new"], row["path"]): bool(row.get("result"))
                        for row in spec.get("proven_deleted", [])}
        self.carries = {(row["old"], row["new"], row["path"]):
                        (row.get("result"), {int(k): int(v) for k, v in row.get("mapped", [])})
                        for row in spec.get("carry", [])}

    def tree(self, target):
        return self.trees[target]

    def lineage(self, old, new, path):
        return self.lineages.get((old, new, path))

    def proven_deleted(self, old, new, path):
        return self.deleted.get((old, new, path), False)

    def carry(self, old, new, path, lines):
        found = self.carries.get((old, new, path))
        if found is None:
            return None, set()
        mapped, matches = found
        return mapped, {matches[number] for number in lines if number in matches}


def invoke(source, inputs):
    """Call the Python oracle from the vector's JSON arguments.

    This is deliberately independent of the emitter's closures: it reads the
    recorded `source` and `input`, so a vector cannot pass by replaying the
    emitter's own output.
    """
    if source == "review_receipt.canonical+digest":
        raw = review_receipt.canonical(inputs["value"])
        return {"canonical": raw.decode("ascii"),
                "sha256": hashlib.sha256(raw).hexdigest()}
    if source == "review_ledger.canonical+digest":
        raw = review_ledger.canonical(inputs["value"])
        return {"canonical": raw.decode("utf-8"),
                "sha256": hashlib.sha256(raw).hexdigest()}
    if source == "crq_repair.atomic":
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "queue.json"
            value = (json.loads(inputs["raw"]) if "raw" in inputs
                     else inputs["value"])
            crq_repair.atomic(path, value)
            data = path.read_bytes()
        return {"text": data.decode("utf-8"),
                "sha256": hashlib.sha256(data).hexdigest()}
    if source == "queue_time.parse_utc":
        return {"utc": utc(queue_time.parse_utc(inputs["value"]))}
    if source == "crq.parse_iso":
        return {"utc": utc(crq.parse_iso(inputs["value"]))}
    if source == "usage_slots.parse_usage":
        return usage_slots.parse_usage(inputs["stream"])
    if source == "usage_slots.next_slot":
        starts = [queue_time.parse_utc(value) for value in inputs["starts"]]
        at = queue_time.parse_utc(inputs["at"])
        return {"utc": utc(usage_slots.next_slot(starts, at, inputs["usage"]))}
    if source == "crq.classify":
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "review.ndjson"
            if inputs["ndjson"] is not None:
                path.write_text(inputs["ndjson"])
            return crq.classify(path, inputs["exit_code"])
    if source == "crq.live_items":
        return {"live_ids": [item["id"] for item in crq.live_items(inputs["queue"])]}
    if source == "merged_reconcile.normalize_interval":
        return merged_reconcile.normalize_interval(inputs["after"], inputs["before"])
    if source == "merged_reconcile.normalize_page_budget":
        return merged_reconcile.normalize_page_budget(inputs["budget"])
    if source == "merged_reconcile.record_identity":
        return merged_reconcile.record_identity(inputs["record"])
    if source == "merged_reconcile.checkpoint_digest":
        return merged_reconcile.checkpoint_digest(inputs["checkpoint"])
    if source == "merged_reconcile.new_checkpoint":
        return merged_reconcile.new_checkpoint(inputs["interval"], inputs["page_budget"],
                                                repo=inputs["repo"], base=inputs["base"])
    if source == "merged_reconcile.reconcile_page":
        checkpoint = copy.deepcopy(inputs["checkpoint"])
        for page in inputs["pages"]:
            checkpoint = merged_reconcile.reconcile_page(checkpoint, page)
        return checkpoint
    if source == "merged_reconcile.load_checkpoint":
        return merged_reconcile.load_checkpoint(
            inputs["checkpoint"], inputs["interval"], inputs["page_budget"],
            repo=inputs["repo"], base=inputs["base"],
            allow_complete=inputs["allow_complete"])
    if source == "coverage.utilization_digest":
        return coverage.utilization_digest(inputs["queue"], inputs["ledger"],
                                           now=inputs["now"],
                                           max_starts_per_hour=inputs["max_starts_per_hour"])
    if source == "coverage.coverage_candidate":
        return coverage.coverage_candidate(
            inputs["queue"], inputs["ledger"], merge_queue_sha=inputs["merge_queue_sha"],
            ordinary_eligible=inputs["ordinary_eligible"], now=inputs["now"],
            max_paths=inputs["max_paths"], min_age_hours=inputs["min_age_hours"],
            excluded_paths=inputs["excluded_paths"])
    if source == "coverage.record_opportunity":
        return coverage.record_opportunity(
            inputs["ledger"], at=inputs["now"], started=inputs["started"],
            pending=inputs["pending"], candidate_exists=inputs["candidate_exists"],
            blocked_reason=inputs["blocked_reason"])
    if source == "backfill_accounting.ranges":
        return backfill_accounting.ranges(inputs["lines"])
    if source == "admission_history.summarize":
        return admission_history.summarize(inputs["decision"])
    if source == "backfill_jobs.admission":
        queue = copy.deepcopy(inputs["queue"])
        item = copy.deepcopy(inputs["item"])
        decision = backfill_jobs.admission(queue, item, inputs["at"],
                                           inputs["observation"],
                                           inputs["ordinary_eligible"],
                                           reserve=inputs["reserve"])
        return {"decision": decision, "queue": queue, "item": item}
    if source == "backfill_inventory.rank":
        return backfill_inventory.rank(inputs["manifest"], inputs["inputs"])
    if source == "backfill_accounting.line_bytes":
        return [base64.b64encode(row).decode("ascii") for row in
                backfill_accounting.line_bytes(base64.b64decode(inputs["base64"]))]
    if source == "backfill_accounting._int":
        return backfill_accounting._int(inputs["value"], inputs["low"])
    if source == "backfill_accounting._opt_str":
        return backfill_accounting._opt_str(inputs["value"])
    if source == "backfill_accounting._rows":
        return backfill_accounting._rows(inputs["value"])
    if source == "backfill_accounting._hexstr":
        return backfill_accounting._hexstr(inputs["value"])
    if source == "backfill_accounting.FACT_SHAPES":
        return backfill_accounting.FACT_SHAPES[inputs["kind"]](inputs["value"])
    if source == "backfill_report.baseline":
        repo = _ReportRepo({"tree": {inputs["ranked"]["target"]: inputs["tree"]}})
        return backfill_report.baseline(repo, inputs["ranked"],
                                        inputs["policy_digest"],
                                        inputs["ledger_head"], inputs["at"])
    if source == "backfill_report.summary":
        return backfill_report.summary(_ReportRepo(inputs["repo"]),
                                       inputs["ranked"], inputs["queue"],
                                       inputs["original"])
    if source == "status_summary.timestamp":
        return {"epoch": status_summary.timestamp(inputs["value"])}
    if source == "status_summary.merged_current":
        return status_summary.merged_current(inputs["queue"])
    if source == "status_summary.repos_summary":
        return status_summary.repos_summary(inputs["queue"], inputs["primary"],
                                            inputs["configured"])
    if source == "review_ledger.timestamp":
        return review_ledger.timestamp(inputs["value"]).isoformat()
    if source == "review_ledger.path":
        return review_ledger.path(inputs["value"])
    if source == "review_ledger.intervals":
        return sorted(review_ledger.intervals(inputs["rows"]))
    if source == "review_ledger.scope":
        result = review_ledger.scope(inputs["rows"])
        return sorted([list(key) + [sorted(value)] for key, value in result.items()])
    if source == "review_ledger.validate":
        return review_ledger.validate(copy.deepcopy(inputs["event"]))
    if source == "review_ledger.validate_sequence":
        return sorted(review_ledger.validate_sequence(copy.deepcopy(inputs["events"])))
    if source == "review_ledger.creditable":
        return review_ledger.creditable(inputs["value"])
    if source == "status_summary.summarize":
        return status_summary.summarize(inputs["status"], inputs["queue"],
                                        inputs["heartbeat"], inputs["config"],
                                        inputs["events"], inputs["now"])
    if source in SCHEDULE_REPLAYS:
        return _schedule_replay(source, inputs)
    if source == "author_quota.identity_kind":
        return author_quota.identity_kind(
            inputs["pidfile"], run_id=inputs.get("run_id"),
            queue_pid=inputs.get("queue_pid"))
    if source == "author_quota.run_state":
        return author_quota.run_state(
            has_exit=inputs["has_exit"], identity=inputs["identity"],
            runner_alive=inputs["runner_alive"], cli_alive=inputs["cli_alive"],
            runner_group_alive=inputs["runner_group_alive"],
            wrapper_group_alive=inputs["wrapper_group_alive"])
    if source == "crq.ident_pid":
        return crq.ident_pid(inputs["value"])
    if source == "crq.admit_available":
        return _admission_replay(inputs)
    raise AssertionError(f"no replay for {source}")


SCHEDULE_REPLAYS = {
    "crq.rank": lambda inputs: crq.rank(inputs["item"]),
    "crq.sort_key": lambda inputs: list(crq.sort_key(inputs["item"])),
    "crq.launch_band": lambda inputs: crq.launch_band(inputs["item"]),
    "crq.deps_met": lambda inputs: crq.deps_met(inputs["queue"], inputs["item"]),
    "crq.optional_wait": lambda inputs: crq.optional_wait(inputs["queue"], inputs["item"]),
    "crq.parked_merged_linked_receipt": lambda inputs: crq.parked_merged_linked_receipt(
        inputs["queue"], inputs["item"]),
    "crq.inflight": lambda inputs: [item["id"] for item in crq.inflight(inputs["queue"])],
    "crq.has_collectable_runs": lambda inputs: crq.has_collectable_runs(inputs["queue"]),
    "crq.background_turn": lambda inputs: crq.background_turn(inputs["queue"]),
    "crq.starts_last_hour": lambda inputs: crq.starts_last_hour(inputs["queue"]),
    "crq.item_repo": lambda inputs: crq.item_repo(inputs["item"]),
}


def _schedule_replay(source, inputs):
    """Replay one scheduling row with the vector's recorded module bindings."""
    config = {**crq.CONFIG, "local_review_aging_minutes": inputs["local_review_aging_minutes"]}
    with patch.multiple(
            crq, REPO=inputs["primary_repo"], REPOS=inputs["repos"],
            CONFIG=config, now=lambda: queue_time.parse_utc(inputs["now"])):
        return SCHEDULE_REPLAYS[source](inputs)


def _admission_replay(inputs):
    """Replay `crq.admit_available` with launch and backfill context stubbed."""
    queue = copy.deepcopy(inputs["queue"])
    queue["starts"] = list(queue.get("starts", []))
    calls = []

    def stub_start_one(q, log, dry, only, ignore_quiet, capture_current=True):
        calls.append(len(q["starts"]))
        q["starts"].append("2026-11-14T00:00:00Z")
        return "stub-run", False

    log = []
    config = {"max_starts_per_hour": inputs["max_starts_per_hour"],
              "max_starts_per_tick": inputs["max_starts_per_tick"],
              "max_inflight": inputs["max_inflight"]}
    with patch.object(crq, "start_one", stub_start_one), \
            patch.object(crq.backfill_runtime, "usage_context", lambda *a, **k: None), \
            patch.multiple(crq, CONFIG=config,
                           now=lambda: queue_time.parse_utc(inputs["now"])):
        _, gate, remaining = crq.admit_available(
            queue, inputs["usage"], log, reserved=tuple(inputs["reserved"]))
    return {
        "gate": gate,
        "remaining": remaining,
        "start_attempts": len(calls),
        "log": log,
        "starts": len(queue["starts"]),
        "usage": queue.get("usage"),
        "backfill_starts_at_observation": queue.get("backfill_starts_at_observation"),
    }


class VectorFileTest(unittest.TestCase):
    def test_checked_in_files_match_the_emitter(self):
        self.assertEqual(vector_emit.check(), 0)

    def test_check_rejects_byte_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "canonical.json"
            path.write_text(vector_emit.encode(vector_emit.build()["canonical"]) + " ")
            with patch.object(vector_emit, "filenames", return_value={"canonical": path}):
                self.assertEqual(vector_emit.check(), 1)

    def test_build_is_reproducible_in_process(self):
        self.assertEqual(vector_emit.encode(vector_emit.build()),
                         vector_emit.encode(vector_emit.build()))

    def test_subprocess_emission_is_independent_of_hash_seed(self):
        command = [sys.executable, str(HERE / "vector_emit.py"), "--stdout"]
        first = subprocess.run(
            command, cwd=HERE, capture_output=True, text=True,
            env={**os.environ, "PYTHONHASHSEED": "0"}, check=False)
        second = subprocess.run(
            command, cwd=HERE, capture_output=True, text=True,
            env={**os.environ, "PYTHONHASHSEED": "12345"}, check=False)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(first.stdout, second.stdout)
        self.assertEqual(first.stdout, vector_emit.encode(vector_emit.build()))

    def test_every_family_and_row_has_the_documented_shape(self):
        seen = set()
        for family in FAMILIES:
            with self.subTest(family=family):
                document = json.loads((FIXTURE_ROOT / f"{family}.json").read_text())
                self.assertEqual(document["schema"], vector_emit.SCHEMA)
                self.assertEqual(document["family"], family)
                self.assertTrue(document["cases"], "family has no cases")
                for case in document["cases"]:
                    self.assertLessEqual(set(case), {"name", "source", "input",
                                                     "expect", "note"})
                    self.assertIsInstance(case["name"], str)
                    self.assertIsInstance(case["source"], str)
                    self.assertIsInstance(case["input"], dict)
                    self.assertIn(case["source"], {
                        "review_receipt.canonical+digest",
                        "review_ledger.canonical+digest",
                        "crq_repair.atomic",
                        "queue_time.parse_utc",
                        "crq.parse_iso",
                        "usage_slots.parse_usage",
                        "usage_slots.next_slot",
                        "crq.classify",
                        "crq.live_items",
                        "merged_reconcile.normalize_interval",
                        "merged_reconcile.normalize_page_budget",
                        "merged_reconcile.record_identity",
                        "merged_reconcile.checkpoint_digest",
                        "merged_reconcile.new_checkpoint",
                        "merged_reconcile.reconcile_page",
                        "merged_reconcile.load_checkpoint",
                        "coverage.utilization_digest",
                        "coverage.coverage_candidate",
                        "coverage.record_opportunity",
                        "backfill_accounting.ranges",
                        "admission_history.summarize",
                        "backfill_jobs.admission",
                        "backfill_inventory.rank",
                        "backfill_accounting.line_bytes",
                        "backfill_accounting._int",
                        "backfill_accounting._opt_str",
                        "backfill_accounting._rows",
                        "backfill_accounting._hexstr",
                        "backfill_accounting.FACT_SHAPES",
                        "backfill_report.baseline",
                        "backfill_report.summary",
                        "status_summary.timestamp",
                        "status_summary.merged_current",
                        "status_summary.repos_summary",
                        "review_ledger.timestamp",
                        "review_ledger.path",
                        "review_ledger.intervals",
                        "review_ledger.scope",
                        "review_ledger.validate",
                        "review_ledger.validate_sequence",
                        "review_ledger.creditable",
                        "status_summary.summarize",
                        "crq.rank",
                        "crq.sort_key",
                        "crq.launch_band",
                        "crq.deps_met",
                        "crq.optional_wait",
                        "crq.parked_merged_linked_receipt",
                        "crq.inflight",
                        "crq.has_collectable_runs",
                        "crq.background_turn",
                        "crq.starts_last_hour",
                        "crq.item_repo",
                        "author_quota.identity_kind",
                        "author_quota.run_state",
                        "crq.ident_pid",
                        "crq.admit_available",
                    })
                    key = (family, case["name"])
                    self.assertNotIn(key, seen, "duplicate case name in family")
                    seen.add(key)
                    expect = case["expect"]
                    self.assertIsInstance(expect["ok"], bool)
                    if expect["ok"]:
                        self.assertIn("value", expect)
                        self.assertNotIn("error", expect)
                    else:
                        self.assertIn("error", expect)
                        self.assertNotIn("value", expect)

    def test_vectors_carry_no_private_or_secret_material(self):
        banned = ("/home/", "/Users/", "crq-deploy", "ghp_", "github_pat_",
                  "BEGIN OPENSSH", "BEGIN RSA", "AKIA", "private_key")
        for path in sorted(FIXTURE_ROOT.glob("*.json")):
            text = path.read_text()
            for marker in banned:
                with self.subTest(path=path.name, marker=marker):
                    self.assertNotIn(marker, text)
            for match in re.findall(r'"canonical": "([^"]*)"', text):
                self.assertNotRegex(match, r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")

    def test_fractional_timestamp_vector_keeps_the_fraction(self):
        document = json.loads((FIXTURE_ROOT / "status-helpers.json").read_text())
        case = next(row for row in document["cases"] if row["name"] == "fraction-accepted")
        value = status_summary.timestamp(case["input"]["value"])
        self.assertIsInstance(value, float)
        self.assertEqual(value, 1794182400.5)
        self.assertEqual(case["expect"]["value"], {"epoch": value})
        self.assertNotEqual(case["expect"]["value"]["epoch"], int(value))

    def test_every_recorded_result_replays_against_the_python_source(self):
        for family in FAMILIES:
            document = json.loads((FIXTURE_ROOT / f"{family}.json").read_text())
            for case in document["cases"]:
                with self.subTest(family=family, case=case["name"]):
                    try:
                        value = invoke(case["source"], case["input"])
                    except Exception as exc:
                        self.assertFalse(
                            case["expect"]["ok"],
                            f"{case['name']} failed unexpectedly: {exc!r}")
                        self.assertEqual(type(exc).__name__, case["expect"]["error"])
                    else:
                        self.assertTrue(
                            case["expect"]["ok"],
                            f"{case['name']} succeeded but the vector records a refusal")
                        self.assertEqual(value, case["expect"]["value"])


class StateFixtureTest(unittest.TestCase):
    def setUp(self):
        self.queue = json.loads((STATE_FIXTURE / "queue.json").read_text())
        self.heartbeat = json.loads((STATE_FIXTURE / "heartbeat.json").read_text())
        self.events = [json.loads(line) for line in
                       (STATE_FIXTURE / "events.jsonl").read_text().splitlines()
                       if line.strip()]
        self.config = {"repo": "example/primary", "max_starts_per_hour": 5,
                       "local_review_aging_minutes": 60,
                       "repos": [{"repo": "example/other", "rank_tier": 3}]}

    def test_queue_ids_are_unique_and_timestamps_parse(self):
        identifiers = [item["id"] for item in self.queue["items"]]
        self.assertEqual(len(identifiers), len(set(identifiers)))
        kinds = {item["kind"] for item in self.queue["items"]}
        self.assertLessEqual({"open", "merged", "merged-current", "coverage",
                              "local-review", "backfill"}, kinds)
        for item in self.queue["items"]:
            self.assertIn("state", item)
        for value in self.queue["starts"]:
            self.assertIsNotNone(queue_time.parse_utc(value))
        for value in (self.queue["last_tick"], self.queue["cooldown_until"]):
            self.assertIsNotNone(queue_time.parse_utc(value))
        for event in self.events:
            self.assertIsNotNone(queue_time.parse_utc(event["at"]))
        self.assertIsNotNone(queue_time.parse_utc(self.heartbeat["last_tick"]))

    def test_derived_identities_and_capture_digests_are_consistent(self):
        for item in self.queue["items"]:
            if item["kind"] == "local-review":
                review_operation.validate("identity", item["identity_inputs"])
                self.assertEqual(item["identity"],
                                 review_receipt.digest(item["identity_inputs"]))
            capture = item.get("capture")
            if capture:
                self.assertEqual(capture["scope_digest"],
                                 review_receipt.digest(capture["paths"]))
                self.assertEqual(capture["equivalence"],
                                 review_receipt.current_equivalence(capture))

    def test_historical_promotion_items_stay_excluded(self):
        promotion = [item for item in self.queue["items"]
                     if item["kind"] == "promotion"]
        self.assertEqual({item["state"] for item in promotion}, {"done", "promoting"})
        promotion_ids = {item["id"] for item in promotion}
        live_ids = {item["id"] for item in crq.live_items(self.queue)}
        self.assertFalse(live_ids & promotion_ids)
        summary = status_summary.summarize(
            json.loads((STATE_FIXTURE / "status.json").read_text()),
            self.queue, self.heartbeat, self.config, self.events, 1794225600)
        self.assertNotIn("promotion", {row["kind"] for row in summary["pending_items"]})
        promotion_prs = {item["pr"] for item in promotion}
        self.assertFalse(promotion_prs & {row["pr"] for row in summary["pending_items"]})

    def test_summary_and_utilization_accept_the_fixture(self):
        summary = status_summary.summarize(
            json.loads((STATE_FIXTURE / "status.json").read_text()),
            self.queue, self.heartbeat, self.config, self.events, 1794225600)
        self.assertEqual(summary["status_as_of"], "2026-11-09T11:50:00Z")
        self.assertEqual(summary["backfill_reserved_slots"], 1)
        self.assertTrue(summary["pending_items"])
        utilization = coverage.utilization_digest(
            self.queue, self.queue["coverage"], now="2026-11-09T12:00:00Z",
            max_starts_per_hour=5)
        self.assertEqual(utilization["observed_ticks_24h"], 1)
        self.assertEqual(utilization["coverage_reviewed_paths"], 1)

    def test_run_classification_matches_the_current_classifier(self):
        run = STATE_FIXTURE / "runs" / "open-101-20261108T235500Z"
        recorded = json.loads((run / "classification.json").read_text())
        self.assertEqual(crq.classify(run / "review.ndjson", 0), recorded)
        meta = json.loads((run / "meta.json").read_text())
        self.assertEqual(meta["run_id"], run.name)
        exit_record = json.loads((run / "exit.json").read_text())
        self.assertEqual(exit_record["exit"], 0)
        self.assertFalse(exit_record["timed_out"])

    def test_state_fixture_carries_no_private_material(self):
        banned = ("/home/", "/Users/", "crq-deploy", "camerontaylor", "ceres",
                  "ghp_", "github_pat_", "BEGIN OPENSSH", "BEGIN RSA", "AKIA")
        for path in sorted(STATE_FIXTURE.rglob("*")):
            if path.suffix not in {".json", ".jsonl"}:
                continue
            text = path.read_text()
            for marker in banned:
                with self.subTest(path=path.name, marker=marker):
                    self.assertNotIn(marker, text)


if __name__ == "__main__":
    unittest.main()
