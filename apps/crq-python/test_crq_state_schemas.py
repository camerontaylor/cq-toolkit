"""On-disk crq state schemas describe what the Python writers actually emit.

Phase 0.2 of the TypeScript migration (crq-ts-migration-plan-20261109 §4):
the schemas under policy/crq/ are the contract the TS port will build on.
Nothing here is imported by a runtime path, and no schema tightens a reader:
every schema is validated against a representative fixture, and every
arbitrary-key map is checked value by value because the checked-in schema
vocabulary has no patternProperties.
"""
import json
from pathlib import Path
import re
import unittest

from review_ledger import _schema


ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "policy/crq"
FIXTURES = Path(__file__).resolve().parent / "fixtures/crq-state-schema-samples"
AUTHOR_CAPTURE = Path(__file__).resolve().parent / "fixtures/author-0e35cd11.json"

# Phase 0.3's synthetic, deployed-shape snapshot. It is another phase's file and
# is read here, never rewritten: the 0.2 schemas are its authority.
DEPLOYED = Path(__file__).resolve().parent / "fixtures/state-20261109"
DEPLOYED_DOCUMENTS = (
    ("queue.json", "queue.schema.json"),
    ("heartbeat.json", "heartbeat.schema.json"),
    ("repair/provider-cooldowns.json", "provider-cooldowns.schema.json"),
    ("runs/open-101-20261108T235500Z/meta.json", "run-meta.schema.json"),
    ("runs/open-101-20261108T235500Z/exit.json", "run-exit.schema.json"),
    ("runs/open-101-20261108T235500Z/classification.json", "run-classification.schema.json"),
    ("runs/open-101-20261108T235500Z/secret-scan.json", "run-secret-scan.schema.json"),
)
DEPLOYED_LINES = (
    ("events.jsonl", "events.schema.json"),
    ("work.jsonl", "work-record.schema.json"),
)
DEPLOYED_TEXT = (("next-review-at", "next-review-at.schema.json"),)

# The vocabulary review_ledger._schema evaluates. A schema using anything else
# is not validated at all, so the omission must fail here instead.
SUPPORTED = {
    "$schema", "oneOf", "type", "const", "enum", "required", "properties",
    "additionalProperties", "items", "minItems", "maxItems", "minimum",
    "minLength", "pattern",
}


def load(path):
    return json.loads(Path(path).read_text())


def walk_schema(rule, where="$"):
    """Every schema position must stay inside the evaluated vocabulary."""
    if not isinstance(rule, dict):
        raise AssertionError(f"{where}: schema position is not an object")
    extra = set(rule) - SUPPORTED
    if extra:
        raise AssertionError(f"{where}: unsupported keywords {sorted(extra)}")
    for key in rule.get("properties", {}):
        walk_schema(rule["properties"][key], f"{where}/properties/{key}")
    if "items" in rule and isinstance(rule["items"], dict):
        walk_schema(rule["items"], f"{where}/items")
    for index, branch in enumerate(rule.get("oneOf", [])):
        walk_schema(branch, f"{where}/oneOf/{index}")
    if isinstance(rule.get("additionalProperties"), dict):
        walk_schema(rule["additionalProperties"], f"{where}/additionalProperties")


def rule_at(schema, keys):
    rule = schema
    for key in keys:
        rule = rule[key]
    if not isinstance(rule, dict):
        raise AssertionError(f"rule path {keys} does not end at a schema object")
    return rule


_MISSING = object()


def at_or_missing(document, keys):
    value = document
    for key in keys:
        if not isinstance(value, dict) or key not in value:
            return _MISSING
        value = value[key]
    return value


def queue_map_checks():
    index = load(FIXTURES / "index.json")
    entry = next(e for e in index["documents"] if e["path"] == "queue.json")
    return entry["map_checks"]


def check_maps(case, document, schema, checks):
    for check in checks:
        values = at_or_missing(document, check["at"])
        if values is _MISSING:
            # A representative fixture need not carry every historical
            # accumulator; the captures below do.
            continue
        with case.subTest(map=check["at"]):
            case.assertIsInstance(values, dict)
            rule = rule_at(schema, check["rule"])
            for key, value in values.items():
                with case.subTest(map=check["at"], key=key):
                    _schema(value, rule)


class CheckedInVocabulary(unittest.TestCase):
    def test_every_schema_stays_inside_the_validator_vocabulary(self):
        for path in sorted(SCHEMAS.glob("*.json")):
            walk_schema(load(path), path.name)

    def test_every_schema_is_paired_with_a_fixture(self):
        index = load(FIXTURES / "index.json")
        used = {entry["schema"] for entry in index["documents"]}
        committed = {path.name for path in SCHEMAS.glob("*.json")}
        self.assertEqual(committed - used, set(), "schema without a fixture")
        self.assertEqual(used - committed, set(), "fixture references a missing schema")


class FixtureDocuments(unittest.TestCase):
    def test_representative_state_validates(self):
        index = load(FIXTURES / "index.json")
        for entry in index["documents"]:
            with self.subTest(path=entry["path"]):
                schema = load(SCHEMAS / entry["schema"])
                path = FIXTURES / entry["path"]
                if entry.get("text"):
                    # next-review-at is a bare timestamp plus one newline, not JSON.
                    document = path.read_text().strip()
                elif entry.get("lines"):
                    self._check_lines(path, schema)
                    continue
                else:
                    document = load(path)
                _schema(document, schema)
                self._check_maps(document, schema, entry.get("map_checks", []))

    def _check_lines(self, path, schema):
        for number, line in enumerate(path.read_text().splitlines(), 1):
            if not line.strip():
                continue
            with self.subTest(line=number):
                _schema(json.loads(line), schema)

    def _check_maps(self, document, schema, checks):
        check_maps(self, document, schema, checks)


class ExistingCapture(unittest.TestCase):
    def test_captured_author_queue_validates_with_unknown_top_level_key(self):
        queue = load(AUTHOR_CAPTURE)["capture"]["queue"]
        self.assertIn("unknown", queue, "the capture pins unknown-key tolerance")
        schema = load(SCHEMAS / "queue.schema.json")
        _schema(queue, schema)
        check_maps(self, queue, schema, queue_map_checks())

    def test_queue_schema_version_stays_absent(self):
        # Phase 0.2 decision: no top-level schema_version until both runtimes
        # demonstrably ignore unknown queue keys. The TS runtime has no queue
        # reader yet, so adding one would be an unverified state change.
        schema = load(SCHEMAS / "queue.schema.json")
        self.assertNotIn("schema_version", schema["properties"])
        self.assertNotIn("schema_version", schema["required"])

    def test_every_live_item_kind_is_described(self):
        schema = load(SCHEMAS / "queue.schema.json")
        kinds = set(schema["properties"]["items"]["items"]["properties"]["kind"]["enum"])
        fixture = load(FIXTURES / "queue.json")
        seen = {item["kind"] for item in fixture["items"]}
        self.assertEqual(seen, kinds, "the sample must exercise every live item kind")


class TimestampPatterns(unittest.TestCase):
    def test_seconds_precision_matches_iso_writer(self):
        pattern = re.compile(load(SCHEMAS / "next-review-at.schema.json")["pattern"])
        self.assertIsNotNone(pattern.fullmatch("2026-11-09T10:00:00Z"))
        self.assertIsNone(pattern.fullmatch("2026-11-09T10:00:00+00:00"))
        self.assertIsNone(pattern.fullmatch("2026-11-09T10:00:00"))

    def test_fractional_seconds_are_admitted_where_coverage_writes_them(self):
        schema = load(SCHEMAS / "coverage.schema.json")
        rule = schema["properties"]["paths"]["additionalProperties"]
        pattern = re.compile(rule["properties"]["last_reviewed_at"]["pattern"])
        self.assertIsNotNone(pattern.fullmatch("2026-11-09T10:00:00.123456Z"))
        self.assertIsNotNone(pattern.fullmatch("2026-11-09T10:00:00Z"))


class DeployedShapeSnapshot(unittest.TestCase):
    """The phase 0.3 synthetic snapshot must satisfy the 0.2 schemas."""

    def test_documents_validate(self):
        for relative, schema_name in DEPLOYED_DOCUMENTS:
            with self.subTest(path=relative):
                path = DEPLOYED / relative
                self.assertTrue(path.exists(), f"missing phase 0.3 fixture {relative}")
                document = load(path)
                schema = load(SCHEMAS / schema_name)
                _schema(document, schema)
                if relative == "queue.json":
                    check_maps(self, document, schema, queue_map_checks())

    def test_jsonl_lines_validate(self):
        for relative, schema_name in DEPLOYED_LINES:
            path = DEPLOYED / relative
            self.assertTrue(path.exists(), f"missing phase 0.3 fixture {relative}")
            for number, line in enumerate(path.read_text().splitlines(), 1):
                if line.strip():
                    with self.subTest(path=relative, line=number):
                        _schema(json.loads(line), load(SCHEMAS / schema_name))

    def test_text_timestamp_validates(self):
        for relative, schema_name in DEPLOYED_TEXT:
            with self.subTest(path=relative):
                path = DEPLOYED / relative
                self.assertTrue(path.exists(), f"missing phase 0.3 fixture {relative}")
                _schema(path.read_text().strip(), load(SCHEMAS / schema_name))


class ReviewFindings(unittest.TestCase):
    """Each review finding gets an executable shape assertion."""

    def test_f1_usage_is_nullable(self):
        document = load(FIXTURES / "queue-usage-unavailable.json")
        self.assertIsNone(document["usage"])
        _schema(document, load(SCHEMAS / "queue.schema.json"))

    def test_f2_deferred_refresh_cursor_is_a_string(self):
        queue = load(FIXTURES / "queue.json")
        self.assertIsInstance(queue["deferred_refresh_cursor"], str)
        _schema(queue, load(SCHEMAS / "queue.schema.json"))

    def test_f3_backfill_capacity_runs_is_a_list(self):
        queue = load(FIXTURES / "queue.json")
        self.assertIsInstance(queue["backfill_capacity_runs"], list)
        _schema(queue, load(SCHEMAS / "queue.schema.json"))

    def test_f4_backfill_halt_fields_are_strings(self):
        queue = load(FIXTURES / "queue-backfill-halted.json")
        self.assertIsInstance(queue["backfill_halted"], str)
        self.assertIsInstance(queue["backfill_halt_operation"], str)
        _schema(queue, load(SCHEMAS / "queue.schema.json"))

    def test_f5_legacy_coverage_failure_runs_is_a_keyed_map(self):
        queue = load(FIXTURES / "queue.json")
        failures = queue["legacy_coverage_failure_runs"]
        self.assertIsInstance(failures, dict)
        value = next(iter(failures.values()))
        self.assertEqual(set(value), {"item", "outcome", "origins", "at"})
        _schema(queue, load(SCHEMAS / "queue.schema.json"))

    def test_f6_inventory_evidence_is_a_sorted_list(self):
        ranked = load(FIXTURES / "backfill/latest-ranked.json")
        for row in ranked["paths"]:
            evidence = row["evidence"]
            self.assertIsInstance(evidence, list)
            self.assertEqual(evidence, sorted(evidence))
        schema = load(SCHEMAS / "backfill-inventory.schema.json")
        evidence_rule = schema["properties"]["paths"]["items"]["properties"]["evidence"]
        _schema([], evidence_rule)
        _schema(ranked, schema)

    def test_f7_work_record_pr_is_nullable(self):
        schema = load(SCHEMAS / "work-record.schema.json")
        for line in (FIXTURES / "work.jsonl").read_text().splitlines():
            record = json.loads(line)
            self.assertIn("pr", record)
            _schema(record, schema)
        self.assertIn(None, [json.loads(line)["pr"] for line in (FIXTURES / "work.jsonl").read_text().splitlines()])

    def test_f8_author_target_is_a_ref(self):
        queue = load(AUTHOR_CAPTURE)["capture"]["queue"]
        targets = {request["target"] for request in queue["author_requests"].values()}
        self.assertTrue(targets)
        self.assertTrue(any("/" in target for target in targets))
        for target in targets:
            self.assertNotRegex(target, r"^[0-9a-f]{40}$")
        _schema(queue, load(SCHEMAS / "queue.schema.json"))

    def test_f9_legacy_repair_job_lacks_review_diff_and_source(self):
        legacy = load(FIXTURES / "repair/inbox/crq-legacy-run-F1.json")
        self.assertNotIn("review_diff", legacy)
        self.assertNotIn("source", legacy)
        _schema(legacy, load(SCHEMAS / "repair-job.schema.json"))
        modern = load(FIXTURES / "repair/inbox/crq-pr1304-20261109T082400Z-F1.json")
        self.assertIn("review_diff", modern)
        _schema(modern, load(SCHEMAS / "repair-job.schema.json"))

    def test_f11_ranked_scores_follow_the_writer_formula(self):
        ranked = load(FIXTURES / "backfill/latest-ranked.json")
        scores = {}
        for row in ranked["paths"]:
            uncovered = sum(end - start + 1 for start, end in row["uncovered"])
            expected = uncovered * (1 + row["churn"] + row["findings"])
            self.assertEqual(row["score"], expected, row["path"])
            scores[row["path"]] = expected
        for candidate in ranked["candidates"]:
            self.assertEqual(
                candidate["score"],
                sum(scores[path] for path in candidate["paths"]),
            )
            self.assertEqual(candidate["path_scores"], {path: scores[path] for path in candidate["paths"]})

    def test_f12_new_state_documents_validate(self):
        for relative, schema in (
            ("status.json", "status.schema.json"),
            ("repair/rate-limited-until", "repair-pause.schema.json"),
            ("backfill/publish-request.json", "backfill-publish-request.schema.json"),
            ("backfill/publication-failure.json", "backfill-publication-failure.schema.json"),
            (
                "backfill/findings/triage/1414141414141414141414141414141414141414141414141414141414141414.json",
                "backfill-triage.schema.json",
            ),
            (
                "backfill/findings/delivery/1414141414141414141414141414141414141414141414141414141414141414.json",
                "backfill-delivery-request.schema.json",
            ),
            (
                "backfill/findings/receipts/1414141414141414141414141414141414141414141414141414141414141414.json",
                "backfill-delivery-receipt.schema.json",
            ),
        ):
            with self.subTest(path=relative):
                _schema(load(FIXTURES / relative), load(SCHEMAS / schema))
        # `rate_limit_pause` also records operator/backfill markers, not only
        # crq job IDs, and an exception can carry an empty message.
        _schema(
            {"until": "2026-11-09T12:30:00Z", "job": "backfill-triage", "at": "2026-11-09T12:00:00Z"},
            load(SCHEMAS / "repair-pause.schema.json"),
        )
        _schema({"error": ""}, load(SCHEMAS / "backfill-publication-failure.schema.json"))


if __name__ == "__main__":
    unittest.main()
