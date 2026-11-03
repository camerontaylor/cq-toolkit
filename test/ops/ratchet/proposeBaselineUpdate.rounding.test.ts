// Directional rounding at the baseline FILE's precision (#319): floor
// for higher-is-better, ceil for lower-is-better, exact boundaries
// never move, and negatives round the mathematical way.
import { match } from '../../helpers/matchers.js';
import { describe, expect, test } from 'vitest';
import { createProposeBaselineUpdate } from '../../../src/ops/ratchet/proposeBaselineUpdate.js';
import {
  CAPTURED_AT,
  makeFakeEffects,
  METRIC,
  proposeInput,
  seedBaseline,
  TARGET,
} from './proposeBaselineUpdate.helpers.js';

describe('proposeBaselineUpdate', () => {
  // ------------------------------------------------------------------------
  // Directional rounding at the baseline FILE's precision (#319)
  // ------------------------------------------------------------------------

  test('higher-is-better rounds DOWN at the file precision: 94.29 against 94.2 proposes NOTHING (#319)', async () => {
    // The regression shape: a half-up rounding at the proposal boundary
    // would turn 94.29 into 94.3 — stricter than the measurement, and a
    // value a re-measurement cannot reproduce (the gate then fails on the
    // proposal PR). Floor at the file's one decimal is 94.2: the rounding
    // absorbs the raw improvement, so the truth is 'not a tightening' and
    // no effects call ever happens.
    await seedBaseline(TARGET, METRIC, 94.2, 'higher-is-better');
    const effects = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 94.29 }] }),
      ),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        proposal: 'none',
        prNumber: null,
        prUrl: null,
        head: null,
        applied: [],
        skipped: [
          {
            target: TARGET,
            metric: METRIC,
            reason: match.stringMatching(
              /94\.2 → 94\.2 is not a tightening \(higher-is-better\) — the measurement 94\.29 rounds to 94\.2 at the baseline file's precision — nothing to propose/,
            ),
          },
        ],
      },
    });
    expect(effects.findCalls()).toBe(0);
    expect(effects.upsertCalls()).toBe(0);
  });

  test('higher-is-better with real headroom proposes the floored value: 94.31 against 94.2 proposes 94.3', async () => {
    await seedBaseline(TARGET, METRIC, 94.2, 'higher-is-better');
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [{ target: TARGET, metric: METRIC, value: 94.31, capturedAt: CAPTURED_AT }],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 94.2, newValue: 94.3 }] },
    });
    const pr = effects.prs.values().next().value;
    expect(pr?.files[0]?.content).toContain('"value": 94.3');
    expect(pr?.body).toContain(`: 94.2 → 94.3 (higher-is-better)`);
  });

  test('lower-is-better rounds UP at the file precision: 2.38 against 2.4 cannot tighten, 2.29 tightens to 2.3', async () => {
    await seedBaseline(TARGET, METRIC, 2.4, 'lower-is-better');
    // ceil(2.38) at the file's one decimal is 2.4 — equal to the baseline,
    // so nothing tighter than the measurement can be stated at this
    // precision and the improvement is absorbed.
    const absorbed = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(absorbed)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 2.38 }] }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: {
        proposal: 'none',
        applied: [],
        skipped: [
          match.objectContaining({
            reason: match.stringMatching(
              /2\.4 → 2\.4 is not a tightening \(lower-is-better\) — the measurement 2\.38 rounds to 2\.4/,
            ),
          }),
        ],
      },
    });
    expect(absorbed.upsertCalls()).toBe(0);
    // A genuinely better reading: ceil(2.29) at one decimal is 2.3 — still
    // ≥ the measurement (never stricter) and a real tighten of 2.4.
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [{ target: TARGET, metric: METRIC, value: 2.29, capturedAt: CAPTURED_AT }],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 2.4, newValue: 2.3 }] },
    });
    const pr = effects.prs.values().next().value;
    expect(pr?.files[0]?.content).toContain('"value": 2.3');
    expect(pr?.body).toContain(': 2.4 → 2.3 (lower-is-better)');
  });

  test('an exact decimal boundary never moves: 94.3 floors to exactly 94.3, 68.1 ceils to exactly 68.1', async () => {
    // A scaled-float implementation (×10^p, floor/ceil, ÷10^p) survives SOME
    // boundaries only by luck of the rounding — the guarantee here is that
    // no scaled product is ever consulted: the digits come from the
    // canonical decimal string, so an on-precision measurement is carried
    // through byte-identical in both directions.
    await seedBaseline(TARGET, METRIC, 94.2, 'higher-is-better');
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [{ target: TARGET, metric: METRIC, value: 94.3, capturedAt: CAPTURED_AT }],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 94.2, newValue: 94.3 }] },
    });
    expect(effects.prs.values().next().value?.files[0]?.content).toContain('"value": 94.3');
    // Mirror boundary for lower-is-better (ceil side).
    await seedBaseline('cx', 'avg-cx', 68.2, 'lower-is-better');
    const effects2 = makeFakeEffects();
    const result2 = await createProposeBaselineUpdate(effects2)(
      proposeInput({
        improvements: [{ target: 'cx', metric: 'avg-cx', value: 68.1, capturedAt: CAPTURED_AT }],
      }),
    );
    expect(result2).toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 68.2, newValue: 68.1 }] },
    });
    expect(effects2.prs.values().next().value?.files[0]?.content).toContain('"value": 68.1');
  });

  test('the boundary holds where scaled-float math actually errs: 0.29 against a 0.28 file floors to exactly 0.29', async () => {
    // 0.29 × 100 is 28.999999999999996 in doubles — a ×100/floor/÷100
    // implementation floors the boundary DOWN to 0.28, absorbs the tighten,
    // and the ratchet never advances. The exact-decimal path keeps 0.29: a
    // genuine tighten of the 0.28 file, never stricter than the 0.29 the
    // caller measured.
    await seedBaseline(TARGET, METRIC, 0.28, 'higher-is-better');
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [{ target: TARGET, metric: METRIC, value: 0.29, capturedAt: CAPTURED_AT }],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 0.28, newValue: 0.29 }] },
    });
    expect(effects.prs.values().next().value?.files[0]?.content).toContain('"value": 0.29');
  });

  test('the FILE precision governs: a 2-decimal file proposes at 2 decimals, an integer file at 0', async () => {
    // 94.291 floors at the 94.25 file's TWO decimals to 94.29 — a genuine
    // tighten that a fixed one-decimal law would have hidden.
    await seedBaseline(TARGET, METRIC, 94.25, 'higher-is-better');
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [{ target: TARGET, metric: METRIC, value: 94.291, capturedAt: CAPTURED_AT }],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 94.25, newValue: 94.29 }] },
    });
    expect(effects.prs.values().next().value?.files[0]?.content).toContain('"value": 94.29');
    // An integer-valued file speaks ZERO decimals: 94.29 floors to 94 —
    // equal to the baseline 94, absorbed, never proposed.
    await seedBaseline('int-file', METRIC, 94, 'higher-is-better');
    const absorbed = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(absorbed)(
        proposeInput({ improvements: [{ target: 'int-file', metric: METRIC, value: 94.29 }] }),
      ),
    ).resolves.toMatchObject({ status: 'ok', value: { proposal: 'none', applied: [] } });
    expect(absorbed.upsertCalls()).toBe(0);
  });

  test('negative measurements round the mathematical way: floor toward −∞, ceil toward +∞', async () => {
    // higher-is-better with a negative measurement: floor(−12.34) at one
    // decimal is −12.4 — NOT the −12.3 truncation toward zero would give
    // (−12.3 > −12.34 would be stricter than the measurement).
    await seedBaseline(TARGET, METRIC, -12.5, 'higher-is-better');
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [{ target: TARGET, metric: METRIC, value: -12.34, capturedAt: CAPTURED_AT }],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: -12.5, newValue: -12.4 }] },
    });
    // lower-is-better with a negative measurement: ceil(−12.34) at one
    // decimal is −12.3 — ≥ the measurement (never stricter) and a genuine
    // tighten of −12.2.
    await seedBaseline('neg', METRIC, -12.2, 'lower-is-better');
    const effects2 = makeFakeEffects();
    const result2 = await createProposeBaselineUpdate(effects2)(
      proposeInput({
        improvements: [{ target: 'neg', metric: METRIC, value: -12.34, capturedAt: CAPTURED_AT }],
      }),
    );
    expect(result2).toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: -12.2, newValue: -12.3 }] },
    });
  });
});
