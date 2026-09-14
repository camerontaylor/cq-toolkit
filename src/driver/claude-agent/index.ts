// The claude-agent driver — T1.6 (the THIRD driver lane on the FROZEN
// Driver seam: run(opInvocation) → Promise<WorkerResult>). It drives the
// agent-SDK host — `query({ prompt, options })` of the OPTIONAL peer
// dependency `@anthropic-ai/claude-agent-sdk` — as a governed worker, and
// folds the SDK's message stream into our seam vocabulary. This file (with
// ./routing.ts and ./process.js) is the deliberate vendor lane: the SDK is
// loaded lazily by dynamic import at run() time and its types are NEVER
// imported — the module is feature-detected against minimal structural
// types defined here (I10: the frozen seam and the kernel stay
// vendor-neutral; this directory is the sanctioned exception).
//
// EXECUTION MODEL: out-of-process via the SDK host. One query() per run —
// no daemon, no pooling, no retries (attempts are the runner/governor's
// business). Each query spawns a fresh agent worker rooted (cwd) in the
// invocation's OWN workspace.
//
// OPTIONAL PEER + CAPABILITY DETECTION (ADR-0001 decision 2): the SDK is an
// optional peerDependency; the package must BUILD and the whole suite must
// pass with it ABSENT from node_modules (the install-matrix workflow proves
// both halves). The peer is loaded lazily ONCE per driver instance through
// the `sdkLoader` constructor seam (production default: the dynamic import;
// tests inject a plain-object mock — zero vendor types). Absence is a
// PRE-DISPATCH THROW naming the peer and the fix — the same posture as a
// missing API key: fail loudly before any session exists, never a crash
// mid-run. Detection is FEATURE detection, never version sniffing: the
// loaded module must expose exactly the surface this lane drives (query /
// tool / createSdkMcpServer); anything else is a loud error. (The SDK's own
// init frame carries a `capabilities` list for the same reason — "so SDK
// consumers can feature-detect instead of version-sniffing".)
//
// NO MODEL ALLOWLIST (owner override 2026-09-14): ANY model id is routed
// UNCHECKED — it rides `Options.model` verbatim; there is deliberately no
// routeFor-style throw on model names. Routing is by PROVIDER only: the
// endpoint table (./routing.ts, the subprocess lane's concept narrowed)
// resolves base URL + auth env NAME for the provider handle; unknown
// provider throws pre-dispatch. THE SILENT-REMAP DEFENCE IS THE
// OBSERVED-MODEL CHECK (conformance leg m): an anthropic-compat gateway
// will silently serve its default model for an unknown name, so the driver
// surfaces the model id the agent REPORTS AS SERVED (the init frame's
// `model`, overwritten by every assistant frame's response-carried
// `message.model` — the observed, never the requested id) into
// `WorkerResult.model`. A lane that cannot observe the served id omits the
// field — and leg m FAILS it: hiding the fact is the one dishonesty the
// suite exists to catch.
//
// TOOL POLICY → SDK MAPPING (the governed surface, exact):
//   - `tools: []` ALWAYS — every BUILT-IN agent tool is disabled. The only
//     tool surface this lane ever offers is the harness surface
//     (buildTools(config, workspace, sandbox level): read/edit/run), so the
//     frozen policy is the WHOLE truth about what can execute.
//   - The selected harness tools ride the SDK's in-process custom-tool path
//     (`createSdkMcpServer` + `tool(name, description, inputSchema,
//     handler)` — the harness zod object schema's raw `.shape` is the
//     declared input schema), registered under one server name
//     ('cq-harness'); `allowedTools` receives their addressable spellings
//     `mcp__cq-harness__<name>` — ALWAYS emitted, empty when nothing is
//     pre-approved (the subprocess lane's always-present --allowedTools).
//   - policy mode 'allowlist' (the default reading) → harness ∩ policy.allow;
//     'unrestricted' → the whole harness surface; 'none' → no server at all
//     + empty allowedTools (nothing pre-approved, nothing registered).
//   - `permissionMode: 'default'` ALWAYS (mode is NOT the policy lever):
//     headless with no prompt surface, an un-pre-approved tool is
//     auto-DENIED — never prompted, never hung — and those SDK-side denials
//     land in the result's `permission_denials`, which map into
//     WorkerResult.denials (frozen {tool, reason} shape, harness-name
//     stripped, deduped per tool_use id). Widening the mode would silently
//     exceed the frozen policy; narrowing is redundant with the surface.
//   - Every HARNESS denial (sandbox, allowlist miss, path escape, …) is
//     BOTH returned to the model as the tool's isError output text (the
//     model can adapt) AND accumulated verbatim ({ tool, reason }) into
//     WorkerResult.denials — observed at the execute boundary, in OUR
//     vocabulary.
//
// SANDBOX MAPPING (honest): sandboxPolicy 'none' → no sandbox option
// (nothing requested); 'workspace-write' | 'read-only' → `sandbox: {
// enabled: true, failIfUnavailable: false }` — the agent's OS-level command
// sandbox as DEFENSE-IN-DEPTH only. The ENFORCEMENT layer stays the harness
// tools (workspace containment + allowlists + the read-only denial
// reasons); `failIfUnavailable: false` because a platform without sandbox
// support must degrade to the documented harness enforcement, never fail
// the run on a missing kernel feature we do not rely on.
//
// STRUCTURED OUTPUT: the SDK's NATIVE path — `outputFormat: { type:
// 'json_schema', schema }` (zod → JSON Schema at CONSTRUCTION: an
// unrepresentable schema is a loud config error before any run). The
// success result's `structured_output` is validated against the ORIGINAL
// zod schema post-settle — the agent is a vendor boundary, and a payload
// that fails is dropped to narration, never trusted (the subprocess lane's
// identical rule). The frozen OpInvocation cannot carry a schema, so per-op
// schema registries stay a later-lane concern; callers configure the driver
// instance per op family until that lane lands.
//
// I6 ISOLATION via the harness session store (src/harness/session.ts) —
// EXACTLY the other two lanes:
//   - NO sessionRef → `tempWorkspace()` + `SessionStore.create()` — fresh
//     record + a workspace nothing has ever touched.
//   - sessionRef → `SessionStore.load(sessionRef)`; the record's workspace
//     AND message history continue. Unknown sessionRef → PRE-DISPATCH
//     throw (a fake resume is worse than a loud one).
//   - The agent's OWN conversation continues via the workspace sidecar
//     `.cq-cli-session` (CLI_SESSION_FILE): the session id the agent
//     reports (every frame carries `session_id`) is persisted post-settle
//     and passed as `Options.resume` on the next run over the same
//     sessionRef. A workspace without a sidecar (prior run died before the
//     agent reported) resumes the WORKSPACE only — an honest partial
//     continuation. A sidecar, not a record message: role 'tool' in a
//     session record means A TOOL RAN, so the handle must not masquerade
//     as one.
//   - Persisted in OUR vocabulary: the user prompt (pre-run); ONE role
//     'tool' message per IN-POLICY harness tool execution ({ input, ok,
//     output } plain JSON) at the execute boundary; the assistant
//     transcript text (when any); narration (unknown frame shapes —
//     evidence, never a crash) under toolName 'agent-narration'. Persist
//     errors after dispatch are swallowed: the honest verdict outranks the
//     record.
//
// I8 SEAM — the driver owns NO wall clock. The governed context arrives
// via `currentJobContext()` (the one driver→kernel import, same as the
// other two lanes) and is forwarded EXACTLY ONE place: the SDK query's
// cancellation root (Options.abortController), wired by ./process.ts (the
// hygiene scan's exempt file — construction of the root is machinery; the
// WHEN stays the governor's). An already-fired signal never dispatches.
// Consequences, documented:
//   - Budget.wallClockMs is IGNORED — the governor's ladder owns wall
//     clock. Whether an aborted query stops endpoint spend mid-flight is
//     UNMEASURED (the slice-3 spike's question; noted in process.ts).
//   - Budget.maxTokens has NO native SDK stop: the SDK's caps are turns
//     (Options.maxTurns), USD (Options.maxBudgetUsd), and an alpha
//     task-budget that PACES the model rather than stopping it — none is a
//     token stop. So maxTokens is enforced the subprocess lane's way:
//     POST-HOC VERDICT CLASSIFICATION over the folded result usage — it
//     classifies a finished run 'budget' but cannot stop one early
//     (stopping early on tokens is the governor's/admission's business).
//     THIS lane's answer to "which mechanism": post-hoc, by SDK-surface
//     fact, not by choice.
//   - Budget.maxAttempts is the runner/governor's; maxUsd is caller-side
//     derived accounting. Exactly ONE query per run.
//
// USAGE MAPPING (exact agent-sdk@0.3.270 result vocabulary → frozen Usage):
//   usage.input_tokens → input, usage.output_tokens → output,
//   usage.cache_read_input_tokens → cacheRead,
//   usage.cache_creation_input_tokens → cacheWrite (missing numerics → 0;
//   an unshaped usage is NO measurement). reasoning is OMITTED on this
//   lane: the SDK reports thinkingTokens as ALREADY INSIDE outputTokens
//   ("Thinking tokens, already counted inside outputTokens"), so lifting
//   them into a separate field would double-count every total — the
//   kernel's Budget.maxTokens classification sums all frozen Usage fields,
//   and a run whose real total was below the cap would misclassify
//   'budget'. The frozen reasoning field stays OPTIONAL precisely for
//   lanes whose SDK reports reasoning ADDITIVE to output; this lane has
//   none. The result's usage is the main-loop count ("prefer modelUsage
//   for token/cost accounting" — but modelUsage keys are per-model
//   aggregates keyed by id; the frozen Usage is one flat fold, so the
//   main-loop usage is what folds; its thinkingTokens subset is left
//   inside output where the SDK put it). Assistant frames carry
//   per-message usage: folded as the FALLBACK when no result event
//   arrived. Σ(frozen Usage) is the number Budget.maxTokens is checked
//   against — the TRUE total, never output-plus-thinking.
//
// STOP REASON (frozen DriverStopReason) — mapping table, checked in order:
//   1. governed signal fired (or the query threw an abort-shaped error) →
//      'aborted'
//   2. folded usage ≥ Budget.maxTokens → 'budget'
//   3. result event present: subtype 'success' with is_error ≠ true →
//      'complete'; error subtypes error_max_turns / error_max_budget_usd
//      (the SDK's own caps — a stop on a cap is a budget stop, frozen
//      DriverStopReason) → 'budget'; any other result status (including
//      success-with-is_error) → 'error'
//   4. no result event (the query threw non-abort, or died silently) →
//      'error'
// Once dispatched, run() NEVER throws: every failure lands in an honest
// verdict carrying the sessionId + denials gathered so far. Only
// PRE-DISPATCH validation throws (peer absent/misshaped, unknown provider,
// missing key env, unknown sessionRef, a non-positive Budget.maxTokens;
// the outputSchema conversion throws at construction).
//
// COST (DD-2, derived-only): costUSD via the `pricing` constructor lookup
// (default: computeCostUSD over the vendored models.dev table) — present
// only on a verdict carrying a REAL usage measurement (a result event, or
// the assistant-usage fallback), and only when the price map knows the
// model. The model PRICED is the one actually SERVED when the agent
// reported a served id (the remap evidence is real — pricing the requested
// id would attribute the wrong rates); ModelSpec.model is the fallback when
// nothing was observed. An UNMEASURED error/abort verdict reports NO
// costUSD: 0 would be a fabricated fact. A present costUSD is labeled
// `costBasis: 'modeled'` — the api-equivalent list-price figure for the
// tokens consumed, never a claim of billed spend (DD-9;
// docs/dd-9-api-equivalent-budget.md). The driver never fabricates or
// reports trusted USD — the SDK's own total_cost_usd is deliberately NOT
// surfaced: a vendor-side cost estimate would bypass the derived-only rule.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { currentJobContext } from '../../kernel/governor.js';
import { defaultHarnessConfig } from '../../harness/config.js';
import type { HarnessConfig } from '../../harness/config.js';
import { buildTools } from '../../harness/tools.js';
import type { ToolkitTool } from '../../harness/tools.js';
import { SessionStore, tempWorkspace } from '../../harness/session.js';
import type { SessionMessage, SessionRecord } from '../../harness/session.js';
import { computeCostUSD } from '../pricing/index.js';
import type { PerMillionRates } from '../pricing/index.js';
import type { Driver, ModelSpec, OpInvocation, SandboxLevel, ToolDenial, ToolPolicy, Usage, WorkerResult } from '../types.js';
import { defaultEndpointTable, resolveEndpoint } from './routing.js';
import type { EndpointTable, ResolvedEndpoint } from './routing.js';
import { abortRootFollowing } from './process.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** The optional peer this lane loads lazily — never statically imported. */
export const SDK_MODULE_SPECIFIER = '@anthropic-ai/claude-agent-sdk';

/** SDK MCP server name under which the harness tool surface is registered. */
export const MCP_SERVER_NAME = 'cq-harness';

/**
 * Workspace sidecar file carrying the agent's own session id — the
 * `Options.resume` handle for the NEXT run on the SAME sessionRef. A
 * sidecar, not a record message: role 'tool' in a session record means a
 * tool ran (header), so the handle lives in the workspace it resumes.
 */
export const AGENT_SESSION_FILE = '.cq-cli-session';

/** Session-message toolName under which unknown-frame narration is recorded. */
export const NARRATION_TOOL = 'agent-narration';

/**
 * One MCP tool-call result (the subset of the SDK's CallToolResult this
 * lane produces): the denial/success text the model sees, plus the error
 * marker that makes a harness denial legible to the agent as a refusal.
 */
export interface SdkToolCallResult {
  content?: ReadonlyArray<{ type?: unknown; text?: unknown }>;
  isError?: unknown;
}

/**
 * The MINIMAL structural surface this lane drives on the loaded SDK module
 * (feature-detected at load, header). Deliberately plain — zero vendor
 * types; the mock the conformance suite injects satisfies it with plain
 * objects.
 */
export interface AgentSdkModule {
  /** `query({ prompt, options })` → the message stream (an async iterable). */
  query(params: { prompt: string; options?: Record<string, unknown> }): AsyncIterable<unknown>;
  /**
   * `tool(name, description, inputSchema, handler)` — one custom-tool
   * definition; the handler executes IN OUR PROCESS (the harness tool).
   */
  tool(
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (args: unknown, extra: unknown) => Promise<SdkToolCallResult>,
  ): unknown;
  /** `createSdkMcpServer({ name, tools })` — the in-process server config. */
  createSdkMcpServer(options: { name: string; version?: string; tools?: unknown[] }): unknown;
}

/** The loader seam: production default = the dynamic import; tests inject a mock module. */
export type SdkLoader = () => Promise<unknown>;

/** Constructor options — everything optional; defaults are production-real. */
export interface ClaudeAgentDriverOptions {
  /**
   * SDK module loader override. Default: the lazy dynamic import of
   * `SDK_MODULE_SPECIFIER` (throws pre-dispatch when the optional peer is
   * absent). Tests inject `() => mockModule` — plain objects, zero vendor
   * types, never the network or the real CLI.
   */
  sdkLoader?: SdkLoader;
  /**
   * Endpoint table override (default: defaultEndpointTable — zai /
   * deepseek / anthropic, as-of 2026-09 provider docs). PROVIDER-only
   * routing: base URL + auth env NAME; the model id rides through
   * UNCHECKED (header).
   */
  endpointTable?: EndpointTable;
  /**
   * Structured-output schema (data-driven). When set, the SDK's native
   * `outputFormat: { type: 'json_schema' }` path runs and the result's
   * `structured_output` is validated against THIS schema before it lands
   * in WorkerResult.structuredOutput (a payload that fails is dropped to
   * narration, never trusted). Per-op schema registries are a later-lane
   * concern (the frozen OpInvocation cannot carry a schema).
   */
  outputSchema?: ZodType;
  /** Harness config (tool surface + prompt budget). Default: defaultHarnessConfig. */
  harnessConfig?: HarnessConfig;
  /** Sessions directory for the backing SessionStore. Default: <os.tmpdir()/cq-harness>/sessions. */
  sessionsDir?: string;
  /**
   * Price-lookup override for the derived-only costUSD rule (default:
   * `computeCostUSD` over the vendored models.dev table via `priceOf`).
   * Tests and per-deployment price tables inject here; a lookup returning
   * undefined keeps costUSD absent.
   */
  pricing?: (modelSpec: ModelSpec) => PerMillionRates | undefined;
}

/**
 * The claude-agent driver on the frozen Driver seam. One instance caches
 * ONLY the loaded SDK module (lazily, once); all per-run state (session
 * record, observation, denials) lives in the run call — a single instance
 * can serve many isolated invocations.
 */
export class ClaudeAgentDriver implements Driver {
  private readonly sdkLoader: SdkLoader;
  private readonly endpointTable: EndpointTable;
  private readonly outputSchema: ZodType | undefined;
  private readonly outputJsonSchema: string | undefined;
  private readonly harnessConfig: HarnessConfig;
  private readonly sessionsDir: string | undefined;
  private readonly pricingOverride: ((modelSpec: ModelSpec) => PerMillionRates | undefined) | undefined;
  /** Memoized load — one feature-detect per driver instance, never per run. */
  private sdkModule: Promise<AgentSdkModule> | undefined;

  constructor(options: ClaudeAgentDriverOptions = {}) {
    this.sdkLoader = options.sdkLoader ?? defaultSdkLoader;
    this.endpointTable = options.endpointTable ?? defaultEndpointTable();
    // zod→JSON Schema at CONSTRUCTION: an unrepresentable schema is a loud
    // config error before any run, not a mid-dispatch surprise. The original
    // zod schema is retained alongside the serialized form — the agent's
    // structured_output is validated against it post-settle (below).
    this.outputSchema = options.outputSchema;
    this.outputJsonSchema =
      options.outputSchema === undefined ? undefined : JSON.stringify(zToJsonSchema(options.outputSchema));
    this.harnessConfig = options.harnessConfig ?? defaultHarnessConfig;
    this.sessionsDir = options.sessionsDir;
    this.pricingOverride = options.pricing;
  }

  /** The frozen seam: run one invocation to completion. */
  async run(opInvocation: OpInvocation): Promise<WorkerResult> {
    const { prompt, modelSpec, toolPolicy, sandboxPolicy, sessionRef, budget } = opInvocation;

    // --- Pre-dispatch validation: everything here throws BEFORE the agent
    // is contacted and BEFORE any session/workspace exists (fail loudly, no
    // partial state). Provider first (pure), then the peer, then budget.
    const endpoint = resolveEndpoint(modelSpec, this.endpointTable); // unknown provider → the throw
    const keyValue = readKeyEnvOrThrow(endpoint); // missing key env → throw
    const sdk = await this.loadSdk(); // peer absent / misshaped → throw
    if (budget.maxTokens !== undefined && (!Number.isFinite(budget.maxTokens) || budget.maxTokens <= 0)) {
      throw new Error(
        `claude-agent driver: budget.maxTokens must be a finite number > 0, got ${String(budget.maxTokens)}`,
      );
    }

    // --- I6 isolation: fresh record + fresh workspace, or a real resume. --
    const store = new SessionStore(this.sessionsDir ?? defaultSessionsDir());
    const record =
      sessionRef === undefined
        ? await store.create(await tempWorkspace(this.harnessConfig.workspaceRoot))
        : await loadSessionOrThrow(store, sessionRef);
    const workspace = record.workspace;

    await store.appendMessage(record.sessionId, { role: 'user', content: prompt, at: nowIso() });

    // --- Tool surface: the harness surface ∩ per-op ToolPolicy, registered
    // as the SDK's in-process custom tools; built-ins are disabled
    // wholesale (the governed surface is the WHOLE surface, header).
    const harnessTools = buildTools(this.harnessConfig, workspace, sandboxPolicy.level);
    const allowed = allowedToolNames(harnessTools.map((t) => t.name), toolPolicy);
    const selected = harnessTools.filter((t) => allowed.includes(t.name));

    // --- Agent-level resume: the agent session id recorded in the -------
    // workspace sidecar by a prior run (absent → workspace-only continuation).
    const resumeAgentSessionId = await readAgentSessionId(workspace);

    // --- Governed cancellation (I8): checked before the dispatch (an
    // already-cancelled invocation never dispatches), then wired to the
    // SDK's cancellation root — the driver decides nothing about WHEN.
    const governed = currentJobContext();
    const signal = governed?.signal;
    if (signal?.aborted === true) {
      return { usage: zeroUsage(), sessionId: record.sessionId, denials: [], stopReason: 'aborted' };
    }

    // The per-run observation — created before the options assembly because
    // the harness-tool closures accumulate denials into it directly.
    const observation = newObservation();

    // --- The one SDK call: options assembly. ------------------------------
    const sandbox = sandboxOption(sandboxPolicy.level);
    const sdkTools = selected.map((harnessTool) =>
      sdk.tool(
        harnessTool.name,
        harnessTool.description,
        harnessTool.inputSchema.shape, // the zod raw shape — the SDK's declared-input form
        (args: unknown): Promise<SdkToolCallResult> =>
          runHarnessTool(harnessTool, args, store, record, observation.denials),
      ),
    );
    const options: Record<string, unknown> = {
      // The model rides UNCHECKED (owner override 2026-09-14, header): any
      // id the endpoint can reach is permitted; the OBSERVED id is the
      // defence (WorkerResult.model).
      model: modelSpec.model,
      cwd: workspace,
      // Built-ins OFF — the only tools the agent can touch are the ones the
      // frozen policy pre-approved below (header's governed-surface rule).
      tools: [],
      allowedTools: allowed.map(qualifiedToolName),
      // Headless posture: un-pre-approved tools are auto-DENIED, never
      // prompted; the denials map into WorkerResult.denials post-settle.
      permissionMode: 'default',
      // Endpoint injection: the SDK's env REPLACES the child environment,
      // so the host environment rides along and the endpoint plan is laid
      // over it (base URL + both auth spellings, values from the host env
      // read AT RUN TIME — the one place a secret value is ever touched).
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: endpoint.baseUrl,
        ANTHROPIC_AUTH_TOKEN: keyValue,
        ANTHROPIC_API_KEY: keyValue,
      },
      systemPrompt: systemPreamble(this.harnessConfig.promptBudget.maxSystemPromptChars),
      ...(selected.length > 0
        ? { mcpServers: { [MCP_SERVER_NAME]: sdk.createSdkMcpServer({ name: MCP_SERVER_NAME, tools: sdkTools }) } }
        : {}),
      ...(sandbox !== undefined ? { sandbox } : {}),
      ...(resumeAgentSessionId !== undefined ? { resume: resumeAgentSessionId } : {}),
      ...(this.outputJsonSchema !== undefined
        ? { outputFormat: { type: 'json_schema', schema: JSON.parse(this.outputJsonSchema) as unknown } }
        : {}),
    };
    const abortRoot = abortRootFollowing(signal); // ./process.ts — the wiring only
    if (abortRoot !== undefined) {
      options['abortController'] = abortRoot.controller;
    }

    // --- Dispatch. From here on, run() NEVER throws past the seam. --------
    let aborted = false;
    try {
      for await (const message of sdk.query({ prompt, options })) {
        foldMessage(observation, message);
      }
    } catch (err) {
      // An abort-shaped failure is the governor's cancellation, not an
      // error (I8); anything else is an honest error verdict. The abort
      // verdict reads the LIVE state of the wired root (the governed
      // signal may fire mid-iteration — flow analysis of the pre-dispatch
      // check cannot see that).
      aborted = abortRoot?.controller.signal.aborted === true || isAbortShaped(err);
    }
    // Mapping-table alignment (governed signal fired → 'aborted'): the
    // exception path above is not the ONLY way an abort manifests — the SDK
    // can settle the for-await loop CLEANLY on abort, and the signal can
    // fire after normal exit but before the verdict. Fold the LIVE state of
    // the wired root here (reading `signal` would be a flow-narrowed
    // always-false compare), and only THEN dispose: an abort landing in the
    // post-settle window must still reach the verdict — disposing first
    // would sever governed-cancellation propagation before the verdict
    // state is captured.
    aborted = aborted || abortRoot?.controller.signal.aborted === true;
    abortRoot?.dispose();

    // --- SDK-side permission denials → frozen shape (post-settle, deduped
    // per tool_use id). These are tools the agent's permission gate refused
    // (outside allowedTools — the withheld surface); harness denials from
    // EXECUTED tools were accumulated at the execute boundary.
    mapPermissionDenials(observation);

    // --- Structured_output is the one vendor field that becomes seam data,
    // so when a schema was configured it must survive that schema before it
    // can reach a verdict — a payload that fails is dropped and its
    // rejection recorded as narration, never trusted.
    let structured: unknown;
    const rawStructured = observation.result?.['structured_output'];
    if (this.outputSchema !== undefined && observation.result !== undefined && rawStructured !== undefined) {
      const check = this.outputSchema.safeParse(rawStructured);
      if (check.success) {
        structured = check.data;
      } else {
        observation.narration.push(
          JSON.stringify({
            cq: 'structured-output-rejected',
            issues: check.error.issues.length,
            paths: check.error.issues.map((issue) => issue.path.map(String).join('.')),
          }),
        );
      }
    }

    // --- Session persistence (post-settle, OUR vocabulary). A store error
    // here is swallowed: once dispatched, the verdict must reach the caller
    // — persistence is evidence hygiene, not the seam contract.
    try {
      await persistObservation(store, record, observation, resumeAgentSessionId);
    } catch {
      // deliberately swallowed — the honest verdict outranks the record
    }

    return this.verdict(modelSpec, budget, observation, record.sessionId, aborted, structured);
  }

  // --- Internals -------------------------------------------------------------

  /**
   * Load + feature-detect the SDK module ONCE per instance. Absent peer →
   * a clear pre-dispatch throw naming the peer (the missing-API-key
   * posture); a module missing the driven surface → a loud capability
   * error (feature detection, never version sniffing — header).
   */
  private loadSdk(): Promise<AgentSdkModule> {
    this.sdkModule ??= (async (): Promise<AgentSdkModule> => {
      let loaded: unknown;
      try {
        loaded = await this.sdkLoader();
      } catch (err) {
        throw new Error(
          `claude-agent driver: the optional peer dependency '${SDK_MODULE_SPECIFIER}' is not installed — ` +
            'install it to use this lane (npm install --save-optional @anthropic-ai/claude-agent-sdk; ' +
            'see src/driver/README.md). Refusing pre-dispatch, before any session exists.',
          { cause: err },
        );
      }
      return asAgentSdkModule(loaded);
    })();
    return this.sdkModule;
  }

  /**
   * Fold the observation into the frozen WorkerResult (header tables:
   * stop reasons, usage, cost). A real measurement (result usage, else the
   * assistant-usage fallback) is kept on any verdict that observed it;
   * unmeasured verdicts (dispatch failure, abort before any frame) report
   * zeros and NEVER a cost.
   */
  private verdict(
    modelSpec: ModelSpec,
    budget: OpInvocation['budget'],
    observation: RunObservation,
    sessionId: string,
    aborted: boolean,
    structured: unknown,
  ): WorkerResult {
    const measured = observation.result !== undefined ? usageFromAgent(observation.result['usage']) : undefined;
    const usage = measured ?? observation.assistantUsage ?? zeroUsage();
    const stopReason = stopReasonOf({
      aborted,
      maxTokens: budget.maxTokens,
      usage,
      resultStatus: resultStatusOf(observation.result),
    });
    // Derived-only cost (DD-2): only on a verdict carrying a REAL usage
    // measurement — never on an unmeasured abort/dispatch-failure verdict.
    // Price the model that was actually SERVED when one was observed (the
    // remap evidence is real — an anthropic-compat gateway can serve a
    // different id than ModelSpec.model asked for, and pricing the
    // requested id would attribute the wrong rates); the requested
    // ModelSpec.model is the fallback when nothing was observed.
    const pricedModel: ModelSpec =
      observation.servedModel !== undefined
        ? { ...modelSpec, model: observation.servedModel }
        : modelSpec;
    const cost =
      measured === undefined && observation.assistantUsage === undefined
        ? {}
        : costField(this.costUSDOf.bind(this), pricedModel, usage);
    return {
      // The observed served model: what the agent reported it served, not
      // what ModelSpec.model requested (the remap-detection fact, header).
      ...(observation.servedModel !== undefined ? { model: observation.servedModel } : {}),
      ...(structured !== undefined ? { structuredOutput: structured } : {}),
      usage,
      ...cost,
      sessionId,
      denials: observation.denials,
      stopReason,
    };
  }

  /** Derived-only cost: computeCostUSD by default; the same fold over an injected price lookup. */
  private costUSDOf(modelSpec: ModelSpec, usage: Usage): number | undefined {
    if (this.pricingOverride === undefined) {
      return computeCostUSD(modelSpec, usage);
    }
    const rates = this.pricingOverride(modelSpec);
    if (rates === undefined) {
      return undefined; // unknown model — never fabricate
    }
    const perMillion = (tokens: number, rate: number | undefined): number =>
      rate === undefined ? 0 : (tokens / 1_000_000) * rate;
    return (
      perMillion(usage.input, rates.input) +
      perMillion(usage.output, rates.output) +
      perMillion(usage.cacheRead, rates.cacheRead) +
      perMillion(usage.cacheWrite, rates.cacheWrite)
    );
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers — pure, exported only where the tests need them
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp for session messages. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Default sessions dir (sibling of the harness temp-workspace root). */
function defaultSessionsDir(): string {
  return join(tmpdir(), 'cq-harness', 'sessions');
}

/**
 * Production loader: the lazy dynamic import of the optional peer. The
 * specifier rides a constant handed to import() — the SDK is resolved at
 * RUN time only, so the package (and this repo's build and test suite)
 * never require it to exist.
 */
async function defaultSdkLoader(): Promise<unknown> {
  return import(SDK_MODULE_SPECIFIER);
}

/**
 * Feature detection (ADR-0001 decision 2): the loaded module must expose
 * exactly the surface this lane drives. NEVER a version check — a module
 * with the same functions is accepted whatever it calls its version.
 */
function asAgentSdkModule(loaded: unknown): AgentSdkModule {
  const rec = asRecord(loaded);
  if (rec === undefined) {
    throw new Error(
      `claude-agent driver: the loaded '${SDK_MODULE_SPECIFIER}' module is not an object — ` +
        'not the agent SDK surface this lane drives',
    );
  }
  const missing = ['query', 'tool', 'createSdkMcpServer'].filter(
    (name) => typeof rec[name] !== 'function',
  );
  if (missing.length > 0) {
    throw new Error(
      `claude-agent driver: the loaded '${SDK_MODULE_SPECIFIER}' module is missing the driven surface ` +
        `(${missing.join(', ')}) — capability detection is feature-based, never version-based`,
    );
  }
  return rec as unknown as AgentSdkModule;
}

/** The resolved endpoint's key VALUE, read from the host env AT RUN TIME. */
function readKeyEnvOrThrow(endpoint: ResolvedEndpoint): string {
  const value = process.env[endpoint.keyEnv];
  if (value === undefined || value === '') {
    throw new Error(
      `claude-agent driver: endpoint '${endpoint.endpoint}' requires ${endpoint.keyEnv} in the environment`,
    );
  }
  return value;
}

/** Load a sessionRef for resume; unknown sessions throw (a fake resume is worse than a loud error). */
async function loadSessionOrThrow(store: SessionStore, sessionRef: string): Promise<SessionRecord> {
  const record = await store.load(sessionRef);
  if (record === undefined) {
    throw new Error(`claude-agent driver: unknown sessionRef '${sessionRef}' — no recorded session to resume`);
  }
  return record;
}

/**
 * Frozen ToolPolicy → the allowed tool-name subset: 'none' → nothing;
 * 'unrestricted' → the whole harness surface; 'allowlist' (the default
 * reading when mode is omitted) → harness names in `allow` only.
 */
export function allowedToolNames(harnessToolNames: readonly string[], policy: ToolPolicy): string[] {
  const mode = policy.mode ?? 'allowlist';
  if (mode === 'none') return [];
  if (mode === 'unrestricted') return [...harnessToolNames];
  const allowed = new Set(policy.allow);
  return harnessToolNames.filter((name) => allowed.has(name));
}

/** The addressable spelling of a registered harness tool (the MCP prefix). */
function qualifiedToolName(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

/** A permission-denial tool name → the harness name (prefix stripped; vendor names verbatim). */
function harnessToolName(deniedName: string): string {
  const prefix = `mcp__${MCP_SERVER_NAME}__`;
  return deniedName.startsWith(prefix) ? deniedName.slice(prefix.length) : deniedName;
}

/** SandboxPolicy → the SDK sandbox option (undefined = nothing requested). */
export function sandboxOption(level: SandboxLevel): Record<string, unknown> | undefined {
  if (level === 'none') return undefined;
  // Defense-in-depth only (header): the harness tools are the enforcement;
  // degrade on platforms without the sandbox instead of failing the run.
  return { enabled: true, failIfUnavailable: false };
}

/** The harness preamble, truncated to the prompt budget (ours truncates; caller data never). */
function systemPreamble(maxChars: number): string {
  const preamble =
    'You are a cq-toolkit worker executing one task. ' +
    'Work inside the provided workspace directory; use the available tools to read, edit, and run. ' +
    'Tool refusals arrive as denial text — adapt instead of retrying the same call.';
  return preamble.length <= maxChars ? preamble : preamble.slice(0, Math.max(0, maxChars));
}

/**
 * Execute one harness tool inside the SDK's tool loop (the MCP handler):
 * persist the outcome as a session message (our vocabulary), surface
 * denials to the model as the tool's isError output text AND accumulate
 * them verbatim for WorkerResult.denials. Persist errors are swallowed:
 * the verdict outranks the record (post-dispatch posture).
 */
async function runHarnessTool(
  harnessTool: ToolkitTool,
  input: unknown,
  store: SessionStore,
  record: SessionRecord,
  denials: ToolDenial[],
): Promise<SdkToolCallResult> {
  const result = await harnessTool.execute(input);
  try {
    await store.appendMessage(record.sessionId, {
      role: 'tool',
      toolName: harnessTool.name,
      content: JSON.stringify({ input: input ?? null, ok: result.ok, output: result.ok ? result.output : result.denial.reason }),
      at: nowIso(),
    });
  } catch {
    // deliberately swallowed — the honest verdict outranks the record
  }
  if (result.ok) {
    return { content: [{ type: 'text', text: result.output }] };
  }
  denials.push(result.denial);
  return { content: [{ type: 'text', text: result.denial.reason }], isError: true };
}

/** Unmeasured usage: the honest zero (it means "not measured", never "nothing spent"). */
function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

// ---------------------------------------------------------------------------
// Message-stream observation — defensive folding of the SDK stream
// ---------------------------------------------------------------------------

/** Per-run observation state folded from the query's message stream. */
interface RunObservation {
  /** The agent's own session id (init/assistant/result frames) — the sidecar's resume handle. */
  agentSessionId: string | undefined;
  /** The model id the agent reports as served (init `model`, overwritten per assistant frame). */
  servedModel: string | undefined;
  /** Assistant text blocks, in arrival order (the transcript). */
  transcript: string[];
  /** Unknown frame shapes — evidence, never a crash. */
  narration: string[];
  /** Usage folded from assistant frames — the fallback when no result usage. */
  assistantUsage: Usage | undefined;
  /** The terminal result event, when it arrived (defensively read at use sites). */
  result: Record<string, unknown> | undefined;
  /** tool_use ids already denied via permission_denials (dedupe). */
  deniedToolUseIds: Set<string>;
  /** The frozen denials, in denial order (execute-boundary + permission-gate). */
  denials: ToolDenial[];
}

function newObservation(): RunObservation {
  return {
    agentSessionId: undefined,
    servedModel: undefined,
    transcript: [],
    narration: [],
    assistantUsage: undefined,
    result: undefined,
    deniedToolUseIds: new Set(),
    denials: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * The agent usage vocabulary → frozen Usage (missing numeric fields map to
 * 0; an unshaped usage is NO measurement). `reasoning` is deliberately NOT
 * set: the SDK's thinkingTokens are ALREADY INCLUDED inside output_tokens,
 * so a separate field would double-count every total that sums the frozen
 * Usage fields (Budget.maxTokens classification) — the frozen field stays
 * optional precisely for lanes whose reasoning is additive (header).
 */
export function usageFromAgent(raw: unknown): Usage | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;
  return {
    input: asNumber(rec['input_tokens']) ?? 0,
    output: asNumber(rec['output_tokens']) ?? 0,
    cacheRead: asNumber(rec['cache_read_input_tokens']) ?? 0,
    cacheWrite: asNumber(rec['cache_creation_input_tokens']) ?? 0,
  };
}

/** Fold one usage observation into an accumulator. */
function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (a === undefined) return b;
  // No reasoning term: on this lane usageFromAgent never produces one
  // (thinking tokens are a subset of output — never double-count).
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/**
 * Fold ONE stream frame into the observation (header mapping table). An
 * unshapeable frame or an unknown type becomes narration — the stream's
 * junk is evidence, never a crash.
 */
export function foldMessage(observation: RunObservation, message: unknown): void {
  const event = asRecord(message);
  if (event === undefined) {
    observation.narration.push(JSON.stringify(message) ?? String(message));
    return;
  }
  switch (event['type']) {
    case 'system': {
      if (event['subtype'] === 'init') {
        observation.agentSessionId = asString(event['session_id']) ?? observation.agentSessionId;
        observation.servedModel = asString(event['model']) ?? observation.servedModel;
        return;
      }
      observation.narration.push(JSON.stringify(event)); // known type, unhandled subtype — evidence
      return;
    }
    case 'assistant': {
      const inner = asRecord(event['message']);
      if (inner === undefined) {
        observation.narration.push(JSON.stringify(event));
        return;
      }
      observation.agentSessionId = asString(event['session_id']) ?? observation.agentSessionId;
      // The response-carried model id (the assistant frame's message is
      // shaped like an Anthropic Messages API Message, whose `model` field
      // is what the endpoint REPORTS it served) — the observed, never the
      // requested id; the latest response wins.
      observation.servedModel = asString(inner['model']) ?? observation.servedModel;
      const usage = usageFromAgent(inner['usage']);
      if (usage !== undefined) {
        observation.assistantUsage = addUsage(observation.assistantUsage, usage);
      }
      for (const block of asArray(inner['content']) ?? []) {
        const rec = asRecord(block);
        if (rec === undefined) continue;
        if (rec['type'] === 'text' && typeof rec['text'] === 'string') {
          observation.transcript.push(rec['text']);
        }
        // tool_use blocks need no fold: the harness surface executes
        // in-process (denials observed at the boundary), and SDK-side
        // refusals arrive on the result's permission_denials.
      }
      return;
    }
    case 'user': {
      // SDKUserMessage frames ride this type (the SDKMessage union) — in
      // practice tool-result deliveries after every tool round, whose
      // MessageParam content can also carry ordinary TEXT blocks. Posture:
      //   - tool_result-only content (or empty / unshapeable — the
      //     subprocess lane's drop-if-unshapeable rule) is DROPPED, exactly
      //     like assistant tool_use blocks: the harness surface executes
      //     in-process, so each outcome is already recorded at the execute
      //     boundary in OUR vocabulary, and SDK-side refusals arrive on the
      //     result's permission_denials (the authoritative record). Folding
      //     these to narration would duplicate the tool outcome AND put a
      //     raw vendor frame shape into persisted session data.
      //   - a frame carrying a TEXT block is NARRATED (evidence): the
      //     normal flow never emits one — the prompt rides query()'s
      //     argument and tool results ride tool_result frames — so a
      //     text-bearing user frame is exactly the kind of unusual thing
      //     narration exists to preserve. Never silently dropped.
      const inner = asRecord(event['message']);
      const content = inner === undefined ? undefined : asArray(inner['content']);
      if (content === undefined) return; // unshapeable — dropped (subprocess posture)
      let hasText = false;
      for (const block of content) {
        if (asRecord(block)?.['type'] === 'text') {
          hasText = true;
          break;
        }
      }
      if (hasText) observation.narration.push(JSON.stringify(event));
      return;
    }
    case 'result': {
      observation.result = event;
      observation.agentSessionId = asString(event['session_id']) ?? observation.agentSessionId;
      return;
    }
    default:
      observation.narration.push(JSON.stringify(event));
  }
}

/** The result's permission_denials → frozen denials (deduped per tool_use id). */
function mapPermissionDenials(observation: RunObservation): void {
  for (const denial of asArray(observation.result?.['permission_denials']) ?? []) {
    const rec = asRecord(denial);
    const toolUseId = asString(rec?.['tool_use_id']);
    if (toolUseId !== undefined && observation.deniedToolUseIds.has(toolUseId)) continue;
    if (toolUseId !== undefined) observation.deniedToolUseIds.add(toolUseId);
    const tool = harnessToolName(asString(rec?.['tool_name']) ?? 'unknown');
    observation.denials.push({ tool, reason: `tool use denied by the agent permission gate (${tool})` });
  }
}

/**
 * Post-settle persistence (OUR vocabulary): the agent-session sidecar
 * (when newly observed — the NEXT run's resume handle), the assistant
 * transcript (when any), and narration (when any). Never fabricates an
 * assistant turn: a run that produced no text records none.
 */
async function persistObservation(
  store: SessionStore,
  record: SessionRecord,
  observation: RunObservation,
  resumeAgentSessionId: string | undefined,
): Promise<void> {
  const agentSessionId = observation.agentSessionId;
  if (agentSessionId !== undefined && agentSessionId !== resumeAgentSessionId) {
    // Best-effort: the sidecar is the NEXT run's resume handle; a failed
    // write costs a workspace-only continuation, never this run's verdict.
    try {
      await writeFile(join(record.workspace, AGENT_SESSION_FILE), `${agentSessionId}\n`, 'utf8');
    } catch {
      // deliberately swallowed — resume degrades honestly (no resume option)
    }
  }
  const text = observation.transcript.join('\n\n');
  if (text !== '') {
    await store.appendMessage(record.sessionId, { role: 'assistant', content: text, at: nowIso() });
  }
  if (observation.narration.length > 0) {
    const message: SessionMessage = {
      role: 'tool',
      toolName: NARRATION_TOOL,
      content: JSON.stringify(observation.narration),
      at: nowIso(),
    };
    await store.appendMessage(record.sessionId, message);
  }
}

/**
 * The agent session id recorded in a prior run's workspace sidecar, if any —
 * the resume handle of THIS run. Missing/unreadable → undefined (an honest
 * workspace-only continuation, never a fabricated resume).
 */
async function readAgentSessionId(workspace: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(workspace, AGENT_SESSION_FILE), 'utf8');
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined; // no sidecar — nothing to resume agent-side
  }
}

/** zod → JSON Schema (the structured-output option's schema form). */
function zToJsonSchema(schema: ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema);
}

/** The terminal result event's status class for the stop-reason table. */
export type ResultStatus = 'success' | 'cap' | 'error' | 'none';

/**
 * 'success' iff the result event says so (subtype 'success' AND is_error
 * ≠ true); the SDK's own cap subtypes (error_max_turns /
 * error_max_budget_usd — which carry is_error: true) are checked FIRST and
 * classify as 'cap', a stop ON A CAP is a budget stop; anything else (or
 * no event) is 'error'/'none'.
 */
export function resultStatusOf(result: Record<string, unknown> | undefined): ResultStatus {
  if (result === undefined) return 'none';
  const subtype = asString(result['subtype']);
  if (subtype === 'error_max_turns' || subtype === 'error_max_budget_usd') return 'cap';
  if (result['is_error'] === true) return 'error';
  return subtype === 'success' ? 'success' : 'error';
}

/** Σ of the frozen Usage fields — the fold Budget.maxTokens is checked against. */
function totalTokensOf(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite + (usage.reasoning ?? 0);
}

/**
 * Derived-only cost field (DD-2): present only when the price lookup knows
 * the model. A present costUSD is labeled `costBasis: 'modeled'` — the
 * api-equivalent list-price figure for the tokens consumed, never a claim of
 * billed spend; an unpriced model gets neither field (never fabricate).
 */
function costField(
  costUSDOf: (modelSpec: ModelSpec, usage: Usage) => number | undefined,
  modelSpec: ModelSpec,
  usage: Usage,
): { costUSD?: number; costBasis?: 'modeled' } {
  const costUSD = costUSDOf(modelSpec, usage);
  return costUSD === undefined ? {} : { costUSD, costBasis: 'modeled' as const };
}

/** Inputs to the frozen stop-reason mapping (header table). */
export interface StopReasonInputs {
  aborted: boolean;
  maxTokens: number | undefined;
  usage: Usage;
  resultStatus: ResultStatus;
}

/** THE mapping (checked in order): aborted → budget → error → complete. */
export function stopReasonOf(inputs: StopReasonInputs): WorkerResult['stopReason'] {
  if (inputs.aborted) return 'aborted';
  if (inputs.maxTokens !== undefined && totalTokensOf(inputs.usage) >= inputs.maxTokens) return 'budget';
  if (inputs.resultStatus === 'success') return 'complete';
  if (inputs.resultStatus === 'cap') return 'budget';
  return 'error';
}

/** Abort-shaped throw: the governor's cancellation, not an error (I8). */
function isAbortShaped(err: unknown): boolean {
  const name = err instanceof Error ? err.name : undefined;
  return name === 'AbortError';
}
