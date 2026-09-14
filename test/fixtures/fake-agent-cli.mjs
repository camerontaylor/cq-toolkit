// Fake agent CLI — the stream-json fixture for the subprocess driver's tests
// (T1.5 slice 2) and the T1.7 smoke lane. Dependency-free, node: builtins
// only, run as `node test/fixtures/fake-agent-cli.mjs`.
//
// It speaks the headless contract the driver parses (src/driver/subprocess):
//
//   argv:  -p   --output-format stream-json   --verbose?  --json-schema <json>
//          --allowedTools <space-separated names>
//          --model <id>   --resume <id>
//          --spawn-grandchild <file>   (fixture-only probe flag, see below)
//   stdin: the prompt (read to EOF; the content steers nothing — the script
//          below is the model).
//   stdout: one JSON event per line —
//     {type:'system', subtype:'init', session_id, model}
//     {type:'assistant', message:{content:[{type:'text',text}
//                                         |{type:'tool_use',id,name,input}],
//                                usage}}
//     {type:'user', message:{content:[{type:'tool_result',tool_use_id,
//                                      is_error,content}]}}
//     {type:'result', subtype:'success', is_error:false, session_id, usage,
//      model, structured_output?}
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
//                    a read of FAKE_AGENT_PATH ?? 'note.txt') EXECUTED for
//                    real against cwd (the driver's workspace) — read/run/
//                    edit with harness-matching denial reasons ('file not
//                    found: …', 'path escape: …', 'edit refused: …') — then
//                    the reply text. A tool not in FAKE_AGENT_ALLOWED (the
//                    driver's --allowedTools, forwarded by the test) is
//                    DENIED without executing ('permission denied: …'),
//                    simulating --permission-prompts none.
//   echo-workspace   alias: tool-then-reply reading FAKE_AGENT_PATH ??
//                    'note.txt' (the tool_use read of a workspace file)
//   deny-tool        scripted permission denial: tool_use 'edit' + is_error
//                    tool_result + result is_error:true (no execution)
//   emit-junk        non-JSON lines interleaved into an ok run
//   budget-usage     ok run reporting usage far above any small cap
//   resume-echo      ok run whose reply echoes the received --resume id
//   unknown-model    stderr error naming the model, exit 1 — the silent-
//                    remap footgun's outcome, simulated
//   fail             stderr error, exit 1, no result event
//   slow-exit-ms     stay alive FAKE_AGENT_SLOW_EXIT_MS ms, then a normal
//                    ok completion (default SIGTERM kills it mid-run)
//   block-until-abort|ignore-sigterm
//                    stay alive indefinitely; ignore-sigterm installs a
//                    SIGTERM handler that ignores it (forcing the driver's
//                    SIGKILL rung), block-until-abort keeps the DEFAULT
//                    disposition (dies on SIGTERM — the graceful rung)
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
import { readFile, realpath, writeFile } from 'node:fs/promises';
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
const resumeId = flagValue('--resume');
const jsonSchemaRaw = flagValue('--json-schema');
const spawnGrandchildPath = flagValue('--spawn-grandchild');
const model = flagValue('--model') ?? 'fake-model';
const servedModel = SERVED_MODEL ?? model; // the endpoint's response model — a remap simulation overrides it

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

/** The CLI session id: stable under --resume, unique otherwise. */
const sessionId = resumeId ?? `fake-cli-${process.pid}-${Date.now().toString(36)}`;

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

/** The structured_output for a completed run, when a schema was requested. */
function structuredOutputFor(replyText) {
  if (jsonSchemaRaw === undefined) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(replyText);
  } catch {
    return undefined; // non-JSON reply — no structured output to offer
  }
  let schema;
  try {
    schema = JSON.parse(jsonSchemaRaw);
  } catch {
    schema = undefined;
  }
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

const emitInit = () => out({ type: 'system', subtype: 'init', session_id: sessionId, model: servedModel });
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
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content }] },
  });
const emitResult = (overrides = {}) =>
  out({
    type: 'result',
    subtype: overrides.is_error === true ? 'error_during_execution' : 'success',
    is_error: false,
    session_id: sessionId,
    usage: USAGE,
    model: servedModel,
    ...overrides,
  });const emitJunk = () => {
  process.stdout.write('fake-agent-cli: transient bootstrapping noise (not json)\n');
  out({ type: 'system', subtype: 'status', message: 'worthless non-contract event' });
  process.stdout.write('{broken json at line level\n');
};

// ---------------------------------------------------------------------------
// Real tool execution against cwd (the driver's workspace) — the read/run/
// edit trio with harness-matching denial reasons. Never throws.
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
    if (abs === undefined) return { ok: false, text: `path escape: '${path_}' resolves outside the workspace` };
    // Symlink re-check ONLY when the path actually resolves (the harness's
    // posture): a missing path must fall through to the fs op for its
    // honest 'file not found' denial, never a symlink escape.
    let target = abs;
    try {
      target = await realpath(abs);
      const realRoot = await realpath(resolve(process.cwd()));
      if (target !== realRoot && !target.startsWith(realRoot + sep)) {
        return { ok: false, text: `path escape: '${path_}' escapes the workspace through a symlink` };
      }
    } catch {
      // unresolvable (missing …) — the read below produces the real denial
    }
    try {
      const text = await readFile(target, 'utf8');
      return { ok: true, text };
    } catch (err_) {
      return { ok: false, text: messageOf(err_).includes('ENOENT') ? `file not found: '${path_}'` : `read failed: ${messageOf(err_)}` };
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
      return { ok: false, text: messageOf(err_).includes('ENOENT') ? `file not found: '${path_}'` : `read failed: ${messageOf(err_)}` };
    }
    const { oldText, newText } = input;
    if (typeof oldText !== 'string' || !content.includes(oldText)) {
      return { ok: false, text: `edit refused: target text not found in '${path_}'` };
    }
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
  return { ok: false, text: `permission denied: ${name} is not a tool this CLI offers` };
}

/** The --permission-prompts none simulation: only --allowedTools names run. */
function permissionDenied(name) {
  if (ALLOWED === undefined) return false; // standalone fixture run — permissive
  return !ALLOWED.split(/\s+/).filter((token) => token !== '').includes(name);
}

// ---------------------------------------------------------------------------
// The scripted run
// ---------------------------------------------------------------------------

function keepAlive() {
  return setInterval(() => {}, 60_000);
}

async function okFlow(replyText, usage = USAGE) {
  emitAssistantText(replyText, usage);
  const structured = structuredOutputFor(replyText);
  emitResult({ usage, ...(structured === undefined ? {} : { structured_output: structured }) });
}

async function toolThenReply() {
  const name = TOOL ?? 'read';
  let input;
  try {
    input = TOOL_INPUT === undefined ? { path: TOOL_PATH ?? 'note.txt' } : JSON.parse(TOOL_INPUT);
  } catch {
    input = { path: TOOL_PATH ?? 'note.txt' };
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
    err(`fake-agent-cli: model '${model}' is not served by this endpoint; serving the endpoint default instead`);
    // exitCode, not exit(): stdout/stderr flush before the process reaps.
    process.exitCode = 1;
    return;
  }
  if (MODE === 'fail') {
    err('fake-agent-cli: simulated hard failure before any result');
    process.exitCode = 1;
    return;
  }

  emitInit();

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
      return;
    }
    keepAlive();
    return;
  }

  if (MODE === 'ignore-sigterm') {
    keepAlive();
    return;
  }
  if (MODE === 'block-until-abort') {
    keepAlive(); // default SIGTERM disposition kills us — the graceful rung
    return;
  }
  if (MODE === 'slow-exit-ms') {
    setTimeout(() => {
      void okFlow(REPLY ?? 'slow exit');
    }, SLOW_EXIT_MS);
    return;
  }
  if (MODE === 'deny-tool') {
    emitToolUse('tu-deny', 'edit', { path: 'x' });
    emitToolResult('tu-deny', true, 'permission denied: edit is not allowed');
    emitResult({ is_error: true, subtype: 'error_during_execution' });
    return;
  }
  if (MODE === 'emit-junk') {
    emitJunk();
    await okFlow(REPLY ?? 'ok despite the junk');
    return;
  }
  if (MODE === 'budget-usage') {
    await okFlow(REPLY ?? 'expensive reply', BUDGET_USAGE);
    return;
  }
  if (MODE === 'resume-echo') {
    await okFlow(`resumed from cli session ${resumeId ?? 'none'}`);
    return;
  }
  if (MODE === 'structured-ok') {
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
      emitResult({ structured_output: parsed });
      return;
    }
    const structured = { answer: 'ok' };
    let schema;
    try {
      schema = jsonSchemaRaw === undefined ? undefined : JSON.parse(jsonSchemaRaw);
    } catch {
      schema = undefined;
    }
    const problem = schema === undefined ? undefined : schemaError(schema, structured);
    if (problem !== undefined) {
      err(`fake-agent-cli: structured_output rejected by --json-schema: ${problem}`);
      emitResult({ is_error: true, subtype: 'error_during_execution' });
      return;
    }
    emitResult({ structured_output: structured });
    return;
  }
  if (MODE === 'tool-then-reply' || MODE === 'echo-workspace') {
    await toolThenReply();
    return;
  }
  // Default: a clean ok completion.
  await okFlow(REPLY ?? 'ok');
}

main().catch((err_) => {
  err(`fake-agent-cli: ${messageOf(err_)}`);
  process.exitCode = 1; // no exit(): let stdio flush before the reaper
});
