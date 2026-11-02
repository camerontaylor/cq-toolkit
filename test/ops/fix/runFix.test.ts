import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createGovernor, currentJobContext } from '../../../src/kernel/governor.js';
import { runPlan, type OpRegistryView } from '../../../src/kernel/runner.js';
import type { Op, OpRegistryEntry } from '../../../src/kernel/types.js';
import {
  fixesPerRunOf,
  githubCompareBaseUrl,
  makeFixRun,
  type FixRunReport,
} from '../../../src/ops/fix/runFix.js';
import type { FixTaskReport } from '../../../src/ops/sweep/taskLoop.js';
import type { SweepUnitReport } from '../../../src/ops/sweep/unit.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { generateScratchRepo } from '../../fixtures/scratch-repo/generate.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';

describe('failed-attempt compare links', () => {
  test('builds an encoded GitHub comparison URL from a remote and pinned base revision', () => {
    expect(githubCompareBaseUrl('git@github.com:example/scratch.git', 'a'.repeat(40))).toBe(
      `https://github.com/example/scratch/compare/${'a'.repeat(40)}...`,
    );
  });

  test('does not invent a GitHub link for a non-GitHub remote or invalid revision', () => {
    expect(githubCompareBaseUrl('/tmp/origin.git', 'a'.repeat(40))).toBeUndefined();
    expect(githubCompareBaseUrl('https://github.com/example/scratch.git', 'HEAD')).toBeUndefined();
  });
});

const task = (outcome: FixTaskReport['outcome'], commits: string[]): FixTaskReport => ({
  task: { id: `t-${commits.join()}-${outcome}`, files: [], failures: [] },
  attempts: [],
  outcome,
  branch: 'cq/fix/static/x',
  commits,
});

/** A fixed row carrying the given verified commit SHAs. */
const fixedTask = (id: string, sha: string): FixTaskReport => ({
  task: { id, files: [], failures: [] },
  attempts: [],
  outcome: 'fixed',
  branch: 'cq/fixture/tests-1/scratch-repo',
  ...(sha ? { commits: [sha] } : { commits: [] }),
});

/** An outstanding row that never verified anything (its attempt SHAs are failed evidence). */
const openTask = (id: string, failedShas: string[]): FixTaskReport => ({
  task: { id, files: [], failures: [] },
  attempts: failedShas.map((sha) => ({
    tier: 'worker' as const,
    attempt: 1,
    invocation: 'edit' as const,
    model: { provider: 'fixture', model: 'scripted' },
    reason: 'failed attempt',
    stopReason: 'complete' as const,
    wallMs: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    ...(sha ? { failedAttempt: { branch: 'cq/fixture/failed/a1', sha } } : {}),
  })),
  outcome: 'escalated-to-human',
  branch: 'cq/fixture/tests-1/scratch-repo',
  commits: [],
});

const emptyFailureSet = () => ({ tool: 'vitest', failures: [], exitCode: 0, numTotalTests: 0 });

describe('M1 verified-commit evidence', () => {
  test('M1 nominal evidence', () => {
    expect(fixesPerRunOf([task('fixed', ['abc123']), task('fixed', ['abc123'])])).toBe(1);
    expect(fixesPerRunOf([task('fixed', ['abc']), task('fixed', ['def'])])).toBe(2);
  });

  test('M1 missing evidence', () => {
    // The #419 sibling fixed/no-commit row resolves nothing; a non-fixed row
    // contributes nothing even when attempt evidence carries SHAs.
    expect(
      fixesPerRunOf([
        task('fixed', ['abc']),
        task('fixed', []),
        task('unfixed', []),
        task('escalated-to-human', []),
      ]),
    ).toBe(1);
  });

  test('M1 failure evidence', () => {
    // A failed run's tasks (attempted, nothing verified) count zero, and a
    // todo/never-attempted row is not distinguishable from evidence here: at
    // the FixTaskReport layer only fixed outcomes with commit SHAs count.
    expect(fixesPerRunOf([task('unfixed', []), task('unfixed', ['dropped'])])).toBe(0);
  });
});

describe('fix.run composition context', () => {
  test('a CLI-style direct invocation gives the inner worker plan its own governed job context', async () => {
    let seenJob: string | undefined;
    const worker: Op<unknown, unknown> = async () => {
      seenJob = currentJobContext()?.info.jobKey;
      return { status: 'ok', value: 'worker ran' };
    };
    const entry = {
      name: 'fixture.worker',
      inputSchema: z.object({}).strict(),
      importer: async () => worker,
    } as unknown as OpRegistryEntry<never, never>;
    const registry: OpRegistryView = { get: () => entry };
    expect(currentJobContext()).toBeUndefined();
    const report = await runPlan(
      { id: 'fix-run-context', jobs: [{ id: 'task', op: entry.name, input: {} }] },
      { concurrency: 1, stopOnError: false },
      registry,
      { governor: createGovernor({ maxTokens: 100 }), allowAdvisory: true },
    );
    expect(report.jobs[0]?.result).toEqual({ status: 'ok', value: 'worker ran' });
    expect(seenJob).toBe('task');
    expect(currentJobContext()).toBeUndefined();
  });
});

describe('M1 fix.run metrics through the real composition', () => {
  vi.setConfig({ testTimeout: 30_000 });

  let gitleaks: Awaited<ReturnType<typeof makeGitleaksFixture>>;
  beforeEach(async () => {
    gitleaks = await makeGitleaksFixture();
    vi.stubEnv('PATH', gitleaks.path);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(gitleaks.root, { recursive: true, force: true });
  });

  const exec = promisify(execFile);
  const git = async (cwd: string, ...args: string[]) =>
    (
      await exec('git', ['-C', cwd, ...args], { env: scrubbedGitEnv(), timeout: 10_000 })
    ).stdout.trim();

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'cq-fix-m1-'));
    const repo = join(root, 'repo');
    await generateScratchRepo(repo);
    await mkdir(join(repo, 'cases'));
    for (const name of ['a', 'b'])
      await writeFile(
        join(repo, 'cases', `${name}.test.cjs`),
        'module.exports = { actual: 1, expected: 2 };\n',
      );
    await writeFile(
      join(repo, 'scripts', 'tests.cjs'),
      `
const names = process.argv.slice(2).filter(x => x !== '--');
const files = names.length ? names : require('node:fs').readdirSync('cases').filter(n => n.endsWith('.test.cjs')).sort().map(n => 'cases/' + n);
let failed = false;
const testResults = files.map(name => {
 const { actual, expected } = require(require('node:path').resolve(name));
 const passes = actual === expected;
 failed ||= !passes;
 return { name: require('node:path').resolve(name), status: passes ? 'passed' : 'failed', assertionResults: [{fullName: name, status: passes ? 'passed' : 'failed', failureMessages: passes ? [] : ['expected ' + expected + ', received ' + actual]}] };
});
console.log(JSON.stringify({success: !failed, numTotalTests: files.length, testResults}));
process.exitCode = failed ? 1 : 0;
`,
    );
    await writeFile(
      join(repo, 'cq.json'),
      JSON.stringify({
        schemaVersion: 2,
        checks: [
          {
            kind: 'tests',
            adapter: 'vitest-json',
            command: { command: process.execPath, args: ['scripts/tests.cjs'] },
            relatedArgs: ['scripts/tests.cjs', '{files}'],
          },
        ],
        roles: { worker: { provider: 'fixture', model: 'scripted' } },
        budgets: { run: { maxTokens: 1000 } },
      }),
    );
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'seed failing tests');
    return { root, repo, journalDir: join(root, 'journal') };
  }

  const input = (f: Awaited<ReturnType<typeof fixture>>) => ({
    repoRoot: f.repo,
    source: 'tests' as const,
    selector: { mode: 'workspace-all' as const },
    journalDir: f.journalDir,
    runPrefix: 'cq/fixture',
  });
  const reportOf = (result: Awaited<ReturnType<ReturnType<typeof makeFixRun>>>) =>
    result.status === 'ok' ? result.value : (result.report as FixRunReport);

  /** One driver that fixes everything; one that fixes only a.test.cjs. */
  const fixingDrivers = (skipB: boolean): DriverFactory => ({
    resolve: ({ modelSpec }) => ({
      modelSpec,
      lane: 'ai-sdk',
      driver: {
        run: async (invocation) => {
          if (!invocation.workspace) throw new Error('fixture requires a workspace');
          const line = invocation.prompt.split('\n').find((line) => line.startsWith('Task: '));
          const taskRow = JSON.parse(line?.slice(6) ?? '{}') as { files: string[] };
          for (const file of taskRow.files)
            if (!(skipB && file.includes('b.test')))
              await writeFile(
                join(invocation.workspace.path, file),
                'module.exports = { actual: 1, expected: 1 };\n',
              );
          return {
            stopReason: 'complete',
            denials: [],
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            structuredOutput: {
              outcome: 'broken-test',
              summary: 'correct fixture expectation',
              confidence: 0.8,
            },
          };
        },
      },
    }),
  });

  /**
   * Registry entries stubbing BOTH sweep ops: the planner (returning one unit
   * so the plan fans out a single unit job) and the unit op (returning the
   * pre-canned FixTaskReport evidence).
   */
  const stubSweepRegistries = (unitReport: SweepUnitReport) => {
    const unitJob = {
      id: 'fixture-unit',
      op: 'sweep.unit',
      input: { package: 'scratch-repo', fixer: 'tests-1', files: [] },
      dependsOn: [],
    };
    const planEntry = {
      name: 'sweep.planSweep',
      inputSchema: z.unknown(),
      importer:
        async () =>
        // The composition pins the planner's fan-out, so the stub must return
        // the same shape a real plan would (one unit job + its unit).
        async () => ({
          status: 'ok' as const,
          value: { jobs: [unitJob], units: [unitJob.input], suppressed: [], needsHuman: [] },
        }),
    } as unknown as OpRegistryEntry<never, never>;
    const unitEntry = {
      name: 'sweep.unit',
      inputSchema: z.unknown(),
      importer: async () => async () => ({ status: 'ok' as const, value: unitReport }),
    } as unknown as OpRegistryEntry<never, never>;
    const entries = new Map([
      [planEntry.name, planEntry],
      [unitEntry.name, unitEntry],
    ]);
    return (name: string): OpRegistryEntry<never, never> | undefined => entries.get(name);
  };

  /**
   * The shared-SHA unit evidence: two fixed rows resolving with ONE commit SHA,
   * a duplicate-SHA pair, a sibling fixed/no-commit row and an outstanding row
   * whose attempt evidence carries SHAs. Distinct verified SHAs = 2 while the
   * old task-count formula reads 4, so either finish-path write reverting to
   * the old formula (or being deleted) fails these composition assertions.
   */
  const sharedUnitReport = (): SweepUnitReport => {
    const sha = 'a'.repeat(40);
    const other = 'b'.repeat(40);
    return {
      package: 'scratch-repo',
      fixer: 'tests-1',
      worktree: {
        path: join('tmp', 'worktree'),
        branch: 'cq/fixture/tests-1/scratch-repo',
        requestedBase: 'HEAD',
        reused: false,
        clearedBaselineCaches: [],
        refusedBaselineCaches: [],
      },
      mode: 'fix',
      baseline: { verdict: 'failing', attempts: 1, failureSet: emptyFailureSet() },
      final: { verdict: 'failing', attempts: 1, failureSet: emptyFailureSet() },
      prBranch: 'cq/fixture/tests-1/scratch-repo',
      tasks: [
        fixedTask('cases/a.test.cjs', sha),
        fixedTask('cases/b.test.cjs', sha),
        fixedTask('cases/c.test.cjs', other),
        fixedTask('cases/c.test.cjs', other),
        fixedTask('cases/d.test.cjs', ''),
        openTask('cases/e.test.cjs', [other]),
      ],
    };
  };

  test('M1 nominal evidence through fix.run composition', async () => {
    const f = await fixture();
    try {
      const result = await makeFixRun({
        drivers: fixingDrivers(false),
        registry: { get: stubSweepRegistries(sharedUnitReport()) },
      })({
        ...input(f),
        // The stubbed unit returns an outstanding row, so the run ends
        // needs-human: this exercises the needs-human terminal write.
      });
      expect(result.status).toBe('needs-human');
      // The needs-human terminal path itself wrote the persisted report;
      // assert the metric on it.
      const report = reportOf(result);
      expect(report.fixesPerRun).toBe(2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('M1 missing evidence through fix.run composition', async () => {
    const f = await fixture();
    try {
      // Same shared-SHA evidence through the PR-assembly leg: the open row
      // fails the run, but the assembly-path accounting pass also re-derives
      // the metric from the shared-SHA evidence: 2, not 4 or 5.
      const result = await makeFixRun({
        drivers: fixingDrivers(true),
        registry: { get: stubSweepRegistries(sharedUnitReport()) },
      })({
        ...input(f),
        pr: true,
      });
      expect(result.status).toBe('needs-human');
      const report = reportOf(result);
      expect(report.fixesPerRun).toBe(2);
      expect(report.counters.fixed).toBe(4);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('M1 failure evidence through fix.run composition', async () => {
    const f = await fixture();
    try {
      // The early-finish leg of the persisted-artifact path: no tasks, so
      // the metric must read 0 (a stale or deleted assignment cannot fake
      // this, since the report is written before any unit ran).
      const failed = await makeFixRun({ drivers: fixingDrivers(false) })({
        ...input(f),
        repoRoot: f.root,
      });
      expect(failed.status).not.toBe('ok');
      expect(failed.report?.fixesPerRun).toBe(0);
      expect(failed.report?.tasks).toHaveLength(0);

      // The ok leg of the same persisted path with the shared-SHA evidence:
      // distinctness is asserted through the composition (2, not 4).
      const ok = await makeFixRun({
        drivers: fixingDrivers(false),
        registry: {
          get: stubSweepRegistries({
            ...sharedUnitReport(),
            tasks: (sharedUnitReport().tasks ?? []).filter(
              (row): row is FixTaskReport => row.outcome === 'fixed',
            ),
          }),
        },
      })(input(f));
      expect(ok.status).toBe('ok');
      const report = reportOf(ok);
      expect(report.verdict).toBe('pass');
      expect(report.fixesPerRun).toBe(2);
      expect(report.fixesPerRun !== undefined).toBe(true);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
