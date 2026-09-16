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
// hard-reset, or push to the base branch, whatever calls it. The guard is
// `safeArgs`: a git/gh argv that contains a squash/force/rebase/hard token,
// or a push whose DESTINATION ref is `main`/`refs/heads/main`, THROWS
// before any process can spawn. realMergeEffects routes EVERY argv — reads
// included — through safeArgs via `safeRunner`, the single I3 enforcement
// point; the negative tests prove the guard shape by shape.
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

/**
 * The forbidden-mutation word list, matched against each argv token with
 * leading dashes stripped: `squash` (and `--squash`), `f` (`-f`), `rebase`
 * (and `--rebase`), `hard` (`--hard`), and anything starting `force`
 * (`--force` and `--force-with-lease` alike). `merge`/`--merge` — the ONLY
 * allowed merge method — is not on the list; `ff-only` and friends are not
 * mutations I3 names.
 */
const isForbiddenWord = (word: string): boolean =>
  word === 'squash' || word === 'f' || word === 'rebase' || word === 'hard' || word.startsWith('force');

/** The destination half of a push refspec (`[+]<src>[:<dst>]` — no colon
 * means the source doubles as the destination). */
const pushDestination = (refspec: string): string => {
  const colon = refspec.indexOf(':');
  return colon === -1 ? refspec : refspec.slice(colon + 1);
};

/** True for the base branch under either spelling — the ref I3 never
 * allows a push to land on. */
const isMainRef = (ref: string): boolean => ref === 'main' || ref === 'refs/heads/main';

/**
 * THE I3 GUARD: validate a git/gh argv before execution. THROWS
 * UnsafeMergeArgsError on any squash/force/rebase/hard token, or any push
 * (a `push` subcommand anywhere in the argv) whose DESTINATION ref is
 * `main` or `refs/heads/main` — bare `main`, `HEAD:main`, `feat:refs/heads/
 * main`, and the remote-branch deletion `:main` all land on main, so all
 * are refused. Returns the argv unchanged otherwise (the caller executes
 * exactly what went in). Flag-value awareness is deliberately absent: a
 * flag value that reads as a push-to-main refspec fails closed.
 */
export function safeArgs(args: readonly string[]): readonly string[] {
  for (const arg of args) {
    if (isForbiddenWord(arg.replace(/^-+/, ''))) {
      throw new UnsafeMergeArgsError(
        args,
        `forbidden mutation token ${JSON.stringify(arg)} — squash, force (-f/--force), rebase, and hard resets never execute`,
      );
    }
  }
  const pushAt = args.indexOf('push');
  if (pushAt !== -1) {
    for (const arg of args.slice(pushAt + 1)) {
      if (arg.startsWith('-')) continue; // flags are not refspecs
      if (isMainRef(pushDestination(arg))) {
        throw new UnsafeMergeArgsError(
          args,
          `push with destination ${JSON.stringify(pushDestination(arg))} — the base branch is never pushed to`,
        );
      }
    }
  }
  return args;
}

/**
 * THE I3 ENFORCEMENT POINT: wrap a command runner so NO argv reaches it
 * until safeArgs passes. realMergeEffects routes BOTH of its runners (git
 * and gh) through this — every argv, reads included — so the production
 * implementation cannot execute a forbidden mutation even if a future argv
 * builder tries.
 */
export const safeRunner = (run: GhFn): GhFn => (args) => run([...safeArgs(args)]);

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
  /** Push `ref` from the worktree at `fromPath`. Resolves with the exit
   * code; safeArgs refuses any push whose destination is the base branch
   * before the process level is ever reached. */
  pushRef(ref: string, fromPath: string): Promise<GhResult>;
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
 *                   <root>/.git/cq-merge-worktrees/pr-<n> <ref>` (the label
 *                   is pr-keyed, mirroring review ops' cq-review/pr-<n>)
 *   - worktreeRemove:  `git -C <root> worktree remove <path>` (no --force —
 *                   a refusing tree stays and throws)
 *   - mergePr:      `gh pr merge <pr> --merge`
 *   - retargetBase: `gh pr edit <pr> --base <newBase>` (--base is not a
 *                   forbidden token — the guard rejects squash / force /
 *                   rebase / --hard / push-to-main only)
 *   - pushRef:      `git -C <fromPath> push origin <ref>`
 */
export function realMergeEffects(opts: RealMergeEffectsOpts): MergeEffects {
  // Absolute everywhere (prWorktree doctrine): mkdir resolves from the
  // process cwd while `-C` resolves from inside repoRoot — a relative root
  // would split one repo across two resolvers.
  const repoRoot = pathResolve(opts.repoRoot);
  const gh = safeRunner(opts.run ?? makeGhRunner({ bin: opts.ghBin, timeoutMs: opts.timeoutMs }));
  const git = safeRunner(
    opts.gitRun ?? makeGhRunner({ bin: opts.gitBin ?? 'git', timeoutMs: opts.timeoutMs }),
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

  const worktreeLabel = (pr: number): string => `cq-merge/pr-${pr}`;

  const worktreePrepare = async (pr: number, ref: string): Promise<{ path: string }> => {
    const path = join(repoRoot, '.git', 'cq-merge-worktrees', `pr-${String(pr)}`);
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
