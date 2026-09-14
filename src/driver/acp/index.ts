// The acp driver — T1.8 (the FOURTH driver lane on the FROZEN Driver seam:
// run(opInvocation) → Promise<WorkerResult>). It speaks the Agent Client
// Protocol — newline-delimited JSON-RPC 2.0 over stdio — to a VENDOR
// HARNESS binary (`zcode-acp-server` by default; `dsh-acp` from
// @openma/deepseek-harness-acp as the fast-follow endpoint), and folds the
// wire into our seam vocabulary. The wire shapes are OURS
// (./protocol.ts — zero vendor imports, I10); the shapes were transcribed
// from LIVE probes recorded in docs/acp-driver-strategy.md.
//
// EXECUTION MODEL: out-of-process. ONE spawn per run, one ACP session, one
// prompt turn — no daemon, no pooling, NO RETRIES (attempts are the
// runner/governor's business). The vendor's tools execute in the VENDOR's
// process; our role is the ACP client and the permission authority. At
// settle the child is TERMINATED (the vendor's in-process session dies
// with the process — ./process.ts's ladder executes that decision).
//
// THE HANDSHAKE (exactly the strategy §1.2 subset, in order):
//   initialize { protocolVersion: 1, clientCapabilities: { fs false/false,
//     terminal false }, clientInfo } — the agent never declines; it answers
//     its latest (OQ-5, live-verified). A DIFFERENT integer than ours
//     fails the run pre-prompt with BOTH numbers in the record (our
//     "close" is killing the spawned child).
//   session/load { sessionId, cwd, mcpServers: [] } on a sessionRef whose
//     workspace sidecar carries a harness session id AND the agent
//     advertises loadSession; else unstable_resumeSession
//     { sessionId, cwd, mcpServers: [] } when sessionCapabilities.resume
//     is advertised (no history replay on this rung); else session/new
//     { cwd, mcpServers: [] } — the HONEST-PARTIAL rung (mcpServers never
//     omitted — the recorded Devin quirk generalizes to "keep the param
//     present"). History that replays via session/update BEFORE the load
//     response LINE is counted into a discard sink — none of it is this
//     run's observation; the fold restarts AT that line (cleared per
//     WIRE LINE, so a frame sharing the response's flush but arriving
//     after it post-dates the settle and folds — strategy §6). No
//     authenticate call, EVER: OQ-1 is
//     answered (no gate; the agent self-handles credentials); an
//     auth_required error fails the run naming the advertised authMethods.
//   session/set_config_option { configId: 'mode', value: 'build' } — THE
//     MODE PIN, before ANY prompt. Sessions open in `yolo`, which NEVER
//     ASKS (OQ-4, live-verified): an unpinned session is a policy void,
//     so a failed pin is a pre-prompt error verdict, never a degraded run.
//   session/prompt { sessionId, prompt: [text] } — fire-and-settle.
//
// TOOL POLICY → session/request_permission (the FULL answer table,
// strategy §2.1 — the declarative answer to an interactive ask; the
// user is never prompted, a headless worker cannot be an interactive
// authority). Decisions, per request:
//   mode 'none'                        → DENY everything ('tool policy: mode none')
//   sandbox 'read-only'                → DENY everything (fail-closed — this
//                                        lane has no read/write classification
//                                        it can trust: `kind` is ABSENT on the
//                                        reference vendor's request toolCall,
//                                        titles are vendor free-text; the
//                                        permission boundary is the ONLY
//                                        enforcement channel we own, so
//                                        read-only points it at maximum
//                                        caution. NOT filesystem containment —
//                                        §2.2's honesty stands)
//   mode 'unrestricted'                → ALLOW everything
//   mode 'allowlist' (the default)     → the request's matched tool IDENTITY
//                                        (the leading token of the title —
//                                        the probe showed `<toolName>:
//                                        <summary>`; `kind` falls back) ∈
//                                        policy.allow (case-insensitive) →
//                                        ALLOW, else DENY ('tool policy: not
//                                        allowlisted (kind …)')
// Answers, by KIND (optionIds are VENDOR STRINGS — "allow_once",
// "allow_project", "deny" on the reference vendor — the chosen option's
// OWN optionId is echoed): ALLOW → allow_once, else allow_always;
// DENY → reject_once, else reject_always. A deny with NO reject option
// offered FAILS THE RUN naming the offered options. 'cancelled' is
// answered on ONE occasion only — a REAL governed cancellation (the
// signal fired while the ask was pending) — never as a table decision.
// Every deny synthesizes the frozen {tool, reason} denial AT THE ANSWER
// (the one place both facts are known); a tool that EXECUTED and then
// failed (tool_call_update status 'failed') is a SECOND denial channel
// (reason = the vendor's rawOutput), deduped per toolCallId.
//
// THE NEVER-ASKS TRIWIRE (§2.1): the spec makes asking the AGENT's
// decision, so a protocol-legal vendor that executes tools WITHOUT asking
// is possible. The driver OBSERVES the tool_call stream: a tool_call (or
// tool_call_update) whose toolCallId was NEVER preceded by a
// session/request_permission for the same id is recorded as evidence of
// UNGATED EXECUTION and the verdict is 'error' — fail loud, because a
// policy that cannot be enforced is not silently soft. (Evaluation happens
// AT SETTLE, FIRST-WRITE-WINS per id: a tool_call that arrived BEFORE any
// gate for its id is the bypass evidence — a gate firing only afterward
// never reclassifies it — while an id whose gate fired FIRST stays gated,
// whatever arrives later.)
//
// USAGE (the step-2-corrected fold): ONLY the PromptResponse.usage folds —
// `usage_update` frames are context-window telemetry and are dropped
// (§1.3). outputTokens → output, cachedReadTokens → cacheRead,
// cachedWriteTokens → cacheWrite (the field EXISTS on this wire — probe
// OQ-3), and input = inputTokens − cachedRead − cachedWrite (floored at
// 0): the wire's inputTokens is INCLUSIVE of the cached tokens (live
// sample: totalTokens 15722 = inputTokens 15719 + outputTokens 3, with
// cachedReadTokens 11648 INSIDE the 15719), so a straight mapping
// double-counted cache in every total that sums the frozen Usage fields —
// the ai-sdk lane's noCacheTokens reasoning; Σ of the frozen fields then
// equals the wire's own totalTokens. `reasoning` is NEVER emitted:
// thoughtTokens exists but its additivity vs outputTokens is unproven, and
// the frozen field is additive-only-when-reported-outside-output (same
// rule as the claude-agent lane). A cancelled response carries usage null
// → the fold is zeros; an unmeasured verdict NEVER reports cost.
//
// MODEL OBSERVATION (leg m binds): WorkerResult.model is the
// POST-MATERIALIZATION config_option_update model value ONLY — the
// session/new configOptions entry is the LAZY default and is never
// surfaced (the probe showed the providerId CHANGES between the two:
// builtin:zai\GLM-5.3 → builtin:bigmodel\GLM-5.3). A harness that reports
// nothing materialized omits the field — leg m fails that, as designed.
// The REQUESTED model rides to the harness through the `modelEnv` spawn-env
// channel (vendor-specific REQUEST transport — the OBSERVED value is what
// binds, and it is never substituted into the result).
//
// STRUCTURED OUTPUT vs DD-4 (strategy §4, prompt-directed JSON): no ACP
// structured-output carrier exists. When the constructor's outputSchema is
// set, the driver APPENDS the JSON schema + a reply-with-only-JSON
// instruction to the prompt, assembles the final text from the
// agent_message_chunk stream, and validates post-settle with zod. A
// payload that fails to parse or validate is DROPPED to narration —
// structuredOutput stays absent, the verdict stays what the wire said.
//
// I6 ISOLATION via the harness session store — EXACTLY the other lanes:
//   - NO sessionRef → tempWorkspace() + SessionStore.create(): a fresh
//     record and a workspace nothing has ever touched; the harness is
//     spawned with cwd = workspace.
//   - sessionRef → SessionStore.load(sessionRef) (unknown → PRE-DISPATCH
//     throw: a fake resume is worse than a loud one). The SAME workspace
//     continues; the vendor conversation continues only through the
//     protocol: the sidecar file `.cq-cli-session` carries the ACP session
//     id recorded post-settle by a prior run, and the §6 gate replays it
//     per the ADVERTISED capabilities: loadSession → session/load, else
//     sessionCapabilities.resume → unstable_resumeSession. A sidecar-less
//     workspace, or an agent advertising NEITHER, is an HONEST PARTIAL
//     continuation (workspace-only — narrated, never fabricated). A
//     sidecar, not a
//     record message: role 'tool' in a session record means A TOOL RAN.
//   - Persisted in OUR vocabulary: the user prompt (pre-run); ONE role
//     'tool' message per IN-POLICY tool execution (an allow-answered id
//     that reached a terminal status — { input, ok, output } plain JSON);
//     the assistant transcript text (when any); narration + stderr under
//     toolName 'acp-narration'. Denied-at-the-answer and UNGATED tool
//     activity is narration-only: the record reflects the governed
//     surface. Persist errors after dispatch are swallowed: the honest
//     verdict outranks the record.
//
// I8 SEAM — the driver owns NO wall clock. The governed context arrives
// via `currentJobContext()` (the one driver→kernel import, same as every
// lane) and is used in exactly two cooperative ways: an already-fired
// signal never dispatches, and a signal firing mid-prompt sends
// session/cancel — the COURTESY write, raced against a short bounded grace
// (cancelWriteGraceMs, default 250 ms) so the termination ladder NEVER
// waits on a write a backpressured child can hold open forever (Codex P1:
// the decided kill is independent of the write's cooperation; the write's
// completion, failure, or stall is evidence either way) — after which the
// child is TERMINATED via the settle path's ladder: the
// governed signal is the kill decision wherever it fires, and a vendor
// that ignores session/cancel must not hang the run past it. The prompt
// settles on whichever arrives first — the cancelled RESPONSE (the spec
// REQUIRES the agent to answer the original prompt with stopReason
// 'cancelled'; §2.3, live-verified at 327 ms — a compliant vendor that
// beats the ladder still folds that shape) or the wire's exit-path
// rejection — and the run settles the honest 'aborted' verdict either
// way. The listener attaches
// at WIRE CREATION, so a signal firing during the HANDSHAKE phases
// (initialize / session establishment / the mode pin — no prompt yet to
// cancel) reaches the child too: the settle path's
// termination ladder runs, the pending handshake request rejects on the
// wire's exit path, and the run settles the honest 'aborted' verdict —
// never an orphaned harness process. Consequences:
//   - Budget.wallClockMs is IGNORED — the governor's ladder owns wall
//     clock. Whether the vendor stops PROVIDER-side metering after a
//     cancel is unobservable from any client (OQ-6/DD-1 scope).
//   - Budget.maxTokens has NO protocol stop — post-hoc verdict
//     classification over the folded usage, like the subprocess and
//     claude-agent lanes: it classifies a finished run 'budget', never
//     stops one early.
//   - No request timeouts, no retries: outside a governed run there is no
//     cancellation source and a hung harness would hang the run — the
//     v1 cut line trades transport-level escalation for the cooperative
//     path (strategy §7).
//
// STOP REASON (frozen DriverStopReason) — mapping table, checked in order:
//   1. governed signal fired, or the prompt settled stopReason
//      'cancelled'                                        → 'aborted'
//   2. never-asks evidence at settle, a DENIED tool reporting a completed
//      execution (ungated through the answer channel), a permission ask
//      with NO answerable option of the required side, or a failed
//      permission-ANSWER write (the enforcement channel is broken —
//      Codex P1)                                          → 'error'
//   3. folded usage ≥ Budget.maxTokens                   → 'budget'
//   4. no wellshaped prompt response (handshake failure, child death) → 'error'
//   5. stopReason 'end_turn'                             → 'complete'
//      stopReason 'max_tokens' | 'max_turn_requests'     → 'budget' (a stop ON a cap)
//      stopReason 'refusal' | anything else              → 'error'
// Once spawned, run() NEVER throws: every failure lands in an honest
// verdict carrying the sessionId + denials gathered so far. Only
// PRE-DISPATCH validation throws (absent binary / unknown endpoint, a
// missing envNames entry, unknown sessionRef, a non-positive
// Budget.maxTokens).
//
// COST (DD-2, derived-only): costUSD via the `pricing` constructor lookup
// (default: computeCostUSD over the vendored models.dev table) keyed by
// the OBSERVED model when one was reported (the remap evidence is real —
// pricing the requested id would attribute the wrong rates), labeled
// `costBasis: 'modeled'`, ABSENT when the model is unpriced, and ABSENT
// on every unmeasured verdict (abort, handshake failure, child death —
// 0 would be a fabricated fact). The vendor's own cost figures
// (usage_update's cost object) are dropped with the frame that carries
// them (DD-9): a vendor-reported cost would bypass the derived-only rule.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { currentJobContext } from '../../kernel/governor.js';
import { SessionStore, tempWorkspace } from '../../harness/session.js';
import type { SessionMessage, SessionRecord } from '../../harness/session.js';
import { computeCostUSD } from '../pricing/index.js';
import type { PerMillionRates } from '../pricing/index.js';
import type { Driver, ModelSpec, OpInvocation, SandboxLevel, ToolDenial, ToolPolicy, Usage, WorkerResult } from '../types.js';
import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  GATING_MODE,
  InboundFrameSchema,
  InitializeResultSchema,
  JsonRpcErrorObjectSchema,
  MODE_CONFIG_ID,
  PromptResponseSchema,
  RequestPermissionParamsSchema,
  SessionNewResultSchema,
  SessionUpdateParamsSchema,
  SetConfigOptionResultSchema,
  AcpRpcError,
  isAuthRequiredError,
  mapWireUsage,
  modelOptionValueFrom,
  parseAcpUpdate,
  permissionToolIdentity,
  selectPermissionAnswer,
} from './protocol.js';
import type { AcpUpdate, ConfigOption, PromptResponse } from './protocol.js';
import { DEFAULT_ACP_ENDPOINT, defaultAcpEndpointTable, resolveAcpCommand } from './binaries.js';
import type { AcpEndpointTable } from './binaries.js';
import {
  DEFAULT_CANCEL_WRITE_GRACE_MS,
  acpExitPromise,
  raceWithGrace,
  spawnAcpProcess,
  terminateAcpProcess,
} from './process.js';
import type { AcpExitInfo, AcpGraceLadderOptions, AcpSpawnFn } from './process.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Workspace sidecar file carrying the ACP session id — the session/load
 * handle for the NEXT run on the SAME sessionRef (when the harness
 * advertises loadSession). A sidecar, not a record message: role 'tool'
 * in a session record means a tool ran (header), so the handle lives in
 * the workspace it resumes.
 */
export const ACP_SESSION_FILE = '.cq-cli-session';

/** Session-message toolName under which narration + stderr diagnostics are recorded. */
export const NARRATION_TOOL = 'acp-narration';

/** Constructor options — everything optional; defaults are production-real. */
export interface AcpDriverOptions {
  /**
   * The harness launch argv (strategy §3: the WHOLE argv is config —
   * harness launch shapes differ). Explicit argv WINS over the endpoint
   * table; default: the `endpoint` table's default argv
   * (`['zcode-acp-server']`).
   */
  command?: readonly [string, ...string[]];
  /** Endpoint registry key used when `command` is not given. Default DEFAULT_ACP_ENDPOINT ('zcode-acp-server'). */
  endpoint?: string;
  /** Endpoint registry override (default: defaultAcpEndpointTable — zcode-acp-server + dsh-acp). */
  endpointTable?: AcpEndpointTable;
  /**
   * Host env var NAMES copied into the child env at run() time (the
   * routing discipline every lane shares: names in config, never values;
   * a missing value throws pre-dispatch). Default: none — the harness
   * inherits the driver's process env (the vendor reads its own
   * credentials app-side, OQ-1).
   */
  envNames?: readonly string[];
  /**
   * Env var NAME through which the REQUESTED model id (ModelSpec.model)
   * is handed to the harness at spawn — the vendor-specific REQUEST
   * transport. The OBSERVED model (the post-materialization
   * config_option_update value) is what lands in WorkerResult.model and
   * what the price fold keys on; a harness that ignores the request
   * surfaces exactly that fact. Default: undefined (no model transmission).
   */
  modelEnv?: string;
  /**
   * Structured-output schema (prompt-directed JSON, strategy §4 — ACP has
   * no native carrier). When set, the prompt carries the JSON schema +
   * a reply-with-only-JSON instruction, and the assembled agent text is
   * validated against THIS schema post-settle (a payload that fails is
   * dropped to narration, never trusted).
   */
  outputSchema?: ZodType;
  /** Root under which fresh temp workspaces are created. Default: the harness default (os.tmpdir()/cq-harness). */
  workspaceRoot?: string;
  /** Sessions directory for the backing SessionStore. Default: <os.tmpdir()/cq-harness>/sessions. */
  sessionsDir?: string;
  /**
   * Price-lookup override for the derived-only costUSD rule (default:
   * `computeCostUSD` over the vendored models.dev table via `priceOf`).
   * A lookup returning undefined keeps costUSD absent.
   */
  pricing?: (modelSpec: ModelSpec) => PerMillionRates | undefined;
  /** SIGTERM→SIGKILL grace in ms for the settle-time child termination (default: process.ts's DEFAULT_TERM_GRACE_MS). */
  termGraceMs?: number;
  /** SIGKILL→force-resolve grace in ms (default: process.ts's DEFAULT_KILL_GRACE_MS). */
  killGraceMs?: number;
  /**
   * The bounded grace, in ms, racing the courtesy session/cancel write in
   * the governed-abort path (Codex P1): the termination ladder fires when
   * the write settles OR this grace expires, whichever first — a child
   * that stopped reading stdin can hold the write open forever, and the
   * decided kill must never wait on it. Default:
   * process.ts's DEFAULT_CANCEL_WRITE_GRACE_MS (250).
   */
  cancelWriteGraceMs?: number;
  /** Spawn override hook for tests. Default: the real spawnAcpProcess. */
  spawn?: AcpSpawnFn;
}

// ---------------------------------------------------------------------------
// Per-run observation — folded defensively from the wire (junk → narration)
// ---------------------------------------------------------------------------

/** Latest fold of one vendor tool call, by toolCallId. */
interface ToolObservation {
  title: string | undefined;
  kind: string | undefined;
  identity: string;
  status: string | undefined;
  rawInput: unknown;
  output: string;
}

interface RunObservation {
  /** Unknown frames, unshapeable updates, and anomaly markers — evidence, never a crash. */
  narration: string[];
  /** Harness stderr lines (diagnostics). */
  stderr: string[];
  /** agent_message_chunk texts, in arrival order (the transcript). */
  transcript: string[];
  /** The POST-MATERIALIZATION model value (config_option_update ONLY — never the session/new lazy default). */
  servedModel: string | undefined;
  /** toolCallId → latest tool fold. */
  tools: Map<string, ToolObservation>;
  /** toolCallId → the channel it was FIRST seen on ('permission' = the gate fired for it). First-write-wins. */
  toolFirstSeen: Map<string, 'permission' | 'tool_call'>;
  /** toolCallId → the decision our answer implemented (persisted executions are the allow side). */
  permissionDecisions: Map<string, 'allow' | 'deny'>;
  /** toolCallIds already carrying a denial (dedupe across the two channels). */
  deniedToolCallIds: Set<string>;
  /** The frozen denials, in denial order (answer-side + execution-failure side). */
  denials: ToolDenial[];
}

function newObservation(): RunObservation {
  return {
    narration: [],
    stderr: [],
    transcript: [],
    servedModel: undefined,
    tools: new Map(),
    toolFirstSeen: new Map(),
    permissionDecisions: new Map(),
    deniedToolCallIds: new Set(),
    denials: [],
  };
}

// ---------------------------------------------------------------------------
// The wire — line-framed JSON-RPC over the spawned child's stdio
// ---------------------------------------------------------------------------

/**
 * The stdout line-buffer ceiling (1 MiB). Frames ARE this wire's data and
 * ACP defines NO line-length limit — a valid frame (a tool_call's rawInput
 * can be large) routinely straddles `data`-chunk boundaries and must sit
 * in the buffer intact until its newline arrives. The old 8000-char mirror
 * of the stderr cap destroyed exactly those frames mid-JSON, before onLine
 * could parse them. 1 MiB is a pathological-run bound, not a protocol limit; stderr (human
 * diagnostics, not frames) keeps its 8000-char cap. ON OVERFLOW the
 * connection FAILS (failConnection — review-debt #42): a valid frame larger
 * than the buffer (a permission request whose rawInput embeds file contents
 * is plausible) must error the run naming the oversized frame, never
 * truncate — once bytes are dropped the stream can never resynchronize
 * mid-JSON.
 */
const STDOUT_LINE_BUFFER_LIMIT = 1_048_576;

interface WireHandlers {
  onNotification(method: string, params: unknown): void;
  /**
   * `id` is the RAW inbound id (JSON-RPC 2.0 allows number AND string) —
   * answers echo it VERBATIM: a coerced id ('id':null) is uncorrelatable,
   * the vendor's pending ask never resolves, and the turn hangs.
   */
  onServerRequest(method: string, id: number | string, params: unknown): void;
  /**
   * A RESPONSE line has arrived — fired SYNCHRONOUSLY at WIRE-LINE
   * processing time, BEFORE the pending request's promise resolves and
   * BEFORE any later line of the same data chunk is processed. `result`
   * is the response's result member (undefined on an error response).
   * The session/load replay window clears HERE, not in the load-branch
   * promise continuation: a session/update flushed back-to-back with the
   * load response post-dates the settle and must fold (round-2 review —
   * the continuation-level clearing dropped it).
   */
  onResponseLine(result: unknown): void;
  onUnparseableLine(line: string): void;
  onStderrLine(line: string): void;
}

/**
 * One ACP connection over one spawned child. Requests are correlated by
 * id; a child exit REJECTS every pending request (a silent death settles
 * instead of hanging). NO timeouts, NO retries: the governed signal is
 * the only cancellation source (I8), and the settle path is cooperative.
 */
class AcpWire {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private lineBuffer = '';
  private stderrBuffer = '';
  readonly exit: Promise<AcpExitInfo>;

  constructor(private readonly child: ChildProcess, private readonly handlers: WireHandlers) {
    child.stdout?.on('data', (chunk: string) => {
      this.lineBuffer += chunk;
      let nl = this.lineBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = this.lineBuffer.slice(0, nl).trim();
        this.lineBuffer = this.lineBuffer.slice(nl + 1);
        if (line !== '') this.onLine(line);
        nl = this.lineBuffer.indexOf('\n');
      }
      // A frame straddling chunk boundaries WAITS here for its newline —
      // the normal case on this wire, not an error (frames are the data;
      // see STDOUT_LINE_BUFFER_LIMIT). The 1 MiB ceiling only bounds a
      // pathological run: on overflow the connection FAILS (review-debt
      // #42) — the evidence lands in narration, then every pending request
      // rejects naming the oversized frame and the child is killed. The
      // old shape (clear the buffer, keep reading) truncated a possibly
      // valid frame and kept a connection that can never resynchronize.
      if (this.lineBuffer.length > STDOUT_LINE_BUFFER_LIMIT) {
        this.handlers.onUnparseableLine(
          `[cq: stdout line buffer overflow — ${this.lineBuffer.length} chars with no newline; failing the connection rather than truncating a possibly-valid frame]`,
        );
        this.lineBuffer = '';
        this.failConnection(
          new Error(
            `the harness emitted an oversized frame (> ${STDOUT_LINE_BUFFER_LIMIT} chars with no newline) — ` +
              'the connection cannot resynchronize mid-frame, so the run fails with this evidence',
          ),
        );
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      this.stderrBuffer += chunk;
      let nl = this.stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = this.stderrBuffer.slice(0, nl);
        this.stderrBuffer = this.stderrBuffer.slice(nl + 1);
        if (line !== '') this.handlers.onStderrLine(line);
        nl = this.stderrBuffer.indexOf('\n');
      }
      if (this.stderrBuffer.length > 8000) this.stderrBuffer = this.stderrBuffer.slice(-4000);
    });
    this.exit = acpExitPromise(child);
    void this.exit.then(() => {
      // Trailing partial lines flush at exit ('close' fires only after
      // stdio is flushed, so nothing can arrive after this): stderr's is
      // often the death diagnosis; stdout's is an unterminated wire line,
      // which still gets its parse-or-narrate chance — same symmetry.
      const trailingStdout = this.lineBuffer;
      this.lineBuffer = '';
      if (trailingStdout.trim() !== '') this.onLine(trailingStdout);
      const trailing = this.stderrBuffer;
      this.stderrBuffer = '';
      if (trailing.trim() !== '') this.handlers.onStderrLine(trailing);
      for (const p of this.pending.values()) {
        p.reject(new Error('the harness process exited before responding'));
      }
      this.pending.clear();
    });
  }

  /** Send one request; rejects on an error response, a dead pipe, or child exit. */
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params }).catch((err: unknown) => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.send({ jsonrpc: '2.0', method, params });
  }

  /** The id echoes back EXACTLY as it arrived (number or string — JSON-RPC correlates on the raw value). */
  respond(id: number | string, result: unknown): Promise<void> {
    return this.send({ jsonrpc: '2.0', id, result });
  }

  /** Answer an unhandled/unshapeable server request so the vendor sees a diagnosis, never silence. */
  failRequest(id: number | string, message: string): Promise<void> {
    return this.send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
  }

  /**
   * Fail the WHOLE connection (review-debt #42): every pending request
   * rejects with `reason` and the child is killed. Once frame bytes have
   * been dropped, the newline-delimited stream can never resynchronize
   * (the next newline would be read as a frame boundary mid-JSON), so the
   * honest settle is an error verdict carrying `reason` — never silent
   * truncation, never a run left reading a misframed wire. Idempotent with
   * the exit path: whatever rejects first wins, and the exit handler finds
   * the pending table already empty.
   */
  private failConnection(reason: Error): void {
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
    this.child.kill();
  }

  private onLine(line: string): void {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      this.handlers.onUnparseableLine(line);
      return;
    }
    const checked = InboundFrameSchema.safeParse(data);
    if (!checked.success) {
      this.handlers.onUnparseableLine(line);
      return;
    }
    const frame = checked.data;
    // The RAW id rides through every branch VERBATIM (number or string —
    // JSON-RPC 2.0 allows both): Number() coercion turned a legal string
    // request id into NaN (the answer serialized 'id':null —
    // uncorrelatable, the vendor's ask hung) and would fabricate 0 from
    // a null id (a misrouted notification answered into the void).
    const rawId = frame.id;
    const numericId = typeof rawId === 'number' ? rawId : undefined;
    if (rawId === undefined && frame.method === undefined) {
      this.handlers.onUnparseableLine(line); // neither response nor request nor notification
      return;
    }
    // A RESPONSE: id + result/error present. OUR request ids are numeric,
    // so only a NUMERIC id can correlate against the pending table — a
    // string-id response was never ours and stays narration evidence
    // (a null id cannot occur: InboundFrameSchema rejects it).
    if (numericId !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      // The LINE-level response hook fires FIRST — synchronously, before
      // the pending resolution (which only schedules the await's
      // continuation) and before any later line of this data chunk is
      // processed. This is what makes the replay window a WIRE-LINE gate:
      // every frame after this line already post-dates the settle.
      this.handlers.onResponseLine(frame.result);
      const pending = this.pending.get(numericId);
      if (pending === undefined) {
        this.handlers.onUnparseableLine(line); // a response to an id we never sent — evidence
        return;
      }
      this.pending.delete(numericId);
      if (frame.error !== undefined) {
        const parsedError = JsonRpcErrorObjectSchema.safeParse(frame.error);
        pending.reject(
          new AcpRpcError(
            parsedError.success
              ? {
                  code: parsedError.data.code,
                  message: parsedError.data.message,
                  ...(parsedError.data.data !== undefined ? { data: parsedError.data.data } : {}),
                }
              : { code: -32700, message: line.slice(0, 500) },
          ),
        );
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    // A server→client REQUEST (session/request_permission is the one the
    // subset answers): method + a present id, echoed back VERBATIM.
    if (frame.method !== undefined && rawId !== undefined) {
      this.handlers.onServerRequest(frame.method, rawId, frame.params);
      return;
    }
    // A notification.
    if (frame.method !== undefined) {
      this.handlers.onNotification(frame.method, frame.params);
      return;
    }
    this.handlers.onUnparseableLine(line);
  }

  private send(frame: Parameters<typeof JSON.stringify>[0]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stdin = this.child.stdin;
      if (stdin === null || stdin === undefined || stdin.destroyed) {
        reject(new Error('the harness stdin is closed'));
        return;
      }
      stdin.write(`${JSON.stringify(frame)}\n`, (err) => (err !== null && err !== undefined ? reject(err) : resolve()));
    });
  }
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * The permission answer for a REAL governed cancellation — the ONE legal
 * 'cancelled' outcome (the answer table's single exception). Never a policy
 * decision: it says the ASK is moot because the run is cancelling, so the
 * vendor can settle the prompt with stopReason 'cancelled' (§2.3) instead
 * of hanging on a dangling request.
 */
const CANCELLED_PERMISSION_ANSWER = { outcome: { outcome: 'cancelled' } } as const;

/**
 * The acp driver on the frozen Driver seam. One instance is stateless
 * across runs — all per-run state (session record, wire, observation,
 * denials) lives in the run call — so a single instance can serve many
 * isolated invocations.
 */
export class AcpDriver implements Driver {
  private readonly command: readonly string[] | undefined;
  private readonly endpoint: string;
  private readonly endpointTable: AcpEndpointTable;
  private readonly envNames: readonly string[];
  private readonly modelEnv: string | undefined;
  private readonly outputSchema: ZodType | undefined;
  private readonly workspaceRoot: string | undefined;
  private readonly sessionsDir: string | undefined;
  private readonly pricingOverride: ((modelSpec: ModelSpec) => PerMillionRates | undefined) | undefined;
  private readonly termGraceMs: number | undefined;
  private readonly killGraceMs: number | undefined;
  private readonly cancelWriteGraceMs: number;
  private readonly spawnImpl: AcpSpawnFn;

  constructor(options: AcpDriverOptions = {}) {
    this.command = options.command;
    this.endpoint = options.endpoint ?? DEFAULT_ACP_ENDPOINT;
    this.endpointTable = options.endpointTable ?? defaultAcpEndpointTable();
    this.envNames = options.envNames ?? [];
    this.modelEnv = options.modelEnv;
    this.outputSchema = options.outputSchema;
    this.workspaceRoot = options.workspaceRoot;
    this.sessionsDir = options.sessionsDir;
    this.pricingOverride = options.pricing;
    this.termGraceMs = options.termGraceMs;
    this.killGraceMs = options.killGraceMs;
    this.cancelWriteGraceMs = options.cancelWriteGraceMs ?? DEFAULT_CANCEL_WRITE_GRACE_MS;
    this.spawnImpl = options.spawn ?? spawnAcpProcess;
  }

  /** The frozen seam: run one invocation to completion. */
  async run(opInvocation: OpInvocation): Promise<WorkerResult> {
    const { prompt, modelSpec, toolPolicy, sandboxPolicy, sessionRef, budget } = opInvocation;

    // --- Pre-dispatch validation: everything here throws BEFORE the
    // harness is spawned (and, except the sessionRef check, before any
    // session exists). Absent binary / unknown endpoint → the §3 throw
    // naming the binary + install hint.
    const resolved = await resolveAcpCommand(this.command, this.endpoint, this.endpointTable, process.env);
    if (budget.maxTokens !== undefined && (!Number.isFinite(budget.maxTokens) || budget.maxTokens <= 0)) {
      throw new Error(
        `acp driver: budget.maxTokens must be a finite number > 0, got ${String(budget.maxTokens)}`,
      );
    }

    // --- I6 isolation: fresh record + fresh workspace, or a real resume.
    const store = new SessionStore(this.sessionsDir ?? defaultSessionsDir());
    const record =
      sessionRef === undefined
        ? await store.create(await tempWorkspace(this.workspaceRoot))
        : await loadSessionOrThrow(store, sessionRef);
    const workspace = record.workspace;

    // --- Child env: the host environment rides (the vendor reads its own
    // credentials app-side, OQ-1); envNames adds explicitly configured
    // NAMES (values read AT run time — the one place a secret value is
    // ever touched); modelEnv hands the REQUESTED model id to the harness.
    // This block sits ABOVE the user-turn append: a missing envNames entry
    // is a PRE-DISPATCH throw and must never leave a dangling user turn
    // in the record.
    const childEnv = { ...process.env } as Record<string, string>;
    for (const name of this.envNames) {
      const value = process.env[name];
      if (value === undefined || value === '') {
        throw new Error(`acp driver: envNames entry '${name}' is not set in the environment`);
      }
      childEnv[name] = value;
    }
    if (this.modelEnv !== undefined) {
      childEnv[this.modelEnv] = modelSpec.model;
    }

    // --- Governed cancellation (I8): checked before the user-turn append
    // AND before the spawn — the envNames hoist rationale applies
    // identically: an already-cancelled invocation must leave neither a
    // dangling user turn in the record nor a spawn.
    const governed = currentJobContext();
    const signal = governed?.signal;
    if (signal?.aborted === true) {
      return { usage: zeroUsage(), sessionId: record.sessionId, denials: [], stopReason: 'aborted' };
    }

    await store.appendMessage(record.sessionId, { role: 'user', content: prompt, at: nowIso() });

    // --- Protocol-level resume handle: the ACP session id a prior run
    // recorded in the workspace sidecar (absent → workspace-only continuation).
    const resumeAcpSessionId = await readAcpSessionId(workspace);

    // --- The one spawn. From here on, run() NEVER throws past the seam.
    const observation = newObservation();
    let child: ChildProcess;
    try {
      child = this.spawnImpl({
        command: resolved.binary,
        args: [...resolved.command.slice(1)],
        cwd: workspace,
        env: childEnv,
      });
    } catch (err) {
      observation.narration.push(JSON.stringify({ cq: 'spawn-threw', message: messageOf(err) }));
      try {
        await persistObservation(store, record, observation, undefined, resumeAcpSessionId);
      } catch {
        // deliberately swallowed — the honest verdict outranks the record
      }
      return { usage: zeroUsage(), sessionId: record.sessionId, denials: [], stopReason: 'error' };
    }

    let signalFired = false;
    // True when the write of a permission ANSWER failed — the enforcement
    // channel is broken and the verdict is pinned to 'error' even if a
    // prompt response somehow arrived afterward (Codex P1).
    let answerWriteFailed = false;
    // True when a permission answer could not be SELECTED — the decision's
    // required side (allow/reject) was never offered (§2.1). The child is
    // terminated, but a termination-tolerant vendor may ignore that, time
    // out its unanswered ask, and settle the turn end_turn anyway: the
    // flag pins the verdict to 'error' regardless (the answerWriteFailed
    // mirror — failed ENFORCEMENT, not the wire outcome, decides).
    let permissionAnswerFailed = false;
    let promptDispatched = false;
    let acpSessionId: string | undefined;
    // The inbound session/request_permission awaiting our answer, by its RAW
    // id (undefined = none). Set on arrival, cleared the moment an answer is
    // initiated — the governed-abort handler answers a still-pending ask
    // 'cancelled' BEFORE proceeding, so the vendor never hangs on a dangling
    // request while the run is cancelling.
    let pendingPermissionId: number | string | undefined;
    // The session/load REPLAY window (strategy §6): true from the
    // session/load write until its RESPONSE LINE arrives. Every
    // session/update inside the window is REPLAYED HISTORY — counted into
    // the discard sink below, never folded into THIS run's observation (a
    // replayed tool_call must not mark toolFirstSeen, a replayed chunk
    // must not join the transcript, a replayed failed status must not
    // synthesize a denial, a replayed model value must not feed
    // servedModel). The flag clears at the WIRE-LINE level
    // (wire.onResponseLine) — synchronously, before any later line of the
    // same data chunk is processed — so a frame flushed back-to-back with
    // the load response post-dates the settle and folds; clearing only at
    // the await's continuation (the round-1 shape) dropped it.
    let replaying = false;
    let replayedFrameCount = 0;
    // True while the session-establishment request (load / resume / new)
    // is in flight. Its RESPONSE LINE carries the authoritative sessionId,
    // which the onResponseLine hook adopts AT LINE LEVEL — a same-chunk
    // post-response update must pass the session-id gate, and the
    // continuation that assigns acpSessionId cannot run until the WHOLE
    // chunk has been processed (the handshake is strictly sequential, so
    // within this window the only response that can arrive is the
    // establishment's own).
    let establishing = false;

    const graceOpts = (): AcpGraceLadderOptions => ({
      ...(this.termGraceMs !== undefined ? { termGraceMs: this.termGraceMs } : {}),
      ...(this.killGraceMs !== undefined ? { killGraceMs: this.killGraceMs } : {}),
    });
    /** Rung markers only for the EXCEPTIONAL rung: a SIGKILL escalation is evidence; a normal SIGTERM exit is every-run silence. */
    const onRung = (marker: { rung: 'sigterm' | 'sigkill'; atMs: number }): void => {
      if (marker.rung === 'sigkill') {
        observation.narration.push(JSON.stringify({ cq: 'termination-rung', ...marker }));
      }
    };

    // --- Inbound server→client requests: session/request_permission is
    // answered declaratively per the FULL answer table (header); anything
    // else gets method-not-found so the record shows what the vendor tried.
    // `id` is the RAW inbound id and rides back verbatim (a string request
    // id answered as a number — or as null via Number() coercion — is an
    // answer the vendor can never correlate).
    const handleServerRequest = (method: string, id: number | string, params: unknown): void => {
      if (method !== ACP_METHODS.sessionRequestPermission) {
        observation.narration.push(JSON.stringify({ cq: 'unhandled-server-request', method }));
        void wire.failRequest(id, `cq acp driver does not implement ${method}`).catch(() => undefined);
        return;
      }
      const parsed = RequestPermissionParamsSchema.safeParse(params);
      if (!parsed.success) {
        observation.narration.push(
          JSON.stringify({ cq: 'unshapeable-request-permission', issues: parsed.error.issues.length }),
        );
        void wire.failRequest(id, 'unshapeable session/request_permission params').catch(() => undefined);
        return;
      }
      const request = parsed.data;
      const toolCallId = request.toolCall.toolCallId;
      // The gate FIRED for this id — first-write-wins (a tool_call that
      // already arrived first keeps its never-asks evidence).
      if (!observation.toolFirstSeen.has(toolCallId)) {
        observation.toolFirstSeen.set(toolCallId, 'permission');
      }
      pendingPermissionId = id;
      // A governed cancellation that ALREADY landed: the answer table is
      // moot — the ask is answered 'cancelled' (the ONE outcome legal on a
      // real cancellation — the answer table's single exception, header) so
      // the vendor can settle the prompt with stopReason 'cancelled' (§2.3)
      // instead of hanging on a dangling ask while we await that settle.
      // Never a policy decision: no table lookup, no denial, no allow.
      if (signalFired) {
        pendingPermissionId = undefined;
        observation.narration.push(
          JSON.stringify({
            cq: 'permission-cancelled',
            toolCallId,
            note: 'the governed cancellation landed before this ask — answered cancelled (legal only on a real cancellation), never a table decision',
          }),
        );
        void wire.respond(id, CANCELLED_PERMISSION_ANSWER).catch((err: unknown) => {
          observation.narration.push(
            JSON.stringify({ cq: 'permission-cancel-send-failed', toolCallId, message: messageOf(err) }),
          );
        });
        return;
      }
      const identity = permissionToolIdentity(request.toolCall.title, request.toolCall.kind);
      const decision = decidePermission(toolPolicy, sandboxPolicy.level, identity, request.toolCall.kind);
      const selection = selectPermissionAnswer(decision.decision, request.options);
      if (!selection.ok) {
        // A decision whose required side was NOT OFFERED — an allow with
        // no allow option, or a deny with no reject option — FAILS THE
        // RUN (strategy §2.1); 'cancelled' is only legal on a real
        // cancellation, never as an answer. Terminating the child settles
        // the pending prompt request via the wire's exit path for a
        // COMPLIANT vendor — but a termination-tolerant vendor may ignore
        // the signal, time out its unanswered ask, and settle end_turn
        // anyway, so permissionAnswerFailed pins the verdict to 'error'
        // however green the wire then looks. The narration names WHICH
        // side failed (selection.side — both sides fail the same way
        // loudly).
        observation.narration.push(
          JSON.stringify({
            cq: 'permission-answer-failed',
            side: selection.side,
            toolCallId,
            offered: request.options.map((option) => ({ optionId: option.optionId, kind: option.kind })),
            note:
              selection.side === 'allow'
                ? 'no allow option offered on the allow side — the run fails; never answered cancelled'
                : 'no reject option offered on the deny side — the run fails; never answered cancelled',
          }),
        );
        permissionAnswerFailed = true;
        void terminateAcpProcess(child, graceOpts(), onRung).catch(() => undefined);
        pendingPermissionId = undefined; // the run is failing; the ask dies with the process — never answered cancelled
        return;
      }
      observation.permissionDecisions.set(toolCallId, decision.decision);
      if (decision.decision === 'deny' && decision.denial !== undefined && !observation.deniedToolCallIds.has(toolCallId)) {
        observation.deniedToolCallIds.add(toolCallId);
        observation.denials.push(decision.denial); // the frozen record, synthesized AT the answer
      }
      pendingPermissionId = undefined; // the answer is initiated — no longer dangling
      void wire.respond(id, selection.answer).catch((err: unknown) => {
        // A failed ANSWER write is a BROKEN ENFORCEMENT CHANNEL (Codex P1):
        // the vendor closed its input pipe yet may keep running, and the
        // pending prompt would never settle (the driver has no timeouts —
        // I8). The write-failure evidence lands in narration,
        // answerWriteFailed pins the verdict to 'error', and the child is
        // terminated via the settle ladder so the pending prompt rejects
        // on the wire's exit path — the run settles instead of hanging.
        answerWriteFailed = true;
        observation.narration.push(
          JSON.stringify({ cq: 'permission-answer-send-failed', toolCallId, message: messageOf(err) }),
        );
        void terminateAcpProcess(child, graceOpts(), onRung).catch(() => undefined);
      });
    };

    const wire = new AcpWire(child, {
      onNotification: (method, params) => {
        if (method === ACP_METHODS.sessionUpdate) {
          // GATE ORDER (round-1 review): the REPLAY gate first — a frame
          // arriving before the session/load response is replay-by-
          // definition (history replays BEFORE the response, strategy
          // §6), discarded on arrival whatever its sessionId; the
          // SESSION-ID gate second — this run's acpSessionId does not
          // exist until establishment resolves, so an id filter could
          // never hold inside the replay window (the reference filters
          // updates to the session's own id: §1.1 item 4). Both gates
          // drop SILENTLY — narration is reserved for unshapeable
          // frames, so a clean run persists none; the replay window
          // leaves exactly one COUNT marker after the load settles (the
          // count is the honest evidence, never the content).
          if (replaying) {
            replayedFrameCount += 1;
            return;
          }
          if (sessionIdOf(params) !== acpSessionId) return; // not this run's session (the spec puts sessionId on every update)
          foldSessionUpdate(observation, params);
        } else {
          observation.narration.push(JSON.stringify({ cq: 'unhandled-notification', method }));
        }
      },
      onServerRequest: handleServerRequest,
      onResponseLine: (result) => {
        // The replay window clears AT THE RESPONSE LINE — synchronously,
        // before any frame later in the same data chunk is gated (the
        // round-1 shape cleared only at the await's continuation, which
        // runs after the WHOLE chunk is processed, dropping same-chunk
        // post-load updates).
        replaying = false;
        // The establishment response's sessionId is authoritative: adopt
        // it at line level so a same-chunk post-response update passes the
        // session-id gate below (the continuation that assigns
        // acpSessionId runs too late for that frame).
        if (establishing) {
          const sid = sessionIdOf(result);
          if (sid !== undefined) acpSessionId = sid;
        }
      },
      onUnparseableLine: (line) => observation.narration.push(line.slice(0, 2000)),
      onStderrLine: (line) => observation.stderr.push(line),
    });

    // --- Governed cancellation (I8). The listener attaches AT WIRE
    // CREATION — before the initialize request — so the governor's signal
    // is honored during EVERY phase, not only the prompt:
    //   - a permission ask still pending as the cancellation lands is
    //     answered 'cancelled' FIRST (legal only on a real cancellation —
    //     the answer table's one exception), never left dangling;
    //   - prompt in flight → session/cancel (the COURTESY write, RACED
    //     against a short bounded grace — its settlement is never the
    //     ladder's precondition: a child wedged on a backpressured prompt
    //     can hold the write open forever, and the kill must not wait on
    //     the thing being killed — Codex P1), then the settle ladder
    //     terminates the child — the same decided-kill execution as the
    //     pre-prompt branch below: the governed signal is the kill
    //     decision wherever it fires, and a vendor that ignores
    //     session/cancel must not hang the run past it (no timeouts —
    //     I8). The prompt settles on whichever arrives first — the
    //     cancelled RESPONSE (§2.3's shape, from a vendor that beats the
    //     ladder) or the wire's exit-path rejection — 'aborted' either way;
    //   - pre-prompt phase (initialize / session establishment / the mode
    //     pin) → there is no prompt to cancel cooperatively, so the child
    //     is TERMINATED via the settle path's ladder (the same rung
    //     discipline); the in-flight handshake request rejects on the
    //     wire's exit path and the run fails to the honest 'aborted'
    //     verdict instead of leaving the harness process running.
    // Purely reactive: nothing here fires without the governor's signal.
    // ONCE-semantics (the attach-time recheck below): a double entry — the
    // abort event AND the recheck, in an attach-then-abort race — must run
    // the path exactly once; signalFired is that guard.
    const onAbort = (): void => {
      if (signalFired) return;
      signalFired = true;
      const dangling = pendingPermissionId;
      pendingPermissionId = undefined;
      if (dangling !== undefined) {
        void wire.respond(dangling, CANCELLED_PERMISSION_ANSWER).catch((err: unknown) => {
          observation.narration.push(
            JSON.stringify({ cq: 'permission-cancel-send-failed', message: messageOf(err) }),
          );
        });
      }
      if (promptDispatched && acpSessionId !== undefined) {
        const target = acpSessionId;
        // THE DECIDED KILL NEVER DEPENDS ON THE COOPERATION OF THE THING
        // BEING KILLED (Codex P1, round 4). The courtesy session/cancel
        // write rides the SAME stdin the prompt may have backpressured: a
        // child that stopped reading never drains it, the write's callback
        // never fires, and a ladder gated on the write's settlement would
        // never start — the run would hang past a decided kill. So the
        // write is RACED against a short bounded grace
        // (cancelWriteGraceMs, default 250 ms, process.ts's
        // raceWithGrace), and the termination ladder fires on WHICHEVER
        // settles first. The write's completion or failure is recorded as
        // evidence either way ('cancel-sent' / 'cancel-send-failed'); a
        // grace win adds the 'cancel-write-stalled' marker — the vendor
        // demonstrably never consumed the cancel before the SIGTERM, and
        // the record says so. When the write WINS the race its evidence
        // handler (attached first) still runs ahead of the kill, so the
        // ordering is preserved: the vendor sees the cancel before the
        // SIGTERM.
        const cancelWrite = wire.notify(ACP_METHODS.sessionCancel, { sessionId: target });
        void cancelWrite.then(
          () => observation.narration.push(JSON.stringify({ cq: 'cancel-sent', sessionId: target })),
          (err: unknown) =>
            observation.narration.push(JSON.stringify({ cq: 'cancel-send-failed', message: messageOf(err) })),
        );
        void raceWithGrace(cancelWrite, this.cancelWriteGraceMs).then((outcome) => {
          if (outcome === 'stalled') {
            observation.narration.push(
              JSON.stringify({ cq: 'cancel-write-stalled', graceMs: this.cancelWriteGraceMs, sessionId: target }),
            );
          }
          // The decided kill, gated on NOTHING the child controls (the
          // prompt-phase kill rung; Codex P1).
          void terminateAcpProcess(child, graceOpts(), onRung).catch(() => undefined);
        });
      } else {
        observation.narration.push(
          JSON.stringify({
            cq: 'pre-prompt-abort',
            note: 'the governed signal fired before the prompt — terminating the child (the settle ladder); the pending handshake phase fails and the run settles aborted',
          }),
        );
        void terminateAcpProcess(child, graceOpts(), onRung).catch(() => undefined);
      }
    };
    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
      // ATTACH-TIME RECHECK (Codex P1): abort events are NOT replayed — a
      // governed deadline that fired while appendMessage()/
      // readAcpSessionId() was awaiting (between the pre-dispatch aborted
      // check and THIS attach) leaves the listener on an ALREADY-aborted
      // signal, never invoked, and the child would never be cancelled: the
      // run would proceed through the whole handshake and prompt past a
      // fired deadline. Run the abort path NOW — idempotent (the
      // signalFired once-guard above), and the cancel/termination path
      // tolerates the entry (the settle ladder re-terminating an already
      // terminating child is a no-op).
      if (signal.aborted) onAbort();
    }

    // --- Handshake step 1: initialize (integer version negotiation; the
    // wire integer is the only version that binds — strategy §3).
    let initAuthMethods: readonly string[] = [];
    let agentSupportsLoad = false;
    let agentSupportsResume = false;
    let negotiatedVersion: number | undefined;
    let handshakeFailure: string | undefined;
    if (!signalFired) {
      try {
        const initRaw = await wire.request(ACP_METHODS.initialize, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'cq-toolkit', version: '0.0.0' },
        });
        const init = InitializeResultSchema.parse(initRaw);
        negotiatedVersion = init.protocolVersion;
        if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
          // The agent never declines initialize — it answers its latest
          // (OQ-5, live-verified). A client that cannot live with the
          // answer closes the connection and informs: our 'close' is
          // killing the spawned child (the settle below), our 'inform'
          // is this failure record.
          handshakeFailure =
            `ACP protocol mismatch: requested ${ACP_PROTOCOL_VERSION}, agent answered ${init.protocolVersion} — ` +
            'closing the connection (killing the spawned harness)';
        } else {
          initAuthMethods = (init.authMethods ?? []).map((method) => method.id);
          agentSupportsLoad = init.agentCapabilities?.loadSession === true;
          // The §6 middle rung's advertisement: sessionCapabilities.resume
          // present (the probe-verbatim `{ list: {}, resume: {}, fork: {} }`
          // — advertised means the member exists, however empty).
          agentSupportsResume = init.agentCapabilities?.sessionCapabilities?.resume !== undefined;
        }
      } catch (err) {
        handshakeFailure = `initialize failed: ${messageOf(err)}`;
      }
    }

    // --- Handshake step 2: session establishment — the THREE-RUNG resume
    // gate (strategy §6, the reference's own gate order), else session/new.
    if (handshakeFailure === undefined && !signalFired) {
      establishing = true;
      try {
        if (sessionRef !== undefined && resumeAcpSessionId !== undefined && agentSupportsLoad) {
          // RUNG 1 — session/load when agentCapabilities.loadSession is
          // advertised. History replays via session/update BEFORE the
          // response (strategy §6) — the replaying flag routes the whole
          // window into the discard sink: none of it is this run's
          // observation. The flag clears the moment the load RESPONSE
          // LINE arrives (wire.onResponseLine — synchronously, before any
          // later line of the same chunk is processed), so a frame
          // flushed back-to-back with the response post-dates the settle
          // and folds normally; only a config_option_update arriving
          // AFTER the load settles can feed servedModel — session/new/
          // load configOptions stay the never-folded lazy defaults
          // (header, §5). cwd + mcpServers stay present (the recorded
          // Devin quirk generalizes: keep the params present).
          replaying = true;
          try {
            const loadedRaw = await wire.request(ACP_METHODS.sessionLoad, {
              sessionId: resumeAcpSessionId,
              cwd: workspace,
              mcpServers: [],
            });
            const loaded = SessionNewResultSchema.safeParse(loadedRaw);
            acpSessionId = loaded.success ? loaded.data.sessionId : resumeAcpSessionId;
          } finally {
            replaying = false; // belt-and-suspenders: the response line already cleared it
            if (replayedFrameCount > 0) {
              observation.narration.push(
                JSON.stringify({
                  cq: 'replayed-frames-discarded',
                  count: replayedFrameCount,
                  note: 'session/update frames replayed before the session/load response never entered this run (strategy §6) — the count is the evidence, not the content',
                }),
              );
            }
          }
        } else if (sessionRef !== undefined && resumeAcpSessionId !== undefined && agentSupportsResume) {
          // RUNG 2 — unstable_resumeSession when sessionCapabilities.resume
          // is advertised (strategy §6: the reference's own middle rung;
          // NO history replay on this rung, so no replay window). The same
          // { sessionId, cwd, mcpServers } param shape as load — the Devin
          // quirk generalizes to "keep the params present".
          const resumedRaw = await wire.request(ACP_METHODS.unstableResumeSession, {
            sessionId: resumeAcpSessionId,
            cwd: workspace,
            mcpServers: [],
          });
          const resumed = SessionNewResultSchema.safeParse(resumedRaw);
          acpSessionId = resumed.success ? resumed.data.sessionId : resumeAcpSessionId;
        } else {
          // RUNG 3 (and the fresh-run path) — session/new. Reaching here
          // WITH a recorded sidecar means NEITHER resume capability is
          // advertised: the honest-partial rung, narrated.
          const createdRaw = await wire.request(ACP_METHODS.sessionNew, { cwd: workspace, mcpServers: [] });
          const created = SessionNewResultSchema.parse(createdRaw);
          acpSessionId = created.sessionId;
          if (sessionRef !== undefined && resumeAcpSessionId !== undefined) {
            observation.narration.push(
              JSON.stringify({
                cq: 'resume-partial',
                acpSessionId: resumeAcpSessionId,
                note: 'the harness advertises NEITHER loadSession NOR sessionCapabilities.resume — workspace-only continuation (the sidecar handle was recorded but is unusable)',
              }),
            );
          }
        }
      } catch (err) {
        handshakeFailure = isAuthRequiredError(err)
          ? `the harness demands authentication (auth_required) — advertised authMethods: ` +
            `${initAuthMethods.length > 0 ? initAuthMethods.join(', ') : '(none)'}; this driver never calls ` +
            'authenticate: the harness is expected to arrive pre-authenticated (OQ-1)'
          : `session establishment failed: ${messageOf(err)}`;
      } finally {
        establishing = false;
      }
    }

    // --- Handshake step 3: THE MODE PIN, before ANY prompt (§1.2
    // amendment). Sessions open in yolo — which never asks — so an
    // unpinned session is a policy void: a failed pin refuses to prompt.
    // The pin is VERIFIED, not just sent (review-debt #39): a 2xx response
    // alone proves nothing — the same response can echo the current mode
    // STILL 'yolo' (or carry no mode echo at all), leaving the policy
    // silently unenforced while the run proceeds. The echoed
    // modes.currentModeId must NAME the pinned mode; a non-confirming
    // response fails the run pre-prompt exactly like a thrown pin (the
    // never-asks tripwire remains the downstream backstop).
    if (handshakeFailure === undefined && !signalFired && acpSessionId !== undefined) {
      try {
        const pinRaw = await wire.request(ACP_METHODS.sessionSetConfigOption, {
          sessionId: acpSessionId,
          configId: MODE_CONFIG_ID,
          value: GATING_MODE,
        });
        const pin = SetConfigOptionResultSchema.safeParse(pinRaw);
        const confirmedMode = pin.success ? pin.data.modes?.currentModeId : undefined;
        if (confirmedMode !== GATING_MODE) {
          handshakeFailure =
            `the mode pin was not confirmed (session/set_config_option ${MODE_CONFIG_ID}=${GATING_MODE} ` +
            `answered ${confirmedMode === undefined ? 'no mode echo' : `mode '${confirmedMode}'`}) — ` +
            'an unpinned session is a policy void, refusing to prompt';
        }
      } catch (err) {
        handshakeFailure =
          `the mode pin failed (session/set_config_option ${MODE_CONFIG_ID}=${GATING_MODE}): ${messageOf(err)} — ` +
          'an unpinned session is a policy void, refusing to prompt';
      }
    }

    // --- The one prompt: fire-and-settle.
    let promptResponse: PromptResponse | undefined;
    let promptFailure: string | undefined;
    if (handshakeFailure === undefined && !signalFired && acpSessionId !== undefined) {
      promptDispatched = true;
      try {
        const responseRaw = await wire.request(ACP_METHODS.sessionPrompt, {
          sessionId: acpSessionId,
          prompt: [{ type: 'text', text: composePrompt(prompt, this.outputSchema) }],
        });
        const parsedResponse = PromptResponseSchema.safeParse(responseRaw);
        if (parsedResponse.success) {
          promptResponse = parsedResponse.data;
        } else {
          promptFailure = 'unshapeable session/prompt response';
        }
      } catch (err) {
        promptFailure = messageOf(err);
      }
    }

    // --- Settle: terminate the child (the vendor session dies with the
    // process — §6), then fold the verdict. Bounded: the ladder always
    // settles (its SIGKILL rung force-resolves).
    await terminateAcpProcess(child, graceOpts(), onRung);
    signal?.removeEventListener('abort', onAbort);

    // --- The never-asks tripwire, evaluated AT SETTLE (first-channel-
    // wins per toolCallId — header): any tool_call stream id with NO
    // preceding permission request is evidence of UNGATED EXECUTION.
    const ungatedToolCallIds = [...observation.toolFirstSeen.entries()]
      .filter(([, via]) => via === 'tool_call')
      .map(([id]) => id);
    if (ungatedToolCallIds.length > 0) {
      observation.narration.push(
        JSON.stringify({
          cq: 'never-asks',
          ungatedToolCallIds,
          note: 'tool_call updates arrived with NO preceding session/request_permission for the id — evidence of UNGATED EXECUTION; the tool policy was unenforceable on this run (strategy §2.1)',
        }),
      );
    }

    // --- THE DENIED-EXECUTION TRIPWIRE (review-debt #45): a toolCallId our
    // answer DENIED that nevertheless reported a COMPLETED execution is
    // ungated execution through the answer channel — the harness asked,
    // was told no, and ran the tool anyway. Same posture as never-asks:
    // the verdict fails loud (a policy that cannot be enforced is not
    // silently soft); the bypass is narration evidence — a denied id is
    // never persisted as a governed tool message.
    const deniedButCompletedIds = [...observation.permissionDecisions.entries()]
      .filter(([id, decision]) => decision === 'deny' && observation.tools.get(id)?.status === 'completed')
      .map(([id]) => id);
    if (deniedButCompletedIds.length > 0) {
      observation.narration.push(
        JSON.stringify({
          cq: 'denied-tool-completed',
          toolCallIds: deniedButCompletedIds,
          note: 'a tool_call our answer DENIED reported status completed — the harness executed past the rejection; UNGATED EXECUTION through the answer channel (strategy §2.1)',
        }),
      );
    }

    // --- Prompt-directed JSON (§4): parse + validate the assembled text;
    // a failing payload is dropped to narration, never trusted.
    let structured: unknown;
    const transcriptText = observation.transcript.join('');
    if (this.outputSchema !== undefined && transcriptText !== '') {
      let parsedJson: unknown;
      let unparseable = false;
      try {
        parsedJson = JSON.parse(transcriptText);
      } catch {
        unparseable = true;
      }
      if (unparseable) {
        observation.narration.push(
          JSON.stringify({ cq: 'structured-output-unparseable', note: 'the assembled agent text is not JSON — dropped (strategy §4)' }),
        );
      } else {
        const check = this.outputSchema.safeParse(parsedJson);
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
    }

    // --- Failure records land in narration BEFORE persistence (evidence,
    // not silence) — the verdict itself has no error-message field.
    if (handshakeFailure !== undefined) {
      observation.narration.push(
        JSON.stringify({ cq: 'handshake-failure', negotiatedProtocolVersion: negotiatedVersion ?? null, message: handshakeFailure }),
      );
    }
    if (promptFailure !== undefined) {
      observation.narration.push(JSON.stringify({ cq: 'prompt-failure', message: promptFailure }));
    }

    // --- Session persistence (post-settle, OUR vocabulary). A store error
    // here is swallowed: once spawned, the verdict must reach the caller.
    try {
      await persistObservation(store, record, observation, acpSessionId, resumeAcpSessionId);
    } catch {
      // deliberately swallowed — the honest verdict outranks the record
    }

    const measuredUsage = promptResponse === undefined ? undefined : mapWireUsage(promptResponse.usage);
    return this.verdict(modelSpec, budget, observation, record.sessionId, {
      structured,
      signalFired,
      answerWriteFailed,
      permissionAnswerFailed,
      deniedRan: deniedButCompletedIds.length > 0,
      promptStopReason: promptResponse?.stopReason,
      responded: promptResponse !== undefined,
      measuredUsage,
      ungated: ungatedToolCallIds.length > 0,
    });
  }

  // --- Internals -------------------------------------------------------------

  /**
   * Fold the observation into the frozen WorkerResult (header tables: stop
   * reasons, usage, cost). A real measurement (the prompt response's
   * usage) is kept on any verdict that observed it — including a pinned-
   * error enforcement failure the vendor settled past; unmeasured
   * verdicts (abort, handshake failure, child death) report zeros and
   * NEVER a cost.
   */
  private verdict(
    modelSpec: ModelSpec,
    budget: OpInvocation['budget'],
    observation: RunObservation,
    sessionId: string,
    inputs: {
      structured: unknown;
      signalFired: boolean;
      answerWriteFailed: boolean;
      permissionAnswerFailed: boolean;
      deniedRan: boolean;
      promptStopReason: string | undefined;
      responded: boolean;
      measuredUsage: Usage | undefined;
      ungated: boolean;
    },
  ): WorkerResult {
    const usage = inputs.measuredUsage ?? zeroUsage();
    const stopReason = stopReasonOf({
      aborted: inputs.signalFired || inputs.promptStopReason === 'cancelled',
      answerWriteFailed: inputs.answerWriteFailed,
      permissionAnswerFailed: inputs.permissionAnswerFailed,
      deniedRan: inputs.deniedRan,
      ungated: inputs.ungated,
      maxTokens: budget.maxTokens,
      usage,
      promptStopReason: inputs.promptStopReason,
      responded: inputs.responded,
    });
    // Derived-only cost (DD-2), keyed by the OBSERVED model when the
    // harness reported one (pricing the requested id would attribute the
    // wrong rates — §5); only on a verdict carrying a REAL measurement.
    const pricedModel: ModelSpec =
      observation.servedModel !== undefined ? { ...modelSpec, model: observation.servedModel } : modelSpec;
    const cost =
      inputs.measuredUsage === undefined ? {} : costField(this.costUSDOf.bind(this), pricedModel, usage);
    return {
      // The observed served model: the POST-MATERIALIZATION value the
      // harness reported, never the requested id (the remap-detection
      // fact, leg m; header).
      ...(observation.servedModel !== undefined ? { model: observation.servedModel } : {}),
      ...(inputs.structured !== undefined ? { structuredOutput: inputs.structured } : {}),
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

/** Load a sessionRef for resume; unknown sessions throw (a fake resume is worse than a loud error). */
async function loadSessionOrThrow(store: SessionStore, sessionRef: string): Promise<SessionRecord> {
  const record = await store.load(sessionRef);
  if (record === undefined) {
    throw new Error(`acp driver: unknown sessionRef '${sessionRef}' — no recorded session to resume`);
  }
  return record;
}

/**
 * The ACP session id recorded in a prior run's workspace sidecar, if any —
 * the session/load handle of THIS run. Missing/unreadable → undefined (an
 * honest workspace-only continuation, never a fabricated resume).
 */
async function readAcpSessionId(workspace: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(workspace, ACP_SESSION_FILE), 'utf8');
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined; // no sidecar — nothing to resume protocol-side
  }
}

/**
 * THE PERMISSION DECISION (the frozen ToolPolicy + SandboxPolicy →
 * allow/deny for ONE request; the full mapping table is in the header).
 * `identity` is the matched tool identity (the title's leading token —
 * ./protocol.ts). The deny side carries the frozen denial record
 * synthesized AT the answer.
 */
export function decidePermission(
  policy: ToolPolicy,
  sandboxLevel: SandboxLevel,
  identity: string,
  kind: string | undefined,
): { decision: 'allow' | 'deny'; tool: string; denial?: ToolDenial } {
  if (policy.mode === 'none') {
    return { decision: 'deny', tool: identity, denial: { tool: identity, reason: 'tool policy: mode none' } };
  }
  if (sandboxLevel === 'read-only') {
    // Fail-closed (header): no read/write classification on this wire can
    // be trusted, so read-only denies EVERY gated execution. This is the
    // permission boundary pointed at maximum caution — NOT filesystem
    // containment (strategy §2.2's honesty stands).
    return {
      decision: 'deny',
      tool: identity,
      denial: {
        tool: identity,
        reason: 'sandbox policy: read-only denies every gated tool execution (the permission boundary is this lane\'s only enforcement channel)',
      },
    };
  }
  if (policy.mode === 'unrestricted') {
    return { decision: 'allow', tool: identity };
  }
  // mode 'allowlist' (the default reading when mode is omitted) — the
  // matched identity against the allowlist, case-insensitively (vendor
  // titles lead with capitalized tool names; our allowlists are lowercase).
  const allowed = new Set([...policy.allow].map((name) => name.toLowerCase()));
  if (allowed.has(identity.toLowerCase())) {
    return { decision: 'allow', tool: identity };
  }
  return {
    decision: 'deny',
    tool: identity,
    denial: { tool: identity, reason: `tool policy: not allowlisted (kind ${kind ?? 'unknown'})` },
  };
}

/**
 * THE PROMPT: the caller's prompt verbatim, or — when a structured-output
 * schema is configured — the prompt PLUS the JSON schema and a
 * reply-with-only-JSON instruction (prompt-directed JSON, strategy §4;
 * ours truncates nothing: caller data never rides a budget).
 */
const STRUCTURED_OUTPUT_INSTRUCTION =
  'Reply with ONLY a JSON value conforming to this JSON Schema — no prose, no code fences:';

export function composePrompt(prompt: string, outputSchema: ZodType | undefined): string {
  if (outputSchema === undefined) return prompt;
  return `${prompt}\n\n${STRUCTURED_OUTPUT_INSTRUCTION}\n${JSON.stringify(z.toJSONSchema(outputSchema))}`;
}

/**
 * Fold ONE session/update notification (defensively: an unshapeable
 * envelope OR an unknown update kind becomes narration — the stream's
 * junk is evidence, never a crash). Known kinds the seam cannot carry are
 * dropped SILENTLY (narration is reserved for genuinely unshapeable
 * frames); the ONE deliberate narration on a well-framed stream is
 * `agent_thought_chunk`'s fact (below) — so a clean run on a
 * NON-THINKING vendor persists no narration at all.
 */
export function foldSessionUpdate(observation: RunObservation, params: unknown): void {
  const checked = SessionUpdateParamsSchema.safeParse(params);
  if (!checked.success) {
    observation.narration.push(JSON.stringify({ cq: 'unshapeable-session-update', preview: previewOf(params) }));
    return;
  }
  const update = parseAcpUpdate(checked.data.update);
  if (update === undefined) {
    observation.narration.push(
      JSON.stringify({ cq: 'unknown-session-update', preview: previewOf(checked.data.update) }),
    );
    return;
  }
  foldUpdate(observation, update);
}

function foldUpdate(observation: RunObservation, update: AcpUpdate): void {
  switch (update.kind) {
    case 'agent_message_chunk': {
      if (update.text !== '') observation.transcript.push(update.text);
      return;
    }
    case 'agent_thought_chunk': {
      // Thought CONTENT is not a token count and must not become one
      // (§2.3); the fact of it is evidence, the text is not persisted.
      observation.narration.push(JSON.stringify({ cq: 'agent-thought', chars: update.text.length }));
      return;
    }
    case 'tool_call':
    case 'tool_call_update': {
      const id = update.toolCallId;
      // First-write-wins channel tracking: a tool_call arriving before any
      // permission request for its id is never-asks evidence (evaluated
      // at settle — header).
      if (!observation.toolFirstSeen.has(id)) {
        observation.toolFirstSeen.set(id, 'tool_call');
      }
      const existing = observation.tools.get(id) ?? {
        title: undefined,
        kind: undefined,
        identity: 'unknown',
        status: undefined,
        rawInput: undefined,
        output: '',
      };
      if (update.kind === 'tool_call') {
        existing.title = update.title ?? existing.title;
        existing.kind = update.toolKind ?? existing.kind;
        existing.rawInput = update.rawInput ?? existing.rawInput;
      } else if (update.rawOutput !== undefined) {
        existing.output = update.rawOutput;
      } else if (update.contentText !== undefined) {
        // No rawOutput on the wire — the tool reported its result via
        // CONTENT blocks (the reference vendor's SUCCESS shape; Codex P2):
        // the folded output is the blocks' text, so a successful tool's
        // output lands in the record and a failed one's in the denial
        // reason, instead of an empty string. A later rawOutput still
        // overwrites (the branch order); a no-text update leaves the
        // folded output untouched (contentText is lifted only non-empty).
        existing.output = update.contentText;
      }
      existing.status = update.status ?? existing.status;
      existing.identity = permissionToolIdentity(existing.title, existing.kind);
      observation.tools.set(id, existing);
      // The SECOND denial channel: an execution that RAN and failed — not
      // one we denied at the answer (deduped per toolCallId).
      if (
        update.status === 'failed' &&
        !observation.deniedToolCallIds.has(id) &&
        observation.permissionDecisions.get(id) !== 'deny'
      ) {
        observation.deniedToolCallIds.add(id);
        observation.denials.push({
          tool: existing.identity,
          reason: existing.output !== '' ? existing.output : `tool execution failed (${existing.identity})`,
        });
      }
      return;
    }
    case 'config_option_update': {
      // The POST-MATERIALIZATION model value — the ONLY model source this
      // driver folds (the session/new entry is the lazy default, never
      // surfaced; strategy §5). Later updates overwrite: the last
      // materialized value wins.
      const value = modelOptionValueFrom(update.configOptions as ConfigOption[] | undefined);
      if (value !== undefined) observation.servedModel = value;
      return;
    }
    case 'current_mode_update':
    case 'usage_update':
    case 'known-unconsumed':
      return; // evidence lives in the mode-pin flow / context telemetry is dropped / no seam field
  }
}

function previewOf(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 500 ? text.slice(0, 500) : text;
}

/** The `sessionId` member of an inbound params object, when a string (absent/other-shaped → undefined — never this run's id). */
function sessionIdOf(params: unknown): string | undefined {
  const value = (params as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Post-settle persistence (OUR vocabulary, in order): the ACP-session
 * sidecar (when newly observed — the NEXT run's session/load handle), ONE
 * role 'tool' message per IN-POLICY tool execution (an allow-answered id
 * that reached a terminal status; { input, ok, output } plain JSON —
 * denied-at-the-answer and UNGATED activity stays narration-only, per the
 * header's governed-surface rule), the assistant transcript (when any),
 * and narration + stderr diagnostics (when any). Never fabricates an
 * assistant turn: a run that produced no text records none.
 */
async function persistObservation(
  store: SessionStore,
  record: SessionRecord,
  observation: RunObservation,
  acpSessionId: string | undefined,
  resumeAcpSessionId: string | undefined,
): Promise<void> {
  if (acpSessionId !== undefined && acpSessionId !== resumeAcpSessionId) {
    // Best-effort: the sidecar is the NEXT run's session/load handle; a
    // failed write costs a workspace-only continuation, never this run's
    // verdict.
    try {
      await writeFile(join(record.workspace, ACP_SESSION_FILE), `${acpSessionId}\n`, 'utf8');
    } catch {
      // deliberately swallowed — resume degrades honestly
    }
  }
  for (const [toolCallId, tool] of observation.tools) {
    if (observation.permissionDecisions.get(toolCallId) !== 'allow') continue;
    if (tool.status !== 'completed' && tool.status !== 'failed') continue; // unsettled cards are not executions
    const message: SessionMessage = {
      role: 'tool',
      toolName: tool.identity,
      content: JSON.stringify({ input: tool.rawInput ?? null, ok: tool.status === 'completed', output: tool.output }),
      at: nowIso(),
    };
    await store.appendMessage(record.sessionId, message);
  }
  const text = observation.transcript.join('');
  if (text !== '') {
    await store.appendMessage(record.sessionId, { role: 'assistant', content: text, at: nowIso() });
  }
  const diagnostics = [...observation.narration, ...observation.stderr.map((line) => `[stderr] ${line}`)];
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

/** Unmeasured usage: the honest zero (it means "not measured", never "nothing spent"). */
function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Σ of the frozen Usage fields — the fold Budget.maxTokens is checked against. */
function totalTokensOf(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite + (usage.reasoning ?? 0);
}

/**
 * Derived-only cost field (DD-2): present only when the price lookup knows
 * the model. A present costUSD is labeled `costBasis: 'modeled'` — the
 * api-equivalent list-price figure for the tokens consumed, never a claim
 * of billed spend; an unpriced model gets neither field (never fabricate).
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
  /** The governed signal fired, or the prompt settled stopReason 'cancelled'. */
  aborted: boolean;
  /** True when the write of a permission ANSWER failed — the enforcement channel is broken; the run fails even if a response arrived (Codex P1). */
  answerWriteFailed?: boolean;
  /** True when a permission answer could not be SELECTED (the required side was never offered) — failed enforcement; the run fails even if the vendor ignores the termination and settles the unanswered ask (round-3). */
  permissionAnswerFailed?: boolean;
  /** A DENIED toolCallId reported a completed execution — ungated through the answer channel (review-debt #45); fails like never-asks. */
  deniedRan?: boolean;
  /** Never-asks evidence at settle (ungated execution — a policy void is an error, never green). */
  ungated: boolean;
  maxTokens: number | undefined;
  usage: Usage;
  /** The wire stopReason, when a wellshaped prompt response arrived. */
  promptStopReason: string | undefined;
  /** True when a wellshaped prompt response arrived at all. */
  responded: boolean;
}

/** THE mapping (checked in order): aborted → permission-selection-failure → answer-write-failure → denied-execution-error → ungated-error → budget → no-response-error → the wire stopReason. */
export function stopReasonOf(inputs: StopReasonInputs): WorkerResult['stopReason'] {
  if (inputs.aborted) return 'aborted';
  if (inputs.permissionAnswerFailed === true) return 'error'; // the unanswerable ask — failed enforcement even if the vendor settles end_turn anyway
  if (inputs.answerWriteFailed === true) return 'error'; // the broken enforcement channel — fail loud even if a response arrived
  if (inputs.deniedRan === true) return 'error'; // a denied tool ran anyway — ungated through the answer channel (review-debt #45)
  if (inputs.ungated) return 'error';
  if (inputs.maxTokens !== undefined && totalTokensOf(inputs.usage) >= inputs.maxTokens) return 'budget';
  if (!inputs.responded) return 'error';
  if (inputs.promptStopReason === 'end_turn') return 'complete';
  if (inputs.promptStopReason === 'max_tokens' || inputs.promptStopReason === 'max_turn_requests') return 'budget';
  return 'error'; // refusal, an unknown vendor reason, or an unshapeable response
}

/** Best-effort error message (an unknown throw shape is still evidence). */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
