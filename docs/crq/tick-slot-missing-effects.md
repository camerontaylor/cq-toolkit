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

| Phase                                                           | Binding                                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backfillPublish`, `backfillInventoryMode`, `backfillInventory` | `fileLocalReviewPublishEffects`, `tickBackfillInventory`; always bound (a gap there would be swallowed by `backfill_halted`)                                                                                                                 |
| `discovery`, `enrollPrimary`, `enrollOthers`                    | `tickDiscoveryBinding`                                                                                                                                                                                                                       |
| `resetFixPrBacklog`, `refreshFixPrBacklog`                      | `FixPrBacklog` (one `TICK_BACKLOG`, returned for the publisher) plus `fileFixPrBacklogEffects`                                                                                                                                               |
| `repairBackfill`, `archiveLegacy`                               | `fileRepairBackfillEffects` over a plain-queue bridge                                                                                                                                                                                        |
| `harvestItems`, `reconcileCompleted`, `collectFinished`         | `createHarvestPhases`; run artifacts of a Python `_review` child (`review.pid`, `review.ndjson`, `exit.json`, `meta.json`) by `fileHarvestRunReads`; findings, worktree removal, receipt and PR-review request by `fileHarvestReviewEffects` |
| `reconcile`                                                     | `fileReconcilePhaseEffects`; its new `onSaved` hook returns the reconciled queue                                                                                                                                                             |
| `writeStatus`, `publishLocalReviewPr`, `recordClientHealth`     | `fileReportingPhases`                                                                                                                                                                                                                        |

A phase whose caller input is absent is bound to a function that rejects with
`TickGapError` (never a no-op), because Python abandons a tick on a phase error
and saves nothing. `TickComposition.unbound` lists those. `STAGED_GAPS` lists
work no adapter does whatever the caller supplies; `complete` is true only when
both are empty. `TICK_MISSING_EFFECTS` (`src/queue-runner/tick.ts`) repeats
`STAGED_GAPS` (a test keeps them in step):

- `harvest-review-effects`: `fileHarvestReviewEffects` (`src/adapters/crq/harvestReviewEffects.ts`) binds findings.md for non-local kinds, `removeWorktree`, `writeReceipt` and `requestPrReview`, each differentially pinned against Python. `repairEnqueue` is bound from the repair-backfill input (`crq_repair.findings` is ported in `src/queue-runner/repairFindings.ts` and read from `RUNS/<run>/review.ndjson`; git, the repair config and the merged-current flag stay injected), `backfillHarvest` is bound by `backfillHarvestEffect` (`src/adapters/crq/backfillHarvestEffect.ts`, differentially pinned, not routed) over the injected git, outbox, inbox, store, `state_event`, queue save and cleanup, but not Python's unverified-terminal retain strings or its quota-cause/no-cooldown outcomes, which throw, and the coverage seam has no harvest-side implementation (start-one `CoverageEffects`).
- `repair-harvest-effects`: `repair_tick.harvest` queue side. `markFindingOutcome` and `recordUnpublishedFixedSibling` (`fileRepairOutcomeEffects`, `src/adapters/crq/repairOutcomeEffects.ts`) and `cleanupHarvested` (`fileRepairCleanup`, `src/adapters/crq/repairCleanupEffects.ts`) are file-backed and differentially pinned against Python (`apps/crq-python/repair_harvest_effects_vectors.py`); none is composed into the tick. The job/result reads (`readJob`, `readResult`, `resultExists`) are bound in `src/adapters/crq/repairHarvestReads.ts`, not by `fileRepairHarvestEffects`, and this emitter does not pin them. Bound offline but not composed into the tick or routed: `makeWorktree`/`removeWorktree`, `verify` and `mechanical` (`src/adapters/crq/repairHarvestRunners.ts`), `requireCanonicalDelivery`, `saveQueue` and `replayBudget` (`repairHarvestState.ts`), and `publish` with its leased push (`repairHarvestPublish.ts`, exercised against a local bare remote). Bound offline, differentially pinned (`repair_harvest_rest_vectors.py`), not composed or routed (`src/adapters/crq/repairHarvestForge.ts`): the `gh pr create` write (`ghCreateRepairPr`), `newItem` with its clock (`fileRepairNewItem`) and the `save_queue` admission-history compaction log (`fileRepairSaveQueue`; its loader half is `pendingCompactionLoader` (`src/adapters/crq/pendingCompactionLoader.ts`, differentially pinned against `crq.load_queue`, sharing one `QueueCompaction` with `fileRepairSaveQueue`); neither is composed, and the production `loadQueueDocument` still refuses a queue needing compaction, so no runtime caller records one). The forge reads and the gitleaks invocation are exercised against identical fake `gh` and `gitleaks` binaries but still need a live `gh`, token and gitleaks at runtime; the 600 s bound is not waited for in tests. The row stays open until the slots are composed into the tick.
- `start-one-effects`: `fileLaunchEffects` (`src/adapters/crq/launchEffects.ts`) binds the clock, repo identity, band, run directory, worktree, `meta.json`, work record, event and `_review` spawn effects. `fileLaunchBindings` (`src/adapters/crq/launchBindings.ts`, differentially pinned by `launch_bindings_vectors.py`) binds the scans (`secret_scan`, `secret_scan_diff`, exemptions), blocked receipt, author lease, on-demand clone and queue save, but nothing composes it into the tick yet; gitleaks discovery semantics are pinned (`gitleaksDiscovery.ts`, `findGitleaksOnPath`, differentially pinned by `gitleaks_discovery_vectors.py` against Python 3.14 `shutil.which`, one helper behind `fileReviewGitleaks`, `repairPreparation` and `authorSnapshotInstall`), but the production binding stays unbound: which PATH and scratch root a caller passes is caller-owned and held; `provision` is not part of launch: it belongs to the review-v1 submit path and is bound by createReviewEffects, differentially pinned; the `save_queue` admission-history compaction log is bound offline (`fileRepairSaveQueue` and `pendingCompactionLoader`, differentially pinned) but the `fileLaunchBindings` queue save does not use it. `CoverageEffects` `select` (`backfill_runtime.py:162`) is bound over `src/adapters/crq/coverageSelect.ts` (differentially pinned by `coverage_select_vectors.py`) only when `makeCoverageEffects` is given its `select` input; the live collaborators it takes stay unbound: `c.launch` (the reviewer process spawn), `services`/`GitLedger.fetch` (the real ArtifactStore, Outbox, Spool and publisher), the file-backed `coverage.load`/`coverage.request` and the publication-failure file probe (nothing supplies them yet). `makeCoverageEffects` (`src/adapters/crq/coverageEffects.ts`) binds `buildSynthetic` (`crq.py:1102`, `src/adapters/crq/buildSynthetic.ts`, differentially pinned by `build_synthetic_vectors.py`, only when the `synthetic` git deps are supplied), `mergeQueueSha`, `diffNameOnly`, `measureMerged`, `coverageCandidate`, `legacyOrigins`, `legacyRetryAllowed`, the clocks (`nowMs`, `parseIsoMs`) and queue helpers (`liveItems`, `compareItems`, `depsMet`) when the `tick` input supplies the injected clock and scheduling config, `backfillDispatchConfigured` (`backfill_runtime.py:37`) when the `dispatch` input supplies the state root and policy loader (all over `src/adapters/crq/coverageTickSeams.ts`, differentially pinned by `coverage_tick_seams_vectors.py`), and, over `src/adapters/crq/coverageBackfillSeams.ts` (differentially pinned by `coverage_backfill_vectors.py`), `rank4Gate` (`backfill_runtime.py:123`), `bindRun` and `cancelBeforeVendor` (`backfill_jobs.py:165`/`:173`). The rank4 gate's clock, ordinary eligibility, usage refresh, state-event outbox and queue writer stay injected as `Rank4Collaborators`.
- `shadow-d2`: only the plan is shadowed, not the composed phases.

Closed: `repair-parity`. `test/adapters/crq/repairTickParity.test.ts` replays seeded on-disk states through the composed `repairBackfill`, `archiveLegacy` and `harvestItems` phases against `apps/crq-python/fixtures/crq-repair-tick-parity/cases.json`, produced by the real `repair_tick` passes (`apps/crq-python/repair_tick_parity_vectors.py`). Effects not composed into this differential (worktree, verify, mechanical, canonical delivery, queue save, publish; the replay budget is the real TS class with only its clock stubbed) use the same deterministic stub on both sides. Five pinned deviations and two disclosed gaps are listed in the test header, including the malformed-inbox family and the identity guard. Not covered: the TS-only `invalid repair inbox: ` replay arm in `repairHarvest.ts` (no Python verdict can carry that reason), which `repairHarvest.test.ts` pins, and array items in `queue.items`, which the held `liveItems` drops where Python raises. It is not routed.

Closed: `review-child`. `_review <run_id>` is routed in `crq.ts` through `runReviewChildMain` as an internal command. It is not in `LIVE_UNIT_COMMANDS`, because no systemd unit runs it. `tick` and `slot` stay unrouted.

Partly closed in S6-h (`publish`'s recovery arm, inactive): `recoverPublication`
(`src/queue-runner/publicationRecovery.ts`) is the decision and effect binding
for `repair_tick.recover_publication` (`repair_tick.py:756`), over injected
`ls-remote`, `pr_info`, `pr list`, ancestry, push and finalize effects. It pins
the lease on the journaled `target` for an open PR (not the stale ls-remote
read), the refusal when that lease is not an ancestor of the journaled head, the
empty lease for an absent branch, the refusal of a present branch that differs
from the journal without an open PR, the refusal (`remote branch read is stale
against the open PR head`, in both runtimes) when the earlier ls-remote read says
the prepared head is published but the later open-PR read is still at the
journaled `target`, and the stale and finalize outcomes. What
`repair-harvest-effects` still lacks for publication:

- The `push` binding is `repairHarvestPublish.ts`: Python's exact
  `git push origin --force-with-lease=refs/heads/<b>:<expected> <sha>:refs/heads/<b>`,
  failing with `c.git`'s RuntimeError text, not `leasedPush` (whose
  not-fast-forward message and already-at-`sha` success differ). It is only
  exercised against a local bare remote.
- The real bindings of `finalize_publication`'s effects (below): its state
  transitions are ported, see S6-i.
- The first-publication arm of `publish` (journal absent): its decision
  sequence is ported, see S6-j. The real cherry-pick replay and the scans stay
  unbound. `publish` with an existing journal is `recoverPublication`.
- The journal read (`publication.json`) and the journal, patch, fix-PR body and
  queue writes: bound offline in S6-k (below).

S6-i (inactive): `finalizePublication`
(`src/queue-runner/publicationFinalize.ts`) is `repair_tick.finalize_publication`
(`repair_tick.py:804`) over injected effects, to be passed as
`recoverPublication`'s `finalize`. Pinned in
`test/queue-runner/publicationFinalize.test.ts`: the `record.publication`,
`repair_own_commits` (deduped as `list.extend(generator)` does, repeats inside
one publication too) and `published_commits` writes; the same-PR `last_push` and
`fix_pr`; the branch arm's listing, then attempts limit (`stale`, bookkeeping
kept), then the #2288 backlog hold (bookkeeping restored, no attempt counted),
then body, journal (`pr_create_pending`, `pr_create_attempts`) and queue save
before the create, the slot reserved before and released only on a `gh` non-zero
exit (`RuntimeError`), and the #2290 requirement that the result be exactly one
PR at the prepared `head` (else `ValueError`, nothing recorded or enrolled)
before the item is enrolled and the record `published`. Effects still unbound:
`listBranchPrs` (`gh pr list ... --state all`), `createPr` (`gh pr create`),
`repairProvenance` (bound in S6-r), `writeFixPrBody` and `writeJournal` (`fix-pr.md`, `publication.json`),
`saveQueue`, `newItem` (bound in S6-s) and the `FixPrBacklog` shared with
`refreshFixPrBacklog`. Narrowings: PR numbers are modelled as integers (`str()` of
a float, bool or `None` differs), and a non-list `commits` or
`repair_own_commits` is a `TypeError` where Python would iterate a string.

S6-j (inactive): `publishRepair` (`src/queue-runner/publicationPublish.ts`) is
`repair_tick.publish` (`repair_tick.py:665`) over injected effects, to be bound as
`repair_harvest`'s `publish`. Pinned in
`test/queue-runner/publicationPublish.test.ts`, which mirrors
`test_repair_replay.py`, `test_repair_publication_lease.py` and
`test_repair_backlog.py`: a present journal is `recoverPublication` with
`finalizePublication` as its finalize and nothing else (no worktree, replay or
new journal); the pre-worktree `stale` marks (closed PR, base not an ancestor of
the PR head); the replay's stale-versus-retry split (a recorded `CHERRY_PICK_HEAD`
with conflicts or an empty index is `stale`, truncated to 200 code points, any
other failure propagates); each repair verified over its own claimed range; the
hack scan (any `ValueError`, including `DetectorUnavailable`, rewrapped as
`publication <message>`) and the secret scan, both before anything is journaled;
the open-PR re-read refusal; the #2288 item-owned branch name (a backfill _item_
keeps `crq/fix-backfill-<run>` even for a prepared `revalidated-` run, an
ordinary item `crq/fix-<run>`, an open-PR publication the record's branch); and
the ordering `update-ref refs/crq/publication/<run>`, journal, `record.publication`,
queue save, then the fast-forward refusal (after the journal, so the next tick
recovers and refuses again), then the leased push (the PR target, `''` for a new
branch), then finalize, with the worktree always removed. Composed with
`finalizePublication` the tests show a backfill item taking and holding a slot.
Effects still unbound (when S6-j landed; the local Git reads and writes are bound
in S6-l and S6-m below, the journal, patch and queue file effects in S6-k):
`verify` (`crq_repair.verify`), `hackDetector` (`crq_repair.hack_detector` over
`cq gates.hackDetector`, 120 KB argv cap), `secretScan` (`c.secret_scan`), `push`
and the `FixPrBacklog`. Narrowings: a non-list `commits` is a `TypeError` where Python
would iterate a string, a non-string commit or SHA likewise, and `bool(info)` is
modelled as a non-null PR view.

S6-k (inactive): `filePublicationEffects` (`src/adapters/crq/publicationFiles.ts`)
binds the five file seams of `publishRepair` (`readJournal`, `writeJournal`,
`writePatch`, `saveQueue`) and `finalizePublication` (`writeFixPrBody`,
`writeJournal`, `saveQueue`) over an injected `stateRoot`. `recoverPublication`
declares none of them: `publishRepair` hands it the journal it read. Nothing
imports it outside tests. Two Python
writers are mirrored, not unified: `crq_repair.atomic` (journal, queue) is
`atomicWrite` over `atomicJsonText` (mkdir -p, 0600 temp, fsync, rename, directory
fsync); `Path.write_text` (patch, fix-pr.md) is an in-place truncating write with
no `mkdir`, so a missing job directory fails and a lone surrogate leaves an empty
file. `readJournal` reads `null` only when the journal does not exist; a present
journal that is unreadable (`OSError`), malformed or over the digit limit
(`ValueError`) or not a JSON object (`TypeError`) throws, so a corrupt journal is
never replayed as a first publication. `test/adapters/crq/publicationFiles.test.ts`
runs the same temp trees through the real `crq_repair.atomic` and the Python
one-liners (oracle `test/helpers/publicationFilesOracle.py`, bytes, modes and
leftovers) and composes the effects with `publishRepair`: a push failure leaves a
journal the next call recovers from. Narrowings: `jobs[0]` must match
`crq-[A-Za-z0-9._-]+` (Python would join `../x`); journal numbers read as plain
values, so an integral float (`2.0`) is rewritten as `2`; `save_queue`'s
compaction log is not reproduced; exception text is Node's. Still unbound: the
remote and forge effects, `verify`, `hackDetector`, `secretScan`, `FixPrBacklog`,
and the wiring of this binding into `tick` (the local Git effects are S6-l and
S6-m).

S6-l (inactive): `gitPublicationReads` (`src/adapters/crq/publicationGitReads.ts`,
#2298) binds the read-only local Git calls of `repair_tick.publish`:
`revParseDefaultRef` and `isAncestor` in the primary clone, and `revParseHead`,
`verifyCherryPickHead`, `conflictedFiles`, `stagedFiles`, `revListSince` and
`diffSince` in the publish worktree. A non-zero Git exit is Python's `RuntimeError`
text, a call with no exit code is `OSError` (never a miss), and text decodes as
`text=True` does. Narrowings: 40-hex operands, worktrees only as direct children of
the root, and a hardened full diff. Nothing imports it outside tests.

S6-m (inactive): `gitPublicationWorktrees`
(`src/adapters/crq/publicationWorktrees.ts`, #2299) binds the four local Git
writes: `makeWorktree` and `removeWorktree` (`c.make_worktree`, `c.remove_worktree`
with their pre-clean and cleanup-on-failure), `cherryPick` (`wt_git`) and
`updateRef` (`refs/crq/publication/<run>`). `test/adapters/crq/publicationWorktrees.test.ts`
runs the real Python functions and the port on paired disposable repositories
(oracle `test/helpers/publicationWorktreesOracle.py`) and compares per-step failure
class and text and the final repository state. Narrowings: safe worktree names,
only `<root>/<prefix><name>` with branch `crq/<name>` is owned, 40-hex commits,
publication refs only, and the recursive delete never removes a symlink or
non-directory. Nothing imports it outside tests.

S6-n (inactive): `forgePublicationReads`
(`src/adapters/crq/publicationForgeReads.ts`) binds the two read-only forge calls
of the publication path: `prInfo` (`crq.pr_info`, `gh pr view <pr> --json
number,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt,mergeCommit,mergedAt`)
and `listBranchPrs` (`gh pr list --head <branch> --state all --json
number,url,state,headRefOid`), both in the primary clone. It reuses the existing
`GhFn` runner and `ForgeBudget`: with `options.budget` each request takes
`budget.take()` seconds (and `RefreshExhausted` refuses before any request),
without it 120 seconds, as `crq.gh_json` does. A non-zero exit is Python's
`RuntimeError` text (first six argv words, stripped stderr cut at 400 code
points); the time bound and a missing `gh` are `OSError` (never a miss), as
`TimeoutExpired` and `FileNotFoundError` are not `RuntimeError`; output that is not
JSON is `ValueError`. Keys `gh` did not print raise `KeyError` at the read, not
before (a closed PR without `headRefName` is still `stale`), and a non-object
answer raises Python's subscript `TypeError`.
`test/adapters/crq/publicationForgeReads.test.ts` replaces `subprocess.run` with a
scripted fake in the Python oracle (`test/helpers/publicationForgeReadsOracle.py`)
and runs the real `crq.pr_info`, `crq.gh_json` and `repair_tick.recover_publication`
against the port driving the real `recoverPublication`: argv, directory, timeout,
outcome class, text and consumer events agree on every scripted transcript. No real
forge call is made. Narrowings: the PR is a non-negative integer and the branch and
repository are validated (Python would pass `str()` of anything to `gh`); a branch
listing that is not an array is a `TypeError` where Python reads `null`, `{}`, `0`
and `""` as "no PR" and would go on to create one, and a falsy non-object `pr view`
answer is refused where `publish` would read it as no PR; integral floats read as
integers; invalid UTF-8 in `gh` output cannot be detected through `GhFn` (Python
raises `UnicodeDecodeError`); JSON error text is the parser's, not CPython's; a
missing clone directory reads as a missing `gh`. Nothing imports it outside tests.

S6-o (inactive): `gitPublicationRemoteReads`
(`src/adapters/crq/publicationRemoteReads.ts`) binds `lsRemoteHeads`, the one
`c.git('ls-remote', '--heads', 'origin', 'refs/heads/' + branch)` of
`recover_publication`, as a single read-only `git ls-remote` in the primary clone
through the hardened `runGitIn` runner. An absent branch is an exit 0 with no
output, so `''`; a non-zero exit is Python's `RuntimeError` text
(`git ls-remote --heads origin refs/heads/<branch> … exit <n>: <stderr stripped,
400 code points>`); a call with no exit code (spawn failure, the time or output
bound) is `OSError`, checked before the output is read, so none of the failure
classes can read as an absent branch and send recovery on to a push. Output is
strict UTF-8 (`ValueError`), universal newlines and Python `strip()`. Narrowings:
the branch passes `branchPathFault` (no glob, space or control character, since
`ls-remote` arguments are glob patterns); the remote is the literal `origin`, not
a parameter; the runner's time bound is 330 seconds where `crq.run` allows 600;
and only rows for exactly `refs/heads/<branch>` are returned. The last is a
deliberate divergence: `ls-remote` tail-matches its pattern, so a remote branch
`a/refs/heads/<branch>` also matches and, sorting first, is read by Python's
`remote.split()[0]` as this branch's tip (or an absent branch as present). The
rows are compared before `strip()`, so a branch ending in Unicode whitespace
(`branchPathFault` accepts U+00A0, U+3000 and the like) still matches its own row
and reads as present, as in Python; the kept rows are stripped afterwards.
`test/adapters/crq/publicationRemoteReads.test.ts` runs the real `crq.git` and the
`remote.split()[0] if remote else None` line (`test/helpers/publicationRemoteReadsOracle.py`)
against throwaway local bare repositories named as `origin` (present, absent,
prefix and case variants, an empty origin, a missing origin, no `origin` remote,
a non-UTF-8 listing, branches ending in Unicode whitespace), pins the failure classes with a scripted process, and drives
the real `recoverPublication` over it. No network, credential or remote service;
the adapter only lists. Nothing imports it outside tests.

S6-p (inactive): `gitPublicationVerify` (`src/adapters/crq/publicationVerify.ts`)
binds `verify`, `crq_repair.verify(wt, base, commits, job)`, the defensive
claimed-range check `publish` runs over each replayed repair (and `harvest` over
each fixer's claim). It ports Python's order and text, not
`commitVerificationFailure` (`src/plans/review-loop.ts`), which differs
materially (`diff --quiet`, no range-set or dirty-tree check). It reuses the
hardened worktree runner of S6-l, now exported as `publicationWorktreeGit`, so
containment, text decoding and the failure classes are identical. Rejections are
`ValueError`s with Python's text (empty or duplicate claim, not 40-hex, not a
strict descendant of `base`, not an ancestor of `HEAD`, empty commit, message
lacking the job id, unclaimed commits in `base..HEAD`, dirty tree); a failed
`cat-file` is a `RuntimeError` so a later tick retries; a call with no exit code
is `OSError`, never read as "not an ancestor". Parity points kept: the `base`
compare is case-sensitive, and the job id is matched literally at a boundary
where `\d` is any Unicode decimal digit. Narrowings: `base` must be 40-hex, the
worktree a direct child of the root, a non-string claim, base or job a
`TypeError`, and the tree check runs `status --porcelain --untracked-files=normal`
(Python's bare form inherits `status.showUntrackedFiles`, so it can accept a stray
file under `no`). A missing exit code is read before output is decoded, so a
truncated read is `OSError`, not a decode `ValueError`. Callers differ on a
`ValueError`: `harvest` records it terminal, `publish` records `publish_failed`. Python returns the verified `HEAD`; callers ignore it, so this
returns nothing.
`test/adapters/crq/publicationVerify.test.ts` runs the real `crq_repair.verify`
(`test/helpers/publicationVerifyOracle.py`) against throwaway local repositories
(good, multi-repair, duplicate, short and non-hex claims, unknown object, base
equal to the claim, non-descendant, not an ancestor of `HEAD`, empty and merge
commits, job-id boundaries including Arabic-Indic digits and regex metacharacters,
unclaimed commits, upper-case claim, untracked and modified files), pins the
argv, order and failure classes with a scripted process, and drives
`publishRepair` over real reads, worktrees and verify. No network, credential,
forge or remote; the adapter only reads. Nothing imports it outside tests.

S6-q (inactive): `gitPublicationSecretScan`
(`src/adapters/crq/publicationSecretScan.ts`) binds `secretScan`,
`c.secret_scan(target, head, STATE/repair/<job>/publication-secret-scan.json)`,
the defensive scan `publish` runs over the final rebased publication after the
hack detector and before the ref update. It does not re-implement the engine:
`scanReviewDiff` (the port of `secret_scan_diff`) and the review matcher and
gitleaks bindings are reused, and the module binds what `secret_scan` does around
them, in Python's order: the `--unified=0` diff, the base commit's
`.crq/scan-exemptions.toml`, `origin/main:policy/denylist/patterns.yml`, the scan,
and the report written with `Path.write_text` semantics (no `mkdir`; a dirty
verdict writes it too). A dirty verdict is `false`, which `publishRepair` turns
into `ValueError`; a refusal skips the ref update, journal, queue save and push
but leaves `publication.patch` and the report. Failure classes: a non-zero Git
read is `RuntimeError` with Python's `c.git` text (built from Python's argv), a
call with no exit code is `OSError`, invalid UTF-8 is `ValueError`, unusable
patterns are `RuntimeError('denylist parse failed (fail closed)')`, an
unwritable report is `OSError`, and an unavailable matcher or gitleaks writes no
report and throws. Parity points kept: exemptions come from the base commit only
(a head cannot exempt itself); the blob read is unchecked as in Python, so a
non-zero exit is an empty document (no exemptions, no error) while an
unanswered or undecodable read is `exemption_error`; either way exemptions are
only lost, which adds hits. Narrowings, all refusals or more scanning: base and
head must be 40-hex, the diff adds the hardened flags (binary and renamed files
are scanned by content), quoted paths are decoded, the patterns parser is strict
and the job id must match the repair grammar. `repairJobDir` and `writeText` are
now exported from `publicationFiles.ts` for the report path.
`test/adapters/crq/publicationSecretScan.test.ts` runs the real
`crq.secret_scan` (`test/helpers/publicationSecretScanOracle.py`) over 30
throwaway local cases with synthetic patterns and a fake gitleaks (verdict,
error class and text, report bytes), pins the argv and failure classes with a
scripted process, and drives `publishRepair` over real repositories. No real
secret, network, forge or provider; nothing imports it outside tests.

S6-r (inactive): `filePublicationProvenance`
(`src/adapters/crq/publicationProvenance.ts`) binds `repairProvenance`,
`repair_tick.repair_provenance(c, record, run)`, the provenance table
`finalizePublication` appends after the verdict rows and before `writeFixPrBody`.
It is read-only and reuses the existing readers: `readJsonValue`
(`repairStateSource.ts`) for the job files, a local `exists` for `Path.exists()`
(it stats the `os.fsencode` bytes, so a lone `U+DC80..U+DCFF` is the raw byte and
any other lone surrogate does not exist, never Node's `U+FFFD`), pathlib-style
joins that keep `..` (a symlinked state root resolves through the kernel),
Python `str.strip()` blankness for the spool key, `checkBackfillRollout` (now split out of `readBackfillRollout`) and `sortedJsonNames`
(now exported from `triageRows.ts`) for the retained-reviews lookup, `ledgerLoads`,
`validate` and the ledger record path for the link. Pinned in order and text: the
five header lines, then one row per job in record order; the finding-id and
source-cell `or` chains (lazy, so `job['finding']` and `job['source']` are only
dereferenced where Python reaches them, and a present `null` is not the `{}`
default); a truthy `pr` is the PR URL with Python `str()` of the number (`7.0`,
`1e+22`, `True`); otherwise the local locator, the source run's `review.ndjson`
when it `exists()`, else the job file, joined and `relative_to`'d as `pathlib`
does (dots and empty segments drop, an absolute segment replaces, a path outside
`STATE.parent` is `ValueError`). A job with `canonical_finding_id` uses its triage
row (or the job file) and then, once per call, the retained reviews: the review is
found by `review_id` or `source.review_id`, must validate, belong to this repo and
hold the finding, and links to `blob/cq/review-ledger/records/YYYY/MM/<id>.json`.
Error ownership: `OSError`, `ValueError` and `KeyError` anywhere in the lookup
collapse to no reviews, and `ValueError`, `KeyError` and `TypeError` in validation
keep the local locator, but a `TypeError` (a non-string durable root, an
unhashable review `id` or lookup key, even against an empty map) and a non-object
rollout (`AttributeError`) escape and abort the table, as does any unreadable or
malformed job file. `LedgerTypeError` is a `LedgerIntegrityError` yet is not a
collapsed class. Narrowings, all refusals: a job id must match the repair grammar,
`jobs` must be a list (a string or object would iterate characters or keys), and a
`pr`, finding id or review id that is a list or object (`str()` of a container) is
not modelled. `test/adapters/crq/publicationProvenance.test.ts` runs the real
`repair_provenance` (`test/helpers/publicationProvenanceOracle.py`, with valid
reviews built by the Python ledger) against the binding over throwaway synthetic
state trees and compares the table or the exception family, then pins the exact
text, the refusals, the `Pick<PublicationFinalizeEffects, 'repairProvenance'>`
ownership and the composition inside `finalizePublication`. No real forge, network,
provider or secret; nothing imports it outside tests.

S6-s (inactive): `publicationNewItem` (`src/queue-runner/publicationEnroll.ts`)
binds `newItem`, `crq.new_item(q, [], False, **fields)`, the call
`finalizePublication` makes to enroll a verified repair's fix PR. It mutates the
plain queue in place and owns no I/O: `iso` and the `enrolled` event are injected
(`fileEnrolledEvent` is the event binding). Pinned in order: the first live item
with an equal `id` is returned untouched (any kind or state, a skipped one too;
a `promotion` item is not live; ids are read lazily to the first match, so an
earlier id-less live item is `KeyError` and a later one is never read);
`kind == "open"` overwrites any `prior_cycles` with 0, so `finalizePublication`'s
`2 - fix_pr_cycles` is never stored (the key keeps its place in the fields); the
item is `order, state, cycles, attempts, **fields` with `notes` replaced by the
single `<iso> auto-enrolled: <why>` note and `why` removed; `order` is one past
the largest live `order` (a missing one is 0, a bool is an int); the item is
appended before the event, so a failing event leaves it in the unsaved queue, and
a field set with no `id` is appended and then fails reading it (`KeyError`).
Narrowings, all refusals: a float, string or null `order` and a non-string `why`.
`test/queue-runner/publicationEnroll.test.ts` runs the real `crq.new_item` and the
real `finalize_publication` (`test/helpers/publicationEnrollOracle.py`, every
effect a fixture) against the binding and compares the final queue, item, record,
publication, journal, body, backlog and ordered effect log as JSON text, so key
order is pinned, and an exception by family. No real queue, event log, forge,
network, provider or secret; nothing imports it outside tests.

S6-t (inactive, test only): no new production code. The existing pieces already
compose over one explicitly injected `FixPrBacklog`: `refreshFixPrBacklog` (with
`fileFixPrBacklogEffects`) fills it, `publishRepair` (initial publish, or journal
recovery when the job's journal, `state/repair/<job>/publication.json`, holds a
publication) reaches `finalizePublication`
through its `finalize` seam, and `finalizePublication` reserves and releases the
same instance. `test/queue-runner/publicationBacklog.test.ts` pins that composition
across several ticks against the real `refresh_fix_pr_backlog`, `publish`,
`recover_publication` and `finalize_publication`
(`test/helpers/publicationBacklogOracle.py`; Git, forge and `gh` are in-memory
fixtures, the only disk a throwaway state tree). Pinned: one refresh view shared by
every publish of a tick; a backfill item pushed and journaled but held when no
slot is free, then recovered on a later tick once a refresh frees one; the slot
reserved before `gh pr create`, released only on a `gh` failure and kept on a
timeout; an unread view (failed or skipped refresh) holding backfill while an
ordinary PR is not capped; a missing `events.jsonl` as a zero limit; and #2291
legacy accounting, where a backfill item's `revalidated-` retry branch counts and
an ordinary item's lookalike does not. Enrollment is out of scope: `newItem` is
stubbed on both sides (it logs only the item id), so the final queue holds no
enrolled `pr<number>` item and the log no `enrolled` event; `publicationEnroll.test.ts`
(S6-s) pins that. The ordered effect log, the backlog view
after every publish, the final queue and the journal, queue and backlog
files are compared as JSON text. Nothing is bound into `tick` or the runtime.

S6-u (inactive, test only): the composed offline shadow of the repair-harvest path.
`test/queue-runner/repairHarvestShadow.test.ts` drives the TypeScript `repairHarvest`
through its `publish` seam (`publishRepair`, `finalizePublication`, `publicationNewItem`
over `filePublicationEffects`) and its `cleanupHarvested` seam (`decideRepairCleanup`),
and the real `repair_tick.harvest`, `publish`, `recover_publication`,
`finalize_publication`, `crq.new_item` and `crq_repair.retain.cleanup_harvested`
(`test/helpers/repairHarvestShadowOracle.py`), over fixed synthetic queues with a
restart between ticks: an in-memory queue JSON round trip and a fresh `FixPrBacklog` in
the same process, not a re-read of `state/queue.json`; recovery reads the publication
journal back from disk. Forge, Git, `gh` and the ledger are in-memory fixtures;
`git worktree remove` is only recorded and adds the tree to an in-memory removed set
that the directory probe consults, so no directory is deleted. The only disk is a
throwaway tree holding the inputs the code under test reads (result, inbox and
retained-snapshot files, empty worktree directories) and the journal, patch, body and
`queue.json` it writes. Per tick the queue and those written files are snapshotted and
compared as JSON text; the ordered effect log (including `enrolled` events and cleanup
calls), the final files and the removed set are compared once over the whole run. No mismatch was found
in the composed scenarios. Not composed: the backlog refresh (pinned by
`publicationBacklog.test.ts`), the rejected-inbox replay divergence (pinned by
`repairHarvest.test.ts`), and the text of a timed-out `gh pr create`, which the fixture
renders as CPython does because the real `createPr` binding does not exist yet.

S5b resume candidate (inactive, decision only): `src/queue-runner/repairResume.ts`
models `resume_worktree` and the missing-candidate refusal at the top of
`crq_repair.process` (`crq_repair.py`, `resume_worktree` and the pending-stage refusal in
`process`) over injected read-only probes (`resolve`, `is_dir`, `exists`) and the job's
owner identity (`worktreeRoot`, `itemId`, `jobId`; Python's `config['worktree_root']`,
`job['item']`, `job['job']`). It answers with the tree to carry on with or a typed
`refuse-missing-candidate` naming the pending `judge` (reported first) or `mechanical`
stage. It saves nothing, runs no judge or mechanical gate and mutates no worktree or
queue; the caller still owns Python's `atomic(result.json)`.

Resume ownership (Python and TS change together): the recorded tree is adopted only when
it resolves differently from the tree in hand, is owned, is a directory and has a `.git`
entry. Owned is the rule `recovery.py:70-72` and `retain.cleanup_harvested` already apply:
the resolved tree sits directly under the resolved worktree root and is named
`crq-repair-<item>-<job>` or that name plus `-A2`. A foreign job or item, the legacy
`crq-repair-<item>` name, an `-A2-A2` or `-A3` name, a tree outside or nested below the
root, the root itself, and an owned-looking symlink whose target is not so named are not
adopted. Because the tree in hand then differs from the recorded one, a pending judge or
mechanical stage is refused with the existing `pending <stage> worktree unavailable; needs
human` result (never judged or verified in a foreign tree), and `dispatch_pending` alone
keeps the tree in hand and so never retains a foreign tree. A foreign-named symlink whose
target is the owned `-A2` tree still resolves to it and is adopted. Nothing reads `git
worktree list`: `.git` existence remains the only registration evidence, and a registration
flag in the fixtures is synthetic and provably inert.

Evidence: `test/queue-runner/repairResume.test.ts` replays named fake-fixture differential
scenarios against the real `resume_worktree` and `process` (with `atomic` and `retain`
stubbed to record the first effect and stop), comparing the chosen tree, the refusal, the
Python `TypeError`/`ValueError` text and the ordered `resolve`/`is_dir`/`exists` probe
trace (the worktree-root resolve is part of the trace); every formerly adopted foreign,
outside, nested, legacy and `-A2-A2` name is replayed as a judge, mechanical,
`dispatch_pending` and running-in-`-A2` case. `test/queue-runner/repairResumeOwnership.test.ts`
feeds synthetic records to `decideRepairCleanup`, used as the ownership oracle, and to
`decideResumeCandidate`, which now agree on every record.
`apps/crq-python/test_repair_resume_ownership.py` pins the same names and the refusal and
fallback effects on the Python side with throwaway directories. Relative recorded paths are
not modelled (resolution is the probe's cwd).

Still unwired after S6-l through S6-t: `push` (the leased remote write),
`createPr` (forge write) and `hackDetector`, plus the binding of any of these, or
of the shared `FixPrBacklog`, into `tick`.

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
  An empty usage object `{}` is the one probe Python refuses after
  `usage_context` (`usage["remaining"]` is a `KeyError`); `usageContext` refuses
  it as a `KeyError` too. `parseUsage` never returns it (it yields `null` or an
  object with `remaining`), so the composed tick cannot reach it and both ports
  refuse before any launch; the `refuses-an-empty-usage-object` vector pins it.
  The differential replay maps each Python error class to its TS analogue
  (`AttributeError` has none, so a dict method on another JSON type is a
  `LedgerTypeError`) and pins the message where the port reproduces it.

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
| Fix-PR backlog around the harvest loop          | `crq.py` tick: `reset_fix_pr_backlog` / `refresh_fix_pr_backlog` (`repair_tick.py:645`/`:611`) under `ForgeBudget(1, 30)`, writing `state/repair/fix-pr-backlog.json` | none                                                                                                                                                                                                                                                                                             | Port, and a slot in `runTick` (it has no phase between `discovery` and `harvestItems`).                                                                                                                                                                                                                                                                                                                                                                                  |
| `reconcileCompleted`                            | `local_review_runtime.reconcile_completed` (`local_review_runtime.py:120`)                                                                                            | `localReviewReconcile.ts`, `createLocalReviewCompletedCaller` (`src/adapters/crq/localReviewCompleted.ts:19`)                                                                                                                                                                                    | A `(queue) => queue` phase wrapper.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `repairBackfill`                                | `repair_tick.backfill` (`repair_tick.py:884`)                                                                                                                         | none                                                                                                                                                                                                                                                                                             | Port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `archiveLegacy`                                 | `repair_tick.archive_legacy` (`repair_tick.py:915`)                                                                                                                   | none                                                                                                                                                                                                                                                                                             | Port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `reconcile`                                     | `repair_tick.reconcile_fix_prs` (`repair_tick.py:1520`) under `ForgeBudget(80, 60)`                                                                                   | `runReconcilePhase` (`src/queue-runner/tickDiscoveryPhase.ts:92`), `fileReconcilePhaseEffects` (`src/adapters/crq/tickReconcilePhaseSource.ts:44`)                                                                                                                                               | The adapter returns counts only; the reconciled queue stays on disk, so the phase must return it. `deliveryPasses` (`harvestDelivery.ts:120`) is an older duplicate of the reconcile report with no runtime caller.                                                                                                                                                                                                                                                      |
| slot `collectFinished`                          | `crq.py:3369`                                                                                                                                                         | `collectFinished` (`src/queue-runner/collectFinished.ts:38`)                                                                                                                                                                                                                                     | Effect binding (exit probe, liveness, republish) and the `harvest_review` dependency above.                                                                                                                                                                                                                                                                                                                                                                              |

### Admission and launch (about 1.5k–2k lines)

| Gap                                  | Python                                                                                           | TypeScript pieces                                                                                                                                      | What is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admit.startOne`                     | `start_one` (`crq.py:3198`)                                                                      | selection loop `startOne` (`src/queue-runner/startOne.ts:116`)                                                                                         | A `StartOneEffects` implementation. That means a `planItem` dispatcher by kind over `planOpen`/`planDelta` (`ordinaryPlan.ts:92`/`:144`), `planMerged`/`planAuthor` (`mergedAuthorPlan.ts`), `prepareCurrent`, `preparePushCurrent` and the local-review prepare (`preparePasses.ts`), plus the PR lookup and quiet gate. `ensure_commit`, `measure_merged` and `build_synthetic` exist only as effect members.                                                                  |
| `launch`                             | `launch` (`crq.py:2004`)                                                                         | `reserveAndSpawnReview` (`src/queue-runner/reviewLaunch.ts:64`), `prepareOrdinaryReview` (`src/queue-runner/reviewPreparation.ts:48`, open/delta only) | Meta, scan and `cmd` for receipt, push-current, local-review, author, merged/coverage and backfill. Also the secret scan with exemptions and a blocked-scan receipt. `ReviewLaunchEffects` is unbound.                                                                                                                                                                                                                                                                           |
| Detached review child                | `cmd_review_child` (`crq.py:2202`), spawned as `python3 crq.py _review <run_id>` (`crq.py:2150`) | `runReviewChild` (`src/adapters/crq/reviewProcess.ts:103`), no runtime caller                                                                          | `_review` is in the runner's command set (`src/queue-runner/runner.ts:31`) but not routed. `runReviewChild` differs from Python in three ways. It runs `timeout` without `--foreground`. It does not start `crq-tick.service` (`--no-block`) when the child finishes. It refuses backfill submission proof. An interim TS launch could spawn the Python child (same artifact names: `review.pid`, `review.ndjson`, `exit.json`).                                                 |
| Coverage fallback and backfill usage | `_coverage_fallback` (`crq.py:3131`), `backfill_runtime.usage_context`                           | `coverageFallback`, `usageContext` (`src/queue-runner/coverageUsage.ts`)                                                                               | Effect binding (17 members; `select` is bound only with the `select` input (`coverageSelect.ts`), `buildSynthetic` is bound only with `synthetic` deps, and the clocks, queue helpers and `backfillDispatchConfigured` only with the `tick`/`dispatch` inputs; `rank4Gate`, `bindRun` and `cancelBeforeVendor` are bound in `coverageBackfillSeams.ts`). `bindAdmit` calls the `backfillGate.ts` `usageContext` since S6-g (this row's `coverageUsage.ts` copy stays test-only). |

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
