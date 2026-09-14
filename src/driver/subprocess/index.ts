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
//   --json-schema <json>        only when the constructor's outputSchema is
//                               set (zod→JSON Schema via z.toJSONSchema;
//                               the OpInvocation seam cannot carry a schema,
//                               so per-op registries stay a later lane)
//   --allowedTools <names>      ALWAYS present: the harness tool surface
//                               (buildTools names) ∩ the frozen ToolPolicy —
//                               'allowlist' (default) → policy.allow ∩
//                               harness, 'unrestricted' → all harness names,
//                               'none' → an EMPTY value (nothing
//                               pre-approved; combined with
//                               --permission-prompts none every tool call
//                               is denied — never prompted, never hung)
//   --permission-prompts none   headless: a tool outside --allowedTools is
//                               auto-DENIED; these denials are the CLI-side
//                               source of WorkerResult.denials
//   --bare                      minimal non-interactive operation
//   --model <route.model>       the routed, allowlist-verified model id
//   --resume <cli-session-id>   only on sessionRef resume, when the record
//                               carries a CLI session marker (below)
//
// SESSIONS (I6, OUR vocabulary — src/harness/session.ts):
//   - NO sessionRef → tempWorkspace() + SessionStore.create(): a fresh
//     scratch dir and a fresh record; the CLI runs with cwd = workspace.
//   - sessionRef → SessionStore.load (unknown → THROW pre-dispatch: a fake
//     resume is worse than a loud one); the SAME workspace continues, and
//     `--resume` continues the CLI-side conversation using the CLI session
//     id recorded in the workspace sidecar file `.cq-cli-session` (below).
//     A workspace without a sidecar (prior run died before the CLI reported
//     a session) resumes the WORKSPACE only: no --resume flag, an honest
//     partial continuation.
//   - WHY A SIDECAR, not a record message: role 'tool' in a session record
//     means A TOOL RAN — that is the contract the shared conformance suite
//     observes (mode 'none' must leave a record with zero tool-role
//     messages), so the CLI session handle must not masquerade as one. The
//     sidecar is plain data (the CLI session id) inside the invocation's
//     OWN workspace — it exists exactly where the resume it enables lives,
//     and a fresh workspace carries none. Our vocabulary never becomes
//     vendor vocabulary either way.
//   - Persisted per run, post-settle: the user prompt, ONE role 'tool'
//     message PER IN-POLICY CLI TOOL EXECUTION (toolName = the CLI tool
//     name; content = { input, ok, output } in plain-JSON our-vocabulary),
//     the assistant transcript text (when any), and non-JSON stdout lines
//     + stderr as narration (toolName 'cli-narration'). OUT-OF-POLICY tool
//     activity is narration-only: the record reflects the governed tool
//     surface (what --allowedTools pre-approved), never a tool the policy
//     withheld.
//
// EVENT → SEAM MAPPING (stream-json, parsed defensively — a non-JSON line
// or unknown event shape becomes narration, never a crash):
//   {type:'system', subtype:'init', session_id}  → CLI session id (marker)
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
//   anything else               → narration (collected, persisted)
//
// STOP REASON (frozen DriverStopReason) — mapping table, checked in order:
//   1. governed signal fired (the ladder terminated the child) → 'aborted'
//   2. real usage folded ≥ Budget.maxTokens → 'budget'
//   3. result event present: subtype 'success' (and is_error ≠ true)
//      → 'complete'; any other result status → 'error'
//   4. no result event (spawn failure, nonzero exit, silent death) → 'error'
// Once spawned, run() NEVER throws: every failure lands in an honest
// 'error' verdict carrying the sessionId + denials gathered so far.
// A spawn failure reports zero usage (nothing was measured); an 'error'
// verdict from a real result event KEEPS the CLI-reported usage (real
// evidence). Only PRE-DISPATCH validation throws (unknown model — the
// routing footgun; missing key env; unknown sessionRef; a non-positive
// Budget.maxTokens; a schema that cannot become JSON Schema — the last at
// construction).
//
// BUDGET — the subprocess floor is honest about what a headless CLI cannot
// do: there is NO mid-run token hook, so Budget.maxTokens is enforced only
// against the FOLDED result usage (pre-verdict check — it can classify a
// finished run 'budget' but cannot stop one early; stopping early on tokens
// is the governor's/admission's business). maxUsd is caller-side derived
// accounting; maxAttempts is the runner's; wallClockMs is the governor's.
//
// COST (DD-2, derived-only): costUSD via computeCostUSD(modelSpec, usage)
// — present only when the price map knows the model (overridable via the
// `pricing` constructor option, same arithmetic over the injected rates),
// and only on a verdict carrying REAL usage. Error/abort verdicts without
// a measurement report NO costUSD: 0 would be a fabricated fact.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { currentJobContext } from '../../kernel/governor.js';
import { defaultHarnessConfig } from '../../harness/config.js';
import type { HarnessConfig } from '../../harness/config.js';
import { buildTools } from '../../harness/tools.js';
import { SessionStore, tempWorkspace } from '../../harness/session.js';
import type { SessionMessage, SessionRecord } from '../../harness/session.js';
import { computeCostUSD } from '../pricing/index.js';
import type { PerMillionRates } from '../pricing/index.js';
import type { Driver, ModelSpec, OpInvocation, ToolDenial, ToolPolicy, Usage, WorkerResult } from '../types.js';
import { RoutingTableSchema, defaultRoutingTable, routeFor } from './routing.js';
import type { Route, RoutingTable } from './routing.js';
import { spawnManaged, terminateGracefully } from './process.js';
import type { ManagedChild, SpawnOptions, TerminationRungMarker } from './process.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Workspace sidecar file carrying the CLI's own session id — the `--resume`
 * handle for the NEXT run on the SAME sessionRef. A sidecar, not a record
 * message: role 'tool' in a session record means a tool ran (header), so
 * the handle lives in the workspace it resumes.
 */
export const CLI_SESSION_FILE = '.cq-cli-session';

/** Session-message toolName under which non-JSON stdout narration is recorded. */
export const NARRATION_TOOL = 'cli-narration';

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
   * structured_output lands in WorkerResult.structuredOutput. Per-op schema
   * registries are a later-lane concern (the frozen OpInvocation cannot
   * carry a schema).
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
  private readonly outputJsonSchema: string | undefined;
  private readonly routingTable: RoutingTable;
  private readonly termGraceMs: number | undefined;
  private readonly killGraceMs: number | undefined;
  private readonly sessionsDir: string | undefined;
  private readonly harnessConfig: HarnessConfig;
  private readonly pricingOverride: ((modelSpec: ModelSpec) => PerMillionRates | undefined) | undefined;
  private readonly spawnImpl: SpawnFn;

  constructor(options: SubprocessDriverOptions = {}) {
    this.binary = typeof options.binary === 'string' ? [options.binary] : options.binary ?? ['claude'];
    // zod→JSON Schema at CONSTRUCTION: an unrepresentable schema is a loud
    // config error before any run, not a mid-dispatch surprise.
    this.outputJsonSchema =
      options.outputSchema === undefined ? undefined : JSON.stringify(z.toJSONSchema(options.outputSchema));
    // An invalid table throws HERE (construction is the closest thing to
    // compile time a data table has) — never silently at route time.
    this.routingTable = RoutingTableSchema.parse(options.routingTable ?? defaultRoutingTable());
    this.termGraceMs = options.termGraceMs;
    this.killGraceMs = options.killGraceMs;
    this.sessionsDir = options.sessionsDir;
    this.harnessConfig = options.harnessConfig ?? defaultHarnessConfig;
    this.pricingOverride = options.pricing;
    this.spawnImpl = options.spawn ?? spawnManaged;
  }

  /** The frozen seam: run one invocation to completion. */
  async run(opInvocation: OpInvocation): Promise<WorkerResult> {
    const { prompt, modelSpec, toolPolicy, sandboxPolicy, sessionRef, budget } = opInvocation;

    // --- Pre-dispatch validation: everything here throws BEFORE the CLI is
    // spawned and (except routing/key checks) before any session exists.
    const route = routeFor(modelSpec, this.routingTable); // unknown provider/model → the footgun throw
    const childEnv = this.resolveChildEnv(route); // missing key env → throw
    if (budget.maxTokens !== undefined && (!Number.isFinite(budget.maxTokens) || budget.maxTokens <= 0)) {
      throw new Error(
        `subprocess driver: budget.maxTokens must be a finite number > 0, got ${String(budget.maxTokens)}`,
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

    // --- Tool surface: harness names ∩ per-op ToolPolicy → --allowedTools.
    const harnessNames = buildTools(this.harnessConfig, workspace, sandboxPolicy.level).map((t) => t.name);
    const allowed = allowedToolNames(harnessNames, toolPolicy);

    // --- CLI-level resume: the CLI session id recorded in the workspace --
    // sidecar by a prior run (absent → workspace-only continuation).
    const resumeCliSessionId = await readCliSessionId(workspace);

    const argv = buildArgs({
      route,
      allowedToolNames: allowed,
      outputJsonSchema: this.outputJsonSchema,
      resumeCliSessionId,
    });

    // --- Governed cancellation (I8): checked before the spawn (an already-
    // cancelled invocation never spawns), then forwarded to the ladder —
    // the driver decides nothing about WHEN.
    const governed = currentJobContext();
    const signal = governed?.signal;
    if (signal?.aborted === true) {
      return { usage: zeroUsage(), sessionId: record.sessionId, denials: [], stopReason: 'aborted' };
    }

    // --- The one spawn. From here on, run() NEVER throws past the seam. ---
    const child = this.spawnImpl({
      command: this.binary[0] as string,
      args: [...this.binary.slice(1), ...argv],
      cwd: workspace,
      env: childEnv,
      stdin: prompt,
    });

    const observation = newObservation();
    let aborted = false;
    let terminationStarted = false;
    let finishTermination: (() => void) | undefined;
    const terminationDone = new Promise<void>((resolve) => {
      finishTermination = resolve;
    });
    const onAbort = (): void => {
      terminationStarted = true;
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
          aborted = true;
          observation.narration.push(JSON.stringify({ cq: 'termination', outcome }));
          finishTermination?.();
        },
        () => {
          aborted = true; // ladder failure must not hang the governed run
          finishTermination?.();
        },
      );
    };
    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.onStdoutLine((line) => handleStdoutLine(observation, line));
    child.onStderrLine((line) => observation.stderr.push(line));

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
   * secret value is ever read.
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
   * report zeros and NEVER a cost.
   */
  private verdict(
    modelSpec: ModelSpec,
    budget: OpInvocation['budget'],
    observation: RunObservation,
    sessionId: string,
    aborted: boolean,
  ): WorkerResult {
    const measured = observation.result !== undefined ? usageFromCli(observation.result.usage) : undefined;
    const usage = measured ?? observation.assistantUsage ?? zeroUsage();
    const structured =
      observation.result === undefined ? undefined : observation.result.structured_output;
    const stopReason = stopReasonOf({
      aborted,
      maxTokens: budget.maxTokens,
      usage,
      resultStatus: resultStatusOf(observation.result),
    });
    // Derived-only cost (DD-2): only on a verdict carrying a REAL usage
    // measurement — never on an unmeasured abort/spawn-failure verdict.
    const cost =
      measured === undefined && observation.assistantUsage === undefined
        ? {}
        : costField(this.costUSDOf.bind(this), modelSpec, usage);
    return {
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
    throw new Error(`subprocess driver: unknown sessionRef '${sessionRef}' — no recorded session to resume`);
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

/** Inputs to the argv builder — plain data. */
export interface ArgBuildInputs {
  route: Route;
  allowedToolNames: readonly string[];
  /** Serialized JSON Schema for --json-schema, when the schema option is set. */
  outputJsonSchema: string | undefined;
  /** CLI session id for --resume, when the record carries a marker. */
  resumeCliSessionId: string | undefined;
}

/**
 * THE ARGV (header table, in order). --allowedTools is ALWAYS emitted: an
 * empty joined value means "nothing pre-approved", which — combined with
 * --permission-prompts none — is exactly ToolPolicy mode 'none' (every tool
 * call denied, never prompted).
 */
export function buildArgs(inputs: ArgBuildInputs): string[] {
  const args: string[] = [
    '-p', // headless print mode; the prompt rides stdin
    '--output-format', 'stream-json',
  ];
  if (inputs.outputJsonSchema !== undefined) {
    args.push('--json-schema', inputs.outputJsonSchema);
  }
  args.push('--allowedTools', inputs.allowedToolNames.join(' '));
  args.push('--permission-prompts', 'none');
  args.push('--bare');
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
}

function newObservation(): RunObservation {
  return {
    cliSessionId: undefined,
    transcript: [],
    narration: [],
    stderr: [],
    assistantUsage: undefined,
    result: undefined,
    toolUseNameById: new Map(),
    toolUses: [],
    toolResults: [],
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
        return;
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
        const tool = observation.toolUseNameById.get(id) ?? 'unknown';
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
      return;
    }
    default:
      observation.narration.push(line);
  }
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
    try {
      await writeFile(join(record.workspace, CLI_SESSION_FILE), `${cliSessionId}\n`, 'utf8');
    } catch {
      // deliberately swallowed — resume degrades honestly (no --resume flag)
    }
  }
  for (const outcome of observation.toolResults) {
    const name = observation.toolUseNameById.get(outcome.toolUseId);
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
 * The CLI session id recorded in a prior run's workspace sidecar, if any —
 * the `--resume` argument of THIS run. Missing/unreadable → undefined (an
 * honest workspace-only continuation, never a fabricated resume).
 */
async function readCliSessionId(workspace: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(workspace, CLI_SESSION_FILE), 'utf8');
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

/** Σ of the frozen Usage fields — the fold Budget.maxTokens is checked against. */
function totalTokensOf(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite + (usage.reasoning ?? 0);
}

/** Unmeasured usage: the honest zero (it means "not measured", never "nothing spent"). */
function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Derived-only cost field: present only when the price lookup knows the model. */
function costField(
  costUSDOf: (modelSpec: ModelSpec, usage: Usage) => number | undefined,
  modelSpec: ModelSpec,
  usage: Usage,
): { costUSD?: number } {
  const costUSD = costUSDOf(modelSpec, usage);
  return costUSD === undefined ? {} : { costUSD };
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
  if (inputs.resultStatus !== 'success') return 'error';
  return 'complete';
}
