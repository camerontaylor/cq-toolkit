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
// HERMETIC HARNESS: the forge seam is the fake gh
// (test/fixtures/gh/fake-gh.mjs) via CQ_GH_BIN for the two forge-touching
// floors (review-loop, merge-prs), and the agent seam is the fake agent CLI
// fixture (test/fixtures/fake-agent-cli.mjs) — the same stream-json fixture
// the subprocess conformance suite and the from-source smoke drive. A
// companion leg runs a plan JSON through the SAME built CLI with the
// cli-smoke-ops fixture, so the real SubprocessDriver + fake agent path is
// exercised here too (the shipped floors are agent-free by construction:
// plans are parameterized builders whose real instances are authored per run
// in the SDK/entry modules, and the registry entry is the discoverable floor).
//
// BUILD ON DEMAND: CI's static job runs the suite BEFORE its build step, and
// a dist-gated skip would make this smoke green because it was omitted (the
// plan's explicit stop condition). So the suite builds dist/ once when it is
// missing (fileParallelism is false — no competing build) and never silently
// skips.
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { exitCodeForRunReport } from '../../src/cli/exit.js';
import { RunReportSchema } from '../../src/kernel/schema.js';
import { listPlans } from '../../src/plans/registry.js';
import { generateScratchRepo } from '../fixtures/scratch-repo/generate.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST_CLI = join(ROOT, 'dist', 'cli.js');
const FAKE_GH = join(ROOT, 'test', 'fixtures', 'gh', 'fake-gh.mjs');
const SMOKE_OPS = join(ROOT, 'test', 'fixtures', 'cli-smoke-ops');

/** Hard per-CLI budget: a hung plan child must fail the smoke, not stall CI. */
const CLI_TIMEOUT_MS = 180_000;
/** The build hook's budget (tsc emit on a cold runner). */
const BUILD_TIMEOUT_MS = 300_000;

/**
 * The smoke table: every plan the registry discovers, the exit code its floor
 * is expected to reach on the scratch repo, and whether its floor may touch a
 * forge (so CQ_GH_BIN routes it to the fake gh). The `covers every discovered
 * plan` test below fails if a new plan lands without a row here.
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

beforeAll(async () => {
  ensureBuiltCli();
  scratchRepo = mkdtempSync(join(tmpdir(), 'cq-plans-smoke-repo-'));
  planDir = mkdtempSync(join(tmpdir(), 'cq-plans-smoke-plan-'));
  await generateScratchRepo(scratchRepo);
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  for (const dir of [scratchRepo, planDir]) {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build dist/ once when the BUILT CLI is absent. CI's static job tests before
 * it builds, so this is the only way the smoke can run there without a
 * dist-gated skip.
 */
function ensureBuiltCli(): void {
  if (existsSync(DIST_CLI)) return;
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
 * The child environment: the host env minus the volatile fake-agent scripting
 * knobs (a stray FAKE_AGENT_MODE could script a hang) and minus any ambient
 * CQ_GH_BIN (each forge case sets the fake explicitly). The repo's
 * node_modules/.bin leads PATH so the analyze floor's placeholder probe
 * resolves `tsc` deterministically.
 */
function hermeticEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.FAKE_AGENT_MODE;
  delete env.FAKE_AGENT_SERVED_MODEL;
  delete env.CQ_GH_BIN;
  delete env.SMOKE_API_KEY;
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
          // The floor's honest pin: probe → collect, and collect fails on the
          // empty-sets policy (nothing was ever wired to the probe).
          const collect = report.jobs.find((row) => row.jobId === 'analyze-collect');
          expect(collect?.result.status, context(res)).toBe('failed');
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
});
