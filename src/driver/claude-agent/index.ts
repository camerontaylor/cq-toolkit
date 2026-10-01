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
//     tool surface this lane ever offers is the harness surface, bound by
//     the SHARED CORE (src/harness/surface.ts — W1.4, ADR-0002 Annex A.1):
//     `buildManifest` (workspace realpath, sandbox level, harness ∩ policy,
//     harness config) → `createHarnessSurface`, the same core the
//     subprocess lane serves over stdio; the handler is `surface.call`, so
//     both lanes return byte-identical CallToolResults (the parity test).
//     The frozen policy is the WHOLE truth about what can execute.
//   - `settingSources: []` + `strictMcpConfig: true` ALWAYS (live leg
//     A.5j): without them subscription auth attaches the account's
//     claude.ai connectors to the worker's surface. The FIRST init frame is
//     then asserted fail-closed: exactly `cq-harness`/connected (or no
//     server) and exactly the qualified selected tools (+ StructuredOutput
//     with outputFormat) — a mismatch ends the query and settles 'error'
//     with a HARNESS_ERROR_PREFIX cause ('harness-surface-mismatch'); a
//     result with no init frame is 'harness-surface-unverified'.
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
// STRUCTURED OUTPUT (seam v2, ADR-0002 §2.3): the SDK's NATIVE path —
// `outputFormat: { type: 'json_schema', schema }`. The schema rides the
// INVOCATION (`OpInvocation.outputSchema` — the plain `OutputSchema`
// {name, schema} document); there is NO construction-time schema (S6) — the
// invocation is the only schema source, so ONE judge covers every lane the
// same way. The
// after-settle judgment is the SHARED validator (`validateStructured` from
// ../common/structured.js) over the SAME document that was sent (meta-URI
// stripped for the CLI-bound transport). Verdict table (ADR §2.3):
//   - object obtained and it validates → 'complete', structuredOutput = the
//     validated plain JSON;
//   - object missing/unparseable/schema-invalid AFTER the SDK's NATIVE
//     outputFormat retry (no manual repair loop here) → stopReason 'error',
//     errorClass 'output-invalid', usage/cost kept, the rejection recorded
//     in the bounded error text; the old behaviour (complete with the
//     payload dropped to narration) is DELETED — consumers read errorClass;
//   - a cap (error_max_turns / error_max_budget_usd) or the signal stopped
//     the run first → 'budget' / 'aborted' (the missing object is a
//     consequence, not the cause);
//   - no schema requested → structuredOutput is ABSENT even when the reply
//     text looks like JSON.
//
// I6 ISOLATION via the harness session store (src/harness/session.ts) —
// EXACTLY the other two lanes:
//   - NO sessionRef → `tempWorkspace()` + `SessionStore.create()` — fresh
//     record + a workspace nothing has ever touched. When the invocation
//     carries a `workspace` binding (ADR-0002 §2.4), the fresh record is
//     instead created IN realpath(workspace.path) and the manifest/tools
//     bind there; a workspace set alongside a sessionRef must record the
//     SAME realpath (else a pre-dispatch config throw). Session sidecars
//     and records stay in the lane's sessionsDir — never in the workspace.
//   - sessionRef → `SessionStore.load(sessionRef)`; the record's workspace
//     AND message history continue. Unknown sessionRef → PRE-DISPATCH
//     throw (a fake resume is worse than a loud one).
//   - The agent's OWN conversation continues via the SESSIONS-STORE sidecar
//     `<sessionsDir>/<sessionId>.cq-cli-session` (AGENT_SESSION_FILE): the
//     session id the agent reports (every frame carries `session_id`) is
//     persisted post-settle and passed as `Options.resume` on the next run
//     over the same sessionRef. A session without a sidecar (prior run died
//     before the agent reported) resumes the WORKSPACE only — an honest
//     partial continuation. A sidecar, not a record message: role 'tool' in
//     a session record means A TOOL RAN, so the handle must not masquerade
//     as one. And NOT in the workspace (issue #26, design (b)): the
//     workspace is MODEL-VISIBLE — the earlier placement there was a tamper
//     vector (the harness edit tool's `**/*` glob includes dotfiles, so the
//     model could read or alter its own resume handle); keyed by sessionId
//     beside the session records, the handle is exactly as precise and out
//     of its reach.
//   - Persisted in OUR vocabulary: the user prompt (pre-run); ONE role
//     'tool' message per IN-POLICY harness tool execution ({ input, ok,
//     output } plain JSON) at the execute boundary; the assistant
//     transcript text (when any); narration (unknown frame shapes —
//     evidence, never a crash) under toolName 'agent-narration'. Persist
//     errors after dispatch are swallowed: the honest verdict outranks the
//     record.
//
// I8 SEAM — the driver owns NO wall clock. The run's ONLY cancellation
// SOURCE is `RunOptions.signal` (seam v2, ADR-0002 §2.1) — the caller
// passes the governed rung-1 signal explicitly — forwarded EXACTLY ONE
// place: the SDK query's
// cancellation root (Options.abortController), wired by ./process.ts (the
// hygiene scan's exempt file — construction of the root is machinery; the
// WHEN stays the signal's sender). An already-fired signal never dispatches
// and creates no session state.
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
// missing key env — each a DispatchError('config'); unknown sessionRef; a
// workspace binding that is not an absolute existing directory or
// disagrees with the resumed record's realpath — a DispatchError('config');
// a non-positive Budget.maxTokens).
//
// ERROR CLASSES (seam v2, ADR-0002 §2.2): every error verdict carries
// `errorClass`, classified ONLY from structured signals — the result-frame
// subtype/errors, the assistant frame's structured `error:"rate_limit"`
// field, and the vendor's limit vocabulary where the SDK exposes no
// structure (anchored patterns only; the unanchored numeric-status style is
// banned) — in the ADR's cut order: the funded-allowance code
// (`enforced_spend_limit_reached`) is 'quota' whatever the wrapper; the
// assistant rate_limit field and the CLI "You've hit your … limit · resets …"
// result are 'quota' (RS-14 §4 rule 3 — ahead of the retry-after rule), with
// the reset instant in `providerSignals.windows[*].resetAt` when the vendor's
// reset text is extractable; `rate_limit_error` with a retry-after is
// 'rate-limit' (retryAfterMs in providerSignals); a dispatch throw (spawn/
// exit/crash of the CLI) is 'harness'; any other result-frame subtype/errors
// is 'provider-error'; anything unresolved is 'unknown', NEVER a guessed
// 'transient'. Abort-shaped results are excluded (they are 'aborted', not
// errors). `providerSignals` rides ANY verdict, only with structurally
// present data — never invented.
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
import { defaultHarnessConfig } from '../../harness/config.js';
import type { HarnessConfig } from '../../harness/config.js';
import {
  HARNESS_MCP_SERVER_NAME,
  buildManifest,
  compareInitSurface,
  createHarnessSurface,
  harnessToolName,
  qualifiedToolName,
  selectToolNames,
} from '../../harness/surface.js';
import type { ExpectedInitSurface, HarnessSurface } from '../../harness/surface.js';
import { SessionStore, tempWorkspace } from '../../harness/session.js';
import type { SessionMessage, SessionRecord } from '../../harness/session.js';
import { boundedErrorText, describeError, redactSensitiveText } from '../error-text.js';
import { DispatchError } from '../errors.js';
import { boundWorkspacePath, resumedRecordOrThrow } from '../common/workspace.js';
import { buildChildEnv } from '../subprocess/process.js';
import { stripMetaSchema } from '../json-schema.js';
import { validateStructured } from '../common/structured.js';
import { computeCostUSD } from '../pricing/index.js';
import type { PerMillionRates } from '../pricing/index.js';
import type {
  Driver,
  ModelSpec,
  OpInvocation,
  ProviderSignals,
  RunOptions,
  SandboxLevel,
  ToolDenial,
  ToolPolicy,
  Usage,
  WorkerErrorClass,
  WorkerResult,
} from '../types.js';
import { defaultEndpointTable, resolveEndpoint } from './routing.js';
import type { EndpointTable, ResolvedEndpoint } from './routing.js';
import { abortRootFollowing } from './process.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** The optional peer this lane loads lazily — never statically imported. */
export const SDK_MODULE_SPECIFIER = '@anthropic-ai/claude-agent-sdk';

/** SDK MCP server name under which the harness tool surface is registered (the shared core's name). */
export const MCP_SERVER_NAME = HARNESS_MCP_SERVER_NAME;

/**
 * The file-name SUFFIX of the agent-session sidecar — the `Options.resume`
 * handle for the NEXT run on the SAME sessionRef, stored as
 * `<sessionsDir>/<sessionId>.cq-cli-session` (issue #26, design (b)). A
 * sidecar, not a record message: role 'tool' in a session record means a
 * tool ran (header). And NOT in the workspace: the workspace is
 * MODEL-VISIBLE — the earlier placement there was a tamper vector (the
 * harness edit tool's catch-all path glob spans dotfiles too, so the model
 * could read or alter its own resume handle); keyed by sessionId beside the
 * session records, the handle is exactly as precise and out of its reach.
 */
export const AGENT_SESSION_FILE = '.cq-cli-session';

/** Session-message toolName under which unknown-frame narration is recorded. */
export const NARRATION_TOOL = 'agent-narration';

/**
 * The SDK-internal tool the init frame lists whenever `outputFormat` is
 * set (W1.4 live leg A.5j, agent-sdk 0.3.270 — its native structured-output
 * tool). Pinned into the init-surface assertion's expected set.
 */
export const SDK_STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/**
 * The stable leading text of a harness-classified error verdict
 * (`WorkerResult.error`) — ADR-0002 §2.2's `errorClass: 'harness'` lands
 * with the seam-v2 types bump (W3.3); until then this prefix and the
 * narration marker's `errorClass` field carry the classification.
 */
export const HARNESS_ERROR_PREFIX = 'claude-agent driver: harness failure';

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
  /** Harness config (tool surface + prompt budget). Default: defaultHarnessConfig. */
  harnessConfig?: HarnessConfig;
  /** Sessions directory for the backing SessionStore. Default: <os.tmpdir()/cq-harness>/sessions. */
  sessionsDir?: string;
  /** Additional host env names exposed to the SDK child and harness run commands. */
  envAllowlist?: readonly string[];
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
  private readonly harnessConfig: HarnessConfig;
  private readonly sessionsDir: string | undefined;
  private readonly envAllowlist: readonly string[] | undefined;
  private readonly pricingOverride:
    | ((modelSpec: ModelSpec) => PerMillionRates | undefined)
    | undefined;
  /** Memoized load — one feature-detect per driver instance, never per run. */
  private sdkModule: Promise<AgentSdkModule> | undefined;

  constructor(options: ClaudeAgentDriverOptions = {}) {
    if (options.envAllowlist?.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
      throw new Error('claude-agent driver: envAllowlist entries must be valid env var names');
    }
    this.envAllowlist =
      options.envAllowlist === undefined ? undefined : Object.freeze([...options.envAllowlist]);
    this.sdkLoader = options.sdkLoader ?? defaultSdkLoader;
    this.endpointTable = options.endpointTable ?? defaultEndpointTable();
    this.harnessConfig = options.harnessConfig ?? defaultHarnessConfig;
    this.sessionsDir = options.sessionsDir;
    this.pricingOverride = options.pricing;
  }

  /** The frozen seam (v2): run one invocation to completion. */
  async run(opInvocation: OpInvocation, options?: RunOptions): Promise<WorkerResult> {
    const { prompt, modelSpec, toolPolicy, sandboxPolicy, sessionRef, budget } = opInvocation;

    // --- Pre-dispatch validation: everything here throws BEFORE the agent
    // is contacted and BEFORE any session/workspace exists (fail loudly, no
    // partial state). Provider first (pure), then the peer, then budget,
    // then the workspace binding.
    const endpoint = resolveEndpoint(modelSpec, this.endpointTable); // unknown provider → the throw
    const keyValue = readKeyEnvOrThrow(endpoint); // missing key env → throw
    const sdk = await this.loadSdk(); // peer absent / misshaped → throw
    if (
      budget.maxTokens !== undefined &&
      (!Number.isFinite(budget.maxTokens) || budget.maxTokens <= 0)
    ) {
      throw new Error(
        `claude-agent driver: budget.maxTokens must be a finite number > 0, got ${String(budget.maxTokens)}`,
      );
    }
    // Workspace binding (ADR-0002 §2.4): validated + realpathed BEFORE any
    // session state exists — a bad binding is a pre-dispatch config throw.
    const boundWorkspace =
      opInvocation.workspace === undefined
        ? undefined
        : boundWorkspacePath(opInvocation.workspace, 'claude-agent driver');

    // --- Governed cancellation (I8): the run's signal is RunOptions.signal
    // the ONLY cancellation channel (seam v2). Checked BEFORE the dispatch
    // (an already-cancelled invocation never dispatches — and never creates
    // a session record), then wired to the SDK's cancellation root — the
    // driver decides nothing about WHEN.
    const signal = options?.signal;
    if (signal?.aborted === true) {
      return { usage: zeroUsage(), denials: [], stopReason: 'aborted' };
    }

    // --- I6 isolation / §2.4 workspace table: a fresh record — created in
    // the bound workspace when one is set, else in a fresh temp workspace —
    // or a real resume, which must record the SAME realpath when a workspace
    // is bound (else a pre-dispatch config throw).
    const sessionsDir = this.sessionsDir ?? defaultSessionsDir();
    const store = new SessionStore(sessionsDir);
    const record =
      sessionRef === undefined
        ? await store.create(
            boundWorkspace ?? (await tempWorkspace(this.harnessConfig.workspaceRoot)),
          )
        : await resumedRecordOrThrow(store, sessionRef, boundWorkspace, 'claude-agent driver');
    const workspace = record.workspace;

    await store.appendMessage(record.sessionId, { role: 'user', content: prompt, at: nowIso() });

    // --- Tool surface: the SHARED CORE (src/harness/surface.ts) — the one
    // manifest constructor binds the workspace realpath, the sandbox level,
    // harness ∩ per-op ToolPolicy and the harness config; the bound surface
    // is registered as the SDK's in-process custom tools. The subprocess
    // lane serves the SAME core over stdio (two-level parity test). An
    // empty selection yields no manifest and no server. Built-ins are
    // disabled wholesale (the governed surface is the WHOLE surface, header).
    const manifest = await buildManifest({
      workspace,
      sandbox: sandboxPolicy.level,
      toolPolicy,
      harness: this.harnessConfig,
      envNames: this.envAllowlist,
    });
    const surface = manifest === undefined ? undefined : createHarnessSurface(manifest);
    const allowed = manifest?.tools ?? [];

    // --- Agent-level resume: the agent session id recorded in the -------
    // SESSIONS STORE sidecar by a prior run (absent → workspace-only
    // continuation).
    const resumeAgentSessionId = await readAgentSessionId(sessionsDir, record.sessionId);

    // --- Per-run schema resolution (ADR-0002 §2.3): the invocation schema
    // is the only schema source; it normalizes to the same plain-data
    // OutputSchema the shared validator judges.
    const outputSchema = opInvocation.outputSchema;

    // The per-run observation — created before the options assembly because
    // the harness-tool closures accumulate denials into it directly.
    const observation = newObservation();
    // Fail-closed init-surface assertion (Annex A.2, enabled after A.5j):
    // exactly the harness server (when registered) and exactly the selected
    // tools, plus the SDK's structured-output tool when outputFormat is set.
    observation.expectedSurface = {
      harness: surface !== undefined,
      tools: allowed,
      internalTools: outputSchema === undefined ? [] : [SDK_STRUCTURED_OUTPUT_TOOL],
    };

    // --- The one SDK call: options assembly. ------------------------------
    const sandbox = sandboxOption(sandboxPolicy.level);
    const sdkTools = (surface?.tools ?? []).map((harnessTool) =>
      sdk.tool(
        harnessTool.name,
        harnessTool.description,
        // The zod raw shape — the SDK's declared-input form. Deliberately the
        // NON-strict shape (what the model sees as the tool's schema): the
        // SDK pre-validates it, so a type-invalid call never reaches the core
        // and extra keys are stripped — the parity test's one scoped
        // transport difference (nothing executes either way).
        harnessTool.inputSchema.shape,
        (args: unknown, extra: unknown): Promise<SdkToolCallResult> =>
          runHarnessTool(
            surface as HarnessSurface,
            harnessTool.name,
            args,
            store,
            record,
            observation.denials,
            // Cancellation reaches the executor: the governed signal (I8 —
            // forwarded, never decided here) and the SDK's per-call signal,
            // whichever fires first; `run` then kills its process group.
            callSignal(signal, extra),
          ),
      ),
    );
    // The SDK query's option object — named apart from the seam's
    // `RunOptions` parameter (the cancellation SIGNAL lives there; this is
    // the assembled query surface).
    const queryOptions: Record<string, unknown> = {
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
      // CLOSED SURFACE (W1.4 live leg A.5j): without these two, subscription
      // auth attaches the account's claude.ai connectors (dozens of extra
      // tools — mail, drive, calendar) to the worker's surface; with them the
      // init frame lists exactly the harness tools (+ StructuredOutput), on
      // API-key and subscription auth alike.
      settingSources: [],
      strictMcpConfig: true,
      // The SDK child receives only allowlisted host names plus its route
      // credentials. Harness run children receive the manifest's allowlist
      // without these SDK-only credential overrides.
      env: buildChildEnv(
        process.env,
        {
          ANTHROPIC_BASE_URL: endpoint.baseUrl,
          ANTHROPIC_AUTH_TOKEN: keyValue,
          ANTHROPIC_API_KEY: keyValue,
        },
        this.envAllowlist,
      ),
      systemPrompt: systemPreamble(this.harnessConfig.promptBudget.maxSystemPromptChars),
      ...(surface !== undefined
        ? {
            mcpServers: {
              [MCP_SERVER_NAME]: sdk.createSdkMcpServer({ name: MCP_SERVER_NAME, tools: sdkTools }),
            },
          }
        : {}),
      ...(sandbox !== undefined ? { sandbox } : {}),
      ...(resumeAgentSessionId !== undefined ? { resume: resumeAgentSessionId } : {}),
      ...(outputSchema !== undefined
        ? {
            outputFormat: {
              type: 'json_schema',
              // Transport (ADR-0002 §2.3): the EXACT plain document the
              // schema request carried, meta-URI stripped (the CLI rejects
              // the draft-2020-12 `$schema` key, #209). The after-settle
              // judgment is `validateStructured` over the SAME document.
              schema: stripMetaSchema(outputSchema.schema),
            },
          }
        : {}),
    };
    const abortRoot = abortRootFollowing(signal); // ./process.ts — the wiring only
    if (abortRoot !== undefined) {
      queryOptions['abortController'] = abortRoot.controller;
    }

    // --- Dispatch. From here on, run() NEVER throws past the seam. --------
    let aborted = false;
    try {
      for await (const message of sdk.query({ prompt, options: queryOptions })) {
        foldMessage(observation, message);
        // A surface mismatch ends the run: leaving the loop returns the
        // query's generator, which closes the SDK session.
        if (observation.harnessFailure !== undefined) break;
      }
    } catch (err) {
      // An abort-shaped failure is the governor's cancellation, not an
      // error (I8); anything else is an honest error verdict. The abort
      // verdict reads the LIVE state of the wired root (the governed
      // signal may fire mid-iteration — flow analysis of the pre-dispatch
      // check cannot see that).
      aborted = abortRoot?.controller.signal.aborted === true || isAbortShaped(err);
      if (!aborted) {
        // A dispatch throw is the CLI's spawn/exit/crash surface (ADR §2.2):
        // 'harness' unless the vendor's limit vocabulary says otherwise —
        // the raw cause is kept for the classifier (the error field carries
        // the lane-prefixed, bounded form).
        observation.errorKind = 'dispatch-threw';
        observation.caughtCause = describeError(err);
        observation.error = `claude-agent driver: query failed — ${describeError(err)}`;
      }
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

    // Fail closed: a run whose SDK never reported an init surface ran
    // unverified — whatever it reports is not a model outcome.
    if (
      !aborted &&
      observation.expectedSurface !== undefined &&
      !observation.initSeen &&
      observation.harnessFailure === undefined &&
      observation.result !== undefined
    ) {
      observation.harnessFailure = { cq: 'harness-surface-unverified', errorClass: 'harness' };
    }
    if (observation.harnessFailure !== undefined) {
      observation.narration.push(JSON.stringify(observation.harnessFailure));
      observation.error =
        observation.harnessFailure.cq === 'harness-surface-mismatch'
          ? `${HARNESS_ERROR_PREFIX} — init surface mismatch: expected ${JSON.stringify(observation.harnessFailure.expected)}, observed ${JSON.stringify(observation.harnessFailure.observed)}`
          : `${HARNESS_ERROR_PREFIX} — the SDK never reported its init surface`;
    }

    // --- SDK-side permission denials → frozen shape (post-settle, deduped
    // per tool_use id). These are tools the agent's permission gate refused
    // (outside allowedTools — the withheld surface); harness denials from
    // EXECUTED tools were accumulated at the execute boundary.
    mapPermissionDenials(observation);

    // --- Structured output (ADR-0002 §2.3, S3): the ONE shared validator
    // judges the payload over the SAME document that was sent. A miss after
    // the SDK's NATIVE outputFormat retry settles the uniform
    // error/'output-invalid' verdict (usage and cost kept, rejection in the
    // bounded error text) — the old "complete with the payload dropped to
    // narration" behaviour is deleted. A result frame that failed for its
    // own reason is not a model-output outcome: the §2.2 classifier names
    // it, and its payload (if any) never reaches the seam.
    let structured: unknown;
    let structuredMiss: string | undefined;
    if (
      outputSchema !== undefined &&
      !aborted &&
      observation.harnessFailure === undefined &&
      observation.result !== undefined
    ) {
      const subtype = asString(observation.result['subtype']);
      if (subtype === 'error_max_structured_output_retries') {
        structuredMiss =
          `the agent exhausted its native structured-output retries ` +
          `(subtype '${subtype}') without producing the required object`;
      } else if (resultStatusOf(observation.result) === 'success') {
        const raw = observation.result['structured_output'];
        if (raw === undefined) {
          structuredMiss =
            'the result event carried no structured_output (the agent never produced the required object)';
        } else {
          const check = validateStructured(outputSchema, raw);
          if (check.ok) {
            structured = check.value;
          } else {
            structuredMiss = `the result does not validate against schema '${outputSchema.name}' — ${check.reason}`;
          }
        }
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

    // --- A result event that reports failure must carry a cause (issue
    // #204): derive one from the frame when the dispatch catch saw nothing.
    // Precedence: the result's own `result` string, then the joined
    // `errors` entries, then the subtype — the SDK supplies whichever it
    // surfaces, and a bare 'error' verdict is exactly the dishonesty this
    // field exists to remove.
    let resultCause: string | undefined;
    if (observation.error === undefined && resultStatusOf(observation.result) === 'error') {
      const resultFrame = observation.result;
      const rawResult = asString(resultFrame?.['result']);
      const errorEntries = (asArray(resultFrame?.['errors']) ?? []).filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
      );
      const subtype = asString(resultFrame?.['subtype']);
      const cause =
        rawResult !== undefined && rawResult.trim() !== ''
          ? rawResult
          : errorEntries.length > 0
            ? errorEntries.join('; ')
            : `subtype '${subtype ?? 'unknown'}'`;
      observation.error = `claude-agent driver: SDK result status error — ${cause}`;
      observation.errorKind = 'result-frame';
      resultCause = cause;
    }

    return this.verdict(
      modelSpec,
      budget,
      observation,
      record.sessionId,
      aborted,
      structured,
      structuredMiss,
      resultCause,
    );
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
        // Pre-dispatch misconfiguration carries its class as structured data
        // (ADR-0002 §2.2): errorClassOf → 'config'. The load failure's own
        // message rides in the text — a DispatchError carries no cause chain.
        throw new DispatchError(
          'config',
          `claude-agent driver: the optional peer dependency '${SDK_MODULE_SPECIFIER}' is not installed — ` +
            'install it to use this lane (npm install --save-optional @anthropic-ai/claude-agent-sdk; ' +
            `see src/driver/README.md). Refusing pre-dispatch, before any session exists. (${describeError(err)})`,
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
   *
   * ERROR CLASSES (seam v2, ADR-0002 §2.2): every 'error' verdict carries
   * `errorClass` — the producer rule — and nothing else does. Cut order:
   * a harness failure → 'harness'; a structured-output miss →
   * 'output-invalid'; otherwise the §2.2 classifier over structured
   * signals. Abort/budget carve-outs carry no class: the missing object is
   * their consequence, not their cause.
   */
  private verdict(
    modelSpec: ModelSpec,
    budget: OpInvocation['budget'],
    observation: RunObservation,
    sessionId: string,
    aborted: boolean,
    structured: unknown,
    structuredMiss: string | undefined,
    resultCause: string | undefined,
  ): WorkerResult {
    const measured =
      observation.result !== undefined ? usageFromAgent(observation.result['usage']) : undefined;
    const usage = measured ?? observation.assistantUsage ?? zeroUsage();
    const stopReason = stopReasonOf({
      aborted,
      harnessFailure: observation.harnessFailure !== undefined,
      maxTokens: budget.maxTokens,
      usage,
      resultStatus: resultStatusOf(observation.result),
    });
    // §2.3 verdict unification: a structured-output miss is an ERROR verdict
    // — except when a cap or the signal stopped the run first (the missing
    // object is its consequence, not its cause: the budget/aborted carve-out).
    const missIsError = structuredMiss !== undefined && stopReason === 'complete';
    const effectiveStopReason: WorkerResult['stopReason'] = missIsError ? 'error' : stopReason;
    // The error field is present ONLY on a driver-level failure verdict (the
    // frozen contract): a token-budget 'budget' stop is not a driver failure.
    // Within that verdict the cause may already be captured (dispatch throw,
    // or a failed result frame); a structured-output miss names the schema
    // rejection; otherwise say the query ended without a result event — a
    // bare 'error' tells the caller nothing.
    let error: string | undefined;
    let errorClass: WorkerErrorClass | undefined;
    let providerSignals: ProviderSignals | undefined;
    if (effectiveStopReason === 'error') {
      if (observation.harnessFailure !== undefined) {
        // Fail-closed surface/transport assertions are always 'harness'.
        errorClass = 'harness';
      } else if (structuredMiss !== undefined) {
        error = `claude-agent driver: structured output invalid — ${structuredMiss}`;
        errorClass = 'output-invalid';
      } else {
        const causeTexts =
          observation.errorKind === 'result-frame'
            ? [resultCause ?? '']
            : [observation.caughtCause ?? ''];
        const classified = classifyFailure({
          kind:
            observation.errorKind === 'result-frame'
              ? 'result-frame'
              : observation.errorKind === 'dispatch-threw'
                ? 'dispatch-threw'
                : 'no-result',
          texts: causeTexts,
          assistantRateLimit: observation.assistantRateLimit,
        });
        errorClass = classified.errorClass;
        providerSignals = classified.providerSignals;
      }
      error =
        error ??
        observation.error ??
        'claude-agent driver: the SDK query ended without a result event (the SDK surfaced no error text)';
    }
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
      stopReason: effectiveStopReason,
      ...(error !== undefined ? { error: boundedErrorText(error) } : {}),
      ...(errorClass !== undefined ? { errorClass } : {}),
      ...(providerSignals !== undefined ? { providerSignals } : {}),
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
    // Pre-dispatch misconfiguration carries its class as structured data
    // (ADR-0002 §2.2): errorClassOf → 'config'.
    throw new DispatchError(
      'config',
      `claude-agent driver: the loaded '${SDK_MODULE_SPECIFIER}' module is not an object — ` +
        'not the agent SDK surface this lane drives',
    );
  }
  const missing = ['query', 'tool', 'createSdkMcpServer'].filter(
    (name) => typeof rec[name] !== 'function',
  );
  if (missing.length > 0) {
    throw new DispatchError(
      'config',
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
    // Pre-dispatch misconfiguration carries its class as structured data
    // (ADR-0002 §2.2): errorClassOf → 'config'.
    throw new DispatchError(
      'config',
      `claude-agent driver: endpoint '${endpoint.endpoint}' requires ${endpoint.keyEnv} in the environment`,
    );
  }
  return value;
}

/**
 * Frozen ToolPolicy → the allowed tool-name subset: 'none' → nothing;
 * 'unrestricted' → the whole harness surface; 'allowlist' (the default
 * reading when mode is omitted) → harness names in `allow` only. The shared
 * core's `selectToolNames` — one implementation for every lane.
 */
export function allowedToolNames(
  harnessToolNames: readonly string[],
  policy: ToolPolicy,
): string[] {
  return selectToolNames(harnessToolNames, policy);
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
 * Execute one harness tool inside the SDK's tool loop (the MCP handler)
 * through the SHARED CORE: `surface.call` executes (serialized) and maps
 * the outcome to the CallToolResult — byte-identical to what the stdio
 * server returns on the subprocess lane. Here the lane adds its
 * execute-boundary duties: persist the outcome as a session message (our
 * vocabulary) and accumulate denials verbatim for WorkerResult.denials.
 * Persist errors are swallowed: the verdict outranks the record
 * (post-dispatch posture).
 */
export async function runHarnessTool(
  surface: HarnessSurface,
  name: string,
  input: unknown,
  store: SessionStore,
  record: SessionRecord,
  denials: ToolDenial[],
  signal?: AbortSignal,
): Promise<SdkToolCallResult> {
  const { result, outcome } = await surface.call(name, input, { signal });
  try {
    await store.appendMessage(record.sessionId, {
      role: 'tool',
      toolName: name,
      content: JSON.stringify({
        input: input ?? null,
        ok: outcome.ok,
        output: outcome.ok ? outcome.output : outcome.denial.reason,
      }),
      at: nowIso(),
    });
  } catch {
    // deliberately swallowed — the honest verdict outranks the record
  }
  if (!outcome.ok) denials.push(outcome.denial);
  return result;
}

/**
 * The cancellation signal for one harness call: the governed signal and the
 * SDK handler's per-call `extra.signal` (MCP RequestHandlerExtra), combined
 * when both exist. Undefined when neither does (an ungoverned run).
 */
function callSignal(governed: AbortSignal | undefined, extra: unknown): AbortSignal | undefined {
  const raw = asRecord(extra)?.['signal'];
  const perCall = raw instanceof AbortSignal ? raw : undefined;
  if (governed === undefined) return perCall;
  if (perCall === undefined) return governed;
  return AbortSignal.any([governed, perCall]);
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
  /**
   * The underlying failure cause, when one was observed (a dispatch throw,
   * or a result event that reports failure). Present only on an 'error'
   * verdict; never on a successful run (issue #204).
   */
  error: string | undefined;
  /**
   * The raw cause of the dispatch catch (unprefixed, unbounded) — the
   * classifier's text input; the `error` field carries the lane-prefixed,
   * bounded form.
   */
  caughtCause: string | undefined;
  /** Which channel set `error` — the classifier's structured kind signal. */
  errorKind: 'dispatch-threw' | 'result-frame' | undefined;
  /**
   * True when an assistant frame carried the SDK's structured
   * `error: 'rate_limit'` field (RS-14 §4 rule 3 → 'quota').
   */
  assistantRateLimit: boolean;
  /** tool_use ids already denied via permission_denials (dedupe). */
  deniedToolUseIds: Set<string>;
  /** The frozen denials, in denial order (execute-boundary + permission-gate). */
  denials: ToolDenial[];
  /** The init surface the SDK must report (fail-closed assertion); undefined = not asserted. */
  expectedSurface: ExpectedInitSurface | undefined;
  /** True once the first init frame was folded. */
  initSeen: boolean;
  /** The init-surface failure that ended the run, when one did. */
  harnessFailure:
    | {
        cq: 'harness-surface-mismatch';
        errorClass: 'harness';
        expected: unknown;
        observed: unknown;
      }
    | { cq: 'harness-surface-unverified'; errorClass: 'harness' }
    | undefined;
}

function newObservation(): RunObservation {
  return {
    agentSessionId: undefined,
    servedModel: undefined,
    transcript: [],
    narration: [],
    assistantUsage: undefined,
    result: undefined,
    error: undefined,
    caughtCause: undefined,
    errorKind: undefined,
    assistantRateLimit: false,
    deniedToolUseIds: new Set(),
    denials: [],
    expectedSurface: undefined,
    initSeen: false,
    harnessFailure: undefined,
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

/**
 * SDK-reported numeric fields must be finite non-negative INTEGERS: a
 * negative or fractional "token count" is a lying measurement — accepting
 * it folded negative usage (→ negative cost) and a NEGATIVE token total
 * that could never trip the `>= maxTokens` budget check (the bypass,
 * issue #19). Invalid → undefined → the fold sites' `?? 0` maps it to an
 * honest zero.
 */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
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
        if (!observation.initSeen) {
          observation.initSeen = true;
          const expected = observation.expectedSurface;
          const verdict =
            expected === undefined
              ? ({ ok: true } as const)
              : compareInitSurface(expected, {
                  mcp_servers: event['mcp_servers'],
                  tools: event['tools'],
                });
          if (!verdict.ok) {
            observation.harnessFailure = {
              cq: 'harness-surface-mismatch',
              errorClass: 'harness',
              expected: verdict.expected,
              observed: verdict.observed,
            };
          }
        }
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
      // The SDK's structured per-frame error field (e.g. `error:
      // 'rate_limit'` on a throttled assistant message) — a STRUCTURED
      // signal (RS-14 §4 rule 3), folded for the verdict classifier.
      const frameError = asString(event['error']) ?? asString(inner['error']);
      if (frameError === 'rate_limit') observation.assistantRateLimit = true;
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
    observation.denials.push({
      tool,
      reason: `tool use denied by the agent permission gate (${tool})`,
    });
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
    // Stored beside the session records, keyed by sessionId (issue #26) —
    // NOT in the model-visible workspace (the tamper vector, header) — and
    // 0o600 like the records it sits beside (never world-readable).
    try {
      await writeFile(
        join(store.sessionsDir, `${record.sessionId}${AGENT_SESSION_FILE}`),
        `${agentSessionId}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
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
      content: JSON.stringify(observation.narration.map(redactSensitiveText)),
      at: nowIso(),
    };
    await store.appendMessage(record.sessionId, message);
  }
}

/**
 * The agent session id recorded by a prior run of THIS session — the resume
 * handle of the current run — read from the relocated store sidecar
 * `<sessionsDir>/<sessionId>.cq-cli-session` (issue #26). Missing/
 * unreadable → undefined (an honest workspace-only continuation, never a
 * fabricated resume).
 */
async function readAgentSessionId(
  sessionsDir: string,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(join(sessionsDir, `${sessionId}${AGENT_SESSION_FILE}`), 'utf8');
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined; // no sidecar — nothing to resume agent-side
  }
}

// ---------------------------------------------------------------------------
// Error-class classifier (seam v2, ADR-0002 §2.2; RS-14 §4 cut order)
// ---------------------------------------------------------------------------

/** Inputs to the claude-agent failure classifier — structured signals only. */
export interface FailureClassInputs {
  /** Which channel reported the failure (the classifier's kind signal). */
  kind: 'dispatch-threw' | 'result-frame' | 'no-result';
  /**
   * The vendor's cause texts for this failure: the thrown message (a
   * dispatch throw) or the failed result frame's result string / joined
   * errors / subtype. The agent SDK exposes no HTTP headers or status
   * codes, so the vendor's limit vocabulary is matched ONLY through these
   * anchored patterns below.
   */
  texts: readonly string[];
  /** An assistant frame carried the structured `error: 'rate_limit'` field. */
  assistantRateLimit: boolean;
}

/** The classifier's verdict: the frozen class plus any limit observations. */
export interface FailureClassification {
  errorClass: WorkerErrorClass;
  providerSignals?: ProviderSignals;
}

/**
 * The class of a claude-agent failure (header table). Cut order:
 *   1. the funded-allowance code (`enforced_spend_limit_reached`) is
 *      'quota' whatever wrapped it (ADR §2.2 rule 2);
 *   2. the assistant's structured `error:'rate_limit'` field, or the CLI's
 *      "You've hit your … limit · resets …" result → 'quota' (RS-14 §4
 *      rule 3 — this precedes the retry-after rule), the reset instant in
 *      `providerSignals.windows[*].resetAt` when extractable;
 *   3. `rate_limit_error` → 'rate-limit', retryAfterMs from the vendor's
 *      anchored retry-after text when present;
 *   4. a dispatch throw or a silent death (no result event) → 'harness';
 *   5. any other result-frame subtype/errors → 'provider-error'.
 * Abort-shaped results never reach this function (they are 'aborted').
 */
export function classifyFailure(inputs: FailureClassInputs): FailureClassification {
  const joined = inputs.texts.join('\n');
  // Cut 1: funded-allowance exhaustion is quota at any status.
  if (/\benforced_spend_limit_reached\b/.test(joined)) {
    return { errorClass: 'quota' };
  }
  // Cut 2: the structured assistant field and the CLI usage-limit result —
  // quota, ahead of the retry-after rule.
  if (inputs.assistantRateLimit) {
    return quotaWithResetSignal(joined);
  }
  if (CLI_LIMIT_TEXT.test(joined)) {
    return quotaWithResetSignal(joined);
  }
  // Cut 3: the API's rate-limit error type → rate-limit (retry-after when
  // the vendor's text states one).
  if (/\brate_limit_error\b/.test(joined)) {
    const retryAfterMs = retryAfterMsFromText(joined);
    return {
      errorClass: 'rate-limit',
      ...(retryAfterMs !== undefined ? { providerSignals: { retryAfterMs } } : {}),
    };
  }
  // Cut 4: the CLI's own failure surfaces are local (harness) — a spawn/
  // exit/crash dispatch throw, or a death with no result event at all.
  if (inputs.kind !== 'result-frame') {
    return { errorClass: 'harness' };
  }
  // Cut 5: a result frame that failed for its own (provider-side) reason.
  return { errorClass: 'provider-error' };
}

/** Quota + the unified-window reset observation, when the text carries one. */
function quotaWithResetSignal(text: string): FailureClassification {
  const resetAt = resetAtFromLimitText(text);
  return {
    errorClass: 'quota',
    ...(resetAt !== undefined
      ? { providerSignals: { windows: [{ id: unifiedWindowIdOf(text), resetAt }] } }
      : {}),
  };
}

/**
 * The claude CLI's usage-limit result, ANCHORED: only the vendor's own
 * "You've hit your … limit · resets …" shape matches — never a bare
 * numeric-status scan.
 */
const CLI_LIMIT_TEXT = /you(?:'ve| have) hit your [a-z ]{1,32}limit · resets /i;

/**
 * The unified-limit window id for a limit text: the vendor names the window
 * ('use limit'/'session limit' = the 5h unified window, 'weekly limit' = the
 * 7d one); anything else is honestly bucketed 'unified' rather than guessed.
 */
function unifiedWindowIdOf(text: string): string {
  if (/\b(?:weekly|7d)\b/i.test(text)) return '7d';
  if (/\b(?:use|session|5h)\b/i.test(text)) return '5h';
  return 'unified';
}

/**
 * A retry-after stated in the vendor's error text → milliseconds. ANCHORED
 * forms only ("Try again in 25 seconds.", "retry after 30s") — the agent
 * SDK exposes no header structure to read instead.
 */
function retryAfterMsFromText(text: string): number | undefined {
  const seconds = /try again in (\d+) seconds?/i.exec(text) ?? /retry[- ]after (\d+)s?/i.exec(text);
  const value = seconds?.[1];
  return value === undefined ? undefined : Number(value) * 1000;
}

/**
 * The reset instant from a claude limit text's "· resets <when>" tail, when
 * the vendor's form is parseable: an absolute date, a relative duration
 * ('1h30m'), or the CLI's wall-clock form ("3pm (Asia/Singapore)" — resolved
 * against the named IANA zone). Anything ambiguous (bare digits, a zoneless
 * wall clock) is left OUT — never invent a reset.
 */
export function resetAtFromLimitText(text: string): string | undefined {
  // The capture stops at the line end: the classifier may join several
  // cause texts (result frame + subtype + stderr) into one string.
  const tail = /· resets ([^\n]+)/i.exec(text)?.[1]?.trim();
  if (tail === undefined || tail === '' || /^\d+$/.test(tail)) return undefined;
  const parsed = Date.parse(tail);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const duration =
    /^((?<days>\d+)d)?((?<hours>\d+)h)?((?<minutes>\d+)m)?((?<seconds>\d+)s)?$/i.exec(tail);
  if (duration?.groups !== undefined) {
    const { days, hours, minutes, seconds } = duration.groups;
    const totalMs =
      Number(days ?? 0) * 86_400_000 +
      Number(hours ?? 0) * 3_600_000 +
      Number(minutes ?? 0) * 60_000 +
      Number(seconds ?? 0) * 1000;
    return totalMs > 0 ? new Date(Date.now() + totalMs).toISOString() : undefined;
  }
  const wall =
    /^(?:(?<date>\d{4}-\d{2}-\d{2})\s+)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)?\s*\((?<zone>[^)]+)\)$/i.exec(
      tail,
    );
  if (wall?.groups === undefined) return undefined;
  const { date, hour, minute, meridiem, zone } = wall.groups;
  if (zone === undefined) return undefined; // a zoneless wall clock is no instant
  let hours = Number(hour);
  const minutes = Number(minute ?? '0');
  if (!Number.isInteger(hours) || hours <= 0 || hours > 23) return undefined;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return undefined;
  if (meridiem !== undefined) {
    if (hours > 12) return undefined;
    hours = (hours % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  }
  return instantOfWallClock(hours, minutes, zone.trim(), date);
}

/**
 * The UTC instant of the NEXT occurrence of `hour:minute` wall-clock time in
 * `zone` (or of the named calendar date in that zone), best effort: the
 * zone's offset is read through Intl and corrected twice for DST edges. An
 * unknown zone yields undefined — a reset is never invented.
 */
function instantOfWallClock(
  hour: number,
  minute: number,
  zone: string,
  date: string | undefined,
): string | undefined {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const offsetAt = (at: number): number => {
      const parts: Record<string, number> = {};
      for (const part of formatter.formatToParts(new Date(at))) {
        if (part.type !== 'literal') parts[part.type] = Number(part.value);
      }
      return (
        Date.UTC(
          parts['year'] ?? 1970,
          (parts['month'] ?? 1) - 1,
          parts['day'] ?? 1,
          parts['hour'] ?? 0,
          parts['minute'] ?? 0,
          parts['second'] ?? 0,
        ) -
        Math.floor(at / 1000) * 1000
      );
    };
    const DAY_MS = 86_400_000;
    const timeOfDay = hour * 3_600_000 + minute * 60_000;
    // The wall-clock midnight of the target date as-if-UTC, then the target
    // instant: solve midnightInstant + offset(midnightInstant) === U twice.
    const midnightAsUtc =
      date === undefined
        ? Math.floor((Date.now() + offsetAt(Date.now())) / DAY_MS) * DAY_MS
        : (() => {
            const parsed = Date.parse(`${date}T00:00:00Z`);
            return Number.isFinite(parsed) ? parsed : Number.NaN;
          })();
    if (!Number.isFinite(midnightAsUtc)) return undefined;
    let midnight = midnightAsUtc;
    midnight -= offsetAt(midnight);
    midnight = midnightAsUtc - offsetAt(midnight);
    let target = midnight + timeOfDay;
    if (date === undefined && target <= Date.now() - 60_000) {
      // Already past today: the reset means tomorrow (best effort — across a
      // DST edge the roll may be off by the shift; it is an observation, not
      // a contract).
      const tomorrow = midnightAsUtc + DAY_MS;
      let next = tomorrow;
      next -= offsetAt(next);
      next = tomorrow - offsetAt(next);
      target = next + timeOfDay;
    }
    return new Date(target).toISOString();
  } catch {
    return undefined; // unknown zone — no reset invented
  }
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
  /** The init-surface assertion failed (always an 'error'). */
  harnessFailure?: boolean;
  maxTokens: number | undefined;
  usage: Usage;
  resultStatus: ResultStatus;
}

/** THE mapping (checked in order): aborted → harness failure → budget → error → complete. */
export function stopReasonOf(inputs: StopReasonInputs): WorkerResult['stopReason'] {
  if (inputs.aborted) return 'aborted';
  if (inputs.harnessFailure === true) return 'error';
  if (inputs.maxTokens !== undefined && totalTokensOf(inputs.usage) >= inputs.maxTokens)
    return 'budget';
  if (inputs.resultStatus === 'success') return 'complete';
  if (inputs.resultStatus === 'cap') return 'budget';
  return 'error';
}

/** Abort-shaped throw: the governor's cancellation, not an error (I8). */
function isAbortShaped(err: unknown): boolean {
  const name = err instanceof Error ? err.name : undefined;
  return name === 'AbortError';
}
