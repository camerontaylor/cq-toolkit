#!/usr/bin/env node
// From-source smoke — T1.7 (ws-k stage 1 item 6), I1 slice D: the BUILT CLI
// (dist/cli.js) drives a real governed plan. This script spawns
//
//   node dist/cli.js run-plan --plan=<file> --journal-dir=<dir> \
//        --concurrency=2 --max-usd=2 --ops-root=test/fixtures/cli-smoke-ops
//
// as a child, consumer-style (stdio piped, streams inspected), and asserts
// the contracts the CLI + kernel + governor + subprocess driver are supposed
// to honor end-to-end. The plan's `agent-run` op resolves through the BUILT
// CLI's registry from the fixture op family (test/fixtures/cli-smoke-ops —
// the documented family convention as plain ESM .js), whose op delegates to
// the REAL SubprocessDriver spawning the fake agent CLI fixture
// (test/fixtures/fake-agent-cli.mjs — the same stream-json fixture the
// subprocess conformance suite drives) through the driver's `binary` config
// with its REAL spawn — no test overrides: the fixture is a real child
// process in a real workspace, only the model is fake (the fixture's
// default 'ok' completion, fixed usage). The governed composition itself is
// the CLI's (src/cli/run-plan.ts):
//
//   runPlan(plan, opts, governRegistry(view, governor))
//     → withBudgetStop(report, plan, governor)
//
// exactly as src/kernel/README.md's "Budget governor" section documents —
// the old smoke wired this composition BY HAND in a self re-invoked child;
// a generic CLI child cannot carry that hand wiring, so the usage-fold
// evidence moved into the fixture op's guards (leg 4 below).
//
// ASSERTED HERE (the legs):
//   0. Child exit code 0 — the CLI's own verdict over the whole run.
//   1. Run report shape — stdout is EXACTLY ONE machine-readable artifact,
//      valid against the shipped RunReportSchema (parseable whole, nothing
//      else); two jobs, both done (value 'smoke-1'), stoppedEarly false,
//      counts honest.
//   1b. Frozen-contract pin — on a FRESH run, report.usage and every
//      row.usage are undefined: RunReport usage is replay-only (the frozen
//      JobOutcome contract — runner.ts sources per-job usage from replayed
//      journal events alone), and the derived-only costUSD stays undefined
//      too (cost is priced by the price-map layer from usage; runPlan never
//      fabricates it).
//   2. Journal evidence — the temp journal dir carries exactly one run whose
//      NDJSON events are run-started, job-started ×2 (attempt 1 each),
//      job-finished ×2, run-finished (first/last in order).
//   3. THE I1 OUTPUT CONTRACT — stdout carries exactly ONE machine-readable
//      artifact (the whole-document JSON parse above); narration rides
//      stderr under the `cq: ` prefix and never stdout (`cq <plan> | jq .`
//      stays safe). Failures-only narration: with both rows ok the stderr
//      view is the counts summary alone — NO per-row lines. (`--json`
//      suppressing narration entirely is pinned by the vitest conformance
//      suite, test/cli/i1.test.ts — not here.)
//   4. USAGE/MODEL OBSERVABILITY — each ok row's observable IS the served
//      model id: the fixture reports the requested --model as served, so
//      the row must pin 'smoke-1' (never the 'unreported' fallback). The
//      USAGE FOLD's evidence moved: the old smoke asserted the governor's
//      rollup ({10,5,2,3} ×2 jobs) INSIDE its hand-wired child, right after
//      runPlan; a generic CLI child has no governor handle to inspect. At
//      the CLI boundary the fold is proven by the fixture op's guards
//      (test/fixtures/cli-smoke-ops/smoke/agent-run.js):
//        (a) the op REFUSES an ungoverned job context — a dropped
//            governRegistry wiring fails both jobs and the child exits 1,
//            failing leg 0;
//        (b) the op REFUSES a driver result without usage (the old
//            regression guard, message unchanged);
//        (c) leg 0's exit 0 + leg 1's two ok rows prove both guards passed
//            — i.e. ctx.reportUsage WAS called with the fixture's fixed
//            usage, once per job, twice here.
//
// SECRETS: the fixture route's key env var (SMOKE_API_KEY) is set here to a
// FAKE value — the subprocess driver reads key VALUES from the environment
// at dispatch time and the fixture never contacts anything (the URL is a
// black hole); no real credential exists in this lane.
//
// Standalone by design — never imported by `npm test` (the suite's smoke
// test only loads the src barrel). Requires `npm run build` first: spawning
// dist/cli.js IS the point. Usage:
//
//   node scripts/smoke-run-plan.mjs            # spawn the built CLI + assert
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(SCRIPT_PATH));

const usage = () => {
  console.error('usage: smoke-run-plan.mjs');
  process.exit(2);
};

if (process.argv.length > 2) usage();
await runPlanParent();

// ---------------------------------------------------------------------------
// Parent mode: spawn the BUILT CLI's run-plan as a child, then assert the
// legs against its streams, the shipped schema, and the journal.
// ---------------------------------------------------------------------------

async function runPlanParent() {
  // Require dist up front: a missing dist is the smoke's most likely failure
  // mode (the from-source point is that dist exists and works) — name the
  // fix instead of leaking an ERR_MODULE_NOT_FOUND from the child.
  try {
    await access(join(REPO_ROOT, 'dist', 'cli.js'));
  } catch {
    fail('dist/cli.js is missing — run `npm run build` first — from-source IS the point (the smoke spawns the BUILT CLI)');
  }
  const { openRunLog, RunReportSchema } = await importDist();

  const journalDir = await mkdtemp(join(tmpdir(), 'smoke-run-plan-journal-'));
  const planDir = await mkdtemp(join(tmpdir(), 'smoke-run-plan-plan-'));
  try {
    const planPath = join(planDir, 'plan.json');
    const plan = {
      id: 'smoke-from-source',
      label: 'T1.7 from-source smoke',
      jobs: [
        { id: 'j1', op: 'agent-run', input: { jobId: 'j1' } },
        { id: 'j2', op: 'agent-run', input: { jobId: 'j2' } },
      ],
    };
    await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');

    // The child's environment: the fixture route's key VALUE (fake — see the
    // header; the driver reads it from the environment at dispatch time and
    // a missing one throws pre-spawn). FAKE_AGENT_MODE deleted: a stray host
    // value would re-script the fixture (up to a SIGTERM-ignoring hang) —
    // the smoke always wants the default 'ok' run. FAKE_AGENT_SERVED_MODEL
    // deleted for the same reason: leg 1 pins the served model as 'smoke-1',
    // so a stray override would masquerade as a driver regression.
    const childEnv = { ...process.env, SMOKE_API_KEY: 'smoke-fake-key' };
    delete childEnv.FAKE_AGENT_MODE;
    delete childEnv.FAKE_AGENT_SERVED_MODEL;

    const child = spawn(
      process.execPath,
      [
        join(REPO_ROOT, 'dist', 'cli.js'),
        'run-plan',
        `--plan=${planPath}`,
        `--journal-dir=${journalDir}`,
        '--concurrency=2',
        '--max-usd=2',
        `--ops-root=${join(REPO_ROOT, 'test', 'fixtures', 'cli-smoke-ops')}`,
      ],
      { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
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

    // Leg 0 — the CLI's own verdict.
    if (code !== 0) {
      fail(`the dist/cli.js run-plan child exited ${code}\n--- child stdout ---\n${stdout}--- child stderr ---\n${stderr}`);
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

    // Leg 1b — the frozen-contract pin on a FRESH run: RunReport usage is
    // replay-only (runner.ts sources per-job usage from replayed journal
    // events alone — executed rows never carry it), so the report and every
    // row leave usage undefined here; the derived-only costUSD stays
    // undefined too (the price-map layer owns cost; runPlan never
    // fabricates it — see the runner's rollup note).
    if (report.usage !== undefined) {
      fail(`fresh-run report.usage is ${JSON.stringify(report.usage)} — RunReport usage must be replay-only on a fresh run (frozen JobOutcome contract)`);
    }
    for (const row of report.jobs) {
      if (row.usage !== undefined) {
        fail(`fresh-run row '${row.jobId}'.usage is ${JSON.stringify(row.usage)} — per-job usage must be replay-only on a fresh run (frozen JobOutcome contract)`);
      }
      if (row.costUSD !== undefined) {
        fail(`fresh-run row '${row.jobId}'.costUSD is ${row.costUSD} — costUSD is derived-only and runPlan never fabricates it`);
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

    // Leg 3 — the I1 halves at the stream boundary: whatever the CLI said on
    // stderr must be `cq: `-prefixed narration (the stdout half was the
    // whole-document JSON parse above), AND that narration is the
    // failures-only human view: with both rows ok it is the counts summary
    // alone — every row silent, no per-row lines.
    for (const line of stderr.split('\n')) {
      if (line !== '' && line.startsWith('cq: ') === false) {
        fail(`non-narration line on the child's stderr (I1): '${line}'`);
      }
    }
    const narrated = stderr.split('\n').filter((line) => line !== '');
    if (narrated.some((line) => line.startsWith('cq: done 2,')) === false) {
      fail(`the child's stderr narration does not carry the counts summary line 'cq: done 2, …' (renderHuman's summary):\n${stderr}`);
    }
    for (const line of narrated) {
      // renderHuman's per-row form is `<jobId> (<op>): <status>`; with all
      // rows ok the failures-only default must render NONE of them.
      if (line.includes(' (agent-run): ')) {
        fail(`failures-only narration rendered a per-row line for an ok row (I1): '${line}'`);
      }
    }

    // Leg 4 — the usage fold, observed at the CLI boundary (see the header):
    // legs 0 + 1 already proved child exit 0 with both rows ok, which is
    // exactly (a) ∧ (b) ∧ (c) — the fixture op's ungoverned guard and
    // no-usage guard both passed, so ctx.reportUsage WAS called with the
    // fixture's fixed usage ×2. The rollup itself lives behind the CLI's
    // composition, where a generic consumer cannot reach it — by design.

    process.stdout.write(`smoke: ok — 2/2 jobs done via dist/cli.js run-plan; journal ${runs[0]}.ndjson; I1 contract held\n`);
  } finally {
    await rm(journalDir, { recursive: true, force: true });
    await rm(planDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Import the BUILT barrel for the parent's own assertions (the schema mirror
 * and the journal reader). The child under test is dist/cli.js; this import
 * only reads evidence, never runs the plan.
 */
async function importDist() {
  try {
    return await import('../dist/index.js');
  } catch (e) {
    fail(
      `cannot import dist/index.js — run \`npm run build\` first — from-source IS the point (the smoke spawns the BUILT CLI)\n  (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

function fail(message) {
  console.error(`smoke-run-plan: FAIL\n${message}`);
  process.exit(1);
}
