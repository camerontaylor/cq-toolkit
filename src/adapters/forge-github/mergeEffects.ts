// effects — the injectable git/gh mutation seam for the merge executor
// (goal F3, ws-f scope item 3; UC §3 row 43).
//
// THE LOAD-BEARING DESIGN POINT (UC row 43, carried as a requirement): every
// git/gh mutation the executor can perform lives behind ONE interface,
// MergeEffects — and `executeMerges` takes an instance as INPUT. A test
// therefore exercises the whole merge flow through a FakeMergeEffects that
// implements eight async methods in memory: ZERO real git/gh processes,
// zero networks, zero filesystems. The production implementation
// (realMergeEffects) is just one more implementor of the same interface.
//
// I3 — MERGE COMMITS ONLY. The executor may never squash, force, rebase,
// hard-reset, amend, or push to the protected branch, whatever calls it.
// The guard is `safeArgs` — an ALLOWLIST (round 2): only the eight argv
// shapes this family documents may execute (see the safeArgs doc); any
// other argv is refused as an unknown shape before any process can spawn,
// and the push shape itself refuses force markers, bare/symbolic
// refspecs, and protected-branch destinations (configurable via
// `protectedBranch`, default `main`). realMergeEffects routes EVERY argv —
// reads included — through safeArgs via `safeRunner`, the single I3
// enforcement point; the negative tests prove the guard shape by shape.
//
// TRANSPORT: the same GhFn pattern as ../review/gh.js — a thin
// `(args) => Promise<GhResult>` seam that RESOLVES with the exit code
// instead of throwing on nonzero, so each effect implements its own
// fail-closed policy. GhResult (and GhFn for the runner overrides) are
// imported type-only; makeGhRunner provides the real spawn behavior with
// the bin configurable per opts. No new dependencies.
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { HARDENED_DIFF_FLAGS } from '../../shared/gitHarden.js';
import type { GhFn, GhResult } from './gh.js';
import { makeGhRunner } from './gh.js';

/**
 * The PR head ref every merge-flow effect addresses the PR by (the
 * prWorktree doctrine carried over: `refs/pull/<pr>/head` is TRUTH — it
 * exists for every PR, fork or same-repo alike, so the executor — which
 * knows only PR numbers, the plan carries no branch names — never depends
 * on a local branch label).
 */
export const headRefFor = (pr: number): string => `refs/pull/${pr}/head`;

/**
 * Thrown by safeArgs BEFORE anything executes when an argv attempts a
 * mutation I3 forbids. Carries the rejected argv and the reason — the
 * negative tests assert on this class.
 */
export class UnsafeMergeArgsError extends Error {
  /** The argv that was refused, verbatim. */
  readonly args: readonly string[];

  constructor(args: readonly string[], why: string) {
    const argv = args.map((arg) => JSON.stringify(arg)).join(' ');
    super(`unsafe argv refused by I3 (merge commits only): ${why} — argv: ${argv}`);
    this.name = 'UnsafeMergeArgsError';
    this.args = args;
  }
}

/** The destination half of a refspec (`[+]<src>[:<dst>]` — no colon means
 * the source doubles as the destination). */
const pushDestination = (refspec: string): string => {
  const colon = refspec.indexOf(':');
  return colon === -1 ? refspec : refspec.slice(colon + 1);
};

/** The branch I3 protects by default: the base branch a merge queue never
 * pushes to. Callers queueing on a differently named trunk pass their own
 * `protectedBranch` (CR-5). */
export const DEFAULT_PROTECTED_BRANCH = 'main';

/** Options for the I3 guard's configurable side. */
export interface SafeArgsOpts {
  /** The branch pushes may never land on, under either spelling; default
   * DEFAULT_PROTECTED_BRANCH ('main'). */
  protectedBranch?: string;
}

/** True when `ref` is the protected branch under EITHER spelling — the bare
 * branch name or its `refs/heads/<branch>` form (the two shapes a push
 * refspec destination takes). */
const isProtectedRef = (ref: string, protectedBranch: string): boolean =>
  ref === protectedBranch || ref === `refs/heads/${protectedBranch}`;

/**
 * THE I3 GUARD — AN ALLOWLIST (round 2): only the argv shapes this family
 * documents may execute; EVERYTHING ELSE is refused with
 * `refused: unknown argv shape`, so an undocumented mutation cannot ride
 * the guard through however innocuous its tokens look. The eight shapes
 * (after the `-C <path>` prefix is stripped):
 *   rev-parse <flags/ref>…                    — ref resolution (≥1 arg)
 *   fetch <remote> <refspec>…                 — refspecs may carry the '+'
 *       in-place marker, but a ':'-refspec whose (+-stripped) DESTINATION
 *       names the protected branch is a forced update of that branch —
 *       refused; colon-less refspecs land in FETCH_HEAD only and cannot
 *       move a branch, so they need no destination check
 *   worktree add -B <label> <path> <ref>      — the exact prepare shape
 *   worktree list|remove <arg>…               — rough arity, FLAG-FREE
 *       (round 3: the documented shapes carry no flags, so `worktree
 *       remove --force <path>` is refused — the real impl deliberately
 *       omits --force)
 *   push --no-follow-tags <remote> <src:dst>  — the EXACT hardened shape
 *       (review P1 p522, PR #1641): the flag pins push.followTags OFF (a
 *       repo/user config could otherwise publish annotated tags — and a
 *       credential in a tag annotation bypasses every scan), an EXPLICIT
 *       src:dst refspec is required with BOTH halves non-empty (`:dst`
 *       deletes a remote branch — refused), no '+' force marker (I3
 *       forbids force, period), NO flag beyond the hardened prefix
 *       (`--force` cannot follow it), and the destination must not be the
 *       protected branch. The flag-less historical shape is refused.
 *   gh pr merge <n> --merge [--match-head-commit <sha>]  — the ONLY merge
 *       method (I3); the head-commit pin is allowed only as a 40-hex sha
 *       (review-debt #186)
 *   gh pr edit <n> --base <base>              — the retarget
 *   gh pr view <n> --json baseRefName         — the base-ref read
 *       (review-debt #193; the read-only forge-metadata probe)
 *   diff <HARDENED_DIFF_FLAGS> --unified=0 <sha> <sha>
 *                                             — the READ-ONLY patch read
 *       (issue #1193: the conflict resolver's pre-push denylist scan).
 *       The hardened flags (shared/gitHarden.ts) disable the
 *       repository-configured diff drivers/textconv a hostile
 *       .gitattributes could select to hide content (review P1, PR
 *       #1628), force binary content to be diffed as text, and pin the
 *       a/ b/ header prefixes. EXACT arity: the pinned flag list, then
 *       both endpoints as FULL 40-hex commit shas — the gate derives
 *       them from validateRef answers, never from plan or agent input,
 *       so no refname or revision expression can ride this shape (a
 *       short sha, a range, or any other flag is refused as an unknown
 *       shape).
 * opts.protectedBranch (default 'main') names the branch pushes may never
 * land on, under either spelling.
 */
export function safeArgs(args: readonly string[], opts: SafeArgsOpts = {}): readonly string[] {
  const protectedBranch = opts.protectedBranch ?? DEFAULT_PROTECTED_BRANCH;
  let rest = args;
  if (rest[0] === '-C') {
    rest = rest.slice(2);
  }
  const unknown = (): UnsafeMergeArgsError =>
    new UnsafeMergeArgsError(
      args,
      'refused: unknown argv shape — the merge family executes only its documented shapes (rev-parse, rev-list, merge-base, log, cat-file, fetch, worktree add/list/remove, push, gh pr merge, gh pr edit, gh pr view, diff)',
    );
  const sub = rest[0];
  switch (sub) {
    case 'rev-parse':
      if (rest.length < 2) throw unknown();
      return args;
    case 'rev-list': {
      // The topology read (review P1, PR #1628 round 2): the publication
      // gate must prove the resolution is EXACTLY ONE commit whose sole
      // parent is the validated baseline before the endpoint diff means
      // anything. EXACT shape: `rev-list --parents -n 1 <40hex>` — the
      // one queried sha is validateRef-derived, read-only, arity-pinned.
      const tail = rest.slice(1);
      if (
        tail.length !== 4 ||
        tail[0] !== '--parents' ||
        tail[1] !== '-n' ||
        tail[2] !== '1' ||
        !/^[0-9a-f]{40}$/i.test(tail[3] ?? '')
      ) {
        throw unknown();
      }
      return args;
    }
    case 'fetch': {
      const tail = rest.slice(1);
      if (tail.length < 2) throw unknown(); // remote + ≥1 refspec
      for (const refspec of tail.slice(1)) {
        if (refspec.includes(':')) {
          const dst = pushDestination(refspec.replace(/^\+/, ''));
          if (isProtectedRef(dst, protectedBranch)) {
            throw new UnsafeMergeArgsError(
              args,
              `fetch refspec ${JSON.stringify(refspec)} would force-update the protected branch ${JSON.stringify(dst)}`,
            );
          }
        }
      }
      return args;
    }
    case 'worktree': {
      const verb = rest[1];
      if (verb !== 'add' && verb !== 'list' && verb !== 'remove') throw unknown();
      if (verb === 'add') {
        // The exact prepare shape the family builds: -B <label> <path> <ref>.
        if (rest.length !== 6 || rest[2] !== '-B') throw unknown();
      } else {
        if (rest.length < 3) throw unknown();
        // list/remove are FLAG-FREE (round 3): the documented shapes carry
        // no flags, so `worktree remove --force <path>` (silent destruction
        // the real impl deliberately omits) is refused like any other
        // undocumented token.
        for (const arg of rest.slice(2)) {
          if (arg.startsWith('-')) {
            throw new UnsafeMergeArgsError(
              args,
              `flags are not part of the documented worktree ${verb} shape — refused ${JSON.stringify(arg)}`,
            );
          }
        }
      }
      return args;
    }
    case 'push': {
      const tail = rest.slice(1);
      // EXACTLY TWO FLAGS, FIRST (review P1 p522 + P2 rw4S, PR #1641):
      // the push must lead with --no-follow-tags AND
      // --recurse-submodules=no. --no-follow-tags stops `push.followTags`
      // publishing annotated tags alongside the explicit refspec;
      // --recurse-submodules=no stops `push.recurseSubmodules=only` from
      // exiting 0 with the superproject UNPUSHED and stops on-demand
      // recursion publishing unscanned submodule commits. The flag-less
      // historical shape is refused like any other undocumented one, and
      // no THIRD flag can ride (the round-3 rule stands: any further
      // `-`-prefixed token is refused on sight — `--force` cannot follow
      // the hardened prefix).
      if (tail[0] !== '--no-follow-tags' || tail[1] !== '--recurse-submodules=no') {
        throw new UnsafeMergeArgsError(
          args,
          `the push shape must lead with --no-follow-tags and --recurse-submodules=no (followTags would publish unscanned tags; recurseSubmodules=only can exit 0 WITHOUT pushing the branch) — refused ${JSON.stringify(tail.slice(0, 2))}`,
        );
      }
      for (const arg of tail.slice(2)) {
        if (arg.startsWith('-')) {
          throw new UnsafeMergeArgsError(
            args,
            `flags beyond --no-follow-tags and --recurse-submodules=no are not part of the documented push shape — refused ${JSON.stringify(arg)}`,
          );
        }
      }
      // tail[2] is the REMOTE; the rest are the refspecs. Fewer than
      // four tokens means NO explicit refspec (round 1): push.default
      // would choose the destination — possibly the protected branch.
      if (tail.length < 4) throw unknown();
      for (const refspec of tail.slice(3)) {
        if (refspec.startsWith('+')) {
          // Force-marker bypass, closed (round 2): a '+'-marked PUSH
          // refspec is a force-push — I3 forbids force outright, whatever
          // it names.
          throw new UnsafeMergeArgsError(
            args,
            `force-marked push refspec ${JSON.stringify(refspec)} — I3 forbids force pushes outright`,
          );
        }
        const colon = refspec.indexOf(':');
        if (colon <= 0 || colon === refspec.length - 1) {
          // Round 2 + round 3: an explicit src:dst is required with BOTH
          // halves non-empty — bare/symbolic sources (HEAD, @, upstream
          // shorthand) name no destination, and an EMPTY source (`:dst`)
          // is a REMOTE BRANCH DELETION.
          throw new UnsafeMergeArgsError(
            args,
            `push refspec ${JSON.stringify(refspec)} is not an explicit non-empty src:dst — bare or symbolic refspecs and remote-branch deletions are refused`,
          );
        }
        if (isProtectedRef(pushDestination(refspec), protectedBranch)) {
          throw new UnsafeMergeArgsError(
            args,
            `push with destination ${JSON.stringify(pushDestination(refspec))} — the protected branch ${JSON.stringify(protectedBranch)} is never pushed to`,
          );
        }
      }
      return args;
    }
    case 'diff': {
      // The read-only patch read (issue #1193; review P1 on PR #1628): the
      // EXACT shape is HARDENED_DIFF_FLAGS + --unified=0, then two full
      // 40-hex shas, nothing else. The hardened flags are load-bearing for
      // the gate: --no-ext-diff and --no-textconv disable the
      // repository-configured diff PROGRAMS a hostile .gitattributes could
      // select to substitute harmless text (or empty output) for the real
      // bytes, --text forces binary content to be diffed as text, and the
      // pinned a/ b/ prefixes pin the header shape the scanner's parser
      // keys on. Both endpoints are validateRef-derived shas, so this
      // shape admits no refname, no range expression, and no flag
      // injection; anything else is an undocumented shape like any other.
      const expected = [...HARDENED_DIFF_FLAGS, '--unified=0'];
      const tail = rest.slice(1);
      if (
        tail.length !== expected.length + 2 ||
        expected.some((flag, index) => tail[index] !== flag) ||
        !/^[0-9a-f]{40}$/i.test(tail[expected.length] ?? '') ||
        !/^[0-9a-f]{40}$/i.test(tail[expected.length + 1] ?? '')
      ) {
        throw unknown();
      }
      return args;
    }
    case 'log': {
      // The commit-message read (review P2 ntJt, PR #1628): the gate scans
      // the resolution commit's subject/body before publishing. EXACT
      // shape: `log -1 --encoding=UTF-8 --format=%B <40hex>` — one commit,
      // the raw message, the pinned encoding (review P1 q2-s, PR #1641: a
      // repo's i18n.logOutputEncoding would otherwise emit UTF-16LE and
      // hide an ASCII token from the UTF-8 decoder), one
      // validateRef-derived sha.
      const tail = rest.slice(1);
      // Two shapes, both exact: the message read
      // (`log -1 --encoding=UTF-8 --format=%B <40hex>`) and the
      // declared-encoding read (`log -1 --format=%e <40hex>`, review P1
      // sMLw — a non-UTF-8 commit encoding must be refused, not recoded).
      if (
        (tail.length === 4 &&
          tail[0] === '-1' &&
          tail[1] === '--encoding=UTF-8' &&
          tail[2] === '--format=%B' &&
          /^[0-9a-f]{40}$/i.test(tail[3] ?? '')) ||
        (tail.length === 3 &&
          tail[0] === '-1' &&
          tail[1] === '--format=%e' &&
          /^[0-9a-f]{40}$/i.test(tail[2] ?? ''))
      ) {
        return args;
      }
      throw unknown();
    }
    case 'cat-file': {
      // The object-presence read (review P2 ntJj, PR #1628): before the
      // ancestry read, the gate must know whether the forge's base tip is
      // even LOCAL (the base may have advanced past what the repo has
      // fetched). EXACT shape: `cat-file -e <40hex>`.
      const tail = rest.slice(1);
      if (tail.length !== 2 || tail[0] !== '-e' || !/^[0-9a-f]{40}$/i.test(tail[1] ?? '')) {
        throw unknown();
      }
      return args;
    }
    case 'merge-base': {
      // The ancestry read (review P1 round 3, PR #1628): the publication
      // gate must decide whether a merge resolution's second parent is
      // PUBLIC base history. EXACT shape: `merge-base --is-ancestor
      // <40hex> <40hex>` — both endpoints are the validated merge parent
      // and the forge-read base tip; exit 0 = ancestor, exit 1 = not,
      // anything else = fault.
      const tail = rest.slice(1);
      if (
        tail.length !== 3 ||
        tail[0] !== '--is-ancestor' ||
        !/^[0-9a-f]{40}$/i.test(tail[1] ?? '') ||
        !/^[0-9a-f]{40}$/i.test(tail[2] ?? '')
      ) {
        throw unknown();
      }
      return args;
    }
    case 'pr': {
      // The three gh shapes: the merge (I3's only method, optionally pinned
      // by `--match-head-commit`), the retarget, and the base-ref read
      // (review-debt #193). rest[0] is 'pr' itself — the
      // gh runner's argv starts at the subcommand (the binary is the runner),
      // so skip it. EXACT ARITY: trailing tokens are how --admin/--squash/
      // --delete-branch would ride an otherwise-legal shape past the guard
      // (VB2F batch gate).
      const [, verb, prNum, flag, base] = rest;
      if (
        (rest.length === 4 || rest.length === 6) &&
        verb === 'merge' &&
        typeof prNum === 'string' &&
        /^\d+$/.test(prNum) &&
        flag === '--merge'
      ) {
        if (rest.length === 4) {
          return args;
        }
        const [, , , , , sha] = rest;
        if (
          rest[4] === '--match-head-commit' &&
          typeof sha === 'string' &&
          /^[0-9a-f]{40}$/i.test(sha)
        ) {
          return args;
        }
        throw unknown();
      }
      if (
        rest.length === 5 &&
        verb === 'edit' &&
        typeof prNum === 'string' &&
        /^\d+$/.test(prNum) &&
        flag === '--base' &&
        typeof base === 'string' &&
        base !== ''
      ) {
        return args;
      }
      // The base-ref READ (review-debt #193): `gh pr view <n> --json
      // baseRefName` — EXACT arity, numeric pr, and the ONE json field this
      // family reads. Any other field or trailing token is unknown: the
      // read must not become a vehicle for a broader `gh pr view` surface.
      if (
        rest.length === 5 &&
        verb === 'view' &&
        typeof prNum === 'string' &&
        /^\d+$/.test(prNum) &&
        flag === '--json' &&
        base === 'baseRefName,baseRefOid'
      ) {
        return args;
      }
      throw unknown();
    }
    case undefined:
      throw unknown();
    default:
      throw unknown();
  }
}

/**
 * THE I3 ENFORCEMENT POINT: wrap a command runner so NO argv reaches it
 * until safeArgs passes. realMergeEffects routes BOTH of its runners (git
 * and gh) through this — every argv, reads included — so the production
 * implementation cannot execute a forbidden mutation even if a future argv
 * builder tries. `opts` (protectedBranch) threads straight through to the
 * guard.
 */
export const safeRunner =
  (run: GhFn, opts: SafeArgsOpts = {}): GhFn =>
  (args) =>
    run([...safeArgs(args, opts)]);

/**
 * The effects seam (UC row 43): every git/gh mutation executeMerges can
 * perform, as injectable methods. A fake implementing this interface makes
 * the whole executor testable with zero real processes; realMergeEffects is
 * the production implementor. GhResult resolution (never throwing) follows
 * the GhFn doctrine — each effect's own doc states its failure policy.
 */
export interface MergeEffects {
  /**
   * Resolve a git ref to its current commit. Resolves `{ ok: true, sha }`
   * when the ref names a commit; `{ ok: false }` otherwise (unknown ref,
   * not a commit) — never throws for an unresolvable ref.
   */
  validateRef(ref: string): Promise<{ ok: boolean; sha?: string }>;
  /** Fetch a ref from origin so the local ref reflects remote truth.
   * Resolves with the exit code (GhResult shape); nonzero means the ref's
   * truth is unavailable. */
  fetchRef(ref: string): Promise<GhResult>;
  /**
   * Re-read PR `pr`'s forge base ref — the branch it currently targets
   * AND that branch's current tip commit (`gh pr view <pr> --json
   * baseRefName,baseRefOid` in the real implementation; review-debt
   * #193, tip added for the publication gate's topology proof — review
   * P1 round 3). executeMerges calls it before each MERGE action and
   * compares the answer against the base the plan was built on: a
   * retarget between plan and run moves the base WITHOUT touching the
   * head, so the head-SHA pin alone cannot catch it. Resolves
   * `{ ok: true, baseRefName, baseTipSha? }` when the forge answers with
   * a non-empty ref (`baseTipSha` present only when the forge answered a
   * full 40-hex OID); `{ ok: false }` when the read failed or the
   * payload was unreadable — never throws for a failed read (each caller
   * decides its own fail-closed policy). The gate treats a missing
   * baseTipSha as "the second parent cannot be verified" and refuses.
   */
  readBaseRef(pr: number): Promise<{ ok: boolean; baseRefName?: string; baseTipSha?: string }>;
  /** Prepare a throwaway worktree for the PR's merge flow, checked out at
   * `ref`. Resolves with the worktree path; throws when the worktree cannot
   * be created (a missing tree is not a merge outcome). */
  worktreePrepare(pr: number, ref: string): Promise<{ path: string }>;
  /** Remove a worktree previously prepared. Throws when git refuses (a
   * dirty or locked tree is left in place, loudly); executeMerges pairs
   * every prepare with a remove in a finally and never lets a cleanup
   * failure mask the primary outcome. */
  worktreeRemove(path: string): Promise<void>;
  /** Merge PR `pr` on the forge, `method: 'merge'` EXCLUSIVELY (I3 — the
   * type admits no other method and safeArgs rejects `--squash`/`--rebase`
   * argv regardless). `matchHeadCommit` (review-debt #186) pins the merge to
   * the reviewed head SHA (`gh pr merge --match-head-commit <sha>`): the
   * forge refuses the merge when the head moved between plan and execution,
   * closing the fixer-push race. Resolves with the exit code; executeMerges
   * reads `stderr` to decide bounded-retry eligibility. */
  mergePr(pr: number, opts: { method: 'merge'; matchHeadCommit?: string }): Promise<GhResult>;
  /** Retarget PR `pr` onto `newBase` — the forge base-edit operation
   * (`gh pr edit <pr> --base <newBase>` in the real implementation). This
   * is the retarget-self action's WHOLE body: forge metadata, so it never
   * touches a worktree, never pushes a ref (the read-only
   * `refs/pull/<n>/head` is unpushable — the CR1 regression is pinned by
   * test), and never merges (I3). Resolves with the exit code. */
  retargetBase(pr: number, newBase: string): Promise<GhResult>;
  /** Push the EXPLICIT `src:dst` refspec `ref` from the worktree at
   * `fromPath` (round 2: bare/symbolic refspecs — HEAD, @, upstream
   * shorthand — are refused by the guard, as is any '+' force marker and
   * any protected-branch destination). Resolves with the exit code. SEAM
   * CONSUMER (round 1): NOT this executor — merge entries are server-side
   * and retargets ride retargetBase — but pushRef stays in the interface
   * as a frozen contract for the WS-I merge-prs wiring, its I3 guard
   * pinned by the safeArgs push tests. Issue #1193 makes the conflict
   * RESOLVER the first op-level consumer: the publication push runs
   * through this seam behind the scan gate, never from the worker. */
  pushRef(ref: string, fromPath: string): Promise<GhResult>;
  /**
   * The READ-ONLY zero-context unified patch between two FULL commit shas
   * (issue #1193 — the resolver's pre-push scan input): `git -C <repoRoot>
   * diff <HARDENED_DIFF_FLAGS> --unified=0 <from> <to>` (no external diff
   * driver, no textconv — repository-configured diff programs cannot hide
   * or substitute the bytes the gate must scan; review P1, PR #1628), the
   * patch on stdout.
   * Resolves with the exit code (GhResult shape); nonzero means the patch
   * is UNAVAILABLE and the caller must treat the change as unscannable —
   * never scan a partial patch, never push unscanned. Both endpoints are
   * validateRef-derived shas by contract (the safeArgs shape refuses
   * everything else), so no refname or range expression can reach git.
   */
  diffPatch(from: string, to: string): Promise<GhResult>;
  /**
   * The parent shas of one FULL commit sha (review P1, PR #1628 round 2 —
   * the publication gate's topology proof): `git -C <repoRoot> rev-list
   * --parents -n 1 <sha>`, the queried sha and its parents on stdout.
   * Resolves `{ ok: true, parents }` (the QUERIED sha excluded) when git
   * answered; `{ ok: false }` when the commit is unknown or the read
   * failed — never throws for a failed read (the caller decides its own
   * fail-closed policy). The gate requires exactly one parent equal to
   * the pre-dispatch baseline: a merge commit, a stacked intermediate
   * commit, or a root carries content the baseline..tip endpoint diff
   * never shows.
   */
  commitParents(sha: string): Promise<{ ok: boolean; parents?: string[] }>;
  /**
   * Whether `ancestor` is an ancestor of `descendant` (review P1 round 3
   * — the publication gate's public-history check): `git -C <repoRoot>
   * merge-base --is-ancestor <sha> <sha>`, both endpoints full 40-hex
   * shas behind the safeArgs-pinned shape. Resolves with the exit code:
   * 0 = ancestor, 1 = not an ancestor (both are ANSWERS); any other exit
   * is a fault the caller refuses on.
   */
  isAncestor(ancestor: string, descendant: string): Promise<GhResult>;
  /**
   * The RAW commit message (`git log -1 --encoding=UTF-8 --format=%B
   * <sha>`, review P2 ntJt, encoding P1 q2-s) of one full 40-hex sha
   * behind the safeArgs-pinned shape — the publication gate scans the
   * subject/body with the same denylist rules as the file patch, because
   * a credential in the message rides the push while absent from it. The
   * encoding is PINNED because a repo's i18n.logOutputEncoding can
   * otherwise make the output UTF-16LE and hide ASCII token text from
   * the UTF-8 decoder. Deliberately UNTRUNCATED: a cap would hide a
   * secret placed past it; the caller bounds only what it quotes in
   * errors.
   */
  readCommitMessage(sha: string): Promise<GhResult>;
  /**
   * The commit's DECLARED message encoding header (`git log -1 --format=%e
   * <sha>`, review P1 sMLw, PR #1641): empty when the commit stores UTF-8.
   * --encoding only RE-CODES a message; a commit created under
   * i18n.commitEncoding=UTF-16LE carries that header and its stored bytes
   * may not survive a UTF-8 re-code (the pinned message read can come
   * back empty), so the gate must refuse any declared non-UTF-8 encoding
   * rather than trust the recoded text.
   */
  readCommitEncoding(sha: string): Promise<GhResult>;
  /**
   * Whether one full 40-hex object exists LOCALLY (`git cat-file -e
   * <sha>`, review P2 ntJj): the ancestry read needs the forge's base tip
   * in the local object store, and the base may have advanced past what
   * the repo has fetched. Exit 0 = present; ANY nonzero exit is treated
   * as absent-or-unreadable by the caller (which then fetches and
   * re-checks, refusing if it still cannot read the object).
   */
  objectExists(sha: string): Promise<GhResult>;
  /**
   * Fetch one branch from origin (`git fetch origin <branch>`, a
   * colon-less refspec that lands in FETCH_HEAD only — the existing
   * safeArgs fetch shape already admits exactly this, and the branch name
   * is the schema-gated conservative refname from the op input, never
   * forge text). Used by the publication gate to bring a not-yet-local
   * forge base tip into the object store before the ancestry read.
   */
  fetchBaseBranch(branch: string): Promise<GhResult>;
}

/**
 * The merge family's per-pr worktree BRANCH LABEL (`worktree add -B`
 * checks the prepared worktree out ON this branch, so after the conflict
 * agent commits its resolution the branch — shared through the repo's
 * common refs — names the resolution commit). {@link realMergeEffects}
 * prepares with this label; {@link mergeWorktreeBranchFor} is its full-ref
 * form for rev-parse and refspecs. One source for both, so they cannot
 * drift (issue #1193).
 */
export const mergeWorktreeBranchLabel = (pr: number): string => `cq-merge/pr-${String(pr)}`;

/**
 * The full ref of the merge family's per-pr worktree branch (issue
 * #1193): resolvable from the repo ROOT (the refs store is shared across
 * linked worktrees), so the conflict resolver reads the resolved change
 * and builds its publication refspec from a ref IT derived — never from
 * agent output.
 */
export const mergeWorktreeBranchFor = (pr: number): string =>
  `refs/heads/${mergeWorktreeBranchLabel(pr)}`;

/**
 * THE WORKTREE LIFECYCLE HELPER (round 1, for F4's conflict resolver): the
 * merge EXECUTOR no longer touches worktrees (gh pr merge is server-side —
 * see executeMerges rule f), but the resolver will need a tree. This is the
 * seam's prepare → fn → remove-in-finally pairing, tested once HERE so the
 * lifecycle cannot drift:
 *   - worktreePrepare throws → the error PROPAGATES untouched; fn never
 *     runs and worktreeRemove never runs (nothing was prepared — there is
 *     nothing to remove).
 *   - fn throws → worktreeRemove STILL runs (finally); the ORIGINAL error
 *     object is rethrown — never replaced — with a removal failure APPENDED
 *     to its message when the remove also failed (the primary failure is
 *     never masked). A non-Error throwable is rethrown as-is.
 *   - fn resolves → worktreeRemove runs; a removal failure never rejects
 *     (the caller's successful result is never masked) — a wedged tree
 *     surfaces loudly at the next prepare.
 */
export async function withPreparedWorktree<T>(
  effects: MergeEffects,
  pr: number,
  ref: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const prepared = await effects.worktreePrepare(pr, ref);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  try {
    outcome = { ok: true, value: await fn(prepared.path) };
  } catch (err) {
    outcome = { ok: false, error: err };
  } finally {
    try {
      await effects.worktreeRemove(prepared.path);
    } catch (removeErr) {
      if (outcome !== undefined && !outcome.ok && outcome.error instanceof Error) {
        const why = removeErr instanceof Error ? removeErr.message : String(removeErr);
        outcome.error.message = `${outcome.error.message}; worktreeRemove ${prepared.path} also failed: ${why}`;
      }
    }
  }
  if (outcome !== undefined && outcome.ok) {
    return outcome.value;
  }
  if (outcome !== undefined) {
    throw outcome.error;
  }
  // Unreachable: the try/catch above always records an outcome.
  throw new Error('withPreparedWorktree: no outcome recorded');
}

/** Options for realMergeEffects — the bins and repo root are configuration
 * at the call site; the runner overrides are the test seams (the same GhFn
 * pattern as review/gh.ts: tests substitute a recording fake, zero real
 * processes, while the guard wiring stays identical). */
export interface RealMergeEffectsOpts {
  /** The checked-out repository every git invocation targets (-C). */
  repoRoot: string;
  /** The git binary; default 'git'. */
  gitBin?: string;
  /** The gh binary; default CQ_GH_BIN, else 'gh' (makeGhRunner's seam). */
  ghBin?: string;
  /** The branch pushes may never land on (I3, either spelling); default
   * 'main' — configuration at the call site, never a hardcoded trunk name
   * (CR-5). */
  protectedBranch?: string;
  /** Per-invocation wall-clock bound handed to makeGhRunner. */
  timeoutMs?: number;
  /** Gh-runner override (test seam) — wrapped in safeRunner like the real one. */
  run?: GhFn;
  /** Git-runner override (test seam) — wrapped in safeRunner like the real one. */
  gitRun?: GhFn;
}

/**
 * The PRODUCTION MergeEffects: real git and gh via the makeGhRunner spawn
 * pattern, both runners behind safeRunner so EVERY argv — every effect,
 * reads included — passes safeArgs first (the I3 enforcement point).
 *
 * Argv shapes (all guarded, all execve-direct, no shell):
 *   - validateRef:  `git -C <root> rev-parse --verify --quiet <ref>^{commit}`
 *   - fetchRef:     `git -C <root> fetch origin +<ref>:<ref>` ('+' allows a
 *                   force-pushed head to refresh the ref in place)
 *   - worktreePrepare: `git -C <root> worktree add -B cq-merge/pr-<n>
 *                   <commonDir>/cq-merge-worktrees/pr-<n> <ref>` (the label
 *                   is pr-keyed, mirroring review ops' cq-review/pr-<n>;
 *                   the root derives from `rev-parse --git-common-dir` —
 *                   round 2: <repoRoot>/.git is a FILE in a linked
 *                   worktree, so it cannot host the trees)
 *   - worktreeRemove:  `git -C <root> worktree remove <path>` (no --force —
 *                   a refusing tree stays and throws)
 *   - mergePr:      `gh pr merge <pr> --merge` (plus
 *                   `--match-head-commit <sha>` when the caller pins the head)
 *   - retargetBase: `gh pr edit <pr> --base <newBase>`
 *   - readBaseRef:  `gh pr view <pr> --json baseRefName,baseRefOid` (the
 *                   forge base-ref read + the base tip — review-debt #193,
 *                   tip for the gate's topology proof, review P1 round 3)
 *   - pushRef:      `git -C <fromPath> push --no-follow-tags origin
 *                   <src:dst>` (an explicit refspec — round 2: bare/
 *                   symbolic forms are refused; the flag pins
 *                   push.followTags off, review P1 p522)
 *   - diffPatch:    `git -C <repoRoot> diff <HARDENED_DIFF_FLAGS>
 *                   --unified=0 <from> <to>` (both full 40-hex shas — the
 *                   hardened read-only patch read behind the resolver's
 *                   pre-push scan, #1193)
 *   - commitParents: `git -C <repoRoot> rev-list --parents -n 1 <sha>`
 *                   (the gate's topology proof — one commit on the
 *                   validated baseline, or a merge of it with public base
 *                   history — review P1 rounds 2-3)
 *   - isAncestor:    `git -C <repoRoot> merge-base --is-ancestor <sha>
 *                   <sha>` (is the merge parent public base history?)
 *   - readCommitMessage: `git -C <repoRoot> log -1 --encoding=UTF-8
 *                   --format=%B <sha>` (the gate's message scan input,
 *                   review P2 ntJt; encoding pinned P1 q2-s)
 *   - objectExists:  `git -C <repoRoot> cat-file -e <sha>` (is the forge
 *                   base tip local yet? review P2 ntJj)
 *   - fetchBaseBranch: `git -C <repoRoot> fetch origin <branch>` (bring a
 *                   not-yet-local base tip in; colon-less, FETCH_HEAD only)
 */
export function realMergeEffects(opts: RealMergeEffectsOpts): MergeEffects {
  // Absolute everywhere (prWorktree doctrine): mkdir resolves from the
  // process cwd while `-C` resolves from inside repoRoot — a relative root
  // would split one repo across two resolvers.
  const repoRoot = pathResolve(opts.repoRoot);
  // exactOptionalPropertyTypes: absent options are OMITTED, never passed
  // as explicit undefined.
  const guardOpts =
    opts.protectedBranch !== undefined ? { protectedBranch: opts.protectedBranch } : {};
  const ghRunnerOpts = {
    ...(opts.ghBin !== undefined ? { bin: opts.ghBin } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    // Scope gh to the target repository (review-debt #163): git already
    // runs via -C, but gh resolved its repo from the process cwd or GH_REPO
    // — an SDK caller with cwd ≠ target repo could hit WRONG-repo PRs when
    // numbers collide. The spawn cwd fixes that without touching argv
    // shapes (safeArgs unaffected); GH_REPO is stripped from the inherited
    // env because gh's resolution precedence (-R > GH_REPO > cwd) would
    // otherwise defeat the cwd. The git runner keeps -C argv scoping.
    cwd: repoRoot,
    unsetEnv: ['GH_REPO'],
  };
  const gitRunnerOpts = {
    ...(opts.gitBin !== undefined ? { bin: opts.gitBin } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    // OBJECT-GRAPH HARDENING (review P1 p528, PR #1641): every gate read
    // — validate/parents/diff/message/ancestry/presence — and the push
    // must see the TRUE objects, never attacker-chosen refs/replace
    // substitutions (a worker can map a secret-bearing resolution to a
    // clean replacement commit; without this the gate would read the
    // clean twin). Also CONFIG-PINNED QUOTING (review P2 p52p):
    // core.quotePath is forced on for this runner so the diff's header
    // paths are always C-quoted deterministically (a repo setting
    // quotePath=false would otherwise emit literal UTF-8 inside quotes
    // the scanner must not have to guess about). The same layering
    // src/ops/dev/internal/snapshot.ts uses, via makeGhRunner's env
    // merge.
    env: {
      // Git treats GIT_NO_REPLACE_OBJECTS as PRESENCE-checked: any value,
      // including 0, disables refs/replace. Setting it to 1 is therefore
      // not a toggle — do not "optimize" this to `process.env.X ?? '1'`
      // and expect 0 to re-enable replacements (crq F1, PR #1641).
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.quotePath',
      GIT_CONFIG_VALUE_0: 'true',
    },
  };
  const gh = safeRunner(opts.run ?? makeGhRunner(ghRunnerOpts), guardOpts);
  const git = safeRunner(
    opts.gitRun ?? makeGhRunner({ bin: opts.gitBin ?? 'git', ...gitRunnerOpts }),
    guardOpts,
  );

  const validateRef = async (ref: string): Promise<{ ok: boolean; sha?: string }> => {
    const result = await git([
      '-C',
      repoRoot,
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    ]);
    if (result.code !== 0) {
      return { ok: false };
    }
    return { ok: true, sha: result.stdout.trim() };
  };

  const fetchRef = (ref: string): Promise<GhResult> =>
    git(['-C', repoRoot, 'fetch', 'origin', `+${ref}:${ref}`]);

  // The forge base-ref read (review-debt #193). `gh pr view --json` prints
  // a JSON document; a nonzero exit, unparseable stdout, or an absent/empty
  // field is `{ ok: false }` — fail closed, never a guessed base. The
  // parsed ref is TRIMMED (a whitespace-padded value must not false-`stale`
  // at the consumer) and an empty-after-trim value is `{ ok: false }`.
  const readBaseRef = async (
    pr: number,
  ): Promise<{ ok: boolean; baseRefName?: string; baseTipSha?: string }> => {
    if (!Number.isInteger(pr) || pr <= 0) return { ok: false };
    const result = await gh(['pr', 'view', String(pr), '--json', 'baseRefName,baseRefOid']);
    if (result.code !== 0) return { ok: false };
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { ok: false };
    }
    const record =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { baseRefName?: unknown; baseRefOid?: unknown })
        : undefined;
    const raw = record?.baseRefName;
    if (typeof raw !== 'string') return { ok: false };
    const baseRefName = raw.trim();
    if (baseRefName === '') return { ok: false };
    // The base tip rides along when the forge answered a full 40-hex OID;
    // anything else is omitted — the gate refuses to verify a second
    // parent against an unshaped answer.
    const rawTip = record?.baseRefOid;
    const baseTipSha =
      typeof rawTip === 'string' && /^[0-9a-f]{40}$/i.test(rawTip) ? rawTip : undefined;
    return { ok: true, baseRefName, ...(baseTipSha !== undefined ? { baseTipSha } : {}) };
  };

  // The ancestry read (review P1 round 3): the argv shape is pinned by
  // safeArgs to --is-ancestor plus two 40-hex shas. Exit 0/1 are both
  // ANSWERS (ancestor / not); any other exit is a fault.
  const isAncestor = (ancestor: string, descendant: string): Promise<GhResult> =>
    git(['-C', repoRoot, 'merge-base', '--is-ancestor', ancestor, descendant]);

  // The message read (review P2 ntJt, encoding P1 q2-s): unpadded %B, the
  // raw subject and body — never truncated (a cap would hide a secret
  // placed past it). --encoding is pinned so a repo's
  // i18n.logOutputEncoding cannot turn the bytes into UTF-16LE and hide
  // ASCII token text from the UTF-8 decoder.
  const readCommitMessage = (sha: string): Promise<GhResult> =>
    git(['-C', repoRoot, 'log', '-1', '--encoding=UTF-8', '--format=%B', sha]);

  // The encoding-header read (review P1 sMLw): the declared encoding, raw
  // header value (empty when the commit stores UTF-8). The gate refuses
  // non-UTF-8 declarations instead of trusting a re-code.
  const readCommitEncoding = (sha: string): Promise<GhResult> =>
    git(['-C', repoRoot, 'log', '-1', '--format=%e', sha]);

  // The object-presence read (review P2 ntJj): exit 0 = local, anything
  // else = absent-or-unreadable (the caller fetches and re-checks).
  const objectExists = (sha: string): Promise<GhResult> =>
    git(['-C', repoRoot, 'cat-file', '-e', sha]);

  // The base fetch (review P2 ntJj): the branch name is the op input's
  // schema-gated conservative refname; the argv is a colon-less fetch
  // refspec the existing safeArgs fetch shape already admits.
  const fetchBaseBranch = (branch: string): Promise<GhResult> =>
    git(['-C', repoRoot, 'fetch', 'origin', branch]);

  // The worktree root's base dir, derived LAZILY (first prepare, then
  // cached) from git's COMMON dir (round 2): a linked worktree's .git is a
  // FILE (a `gitdir:` pointer), so joining <repoRoot>/.git threw ENOTDIR
  // there. `git rev-parse --git-common-dir` names the shared dir (a
  // relative answer resolves against repoRoot); if the probe fails or
  // prints nothing the fallback is <repoRoot>/.git — the main-checkout
  // layout, documented.
  let gitCommonDir: string | undefined;
  const commonDir = async (): Promise<string> => {
    if (gitCommonDir !== undefined) return gitCommonDir;
    const probe = await git(['-C', repoRoot, 'rev-parse', '--git-common-dir']);
    const answered = probe.code === 0 ? probe.stdout.trim() : '';
    gitCommonDir = answered === '' ? join(repoRoot, '.git') : pathResolve(repoRoot, answered);
    return gitCommonDir;
  };

  const worktreeLabel = mergeWorktreeBranchLabel;

  const worktreePrepare = async (pr: number, ref: string): Promise<{ path: string }> => {
    const path = join(await commonDir(), 'cq-merge-worktrees', `pr-${String(pr)}`);
    await mkdir(dirname(path), { recursive: true });
    const result = await git([
      '-C',
      repoRoot,
      'worktree',
      'add',
      '-B',
      worktreeLabel(pr),
      path,
      ref,
    ]);
    if (result.code !== 0) {
      throw new Error(
        `worktree add for pr ${pr} failed (exit ${result.code}): ${result.stderr.trim()}`,
      );
    }
    return { path };
  };

  const worktreeRemove = async (path: string): Promise<void> => {
    const result = await git(['-C', repoRoot, 'worktree', 'remove', path]);
    if (result.code !== 0) {
      throw new Error(
        `worktree remove ${path} failed (exit ${result.code}): ${result.stderr.trim()} — a dirty or locked tree is left in place`,
      );
    }
  };

  const mergePr = (
    pr: number,
    opts: { method: 'merge'; matchHeadCommit?: string },
  ): Promise<GhResult> =>
    gh([
      'pr',
      'merge',
      String(pr),
      `--${opts.method}`,
      ...(opts.matchHeadCommit !== undefined ? ['--match-head-commit', opts.matchHeadCommit] : []),
    ]);

  const retargetBase = (pr: number, newBase: string): Promise<GhResult> =>
    gh(['pr', 'edit', String(pr), '--base', newBase]);

  // The publication/executor push (review P1 p522, PR #1641): the argv is
  // pinned by safeArgs to lead with --no-follow-tags AND
  // --recurse-submodules=no. --no-follow-tags stops `push.followTags`
  // publishing ANNOTATED TAGS; --recurse-submodules=no stops
  // `push.recurseSubmodules=only` from exiting 0 with the superproject
  // UNPUSHED (review P2 rw4S) and stops on-demand recursion publishing
  // unscanned submodule commits (CodeRabbit sULU).
  const pushRef = (ref: string, fromPath: string): Promise<GhResult> =>
    git(['-C', fromPath, 'push', '--no-follow-tags', '--recurse-submodules=no', 'origin', ref]);

  // The read-only patch read (issue #1193): the argv shape is pinned by
  // safeArgs to HARDENED_DIFF_FLAGS + --unified=0 plus two 40-hex shas —
  // the guard is the only reason this call is safe for endpoint arguments
  // the op computed itself. The hardened flags keep a repo-controlled
  // .gitattributes diff driver or textconv from substituting (or
  // emptying) the patch text the gate scans (review P1, PR #1628).
  const diffPatch = (from: string, to: string): Promise<GhResult> =>
    git(['-C', repoRoot, 'diff', ...HARDENED_DIFF_FLAGS, '--unified=0', from, to]);

  // The gate's topology read (review P1 round 2): the argv shape is
  // pinned by safeArgs to `--parents -n 1` plus one 40-hex sha. Nonzero →
  // { ok: false } — the caller refuses, it never guesses a topology.
  const commitParents = async (sha: string): Promise<{ ok: boolean; parents?: string[] }> => {
    const result = await git(['-C', repoRoot, 'rev-list', '--parents', '-n', '1', sha]);
    if (result.code !== 0) return { ok: false };
    const tokens = result.stdout
      .trim()
      .split(/\s+/)
      .filter((token) => token !== '');
    return { ok: true, parents: tokens.slice(1) };
  };

  return {
    validateRef,
    fetchRef,
    readBaseRef,
    worktreePrepare,
    worktreeRemove,
    mergePr,
    retargetBase,
    pushRef,
    diffPatch,
    commitParents,
    isAncestor,
    readCommitMessage,
    readCommitEncoding,
    objectExists,
    fetchBaseBranch,
  };
}
