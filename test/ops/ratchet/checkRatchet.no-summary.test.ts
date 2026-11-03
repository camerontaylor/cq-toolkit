// Split provenance: test/ops/ratchet/checkRatchet.test.ts was split into
// checkRatchet.helpers.ts (shared fixtures) and six subject files; this file
// carries the no-summary subject — I5/UC §5 row 56: absent evidence never
// passes, even behind a permissive baseline.
import { match } from '../../helpers/matchers.js';
import { describe, expect, test } from 'vitest';
import { baselineRelPath } from '../../../src/ops/ratchet/format.js';
import {
  check,
  checkInput,
  DIRECTIONS,
  METRIC,
  NONOBJECT_READING_METRIC,
  NULL_EXTRACT_METRIC,
  plantBaseline,
  raws,
  REL,
  TARGET,
  UNDEFINED_READING_METRIC,
} from './checkRatchet.helpers.js';

describe('checkRatchet', () => {
  test('a missing summary fails with the I5 wording EVEN WHEN a permissive baseline exists', async () => {
    // The baseline (3) would pass a current ≤ 3 — but there is no reading:
    // UC §5 row 56's `no-summary` lesson is a hard rule, so absent evidence
    // can never ride a would-have-passed baseline to a pass.
    await plantBaseline(DIRECTIONS[0], 3);
    raws[METRIC] = null;
    await expect(check(checkInput())).resolves.toEqual({
      status: 'ok',
      value: {
        path: REL,
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(
          /metric 'typecheck-count' has no metrics summary \(I5: non-passing evidence, never a pass\)/,
        ),
      },
    });
  });

  test('an extract that yields null on usable raw fails with the same no-summary wording', async () => {
    await plantBaseline(DIRECTIONS[0], 3);
    await expect(
      check(checkInput({ metric: NULL_EXTRACT_METRIC, sourceId: NULL_EXTRACT_METRIC })),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, NULL_EXTRACT_METRIC),
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(
          /has no metrics summary \(I5: non-passing evidence, never a pass\)/,
        ),
      },
    });
  });

  test.each([
    ['undefined', UNDEFINED_READING_METRIC],
    ['a non-object (42)', NONOBJECT_READING_METRIC],
  ])(
    'a type-violating adapter returning %s fails as no-summary (no throw, no dereference)',
    async (_kind, metric) => {
      await expect(check(checkInput({ metric, sourceId: metric }))).resolves.toEqual({
        status: 'ok',
        value: {
          path: baselineRelPath(TARGET, metric),
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(
            new RegExp(
              `metric '${metric}' has no metrics summary \\(I5: non-passing evidence, never a pass\\)`,
            ),
          ),
        },
      });
    },
  );
});
