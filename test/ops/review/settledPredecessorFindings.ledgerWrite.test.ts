// Split provenance: test/ops/review/settledPredecessorFindings.test.ts was split into the
// settledPredecessorFindings.*.test.ts siblings in this directory; shared fixtures live in
// settledPredecessorFindings.helpers.ts.
import { expect, test, vi } from 'vitest';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { cleanDrivers, fixtureFactory } from './settledPredecessorFindings.helpers.js';

const fixture = fixtureFactory();

test('a rejected durable ledger write never owns the attempt', async () => {
  const f = await fixture();
  const seeded = f.effects.openLedger(f.state.branch).load();
  f.effects.openLedger(f.state.branch).save({
    ...seeded,
    records: seeded.records.filter((entry) => entry.kind !== 'vendor-debt'),
  });
  const before = f.effects.openLedger(f.state.branch).load();
  const note = vi.fn(async () => {});
  // The store rejects the engine's own requested mutation: nothing durable was
  // accepted, so no ownership notification may follow.
  const failing = {
    ...f.effects,
    openLedger: (branch: string): ReturnType<typeof f.effects.openLedger> => {
      const store = f.effects.openLedger(branch);
      return {
        load: () => store.load(),
        save: (file) => store.save(file),
        mutate: <T>() => Promise.reject<T>(new Error('durable ledger write failed')),
      };
    },
  };
  const result = await makeReviewRun({
    drivers: cleanDrivers(),
    queueClient: f.client,
    effectsFactory: () => failing,
    noteLedgerWrite: note,
    scannerFactory: () => async (components) =>
      components.map((component) => ({ component: component.component, hits: [] })),
  })({ repoRoot: f.repo.root });
  expect(result.status, JSON.stringify(result)).toBe('indeterminate');
  if (result.status !== 'indeterminate') throw Error(JSON.stringify(result));
  expect(result.detail).toContain('durable ledger write failed');
  expect(note).not.toHaveBeenCalled();
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});
