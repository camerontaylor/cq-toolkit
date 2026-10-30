import { describe, expect, it } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { makeTestRepo, repoEffects } from '../dev/repo.js';

const noDriver: DriverFactory = {
  resolve: () => {
    throw new Error('unexpected driver');
  },
};

describe('review.run usage envelope', () => {
  it('attaches an empty summary to a pre-dispatch refusal', async () => {
    const repo = await makeTestRepo();
    try {
      const result = await makeReviewRun({ drivers: noDriver })({ repoRoot: repo.root });
      expect(result).toEqual({
        status: 'needs-human',
        reason: 'review.run: cq.json is required',
        usageSummary: { knownCount: 0, unknownCount: 0, unpricedCount: 0 },
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('retains mixed engine counts when the attempt log fails after review settlement', async () => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          roles: { reviewer: { provider: 'mock', model: 'mock' } },
          budgets: { run: { maxTokens: 500 } },
          review: { reviewers: ['agent'] },
        }),
      );
      repo.commitAll('usage fixture');
      const effects = repoEffects(repo, () => undefined, {
        writeReviewLog: async () => {
          throw new Error('log unavailable');
        },
      });
      const result = await makeReviewRun({
        drivers: noDriver,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map(({ component }) => ({ component, hits: [] })),
        runAgentReviewer: async () => ({
          status: 'needs-human',
          reason: 'fixture engine blocked',
          report: {
            findings: [],
            usage: 12,
            usageSummary: {
              usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0 },
              costUSD: 0.02,
              knownCount: 2,
              unknownCount: 1,
              unpricedCount: 2,
            },
            coverage: {} as never,
            advisories: [],
            limitations: [],
          },
        }),
      })({ repoRoot: repo.root });
      expect(result).toMatchObject({
        status: 'indeterminate',
        detail: expect.stringContaining('log unavailable') as unknown,
        usageSummary: {
          usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0 },
          costUSD: 0.02,
          knownCount: 2,
          unknownCount: 1,
          unpricedCount: 2,
        },
      });
    } finally {
      await repo.cleanup();
    }
  });
  it('folds an engine summary whose usage was unmeasured without inventing a measurement', async () => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          roles: { reviewer: { provider: 'mock', model: 'mock' } },
          budgets: { run: { maxTokens: 500 } },
          review: { reviewers: ['agent'] },
        }),
      );
      repo.commitAll('unmeasured fixture');
      const effects = repoEffects(repo, () => undefined, {
        writeReviewLog: async () => {
          throw new Error('log unavailable');
        },
      });
      const result = await makeReviewRun({
        drivers: noDriver,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map(({ component }) => ({ component, hits: [] })),
        runAgentReviewer: async () => ({
          status: 'needs-human',
          reason: 'fixture engine blocked',
          report: {
            findings: [],
            usage: 0,
            usageSummary: { knownCount: 0, unknownCount: 1, unpricedCount: 1 },
            coverage: {} as never,
            advisories: [],
            limitations: [],
          },
        }),
      })({ repoRoot: repo.root });
      expect(result).toMatchObject({
        status: 'indeterminate',
        usageSummary: { knownCount: 0, unknownCount: 1, unpricedCount: 1 },
      });
      expect(result.usageSummary).not.toHaveProperty('usage');
      expect(result.usageSummary).not.toHaveProperty('costUSD');
    } finally {
      await repo.cleanup();
    }
  });
});
