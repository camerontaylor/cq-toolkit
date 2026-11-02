# Admission history compaction (#779)

Admission history is diagnostic, not quota or acceptance authority. Retain the
latest 256 decisions in append order (including refusals). Each contains `at`,
`item`, `ordinary_eligible`, `decision`, `effective_remaining`, observation
`successful`/`observed_at`/`remaining`, and counts by reservation quota state.
Observation time and item identify the decision context; full reservation records
remain in `backfill_reservations`. Historical snapshots and reflected-ID lists
are deliberately discarded. Older decisions age out by count, not wall clock.
An operator requiring a complete historical audit must retain the pre-migration
backup; the live report is a rolling diagnostic window.

All readers found by repository-wide search:

- `backfill_report.summary` exposes the history as `spare_quota_admissions`.
  It does not inspect nested snapshot fields.
- `backfill_runtime.admit` consumes the returned `decision` code; tests also
  assert `effective_remaining`. Neither needs copied reservations/observations.
- `crq.load_queue`, `backfill_jobs.Journal.transact`, and generic queue
  serialization/copying carry the field without interpreting it. Both load paths
  now use the incremental reader.
- Receipt, acceptance, ledger publication and quota accounting code do not read
  `backfill_admissions`. Authoritative reservations, usage, daily capacity,
  request state, item attempts and receipts are retained without modification.

The loader reads chunks and decodes individual legacy admission entries, reducing
them immediately into a 256-entry deque. Other top-level values decode one at a
time; memory still scales with the largest non-history field and current queue,
not accumulated admission snapshots. No new JSON parser dependency is needed.
The locked, non-dry tick saves the compacted queue through the existing fsync +
atomic-replace writer, then logs before/after bytes on stderr. The version marker
`backfill_admission_history_version: 1` prevents repeated migration writes.
Malformed/truncated JSON fails before any replacement. Read-only status/report
loads compact in memory and leave disk alone; the next tick persists migration.
Journal transactions save the compact representation with their normal commit.

Existing deferred intents refresh before discovery writes, using the same
24-request / 30-second aggregate forge allowance. The budget is neither restarted
nor extended; an exhausted discovery keeps its cursor/debt for a later tick.
This deliberately prioritizes existing intents over discovering new work.

## Deployment

No deployment performed. Stop the timer and wait for the current tick to exit.
Back up queue.json outside the active state directory **before running any new
mutating command**; keep that backup for historical audit and rollback. Ensure
free disk for the backup plus a full temporary queue, since atomic replacement
retains the original until the new file is fsynced. Run the first tick under the
ordinary scheduler lock and check the `admission compaction v1` byte counts before
resuming the timer. Do not edit/reset reservations or receipts. A crash before
replacement leaves the old queue; a crash after replacement leaves a fully
written compacted queue. Rollback requires stopping the timer again and accounting
for any decisions made since backup; do not blindly restore over newer state.

## Synthetic benchmark

Generate only synthetic data; no live queue or production-host access was used. Run
`benchmark_admission_history.py <scratch-directory> generate`, then `before`,
`compact`, `after` in separate processes. The fixture has about 150 MiB of ordinary
items plus 600 MiB of repeated observations and 3,000 reservation snapshots per
decision, predominantly released. `before` uses the legacy JSON loader and `after` uses the new incremental
loader, both with the production atomic writer; `compact` uses the incremental
migration and production writer. Peak RSS includes Python startup/imports. Measurements are
host/load dependent and are not a production runtime guarantee.

Measured sequentially on a Linux development VM, 2026-11-02 UTC, under nice 5:

| Phase     | Load/parse |     Save |     Total |      Peak RSS |
| --------- | ---------: | -------: | --------: | ------------: |
| Legacy    |   32.111 s | 88.168 s | 120.280 s | 3,406,352 KiB |
| Migration |   49.498 s |  1.584 s |  51.082 s |   808,176 KiB |
| Compacted |    3.553 s |  2.570 s |   6.122 s |   413,724 KiB |

Size: 785,800,490 → 157,791,949 bytes (749.4 → 150.5 MiB, 79.9% smaller).
Migration peak is 789.2 MiB, compared with legacy peak 3.25 GiB. Admission
history is capped at 256 summaries thereafter; the 150 MiB ordinary payload is
retained. This is a same-shape synthetic measurement, not a production estimate.
Allow several minutes for the first production tick with timer stopped, and
observe actual completion rather than enforcing the measured 51-second duration.

Load stamps (uptime and load averages at phase start): legacy 15 days 07:54,
7.86/6.47/2.89; migration 15 days 07:56, 7.94/7.10/3.56; compacted 15 days 07:56,
5.22/6.47/3.53. Available memory exceeded 13 GiB at every phase start.
