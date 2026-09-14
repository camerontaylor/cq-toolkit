#!/usr/bin/env node
// DD-1 abort spike — T1.6 slice 3 (measured, not aspirational).
//
// Runs ONE long job per lane inside the governor's own channel (runLadder,
// rung-1 signal at WALL_CLOCK_MS) and measures what the client can actually
// observe about abort-vs-spend:
//
//   abortedAtMs      — ms from dispatch to the driver verdict settling
//                      (the COOPERATIVE settle latency the governor's
//                      rung-1 → rung-2 abortGraceMs must cover).
//   stopReason       — must be 'aborted' (the lane obeyed the signal).
//   usageAtAbort     — the usage the lane's verdict carries at the abort
//                      verdict (ai-sdk: zeros by design — ai@7 generateText
//                      THROWS on abort and surfaces no usage, which is
//                      exactly why the frozen unmeasured-abort rule exists;
//                      claude-agent: the tokens already folded from
//                      assistant frames before the abort — real numbers).
//   usageAfterPoll   — POLL_MS later: the usage-shaped fact after the poll.
//                      claude-agent: the CLI's LOCAL transcript message
//                      count at settle vs after the poll (growth = the
//                      worker kept producing after the abort) plus whether
//                      any agent worker PROCESS survived the poll.
//                      ai-sdk: in-process call, no accrual channel exists
//                      post-settle (the fetch is aborted in-process) — the
//                      count is re-reported unchanged and the doc says so.
//   spendStopped     — the verdict: stopReason 'aborted' AND settle within
//                      a small multiple of the signal AND no post-abort
//                      transcript growth AND no lingering worker process.
//
// CLIENT-SIDE HONESTY LIMIT (stated in docs/dd-1-abort-spike.md): no client
// can see provider-side tokens already in flight; "spendStopped" is the
// client-observable verdict, not an invoice.
//
// SECRETS: this script reads key material from the environment and prints
// NOTHING sensitive — verdict JSON carries env var NAMES only. The stale
// host ANTHROPIC_API_KEY is explicitly neutralized (empty string) at start;
// the Z.AI key is expected in Z_AI_API_KEY (mapped onto the routes'
// ZAI_API_KEY name in-process). Both live runs are capped: Budget.maxUsd 2,
// toolPolicy 'none', and the rung-1 wall clock bounds the exposure.
//
// Usage:
//   node scripts/dd1-abort-spike.mjs --lane ai-sdk
//   node scripts/dd1-abort-spike.mjs --lane claude-agent
//
// The claude-agent lane loads the SDK dynamically through the driver's
// production default loader; make the optional peer resolvable for LIVE
// runs only, without touching package.json/lockfile:
//   ln -s /tmp/sdk-probe/node_modules/@anthropic-ai node_modules/@anthropic-ai
import { AiSdkDriver, ClaudeAgentDriver, SessionStore, runLadder } from '../dist/index.js';
import { AGENT_SESSION_FILE } from '../dist/driver/claude-agent/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// --- Caps + timings (the spike's declared ceilings) -------------------------
const WALL_CLOCK_MS = 5_000; // rung-1 signal: WHEN is the governor's decision
const POLL_MS = 5_000; // the post-abort accrual watch
const MAX_USD = 2; // the declared spend ceiling for every live run
const MODEL = 'glm-4.6'; // priced in src/driver/pricing/data.ts (zai row)

// --- Environment hygiene (silent — never print values) ----------------------
// The stale host ANTHROPIC_API_KEY must never be used; empty it so any lane
// that reads it fails loudly instead of silently using an invalid key.
process.env.ANTHROPIC_API_KEY = '';
// The login shell exports the Z.AI key as Z_AI_API_KEY; the routes consume
// the name ZAI_API_KEY. Map in-process, silently.
if (process.env.ZAI_API_KEY === undefined || process.env.ZAI_API_KEY === '') {
  process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
}
if (process.env.ZAI_API_KEY === undefined || process.env.ZAI_API_KEY === '') {
  console.error('dd1-abort-spike: Z_AI_API_KEY is not set in the environment — refusing to run');
  process.exit(1);
}

// The fixture prompt: a deliberately LONG multi-part output so the run is
// still mid-flight when the governed signal fires at 5s.
const PROMPT =
  'Write a long, detailed essay in TEN numbered sections, each section at least 150 words, ' +
  'on the history of text editors from TECO to LSP. Do not stop early; keep writing until all ' +
  'ten sections are complete. Begin now with section 1.';

const lane = process.argv.includes('--lane') ? process.argv[process.argv.indexOf('--lane') + 1] : undefined;

/** pgrep helper: pids whose cmdline matches, as an array of strings. */
async function matchingPids(pattern) {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', pattern]);
    return stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');
  } catch {
    return []; // pgrep exits 1 on no match
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Lane runners — each returns { driver, invocation } for the shared measurement
// ---------------------------------------------------------------------------

function aiSdkLane() {
  const driver = new AiSdkDriver({
    sessionsDir: join(tmpdir(), 'dd1-spike', 'sessions'),
  });
  const invocation = {
    prompt: PROMPT,
    modelSpec: { provider: 'zai', model: MODEL },
    toolPolicy: { allow: [], mode: 'none' },
    sandboxPolicy: { level: 'none' },
    budget: { maxUsd: MAX_USD },
  };
  return { driver, invocation, lane: 'ai-sdk' };
}

function claudeAgentLane() {
  // The production default loader (dynamic import) resolves the OPTIONAL
  // peer through the node_modules symlink — no package.json/lockfile change.
  const driver = new ClaudeAgentDriver({
    sessionsDir: join(tmpdir(), 'dd1-spike', 'agent-sessions'),
  });
  const invocation = {
    prompt: PROMPT,
    modelSpec: { provider: 'zai', model: MODEL }, // endpoint default IS the Z.AI anthropic-compat URL
    toolPolicy: { allow: [], mode: 'none' },
    sandboxPolicy: { level: 'none' },
    budget: { maxUsd: MAX_USD },
  };
  return { driver, invocation, lane: 'claude-agent' };
}

/** The claude-agent leg's post-abort observables: CLI transcript growth + worker-process liveness. */
async function claudeAgentPollEvidence(verdict) {
  const evidence = { transcriptCountAtSettle: undefined, transcriptCountAfterPoll: undefined, lingeringWorkerPids: [] };
  try {
    const record = await new SessionStore(join(tmpdir(), 'dd1-spike', 'agent-sessions')).load(verdict.sessionId);
    const workspace = record.workspace;
    const agentSessionId = (await readFile(join(workspace, AGENT_SESSION_FILE), 'utf8')).trim();
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const count = async () => {
      try {
        const messages = await sdk.getSessionMessages(agentSessionId, { dir: workspace });
        return messages.length;
      } catch {
        return undefined; // transcript not found locally — unobservable, stated honestly
      }
    };
    evidence.transcriptCountAtSettle = await count();
    await sleep(POLL_MS);
    evidence.transcriptCountAfterPoll = await count();
    // A surviving worker process is a surviving spend channel.
    const pidsAfterPoll = await matchingPids('claude-agent-sdk');
    evidence.lingeringWorkerPids = pidsAfterPoll;
  } catch (err) {
    evidence.pollError = err instanceof Error ? err.message : String(err);
    await sleep(POLL_MS);
  }
  return evidence;
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

async function measure(laneName) {
  const { driver, invocation, lane } =
    laneName === 'claude-agent' ? claudeAgentLane() : aiSdkLane();

  const startedAt = Date.now();
  let verdict;
  const ladderOutcome = await runLadder(
    async () => {
      const result = await driver.run(invocation);
      verdict = result;
      return result;
    },
    { wallClockMs: WALL_CLOCK_MS },
    { op: 'dd1-abort-spike', jobKey: `dd1-${laneName}`, attempt: 1 },
  );
  const settledAtMs = Date.now() - startedAt;

  if (verdict === undefined) {
    return {
      lane,
      wallClockMs: WALL_CLOCK_MS,
      settledAtMs,
      ladderOutcome: ladderOutcome.outcome,
      stopReason: undefined,
      usageAtAbort: undefined,
      error: 'the run never produced a verdict — see ladderOutcome',
      spendStopped: false,
    };
  }

  let usageAfterPoll = verdict.usage;
  let pollEvidence = {};
  if (lane === 'claude-agent') {
    pollEvidence = await claudeAgentPollEvidence(verdict);
    usageAfterPoll = {
      ...verdict.usage,
      transcriptMessagesAfterPoll: pollEvidence.transcriptCountAfterPoll,
    };
  } else {
    // ai-sdk: nothing client-observable can accrue post-settle (the abort
    // destroys the in-process fetch); hold the poll anyway so the wall time
    // parity between lanes is honest.
    await sleep(POLL_MS);
    pollEvidence.note = 'in-process lane: no post-settle accrual channel exists to observe';
  }

  const grew = pollEvidence.transcriptCountAtSettle !== undefined &&
    pollEvidence.transcriptCountAfterPoll !== undefined &&
    pollEvidence.transcriptCountAfterPoll > pollEvidence.transcriptCountAtSettle;
  const lingered = Array.isArray(pollEvidence.lingeringWorkerPids) && pollEvidence.lingeringWorkerPids.length > 0;
  const settledPromptly = settledAtMs <= WALL_CLOCK_MS + 3_000; // signal → settle well inside rung-2 territory
  const spendStopped = verdict.stopReason === 'aborted' && settledPromptly && !grew && !lingered;

  return {
    lane,
    wallClockMs: WALL_CLOCK_MS,
    pollMs: POLL_MS,
    settledAtMs,
    settleLatencyMs: settledAtMs - WALL_CLOCK_MS,
    ladderOutcome: ladderOutcome.outcome,
    stopReason: verdict.stopReason,
    usageAtAbort: verdict.usage,
    costUSDAtAbort: verdict.costUSD ?? null,
    usageAfterPoll,
    spendStopped,
    grewAfterAbort: pollEvidence.transcriptCountAtSettle !== undefined ? grew === true : undefined,
    lingeringWorkerPids: pollEvidence.lingeringWorkerPids ?? [],
    pollError: pollEvidence.pollError,
    pollNote: pollEvidence.note,
  };
}

if (lane !== 'ai-sdk' && lane !== 'claude-agent') {
  console.error('dd1-abort-spike: pass --lane ai-sdk or --lane claude-agent');
  process.exit(1);
}
const verdictJson = await measure(lane);
console.log(JSON.stringify(verdictJson, null, 2));
