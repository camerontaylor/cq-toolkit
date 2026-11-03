// Split provenance: test/ops/review/addressManyPlan.test.ts was split into
// this file plus addressManyPlan.helpers.ts, addressManyPlan.selection.test.ts,
// addressManyPlan.admission.test.ts, addressManyPlan.admissionStop.test.ts,
// addressManyPlan.attribution.test.ts and addressManyPlan.outcomes.test.ts.
import { describe, expect, test } from 'vitest';
import {
  aggregateAddressMany,
  initialAddressManyBudget,
  type AddressManyOutcomeInput,
} from '../../../src/ops/review/internal/addressManyPlan.js';
import {
  HEAD_A,
  HEAD_B,
  HEAD_C,
  REPO,
  candidates,
  makeReport,
  okResult,
  record,
} from './addressManyPlan.helpers.js';

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

describe('aggregateAddressMany coverage', () => {
  const budget = initialAddressManyBudget({ limitTokens: 1000 });
  const clean = makeReport({ rounds: [{ round: 1, record: record(HEAD_A), runs: [] }] });

  test('refuses an empty candidate set instead of reporting ok', () => {
    expect(
      aggregateAddressMany({ repo: REPO, budget, candidates: [], outcomes: [] }),
    ).toMatchObject({
      ok: false,
      refusal: { kind: 'empty-coverage' },
    });
  });

  test('refuses duplicate selection coverage and foreign-repo candidates', () => {
    const duplicated = [...candidates, candidates[0]!];
    expect(
      aggregateAddressMany({ repo: REPO, budget, candidates: duplicated, outcomes: [] }),
    ).toEqual({
      ok: false,
      refusal: { kind: 'duplicate-coverage', numbers: [5] },
    });
    const foreign = [{ ...candidates[0]!, repo: 'other/repo' }];
    expect(
      aggregateAddressMany({ repo: REPO, budget, candidates: foreign, outcomes: [] }),
    ).toMatchObject({
      ok: false,
      refusal: { kind: 'repo-mismatch' },
    });
  });

  test('refuses missing, extra, duplicate and self-contradictory outcomes', () => {
    const both = { result: okResult(clean), exception: 'boom' };
    const cases: Array<[unknown, string]> = [
      // #5 is supplied and well formed; #6 is absent from the outcome set.
      [[{ number: 5, headOid: HEAD_A, result: okResult(clean) }], 'missing-outcome'],
      [
        [
          { number: 5, headOid: HEAD_A, result: okResult(clean) },
          { number: 9, headOid: HEAD_C, result: okResult(clean) },
        ],
        'extra-outcome',
      ],
      [
        [
          { number: 5, headOid: HEAD_A, result: okResult(clean) },
          { number: 5, headOid: HEAD_A, result: okResult(clean) },
        ],
        'duplicate-outcome',
      ],
      [
        [
          { number: 5, headOid: HEAD_A },
          { number: 6, headOid: HEAD_B, ...both },
        ],
        'malformed-outcome',
      ],
    ];
    for (const [value, kind] of cases) {
      const outcomes = Array.isArray(value)
        ? (value as readonly AddressManyOutcomeInput[])
        : [value as AddressManyOutcomeInput];
      const result = aggregateAddressMany({ repo: REPO, budget, candidates, outcomes });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.refusal.kind).toBe(kind);
    }
  });
});
