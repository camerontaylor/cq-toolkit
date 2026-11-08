// M4b1: import self-declared acceptances from recorded PR-comment
// snapshots. One case per asserted condition: exact anchored header forms
// (PASS/ITERATE and coordinator carry-over), near-miss headers as unknowns
// rather than rows, one admit/dedup path keyed head+base+reviewer with
// conflict exclusion and order independence, missing bases and corrupt or
// incomplete snapshots as unknowns (never a zero fallback), and the rows
// feeding M10e unchanged. Failure cases keep the M10b discipline: malformed
// evidence is an unknown entry with a reason, never a crash.
// Fixture data is synthetic throughout: shas, ids, logins and URLs are
// invented for these tests; no real snapshot is committed.
import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { importAcceptance } from '../scripts/measurement-acceptance.mjs';
import { computeOutcomePanels } from '../scripts/measurement-outcomes.mjs';
import { AcceptancePayloadSchema } from '../src/kernel/schema.js';

const LOGIN = 'synthetic-author';
const HEAD_A = 'b'.repeat(40);
const HEAD_B = 'c'.repeat(40);
const HEAD_C = 'd'.repeat(40);
const HEAD_D = 'e'.repeat(40);
const BASE_A = 'a'.repeat(40);
const AT_A = '2026-11-04T09:37:45Z';
const AT_A_MS = '2026-11-04T09:37:45.000Z';
const INDEPENDENT_REASON =
  'self-declared in review comment header; reviewer identity not verified (shared GitHub account)';
const pass = (sha: string) => `**Independent review (DeepSeek): PASS for \`${sha}\`**`;
const iterate = (sha: string) => `**Independent review (DeepSeek): ITERATE for \`${sha}\`**`;
const carry = (sha: string) => `**Independent PASS carried to head \`${sha}\`.**`;

interface FixtureComment {
  id: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: { login: string };
  body: string;
}

let seq = 6600000000;
/** A synthetic recorded comment; ids ascend so each html_url is distinct. */
const comment = (
  body: string,
  init: { id?: number; created_at?: string; login?: string } = {},
): FixtureComment => {
  const id = init.id ?? ++seq;
  const at = init.created_at ?? AT_A;
  return {
    id,
    html_url: `https://github.com/synthetic-org/synthetic-repo/issues/7#issuecomment-${id}`,
    created_at: at,
    updated_at: at,
    user: { login: init.login ?? LOGIN },
    body,
  };
};

interface FixtureSnapshot {
  repo: string;
  pr_number: number;
  fetched_at: string;
  pr: {
    number: number;
    user: { login: string };
    head: { sha: string };
    base: { ref: string };
    merged_at: string;
    merge_commit_sha: string;
  };
  comments: unknown[];
  reviews?: unknown;
  bases: Record<string, string | null>;
  pagination: { comments: number };
  complete: boolean;
  failed_step: string | null;
}

/** A synthetic recorded snapshot (docs/measurement/import-acceptance.md). */
const snapshot = (
  comments: unknown[],
  init: {
    bases?: Record<string, string | null>;
    complete?: boolean;
    failed_step?: string;
    reviews?: unknown;
    noReviews?: boolean;
  } = {},
): FixtureSnapshot => ({
  repo: 'synthetic-org/synthetic-repo',
  pr_number: 7,
  fetched_at: '2026-11-05T00:00:00Z',
  pr: {
    number: 7,
    user: { login: LOGIN },
    head: { sha: HEAD_B },
    base: { ref: 'main' },
    merged_at: '2026-11-04T11:07:29Z',
    merge_commit_sha: 'f'.repeat(40),
  },
  comments,
  ...(init.noReviews ? {} : { reviews: init.reviews ?? [] }),
  bases: init.bases ?? { [HEAD_A]: BASE_A, [HEAD_B]: BASE_A, [HEAD_C]: BASE_A },
  pagination: { comments: 1 },
  complete: init.complete ?? true,
  failed_step: init.failed_step ?? null,
});

describe('M4b1 nominal evidence', () => {
  test('a PASS header yields a schema-valid self-declared acceptance row', () => {
    const c = comment(`${pass(HEAD_A)}\r\n\r\nMutation kills recorded below.`);
    const result = importAcceptance(snapshot([c]));

    expect(result.unknown).toEqual([]);
    expect(result.acceptances).toHaveLength(1);
    const row = result.acceptances[0]!;
    expect(AcceptancePayloadSchema.safeParse(row).success).toBe(true);
    expect(row).toMatchObject({
      headSha: HEAD_A,
      reviewedBaseSha: BASE_A,
      reviewerId: 'self-declared:DeepSeek',
      authorId: `github:${LOGIN}`,
      independent: true,
      verdict: 'PASS',
      evidence: [c.html_url],
    });
    expect(row.availability['/independent']).toEqual({
      state: 'known',
      reason: INDEPENDENT_REASON,
      source: c.html_url,
    });
    // The capture instant rides in the parallel meta array, ms-normalised.
    expect(result.meta).toEqual([{ at: AT_A_MS }]);
  });

  test('a review posted by cq-review[bot] is attested; the same header from the owner account is not', () => {
    const app = comment(pass(HEAD_A), { login: 'cq-review[bot]' });
    const owner = comment(pass(HEAD_A));
    const result = importAcceptance(snapshot([app, owner]));

    expect(result.unknown).toEqual([]);
    expect(result.acceptances).toHaveLength(2);
    for (const row of result.acceptances)
      expect(AcceptancePayloadSchema.safeParse(row).success).toBe(true);
    const byId = new Map(result.acceptances.map((r) => [r.reviewerId, r]));
    expect(byId.get('app:cq-review:DeepSeek')?.availability['/independent']).toEqual({
      state: 'known',
      reason:
        'posted by the cq-review GitHub App (cq-review[bot]), an identity separate from the owner account; reviewer name self-declared in the header',
      source: app.html_url,
    });
    expect(byId.get('self-declared:DeepSeek')?.availability['/independent']).toEqual({
      state: 'known',
      reason: INDEPENDENT_REASON,
      source: owner.html_url,
    });
    // A look-alike login is not the App.
    const lookalike = importAcceptance(snapshot([comment(pass(HEAD_A), { login: 'cq-review' })]));
    expect(lookalike.acceptances[0]?.reviewerId).toBe('self-declared:DeepSeek');
    // Carry-overs stay self-declared whoever posts them.
    const carried = importAcceptance(
      snapshot([comment(carry(HEAD_A), { login: 'cq-review[bot]' })]),
    );
    expect(carried.acceptances[0]?.reviewerId).toBe('self-declared:coordinator');
  });

  test('a findings-mode PR review (run marker, then header) is read from reviews', () => {
    const review = {
      id: 4200,
      html_url: 'https://github.com/synthetic-org/synthetic-repo/pull/7#pullrequestreview-4200',
      submitted_at: AT_A,
      user: { login: 'cq-review[bot]' },
      body: `<!-- crq-findings run=7-bbbbbbbbbb-DeepSeek -->\n${pass(HEAD_A)}\n\n- P3 one minor thread`,
    };
    const result = importAcceptance(snapshot([], { reviews: [review] }));

    expect(result.unknown).toEqual([]);
    expect(result.acceptances).toHaveLength(1);
    const row = result.acceptances[0]!;
    expect(AcceptancePayloadSchema.safeParse(row).success).toBe(true);
    expect(row).toMatchObject({
      headSha: HEAD_A,
      reviewerId: 'app:cq-review:DeepSeek',
      verdict: 'PASS',
      evidence: [review.html_url],
    });
    expect(result.meta).toEqual([{ at: AT_A_MS }]);
  });

  test('marker skipping is for whole-line HTML comments before the header only', () => {
    const late = comment(`<!-- marker -->\nnot a header\n${pass(HEAD_A)}`);
    const markerOnly = comment('<!-- crq-findings run=x -->');
    const inline = comment(`<!-- marker --> ${pass(HEAD_A)}`);
    const result = importAcceptance(snapshot([late, markerOnly, inline]));
    expect(result.acceptances).toEqual([]);
    expect(result.unknown).toEqual([]);
    // Two leading markers are both skipped.
    const two = importAcceptance(snapshot([comment(`<!-- a -->\r\n<!-- b -->\n${pass(HEAD_A)}`)]));
    expect(two.acceptances).toHaveLength(1);
  });

  test('ITERATE maps to HOLD', () => {
    const result = importAcceptance(snapshot([comment(iterate(HEAD_A))]));

    expect(result.unknown).toEqual([]);
    expect(result.acceptances[0]).toMatchObject({
      reviewerId: 'self-declared:DeepSeek',
      verdict: 'HOLD',
    });
  });

  test('a carry-over header yields the coordinator row with referenced comment URLs', () => {
    const body = [
      carry(HEAD_A),
      '',
      'Reviewer passed earlier: https://github.com/synthetic-org/synthetic-repo/issues/7#issuecomment-111',
      'then https://github.com/synthetic-org/synthetic-repo/issues/7#issuecomment-222 and none later.',
    ].join('\n');
    const c = comment(body);
    const rebased = comment(`**Independent PASS carried to rebased head \`${HEAD_B}\`.**`);
    const result = importAcceptance(snapshot([c, rebased]));

    expect(result.unknown).toEqual([]);
    expect(result.acceptances[0]).toMatchObject({
      reviewerId: 'self-declared:coordinator',
      verdict: 'PASS',
      // Referenced issuecomment URLs join the evidence in body order.
      evidence: [
        c.html_url,
        'https://github.com/synthetic-org/synthetic-repo/issues/7#issuecomment-111',
        'https://github.com/synthetic-org/synthetic-repo/issues/7#issuecomment-222',
      ],
    });
    expect(result.acceptances[1]).toMatchObject({
      headSha: HEAD_B,
      reviewerId: 'self-declared:coordinator',
      verdict: 'PASS',
      evidence: [rebased.html_url],
    });
  });

  test('the rows feed computeOutcomePanels and a PASS makes the head population-eligible', () => {
    const accepted = importAcceptance(snapshot([comment(pass(HEAD_A))]));
    const panels = computeOutcomePanels({
      acceptances: accepted.acceptances,
      population: [{ headSha: HEAD_A, mergedAt: '2026-11-01T00:00:00.000Z' }],
      followUpDays: 1,
      observedAt: '2026-11-20T00:00:00.000Z',
    });
    expect(panels.population.eligible).toBe(1);
    expect(panels.population.mature).toBe(1);

    const held = importAcceptance(snapshot([comment(iterate(HEAD_A))]));
    const heldPanels = computeOutcomePanels({
      acceptances: held.acceptances,
      population: [{ headSha: HEAD_A, mergedAt: '2026-11-01T00:00:00.000Z' }],
      followUpDays: 1,
      observedAt: '2026-11-20T00:00:00.000Z',
    });
    expect(heldPanels.population.eligible).toBe(0);
    expect(heldPanels.unknown).toContainEqual({
      source: `population ${HEAD_A}`,
      kind: 'missing',
      reason: 'PR head has no independent PASS acceptance',
    });
  });
});

describe('M4b1 missing evidence', () => {
  test('a head with no recorded base is an unknown, never a row', () => {
    const c = comment(pass(HEAD_A));
    for (const bases of [{}, { [HEAD_A]: null }, { [HEAD_A]: 'short' }]) {
      const result = importAcceptance(snapshot([c], { bases }));
      expect(result.acceptances).toEqual([]);
      expect(result.unknown).toEqual([
        { source: c.html_url, kind: 'unavailable', reason: 'reviewed base not recorded' },
      ]);
    }
  });

  test('a snapshot without reviews says so; malformed reviews are corrupt', () => {
    const absent = importAcceptance(snapshot([comment(pass(HEAD_A))], { noReviews: true }));
    expect(absent.acceptances).toHaveLength(1);
    expect(absent.unknown).toEqual([
      { source: 'snapshot', kind: 'unavailable', reason: 'PR reviews not recorded' },
    ]);
    const notArray = importAcceptance(snapshot([], { reviews: 'no' }));
    expect(notArray.unknown).toEqual([
      { source: 'snapshot reviews', kind: 'corrupt', reason: 'reviews is not an array' },
    ]);
    const badTime = importAcceptance(
      snapshot([], {
        reviews: [
          {
            id: 1,
            html_url: 'https://github.com/o/r/pull/7#pullrequestreview-1',
            submitted_at: null,
            user: { login: 'cq-review[bot]' },
            body: pass(HEAD_A),
          },
          7,
        ],
      }),
    );
    expect(badTime.acceptances).toEqual([]);
    expect(badTime.unknown).toEqual([
      {
        source: 'https://github.com/o/r/pull/7#pullrequestreview-1',
        kind: 'corrupt',
        reason: 'review submitted_at is not a UTC instant',
      },
      { source: 'snapshot reviews', kind: 'corrupt', reason: 'review entry is not an object' },
    ]);
  });

  test('an incomplete snapshot yields its rows plus one partial unknown', () => {
    const result = importAcceptance(
      snapshot([comment(pass(HEAD_A))], { complete: false, failed_step: 'comments' }),
    );

    expect(result.acceptances).toHaveLength(1);
    expect(result.unknown).toEqual([
      {
        source: 'snapshot',
        kind: 'partial',
        reason: "incomplete snapshot; failed_step 'comments'",
      },
    ]);
  });

  test('an absent or malformed snapshot yields no rows and one corrupt unknown', () => {
    for (const bad of [
      null,
      'nope',
      [],
      {},
      { pr: null, comments: [] },
      { pr: { user: {} }, comments: 'no' },
    ])
      expect(importAcceptance(bad)).toEqual({
        acceptances: [],
        meta: [],
        unknown: [
          { source: 'snapshot', kind: 'corrupt', reason: 'snapshot is absent or malformed' },
        ],
      });
  });

  test('a complete snapshot with no acceptance headers is known: none found', () => {
    const result = importAcceptance(snapshot([comment('Ordinary review comment.'), comment('')]));
    expect(result).toEqual({ acceptances: [], meta: [], unknown: [] });
  });
});

describe('M4b1 failure evidence', () => {
  test('near-miss headers are malformed unknowns, not rows', () => {
    const short = comment(`**Independent review (DeepSeek): PASS for \`${'b'.repeat(7)}\`**`);
    const lower = comment(`**Independent review (DeepSeek): pass for \`${HEAD_A}\`**`);
    const extra = comment(`**Independent review (DeepSeek): PASS with notes for \`${HEAD_A}\`**`);
    const result = importAcceptance(snapshot([short, lower, extra]));

    expect(result.acceptances).toEqual([]);
    expect(result.unknown).toEqual(
      [short, lower, extra].map((c) => ({
        source: c.html_url,
        kind: 'unavailable',
        reason: 'malformed acceptance header',
      })),
    );
  });

  test('a header on line 2 is ignored', () => {
    const result = importAcceptance(snapshot([comment(`Preamble.\n${pass(HEAD_A)}`)]));
    expect(result).toEqual({ acceptances: [], meta: [], unknown: [] });
  });

  test('identical duplicate comments dedupe to one row', () => {
    const c = comment(pass(HEAD_A));
    const result = importAcceptance(snapshot([c, c]));
    expect(result.acceptances).toHaveLength(1);
    expect(result.meta).toEqual([{ at: AT_A_MS }]);
    expect(result.unknown).toEqual([]);
  });

  test('a PASS/HOLD conflict is one unknown and no row', () => {
    const a = comment(pass(HEAD_A));
    const b = comment(iterate(HEAD_A));
    const result = importAcceptance(snapshot([a, b]));

    expect(result.acceptances).toEqual([]);
    expect(result.unknown).toEqual([
      {
        source: `${a.html_url} + ${b.html_url}`,
        kind: 'conflict',
        reason: 'conflicting acceptance observations',
      },
    ]);
  });

  test('a shuffled comment order gives the same result', () => {
    const comments = [
      comment(pass(HEAD_A)),
      comment(iterate(HEAD_B)),
      comment(carry(HEAD_C)),
      comment(`**Independent review (DeepSeek): PASS for \`${'b'.repeat(8)}\`**`),
      comment(pass(HEAD_D)), // HEAD_D has no recorded base
    ];
    const ordered = importAcceptance(snapshot(comments));
    const shuffled = importAcceptance(snapshot([...comments].reverse()));

    expect(shuffled).toEqual(ordered);
    expect(ordered.acceptances).toHaveLength(3);
    expect(ordered.unknown.map((u) => u.reason).sort()).toEqual([
      'malformed acceptance header',
      'reviewed base not recorded',
    ]);
  });

  test('an invalid created_at makes the comment corrupt', () => {
    const c = comment(pass(HEAD_A), { created_at: '2026-02-30T09:37:45Z' });
    const result = importAcceptance(snapshot([c]));

    expect(result.acceptances).toEqual([]);
    expect(result.unknown).toEqual([
      { source: c.html_url, kind: 'corrupt', reason: 'comment created_at is not a UTC instant' },
    ]);
  });

  test('the importer is pure: no network or process tokens in the module', async () => {
    const source = await readFile('scripts/measurement-acceptance.mjs', 'utf8');
    for (const forbidden of [
      'fetch(',
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'child_process',
      'XMLHttpRequest',
    ])
      expect(source).not.toContain(forbidden);
  });
});
