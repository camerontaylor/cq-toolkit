// The Claude Code lane's SDK transport — Phase 1.9 (the consolidation of
// the former claude-agent driver, T1.6): drive the agent-SDK host —
// `query({ prompt, options })` of the OPTIONAL peer dependency
// `@anthropic-ai/claude-agent-sdk` — as a governed worker on the FROZEN
// Driver seam. This is the lane's OPTIONAL substrate path (D-E′ option A:
// one cq-owned Claude Code lane, CLI primary — cli.ts —, Agent SDK
// optional): a deployment binds the 'sdk' transport only when it installs
// the peer.
//
// EXECUTION MODEL: out-of-process via the SDK host. One query() per run —
// no daemon, no pooling, no retries (attempts are the runner/governor's
// business). Each query spawns a fresh agent worker rooted (cwd) in the
// invocation's OWN workspace.
//
// OPTIONAL PEER + CAPABILITY DETECTION (ADR-0001 decision 2): the SDK is an
// optional peerDependency; the package must BUILD and the whole suite must
// pass with it ABSENT from node_modules (the install-matrix workflow proves
// both halves). The peer is loaded lazily ONCE per transport instance
// through the `sdkLoader` constructor seam (production default: the dynamic
// import; tests inject a plain-object mock — zero vendor types). Absence is
// a PRE-DISPATCH THROW naming the peer and the fix — the same posture as a
// missing API key: fail loudly before any session exists, never a crash
// mid-run. Detection is FEATURE detection, never version sniffing: the
// loaded module must expose exactly the surface this transport drives
// (query / tool / createSdkMcpServer); anything else is a loud error.
//
// NO MODEL ALLOWLIST (owner override 2026-09-14): ANY model id is routed
// UNCHECKED — it rides `Options.model` verbatim. Routing is by PROVIDER
// only, over the ONE shared table (./routing.ts): base URL + auth env NAME;
// unknown provider throws pre-dispatch. THE SILENT-REMAP DEFENCE IS THE
// OBSERVED-MODEL CHECK: the transport surfaces the model id the agent
// REPORTS AS SERVED (the init frame's `model`, overwritten by every
// assistant frame's response-carried `message.model`) into
// `WorkerResult.model`; the shared served-model assertion fails a lane that
// remaps silently or cannot observe.
//
// TOOL POLICY → SDK MAPPING (the governed surface, exact):
//   - `tools: []` ALWAYS — every BUILT-IN agent tool is disabled. The only
//     tool surface this transport ever offers is the harness surface, bound
//     by the SHARED CORE (src/harness/surface.ts — W1.4, ADR-0002 Annex
//     A.1): `buildManifest` → `createHarnessSurface`, the same core the CLI
//     transport serves over stdio; the handler is `surface.call`, so both
//     transports return byte-identical CallToolResults (the parity test).
//     The frozen policy is the WHOLE truth about what can execute.
//   - `settingSources: []` + `strictMcpConfig: true` ALWAYS (live leg
//     A.5j): without them subscription auth attaches the account's
//     claude.ai connectors — and a workspace-committed `.claude/
//     settings.json` could add allow rules or hooks — to the worker's
//     surface. Ambient settings and MCP servers are structurally EXCLUDED
//     here (the CLI transport's `--setting-sources ""` +
//     `--strict-mcp-config` counterpart). The FIRST init frame is then
//     asserted fail-closed: exactly `cq-harness`/connected (or no server)
//     and exactly the qualified selected tools (+ StructuredOutput with
//     outputFormat) — a mismatch ends the query and settles 'error' with a
//     HARNESS_ERROR_PREFIX cause ('harness-surface-mismatch'); a result
//     with no init frame is 'harness-surface-unverified'.
//   - The selected harness tools ride the SDK's in-process custom-tool path
//     (`createSdkMcpServer` + `tool(name, description, inputSchema,
//     handler)`), registered under one server name ('cq-harness');
//     `allowedTools` receives their addressable spellings
//     `mcp__cq-harness__<name>` — ALWAYS emitted, empty when nothing is
//     pre-approved (the CLI transport's always-present --allowedTools).
//   - policy mode 'allowlist' (the default reading) → harness ∩ policy.allow;
//     'unrestricted' → the whole harness surface; 'none' → no server at all
//     + empty allowedTools.
//   - `permissionMode: 'default'` ALWAYS (mode is NOT the policy lever):
//     headless with no prompt surface, an un-pre-approved tool is
//     auto-DENIED — never prompted, never hung — and those SDK-side denials
//     land in the result's `permission_denials`, which map into
//     WorkerResult.denials (frozen {tool, reason} shape, harness-name
//     stripped, deduped per tool_use id).
//   - Every HARNESS denial (sandbox, allowlist miss, path escape, …) is
//     BOTH returned to the model as the tool's isError output text (the
//     model can adapt) AND accumulated verbatim ({ tool, reason }) into
//     WorkerResult.denials — observed at the execute boundary, in OUR
//     vocabulary.
//
// SANDBOX MAPPING (honest): sandboxPolicy 'none' → no sandbox option;
// 'workspace-write' | 'read-only' → `sandbox: { enabled: true,
// failIfUnavailable: false }` — defense-in-depth only; the ENFORCEMENT
// layer stays the harness tools.
//
// STRUCTURED OUTPUT (seam v2, ADR-0002 §2.3): the SDK's NATIVE path —
// `outputFormat: { type: 'json_schema', schema }`; the after-settle
// judgment is the ONE shared judge (verdict.ts, refusal-voided).
//
// I6 ISOLATION via the harness session store — EXACTLY the CLI transport,
// including the SHARED substrate-session sidecar (sessions.ts): a session
// record created by one transport resumes honestly on the other.
//
// I8 SEAM — the driver owns NO wall clock. The run's ONLY cancellation
// SOURCE is `RunOptions.signal`, forwarded EXACTLY ONE place: the SDK
// query's cancellation root (Options.abortController), wired by
// ./process.ts (the hygiene scan's exempt file). An already-fired signal
// never dispatches and creates no session state. Budget.maxTokens has NO
// native SDK stop: enforced POST-HOC over the folded result usage (the
// shared stop-reason map).
//
// USAGE MAPPING: the ONE shared fold (usage.ts) — the result frame's
// `modelUsage` per-model token aggregates when present (subagent spend
// included; tokens only, USD stays derived), else the flat result `usage`,
// else Σ assistant-frame usage; provenance + resume markers ride the
// narration. `reasoning` is deliberately NOT set (thinkingTokens are
// already inside output_tokens — a separate field would double-count).
import { defaultHarnessConfig } from '../../harness/config.js';
import { defaultSessionsDir } from '../sessions-dir.js';
import type { HarnessConfig } from '../../harness/config.js';
import {
  HARNESS_MCP_SERVER_NAME,
  buildManifest,
  compareInitSurface,
  createHarnessSurface,
  harnessToolName,
  qualifiedToolName,
} from '../../harness/surface.js';
import type { ExpectedInitSurface, HarnessSurface } from '../../harness/surface.js';
import { SessionStore, tempWorkspace } from '../../harness/session.js';
import type { SessionMessage, SessionRecord } from '../../harness/session.js';
import { toolAliases } from '../../harness/tools.js';
import { boundedErrorText, describeError, redactSensitiveText } from '../error-text.js';
import { DispatchError } from '../errors.js';
import { assertStrictTokenBudgetSupported } from '../common/strict-budget.js';
import { boundWorkspacePath, resumedRecordOrThrow } from '../common/workspace.js';
import { stripMetaSchema } from '../../shared/json-schema.js';
import { compileOutputSchema, uncompilableSchemaVerdict } from '../common/structured.js';
import type {
  Driver,
  ModelSpec,
  OpInvocation,
  RunOptions,
  SandboxLevel,
  ToolDenial,
  Usage,
  WorkerErrorClass,
  WorkerResult,
} from '../types.js';
import type { PerMillionRates } from '../pricing/index.js';
import {
  addUsage,
  computeDerivedCost,
  costField,
  measureResultUsage,
  usageFromWire,
  usageProvenanceMarker,
  resumedUsageSemanticsMarker,
  zeroUsage,
} from './usage.js';
import { classifyFailure } from './failures.js';
import { RoutingTableSchema, defaultRoutingTable, resolveRoute } from './routing.js';
import type { RoutingTable } from './routing.js';
import { buildChildEnv } from '../../shared/proc.js';
import { abortRootFollowing } from './process.js';
import { readCliSessionId, writeCliSessionId, SDK_NARRATION_TOOL } from './sessions.js';
import { applyCorrelationEnv } from '../correlation-env.js';
import {
  frameCarriesRefusal,
  isAbortShaped,
  judgeStructuredOutput,
  refusalNarrationMarker,
  resultStatusOf,
  signalAborted,
  stopReasonOf,
  HARNESS_ERROR_PREFIX,
  STRUCTURED_OUTPUT_TOOL,
} from './verdict.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** The optional peer this transport loads lazily — never statically imported. */
export const SDK_MODULE_SPECIFIER = '@anthropic-ai/claude-agent-sdk';

/** SDK MCP server name under which the harness tool surface is registered (the shared core's name). */
export const MCP_SERVER_NAME = HARNESS_MCP_SERVER_NAME;

/**
 * One MCP tool-call result (the subset of the SDK's CallToolResult this
 * transport produces): the denial/success text the model sees, plus the error
 * marker that makes a harness denial legible to the agent as a refusal.
 */
export interface SdkToolCallResult {
  content?: ReadonlyArray<{ type?: unknown; text?: unknown }>;
  isError?: unknown;
}

/**
 * The MINIMAL structural surface this transport drives on the loaded SDK
 * module (feature-detected at load). Deliberately plain — zero vendor
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

/** SDK-transport constructor options (a subset of ClaudeCodeDriverOptions). */
export interface SdkTransportOptions {
  /** SDK module loader override. Default: the lazy dynamic import. */
  sdkLoader?: SdkLoader;
  /** Routing table override (default: defaultRoutingTable). */
  routingTable?: RoutingTable;
  /** Harness config (tool surface + prompt budget). Default: defaultHarnessConfig. */
  harnessConfig?: HarnessConfig;
  /** Sessions directory for the backing SessionStore. Default: the shared durable sessions dir (`defaultSessionsDir()` — item 1.1). */
  sessionsDir?: string;
  /** Additional host env names exposed to the SDK child and harness run commands. */
  envAllowlist?: readonly string[];
  /** Price-lookup override for the derived-only costUSD rule. */
  pricing?: (modelSpec: ModelSpec) => PerMillionRates | undefined;
}

/**
 * The SDK transport on the frozen Driver seam. One instance caches ONLY the
 * loaded SDK module (lazily, once); all per-run state (session record,
 * observation, denials) lives in the run call — a single instance can serve
 * many isolated invocations.
 */
export class ClaudeCodeSdkTransport implements Driver {
  private readonly sdkLoader: SdkLoader;
  private readonly routingTable: RoutingTable;
  private readonly harnessConfig: HarnessConfig;
  private readonly sessionsDir: string | undefined;
  private readonly envAllowlist: readonly string[] | undefined;
  private readonly pricingOverride:
    | ((modelSpec: ModelSpec) => PerMillionRates | undefined)
    | undefined;
  /** Memoized load — one feature-detect per transport instance, never per run. */
  private sdkModule: Promise<AgentSdkModule> | undefined;

  constructor(options: SdkTransportOptions = {}) {
    if (options.envAllowlist?.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
      throw new Error('claude-code driver: envAllowlist entries must be valid env var names');
    }
    this.envAllowlist =
      options.envAllowlist === undefined ? undefined : Object.freeze([...options.envAllowlist]);
    this.sdkLoader = options.sdkLoader ?? defaultSdkLoader;
    // An invalid table throws HERE (construction is the closest thing to
    // compile time a data table has) — never silently at route time.
    this.routingTable = RoutingTableSchema.parse(options.routingTable ?? defaultRoutingTable());
    this.harnessConfig = options.harnessConfig ?? defaultHarnessConfig;
    this.sessionsDir = options.sessionsDir;
    this.pricingOverride = options.pricing;
  }

  /** The frozen seam (v2): run one invocation to completion. */
  async run(opInvocation: OpInvocation, options?: RunOptions): Promise<WorkerResult> {
    const { prompt, modelSpec, toolPolicy, sandboxPolicy, sessionRef, budget } = opInvocation;

    // --- Governed cancellation + strict-budget honesty, ENTRY checks (I8):
    // the run signal is read ONCE here. An already-cancelled invocation never
    // reaches transport-specific setup (route/key/`loadSdk`/workspace), and a
    // `Budget.strictTokenBudget` request is refused before it either.
    // Cancellation outranks the strict refusal.
    const signal = options?.signal;
    if (signalAborted(signal)) {
      return { usage: zeroUsage(), denials: [], stopReason: 'aborted' };
    }
    assertStrictTokenBudgetSupported(opInvocation.budget, 'claude-code');

    // --- Pre-dispatch validation: everything here throws BEFORE the agent
    // is contacted and BEFORE any session/workspace exists (fail loudly, no
    // partial state). Provider first (pure), then the peer, then budget,
    // then the workspace binding.
    const route = resolveRoute(modelSpec, this.routingTable); // unknown provider → the throw
    const keyValue = readKeyEnvOrThrow(route); // missing key env → throw
    const sdk = await this.loadSdk(); // peer absent / misshaped → throw
    if (
      budget.maxTokens !== undefined &&
      (!Number.isFinite(budget.maxTokens) || budget.maxTokens <= 0)
    ) {
      throw new Error(
        `claude-code driver: budget.maxTokens must be a finite number > 0, got ${String(budget.maxTokens)}`,
      );
    }
    if (
      budget.maxSteps !== undefined &&
      (!Number.isInteger(budget.maxSteps) || budget.maxSteps <= 0)
    ) {
      throw new Error(
        `claude-code driver: budget.maxSteps must be a positive integer, got ${String(budget.maxSteps)}`,
      );
    }
    // Workspace binding (ADR-0002 §2.4): validated + realpathed BEFORE any
    // session state exists — a bad binding is a pre-dispatch config throw.
    const boundWorkspace =
      opInvocation.workspace === undefined
        ? undefined
        : boundWorkspacePath(opInvocation.workspace, 'claude-code driver');

    // --- Governed-cancellation LATE recheck (I8): the signal was read at
    // entry; recheck the SAME live RunOptions.signal after the setup
    // (which AWAITS `loadSdk`), so an abort that fired during setup never
    // dispatches and never creates a session record. The strict refusal
    // already ran at entry (no duplicate here).
    if (signalAborted(signal)) {
      return { usage: zeroUsage(), denials: [], stopReason: 'aborted' };
    }

    // --- Structured-output preflight (PR #238 review round 2): the schema
    // document is caller-authored plain data — compile it BEFORE the agent
    // is contacted. An uncompilable document is the uniform LOCAL
    // 'output-invalid' verdict (the settle-time miss shape), never a
    // provider/harness failure from a request-setup rejection. No record
    // exists yet (none is created): zero usage, no denials, no sessionId.
    if (opInvocation.outputSchema !== undefined) {
      const compiled = compileOutputSchema(opInvocation.outputSchema);
      if ('fault' in compiled) {
        return uncompilableSchemaVerdict('claude-code', compiled.fault);
      }
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
        : await resumedRecordOrThrow(store, sessionRef, boundWorkspace, 'claude-code driver');
    const workspace = record.workspace;

    await store.appendMessage(record.sessionId, { role: 'user', content: prompt, at: nowIso() });

    // --- Tool surface: the SHARED CORE (src/harness/surface.ts) — the one
    // manifest constructor binds the workspace realpath, the sandbox level,
    // harness ∩ per-op ToolPolicy and the harness config; the bound surface
    // is registered as the SDK's in-process custom tools. The CLI transport
    // serves the SAME core over stdio (two-level parity test). An empty
    // selection yields no manifest and no server. Built-ins are disabled
    // wholesale (the governed surface is the WHOLE surface, header).
    const manifest = await buildManifest({
      workspace,
      sandbox: sandboxPolicy.level,
      toolPolicy,
      harness: this.harnessConfig,
      envNames: this.envAllowlist,
    });
    const surface = manifest === undefined ? undefined : createHarnessSurface(manifest);
    const allowed = manifest?.tools ?? [];

    // --- Agent-level resume: the substrate session id recorded in the
    // SESSIONS STORE sidecar by a prior run (absent → workspace-only
    // continuation).
    const resumeAgentSessionId = await readCliSessionId(sessionsDir, record.sessionId);

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
      // The SDK lane registers the one-release aliases as real tools, so its
      // init surface lists them; the CLI lane's MCP server advertises only
      // canonical names and keeps the unexpanded list.
      tools: allowed.flatMap((name) => [name, ...toolAliases(name)]),
      internalTools: outputSchema === undefined ? [] : [STRUCTURED_OUTPUT_TOOL],
    };

    // --- The one SDK call: options assembly. ------------------------------
    const sandbox = sandboxOption(sandboxPolicy.level);
    const sdkTools = (surface?.tools ?? []).flatMap((harnessTool) =>
      [harnessTool.name, ...toolAliases(harnessTool.name)].map((name) =>
        sdk.tool(
          name,
          harnessTool.description,
          // The zod raw shape — the SDK's declared-input form. Deliberately
          // the NON-strict shape (what the model sees as the tool's schema):
          // the SDK pre-validates it, so a type-invalid call never reaches the
          // core and extra keys are stripped — the parity test's one scoped
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
      ),
    );
    // The SDK query's option object — named apart from the seam's
    // `RunOptions` parameter (the cancellation SIGNAL lives there; this is
    // the assembled query surface).
    const queryOptions: Record<string, unknown> = {
      ...(budget.maxSteps !== undefined ? { maxTurns: budget.maxSteps } : {}),
      // The model rides UNCHECKED (owner override 2026-09-14, header): any
      // id the endpoint can reach is permitted; the OBSERVED id is the
      // defence (WorkerResult.model).
      model: modelSpec.model,
      cwd: workspace,
      // Built-ins OFF — the only tools the agent can touch are the ones the
      // frozen policy pre-approved below (header's governed-surface rule).
      tools: [],
      allowedTools: allowed.flatMap((name) => [name, ...toolAliases(name)]).map(qualifiedToolName),
      // Headless posture: un-pre-approved tools are auto-DENIED, never
      // prompted; the denials map into WorkerResult.denials post-settle.
      permissionMode: 'default',
      // CLOSED SURFACE (W1.4 live leg A.5j): without these two, subscription
      // auth attaches the account's claude.ai connectors (dozens of extra
      // tools — mail, drive, calendar) to the worker's surface; with them the
      // init frame lists exactly the harness tools (+ StructuredOutput), on
      // API-key and subscription auth alike. Ambient workspace settings
      // (`.claude/settings.json`, `.mcp.json`) are structurally excluded.
      settingSources: [],
      strictMcpConfig: true,
      // The SDK child receives only allowlisted host names plus its route
      // credentials. Harness run children receive the manifest's allowlist
      // without these SDK-only credential overrides.
      // Session-log correlation (items 1.3–1.5): the invocation's work
      // identity rides the child env, as on the CLI transport.
      env: applyCorrelationEnv(
        buildChildEnv(
          process.env,
          {
            ANTHROPIC_BASE_URL: route.baseUrl,
            ANTHROPIC_AUTH_TOKEN: keyValue,
            ANTHROPIC_API_KEY: keyValue,
          },
          this.envAllowlist,
        ),
        opInvocation.correlation,
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
              // judgment is the shared judge over the SAME document.
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
        observation.error = `claude-code driver: query failed — ${describeError(err)}`;
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

    // --- Usage accounting (usage.ts: the ONE fold) + its provenance.
    recordUsageProvenance(observation, resumeAgentSessionId !== undefined);

    // --- Structured output (ADR-0002 §2.3, S3): the ONE shared judge
    // (refusal-voided — verdict.ts) over the SAME document that was sent. A
    // miss after the SDK's NATIVE outputFormat retry settles the uniform
    // error/'output-invalid' verdict (usage and cost kept, rejection in the
    // bounded error text). A result frame that failed for its own reason is
    // not a model-output outcome: the §2.2 classifier names it, and its
    // payload (if any) never reaches the seam.
    let structured: unknown;
    let structuredMiss: string | undefined;
    if (
      outputSchema !== undefined &&
      !aborted &&
      observation.harnessFailure === undefined &&
      observation.result !== undefined
    ) {
      const judged = judgeStructuredOutput(
        outputSchema,
        observation.result,
        observation.refusalSeen,
      );
      structured = judged.structured;
      structuredMiss = judged.miss;
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
      observation.error = `claude-code driver: SDK result status error — ${cause}`;
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
          `claude-code driver: the optional peer dependency '${SDK_MODULE_SPECIFIER}' is not installed — ` +
            'install it to use the sdk transport (npm install --save-optional @anthropic-ai/claude-agent-sdk; ' +
            'see src/driver/README.md). Refusing pre-dispatch, before any session exists. ' +
            `(${describeError(err)})`,
        );
      }
      return asAgentSdkModule(loaded);
    })();
    return this.sdkModule;
  }

  /**
   * Fold the observation into the frozen WorkerResult (header tables:
   * stop reasons, usage, cost). A real measurement (the shared fold:
   * modelUsage aggregates, else the flat result usage, else the
   * assistant-usage fallback) is kept on any verdict that observed it;
   * unmeasured verdicts (dispatch failure, abort before any frame) report
   * zeros and NEVER a cost.
   *
   * ERROR CLASSES (seam v2, ADR-0002 §2.2): every 'error' verdict carries
   * `errorClass`, from the ONE shared classifier (failures.ts). Abort and
   * budget carve-outs carry no class: the missing object is their
   * consequence, not their cause.
   */
  private verdict(
    modelSpec: ModelSpec,
    budget: OpInvocation['budget'],
    observation: SdkRunObservation,
    sessionId: string,
    aborted: boolean,
    structured: unknown,
    structuredMiss: string | undefined,
    resultCause: string | undefined,
  ): WorkerResult {
    const measuredFrame = measureResultUsage(observation.result);
    const measured = measuredFrame !== undefined ? measuredFrame.usage : undefined;
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
    let providerSignals: ReturnType<typeof classifyFailure>['providerSignals'];
    if (effectiveStopReason === 'error') {
      if (observation.harnessFailure !== undefined) {
        // Fail-closed surface assertions are always 'harness'.
        errorClass = 'harness';
      } else if (structuredMiss !== undefined) {
        error = `claude-code driver: structured output invalid — ${structuredMiss}`;
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
        'claude-code driver: the SDK query ended without a result event (the SDK surfaced no error text)';
    }
    // Derived-only cost (DD-2): only on a verdict carrying a REAL usage
    // measurement — never on an unmeasured abort/dispatch-failure verdict.
    // Price the model that was actually SERVED when one was observed (the
    // remap evidence is real); the requested ModelSpec.model is the
    // fallback when nothing was observed.
    const pricedModel: ModelSpec =
      observation.servedModel !== undefined
        ? { ...modelSpec, model: observation.servedModel }
        : modelSpec;
    const cost =
      measured === undefined && observation.assistantUsage === undefined
        ? {}
        : costField(
            (spec, fold) => computeDerivedCost(this.pricingOverride, spec, fold),
            pricedModel,
            usage,
          );
    return {
      // The observed served model: what the agent reported it served, not
      // what ModelSpec.model requested (the remap-detection fact, header).
      ...(observation.servedModel !== undefined ? { model: observation.servedModel } : {}),
      // The payload rides a COMPLETE verdict only (parity with the ai-sdk
      // lane): the served-model wrapper judges only completes, so a payload
      // on a budget/aborted verdict would bypass the observed-model check.
      ...(effectiveStopReason === 'complete' && structured !== undefined
        ? { structuredOutput: structured }
        : {}),
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
}

// ---------------------------------------------------------------------------
// Module-level helpers — pure, exported only where the tests need them
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp for session messages. */
function nowIso(): string {
  return new Date().toISOString();
}

// The shared default (item 1.1): one helper, durable XDG state location.
// (Imported above; re-exported so existing importers keep their path.)
export { defaultSessionsDir };

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
 * exactly the surface this transport drives. NEVER a version check — a
 * module with the same functions is accepted whatever it calls its version.
 */
function asAgentSdkModule(loaded: unknown): AgentSdkModule {
  const rec = asRecord(loaded);
  if (rec === undefined) {
    // Pre-dispatch misconfiguration carries its class as structured data
    // (ADR-0002 §2.2): errorClassOf → 'config'.
    throw new DispatchError(
      'config',
      `claude-code driver: the loaded '${SDK_MODULE_SPECIFIER}' module is not an object — ` +
        'not the agent SDK surface this transport drives',
    );
  }
  const missing = ['query', 'tool', 'createSdkMcpServer'].filter(
    (name) => typeof rec[name] !== 'function',
  );
  if (missing.length > 0) {
    throw new DispatchError(
      'config',
      `claude-code driver: the loaded '${SDK_MODULE_SPECIFIER}' module is missing the driven surface ` +
        `(${missing.join(', ')}) — capability detection is feature-based, never version-based`,
    );
  }
  return rec as unknown as AgentSdkModule;
}

/** The resolved route's key VALUE, read from the host env AT RUN TIME. */
function readKeyEnvOrThrow(route: { endpoint: string; keyEnv: string }): string {
  const value = process.env[route.keyEnv];
  if (value === undefined || value === '') {
    // Pre-dispatch misconfiguration carries its class as structured data
    // (ADR-0002 §2.2): errorClassOf → 'config'.
    throw new DispatchError(
      'config',
      `claude-code driver: endpoint '${route.endpoint}' requires ${route.keyEnv} in the environment`,
    );
  }
  return value;
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
 * server returns on the CLI transport. Here the transport adds its
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

// ---------------------------------------------------------------------------
// Message-stream observation — defensive folding of the SDK stream
// ---------------------------------------------------------------------------

/** Per-run observation state folded from the query's message stream. */
export interface SdkRunObservation {
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
  /**
   * True once any frame carried the substrate's structured refusal stop
   * reason (the D-E′ refusal void — verdict.ts).
   */
  refusalSeen: boolean;
}

function newObservation(): SdkRunObservation {
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
    refusalSeen: false,
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

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Record the run's usage provenance + resume semantics markers (usage.ts):
 * a marker only when the fold came from a NON-DEFAULT channel (per-model
 * aggregates vs assistant fallback — absence means the result channel),
 * and — on a resumed session — the version-gated per-call/cumulative
 * boundary note.
 */
function recordUsageProvenance(observation: SdkRunObservation, resumed: boolean): void {
  const measured = measureResultUsage(observation.result);
  const provenance =
    measured !== undefined
      ? usageProvenanceMarker(measured)
      : observation.assistantUsage !== undefined
        ? usageProvenanceMarker({ usage: observation.assistantUsage, channel: 'assistant' })
        : undefined;
  if (provenance !== undefined) observation.narration.push(provenance);
  if (resumed && (measured !== undefined || observation.assistantUsage !== undefined)) {
    observation.narration.push(resumedUsageSemanticsMarker());
  }
}

/**
 * Fold ONE stream frame into the observation (header mapping table). An
 * unshapeable frame or an unknown type becomes narration — the stream's
 * junk is evidence, never a crash.
 */
export function foldMessage(observation: SdkRunObservation, message: unknown): void {
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
        if (frameCarriesRefusal(event) && !observation.refusalSeen) {
          observation.refusalSeen = true;
          observation.narration.push(refusalNarrationMarker());
        }
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
      // The refusal stop reason rides the inner Anthropic Messages API
      // Message shape (`message.stop_reason`) — the D-E′ refusal void's
      // SDK-transport observation point.
      if (frameCarriesRefusal(inner) && !observation.refusalSeen) {
        observation.refusalSeen = true;
        observation.narration.push(refusalNarrationMarker());
      }
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
      const usage = usageFromWire(inner['usage']);
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
      //   - tool_result-only content (or empty / unshapeable) is DROPPED,
      //     exactly like assistant tool_use blocks: the harness surface
      //     executes in-process, so each outcome is already recorded at the
      //     execute boundary in OUR vocabulary, and SDK-side refusals arrive
      //     on the result's permission_denials (the authoritative record).
      //     Folding these to narration would duplicate the tool outcome AND
      //     put a raw vendor frame shape into persisted session data.
      //   - a frame carrying a TEXT block is NARRATED (evidence): the
      //     normal flow never emits one — the prompt rides query()'s
      //     argument and tool results ride tool_result frames — so a
      //     text-bearing user frame is exactly the kind of unusual thing
      //     narration exists to preserve. Never silently dropped.
      const inner = asRecord(event['message']);
      const content = inner === undefined ? undefined : asArray(inner['content']);
      if (content === undefined) return; // unshapeable — dropped
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
      // The result frame can carry the refusal stop reason too — observe it
      // wherever the substrate states it (the void is channel-agnostic).
      if (frameCarriesRefusal(event) && !observation.refusalSeen) {
        observation.refusalSeen = true;
        observation.narration.push(refusalNarrationMarker());
      }
      return;
    }
    default:
      observation.narration.push(JSON.stringify(event));
  }
}

/** The result's permission_denials → frozen denials (deduped per tool_use id). */
function mapPermissionDenials(observation: SdkRunObservation): void {
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
 * Post-settle persistence (OUR vocabulary): the substrate-session sidecar
 * (when newly observed — the NEXT run's resume handle), the assistant
 * transcript (when any), and narration (when any). Never fabricates an
 * assistant turn: a run that produced no text records none.
 */
async function persistObservation(
  store: SessionStore,
  record: SessionRecord,
  observation: SdkRunObservation,
  resumeAgentSessionId: string | undefined,
): Promise<void> {
  await writeCliSessionId(store, record, observation.agentSessionId, resumeAgentSessionId);
  const text = observation.transcript.join('\n\n');
  if (text !== '') {
    await store.appendMessage(record.sessionId, { role: 'assistant', content: text, at: nowIso() });
  }
  if (observation.narration.length > 0) {
    const message: SessionMessage = {
      role: 'tool',
      toolName: SDK_NARRATION_TOOL,
      content: JSON.stringify(observation.narration.map(redactSensitiveText)),
      at: nowIso(),
    };
    await store.appendMessage(record.sessionId, message);
  }
}
