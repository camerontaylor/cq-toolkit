import { expect, test } from 'vitest';
import type { QueueEvidence } from '../../../src/ops/review/internal/queueEvidence.js';
import { loadCurrentDeferredVendorDebt } from '../../../src/ops/dev/internal/deferredLedger.js';
import type {
  QueueReference,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import {
  successorWithPendingAncestor,
  adapterAborted,
  adapterTimedOut,
} from './deferredLedgerHelpers.js';

test('a caller abort during the post-report identity read prevents the ancestor append', async () => {
  const { f, predecessor, terminal, successorStatus, read } = await successorWithPendingAncestor();
  const controller = new AbortController();
  const reason = new Error('caller cancelled during the post-report identity read');
  let imported = false;
  const client = {
    ...terminal.client,
    status: async (ref: QueueReference): Promise<QueueStatus> =>
      ref.requestId === predecessor.reference.requestId
        ? terminal.client.status()
        : successorStatus,
    report: async (ref: QueueReference, root: string): Promise<QueueEvidence> => {
      const evidence = await terminal.client.report(ref, root);
      imported = true;
      return evidence;
    },
  };
  const before = f.effects.openLedger(f.state.branch).load();
  const effects = {
    ...f.effects,
    runCommand: async (...call: Parameters<typeof f.effects.runCommand>) => {
      const result = await f.effects.runCommand(...call);
      // Cancellation lands on the ancestry loop's post-report identity read (readWorkState opens
      // with `symbolic-ref`), i.e. AFTER consumeDeferredVendorReport has fully returned.
      if (imported && call[0] === 'git' && call[1].includes('symbolic-ref'))
        controller.abort(reason);
      return result;
    },
  };
  await expect(
    loadCurrentDeferredVendorDebt(effects, 'main', read.state, before, client, controller.signal),
  ).rejects.toBe(reason);
  // No late settlement write: the ledger is exactly as before.
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});
test('a caller abort after the final ancestor settlement still propagates from lineage exhaustion', async () => {
  const { f, predecessor, terminal, successorStatus, read } = await successorWithPendingAncestor();
  const controller = new AbortController();
  const reason = new Error('caller cancelled after the final settlement');
  const client = {
    ...terminal.client,
    status: async (ref: QueueReference): Promise<QueueStatus> =>
      ref.requestId === predecessor.reference.requestId
        ? terminal.client.status()
        : successorStatus,
  };
  const store = f.effects.openLedger(f.state.branch);
  const before = store.load();
  const effects = {
    ...f.effects,
    openLedger: () => ({
      ...store,
      mutate: async <T>(fn: Parameters<typeof store.mutate<T>>[0]) => {
        const value = await store.mutate(fn);
        // The settlement is published; cancellation lands before the lineage can be re-read.
        controller.abort(reason);
        return value;
      },
    }),
  };
  await expect(
    loadCurrentDeferredVendorDebt(effects, 'main', read.state, before, client, controller.signal),
  ).rejects.toBe(reason);
});
test('the post-report identity read is clamped to the remaining budget and carries the signal', async () => {
  const { f, predecessor, terminal, successorStatus, successor, read } =
    await successorWithPendingAncestor();
  const client = {
    ...f.client,
    status: async (ref: QueueReference): Promise<QueueStatus> =>
      ref.requestId === predecessor.reference.requestId
        ? terminal.client.status()
        : successorStatus,
    report: terminal.client.report,
  };
  let imported = false;
  let inIdentityRead = false;
  const calls: { command: string; timeoutMs: number; signal: boolean }[] = [];
  const wrapped = {
    ...f.effects,
    // Arm the recorder only once the receipt has been imported, i.e. the identity read under test.
    runCommand: async (...call: Parameters<typeof f.effects.runCommand>) => {
      // The bounded window starts at the identity read's first command (`symbolic-ref`); the
      // receipt import's own 30 s commands are outside it.
      if (imported && (inIdentityRead || call[1].includes('symbolic-ref'))) inIdentityRead = true;
      if (imported && inIdentityRead)
        calls.push({
          command: call[0],
          timeoutMs: call[2].timeoutMs,
          signal: call[2].signal !== undefined,
        });
      const result = await f.effects.runCommand(...call);
      return result;
    },
  };
  const recordingClient = {
    ...client,
    report: async (ref: QueueReference, root: string): Promise<QueueEvidence> => {
      const evidence = await client.report(ref, root);
      imported = true;
      return evidence;
    },
  };
  const before = f.effects.openLedger(f.state.branch).load();
  const debt = await loadCurrentDeferredVendorDebt(
    wrapped,
    'main',
    read.state,
    before,
    recordingClient,
    undefined,
    { remainingMs: () => 5_000 },
  );
  expect(debt?.reference.requestId).toBe(successor.reference.requestId);
  const gitCalls = calls.filter((call) => call.command === 'git');
  expect(gitCalls.length).toBeGreaterThan(0);
  for (const call of gitCalls) {
    expect(call.timeoutMs).toBeLessThanOrEqual(5_000);
    expect(call.signal).toBe(true);
  }
});
test('cancellation during the post-report identity read keeps the caller reason', async () => {
  const { f, predecessor, terminal, successorStatus, read } = await successorWithPendingAncestor();
  const controller = new AbortController();
  const reason = new Error('caller cancelled during the bounded identity read');
  let imported = false;
  const client = {
    ...terminal.client,
    status: async (ref: QueueReference): Promise<QueueStatus> =>
      ref.requestId === predecessor.reference.requestId
        ? terminal.client.status()
        : successorStatus,
    report: async (ref: QueueReference, root: string): Promise<QueueEvidence> => {
      const evidence = await terminal.client.report(ref, root);
      imported = true;
      return evidence;
    },
  };
  const before = f.effects.openLedger(f.state.branch).load();
  const effects = {
    ...f.effects,
    runCommand: async (...call: Parameters<typeof f.effects.runCommand>) => {
      if (imported) controller.abort(reason);
      return f.effects.runCommand(...call);
    },
  };
  await expect(
    loadCurrentDeferredVendorDebt(effects, 'main', read.state, before, client, controller.signal),
  ).rejects.toBe(reason);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});
test('budget exhaustion during the post-report identity read truncates nonfatally', async () => {
  const { f, predecessor, terminal, successorStatus, successor, read } =
    await successorWithPendingAncestor();
  let exhausted = false;
  const client = {
    ...terminal.client,
    status: async (ref: QueueReference): Promise<QueueStatus> =>
      ref.requestId === predecessor.reference.requestId
        ? terminal.client.status()
        : successorStatus,
    report: async (ref: QueueReference, root: string): Promise<QueueEvidence> => {
      const evidence = await terminal.client.report(ref, root);
      exhausted = true;
      return evidence;
    },
  };
  // An "unbounded" dispatch is one with neither the invocation signal nor a budget-clamped timeout;
  // the receipt import's own signal-bound 30 s commands are not unbounded and are not counted.
  let unboundedAfterExhaustion = 0;
  const effects = {
    ...f.effects,
    runCommand: async (...call: Parameters<typeof f.effects.runCommand>) => {
      if (exhausted && call[2].signal === undefined && call[2].timeoutMs > 5_000)
        unboundedAfterExhaustion += 1;
      return f.effects.runCommand(...call);
    },
  };
  const before = f.effects.openLedger(f.state.branch).load();
  const debt = await loadCurrentDeferredVendorDebt(
    effects,
    'main',
    read.state,
    before,
    client,
    undefined,
    { remainingMs: () => (exhausted ? 0 : 5_000) },
  );
  expect(debt?.reference.requestId).toBe(successor.reference.requestId);
  // Nothing unbounded is dispatched once the budget is gone: the wait is bounded, not re-checked late.
  expect(unboundedAfterExhaustion).toBe(0);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});
test('an in-flight caller abort resolved by the adapter keeps the exact caller reason', async () => {
  const { f, predecessor, terminal, successorStatus, read } = await successorWithPendingAncestor();
  const controller = new AbortController();
  const reason = new Error('caller cancelled in-flight during the bounded identity read');
  let imported = false;
  const client = {
    ...terminal.client,
    status: async (ref: QueueReference): Promise<QueueStatus> =>
      ref.requestId === predecessor.reference.requestId
        ? terminal.client.status()
        : successorStatus,
    report: async (ref: QueueReference, root: string): Promise<QueueEvidence> => {
      const evidence = await terminal.client.report(ref, root);
      imported = true;
      return evidence;
    },
  };
  const before = f.effects.openLedger(f.state.branch).load();
  const effects = {
    ...f.effects,
    runCommand: async (...call: Parameters<typeof f.effects.runCommand>) => {
      // The bounded identity read opens with `symbolic-ref`: abort there and hand back the
      // adapter-shaped aborted result, exactly as the real seam does.
      if (imported && call[0] === 'git' && call[1].includes('symbolic-ref')) {
        controller.abort(reason);
        return adapterAborted();
      }
      return f.effects.runCommand(...call);
    },
  };
  await expect(
    loadCurrentDeferredVendorDebt(effects, 'main', read.state, before, client, controller.signal),
  ).rejects.toBe(reason);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});
test('an in-flight invocation deadline resolved as a timeout truncates nonfatally', async () => {
  const { f, predecessor, terminal, successorStatus, successor, read } =
    await successorWithPendingAncestor();
  let imported = false;
  let exhausted = false;
  const client = {
    ...terminal.client,
    status: async (ref: QueueReference): Promise<QueueStatus> =>
      ref.requestId === predecessor.reference.requestId
        ? terminal.client.status()
        : successorStatus,
    report: async (ref: QueueReference, root: string): Promise<QueueEvidence> => {
      const evidence = await terminal.client.report(ref, root);
      imported = true;
      return evidence;
    },
  };
  const before = f.effects.openLedger(f.state.branch).load();
  const effects = {
    ...f.effects,
    runCommand: async (...call: Parameters<typeof f.effects.runCommand>) => {
      if (imported && call[0] === 'git' && call[1].includes('symbolic-ref')) {
        // The clamped command times out: the budget is now gone and the adapter resolves a failed
        // result rather than rejecting.
        exhausted = true;
        return adapterTimedOut();
      }
      return f.effects.runCommand(...call);
    },
  };
  const debt = await loadCurrentDeferredVendorDebt(
    effects,
    'main',
    read.state,
    before,
    client,
    undefined,
    { remainingMs: () => (exhausted ? 0 : 5_000) },
  );
  expect(debt?.reference.requestId).toBe(successor.reference.requestId);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});
test('an unrelated identity read failure remains hard', async () => {
  const { f, predecessor, terminal, successorStatus, read } = await successorWithPendingAncestor();
  let imported = false;
  const client = {
    ...terminal.client,
    status: async (ref: QueueReference): Promise<QueueStatus> =>
      ref.requestId === predecessor.reference.requestId
        ? terminal.client.status()
        : successorStatus,
    report: async (ref: QueueReference, root: string): Promise<QueueEvidence> => {
      const evidence = await terminal.client.report(ref, root);
      imported = true;
      return evidence;
    },
  };
  const before = f.effects.openLedger(f.state.branch).load();
  const effects = {
    ...f.effects,
    runCommand: async (...call: Parameters<typeof f.effects.runCommand>) => {
      // A timeout result while the budget REMAINS is not this invocation's deadline.
      if (imported && call[0] === 'git' && call[1].includes('symbolic-ref'))
        return adapterTimedOut();
      return f.effects.runCommand(...call);
    },
  };
  await expect(
    loadCurrentDeferredVendorDebt(effects, 'main', read.state, before, client, undefined, {
      remainingMs: () => 5_000,
    }),
  ).rejects.toThrow('deferred invocation identity changed while settling authorized ancestry');
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});
