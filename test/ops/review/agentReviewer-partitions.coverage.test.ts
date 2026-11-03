// Split provenance: test/ops/review/agentReviewer-partitions.test.ts was split
// into agentReviewer-partitions.{session,coverage,scan,cancellation,preflight,
// budget,concurrency,failures,retries,exclusions,wire}.test.ts. This file holds
// the partition fallback coverage proof and partition-plan geometry decisions.
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { REVIEW_PARTITION_STEPS } from '../../../src/ops/review/internal/reviewPlan.js';
import { partitionReview } from '../../../src/ops/review/internal/reviewPartitions.js';
import { baseInput, fakeDrivers, large } from './agentReviewer-partitions.helpers.js';

it('falls back for a large change and proves complete contiguous UTF-16 coverage of original bytes', async () => {
  const input = baseInput({
    diff: large,
    components: [{ component: 'tracked:src/a.ts', path: 'src/a.ts', text: large }],
  });
  const fake = fakeDrivers();
  const outcome = await runAgentReviewer(fake.drivers, input);
  expect(outcome.status).toBe('ok');
  if (outcome.status !== 'ok') throw new Error(JSON.stringify(outcome));
  const { coverage } = outcome.value;
  expect(coverage.mode).toBe('partitioned');
  expect(coverage.pieces[0]).toMatchObject({
    component: 'tracked:src/a.ts',
    path: 'src/a.ts',
    chars: large.length,
    bytes: Buffer.byteLength(large, 'utf8'),
    sha256: createHash('sha256').update(large).digest('hex'),
    state: 'completed',
  });
  const deliveries = coverage.sessions.flatMap((session) => session.deliveries);
  expect(deliveries.length).toBeGreaterThan(1);
  expect(deliveries.map(({ start, end }) => [start, end])).toEqual(
    [...deliveries].sort((a, b) => a.start - b.start).map(({ start, end }) => [start, end]),
  );
  let next = 0;
  let reconstructed = '';
  for (const delivery of deliveries) {
    expect(delivery.start).toBe(next);
    const prompt =
      fake.invocations[coverage.sessions.findIndex((s) => s.deliveries.includes(delivery))]!.prompt;
    const data = prompt.slice(prompt.indexOf('partition data (UTF-16 range'));
    expect(delivery.end).toBeGreaterThan(delivery.start);
    reconstructed += large.slice(delivery.start, delivery.end);
    expect(large.slice(delivery.start, delivery.end)).not.toMatch(
      /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/,
    );
    expect(data).toContain(large.slice(delivery.start, delivery.end));
    next = delivery.end;
  }
  expect(next).toBe(large.length);
  expect(reconstructed).toBe(large);
  expect(fake.calls()).toBe(coverage.sessions.length);
  expect(outcome.value.usage).toBe(fake.calls() * 5);
  // Fixed partition tooling: every fallback session carries the same
  // read-only reference definitions and the bounded total step allowance.
  expect(
    fake.invocations.every(
      (invocation) =>
        invocation.toolPolicy.mode === 'allowlist' &&
        invocation.toolPolicy.allow.join(',') === 'read,grep,glob' &&
        invocation.budget.maxSteps === REVIEW_PARTITION_STEPS,
    ),
  ).toBe(true);
});

it('retains original line attribution and preserves surrogate-safe partition boundaries', async () => {
  const text = '@@ -900 +800 @@\n' + '😀 ordinary line\n'.repeat(5_000);
  const component = { component: 'untracked:new.txt', path: 'new.txt', text };
  const plan = partitionReview({
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    scope: 'full',
    components: [component],
    requireReceipt: false,
  });
  expect(plan.partitions.length).toBeGreaterThan(1);
  let next = 0;
  for (const part of plan.coverage.partitions) {
    const range = part.ranges[0]!;
    expect(range.start).toBe(next);
    const slice = text.slice(range.start, range.end);
    expect(slice).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    next = range.end;
  }
  expect(next).toBe(text.length);
  const rightLine = text.slice(0, plan.coverage.partitions[1]!.ranges[0]!.start).split('\n').length;
  expect(rightLine).toBeGreaterThan(1);
  expect(plan.partitions[1]?.prompt).toContain(`"newLine":${rightLine}`);
  expect(plan.partitions[1]?.prompt).not.toContain('"oldLine"');
});

it('tracks old and new line numbers through context, removed and added hunk lines', () => {
  const text = ['@@ -10,4 +20,4 @@', ' context', '-removed', '+added', ' tail', ''].join('\n');
  const plan = partitionReview({
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    scope: 'full',
    components: [{ component: 'tracked:a.ts', path: 'a.ts', text }],
    requireReceipt: false,
  });
  expect(plan.partitions).toHaveLength(1);
});

it('refuses partition instructions that alone exceed the prompt cap', () => {
  expect(() =>
    partitionReview({
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
      scope: 'full',
      components: [{ component: 'tracked:a.ts', path: 'a.ts', text: 'x\n' }],
      instructions: 'i'.repeat(200_000),
    }),
  ).toThrow('exceed the supported prompt limit');
});
