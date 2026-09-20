// T4.3 per-plan CLI smoke — every shipped plan through the BUILT CLI.
//
// ws-i scope item 2 ("all five shipped plans exposed as subcommands") plus
// "each shipped plan has a smoke test": this suite pins the CLI path, where
// test/plans/** pins the plan modules themselves. For every plan the plan
// registry discovers (sweep, test-fix, review-loop, merge-prs, analyze) it
// spawns the built CLI
//
//   node dist/cli.js <plan-name> --json
//
// on a fresh scratch fixture repo (the D4 generator: two packages, a probe
// check, one seed commit) and asserts the I1 contract end to end:
//   - stdout is EXACTLY ONE artifact, validating against the shipped
//     RunReportSchema;
//   - --json is machine mode: stderr is EMPTY;
//   - the process exit code is the report's own mechanical verdict
//     (exitCodeForRunReport — the frozen taxonomy, never guessed here);
//   - the runId carries the plan id prefix, so the subcommand really ran that
//     plan and not another;
//   - the per-plan shape: review-loop's floor is the empty plan, analyze's
//     floor terminates at its honest collect failure, the planner-only
//     floors (sweep, test-fix, merge-prs) complete.
// Plus the generation contract: global --help lists EVERY registry plan
// (help is derived from the registry, not a hand-written list) and the smoke
// table below must cover exactly the discovered set.
//
// HERMETIC HARNESS: the forge seam is ROUTED to the fake gh
// (test/fixtures/gh/fake-gh.mjs) via CQ_GH_BIN for the two forge-capable
// floors (review-loop, merge-prs) — the shipped floors are empty passes and
// spawn no gh, so this only guarantees that IF one ever spawns, it can never
// reach a live forge (the fake gh itself is exercised by test/ops/review/**
// and the live-review drill). The agent seam is the fake sweep agent
// (test/fixtures/scratch-repo/sweep-agent.mjs) driven by the REAL
// SubprocessDriver in the real-instance leg below.
//
// REAL-INSTANCE COVERAGE (the goal's "via the subprocess driver + fake
// agent" acceptance): the floor runs above are agent-free by construction,
// so a separate leg builds the REAL sweep and test-fix instances (phase-A
// planner over the scratch repo → phase-B expanded graph with the driver/
// check bindings) and runs each through the same built CLI via
// `run-plan --plan=<file>`; the real SubprocessDriver then spawns the fake
// sweep agent once per unit (asserted from the driver's session files).
// review-loop, merge-prs and analyze have no hermetic real instance here:
// their real builders need per-run state (fetched review threads, conflicting
// PRs, a real analysis target) and, for the agent-backed review/merge ops, a
// driver-BINARY injection the op input does not expose — so running them
// through the CLI would require a per-plan CLI input/injection surface the
// goal did not specify. Owner: goal T4.3 / ws-i scope item 2 ("all five
// shipped plans exposed as subcommands" + "each shipped plan has a smoke
// test"). Their real instances stay pinned in-process by test/plans/** and
// test/e2e/** (D4/E4/F4/G3 lanes).
//
// BUILD ON DEMAND: CI's static job runs the suite BEFORE its build step, and
// a dist-gated skip would make this smoke green because it was omitted (the
// plan's explicit stop condition). So the suite builds dist/ once when it is
// missing OR STALE (older than the newest src/** file — a stale dist would
// certify obsolete code) and never silently skips.
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { exitCodeForRunReport } from '../../src/cli/exit.js';
import { RunReportSchema } from '../../src/kernel/schema.js';
import type { Plan } from '../../src/kernel/types.js';
import {
  makePlanSweep,
  makeSubprocessSweepPlannerDeps,
  SWEEP_UNIT_OP,
} from '../../src/ops/sweep/planSweep.js';
import type {
  SweepUnitCheckConfig,
  SweepUnitDispatchInput,
  SweepUnitDriverConfig,
} from '../../src/ops/sweep/unit.js';
import { listPlans } from '../../src/plans/registry.js';
import {
  buildSweepPlan,
  SWEEP_PLAN_ID,
  SWEEP_PLAN_JOB_IDS,
  sweepPlannerInput,
} from '../../src/plans/sweep.js';
import { buildTestFixPlan, TEST_FIX_FIXER, TEST_FIX_PLAN_ID } from '../../src/plans/test-fix.js';
import {
  generateScratchRepo,
  SCRATCH_PACKAGES,
  SCRATCH_PACKAGE_FILES,
} from '../fixtures/scratch-repo/generate.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST_CLI = join(ROOT, 'dist', 'cli.js');
const FAKE_GH = join(ROOT, 'test', 'fixtures', 'gh', 'fake-gh.mjs');
const SMOKE_OPS = join(ROOT, 'test', 'fixtures', 'cli-smoke-ops');
const SWEEP_AGENT = join(ROOT, 'test', 'fixtures', 'scratch-repo', 'sweep-agent.mjs');

/** Hard per-CLI budget: a hung plan child must fail the smoke, not stall CI. */
const CLI_TIMEOUT_MS = 180_000;
/** The build hook's budget (tsc emit on a cold runner). */
const BUILD_TIMEOUT_MS = 300_000;

/**
 * The smoke table: every plan the registry discovers, the exit code its floor
 * is expected to reach on the scratch repo, and whether its floor is
 * forge-capable (CQ_GH_BIN routes any spawn to the fake gh; the empty floors
 * spawn none). The `covers every discovered plan` test below fails if a new
 * plan lands without a row here.
 */
const PLANS = [
  { name: 'sweep', exit: 0, forge: false },
  { name: 'test-fix', exit: 0, forge: false },
  { name: 'review-loop', exit: 0, forge: true },
  { name: 'merge-prs', exit: 0, forge: true },
  { name: 'analyze', exit: 1, forge: false },
] as const;

let scratchRepo = '';
let planDir = '';

beforeAll(
  async () => {
    ensureBuiltCli();
    scratchRepo = mkdtempSync(join(tmpdir(), 'cq-plans-smoke-repo-'));
    planDir = mkdtempSync(join(tmpdir(), 'cq-plans-smoke-plan-'));
    await generateScratchRepo(scratchRepo);
  },
  // A margin over the build budget: a near-limit build must not starve the
  // scratch-repo setup and misreport the failure as a hook timeout.
  BUILD_TIMEOUT_MS + 120_000,
);

afterAll(() => {
  for (const dir of [scratchRepo, planDir]) {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  }
});

/** Newest mtime (ms) across a directory tree; 0 when it holds no files. */
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtimeMs(full));
    else if (entry.isFile()) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

/**
 * Build dist/ when the BUILT CLI is missing OR STALE (older than the newest
 * src/** file): a dist built from older sources would make the whole smoke
 * certify obsolete code. CI's static job tests before it builds, so this is
 * the only way the smoke can run there without a dist-gated skip.
 */
function ensureBuiltCli(): void {
  const distMtime = existsSync(DIST_CLI) ? statSync(DIST_CLI).mtimeMs : 0;
  if (distMtime > 0 && distMtime >= newestMtimeMs(join(ROOT, 'src'))) return;
  try {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: BUILD_TIMEOUT_MS,
    });
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer };
    throw new Error(
      `plans.smoke: could not build dist/ (the built CLI is the point) — ` +
        `run \`npm run build\`\n${String(e.stdout ?? '')}${String(e.stderr ?? '')}`,
    );
  }
}

/**
 * The child environment, scrubbed of every ambient knob that could script or
 * leak into the plan children: all `CQ_*` (CQ_GH_BIN / CQ_GH_SCENARIO /
 * CQ_GH_LOG / …), the fake-agent scripting vars, the smoke route's key and
 * URL, and the forge credentials. The repo's node_modules/.bin leads PATH so
 * the analyze floor's placeholder probe resolves `tsc` deterministically.
 */
function hermeticEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('CQ_') ||
      key.startsWith('FAKE_AGENT_') ||
      key === 'SMOKE_API_KEY' ||
      key === 'SMOKE_BASE_URL' ||
      key === 'GH_TOKEN' ||
      key === 'GITHUB_TOKEN'
    ) {
      delete env[key];
    }
  }
  const bin = join(ROOT, 'node_modules', '.bin');
  env.PATH = env.PATH === undefined ? bin : `${bin}${delimiter}${env.PATH}`;
  return env;
}

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** One diagnostic context string for a spawn result, for assertion messages. */
function context(res: SpawnSyncReturns<string>): string {
  return (
    `status=${String(res.status)} signal=${String(res.signal)} ` +
    `error=${res.error instanceof Error ? res.error.message : String(res.error)}\n` +
    `--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`
  );
}

interface RealSweepFamilyPlan {
  plan: Plan;
  sessionsDir: string;
}

/**
 * Build a REAL instance of a sweep-family shipped plan (sweep / test-fix)
 * over the scratch repo: phase A runs the planner with its real subprocess
 * deps, phase B expands it, and the caller's documented post-build enrichment
 * layers the driver/check bindings the `sweep.unit` op needs. The declared
 * tracker-branch/assemble legs are dropped — a real forge is out of scope for
 * this hermetic leg (the per-plan D4 e2e owns the forge composition). The
 * result is a JSON-serializable Plan whose unit jobs dispatch through the
 * REAL SubprocessDriver against the fake sweep agent.
 */
async function buildRealSweepFamilyPlan(kind: 'sweep' | 'test-fix'): Promise<RealSweepFamilyPlan> {
  const fixer = kind === 'sweep' ? 'fix' : TEST_FIX_FIXER;
  const config = {
    repoRoot: scratchRepo,
    worktreesDir: kind === 'sweep' ? 'worktrees' : 'worktrees-test-fix',
    runPrefix: kind === 'sweep' ? 'cq/t43-sweep' : 'cq/t43-test-fix',
    base: 'main',
    packages: SCRATCH_PACKAGES,
    selector: { mode: 'workspace-all' as const },
    fixers: [fixer],
    packageFiles: SCRATCH_PACKAGE_FILES,
  };
  const plannerOp = makePlanSweep(makeSubprocessSweepPlannerDeps(scratchRepo));
  const planned = await plannerOp(sweepPlannerInput(config));
  if (planned.status !== 'ok') {
    throw new Error(`real ${kind} plan: the phase-A planner failed — ${JSON.stringify(planned)}`);
  }
  const sessionsDir = join(planDir, `sessions-${kind}`);
  const runStateDir = join(planDir, `run-state-${kind}`);
  const driver: SweepUnitDriverConfig = {
    binary: [process.execPath, SWEEP_AGENT],
    provider: 'cq-t43-smoke',
    model: 'sweep-fake',
    sessionsDir,
    routingTable: {
      endpoints: {
        'cq-t43-smoke': {
          baseUrlEnv: 'CQ_T43_SMOKE_URL',
          baseUrlDefault: 'http://127.0.0.1:9',
          keyEnv: 'CQ_T43_SMOKE_KEY',
          models: ['sweep-fake'],
          notes:
            'T4.3 real-plan smoke: the sweep agent fixture is the model; the URL is never contacted',
        },
      },
    },
  };
  const check: SweepUnitCheckConfig = {
    adapter: 'tsc-lines',
    command: process.execPath,
    args: ['scripts/check.js', '{package}'],
    timeoutMs: 30_000,
  };
  const full =
    kind === 'sweep'
      ? buildSweepPlan(config, planned.value)
      : buildTestFixPlan(config, planned.value);
  // The caller's post-build enrichment + the #174 run-state vouch, exactly
  // as the D4 e2e composes it (the frozen Job has no cross-job data channel).
  const jobs = full.jobs.filter(
    (job) => job.id !== SWEEP_PLAN_JOB_IDS.assemble && job.id !== SWEEP_PLAN_JOB_IDS.trackerBranch,
  );
  for (const job of jobs) {
    if (job.op !== SWEEP_UNIT_OP) continue;
    Object.assign(job.input as SweepUnitDispatchInput, {
      driver,
      check,
      push: false,
      runStateDir,
    });
  }
  const planId = kind === 'sweep' ? SWEEP_PLAN_ID : TEST_FIX_PLAN_ID;
  return { plan: { ...full, id: planId, jobs }, sessionsDir };
}

describe('the plan smoke table covers the registry (generation contract)', () => {
  test('exactly the discovered plan set is exercised', async () => {
    const discovered = (await listPlans()).map((entry) => entry.name).sort();
    expect(discovered).toEqual(PLANS.map((plan) => plan.name).sort());
  });

  test('global --help lists every discovered plan subcommand', async () => {
    const res = runCli(['--help'], hermeticEnv(), ROOT);
    expect(res.error, context(res)).toBeUndefined();
    expect(res.status, context(res)).toBe(0);
    for (const plan of await listPlans()) {
      expect(res.stdout, `plan '${plan.name}' missing from global help`).toContain(
        `\n  ${plan.name}\n`,
      );
    }
  });
});

describe('every shipped plan runs through the built CLI (ws-i item 2)', () => {
  for (const plan of PLANS) {
    test(
      `cq ${plan.name} --json → one RunReport, exit ${plan.exit}`,
      () => {
        const env = hermeticEnv();
        if (plan.forge) env.CQ_GH_BIN = FAKE_GH;
        const res = runCli([plan.name, '--json'], env, scratchRepo);
        expect(res.error, context(res)).toBeUndefined();
        expect(res.status, context(res)).toBe(plan.exit);
        // Machine mode: --json keeps stderr EMPTY (I1).
        expect(res.stderr, context(res)).toBe('');
        // stdout is EXACTLY one artifact, valid against the shipped schema.
        const report = RunReportSchema.parse(JSON.parse(res.stdout));
        expect(report.runId.startsWith(`${plan.name}--`), context(res)).toBe(true);
        // The exit code is the report's own mechanical taxonomy verdict.
        expect(res.status, context(res)).toBe(exitCodeForRunReport(report));
        if (plan.name === 'review-loop') {
          // The floor is the documented empty instance: zero jobs, clean stop.
          expect(report.jobs).toEqual([]);
          expect(report.stoppedEarly).toBe(false);
        }
        if (plan.name === 'analyze') {
          // The floor's honest pin: the run fails for an honest reason. When
          // the probe reaches a reading, collect fails on its OWN empty-sets
          // policy; when the probe itself cannot read the target (a
          // host-toolchain fact, e.g. no parsable tsc diagnostics), collect is
          // honestly BLOCKED by it. Either way a failed row carries a
          // non-empty reason — never a fabricated pass. Pin both shapes
          // rather than assuming the probe's outcome on this host.
          const probe = report.jobs.find((row) => row.jobId === 'analyze-probe');
          const collect = report.jobs.find((row) => row.jobId === 'analyze-collect');
          expect(collect?.result.status, context(res)).toBe('failed');
          if (collect?.result.status === 'failed') {
            const expected = probe?.result.status === 'ok' ? 'no input sets' : 'blocked:';
            expect(collect.result.error, context(res)).toContain(expected);
          }
        }
      },
      CLI_TIMEOUT_MS,
    );
  }

  test('a plan subcommand --help renders the governed-run flags (no --plan)', () => {
    const res = runCli(['sweep', '--help'], hermeticEnv(), scratchRepo);
    expect(res.error, context(res)).toBeUndefined();
    expect(res.status, context(res)).toBe(0);
    for (const flag of ['--ops-root=', '--concurrency=', '--journal-dir=', '--json', '--help']) {
      expect(res.stdout).toContain(flag);
    }
    expect(res.stdout).not.toContain('--plan=');
  });

  test('a plan subcommand rejects a plan-file flag (its plan comes from the registry)', () => {
    const res = runCli(['sweep', '--plan=whatever.json'], hermeticEnv(), scratchRepo);
    expect(res.status, context(res)).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/invalid input for 'sweep'/);
  });
});

describe('the built CLI still drives the subprocess driver + fake agent', () => {
  test(
    'run-plan over the cli-smoke-ops fixture completes through a real fake-agent child',
    () => {
      const planPath = join(planDir, 'driver-smoke-plan.json');
      writeFileSync(
        planPath,
        JSON.stringify({
          id: 'plans-smoke-driver',
          label: 'T4.3 smoke — subprocess driver + fake agent leg',
          jobs: [{ id: 'agent', op: 'agent-run', input: { jobId: 'agent' } }],
        }),
        'utf8',
      );
      const env = hermeticEnv();
      // The fixture route's key VALUE (fake — the URL is a black hole and the
      // fake agent CLI is the model).
      env.SMOKE_API_KEY = 'plans-smoke-fake-key';
      const res = runCli(
        ['run-plan', `--plan=${planPath}`, `--ops-root=${SMOKE_OPS}`, '--json'],
        env,
        scratchRepo,
      );
      expect(res.error, context(res)).toBeUndefined();
      expect(res.status, context(res)).toBe(0);
      expect(res.stderr, context(res)).toBe('');
      const report = RunReportSchema.parse(JSON.parse(res.stdout));
      expect(report.jobs).toHaveLength(1);
      const job = report.jobs[0];
      if (job === undefined) throw new Error('the driver-smoke plan produced no job row');
      expect(job.op).toBe('agent-run');
      expect(job.result.status, context(res)).toBe('ok');
      // The fixture reports the requested model as served — a driver that
      // dropped WorkerResult.model falls back to 'unreported'.
      if (job.result.status === 'ok') {
        expect(job.result.value, context(res)).toBe('smoke-1');
      }
    },
    CLI_TIMEOUT_MS,
  );

  for (const kind of ['sweep', 'test-fix'] as const) {
    test(
      `run-plan of a REAL ${kind} plan spawns the fake sweep agent through the real SubprocessDriver`,
      async () => {
        const built = await buildRealSweepFamilyPlan(kind);
        const planPath = join(planDir, `real-${kind}-plan.json`);
        writeFileSync(planPath, JSON.stringify(built.plan), 'utf8');
        const env = hermeticEnv();
        // The driver route's key VALUE (fake — the URL is a black hole; the
        // fake sweep agent IS the model).
        env.CQ_T43_SMOKE_KEY = 't43-smoke-fake-key';
        const res = runCli(
          ['run-plan', `--plan=${planPath}`, '--json', '--concurrency=1'],
          env,
          scratchRepo,
        );
        expect(res.error, context(res)).toBeUndefined();
        expect(res.status, context(res)).toBe(0);
        expect(res.stderr, context(res)).toBe('');
        const report = RunReportSchema.parse(JSON.parse(res.stdout));
        for (const row of report.jobs) {
          expect(row.result.status, `${row.jobId}: ${context(res)}`).toBe('ok');
        }
        // Every selected package dispatched one sweep.unit job.
        const unitRows = report.jobs.filter((row) => row.op === SWEEP_UNIT_OP);
        expect(unitRows.length, context(res)).toBe(SCRATCH_PACKAGES.length);
        // The REAL SubprocessDriver wrote a session per unit: the fake agent
        // CLI was genuinely spawned, not stubbed.
        expect(
          existsSync(built.sessionsDir),
          `the driver wrote no sessions — the fake agent never spawned:\n${context(res)}`,
        ).toBe(true);
        expect(readdirSync(built.sessionsDir).length, context(res)).toBeGreaterThanOrEqual(
          SCRATCH_PACKAGES.length,
        );
      },
      CLI_TIMEOUT_MS,
    );
  }
});
