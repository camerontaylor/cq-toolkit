// Split provenance: test/ops/review/settledPredecessorFindings.test.ts was split into the
// settledPredecessorFindings.*.test.ts siblings in this directory; shared fixtures live in
// settledPredecessorFindings.helpers.ts.
import { expect, test } from 'vitest';
import type { DeferredVendorDebt } from '../../../src/ops/dev/internal/deferredReview.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import { assembleReadiness } from '../../../src/ops/dev/record.js';
import type { QueueEvidence } from '../../../src/ops/review/internal/queueEvidence.js';
import type {
  QueueReference,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import {
  cleanDrivers,
  fixtureFactory,
  successorReceipt,
} from './settledPredecessorFindings.helpers.js';

const fixture = fixtureFactory();

test('a superseded older-head predecessor permits a clean run and stays an outstanding obligation', async () => {
  const f = await fixture();
  const predecessor = f.debt;
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  f.repo.commitAll('new head');
  const read = await readWorkState(f.effects, { target: 'main' });
  if (!read.ok) throw new Error(read.reason);
  const head = read.state.head;
  const evidence = await successorReceipt(f, 'successor', head);
  const binding = predecessor.reference.binding;
  if (binding.kind !== 'deferred-author') throw new Error('fixture debt must be deferred-author');
  const successor: DeferredVendorDebt = {
    reference: {
      requestId: 'successor',
      binding: { ...binding, head },
    },
    originAttempt: predecessor.originAttempt,
    deferral: { id: 'successor', base: read.state.base, dirtySha256: 'clean-tree' },
    predecessor: predecessor.reference,
    queue: {
      ...predecessor.queue,
      state: 'terminal-clean',
      pr: 42,
      mergeSha: head,
      itemId: 'successor-item',
      receiptId: evidence.receiptId,
      consumed: true,
      reviewed: true,
    },
    vendor: 'vendor-completed',
    vendorCompleted: true,
    completion: evidence,
  };
  f.effects.openLedger(f.state.branch).save({
    version: 2,
    branch: f.state.branch,
    records: [
      ...f.effects.openLedger(f.state.branch).load().records,
      { kind: 'vendor-debt', debt: successor, at: f.effects.nowIso() },
    ],
  });
  const client = {
    ...f.client,
    status: async (ref: QueueReference): Promise<QueueStatus> =>
      ref.requestId === predecessor.reference.requestId
        ? { ...predecessor.queue, state: 'awaiting-pr', pr: null }
        : successor.queue,
    report: async (): Promise<QueueEvidence> => evidence,
  };
  const result = await makeReviewRun({
    drivers: cleanDrivers(),
    queueClient: client,
    effectsFactory: () => f.effects,
    scannerFactory: () => async (components) =>
      components.map((component) => ({ component: component.component, hits: [] })),
  })({ repoRoot: f.repo.root });
  // RUN acceptance: the completed successor at this head is the authority; the superseded
  // older-head predecessor does not refuse it (its obligation is carried, never credited).
  expect(result.status, JSON.stringify(result)).toBe('ok');
  // DURABLE readiness still reports the outstanding obligation.
  const readiness = assembleReadiness({
    branch: f.state.branch,
    target: 'main',
    identity: { head, base: read.state.base, dirtySha256: 'clean-tree' },
    ledger: f.effects.openLedger(f.state.branch).load(),
    untracked: [],
    configuredReviewers: ['agent', 'coderabbit'],
    deferredVendorDebt: successor,
    nowIso: f.effects.nowIso(),
  });
  expect(readiness.ready).toBe(false);
  if (readiness.ready) throw Error('unexpected readiness');
  expect(readiness.gaps.map((gap) => gap.detail).join(' ')).toContain(
    'authorized predecessor obligation(s) unsettled:',
  );
  const settled = f.effects.openLedger(f.state.branch).load();
  const pending = settled.records.filter(
    (entry) =>
      entry.kind === 'vendor-debt' &&
      entry.debt.reference.requestId === predecessor.reference.requestId,
  );
  expect(pending).toHaveLength(1);
  expect(pending[0]!.kind === 'vendor-debt' && pending[0]!.debt.vendorCompleted).toBe(false);
});
