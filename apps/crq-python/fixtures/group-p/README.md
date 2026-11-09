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

## Families

| file | Python sources | covers |
|---|---|---|
| `canonical.json` | `review_receipt.canonical+digest`, `review_ledger.canonical+digest` | key order, ASCII vs UTF-8, UTF-16BE key order, Python float repr, integer range, control characters, lone surrogates |
| `queue-bytes.json` | `crq_repair.atomic` | exact `queue.json` writer bytes: insertion order, `indent=2`, default ASCII escaping, one trailing newline, parse-then-write round trips |
| `time.json` | `queue_time.parse_utc`, `crq.parse_iso` | Zulu, numeric offsets, naive-as-UTC, compact run suffix, `.000` stripping, refused fractional/offset/date-only forms |
| `usage.json` | `usage_slots.parse_usage`, `usage_slots.next_slot` | partial usage, refused shapes, rolling window, full-capacity fallback, reservation lag |
| `classify.json` | `crq.classify` | completion, findings, rate limit and `waitTime`, auth, action required, malformed streams, missing exit, unknown status, transient exits |
| `merged-reconcile.json` | `merged_reconcile.normalize_interval`, `normalize_page_budget`, `record_identity`, `checkpoint_digest`, `new_checkpoint`, `reconcile_page`, `load_checkpoint` | exact timestamps, Unicode digits, page folds, duplicates, outside-window records, sealed checkpoint loading and refusals |
| `coverage.json` | `coverage.utilization_digest`, `coverage.coverage_candidate`, `coverage.record_opportunity` | 24 h window, unknown observations, cooldown floor, oldest-region selection, active-item exclusion |
| `backfill.json` | `backfill_accounting.ranges`, `admission_history.summarize`, `backfill_jobs.admission` | range coalescing, bounded diagnostics, ordinary/usage/reserve/inflight decisions |
| `ledger.json` | `review_ledger.timestamp`, `path`, `intervals`, `scope`, `validate`, `validate_sequence`, `creditable` | exact UTC, canonical paths, interval overlap, scope duplicates, event hash, quarantine operator requirement, credit authority |
| `summary.json` | `status_summary.summarize` | backlog, bounded pending preview, 24 h outcomes, merged discovery, invalid tick refusal |

## Decision D2

The owner ruling D2 changes no-fresh classification in TypeScript: Python
records terminal `skipped`; TypeScript records blocked/retriable with an
explicit `skipped:no-fresh` reason. The two affected `classify` rows carry a
`note`. A differential runner must whitelist exactly those rows, not loosen the
comparison generally.

## Gaps

Not vectorized here because they need effect doubles, filesystem state or a
repository adapter: `backfill_inventory.rank`, `backfill_report.summary` and
`finding_triage` (repository lineage/carry effects), `status_summary.publish`
(systemd and home filesystem), and the tick/slot launch and harvest loops.
Group E fixtures seeded from `fixtures/state-<date>/` cover those in Phase 1.
