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

/** One complete v2 coverage payload for the ok path, bound to a fixture head. */
const okCoverage = (head: string, base: string) => ({
  version: 2,
  head,
  base,
  scope: 'full' as const,
  mode: 'session' as const,
  modeReason: 'fixture single session',
  pieces: [
    {
      component: 'diff',
      path: 'review.diff',
      sha256: 'c'.repeat(64),
      chars: 3,
      bytes: 3,
      state: 'completed' as const,
      sessionId: 's1',
    },
  ],
  sessions: [
    {
      id: 's1',
      status: 'complete' as const,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      deliveries: [{ component: 'diff', start: 0, end: 3, sha256: 'c'.repeat(64) }],
      requests: [{ serializedChars: 3, decodedChars: 3 }],
    },
  ],
});

/** Settled engine spend a reviewer attempt reports on EVERY outcome. */
const childUsage = (): KnownUsageSummary => ({
  usage: { input: 11, output: 5, cacheRead: 2, cacheWrite: 1 },
  costUSD: 0.03,
  knownCount: 3,
  unknownCount: 1,
  unpricedCount: 2,
});

const baseUsage = { input: 11, output: 5, cacheRead: 2, cacheWrite: 1 };

type AgentReviewReportCoverage = AgentReviewResult extends { value: { coverage: infer C } }
  ? C
  : never;

/** Build a settled reviewer result for one OpResult status. */
const reviewerResult = (
  status: AgentReviewResult['status'],
  head?: string,
  base?: string,
): AgentReviewResult => {
  const report = {
    findings: [],
    usage: 3,
    usageSummary: childUsage(),
    coverage: undefined as never,
    advisories: [],
    limitations: [],
  };
  if (status === 'ok')
    return {
      status,
      value: {
        ...report,
        coverage: okCoverage(head!, base!) as AgentReviewReportCoverage,
      },
    };
  if (status === 'needs-human') return { status, reason: 'fixture blocked', report };
  if (status === 'failed') return { status, error: 'fixture failed', report };
  if (status === 'budget-exhausted') return { status, report };
  return { status, detail: 'fixture lost verdict', report };
};

/** Local fixture composition: an agent-only repo whose reviewer is scripted. */
const setupRun = async (
  runAgentReviewer: (
    drivers: DriverFactory,
    input: Parameters<
      typeof import('../../../src/ops/review/agentReviewer.js').runAgentReviewer
    >[1],
  ) => Promise<AgentReviewResult>,
) => {
  const repo = await makeTestRepo();
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
  const effects = repoEffects(repo);
  const run = makeReviewRun({
    drivers: noDriver,
    effectsFactory: () => effects,
    scannerFactory: () => async (components) =>
      components.map(({ component }) => ({ component, hits: [] })),
    runAgentReviewer,
  });
  return { repo, run };
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

describe('review.run usage retention (M7-review)', () => {
  it('M7-review nominal evidence', async () => {
    const { repo, run } = await setupRun(async (_drivers, input) =>
      reviewerResult('ok', input.head, input.base),
    );
    try {
      // A terminal run preserves the child attempt's settled spend exactly
      // once, on the existing envelope carrier.
      const result = await run({ repoRoot: repo.root });
      expect(result.status).toBe('ok');
      expect(result.usageSummary).toEqual(childUsage());
    } finally {
      await repo.cleanup();
    }
  });

  it('M7-review failure evidence', async () => {
    const { repo, run } = await setupRun(async () => reviewerResult('failed'));
    try {
      // A failed attempt still exposes its settled spend, folded exactly once;
      // the failure surfaces with the persisted record, never laundered away.
      const result = await run({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      expect(result.usageSummary).toEqual(childUsage());
      expect(result.usageSummary?.usage).toEqual(baseUsage);
    } finally {
      await repo.cleanup();
    }
  });

  it('M7-review missing evidence', async () => {
    const { repo, run } = await setupRun(async () => ({
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
    }));
    try {
      // Absent observed usage stays absent through the fold: counts only,
      // never a zero or cost invented from counts.
      const result = await run({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      expect(result.usageSummary).toEqual({ knownCount: 0, unknownCount: 1, unpricedCount: 1 });
      expect(result.usageSummary).not.toHaveProperty('usage');
      expect(result.usageSummary).not.toHaveProperty('costUSD');
    } finally {
      await repo.cleanup();
    }
  });

  it.each(['needs-human', 'budget-exhausted', 'indeterminate'] as const)(
    'settles usage once through makeReviewRun on a %s exit',
    async (status) => {
      const { repo, run } = await setupRun(async () => reviewerResult(status));
      try {
        const result = await run({ repoRoot: repo.root });
        expect(result.status).toBe('needs-human');
        expect(result.usageSummary).toEqual(childUsage());
      } finally {
        await repo.cleanup();
      }
    },
  );

  it('parent totals do not double count child usage', async () => {
    // Two child dispatches in one reviewer attempt (two engine summaries);
    // the engine folds the CHILD totals itself, so the outer fold must see
    // one summary per attempt, never per dispatch.
    const { repo, run } = await setupRun(async () => {
      const report = reviewerResult('needs-human').report!;
      const reportB = reviewerResult('needs-human').report!;
      const usageA = report.usageSummary!.usage!;
      const usageB = reportB.usageSummary!.usage!;
      return {
        status: 'needs-human' as const,
        reason: 'fixture blocked',
        report: {
          ...report,
          usageSummary: {
            ...report.usageSummary!,
            usage: {
              input: usageA.input + usageB.input,
              output: usageA.output + usageB.output,
              cacheRead: usageA.cacheRead + usageB.cacheRead,
              cacheWrite: usageA.cacheWrite + usageB.cacheWrite,
            },
          },
        },
      };
    });
    try {
      const result = await run({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      // The attempt reports BOTH dispatches inside ONE summary; the run
      // envelope carries that summary once — not two folded copies of it.
      expect(result.usageSummary).toEqual({
        usage: { input: 22, output: 10, cacheRead: 4, cacheWrite: 2 },
        costUSD: 0.03,
        knownCount: 3,
        unknownCount: 1,
        unpricedCount: 2,
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('M7-review thrown exception preserves settled usage once', async () => {
    const thrownUsage: KnownUsageSummary = {
      usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 0 },
      knownCount: 1,
      unknownCount: 0,
      unpricedCount: 1,
    };
    let calls = 0;
    const { repo, run } = await setupRun(async () => {
      calls += 1;
      const error: Error & { usageSummary?: KnownUsageSummary } = new Error(
        'fixture reviewer fault',
      );
      // Partial spend settled BEFORE the fault; the engine must surface it,
      // not launder the throw into a result.
      error.usageSummary = thrownUsage;
      throw error;
    });
    try {
      const error = await run({ repoRoot: repo.root }).then(
        (resolved) => {
          throw new Error(`expected rejection, resolved ${JSON.stringify(resolved)}`);
        },
        (rejected: unknown) => rejected,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ message: 'fixture reviewer fault' });
      expect((error as { usageSummary?: KnownUsageSummary }).usageSummary).toEqual(thrownUsage);
      expect(calls).toBe(1);
    } finally {
      await repo.cleanup();
    }
  });

  it('thrown exception with no observed usage invents no measurement', async () => {
    const { repo, run } = await setupRun(async () => {
      throw new Error('fixture reviewer fault before dispatch');
    });
    try {
      const error = await run({ repoRoot: repo.root }).then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
      const summary = (error as { usageSummary?: KnownUsageSummary }).usageSummary;
      expect(summary).toEqual({ knownCount: 0, unknownCount: 0, unpricedCount: 0 });
      expect(summary).not.toHaveProperty('usage');
      expect(summary).not.toHaveProperty('costUSD');
    } finally {
      await repo.cleanup();
    }
  });
});
