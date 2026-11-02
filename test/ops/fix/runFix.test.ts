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

  test('M1 nominal evidence', async () => {
    const f = await fixture();
    try {
      const result = await makeFixRun({ drivers: fixingDrivers(false) })(input(f));
      expect(result.status, JSON.stringify(result)).toBe('ok');
      const report = reportOf(result);
      expect(report.tasks.map((taskRow) => taskRow.outcome)).toEqual(['fixed', 'fixed']);
      expect(report.tasks.flatMap((taskRow) => taskRow.commits)).toHaveLength(2);
      expect(report.fixesPerRun).toBe(2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('M1 missing evidence', async () => {
    const f = await fixture();
    try {
      // Only a.test.cjs is fixed; b stays failing (no rescue role), so one
      // row is fixed with one commit, the sibling row carries no verified
      // evidence, and the run ends needs-human. The metric still reads 1.
      const result = await makeFixRun({ drivers: fixingDrivers(true) })(input(f));
      expect(result.status).toBe('needs-human');
      const report = reportOf(result);
      expect(report.tasks.filter((taskRow) => taskRow.outcome === 'fixed')).toHaveLength(1);
      expect(report.tasks.flatMap((taskRow) => taskRow.commits)).toHaveLength(1);
      expect(report.fixesPerRun).toBe(1);
      expect(report.counters.fixed).toBe(1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('M1 failure evidence', async () => {
    const f = await fixture();
    try {
      // Both finish paths run the same fixesPerRunOf computation: the
      // failed/needs-human persisted path (cancelled before dispatch) and the
      // ok persisted path must agree that no verified commits means 0, and
      // this read fails if either path stops assigning the metric.
      const cancelled = await makeFixRun({ drivers: fixingDrivers(false) })({
        ...input(f),
        // repoRoot without cq.json forces an early finish leg of the
        // persisted-artifact path with no tasks.
        repoRoot: f.root,
      });
      expect(cancelled.status).not.toBe('ok');
      expect(cancelled.report?.fixesPerRun).toBe(0);
      expect(cancelled.report?.tasks).toHaveLength(0);

      const ok = await makeFixRun({ drivers: fixingDrivers(false) })(input(f));
      expect(ok.status, JSON.stringify(ok)).toBe('ok');
      const report = reportOf(ok);
      expect(report.verdict).toBe('pass');
      expect(report.fixesPerRun).toBe(2);
      expect(report.tasks.flatMap((taskRow) => taskRow.commits)).toHaveLength(2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
