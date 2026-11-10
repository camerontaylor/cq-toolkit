"""Schema-fidelity and redaction tests for the state fixture provenance."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import state_fixture_provenance as provenance


HERE = Path(__file__).resolve().parent
STATE_FIXTURE = HERE / "fixtures" / "state-20261109"
MANIFEST = STATE_FIXTURE / "provenance.json"


def compatible(value, spec):
    types = spec if isinstance(spec, list) else [spec]
    return provenance.type_name(value) in types


def keyed(rows, key):
    return [row[key] for row in rows if isinstance(row, dict) and key in row]


class ProvenanceFixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads(MANIFEST.read_text())
        cls.queue = json.loads((STATE_FIXTURE / "queue.json").read_text())
        cls.summary = json.loads((STATE_FIXTURE / "summary.json").read_text())
        cls.status = json.loads((STATE_FIXTURE / "status.json").read_text())
        cls.heartbeat = json.loads((STATE_FIXTURE / "heartbeat.json").read_text())
        cls.events = [json.loads(line) for line in
                      (STATE_FIXTURE / "events.jsonl").read_text().splitlines()
                      if line.strip()]
        cls.work = [json.loads(line) for line in
                    (STATE_FIXTURE / "work.jsonl").read_text().splitlines()
                    if line.strip()]

    def test_manifest_is_self_consistent(self):
        self.assertEqual(self.manifest["schema"], provenance.SCHEMA)
        expected = dict(self.manifest)
        digest = expected.pop("projection_sha256")
        canonical = json.dumps(expected, sort_keys=True, separators=(",", ":"),
                               ensure_ascii=True)
        import hashlib
        self.assertEqual(digest, hashlib.sha256(canonical.encode()).hexdigest())
        text = MANIFEST.read_text()
        for marker in provenance.SAFE_MARKERS:
            self.assertNotIn(marker, text)

    def test_queue_top_level_covers_real_schema(self):
        for key, spec in self.manifest["queue"]["top_level_keys"].items():
            if key.startswith("_"):
                continue
            with self.subTest(key=key):
                self.assertIn(key, self.queue)
                self.assertTrue(compatible(self.queue[key], spec),
                                f"{key} is {provenance.type_name(self.queue[key])}, "
                                f"expected {spec}")

    def test_every_real_item_kind_has_a_fixture_item(self):
        fixture_kinds = {item["kind"] for item in self.queue["items"]}
        self.assertEqual(set(self.manifest["queue"]["item_kinds"]), fixture_kinds)

    def test_item_keys_cover_real_schema_and_states(self):
        for kind in self.manifest["queue"]["item_kinds"]:
            items = [item for item in self.queue["items"] if item["kind"] == kind]
            with self.subTest(kind=kind):
                self.assertTrue(items)
                allowed_states = set(self.manifest["queue"]["item_states_by_kind"][kind])
                self.assertLessEqual({item["state"] for item in items}, allowed_states)
                for key, spec in self.manifest["queue"]["item_keys_by_kind"][kind].items():
                    if key.startswith("_"):
                        continue
                    matches = [item for item in items if key in item]
                    self.assertTrue(matches, f"{kind} has no fixture item with {key}")
                    self.assertTrue(
                        any(compatible(item[key], spec) for item in matches),
                        f"{kind}.{key} fixture type does not match {spec}")

    def test_sidecars_cover_real_schema(self):
        for name, obj in (("summary_keys", self.summary),
                          ("status_keys", self.status),
                          ("heartbeat_keys", self.heartbeat)):
            for key, spec in self.manifest[name].items():
                if key.startswith("_"):
                    continue
                with self.subTest(field=name, key=key):
                    self.assertIn(key, obj)
                    self.assertTrue(compatible(obj[key], spec),
                                    f"{key} is {provenance.type_name(obj[key])}, "
                                    f"expected {spec}")

        for key, spec in self.manifest["event_keys"].items():
            if key.startswith("_"):
                continue
            with self.subTest(event_key=key):
                values = keyed(self.events, key)
                self.assertTrue(values)
                self.assertTrue(any(compatible(value, spec) for value in values),
                                f"event {key} type does not match {spec}")

        for key, spec in self.manifest["work_keys"].items():
            if key.startswith("_"):
                continue
            with self.subTest(work_key=key):
                values = keyed(self.work, key)
                self.assertTrue(values)
                self.assertTrue(any(compatible(value, spec) for value in values),
                                f"work {key} type does not match {spec}")

    def test_run_artifacts_cover_real_schema(self):
        run_dir = STATE_FIXTURE / "runs" / "open-101-20261108T235500Z"
        for name, spec in self.manifest["run_files"].items():
            path = run_dir / name
            with self.subTest(file=name):
                self.assertTrue(path.exists(), f"missing run artifact {name}")
                if spec == {"type": "text"}:
                    continue
                record = json.loads(path.read_text())
                for key, expected in spec.items():
                    if key.startswith("_"):
                        continue
                    self.assertIn(key, record)
                    self.assertTrue(compatible(record[key], expected),
                                    f"{name}.{key} type does not match {expected}")

    def test_cooldown_shape_has_no_provider_names(self):
        cooldowns = json.loads(
            (STATE_FIXTURE / "repair" / "provider-cooldowns.json").read_text())
        self.assertIsInstance(cooldowns, dict)
        for key, value in cooldowns.items():
            self.assertIsInstance(key, str)
            self.assertIsInstance(value, str)
        shape = self.manifest["repair_cooldowns"]
        self.assertEqual(shape["key_type"], "str")
        self.assertEqual(shape["value_type"], "str")


class ProvenanceExtractorTest(unittest.TestCase):
    def source_tree(self, root: Path) -> dict:
        queue = {
            "created_at": "2026-11-09T00:00:00Z",
            "items": [{
                "id": "PRIVATE-ID",
                "kind": "open",
                "state": "pending",
                "repo": "private-org/secret-repo",
                "pr": 987654,
                "head": "deadbeef" * 5,
                "notes": "TOP SECRET FINDING",
                "paths": ["/home/alice/private.ts"],
                "secret": "ghp_" + "a" * 30,
            }, {
                "id": "PRIVATE-KIND",
                "kind": "mystery",
                "state": "pending",
                "secret": "ghp_" + "b" * 30,
            }],
            "private_map": {"private-key": "secret-value"},
        }
        (root / "queue.json").write_text(json.dumps(queue))
        (root / "summary.json").write_text(json.dumps({
            "generated_at": "2026-11-09T00:00:00Z",
            "repos": {"private-org/secret-repo": {"pending": 1}},
            "pending_items": [{"title": "TOP SECRET"}],
        }))
        (root / "heartbeat.json").write_text(json.dumps({
            "last_tick": "2026-11-09T00:00:00Z",
            "root": "/home/alice/crq",
            "alert_agent_host": "private-host",
        }))
        (root / "status.json").write_text(json.dumps({
            "generated_at": "2026-11-09T00:00:00Z",
            "finding_triage": {"needs_human": [{"title": "TOP SECRET"}]},
        }))
        (root / "events.jsonl").write_text(json.dumps({
            "at": "2026-11-09T00:00:00Z",
            "event": "private_event",
            "repo": "private-org/secret-repo",
            "description": "TOP SECRET",
        }) + "\n")
        (root / "work.jsonl").write_text(json.dumps({
            "at": "2026-11-09T00:00:00Z",
            "repo": "private-org/secret-repo",
            "task": "TOP SECRET",
        }) + "\n")
        (root / "cooldowns.json").write_text(json.dumps({
            "zai": "2026-11-11T05:16:37Z",
        }))
        run = root / "run"
        run.mkdir()
        (run / "meta.json").write_text(json.dumps({
            "run_id": "private-run",
            "worktree": "/home/alice/private",
        }))
        (run / "findings.md").write_text("TOP SECRET FINDING\n")
        (run / "private-artifact.bin").write_text("TOP SECRET\n")
        return {
            "--queue": str(root / "queue.json"),
            "--summary": str(root / "summary.json"),
            "--heartbeat": str(root / "heartbeat.json"),
            "--status": str(root / "status.json"),
            "--events": str(root / "events.jsonl"),
            "--work": str(root / "work.jsonl"),
            "--cooldowns": str(root / "cooldowns.json"),
            "--run-dir": str(run),
        }

    def run_extractor(self, args, extra=()):
        return subprocess.run(
            [sys.executable, str(HERE / "state_fixture_provenance.py"),
             *args, "--observed-on", "2026-11-09", *extra],
            capture_output=True, text=True, check=False)

    def test_planted_private_values_never_appear(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = self.source_tree(Path(tmp))
            result = self.run_extractor(
                [item for pair in args.items() for item in pair])
            self.assertEqual(result.returncode, 0, result.stderr)
            for secret in ("private-org", "secret-repo", "987654", "deadbeef",
                           "TOP SECRET", "/home/alice", "private-host", "zai",
                           "private-run", "private_event", "private-key",
                           "secret-value", "ghp_"):
                self.assertNotIn(secret, result.stdout)

            projection = json.loads(result.stdout)
            top = projection["queue"]["top_level_keys"]
            self.assertEqual(top["_unknown_key_count"], "1-9")
            self.assertNotIn("private_map", top)
            item = projection["queue"]["item_keys_by_kind"]["open"]
            self.assertEqual(item["_unknown_key_count"], "1-9")
            self.assertNotIn("secret", item)
            self.assertNotIn("private-key", result.stdout)
            self.assertEqual(projection["queue"]["unknown_kind_count"], "1-9")
            self.assertNotIn("mystery", result.stdout)
            self.assertEqual(projection["unknown_run_file_count"], "1-9")
            self.assertNotIn("private-artifact", result.stdout)
            self.assertEqual(projection["event_type_count_bucket"], "1-9")
            self.assertNotIn("private_event", result.stdout)

    def test_full_log_tails_are_scanned(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            args = self.source_tree(root)
            events = [json.dumps({"at": "2026-11-09T00:00:00Z",
                                  "event": "started"}) for _ in range(1000)]
            events.append(json.dumps({"at": "2026-11-09T00:00:01Z",
                                      "event": "finished", "verdict": "pass"}))
            (root / "events.jsonl").write_text("\n".join(events) + "\n")
            work = [json.dumps({"at": "2026-11-09T00:00:00Z"})
                    for _ in range(1000)]
            work.append(json.dumps({"at": "2026-11-09T00:00:01Z",
                                    "task": "tail"}))
            (root / "work.jsonl").write_text("\n".join(work) + "\n")
            result = self.run_extractor(
                [item for pair in args.items() for item in pair])
            self.assertEqual(result.returncode, 0, result.stderr)
            projection = json.loads(result.stdout)
            self.assertEqual(projection["event_keys"]["verdict"], "str")
            self.assertEqual(projection["work_keys"]["task"], "str")
            self.assertEqual(projection["event_type_count_bucket"], "1-9")

    def test_projection_is_deterministic_and_checkable(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = self.source_tree(Path(tmp))
            flat = [item for pair in args.items() for item in pair]
            first = self.run_extractor(flat)
            second = self.run_extractor(flat)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(first.stdout, second.stdout)
            expected = Path(tmp) / "expected.json"
            expected.write_text(first.stdout)
            check = self.run_extractor(flat, ("--check", str(expected)))
            self.assertEqual(check.returncode, 0, check.stderr)
            expected.write_text(first.stdout.replace("1-9", "0"))
            changed = self.run_extractor(flat, ("--check", str(expected)))
            self.assertEqual(changed.returncode, 1)

    def test_assert_safe_refuses_private_markers(self):
        for text in ("x /home/alice y", "ctaylor", "ghp_" + "a" * 30):
            with self.subTest(text=text[:10]):
                with self.assertRaises(SystemExit):
                    provenance.assert_safe(text)


if __name__ == "__main__":
    unittest.main()
