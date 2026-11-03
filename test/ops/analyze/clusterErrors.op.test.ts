// Analyze lane G1 — test evidence for signature clustering: the exact
// normalization pipeline (what is abstracted, what is preserved, rule
// order), content-derived stable ids, the confidence decision table
// (high/low; v1 never merges, never emits 'medium'), the ledger noise seam
// (knownNoise excludes BY CLUSTER SIGNATURE — any other recorded form never
// matches), and a seeded PROPERTY test proving the acceptance constraint:
// the same failure set in any presentation order yields identical cluster
// ids, confidences, and membership. All pure — zero I/O.
//
// Split provenance: test/ops/analyze/clusterErrors.test.ts was split by
// subject into this file (the clusterErrorsOp result mapping) and the
// sibling clusterErrors.*.test.ts files plus clusterErrors.helpers.ts.
import { describe, expect, test } from 'vitest';
import { clusterErrorsOp, clusterSignature } from '../../../src/ops/analyze/clusterErrors.js';
import { failureOf, ledgerOf, setOf } from './clusterErrors.helpers.js';

describe('clusterErrorsOp', () => {
  test('ok with the report, including the optional ledger input', async () => {
    const noisy = failureOf({ message: 'known noise' });
    const signature = clusterSignature(noisy, 'eslint');
    const result = await clusterErrorsOp({ set: setOf([noisy]), ledger: ledgerOf([signature]) });
    expect(result).toEqual({
      status: 'ok',
      value: { clusters: [], noise: [noisy] },
    });
  });

  test('ok on an empty set (an empty report asserts nothing)', async () => {
    const result = await clusterErrorsOp({ set: setOf([], 'eslint', 0) });
    expect(result).toEqual({ status: 'ok', value: { clusters: [], noise: [] } });
  });

  test('an invariant-violating ledger view maps the policy throw to failed', async () => {
    const escalated = failureOf({ message: 'escalated but unsuppressed' });
    const signature = clusterSignature(escalated, 'eslint');
    const result = await clusterErrorsOp({
      set: setOf([escalated]),
      ledger: { entries: [], knownNoise: [], needsHuman: [signature] },
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error).toContain('needsHuman');
    expect(result.error).toContain(signature);
  });

  test('an ungrounded knownNoise view maps the policy throw to failed', async () => {
    const neverRecorded = failureOf({ message: 'never recorded anywhere' });
    const signature = clusterSignature(neverRecorded, 'eslint');
    const result = await clusterErrorsOp({
      set: setOf([neverRecorded]),
      ledger: { entries: [], knownNoise: [signature], needsHuman: [] },
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error).toContain('knownNoise');
    expect(result.error).toContain(signature);
  });
});
