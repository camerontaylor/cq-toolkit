// effects — the injectable git/gh mutation seam for the merge executor
// (goal F3, ws-f scope item 3; UC §3 row 43).
//
// THE LOAD-BEARING DESIGN POINT (UC row 43, carried as a requirement): every
// git/gh mutation the executor can perform lives behind ONE interface,
// MergeEffects — and `executeMerges` takes an instance as INPUT. A test
// therefore exercises the whole merge flow through a FakeMergeEffects that
// implements seven async methods in memory: ZERO real git/gh processes,
// zero networks, zero filesystems. The production implementation
// (realMergeEffects) is just one more implementor of the same interface.
//
// I3 — MERGE COMMITS ONLY. The executor may never squash, force, rebase,
// hard-reset, amend, or push to the protected branch, whatever calls it.
// The guard is `safeArgs` — an ALLOWLIST (round 2): only the seven argv
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
import type { GhFn, GhResult } from '../review/gh.js';
import { makeGhRunner } from '../review/gh.js';

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
 * the guard through however innocuous its tokens look. The seven shapes
 * (after the `-C <path>` prefix is stripped):
 *   rev-parse <flags/ref>…                    — ref resolution (≥1 arg)
 *   fetch <remote> <refspec>…                 — refspecs may carry the '+'
 *       in-place marker, but a ':'-refspec whose (+-stripped) DESTINATION
 *       names the protected branch is a forced update of that branch —
 *       refused; colon-less refspecs land in FETCH_HEAD only and cannot
 *       move a branch, so they need no destination check
 *   worktree add -B <label> <path> <ref>      — the exact prepare shape
 *   worktree list|remove <arg>…               — rough arity
 *   push <remote> <src:dst>                   — an EXPLICIT src:dst refspec
 *       is required (bare HEAD/@/upstream shorthands refused, round 2), a
 *       '+' force marker is refused OUTRIGHT (round 2 — I3 forbids force,
 *       period), and the destination must not be the protected branch
 *   gh pr merge <n> --merge                   — the ONLY merge method (I3)
 *   gh pr edit <n> --base <base>              — the retarget
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
      'refused: unknown argv shape — the merge family executes only its seven documented shapes (rev-parse, fetch, worktree add/list/remove, push, gh pr merge, gh pr edit)',
    );
  const sub = rest[0];
  switch (sub) {
    case 'rev-parse':
      if (rest.length < 2) throw unknown();
      return args;
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
      } else if (rest.length < 3) {
        throw unknown();
      }
      return args;
    }
    case 'push': {
      const tail = rest.slice(1).filter((arg) => !arg.startsWith('-'));
      // tail[0] is the REMOTE; the rest are the refspecs. Fewer than two
      // non-flag tokens means NO explicit refspec (round 1): push.default
      // would choose the destination — possibly the protected branch.
      if (tail.length < 2) throw unknown();
      for (const refspec of tail.slice(1)) {
        if (refspec.startsWith('+')) {
          // Force-marker bypass, closed (round 2): a '+'-marked PUSH
          // refspec is a force-push — I3 forbids force outright, whatever
          // it names.
          throw new UnsafeMergeArgsError(
            args,
            `force-marked push refspec ${JSON.stringify(refspec)} — I3 forbids force pushes outright`,
          );
        }
        if (!refspec.includes(':')) {
          throw new UnsafeMergeArgsError(
            args,
            `push refspec ${JSON.stringify(refspec)} is not an explicit src:dst — bare or symbolic refspecs (HEAD, @, upstream shorthand) are refused`,
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
    case 'pr':
      // The two gh shapes: the merge (I3's only method) and the retarget.
      if (
        rest.length === 4 &&
        rest[1] === 'merge' &&
        /^\d+$/.test(rest[2]) &&
        rest[3] === '--merge'
      ) {
        return args;
      }
      if (
        rest.length === 5 &&
        rest[1] === 'edit' &&
        /^\d+$/.test(rest[2]) &&
        rest[3] === '--base' &&
        rest[4] !== ''
      ) {
        return args;
      }
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
export const safeRunner = (run: GhFn, opts: SafeArgsOpts = {}): GhFn => (args) =>
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
   * argv regardless). Resolves with the exit code; executeMerges reads
   * `stderr` to decide bounded-retry eligibility. */
  mergePr(pr: number, opts: { method: 'merge' }): Promise<GhResult>;
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
   * pinned by the safeArgs push tests. */
  pushRef(ref: string, fromPath: string): Promise<GhResult>;
}

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
 *   - mergePr:      `gh pr merge <pr> --merge`
 *   - retargetBase: `gh pr edit <pr> --base <newBase>`
 *   - pushRef:      `git -C <fromPath> push origin <src:dst>` (an explicit
 *                   refspec — round 2: bare/symbolic forms are refused)
 */
export function realMergeEffects(opts: RealMergeEffectsOpts): MergeEffects {
  // Absolute everywhere (prWorktree doctrine): mkdir resolves from the
  // process cwd while `-C` resolves from inside repoRoot — a relative root
  // would split one repo across two resolvers.
  const repoRoot = pathResolve(opts.repoRoot);
  const guardOpts = { protectedBranch: opts.protectedBranch };
  const gh = safeRunner(opts.run ?? makeGhRunner({ bin: opts.ghBin, timeoutMs: opts.timeoutMs }), guardOpts);
  const git = safeRunner(
    opts.gitRun ?? makeGhRunner({ bin: opts.gitBin ?? 'git', timeoutMs: opts.timeoutMs }),
    guardOpts,
  );

  const validateRef = async (ref: string): Promise<{ ok: boolean; sha?: string }> => {
    const result = await git(['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (result.code !== 0) {
      return { ok: false };
    }
    return { ok: true, sha: result.stdout.trim() };
  };

  const fetchRef = (ref: string): Promise<GhResult> =>
    git(['-C', repoRoot, 'fetch', 'origin', `+${ref}:${ref}`]);

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

  const worktreeLabel = (pr: number): string => `cq-merge/pr-${pr}`;

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

  const mergePr = (pr: number, method: { method: 'merge' }): Promise<GhResult> =>
    gh(['pr', 'merge', String(pr), `--${method.method}`]);

  const retargetBase = (pr: number, newBase: string): Promise<GhResult> =>
    gh(['pr', 'edit', String(pr), '--base', newBase]);

  const pushRef = (ref: string, fromPath: string): Promise<GhResult> =>
    git(['-C', fromPath, 'push', 'origin', ref]);

  return { validateRef, fetchRef, worktreePrepare, worktreeRemove, mergePr, retargetBase, pushRef };
}
