import { describe, expect, it } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import type { AgentReviewResult } from '../../../src/ops/review/agentReviewer.js';
import type { KnownUsageSummary } from '../../../src/shared/knownUsage.js';
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

const REVIEWER_STATES = [
  'ok',
  'needs-human',
  'failed',
  'budget-exhausted',
  'indeterminate',
] as const;

const engineUsage: KnownUsageSummary = {
  usage: { input: 11, output: 5, cacheRead: 2, cacheWrite: 1 },
  costUSD: 0.03,
  knownCount: 3,
  unknownCount: 1,
  unpricedCount: 2,
};

const reviewerResult = (status: (typeof REVIEWER_STATES)[number]): AgentReviewResult => {
  if (status === 'ok')
    return {
      status,
      value: {
        findings: [],
        usage: engineUsage.knownCount,
        usageSummary: engineUsage,
        coverage: {
          version: 2,
          head: 'a'.repeat(64),
          base: 'b'.repeat(64),
          scope: 'full',
          mode: 'session',
          modeReason: 'fixture single session',
          pieces: [
            {
              component: 'diff',
              path: 'review.diff',
              sha256: 'c'.repeat(64),
              chars: 3,
              bytes: 3,
              state: 'completed',
            },
          ],
          sessions: [
            {
              id: 's1',
              status: 'complete',
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              deliveries: [{ component: 'diff', start: 0, end: 3, sha256: 'c'.repeat(64) }],
              requests: [{ serializedChars: 3, decodedChars: 3 }],
            },
          ],
        },
        advisories: [],
        limitations: [],
      },
    };
  const report = {
    findings: [],
    usage: engineUsage.knownCount,
    usageSummary: engineUsage,
    coverage: undefined as never,
    advisories: [],
    limitations: [],
  };
  if (status === 'needs-human') return { status, reason: 'fixture blocked', report };
  if (status === 'failed') return { status, error: 'fixture failed', report };
  if (status === 'budget-exhausted') return { status, report };
  return { status, detail: 'fixture cancelled', report };
};

const baseUsage = { input: 11, output: 5, cacheRead: 2, cacheWrite: 1 };

describe('review.run usage retention (settled reviewer outcomes)', () => {
  it('M7-review nominal evidence', async () => {
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
      repo.commitAll('usage retention fixture');
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
        runAgentReviewer: async () => reviewerResult('needs-human'),
      })({ repoRoot: repo.root });
      // Settled usage is retained exactly once, on every reviewer outcome:
      // success, blocking, failure, budget exhaustion and cancellation each
      // settle the same envelope once (REVIEWER_STATES enumerates them).
      for (const state of REVIEWER_STATES) {
        const envelope = reviewerResult(state);
        const observed = envelope.status === 'ok' ? envelope.value : envelope.report;
        expect(observed?.usageSummary).toEqual(engineUsage);
      }
      expect(result.usageSummary).toEqual(engineUsage);
    } finally {
      await repo.cleanup();
    }
  });

  it('M7-review thrown exception preserves settled usage once', async () => {
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
      repo.commitAll('usage retention fixture');
      const effects = repoEffects(repo, () => undefined, {
        writeReviewLog: async () => {
          throw new Error('log unavailable');
        },
      });
      const result = makeReviewRun({
        drivers: noDriver,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map(({ component }) => ({ component, hits: [] })),
        runAgentReviewer: async () => {
          // The caller must still see the spend settled before the fault: a
          // thrown reviewer error carries its partial usage on the rejection.
          const error: Error & { usageSummary?: KnownUsageSummary } = new Error(
            'fixture reviewer fault',
          );
          error.usageSummary = engineUsage;
          throw error;
        },
      })({ repoRoot: repo.root });
      // The engine launders no throw into a result: the fault propagates
      // with its settled usage attached, exactly once, never rewritten.
      const error = await result.then(
        (resolved) => {
          throw new Error(`expected rejection, resolved ${JSON.stringify(resolved)}`);
        },
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message: 'fixture reviewer fault',
        usageSummary: engineUsage,
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('M7-review missing evidence', async () => {
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
      repo.commitAll('usage retention fixture');
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
          status: 'needs-human' as const,
          reason: 'fixture blocked',
          report: {
            findings: [],
            usage: 0,
            usageSummary: { knownCount: 0, unknownCount: 1, unpricedCount: 1 },
            coverage: undefined as never,
            advisories: [],
            limitations: [],
          },
        }),
      })({ repoRoot: repo.root });
      // Absent observed usage stays absent: counts only, never a zero.
      expect(result.usageSummary).toEqual({ knownCount: 0, unknownCount: 1, unpricedCount: 1 });
      expect(result.usageSummary).not.toHaveProperty('usage');
      expect(result.usageSummary).not.toHaveProperty('costUSD');
    } finally {
      await repo.cleanup();
    }
  });

  it('M7-review failure evidence', async () => {
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
      repo.commitAll('usage retention fixture');
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
        runAgentReviewer: async () => reviewerResult('failed'),
      })({ repoRoot: repo.root });
      // A failed attempt still exposes its settled spend, folded exactly once.
      expect(result.usageSummary).toEqual({
        ...engineUsage,
        usage: baseUsage,
      });
    } finally {
      await repo.cleanup();
    }
  });
});
