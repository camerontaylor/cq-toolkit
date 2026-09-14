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
//   --allowedTools <names>      ALWAYS present: the harness tool surface
//                               (buildTools names) ∩ the frozen ToolPolicy —
//                               'allowlist' (default) → policy.allow ∩
//                               harness, 'unrestricted' → all harness names,
//                               'none' → an EMPTY value (nothing
//                               pre-approved). Headless -p mode CANNOT
//                               PROMPT: a tool outside --allowedTools is
//                               DENIED by the CLI (never prompted, never
//                               hung) — those denials are the CLI-side
//                               source of WorkerResult.denials. NO
//                               UNDOCUMENTED FLAGS (issue #19):
//                               `--permission-prompts none` and `--bare`
//                               were removed — the real CLI rejects them at
//                               parse.
//   --model <route.model>       the routed, allowlist-verified model id
//   --resume <cli-session-id>   only on sessionRef resume, when the record
//                               carries a CLI session marker (below)
//
// TRUST STATEMENT (issue #28's subprocess half): sandboxPolicy governs the
// tool-NAME surface only — the harness sandbox/path/output restrictions are
// NOT enforced by this driver. The CLI is an independent process with its
// own permission model: run/sandbox confinement is the host CLI's business
// (--allowedTools controls WHICH tools may run, never where or how). When
// sandboxPolicy.level is not 'none' AND a tool surface was actually
// exposed, the run records a `sandbox-level-unenforced` narration marker so
// the unenforced request is observable per run (a mode-'none' run exposes
// NOTHING pre-approved — headless-denied — so there is nothing unenforced
// to observe, and the shared conformance contract pins such records to zero
// tool-role messages).
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
// CLI-reported usage (real evidence). Only PRE-DISPATCH validation throws
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
  private readonly pricingOverride: ((modelSpec: ModelSpec) => PerMillionRates | undefined) | undefined;
  private readonly spawnImpl: SpawnFn;

  constructor(options: SubprocessDriverOptions = {}) {
    this.binary = typeof options.binary === 'string' ? [options.binary] : options.binary ?? ['claude'];
    // An empty binary template cannot spawn anything — invalid argv would
    // only explode at spawn time (post-dispatch). Validate HERE, loudly.
    if (this.binary.length === 0 || this.binary.some((part) => part === '')) {
      throw new Error(
        `subprocess driver: binary must be a non-empty string or a non-empty array of non-empty strings, got ${JSON.stringify(options.binary)}`,
      );
    }
    // zod→JSON Schema at CONSTRUCTION: an unrepresentable schema is a loud
    // config error before any run, not a mid-dispatch surprise. The original
    // zod schema is retained alongside the serialized form — the CLI's
    // structured_output is validated against it post-settle (below).
    this.outputSchema = options.outputSchema;
    this.outputJsonSchema =
      options.outputSchema === undefined ? undefined : JSON.stringify(z.toJSONSchema(options.outputSchema));
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
    const sessionsDir = this.sessionsDir ?? defaultSessionsDir();
    const store = new SessionStore(sessionsDir);
    const record =
      sessionRef === undefined
        ? await store.create(await tempWorkspace(this.harnessConfig.workspaceRoot))
        : await loadSessionOrThrow(store, sessionRef);
    const workspace = record.workspace;

    await store.appendMessage(record.sessionId, { role: 'user', content: prompt, at: nowIso() });

    // --- Tool surface: harness names ∩ per-op ToolPolicy → --allowedTools.
    const harnessNames = buildTools(this.harnessConfig, workspace, sandboxPolicy.level).map((t) => t.name);
    const allowed = allowedToolNames(harnessNames, toolPolicy);

    // --- Trust statement (header): sandboxPolicy names the tool surface ---
    // only; THIS driver does not enforce a sandbox level. When a level was
    // requested AND a tool surface was actually exposed, record that the
    // level went unenforced here (per-run, observable).
    const sandboxUnenforced = sandboxPolicy.level !== 'none' && allowed.length > 0;

    // --- CLI-level resume: the CLI session id recorded in the SESSIONS ---
    // STORE sidecar by a prior run (absent → workspace-only continuation).
    const resumeCliSessionId = await readCliSessionId(sessionsDir, record.sessionId);

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

    // --- The one spawn. From here on, run() NEVER throws past the seam —
    // including the spawn itself: a SYNCHRONOUS spawnImpl failure (empty
    // argv → ERR_INVALID_ARG_TYPE, a hostile override) is an 'error'
    // VERDICT, not a rejection (issue #19).
    const observation = newObservation();
    if (sandboxUnenforced) {
      observation.narration.push(
        JSON.stringify({ cq: 'sandbox-level-unenforced', level: sandboxPolicy.level }),
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
      });
    } catch (err) {
      // Best-effort narration first (the same swallow rule as persistence:
      // the verdict outranks the record), then the honest error verdict.
      try {
        await store.appendMessage(record.sessionId, {
          role: 'tool',
          toolName: NARRATION_TOOL,
          content: JSON.stringify([
            JSON.stringify({ cq: 'spawn-failed', error: err instanceof Error ? err.message : String(err) }),
          ]),
          at: nowIso(),
        });
      } catch {
        // deliberately swallowed — the verdict still reaches the caller
      }
      return { usage: zeroUsage(), sessionId: record.sessionId, denials: [], stopReason: 'error' };
    }

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

    // Structured_output is the one vendor field that becomes seam data, so
    // when a schema was configured it must survive that schema before it can
    // reach a verdict — the CLI is a vendor boundary, and a payload that
    // fails is dropped and its rejection recorded as narration, never
    // trusted (the ai-sdk lane gets the same guarantee from Output.object).
    const rawStructured = observation.result?.['structured_output'];
    if (this.outputSchema !== undefined && observation.result !== undefined && rawStructured !== undefined) {
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
        JSON.stringify({ cq: 'served-model-mismatch', requested: modelSpec.model, served: observation.servedModel }),
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
    '--output-format', 'stream-json',
    // The real CLI refuses `-p --output-format stream-json` without
    // --verbose (found live against CLI 2.1.270, T1.6 slice 4) — always
    // emitted so stream-json parses on every lane.
    '--verbose',
  ];
  if (inputs.outputJsonSchema !== undefined) {
    args.push('--json-schema', inputs.outputJsonSchema);
  }
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
    servedModel: undefined,
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
      observation.servedModel = asString(event['model']) ?? observation.servedModel;
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
 * The CLI session id recorded by a prior run of THIS session — the
 * `--resume` argument of the current run — read from the relocated store
 * sidecar `<sessionsDir>/<sessionId>.cq-cli-session` (issue #26). Missing/
 * unreadable → undefined (an honest workspace-only continuation, never a
 * fabricated resume).
 */
async function readCliSessionId(sessionsDir: string, sessionId: string): Promise<string | undefined> {
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
