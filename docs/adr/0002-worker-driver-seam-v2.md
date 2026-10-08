# ADR-0002 — Worker/driver seam v2

- **Status:** accepted (G1, 2026-09-26)
- **Date:** 2026-09-25
- **Amends / Related:** amends [ADR-0001](0001-worker-driver-seam.md) (the seam contract and its served-model rule,
  §2.6). Paired with [ADR-0003](0003-governed-runner.md) (governed runner): together they are the one published seam
  bump that P2 allows. Annexes: [A](0002-annex-a-mcp-harness.md) (MCP harness server) and
  [B](0002-annex-b-config.md) (configuration keys).

## 1. Context

[ADR-0001](0001-worker-driver-seam.md) froze `Driver.run(OpInvocation) → WorkerResult`. The v1 evaluation found four
seam gaps, each of which forced a workaround:

1. **No output schema on the invocation.** The schema is a driver _constructor_ option on all four lanes, so ops
   construct concrete lanes, and they pick a lane by overloading `ModelSpec.provider` (`'ai-sdk'` is both a lane and
   a Z.AI alias).
2. **No cancellation signal.** Every lane imports the kernel's ambient `currentJobContext()`, which inverts the
   seam's stated dependency direction, and drivers outside a governed job cannot be cancelled.
3. **No workspace.** Workers are bound to a directory only through a pre-created session record. Callers that don't
   know this (the cq-fixtures eval harness was one) put the path in the prompt, and the worker edits a scratch dir.
4. **No error class.** Failure causes are free text. One lane embeds a class token in the text, consumers match it
   with a regex, and an unanchored transient regex misfires.

There are also two contract defects: structured-output failure is `error` on ai-sdk but `complete`-without-object on
the other three lanes, and ADR-0001's served-model assertion is implemented only in the test suite.

## 2. Decision — the contract diff

All additions are **optional fields, an optional parameter, or new exports**. No existing field changes type or
meaning. The one removal is the per-lane constructor `outputSchema` option (§2.5), before publication.
[src/driver/types.ts](../../src/driver/types.ts) stays free of kernel imports and vendor types, and `OpInvocation`
and `WorkerResult` stay **plain serializable data**.

### 2.1 `OpInvocation` and `Driver.run`

```ts
// src/driver/types.ts (v2) — additions marked +

/** A JSON Schema (draft 2020-12) document, plain data. No external $ref; meta-schema URIs stripped. */
+export type JsonSchema = { readonly [key: string]: unknown };
/** Structured-output request: plain data, hashable, lane-neutral. */
+export interface OutputSchema {
+  name: string; // stable contract name, e.g. 'review.fixItem/v1' — journalled, used in diagnostics
+  schema: JsonSchema;
+}
/** The directory the worker edits. The driver binds cwd and harness confinement to realpath(path). */
+export interface WorkspaceBinding {
+  path: string; // absolute path to an existing directory
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
+  signal?: AbortSignal | undefined;             // cooperative cancellation; `| undefined` for exactOptionalPropertyTypes
+  reservation?: BudgetReservation | undefined;  // the governing gate's reservation (ADR-0003 §2.2); drivers MAY ignore it
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

The signal rides an **optional second parameter** (the `fetch(url, {signal})` idiom), not the invocation, so
`OpInvocation` stays pure data and mirrors, hashes and journals need no "never persist this field" rule. v1 call
sites compile unchanged, and a v1 `run(invocation)` is still assignable to the v2 `Driver`; such a driver ignores
cancellation, which conformance leg b-iii catches.

**Signal rules.**

- A driver MUST honour `options.signal`. If the signal is already aborted, the driver never dispatches and returns
  `stopReason:'aborted'` with zero usage. If it fires mid-run, the run settles `aborted` with the usage observed so
  far.
- Drivers MUST NOT read `currentJobContext()` (the migration-time fallback to it was removed in the final slice).
- **Ops bridge the signal:** `driver.run(invocation, { signal: currentJobContext()?.signal })`. ADR-0003's
  `runPlan(..., {signal})` feeds that same job context, so neither ADR changes the other's surface.
- **Pass-through wrappers** (the served-model assertion, the session reaper; §2.5–§2.6) MUST forward `options`
  unchanged. A wrapper that drops the parameter still type-checks, so conformance leg b-v enforces this by running
  b-iii through `withServedModelAssertion(fake)`, a `reap-on-settle` resolution and `createDriverFactory().resolve(...)`.
- **The governing wrapper composes; it does not forward.** ADR-0003's invocation gate passes the inner driver
  `{ signal: AbortSignal.any([options?.signal, jobSignal, tripSignal] — the defined ones), reservation }` as
  `RunOptions`. It never puts a signal or a reservation on the invocation: such a field would never reach the lane,
  which would fail open on D5's trip-abort.

### 2.2 `WorkerResult`

```ts
+export type WorkerErrorClass =
+  | 'output-invalid'        // outputSchema requested; object missing, unparseable, or schema-invalid (a MODEL outcome)
+  | 'served-model-mismatch' // set only by the shared served-model wrapper (§2.6)
+  | 'transient'             // network reset, timeout, 5xx/overloaded — retry may succeed
+  | 'rate-limit'            // throttling: retryable with backoff (e.g. 429 WITH retry-after)
+  | 'quota'                 // funded-allowance exhaustion: defer-until-reset if a reset is known, else needs-human
+  | 'auth'                  // credentials rejected at the provider (401/403)
+  | 'provider-error'        // any other provider-reported permanent failure
+  | 'harness'               // local failure: spawn/exit/crash, protocol break, oversized frame, session I/O
+  | 'unknown';              // could not be classified from a structured signal — never guessed

/** Provider limit observations (plain data). Lanes populate what the vendor exposes; ops never read them. */
+export interface ProviderSignals {
+  retryAfterMs?: number;  // from a Retry-After (or vendor equivalent) on this response
+  /** Every limit window the provider reported on this response; several may be live at once. */
+  windows?: Array<{
+    id: string;           // provider window id, e.g. '5h' | '7d' (claude unified-*), 'weekly', 'requests' | 'tokens'
+    utilization?: number; // fraction of the window used, 0–1 (percent sources are divided by 100)
+    remaining?: { requests?: number; tokens?: number }; // where the provider reports counts
+    resetAt?: string;     // ISO-8601 instant this window resets
+  }>;
+}

export interface WorkerResult {
  // …v1 fields unchanged…
+ /** Only on stopReason === 'error' (same one-directional rule as `error`). */
+ errorClass?: WorkerErrorClass;
+ /** Allowed on any stopReason. Field set closed at acceptance. */
+ providerSignals?: ProviderSignals;
}

/** Pre-dispatch throws (the only throws the seam allows) carry a class too. */
+export type DispatchErrorClass = 'config' | 'auth';
+export function errorClassOf(err: unknown): DispatchErrorClass | undefined;
+export const SEAM_VERSION = 2;
```

**Two separate `errorClass` rules.**

- **Wire rule (strict mirror, permanent):** `errorClass` present ⇒ `stopReason === 'error'`. Like the `error` rule
  it is one-directional, so v1 records and unclassified `error` verdicts still parse.
- **Producer rule (enforced by conformance, not the schema):** every `error` verdict a v2 driver produces carries
  `errorClass`.

**Classification rules.**

- Classes come from **structured signals**: HTTP status or SDK error class, CLI exit code or signal, protocol fields.
- Free-text matching is allowed only where the vendor exposes no structure, and only with anchored patterns.
- Anything unresolved is `unknown`, never `transient`.
- `error` stays bounded, redacted text for humans. The `<lane> driver: [token]` prefix is **no longer a contract**;
  consumers switch to `errorClass`.
- **Limit cuts are structural:**
  1. Status code plus the provider's error code outrank message text.
  2. A provider error code in the funded-allowance set is `quota`, whatever its HTTP status: Anthropic
     `enforced_spend_limit_reached` (429, no `retry-after`), OpenAI `insufficient_quota` / `credit_balance_exhausted` /
     `*_spend_limit_exceeded` (429), HTTP 402 (DeepSeek, OpenCode Zen),
     and the Z.AI coding wire's 429. A bare "429 ⇒ rate limit" rule misclassifies these.
  3. On the Claude lanes, the `anthropic-ratelimit-unified-*` headers (or the CLI/SDK "You've hit your … limit ·
     resets …" result) separate a plan limit (`quota`) from a throttle (`rate-limit`). This precedes rule 4, because
     a subscription-quota 429 can carry `retry-after`.
  4. Otherwise a 429 **with** `retry-after` is `rate-limit`.
  5. **Producer rule for `quota`:** the verdict carries `providerSignals.windows[*].resetAt` whenever a reset is
     extractable. Without a reset, consumers treat `quota` as needs-human.
- The enum values and the `ProviderSignals` field set are closed for this bump. Later provider-limit work (W2.6)
  changes only the per-lane mapping from signals to classes and fields.

### 2.3 Uniform structured output (all lanes)

When `invocation.outputSchema` is set:

| Run outcome                                                          | Verdict                                                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Object obtained and it validates against `schema`                    | `complete`. `structuredOutput` = the validated plain JSON                                             |
| Object missing, unparseable or invalid, after the lane's repair step | `stopReason:'error'`, `errorClass:'output-invalid'`, usage/cost kept, rejection recorded in narration |
| A cap or the signal stopped the run first                            | `budget` / `aborted` (carve-out: the missing object is a consequence, not the cause)                  |

When no schema is requested, `structuredOutput` MUST be absent.

**Per-lane transport and repair.** The _verdict_ is uniform; the transport stays native.

- **ai-sdk:** `Output.object` over the JSON Schema, keeping the step-7 tool cutoff. It MUST make **one** bounded
  repair request before giving up: tool-free, over the session transcript, schema restated, `maxRetries: 0`, inside
  `budget` and `signal`.
- **claude-agent:** native `outputFormat` `json_schema` (the SDK validates and retries).
- **subprocess:** `--json-schema` (the CLI validates and retries).
- **acp:** prompt-directed JSON. It MAY make one "reply with only the JSON" follow-up turn in the same session.
- **All lanes:** validate after settle with the shared validator in
  [src/driver/common/structured.ts](../../src/driver/common/structured.ts), over the same stripped schema that was
  sent.

### 2.4 Workspace binding

| `workspace` | `sessionRef` | Behaviour                                                                                                  |
| ----------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| absent      | absent       | Fresh temp workspace and fresh record (I6, unchanged)                                                      |
| set         | absent       | Fresh session record **created in `realpath(workspace.path)`**. Tools, cwd and path confinement bind to it |
| absent      | set          | Load the record and reuse its workspace (unchanged)                                                        |
| set         | set          | Load the record. It MUST record the same realpath, **else throw pre-dispatch** (`errorClassOf → 'config'`) |

- The path must be absolute and name an existing directory, else the driver throws pre-dispatch (`config`).
- Session sidecars, including acp's, stay in `sessionsDir` and never in the workspace, where the worker could tamper
  with them.
- `workspace` is the P1 binding; prompt text naming a path confers nothing. Where `workspace.path` comes from plan
  data (for example fixItem's `input.worktree.path`), the op's P1 checklist names it.
- **Record retention** for the fresh record a workspace-bound run creates is a factory concern
  (`DriverRequest.sessionRetention`, §2.5), not a seam field.

### 2.5 Driver construction and `DriverFactory`

```ts
// src/driver/factory.ts (new; driver family — no kernel import)
+export type LaneId = 'ai-sdk' | 'claude-agent' | 'subprocess' | 'acp';
+export type WorkerRole = 'fixer' | 'conflict-resolver' | 'remediator' | 'classifier' | (string & {});

+export interface DriverRequest {
+  role: WorkerRole;
+  modelSpec: ModelSpec;
+  harness?: HarnessConfig;                       // command/path restrictions ToolPolicy (names only) cannot carry
+  sessionRetention?: 'keep' | 'reap-on-settle'; // fresh records of workspace-bound runs; default 'keep'
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
  `createDriverFactory()` with the resolved project config; tests inject a factory that returns fakes.
- **Ops put `resolved.modelSpec` on the invocation**, never the input's spec, so the deprecated `'ai-sdk'` alias
  never reaches a lane or a journal.
- **Default bindings (conservative, P8):** every role binds to `ai-sdk` for the providers that lane supports (`zai`,
  `anthropic`, `openai`, `deepseek`). An unknown provider throws `config`. `subprocess` is never a silent default: it
  is bound explicitly, and only after W1.4 closes its tool surface. `claude-agent` and `acp` are bound explicitly.
  §3 gives the before → after table.
- **Session retention:** `'reap-on-settle'` deletes only the fresh record that the factory's lane created for that
  run, after it settles, whatever the verdict. `keep` (the default) leaves it for `sessionRef` resume and for the
  "see the session record" pointers in op results. `review.fixItem` requests `reap-on-settle`, preserving its
  existing behaviour unless retention is configured.
- **Deprecated alias:** `provider: 'ai-sdk'` normalises to `{lane: 'ai-sdk', provider: 'zai'}`, with a `cq:` stderr
  notice. It is removed in the next major.
- **Retired:** the lane constructors' `outputSchema` option; `worktreeFixDriver` and `FixDriverSource.perHarness`
  (replaced by `workspace` plus `DriverRequest.harness` and `sessionRetention`); every lane construction under
  `src/ops/**`, static or via dynamic `import()`; and `sweep.unit`'s plan-JSON `driver.binary`/`routingTable`, which
  move to `DriverFactoryConfig.lanes.subprocess` because plan data never names an executable (P1).
- **Direct lane use.** The lane classes stay exported on the **`./driver`** subpath (the four lanes, routing,
  pricing, process helpers and seam types; `.` stays the full barrel for v1.1). Such callers own the served-model
  wrapping (§2.6). A driver that no factory issued has no `ResolvedDriver.lane`, and ADR-0003 MUST classify it
  **ADVISORY**, so it is refused unattended by default (P8, `CQ_BUDGET_ALLOW_ADVISORY=false`). This is what makes
  "ignore unknown `Budget` fields" (§2.7) safe.

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

This section replaces ADR-0001's served-model rule.

- **Where it applies:** `createDriverFactory` applies the wrapper to every resolved driver; that is the **one** hook
  for toolkit dispatch. Direct lane constructions must wrap explicitly. Lanes only _observe_ (`WorkerResult.model`);
  ops and the governor never assert.
- **Normalisation is lane-declared and anchored.** ai-sdk, claude-agent and subprocess normalise by identity. acp
  strips exactly one leading `builtin:<provider>\` namespace (the form its harness reports) and case-folds.
  `WorkerResult.model` keeps the **raw** observation (v1 meaning unchanged). The wrapper's narration records
  `{requested, raw, normalised, via: 'exact' | 'alias' | 'unobserved-allowed'}`.
- **Scope:** the wrapper judges only `stopReason:'complete'` results.
- **Pass** on any one of:
  - `normalise(model) === normalise(modelSpec.model)`;
  - the normalised pair is a declared alias **for this lane**;
  - no id was observed and `requireObserved[lane] === false`. This relaxation is recorded, and it never admits an
    _observed_ mismatching id.
- **Fail:** the verdict is rewritten to `stopReason:'error'`, `errorClass:'served-model-mismatch'`, with
  `error: "requested <x>, served <raw|unobserved>"`. `structuredOutput` is dropped. `usage`, `costUSD`, `costBasis`,
  `sessionId`, `denials` and `providerSignals` are **kept**, because the spend was real.
- **No off switch.** No mode turns mismatches into narration. A remap is either declared (an alias, recorded) or it
  fails.
- **Retired:** the subprocess lane's pre-dispatch model allowlist, which cannot catch a server-side remap. The
  wrapper replaces it, so there is no window without a remap defence.
- **A normalised acp mismatch is a finding, not something to configure away** (e.g. `builtin:bigmodel\GLM-5.3` for a
  `glm-5.3-flash` request): the eval requests what that harness serves, or the owner declares a recorded alias.
- **One alias source of truth.** `ServedModelPolicy.aliases` is the only served-id alias table: W3.5's pricing
  normaliser and ADR-0003 §2.2 step 1's `W_max` alias set **read it** and keep none of their own. Provider profiles
  (`ProviderProfile.modelLimits[*].servedAliases`) populate its lane-scoped **built-in** layer (P7). Which vendor
  remaps ship built in is open (open point O-2; candidates include `deepseek-chat` → `deepseek-flash` and Anthropic
  dated ↔ alias ids); until then the built-in layer is empty (§3).
- **Budget classification depends on this policy.** A lane configured `requireObserved: false` can serve any model
  unobserved, so the `W_max` alias-set maximum does not bound it. ADR-0003 MUST classify such a lane **ADVISORY** for
  USD.

### 2.7 `Budget`: the ADR-0003 pass-through

- `Budget` stays the per-invocation cap contract the driver enforces. ADR-0003 MAY add optional **cap** fields to it
  **within this same types bump**; ADR-0002 reserves no names there.
- **The reservation is not a `Budget` field.** It is runtime-only, so it rides `RunOptions.reservation` (§2.1).
- Driver obligations:
  - report `usage` on every exit path, including abort and error;
  - return `stopReason:'budget'` for any cap the driver enforces;
  - **ignore unknown optional `Budget` fields rather than reject them.** Whether a lane _enforces_ a field is
    ADR-0003's lane classification, keyed on `ResolvedDriver.lane`; lane-less drivers are ADVISORY (§2.5), so an
    ignored cap fails closed at admission, not open at dispatch.
- **Observations flow back through ADR-0003's invocation gate**, which settles every factory-resolved
  `WorkerResult` (one reservation = one `Driver.run`). It records `errorClass` and `providerSignals` on
  `reservation-settled` (ADR-0003 §2.2 step 9; the journal annex §2), where class-aware rescue and W2.6 admission
  read them. **Ops forward nothing**; the v1 `reportResult` fold is not the channel (ADR-0003 deletes it).
- **Ungoverned callers** (outside a governed scope, e.g. cq-fixtures) read them from the `WorkerResult` itself.

### 2.8 Mirrors, version, conformance

- **Strict zod mirrors** ([src/kernel/schema.ts](../../src/kernel/schema.ts)): `OpInvocationSchema` adds
  `outputSchema` and `workspace` and stays typed `z.ZodType<OpInvocation>`. `WorkerResultSchema` adds `errorClass`
  with the one-directional refinement of §2.2 and a strict optional `providerSignals`; the `error` rule is unchanged.
- **`SEAM_VERSION = 2`**, exported from the seam barrel, is shared with ADR-0003's runner and journal changes: one
  package minor, one types bump.
- **The conformance suite ships from `./driver`** (no `./testing` entry in v1.1) as
  `runDriverConformance(makeDriver, runner)` v2. It is runner-agnostic (the caller injects
  `runner = { describe, test, expect }`, so `vitest` stays a devDependency) and imports nothing from the kernel (the
  ladder-abort leg b-ii needs `runLadder`, so it stays a kernel test). `makeDriver` no longer receives
  `outputSchema`. P2 allows exactly one conformance-suite bump, so this packaging is frozen surface.
- **Freeze point.** `SEAM_VERSION = 2` and conformance v2 freeze when S6, W2.2 **and W2.3** (ADR-0003's `Budget`
  fields and their enforcement legs) have all landed. W3.1's API-report baseline is generated after that point.
- Old journals replay unchanged and parse through the v2 mirror: every addition is optional, and the `errorClass`
  rule is one-directional.

### 2.9 Consumer contract: driver outcome → `OpResult` status (normative)

Every op that runs a driver maps throws and `error` verdicts this way. The table deliberately **preserves existing
statuses** wherever behaviour was already defined. Class-aware retry is a runner policy (ADR-0003,
[src/kernel/rescue.ts](../../src/kernel/rescue.ts)) fed by the structured class on `reservation-settled` (§2.7), not
an op-status relabel.

| Driver outcome                                                                                                                       | `OpResult.status` | Notes                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run()` throws, signal aborted                                                                                                       | `indeterminate`   | unchanged (I8)                                                                                                                                                        |
| `run()` throws, `errorClassOf` = `config` or `auth`                                                                                  | `needs-human`     | the existing rule, already used by resolveConflict/fixItem                                                                                                            |
| `run()` throws, unclassified                                                                                                         | `needs-human`     | same rule. A post-dispatch throw is a lane bug that conformance catches                                                                                               |
| `stopReason:'error'`, **any** `errorClass` (including `transient`, `rate-limit`, `quota`, `served-model-mismatch`, `output-invalid`) | `failed`          | the failure text names the class (`errorClass=<x>`) for humans only. The structured class reaches the runner on `reservation-settled` (§2.7); nothing parses the text |
| `stopReason:'aborted'` / `'budget'`                                                                                                  | unchanged per op  | out of scope (sweep's existing all-non-complete → `failed` stays; W4.x)                                                                                               |
| `complete` whose `structuredOutput` fails the op's own strict parse                                                                  | `failed`          | unchanged                                                                                                                                                             |

**Why provider-failure classes stay `failed`.** Relabelling `transient`/`rate-limit`/`quota` as `indeterminate`, or
`served-model-mismatch` as `needs-human`, would gain nothing: `indeterminate` and `failed` both re-run on resume and
both report as JobState `failed` ([src/kernel/runner.ts](../../src/kernel/runner.ts)), so the relabel would only
perturb status-keyed rescue rows and the journal fold. Class-aware policy keys on the structured class instead.
`CONSERVATIVE_RESCUE_POLICY` has no class-aware rows yet; adding any is W2.6 and rescue work, not this ADR.

## 3. Consequences

**Good.** Ops stop constructing lanes, so one driver instance serves any role and schema. The kernel ↔ driver
dependency direction is restored, the prompt-text workspace workaround disappears, and the two §1 defects become
contract. ADR-0003 gets its lane key, its `Budget` extension point and an observed-limits channel, with no second
break.

**Notable behaviour changes.** The owner signed these off at acceptance:

1. **Uniform `output-invalid`**, including agentic remediation's `ok` → `failed` change and the change to how
   cq-fixtures scores fixer rows (below).
2. **A fail-closed served model** with only the two lane-scoped relaxations (§2.6), and acp remaps treated as
   findings, including the `deepseek-chat` default consequence (below) until the built-in alias layer is decided.
3. **`ProviderSignals` and the limit classes** (§2.2): `rate-limit` / `quota` / `provider-error`, the structural 429
   cut and the multi-window shape.
4. **The default lane flip** to ai-sdk for four ops, with the owner's Claude route via an explicit `claude-agent`
   binding (below).

**Op-level status changes.** These are all the op-visible changes; every other outcome keeps its v1 status (§2.9).

| Op                                        | Case                                                                                           | v1 status                                                         | v2 status                                        | Lands in                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `analyze.agenticRemediation`              | `complete` with a missing or invalid proposal                                                  | `ok` (value = the bare `WorkerResult`)                            | `failed` (lane returns `error`/`output-invalid`) | **S3**: the op is still bound to subprocess with a constructor schema, which S3 unifies too |
| `analyze.agenticRemediation`              | pre-dispatch throw (`config`/`auth`/unclassified)                                              | `indeterminate`                                                   | `needs-human`                                    | S4                                                                                          |
| all four driver ops                       | `complete` whose served id differs (normalised, no lane alias) or is unobserved where required | `ok` or the op's usual `complete` path (subprocess only narrates) | `failed` (`served-model-mismatch`)               | S4                                                                                          |
| `merge.resolveConflict`, `review.fixItem` | claude-agent/subprocess/acp `complete` without a valid object                                  | `failed` (the op's own parse)                                     | `failed` (`error`/`output-invalid`)              | S3. **Status unchanged**, different path                                                    |
| `sweep.unit`                              | — (no `outputSchema`)                                                                          | —                                                                 | unchanged                                        | —                                                                                           |

**Default lane, before → after.**

| Op                           | Provider           | v1 lane                          | v2 default lane                                                              |
| ---------------------------- | ------------------ | -------------------------------- | ---------------------------------------------------------------------------- |
| `merge.resolveConflict`      | `'ai-sdk'`         | ai-sdk                           | ai-sdk (alias → `zai`)                                                       |
| `merge.resolveConflict`      | any other          | **subprocess** (Claude Code CLI) | **ai-sdk** for `zai`/`anthropic`/`openai`/`deepseek`; other → `config` throw |
| `review.fixItem`             | `'ai-sdk'` / other | ai-sdk / **subprocess**          | as resolveConflict                                                           |
| `analyze.agenticRemediation` | any                | **subprocess**                   | **ai-sdk**                                                                   |
| `sweep.unit`                 | any                | **subprocess** from plan data    | **ai-sdk** unless config binds subprocess                                    |

- `{provider:'anthropic'}` moves from the Claude Code CLI's own endpoint to `@ai-sdk/anthropic`, which **requires
  `ANTHROPIC_API_KEY`**. Without one, those calls throw `config` pre-dispatch and the op returns `needs-human`: loud,
  but a behaviour change. The owner's supported Claude route under v2 is an explicit `anthropic → claude-agent`
  binding (or `→ subprocess` once W1.4 has closed its tool surface), shipped in the `solo-maintainer` profile
  (Annex B).
- `{provider:'zai'}` moves from the CLI over Z.AI's Anthropic-compatible route to the in-process lane on the coding
  `paas/v4` endpoint: a different harness, tool surface and wire.
- Rationale for the default (P8): the subprocess lane's tool surface is open until W1.4 closes it, so it must not be
  a silent default for write-capable roles.

**Other costs.**

- cq-fixtures scoring changes on the ai-sdk fixer rows only. Other totals stay comparable **per scored row**, but a
  served-model mismatch is now an absence (no row), so `expectedCases` coverage can drop wherever a served id differs
  (on acp, possibly every row until the remap finding is resolved).
- **`deepseek-chat` fails by default.** Under the default binding, identity normalisation and an empty built-in
  alias layer, every `{provider:'deepseek', model:'deepseek-chat'}` request becomes `failed`/`served-model-mismatch`,
  because the wire serves `deepseek-flash`. Anthropic dated and alias ids behave the same way wherever they differ.
  cq-fixtures requests served ids and is unaffected; SDK callers are affected.
- The driver family needs a JSON Schema validator: zod's own importer if zod 4.6.4 has one, else a pinned `ajv`.
- Unattended acp runs fail when the harness reports no served id (unless `requireObserved.acp = false`) or a
  differing normalised id (a finding, §2.6).

**Not changed** (P2: no other seam changes).

- `ModelSpec`, `ToolPolicy`, `SandboxPolicy`, `Usage`, `DriverStopReason` (still four values).
- `Driver.run`'s return type and first parameter; the only signature change is the optional `RunOptions`
  parameter. The name `RunOptions` collides with the kernel's existing `RunOptions` on the `.` barrel; the rename
  was left open at acceptance (open point O-1).
- The op contract `Op<I,R> = (input) => Promise<OpResult<R>>` and the `OpResult` status set.
- The journal event shapes (ADR-0003 owns those).

## 4. Landing

Six risk-ordered internal slices (S1–S6), each keeping `main` green:

1. Types, mirrors, `SEAM_VERSION`, and conformance legs added as _pending_.
2. Lanes honour `RunOptions.signal` and the `workspace` invocation field, with a temporary ambient fallback.
3. `errorClass`, uniform structured output in all four lanes, and the ai-sdk repair step.
4. `DriverFactory` plus the served-model wrapper; ops, e2e tests and scripts migrated.
5. cq-fixtures pinned to the slice-4 commit and migrated.
6. Removals: constructor `outputSchema`, the ambient fallback, `worktreeFixDriver`, and sweep's plan binary. Then
   conformance v2 becomes mandatory (freeze point: §2.8).

Nothing is published until W7.1.

## 5. Alternatives rejected

- **A zod object on the seam:** not plain data, and it ties the seam to one library; the seam carries JSON Schema.
- **Keeping the ambient signal:** it inverts the dependency direction and leaves ungoverned drivers uncancellable.
- **`signal` as an `OpInvocation` field:** it breaks the plain-data invariant.
- **`workspace.sessionRef`:** binding the workspace through a session record is the workaround §1 removes.
- **`lane` on `ModelSpec`:** it repeats the provider overloading of §1; lane choice is a factory binding.
- **Per-lane, op-level or governor-level served-model checks:** one factory-applied wrapper is the single hook.
- **A served-model `record` mode:** an unscoped off switch.
- **`complete`-without-object as the uniform verdict:** it hides a model failure as success.
- **Relabelling provider-failure classes to `indeterminate`/`needs-human`:** no behavioural gain on resume (§2.9).
- **W2.6 limited to config profiles, with no observed-signal channel:** it contradicts D5's budgets from response
  headers where the provider exposes them.
- **Forwarding `errorClass`/`providerSignals` through the ops' `reportResult` fold:** ADR-0003 deletes the fold, and
  its type (`{usage?, costUSD?}`) cannot carry the fields.
- **The reservation as a `Budget` field, excluded by a named persisted/hashed projection:** runtime-only data
  belongs on `RunOptions`.

## 6. Hand-offs

What [ADR-0003](0003-governed-runner.md) takes from this record, beyond §2.5–§2.7: its §2.2 step 7 dispatches via
`RunOptions` as `driver.run(inv', { signal: any(options.signal, jobSignal, tripSignal), reservation })`, where `inv'`
differs from `inv` only in `budget.maxUsd`.

## Annexes

- [Annex A — MCP harness server](0002-annex-a-mcp-harness.md): the read/edit/run harness shared by two lanes.
- [Annex B — configuration keys](0002-annex-b-config.md): the factory bindings (including the `solo-maintainer`
  profile), served-model policy, session retention and lane knobs, under P7 precedence and P8
  blank-means-conservative; no key disables the served-model comparison.
