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


def at(document, keys):
    value = document
    for key in keys:
        value = value[key]
    return value


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
                for check in entry.get("map_checks", []):
                    self._check_map(document, schema, check)

    def _check_lines(self, path, schema):
        for number, line in enumerate(path.read_text().splitlines(), 1):
            if not line.strip():
                continue
            with self.subTest(line=number):
                _schema(json.loads(line), schema)

    def _check_map(self, document, schema, check):
        values = at(document, check["at"])
        self.assertIsInstance(values, dict)
        rule = rule_at(schema, check["rule"])
        for key, value in values.items():
            with self.subTest(key=key):
                _schema(value, rule)


class ExistingCapture(unittest.TestCase):
    def test_captured_author_queue_validates_with_unknown_top_level_key(self):
        queue = load(AUTHOR_CAPTURE)["capture"]["queue"]
        self.assertIn("unknown", queue, "the capture pins unknown-key tolerance")
        _schema(queue, load(SCHEMAS / "queue.schema.json"))

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
        self.assertEqual(seen, kinds)


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
                _schema(load(path), load(SCHEMAS / schema_name))

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


if __name__ == "__main__":
    unittest.main()
