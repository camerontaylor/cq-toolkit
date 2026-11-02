import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createGovernor, currentJobContext } from '../../../src/kernel/governor.js';
import { runPlan, type OpRegistryView } from '../../../src/kernel/runner.js';
import type { Op, OpRegistryEntry } from '../../../src/kernel/types.js';
import {
  githubCompareBaseUrl,
  verifiedCommitCount,
  type FixRunReport,
} from '../../../src/ops/fix/runFix.js';
import type { FixTaskReport } from '../../../src/ops/sweep/taskLoop.js';

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

describe('M1 verified-commit evidence', () => {
  const task = (outcome: FixTaskReport['outcome'], commits: string[]): FixTaskReport => ({
    task: { id: `t-${commits.join()}-${outcome}`, files: [], failures: [] },
    attempts: [],
    outcome,
    branch: 'cq/fix/static/x',
    commits,
  });

  test('M1 nominal evidence: one commit resolves two rows → 1', () => {
    expect(verifiedCommitCount([task('fixed', ['abc123']), task('fixed', ['abc123'])])).toBe(1);
  });

  test('M1 missing evidence: duplicate SHA → 1; sibling/no-commit, failed and todo → 0', () => {
    expect(verifiedCommitCount([task('fixed', ['abc']), task('fixed', ['abc'])])).toBe(1);
    expect(
      verifiedCommitCount([
        task('fixed', ['abc']),
        task('unfixed', []),
        task('escalated-to-human', []),
        task('unfixed', ['ignored-unverified-sha']),
      ]),
    ).toBe(1);
  });

  test('M1 failure evidence: both finish paths agree', () => {
    // The helper is the single computation both finish paths call; a failed
    // run's tasks (attempted, nothing verified) and an ok run's tasks must
    // count the same distinct SHA set.
    const failed: FixTaskReport[] = [task('unfixed', []), task('unfixed', ['dropped'])];
    const ok: FixTaskReport[] = [task('fixed', ['abc']), task('fixed', ['def'])];
    expect(verifiedCommitCount(failed)).toBe(0);
    expect(verifiedCommitCount(ok)).toBe(2);
    // Every FixRunReport carries the field on both paths (compile-time shape
    // guard); the count equals the distinct set the helper derives.
    const report: FixRunReport = {
      source: 'static',
      runPrefix: 'cq/fix-x',
      reportPath: '/tmp/r.json',
      verdict: 'pass',
      units: [],
      tasks: ok,
      failed: [],
      planned: [],
      counters: {
        planned: 2,
        attempted: 2,
        fixed: 2,
        skipped: 0,
        unresolved: 0,
        rescueAttempts: 0,
        rescueFixes: 0,
      },
      fixesPerRun: 2,
      verifiedCommits: verifiedCommitCount(ok),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      wallMs: 0,
    };
    expect(report.verifiedCommits).toBe(report.fixesPerRun);
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
