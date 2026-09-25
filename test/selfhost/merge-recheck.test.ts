// W1.2 slice B — tests for the merge-time recheck
// (src/selfhost/merge-recheck.ts, the RS-3 decision).
//
// The forge is a fake GhFn: `api graphql` answers with a synthetic PR
// payload built per test (mutable between calls, so a test can move the
// head, add a review, or force-push mid-timeline), and the state-branch
// git-data calls hit a tiny in-memory store (refs/commits/trees; 404 as
// code 1 + 'gh: Not Found (HTTP 404)'; PATCH fast-forward only). Every argv
// is recorded in order, interleaved with the inner mergePr's own entry, so
// call ORDER is assertable.
//
// Pinned here: SHA-bound acceptance (an approval of an older commit never
// counts — end-to-end the inner mergePr is never called), the immediate
// re-fetch ordering, objection folding (old-sha CHANGES_REQUESTED blocks;
// same-actor later APPROVED supersedes; COMMENTED does not), bot identity
// folding and allowlisting, author/excluded exclusion, the client-side
// force-push epoch, cursor pagination (page cap and mid-read head moves
// fail closed), trustPolicyFromConfig's narrowing, every structural
// refusal, CAS-failure refusal, never throwing, write minimization
// (observeOpenPrs and the recheck write only on material change; an ok
// recheck writes BEFORE the inner merge), observeOpenPrs
// isolation/pruning/single write, and the non-retryable refusal stderr.
// Also: acceptance from each actor's CURRENT opinion (DISMISSED — in place
// or as a later review — revokes it), base oid/name consistency across
// pages, the per-PR base pin (unverified / changed / protected), unresolved
// external threads, and the state read's discarded reasons on the answer.
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { GhFn, GhResult } from '../../src/ops/review/gh.js';
import type { MergeEffects } from '../../src/ops/merge/effects.js';
import {
  CONSERVATIVE_TRUST_POLICY,
  PR_SNAPSHOT_QUERY,
  SNAPSHOT_PAGE_CAP,
  STRUCTURAL_EXCLUDED_LOGINS,
  actorKey,
  fetchPrSnapshot,
  foldLatestOpinionated,
  gateMergeEffects,
  judgeAtHead,
  observeOpenPrs,
  recheckBeforeMerge,
  trustPolicyFromConfig,
} from '../../src/selfhost/merge-recheck.js';
import type { RecheckResult, TrustPolicy } from '../../src/selfhost/merge-recheck.js';
import { readSettleState } from '../../src/selfhost/state-branch.js';

const OWNER = 'octo';
const REPO = 'widget';
const PREFIX = `repos/${OWNER}/${REPO}/`;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const BASE_NAME = 'merge-queue';
const T0 = Date.parse('2026-09-25T00:00:00.000Z');
const SETTLE_MS = 30 * 60_000;
const LATER = T0 + SETTLE_MS + 60_000;

// ---------------------------------------------------------------------------
// Synthetic PR payloads
// ---------------------------------------------------------------------------

interface ReviewSpec {
  login: string | null;
  typename?: string | undefined;
  association?: string;
  state: string;
  submittedAt: string | null;
  oid: string | null;
}

interface ThreadSpec {
  isResolved: unknown;
  /** The root comment's author login; null → a null author; undefined → no comments. */
  root: string | null | undefined;
}

interface PrSpec {
  state: string;
  isDraft: boolean;
  /** The PR author's login; null → a null author (deleted account / partial payload). */
  author: string | null;
  /** Extra timeline nodes appended to the first page (malformed-payload probes). */
  extraTimelineNodes: unknown[];
  head: string;
  base: string;
  baseName: string;
  reviews: ReviewSpec[];
  threads: ThreadSpec[];
  omitThreads: boolean;
  forcePushes: number;
  reviewsHasNext: boolean;
  timelineTotalCount: number;
  omitReviews: boolean;
  errors: string[] | null;
  missing: boolean;
  /** When set, pages after the first report this headRefOid (a mid-read push). */
  headOnLaterPages: string | null;
  /** When set, pages after the first report this baseRefOid (a mid-read base move). */
  baseOnLaterPages: string | null;
  /** When set, pages after the first report this baseRefName (a mid-read retarget). */
  baseNameOnLaterPages: string | null;
}

const prSpec = (over: Partial<PrSpec> = {}): PrSpec => ({
  state: 'OPEN',
  isDraft: false,
  author: 'alice',
  extraTimelineNodes: [],
  head: SHA_B,
  base: BASE,
  baseName: BASE_NAME,
  reviews: [],
  threads: [],
  omitThreads: false,
  forcePushes: 0,
  reviewsHasNext: false,
  timelineTotalCount: 0,
  omitReviews: false,
  errors: null,
  missing: false,
  headOnLaterPages: null,
  baseOnLaterPages: null,
  baseNameOnLaterPages: null,
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

const flagValue = (args: string[], name: string): string => {
  const entry = args.find((a) => a.startsWith(`${name}=`));
  return entry === undefined ? '' : entry.slice(name.length + 1);
};

/** The fake's page size (the query's `first: 100`). */
const PAGE = 100;

/**
 * One page of the snapshot payload. Cursors are decimal offsets; each
 * connection pages independently off its own `-f <name>After=` flag.
 * `reviewsHasNext` forces a hasNextPage with NO cursor (unreachable → truncated).
 */
const payloadFor = (spec: PrSpec, args: string[]): unknown => {
  if (spec.errors !== null) return { errors: spec.errors.map((message) => ({ message })) };
  if (spec.missing) return { data: { repository: { pullRequest: null } } };
  const reviewsFrom = Number(flagValue(args, 'reviewsAfter') || '0');
  const timelineFrom = Number(flagValue(args, 'timelineAfter') || '0');
  const threadsFrom = Number(flagValue(args, 'threadsAfter') || '0');
  const laterPage = reviewsFrom > 0 || timelineFrom > 0 || threadsFrom > 0;
  const reviewsMore = reviewsFrom + PAGE < spec.reviews.length;
  const threadsMore = threadsFrom + PAGE < spec.threads.length;
  const timelineMore = timelineFrom + PAGE < spec.forcePushes;
  return {
    data: {
      repository: {
        pullRequest: {
          state: spec.state,
          isDraft: spec.isDraft,
          author: spec.author === null ? null : { login: spec.author, __typename: 'User' },
          headRefOid:
            laterPage && spec.headOnLaterPages !== null ? spec.headOnLaterPages : spec.head,
          baseRefOid:
            laterPage && spec.baseOnLaterPages !== null ? spec.baseOnLaterPages : spec.base,
          baseRefName:
            laterPage && spec.baseNameOnLaterPages !== null
              ? spec.baseNameOnLaterPages
              : spec.baseName,
          ...(spec.omitThreads
            ? {}
            : {
                reviewThreads: {
                  pageInfo: {
                    hasNextPage: threadsMore,
                    endCursor: threadsMore ? String(threadsFrom + PAGE) : null,
                  },
                  nodes: spec.threads.slice(threadsFrom, threadsFrom + PAGE).map((t) => ({
                    isResolved: t.isResolved,
                    comments: {
                      nodes:
                        t.root === undefined
                          ? []
                          : [{ author: t.root === null ? null : { login: t.root } }],
                    },
                  })),
                },
              }),
          ...(spec.omitReviews
            ? {}
            : {
                reviews: {
                  pageInfo: spec.reviewsHasNext
                    ? { hasNextPage: true, endCursor: null }
                    : {
                        hasNextPage: reviewsMore,
                        endCursor: reviewsMore ? String(reviewsFrom + PAGE) : null,
                      },
                  nodes: spec.reviews.slice(reviewsFrom, reviewsFrom + PAGE).map((r) => ({
                    author:
                      r.login === null
                        ? null
                        : {
                            login: r.login,
                            ...(r.typename === undefined ? {} : { __typename: r.typename }),
                          },
                    authorAssociation: r.association,
                    state: r.state,
                    submittedAt: r.submittedAt,
                    commit: r.oid === null ? null : { oid: r.oid },
                  })),
                },
              }),
          timelineItems: {
            // The UNFILTERED count GitHub reports — never read.
            totalCount: spec.timelineTotalCount,
            pageInfo: {
              hasNextPage: timelineMore,
              endCursor: timelineMore ? String(timelineFrom + PAGE) : null,
            },
            nodes: [
              ...Array.from(
                { length: Math.max(0, Math.min(PAGE, spec.forcePushes - timelineFrom)) },
                () => ({ __typename: 'HeadRefForcePushedEvent' }),
              ),
              ...(timelineFrom === 0 ? spec.extraTimelineNodes : []),
            ],
          },
        },
      },
    },
  };
};

// ---------------------------------------------------------------------------
// The fake forge (graphql + in-memory state branch)
// ---------------------------------------------------------------------------

const okRes = (body: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });
const notFound = (): GhResult => ({ code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' });
const unprocessable = (msg: string): GhResult => ({
  code: 1,
  stdout: '',
  stderr: `gh: ${msg} (HTTP 422)`,
});
const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

interface Forge {
  gh: GhFn;
  /** Every event in order: 'graphql:<pr>', 'state:<METHOD> <path>', 'inner-merge:<pr>'. */
  log: string[];
  prs: Map<number, PrSpec>;
  refs: Map<string, string>;
  /** Fault injection: return a result to answer instead of routing. */
  hook: ((args: string[]) => GhResult | undefined) | undefined;
}

const makeForge = (prs: Record<number, PrSpec>): Forge => {
  const refs = new Map<string, string>();
  const commits = new Map<string, { tree: string; parents: string[] }>();
  const trees = new Map<string, Map<string, string>>();
  let counter = 0;
  const forge: Forge = {
    log: [],
    prs: new Map(Object.entries(prs).map(([k, v]) => [Number(k), v])),
    refs,
    hook: undefined,
    gh: (args) => {
      const hooked = forge.hook?.(args);
      if (hooked !== undefined) return Promise.resolve(hooked);
      return Promise.resolve(route(args));
    },
  };
  const reaches = (commit: string, ancestor: string): boolean => {
    const queue = [commit];
    while (queue.length > 0) {
      const c = queue.shift() ?? '';
      if (c === ancestor) return true;
      queue.push(...(commits.get(c)?.parents ?? []));
    }
    return false;
  };
  const route = (args: string[]): GhResult => {
    if (args[0] !== 'api') return notFound();
    if (args[1] === 'graphql') {
      const pr = Number(flagValue(args, 'pr'));
      forge.log.push(`graphql:${String(pr)}`);
      const spec = forge.prs.get(pr);
      return spec === undefined
        ? okRes({ data: { repository: { pullRequest: null } } })
        : okRes(payloadFor(spec, args));
    }
    let method = 'GET';
    let path = '';
    const fields: Array<[string, string]> = [];
    for (let i = 1; i < args.length; i += 1) {
      const arg = args[i] ?? '';
      if (arg === '-X') method = args[(i += 1)] ?? '';
      else if (arg === '-f' || arg === '-F') {
        const kv = args[(i += 1)] ?? '';
        const eq = kv.indexOf('=');
        fields.push([kv.slice(0, eq), kv.slice(eq + 1)]);
      } else path = arg;
    }
    const field = (name: string) => fields.find(([k]) => k === name)?.[1];
    forge.log.push(`state:${method} ${path.split('?')[0] ?? ''}`);
    if (!path.startsWith(PREFIX)) return notFound();
    const rest = path.slice(PREFIX.length);
    if (method === 'GET' && rest.startsWith('git/ref/heads/')) {
      const sha = refs.get(`refs/heads/${rest.slice('git/ref/heads/'.length)}`);
      return sha === undefined ? notFound() : okRes({ object: { sha, type: 'commit' } });
    }
    if (method === 'GET' && rest.startsWith('contents/')) {
      const [filePath = '', query = ''] = rest.slice('contents/'.length).split('?');
      const commit = commits.get(new URLSearchParams(query).get('ref') ?? '');
      const content = commit === undefined ? undefined : trees.get(commit.tree)?.get(filePath);
      if (content === undefined) return notFound();
      return okRes({
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(content).toString('base64'),
      });
    }
    if (method === 'POST' && rest === 'git/trees') {
      const p = field('tree[][path]') ?? '';
      const content = field('tree[][content]') ?? '';
      const sha = sha1(`tree\0${p}\0${content}`);
      trees.set(sha, new Map([[p, content]]));
      return okRes({ sha });
    }
    if (method === 'POST' && rest === 'git/commits') {
      const tree = field('tree') ?? '';
      const parents = fields.filter(([k]) => k === 'parents[]').map(([, v]) => v);
      counter += 1;
      const sha = sha1(`commit\0${tree}\0${parents.join(',')}\0${String(counter)}`);
      commits.set(sha, { tree, parents });
      return okRes({ sha });
    }
    if (method === 'POST' && rest === 'git/refs') {
      const ref = field('ref') ?? '';
      if (refs.has(ref)) return unprocessable('Reference already exists');
      refs.set(ref, field('sha') ?? '');
      return okRes({});
    }
    if (method === 'PATCH' && rest.startsWith('git/refs/heads/')) {
      const ref = `refs/heads/${rest.slice('git/refs/heads/'.length)}`;
      const current = refs.get(ref);
      const sha = field('sha') ?? '';
      if (current === undefined) return unprocessable('Reference does not exist');
      if (field('force') !== 'true' && !reaches(sha, current)) {
        return unprocessable('Update is not a fast forward');
      }
      refs.set(ref, sha);
      return okRes({});
    }
    return notFound();
  };
  return forge;
};

const forgeDeps = (forge: Forge) => ({ gh: forge.gh, owner: OWNER, repo: REPO });

const recheckDeps = (
  forge: Forge,
  nowMs: number,
  policy: TrustPolicy = CONSERVATIVE_TRUST_POLICY,
) => ({
  ...forgeDeps(forge),
  nowMs: () => nowMs,
  settleMs: SETTLE_MS,
  policy,
});

/** Seed the durable first observation of every listed PR at T0. */
const seedObservation = async (forge: Forge, prs: number[]): Promise<void> => {
  const result = await observeOpenPrs({ ...forgeDeps(forge), nowMs: () => T0 }, prs);
  expect(result.write?.ok).toBe(true);
};

/** A MergeEffects fake whose mergePr logs into the forge's shared timeline. */
const innerEffects = (forge: Forge) => {
  const mergeCalls: Array<{ pr: number; opts: { method: 'merge'; matchHeadCommit?: string } }> = [];
  const ok: GhResult = { code: 0, stdout: '', stderr: '' };
  const effects: MergeEffects = {
    validateRef: () => Promise.resolve({ ok: true, sha: SHA_B }),
    fetchRef: () => Promise.resolve(ok),
    readBaseRef: () => Promise.resolve({ ok: true, baseRefName: BASE_NAME }),
    worktreePrepare: (pr) => Promise.resolve({ path: `/tmp/pr-${String(pr)}` }),
    worktreeRemove: () => Promise.resolve(),
    mergePr: (pr, opts) => {
      forge.log.push(`inner-merge:${String(pr)}`);
      mergeCalls.push({ pr, opts });
      return Promise.resolve(ok);
    },
    retargetBase: () => Promise.resolve(ok),
    pushRef: () => Promise.resolve(ok),
  };
  return { effects, mergeCalls };
};

const gated = (forge: Forge, nowMs: number, policy: TrustPolicy = CONSERVATIVE_TRUST_POLICY) => {
  const inner = innerEffects(forge);
  const effects = gateMergeEffects(inner.effects, (pr, head, base) =>
    recheckBeforeMerge(recheckDeps(forge, nowMs, policy), pr, head, base),
  );
  return { effects, mergeCalls: inner.mergeCalls };
};

/** executeMerges' order: readBaseRef right before every mergePr call. */
const readAndMerge = async (
  effects: MergeEffects,
  pr: number,
  opts: { method: 'merge'; matchHeadCommit?: string },
): Promise<GhResult> => {
  await effects.readBaseRef(pr);
  return effects.mergePr(pr, opts);
};

const snapshotOf = async (spec: PrSpec) => fetchPrSnapshot(forgeDeps(makeForge({ 7: spec })), 7);

// ---------------------------------------------------------------------------

describe('fetchPrSnapshot', () => {
  test('mirrors fetchReviewState argv; no GraphQL variable is named query', async () => {
    const forge = makeForge({ 7: prSpec() });
    const calls: string[][] = [];
    await fetchPrSnapshot(
      {
        ...forgeDeps(forge),
        gh: (args) => {
          calls.push(args);
          return forge.gh(args);
        },
      },
      7,
    );
    expect(calls[0]).toEqual([
      'api',
      'graphql',
      '-f',
      `query=${PR_SNAPSHOT_QUERY}`,
      '-f',
      `owner=${OWNER}`,
      '-f',
      `name=${REPO}`,
      '-F',
      'pr=7',
    ]);
    expect(PR_SNAPSHOT_QUERY).not.toMatch(/\$query\b/);
    expect(PR_SNAPSHOT_QUERY).toMatch(
      /\$reviewsAfter: String, \$threadsAfter: String, \$timelineAfter: String/,
    );
    expect(PR_SNAPSHOT_QUERY).toMatch(/baseRefName/);
    expect(PR_SNAPSHOT_QUERY).not.toMatch(/totalCount/);
    expect(calls).toHaveLength(1); // one page: no cursor flag ever sent
  });

  test('>100 reviews page across 2 requests; a trusted approval on page 2 is accepted', async () => {
    const crowd = Array.from({ length: 140 }, (_, i) =>
      review({ login: `drive-by-${String(i)}`, association: 'NONE', state: 'COMMENTED' }),
    );
    const forge = makeForge({ 7: prSpec({ reviews: [...crowd, review({ login: 'carol' })] }) });
    const calls: string[][] = [];
    const snap = await fetchPrSnapshot(
      {
        ...forgeDeps(forge),
        gh: (args) => {
          calls.push(args);
          return forge.gh(args);
        },
      },
      7,
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.slice(-2)).toEqual(['-f', 'reviewsAfter=100']);
    expect(calls[1]?.some((arg) => arg.startsWith('timelineAfter='))).toBe(false);
    expect(snap.truncated).toBe(false);
    expect(snap.reviews).toHaveLength(141);
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toEqual({
      accepted: true,
      by: ['user:carol'],
    });
  });

  test('more pages than the cap → truncated, and the recheck refuses', async () => {
    const many = Array.from({ length: SNAPSHOT_PAGE_CAP * 100 + 1 }, () => review());
    const forge = makeForge({ 7: prSpec({ reviews: many }) });
    const snap = await fetchPrSnapshot(forgeDeps(forge), 7);
    expect(snap.truncated).toBe(true);
    expect(forge.log.filter((entry) => entry === 'graphql:7')).toHaveLength(SNAPSHOT_PAGE_CAP);
    const result = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME);
    expect(result).toEqual({
      ok: false,
      reason:
        'snapshot truncated: reviews, review threads or force-push timeline incomplete, or the pr moved mid-read',
    });
  });

  test('a base oid or base name that changes between pages → truncated (fail closed)', async () => {
    const crowd = Array.from({ length: 150 }, () => review());
    const movedOid = await snapshotOf(prSpec({ reviews: crowd, baseOnLaterPages: SHA_A }));
    expect(movedOid.truncated).toBe(true);
    const retargeted = await snapshotOf(
      prSpec({ reviews: crowd, baseNameOnLaterPages: 'release' }),
    );
    expect(retargeted.truncated).toBe(true);
    expect(retargeted.baseRefName).toBe(BASE_NAME); // PR-level fields: first page
    expect((await snapshotOf(prSpec({ reviews: crowd }))).truncated).toBe(false);
  });

  test('review threads page with their own cursor; resolution and root author fail closed', async () => {
    const threads: ThreadSpec[] = [
      ...Array.from({ length: 140 }, () => ({ isResolved: true, root: 'dave' })),
      { isResolved: 'yes', root: 'dave' },
      { isResolved: false, root: undefined },
      { isResolved: false, root: null },
    ];
    const forge = makeForge({ 7: prSpec({ threads }) });
    const calls: string[][] = [];
    const snap = await fetchPrSnapshot(
      {
        ...forgeDeps(forge),
        gh: (args) => {
          calls.push(args);
          return forge.gh(args);
        },
      },
      7,
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.slice(-2)).toEqual(['-f', 'threadsAfter=100']);
    expect(snap.truncated).toBe(false);
    expect(snap.threads).toHaveLength(143);
    expect(snap.threads.slice(-3)).toEqual([
      { isResolved: false, rootAuthorLogin: 'dave' },
      { isResolved: false, rootAuthorLogin: null },
      { isResolved: false, rootAuthorLogin: null },
    ]);
    // A missing reviewThreads connection is truncated.
    expect((await snapshotOf(prSpec({ omitThreads: true }))).truncated).toBe(true);
  });

  test('a head that moves between pages → truncated (the PR moved mid-read)', async () => {
    const crowd = Array.from({ length: 150 }, () => review());
    const snap = await snapshotOf(prSpec({ reviews: crowd, headOnLaterPages: SHA_A }));
    expect(snap.truncated).toBe(true);
    expect(snap.headRefOid).toBe(SHA_B); // head/base come from the first page
  });

  test('force-push epoch is counted from nodes, never the unfiltered totalCount', async () => {
    const snap = await snapshotOf(prSpec({ forcePushes: 1, timelineTotalCount: 987_654 }));
    expect(snap.forcePushEpoch).toBe(1);
    // Paged: 130 events over two timeline pages all count.
    expect((await snapshotOf(prSpec({ forcePushes: 130 }))).forcePushEpoch).toBe(130);
  });

  test('a malformed timeline node fails closed (an uncounted force-push must not reuse a settled tuple)', async () => {
    for (const junk of [{}, { __typename: 'IssueComment' }, null, 'x']) {
      const snap = await snapshotOf(prSpec({ forcePushes: 1, extraTimelineNodes: [junk] }));
      expect(snap.truncated).toBe(true);
    }
  });

  test('an unknown PR author trusts nobody: acceptance fails closed', async () => {
    const snap = await snapshotOf(prSpec({ author: null, reviews: [review()] }));
    expect(snap.authorLogin).toBeNull();
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
      accepted: false,
      reason: 'no_head_bound_acceptance',
    });
  });

  test('truncated on hasNextPage or a missing connection; malformed oids → null', async () => {
    expect((await snapshotOf(prSpec({ reviewsHasNext: true }))).truncated).toBe(true);
    expect((await snapshotOf(prSpec({ omitReviews: true }))).truncated).toBe(true);
    const bad = await snapshotOf(prSpec({ head: 'not-a-sha', base: SHA_A.slice(1) }));
    expect(bad.headRefOid).toBeNull();
    expect(bad.baseRefOid).toBeNull();
  });

  test('GraphQL errors, missing pullRequest, and a bad owner throw', async () => {
    await expect(snapshotOf(prSpec({ errors: ['boom'] }))).rejects.toThrow(/boom/);
    await expect(snapshotOf(prSpec({ missing: true }))).rejects.toThrow(/no pullRequest/);
    await expect(
      fetchPrSnapshot({ gh: makeForge({}).gh, owner: '..', repo: REPO }, 7),
    ).rejects.toThrow(/charset/);
  });
});

describe('actorKey + foldLatestOpinionated', () => {
  test('both CodeRabbit identity forms are one actor; a human coderabbitai is distinct', () => {
    expect(actorKey('coderabbitai', 'Bot')).toBe('bot:coderabbitai');
    expect(actorKey('coderabbitai[bot]', 'User')).toBe('bot:coderabbitai');
    expect(actorKey('CodeRabbitAI', 'User')).toBe('user:coderabbitai');
    expect(actorKey(null, 'User')).toBe('unknown:');
  });

  test('COMMENTED and PENDING never supersede an opinion', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-09-24T01:00:00Z' }),
          review({ state: 'COMMENTED', submittedAt: '2026-09-24T02:00:00Z' }),
          review({ state: 'PENDING', submittedAt: null }),
        ],
      }),
    );
    expect(foldLatestOpinionated(snap.reviews).get('user:carol')?.state).toBe('CHANGES_REQUESTED');
  });
});

describe('judgeAtHead', () => {
  test('an approval whose commit.oid ≠ headRefOid at merge time is not acceptance', async () => {
    // SYNTHETIC TIMELINE: COLLABORATOR approves sha A; the author pushes sha
    // B; the merge-time snapshot reports headRefOid B.
    const forge = makeForge({ 7: prSpec({ head: SHA_A, reviews: [review({ oid: SHA_A })] }) });
    const atA = await fetchPrSnapshot(forgeDeps(forge), 7);
    expect(judgeAtHead(atA, SHA_A, CONSERVATIVE_TRUST_POLICY)).toEqual({
      accepted: true,
      by: ['user:carol'],
    });
    forge.prs.set(7, prSpec({ head: SHA_B, reviews: [review({ oid: SHA_A })] })); // the push
    const atB = await fetchPrSnapshot(forgeDeps(forge), 7);
    const verdict = judgeAtHead(atB, SHA_B, CONSERVATIVE_TRUST_POLICY);
    expect(verdict).toMatchObject({ accepted: false, reason: 'no_head_bound_acceptance' });

    // End to end: settled tuple at B, yet the stale approval can never merge.
    await seedObservation(forge, [7]);
    const { effects, mergeCalls } = gated(forge, LATER);
    const result = await readAndMerge(effects, 7, { method: 'merge', matchHeadCommit: SHA_B });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/refused pr 7: no_head_bound_acceptance/);
    expect(mergeCalls).toEqual([]);
  });

  test('trusted CHANGES_REQUESTED on an OLD sha still blocks', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ login: 'dave', state: 'CHANGES_REQUESTED', oid: SHA_A }),
          review({ login: 'carol', oid: SHA_B, submittedAt: '2026-09-24T11:00:00Z' }),
        ],
      }),
    );
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
      accepted: false,
      reason: 'objection_outstanding',
      detail: expect.stringContaining('user:dave') as unknown,
    });
  });

  test("superseded by the same actor's later APPROVED at head → accepted", async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ state: 'CHANGES_REQUESTED', oid: SHA_A, submittedAt: '2026-09-24T09:00:00Z' }),
          review({ state: 'APPROVED', oid: SHA_B, submittedAt: '2026-09-24T10:00:00Z' }),
        ],
      }),
    );
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toEqual({
      accepted: true,
      by: ['user:carol'],
    });
  });

  test('a later COMMENTED does not supersede CHANGES_REQUESTED', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({
            login: 'dave',
            state: 'CHANGES_REQUESTED',
            oid: SHA_A,
            submittedAt: '2026-09-24T09:00:00Z',
          }),
          review({
            login: 'dave',
            state: 'COMMENTED',
            oid: SHA_B,
            submittedAt: '2026-09-24T12:00:00Z',
          }),
          review({ login: 'carol', oid: SHA_B }),
        ],
      }),
    );
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
      reason: 'objection_outstanding',
    });
  });

  test('CodeRabbit APPROVED at head: refused conservatively, accepted when allowlisted; one actor', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({
            login: 'coderabbitai',
            typename: 'Bot',
            association: 'NONE',
            submittedAt: '2026-09-24T09:00:00Z',
          }),
          review({ login: 'coderabbitai[bot]', typename: 'User', association: 'NONE' }),
        ],
      }),
    );
    expect(new Set(snap.reviews.map((r) => r.actorKey))).toEqual(new Set(['bot:coderabbitai']));
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
      accepted: false,
      reason: 'no_head_bound_acceptance',
    });
    const withBot: TrustPolicy = {
      ...CONSERVATIVE_TRUST_POLICY,
      trustedBots: new Set(['coderabbitai']),
    };
    expect(judgeAtHead(snap, SHA_B, withBot)).toEqual({ accepted: true, by: ['bot:coderabbitai'] });
  });

  test('PR author self-approval and excludedLogins actors never count', async () => {
    const snap = await snapshotOf(
      prSpec({
        author: 'alice',
        reviews: [
          review({ login: 'alice', association: 'OWNER' }),
          review({ login: 'cq-automation', association: 'MEMBER' }),
        ],
      }),
    );
    const policy: TrustPolicy = {
      ...CONSERVATIVE_TRUST_POLICY,
      excludedLogins: new Set(['cq-automation']),
    };
    expect(judgeAtHead(snap, SHA_B, policy)).toMatchObject({ reason: 'no_head_bound_acceptance' });
  });

  test('a null author or a non-User/Bot author type (Organization) is never trusted', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ login: null, association: 'OWNER' }),
          review({ login: 'acme', typename: 'Organization', association: 'OWNER' }),
          review({ login: 'coderabbitai', typename: 'Organization', association: 'NONE' }),
          review({ login: 'ghost', typename: undefined, association: 'MEMBER' }),
        ],
      }),
    );
    const withBot = trustPolicyFromConfig({ trustedBots: ['coderabbitai[bot]'] });
    for (const policy of [CONSERVATIVE_TRUST_POLICY, withBot]) {
      expect(judgeAtHead(snap, SHA_B, policy)).toMatchObject({
        accepted: false,
        reason: 'no_head_bound_acceptance',
        detail: expect.stringContaining('trusted=0') as unknown,
      });
    }
  });

  test('APPROVED at head then a later DISMISSED review by the same actor → not an acceptor', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ state: 'APPROVED', submittedAt: '2026-09-24T09:00:00Z' }),
          review({ state: 'DISMISSED', submittedAt: '2026-09-24T10:00:00Z' }),
        ],
      }),
    );
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
      accepted: false,
      reason: 'no_head_bound_acceptance',
    });
  });

  test('an approval node GitHub rewrote to DISMISSED (state mutated in place) never counts', async () => {
    const snap = await snapshotOf(prSpec({ reviews: [review({ state: 'DISMISSED' })] }));
    const both = trustPolicyFromConfig({ acceptReviewStates: ['APPROVED', 'COMMENTED'] });
    for (const policy of [CONSERVATIVE_TRUST_POLICY, both]) {
      expect(judgeAtHead(snap, SHA_B, policy)).toMatchObject({
        reason: 'no_head_bound_acceptance',
      });
    }
  });

  test('APPROVED at head then COMMENTED (not an accept state) → still an acceptor', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ state: 'APPROVED', submittedAt: '2026-09-24T09:00:00Z' }),
          review({ state: 'COMMENTED', oid: SHA_A, submittedAt: '2026-09-24T10:00:00Z' }),
        ],
      }),
    );
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toEqual({
      accepted: true,
      by: ['user:carol'],
    });
  });

  test('with COMMENTED accepted, the LATEST accept-state review decides (current opinion)', async () => {
    const policy = trustPolicyFromConfig({ acceptReviewStates: ['APPROVED', 'COMMENTED'] });
    // APPROVED of an old sha, then COMMENTED at head → the head comment counts.
    const current = await snapshotOf(
      prSpec({
        reviews: [
          review({ state: 'APPROVED', oid: SHA_A, submittedAt: '2026-09-24T09:00:00Z' }),
          review({ state: 'COMMENTED', oid: SHA_B, submittedAt: '2026-09-24T10:00:00Z' }),
        ],
      }),
    );
    expect(judgeAtHead(current, SHA_B, policy)).toEqual({ accepted: true, by: ['user:carol'] });
    // COMMENTED at head, then APPROVED of an old sha → the actor's current
    // opinion is bound to the old sha: no acceptance.
    const stale = await snapshotOf(
      prSpec({
        reviews: [
          review({ state: 'COMMENTED', oid: SHA_B, submittedAt: '2026-09-24T09:00:00Z' }),
          review({ state: 'APPROVED', oid: SHA_A, submittedAt: '2026-09-24T10:00:00Z' }),
        ],
      }),
    );
    expect(judgeAtHead(stale, SHA_B, policy)).toMatchObject({
      reason: 'no_head_bound_acceptance',
    });
  });

  test('an acceptance needs a PARSEABLE submittedAt', async () => {
    const snap = await snapshotOf(prSpec({ reviews: [review({ submittedAt: 'not-a-date' })] }));
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
      reason: 'no_head_bound_acceptance',
    });
  });

  test('an untrusted association never counts; a pending review never counts', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ login: 'eve', association: 'CONTRIBUTOR' }),
          review({ login: 'carol', state: 'PENDING', submittedAt: null }),
        ],
      }),
    );
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
      reason: 'no_head_bound_acceptance',
    });
  });
});

describe('trustPolicyFromConfig', () => {
  test('blank config = the conservative blanks plus the structural exclusions', () => {
    const blank = trustPolicyFromConfig({});
    expect([...blank.trustedAssociations]).toEqual(['OWNER', 'MEMBER', 'COLLABORATOR']);
    expect([...blank.trustedBots]).toEqual([]);
    expect([...blank.acceptStates]).toEqual(['APPROVED']);
    expect([...blank.excludedLogins].sort()).toEqual([...STRUCTURAL_EXCLUDED_LOGINS].sort());
    expect(CONSERVATIVE_TRUST_POLICY).toEqual(blank);
    expect(Object.isFrozen(CONSERVATIVE_TRUST_POLICY)).toBe(true);
  });

  test('bot logins normalize to the bare name; excluded identities are dropped', () => {
    const policy = trustPolicyFromConfig({
      trustedBots: [
        'coderabbitai[bot]',
        ' CodeRabbitAI ',
        'github-actions[bot]',
        'cq-verdict',
        'mybot[bot]',
        '',
      ],
      automationLogin: 'mybot[bot]',
    });
    expect([...policy.trustedBots]).toEqual(['coderabbitai']);
    expect(policy.excludedLogins.has('mybot[bot]')).toBe(true);
  });

  test('trustedAssociations may only narrow the blank set', () => {
    expect([
      ...trustPolicyFromConfig({ trustedAssociations: ['owner', 'CONTRIBUTOR', 'NONE'] })
        .trustedAssociations,
    ]).toEqual(['OWNER']);
    expect(
      trustPolicyFromConfig({ trustedAssociations: ['CONTRIBUTOR'] }).trustedAssociations.size,
    ).toBe(0);
    expect(trustPolicyFromConfig({ trustedAssociations: [] }).trustedAssociations.size).toBe(3);
  });

  test('acceptStates keeps only APPROVED/COMMENTED; blank → APPROVED', () => {
    expect([
      ...trustPolicyFromConfig({
        acceptReviewStates: ['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED', 'DISMISSED'],
      }).acceptStates,
    ]).toEqual(['APPROVED', 'COMMENTED']);
    expect(trustPolicyFromConfig({ acceptReviewStates: ['DISMISSED'] }).acceptStates.size).toBe(0);
    expect([...trustPolicyFromConfig({ acceptReviewStates: [] }).acceptStates]).toEqual([
      'APPROVED',
    ]);
  });

  test('configured and automation logins never count, in either identity form', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ login: 'robo', association: 'MEMBER' }),
          review({ login: 'ops-person', association: 'OWNER' }),
          review({ login: 'cq-automation', typename: 'Bot', association: 'NONE' }),
        ],
      }),
    );
    const policy = trustPolicyFromConfig({
      automationLogin: 'robo',
      excludedLogins: ['Ops-Person'],
      trustedBots: ['cq-automation[bot]'],
    });
    expect(judgeAtHead(snap, SHA_B, policy)).toMatchObject({ reason: 'no_head_bound_acceptance' });
  });
});

describe('recheckBeforeMerge + gateMergeEffects', () => {
  test('approval at head B with settled state → inner mergePr called with the same opts', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    await seedObservation(forge, [7]);
    const { effects, mergeCalls } = gated(forge, LATER);
    const opts = { method: 'merge' as const, matchHeadCommit: SHA_B };
    const result = await readAndMerge(effects, 7, opts);
    expect(result.code).toBe(0);
    expect(mergeCalls).toEqual([{ pr: 7, opts }]);
    const direct = await recheckBeforeMerge(recheckDeps(forge, LATER + 1), 7, SHA_B, BASE_NAME);
    expect(direct).toMatchObject({
      ok: true,
      acceptedBy: ['user:carol'],
      tuple: { head: SHA_B, base: BASE, forcePushEpoch: 0 },
      firstObservedAt: new Date(T0).toISOString(),
    });
  });

  test('reviews are re-fetched immediately before merge; a late CHANGES_REQUESTED blocks', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    await seedObservation(forge, [7]);
    // "Classify": an earlier read sees a clean approval.
    const early = await fetchPrSnapshot(forgeDeps(forge), 7);
    expect(judgeAtHead(early, SHA_B, CONSERVATIVE_TRUST_POLICY).accepted).toBe(true);
    // Between classify and merge a trusted reviewer objects.
    forge.prs.set(
      7,
      prSpec({
        reviews: [
          review(),
          review({
            login: 'dave',
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-09-24T12:00:00Z',
          }),
        ],
      }),
    );
    const { effects, mergeCalls } = gated(forge, LATER);
    forge.log.length = 0;
    forge.log.push('merge-requested');
    const blocked = await readAndMerge(effects, 7, { method: 'merge', matchHeadCommit: SHA_B });
    expect(blocked.stderr).toMatch(/objection_outstanding/);
    expect(mergeCalls).toEqual([]);
    expect(forge.log[1]).toBe('graphql:7');

    // Once dave approves at head, the fresh read lets the merge through —
    // and the snapshot read sits between the request and the inner merge.
    forge.prs.set(
      7,
      prSpec({
        reviews: [
          review(),
          review({ login: 'dave', state: 'APPROVED', submittedAt: '2026-09-24T13:00:00Z' }),
        ],
      }),
    );
    forge.log.length = 0;
    forge.log.push('merge-requested');
    expect((await readAndMerge(effects, 7, { method: 'merge', matchHeadCommit: SHA_B })).code).toBe(
      0,
    );
    const graphqlAt = forge.log.indexOf('graphql:7');
    expect(graphqlAt).toBeGreaterThan(forge.log.indexOf('merge-requested'));
    expect(graphqlAt).toBeLessThan(forge.log.indexOf('inner-merge:7'));
  });

  test('A → force-push → back to A: epoch bump invalidates the prior observation', async () => {
    const forge = makeForge({ 7: prSpec({ head: SHA_A, reviews: [review({ oid: SHA_A })] }) });
    await seedObservation(forge, [7]);
    // Force-pushed away and back to A: same head, epoch 1.
    forge.prs.set(7, prSpec({ head: SHA_A, forcePushes: 1, reviews: [review({ oid: SHA_A })] }));
    const result = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_A, BASE_NAME);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(
      /^settle: (tuple_changed|single_observation)$/,
    );
  });

  test('settle pending when the second observation is too soon', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    await seedObservation(forge, [7]);
    forge.log.length = 0;
    const result = await recheckBeforeMerge(recheckDeps(forge, T0 + 1000), 7, SHA_B, BASE_NAME);
    expect(result).toEqual({ ok: false, reason: 'settle: settle_pending' });
    // A refusal on an unchanged tuple writes nothing.
    expect(forge.log.filter((entry) => /^state:(POST|PATCH)/.test(entry))).toEqual([]);
  });

  test('a refusal that creates a new anchor writes it (best effort) so a later run can settle', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    const result = await recheckBeforeMerge(recheckDeps(forge, T0), 7, SHA_B, BASE_NAME);
    expect(result).toEqual({ ok: false, reason: 'settle: single_observation' });
    const { state } = await readSettleState(forgeDeps(forge));
    expect(state.prs['7']?.observations).toEqual([
      { observedAt: new Date(T0).toISOString(), by: 'self-merge-prs:recheck' },
    ]);
    // The anchor it wrote settles a recheck past the window.
    expect((await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME)).ok).toBe(
      true,
    );
  });

  test('an ok recheck writes its observation BEFORE the inner mergePr', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    await seedObservation(forge, [7]);
    forge.log.length = 0;
    const { effects } = gated(forge, LATER);
    expect((await readAndMerge(effects, 7, { method: 'merge', matchHeadCommit: SHA_B })).code).toBe(
      0,
    );
    const patchAt = forge.log.findIndex((entry) => entry.startsWith('state:PATCH'));
    expect(patchAt).toBeGreaterThan(forge.log.indexOf('graphql:7'));
    expect(patchAt).toBeLessThan(forge.log.indexOf('inner-merge:7'));
    const { state } = await readSettleState(forgeDeps(forge));
    expect(state.prs['7']?.observations.map((o) => o.observedAt)).toEqual([
      new Date(T0).toISOString(),
      new Date(LATER).toISOString(),
    ]);
  });

  test('the clock is read AFTER the snapshot fetch', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    const order: string[] = [];
    const gh: GhFn = (args) => {
      if (args[1] === 'graphql') order.push('fetch');
      return forge.gh(args);
    };
    await recheckBeforeMerge(
      {
        ...recheckDeps(forge, T0),
        gh,
        nowMs: () => {
          order.push('clock');
          return T0;
        },
      },
      7,
      SHA_B,
      BASE_NAME,
    );
    expect(order).toEqual(['fetch', 'clock']);
  });

  test('refusals: head moved, unpinned, closed, draft, truncated reviews', async () => {
    const cases: Array<[Partial<PrSpec>, string | undefined, RegExp]> = [
      [{ head: SHA_A }, SHA_B, /^head moved/],
      [{}, undefined, /^unpinned head/],
      [{}, 'deadbeef', /^unpinned head/],
      [{ state: 'CLOSED' }, SHA_B, /not open/],
      [{ isDraft: true }, SHA_B, /draft/],
      [{ reviewsHasNext: true }, SHA_B, /truncated/],
      [{ base: 'zz' }, SHA_B, /base oid unavailable/],
    ];
    for (const [over, head, pattern] of cases) {
      const forge = makeForge({ 7: prSpec({ reviews: [review()], ...over }) });
      const result = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, head, BASE_NAME);
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toMatch(pattern);
    }
  });

  test('state-branch write CAS failure → refuse; nothing merges', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    await seedObservation(forge, [7]);
    forge.hook = (args) =>
      args.includes('PATCH') ? unprocessable('Update is not a fast forward') : undefined;
    const { effects, mergeCalls } = gated(forge, LATER);
    const result = await readAndMerge(effects, 7, { method: 'merge', matchHeadCommit: SHA_B });
    expect(result.stderr).toMatch(/settle state not durable/);
    expect(mergeCalls).toEqual([]);
  });

  test('state-branch read failure (non-404) → refuse', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    forge.hook = (args) =>
      (args[1] ?? '').includes('git/ref/')
        ? { code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)' }
        : undefined;
    const result = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME);
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^settle state not durable: gh exit 1/) as unknown,
    });
  });

  test('gh throw → refuse, never throws', async () => {
    const throwing: GhFn = () => Promise.reject(new Error('spawn gh ENOENT\nstack…'));
    const result = await recheckBeforeMerge(
      {
        gh: throwing,
        owner: OWNER,
        repo: REPO,
        nowMs: () => LATER,
        settleMs: SETTLE_MS,
        policy: CONSERVATIVE_TRUST_POLICY,
      },
      7,
      SHA_B,
      BASE_NAME,
    );
    expect(result).toEqual({ ok: false, reason: 'recheck fetch failed: spawn gh ENOENT' });
    const badClock = await recheckBeforeMerge(
      {
        ...recheckDeps(makeForge({ 7: prSpec({ reviews: [review()] }) }), LATER),
        nowMs: () => Number.NaN,
      },
      7,
      SHA_B,
      BASE_NAME,
    );
    expect(badClock.ok).toBe(false);
  });

  test('base pin: no successful readBaseRef → base unverified; a failed read forgets the pin; the pin is single-use', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    await seedObservation(forge, [7]);
    const inner = innerEffects(forge);
    let readAnswer: { ok: boolean; baseRefName?: string } = { ok: true, baseRefName: BASE_NAME };
    const effects = gateMergeEffects(
      { ...inner.effects, readBaseRef: () => Promise.resolve(readAnswer) },
      (pr, head, base) => recheckBeforeMerge(recheckDeps(forge, LATER), pr, head, base),
    );
    const opts = { method: 'merge' as const, matchHeadCommit: SHA_B };
    // No read at all.
    expect((await effects.mergePr(7, opts)).stderr).toMatch(/refused pr 7: base unverified/);
    // A successful read, then a failed one: the older pin is forgotten.
    await effects.readBaseRef(7);
    readAnswer = { ok: false };
    await effects.readBaseRef(7);
    expect((await effects.mergePr(7, opts)).stderr).toMatch(/base unverified/);
    // An ok read with an empty name pins nothing.
    readAnswer = { ok: true, baseRefName: '' };
    await effects.readBaseRef(7);
    expect((await effects.mergePr(7, opts)).stderr).toMatch(/base unverified/);
    expect(inner.mergeCalls).toEqual([]);
    // A good read pins exactly one merge call.
    readAnswer = { ok: true, baseRefName: BASE_NAME };
    await effects.readBaseRef(7);
    expect((await effects.mergePr(7, opts)).code).toBe(0);
    expect((await effects.mergePr(7, opts)).stderr).toMatch(/base unverified/);
    expect(inner.mergeCalls).toHaveLength(1);
  });

  test('base pin: the recheck receives the base readBaseRef saw, per PR', async () => {
    const forge = makeForge({});
    const inner = innerEffects(forge);
    const seen: Array<[number, string | undefined]> = [];
    const effects = gateMergeEffects(
      {
        ...inner.effects,
        readBaseRef: (pr) => Promise.resolve({ ok: true, baseRefName: `base-${String(pr)}` }),
      },
      (pr, _head, base) => {
        seen.push([pr, base]);
        return Promise.resolve({ ok: false, reason: 'stub' });
      },
    );
    await effects.readBaseRef(1);
    await effects.readBaseRef(2);
    await effects.mergePr(2, { method: 'merge', matchHeadCommit: SHA_B });
    await effects.mergePr(1, { method: 'merge', matchHeadCommit: SHA_B });
    expect(seen).toEqual([
      [2, 'base-2'],
      [1, 'base-1'],
    ]);
  });

  test('a live base that differs from the pinned base → base changed; nothing merges', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()], baseName: 'release' }) });
    await seedObservation(forge, [7]);
    const { effects, mergeCalls } = gated(forge, LATER);
    const result = await readAndMerge(effects, 7, { method: 'merge', matchHeadCommit: SHA_B });
    expect(result.stderr).toMatch(
      /refused pr 7: base changed: readBaseRef pinned merge-queue but the forge now reports release/,
    );
    expect(mergeCalls).toEqual([]);
  });

  test('a live base of the protected branch is refused outright, even when pinned', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()], baseName: 'main' }) });
    await seedObservation(forge, [7]);
    const result = await recheckBeforeMerge(
      { ...recheckDeps(forge, LATER), protectedBranch: 'main' },
      7,
      SHA_B,
      'main',
    );
    expect(result).toEqual({
      ok: false,
      reason: 'base is the protected branch main: never merged into',
    });
    // Without a protected branch configured the same pin would pass the base gate.
    expect((await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, 'main')).ok).toBe(true);
  });

  test('unresolved external threads refuse before reviews are judged', async () => {
    const cases: Array<[ThreadSpec[], string | null]> = [
      [[{ isResolved: false, root: 'dave' }], 'unresolved external threads: 1'],
      [[{ isResolved: false, root: null }], 'unresolved external threads: 1'],
      [
        [
          { isResolved: false, root: 'dave' },
          { isResolved: 'maybe', root: 'erin' },
        ],
        'unresolved external threads: 2',
      ],
      // The PR author's own thread and resolved threads never block.
      [
        [
          { isResolved: false, root: 'alice' },
          { isResolved: true, root: 'dave' },
        ],
        null,
      ],
    ];
    for (const [threads, reason] of cases) {
      const forge = makeForge({ 7: prSpec({ reviews: [review()], threads }) });
      await seedObservation(forge, [7]);
      const result = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME);
      expect(result).toEqual(
        reason === null ? expect.objectContaining({ ok: true }) : { ok: false, reason },
      );
    }
    // With NO acceptance at all, the thread refusal still comes first.
    const bare = makeForge({ 7: prSpec({ threads: [{ isResolved: false, root: 'dave' }] }) });
    expect(await recheckBeforeMerge(recheckDeps(bare, LATER), 7, SHA_B, BASE_NAME)).toEqual({
      ok: false,
      reason: 'unresolved external threads: 1',
    });
  });

  test('discarded ledger records surface on a refusal reason and on an ok result', async () => {
    // Refusal: a foreign ledger is discarded wholesale → single observation.
    const foreign = makeForge({ 7: prSpec({ reviews: [review()] }) });
    foreign.hook = (args) =>
      (args[1] ?? '').includes('git/ref/')
        ? okRes({ object: { sha: 'e'.repeat(40) } })
        : (args[1] ?? '').includes('contents/')
          ? okRes({ encoding: 'base64', content: Buffer.from('{"version":9}').toString('base64') })
          : undefined;
    expect(await recheckBeforeMerge(recheckDeps(foreign, LATER), 7, SHA_B, BASE_NAME)).toEqual({
      ok: false,
      reason:
        'settle: single_observation (state discarded: 1 record(s); first: settle state version 9 is not 1)',
    });

    // Ok: a settled ledger that also carries one malformed record.
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    await seedObservation(forge, [7]);
    const tip = forge.refs.get('refs/heads/cq-state') ?? '';
    const res = await forge.gh(['api', `${PREFIX}contents/.cq/settle-state.json?ref=${tip}`]);
    const file = JSON.parse(res.stdout) as { content: string };
    const ledger = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) as {
      prs: Record<string, unknown>;
    };
    ledger.prs['x'] = {};
    const tampered = Buffer.from(JSON.stringify(ledger)).toString('base64');
    forge.hook = (args) =>
      (args[1] ?? '').includes('contents/')
        ? okRes({ encoding: 'base64', content: tampered })
        : undefined;
    const ok = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME);
    expect(ok).toMatchObject({ ok: true, discarded: ['pr key "x" is not a decimal PR number'] });
  });

  test('refusal stderr does not match /base branch was modified/i', async () => {
    const recheck = (): Promise<RecheckResult> =>
      Promise.resolve({ ok: false, reason: 'forge said: Base branch was modified' });
    const forge = makeForge({});
    const inner = innerEffects(forge);
    const result = await gateMergeEffects(inner.effects, recheck).mergePr(9, { method: 'merge' });
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toMatch(/^cq merge-time recheck refused pr 9: /);
    expect(result.stderr).not.toMatch(/base branch was modified/i);
    expect(inner.mergeCalls).toEqual([]);
  });

  test('every non-merge member delegates to the inner effects', async () => {
    const forge = makeForge({});
    const inner = innerEffects(forge);
    const effects = gateMergeEffects(inner.effects, () => Promise.reject(new Error('never')));
    expect(await effects.validateRef('x')).toEqual({ ok: true, sha: SHA_B });
    expect(await effects.readBaseRef(1)).toEqual({ ok: true, baseRefName: BASE_NAME });
    expect(await effects.worktreePrepare(3, 'r')).toEqual({ path: '/tmp/pr-3' });
    expect((await effects.fetchRef('r')).code).toBe(0);
    expect((await effects.retargetBase(1, 'main')).code).toBe(0);
    expect((await effects.pushRef('a:b', '/p')).code).toBe(0);
    await expect(effects.worktreeRemove('/p')).resolves.toBeUndefined();
  });
});

describe('observeOpenPrs', () => {
  test('isolates a failing PR, prunes closed PRs, and writes once', async () => {
    const forge = makeForge({ 1: prSpec(), 2: prSpec({ head: SHA_A }), 3: prSpec() });
    await seedObservation(forge, [1, 2, 3]);
    // PR 3 closed (dropped from the open list); PR 2's read now fails.
    forge.hook = (args) =>
      args[1] === 'graphql' && flagValue(args, 'pr') === '2'
        ? { code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)' }
        : undefined;
    forge.prs.set(4, prSpec({ state: 'CLOSED' }));
    forge.log.length = 0;
    const result = await observeOpenPrs({ ...forgeDeps(forge), nowMs: () => LATER }, [1, 2, 4]);
    expect(result.observed).toEqual([1]);
    expect(result.skipped).toEqual([
      { pr: 2, reason: 'fetch failed: gh exit 1: gh: Server Error (HTTP 502)' },
      { pr: 4, reason: 'not open' },
    ]);
    expect(result.write?.ok).toBe(true);
    expect(forge.log.filter((entry) => entry.startsWith('state:PATCH'))).toHaveLength(1);
    const { state } = await readSettleState(forgeDeps(forge));
    expect(Object.keys(state.prs).sort()).toEqual(['1', '2']);
    // PR 1's same-tuple observation is NOT appended (the prune alone made
    // the write material); the T0 anchor stands.
    expect(state.prs['1']?.observations).toEqual([
      { observedAt: new Date(T0).toISOString(), by: 'self-merge-prs:observe' },
    ]);
  });

  test('a pass with only same-tuple observations makes NO state-branch write', async () => {
    const forge = makeForge({ 1: prSpec(), 2: prSpec({ head: SHA_A }) });
    await seedObservation(forge, [1, 2]);
    forge.log.length = 0;
    const result = await observeOpenPrs({ ...forgeDeps(forge), nowMs: () => LATER }, [1, 2]);
    expect(result).toEqual({ observed: [1, 2], skipped: [], discarded: [], write: null });
    expect(forge.log.filter((entry) => /^state:(POST|PATCH)/.test(entry))).toEqual([]);
  });

  test('a moved head resets its record and is written; discarded reasons surface', async () => {
    const forge = makeForge({ 1: prSpec() });
    await seedObservation(forge, [1]);
    forge.prs.set(1, prSpec({ head: SHA_A }));
    const result = await observeOpenPrs({ ...forgeDeps(forge), nowMs: () => LATER }, [1]);
    expect(result.write?.ok).toBe(true);
    const { state } = await readSettleState(forgeDeps(forge));
    expect(state.prs['1']?.tuple.head).toBe(SHA_A);
    expect(state.prs['1']?.observations).toHaveLength(1);

    // A foreign ledger is discarded on read; the reason rides the result.
    const foreign = makeForge({ 1: prSpec() });
    foreign.hook = (args) =>
      (args[1] ?? '').includes('git/ref/')
        ? okRes({ object: { sha: 'e'.repeat(40) } })
        : (args[1] ?? '').includes('contents/')
          ? okRes({ encoding: 'base64', content: Buffer.from('{"version":9}').toString('base64') })
          : undefined;
    const discardedRun = await observeOpenPrs({ ...forgeDeps(foreign), nowMs: () => T0 }, [1]);
    expect(discardedRun.discarded).toEqual(['settle state version 9 is not 1']);
  });

  test('a state-branch read failure is reported, never thrown; empty input writes nothing', async () => {
    const forge = makeForge({ 1: prSpec() });
    forge.hook = (args) =>
      (args[1] ?? '').includes('git/ref/')
        ? { code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)' }
        : undefined;
    const result = await observeOpenPrs({ ...forgeDeps(forge), nowMs: () => T0 }, [1]);
    expect(result.observed).toEqual([]);
    expect(result.write).toMatchObject({ ok: false });
    expect(await observeOpenPrs({ ...forgeDeps(forge), nowMs: () => T0 }, [])).toEqual({
      observed: [],
      skipped: [],
      discarded: [],
      write: null,
    });
  });
});
