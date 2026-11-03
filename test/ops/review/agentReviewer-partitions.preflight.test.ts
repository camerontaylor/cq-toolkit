// Split provenance: test/ops/review/agentReviewer-partitions.test.ts was split
// into agentReviewer-partitions.{session,coverage,scan,cancellation,preflight,
// budget,concurrency,failures,retries,exclusions,wire}.test.ts. This file holds
// the pre-dispatch validation and duplicate-identity refusals.
import { expect, it } from 'vitest';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import {
  createReviewPlan,
  type PlannedReviewSession,
} from '../../../src/ops/review/internal/reviewPlan.js';
import { runReviewSession } from '../../../src/ops/review/internal/reviewSession.js';
import type { ReviewCoverageV2 } from '../../../src/ops/review/internal/reviewCoverageV2.js';
import { baseInput, clean, fakeDrivers, small, usage } from './agentReviewer-partitions.helpers.js';

it('rejects a forged prompt offset before dispatch while accepting an empty exact placement', async () => {
  const planned = createReviewPlan({
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    scope: 'full',
    components: [small],
  });
  const session = planned.sessions[0]!;
  const broken: PlannedReviewSession = {
    ...session,
    placements: session.placements.map((placement) => ({
      ...placement,
      offset: placement.offset + 1,
    })),
  };
  const evidence: ReviewCoverageV2['sessions'][number] = {
    id: session.id,
    status: 'error',
    usage: { ...usage },
    deliveries: [],
    requests: [],
  };
  const fake = fakeDrivers();
  await expect(
    runReviewSession(fake.drivers, {
      repoRoot: '/fixture/repo',
      role: { provider: 'mock', model: 'fixture' },
      severityMap: { high: 'major', medium: 'minor' },
      maxTokens: 100,
      maxSteps: 15,
      maxPromptChars: 60_000,
      signal: new AbortController().signal,
      scanSecrets: clean,
      components: [small],
      plan: broken,
      evidence,
      onUsage: () => undefined,
      searchTools: true,
    }),
  ).rejects.toThrow('agent review prompt placement does not match its planned component');
  expect(fake.calls()).toBe(0);
});

it('refuses duplicate component identities rather than collapsing original coverage', async () => {
  const duplicate = { ...small, path: 'src/other.ts' };
  const fake = fakeDrivers();
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({ components: [small, duplicate] }),
  );
  expect(outcome).toMatchObject({
    status: 'needs-human',
    reason: expect.stringContaining('component identities must be unique') as unknown,
  });
  expect(fake.calls()).toBe(0);
});

it('rejects a session whose evidence record is not empty before dispatch', async () => {
  const planned = createReviewPlan({
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    scope: 'full',
    components: [small],
  });
  const session = planned.sessions[0]!;
  const fake = fakeDrivers();
  await expect(
    runReviewSession(fake.drivers, {
      repoRoot: '/fixture/repo',
      role: { provider: 'mock', model: 'fixture' },
      severityMap: { high: 'major', medium: 'minor' },
      maxTokens: 100,
      maxSteps: 4,
      maxPromptChars: 60_000,
      signal: new AbortController().signal,
      scanSecrets: clean,
      components: [small],
      plan: session,
      evidence: {
        id: session.id,
        status: 'error',
        usage: { ...usage },
        deliveries: [],
        requests: [{ kind: 'model-request', matched: true }] as never,
      },
      onUsage: () => undefined,
      searchTools: true,
    }),
  ).rejects.toThrow('agent review session evidence must start empty');
  expect(fake.calls()).toBe(0);
});
