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
// the governor's decision (T1.3), and this driver only OBEYS. It reads the
// governed context via `currentJobContext()` (imported from
// ../../kernel/governor.js — the one deliberate driver→kernel import: the
// governor's cooperative-cancel channel is the process-wide job context)
// and passes `context?.signal` into the SDK call's `abortSignal` option.
// Outside a governed run the signal is undefined and the SDK call is simply
// not wired to a cancellation source. Consequences, documented:
//   - Budget.wallClockMs is IGNORED here — the governor's escalation ladder
//     is the wall-clock owner; a driver-owned deadline would duplicate and
//     races it.
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
//     with a previous one.
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
// STRUCTURED OUTPUT: constructor option `outputSchema?: ZodType` — when
// set, the SDK's structured-output path (`Output.object({ schema })`) runs
// and the parsed value lands in WorkerResult.structuredOutput as plain
// JSON. Data-driven by construction; per-op schema registries (an op-name →
// schema table owned by the composition layer) are a later-lane concern —
// the frozen OpInvocation cannot carry a schema, so callers configure the
// driver instance per op family until that lane lands.
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
//   1. governed signal fired (context.signal.aborted) or the SDK call threw
//      an abort-shaped error          → 'aborted'
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
import { generateText, Output, stepCountIs, tool } from 'ai';
import type {
  FinishReason,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  StopCondition,
  ToolSet,
} from 'ai';
import type { ZodType } from 'zod';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createZai } from '@ai-sdk/zai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { currentJobContext } from '../../kernel/governor.js';
import { deepFreeze, defaultHarnessConfig } from '../../harness/config.js';
import type { HarnessConfig } from '../../harness/config.js';
import { buildTools } from '../../harness/tools.js';
import type { ToolkitTool } from '../../harness/tools.js';
import { SessionStore, tempWorkspace } from '../../harness/session.js';
import type { SessionMessage, SessionRecord } from '../../harness/session.js';
import { boundedErrorText, describeError } from '../error-text.js';
import { priceOf } from '../pricing/index.js';
import type { PerMillionRates } from '../pricing/index.js';
import type { Driver, ToolDenial, ToolPolicy, Usage, WorkerResult } from '../types.js';
import type { ModelSpec, OpInvocation } from '../types.js';

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

/** Constructor options — everything optional; defaults are production-real. */
export interface AiSdkDriverOptions {
  /**
   * Provider registry override (name → factory). Unknown provider names
   * still throw before dispatch. Tests inject mocks here; the production
   * default builds real provider instances lazily per run with API keys
   * read from the environment at call time.
   */
  providers?: Readonly<Record<string, ProviderFactory>>;
  /**
   * Structured-output schema (data-driven). When set, the SDK's
   * Output.object path runs and the parsed value lands in
   * WorkerResult.structuredOutput. Per-op schema registries are a
   * later-lane concern (see header).
   */
  outputSchema?: ZodType;
  /** Harness config (tool surface + prompt budget). Default: defaultHarnessConfig. */
  harnessConfig?: HarnessConfig;
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
  private readonly outputSchema: ZodType | undefined;
  private readonly harnessConfig: HarnessConfig;
  private readonly sessionsDir: string | undefined;
  private readonly pricing: (modelSpec: ModelSpec) => PerMillionRates | undefined;

  constructor(options: AiSdkDriverOptions = {}) {
    this.providers = options.providers ?? defaultProviders();
    this.outputSchema = options.outputSchema;
    // The effective config is stored as a deep-frozen STRUCTURED CLONE:
    // neither the caller's object (mutated after construction) nor the
    // shared `defaultHarnessConfig` can be reached — or mutated — through
    // the driver (a shared mutable default would leak one caller's change
    // into every later run).
    this.harnessConfig = deepFreeze(structuredClone(options.harnessConfig ?? defaultHarnessConfig));
    this.sessionsDir = options.sessionsDir;
    this.pricing = options.pricing ?? priceOf;
  }

  /** The frozen seam: run one invocation to completion. */
  async run(opInvocation: OpInvocation): Promise<WorkerResult> {
    const { prompt, modelSpec, toolPolicy, sandboxPolicy, sessionRef, budget } = opInvocation;

    // --- Pre-dispatch validation: everything here throws BEFORE the model
    // is contacted and BEFORE any session/workspace exists (fail loudly, no
    // partial state).
    const model = this.resolveModel(modelSpec);
    const system = this.composeSystemPrompt(prompt);

    // --- I6 isolation: fresh record + fresh workspace, or a real resume. --
    const store = new SessionStore(this.sessionsDir ?? defaultSessionsDir());
    const record =
      sessionRef === undefined
        ? await store.create(await tempWorkspace(this.harnessConfig.workspaceRoot))
        : await loadSessionOrThrow(store, sessionRef);
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
    const denials: ToolDenial[] = [];
    const harnessTools = buildTools(this.harnessConfig, record.workspace, sandboxPolicy.level);
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

    // --- Governed cancellation (I8): the governor decides WHEN to abort; ---
    // the driver only forwards its signal. No driver-owned wall clock.
    const governed = currentJobContext();
    const abortSignal = governed?.signal;

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

    // --- The one SDK call. -------------------------------------------------
    // Per-step usage accumulation (DD-2 evidence): onStepFinish fires for
    // EVERY completed step — intermediate ones included — so a run that
    // fails mid-loop still carries the tokens its completed steps spent
    // (an error verdict reporting all-zero usage after real work would be
    // dishonest evidence). The fold never feeds a cost figure on this path.
    let stepUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    try {
      const result = await generateText({
        model,
        system,
        messages: transcript,
        // NO driver-side retries: attempts are the runner/governor's
        // business (a retry here would hide attempts from the journal), and
        // a governed abort must surface immediately.
        maxRetries: 0,
        ...(selected.length > 0 ? { tools: toolSet } : {}),
        // DECOUPLE the mandatory structured object from the tool loop (#203):
        // with tools available on the final step the model tends to call one
        // more tool instead of emitting the required object, and `result.output`
        // then throws. Disabling tools on that step nudges the model into
        // prose the Output.object path can parse. Pure step-number function —
        // no scheduling primitive (I8).
        ...(this.outputSchema !== undefined && selected.length > 0
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
        ...(this.outputSchema !== undefined
          ? { output: Output.object({ schema: this.outputSchema }) }
          : {}),
      });

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
      let structuredOutput: unknown;
      if (this.outputSchema !== undefined) {
        // Reading `output` can throw (ai@7.0.99): NoOutputGeneratedError when
        // the final step ended on tool-calls, NoObjectGeneratedError when the
        // text does not parse against the schema. Both are DRIVER-LEVEL
        // failures, not scored model outcomes — never fabricate a
        // structuredOutput, never fall through to a 'complete' verdict.
        try {
          structuredOutput = result.output; // parsed plain JSON per Output.object
        } catch (err) {
          // Persist the assistant turn exactly as the success path does
          // (result.text when non-empty) — the model's text is real evidence
          // even though the required object never arrived.
          if (text !== '') {
            await store.appendMessage(record.sessionId, {
              role: 'assistant',
              content: text,
              at: nowIso(),
            });
          }
          const mapped = stopReasonOf({
            finishReason,
            aborted: abortSignal?.aborted === true,
            tokenBudget: budget.maxTokens,
            totalTokens: totalTokensOf(usage),
          });
          // The SDK returned a FULL result usage here (not the partial
          // per-step fold), so price it exactly as the success path does —
          // the miss changes the verdict, not the spend.
          const cost = costField(
            this.pricing,
            { ...modelSpec, model: servedModel ?? modelSpec.model },
            usage,
          );
          // Budget/abort carve-out: a cap or cancellation that leaves the
          // final step on tool-calls is the honest stop reason — the missing
          // object is its consequence, not a driver failure.
          if (mapped === 'budget' || mapped === 'aborted') {
            return {
              ...(servedModel !== undefined ? { model: servedModel } : {}),
              usage,
              ...cost,
              sessionId: record.sessionId,
              denials,
              stopReason: mapped,
            };
          }
          return {
            ...(servedModel !== undefined ? { model: servedModel } : {}),
            usage,
            ...cost,
            sessionId: record.sessionId,
            denials,
            stopReason: 'error',
            error: boundedErrorText(
              `ai-sdk driver: structured output was not produced (final step finishReason '${String(finishReason)}', steps ${result.steps.length}): ${describeError(err)}`,
            ),
          };
        }
      }

      // Assistant turn persisted in OUR vocabulary before the verdict.
      await store.appendMessage(record.sessionId, {
        role: 'assistant',
        content: text !== '' ? text : JSON.stringify(structuredOutput ?? ''),
        at: nowIso(),
      });

      return {
        ...(servedModel !== undefined ? { model: servedModel } : {}),
        ...(structuredOutput !== undefined ? { structuredOutput } : {}),
        usage,
        // PRICING KEY: derived over the OBSERVED served model id — a
        // silently-remapped gateway is priced off the id the response
        // reports (the same fact WorkerResult.model carries); the provider
        // handle stays modelSpec.provider (the price table's key).
        ...costField(this.pricing, { ...modelSpec, model: servedModel ?? modelSpec.model }, usage),
        sessionId: record.sessionId,
        denials,
        stopReason: stopReasonOf({
          finishReason,
          aborted: abortSignal?.aborted === true,
          tokenBudget: budget.maxTokens,
          totalTokens: totalTokensOf(usage),
        }),
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
        abortSignal?.aborted === true || (err instanceof Error && err.name === 'AbortError');
      return {
        usage: stepUsage,
        sessionId: record.sessionId,
        denials,
        stopReason: aborted ? 'aborted' : 'error',
        // The abort branch is the governor's cancellation (I8), not a
        // failure — only a real error carries its cause forward.
        ...(!aborted
          ? { error: boundedErrorText(`ai-sdk driver: run failed — ${describeError(err)}`) }
          : {}),
      };
    }
  }

  // --- Internals -------------------------------------------------------------

  /** Resolve the frozen ModelSpec onto a live provider instance. Throws before dispatch. */
  private resolveModel(modelSpec: ModelSpec): LanguageModel {
    const factory = this.providers[modelSpec.provider];
    if (factory === undefined) {
      throw new Error(
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
      throw new Error(
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

/** Load a sessionRef for resume; unknown sessions throw (a fake resume is worse than a loud error). */
async function loadSessionOrThrow(store: SessionStore, sessionRef: string): Promise<SessionRecord> {
  const record = await store.load(sessionRef);
  if (record === undefined) {
    throw new Error(
      `ai-sdk driver: unknown sessionRef '${sessionRef}' — no recorded session to resume`,
    );
  }
  return record;
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
