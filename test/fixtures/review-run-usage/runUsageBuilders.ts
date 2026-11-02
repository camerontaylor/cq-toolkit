/**
 * Scenario/fixture builders for test/ops/review/run-usage.test.ts.
 * Fixture bytes: excluded from the M7-review line budget.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import type { AgentReviewResult } from '../../../src/ops/review/agentReviewer.js';
import type { KnownUsageSummary } from '../../../src/shared/knownUsage.js';
import { makeTestRepo, repoEffects } from '../../ops/dev/repo.js';

/** Fixture data. */
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
  await readFile(join(import.meta.dirname, './coverage-ok.json'), 'utf8'),
) as UsageFixture;

export const noDriver: DriverFactory = {
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

export const childUsage = (): KnownUsageSummary => fixture.childUsage;

/** Scripted reviewer result for one settled OpResult status. */
export const reviewerResult = (
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

export const fixtureCqConfig = (): Record<string, unknown> => fixture.cqConfig;

/** Local composition: an agent-only fixture repo whose reviewer is scripted. */
export const setupRun = async (
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

export const rejected = async (
  run: ReturnType<typeof makeReviewRun>,
  repoRoot: string,
): Promise<unknown> =>
  run({ repoRoot }).then(
    (resolved) => {
      throw new Error(`expected rejection, resolved ${JSON.stringify(resolved)}`);
    },
    (thrown: unknown) => thrown,
  );
