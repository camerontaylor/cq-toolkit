// Split provenance: test/ops/review/addressMany.test.ts was split into this
// file plus addressMany.helpers.ts, addressMany.registry.test.ts,
// addressMany.guards.test.ts, addressMany.budget.test.ts,
// addressMany.query.test.ts, addressMany.enrollment.test.ts,
// addressMany.accounting.test.ts, addressMany.concurrency.test.ts,
// addressMany.isolation.test.ts and addressMany.usage.test.ts.
import { expect, test, vi } from 'vitest';
import { makeReviewAddressMany } from '../../../src/ops/review/addressMany.js';
import { gh, input, report } from './addressMany.helpers.js';

test('addresses two independently attributed heads and preserves reports', async () => {
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    isolate: async (root) => root,
    gh,
    address,
  })(input);
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('expected success');
  expect(result.value.rows.map((row) => row.scope.number)).toEqual([1, 2]);
  expect(result.value.accounting.observedTokens).toBe(20);
  expect(address.mock.calls).toHaveLength(2);
});

test('known failed leg does not discard a successful sibling', async () => {
  let calls = 0;
  const address = vi.fn(async () =>
    ++calls === 1
      ? { status: 'failed' as const, error: 'verification failed', report: report() }
      : { status: 'ok' as const, value: report() },
  );
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    isolate: async (root) => root,
    gh,
    address,
  })(input);
  expect(result.status).toBe('failed');
  expect(result.report?.rows).toHaveLength(2);
  expect(address).toHaveBeenCalledTimes(2);
});

test('unclean summaries retain each PR reason when aggregate accounting is clean', async () => {
  const address = vi.fn(async () => ({
    status: 'needs-human' as const,
    reason: 'reviewer unavailable',
    report: report(),
  }));
  const result = await makeReviewAddressMany({
    coordinationRoot: '/unused-test-coordination',
    isolate: async (root) => root,
    gh,
    address,
  })(input);
  expect(result.status).toBe('needs-human');
  if (result.status !== 'needs-human') throw new Error('expected needs-human');
  expect(result.reason).toContain('PR #1: reviewer unavailable');
  expect(result.reason).toContain('PR #2: reviewer unavailable');
  expect(result.report?.reasons).toEqual([
    'PR #1: reviewer unavailable',
    'PR #2: reviewer unavailable',
  ]);
});
