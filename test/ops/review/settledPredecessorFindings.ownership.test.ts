// Split provenance: test/ops/review/settledPredecessorFindings.test.ts was split into the
// settledPredecessorFindings.*.test.ts siblings in this directory; shared fixtures live in
// settledPredecessorFindings.helpers.ts.
import { expect, test, vi } from 'vitest';
import type {
  DeferredQueueClient,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { cycleRecord } from '../dev/fakes.js';
import { cleanDrivers, fixtureFactory } from './settledPredecessorFindings.helpers.js';

const fixture = fixtureFactory();

test('failing post-enrollment status read owns the durable append; replay stays fail-closed', async () => {
  const f = await fixture();
  // Fresh enrollment shape: keep the retained blocked origin cycle, drop the seeded debt.
  const seeded = f.effects.openLedger(f.state.branch).load();
  f.effects.openLedger(f.state.branch).save({
    ...seeded,
    records: seeded.records.filter((entry) => entry.kind !== 'vendor-debt'),
  });
  const awaiting: QueueStatus = {
    state: 'awaiting-pr',
    pr: null,
    mergeSha: null,
    itemId: null,
    receiptId: null,
    consumed: false,
    reviewed: false,
    fixed: false,
  };
  const notes: { enrolled: boolean; beforeVendor: boolean }[] = [];
  const note = vi.fn(async () => {
    const latest = f.effects.openLedger(f.state.branch).load();
    notes.push({
      enrolled: latest.records.some(
        (entry) => entry.kind === 'vendor-debt' && !entry.debt.vendorCompleted,
      ),
      beforeVendor: !f.effects.calls.some((call) => call.command === 'coderabbit'),
    });
  });
  const run = (client: DeferredQueueClient) =>
    makeReviewRun({
      drivers: cleanDrivers(),
      queueClient: client,
      effectsFactory: () => f.effects,
      noteLedgerWrite: note,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: f.repo.root });

  // Enrollment persists through enqueue; the following current-debt status read fails.
  const failStatus: DeferredQueueClient = {
    ...f.client,
    status: async () => {
      throw new Error('status read failed after durable enrollment');
    },
  };
  const first = await run(failStatus);
  expect(first.status, JSON.stringify(first)).toBe('indeterminate');
  if (first.status !== 'indeterminate') throw Error(JSON.stringify(first));
  expect(first.detail).toContain('status read failed after durable enrollment');
  expect(note).toHaveBeenCalledTimes(1);
  expect(notes[0]!).toEqual({ enrolled: true, beforeVendor: true });
  expect(f.effects.calls.filter((c) => c.command === 'coderabbit')).toHaveLength(0);
  let ledger = f.effects.openLedger(f.state.branch).load();
  const enrolled = ledger.records.filter((r) => r.kind === 'vendor-debt');
  expect(enrolled).toHaveLength(1);
  expect(enrolled[0]!.debt.vendorCompleted).toBe(false);

  // Replay with no new mutation: the same failing read never notifies again.
  const second = await run(failStatus);
  expect(second.status, JSON.stringify(second)).toBe('indeterminate');
  expect(note).toHaveBeenCalledTimes(1);

  // Replay after unrelated external bytes refuses to persist successor debt.
  await f.repo.write('src/a.ts', 'export const a = 3;\n');
  f.repo.commitAll('moved head');
  const poisoned: DeferredQueueClient = {
    ...f.client,
    status: async () => {
      const latest = f.effects.openLedger(f.state.branch).load();
      if (
        !latest.records.some(
          (entry) => entry.kind === 'cycle' && entry.cycleId === 'c911-unrelated',
        )
      )
        f.effects.openLedger(f.state.branch).save({
          ...latest,
          records: [
            ...latest.records,
            cycleRecord({ head: f.state.head, base: f.state.base, cycleId: 'c911-unrelated' }),
          ],
        });
      return awaiting;
    },
  };
  const third = await run(poisoned);
  expect(third.status, JSON.stringify(third)).toBe('indeterminate');
  if (third.status !== 'indeterminate') throw Error(JSON.stringify(third));
  expect(third.detail).toContain('deferred ledger changed; replay the same successor');
  // The external bytes are not the engine-requested mutation, so even though
  // the ledger changed, no ownership notification may bless them.
  expect(note).toHaveBeenCalledTimes(1);
  ledger = f.effects.openLedger(f.state.branch).load();
  expect(ledger.records.filter((r) => r.kind === 'vendor-debt')).toHaveLength(1);
});

test('unrelated durable bytes appended during a failing status throw never own the attempt', async () => {
  const f = await fixture();
  // Fresh enrollment shape: keep the retained blocked origin cycle, drop the seeded debt.
  const seeded = f.effects.openLedger(f.state.branch).load();
  f.effects.openLedger(f.state.branch).save({
    ...seeded,
    records: seeded.records.filter((entry) => entry.kind !== 'vendor-debt'),
  });
  const note = vi.fn(async () => {});
  const client: DeferredQueueClient = {
    ...f.client,
    status: async () => {
      const latest = f.effects.openLedger(f.state.branch).load();
      f.effects.openLedger(f.state.branch).save({
        ...latest,
        records: [
          ...latest.records,
          cycleRecord({ head: f.state.head, base: f.state.base, cycleId: 'c913-external-append' }),
        ],
      });
      throw new Error('status read failed after external append');
    },
  };
  const result = await makeReviewRun({
    drivers: cleanDrivers(),
    queueClient: client,
    effectsFactory: () => f.effects,
    noteLedgerWrite: note,
    scannerFactory: () => async (components) =>
      components.map((component) => ({ component: component.component, hits: [] })),
  })({ repoRoot: f.repo.root });
  expect(result.status, JSON.stringify(result)).toBe('indeterminate');
  if (result.status !== 'indeterminate') throw Error(JSON.stringify(result));
  // The original status error survives, and the ownership callback is never
  // invoked for bytes the engine did not request, even though its own durable
  // enrollment resolved first.
  expect(result.detail).toContain('status read failed after external append');
  expect(note).not.toHaveBeenCalled();
  const ledger = f.effects.openLedger(f.state.branch).load();
  expect(ledger.records.filter((entry) => entry.kind === 'vendor-debt')).toHaveLength(1);
  expect(
    ledger.records.some(
      (entry) => entry.kind === 'cycle' && entry.cycleId === 'c913-external-append',
    ),
  ).toBe(true);
});
