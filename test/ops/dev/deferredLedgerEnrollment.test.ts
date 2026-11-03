import { expect, test } from 'vitest';
import { checkRecord } from './fakes.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import {
  currentLedgerDebt,
  loadCurrentDeferredVendorDebt,
  bindPublishedDeferredDebt,
  prepareDeferredVendorReview,
} from '../../../src/ops/dev/internal/deferredLedger.js';
import { serializeDevLedger } from '../../../src/ops/dev/record.js';
import { fixture } from './deferredLedgerHelpers.js';

test('a changed enrolled head cannot be loaded as current vendor debt', async () => {
  const f = await fixture();
  expect(currentLedgerDebt(f.ledger, 'main', f.state)).toEqual(f.debt);
  f.debt.reference.binding = {
    ...f.debt.reference.binding,
    kind: 'deferred-author',
    repo: 'owner/repo',
    producer: 'author',
    target: 'main',
    head: 'c'.repeat(40),
  };
  expect(currentLedgerDebt(f.ledger, 'main', f.state)).toBeUndefined();
});
test('queue auth/read uncertainty retains debt and never grants snapshot continuation', async () => {
  const f = await fixture();
  const before = serializeDevLedger(f.effects.openLedger(f.state.branch).load());
  f.client.status = async () => {
    throw new Error('queue auth failed');
  };
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, f.ledger, f.client),
  ).rejects.toThrow('queue auth failed');
  expect(serializeDevLedger(f.effects.openLedger(f.state.branch).load())).toBe(before);
});
test('typed vendor blockage continues, queue identity blockage and changed ledger refuse', async () => {
  const f = await fixture();
  f.client.status = async () => ({
    ...f.debt.queue,
    state: 'blocked',
    enqueued: true,
    reason: { source: 'vendor', category: 'vendor-needs-action', code: 'auth' },
  });
  expect(
    await loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, f.ledger, f.client),
  ).toMatchObject({ queue: { state: 'blocked' } });
  f.client.status = async () => ({
    ...f.debt.queue,
    state: 'blocked',
    enqueued: true,
    reason: { source: 'queue', category: 'identity', code: 'forge-identity' },
  });
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, f.ledger, f.client),
  ).rejects.toThrow('does not authorize');
  f.client.status = async () => {
    f.effects.openLedger(f.state.branch).save({
      ...f.ledger,
      records: [...f.ledger.records, checkRecord({ ...f.identity, checkId: 'new-check' })],
    });
    return f.debt.queue;
  };
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, f.ledger, f.client),
  ).rejects.toThrow('changed while verifying');
});
test('repository mismatch, missing persisted origin and cancellation refuse before continuation', async () => {
  const f = await fixture();
  const other = {
    ...f.effects,
    runCommand: async () => ({ exitCode: 0, stdout: 'other/repo', stderr: '', timedOut: false }),
  };
  await expect(
    loadCurrentDeferredVendorDebt(other, 'main', f.state, f.ledger, f.client),
  ).rejects.toThrow('repository');
  const abort = new AbortController();
  abort.abort();
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, f.ledger, f.client, abort.signal),
  ).rejects.toThrow();
  delete f.origin.vendorFailure;
  expect(() => currentLedgerDebt(f.ledger, 'main', f.state)).toThrow('origin');
});
test('initial blocked CLI enrollment is durable and replayed before invoking any fresh reviewer', async () => {
  const f = await fixture();
  f.ledger.records = [f.origin];
  f.effects.openLedger(f.state.branch).save(f.ledger);
  let enqueues = 0;
  f.client.enqueue = async () => {
    enqueues++;
    return f.debt.queue;
  };
  const debt = await prepareDeferredVendorReview(f.effects, 'main', f.state, f.client);
  expect(debt?.reference.binding).toMatchObject({ producer: 'author', head: f.state.head });
  expect(debt?.reference.requestId).toMatch(/^defer-[a-f0-9]{64}$/);
  const ledger = f.effects.openLedger(f.state.branch).load();
  expect(ledger.records).toHaveLength(2);
  expect(ledger.records[0]).toEqual(f.origin);
  expect(ledger.records[1]).toMatchObject({
    kind: 'vendor-debt',
    debt: { vendorCompleted: false },
  });
  expect(await prepareDeferredVendorReview(f.effects, 'main', f.state, f.client)).toEqual(debt);
  expect(enqueues).toBe(1);
  expect(f.effects.calls.some((call) => call.command === 'coderabbit')).toBe(false);
});
test('changed head enrolls a successor before selection and never cancels published predecessor debt', async () => {
  const f = await fixture();
  f.debt.queue.pr = 12;
  f.debt.queue.state = 'awaiting-merge';
  f.effects.openLedger(f.state.branch).save(f.ledger);
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  f.repo.git('add', 'src/a.ts');
  f.repo.git('commit', '-qm', 'fix finding');
  const read = await readWorkState(f.effects, { target: 'main' });
  if (!read.ok) throw new Error(read.reason);
  const ids: string[] = [];
  f.client.enqueue = async (ref) => {
    ids.push(ref.requestId);
    return { ...f.debt.queue, state: 'awaiting-pr', pr: null };
  };
  f.client.status = async (ref) =>
    ref.requestId === f.debt.reference.requestId
      ? f.debt.queue
      : { ...f.debt.queue, state: 'awaiting-pr', pr: null };
  f.client.cancel = async () => {
    throw new Error('must not cancel predecessor');
  };
  const store = f.effects.openLedger(f.state.branch);
  const mutate = store.mutate;
  let failWrite = true;
  const faulty = {
    ...f.effects,
    openLedger: () => ({
      ...store,
      mutate: async <T>(fn: Parameters<typeof store.mutate<T>>[0]) => {
        if (failWrite) throw new Error('disk unavailable');
        return mutate(fn);
      },
    }),
  };
  await expect(prepareDeferredVendorReview(faulty, 'main', read.state, f.client)).rejects.toThrow(
    'disk unavailable',
  );
  expect(store.load().records).toEqual(f.ledger.records);
  failWrite = false;
  const successor = await prepareDeferredVendorReview(faulty, 'main', read.state, f.client);
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(successor?.predecessor).toEqual(f.debt.reference);
  expect(successor?.originAttempt).toEqual(f.debt.originAttempt);
  expect(f.debt.queue.pr).toBe(12);
});
test('publication bind persists only verified PR identity and supports crash replay', async () => {
  const f = await fixture();
  let binds = 0;
  f.client.bind = async (ref) => {
    binds++;
    return { ...f.debt.queue, state: 'awaiting-merge', pr: ref.pr };
  };
  await bindPublishedDeferredDebt(f.effects, 'main', f.state, f.ledger, 42, f.client);
  const latest = f.effects.openLedger(f.state.branch).load();
  expect(latest.records.at(-1)).toMatchObject({
    kind: 'vendor-debt',
    debt: { queue: { pr: 42 }, vendorCompleted: false },
  });
  await bindPublishedDeferredDebt(f.effects, 'main', f.state, latest, 42, f.client);
  expect(f.effects.openLedger(f.state.branch).load().records).toHaveLength(latest.records.length);
  expect(binds).toBe(2);
  f.client.bind = async () => {
    throw new Error('lost queue reply');
  };
  await expect(
    bindPublishedDeferredDebt(f.effects, 'main', f.state, latest, 42, f.client),
  ).rejects.toThrow('lost queue reply');
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(latest);
});
