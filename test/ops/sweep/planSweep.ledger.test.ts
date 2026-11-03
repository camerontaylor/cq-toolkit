// Split provenance: test/ops/sweep/planSweep.test.ts was split into
// planSweep.{selector,selection,ledger,jobs,legacy-scheme,signature,subprocess}.test.ts
// plus planSweep.helpers.ts (shared fixtures). This file carries the ledger
// consult: suppression, needsHuman routing, and query-fault behaviour.
import { describe, expect, test } from 'vitest';
import type { LedgerEntry, LedgerQueryInput } from '../../../src/ops/ledger/ledger.js';
import { makeLedgerQuery } from '../../../src/ops/ledger/ledger.js';
import { makePlanSweep } from '../../../src/ops/sweep/planSweep.js';
import {
  baseInput,
  changed,
  EMPTY_VIEW,
  failedPlan,
  makePlanner,
  memoryStore,
  okPlan,
  PACKAGES,
  plannerWithLedger,
} from './planSweep.helpers.js';

// ---------------------------------------------------------------------------
// 3. The ledger consult (UC §1 row 8)
// ---------------------------------------------------------------------------

describe('planSweep ledger suppression (UC §1 row 8 / R2 D6)', () => {
  // knownNoise = [sig-human, sig-noise], needsHuman = [sig-human].
  const LEDGER: LedgerEntry[] = [
    { signature: 'sig-noise', count: 2 },
    { signature: 'sig-human', count: 4 },
    { signature: 'sig-fresh', count: 1 },
  ];

  /** The consult trigger: without a ledger config the planner never queries. */
  const LEDGER_CONFIG = { root: '.cq', storePath: '.cq/ledger.json' };

  test('a fully-known-noise package contributes NO fix units and lands in suppressed', async () => {
    const report = await okPlan(
      plannerWithLedger(LEDGER),
      baseInput({
        fixers: ['lint', 'format'],
        ledger: LEDGER_CONFIG,
        baselineSignatures: [
          { package: 'core', signature: 'sig-noise' },
          { package: 'web', signature: 'sig-fresh' },
        ],
      }),
    );
    // core suppressed; the remaining 3 packages × 2 fixers all plan.
    expect(report.units.map((u) => u.package)).toEqual([
      'core-tests',
      'core-tests',
      'cli',
      'cli',
      'web',
      'web',
    ]);
    expect(report.jobs).toHaveLength(6);
    expect(report.suppressed).toEqual([
      { package: 'core', reason: 'all 1 baseline signature(s) are known ledger noise' },
    ]);
    expect(report.needsHuman).toEqual([]);
  });

  test('an escalated baseline signature routes to needsHuman, and its package is still suppressed', async () => {
    const report = await okPlan(
      plannerWithLedger(LEDGER),
      baseInput({
        ledger: LEDGER_CONFIG,
        baselineSignatures: [{ package: 'cli', signature: 'sig-human' }],
      }),
    );
    // needsHuman ⊆ knownNoise (the planner-contract fixture), so the
    // package is suppressed AND the signature is routed to a human.
    expect(report.suppressed.map((s) => s.package)).toEqual(['cli']);
    expect(report.needsHuman).toEqual([{ package: 'cli', signature: 'sig-human' }]);
    expect(report.units.map((u) => u.package)).toEqual(['core', 'core-tests', 'web']);
  });

  test('a mixed package (one fresh, one known-noise signature) is NOT suppressed', async () => {
    const report = await okPlan(
      plannerWithLedger(LEDGER),
      baseInput({
        ledger: LEDGER_CONFIG,
        baselineSignatures: [
          { package: 'core', signature: 'sig-noise' },
          { package: 'core', signature: 'sig-fresh' },
        ],
      }),
    );
    expect(report.suppressed).toEqual([]);
    expect(report.units.map((u) => u.package)).toContain('core');
  });

  test('a needsHuman signature routes even when the package still plans (the row is the human surface)', async () => {
    const report = await okPlan(
      plannerWithLedger(LEDGER),
      baseInput({
        ledger: LEDGER_CONFIG,
        baselineSignatures: [
          { package: 'core', signature: 'sig-human' },
          { package: 'core', signature: 'sig-fresh' },
        ],
      }),
    );
    // One fresh signature keeps the package plannable; the escalated
    // signature is still routed — never repackaged as an auto-fix decision.
    expect(report.needsHuman).toEqual([{ package: 'core', signature: 'sig-human' }]);
    expect(report.suppressed).toEqual([]);
    expect(report.units.map((u) => u.package)).toContain('core');
  });

  test('without a ledger config the planner plans everything the selector selected', async () => {
    const report = await okPlan(
      makePlanner(),
      baseInput({
        baselineSignatures: [{ package: 'core', signature: 'sig-noise' }],
      }),
    );
    expect(report.suppressed).toEqual([]);
    expect(report.units).toHaveLength(PACKAGES.length);
  });

  test('needsHuman routing is SELECTOR-INDEPENDENT: an escalated package changed-vs-base does not select still routes', async () => {
    // Only cli has a changed file; core is NOT selected — its escalated
    // baseline signature must still route to the report's needsHuman rows.
    const planner = makePlanSweep({
      changedFiles: async () => changed('packages/cli/main.ts'),
      queryLedger: makeLedgerQuery(() => memoryStore(LEDGER)),
    });
    const report = await okPlan(
      planner,
      baseInput({
        selector: { mode: 'changed-vs-base', base: 'origin/main' },
        ledger: LEDGER_CONFIG,
        baselineSignatures: [
          { package: 'core', signature: 'sig-human' }, // escalated, NOT selected
          { package: 'cli', signature: 'sig-fresh' }, // fresh, selected
        ],
      }),
    );
    expect(report.needsHuman).toEqual([{ package: 'core', signature: 'sig-human' }]);
    // Suppression logic is unchanged: unselected packages produce no
    // suppression entries, and the selected fresh package plans.
    expect(report.suppressed).toEqual([]);
    expect(report.units.map((u) => u.package)).toEqual(['cli']);
  });

  test('needsHuman routing is bounded by the MANIFEST: a ghost-package baseline routes nothing', async () => {
    const planner = makePlanSweep({
      changedFiles: async () => changed('packages/cli/main.ts'),
      queryLedger: makeLedgerQuery(() => memoryStore(LEDGER)),
    });
    const report = await okPlan(
      planner,
      baseInput({
        selector: { mode: 'changed-vs-base', base: 'origin/main' },
        ledger: LEDGER_CONFIG,
        baselineSignatures: [
          { package: 'ghost', signature: 'sig-human' }, // non-manifest → NO row
          { package: 'core', signature: 'sig-human' }, // manifest, NOT selected → row
        ],
      }),
    );
    // A human is never routed to a package the manifest does not define,
    // while the round-1 selector-independence contract still holds for the
    // real (manifest) package nothing selected.
    expect(report.needsHuman).toEqual([{ package: 'core', signature: 'sig-human' }]);
    expect(report.units.map((u) => u.package)).toEqual(['cli']);
  });

  test('the query receives exactly the configured root, storePath and thresholds', async () => {
    const seen: LedgerQueryInput[] = [];
    const planner = makePlanSweep({
      changedFiles: async () => [],
      queryLedger: async (q) => {
        seen.push(q);
        return { status: 'ok', value: EMPTY_VIEW };
      },
    });
    await okPlan(
      planner,
      baseInput({
        ledger: { root: '.cq', storePath: '.cq/ledger.json', thresholds: { suppressAt: 3 } },
      }),
    );
    expect(seen).toEqual([
      { root: '.cq', storePath: '.cq/ledger.json', thresholds: { suppressAt: 3 } },
    ]);
  });

  test('a failing ledger query is a failed result carrying the fault — never a fabricated ok', async () => {
    const planner = makePlanSweep({
      changedFiles: async () => [],
      queryLedger: async () => ({ status: 'failed', error: 'ledger: could not load' }),
    });
    const error = await failedPlan(
      planner,
      baseInput({ ledger: { root: '.cq', storePath: '.cq/ledger.json' } }),
    );
    expect(error).toMatch(/ledger query returned failed/);
    expect(error).toMatch(/could not load/);
  });

  test('a ledger config without a queryLedger dep is a failed result', async () => {
    const error = await failedPlan(
      makePlanner(),
      baseInput({ ledger: { root: '.cq', storePath: '.cq/ledger.json' } }),
    );
    expect(error).toMatch(/queryLedger dependency was not provided/);
  });
});
