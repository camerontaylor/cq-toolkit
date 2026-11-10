// Focused tests for the shared fix-contract parse
// (src/ops/review/internal/fixContract.ts).
//
// Pinned here:
//   1. The two outcome dispositions, with their required commits/evidence.
//   2. The typed no-outcome record for needs_human, no_outcome and
//      unchanged_with_reason-without-evidence: the STATED disposition,
//      summary, commits and evidence survive the review.fixItem fold, and
//      evidence-missing is a typed field rather than reason prose.
//   3. The legacy v1 form stays failed-closed and byte-compatible.
//   4. Classification is structural: summary wording never changes a verdict.
//   5. The presentation reason keeps the exact bytes crq consumes
//      (`worker disposition <x>:`) and never carries that token for the
//      evidence-missing or legacy rows.
import { describe, expect, test } from 'vitest';
import {
  FIX_DISPOSITIONS,
  MAX_EVIDENCE,
  MAX_FIX_COMMITS,
  MAX_SUMMARY_CHARS,
  NO_OUTCOME_REASON,
  parseFixContract,
} from '../../../src/ops/review/internal/fixContract.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const SUMMARY = 'Already satisfied: src/a.ts line 3 already handles this case.';
const EVIDENCE = [{ path: 'src/a.ts', line: 3 }];

describe('fixContract outcomes', () => {
  test('fixed with its commits is an outcome', () => {
    const parsed = parseFixContract({
      disposition: 'fixed',
      summary: 'Guarded the abort.',
      commits: [SHA],
      evidence: EVIDENCE,
    });
    expect(parsed).toEqual({
      kind: 'outcome',
      disposition: 'fixed',
      summary: 'Guarded the abort.',
      summaryTruncated: false,
      commits: [SHA],
      evidence: EVIDENCE,
    });
  });

  test('unchanged_with_reason with evidence is an outcome and retains the evidence', () => {
    const parsed = parseFixContract({
      disposition: 'unchanged_with_reason',
      summary: SUMMARY,
      commits: [],
      evidence: EVIDENCE,
    });
    expect(parsed).toEqual({
      kind: 'outcome',
      disposition: 'unchanged_with_reason',
      summary: SUMMARY,
      summaryTruncated: false,
      commits: [],
      evidence: EVIDENCE,
    });
  });

  test('a one-line JSON string parses into the contract', () => {
    const parsed = parseFixContract(
      JSON.stringify({
        disposition: 'unchanged_with_reason',
        summary: SUMMARY,
        commits: [],
        evidence: EVIDENCE,
      }),
    );
    expect(parsed.kind).toBe('outcome');
  });

  test(`the outcome summary is head-capped to MAX_SUMMARY_CHARS (${String(MAX_SUMMARY_CHARS)})`, () => {
    const parsed = parseFixContract({
      disposition: 'fixed',
      summary: 'x'.repeat(MAX_SUMMARY_CHARS + 50),
      commits: [SHA],
      evidence: [],
    });
    if (parsed.kind !== 'outcome') throw new Error(`unexpected ${parsed.kind}`);
    expect(parsed.summary).toHaveLength(MAX_SUMMARY_CHARS);
    expect(parsed.summaryTruncated).toBe(true);
  });
});

describe('fixContract no-outcome distinctions', () => {
  test.each(['needs_human', 'no_outcome'] as const)(
    '%s keeps the stated disposition, summary and empty commits',
    (disposition) => {
      const parsed = parseFixContract({
        disposition,
        summary: 'A maintainer must choose.',
        commits: [],
        evidence: [],
      });
      expect(parsed).toEqual({
        kind: 'no-outcome',
        form: 'contract',
        disposition,
        evidenceMissing: false,
        summary: 'A maintainer must choose.',
        commits: [],
        evidence: [],
        reason: `worker disposition ${disposition}: A maintainer must choose.`,
      });
    },
  );

  test('a needs_human answer retains evidence it did supply (typed fields, not prose)', () => {
    const parsed = parseFixContract({
      disposition: 'needs_human',
      summary: 'Choose a policy.',
      commits: [],
      evidence: EVIDENCE,
    });
    if (parsed.kind !== 'no-outcome') throw new Error(`unexpected ${parsed.kind}`);
    expect(parsed.disposition).toBe('needs_human');
    expect(parsed.evidence).toEqual(EVIDENCE);
    expect(parsed.commits).toEqual([]);
  });

  test('unchanged_with_reason without evidence is typed evidence-missing', () => {
    const parsed = parseFixContract({
      disposition: 'unchanged_with_reason',
      summary: SUMMARY,
      commits: [],
      evidence: [],
    });
    expect(parsed).toEqual({
      kind: 'no-outcome',
      form: 'contract',
      disposition: 'unchanged_with_reason',
      evidenceMissing: true,
      summary: SUMMARY,
      commits: [],
      evidence: [],
      reason: 'disposition unchanged_with_reason cites no evidence',
    });
  });

  test('unchanged_with_reason with evidence is an outcome, never evidence-missing', () => {
    const parsed = parseFixContract({
      disposition: 'unchanged_with_reason',
      summary: SUMMARY,
      commits: [],
      evidence: EVIDENCE,
    });
    expect(parsed.kind).toBe('outcome');
  });

  test('legacy changed:false keeps the exact reason bytes and states no disposition', () => {
    const parsed = parseFixContract({ changed: false, summary: SUMMARY, commits: [] });
    expect(parsed).toEqual({
      kind: 'no-outcome',
      form: 'legacy',
      disposition: null,
      evidenceMissing: false,
      summary: SUMMARY,
      commits: [],
      evidence: [],
      reason: 'a legacy no-change contract carries no disposition or evidence',
    });
  });

  test('legacy changed:true with commits reads as fixed, because its commits still verify', () => {
    const parsed = parseFixContract({ changed: true, summary: 'Guarded.', commits: [SHA] });
    expect(parsed).toEqual({
      kind: 'outcome',
      disposition: 'fixed',
      summary: 'Guarded.',
      summaryTruncated: false,
      commits: [SHA],
      evidence: [],
    });
  });

  test('multiple commits survive in worker-reported order', () => {
    const parsed = parseFixContract({
      disposition: 'fixed',
      summary: 'Two commits.',
      commits: [SHA, OTHER_SHA],
      evidence: [],
    });
    if (parsed.kind !== 'outcome') throw new Error(`unexpected ${parsed.kind}`);
    expect(parsed.commits).toEqual([SHA, OTHER_SHA]);
  });
});

describe('fixContract is structural, never prose', () => {
  test('a fixed summary that talks about needs_human stays fixed', () => {
    const parsed = parseFixContract({
      disposition: 'fixed',
      summary: 'The worker disposition needs_human: no_outcome was removed.',
      commits: [SHA],
      evidence: [],
    });
    expect(parsed.kind).toBe('outcome');
    if (parsed.kind !== 'outcome') return;
    expect(parsed.disposition).toBe('fixed');
  });

  test('an unchanged summary claiming no evidence stays an outcome when evidence is present', () => {
    const parsed = parseFixContract({
      disposition: 'unchanged_with_reason',
      summary: 'disposition unchanged_with_reason cites no evidence',
      commits: [],
      evidence: EVIDENCE,
    });
    expect(parsed.kind).toBe('outcome');
  });

  test('evidence-missing follows the empty evidence array, not the summary text', () => {
    const parsed = parseFixContract({
      disposition: 'unchanged_with_reason',
      summary: `Cites src/a.ts:3 as evidence: ${JSON.stringify(EVIDENCE)}`,
      commits: [],
      evidence: [],
    });
    if (parsed.kind !== 'no-outcome') throw new Error(`unexpected ${parsed.kind}`);
    expect(parsed.evidenceMissing).toBe(true);
  });
});

describe('fixContract invalid (unchanged distinction)', () => {
  test.each([
    ['missing output', undefined],
    ['unparseable string', 'not json at all'],
    ['non-object JSON', '[1,2,3]'],
    ['null', null],
    ['unknown disposition', { disposition: 'done', summary: 's', commits: [], evidence: [] }],
    [
      'commits on unchanged_with_reason',
      { disposition: 'unchanged_with_reason', summary: 's', commits: [SHA], evidence: EVIDENCE },
    ],
    [
      'commits on needs_human',
      { disposition: 'needs_human', summary: 's', commits: [SHA], evidence: [] },
    ],
    ['fixed naming no commit', { disposition: 'fixed', summary: 's', commits: [], evidence: [] }],
    ['empty summary', { disposition: 'fixed', summary: '   ', commits: [SHA], evidence: [] }],
    ['missing evidence key', { disposition: 'unchanged_with_reason', summary: 's', commits: [] }],
    [
      'mixed v1 and v2 keys',
      {
        disposition: 'unchanged_with_reason',
        summary: 's',
        commits: [],
        evidence: [],
        changed: false,
      },
    ],
    [
      'extra key',
      { disposition: 'fixed', summary: 's', commits: [SHA], evidence: [], session: 'x' },
    ],
    ['non-string commit', { disposition: 'fixed', summary: 's', commits: [42], evidence: [] }],
    [
      'abbreviated commit',
      { disposition: 'fixed', summary: 's', commits: ['cafe123'], evidence: [] },
    ],
    [
      'absolute evidence path',
      {
        disposition: 'unchanged_with_reason',
        summary: 's',
        commits: [],
        evidence: [{ path: '/etc/passwd', line: 1 }],
      },
    ],
    [
      'parent-escaping evidence path',
      {
        disposition: 'unchanged_with_reason',
        summary: 's',
        commits: [],
        evidence: [{ path: 'src/../../x', line: 1 }],
      },
    ],
    [
      'empty evidence path',
      {
        disposition: 'unchanged_with_reason',
        summary: 's',
        commits: [],
        evidence: [{ path: '', line: 1 }],
      },
    ],
    [
      'zero evidence line',
      {
        disposition: 'unchanged_with_reason',
        summary: 's',
        commits: [],
        evidence: [{ path: 'src/a.ts', line: 0 }],
      },
    ],
    [
      'fractional evidence line',
      {
        disposition: 'unchanged_with_reason',
        summary: 's',
        commits: [],
        evidence: [{ path: 'src/a.ts', line: 1.5 }],
      },
    ],
    [
      'evidence entry with an extra key',
      {
        disposition: 'unchanged_with_reason',
        summary: 's',
        commits: [],
        evidence: [{ path: 'src/a.ts', line: 3, note: 'x' }],
      },
    ],
    [
      `more than MAX_EVIDENCE (${String(MAX_EVIDENCE)}) entries`,
      {
        disposition: 'unchanged_with_reason',
        summary: 's',
        commits: [],
        evidence: Array.from({ length: MAX_EVIDENCE + 1 }, () => ({ path: 'src/a.ts', line: 3 })),
      },
    ],
    [
      `more than MAX_FIX_COMMITS (${String(MAX_FIX_COMMITS)}) entries`,
      {
        disposition: 'fixed',
        summary: 's',
        commits: Array.from({ length: MAX_FIX_COMMITS + 1 }, () => SHA),
        evidence: [],
      },
    ],
    ['legacy changed non-boolean', { changed: 'yes', summary: 's', commits: [] }],
    ['legacy changed:true with empty commits', { changed: true, summary: 's', commits: [] }],
    ['legacy changed:false with commits', { changed: false, summary: 's', commits: [SHA] }],
    ['legacy empty summary', { changed: false, summary: '   ', commits: [] }],
  ])('%s → invalid', (_name, raw) => {
    expect(parseFixContract(raw)).toEqual({ kind: 'invalid' });
  });
});

describe('the presentation reason keeps the review.fixItem consumer contract', () => {
  test.each(FIX_DISPOSITIONS.filter((d) => d !== 'fixed' && d !== 'unchanged_with_reason'))(
    '%s renders the exact worker disposition prefix (the crq token)',
    (disposition) => {
      const parsed = parseFixContract({
        disposition,
        summary: 'stated reason',
        commits: [],
        evidence: [],
      });
      if (parsed.kind !== 'no-outcome') throw new Error(`unexpected ${parsed.kind}`);
      expect(parsed.reason).toBe(`worker disposition ${disposition}: stated reason`);
      // The prefix Python's driver anchors on, after NO_OUTCOME_REASON.
      expect(`${NO_OUTCOME_REASON} — ${parsed.reason}`).toMatch(
        /^fixReviewItem: no outcome to post — worker disposition (needs_human|no_outcome):/,
      );
    },
  );

  test('evidence-missing and legacy reasons never carry the worker disposition token', () => {
    const evidenceMissing = parseFixContract({
      disposition: 'unchanged_with_reason',
      summary: 's',
      commits: [],
      evidence: [],
    });
    const legacy = parseFixContract({ changed: false, summary: 's', commits: [] });
    for (const parsed of [evidenceMissing, legacy]) {
      if (parsed.kind !== 'no-outcome') throw new Error(`unexpected ${parsed.kind}`);
      expect(parsed.evidenceMissing).toBe(parsed.form === 'legacy' ? false : true);
      expect(parsed.reason).not.toMatch(/^worker disposition /);
      expect(`${NO_OUTCOME_REASON} — ${parsed.reason}`).not.toMatch(
        /worker disposition (needs_human|no_outcome):/,
      );
    }
  });

  test('the reason carries the head-capped summary, matching the old op bytes', () => {
    const long = 'z'.repeat(MAX_SUMMARY_CHARS + 10);
    const parsed = parseFixContract({
      disposition: 'needs_human',
      summary: long,
      commits: [],
      evidence: [],
    });
    if (parsed.kind !== 'no-outcome') throw new Error(`unexpected ${parsed.kind}`);
    expect(parsed.reason).toBe(`worker disposition needs_human: ${'z'.repeat(MAX_SUMMARY_CHARS)}`);
  });
});
