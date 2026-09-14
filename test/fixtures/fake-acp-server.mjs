// Fake ACP server — the wire fixture for the acp driver's tests (T1.8).
// Dependency-free, node: builtins only, run as
// `node test/fixtures/fake-acp-server.mjs` (the driver spawns it with
// cwd = the invocation's workspace; there IS no argv — the protocol is
// newline-delimited JSON-RPC 2.0 over stdio).
//
// It speaks EXACTLY the strategy §1.2 subset (docs/acp-driver-strategy.md)
// with the REAL wire shapes recorded by scripts/probe-acp.mjs against
// zcode-acp-server@0.37.3:
//   - initialize { protocolVersion } → answers protocolVersion 1 (the
//     agent never declines — OQ-5), agentCapabilities.loadSession: true,
//     one self-handled authMethod (OQ-1: no gate, no authenticate call
//     is ever needed or expected).
//   - session/new { cwd, mcpServers } → sessionId + modes (current yolo)
//     + configOptions carrying the LAZY model value 'builtin:zai\<model>'.
//   - session/load { sessionId, cwd, mcpServers } → continues the RECORDED
//     session id (the resume path; handled in every mode).
//   - unstable_resumeSession { sessionId, cwd, mcpServers } → the §6 rung-2
//     resume (same param shape, NO history replay) — exercisable with
//     FAKE_ACP_NO_LOADSESSION=1 + FAKE_ACP_RESUME=1.
//   - session/set_config_option { configId: 'mode', value } → switches the
//     session mode (the driver's pin lands here; tool-then-reply replies
//     echo '[mode:<mode>]' so a test can observe the pin took effect).
//   - session/prompt → runs the MODE script (below), emitting NESTED
//     session/update notifications (params.update.sessionUpdate — the
//     probe's shape pin), including the MATERIALIZED model value via
//     config_option_update, and settling with a PromptResponse.
//   - session/cancel → settles an active turn with
//     { stopReason: 'cancelled', usage: null } (the probed cancel shape).
//   - session/request_permission (server→client request) with VENDOR-STRING
//     optionIds selected by kind — the answered optionId is echoed in the
//     reply ('[permission:<optionId>]'), so tests assert the driver's
//     answer-table behavior from the session transcript.
//
// SCRIPTED BEHAVIOR (env FAKE_ACP_MODE; default 'ok') — fixed usage numbers
// everywhere, mirroring fake-agent-cli.mjs in the ACP vocabulary:
//   FAKE_ACP_SERVED_MODEL   overrides the MATERIALIZED model id (the
//                           config_option_update value) — simulates a
//                           vendor whose served model diverges from what
//                           was requested (the observed-model check catches it)
//   FAKE_ACP_MODEL          what was REQUESTED (the driver's modelEnv
//                           channel); the default materialized value. The
//                           LAZY session/new value is
//                           'builtin:zai\<model>' — deliberately DIFFERENT
//                           from the materialized value, so a driver that
//                           reads the lazy default fails the observed-model leg
//   FAKE_ACP_PROTOCOL_VERSION  the protocolVersion the initialize answer
//                           reports (default 1 — the mismatch-verdict test)
//   FAKE_ACP_REPLAY       when '1', session/load REPLAYS a prior-turn
//                         history via session/update BEFORE the load
//                         response — an agent_message_chunk, a tool_call
//                         with NO permission request, and a failed
//                         tool_call_update (the reference-recorded
//                         replay-before-load-response shape, strategy §6;
//                         a driver that folds them false-fires the
//                         never-asks tripwire, leaks prior-turn text into
//                         the transcript, and synthesizes a phantom denial)
//   FAKE_ACP_REPLAY_WITH_TAIL  when '1', like FAKE_ACP_REPLAY, then the
//                         load RESPONSE LINE and a POST-load
//                         agent_message_chunk (POST_LOAD_TAIL_TEXT) go out
//                         in ONE stdout flush — the tail frame post-dates
//                         the response line and MUST fold (the round-2
//                         chunk-boundary regression: a gate cleared only at
//                         the load await's continuation drops it, because
//                         the whole same-flush chunk is processed before
//                         any continuation runs)
//   FAKE_ACP_NO_LOADSESSION  when '1', the initialize answer reports
//                         agentCapabilities.loadSession: false — the §6
//                         resume gate must fall BELOW rung 1
//   FAKE_ACP_RESUME       when '1', the initialize answer advertises
//                         sessionCapabilities { list, resume, fork }
//                         (probe-verbatim shape) — §6 rung 2,
//                         unstable_resumeSession, becomes exercisable
//   FAKE_ACP_STRING_REQUEST_IDS  when '1', session/request_permission ids
//                         are JSON-RPC STRINGS (protocol-legal; the
//                         reference vendor sends numbers) — the answer
//                         must echo the id verbatim or the round-trip
//                         never completes and the turn hangs
//   FAKE_ACP_CLOSE_STDIN_ON_PERMISSION  when '1', the fixture DESTROYS its
//                         own stdin the moment a session/request_permission
//                         goes out and KEEPS RUNNING — the driver's answer
//                         write fails (EPIPE) with the prompt still pending
//                         (the broken-enforcement-channel scenario; the
//                         run must settle 'error', never hang)
//   FAKE_ACP_IGNORE_CANCEL  when '1', the TOLERANT-VENDOR persona:
//                         session/cancel is SWALLOWED (the turn never
//                         settles protocol-side — the governed kill rung
//                         must still reach it), the termination SIGNAL is
//                         IGNORED (SIGTERM cannot kill this process), and
//                         in the tool flows an ask the client never
//                         answers TIMES OUT — the vendor abandons the
//                         permission and settles the turn end_turn anyway
//                         (the wire can look green past failed
//                         enforcement — the shape the selection-failure
//                         verdict pin must survive)
//   FAKE_ACP_PLACEHOLDER_CARD  when '1' (tool flows), the fixture emits
//                         the probe-recorded PLACEHOLDER card while the
//                         request_permission is still pending: a tool_call
//                         titled 'tool permission (<Tool>)' (status
//                         'pending', kind 'other') carrying the ASK's
//                         toolCallId — the strategy-recorded popup card a
//                         driver must not treat as the tool execution
//                         (the run must stay a clean complete: no
//                         never-asks tripwire, no denials)
//   FAKE_ACP_BIG_FRAME   when '1', the reply chunk is ONE session/update
//                         whose JSON line is ~20k chars, written in TWO
//                         stdout flushes 25 ms apart with NO newline
//                         between — a valid frame straddling data-chunk
//                         boundaries (ACP defines no line-length limit);
//                         the driver's stdout line buffer must hold the
//                         partial frame until the newline (the old
//                         8000-char cap destroyed it mid-JSON)
//   ok               materialization updates + reply (FAKE_ACP_REPLY ??
//                    'ok') + end_turn with usage
//   tool-then-reply  ONE gated tool call: request_permission round-trip
//                   (FAKE_ACP_OPTIONS overrides the offered options — JSON
//                   array of {optionId, kind}); the answer is HONORED —
//                   an allow kind executes the tool for real (read/run/
//                   edit with harness-matching denial reasons), a reject
//                   kind fails it with rawOutput 'rejected (<optionId>)'
//                   (the probed deny shape) — then the reply + end_turn
//   deny-tool        like tool-then-reply, but the tool ALWAYS ends
//                   status 'failed' with rawOutput
//                   'permission denied: <tool> is not allowed' (a
//                   vendor-side execution failure after the round-trip)
//   never-asks       executes the directed tool for real with NO
//                   request_permission at all (the structural failure
//                   mode — the driver's tripwire must catch it)
//   block-until-abort materialization updates, then NO response until a
//                   session/cancel arrives (settles 'cancelled', usage null)
//   fail             stderr error + exit 1 after session/new, before any
//                   prompt response (no result — an honest error verdict)
//   resume-echo      replies 'resumed from acp session <id>' (proves the
//                   session/load sidecar round-trip)
//
// Fixed usage: { totalTokens: 20, inputTokens: 15, outputTokens: 5,
// thoughtTokens: 0, cachedReadTokens: 2, cachedWriteTokens: 3 } — modeled
// on the LIVE wire's INCLUSIVE arithmetic (cache-bucket fix, 2026-09-15):
// totalTokens = inputTokens + outputTokens with the cached tokens INSIDE
// inputTokens (the committed probe sample: total 15722 = input 15719 +
// output 3, cachedRead 11648 inside the 15719). The driver's fold derives
// input = inputTokens − cachedRead − cachedWrite = 15 − 2 − 3 = 10, so the
// usage-mapping test freezes { input: 10, output: 5, cacheRead: 2,
// cacheWrite: 3 } with NO reasoning field, and Σ of the frozen fields
// (20) equals the wire's totalTokens.
import { exec } from 'node:child_process';
import { closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// env + fixed shapes
// ---------------------------------------------------------------------------

const MODE = process.env.FAKE_ACP_MODE ?? 'ok';
const REPLY = process.env.FAKE_ACP_REPLY;
const TOOL = process.env.FAKE_ACP_TOOL ?? 'read';
const OPTIONS_RAW = process.env.FAKE_ACP_OPTIONS;
const SERVED_MODEL = process.env.FAKE_ACP_SERVED_MODEL;
const REQUESTED_MODEL = process.env.FAKE_ACP_MODEL ?? 'fake-model';
const PROTOCOL_VERSION = Number(process.env.FAKE_ACP_PROTOCOL_VERSION ?? '1');
const REPLAY = process.env.FAKE_ACP_REPLAY === '1';
const REPLAY_WITH_TAIL = process.env.FAKE_ACP_REPLAY_WITH_TAIL === '1';
const NO_LOADSESSION = process.env.FAKE_ACP_NO_LOADSESSION === '1';
const ADVERTISE_RESUME = process.env.FAKE_ACP_RESUME === '1';
const STRING_REQUEST_IDS = process.env.FAKE_ACP_STRING_REQUEST_IDS === '1';
const CLOSE_STDIN_ON_PERMISSION = process.env.FAKE_ACP_CLOSE_STDIN_ON_PERMISSION === '1';
const IGNORE_CANCEL = process.env.FAKE_ACP_IGNORE_CANCEL === '1';
const PLACEHOLDER_CARD = process.env.FAKE_ACP_PLACEHOLDER_CARD === '1';
const BIG_FRAME = process.env.FAKE_ACP_BIG_FRAME === '1';

// The tolerant-vendor persona (FAKE_ACP_IGNORE_CANCEL=1), signal half: the
// termination is IGNORED — only the unignorable SIGKILL rung reaches this
// process once it is up.
if (IGNORE_CANCEL) process.on('SIGTERM', () => undefined);

// The tolerant-vendor persona, ask half: an unanswered permission ask times
// out and the turn settles end_turn anyway (see toolFlow). Generous enough
// to never race the handshake; short enough to keep its test fast.
const TOLERANT_ASK_TIMEOUT_MS = 250;

// The POST-load tail marker (FAKE_ACP_REPLAY_WITH_TAIL=1): emitted in the
// SAME stdout flush as the session/load response line, so it post-dates
// the settle — a correct driver folds it into THIS run's transcript. The
// chunk-boundary test asserts this text verbatim.
const POST_LOAD_TAIL_TEXT =
  'POST-LOAD tail chunk — same flush as the load response, post-dates the settle, must fold';

// The frame-straddle marker (FAKE_ACP_BIG_FRAME=1): one session/update
// whose JSON line is ~20k chars, written in TWO flushes with no newline
// between — the first flush exceeds the old 8000-char stdout cap while the
// line is still partial. The driver must hold the partial frame until the
// newline; BOTH markers must then appear in the folded transcript.
const BIG_FRAME_TEXT = `BIGFRAME-START ${'x'.repeat(20000)} BIGFRAME-END`;

/**
 * Emit ONE agent_message_chunk update as a ~20k-char JSON line split across
 * two stdout flushes (no newline in the first): the straddle shape the
 * driver's line buffer must survive. Resolves after the second flush lands.
 */
function emitBigFrameChunk() {
  const line = JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: acpSessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: BIG_FRAME_TEXT } },
    },
  });
  return new Promise((flushed) => {
    process.stdout.write(line.slice(0, 9000)); // partial frame — no newline yet
    setTimeout(() => {
      process.stdout.write(`${line.slice(9000)}\n`); // the frame completes
      flushed();
    }, 25);
  });
}

const USAGE = {
  // INCLUSIVE wire arithmetic (the live sample's shape): totalTokens =
  // inputTokens + outputTokens, cachedRead/cachedWrite INSIDE inputTokens.
  totalTokens: 20,
  inputTokens: 15,
  outputTokens: 5,
  thoughtTokens: 0,
  cachedReadTokens: 2,
  cachedWriteTokens: 3,
};

// The reference vendor's offered options, VERBATIM from the probe: vendor
// optionIds ("allow_once" / "allow_project" / "deny"), kinds carrying the
// selection semantics. The driver must select by KIND and echo optionId.
const DEFAULT_OPTIONS = [
  { optionId: 'allow_once', kind: 'allow_once' },
  { optionId: 'allow_project', kind: 'allow_always' },
  { optionId: 'deny', kind: 'reject_once' },
];

function offeredOptions() {
  if (OPTIONS_RAW === undefined) return DEFAULT_OPTIONS;
  const parsed = JSON.parse(OPTIONS_RAW);
  if (!Array.isArray(parsed)) throw new Error('FAKE_ACP_OPTIONS must be a JSON array');
  return parsed;
}

// The tool name → the vendor TOOL_KIND_MAP-ish kind (probe: Write→edit).
function toolKind(name) {
  if (name === 'read') return 'read';
  if (name === 'edit') return 'edit';
  if (name === 'run') return 'execute';
  return 'other';
}

// ---------------------------------------------------------------------------
// session state
// ---------------------------------------------------------------------------

let acpSessionId = null;
let sessionMode = 'yolo'; // sessions open in yolo — the gate is OFF until the pin (OQ-4)
let sessionCounter = 0;
let promptRequestId = null; // the in-flight session/prompt request, if any
let pendingPermission = null; // { id, onAnswered } — the in-flight request_permission

const materializedModel = () => SERVED_MODEL ?? REQUESTED_MODEL; // what the session REALLY serves
const lazyModel = () => `builtin:zai\\${materializedModel()}`; // the session/new default — deliberately different

// ---------------------------------------------------------------------------
// outbound helpers (NESTED update shape — the probe's pin)
// ---------------------------------------------------------------------------

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const errLine = (line) => process.stderr.write(`${line}\n`);
let serverRequestId = 100;

function notifyUpdate(update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: acpSessionId, update } });
}

function emitConfigOptionUpdate() {
  // The MATERIALIZATION update — the real served model (strategy §5: the
  // driver folds THIS, never the session/new lazy default).
  notifyUpdate({
    sessionUpdate: 'config_option_update',
    configOptions: [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: materializedModel(), options: [] },
    ],
  });
}

function emitModeUpdate() {
  notifyUpdate({ sessionUpdate: 'current_mode_update', currentModeId: sessionMode });
}

function emitChunk(text) {
  notifyUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
}

// The replay-before-load-response history (strategy §1.1 item 8 / §6,
// FAKE_ACP_REPLAY=1): three prior-turn bait frames — a text chunk, a
// tool_call with NO permission request, a FAILED tool_call_update — a
// driver that folds them marks toolFirstSeen (never-asks false-fire at
// settle), joins prior-turn text to this run's transcript, and
// synthesizes a phantom denial.
function replayPriorTurnHistory() {
  emitChunk('REPLAYED prior-turn reply (must never surface in this run)');
  notifyUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_replayed_prior_turn',
    title: 'read: replayed.txt',
    kind: 'read',
    status: 'in_progress',
    content: [],
    locations: [],
    rawInput: { path: 'replayed.txt' },
  });
  notifyUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_replayed_prior_turn',
    status: 'failed',
    content: [{ type: 'text', text: 'REPLAYED prior-turn failure' }],
    rawOutput: 'REPLAYED prior-turn failure',
  });
}

function modesShape() {
  // Probe-verbatim (2026-09-15): availableModes entries are { id, name }
  // OBJECTS on the live wire — the fixture previously emitted bare strings,
  // matching the driver schema's transcription bug instead of the wire.
  return {
    currentModeId: sessionMode,
    availableModes: [
      { id: 'plan', name: 'Plan' },
      { id: 'build', name: 'Build' },
      { id: 'edit', name: 'Edit' },
      { id: 'yolo', name: 'Yolo' },
      { id: 'auto', name: 'Auto' },
    ],
  };
}

function configOptionsLazy() {
  return [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: lazyModel(), options: [] }];
}

function respondPrompt(result) {
  if (promptRequestId === null) return; // no active turn — a stray cancel is a no-op
  send({ jsonrpc: '2.0', id: promptRequestId, result });
  promptRequestId = null;
}

// ---------------------------------------------------------------------------
// the permission round-trip (server → client REQUEST, answer honored)
// ---------------------------------------------------------------------------

function askPermission(toolCallId, title, input, onAnswered) {
  const options = offeredOptions();
  const id = STRING_REQUEST_IDS ? `perm_${serverRequestId++}` : serverRequestId++;
  pendingPermission = { id, onAnswered };
  const frame = {
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId: acpSessionId,
      toolCall: { toolCallId, rawInput: input, title, content: [], locations: [] },
      options,
    },
  };
  if (CLOSE_STDIN_ON_PERMISSION) {
    // The broken-enforcement-channel scenario: the vendor closes its INPUT
    // pipe as the ask goes out but KEEPS RUNNING. destroy() alone does NOT
    // close fd 0 (Node never closes stdin's fd — the parent's writes would
    // still succeed), so the REAL close happens after the stream's 'close'
    // event releases libuv's handle: closeSync(0). The ask goes out only
    // AFTER that, so the driver's answer write deterministically EPIPEs
    // while this process stays alive (the 'end' exit handler never fires —
    // destroy is not EOF).
    errLine("fake-acp-server: closing stdin on the permission ask (the driver's answer write must fail)");
    process.stdin.once('close', () => {
      try {
        closeSync(0);
      } catch {
        // already gone — nothing left to simulate
      }
      send(frame);
    });
    process.stdin.destroy();
    return;
  }
  send(frame);
}

function kindOfOptionId(optionId, options) {
  const option = options.find((candidate) => candidate.optionId === optionId);
  return option === undefined ? undefined : option.kind;
}

// ---------------------------------------------------------------------------
// real tool execution against cwd (mirrors fake-agent-cli.mjs: the
// read/run/edit trio with harness-matching denial reasons). Never throws.
// ---------------------------------------------------------------------------

const messageOf = (err_) => (err_ instanceof Error ? err_.message : String(err_));

function resolveInside(path_) {
  const root = resolve(process.cwd());
  const abs = resolve(root, path_);
  return abs === root || abs.startsWith(root + sep) ? abs : undefined;
}

async function executeTool(name, input) {
  if (name === 'read') {
    const path_ = typeof input?.path === 'string' ? input.path : '';
    const abs = resolveInside(path_);
    if (abs === undefined) return { ok: false, text: `path escape: '${path_}' resolves outside the workspace` };
    try {
      const text = await readFile(abs, 'utf8');
      return { ok: true, text };
    } catch (err_) {
      return {
        ok: false,
        text: messageOf(err_).includes('ENOENT') ? `file not found: '${path_}'` : `read failed: ${messageOf(err_)}`,
      };
    }
  }
  if (name === 'edit') {
    const path_ = typeof input?.path === 'string' ? input.path : '';
    const abs = resolveInside(path_);
    if (abs === undefined) return { ok: false, text: `path escape: '${path_}' resolves outside the workspace` };
    let content;
    try {
      content = await readFile(abs, 'utf8');
    } catch (err_) {
      return {
        ok: false,
        text: messageOf(err_).includes('ENOENT') ? `file not found: '${path_}'` : `read failed: ${messageOf(err_)}`,
      };
    }
    const { oldText, newText } = input;
    if (typeof oldText !== 'string' || !content.includes(oldText)) {
      return { ok: false, text: `edit refused: target text not found in '${path_}'` };
    }
    const { writeFile } = await import('node:fs/promises');
    try {
      await writeFile(abs, content.replace(oldText, () => (typeof newText === 'string' ? newText : '')), 'utf8');
    } catch (err_) {
      return { ok: false, text: `edit failed: ${messageOf(err_)}` };
    }
    return { ok: true, text: `edited '${path_}': replaced 1 occurrence` };
  }
  if (name === 'run') {
    const command = typeof input?.command === 'string' ? input.command : '';
    if (command === '') return { ok: false, text: 'invalid input: command must be a non-empty string' };
    return await new Promise((done) => {
      exec(command, { cwd: process.cwd() }, (err_, stdout, stderr) => {
        if (err_ && err_.code === undefined) {
          done({ ok: false, text: `run failed: ${messageOf(err_)}` }); // spawn-level failure
          return;
        }
        const parts = [`exit ${err_ ? err_.code : 0}`];
        if (stdout !== '') parts.push(`--- stdout ---\n${stdout}`);
        if (stderr !== '') parts.push(`--- stderr ---\n${stderr}`);
        done({ ok: !err_, text: parts.join('\n') });
      });
    });
  }
  return { ok: false, text: `permission denied: ${name} is not a tool this server offers` };
}

// ---------------------------------------------------------------------------
// the prompt scripts
// ---------------------------------------------------------------------------

function materializationUpdates() {
  emitConfigOptionUpdate();
  emitModeUpdate();
  notifyUpdate({ sessionUpdate: 'usage_update', used: 10, size: 1000000 }); // context telemetry — the driver drops it
}

function endTurn() {
  respondPrompt({ stopReason: 'end_turn', usage: USAGE });
}

async function okFlow() {
  materializationUpdates();
  if (BIG_FRAME) {
    await emitBigFrameChunk(); // the straddled frame fully flushes BEFORE end_turn
  } else {
    emitChunk(REPLY ?? 'ok');
  }
  endTurn();
}

async function resumeEchoFlow() {
  materializationUpdates();
  emitChunk(`resumed from acp session ${acpSessionId}`);
  endTurn();
}

async function toolFlow({ alwaysFail }) {
  materializationUpdates();
  const input = toolInput();
  const toolCallId = `call_${TOOL}_${process.pid}`;
  const title = `${TOOL}: ${toolSummary(input)}`;
  const options = offeredOptions();

  await new Promise((answered) => {
    let settled = false;
    const answer = (result) => {
      if (settled) return;
      settled = true;
      answered(result);
    };
    askPermission(toolCallId, title, input, answer);
    if (PLACEHOLDER_CARD) {
      // The probe-recorded placeholder popup card (strategy checkpoint,
      // verbatim shape): emitted while the ask is STILL PENDING, carrying
      // the ASK's toolCallId — a driver must not mistake it for the tool
      // execution, and its id (already permission-gated) must not read as
      // never-asks evidence. The real tool_call card below overwrites it.
      notifyUpdate({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: `tool permission (${TOOL})`,
        kind: 'other',
        status: 'pending',
        content: [],
        locations: [],
      });
    }
    if (IGNORE_CANCEL) {
      // The tolerant-vendor persona, ask half: an ask the client never
      // answers TIMES OUT — the vendor abandons the permission and
      // settles the turn end_turn anyway. `answer` stays uncalled on this
      // path, so the execution continuation below is dead code (the run
      // is settling over our head).
      const askId = pendingPermission?.id;
      setTimeout(() => {
        if (pendingPermission !== null && pendingPermission.id === askId) {
          pendingPermission = null;
          emitChunk(REPLY ?? 'settled past the unanswered ask');
          endTurn();
        }
      }, TOLERANT_ASK_TIMEOUT_MS);
    }
  }).then(async (result) => {
    const outcome = result?.outcome ?? {};
    const optionId = outcome.outcome === 'selected' ? outcome.optionId : 'cancelled';
    const kind = kindOfOptionId(optionId, options);
    const allowed = typeof kind === 'string' && kind.startsWith('allow');

    // The tool_call card follows the answered request (the probed order:
    // the ask precedes every tool_call for its id).
    notifyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId,
      title,
      kind: toolKind(TOOL),
      status: 'in_progress',
      content: [],
      locations: [],
      rawInput: input,
    });

    let ok;
    let text;
    if (!allowed) {
      ok = false;
      text = `rejected (${optionId})`; // the probed deny shape: rawOutput 'rejected (deny)'
    } else if (alwaysFail) {
      ok = false;
      text = `permission denied: ${TOOL} is not allowed`; // vendor-side execution failure
    } else {
      const executed = await executeTool(TOOL, input);
      ok = executed.ok;
      text = executed.text;
    }
    notifyUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: ok ? 'completed' : 'failed',
      content: [{ type: 'text', text }],
      ...(ok ? {} : { rawOutput: text }),
    });
    emitChunk(`${REPLY ?? 'noted the tool result'} [permission:${optionId}] [mode:${sessionMode}]`);
    endTurn();
  });
}

async function neverAsksFlow() {
  materializationUpdates();
  const input = toolInput();
  const toolCallId = `call_ungated_${process.pid}`;
  const title = `${TOOL}: ${toolSummary(input)}`;
  // NO request_permission — the structural failure mode (strategy §2.1):
  // the tool really executes, ungated.
  notifyUpdate({
    sessionUpdate: 'tool_call',
    toolCallId,
    title,
    kind: toolKind(TOOL),
    status: 'in_progress',
    content: [],
    locations: [],
    rawInput: input,
  });
  const executed = await executeTool(TOOL, input);
  notifyUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: executed.ok ? 'completed' : 'failed',
    content: [{ type: 'text', text: executed.text }],
    ...(executed.ok ? {} : { rawOutput: executed.text }),
  });
  emitChunk(REPLY ?? 'executed without asking');
  endTurn();
}

function toolInput() {
  if (process.env.FAKE_ACP_INPUT === undefined) {
    if (TOOL === 'run') return { command: `echo fake-acp-marker > ${TOOL}-marker.txt` };
    if (TOOL === 'edit') return { path: 'x.txt', oldText: 'a', newText: 'b' };
    return { path: process.env.FAKE_ACP_PATH ?? 'note.txt' };
  }
  try {
    return JSON.parse(process.env.FAKE_ACP_INPUT);
  } catch {
    return { path: 'note.txt' };
  }
}

function toolSummary(input) {
  if (typeof input?.path === 'string') return input.path;
  if (typeof input?.command === 'string') return input.command;
  return '(input)';
}

function blockUntilAbortFlow() {
  materializationUpdates();
  // NO response — the turn hangs until session/cancel settles it
  // ({ stopReason: 'cancelled', usage: null }, the probed cancel shape).
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

function onFrame(frame) {
  // A response to OUR server→client request (the permission answer).
  if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
    if (pendingPermission !== null && frame.id === pendingPermission.id) {
      const current = pendingPermission;
      pendingPermission = null;
      void current.onAnswered(frame.result);
    }
    return;
  }
  switch (frame.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          protocolVersion: PROTOCOL_VERSION, // the agent never declines — it answers its latest (OQ-5)
          agentInfo: { name: 'fake-acp-server', title: 'Fake ACP', version: '0.0.0' },
          agentCapabilities: {
            loadSession: !NO_LOADSESSION, // FAKE_ACP_NO_LOADSESSION drops the §6 gate below rung 1
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            // Probe-verbatim shape (strategy §7): sessionCapabilities is a
            // member of agentCapabilities with EMPTY-object members.
            ...(ADVERTISE_RESUME ? { sessionCapabilities: { list: {}, resume: {}, fork: {} } } : {}),
          },
          authMethods: [
            {
              id: 'fake-credentials',
              name: 'Fake built-in credentials',
              description: 'The fixture self-handles auth — mirrors the probed zcode-credentials shape (OQ-1: no gate).',
            },
          ],
        },
      });
      return;
    case 'authenticate':
      // Never expected (no gate) — the error keeps the record honest if a driver ever calls it.
      send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'fake-acp-server: no auth gate; authenticate is never needed (OQ-1)' } });
      return;
    case 'session/new':
      acpSessionId = `fake-acp-${process.pid}-${++sessionCounter}`;
      sessionMode = 'yolo';
      send({
        jsonrpc: '2.0',
        id: frame.id,
        result: { sessionId: acpSessionId, modes: modesShape(), configOptions: configOptionsLazy() },
      });
      return;
    case 'session/load': {
      const sid = frame.params?.sessionId;
      if (typeof sid !== 'string' || sid === '') {
        send({ jsonrpc: '2.0', id: frame.id, error: { code: -32602, message: 'session/load requires sessionId' } });
        return;
      }
      acpSessionId = sid;
      sessionMode = 'yolo';
      if (REPLAY) replayPriorTurnHistory(); // BEFORE the response — the reference-recorded replay shape
      if (REPLAY_WITH_TAIL) {
        // The chunk-boundary shape (round-2 review): the bait replay
        // history, then the load RESPONSE LINE and a POST-load update in
        // ONE stdout flush — the tail post-dates the response line and
        // MUST fold, whatever a promise-continuation-level gate does.
        replayPriorTurnHistory();
        const response = {
          jsonrpc: '2.0',
          id: frame.id,
          result: { sessionId: acpSessionId, modes: modesShape(), configOptions: configOptionsLazy() },
        };
        const tail = {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: acpSessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: POST_LOAD_TAIL_TEXT } },
          },
        };
        process.stdout.write(`${JSON.stringify(response)}\n${JSON.stringify(tail)}\n`); // ONE flush
        return;
      }
      send({
        jsonrpc: '2.0',
        id: frame.id,
        result: { sessionId: acpSessionId, modes: modesShape(), configOptions: configOptionsLazy() },
      });
      return;
    }
    case 'unstable_resumeSession': {
      // §6 rung 2 — the middle rung the reference names
      // unstable_resumeSession when sessionCapabilities.resume is
      // advertised: same { sessionId, cwd, mcpServers } param shape as
      // load (the Devin quirk generalizes), NO history replay.
      const sid = frame.params?.sessionId;
      if (typeof sid !== 'string' || sid === '') {
        send({ jsonrpc: '2.0', id: frame.id, error: { code: -32602, message: 'unstable_resumeSession requires sessionId' } });
        return;
      }
      acpSessionId = sid;
      sessionMode = 'yolo';
      send({
        jsonrpc: '2.0',
        id: frame.id,
        result: { sessionId: acpSessionId, modes: modesShape(), configOptions: configOptionsLazy() },
      });
      return;
    }
    case 'session/set_config_option':
      if (frame.params?.configId === 'mode') {
        sessionMode = String(frame.params?.value ?? sessionMode);
      }
      send({
        jsonrpc: '2.0',
        id: frame.id,
        result: { modes: modesShape(), configOptions: configOptionsLazy() },
      });
      return;
    case 'session/prompt': {
      if (promptRequestId !== null) {
        send({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: 'a turn is already active' } });
        return;
      }
      promptRequestId = frame.id;
      const script = {
        ok: okFlow,
        'resume-echo': resumeEchoFlow,
        'tool-then-reply': () => toolFlow({ alwaysFail: false }),
        'deny-tool': () => toolFlow({ alwaysFail: true }),
        'never-asks': neverAsksFlow,
        'block-until-abort': blockUntilAbortFlow,
        fail: () => {
          errLine('fake-acp-server: simulated hard failure before any prompt response');
          process.exit(1);
        },
      }[MODE] ?? okFlow;
      void script();
      return;
    }
    case 'session/cancel':
      if (IGNORE_CANCEL) return; // the non-compliant vendor: the cancel is swallowed, the turn never settles protocol-side
      // The probed cancel settle: the ORIGINAL prompt request answers
      // 'cancelled' with usage null (§2.3: settle on the cancelled
      // RESPONSE, never on the cancel write).
      respondPrompt({ stopReason: 'cancelled', usage: null });
      return;
    default:
      if (frame.id !== undefined) {
        send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: `fake-acp-server does not implement ${frame.method}` } });
      }
  }
}

// ---------------------------------------------------------------------------
// stdin line loop
// ---------------------------------------------------------------------------

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === '') continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      errLine(`fake-acp-server: unparseable inbound line: ${line.slice(0, 200)}`);
      continue;
    }
    onFrame(frame);
    nl = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  process.exit(0); // the driver closed our stdin (or died) — exit cleanly
});
