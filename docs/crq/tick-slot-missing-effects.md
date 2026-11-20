# CRQ tick and slot: missing live effects (S6 inventory)

Status: inventory at `main` `bace10728` plus this PR (S6-0). The TypeScript
`tick` and `slot` are **not live**: `crq.ts` routes neither command, and
`LIVE_UNIT_COMMANDS` (`src/queue-runner/capabilities.ts`) is
`['watchdog', 'publish', 'backfill inventory']` on `main` and neither command
is added to it. Do not switch `crq-tick.service` or
`crq-slot.service` to a Node runtime until every row below is closed and the
two commands are routed and declared together.

The sequencing exists and is tested: `runTick`
(`src/queue-runner/tickOrchestrator.ts`, `crq.tick` at
`apps/crq-python/crq.py:3483`), `runScheduledSlot`/`runSlot`
(`src/queue-runner/slotOrchestrator.ts`, `crq.py:3447`/`:3469`) and the
composition `composeTickPhases`/`composeSlot` (`src/adapters/crq/composeTick.ts`).
What is missing is the effects those sequences call. `RemainingPhaseNames`
(`composeTick.ts:42`) is the compile-time list of unbound tick phases, and
`TICK_MISSING_EFFECTS` (`src/queue-runner/tick.ts`) is the same list in the
dry-run plan's `reason`, so a shadow never treats a partial plan as parity.

## Bound (no gap)

| Phase                                                                                                        | Binding                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runnerDisabled`, `loadQueue`, `saveQueue`, `parseIso`, `nowMs`, `nowIso`, `event`, `mergedDiscoveryEnabled` | `fileTickSeams` (`src/adapters/crq/tickPhaseSeams.ts`)                                                                                                 |
| `deliverIssues`, `deliverPrReviews`, `deliverCleanReviews`, `deliverReviewRefreshes` (sequencing)            | `bindDeliveryPhases` (`src/adapters/crq/deliveryWiring.ts`); its `DeliveryEnv` is a gap below                                                          |
| `admit` (gate, budget, loop)                                                                                 | `bindAdmit` (`src/adapters/crq/admitWiring.ts`); its `startOne` is a gap below                                                                         |
| `refreshSlotDeadline`, `writeHeartbeat`                                                                      | `fileSlotDeadlineEffects`, `fileHeartbeatEffects` (`src/adapters/crq/slotDeadlineSource.ts`)                                                           |
| `fetch` (S6-0)                                                                                               | `fileTickFetch` (`src/adapters/crq/tickHostEffects.ts`): `git fetch --prune --quiet origin` in `config.clone`, Python `run`'s error text, `crq.py:317` |
| `notifyOwner` (S6-0)                                                                                         | `notifyOwnerFrom` (`tickHostEffects.ts`) over `spawnNotifySend`: `CONFIG.alerts` destination, `crq.py:1994`                                            |
| `readSlotUsage` (S6-0)                                                                                       | `fileReadSlotUsage` (`tickHostEffects.ts`): progress probes in queue order, then usage; marks `vendor_observed` only on a usage read, `crq.py:3340`    |
| `recordCoverage` (S6-0)                                                                                      | `recordCoverage` (`tickHostEffects.ts`) over `src/policy/crq/coverageOpportunity.ts`, `coverage.py:43`/`:469`                                          |
| slot lock, queue equality, preflight hint                                                                    | `slotTickLock`, `fileSlotPhases` (`src/adapters/crq/slotPhaseSeams.ts`), `fileSlotPreflightEffects` (`slotSource.ts`)                                  |

S6-0 changed the `readSlotUsage` phase to return `{ queue, usage, reserved }`.
Python marks observed runs `vendor_observed` in place; queues are immutable in
TypeScript, so the probe returns the marked queue. `runTick` threads it into
admission, and `runScheduledSlot`/`composeSlot` continue from the probed copy,
as Python's `slot(observed, observation)` does.

## S6-f: offline composition and what is still staged

`composeFullTick` (`src/adapters/crq/tickComposition.ts`) binds the sixteen
`RemainingPhaseNames` to the merged S6-a..e adapters and `composeSlot`'s
`collectFinished` to `createHarvestPhases`. It is inactive: no runtime entry
imports it, `crq.ts` routes neither `tick` nor `slot`, and `LIVE_UNIT_COMMANDS`
(`['watchdog', 'publish', 'backfill inventory']`) and the capabilities are
untouched.

| Phase                                                           | Binding                                                                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backfillPublish`, `backfillInventoryMode`, `backfillInventory` | `fileLocalReviewPublishEffects`, `tickBackfillInventory`; always bound (a gap there would be swallowed by `backfill_halted`)                        |
| `discovery`, `enrollPrimary`, `enrollOthers`                    | `tickDiscoveryBinding`                                                                                                                              |
| `resetFixPrBacklog`, `refreshFixPrBacklog`                      | `FixPrBacklog` (one `TICK_BACKLOG`, returned for the publisher) plus `fileFixPrBacklogEffects`                                                      |
| `repairBackfill`, `archiveLegacy`                               | `fileRepairBackfillEffects` over a plain-queue bridge                                                                                               |
| `harvestItems`, `reconcileCompleted`, `collectFinished`         | `createHarvestPhases`; run artifacts of a Python `_review` child (`review.pid`, `review.ndjson`, `exit.json`, `meta.json`) by `fileHarvestRunReads` |
| `reconcile`                                                     | `fileReconcilePhaseEffects`; its new `onSaved` hook returns the reconciled queue                                                                    |
| `writeStatus`, `publishLocalReviewPr`, `recordClientHealth`     | `fileReportingPhases`                                                                                                                               |

A phase whose caller input is absent is bound to a function that rejects with
`TickGapError` (never a no-op), because Python abandons a tick on a phase error
and saves nothing. `TickComposition.unbound` lists those. `STAGED_GAPS` lists
work no adapter does whatever the caller supplies; `complete` is true only when
both are empty. `TICK_MISSING_EFFECTS` (`src/queue-runner/tick.ts`) repeats
`STAGED_GAPS` (a test keeps them in step):

- `harvest-review-effects`: `harvest_review` effects beyond the run-artifact reads (findings.md for non-local kinds, `removeWorktree`, `writeReceipt`, `repairEnqueue`, `backfillHarvest`, `requestPrReview`, coverage).
- `repair-harvest-effects`: `repair_tick.harvest` queue side (worktree, verify, mechanical, `markFindingOutcome`, `cleanupHarvested`, publish); only the reads are file-backed.
- `start-one-effects`: per-kind `LaunchEffects` and `CoverageEffects` for `admit.startOne`.
- `review-child`: `_review` is not routed in the TS runner; Node needs `--foreground`, the tick kick and backfill proof, or the tick spawns the Python child.
- `repair-parity`: repair-side tick passes have no seeded differential against Python.
- `shadow-d2`: only the plan is shadowed, not the composed phases.

Closed in S6-g, kept here as the record:

- `usage-context`: `bindAdmit` now runs what `admit_available` runs before its
  gate: `q["usage"] = usage`, `backfill_runtime.usage_context` and
  `q["backfill_starts_at_observation"] = len(starts)`, on dry runs and closed
  gates too, so the saved queue carries `backfill_usage` and any reflected or
  expired backfill hold. It reuses `usageContext` from
  `src/ops/crq/internal/backfillGate.ts` (JsonObject-based, so `None` start
  stamps, unreadable `terminal_at` and a non-object hold fail as Python does),
  not the plain-record `coverageUsage.usageContext`, which is test-only and
  matches an undated hold differently. Replayed against Python by the
  `usage-context` group-P family (`test/adapters/crq/admitUsageContext.test.ts`).
  An unhashable `attempt_id` is now a refusal in `usageContext`, as Python's
  `attempt_id in dict` is a `TypeError`.

Closed in S6-f, kept here as the record:

- The primary clone was fetched twice per tick (`fetch`, then `discoverOpenPrs`).
  `tickDiscoveryBinding` now passes `enroll.primaryFetched` and the enrollment
  source skips its own primary fetch; a standalone caller still fetches. Python
  fetches the primary once (`crq.py:3550`); non-primary repos fetch their default
  branch in enrollment (`pr_enroll.py:44`), as before.
- The primary listing-failure log now reads `enrollment skipped: <reason>`
  (`crq.py:3127`); a configured repo keeps `pr discovery skipped <repo>: <reason>`
  (`pr_enroll.py:31`).

Intentional remaining difference: `<reason>` is the opaque `forge listing
unavailable`, not Python's raw exception text. The raw text is a Python
exception string (`gh` stderr, `OSError`) with no TS equivalent, and the ported
discovery deliberately never logs forge or git error bodies. The log lines are
informational; nothing parses them.

The tables below are the S6-0 inventory and are historical for every row that
S6-a..f bound.

## Missing, by area (S6-0, historical)

Sizes are rough estimates of adapter and glue code over the existing pure logic.

### Harvest (about 1.3k–1.7k lines)

| Gap                                             | Python                                                                                                                                                                | TypeScript pieces                                                                                                                                                                                                                                                                                | What is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `harvestItems`: `harvest_review` for every kind | `crq.py:2619` (~270 lines) plus `classify`, `findings_md`, `ledger_append`, `advance_open`, `set_rate_cooldown`                                                       | loop `harvestLoop` (`src/queue-runner/harvestDelivery.ts:62`); `classify` (`src/policy/crq/classification.ts:41`); local-review only: `harvestLocalReviewExit` (`src/ops/crq/internal/localReviewExit.ts`), `createLocalReviewHarvestCaller` (`src/adapters/crq/localReviewHarvestCaller.ts:11`) | Every kind except `local-review` (`localReviewExit.ts:104` throws `not a local-review item`): `review_receipt`, push-current, open/delta/merged/coverage/author and backfill dispatch. That covers `classification.json` and `findings.md`, the `review_finished` event, cycles and receipts, the cooldown and pause rules, the `next-review-at` hint and repair enqueue. It also needs a bridge from `harvestLoop`'s plain records to the immutable `JsonObject` queue. |
| `harvestItems`: repair harvest                  | `repair_tick.harvest` (`repair_tick.py:422`)                                                                                                                          | ledger half: `fileRepairHarvestEffects` (`src/adapters/crq/repairHarvestSource.ts:26`), `repairHarvestExecution.ts`                                                                                                                                                                              | Queue-side port of `repair_tick.harvest` and its binding as `HarvestLoopEffects.repairHarvest`.                                                                                                                                                                                                                                                                                                                                                                          |
| Fix-PR backlog around the harvest loop          | `crq.py` tick: `reset_fix_pr_backlog` / `refresh_fix_pr_backlog` (`repair_tick.py:626`/`:603`) under `ForgeBudget(1, 30)`, writing `state/repair/fix-pr-backlog.json` | none                                                                                                                                                                                                                                                                                             | Port, and a slot in `runTick` (it has no phase between `discovery` and `harvestItems`).                                                                                                                                                                                                                                                                                                                                                                                  |
| `reconcileCompleted`                            | `local_review_runtime.reconcile_completed` (`local_review_runtime.py:120`)                                                                                            | `localReviewReconcile.ts`, `createLocalReviewCompletedCaller` (`src/adapters/crq/localReviewCompleted.ts:19`)                                                                                                                                                                                    | A `(queue) => queue` phase wrapper.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `repairBackfill`                                | `repair_tick.backfill` (`repair_tick.py:848`)                                                                                                                         | none                                                                                                                                                                                                                                                                                             | Port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `archiveLegacy`                                 | `repair_tick.archive_legacy` (`repair_tick.py:879`)                                                                                                                   | none                                                                                                                                                                                                                                                                                             | Port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `reconcile`                                     | `repair_tick.reconcile_fix_prs` (`repair_tick.py:1475`) under `ForgeBudget(80, 60)`                                                                                   | `runReconcilePhase` (`src/queue-runner/tickDiscoveryPhase.ts:92`), `fileReconcilePhaseEffects` (`src/adapters/crq/tickReconcilePhaseSource.ts:44`)                                                                                                                                               | The adapter returns counts only; the reconciled queue stays on disk, so the phase must return it. `deliveryPasses` (`harvestDelivery.ts:120`) is an older duplicate of the reconcile report with no runtime caller.                                                                                                                                                                                                                                                      |
| slot `collectFinished`                          | `crq.py:3369`                                                                                                                                                         | `collectFinished` (`src/queue-runner/collectFinished.ts:38`)                                                                                                                                                                                                                                     | Effect binding (exit probe, liveness, republish) and the `harvest_review` dependency above.                                                                                                                                                                                                                                                                                                                                                                              |

### Admission and launch (about 1.5k–2k lines)

| Gap                                  | Python                                                                                           | TypeScript pieces                                                                                                                                      | What is missing                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admit.startOne`                     | `start_one` (`crq.py:3198`)                                                                      | selection loop `startOne` (`src/queue-runner/startOne.ts:116`)                                                                                         | A `StartOneEffects` implementation. That means a `planItem` dispatcher by kind over `planOpen`/`planDelta` (`ordinaryPlan.ts:92`/`:144`), `planMerged`/`planAuthor` (`mergedAuthorPlan.ts`), `prepareCurrent`, `preparePushCurrent` and the local-review prepare (`preparePasses.ts`), plus the PR lookup and quiet gate. `ensure_commit`, `measure_merged` and `build_synthetic` exist only as effect members.                  |
| `launch`                             | `launch` (`crq.py:2004`)                                                                         | `reserveAndSpawnReview` (`src/queue-runner/reviewLaunch.ts:64`), `prepareOrdinaryReview` (`src/queue-runner/reviewPreparation.ts:48`, open/delta only) | Meta, scan and `cmd` for receipt, push-current, local-review, author, merged/coverage and backfill. Also the secret scan with exemptions and a blocked-scan receipt. `ReviewLaunchEffects` is unbound.                                                                                                                                                                                                                           |
| Detached review child                | `cmd_review_child` (`crq.py:2202`), spawned as `python3 crq.py _review <run_id>` (`crq.py:2150`) | `runReviewChild` (`src/adapters/crq/reviewProcess.ts:103`), no runtime caller                                                                          | `_review` is in the runner's command set (`src/queue-runner/runner.ts:31`) but not routed. `runReviewChild` differs from Python in three ways. It runs `timeout` without `--foreground`. It does not start `crq-tick.service` (`--no-block`) when the child finishes. It refuses backfill submission proof. An interim TS launch could spawn the Python child (same artifact names: `review.pid`, `review.ndjson`, `exit.json`). |
| Coverage fallback and backfill usage | `_coverage_fallback` (`crq.py:3131`), `backfill_runtime.usage_context`                           | `coverageFallback`, `usageContext` (`src/queue-runner/coverageUsage.ts`)                                                                               | Effect binding (17 members; `measureMerged`, `buildSynthetic` and `legacyOrigins` have no implementation). `bindAdmit` calls the `backfillGate.ts` `usageContext` since S6-g (this row's `coverageUsage.ts` copy stays test-only).                                                                                                                                                                                               |

### Discovery, enrollment, delivery and reporting (about 1k–1.4k lines)

| Gap                             | Python                                                                                              | TypeScript pieces                                                                                                                                                        | What is missing                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backfillPublish`               | `backfill_runtime.publish` (`backfill_runtime.py:455`)                                              | writer inside `requestPublish` (`src/adapters/crq/localReviewPublish.ts:64`)                                                                                             | A `(queue) => queue` phase that also clears a `publication-request` halt.                                                                                                        |
| `backfillInventoryMode`         | `backfill_runtime.settings` (`backfill_runtime.py:37`)                                              | `rolloutSettings` (`src/ops/crq/backfillInventory.ts:122`)                                                                                                               | `inventory_mode` is not parsed.                                                                                                                                                  |
| `backfillInventory`             | `backfill_runtime.run_inventory` (`backfill_runtime.py:561`)                                        | `runBackfillInventory` (`backfillInventory.ts:219`, report-only, reads disk)                                                                                             | The in-tick enqueue path: capture, subjects, `jobs.enqueue`, supersede retirement, halt clearing.                                                                                |
| `discovery`                     | `crq.py` tick: deferred refresh, `discover_merged`, `push_current.discover` (`push_current.py:146`) | `runDiscoveryPhase` (`tickDiscoveryPhase.ts:29`), `fileDiscoveryPhaseEffects` (`tickDiscoveryPhaseSource.ts:21`), `runMergedDiscoveryStep` (`tickMergedDiscovery.ts:40`) | Composition. The `merged` seam, push repositories and `event` are caller-supplied; nothing calls `runMergedDiscoveryStep`.                                                       |
| `enrollPrimary`, `enrollOthers` | `enroll` (`crq.py:3058`), `pr_enroll.enroll` (`pr_enroll.py:20`)                                    | `runEnrollmentPhase` (`tickDiscoveryPhase.ts:64`), `fileEnrollmentPhaseEffects` (`tickEnrollmentPhaseSource.ts:37`)                                                      | A builder from `config.json` to `OpenPrRepository[]`, local-review facts and `event`. The double primary fetch and the primary skip-log wording were closed in S6-f (see above). |
| Delivery env                    | `pr_review_findings.py`, `finding_issues.py`, `crq_review_identity.py`                              | `authenticatedGh` (`src/policy/crq/reviewIdentity.ts:114`), `nodeIdentityDeps`, `fileFindingIssue`                                                                       | The delivery `gh` port, `ReceiptFiles.readBytes`, `readText` and the `push.repoMode`/`readFindings`/`fileIssue` adapters.                                                        |
| `writeStatus`                   | `write_status` (`crq.py:3654`)                                                                      | `writeStatusForDocuments` (`src/ops/crq/statusWriter.ts:1004`), `runStatusWriter` (`src/adapters/crq/statusWriter.ts:285`, re-reads disk)                                | An in-process write from the tick's queue. The adapter's schedule-failure text is fixed (`statusWriter.ts:67`), whereas Python embeds the exception.                             |
| `publishLocalReviewPr`          | `local_review_pr.publish` (`local_review_pr.py:100`)                                                | none (`review_pr_outbox` appears only in the schema)                                                                                                                     | Port.                                                                                                                                                                            |
| `recordClientHealth`            | `client_health.record` (`client_health.py:119`)                                                     | read side only: `clientHealthSnapshot` (`src/policy/crq/clientHealth.ts:36`)                                                                                             | Port of `record`/`advisory`/`checkout_sha`.                                                                                                                                      |

## Parity fixes made in S6-0

- `runTick` passed `only === null && mergedDiscoveryEnabled()` to
  `recordClientHealth`; Python passes `not only and …`, so `only == ''` is
  unrestricted. Fixed; the old test that pinned the wrong value is corrected.
- `buildTickPlan` counted `boost` on retired promotion rows; `load_queue` pops
  it from live items only. Fixed after the new differential caught it.
- `readSlotUsage` had no way to carry Python's in-place `vendor_observed` mark.
  It now returns the marked queue (see above).

## Suggested split (each one PR along a module boundary)

1. Harvest: `harvest_review` per kind plus `collectFinished` binding.
2. Repair-side tick passes: `repair_tick.harvest` queue side, `backfill`, `archive_legacy`, the fix-PR backlog (with a `runTick` slot), and the `reconcile` queue return.
3. Admission: `planItem` and `launch` per kind, coverage fallback, `usageContext`, and the `_review` child (Node with `--foreground` and the tick kick, or spawning the Python child).
4. Discovery and enrollment composition, plus backfill-in-tick.
5. Reporting and delivery env: `writeStatus`, `local_review_pr`, `client_health`, `DeliveryEnv`.
6. Composition and switch: route `tick` and `slot` in `crq.ts`, add both to `LIVE_UNIT_COMMANDS`, extend the seeded differential and the shadow to the whole tick.
