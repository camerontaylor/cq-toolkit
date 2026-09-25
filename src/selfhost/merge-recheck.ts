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
// not the code that would merge — and it counts only while it is still that
// actor's CURRENT opinion (the actor's latest accept-state, CHANGES_REQUESTED
// or DISMISSED review), so a dismissed or overruled approval never counts.
// We fold the latest opinionated review per ACTOR over ALL reviews ourselves: GitHub's `latestOpinionatedReviews
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
// is the ONLY bot trust path); an author that is neither Bot nor User
// (Organization, Mannequin, deleted) never counts; the PR author and every
// excluded login (the automation's own identity, plus the STRUCTURAL
// automation bots, which config can never re-admit) NEVER count, whatever
// their association. trustPolicyFromConfig maps the D3 config shape onto
// this policy and can only narrow the blanks.
//
// SETTLE. The durable two-observation rule on `(head, base, forcePushEpoch)`
// lives in settle-state.ts. The force-push epoch is the number of
// HeadRefForcePushedEvent NODES in the PR timeline, COUNTED CLIENT-SIDE —
// the filtered connection's `totalCount` is the UNFILTERED timeline count
// and is never read. The state branch IS the persistence: an observation
// that is not durable does not exist, and no durable observation means no
// merge — an ok recheck WRITES its observation (the audit record of the
// settled tuple) before it answers ok, and a failed write refuses.
//
// WRITES SCALE WITH ACTIVITY, NOT CRON FIRES. Every push to cq-state runs
// the repo's unfiltered `push:` workflows on that branch, so a write happens
// only when it carries something new: a created/reset record (a new
// anchor), a pruned record, or the pre-merge audit observation. A pure
// same-tuple append on an unchanged PR is never written — the first
// observation anchors settle and the merge-time recheck supplies the
// second, in memory, at the instant it judges.
//
// NO CLASSIFY→MERGE WINDOW. gateMergeEffects wraps the executor's effects so
// the snapshot (reviews and review threads included) is re-fetched
// IMMEDIATELY before each forge merge call; a refusal resolves as a
// non-retryable merge failure and the inner mergePr is never invoked. The
// base branch NAME the executor's readBaseRef saw right before the call is
// pinned too: the recheck refuses a changed, unverified, or protected base.
// Unresolved external review threads (classify row 5's count) refuse.
//
// FAIL-CLOSED: every ambiguity (truncated connection, malformed oid, GraphQL
// error, transport failure, CAS loss) refuses. recheckBeforeMerge and
// observeOpenPrs NEVER throw — a throw inside becomes a one-line, capped,
// log-safe refusal reason (counts and actor keys; never review bodies).
import { GhError, ghJson, ghNameOk } from '../ops/review/gh.js';
import type { GhFn, GhResult } from '../ops/review/gh.js';
import type { MergeEffects } from '../ops/merge/effects.js';
import { countUnresolvedThreads } from '../ops/review/threads.js';
import { observeWithChange, pruneToOpen, settleStatus } from './settle-state.js';
import type { SettleTuple } from './settle-state.js';
import { readSettleState, writeSettleState } from './state-branch.js';
import type { StateBranchSnapshot, StateBranchWriteResult } from './state-branch.js';

/**
 * The ONE GraphQL document the recheck reads, paged by three independent
 * cursors. Variable names are load-bearing (the I11 collision rule, see
 * fetchReviewState): the document rides gh's `-f query=` slot, so no
 * GraphQL variable may be named `query` — the cursors are reviewsAfter,
 * threadsAfter and timelineAfter, sent as `-f` strings ONLY when a real
 * cursor exists. `timelineItems.totalCount` is deliberately NOT selected —
 * on a filtered connection it reports the UNFILTERED count; the epoch is
 * counted from the nodes. A thread's ROOT author is its first comment's.
 */
export const PR_SNAPSHOT_QUERY = `query ($owner: String!, $name: String!, $pr: Int!, $reviewsAfter: String, $threadsAfter: String, $timelineAfter: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      state
      isDraft
      author { login __typename }
      headRefOid
      baseRefOid
      baseRefName
      reviewThreads(first: 100, after: $threadsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 1) { nodes { author { login } } } }
      }
      reviews(first: 100, after: $reviewsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes { author { login __typename } authorAssociation state submittedAt commit { oid } }
      }
      timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], first: 100, after: $timelineAfter) {
        pageInfo { hasNextPage endCursor }
        nodes { __typename }
      }
    }
  }
}`;

/**
 * Page cap per connection (fetchReviewState's reviewPages default): 1,000
 * reviews / review threads / force-push events. A connection with more pages is TRUNCATED
 * and every consumer refuses (fail closed).
 */
export const SNAPSHOT_PAGE_CAP = 10;

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

/** One review thread, reduced to the facts the thread rule reads. */
export interface SnapshotThread {
  /** True only when the wire says exactly `true` (anything else: unresolved). */
  isResolved: boolean;
  /** The ROOT comment's author login, or null (deleted/absent — external). */
  rootAuthorLogin: string | null;
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
  /** Base branch NAME, or null when absent/empty. */
  baseRefName: string | null;
  /** HeadRefForcePushedEvent nodes counted client-side. */
  forcePushEpoch: number;
  /** Every review across the pages read (all of them, when untruncated). */
  reviews: BoundReview[];
  /** Every review thread across the pages read (all, when untruncated). */
  threads: SnapshotThread[];
  /**
   * True when a connection had more pages than SNAPSHOT_PAGE_CAP, was
   * missing/malformed, or the head or base (oid or name) changed between
   * pages — the reviews, threads and/or the epoch may be incomplete, so
   * every consumer refuses.
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
 * Automation identities that NEVER count as reviewers, whatever the config
 * says (RS-15 Annex B): the Actions token and the toolkit's own Apps. A
 * trustedBots entry naming one of them is dropped.
 */
export const STRUCTURAL_EXCLUDED_LOGINS: readonly string[] = Object.freeze([
  'github-actions[bot]',
  'cq-automation[bot]',
  'cq-verdict[bot]',
  'cq-promoter[bot]',
]);

/**
 * Login → the bare lowercase name (a trailing `[bot]` stripped). Declared
 * above CONSERVATIVE_TRUST_POLICY, which calls it at module load.
 */
const bareName = (login: string): string => login.toLowerCase().replace(/\[bot\]$/, '');

/** The blank (and widest) trusted-association set; config may only narrow it. */
const BLANK_ASSOCIATIONS: readonly string[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];

/**
 * The D3 trust config, STRUCTURALLY (the W1.1 ClassifyPrConfig fields —
 * deliberately not imported, so either lane lands first).
 */
interface TrustPolicyConfig {
  /** Raw bot logins (e.g. 'coderabbitai[bot]') whose reviews count. */
  trustedBots?: readonly string[];
  /** Association narrowing; blank = {OWNER, MEMBER, COLLABORATOR}. */
  trustedAssociations?: readonly string[];
  /** The automation's own login — always excluded. */
  automationLogin?: string | null;
  /** Further logins that never count. */
  excludedLogins?: readonly string[];
  /** Review states that count as acceptance; blank = APPROVED only. */
  acceptReviewStates?: readonly string[];
}

/**
 * Map the D3 trust config onto a TrustPolicy — every mapping can only
 * NARROW trust relative to the blanks:
 *   - trustedBots: normalized to the bare lowercase name ('coderabbitai');
 *     an entry naming an excluded identity (structural, automation, or
 *     configured) is DROPPED;
 *   - trustedAssociations: intersected with {OWNER, MEMBER, COLLABORATOR}
 *     (case-insensitive); blank (absent or empty) → that set; a list with
 *     no member of it trusts no user;
 *   - acceptStates: APPROVED/COMMENTED only (every other state is not an
 *     acceptance); blank → {APPROVED}; a list naming neither accepts none;
 *   - excludedLogins: the configured ones plus automationLogin plus
 *     STRUCTURAL_EXCLUDED_LOGINS, lowercased.
 * Pure; empty/whitespace entries are ignored.
 */
export function trustPolicyFromConfig(cfg: TrustPolicyConfig): TrustPolicy {
  const clean = (values: readonly string[] | undefined): string[] =>
    (values ?? []).map((value) => value.trim()).filter((value) => value !== '');
  const excluded = new Set(
    [
      ...STRUCTURAL_EXCLUDED_LOGINS,
      ...clean(cfg.excludedLogins),
      ...clean(cfg.automationLogin == null ? [] : [cfg.automationLogin]),
    ].map((login) => login.toLowerCase()),
  );
  const excludedNames = new Set([...excluded].map(bareName));
  const trustedBots = new Set(
    clean(cfg.trustedBots)
      .map(bareName)
      .filter((name) => name !== '' && !excludedNames.has(name)),
  );
  const associations = clean(cfg.trustedAssociations).map((value) => value.toUpperCase());
  const trustedAssociations = new Set(
    associations.length === 0
      ? BLANK_ASSOCIATIONS
      : BLANK_ASSOCIATIONS.filter((value) => associations.includes(value)),
  );
  const states = clean(cfg.acceptReviewStates).map((value) => value.toUpperCase());
  const acceptStates = new Set<'APPROVED' | 'COMMENTED'>(
    states.length === 0
      ? ['APPROVED']
      : (['APPROVED', 'COMMENTED'] as const).filter((value) => states.includes(value)),
  );
  return { trustedAssociations, trustedBots, acceptStates, excludedLogins: excluded };
}

/**
 * The conservative blanks (RS-15 Annex B) — trustPolicyFromConfig({}):
 * OWNER/MEMBER/COLLABORATOR users, no bots, APPROVED only, the structural
 * automation identities excluded (the PR author is always excluded
 * regardless). Frozen — callers build their own policy object.
 */
export const CONSERVATIVE_TRUST_POLICY: TrustPolicy = Object.freeze(trustPolicyFromConfig({}));

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
  | {
      ok: true;
      tuple: SettleTuple;
      acceptedBy: string[];
      firstObservedAt: string;
      /** The state read's discarded reasons (the audit trail; usually empty). */
      discarded: string[];
    }
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

/**
 * One page of a connection, failing closed: missing/non-array nodes →
 * malformed; `hasNextPage` anything but `false` means more (a non-boolean
 * is treated as more); the cursor is kept only when it is a non-empty string.
 */
const readPage = (
  connection: unknown,
): { nodes: unknown[]; more: boolean; cursor: string | null } | null => {
  const record = asRecord(connection);
  const nodes = record['nodes'];
  if (!Array.isArray(nodes)) return null;
  const pageInfo = asRecord(record['pageInfo']);
  return {
    nodes,
    more: pageInfo['hasNextPage'] !== false,
    cursor: asString(pageInfo['endCursor']) || null,
  };
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
 * Fold ALL reviews to each actor's LATEST review whose state is in `states`
 * (default: the OPINIONATED states APPROVED, CHANGES_REQUESTED, DISMISSED;
 * latest by submittedAt). PENDING reviews, reviews with a null/unparseable
 * submittedAt, and states outside `states` (by default COMMENTED and
 * unknown) are ignored — a later comment never supersedes an opinion. Ties
 * keep the later-listed review (GraphQL lists reviews oldest first). Pure.
 */
export function foldLatestOpinionated(
  reviews: readonly BoundReview[],
  states: ReadonlySet<string> = OPINIONATED,
): Map<string, BoundReview> {
  const latest = new Map<string, BoundReview>();
  for (const review of reviews) {
    if (review.state === null || !states.has(review.state)) continue;
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

/** One wire reviewThread node → SnapshotThread (root = first comment). */
const toSnapshotThread = (node: unknown): SnapshotThread => {
  const record = asRecord(node);
  const comments = asRecord(record['comments'])['nodes'];
  const root = Array.isArray(comments) ? asRecord(comments[0]) : {};
  return {
    isResolved: record['isResolved'] === true,
    rootAuthorLogin: asString(asRecord(root['author'])['login']) || null,
  };
};

/** Per-connection pagination state inside fetchPrSnapshot. */
interface PagedConnection {
  /** The next `after` cursor; null = first page (the flag is omitted). */
  cursor: string | null;
  /** Stop advancing (read to the end, or truncated). */
  done: boolean;
}

/**
 * Read one PR's merge-time snapshot: state, draft flag, author, head/base
 * oids, the base branch name, EVERY review (commit-bound), EVERY review
 * thread (resolution + root author), and the force-push epoch — a single
 * `gh api graphql` request loop advancing three independent cursors
 * (fetchReviewState's pattern: owner/name as raw `-f` strings, pr coerced
 * via `-F`, `reviewsAfter`/`threadsAfter`/`timelineAfter` sent as `-f` ONLY
 * when a real cursor exists; a finished connection's re-served page is
 * ignored). The PR-level fields come from the FIRST page. THROWS on invalid
 * owner/repo, a transport failure, a GraphQL `errors` array, or a missing
 * pullRequest. `truncated` is set (fail closed) when a connection is
 * missing/malformed, still has pages past SNAPSHOT_PAGE_CAP, reports more
 * pages without a cursor, or a later page reports a different headRefOid,
 * baseRefOid or baseRefName (the PR or its base moved mid-read); oids are
 * accepted only as 40-hex (else null).
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
  const reviews: BoundReview[] = [];
  const threads: SnapshotThread[] = [];
  let forcePushEpoch = 0;
  let truncated = false;
  let first: Record<string, unknown> | null = null;
  const reviewsPaging: PagedConnection = { cursor: null, done: false };
  const threadsPaging: PagedConnection = { cursor: null, done: false };
  const timelinePaging: PagedConnection = { cursor: null, done: false };

  /** Consume one page of a live connection and advance (or finish) it. */
  const advance = (
    paging: PagedConnection,
    connection: unknown,
    page: number,
    take: (nodes: unknown[]) => void,
  ): void => {
    if (paging.done) return;
    const read = readPage(connection);
    if (read === null) {
      truncated = true;
      paging.done = true;
      return;
    }
    take(read.nodes);
    if (!read.more) {
      paging.done = true;
    } else if (page < SNAPSHOT_PAGE_CAP && read.cursor !== null) {
      paging.cursor = read.cursor;
    } else {
      // Past the cap, or more pages with no cursor to reach them.
      truncated = true;
      paging.done = true;
    }
  };

  const pinned = (pull: Record<string, unknown>): string =>
    JSON.stringify([
      asOid(pull['headRefOid']),
      asOid(pull['baseRefOid']),
      asString(pull['baseRefName']),
    ]);
  for (
    let page = 1;
    !reviewsPaging.done || !threadsPaging.done || !timelinePaging.done;
    page += 1
  ) {
    const args = [
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
    ];
    if (reviewsPaging.cursor !== null) args.push('-f', `reviewsAfter=${reviewsPaging.cursor}`);
    if (threadsPaging.cursor !== null) args.push('-f', `threadsAfter=${threadsPaging.cursor}`);
    if (timelinePaging.cursor !== null) args.push('-f', `timelineAfter=${timelinePaging.cursor}`);
    const payload = asRecord(await ghJson<unknown>(gh, args));
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
    if (first === null) {
      first = pull;
    } else if (pinned(pull) !== pinned(first)) {
      // The PR (head) or its base (oid or name) moved mid-read: the pages
      // describe different code or a different merge target.
      truncated = true;
      break;
    }
    advance(reviewsPaging, pull['reviews'], page, (nodes) => {
      reviews.push(...nodes.map(toBoundReview));
    });
    advance(threadsPaging, pull['reviewThreads'], page, (nodes) => {
      threads.push(...nodes.map(toSnapshotThread));
    });
    // Counted from the NODES; the filtered totalCount lies (module doc).
    // The connection is filtered to force-push events, so any node that is
    // not one is a malformed payload: counting around it could reuse a
    // settled tuple after an uncounted force-push — fail closed instead.
    advance(timelinePaging, pull['timelineItems'], page, (nodes) => {
      for (const node of nodes) {
        if (asString(asRecord(node)['__typename']) === 'HeadRefForcePushedEvent') {
          forcePushEpoch += 1;
        } else {
          truncated = true;
        }
      }
    });
  }
  const pull = first ?? {};
  const author = asRecord(pull['author']);
  return {
    pr,
    open: asString(pull['state']) === 'OPEN',
    draft: pull['isDraft'] === true,
    authorLogin: asString(author['login']) || null,
    headRefOid: asOid(pull['headRefOid']),
    baseRefOid: asOid(pull['baseRefOid']),
    baseRefName: asString(pull['baseRefName']) || null,
    forcePushEpoch,
    reviews,
    threads,
    truncated,
  };
}

// -- the judgment -------------------------------------------------------------

/**
 * Whether `review`'s actor is trusted under `policy` for a PR by
 * `authorLogin`. The author and excluded logins are compared by bare name
 * (either identity form) — deliberately over-broad, which can only refuse.
 * An author that is neither Bot nor User (null, Organization, …) is never
 * trusted. Users need `authorType` User AND a trusted association; bots
 * need their bare name allowlisted in `trustedBots`.
 */
const isTrusted = (
  review: BoundReview,
  authorLogin: string | null,
  policy: TrustPolicy,
): boolean => {
  if (review.authorLogin === null || review.authorLogin === '') return false;
  if (review.authorType === 'Other') return false;
  // An unknown PR author means the self-review exclusion cannot be
  // established: trust nobody (acceptance then fails closed).
  if (authorLogin === null || authorLogin === '') return false;
  const name = bareName(review.authorLogin);
  if (bareName(authorLogin) === name) return false;
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
 * Otherwise acceptance comes from each trusted actor's CURRENT opinion,
 * never its history: fold the actor's reviews to its LATEST RELEVANT one
 * (state in `policy.acceptStates` ∪ {CHANGES_REQUESTED, DISMISSED}, with a
 * parseable submittedAt); the actor accepts iff that review's state is in
 * `policy.acceptStates` AND its `commitOid === headSha` (case-insensitive).
 * So an approval at head later DISMISSED (GitHub rewrites the node's state,
 * or a later DISMISSED review lands) no longer counts, while a later
 * COMMENTED outside acceptStates supersedes nothing. A review of any other
 * commit never counts. `detail` is log-safe (counts and actor keys only).
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
  const acceptStates: ReadonlySet<string> = policy.acceptStates;
  const relevant = new Set<string>([...acceptStates, 'CHANGES_REQUESTED', 'DISMISSED']);
  const acceptors = [...foldLatestOpinionated(trusted, relevant).values()]
    .filter(
      (review) =>
        SHA_RE.test(head) &&
        review.commitOid === head &&
        review.state !== null &&
        acceptStates.has(review.state),
    )
    .map((review) => review.actorKey);
  if (acceptors.length === 0) {
    const atHead = snapshot.reviews.filter((review) => review.commitOid === head).length;
    return {
      accepted: false,
      reason: 'no_head_bound_acceptance',
      detail: `no trusted acceptance bound to head ${head.slice(0, 12)} (reviews=${String(snapshot.reviews.length)} trusted=${String(trusted.length)} atHead=${String(atHead)})`,
    };
  }
  return { accepted: true, by: acceptors.sort() };
}

// -- the recheck --------------------------------------------------------------

/** recheckBeforeMerge's injected seams. */
export interface RecheckDeps extends ForgeDeps {
  /** The injected clock — read ONCE per recheck, AFTER the snapshot fetch. */
  nowMs: () => number;
  /** Minimum spacing between the first and the recheck observation. */
  settleMs: number;
  /** The trust set. */
  policy: TrustPolicy;
  /**
   * The protected branch (SelfhostDefaults.protectedBranch): a PR whose
   * live base is this branch is refused outright — the automation never
   * merges into it. Absent → no such refusal.
   */
  protectedBranch?: string;
}

/** Cap on the one discarded reason quoted into a refusal. */
const DISCARDED_QUOTE_MAX = 120;

/** The refusal suffix naming the state read's discarded records ('' when none). */
const discardedSuffix = (discarded: readonly string[]): string => {
  if (discarded.length === 0) return '';
  const firstReason = (discarded[0] ?? '').split('\n', 1)[0] ?? '';
  return ` (state discarded: ${String(discarded.length)} record(s); first: ${firstReason.slice(0, DISCARDED_QUOTE_MAX)})`;
};

/** The recheck body; may throw — the exported wrapper catches. */
const recheckOrThrow = async (
  deps: RecheckDeps,
  pr: number,
  expectedHead: string | undefined,
  expectedBase: string | undefined,
): Promise<RecheckResult> => {
  const refuse = (reason: string): RecheckResult => ({ ok: false, reason: oneLine(reason) });
  // (a) Only a pinned, full head is rechecked — the pin is what the forge's
  // --match-head-commit enforces after us. Likewise a base NAME pinned by
  // the executor's own readBaseRef right before this merge call (I3): no
  // pin, no merge.
  if (expectedHead === undefined || !SHA_RE.test(expectedHead)) {
    return refuse('unpinned head: the merge carries no 40-hex matchHeadCommit');
  }
  if (expectedBase === undefined || expectedBase === '') {
    return refuse('base unverified: no successful readBaseRef preceded this merge call');
  }
  const expected = expectedHead.toLowerCase();
  // (b) The immediate re-fetch.
  let snapshot: PrSnapshot;
  try {
    snapshot = await fetchPrSnapshot(deps, pr);
  } catch (error) {
    return refuse(`recheck fetch failed: ${describeError(error)}`);
  }
  // ONE clock read, AFTER the fetch: the observation stamped below records
  // what the fetch saw, so its stamp must never predate the fetch (a new
  // anchor stamped early would lengthen the measured settle — fail open).
  const nowMs = deps.nowMs();
  // (c)–(e) Structural gates.
  if (!snapshot.open) return refuse('pr is not open');
  if (snapshot.draft) return refuse('pr is a draft');
  if (snapshot.truncated) {
    return refuse(
      'snapshot truncated: reviews, review threads or force-push timeline incomplete, or the pr moved mid-read',
    );
  }
  if (snapshot.headRefOid !== expected) {
    return refuse(
      `head moved: expected ${expected} but the forge reports ${snapshot.headRefOid ?? 'no valid head oid'}`,
    );
  }
  if (snapshot.baseRefOid === null) return refuse('base oid unavailable');
  if (snapshot.baseRefName === null) return refuse('base name unavailable');
  if (deps.protectedBranch !== undefined && snapshot.baseRefName === deps.protectedBranch) {
    return refuse(`base is the protected branch ${deps.protectedBranch}: never merged into`);
  }
  if (snapshot.baseRefName !== expectedBase) {
    return refuse(
      `base changed: readBaseRef pinned ${expectedBase} but the forge now reports ${snapshot.baseRefName}`,
    );
  }
  const tuple: SettleTuple = {
    head: snapshot.headRefOid,
    base: snapshot.baseRefOid,
    forcePushEpoch: snapshot.forcePushEpoch,
  };
  // (f) The observation, computed IN MEMORY on the durable ledger — an
  // unreadable ledger is no durable observation, so no merge.
  let read: StateBranchSnapshot;
  try {
    read = await readSettleState(deps);
  } catch (error) {
    return refuse(`settle state not durable: ${describeError(error)}`);
  }
  const observed = observeWithChange(read.state, pr, tuple, nowMs, RECHECK_BY);
  // Every refusal past the read names what the read discarded (audit).
  const suffix = discardedSuffix(read.discarded);
  const persist = (): Promise<StateBranchWriteResult> =>
    writeSettleState(
      deps,
      { state: observed.state, parentCommit: read.parentCommit },
      `settle: recheck pr #${String(pr)}`,
    );
  // A refusal writes only a NEW anchor (created/reset record), best effort
  // — the answer is a refusal either way, but a later run must be able to
  // settle from it. A refusal on an unchanged tuple writes nothing.
  const refuseAfterObserving = async (reason: string): Promise<RecheckResult> => {
    if (observed.changed !== 'appended') {
      try {
        await persist();
      } catch {
        // Best effort: the refusal stands regardless.
      }
    }
    return refuse(`${reason}${suffix}`);
  };
  // (g) Unresolved external threads (the I2 thread rule, classify row 5's
  // exact count: root author ≠ PR author; a null root author is external),
  // judged before any review.
  const unresolved = countUnresolvedThreads(
    snapshot.threads.map((thread) => ({
      id: '',
      rootDatabaseId: null,
      path: null,
      line: null,
      isResolved: thread.isResolved,
      isOutdated: false,
      authorLogin: thread.rootAuthorLogin,
      createdAt: null,
      body: '',
      replies: [],
    })),
    { excludeAuthorLogin: snapshot.authorLogin },
  );
  if (unresolved > 0) {
    return refuseAfterObserving(`unresolved external threads: ${String(unresolved)}`);
  }
  // (h) Head-bound acceptance.
  const judgment = judgeAtHead(snapshot, expected, deps.policy);
  if (!judgment.accepted) {
    return refuseAfterObserving(`${judgment.reason}: ${judgment.detail}`);
  }
  // (i) Settle, judged on the observed ledger.
  const settle = settleStatus(observed.state.prs[String(pr)], tuple, nowMs, deps.settleMs);
  if (!settle.settled) return refuseAfterObserving(`settle: ${settle.reason}`);
  // (j) About to answer ok: the audit observation MUST be durable first.
  let write: StateBranchWriteResult;
  try {
    write = await persist();
  } catch (error) {
    return refuse(`settle state not durable: ${describeError(error)}${suffix}`);
  }
  if (!write.ok) return refuse(`settle state not durable: ${write.reason}${suffix}`);
  return {
    ok: true,
    tuple,
    acceptedBy: judgment.by,
    firstObservedAt: settle.firstObservedAt,
    discarded: read.discarded,
  };
};

/**
 * The merge-time recheck for PR `pr` pinned at `expectedHead` onto the base
 * branch NAME `expectedBase` (the executor's own readBaseRef answer right
 * before this merge call), in order: (a) refuse an unpinned/non-40-hex head
 * or an absent base pin ('base unverified'); (b) re-fetch the snapshot, then
 * read the clock ONCE; (c) refuse closed or draft; (d) refuse truncated;
 * (e) refuse a moved head, a missing base oid/name, a live base that is
 * `deps.protectedBranch`, or a live base name ≠ `expectedBase` ('base
 * changed'); (f) read the state branch (a read failure refuses as not
 * durable) and observe the tuple in memory; (g) refuse unresolved external
 * review threads; (h) refuse without head-bound trusted acceptance or with
 * an outstanding objection; (i) refuse unless settled per the observed
 * ledger; (j) WRITE the observation (compare-and-swap) and answer ok — a
 * failed write refuses as not durable. A refusal at (g)–(i) writes only
 * when the observation created/reset the record (best effort); on an
 * unchanged tuple it writes nothing. Every refusal past (f) carries a
 * short `(state discarded: …)` suffix when the read discarded records; an
 * ok answer carries them as `discarded`. NEVER throws: every throw is a
 * capped one-line `ok: false` reason.
 */
export async function recheckBeforeMerge(
  deps: RecheckDeps,
  pr: number,
  expectedHead: string | undefined,
  expectedBase: string | undefined,
): Promise<RecheckResult> {
  try {
    return await recheckOrThrow(deps, pr, expectedHead, expectedBase);
  } catch (error) {
    return { ok: false, reason: oneLine(`recheck failed: ${describeError(error)}`) };
  }
}

// -- the run-start observation pass ------------------------------------------

/** observeOpenPrs's outcome. */
export interface ObserveOpenPrsResult {
  /**
   * PRs whose live tuple the ledger now anchors — newly created/reset and
   * already-anchored alike; empty when the ledger read or the write failed.
   */
  observed: number[];
  /** PRs not observed, with the one-line why. */
  skipped: Array<{ pr: number; reason: string }>;
  /** Why (parts of) the persisted ledger were discarded on read — the audit trail. */
  discarded: string[];
  /**
   * The write's outcome; null when nothing material changed (no record
   * created, reset, or pruned) or `prs` was empty — no write attempted.
   */
  write: { ok: true; commit: string } | { ok: false; reason: string } | null;
}

/**
 * The run-start observation pass: snapshot each PR under per-PR fault
 * isolation (a fetch failure, truncated snapshot, closed PR, or missing
 * head/base oid is SKIPPED with a reason — never fatal to its siblings),
 * then read the ledger ONCE, observe every good tuple, prune records of
 * PRs not in `prs` (the caller passes the full open set), and write at most
 * ONCE — only when the ledger changed MATERIALLY: a record created or reset
 * (a new anchor) or a record pruned. A same-tuple observation is NOT
 * appended (the first observation anchors settle; the merge-time recheck
 * supplies the second), so an idle repo costs no state-branch push. An
 * empty `prs` attempts nothing (`write: null`).
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
  if (prs.length === 0) return { observed: [], skipped: [], discarded: [], write: null };
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
  let discarded: string[] = [];
  try {
    const nowMs = deps.nowMs();
    const read = await readSettleState(deps);
    discarded = read.discarded;
    let state = read.state;
    let material = false;
    for (const { pr, tuple } of tuples) {
      try {
        const next = observeWithChange(state, pr, tuple, nowMs, OBSERVE_BY);
        // A same-tuple append is dropped: the anchor already stands.
        if (next.changed !== 'appended') {
          state = next.state;
          material = true;
        }
        observed.push(pr);
      } catch (error) {
        skipped.push({ pr, reason: `observe failed: ${describeError(error)}` });
      }
    }
    const pruned = pruneToOpen(state, new Set(prs));
    if (Object.keys(pruned.prs).length !== Object.keys(state.prs).length) material = true;
    if (!material) return { observed, skipped, discarded, write: null };
    const write = await writeSettleState(
      deps,
      { state: pruned, parentCommit: read.parentCommit },
      `settle: observe ${String(prs.length)} open pr(s)`,
    );
    if (!write.ok) {
      return {
        observed: [],
        skipped,
        discarded,
        write: { ok: false, reason: oneLine(write.reason) },
      };
    }
    return { observed, skipped, discarded, write: { ok: true, commit: write.commit } };
  } catch (error) {
    return { observed: [], skipped, discarded, write: { ok: false, reason: describeError(error) } };
  }
}

// -- the effects gate ---------------------------------------------------------

/**
 * Wrap `effects` so every forge merge is preceded by `recheck` — the
 * immediate re-fetch that closes the classify→merge window. Every other
 * member delegates EXPLICITLY (method calls on `effects`, so class-instance
 * `this` binding is preserved). BASE PIN (I3): `readBaseRef(pr)` delegates
 * and REMEMBERS, per PR, the `baseRefName` of the most recent SUCCESSFUL
 * answer (ok with a non-empty name); a failed or throwing read forgets it.
 * executeMerges calls readBaseRef right before every merge attempt and
 * every retry. `mergePr(pr, opts)` CONSUMES that pin (one read, one merge
 * call) and runs `recheck(pr, opts.matchHeadCommit, pinnedBase)` first —
 * `pinnedBase` undefined when no successful read preceded it. A refusal
 * resolves
 * `{ code: 1, stdout: '', stderr: 'cq merge-time recheck refused pr <n>: <reason>' }`
 * WITHOUT calling the inner mergePr — a wording that never matches
 * executeMerges' retryable `/base branch was modified/i`, so a refusal is
 * never retried. On ok the inner mergePr is called with `opts` unchanged.
 */
export function gateMergeEffects(
  effects: MergeEffects,
  recheck: (
    pr: number,
    expectedHead: string | undefined,
    expectedBase: string | undefined,
  ) => Promise<RecheckResult>,
): MergeEffects {
  const pinnedBase = new Map<number, string>();
  return {
    validateRef: (ref) => effects.validateRef(ref),
    fetchRef: (ref) => effects.fetchRef(ref),
    readBaseRef: async (pr) => {
      // Forget first: a failed or throwing read must never leave an older pin.
      pinnedBase.delete(pr);
      const answer = await effects.readBaseRef(pr);
      if (answer.ok && typeof answer.baseRefName === 'string' && answer.baseRefName !== '') {
        pinnedBase.set(pr, answer.baseRefName);
      }
      return answer;
    },
    worktreePrepare: (pr, ref) => effects.worktreePrepare(pr, ref),
    worktreeRemove: (path) => effects.worktreeRemove(path),
    retargetBase: (pr, newBase) => effects.retargetBase(pr, newBase),
    pushRef: (ref, fromPath) => effects.pushRef(ref, fromPath),
    mergePr: async (pr, opts): Promise<GhResult> => {
      const base = pinnedBase.get(pr);
      pinnedBase.delete(pr);
      const verdict = await recheck(pr, opts.matchHeadCommit, base);
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
