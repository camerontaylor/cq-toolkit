import { expect, test } from 'vitest';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import {
  loadCurrentDeferredVendorDebt,
  prepareDeferredVendorReview,
} from '../../../src/ops/dev/internal/deferredLedger.js';
import { assembleReadiness } from '../../../src/ops/dev/record.js';
import type {
  QueueReference,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import {
  fixture,
  terminalReport,
  effectsFor,
  successorWithPendingAncestor,
} from './deferredLedgerHelpers.js';

test('in-flight deadline expiry during an ancestor RPC truncates nonfatally', async () => {
  const f = await fixture();
  const predecessor = f.debt;
  const terminal = terminalReport(f);
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  f.repo.git('add', 'src/a.ts');
  f.repo.git('commit', '-qm', 'new head');
  const read = await readWorkState(f.effects, { target: 'main' });
  if (!read.ok) throw new Error(read.reason);
  const successorStatus: QueueStatus = { ...f.debt.queue, state: 'awaiting-pr', pr: null };
  const successor = await prepareDeferredVendorReview(f.effects, 'main', read.state, {
    ...f.client,
    enqueue: async () => successorStatus,
    status: async () => successorStatus,
  });
  if (!successor) throw new Error('missing successor');
  // A wide margin keeps this deterministic: the budget survives the current work and is exhausted
  // while the ancestor status is still in flight.
  const budget = 2_000;
  const remainingMs = () => budget;
  const before = f.effects.openLedger(f.state.branch).load();
  const client = {
    ...terminal.client,
    status: async (ref: QueueReference): Promise<QueueStatus> => {
      if (ref.requestId !== predecessor.reference.requestId) return successorStatus;
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return successorStatus;
    },
  };
  const debt = await loadCurrentDeferredVendorDebt(
    f.effects,
    'main',
    read.state,
    before,
    client,
    undefined,
    { remainingMs },
  );
  // Truncation is nonfatal: the verified current enrollment comes back...
  expect(debt?.reference.requestId).toBe(successor.reference.requestId);
  // ...nothing is appended, and the retained obligation stays a readiness gap.
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
  const readiness = assembleReadiness({
    branch: f.state.branch,
    target: 'main',
    identity: { head: read.state.head, base: read.state.base, dirtySha256: read.state.dirtySha256 },
    ledger: before,
    untracked: [],
    configuredReviewers: ['agent', 'coderabbit'],
    deferredVendorDebt: successor,
    nowIso: f.effects.nowIso(),
  });
  expect(readiness.ready).toBe(false);
  if (readiness.ready) throw new Error('unexpected readiness');
  expect(readiness.gaps.map((gap) => gap.detail).join(' ')).toContain(
    'authorized predecessor obligation(s) unsettled:',
  );
});
test('an unrelated trust failure coinciding with expiry still propagates', async () => {
  const f = await fixture();
  const predecessor = f.debt;
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  f.repo.git('add', 'src/a.ts');
  f.repo.git('commit', '-qm', 'new head');
  const read = await readWorkState(f.effects, { target: 'main' });
  if (!read.ok) throw new Error(read.reason);
  const successorStatus: QueueStatus = { ...f.debt.queue, state: 'awaiting-pr', pr: null };
  const successor = await prepareDeferredVendorReview(f.effects, 'main', read.state, {
    ...f.client,
    enqueue: async () => successorStatus,
    status: async () => successorStatus,
  });
  if (!successor) throw new Error('missing successor');
  let exhausted = false;
  const remainingMs = () => (exhausted ? 0 : 5_000);
  const client = {
    ...f.client,
    status: async (ref: QueueReference): Promise<QueueStatus> => {
      if (ref.requestId === predecessor.reference.requestId) {
        // The clock expires first, THEN an unrelated trust failure surfaces: the catch must
        // classify by the caught outcome, never by the clock.
        exhausted = true;
        throw new Error('queue alias status binding mismatch');
      }
      return successorStatus;
    },
  };
  const before = f.effects.openLedger(f.state.branch).load();
  await expect(
    loadCurrentDeferredVendorDebt(effectsFor(f), 'main', read.state, before, client, undefined, {
      remainingMs,
    }),
  ).rejects.toThrow(/queue alias status binding mismatch/);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});
test('an exhausted budget before the timer callback still truncates nonfatally', async () => {
  const f = await fixture();
  const predecessor = f.debt;
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  f.repo.git('add', 'src/a.ts');
  f.repo.git('commit', '-qm', 'new head');
  const read = await readWorkState(f.effects, { target: 'main' });
  if (!read.ok) throw new Error(read.reason);
  const successorStatus: QueueStatus = { ...f.debt.queue, state: 'awaiting-pr', pr: null };
  const successor = await prepareDeferredVendorReview(f.effects, 'main', read.state, {
    ...f.client,
    enqueue: async () => successorStatus,
    status: async () => successorStatus,
  });
  if (!successor) throw new Error('missing successor');
  let exhausted = false;
  const remainingMs = () => (exhausted ? 0 : 5_000);
  const terminal = terminalReport(f);
  const client = {
    ...terminal.client,
    status: async (ref: QueueReference): Promise<QueueStatus> => {
      if (ref.requestId !== predecessor.reference.requestId) return successorStatus;
      // The budget reaches zero BEFORE the invocation timer callback can run; the very next
      // internal call must still be classified as OUR deadline, not as a fatal refresh error.
      exhausted = true;
      return {
        ...f.debt.queue,
        state: 'terminal-clean',
        pr: 42,
        mergeSha: f.state.head,
        itemId: 'current-fixture',
        reviewed: true,
        consumed: true,
      };
    },
    report: terminal.client.report,
  };
  const before = f.effects.openLedger(f.state.branch).load();
  const debt = await loadCurrentDeferredVendorDebt(
    f.effects,
    'main',
    read.state,
    before,
    client,
    undefined,
    { remainingMs },
  );
  expect(debt?.reference.requestId).toBe(successor.reference.requestId);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});
test('a non-vendor blocker discovered while refreshing an ancestor propagates', async () => {
  const { f, predecessor, successorStatus, read } = await successorWithPendingAncestor();
  const blocked: QueueStatus = {
    ...f.debt.queue,
    state: 'blocked',
    reason: { source: 'queue', category: 'identity', code: 'forge-identity' },
  };
  const client = {
    ...f.client,
    status: async (ref: QueueReference): Promise<QueueStatus> =>
      ref.requestId === predecessor.reference.requestId ? blocked : successorStatus,
  };
  const before = f.effects.openLedger(f.state.branch).load();
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'main', read.state, before, client),
  ).rejects.toThrow(/non-vendor blocker/);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});
test('a vendor-blocked, enqueued ancestor stays ordinary pending vendor work', async () => {
  const { f, predecessor, successorStatus, successor, read } = await successorWithPendingAncestor();
  const vendorBlocked: QueueStatus = {
    ...f.debt.queue,
    state: 'blocked',
    enqueued: true,
    reason: { source: 'vendor', category: 'vendor-rate-limited', code: 'rate_limited' },
  };
  const client = {
    ...f.client,
    status: async (ref: QueueReference): Promise<QueueStatus> =>
      ref.requestId === predecessor.reference.requestId ? vendorBlocked : successorStatus,
  };
  const before = f.effects.openLedger(f.state.branch).load();
  const debt = await loadCurrentDeferredVendorDebt(f.effects, 'main', read.state, before, client);
  expect(debt?.reference.requestId).toBe(successor.reference.requestId);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});
