# ADR 0003 — Governed runner, budgets as ceilings, human-approval token

> Publication note (W7.2): copied from `toolkit-research` branch `research/g1-adr-reconciliation` at `bf5f540`. The status below records the later owner G1 decision. References below to pending G1 approval or draft status describe the source text at its drafting date; accepted preconditions and residuals remain binding.

Status: **accepted** (owner G1 sign-off, 2026-09-26; binding work-item preconditions and residuals retained)

- Critic round 1 (`research/adr-0003-critic` @ `d8349c8`) returned ITERATE with 16 findings. All are
  dispositioned in `adr-0003-r1-dispositions.md`, which is not published in this repository (it lives in the private
  `toolkit-research` repository).
- Critic round 2 (final, `research/adr-0003-critic-r2` @ `f4ebca6`) returned ITERATE with 13 residual findings
  (3 major). Still pending: a cross-family second opinion (V11PLAN §16.8) and owner approval at G1.
- **Reconciled (G1 prep): 2026-09-25.** Folds `adr-0003-critic-r2-verdict.md` (`f4ebca6`), the cross-ADR items of
  `adr-0002-critic-r2-verdict.md` (`research/adr-0002-critic-r2` @ `95bcf63`: the dispatch shape and the class
  channel), RS-14 (`research/rs14-provider-limits` @ `ab671be`) and RS-7 (`research/rs7-public-api` @ `1b9a709`).
  Finding → section → change: `adr-reconciliation-log.md`. The owner's accept-vs-hold decision is stated in §6; it
  is not taken here.

Date: 2026-09-25 (r0), 2026-09-25 (r1), 2026-09-25 (G1 reconciliation).
Amends: ADR-0001 (the T1.1 freeze of `runPlan`, `RunOptions` and the journal schema). Paired with ADR-0002
(seam v2). Together they are the **single P2 thaw**: one types bump, `SEAM_VERSION = 2`.
Evidence:

- `rs6-governed-runner.md`, anchored against cq-toolkit `5e52707` and cq-fixtures `8f6b94c`;
- RS-1/RS-1b (`research/rs1-cli-surface`);
- static inspection of the claude CLI 2.1.280 bundle, and the Anthropic model and pricing docs (fetched
  2026-09-25): design note §2.6.

Annexes: `adr-0003-journal-migration.md` (journal v2 and replay), `adr-0003-approval-token.md` (token spec),
`adr-0003-r1-dispositions.md` (critic round 1; private `toolkit-research` repository, unpublished).
Slots: **C — provider-profile contents (RS-14)**; **D — configuration keys (RS-15)**.

## 1. Context

v1 retrofitted budget governance onto a frozen runner. The result (J1 C1, C2, M1–M4, M6, M7) is:

- spend is op-reported and opt-in;
- usage is never journalled;
- caps gate admission only;
- attempts are keyed heuristically;
- the kill rung frees the slot;
- there are **four** hand-copied compositions: three in the toolkit, one in cq-fixtures `runner/index.ts:326-397`;
- there is no journal lock.

D5 decides:

- ceilings are in modeled API-equivalent units;
- admission is reserve-then-settle;
- reservations are write-ahead;
- an unresolved reservation is charged in full and its job quarantined on resume;
- a trip aborts in-flight work;
- every lane is ADVISORY until proven HARD.

J4 M3 needs `approved:true` to stop being plan data.

RS-1b demonstrated the only native cap in evidence: the claude CLI's `--max-budget-usd`, a per-invocation
between-request check. Re-reading its streams shows two faults on the toolkit's current settlement path:

- It settles from `result.usage`. That field is a **lagging, main-loop-only prefix sum**: requests 1…n−1, missing
  the final request and every auxiliary request.
- It prices the **served dated id** (`claude-haiku-4-5-20251001`), which misses the exact-key price table
  (`pricing/index.ts:28-30` vs `pricing/data.ts:76`). So the lane produces **no cost at all**.

## 2. Decision

### 2.1 `runPlan` takes governance

```ts
export interface Governance {
  governor: Governor;                 // createGovernor(config): ledger + ladder + attempt/quota caps
  clock?: Clock;                      // drives journal `at` (display only) and the ladder
  signal?: AbortSignal;               // run-level cancel → 'signal' trip (CLI: SIGINT/SIGTERM)
  approvals?: readonly string[];      // serialized approval tokens (annex), side channel only
  attended?: boolean;                 // default false (P8)
  releaseQuarantine?: readonly string[]; // job ids, journalled with provenance 'call'
  optIn?: readonly GovernanceOptIn[]; // 'budget.legacyJournal=reset' | 'budget.raiseCap' | 'budget.ungovernedOverGoverned'
                                      // | 'budget.breakLock=<runId>' (G1 reconciliation, §2.5)
}
export function runPlan(plan: Plan, opts: RunOptions, registry: OpRegistryView, gov?: Governance): Promise<RunReport>;

/** Governed scope for callers that dispatch drivers outside a plan (cq-fixtures' eval runner).
 *  r1 signature, kept only as a placeholder: its contract is open at G1 (O-3, below). */
export function runGoverned<T>(gov: Governance, scope: { planId: string; jobId: string; journalDir?: string },
                               fn: () => Promise<T>): Promise<T>;
```

- `opts.maxUsd` or `opts.maxTokens` without `gov` **throws** `runPlan: caps require governance`.
- A run over a journal dir whose plan history contains a governed v2 run **must be governed**. Otherwise it throws,
  unless `optIn` names `budget.ungovernedOverGoverned` (§2.5).
- A run with a `journalDir` holds the **plan lock** (§2.5) for its whole duration.
- The runner owns job identity (`job.id`) and real attempt numbers:
  `attempt = 1 + |prior job-started(job.id)|` across the folded runs.
- **`runPlan` takes over both of `withBudgetStop`'s duties** (§2.9):
  - the transitive budget-caused re-marking of never-dispatched rows;
  - `report.costUSD`.
- `governRegistry`, `withBudgetStop`, `seedFromRunLog`, `JobGovernance.report*` and the three toolkit
  compositions are **deleted, with no shims**. The one consumer outside the toolkit, cq-fixtures (vendored, pinned
  by SHA per P2), migrates in the same thaw (§4 slice 5). The full fallout inventory is design note §5.1.
- The kernel exposes `invokeOp(op, input, registry, gov?)` (W3.2) through the same job gate.

**`runGoverned` / slice F is not yet designed (ADR-0003 critic r2 N3; open point O-3).** As written, the r1 API
governs nothing for its only consumer:

- cq-fixtures constructs its lanes directly (`fixtures:runner/cli.ts:324-329`), so the factory-decorator gate
  (§2.2) never sees `opts.driver.run` (`fixtures:runner/index.ts:524`). It fails open, silently;
- one scope has one `jobId`, but fixtures has per-case jobs, attempts and W6.2 per-case budgets;
- fixtures writes its own v1-shaped journal (`fixtures:runner/index.ts:310`), so file ownership, `seq` and the
  "`reservation-*` only in v2 files" invariant are unspecified;
- the preflight acp probe (`fixtures:runner/index.ts:344-395`) spends outside `Driver.run`;
- `fn` gets no signal and the call returns no report.

Whatever slice F becomes, it MUST meet these requirements (binding W2 acceptance criteria, from the verdict):

1. **Run lifecycle:** one governed run per call. It owns the plan lock, `run-started` v2 with `seq`, the fold and
   `run-finished`.
2. **Per-job scopes:** real attempts and quarantine per case.
3. **Journal ownership:** the caller stops writing its own `run-started`/`run-finished` for that plan id, or uses
   a separate plan id.
4. **Signal and report:** the caller's code receives the trip-aware signal and the governed factory, and gets the
   run report (cost and absence columns, W6.2) back.
5. **No unwrapped drivers:** every dispatched driver comes from the governed factory. A fixtures test asserts
   exactly one `reservation-opened` per dispatched case.
6. **The probe:** routed through the gate, or declared an excluded, journalled spend.

The **shape** is the open choice, and the verdict names two: (i) a real `runGoverned` contract
(`scope.job(jobId, fn)`, `fn` receiving `{signal, factory}`, returning `{value, report}`); or (ii) slice F ports
fixtures onto `runPlan` (its suite already is a job list) and `runGoverned` leaves the public surface until a
second consumer exists. D10's unpause of W6.4 rides on this, so it is listed with the owner items in §6.

### 2.2 Invocation gate: one reservation = one `Driver.run`

- `governDriverFactory(factory)` lives in `src/kernel/governed-driver.ts`. Registry importers bind
  `governDriverFactory(createDriverFactory(cfg))`.
- Outside a governed job context (no `runPlan`/`runGoverned` scope) it is a pass-through that **writes nothing**.
- Inside one, each `run(inv, options?)` does the following:
  1. **Identify the priced model.**
     - Classification and sizing use **`inv.modelSpec`**.
     - If it differs from the `ResolvedDriver.modelSpec` that produced this driver, **after normalisation** (the
       deprecated `provider:'ai-sdk'` alias resolved, ADR-0002 §2.5; ops put `resolved.modelSpec` on the
       invocation), the gate **throws pre-dispatch** (`errorClassOf → 'config'`).
     - `W_max` and the rate table are the **maximum over `inv.modelSpec.model` and every served-model alias**
       declared for it in `ServedModelPolicy.aliases` (lane → provider → requested → served[]; ADR-0002 §2.6, the
       single alias source, which W3.5 also reads).
     - That maximum bounds the served model only while the lane's served-model check is on with
       `requireObserved: true`. A lane configured `requireObserved: false` can serve any model unobserved, so it
       is **ADVISORY** for USD (m-d).
  2. **Classify** `(lane, provider, model)` → `hard | advisory` per configured dimension (§2.4).
     ADVISORY + unattended + no `allowAdvisory` → refuse: `{stopReason:'budget', usage: zero}` plus
     `reservation-refused{reason:'advisory-lane'|'advisory-dimension'}`. Nothing is dispatched.
  3. **Size.** Let `floor = overshootUsd(lane, model) + c_min`, with `c_min > 0` (config, blank $0.01).
     - **Concurrency floor check, the first time a class is seen in the run:** if `C < concurrency × floor`, the
       run cannot hold `concurrency` HARD invocations of this class. The gate refuses
       (`reservation-refused{reason:'cap-below-concurrency-floor'}`) and **trips** (`exhausted`) with a config
       hint: lower `concurrency` or raise the cap. Concurrency is never lowered silently.
     - The proposal is `p = inv.budget.maxUsd ?? C / concurrency`.
     - **`r = max(p, floor)`.** When `p < floor`, the op's smaller ask cannot be enforced HARD. The reservation
       is sized up and journalled `sizedUp: true`.
     - If `C − S < floor`, it is an `exhausted` trip.
     - If `r > C − S − O`:
       - `O > 0`: wait FIFO for a settle;
       - `O = 0`: shrink to `r = C − S` (≥ floor, by the previous rule).
     - Any trip wakes and refuses every waiter (`tripped`). If only zombie reservations hold `O`, the run ends
       `stalled`.
     - **Invariant:** the inner cap `c = r − overshootUsd ≥ c_min > 0`. The gate never passes `c ≤ 0` to a lane.
       The CLI rejects a non-positive cap at parse (design note §2.6), so the invariant also keeps the lane
       from erroring.
  4. **Consult** the provider profile (§2.6): admit, defer, or refuse. The profile reads the limit observations
     (`errorClass` `rate-limit`/`quota`, `providerSignals.windows`) recorded on earlier settles (step 9).
  5. **Write ahead:** append `reservation-opened` and **fdatasync** it.
  6. **Fence:** re-verify plan-lock ownership (§2.5). If it has been lost, do **not** dispatch. The opened record
     stays unresolved and is charged `r` on the next fold.
  7. **Dispatch through `RunOptions`** (ADR-0002 §2.1, reconciled): the signal and the reservation are runtime-only
     and never ride the invocation.
     ```ts
     driver.run(
       { ...inv, budget: { ...inv.budget, maxUsd: c } },
       { signal: AbortSignal.any([options?.signal, jobSignal, tripSignal]
                                   .filter((s): s is AbortSignal => s !== undefined)), reservation },
     )
     ```
     This is the gate's own `run(inv, options?)` composing, not forwarding. A cast that puts `signal` on the
     invocation compiles (as r1's snippet would under a widened type) but never reaches the lane, which fails
     open on the trip-abort (§2.3); conformance leg b-v covers the pass-through wrappers.
  8. **Charge** (design note §3.4):
     - **the modeled cost of the reported usage plus billed-then-failed attempts**, when the lane's report is
       authoritative for that exit path:
       `charged = modeled(reported) + W_max(main) × failedAttemptsObserved` (N2). On a lane whose mechanism
       counts billed-then-failed attempts itself, `failedAttemptsObserved = 0`.
       - **subprocess:** `failedAttemptsObserved` = the number of stream-json `system`/`api_retry` frames
         (`attempt`, `max_retries`, `error_status`). The frame is documented for headless mode
         (code.claude.com/docs/en/headless, recorded in `research/research-20260912-r1-substrate/notes/
subprocess-cli-baseline.md:12`) and was found in the CLI 2.1.280 bundle as the wire twin of
         `SDKAPIRetryMessage` (static read, critic r2 N2; **no live capture yet**, a W2.1 evidence item);
       - **claude-agent:** the same frame if the SDK surfaces it, otherwise `R_max`;
       - with `CLAUDE_CODE_MAX_RETRIES=0` pinned and proxy-asserted, the term is 0 on success, and an `error` exit
         after a transport failure is charged `r`;
       - **ai-sdk:** unchanged (`W_step` per failed attempt, or `maxRetries: 0`). The CLI rule is its settle-side
         twin, and the additive `overshootUsd` (§2.4 criterion 6) remains the dispatch-side twin;
     - `min(r, observed + W_step × (1 + failedAttempts))` for an in-process abort;
     - `r` for a process-lane abort, an unreturned invocation, or **any throw whose `errorClassOf` is not
       `config`/`auth`** (a seam violation of unknown dispatch status, plus a `breach`-class diagnostic);
     - `0` only for a `config`/`auth` pre-dispatch throw or a pre-aborted signal.
  9. **Settle:** append `reservation-settled` (fdatasync) and update the ledger. `charged > r` → a `breach` trip.
     The settle record carries the result's **`errorClass` and `providerSignals`** (and `failedAttemptsObserved`),
     structured (journal annex §2). This is the channel ADR-0002 §2.7 names for class-aware rescue rows and W2.6
     admission. Ops forward nothing, and nothing parses `OpResult.error` text.
- The gate is the **only** writer of spend.

**The reservation rides `RunOptions`, not `Budget`** (reconciled with ADR-0002 §2.1/§2.7; ADR-0002 critic r2 N2,
option (a)). The type is plain data, declared in `src/driver/types.ts` so the driver family needs no kernel
import; this ADR owns its field set:

```ts
export interface BudgetReservation {
  id: string;               // `${runId}:${jobId}:${attempt}:${seq}`
  usd?: number;             // r
  tokens?: number;
  overshootUsd: number;     // additive, per §2.4 criterion 6 (0 = lane pre-checks every request in-process)
  class: 'hard' | 'advisory';   // r1: renamed from `lane` (collided with ResolvedDriver.lane: LaneId)
}
// ADR-0002 §2.1: RunOptions { signal?: AbortSignal | undefined; reservation?: BudgetReservation | undefined }
```

- `Budget` gains no reservation field, and `BudgetSchema` is unchanged by it. (ADR-0002 still lets this ADR add
  optional **cap** fields to `Budget` in the same bump; none is needed today.)
- `reservation` is **runtime-only, like `signal`**, and lives beside it. Its run-scoped id therefore never enters
  an invocation, a journal copy of one, or an invocation hash. r1 relied on excluding it from `OpInvocationData`,
  a projection ADR-0002 r1 deleted; that dependency is gone.
- **`Budget.maxUsd` changes meaning.** It was "caller-side derived accounting", ignored by every lane at
  `5e52707`. After W2.1 it is an **enforced inner cap**: HARD lanes MUST enforce it natively in-process
  (subprocess `--max-budget-usd`, claude-agent `maxBudgetUsd`, ai-sdk pre-request guard). This also applies to
  ungoverned SDK callers, whose `maxUsd` becomes a live stop (Consequences).
- Drivers MAY ignore `RunOptions.reservation` (ADR-0002 §2.1). That is safe because classification is keyed on
  `ResolvedDriver.lane`, and lane-less drivers are ADVISORY (ADR-0002 §2.5).

### 2.3 Admission, trips, and the bound

- **Admission:** `S + O + r ≤ C` per configured dimension.
- **Token caps are ADVISORY on every lane in v1.1.** An unattended run with `maxTokens` needs `allowAdvisory`.
- **Trip kinds:** `exhausted`, `breach`, `token-cap`, `signal`, `lock-lost`, `provider`.
- **On a trip (D5):** no new reservations; queued jobs are not started; **in-flight invocations are aborted**;
  slots and reservations stay held until each driver returns.
- **Bound (USD).** On HARD lanes, total modeled spend over a plan's governed runs is **≤ C_max**, where `C_max`
  is the largest cap any of those runs used. It holds under three stated preconditions, each enforced:
  1. **Sizing:** each reservation `r ≥` the invocation's demonstrated worst case (`r ≥ floor`, with `overshootUsd`
     per §2.4). Enforced by §2.2 step 3.
  2. **One ledger:** exactly one live process admits against a plan's ledger at a time. Enforced by the plan lock
     plus the pre-dispatch fence (§2.5).
  3. **Complete history:** every dispatch over the plan's governed history is write-ahead journalled. Enforced
     by the governed-only rule. The bound **excludes** v1 runs admitted under `legacyJournal=reset`, and runs
     under `ungovernedOverGoverned`. Both are named per-call opt-ins, journalled on `run-started`.

  Raising the cap on resume requires `optIn: budget.raiseCap` (P7/P8). Without it, `C_now > C_prev` throws.

  **Scope of the bound (reconciliation).**
  - It covers plans whose **every admitted invocation is HARD**. ADVISORY invocations admitted under
    `allowAdvisory`/`attended` are outside it. Their sizing rule (`r`, `c`, whether the concurrency floor check
    applies, and whether an expected `charged > r` trips `breach`) is **not yet defined** (critic r2 m-h; open
    point O-4). Until it is, step 9's unconditional `breach` trip applies to them too, so an allowed ADVISORY run
    that overspends its `r` stops.
  - It is scoped to **one journal dir**. A run with a fresh `--journal-dir`, or none, starts at `S = 0` and does
    not see quarantine. That is inherent (no shared state), and it qualifies §2.5's quarantine rationale ("the
    orphan may still be running"), which holds only within that dir.

- **Early-stop reasons:** `RunEarlyStopReason` widens from `'budget'` to
  `'budget' | 'signal' | 'stalled' | 'deferred' | 'lock-lost' | 'provider'`.
  - Trip → reason: `exhausted`/`breach`/`token-cap` → `budget`; `signal` → `signal`; `lock-lost` → `lock-lost`;
    profile `refuse` → `provider`; profile `defer` → `deferred`.

### 2.4 Lane classification

A `(lane, provider, model)` is **HARD for USD** only when all of the following are **demonstrated** by a
conformance leg in CI. Legs 2, 3, 4 and 6 run the lane through the **recording proxy** (below).

1. **In-process mechanism.** A mechanism _inside the invocation's own process tree_ stops further requests once
   the inner cap is reached. This is what makes the bound survive an orphaned child after a parent crash.
2. **`W_max` from API-published limits.**
   - `W_max = maxInputTokens × maxInputClassRate + maxOutputTokens × outputRate`.
   - Both token limits come from the provider's published model limits: the Models API
     `max_input_tokens`/`max_tokens`, or the model card. They are **never** a client default.
   - A lane MAY pin a smaller output cap (e.g. `CLAUDE_CODE_MAX_OUTPUT_TOKENS`) and use it in `W_max` only if the
     proxy leg shows **every** request's `max_tokens` ≤ the pin.
   - A context-extending mode (a `[1m]` model suffix, a 1M beta) is refused unless `W_max` is recomputed for it.
   - Rates include every applicable multiplier that the lane can set: data residency 1.1×, fast mode, and
     **long-context input/output tiers** where the provider prices long prompts at a premium (critic r2 m-i;
     which models carry tiered rates is re-fetched from the pricing page when the row is demonstrated).
   - `maxTurns` and post-step stops don't qualify.
3. **Per-rate dominance.** For **every** token class (input, output, cache read, each cache-write TTL, and any
   multiplier), the mechanism's rate ≥ the toolkit's rate. Recorded-run aggregates are a spot check, not the
   criterion.
4. **Settle accuracy, against the proxy, not the CLI; one-sided and scenario-scoped** (reconciled, N2). With Σ
   proxy-recorded billed usage priced by the toolkit table keyed on the canonical model:
   - **bound:** charged ≥ Σ proxy-billed in **all three** criterion-6 scenarios, including forward-then-drop;
   - **accuracy:** charged ≤ 1.01 × Σ proxy-billed on the **baseline** scenario only.

   A two-sided 1% match cannot hold under forward-then-drop, because the CLI never receives the dropped
   response's usage; the §2.2 step 8 `failedAttemptsObserved` term is what makes the one-sided bound hold.
   **Cross-invocation leg:** K forward-then-drop invocations in one governed run → the final ledger `S ≥` Σ
   proxy-billed.

5. **No parallel requests** inside one invocation, unless a declared per-kind bound covers them (closed tool
   surface: no subagent or Task tools).
6. **Proxy-observed gating.** Through a recording, fault-injecting HTTPS proxy (`ANTHROPIC_BASE_URL`-style;
   forwards to the provider; records each request's start time, `max_tokens`, and billed usage), the leg asserts:
   - (i) no request **starts** after proxy-cumulative spend ≥ `c`, except requests of an enumerated kind that
     carries a declared per-kind bound;
   - (ii) proxy-cumulative spend ≤ `c + overshootUsd`.

   It runs three forced scenarios:
   - the baseline, with its auxiliary call (RS-1b shows one per run);
   - a forced compaction, or compaction pinned off (`DISABLE_AUTO_COMPACT`) with the pin asserted by the proxy;
   - forward-then-drop: the provider bills, the proxy severs the response, and the CLI retries.

   **`overshootUsd` is additive:**
   `overshootUsd = W_max(main) + Σ_k W_max(aux_k not shown gated) + R_max × W_max(main)`, where the last term
   applies when billed-then-failed attempts are not counted by the mechanism. `R_max` is the demonstrated or
   pinned retry ceiling (`CLAUDE_CODE_MAX_RETRIES`, pin asserted by the proxy).
   - ai-sdk: the guard sits under the retry loop and counts `W_step` per failed attempt, or runs with
     `maxRetries: 0`.

   **The leg spec must pin these before it can be written (critic r2 m-e):**
   - (i) **request-kind classification:** the proxy's classifier inputs for main / aux / compaction / retry
     (for example model id, a body hash equal to an earlier request's, system-prompt markers). An unclassifiable
     request counts as main;
   - (ii) **forward-then-drop drains upstream:** the proxy reads the upstream response to completion (recording
     billed usage) before severing downstream;
   - (iii) **configuration parity:** the leg proves the CLI's behaviour with `ANTHROPIC_BASE_URL` set, so either
     production runs with the same setting (for example through the recording proxy, which would also give the
     step-8 charge a direct source), or the leg shows the setting doesn't change the request mix;
   - (iv) **scenario parameters:** the cap placement per scenario (for example, drop the request that crosses
     `c`).

Anything else is ADVISORY. Unknown pricing, or `limitsKnown: false` on the provider profile, means ADVISORY.
**At `5e52707`, every lane is ADVISORY.**

The classification table is data in `src/kernel/lanes.ts`, versioned with the proxy evidence that justifies each
HARD row. First candidate: `subprocess` + an anthropic model, after W2.1 **and** W3.5.

- W3.5 is **upgraded to a W2 blocker** by this ADR: it blocks **W2.1 settlement** and the **HARD flip** (slice 4).
  The price table must resolve served dated ids to canonical ids (`modelUsage[*].canonicalModel` on the CLI
  lanes), reading the served→requested remaps from `ServedModelPolicy.aliases` (ADR-0002 §2.6; RS-14's
  `servedAliases` populate its built-in layer). An unknown canonical model is ADVISORY and never priced 0.
- **Candidate model:** Haiku 4.5's published retirement is "not sooner than 2026-10-15". The first HARD row should
  be demonstrated on a model whose retirement falls after the v1.1 soak window. The model choice is recorded as an
  owner input at G1.

### 2.5 Crash, resume, lock, and ungoverned runs

- **Write-ahead:** `reservation-opened` is durable before dispatch; `reservation-settled` is durable before the
  op sees the result.
- **Resume fold:** `S = Σ charged(settled) + Σ r(unresolved)` over every prior run of the plan, in `seq` order
  (journal annex §3).
- **Quarantine:** a job with an unresolved reservation is quarantined:
  - it is not dispatched;
  - its report row is `needs-human`;
  - its dependents are blocked;
  - it is re-attested each run until released by an explicit per-call opt-in, which never refunds.
- **Zombies:**
  - A slot is freed only when the op promise settles.
  - At run end, zombies past `zombieGraceMs` are written `reservation-abandoned` (charged `r`) and quarantined.
  - An abandoned reservation is closed. A late return is never journalled, and nothing is appended after
    `run-finished`.
- **Plan lock (r1 socket liveness; rendezvous re-anchored at G1 reconciliation, critic r2 N1).**
  - **Why r1's rendezvous failed.** r1 derived the socket path under `os.tmpdir()`, which reads `$TMPDIR`. Two
    contenders launched from different contexts (an interactive shell vs launchd/cron/paseo, `sudo`, a sandbox
    that remaps tmp, two containers sharing one journal dir) derived different paths, each `listen()`ed on its
    own, and each passed its own inode fence forever: two ledgers, ≈ 2C. Acquire also never read the record file.
  - **The journal dir is the rendezvous.** The lock record `<journalDir>/<planId>.lock.json` is the one object
    every contender agrees on. It is created with `open(…, 'wx')` and carries
    `{nonce, socketPath, pid, host, bootId, runId}`. The socket stays, **as a liveness signal only**; its path is
    whatever the holder chose (short enough for `sun_path`) and is read from the record, never derived locally.
  - **Acquire:**
    1. `open(record, 'wx')` succeeds → write the record (fsync), `listen(socketPath)`. Held.
    2. `EEXIST` → read the record. **First, the host check:** `host` differs from this host → refuse, unless the
       caller passes the journalled break-lock opt-in `budget.breakLock=<runId>` (for a hostname change, e.g. macOS
       `*.local` vs a DHCP name, or a dead foreign host). A foreign holder's pid and boot id mean nothing here, so
       this precedes every liveness test. Governed runs over a journal dir shared live across hosts (network FS)
       stay unsupported. Same host → probe the holder at the **recorded** `socketPath`:
       - `connect` succeeds, or fails `EAGAIN` (a full AF_UNIX backlog on Linux) → **alive** → refuse
         (`plan locked by <runId>`);
       - `connect` fails `ENOENT`/`ECONNREFUSED` → **dead only if** `kill(recordedPid, 0)` also fails `ESRCH`
         with `bootId` equal to this boot's; a different `bootId` means dead. Otherwise alive → refuse.
         On macOS a SIGSTOPped holder's backlog fills at `kern.ipc.somaxconn = 128`, after which `connect`
         returns `ECONNREFUSED` exactly as for a dead one (critic r2, live on this host), so the connect probe
         alone cannot declare death. PID reuse can only make a dead holder look _alive_, the safe direction; r1
         rejected pid checks as the _sole_ test, not as a confirming one.
    3. Dead holder (or a break-lock) → **steal** by writing a fresh record to a temp name in the journal dir and
       atomically `rename()`-ing it over the old record. Then `listen` on the new socket path.
    4. A record that is empty or unparseable (a contender between another's `'wx'` create and its write) has no
       specified handling yet (open point O-8); the fence keeps the bound either way.
  - **Fence:** ownership = **the record at `<journalDir>/<planId>.lock.json` still carries our `nonce`** (read
    back; equivalently, its inode is the one we renamed or created). It is checked after acquire, before the fold,
    and **after every `reservation-opened` fdatasync, before dispatch** (§2.2 step 6).
  - **Why double admission is impossible.** The record path names exactly one owner at any instant, whatever the
    contenders' environments. A process dispatches only after its own fence check, which happens after its
    reservation is durable. So any rival that replaced the record either folded that reservation (it was durable
    before the fence) or caused the fence to fail (no dispatch). In both cases the reservation is inside `S`.
    Safety rests on the fence; the liveness probe is an availability concern only.
  - **Paused holders (claim corrected).** r1 said "a paused holder is never declared dead"; with a connect-only
    probe that was false past 128 probes on macOS. With the two-check rule, a paused same-boot holder is alive
    (its pid exists) and is not stolen from. Should a holder nonetheless lose the record (e.g. an operator
    break-lock), it finds out at its next fence → a `lock-lost` trip.
  - **A12 lock variants** (regression tests, P3):
    - SIGSTOP P1 past any timeout, then **more than `somaxconn` probes**, start P2 → P2 is refused;
    - SIGKILL P1, start P2 → P2 acquires and folds P1's unresolved reservations as `r`. Combined spend ≤ C;
    - **two contenders with different `TMPDIR`**, and **a contender with no `TMPDIR`** → exactly one holds;
    - racing stealers → exactly one passes the fence, and the `seq` values stay unique (journal annex §2).
  - **Other users of the primitive.** The approval nonce ledger's lock anchors its record **beside the ledger
    file** (the shared state is the rendezvous, as here). The per-workspace mutation lock (token annex §4c) needs
    the same split-brain-proof anchor; where its record lives is open (O-5).
- **Ungoverned over governed:** refused unless `optIn: budget.ungovernedOverGoverned`. When opted in:
  - the run takes the plan lock and honours quarantine;
  - it writes **no** reservation events (the gate is a pass-through);
  - `run-started.ungoverned = {optIn: true}`, and its dispatches are outside the bound (§2.3 precondition 3);
  - a later governed resume emits a `cq:` notice naming the excluded runs.
- **Durability:** the journal dir is fsync'd on run-file creation. macOS `F_FULLFSYNC` is a recorded residual
  for power loss only.

### 2.6 Provider limits (D5): interface only

```
ProviderProfile { id; accounting: 'modeled-usd'|'quota'; limitsKnown;
                  consult(req, now) → admit|defer|refuse; observe?(settled) }
```

- It is consulted after the modeled check.
- A `defer` beyond `maxDeferMs` (blank 0) ends the run with the jobs `queued` and an `admission-deferred` event.
- It also carries the published per-model limits used by §2.4 criterion 2, when the provider exposes them.
- **Admission against observed limits (aligned with RS-14 at reconciliation).** The profile's `observe(settled)`
  receives each `reservation-settled` (§2.2 step 9), which carries the seam's structured limit observations
  (ADR-0002 §2.2): `errorClass` `rate-limit` / `quota`, and `providerSignals` `{retryAfterMs, windows[{id,
utilization, remaining, resetAt}]}`, several windows live at once (e.g. the Claude subscription's 5h and 7d).
  `consult` then decides per RS-14 §4:
  - after a `rate-limit`: `defer` for `retryAfterMs` (within `maxDeferMs`, else the run ends `deferred`);
  - after a `quota`: `defer` until the relevant window's `resetAt` (within `maxDeferMs`); without an extractable
    reset, `refuse` (the run ends `provider`; the rows need a human);
  - `accounting: 'quota'` profiles (claude-subscription, zai-glm-coding, codex-chatgpt, opencode-go) also admit
    against window utilization where observable; where it is not (zai: console-only; codex: interactive TUI only)
    the profile models burn locally and quota-aware admission is **ADVISORY** (RS-14 §6).
    These are consult _policy_ inputs. None of them changes the USD bound (§2.3), which rests on modeled spend.
- Contents: Slot C, now answered by RS-14 (below).

### 2.7 Human-approval token

- An op registry entry MAY declare `approval?: { required(input): boolean; state(input): Promise<ApprovalState> }`.
- For such jobs the kernel requires a valid **Ed25519-signed approval token**, supplied out of band:
  - its subject is `(op, planId, jobId, inputsHash)`;
  - its **mandatory** state is `{workspace realpath, git headSha, clean tree}` for mutating ops.
- **Admission** (job gate) verifies the signature, claim and subject against a **run-start snapshot** of the
  signer list and consumed-nonce ledger. Unreadable → fail closed. Without a valid token: `needs-human`, and the
  job is not dispatched.
- **Exercise** (r1): the nonce is **not** consumed at op start. The engine primitive calls `exerciseGrant(grant)`
  immediately before its **first write**, under the per-`realpath(workspace)` mutation lock. That call:
  1. re-computes and matches the state;
  2. checks the nonce against snapshot ∪ in-run consumed ∪ a fresh ledger read;
  3. appends the nonce to the operator ledger, durably;
  4. appends `approval-consumed` to the journal, durably;
  5. returns.

  So check and use are atomic with the write **between approval-gated exercisers**, and every pre-write refusal is
  non-burning.

- **Remaining TOCTOU (critic r2 m-c, reconciliation).**
  - Only `exerciseGrant` takes the mutation lock. A concurrent non-approval job on the same workspace (in this run,
    or from another plan), or a human, can still change HEAD or the tree between the step-1 re-check and the end
    of the write. The closing rule is open (O-6): either the runner never co-schedules another job whose
    `WorkspaceBinding` has the same realpath while an approval job holds the lock, or every workspace-mutating job
    takes the lock (shared/exclusive). Either way, the §7 annex test gains a **during-write** variant.
  - **Nested grants:** `playbookDispatch`'s child applies do not receive the raw grant (exercising it twice throws,
    and the lock is not re-entrant). Inside its single `exerciseGrant`, the parent passes children an in-lock
    **`ExercisedScope`** capability, which the engine primitives accept in place of a grant (token annex §6).
- **Threat-model scope (r1, honest).**
  - Approval integrity against _workers_ holds when workers are sandboxed (`CQ_SANDBOX=required`), or when signers
    and ledger come from the CI trusted layer.
  - Under `CQ_SANDBOX=off` (the `solo-maintainer` profile), a worker's allowlisted command runs as the operator's
    uid and can write the local signer list and ledger. The run-start snapshot stops _in-run_ tampering; nothing
    stops _cross-run_ tampering on that host.
  - Therefore: **unattended runs with `CQ_SANDBOX=off` refuse approval-required jobs** (`needs-human`) unless
    `attended: true`. The residual is recorded for the owner at G1 next to the §14 sandbox-off residual.
  - **`attended` is operator-declared and unverified** (a bare flag, correctly, per P8). Setting it for unattended
    automation, e.g. an agent fleet composing the `cq` command line, removes this guard (critic r2 m-k).
- Spec: annex `adr-0003-approval-token.md`.

### 2.8 Journal v2

- `run-started.journalVersion: 2` and `run-started.seq`. The fold orders on `seq`; `at` is for display only.
- **`seq` is claimed, not just computed (critic r2 m-b).** Racing stealers can each fold before the other's
  `run-started` lands and compute the same `seq`; the fence stops the loser from dispatching, but the reader's
  "duplicate `seq` = corrupt" rule would then brick the plan's journal on every later fold. So `seq = n` is
  assigned by exclusive create of `<journalDir>/<planId>.seq.<n>` (`'wx'`), retrying `n + 1` on `EEXIST`. The
  uniqueness invariant then holds by construction.
- New events: `reservation-opened|settled|refused|abandoned`, `budget-tripped`, `admission-deferred`,
  `job-quarantined`, `quarantine-released`, `approval-consumed`.
- `job-finished` gains `costUSD?`, `charged?` and a specified `usage?`.
- `reservation-settled` carries the result's `errorClass?`, `providerSignals?` and `failedAttemptsObserved?`
  (§2.2 steps 8–9). This is the structured class channel ADR-0002 §2.7 relies on.
- v1 journals replay unchanged. A governed resume over v1 dispatches refuses unless `legacyJournal=reset`. The
  reset is **sticky**: honoured on later resumes for the same v1 file set.
- Spec: annex `adr-0003-journal-migration.md`.

### 2.9 Report and CLI contracts that replace `withBudgetStop`

- **Budget-caused re-marking** (I9, was `governor.ts:1502-1560`):
  - `runPlan` re-marks a `blocked`/`queued` row as `budget-exhausted` iff its non-dispatch is transitively caused
    by a `reservation-refused` (except `advisory-*`, which stays `budget-exhausted` on the job itself), a trip, or
    a `deferred` stop. The walk is memoized over the dependency DAG, as today.
  - Causes are read from the run's own events, never from marker strings.
  - Quarantine rows stay `needs-human`.
- **`report.costUSD = Σ chargedUsd`** over the run's reservations: the ledger truth, which is ≥ modeled cost when
  any reservation was full-charged. This is what `ReviewLoopOutcome.fixReport` and `SelfMergePrsResult.report`
  consume. `report.usage` = Σ settled usage over reservations whose basis ≠ `full`.
- **Exit codes** (`cli/exit.ts`; the header's "`budget` is the only value" is rewritten):

  | `earlyStopReason`                                        | Exit                                                                                                           |
  | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
  | `budget`, `stalled`, `deferred`, `lock-lost`, `provider` | **3** (needs a human, or retry later)                                                                          |
  | `signal`                                                 | **130** for SIGINT, **143** for SIGTERM (shell convention); **3** for an SDK-supplied signal with no OS signal |

  Row-based mapping is unchanged. **Kernel refusals (reconciled, critic r2 m-a):**
  - the **lock refusal** (`plan locked by <runId>`) is **transient** → **3** ("retry later"). Automation treats 2
    as a permanent usage error and would never retry it;
  - the v1-journal refusal and the ungoverned-over-governed refusal are a missing `--opt-in`, which is
    arg-shaped → **2**, mapped from a **typed error class** the CLI catches, never by message matching. That
    keeps `cli/exit.ts:5-15`'s rule that 2 is never derived from a _taxonomy value_.
  - **Contract widening, recorded:** the documented exit contract grows from four codes `{0,1,2,3}` to six (adding
    130/143), and `exitCodeForRunReport`'s return type widens from `0|1|3`. The `cli/exit.ts` header is rewritten
    accordingly.

## 3. Consequences

**Good.**

- One writer of spend.
- Resume keeps the budget.
- HARD lanes bound total modeled USD by `C_max` under three enforced preconditions, within one journal dir
  (§2.3), including against orphaned children, paused same-boot lock holders, and contenders launched with
  different `$TMPDIR` (§2.5, reconciled).
- Four compositions, `withBudgetStop`, the heuristic job keys and the marker parsing go.
- Approval stops being attacker-writable plan data. Its check and use are atomic with the write.

**Costs.**

- HARD is expensive. `W_max` from published limits:
  - Haiku 4.5: 200K context, 64K max output, 1h write $2/MTok, output $5/MTok → **$0.72** per request.
  - A 1M-context/128K-output model at $4 (1h write) and $10 (output) per MTok → **≈ $5.28**.
  - The additive aux and retry terms raise the floor further. With the CLI's **unpinned** retry ceiling the floor
    is `(1 + R_max) × W_max` for the retry term alone, several dollars per Haiku invocation, and the settle-side
    `failedAttemptsObserved` term (§2.2 step 8) charges each observed retry `W_max`. In practice, **pinning
    `CLAUDE_CODE_MAX_RETRIES` (proxy-asserted) is a HARD precondition for small caps** (critic r2 N2). The CLI's
    default ceiling was not found in the bundle, so this is stated qualitatively.
  - Small caps can't run HARD at useful concurrency. The concurrency floor check refuses them loudly.
- An op's small `maxUsd` is sized **up** to `floor` on HARD lanes (`sizedUp`), so it is not honoured tighter than
  the worst case.
- `Budget.maxUsd` becomes live for ungoverned SDK callers after W2.1.
- Process-lane aborts are charged `r`. D5's abort-on-trip burns those reservations.
- Two fdatasyncs per invocation, plus a `stat` fence.
- Quarantine needs a human.
- Approval tokens are single-use and consumed at write.
- Unattended sandbox-off runs can't run approval jobs.
- Until W2.1 + W3.5 and a lane's proxy leg pass, **every unattended governed run is refused** without
  `--allow-advisory-budget`.

**Not changed.** ADR-0002's seam (`Driver.run`, `WorkerResult`, `DriverStopReason`, the factory surface); the Op
contract; replay's skip rule.

## 4. Landing (slices; details in design note §5)

1. Journal v2 (+`seq` claimed by exclusive create), fdatasync, the plan lock (journal-dir record rendezvous, socket
   - pid/bootId liveness, record-nonce fence, break-lock opt-in), `allSettled`/stop-on-emit.
2. `runPlan` governance param, `runGoverned`, job gate, invocation gate in shadow mode.
3. Drivers (W2.1) + pricing normaliser (W3.5, now a W2 blocker): native caps, `modelUsage`/`canonicalModel`
   settlement, the ai-sdk pre-request guard, pinned env (`CLAUDE_CODE_MAX_RETRIES`, output cap, compaction), and
   the recording proxy harness.
4. Flip to ledger authority. Delete per design note §5.1: compositions, `withBudgetStop`, `report*`, barrel
   exports, the smoke script and fixture op, docs. Re-marking, `costUSD` and exit codes move per §2.9. ADVISORY
   refusal and quarantine go live.
5. **cq-fixtures migration (slice F)** (pinned-SHA bump): `runner/index.ts:326-397` and `runner/budget.ts` onto a
   governed scope meeting the six §2.1 requirements. The shape (a real `runGoverned` contract vs porting onto
   `runPlan`) is open (O-3). This is a precondition for W6.4's USD ceiling (D10).
6. Approval token (W4.3): exercise-at-write, workspace mutation lock.
7. Per-lane HARD rows switched on as their proxy legs pass.

A12 (including the SIGSTOP/SIGKILL lock variant), A12b, A12c, A16 and A18 become regression tests (P3).

## 5. Alternatives rejected

Design note §4, plus r1:

- mtime-staleness locks (M2);
- pid-liveness locks: pid reuse, and a record file doesn't prove the pid is ours;
- ungoverned pass-through journalling (M3 alternative: contradicts write-ahead);
- auto-reducing concurrency under a small cap (a hidden throughput change; P8 prefers a loud refusal);
- consuming approval at op start (M5);
- (reconciliation) a socket path derived from the process environment (`os.tmpdir()`): it splits the rendezvous
  across `$TMPDIR` contexts (critic r2 N1);
- (reconciliation) `ECONNREFUSED` alone as the death test: ambiguous for a SIGSTOPped holder on macOS once
  `somaxconn` connections are queued (critic r2 N1);
- (reconciliation) the reservation as a `Budget` field excluded by `OpInvocationData`: that projection no longer
  exists (ADR-0002 critic r2 N2).

## 6. G1 decision points and plan deltas (reconciliation)

**Owner decision, stated and not taken here** (critic r2: "If the owner accepts the ADR with N1–N3 carried as
binding W2 acceptance criteria, that is a defensible G1 outcome"):

- **(a)** accept at G1 with this reconciliation, the open points below carried as binding W2 acceptance criteria;
  or
- **(b)** hold G1 sign-off until slice F (O-3) is designed and the reconciled text has had a further critic round.

N1 and N2 are folded into the text (§2.5; §2.2 step 8 and §2.4 criterion 4). N3 is folded as requirements (§2.1),
and its shape is O-3.

**Open points** (reconciliation log): O-3 slice-F shape; O-4 ADVISORY sizing; O-5 the workspace mutation lock's
record anchor; O-6 the approval TOCTOU closing rule; O-8 a half-written lock record. **Owner inputs already recorded:** the first HARD row's
model (Haiku 4.5 retires no sooner than 2026-10-15, §2.4); the fixer lane and model DoD 3 will use (below).

**Plan deltas the overseer carries** (critic r2 m-f; this ADR does not edit the plan):

- **W3.5:** a W2 blocker. It blocks W2.1 settlement and the HARD flip, and reads ADR-0002's
  `ServedModelPolicy.aliases`. §16.5's serial chain: W2.2/2.3/3.3 stay in one Opus lane; W3.5 (S, non-[O]) runs in
  parallel but lands first.
- **W2.4:** "per-plan lockfile; ordering by `run-started.at`" → the §2.5 journal-dir lock record with socket +
  pid/bootId liveness, and `seq` ordering (§2.8).
- **W6.4:** blocks on **slice F** (§4 slice 5), which follows the W2.2b/2.3 flip. That moves D10's unpause behind
  the W2 flip.
- **Fixtures matrix is ADVISORY in practice:** it is token-capped (`perSuiteTokenCap`), tokens are ADVISORY
  everywhere, and acp is ADVISORY for all of v1.1. The unattended matrix needs `allowAdvisory`, and W6.4's "USD
  ceiling" is an ADVISORY ceiling, not a DoD 2 bound.
- **DoD 3** requires "a HARD fixer lane". ADR-0002's default fixer binding is ai-sdk (HARD path pending the
  proxy leg; RS-14 has now shown `max_tokens` honoured on the zai and deepseek wires), and the subprocess/Haiku
  candidate retires on or after 2026-10-15. **Owner input:** name the fixer lane and model DoD 3 will use.
- DoD 2's bound is consistent: `≤ C_max` is stronger than DoD 2's `cap + Σ in-flight reservations`, with
  `C_max = cap` absent `raiseCap`.

## Slot C — provider-profile contents (RS-14)

Windows, RPM/TPM, peak multipliers, native account caps, remaining-quota observation, the lane→`errorClass`
mapping, **and the per-model published limits** (`max_input_tokens`, `max_tokens`) for §2.4 criterion 2.

**Filled by RS-14** (`research/rs14-provider-limits` @ `ab671be`, §3 schema, §6 Decision), folded by reference at
G1 reconciliation: `ProviderProfile` = the §2.6 interface plus `cap{kind, amount, settableVia, enforcedAs}`,
`quota{windows[], peak, burnModel}`, `observability{channel, headers, usageEndpoint}`, `rateLimitHeaders[]` and
`modelLimits{max_input_tokens, max_output_tokens, rpm/itpm/otpm, servedAliases[]}`.

- `accounting: 'quota'` for claude-subscription / zai-glm-coding / codex-chatgpt / opencode-go; `modeled-usd` for
  anthropic-api / deepseek / openai-api.
- `modelLimits[*].servedAliases` feeds the **built-in layer of ADR-0002's `ServedModelPolicy.aliases`**; it is not a
  second alias table (ADR-0002 §2.6).
- The lane → `errorClass` map is ADR-0002 migration checklist §3 (RS-14 §4 verbatim).
- RS-14's evidence closes one open input of §2.4 criterion 2: `max_tokens` is honoured live by the zai coding and
  deepseek wires, and the claude CLI pins `max_tokens: 32000` on Haiku 4.5 (a demonstrated pin, usable in
  `W_max` once the proxy leg asserts it).
- Config key names stay with RS-15 (Slot D).

## Slot D — configuration keys (RS-15)

- `CQ_BUDGET_ALLOW_ADVISORY` (blank `false`)
- `CQ_BUDGET_REQUIRE_CAP` (blank `true`)
- `CQ_BUDGET_MIN_INNER_USD` (`c_min`; blank `0.01`)
- `CQ_BUDGET_MAX_DEFER_MS` (blank `0`)
- `CQ_BUDGET_ZOMBIE_GRACE_MS`
- `CQ_BUDGET_INVOCATION_USD` (default proposal)
- `CQ_APPROVAL_SIGNERS`
- `CQ_APPROVAL_MAX_TTL_MS` (blank 24 h)
- `CQ_APPROVAL_LEDGER`
- Per-call opt-ins only: `budget.legacyJournal=reset`, `budget.raiseCap`, `budget.ungovernedOverGoverned`,
  `budget.breakLock=<runId>` (G1 reconciliation, §2.5)
- Attended: a flag only

All follow P7 precedence and P8 blank = conservative.
