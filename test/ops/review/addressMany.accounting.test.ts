import { coordinationRoot } from './addressMany.helpers.js';
// Split provenance: test/ops/review/addressMany.test.ts was split into this
// file plus addressMany.helpers.ts, addressMany.registry.test.ts,
// addressMany.dispatch.test.ts, addressMany.guards.test.ts,
// addressMany.budget.test.ts, addressMany.query.test.ts,
// addressMany.enrollment.test.ts, addressMany.concurrency.test.ts,
// addressMany.isolation.test.ts and addressMany.usage.test.ts.
import { expect, test, vi } from 'vitest';
import { makeReviewAddressMany } from '../../../src/ops/review/addressMany.js';
import { gh, input, report } from './addressMany.helpers.js';

test('unknown usage stops admission and retains held allocation', async () => {
  const address = vi.fn(async () => {
    throw new Error('worker lost');
  });
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    isolate: async (root) => root,
    gh,
    address,
  })(input);
  expect(address).toHaveBeenCalledTimes(1);
  expect(result.report?.accounting.stop).toBe('unknown-usage');
  expect(result.report?.rows[1]?.status).toBe('not-admitted');
});

test('refused usage settlement retains sibling reports and names the accounting fault', async () => {
  const address = vi.fn(async () => ({
    status: 'ok' as const,
    value: {
      ...report(),
      usage: { input: Number.MAX_SAFE_INTEGER, output: 1, cacheRead: 0, cacheWrite: 0 },
    },
  }));
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    gh,
    address,
    isolate: async (root) => root,
  })({ ...input, concurrency: 2 });
  expect(result.status).toBe('budget-exhausted');
  expect(result.report?.rows).toHaveLength(2);
  expect(result.report?.reasons.join(';')).toContain('settlement refused');
});

test('a throwing settlement waits for siblings and preserves their individual results', async () => {
  const address = vi.fn(async () => ({
    status: 'ok' as const,
    value: {
      ...report(),
      usage: { input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  }));
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    gh,
    address,
    isolate: async (root) => root,
  })({ ...input, concurrency: 2 });
  expect(result.report?.rows).toHaveLength(2);
  expect(result.report?.rows.every((row) => row.result?.status === 'ok')).toBe(true);
  // The thrown settlement is now settled as unknown with a named fault, so
  // both rows survive with their individual results and no worker is lost.
  expect(result.report?.reasons.join(';')).toContain('settlement threw and was settled as unknown');
  expect(result.report?.accounting.stop).toBe('overrun');
});

test('skipped rows name the settlement fault and held allocation', async () => {
  const address = vi.fn(async () => ({
    status: 'ok' as const,
    value: {
      ...report(),
      usage: { input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  }));
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    gh,
    address,
    isolate: async (root) => root,
  })({ ...input, pulls: [1, 2, 3], concurrency: 2 });
  expect(result.report?.rows).toHaveLength(3);
  // The sticky stop is an explicit budget refusal, not a generic missing worker result.
  expect(result.report?.rows[2]?.reason).toBe('budget');
  expect(result.report?.rows[2]?.detail).toContain('Runtime faults');
  expect(result.report?.reasons.join(';')).toContain('settlement threw and was settled as unknown');
});
