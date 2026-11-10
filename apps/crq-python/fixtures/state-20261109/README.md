# State-derived, fully redacted fixture (`state-20261109`)

This directory seeds Group E effect tests with a small, schema-faithful crq
state tree. Its **values are synthetic**; its **schema is derived read-only**
from the deployed ceres state and recorded in `provenance.json`. No real state
value is published here.

## What was derived from real state

On 2026-11-09 the deployed state was inspected read-only at
`~/repos/crq-deploy/apps/crq-python/state` and `~/.local/state/crq`.
`state_fixture_provenance.py` emits only:

- allowlisted schema key names that are present, and their JSON value types;
- item kinds and code-enum item states;
- bucketed counts (not exact totals; exact zero is retained for unknown-key
  diagnostics, nonzero counts are bucketed);
- run artifact file names and their key/type shape;
- a SHA-256 of the structural projection.

It never emits a scalar value. Repository slugs, PR numbers, commit and tree
IDs, item/run/job IDs, paths, host names, timestamps, finding text, notes,
credentials and config entries are dropped. Unknown keys are bucketed, not
named, so a corrupt or private dynamic key cannot leak through the projection.
`events.jsonl` and `work.jsonl` are scanned end to end, not sampled, so a key
that first appears in the tail is still reported.
`assert_safe` refuses output containing known private markers, and
`test_state_provenance.py` runs the extractor over a synthetic tree with planted
private values and asserts none of them survive.

## Why there is no value-bearing real snapshot

A redacted value snapshot cannot be established safe. The live queue, events,
work records, repair inbox and run directories are dominated by private
identifiers and free text: repository slugs, PR numbers, commit identities,
CodeRabbit finding titles and bodies, worktree paths and operator notes. Every
allowlist that removes those leaves only booleans, small integers, timestamps
and enums; shifting and permuting them still preserves private activity
fingerprints. Publishing such a snapshot would be unverified private data, so
this directory publishes the structural projection instead. The fixture values
remain invented. The missing value snapshot is reported as a precise blocker in
the pull request.

## Contents

| path | shape source |
|---|---|
| `provenance.json` | emitted by `state_fixture_provenance.py` from the deployed state on 2026-11-09; keys, types, states and bucketed counts only |
| `queue.json` | deployed `state/queue.json`: every top-level key, one item of each real kind (author, backfill, coverage, delta, local-review, merged, merged-current, open, promotion, push-current), coverage ledger, merged discovery/reconcile summaries, usage, backfill reservations and admissions |
| `summary.json` | `~/.local/state/crq/summary.json`: every published summary key, generated from the fixture and filled with fixture values |
| `heartbeat.json` | `~/.local/state/crq/heartbeat.json` |
| `next-review-at` | `state/next-review-at` |
| `status.json` | deployed `state/status.json` |
| `events.jsonl` | deployed `state/events.jsonl`; one event covers every recorded event key |
| `work.jsonl` | deployed `state/work.jsonl` |
| `repair/provider-cooldowns.json` | deployed `state/repair/provider-cooldowns.json`; provider names replaced with `provider-a` and `provider-b` |
| `runs/open-101-20261108T235500Z/` | deployed `state/runs/<run>/`: `meta.json`, `review.ndjson`, `classification.json`, `exit.json`, `findings.md`, `secret-scan.json`, `review.pid`, empty `runner.log` and `stderr.log` |

Large accumulators (`archived_tick_runs`, `backfill_state_events`,
manifest/history imports, receipt trees and ledger objects) are present as
empty containers so the top-level schema matches the deployed queue. Group E
tests seed their contents from the specific behaviour under test rather than
from a 20 MB blob.

## Constraints

- `queue.json` is a minimal fixture, not a full production queue: every present
  field has the deployed type, but optional historian fields may be empty.
  `provenance.json` records which keys and types the deployed state exposed.
  The JSON Schemas from phase 0.2 are the authority once they land.
- `test_state_provenance.py` proves that the fixture covers every recorded
  top-level key, every item kind, every item key per kind, every sidecar key,
  every event/work key and every run artifact key, and that fixture item states
  are a subset of the real states for that kind. It also exercises rejection of
  planted private values and deterministic `--check` output.
- `runs/open-101-20261108T235500Z/classification.json` is the exact output of
  the current `crq.classify` over the adjacent `review.ndjson`.
- The fixture contains no live credential, token, private host path, private
  repository or real finding text. `test_vector_emit.py` scans the vector
  family files for the same class of leak; the state fixture carries only the
  `example/*` slugs and fixture hashes shown above.
