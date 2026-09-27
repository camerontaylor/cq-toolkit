// W1.10 — tests for the read-only I2 acceptance judgment behind
// `cq/acceptance` (src/selfhost/acceptance.ts, methods Decisions 10–11).
//
// The forge is a fake GhFn (merge-recheck.test.ts's approach, minimal
// helpers copied): `api graphql` answers with a synthetic single-page PR
// payload built per test, and the I11 REST reviews/comments reads answer
// with collections CONSISTENT with that payload plus per-spec extras. Every
// argv is recorded, so "read-only" is assertable: no call other than the
// graphql snapshot and the two REST lag reads is ever made.
//
// Pinned here: pass at head; an approval of an older commit fails; an
// outstanding objection fails; unresolved external threads fail; draft,
// head moved, wrong base, truncated and REST lag fail; open vs merged
// state; never throwing; resolveAcceptanceTrust's P7 layering (blank and
// whitespace = conservative default, env values, loud failure on an
// unrecognised entry naming the key, structural identities never
// re-admitted); and the strict CLI arg parser.
import { describe, expect, test } from 'vitest';
import type { GhFn, GhResult } from '../../src/ops/review/gh.js';
import {
  ACCEPTANCE_CHECK_NAME,
  ACCEPT_REVIEW_STATES_ENV,
  TRUSTED_ASSOCIATIONS_ENV,
  TRUSTED_BOTS_ENV,
  judgeAcceptance,
  parseAcceptanceArgs,
  resolveAcceptanceTrust,
} from '../../src/selfhost/acceptance.js';
import type { AcceptanceInput } from '../../src/selfhost/acceptance.js';
import {
  CONSERVATIVE_TRUST_POLICY,
  STRUCTURAL_EXCLUDED_LOGINS,
} from '../../src/selfhost/merge-recheck.js';
import type { TrustPolicy } from '../../src/selfhost/merge-recheck.js';

const OWNER = 'octo';
const REPO = 'widget';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const BASE_NAME = 'merge-queue';
const PR = 7;

// ---------------------------------------------------------------------------
// Synthetic PR payloads
// ---------------------------------------------------------------------------

interface ReviewSpec {
  login: string;
  typename: string;
  association: string;
  state: string;
  submittedAt: string;
  oid: string;
}

interface ThreadSpec {
  isResolved: boolean;
  root: string | null;
}

interface PrSpec {
  state: string;
  isDraft: boolean;
  author: string;
  head: string;
  baseName: string;
  reviews: ReviewSpec[];
  threads: ThreadSpec[];
  /** hasNextPage with no cursor on reviews → the snapshot is truncated. */
  reviewsHasNext: boolean;
  /** Extra REST review entries (beyond the snapshot's) — reviews-lag probes. */
  restExtraReviews: unknown[];
}

const prSpec = (over: Partial<PrSpec> = {}): PrSpec => ({
  state: 'OPEN',
  isDraft: false,
  author: 'alice',
  head: SHA_B,
  baseName: BASE_NAME,
  reviews: [],
  threads: [],
  reviewsHasNext: false,
  restExtraReviews: [],
  ...over,
});

const review = (over: Partial<ReviewSpec> = {}): ReviewSpec => ({
  login: 'carol',
  typename: 'User',
  association: 'COLLABORATOR',
  state: 'APPROVED',
  submittedAt: '2026-09-24T10:00:00Z',
  oid: SHA_B,
  ...over,
});

const rootDatabaseId = (index: number): number => 1000 + index;

const payloadFor = (spec: PrSpec): unknown => ({
  data: {
    repository: {
      pullRequest: {
        state: spec.state,
        isDraft: spec.isDraft,
        author: { login: spec.author, __typename: 'User' },
        headRefOid: spec.head,
        baseRefOid: BASE,
        baseRefName: spec.baseName,
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: spec.threads.map((t, i) => ({
            isResolved: t.isResolved,
            comments: {
              nodes: [
                {
                  databaseId: rootDatabaseId(i),
                  author: t.root === null ? null : { login: t.root },
                },
              ],
            },
          })),
        },
        reviews: {
          pageInfo: { hasNextPage: spec.reviewsHasNext, endCursor: null },
          nodes: spec.reviews.map((r, i) => ({
            id: `R_${String(i)}`,
            author: { login: r.login, __typename: r.typename },
            authorAssociation: r.association,
            state: r.state,
            submittedAt: r.submittedAt,
            commit: { oid: r.oid },
          })),
        },
        timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// The fake forge (graphql + the REST lag reads; nothing else answers)
// ---------------------------------------------------------------------------

const okRes = (body: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });
const notFound = (): GhResult => ({ code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' });

interface Forge {
  gh: GhFn;
  /** 'graphql' | 'rest:<collection>' | 'other:<argv>' per call, in order. */
  log: string[];
  spec: PrSpec;
}

const makeForge = (spec: PrSpec): Forge => {
  const forge: Forge = {
    log: [],
    spec,
    gh: (args) => {
      if (args[0] === 'api' && args[1] === 'graphql') {
        forge.log.push('graphql');
        return Promise.resolve(okRes(payloadFor(forge.spec)));
      }
      const rest = /^repos\/octo\/widget\/pulls\/7\/(reviews|comments)\?per_page=100$/.exec(
        args[1] ?? '',
      );
      if (args[0] === 'api' && rest !== null && args.includes('--slurp')) {
        forge.log.push(`rest:${rest[1] ?? ''}`);
        const s = forge.spec;
        const entries =
          rest[1] === 'reviews'
            ? [
                ...s.reviews.map((r, i) => ({ node_id: `R_${String(i)}`, state: r.state })),
                ...s.restExtraReviews,
              ]
            : s.threads.map((_, i) => ({ id: rootDatabaseId(i), in_reply_to_id: null }));
        return Promise.resolve(okRes([entries]));
      }
      forge.log.push(`other:${args.join(' ')}`);
      return Promise.resolve(notFound());
    },
  };
  return forge;
};

const input = (over: Partial<AcceptanceInput> = {}): AcceptanceInput => ({
  pr: PR,
  subject: SHA_B,
  base: BASE_NAME,
  state: 'open',
  ...over,
});

const judge = (
  forge: Forge,
  over: Partial<AcceptanceInput> = {},
  policy: TrustPolicy = CONSERVATIVE_TRUST_POLICY,
) => judgeAcceptance({ gh: forge.gh, owner: OWNER, repo: REPO, policy }, input(over));

/** The report's `fail (<rule>): …` line. */
const failLine = (report: readonly string[]): string =>
  report.find((line) => line.startsWith('fail (')) ?? '';

// ---------------------------------------------------------------------------
// judgeAcceptance
// ---------------------------------------------------------------------------

describe('judgeAcceptance', () => {
  test('the check name is cq/acceptance', () => {
    expect(ACCEPTANCE_CHECK_NAME).toBe('cq/acceptance');
  });

  test('passes on trusted acceptance bound to the head, read-only', async () => {
    const forge = makeForge(prSpec({ reviews: [review()] }));
    const result = await judge(forge, { subject: SHA_B.toUpperCase() });
    expect(result).toMatchObject({
      verdict: 'pass',
      pr: PR,
      subject: SHA_B,
      acceptedBy: ['user:carol'],
    });
    expect(result.report[0]).toContain(`pr #7 subject ${SHA_B}`);
    expect(result.report[1]).toMatch(/^trust: bots=\(none\) acceptStates=APPROVED /);
    expect(result.report.at(-1)).toBe('pass: accepted by user:carol');
    // Only the snapshot and the two REST lag reads — no settle ledger, no writes.
    expect(forge.log).toEqual(['graphql', 'rest:reviews', 'rest:comments']);
  });

  test('an approval of an older commit fails', async () => {
    const forge = makeForge(prSpec({ reviews: [review({ oid: SHA_A })] }));
    const result = await judge(forge);
    expect(result.verdict).toBe('fail');
    expect(result.acceptedBy).toEqual([]);
    expect(failLine(result.report)).toMatch(/^fail \(acceptance\): no_head_bound_acceptance: /);
  });

  test('an outstanding trusted objection fails, even beside an approval at head', async () => {
    const forge = makeForge(
      prSpec({
        reviews: [review(), review({ login: 'dave', state: 'CHANGES_REQUESTED', oid: SHA_A })],
      }),
    );
    const result = await judge(forge);
    expect(failLine(result.report)).toMatch(
      /^fail \(acceptance\): objection_outstanding: changes requested by user:dave/,
    );
  });

  test('an unresolved external thread fails; the author-rooted one does not', async () => {
    const external = makeForge(
      prSpec({ reviews: [review()], threads: [{ isResolved: false, root: 'carol' }] }),
    );
    expect(failLine((await judge(external)).report)).toBe(
      'fail (threads): unresolved external threads: 1',
    );
    const own = makeForge(
      prSpec({
        reviews: [review()],
        threads: [
          { isResolved: false, root: 'alice' },
          { isResolved: true, root: 'carol' },
        ],
      }),
    );
    expect((await judge(own)).verdict).toBe('pass');
  });

  test.each<[string, Partial<PrSpec>, Partial<AcceptanceInput>, RegExp]>([
    ['draft', { isDraft: true }, {}, /^fail \(draft\): pr is a draft$/],
    [
      'head moved',
      { head: SHA_A },
      {},
      /^fail \(head\): head moved: expected b{40} but the forge reports a{40}$/,
    ],
    [
      'wrong base',
      { baseName: 'main' },
      {},
      /^fail \(base\): wrong base: required merge-queue but the forge reports main$/,
    ],
    ['truncated', { reviewsHasNext: true }, {}, /^fail \(truncated\): snapshot truncated/],
    [
      'REST lag',
      { restExtraReviews: [{ node_id: 'R_missing', state: 'APPROVED' }] },
      {},
      /^fail \(lag\): review data lag: reviews\.lag \(1 of 2 REST review/,
    ],
    ['closed while open expected', { state: 'CLOSED' }, {}, /^fail \(state\): pr is not open$/],
    ['open while merged expected', {}, { state: 'merged' }, /^fail \(state\): pr is still open/],
  ])('%s fails', async (_name, spec, over, expected) => {
    const result = await judge(makeForge(prSpec({ reviews: [review()], ...spec })), over);
    expect(result.verdict).toBe('fail');
    expect(result.acceptedBy).toEqual([]);
    expect(failLine(result.report)).toMatch(expected);
  });

  test("state 'merged' judges an already-merged PR at its merged head", async () => {
    const forge = makeForge(prSpec({ state: 'MERGED', reviews: [review()] }));
    const result = await judge(forge, { state: 'merged' });
    expect(result).toMatchObject({ verdict: 'pass', acceptedBy: ['user:carol'] });
  });

  test.each<[string, Partial<AcceptanceInput>]>([
    ['short subject', { subject: 'abc123' }],
    ['non-hex subject', { subject: 'z'.repeat(40) }],
    ['zero pr', { pr: 0 }],
    ['fractional pr', { pr: 1.5 }],
    ['empty base', { base: '' }],
  ])('rejects invalid input before any read: %s', async (_name, over) => {
    const forge = makeForge(prSpec({ reviews: [review()] }));
    const result = await judge(forge, over);
    expect(result.verdict).toBe('fail');
    expect(failLine(result.report)).toMatch(/^fail \(input\): /);
    expect(forge.log).toEqual([]);
  });

  test('never throws: a transport throw is a capped one-line fail', async () => {
    const gh: GhFn = () => Promise.reject(new Error(`socket hang up\n${'x'.repeat(2000)}`));
    const result = await judgeAcceptance(
      { gh, owner: OWNER, repo: REPO, policy: CONSERVATIVE_TRUST_POLICY },
      input(),
    );
    expect(result.verdict).toBe('fail');
    const line = failLine(result.report);
    expect(line).toBe('fail (fetch): acceptance fetch failed: socket hang up');
  });

  test('never throws: a gh failure on a REST lag read fails the lag rule', async () => {
    const forge = makeForge(prSpec({ reviews: [review()] }));
    const inner = forge.gh;
    const gh: GhFn = (args) =>
      (args[1] ?? '').endsWith('/comments?per_page=100')
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)' })
        : inner(args);
    const result = await judgeAcceptance(
      { gh, owner: OWNER, repo: REPO, policy: CONSERVATIVE_TRUST_POLICY },
      input(),
    );
    expect(failLine(result.report)).toMatch(
      /^fail \(lag\): review data lag: restComments read failed/,
    );
  });

  test('a trusted bot counts only when allowlisted', async () => {
    const spec = prSpec({
      reviews: [review({ login: 'coderabbitai', typename: 'Bot', association: 'NONE' })],
    });
    expect((await judge(makeForge(spec))).verdict).toBe('fail');
    const { policy } = resolveAcceptanceTrust({ [TRUSTED_BOTS_ENV]: 'coderabbitai[bot]' });
    expect(await judge(makeForge(spec), {}, policy)).toMatchObject({
      verdict: 'pass',
      acceptedBy: ['bot:coderabbitai'],
    });
  });

  test('structural automation identities stay excluded even when listed as trusted bots', async () => {
    const { policy } = resolveAcceptanceTrust({
      [TRUSTED_BOTS_ENV]: STRUCTURAL_EXCLUDED_LOGINS.join(','),
    });
    expect(policy.trustedBots.size).toBe(0);
    const forge = makeForge(
      prSpec({
        reviews: [review({ login: 'github-actions[bot]', typename: 'Bot', association: 'NONE' })],
      }),
    );
    expect((await judge(forge, {}, policy)).verdict).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// resolveAcceptanceTrust
// ---------------------------------------------------------------------------

describe('resolveAcceptanceTrust', () => {
  test('absent keys resolve to the conservative default', () => {
    const trust = resolveAcceptanceTrust({});
    expect([...trust.policy.trustedBots]).toEqual([]);
    expect([...trust.policy.acceptStates]).toEqual(['APPROVED']);
    expect([...trust.policy.trustedAssociations].sort()).toEqual([
      'COLLABORATOR',
      'MEMBER',
      'OWNER',
    ]);
    expect(trust.layers).toEqual({
      trustedBots: 'default',
      acceptReviewStates: 'default',
      trustedAssociations: 'default',
    });
    expect(trust.report).toEqual([
      'CQ_MERGE_TRUSTED_BOTS=(none) (default)',
      'CQ_MERGE_ACCEPT_REVIEW_STATES=APPROVED (default)',
      'CQ_MERGE_TRUSTED_ASSOCIATIONS=COLLABORATOR,MEMBER,OWNER (default)',
    ]);
  });

  test('blank and whitespace-only values are the default layer', () => {
    const trust = resolveAcceptanceTrust({
      [TRUSTED_BOTS_ENV]: '',
      [ACCEPT_REVIEW_STATES_ENV]: '   ',
      [TRUSTED_ASSOCIATIONS_ENV]: ' \t ',
    });
    expect(trust.layers).toEqual({
      trustedBots: 'default',
      acceptReviewStates: 'default',
      trustedAssociations: 'default',
    });
    expect(trust.report).toEqual(resolveAcceptanceTrust({}).report);
  });

  test('env values resolve (trimmed, case-insensitive) from the env layer', () => {
    const trust = resolveAcceptanceTrust({
      [TRUSTED_BOTS_ENV]: ' coderabbitai[bot] , ,renovate ',
      [ACCEPT_REVIEW_STATES_ENV]: 'approved, Commented',
      [TRUSTED_ASSOCIATIONS_ENV]: 'owner',
    });
    expect([...trust.policy.trustedBots].sort()).toEqual(['coderabbitai', 'renovate']);
    expect([...trust.policy.acceptStates].sort()).toEqual(['APPROVED', 'COMMENTED']);
    expect([...trust.policy.trustedAssociations]).toEqual(['OWNER']);
    expect(trust.layers).toEqual({
      trustedBots: 'env',
      acceptReviewStates: 'env',
      trustedAssociations: 'env',
    });
    expect(trust.report).toEqual([
      'CQ_MERGE_TRUSTED_BOTS=coderabbitai,renovate (env)',
      'CQ_MERGE_ACCEPT_REVIEW_STATES=APPROVED,COMMENTED (env)',
      'CQ_MERGE_TRUSTED_ASSOCIATIONS=OWNER (env)',
    ]);
  });

  test.each<[string, string]>([
    [ACCEPT_REVIEW_STATES_ENV, 'APPROVED,CHANGES_REQUESTED'],
    [ACCEPT_REVIEW_STATES_ENV, 'LGTM'],
    [TRUSTED_ASSOCIATIONS_ENV, 'OWNER,CONTRIBUTOR'],
    [TRUSTED_ASSOCIATIONS_ENV, 'NONE'],
    [TRUSTED_BOTS_ENV, 'coderabbitai[bot'],
    [TRUSTED_BOTS_ENV, '-leading-dash'],
    [TRUSTED_BOTS_ENV, 'two words'],
  ])('%s=%s throws naming the key', (key, value) => {
    expect(() => resolveAcceptanceTrust({ [key]: value })).toThrow(new RegExp(`^${key}: `));
  });
});

// ---------------------------------------------------------------------------
// parseAcceptanceArgs
// ---------------------------------------------------------------------------

describe('parseAcceptanceArgs', () => {
  const required = ['--repository=octo/widget', '--pr=7', `--subject=${SHA_B.toUpperCase()}`];

  test('required flags, with base and state defaults', () => {
    expect(parseAcceptanceArgs(required)).toEqual({
      owner: 'octo',
      repo: 'widget',
      input: { pr: 7, subject: SHA_B, base: 'merge-queue', state: 'open' },
    });
  });

  test('explicit base and state', () => {
    expect(parseAcceptanceArgs([...required, '--base=main', '--state=merged']).input).toEqual({
      pr: 7,
      subject: SHA_B,
      base: 'main',
      state: 'merged',
    });
  });

  test.each<[string, string[]]>([
    ['unknown flag', [...required, '--dry-run=1']],
    ['bare flag', [...required, '--state']],
    ['space-separated value', ['--repository', 'octo/widget', '--pr=7', `--subject=${SHA_B}`]],
    ['positional', [...required, 'extra']],
    ['repeated flag', [...required, '--pr=8']],
    ['empty value', [...required, '--base=']],
    ['missing repository', ['--pr=7', `--subject=${SHA_B}`]],
    ['bad repository', ['--repository=octo/widget/x', '--pr=7', `--subject=${SHA_B}`]],
    ['dot repository', ['--repository=octo/..', '--pr=7', `--subject=${SHA_B}`]],
    ['missing pr', ['--repository=octo/widget', `--subject=${SHA_B}`]],
    ['zero pr', ['--repository=octo/widget', '--pr=0', `--subject=${SHA_B}`]],
    ['non-numeric pr', ['--repository=octo/widget', '--pr=7a', `--subject=${SHA_B}`]],
    ['short subject', ['--repository=octo/widget', '--pr=7', '--subject=abc']],
    ['bad state', [...required, '--state=closed']],
  ])('throws on %s', (_name, argv) => {
    expect(() => parseAcceptanceArgs(argv)).toThrow();
  });
});
