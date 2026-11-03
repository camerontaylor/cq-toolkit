// Coverage's metric-defined one-decimal granularity overrides the
// baseline file's own lexical precision (PR reviews #4304483867 and
// #4305894808).
import { describe, expect, test } from 'vitest';
import { createProposeBaselineUpdate } from '../../../src/ops/ratchet/proposeBaselineUpdate.js';
import {
  BASELINE_CAPTURED_AT,
  CAPTURED_AT,
  makeFakeEffects,
  METRIC,
  proposeInput,
  seedBaseline,
  seedRawBaseline,
} from './proposeBaselineUpdate.helpers.js';

describe('proposeBaselineUpdate', () => {
  test('coverage keeps its one-decimal granularity on an integer-written file: 94 + 94.3 proposes 94.3 (PR review #4304483867)', async () => {
    // The repository's coverage baseline is written "value": 94. The file's
    // lexical precision is zero decimals, but coverage's metric-defined
    // granularity is ONE decimal, so 94.3 floors at one decimal to itself —
    // a genuine tighten — instead of being absorbed at the integer.
    await seedBaseline('cov', 'coverage', 94, 'higher-is-better');
    const effects = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({
          improvements: [
            { target: 'cov', metric: 'coverage', value: 94.3, capturedAt: CAPTURED_AT },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 94, newValue: 94.3 }] },
    });
    expect(effects.prs.values().next().value?.files[0]?.content).toContain('"value": 94.3,');
    // Still directional at that granularity: 94.29 floors to 94.2, which
    // tightens 94 and is never the half-up 94.3.
    const floored = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(floored)(
        proposeInput({ improvements: [{ target: 'cov', metric: 'coverage', value: 94.29 }] }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 94, newValue: 94.2 }] },
    });
    // A non-coverage metric keeps the file's own (integer) precision.
    await seedBaseline('other', METRIC, 94, 'higher-is-better');
    const absorbed = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(absorbed)(
        proposeInput({ improvements: [{ target: 'other', metric: METRIC, value: 94.3 }] }),
      ),
    ).resolves.toMatchObject({ status: 'ok', value: { proposal: 'none', applied: [] } });
    expect(absorbed.upsertCalls()).toBe(0);
  });

  test('coverage proposals use exactly one decimal even on a finer file: 94.20 + 94.24 absorbs, 94.20 + 94.35 writes 94.3 (PR review #4305894808)', async () => {
    const rawCoverage = [
      '{',
      '  "schemaVersion": 1,',
      '  "target": "cov",',
      '  "metric": "coverage",',
      '  "direction": "higher-is-better",',
      '  "value": 94.20,',
      `  "capturedAt": "${BASELINE_CAPTURED_AT}"`,
      '}',
      '',
    ].join('\n');
    await seedRawBaseline('cov', 'coverage', rawCoverage);
    // 94.24 floors to the one-decimal 94.2 the live reading would show — not
    // a tightening of 94.20, and never the 94.24 a re-measurement reads as
    // 94.2 (a regression against it).
    const absorbed = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(absorbed)(
        proposeInput({ improvements: [{ target: 'cov', metric: 'coverage', value: 94.24 }] }),
      ),
    ).resolves.toMatchObject({ status: 'ok', value: { proposal: 'none', applied: [] } });
    expect(absorbed.upsertCalls()).toBe(0);
    const tightened = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(tightened)(
        proposeInput({
          improvements: [
            { target: 'cov', metric: 'coverage', value: 94.35, capturedAt: CAPTURED_AT },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 94.2, newValue: 94.3 }] },
    });
    expect(tightened.prs.values().next().value?.files[0]?.content).toContain('  "value": 94.3,\n');
  });
});
