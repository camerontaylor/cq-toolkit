// selfhost/merge-recheck — the MERGE-TIME RECHECK (task W1.2 slice B, the
// RS-3 decision): the last gate between "the plan says merge" and the forge
// merge call. Composition glue over the settle ledger (settle-state.ts, pure
// rules) and its durable persistence (state-branch.ts); the only logic here
// is wire mapping, the head-bound acceptance judgment, and fail-closed
// bookkeeping.
//
// REVIEWS ARE BOUND TO A SHA. A review counts as acceptance only when its
// `commit.oid` equals the PR's `headRefOid` AT MERGE TIME — an approval of an
// older commit NEVER counts, however recent, because the code it approved is
// not the code that would merge. We fold the latest opinionated review per
// ACTOR over ALL reviews ourselves: GitHub's `latestOpinionatedReviews
// (writersOnly: true)` includes the coderabbitai App, and `reviewDecision`
// is both SHA-unbound and bot-sourced — neither is read here, ever.
//
// ACTOR IDENTITY. CodeRabbit surfaces as login `coderabbitai` with
// `__typename: Bot` AND as `coderabbitai[bot]` with `__typename: User`; both
// are ONE actor (`bot:coderabbitai`). A human account literally named
// `coderabbitai` stays the distinct actor `user:coderabbitai`.
//
// OBJECTIONS OUTLIVE PUSHES. A trusted actor's latest opinionated review
// (APPROVED | CHANGES_REQUESTED | DISMISSED, latest by submittedAt; PENDING
// ignored) of CHANGES_REQUESTED blocks whatever SHA it was left on, until it
// is dismissed or superseded by the same actor's later APPROVED. A later
// COMMENTED is not an opinion and supersedes nothing (GitHub semantics).
//
// TRUST (plan D3, conservative blanks per RS-15 Annex B): users count only
// with an association in {OWNER, MEMBER, COLLABORATOR}; bots never count
// unless allowlisted (`authorAssociation` is NONE for bots, so the allowlist
// is the ONLY bot trust path); the PR author and every excluded login (the
// automation's own identity) NEVER count, whatever their association.
//
// SETTLE. The durable two-observation rule on `(head, base, forcePushEpoch)`
// lives in settle-state.ts. The force-push epoch is the number of
// HeadRefForcePushedEvent NODES in the PR timeline, COUNTED CLIENT-SIDE —
// the filtered connection's `totalCount` is the UNFILTERED timeline count
// and is never read. The recheck's observation is WRITTEN to the state
// branch before settle is judged: the state branch IS the persistence, so
// an observation that is not durable does not exist, and no durable
// observation means no merge.
//
// NO CLASSIFY→MERGE WINDOW. gateMergeEffects wraps the executor's effects so
// the snapshot (reviews included) is re-fetched IMMEDIATELY before each
// forge merge call; a refusal resolves as a non-retryable merge failure and
// the inner mergePr is never invoked.
//
// FAIL-CLOSED: every ambiguity (truncated connection, malformed oid, GraphQL
// error, transport failure, CAS loss) refuses. recheckBeforeMerge and
// observeOpenPrs NEVER throw — a throw inside becomes a one-line, capped,
// log-safe refusal reason (counts and actor keys; never review bodies).
import { GhError, ghJson, ghNameOk } from '../ops/review/gh.js';
import type { GhFn, GhResult } from '../ops/review/gh.js';
import type { MergeEffects } from '../ops/merge/effects.js';
import { observe, pruneToOpen, settleStatus } from './settle-state.js';
import type { SettleState, SettleTuple } from './settle-state.js';
import { readSettleState, writeSettleState } from './state-branch.js';

/**
 * The ONE GraphQL document the recheck reads. Variable names are
 * load-bearing (the I11 collision rule, see fetchReviewState): the document
 * rides gh's `-f query=` slot, so no GraphQL variable may be named `query`.
 * `timelineItems.totalCount` is deliberately NOT selected — on a filtered
 * connection it reports the UNFILTERED count; the epoch is counted from
 * the nodes.
 */
export const PR_SNAPSHOT_QUERY = `query ($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      state
      isDraft
      author { login __typename }
      headRefOid
      baseRefOid
      reviews(first: 100) {
        pageInfo { hasNextPage }
        nodes { author { login __typename } authorAssociation state submittedAt commit { oid } }
      }
      timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], first: 100) {
        pageInfo { hasNextPage }
        nodes { __typename }
      }
    }
  }
}`;

/** One review, reduced to the facts the judgment reads (never the body). */
export interface BoundReview {
  /** Normalized actor identity — see {@link actorKey}. */
  actorKey: string;
  /** The author login verbatim, or null (deleted account). */
  authorLogin: string | null;
  /** The author's GraphQL `__typename`; anything but Bot/User → 'Other'. */
  authorType: 'Bot' | 'User' | 'Other';
  /** `authorAssociation` verbatim ('' when absent). */
  association: string;
  /** The review state; unknown wire values → null. */
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING' | null;
  /** Submission timestamp; null = PENDING (ignored by every judgment). */
  submittedAt: string | null;
  /** The reviewed commit, lowercase 40-hex, or null when absent/malformed. */
  commitOid: string | null;
}

/** The PR as seen by one recheck read. */
export interface PrSnapshot {
  /** The PR number, echoed. */
  pr: number;
  /** True iff the forge state is OPEN. */
  open: boolean;
  /** The forge draft flag. */
  draft: boolean;
  /** PR author login, or null (deleted account). */
  authorLogin: string | null;
  /** Head commit, lowercase 40-hex, or null when absent/malformed. */
  headRefOid: string | null;
  /** Base branch tip, lowercase 40-hex, or null when absent/malformed. */
  baseRefOid: string | null;
  /** HeadRefForcePushedEvent nodes counted client-side. */
  forcePushEpoch: number;
  /** Every review on the first (and, untruncated, only) page. */
  reviews: BoundReview[];
  /**
   * True when a connection had more pages OR was missing/malformed — the
   * reviews and/or the epoch may be incomplete, so every consumer refuses.
   */
  truncated: boolean;
}

/** The trust set the acceptance judgment applies (plan D3). */
export interface TrustPolicy {
  /** `authorAssociation` values that make a USER trusted. */
  trustedAssociations: ReadonlySet<string>;
  /** Normalized bot names (e.g. 'coderabbitai') whose reviews count. */
  trustedBots: ReadonlySet<string>;
  /** Review states that count as acceptance when bound to the head. */
  acceptStates: ReadonlySet<'APPROVED' | 'COMMENTED'>;
  /** Logins (automation identities) that never count, in either form. */
  excludedLogins: ReadonlySet<string>;
}

/**
 * The conservative blanks (RS-15 Annex B): OWNER/MEMBER/COLLABORATOR users,
 * no bots, APPROVED only, no extra exclusions (the PR author is always
 * excluded regardless). Frozen — callers build their own policy object.
 */
export const CONSERVATIVE_TRUST_POLICY: TrustPolicy = Object.freeze({
  trustedAssociations: new Set(['OWNER', 'MEMBER', 'COLLABORATOR']) as ReadonlySet<string>,
  trustedBots: new Set<string>() as ReadonlySet<string>,
  acceptStates: new Set(['APPROVED'] as const) as ReadonlySet<'APPROVED' | 'COMMENTED'>,
  excludedLogins: new Set<string>() as ReadonlySet<string>,
});

/** judgeAtHead's verdict. */
export type HeadJudgment =
  | { accepted: true; by: string[] }
  | {
      accepted: false;
      reason: 'objection_outstanding' | 'no_head_bound_acceptance';
      detail: string;
    };

/** recheckBeforeMerge's verdict. */
export type RecheckResult =
  | { ok: true; tuple: SettleTuple; acceptedBy: string[]; firstObservedAt: string }
  | { ok: false; reason: string };

/** Transport + coordinates shared by every read here. */
interface ForgeDeps {
  /** The gh transport. */
  gh: GhFn;
  /** Repository owner. */
  owner: string;
  /** Repository name. */
  repo: string;
}

/** The observer labels persisted into the ledger. */
const RECHECK_BY = 'self-merge-prs:recheck';
const OBSERVE_BY = 'self-merge-prs:observe';

/** Refusal-reason cap: a reason is a log fact, not an error dump. */
const REASON_MAX = 500;

const SHA_RE = /^[0-9a-f]{40}$/i;

// -- JSON-boundary helpers ----------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A wire oid, accepted only as 40-hex (lowercased); anything else → null. */
const asOid = (value: unknown): string | null => {
  const raw = asString(value);
  return SHA_RE.test(raw) ? raw.toLowerCase() : null;
};

/** First line of a message, capped — the refusal reason's raw material. */
const oneLine = (text: string): string => {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > REASON_MAX ? line.slice(0, REASON_MAX) : line;
};

/** Any throwable → one capped line (gh failures keep exit code + stderr). */
const describeError = (error: unknown): string =>
  error instanceof GhError
    ? `gh exit ${String(error.code)}: ${oneLine(error.stderr.trim() === '' ? error.message : error.stderr)}`
    : oneLine(error instanceof Error ? error.message : String(error));

const REVIEW_STATES: readonly string[] = [
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
];

const OPINIONATED: ReadonlySet<string> = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/** Login → the bare lowercase name (a trailing `[bot]` stripped). */
const bareName = (login: string): string => login.toLowerCase().replace(/\[bot\]$/, '');

/** A connection's `hasNextPage`, failing closed: anything but `false` → true. */
const connectionTruncated = (connection: unknown): boolean => {
  const record = asRecord(connection);
  if (!Array.isArray(record['nodes'])) return true;
  return asRecord(record['pageInfo'])['hasNextPage'] !== false;
};

// -- identity + folding -------------------------------------------------------

/**
 * The normalized actor identity: kind 'bot' when `__typename` is Bot or the
 * login ends with `[bot]`, else 'user'; key `${kind}:${bare lowercase
 * login}`. So `coderabbitai`/Bot and `coderabbitai[bot]`/User are ONE actor
 * (`bot:coderabbitai`) while a human `coderabbitai` is `user:coderabbitai`.
 * A null/empty login (deleted account) → `unknown:` — never trusted.
 */
export function actorKey(login: string | null, typename: string | null): string {
  if (login === null || login === '') return 'unknown:';
  const kind = typename === 'Bot' || /\[bot\]$/i.test(login) ? 'bot' : 'user';
  return `${kind}:${bareName(login)}`;
}

/** Epoch ms of a submitted review, or NaN when unparseable/pending. */
const submittedMs = (review: BoundReview): number =>
  review.submittedAt === null ? Number.NaN : Date.parse(review.submittedAt);

/**
 * Fold ALL reviews to each actor's LATEST OPINIONATED one (APPROVED,
 * CHANGES_REQUESTED, DISMISSED; latest by submittedAt). PENDING reviews,
 * reviews with a null/unparseable submittedAt, COMMENTED, and unknown states
 * are ignored — a later comment never supersedes an opinion. Ties keep the
 * later-listed review (GraphQL lists reviews oldest first). Pure.
 */
export function foldLatestOpinionated(reviews: readonly BoundReview[]): Map<string, BoundReview> {
  const latest = new Map<string, BoundReview>();
  for (const review of reviews) {
    if (review.state === null || !OPINIONATED.has(review.state)) continue;
    const ms = submittedMs(review);
    if (!Number.isFinite(ms)) continue;
    const prior = latest.get(review.actorKey);
    if (prior === undefined || ms >= submittedMs(prior)) latest.set(review.actorKey, review);
  }
  return latest;
}

// -- the snapshot read --------------------------------------------------------

/** One wire review node → BoundReview. */
const toBoundReview = (node: unknown): BoundReview => {
  const record = asRecord(node);
  const author = asRecord(record['author']);
  const login = asString(author['login']) || null;
  const typename = asString(author['__typename']);
  const state = asString(record['state']);
  return {
    actorKey: actorKey(login, typename),
    authorLogin: login,
    authorType: typename === 'Bot' || typename === 'User' ? typename : 'Other',
    association: asString(record['authorAssociation']),
    state: REVIEW_STATES.includes(state) ? (state as BoundReview['state']) : null,
    submittedAt: asString(record['submittedAt']) || null,
    commitOid: asOid(asRecord(record['commit'])['oid']),
  };
};

/**
 * Read one PR's merge-time snapshot: state, draft flag, author, head/base
 * oids, the first 100 reviews (commit-bound), and the force-push epoch —
 * ONE `gh api graphql` call, argv mirroring fetchReviewState (owner/name as
 * raw `-f` strings, pr coerced via `-F`). THROWS on invalid owner/repo, a
 * transport failure, a GraphQL `errors` array, or a missing pullRequest.
 * `truncated` is set on any `hasNextPage` other than `false` or a
 * missing/malformed connection (fail closed); oids are accepted only as
 * 40-hex (else null).
 */
export async function fetchPrSnapshot(deps: ForgeDeps, pr: number): Promise<PrSnapshot> {
  const { gh, owner, repo } = deps;
  if (!ghNameOk(owner) || !ghNameOk(repo)) {
    throw new Error(
      `merge-recheck: owner/repo must match the gh name charset (never "." or "..") — got owner ${JSON.stringify(owner)}, repo ${JSON.stringify(repo)}`,
    );
  }
  if (!Number.isSafeInteger(pr) || pr <= 0) {
    throw new Error(`merge-recheck: pr must be a positive safe integer — got ${String(pr)}`);
  }
  const payload = asRecord(
    await ghJson<unknown>(gh, [
      'api',
      'graphql',
      '-f',
      `query=${PR_SNAPSHOT_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${repo}`,
      '-F',
      `pr=${String(pr)}`,
    ]),
  );
  const errors = payload['errors'];
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors
      .map((error) => asString(asRecord(error)['message']) || 'unnamed error')
      .join('; ');
    throw new Error(`gh api graphql returned GraphQL errors: ${messages}`);
  }
  const pullValue = asRecord(asRecord(payload['data'])['repository'])['pullRequest'];
  if (typeof pullValue !== 'object' || pullValue === null || Array.isArray(pullValue)) {
    throw new Error(
      `gh api graphql returned no pullRequest payload for ${owner}/${repo}#${String(pr)}`,
    );
  }
  const pull = asRecord(pullValue);
  const reviewsConnection = asRecord(pull['reviews']);
  const timeline = asRecord(pull['timelineItems']);
  const reviewNodes = reviewsConnection['nodes'];
  const timelineNodes = timeline['nodes'];
  const author = asRecord(pull['author']);
  return {
    pr,
    open: asString(pull['state']) === 'OPEN',
    draft: pull['isDraft'] === true,
    authorLogin: asString(author['login']) || null,
    headRefOid: asOid(pull['headRefOid']),
    baseRefOid: asOid(pull['baseRefOid']),
    // Counted from the NODES; the filtered totalCount lies (module doc).
    forcePushEpoch: Array.isArray(timelineNodes)
      ? timelineNodes.filter(
          (node) => asString(asRecord(node)['__typename']) === 'HeadRefForcePushedEvent',
        ).length
      : 0,
    reviews: Array.isArray(reviewNodes) ? reviewNodes.map(toBoundReview) : [],
    truncated: connectionTruncated(pull['reviews']) || connectionTruncated(pull['timelineItems']),
  };
}

// -- the judgment -------------------------------------------------------------

/**
 * Whether `review`'s actor is trusted under `policy` for a PR by
 * `authorLogin`. The author and excluded logins are compared by bare name
 * (either identity form) — deliberately over-broad, which can only refuse.
 * Users need `authorType` User AND a trusted association; bots need their
 * bare name allowlisted in `trustedBots`.
 */
const isTrusted = (
  review: BoundReview,
  authorLogin: string | null,
  policy: TrustPolicy,
): boolean => {
  if (review.authorLogin === null || review.authorLogin === '') return false;
  const name = bareName(review.authorLogin);
  if (authorLogin !== null && authorLogin !== '' && bareName(authorLogin) === name) return false;
  for (const excluded of policy.excludedLogins) {
    if (bareName(excluded) === name) return false;
  }
  if (review.actorKey.startsWith('bot:')) {
    for (const bot of policy.trustedBots) {
      if (bareName(bot) === name) return true;
    }
    return false;
  }
  return review.authorType === 'User' && policy.trustedAssociations.has(review.association);
};

/**
 * Judge acceptance AT `headSha` — pure. Trusted actors only (see the module
 * doc). An outstanding objection — a trusted actor whose latest opinionated
 * review is CHANGES_REQUESTED, on ANY sha — refuses `objection_outstanding`.
 * Otherwise accepted iff some trusted actor has a SUBMITTED review with
 * `commitOid === headSha` (case-insensitive) in `policy.acceptStates`; a
 * review of any other commit never counts. `detail` is log-safe (counts and
 * actor keys only).
 */
export function judgeAtHead(
  snapshot: PrSnapshot,
  headSha: string,
  policy: TrustPolicy,
): HeadJudgment {
  const trusted = snapshot.reviews.filter((review) =>
    isTrusted(review, snapshot.authorLogin, policy),
  );
  const objectors = [...foldLatestOpinionated(trusted).values()]
    .filter((review) => review.state === 'CHANGES_REQUESTED')
    .map((review) => review.actorKey)
    .sort();
  if (objectors.length > 0) {
    return {
      accepted: false,
      reason: 'objection_outstanding',
      detail: `changes requested by ${objectors.join(', ')} (${String(objectors.length)} trusted objector(s))`,
    };
  }
  const head = headSha.toLowerCase();
  const acceptors = new Set<string>();
  for (const review of trusted) {
    if (
      SHA_RE.test(head) &&
      review.commitOid === head &&
      review.submittedAt !== null &&
      review.state !== null &&
      (policy.acceptStates as ReadonlySet<string>).has(review.state)
    ) {
      acceptors.add(review.actorKey);
    }
  }
  if (acceptors.size === 0) {
    const atHead = snapshot.reviews.filter((review) => review.commitOid === head).length;
    return {
      accepted: false,
      reason: 'no_head_bound_acceptance',
      detail: `no trusted acceptance bound to head ${head.slice(0, 12)} (reviews=${String(snapshot.reviews.length)} trusted=${String(trusted.length)} atHead=${String(atHead)})`,
    };
  }
  return { accepted: true, by: [...acceptors].sort() };
}

// -- the recheck --------------------------------------------------------------

/** recheckBeforeMerge's injected seams. */
export interface RecheckDeps extends ForgeDeps {
  /** The injected clock — read ONCE per recheck. */
  nowMs: () => number;
  /** Minimum spacing between the first and the recheck observation. */
  settleMs: number;
  /** The trust set. */
  policy: TrustPolicy;
}

/** The recheck body; may throw — the exported wrapper catches. */
const recheckOrThrow = async (
  deps: RecheckDeps,
  pr: number,
  expectedHead: string | undefined,
): Promise<RecheckResult> => {
  const refuse = (reason: string): RecheckResult => ({ ok: false, reason: oneLine(reason) });
  // (a) Only a pinned, full head is rechecked — the pin is what the forge's
  // --match-head-commit enforces after us.
  if (expectedHead === undefined || !SHA_RE.test(expectedHead)) {
    return refuse('unpinned head: the merge carries no 40-hex matchHeadCommit');
  }
  const expected = expectedHead.toLowerCase();
  // ONE clock read, BEFORE the fetch: the recheck stamp can only understate
  // the elapsed settle time (fail closed).
  const nowMs = deps.nowMs();
  // (b) The immediate re-fetch.
  let snapshot: PrSnapshot;
  try {
    snapshot = await fetchPrSnapshot(deps, pr);
  } catch (error) {
    return refuse(`recheck fetch failed: ${describeError(error)}`);
  }
  // (c)–(e) Structural gates.
  if (!snapshot.open) return refuse('pr is not open');
  if (snapshot.draft) return refuse('pr is a draft');
  if (snapshot.truncated) {
    return refuse('snapshot truncated: reviews or force-push timeline incomplete');
  }
  if (snapshot.headRefOid !== expected) {
    return refuse(
      `head moved: expected ${expected} but the forge reports ${snapshot.headRefOid ?? 'no valid head oid'}`,
    );
  }
  if (snapshot.baseRefOid === null) return refuse('base oid unavailable');
  const tuple: SettleTuple = {
    head: snapshot.headRefOid,
    base: snapshot.baseRefOid,
    forcePushEpoch: snapshot.forcePushEpoch,
  };
  // (f) Durable observation — no durable observation, no merge.
  let written: SettleState;
  try {
    const read = await readSettleState(deps);
    written = observe(read.state, pr, tuple, nowMs, RECHECK_BY);
    const write = await writeSettleState(
      deps,
      { state: written, parentCommit: read.parentCommit },
      `settle: recheck pr #${String(pr)}`,
    );
    if (!write.ok) return refuse(`settle state not durable: ${write.reason}`);
  } catch (error) {
    return refuse(`settle state not durable: ${describeError(error)}`);
  }
  // (g) Head-bound acceptance.
  const judgment = judgeAtHead(snapshot, expected, deps.policy);
  if (!judgment.accepted) return refuse(`${judgment.reason}: ${judgment.detail}`);
  // (h) Settle, judged on the WRITTEN state.
  const settle = settleStatus(written.prs[String(pr)], tuple, nowMs, deps.settleMs);
  if (!settle.settled) return refuse(`settle: ${settle.reason}`);
  return { ok: true, tuple, acceptedBy: judgment.by, firstObservedAt: settle.firstObservedAt };
};

/**
 * The merge-time recheck for PR `pr` pinned at `expectedHead`, in order:
 * (a) refuse an unpinned/non-40-hex head; (b) re-fetch the snapshot;
 * (c) refuse closed or draft; (d) refuse truncated; (e) refuse a moved head
 * or a missing base oid; (f) read the state branch, observe the tuple, and
 * WRITE it (compare-and-swap) — any read/write failure refuses as not
 * durable; (g) refuse without head-bound trusted acceptance or with an
 * outstanding objection; (h) refuse unless settled per the written ledger.
 * The clock is read ONCE. NEVER throws: every throw is a capped one-line
 * `ok: false` reason.
 */
export async function recheckBeforeMerge(
  deps: RecheckDeps,
  pr: number,
  expectedHead: string | undefined,
): Promise<RecheckResult> {
  try {
    return await recheckOrThrow(deps, pr, expectedHead);
  } catch (error) {
    return { ok: false, reason: oneLine(`recheck failed: ${describeError(error)}`) };
  }
}

// -- the run-start observation pass ------------------------------------------

/** observeOpenPrs's outcome. */
export interface ObserveOpenPrsResult {
  /** PRs whose tuple was observed into the written state. */
  observed: number[];
  /** PRs not observed, with the one-line why. */
  skipped: Array<{ pr: number; reason: string }>;
  /** The ONE write's outcome; null when `prs` was empty (no write attempted). */
  write: { ok: true; commit: string } | { ok: false; reason: string } | null;
}

/**
 * The run-start observation pass: snapshot each PR under per-PR fault
 * isolation (a fetch failure, truncated snapshot, closed PR, or missing
 * head/base oid is SKIPPED with a reason — never fatal to its siblings),
 * then read the ledger ONCE, observe every good tuple, prune records of
 * PRs not in `prs` (the caller passes the full open set), and write ONCE.
 * An empty `prs` attempts nothing (`write: null`).
 * The clock is read once, AFTER the fetches (stamps can only be late — an
 * anchor stamped late shortens the measured settle; fail closed). A read
 * throw or refused write is reported in `write`; NEVER throws.
 */
export async function observeOpenPrs(
  deps: ForgeDeps & { nowMs: () => number },
  prs: readonly number[],
): Promise<ObserveOpenPrsResult> {
  // Nothing to observe: never prune the ledger from an empty list (an empty
  // input is more likely a failed listing than a truly empty repo).
  if (prs.length === 0) return { observed: [], skipped: [], write: null };
  const skipped: Array<{ pr: number; reason: string }> = [];
  const tuples: Array<{ pr: number; tuple: SettleTuple }> = [];
  for (const pr of prs) {
    try {
      const snapshot = await fetchPrSnapshot(deps, pr);
      if (!snapshot.open) skipped.push({ pr, reason: 'not open' });
      else if (snapshot.truncated) skipped.push({ pr, reason: 'snapshot truncated' });
      else if (snapshot.headRefOid === null || snapshot.baseRefOid === null) {
        skipped.push({ pr, reason: 'head or base oid unavailable' });
      } else {
        tuples.push({
          pr,
          tuple: {
            head: snapshot.headRefOid,
            base: snapshot.baseRefOid,
            forcePushEpoch: snapshot.forcePushEpoch,
          },
        });
      }
    } catch (error) {
      skipped.push({ pr, reason: `fetch failed: ${describeError(error)}` });
    }
  }
  const observed: number[] = [];
  try {
    const nowMs = deps.nowMs();
    const read = await readSettleState(deps);
    let state = read.state;
    for (const { pr, tuple } of tuples) {
      try {
        state = observe(state, pr, tuple, nowMs, OBSERVE_BY);
        observed.push(pr);
      } catch (error) {
        skipped.push({ pr, reason: `observe failed: ${describeError(error)}` });
      }
    }
    state = pruneToOpen(state, new Set(prs));
    const write = await writeSettleState(
      deps,
      { state, parentCommit: read.parentCommit },
      `settle: observe ${String(observed.length)} open pr(s)`,
    );
    if (!write.ok)
      return { observed: [], skipped, write: { ok: false, reason: oneLine(write.reason) } };
    return { observed, skipped, write: { ok: true, commit: write.commit } };
  } catch (error) {
    return { observed: [], skipped, write: { ok: false, reason: describeError(error) } };
  }
}

// -- the effects gate ---------------------------------------------------------

/**
 * Wrap `effects` so every forge merge is preceded by `recheck` — the
 * immediate re-fetch that closes the classify→merge window. Every other
 * member delegates EXPLICITLY (method calls on `effects`, so class-instance
 * `this` binding is preserved). `mergePr(pr, opts)` runs
 * `recheck(pr, opts.matchHeadCommit)` first: a refusal resolves
 * `{ code: 1, stdout: '', stderr: 'cq merge-time recheck refused pr <n>: <reason>' }`
 * WITHOUT calling the inner mergePr — a wording that never matches
 * executeMerges' retryable `/base branch was modified/i`, so a refusal is
 * never retried. On ok the inner mergePr is called with `opts` unchanged.
 */
export function gateMergeEffects(
  effects: MergeEffects,
  recheck: (pr: number, expectedHead: string | undefined) => Promise<RecheckResult>,
): MergeEffects {
  return {
    validateRef: (ref) => effects.validateRef(ref),
    fetchRef: (ref) => effects.fetchRef(ref),
    readBaseRef: (pr) => effects.readBaseRef(pr),
    worktreePrepare: (pr, ref) => effects.worktreePrepare(pr, ref),
    worktreeRemove: (path) => effects.worktreeRemove(path),
    retargetBase: (pr, newBase) => effects.retargetBase(pr, newBase),
    pushRef: (ref, fromPath) => effects.pushRef(ref, fromPath),
    mergePr: async (pr, opts): Promise<GhResult> => {
      const verdict = await recheck(pr, opts.matchHeadCommit);
      if (!verdict.ok) {
        // Scrub the retryable phrase defensively: a reason quoting forge
        // text must never turn a refusal into a retry.
        const reason = verdict.reason.replace(/base branch was modified/gi, 'base changed');
        return {
          code: 1,
          stdout: '',
          stderr: `cq merge-time recheck refused pr ${String(pr)}: ${reason}`,
        };
      }
      return effects.mergePr(pr, opts);
    },
  };
}
