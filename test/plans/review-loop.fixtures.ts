// Split provenance: test/plans/review-loop.helpers.ts was split by subject;
// this module carries the loop world fixtures (the fake world's shape, shas,
// thread/comment builders and the default world).
const NOW = 1_750_000_000_000;
const COORDS = { owner: 'octo', repo: 'widget', pr: 7 } as const;

/**
 * Fixture timestamps are DERIVED from the injected clock, never absolute —
 * an absolute "September 2026" stamp is a time bomb against the classify
 * table's recency heuristics (an unknowingly future date flips the
 * last-word/answered comparisons under a real clock). ROOT_AGE keeps the
 * anchors an hour old; REPLY_AGE is "recently replied".
 */
export const ROOT_AGE = 60 * 60_000;
export const REPLY_AGE = 5 * 60_000;
export const iso = (ageMs: number): string => new Date(NOW - ageMs).toISOString();
/** The review worktree's branch label (reviewBranchFor(7)) and its checked-out sha. */
export const LABEL = 'cq-review/pr-7';
/** The PR's real head branch — the push refspec target (finding 1). */
export const HEAD_REF = 'pr-7-fix';
export const SHA = 'b7e5f1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8';
/**
 * A REAL new commit in the world: full 40-hex (the per-item resolve gate
 * rejects short shas and non-sha literals outright), known to the fake git
 * (rev-parse + ancestry answer), and a STRICT descendant of the served
 * origin head.
 */
export const NEW_SHA = 'cafe1234cafe1234cafe1234cafe1234cafe1234';
export const BEEF_SHA = 'beef4567beef4567beef4567beef4567beef4567';
/** A second real commit for the range pins (worker B's claimed tip). */
export const DEAD_SHA = 'dead5678dead5678dead5678dead5678dead5678';
/** An UNCLAIMED mid-range commit for the range-accountability pin (round 2). */
export const MID_SHA = 'abcd1234abcd1234abcd1234abcd1234abcd1234';
/** An ANCESTOR of the before-head — the backward-move pin's tip (jLBJm P2). */
export const ANCESTOR_SHA = 'cccc1111cccc1111cccc1111cccc1111cccc1111';
/**
 * A PRE-EXISTING commit between the STALE snapshot head and the observed
 * base — the stale-snapshot pin's false positive (codex P2).
 */
export const PREEXISTING_SHA = '0123abcd0123abcd0123abcd0123abcd0123abcd';
/** The served origin heads — 40-hex so the per-item gate's STRICT
 * descendant check (sha ≠ before.headSha) is exercisable. */
export const BEFORE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const AFTER_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export interface LoopWorld {
  /** The head sha the fake gh serves for the PR object. */
  sha: string;
  /** When true, a recorded git push moves the served head sha (the fix landed). */
  advanceOnPush: boolean;
  /**
   * Shas the fake git world knows: `rev-parse --verify <sha>^{commit}`
   * succeeds and `merge-base --is-ancestor <sha> HEAD` exits 0 exactly for
   * these — the per-item resolve gate (finding 2) sees a hallucinated sha
   * as unverifiable.
   */
  knownShas: string[];
  /** When set, the Nth and every later git push FAILS (1-based). */
  pushFailAt?: number;
  loseFirstPushAcknowledgement?: boolean;
  /**
   * When set, the fake gh's PR-object reads keep serving the OLD head —
   * origin REST lag — while the git world HAS the new commit (finding 6:
   * the PR-wide verdict is observability only).
   */
  laggingOrigin?: boolean;
  /** Commit messages the fake git answers for `log -1 --format=%B <sha>`. */
  commitMessages: Record<string, string>;
  /** REST issue comments (the top-level PR conversation) served to the fetch. */
  issueComments: unknown[];
  /**
   * The worktree HEAD advances after this many reads of `rev-parse HEAD`
   * at the worktree path (read 1 is resolvePrWorktree's candidate check,
   * read 2 is the loop's pre-fix boundary, read 3 is the post-fix
   * boundary — 2 models "a commit landed during the fix stage").
   */
  worktreeAdvancesAt?: number;
  /**
   * The worktree is checked out at the SERVED origin head (`world.sha`), as
   * production's resolvePrWorktree guarantees: every un-advanced worktree
   * read (and the origin ref) report it. A published fix advances it with
   * `worktreeAdvancesAt`. Default off (legacy: SHA throughout).
   */
  worktreeFollowsOrigin?: boolean;
  /**
   * The head the worktree (and the origin ref resolvePrWorktree fetched) sit
   * at, when it differs from the served `sha`: a push landed between
   * resolvePrWorktree and the state fetch. Overrides worktreeFollowsOrigin.
   */
  worktreeHead?: string;
  executionHead?: string;
  /** The sha the ADVANCED worktree HEAD reports (default: the 4444 filler). */
  worktreeAdvancesTo?: string;
  /**
   * Shas `rev-list <before>..HEAD` prints for the ADVANCED worktree
   * (rev-list order, newest first; default: the advanced tip alone — a
   * single commit). The loop's range accountability (round 2) requires
   * every listed sha to be a verified claimed commit.
   */
  revListShas?: string[];
  /**
   * BASE-KEYED ranges (codex P2): when set, `rev-list <base>..HEAD` answers
   * from THIS map instead of revListShas — the stale-snapshot pin serves a
   * different range per base (the snapshot-stale base drags in
   * pre-existing commits the observed base does not).
   */
  revListByBase?: Record<string, string[]>;
  /** Shas whose `<sha>..HEAD` ancestry the fake git REFUSES (drives the not-ancestor stage). */
  ancestorFails?: string[];
  /** `git diff --quiet <sha>^..<sha>`: 0 empty, 1 non-empty, other unreadable. */
  diffCode?: number;
  /**
   * Worktree-path `rev-parse HEAD` reads after this count FAIL (round 3:
   * the loop's post-run read is read 3 — read 1 is resolvePrWorktree's
   * candidate check, read 2 the pre-fix boundary). Drives the fail-closed
   * head-unreadable gate without disturbing worktree resolution.
   */
  headReadFailsAfter?: number;
  /**
   * The ONE worktree-path HEAD read (by count) that FAILS (final bot slice
   * P1): `2` fails exactly the loop's PRE-run boundary read while
   * resolution (read 1) and the post-run read (3) succeed — the P1 shape.
   */
  headReadFailsAt?: number;
  /** When true, `status --porcelain` reports a dirty worktree. */
  dirty?: boolean;
  /**
   * Files in the worktree tree, path → line count, served to `git show
   * <sha>:<path>` (an unchanged answer's evidence check). Default:
   * DEFAULT_WORLD_FILES.
   */
  files?: Record<string, number>;
  /** Per-commit trees overriding `files` for `git cat-file`/`git show` at that sha. */
  filesAt?: Record<string, Record<string, number>>;
  /** GraphQL thread nodes served to fetchReviewState. */
  threads: unknown[];
  /** REST pulls-comment entries (flat shape is tolerated by the slurp guard). */
  pullsComments: unknown[];
  /**
   * When true, the fake gh REFUSES resolveReviewThread (drives the
   * pending-resolve carry pin: the reply posts, the resolve stays
   * unrecorded).
   */
  resolveReviewThreadFails?: boolean;
  /** Resolved-thread nodes served to the snapshot walks. */
  resolvedThreads: unknown[];
}

/** One GraphQL root-comment node (fetchReviewState reads databaseId + author + body). */
export const rootComment = (databaseId: number, login: string, body: string): unknown => ({
  databaseId,
  author: { login },
  body,
  createdAt: iso(ROOT_AGE),
});

/** One actionable thread: external reviewer, unresolved, fresh. */
export const actionableThread = (
  id: string,
  path: string,
  line: number,
  databaseId: number,
): unknown => ({
  id,
  isResolved: false,
  isOutdated: false,
  path,
  line,
  comments: { nodes: [rootComment(databaseId, 'reviewer', `Fix ${path} at ${String(line)}.`)] },
});

/** GitHub's view once a resolve recorded: the thread `id` is served resolved. */
export const markResolved = (world: LoopWorld, id: string): void => {
  world.threads = world.threads.map((thread) =>
    (thread as { id: string }).id === id ? { ...(thread as object), isResolved: true } : thread,
  );
};

/** The default world: T1 actionable (external), T2 the responder's own (skip). */
export const defaultWorld = (): LoopWorld => ({
  sha: BEFORE_SHA,
  advanceOnPush: true,
  knownShas: [SHA, NEW_SHA],
  commitMessages: { [NEW_SHA]: 'Fix review item T1 in src/a.ts' },
  issueComments: [],
  threads: [
    actionableThread('T1', 'src/a.ts', 3, 101),
    {
      id: 'T2',
      isResolved: false,
      isOutdated: false,
      path: 'src/b.ts',
      line: 8,
      comments: { nodes: [rootComment(102, 'prauthor', 'The responder note.')] },
    },
  ],
  pullsComments: [],
  resolvedThreads: [],
});

/**
 * A REST pulls-comment entry. The chain ROOT (in_reply_to_id null, id =
 * the thread's rootDatabaseId) must be present for attachRestReplies to
 * anchor a reply — real GitHub collections always include it.
 */
export const restComment = (
  id: number,
  login: string,
  body: string,
  iso: string,
  inReplyToId: number | null,
): unknown => ({
  id,
  node_id: null,
  user: { login },
  body,
  created_at: iso,
  in_reply_to_id: inReplyToId,
});

export { COORDS, NOW };
