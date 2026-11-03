// E4 slice 2 — tests for the review-loop plan wiring
// (src/plans/review-loop.ts; ws-e item 8).
//
// Pinned here:
//   1. HAPPY PATH: one actionable thread → the fix driver commits → the
//      worktree push publishes it → the after-snapshot sees the new commit →
//      reply + resolve post → outcome ok (fixReport came from the governed
//      runPlan: counts.done === 1). VERIFY BEFORE ANY POST is asserted from
//      the fake gh's call log: no mutation argv precedes the AFTER-snapshot
//      argv. Every git push argv is exactly the composed worktree form
//      ['-C', <worktree>, 'push', 'origin', 'HEAD:<branch>'] — the prWorktree
//      argv pattern (leading -C, since the runner spawns with the process
//      cwd).
//   2. ENRICHMENT: the fix job's input.item carries the thread's body, path,
//      line, and prior comments reconstructed from the fetched state (REST
//      reply chains included).
//   3. NO PROGRESS: the driver claims a fix but the fake world never moves
//      (identical snapshots) → needs-human naming NO PROGRESS; the resolve
//      is withheld (a claimed fix without observable movement never hides
//      its thread); the reply still posts (the worker's account is reported
//      honestly for the human to judge).
//   4. PARTIAL FAILURE: a malformed worker answer → that fix row failed →
//      needs-human, while the other thread still gets its reply + resolve
//      (stopOnError false).
//   5. EXIT CODE: the needs-human outcome maps to exit 3 through the CLI
//      mapper (the "via the CLI" claim, tested at the mapper seam).
//   6. RE-RUN NO-OP: the actionable thread now carries the responder's reply
//      → classify says responded → zero batches, zero fix jobs, zero gh
//      mutations, outcome ok, and NO 'NO PROGRESS' anywhere (verify never
//      ran — a no-op must not manufacture a verdict).
//   7. REGISTRY: listPlans() discovers 'review-loop'; its importer resolves
//      to the valid empty instance; PlanSchema.parse accepts it.
//
// Hermetic by construction: the gh and git seams are routed fakes recording
// every argv (no network, no spawned processes, no real clocks); the fix
// workers run through the REAL makeFixReviewItem op over a scripted Driver;
// the only filesystem writes are the test's own mkdtemp scratch dirs.
//
// The suite was split into per-subject files (review-loop.<subject>.test.ts)
// so review tooling can see below the 256 KiB single-file cap; this module
// carries the shared fixtures, fakes, runner and settle-gate helpers all of
// them import.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect } from 'vitest';
import type { Driver, OpInvocation, WorkerResult } from '../../src/driver/types.js';
import type { OpRegistryView } from '../../src/kernel/runner.js';
import type { GovernanceOptIn, OpRegistryEntry } from '../../src/kernel/types.js';
import { makeFixReviewItem, type FixReviewItemInput } from '../../src/ops/review/fixReviewItem.js';
import { FixReviewItemInputSchema } from '../../src/ops/review/registry.js';
import type { GhFn, GhResult } from '../../src/adapters/forge-github/gh.js';
import type { RegistryMap, WorktreeRegistry } from '../../src/adapters/git/prWorktree.js';
import { runReviewLoop, type ReviewLoopOutcome } from '../../src/plans/review-loop.js';

// ---------------------------------------------------------------------------
// Fixtures — the loop world, the routed gh/git fakes, the scripted driver
// ---------------------------------------------------------------------------

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

/** Value of a `name=…` argv entry the gh -f/-F flags carry. */
export const flagValue = (args: string[], name: string): string => {
  const entry = args.find((a) => a.startsWith(`${name}=`));
  return entry === undefined ? '' : entry.slice(name.length + 1);
};

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

const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' });

/** The routed gh fake: snapshots, the review-state fetch, replies, resolves. */
const fakeGh =
  (world: LoopWorld, log: string[][]): GhFn =>
  async (args) => {
    log.push(args);
    if (args.includes('graphql')) {
      const query = flagValue(args, 'query');
      if (query.includes('resolveReviewThread')) {
        // The fake echoes the REQUESTED thread and fails loudly on a
        // missing or unexpected one — a resolve can only ever target a
        // thread the world actually served.
        const threadId = flagValue(args, 'threadId');
        const known = world.threads.flatMap((node) =>
          typeof node === 'object' && node !== null && 'id' in node
            ? [String((node as { id: unknown }).id)]
            : [],
        );
        if (threadId === '' || !known.includes(threadId)) {
          return {
            code: 1,
            stdout: '',
            stderr: `fake gh: resolveReviewThread for unexpected threadId ${JSON.stringify(threadId)}`,
          };
        }
        // The pending-resolve carry pin (codex P2): run 1 refuses the
        // resolve so it stays unrecorded behind a posted reply.
        if (world.resolveReviewThreadFails === true) {
          return { code: 1, stdout: '', stderr: 'resolve failed (world-driven)' };
        }
        return ok(
          JSON.stringify({
            data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } },
          }),
        );
      }
      if (query.includes('threadsCursor')) {
        return ok(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: world.resolvedThreads,
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          }),
        );
      }
      return ok(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                author: { login: 'prauthor' },
                headRefName: HEAD_REF,
                headRefOid: world.sha,
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: world.threads,
                },
                reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          },
        }),
      );
    }
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    if (path === `repos/${COORDS.owner}/${COORDS.repo}/pulls/${String(COORDS.pr)}`) {
      return ok(JSON.stringify({ head: { sha: world.laggingOrigin ? BEFORE_SHA : world.sha } }));
    }
    if (
      path.startsWith(`repos/${COORDS.owner}/${COORDS.repo}/pulls/${String(COORDS.pr)}/reviews`)
    ) {
      return ok('[]');
    }
    if (path.startsWith(`repos/${COORDS.owner}/${COORDS.repo}/pulls/${String(COORDS.pr)}/`)) {
      return ok(JSON.stringify(world.pullsComments));
    }
    if (path.startsWith(`repos/${COORDS.owner}/${COORDS.repo}/issues/${String(COORDS.pr)}/`)) {
      return ok(JSON.stringify(world.issueComments));
    }
    return { code: 1, stdout: '', stderr: `unexpected gh argv: ${args.join(' ')}` };
  };

/** The routed git fake: prWorktree's model (a reusable on-label tree) + pushes. */
/**
 * The worktree tree the fake git serves by default (path → line count): the
 * three anchored files, an empty file, and a huge one (-1: over the
 * evidence size bound, never meant to be read).
 */
export const DEFAULT_WORLD_FILES: Record<string, number> = {
  'src/a.ts': 20,
  'src/b.ts': 20,
  'src/c.ts': 20,
  'src/empty.ts': 0,
  'src/huge.ts': -1,
};

export const fakeGit = (world: LoopWorld, log: string[][], worktreePath: string): GhFn => {
  /** The tree at `<sha>:<path>`'s sha: a per-commit override, else the world's files. */
  const treeAt = (object: string): Record<string, number> =>
    world.filesAt?.[object.slice(0, 40)] ?? world.files ?? DEFAULT_WORLD_FILES;
  let pushCount = 0;
  let worktreeHeadReads = 0;
  return async (args) => {
    log.push(args);
    // prWorktree composes every git argv with a leading '-C <path>' — the
    // subcommand starts at index 2 in that form, at 0 without it.
    const rest = args[0] === '-C' ? args.slice(2) : args;
    if (rest[0] === 'rev-parse' && rest[1] === '--absolute-git-dir') {
      return ok('/fake/git-dir\n');
    }
    if (rest[0] === 'fetch' && rest[1] === 'origin') {
      return ok('');
    }
    if (rest[0] === 'rev-parse' && (rest[1] ?? '').startsWith('refs/cq-review/pr-')) {
      return ok(
        `${world.worktreeHead ?? (world.worktreeFollowsOrigin === true ? world.sha : SHA)}\n`,
      );
    }
    // The per-item resolve gate's mechanical checks (finding 2): a sha is
    // verifiable exactly when the world knows it.
    if (rest[0] === 'rev-parse' && rest[1] === '--verify') {
      if (rest[2] === 'HEAD^{commit}')
        return ok(
          `${world.executionHead ?? world.worktreeHead ?? (world.worktreeFollowsOrigin ? world.sha : SHA)}\n`,
        );
      const sha = (rest[2] ?? '').replace(/\^\{commit\}$/, '');
      if (world.knownShas.includes(sha)) {
        return ok(`${sha}\n`);
      }
      return { code: 128, stdout: '', stderr: `fatal: Needed a single revision: ${sha}` };
    }
    if (rest[0] === 'merge-base' && rest[1] === '--is-ancestor') {
      const from = rest[2] ?? '';
      const to = rest[3] ?? '';
      // The not-ancestor stage driver (round-2 low): a declared sha's
      // HEAD-ancestry is refused before the permissive pass conditions.
      if (world.ancestorFails !== undefined && world.ancestorFails.includes(from)) {
        return { code: 128, stdout: '', stderr: 'fatal: not an ancestor relation in this world' };
      }
      // Two-ref ancestry: 0 when (a) FROM is a served origin head (either —
      // the stage-5 publish may already have moved it; SHA too, since
      // resolvePrWorktree fetched it — the observed base, codex P2) and TO
      // is a known new commit (the strict-descendant check), or (b) FROM is
      // a known new commit and TO is HEAD (the pushed-head check).
      const servedHead = from === BEFORE_SHA || from === AFTER_SHA || from === SHA;
      const descendantOfHead = servedHead && world.knownShas.includes(to);
      const inPushedHead = world.knownShas.includes(from) && to === 'HEAD';
      if (descendantOfHead || inPushedHead) {
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 128, stdout: '', stderr: 'fatal: not an ancestor relation in this world' };
    }
    if (rest[0] === 'rev-list') {
      // The loop's range accountability (round 2): `rev-list <before>..HEAD`
      // lists the commits the fix run added — the world declares them
      // (default: the advanced tip alone). prWorktree's `rev-list --count`
      // guard never runs in these worlds (the reuse path skips it). When
      // revListByBase is set, the answer keys on the BASE the loop passes
      // (the stale-snapshot pin, codex P2).
      if (world.revListByBase !== undefined) {
        const base = (rest[1] ?? '').replace(/\.\.HEAD$/, '');
        const shas = world.revListByBase[base] ?? [];
        return ok(`${shas.join('\n')}${shas.length > 0 ? '\n' : ''}`);
      }
      const advanced = world.worktreeAdvancesAt !== undefined;
      const shas = advanced
        ? (world.revListShas ?? [world.worktreeAdvancesTo ?? '4444'.repeat(10)])
        : [];
      return ok(`${shas.join('\n')}${shas.length > 0 ? '\n' : ''}`);
    }
    if (rest[0] === 'diff' && rest[1] === '--quiet') {
      return { code: world.diffCode ?? 1, stdout: '', stderr: '' };
    }
    if (rest[0] === 'log' && rest[1] === '-1') {
      // Per-item attribution (round-3 finding 3): the commit message the
      // world carries for this sha.
      return ok(world.commitMessages[rest[3] ?? ''] ?? '');
    }
    if (rest[0] === 'worktree' && rest[1] === 'list') {
      return ok(`worktree ${worktreePath}\nHEAD ${SHA}\nbranch refs/heads/${LABEL}\n\n`);
    }
    if (rest[0] === 'rev-parse' && rest[1] === '--abbrev-ref') {
      return ok(`${LABEL}\n`);
    }
    if (rest[0] === 'rev-parse' && rest[1] === 'HEAD') {
      if (args[1] === worktreePath) {
        // The loop's per-stage worktree HEAD reads (slice 9 item 2): the
        // head advances after the configured read count. Reads after
        // headReadFailsAfter FAIL, as does the single headReadFailsAt read
        // (round 3 + final bot slice P1: drives the fail-closed
        // head-unreadable gate for both its shapes).
        worktreeHeadReads += 1;
        if (
          (world.headReadFailsAfter !== undefined &&
            worktreeHeadReads > world.headReadFailsAfter) ||
          world.headReadFailsAt === worktreeHeadReads
        ) {
          return { code: 128, stdout: '', stderr: 'fatal: unreadable HEAD' };
        }
        const advanced =
          world.worktreeAdvancesAt !== undefined && worktreeHeadReads > world.worktreeAdvancesAt;
        const base = world.worktreeHead ?? (world.worktreeFollowsOrigin === true ? world.sha : SHA);
        return ok(`${advanced ? (world.worktreeAdvancesTo ?? '4444'.repeat(10)) : base}\n`);
      }
      return ok(`${SHA}\n`);
    }
    if (rest[0] === 'status' && rest[1] === '--porcelain') {
      return world.dirty === true ? ok(' M src/a.ts\n') : ok('');
    }
    if (rest[0] === 'cat-file' && rest[1] === '-s' && /^[0-9a-f]{40}:/.test(rest[2] ?? '')) {
      const lines = treeAt(rest[2] ?? '')[(rest[2] ?? '').slice(41)];
      // Each served line is 'line N\n': about 8 bytes; -1 marks a huge blob.
      return lines === undefined
        ? { code: 128, stdout: '', stderr: 'fatal: not a valid object\n' }
        : ok(`${String(lines < 0 ? 10_000_000 : lines * 8)}\n`);
    }
    if (rest[0] === 'cat-file' && rest[1] === '-t' && /^[0-9a-f]{40}:/.test(rest[2] ?? '')) {
      const path = (rest[2] ?? '').slice(41);
      const files = Object.keys(treeAt(rest[2] ?? ''));
      return files.includes(path)
        ? ok('blob\n')
        : files.some((file) => file.startsWith(`${path}/`))
          ? ok('tree\n')
          : { code: 128, stdout: '', stderr: `fatal: path '${path}' does not exist\n` };
    }
    if (rest[0] === 'show' && /^[0-9a-f]{40}:/.test(rest[1] ?? '')) {
      const path = (rest[1] ?? '').slice(41);
      const files = treeAt(rest[1] ?? '');
      const lines = files[path];
      const entries = Object.keys(files).filter((file) => file.startsWith(`${path}/`));
      // Like git: showing a TREE succeeds and lists its entries.
      if (lines === undefined && entries.length > 0) {
        return ok(
          `tree ${rest[1] ?? ''}\n\n${entries.map((file) => file.slice(path.length + 1)).join('\n')}\n`,
        );
      }
      return lines === undefined
        ? { code: 128, stdout: '', stderr: `fatal: path '${path}' does not exist\n` }
        : lines <= 0
          ? ok('')
          : ok(Array.from({ length: lines }, (_, i) => `line ${String(i + 1)}`).join('\n') + '\n');
    }
    if (rest[0] === 'push') {
      pushCount += 1;
      if (world.pushFailAt !== undefined && pushCount >= world.pushFailAt) {
        return { code: 1, stdout: '', stderr: 'fatal: remote rejected the push\n' };
      }
      // KEYED (finding 1): only a push of the PR's REAL head moves the
      // served origin state — a push of the internal cq-review label must
      // NOT (a stray label branch and a phantom progress signal).
      if (world.advanceOnPush && rest[2] === `HEAD:${HEAD_REF}`) {
        world.sha = AFTER_SHA;
      }
      return ok('');
    }
    return { code: 1, stdout: '', stderr: `unexpected git argv: ${args.join(' ')}` };
  };
};

/** An unsynchronized in-memory WorktreeRegistry (single-threaded tests). */
const memoryRegistry = (): WorktreeRegistry => {
  let map: RegistryMap = {};
  return {
    load: async () => ({ ...map }),
    save: async (next) => {
      map = { ...next };
    },
    update: async (key, entry) => {
      const next = { ...map };
      if (entry === null) {
        delete next[key];
      } else {
        next[key] = entry;
      }
      map = next;
    },
    withLock: async (fn) => fn(),
  };
};

/** A 'complete' WorkerResult whose structuredOutput is a single JSON line. */
export const completeWorker = (line: string, extra?: Partial<WorkerResult>): WorkerResult => ({
  structuredOutput: line,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  denials: [],
  stopReason: 'complete',
  model: 'test-model',
  ...extra,
});

/** The single-line JSON contract a compliant worker answers with. */
/**
 * One v2 fix contract line (THE FIX OUTCOME CONTRACT): a change is `fixed`;
 * no change is `unchanged_with_reason` citing `src/a.ts:3` unless `evidence`
 * says otherwise.
 */
export const fixLine = (
  changed: boolean,
  summary: string,
  commits: string[],
  evidence: Array<{ path: string; line: number }> = changed ? [] : [{ path: 'src/a.ts', line: 3 }],
): string =>
  JSON.stringify({
    disposition: changed ? 'fixed' : 'unchanged_with_reason',
    summary,
    commits,
    evidence,
  });

/** A v2 contract line with an explicit disposition (no commits). */
export const dispositionLine = (disposition: string, summary: string): string =>
  JSON.stringify({ disposition, summary, commits: [], evidence: [] });

/** The LEGACY v1 shape `{changed, summary, commits}`: free text, no disposition. */
export const legacyFixLine = (changed: boolean, summary: string, commits: string[]): string =>
  JSON.stringify({ changed, summary, commits });

// ---------------------------------------------------------------------------
// The loop runner: fresh scratch, scripted driver, wired seams
// ---------------------------------------------------------------------------

export const scratchDirs: string[] = [];
afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

/** Run the loop over a world with a scripted driver; record every argv. */
export const runLoop = async (
  world: LoopWorld,
  o: {
    driverResults?: WorkerResult[];
    ghLog?: string[][];
    gitLog?: string[][];
    invocations?: OpInvocation[];
    headRepo?: string;
    expectedHead?: string;
    dispatchLogPath?: string;
    promptOverride?: string;
    /** Governor LIMITS half riding the loop opts (the review-path #137 arming). */
    limits?: { perJobWallClockMs?: number };
    /** RunOptions overlay for the fix run (journalDir is the ledger dir). */
    runOptions?: { journalDir?: string; maxUsd?: number; maxTokens?: number };
    /** Governance opt-ins for the fix run (the ledger-refusal resolutions). */
    governanceOptIn?: GovernanceOptIn[];
    /** Full driver.run override (the wall-clock test's cooperating wedge). */
    driverRun?: Driver['run'];
    signal?: AbortSignal;
    gitHook?: (args: string[], run: GhFn) => ReturnType<GhFn>;
    ghHook?: (args: string[], run: GhFn) => ReturnType<GhFn>;
    /** Propagated-spend observer (review-debt #186). */
    onSpend?: (usd: number) => void;
    /** The loop's own identity (the settle gate's resolve-carry authorization). */
    responderLogin?: string;
    engineObservedHead?: string;
    /** Explicit publication opt-in (the composition passes `input.push === true`). */
    publish?: boolean;
  } = {},
): Promise<{
  outcome: ReviewLoopOutcome;
  ghLog: string[][];
  gitLog: string[][];
  worktreePath: string;
}> => {
  const scratch = await mkdtemp(join(tmpdir(), 'cq-review-loop-'));
  scratchDirs.push(scratch);
  const worktreePath = join(scratch, 'pr-7-pr-7-fix');
  const ghLog = o.ghLog ?? [];
  const gitLog = o.gitLog ?? [];
  world.executionHead ??= world.worktreeHead ?? (world.worktreeFollowsOrigin ? world.sha : SHA);
  const driver: Driver = {
    run:
      o.driverRun ??
      (async (invocation) => {
        o.invocations?.push(invocation);
        const next = o.driverResults?.shift();
        if (next === undefined) {
          throw new Error('scripted driver: no scripted result left');
        }
        if (
          world.worktreeAdvancesAt !== undefined &&
          String(next.structuredOutput).includes('"disposition":"fixed"')
        )
          world.executionHead = world.worktreeAdvancesTo ?? SHA;
        return next;
      }),
  };
  // The fix op dispatches through a registry view whose review.fixItem binds
  // a factory resolving to the scripted Driver (ADR-0002 §2.5) — the same
  // governed runPlan seam the CLI uses.
  const view: OpRegistryView = {
    get: (name) =>
      name === 'review.fixItem'
        ? ({
            name: 'review.fixItem',
            inputSchema: FixReviewItemInputSchema,
            importer: async () => {
              const op = makeFixReviewItem({
                drivers: {
                  resolve: (req) => ({ driver, lane: 'ai-sdk', modelSpec: req.modelSpec }),
                },
              });
              return async (input: FixReviewItemInput) => {
                const result = await op(input);
                return result.status === 'ok' && o.engineObservedHead !== undefined
                  ? { ...result, value: { ...result.value, observedHead: o.engineObservedHead } }
                  : result;
              };
            },
          } as unknown as OpRegistryEntry<never, never>)
        : undefined,
  };
  const gitRunner = fakeGit(world, gitLog, worktreePath);
  const ghRunner = fakeGh(world, ghLog);
  const outcome = await runReviewLoop({
    owner: COORDS.owner,
    repo: COORDS.repo,
    pr: COORDS.pr,
    headRefName: HEAD_REF,
    ...(o.headRepo !== undefined ? { headRepo: o.headRepo } : {}),
    repoRoot: '/fake/repo',
    ...(o.expectedHead ? { expectedHead: o.expectedHead } : {}),
    gh: o.ghHook ? (args) => o.ghHook!(args, ghRunner) : ghRunner,
    git: (args) =>
      args.slice(2).join(' ') === 'rev-parse --path-format=absolute --git-common-dir'
        ? Promise.resolve({ code: 0, stdout: `${scratch}\n`, stderr: '' })
        : o.gitHook
          ? o.gitHook(args, gitRunner)
          : gitRunner(args),
    ...(o.signal ? { signal: o.signal } : {}),
    registry: memoryRegistry(),
    driver: { model: 'test-model', provider: 'test-provider' },
    driverRegistryView: view,
    ...(o.engineObservedHead !== undefined ? { engineOwnedConcurrency: 1 } : {}),
    // The A12c escape is EXPLICIT and defaults OFF (r1 M4): these tests
    // exercise dispatched fix runs, so they opt in — the shipped sweep does
    // the same (unattended by design), and the journal records
    // allowAdvisoryProvenance: 'product'.
    allowAdvisoryBudget: true,
    // Legacy tests rely on `publish` being ABSENT (the loop's historical
    // publishable default, `opts.publish !== false`); only an explicit
    // opt-in mirrors the composition's `input.push === true` shape.
    ...(o.publish !== undefined ? { publish: o.publish } : {}),
    nowMs: NOW,
    dispatchLogPath: o.dispatchLogPath ?? join(scratch, 'dispatch.jsonl'),
    worktreeRoot: scratch,
    ...(o.promptOverride !== undefined ? { promptOverride: o.promptOverride } : {}),
    ...(o.limits !== undefined ? { limits: o.limits } : {}),
    ...(o.runOptions !== undefined ? { runOptions: o.runOptions } : {}),
    ...(o.governanceOptIn !== undefined ? { governanceOptIn: o.governanceOptIn } : {}),
    ...(o.onSpend !== undefined ? { onSpend: o.onSpend } : {}),
    ...(o.responderLogin !== undefined ? { responderLogin: o.responderLogin } : {}),
  });
  return { outcome, ghLog, gitLog, worktreePath };
};

/** Count of recorded git push invocations. */
export const gitLogPushes = (gitLog: string[][]): number =>
  gitLog.filter((args) => args[2] === 'push').length;

/** Gh mutation argv: a REST POST or the resolveReviewThread graphql mutation. */
export const isGhMutation = (args: string[]): boolean => {
  if (args.includes('-X')) {
    return true;
  }
  return flagValue(args, 'query').includes('resolveReviewThread');
};

/** Indexes of the PR-object reads — snapshotPrState always starts there. */
export const prReadIndexes = (ghLog: string[][]): number[] =>
  ghLog
    .map((args, index) =>
      args[0] === 'api' &&
      args[1] === `repos/${COORDS.owner}/${COORDS.repo}/pulls/${String(COORDS.pr)}`
        ? index
        : -1,
    )
    .filter((index) => index >= 0);

export const firstMutationIndex = (ghLog: string[][]): number =>
  ghLog.findIndex((args) => isGhMutation(args));

/** The composed worktree push argv the loop must use (clarified pattern). */
export const expectedPushArgs = (worktreePath: string, target = 'origin'): string[] => [
  '-C',
  worktreePath,
  'push',
  target,
  `HEAD:${HEAD_REF}`,
];

// ---------------------------------------------------------------------------
// Shared helpers of the settle-gate suite (reproduced describe wrappers live
// in review-loop.settle-gate.test.ts and review-loop.settle-outcomes.test.ts).
// ---------------------------------------------------------------------------

export const settleWorld = (): LoopWorld => ({ ...defaultWorld(), worktreeFollowsOrigin: true });
/** A world whose fix run publishes: the worktree advances to SHA after the pre-fix read. */
export const publishedWorld = (): LoopWorld => ({
  ...settleWorld(),
  worktreeAdvancesAt: 2,
  worktreeAdvancesTo: SHA,
  revListShas: [NEW_SHA],
});
export const LOOP_LOGIN = 'cq-automation[bot]';
export const SIG = '<!-- cq-review-loop:octo/widget#7 -->';
export const OLD_HEAD = 'f40e01550df09310707247bd2cb97b0ac79a5d1b';
export const DISPOSITION = 'Already satisfied: src/a.ts line 3 already guards the case.';
export const reply = (
  body: string,
  createdAt: string | null = iso(REPLY_AGE),
  authorLogin: string = LOOP_LOGIN,
) => ({ authorLogin, body, createdAt });
export const postedBodies = (ghLog: string[][]): string[] =>
  ghLog.filter((args) => args.includes('-X')).map((args) => flagValue(args, 'body'));
export const postedKinds = (outcome: ReviewLoopOutcome): string[] =>
  outcome.reply?.posted.map((record) => record.kind) ?? [];
export const root = () => restComment(101, 'reviewer', 'Fix src/a.ts at 3.', iso(ROOT_AGE), null);
export const loopReply = (body: string, id = 9001, login = LOOP_LOGIN) =>
  restComment(id, login, body, iso(REPLY_AGE), 101);
/** Run 1 over T1 with no replies: the loop posts one answer; returns its body. */
export const answerOnce = async (summary = DISPOSITION): Promise<string> => {
  const world = settleWorld();
  world.pullsComments = [root()];
  const ghLog: string[][] = [];
  const { outcome } = await runLoop(world, {
    driverResults: [completeWorker(fixLine(false, summary, []))],
    ghLog,
  });
  expect(outcome.actionsPosted).toBe(1);
  return postedBodies(ghLog)[0] ?? '';
};
