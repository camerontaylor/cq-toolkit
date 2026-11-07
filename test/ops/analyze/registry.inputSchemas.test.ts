// Split provenance: test/ops/analyze/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures live in
// registry.helpers.ts. This file carries the G1 boundary mirrors: the
// CollectFailures, LedgerView and ClusterErrors input schemas.
import { afterEach, describe, expect, test } from 'vitest';
import {
  ClusterErrorsInputSchema,
  CollectFailuresInputSchema,
  LedgerViewSchema,
  setAnalyzeApprovalAuthority,
} from '../../../src/ops/analyze/registry.js';
import { EMPTY_FAILURE_SET } from './registry.helpers.js';

// The authority binding is PROCESS-WIDE module state (the same reason the
// playbook registry and quarantine ledger are shared), so every test must
// hand it back. Without this, one test binding an authority would silently
// authorize writes in the next — the exact failure the deny-all default
// exists to prevent.
afterEach(() => {
  setAnalyzeApprovalAuthority(undefined);
});

describe('CollectFailuresInputSchema (full input, and only it)', () => {
  test('parses the full input: an array of FailureSets', () => {
    const valid = {
      sets: [
        {
          tool: 'eslint',
          failures: [
            {
              file: 'src/a.ts',
              line: 5,
              column: 1,
              ruleId: 'prefer-const',
              message: 'm',
              severity: 'error',
            },
          ],
          exitCode: 1,
        },
        { tool: 'eslint', failures: [], exitCode: null },
      ],
    };
    expect(CollectFailuresInputSchema.parse(valid)).toEqual(valid);
  });

  test("an EMPTY sets array is a valid SHAPE — the empty-aggregate policy is the op's `failed`, not the boundary's", () => {
    expect(CollectFailuresInputSchema.parse({ sets: [] })).toEqual({ sets: [] });
  });

  test('accepts the vitest adapter optional test-count and advisory keys', () => {
    const withOptional = {
      sets: [
        {
          tool: 'vitest',
          failures: [],
          exitCode: 1,
          numTotalTests: 3,
          advisories: ['slow test'],
          numPassedTests: 1,
          numPassed: 1,
          numSkippedTests: 1,
          numPendingTests: 0,
          numTodoTests: 0,
        },
      ],
    };
    expect(CollectFailuresInputSchema.parse(withOptional)).toEqual(withOptional);
  });

  test('rejects sets that do not mirror the gates FailureSet, and smuggled keys', () => {
    expect(CollectFailuresInputSchema.safeParse({ sets: [{ tool: 5 }] }).success).toBe(false);
    expect(
      CollectFailuresInputSchema.safeParse({
        sets: [{ tool: 'eslint', failures: [], exitCode: '0' }],
      }).success,
    ).toBe(false);
    expect(
      CollectFailuresInputSchema.safeParse({
        sets: [],
        cache: true, // a smuggled memoization field must fail loudly (I7)
      }).success,
    ).toBe(false);
    expect(CollectFailuresInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('LedgerViewSchema (the frozen ledger view, mirrored here)', () => {
  test('parses a full view with bounded entries', () => {
    const valid = {
      entries: [{ signature: 'a'.repeat(8), count: 2, component: 'src/ops/analyze' }],
      knownNoise: ['a'.repeat(8)],
      needsHuman: [],
    };
    expect(LedgerViewSchema.parse(valid)).toEqual(valid);
  });

  test('rejects entries outside the ledger record boundary (one definition of the bounds)', () => {
    expect(
      LedgerViewSchema.safeParse({
        entries: [{ signature: '', count: 1 }],
        knownNoise: [],
        needsHuman: [],
      }).success,
    ).toBe(false);
    expect(
      LedgerViewSchema.safeParse({
        entries: [{ signature: 'x', count: 0 }],
        knownNoise: [],
        needsHuman: [],
      }).success,
    ).toBe(false);
    expect(
      LedgerViewSchema.safeParse({
        entries: [{ signature: 'x'.repeat(501), count: 1 }],
        knownNoise: [],
        needsHuman: [],
      }).success,
    ).toBe(false);
    expect(
      LedgerViewSchema.safeParse({
        entries: [{ signature: 'x', count: 1, component: '' }],
        knownNoise: [],
        needsHuman: [],
      }).success,
    ).toBe(false);
  });

  test('rejects a wrong-shaped view and smuggled keys', () => {
    expect(
      LedgerViewSchema.safeParse({ entries: [], knownNoise: {}, needsHuman: [] }).success,
    ).toBe(false);
    expect(
      LedgerViewSchema.safeParse({ entries: [], knownNoise: [], needsHuman: [], extra: 1 }).success,
    ).toBe(false);
  });
});

describe('ClusterErrorsInputSchema (full input, and only it)', () => {
  const VALID = { set: EMPTY_FAILURE_SET };

  test('parses the input with and without the optional ledger view', () => {
    expect(ClusterErrorsInputSchema.parse(VALID)).toEqual(VALID);
    const withLedger = {
      ...VALID,
      ledger: { entries: [], knownNoise: ['sig'], needsHuman: ['sig'] },
    };
    expect(ClusterErrorsInputSchema.parse(withLedger)).toEqual(withLedger);
  });

  test('an explicit ledger null is NOT a view (exactOptional, like the frozen type)', () => {
    expect(ClusterErrorsInputSchema.safeParse({ ...VALID, ledger: null }).success).toBe(false);
  });

  test('rejects a set that does not mirror the FailureSet, and smuggled keys', () => {
    expect(ClusterErrorsInputSchema.safeParse({ set: { failures: [] } }).success).toBe(false);
    expect(ClusterErrorsInputSchema.safeParse({ ...VALID, verdict: 'no-clusters' }).success).toBe(
      false,
    );
  });
});
