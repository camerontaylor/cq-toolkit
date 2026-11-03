import { expect, test } from 'vitest';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { QueueEvidence } from '../../../src/ops/review/internal/queueEvidence.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import {
  currentLedgerDebt,
  loadCurrentDeferredVendorDebt,
  prepareDeferredVendorReview,
  readCurrentEnrollment,
} from '../../../src/ops/dev/internal/deferredLedger.js';
import { assembleReadiness, DEV_LEDGER_VERSION } from '../../../src/ops/dev/record.js';
import type {
  DeferredQueueClient,
  QueueReference,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import {
  fixture,
  terminalReport,
  syntheticDebt,
  pendingTemplate,
  type PendingDebt,
} from './deferredLedgerHelpers.js';

test('a completed predecessor appended after its successor never displaces the current enrollment', async () => {
  const f = await fixture();
  const predecessor = f.debt;
  // The predecessor's receipt is captured at its own head, before HEAD moves.
  const terminal = terminalReport(f);
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  f.repo.git('add', 'src/a.ts');
  f.repo.git('commit', '-qm', 'new head');
  const read = await readWorkState(f.effects, { target: 'main' });
  if (!read.ok) throw new Error(read.reason);
  const successorStatus: QueueStatus = { ...f.debt.queue, state: 'awaiting-pr', pr: null };
  const client: DeferredQueueClient = {
    ...f.client,
    enqueue: async () => successorStatus,
    status: async () => successorStatus,
    cancel: async () => {
      throw new Error('must not cancel a published predecessor');
    },
  };
  const successor = await prepareDeferredVendorReview(f.effects, 'main', read.state, client);
  if (!successor) throw new Error('missing successor');
  expect(successor.predecessor).toEqual(predecessor.reference);
  const terminalClient = {
    ...client,
    status: async (ref: QueueReference): Promise<QueueStatus> =>
      ref.requestId === predecessor.reference.requestId
        ? terminal.client.status()
        : successorStatus,
    report: terminal.client.report,
  };
  const ledger = f.effects.openLedger(f.state.branch).load();
  const refreshed = await loadCurrentDeferredVendorDebt(
    f.effects,
    'main',
    read.state,
    ledger,
    terminalClient,
  );
  // Only the current enrollment is returned; the settled predecessor is never authority.
  expect(refreshed?.reference.requestId).toBe(successor.reference.requestId);
  const after = f.effects.openLedger(f.state.branch).load();
  const appended = after.records.filter((entry) => entry.kind === 'vendor-debt').at(-1);
  if (appended?.kind !== 'vendor-debt') throw new Error('missing appended snapshot');
  expect(appended.debt.reference).toEqual(predecessor.reference);
  expect(appended.debt.vendorCompleted).toBe(true);
  expect(currentLedgerDebt(after, 'main', read.state)?.reference).toEqual(successor.reference);
  const authority = readCurrentEnrollment(
    after,
    { head: read.state.head, base: read.state.base, dirtySha256: read.state.dirtySha256 },
    'main',
  );
  if (authority.kind !== 'enrollment') throw new Error('missing current authority');
  expect(authority.enrollment.debt.reference).toEqual(successor.reference);
  expect(authority.enrollment.pendingAncestry).toEqual([]);
  // Readiness for the successor identity sees no unsettled ancestry: the settled predecessor is
  // an imported obligation, never a lineage gap.
  const readiness = assembleReadiness({
    branch: f.state.branch,
    target: 'main',
    identity: { head: read.state.head, base: read.state.base, dirtySha256: read.state.dirtySha256 },
    ledger: after,
    untracked: [],
    configuredReviewers: ['agent', 'coderabbit'],
    deferredVendorDebt: successor,
    nowIso: f.effects.nowIso(),
  });
  // Join the details: an array `toContain` compares whole elements and could never fail here.
  expect(readiness.ready ? '' : readiness.gaps.map((gap) => gap.detail).join(' ')).not.toContain(
    'authorized predecessor obligation(s) unsettled:',
  );

  // Replay is inert: no second snapshot, no re-acknowledgement.
  const replay = await loadCurrentDeferredVendorDebt(
    f.effects,
    'main',
    read.state,
    after,
    terminalClient,
  );
  expect(replay?.reference.requestId).toBe(successor.reference.requestId);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(after);
});
test('the authorized-predecessor pass stops nonfatally at the count backstop', async () => {
  const f = await fixture();
  const ancestors: PendingDebt[] = [];
  let link: QueueReference | undefined;
  for (let index = 0; index < 17; index += 1) {
    const ancestor = syntheticDebt(
      pendingTemplate(f.debt),
      `ancestor-${String(index).padStart(2, '0')}`,
      `${String(index).padStart(2, '0')}${'b'.repeat(38)}`,
      link,
    );
    ancestors.push(ancestor);
    link = ancestor.reference;
  }
  const current = syntheticDebt(
    pendingTemplate(f.debt),
    f.debt.reference.requestId,
    f.state.head,
    link,
  );
  const records = f.ledger.records.filter((entry) => entry.kind !== 'vendor-debt');
  f.effects.openLedger(f.state.branch).save({
    version: DEV_LEDGER_VERSION,
    branch: f.state.branch,
    records: [
      ...records,
      ...ancestors.map((debt) => ({ kind: 'vendor-debt' as const, debt, at: f.effects.nowIso() })),
      { kind: 'vendor-debt' as const, debt: current, at: f.effects.nowIso() },
    ],
  });
  const refreshed: string[] = [];
  const client: DeferredQueueClient = {
    ...f.client,
    status: async (ref) => {
      if (ref.requestId.startsWith('ancestor-')) refreshed.push(ref.requestId);
      return { ...f.debt.queue, state: 'awaiting-pr', pr: null };
    },
  };
  const ledger = f.effects.openLedger(f.state.branch).load();
  const debt = await loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, ledger, client);
  // Truncation is nonfatal: the current enrollment is still returned...
  expect(debt?.reference.requestId).toBe(current.reference.requestId);
  // ...after exactly K refreshes, oldest first (FIFO), never renewing the budget...
  expect(refreshed).toHaveLength(16);
  expect(refreshed).toEqual(ancestors.slice(0, 16).map((ancestor) => ancestor.reference.requestId));
  expect(refreshed).not.toContain('ancestor-16');
  // ...and nothing is appended: an unsettled obligation stays visible to readiness.
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(ledger);
  const authority = readCurrentEnrollment(
    ledger,
    { head: f.state.head, base: f.state.base, dirtySha256: f.state.dirtySha256 },
    'main',
  );
  if (authority.kind !== 'enrollment') throw new Error('missing current authority');
  expect(authority.enrollment.pendingAncestry).toHaveLength(17);
  const readiness = f.assemble(ledger, current);
  expect(readiness.ready).toBe(false);
  if (readiness.ready) throw new Error('unexpected readiness');
  expect(readiness.gaps.map((gap) => gap.detail).join(' ')).toContain(
    'authorized predecessor obligation(s) unsettled:',
  );
});
test('the invocation budget covers current work and fails closed before any predecessor refresh', async () => {
  const f = await fixture();
  let calls = 0;
  const remainingMs = () => {
    calls += 1;
    return calls === 1 ? 5_000 : 0;
  };
  const before = f.effects.openLedger(f.state.branch).load();
  const refreshed: string[] = [];
  const client: DeferredQueueClient = {
    ...f.client,
    status: async (ref) => {
      refreshed.push(ref.requestId);
      return f.debt.queue;
    },
  };
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, before, client, undefined, {
      remainingMs,
    }),
  ).rejects.toThrow();
  expect(refreshed).toEqual([]);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});
test('a caller abort bounds each RPC and leaves a late terminal value inert', async () => {
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
  const controller = new AbortController();
  const client = {
    ...f.client,
    status: async (ref: QueueReference): Promise<QueueStatus> => {
      if (ref.requestId !== predecessor.reference.requestId) return successorStatus;
      controller.abort(new Error('caller cancelled'));
      await new Promise((resolve) => setTimeout(resolve, 5));
      return terminal.client.status();
    },
    report: terminal.client.report,
  };
  const before = f.effects.openLedger(f.state.branch).load();
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'main', read.state, before, client, controller.signal),
  ).rejects.toThrow(/caller cancelled/);
  // The late terminal value was never imported, acknowledged or persisted.
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});
test('unrelated roots gain no authority and same-identity duplicates become gaps', async () => {
  const f = await fixture();
  const identity = { head: f.state.head, base: f.state.base, dirtySha256: f.state.dirtySha256 };
  const unrelated = syntheticDebt(pendingTemplate(f.debt), 'other-root', 'f'.repeat(40));
  const withUnrelated = {
    ...f.ledger,
    records: [
      ...f.ledger.records,
      { kind: 'vendor-debt' as const, debt: unrelated, at: f.effects.nowIso() },
    ],
  };
  const read = readCurrentEnrollment(withUnrelated, identity, 'main');
  if (read.kind !== 'enrollment') throw new Error('unrelated root displaced the enrollment');
  expect(read.enrollment.debt.reference).toEqual(f.debt.reference);
  expect(read.enrollment.ancestry).toEqual([]);
  expect(read.enrollment.pendingAncestry).toEqual([]);
  expect(currentLedgerDebt(withUnrelated, 'main', f.state)?.reference).toEqual(f.debt.reference);

  const duplicate = syntheticDebt(pendingTemplate(f.debt), 'intent-2', f.state.head);
  const ambiguous = {
    ...f.ledger,
    records: [
      ...f.ledger.records,
      { kind: 'vendor-debt' as const, debt: duplicate, at: f.effects.nowIso() },
    ],
  };
  const ambiguousRead = readCurrentEnrollment(ambiguous, identity, 'main');
  expect(ambiguousRead.kind).toBe('ambiguous');
  if (ambiguousRead.kind !== 'ambiguous') throw new Error('unreachable');
  expect([...ambiguousRead.requestIds].sort()).toEqual(['intent-1', 'intent-2']);
  const readiness = f.assemble(ambiguous, f.debt);
  expect(readiness.ready).toBe(false);
  if (readiness.ready) throw new Error('unexpected readiness');
  expect(readiness.gaps.map((gap) => gap.detail).join(' ')).toContain(
    'ambiguous current enrollment',
  );
});
test('a caller abort before the next wrapped call never dispatches it', async () => {
  const f = await fixture();
  const terminal = terminalReport(f);
  const controller = new AbortController();
  const reason = new Error('caller cancelled before dispatch');
  let reported = 0;
  let statused = 0;
  const client = {
    ...terminal.client,
    status: async (): Promise<QueueStatus> => {
      statused += 1;
      return terminal.client.status();
    },
    report: async (ref: QueueReference, root: string): Promise<QueueEvidence> => {
      reported += 1;
      return terminal.client.report(ref, root);
    },
  };
  const before = f.effects.openLedger(f.state.branch).load();
  const evidenceDir = join(f.repo.root, '.cq', 'queue-evidence');
  const effects = {
    ...f.effects,
    runCommand: async (...call: Parameters<typeof f.effects.runCommand>) => {
      const result = await f.effects.runCommand(...call);
      const [command, args] = call;
      // Cancellation lands while the forge identity read is in flight, before any wrapped queue
      // call is attempted.
      if (command === 'gh' && args.includes('nameWithOwner')) controller.abort(reason);
      return result;
    },
  };
  await expect(
    loadCurrentDeferredVendorDebt(effects, 'main', f.state, before, client, controller.signal),
  ).rejects.toThrow(reason);
  // The wrapper refuses BEFORE dispatch: no status, no report, no ack, no import, no append.
  expect(statused).toBe(0);
  expect(reported).toBe(0);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
  await expect(readdir(evidenceDir)).rejects.toThrow();
});
test('a caller abort at the ancestry boundary outranks a zero budget and keeps its reason', async () => {
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
  const controller = new AbortController();
  const reason = new Error('caller cancelled at the ancestry boundary');
  let exhausted = false;
  const remainingMs = () => (exhausted ? 0 : 5_000);
  const store = f.effects.openLedger(f.state.branch);
  const before = store.load();
  const refreshedAncestors: string[] = [];
  const client = {
    ...terminal.client,
    status: async (ref: QueueReference): Promise<QueueStatus> => {
      if (ref.requestId === predecessor.reference.requestId) refreshedAncestors.push(ref.requestId);
      return successorStatus;
    },
  };
  let loads = 0;
  const effects = {
    ...f.effects,
    openLedger: () => ({
      ...store,
      // The final ledger read is the last local step before the ancestry boundary.
      load: () => {
        const ledger = store.load();
        loads += 1;
        if (loads === 1) {
          exhausted = true;
          controller.abort(reason);
        }
        return ledger;
      },
    }),
  };
  await expect(
    loadCurrentDeferredVendorDebt(effects, 'main', read.state, before, client, controller.signal, {
      remainingMs,
    }),
  ).rejects.toThrow(reason);
  // The caller's cancellation is the reason, never a silent nonfatal truncation.
  expect(refreshedAncestors).toEqual([]);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});
