// Sweep lane (WS-D, goal D2) — the AGE-BASED CLEANUP of run-prefixed
// worktrees and branches (UC §1 row 13): enumerate candidate worktrees whose
// branch sits under the reserved run prefix AND whose path sits inside the
// worktrees dir, probe their age and strict cleanliness, and — ONLY outside
// the dry-run default — remove the aged ones. THE SAFETY LADDER is the
// goal's required assertion: NO worktree is ever removed while dirty except
// via the explicit `force` flag — and even `force` never widens the
// candidate set: the run prefix and the worktrees dir are hard boundaries,
// anything else is untouchable and reported as kept. The FACTORY is pure
// decision core over the injected {@link CleanupEffects} (the worktreeFor
// factory-over-injected-effects idiom); the module ships the REAL effects
// binding ({@link makeSubprocessCleanupEffects}, the registry importer's
// input-driven binding, reusing the worktreeFor adapter's listings and
// strict-clean probe); every git-MUTATING section runs inside
// {@link makeGitMutex} when the input configures one (UC row 32).
//
// Invariants honored here:
//   - Dry-run is the DEFAULT: a bare invocation mutates nothing and reports
//     the would-be outcome (removed/pruned/skippedDirty rows are the
//     WOULD-BE lists when `dryRun` is true — the flag is what makes them
//     honest).
//   - Dirty requires explicit force: a dirty aged tree lands in
//     skippedDirty unless `force` is set; clean trees never need it. The
//     removal revalidates existence, age and cleanliness INSIDE the mutex,
//     immediately before mutating — never removed on stale evidence.
//   - A registered-but-missing worktree dir is residue, not a failure: the
//     stale registration is pruned and reported, its branch left to the
//     branch-only sweep.
//   - R2 D8 posture: a fault is a `failed` result naming the tree AND the
//     removals already completed — a candidate is never silently skipped,
//     completed work is never invisible.
//   - Canonicalized path comparisons throughout (the worktreeFor realpath
//     idiom), so porcelain-reported realpaths and caller-supplied dirs meet
//     on equal terms.
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Op } from '../../kernel/types.js';
import { makeGitMutex } from './gitMutex.js';
import type { GitMutex, GitMutexConfig } from './gitMutex.js';
import { makeSubprocessWorktreeEffects, mapWorktreeGitFault } from './worktreeFor.js';
import type { WorktreeMutexConfig } from './worktreeFor.js';

/** JSON-serializable input of the `sweep.cleanup` op. */
export interface CleanupInput {
  /** Repository the worktrees and branches live in. */
  repoRoot: string;
  /**
   * Parent dir of the run worktrees — CONFIG-GRADE, resolved against
   * `repoRoot` when relative (the worktreeFor convention). Only trees
   * canonically INSIDE this dir are ever considered.
   */
  worktreesDir: string;
  /**
   * The reserved run prefix (e.g. `cq/09-16a`). ONLY branches starting
   * `<runPrefix>/` are ever considered — any other branch or tree is
   * untouchable and reported as kept. Held to the same safe-segment rule as
   * worktreeFor's runPrefix: it feeds git refnames on the delete path.
   */
  runPrefix: string;
  /** Age cutoff in ms (integer ≥ 0): a candidate qualifies when its age STRICTLY exceeds it. */
  olderThanMs: number;
  /**
   * DEFAULT TRUE: report the would-be removals and skips, calling ZERO
   * mutating effects. Set explicitly false to perform the removals.
   */
  dryRun?: boolean;
  /**
   * Explicit --force: ONLY affects DIRTY worktree removal (a dirty aged tree
   * is removed instead of skipped). Never a clean-tree requirement, never a
   * candidate-set widening — the prefix and dir boundaries stand regardless.
   */
  force?: boolean;
  /** When present, every git-mutating section runs inside the git mutex (UC row 32). */
  mutex?: WorktreeMutexConfig;
}

/**
 * The injected git/fs seam — the ONE place this module touches the world.
 * All effects are lazy per call (no caching between calls); tests inject
 * fakes, production binds {@link makeSubprocessCleanupEffects}.
 */
export interface CleanupEffects {
  /** Local worktrees from `git worktree list --porcelain`; `branch` is undefined for detached/bare entries. */
  listWorktrees(): Promise<Array<{ path: string; branch?: string }>>;
  /** Short names of local branches (`git for-each-ref refs/heads`). */
  listBranches(): Promise<string[]>;
  /** The mtime (ms) of the worktree dir at `path` — the age basis for trees. */
  modifiedTimeMs(path: string): Promise<number>;
  /** STRICT clean: `git status --porcelain` EMPTY semantics — untracked files count as dirty. */
  isStrictClean(path: string): Promise<boolean>;
  /**
   * Remove the worktree at `path`. WITHOUT `opts.force` this must run plain
   * `git worktree remove <path>`: git itself refuses a dirty tree, the
   * adapter-level backstop under the op's own clean-check. `opts.force` is
   * reached ONLY when the op's input.force was true for a probed-dirty tree.
   */
  worktreeRemove(repoRoot: string, path: string, opts?: { force?: boolean }): Promise<void>;
  /** Hard-delete a local branch (`git branch -D <branch>`); prefix-guarded by the op. */
  branchDelete(repoRoot: string, branch: string): Promise<void>;
  /**
   * Drop stale worktree registrations (`git worktree prune`) — the residue
   * path for a REGISTERED worktree whose dir is already gone (rm -rf'd
   * without `git worktree remove`).
   */
  worktreePrune(repoRoot: string): Promise<void>;
  /**
   * The age basis (ms) of a BRANCH with no worktree — its tip's committer
   * date. The mandate's `modifiedTimeMs(path)` has no honest branch form
   * (stating a ref file path would fabricate repo internals into the seam),
   * so this is the one seam member beyond the listed set: smallest deviation,
   * flagged in the D2 notes. Also the branch-activity half of a worktree
   * candidate's age basis (an old dir with a fresh tip commit is kept —
   * the branch delete would destroy unpushed work).
   */
  branchTimeMs(repoRoot: string, branch: string): Promise<number>;
}

/** The age-based cleanup's report. Plain JSON; `dryRun` marks the WOULD-BE lists. */
export interface CleanupReport {
  /** True when nothing was mutated and every list below is the WOULD-BE outcome. */
  dryRun: boolean;
  /** Removed (or would-be removed) worktrees, with the branch deleted alongside each. */
  removed: Array<{ path: string; branch: string }>;
  /**
   * Registered-but-missing worktree dirs (the residue class): the stale
   * registration pruned; the branch is NOT deleted here — it remains
   * branch-only-sweep eligible.
   */
  pruned: Array<{ path: string; branch: string }>;
  /** Aged-but-DIRTY trees not removed (no force) — the explicit --force surface. */
  skippedDirty: Array<{ path: string; reason: string }>;
  /** Every other enumerated worktree: younger than the cutoff, or outside the prefix/dir — untouchable. */
  kept: Array<{ path: string; reason: string }>;
  /** Branches deleted: each removed tree's branch plus aged prefix branches with no worktree. */
  branchesRemoved: string[];
}

/**
 * Build the `sweep.cleanup` op over injected git effects. Per call, in
 * order: (a) probe — list worktrees and branches, canonicalize the
 * worktrees dir, and partition the enumerated worktrees into CANDIDATES
 * (branch starts `<runPrefix>/` AND path canonically inside worktreesDir)
 * and kept rows (detached, outside the prefix, or outside the dir — each
 * accounted for, never silently dropped); (b) classify per candidate — the
 * AGE BASIS is the LATEST of the dir mtime and the branch tip commit (an
 * old dir with a recent commit is KEPT: the branch delete would destroy
 * unpushed work); a REGISTERED candidate whose dir is ABSENT is residue —
 * pruned (`git worktree prune`) and reported as pruned, its branch left to
 * the branch-only sweep, never a whole-op failure; strictly older than the
 * cutoff AND strictly clean is a removal candidate, dirty is one only under
 * `force`, younger is kept; (c) the mutation phase — only when `dryRun` is
 * false — is probe-then-remove PER CANDIDATE within ONE mutex acquisition:
 * existence, age (dir AND tip) and strict cleanliness are REVALIDATED while
 * holding the lock, and a candidate whose state changed (now dirty / now
 * young / now missing) moves to skippedDirty/kept with a "revalidated
 * inside the mutex" reason — never removed on stale evidence; (d) a
 * branch-only sweep — prefix branches with NO registered worktree whose tip
 * age strictly exceeds the cutoff are branch-deleted (tip age re-probed
 * under the lock; their tree is already gone). In dry-run every list is the
 * WOULD-BE outcome and zero mutators run. Every effects fault is a `failed`
 * result naming the tree AND appending the removals already completed —
 * completed work is never invisible — never a throw across the op seam,
 * never a fabricated ok.
 */
export function makeCleanup(git: CleanupEffects): Op<CleanupInput, CleanupReport> {
  return async (input) => {
    const fault = inputFaultOf(input);
    if (fault !== null) return { status: 'failed', error: fault };
    const dryRun = input.dryRun ?? true;
    // Belt-and-braces around inputFaultOf's mutex-bound validation: a
    // makeGitMutex construction throw is a LIBRARY precondition violation,
    // and across the op seam it maps to `failed` — never an escaping
    // rejected promise, never a fabricated ok.
    let guard: GitMutex | undefined;
    try {
      guard = input.mutex === undefined ? undefined : makeGitMutex(mutexConfigOf(input.mutex));
    } catch (err) {
      return {
        status: 'failed',
        error: `sweep: could not build the git mutex — ${messageOf(err)}`,
      };
    }
    const inGuard = <T>(fn: () => T | Promise<T>): Promise<T> =>
      guard === undefined ? Promise.resolve().then(fn) : guard.withLock(fn);

    let worktrees: Array<{ path: string; branch?: string }>;
    try {
      worktrees = await git.listWorktrees();
    } catch (err) {
      return {
        status: 'failed',
        error: `sweep: could not list local worktrees — ${messageOf(err)}`,
      };
    }
    let branches: string[];
    try {
      branches = await git.listBranches();
    } catch (err) {
      return {
        status: 'failed',
        error: `sweep: could not list local branches — ${messageOf(err)}`,
      };
    }

    // CANONICALIZED comparison (the worktreeFor idiom): porcelain reports
    // REALPATH'd paths, so the dir boundary is canonicalized before any
    // containment check; an absent dir falls back to its lexical form.
    const dirReal = await realpathOf(resolve(input.repoRoot, input.worktreesDir));
    const prefix = `${input.runPrefix}/`;

    const removed: Array<{ path: string; branch: string }> = [];
    const pruned: Array<{ path: string; branch: string }> = [];
    const skippedDirty: Array<{ path: string; reason: string }> = [];
    const kept: Array<{ path: string; reason: string }> = [];
    const branchOnly: string[] = [];

    // Completed work is never invisible: every `failed` return after the
    // loop begins appends what already mutated.
    const progressNote = (): string => {
      const parts = [
        ...pruned.map(
          (r) =>
            `pruned the stale registration for '${r.path}' (branch '${r.branch}' left to the branch-only sweep)`,
        ),
        ...removed.map((r) => `removed worktree '${r.path}' on branch '${r.branch}'`),
        ...branchOnly.map((b) => `deleted branch '${b}'`),
      ];
      return parts.length === 0 ? '' : ` — completed before the fault: ${parts.join('; ')}`;
    };

    for (const worktree of worktrees) {
      const real = await realpathOf(worktree.path);
      const branch = worktree.branch;
      const inDir = isInside(real, dirReal);
      if (branch === undefined || !branch.startsWith(prefix) || !inDir) {
        // Account for every enumerated worktree — a non-candidate is a kept
        // row naming WHY, never a silent drop (the planner's orphan rule).
        const whys: string[] = [];
        if (branch === undefined) whys.push('the tree is detached (no branch)');
        else if (!branch.startsWith(prefix)) {
          whys.push(`branch '${branch}' is outside the run prefix '${prefix}'`);
        }
        if (!inDir) whys.push(`the path is outside worktreesDir '${dirReal}'`);
        kept.push({ path: real, reason: whys.join('; ') });
        continue;
      }

      // FIRST-PASS PROBE (outside the lock) — classifies the row set. The
      // age basis includes BRANCH ACTIVITY: the effective reference is the
      // LATEST of dir mtime and branch tip commit, so an old dir whose tip
      // commit is recent is YOUNG (branch -D would destroy the unpushed
      // commits).
      let mtimeMs: number;
      try {
        mtimeMs = await git.modifiedTimeMs(real);
      } catch (err) {
        if (isAbsence(err)) {
          // REGISTERED-but-missing dir (rm -rf'd without `git worktree
          // remove` — the residue class this op exists for): prune the
          // stale registration on the removal path and report the row as
          // pruned. The branch is NOT deleted here — it stays
          // branch-only-sweep eligible. Never a whole-op failure.
          if (!dryRun) {
            try {
              await inGuard(() => git.worktreePrune(input.repoRoot));
            } catch (pruneErr) {
              return {
                status: 'failed',
                error: `sweep: could not prune the stale registration for missing worktree '${real}' — ${messageOf(pruneErr)}${progressNote()}`,
              };
            }
          }
          pruned.push({ path: real, branch });
          continue;
        }
        return {
          status: 'failed',
          error: `sweep: could not read the age of worktree '${real}' — ${messageOf(err)}${progressNote()}`,
        };
      }
      let tipMs: number;
      try {
        tipMs = await git.branchTimeMs(input.repoRoot, branch);
      } catch (err) {
        return {
          status: 'failed',
          error: `sweep: could not read the age of branch '${branch}' — ${messageOf(err)}${progressNote()}`,
        };
      }
      const basisMs = Math.max(mtimeMs, tipMs);
      const ageMs = Date.now() - basisMs;
      if (ageMs <= input.olderThanMs) {
        kept.push({
          path: real,
          reason:
            tipMs > mtimeMs
              ? `younger than the cutoff (age ${String(ageMs)} ms ≤ ${String(input.olderThanMs)} ms) — branch '${branch}' carries a recent commit (${String(Date.now() - tipMs)} ms old); deleting it could destroy unpushed work`
              : `younger than the cutoff (age ${String(ageMs)} ms ≤ ${String(input.olderThanMs)} ms)`,
        });
        continue;
      }
      let clean: boolean;
      try {
        clean = await git.isStrictClean(real);
      } catch (err) {
        return {
          status: 'failed',
          error: `sweep: could not check '${real}' for a strictly clean tree — ${messageOf(err)}${progressNote()}`,
        };
      }
      if (!clean && input.force !== true) {
        // THE REQUIRED LADDER: no worktree is ever removed while dirty
        // except via the explicit --force flag.
        skippedDirty.push({
          path: real,
          reason:
            'dirty (git status --porcelain non-empty, untracked files included) and force is not set — a dirty worktree is never removed without explicit --force',
        });
        continue;
      }

      // REMOVAL — probe-then-remove PER CANDIDATE within one guard
      // acquisition. In dry-run the would-be row is recorded and no effect
      // runs at all.
      if (dryRun) {
        removed.push({ path: real, branch });
        continue;
      }
      try {
        await inGuard(async () => {
          // REVALIDATION under the lock: existence, age (dir AND tip) and
          // strict cleanliness, from scratch. A candidate whose state
          // changed since the first probe moves to kept/skippedDirty —
          // never removed on stale evidence.
          let reMtimeMs: number;
          try {
            reMtimeMs = await git.modifiedTimeMs(real);
          } catch (rerr) {
            if (isAbsence(rerr)) {
              kept.push({
                path: real,
                reason:
                  'revalidated inside the mutex: the worktree dir is gone (stale registration residue) — never removed on stale evidence; a follow-up run prunes the registration',
              });
              return;
            }
            throw rerr;
          }
          const reTipMs = await git.branchTimeMs(input.repoRoot, branch);
          const reAgeMs = Date.now() - Math.max(reMtimeMs, reTipMs);
          if (reAgeMs <= input.olderThanMs) {
            kept.push({
              path: real,
              reason: `revalidated inside the mutex: younger than the cutoff on the re-check (age ${String(reAgeMs)} ms ≤ ${String(input.olderThanMs)} ms) — never removed on stale evidence`,
            });
            return;
          }
          const reClean = await git.isStrictClean(real);
          if (!reClean && input.force !== true) {
            skippedDirty.push({
              path: real,
              reason:
                'revalidated inside the mutex: the tree went dirty before the removal — a dirty worktree is never removed without explicit --force',
            });
            return;
          }
          // The state held: plain removal for a clean tree (git itself
          // backstops a raced dirty tree); the explicit force path
          // otherwise. The row records only after BOTH mutations succeed.
          if (reClean) await git.worktreeRemove(input.repoRoot, real);
          else await git.worktreeRemove(input.repoRoot, real, { force: true });
          // Prefix re-check before the delete: the branch namespace guard
          // is load-bearing even here, against a raced relisting.
          if (branch.startsWith(prefix)) await git.branchDelete(input.repoRoot, branch);
          removed.push({ path: real, branch });
        });
      } catch (err) {
        return {
          status: 'failed',
          error: `sweep: could not remove worktree '${real}' on branch '${branch}' — ${messageOf(err)}${progressNote()}`,
        };
      }
    }

    // Branch-only sweep: a prefix branch with NO registered worktree is
    // residue whose tree is already gone (a pruned residue row's branch
    // counts as worktree-less from here on — it stays sweep-eligible).
    // Aged by its tip's committer date, RE-PROBED under the lock; a YOUNG
    // one is left in place (the report shape has no branch-kept rows;
    // nothing under the prefix is ever touched without age evidence).
    const prunedBranches = new Set(pruned.map((r) => r.branch));
    const worktreeBranches = new Set(
      worktrees.flatMap((w) =>
        w.branch !== undefined && !prunedBranches.has(w.branch) ? [w.branch] : [],
      ),
    );
    for (const branch of branches) {
      if (!branch.startsWith(prefix) || worktreeBranches.has(branch)) continue;
      let tipMs: number;
      try {
        tipMs = await git.branchTimeMs(input.repoRoot, branch);
      } catch (err) {
        return {
          status: 'failed',
          error: `sweep: could not read the age of branch '${branch}' — ${messageOf(err)}${progressNote()}`,
        };
      }
      if (Date.now() - tipMs <= input.olderThanMs) continue;
      if (dryRun) {
        branchOnly.push(branch);
        continue;
      }
      try {
        await inGuard(async () => {
          // Light revalidation under the lock: a branch that gained a
          // recent commit between the probe and the guard is left alone.
          const reTipMs = await git.branchTimeMs(input.repoRoot, branch);
          if (Date.now() - reTipMs <= input.olderThanMs) return;
          await git.branchDelete(input.repoRoot, branch);
          branchOnly.push(branch);
        });
      } catch (err) {
        return {
          status: 'failed',
          error: `sweep: could not delete branch '${branch}' — ${messageOf(err)}${progressNote()}`,
        };
      }
    }

    return {
      status: 'ok',
      value: {
        dryRun,
        removed,
        pruned,
        skippedDirty,
        kept,
        branchesRemoved: [...removed.map((row) => row.branch), ...branchOnly],
      },
    };
  };
}

/**
 * The ABSENCE class of node:fs faults — ENOENT and ENOTDIR (a path walking
 * through a file) both mean "nothing there". ANY OTHER fault is a real
 * failure, never read as absence (the worktreeFor I7 idiom).
 */
function isAbsence(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    ((err as { code?: unknown }).code === 'ENOENT' ||
      (err as { code?: unknown }).code === 'ENOTDIR')
  );
}

/**
 * Containment of a canonical worktree path inside the canonical worktrees
 * dir: relative()-to-relative() with the separator-aware escape check (the
 * worktreeFor baselineCacheContainmentFault idiom), which guards the
 * prefix-collision class ('wt' vs 'wt-x'). The dir itself is not contained.
 */
function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Library-level input contract; the registry schema mirrors it for JSON dispatch. */
function inputFaultOf(input: CleanupInput): string | null {
  // The WHOLE input is reachable null/undefined/primitive from an untyped
  // caller past any schema — guard the top level BEFORE the first field
  // read, or this boundary itself would throw the TypeError it exists to
  // prevent.
  if (input === null || typeof input !== 'object') {
    return 'sweep: input must be an object with non-empty repoRoot, worktreesDir and runPrefix, and an integer ≥ 0 olderThanMs';
  }
  for (const [field, value] of [
    ['repoRoot', input.repoRoot],
    ['worktreesDir', input.worktreesDir],
    ['runPrefix', input.runPrefix],
  ] as const) {
    if (typeof value !== 'string' || value === '') {
      return `sweep: ${field} must be a non-empty string`;
    }
  }
  // CONTROL CHARACTERS (jCoNL): the porcelain lists these values feed are
  // LINE-oriented, and worktreeRemove/branchDelete pass the derived values
  // as positional git arguments.
  if (CONTROL_CHARS_RE.test(input.repoRoot)) {
    return 'sweep: repoRoot must not contain control characters (newline/carriage return) — the porcelain lists it anchors are line-oriented';
  }
  if (CONTROL_CHARS_RE.test(input.worktreesDir)) {
    return 'sweep: worktreesDir must not contain control characters (newline/carriage return) — the porcelain lists it is compared against are line-oriented';
  }
  // The worktreesDir resolves into a positional git argument on the removal
  // path (`git worktree remove <path>`), so a dash-leading dir would inject
  // it as a flag.
  if (input.worktreesDir.startsWith('-')) {
    return `sweep: worktreesDir '${input.worktreesDir}' must not start with '-' — the removal path is a positional git argument, never a flag`;
  }
  // runPrefix feeds branch matching AND the `git branch -D <branch>`
  // refname: every segment is held to the same safe-segment rule as
  // worktreeFor's runPrefix (no traversal, no leading dash, no '..' run, no
  // '.lock' suffix).
  for (const segment of input.runPrefix.split('/')) {
    if (!SEGMENT_RE.test(segment) || refnameUnsafeSegment(segment)) {
      return `sweep: runPrefix '${input.runPrefix}' must be '/'-joined safe segments (${SEGMENT_RE.source}) — it guards the only removable branch namespace and feeds a git refname`;
    }
  }
  if (!Number.isInteger(input.olderThanMs) || input.olderThanMs < 0) {
    return `sweep: olderThanMs (${String(input.olderThanMs)}) must be an integer ≥ 0 — the age cutoff in milliseconds`;
  }
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') {
    return 'sweep: dryRun must be a boolean when present (it defaults to true)';
  }
  if (input.force !== undefined && typeof input.force !== 'boolean') {
    return 'sweep: force must be a boolean when present — the explicit dirty-removal flag';
  }
  if (input.mutex !== undefined) {
    // A null/non-object mutex is reachable from an untyped caller past any
    // schema — a `failed` result at this boundary, never a TypeError at the
    // lockPath read.
    if (input.mutex === null || typeof input.mutex !== 'object') {
      return 'sweep: mutex must be an object with a non-empty lockPath';
    }
    if (typeof input.mutex.lockPath !== 'string' || input.mutex.lockPath === '') {
      return 'sweep: mutex.lockPath must be a non-empty string';
    }
    // Mutex timing bounds mirror makeGitMutex's construction preconditions
    // (staleMs ≥ 2000 is proper-lockfile's real clamp floor): a malformed
    // timing is caught HERE as a `failed` result, at the op boundary.
    if (
      input.mutex.staleMs !== undefined &&
      (!Number.isInteger(input.mutex.staleMs) || input.mutex.staleMs < 2000)
    ) {
      return `sweep: mutex.staleMs (${String(input.mutex.staleMs)}) must be an integer ≥ 2000 — proper-lockfile clamps the stale window to that floor`;
    }
    if (
      input.mutex.retries !== undefined &&
      (!Number.isInteger(input.mutex.retries) || input.mutex.retries < 0)
    ) {
      return `sweep: mutex.retries (${String(input.mutex.retries)}) must be an integer ≥ 0`;
    }
    if (
      input.mutex.retryBaseMs !== undefined &&
      (!Number.isInteger(input.mutex.retryBaseMs) || input.mutex.retryBaseMs < 1)
    ) {
      return `sweep: mutex.retryBaseMs (${String(input.mutex.retryBaseMs)}) must be an integer ≥ 1`;
    }
  }
  return null;
}

/**
 * Control characters (the Unicode Cc category: C0, DEL, C1) —
 * newline/carriage-return above all: git's `worktree list --porcelain` is
 * LINE-oriented, and one of these in a compared value would corrupt the
 * framing (the worktreeFor jCoNL treatment, re-declared locally).
 */
const CONTROL_CHARS_RE = /[\p{Cc}]/u;

/**
 * A safe single path segment (the worktreeFor SEGMENT_RE): starts with a
 * letter/digit, then letters, digits, dots, dashes, underscores — no
 * separators, no leading dash.
 */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A '..' run walks refs and a '.lock' suffix collides with the loose-ref lock file. */
function refnameUnsafeSegment(segment: string): boolean {
  return segment.includes('..') || segment.endsWith('.lock');
}

/** Bind the input's mutex config, keeping absent timings absent (the mutex's own defaults stand). */
function mutexConfigOf(mutex: WorktreeMutexConfig): GitMutexConfig {
  const config: GitMutexConfig = { lockPath: mutex.lockPath };
  if (mutex.staleMs !== undefined) config.staleMs = mutex.staleMs;
  if (mutex.retries !== undefined) config.retries = mutex.retries;
  if (mutex.retryBaseMs !== undefined) config.retryBaseMs = mutex.retryBaseMs;
  return config;
}

/**
 * CANONICALIZED path comparison (the worktreeFor realpathOf idiom,
 * re-declared locally so worktreeFor.ts stays untouched): `git worktree
 * list --porcelain` reports REALPATH'd paths (macOS /tmp → /private/tmp),
 * so lexical comparisons break under symlinked components. Resolves through
 * realpath; an ABSENT target falls back to the lexical path.
 */
async function realpathOf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Auto-maintenance suppression, copied VERBATIM from the worktreeFor
 * sibling's runGit (its GIT_NO_AUTO_MAINTENANCE const and prepend — the
 * proven treatment for the detached background `gc --auto` /
 * `maintenance run --auto` hang class that inherits our stdio pipes).
 */
const GIT_NO_AUTO_MAINTENANCE = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];

/** Generous capture ceiling — a big listing must not truncate into a fault. */
const CLEANUP_GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** The default wall-clock cap for one git subprocess (the family's 600_000ms default). */
const CLEANUP_GIT_TIMEOUT_MS = 600_000;

/**
 * Run git with an execFile ARGS ARRAY — never a shell string, so no value
 * can be re-parsed as shell syntax (the repo's tooling convention). A
 * non-zero exit, a spawn failure, or a run exceeding {@link timeoutMs}
 * (SIGKILL) rejects with the captured stderr text.
 */
function runCleanupGit(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_NO_AUTO_MAINTENANCE, ...args],
      {
        cwd,
        maxBuffer: CLEANUP_GIT_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          // The SHARED family fault mapping (worktreeFor's): distinguishes
          // the maxBuffer-overflow class (which also sets `killed`) from a
          // timeout SIGKILL, and names the mechanism — a weakened local
          // branch would misreport an output limit as a timeout.
          reject(mapWorktreeGitFault(args, error, stderr, timeoutMs));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Per-call timeout options of {@link makeSubprocessCleanupEffects}; absent
 * fields fall back to the shipped default (10 minutes, the family default).
 */
export interface SubprocessCleanupEffectsOptions {
  timeoutMs?: number;
}

/**
 * The REAL effects binding of the cleanup op (the registry importer's
 * input-driven binding; constructed fresh per dispatch, bound to the
 * dispatched input's repoRoot where an effect needs one). The listings and
 * the strict-clean probe REUSE the worktreeFor adapter (the same porcelain /
 * for-each-ref parsers and the same `git status --porcelain` EMPTY probe);
 * age is the worktree dir's mtime; branch age is the tip's committer date;
 * removal is `git worktree remove [<path>]` — WITHOUT `opts.force` git
 * itself refuses a dirty tree, the adapter-level backstop under the op's
 * clean-check; `--force` is built ONLY when the op's explicit force reached
 * the effect. Every effect is a fresh lazy call, and every git call — the
 * reused listings and strict-clean probe INCLUDED — is bounded by
 * {@link SubprocessCleanupEffectsOptions.timeoutMs} (the shipped
 * {@link CLEANUP_GIT_TIMEOUT_MS} default when absent): a hung git is
 * SIGKILLed and reported, never awaited forever. A library consumer injects
 * fakes instead (every decision test does exactly that).
 */
export function makeSubprocessCleanupEffects(
  repoRoot: string,
  timeouts?: SubprocessCleanupEffectsOptions,
): CleanupEffects {
  const timeoutMs = timeouts?.timeoutMs ?? CLEANUP_GIT_TIMEOUT_MS;
  const listings = makeSubprocessWorktreeEffects(repoRoot, { timeoutMs });
  return {
    listWorktrees: listings.listWorktrees,
    listBranches: listings.listBranches,
    modifiedTimeMs: async (path) => (await stat(path)).mtimeMs,
    isStrictClean: listings.isStrictClean,
    worktreeRemove: async (root, path, opts) => {
      const args =
        opts?.force === true
          ? ['worktree', 'remove', '--force', path]
          : ['worktree', 'remove', path];
      await runCleanupGit(args, root, timeoutMs);
    },
    branchDelete: async (root, branch) => {
      await runCleanupGit(['branch', '-D', branch], root, timeoutMs);
    },
    worktreePrune: async (root) => {
      await runCleanupGit(['worktree', 'prune'], root, timeoutMs);
    },
    branchTimeMs: async (root, branch) => {
      const out = await runCleanupGit(
        ['for-each-ref', '--format=%(committerdate:unix)', `refs/heads/${branch}`],
        root,
        timeoutMs,
      );
      const seconds = Number(out.trim());
      if (out.trim() === '' || !Number.isFinite(seconds)) {
        // An unageable branch is never silently treated as aged.
        throw new Error(`branch '${branch}' has no committer date — it is not a local head`);
      }
      return seconds * 1000;
    },
  };
}
