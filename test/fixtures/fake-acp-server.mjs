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
//   FAKE_ACP_STRING_REQUEST_IDS  when '1', session/request_permission ids
//                         are JSON-RPC STRINGS (protocol-legal; the
//                         reference vendor sends numbers) — the answer
//                         must echo the id verbatim or the round-trip
//                         never completes and the turn hangs
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
// Fixed usage: { totalTokens: 20, inputTokens: 10, outputTokens: 5,
// thoughtTokens: 0, cachedReadTokens: 2, cachedWriteTokens: 3 } — frozen
// by the driver's usage-mapping test as { input: 10, output: 5,
// cacheRead: 2, cacheWrite: 3 } with NO reasoning field.
import { exec } from 'node:child_process';
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
const STRING_REQUEST_IDS = process.env.FAKE_ACP_STRING_REQUEST_IDS === '1';

const USAGE = {
  totalTokens: 20,
  inputTokens: 10,
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
  send({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId: acpSessionId,
      toolCall: { toolCallId, rawInput: input, title, content: [], locations: [] },
      options,
    },
  });
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
  emitChunk(REPLY ?? 'ok');
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
    askPermission(toolCallId, title, input, (result) => answered(result));
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
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
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
