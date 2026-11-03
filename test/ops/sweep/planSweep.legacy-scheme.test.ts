// Split provenance: test/ops/sweep/planSweep.test.ts was split into
// planSweep.{selector,selection,ledger,jobs,legacy-scheme,signature,subprocess}.test.ts
// plus planSweep.helpers.ts (shared fixtures). This file carries the W4.4
// legacy-scheme escalation guard.
import { describe, expect, test } from 'vitest';
import type { CheckFailure } from '../../../src/ops/gates/checkRunner.js';
import { ledgerSignature, legacyLedgerSignature } from '../../../src/ops/sweep/planSweep.js';
import { baseInput, failedPlan, okPlan, plannerWithLedger } from './planSweep.helpers.js';

describe('planSweep legacy-scheme escalation guard (W4.4 signature change)', () => {
  const LEDGER_CONFIG = { root: '.cq', storePath: '.cq/ledger.json' };
  /** A located Vitest assertion failure: scheme 1 keyed it by position, scheme 2 by test name. */
  const VITEST_FAILURE: CheckFailure = {
    file: 'packages/core/a.test.ts',
    line: 10,
    column: 3,
    ruleId: null,
    message: 'suite > handles iso dates',
    severity: 'error',
  };
  const current = ledgerSignature(VITEST_FAILURE, 'vitest');
  const legacy = legacyLedgerSignature(VITEST_FAILURE, 'vitest') as string;
  const baseline = { package: 'core', signature: current, legacySignature: legacy };

  test('the scheme change really moved this failure (precondition)', () => {
    expect(legacy).not.toBeNull();
    expect(legacy).not.toBe(current);
  });

  test('an old-scheme needsHuman row keeps the package escalated', async () => {
    const report = await okPlan(
      plannerWithLedger([{ signature: legacy, count: 4 }]),
      baseInput({ ledger: LEDGER_CONFIG, baselineSignatures: [baseline] }),
    );
    expect(report.needsHuman).toEqual([{ package: 'core', signature: legacy }]);
    // Legacy rows never suppress: the package is escalated AND re-planned.
    expect(report.suppressed).toEqual([]);
    expect(report.units.map((u) => u.package)).toContain('core');
  });

  test('an old-scheme knownNoise row no longer suppresses', async () => {
    const report = await okPlan(
      plannerWithLedger([{ signature: legacy, count: 2 }]),
      baseInput({ ledger: LEDGER_CONFIG, baselineSignatures: [baseline] }),
    );
    expect(report.suppressed).toEqual([]);
    expect(report.needsHuman).toEqual([]);
    expect(report.units.map((u) => u.package)).toContain('core');
  });

  test('new-scheme rows behave as before: noise suppresses, escalation routes', async () => {
    const noise = await okPlan(
      plannerWithLedger([{ signature: current, count: 2 }]),
      baseInput({ ledger: LEDGER_CONFIG, baselineSignatures: [baseline] }),
    );
    expect(noise.suppressed.map((s) => s.package)).toEqual(['core']);
    expect(noise.needsHuman).toEqual([]);
    const human = await okPlan(
      plannerWithLedger([{ signature: current, count: 4 }]),
      baseInput({ ledger: LEDGER_CONFIG, baselineSignatures: [baseline] }),
    );
    expect(human.suppressed.map((s) => s.package)).toEqual(['core']);
    expect(human.needsHuman).toEqual([{ package: 'core', signature: current }]);
  });

  test('both schemes escalated route both rows, current first; an equal legacy signature never duplicates', async () => {
    const both = await okPlan(
      plannerWithLedger(
        [
          { signature: current, count: 3 },
          { signature: legacy, count: 3 },
        ].sort((a, b) => (a.signature < b.signature ? -1 : 1)),
      ),
      baseInput({ ledger: LEDGER_CONFIG, baselineSignatures: [baseline] }),
    );
    expect(both.needsHuman).toEqual([
      { package: 'core', signature: current },
      { package: 'core', signature: legacy },
    ]);
    const same = await okPlan(
      plannerWithLedger([{ signature: current, count: 3 }]),
      baseInput({
        ledger: LEDGER_CONFIG,
        baselineSignatures: [{ package: 'core', signature: current, legacySignature: current }],
      }),
    );
    expect(same.needsHuman).toEqual([{ package: 'core', signature: current }]);
  });

  test('a legacy signature of a non-manifest package routes nowhere', async () => {
    const report = await okPlan(
      plannerWithLedger([{ signature: legacy, count: 4 }]),
      baseInput({
        ledger: LEDGER_CONFIG,
        baselineSignatures: [{ ...baseline, package: 'ghost' }],
      }),
    );
    expect(report.needsHuman).toEqual([]);
  });

  test('a malformed legacySignature fails the plan rather than being dropped (fail closed)', async () => {
    const error = await failedPlan(
      plannerWithLedger([]),
      baseInput({
        ledger: LEDGER_CONFIG,
        baselineSignatures: [{ package: 'core', signature: current, legacySignature: '' }],
      }),
    );
    expect(error).toMatch(/baselineSignatures\[0\]\.legacySignature must be a non-empty string/);
  });
});
