// The Claude Code lane's CLI transport — Phase 1.9 (the consolidation of
// the former subprocess driver, T1.5 slice 1): run the `claude` CLI headless
// on the FROZEN Driver seam (run(opInvocation) → Promise<WorkerResult>).
// This is the lane's PRIMARY substrate path (D-E′ option A: one cq-owned
// Claude Code lane, CLI primary, Agent SDK optional — sdk.ts).
//
// EXECUTION MODEL: out-of-process. Each invocation spawns ONE headless CLI
// run (`claude -p …` by default — see the argv table below) in the
// invocation's workspace, parses its stream-json stdout, and folds the
// events into our seam vocabulary. No daemon, no pooling, no reuse.
//
// I8 SEAM — the driver owns NO wall clock. The run's ONLY cancellation
// SOURCE is `RunOptions.signal` (seam v2, ADR-0002 §2.1) — the caller
// passes the governed rung-1 signal explicitly. The signal is forwarded
// EXACTLY ONE place: the SIGTERM→SIGKILL grace ladder in shared/proc.ts
// (migration 1.1), where the ladder executes an
// already-decided kill). An already-aborted signal never dispatches and
// creates NO session state. Consequences, documented:
//   - Budget.wallClockMs is IGNORED — the governor's ladder owns wall
//     clock; a driver-owned deadline would duplicate and race it.
//   - No retries, ever: exactly ONE spawn per run (attempts are the
//     runner/governor's business — a retry here would hide attempts).
//
// ROUTING (./routing.ts): ModelSpec → env-based route over the shared
// RoutingTable. The endpoint is injected purely through env
// (ANTHROPIC_BASE_URL + auth-token vars); the model rides `--model`
// UNCHECKED — the DEEPSEEK SILENT-REMAP FOOTGUN is defended POST-DISPATCH
// (§2.6 allowlist retirement): the transport surfaces the model id the CLI
// reports as served, and the shared served-model assertion fails a
// mismatching run. Key VALUES are read from the environment at run() time;
// a missing one throws pre-dispatch. Routes carry var NAMES only.
//
// ARGV (the reference headless surface, built by `buildArgs`):
//   -p                          headless print mode; the PROMPT rides stdin
//                               (no argv-length ceiling on caller data)
//   --output-format stream-json newline-delimited JSON events on stdout
//   --verbose                   REQUIRED by the real CLI with `-p
//                               --output-format stream-json` (print mode
//                               rejects stream-json without it — found live,
//                               CLI 2.1.270, T1.6 slice 4; a no-op for CLIs
//                               that don't know the flag)
//   --json-schema <json>        only when the invocation carries
//                               `outputSchema`
//   --tools ""                  harness mode (default): every CLI builtin
//                               is REMOVED from the surface (absent, not
//                               denied — RS-1/RS-1b b1/b5)
//   --setting-sources ""        harness mode: no ambient HOME/project
//                               settings (canary allow rules stay inert)
//   --strict-mcp-config         harness mode: no ambient MCP servers
//   --mcp-config <file>         harness mode, non-empty selection only: the
//                               per-run config launching `cq-harness-mcp`
//                               (`<sessionsDir>/<sessionId>.<run-uuid>.cq-
//                               harness-mcp.json` — unique per run; O_EXCL +
//                               0600, an existing file is a hard error;
//                               deleted once init reports the server
//                               connected, again at settle)
//   --allowedTools <names>      ALWAYS present, ONE argv element,
//                               SPACE-joined (comma-joining silently
//                               pre-approves only the first entry — RS-1b
//                               b9/b10): harness mode → the QUALIFIED
//                               spellings `mcp__cq-harness__<name>` of the
//                               selected surface (harness ∩ ToolPolicy:
//                               'allowlist' → allow ∩ harness,
//                               'unrestricted' → all, 'none' → empty).
//                               MCP tools are never auto-approved, so this
//                               list is load-bearing (RS-1b b6); name
//                               matching is byte-exact (b3). Headless -p
//                               mode CANNOT PROMPT: a call outside the list
//                               is DENIED (never prompted, never hung). NO
//                               UNDOCUMENTED FLAGS (issue #19).
//   --model <route.model>       the routed model id (routed verbatim — the
//                               pre-dispatch model allowlist is retired, §2.6)
//   --resume <cli-session-id>   only on sessionRef resume, when the record
//                               carries a CLI session marker (sessions.ts)
//
// CLOSED TOOL SURFACE (W1.4 — RS-12 design, ADR-0002 Annex A.4). The
// harness executors run on this transport too: the CLI's only tools are the
// harness's, served over stdio by `cq-harness-mcp` (src/harness/mcp/) —
// the SAME shared core (src/harness/surface.ts) the SDK transport serves
// in-process. The transport authors the manifest (workspace realpath,
// sandbox, selection, harness config, env names); the server re-validates
// it, scrubs its env to the default child-env allowlist + envAllowlist names
// (route credentials never reach `run` children's env), and enforces
// containment, allowlists and the read-only mapping. Fail-closed on three
// fronts, each settling stopReason 'error' with a `HARNESS_ERROR_PREFIX`
// cause and an `errorClass: 'harness'` narration marker (ADR-0002 §2.2):
//   - the FIRST system/init must report exactly the expected surface —
//     `cq-harness`/connected (or no server) and exactly the qualified
//     selected tools, plus `StructuredOutput` under --json-schema (pinned
//     by the live leg) — else the ladder terminates the run
//     ('harness-surface-mismatch'); a run whose result arrives with no init
//     at all is 'harness-surface-unverified';
//   - an is_error result on a harness tool is a DENIAL only when its text
//     carries a stable harness denial prefix, or the CLI reported a
//     permission denial for it; anything else (a dead server's
//     'Connection closed', an MCP timeout, …) is a transport failure that
//     terminates the run ('harness-transport-failure').
// Tool names are mapped back to harness names in records and denials.
//
// STOCK MODE (plan D6 — null-hypothesis evals only): `toolSurface:
// 'stock'` keeps the legacy argv (no --tools/--setting-sources/MCP flags;
// harness NAMES in --allowedTools, which the CLI does not know — inert,
// RS-1 J2 C1) and none of the harness enforcement. An option of the
// directly constructed driver only — never a factory or plan key. Stock
// mode remains EVAL-ONLY and is not admissible in production.
//
// TRUST STATEMENT (issue #28's CLI half). Harness mode: the harness
// enforces the TOOL-level sandbox mapping (read-only denials, workspace
// containment, allowlists); OS confinement stays unenforced, so a
// requested level with a non-empty surface records `{cq:
// 'sandbox-level-unenforced', level, layer: 'os'}`. `run` commands keep
// HOST privileges (the harness trust boundary, tools.ts). Stock mode: the
// CLI's own permission model governs; the legacy `sandbox-level-
// unenforced` marker (no layer) records that nothing was enforced here.
//
// SESSIONS (I6, OUR vocabulary — src/harness/session.ts + ./sessions.ts):
//   - NO sessionRef → tempWorkspace() + SessionStore.create(): a fresh
//     scratch dir and a fresh record; the CLI runs with cwd = workspace.
//     When the invocation carries a `workspace` binding (ADR-0002 §2.4),
//     the fresh record is instead created IN realpath(workspace.path) and
//     the CLI + harness manifest bind there; a workspace set alongside a
//     sessionRef must record the SAME realpath (else a pre-dispatch config
//     throw). Session records and sidecars stay in the lane's sessionsDir —
//     never inside the workspace.
//   - sessionRef → SessionStore.load (unknown → THROW pre-dispatch: a fake
//     resume is worse than a loud one); the SAME workspace continues, and
//     `--resume` continues the CLI-side conversation using the substrate
//     session id recorded in the SESSIONS-STORE sidecar (sessions.ts). A
//     session without a sidecar (prior run died before the CLI reported a
//     session) resumes the WORKSPACE only: no --resume flag, an honest
//     partial continuation. BOTH transports share the sidecar, so a record
//     created by the SDK transport resumes honestly here and vice versa.
//   - Persisted per run, post-settle: the user prompt, ONE role 'tool'
//     message PER IN-POLICY CLI TOOL EXECUTION (toolName = the harness name
//     — `mcp__cq-harness__read` is recorded as `read`; stock mode: the CLI
//     tool name; content = { input, ok, output } in plain-JSON
//     our-vocabulary), the assistant transcript text (when any), and
//     non-JSON stdout lines + stderr as narration (toolName
//     'cli-narration'). OUT-OF-POLICY tool activity is narration-only: the
//     record reflects the governed tool surface (what --allowedTools
//     pre-approved), never a tool the policy withheld.
//
// EVENT → SEAM MAPPING (stream-json, parsed defensively — a non-JSON line
// or unknown event shape becomes narration, never a crash):
//   {type:'system', subtype:'init', session_id}  → CLI session id (marker)
//   {type:'system', subtype:'init', model}       → servedModel → WorkerResult.model
//   {type:'assistant', message:{content:[…], usage, stop_reason}} → text
//                              blocks → transcript; tool_use blocks
//                              remembered by id → tool names; usage folded
//                              (fallback usage); stop_reason 'refusal'
//                              observed (the D-E′ refusal void)
//   {type:'user', message:{content:[{type:'tool_result', tool_use_id,
//                              is_error, content}]}}  → tool activity
//                              (in-policy tools become role 'tool' record
//                              messages); an is_error one is additionally
//                              a permission/execution DENIAL {tool, reason}
//                              (frozen ToolDenial shape), deduped per
//                              tool_use id
//   {type:'result', subtype, is_error, session_id, usage | modelUsage,
//                              stop_reason, structured_output}  → the
//                              shared accounting fold (usage.ts: per-model
//                              aggregates preferred — subagent spend
//                              included); structuredOutput (when
//                              --json-schema, refusal-voided); the
//                              terminal status
//   {type:'result', model}      → servedModel → WorkerResult.model (init
//                              first; the result event may overwrite/confirm)
//   anything else               → narration (collected, persisted)
//
// Once spawned, run() NEVER throws: every failure lands in an honest
// 'error' verdict carrying the sessionId + denials gathered so far — and a
// SYNCHRONOUS SPAWN FAILURE is a verdict too (issue #19). A spawn failure
// reports zero usage (nothing was measured); an 'error' verdict from a real
// result event KEEPS the CLI-reported usage (real evidence). Every 'error'
// verdict also POPULATES WorkerResult.error (bounded + secret-redacted,
// issue #208). Only PRE-DISPATCH validation throws.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultSessionsDir } from '../sessions-dir.js';
import { applyCorrelationEnv, correlationEnvRemovals } from '../correlation-env.js';
import { rm, writeFile } from 'node:fs/promises';
import { defaultHarnessConfig } from '../../harness/config.js';
import type { HarnessConfig } from '../../harness/config.js';
import { buildTools, canonicalToolName, toolAliases } from '../../harness/tools.js';
import {
  buildManifest,
  compareInitSurface,
  harnessToolName,
  isHarnessDenial,
  isQualifiedHarnessTool,
  qualifiedToolName,
  selectToolNames,
} from '../../harness/surface.js';
import type { ExpectedInitSurface, HarnessManifest } from '../../harness/surface.js';
import { HARNESS_MCP_SERVER_NAME } from '../../harness/surface.js';
import { harnessServerLaunch } from '../../harness/mcp/launch.js';
import { SessionStore, tempWorkspace } from '../../harness/session.js';
import type { SessionMessage, SessionRecord } from '../../harness/session.js';
import { stripMetaSchema } from '../../shared/json-schema.js';
import { boundedErrorText, describeError, redactSensitiveText } from '../error-text.js';
import { DispatchError } from '../errors.js';
import { assertStrictTokenBudgetSupported } from '../common/strict-budget.js';
import { boundWorkspacePath, resumedRecordOrThrow } from '../common/workspace.js';
import { compileOutputSchema, uncompilableSchemaVerdict } from '../common/structured.js';
import type {
  Driver,
  ModelSpec,
  OpInvocation,
  ProviderSignals,
  RunOptions,
  ToolDenial,
  ToolPolicy,
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
import type { MeasuredUsage } from './usage.js';
import { classifyFailure, isCodexBinary } from './failures.js';
import { RoutingTableSchema, defaultRoutingTable, resolveRoute, authEnvPlan } from './routing.js';
import type { Route, RoutingTable } from './routing.js';
import { spawnManaged, terminateGracefully } from '../../shared/proc.js';
import type {
  ManagedChild,
  ProcessClose,
  SpawnOptions,
  TerminationRungMarker,
} from '../../shared/proc.js';
import { readCliSessionId, writeCliSessionId, CLI_NARRATION_TOOL } from './sessions.js';
import {
  frameCarriesRefusal,
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

/**
 * The file-name SUFFIX of the per-run MCP config (W1.4, Annex A.4):
 * `<sessionsDir>/<sessionId>.<run-uuid>.cq-harness-mcp.json` — UNIQUE PER
 * RUN, so two concurrent runs on one session can never read, replace or
 * delete each other's binding — created exclusively (O_EXCL) with mode
 * 0600, never in the model-visible workspace (tamper vector #26), and
 * deleted as soon as `system/init` reports the harness connected, with a
 * second delete at settle as the backstop.
 */
export const HARNESS_MCP_CONFIG_FILE = '.cq-harness-mcp.json';

/**
 * The spawn seam: `spawnManaged` by default; tests inject a fake (the
 * conformance suite's scripted CLI) through the driver's `spawn` option.
 */
export type SpawnFn = (opts: SpawnOptions) => ManagedChild;

/** CLI-transport constructor options (a subset of ClaudeCodeDriverOptions). */
export interface CliTransportOptions {
  /** The CLI to spawn: a bare command/path, or a full leading-argv template. Default 'claude'. */
  binary?: string | readonly string[];
  /** Routing table override (default: defaultRoutingTable — as-of 2026-09 provider docs). */
  routingTable?: RoutingTable;
  /** SIGTERM→SIGKILL grace in ms (default: process.ts's DEFAULT_TERM_GRACE_MS). */
  termGraceMs?: number;
  /** SIGKILL→force-resolve grace in ms (default: process.ts's DEFAULT_KILL_GRACE_MS). */
  killGraceMs?: number;
  /** Sessions directory for the backing SessionStore. Default: the shared durable sessions dir (`defaultSessionsDir()` — item 1.1). */
  sessionsDir?: string;
  /** Harness config — the tool surface mapped onto --allowedTools + the temp-workspace root. Default: defaultHarnessConfig. */
  harnessConfig?: HarnessConfig;
  /** Price-lookup override for the derived-only costUSD rule. */
  pricing?: (modelSpec: ModelSpec) => PerMillionRates | undefined;
  /**
   * Extra parent-env NAMES copied into every spawned CLI worker on top of
   * the default-deny allowlist (issue #183). Names only, never values.
   */
  envAllowlist?: readonly string[];
  /**
   * The tool surface: 'harness' (default, the closed surface) or 'stock'
   * (null-hypothesis evals only, direct construction only).
   */
  toolSurface?: 'harness' | 'stock';
  /** Spawn override hook for tests. Default: the real spawnManaged. */
  spawn?: SpawnFn;
}

/** The tool surface the CLI transport runs with (see CliTransportOptions). */
export type CliToolSurface = NonNullable<CliTransportOptions['toolSurface']>;

/**
 * The CLI transport on the frozen Driver seam. One instance is stateless
 * across runs — all per-run state (session record, event observation,
 * denials) lives in the run call — so a single instance can serve many
 * isolated invocations.
 */
export class ClaudeCodeCliTransport implements Driver {
  private readonly binary: readonly string[];
  private readonly routingTable: RoutingTable;
  private readonly termGraceMs: number | undefined;
  private readonly killGraceMs: number | undefined;
  private readonly sessionsDir: string | undefined;
  private readonly harnessConfig: HarnessConfig;
  private readonly pricingOverride:
    | ((modelSpec: ModelSpec) => PerMillionRates | undefined)
    | undefined;
  private readonly envAllowlist: readonly string[] | undefined;
  private readonly toolSurface: CliToolSurface;
  private readonly spawnImpl: SpawnFn;

  constructor(options: CliTransportOptions = {}) {
    this.binary =
      typeof options.binary === 'string' ? [options.binary] : (options.binary ?? ['claude']);
    // An empty binary template cannot spawn anything — invalid argv would
    // only explode at spawn time (post-dispatch). Validate HERE, loudly.
    if (this.binary.length === 0 || this.binary.some((part) => part === '')) {
      throw new Error(
        `claude-code driver: binary must be a non-empty string or a non-empty array of non-empty strings, got ${JSON.stringify(options.binary)}`,
      );
    }
    // An env-allowlist entry is a NAME copied from the parent env; a name
    // that is not a well-formed env var identifier (empty, '='-bearing,
    // whitespace/NUL) would silently do nothing or explode at spawn (issue
    // #183 r1/r2). Validate HERE, loudly, like the binary template.
    if (
      options.envAllowlist !== undefined &&
      options.envAllowlist.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    ) {
      throw new Error(
        `claude-code driver: envAllowlist entries must be env var names matching /^[A-Za-z_][A-Za-z0-9_]*$/, got ${JSON.stringify(options.envAllowlist)}`,
      );
    }
    // An invalid table throws HERE (construction is the closest thing to
    // compile time a data table has) — never silently at route time.
    this.routingTable = RoutingTableSchema.parse(options.routingTable ?? defaultRoutingTable());
    // The grace windows are the I8-exempt ladder's execution inputs: a
    // negative/NaN/Infinity grace would collapse to an immediate SIGKILL.
    // Validate HERE, loudly (issue #19).
    for (const [name, value] of [
      ['termGraceMs', options.termGraceMs],
      ['killGraceMs', options.killGraceMs],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        throw new Error(
          `claude-code driver: ${name} must be an integer >= 0, got ${String(value)}`,
        );
      }
    }
    this.termGraceMs = options.termGraceMs;
    this.killGraceMs = options.killGraceMs;
    this.sessionsDir = options.sessionsDir;
    this.harnessConfig = options.harnessConfig ?? defaultHarnessConfig;
    this.pricingOverride = options.pricing;
    // Frozen COPY (issue #183 r2): the default allowlist is frozen for the
    // same reason — a caller mutating its array after construction must not
    // weaken default-deny for every later spawn on a "stateless" instance.
    this.envAllowlist =
      options.envAllowlist === undefined ? undefined : Object.freeze([...options.envAllowlist]);
    if (
      options.toolSurface !== undefined &&
      options.toolSurface !== 'harness' &&
      options.toolSurface !== 'stock'
    ) {
      throw new Error(
        `claude-code driver: toolSurface must be 'harness' or 'stock', got ${JSON.stringify(options.toolSurface)}`,
      );
    }
    this.toolSurface = options.toolSurface ?? 'harness';
    this.spawnImpl = options.spawn ?? spawnManaged;
  }

  /** The frozen seam (v2): run one invocation to completion. */
  async run(opInvocation: OpInvocation, options?: RunOptions): Promise<WorkerResult> {
    const { prompt, modelSpec, toolPolicy, sandboxPolicy, sessionRef, budget } = opInvocation;

    // --- Governed cancellation + strict-budget honesty, ENTRY checks (I8):
    // the run signal is read ONCE here. An already-cancelled invocation never
    // reaches lane-specific setup (route/key/env/workspace), and a
    // `Budget.strictTokenBudget` request is refused before it either.
    // Cancellation outranks the strict refusal.
    const signal = options?.signal;
    if (signalAborted(signal)) {
      return { usage: zeroUsage(), denials: [], stopReason: 'aborted' };
    }
    assertStrictTokenBudgetSupported(opInvocation.budget, 'claude-code');

    // --- Pre-dispatch validation: everything here throws BEFORE the CLI is
    // spawned and (except routing/key checks) before any session exists.
    const route = resolveRoute(modelSpec, this.routingTable); // unknown provider → the config throw
    const childEnv = this.resolveChildEnv(route); // missing key env → throw
    // Session-log correlation (preservation plan items 1.3–1.5): the
    // invocation's work identity rides the child env as explicit overrides
    // (shared with the SDK and ACP transports — ../correlation-env.ts).
    applyCorrelationEnv(childEnv, opInvocation.correlation);
    if (
      budget.maxTokens !== undefined &&
      (!Number.isFinite(budget.maxTokens) || budget.maxTokens <= 0)
    ) {
      throw new Error(
        `claude-code driver: budget.maxTokens must be a finite number > 0, got ${String(budget.maxTokens)}`,
      );
    }
    // Workspace binding (ADR-0002 §2.4): validated + realpathed BEFORE any
    // session state exists — a bad binding is a pre-dispatch config throw.
    const boundWorkspace =
      opInvocation.workspace === undefined
        ? undefined
        : boundWorkspacePath(opInvocation.workspace, 'claude-code driver');

    // --- Governed-cancellation LATE recheck (I8): the signal was read at
    // entry; recheck the SAME live RunOptions.signal after lane setup, so an
    // abort that fired since entry never spawns and never creates a session
    // record. The strict refusal already ran at entry (no duplicate here).
    if (signalAborted(signal)) {
      return { usage: zeroUsage(), denials: [], stopReason: 'aborted' };
    }

    // --- Structured-output preflight (PR #238 review round 2): the schema
    // document is caller-authored plain data — compile it BEFORE the CLI is
    // spawned. An uncompilable document is the uniform LOCAL 'output-invalid'
    // verdict (the settle-time miss shape), never a provider/harness failure
    // from a request-setup rejection. No record exists yet (none is created):
    // zero usage, no denials, no sessionId.
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

    // --- Tool surface. 'harness' (default): the SHARED CORE's one manifest
    // constructor binds the workspace realpath, sandbox level, harness ∩
    // ToolPolicy, harness config and env names; the manifest rides the
    // server's argv inside a per-run MCP config (Annex A.4). 'stock': the
    // legacy inert harness-name allowlist over the CLI's builtins (D6).
    const stock = this.toolSurface === 'stock';
    let manifest: HarnessManifest | undefined;
    let allowed: string[];
    if (stock) {
      // Stock mode is the legacy inert allowlist over the CLI's builtins: it
      // keeps the pre-F1 read/edit/run names and never grows the new `write`
      // tool (the harness config's canonical names are mapped back here).
      allowed = selectToolNames(
        buildTools(this.harnessConfig, workspace, sandboxPolicy.level)
          .map((t) => t.name)
          .filter((name) => name !== 'write')
          .map((name) => (name === 'bash' ? 'run' : name)),
        toolPolicy,
      );
    } else {
      manifest = await buildManifest({
        workspace,
        sandbox: sandboxPolicy.level,
        toolPolicy,
        harness: this.harnessConfig,
        envNames: this.envAllowlist,
      });
      allowed = manifest?.tools ?? [];
    }

    // --- Sandbox narration. Harness mode: the harness now enforces the
    // TOOL-level sandbox mapping (read-only denials, containment) on this
    // lane, so the marker narrows to OS confinement (`layer: 'os'`). Stock
    // mode: nothing the harness enforces applies — the legacy marker.
    const sandboxUnenforced = sandboxPolicy.level !== 'none' && allowed.length > 0;

    // --- CLI-level resume: the substrate session id recorded in the
    // SESSIONS STORE sidecar by a prior run (absent → workspace-only
    // continuation).
    const resumeCliSessionId = await readCliSessionId(sessionsDir, record.sessionId);

    // --- The per-run MCP config (harness mode, non-empty selection):
    // created exclusively, 0600, beside the session records.
    const mcpConfigPath =
      manifest === undefined
        ? undefined
        : await writeMcpConfig(sessionsDir, record.sessionId, manifest);

    // --- Per-run schema resolution (ADR-0002 §2.3): the invocation schema
    // is the only schema source; it normalizes to the same plain-data
    // OutputSchema the shared validator judges.
    const outputSchema = opInvocation.outputSchema;

    // The CLI's permission gate is byte-exact over --allowedTools, so the
    // one-release aliases (the pre-F1 `run` name) must be named there too;
    // the reported init surface stays canonical.
    const argv = buildArgs({
      route,
      toolSurface: this.toolSurface,
      allowedToolNames: stock
        ? allowed
        : allowed
            .flatMap((name) => [name, ...toolAliases(name)])
            .map((name) => qualifiedToolName(name)),
      mcpConfigPath,
      outputJsonSchema:
        outputSchema === undefined
          ? undefined
          : // Transport (ADR-0002 §2.3): the EXACT plain document the schema
            // request carried, meta-URI stripped (the CLI rejects the
            // draft-2020-12 `$schema` key, #209).
            JSON.stringify(stripMetaSchema(outputSchema.schema)),
      resumeCliSessionId,
    });

    // --- The one spawn. From here on, run() NEVER throws past the seam —
    // including the spawn itself: a SYNCHRONOUS spawnImpl failure (empty
    // argv → ERR_INVALID_ARG_TYPE, a hostile override) is an 'error'
    // VERDICT, not a rejection (issue #19).
    const observation = newObservation();
    if (!stock) {
      // Fail-closed init-surface assertion (Annex A.4): exactly the harness
      // server (when configured) and exactly the selected tools, plus the
      // pinned CLI-internal structured-output tool under --json-schema.
      observation.expectedSurface = {
        harness: manifest !== undefined,
        tools: allowed,
        internalTools: outputSchema === undefined ? [] : [STRUCTURED_OUTPUT_TOOL],
      };
    }
    if (sandboxUnenforced) {
      observation.narration.push(
        JSON.stringify(
          stock
            ? { cq: 'sandbox-level-unenforced', level: sandboxPolicy.level }
            : { cq: 'sandbox-level-unenforced', level: sandboxPolicy.level, layer: 'os' },
        ),
      );
    }
    let child: ManagedChild;
    try {
      child = this.spawnImpl({
        command: this.binary[0] as string,
        args: [...this.binary.slice(1), ...argv],
        cwd: workspace,
        env: childEnv,
        // Session-log correlation: childEnv holds only overrides, and the
        // spawn composes the final env from the parent — so a correlated
        // invocation's absent CQ_* fields are removed there, not here.
        ...(opInvocation.correlation !== undefined
          ? { envRemove: correlationEnvRemovals(opInvocation.correlation) }
          : {}),
        stdin: prompt,
        // Default-deny parent-env pass-through (issue #183); undefined keeps
        // spawnManaged's shipped allowlist alone.
        ...(this.envAllowlist !== undefined ? { envAllowlist: this.envAllowlist } : {}),
      });
    } catch (err) {
      // Best-effort narration first (the same swallow rule as persistence:
      // the verdict outranks the record), then the honest error verdict.
      try {
        await store.appendMessage(record.sessionId, {
          role: 'tool',
          toolName: CLI_NARRATION_TOOL,
          content: JSON.stringify([
            JSON.stringify({
              cq: 'spawn-failed',
              error: err instanceof Error ? err.message : String(err),
            }),
          ]),
          at: nowIso(),
        });
      } catch {
        // deliberately swallowed — the verdict still reaches the caller
      }
      await removeMcpConfig(mcpConfigPath);
      return {
        usage: zeroUsage(),
        sessionId: record.sessionId,
        denials: [],
        stopReason: 'error',
        error: boundedErrorText(`claude-code driver: spawn failed — ${describeError(err)}`),
        // A spawn failure is a local (harness) failure — the producer rule
        // (ADR-0002 §2.2): every error verdict carries its class.
        errorClass: 'harness',
      };
    }

    let aborted = false;
    let terminationStarted = false;
    let finishTermination: (() => void) | undefined;
    const terminationDone = new Promise<void>((resolve) => {
      finishTermination = resolve;
    });
    // One ladder, two deciders: the GOVERNED signal (→ 'aborted') and the
    // fail-closed harness checks (→ 'error'/harness). The first decider wins;
    // the ladder runs once.
    let terminationCause: 'governed' | 'harness' | undefined;
    const startTermination = (cause: 'governed' | 'harness'): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      terminationCause = cause;
      void terminateGracefully(
        child,
        {
          ...(this.termGraceMs !== undefined ? { termGraceMs: this.termGraceMs } : {}),
          ...(this.killGraceMs !== undefined ? { killGraceMs: this.killGraceMs } : {}),
        },
        // Termination evidence lands in the session narration (observable,
        // in OUR vocabulary).
        (marker: TerminationRungMarker) => {
          observation.narration.push(JSON.stringify({ cq: 'termination-rung', ...marker }));
        },
      ).then(
        (outcome) => {
          aborted = terminationCause === 'governed';
          observation.narration.push(JSON.stringify({ cq: 'termination', outcome }));
          finishTermination?.();
        },
        () => {
          aborted = terminationCause === 'governed'; // ladder failure must not hang the run
          finishTermination?.();
        },
      );
    };
    const onAbort = (): void => startTermination('governed');
    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
      // ATTACH-TIME RECHECK (the acp lane's Codex P1 pattern, and the SDK
      // transport's abortRootFollowing): abort events are NOT replayed —
      // a signal that fired while the record/manifest/MCP-config awaits were
      // in flight (between the pre-dispatch aborted check and THIS attach)
      // lands the listener on an ALREADY-aborted signal, never invoked, and
      // the child would never be terminated: the run would stream past a
      // fired cancellation. Run the abort path NOW — startTermination is
      // once-guarded, and the settle below awaits the ladder's markers.
      if (signal.aborted) onAbort();
    }

    let earlyConfigDelete: Promise<void> | undefined;
    child.onStdoutLine((line) => {
      handleStdoutLine(observation, line);
      if (observation.harnessConnected && earlyConfigDelete === undefined) {
        // Shortest useful lifetime: the CLI has spawned the server and the
        // manifest now lives in its memory (a reconnect respawns from that
        // in-memory config, never the file — live leg A.5i) — delete the
        // config at once; the settle-time delete below is the backstop.
        earlyConfigDelete = removeMcpConfig(mcpConfigPath);
      }
      if (observation.harnessFailure !== undefined) startTermination('harness');
    });
    child.onStderrLine((line) => observation.stderr.push(line));

    // Capture the settled close value WITHOUT adding an unbounded await: a
    // stubborn child the ladder force-resolved may never close, so this is
    // best-effort error-cause evidence (issue #208) — the race semantics
    // below are unchanged.
    void child.close.then(
      (closed) => {
        observation.close = closed;
      },
      () => {
        // child.close always settles (spawn failure included); a rejection is
        // impossible in practice and must never affect the verdict.
      },
    );
    // Settle whichever channel lands first: the child closing (its result
    // event already folded) or the governed ladder finishing the kill.
    // The termination path deliberately does NOT await a stubborn child.
    await Promise.race([child.close, terminationDone]);
    signal?.removeEventListener('abort', onAbort);

    // The ladder's markers (rungs + outcome) are part of the narration
    // contract; a child that dies on SIGTERM must not win the settle race
    // against the ladder's final marker. Bounded: terminateGracefully
    // always settles (its SIGKILL rung force-resolves).
    if (terminationStarted) await terminationDone;

    // Backstop delete of the per-run MCP config, whatever the verdict and
    // whatever the sessionRetention (a failure is swallowed; rm is idempotent).
    await earlyConfigDelete;
    await removeMcpConfig(mcpConfigPath);

    // Fail closed: a harness-mode run whose CLI never reported an init
    // surface ran unverified — whatever it reports is not a model outcome.
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
    }

    // --- Usage accounting (usage.ts: the ONE fold) + its provenance.
    recordUsageProvenance(observation, resumeCliSessionId !== undefined);

    // --- Structured output (ADR-0002 §2.3, S3): the ONE shared judge over
    // the SAME document that was sent (refusal-voided — verdict.ts). A miss
    // after the CLI's own retry settles the uniform error/'output-invalid'
    // verdict (usage and cost kept, rejection in the bounded error text).
    // A harness failure voids the payload outright: output produced on an
    // unverified or broken tool surface is not a model outcome.
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

    // The served model is OBSERVED, never requested: when the CLI reports a
    // different id than ModelSpec.model asked for, the mismatch is recorded
    // as narration (issue #19 — the corruption is now observable). The
    // conformance suite fails a mismatching run loudly (leg m); production
    // runs record it and price off the served id (below).
    if (observation.servedModel !== undefined && observation.servedModel !== modelSpec.model) {
      observation.narration.push(
        JSON.stringify({
          cq: 'served-model-mismatch',
          requested: modelSpec.model,
          served: observation.servedModel,
        }),
      );
    }

    // --- Session persistence (post-settle, OUR vocabulary). A store error
    // here is swallowed: once spawned, the verdict must reach the caller —
    // persistence is evidence hygiene, not the seam contract.
    try {
      await persistObservation(store, record, observation, resumeCliSessionId, new Set(allowed));
    } catch {
      // deliberately swallowed — the honest verdict outranks the record
    }

    return this.verdict(
      modelSpec,
      budget,
      observation,
      record.sessionId,
      aborted,
      structured,
      structuredMiss,
      isCodexBinary(this.binary[0] ?? ''),
      workspace,
    );
  }

  // --- Internals -------------------------------------------------------------

  /**
   * Child env for one route: the resolved base URL plus the auth plan —
   * each entry names the HOST env var to copy AT RUN TIME; a missing value
   * throws BEFORE the spawn (same never-guess posture as the ai-sdk key
   * check). The route carries names only, so this is the one place a
   * secret value is ever read. The returned map is the EXPLICIT override
   * layer `spawnManaged` applies on top of its default-deny allowlist
   * (issue #183): configured route keys reach the child even though the
   * parent env is otherwise not inherited.
   */
  private resolveChildEnv(route: Route): Record<string, string> {
    const childEnv: Record<string, string> = { ANTHROPIC_BASE_URL: route.baseUrl };
    for (const [childVar, hostVar] of Object.entries(authEnvPlan(route.keyEnv))) {
      const value = process.env[hostVar];
      if (value === undefined || value === '') {
        // Pre-dispatch misconfiguration carries its class as structured data
        // (ADR-0002 §2.2): errorClassOf → 'config'.
        throw new DispatchError(
          'config',
          `claude-code driver: route to '${route.endpoint}' requires ${hostVar} in the environment`,
        );
      }
      childEnv[childVar] = value;
    }
    return childEnv;
  }

  /**
   * Fold the observation into the frozen WorkerResult (header tables:
   * stop reasons, cost, usage). Real usage (CLI-reported, per-model
   * aggregates preferred — usage.ts) is kept on any verdict that observed
   * it; unmeasured verdicts (spawn failure, abort) report zeros and NEVER a
   * cost. A served/reported model mismatch with the requested id is the
   * narration marker's business (run()); the PRICING here keys on the
   * served id either way (issue #24).
   *
   * ERROR CLASSES (seam v2, ADR-0002 §2.2): every 'error' verdict carries
   * `errorClass`, from the ONE shared classifier (failures.ts). Abort and
   * budget carve-outs carry no class: the missing object is their
   * consequence, not their cause.
   */
  private verdict(
    modelSpec: ModelSpec,
    budget: OpInvocation['budget'],
    observation: RunObservation,
    sessionId: string,
    aborted: boolean,
    structured: unknown,
    structuredMiss: string | undefined,
    codexBinary: boolean,
    workspacePath: string | undefined,
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
      oversizedLine: observation.close?.oversizedLine === true,
    });
    // §2.3 verdict unification: a structured-output miss is an ERROR verdict
    // — except when a cap or the signal stopped the run first (the missing
    // object is its consequence, not its cause: the budget/aborted carve-out).
    const missIsError = structuredMiss !== undefined && stopReason === 'complete';
    const effectiveStopReason: WorkerResult['stopReason'] = missIsError ? 'error' : stopReason;
    // The error field is present ONLY on a driver-level failure verdict (the
    // frozen contract allows `error` only with stopReason 'error'): the cause
    // is derived from the result frame, else the child's exit evidence, else
    // the narration tail — a bare 'error' tells the caller nothing (issue
    // #208).
    let error: string | undefined;
    let errorClass: WorkerErrorClass | undefined;
    let providerSignals: ProviderSignals | undefined;
    if (effectiveStopReason === 'error') {
      if (observation.harnessFailure !== undefined) {
        // Fail-closed surface/transport assertions are always 'harness'.
        errorClass = 'harness';
      } else if (structuredMiss !== undefined) {
        error = `claude-code driver: structured output invalid — ${structuredMiss}`;
        errorClass = 'output-invalid';
      } else {
        const result = observation.result;
        const resultFailed = result !== undefined && resultStatusOf(result) === 'error';
        const rawResult = asString(result?.['result']);
        const errorEntries = (asArray(result?.['errors']) ?? []).filter(
          (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
        );
        const subtype = asString(result?.['subtype']);
        const resultCause =
          rawResult !== undefined && rawResult.trim() !== '' ? rawResult : errorEntries.join('; ');
        const classified = classifyFailure({
          kind: resultFailed ? 'result-frame' : 'close',
          texts: [...(resultFailed ? [resultCause, subtype ?? ''] : []), ...observation.stderr],
          ...(observation.close?.oversizedLine === true ? { oversizedLine: true } : {}),
          ...(observation.close !== undefined ? { close: observation.close } : {}),
          measuredUsage: measured !== undefined || observation.assistantUsage !== undefined,
          codexBinary,
        });
        errorClass = classified.errorClass;
        providerSignals = classified.providerSignals;
      }
      error = error ?? errorCauseOf(observation);
      if (error !== undefined && observation.stderr.length > 0) {
        error = `${error}; stderr: ${observation.stderr.slice(-3).join(' | ')}`;
      }
      error = boundedErrorText(error ?? 'claude-code driver: the CLI failed without a cause');
    }
    // Derived-only cost (DD-2): only on a verdict carrying a REAL usage
    // measurement — never on an unmeasured abort/spawn-failure verdict.
    // Price the model that was actually SERVED when one was observed (the
    // remap evidence is real — pricing the requested id would attribute the
    // wrong rates); the requested ModelSpec.model is the fallback. The
    // provider handle stays modelSpec.provider (the price table's key).
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
      // The observed served model: what the endpoint reports it served, not
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
      // Session-log preservation item 1.5: the harness-native session id
      // and the transcript path it implies (Claude Code encodes the cwd —
      // here the run's workspace — as the project dir). The ARCHIVER joins
      // on these; we never rewrite the transcript (feature R4). Absent
      // when the CLI never reported a session id.
      ...(observation.cliSessionId !== undefined
        ? {
            nativeSessionId: observation.cliSessionId,
            ...(nativeTranscriptPath(observation.cliSessionId, workspacePath) !== undefined
              ? {
                  nativeSessionPath: nativeTranscriptPath(
                    observation.cliSessionId,
                    workspacePath,
                  ) as string,
                }
              : {}),
          }
        : {}),
      denials: observation.denials,
      toolFailures: observation.deniedToolUseIds.size,
      stopReason: effectiveStopReason,
      ...(error !== undefined ? { error } : {}),
      ...(errorClass !== undefined ? { errorClass } : {}),
      ...(providerSignals !== undefined ? { providerSignals } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers — pure, exported only where the tests need them
// ---------------------------------------------------------------------------

/**
 * The Claude Code transcript path a native session id implies (item 1.5):
 * `~/.claude/projects/<encoded-workspace>/<sessionId>.jsonl`, where the
 * encoding replaces every non-alphanumeric char with `-`. Exported for the
 * driver tests; returns undefined when the workspace is unknown (a
 * temp-workspace run's key is its own mkdtemp path — the path is still
 * derivable, but the caller can pass it; unknown in → undefined out, never
 * a guessed key).
 */
export function nativeTranscriptPath(
  nativeSessionId: string,
  workspace: string | undefined,
): string | undefined {
  if (workspace === undefined || workspace === '') return undefined;
  const key = workspace.replace(/[^A-Za-z0-9]/g, '-');
  return join(homedir(), '.claude', 'projects', key, `${nativeSessionId}.jsonl`);
}

/** ISO-8601 timestamp for session messages. */
function nowIso(): string {
  return new Date().toISOString();
}

// The shared default (item 1.1): one helper, durable XDG state location.
// (Imported above; re-exported so existing importers keep their path.)
export { defaultSessionsDir };

/**
 * Frozen ToolPolicy → the allowed tool-name subset: 'none' → nothing;
 * 'unrestricted' → the whole harness surface; 'allowlist' (the default
 * reading when mode is omitted) → harness names in `allow` only.
 */
export function allowedToolNames(
  harnessToolNames: readonly string[],
  policy: ToolPolicy,
): string[] {
  return selectToolNames(harnessToolNames, policy); // the shared core — one implementation
}

/**
 * Write the per-run MCP config (Annex A.4) EXCLUSIVELY (flag 'wx' =
 * O_CREAT|O_EXCL — never follows or reuses a pre-planted file) with mode
 * 0600, beside the session records, under a per-run random name. An
 * existing file at that name is never adopted or replaced: EEXIST throws
 * (pre-dispatch). The server is launched as `process.execPath` + the
 * module-relative bin (never PATH/npx/plan data); the manifest is its one
 * argv element.
 */
async function writeMcpConfig(
  sessionsDir: string,
  sessionId: string,
  manifest: HarnessManifest,
): Promise<string> {
  // ABSOLUTE: the CLI runs with cwd = the workspace, so a relative
  // sessionsDir would resolve --mcp-config beneath the workspace.
  const path = resolve(sessionsDir, `${sessionId}.${randomUUID()}${HARNESS_MCP_CONFIG_FILE}`);
  const launch = harnessServerLaunch();
  const config = {
    mcpServers: {
      [HARNESS_MCP_SERVER_NAME]: {
        command: launch.command,
        args: [...launch.args, JSON.stringify(manifest)],
        env: {},
      },
    },
  };
  const body = `${JSON.stringify(config)}\n`;
  await writeFile(path, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return path;
}

/** Delete the per-run MCP config; absent path or failure is swallowed (persistence posture). */
async function removeMcpConfig(path: string | undefined): Promise<void> {
  if (path === undefined) return;
  try {
    await rm(path, { force: true });
  } catch {
    // deliberately swallowed — the verdict outranks the cleanup
  }
}

/** Inputs to the argv builder — plain data. */
export interface ArgBuildInputs {
  route: Route;
  /** The tool surface. Default 'harness' (the closed surface). */
  toolSurface?: CliToolSurface;
  /**
   * The --allowedTools names, verbatim: harness mode passes the QUALIFIED
   * spellings (`mcp__cq-harness__<name>`); stock mode the legacy harness names.
   */
  allowedToolNames: readonly string[];
  /** The per-run MCP config path (harness mode, non-empty selection only). */
  mcpConfigPath?: string | undefined;
  /** Serialized JSON Schema for --json-schema, when the schema option is set. */
  outputJsonSchema: string | undefined;
  /** CLI session id for --resume, when the record carries a marker. */
  resumeCliSessionId: string | undefined;
}

/**
 * THE ARGV (header table, in order). --allowedTools is ALWAYS emitted: an
 * empty joined value means "nothing pre-approved" — and because headless -p
 * mode cannot prompt, a tool outside --allowedTools is DENIED by the CLI
 * (never prompted, never hung): those CLI-side denials are the source of
 * WorkerResult.denials. No undocumented flags (issue #19): the former
 * `--permission-prompts none` and `--bare` are REMOVED — the real `claude`
 * CLI rejects them at argv parse.
 */
export function buildArgs(inputs: ArgBuildInputs): string[] {
  const args: string[] = [
    '-p', // headless print mode; the prompt rides stdin
    '--output-format',
    'stream-json',
    // The real CLI refuses `-p --output-format stream-json` without
    // --verbose (found live against CLI 2.1.270, T1.6 slice 4) — always
    // emitted so stream-json parses on every lane.
    '--verbose',
  ];
  if (inputs.outputJsonSchema !== undefined) {
    args.push('--json-schema', inputs.outputJsonSchema);
  }
  if ((inputs.toolSurface ?? 'harness') === 'harness') {
    // The CLOSED surface (RS-1 recipe + RS-1b MCP form, Annex A.4): no
    // builtins (absent, not denied), no ambient settings, no ambient MCP.
    args.push('--tools', '', '--setting-sources', '', '--strict-mcp-config');
    if (inputs.mcpConfigPath !== undefined) args.push('--mcp-config', inputs.mcpConfigPath);
  }
  // ONE argv element, SPACE-joined: a comma-joined list silently
  // pre-approves only its first entry (RS-1b b9/b10).
  args.push('--allowedTools', inputs.allowedToolNames.join(' '));
  args.push('--model', inputs.route.model);
  if (inputs.resumeCliSessionId !== undefined) {
    args.push('--resume', inputs.resumeCliSessionId);
  }
  return args;
}

// ---------------------------------------------------------------------------
// stream-json observation — defensive folding of the CLI's event stream
// ---------------------------------------------------------------------------

/** The CLI's terminal result event, kept raw (defensively read at use sites). */
type ResultEvent = Record<string, unknown>;

/** Per-run observation state folded from stdout lines. */
export interface RunObservation {
  /** CLI-side session id (init/result events) — recorded as a marker message. */
  cliSessionId: string | undefined;
  /** The model id the CLI reports as served (init/result events) — the observed, never requested id. */
  servedModel: string | undefined;
  /** Assistant text blocks, in arrival order (the transcript). */
  transcript: string[];
  /** Non-JSON lines and unknown event shapes — evidence, never a crash. */
  narration: string[];
  /** stderr lines (diagnostics). */
  stderr: string[];
  /** Usage folded from assistant events — the fallback when no result usage. */
  assistantUsage: Usage | undefined;
  /** The terminal result event, when it arrived. */
  result: ResultEvent | undefined;
  /** The child's settled close (exit code/signal/spawn error), when it closed — error-cause evidence (#208). */
  close: ProcessClose | undefined;
  /** tool_use id → tool name (to attribute tool_result activity/denials). */
  toolUseNameById: Map<string, string>;
  /** tool_use blocks in arrival order (id, name, declared input). */
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  /** tool_result outcomes in arrival order (paired to tool_use ids). */
  toolResults: Array<{ toolUseId: string; ok: boolean; text: string }>;
  /** tool_use ids already denied (dedupe). */
  deniedToolUseIds: Set<string>;
  /** The frozen denials, in denial order. */
  denials: ToolDenial[];
  /** Harness mode only: the init surface the CLI must report (fail-closed assertion). */
  expectedSurface: ExpectedInitSurface | undefined;
  /** True once the first system/init event was folded. */
  initSeen: boolean;
  /** True once init reported the harness server connected (the config file may go). */
  harnessConnected: boolean;
  /** tool_use ids the CLI reported as permission-denied (system/permission_denied). */
  permissionDeniedIds: Set<string>;
  /** The first harness failure (surface mismatch / transport failure) — terminates the run. */
  harnessFailure: HarnessFailure | undefined;
  /**
   * True once any wire frame carried the substrate's structured refusal
   * stop reason (the D-E′ refusal void — verdict.ts).
   */
  refusalSeen: boolean;
}

/** A harness-classified failure marker (narration + error cause), `errorClass: 'harness'`. */
type HarnessFailure =
  | {
      cq: 'harness-surface-mismatch';
      errorClass: 'harness';
      expected: unknown;
      observed: unknown;
    }
  | { cq: 'harness-transport-failure'; errorClass: 'harness'; tool: string; text: string }
  | { cq: 'harness-surface-unverified'; errorClass: 'harness' };

/** The CLI's own permission-denial text (RS-1b b3/b6), the fallback when no frame was seen. */
const CLI_PERMISSION_TEXT = /^Claude requested permissions to use /;

function newObservation(): RunObservation {
  return {
    cliSessionId: undefined,
    servedModel: undefined,
    transcript: [],
    narration: [],
    stderr: [],
    assistantUsage: undefined,
    result: undefined,
    close: undefined,
    toolUseNameById: new Map(),
    toolUses: [],
    toolResults: [],
    deniedToolUseIds: new Set(),
    denials: [],
    expectedSurface: undefined,
    initSeen: false,
    harnessConnected: false,
    permissionDeniedIds: new Set(),
    harnessFailure: undefined,
    refusalSeen: false,
  };
}

/**
 * Record the run's usage provenance + resume semantics markers (usage.ts):
 * a marker only when the fold came from a NON-DEFAULT channel (per-model
 * aggregates vs assistant fallback — absence means the result channel),
 * and — on a resumed session — the version-gated per-call/cumulative
 * boundary note. Markers go to the narration, so they persist with the
 * session evidence.
 */
function recordUsageProvenance(observation: RunObservation, resumed: boolean): void {
  const measuredFrame: MeasuredUsage | undefined = measureResultUsage(observation.result);
  const provenance =
    measuredFrame !== undefined
      ? usageProvenanceMarker(measuredFrame)
      : observation.assistantUsage !== undefined
        ? usageProvenanceMarker({ usage: observation.assistantUsage, channel: 'assistant' })
        : undefined;
  if (provenance !== undefined) observation.narration.push(provenance);
  if (resumed && (measuredFrame !== undefined || observation.assistantUsage !== undefined)) {
    observation.narration.push(resumedUsageSemanticsMarker());
  }
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

/** tool_result content → the denial reason text (string or text-block array). */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  const blocks = asArray(content);
  if (blocks === undefined) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    const rec = asRecord(block);
    if (rec !== undefined && rec['type'] === 'text' && typeof rec['text'] === 'string') {
      parts.push(rec['text']);
    }
  }
  return parts.join('');
}

/**
 * Fold ONE stdout line into the observation (header mapping table). A
 * non-JSON line, an unshapeable event, or an unknown event type becomes
 * narration — the stream's junk is evidence, never a crash.
 */
export function handleStdoutLine(observation: RunObservation, line: string): void {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    observation.narration.push(line);
    return;
  }
  const event = asRecord(data);
  if (event === undefined) {
    observation.narration.push(line);
    return;
  }
  switch (event['type']) {
    case 'system': {
      if (event['subtype'] === 'init') {
        observation.cliSessionId = asString(event['session_id']) ?? observation.cliSessionId;
        observation.servedModel = asString(event['model']) ?? observation.servedModel;
        if (!observation.initSeen) {
          observation.initSeen = true;
          assertInitSurface(observation, event);
        }
        return;
      }
      if (event['subtype'] === 'permission_denied') {
        // The CLI's permission gate refused a call outside --allowedTools;
        // the errored tool_result that follows is a permission denial.
        const id = asString(event['tool_use_id']);
        if (id !== undefined) observation.permissionDeniedIds.add(id);
      }
      observation.narration.push(line); // known type, unhandled subtype — evidence
      return;
    }
    case 'assistant': {
      const message = asRecord(event['message']);
      if (message === undefined) {
        observation.narration.push(line);
        return;
      }
      // The refusal stop reason rides the inner Anthropic Messages API
      // Message shape (`message.stop_reason`) — the D-E′ refusal void's
      // CLI-transport observation point.
      if (frameCarriesRefusal(message) && !observation.refusalSeen) {
        observation.refusalSeen = true;
        observation.narration.push(refusalNarrationMarker());
      }
      const usage = usageFromWire(message['usage']);
      if (usage !== undefined) {
        observation.assistantUsage = addUsage(observation.assistantUsage, usage);
      }
      const content = asArray(message['content']) ?? [];
      for (const block of content) {
        const rec = asRecord(block);
        if (rec === undefined) continue;
        if (rec['type'] === 'text' && typeof rec['text'] === 'string') {
          observation.transcript.push(rec['text']);
        } else if (rec['type'] === 'tool_use') {
          const id = asString(rec['id']);
          const name = asString(rec['name']);
          if (id !== undefined && name !== undefined) {
            observation.toolUseNameById.set(id, name);
            observation.toolUses.push({ id, name, input: rec['input'] });
          }
        }
      }
      return;
    }
    case 'user': {
      // tool_result events ride a user-role envelope in stream-json: EVERY
      // one is tool activity (persisted for in-policy tools post-settle),
      // and an errored one is additionally a denial of the matching
      // tool_use (frozen shape).
      const message = asRecord(event['message']);
      const content = message === undefined ? undefined : asArray(message['content']);
      if (content === undefined) return;
      for (const block of content) {
        const rec = asRecord(block);
        if (rec === undefined || rec['type'] !== 'tool_result') continue;
        const id = asString(rec['tool_use_id']);
        if (id === undefined) continue;
        const text = textOfContent(rec['content']);
        observation.toolResults.push({ toolUseId: id, ok: rec['is_error'] !== true, text });
        if (rec['is_error'] !== true || observation.deniedToolUseIds.has(id)) continue;
        observation.deniedToolUseIds.add(id);
        const rawName = observation.toolUseNameById.get(id) ?? 'unknown';
        // Harness names in OUR vocabulary (the SDK transport's too). The
        // one-release `run` alias folds to canonical `bash`, matching the
        // core's denial and the SDK transport.
        const tool = canonicalToolName(harnessToolName(rawName));
        if (
          observation.expectedSurface !== undefined &&
          isQualifiedHarnessTool(rawName) &&
          !observation.permissionDeniedIds.has(id) &&
          !CLI_PERMISSION_TEXT.test(text) &&
          !isHarnessDenial(text)
        ) {
          // THREE-WAY is_error CLASSIFICATION (Annex A.4) — neither a harness
          // denial (stable prefix) nor a CLI permission denial: a server
          // crash, an MCP timeout, a -32602 … arriving as CLI-authored text.
          // Never a denial: the run would otherwise finish as a model
          // outcome with no working tools. Terminate → error/harness.
          observation.harnessFailure ??= {
            cq: 'harness-transport-failure',
            errorClass: 'harness',
            tool,
            text: text.slice(0, 2_000),
          };
          continue;
        }
        observation.denials.push({
          tool,
          reason: text === '' ? `tool use denied by the CLI (${tool})` : text,
        });
      }
      return;
    }
    case 'result': {
      observation.result = event;
      observation.cliSessionId = asString(event['session_id']) ?? observation.cliSessionId;
      observation.servedModel = asString(event['model']) ?? observation.servedModel;
      // The result frame can carry the refusal stop reason too — observe it
      // wherever the substrate states it (the void is channel-agnostic).
      if (frameCarriesRefusal(event) && !observation.refusalSeen) {
        observation.refusalSeen = true;
        observation.narration.push(refusalNarrationMarker());
      }
      return;
    }
    default:
      observation.narration.push(line);
  }
}

/**
 * The fail-closed init-surface assertion (Annex A.4), on the FIRST
 * system/init event of a harness-mode run: the `{name, status}` projection
 * of `mcp_servers` and the `tools` set must match the expected surface
 * exactly. A mismatch (a missing/failed harness, a leaked connector or
 * stray `.mcp.json`, a builtin `--tools ""` no longer strips) records the
 * harness failure that terminates the run; a match with a configured
 * server marks it connected.
 */
function assertInitSurface(observation: RunObservation, event: Record<string, unknown>): void {
  const expected = observation.expectedSurface;
  if (expected === undefined) return; // stock mode — nothing asserted
  const verdict = compareInitSurface(expected, {
    mcp_servers: event['mcp_servers'],
    tools: event['tools'],
  });
  if (verdict.ok) {
    observation.harnessConnected = expected.harness;
    return;
  }
  observation.harnessFailure ??= {
    cq: 'harness-surface-mismatch',
    errorClass: 'harness',
    expected: verdict.expected,
    observed: verdict.observed,
  };
}

/**
 * Post-settle persistence (OUR vocabulary, in arrival-ish order): the CLI
 * session sidecar (when newly observed), one role 'tool' message per
 * IN-POLICY tool execution (input + outcome in plain JSON — out-of-policy
 * activity stays narration-only, per the header's governed-surface rule),
 * the assistant transcript (when any), and narration + stderr diagnostics
 * (when any). Never fabricates an assistant turn: a run that produced no
 * text records none.
 */
async function persistObservation(
  store: SessionStore,
  record: SessionRecord,
  observation: RunObservation,
  resumeCliSessionId: string | undefined,
  allowedNames: ReadonlySet<string>,
): Promise<void> {
  await writeCliSessionId(store, record, observation.cliSessionId, resumeCliSessionId);
  for (const outcome of observation.toolResults) {
    const rawName = observation.toolUseNameById.get(outcome.toolUseId);
    // Harness mode: only the QUALIFIED harness spellings are the governed
    // surface, recorded under their harness names; stock mode: the legacy
    // raw-name match.
    const name =
      rawName === undefined
        ? undefined
        : observation.expectedSurface === undefined
          ? rawName
          : isQualifiedHarnessTool(rawName)
            ? canonicalToolName(harnessToolName(rawName))
            : undefined;
    if (name === undefined || !allowedNames.has(name)) continue; // governed surface only
    const use = observation.toolUses.find((candidate) => candidate.id === outcome.toolUseId);
    const message: SessionMessage = {
      role: 'tool',
      toolName: name,
      content: JSON.stringify({ input: use?.input ?? null, ok: outcome.ok, output: outcome.text }),
      at: nowIso(),
    };
    await store.appendMessage(record.sessionId, message);
  }
  const text = observation.transcript.join('\n\n');
  if (text !== '') {
    await store.appendMessage(record.sessionId, { role: 'assistant', content: text, at: nowIso() });
  }
  const diagnostics = [
    ...observation.narration.map(redactSensitiveText),
    ...observation.stderr.map((l) => `[stderr] ${redactSensitiveText(l)}`),
  ];
  if (diagnostics.length > 0) {
    const message: SessionMessage = {
      role: 'tool',
      toolName: CLI_NARRATION_TOOL,
      content: JSON.stringify(diagnostics),
      at: nowIso(),
    };
    await store.appendMessage(record.sessionId, message);
  }
}

/**
 * The error CAUSE for an 'error' verdict (issue #208): what actually went
 * wrong, in precedence order — a harness failure; a failed result frame's
 * own `result` string, joined `errors` entries, or subtype; the child's
 * oversized-line failure, spawn error, exit code or terminating signal;
 * finally the narration tail.
 * The caller appends the retained stderr tail and redacts/bounds the result
 * (`boundedErrorText`), so a 0-token failure is diagnosable from the journal.
 */
function errorCauseOf(observation: RunObservation): string {
  const failure = observation.harnessFailure;
  if (failure !== undefined) {
    switch (failure.cq) {
      case 'harness-surface-mismatch':
        return `${HARNESS_ERROR_PREFIX} — init surface mismatch: expected ${JSON.stringify(failure.expected)}, observed ${JSON.stringify(failure.observed)}`;
      case 'harness-transport-failure':
        return `${HARNESS_ERROR_PREFIX} — transport failure on '${failure.tool}': ${failure.text}`;
      case 'harness-surface-unverified':
        return `${HARNESS_ERROR_PREFIX} — the CLI never reported its init surface`;
    }
  }
  const result = observation.result;
  if (result !== undefined && resultStatusOf(result) === 'error') {
    const rawResult = asString(result['result']);
    const errorEntries = (asArray(result['errors']) ?? []).filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
    );
    const subtype = asString(result['subtype']);
    const cause =
      rawResult !== undefined && rawResult.trim() !== ''
        ? rawResult
        : errorEntries.length > 0
          ? errorEntries.join('; ')
          : `subtype '${subtype ?? 'unknown'}'`;
    return `claude-code driver: result event error — ${cause}`;
  }
  const close = observation.close;
  if (close?.oversizedLine === true) {
    return 'claude-code driver: child emitted an oversized stdout/stderr line';
  }
  if (close?.spawnError !== undefined) {
    return `claude-code driver: spawn failed — ${describeError(close.spawnError)}`;
  }
  if (close !== undefined && (close.code !== 0 || close.signal !== null)) {
    if (close.signal !== null) {
      return `claude-code driver: CLI killed by signal ${String(close.signal)}`;
    }
    return `claude-code driver: CLI exited with code ${String(close.code)}`;
  }
  const narration = observation.narration.at(-1);
  return narration !== undefined && narration !== ''
    ? `claude-code driver: no result event — ${narration}`
    : 'claude-code driver: no result event';
}
