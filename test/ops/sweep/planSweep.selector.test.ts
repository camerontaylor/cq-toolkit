// Split provenance: test/ops/sweep/planSweep.test.ts was split into
// planSweep.{selector,selection,ledger,jobs,legacy-scheme,signature,subprocess}.test.ts
// plus planSweep.helpers.ts (shared fixtures). This file carries the
// required-selector contract and the untyped-caller input boundary.
import { describe, expect, test } from 'vitest';
import type { PlanSweepInput, PlanSweepPackage } from '../../../src/ops/sweep/planSweep.js';
import { baseInput, failedPlan, makePlanner, PACKAGES } from './planSweep.helpers.js';

// ---------------------------------------------------------------------------
// 1. The selector contract (UC §1 row 16)
// ---------------------------------------------------------------------------

describe('planSweep selector contract (UC §1 row 16: no default selector)', () => {
  test('a missing selector is a failed result naming the selector requirement', async () => {
    // The cast mirrors an untyped/JSON caller that omitted the field; the
    // required-selector check is the library-level contract behind the
    // registry schema's arg-error.
    const input = {
      repoRoot: '/repo',
      packages: PACKAGES,
      fixers: ['lint'],
    } as PlanSweepInput;
    const error = await failedPlan(makePlanner(), input);
    expect(error).toMatch(/selector is required/);
    expect(error).toMatch(/workspace-all/);
  });

  test('an explicitly-undefined selector fails the same way', async () => {
    const input = {
      repoRoot: '/repo',
      packages: PACKAGES,
      fixers: ['lint'],
      selector: undefined,
    } as unknown as PlanSweepInput;
    await expect(failedPlan(makePlanner(), input)).resolves.toMatch(/selector is required/);
  });

  test.each(['failed', 'track', 'failed!'] as const)(
    'reserved fixer label %s is refused before branch planning',
    async (fixer) => {
      await expect(failedPlan(makePlanner(), baseInput({ fixers: [fixer] }))).resolves.toMatch(
        /reserved for failed-attempt and tracking branches/,
      );
    },
  );

  test('an unknown selector mode is failed — no hardcoded default falls out', async () => {
    const input = baseInput({
      selector: { mode: 'magic' } as unknown as PlanSweepInput['selector'],
    });
    const error = await failedPlan(makePlanner(), input);
    expect(error).toMatch(/unknown selector mode "magic"/);
    expect(error).toMatch(/NO default selector/);
  });

  test('changed-vs-base requires a non-empty base ref', async () => {
    const input = baseInput({ selector: { mode: 'changed-vs-base', base: '' } });
    await expect(failedPlan(makePlanner(), input)).resolves.toMatch(/non-empty base ref/);
  });

  test('a flag-impersonating changed-vs-base base is refused — the diff arg is positional', async () => {
    const input = baseInput({
      selector: { mode: 'changed-vs-base', base: '--output=/tmp/x' },
    });
    const error = await failedPlan(makePlanner(), input);
    expect(error).toMatch(/changed-vs-base base/);
    expect(error).toMatch(/never a flag/);
  });
});

// ---------------------------------------------------------------------------
// 1b. The library input boundary (untyped-caller hardening)
// ---------------------------------------------------------------------------

describe('planSweep library input boundary (reachable past any schema)', () => {
  test('a non-array packages field is a failed result — never an escaping TypeError', async () => {
    const input = baseInput({ packages: 'packages/core' as unknown as PlanSweepPackage[] });
    await expect(failedPlan(makePlanner(), input)).resolves.toMatch(
      /packages must be an array of manifest entries/,
    );
  });

  test('a null selector is a failed result — the required-selector taxonomy', async () => {
    const input = baseInput({
      selector: null as unknown as PlanSweepInput['selector'],
    });
    await expect(failedPlan(makePlanner(), input)).resolves.toMatch(/selector is required/);
    await expect(failedPlan(makePlanner(), input)).resolves.toMatch(/NO default selector/);
  });

  test('a null packages ELEMENT is a failed result naming the index', async () => {
    const input = baseInput({
      packages: [null as unknown as PlanSweepPackage, PACKAGES[0] as PlanSweepPackage],
    });
    const error = await failedPlan(makePlanner(), input);
    expect(error).toMatch(/packages\[0\]/);
  });

  test('a non-array baselineSignatures is a failed result — the packages-guard mirror', async () => {
    const input = baseInput({
      baselineSignatures: 'sig-noise' as unknown as NonNullable<
        PlanSweepInput['baselineSignatures']
      >,
    });
    await expect(failedPlan(makePlanner(), input)).resolves.toMatch(
      /baselineSignatures must be an array/,
    );
  });

  test('a null ledger is a failed result, not a TypeError at the root read', async () => {
    const input = baseInput({
      ledger: null as unknown as NonNullable<PlanSweepInput['ledger']>,
    });
    const error = await failedPlan(makePlanner(), input);
    expect(error).toMatch(/ledger must be an object/);
  });

  test('a null/garbage baselineSignatures ELEMENT is a failed result naming the index', async () => {
    type Entries = NonNullable<PlanSweepInput['baselineSignatures']>;
    const nullEntry = baseInput({
      baselineSignatures: [null] as unknown as Entries,
    });
    await expect(failedPlan(makePlanner(), nullEntry)).resolves.toMatch(/baselineSignatures\[0\]/);
    const garbage = baseInput({
      baselineSignatures: [42] as unknown as Entries,
    });
    await expect(failedPlan(makePlanner(), garbage)).resolves.toMatch(/baselineSignatures\[0\]/);
    const blank = baseInput({
      baselineSignatures: [{ package: 'core', signature: '' }] as unknown as Entries,
    });
    await expect(failedPlan(makePlanner(), blank)).resolves.toMatch(/baselineSignatures\[0\]/);
  });

  test('an empty explicit selector is a failed result — aligned with the registry min(1)', async () => {
    const error = await failedPlan(
      makePlanner(),
      baseInput({ selector: { mode: 'explicit', packages: [] } }),
    );
    expect(error).toMatch(/at least one package/);
  });

  test('a packageFiles value that is not an array of strings is a failed result naming the key', async () => {
    const input = baseInput({
      packageFiles: { core: 'build' } as unknown as NonNullable<PlanSweepInput['packageFiles']>,
    });
    const error = await failedPlan(makePlanner(), input);
    expect(error).toMatch(/packageFiles\['core'\]/);
  });
});
