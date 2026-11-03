// Split provenance: test/ops/ratchet/checkRatchet.test.ts was split into
// checkRatchet.helpers.ts (shared fixtures) and six subject files; this file
// carries the identity subject — target/metric/direction/unit disagreements
// are incomparable evidence, plus the unknown-metric and unknown-sourceId
// argument failures.
import { match } from '../../helpers/matchers.js';
import { describe, expect, test } from 'vitest';
import { baselineRelPath } from '../../../src/ops/ratchet/format.js';
import type { BaselineFile } from '../../../src/ops/ratchet/format.js';
import {
  check,
  checkInput,
  DIRECTIONS,
  METRIC,
  plantBaseline,
  raws,
  REL,
  TARGET,
  UNIT_SHIFTING_METRIC,
} from './checkRatchet.helpers.js';

describe('checkRatchet', () => {
  const IDENTITY_MISMATCHES: Array<[string, Partial<BaselineFile>, RegExp]> = [
    ['target', { target: 'elsewhere' }, /disagrees on target 'elsewhere' → 'typecheck'/],
    [
      'metric',
      { metric: 'other-metric' },
      /disagrees on metric 'other-metric' → 'typecheck-count'/,
    ],
    [
      'direction',
      { direction: 'higher-is-better' },
      /disagrees on direction 'higher-is-better' → 'lower-is-better'/,
    ],
  ];
  test.each(IDENTITY_MISMATCHES)(
    'a planted baseline whose %s disagrees is incomparable evidence — fail naming both sides',
    async (_field, overrides, pattern) => {
      raws[METRIC] = { count: 2 };
      await plantBaseline(DIRECTIONS[0], 3, overrides);
      await expect(check(checkInput())).resolves.toEqual({
        status: 'ok',
        value: {
          path: REL,
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(pattern),
        },
      });
    },
  );

  test('unknown metric fails with arg-error semantics in the reason (a verdict, not a throw)', async () => {
    await expect(check(checkInput({ metric: 'no-such-metric' }))).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, 'no-such-metric'),
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(/unknown metric 'no-such-metric' — no registered adapter/),
      },
    });
  });

  test('unknown sourceId fails naming the source', async () => {
    raws[METRIC] = { count: 2 };
    await plantBaseline(DIRECTIONS[0], 3);
    await expect(check(checkInput({ sourceId: 'no-such-source' }))).resolves.toEqual({
      status: 'ok',
      value: {
        path: REL,
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(
          /unknown source 'no-such-source' for metric 'typecheck-count'/,
        ),
      },
    });
  });

  test.each([
    {
      label: "plant 'errors', check 'failures'",
      plantUnit: 'errors' as string | undefined,
      raw: { count: 2, unit: 'failures' },
      pattern: /disagrees on unit 'errors' → 'failures' — incomparable scale/,
    },
    {
      label: "plant 'errors', check undefined",
      plantUnit: 'errors' as string | undefined,
      raw: { count: 2 },
      pattern: /disagrees on unit 'errors' → undefined — incomparable scale/,
    },
    {
      label: "plant undefined, check 'errors'",
      plantUnit: undefined as string | undefined,
      raw: { count: 2, unit: 'errors' },
      pattern: /disagrees on unit undefined → 'errors' — incomparable scale/,
    },
  ])(
    'a unit disagreement fails as incomparable scale ($label)',
    async ({ plantUnit, raw, pattern }) => {
      raws[UNIT_SHIFTING_METRIC] = raw;
      await plantBaseline(
        {
          label: 'lower-is-better',
          metric: UNIT_SHIFTING_METRIC,
          ...(plantUnit === undefined ? {} : { unit: plantUnit }),
        },
        3,
      );
      await expect(
        check(checkInput({ metric: UNIT_SHIFTING_METRIC, sourceId: UNIT_SHIFTING_METRIC })),
      ).resolves.toEqual({
        status: 'ok',
        value: {
          path: baselineRelPath(TARGET, UNIT_SHIFTING_METRIC),
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(pattern),
        },
      });
    },
  );

  test('same-unit checks pass untouched — including unit-undefined ≡ unit-undefined', async () => {
    raws[UNIT_SHIFTING_METRIC] = { count: 2 };
    await plantBaseline({ label: 'lower-is-better', metric: UNIT_SHIFTING_METRIC }, 3);
    await expect(
      check(checkInput({ metric: UNIT_SHIFTING_METRIC, sourceId: UNIT_SHIFTING_METRIC })),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, UNIT_SHIFTING_METRIC),
        verdict: 'pass',
        baselineValue: 3,
        currentValue: 2,
      },
    });
  });
});
