# W5 coverage integration

`coverage.py` is a standalone stdlib policy module. It imports no queue runtime,
executes no processes, reads no repositories, and writes no files. The conductor
integrates it under the queue lock. The original W5 lease is complete; this
document describes the integrated runner, not an active worktree restriction.

## Ledger and completed reviews

Initialize `q['coverage'] = coverage.new_ledger()` if absent; persist it with the
queue's existing atomic save. Schema 1 holds `paths`, deduplicated `runs`, and
idempotent tick `observations`. Retain run IDs for replay safety. Retain observation
history for at least 24 hours; the conductor may prune older observations.

After a terminal counted completion, `crq.py:harvest_review` already extracts
terminal `reviewedFiles`: string entries or object `path`/`fileName` fields.
It calls `coverage.record_review` under the queue lock. `classify`'s count alone
does not establish path evidence. The integrated call has this shape:

```python
q['coverage'] = coverage.record_review(
    q['coverage'], run_id=meta['run_id'], completed_at=record['completed_at'],
    reviewed_paths=paths, review_sha=reviewed_tip,
    counted=cls['counted'], outcome=cls['outcome'], focus_paths=planned_paths)
```

For merged reviews, snapshot `measure.synthetic_paths` and `measure.merge_queue`
in run metadata at launch; use them as `planned_paths` and `reviewed_tip` at
harvest. For coverage use `coverage_paths` and `coverage_sha`. The synthetic head
is not the main SHA. For ordinary reviews pass `focus_paths=None` and the
actual reviewed head. Missing historical reviewed-file evidence earns no credit;
never infer coverage from findings, measurement timestamps, surviving lines,
skipped items, unsuccessful attempts, or review launches. Backfill only counted
completed cycles with explicit terminal path evidence and their original scope.
Deleted paths earn no candidates. Rename aliases are retained in the synthetic
scope but credit is attributed to the current reviewed path; no guessed migration
of historical path credit occurs. Zero reviewed files is a completed run with no
path credit. Replay and out-of-order harvest preserve the latest timestamp.

## Lowest-priority fallback

Add an explicit `kind == 'coverage'` rank of `coverage.COVERAGE_RANK` (4), with no
boost/promotion precedence. Rank alone is insufficient: only attempt coverage
AFTER all ordinary items fail eligibility/planning, inside the existing global
pause, cooldown, hourly cap, and inflight gates. Respect `--only`: no unsolicited
fallback for an explicit item filter. Do not let coverage bypass dependency,
backoff, secret-scan, or failure handling.

Refresh merged measurements through `measure_merged` against the current
`origin/main` SHA, including supersession-skipped merged sources. Candidate
selection uses their surviving/current path and synthetic size data; it deliberately
also admits paths excluded by the ordinary focus threshold, filling those gaps.
Supply caller policy exclusions through `excluded_paths` (generated/secret/vendor
paths, if appropriate). No recursive repository scan is needed.

```python
candidate = coverage.coverage_candidate(
    q, q['coverage'], merge_queue_sha=mq, ordinary_eligible=False, now=now(),
    max_paths=8, min_age_hours=24, excluded_paths=excluded)
```

It selects never-reviewed paths first, then oldest review and fewest reviews,
with deterministic path/source ties. The bounded region is one parent directory
from one merged source. Synthetic scope includes old rename aliases. Default
24-hour freshness prevents repeatedly reviewing a just-completed region; lower
the bound explicitly if continuous repeat coverage is desired. Existing pending,
reviewing, deferred, or blocked coverage suppresses new enrollment. A `repairing`
or `repair_failed` item with a persisted completed cycle credited in the terminal
review ledger does not hold that global review slot. Its own `coverage_paths`
and stored `measure.synthetic_paths` rename aliases remain excluded until
reconciliation, while unrelated regions remain eligible.
Missing completion evidence and unknown states still suppress enrollment. This
neither resolves findings nor alters repair jobs. Retry pending
coverage through the fallback path after ordinary work, and retire stale items
explicitly before recutting. Completed/skipped IDs remain sticky; fresh cuts get
a unique suffix. Sources without fresh tip measurements produce no candidates.

Enroll the returned JSON item only in a real tick. A dry tick uses an in-memory
copy and performs no persistence or Git synthetic construction. For real planning,
check `coverage_sha == current_mq`; otherwise mark the item skipped and recut.
Revalidate existence/nonempty diff and all current policy restrictions before
launch. Call existing `build_synthetic(candidate)` (its explicit nonempty
`measure.synthetic_paths` override fits this API), then construct:

```python
plan = dict(base=base, head=head, target='origin/main', cycle=None,
            branch=None, notes=[], label='lowest-priority coverage review')
```

Capture the pinned tip/scope in metadata. Call existing `launch` so uploads retain
the secret scan, clean worktree, budget accounting, and detached CLI runner.
Handle coverage before the PR-info branch in tick planning: its `pr` identifies
source provenance, not an open PR needing quiet checks. The current harvest
non-open/non-promotion branch already appends one cycle and marks done; adapt
ledger/publishing behavior explicitly so coverage blockers enter the merged-code
repair path and never publish to the historical PR branch. This module performs
no repair, publishing, model dispatch, or GitHub writes.

## Utilization

At each real tick record one opportunity after selection. `started` is true only
when the CLI actually starts (e.g. item state becomes reviewing), or the signer
request really consumes a start. `launch` can return a run ID after a failed secret
scan, so a non-null return alone is insufficient. `pending` describes backlog at
the decision point, before enrollment/launch. `candidate_exists` includes an
eligible existing coverage item or a newly computed candidate. Record global
blocking reasons such as paused/cooldown/hourly_cap/inflight/only; planning or
secret-scan failures on an otherwise available slot are idle opportunities.

```python
q['coverage'] = coverage.record_opportunity(
    q['coverage'], at=tick_at, started=actual_start, pending=pending,
    candidate_exists=has_candidate, blocked_reason=global_gate)
digest = coverage.utilization_digest(
    q, q['coverage'], now=now(), max_starts_per_hour=CONFIG['max_starts_per_hour'])
```

Include `digest` in status and summary via conductor-owned edits. Queue `starts`
already includes signer requests, so do not count event starts again. The 24-hour
cap is nominal (24 times configured hourly cap); server cooldown remains
authoritative. Cooldown minutes means remaining time, not accumulated downtime.
Idle counts are observed available tick opportunities, not estimated missed quota
slots. No observations yields `None` idle counts rather than a misleading zero.
A partial observation window must be labelled as such using `observed_ticks_24h`;
these counters cannot establish historical utilization before integration.

## Focused verification

Use `pnpm test:narrow apps/crq-python/test_coverage.py` for policy changes, and
name the affected harvest tests for integration changes. The original W5
no-tests restriction ended with that lease. Full discovery remains CI-only;
focused tests use fixtures and authorize no live queue or model dispatch.
