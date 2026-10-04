# Composition kernel

The kernel owns the frozen contracts everything else composes: the atomic-op
contract, the result taxonomy, plans/journal/run types, and the registry
entry shapes. Source of truth (start reading here):

- `src/kernel/types.ts` — hand-written frozen types (single source of truth)
- `src/kernel/schema.ts` — zod mirrors for serializability tests and journal
  parsing (strict: unknown keys fail parsing)

## What the kernel owns

- **Op contract.** `Op<I, R>` is a typed async function
  `(input: I) => Promise<OpResult<R>>`. Inputs and outputs are
  JSON-serializable; ops never see drivers, processes, or exit codes. Exit
  codes {0,1,2,3} belong to the CLI layer (resolves design debt DD-7).
- **Result taxonomy.** `OpResult<R>` has exactly five frozen statuses:
  `'ok' | 'failed' | 'needs-human' | 'budget-exhausted' | 'indeterminate'`.
  - `ok` — produced `value`
  - `failed` — definitive failure; `error` says why
  - `needs-human` — stopped for a human decision (`reason`)
  - `budget-exhausted` — did not run, or halted, on a budget bound
  - `indeterminate` — no verdict possible (`detail` carries what is known);
    assume neither success nor failure
- **Plans, journal, runs.** `Plan`/`Job` (serializable plans-as-data),
  `RunOptions`, `RunReport` (with the honest-stop flag), `Limits` (dual
  caps: `inFlightCeiling` is separate from `runDispatchQuota`), the
  `JournalEvent` union (discriminated on `type`; `job-finished` carries the
  frozen replay record `opId + inputsHash + result`), `JobState`/`JobStatus`.
- **Registry entries.** `OpRegistryEntry` (`name`, `inputSchema`, lazy
  `importer`) and `PlanRegistryEntry` are runtime-only — function fields,
  never persisted, deliberately no schema mirror.

## The freeze rule

These types are the GLOBAL freeze point for the toolkit; the frozen surface
is tagged `types-freeze-v1`. After the tag, any change to a frozen name,
field, status value, or schema is a separate migration PR with its own
review — never an edit folded into a later goal. Serializability is pinned
by `test/kernel/types.test.ts`. Recorded fold-ins from a previous PR's
accepted-at-merge record (for instance PR 7's `concurrency .min(1)` → T1.2)
are the one exception in MECHANISM only: they are executed as
mirror-tightenings with provenance comments, never as frozen-shape changes
(which always need their own migration PR).

## Vendor neutrality (invariant I10)

No vendor SDK imports and no vendor vocabulary in kernel types or persisted
data — kernel code speaks only its own plain-data language. Enforced in CI
by the eslint rule `cq/no-vendor-sdk-in-kernel`, scoped to `src/kernel/**`
(the driver seam types file sits under the same ban).

## What lands next

Phase 1 (this phase) has landed: the plan runner, the NDJSON journal, the
budget governor, and the rescue policy lane — all consuming these frozen
types as-is. Later phases: op families under `src/ops/`, the plan library
under `src/plans/`, and the CLI layer (which owns the {0,1,2,3} exit-code
mapping) under `src/cli/`.

## Runner, manifest, journal (T1.2)

`runPlan(plan, opts, registry)` interprets a plan to a `RunReport` (R2 §5:
a deterministic interpreter — no daemon, no workflow engine; rescue is
T1.3's governor, never the runner).

- **Registry is dependency-injected** (`OpRegistryView.get`): the frozen
  `RunOptions` cannot carry it, and the runner stays DI-clean — phase-2
  lane I's `src/plans/registry.ts` will own the global registry. Unknown op
  names fail that job at execution time; the manifest still builds
  (op-agnostic).
- **Committed manifest**: `makeManifest` freezes a plan into plain rows,
  each with `inputsHash = sha256(canonicalJson({op, input}))` — key-order
  independent, array-order sensitive. That hash is what makes replay
  provable.
- **NDJSON journal** (`<journalDir>/<runId>.ndjson`): append-only,
  schema-validated facts; a torn tail (crash mid-append — an UNTERMINATED
  last line) is ignored, while a complete but invalid line anywhere,
  including last, throws; `statusOf` is derived at read by folding events.
- **Replay/resume** (`resume: true`): every prior run for the planId folds
  oldest-first, per job last-finish-wins — a later PARTIAL run cannot erase
  older runs' completed jobs; a job skips only on terminal-`ok` + equal
  `inputsHash` (zero op invocation, outcome reconstructed from the journal);
  everything else re-runs — continue-from-first-failure falls out naturally.
- **stopOnError**: only when `stopOnError` is true: after the first non-ok
  result nothing new starts (in-flight jobs complete and are recorded);
  downstream jobs are `blocked`, never-dispatched jobs with healthy
  dependencies are `queued`. With `stopOnError: false` every schedulable job
  dispatches regardless of earlier failures — downstream rows are `blocked`
  only when a dependency actually did not succeed.

Recorded freeze-friction workarounds (the ws-a "deviations need a recorded
reason" clause):

- `JobState` has no needs-human/indeterminate values, so report COUNTS map
  needs-human→blocked and indeterminate→failed; `JobOutcome.result` rows
  keep the true taxonomy statuses (and resume re-runs both).
- Blocked jobs emit NO journal events — no frozen event type can express
  blocking — so they exist only in the run report.
- Replay re-attests skipped jobs with a `job-finished` event and no
  preceding `job-started` (no dispatch happened; the verified inputsHash
  makes the attestation sound). This keeps each run's journal
  self-contained so the per-job fold rule survives chained resumes.
- `stopOnError` leaving jobs unstarted does NOT set `stoppedEarly`: the
  frozen `RunEarlyStopReason` only contains `'budget'`, and honest-stop
  marking is T1.3's — callers read `counts.queued`/`counts.blocked` to see
  what never ran.

## Budget governor (T1.3)

The governor owns WHEN to abort (invariant I8): the per-job wall-clock
escalation ladder, per-job and per-run attempt caps, the USD rollup cap, and
the dual in-flight/dispatch caps. Source: `src/kernel/governor.ts` (enforcer)
and `src/kernel/rescue.ts` (policy table + decision engine).

- **Seam — the governed runner (W2.2, ADR-0003 §2).**
  `runPlan(plan, opts, registry, gov?)` takes the `Governance` handle
  (`{ governor, signal?, attended?, optIn? }`; `createGovernor(config, clock?)`
  builds the enforcer and accepts the injected clock) and performs admission,
  the ladder, the DD-9 evidence
  folds, the v2 journal, and the honest stop ITSELF. Caps in `opts` without
  `gov` throw (`runPlan: caps require governance`) — a cap without admission
  and spend observation is silently unenforceable. The earlier
  governed-registry decorator (`governRegistry`/`withBudgetStop`/
  `seedFromRunLog`) is DELETED with no shim: the runner is the one governed
  composition, which is also what lets admission key on the real plan
  `job.id` and lets the journal carry real attempt numbers. Consequence,
  still recorded: the governor NEVER retries — an in-wrapper retry would
  hide attempts from the journal (one job-started, two real dispatches),
  which is journal-dishonest and rejected. Re-dispatch happens at the
  runPlan level via the rescue lane.
- **Escalation ladder (per job).** Rungs fire in order, each after its grace,
  each appending a marker (kind `ladder-rung`: `rung`, `delayMs` since the
  previous rung, `sinceStartMs`, `delivered`) to `BudgetGovernor.events`:
  1. `signal` after `perJobWallClockMs` — cooperative cancellation: the op's
     `AbortSignal`, reached via `currentJobContext()` (the additive ambient
     channel; the frozen Op contract carries no signal parameter). Always
     `delivered: true` — the signal is the primitive.
  2. `timeout` after `abortGraceMs` — the second, harder cancel: the
     subprocess-timeout semantics placeholder. The op registers a cancel
     port (`ctx.setCancelPort`) and the rung calls `hardCancel()`;
     `delivered: false` when no port was registered (the rung still fires
     and is still recorded).
  3. `kill` after `killGraceMs` — the SIGKILL-equivalent: `port.kill()` when
     the op hosts a killable worker, and ALWAYS in-process abandonment — the
     op promise is detached (its later settlement suppressed, no unhandled
     rejection), the invocation settles `{status:'budget-exhausted'}`, and
     the run no longer waits on it. A fake op that ignores the abort signal
     is therefore still terminated at the final rung — that is the slice-2
     test.
     An op that settles early disarms every pending rung. A port primitive that
     THROWS is recorded on the rung marker (`delivered: false` plus an `error`
     note — mirrored on the governor's `ladder-rung` event) and the ladder
     continues: a failing port can never lose a marker, skip the later rungs,
     or hang the job. `runLadder` is the standalone unit (no registry needed);
     markers are also returned on the `LadderOutcome`.
- **Why kills are `budget-exhausted`, not `indeterminate` (recorded
  decision).** The taxonomy lists "timeout" under `indeterminate` for
  op-internal losses with no attributable cause; a governor kill has a known
  cause — a budget bound was hit ("the op did not run (or halted) because a
  budget bound was hit", frozen wording). This also makes the journal honest
  and resume-compatible: the terminal record re-runs on resume like any
  non-ok row.
- **Caps.** Per-job attempts and the per-run dispatch quota
  (`Limits.runDispatchQuota` IS the per-run attempt cap) reject at
  admission: the op never runs and the invocation returns
  `{status:'budget-exhausted'}`. The in-flight ceiling
  (`Limits.inFlightCeiling`) is SEPARATE and enforced by FIFO QUEUEING,
  never by failing (failing waiters would be dishonest — they merely had to
  wait), so effective parallelism is the frozen
  min(`RunOptions.concurrency`, ceiling). Admission IS the dispatch
  decision: quota/attempt counters advance at admit, before in-flight
  queueing; a dispatch queued when the budget trips is refused
  (`budget-while-queued`) rather than run.
- **USD accounting.** Ops report spend through the job context in ONE fold
  via `reportResult({ usage, costUSD })` — the transitional streaming
  channel for an op that maps a driver `WorkerResult` into its OWN value
  shape (so the completion-time fold cannot see it); it applies the DD-9
  rules exactly as the completion-time fold does — real usage rolls the
  token cap, a present `costUSD` rolls the USD cap, and real usage with no
  `costUSD` under a configured `maxUsd` trips loudly (an unpriced model
  makes the cap unenforceable). A lying (NaN/Infinity/negative) measurement
  is sanitized to zero evidence, never a post-record throw. The governor
  rolls up and trips at the EFFECTIVE cap = min(`RunOptions.maxUsd`,
  `Limits.maxUsd`) (frozen precedence; the cap is inclusive — the trip fires
  when the rollup EXCEEDS it). The kernel never derives cost itself. Trips
  carry a kind (`TripKind`: `exhausted` / `token-cap` / `signal`) — a
  `signal` trip is a run-level CANCEL (`Governance.signal`), not a budget
  verdict. Since W2.3's reserve-then-settle a trip stops NEW reservations,
  refuses every capacity waiter, and ABORTS IN-FLIGHT work: the governor
  owns the run's trip signal (`tripAbortSignal`; every dispatch ladder
  composes it), and each aborted dispatch's reservation settles when it
  returns — the slot is held until then.
- **Honest stop (I9).** The runner claims the stop itself — no post-pass:
  a budget-family trip (or a per-run dispatch-quota refusal) re-marks the
  never-dispatched rows whose non-execution is transitively budget-caused
  `OpResult {status:'budget-exhausted'}`, sets `stoppedEarly: true` and
  `earlyStopReason: 'budget'`, and only when something was actually gated
  (a refusal row that is itself terminal evidence claims nothing). The
  attribution walks the runner's OWN admission records — which jobs were
  admitted, which refused — never marker strings in row text; a blocked row
  with a definitively-failed dependency keeps its real verdict. Executed
  rows are never rewritten. A `signal` trip re-marks nothing: undispatched
  rows stay `queued`, and the report claims `earlyStopReason: 'signal'`
  when queued rows remain. The cancel rule holds MID-RUN and TRANSITIVELY:
  the trip is evaluated at each classification point (not snapshotted at
  run start), and a dependency cancelled while it waited for its slot
  (`result: 'indeterminate'`) is UNRESOLVED, not failed; an operation's own
  indeterminate verdict is unresolved too. Their dependents stay `queued`,
  never fabricated `blocked` (a cancel is not a verdict; everything
  undispatched re-runs on resume). Counts move only the
  re-marked rows.
- **Composable with resume (ledger continuity).** A run the governor
  stopped still leaves journal evidence: an in-process kill produces a
  terminal budget-exhausted record; a hard-crashed job has `job-started`
  with no terminal event. Governed runs fold the dir's ENTIRE history —
  v1 runs by `at`, then v2 runs by their claimed `seq` (journal v2,
  ADR-0003 annex) — with or without `resume: true` (only the replay-skip
  map is resume-gated): attempts seed as `1 + |prior job-started(jobId)|`,
  the dispatch count and the usage/`costUSD` rollups seed from
  job-finished events (a finish counts only when it CLOSES an open start),
  so a run continues the SAME budget. The seed's open-start dedupe is
  keyed PER (run, job): a finish closes only its own run's start, so a
  finish-only re-attestation in a later run can never close (and
  double-charge) the start of a run that died first. Identity residual
  (recorded, unreachable from the CLI today): the attempt seed keys on
  `job.id`, which the PLAN controls — a plan that renames its job ids
  between runs presents as fresh jobs and resets its per-job attempt
  lineage (rename evasion); stable identity needs a plan-external job
  identity, which is not in v1.1. The SAME keying bounds the A12b
  quarantine: it keys on `job.id` too, so a rename does not merely reset
  the attempt lineage — it ESCAPES a standing quarantine (the renamed job
  re-dispatches while the unresolved charge stays; named in the P1
  table's quarantine row — a plan-external identity closes both).
  The fold's corruption checks are loud on DUPLICATES (two v2 runs sharing
  one `seq`) and on GAPS: a `claimSeq` tombstone (`<planId>.seq.<n>`)
  beyond the highest folded run-started `seq` throws
  `journal: corrupt — seq gap` — a claimed run whose FILE is gone (deleted;
  its spend would silently vanish from the seed), or an orphaned claim (a
  crash between claimSeq and the first append — safe to resolve by deleting
  the named tombstone, which the error says). This maximum-sequence check
  catches claims trailing the folded history; it does not detect a deleted
  interior run when a higher sequence still folds. A surviving run file's LINE
  COUNT is checked too: `run-finished.eventCount` (the writer's total) must
  match the folded line count, so deleting a single line — a crashed
  dispatch's `reservation-opened`, which would otherwise silently drop the
  run out of the reservation era — throws instead of folding. The refusals guard the
  ledger: governed history refuses an ungoverned run (opt-in
  `budget.ungovernedOverGoverned` marks the run ungoverned on its v2
  record instead — and the marker is honoured ONLY over actual governed
  history: on a plan with none it is refused, since honouring it would
  strand that run's spend outside every future ledger); v1 journals with
  unaccounted dispatches refuse a governed run (opt-in
  `budget.legacyJournal=reset` charges them zero and records exactly which
  runs the bound excludes — sticky); a cap RAISE over the last governed
  run's `capUsd` refuses (opt-in `budget.raiseCap` — the predecessor check
  gates the USD bound only, because token caps are ADVISORY in v1.1
  (ADR-0003 §2.3) and a token-cap raise has no spend-integrity consequence
  to gate). When a governed run's seed excludes ungoverned-marked runs,
  the runner records the fact on the governor's event stream and the CLI
  narrates `cq: bound excludes ungoverned runs <runIds>` (annex §3 rule 7).
  Consequence: budget-exhausted rows are terminal and
  are NOT auto-retried by resume in any effective sense — a seeded,
  still-tripped governor re-marks them without op invocation; only an
  input change (new `inputsHash`, which defeats even ok-skip in replay)
  puts them back under the caps as genuinely new work.
  Cost scope, named (do not double-count): the RUN-level `costUSD` on a
  report is the cumulative seeded LEDGER (prior runs' finishes plus this
  run's evidence), while each per-row `costUSD` is THIS run's evidence
  only (a replay-skipped row restates the copied prior cost) — summing
  rows across runs double-counts; the run-level figure is the ledger.
  Recorded ledger-integrity residuals (W2.2 scope ends here):
  - **The journal is trusted by possession.** Anyone with write access to
    `--journal-dir` can edit a `job-finished.costUSD` undetected — the
    fold validates shape, not provenance. The future fix is a per-run
    chained hash over the journal lines, verified at fold time.
  - **Concurrent runs over one journal dir (closed by W2.4).** Without a
    lock, concurrent governed runs are ≈2C: two processes can both fold
    and both dispatch before either's spend lands. The W2.4 plan lock
    (below) closes it; a naive `open('wx')` lock was rejected because a
    crashed holder would wedge the plan (fail-closed with no stale-lock
    recovery).

## Plan lock (W2.4, ADR-0003 §2.5)

A journaled run holds `<journalDir>/<planId>.lock.json` for its lifetime
(`acquirePlanLock` in `journal.ts`). The record names the owner: nonce, a
kernel-held probe socket, pid, host, boot identity and runId. Liveness is
the socket and pid/boot evidence, never an mtime, so a SIGSTOPped owner is
never treated as dead. Every dispatch is fenced on the record nonce, and an
owner whose record was displaced fails closed (`journal: lock-lost`).

- **Guard plus claims.** Acquisition (the eligibility decision plus record
  publication) runs under a short publication guard: a proper-lockfile
  lease on `<planId>.lock.guard.lock` (stale 30 s, refreshed every 5 s, no
  retries). The guard only reduces contention; it is not what makes the
  lock safe. A new record is published by exclusive `link(2)`. Replacing a
  released or dead owner's record first needs an exclusive
  `<planId>.lock.json.<predecessor nonce>.claim` (also a `link`), so each
  record can be succeeded exactly once and a live owner is never replaced.
  A guard compromise is detected at the next fence, and anything already
  published is rolled back to a released tombstone.
- **Drain #259-era runners before rollout.** Runners from #259 took a perl
  `flock` on `<planId>.lock.guard` and reclaimed without claims. They do
  not exclude new runners during acquisition, and they can displace a new
  owner (which then fails closed). On a shared journal dir, stop every
  #259-era runner before starting new ones. Leftover `<planId>.lock.guard`
  files are inert.
- **≤30 s busy window after a crash.** If a process dies while holding the
  guard (mid-acquisition), other acquirers refuse with `plan lock
acquisition in progress or interrupted` until the guard lease is stale,
  at most 30 s. Retry after that. A crash after acquisition leaves only the
  record. On the same host that record is reclaimable as soon as its owner
  is provably dead; a foreign host's record needs its release tombstone.
- **`.claim` files accumulate.** One `<planId>.lock.json.<nonce>.claim` is
  kept per reclamation as evidence, like `<planId>.seq.<n>` tombstones. They
  are never removed automatically (GC is a follow-up). Acquisition walks the
  claim chain past claimants that were themselves claimed, released, or
  provably dead. A claimant whose publication fails marks its own claim
  released, so a retry (even in the same process) is not wedged. If a claim
  names a run whose record was never published and whose process may still
  be alive (still publishing, or its publication failed and the claim could
  not be marked), acquisition refuses with an error naming the claim file.
  If that run's process has exited (same host) or is known dead (foreign
  host), removing the file unblocks acquisition.
- **Plan id length.** A journaled run's plan id is at most 195 characters,
  so the longest lock artifact (`<planId>.lock.json.<nonce>.released.tmp`)
  fits a 255-byte file name. A longer id is refused before anything is
  created; such ids could never release their lock before this bound
  either.

## Reserve-then-settle (W2.3, ADR-0003 §2.2/§2.3)

A governed dispatch under a USD cap holds a RESERVATION — the admission
invariant is `settled + outstanding + reserved ≤ C`, held synchronously
from `reserve` to `settle`.

- **Write-ahead (A12b).** `reservation-opened` is fdatasync'd BEFORE the op
  runs; `reservation-settled` BEFORE the outcome is journalled. A hard
  crash between them is exactly the spend-behind-a-crashed-dispatch window
  W2.2 could not see: the resume fold charges the reservation IN FULL
  (`usdSpent` includes it, so a crash that spent the cap trips the seeded
  overrun check) and QUARANTINES the job — never dispatched, reported
  `needs-human`, dependents blocked, re-attested every run until an
  explicit per-call `releaseQuarantine` (CLI `--release-quarantine`),
  which re-runs the job but NEVER refunds the charge. A crash BEFORE
  `reservation-opened` cannot have spent anything: the job re-runs on
  resume with no charge (an open `job-started` alone proves no dispatch
  started — that ordering IS the undercount fix). The third window sits
  between the two facts above: a crash AFTER the durable settle but BEFORE
  `job-finished` leaves the spend counted and the job with an open
  `job-started`, so the next run RE-DISPATCHES it at a fresh full
  reservation — the cap is charged twice for one unit of work (the bound
  holds: the cap is the cap; attempt accounting stays correct), recorded
  as a residual, not a break. Line-deletion corruption in a SURVIVING run
  file is loud: `run-finished` carries the file's total `eventCount`, and
  the resume fold throws on a mismatch (a deleted `reservation-opened`
  would otherwise drop the run out of the reservation era — its full
  charge vanishing and its quarantine never firing). Recorded residual: the
  CLI's release surface is a comma-separated flag whose empty segments are
  dropped (`--release-quarantine`, `src/cli/run-plan.ts`), so a job whose
  `id` is the empty string — a degenerate but schema-valid plan — can be
  quarantined and never named on that surface. The honest closure is on the
  PLAN side (`JobSchema.id` requiring `min(1)`), a frozen input-contract
  change outside this slice; recorded here rather than papered over.
- **Sizing.** The proposal is the fair share `C / concurrency` — ADR §2.2
  step 3's `inv.budget.maxUsd` proposal term is NOT implementable at today's
  kernel op seam (no per-invocation budget crosses it; the term lands with
  the W3.3 reservation surface), so only the fair-share half exists. When
  the proposal exceeds remaining capacity, ADR §2.2 step 3 decides: with any
  reservation OUTSTANDING the dispatch WAITS FIFO for a settle (a bookkeeping
  shrink there would undersize `r` and the dispatch's real charge would trip
  `breach`, aborting healthy in-flight work); with NOTHING outstanding the
  gate shrinks to `C − S` (`proposedUsd` journalled when shrunk), because no
  settle can free capacity anymore. That shrink carries the SAME
  under-sizing exposure as the park it contrasts with — the dispatch's real
  charge is still unknown at the gate, and one that outruns `C − S` trips
  `breach`: the recorded post-hoc detector, not prevention. Parked waiters
  keep their queue
  position (grant-from-head: a settle that frees nothing never wakes the
  head at all — a waiter is woken only WITH its grant or with a trip), a
  newcomer never jumps the queue, and a
  tripped waiter short-circuits at its wake with the budget verdict
  (`budget-exhausted`; `cancelled` under a signal trip) rather than being
  refused at trip time. No `W_max`
  floor exists at the kernel seam — sizing is honest-share, not
  demonstrated-worst-case; the floor machinery is W2.1/W3.5's (HARD rows).
  A zero cap admits nothing: the first reserve trips `exhausted` before any
  dispatch (a zero budget that dispatches anyway is the lie the cap
  prevents). Uncapped governed runs are reservation-less (there is no bound
  to hold capacity against; their ledger folds observed evidence exactly as
  W2.2). Token caps are not a reservation dimension — USD is the ledger's
  binding unit (the W2.2 `prevCapTokens` record); the token rollup binds
  through the DD-9 folds unchanged.
- **Charges.** Evidence folds attribute to the job's open reservation.
  Definitive verdicts settle basis `observed` — the charge is exactly what
  the folds saw (a pre-dispatch failure like an unknown op settles 0). A
  dispatch ending in UNKNOWN status — ladder kill, `indeterminate` verdict,
  a defensive throw, or a post-invocation failure — settles basis `full`:
  charged = max(r, folded), at
  least the whole reservation (spend may exist that no fold saw). The
  post-invocation case is INVISIBLE in the verdict — `executeOp` never
  rejects and flattens every such failure into a `failed` result (by the
  frozen contract), so the dispatch signals it out of band and the settle
  reads that signal. It covers a body that REJECTED and a body that RESOLVED
  to something that is not an `OpResult` at all: both RAN the op, so both
  may have spent. The PRE-dispatch failures — a throwing registry lookup, an
  unknown op, a schema violation, a throwing importer — provably dispatched
  nothing and settle `observed` zero. A body that resolved to a WELL-FORMED
  result whose VALUE the journal refuses is deliberately NOT in the signal:
  that is the evidence guard's lying-measurement case (a `NaN`/negative
  `costUSD` folds nothing by design), and a full-reservation charge there
  would let a bad number invent spend no fold ever saw. Recorded residual:
  a dispatch whose ONLY evidence is such an uns journallable value settles
  `observed` at zero. The
  journal's `reservation-settled.charged` and the live ledger agree exactly
  (the settle adds only the un-counted remainder), and the event carries
  `priced` — whether a `costUSD`, ZERO included, was observed on the
  channel — so the resume fold's DD-9 check (`charged === 0 && usage > 0 &&
!priced`) never mistakes a legitimate zero-priced/subscription lane for
  unpriced spend. `charged > r` trips
  `breach`. That trip is a post-hoc DETECTOR, recorded as such: it fires at
  SETTLE — after the overshoot already spent — because the gate holds no
  pre-dispatch floor at this seam (no `W_max`); the ADR's floor machinery
  (W2.1/W3.5) is the closure, and until then breach is evidence of
  underselling, not prevention. Residuals, recorded: post-settle folds from
  a detached (killed) op promise are suppressed at the runner — the `full`
  charge covers them — but a misbehaving op streaming evidence after a
  NORMAL settle would move the live ledger without journal backing (the
  driver-side report-on-every-exit-path guard, W2.1, is the real closure);
  and a durable `reservation-settled` WRITE failure after the in-memory
  settle leaves the journal's reservation open while the live ledger took
  the charge — the next fold charges `r` in full where the live run charged
  possibly-less (conservative, but permanent divergence with no abandon
  path; the write-ahead OPEN side has one, the settle side has none).
- **The structured driver-seam settle channel** (`errorClass`,
  `providerSignals`, `failedAttemptsObserved`, ADR-0003 §2.2 step 9) rides
  `reservation-settled` from W2.1/W3.3 outward; this slice journals the
  usage rollup only. The driver-seam `BudgetReservation` /
  `RunOptions.reservation` types are W3.3's (one types bump on the last P2
  PR) — the kernel's reservation is internal.
- **Abort-on-trip.** A trip (any kind) aborts the run's trip signal; every
  dispatch ladder composes it, so in-flight ops see the abort through
  `currentJobContext()` and settle. The governor owns this signal (I8 —
  `bindRunSignal`/`tripAbortSignal`; the kernel keeps ONE cancellation-root
  owner, pinned by test/kernel/driver-hygiene.test.ts).
- **A12c — the ADVISORY gate.** Every dispatch classifies through
  `src/kernel/lanes.ts` (`classifyDispatch`): the table ships EMPTY — no
  conformance leg has proven a lane HARD, so every dispatch is ADVISORY at
  v1.1 — and a 'hard' row without `evidence` throws (HARD is demonstrated,
  never declared). A NON-EMPTY table with no dispatch key throws too — a
  HARD row silently failing to match (the gate refusing as ADVISORY while
  the table promises HARD) is the inert-gate failure this module never
  hides. ADVISORY + unattended (`attended` defaults false, P8) +
  no escape → refused per dispatch: `reservation-refused
{reason:'advisory-lane'}` journalled, the row budget-exhausted ON ITSELF,
  dependents re-marked transitively, nothing dispatched. The gate sits
  behind the trip check: on an already-tripped run the refusal names the
  TRIP as the cause (`governor.admit`), never a mis-attributed
  `advisory-lane`. One refusal yields two honest-stop shapes, split on the
  runner's `advisoryRefused && !stop.requested` gate: with stopOnError false
  the refusal counts as a budget-family stop (`earlyStopReason: 'budget'`
  claimed, dependents re-marked transitively), while under stopOnError the
  rows stay re-runnable `queued` and NO `earlyStopReason: 'budget'` is
  claimed — the journal holds a per-row refusal, not a budget-tripped fact,
  so claiming a budget stop would assert a $0-spent bound the run never
  fired. The escapes:
  `Governance.allowAdvisory` (CLI `--allow-advisory-budget`) or
  `attended: true`, and the escape is ROUTED, never hardcoded: product
  paths turn it on through their own explicit options (default OFF at the
  library surface), and the journal records WHO set it —
  `allowAdvisoryProvenance: 'operator' | 'product'` — because ADR-0003
  §2.3 puts allowAdvisory admissions OUTSIDE the C_max bound, so a future
  HARD row's breach must be attributable. Recorded posture (v1.1): the
  unattended-by-design product paths (review-loop's sweep, self-merge-prs)
  pass the escape explicitly; an embedder withholding it refuses every
  dispatch on unattended runs — that is the gate working, not a bug.
  Recorded gap: the journalled `governance` block validates provenance ONLY
  in the direction it needs for safety — provenance without the escape is
  refused, but the escape WITHOUT provenance is accepted, so a library
  caller can persist an unattributed lane (both in-diff product paths stamp
  theirs: the CLI `'operator'`, self-merge-prs `'product'`). The honest
  closure is to make the unattributed escape unrepresentable — either the
  inverse check plus a migration of every `{ allowAdvisory: true }` caller
  to pass provenance, or distinct operator/product entry points that derive
  it — not a footnote: this schema IS the durable record, so the check
  belongs where the record is written. Recorded here for that change.
- **Capless governed runs inherit C_prev.** A governed run without a cap
  over capped history conservatively inherits the predecessor cap
  (`governor.inheritCapUsd`) and journals
  `run-started.governance.inheritedCapUsd` — the ledger's C never silently
  disappears between runs. The inheritance does NOT move the raise
  refusal's predecessor cap. Recorded residual: the inherited value reads
  the same journalled `capUsd` the raise refusal reads, so a hand-edited
  journal can inflate it the same way it could inflate a predecessor cap —
  trusted-by-possession, no new trust assumption — and an inherited cap
  BINDS like a configured one (it arms the DD-9 unpriced trip and the
  seeded-overrun check on a run that set no `maxUsd` of its own; the trip
  message names the inheritance).
- **Fold eras.** A run with any `reservation-opened` folds its spend from
  reservation events (`Σ settled.charged + Σ r(unresolved)`); a W2.2-era
  governed run (no reservations) folds from `job-finished.costUSD` with the
  per-(run, job) close rule — the composite-key hardening the cycle-3
  rejection noted, which M2 landed and this fold preserves. Corruption is
  loud: a settle without an open, or a finish over an unsettled
  reservation, throws (writer order + durable-before-issued makes both
  unreachable from an honest writer).
- **`budget-tripped`** is journalled once per run, just before
  `run-finished` — the durable fact of which bound fired and why; the
  honest-stop CLAIM stays the report's taxonomy.
- **Human-approval quarantine interaction (W4.3 note):** a job refused or
  quarantined never burns its approval token — consumption happens only at
  exercise (the annex's refusal-is-non-burning rule already composes with
  this slice's refusals).

## Governor config

`GovernorConfig` is plain serializable data (W2.2 removed its one
runtime-only field, the `jobKey` extractor — admission keys on the real
plan job id). `governorConfig(opts, limits, extra?)` builds it from the
frozen `RunOptions`/`Limits` surfaces with the min-precedence applied.

| field               | meaning                                                                                                                                                          | default                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `maxUsd`            | EFFECTIVE run USD cap = min(RunOptions.maxUsd, Limits.maxUsd)                                                                                                    | none                                                                           |
| `maxTokens`         | EFFECTIVE run token cap = `RunOptions.maxTokens` (DD-9's parallel token rollup; no Limits half in v1) — independent of `maxUsd`, same exceeds-cap trip semantics | none                                                                           |
| `perJobWallClockMs` | rung-1 delay (`Limits.perJobWallClockMs`)                                                                                                                        | none = no ladder                                                               |
| `abortGraceMs`      | rung 1 → rung 2 grace                                                                                                                                            | `DEFAULT_ABORT_GRACE_MS` = 5000 (DD-1 spike result — docs/dd-1-abort-spike.md) |
| `killGraceMs`       | rung 2 → rung 3 grace                                                                                                                                            | `DEFAULT_KILL_GRACE_MS` = 5000 (conservative; no spike evidence to move it)    |
| `maxAttemptsPerJob` | per-job attempt cap (effective min)                                                                                                                              | none                                                                           |
| `runDispatchQuota`  | per-run dispatch/attempt cap (`Limits.runDispatchQuota`)                                                                                                         | none                                                                           |
| `inFlightCeiling`   | in-flight ceiling — enforced by queueing                                                                                                                         | none                                                                           |

**DD-1 result: CLOSED (T1.6 spike)** — the abort spike ran LIVE on both
governed lanes (method + numbers: `docs/dd-1-abort-spike.md`): a governed
abort settles ≈6 ms after the signal on the ai-sdk lane and ≈2.0 s on the
claude-agent lane (SDK CLI-worker teardown; the post-abort poll verified no
transcript growth and no surviving worker process — abort stops spend
client-side in both lanes). The spike-derived `DEFAULT_ABORT_GRACE_MS` =
5000 (≈2.5× the measured worst cooperative settle; the pre-spike 2000 sat
exactly AT it) lives in `src/kernel/governor.config.ts` — the single source
of truth, re-exported by `governor.ts` and pinned to the doc by
`test/kernel/governor-config.test.ts`. `DEFAULT_KILL_GRACE_MS` stays 5000:
the spike gathered no SIGTERM→SIGKILL-resistance evidence, so the T1.5
process-ladder measurements stand.

**DD-9 result: CLOSED for the governor half (T1.6b)** — what shipped in
T1.6b is the GOVERNOR's machinery: `GovernorConfig.maxTokens` with the
parallel token rollup, the modeled-cost labeling, the unpriced-usage
fail-loud fold, and the seed-time trip over BOTH caps. Every PRICED
usage-bearing driver result carries `costUSD` labeled `costBasis: 'modeled'`
(the list-price proxy from `src/driver/pricing`); a result from an unpriced
model carries NEITHER field. On that basis `maxUsd` binds
subscription-routed lanes through the modeled figure (primary), and
`RunOptions.maxTokens` binds independently as the unpriced-model backstop.
Folding real usage that carries no `costUSD` under a configured `maxUsd`
trips the budget loud — never fail open (the escapes: price the model, or
cap with `maxTokens`), and the seed-time trip covers BOTH caps, so a resumed
run whose journaled rollup already overruns either cap stops before
admitting anything. WIRED (the driver→governor bridge, review-debt #14): the
governed runner folds a completed `ok` value that carries a WorkerResult
shape through `observeResult` once (the transitional `reportResult`
streaming channel suppressed via once-only flags), `RunOptionsSchema`
accepts `maxTokens`, and seeded journaled usage with no costUSD evidence
under a configured `maxUsd` trips at seed time. Full disposition:
`docs/dd-9-api-equivalent-budget.md`.
**DD-9 result: CLOSED (T1.6b)** — the api-equivalent budget shipped. Every
usage-bearing driver result carries `costUSD` labeled
`costBasis: 'modeled'` (the list-price proxy from `src/driver/pricing`), so
`maxUsd` binds subscription-routed lanes through the modeled figure
(primary), and `RunOptions.maxTokens` binds independently as the
unpriced-model backstop. Folding real usage that carries no `costUSD` under
a configured `maxUsd` trips the budget loud — never fail open (the
escapes: price the model, or cap with `maxTokens`), and the seed-time trip
covers BOTH caps, so a resumed run whose journaled rollup already overruns
either cap stops before admitting anything. Full disposition:
`docs/dd-9-api-equivalent-budget.md`.

Every timer in the governor flows through the injected `Clock`
(`new BudgetGovernor(config, clock)`; default `realClock`) — there is no
naked `setTimeout` in the governor — so slice-2 tests advance virtual time
deterministically and assert the ladder purely from
`BudgetGovernor.events` (admissions, refusals, rungs with delays and
`delivered` flags, completions, the trip, the seed).

## Rescue lane (T1.3)

`src/kernel/rescue.ts` holds the policy TABLE — plain serializable data
(JSON round-trips losslessly; no functions) — and the pure decision engine
that consumes it. Invariant I8 in kernel terms: the KERNEL decides WHETHER
to retry/escalate and WHAT a re-dispatch carries; drivers execute and never
decide. The kernel never constructs driver objects — escalation is data a
driver-owning layer maps onto real drivers.

Shape (first matching row wins; `on` matches the LATEST attempt's outcome;
`op` scopes the row when present):

```ts
interface RescuePolicyRow {
  id: string;                 // stable — audit references name the deciding row
  on: RescueOutcome | 'any';  // 'ok'|'failed'|'needs-human'|'budget-exhausted'|'indeterminate'|'killed'
  op?: string;                // absent = every op
  action:
    | { kind: 'retry';
        maxAttempts: number;  // MAX TOTAL attempts under this row (1 = never re-dispatch)
        escalate?: { model?: string; provider?: string; driver?: string };
        carrySessionRef?: boolean }  // echo the latest attempt's session resume token
    | { kind: 'skip' };       // explicit conservative termination
}
interface RescuePolicy { rows: RescuePolicyRow[] }
```

`CONSERVATIVE_RESCUE_POLICY = { rows: [] }` rescues nothing.

Decision rules, in order — first termination wins (conservative by
construction):

1. Guards first. `baseline-failed` (the job's pre-rescue baseline attempt
   ended in a definitive failure — a real verdict; re-dispatch cannot help)
   and `human-intervened` (a human owns the next move) terminate with the
   guard named; NO row overrides a guard — when a guard trips, rescue NEVER
   retries. A `needs-human` latest outcome auto-trips the human-intervened
   guard.
2. No attempts → terminate (`no-attempts`); latest outcome `ok` → terminate
   (`already-ok`).
3. No matching row → terminate (`no-policy-row`); a `skip` row → terminate
   (`policy-skip`).
4. A `retry` row is bounded by the EFFECTIVE per-job attempt cap =
   min(`row.maxAttempts`, `Limits.maxAttemptsPerJob`) — at cap, terminate
   (`attempt-cap`, naming which bound refused). Otherwise re-dispatch as
   attempt `n+1` carrying the row's escalation (stronger model/driver, as
   data) and — only when the row says `carrySessionRef` and the latest
   attempt observed a token — the session resume token (`OpInvocation.sessionRef`
   on the frozen seam; observed from `WorkerResult.sessionId`).

`attemptsFromJournal(events, jobId)` is the evidence fold: each
`job-started` opens a dispatch with ordinal max(frozen `attempt` field,
dispatch occurrence) — the occurrence count carries the truth while the
runner still writes `attempt: 1`, and the frozen field dominates once real
attempt numbers land; the matching `job-finished` closes it with the frozen
result; a start with no finish (crash/torn tail) stays `killed`; an orphan
finish is a replay re-attestation refreshing the last attempt. From journal
evidence alone a ladder kill and any other budget-exhausted result fold to
the same frozen status — refine to `killed` from the governor's event
stream when available.

Executing a `retry` decision = a resumed `runPlan` whose dispatches honor
the decision — never an in-wrapper retry (see the governor section). The
composition harness for that arrives with the op families (T1.4+).

## Recorded design decisions (T1.3)

- **Decorator seam** chosen over the `runPlan` `gov` parameter: purely
  additive, runner untouched; the `gov` parameter is the recorded T1.4
  runner-integration path.
- **Ladder kills settle `budget-exhausted`**, not `indeterminate`: known
  budget cause; journal stays honest; resume re-runs the row.
- **No in-wrapper retries**: retries must rise through the runner so
  `JobStartedJournalEvent.attempt` rises; anything else hides attempts from
  the journal.
- **Job-key identity**: the frozen Op contract carries no job id, so caps
  key on an explicit `jobKey` extractor, the `input.jobId` plan-jobId
  convention, else the OP NAME — under that fallback every dispatch of an op
  counts as another attempt of that op, so the per-job attempt cap always
  exists (a per-dispatch unique key would make it a silent no-op).
  `seedFromJournal` seeds BOTH keys (journal jobId and op name) so a resumed
  run's caps hold under either identity. Stable per-job identity needs
  `config.jobKey` or `input.jobId`.
- **Seed dedupe**: usage is counted only for journal finishes that close an
  open start — an orphan finish in a multi-run journal is a replay
  re-attestation of an already-counted dispatch, and counting it again would
  double the rollup.
- **Trip gates admission only** _(T1.3's decision — superseded by W2.3's
  abort-on-trip, see "Reserve-then-settle" above)_: in-flight jobs complete; their evidence
  stays real.
- **USD is observed, never derived**: cost arrives from the op's evidence
  folds (a priced driver result carries `costUSD` labeled
  `costBasis: 'modeled'`); the kernel computes no cost.
- **Grace defaults are spike-derived where measurement exists**:
  `DEFAULT_ABORT_GRACE_MS` = 5000 from the DD-1 spike
  (docs/dd-1-abort-spike.md; single source of truth
  `src/kernel/governor.config.ts`); `DEFAULT_KILL_GRACE_MS` = 5000 stays
  conservative (no spike evidence to move it).
