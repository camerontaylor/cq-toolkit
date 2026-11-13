// Split provenance: test/ops/merge/classifyPrs.test.ts was split by subject into
// classifyPrs.{rows,temporal,all-clear,allClearPattern,acceptance,config,objections}.test.ts
// plus classifyPrs.helpers.ts (shared fixtures). This file carries what counts
// as acceptable review evidence: plain exact-head PASS signals, the row-6
// reviewer rules, and the row-7 verdict states.
import { describe, expect, test } from 'vitest';
import { readCqEnv } from '../../../src/config/env.js';
import { defaultClassifyPrConfig } from '../../../src/ops/merge/classify.config.js';
import { classifyPr } from '../../../src/ops/merge/classifyPrs.js';
import { registry } from '../../../src/ops/merge/registry.js';
import {
  HEAD,
  PENDING_MS,
  SETTLED_MS,
  agentMarker,
  approved,
  candidate,
  comment,
  settleCandidate,
  thread,
} from './classifyPrs.helpers.js';

describe('plain independent review acceptance', () => {
  test.each([{ authorType: 'Bot' }, { authorLogin: 'reviewer[bot]' }])(
    'ignores bot review signals: %j',
    (author) => {
      expect(
        classifyPr(
          candidate({
            headRefOid: 'a'.repeat(40),
            issueComments: [
              comment({
                body: `${'a'.repeat(40)} PASS`,
                ...author,
              }),
            ],
          }),
          PENDING_MS,
        ).reason,
      ).toBe('no_acceptable_review');
    },
  );

  test.each([
    { authorType: 'Bot', authorLogin: 'cq-review[bot]' },
    { authorType: 'Bot', authorLogin: 'cq-review' },
  ])('accepts a cq-review App PASS (REST and GraphQL login forms): %j', (author) => {
    expect(
      classifyPr(
        candidate({
          headRefOid: 'a'.repeat(40),
          issueComments: [comment({ body: `${'a'.repeat(40)} PASS`, ...author })],
        }),
        PENDING_MS,
      ).reason,
    ).toBe('settle_window_pending');
  });

  test('accepts a cq-review COMMENT review with an unresolved minor thread', () => {
    const author = { authorType: 'Bot', authorLogin: 'cq-review[bot]' };
    expect(
      classifyPr(
        candidate({
          headRefOid: 'a'.repeat(40),
          reviews: [
            approved({
              ...author,
              state: 'COMMENTED',
              body: `**Independent review (Sol): PASS for \`${'a'.repeat(40)}\`**`,
            }),
          ],
          threads: [thread({ ...author, body: 'minor: simplify the helper' })],
        }),
        PENDING_MS,
      ).reason,
    ).toBe('settle_window_pending');
  });

  test.each([{ automationLogin: 'cq-automation[bot]' }, { excludedLogins: ['automation-author'] }])(
    'still accepts the cq-review App PASS when the PR author itself is automation or excluded: %j',
    (config) => {
      const authorLogin = 'automationLogin' in config ? 'cq-automation[bot]' : 'automation-author';
      expect(
        classifyPr(
          candidate({
            headRefOid: 'a'.repeat(40),
            authorLogin,
            issueComments: [
              comment({
                authorType: 'Bot',
                authorLogin: 'cq-review[bot]',
                body: `${'a'.repeat(40)} PASS`,
              }),
            ],
          }),
          PENDING_MS,
          { ...defaultClassifyPrConfig, ...config },
        ).reason,
      ).toBe('settle_window_pending');
    },
  );

  test('the excluded PR author cannot accept through the shared-account path', () => {
    expect(
      classifyPr(
        candidate({
          headRefOid: 'a'.repeat(40),
          authorLogin: 'automation-author',
          issueComments: [
            comment({
              authorType: 'User',
              authorLogin: 'automation-author',
              body: `${'a'.repeat(40)} PASS`,
            }),
          ],
        }),
        PENDING_MS,
        { ...defaultClassifyPrConfig, excludedLogins: ['automation-author'] },
      ).reason,
    ).toBe('no_acceptable_review');
  });

  test.each([{ automationLogin: 'AuToMaTiOn-AuThOr' }, { excludedLogins: ['AuToMaTiOn-AuThOr'] }])(
    'mixed-case author exclusions block exact-head PASS: %j',
    (config) => {
      for (const evidence of ['comment', 'review']) {
        const signal = { authorLogin: 'automation-author', body: `${'a'.repeat(40)} PASS` };
        expect(
          classifyPr(
            candidate({
              authorLogin: 'automation-author',
              headRefOid: 'a'.repeat(40),
              issueComments: evidence === 'comment' ? [comment(signal)] : [],
              reviews: evidence === 'review' ? [approved({ ...signal, state: 'COMMENTED' })] : [],
            }),
            PENDING_MS,
            { ...defaultClassifyPrConfig, ...config },
          ).reason,
        ).toBe('no_acceptable_review');
      }
    },
  );

  test('accepts a plain top-level PR-author comment with the exact head and PASS', () => {
    expect(
      classifyPr(
        candidate({
          headRefOid: 'a'.repeat(40),
          issueComments: [
            comment({ authorLogin: 'pr-author', body: `opus ${'a'.repeat(40)} PASS` }),
          ],
        }),
        PENDING_MS,
      ).reason,
    ).toBe('settle_window_pending');
  });

  test('a non-author commenter posting an exact-head PASS is not acceptance', () => {
    expect(
      classifyPr(
        candidate({
          headRefOid: 'a'.repeat(40),
          issueComments: [comment({ authorLogin: 'mallory', body: `${'a'.repeat(40)} PASS` })],
        }),
        PENDING_MS,
      ).reason,
    ).toBe('no_acceptable_review');
  });

  test('a DISMISSED author review carrying a PASS is void', () => {
    const pr = candidate({
      authorLogin: 'pr-author',
      headRefOid: 'a'.repeat(40),
      reviews: [
        approved({
          authorLogin: 'pr-author',
          state: 'DISMISSED',
          body: `${'a'.repeat(40)} PASS`,
        }),
      ],
    });
    expect(classifyPr(pr, PENDING_MS).reason).toBe('no_acceptable_review');
  });

  test('the automation login authoring the PR cannot self-accept', () => {
    const pr = candidate({
      authorLogin: 'automation',
      headRefOid: 'a'.repeat(40),
      issueComments: [comment({ authorLogin: 'automation', body: `${'a'.repeat(40)} PASS` })],
    });
    expect(
      classifyPr(pr, PENDING_MS, {
        ...defaultClassifyPrConfig,
        trustedBots: [],
        automationLogin: 'automation',
      }).reason,
    ).toBe('no_acceptable_review');
  });
  test.each([`Reviewer opus: ${'a'.repeat(40)} PASS`, agentMarker('PASS')])(
    'accepts a shared-account exact-head PASS without opt-in: %s',
    (body) => {
      const pr = candidate({
        authorLogin: 'pr-author',
        headRefOid: 'a'.repeat(40),
        reviews: [approved({ authorLogin: 'pr-author', state: 'COMMENTED', body })],
      });
      expect(classifyPr(pr, PENDING_MS).reason).toBe('settle_window_pending');
    },
  );
  test.each(['PASS', `${'b'.repeat(40)} PASS`, `${'a'.repeat(40)} HOLD`])(
    'ignores evidence missing the current head and PASS: %s',
    (body) => {
      expect(
        classifyPr(
          candidate({
            headRefOid: 'a'.repeat(40),
            // This review carries no head binding: the comment-body PASS is
            // not acceptance when the review cannot prove it covers HEAD.
            reviews: [approved({ state: 'COMMENTED', body, commitOid: null })],
          }),
          PENDING_MS,
        ).reason,
      ).toBe('no_acceptable_review');
    },
  );
});

// ---------------------------------------------------------------------------
// #1213 — an absent headRefOid must fail closed exactly like an explicit null
// ---------------------------------------------------------------------------

describe('classifyPr — a missing head is not a wildcard (#1213)', () => {
  const reviewed = approved({ commitOid: HEAD });

  test('an omitted headRefOid with a post-commit APPROVED review awaits', () => {
    const { headRefOid: _omitted, ...headless } = candidate({ reviews: [reviewed] });
    expect(classifyPr(headless, SETTLED_MS)).toMatchObject({
      verdict: 'awaiting',
      reason: 'no_acceptable_review',
    });
  });

  test('an explicit null head classifies identically to an omitted head', () => {
    const { headRefOid: _omitted, ...headless } = candidate({ reviews: [reviewed] });
    expect(classifyPr({ ...headless, headRefOid: null }, SETTLED_MS)).toEqual(
      classifyPr(headless, SETTLED_MS),
    );
  });

  test('a matching head still accepts the same review (head-bound case preserved)', () => {
    expect(classifyPr(candidate({ reviews: [reviewed] }), SETTLED_MS)).toMatchObject({
      verdict: 'eligible',
      reason: 'settle_window_elapsed',
    });
  });

  test('a review bound to a different head is still rejected', () => {
    expect(
      classifyPr(candidate({ reviews: [approved({ commitOid: 'b'.repeat(40) })] }), SETTLED_MS),
    ).toMatchObject({ verdict: 'awaiting', reason: 'no_acceptable_review' });
  });

  test('the dispatched merge.classifyPrs op fails closed on an omitted headRefOid', async () => {
    const entry = registry.find((candidate) => candidate.name === 'merge.classifyPrs');
    if (entry === undefined) throw new Error('merge.classifyPrs is not registered');
    const op = await entry.importer({ cqEnv: readCqEnv({}) });
    const { headRefOid: _omitted, ...headless } = candidate({ reviews: [reviewed] });
    await expect(op({ candidate: headless, nowMs: SETTLED_MS })).resolves.toMatchObject({
      status: 'ok',
      value: { verdict: 'awaiting', reason: 'no_acceptable_review' },
    });
  });
});

// ---------------------------------------------------------------------------
// What counts as an acceptable review (row 6) — no reviewer privileged
// ---------------------------------------------------------------------------

describe('classifyPr — acceptable-review rules (row 6)', () => {
  test('an author self-review does not satisfy row 6', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ authorLogin: 'pr-author' })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a bot skip/failure notice does not satisfy row 7 (skipPatterns)', () => {
    const result = classifyPr(
      candidate({
        reviews: [
          approved({
            authorLogin: 'coderabbitai[bot]',
            state: 'COMMENTED',
            body: 'CodeRabbit skipped this run because of a configuration error.',
          }),
        ],
      }),
      SETTLED_MS,
    );
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a SPLIT-LINE bot notice ("CodeRabbit" alone on its line, verb on the next) is not a review', () => {
    // Round 3: the bounded window spans line breaks ([\s\S]{0,80}, kept in
    // sync with ws-e's copy) — the split rendering does not dodge the skip
    // screen.
    const result = classifyPr(
      candidate({
        reviews: [
          approved({
            authorLogin: 'coderabbitai[bot]',
            state: 'COMMENTED',
            body: 'CodeRabbit\nskipped this run',
          }),
        ],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a DISMISSED review does not satisfy row 6 (voided verdict)', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ state: 'DISMISSED' })] }),
      SETTLED_MS,
    );
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a non-author BOT review DOES satisfy row 6 (no reviewer privileged)', () => {
    const result = classifyPr(
      candidate({
        reviews: [
          approved({
            authorLogin: 'coderabbitai[bot]',
            state: 'COMMENTED',
            body: 'reviewed the diff and left two nitpicks.',
          }),
        ],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('settle_window_elapsed');
  });

  test('a null-authorLogin review DOES satisfy row 6 (external — fail toward accepting)', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ authorLogin: null })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('settle_window_elapsed');
  });

  test("the author's own unresolved thread does not block (row 5 excludes the PR author)", () => {
    const result = classifyPr(
      settleCandidate({ threads: [thread({ authorLogin: 'pr-author' })] }),
      SETTLED_MS,
    );
    expect(result.unresolvedExternalThreads).toBe(0);
    expect(result.reason).toBe('settle_window_elapsed');
  });
});

// ---------------------------------------------------------------------------
// Acceptance VERDICTS (row 6) — only APPROVED/COMMENTED carry evidence
// ---------------------------------------------------------------------------

describe('classifyPr — acceptance states (row 7)', () => {
  test('a post-commit COMMENTED review IS acceptable (control: the settle flow works)', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ state: 'COMMENTED' })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('settle_window_elapsed');
  });

  test('a null-state review never counts (fail toward awaiting)', () => {
    const result = classifyPr(candidate({ reviews: [approved({ state: null })] }), SETTLED_MS);
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });
});

describe('latest CRQ verdict at the exact head', () => {
  const body = (verdict: string, head = HEAD, refresh = false) =>
    `${refresh ? `<!-- crq-verdict-refresh head=${head} scan-run=scan -->` : '<!-- crq-findings run=scan -->'}\n**Independent review (CodeRabbit CLI via crq): ${verdict} for \`${head}\`**\n`;
  const crq = (verdict: string, at: string, head = HEAD, refresh = false) =>
    approved({
      authorType: 'Bot',
      authorLogin: 'cq-review[bot]',
      state: 'COMMENTED',
      submittedAt: at,
      body: body(verdict, head, refresh),
    });
  test('dismissed ITERATE without chronology cannot hide earlier PASS', () => {
    const pass = crq('PASS', '2026-01-01T00:00:01Z');
    const dismissed = {
      ...crq('ITERATE', '2026-01-01T00:00:02Z'),
      state: 'DISMISSED' as const,
      submittedAt: null,
    };
    expect(classifyPr(candidate({ reviews: [dismissed, pass] }), PENDING_MS).reason).toBe(
      'settle_window_pending',
    );
  });
  test('a native changes-requested review containing a CRQ header remains an objection', () => {
    const objection = approved({
      authorLogin: 'objector',
      authorType: 'User',
      state: 'CHANGES_REQUESTED',
      body: body('ITERATE'),
    });
    expect(
      classifyPr(
        candidate({ reviews: [crq('PASS', '2026-01-01T00:00:01Z'), objection] }),
        PENDING_MS,
      ).reason,
    ).toBe('merge_objection_outstanding');
  });
  test('trusted non-author host fallback joins CRQ history; untrusted fallback does not', () => {
    const app = crq('PASS', '2026-01-01T00:00:01Z');
    const fallback = {
      ...crq('ITERATE', '2026-01-01T00:00:02Z'),
      authorLogin: 'queue-host',
      authorType: 'User',
      authorAssociation: 'OWNER',
    };
    expect(classifyPr(candidate({ reviews: [app, fallback] }), PENDING_MS).reason).toBe(
      'no_acceptable_review',
    );
    expect(
      classifyPr(candidate({ reviews: [{ ...fallback, body: body('PASS') }] }), PENDING_MS).reason,
    ).toBe('settle_window_pending');
    expect(
      classifyPr(
        candidate({ reviews: [{ ...fallback, body: body('PASS'), authorAssociation: 'NONE' }] }),
        PENDING_MS,
      ).reason,
    ).toBe('no_acceptable_review');
    expect(
      classifyPr(
        candidate({ reviews: [app, { ...fallback, authorAssociation: 'NONE' }] }),
        PENDING_MS,
      ).reason,
    ).toBe('settle_window_pending');
  });
  test.each([false, true])('uses submission time, not input order (reverse=%s)', (reverse) => {
    const earlier = crq('PASS', '2026-01-01T00:00:01Z');
    const later = crq('ITERATE', '2026-01-01T00:00:02Z');
    const reviews = reverse ? [later, earlier] : [earlier, later];
    expect(classifyPr(candidate({ reviews }), PENDING_MS).reason).toBe('no_acceptable_review');
    const refresh = crq('PASS', '2026-01-01T00:00:03Z', HEAD, true);
    expect(classifyPr(candidate({ reviews: [refresh, ...reviews] }), PENDING_MS).reason).toBe(
      'settle_window_pending',
    );
  });
  test('stale CRQ PASS cannot count even when its body mentions the current SHA', () => {
    const stale = crq('PASS', '2026-01-01T00:00:03Z', 'b'.repeat(40));
    stale.body += `Finding mentions ${HEAD}`;
    expect(classifyPr(candidate({ reviews: [stale] }), PENDING_MS).reason).toBe(
      'no_acceptable_review',
    );
  });
  test('CRQ ITERATE preserves independent non-CRQ acceptance', () => {
    expect(
      classifyPr(
        candidate({ reviews: [crq('ITERATE', '2026-01-01T00:00:03Z'), approved()] }),
        PENDING_MS,
      ).reason,
    ).toBe('settle_window_pending');
  });
});
