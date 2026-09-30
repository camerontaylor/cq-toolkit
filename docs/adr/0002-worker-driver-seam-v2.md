# ADR 0002 — Worker/driver seam v2

> Publication note (W7.2): copied from `toolkit-research` branch `research/g1-adr-reconciliation` at `bf5f540`. The status above records the later owner G1 decision. References below to pending G1 approval or draft status describe the source text at its drafting date; accepted preconditions and residuals remain binding.

Status: **accepted** (owner G1 sign-off, 2026-09-26; binding work-item preconditions and residuals retained)
dispositions in [`adr-0002-r1-dispositions.md`](adr-0002-r1-dispositions.md). Critic round 2 (final) returned ITERATE
(10 residual findings, 4 major). Pending owner approval at G1 (the G1 preconditions are in §7).
**Reconciled (G1 prep): 2026-09-25.** The residuals of `adr-0002-critic-r2-verdict.md` (`research/adr-0002-critic-r2`
@ `95bcf63`) are folded, together with the cross-ADR items of `adr-0003-critic-r2-verdict.md`
(`research/adr-0003-critic-r2` @ `f4ebca6`), RS-14 (`research/rs14-provider-limits` @ `ab671be`) and RS-7
(`research/rs7-public-api` @ `1b9a709`). Finding → section → change: `adr-reconciliation-log.md`. The owner's
accept-vs-hold decision is left stated in §7; it is not taken here.
Date: 2026-09-25
Amends: ADR-0001 (seam contract; served-model clause, see §2.6). Paired with: ADR-0003 (governed runner). Together
they are the **single P2 thaw** (plan §2 P2, §5).
Evidence: `research/research-20260925-v11/rs5-seam-v2.md` (all anchors against cq-toolkit `5e52707`).
Annex slots: **A — MCP harness server (RS-12)**; **B — configuration keys (RS-15)**. Both are placeholders. Their
spikes fill them without changing §2–§7.

## 1. Context

ADR-0001 froze `Driver.run(OpInvocation) → WorkerResult` (T1.1). The v1 evaluation (J2, improvements 04 §4.3) and
RS-5 found four seam gaps, each of which forced a workaround:

1. **No output schema on the invocation.** So the schema is a driver _constructor_ option on all 4 lanes, ops
   construct concrete lanes, and they pick a lane by overloading `ModelSpec.provider` (`'ai-sdk'` is both a lane
   and a Z.AI alias).
2. **No cancellation signal.** So every lane imports the kernel's ambient `currentJobContext()`, which inverts the
   seam's stated dependency direction. Drivers outside a governed job can't be cancelled.
3. **No workspace.** Workers are bound to a directory only through a pre-created session record. Callers that don't
   know the trick (fixtures E1) put the path in prompt text, and the worker edits a scratch dir.
4. **No error class.** Failure causes are free text. One lane embeds a class token in the text, consumers regex it,
   and an unanchored transient regex misfires.

There are also two contract defects:

- Structured-output failure is `error` on ai-sdk but `complete`-without-object on the other three lanes.
- ADR-0001's served-model assertion is implemented only in the test suite.

## 2. Decision — the contract diff

All additions are **optional fields, an optional parameter, or new exports**. No existing field changes type or
meaning. The one removal is the per-lane constructor `outputSchema` option (§2.5), before publish.
`src/driver/types.ts` stays free of kernel imports and vendor types, and `OpInvocation` and `WorkerResult` stay
**plain serializable data** (`types.ts:12-13`).

### 2.1 `OpInvocation` and `Driver.run`

```ts
// src/driver/types.ts (v2) — additions marked +

/** A JSON Schema (draft 2020-12) document, plain data. No external $ref; meta-schema URIs stripped. */
+export type JsonSchema = { readonly [key: string]: unknown };

/** Structured-output request: plain data, hashable, lane-neutral. */
+export interface OutputSchema {
+  /** Stable contract name, e.g. 'review.fixItem/v1' — journalled and used in diagnostics. */
+  name: string;
+  schema: JsonSchema;
+}

/** The directory the worker edits. The driver binds cwd and harness confinement to realpath(path). */
+export interface WorkspaceBinding {
+  /** Absolute path to an existing directory. */
+  path: string;
+}

export interface OpInvocation {
  prompt: string;
  modelSpec: ModelSpec;
  toolPolicy: ToolPolicy;
  sandboxPolicy: SandboxPolicy;
  sessionRef?: string;
  budget: Budget;
+ /** When set, the run must end with a schema-valid structuredOutput or an 'output-invalid' error (§2.3). */
+ outputSchema?: OutputSchema;
+ /** Workspace binding (§2.4). Absent → I6 fresh temp workspace, unchanged. */
+ workspace?: WorkspaceBinding;
}

/** Runtime-only per-call options. Never persisted, hashed, or schema-mirrored. */
+export interface RunOptions {
+  /** Cooperative cancellation. `| undefined` so `{ signal: ctx?.signal }` compiles under exactOptionalPropertyTypes. */
+  signal?: AbortSignal | undefined;
+  /** Budget reservation of the governing gate (ADR-0003 §2.2). Runtime-only, next to the signal. Drivers MAY ignore it. */
+  reservation?: BudgetReservation | undefined;
+}
+/** Plain data; field set owned by ADR-0003 §2.2, declared here so the driver family needs no kernel import. */
+export interface BudgetReservation {
+  id: string; usd?: number; tokens?: number; overshootUsd: number; class: 'hard' | 'advisory';
+}

export interface Driver {
- run(invocation: OpInvocation): Promise<WorkerResult>;
+ run(invocation: OpInvocation, options?: RunOptions): Promise<WorkerResult>;
}
```

The signal rides an **optional second parameter** (the `fetch(url, {signal})` idiom), not the invocation. This
keeps `OpInvocation` pure data, so the strict mirror, the fixtures hash and journals need no "never persist this
field" rule. The parameter is additive: v1 call sites compile unchanged, and a v1 implementation
`run(invocation)` is still assignable to the v2 `Driver` type. Such a driver just ignores cancellation, which
conformance leg b-iii catches.

**Signal rules.**

- A driver MUST honour `options.signal`. If the signal is already aborted, the driver never dispatches: it returns
  `stopReason:'aborted'` with zero usage. If it fires mid-run, the run settles `aborted` with the usage observed so
  far.
- Drivers MUST NOT read `currentJobContext()` after the final slice. During migration the fallback
  `options?.signal ?? currentJobContext()?.signal` is allowed.
- **Ops bridge the signal.** An op calls `driver.run(invocation, { signal: currentJobContext()?.signal })` (ops
  already import the job context). ADR-0003's `runPlan(..., {signal})` feeds that same job context, so neither ADR
  changes the other's surface. The call compiles under the repo's `exactOptionalPropertyTypes`
  (`tsconfig.json:15`) because `RunOptions.signal` admits `undefined`.
- **Pass-through wrappers** (the served-model assertion, the session reaper, the S4 deprecated `worktreeFixDriver`
  shim; §2.5–§2.6) MUST forward `options` unchanged. A fewer-parameter `run: async (inv) => inner.run(inv)`
  type-checks against the v2 `Driver` and silently drops the signal, so this is enforced by a test, not the type:
  conformance leg b-v (migration checklist §4) runs b-iii through `withServedModelAssertion(fake)`, a
  `reap-on-settle` resolution and `createDriverFactory().resolve(...)`.
- **The governing wrapper composes; it does not forward.** ADR-0003's invocation gate passes the inner driver
  `{ signal: AbortSignal.any([options?.signal, jobSignal, tripSignal] — the defined ones), reservation }` as
  `RunOptions`. It never puts a signal or a reservation on the invocation (`OpInvocation` has neither field, and a
  cast that smuggles one there compiles but never reaches the lane, which fails open on D5's trip-abort).

### 2.2 `WorkerResult`

```ts
+export type WorkerErrorClass =
+  | 'output-invalid'        // outputSchema requested; object missing, unparseable, or schema-invalid (a MODEL outcome)
+  | 'served-model-mismatch' // set only by the shared served-model wrapper (§2.6)
+  | 'transient'             // network reset, timeout, 5xx/overloaded — retry may succeed
+  | 'rate-limit'            // throttling: retryable with backoff (RS-14 §4; e.g. 429 WITH retry-after)
+  | 'quota'                 // funded-allowance exhaustion: defer-until-reset if a reset is known, else needs-human (RS-14 §4)
+  | 'auth'                  // credentials rejected at the provider (401/403)
+  | 'provider-error'        // any other provider-reported permanent failure (RS-14's name)
+  | 'harness'               // local failure: spawn/exit/crash, protocol break, oversized frame, session I/O
+  | 'unknown';              // could not be classified from a structured signal — never guessed

/** Provider limit observations (plain data, RS-14 §1/§4). Lanes populate what the vendor exposes; ops never read them. */
+export interface ProviderSignals {
+  /** From a Retry-After (or vendor equivalent) on this response. */
+  retryAfterMs?: number;
+  /** Every limit window the provider reported on this response; several may be live at once. */
+  windows?: Array<{
+    /** Provider window id, e.g. '5h' | '7d' (claude unified-*), 'rolling' | 'weekly' | 'monthly' (opencode-go),
+     *  'requests' | 'tokens' (per-minute API headers). */
+    id: string;
+    /** Fraction of the window used, 0–1 (percent sources are divided by 100). */
+    utilization?: number;
+    /** Remaining requests/tokens, where the provider reports counts (Anthropic API, OpenAI). */
+    remaining?: { requests?: number; tokens?: number };
+    /** ISO-8601 instant this window resets. */
+    resetAt?: string;
+  }>;
+}

export interface WorkerResult {
  // …v1 fields unchanged…
+ /** Only on stopReason === 'error' (same one-directional rule as `error`). */
+ errorClass?: WorkerErrorClass;
+ /** Allowed on any stopReason. Field set per RS-14 (§7 precondition 1); closed at acceptance. */
+ providerSignals?: ProviderSignals;
}

/** Pre-dispatch throws (the only throws the seam allows) carry a class too. */
+export type DispatchErrorClass = 'config' | 'auth';
+export function errorClassOf(err: unknown): DispatchErrorClass | undefined;
+export const SEAM_VERSION = 2;
```

**Two separate `errorClass` rules.**

- **Wire rule (strict mirror, permanent):** `errorClass` present ⇒ `stopReason === 'error'`. It is one-directional,
  like the existing `error` rule (`kernel/schema.ts:176-183`; pinned by `test/kernel/types.test.ts:935`, "an error
  verdict with NO error parses"). v1 records, and `error` verdicts from lanes before S3, still parse.
- **Producer rule (normative, enforced by conformance leg i):** every `error` verdict a v2 driver produces carries
  `errorClass`. It is a conformance obligation, not a schema constraint, so consumers of old journals never fail
  to parse.

**Classification rules.**

- Classes come from **structured signals**: HTTP status or SDK error class, CLI exit code/signal, protocol fields.
- Free-text matching is allowed only where the vendor exposes no structure, and only with anchored patterns.
- Anything unresolved is `unknown`, never `transient`.
- `error` stays bounded, redacted text for humans. The `<lane> driver: [token]` prefix is **no longer a contract**,
  so consumers must switch to `errorClass`.
- **Limit cuts are structural (RS-14 §4 rules of record).**
  1. Status code plus the provider's error code outrank message text.
  2. A provider error code in the funded-allowance set is `quota`, whatever its HTTP status:
     Anthropic `enforced_spend_limit_reached` (429, no `retry-after`), OpenAI `insufficient_quota` /
     `credit_balance_exhausted` / `*_spend_limit_exceeded` (429), HTTP 402 (DeepSeek, OpenCode Zen), the Z.AI coding
     wire's 429. A bare "429 ⇒ rate limit" rule misclassifies these quota 429s (RS-14 §6).
  3. On the Claude lanes, the presence of the `anthropic-ratelimit-unified-*` headers (or the CLI/SDK "You've hit
     your … limit · resets …" result) discriminates a plan limit (`quota`) from a throttle (`rate-limit`). This
     precedes rule 4: RS-14 §1.2's live subscription-quota 429 carried `retry-after: 3741`.
  4. Otherwise a 429 **with** `retry-after` is `rate-limit`.
  5. **Producer rule for `quota`:** the verdict carries `providerSignals.windows[*].resetAt` whenever a reset is
     extractable (unified `-reset`, opencode-go `resetsAt`, the CLI text's reset time). Absent a reset, consumers
     treat `quota` as needs-human.

  The per-lane signal → class table is migration checklist §3 (RS-14 §4 verbatim).

- **RS-14 has answered (`ab671be`, §4 and §6) and is folded here**: the class names `rate-limit` / `quota` /
  `provider-error`, the structural cuts above, and a multi-window `ProviderSignals`. At acceptance the enum
  values and the `ProviderSignals` field set close for this bump; RS-14's later work (and W2.6) changes only the
  lane→class and lane→signal _mapping_.

### 2.3 Uniform structured output (all lanes)

When `invocation.outputSchema` is set (or, until S6, a lane's constructor `outputSchema`):

| Run outcome                                                          | Verdict                                                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Object obtained and it validates against `schema`                    | `complete`. `structuredOutput` = the validated plain JSON                                             |
| Object missing, unparseable or invalid, after the lane's repair step | `stopReason:'error'`, `errorClass:'output-invalid'`, usage/cost kept, rejection recorded in narration |
| A cap or the signal stopped the run first                            | `budget` / `aborted` (carve-out: the missing object is a consequence, not the cause)                  |

When no schema is requested, `structuredOutput` MUST be absent.

**Per-lane transport and repair.** The _verdict_ is uniform; the transport stays native.

- **ai-sdk:** `Output.object` over the JSON Schema, keeping the step-7 tool cutoff. It MUST make **one** bounded
  repair request before giving up: tool-free, over the session transcript, schema restated, `maxRetries: 0`, inside
  `budget` and `signal` (W3.4).
- **claude-agent:** native `outputFormat` `json_schema` (the SDK validates and retries).
- **subprocess:** `--json-schema` (the CLI validates and retries).
- **acp:** prompt-directed JSON. It MAY make one "reply with only the JSON" follow-up turn in the same session.
- **All lanes:** validate after settle with the shared validator in `src/driver/common/structured.ts`, over the same
  stripped schema that was sent.

### 2.4 Workspace binding

| `workspace` | `sessionRef` | Behaviour                                                                                                  |
| ----------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| absent      | absent       | Fresh temp workspace and fresh record (I6, unchanged)                                                      |
| set         | absent       | Fresh session record **created in `realpath(workspace.path)`**. Tools, cwd and path confinement bind to it |
| absent      | set          | Load the record and reuse its workspace (unchanged)                                                        |
| set         | set          | Load the record. It MUST record the same realpath, **else throw pre-dispatch** (`errorClassOf → 'config'`) |

- The path must be absolute and name an existing directory, else throw pre-dispatch (`config`).
- Session sidecars stay in `sessionsDir`, never in the workspace (tamper vector #26). That includes acp's, per W1.5.
- `workspace` is the P1 binding ("the workspace binding, not prompt text"). Prompt text naming a path confers nothing.
- `workspace.path` is P1-relevant input: where it comes from plan data (e.g. fixItem's `input.worktree.path`), the
  op's P1 checklist names it (checklist §2).
- **Record retention** for the fresh record a workspace-bound run creates is a factory concern (§2.5,
  `DriverRequest.sessionRetention`), not a seam field.

### 2.5 Driver construction and `DriverFactory`

```ts
// src/driver/factory.ts (new; driver family — no kernel import)
+export type LaneId = 'ai-sdk' | 'claude-agent' | 'subprocess' | 'acp';
+export type WorkerRole = 'fixer' | 'conflict-resolver' | 'remediator' | 'classifier' | (string & {});

+export interface DriverRequest {
+  role: WorkerRole;
+  modelSpec: ModelSpec;
+  /** Command/path restrictions that ToolPolicy (names only) cannot carry. Plain data. */
+  harness?: HarnessConfig;
+  /** Fresh session records created by workspace-bound runs: kept (default) or reaped once the run settles. */
+  sessionRetention?: 'keep' | 'reap-on-settle';
+}

+export interface ResolvedDriver {
+  readonly driver: Driver;       // already wrapped by the served-model assertion (§2.6)
+  readonly lane: LaneId;         // ADR-0003 keys HARD/ADVISORY lane classification on (lane, provider)
+  readonly modelSpec: ModelSpec; // normalised (deprecated provider aliases resolved) — ops put THIS on the invocation
+}

+export interface DriverFactory {
+  /** Throws pre-dispatch (errorClassOf → 'config') for an unbound role/provider. Never silently falls back. */
+  resolve(request: DriverRequest): ResolvedDriver;
+}

+export interface DriverFactoryConfig {
+  /** role → provider → lane; '*' = any provider. Resolved per P7 (built-in → CQ_* env → per-call). Names: Annex B. */
+  bindings?: Readonly<Record<string, Readonly<Record<string, LaneId>>>>;
+  sessionsDir?: string;
+  pricing?: (spec: ModelSpec) => PerMillionRates | undefined;
+  servedModel?: ServedModelPolicy;
+  /** Per-lane construction knobs (e.g. subprocess binary/routing table, acp command). Never from plan JSON. */
+  lanes?: { subprocess?: SubprocessLaneConfig; acp?: AcpLaneConfig; claudeAgent?: ClaudeAgentLaneConfig; aiSdk?: AiSdkLaneConfig };
+}
+export function createDriverFactory(config?: DriverFactoryConfig): DriverFactory;
```

- **Ops take a `DriverFactory`** (dependency injection), never a lane class. Registry importers bind
  `createDriverFactory()` with the resolved project config. Tests inject a factory that returns fakes.
- **Ops put `resolved.modelSpec` on the invocation**, never the input's spec, so the deprecated `'ai-sdk'` alias
  never reaches a lane or a journal.
- **Default bindings (conservative, P8):** every role binds to `ai-sdk` for the providers that lane supports
  (`zai`, `anthropic`, `openai`, `deepseek`).
  - An unknown provider throws `config`.
  - `subprocess` is never a silent default. It is bound explicitly, and only after W1.4 closes its tool surface.
  - `claude-agent` and `acp` are bound explicitly.
  - **This moves four ops off the subprocess lane by default**: `merge.resolveConflict`, `review.fixItem`,
    `analyze.agenticRemediation` and `sweep.unit`. The per-op before→after table, and the consequence for
    `anthropic` without an API key, are in §3 and are owner sign-off item 4 (§8).
- **Session retention:** `sessionRetention: 'reap-on-settle'` deletes only the fresh record that the factory's
  lane created for that run, after it settles, whatever the verdict. `keep` (default) leaves it for `sessionRef`
  resume, the rescue mechanism ADR-0001 names, and for the "see the session record" pointers ops put in their
  results. `review.fixItem` requests `reap-on-settle`, preserving today's behaviour (`fixReviewItem.ts:564-574`,
  round-3 item 14) unless retention is configured.
- **Deprecated alias:** `provider: 'ai-sdk'` normalises to `{lane: 'ai-sdk', provider: 'zai'}`, with a `cq:` stderr
  notice. It is removed in the next major.
- **Retired:**
  - the lane constructors' `outputSchema` option (removed in the last slice, before publish);
  - `worktreeFixDriver` and `FixDriverSource.perHarness` (replaced by `workspace` plus `DriverRequest.harness` and
    `sessionRetention`);
  - every lane construction under `src/ops/**`, static or via dynamic `import()`;
  - `sweep.unit`'s plan-JSON `driver.binary`/`routingTable`. Plan data never names an executable (P1); these move
    to `DriverFactoryConfig.lanes.subprocess`.
- The lane classes stay exported, on the **`./driver`** subpath (RS-7's validated map: the four lanes, routing,
  pricing, process helpers and seam types; `.` stays the full barrel for v1.1), for callers that want a lane directly.
  Such callers own the served-model wrapping (§2.6). A driver that no factory issued has no `ResolvedDriver.lane`,
  and ADR-0003 MUST classify it **ADVISORY**, so it is refused unattended by default (P8,
  `CQ_BUDGET_ALLOW_ADVISORY=false`). This is what makes "ignore unknown `Budget` fields" (§2.7) safe.

### 2.6 Served-model assertion (amends ADR-0001)

```ts
// src/driver/served-model.ts (new)
+export interface ServedModelPolicy {
+  /** Declared wire remaps, LANE-scoped: lane → provider → requested id → admitted served ids (normalised). */
+  aliases?: Readonly<Partial<Record<LaneId, Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>>>>;
+  /** Per lane: must a completed run report a served id? Default true on every lane. */
+  requireObserved?: Readonly<Partial<Record<LaneId, boolean>>>;
+}
+/** Lane-declared normaliser applied to BOTH the observed and the requested id before comparison. */
+export function normaliseModelId(lane: LaneId, id: string): string;
+export function withServedModelAssertion(driver: Driver, opts: { lane: LaneId; policy?: ServedModelPolicy }): Driver;
```

- **Normalisation is lane-declared and anchored.** ai-sdk, claude-agent and subprocess normalise by identity. acp
  strips exactly one leading `builtin:<provider>\` namespace (the form its harness reports, `acp/protocol.ts:642-648`;
  `test/driver/acp.test.ts:723-728`) and case-folds. `WorkerResult.model` keeps the **raw** observation (v1 meaning
  unchanged). The wrapper's narration records `{requested, raw, normalised, via: 'exact' | 'alias' | 'unobserved-allowed'}`.
- **Scope:** the wrapper judges only `stopReason:'complete'` results.
- **Pass:** any one of:
  - `normalise(model) === normalise(modelSpec.model)`;
  - the normalised pair is a declared alias **for this lane**;
  - no id was observed and `requireObserved[lane] === false`. This relaxation is recorded, and it never admits an
    _observed_ mismatching id.
- **Fail:** the verdict is rewritten to `stopReason:'error'`, `errorClass:'served-model-mismatch'`, with
  `error: "requested <x>, served <raw|unobserved>"`.
  - `structuredOutput` is dropped.
  - `usage`, `costUSD`, `costBasis`, `sessionId`, `denials` and `providerSignals` are **kept**, because the spend was real.
- **No off switch.** There is no mode that turns mismatches into narration. The v1 draft's `record` mode is
  **dropped**. A remap either is declared (alias, recorded) or fails.
- **Where it applies:** `createDriverFactory` applies it to every resolved driver; this is the **one** hook for
  toolkit dispatch (W1.6). Direct lane constructions must wrap explicitly.
- **No other assertion point:** lanes only _observe_ (`WorkerResult.model`). Ops and the governor never assert.
- **Retired:** the subprocess pre-dispatch model allowlist, which ADR-0001 itself calls structurally incapable. The
  wrapper replaces it on that lane, so there is no window without a remap defence.
- **A normalised acp mismatch is a finding, not something to configure away.** If acp observes
  `builtin:bigmodel\GLM-5.3` for a `glm-5.3-flash` request, the normalised ids differ (`glm-5.3` ≠ `glm-5.3-flash`).
  That is a remap on the acp eval column (ADR-0001's "drivers vary on a fixed GLM model" axis). It is reported as
  such. The eval then either requests what that harness serves, or the owner declares a recorded alias. It is never
  relaxed away.
- **One alias source of truth.** `ServedModelPolicy.aliases` is the only table that says which served ids a
  requested id may come back as. W3.5's served→canonical pricing normaliser and ADR-0003 §2.2 step 1's `W_max`
  alias set **read it**; they do not keep their own. RS-14's `ProviderProfile.modelLimits[*].servedAliases`
  populates its **built-in** layer (P7: built-in → env → call), lane-scoped like every other entry. Which vendor
  remaps ship built in (RS-14 records `deepseek-chat` → `deepseek-flash`, Z.AI GLM-5.2/5.1 → GLM-5.3 and GLM-4.7 →
  GLM-5.3-Flash, Anthropic dated ↔ alias ids) is open at G1 (reconciliation log, open point O-2). Until it is
  decided, the built-in layer is empty, and §3 states the consequence.
- **Budget classification depends on this policy.** A lane configured `requireObserved: false` can serve any model
  unobserved, so the `W_max` alias-set maximum does not bound it. ADR-0003 MUST classify such a lane **ADVISORY**
  for USD (ADR-0003 critic r2 m-d).

**ADR-0001 amendment text (served-model rule):** "Every driver reports the model id observed on the response. One
shared wrapper, applied by the `DriverFactory` to every driver it resolves, compares that id with
`modelSpec.model` after the lane's declared normalisation. On a completed run, a mismatch or an unobserved id fails
the invocation loudly (`errorClass: 'served-model-mismatch'`) and keeps its usage. There are exactly two
relaxations. Both are declared in configuration, scoped to one lane, and recorded whenever they are used: (1) an
alias table that admits named wire remaps (lane → provider → requested → served ids); (2) a per-lane
`requireObserved: false`, which lets an _unobserved_ id pass on that lane only — an observed mismatching id still
fails. No setting disables the comparison. Callers that construct lanes directly wrap them with
`withServedModelAssertion`."

### 2.7 `Budget`: the ADR-0003 pass-through

- `Budget` stays the per-invocation cap contract the driver enforces.
- ADR-0003 MAY add optional **cap** fields to `Budget` **within this same types bump**. ADR-0002 reserves no names
  there.
- **The reservation is not a `Budget` field** (reconciliation, ADR-0002 critic r2 N2, option (a)). It is runtime-only
  and run-scoped, so it rides `RunOptions.reservation` (§2.1) next to the signal. `OpInvocation` therefore stays
  pure _and_ stable: no persisted or hashed projection has to strip anything, and the deleted `OpInvocationData`
  is not needed.
- Driver obligations for that to work:
  - report `usage` on every exit path, including abort and error (already the lanes' rule; W2.1 lints it);
  - return `stopReason:'budget'` for any cap the driver enforces;
  - **ignore unknown optional `Budget` fields rather than reject them**. Whether a lane _enforces_ a field is
    ADR-0003's lane classification, keyed on `ResolvedDriver.lane`. Drivers without a factory-issued lane are
    ADVISORY (§2.5), so an ignored cap fails closed at admission, not open at dispatch.
- **The observation channel runs the other way, through ADR-0003's invocation gate.** The gate is the one component
  that settles every factory-resolved `WorkerResult` (one reservation = one `Driver.run`, ADR-0003 §2.2). It reads
  `errorClass` and `providerSignals` from the result and records them on `reservation-settled`, a journal shape
  ADR-0003 owns (ADR-0003 §2.2 step 9; journal annex §2). Class-aware rescue rows and W2.6 admission read them
  from there, structured. **Ops forward nothing.** The v1 `reportResult` fold is not the channel: ADR-0003 deletes
  it, and its type (`{usage?, costUSD?}`, `governor.ts:204`) could not carry the fields anyway.
- **Ungoverned callers** (SDK callers outside a governed scope, fixtures' directly constructed lanes) get the
  `WorkerResult` itself, which already carries the class and the signals. That is sufficient, and fixtures loses
  nothing.

### 2.8 Mirrors, version, conformance

- **Strict zod mirrors** (`kernel/schema.ts`):
  - `OpInvocationSchema` adds `outputSchema` and `workspace`. It stays typed `z.ZodType<OpInvocation>`; there is no
    runtime field to exclude.
  - `WorkerResultSchema` adds `errorClass` with the one-directional refinement "`errorClass` ⇒
    `stopReason === 'error'`" (§2.2), and a strict optional `providerSignals`. The existing `error` rule is
    unchanged.
- **`SEAM_VERSION = 2`**, exported from the seam barrel. It is shared with ADR-0003's runner and journal changes:
  one package minor, one types bump.
- **The conformance suite ships from `./driver`** (RS-7's validated map has no `./testing`, and none is added in
  v1.1) as `runDriverConformance(makeDriver, runner)` v2:
  - **Runner-agnostic:** `runner = { describe, test, expect }` is injected by the caller. The shipped suite imports
    no test framework, so `vitest` stays a devDependency (`package.json:65`) with no runtime or peer dependency.
    The toolkit's own lane registrations pass vitest's functions.
  - **No kernel import:** the ladder-abort leg b-ii stays a kernel test (it needs `runLadder` from
    `kernel/governor.js`) and is not part of the shipped suite.
  - `makeDriver` no longer receives `outputSchema`. Schema and workspace ride the invocation; the signal rides
    `RunOptions`.
  - New and changed legs are listed in the migration checklist §4.
  - P2 allows exactly one conformance-suite bump, so this packaging (entry point, injected runner) is part of the
    frozen surface.
- **Freeze point.** `SEAM_VERSION = 2` and conformance v2 freeze when S6, W2.2 **and W2.3** have all landed. W2.3
  brings ADR-0003's `Budget` fields and their enforcement legs. W3.1's API-report baseline is generated after that
  point.
- Old journals replay unchanged, and they also parse through the v2 mirror: every addition is optional, and the
  `errorClass` rule is one-directional.

### 2.9 Consumer contract: driver outcome → `OpResult` status (normative)

Every op that runs a driver maps throws and `error` verdicts this way. The table deliberately **preserves today's
statuses** wherever today's behaviour was already defined. Class-aware retry is a runner policy (ADR-0003 /
`kernel/rescue.ts`), fed by the structured class the invocation gate records on `reservation-settled` (§2.7), and
not an op-status relabel.

| Driver outcome                                                                                                                       | `OpResult.status` | Notes                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run()` throws, signal aborted                                                                                                       | `indeterminate`   | unchanged (I8)                                                                                                                                                        |
| `run()` throws, `errorClassOf` = `config` or `auth`                                                                                  | `needs-human`     | the review-debt #186 rule, already used by resolveConflict/fixItem                                                                                                    |
| `run()` throws, unclassified                                                                                                         | `needs-human`     | same rule. A post-dispatch throw is a lane bug that conformance catches                                                                                               |
| `stopReason:'error'`, **any** `errorClass` (including `transient`, `rate-limit`, `quota`, `served-model-mismatch`, `output-invalid`) | `failed`          | the failure text names the class (`errorClass=<x>`) for humans only. The structured class reaches the runner on `reservation-settled` (§2.7); nothing parses the text |
| `stopReason:'aborted'` / `'budget'`                                                                                                  | unchanged per op  | out of scope (sweep's existing all-non-complete → `failed` stays; W4.x)                                                                                               |
| `complete` whose `structuredOutput` fails the op's own strict parse                                                                  | `failed`          | unchanged                                                                                                                                                             |

This drops the v1 checklist's proposed `transient|rate-limited|quota-exhausted → indeterminate` (the r1 class
names) and
`served-model-mismatch → needs-human`. **Rationale (corrected at reconciliation; r1 cited `governor.ts:1601`, which
is `withBudgetStop`'s count re-booking, not a resume path):** `indeterminate` and `failed` **both** re-run on
resume. The replay rule skips a job only when its last prior finish was `ok` (`runner.ts:557-566`; "everything
else re-runs", `runner.ts:47-49`), and resume is an explicit caller act. The runner report maps both to JobState
`failed` (`runner.ts:278-281`). The only behavioural differences are the status-keyed rescue rows
(`rescue.ts:37-43`) and the journal fold, where `indeterminate` keeps the last derived state
(`journal.ts:254-262`). So v2 keeps `failed`, so that status-keyed rescue rows and the journal fold see no change.
**Class-aware policy keys on the structured class** (on `reservation-settled`, §2.7), **not on a relabelled
status.** Under `CONSERVATIVE_RESCUE_POLICY` (`rescue.ts:101`, no rows) there are no class-aware rows yet; adding
any is W2.6/rescue work, not this ADR.

## 3. Consequences

**Good.**

- Ops stop constructing lanes, so one driver instance serves any role and schema.
- The kernel↔driver dependency direction is restored, and `OpInvocation` stays pure data.
- Fixtures E1 disappears structurally.
- The J2 M3/M5 findings become contract rather than per-lane convention.
- W1.6 has exactly one hook.
- ADR-0003 gets its lane key, its `Budget` extension point and an observed-limits channel, with no second break.

**Costs.**

_Op-level status changes._ These are all the op-visible changes. Every other outcome keeps its v1 status (§2.9).

| Op                                        | Case                                                                                           | v1 status                                                                                        | v2 status                                        | Lands in                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `analyze.agenticRemediation`              | `complete` with a missing or invalid proposal                                                  | `ok` (value = the bare `WorkerResult`; header `:69-75`)                                          | `failed` (lane returns `error`/`output-invalid`) | **S3**: the op is still bound to subprocess with a constructor schema, which S3 unifies too |
| `analyze.agenticRemediation`              | pre-dispatch throw (`config`/`auth`/unclassified)                                              | `indeterminate` (`:232-238`)                                                                     | `needs-human`                                    | S4                                                                                          |
| all four driver ops                       | `complete` whose served id differs (normalised, no lane alias) or is unobserved where required | `ok` or the op's usual `complete` path (subprocess only narrates, `subprocess/index.ts:565-577`) | `failed` (`served-model-mismatch`)               | S4                                                                                          |
| `merge.resolveConflict`, `review.fixItem` | claude-agent/subprocess/acp `complete` without a valid object                                  | `failed` (op parse, e.g. `fixReviewItem.ts:657-660`)                                             | `failed` (`error`/`output-invalid`)              | S3. **Status unchanged**, different path                                                    |
| `sweep.unit`                              | — (no `outputSchema`)                                                                          | —                                                                                                | unchanged                                        | —                                                                                           |

_Default lane before → after (owner sign-off item 4)._

| Op                           | Provider           | v1 lane                                                                 | v2 default lane                                                              |
| ---------------------------- | ------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `merge.resolveConflict`      | `'ai-sdk'`         | ai-sdk (`resolveConflict.ts:422-431`)                                   | ai-sdk (alias → `zai`)                                                       |
| `merge.resolveConflict`      | any other          | **subprocess** (Claude-Code CLI)                                        | **ai-sdk** for `zai`/`anthropic`/`openai`/`deepseek`; other → `config` throw |
| `review.fixItem`             | `'ai-sdk'` / other | ai-sdk / **subprocess** (`registry.ts:490-505`, `fixReviewItem.ts:556`) | as resolveConflict                                                           |
| `analyze.agenticRemediation` | any                | **subprocess** (`analyze/registry.ts:425-426`)                          | **ai-sdk**                                                                   |
| `sweep.unit`                 | any                | **subprocess** from plan data (`unit.ts:1296-1333`)                     | **ai-sdk** unless config binds subprocess                                    |

- `{provider:'anthropic'}` moves from the Claude-Code CLI's own endpoint to `@ai-sdk/anthropic`, which **requires
  `ANTHROPIC_API_KEY`** (`ai-sdk/index.ts:631-635`). The owner runs without one (ADR-0001 eval-axes paragraph).
  Under the default binding, those calls throw `config` pre-dispatch, and the op returns `needs-human`. That is loud,
  but it is a behaviour change.
  - **The owner's supported Claude route under v2:** bind `anthropic → claude-agent` (or `→ subprocess` once W1.4
    has closed its tool surface) explicitly. This binding ships in the `solo-maintainer` profile (Annex B).
- `{provider:'zai'}` moves from the CLI over Z.AI's anthropic-compatible route to the in-process lane on the coding
  `paas/v4` endpoint. That is a different harness, tool surface and wire.
- Rationale for the default (P8): subprocess has an open tool surface until W1.4 closes it (J2 C1), so it must not be
  a silent default for write-capable roles.

_Other costs._

- Fixtures scoring changes on the ai-sdk fixer rows only (checklist §5, the metric-definition note). Non-ai-sdk
  fixer totals stay comparable across S5 **per scored row**, but _coverage_ is not: after S5 a served-model mismatch
  is an absence (no row) where it used to be a scored row, so `expectedCases` coverage (W6.2) can drop wherever a
  lane's served id differs. The acp column's comparability is conditional on the acp remap finding (§2.6) being
  resolved; until then every acp row may be an absence.
- **`deepseek-chat` fails by default.** Under the default binding (`deepseek → ai-sdk`), identity normalisation
  and an empty built-in alias layer (§2.6, open point O-2), every `{provider:'deepseek', model:'deepseek-chat'}`
  request becomes `failed`/`served-model-mismatch` at S4, because the wire serves `deepseek-flash`
  (`pricing/data.ts:97-102`; RS-14 §1.4 live capture). Anthropic dated vs alias ids behave the same way wherever
  they differ. Fixtures is unaffected (it requests served ids, `fixtures:runner/cli.ts:44,221`); SDK callers are.
- A JSON-Schema validator is needed in the driver family: zod's own importer if 4.6.4 has one, else a pinned `ajv`
  (the W3.3 decision rule is in the checklist).
- Unattended acp runs fail when the harness doesn't report a served id, unless `requireObserved.acp = false` is
  configured. They also fail when the normalised id differs; that failure is a finding (§2.6).

**Not changed (P2 "no other seam changes").**

- `ModelSpec`, `ToolPolicy`, `SandboxPolicy`, `Usage`, `DriverStopReason` (still 4 values).
- `Driver.run`'s return type and first parameter. The only signature change is the optional `RunOptions`
  parameter, which v1 implementations still satisfy. (The name `RunOptions` collides with the kernel's existing
  `RunOptions` on the `.` barrel, `src/index.ts:37`, which RS-7 keeps whole for v1.1. The rename is open at G1:
  reconciliation log, open point O-1.)
- The Op contract `Op<I,R> = (input) => Promise<OpResult<R>>` and the `OpResult` status set.
- The journal event shapes (ADR-0003 owns those).

## 4. Landing

Six risk-ordered internal slices, each keeping `main` green. Details are in `adr-0002-migration-checklist.md` §1.

1. Types, mirrors (one-directional refinements), `SEAM_VERSION`, and conformance legs added as _pending_.
2. Lanes honour `RunOptions.signal` and the `workspace` invocation field, with the ambient fallback.
3. `errorClass` plus uniform structured output in all 4 lanes (invocation and constructor schemas), and the ai-sdk
   repair (W3.4). This also changes agentic's no-proposal outcome (§3).
4. `DriverFactory` plus the served-model wrapper (W1.6); ops, e2e and scripts migrated.
5. Fixtures pinned to the slice-4 SHA and migrated.
6. Removals: constructor `outputSchema`, the ambient fallback, `worktreeFixDriver`, and sweep's plan binary. Then
   conformance v2 becomes mandatory. It freezes once W2.2 and W2.3 have also landed (§2.8).

Nothing is published until W7.1.

## 5. Alternatives rejected

Recorded in the RS-5 design note, §3:

- a zod object on the seam;
- keeping the ambient signal;
- `signal` as an `OpInvocation` field (the v1 draft's choice; it broke the plain-data invariant);
- `workspace.sessionRef`;
- `lane` on `ModelSpec`;
- per-lane, op-level or governor-level served-model checks;
- a served-model `record` mode (an unscoped off switch);
- `complete`-without-object as the uniform verdict;
- relabelling provider-failure classes to `indeterminate`/`needs-human` (§2.9);
- a W2.6 limited to config profiles only, with no observed-signal channel (it contradicts plan D5/W2.6's "from
  response headers where the provider exposes them");
- forwarding `errorClass`/`providerSignals` through the ops' `reportResult` fold (r1's channel: ADR-0003 deletes
  the fold, and its type can't carry the fields; §2.7);
- the reservation as a `Budget` field, excluded by a named persisted/hashed projection (ADR-0002 critic r2 N2
  option (b); r1 deleted `OpInvocationData`, and `RunOptions` is where runtime-only data belongs; §2.7).

## 6. Hand-offs

- **ADR-0003:**
  - `ResolvedDriver.lane` for classification; lane-less drivers, and lanes configured `requireObserved: false`, are
    ADVISORY;
  - `Budget` cap fields inside this bump; the reservation on `RunOptions.reservation`;
  - **§2.2 step 7 dispatches via `RunOptions`**: `driver.run(inv', { signal: any(options.signal, jobSignal,
tripSignal), reservation })`, where `inv'` differs from `inv` only in `budget.maxUsd` (mirrored in ADR-0003
    §2.2, reconciliation);
  - the gate records `errorClass` and `providerSignals` on `reservation-settled` (ADR-0003 §2.2 step 9 and journal
    annex §2) for class-aware rescue and W2.6 admission.
- **RS-14:** answered and folded (§2.2). Later RS-14/W2.6 work changes per-lane mappings only.
- **W3.5 / RS-14 `servedAliases`:** read and populate `ServedModelPolicy.aliases` (§2.6); no second alias table.
- **RS-7 / W3.1:** lanes and `runDriverConformance` on `./driver`; no `./testing` entry in v1.1; `.` stays the
  full barrel (§2.5, §2.8).
- **RS-15:** Annex B names.

## 7. G1 preconditions (acceptance gate)

This ADR can be accepted at G1 only when:

1. RS-14 has recorded its answer on (a) the `WorkerErrorClass` values and (b) the `ProviderSignals` fields.
   **Met at reconciliation:** RS-14 `ab671be` §4/§6 is folded into §2.2.
2. **The paired ADRs agree on the dispatch shape** (`RunOptions` carries the signal and reservation; the invocation
   carries neither) and on the class channel (`reservation-settled`). **Met at reconciliation** in both drafts
   (ADR-0003 §2.2 steps 7 and 9).
3. Critic round 2 (final) returned **ITERATE** (10 residuals, 4 major), not APPROVE. Its findings are folded
   (reconciliation log), except the items that need an owner decision or are recorded as open points (O-1, O-2).
   **Owner decision, stated and not taken here:** **(a)** accept at G1 with this reconciliation, the residual open
   points carried as W3.3/W3.5 acceptance criteria; or **(b)** hold G1 sign-off for a further critic round over
   the reconciled text.
4. The owner has signed off the four items in §8.

## 8. Owner sign-off items

1. **Uniform `output-invalid`**, including agentic's `ok` → `failed` change (§3) and the fixtures metric-definition
   change (checklist §5).
2. **Fail-closed served model**, with only the two lane-scoped relaxations (§2.6), and acp remaps treated as findings
   (including the `deepseek-chat` default consequence, §3, until O-2 is decided).
3. **`ProviderSignals` and the limit classes** as folded from RS-14 (§2.2): `rate-limit` / `quota` /
   `provider-error`, the structural 429 cut, and the multi-window shape.
4. **Default lane flip** to ai-sdk for four ops (`merge.resolveConflict`, `review.fixItem`,
   `analyze.agenticRemediation`, `sweep.unit`), plus the owner's Claude route via an explicit `claude-agent`
   binding (§3).

## Annex A — MCP harness server (RS-12) — _slot_

Filled by RS-12. The fixed constraints from this ADR:

- The server binds to `invocation.workspace`, resolved by the driver, and to `DriverRequest.harness`.
- It adds no `OpInvocation` fields.
- It is shared by the subprocess and claude-agent lanes behind the same `ResolvedDriver`.

## Annex B — configuration keys (RS-15) — _slot_

Placeholders, to be named by RS-15:

- the factory bindings (`CQ_DRIVER_<ROLE>_LANE`-shaped), plus the `solo-maintainer` profile's
  `anthropic → claude-agent` binding;
- the lane-scoped served-model alias table (`CQ_DRIVER_SERVED_ALIASES`);
- the lanes that allow an unobserved served id (`CQ_DRIVER_SERVED_UNOBSERVED_OK=<lane,…>`; blank = none);
- session retention for workspace-bound records;
- the per-lane construction knobs (subprocess binary, acp command).

All keys follow P7 precedence and P8 blank-means-conservative. No key disables the served-model comparison.
