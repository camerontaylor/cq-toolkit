import { managedTerminal } from '../dev/reviewTestKit.js';
// Split provenance: test/ops/review/settledPredecessorFindings.test.ts was split into the
// settledPredecessorFindings.*.test.ts siblings in this directory; shared fixtures live in
// settledPredecessorFindings.helpers.ts.
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { dispositionRecord } from '../dev/fakes.js';
import {
  cleanDrivers,
  fixtureFactory,
  terminalReport,
} from './settledPredecessorFindings.helpers.js';

const fixture = fixtureFactory();

test.each(['fixed', 'rejected'] as const)(
  'changed raw receipt cannot inherit %s from an older receipt ID',
  async (action) => {
    const f = await fixture();
    const terminal = terminalReport(f, [
      {
        type: 'finding',
        severity: 'major',
        fileName: 'src/a.ts',
        comment: 'same comment',
        codegenInstructions: 'original instruction',
      },
    ]);
    const oldId =
      'receipt-' +
      createHash('sha256').update(JSON.stringify(terminal.document)).digest('hex') +
      '#f1';
    terminal.document.findings[0]!['codegenInstructions'] = 'changed instruction';
    const ledger = f.effects.openLedger(f.state.branch).load();
    ledger.records.push(dispositionRecord({ findingId: oldId, action, head: f.state.head }));
    f.effects.openLedger(f.state.branch).save(ledger);
    await f.repo.write('src/a.ts', 'export const a = 2;\n');
    f.repo.commitAll('changed head');
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
    const finding = result.value.findings.find((item) => item.text === 'changed instruction');
    expect(finding).toMatchObject({ status: 'open', severity: 'major' });
    expect(finding?.id).not.toBe(oldId);
    expect(result.value.findings.some((item) => item.id === oldId)).toBe(false);
  },
);
