import { coordinationRoot } from './addressMany.helpers.js';
// Split provenance: test/ops/review/addressMany.test.ts was split into this
// file plus addressMany.helpers.ts, addressMany.registry.test.ts,
// addressMany.dispatch.test.ts, addressMany.guards.test.ts,
// addressMany.budget.test.ts, addressMany.query.test.ts,
// addressMany.enrollment.test.ts, addressMany.accounting.test.ts,
// addressMany.concurrency.test.ts and addressMany.usage.test.ts.
import { expect, test, vi } from 'vitest';
import { makeReviewAddressMany } from '../../../src/ops/review/addressMany.js';
import { ReviewAddressManyInputSchema } from '../../../src/ops/review/registry.js';
import { gh, input, report } from './addressMany.helpers.js';

test('aggregate reports the preserved isolation path for each leg', async () => {
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    gh,
    address,
    isolate: async (_root, number) => `/isolated/pr-${number}`,
  })({ ...input });
  expect(result.status).toBe('ok');
  if (result.status === 'ok')
    expect(result.value.preservedClones).toEqual([
      { number: 1, path: '/isolated/pr-1' },
      { number: 2, path: '/isolated/pr-2' },
    ]);
});

test('bulk caller forwards only the selected PR prepared dependency root', async () => {
  const address = vi.fn(async (_input: unknown) => ({ status: 'ok' as const, value: report() }));
  await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    isolate: async () => '/isolated',
    gh,
    address,
  })({ ...input, dependencyRoots: { '1': 'prepared/old-pr' } });
  expect(address.mock.calls[0]![0]).toMatchObject({
    repoRoot: '/isolated',
    dependencyRoot: '/repo/prepared/old-pr',
  });
  expect(address.mock.calls[1]![0]).not.toHaveProperty('dependencyRoot');
  expect(
    ReviewAddressManyInputSchema.safeParse({ ...input, dependencyRoots: { bad: '/path' } }).success,
  ).toBe(false);
});
