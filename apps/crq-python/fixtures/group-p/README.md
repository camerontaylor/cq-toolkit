# Group P vectors (`fixtures/group-p/`)

Shared, language-neutral fixtures for the crq TypeScript migration. Each file
records JSON input and the exact JSON result of a pure function in
`apps/crq-python`, including expected refusals. Phase 1 replays these files in
vitest so a ported implementation is compared with the Python oracle at the
same commit.

`apps/crq-python/vector_emit.py` is the only writer. It is test tooling: crq
never imports it.

```sh
cd apps/crq-python
python3 vector_emit.py --write   # regenerate every family
python3 vector_emit.py --check   # fail when a checked-in file is stale
python3 vector_emit.py --stdout  # one object, used by the reproducibility test
```

## Determinism

Files are encoded with `json.dumps(..., indent=2, ensure_ascii=True)` plus one
trailing newline. Case order is source order, never set or hash order. No
timestamp, host, path, process id or Python version is recorded, so the bytes
are identical on every host and on Python 3.14+ patch levels. A test runs
`--stdout` in two processes with different `PYTHONHASHSEED` values and requires
byte equality.

## Row format

```json
{
  "schema": "cq.crq-group-p-vector/v1",
  "family": "time",
  "cases": [
    {
      "name": "zulu-fraction",
      "source": "queue_time.parse_utc",
      "input": {"value": "2026-11-08T00:00:00.500Z"},
      "expect": {"ok": true, "value": {"utc": "2026-11-08T00:00:00.500000Z"}}
    }
  ]
}
```

- `name` is unique inside a family and is never renamed casually: review notes
  and shadow-diff whitelists refer to it.
- `source` is `<python module>.<function>`.
- `input` names the arguments. Datetimes crossing the boundary are strings in
  UTC with six fractional digits. For `status_summary.summarize`, `now` is
  integer epoch seconds, matching the Python signature.
- `expect.ok` is false when the Python function raises. `expect.error` is the
  exception class. `expect.message` is diagnostic context taken from crq-owned
  text. The differential runner compares `ok`, `error` and `value`; it does not
  compare exception text, which can vary across Python patch levels.
- Some cases add `note`. The note is guidance, not an input to the function.
- `merged_reconcile.reconcile_page` rows carry `input.pages`, a list of pages
  folded in order. The recorded value is the checkpoint after the last page.
- `backfill_jobs.admission` rows mutate their input queue and item. The value
  records the returned decision plus both mutated objects.
- `crq_repair.atomic` rows carry either `input.value`, the object to write, or
  `input.raw`, JSON text that is parsed first. The value records the exact file
  text and its SHA-256. This is the queue.json writer contract: insertion order
  preserved, `indent=2`, `ensure_ascii=True`, one trailing newline.
- `backfill_inventory.rank` rows carry a manifest plus the exact captured
  `inputs`. Snapshot `sha256` values are recomputed from those inputs, and the
  artifact refs are placeholders because `rank` consumes JSON only and never
  opens a bundle or artifact location. Capture and replay remain Group E.
- `backfill_accounting.line_bytes` rows carry base64 input and base64 output
  chunks so non-UTF8 blobs survive the JSON boundary. Shape predicates and
  `FACT_SHAPES` rows record booleans.
- `backfill_report` rows carry a `repo` stub spec with `tree`, `lineage`,
  `proven_deleted` and `carry` answers. `carry.mapped` is a list of
  `[old_line, new_line]` pairs. The report's pure projection and accounting run
  against that stub; real Git and filesystem capture remain Group E.

## Families

| file | Python sources | covers |
|---|---|---|
| `canonical.json` | `review_receipt.canonical+digest`, `review_ledger.canonical+digest` | code-point vs UTF-16BE key order (including astral vs U+FFFF), ASCII vs UTF-8, control/DEL/U+2028 escaping, Python float repr at its fixed/scientific boundaries, integer range, lone surrogates |
| `queue-bytes.json` | `crq_repair.atomic` | exact `queue.json` writer bytes: insertion order, nested and empty `indent=2` layout, ASCII escaping of keys and values, one trailing newline, float repr boundaries, parse-then-write round trips |
| `time.json` | `queue_time.parse_utc`, `crq.parse_iso` | Zulu, numeric offsets (hour-only, basic, seconds, fractional), naive-as-UTC, basic/compact dates, ISO week dates, hour-only, 24:00 rollover, comma/dot fractions with microsecond truncation, `.000` stripping, refused fractional/offset/date-only forms |
| `usage.json` | `usage_slots.parse_usage`, `usage_slots.next_slot` | partial usage, refused shapes, rolling window, full-capacity fallback, reservation lag |
| `classify.json` | `crq.classify` | completion, findings, rate limit and `waitTime`, auth, action required, malformed streams, missing exit, unknown status, transient exits |
| `promotion-filter.json` | `crq.live_items` | historical `promotion` items stay out of live scheduling in every state; exact-kind and missing-kind edges |
| `merged-reconcile.json` | `merged_reconcile.normalize_interval`, `normalize_page_budget`, `record_identity`, `checkpoint_digest`, `new_checkpoint`, `reconcile_page`, `load_checkpoint` | exact timestamps, Unicode digits, page folds, duplicates, outside-window records, sealed checkpoint loading and refusals |
| `coverage.json` | `coverage.utilization_digest`, `coverage.coverage_candidate`, `coverage.record_opportunity` | 24 h window, unknown observations, cooldown floor, oldest-region selection, active-item exclusion |
| `backfill.json` | `backfill_accounting.ranges`, `admission_history.summarize`, `backfill_jobs.admission` | range coalescing, bounded diagnostics, ordinary/usage/reserve/inflight decisions |
| `backfill-inventory.json` | `backfill_inventory.rank` | tier/retry/score ordering, active and mapped ownership subtraction, family and path quarantine/eligibility, file/byte partition limits, required unions and evidence outcomes |
| `backfill-accounting.json` | `backfill_accounting.line_bytes`, `_int`, `_opt_str`, `_rows`, `_hexstr`, `FACT_SHAPES` | byte splitting, non-UTF8 input, integer/boolean/row/hex validation, every persisted fact shape including valid and malformed rows |
| `backfill-report.json` | `backfill_report.baseline`, `backfill_report.summary` | baseline row projection and digest, tier totals, empty/unsupported objects, operational counts, surviving/reviewed/removed/new T1 debt, unverified lineage, unmeasurable objects and capacity estimate |
| `status-helpers.json` | `status_summary.timestamp`, `merged_current`, `repos_summary` | epoch parsing, receipt-less merged-current counts, discovery passthrough, configured/push-only repo visibility and per-state counts |
| `ledger.json` | `review_ledger.timestamp`, `path`, `intervals`, `scope`, `validate`, `validate_sequence`, `creditable` | exact UTC, canonical paths, interval overlap, scope duplicates, event hash, quarantine operator requirement, credit authority |
| `summary.json` | `status_summary.summarize` | backlog, bounded pending preview, 24 h outcomes, merged discovery, historical promotion exclusion, invalid tick refusal |

## Decision D2

The owner ruling D2 changes no-fresh classification in TypeScript: Python
records terminal `skipped`; TypeScript records blocked/retriable with an
explicit `skipped:no-fresh` reason. The two affected `classify` rows carry a
`note`. A differential runner must whitelist exactly those rows, not loosen the
comparison generally.

## Python minor

The oracle is Python 3.14, the production minor. `datetime.fromisoformat`
became stricter in 3.15. Three input families are deliberately absent from
`time.json` because 3.14 and 3.15 disagree on them: an offset component
overflow (`+10:60`, `+10:00:60`), an empty fraction separator before an offset
(`2026-11-08T00:00:00.Z`), and a sub-second offset fraction when the integer
seconds are zero (`+00:00:00.5`). Keeping them out makes `--check`
byte-identical on both minors. Every timestamp crq itself writes is
`strftime`-formatted, so none of these forms can appear in crq-owned state.

## Gaps

Not vectorized here because they need real effect doubles, filesystem state
or live repository objects: `backfill_report.finding_triage` and
`status_summary.finding_triage` (directory reads), `status_summary.publish`
(systemd and home filesystem), real Git lineage/carry capture, receipt reading
and the tick/slot launch and harvest loops. The report's accounting is
vectorized against a documented repository stub. Group E fixtures seeded from
`fixtures/state-<date>/` cover the remaining effects in Phase 1.
