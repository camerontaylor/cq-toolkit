// The first-party in-process driver — T1.4 slice 2 (the toolkit's own
// worker on the FROZEN Driver seam: run(opInvocation) → Promise<WorkerResult>).
//
// EXECUTION MODEL (R2): in-process. Per-op isolation comes from the kernel
// process model (each op invocation is governed alone by the budget
// governor) plus a FRESH WORKSPACE per fresh invocation (below) — this
// driver adds no daemon, no pooling, no shared worker state.
//
// I8 SEAM — the driver owns NO wall clock. The driver-hygiene scan bans
// driver-owned scheduling primitives under src/driver/**: WHEN to abort is
// the governor's decision (T1.3), and this driver only OBEYS. The run's
// ONLY cancellation SOURCE is `RunOptions.signal` (seam v2, ADR-0002 §2.1)
// — the caller passes the governed rung-1 signal explicitly; a lane that
// consulted ambient state instead would abort runs its caller never
// cancelled. The signal rides the SDK call's `abortSignal` option; an
// already-aborted signal never dispatches
// (stopReason 'aborted', zero usage, no session state created). Without a
// signal the SDK call is simply not wired to a
// cancellation source. Consequences, documented:
//   - Budget.wallClockMs is IGNORED here — the governor's escalation ladder
//     is the wall-clock owner; a driver-owned deadline would duplicate and
//     races it. The SDK call's `timeout.stepMs`
//     (DEFAULT_STEP_TIMEOUT_MS) is NOT a run deadline — it bounds one step
//     (model call, its retry and tool runs) so a hung step cannot stall the loop; WHEN to abort the
//     RUN remains the governor's decision.
//   - Budget.maxTokens is ENFORCED here, timer-free: it becomes a
//     `stopWhen` stop condition over the SDK's accumulated step usage (a
//     pure token fold — no scheduling primitive involved).
//   - The main tool loop is ALWAYS step-bounded with
//     `stepCountIs(min(maxSteps ?? DEFAULT_MAX_STEPS, DEFAULT_MAX_STEPS))`;
//     the tool set is fixed per session: the final schema step adds a
//     "final step: reply with only the JSON" turn (calls on it are denied),
//     and the separate structured-output repair may add one completed step.
//   - The prompt budget applies to the caller-owned user prompt, which is
//     sent once as a user turn. The system message contains only driver-owned
//     tool-aware guidance.
//   - Budget.strictTokenBudget (OPT-IN, separate from maxTokens) adds a
//     BINDING pre-request ceiling: `pre-request-ceiling.ts` wraps the
//     resolved model so every wire attempt counts the full request and
//     reserves input + reserved output before the send. It requires an
//     operator-injected `AiSdkDriverOptions.strictTokenCapability` (there is
//     NO built-in/provider-list capability — production refuses a strict
//     budget until a deployment injects a proven one). A refusal that means a
//     REAL token cap (input ceiling, output reserve, shared whole-job
//     allowance) settles as stopReason 'budget'; a capability/serialization/
//     durable-hook failure settles a diagnostic stopReason 'error' (never hid
//     as budget-exhausted), and a governed abort settles 'aborted'. It does NOT
//     redefine maxTokens.
//   - Budget.maxAttempts is the runner/governor's retry business; this
//     driver makes exactly ONE attempt per run.
//   - Budget.maxUsd is caller-side derived accounting (USD is never
//     driver-trusted); ignored here.
//
// PROVIDER INSTANCES (seam rule): providers are imported DIRECTLY and
// instantiated as real language-model objects — never gateway string ids.
// The registry { anthropic, openai, zai, ai-sdk, deepseek, opencode-go }
// maps the frozen ModelSpec.provider handle onto the matching @ai-sdk
// factory; the model id rides ModelSpec.model. UNKNOWN PROVIDER THROWS
// BEFORE DISPATCH (and before any session is created) — fail loudly, never
// guess. Production default builds instances lazily at run() time with API
// keys read from the environment AT CALL TIME (ANTHROPIC_API_KEY /
// OPENAI_API_KEY / ZAI_API_KEY / DEEPSEEK_API_KEY / OPENCODE_GO_API_KEY; a
// missing key throws a clear error before dispatch). For testability the
// constructor accepts a `providers` override map (name → (modelId) =>
// language-model instance); the conformance suite injects a mock there and
// never touches the network.
//
// I6 ISOLATION via the harness session store (src/harness/session.ts):
//   - NO sessionRef → `tempWorkspace()` (fresh scratch dir) +
//     `SessionStore.create()` — a fresh record with zero messages in a
//     workspace nothing has ever touched: the invocation shares NOTHING
//     with a previous one. When the invocation carries a `workspace`
//     binding (ADR-0002 §2.4), the fresh record is instead created IN
//     realpath(workspace.path) and the tools bind there; a workspace set
//     alongside a sessionRef must record the SAME realpath (else a
//     pre-dispatch config throw). Session records stay in the lane's
//     sessionsDir — never inside the workspace.
//   - sessionRef → `SessionStore.load(sessionRef)`; the record's workspace
//     AND message history continue. A missing/unknown session throws a
//     clear error (a fake resume is worse than a loud one).
//   - Every turn is persisted in OUR vocabulary (SessionMessage — never
//     vendor message shapes): the user prompt, each tool result
//     (role 'tool', toolName, JSON content), and the final assistant text.
//   On resume, prior history is replayed as plain user/assistant text;
//   tool turns are folded into the transcript as readable text lines
//   (our shapes are canonical and vendor tool-call ids are not persisted,
//   so faithful vendor-side tool-call replay is impossible by design).
//
// TOOL LOOP: harness `buildTools(config, record.workspace,
// sandboxPolicy.level)` descriptors are adapted to the SDK tool format
// (`tool({ description, inputSchema, execute })` — zod schemas pass
// through). The frozen ToolPolicy filters the surface per-op: mode
// 'allowlist' (the default reading) keeps only `policy.allow` names,
// 'unrestricted' keeps all harness tools, 'none' sends no tools at all.
// Every harness denial is BOTH returned to the model as the tool's output
// text (the reason — the model can adapt) AND accumulated verbatim
// ({ tool, reason }) into WorkerResult.denials.
//
// STRUCTURED OUTPUT (seam v2, ADR-0002 §2.3): the schema rides the
// INVOCATION (`OpInvocation.outputSchema` — a plain `OutputSchema` {name,
// schema: JsonSchema document}). The document is wrapped with the ai SDK's
// native `jsonSchema(...)` helper and handed to `Output.object` — so the
// wire transport is the SDK's structured output over the EXACT document the
// invocation carried, and the after-settle judgment is the SHARED validator
// (`validateStructured` from ../common/structured.js) over that same
// document. There is NO construction-time schema: the invocation is the
// only schema source (S6), so ONE validator and one verdict rule judge every
// lane the same way. Verdict table (ADR §2.3):
//   - object obtained and it validates  → 'complete', structuredOutput =
//     the validated plain JSON;
//   - missing / unparseable / invalid after ONE bounded repair request
//     (W3.4: no tool execution, over the session transcript, the JSON Schema
//     restated, maxRetries 0, inside the same Budget.maxTokens remainder
//     and the same signal) → 'error', errorClass 'output-invalid', usage
//     and derived cost KEPT (both calls' usage lands in the verdict);
//   - a cap or the signal stopped the run first → 'budget' / 'aborted'
//     (the missing object is a consequence, not the cause);
//   - no schema requested → structuredOutput is ABSENT even when the reply
//     text looks like JSON.
// A provider-level finish (finishReason 'error'/'content-filter') that
// leaves no usable object is NOT a model output outcome: it classifies as a
// provider cause and skips the repair (a repair call cannot fix a provider
// failure).
//
// USAGE MAPPING (exact ai@7.0.99 `LanguageModelUsage` fields → frozen
// Usage): inputTokens / inputTokenDetails.noCacheTokens → input (details
// win: non-cached input keeps cache terms from double-counting; without
// details the total input is used with cache fields at 0, which is the
// same arithmetic), inputTokenDetails.cacheReadTokens → cacheRead,
// inputTokenDetails.cacheWriteTokens → cacheWrite, outputTokens → output.
// reasoning is OMITTED on this lane: the AI SDK counts reasoning tokens
// INSIDE outputTokens (totalTokens = inputTokens + outputTokens), so a
// separate field would double-count every total that sums the frozen Usage
// fields vs the SDK's own totalTokens. Missing numeric fields map to 0.
//
// MODEL OBSERVATION: WorkerResult.model carries `result.response.modelId` —
// the SERVED model id the provider's response reports (the SDK prefers it
// over the requested id), which the shared conformance suite checks against
// the requested model (the silent-remap defence).
//
// STOP REASON (frozen DriverStopReason) — mapping table, checked in order:
//   1. the run signal fired (already-aborted at entry, mid-run through the
//      SDK's abortSignal, or an abort-shaped throw) → 'aborted'
//   2. token budget tripped (the Usage token fold — input+output+cache+
//      cacheWrite, reasoning counted once via output — >= Budget.maxTokens)
//      or SDK finishReason 'length'   → 'budget'
//   3. SDK finishReason 'error' or 'content-filter', or the run threw  →
//      'error'
//   4. otherwise ('stop' | 'tool-calls' | 'other') → 'complete'
// A caught throw returns stopReason 'error' (never throw past the seam
// mid-run): the result keeps the usage of every completed step (folded via
// onStepFinish — all-zero only when truly nothing completed) plus the
// denials + sessionId gathered so far, and the caught cause's message rides
// WorkerResult.error so a failing lane surfaces loudly instead of as a bare
// 'error'. Only PRE-DISPATCH validation (unknown provider, missing key,
// over-budget op prompt, unknown sessionRef) throws.
//
// ERROR CLASSES (seam v2, ADR-0002 §2.2): every error verdict carries
// `errorClass`, classified ONLY from structured signals —
// APICallError.statusCode, the provider error code, and the SDK error class
// name — in the ADR's cut order (code + status outrank message text; a
// funded-allowance code is 'quota' whatever the status; anything unresolved
// is 'unknown', NEVER a guessed 'transient'). The old free-text token
// prefix contract (`[structured-output-miss]` / `[endpoint-timeout]`) is
// retired: consumers read `errorClass`. `WorkerResult.error` stays bounded,
// redacted human text. Provider limit observations ride `providerSignals`
// (allowed on ANY verdict): from APICallError.responseHeaders on failures
// and from the response metadata headers on successes.
//
// TRANSIENT RETRY (#210): the generateText call runs
// `maxRetries: 1` — ONE retry per step request (bounded; ≤ DEFAULT_MAX_STEPS
// per run) for the SDK-retryable transient class (endpoint header timeout /
// network). This is a deliberate, recorded
// deviation from the earlier "no driver-side retries" note: the classifier
// cell on the same endpoint is healthy, so a single retry recovers the
// endpoint hiccup; the SDK's own retry machinery classifies retryability
// and its exhausted-retry error names the attempt count and the last error
// (`Failed after N attempts. Last error: …`), so the cause still reaches
// WorkerResult.error. Each step of the tool loop is also bounded by
// DEFAULT_STEP_TIMEOUT_MS (a hung step cannot stall the loop); that
// step-timeout abort is NOT SDK-retryable and therefore
// classifies as 'transient' (the TimeoutError error class name).
//
// COST (DD-2, derived-only): costUSD is computed over the OBSERVED served
// model id ({ ...modelSpec, model: servedModel ?? modelSpec.model } — a
// silently-remapped gateway is priced off the id the response reports;
// the provider handle stays ModelSpec.provider, the price table's key) —
// derived whenever the SDK returned a FULL result usage: the success path
// (whatever stop reason it maps to) and the structured-output miss, whose
// result usage is equally whole. A mid-run THROW keeps only the partial
// per-step fold — which understates the run — so it reports NO costUSD
// (never fabricate: 0 would be as invented as any other number), as does
// an id the price map (src/driver/pricing; overridable via the `pricing`
// constructor option) does not know. The derived figure is api-equivalent
// (modeled — list price for the tokens consumed), never presented as billed
// (DD-9; docs/dd-9-api-equivalent-budget.md). The driver never fabricates
// or reports trusted USD.
import {
  APICallError,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  InvalidToolInputError,
  Output,
  stepCountIs,
  wrapLanguageModel,
  tool,
} from 'ai';
import type {
  FinishReason,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  StopCondition,
  Tool,
  ToolSet,
} from 'ai';
import type { JSONSchema7 } from '@ai-sdk/provider';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createZai } from '@ai-sdk/zai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { deepFreeze } from '../../shared/deepFreeze.js';
import { defaultHarnessConfig } from '../../harness/config.js';
import type { HarnessConfig } from '../../harness/config.js';
import {
  buildTools,
  AdvertisedToolInputSchemas,
  normalizeToolInput,
  canonicalToolName,
  probeRgVersion,
  RG_MINIMUM_VERSION as HARNESS_RG_FLOOR,
} from '../../harness/tools.js';
import { harnessRunGate } from '../../sandbox/index.js';
import type { SandboxConfig } from '../../sandbox/index.js';
import type { ToolkitTool, ToolExecuteOptions } from '../../harness/tools.js';
import { SessionStore, tempWorkspace } from '../../harness/session.js';
import type { SessionMessage, SessionRecord } from '../../harness/session.js';
import { invalidToolInput, toolFailureKind } from '../../harness/failures.js';
import type { ToolFailureKind } from '../../harness/failures.js';
import { boundedErrorText, describeError } from '../error-text.js';
import { DispatchError } from '../errors.js';
import { boundWorkspacePath, resumedRecordOrThrow } from '../common/workspace.js';
import {
  compileOutputSchema,
  uncompilableSchemaVerdict,
  validateStructured,
} from '../common/structured.js';
import { priceOf } from '../pricing/index.js';
import type { PerMillionRates } from '../pricing/index.js';
import {
  isPreRequestCeilingRefusal,
  PreRequestCeiling,
  wrapWithPreRequestCeiling,
} from './pre-request-ceiling.js';
import type { StrictTokenCapability, WireReservation } from './pre-request-ceiling.js';
import type {
  Budget,
  Driver,
  RunOptions,
  ToolDenial,
  ToolPolicy,
  Usage,
  WorkerResult,
} from '../types.js';
import type { ModelSpec, OpInvocation } from '../types.js';
import type { OutputSchema, ProviderSignals, WorkerErrorClass } from '../types.js';
import { defaultSessionsDir } from '../sessions-dir.js';
import { createStepFetch } from './step-fetch.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** A provider factory: model id and optional persisted session id → a live language-model instance. */
export type ProviderFactory = (modelId: string, sessionId?: string) => LanguageModel;

/**
 * The multi-step default for the SDK tool loop (ai@7.0.99). TOOL-CALL LOOPS
 * NEED MULTI-STEP: without an explicit `stopWhen` the SDK's default is
 * `stepCountIs(1)` — the run would return after the FIRST tool-calls step,
 * so tool calls would never be followed up. 40 steps bounds the loop as a
 * runaway guard (a misbehaving model cannot loop forever; owner 2026-10-25:
 * budgets stop runaways, not good-faith work) while remaining a
 * pure STEP COUNT, not a scheduling primitive (I8: WHEN to abort on time is
 * still the governor's ladder; Budget.maxTokens is the token-side bound).
 */
export const DEFAULT_MAX_STEPS = 40;

/**
 * Wall-clock bound for EACH step of the SDK tool loop (`timeout.stepMs`,
 * ai@7.0.99). ai's generateText arms ONE timer per loop iteration
 * (`setAbortTimeout`, dist/index.js ~5810) and clears it only after the step's
 * tool execution (~6286), so it covers the model call INCLUDING its SDK retry
 * and the step's tool runs — not a single HTTP request, and not the whole turn
 * (`timeout.totalMs`, unset here). It is NOT a run deadline — the governor
 * and the review wall budget own that (I8; Budget.wallClockMs is ignored
 * here). It catches a hung step; the SDK aborts it and surfaces the cause,
 * which the classifier maps to [endpoint-timeout]. The default is generous
 * because a non-streaming step legitimately waits for its whole output (a
 * 48k-token review answer exceeded 120 s, a slow-but-steady GLM piece
 * exceeded 600 s): limits stop runaways, not slow working runs. ai@7's
 * `chunkMs`/`firstChunkMs` apply to streamText only (generateText warns
 * "only supported by streaming functions"). Override per driver with
 * `AiSdkDriverOptions.stepTimeoutMs`.
 */
export const DEFAULT_STEP_TIMEOUT_MS = 1_200_000;

/**
 * The minimum ripgrep the search tools need at runtime: 11.0.0 (the CI
 * installer pins a newer 15.2.0 separately — that is the installer's
 * constant, not this driver's; 14.x and every 11+ build SERVE, never
 * "below minimum"). Flag floor is 0.10.0 — upstream CHANGELOG #0100
 * (2018-09-07) added --json (feature #244), and 0.10.0's src/app.rs already
 * carries every flag both invocations use (`--files --no-config --hidden
 * --color=never --null --glob --` and `--json --max-count -e --`); no newer
 * flag raises it. The BEHAVIOR floor is 11.0.0 (CHANGELOG #1100,
 * 2019-04-15): non-fatal search errors became exit 2 even with matches
 * found — before 11, a partial-error search could exit 0/1 with
 * incomplete results, which the grep tool would wrongly serve (it denies
 * exit codes other than 0/1 precisely to refuse error-partial output).
 * Sources: github.com/BurntSushi/ripgrep/blob/15.2.0/CHANGELOG.md
 * #1100-2019-04-15 and #0100-2018-09-07. Boundary tests: 10.x rejects,
 * 11.0.0 and 14.1 accept.
 */
export const RG_MINIMUM_VERSION = HARNESS_RG_FLOOR;

/** Constructor options — everything optional; defaults are production-real. */
export interface AiSdkDriverOptions {
  /**
   * The ripgrep capability probe (rg seam): runtime-only, NEVER HarnessConfig
   * data. The default shells `rg --version` once per RUN (memoized on the
   * run's promise — shared by manifest/descriptor selection and the result
   * capability record; not per selection) with a bounded child process that
   * honors the cancellation signal. The resolved binary path is never
   * reported — only the outcome. Tests inject a deterministic resolver.
   */
  resolveRg?: (
    signal?: AbortSignal,
  ) => Promise<
    { ok: true; version: string } | { ok: false; reason: 'absent' | 'old'; found?: string }
  >;
  /**
   * Bound for each SDK step, in ms (`timeout.stepMs`; the model call incl. its
   * retry and the step's tool runs). It catches a hung step, not a slow answer; default DEFAULT_STEP_TIMEOUT_MS.
   */
  stepTimeoutMs?: number;
  /**
   * Runs before every provider send, including retries and repairs. The
   * optional context distinguishes a model request from scanned tool output;
   * existing two-argument callbacks remain valid.
   */
  beforeRequest?: (
    text: string,
    contents?: readonly { text: string; path?: string }[],
    context?: { kind: 'model-request' | 'tool-output' },
  ) => void | Promise<void>;
  /**
   * Provider registry override (name → factory). Unknown provider names
   * still throw before dispatch. Tests inject mocks here; the production
   * default builds real provider instances lazily per run with API keys
   * read from the environment at call time.
   */
  providers?: Readonly<Record<string, ProviderFactory>>;
  /** Harness config (tool surface + prompt budget). Default: defaultHarnessConfig. */
  harnessConfig?: HarnessConfig;
  /**
   * Resolved CQ_SANDBOX/CQ_RUN_TOOL policy. When omitted, preserve the
   * pre-W1.11 no-policy behavior; the shared gate only resolves a policy
   * when the process environment expresses one. A withheld or disabled run
   * tool is omitted from the model surface.
   */
  sandboxConfig?: SandboxConfig;
  /** Sessions directory for the backing SessionStore. Default: the shared durable sessions dir (`defaultSessionsDir()` — item 1.1). */
  sessionsDir?: string;
  /**
   * Price-lookup override for the derived-only costUSD rule (default:
   * `priceOf` over the vendored models.dev table). Tests and per-deployment
   * price tables inject here; the conformance suite's priced-model test
   * rides this seam. A lookup returning undefined keeps costUSD absent.
   */
  pricing?: (modelSpec: ModelSpec) => PerMillionRates | undefined;
  /**
   * Operator-supplied trusted capability for the strict pre-request ceiling
   * (`Budget.strictTokenBudget`). ABSENT BY DEFAULT: production ships NO
   * attested tokenizer/wire capability, so a strict budget REFUSES before
   * dispatch unless a deployment injects one here. The capability is trusted
   * code (metering + output-ceiling behavior), never a provider name, string
   * or boolean — see `pre-request-ceiling.ts` for what it must account for.
   * Tests inject a fake here; no production provider list exists.
   */
  strictTokenCapability?: (modelSpec: ModelSpec) => StrictTokenCapability | undefined;
  /**
   * The explicit durable PRE-WIRE reservation hook for the strict ceiling. It
   * receives a receipt carrying the resolved model identity and a TS-LOCAL
   * `countableProjectionDigest` (sha256 over the countable projection only —
   * excludes headers/abortSignal/includeRawChunks; NOT the Python
   * `token_guard.request_sha256` canonical form, NOT a whole-wire digest, NOT
   * interoperable; a shared canonical projection protocol is an activation
   * blocker for an external bridge). Called after the local conservative
   * charge and before the wire send; a throw refuses the request without
   * refunding the local charge. ABSENT BY DEFAULT: without it, the shared
   * allowance is enforced per-invocation only — a named gap, never a
   * whole-job claim.
   */
  strictTokenReservationHook?: (receipt: WireReservation) => void | Promise<void>;
}

/**
 * The in-process ai-sdk driver implementing the frozen Driver seam. One
 * instance is stateless across runs — all per-run state (session record,
 * denials) lives in the run call — so a single instance can serve many
 * isolated invocations.
 */
export class AiSdkDriver implements Driver {
  private readonly beforeRequest: AiSdkDriverOptions['beforeRequest'];
  private readonly providers: Readonly<Record<string, ProviderFactory>>;
  private readonly harnessConfig: HarnessConfig;
  private readonly sandboxConfig: SandboxConfig | undefined;
  private readonly sessionsDir: string | undefined;
  private readonly pricing: (modelSpec: ModelSpec) => PerMillionRates | undefined;
  private readonly strictTokenCapability:
    | ((modelSpec: ModelSpec) => StrictTokenCapability | undefined)
    | undefined;
  private readonly strictTokenReservationHook:
    | ((receipt: WireReservation) => void | Promise<void>)
    | undefined;
  /** Runtime rg probe seam (injected, async, never serializable config). */
  private readonly resolveRg: NonNullable<AiSdkDriverOptions['resolveRg']>;
  private readonly stepTimeoutMs: number;

  constructor(options: AiSdkDriverOptions = {}) {
    // The effective config is stored as a deep-frozen STRUCTURED CLONE:
    // neither the caller's object (mutated after construction) nor the
    // shared `defaultHarnessConfig` can be reached — or mutated — through
    // the driver (a shared mutable default would leak one caller's change
    // into every later run).
    this.harnessConfig = deepFreeze(structuredClone(options.harnessConfig ?? defaultHarnessConfig));
    this.sandboxConfig =
      options.sandboxConfig === undefined
        ? undefined
        : deepFreeze(structuredClone(options.sandboxConfig));
    this.sessionsDir = options.sessionsDir;
    this.beforeRequest = options.beforeRequest;
    const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    if (!Number.isInteger(stepTimeoutMs) || stepTimeoutMs <= 0)
      throw new Error(
        `ai-sdk driver: stepTimeoutMs must be a positive integer, got ${String(stepTimeoutMs)}`,
      );
    this.stepTimeoutMs = stepTimeoutMs;
    // The production providers fetch through a transport bounded by the same
    // step bound (step-fetch.ts); injected providers are left untouched.
    this.providers = options.providers ?? defaultProviders(createStepFetch(stepTimeoutMs));
    this.pricing = options.pricing ?? priceOf;
    this.strictTokenCapability = options.strictTokenCapability;
    this.strictTokenReservationHook = options.strictTokenReservationHook;
    // The default probe lives in the HARNESS layer (src/harness/tools.ts),
    // which owns the clock legally (runArgvCommand timeoutMs); the driver owns
    // no timer (I8 hygiene) and only forwards the run's governed signal.
    this.resolveRg = options.resolveRg ?? probeRgVersion;
  }

  /** The frozen seam (v2): run one invocation to completion. */
  async run(opInvocation: OpInvocation, options?: RunOptions): Promise<WorkerResult> {
    const failures = { count: 0 };
    const result = await this.runObserved(opInvocation, options, failures);
    return { ...result, toolFailures: failures.count };
  }

  private async runObserved(
    opInvocation: OpInvocation,
    options: RunOptions | undefined,
    failures: { count: number },
  ): Promise<WorkerResult> {
    const { prompt, modelSpec, toolPolicy, sandboxPolicy, sessionRef, budget } = opInvocation;
    const strictBudget = budget.strictTokenBudget;
    // The run signal is read ONCE here; both the ENTRY and LATE checks read the
    // SAME live RunOptions.signal through `signalAborted`.
    const abortSignal = options?.signal;

    // --- Governed cancellation (I8), ENTRY: the governor decides WHEN to
    // abort; the driver only forwards its signal (no driver-owned clock). An
    // already-aborted invocation never reaches the provider factory (an env
    // key read / provider-model resolution), the prompt/policy/workspace setup
    // or any session state.
    if (signalAborted(abortSignal)) {
      return {
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        steps: 0,
        denials: [],
        stopReason: 'aborted',
      };
    }

    if (
      budget.maxSteps !== undefined &&
      (!Number.isInteger(budget.maxSteps) || budget.maxSteps <= 0)
    ) {
      throw new DispatchError(
        'config',
        `ai-sdk driver: budget.maxSteps must be a positive integer, got ${String(budget.maxSteps)}`,
      );
    }
    const effectiveStepCap = Math.min(budget.maxSteps ?? DEFAULT_MAX_STEPS, DEFAULT_MAX_STEPS);

    // --- Strict pre-request ceiling capability, resolved + REFUSED BEFORE the
    // provider factory: the capability must be INJECTED (trusted operator
    // code) and there is no built-in provider list, so an unconfigured
    // deployment (including production) REFUSES this run before dispatch —
    // specifically BEFORE any provider factory runs, reads its key env or
    // resolves a model. Cancellation above outranks this refusal
    // (signal-first). Resolved ONCE; the ceiling is built later from the SAME
    // capability.
    let capability: StrictTokenCapability | undefined;
    if (strictBudget !== undefined) {
      capability = this.strictTokenCapability?.(modelSpec);
      if (capability === undefined) {
        throw new DispatchError(
          'config',
          `ai-sdk driver: strictTokenBudget is set but no trusted token capability is configured for model '${modelSpec.provider}/${modelSpec.model}' — refusing (inject AiSdkDriverOptions.strictTokenCapability; no built-in capability exists)`,
        );
      }
    }

    // --- Pre-dispatch validation: everything here throws BEFORE the model
    // is contacted and BEFORE any session/workspace exists (fail loudly, no
    // partial state).
    // OpenCode Go routes requests by session header. Allocate the fresh
    // invocation's session id before provider construction so the wire and
    // persisted session record share one stable identity; resumed runs reuse
    // their existing record id.
    const sessionId =
      sessionRef ?? (modelSpec.provider === 'opencode-go' ? randomUUID() : undefined);
    const resolvedModel = this.resolveModel(modelSpec, sessionId);
    let model: LanguageModel = resolvedModel;
    // Resolve policy before creating session/workspace state: malformed
    // sandbox configuration must fail before any partial run state exists.
    const runGate = harnessRunGate(
      this.sandboxConfig === undefined ? {} : { sandboxConfig: this.sandboxConfig },
    );
    // Workspace binding (ADR-0002 §2.4): validated + realpathed BEFORE any
    // session state exists — a bad binding is a pre-dispatch config throw.
    const boundWorkspace =
      opInvocation.workspace === undefined
        ? undefined
        : boundWorkspacePath(opInvocation.workspace, 'ai-sdk driver');

    // --- Governed-cancellation LATE recheck (I8): the provider factory or the
    // strict-capability callback above may have SYNCHRONOUSLY aborted the
    // controller; recheck the SAME live abortSignal after provider/policy/
    // workspace setup, so such an abort never dispatches or creates a session.
    // The SOURCE is the seam-v2 RunOptions.signal — the ONLY cancellation
    // channel (an already-aborted signal creates NO session state: zero usage,
    // no denials, no sessionId).
    if (signalAborted(abortSignal)) {
      return {
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        steps: 0,
        denials: [],
        stopReason: 'aborted',
      };
    }

    this.validatePromptBudget(prompt);

    // --- Strict pre-request ceiling wrap: the capability was validated above,
    // so the ceiling is constructed here (once) over the resolved model. The
    // shared whole-job token allowance rides only when the governing gate
    // supplied a reservation; absent = per-request ceiling only (no whole-job
    // claim from an invocation-local budget).
    if (strictBudget !== undefined && capability !== undefined) {
      const sharedTokenAllowance = options?.reservation?.tokens;
      const ceiling = new PreRequestCeiling({
        budget: strictBudget,
        capability,
        modelSpec,
        ...(sharedTokenAllowance !== undefined
          ? { wholeJobTokenAllowance: sharedTokenAllowance }
          : {}),
        ...(this.strictTokenReservationHook !== undefined
          ? { onBeforeWireReserve: this.strictTokenReservationHook }
          : {}),
      });
      model = wrapWithPreRequestCeiling(resolvedModel, ceiling);
    }

    let uploadRefused = false;
    const guard: AiSdkDriverOptions['beforeRequest'] =
      this.beforeRequest === undefined
        ? undefined
        : async (text, contents, context) => {
            if (uploadRefused) throw new Error('worker upload already refused');
            try {
              await this.beforeRequest?.(text, contents, context);
            } catch {
              uploadRefused = true;
              throw new Error('worker upload refused by scan');
            }
          };
    if (guard !== undefined) {
      if (typeof model === 'string') throw new Error('upload gate requires a resolved model');
      model = wrapLanguageModel({
        model,
        middleware: {
          transformParams: async ({ params }) => {
            const text = serializeRequestForScan(params);
            const contents: { text: string }[] = [];
            const collect = (value: unknown): void => {
              if (typeof value === 'string') contents.push({ text: value });
              else if (value !== null && typeof value === 'object')
                for (const child of Object.values(value)) collect(child);
            };
            collect(JSON.parse(text));
            await guard(text, contents, { kind: 'model-request' });
            return params;
          },
        },
      });
    }

    // --- Structured-output preflight (PR #238 review round 2): the schema
    // document is caller-authored plain data — compile it BEFORE any
    // provider dispatch (the same slot as the other lanes: after the
    // governed-cancellation check — I8, cancellation outranks everything —
    // and before any record exists). An uncompilable document is the
    // uniform LOCAL 'output-invalid' verdict, never a provider/harness
    // failure from a request-setup rejection.
    if (opInvocation.outputSchema !== undefined) {
      const compiled = compileOutputSchema(opInvocation.outputSchema);
      if ('fault' in compiled) {
        return uncompilableSchemaVerdict('ai-sdk', compiled.fault);
      }
    }

    // --- I6 isolation / §2.4 workspace table: a fresh record — created in
    // the bound workspace when one is set, else in a fresh temp workspace —
    // or a real resume, which must record the SAME realpath when a workspace
    // is bound (else a pre-dispatch config throw).
    const store = new SessionStore(this.sessionsDir ?? defaultSessionsDir());
    const record =
      sessionRef === undefined
        ? await store.create(
            boundWorkspace ?? (await tempWorkspace(this.harnessConfig.workspaceRoot)),
            sessionId,
          )
        : await resumedRecordOrThrow(store, sessionRef, boundWorkspace, 'ai-sdk driver');
    // A FAILED prior attempt persists its prompt with no verdict after it:
    // when the resumed record's LAST message is already this exact user
    // prompt, re-appending would compose two CONSECUTIVE identical user
    // turns — reuse the existing trailing turn instead (skip both the store
    // append and the extra prompt message).
    const lastMessage = record.messages[record.messages.length - 1];
    const resumedTrailingPrompt =
      lastMessage !== undefined && lastMessage.role === 'user' && lastMessage.content === prompt;
    if (!resumedTrailingPrompt) {
      await store.appendMessage(record.sessionId, {
        role: 'user',
        content: prompt,
        at: nowIso(),
      });
    }
    // The store write does not mutate the in-memory record: the fresh prompt
    // is appended explicitly to the transcript (resume records already carry
    // their history in record.messages) — unless the trailing turn above IS
    // this prompt, in which case the transcript reuses it.
    const promptMessage: SessionMessage = { role: 'user', content: prompt, at: nowIso() };
    const transcript = transcriptMessages(
      resumedTrailingPrompt ? record.messages : [...record.messages, promptMessage],
    );

    // --- Tool surface: harness config surface ∩ per-op ToolPolicy. --------
    // The gate is the SHARED buildTools seam decision (src/sandbox), so this
    // driver adds no policy of its own: a CQ_SANDBOX policy that withholds
    // `run` withholds it here exactly as it does on the subprocess and MCP
    // harness surfaces. With no explicit config, preserve the pre-W1.11
    // no-policy behavior; an expressed environment is resolved by the gate.
    const denials: ToolDenial[] = [];
    const failedCalls = new Set<string>();
    const sdkErrorKinds = new Map<string, ToolFailureKind>();
    let toolStep = 0;
    const recordFailure = async (
      id: string,
      toolName: string,
      input: unknown,
      fallbackKind: ToolFailureKind,
      reason: string,
      step = toolStep,
    ): Promise<void> => {
      const key = `${step}:${id}`;
      if (failedCalls.has(key)) return;
      failedCalls.add(key);
      failures.count += 1;
      if (this.harnessConfig.logToolFailures !== true) return;
      const kind = toolFailureKind(reason, fallbackKind);
      // Scan complete diagnostics before bounding them. Without a configured
      // scanner retain only a shape summary; values and vendor errors may contain secrets.
      let tool = boundedErrorText(toolName).slice(0, 128);
      let inputSummary = '[values omitted: no scanner]';
      let safeReason = boundedErrorText(reason).slice(0, 1024);
      if (this.beforeRequest !== undefined) {
        const serialized = JSON.stringify(input) ?? 'undefined';
        try {
          const contents = [{ text: toolName }, { text: reason }];
          const collect = (value: unknown): void => {
            if (typeof value === 'string') contents.push({ text: value });
            else if (value !== null && typeof value === 'object')
              for (const [key, child] of Object.entries(value)) {
                contents.push({ text: key });
                collect(child);
              }
          };
          collect(input);
          await this.beforeRequest(
            JSON.stringify({ tool: toolName, reason, input: serialized }),
            contents,
            {
              kind: 'tool-output',
            },
          );
          inputSummary = boundedErrorText(serialized).slice(0, 2048);
        } catch {
          tool = '[redacted]';
          safeReason = '[redacted: diagnostic scan refused]';
          inputSummary = '[redacted: diagnostic scan refused]';
        }
      } else {
        // No scan means no input values or interpolated error strings on disk.
        safeReason = `${kind}: details omitted (no scanner)`;
        if (
          !selected.some(
            (candidate) =>
              candidate.name === toolName ||
              (('aliases' in candidate ? candidate.aliases : undefined) ?? []).includes(toolName),
          )
        )
          tool = '[unknown tool]';
      }
      await store.appendToolFailure(record.sessionId, {
        type: 'tool-failure',
        kind,
        tool,
        reason: safeReason,
        inputSummary,
        step,
        at: nowIso(),
      });
    };
    const observeToolStep = async (
      step: { content: readonly unknown[] },
      repair: boolean,
      stepNumber: number,
    ): Promise<void> => {
      for (const item of step.content) {
        if (typeof item !== 'object' || item === null) continue;
        const part = item as {
          type?: string;
          toolCallId?: string;
          toolName?: string;
          input?: unknown;
          invalid?: boolean;
          error?: unknown;
        };
        if (part.type !== 'tool-call' && part.type !== 'tool-error') continue;
        if (!repair && part.type !== 'tool-error' && part.invalid !== true) continue;
        const name = part.toolName ?? 'unknown';
        const kind = repair
          ? 'REPAIR_STEP'
          : !Object.hasOwn(toolSet, name)
            ? 'UNKNOWN_TOOL'
            : part.invalid === true ||
                InvalidToolInputError.isInstance(part.error) ||
                part.type === 'tool-call'
              ? 'INPUT_INVALID'
              : 'EXECUTION_ERROR';
        if (part.toolCallId !== undefined && part.error instanceof Error) {
          sdkErrorKinds.set(
            JSON.stringify([part.toolCallId, String(part.error)]),
            toolFailureKind(describeError(part.error), kind),
          );
        }
        await recordFailure(
          part.toolCallId ?? `${stepNumber}:${name}`,
          name,
          part.input,
          kind,
          repair
            ? 'REPAIR_STEP: tool calls are disabled during structured-output repair'
            : describeError(part.error ?? 'invalid tool input'),
          stepNumber,
        );
      }
    };

    const harnessTools = buildTools(
      this.harnessConfig,
      record.workspace,
      sandboxPolicy.level,
      runGate,
    );
    // The rg capability probe: ONE probe per RUN, decided from the CANDIDATE
    // selection (harness surface ∩ policy) — probe iff grep OR glob is
    // actually offered, so a glob-only allowlist, a sandbox/harness that
    // withholds search, and an unrestricted policy are all handled without a
    // bypass and without probing when search is unavailable anyway. Absent/
    // old rg then filters BOTH tools from the candidates. A selection without
    // any search tool never probes (the distinguishable not-configured state).
    const candidates = selectTools(harnessTools, toolPolicy);
    const searchOffered = candidates.some((tool) => tool.name === 'grep' || tool.name === 'glob');
    const rgProbe = searchOffered
      ? await this.resolveRg(abortSignal).catch(() => ({
          ok: false as const,
          reason: 'absent' as const,
        }))
      : undefined;
    const searchWithheld = rgProbe !== undefined && rgProbe.ok === false;
    // rg capability seam: the evidence object attached to EVERY post-probe
    // verdict from this run — success, repair success/failure, error, abort,
    // budget — so consumers always see what the once-per-run probe observed.
    const capabilityEvidence =
      rgProbe === undefined
        ? {}
        : {
            capabilities: {
              rg:
                rgProbe.ok === true
                  ? {
                      available: true,
                      version: rgProbe.version,
                      minimum: RG_MINIMUM_VERSION,
                      probe: 'ok' as const,
                    }
                  : rgProbe.reason === 'old'
                    ? {
                        available: false,
                        ...(rgProbe.found !== undefined ? { found: rgProbe.found } : {}),
                        minimum: RG_MINIMUM_VERSION,
                        probe: rgProbe.reason,
                      }
                    : {
                        available: false,
                        minimum: RG_MINIMUM_VERSION,
                        probe: rgProbe.reason,
                      },
            },
            ...(searchWithheld
              ? {
                  advisories: [
                    rgProbe.ok === false && rgProbe.reason === 'old'
                      ? `search tools unavailable: ripgrep older than minimum ${RG_MINIMUM_VERSION}`
                      : 'search tools unavailable: ripgrep not found',
                  ],
                }
              : {}),
          };
    const selected = searchWithheld
      ? candidates.filter((tool) => tool.name !== 'grep' && tool.name !== 'glob')
      : candidates;
    const system = this.composeSystemPrompt(selected.length > 0);
    const toolSet: ToolSet = {};
    // Set by prepareStep on the forced final step. The tool set is fixed per
    // session (#502), so the executors stay registered there; a call the model
    // makes anyway must not run a tool whose result it would never see.
    let finalStepStarted = false;
    // The repair request carries the same definitions WITHOUT executors: the
    // request shape stays fixed for the whole session (#502), and a stray
    // tool call in the repair is returned unexecuted, never run.
    const repairToolSet: ToolSet = {};
    for (const harnessTool of selected) {
      const inputSchema = jsonSchema<Record<string, unknown>>(
        z.toJSONSchema(AdvertisedToolInputSchemas[harnessTool.name]) as JSONSchema7,
        {
          validate: (value) => {
            try {
              return { success: true, value: normalizeToolInput(harnessTool, value) };
            } catch (error) {
              return {
                success: false,
                error: new Error(invalidToolInput(error)),
              };
            }
          },
        },
      );
      const descriptor = {
        description: harnessTool.description,
        inputSchema,
        execute: async (
          input: unknown,
          options: { abortSignal: AbortSignal; toolCallId: string },
        ): Promise<string> => {
          if (finalStepStarted) {
            const denial = {
              tool: harnessTool.name,
              reason:
                'FINAL_STEP: tool calls are disabled on the final step; reply with the answer',
            };
            denials.push(denial);
            await recordFailure(
              options.toolCallId,
              harnessTool.name,
              input,
              'FINAL_STEP',
              denial.reason,
            );
            await store.appendMessage(record.sessionId, {
              role: 'tool',
              toolName: harnessTool.name,
              content: JSON.stringify({ ok: false, denial }),
              at: nowIso(),
            });
            return denial.reason;
          }
          return runTool(
            harnessTool,
            input,
            store,
            record,
            denials,
            guard,
            {
              signal: options.abortSignal,
            },
            async (reason, kind) =>
              recordFailure(options.toolCallId, harnessTool.name, input, kind, reason),
            this.beforeRequest,
          );
        },
      };
      const repairDescriptor = {
        description: harnessTool.description,
        inputSchema,
      };
      toolSet[harnessTool.name] = tool(descriptor as Tool);
      repairToolSet[harnessTool.name] = tool(repairDescriptor as Tool);
      // One-release aliases (the pre-F1 `run` name for `bash`) are registered
      // under their own names so a model or prompt that still calls them
      // reaches the canonical executor and denial vocabulary.
      for (const alias of ('aliases' in harnessTool ? harnessTool.aliases : undefined) ?? []) {
        toolSet[alias] = tool(descriptor as Tool);
        repairToolSet[alias] = tool(repairDescriptor as Tool);
      }
    }

    // --- Timer-free budget + the tool-loop bound: stopWhen is ALWAYS ------
    // passed. With Budget.maxTokens the token fold trips the cap; without
    // one, stepCountIs(DEFAULT_MAX_STEPS) still bounds the tool loop — the
    // SDK's own default is a SINGLE step (stepCountIs(1)), under which tool
    // calls would never be followed up. Both ride the SDK's step loop: no
    // scheduling primitive (I8).
    const stopWhen: Array<StopCondition<ToolSet>> = [
      ...(budget.maxTokens !== undefined ? [tokenBudgetCondition(budget.maxTokens)] : []),
      stepCountIs(effectiveStepCap),
    ];

    // Structured output (ADR-0002 §2.3): the invocation schema is the only
    // schema source; it normalizes to the same plain-data OutputSchema the
    // shared validator judges.
    const outputSchema = opInvocation.outputSchema;
    const prompted = outputSchema !== undefined && promptedSchemaProvider(modelSpec.provider);
    const messages: ModelMessage[] =
      prompted && outputSchema !== undefined
        ? [
            ...transcript,
            { role: 'user', content: schemaContract(outputSchema, selected.length > 0) },
          ]
        : transcript;

    // --- The one SDK call. -------------------------------------------------
    // Per-step usage accumulation (DD-2 evidence): onStepFinish fires for
    // EVERY completed step — intermediate ones included — so a run that
    // fails mid-loop still carries the tokens its completed steps spent
    // (an error verdict reporting all-zero usage after real work would be
    // dishonest evidence). The fold never feeds a cost figure on this path.
    // ai@7 response.messages covers one step; retain every completed step
    // for repair, including when native output parsing throws after the loop.
    const normalizeToolErrors = (messages: readonly ModelMessage[]): ModelMessage[] =>
      messages.map((message): ModelMessage => {
        if (message.role !== 'tool') return message;
        return {
          ...message,
          content: message.content.map((part) => {
            if (part.type !== 'tool-result' || part.output.type !== 'error-text') return part;
            const text = part.output.value;
            const kind =
              sdkErrorKinds.get(JSON.stringify([part.toolCallId, text])) ??
              toolFailureKind(
                text,
                Object.hasOwn(toolSet, part.toolName) ? 'EXECUTION_ERROR' : 'UNKNOWN_TOOL',
              );
            const start = text.indexOf(`${kind}: `);
            return {
              ...part,
              output: {
                type: 'error-text',
                value: start < 0 ? `${kind}: ${text}` : text.slice(start),
              },
            };
          }),
        };
      });

    const responseMessages: ModelMessage[] = [];
    let stepUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let completedSteps = 0;
    // Session-log fidelity (item 1.7): the FINAL completed step, so the
    // persisted assistant turn can carry its own usage and requested tool
    // calls. Undefined when no step completed (an immediate abort) — the
    // message then persists without the fidelity fields, exactly as before.
    let lastStep:
      | { usage: LanguageModelUsage; toolCalls: readonly unknown[] | undefined }
      | undefined;
    try {
      let result: Awaited<ReturnType<typeof generateText>>;
      try {
        result = await generateText({
          model,
          system,
          messages,
          // ONE retry per step request (bounded; ≤ DEFAULT_MAX_STEPS per run)
          // (#210 Ask 1): the SDK retries ONLY its
          // retryable transient class (endpoint header timeout / network),
          // and an exhausted retry still surfaces the attempt count and last
          // error in the thrown message, so the cause reaches
          // WorkerResult.error rather than being hidden. This is a deliberate,
          // recorded deviation from the earlier "no driver-side retries"
          // note: the same endpoint is healthy on the classifier cell, so one
          // retry recovers the hiccup while a governed abort still surfaces
          // immediately. USAGE ACCOUNTING: `usage` remains the observed
          // completed steps (the SDK reports no usage for a request that
          // never produced a response) and `costBasis: 'modeled'` never
          // claims billed spend — a retried request is exactly the DD-9
          // api-equivalent caveat the modeled label records, not a hidden
          // second charge.
          maxRetries: 1,
          // Bound for EACH step (see DEFAULT_STEP_TIMEOUT_MS): a
          // hung step cannot stall the loop. The step-timeout abort is not
          // SDK-retryable; it classifies as 'transient' (TimeoutError name).
          timeout: { stepMs: this.stepTimeoutMs },
          ...(selected.length > 0 ? { tools: toolSet } : {}),
          // DECOUPLE the mandatory structured object from the tool loop (#203):
          // with tools available on the final step the model tends to call one
          // more tool instead of emitting the required object, and `result.output`
          // then throws. The final step ends the loop with an instruction turn
          // ("final step: reply with only the JSON object") rather than by
          // changing the request (#502): tools, toolChoice and the system prompt
          // stay fixed for the whole session. Removing the definitions or
          // forcing toolChoice 'none' mid-session made DeepSeek answer with DSML
          // pseudo-tool-call text (Step 4 eval, eb8f80ac and 49c3715c). A call
          // the model makes anyway is denied by the executor backstop above.
          // Pure step-number function — no scheduling primitive (I8).
          prepareStep: ({ stepNumber, messages }) => {
            toolStep = stepNumber;
            const typedMessages = normalizeToolErrors(messages);
            if (
              outputSchema === undefined ||
              selected.length === 0 ||
              stepNumber < effectiveStepCap - 1
            )
              return { messages: typedMessages };
            finalStepStarted = true;
            return {
              messages: [
                ...typedMessages,
                { role: 'user' as const, content: finalStepContract(outputSchema, prompted) },
              ],
            };
          },
          stopWhen,
          onStepFinish: async (step) => {
            await observeToolStep(step, false, completedSteps);
            completedSteps += 1;
            toolStep = completedSteps;
            stepUsage = addUsage(stepUsage, usageFromSdk(step.usage));
            responseMessages.push(...normalizeToolErrors(step.response.messages));
            lastStep = {
              usage: step.usage,
              toolCalls: step.toolCalls as readonly unknown[] | undefined,
            };
          },
          ...(abortSignal !== undefined ? { abortSignal } : {}),
          // Transport (ADR-0002 §2.3): the SDK's structured output over the
          // EXACT plain document the schema request carried — the native
          // `jsonSchema` wrapper, no second zod conversion. The wrapper ships
          // no `validate`, so the SDK's own parse is parse-level; the schema
          // judgment is `validateStructured` after settle, the same shared
          // validator every lane runs over the same stripped document.
          ...(outputSchema !== undefined && !prompted
            ? {
                output: Output.object({
                  schema: jsonSchema(outputSchema.schema as unknown as JSONSchema7),
                }),
              }
            : {}),
        });
      } catch (err) {
        // STRUCTURED PARSE FAILURES SURFACE HERE (ai@7): when the final
        // step's text does not parse as the requested object, Output.object's
        // parseCompleteOutput throws INSIDE the generateText promise — the
        // call REJECTS with NoObjectGeneratedError, which carries the model's
        // text, the response metadata and the usage. Route that into the
        // SAME miss flow as the lazy-getter miss below (a final step that
        // ends on tool-calls RESOLVES and `result.output` throws instead).
        // Everything else rethrows to the outer catch.
        if (outputSchema !== undefined && NoObjectGeneratedError.isInstance(err)) {
          return await this.settleStructuredMiss({
            outputSchema,
            observeToolStep,
            repairTools: selected.length > 0 ? repairToolSet : undefined,
            rejection: `the reply carried no parseable object — ${describeError(err)}`,
            mainText: err.text ?? '',
            mainUsage: stepUsage,
            mainSteps: completedSteps,
            servedModel:
              typeof err.response?.modelId === 'string' && err.response.modelId !== ''
                ? err.response.modelId
                : undefined,
            responseHeaders: err.response?.headers,
            finishReason: err.finishReason ?? 'error',
            capabilityEvidence,
            abortSignal,
            budget,
            model,
            responseMessages,
            transcript,
            store,
            record,
            modelSpec,
            denials,
          });
        }
        throw err;
      }

      const usage = usageFromSdk(result.usage);
      // The observed served model: the SDK prefers the provider-reported
      // response modelId over the requested id (ai@7.0.99), which is exactly
      // the remap-detection fact WorkerResult.model carries. Absent on the
      // error/abort path: no response, no observation.
      const servedModel =
        typeof result.response.modelId === 'string' && result.response.modelId !== ''
          ? result.response.modelId
          : undefined;
      const finishReason: FinishReason = result.finishReason;
      const text = result.text;
      // Success-path provider signals (RS-14): the vendor's limit headers,
      // only when the response actually carried them. Allowed on ANY verdict.
      const signals = providerSignalsFromHeaders(result.response.headers);
      let structuredOutput: unknown;
      if (outputSchema !== undefined) {
        // Reading `output` can throw (ai@7.0.99): NoOutputGeneratedError when
        // the final step ended on tool-calls, NoObjectGeneratedError when the
        // text does not parse against the schema. The SDK's wrapper ships no
        // `validate`, so a PARSEABLE reply always yields a value here — the
        // schema judgment is the shared validator below, over the same
        // stripped document that was sent. Never fabricate a
        // structuredOutput, never fall through to a 'complete' verdict.
        let rejection: string | undefined;
        let parsed: unknown;
        try {
          parsed = prompted ? parseReplyJson(text) : result.output;
        } catch (err) {
          rejection = `the reply carried no parseable object — ${describeError(err)}`;
        }
        if (rejection === undefined) {
          const validated = validateStructured(outputSchema, parsed);
          if (validated.ok) {
            structuredOutput = validated.value;
          } else {
            rejection = `the reply does not validate against schema '${outputSchema.name}' — ${validated.reason}`;
          }
        }
        if (rejection !== undefined) {
          // Persist + carve-outs + repair live in ONE place, so a parse
          // rejection (above) and a getter miss (here) settle identically.
          return await this.settleStructuredMiss({
            outputSchema,
            observeToolStep,
            repairTools: selected.length > 0 ? repairToolSet : undefined,
            rejection,
            mainText: text,
            mainUsage: usage,
            mainSteps: completedSteps,
            servedModel,
            responseHeaders: result.response.headers,
            finishReason,
            capabilityEvidence,
            abortSignal,
            budget,
            model,
            responseMessages,
            transcript,
            store,
            record,
            modelSpec,
            denials,
          });
        }
      }

      // Assistant turn persisted in OUR vocabulary before the verdict —
      // now with the step's OWN usage (item 1.7: the store answers "what
      // did this turn spend" without the journal) and the step's requested
      // tool calls (the role-'tool' lines that follow are the results).
      await store.appendMessage(record.sessionId, {
        role: 'assistant',
        content: text !== '' ? text : JSON.stringify(structuredOutput ?? ''),
        ...(lastStep !== undefined
          ? {
              usage: usageFromSdk(lastStep.usage),
              ...(lastStep.toolCalls !== undefined && lastStep.toolCalls.length > 0
                ? { toolCalls: JSON.stringify(lastStep.toolCalls) }
                : {}),
            }
          : {}),
        at: nowIso(),
      });

      const stopReason = stopReasonOf({
        finishReason,
        aborted: signalAborted(abortSignal),
        tokenBudget: budget.maxTokens,
        totalTokens: totalTokensOf(usage),
      });
      // PRODUCER RULE (ADR §2.2): every error verdict this lane returns
      // carries errorClass. A resolved run whose final step finished
      // 'error'/'content-filter' has no caught cause — classify from the
      // finish reason (a provider refusal is provider-reported; anything
      // else stays 'unknown', never guessed).
      const finishClass = stopReason === 'error' ? finishReasonErrorClass(finishReason) : undefined;
      return {
        ...(servedModel !== undefined ? { model: servedModel } : {}),
        // The payload rides a COMPLETE verdict only (as the repair path
        // already does): a budget/aborted run's parsed object is not an
        // outcome the caller may consume, and the outer served-model
        // wrapper judges only completes — a payload on a non-complete
        // verdict would bypass the observed-model check.
        ...(stopReason === 'complete' && structuredOutput !== undefined
          ? { structuredOutput }
          : {}),
        usage,
        steps: completedSteps,
        // PRICING KEY: derived over the OBSERVED served model id — a
        // silently-remapped gateway is priced off the id the response
        // reports (the same fact WorkerResult.model carries); the provider
        // handle stays modelSpec.provider (the price table's key).
        ...costField(this.pricing, { ...modelSpec, model: servedModel ?? modelSpec.model }, usage),
        sessionId: record.sessionId,
        denials,
        // rg capability seam: evidence rides EVERY verdict (shared object).
        ...capabilityEvidence,
        stopReason,
        ...(finishClass !== undefined
          ? {
              error: boundedErrorText(
                `ai-sdk driver: the final step finished with finishReason '${String(finishReason)}'`,
              ),
              errorClass: finishClass,
            }
          : {}),
        ...(signals !== undefined ? { providerSignals: signals } : {}),
      };
    } catch (err) {
      // Cancellation OUTRANKS every other corridor (I8 / V1GX): a live run
      // signal — or an abort-shaped throw from the ceiling's abort-aware
      // durable hook — settles 'aborted' FIRST, never a budget/infra refusal.
      // Provider limit observations ride ANY verdict (RS-14): the caught
      // chain's APICallError headers, when present.
      const signals = providerSignalsFromError(err);
      const aborted =
        signalAborted(abortSignal) || (err instanceof Error && err.name === 'AbortError');
      if (aborted) {
        return {
          usage: stepUsage,
          steps: completedSteps,
          sessionId: record.sessionId,
          denials,
          ...capabilityEvidence,
          stopReason: 'aborted',
          ...(signals !== undefined ? { providerSignals: signals } : {}),
        };
      }
      // The strict pre-request ceiling refused a wire send. Only a REAL token
      // cap settles 'budget'; a capability/serialization/durable-hook failure
      // settles a DIAGNOSTIC 'error' (V1Gf) — never hidden as budget-exhausted
      // (which ops would surface for a broken hook). The completed steps' usage
      // is kept (onStepFinish folded them); nothing was sent.
      if (isPreRequestCeilingRefusal(err)) {
        if (err.kind === 'budget') {
          return {
            usage: stepUsage,
            steps: completedSteps,
            sessionId: record.sessionId,
            denials,
            ...capabilityEvidence,
            stopReason: 'budget',
            ...(signals !== undefined ? { providerSignals: signals } : {}),
          };
        }
        return {
          usage: stepUsage,
          steps: completedSteps,
          sessionId: record.sessionId,
          denials,
          stopReason: 'error',
          error: boundedErrorText(
            `ai-sdk driver: strict token ceiling infrastructure failure (${err.reason}) — ${err.message}`,
          ),
          errorClass: 'harness',
          ...(signals !== undefined ? { providerSignals: signals } : {}),
        };
      }
      // Mid-run failure: return an honest error verdict (never throw past
      // the seam — the frozen result carries the evidence gathered so far).
      // A missing structured object is an error verdict too: the model never
      // produced the required output.
      //
      // USAGE EVIDENCE IS KEPT: onStepFinish folded every completed step,
      // so the verdict carries the real tokens spent before the failure —
      // all-zero only when truly nothing completed. COST is NOT fabricated
      // (never-fabricate): cost is derived only from a FULL result usage
      // (the success and structured-output-miss paths); this partial fold
      // understates the run, so no figure is claimed.
      return {
        usage: stepUsage,
        steps: completedSteps,
        sessionId: record.sessionId,
        denials,
        ...capabilityEvidence,
        stopReason: 'error',
        error: boundedErrorText(`ai-sdk driver: run failed — ${describeError(err)}`),
        errorClass: classifyRunFailure(err),
        ...(signals !== undefined ? { providerSignals: signals } : {}),
      };
    }
  }

  // --- Internals -------------------------------------------------------------

  /**
   * The §2.3 miss settlement — ONE flow for BOTH miss shapes: (a) the main
   * generateText RESOLVED but `result.output` threw (a final step on
   * tool-calls — NoOutputGeneratedError from the lazy getter), and (b) the
   * main generateText REJECTED outright (the reply text did not parse —
   * NoObjectGeneratedError thrown inside the SDK's promise). Owns, in
   * order: the assistant-turn persistence, the budget/abort carve-out (the
   * missing object is the cap's or cancellation's consequence, not a schema
   * violation), the provider-finish shortcut (a provider-level finish is
   * NOT a model output outcome — a repair cannot fix it), and then the W3.4
   * repair (ADR-0002 §2.3): ONE bounded request — no tool execution (the
   * session's definitions without executors, so the request shape is
   * unchanged, #502), over the session transcript so the model sees what it produced,
   * the JSON Schema restated in the prompt, `maxRetries: 0`, one step,
   * inside the SAME budget (the `maxTokens` remainder) and the SAME signal.
   * The repair is a REAL extra model call: its usage folds into the
   * verdict's alongside the main call's, and the derived cost is computed
   * over the folded usage. A validating repair object completes the run;
   * anything else settles the uniform 'error'/'output-invalid' verdict.
   */
  private async settleStructuredMiss(inputs: {
    outputSchema: OutputSchema;
    /** The session's tool definitions without executors, or undefined for a tool-less session. */
    repairTools: ToolSet | undefined;
    observeToolStep: (
      step: { content: readonly unknown[] },
      repair: boolean,
      stepNumber: number,
    ) => Promise<void>;
    /** The main call's miss reason (bounded into the verdict text). */
    rejection: string;
    mainText: string;
    mainUsage: Usage;
    mainSteps: number;
    servedModel: string | undefined;
    responseHeaders: Record<string, string> | undefined;
    finishReason: FinishReason;
    abortSignal: AbortSignal | undefined;
    budget: Budget;
    model: LanguageModel;
    responseMessages: ModelMessage[];
    transcript: ModelMessage[];
    store: SessionStore;
    record: SessionRecord;
    modelSpec: ModelSpec;
    denials: ToolDenial[];
    /** rg capability seam: the once-per-run probe evidence, attached to every miss-flow verdict. */
    capabilityEvidence: Partial<WorkerResult>;
  }): Promise<WorkerResult> {
    const {
      outputSchema,
      repairTools,
      rejection,
      mainText,
      mainUsage,
      mainSteps,
      servedModel,
      responseHeaders,
      finishReason,
      abortSignal,
      budget,
      model,
      responseMessages,
      transcript,
      store,
      record,
      modelSpec,
      denials,
      capabilityEvidence,
    } = inputs;

    /** Fold-in helper: verdict usage over BOTH calls, cost over the fold. */
    let repairSteps = 0;
    const verdictExtras = (
      totalUsage: Usage,
    ): Pick<WorkerResult, 'usage' | 'steps' | 'costUSD' | 'costBasis'> => ({
      usage: totalUsage,
      steps: mainSteps + repairSteps,
      ...costField(
        this.pricing,
        { ...modelSpec, model: servedModel ?? modelSpec.model },
        totalUsage,
      ),
    });
    /** Usage WITHOUT a derived cost — the mixed-identity (repair remap) verdict refuses to price. */
    const verdictUsageOnly = (totalUsage: Usage): Pick<WorkerResult, 'usage' | 'steps'> => ({
      usage: totalUsage,
      steps: mainSteps + repairSteps,
    });
    const verdictSignals = (): { providerSignals?: ProviderSignals } => {
      const signals = providerSignalsFromHeaders(responseHeaders);
      return signals !== undefined ? { providerSignals: signals } : {};
    };

    // Persist the assistant turn exactly as the success path does — the
    // model's text is real evidence even though the required object missed.
    // Deliberate skip when there is no text: the model produced NEITHER text
    // NOR the object, so there is no assistant turn.
    if (mainText.trim() !== '') {
      await store.appendMessage(record.sessionId, {
        role: 'assistant',
        content: mainText,
        at: nowIso(),
      });
    }
    const mapped = stopReasonOf({
      finishReason,
      aborted: signalAborted(abortSignal),
      tokenBudget: budget.maxTokens,
      totalTokens: totalTokensOf(mainUsage),
    });
    // Budget/abort carve-out (ADR §2.3): a cap or cancellation that leaves
    // the final step on tool-calls is the honest stop reason — the missing
    // object is its consequence, not a schema violation.
    if (mapped === 'budget' || mapped === 'aborted') {
      return {
        ...(servedModel !== undefined ? { model: servedModel } : {}),
        ...verdictExtras(mainUsage),
        sessionId: record.sessionId,
        denials,
        ...capabilityEvidence,
        stopReason: mapped,
        ...verdictSignals(),
      };
    }
    // A provider-level finish is NOT a model output outcome (ADR §2.2:
    // 'output-invalid' is a MODEL outcome): a repair call cannot fix a
    // provider failure, so classify the provider cause and skip the repair.
    if (finishReason === 'error' || finishReason === 'content-filter') {
      return {
        ...(servedModel !== undefined ? { model: servedModel } : {}),
        ...verdictExtras(mainUsage),
        sessionId: record.sessionId,
        denials,
        ...capabilityEvidence,
        stopReason: 'error',
        error: boundedErrorText(
          `ai-sdk driver: the run ended with finishReason '${String(finishReason)}' before a schema-valid object (${rejection})`,
        ),
        errorClass: finishReasonErrorClass(finishReason),
        ...verdictSignals(),
      };
    }

    // W3.4 REPAIR — ONE bounded request before giving up.
    const remainingTokens =
      budget.maxTokens === undefined ? undefined : budget.maxTokens - totalTokensOf(mainUsage);
    if (signalAborted(abortSignal) || (remainingTokens !== undefined && remainingTokens <= 0)) {
      // A signal fired in the gap after the main call, or the token
      // remainder is spent: the run is over — settle the honest consequence.
      if (signalAborted(abortSignal)) {
        return {
          ...(servedModel !== undefined ? { model: servedModel } : {}),
          ...verdictExtras(mainUsage),
          sessionId: record.sessionId,
          denials,
          ...capabilityEvidence,
          stopReason: 'aborted',
          ...verdictSignals(),
        };
      }
      return {
        ...(servedModel !== undefined ? { model: servedModel } : {}),
        ...verdictExtras(mainUsage),
        sessionId: record.sessionId,
        denials,
        ...capabilityEvidence,
        stopReason: 'error',
        error: boundedErrorText(
          `ai-sdk driver: structured output invalid and the token budget leaves no room for the repair attempt — ${rejection}`,
        ),
        errorClass: 'output-invalid',
        ...verdictSignals(),
      };
    }

    const repairMessages: ModelMessage[] = [
      ...transcript,
      ...(responseMessages.length > 0
        ? responseMessages
        : mainText.trim() !== ''
          ? [{ role: 'assistant' as const, content: mainText }]
          : []),
      {
        role: 'user',
        content:
          `Your previous reply did not satisfy the required JSON contract. ` +
          `Reply with ONLY one JSON object — no prose, no code fences, no tool calls — that validates ` +
          `against this JSON Schema (draft 2020-12):\n${JSON.stringify(outputSchema.schema)}`,
      },
    ];
    let repairUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    try {
      const repair = await generateText({
        model,
        system: this.composeSystemPrompt(repairTools !== undefined),
        messages: repairMessages,
        ...(repairTools !== undefined ? { tools: repairTools } : {}),
        // W3.4: the repair gets ZERO SDK retries and exactly ONE step —
        // bounded, unlike the main loop.
        maxRetries: 0,
        timeout: { stepMs: this.stepTimeoutMs },
        ...(remainingTokens !== undefined
          ? { stopWhen: [tokenBudgetCondition(remainingTokens), stepCountIs(1)] }
          : { stopWhen: [stepCountIs(1)] }),
        onStepFinish: async (step) => {
          await inputs.observeToolStep(step, true, mainSteps + repairSteps);
          repairSteps += 1;
          repairUsage = addUsage(repairUsage, usageFromSdk(step.usage));
        },
        // No tool EXECUTION: the definitions above have no executors, so a
        // call comes back unexecuted and the reply still misses the object.
        ...(abortSignal !== undefined ? { abortSignal } : {}),
        ...(promptedSchemaProvider(modelSpec.provider)
          ? {}
          : {
              output: Output.object({
                schema: jsonSchema(outputSchema.schema as unknown as JSONSchema7),
              }),
            }),
      });
      const totalUsage = addUsage(mainUsage, usageFromSdk(repair.usage));
      // The repair is a REAL model call with its OWN served-id observation,
      // judged ONCE for every repair-path verdict — not only the success
      // path (the wrapper cannot see this inner call):
      //   'mixed'       — the main observed an id and the repair reports a
      //                   DIFFERENT one or none at all: the payload's
      //                   producer identity contradicts (or is unobserved
      //                   under) the run's claim — fail closed wherever a
      //                   payload would be accepted, and NEVER price the
      //                   fold (attributing the repair's tokens to the main
      //                   response's model would be fabrication);
      //   'repair-only' — the main was unobserved but the repair reported:
      //                   the repair IS the payload's producer, so the
      //                   verdict reports ITS id and prices under it — the
      //                   outer wrapper then judges that id against the
      //                   REQUESTED model exactly as it judges a single-call
      //                   run (its default requireObserved and alias policy
      //                   both apply);
      //   'match'       — both observed and equal, or neither observed:
      //                   unchanged behavior.
      const repairServedModel =
        typeof repair.response.modelId === 'string' && repair.response.modelId !== ''
          ? repair.response.modelId
          : undefined;
      const repairIdentity: 'match' | 'mixed' | 'repair-only' =
        servedModel === undefined
          ? repairServedModel === undefined
            ? 'match'
            : 'repair-only'
          : repairServedModel === servedModel
            ? 'match'
            : 'mixed';
      const verdictModel = repairIdentity === 'repair-only' ? repairServedModel : servedModel;
      /**
       * Aggregate pricing requires ONE attributable identity for BOTH calls:
       * 'mixed' attributes the repair's tokens to the main response's model
       * (fabrication), and 'repair-only' attributes the possibly-remapped
       * MAIN call's tokens to the repair's model (misattribution that would
       * also silence the governor's unpriced-usage trip). Both settle with
       * the usage evidence and NO costUSD — the same derived-only honesty as
       * an unpriced model. Only 'match' prices: both observed and equal
       * under the served id; both unobserved under the requested id (the v1
       * rule).
       */
      const repairVerdictExtras = (
        usage: Usage,
      ): Pick<WorkerResult, 'usage' | 'steps' | 'costUSD' | 'costBasis'> =>
        repairIdentity === 'match'
          ? {
              usage,
              steps: mainSteps + repairSteps,
              ...costField(
                this.pricing,
                { ...modelSpec, model: servedModel ?? modelSpec.model },
                usage,
              ),
            }
          : verdictUsageOnly(usage);
      // The repair's OWN limit headers are the FRESHER observation (the
      // second request consumed capacity after the first) — they take
      // precedence over the main response's whenever the repair returned
      // any.
      const repairSignals = (): { providerSignals?: ProviderSignals } => {
        const signals =
          providerSignalsFromHeaders(repair.response.headers) ??
          providerSignalsFromHeaders(responseHeaders);
        return signals !== undefined ? { providerSignals: signals } : {};
      };
      if (repair.text.trim() !== '') {
        await store.appendMessage(record.sessionId, {
          role: 'assistant',
          content: repair.text,
          at: nowIso(),
        });
      }
      // The repair's object goes through the SAME validator as the main
      // call's — one judge, whichever call produced the payload.
      let repairRejection: string | undefined;
      let repairedValue: unknown;
      try {
        const validated = validateStructured(
          outputSchema,
          promptedSchemaProvider(modelSpec.provider) ? parseReplyJson(repair.text) : repair.output,
        );
        if (validated.ok) repairedValue = validated.value;
        else repairRejection = validated.reason;
      } catch (err) {
        repairRejection = describeError(err);
      }
      if (repairRejection === undefined) {
        // The repair consumed budget too: a successful repair is judged by
        // the SAME rule as the main loop — stopReasonOf over the repair's
        // OWN finish status and the ACCUMULATED usage (main call + repair).
        // A repair that lands on/over the cap is an honest 'budget' verdict
        // carrying its spend evidence; one the provider ended on a terminal
        // status is 'error' with the classified cause — never a complete
        // that overrode the wire. The payload rides a 'complete' verdict
        // only.
        const repairStop = stopReasonOf({
          finishReason: repair.finishReason,
          aborted: signalAborted(abortSignal),
          tokenBudget: budget.maxTokens,
          totalTokens: totalTokensOf(totalUsage),
        });
        if (repairStop === 'error') {
          return {
            ...(verdictModel !== undefined ? { model: verdictModel } : {}),
            ...repairVerdictExtras(totalUsage),
            sessionId: record.sessionId,
            denials,
            ...capabilityEvidence,
            stopReason: 'error',
            error: boundedErrorText(
              `ai-sdk driver: the repair attempt ended on the provider's terminal status (${String(repair.finishReason)})`,
            ),
            errorClass: finishReasonErrorClass(repair.finishReason),
            ...repairSignals(),
          };
        }
        // The ONE fail-closed point for a mixed identity (see the judgment
        // above): the payload is dropped, spend evidence kept, the fold
        // unpriced. Only a COMPLETE verdict carries a payload — a 'budget'
        // or 'aborted' repair keeps its honest verdict (a governed abort is
        // never a failure, I8; a cap trip is never an endpoint mismatch);
        // those are already payload-free and unpriced by
        // repairVerdictExtras. 'mixed' implies the main response observed an
        // id (see the judgment above); the conjunction narrows for the
        // compiler.
        if (repairStop === 'complete' && repairIdentity === 'mixed' && servedModel !== undefined) {
          return {
            model: servedModel,
            ...verdictUsageOnly(totalUsage),
            sessionId: record.sessionId,
            denials,
            ...capabilityEvidence,
            stopReason: 'error',
            error: boundedErrorText(
              repairServedModel === undefined
                ? `ai-sdk driver: the repair attempt reported no model id while the main call observed '${servedModel}' — the accepted payload's producer identity is unobserved`
                : `ai-sdk driver: the repair attempt was served '${repairServedModel}' while the main call observed '${servedModel}' — the payload mixes model identities`,
            ),
            errorClass: 'served-model-mismatch',
            ...repairSignals(),
          };
        }
        return {
          ...(verdictModel !== undefined ? { model: verdictModel } : {}),
          ...(repairStop === 'complete' ? { structuredOutput: repairedValue } : {}),
          ...repairVerdictExtras(totalUsage),
          sessionId: record.sessionId,
          denials,
          ...capabilityEvidence,
          stopReason: repairStop,
          ...repairSignals(),
        };
      }
      return {
        ...(verdictModel !== undefined ? { model: verdictModel } : {}),
        ...repairVerdictExtras(totalUsage),
        sessionId: record.sessionId,
        denials,
        ...capabilityEvidence,
        stopReason: 'error',
        error: boundedErrorText(
          `ai-sdk driver: structured output invalid after the repair attempt — ${rejection}; repair: ${repairRejection}`,
        ),
        errorClass: 'output-invalid',
        ...repairSignals(),
      };
    } catch (err) {
      // The REPAIR REQUEST itself failed. A parse miss (NoObjectGeneratedError
      // — the repair's text is not the object) is STILL the model outcome the
      // §2.3 table names: 'output-invalid'. Any other failure (network,
      // provider, abort) is the run's terminal cause, classified by the
      // structured cuts; an abort-shaped failure is the caller's
      // cancellation, not an error.
      const totalUsage = addUsage(mainUsage, repairUsage);
      const aborted =
        signalAborted(abortSignal) || (err instanceof Error && err.name === 'AbortError');
      const signals = providerSignalsFromError(err);
      // The ceiling refused the REPAIR request before the wire send. Cancellation
      // still outranks (the `!aborted` gate below); a REAL cap settles the honest
      // 'budget' verdict with the main call's spend, while a
      // capability/serialization/durable-hook failure settles a DIAGNOSTIC
      // 'error' (V1Gf) — never hidden as budget-exhausted.
      if (!aborted && isPreRequestCeilingRefusal(err)) {
        if (err.kind === 'budget') {
          return {
            ...(servedModel !== undefined ? { model: servedModel } : {}),
            ...verdictExtras(totalUsage),
            sessionId: record.sessionId,
            denials,
            ...capabilityEvidence,
            stopReason: 'budget',
            ...verdictSignals(),
          };
        }
        return {
          ...(servedModel !== undefined ? { model: servedModel } : {}),
          usage: totalUsage,
          steps: mainSteps + repairSteps,
          sessionId: record.sessionId,
          denials,
          ...capabilityEvidence,
          stopReason: 'error',
          error: boundedErrorText(
            `ai-sdk driver: structured output invalid and the repair attempt was refused by the strict token ceiling for an infrastructure reason (${err.reason}) — ${err.message}`,
          ),
          errorClass: 'harness',
          ...verdictSignals(),
        };
      }
      if (!aborted && NoObjectGeneratedError.isInstance(err)) {
        // The parse-miss error carries the repair's own response metadata:
        // the SAME identity judgment as the returned-repair paths (a
        // repair-only observation is reported for the wrapper to judge; a
        // mixed identity is never priced), and the repair's headers are the
        // fresher limit evidence.
        const errRepairServedModel =
          typeof err.response?.modelId === 'string' && err.response.modelId !== ''
            ? err.response.modelId
            : undefined;
        const errIdentity: 'match' | 'mixed' | 'repair-only' =
          servedModel === undefined
            ? errRepairServedModel === undefined
              ? 'match'
              : 'repair-only'
            : errRepairServedModel === servedModel
              ? 'match'
              : 'mixed';
        const errModel = errIdentity === 'repair-only' ? errRepairServedModel : servedModel;
        // The repair error's own headers first; when it exposes none, the
        // MAIN response's still-honest limit evidence — dropping it would
        // hide quota/reset facts already observed on this run.
        const errSignals =
          providerSignalsFromHeaders(err.response?.headers as Record<string, string> | undefined) ??
          signals ??
          providerSignalsFromHeaders(responseHeaders);
        return {
          ...(errModel !== undefined ? { model: errModel } : {}),
          // Same aggregate-pricing rule as the returned-repair paths: only
          // a 'match' (both observed and equal, or neither observed) prices.
          ...(errIdentity === 'match'
            ? verdictExtras(totalUsage)
            : { usage: totalUsage, steps: mainSteps + repairSteps }),
          sessionId: record.sessionId,
          denials,
          ...capabilityEvidence,
          stopReason: 'error',
          error: boundedErrorText(
            `ai-sdk driver: structured output invalid after the repair attempt — ${rejection}; repair: ${describeError(err)}`,
          ),
          errorClass: 'output-invalid',
          ...(errSignals !== undefined ? { providerSignals: errSignals } : {}),
        };
      }
      return {
        ...(servedModel !== undefined ? { model: servedModel } : {}),
        // Failed requests may contain unobserved spend; partial usage cannot price the run.
        usage: totalUsage,
        steps: mainSteps + repairSteps,
        sessionId: record.sessionId,
        denials,
        ...capabilityEvidence,
        stopReason: aborted ? 'aborted' : 'error',
        ...(!aborted
          ? {
              error: boundedErrorText(
                `ai-sdk driver: structured output invalid and the repair attempt failed — ${rejection}; repair failure: ${describeError(err)}`,
              ),
              errorClass: classifyRunFailure(err),
            }
          : {}),
        // The failure error's own signals first; when it exposes none, the
        // MAIN response's limit evidence stays on the verdict (same
        // fallback as the parse-miss path above).
        ...(signals !== undefined
          ? { providerSignals: signals }
          : (() => {
              const mainSignals = providerSignalsFromHeaders(responseHeaders);
              return mainSignals !== undefined ? { providerSignals: mainSignals } : {};
            })()),
      };
    }
  }

  /** Resolve the frozen ModelSpec onto a live provider instance. Throws before dispatch. */
  private resolveModel(modelSpec: ModelSpec, sessionId?: string): LanguageModel {
    const factory = this.providers[modelSpec.provider];
    if (factory === undefined) {
      // Pre-dispatch misconfiguration carries its class as structured data
      // (ADR-0002 §2.2): errorClassOf → 'config'.
      throw new DispatchError(
        'config',
        `ai-sdk driver: unknown provider '${modelSpec.provider}' (known: ${Object.keys(this.providers).join(', ')})`,
      );
    }
    return factory(modelSpec.model, sessionId);
  }

  private validatePromptBudget(prompt: string): void {
    const maxChars = this.harnessConfig.promptBudget.maxSystemPromptChars;
    if (prompt.length > maxChars) {
      throw new Error(
        `ai-sdk driver: op prompt is ${prompt.length} chars, over the harness prompt budget of ${maxChars} — refusing (not truncating caller data)`,
      );
    }
  }

  /** The system prompt is driver-owned guidance; caller task text stays in its user turn. */
  private composeSystemPrompt(hasTools: boolean): string {
    return hasTools ? SYSTEM_PREAMBLE : TOOL_FREE_PREAMBLE;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers — pure, exported only where the conformance suite needs them
// ---------------------------------------------------------------------------

/** Minimal harness preamble the driver adds to every composed system prompt. */
const SYSTEM_PREAMBLE =
  'You are a cq-toolkit worker executing one task. ' +
  'Work inside the provided workspace directory; use the available tools to read, edit, and run. ' +
  'Tool refusals arrive as denial text — adapt instead of retrying the same call.';

const TOOL_FREE_PREAMBLE =
  'You are a cq-toolkit worker executing one task. ' +
  'You have no tools: everything you need is in the messages below. Answer directly.';

/**
 * Providers whose chat route cannot carry `response_format: json_schema`
 * (live probe 2026-10-25): the OpenCode Go gateway answers 400 to any
 * json_schema request, and the Z.ai provider drops the schema with a
 * warning, so the model never sees it. On these routes the schema rides a
 * trailing user turn, the reply text is parsed as JSON, and the shared
 * validator judges it exactly as it judges a native structured object.
 */
const PROMPTED_SCHEMA_PROVIDERS: ReadonlySet<string> = new Set(['opencode-go', 'zai', 'ai-sdk']);

function promptedSchemaProvider(provider: string): boolean {
  return PROMPTED_SCHEMA_PROVIDERS.has(provider);
}

function schemaContract(outputSchema: OutputSchema, hasTools: boolean): string {
  const instruction = hasTools
    ? 'Use the tools to complete the task first. When you are done, reply with ONLY one JSON object — no prose, no code fences —'
    : 'Reply with ONLY one JSON object — no prose, no code fences, no tool calls —';
  return (
    `${instruction} that validates against this JSON Schema ` +
    `(draft 2020-12):\n${JSON.stringify(outputSchema.schema)}`
  );
}

/** The trailing user turn on the forced final step; the request is otherwise unchanged. */
function finalStepContract(outputSchema: OutputSchema, prompted: boolean): string {
  const instruction =
    'This is your final step: do not call any more tools. ' +
    'Reply now with ONLY one JSON object — no prose, no code fences —';
  return prompted
    ? `${instruction} that validates against this JSON Schema ` +
        `(draft 2020-12):\n${JSON.stringify(outputSchema.schema)}`
    : `${instruction} matching the required response format.`;
}

/** Parse a prompted-schema reply: bare JSON, one fenced block, or the outermost object. */
export function parseReplyJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch (error) {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    try {
      if (start === -1 || end <= start) throw error;
      if (
        /<[|｜]DSML[|｜]|<tool_call>|<function_call>/.test(
          body.slice(0, start) + body.slice(end + 1),
        )
      ) {
        throw new Error('model emitted tool-call markup instead of the JSON reply');
      }
      return JSON.parse(body.slice(start, end + 1));
    } catch (parseError) {
      if (/<[|｜]DSML[|｜]|<tool_call>|<function_call>/.test(text)) {
        throw new Error('model emitted tool-call markup instead of the JSON reply');
      }
      throw parseError;
    }
  }
}

/** ISO-8601 timestamp for session messages. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The LIVE aborted state of the run signal. Deliberately a function, never
 * an inline `signal?.aborted === true` at use sites: the pre-dispatch guard
 * narrows a variable's flow type, but the SIGNAL OBJECT is live — it can
 * fire at any moment — and a read after the guard must observe that, not
 * the entry-time snapshot.
 */
function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Production provider registry — real @ai-sdk provider instances, built
 * lazily per run() call so environment API keys are read AT CALL TIME. A
 * missing key throws a clear error before dispatch.
 *
 * The `zai` handle defaults to the GLM CODING PLAN's OpenAI-compatible
 * endpoint (https://api.z.ai/api/coding/paas/v4 — the plan-funded wire,
 * owner-verified 2026-09-14: the pay-as-you-go /api/paas/v4 rejects the
 * plan key with 429 insufficient-balance BY DESIGN, while the coding
 * endpoint answers 200). ZAI_BASE_URL overrides the base URL for
 * deployments on the pay-as-you-go wire.
 *
 * THE `opencode-go` HANDLE (dev-strategy §8 item 7): OpenCode's Go
 * subscription wire, OpenAI-compatible CHAT COMPLETIONS only. The model
 * AND the route are CONFIGURATION, never constants (owner ruling
 * 2026-10-16): the key is read from OPENCODE_GO_API_KEY and the base URL
 * from OPENCODE_GO_BASE_URL — REQUIRED, with NO built-in default route, so
 * a deployment points the handle at its wire explicitly (the captured Go
 * origin lives in the pricing profile's endpoint-scoped 402 rule,
 * provider-profiles.ts, and is deliberately not duplicated here). The
 * provider supplies the persisted session id when resuming, or a fresh UUID
 * for a new run, as Go uses conversation ids for routing and prompt caching.
 * model id rides ModelSpec.model verbatim — `.chat(modelId)`, no aliasing.
 * The Go wire ECHOES the requested id in the response `model` field (RS-14
 * capture: the upstream serving provider surfaces only in routing
 * headers, which are explicitly NOT a served-id alias — see
 * candidate-aliases.ts), so deployments request the served id directly; a
 * deployment that observes a remap declares it under
 * DriverFactoryConfig.servedModel.aliases['ai-sdk']['opencode-go'] —
 * config-owned data, never a built-in row. The wire's Responses-only ids
 * (the muse/luna family) are NOT addressable through this handle: it
 * speaks chat completions only, and no chat route is fabricated for them.
 * Funded-allowance exhaustion on this wire is HTTP 402 → 'quota'
 * (classifyRunFailure below).
 *
 * THE `ai-sdk` HANDLE (review-debt #186): the self-hosting default's
 * provider (SelfhostDefaults.driver.provider) names the DRIVER, not a
 * vendor — "the Z.AI coding endpoint is the ai-sdk default route" (see
 * src/selfhost/config.ts). The registry honors it as an alias for the zai
 * factory so an op that routes its driver by provider handle can bind the
 * in-process lane (no host CLI) for exactly that handle, while real vendor
 * handles keep their own routes.
 */
function defaultProviders(fetch: typeof globalThis.fetch): Record<string, ProviderFactory> {
  const requireEnv = (provider: string, envName: string): string => {
    const value = process.env[envName];
    if (value === undefined || value === '') {
      // Pre-dispatch misconfiguration carries its class as structured data
      // (ADR-0002 §2.2): errorClassOf → 'config'.
      throw new DispatchError(
        'config',
        `ai-sdk driver: provider '${provider}' requires ${envName} in the environment`,
      );
    }
    return value;
  };
  const zai =
    (handle: string) =>
    (modelId: string): LanguageModel =>
      createZai({
        apiKey: requireEnv(handle, 'ZAI_API_KEY'),
        baseURL: process.env.ZAI_BASE_URL ?? 'https://api.z.ai/api/coding/paas/v4',
        fetch,
      }).languageModel(modelId);
  return {
    anthropic: (modelId) =>
      createAnthropic({
        apiKey: requireEnv('anthropic', 'ANTHROPIC_API_KEY'),
        fetch,
      }).languageModel(modelId),
    openai: (modelId) =>
      createOpenAI({ apiKey: requireEnv('openai', 'OPENAI_API_KEY'), fetch }).languageModel(
        modelId,
      ),
    zai: zai('zai'),
    // The driver-kind alias (see header): the self-host default provider.
    // It reports ITS OWN handle in a missing-key error (not 'zai'), so the
    // message names the provider the caller actually configured.
    'ai-sdk': zai('ai-sdk'),
    deepseek: (modelId) =>
      createDeepSeek({
        apiKey: requireEnv('deepseek', 'DEEPSEEK_API_KEY'),
        fetch,
      }).languageModel(modelId),
    // Chat-completions-only OpenCode Go handle (see the doc comment above):
    // both the credential and the route are required env reads — there is
    // deliberately NO default base-URL literal here.
    'opencode-go': (modelId, sessionId) =>
      createOpenAI({
        apiKey: requireEnv('opencode-go', 'OPENCODE_GO_API_KEY'),
        baseURL: requireEnv('opencode-go', 'OPENCODE_GO_BASE_URL'),
        headers: { 'x-opencode-session': sessionId ?? randomUUID() },
        fetch,
      }).chat(modelId),
  };
}

/**
 * Frozen ToolPolicy → the per-op tool subset: 'none' → nothing;
 * 'unrestricted' → the whole harness surface; 'allowlist' (the default
 * reading when mode is omitted) → names in `allow` only.
 */
export function selectTools(tools: readonly ToolkitTool[], policy: ToolPolicy): ToolkitTool[] {
  const mode = policy.mode ?? 'allowlist';
  if (mode === 'none') return [];
  if (mode === 'unrestricted') return [...tools];
  // One-release alias: `run` in a ToolPolicy selects the canonical `bash`.
  const allowed = new Set(policy.allow.map((name) => canonicalToolName(name)));
  return tools.filter((t) => allowed.has(canonicalToolName(t.name)));
}

/**
 * Execute one harness tool inside the SDK loop: persist the outcome as a
 * session message (our vocabulary), surface denials to the model as the
 * tool's output text AND accumulate them verbatim for WorkerResult.denials.
 */
async function runTool(
  harnessTool: ToolkitTool,
  input: unknown,
  store: SessionStore,
  record: SessionRecord,
  denials: ToolDenial[],
  guard?: AiSdkDriverOptions['beforeRequest'],
  options?: ToolExecuteOptions,
  onFailure?: (reason: string, kind: ToolFailureKind) => Promise<void>,
  scanDiagnostic?: AiSdkDriverOptions['beforeRequest'],
): Promise<string> {
  const result = await harnessTool.execute(input, options);
  if (!result.ok)
    await onFailure?.(
      result.denial.reason,
      toolFailureKind(result.denial.reason, 'EXECUTION_ERROR'),
    );
  else if (result.killed) {
    const kind = toolFailureKind(result.output, 'TIMEOUT');
    await onFailure?.(`${kind}: tool execution was killed`, kind);
  }
  if (guard !== undefined && result.ok) {
    const contents: { text: string; path?: string }[] = [{ text: result.output }];
    if (
      harnessTool.name === 'read' &&
      (record.workspace === undefined || (result.sourceContents?.length ?? 0) === 0)
    ) {
      throw new Error('read upload lacks source provenance');
    }
    if (result.sourceContents !== undefined) contents.push(...result.sourceContents);
    await guard(result.output, contents, { kind: 'tool-output' });
  }
  // The scan-only provenance (raw file text) must NOT persist: the tool
  // result is JSON-stringified into the transcript and replayed verbatim on
  // resume — sourceContents would put pre-cap-scan-only data past the output
  // bounds and leak it to a later model turn. Strip it AFTER the guard, keep
  // the guard itself unconditional (user-approved contract).
  const persistable =
    result.ok && result.sourceContents !== undefined
      ? (() => {
          const { sourceContents: _scanOnly, ...rest } = result;
          return rest;
        })()
      : result;
  let description: string | undefined;
  if (
    harnessTool.name === 'bash' &&
    typeof input === 'object' &&
    input !== null &&
    'description' in input &&
    typeof input.description === 'string'
  ) {
    description = '[description omitted: no scanner]';
    if (scanDiagnostic !== undefined) {
      try {
        await scanDiagnostic(input.description, undefined, { kind: 'tool-output' });
        description = boundedErrorText(input.description).slice(0, 1024);
      } catch {
        description = '[redacted: description scan refused]';
      }
    }
  }
  await store.appendMessage(record.sessionId, {
    role: 'tool',
    ...(description === undefined ? {} : { description }),
    toolName: harnessTool.name,
    content: JSON.stringify(persistable),
    at: nowIso(),
  });
  if (result.ok) {
    return result.output;
  }
  denials.push(result.denial);
  return result.denial.reason;
}

/** Our session transcript → SDK messages (plain text replay; tool turns folded into user turns). */
function transcriptMessages(messages: readonly SessionMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      out.push({ role: 'assistant', content: message.content });
    } else if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
    } else {
      out.push({
        role: 'user',
        content: `[tool ${message.toolName ?? 'unknown'}] ${message.content}`,
      });
    }
  }
  return out;
}

/** Timer-free Budget.maxTokens stop condition: fold accumulated step usage, compare, done. */
function tokenBudgetCondition(maxTokens: number): StopCondition<ToolSet> {
  return ({ steps }: { steps: ReadonlyArray<{ usage?: LanguageModelUsage }> }): boolean => {
    let total = 0;
    for (const step of steps) {
      total += step.usage?.totalTokens ?? 0;
    }
    return total >= maxTokens;
  };
}

/**
 * Exact ai@7.0.99 LanguageModelUsage → frozen Usage. Token details win over
 * the input total (noCacheTokens keeps cache fields from double-counting);
 * when a provider reports no details the total input is used with cache
 * fields at 0 — the same arithmetic, honestly stated. `reasoning` is
 * deliberately NOT set: the AI SDK counts reasoning tokens INSIDE
 * outputTokens (totalTokens = inputTokens + outputTokens), so lifting
 * outputTokenDetails.reasoningTokens into a separate field would make every
 * total that sums the frozen Usage fields (the kernel's
 * Budget.maxTokens/DD-9 rollup) diverge from the SDK's own totalTokens by
 * exactly `reasoning` — the frozen field stays optional precisely for lanes
 * whose SDK reports reasoning additive to output; this one does not.
 */
export function usageFromSdk(usage: LanguageModelUsage): Usage {
  const input = usage.inputTokenDetails?.noCacheTokens ?? usage.inputTokens ?? 0;
  return {
    input,
    output: usage.outputTokens ?? 0,
    cacheRead: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWrite: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

/**
 * Field-wise Usage fold (frozen Usage) — accumulates per-step evidence into
 * one rollup. `reasoning` sums the reported field itself; the CAP fold
 * (totalTokensOf) is where reasoning must not double-count.
 */
function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    ...(a.reasoning !== undefined || b.reasoning !== undefined
      ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) }
      : {}),
  };
}

/**
 * Σ of the frozen Usage fields — the Budget.maxTokens cap fold. `reasoning`
 * is NOT added on top: the frozen `output` field already includes reasoning
 * tokens (outputTokenDetails.reasoningTokens is a breakdown OF output), so
 * the fold counts them once, via output — output + reasoning would
 * double-count. The field stays on Usage as reported evidence; the
 * per-step accumulation (addUsage) still sums it.
 */
function totalTokensOf(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Derived-only cost field (DD-2): present only when the price lookup knows
 * the model. A present costUSD is labeled `costBasis: 'modeled'` — the
 * api-equivalent list-price figure for the tokens consumed, never a claim of
 * billed spend; an unknown model gets neither field (never fabricate).
 */
function costField(
  pricing: (modelSpec: ModelSpec) => PerMillionRates | undefined,
  modelSpec: ModelSpec,
  usage: Usage,
): { costUSD?: number; costBasis?: 'modeled' } {
  const rates = pricing(modelSpec);
  if (rates === undefined) {
    return {}; // unknown model — never fabricate
  }
  const perMillion = (tokens: number, rate: number | undefined): number =>
    rate === undefined ? 0 : (tokens / 1_000_000) * rate;
  const costUSD =
    perMillion(usage.input, rates.input) +
    perMillion(usage.output, rates.output) +
    perMillion(usage.cacheRead, rates.cacheRead) +
    perMillion(usage.cacheWrite, rates.cacheWrite);
  return { costUSD, costBasis: 'modeled' as const };
}

/** Inputs to the frozen stop-reason mapping (header table). */
export interface StopReasonInputs {
  finishReason: FinishReason;
  aborted: boolean;
  tokenBudget: number | undefined;
  totalTokens: number;
}

/** THE mapping (checked in order): aborted → budget → error → complete. */
export function stopReasonOf(inputs: StopReasonInputs): WorkerResult['stopReason'] {
  if (inputs.aborted) return 'aborted';
  if (inputs.tokenBudget !== undefined && inputs.totalTokens >= inputs.tokenBudget) return 'budget';
  if (inputs.finishReason === 'length') return 'budget';
  if (inputs.finishReason === 'error' || inputs.finishReason === 'content-filter') return 'error';
  return 'complete';
}

/**
 * The class of a caught run failure (seam v2, ADR-0002 §2.2) — classified
 * ONLY from structured signals, in the ADR's limit-cut order:
 *
 *   1. Status code plus the provider error code outrank message text.
 *   2. A provider error code in the FUNDED-ALLOWANCE set is 'quota',
 *      whatever its HTTP status (RS-14 §4 rule 2): `insufficient_quota`,
 *      `credit_balance_exhausted`, `*_spend_limit_exceeded`,
 *      `enforced_spend_limit_reached`. HTTP 402 (DeepSeek, OpenCode Zen) and
 *      the Z.AI coding wire's 429 are in the same funded-allowance set — a
 *      bare "429 ⇒ rate limit" rule misclassifies these quota 429s.
 *   3. 401/403 → 'auth'.
 *   4. Any other 429: 'rate-limit' when a retry-after is present (on this
 *      response OR elsewhere in the wrapped error chain); a bare 429 with no
 *      retry-after anywhere is a 'provider-error'.
 *   5. 408/5xx → 'transient'.
 *   6. No HTTP status: the SDK's retryable class IS the transient signal
 *      (network failure / endpoint header timeout); the SDK step-timeout
 *      DOMException (name 'TimeoutError') is 'transient' for the same
 *      reason.
 *
 * Anything unresolved is 'unknown' — NEVER a guessed 'transient' (the old
 * unanchored `\b(408|409|429|5\d\d)\b` message regex is deleted: a status
 * number embedded in prose is not a status code).
 */
export function classifyRunFailure(err: unknown): WorkerErrorClass {
  // Depth-first over the throw's chain: RetryError (the SDK's
  // exhausted-retry wrapper) names the LAST attempt error as its final
  // `errors` entry / cause — that final attempt is the classification
  // subject, and a retry-after on any wrapped error counts (cut 4).
  const apiErrors = apiErrorsIn(err);
  const primary = apiErrors[0];
  if (primary !== undefined) {
    const statusCode = primary.statusCode;
    // Cut 2, codes first: funded-allowance exhaustion is quota at any status.
    if (isFundedAllowanceCode(providerErrorCodeOf(primary))) return 'quota';
    // The Z.AI coding wire's 429 is the plan-funded quota wall, not a
    // throttle (the request URL the SDK reports is the structured signal).
    if (
      statusCode === 429 &&
      typeof primary.url === 'string' &&
      primary.url.includes('/api/coding/')
    ) {
      return 'quota';
    }
    // HTTP 402 — funded balance exhausted (DeepSeek, OpenCode Zen and the
    // OpenCode Go wire, whose per-model monthly allowance answers the same
    // status; the pricing profile's endpoint-scoped rule discriminates the
    // two wires at the profile layer).
    if (statusCode === 402) return 'quota';
    // Cut 3.
    if (statusCode === 401 || statusCode === 403) return 'auth';
    // Cut 4: the 429 discrimination.
    if (statusCode === 429) {
      if (apiErrors.some((api) => retryAfterMsFromHeaders(api.responseHeaders) !== undefined)) {
        return 'rate-limit';
      }
      return 'provider-error';
    }
    // Cut 5.
    if (statusCode === 408 || (statusCode !== undefined && statusCode >= 500)) return 'transient';
    // Cut 6: the SDK's own retryable class marks network/header-timeout
    // failures — a structured SDK signal, not message text.
    if (primary.isRetryable) return 'transient';
    // A non-retryable API error is a permanent provider failure even when
    // its diagnostic text contains a transient phrase.
    return 'provider-error';
  }
  if (err instanceof Error && err.name === 'TimeoutError') return 'transient';
  return 'unknown';
}

/**
 * The class for a RESOLVED run whose final step finished 'error' or
 * 'content-filter' (no caught cause exists): a provider content filter is a
 * provider-reported permanent refusal; anything else has no structured
 * signal and stays 'unknown'.
 */
function finishReasonErrorClass(finishReason: FinishReason): WorkerErrorClass {
  return finishReason === 'content-filter' ? 'provider-error' : 'unknown';
}

/**
 * Every APICallError reachable from a thrown value, depth-first: the value
 * itself, then an `errors` array walked LAST-first (the SDK's RetryError
 * keeps the final attempt last), then the `cause` chain. Depth-bounded; a
 * misbehaving chain cannot recurse forever.
 */
function apiErrorsIn(err: unknown): APICallError[] {
  const found: APICallError[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== 'object') return;
    if (APICallError.isInstance(value)) found.push(value);
    const record = value as { cause?: unknown; errors?: unknown };
    if (Array.isArray(record.errors)) {
      for (let index = record.errors.length - 1; index >= 0; index -= 1) {
        walk(record.errors[index], depth + 1);
      }
    }
    walk(record.cause, depth + 1);
  };
  walk(err, 0);
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathValue(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * The provider error code from an APICallError's STRUCTURED payload — the
 * parsed `data` or the JSON `responseBody` — checking the shapes vendors
 * actually use (`error.code`, `code`, `error.type`, `type`). Never the
 * message text: cut 1 gives codes rank over prose.
 */
function providerErrorCodeOf(api: APICallError): string | undefined {
  const candidates: unknown[] = [];
  for (const payload of [api.data, parsedResponseBody(api.responseBody)]) {
    if (!isRecord(payload)) continue;
    candidates.push(
      payload.code,
      pathValue(payload, 'error', 'code'),
      payload.type,
      pathValue(payload, 'error', 'type'),
    );
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return undefined;
}

function parsedResponseBody(body: string | undefined): unknown {
  if (typeof body !== 'string' || body === '') return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined; // a non-JSON body carries no code
  }
}

/** The RS-14 funded-allowance set: quota whatever the HTTP status (cut 2). */
const FUNDED_ALLOWANCE_CODES: ReadonlySet<string> = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'enforced_spend_limit_reached',
]);

function isFundedAllowanceCode(code: string | undefined): boolean {
  if (code === undefined) return false;
  return FUNDED_ALLOWANCE_CODES.has(code) || code.endsWith('_spend_limit_exceeded');
}

/** Case-insensitive header lookup over a plain header record. */
function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/**
 * `Retry-After` (or vendor equivalent) → milliseconds: delay-seconds form
 * (`'3741'` → 3_741_000) or HTTP-date (parsed against the current clock,
 * floored at 0). Anything else is absent — never invented.
 */
function retryAfterMsFromValue(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function retryAfterMsFromHeaders(headers: Record<string, string> | undefined): number | undefined {
  return retryAfterMsFromValue(headerValue(headers, 'retry-after'));
}

/**
 * A reset-instant header value → an ISO-8601 string: an ISO-8601/HTTP-date
 * parse wins; a vendor duration form (`'6m0s'`, `'90s'`, `'1h30m'`) is
 * anchored and added to the current clock. A bare digit string is AMBIGUOUS
 * (epoch seconds? seconds-until?) and is left out — never invent a reset.
 */
function resetAtFromValue(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  // A bare digit string is AMBIGUOUS (epoch seconds? seconds-until? a bare
  // year — V8's Date.parse('3741') accepts that!) and is left out — never
  // invent a reset.
  if (/^\d+$/.test(value)) return undefined;
  const at = Date.parse(value);
  if (Number.isFinite(at)) return new Date(at).toISOString();
  const duration =
    /^((?<days>\d+)d)?((?<hours>\d+)h)?((?<minutes>\d+)m)?((?<seconds>\d+)s)?((?<ms>\d+)ms)?$/.exec(
      value,
    );
  if (duration?.groups === undefined) return undefined;
  const { days, hours, minutes, seconds, ms } = duration.groups;
  const totalMs =
    Number(days ?? 0) * 86_400_000 +
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1000 +
    Number(ms ?? 0);
  if (totalMs <= 0) return undefined;
  return new Date(Date.now() + totalMs).toISOString();
}

/**
 * Provider limit headers → {@link ProviderSignals} (RS-14): only
 * structurally present data, never invented. Recognized families:
 * `retry-after`; `anthropic-ratelimit-unified-{scope}-percent-remaining` /
 * `-reset` (a percent-REMAINING source → utilization is the used fraction);
 * and the per-minute `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`
 * family (utilization derived from the limit/remaining counts). Absent when
 * no recognized header is present.
 */
export function providerSignalsFromHeaders(
  headers: Record<string, string> | undefined,
): ProviderSignals | undefined {
  if (headers === undefined) return undefined;
  const retryAfterMs = retryAfterMsFromHeaders(headers);
  const windows: NonNullable<ProviderSignals['windows']> = [];
  const windowOf = (id: string): NonNullable<ProviderSignals['windows']>[number] => {
    const existing = windows.find((entry) => entry.id === id);
    if (existing !== undefined) return existing;
    const created: NonNullable<ProviderSignals['windows']>[number] = { id };
    windows.push(created);
    return created;
  };
  // claude unified plan windows: percent-remaining (→ used fraction) + reset.
  for (const [key, value] of Object.entries(headers)) {
    const unified = /^anthropic-ratelimit-unified-(?<id>.+)-percent-remaining$/i.exec(key);
    const unifiedId = unified?.groups?.id;
    if (unifiedId !== undefined) {
      const percent = Number(value);
      if (Number.isFinite(percent)) {
        windowOf(unifiedId).utilization = Math.min(1, Math.max(0, 1 - percent / 100));
      }
      continue;
    }
    const unifiedReset = /^anthropic-ratelimit-unified-(?<id>.+)-reset$/i.exec(key);
    const unifiedResetId = unifiedReset?.groups?.id;
    if (unifiedResetId !== undefined) {
      const resetAt = resetAtFromValue(value);
      if (resetAt !== undefined) windowOf(unifiedResetId).resetAt = resetAt;
      continue;
    }
    // Per-minute API headers (Anthropic/OpenAI): remaining/limit/reset counts.
    const remaining = /^x-ratelimit-remaining-(?<id>requests|tokens)$/i.exec(key);
    const remainingId = remaining?.groups?.id;
    if (remainingId !== undefined) {
      const count = Number(value);
      // A remaining COUNT is a nonnegative integer (the mirror's bound, and
      // the doc's "counts"): a malformed header value is dropped, never
      // recorded as fabricated quota evidence (PR #238 review round 2).
      if (Number.isInteger(count) && count >= 0) {
        const win = windowOf(remainingId);
        win.remaining = {
          ...win.remaining,
          ...(remainingId === 'requests' ? { requests: count } : { tokens: count }),
        };
      }
      continue;
    }
    const limit = /^x-ratelimit-limit-(?<id>requests|tokens)$/i.exec(key);
    const limitId = limit?.groups?.id;
    if (limitId !== undefined) {
      const limitValue = Number(value);
      const remainingValue = Number(
        headerValue(headers, `x-ratelimit-remaining-${limitId}`) ?? NaN,
      );
      if (Number.isFinite(limitValue) && limitValue > 0 && Number.isFinite(remainingValue)) {
        windowOf(limitId).utilization = Math.min(
          1,
          Math.max(0, (limitValue - remainingValue) / limitValue),
        );
      }
      continue;
    }
    const reset = /^x-ratelimit-reset-(?<id>requests|tokens)$/i.exec(key);
    const resetId = reset?.groups?.id;
    if (resetId !== undefined) {
      const resetAt = resetAtFromValue(value);
      if (resetAt !== undefined) windowOf(resetId).resetAt = resetAt;
      continue;
    }
  }
  if (retryAfterMs === undefined && windows.length === 0) return undefined;
  return {
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(windows.length > 0 ? { windows } : {}),
  };
}

/** The failure-path form: the caught chain's APICallError response headers. */
export function providerSignalsFromError(err: unknown): ProviderSignals | undefined {
  for (const api of apiErrorsIn(err)) {
    const signals = providerSignalsFromHeaders(api.responseHeaders);
    if (signals !== undefined) return signals;
  }
  return undefined;
}

/** Preserve undefined slots explicitly; refuse values JSON would silently erase or coerce. */
export function serializeRequestForScan(params: unknown): string {
  if (params === null || typeof params !== 'object')
    throw new Error('upload scan requires a request object');
  const active = new Set<object>();
  const inspect = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || value instanceof AbortSignal) return;
    if (active.has(value)) throw new Error('upload scan request is cyclic');
    if (
      'toJSON' in value ||
      (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    )
      throw new Error('upload scan request contains a non-JSON object');
    active.add(value);
    for (const entry of Object.values(value)) inspect(entry);
    active.delete(value);
  };
  inspect(params);
  return JSON.stringify(params, (_key, value: unknown) => {
    if (value === undefined) return '[undefined]';
    if (
      typeof value === 'function' ||
      typeof value === 'symbol' ||
      typeof value === 'bigint' ||
      (typeof value === 'number' && !Number.isFinite(value))
    )
      throw new Error('upload scan request contains a non-JSON value');
    return value;
  });
}
