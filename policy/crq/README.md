# crq state schemas

JSON Schemas for the on-disk state of `apps/crq-python` (the CodeRabbit review
queue that runs on ceres). They are the contract the TypeScript port builds on
(plan `crq-ts-migration-plan-20261109` §2.2 and §4 phase 0.2).

These files are data and remain the authority. Python does not import them;
the TypeScript port embeds them through the generated
`src/policy/crq/schemas.ts` and validates state read-only in
`src/policy/crq/state.ts`. No TypeScript writer uses them yet, so a schema
mistake cannot block a running tick.

## Compatibility rules

- A schema admits every shape the Python writer can emit, including optional
  fields that only one code path sets. Additional fields are allowed where the
  readers tolerate them (`additionalProperties: true`).
- Required lists name only fields a writer always sets. Historical or legacy
  records on ceres stay readable, even when the current writer has stopped
  producing a field.
- `repair-job.schema.json` keeps `review_diff` and `source` in `properties` but
  not in `required`: `repair_tick.enqueue` backfills a missing `source` on
  existing jobs, and `crq_repair` reads `review_diff` with a default. Legacy
  inbox jobs therefore still validate.
- No top-level `schema_version` is added to `queue.json`. Python's
  `admission_history.load` tolerates unknown top-level keys, and the existing
  capture `apps/crq-python/fixtures/author-0e35cd11.json` proves it by carrying
  an `unknown` key. Phase 1.1 added a TypeScript READER (`parseCrqState`) that
  admits the same unknown top-level keys, but there is still no TypeScript
  queue writer to prove the write path tolerates them. Adding a version key
  remains an unverified state change until that writer exists.
- `state/next-review-at` is not JSON. It is one `%Y-%m-%dT%H:%M:%SZ` timestamp
  plus a newline; `next-review-at.schema.json` describes the stripped string.

## Schema vocabulary

`review_ledger._schema` is the checked-in validator, and it evaluates exactly:

```
$schema, oneOf, type, const, enum, required, properties,
additionalProperties, items, minItems, maxItems, minimum, minLength, pattern
```

Every schema here stays inside that set, and
`apps/crq-python/test_crq_state_schemas.py` fails if one does not. Two limits
follow from the vocabulary:

- `patternProperties` is unavailable, so arbitrary-key maps (`coverage.paths`,
  `provider-cooldowns`, `backfill_families`) carry their value schema under
  `additionalProperties` for documentation and zod generation, and the test
  checks the interiors explicitly through `map_checks` in the fixture index.
  Queue `map_checks` run against the sample tree, the historical
  `author-0e35cd11` capture, and Phase 0.3's deployed snapshot.
- Patterns are evaluated with `re.fullmatch`, so every pattern is anchored.

## Files

| Schema                                     | On-disk file                                         | Writer                                                         |
| ------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------- |
| `queue.schema.json`                        | `state/queue.json`                                   | `crq.save_queue`, every `new_item` caller                      |
| `coverage.schema.json`                     | `state/queue.json` `coverage` member                 | `coverage.new_ledger` / `record_review` / `record_opportunity` |
| `events.schema.json`                       | `state/events.jsonl` (one line each)                 | `crq.event`                                                    |
| `work-record.schema.json`                  | `state/work.jsonl` (one line each)                   | `crq.append_work_record`                                       |
| `run-meta.schema.json`                     | `state/runs/<id>/meta.json`                          | `crq.launch`                                                   |
| `run-exit.schema.json`                     | `state/runs/<id>/exit.json`                          | `crq.cmd_review_child`                                         |
| `run-classification.schema.json`           | `state/runs/<id>/classification.json`                | `crq.classify`                                                 |
| `run-pidfile.schema.json`                  | `state/runs/<id>/review.pid`                         | `crq.cmd_review_child`                                         |
| `run-submission.schema.json`               | `state/runs/<id>/submission.json`                    | `crq.cmd_review_child` (backfill runs)                         |
| `run-secret-scan.schema.json`              | `state/runs/<id>/secret-scan.json`                   | `crq.secret_scan_diff`                                         |
| `repair-job.schema.json`                   | `state/repair/inbox/<job>.json`                      | `repair_tick.enqueue`, `prepare_current_job`                   |
| `repair-result.schema.json`                | `state/repair/<job>/result.json` and `progress.json` | `crq_repair.process`, `mark_stale`                             |
| `repair-publication.schema.json`           | `state/repair/<job>/publication.json`                | `repair_tick.publish`                                          |
| `repair-pause.schema.json`                 | `state/repair/rate-limited-until`                    | `crq_repair.rate_limit_pause`                                  |
| `provider-cooldowns.schema.json`           | `state/repair/provider-cooldowns.json`               | `crq_repair.remember_provider_limit`                           |
| `heartbeat.schema.json`                    | `~/.local/state/crq/heartbeat.json`                  | `crq.write_heartbeat`                                          |
| `next-review-at.schema.json`               | `state/next-review-at`                               | `usage_slots.write_next`                                       |
| `status.schema.json`                       | `state/status.json`                                  | `crq.cmd_status` projection                                    |
| `backfill-inventory.schema.json`           | `state/backfill/latest-ranked.json`                  | `backfill_inventory.rank`                                      |
| `backfill-report.schema.json`              | `state/backfill/latest-report.json`                  | `backfill_report.summary`                                      |
| `backfill-baseline.schema.json`            | `state/backfill/baseline.json`                       | `backfill_report.baseline`                                     |
| `backfill-publish-request.schema.json`     | `state/backfill/publish-request.json`                | `backfill_runtime.publish`, `backfill_publisher.run`           |
| `backfill-publication-failure.schema.json` | `state/backfill/publication-failure.json`            | `backfill_publisher.run`                                       |
| `backfill-triage.schema.json`              | `state/backfill/findings/triage/<id>.json`           | `finding_delivery.Inbox.ingest` / `triage`                     |
| `backfill-delivery-request.schema.json`    | `state/backfill/findings/delivery/<key>.json`        | `finding_delivery.Inbox.deliver`                               |
| `backfill-delivery-receipt.schema.json`    | `state/backfill/findings/receipts/<key>.json`        | `finding_delivery.Inbox.deliver`                               |

## Queue item kinds

`queue.schema.json` describes one item shape with a `kind` enum rather than a
`oneOf` per kind. Legacy `promotion` items remain on disk after `live_items`
stops reading them, and a permissive item schema cannot reject an item a
tolerating reader accepts. The fields each kind always writes:

| Kind                 | Always present beyond `id`, `kind`, `state`                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `open`, `delta`      | `pr`, `order`, `cycles`, `attempts`, `notes`                                                      |
| `merged`             | `pr`, `merge_commit`, `measure`                                                                   |
| `coverage`           | `pr`, `coverage_source`, `coverage_sha`, `coverage_paths`, `merge_commit`                         |
| `backfill`           | `subject_id`, `job_id`, `family`, `generation`, `scope`, `scope_digest`, `target`, `vendor_state` |
| `merged-current`     | `pr`, `merge_commit`, `subject`, `request_id`, `depends_on`                                       |
| `push-current`       | `repo`, `subject`                                                                                 |
| `local-review`       | `repo`, `identity`, `identity_inputs`, `profile`, `generation`, `depends_on`                      |
| `author`             | `pr` (0), `author`, `requested_at`, `author_cycles`                                               |
| `promotion` (legacy) | read-only history; only the common fields are asserted                                            |

## Fixtures

`apps/crq-python/fixtures/crq-state-schema-samples/` is a representative,
secret-free sample tree derived from the writers, one file per schema family.
`index.json` maps each sample to its schema, marks JSONL files, marks the
non-JSON timestamp file, and lists the arbitrary-key map checks. It
complements Phase 0.3's synthetic deployed-shape snapshot at
`apps/crq-python/fixtures/state-20261109/`; the test also validates that
snapshot read-only, because this phase's schemas are its authority. A redacted
real ceres capture remains a Phase 0.3 follow-up.

## TypeScript consumer

`scripts/gen-crq-schemas.mjs` embeds every schema above verbatim in
`src/policy/crq/schemas.ts` and hands each document to zod's
`z.fromJSONSchema`. The generated file is checked in and formatted, so a
schema edit is a two-file change. `src/policy/crq/state.ts` then:

- parses the text with `src/policy/crq/jsonValue.ts`, which keeps the Python
  `int` vs `float` source distinction and large integers exact;
- validates the zod schema and a JSON-Schema evaluator over that lossless
  value;
- reports a `divergence` and fails closed if the two disagree.

The second evaluator exists because zod sees `1.0` as the JavaScript number
`1`; the lossless document still knows the source was a float, which Python's
`type(value) is int` rejects in an integer position. Tests under
`test/policy/crq/` pin representative fixtures, the deployed snapshot, the
historical capture, map interiors, integer-lexeme refusals, and every embedded
schema against its policy file.

## Changing a schema

Update the schema and the fixture in the same change, regenerate the embedded
module, then run:

```
node scripts/gen-crq-schemas.mjs
pnpm test:narrow apps/crq-python/test_crq_state_schemas.py
pnpm test:narrow test/policy/crq/schemas.test.ts
```

Both tests assert that every schema is paired with a fixture, so a new state
file needs both. The generated module's test also proves the embedded document
is exactly the checked-in JSON Schema.
