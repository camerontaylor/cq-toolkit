import { coordinationRoot } from './addressMany.helpers.js';
// Split provenance: test/ops/review/addressMany.test.ts was split into this
// file plus addressMany.helpers.ts, addressMany.registry.test.ts,
// addressMany.dispatch.test.ts, addressMany.guards.test.ts,
// addressMany.budget.test.ts, addressMany.query.test.ts,
// addressMany.enrollment.test.ts, addressMany.accounting.test.ts,
// addressMany.isolation.test.ts and addressMany.usage.test.ts.
import { expect, test, vi } from 'vitest';
import { makeReviewAddressMany } from '../../../src/ops/review/addressMany.js';
import { gh, input, report } from './addressMany.helpers.js';

test('bounded workers overlap and settle shared allocation without oversubscription', async () => {
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const address = vi.fn(async () => {
    peak = Math.max(peak, ++active);
    if (active === 2) release();
    await barrier;
    active--;
    return { status: 'ok' as const, value: report() };
  });
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    gh,
    address,
    isolate: async (root) => root,
  })({
    ...input,
    concurrency: 2,
  });
  expect(peak).toBe(2);
  expect(result.status).toBe('ok');
  if (result.status === 'ok') expect(result.value.accounting.observedTokens).toBe(20);
});

test('facts reads are bounded', async () => {
  let active = 0;
  let peak = 0;
  const boundedGh = async (args: string[]) => {
    if (args[0] === 'repo') return gh(args);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const result = await gh(args);
    active--;
    return result;
  };
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    gh: boundedGh,
    address,
    isolate: async (root) => root,
  })({ ...input, pulls: Array.from({ length: 20 }, (_, i) => i + 1), maxTokens: 1000 });
  expect(peak).toBeLessThanOrEqual(8);
  expect(address).toHaveBeenCalledTimes(20);
});
