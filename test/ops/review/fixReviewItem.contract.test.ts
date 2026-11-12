// Split provenance: test/ops/review/fixReviewItem.test.ts was split into the
// fixReviewItem.*.test.ts siblings in this directory; the shared fixtures live
// in fixReviewItem.helpers.ts and the original suite header sits there.
import { describe, expect, test } from 'vitest';
import {
  FixReviewItemOutputSchema,
  MAX_EVIDENCE,
  MAX_FIX_COMMITS,
  NO_OUTCOME_REASON,
  makeFixReviewItem,
} from '../../../src/ops/review/fixReviewItem.js';
import {
  baseInput,
  completeWorker,
  expectOk,
  NO_CHANGE,
  scriptedOp,
  UNCHANGED,
} from './fixReviewItem.helpers.js';

// ---------------------------------------------------------------------------
// Round-3 — commits-array bounds, sha shape, defang units, id/path,
// output schema, shipped fixer harness
// ---------------------------------------------------------------------------

describe('summary contract (round-2 finding 5+7)', () => {
  test('an EMPTY summary is a definitive contract violation → failed', async () => {
    const { op } = scriptedOp([completeWorker({ ...UNCHANGED, summary: '   ' })]);
    const result = await op(baseInput());
    expect(result.status).toBe('failed');
  });

  test(`an oversized summary is head-capped to MAX_SUMMARY_CHARS and reports summaryTruncated (item 13: context truncation is a separate signal)`, async () => {
    const { op } = scriptedOp([
      completeWorker({
        ...UNCHANGED,
        summary: 'Already satisfied by the guard at line 3. '.repeat(40),
      }),
    ]);
    const value = expectOk(await op(baseInput()));
    expect(value.summary).toHaveLength(1000);
    expect(value.summaryTruncated).toBe(true);
    // The context signal is untouched: the worker saw the whole prompt.
    expect(value.truncated).toBeUndefined();
  });

  test('an empty legacy summary is a definitive contract violation → failed', async () => {
    const { op } = scriptedOp([completeWorker({ changed: false, summary: '   ', commits: [] })]);
    const result = await op(baseInput());
    expect(result.status).toBe('failed');
  });
});

// The bodies the cq-automation App actually posted, signature stripped, on PR
// #336 (and #334/#335/#339) between 2026-10-17 21:08Z and 2026-10-18 00:28Z,
// plus the independent reviews' probes: free text the old gate had to judge.
const LIVE_NON_ANSWERS = [
  'Reading the anchored code first.',
  'Starting work on the reviewed item.',
  'Working on it.',
  'placeholder',
  'start',
  'Investigating why the test fails.',
  'I am investigating why no changes are applied.',
  'The investigation of `src/a.ts` is still in progress.',
  'Checking whether `src/a.ts` shows the reported issue.',
  'The next step is to inspect `src/a.ts` before making any changes.',
  'No changes are needed in the guard at `src/a.ts:3`.',
] as const;

describe('the fix outcome contract (PR #336 incident; PR #343)', () => {
  const expectNoOutcome = (
    result: Awaited<ReturnType<ReturnType<typeof makeFixReviewItem>>>,
    why: string,
  ): void => {
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human') throw new Error(`unexpected ${result.status}`);
    expect(result.reason.startsWith(NO_OUTCOME_REASON)).toBe(true);
    expect(result.reason).toContain(why);
  };

  test.each(LIVE_NON_ANSWERS)(
    'a legacy free-text no-change answer %j is no outcome, whatever it says',
    async (summary) => {
      const { op } = scriptedOp([completeWorker({ changed: false, summary, commits: [] })]);
      expectNoOutcome(await op(baseInput()), 'legacy no-change contract');
    },
  );

  test.each([
    ['needs_human', 'A maintainer must choose between the two retry policies.'],
    ['no_outcome', 'Reading the anchored code first.'],
  ])('disposition %s is no outcome', async (disposition, summary) => {
    const { op } = scriptedOp([
      completeWorker({ disposition, summary, commits: [], evidence: [] }),
    ]);
    expectNoOutcome(await op(baseInput()), `worker disposition ${disposition}`);
  });

  test('unchanged_with_reason without evidence is no outcome', async () => {
    const { op } = scriptedOp([completeWorker({ ...UNCHANGED, evidence: [] })]);
    expectNoOutcome(await op(baseInput()), 'cites no evidence');
  });

  test.each([
    NO_CHANGE,
    // The independent review's P2 at c05577e2: wording is never judged.
    'I am leaving `src/a.ts:3` unchanged because its guard already rejects empty input.',
  ])('unchanged_with_reason with evidence %j is an outcome', async (summary) => {
    const { op } = scriptedOp([completeWorker({ ...UNCHANGED, summary })]);
    const value = expectOk(await op(baseInput()));
    expect(value).toMatchObject({
      disposition: 'unchanged_with_reason',
      changed: false,
      summary,
      commits: [],
      evidence: [{ path: 'src/a.ts', line: 3 }],
    });
  });

  test('fixed with its commits is an outcome; legacy changed:true with commits reads as fixed', async () => {
    const sha = 'a'.repeat(40);
    const { op } = scriptedOp([
      completeWorker({
        disposition: 'fixed',
        summary: 'Guarded the abort.',
        commits: [sha],
        evidence: [],
      }),
      completeWorker({ changed: true, summary: 'Guarded the abort.', commits: [sha] }),
    ]);
    for (let run = 0; run < 2; run += 1) {
      expect(expectOk(await op(baseInput()))).toMatchObject({
        disposition: 'fixed',
        changed: true,
        commits: [sha],
        evidence: [],
      });
    }
  });

  // The reason bytes are the externally observed mapping: the Python cq driver
  // (crq_repair/drivers/cq.py) classifies from the stable token at this exact
  // position, so pin whole strings rather than fragments.
  describe('the no-outcome reason is the externally observed mapping (crq token)', () => {
    test.each(['needs_human', 'no_outcome'] as const)(
      '%s → exact reason carrying the worker disposition token',
      async (disposition) => {
        const summary = 'A maintainer must choose.';
        const { op } = scriptedOp([
          completeWorker({ disposition, summary, commits: [], evidence: [] }),
        ]);
        expect(await op(baseInput())).toEqual({
          status: 'needs-human',
          reason: `fixReviewItem: no outcome to post — worker disposition ${disposition}: ${summary}`,
        });
      },
    );

    test('evidence-missing keeps the legacy prose and no worker disposition token', async () => {
      const { op } = scriptedOp([completeWorker({ ...UNCHANGED, evidence: [] })]);
      expect(await op(baseInput())).toEqual({
        status: 'needs-human',
        reason:
          'fixReviewItem: no outcome to post — disposition unchanged_with_reason cites no evidence',
      });
    });

    test('legacy changed:false keeps the legacy prose byte-for-byte', async () => {
      const { op } = scriptedOp([
        completeWorker({ changed: false, summary: NO_CHANGE, commits: [] }),
      ]);
      expect(await op(baseInput())).toEqual({
        status: 'needs-human',
        reason:
          'fixReviewItem: no outcome to post — a legacy no-change contract carries no disposition or evidence',
      });
    });

    test('the parser reason is capped at 200 chars before the session suffix', async () => {
      const summary = 'r'.repeat(300);
      const { op } = scriptedOp([
        completeWorker(
          { disposition: 'needs_human', summary, commits: [], evidence: [] },
          { sessionId: 'sess-9' },
        ),
      ]);
      const parsed = `worker disposition needs_human: ${summary}`;
      expect(await op(baseInput())).toEqual({
        status: 'needs-human',
        reason: `${NO_OUTCOME_REASON} — ${parsed.slice(0, 200)} (session sess-9)`,
      });
    });
  });

  test.each([
    ['an unknown disposition', { ...UNCHANGED, disposition: 'done' }],
    ['commits on unchanged_with_reason', { ...UNCHANGED, commits: ['a'.repeat(40)] }],
    [
      'commits on needs_human',
      { disposition: 'needs_human', summary: 's', commits: ['a'.repeat(40)], evidence: [] },
    ],
    ['fixed naming no commit', { disposition: 'fixed', summary: 's', commits: [], evidence: [] }],
    ['an absolute evidence path', { ...UNCHANGED, evidence: [{ path: '/etc/passwd', line: 1 }] }],
    [
      'a parent-escaping evidence path',
      { ...UNCHANGED, evidence: [{ path: 'src/../../x', line: 1 }] },
    ],
    ['an empty evidence path', { ...UNCHANGED, evidence: [{ path: '', line: 1 }] }],
    ['a zero evidence line', { ...UNCHANGED, evidence: [{ path: 'src/a.ts', line: 0 }] }],
    ['a fractional evidence line', { ...UNCHANGED, evidence: [{ path: 'src/a.ts', line: 1.5 }] }],
    [
      'an evidence entry with an extra key',
      { ...UNCHANGED, evidence: [{ path: 'src/a.ts', line: 3, note: 'x' }] },
    ],
    [
      `more than MAX_EVIDENCE (${String(MAX_EVIDENCE)}) entries`,
      {
        ...UNCHANGED,
        evidence: Array.from({ length: MAX_EVIDENCE + 1 }, () => ({ path: 'src/a.ts', line: 3 })),
      },
    ],
    ['a missing evidence key', { disposition: 'unchanged_with_reason', summary: 's', commits: [] }],
    ['mixed v1 and v2 keys', { ...UNCHANGED, changed: false }],
  ])('%s → failed (contract violation)', async (_name, structuredOutput) => {
    const { op } = scriptedOp([completeWorker(structuredOutput)]);
    expect((await op(baseInput())).status).toBe('failed');
  });

  test('the user prompt states the disposition contract (non-overridable)', async () => {
    const { op, invocations } = scriptedOp([completeWorker(UNCHANGED)]);
    await op(baseInput({ promptOverride: 'OVERRIDE PROMPT' }));
    expect(invocations[0]?.prompt).toContain('"disposition" is "fixed" only when');
    expect(invocations[0]?.prompt).toContain('"evidence" entry citing the file');
  });
});

describe('commits-array bounds (round-3 item 2)', () => {
  test(`more than MAX_FIX_COMMITS (${MAX_FIX_COMMITS}) entries → failed`, async () => {
    const shas = Array.from({ length: MAX_FIX_COMMITS + 1 }, (_, i) =>
      (i.toString(16) + '0'.repeat(40)).slice(0, 40),
    );
    const { op } = scriptedOp([completeWorker({ changed: true, summary: 's', commits: shas })]);
    const result = await op(baseInput());
    expect(result.status).toBe('failed');
  });

  test('a 100-char commit entry → failed', async () => {
    const { op } = scriptedOp([
      completeWorker({ changed: true, summary: 's', commits: ['a'.repeat(100)] }),
    ]);
    const result = await op(baseInput());
    expect(result.status).toBe('failed');
  });
});

describe('commit sha shape (round-3 item 15)', () => {
  test('an abbreviated sha that would resolve in git is rejected → failed', async () => {
    const { op } = scriptedOp([
      completeWorker({ changed: true, summary: 's', commits: ['cafe123'] }),
    ]);
    const result = await op(baseInput());
    expect(result.status).toBe('failed');
  });
});

describe('FixReviewItemOutputSchema (Codex 2j)', () => {
  test('accepts the fix contract', () => {
    expect(
      FixReviewItemOutputSchema.safeParse({
        disposition: 'fixed',
        summary: 's',
        commits: ['a'.repeat(40)],
        evidence: [],
      }).success,
    ).toBe(true);
  });

  test('rejects an extra key', () => {
    expect(FixReviewItemOutputSchema.safeParse({ ...UNCHANGED, extra: 1 }).success).toBe(false);
  });
});
