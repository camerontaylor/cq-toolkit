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
  schema-validated facts; a torn tail (crash mid-append) is ignored only as
  the LAST line, corrupt middle lines throw; `statusOf` is derived at read
  by folding events.
- **Replay/resume** (`resume: true`): the latest prior run for the planId;
  a job skips only on terminal-`ok` + equal `inputsHash` (zero op
  invocation, outcome reconstructed from the journal); everything else
  re-runs — continue-from-first-failure falls out naturally.
- **stopOnError**: after the first non-ok result nothing new starts
  (in-flight jobs complete and are recorded); downstream jobs are `blocked`,
  never-dispatched jobs with healthy dependencies are `queued`.

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
  self-contained so the latest-run rule survives chained resumes.
- `stopOnError` leaving jobs unstarted does NOT set `stoppedEarly`: the
  frozen `RunEarlyStopReason` only contains `'budget'`, and honest-stop
  marking is T1.3's — callers read `counts.queued`/`counts.blocked` to see
  what never ran.

## Budget governor (T1.3)

The governor owns WHEN to abort (invariant I8): the per-job wall-clock
escalation ladder, per-job and per-run attempt caps, the USD rollup cap, and
the dual in-flight/dispatch caps. Source: `src/kernel/governor.ts` (enforcer)
and `src/kernel/rescue.ts` (policy table + decision engine).

- **Seam — governed-registry decorator (recorded decision).**
  `governRegistry(view, governor)` wraps an `OpRegistryView`; every op
  invocation then runs under admission caps, the in-flight ceiling, and the
  escalation ladder. Chosen over a `runPlan(plan, opts, registry, gov?)`
  parameter because it is purely additive — T1.2 call-sites and tests compile
  and pass unchanged, and the runner stays frozen. The `gov` parameter is the
  recorded T1.4 runner-integration path (retries must raise the frozen
  `JobStartedJournalEvent.attempt` field, and only the runner journals
  dispatches). Consequence, also recorded: the governor NEVER retries inside
  the wrapper — an in-wrapper retry would hide attempts from the journal
  (one job-started, two real dispatches), which is journal-dishonest and
  rejected. Re-dispatch happens at the runPlan level via the rescue lane.
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
- **USD accounting.** Ops report usage and cost through the job context
  (`reportUsage` / `reportCost`); the governor rolls up and trips at the
  EFFECTIVE cap = min(`RunOptions.maxUsd`, `Limits.maxUsd`) (frozen
  precedence; the cap is inclusive — the trip fires when the rollup EXCEEDS
  it). The kernel never derives cost itself: until the T1.4 price-map layer
  lands, tests inject cost via `reportCost`. Tripping gates admission only —
  in-flight jobs were admitted before the trip and their outcomes stay real
  evidence (aborting them mid-flight would complicate honest attribution;
  recorded decision).
- **Honest stop (I9).** `withBudgetStop(report, plan, governor)` annotates a
  returned report ONLY when the governor actually tripped:
  `stoppedEarly: true`, `earlyStopReason: 'budget'` (the frozen
  `RunEarlyStopReason`'s only value — this is its purpose), and
  never-dispatched rows re-marked `OpResult {status:'budget-exhausted'}`:
  `queued: …` marker rows always; `blocked: …` marker rows only when their
  whole dependency obstruction is transitively budget-caused — a blocked row
  with a definitively-failed dependency keeps its real verdict. Executed
  rows are never rewritten. Counts are recomputed over the marked rows
  (mirroring the runner's private state mapping — keep-in-sync note in the
  source). Today the caller composes
  `withBudgetStop(await runPlan(...), plan, governor)`; the T1.4 runner
  integration folds it into runPlan.
- **Composable with resume.** A run the governor stopped still leaves
  journal evidence: an in-process kill produces a terminal
  budget-exhausted record; a hard-crashed job has `job-started` with no
  terminal event. Both re-enter correctly on `resume: true` (T1.2 replay
  re-runs every non-ok row). `seedFromRunLog(log, planId, {config?, usdOf?})`
  is the composition path: it reads ALL of the plan's run journals (the same
  `<planId>--` prefix + run-started `planId` matchers as resume,
  oldest-first) and seeds a constructed governor from their ordered
  concatenation. The raw `BudgetGovernor.seedFromJournal(events, {usdOf?})`
  requires exactly that concatenation — the latest run's journal alone
  undercounts re-attested jobs (finish-only events) and chained dispatches.
  The fold carries per-job attempt ordinals from the frozen attempt field
  (via `rescue.attemptsFromJournal`), the usage
  rollup (USD needs the optional `usdOf` price mapping), and the dispatch
  count (`runDispatchQuota` carries across resume instead of restarting at
  0) — so a resumed run continues the SAME budget. Under the op-name
  fallback the op key seeds the SUM of the op's journaled dispatches (the
  fallback's ordinal IS the op's dispatch count; a max would understate it
  and let a resumed run exceed the cap). Consequence: budget-exhausted rows
  are
  terminal and are NOT auto-retried by resume in any effective sense — a
  seeded, still-tripped governor re-marks them without op invocation; only
  an input change (new `inputsHash`, which defeats even ok-skip in T1.2
  replay) puts them back under the caps as genuinely new work. Without a
  seed, T1.2 replay re-runs them as fresh dispatches — still under the
  same caps.

## Governor config

`GovernorConfig` is plain serializable data for now (the one runtime-only
field is `jobKey`, a function — like the registry's importer, never
persisted). `governorConfig(opts, limits, extra?)` builds it from the frozen
`RunOptions`/`Limits` surfaces with the min-precedence applied.

| field | meaning | default |
| --- | --- | --- |
| `maxUsd` | EFFECTIVE run USD cap = min(RunOptions.maxUsd, Limits.maxUsd) | none |
| `maxTokens` | EFFECTIVE run token cap = `RunOptions.maxTokens` (DD-9's parallel token rollup; no Limits half in v1) — independent of `maxUsd`, same exceeds-cap trip semantics | none |
| `perJobWallClockMs` | rung-1 delay (`Limits.perJobWallClockMs`) | none = no ladder |
| `abortGraceMs` | rung 1 → rung 2 grace | `DEFAULT_ABORT_GRACE_MS` = 5000 (DD-1 spike result — docs/dd-1-abort-spike.md) |
| `killGraceMs` | rung 2 → rung 3 grace | `DEFAULT_KILL_GRACE_MS` = 5000 (conservative; no spike evidence to move it) |
| `maxAttemptsPerJob` | per-job attempt cap (effective min) | none |
| `runDispatchQuota` | per-run dispatch/attempt cap (`Limits.runDispatchQuota`) | none |
| `inFlightCeiling` | in-flight ceiling — enforced by queueing | none |
| `jobKey` | job-key extractor (runtime-only) | `input.jobId` convention, else the **op name** |

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
admitting anything. NOT yet wired in production: the per-result fold —
`observeResult` has no production caller (runs fold only through
`governOp`'s streaming `onUsage`/`onCost` callbacks), and
`RunOptionsSchema` does not yet accept `maxTokens`; until that bridge lands
the strict schema rejects the option (review-debt #14). Full disposition:
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
- **Trip gates admission only**: in-flight jobs complete; their evidence
  stays real.
- **USD is observed, never derived**: cost arrives via `reportCost` (tests
  inject until the T1.4 price-map layer); the kernel computes no cost.
- **Grace defaults are spike-derived where measurement exists**:
  `DEFAULT_ABORT_GRACE_MS` = 5000 from the DD-1 spike
  (docs/dd-1-abort-spike.md; single source of truth
  `src/kernel/governor.config.ts`); `DEFAULT_KILL_GRACE_MS` = 5000 stays
  conservative (no spike evidence to move it).
