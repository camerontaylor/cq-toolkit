// The subprocess driver — T1.5 slice 1 (the null-hypothesis floor: run an
// existing agent CLI headless on the FROZEN Driver seam:
// run(opInvocation) → Promise<WorkerResult>).
//
// EXECUTION MODEL: out-of-process. Each invocation spawns ONE headless CLI
// run (`claude -p …` by default — see the argv table below) in the
// invocation's workspace, parses its stream-json stdout, and folds the
// events into our seam vocabulary. No daemon, no pooling, no reuse — the
// null hypothesis against which the in-process driver (T1.4) must justify
// itself: if a stock agent CLI can be driven as a worker, the toolkit's
// value is NOT "you can run Claude headless".
//
// I8 SEAM — the driver owns NO wall clock. The driver-hygiene scan bans
// driver-owned scheduling primitives under src/driver/**; this file (and
// routing.ts) contain none. WHEN to abort is the governor's decision: the
// governed context arrives via `currentJobContext()` (imported from
// ../../kernel/governor.js — the one deliberate driver→kernel import, same
// as the ai-sdk driver) and its `signal` is forwarded EXACTLY ONE place:
// the SIGTERM→SIGKILL grace ladder in ./process.ts (the scan's single
// exempt file, where the ladder executes an already-decided kill). Outside
// a governed run no cancellation source exists and a run is simply
// un-abortable by us. Consequences, documented:
//   - Budget.wallClockMs is IGNORED — the governor's ladder owns wall
//     clock; a driver-owned deadline would duplicate and race it.
//   - No retries, ever: exactly ONE spawn per run (attempts are the
//     runner/governor's business — a retry here would hide attempts).
//
// ROUTING (./routing.ts): ModelSpec → env-based route over a serializable
// RoutingTable (default: zai / deepseek / anthropic anthropic-compat
// endpoints, as-of 2026-09). The endpoint is injected purely through env
// (ANTHROPIC_BASE_URL + auth-token vars); the model rides `--model`. The
// DEEPSEEK SILENT-REMAP FOOTGUN is enforced in routeFor: a model name not
// on the endpoint allowlist THROWS before dispatch (gateways silently serve
// their default model for unknown names — a poisoned fact we refuse to
// create). Key VALUES are read from the environment at run() time; a
// missing one throws pre-dispatch. Routes carry var NAMES only, never
// secrets.
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
//   --json-schema <json>        only when the constructor's outputSchema is
//                               set (zod→JSON Schema via z.toJSONSchema;
//                               the OpInvocation seam cannot carry a schema,
//                               so per-op registries stay a later lane)
//   --tools ""                  harness mode (default): every CLI builtin
//                               is REMOVED from the surface (absent, not
//                               denied — RS-1/RS-1b b1/b5)
//   --setting-sources ""        harness mode: no ambient HOME/project
//                               settings (canary allow rules stay inert)
//   --strict-mcp-config         harness mode: no ambient MCP servers
//   --mcp-config <file>         harness mode, non-empty selection only: the
//                               per-run config launching `cq-harness-mcp`
//                               (`<sessionsDir>/<sessionId>.cq-harness-
//                               mcp.json`, O_EXCL + 0600, deleted once init
//                               reports the server connected, again at
//                               settle)
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
//   --model <route.model>       the routed, allowlist-verified model id
//   --resume <cli-session-id>   only on sessionRef resume, when the record
//                               carries a CLI session marker (below)
//
// CLOSED TOOL SURFACE (W1.4 — RS-12 design, ADR-0002 Annex A.4). The
// harness executors now run on this lane too: the CLI's only tools are the
// harness's, served over stdio by `cq-harness-mcp` (src/harness/mcp/) —
// the SAME shared core (src/harness/surface.ts) claude-agent serves
// in-process. The driver authors the manifest (workspace realpath, sandbox,
// selection, harness config, env names); the server re-validates it,
// scrubs its env to the default child-env allowlist + envAllowlist names
// (route credentials never reach `run` children's env), and enforces
// containment, allowlists and the read-only mapping. Fail-closed on three
// fronts, each settling stopReason 'error' with a `HARNESS_ERROR_PREFIX`
// cause and an `errorClass: 'harness'` narration marker (ADR-0002 §2.2's
// enum field lands with the W3.3 types bump):
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
// directly constructed driver only — never a factory or plan key.
//
// TRUST STATEMENT (issue #28's subprocess half). Harness mode: the harness
// enforces the TOOL-level sandbox mapping (read-only denials, workspace
// containment, allowlists); OS confinement stays unenforced, so a
// requested level with a non-empty surface records `{cq:
// 'sandbox-level-unenforced', level, layer: 'os'}`. `run` commands keep
// HOST privileges (the harness trust boundary, tools.ts). Stock mode: the
// CLI's own permission model governs; the legacy `sandbox-level-
// unenforced` marker (no layer) records that nothing was enforced here.
//
// SESSIONS (I6, OUR vocabulary — src/harness/session.ts):
//   - NO sessionRef → tempWorkspace() + SessionStore.create(): a fresh
//     scratch dir and a fresh record; the CLI runs with cwd = workspace.
//   - sessionRef → SessionStore.load (unknown → THROW pre-dispatch: a fake
//     resume is worse than a loud one); the SAME workspace continues, and
//     `--resume` continues the CLI-side conversation using the CLI session
//     id recorded in the SESSIONS-STORE sidecar `<sessionsDir>/
//     <sessionId>.cq-cli-session` (below). A session without a sidecar
//     (prior run died before the CLI reported a session) resumes the
//     WORKSPACE only: no --resume flag, an honest partial continuation.
//   - WHY A SIDECAR, and why it lives in the STORE, not the workspace
//     (issue #26, candidate design (b)): role 'tool' in a session record
//     means A TOOL RAN — that is the contract the shared conformance suite
//     observes (mode 'none' must leave a record with zero tool-role
//     messages), so the CLI session handle must not masquerade as one. And
//     it must not live in the WORKSPACE either: the workspace is
//     MODEL-VISIBLE — the earlier placement there was a tamper vector (the
//     model could read or alter its own resume handle through the very
//     tools the policy hands it). Relocated beside the session records and
//     keyed by sessionId, the handle is exactly as precise and no longer
//     reachable by the model. Our vocabulary never becomes vendor
//     vocabulary either way.
//   - Persisted per run, post-settle: the user prompt, ONE role 'tool'
//     message PER IN-POLICY CLI TOOL EXECUTION (toolName = the harness name
//     — `mcp__cq-harness__read` is recorded as `read`; stock mode: the CLI
//     tool name; content = { input, ok, output } in plain-JSON
//     our-vocabulary),
//     the assistant transcript text (when any), and non-JSON stdout lines
//     + stderr as narration (toolName 'cli-narration'). OUT-OF-POLICY tool
//     activity is narration-only: the record reflects the governed tool
//     surface (what --allowedTools pre-approved), never a tool the policy
//     withheld.
//
// EVENT → SEAM MAPPING (stream-json, parsed defensively — a non-JSON line
// or unknown event shape becomes narration, never a crash):
//   {type:'system', subtype:'init', session_id}  → CLI session id (marker)
//   {type:'system', subtype:'init', model}       → servedModel → WorkerResult.model
//   {type:'assistant', message:{content:[…], usage}} → text blocks →
//                              transcript; tool_use blocks remembered by id
//                              → tool names; usage folded (fallback usage)
//   {type:'user', message:{content:[{type:'tool_result', tool_use_id,
//                              is_error, content}]}}  → tool activity
//                              (in-policy tools become role 'tool' record
//                              messages); an is_error one is additionally
//                              a permission/execution DENIAL {tool, reason}
//                              (frozen ToolDenial shape), deduped per
//                              tool_use id
//   {type:'result', subtype, is_error, session_id, usage:{input_tokens,
//                              output_tokens, cache_read_input_tokens,
//                              cache_creation_input_tokens},
//                              structured_output}  → frozen Usage;
//                              structuredOutput (when --json-schema);
//                              the terminal status
//   {type:'result', model}      → servedModel → WorkerResult.model (init
//                              first; the result event may overwrite/confirm)
//   anything else               → narration (collected, persisted)
//
// STOP REASON (frozen DriverStopReason) — mapping table, checked in order:
//   1. governed signal fired (the ladder terminated the child) → 'aborted'
//   2. real usage folded ≥ Budget.maxTokens → 'budget'
//   3. result event present: subtype 'success' (and is_error ≠ true)
//      → 'complete'; any other result status → 'error'
//   4. no result event (spawn failure, nonzero exit, silent death) → 'error'
// Once spawned, run() NEVER throws: every failure lands in an honest
// 'error' verdict carrying the sessionId + denials gathered so far — and a
// SYNCHRONOUS SPAWN FAILURE is a verdict too (issue #19): a spawnImpl that
// throws (empty argv → ERR_INVALID_ARG_TYPE, a hostile test override)
// returns stopReason 'error' with the spawn error recorded as narration,
// never a rejection. A spawn failure reports zero usage (nothing was
// measured); an 'error' verdict from a real result event KEEPS the
// CLI-reported usage (real evidence). Every 'error' verdict also POPULATES
// WorkerResult.error (bounded + secret-redacted, issue #208): the CLI result
// event's own cause, else the child's exit code/signal or spawn error, plus
// the retained stderr tail — so a 0-token failure is diagnosable from the
// journal instead of an unexplained "driver reported no cause".
// Only PRE-DISPATCH validation throws
// (unknown model — the routing footgun; missing key env; unknown
// sessionRef; a non-positive Budget.maxTokens; invalid grace windows or
// binary template at construction; a schema that cannot become JSON Schema
// — the last at construction).
//
// BUDGET — the subprocess floor is honest about what a headless CLI cannot
// do: there is NO mid-run token hook, so Budget.maxTokens is enforced only
// against the FOLDED result usage (pre-verdict check — it can classify a
// finished run 'budget' but cannot stop one early; stopping early on tokens
// is the governor's/admission's business). maxUsd is caller-side derived
// accounting; maxAttempts is the runner's; wallClockMs is the governor's.
//
// COST (DD-2, derived-only): costUSD is computed over the OBSERVED served
// model id ({ ...modelSpec, model: servedModel ?? modelSpec.model }; the
// provider handle stays ModelSpec.provider — the price table's key), so a
// gateway that silently remaps is priced off the id the CLI actually
// reported — present only when the price map knows that id (overridable via
// the `pricing` constructor option, same arithmetic over the injected
// rates), and only on a verdict carrying REAL usage. A served/reported
// mismatch with the requested id is recorded as a served-model-mismatch
// narration marker (observable, issue #19) — the conformance suite fails a
// mismatching run loudly; production runs record it and price off the
// served id. Error/abort verdicts without a measurement report NO costUSD:
// 0 would be a fabricated fact. The derived figure is api-equivalent
// (modeled — list price for the tokens consumed), never presented as billed
// (DD-9; docs/dd-9-api-equivalent-budget.md).
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { currentJobContext } from '../../kernel/governor.js';
import { defaultHarnessConfig } from '../../harness/config.js';
import type { HarnessConfig } from '../../harness/config.js';
import { buildTools } from '../../harness/tools.js';
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
import { stripMetaSchema } from '../json-schema.js';
import { boundedErrorText, describeError } from '../error-text.js';
import { computeCostUSD } from '../pricing/index.js';
import type { PerMillionRates } from '../pricing/index.js';
import type {
  Driver,
  ModelSpec,
  OpInvocation,
  ToolDenial,
  ToolPolicy,
  Usage,
  WorkerResult,
} from '../types.js';
import { RoutingTableSchema, defaultRoutingTable, routeFor } from './routing.js';
import type { Route, RoutingTable } from './routing.js';
import { spawnManaged, terminateGracefully } from './process.js';
import type { ManagedChild, ProcessClose, SpawnOptions, TerminationRungMarker } from './process.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * The file-name SUFFIX of the CLI-session sidecar — the `--resume` handle
 * for the NEXT run on the SAME sessionRef, stored as
 * `<sessionsDir>/<sessionId>.cq-cli-session` (issue #26, design (b)). A
 * sidecar, not a record message: role 'tool' in a session record means a
 * tool ran (header). And NOT in the workspace: the workspace is
 * model-visible — the earlier placement there let the model read or alter
 * its own resume handle (the tamper vector); beside the session records the
 * handle is out of its reach.
 */
export const CLI_SESSION_FILE = '.cq-cli-session';

/** Session-message toolName under which non-JSON stdout narration is recorded. */
export const NARRATION_TOOL = 'cli-narration';

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
 * CLI-internal tools the `claude` CLI adds to `init.tools` even under
 * `--tools ""`, pinned by the W1.4 live leg (A.5a, CLI 2.1.280): with
 * `--json-schema` the CLI injects exactly `StructuredOutput` (its native
 * structured-output tool, auto-approved). Nothing is added without it.
 */
export const CLI_STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/**
 * The stable leading text of every harness-classified error verdict
 * (`WorkerResult.error`). ADR-0002 §2.2's `errorClass: 'harness'` lands with
 * the seam-v2 types bump (W3.3); until then this prefix — and the
 * `errorClass: 'harness'` field on the narration marker — is the
 * machine-readable classification.
 */
export const HARNESS_ERROR_PREFIX = 'subprocess driver: harness failure';

/**
 * The tool surface the lane runs with:
 *   - 'harness' (default) — the CLOSED surface (W1.4): every CLI builtin is
 *     removed (`--tools ""`), ambient settings and MCP servers are ignored,
 *     and the only tools are the harness's, served by `cq-harness-mcp` and
 *     enforced by the shared core.
 *   - 'stock' — the NULL-HYPOTHESIS EVAL mode only (plan D6): the CLI's own
 *     builtin surface with the legacy argv, where `--allowedTools` carries
 *     harness names the CLI does not know (inert — RS-1 J2 C1) and NOTHING
 *     the harness enforces applies. An option of the DIRECTLY CONSTRUCTED
 *     driver only (ADVISORY, ADR-0002 §2.5) — never a factory or plan key.
 */
export type SubprocessToolSurface = 'harness' | 'stock';

/**
 * The spawn seam: `spawnManaged` by default; tests inject a fake (the
 * conformance suite's scripted CLI, slice 2) through the constructor's
 * `spawn` option.
 */
export type SpawnFn = (opts: SpawnOptions) => ManagedChild;

/** Constructor options — everything optional; defaults are production-real. */
export interface SubprocessDriverOptions {
  /**
   * The CLI to spawn: a bare command/path, or a full leading-argv template
   * (`['claude', '--fallback-flag']`). Default 'claude'.
   */
  binary?: string | readonly string[];
  /**
   * Structured-output schema (data-driven). When set, the CLI is invoked
   * with `--json-schema <zod→JSON Schema>` and the result event's
   * structured_output is validated against this schema before it lands in
   * WorkerResult.structuredOutput (a payload that fails is dropped to
   * narration, never trusted). Per-op schema registries are a later-lane
   * concern (the frozen OpInvocation cannot carry a schema).
   */
  outputSchema?: ZodType;
  /** Routing table override (default: defaultRoutingTable — as-of 2026-09 provider docs). */
  routingTable?: RoutingTable;
  /** SIGTERM→SIGKILL grace in ms (default: process.ts's DEFAULT_TERM_GRACE_MS). */
  termGraceMs?: number;
  /** SIGKILL→force-resolve grace in ms (default: process.ts's DEFAULT_KILL_GRACE_MS). */
  killGraceMs?: number;
  /** Sessions directory for the backing SessionStore. Default: <os.tmpdir()/cq-harness>/sessions. */
  sessionsDir?: string;
  /** Harness config — the tool surface mapped onto --allowedTools + the temp-workspace root. Default: defaultHarnessConfig. */
  harnessConfig?: HarnessConfig;
  /**
   * Price-lookup override for the derived-only costUSD rule (default:
   * `computeCostUSD` over the vendored models.dev table via `priceOf`).
   * A lookup returning undefined keeps costUSD absent.
   */
  pricing?: (modelSpec: ModelSpec) => PerMillionRates | undefined;
  /**
   * Extra parent-env NAMES copied into every spawned CLI worker on top of
   * the default-deny allowlist (issue #183). Everything else in the entry
   * process env stays out: a GH_TOKEN or repo secret is NOT inherited unless
   * a Route's auth plan injects it explicitly or it is named here. Names
   * only, never values.
   */
  envAllowlist?: readonly string[];
  /**
   * The tool surface (see SubprocessToolSurface). Default 'harness' — the
   * closed surface. 'stock' exists for null-hypothesis evals only and is
   * reachable solely by constructing this class directly.
   */
  toolSurface?: SubprocessToolSurface;
  /** Spawn override hook for tests. Default: the real spawnManaged. */
  spawn?: SpawnFn;
}

/**
 * The subprocess driver on the frozen Driver seam. One instance is
 * stateless across runs — all per-run state (session record, event
 * observation, denials) lives in the run call — so a single instance can
 * serve many isolated invocations.
 */
export class SubprocessDriver implements Driver {
  private readonly binary: readonly string[];
  /** The constructor's original schema — the settle-time structured_output check parses against it. */
  private readonly outputSchema: ZodType | undefined;
  private readonly outputJsonSchema: string | undefined;
  private readonly routingTable: RoutingTable;
  private readonly termGraceMs: number | undefined;
  private readonly killGraceMs: number | undefined;
  private readonly sessionsDir: string | undefined;
  private readonly harnessConfig: HarnessConfig;
  private readonly pricingOverride:
    | ((modelSpec: ModelSpec) => PerMillionRates | undefined)
    | undefined;
  private readonly envAllowlist: readonly string[] | undefined;
  private readonly toolSurface: SubprocessToolSurface;
  private readonly spawnImpl: SpawnFn;

  constructor(options: SubprocessDriverOptions = {}) {
    this.binary =
      typeof options.binary === 'string' ? [options.binary] : (options.binary ?? ['claude']);
    // An empty binary template cannot spawn anything — invalid argv would
    // only explode at spawn time (post-dispatch). Validate HERE, loudly.
    if (this.binary.length === 0 || this.binary.some((part) => part === '')) {
      throw new Error(
        `subprocess driver: binary must be a non-empty string or a non-empty array of non-empty strings, got ${JSON.stringify(options.binary)}`,
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
        `subprocess driver: envAllowlist entries must be env var names matching /^[A-Za-z_][A-Za-z0-9_]*$/, got ${JSON.stringify(options.envAllowlist)}`,
      );
    }
    // zod→JSON Schema at CONSTRUCTION: an unrepresentable schema is a loud
    // config error before any run, not a mid-dispatch surprise. The original
    // zod schema is retained alongside the serialized form — the CLI's
    // structured_output is validated against it post-settle (below).
    this.outputSchema = options.outputSchema;
    this.outputJsonSchema =
      options.outputSchema === undefined
        ? undefined
        : JSON.stringify(stripMetaSchema(z.toJSONSchema(options.outputSchema)));
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
        throw new Error(`subprocess driver: ${name} must be an integer >= 0, got ${String(value)}`);
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
        `subprocess driver: toolSurface must be 'harness' or 'stock', got ${JSON.stringify(options.toolSurface)}`,
      );
    }
    this.toolSurface = options.toolSurface ?? 'harness';
    this.spawnImpl = options.spawn ?? spawnManaged;
  }

  /** The frozen seam: run one invocation to completion. */
  async run(opInvocation: OpInvocation): Promise<WorkerResult> {
    const { prompt, modelSpec, toolPolicy, sandboxPolicy, sessionRef, budget } = opInvocation;

    // --- Pre-dispatch validation: everything here throws BEFORE the CLI is
    // spawned and (except routing/key checks) before any session exists.
    const route = routeFor(modelSpec, this.routingTable); // unknown provider/model → the footgun throw
    const childEnv = this.resolveChildEnv(route); // missing key env → throw
    if (
      budget.maxTokens !== undefined &&
      (!Number.isFinite(budget.maxTokens) || budget.maxTokens <= 0)
    ) {
      throw new Error(
        `subprocess driver: budget.maxTokens must be a finite number > 0, got ${String(budget.maxTokens)}`,
      );
    }

    // --- I6 isolation: fresh record + fresh workspace, or a real resume. --
    const sessionsDir = this.sessionsDir ?? defaultSessionsDir();
    const store = new SessionStore(sessionsDir);
    const record =
      sessionRef === undefined
        ? await store.create(await tempWorkspace(this.harnessConfig.workspaceRoot))
        : await loadSessionOrThrow(store, sessionRef);
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
      allowed = selectToolNames(
        buildTools(this.harnessConfig, workspace, sandboxPolicy.level).map((t) => t.name),
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

    // --- CLI-level resume: the CLI session id recorded in the SESSIONS ---
    // STORE sidecar by a prior run (absent → workspace-only continuation).
    const resumeCliSessionId = await readCliSessionId(sessionsDir, record.sessionId);

    // --- The per-run MCP config (harness mode, non-empty selection):
    // created exclusively, 0600, beside the session records.
    const mcpConfigPath =
      manifest === undefined
        ? undefined
        : await writeMcpConfig(sessionsDir, record.sessionId, manifest);

    const argv = buildArgs({
      route,
      toolSurface: this.toolSurface,
      allowedToolNames: stock ? allowed : allowed.map(qualifiedToolName),
      mcpConfigPath,
      outputJsonSchema: this.outputJsonSchema,
      resumeCliSessionId,
    });

    // --- Governed cancellation (I8): checked before the spawn (an already-
    // cancelled invocation never spawns), then forwarded to the ladder —
    // the driver decides nothing about WHEN.
    const governed = currentJobContext();
    const signal = governed?.signal;
    if (signal?.aborted === true) {
      await removeMcpConfig(mcpConfigPath);
      return {
        usage: zeroUsage(),
        sessionId: record.sessionId,
        denials: [],
        stopReason: 'aborted',
      };
    }

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
        internalTools: this.outputJsonSchema === undefined ? [] : [CLI_STRUCTURED_OUTPUT_TOOL],
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
          toolName: NARRATION_TOOL,
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
        error: boundedErrorText(`subprocess driver: spawn failed — ${describeError(err)}`),
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

    // Structured_output is the one vendor field that becomes seam data, so
    // when a schema was configured it must survive that schema before it can
    // reach a verdict — the CLI is a vendor boundary, and a payload that
    // fails is dropped and its rejection recorded as narration, never
    // trusted (the ai-sdk lane gets the same guarantee from Output.object).
    const rawStructured = observation.result?.['structured_output'];
    if (
      this.outputSchema !== undefined &&
      observation.result !== undefined &&
      rawStructured !== undefined
    ) {
      const check = this.outputSchema.safeParse(rawStructured);
      if (check.success) {
        observation.result['structured_output'] = check.data;
      } else {
        delete observation.result['structured_output'];
        observation.narration.push(
          JSON.stringify({
            cq: 'structured-output-rejected',
            issues: check.error.issues.length,
            paths: check.error.issues.map((issue) => issue.path.map(String).join('.')),
          }),
        );
      }
    }

    // The served model is OBSERVED, never requested: when the CLI reports a
    // different id than ModelSpec.model asked for, the mismatch is recorded
    // as narration (issue #19 — the corruption is now observable). The
    // conformance suite fails a mismatching run loudly (leg m); production
    // runs record the mismatch and price off the served id (below).
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

    return this.verdict(modelSpec, budget, observation, record.sessionId, aborted);
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
    for (const [childVar, hostVar] of Object.entries(route.env)) {
      const value = process.env[hostVar];
      if (value === undefined || value === '') {
        throw new Error(
          `subprocess driver: route to '${route.endpoint}' requires ${hostVar} in the environment`,
        );
      }
      childEnv[childVar] = value;
    }
    return childEnv;
  }

  /**
   * Fold the observation into the frozen WorkerResult (header tables:
   * stop reasons, cost, usage). Real usage (CLI-reported) is kept on any
   * verdict that observed it; unmeasured verdicts (spawn failure, abort)
   * report zeros and NEVER a cost. A served/reported model mismatch with
   * the requested id is the narration marker's business (run()); the
   * PRICING here keys on the served id either way (issue #24).
   */
  private verdict(
    modelSpec: ModelSpec,
    budget: OpInvocation['budget'],
    observation: RunObservation,
    sessionId: string,
    aborted: boolean,
  ): WorkerResult {
    const measured =
      observation.result !== undefined ? usageFromCli(observation.result.usage) : undefined;
    const usage = measured ?? observation.assistantUsage ?? zeroUsage();
    const structured =
      observation.result === undefined ? undefined : observation.result.structured_output;
    const stopReason = stopReasonOf({
      aborted,
      harnessFailure: observation.harnessFailure !== undefined,
      maxTokens: budget.maxTokens,
      usage,
      resultStatus: resultStatusOf(observation.result),
    });
    // The error field is present ONLY on a driver-level failure verdict (the
    // frozen contract allows `error` only with stopReason 'error'): the cause
    // is derived from the result frame, else the child's exit evidence, else
    // the narration tail — a bare 'error' tells the caller nothing (issue
    // #208, mirroring the claude-agent derivation).
    let error: string | undefined;
    if (stopReason === 'error') {
      error = errorCauseOf(observation);
      if (observation.stderr.length > 0) {
        error = `${error}; stderr: ${observation.stderr.slice(-3).join(' | ')}`;
      }
      error = boundedErrorText(error);
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
        : costField(this.costUSDOf.bind(this), pricedModel, usage);
    return {
      // The observed served model: what the endpoint reports it served, not
      // what ModelSpec.model requested (the remap-detection fact, header).
      ...(observation.servedModel !== undefined ? { model: observation.servedModel } : {}),
      ...(structured !== undefined ? { structuredOutput: structured } : {}),
      usage,
      ...cost,
      sessionId,
      denials: observation.denials,
      stopReason,
      ...(error !== undefined ? { error } : {}),
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
// Module-level helpers — pure, exported only where slice-2 tests need them
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp for session messages. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Default sessions dir (sibling of the harness temp-workspace root). */
function defaultSessionsDir(): string {
  return join(tmpdir(), 'cq-harness', 'sessions');
}

/** Load a sessionRef for resume; unknown sessions throw (a fake resume is worse than a loud error). */
async function loadSessionOrThrow(store: SessionStore, sessionRef: string): Promise<SessionRecord> {
  const record = await store.load(sessionRef);
  if (record === undefined) {
    throw new Error(
      `subprocess driver: unknown sessionRef '${sessionRef}' — no recorded session to resume`,
    );
  }
  return record;
}

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
  const path = join(sessionsDir, `${sessionId}.${randomUUID()}${HARNESS_MCP_CONFIG_FILE}`);
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
  toolSurface?: SubprocessToolSurface;
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
interface RunObservation {
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
 * CLI-reported numeric fields must be finite non-negative INTEGERS: a
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

/** The CLI usage vocabulary → frozen Usage (missing numeric fields map to 0). */
export function usageFromCli(raw: unknown): Usage | undefined {
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
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
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
      const usage = usageFromCli(message['usage']);
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
        // Harness names in OUR vocabulary (the claude-agent lane's too).
        const tool = harnessToolName(rawName);
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
  const cliSessionId = observation.cliSessionId;
  if (cliSessionId !== undefined && cliSessionId !== resumeCliSessionId) {
    // Best-effort: the sidecar is the NEXT run's --resume handle; a failed
    // write costs a workspace-only continuation, never this run's verdict.
    // Stored beside the session records, keyed by sessionId (issue #26) —
    // NOT in the model-visible workspace (the tamper vector, header) — and
    // 0o600 like the records it sits beside (never world-readable).
    try {
      await writeFile(
        join(store.sessionsDir, `${record.sessionId}${CLI_SESSION_FILE}`),
        `${cliSessionId}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    } catch {
      // deliberately swallowed — resume degrades honestly (no --resume flag)
    }
  }
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
            ? harnessToolName(rawName)
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
  const diagnostics = [...observation.narration, ...observation.stderr.map((l) => `[stderr] ${l}`)];
  if (diagnostics.length > 0) {
    const message: SessionMessage = {
      role: 'tool',
      toolName: NARRATION_TOOL,
      content: JSON.stringify(diagnostics),
      at: nowIso(),
    };
    await store.appendMessage(record.sessionId, message);
  }
}

/**
 * The CLI session id recorded by a prior run of THIS session — the
 * `--resume` argument of the current run — read from the relocated store
 * sidecar `<sessionsDir>/<sessionId>.cq-cli-session` (issue #26). Missing/
 * unreadable → undefined (an honest workspace-only continuation, never a
 * fabricated resume).
 */
async function readCliSessionId(
  sessionsDir: string,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(join(sessionsDir, `${sessionId}${CLI_SESSION_FILE}`), 'utf8');
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined; // no sidecar — nothing to resume CLI-side
  }
}

/** The terminal result event's status class for the stop-reason table. */
export type ResultStatus = 'success' | 'error' | 'none';

/** 'success' iff the result event says so; anything else (or no event) is not. */
export function resultStatusOf(result: ResultEvent | undefined): ResultStatus {
  if (result === undefined) return 'none';
  if (result['is_error'] === true) return 'error';
  return asString(result['subtype']) === 'success' ? 'success' : 'error';
}

/**
 * The error CAUSE for an 'error' verdict (issue #208): what actually went
 * wrong, in precedence order — a failed result frame's own `result` string,
 * then its joined `errors` entries, then its subtype; else the child's spawn
 * error, else its exit code or terminating signal, else the narration tail.
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
    return `subprocess driver: result event error — ${cause}`;
  }
  const close = observation.close;
  if (close?.spawnError !== undefined) {
    return `subprocess driver: spawn failed — ${describeError(close.spawnError)}`;
  }
  if (close !== undefined && (close.code !== 0 || close.signal !== null)) {
    if (close.signal !== null) {
      return `subprocess driver: CLI killed by signal ${String(close.signal)}`;
    }
    return `subprocess driver: CLI exited with code ${String(close.code)}`;
  }
  const narration = observation.narration.at(-1);
  return narration !== undefined && narration !== ''
    ? `subprocess driver: no result event — ${narration}`
    : 'subprocess driver: no result event';
}

/** Σ of the frozen Usage fields — the fold Budget.maxTokens is checked against. */
function totalTokensOf(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite + (usage.reasoning ?? 0);
}

/** Unmeasured usage: the honest zero (it means "not measured", never "nothing spent"). */
function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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
  /** A harness failure terminated or invalidated the run (always an 'error'). */
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
  if (inputs.resultStatus !== 'success') return 'error';
  return 'complete';
}
