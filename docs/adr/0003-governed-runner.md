# ADR-0003 — Governed runner, budgets as ceilings, human-approval token

- **Status:** accepted (G1, 2026-09-26)
- **Date:** 2026-09-25
- **Amends / Related:** amends [ADR-0001](0001-worker-driver-seam.md) (the frozen `runPlan`, `RunOptions` and
  journal schema); paired with [ADR-0002](0002-worker-driver-seam-v2.md). Together they are the single P2 thaw: one
  types bump, `SEAM_VERSION = 2`.
- **Annexes:** [approval token](0003-approval-token.md), [journal v2](0003-journal-migration.md).

Post-acceptance notes N1, N6, N11 and N13 in the [ADR index](README.md#post-acceptance-notes) narrow parts of this record.

## 1. Context

v1 retrofitted budget governance onto a frozen runner. Spend is op-reported and opt-in, usage is never journalled,
caps gate admission only, attempts are keyed heuristically, the kill rung frees the slot, there are **four**
hand-copied compositions (three in the toolkit, one in the cq-fixtures runner), and there is no journal lock.

D5 decides: ceilings are in modeled API-equivalent units; admission is reserve-then-settle; reservations are
write-ahead; an unresolved reservation is charged in full and its job quarantined on resume; a trip aborts in-flight
work; every lane is ADVISORY until proven HARD.

Separately, approval is a plan-data boolean (`approved: true`) that any plan author can write. It has to stop being
plan data.

The only native cap in evidence is the claude CLI's `--max-budget-usd`, a per-invocation between-request check.
Static inspection of the CLI 2.1.280 bundle, plus the Anthropic model and pricing docs, shows two faults on the
toolkit's current settlement path:

- It settles from `result.usage`, a **lagging, main-loop-only prefix sum** (requests 1…n−1, missing the final
  request and every auxiliary request).
- It prices the **served dated id** (`claude-haiku-4-5-20251001`), which misses the exact-key price table, so the
  lane produces **no cost at all**.

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
                                      // | 'budget.breakLock=<runId>' (§2.5)
}
export function runPlan(plan: Plan, opts: RunOptions, registry: OpRegistryView, gov?: Governance): Promise<RunReport>;

/** Governed scope for callers that dispatch drivers outside a plan (cq-fixtures' eval runner).
 *  Placeholder signature only: its contract is open (O-3, below). */
export function runGoverned<T>(gov: Governance, scope: { planId: string; jobId: string; journalDir?: string },
                               fn: () => Promise<T>): Promise<T>;
```

- `opts.maxUsd` or `opts.maxTokens` without `gov` **throws** `runPlan: caps require governance`.
- A run over a journal dir whose plan history contains a governed v2 run **must be governed**, or it throws unless
  `optIn` names `budget.ungovernedOverGoverned`. A run with a `journalDir` holds the **plan lock** throughout (§2.5).
- The runner owns job identity (`job.id`) and real attempt numbers:
  `attempt = 1 + |prior job-started(job.id)|` across the folded runs.
- **`runPlan` takes over both of `withBudgetStop`'s duties** (re-marking and `report.costUSD`, §2.9).
  `governRegistry`, `withBudgetStop`, `seedFromRunLog`, `JobGovernance.report*` and the three toolkit compositions
  are **deleted, with no shims**; cq-fixtures (vendored, pinned by SHA per P2) migrates in the same thaw (§4 slice 5).
- The kernel exposes `invokeOp(op, input, registry, gov?)` (W3.2) through the same job gate.

**`runGoverned` (slice F) is not yet designed (open point O-3).** As written, the signature governs nothing for its
only consumer: cq-fixtures constructs its lanes directly, so the factory gate (§2.2) never sees them and fails open
silently; it has per-case jobs, attempts and budgets (W6.2) but one scope has one `jobId`; it writes its own
v1-shaped journal; its preflight acp probe spends outside `Driver.run`; and `fn` gets no signal and returns no
report. Whatever slice F becomes, it MUST meet these requirements (binding W2 acceptance criteria):

1. **Run lifecycle:** one governed run per call (plan lock, `run-started` v2 with `seq`, fold, `run-finished`).
2. **Per-job scopes:** real attempts and quarantine per case.
3. **Journal ownership:** the caller stops writing its own `run-started`/`run-finished` for that plan id, or uses a
   separate plan id.
4. **Signal and report:** the caller gets the trip-aware signal and the governed factory, and the run report (cost
   and absence columns, W6.2) back.
5. **No unwrapped drivers:** every dispatched driver comes from the governed factory; a fixtures test asserts exactly
   one `reservation-opened` per dispatched case.
6. **The probe:** routed through the gate, or declared an excluded, journalled spend.

Candidates: (i) a real `runGoverned` contract (`scope.job(jobId, fn)`, `fn` receiving `{signal, factory}`,
returning `{value, report}`); or (ii) port fixtures onto `runPlan` (its suite already is a job list) and drop
`runGoverned` from the public surface until a second consumer exists. W6.4's USD ceiling waits on this choice.

### 2.2 Invocation gate: one reservation = one `Driver.run`

`governDriverFactory(factory)` lives in `src/kernel/governed-driver.ts`; registry importers bind
`governDriverFactory(createDriverFactory(cfg))`. Outside a governed job context (no `runPlan`/`runGoverned` scope)
it is a pass-through that **writes nothing**. Inside one, each `run(inv, options?)` does the following:

1. **Identify the priced model.** Classification and sizing use **`inv.modelSpec`**; if, after normalisation (the
   deprecated `provider:'ai-sdk'` alias resolved, ADR-0002 §2.5), it differs from the producing
   `ResolvedDriver.modelSpec`, the gate **throws pre-dispatch** (`errorClassOf → 'config'`). `W_max` and the rate
   table are the **maximum over `inv.modelSpec.model` and every served-model alias** in `ServedModelPolicy.aliases`
   (ADR-0002 §2.6). A lane configured `requireObserved: false` can serve any model unobserved, so it is
   **ADVISORY** for USD.
2. **Classify** `(lane, provider, model)` → `hard | advisory` per configured dimension (§2.4).
   ADVISORY + unattended + no `allowAdvisory` → refuse: `{stopReason:'budget', usage: zero}` plus
   `reservation-refused{reason:'advisory-lane'|'advisory-dimension'}`. Nothing is dispatched.
3. **Size.** Let `floor = overshootUsd(lane, model) + c_min`, with `c_min > 0` (config, blank $0.01).
   - **Concurrency floor check, the first time a class is seen in the run:** if `C < concurrency × floor`, the gate
     refuses (`reservation-refused{reason:'cap-below-concurrency-floor'}`) and **trips** (`exhausted`) with a
     config hint: lower `concurrency` or raise the cap. Concurrency is never lowered silently.
   - The proposal is `p = inv.budget.maxUsd ?? C / concurrency`, and **`r = max(p, floor)`**; when `p < floor` the
     reservation is sized up and journalled `sizedUp: true`. If `C − S < floor`, it is an `exhausted` trip.
   - If `r > C − S − O`: with `O > 0`, wait FIFO for a settle; with `O = 0`, shrink to `r = C − S` (≥ floor). Any
     trip wakes and refuses every waiter (`tripped`). If only zombie reservations hold `O`, the run ends `stalled`.
   - **Invariant:** the inner cap `c = r − overshootUsd ≥ c_min > 0`; the gate never passes `c ≤ 0` to a lane.
4. **Consult** the provider profile (§2.6): admit, defer, or refuse, using the limit observations recorded on
   earlier settles (step 9).
5. **Write ahead:** append `reservation-opened` and **fdatasync** it.
6. **Fence:** re-verify plan-lock ownership (§2.5). If it has been lost, do **not** dispatch. The opened record
   stays unresolved and is charged `r` on the next fold.
7. **Dispatch through `RunOptions`** (ADR-0002 §2.1). The signal and the reservation are runtime-only and never ride
   the invocation:
   ```ts
   driver.run(
     { ...inv, budget: { ...inv.budget, maxUsd: c } },
     { signal: AbortSignal.any([options?.signal, jobSignal, tripSignal]
                                 .filter((s): s is AbortSignal => s !== undefined)), reservation },
   )
   ```
8. **Charge:**
   - when the lane's report is authoritative for that exit path,
     `charged = modeled(reported) + W_max(main) × failedAttemptsObserved` (0 on a lane whose mechanism counts
     billed-then-failed attempts itself). On subprocess it is the count of stream-json `system`/`api_retry` frames
     (not yet captured live, a W2.1 evidence item); on claude-agent the same frame if
     the SDK surfaces it, otherwise `R_max`. With `CLAUDE_CODE_MAX_RETRIES=0` pinned and proxy-asserted, the term is
     0 on success and an `error` exit after a transport failure is charged `r`. ai-sdk is unchanged (`W_step` per
     failed attempt, or `maxRetries: 0`);
   - `min(r, observed + W_step × (1 + failedAttempts))` for an in-process abort;
   - `r` for a process-lane abort, an unreturned invocation, or **any throw whose `errorClassOf` is not
     `config`/`auth`** (a seam violation of unknown dispatch status, plus a `breach`-class diagnostic);
   - `0` only for a `config`/`auth` pre-dispatch throw or a pre-aborted signal.
9. **Settle:** append `reservation-settled` (fdatasync) and update the ledger. `charged > r` → a `breach` trip. The
   settle record carries the result's **`errorClass`, `providerSignals`** and `failedAttemptsObserved`, structured
   (journal annex §2): the channel ADR-0002 §2.7 names for class-aware rescue rows and W2.6 admission. Ops forward
   nothing, and nothing parses `OpResult.error` text.

The gate is the **only** writer of spend.

**The reservation rides `RunOptions`, not `Budget`** (ADR-0002 §2.1/§2.7). The type is plain data in
[src/driver/types.ts](../../src/driver/types.ts), so the driver family needs no kernel import; this ADR owns its
field set:

```ts
export interface BudgetReservation {
  id: string;               // `${runId}:${jobId}:${attempt}:${seq}`
  usd?: number;             // r
  tokens?: number;
  overshootUsd: number;     // additive, per §2.4 criterion 6 (0 = lane pre-checks every request in-process)
  class: 'hard' | 'advisory';   // not `lane`: that name is ResolvedDriver.lane (LaneId)
}
// ADR-0002 §2.1: RunOptions { signal?: AbortSignal | undefined; reservation?: BudgetReservation | undefined }
```

- `Budget` gains no reservation field and `BudgetSchema` is unchanged (optional **cap** fields remain allowed in
  the same bump; none is needed). Being runtime-only, the run-scoped id never enters an invocation or its hash.
- **`Budget.maxUsd` changes meaning.** It was caller-side derived accounting that every lane ignored. After W2.1 it
  is an **enforced inner cap**: HARD lanes MUST enforce it natively in-process (subprocess `--max-budget-usd`,
  claude-agent `maxBudgetUsd`, ai-sdk pre-request guard). It also becomes a live stop for ungoverned SDK callers.
- Drivers MAY ignore `RunOptions.reservation` (ADR-0002 §2.1). That is safe because classification is keyed on
  `ResolvedDriver.lane`, and lane-less drivers are ADVISORY (ADR-0002 §2.5).

### 2.3 Admission, trips, and the bound

- **Admission:** `S + O + r ≤ C` per configured dimension.
- **Token caps are ADVISORY on every lane in v1.1.** An unattended run with `maxTokens` needs `allowAdvisory`.
- **Trip kinds:** `exhausted`, `breach`, `token-cap`, `signal`, `lock-lost`, `provider`.
- **On a trip (D5):** no new reservations; queued jobs are not started; **in-flight invocations are aborted**; slots
  and reservations stay held until each driver returns.
- **Bound (USD).** On HARD lanes, total modeled spend over a plan's governed runs is **≤ C_max**, the largest cap any
  of those runs used. It holds under three enforced preconditions:
  1. **Sizing:** each `r ≥` the invocation's demonstrated worst case (`r ≥ floor`; §2.2 step 3, §2.4).
  2. **One ledger:** exactly one live process admits against a plan's ledger at a time (plan lock plus the
     pre-dispatch fence, §2.5).
  3. **Complete history:** every dispatch over the plan's governed history is write-ahead journalled (the
     governed-only rule). The bound **excludes** v1 runs admitted under `legacyJournal=reset` and runs under
     `ungovernedOverGoverned`; both are named per-call opt-ins, journalled on `run-started`.

  Raising the cap on resume requires `optIn: budget.raiseCap` (P7/P8). Without it, `C_now > C_prev` throws.

  **Scope of the bound.** It covers plans whose **every admitted invocation is HARD**. ADVISORY invocations admitted
  under `allowAdvisory`/`attended` are outside it; their sizing rule (`r`, `c`, whether the concurrency floor check
  applies, whether an expected `charged > r` trips `breach`) is **not yet defined** (open point O-4), and until it
  is, step 9's unconditional `breach` trip applies to them too. It is scoped to **one journal dir**: a run with a
  fresh `--journal-dir`, or none, starts at `S = 0` and does not see quarantine.

- **Early-stop reasons:** `RunEarlyStopReason` widens from `'budget'` to
  `'budget' | 'signal' | 'stalled' | 'deferred' | 'lock-lost' | 'provider'`. `exhausted`/`breach`/`token-cap` trips
  → `budget`; `signal` → `signal`; `lock-lost` → `lock-lost`; profile `refuse` → `provider`, `defer` → `deferred`.

  > Partly in force: only `'budget' | 'signal'`; see post-acceptance note N13 in the
  > [ADR index](README.md#post-acceptance-notes).

### 2.4 Lane classification

A `(lane, provider, model)` is **HARD for USD** only when all of the following are **demonstrated** by a
conformance leg in CI. Legs 2, 3, 4 and 6 run the lane through the **recording proxy** (criterion 6).

1. **In-process mechanism.** A mechanism _inside the invocation's own process tree_ stops further requests once the
   inner cap is reached, so the bound survives an orphaned child after a parent crash.
2. **`W_max` from API-published limits:**
   `W_max = maxInputTokens × maxInputClassRate + maxOutputTokens × outputRate`. Both token limits come from the
   provider's published model limits (Models API `max_input_tokens`/`max_tokens`, or the model card), **never** a
   client default. A lane MAY use a smaller pinned output cap (e.g. `CLAUDE_CODE_MAX_OUTPUT_TOKENS`) only if the proxy
   leg shows **every** request's `max_tokens` ≤ the pin. A context-extending mode (a `[1m]` suffix, a 1M beta) is
   refused unless `W_max` is recomputed for it. Rates include every multiplier the lane can set (data residency 1.1×,
   fast mode, long-context tiers, re-fetched from the pricing page when the row is demonstrated). `maxTurns` and
   post-step stops don't qualify.
3. **Per-rate dominance.** For **every** token class (input, output, cache read, each cache-write TTL, any
   multiplier), the mechanism's rate ≥ the toolkit's rate. Recorded-run aggregates are a spot check only.
4. **Settle accuracy, against the proxy, one-sided.** With Σ proxy-billed usage priced by the toolkit table on the
   canonical model: charged ≥ Σ proxy-billed in **all three** criterion-6 scenarios (the **bound**), and charged ≤
   1.01 × Σ proxy-billed on the **baseline** only (**accuracy**: the CLI never receives a dropped response's usage,
   and the §2.2 step 8 `failedAttemptsObserved` term is what keeps the bound). A cross-invocation leg runs K
   forward-then-drop invocations in one governed run and asserts the final ledger `S ≥` Σ proxy-billed.
5. **No parallel requests** inside one invocation, unless a declared per-kind bound covers them (closed tool
   surface: no subagent or Task tools).
6. **Proxy-observed gating.** Through a recording, fault-injecting HTTPS proxy (`ANTHROPIC_BASE_URL`-style; records
   each request's start time, `max_tokens` and billed usage), the leg asserts (i) no request **starts** after
   proxy-cumulative spend ≥ `c`, except an enumerated kind with a declared per-kind bound; and (ii)
   proxy-cumulative spend ≤ `c + overshootUsd`. It runs three forced scenarios: the baseline with its auxiliary
   call; a forced compaction, or compaction pinned off (`DISABLE_AUTO_COMPACT`, pin asserted by the proxy); and
   forward-then-drop (the provider bills, the proxy severs the response, the CLI retries).

   **`overshootUsd` is additive:**
   `overshootUsd = W_max(main) + Σ_k W_max(aux_k not shown gated) + R_max × W_max(main)`, where the last term applies
   when the mechanism does not count billed-then-failed attempts. `R_max` is the demonstrated or pinned retry
   ceiling (`CLAUDE_CODE_MAX_RETRIES`, pin asserted by the proxy). On ai-sdk the guard sits under the retry loop and
   counts `W_step` per failed attempt, or runs with `maxRetries: 0`.

   **The leg spec must pin:** (i) request-kind classification (an unclassifiable request counts as main); (ii)
   forward-then-drop drains the upstream response before severing downstream; (iii) configuration parity
   (production uses the same `ANTHROPIC_BASE_URL`, or the leg shows it doesn't change the request mix); (iv) the
   cap placement per scenario.

Anything else is ADVISORY. Unknown pricing, or `limitsKnown: false` on the provider profile, means ADVISORY. When
this ADR was drafted, every lane was ADVISORY.

The classification table is data in [src/kernel/lanes.ts](../../src/kernel/lanes.ts), versioned with the proxy
evidence that justifies each HARD row. First candidate: `subprocess` + an anthropic model, after W2.1 **and** W3.5.

**W3.5 is a W2 blocker** for W2.1 settlement and the HARD flip (slice 4): the price table must resolve served dated
ids to canonical ids (`modelUsage[*].canonicalModel` on the CLI lanes), reading the remaps from
`ServedModelPolicy.aliases` (ADR-0002 §2.6). An unknown canonical model is ADVISORY and never priced 0. Haiku 4.5's
published retirement is "not sooner than 2026-10-15", so the first HARD row should be demonstrated on a model that
retires after the v1.1 soak window (an owner input, §6).

### 2.5 Crash, resume, lock, and ungoverned runs

- **Write-ahead:** `reservation-opened` is durable before dispatch; `reservation-settled` is durable before the op
  sees the result. **Resume fold:** `S = Σ charged(settled) + Σ r(unresolved)` over every prior run of the plan, in
  `seq` order (journal annex §3).
- **Quarantine:** a job with an unresolved reservation is not dispatched, its report row is `needs-human`, its
  dependents are blocked, and it is re-attested each run until released by an explicit per-call opt-in, which never
  refunds.
- **Zombies:** a slot is freed only when the op promise settles. At run end, zombies past `zombieGraceMs` are
  written `reservation-abandoned` (charged `r`) and quarantined. An abandoned reservation is closed: a late return
  is never journalled, and nothing is appended after `run-finished`.
- **Plan lock.**
  - **The lock record** `<journalDir>/<planId>.lock.json` is the rendezvous. It is created with `open(…, 'wx')` and
    carries `{nonce, socketPath, pid, host, bootId, runId}`. The socket is **a liveness signal only**; its path is
    read from the record, never derived locally. (A path derived from `os.tmpdir()` reads `$TMPDIR`, so contenders
    from different contexts, such as cron vs a shell, `sudo`, or a sandbox that remaps tmp, would each pass their own
    fence: two ledgers, ≈ 2C.)
  - **Acquire:**
    1. `open(record, 'wx')` succeeds → write the record (fsync), `listen(socketPath)`. Held.
    2. `EEXIST` → read the record. **First, the host check** (a foreign pid and boot id mean nothing): a different
       `host` → refuse, unless the caller passes the journalled break-lock opt-in `budget.breakLock=<runId>` (a
       hostname change or a dead foreign host). Journal dirs shared live across hosts stay unsupported. Same host →
       probe the **recorded** `socketPath`:
       - `connect` succeeds, or fails `EAGAIN` (full AF_UNIX backlog on Linux) → **alive** → refuse
         (`plan locked by <runId>`);
       - `connect` fails `ENOENT`/`ECONNREFUSED` → **dead only if** `kill(recordedPid, 0)` also fails `ESRCH` with
         `bootId` equal to this boot's; a different `bootId` means dead. Otherwise alive → refuse. (A SIGSTOPped
         macOS holder returns `ECONNREFUSED` once `kern.ipc.somaxconn = 128` probes queue; PID reuse can only make a
         dead holder look alive, the safe direction.)
    3. Dead holder (or a break-lock) → **steal** by writing a fresh record to a temp name in the journal dir and
       atomically `rename()`-ing it over the old one, then `listen` on the new socket path.
    4. A record that is empty or unparseable (a contender between another's `'wx'` create and its write) has no
       specified handling yet (open point O-8); the fence keeps the bound either way.
  - **Fence:** ownership = **the record at `<journalDir>/<planId>.lock.json` still carries our `nonce`** (read back;
    equivalently, its inode is the one we created or renamed). It is checked after acquire, before the fold, and
    **after every `reservation-opened` fdatasync, before dispatch** (§2.2 step 6). A rival that replaced the record
    has therefore either folded the reservation or failed our fence, so double admission is impossible. Safety rests
    on the fence; the liveness probe is an availability concern only.
  - **Paused holders:** a paused same-boot holder is alive (its pid exists) and is not stolen from, however many
    probes have queued. A holder that loses the record anyway (e.g. an operator break-lock) finds out at its next
    fence → a `lock-lost` trip.
  - **A12 lock variants** (regression tests, P3): SIGSTOP P1 past any timeout, then **more than `somaxconn`
    probes**, start P2 → P2 is refused. SIGKILL P1, start P2 → P2 acquires and folds P1's unresolved reservations as
    `r`; combined spend ≤ C. **Two contenders with different `TMPDIR`**, and **one with no `TMPDIR`** → exactly one
    holds. Racing stealers → exactly one passes the fence, and `seq` values stay unique (journal annex §2).
  - **Other users of the primitive.** The approval nonce ledger's lock anchors its record **beside the ledger file**.
    The per-workspace mutation lock (approval-token annex §4c) needs the same split-brain-proof anchor; where its
    record lives is open (O-5).

  > O-5 and O-8 are resolved in code, and the `budget.breakLock` opt-in above is not in the kernel union yet: see
  > post-acceptance notes N11 and N13 in the [ADR index](README.md#post-acceptance-notes).

- **Ungoverned over governed:** refused unless `optIn: budget.ungovernedOverGoverned`. When opted in, the run takes
  the plan lock and honours quarantine, writes **no** reservation events, and records
  `run-started.ungoverned = {optIn: true}` (outside the bound, §2.3 precondition 3); a later governed resume emits a
  `cq:` notice naming the excluded runs.
- **Durability:** the journal dir is fsync'd on run-file creation. macOS `F_FULLFSYNC` is a recorded residual for
  power loss only.

### 2.6 Provider limits (D5): interface only

```
ProviderProfile { id; accounting: 'modeled-usd'|'quota'; limitsKnown;
                  consult(req, now) → admit|defer|refuse; observe?(settled) }
```

It is consulted after the modeled check. A `defer` beyond `maxDeferMs` (blank 0) ends the run with the jobs `queued`
and an `admission-deferred` event. It carries the published per-model limits used by §2.4 criterion 2.
`observe(settled)` receives each `reservation-settled` (§2.2 step 9) with the seam's structured limit observations
(ADR-0002 §2.2): `errorClass` `rate-limit` / `quota`, and `providerSignals`
`{retryAfterMs, windows[{id, utilization, remaining, resetAt}]}` (several windows may be live, e.g. 5h and 7d).
`consult` then decides:

- after a `rate-limit`: `defer` for `retryAfterMs` (within `maxDeferMs`, else the run ends `deferred`);
- after a `quota`: `defer` until the relevant window's `resetAt` (within `maxDeferMs`); without an extractable
  reset, `refuse` (the run ends `provider`; the rows need a human);
- `accounting: 'quota'` profiles also admit against window utilization where observable. Where it is not (zai:
  console-only; codex: interactive TUI only) the profile models burn locally and quota-aware admission is
  **ADVISORY**.

None of these changes the USD bound (§2.3), which rests on modeled spend. Profile contents:
[Slot C](#slot-c--provider-profiles).

### 2.7 Human-approval token

- An op registry entry MAY declare `approval?: { required(input): boolean; state(input): Promise<ApprovalState> }`.
  For such jobs the kernel requires a valid **Ed25519-signed approval token**, supplied out of band, whose subject is
  `(op, planId, jobId, inputsHash)` and whose **mandatory** state for mutating ops is
  `{workspace realpath, git headSha, clean tree}`.
- **Admission** (job gate) verifies the signature, claim and subject against a **run-start snapshot** of the signer
  list and consumed-nonce ledger. Unreadable → fail closed. Without a valid token: `needs-human`, and the job is not
  dispatched.
- **Exercise:** the nonce is **not** consumed at op start. The engine primitive calls `exerciseGrant(grant)`
  immediately before its **first write**, under the per-`realpath(workspace)` mutation lock. That call (1)
  re-computes and matches the state, (2) checks the nonce against snapshot ∪ in-run consumed ∪ a fresh ledger read,
  (3) appends the nonce to the operator ledger, durably, (4) appends `approval-consumed` to the journal, durably, and
  (5) returns (approval-token annex §4c). So check and use are atomic with the write **between approval-gated
  exercisers**, and every pre-write refusal is non-burning.

  > Narrowed: see post-acceptance note N6 in the [ADR index](README.md#post-acceptance-notes).

- **Remaining TOCTOU.** Only `exerciseGrant` takes the mutation lock, so a concurrent non-approval job on the same
  workspace (this run or another plan), or a human, can still change HEAD or the tree between the step-1 re-check
  and the end of the write. The closing rule is open (O-6): either the runner never co-schedules another job whose
  `WorkspaceBinding` has the same realpath while an approval job holds the lock, or every workspace-mutating job
  takes the lock (shared/exclusive). Either way, the approval-token annex §7 test gains a **during-write** variant.

  > Open: see post-acceptance note N5 in the [ADR index](README.md#post-acceptance-notes).

- **Nested grants:** `playbookDispatch`'s child applies never receive the raw grant; inside its single
  `exerciseGrant`, the parent passes them an in-lock **`ExercisedScope`** capability (approval-token annex §6).
- **Threat-model scope** (approval-token annex §1): under `CQ_SANDBOX=off` a worker can tamper with the local
  signer list and ledger across runs, so **unattended runs with `CQ_SANDBOX=off` refuse approval-required jobs**
  (`needs-human`) unless `attended: true`, which is operator-declared and unverified (P8).
- Spec: the [approval-token annex](0003-approval-token.md).

### 2.8 Journal v2

- `run-started.journalVersion: 2` and `run-started.seq`. The fold orders on `seq`; `at` is for display only.
- **`seq` is claimed, not just computed:** `seq = n` is assigned by exclusive create of
  `<journalDir>/<planId>.seq.<n>` (`'wx'`), retrying `n + 1` on `EEXIST`. Racing stealers could otherwise compute the
  same `seq`, and the reader's "duplicate `seq` = corrupt" rule would brick the plan's journal.
- New events: `reservation-opened|settled|refused|abandoned`, `budget-tripped`, `admission-deferred`,
  `job-quarantined`, `quarantine-released`, `approval-consumed`. `job-finished` gains `costUSD?`, `charged?` and a
  specified `usage?`; `reservation-settled` carries `errorClass?`, `providerSignals?` and `failedAttemptsObserved?`
  (§2.2 steps 8–9).
- v1 journals replay unchanged. A governed resume over v1 dispatches refuses unless `legacyJournal=reset`. The reset
  is **sticky**: honoured on later resumes for the same v1 file set.
- Spec: the [journal annex](0003-journal-migration.md).

### 2.9 Report and CLI contracts that replace `withBudgetStop`

- **Budget-caused re-marking** (I9): `runPlan` re-marks a `blocked`/`queued` row as `budget-exhausted` iff its
  non-dispatch is transitively caused (memoized over the dependency DAG) by a `reservation-refused` (except
  `advisory-*`, which stays `budget-exhausted` on the job itself), a trip, or a `deferred` stop. Causes are read
  from the run's own events, never from marker strings. Quarantine rows stay `needs-human`.
- **`report.costUSD = Σ chargedUsd`** over the run's reservations: the ledger truth, ≥ modeled cost when any
  reservation was full-charged. `ReviewLoopOutcome.fixReport` and `SelfMergePrsResult.report` consume it.
  `report.usage` = Σ settled usage over reservations whose basis ≠ `full`.
- **Exit codes** ([src/cli/exit.ts](../../src/cli/exit.ts); its header's "`budget` is the only value" is
  rewritten):

  | `earlyStopReason`                                        | Exit                                                                                                           |
  | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
  | `budget`, `stalled`, `deferred`, `lock-lost`, `provider` | **3** (needs a human, or retry later)                                                                          |
  | `signal`                                                 | **130** for SIGINT, **143** for SIGTERM (shell convention); **3** for an SDK-supplied signal with no OS signal |

  Row-based mapping is unchanged. The **lock refusal** (`plan locked by <runId>`) is **transient** → **3** (automation
  treats 2 as a permanent usage error and would never retry). The v1-journal and ungoverned-over-governed refusals
  are a missing `--opt-in` → **2**, mapped from a **typed error class** the CLI catches, never by message matching.
  The documented exit contract grows from `{0,1,2,3}` to six codes (adding 130/143), and `exitCodeForRunReport`'s
  return type widens from `0|1|3`.

  > Not in force (the 130/143 row and the six-code widening): see post-acceptance note N1 in the
  > [ADR index](README.md#post-acceptance-notes).

## 3. Consequences

**Good.**

- One writer of spend, and resume keeps the budget. The four compositions, `withBudgetStop`, the heuristic job keys
  and the marker parsing go.
- HARD lanes bound total modeled USD by `C_max` within one journal dir (§2.3), including against orphaned children,
  paused same-boot lock holders, and contenders launched with different `$TMPDIR` (§2.5).
- Approval stops being attacker-writable plan data, and its check and use are atomic with the write.

**Costs.**

- HARD is expensive. `W_max` from published limits is **$0.72** per request for Haiku 4.5 (200K context, 64K max
  output, 1h write $2/MTok, output $5/MTok) and **≈ $5.28** for a 1M-context/128K-output model at $4/$10 per MTok.
  With the CLI's **unpinned** retry ceiling the retry term alone is `(1 + R_max) × W_max`, several dollars per Haiku
  invocation, so **pinning `CLAUDE_CODE_MAX_RETRIES` (proxy-asserted) is in practice a HARD precondition for small
  caps**.
- Small caps can't run HARD at useful concurrency (the concurrency floor check refuses them loudly), and an op's
  small `maxUsd` is sized **up** to `floor`.
- `Budget.maxUsd` becomes live for ungoverned SDK callers after W2.1. Process-lane aborts are charged `r`, so D5's
  abort-on-trip burns those reservations. Each invocation costs two fdatasyncs plus a `stat` fence.
- Quarantine needs a human. Approval tokens are single-use and consumed at write. Unattended sandbox-off runs can't
  run approval jobs.
- Until W2.1 + W3.5 and a lane's proxy leg pass, **every unattended governed run is refused** without
  `--allow-advisory-budget`. The cq-fixtures matrix (token-capped; acp is ADVISORY for all of v1.1) therefore needs
  `allowAdvisory`, and its W6.4 "USD ceiling" is an ADVISORY ceiling, not the §2.3 bound.

**Not changed.** ADR-0002's seam (`Driver.run`, `WorkerResult`, `DriverStopReason`, the factory surface); the Op
contract; replay's skip rule.

## 4. Landing

1. Journal v2 (`seq` claimed by exclusive create), fdatasync, the plan lock (§2.5), `allSettled`/stop-on-emit.
2. `runPlan` governance param, `runGoverned`, job gate, invocation gate in shadow mode.
3. Drivers (W2.1) + pricing normaliser (W3.5): native caps, `canonicalModel` settlement, the ai-sdk pre-request
   guard, pinned env (retries, output cap, compaction), the recording proxy harness.
4. Flip to ledger authority: delete the compositions, `withBudgetStop`, `report*` and their exports, smoke script,
   fixture op and docs; §2.9 goes live, with ADVISORY refusal and quarantine.
5. **cq-fixtures migration (slice F)** (pinned-SHA bump) onto a governed scope meeting §2.1's six requirements
   (shape open, O-3). A precondition for W6.4's USD ceiling.
6. Approval token (W4.3): exercise-at-write, workspace mutation lock.
7. Per-lane HARD rows switched on as their proxy legs pass.

A12 (including the lock variants), A12b, A12c, A16 and A18 become regression tests (P3).

## 5. Alternatives rejected

- **mtime-staleness locks:** staleness is a timeout, and a holder paused past any timeout must still be refused.
- **pid liveness as the sole lock test:** pid reuse, and a record file doesn't prove the pid is ours.
- **`ECONNREFUSED` alone as the death test:** ambiguous for a SIGSTOPped macOS holder once `somaxconn` is queued.
- **A socket path derived from `os.tmpdir()`:** splits the rendezvous across `$TMPDIR` contexts (§2.5).
- **Journalling ungoverned pass-through dispatches:** contradicts write-ahead.
- **Auto-reducing concurrency under a small cap:** a hidden throughput change; P8 prefers a loud refusal.
- **Consuming approval at op start:** a later refusal or a moved workspace would burn the token, and check and use
  would not be atomic with the write.
- **The reservation as a `Budget` field hidden from the invocation hash by a projection:** that projection
  (`OpInvocationData`) no longer exists in ADR-0002.

## 6. Open points and owner inputs

Accepted with these open points carried as binding W2 acceptance criteria:

- **O-3** — the slice-F shape (§2.1).
- **O-4** — ADVISORY sizing (§2.3).
- **O-5** — where the workspace mutation lock's record lives (§2.5; approval-token annex §4c).
- **O-6** — the approval TOCTOU closing rule for non-approval writers (§2.7; post-acceptance note N5).
- **O-8** — handling of an empty or half-written lock record (§2.5 acquire step 4).

Owner inputs: the first HARD row's model (§2.4), and the fixer lane and model for the v1.1 HARD-fixer-lane
requirement (ADR-0002's default fixer binding is ai-sdk, whose HARD path waits on the proxy leg).

Plan consequences: the per-plan lock (W2.4) is the §2.5 lock record with `seq` ordering (§2.8); W6.4 blocks on
slice F, which follows the W2 HARD flip. The `≤ C_max` bound is stronger than a "cap + Σ in-flight reservations"
bound, with `C_max = cap` absent `raiseCap`.

## Slot C — Provider profiles

A provider profile carries windows, RPM/TPM, peak multipliers, native account caps, remaining-quota observation, the
lane → `errorClass` mapping, **and the per-model published limits** for §2.4 criterion 2. Shape (from RS-14):
`ProviderProfile` = the §2.6 interface plus `cap{kind, amount, settableVia, enforcedAs}`,
`quota{windows[], peak, burnModel}`, `observability{channel, headers, usageEndpoint}`, `rateLimitHeaders[]` and
`modelLimits{max_input_tokens, max_output_tokens, rpm/itpm/otpm, servedAliases[]}`.

`accounting` is `'quota'` for claude-subscription / zai-glm-coding / codex-chatgpt / opencode-go, and `modeled-usd`
for anthropic-api / deepseek / openai-api. `modelLimits[*].servedAliases` feeds the **built-in layer of ADR-0002's
`ServedModelPolicy.aliases`**, not a second alias table (ADR-0002 §2.6). `max_tokens` is honoured live by the zai
coding and deepseek wires, and the claude CLI pins `max_tokens: 32000` on Haiku 4.5 (a demonstrated pin, usable in
`W_max` once the proxy leg asserts it).

## Slot D — Configuration keys

Specified by [ADR-0002 Annex B](0002-annex-b-config.md): §B.8.4 (budget and governor keys, the per-call-only opt-ins
and the `--attended` flag) and §B.8.5 (approval-token keys). All follow P7 precedence and P8 blank = conservative.
