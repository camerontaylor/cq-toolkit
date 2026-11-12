// Split provenance: test/ops/fix/runFix.test.ts was split by subject into
// runFix.compare-links.test.ts, runFix.fixes-per-run.test.ts,
// runFix.composition-context.test.ts, runFix.composition-metrics.test.ts
// (this file), runFix.pr-base.test.ts and runFix.atomic-report.test.ts.
// This file keeps the real-composition metrics cases (M1 verified-commit,
// M7-fix retained spend, additive reasoning) with their shared fixture surface.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { currentJobContext } from '../../../src/kernel/governor.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { makeFixRun, type FixRunReport } from '../../../src/ops/fix/runFix.js';
import type { FixTaskReport } from '../../../src/ops/sweep/taskLoop.js';
import type { SweepUnitReport } from '../../../src/ops/sweep/unit.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { generateScratchRepo } from '../../fixtures/scratch-repo/generate.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';

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
      // ADR-0005 decision 10: the persisted report writer always writes v1.
      expect(report.version).toBe(1);
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
   * A driver whose dispatches meter real governed usage and then throw a
   * fault AFTER settlement, carrying the settled usage on the rejection
   * (#1195): the thrown attempt row records it, and the engine's once-only
   * rollup folds the spend exactly once from the surviving row evidence —
   * never a double fold with the governed ledger that metered the same
   * dispatch.
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
      // A fault thrown AFTER settlement with the settled usage attached to
      // the rejection (#1195): governed metering observed the dispatch spend,
      // and the failed report retains it exactly once.
      const result = await makeFixRun({ drivers: meterThenFaultDriver() })(input(f));
      // A thrown dispatch folds to needs-human (a misconfiguration-class
      // ending), which still flows through finish(). The fixture repo has
      // four tasks, so the fault metered four governed dispatches: the
      // report retains exactly that spend once.
      expect(result.status).toBe('needs-human');
      expect(result.report?.usage).toEqual({
        input: 28,
        output: 12,
        cacheRead: 8,
        cacheWrite: 4,
      });
      // Settled exactly once (#1195): every thrown attempt row now carries
      // the rejection's settled usage (four rows, one {7,3,2,1} each), and
      // the rollup above still folds 28/12/8/4 — the once-only fold reads
      // the surviving row evidence without double-counting the governed
      // ledger that metered the same dispatches.
      const usageRows = result.report?.tasks.flatMap((task) =>
        (task.attempts ?? []).filter((attempt) => attempt.usage !== undefined),
      );
      expect(usageRows).toHaveLength(4);
      for (const attempt of usageRows ?? [])
        expect(attempt.usage).toEqual({ input: 7, output: 3, cacheRead: 2, cacheWrite: 1 });
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
      // The bare rejection carries no usage attachment (#1195's no-usage
      // twin): no thrown attempt row invents a measurement.
      expect(
        result.report?.tasks.flatMap((task) =>
          (task.attempts ?? []).filter((attempt) => attempt.usage !== undefined),
        ),
      ).toHaveLength(0);
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
      // additive reasoning: the settled usage rides the surviving attempt
      // rows too (#1195), and the report retains the reasoning sum exactly
      // once.
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
