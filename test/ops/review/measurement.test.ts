import { describe, expect, it } from 'vitest';
import type { AddressFix } from '../../../src/ops/review/addressWorker.js';
import type { Finding } from '../../../src/ops/review/findings.js';
import type { ValidationVerdict } from '../../../src/ops/fix/validate.js';
import {
  measureRun,
  reviewClosuresOf,
  reviewPlannedUnitsOf,
} from '../../../src/ops/fix/measurement.js';
import { fixture, finding as workerFinding } from './addressWorker.helpers.js';

// Fake/local fixtures only: no repositories, providers or credentials.
const pass: ValidationVerdict = { verdict: 'pass', gates: [] };
const fail: ValidationVerdict = {
  verdict: 'fail',
  gates: [{ gate: 'related', verdict: 'fail', wallMs: 1 }],
};
const human: ValidationVerdict = {
  verdict: 'needs-human',
  gates: [{ gate: 'paths', verdict: 'needs-human', wallMs: 1 }],
};

// Review commits name the finding id in the SAME Cq-Task trailer the fix
// producer writes; the closure link is the trailer, never the subject.
const linked = (findingId: string, extra = ''): string =>
  `fix(review): Address ${findingId}\n\nCq-Task: ${findingId}${extra ? `\n${extra}` : ''}`;
const messages = new Map<string, string>([
  ['review1', linked('finding-1')],
  ['review2', linked('finding-2')],
  ['todoReview', linked('finding-1', 'Cq-Todo: true')],
  ['crlfReview', 'fix(review): Address finding-1\r\n\r\nCq-Task: finding-1\r\nCQ-TODO: TRUE'],
  [
    'paddedTodo',
    `fix(review): staged repair\n\nCq-Task: finding-1\nCq-Run: p\n  cq-todo :  True  `,
  ],
  ['subjectOnly', 'fix(review): Address finding-1\n\nplain body, no trailers'],
  [
    'proseTodo',
    `fix(review): repairs a TODO marker\n\nCq-Todo: true\n\nCq-Task: finding-1\nCq-Todo: false`,
  ],
  ['wrongLink', linked('finding-9')],
  ['unlinked', 'fix(review): repair the related cluster\n\nplain body, no trailers'],
  // The review commit writer collapses embedded newlines in a caller-supplied
  // finding id to one space, and the trailer reader trims its value.
  ['newlineLink', linked('finding one')],
  ['paddedLink', 'fix(review): Address finding-1\n\nCq-Task:   finding-1  '],
]);
const messageOf = (sha: string): string | undefined => messages.get(sha);

const finding = (id: string, status: Finding['status'] = 'fixed'): Finding => ({
  id,
  source: 'pr-threads',
  file: 'src/a.ts',
  severity: 'major',
  text: `finding ${id}`,
  status,
});

function reviewFix(overrides: {
  finding?: Finding;
  commit?: string | null;
  validation?: ValidationVerdict[];
}): AddressFix {
  const commit = overrides.commit === undefined ? 'review1' : overrides.commit;
  return {
    finding: overrides.finding ?? finding('finding-1'),
    observedHead: 'head-2',
    validatedParent: 'head-1',
    ...(commit === null ? {} : { commit }),
    reason: 'closed',
    validation: overrides.validation ?? [pass],
  };
}

// The initial open-blocker population is the review run's baseline: every
// initial blocker is one observed baseline failure, and the post-fix
// openBlocking population is never substituted for it.
const initialOpenBlocking = ['finding-1', 'finding-2', 'finding-3'];
const probes = new Map(
  initialOpenBlocking.map((id) => [id, { completed: true, count: 1 }] as const),
);

describe('reviewClosuresOf', () => {
  it('T35 round-trip', () => {
    const fixes: AddressFix[] = [
      reviewFix({}),
      // Duplicate rows across re-review rounds: the same SHA counts once.
      reviewFix({}),
      reviewFix({ finding: finding('finding-2'), commit: 'review2' }),
      // Todo trailer: closure recorded with todo true, excluded from the numerator.
      reviewFix({ commit: 'todoReview' }),
      // Non-fixed dispositions never contribute, even with a commit/validation.
      reviewFix({ finding: finding('finding-1', 'deferred'), commit: null }),
      reviewFix({ finding: finding('finding-1', 'open'), commit: 'review1' }),
      reviewFix({ finding: finding('finding-1', 'rejected'), commit: 'review1' }),
      // Missing, failing and needs-human validation never contribute.
      reviewFix({ validation: [] }),
      reviewFix({ validation: [fail] }),
      reviewFix({ validation: [human] }),
    ];
    const { closures, unknownTrailerShas } = reviewClosuresOf(fixes, messageOf);
    expect(closures.map((closure) => closure.commitSha)).toEqual([
      'review1',
      'review1',
      'review2',
      'todoReview',
    ]);
    expect(closures[0]?.taskIds).toEqual(['finding-1']);
    expect(closures[0]?.verificationEvidence).toEqual(['validation:pass']);
    expect(closures[0]?.findingFingerprints).toEqual([]);
    expect(closures[0]?.todo).toBe(false);
    expect(closures[3]?.todo).toBe(true);
    expect(unknownTrailerShas).toEqual([]);

    const metric = measureRun(fixes, initialOpenBlocking, probes, messageOf);
    expect(metric.fixesPerRun).toEqual({ numerator: 2, denominator: 3 });
    expect(metric.verifiedCommits).toEqual(['review1', 'review2']);
    expect(metric.baselineFailures).toEqual([
      { unitId: 'finding-1', probeHead: null, completed: true, count: 1, unknownReason: null },
      { unitId: 'finding-2', probeHead: null, completed: true, count: 1, unknownReason: null },
      { unitId: 'finding-3', probeHead: null, completed: true, count: 1, unknownReason: null },
    ]);
    expect(metric.availability['/metric/fixesPerRun/numerator']?.state).toBe('known');
    expect(metric.availability['/metric/fixesPerRun/denominator']?.state).toBe('known');
  });

  it('T35 real worker result', async () => {
    // One fixture built by the real fake-driver makeAddressWorker: the gate
    // array and the Cq-Task trailer are the producer's own, not hand-built.
    const f = await fixture();
    try {
      const fix = await f.engine.fix(workerFinding(), 1);
      expect(fix.finding.status).toBe('fixed');
      expect(fix.commit).toBeDefined();
      const sha = fix.commit!;
      const message = f.repo.git('show', '-s', '--format=%B', sha);
      const read = (id: string): string | undefined => (id === sha ? message : undefined);
      const { closures, unknownTrailerShas } = reviewClosuresOf([fix], read);
      expect(unknownTrailerShas).toEqual([]);
      expect(closures.map((closure) => closure.commitSha)).toEqual([sha]);
      expect(closures[0]?.taskIds).toEqual(['src/a.ts']);
      expect(closures[0]?.verificationEvidence).toEqual(['validation:pass']);
      expect(closures[0]?.todo).toBe(false);
      const metric = measureRun(
        [fix],
        ['src/a.ts'],
        new Map([['src/a.ts', { completed: true, count: 1 } as const]]),
        read,
      );
      expect(metric.fixesPerRun).toEqual({ numerator: 1, denominator: 1 });
    } finally {
      await f.cleanup();
    }
  });

  it('T35 link normalization matches the review commit writer', () => {
    // The worker writes finding.id.replace(/[\r\n]+/g, ' ') and the trailer
    // reader trims the value; the closure link must be compared in that same
    // form, or a caller-supplied id can never link to its own commit.
    const newline = reviewClosuresOf(
      [reviewFix({ finding: finding('finding\none'), commit: 'newlineLink' })],
      messageOf,
    );
    expect(newline.closures).toHaveLength(1);
    expect(newline.closures[0]?.taskIds).toEqual(['finding one']);
    const padded = reviewClosuresOf(
      [reviewFix({ finding: finding('  finding-1  '), commit: 'paddedLink' })],
      messageOf,
    );
    expect(padded.closures).toHaveLength(1);
    expect(padded.closures[0]?.taskIds).toEqual(['finding-1']);
  });

  it('T35 initial open blockers stay in the baseline after a fix', () => {
    // A fixed blocker leaves openBlocking (and the re-review record), but the
    // initial population is the denominator's authority: the ratio must not
    // inflate because the blocker was repaired.
    const report = {
      initialOpenBlocking: ['finding-1', 'finding-2'],
      openBlocking: [] as Finding[],
    };
    const planned = reviewPlannedUnitsOf(report);
    expect(planned).toEqual(['finding-1', 'finding-2']);
    const probes = new Map(
      (planned ?? []).map((id) => [id, { completed: true, count: 1 }] as const),
    );
    const metric = measureRun([reviewFix({})], planned ?? [], probes, messageOf);
    expect(metric.fixesPerRun).toEqual({ numerator: 1, denominator: 2 });
    expect(metric.baselineFailures.map((row) => row.unitId)).toEqual(['finding-1', 'finding-2']);
    // A report without the capture is unknown, never the recomputed population.
    const recomputed = { openBlocking: [finding('finding-1')] };
    expect(reviewPlannedUnitsOf(recomputed)).toBeNull();
  });

  it('T35 unknown evidence', () => {
    // A candidate closure with an unavailable message is genuinely unknown:
    // the numerator is null (never zero), with an unavailable availability
    // record that the T28 null rule requires.
    const noMessage = () => undefined;
    expect(reviewClosuresOf([reviewFix({})], noMessage)).toEqual({
      closures: [],
      unknownTrailerShas: ['review1'],
    });
    const unknownMessage = measureRun([reviewFix({})], initialOpenBlocking, probes, noMessage);
    expect(unknownMessage.fixesPerRun.numerator).toBeNull();
    expect(unknownMessage.verifiedCommits).toEqual([]);
    expect(unknownMessage.availability['/metric/fixesPerRun/numerator']?.state).toBe('unavailable');

    // A run with no closures at all is known zero, not unknown.
    const emptyMetric = measureRun([], initialOpenBlocking, probes, messageOf);
    expect(emptyMetric.fixesPerRun.numerator).toBe(0);
    expect(emptyMetric.availability['/metric/fixesPerRun/numerator']?.state).toBe('known-zero');

    // No validation recorded is not a pass: an empty validation array leaves
    // the finding unverified rather than contributing a closure.
    expect(reviewClosuresOf([reviewFix({ validation: [] })], messageOf)).toEqual({
      closures: [],
      unknownTrailerShas: [],
    });

    // Every initial open blocker is retained as a baseline row. An unprobed
    // initial blocker leaves its count and the denominator null, never zero,
    // with an explicit reason and per-baseline availability entry.
    const partialProbes = new Map([
      ['finding-1', { completed: true, count: 1 }],
      ['finding-2', { completed: false, count: null }],
    ]);
    const baseline = measureRun([reviewFix({})], initialOpenBlocking, partialProbes, messageOf);
    expect(baseline.baselineFailures.length).toBe(3);
    expect(baseline.baselineFailures[2]?.completed).toBe(false);
    expect(baseline.baselineFailures[2]?.count).toBeNull();
    expect(baseline.baselineFailures[2]?.unknownReason).toBe(
      'baseline probe did not complete for this unit',
    );
    expect(baseline.fixesPerRun.denominator).toBeNull();
    expect(baseline.availability['/metric/fixesPerRun/denominator']?.state).toBe('not-collected');
    expect(baseline.availability['/metric/baselineFailures/2/count']?.state).toBe('not-collected');
  });

  it('T35 failure boundary', () => {
    // The closure link is required: the subject names the finding, but with
    // no Cq-Task trailer there is no closure. No subject inference.
    expect(reviewClosuresOf([reviewFix({ commit: 'subjectOnly' })], messageOf)).toEqual({
      closures: [],
      unknownTrailerShas: [],
    });
    // Mismatched and missing Cq-Task links block the closure entirely.
    expect(
      reviewClosuresOf(
        [reviewFix({ commit: 'wrongLink' }), reviewFix({ commit: 'unlinked' })],
        messageOf,
      ).closures,
    ).toEqual([]);
    // The excluded trailer applies per commit, and prose/false markers stay
    // non-todo: the trailer block is the LAST paragraph, so an earlier prose
    // paragraph that looks like a trailer is never an intent signal.
    // CRLF trailers parse through the same block rule.
    const { closures } = reviewClosuresOf(
      [
        reviewFix({ commit: 'paddedTodo' }),
        reviewFix({ commit: 'crlfReview' }),
        reviewFix({ commit: 'proseTodo' }),
      ],
      messageOf,
    );
    expect(closures.filter((closure) => closure.todo).map((closure) => closure.commitSha)).toEqual([
      'paddedTodo',
      'crlfReview',
    ]);
    expect(closures.find((closure) => closure.commitSha === 'proseTodo')?.todo).toBe(false);

    // A per-check validation array normalizes to the unit's single verdict:
    // one passing check cannot mask a failing or human-scoped sibling.
    expect(reviewClosuresOf([reviewFix({ validation: [pass, fail] })], messageOf)).toEqual({
      closures: [],
      unknownTrailerShas: [],
    });
    expect(reviewClosuresOf([reviewFix({ validation: [pass, human] })], messageOf)).toEqual({
      closures: [],
      unknownTrailerShas: [],
    });
    expect(
      reviewClosuresOf([reviewFix({ validation: [pass, pass] })], messageOf).closures,
    ).toHaveLength(1);

    // A known boundary: subject-only, mismatched and unlinked rows contribute
    // nothing, the prose-todo commit is the only closure, and the todo commits
    // are recorded but excluded from the numerator.
    const metric = measureRun(
      [
        reviewFix({ commit: 'subjectOnly' }),
        reviewFix({ commit: 'wrongLink' }),
        reviewFix({ commit: 'unlinked' }),
        reviewFix({ commit: 'paddedTodo' }),
        reviewFix({ commit: 'crlfReview' }),
        reviewFix({ commit: 'proseTodo' }),
        reviewFix({ validation: [pass, fail] }),
      ],
      [],
      new Map(),
      messageOf,
    );
    expect(metric.fixesPerRun).toEqual({ numerator: 1, denominator: 0 });
    expect(metric.verifiedCommits).toEqual(['proseTodo']);
    expect(metric.closures.filter((closure) => !closure.todo).map((c) => c.commitSha)).toEqual([
      'proseTodo',
    ]);
    expect(metric.closures.filter((closure) => closure.todo).map((c) => c.commitSha)).toEqual([
      'paddedTodo',
      'crlfReview',
    ]);
    expect(metric.availability['/metric/fixesPerRun/numerator']?.state).toBe('known');
    expect(metric.availability['/metric/fixesPerRun/denominator']?.state).toBe('known-zero');
  });
});
