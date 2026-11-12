import { managedTerminal } from '../dev/reviewTestKit.js';
// Split provenance: test/ops/review/settledPredecessorFindings.test.ts was split into the
// settledPredecessorFindings.*.test.ts siblings in this directory; shared fixtures live in
// settledPredecessorFindings.helpers.ts.
import { expect, test } from 'vitest';
import {
  prepareDeferredVendorReview,
  retainedReceiptFindings,
} from '../../../src/ops/dev/internal/deferredLedger.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { dispositionRecord } from '../dev/fakes.js';
import {
  cleanDrivers,
  fixtureFactory,
  terminalReport,
} from './settledPredecessorFindings.helpers.js';

const fixture = fixtureFactory();

test.each(['fixed', 'rejected'] as const)(
  'exact retained immutable receipt honors its later %s disposition',
  async (action) => {
    const f = await fixture();
    const terminal = terminalReport(f, [
      { type: 'finding', severity: 'major', comment: 'retained' },
    ]);
    await f.repo.write('src/a.ts', 'export const a = 2;\n');
    f.repo.commitAll('changed head');
    const current = await readWorkState(f.effects, { target: 'main' });
    if (!current.ok) throw Error(current.reason);
    expect(
      await prepareDeferredVendorReview(f.effects, 'main', current.state, terminal.client),
    ).toBeUndefined();
    const ledger = f.effects.openLedger(f.state.branch).load();
    const finding = retainedReceiptFindings(ledger)[0]!;
    ledger.records.push(
      dispositionRecord({ findingId: finding.id, action, head: current.state.head }),
    );
    f.effects.openLedger(f.state.branch).save(ledger);
    const result = await makeReviewRun({
      managedSubmit: managedTerminal([]),
      drivers: cleanDrivers(),
      queueClient: terminal.client,
      effectsFactory: () => f.effects,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: f.repo.root });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    if (result.status !== 'ok') throw Error(JSON.stringify(result));
    expect(result.value.findings).toContainEqual({
      ...finding,
      status: action,
      reason: 'addressed in the diff',
    });
    expect(result.report?.deferredVendorDebt).toBeUndefined();
  },
);
