// Split provenance: test/ops/review/addressManyPlan.test.ts was split into
// this file plus addressManyPlan.helpers.ts, addressManyPlan.selection.test.ts,
// addressManyPlan.admission.test.ts, addressManyPlan.admissionStop.test.ts,
// addressManyPlan.coverage.test.ts and addressManyPlan.attribution.test.ts.
import { describe, expect, test } from 'vitest';
import {
  admitAddressMany,
  aggregateAddressMany,
  initialAddressManyBudget,
  settleAddressMany,
} from '../../../src/ops/review/internal/addressManyPlan.js';
import {
  HEAD_A,
  HEAD_B,
  HEAD_C,
  REPO,
  budgetResult,
  candidates,
  cleanBudget,
  deferredDebt,
  failedResult,
  finding,
  makeReport,
  needHumanResult,
  okResult,
  record,
} from './addressManyPlan.helpers.js';

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

describe('aggregateAddressMany truth', () => {
  test('scopes duplicate finding ids by PR and never merges them', () => {
    const shared = finding('F-1');
    const first = makeReport({
      rounds: [{ round: 1, record: record(HEAD_A), runs: [] }],
      findings: [shared, shared],
    });
    const second = makeReport({
      rounds: [{ round: 1, record: record(HEAD_B), runs: [] }],
      findings: [shared],
    });
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates,
      outcomes: [
        { number: 5, headOid: HEAD_A, result: okResult(first) },
        { number: 6, headOid: HEAD_B, result: okResult(second) },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aggregate.findings).toHaveLength(3);
    expect(
      result.aggregate.findings.map((entry) => [
        entry.scope.number,
        entry.scope.headOid,
        entry.finding.id,
      ]),
    ).toEqual([
      [5, HEAD_A, 'F-1'],
      [5, HEAD_A, 'F-1'],
      [6, HEAD_B, 'F-1'],
    ]);
    expect(result.aggregate.status).toBe('ok');
  });

  test('counts fixes only from attributed heads and never turns an advanced head into publication', () => {
    const report = makeReport({
      rounds: [{ round: 1, record: record(HEAD_A), runs: [] }],
      fixesPerRun: 2,
      verifiedHead: HEAD_B,
    });
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: okResult(report) }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aggregate.rows[0]).toMatchObject({
      fixesPerRun: 2,
      publication: 'unknown',
      attribution: 'trusted',
    });
    expect(result.aggregate.totals.fixesPerRun).toBe(2);
    expect(result.aggregate.status).toBe('ok');
  });

  test('keeps an unclean PR beside a clean one without losing either report', () => {
    const clean = makeReport({ rounds: [{ round: 1, record: record(HEAD_A), runs: [] }] });
    const uncleanReport = makeReport({
      rounds: [{ round: 1, record: record(HEAD_B), runs: [] }],
      findings: [finding('F-9')],
      fixesPerRun: 1,
    });
    const unclean = needHumanResult('review round cap reached with open findings', uncleanReport);
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates,
      outcomes: [
        { number: 5, headOid: HEAD_A, result: okResult(clean) },
        { number: 6, headOid: HEAD_B, result: unclean },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aggregate.status).toBe('needs-human');
    expect(result.aggregate.totals).toMatchObject({ settledOk: 1, needsHuman: 1, fixesPerRun: 1 });
    expect(result.aggregate.rows[1]).toMatchObject({
      status: 'settled-needs-human',
      reason: 'review round cap reached with open findings',
      attribution: 'trusted',
    });
    expect(result.aggregate.rows[1]!.result).toBe(unclean);
    expect(result.aggregate.findings.map((entry) => entry.finding.id)).toEqual(['F-9']);
  });

  test('cannot report ok while a sibling is not admitted or an allocation stays held', () => {
    const clean = makeReport({ rounds: [{ round: 1, record: record(HEAD_A), runs: [] }] });
    const notAdmitted = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates,
      outcomes: [
        { number: 5, headOid: HEAD_A, result: okResult(clean) },
        { number: 6, headOid: HEAD_B, notAdmitted: 'budget' },
      ],
    });
    expect(notAdmitted.ok).toBe(true);
    if (!notAdmitted.ok) return;
    expect(notAdmitted.aggregate.status).toBe('budget-exhausted');
    expect(notAdmitted.aggregate.totals.notAdmitted).toBe(1);
    expect(notAdmitted.aggregate.rows[0]).toMatchObject({ status: 'settled-ok' });

    const otherHead = makeReport({ rounds: [{ round: 1, record: record(HEAD_C), runs: [] }] });
    const admitted = admitAddressMany(cleanBudget(), {
      id: 'held',
      repo: REPO,
      number: 8,
      headOid: HEAD_C,
      tokens: 250,
    });
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;
    const heldState = settleAddressMany(admitted.state, {
      id: 'held',
      repo: REPO,
      number: 8,
      headOid: HEAD_C,
      usage: { kind: 'unknown' },
    });
    expect(heldState.kind).toBe('unknown-usage');
    if (heldState.kind !== 'unknown-usage') return;

    const unresolved = aggregateAddressMany({
      repo: REPO,
      budget: heldState.state,
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: okResult(clean) }],
    });
    expect(unresolved.ok).toBe(true);
    if (!unresolved.ok) return;
    expect(unresolved.aggregate.status).toBe('budget-exhausted');
    expect(unresolved.aggregate.accounting).toMatchObject({
      heldTokens: 250,
      unresolved: ['held'],
      stop: 'unknown-usage',
    });
    expect(unresolved.aggregate.reasons.join(' ')).toContain('is still held');
    expect(otherHead.rounds[0]!.record.head).toBe(HEAD_C);
  });

  test('a definitive failure outranks a budget stop', () => {
    const result = aggregateAddressMany({
      repo: REPO,
      budget: initialAddressManyBudget({ limitTokens: 100, observedTokens: 400 }),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: failedResult('fixer exploded') }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aggregate.status).toBe('failed');
    expect(result.aggregate.rows[0]).toMatchObject({
      status: 'settled-failed',
      reason: 'fixer exploded',
    });
    expect(result.aggregate.accounting.stop).toBe('overrun');
  });

  test('treats exceptions and cancelled legs as non-success with their own totals', () => {
    const thrown = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, exception: 'driver crashed' }],
    });
    expect(thrown.ok).toBe(true);
    if (!thrown.ok) return;
    expect(thrown.aggregate.status).toBe('failed');
    expect(thrown.aggregate.totals).toMatchObject({ exceptions: 1, settledOk: 0 });
    expect(thrown.aggregate.rows[0]).toMatchObject({
      status: 'exception',
      reason: 'driver crashed',
      // A dispatched leg that threw may have created durable author debt; with
      // no report the state is unknown, not `absent`.
      deferredVendorDebt: 'unknown',
    });

    const cancelled = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates,
      outcomes: [
        { number: 5, headOid: HEAD_A, result: budgetResult() },
        { number: 6, headOid: HEAD_B, notAdmitted: 'cancel' },
      ],
    });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.aggregate.status).toBe('budget-exhausted');
    expect(cancelled.aggregate.totals).toMatchObject({ budgetExhausted: 1, notAdmitted: 1 });
    // A cancelled leg never produced a report, so its durable-debt state is
    // unknowable, never affirmatively absent (crq finding F1).
    expect(cancelled.aggregate.rows[1]).toMatchObject({
      status: 'not-admitted',
      deferredVendorDebt: 'unknown',
    });
  });

  test('reports enrollment as advisory metadata, separate from the settled outcome', () => {
    const debt = deferredDebt(HEAD_A, 'req-1', 'cycle-1');
    const withDebt = makeReport({
      rounds: [{ round: 1, record: record(HEAD_B), runs: [] }],
      deferredVendorDebt: debt,
    });
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates,
      outcomes: [
        {
          number: 5,
          headOid: HEAD_A,
          result: okResult(
            makeReport({ rounds: [{ round: 1, record: record(HEAD_A), runs: [] }] }),
          ),
          enrollment: { state: 'unavailable', reason: 'queue endpoint unreachable' },
        },
        { number: 6, headOid: HEAD_B, result: okResult(withDebt) },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both legs are genuinely complete; advisory metadata never changes that.
    expect(result.aggregate.status).toBe('ok');
    expect(result.aggregate.rows[0]).toMatchObject({
      enrollment: { state: 'unavailable', reason: 'queue endpoint unreachable' },
      deferredVendorDebt: 'absent',
    });
    expect(result.aggregate.rows[1]).toMatchObject({
      enrollment: { state: 'not-requested' },
      deferredVendorDebt: 'present',
    });
    expect(result.aggregate.reasons.join(' ')).toContain('enrollment unavailable');
    expect(result.aggregate.reasons.join(' ')).toContain('deferred vendor debt');
  });

  test('reports debt as unknown when the report head is not attributable', () => {
    const debt = deferredDebt(HEAD_C, 'req-2', 'cycle-2');
    const report = makeReport({
      rounds: [{ round: 1, record: record(HEAD_C), runs: [] }],
      fixesPerRun: 4,
      deferredVendorDebt: debt,
    });
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: okResult(report) }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aggregate.rows[0]).toMatchObject({
      status: 'unattributed',
      deferredVendorDebt: 'unknown',
      fixesPerRun: 0,
      publication: 'unknown',
    });
  });
});
