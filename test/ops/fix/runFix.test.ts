import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
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
  resolveFixPrBase,
  writeAtomicFixReport,
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

  test('install hook reaches isolated unit jobs without implicit installation', async () => {
    const f = await fixture();
    const received: unknown[] = [];
    const unitEntry = {
      name: 'sweep.unit',
      inputSchema: z.unknown(),
      importer: async () => async (raw: { install?: unknown }) => {
        received.push(raw.install);
        return { status: 'ok' as const, value: sharedUnitReport() };
      },
    } as unknown as OpRegistryEntry<never, never>;
    const install = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
    try {
      for (const hook of [undefined, install]) {
        await makeFixRun({
          registry: { get: (name) => (name === 'sweep.unit' ? unitEntry : undefined) },
        })({
          ...input(f),
          ...(hook === undefined ? {} : { install: hook }),
        });
      }
      expect(received).toEqual([undefined, install]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
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
   * The shared-SHA unit evidence: two fixed rows resolving with ONE commit
   * SHA, a duplicate-SHA pair, a sibling fixed/no-commit row and an
   * outstanding row whose attempt evidence carries SHAs. Distinct verified
   * SHAs = 2 while the old task-count formula reads 5 (five fixed rows,
   * one of them commit-less), so reverting the observable finish() write to
   * the old formula fails these composition assertions.
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
      await git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      await git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      // Seed a committed marker under the run-state dir so the pr:true leg
      // reaches real assembly bookkeeping (marker read + package matching),
      // with the tracker/assemble ops stubbed so no forge is contacted.
      const segments = { kind: 'tests-1', slug: 'scratch-repo' };
      const markerDir = join(f.journalDir, 'state', 'committed', segments.kind);
      await mkdir(markerDir, { recursive: true });
      await writeFile(
        join(markerDir, `${segments.slug}.json`),
        `${JSON.stringify({
          package: 'scratch-repo',
          fixer: 'tests-1',
          branch: `cq/fixture/${segments.kind}/${segments.slug}`,
        })}\n`,
      );
      const assembled: unknown[] = [];
      const forgeStub = (name: string) =>
        ({
          name,
          inputSchema: z.unknown(),
          importer: async () => async (raw: unknown) => {
            assembled.push({ name, raw });
            return { status: 'ok' as const, value: { offline: true } };
          },
        }) as unknown as OpRegistryEntry<never, never>;
      const sweep = stubSweepRegistries(sharedUnitReport());
      const result = await makeFixRun({
        drivers: fixingDrivers(true),
        registry: {
          get: (name) =>
            name === 'pr.ensureTrackerBranch' || name === 'pr.assemblePrs'
              ? forgeStub(name)
              : sweep(name),
        },
      })({
        ...input(f),
        pr: true,
      });
      expect(result.status).toBe('needs-human');
      // The assembly leg actually ran over the seeded marker.
      expect(assembled.map((entry) => (entry as { name: string }).name)).toContain(
        'pr.assemblePrs',
      );
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
      // the metric reads the initializer 0. This pins the empty-task path
      // behavior (0, never a fabricated count).
      const failed = await makeFixRun({ drivers: fixingDrivers(false) })({
        ...input(f),
        repoRoot: f.root,
      });
      expect(failed.status).not.toBe('ok');
      expect(failed.report?.fixesPerRun).toBe(0);
      expect(failed.report?.tasks).toHaveLength(0);

      // The ok leg of the same persisted path with the shared-SHA evidence:
      // distinctness is asserted through the composition (2, not the old
      // formula's 5).
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
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  // ---- M7-fix: retain fix exit spend -------------------------------------
  // finish() folds landed attempt evidence, then adopts the runner's
  // once-only usage rollup when the engine produced one: the rollup is the
  // fold of every metered dispatch (attempt usage plus metered faults that
  // left no surviving attempt evidence), so settled usage is preserved once
  // in full and partial evidence is never dropped. Absence stays explicit
  // (no rollup and no attempt usage: zeros, never a fabricated
  // measurement). Every named case runs through makeFixRun.

  /**
   * A driver whose dispatches meter real governed usage but never leave
   * surviving attempt evidence: it throws a fault after settlement, so the
   * unit folds to a rejected result with no FixTaskReport attempts. The
   * engine's ledger is the only carrier that observed the spend.
   */
  const meterThenFaultDriver = (): DriverFactory => ({
    resolve: ({ modelSpec }) => ({
      modelSpec,
      lane: 'ai-sdk',
      driver: {
        run: async () => {
          const usage = { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 };
          currentJobContext()?.reportResult({ usage });
          const error = new Error('fixture: dispatch fault after settlement') as Error & {
            usage?: typeof usage;
          };
          error.usage = usage;
          throw error;
        },
      },
    }),
  });

  /** A driver whose dispatches are never metered at all. */
  const silentFaultDriver = (): DriverFactory => ({
    resolve: ({ modelSpec }) => ({
      modelSpec,
      lane: 'ai-sdk',
      driver: {
        run: async () => {
          throw new Error('fixture: unmetered fault');
        },
      },
    }),
  });

  /** Like meterThenFaultDriver, but the metered usage carries ADDITIVE reasoning. */
  const reasoningFaultDriver = (): DriverFactory => ({
    resolve: ({ modelSpec }) => ({
      modelSpec,
      lane: 'ai-sdk',
      driver: {
        run: async () => {
          const usage = { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, reasoning: 4 };
          currentJobContext()?.reportResult({ usage });
          const error = new Error('fixture: dispatch fault after settlement') as Error & {
            usage?: typeof usage;
          };
          error.usage = usage;
          throw error;
        },
      },
    }),
  });

  test('M7-fix nominal evidence', async () => {
    const f = await fixture();
    try {
      // A fault thrown AFTER settlement: governed metering still observed
      // the dispatch spend, so the failed report retains it via the engine
      // ledger instead of the zeroed attempt fold.
      const result = await makeFixRun({ drivers: meterThenFaultDriver() })(input(f));
      // A thrown dispatch folds to needs-human (a misconfiguration-class
      // ending), which still flows through finish(). The fixture repo has
      // four tasks, so the fault metered four governed dispatches: the
      // ledger retains exactly that spend once.
      expect(result.status).toBe('needs-human');
      expect(result.report?.usage).toEqual({
        input: 28,
        output: 12,
        cacheRead: 8,
        cacheWrite: 4,
      });
      // Settled exactly once through the runner rollup: the surviving attempt
      // rows carry NO usage (the driver threw before returning a
      // measurement), so the report's spend comes solely from the ledger,
      // never double folded.
      expect(
        result.report?.tasks.flatMap((task) =>
          (task.attempts ?? []).filter((attempt) => attempt.usage !== undefined),
        ),
      ).toHaveLength(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('M7-fix missing evidence', async () => {
    const f = await fixture();
    try {
      // A fault that never metered anything: the ledger is absent and the
      // attempt fold is empty, so the report keeps explicit zeros rather
      // than inventing a measurement.
      const result = await makeFixRun({ drivers: silentFaultDriver() })(input(f));
      expect(result.status).toBe('needs-human');
      expect(result.report?.usage).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      expect(result.report?.run?.usage).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('M7-fix failure evidence', async () => {
    const f = await fixture();
    try {
      // Mixed evidence: the canned unit's open row lands one usage-bearing
      // attempt {1,1,0,0} in the attempt fold, and the unit op also meters a
      // DISTINCT {5,5,0,0} dispatch through the governed reportResult seam
      // (spend that never survived as attempt evidence, a killed/replaced
      // dispatch). The report adopts the runner's once-only rollup {5,5,0,0}
      // — never the attempt fold alone (which would drop the metered fault)
      // and never a double count of the two carriers.
      const unitJob = {
        id: 'fixture-unit',
        op: 'sweep.unit',
        input: { package: 'scratch-repo', fixer: 'tests-1', files: [] },
        dependsOn: [],
      };
      const planEntry = {
        name: 'sweep.planSweep',
        inputSchema: z.unknown(),
        importer: async () => async () => ({
          status: 'ok' as const,
          value: { jobs: [unitJob], units: [unitJob.input], suppressed: [], needsHuman: [] },
        }),
      } as unknown as OpRegistryEntry<never, never>;
      const unitEntry = {
        name: 'sweep.unit',
        inputSchema: z.unknown(),
        importer: async () => async () => {
          currentJobContext()?.reportResult({
            usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
          });
          return { status: 'ok' as const, value: sharedUnitReport() };
        },
      } as unknown as OpRegistryEntry<never, never>;
      const entries = new Map([
        [planEntry.name, planEntry],
        [unitEntry.name, unitEntry],
      ]);
      const result = await makeFixRun({
        drivers: fixingDrivers(false),
        registry: { get: (name) => entries.get(name) },
      })(input(f));
      expect(result.status).toBe('needs-human');
      const report = reportOf(result);
      expect(report.usage).toEqual({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0 });
      expect(report.fixesPerRun).toBe(2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('T-usage reasoning once: the runFix rollup counts additive reasoning once', async () => {
    const f = await fixture();
    try {
      // Regression guard for the additive-once contract: the attempt fold
      // (runFix.ts:289) already summed `reasoning` before the kernel folds
      // were fixed, and the ledger adoption (report.usage = report.run?.usage)
      // carries it once either way. A fault thrown after settlement carrying
      // additive reasoning: the ledger is the only carrier, and the report
      // retains the reasoning sum exactly once.
      // Four governed dispatches metered, so reasoning sums to 4×4 = 16.
      const result = await makeFixRun({ drivers: reasoningFaultDriver() })(input(f));
      expect(result.status).toBe('needs-human');
      expect(result.report?.usage).toEqual({
        input: 28,
        output: 12,
        cacheRead: 8,
        cacheWrite: 4,
        reasoning: 16,
      });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

test('PR base resolves the remote default, explicit branches and upstream; refuses revisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-pr-base-'));
  const git = async (...args: string[]) =>
    promisify(execFile)('git', ['-C', root, ...args], { env: scrubbedGitEnv() });
  try {
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Fixture');
    await git('config', 'user.email', 'fixture@invalid');
    await git('commit', '--allow-empty', '-m', 'baseline');
    expect(await resolveFixPrBase(root)).toBeUndefined();
    await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    await git('update-ref', 'refs/remotes/origin/release', 'HEAD');
    await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    expect(await resolveFixPrBase(root)).toBe('main');
    expect(await resolveFixPrBase(root, 'release')).toBe('release');
    expect(await resolveFixPrBase(root, 'origin/release')).toBe('release');
    expect(await resolveFixPrBase(root, 'HEAD~1')).toBeUndefined();
    await git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    await git('config', 'remote.origin.url', '.');
    await git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    await git('config', 'branch.main.remote', 'origin');
    await git('config', 'branch.main.merge', 'refs/heads/main');
    expect(await resolveFixPrBase(root)).toBe('main');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('atomic report replaces complete files and cleans up failed replacements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-atomic-report-'));
  try {
    const path = join(root, 'report.json');
    await writeFile(path, 'previous');
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(writeAtomicFixReport(path, cyclic)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('previous');
    await writeAtomicFixReport(path, { complete: true });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ complete: true });
    const directory = join(root, 'blocked');
    await mkdir(directory);
    await writeFile(join(directory, 'previous'), 'preserved');
    await expect(writeAtomicFixReport(directory, {})).rejects.toThrow();
    expect(await readFile(join(directory, 'previous'), 'utf8')).toBe('preserved');
    expect((await readdir(root)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
