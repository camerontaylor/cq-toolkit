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
// And the I11 REST lag cross-check: the fake serves REST reviews/comments
// consistent with the snapshot (plus per-spec extras), so reviews lag,
// reviewThreads lag, PENDING exclusion, read failure and the page cap are
// all probed through recheckBeforeMerge.
import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { GhFn, GhResult } from '../../src/adapters/forge-github/gh.js';
import type { MergeEffects } from '../../src/adapters/forge-github/mergeEffects.js';
import {
  CONSERVATIVE_TRUST_POLICY,
  fetchPrSnapshot,
  gateMergeEffects,
  observeOpenPrs,
  recheckBeforeMerge,
} from '../../src/selfhost/merge-recheck.js';
import type { TrustPolicy } from '../../src/selfhost/merge-recheck.js';

export const OWNER = 'octo';
export const REPO = 'widget';
export const PREFIX = `repos/${OWNER}/${REPO}/`;
export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);
export const BASE = 'c'.repeat(40);
export const BASE_NAME = 'merge-queue';
export const T0 = Date.parse('2026-09-25T00:00:00.000Z');
export const SETTLE_MS = 30 * 60_000;
export const LATER = T0 + SETTLE_MS + 60_000;

// ---------------------------------------------------------------------------
// Synthetic PR payloads
// ---------------------------------------------------------------------------

export interface ReviewSpec {
  /** The review node id (GraphQL `id` = REST `node_id`); default `R_<index>`. */
  id?: string;
  login: string | null;
  typename?: string | undefined;
  association?: string;
  state: string;
  submittedAt: string | null;
  oid: string | null;
  body?: string;
}

export interface ThreadSpec {
  isResolved: unknown;
  /** The root comment's author login; null → a null author; undefined → no comments. */
  root: string | null | undefined;
}

export interface PrSpec {
  committedDate: string | null;
  issueComments: Array<{
    author: { login: string; __typename: string } | null;
    authorAssociation: string;
    body: string;
    createdAt: string | null;
  }>;
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
  /** Extra REST review entries (beyond the snapshot's) — reviews-lag probes. */
  restExtraReviews: unknown[];
  /** When set, REST reports this state for every snapshot review (a dismissal GraphQL lags). */
  restStateOverride: string | null;
  /** Extra REST review-comment entries (beyond the snapshot's) — thread-lag probes. */
  restExtraComments: unknown[];
}

export const prSpec = (over: Partial<PrSpec> = {}): PrSpec => ({
  committedDate: new Date(T0).toISOString(),
  issueComments: [],
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
  restExtraReviews: [],
  restStateOverride: null,
  restExtraComments: [],
  ...over,
});

export const review = (over: Partial<ReviewSpec> = {}): ReviewSpec => ({
  login: 'carol',
  typename: 'User',
  association: 'COLLABORATOR',
  state: 'APPROVED',
  submittedAt: '2026-09-24T10:00:00Z',
  oid: SHA_B,
  body: '',
  ...over,
});

export const agentMarker = (verdict: 'PASS' | 'HOLD' | 'RETRACT', headSha = SHA_B): string =>
  `<!-- cq-agent-review: ${JSON.stringify({
    version: 1,
    reviewerAgentId: 'reviewer-agent',
    authorAgentId: 'author-agent',
    headSha,
    verdict,
    independent: true,
  })} -->`;

/** A review's node id: its explicit `id`, else `R_<index>`. */
const reviewNodeId = (r: ReviewSpec, index: number): string => r.id ?? `R_${String(index)}`;

/** A thread root's REST id (GraphQL `databaseId`). */
const rootDatabaseId = (index: number): number => 1000 + index;

/**
 * The REST collections CONSISTENT with the snapshot (plus the spec's
 * extras): every review by node_id, and every thread's root comment plus
 * one reply chained to it.
 */
const restReviewsFor = (spec: PrSpec): unknown[] => [
  ...spec.reviews.map((r, i) => ({
    node_id: reviewNodeId(r, i),
    state: spec.restStateOverride ?? r.state,
  })),
  ...spec.restExtraReviews,
];
const restCommentsFor = (spec: PrSpec): unknown[] => [
  ...spec.threads.flatMap((t, i) =>
    t.root === undefined
      ? []
      : [
          { id: rootDatabaseId(i), in_reply_to_id: null },
          { id: 5000 + i, in_reply_to_id: rootDatabaseId(i) },
        ],
  ),
  ...spec.restExtraComments,
];

export const flagValue = (args: string[], name: string): string => {
  const entry = args.find((a) => a.startsWith(`${name}=`));
  return entry === undefined ? '' : entry.slice(name.length + 1);
};

/** The fake's page size (the query's `first: 100`). */
export const PAGE = 100;

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
  const commentsFrom = Number(flagValue(args, 'commentsAfter') || '0');
  const laterPage = reviewsFrom > 0 || timelineFrom > 0 || threadsFrom > 0 || commentsFrom > 0;
  const reviewsMore = reviewsFrom + PAGE < spec.reviews.length;
  const threadsMore = threadsFrom + PAGE < spec.threads.length;
  const timelineMore = timelineFrom + PAGE < spec.forcePushes;
  return {
    data: {
      repository: {
        pullRequest: {
          commits: { nodes: [{ commit: { oid: spec.head, committedDate: spec.committedDate } }] },
          comments: {
            nodes: spec.issueComments.slice(commentsFrom, commentsFrom + PAGE),
            pageInfo: {
              hasNextPage: commentsFrom + PAGE < spec.issueComments.length,
              endCursor:
                commentsFrom + PAGE < spec.issueComments.length
                  ? String(commentsFrom + PAGE)
                  : null,
            },
          },
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
                  nodes: spec.threads.slice(threadsFrom, threadsFrom + PAGE).map((t, i) => ({
                    isResolved: t.isResolved,
                    comments: {
                      nodes:
                        t.root === undefined
                          ? []
                          : [
                              {
                                databaseId: rootDatabaseId(threadsFrom + i),
                                author: t.root === null ? null : { login: t.root },
                              },
                            ],
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
                  nodes: spec.reviews.slice(reviewsFrom, reviewsFrom + PAGE).map((r, i) => ({
                    id: reviewNodeId(r, reviewsFrom + i),
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
                    body: r.body ?? '',
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

export const okRes = (body: unknown): GhResult => ({
  code: 0,
  stdout: JSON.stringify(body),
  stderr: '',
});
const notFound = (): GhResult => ({ code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' });
export const unprocessable = (msg: string): GhResult => ({
  code: 1,
  stdout: '',
  stderr: `gh: ${msg} (HTTP 422)`,
});
const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

export interface Forge {
  gh: GhFn;
  /** Every event in order: 'graphql:<pr>', 'state:<METHOD> <path>', 'inner-merge:<pr>'. */
  log: string[];
  prs: Map<number, PrSpec>;
  refs: Map<string, string>;
  /** Fault injection: return a result to answer instead of routing. */
  hook: ((args: string[]) => GhResult | undefined) | undefined;
}

export const makeForge = (prs: Record<number, PrSpec>): Forge => {
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
    // The I11 REST cross-check reads (`--paginate --slurp`: one outer array of pages).
    const restRead = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/(reviews|comments)\?per_page=100$/.exec(
      args[1] ?? '',
    );
    if (restRead !== null && args.includes('--paginate') && args.includes('--slurp')) {
      forge.log.push(`rest:${restRead[2] ?? ''}:${restRead[1] ?? ''}`);
      const spec = forge.prs.get(Number(restRead[1]));
      if (spec === undefined) return notFound();
      return okRes([restRead[2] === 'reviews' ? restReviewsFor(spec) : restCommentsFor(spec)]);
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

export const forgeDeps = (forge: Forge) => ({ gh: forge.gh, owner: OWNER, repo: REPO });

export const recheckDeps = (
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
export const seedObservation = async (forge: Forge, prs: number[]): Promise<void> => {
  const result = await observeOpenPrs({ ...forgeDeps(forge), nowMs: () => T0 }, prs);
  expect(result.write?.ok).toBe(true);
};

/** A MergeEffects fake whose mergePr logs into the forge's shared timeline. */
export const innerEffects = (forge: Forge) => {
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
    diffPatch: () => Promise.resolve(ok),
    commitParents: () => Promise.resolve({ ok: true, parents: [] }),
    isAncestor: () => Promise.resolve(ok),
    readCommitMessage: () => Promise.resolve(ok),
    readCommitEncoding: () => Promise.resolve(ok),
    objectExists: () => Promise.resolve(ok),
    fetchBaseBranch: () => Promise.resolve(ok),
  };
  return { effects, mergeCalls };
};

export const gated = (
  forge: Forge,
  nowMs: number,
  policy: TrustPolicy = CONSERVATIVE_TRUST_POLICY,
) => {
  const inner = innerEffects(forge);
  const effects = gateMergeEffects(inner.effects, (pr, head, base) =>
    recheckBeforeMerge(recheckDeps(forge, nowMs, policy), pr, head, base),
  );
  return { effects, mergeCalls: inner.mergeCalls };
};

/** executeMerges' order: readBaseRef right before every mergePr call. */
export const readAndMerge = async (
  effects: MergeEffects,
  pr: number,
  opts: { method: 'merge'; matchHeadCommit?: string },
): Promise<GhResult> => {
  await effects.readBaseRef(pr);
  return effects.mergePr(pr, opts);
};

export const snapshotOf = async (spec: PrSpec) =>
  fetchPrSnapshot(forgeDeps(makeForge({ 7: spec })), 7);

// ---------------------------------------------------------------------------
