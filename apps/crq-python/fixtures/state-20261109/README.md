# Synthetic crq state fixture (`state-20261109`)

This directory seeds Group E effect tests with a small, schema-shaped crq state
tree. It is **synthetic**. No real ceres state file is published here.

## Why there is no real snapshot

Phase 0.3 permits a redacted real ceres snapshot only when it is verified to
contain no secrets, no private config overlay and no private data. On
2026-11-09 the deployed state was inspected read-only, keys and value types
only, at `~/repos/crq-deploy/apps/crq-python/state` and
`~/.local/state/crq`. That inspection established the shapes below, and it also
established that the live queue, events, work records, repair inbox and run
directories carry private repository slugs, PR numbers, commit identities,
CodeRabbit finding text and worktree paths. Those are private data even after
secret scanning, so the real snapshot was not copied, redacted or attached.
The missing real snapshot is reported in the pull request.

The values here are invented: `example/primary`, `example/other`, fixture SHAs,
fixture digests and a single synthetic minor finding. They exercise the same
field names and types as the inspected files. Nothing here was taken from the
live host.

## Contents

| path | shape source |
|---|---|
| `queue.json` | deployed `state/queue.json`: top-level counters, one item of each common kind (open, merged, merged-current, coverage, local-review, backfill), coverage ledger, merged discovery/reconcile summaries, usage, backfill reservations and admissions |
| `heartbeat.json` | `~/.local/state/crq/heartbeat.json` |
| `next-review-at` | `state/next-review-at` |
| `status.json` | deployed `state/status.json` |
| `events.jsonl` | deployed `state/events.jsonl` |
| `work.jsonl` | deployed `state/work.jsonl` |
| `repair/provider-cooldowns.json` | deployed `state/repair/provider-cooldowns.json` |
| `runs/open-101-20261108T235500Z/` | deployed `state/runs/<run>/`: `meta.json`, `review.ndjson`, `classification.json`, `exit.json`, `findings.md`, `secret-scan.json`, empty `runner.log` and `stderr.log` |

Omitted on purpose: large operational accumulators (`archived_tick_runs`,
`backfill_state_events`, manifest/history imports), receipt trees, ledger
objects, the repair inbox and repair results, and private config overlays.
Group E tests seed those from the specific behaviour under test rather than
from a 20 MB blob.

## Constraints

- `queue.json` is a minimal fixture, not a full production queue: every present
  field has the deployed shape, but optional historian fields may be absent.
  The JSON Schemas from phase 0.2 are the authority once they land. A fixture
  test loads this tree and runs `status_summary.summarize`,
  `coverage.utilization_digest` and `crq.classify` over the run to catch gross
  shape drift sooner.
- `runs/open-101-20261108T235500Z/classification.json` is the exact output of
  the current `crq.classify` over the adjacent `review.ndjson`.
- The fixture contains no live credential, token, private host path, private
  repository or real finding text. `test_vector_emit.py` scans the vector
  family files for the same class of leak; the state fixture carries only the
  `example/*` slugs and fixture hashes shown above.
