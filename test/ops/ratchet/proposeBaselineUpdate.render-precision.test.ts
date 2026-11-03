// The rendered proposal value keeps the file's lexical scale (PR
// reviews #4304483873, #4305217668, #4305217670).
import { describe, expect, test } from 'vitest';
import { parseBaseline } from '../../../src/ops/ratchet/format.js';
import { createProposeBaselineUpdate } from '../../../src/ops/ratchet/proposeBaselineUpdate.js';
import {
  BASELINE_CAPTURED_AT,
  CAPTURED_AT,
  makeFakeEffects,
  METRIC,
  proposeInput,
  seedRawBaseline,
  TARGET,
} from './proposeBaselineUpdate.helpers.js';

describe('proposeBaselineUpdate', () => {
  test('the rendered value keeps the file lexical precision: 94.20 + 94.301 writes "94.30", not "94.3" (PR review #4304483873)', async () => {
    await seedRawBaseline(
      TARGET,
      METRIC,
      [
        '{',
        '  "schemaVersion": 1,',
        `  "target": "${TARGET}",`,
        `  "metric": "${METRIC}",`,
        '  "direction": "higher-is-better",',
        '  "value": 94.20,',
        `  "capturedAt": "${BASELINE_CAPTURED_AT}"`,
        '}',
        '',
      ].join('\n'),
    );
    const effects = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({
          improvements: [
            { target: TARGET, metric: METRIC, value: 94.301, capturedAt: CAPTURED_AT },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 94.2, newValue: 94.3 }] },
    });
    const content = effects.prs.values().next().value?.files[0]?.content ?? '';
    expect(content).toContain('  "value": 94.30,\n');
    // Same JSON value, still a valid baseline — and the precision survives
    // the round trip: the next run reads two decimals off the token.
    expect(parseBaseline(content).value).toBe(94.3);
    // An integer padded into a two-decimal file keeps its decimals too.
    const wide = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(wide)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 95 }] }),
      ),
    ).resolves.toMatchObject({ status: 'ok', value: { proposal: 'created' } });
    expect(wide.prs.values().next().value?.files[0]?.content).toContain('  "value": 95.00,\n');
  });

  test('exponent-form proposal values keep the file lexical scale: 0.0000000000 + 1e-7 writes 0.0000001000 (PR review #4305217668)', async () => {
    const rawFile = (value: string): string =>
      [
        '{',
        '  "schemaVersion": 1,',
        `  "target": "${TARGET}",`,
        `  "metric": "${METRIC}",`,
        '  "direction": "higher-is-better",',
        `  "value": ${value},`,
        `  "capturedAt": "${BASELINE_CAPTURED_AT}"`,
        '}',
        '',
      ].join('\n');
    await seedRawBaseline(TARGET, METRIC, rawFile('0.0000000000'));
    const effects = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({
          improvements: [{ target: TARGET, metric: METRIC, value: 1e-7, capturedAt: CAPTURED_AT }],
        }),
      ),
    ).resolves.toMatchObject({ status: 'ok', value: { proposal: 'created' } });
    const content = effects.prs.values().next().value?.files[0]?.content ?? '';
    expect(content).toContain('  "value": 0.0000001000,\n');
    expect(parseBaseline(content).value).toBe(1e-7);
  });

  test('an absurd lexical scale is bounded, not allocated: "value": 1e-1000000000 proposes without throwing (PR review #4305217670)', async () => {
    await seedRawBaseline(
      TARGET,
      METRIC,
      [
        '{',
        '  "schemaVersion": 1,',
        `  "target": "${TARGET}",`,
        `  "metric": "${METRIC}",`,
        '  "direction": "higher-is-better",',
        '  "value": 1e-1000000000,',
        `  "capturedAt": "${BASELINE_CAPTURED_AT}"`,
        '}',
        '',
      ].join('\n'),
    );
    const effects = makeFakeEffects();
    // The file parses to 0; the scale falls back to the canonical 0, so
    // 5.5 is proposed as 5 — a plain verdict, never a RangeError.
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({
          improvements: [{ target: TARGET, metric: METRIC, value: 5.5, capturedAt: CAPTURED_AT }],
        }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 0, newValue: 5 }] },
    });
    expect(effects.prs.values().next().value?.files[0]?.content).toContain('  "value": 5,\n');
  });
});
