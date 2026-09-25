// Fake agent CLI — the stream-json fixture for the subprocess driver's tests
// (T1.5 slice 2, W1.4) and the T1.7 smoke lane. Dependency-free, node:
// builtins only, run as `node test/fixtures/fake-agent-cli.mjs`.
//
// It speaks the headless contract the driver parses (src/driver/subprocess)
// in TWO surfaces, selected by argv exactly as the real `claude` CLI is:
//
//   HARNESS MODE — `--tools ""` present (the driver's default closed surface):
//     argv:  -p --output-format stream-json --verbose [--json-schema <json>]
//            --tools "" --setting-sources "" --strict-mcp-config
//            [--mcp-config <file>] --allowedTools "<space-separated names>"
//            --model <id> [--resume <id>]
//     Mimics claude 2.1.280 (recorded live, W1.4 A.5a): no builtin tool
//     exists. Every server in the --mcp-config file is SPAWNED (command/args,
//     env = this process's env merged with the config's `env`) and driven
//     over newline-delimited JSON-RPC: `initialize` (protocolVersion
//     '2025-06-18' + clientInfo) → `notifications/initialized` →
//     `tools/list`, bounded by FAKE_AGENT_MCP_TIMEOUT_MS (default 10s).
//     Status 'connected' on success, 'failed' otherwise (e.g. the server
//     refused its manifest and exited 78). The init event then reports
//       tools: ['StructuredOutput' (only with --json-schema),
//               'mcp__<server>__<tool>' for every connected server's tool]
//       mcp_servers: [{name, status, source:'dynamic'}]
//     The scripted tool (FAKE_AGENT_TOOL — a HARNESS name: read/run/edit) is
//     addressed as mcp__cq-harness__<tool>:
//       - NOT on the reported surface → the model cannot see it: no tool_use
//         is emitted at all, just the reply;
//       - on the surface but outside --allowedTools → the CLI permission
//         gate: tool_use, then {type:'system', subtype:'permission_denied',
//         tool_name, tool_use_id, message}, then an is_error tool_result
//         with that same "Claude requested permissions to use …" text, and
//         result.permission_denials lists it;
//       - allowed → executed through `tools/call`; a success result's
//         content is the server's text-block ARRAY, an isError result's
//         content is a PLAIN STRING (the server's text verbatim) with
//         is_error:true; a JSON-RPC error or a dead server becomes
//         CLI-authored text ('MCP error <code>: <message>').
//     Structured output under --json-schema: a 'StructuredOutput' tool_use
//     carrying the payload, its tool_result 'Structured output provided
//     successfully', then result.structured_output.
//     On exit every server's stdin is closed (EOF) and the fixture waits
//     briefly for it to exit (SIGKILL after the wait).
//
//   STOCK MODE — no --tools flag (the driver's `toolSurface: 'stock'`, and
//   standalone use): the LEGACY in-process emulation. The init event carries
//   only session_id + model; the scripted tool_use is emitted under the raw
//   harness name and EXECUTED in-process against cwd (the driver's
//   workspace) — read/run/edit with harness-matching denial reasons ('file
//   not found: …', 'path escape: …', 'edit refused: …'). A tool not in
//   FAKE_AGENT_ALLOWED (the driver's --allowedTools, forwarded by the test)
//   is DENIED without executing ('permission denied: …').
//
//   stdin: the prompt (read to EOF; the content steers nothing — the script
//          below is the model).
//   stdout: one JSON event per line (system/init, assistant text|tool_use,
//          user tool_result, system/permission_denied, result).
//   stderr: diagnostics. Exit 0 on a completed run, non-zero on a simulated
//   hard failure (via process.exitCode, so stdio flushes).
//
// SCRIPTED BEHAVIOR (env FAKE_AGENT_MODE, values below) — the default is a
// clean 'ok' completion with fixed usage numbers:
//   FAKE_AGENT_SERVED_MODEL — a GLOBAL override, not a mode: the model id
//                    both contract events report as served (default: the
//                    requested --model). Simulates a gateway silently
//                    remapping the requested name server-side.
//   ok               assistant text (FAKE_AGENT_REPLY ?? 'ok') + result
//   structured-ok    result carries structured_output {answer:'ok'};
//                    FAKE_AGENT_STRUCTURED_RAW overrides the payload
//                    verbatim with NO --json-schema checking (a lying CLI,
//                    for observing the driver's own seam validation)
//   tool-then-reply  ONE tool_use (FAKE_AGENT_TOOL/FAKE_AGENT_INPUT, default
//                    a read of FAKE_AGENT_PATH ?? 'note.txt'), executed per
//                    the surface rules above, then the reply text
//   echo-workspace   alias: tool-then-reply reading FAKE_AGENT_PATH ??
//                    'note.txt' (the tool_use read of a workspace file)
//   deny-tool        scripted permission denial + result is_error:true. Stock:
//                    tool_use 'edit' + is_error tool_result ('permission
//                    denied: edit is not allowed'). Harness: the CLI
//                    permission-gate shape for mcp__cq-harness__edit (frame +
//                    'Claude requested permissions …' text), never executed
//   error-result     result is_error:true with result + errors + subtype set
//                    (the driver's result→errors→subtype cause precedence)
//   error-errors     result is_error:true with only errors set (middle leg)
//   emit-junk        non-JSON lines interleaved into an ok run
//   budget-usage     ok run reporting usage far above any small cap
//   resume-echo      ok run whose reply echoes the received --resume id
//   unknown-model    stderr error naming the model, exit 1 — the silent-
//                    remap footgun's outcome, simulated
//   fail             stderr error, exit 1, no result event
//   self-kill        kill the CLI with SIGKILL, emitting NO result event —
//                    the driver's signal-death error cause (#208)
//   slow-exit-ms     stay alive FAKE_AGENT_SLOW_EXIT_MS ms, then a normal
//                    ok completion (default SIGTERM kills it mid-run)
//   block-until-abort|ignore-sigterm
//                    stay alive indefinitely; ignore-sigterm installs a
//                    SIGTERM handler that ignores it (forcing the driver's
//                    SIGKILL rung), block-until-abort keeps the DEFAULT
//                    disposition (dies on SIGTERM — the graceful rung)
//
// HARNESS-MODE PROBES (env, W1.4):
//   FAKE_AGENT_INIT_EXTRA_TOOL=<name>    init also reports this tool (e.g.
//                    'Bash' — a builtin `--tools ""` failed to strip)
//   FAKE_AGENT_INIT_EXTRA_SERVER=<name>  init also reports this server as
//                    connected (a leaked connector / stray .mcp.json)
//   FAKE_AGENT_NO_INIT=1                 no system/init event at all
//   FAKE_AGENT_KILL_SERVER=1             SIGKILL the cq-harness server right
//                    before the tool call; the tool_result is then is_error
//                    with the CLI-authored text 'MCP error -32000: Connection
//                    closed' (a transport failure, never a harness denial)
//   FAKE_AGENT_CONFIG_PROBE=<file>       records the --mcp-config file's
//                    state as JSON {path, atStart:{present, mode, symlink},
//                    afterInit:{present}} — atStart before the servers are
//                    spawned, afterInit FAKE_AGENT_CONFIG_PROBE_DELAY_MS
//                    (default 500) after init was emitted; the scripted run
//                    waits for the probe, so it lands while the run is live
//   FAKE_AGENT_SERVER_PID_FILE=<file>    the spawned servers' pids, one per
//                    line (a liveness probe for the process-group kill)
//
// FIXTURE-ONLY PROBE FLAG (--spawn-grandchild <file>, issue #19): with the
// flag set (any mode), the CLI spawns a SLEEPING GRANDCHILD that inherits
// the CLI's process group, records the grandchild's pid into <file>, and
// stays alive itself — the descendant-survival probe for the driver's
// process-group kill (a direct-child-only kill leaves the grandchild
// running; a group kill takes it down).
//
// Fixed usage everywhere: {input_tokens:10, output_tokens:5,
// cache_read_input_tokens:2, cache_creation_input_tokens:3} (budget-usage
// overrides the numbers, not the shape).
import { exec, spawn } from 'node:child_process';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// argv + env plumbing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flagValue = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 || index + 1 >= args.length ? undefined : args[index + 1];
};

const MODE = process.env.FAKE_AGENT_MODE; // undefined === 'ok'
const REPLY = process.env.FAKE_AGENT_REPLY;
const TOOL = process.env.FAKE_AGENT_TOOL;
const TOOL_INPUT = process.env.FAKE_AGENT_INPUT;
const TOOL_PATH = process.env.FAKE_AGENT_PATH;
const SLOW_EXIT_MS = Number(process.env.FAKE_AGENT_SLOW_EXIT_MS ?? '0');
const ALLOWED = process.env.FAKE_AGENT_ALLOWED; // undefined (standalone) = all; '' = none
const SERVED_MODEL = process.env.FAKE_AGENT_SERVED_MODEL;
const STRUCTURED_RAW = process.env.FAKE_AGENT_STRUCTURED_RAW;
const INIT_EXTRA_TOOL = process.env.FAKE_AGENT_INIT_EXTRA_TOOL;
const INIT_EXTRA_SERVER = process.env.FAKE_AGENT_INIT_EXTRA_SERVER;
const NO_INIT = process.env.FAKE_AGENT_NO_INIT === '1';
const KILL_SERVER = process.env.FAKE_AGENT_KILL_SERVER === '1';
const CONFIG_PROBE = process.env.FAKE_AGENT_CONFIG_PROBE;
const CONFIG_PROBE_DELAY_MS = Number(process.env.FAKE_AGENT_CONFIG_PROBE_DELAY_MS ?? '500');
const SERVER_PID_FILE = process.env.FAKE_AGENT_SERVER_PID_FILE;
const MCP_TIMEOUT_MS = Number(process.env.FAKE_AGENT_MCP_TIMEOUT_MS ?? '10000');
const resumeId = flagValue('--resume');
const jsonSchemaRaw = flagValue('--json-schema');
const spawnGrandchildPath = flagValue('--spawn-grandchild');
const model = flagValue('--model') ?? 'fake-model';
const servedModel = SERVED_MODEL ?? model; // the endpoint's response model — a remap simulation overrides it

/** HARNESS MODE: the closed surface, exactly as the real CLI keys it — `--tools` present. */
const HARNESS = args.includes('--tools');
const mcpConfigPath = flagValue('--mcp-config');
/** The --allowedTools value, space-split (the real CLI's permission allowlist). */
const allowedToolsArgv = (flagValue('--allowedTools') ?? '').split(/\s+/).filter((t) => t !== '');

/** The harness MCP server name and its addressable tool prefix. */
const HARNESS_SERVER = 'cq-harness';
const qualified = (server, tool) => `mcp__${server}__${tool}`;
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 2,
  cache_creation_input_tokens: 3,
};
const BUDGET_USAGE = {
  input_tokens: 120_000,
  output_tokens: 30_000,
  cache_read_input_tokens: 1_000,
  cache_creation_input_tokens: 500,
};

const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const err = (line) => process.stderr.write(`${line}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The CLI session id: stable under --resume, unique otherwise. */
const sessionId = resumeId ?? `fake-cli-${process.pid}-${Date.now().toString(36)}`;

/** Harness-mode permission denials, reported on the result event (real CLI shape). */
const permissionDenials = [];

// ---------------------------------------------------------------------------
// --json-schema light validation: required keys present + rough JSON types.
// Returns an error string, or undefined when the value plausibly matches.
// ---------------------------------------------------------------------------

function schemaError(schema, value) {
  if (schema === undefined) return undefined;
  if (schema.type === 'object' || schema.properties !== undefined) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return 'structured_output is not an object';
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) return `structured_output is missing required key '${key}'`;
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (!(key in value) || propSchema?.type === undefined) continue;
      const actual = Array.isArray(value[key]) ? 'array' : typeof value[key];
      const expected = propSchema.type === 'integer' ? 'number' : propSchema.type;
      if (actual !== expected) {
        return `structured_output['${key}'] is ${actual}, expected ${propSchema.type}`;
      }
    }
  }
  return undefined;
}

function parsedJsonSchema() {
  try {
    return jsonSchemaRaw === undefined ? undefined : JSON.parse(jsonSchemaRaw);
  } catch {
    return undefined;
  }
}

/** The structured_output for a completed run, when a schema was requested. */
function structuredOutputFor(replyText) {
  if (jsonSchemaRaw === undefined) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(replyText);
  } catch {
    return undefined; // non-JSON reply — no structured output to offer
  }
  const schema = parsedJsonSchema();
  const problem = schema === undefined ? undefined : schemaError(schema, parsed);
  if (problem !== undefined) {
    err(`fake-agent-cli: structured_output rejected by --json-schema: ${problem}`);
    return undefined;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

let toolUseCounter = 0;
const nextToolUseId = () => `toolu_fake_${String(++toolUseCounter).padStart(2, '0')}`;

const emitAssistantText = (text, usage = USAGE) =>
  out({ type: 'assistant', message: { content: [{ type: 'text', text }], usage } });
const emitToolUse = (id, name, input, usage = USAGE) =>
  out({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }], usage },
  });
const emitToolResult = (toolUseId, isError, content) =>
  out({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content }],
    },
  });
const emitResult = (overrides = {}) =>
  out({
    type: 'result',
    subtype: overrides.is_error === true ? 'error_during_execution' : 'success',
    is_error: false,
    session_id: sessionId,
    usage: USAGE,
    model: servedModel,
    ...(HARNESS ? { permission_denials: permissionDenials } : {}),
    ...overrides,
  });
const emitJunk = () => {
  process.stdout.write('fake-agent-cli: transient bootstrapping noise (not json)\n');
  out({ type: 'system', subtype: 'status', message: 'worthless non-contract event' });
  process.stdout.write('{broken json at line level\n');
};

// ---------------------------------------------------------------------------
// HARNESS MODE: the MCP client — spawn each configured server, handshake
// over newline-delimited JSON-RPC, list its tools, call them.
// ---------------------------------------------------------------------------

/** Every spawned server connection, in config order. */
const servers = [];

function spawnServer(name, spec) {
  const conn = {
    name,
    status: 'pending',
    tools: [],
    exited: false,
    pending: new Map(),
    nextId: 1,
    child: undefined,
    exitPromise: undefined,
  };
  const closeAll = (why) => {
    conn.exited = true;
    for (const { reject } of conn.pending.values()) reject(new Error(why));
    conn.pending.clear();
  };
  let child;
  try {
    child = spawn(spec.command, Array.isArray(spec.args) ? spec.args : [], {
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err_) {
    conn.exited = true;
    conn.status = 'failed';
    err(`fake-agent-cli: MCP server '${name}' failed to spawn: ${messageOf(err_)}`);
    conn.exitPromise = Promise.resolve();
    return conn;
  }
  conn.child = child;
  conn.exitPromise = new Promise((done) => {
    child.once('exit', () => {
      closeAll('Connection closed');
      done();
    });
    child.once('error', () => {
      closeAll('Connection closed');
      done();
    });
  });
  child.stdin.on('error', () => {}); // EPIPE on a dead server is a closed connection, not a crash
  child.stderr.resume(); // drained, never forwarded (the real CLI keeps server stderr to itself)
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let nl;
    while ((nl = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = conn.pending.get(message?.id);
      if (waiter !== undefined) {
        conn.pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });
  return conn;
}

function mcpRequest(conn, method, params, timeoutMs) {
  if (conn.exited || conn.child === undefined) {
    return Promise.reject(new Error('Connection closed'));
  }
  const id = conn.nextId++;
  return new Promise((resolve_, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error('Request timed out'));
    }, timeoutMs);
    conn.pending.set(id, {
      resolve: (message) => {
        clearTimeout(timer);
        resolve_(message);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    conn.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function mcpNotify(conn, method, params) {
  if (conn.exited || conn.child === undefined) return;
  conn.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

async function handshake(conn) {
  const deadline = Date.now() + MCP_TIMEOUT_MS;
  const left = () => Math.max(1, deadline - Date.now());
  try {
    const init = await mcpRequest(
      conn,
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fake-agent-cli', version: '0.0.0' },
      },
      left(),
    );
    if (init.error !== undefined) throw new Error(`initialize failed: ${init.error.message}`);
    mcpNotify(conn, 'notifications/initialized');
    const list = await mcpRequest(conn, 'tools/list', {}, left());
    if (list.error !== undefined) throw new Error(`tools/list failed: ${list.error.message}`);
    conn.tools = (list.result?.tools ?? []).map((tool) => tool.name);
    conn.status = 'connected';
  } catch (err_) {
    conn.status = 'failed';
    conn.tools = [];
    err(`fake-agent-cli: MCP server '${conn.name}' failed: ${messageOf(err_)}`);
  }
}

/** Read the --mcp-config file, spawn and handshake every server (in parallel). */
async function connectServers() {
  if (mcpConfigPath === undefined) return;
  let config;
  try {
    config = JSON.parse(await readFile(mcpConfigPath, 'utf8'));
  } catch (err_) {
    err(`fake-agent-cli: cannot read --mcp-config '${mcpConfigPath}': ${messageOf(err_)}`);
    return;
  }
  for (const [name, spec] of Object.entries(config?.mcpServers ?? {})) {
    servers.push(spawnServer(name, spec ?? {}));
  }
  if (SERVER_PID_FILE !== undefined) {
    const pids = servers.map((conn) => conn.child?.pid).filter((pid) => pid !== undefined);
    await writeFile(SERVER_PID_FILE, pids.join('\n'), 'utf8');
  }
  await Promise.all(servers.filter((conn) => conn.status === 'pending').map(handshake));
}

/** EOF every server's stdin, wait briefly, then SIGKILL stragglers. */
async function shutdownServers() {
  await Promise.all(
    servers.map(async (conn) => {
      if (conn.exited || conn.child === undefined) return;
      conn.child.stdin.end();
      const exited = await Promise.race([conn.exitPromise.then(() => true), sleep(2_000)]);
      if (!exited) conn.child.kill('SIGKILL');
    }),
  );
}

/** The reported init surface (tools + mcp_servers), computed from the live connections. */
function initSurface() {
  const tools = [];
  if (jsonSchemaRaw !== undefined) tools.push(STRUCTURED_OUTPUT_TOOL);
  for (const conn of servers) {
    if (conn.status === 'connected') tools.push(...conn.tools.map((t) => qualified(conn.name, t)));
  }
  if (INIT_EXTRA_TOOL !== undefined) tools.push(INIT_EXTRA_TOOL);
  const mcpServers = servers.map((conn) => ({
    name: conn.name,
    status: conn.status,
    source: 'dynamic',
  }));
  if (INIT_EXTRA_SERVER !== undefined) {
    mcpServers.push({ name: INIT_EXTRA_SERVER, status: 'connected', source: 'dynamic' });
  }
  return { tools, mcp_servers: mcpServers };
}

const emitInit = () =>
  out({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: servedModel,
    ...(HARNESS ? initSurface() : {}),
  });

/** The config-file probe: its state before the servers spawn. */
async function configStateAtStart() {
  if (mcpConfigPath === undefined) return { present: false };
  try {
    const info = await lstat(mcpConfigPath);
    return { present: true, mode: info.mode & 0o777, symlink: info.isSymbolicLink() };
  } catch {
    return { present: false };
  }
}

async function configPresent() {
  if (mcpConfigPath === undefined) return false;
  try {
    await lstat(mcpConfigPath);
    return true;
  } catch {
    return false;
  }
}

/** The CLI permission-gate text (RS-1b b3/b6, recorded live). */
const permissionText = (name) =>
  `Claude requested permissions to use ${name}, but you haven't granted it yet.`;

/** Emit the CLI permission-gate shape for an addressed tool: frame + is_error result. */
function emitPermissionDenied(id, name, input) {
  out({
    type: 'system',
    subtype: 'permission_denied',
    tool_name: name,
    tool_use_id: id,
    message: permissionText(name),
  });
  emitToolResult(id, true, permissionText(name));
  permissionDenials.push({ tool_name: name, tool_use_id: id, tool_input: input });
}

/** Execute one addressed harness tool over MCP and emit the tool_result (real CLI mapping). */
async function callHarnessTool(id, tool) {
  const conn = servers.find((candidate) => candidate.name === HARNESS_SERVER);
  if (conn === undefined) {
    emitToolResult(id, true, 'MCP error -32000: Connection closed');
    return;
  }
  if (KILL_SERVER && conn.child !== undefined && !conn.exited) {
    conn.child.kill('SIGKILL');
    await conn.exitPromise;
  }
  let response;
  try {
    response = await mcpRequest(
      conn,
      'tools/call',
      { name: tool.name, arguments: tool.input ?? {} },
      30_000,
    );
  } catch (err_) {
    const code = messageOf(err_) === 'Request timed out' ? -32001 : -32000;
    emitToolResult(id, true, `MCP error ${code}: ${messageOf(err_)}`);
    return;
  }
  if (response.error !== undefined) {
    emitToolResult(id, true, `MCP error ${response.error.code}: ${response.error.message}`);
    return;
  }
  const content = Array.isArray(response.result?.content) ? response.result.content : [];
  if (response.result?.isError === true) {
    // An MCP isError result reaches the stream as a PLAIN STRING (recorded live).
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    emitToolResult(id, true, text);
    return;
  }
  emitToolResult(id, false, content);
}

// ---------------------------------------------------------------------------
// STOCK MODE: real tool execution against cwd (the driver's workspace) — the
// read/run/edit trio with harness-matching denial reasons. Never throws.
// ---------------------------------------------------------------------------

const messageOf = (err_) => (err_ instanceof Error ? err_.message : String(err_));

/** Workspace containment, lexical only (the fixture needs no symlink war). */
function resolveInside(path_) {
  const root = resolve(process.cwd());
  const abs = resolve(root, path_);
  return abs === root || abs.startsWith(root + sep) ? abs : undefined;
}

async function executeTool(name, input) {
  if (name === 'read') {
    const path_ = typeof input?.path === 'string' ? input.path : '';
    const abs = resolveInside(path_);
    if (abs === undefined)
      return { ok: false, text: `path escape: '${path_}' resolves outside the workspace` };
    // Symlink re-check ONLY when the path actually resolves (the harness's
    // posture): a missing path must fall through to the fs op for its
    // honest 'file not found' denial, never a symlink escape.
    let target = abs;
    try {
      target = await realpath(abs);
      const realRoot = await realpath(resolve(process.cwd()));
      if (target !== realRoot && !target.startsWith(realRoot + sep)) {
        return {
          ok: false,
          text: `path escape: '${path_}' escapes the workspace through a symlink`,
        };
      }
    } catch {
      // unresolvable (missing …) — the read below produces the real denial
    }
    try {
      const text = await readFile(target, 'utf8');
      return { ok: true, text };
    } catch (err_) {
      return {
        ok: false,
        text: messageOf(err_).includes('ENOENT')
          ? `file not found: '${path_}'`
          : `read failed: ${messageOf(err_)}`,
      };
    }
  }
  if (name === 'edit') {
    const path_ = typeof input?.path === 'string' ? input.path : '';
    const abs = resolveInside(path_);
    if (abs === undefined)
      return { ok: false, text: `path escape: '${path_}' resolves outside the workspace` };
    let content;
    try {
      content = await readFile(abs, 'utf8');
    } catch (err_) {
      return {
        ok: false,
        text: messageOf(err_).includes('ENOENT')
          ? `file not found: '${path_}'`
          : `read failed: ${messageOf(err_)}`,
      };
    }
    const { oldText, newText } = input;
    if (typeof oldText !== 'string' || !content.includes(oldText)) {
      return { ok: false, text: `edit refused: target text not found in '${path_}'` };
    }
    try {
      await writeFile(
        abs,
        content.replace(oldText, () => (typeof newText === 'string' ? newText : '')),
        'utf8',
      );
    } catch (err_) {
      return { ok: false, text: `edit failed: ${messageOf(err_)}` };
    }
    return { ok: true, text: `edited '${path_}': replaced 1 occurrence` };
  }
  if (name === 'run') {
    const command = typeof input?.command === 'string' ? input.command : '';
    if (command === '')
      return { ok: false, text: 'invalid input: command must be a non-empty string' };
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
  return { ok: false, text: `permission denied: ${name} is not a tool this CLI offers` };
}

/** The stock-mode permission simulation: only FAKE_AGENT_ALLOWED names run. */
function permissionDenied(name) {
  if (ALLOWED === undefined) return false; // standalone fixture run — permissive
  return !ALLOWED.split(/\s+/)
    .filter((token) => token !== '')
    .includes(name);
}

// ---------------------------------------------------------------------------
// The scripted run
// ---------------------------------------------------------------------------

function keepAlive() {
  return setInterval(() => {}, 60_000);
}

/** Harness mode + --json-schema: the CLI's native StructuredOutput tool round-trip. */
function emitStructuredOutputTool(payload) {
  const id = nextToolUseId();
  emitToolUse(id, STRUCTURED_OUTPUT_TOOL, payload);
  emitToolResult(id, false, 'Structured output provided successfully');
}

async function okFlow(replyText, usage = USAGE) {
  emitAssistantText(replyText, usage);
  const structured = structuredOutputFor(replyText);
  if (HARNESS && structured !== undefined) emitStructuredOutputTool(structured);
  emitResult({ usage, ...(structured === undefined ? {} : { structured_output: structured }) });
}

function scriptedToolInput() {
  try {
    return TOOL_INPUT === undefined ? { path: TOOL_PATH ?? 'note.txt' } : JSON.parse(TOOL_INPUT);
  } catch {
    return { path: TOOL_PATH ?? 'note.txt' };
  }
}

async function toolThenReply() {
  const name = TOOL ?? 'read';
  const input = scriptedToolInput();
  if (HARNESS) {
    const addressed = qualified(HARNESS_SERVER, name);
    // Off the reported surface, the model cannot see the tool: no tool_use.
    if (initSurface().tools.includes(addressed)) {
      const id = nextToolUseId();
      emitToolUse(id, addressed, input);
      if (!allowedToolsArgv.includes(addressed)) {
        emitPermissionDenied(id, addressed, input);
      } else {
        await callHarnessTool(id, { name, input });
      }
    }
    await okFlow(REPLY ?? 'noted the tool result');
    return;
  }
  emitToolUse('tu-1', name, input);
  if (permissionDenied(name)) {
    emitToolResult('tu-1', true, `permission denied: ${name} is not allowed`);
  } else {
    const outcome = await executeTool(name, input);
    emitToolResult('tu-1', !outcome.ok, outcome.text);
  }
  await okFlow(REPLY ?? 'noted the tool result');
}

async function structuredOk() {
  emitAssistantText(REPLY ?? '{"answer":"ok"}');
  // FAKE_AGENT_STRUCTURED_RAW: emit this JSON verbatim as structured_output
  // with NO --json-schema checking — a lying CLI, so the DRIVER's own
  // schema validation can be observed dropping the payload.
  if (STRUCTURED_RAW !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(STRUCTURED_RAW);
    } catch {
      parsed = STRUCTURED_RAW;
    }
    if (HARNESS && jsonSchemaRaw !== undefined) emitStructuredOutputTool(parsed);
    emitResult({ structured_output: parsed });
    return;
  }
  const structured = { answer: 'ok' };
  const schema = parsedJsonSchema();
  const problem = schema === undefined ? undefined : schemaError(schema, structured);
  if (problem !== undefined) {
    err(`fake-agent-cli: structured_output rejected by --json-schema: ${problem}`);
    emitResult({ is_error: true, subtype: 'error_during_execution' });
    return;
  }
  if (HARNESS && jsonSchemaRaw !== undefined) emitStructuredOutputTool(structured);
  emitResult({ structured_output: structured });
}

/** Returns true when the process must stay alive (the governed ladder decides its end). */
async function scriptedRun() {
  // The descendant-survival probe (header): a sleeping grandchild in THIS
  // process group, its pid recorded for the test's liveness poll. The CLI
  // stays alive afterwards — the governed ladder decides when it dies.
  if (spawnGrandchildPath !== undefined) {
    const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore', // SAME process group (not detached) — that is the point
    });
    grandchild.unref();
    try {
      await writeFile(spawnGrandchildPath, String(grandchild.pid), 'utf8');
    } catch {
      err('fake-agent-cli: could not record the grandchild pid');
      process.exitCode = 1;
      return false;
    }
    keepAlive();
    return true;
  }

  if (MODE === 'ignore-sigterm' || MODE === 'block-until-abort') {
    // block-until-abort keeps the default SIGTERM disposition — the graceful rung
    keepAlive();
    return true;
  }
  if (MODE === 'slow-exit-ms') {
    await sleep(SLOW_EXIT_MS);
    await okFlow(REPLY ?? 'slow exit');
    return false;
  }
  if (MODE === 'deny-tool') {
    if (HARNESS) {
      const addressed = qualified(HARNESS_SERVER, 'edit');
      const id = nextToolUseId();
      emitToolUse(id, addressed, { path: 'x' });
      emitPermissionDenied(id, addressed, { path: 'x' });
    } else {
      emitToolUse('tu-deny', 'edit', { path: 'x' });
      emitToolResult('tu-deny', true, 'permission denied: edit is not allowed');
    }
    emitResult({ is_error: true, subtype: 'error_during_execution' });
    return false;
  }
  if (MODE === 'error-result') {
    // A failed result frame carrying ALL THREE cause sources so the driver's
    // precedence (result → errors → subtype) is observable (#208).
    emitResult({
      is_error: true,
      subtype: 'error_during_execution',
      result: 'result-string-cause',
      errors: ['errors-entry-cause'],
    });
    return false;
  }
  if (MODE === 'error-errors') {
    // A failed frame with only `errors` set (the middle precedence leg).
    emitResult({
      is_error: true,
      subtype: 'error_during_execution',
      errors: ['errors-entry-cause'],
    });
    return false;
  }
  if (MODE === 'emit-junk') {
    emitJunk();
    await okFlow(REPLY ?? 'ok despite the junk');
    return false;
  }
  if (MODE === 'budget-usage') {
    await okFlow(REPLY ?? 'expensive reply', BUDGET_USAGE);
    return false;
  }
  if (MODE === 'resume-echo') {
    await okFlow(`resumed from cli session ${resumeId ?? 'none'}`);
    return false;
  }
  if (MODE === 'structured-ok') {
    await structuredOk();
    return false;
  }
  if (MODE === 'tool-then-reply' || MODE === 'echo-workspace') {
    await toolThenReply();
    return false;
  }
  // Default: a clean ok completion.
  await okFlow(REPLY ?? 'ok');
  return false;
}

async function main() {
  // Consume the prompt (stdin to EOF) without gating the event stream on it.
  process.stdin.resume();

  // The ignore handler installs BEFORE anything else (init included) — a
  // governed SIGTERM that raced node startup would otherwise kill us via
  // the default disposition and never exercise the SIGKILL rung.
  if (MODE === 'ignore-sigterm') {
    process.on('SIGTERM', () => {
      // deliberately ignored — the driver must escalate to SIGKILL
    });
  }

  if (MODE === 'unknown-model') {
    err(
      `fake-agent-cli: model '${model}' is not served by this endpoint; serving the endpoint default instead`,
    );
    // exitCode, not exit(): stdout/stderr flush before the process reaps.
    process.exitCode = 1;
    return;
  }
  if (MODE === 'fail') {
    err('fake-agent-cli: simulated hard failure before any result');
    process.exitCode = 1;
    return;
  }
  if (MODE === 'self-kill') {
    // Die by a REAL signal with NO result event (#208): the driver's error
    // cause must name the signal, not a governed abort (this run is not
    // governed). SIGKILL is uncatchable and leaves no exit code.
    process.kill(process.pid, 'SIGKILL');
    return;
  }

  let stayAlive = false;
  try {
    const atStart = HARNESS && CONFIG_PROBE !== undefined ? await configStateAtStart() : undefined;
    if (HARNESS) await connectServers();
    if (!NO_INIT) emitInit();
    if (atStart !== undefined) {
      // The driver deletes the config once init reports connected: probe
      // after a short delay while the run is still live.
      await sleep(CONFIG_PROBE_DELAY_MS);
      await writeFile(
        CONFIG_PROBE,
        JSON.stringify({
          path: mcpConfigPath ?? null,
          atStart,
          afterInit: { present: await configPresent() },
        }),
        'utf8',
      );
    }
    stayAlive = await scriptedRun();
  } finally {
    if (!stayAlive) await shutdownServers();
  }
}

main().catch((err_) => {
  err(`fake-agent-cli: ${messageOf(err_)}`);
  process.exitCode = 1; // no exit(): let stdio flush before the reaper
});
