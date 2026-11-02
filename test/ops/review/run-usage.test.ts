import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import type { AgentReviewResult } from '../../../src/ops/review/agentReviewer.js';
import type { KnownUsageSummary } from '../../../src/shared/knownUsage.js';
import { makeTestRepo, repoEffects } from '../dev/repo.js';

/** Fixture data (bytes excluded from the M7-review line budget). */
interface UsageFixture {
  coverage: {
    scope: 'full';
    mode: 'session';
    modeReason: string;
    piece: Record<string, unknown>;
    session: Record<string, unknown>;
  };
  childUsage: KnownUsageSummary;
  cqConfig: Record<string, unknown>;
}

const fixture = JSON.parse(
  await readFile(
    join(import.meta.dirname, '../../fixtures/review-run-usage/coverage-ok.json'),
    'utf8',
  ),
) as UsageFixture;

const noDriver: DriverFactory = {
  resolve: () => {
    throw new Error('unexpected driver');
  },
};

/** Complete v2 coverage for the ok path, bound to the reviewed identity. */
const okCoverage = (head: string, base: string) => ({
  version: 2,
  head,
  base,
  scope: fixture.coverage.scope,
  mode: fixture.coverage.mode,
  modeReason: fixture.coverage.modeReason,
  pieces: [fixture.coverage.piece],
  sessions: [
    {
      id: fixture.coverage.session.id as string,
      status: fixture.coverage.session.status,
      usage: fixture.coverage.session.usage,
      deliveries: [
        {
          ...(fixture.coverage.session.delivery as Record<string, unknown>),
          sha256: (fixture.coverage.piece as { sha256: string }).sha256,
        },
      ],
      requests: [fixture.coverage.session.request],
    },
  ],
});

const childUsage = (): KnownUsageSummary => fixture.childUsage;

/** Scripted reviewer result for one settled OpResult status. */
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
      value: { ...report, coverage: okCoverage(head!, base!) as never },
    };
  if (status === 'needs-human') return { status, reason: 'fixture blocked', report };
  if (status === 'failed') return { status, error: 'fixture failed', report };
  if (status === 'budget-exhausted') return { status, report };
  return { status, detail: 'fixture lost verdict', report };
};

/** Local composition: an agent-only fixture repo whose reviewer is scripted. */
const setupRun = async (
  runAgentReviewer: (input: { head: string; base: string }) => Promise<AgentReviewResult>,
  effectsOverrides?: Parameters<typeof repoEffects>[2],
) => {
  const repo = await makeTestRepo();
  await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
  await repo.write('cq.json', JSON.stringify(fixture.cqConfig));
  repo.commitAll('usage retention fixture');
  const effects = repoEffects(repo, () => undefined, effectsOverrides);
  const run = makeReviewRun({
    drivers: noDriver,
    effectsFactory: () => effects,
    scannerFactory: () => async (components) =>
      components.map(({ component }) => ({ component, hits: [] })),
    runAgentReviewer: () =>
      runAgentReviewer({
        head: repo.git('rev-parse', 'HEAD').trim(),
        base: repo.git('merge-base', 'origin/main', 'HEAD').trim(),
      }),
  });
  return { repo, run };
};

const rejected = async (run: ReturnType<typeof makeReviewRun>, repoRoot: string) =>
  run({ repoRoot }).then(
    (resolved) => {
      throw new Error(`expected rejection, resolved ${JSON.stringify(resolved)}`);
    },
    (thrown: unknown) => thrown,
  );

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
      await repo.write('cq.json', JSON.stringify(fixture.cqConfig));
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
});

describe('review.run usage retention (M7-review)', () => {
  it('M7-review nominal evidence', async () => {
    const { repo, run } = await setupRun((input) =>
      Promise.resolve(reviewerResult('ok', input.head, input.base)),
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

  it('M7-review failure evidence', async () => {
    const { repo, run } = await setupRun(async () => reviewerResult('failed'));
    try {
      // A failed attempt still exposes its settled spend, folded exactly once;
      // the failed ENGINE result surfaces as a run-level failed, not blocked.
      const result = await run({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      expect(result.usageSummary).toEqual(childUsage());
      expect(result.report?.sources[0]).toMatchObject({
        status: 'blocked',
        reason: 'fixture failed',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('M7-review budget exhaustion marks blockedBudget on the report', async () => {
    const { repo, run } = await setupRun(async () => {
      // The reviewer dispatch still runs (its usage settles), but the wall
      // budget expires mid-attempt: budgetStopped() turns true while the
      // engine result reports budgetExhausted.
      await new Promise((resolve) => setTimeout(resolve, 2100));
      return {
        ...reviewerResult('budget-exhausted'),
        report: {
          ...reviewerResult('budget-exhausted').report!,
          budgetExhausted: true as const,
        },
      };
    });
    try {
      const result = await run({ repoRoot: repo.root, wallMs: 2000 });
      expect(result.status).toBe('needs-human');
      expect(result.usageSummary).toEqual(childUsage());
      // Every blocked source stopped on the budget and nothing drifted, so
      // the run decorates the block with the budget attribution.
      expect(result.report?.blockedBudget).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('M7-review cancellation is owned by the caller, usage still retained', async () => {
    const { repo, run } = await setupRun(async () => ({
      status: 'needs-human' as const,
      reason: 'agent review cancelled or wall budget exhausted',
      report: {
        findings: [],
        usage: 3,
        usageSummary: childUsage(),
        coverage: undefined as never,
        cancelled: true as const,
        advisories: [],
        limitations: [],
      },
    }));
    try {
      const result = await run({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      expect(result.usageSummary).toEqual(childUsage());
      // A parent cancel is never re-attributed to the budget (blockedBudget
      // requires !parent.aborted and a budget-stopped source): the caller
      // owns the cancellation attribution, the spend still lands once.
      expect(result.report?.blockedBudget).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it('parent totals do not double count child usage', async () => {
    // Two child dispatches in one reviewer attempt fold into ONE engine
    // summary; the run envelope carries that summary once, never two copies.
    const { repo, run } = await setupRun(async () => {
      const report = reviewerResult('needs-human').report!;
      const usageA = report.usageSummary!.usage!;
      const usageB = reviewerResult('needs-human').report!.usageSummary!.usage!;
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
    // A REAL post-settlement fault: the reviewer returns normally (its usage
    // was pushed at run.ts's capture point), then the engine's own nowIso
    // read throws. The rejection must carry the already-folded envelope.
    const { repo, run } = await setupRun(async () => reviewerResult('needs-human'), {
      nowIso: () => {
        throw new Error('clock exploded after settlement');
      },
    });
    try {
      const error = (await rejected(run, repo.root)) as Error & {
        usageSummary?: KnownUsageSummary;
      };
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('clock exploded after settlement');
      expect(error.usageSummary).toEqual(childUsage());
    } finally {
      await repo.cleanup();
    }
  });

  it('thrown exception with no observed usage invents no measurement', async () => {
    const { repo, run } = await setupRun(async () => {
      throw new Error('fixture reviewer fault before dispatch');
    });
    try {
      const error = (await rejected(run, repo.root)) as Error & {
        usageSummary?: KnownUsageSummary;
      };
      expect(error.message).toBe('fixture reviewer fault before dispatch');
      expect(error.usageSummary).toEqual({ knownCount: 0, unknownCount: 0, unpricedCount: 0 });
      expect(error.usageSummary).not.toHaveProperty('usage');
      expect(error.usageSummary).not.toHaveProperty('costUSD');
    } finally {
      await repo.cleanup();
    }
  });

  it('a non-extensible thrown error propagates without masking its fault', async () => {
    const { repo, run } = await setupRun(async () => {
      const fault: string = Object.freeze('frozen reviewer fault');
      throw fault;
    });
    try {
      const error = await rejected(run, repo.root);
      // The carrier attach must be best-effort: a frozen thrown value still
      // surfaces verbatim, never as an assignment TypeError.
      expect(error).toBe('frozen reviewer fault');
    } finally {
      await repo.cleanup();
    }
  });
});
