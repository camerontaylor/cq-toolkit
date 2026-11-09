// Split provenance: test/ops/review/addressManyPlan.test.ts was split into
// this file plus addressManyPlan.helpers.ts, addressManyPlan.selection.test.ts,
// addressManyPlan.admission.test.ts, addressManyPlan.admissionStop.test.ts,
// addressManyPlan.coverage.test.ts and addressManyPlan.outcomes.test.ts.
import { describe, expect, test } from 'vitest';
import type { ReviewAddressResult } from '../../../src/ops/review/address.js';
import { aggregateAddressMany } from '../../../src/ops/review/internal/addressManyPlan.js';
import {
  HEAD_A,
  HEAD_B,
  HEAD_C,
  REPO,
  candidates,
  cleanBudget,
  deferredDebt,
  failedResult,
  finding,
  makeReport,
  needHumanResult,
  okResult,
  record,
  withoutAdmissionHead,
} from './addressManyPlan.helpers.js';

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

describe('aggregateAddressMany truth', () => {
  test('refuses ok results without trusted head evidence and keeps the original result', () => {
    const atOtherHead = makeReport({
      rounds: [{ round: 1, record: record(HEAD_C), runs: [] }],
      findings: [finding('F-1')],
      fixesPerRun: 3,
    });
    const noRounds = makeReport({ rounds: [] });
    const mismatch = okResult(atOtherHead);
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: mismatch }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = result.aggregate.rows;
    expect(row).toMatchObject({
      status: 'unattributed',
      attribution: 'unattributed',
      fixesPerRun: 0,
    });
    expect(row!.result).toBe(mismatch);
    expect(result.aggregate.findings).toEqual([]);
    expect(result.aggregate.status).toBe('needs-human');
    expect(result.aggregate.totals).toMatchObject({ unattributed: 1, fixesPerRun: 0 });
    expect(result.aggregate.reasons.join(' ')).toContain('not the admitted head');

    // A successful result is value-only in the producer's shape, so a report
    // with zero rounds is still a report: unattributed, not absent.
    const noRoundsOutcome = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: { status: 'ok', value: noRounds } }],
    });
    expect(noRoundsOutcome.ok).toBe(true);
    if (!noRoundsOutcome.ok) return;
    expect(noRoundsOutcome.aggregate.rows[0]).toMatchObject({
      status: 'unattributed',
      attribution: 'unattributed',
      fixesPerRun: 0,
    });

    // A non-ok result that carries no report at all has no evidence source, so its
    // debt state is unknowable rather than affirmatively absent.
    const reportless = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: failedResult('fixer crashed') }],
    });
    expect(reportless.ok).toBe(true);
    if (!reportless.ok) return;
    expect(reportless.aggregate.rows[0]).toMatchObject({
      status: 'settled-failed',
      attribution: 'absent',
      deferredVendorDebt: 'unknown',
    });
    expect(reportless.aggregate.reasons.join(' ')).toContain(
      '#5 debt state unknowable; the leg produced no report',
    );
  });

  test('consumes the value-only report a real successful result carries', () => {
    const report = makeReport({
      rounds: [{ round: 1, record: record(HEAD_A), runs: [] }],
      findings: [finding('F-5'), finding('F-6', { status: 'fixed' })],
      fixesPerRun: 2,
      verifiedHead: HEAD_B,
      deferredVendorDebt: deferredDebt(HEAD_A, 'req-5', 'cycle-5'),
    });
    // Exactly the producer's public shape: no `report` field beside `value`.
    const success: ReviewAddressResult = { status: 'ok', value: report };
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: success }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aggregate.rows[0]).toMatchObject({
      status: 'settled-ok',
      attribution: 'trusted',
      fixesPerRun: 2,
      deferredVendorDebt: 'present',
      publication: 'unknown',
    });
    expect(result.aggregate.rows[0]!.result).toEqual({ status: 'ok', value: report });
    expect(result.aggregate.findings.map((entry) => entry.finding.id)).toEqual(['F-5', 'F-6']);
    expect(result.aggregate.totals).toMatchObject({ settledOk: 1, fixesPerRun: 2 });
    expect(result.aggregate.status).toBe('ok');
  });

  test('trusts the immutable admission witness, not the refreshed first-round record', () => {
    // A successful fix/re-review overwrites rounds[0].record with the refreshed
    // head in the real producer. The witness keeps the admitted head, so the
    // report stays attributable to the PR the caller dispatched.
    const report = makeReport({
      rounds: [{ round: 1, record: record(HEAD_B), runs: [] }],
      admissionHead: HEAD_A,
      findings: [finding('F-7')],
      fixesPerRun: 1,
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
      status: 'settled-ok',
      attribution: 'trusted',
      fixesPerRun: 1,
      publication: 'unknown',
    });
    expect(result.aggregate.rows[0]!.scope.headOid).toBe(HEAD_A);
    expect(result.aggregate.findings.map((entry) => entry.finding.id)).toEqual(['F-7']);
    expect(result.aggregate.totals.fixesPerRun).toBe(1);

    // The mirror case: a matching first-round record with no witness is still
    // not success — rounds are never a fallback.
    const unwitnessed = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [
        {
          number: 5,
          headOid: HEAD_A,
          result: okResult(withoutAdmissionHead(makeReport())),
        },
      ],
    });
    expect(unwitnessed.ok).toBe(true);
    if (!unwitnessed.ok) return;
    expect(unwitnessed.aggregate.rows[0]).toMatchObject({
      status: 'unattributed',
      attribution: 'unattributed',
      fixesPerRun: 0,
    });
    expect(unwitnessed.aggregate.status).toBe('needs-human');
  });

  test('classifies a structured budget stop on a needs-human leg as budget-stopped', () => {
    const report = makeReport({
      rounds: [{ round: 1, record: record(HEAD_A), runs: [] }],
      stop: 'budget',
      reasons: ['token or wall budget exhausted'],
    });
    const stopped = needHumanResult('token or wall budget exhausted', report);
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: stopped }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aggregate.rows[0]).toMatchObject({
      status: 'settled-budget-exhausted',
      reason: 'token or wall budget exhausted',
      attribution: 'trusted',
      publication: 'unknown',
    });
    expect(result.aggregate.rows[0]!.result).toBe(stopped);
    expect(result.aggregate.totals).toMatchObject({
      budgetExhausted: 1,
      needsHuman: 0,
      settledOk: 0,
    });
    expect(result.aggregate.status).toBe('budget-exhausted');
    expect(result.aggregate.reasons.join(' ')).toContain('structured budget marker');

    // Without the structured marker the same status stays an ordinary
    // needs-human refusal: no reason text is parsed.
    const plain = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [
        {
          number: 5,
          headOid: HEAD_A,
          result: needHumanResult(
            'token or wall budget exhausted',
            makeReport({ rounds: [{ round: 1, record: record(HEAD_A), runs: [] }] }),
          ),
        },
      ],
    });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.aggregate.rows[0]).toMatchObject({ status: 'settled-needs-human' });
    expect(plain.aggregate.status).toBe('needs-human');
  });
});
