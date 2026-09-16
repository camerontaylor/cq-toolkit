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
//                      An evidence channel that FAILS (transcript unreadable,
//                      pgrep execution error) yields 'inconclusive' with a
//                      reason — absence of observation is never "all clear".
//
// CLIENT-SIDE HONESTY LIMIT (stated in docs/dd-1-abort-spike.md): no client
// can see provider-side tokens already in flight; "spendStopped" is the
// client-observable verdict, not an invoice.
//
// SECRETS: this script reads key material from the environment and prints
// NOTHING sensitive — verdict JSON carries env var NAMES only. The stale
// host ANTHROPIC_API_KEY is explicitly neutralized (empty string) at start;
// the Z.AI key is expected in Z_AI_API_KEY (mapped onto the routes'
// ZAI_API_KEY name in-process). Spend bounds, stated precisely: the
// rung-1 wall clock (WALL_CLOCK_MS) is the RUNTIME bound; `Budget.maxUsd 2`
// rides the invocation as caller-side derived accounting (the drivers
// derive cost after usage — it is the declared ceiling a caller compares
// against, not a kill switch).
//
// Usage:
//   node scripts/dd1-abort-spike.mjs --lane ai-sdk
//   node scripts/dd1-abort-spike.mjs --lane claude-agent
//
// The claude-agent lane loads the SDK dynamically through the driver's
// production default loader; make the optional peer resolvable for LIVE
// runs only, without touching package.json/lockfile:
//   ln -s /tmp/sdk-probe/node_modules/@anthropic-ai node_modules/@anthropic-ai
import {
  AiSdkDriver,
  ClaudeAgentDriver,
  SessionStore,
  defaultHarnessConfig,
  runLadder,
} from '../dist/index.js';
import { AGENT_SESSION_FILE } from '../dist/driver/claude-agent/index.js';
import dns from 'node:dns';
import net from 'node:net';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// HOST NETWORK QUIRK (found live, 2026-09-14 — see docs/dd-1-abort-spike.md
// and scripts/demo-eval-axes.mjs): this host's IPv6 route to api.z.ai hangs
// (node fetch → ETIMEDOUT); the IPv4 path works. This script owns its
// process, so pin node's connect defaults to IPv4-first with family
// autoselection off. (A library must never set process-global network
// policy; the driver and kernel stay untouched.)
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);

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

const lane = process.argv.includes('--lane')
  ? process.argv[process.argv.indexOf('--lane') + 1]
  : undefined;

/**
 * pgrep helper: pids whose cmdline matches, as an array of strings.
 * Exit code 1 is a legitimate "no matches" → []. ANY other failure
 * (pgrep unavailable, not executable, killed) THROWS: an empty list must
 * never be indistinguishable from "we never checked" — the caller turns a
 * thrown check into spendStopped 'inconclusive'.
 */
async function matchingPids(pattern) {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', pattern]);
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  } catch (err) {
    if (err?.code === 1) return []; // pgrep's documented "no processes matched"
    throw new Error(`pgrep failed for '${pattern}' (exit ${String(err?.code ?? 'unknown')})`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The cwd of one pid, via lsof (macOS has no /proc). Throws when the cwd
 * cannot be determined — the caller must treat an unverifiable worker as
 * inconclusive, never as a kill target.
 */
async function cwdOfPid(pid) {
  const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const line = stdout.split('\n').find((l) => l.startsWith('n'));
  if (line === undefined || line.slice(1) === '') {
    throw new Error('lsof reported no cwd');
  }
  return line.slice(1);
}

// ---------------------------------------------------------------------------
// Lane runners — each returns { driver, invocation } for the shared measurement
// ---------------------------------------------------------------------------

function aiSdkLane(scratchDir) {
  const driver = new AiSdkDriver({
    sessionsDir: join(scratchDir, 'sessions'),
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

function claudeAgentLane(scratchDir) {
  // The production default loader (dynamic import) resolves the OPTIONAL
  // peer through the node_modules symlink — no package.json/lockfile change.
  // harnessConfig.workspaceRoot is pinned UNDER the run's own scratch dir:
  // the agent worker's cwd is therefore unique to THIS run, which is what
  // the cleanup sweep scopes its kills to (only this run's workers can ever
  // be killed).
  const driver = new ClaudeAgentDriver({
    sessionsDir: join(scratchDir, 'agent-sessions'),
    harnessConfig: { ...defaultHarnessConfig, workspaceRoot: join(scratchDir, 'workspaces') },
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

/** The claude-agent leg's post-abort observables: CLI transcript growth. */
async function claudeAgentPollEvidence(verdict, scratchDir) {
  // Transcript-channel evidence only: the lingering-worker poll lives in
  // sweepLingeringWorkers (the authoritative, every-exit-path sweep).
  const evidence = { transcriptCountAtSettle: undefined, transcriptCountAfterPoll: undefined };
  try {
    const record = await new SessionStore(join(scratchDir, 'agent-sessions')).load(
      verdict.sessionId,
    );
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
  } catch (err) {
    evidence.pollError = err instanceof Error ? err.message : String(err);
    await sleep(POLL_MS);
  }
  return evidence;
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

/**
 * The ALWAYS-ON cleanup sweep (run on EVERY exit path): find lingering
 * agent worker processes and SIGKILL each — a bounded experiment must
 * never leave a spending process behind.
 *
 * SCOPED TO THIS RUN: `pgrep -f` matches ANY agent-SDK worker on the host,
 * so the candidate list alone must never be a kill list. A candidate is
 * killed only when its CWD (via lsof) sits under THIS run's scratch dir —
 * the lanes pin harnessConfig.workspaceRoot (the worker's cwd) under it,
 * so only this run's workers can ever qualify. A candidate whose cwd
 * cannot be verified is left alone and reported, turning the verdict
 * inconclusive; a pgrep/lsof EXECUTION failure is likewise reported, never
 * an empty all-clear. Per-pid kill errors are swallowed (the process died
 * between the check and the kill — best-effort cleanup, not evidence).
 */
async function sweepLingeringWorkers(scratchDir) {
  const result = { lingeringWorkerPids: [], lingeringPidsKilled: [], processCheckError: undefined };
  let candidates;
  try {
    candidates = await matchingPids('claude-agent-sdk');
  } catch (err) {
    result.processCheckError = err instanceof Error ? err.message : String(err);
    return result;
  }
  // macOS /var ↔ /private/var: tmp paths are symlinks, and lsof reports the
  // RESOLVED cwd — compare against the resolved scratch root.
  const realScratch = await realpath(scratchDir);
  for (const pid of candidates) {
    let cwd;
    try {
      cwd = await cwdOfPid(pid);
    } catch (err) {
      result.processCheckError = `could not verify worker pid ${pid} (unverified workers are never killed): ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    const ours =
      cwd === scratchDir ||
      cwd === realScratch ||
      cwd.startsWith(scratchDir + '/') ||
      cwd.startsWith(realScratch + '/');
    if (!ours) continue; // someone else's worker — never touched
    result.lingeringWorkerPids.push(pid);
    try {
      process.kill(Number(pid), 'SIGKILL');
      result.lingeringPidsKilled.push(pid);
    } catch {
      // deliberately swallowed per-pid (see header comment)
    }
  }
  return result;
}

async function measure(laneName) {
  // The run's own scratch dir — sessions AND workspaces live under it, so
  // any worker this run spawned has its cwd here and the cleanup sweep can
  // identify (and only kill) THIS run's workers.
  const scratchDir = await mkdtemp(join(tmpdir(), 'dd1-abort-spike-'));
  const { driver, invocation, lane } =
    laneName === 'claude-agent' ? claudeAgentLane(scratchDir) : aiSdkLane(scratchDir);

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
  // Detached at rung 3: the worker never settled cooperatively after the
  // governed signal and the ladder escalated to the kill rung — evidence
  // of the very failure the spike hunts, whatever else the verdict says.
  const detachedAtRung3 = ladderOutcome.outcome === 'killed';

  if (verdict === undefined) {
    // No-verdict exit path — the sweep STILL runs: a detached SDK query /
    // CLI worker may still be spending, so find and kill it, then report
    // honestly (an absent verdict is no evidence that spend stopped).
    await sleep(POLL_MS);
    const sweep = await sweepLingeringWorkers(scratchDir);
    return {
      lane,
      wallClockMs: WALL_CLOCK_MS,
      pollMs: POLL_MS,
      settledAtMs,
      ladderOutcome: ladderOutcome.outcome,
      detachedAtRung3,
      ...sweep,
      stopReason: undefined,
      usageAtAbort: undefined,
      error: 'the run never produced a verdict — see ladderOutcome',
      spendStopped: 'inconclusive',
      inconclusiveReason: detachedAtRung3
        ? 'the run never produced a verdict and the ladder reached rung 3 (kill) — the worker never settled cooperatively'
        : 'the run never produced a verdict — see ladderOutcome',
    };
  }

  let usageAfterPoll = verdict.usage;
  let pollEvidence = {};
  if (lane === 'claude-agent') {
    pollEvidence = await claudeAgentPollEvidence(verdict, scratchDir);
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

  // The cleanup sweep runs on THIS path too (it is the same post-abort
  // process poll the early path runs): whatever it finds is merged into the
  // evidence and killed, so the recorded lingering-worker fact and the
  // cleanup always describe the final state of the machine.
  const sweep = await sweepLingeringWorkers(scratchDir);
  if (pollEvidence.processCheckError === undefined && sweep.processCheckError !== undefined) {
    pollEvidence.processCheckError = sweep.processCheckError;
  }
  if (sweep.lingeringWorkerPids.length > 0) {
    pollEvidence.lingeringWorkerPids = sweep.lingeringWorkerPids;
  }

  const grew =
    pollEvidence.transcriptCountAtSettle !== undefined &&
    pollEvidence.transcriptCountAfterPoll !== undefined &&
    pollEvidence.transcriptCountAfterPoll > pollEvidence.transcriptCountAtSettle;
  const lingered =
    Array.isArray(pollEvidence.lingeringWorkerPids) && pollEvidence.lingeringWorkerPids.length > 0;
  const settledPromptly = settledAtMs <= WALL_CLOCK_MS + 3_000; // signal → settle well inside rung-2 territory
  // EVIDENCE AVAILABILITY gates the verdict: a missing poll channel (failed
  // store load / transcript read / SDK import) must never be scored as
  // "spend stopped" — that would be `true` by absence of observation. The
  // ai-sdk lane's channel is structurally absent (an in-process fetch
  // cannot accrue after the abort destroys it) — that is EVIDENCE BY
  // STRUCTURE, not missing evidence, and the doc states it; every other
  // gap is inconclusive.
  let spendStopped;
  let inconclusiveReason;
  if (lane === 'claude-agent' && pollEvidence.pollError !== undefined) {
    spendStopped = 'inconclusive';
    inconclusiveReason = `post-abort evidence channel failed: ${pollEvidence.pollError}`;
  } else if (
    lane === 'claude-agent' &&
    (pollEvidence.transcriptCountAtSettle === undefined ||
      pollEvidence.transcriptCountAfterPoll === undefined)
  ) {
    spendStopped = 'inconclusive';
    inconclusiveReason =
      'the agent transcript message counts were unavailable at settle and/or after the poll';
  } else if (lane === 'claude-agent' && pollEvidence.processCheckError !== undefined) {
    // The lingering-process check FAILED (pgrep itself broke) — an empty
    // pid list was never observed, so "no survivors" cannot be claimed.
    spendStopped = 'inconclusive';
    inconclusiveReason = `process-check failed: ${pollEvidence.processCheckError}`;
  } else if (detachedAtRung3) {
    // The ladder had to escalate to the kill rung: the cooperative settle
    // failed. Spend did NOT verifiably stop — the worker was killed, not
    // obeying — and the sweep above cleaned up whatever survived.
    spendStopped = 'inconclusive';
    inconclusiveReason =
      'the ladder reached rung 3 (kill) — the worker never settled cooperatively after the governed signal';
  } else {
    spendStopped = verdict.stopReason === 'aborted' && settledPromptly && !grew && !lingered;
  }

  return {
    lane,
    wallClockMs: WALL_CLOCK_MS,
    pollMs: POLL_MS,
    settledAtMs,
    settleLatencyMs: settledAtMs - WALL_CLOCK_MS,
    ladderOutcome: ladderOutcome.outcome,
    detachedAtRung3,
    stopReason: verdict.stopReason,
    usageAtAbort: verdict.usage,
    costUSDAtAbort: verdict.costUSD ?? null,
    usageAfterPoll,
    spendStopped,
    ...(inconclusiveReason !== undefined ? { inconclusiveReason } : {}),
    grewAfterAbort: pollEvidence.transcriptCountAtSettle !== undefined ? grew === true : undefined,
    lingeringWorkerPids: pollEvidence.lingeringWorkerPids ?? [],
    lingeringPidsKilled: sweep.lingeringPidsKilled,
    pollError: pollEvidence.pollError,
    processCheckError: pollEvidence.processCheckError,
    pollNote: pollEvidence.note,
  };
}

if (lane !== 'ai-sdk' && lane !== 'claude-agent') {
  console.error('dd1-abort-spike: pass --lane ai-sdk or --lane claude-agent');
  process.exit(1);
}
const verdictJson = await measure(lane);
console.log(JSON.stringify(verdictJson, null, 2));
// THE VERDICT GATES THE EXIT STATUS (PR #52 review, Codex P2): a green
// workflow step past a failed abort verdict hid exactly the failure this
// spike exists to catch — spend that did not verifiably stop. The
// evidence prints above either way; the nonzero exit makes the
// live-drivers step fail on: no verdict (the `error` field), a
// `spendStopped` of false/'inconclusive' (an unverified stop is no
// stop), or an inconclusive reason. A thrown measure() already exits 1
// via the unhandled top-level rejection.
if (verdictJson.error !== undefined || verdictJson.spendStopped !== true) {
  const why =
    verdictJson.error !== undefined
      ? verdictJson.error
      : `spendStopped=${String(verdictJson.spendStopped)}` +
        (verdictJson.inconclusiveReason !== undefined
          ? ` — ${verdictJson.inconclusiveReason}`
          : '');
  console.error(`dd1-abort-spike: ABORT VERDICT FAILED for lane '${lane}': ${why}`);
  // Drain, THEN a bounded exit (PR #114 review, Codex P1): a bare
  // process.exit truncates a piped stdout before the verdict JSON drains
  // (the PR #101 finding) — but exitCode ALONE lets a detached rung-3
  // in-process request's network handles keep the event loop alive,
  // burning the workflow's 30-minute timeout while spend may continue.
  // The write callback fires once the buffer is flushed: bounded, but
  // never truncated.
  process.stdout.write('', () => process.exit(1)); // flush-drain, then the bounded exit
  process.exitCode = 1; // the callback above owns the bound; this is the fallback
} else {
  console.error(
    `dd1-abort-spike: abort verdict passed for lane '${lane}' (spend verifiably stopped)`,
  );
}
