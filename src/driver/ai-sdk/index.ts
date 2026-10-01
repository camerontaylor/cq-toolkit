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
//     races it. The SDK call's per-request `timeout.stepMs`
//     (DEFAULT_STEP_TIMEOUT_MS) is NOT a run deadline — it bounds one HTTP
//     request so a hung connection cannot stall the loop; WHEN to abort the
//     RUN remains the governor's decision.
//   - Budget.maxTokens is ENFORCED here, timer-free: it becomes a
//     `stopWhen` stop condition over the SDK's accumulated step usage (a
//     pure token fold — no scheduling primitive involved). stopWhen is
//     passed ALWAYS: `stepCountIs(DEFAULT_MAX_STEPS)` bounds the tool loop
//     even without a token cap (the SDK's own default is a single step,
//     under which tool calls are never followed up).
//   - Budget.maxAttempts is the runner/governor's retry business; this
//     driver makes exactly ONE attempt per run.
//   - Budget.maxUsd is caller-side derived accounting (USD is never
//     driver-trusted); ignored here.
//
// PROVIDER INSTANCES (seam rule): providers are imported DIRECTLY and
// instantiated as real language-model objects — never gateway string ids.
// The registry { anthropic, openai, zai, ai-sdk, deepseek } maps the frozen
// ModelSpec.provider handle onto the matching @ai-sdk factory; the model id
// rides ModelSpec.model. UNKNOWN PROVIDER THROWS BEFORE DISPATCH (and
// before any session is created) — fail loudly, never guess. Production
// default builds instances lazily at run() time with API keys read from the
// environment AT CALL TIME (ANTHROPIC_API_KEY / OPENAI_API_KEY /
// ZAI_API_KEY / DEEPSEEK_API_KEY; a missing key throws a clear error before
// dispatch). For testability the constructor accepts a `providers` override
// map (name → (modelId) => language-model instance); the conformance suite
// injects a mock there and never touches the network.
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
//     (W3.4: tool-free, over the session transcript, the JSON Schema
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
// DEFAULT_STEP_TIMEOUT_MS (a hung HTTP request cannot stall the loop); that
// per-request step-timeout abort is NOT SDK-retryable and therefore
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
  Output,
  stepCountIs,
  tool,
} from 'ai';
import type {
  FinishReason,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  StopCondition,
  ToolSet,
} from 'ai';
import type { JSONSchema7 } from '@ai-sdk/provider';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createZai } from '@ai-sdk/zai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { deepFreeze, defaultHarnessConfig } from '../../harness/config.js';
import type { HarnessConfig } from '../../harness/config.js';
import { buildTools } from '../../harness/tools.js';
import { harnessRunGate } from '../../sandbox/index.js';
import type { SandboxConfig } from '../../sandbox/index.js';
import type { ToolkitTool } from '../../harness/tools.js';
import { SessionStore, tempWorkspace } from '../../harness/session.js';
import type { SessionMessage, SessionRecord } from '../../harness/session.js';
import { boundedErrorText, describeError } from '../error-text.js';
import { DispatchError } from '../errors.js';
import { boundWorkspacePath, resumedRecordOrThrow } from '../common/workspace.js';
import { compileOutputSchemaFault, validateStructured } from '../common/structured.js';
import { priceOf } from '../pricing/index.js';
import type { PerMillionRates } from '../pricing/index.js';
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

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** A provider factory: frozen ModelSpec.model id → a live language-model instance. */
export type ProviderFactory = (modelId: string) => LanguageModel;

/**
 * The multi-step default for the SDK tool loop (ai@7.0.99). TOOL-CALL LOOPS
 * NEED MULTI-STEP: without an explicit `stopWhen` the SDK's default is
 * `stepCountIs(1)` — the run would return after the FIRST tool-calls step,
 * so tool calls would never be followed up. 8 steps bounds the loop
 * defensively (a misbehaving model cannot loop forever) while remaining a
 * pure STEP COUNT, not a scheduling primitive (I8: WHEN to abort on time is
 * still the governor's ladder; Budget.maxTokens is the token-side bound).
 */
export const DEFAULT_MAX_STEPS = 8;

/**
 * Per-request wall-clock bound for EACH step of the SDK tool loop
 * (`timeout.stepMs`, ai@7.0.99). This is NOT a run deadline — the governor's
 * escalation ladder owns WHEN to abort the run (I8; Budget.wallClockMs is
 * ignored here). It bounds a single provider HTTP request so a hung
 * connection cannot stall the loop indefinitely; the SDK aborts that step
 * and surfaces the cause, which the classifier maps to [endpoint-timeout].
 */
export const DEFAULT_STEP_TIMEOUT_MS = 120_000;

/** Constructor options — everything optional; defaults are production-real. */
export interface AiSdkDriverOptions {
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
  /** Sessions directory for the backing SessionStore. Default: <os.tmpdir()/cq-harness>/sessions. */
  sessionsDir?: string;
  /**
   * Price-lookup override for the derived-only costUSD rule (default:
   * `priceOf` over the vendored models.dev table). Tests and per-deployment
   * price tables inject here; the conformance suite's priced-model test
   * rides this seam. A lookup returning undefined keeps costUSD absent.
   */
  pricing?: (modelSpec: ModelSpec) => PerMillionRates | undefined;
}

/**
 * The in-process ai-sdk driver implementing the frozen Driver seam. One
 * instance is stateless across runs — all per-run state (session record,
 * denials) lives in the run call — so a single instance can serve many
 * isolated invocations.
 */
export class AiSdkDriver implements Driver {
  private readonly providers: Readonly<Record<string, ProviderFactory>>;
  private readonly harnessConfig: HarnessConfig;
  private readonly sandboxConfig: SandboxConfig | undefined;
  private readonly sessionsDir: string | undefined;
  private readonly pricing: (modelSpec: ModelSpec) => PerMillionRates | undefined;

  constructor(options: AiSdkDriverOptions = {}) {
    this.providers = options.providers ?? defaultProviders();
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
    this.pricing = options.pricing ?? priceOf;
  }

  /** The frozen seam (v2): run one invocation to completion. */
  async run(opInvocation: OpInvocation, options?: RunOptions): Promise<WorkerResult> {
    const { prompt, modelSpec, toolPolicy, sandboxPolicy, sessionRef, budget } = opInvocation;

    // --- Structured-output preflight (PR #238 review round 2): the schema
    // document is caller-authored plain data — compile it FIRST, before
    // even the provider handle is resolved. An uncompilable document is the
    // uniform LOCAL 'output-invalid' verdict (the settle-time miss shape),
    // never a provider/harness failure from a request-setup rejection. No
    // record exists yet (none is created): zero usage, no denials, no
    // sessionId.
    if (opInvocation.outputSchema !== undefined) {
      const schemaFault = compileOutputSchemaFault(opInvocation.outputSchema);
      if (schemaFault !== undefined) {
        return {
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'error',
          error: boundedErrorText(`ai-sdk driver: structured output invalid — ${schemaFault}`),
          errorClass: 'output-invalid',
        };
      }
    }

    // --- Pre-dispatch validation: everything here throws BEFORE the model
    // is contacted and BEFORE any session/workspace exists (fail loudly, no
    // partial state).
    const model = this.resolveModel(modelSpec);
    const system = this.composeSystemPrompt(prompt);
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

    // --- Governed cancellation (I8): the governor decides WHEN to abort; ---
    // the driver only forwards its signal. No driver-owned wall clock. The
    // SOURCE is the seam-v2 RunOptions.signal — the ONLY cancellation
    // channel. An already-aborted signal never dispatches and creates NO
    // session state: zero usage, no denials, no sessionId (no record was
    // created).
    const abortSignal = options?.signal;
    if (signalAborted(abortSignal)) {
      return {
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        denials: [],
        stopReason: 'aborted',
      };
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
    const harnessTools = buildTools(
      this.harnessConfig,
      record.workspace,
      sandboxPolicy.level,
      runGate,
    );
    const selected = selectTools(harnessTools, toolPolicy);
    const toolSet: ToolSet = {};
    for (const harnessTool of selected) {
      toolSet[harnessTool.name] = tool({
        description: harnessTool.description,
        inputSchema: harnessTool.inputSchema,
        execute: async (input: unknown): Promise<string> =>
          runTool(harnessTool, input, store, record, denials),
      });
    }

    // --- Timer-free budget + the tool-loop bound: stopWhen is ALWAYS ------
    // passed. With Budget.maxTokens the token fold trips the cap; without
    // one, stepCountIs(DEFAULT_MAX_STEPS) still bounds the tool loop — the
    // SDK's own default is a SINGLE step (stepCountIs(1)), under which tool
    // calls would never be followed up. Both ride the SDK's step loop: no
    // scheduling primitive (I8).
    const stopWhen: Array<StopCondition<ToolSet>> = [
      ...(budget.maxTokens !== undefined ? [tokenBudgetCondition(budget.maxTokens)] : []),
      stepCountIs(DEFAULT_MAX_STEPS),
    ];

    // Structured output (ADR-0002 §2.3): the invocation schema is the only
    // schema source; it normalizes to the same plain-data OutputSchema the
    // shared validator judges.
    const outputSchema = opInvocation.outputSchema;

    // --- The one SDK call. -------------------------------------------------
    // Per-step usage accumulation (DD-2 evidence): onStepFinish fires for
    // EVERY completed step — intermediate ones included — so a run that
    // fails mid-loop still carries the tokens its completed steps spent
    // (an error verdict reporting all-zero usage after real work would be
    // dishonest evidence). The fold never feeds a cost figure on this path.
    let stepUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    try {
      let result: Awaited<ReturnType<typeof generateText>>;
      try {
        result = await generateText({
          model,
          system,
          messages: transcript,
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
          // Per-request bound for EACH step (see DEFAULT_STEP_TIMEOUT_MS): a
          // hung request cannot stall the loop. The step-timeout abort is not
          // SDK-retryable; it classifies as 'transient' (TimeoutError name).
          timeout: { stepMs: DEFAULT_STEP_TIMEOUT_MS },
          ...(selected.length > 0 ? { tools: toolSet } : {}),
          // DECOUPLE the mandatory structured object from the tool loop (#203):
          // with tools available on the final step the model tends to call one
          // more tool instead of emitting the required object, and `result.output`
          // then throws. Disabling tools on that step nudges the model into
          // prose the Output.object path can parse. Pure step-number function —
          // no scheduling primitive (I8).
          ...(outputSchema !== undefined && selected.length > 0
            ? {
                prepareStep: ({ stepNumber }: { stepNumber: number }) =>
                  stepNumber >= DEFAULT_MAX_STEPS - 1 ? { activeTools: [] } : undefined,
              }
            : {}),
          stopWhen,
          onStepFinish: (step) => {
            stepUsage = addUsage(stepUsage, usageFromSdk(step.usage));
          },
          ...(abortSignal !== undefined ? { abortSignal } : {}),
          // Transport (ADR-0002 §2.3): the SDK's structured output over the
          // EXACT plain document the schema request carried — the native
          // `jsonSchema` wrapper, no second zod conversion. The wrapper ships
          // no `validate`, so the SDK's own parse is parse-level; the schema
          // judgment is `validateStructured` after settle, the same shared
          // validator every lane runs over the same stripped document.
          ...(outputSchema !== undefined
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
            rejection: `the reply carried no parseable object — ${describeError(err)}`,
            mainText: err.text ?? '',
            mainUsage: stepUsage,
            servedModel:
              typeof err.response?.modelId === 'string' && err.response.modelId !== ''
                ? err.response.modelId
                : undefined,
            responseHeaders: err.response?.headers,
            finishReason: err.finishReason ?? 'error',
            abortSignal,
            budget,
            model,
            system,
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
          parsed = result.output;
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
            rejection,
            mainText: text,
            mainUsage: usage,
            servedModel,
            responseHeaders: result.response.headers,
            finishReason,
            abortSignal,
            budget,
            model,
            system,
            transcript,
            store,
            record,
            modelSpec,
            denials,
          });
        }
      }

      // Assistant turn persisted in OUR vocabulary before the verdict.
      await store.appendMessage(record.sessionId, {
        role: 'assistant',
        content: text !== '' ? text : JSON.stringify(structuredOutput ?? ''),
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
        // PRICING KEY: derived over the OBSERVED served model id — a
        // silently-remapped gateway is priced off the id the response
        // reports (the same fact WorkerResult.model carries); the provider
        // handle stays modelSpec.provider (the price table's key).
        ...costField(this.pricing, { ...modelSpec, model: servedModel ?? modelSpec.model }, usage),
        sessionId: record.sessionId,
        denials,
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
      // Mid-run failure: return an honest error verdict (never throw past
      // the seam — the frozen result carries the evidence gathered so far).
      // An abort-shaped failure is the governor's cancellation, not an
      // error (I8). A missing structured object is an error verdict too:
      // the model never produced the required output.
      //
      // USAGE EVIDENCE IS KEPT: onStepFinish folded every completed step,
      // so the verdict carries the real tokens spent before the failure —
      // all-zero only when truly nothing completed. COST is NOT fabricated
      // (never-fabricate): cost is derived only from a FULL result usage
      // (the success and structured-output-miss paths); this partial fold
      // understates the run, so no figure is claimed.
      const aborted =
        signalAborted(abortSignal) || (err instanceof Error && err.name === 'AbortError');
      // Provider limit observations ride ANY verdict (RS-14): the caught
      // chain's APICallError headers, when present.
      const signals = providerSignalsFromError(err);
      return {
        usage: stepUsage,
        sessionId: record.sessionId,
        denials,
        stopReason: aborted ? 'aborted' : 'error',
        // The abort branch is the governor's cancellation (I8), not a
        // failure — only a real error carries its cause and its class
        // forward (PRODUCER RULE, ADR §2.2: every error verdict carries
        // errorClass, classified from structured signals only).
        ...(!aborted
          ? {
              error: boundedErrorText(`ai-sdk driver: run failed — ${describeError(err)}`),
              errorClass: classifyRunFailure(err),
            }
          : {}),
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
   * repair (ADR-0002 §2.3): ONE bounded request — tool-free (no tools at
   * all), over the session transcript so the model sees what it produced,
   * the JSON Schema restated in the prompt, `maxRetries: 0`, one step,
   * inside the SAME budget (the `maxTokens` remainder) and the SAME signal.
   * The repair is a REAL extra model call: its usage folds into the
   * verdict's alongside the main call's, and the derived cost is computed
   * over the folded usage. A validating repair object completes the run;
   * anything else settles the uniform 'error'/'output-invalid' verdict.
   */
  private async settleStructuredMiss(inputs: {
    outputSchema: OutputSchema;
    /** The main call's miss reason (bounded into the verdict text). */
    rejection: string;
    mainText: string;
    mainUsage: Usage;
    servedModel: string | undefined;
    responseHeaders: Record<string, string> | undefined;
    finishReason: FinishReason;
    abortSignal: AbortSignal | undefined;
    budget: Budget;
    model: LanguageModel;
    system: string;
    transcript: ModelMessage[];
    store: SessionStore;
    record: SessionRecord;
    modelSpec: ModelSpec;
    denials: ToolDenial[];
  }): Promise<WorkerResult> {
    const {
      outputSchema,
      rejection,
      mainText,
      mainUsage,
      servedModel,
      responseHeaders,
      finishReason,
      abortSignal,
      budget,
      model,
      system,
      transcript,
      store,
      record,
      modelSpec,
      denials,
    } = inputs;

    /** Fold-in helper: verdict usage over BOTH calls, cost over the fold. */
    const verdictExtras = (
      totalUsage: Usage,
    ): Pick<WorkerResult, 'usage' | 'costUSD' | 'costBasis'> => ({
      usage: totalUsage,
      ...costField(
        this.pricing,
        { ...modelSpec, model: servedModel ?? modelSpec.model },
        totalUsage,
      ),
    });
    /** Usage WITHOUT a derived cost — the mixed-identity (repair remap) verdict refuses to price. */
    const verdictUsageOnly = (totalUsage: Usage): Pick<WorkerResult, 'usage'> => ({
      usage: totalUsage,
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
          stopReason: 'aborted',
          ...verdictSignals(),
        };
      }
      return {
        ...(servedModel !== undefined ? { model: servedModel } : {}),
        ...verdictExtras(mainUsage),
        sessionId: record.sessionId,
        denials,
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
      ...(mainText.trim() !== '' ? [{ role: 'assistant' as const, content: mainText }] : []),
      {
        role: 'user',
        content:
          `Your previous reply did not satisfy the required JSON contract. ` +
          `Reply with ONLY one JSON object — no prose, no code fences — that validates ` +
          `against this JSON Schema (draft 2020-12):\n${JSON.stringify(outputSchema.schema)}`,
      },
    ];
    let repairUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    try {
      const repair = await generateText({
        model,
        system,
        messages: repairMessages,
        // W3.4: the repair gets ZERO SDK retries and exactly ONE step —
        // bounded, unlike the main loop.
        maxRetries: 0,
        timeout: { stepMs: DEFAULT_STEP_TIMEOUT_MS },
        ...(remainingTokens !== undefined
          ? { stopWhen: [tokenBudgetCondition(remainingTokens), stepCountIs(1)] }
          : { stopWhen: [stepCountIs(1)] }),
        onStepFinish: (step) => {
          repairUsage = addUsage(repairUsage, usageFromSdk(step.usage));
        },
        // Tool-free: NO tools key at all.
        ...(abortSignal !== undefined ? { abortSignal } : {}),
        output: Output.object({
          schema: jsonSchema(outputSchema.schema as unknown as JSONSchema7),
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
      ): Pick<WorkerResult, 'usage' | 'costUSD' | 'costBasis'> =>
        repairIdentity === 'match'
          ? {
              usage,
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
        const validated = validateStructured(outputSchema, repair.output);
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
          stopReason: repairStop,
          ...repairSignals(),
        };
      }
      return {
        ...(verdictModel !== undefined ? { model: verdictModel } : {}),
        ...repairVerdictExtras(totalUsage),
        sessionId: record.sessionId,
        denials,
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
          ...(errIdentity === 'match' ? verdictExtras(totalUsage) : { usage: totalUsage }),
          sessionId: record.sessionId,
          denials,
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
        sessionId: record.sessionId,
        denials,
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
  private resolveModel(modelSpec: ModelSpec): LanguageModel {
    const factory = this.providers[modelSpec.provider];
    if (factory === undefined) {
      // Pre-dispatch misconfiguration carries its class as structured data
      // (ADR-0002 §2.2): errorClassOf → 'config'.
      throw new DispatchError(
        'config',
        `ai-sdk driver: unknown provider '${modelSpec.provider}' (known: ${Object.keys(this.providers).join(', ')})`,
      );
    }
    return factory(modelSpec.model);
  }

  /**
   * The composed system prompt: minimal harness preamble (tool usage +
   * workspace note) + the op prompt. Budget rule (documented): the OP
   * PROMPT is caller data — if it alone exceeds maxSystemPromptChars the
   * run REFUSES loudly (throw before dispatch; silently truncating an op's
   * task would corrupt semantics). The PREAMBLE is ours — it is truncated
   * to fit the remaining budget. The op prompt ALSO rides as the terminal
   * user turn of the conversation (chat providers require a real user
   * turn to answer; the composed system states the task and the boundary
   * rules) — the prompt budget accounts for the composed system, the user
   * turn is the model's input message, not system-prompt text.
   */
  private composeSystemPrompt(prompt: string): string {
    const maxChars = this.harnessConfig.promptBudget.maxSystemPromptChars;
    if (prompt.length > maxChars) {
      throw new Error(
        `ai-sdk driver: op prompt is ${prompt.length} chars, over the harness prompt budget of ${maxChars} — refusing (not truncating caller data)`,
      );
    }
    const room = maxChars - prompt.length - 2; // '\n\n' separator
    const preamble =
      room <= 0
        ? ''
        : SYSTEM_PREAMBLE.length <= room
          ? SYSTEM_PREAMBLE
          : SYSTEM_PREAMBLE.slice(0, room);
    // An empty preamble has nothing to separate: the prompt rides ALONE.
    // The unconditional separator would compose prompt.length + 2 chars —
    // slipping past the very budget it enforces.
    return preamble === '' ? prompt : `${preamble}\n\n${prompt}`;
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

/** Default sessions dir (sibling of the harness temp-workspace root). */
function defaultSessionsDir(): string {
  return join(tmpdir(), 'cq-harness', 'sessions');
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
 * THE `ai-sdk` HANDLE (review-debt #186): the self-hosting default's
 * provider (SelfhostDefaults.driver.provider) names the DRIVER, not a
 * vendor — "the Z.AI coding endpoint is the ai-sdk default route" (see
 * src/selfhost/config.ts). The registry honors it as an alias for the zai
 * factory so an op that routes its driver by provider handle can bind the
 * in-process lane (no host CLI) for exactly that handle, while real vendor
 * handles keep their own routes.
 */
function defaultProviders(): Record<string, ProviderFactory> {
  const requireKey = (provider: string, envName: string): string => {
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
        apiKey: requireKey(handle, 'ZAI_API_KEY'),
        baseURL: process.env.ZAI_BASE_URL ?? 'https://api.z.ai/api/coding/paas/v4',
      }).languageModel(modelId);
  return {
    anthropic: (modelId) =>
      createAnthropic({ apiKey: requireKey('anthropic', 'ANTHROPIC_API_KEY') }).languageModel(
        modelId,
      ),
    openai: (modelId) =>
      createOpenAI({ apiKey: requireKey('openai', 'OPENAI_API_KEY') }).languageModel(modelId),
    zai: zai('zai'),
    // The driver-kind alias (see header): the self-host default provider.
    // It reports ITS OWN handle in a missing-key error (not 'zai'), so the
    // message names the provider the caller actually configured.
    'ai-sdk': zai('ai-sdk'),
    deepseek: (modelId) =>
      createDeepSeek({ apiKey: requireKey('deepseek', 'DEEPSEEK_API_KEY') }).languageModel(modelId),
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
  const allowed = new Set(policy.allow);
  return tools.filter((t) => allowed.has(t.name));
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
): Promise<string> {
  const result = await harnessTool.execute(input);
  await store.appendMessage(record.sessionId, {
    role: 'tool',
    toolName: harnessTool.name,
    content: JSON.stringify(result),
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
    // HTTP 402 — funded balance exhausted (DeepSeek, OpenCode Zen).
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
      if (Number.isFinite(count)) {
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
