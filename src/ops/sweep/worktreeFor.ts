// Sweep lane (WS-D, goal D1) — the worktree PROVIDER (ADOPT git worktree +
// thin COPY; UC §1 rows 20, 23; R2 D2): derive the run's branch and checkout
// path from config-grade naming inputs, RESERVE the namespace (refuse, never
// mint — the run-prefix scheme is the caller's), REUSE an existing tree only
// when it is STRICTLY clean (dirty candidates are refused loudly — salvage
// is D2's business, never auto-clean, UC row 20), else CREATE via
// `git worktree add`. The DECISION core is effects-only: zero
// child_process here — every git touch arrives through the injected
// {@link WorktreeEffects}, and every git-MUTATING section (prune, add,
// baseline-cache eviction) runs inside {@link makeGitMutex} when the input
// configures one (UC row 32). The shipped effects adapter is
// {@link makeSubprocessWorktreeEffects}, the registry importer's binding.
//
// Invariants honored here:
//   - UC row 23: the namespace is RESERVED, not generated — an existing
//     branch (local or remote), worktree path, or plain directory is a
//     `failed` result naming the namespace; this op checks and refuses,
//     never mints fresh prefixes.
//   - UC row 20: a dirty reused candidate is refused with the tree named —
//     never silently cleaned, never silently skipped.
//   - I7: the baseline is never cached on reuse — a reused tree is returned
//     only after its configured baseline cache dirs are evicted (listed in
//     clearedBaselineCaches), so the caller must RE-PROBE the baseline for
//     every reused tree; the create path carries an empty eviction list.
//   - Derived paths cannot escape worktreesDir: kind/slug/runPrefix must be
//     safe path segments (no separators, no '..', no leading dash — which
//     also keeps them out of git's flag namespace in the args array).
import { execFile } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Op } from '../../kernel/types.js';
import { makeGitMutex } from './gitMutex.js';
import type { GitMutex, GitMutexConfig } from './gitMutex.js';

/** JSON-serializable input of the `sweep.worktreeFor` op. */
export interface WorktreeForInput {
  /** Repository the worktree checks out FROM (git -C repoRoot worktree add …). */
  repoRoot: string;
  /**
   * Parent dir for worktree checkouts — CONFIG-GRADE: the legacy
   * `<repo>/../worktrees/cq` layout is an assumption, not a constant.
   * ABSOLUTE or REPO-ROOT-RELATIVE: a relative dir is resolved against
   * `repoRoot`, and the derived `Workspace.path` is always ABSOLUTE —
   * `git worktree list --porcelain` reports absolute paths, so the
   * resolution is what makes a re-invoke reuse its own worktree instead of
   * colliding with itself.
   */
  worktreesDir: string;
  /** Reserved run prefix (e.g. `cq/09-16a`); may itself carry `/` segments. Naming is the caller's scheme. */
  runPrefix: string;
  /** Work kind segment (e.g. `fix`). */
  kind: string;
  /** Package slug segment. */
  slug: string;
  /** Branch or sha the worktree checks out. */
  base: string;
  /** When present, every git-mutating section runs inside the git mutex (UC row 32). */
  mutex?: WorktreeMutexConfig;
  /**
   * Repo-root-relative cache dirs (e.g. `.cq/baseline`) evicted from a
   * REUSED tree — I7: the baseline is never cached on reuse; the caller
   * re-probes. Each entry must be a NORMALIZED non-empty RELATIVE path
   * ('' / '.' / absolute / any '..' segment refused), and its resolution
   * against the worktree path must land STRICTLY INSIDE the tree — a
   * refused entry is never touched on disk and is listed in the result's
   * `refusedBaselineCaches`. Only ignored/untracked tool state should live
   * here: a TRACKED file under one of these paths would make the tree dirty
   * long before eviction, and dirty reuse is refused (UC row 20).
   */
  baselineCacheDirs?: string[];
}

/** The git-mutex binding of {@link WorktreeForInput}; timings fall back to the mutex defaults. */
export interface WorktreeMutexConfig {
  lockPath: string;
  staleMs?: number;
  retries?: number;
  retryBaseMs?: number;
}

/** The provider's report: where the tree lives and how it was obtained. Plain JSON. */
export interface Workspace {
  /** The checkout path — always ABSOLUTE (a relative worktreesDir is resolved against repoRoot). */
  path: string;
  /** The derived branch `<runPrefix>/<kind>/<slug>`. */
  branch: string;
  /** The base the tree checks out (verbatim input). */
  base: string;
  /** true when an existing strictly-clean tree was reused; false when freshly created. */
  reused: boolean;
  /** I7: baseline cache dirs evicted from a reused tree (input-relative names). Empty on create. */
  clearedBaselineCaches: string[];
  /** I7 security: baseline cache entries REFUSED by containment (never touched on disk). Empty when none. */
  refusedBaselineCaches: string[];
}

/**
 * Request of the {@link WorktreeEffects.worktreeAdd} effect: create the
 * worktree at `path` with a NEW branch `branch` at `base`.
 */
export interface WorktreeAddRequest {
  repoRoot: string;
  path: string;
  branch: string;
  base: string;
}

/**
 * The injected git seam — the ONE place this lane touches git. All effects
 * are lazy per call (no caching of git state between calls); tests inject
 * fakes, production binds {@link makeSubprocessWorktreeEffects}.
 */
export interface WorktreeEffects {
  /** Local worktrees from `git worktree list --porcelain`; `branch` is undefined for detached/bare entries. */
  listWorktrees(): Promise<Array<{ path: string; branch?: string }>>;
  /** Short names of local branches (`git for-each-ref refs/heads`). */
  listBranches(): Promise<string[]>;
  /** Short names of origin's heads (`git ls-remote --heads origin`) — network-touching, still lazy per call. */
  listRemoteBranches(): Promise<string[]>;
  pathExists(p: string): Promise<boolean>;
  /** STRICT clean: `git status --porcelain` EMPTY semantics — untracked files count as dirty. */
  isStrictClean(worktreePath: string): Promise<boolean>;
  worktreeAdd(input: WorktreeAddRequest): Promise<void>;
  worktreePrune(repoRoot: string): Promise<void>;
  rmDir(p: string): Promise<void>;
}

/**
 * A safe single path segment: starts with a letter/digit, then letters,
 * digits, dots, dashes, underscores. No separators (the derived path cannot
 * escape worktreesDir), no leading dash (a derived branch or base must
 * never be mistakable for a git flag — the subprocess adapter passes args
 * as an ARRAY, and this keeps even a hostile config from trying).
 */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Build the `sweep.worktreeFor` op over injected git effects. Derived
 * naming: branch `<runPrefix>/<kind>/<slug>`, path
 * `<worktreesDir>/<kind>/<slug>` (posix join of validated segments).
 *
 * Per call, in order: (a) RESERVATION — unless a reuse candidate exists,
 * every namespace must be empty: a local worktree on the derived path, the
 * derived branch among local branches, among origin's heads, or a plain
 * directory at the derived path — each a `failed` result naming the
 * namespace (UC row 23; the caller's run-prefix scheme mints fresh
 * prefixes, this op only refuses). A branch checked out at a DIFFERENT
 * path than derived is also a collision (an anomaly, refused loudly).
 * (b) REUSE — a worktree at exactly the derived branch AND path is reused
 * only when strictly clean (`git status --porcelain` empty, untracked
 * included); dirty is `failed` naming the tree (UC row 20 — never
 * auto-cleaned; salvage is D2's business). (c) CREATE — `git worktree
 * prune` then `git worktree add -b <branch> <path> <base>`, both inside
 * the git mutex when configured. (d) I7 — before a reused tree is
 * returned, every configured `baselineCacheDirs` present in the tree is
 * removed and listed in `clearedBaselineCaches`: the caller must re-probe
 * the baseline for every reused tree; the create path carries an empty
 * list. Every effects fault is a `failed` result — never a throw across
 * the op seam.
 */
export function makeWorktreeFor(git: WorktreeEffects): Op<WorktreeForInput, Workspace> {
  return async (input) => {
    const fault = inputFaultOf(input);
    if (fault !== null) return { status: 'failed', error: fault };
    const branch = `${input.runPrefix}/${input.kind}/${input.slug}`;
    // The derived path is ABSOLUTE: a relative worktreesDir resolves
    // against repoRoot, because `git worktree list --porcelain` records
    // absolute paths — without the resolution a re-invoke would fail to
    // match its own worktree and collide with itself.
    const path = resolve(input.repoRoot, input.worktreesDir, input.kind, input.slug);
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
    const candidate = worktrees.find((w) => w.branch === branch);
    if (candidate !== undefined) {
      // REUSE requires the tree at the DERIVED path: a branch checked out
      // elsewhere is an anomaly, and returning a Workspace pointing at a
      // path the caller did not derive would be a silent lie.
      if (candidate.path !== path) {
        return {
          status: 'failed',
          error: `sweep: branch '${branch}' is checked out at '${candidate.path}', not the derived worktree path '${path}' — path namespace collision (UC row 23)`,
        };
      }
      let clean: boolean;
      try {
        clean = await git.isStrictClean(candidate.path);
      } catch (err) {
        return {
          status: 'failed',
          error: `sweep: could not check '${candidate.path}' for a strictly clean tree — ${messageOf(err)}`,
        };
      }
      if (!clean) {
        return {
          status: 'failed',
          error: `sweep: worktree '${candidate.path}' on branch '${branch}' is dirty (git status --porcelain non-empty, untracked files included) — refusing reuse; salvage is the caller's next step, never auto-clean (UC row 20)`,
        };
      }
      // I7: the baseline is never cached on reuse — evict, list, and hand
      // the caller a tree it must re-probe. Every entry passes the
      // containment check FIRST: a refused entry is never touched on disk
      // (no stat, no rm) and only listed.
      const clearedBaselineCaches: string[] = [];
      const refusedBaselineCaches: string[] = [];
      for (const rel of input.baselineCacheDirs ?? []) {
        const containmentFault = baselineCacheContainmentFault(rel, candidate.path);
        if (containmentFault !== null) {
          refusedBaselineCaches.push(rel);
          continue;
        }
        const inTree = resolve(candidate.path, rel);
        let exists: boolean;
        try {
          exists = await git.pathExists(inTree);
        } catch (err) {
          return {
            status: 'failed',
            error: `sweep: could not check for baseline cache '${inTree}' — ${messageOf(err)}`,
          };
        }
        if (!exists) continue;
        try {
          await inGuard(() => git.rmDir(inTree));
        } catch (err) {
          return {
            status: 'failed',
            error: `sweep: could not evict baseline cache '${inTree}' — ${messageOf(err)}`,
          };
        }
        clearedBaselineCaches.push(rel);
      }
      return {
        status: 'ok',
        value: {
          path: candidate.path,
          branch,
          base: input.base,
          reused: true,
          clearedBaselineCaches,
          refusedBaselineCaches,
        },
      };
    }

    // RESERVATION (UC row 23): no reuse candidate — every namespace must be
    // empty, and each collision is refused naming its namespace.
    const occupant = worktrees.find((w) => w.path === path);
    if (occupant !== undefined) {
      return {
        status: 'failed',
        error: `sweep: worktree path '${path}' is already a local worktree on branch '${occupant.branch ?? '(detached)'}' — path namespace collision (UC row 23)`,
      };
    }
    let localBranches: string[];
    try {
      localBranches = await git.listBranches();
    } catch (err) {
      return {
        status: 'failed',
        error: `sweep: could not list local branches — ${messageOf(err)}`,
      };
    }
    if (localBranches.includes(branch)) {
      return {
        status: 'failed',
        error: `sweep: branch '${branch}' already exists as a local branch — branch namespace collision (UC row 23); the caller's run-prefix scheme mints fresh prefixes, this op only refuses`,
      };
    }
    let remoteBranches: string[];
    try {
      remoteBranches = await git.listRemoteBranches();
    } catch (err) {
      return {
        status: 'failed',
        error: `sweep: could not list remote branches — ${messageOf(err)}`,
      };
    }
    if (remoteBranches.includes(branch)) {
      return {
        status: 'failed',
        error: `sweep: branch '${branch}' already exists on the remote — remote branch namespace collision (UC row 23)`,
      };
    }
    let dirExists: boolean;
    try {
      dirExists = await git.pathExists(path);
    } catch (err) {
      return {
        status: 'failed',
        error: `sweep: could not check for an existing directory at '${path}' — ${messageOf(err)}`,
      };
    }
    if (dirExists) {
      return {
        status: 'failed',
        error: `sweep: worktree path '${path}' already exists as a directory — path namespace collision (UC row 23)`,
      };
    }

    // CREATE: prune stale registrations, then add with a NEW branch at the
    // base — one git-mutating section, inside the mutex when configured.
    try {
      await inGuard(async () => {
        await git.worktreePrune(input.repoRoot);
        await git.worktreeAdd({ repoRoot: input.repoRoot, path, branch, base: input.base });
      });
    } catch (err) {
      return {
        status: 'failed',
        error: `sweep: could not create worktree '${path}' on branch '${branch}' at base '${input.base}' — ${messageOf(err)}`,
      };
    }
    return {
      status: 'ok',
      value: {
        path,
        branch,
        base: input.base,
        reused: false,
        clearedBaselineCaches: [],
        refusedBaselineCaches: [],
      },
    };
  };
}

/**
 * Containment check for one `baselineCacheDirs` entry (the I7 security
 * boundary): the entry must be a normalized non-empty RELATIVE path — ''
 * / '.' / an absolute path / any '..' or empty segment is refused — and its
 * resolution against the worktree path must land STRICTLY INSIDE the tree.
 * The containment comparison is relative()-to-relative() with the
 * separator-aware escape check, which is what guards the prefix-collision
 * class ('wt' vs 'wt-x': a target under the SIBLING yields a '../' relative
 * form and is refused). Returns null when contained, else the refusal
 * reason — the caller lists the entry and never touches the disk for it.
 */
function baselineCacheContainmentFault(entry: string, worktreePath: string): string | null {
  if (typeof entry !== 'string' || entry === '') {
    return 'must be a non-empty string';
  }
  if (entry === '.') {
    return "'.' is not a cache path";
  }
  if (isAbsolute(entry)) {
    return 'absolute paths are refused';
  }
  const segments = entry.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'must be a normalized relative path — segments non-empty, never "." or ".."';
  }
  const rel = relative(worktreePath, resolve(worktreePath, entry));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return 'resolves outside the worktree';
  }
  return null;
}

/** Library-level input contract; the registry schema (next slice) mirrors it for JSON dispatch. */
function inputFaultOf(input: WorktreeForInput): string | null {
  for (const [field, value] of [
    ['repoRoot', input.repoRoot],
    ['worktreesDir', input.worktreesDir],
    ['runPrefix', input.runPrefix],
    ['kind', input.kind],
    ['slug', input.slug],
    ['base', input.base],
  ] as const) {
    if (typeof value !== 'string' || value === '') {
      return `sweep: ${field} must be a non-empty string`;
    }
  }
  // kind/slug are single segments; runPrefix may nest, but every segment is
  // held to the same safe-segment rule, so the derived branch and path can
  // neither escape worktreesDir nor impersonate a git flag.
  if (!SEGMENT_RE.test(input.kind)) {
    return `sweep: kind '${input.kind}' must be one safe path segment (${SEGMENT_RE.source}) — no separators, no '..', no leading dash`;
  }
  if (!SEGMENT_RE.test(input.slug)) {
    return `sweep: slug '${input.slug}' must be one safe path segment (${SEGMENT_RE.source}) — path traversal out of worktreesDir is refused`;
  }
  for (const segment of input.runPrefix.split('/')) {
    if (!SEGMENT_RE.test(segment)) {
      return `sweep: runPrefix '${input.runPrefix}' must be '/'-joined safe segments (${SEGMENT_RE.source}) — path traversal is refused`;
    }
  }
  if (input.base.startsWith('-')) {
    return `sweep: base '${input.base}' must not start with '-' — it is a positional git argument, never a flag`;
  }
  // The DERIVED PATH is a positional git argument too: `<worktreesDir>/…`
  // lands verbatim in `worktree add -b <branch> <path> <base>`, so a
  // worktreesDir starting with '-' would inject it as a flag.
  if (input.worktreesDir.startsWith('-')) {
    return `sweep: worktreesDir '${input.worktreesDir}' must not start with '-' — the derived path is a positional git argument, never a flag`;
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
    // timing is caught HERE as a `failed` result, at the op boundary — the
    // op never lets the factory's RangeError escape as a rejected promise.
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

/** Bind the input's mutex config, keeping absent timings absent (the mutex's own defaults stand). */
function mutexConfigOf(mutex: WorktreeMutexConfig): GitMutexConfig {
  const config: GitMutexConfig = { lockPath: mutex.lockPath };
  if (mutex.staleMs !== undefined) config.staleMs = mutex.staleMs;
  if (mutex.retries !== undefined) config.retries = mutex.retries;
  if (mutex.retryBaseMs !== undefined) config.retryBaseMs = mutex.retryBaseMs;
  return config;
}

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse `git worktree list --porcelain` output: BLOCKS of `worktree <path>`
 * plus attribute lines (`HEAD`, `branch refs/heads/<b>`, `bare`,
 * `detached`, …) separated by blank lines. Only two fields matter here —
 * the path and, when the entry is on a branch, the short branch name;
 * detached and bare entries carry no `branch` line and come back with
 * `branch` undefined.
 */
export function parseWorktreePorcelain(text: string): Array<{ path: string; branch?: string }> {
  const worktrees: Array<{ path: string; branch?: string }> = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      worktrees.push({ path: line.slice('worktree '.length) });
    } else if (line.startsWith('branch refs/heads/')) {
      const current = worktrees[worktrees.length - 1];
      if (current !== undefined && current.branch === undefined) {
        current.branch = line.slice('branch refs/heads/'.length);
      }
    }
  }
  return worktrees;
}

/** Parse `git for-each-ref --format=%(refname:short) refs/heads`: one short branch name per non-empty line. */
export function parseBranchRefs(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Parse `git ls-remote --heads origin`: `<sha>\trefs/heads/<name>` rows → short branch names. */
export function parseRemoteHeads(text: string): string[] {
  const heads: string[] = [];
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const ref = line.slice(tab + 1);
    if (ref.startsWith('refs/heads/')) heads.push(ref.slice('refs/heads/'.length));
  }
  return heads;
}

/** Generous capture ceiling — a big for-each-ref/ls-remote listing must not truncate into a fault. */
const GIT_OUTPUT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * The default wall-clock cap for one git subprocess (the checkRunner's
 * 600_000ms registry default). A hung git must surface as a REJECTION
 * naming the timeout — never an eternal await; the child is SIGKILLed.
 */
const DEFAULT_GIT_TIMEOUT_MS = 600_000;

/**
 * Auto-maintenance suppression, per invocation and never persisted. `git
 * commit` and `git worktree add` may fork a DETACHED background
 * `gc --auto` / `maintenance run --auto` that inherits our stdout/stderr
 * pipes; execFile's callback waits for stream CLOSE, so a long-lived
 * background job hangs the call past the command's own exit — and the auto
 * triggers are randomized, making the hang nondeterministic. These are
 * plumbing reads/mutations with no interest in gc, so the background jobs
 * are simply switched off for every call.
 */
const GIT_NO_AUTO_MAINTENANCE = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];

/**
 * Run git with an execFile ARGS ARRAY — never a shell string, so no config
 * value can be re-parsed as shell syntax (the repo's tooling convention).
 * A non-zero exit, a spawn failure, or a run exceeding {@link timeoutMs}
 * (SIGKILL) rejects with the captured stderr text.
 */
function runGit(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_NO_AUTO_MAINTENANCE, ...args],
      { cwd, maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error !== null) {
          const exit = typeof error.code === 'number' ? ` (exit ${String(error.code)})` : '';
          const timedOut = error.killed === true;
          reject(
            new Error(
              timedOut
                ? `git ${args[0] ?? 'git'} timed out after ${String(timeoutMs)}ms and was SIGKILLed — the git call never produced evidence`
                : `git ${args[0] ?? 'git'}${exit} failed — ${stderr.trim() !== '' ? stderr.trim() : error.message}`,
              { cause: error },
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Per-call timeout options of {@link makeSubprocessWorktreeEffects}; absent
 * fields fall back to the shipped default (10 minutes, the checkRunner
 * registry default).
 */
export interface SubprocessWorktreeEffectsOptions {
  timeoutMs?: number;
}

/**
 * The shipped effects adapter (the registry importer's binding in the next
 * slice): one bound `repoRoot`, every effect a fresh lazy git/fs call.
 * Strict-clean is `git status --porcelain` EMPTY (untracked files count);
 * add creates a NEW branch at the base; rmDir is a recursive forced fs rm
 * (worktree dirs and cache dirs are disposable tool state). Every git call
 * is bounded by {@link SubprocessWorktreeEffectsOptions.timeoutMs} — a hung
 * git is SIGKILLed and reported, never awaited forever.
 */
export function makeSubprocessWorktreeEffects(
  repoRoot: string,
  timeouts?: SubprocessWorktreeEffectsOptions,
): WorktreeEffects {
  const timeoutMs = timeouts?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  return {
    listWorktrees: async () =>
      parseWorktreePorcelain(
        await runGit(['worktree', 'list', '--porcelain'], repoRoot, timeoutMs),
      ),
    listBranches: async () =>
      parseBranchRefs(
        await runGit(
          ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
          repoRoot,
          timeoutMs,
        ),
      ),
    listRemoteBranches: async () =>
      parseRemoteHeads(await runGit(['ls-remote', '--heads', 'origin'], repoRoot, timeoutMs)),
    pathExists: async (p) => {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    },
    isStrictClean: async (worktreePath) =>
      (await runGit(['status', '--porcelain'], worktreePath, timeoutMs)).trim() === '',
    worktreeAdd: async (add) => {
      await runGit(
        ['worktree', 'add', '-b', add.branch, add.path, add.base],
        add.repoRoot,
        timeoutMs,
      );
    },
    worktreePrune: async (root) => {
      await runGit(['worktree', 'prune'], root, timeoutMs);
    },
    rmDir: async (p) => {
      await rm(p, { recursive: true, force: true });
    },
  };
}
