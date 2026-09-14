#!/usr/bin/env node
// ACP live probe — T1.8 step 2, SLICE 1 (evidence gathering, NOT driver code).
//
// Speaks the strategy §1.2 subset over stdio (newline-delimited JSON-RPC 2.0,
// confirmed against @agentclientprotocol/sdk's own LineBuffer) against the
// operator-installed `zcode-acp-server` binary, and records EVERY frame
// verbatim so the OQ register in docs/acp-driver-strategy.md can be answered
// from the wire, not from hope:
//
//   init     — OQ-5 (negotiated protocolVersion) + OQ-1 (does session/new gate
//              behind auth_required? what authMethods are advertised?)
//   version  — OQ-5's mismatch leg: initialize with an unsupported version,
//              observe the agent's answer-with-latest behavior (zero LLM spend)
//   prompt   — OQ-2 (where is the served model id reported?) + OQ-3 (does the
//              prompt response carry usage? verbatim field shape)
//   tool     — OQ-4: in mode `build`, a file-writing prompt; leg `allow`
//              answers allow_once/allow_always, leg `deny` answers
//              reject_once/reject_always; records the request_permission
//              payload (title/kind/rawInput/options), the tool_call frames,
//              and the never-asks check (a tool_call with NO preceding
//              request_permission for that toolCallId)
//   cancel   — OQ-6: mid-prompt session/cancel; post-cancel frames, settle
//              latency, and continued client-observable activity
//
// SPEND BOUNDS: every scenario uses one short prompt (the cancel prompt is the
// longest and is cancelled after CANCEL_AFTER_MS; the version scenario spends
// nothing). Each prompt request carries its own timeout so a hung harness
// cannot run the probe long.
//
// SECRETS: the script passes the parent environment through to the spawned
// server (Z_AI_API_KEY reaches the vendor's own binary the same way the
// desktop app's credentials do) but prints NAMES ONLY — a presence report,
// never a value. Frames captured from the wire are protocol frames, and the
// probe never writes secrets into them.
//
// Usage:
//   node scripts/probe-acp.mjs <init|version|prompt|tool|cancel> [--leg allow|deny]
//
// Frames go to <os-tmpdir>/acp-probe-<stamp>/<scenario>-<leg>.ndjson (and the
// verdict summary to verdict-<scenario>-<leg>.json); paths are printed at the
// end. The log directory lives OUTSIDE the repo so evidence gathering never
// dirties the tree.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The strategy's negotiation analysis (§3, OQ-5): the wire integer is the only
// version that binds. The installed server's SDK exports PROTOCOL_VERSION = 1;
// the probe sends exactly this and records whatever comes back.
const PROTOCOL_VERSION = 1;
const CLIENT_INFO = { name: 'cq-acp-probe', version: '0.0.0' };
// The v1 client posture (strategy §1.3): no fs serving, no terminal hosting,
// and deliberately NO elicitation capability — the server falls back from
// elicitation/create to session/request_permission precisely when the client
// does not advertise elicitation, which is the channel the driver maps.
const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

const ACP_BIN = process.env.PROBE_ACP_BIN ?? 'zcode-acp-server';
// Mirror of src/driver/acp/protocol.ts's AUTH_REQUIRED_ERROR_CODE — the ACP
// "authenticate first" error code (NOT http-style 401). The probe stays
// dependency-free (node builtins only, the script's import posture), so the
// constant is duplicated WITH this pointer; keep the two in sync.
const AUTH_REQUIRED_ERROR_CODE = -32000;
// `zcode` may not be on this host's PATH; the ZCODE_BIN env var names the
// app-bundle CLI the README documents. Caller's env wins; the app-bundle
// fallback is DARWIN-ONLY (issue #50, the demo script's darwin-scoped
// posture — scripts/demo-eval-axes.mjs): the path is a macOS app container,
// and injecting it on Linux/Windows would shadow the harness's own PATH
// discovery of `zcode`, failing every documented probe scenario to launch.
if ((process.env.ZCODE_BIN ?? '') === '' && process.platform === 'darwin') {
  process.env.ZCODE_BIN = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
}
const ZCODE_BIN = process.env.ZCODE_BIN;

const INIT_TIMEOUT_MS = 20_000;
const SESSION_NEW_TIMEOUT_MS = 30_000;
const SET_CONFIG_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 120_000;
const CANCEL_AFTER_MS = 5_000;
const POST_CANCEL_OBSERVE_MS = 20_000;

const scenario = process.argv[2];
const legIdx = process.argv.indexOf('--leg');
const leg = legIdx === -1 ? null : process.argv[legIdx + 1];

if (!['init', 'version', 'prompt', 'tool', 'cancel'].includes(scenario)) {
  console.error('usage: probe-acp.mjs <init|version|prompt|tool|cancel> [--leg allow|deny]');
  process.exit(2);
}
if (scenario === 'tool' && !['allow', 'deny'].includes(leg)) {
  console.error('scenario `tool` requires --leg allow|deny');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logDir = join(tmpdir(), `acp-probe-${stamp}`);
await mkdir(logDir, { recursive: true });
const logName = leg ? `${scenario}-${leg}` : scenario;
const logPath = join(logDir, `${logName}.ndjson`);
const verdictPath = join(logDir, `verdict-${logName}.json`);

let t0 = Date.now();
const elapsedMs = () => Date.now() - t0;

function appendLog(record) {
  return writeFile(logPath, `${JSON.stringify(record)}\n`, { flag: 'a' });
}

// ---------- the client (subset §1.2, dependency-free) ----------

class AcpProbe {
  constructor(name) {
    this.name = name;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.serverRequestHandler = null; // async (method, params) => result
    this.serverRequests = []; // server→client REQUESTS (method+id), in order
    this.notifications = []; // every session/update and friends, in order
    this.allInbound = []; // EVERY inbound frame (responses included) — for sweeps
    this.frames = 0;
    this.exitPromise = null;
  }

  start(cwd) {
    // ZCODE_BIN rides only when it is actually set (issue #50): an
    // undefined value must never reach the child env as the string
    // "undefined" — on a non-darwin host with no explicit setting the
    // harness resolves `zcode` from PATH untouched.
    const env = { ...process.env, ...(ZCODE_BIN !== undefined ? { ZCODE_BIN } : {}) };
    this.child = spawn(ACP_BIN, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    // A spawn FAILURE emits 'error' (then 'close') and may never emit
    // 'exit' — settle on whichever arrives FIRST, once, carrying the
    // spawn error as evidence (an ENOENT must not hang the probe).
    this.exitPromise = new Promise((res) => {
      let settled = false;
      let spawnError = null;
      const done = (info) => {
        if (settled) return;
        settled = true;
        this.exitInfo = info;
        // THE CHILD IS GONE — no in-flight RPC can ever be answered
        // (issue #38): reject every pending request NOW with the exit
        // evidence instead of letting each ride to its 20–120s timeout and
        // report a bogus timeout for what was really a process exit. Each
        // rejection lands in the scenario's own catch (failure EVIDENCE,
        // never an unhandled rejection).
        const evidence = [
          info.spawnError !== undefined ? `spawnError=${info.spawnError}` : null,
          info.code !== undefined && info.code !== null ? `code=${info.code}` : null,
          info.signal !== undefined && info.signal !== null ? `signal=${info.signal}` : null,
        ].filter((part) => part !== null).join(' ');
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(
            new Error(`${pending.method ?? 'rpc'} aborted: the ACP process closed (${evidence || 'no exit details'})`),
          );
        }
        res(info);
      };
      this.child.on('error', (e) => {
        spawnError = e;
        done({ code: null, signal: null, spawnError: String(e), atMs: elapsedMs() });
      });
      this.child.on('close', (code, signal) => {
        done({
          code,
          signal,
          ...(spawnError !== null ? { spawnError: String(spawnError) } : {}),
          atMs: elapsedMs(),
        });
      });
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) void this.onLine(line);
        nl = buffer.indexOf('\n');
      }
    });
    let stderrTail = '';
    this.child.stderr.on('data', (chunk) => {
      stderrTail += chunk;
      let nl = stderrTail.indexOf('\n');
      while (nl !== -1) {
        const line = stderrTail.slice(0, nl);
        stderrTail = stderrTail.slice(nl + 1);
        void appendLog({ dir: 'err', t: elapsedMs(), line });
        nl = stderrTail.indexOf('\n');
      }
      if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-4000);
    });
    this.child.on('error', (e) => {
      void appendLog({ dir: 'spawn-error', t: elapsedMs(), message: String(e) });
    });
    this.stderrTail = () => stderrTail;
  }

  async onLine(line) {
    this.frames += 1;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      void appendLog({ dir: 'in-garbage', t: elapsedMs(), line: line.slice(0, 2000) });
      return;
    }
    // WIRE ORDER: every consumer push (allInbound / pending settlement /
    // serverRequests / notifications) happens BEFORE any await — a pending
    // log write must never reorder the record the verdicts sweep over.
    this.allInbound.push(frame);
    if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      void appendLog({ dir: 'in', t: elapsedMs(), frame });
      const p = this.pending.get(frame.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(frame.id);
        if (frame.error !== undefined) p.reject(new RpcError(frame.error));
        else p.resolve(frame.result);
      }
      return;
    }
    if (frame.method !== undefined && frame.id !== undefined) {
      // Server → client REQUEST. Only session/request_permission is answered;
      // anything else is answered with a JSON-RPC method-not-found error so
      // the record shows exactly what the vendor tried.
      this.serverRequests.push({ t: elapsedMs(), frame });
      void appendLog({ dir: 'in', t: elapsedMs(), frame });
      if (this.serverRequestHandler && frame.method === this.serverRequestHandler.method) {
        try {
          const result = await this.serverRequestHandler.handler(frame.params);
          await this.send({ jsonrpc: '2.0', id: frame.id, result });
        } catch (e) {
          await this.send({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: String(e.message ?? e) } });
        }
      } else {
        await this.send({
          jsonrpc: '2.0',
          id: frame.id,
          error: { code: -32601, message: `probe does not implement ${frame.method}` },
        });
      }
      return;
    }
    if (frame.method !== undefined) {
      this.notifications.push({ t: elapsedMs(), frame });
    }
    void appendLog({ dir: 'in', t: elapsedMs(), frame });
  }

  async send(obj) {
    const line = JSON.stringify(obj);
    await appendLog({ dir: 'out', t: elapsedMs(), frame: obj });
    await new Promise((res, rej) => {
      this.child.stdin.write(`${line}\n`, (e) => (e ? rej(e) : res()));
    });
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectP(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveP, reject: rejectP, timer, method });
      void this.send({ jsonrpc: '2.0', id, method, params }).catch((e) => {
        // A failed request write must not leave the pending entry and its
        // timeout alive (issue #51): clear BOTH before rejecting, so the
        // probe process cannot outlive the scenario cleanup hanging on a
        // timeout for a request that was never even written.
        clearTimeout(timer);
        this.pending.delete(id);
        rejectP(e);
      });
    });
  }

  notify(method, params) {
    return this.send({ jsonrpc: '2.0', method, params });
  }

  updates(method) {
    return this.notifications.filter((n) => n.frame.method === method);
  }

  sessionUpdates() {
    return this.notifications.filter((n) => n.frame.method === 'session/update');
  }

  updateKinds() {
    // The wire nests the payload: session/update params = { sessionId, update: { sessionUpdate, ... } }.
    return this.sessionUpdates().map((n) => n.frame.params?.update?.sessionUpdate ?? '<none>');
  }

  async kill() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return this.exitInfo ?? null;
    this.child.kill('SIGTERM');
    const exited = await Promise.race([
      this.exitPromise,
      new Promise((res) => setTimeout(() => res('still-alive'), 3000)),
    ]);
    if (exited === 'still-alive') this.child.kill('SIGKILL');
    await this.exitPromise;
    return this.exitInfo;
  }
}

class RpcError extends Error {
  constructor(errorObj) {
    super(`rpc error ${errorObj.code}: ${errorObj.message}`);
    this.code = errorObj.code;
    this.data = errorObj.data;
    this.errorObject = errorObj;
  }
}

// ---------- shared scenario scaffolding ----------

async function freshWorkspace() {
  return mkdtemp(join(tmpdir(), 'acp-probe-ws-'));
}

function secretReport() {
  const names = ['Z_AI_API_KEY', 'ZAI_API_KEY'];
  return names.map((n) => ({ name: n, present: process.env[n] !== undefined }));
}

async function bootProbe(name) {
  const cwd = await freshWorkspace();
  const probe = new AcpProbe(name);
  probe.start(cwd);
  return { probe, cwd };
}

async function initialize(probe, { protocolVersion = PROTOCOL_VERSION } = {}) {
  return probe.request(
    'initialize',
    { protocolVersion, clientCapabilities: CLIENT_CAPABILITIES, clientInfo: CLIENT_INFO },
    INIT_TIMEOUT_MS,
  );
}

async function newSession(probe, cwd) {
  // mcpServers present-but-empty (strategy §1.3: keep the param present).
  return probe.request('session/new', { cwd, mcpServers: [] }, SESSION_NEW_TIMEOUT_MS);
}

function modelOptionFrom(configOptions) {
  if (!Array.isArray(configOptions)) return null;
  return configOptions.find((o) => o?.id === 'model' || o?.category === 'model') ?? null;
}

// Mechanical sweep: every key path anywhere in a frame whose key mentions
// model — so "the harness reports no model" is never a human skim's word.
function modelKeyPaths(value, prefix = '') {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...modelKeyPaths(v, `${prefix}[${i}]`)));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const path = `${prefix}.${k}`;
      if (/model/i.test(k)) hits.push(path);
      hits.push(...modelKeyPaths(v, path));
    }
  }
  return hits;
}

async function settle(probe) {
  const exit = await probe.kill();
  await appendLog({ dir: 'probe', t: elapsedMs(), exit, stderrTail: probe.stderrTail?.() ?? '' });
  return exit;
}

async function settleAndPrint(verdict, verdictPathOverride) {
  await writeFile(verdictPathOverride ?? verdictPath, `${JSON.stringify(verdict, null, 2)}\n`);
  console.log(JSON.stringify(verdict, null, 2));
  console.error(`probe: log=${logPath}`);
  console.error(`probe: verdict=${verdictPathOverride ?? verdictPath}`);
}

// ---------- scenarios ----------

// OQ-5 + OQ-1: initialize, then session/new with NO authenticate call.
async function scenarioInit() {
  const { probe, cwd } = await bootProbe('init');
  const verdict = { scenario: 'init', acpBin: ACP_BIN, zcodeBinSet: Boolean(ZCODE_BIN), secrets: secretReport() };
  try {
    const tInit0 = elapsedMs();
    const initResult = await initialize(probe);
    verdict.initialize = {
      requestedProtocolVersion: PROTOCOL_VERSION,
      negotiatedProtocolVersion: initResult.protocolVersion,
      agentInfo: initResult.agentInfo ?? null,
      agentCapabilities: initResult.agentCapabilities ?? null,
      authMethods: initResult.authMethods ?? null,
      elapsedMs: elapsedMs() - tInit0,
    };
    const tNew0 = elapsedMs();
    try {
      const session = await newSession(probe, cwd);
      verdict.sessionNew = {
        gated: false,
        sessionIdPrefix: String(session.sessionId ?? '').slice(0, 8),
        modes: session.modes ?? null,
        modelOption: modelOptionFrom(session.configOptions),
        configOptionIds: Array.isArray(session.configOptions) ? session.configOptions.map((o) => o?.id) : null,
        elapsedMs: elapsedMs() - tNew0,
      };
    } catch (e) {
      verdict.sessionNew = {
        gated: e instanceof RpcError && e.code === AUTH_REQUIRED_ERROR_CODE ? true : 'error',
        error: e instanceof RpcError ? e.errorObject : String(e.message ?? e),
        elapsedMs: elapsedMs() - tNew0,
      };
    }
    verdict.fullFrameSweep = {
      note: 'key paths matching /model/i anywhere on the wire this run',
      paths: [...modelKeyPaths(probe.allInbound)],
    };
    verdict.framesSeen = probe.frames;
  } catch (e) {
    // A rejection (rpc error, or issue #38's child-exit rejection) is the
    // scenario's failure EVIDENCE — recorded like the other scenarios do,
    // never an unhandled rejection that would kill the process before the
    // verdict + log paths are printed.
    verdict.error = e instanceof RpcError ? e.errorObject : String(e.message ?? e);
  } finally {
    verdict.exit = await settle(probe);
  }
  await settleAndPrint(verdict, verdictPath);
}

// OQ-5's mismatch leg: request an unsupported version; the spec says the agent
// answers with its own latest and never declines. Zero LLM spend.
async function scenarioVersion() {
  const { probe } = await bootProbe('version');
  const verdict = { scenario: 'version', requestedProtocolVersion: 99 };
  try {
    try {
      const initResult = await initialize(probe, { protocolVersion: 99 });
      verdict.agentAnswered = { protocolVersion: initResult.protocolVersion, note: 'agent answered (spec: with its latest)' };
    } catch (e) {
      verdict.agentAnswered = {
        error: e instanceof RpcError ? e.errorObject : String(e.message ?? e),
        note: 'agent declined the initialize request',
      };
    }
    verdict.framesSeen = probe.frames;
  } finally {
    verdict.exit = await settle(probe);
  }
  await settleAndPrint(verdict, verdictPath);
}

// OQ-2 + OQ-3: tiny no-tool prompt; capture every frame.
async function scenarioPrompt() {
  const { probe, cwd } = await bootProbe('prompt');
  const verdict = { scenario: 'prompt' };
  try {
    const initResult = await initialize(probe);
    verdict.negotiatedProtocolVersion = initResult.protocolVersion;
    const session = await newSession(probe, cwd);
    verdict.sessionNew = {
      modes: session.modes ?? null,
      modelOption: modelOptionFrom(session.configOptions),
      configOptionIds: Array.isArray(session.configOptions) ? session.configOptions.map((o) => o?.id) : null,
    };
    const tPrompt0 = elapsedMs();
    const response = await probe.request(
      'session/prompt',
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Reply with exactly these two characters: OK' }] },
      PROMPT_TIMEOUT_MS,
    );
    verdict.prompt = {
      response,
      usage: response.usage ?? null,
      usagePresent: response.usage !== undefined && response.usage !== null,
      elapsedMs: elapsedMs() - tPrompt0,
    };
    verdict.updatesInOrder = probe.updateKinds();
    // config_option_update frames: the materialization path reports real values
    // once the lazy session materializes on first prompt.
    verdict.configOptionUpdates = probe
      .sessionUpdates()
      .filter((n) => n.frame.params?.update?.sessionUpdate === 'config_option_update')
      .map((n) => ({ t: n.t, modelOption: modelOptionFrom(n.frame.params?.update?.configOptions) }));
    verdict.modelKeyPathsSweep = {
      note: 'key paths matching /model/i anywhere on the wire this run',
      paths: [...modelKeyPaths(probe.allInbound)],
    };
    verdict.finalText = probe
      .sessionUpdates()
      .filter((n) => n.frame.params?.update?.sessionUpdate === 'agent_message_chunk')
      .map((n) => n.frame.params?.update?.content?.text ?? '')
      .join('');
  } catch (e) {
    // A rejection (timeout, rpc error, spawn failure) is the scenario's
    // failure EVIDENCE — recorded, never an unhandled rejection (which
    // would kill the process before the verdict + log paths are printed).
    verdict.error = e instanceof RpcError ? e.errorObject : String(e.message ?? e);
  } finally {
    verdict.exit = await settle(probe);
  }
  await settleAndPrint(verdict, verdictPath);
}

// OQ-4: mode=build, a file-writing prompt, answer request_permission per leg.
async function scenarioTool() {
  const { probe, cwd } = await bootProbe(`tool-${leg}`);
  const verdict = { scenario: 'tool', leg };
  const permissionRequests = [];
  const toolCallsByOrder = []; // { t, toolCallId, via, frame } in first-appearance order
  const toolCallFrames = [];
  const seenToolCallIds = new Map(); // toolCallId -> 'permission'|'tool_call' (first channel)

  try {
    const initResult = await initialize(probe);
    verdict.negotiatedProtocolVersion = initResult.protocolVersion;
    const session = await newSession(probe, cwd);
    // Materialize + leave yolo: ask the wire to switch into `build`, the
    // mode whose gate should fire for file writes.
    const setResp = await probe.request(
      'session/set_config_option',
      { sessionId: session.sessionId, configId: 'mode', value: 'build' },
      SET_CONFIG_TIMEOUT_MS,
    );
    verdict.modeSwitch = { modes: setResp.modes ?? null, modelOption: modelOptionFrom(setResp.configOptions) };
    const modeUpdates = probe.sessionUpdates().filter((n) => n.frame.params?.update?.sessionUpdate === 'current_mode_update');
    verdict.modeAfterSwitch = modeUpdates.at(-1)?.frame.params?.update?.currentModeId ?? 'unknown';

    probe.serverRequestHandler = {
      method: 'session/request_permission',
      handler: async (params) => {
        permissionRequests.push({ t: elapsedMs(), params });
        const options = Array.isArray(params?.options) ? params.options : [];
        const pick = (kinds) => options.find((o) => kinds.includes(o?.kind));
        const chosen =
          leg === 'allow'
            ? (pick(['allow_once']) ?? pick(['allow_always']))
            : (pick(['reject_once']) ?? pick(['reject_always']));
        verdict[`answeredWith_${permissionRequests.length}`] = {
          chosenOption: chosen ?? null,
          offeredOptions: options,
          note: chosen ? null : 'NO option of the required side was offered',
        };
        if (!chosen) throw new Error(`no ${leg} option offered: ${JSON.stringify(options)}`);
        return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
      },
    };

    const tPrompt0 = elapsedMs();
    const response = await probe.request(
      'session/prompt',
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Create a file named probe-hello.txt in the current directory containing exactly: hello' }],
      },
      PROMPT_TIMEOUT_MS,
    );
    verdict.prompt = { response, elapsedMs: elapsedMs() - tPrompt0 };

    for (const n of probe.serverRequests) {
      if (n.frame.method !== 'session/request_permission') continue;
      const id = n.frame.params?.toolCall?.toolCallId;
      if (id !== undefined && !seenToolCallIds.has(id)) {
        seenToolCallIds.set(id, 'permission');
        toolCallsByOrder.push({ t: n.t, toolCallId: id, via: 'request_permission' });
      }
    }
    for (const n of probe.notifications) {
      const p = n.frame.params ?? {};
      if (n.frame.method === 'session/update') {
        const kindU = p.update?.sessionUpdate;
        if (kindU === 'tool_call' || kindU === 'tool_call_update') {
          const id = p.update?.toolCallId;
          toolCallFrames.push({ t: n.t, kindU, frame: p.update });
          if (id !== undefined && !seenToolCallIds.has(id)) {
            seenToolCallIds.set(id, 'tool_call');
            toolCallsByOrder.push({ t: n.t, toolCallId: id, via: 'tool_call' });
          }
        }
      }
    }
    verdict.permissionRequestCount = permissionRequests.length;
    verdict.permissionRequests = permissionRequests.map((r) => ({
      t: r.t,
      toolCall: r.params?.toolCall ?? null,
      options: r.params?.options ?? null,
      kindFieldPresent: Object.prototype.hasOwnProperty.call(r.params?.toolCall ?? {}, 'kind'),
    }));
    verdict.toolCallFirstAppearance = toolCallsByOrder;
    verdict.toolCallFrames = toolCallFrames;
    verdict.neverAsksCheck = {
      note: 'a tool_call whose id NEVER appears in a request_permission (this mode should gate file writes)',
      ungatedToolCallIds: [...seenToolCallIds.entries()].filter(([, via]) => via === 'tool_call').map(([id]) => id),
      verdict: toolCallFrames.length === 0
        ? 'no tool_call frames at all'
        : [...seenToolCallIds.values()].every((via) => via === 'permission')
          ? 'asked: every tool_call id was preceded by a permission request'
          : 'NEVER-ASKS EVIDENCE: at least one tool_call id with no permission request',
    };
    verdict.updatesInOrder = probe.updateKinds();
    verdict.finalText = probe
      .sessionUpdates()
      .filter((n) => n.frame.params?.update?.sessionUpdate === 'agent_message_chunk')
      .map((n) => n.frame.params?.update?.content?.text ?? '')
      .join('');
  } catch (e) {
    verdict.error = e instanceof RpcError ? e.errorObject : String(e.message ?? e);
  } finally {
    verdict.exit = await settle(probe);
  }
  await settleAndPrint(verdict, verdictPath);
}

// OQ-6: mid-prompt cancel; client-observable verdict only.
async function scenarioCancel() {
  const { probe, cwd } = await bootProbe('cancel');
  const verdict = { scenario: 'cancel', cancelAfterMs: CANCEL_AFTER_MS, postCancelObserveMs: POST_CANCEL_OBSERVE_MS };
  try {
    const initResult = await initialize(probe);
    verdict.negotiatedProtocolVersion = initResult.protocolVersion;
    const session = await newSession(probe, cwd);
    const updatesAtCancelStart = probe.notifications.length;
    const tPrompt0 = elapsedMs();
    const promptPromise = probe.request(
      'session/prompt',
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Without using any tools, write a 300-word essay about tide pools.' }],
      },
      PROMPT_TIMEOUT_MS,
    );
    await new Promise((res) => setTimeout(res, CANCEL_AFTER_MS));
    const tCancelSent0 = elapsedMs();
    await probe.notify('session/cancel', { sessionId: session.sessionId });
    verdict.cancelNotificationSentAtMs = tCancelSent0;

    let response = null;
    let promptError = null;
    try {
      response = await promptPromise;
    } catch (e) {
      promptError = e instanceof RpcError ? e.errorObject : String(e.message ?? e);
    }
    verdict.settle = {
      stopReason: response?.stopReason ?? null,
      usage: response?.usage ?? null,
      settleLatencyMs: elapsedMs() - tCancelSent0,
      promptError,
      updatesBetweenCancelAndSettle: probe.notifications
        .slice(updatesAtCancelStart)
        .map((n) => n.frame.params?.update?.sessionUpdate ?? n.frame.method),
    };

    // The settle is not the question — the question is whether the vendor
    // keeps generating afterwards (client-observable only, per §2.3).
    const updatesAtSettle = probe.notifications.length;
    await new Promise((res) => setTimeout(res, POST_CANCEL_OBSERVE_MS));
    const post = probe.notifications.slice(updatesAtSettle);
    // Count FROM THE RECORDED FRAMES: the chunk count reflects what was
    // actually observed post-cancel (chunks with empty/absent text still
    // count — a text-derived count could silently read 0 when chunks exist).
    const postTextChunks = post.filter((n) => n.frame.params?.update?.sessionUpdate === 'agent_message_chunk');
    const textAfter = postTextChunks
      .map((n) => n.frame.params?.update?.content?.text ?? '')
      .join('');
    verdict.postCancel = {
      updateCount: post.length,
      updateKinds: post.map((n) => n.frame.params?.update?.sessionUpdate ?? n.frame.method),
      textChunkCount: postTextChunks.length,
      textChars: textAfter.length,
      continuedTraffic: post.length > 0,
    };
    // The cancel scenario logs its exit through the SAME settle() path as
    // every other scenario — the NDJSON record carries the exit evidence.
    verdict.exit = await settle(probe);
  } catch (e) {
    verdict.error = e instanceof RpcError ? e.errorObject : String(e.message ?? e);
    verdict.exit = await settle(probe);
  }
  await settleAndPrint(verdict, verdictPath);
}

const runners = {
  init: scenarioInit,
  version: scenarioVersion,
  prompt: scenarioPrompt,
  tool: scenarioTool,
  cancel: scenarioCancel,
};
t0 = Date.now();
await appendLog({ dir: 'probe', t: 0, note: `start scenario=${scenario} leg=${leg ?? '-'} acpBin=${ACP_BIN}` });
await runners[scenario]();
