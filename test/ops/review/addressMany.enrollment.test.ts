import { coordinationRoot } from './addressMany.helpers.js';
// Split provenance: test/ops/review/addressMany.test.ts was split into this
// file plus addressMany.helpers.ts, addressMany.registry.test.ts,
// addressMany.dispatch.test.ts, addressMany.guards.test.ts,
// addressMany.budget.test.ts, addressMany.query.test.ts,
// addressMany.accounting.test.ts, addressMany.concurrency.test.ts,
// addressMany.isolation.test.ts and addressMany.usage.test.ts.
import { expect, test, vi } from 'vitest';
import { makeReviewAddressMany } from '../../../src/ops/review/addressMany.js';
import { ReviewAddressManyInputSchema } from '../../../src/ops/review/registry.js';
import { enrollmentRequest, gh, head, input, metadata, report } from './addressMany.helpers.js';

test('enrollment transport failure remains advisory on the attributed row', async () => {
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const enqueue = vi.fn(async () => {
    throw new Error('transport unavailable');
  });
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    gh,
    address,
    enqueue,
    isolate: async (root) => root,
  })({
    ...input,
    pulls: [1],
    enrollments: [
      {
        number: 1,
        request: {
          requestId: 'm4-test',
          binding: {
            kind: 'deferred-author',
            repo: input.repo,
            head,
            producer: 'm4',
            target: 'main',
            targetSelector: 'promoted-main',
          },
        },
      },
    ],
  });
  expect(result.status).toBe('ok');
  if (result.status === 'ok')
    expect(result.value.rows[0]?.enrollment).toEqual({
      state: 'unavailable',
      reason: 'Error: transport unavailable',
    });
  expect(address).toHaveBeenCalledTimes(1);
  expect(enqueue).toHaveBeenCalledTimes(1);
});

test('duplicate and out-of-selection enrollments are refused', async () => {
  expect(
    ReviewAddressManyInputSchema.safeParse({
      ...input,
      enrollments: [1, 1].map((number) => ({ number, request: enrollmentRequest })),
    }).success,
  ).toBe(false);
  expect(
    ReviewAddressManyInputSchema.safeParse({
      ...input,
      enrollments: [{ number: 3, request: enrollmentRequest }],
    }).success,
  ).toBe(false);
});

test('an ineligible enrolled PR remains advisory while eligible siblings dispatch', async () => {
  const metadataGh = async (args: string[]) => {
    if (args[0] === 'repo') return gh(args);
    const number = Number(args[1]!.split('/').at(-1));
    return {
      code: 0,
      stderr: '',
      stdout: JSON.stringify({ ...metadata(number), draft: number === 1 }),
    };
  };
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    gh: metadataGh,
    address,
    isolate: async (root) => root,
  })({ ...input, enrollments: [{ number: 1, request: enrollmentRequest }] });
  expect(result.status).toBe('ok');
  if (result.status === 'ok')
    expect(result.value.excluded?.[0]?.enrollment.state).toBe('unavailable');
  expect(address).toHaveBeenCalledTimes(1);
});
