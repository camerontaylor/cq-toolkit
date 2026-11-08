import { coordinationRoot } from './addressMany.helpers.js';
// Split provenance: test/ops/review/addressMany.test.ts was split into this
// file plus addressMany.helpers.ts, addressMany.registry.test.ts,
// addressMany.dispatch.test.ts, addressMany.guards.test.ts,
// addressMany.query.test.ts, addressMany.enrollment.test.ts,
// addressMany.accounting.test.ts, addressMany.concurrency.test.ts,
// addressMany.isolation.test.ts and addressMany.usage.test.ts.
import { expect, test, vi } from 'vitest';
import { acquireSlot } from '../../../src/adapters/lock/slotLock.js';
import { makeReviewAddressMany } from '../../../src/ops/review/addressMany.js';
import { enrollmentRequest, gh, input, report } from './addressMany.helpers.js';

test('oversized reservation never dispatches either PR', async () => {
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    isolate: async (root) => root,
    gh,
    address,
  })({
    ...input,
    maxTokens: 10,
  });
  expect(result.status).toBe('budget-exhausted');
  expect(result.report?.rows.every((row) => row.status === 'not-admitted')).toBe(true);
  expect(address).not.toHaveBeenCalled();
});

test('temporary sibling reservations defer candidates until known usage releases allocation', async () => {
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    gh,
    address,
    isolate: async (root) => root,
  })({
    ...input,
    pulls: [1, 2, 3, 4],
    concurrency: 3,
  });
  expect(address).toHaveBeenCalledTimes(4);
  expect(result.status).toBe('ok');
  if (result.status === 'ok') expect(result.value.accounting.observedTokens).toBe(40);
});

test('budget refusal retains the advisory request', async () => {
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    gh,
    address: vi.fn(),
  })({ ...input, maxTokens: 1, enrollments: [{ number: 1, request: enrollmentRequest }] });
  expect(result.report?.rows[0]?.enrollment.state).toBe('unavailable');
});

test('busy first PR releases its reservation so the next PR runs at one-leg budget (mutation: omit pre-callback zero settlement)', async () => {
  const root = coordinationRoot();
  const held = await acquireSlot(root, 1);
  const dispatched: number[] = [];
  try {
    const result = await makeReviewAddressMany({
      coordinationRoot: root,
      gh,
      isolate: async (root) => root,
      address: async (input) => {
        dispatched.push(Number(input.source.slice(3)));
        return { status: 'ok' as const, value: report() };
      },
    })({ ...input, maxTokens: input.tokensPerPr, concurrency: 1 });
    expect(dispatched, 'busy PR must not starve an unrelated candidate').toEqual([2]);
    const aggregate = result.status === 'ok' ? result.value : result.report!;
    expect(aggregate.rows.map((row) => row.scope.number)).toEqual([1, 2]);
    expect(aggregate.accounting.heldTokens).toBe(0);
  } finally {
    await held.close();
  }
});
