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
- `crq.load_queue` and `backfill_jobs.Journal.transact` use the incremental
  reader. Journal also retains its strict nested-duplicate/numeric rejection.
- `crq_repair.py`'s repair drain and `crq_repair.bounded.select_job` directly
  load queue JSON to inspect item/run ownership. They do not interpret admission
  history and never write the queue. These remain ordinary JSON readers.
- `ops/deploy-controller.py`'s `compatibility_record` and `drain_check` use
  `Effects.read_json` for compatibility/liveness checks. Deployment preserves
  queue bytes rather than migrating them.
- Load-plus-save callers through `crq.save_queue` include `tick`/`start`, `slot`,
  `enqueue_merged`, `reconcile-merged` checkpoints, `cmd_measure`, `admin`
  (pause/resume/requeue/skip/block/priority), `enroll_author`, `author_observe`,
  `author_lease_command` when claiming fallback, and `repair-prepare` through
  `repair_tick.prepare_current_job`. `backfill.execute` and
  `backfill.inventory_unlocked` use the same loader/saver, as does
  `queue_transport.handle` for non-inventory queue-v1 operations (including
  status/report reads that persist reconciliation or delivery state). Their in-memory copies
  carry history without inspecting it. Any of these may first save compaction.
- `current_report`, status/summary/synth, author-lease inspection, backfill
  report/dry-run operations, and queue-v1 inventory use loaded snapshots
  without writing queue history. `write_status` and
  `status_summary.publish` render queue data; admission diagnostics flow through
  `backfill_report.summary`.
- The synthetic benchmark's direct JSON loader/atomic writer operates only on
  generated scratch files, never live queue state.
- Receipt, acceptance, ledger publication and quota accounting code do not read
  `backfill_admissions`. Authoritative reservations, usage, daily capacity,
  request state, item attempts and receipts are retained without modification.

The loader reads chunks and decodes individual legacy admission entries, reducing
them immediately into a 256-entry deque. Other top-level values decode one at a
time; memory still scales with the largest non-history field and current queue,
not accumulated admission snapshots. No new JSON parser dependency is needed.
The first locked mutator that saves the compacted queue uses the existing fsync +
atomic-replace writer, then logs before/after bytes on stderr. `crq.save_queue`
tracks the loaded source file identity until a successful write, so this also
works for copied queue snapshots and non-tick commands. Journal transactions
log after their own successful atomic write. Failed writes emit no success log. The version marker
`backfill_admission_history_version: 1` prevents repeated migration writes.
Malformed/truncated JSON fails before any replacement. Read-only status/report
loads compact in memory and leave disk alone; the next mutating save persists
migration. The tick explicitly persists migration before other tick work.

Existing deferred intents refresh before discovery writes, using the same
24-request / 30-second aggregate forge allowance. The budget is neither restarted
nor extended; an exhausted discovery keeps its cursor/debt for a later tick.
This deliberately prioritizes existing intents over discovering new work.

## Deployment

No deployment performed. Stop the timer and wait for the current tick to exit.
Back up queue.json outside the active state directory **before running any new
mutating command**; keep that backup for recovering the full historical audit. Ensure
free disk for the backup plus a full temporary queue, since atomic replacement
retains the original until the new file is fsynced. Run the first tick under the
ordinary scheduler lock and check the `admission compaction v1` byte counts before
resuming the timer. Do not edit/reset reservations or receipts. A crash before
replacement leaves the old queue; a crash after replacement leaves a fully
written compacted queue.

A code-only revert is safe: the previous runner reads the compacted queue,
including the integer marker, and resumes appending legacy snapshots (so history
starts growing again). No backup restore is needed to roll back code.

The backup is only needed to recover full historical diagnostics. Restore the
whole queue only if no ticks **or other mutating commands** have run since the
backup. Otherwise retain the newest queue as authority: recover old admissions
into a separate audit export, or, with the timer stopped and the scheduler lock
held, merge **only** `backfill_admissions` into the latest queue. Preserve every
other current field, especially reservations, receipts, requests and item attempts;
never restore the old queue over them. If legacy history is merged into the active
queue, reset the admission-history marker to 0 so the new runner re-compacts it on
its next mutating save (keep the full merged audit separately).

## Synthetic benchmarks

The generator (`benchmark_admission_history.py`) was deleted with the Python crq
migration (Phase 0.1, 2026-11-09). The measurements below are retained as
historical evidence; they are not reproducible from this tree.

### Stress fixture

Generate only synthetic data; no live queue or production-host access was used. Run
the generator with `<scratch-directory> generate`, then `before`, `compact`, `after`
in separate processes. The fixture has about 150 MiB of ordinary
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
retained. This deliberately oversized non-history stress fixture is not the live shape
and its 150.5 MiB result is not the expected production outcome.
Allow several minutes for the first production tick with timer stopped, and
observe actual completion rather than enforcing the measured 51-second duration.

Load stamps (uptime and load averages at phase start): legacy 15 days 07:54,
7.86/6.47/2.89; migration 15 days 07:56, 7.94/7.10/3.56; compacted 15 days 07:56,
5.22/6.47/3.53. Available memory exceeded 13 GiB at every phase start.

### Live-shaped fixture

The independent review's read-only shape observation found 783,287,101 bytes:
25,526 admission rows (each at most 36.7 KB, at most 112 holds, mostly expired),
about 773.8 MB history and 9.5 MB other data, including 1,596 items (~7.8 MB).
No live contents are copied into the generator.

The generator ran with `<new-scratch-directory> generate-live`, then `before`,
`compact`, `after` in separate sequential processes. This fixture
has 25,526 decisions of 30,535 bytes each, 112 holds (100 expired), and 1,596 items
with about 9.5 MB non-history data. It models the observed shape rather than the
stress fixture's 3,000 holds and 150 MiB ordinary payload.

The independent review also generated a separate live-shaped fixture with about
8 MB ordinary payload: 941,582,322 → 7,897,753 bytes, 13.1 s migration, peak RSS
43,012 KiB; a second load was unchanged with 256 retained rows. Its recorded load
range was 0.4–1.3 with about 13 GiB available on the development VM (uptime was
not recorded with that comparison, so use our stamped run below for timing
comparisons).

Expected production outcome is **around 10 MB**, preserving the ~9.5 MB
non-history data plus bounded summaries. A normal first-write log should show
roughly `before_bytes=783000000 after_bytes=10000000`; exact bytes depend on the
latest queue contents and JSON indentation. Expect migration in tens of seconds
on the observed shape, rather than the stress fixture's minute-scale run. The
reviewer's observed service timeout is ten minutes; observe actual completion
rather than treating any synthetic duration as a deadline.

Our sequential live-shaped run, 2026-11-02 UTC on the same Linux development VM
under nice 5, with the stricter nested-duplicate decoder:

| Phase     | Load/parse |     Save |    Total |      Peak RSS |
| --------- | ---------: | -------: | -------: | ------------: |
| Legacy    |   15.407 s | 37.390 s | 52.797 s | 2,433,776 KiB |
| Migration |   14.003 s |  0.497 s | 14.500 s |    68,604 KiB |
| Compacted |    0.079 s |  0.065 s |  0.144 s |    43,604 KiB |

Size: **788,935,780 → 9,662,443 bytes** (789 MB → 9.66 MB, decimal).
Migration peaks at **67.0 MiB RSS**, compared with legacy peak **2.32 GiB**.
The difference from the reviewer's 7.9 MB result reflects this fixture's larger
non-history payload; both support the expected ~10 MB production result.

Load stamps at phase start: legacy uptime 15 days 08:27, load averages
3.47/1.91/1.62; migration 15 days 08:27, 2.19/1.83/1.61; compacted 15 days 08:28,
1.93/1.78/1.60. Available memory exceeded 13,600 MB before every phase.
