// Split provenance: test/ops/ratchet/checkRatchet.test.ts was split into
// checkRatchet.helpers.ts (shared fixtures) and six subject files; this file
// carries the op-input contract subject — the plain-data input shape, the
// arg-error verdicts for malformed inputs, and the non-finite reading refusal.
import { match } from '../../helpers/matchers.js';
import { describe, expect, test } from 'vitest';
import type { CheckRatchetInput } from '../../../src/ops/ratchet/checkRatchet.js';
import { baselineRelPath } from '../../../src/ops/ratchet/format.js';
import { check, checkInput, INFINITE_VALUE_METRIC, TARGET } from './checkRatchet.helpers.js';

describe('checkRatchet', () => {
  test('the op input is plain data: structuredClone-safe (kernel makeManifest clones Job.input)', () => {
    expect(() => structuredClone(checkInput())).not.toThrow();
  });

  test.each([
    ['ws: undefined', { ws: undefined }],
    ['target: 42', { target: 42 }],
    ['metric: {}', { metric: {} }],
    ['sourceId: null', { sourceId: null }],
  ])(
    'a non-string input (%s) fails with arg-error wording before any path work — never a throw',
    async (_label, overrides) => {
      await expect(check(checkInput(overrides as Partial<CheckRatchetInput>))).resolves.toEqual({
        status: 'ok',
        value: {
          path: '',
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(
            /invalid input — '(ws|target|metric|sourceId)' must be a string/,
          ),
        },
      });
    },
  );

  test.each([
    ['null', null],
    ['undefined', undefined],
  ])(
    'calling the op with %s input fails with arg-error wording — no throw',
    async (_label, badInput) => {
      await expect(check(badInput as unknown as CheckRatchetInput)).resolves.toEqual({
        status: 'ok',
        value: {
          path: '',
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(/invalid input — expected a non-null object/),
        },
      });
    },
  );

  test('a clean non-finite reading (Infinity) fails as an unusable reading — no throw, no comparison', async () => {
    await expect(
      check(checkInput({ metric: INFINITE_VALUE_METRIC, sourceId: INFINITE_VALUE_METRIC })),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, INFINITE_VALUE_METRIC),
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(/adapter produced an unusable reading \(Infinity\)/),
      },
    });
  });
});
