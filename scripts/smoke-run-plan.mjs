#!/usr/bin/env node
// From-source smoke — T1.7 (ws-k stage 1 item 6): the SHIPPED ARTIFACT drives
// a real governed plan. This script imports the BUILT barrel (dist/index.js —
// never src/), wires the documented composition, and asserts the contracts
// the plan runner + governor + subprocess driver are supposed to honor
// end-to-end:
//
//   runPlan(plan, opts, governRegistry(registry, governor))
//     → withBudgetStop(report, plan, governor)
//
// exactly as src/kernel/README.md's "Budget governor" section documents (the
// strategy the kernel and governor tests use). The registry holds ONE op,
// `agent-run`, which delegates to the REAL SubprocessDriver spawning the
// fake agent CLI fixture (test/fixtures/fake-agent-cli.mjs — the same
// stream-json fixture the subprocess conformance suite drives) through the
// driver's `binary` config with its REAL spawn — no test overrides: the
// fixture is a real child process in a real workspace, only the model is
// fake (the fixture's default 'ok' completion, fixed usage).
//
// ASSERTED HERE (the goal's three legs):
//   1. Run report shape — two jobs, both done (result 'ok'), stoppedEarly
//      false, counts honest, report valid against the shipped RunReportSchema.
//   2. Journal evidence — the temp journal dir carries exactly one run whose
//      NDJSON events are run-started, job-started ×2 (attempt 1 each),
//      job-finished ×2, run-finished (first/last in order).
//   3. THE I1 OUTPUT CONTRACT — stdout carries exactly ONE machine-readable
//      artifact, the RunReport as JSON (parseable whole, nothing else);
//      narration, when any, rides stderr under the `cq: ` prefix and never
//      stdout (`cq <plan> | jq .` stays safe). The plan run executes in a
//      CHILD process (this script re-invokes itself with --plan-run) so the
//      parent can inspect its streams as a consumer would.
//   4. USAGE/MODEL OBSERVABILITY — each ok row's observable IS the served
//      model id: the fixture reports the requested --model as served, so
//      the row pins 'smoke-1' (never the 'unreported' fallback), and the
//      governed reportUsage fold lands in the governor's rollup as the
//      fixture's fixed usage ×2 jobs. A driver result WITHOUT usage fails
//      the op outright (the fixture contract guarantees fixed usage).
//      RunReport.usage itself is replay-only on a fresh run (the frozen
//      JobOutcome contract — runner.ts sources per-job usage from replayed
//      journal events alone), so the fold is asserted at the governor in
//      the producing child, not on the report.
//
// SECRETS: the fixture route's key env var (SMOKE_API_KEY) is set here to a
// FAKE value — the subprocess driver reads key VALUES from the environment
// at dispatch time and the fixture never contacts anything (the URL is a
// black hole); no real credential exists in this lane.
//
// Standalone by design — never runs in `npm test` (the suite's smoke test
// only loads the src barrel). Requires `npm run build` first: importing dist
// IS the point. Usage:
//
//   node scripts/smoke-run-plan.mjs            # parent: run + assert
//   node scripts/smoke-run-plan.mjs --plan-run <journalDir>
//                                              # child: execute the plan, I1 output
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(SCRIPT_PATH));
const FAKE_CLI = join(REPO_ROOT, 'test', 'fixtures', 'fake-agent-cli.mjs');

const usage = () => {
  console.error('usage: smoke-run-plan.mjs [--plan-run <journalDir>]');
  process.exit(2);
};

if (process.argv[2] === '--plan-run') {
  const journalDir = process.argv[3];
  if (journalDir === undefined || process.argv[4] !== undefined) usage();
  await runPlanChild(journalDir);
} else if (process.argv[2] === undefined) {
  await runPlanParent();
} else {
  usage();
}

// ---------------------------------------------------------------------------
// Parent mode: spawn the plan run as a child, then assert the three legs.
// ---------------------------------------------------------------------------

async function runPlanParent() {
  const { openRunLog, RunReportSchema } = await importDist();
  const journalDir = await mkdtemp(join(tmpdir(), 'smoke-run-plan-journal-'));
  try {
    const child = spawn(process.execPath, [SCRIPT_PATH, '--plan-run', journalDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (code !== 0) {
      fail(`the plan-run child exited ${code}\n--- child stdout ---\n${stdout}--- child stderr ---\n${stderr}`);
    }

    // Leg 1 — the run report shape, validated against the SHIPPED schema.
    let report;
    try {
      report = RunReportSchema.parse(JSON.parse(stdout));
    } catch (e) {
      fail(
        `I1 violation or bad report: stdout must be exactly one JSON RunReport\n  (${e instanceof Error ? e.message : String(e)})\n--- stdout ---\n${stdout}`,
      );
    }
    if (report.runId.startsWith('smoke-from-source--') === false) {
      fail(`report.runId '${report.runId}' does not carry the plan id prefix 'smoke-from-source--'`);
    }
    if (report.stoppedEarly !== false || report.earlyStopReason !== undefined) {
      fail(`a clean two-job run claims stoppedEarly=${report.stoppedEarly} — dishonest stop (I9)`);
    }
    // Per-key over the six canonical states: a JSON.stringify whole-object
    // compare is key-ORDER-sensitive, so a semantically-equal key reorder
    // in the runner's emptyCounts() would fail the smoke with a misleading
    // diff. Key presence needs no guard here — RunCountsSchema is strict
    // over all six states and the report parsed above.
    const expectedCounts = { queued: 0, running: 0, blocked: 0, done: 2, failed: 0, 'budget-exhausted': 0 };
    for (const state of ['queued', 'running', 'blocked', 'done', 'failed', 'budget-exhausted']) {
      if (report.counts[state] !== expectedCounts[state]) {
        fail(`run counts: state '${state}' expected ${expectedCounts[state]}, got ${report.counts[state]} (full counts ${JSON.stringify(report.counts)})`);
      }
    }
    if (report.jobs.length !== 2) fail(`expected 2 job rows, got ${report.jobs.length}`);
    for (const row of report.jobs) {
      if (row.op !== 'agent-run') fail(`job '${row.jobId}' ran op '${row.op}', expected 'agent-run'`);
      if (row.result.status !== 'ok') {
        fail(`job '${row.jobId}' did not finish ok: ${JSON.stringify(row.result)}`);
      }
      // The op's observable is the SERVED model id (the remap-detection
      // fact): the fixture reports the requested --model as served, so the
      // row must pin 'smoke-1'. A driver dropping WorkerResult.model would
      // otherwise slide through the op's 'unreported' fallback green.
      if (row.result.value !== 'smoke-1') {
        fail(`job '${row.jobId}' observable ${JSON.stringify(row.result.value ?? null)} does not pin the served model 'smoke-1' — model reporting regressed to the 'unreported' fallback`);
      }
    }

    // Leg 2 — the journal evidence in the temp dir.
    const log = openRunLog(journalDir);
    const runs = await log.runs();
    if (runs.length !== 1) fail(`expected exactly one run in the journal dir, got ${runs.length}`);
    const events = await log.read(runs[0]);
    const types = events.map((e) => e.type);
    const count = (type) => types.filter((t) => t === type).length;
    if (types[0] !== 'run-started') fail(`journal must open with run-started, got '${types[0]}'`);
    if (types.at(-1) !== 'run-finished') fail(`journal must close with run-finished, got '${types.at(-1)}'`);
    for (const [type, expected] of [['job-started', 2], ['job-finished', 2], ['run-started', 1], ['run-finished', 1]]) {
      if (count(type) !== expected) fail(`journal carries ${count(type)} ${type} event(s), expected ${expected}`);
    }
    const started = events.filter((e) => e.type === 'job-started');
    for (const event of started) {
      if (event.attempt !== 1) fail(`job-started for '${event.jobId}' carries attempt ${event.attempt}, expected 1`);
    }
    if (new Set(started.map((e) => e.jobId)).size !== 2) fail('the two job-started events do not cover two distinct jobs');

    // Leg 3 — narration never touched stdout: whatever the child said on
    // stderr must be `cq: `-prefixed narration (the I1 halves; the stdout
    // half was the whole-document JSON parse above).
    for (const line of stderr.split('\n')) {
      if (line !== '' && line.startsWith('cq: ') === false) {
        fail(`non-narration line on the child's stderr (I1): '${line}'`);
      }
    }

    process.stdout.write(`smoke: ok — 2/2 jobs done from dist/; journal ${runs[0]}.ndjson; I1 contract held\n`);
  } finally {
    await rm(journalDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Child mode (--plan-run <journalDir>): the REAL composition over dist/.
// ---------------------------------------------------------------------------

async function runPlanChild(journalDir) {
  const {
    BudgetGovernor,
    RunReportSchema,
    RoutingTableSchema,
    SubprocessDriver,
    defaultHarnessConfig,
    defaultRoutingTable,
    emitReport,
    governRegistry,
    governorConfig,
    narrate,
    currentJobContext,
    runPlan,
    withBudgetStop,
  } = await importDist();
  const { z } = await import('zod');

  // The fixture route's key VALUE (fake — see header). The driver reads it
  // from the environment at dispatch time; a missing one throws pre-spawn.
  process.env.SMOKE_API_KEY ??= 'smoke-fake-key';
  // A stray host FAKE_AGENT_MODE would re-script the fixture (up to a
  // SIGTERM-ignoring hang) — the smoke always wants the default 'ok' run.
  // Same for FAKE_AGENT_SERVED_MODEL: the parent pins the served model as
  // 'smoke-1', so a stray override would masquerade as a driver regression.
  delete process.env.FAKE_AGENT_MODE;
  delete process.env.FAKE_AGENT_SERVED_MODEL;

  const scratchDir = await mkdtemp(join(tmpdir(), 'smoke-run-plan-ws-'));
  try {
    // The routing table is CONFIG: the shipped default extended with the
    // fixture endpoint (the subprocess test's conformance-table posture —
    // the URL is a black hole; the fixture IS the model).
    const routingTable = RoutingTableSchema.parse({
      endpoints: {
        ...defaultRoutingTable().endpoints,
        smoke: {
          baseUrlEnv: 'SMOKE_BASE_URL',
          baseUrlDefault: 'http://127.0.0.1:1/anthropic',
          keyEnv: 'SMOKE_API_KEY',
          models: ['smoke-1'],
          notes: 'T1.7 from-source smoke: the fake agent CLI is the model; the URL is never contacted',
        },
      },
    });
    const driver = new SubprocessDriver({
      binary: ['node', FAKE_CLI],
      routingTable,
      sessionsDir: join(scratchDir, 'sessions'),
      harnessConfig: { ...defaultHarnessConfig, workspaceRoot: join(scratchDir, 'workspaces') },
      // no `spawn` override — the REAL spawnManaged runs the fixture child
    });

    // The minimal governed op: delegate to the driver on the frozen seam,
    // fold the WorkerResult into the op-result taxonomy, report usage
    // through the governed job context (the kernel's observer hook). The
    // served model id is the op's value — the remap-detection fact.
    const jobInputSchema = z.object({ jobId: z.string() });
    const agentRunOp = async (raw) => {
      const { jobId } = jobInputSchema.parse(raw);
      const ctx = currentJobContext();
      let result;
      try {
        result = await driver.run({
          prompt: `smoke job ${jobId}: reply with the word ok`,
          modelSpec: { provider: 'smoke', model: 'smoke-1' },
          toolPolicy: { allow: [], mode: 'none' },
          sandboxPolicy: { level: 'none' },
          budget: {},
        });
      } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
      // The fixture contract guarantees usage on every result (fixed
      // numbers): a driver result WITHOUT it is exactly the regression
      // this smoke must catch, so it fails the job — never a silent skip
      // of the reportUsage fold.
      if (result.usage === undefined) {
        return {
          status: 'failed',
          error: 'driver result carries no usage — WorkerResult.usage reporting regressed (the fixture always reports fixed usage)',
        };
      }
      if (ctx !== undefined) ctx.reportUsage(result.usage);
      if (result.stopReason === 'complete') return { status: 'ok', value: result.model ?? 'unreported' };
      return { status: 'failed', error: `agent run stopped: ${result.stopReason}` };
    };
    const registry = {
      get: (name) =>
        name === 'agent-run'
          ? { name, inputSchema: jobInputSchema, importer: () => Promise.resolve(agentRunOp) }
          : undefined,
    };

    const runOptions = { concurrency: 2, stopOnError: false, journalDir, maxUsd: 2 };
    const governor = new BudgetGovernor(governorConfig(runOptions, { perJobWallClockMs: 60_000 }));
    const plan = {
      id: 'smoke-from-source',
      label: 'T1.7 from-source smoke',
      jobs: [
        { id: 'j1', op: 'agent-run', input: { jobId: 'j1' } },
        { id: 'j2', op: 'agent-run', input: { jobId: 'j2' } },
      ],
    };

    // THE COMPOSITION (kernel README, "Budget governor"): the governed
    // registry decorates the view; withBudgetStop annotates the report only
    // on an actual trip.
    const raw = await runPlan(plan, runOptions, governRegistry(registry, governor));
    const report = withBudgetStop(raw, plan, governor);

    // The reportUsage fold, observed where it lands: on a fresh run the
    // RunReport carries usage only from REPLAYED journal events (frozen
    // JobOutcome contract), so the fold's evidence on this path is the
    // governor's rollup — the fixture's fixed usage {10,5,2,3} once per
    // job, twice here. A dropped reportUsage call (or a regressed
    // WorkerResult.usage sneaking past the op guard above) leaves this
    // undefined or short. Key order is the driver's canonical Usage order
    // on both sides (same in-process fold), so the whole-object compare
    // here is not order-sensitive.
    assertDeepEqual(
      governor.usage,
      { input: 20, output: 10, cacheRead: 4, cacheWrite: 6 },
      'governor usage rollup (fixture fixed usage ×2 jobs — the reportUsage fold)',
    );

    // THE I1 CONTRACT: stdout carries the report (one JSON artifact, via the
    // shipped emitReport helper); narration rides stderr under `cq: `.
    RunReportSchema.parse(report); // never emit what the schema rejects
    emitReport(report);
    narrate(`smoke: ${report.counts.done}/2 jobs done (plan ${plan.id}, run ${report.runId})`);
    process.exitCode = report.counts.done === 2 ? 0 : 1;
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Import the BUILT barrel. A missing dist is the smoke's most likely
 * failure mode (the from-source point is that dist exists and works) —
 * name the fix instead of leaking an ERR_MODULE_NOT_FOUND.
 */
async function importDist() {
  try {
    return await import('../dist/index.js');
  } catch (e) {
    fail(
      `cannot import dist/index.js — run \`npm run build\` first (the from-source smoke drives the BUILT artifact)\n  (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

/** Assert deep equality with a readable diff, then exit non-zero. */
function assertDeepEqual(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(`${what}: expected ${b}, got ${a}`);
}

function fail(message) {
  console.error(`smoke-run-plan: FAIL\n${message}`);
  process.exit(1);
}
