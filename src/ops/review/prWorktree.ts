// prWorktree — E3 slice 3 (goal E3; UC §2 row 38): resolve THE worktree for
// a PR — reuse the tree already checked out on the PR's branch, else create
// one. The ORIGIN PR BRANCH IS TRUTH: the branch is fetched from origin
// before any resolution decision, so every path below acts on what the
// remote actually has, not on local memory.
//
// DOMAIN BOUNDARY (asserted, not incidental): this is the REVIEW-OPS
// worktree — keyed by PR, rooted at `<repoRoot>/.cq-review-worktrees`. It is
// NOT the package-keyed sweep worktree: `createOrReuseWorktree` in the sweep
// ops family is a different domain with different keys and a different
// lifetime, and review ops must never consult it (and vice versa). The test
// suite pins this rule by name.
//
// Resolution order (each step pinned by a test):
//   a. `git -C <repoRoot> fetch origin <headRefName>` — nonzero → THROW:
//      the branch's truth is unavailable and nothing must be guessed.
//   b. Registry consult: an entry for the pr that still POINTS AT TRUTH
//      (directory exists AND `git -C <entryPath> rev-parse --abbrev-ref
//      HEAD` prints headRefName) → reuse it. Any check failing means the
//      entry is STALE — it is pruned from the registry and resolution
//      continues (the registry is a cache, never the evidence).
//   c. Existing-worktree scan (`git worktree list --porcelain`, parsed
//      blocks): a worktree already checked out on headRefName is REGISTERED
//      and reused — `git worktree add` refuses an already-checked-out
//      branch, so when the branch is checked out anywhere, reuse is the
//      only move (UC row 38).
//   d. Create: `git -C <repoRoot> worktree add <worktreeRoot>/<sanitized-
//      branch> <headRefName>`; register and return it as NOT reused.
//
// The `[A-Za-z0-9._-]` sanitization: branch names are user data ("release/
// 1.0 +fix me") and the worktree directory name must stay one path segment —
// every character outside [A-Za-z0-9._-] becomes '-', so `/` cannot smuggle
// a directory hop and spaces/metacharacters cannot reach a shell (argv-only
// spawns anyway — this keeps the name boring, not the process safe).
//
// I/O discipline: ALL git I/O goes through the injected `run` (the same
// GhFn shape as gh.ts — a generic command runner; the bin is the caller's
// convention, typically makeGhRunner({ bin: 'git' }) or a fake). Because
// that runner spawns with the PROCESS cwd, repoRoot has effect only through
// explicit `-C <repoRoot>` prefixes (and `-C <entryPath>` for the registry
// rev-parse) — the module never assumes where it runs. All persistence goes
// through the injected WorktreeRegistry; the clock is injected (nowMs,
// never Date.now); the only direct fs touch is the worktreeRoot mkdir and
// the registry entry's directory-existence check.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GhFn } from './gh.js';

/** One registry entry: where the PR's worktree lives and what it is on. */
export interface WorktreeRegistryEntry {
  /** Absolute worktree directory. */
  path: string;
  /** The branch the entry believes is checked out there. */
  branch: string;
  /** When the entry was (re)registered: the injected nowMs of that run. */
  createdAt: number;
}

/**
 * The PR → worktree registry. Keys are PR numbers as DECIMAL STRINGS
 * (JSON object keys are strings by definition). A cache of step-b's
 * pointers — never evidence: every load re-verifies against the filesystem
 * and git before trusting an entry.
 */
export type RegistryMap = Record<string, WorktreeRegistryEntry>;

/** The registry persistence seam (injectable; tests use an in-memory map). */
export interface WorktreeRegistry {
  load(): Promise<RegistryMap>;
  save(map: RegistryMap): Promise<void>;
}

/**
 * The file-backed WorktreeRegistry: one JSON object mapping decimal PR
 * number strings to entries. A MISSING file is an empty registry (first
 * run); a CORRUPT file (unparseable JSON, or not a plain object) throws a
 * clear error — resolving worktrees on top of an unreadable registry would
 * silently duplicate trees. `save` rewrites the whole file.
 */
export function fileWorktreeRegistry(path: string): WorktreeRegistry {
  const load = async (): Promise<RegistryMap> => {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw err;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not a JSON object');
      }
      return parsed as RegistryMap;
    } catch {
      throw new Error(
        `fileWorktreeRegistry: worktree registry at ${JSON.stringify(path)} is corrupt — refusing to resolve worktrees against an unreadable registry; fix or remove the file and re-run`,
      );
    }
  };
  const save = async (map: RegistryMap): Promise<void> => {
    await writeFile(path, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  };
  return { load, save };
}

/** What resolvePrWorktree/removePrWorktree need — everything injected. */
export interface PrWorktreeOpts {
  /** The checked-out repository the PR branch belongs to (git -C target). */
  repoRoot: string;
  /** The PR number (the registry key, as a decimal string). */
  pr: number;
  /** The PR's head branch name (origin truth, fetched in step a). */
  headRefName: string;
  /**
   * The generic command runner — the SAME GhFn shape as gh.ts, resolving
   * with the exit code instead of throwing. The spawned bin is the caller's
   * convention: `makeGhRunner({ bin: 'git' })` for the real thing, a fake
   * in tests. All git I/O rides it.
   */
  run: GhFn;
  /** The PR → worktree registry (persistence seam). */
  registry: WorktreeRegistry;
  /** The injected clock stamping registry entries — never Date.now. */
  nowMs: number;
  /** Root for created worktrees; defaults to `<repoRoot>/.cq-review-worktrees`. */
  worktreeRoot?: string;
}

/** Branch-name characters allowed to survive into a directory name. */
const SANITIZE_OK = /[^A-Za-z0-9._-]/g;

/** GhError-shaped failure message for a git invocation (plain Error — the
 * runner here is git, not gh, so the message must not claim otherwise). */
const gitFail = (why: string, code: number, stderr: string, args: string[]): Error => {
  const argv = args.map((arg) => JSON.stringify(arg)).join(' ');
  const trimmed = stderr.trim();
  return new Error(`git ${why} (exit ${code}): git ${argv}${trimmed === '' ? '' : `\nstderr: ${trimmed}`}`);
};

/** One parsed `worktree list --porcelain` block. */
interface PorcelainWorktree {
  path: string;
  /** refs/heads/ branch name, or null when detached/bare. */
  branch: string | null;
}

/**
 * Parse `git worktree list --porcelain` output: blank-line-separated
 * blocks of `worktree <path>` / `HEAD <sha>` / `branch refs/heads/<name>`
 * (or `detached`/`bare` — no branch). Only the path and the heads/-stripped
 * branch are read; blocks without a worktree line are ignored.
 */
const parseWorktreeList = (text: string): PorcelainWorktree[] => {
  const out: PorcelainWorktree[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;
    let path: string | null = null;
    let branch: string | null = null;
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length);
      } else if (line.startsWith('branch refs/heads/')) {
        branch = line.slice('branch refs/heads/'.length);
      }
    }
    if (path !== null) {
      out.push({ path, branch });
    }
  }
  return out;
};

/** True only when `path` exists AND is a directory (the registry-dir check). */
const directoryExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    throw err;
  }
};

/** Validate the shared opts, fail loud before any I/O (E1/E3 convention).
 * headRefName gets only the local safety checks (non-empty, never reads as
 * an argv flag) — ref-NAME validity is git's business: a name git rejects
 * fails the step-a fetch nonzero, which throws with git's stderr. */
const validateOpts = (opts: PrWorktreeOpts): void => {
  if (opts.repoRoot === '') {
    throw new Error('resolvePrWorktree: repoRoot must be a non-empty string');
  }
  if (!Number.isSafeInteger(opts.pr) || opts.pr <= 0) {
    throw new Error(`resolvePrWorktree: pr must be a positive safe integer — got ${JSON.stringify(opts.pr)}`);
  }
  if (opts.headRefName === '' || opts.headRefName.startsWith('-')) {
    throw new Error(
      `resolvePrWorktree: headRefName must be a non-empty ref name and must not start with '-' — got ${JSON.stringify(opts.headRefName)}`,
    );
  }
};

/**
 * Resolve THE worktree for a PR (UC row 38): fetch the origin branch
 * (truth first), reuse the registry entry when it still points at reality,
 * reuse any worktree already checked out on the branch (git refuses adding
 * a second checkout of one branch — reuse is the only move there), else
 * create one under worktreeRoot. See the module doc for the full ordered
 * contract; every step is pinned by a test. `reused` distinguishes an
 * existing tree (true) from one this call created (false).
 */
export async function resolvePrWorktree(opts: PrWorktreeOpts): Promise<{ path: string; reused: boolean; branch: string }> {
  validateOpts(opts);
  const worktreeRoot = opts.worktreeRoot ?? join(opts.repoRoot, '.cq-review-worktrees');
  const key = String(opts.pr);

  // (a) ORIGIN BRANCH IS TRUTH — fetched before any decision. A fetch
  // failure means the branch's state is unknown: throw, touch nothing.
  const fetchArgs = ['-C', opts.repoRoot, 'fetch', 'origin', opts.headRefName];
  const fetch = await opts.run(fetchArgs);
  if (fetch.code !== 0) {
    throw gitFail(
      `fetch origin ${opts.headRefName} failed — the origin PR branch is truth and cannot be resolved`,
      fetch.code,
      fetch.stderr,
      fetchArgs,
    );
  }

  const map = await opts.registry.load();

  // (b) Registry consult — the entry must still POINT AT TRUTH: the
  // directory exists AND git says headRefName is checked out there.
  const entry = map[key];
  if (entry !== undefined) {
    const valid =
      (await directoryExists(entry.path)) &&
      (await (async () => {
        const revParseArgs = ['-C', entry.path, 'rev-parse', '--abbrev-ref', 'HEAD'];
        const result = await opts.run(revParseArgs);
        return result.code === 0 && result.stdout.trim() === opts.headRefName;
      })());
    if (valid) {
      return { path: entry.path, reused: true, branch: opts.headRefName };
    }
    // Stale (dir gone / wrong branch / unresolvable): prune and move on —
    // the registry is a cache, never the evidence.
    delete map[key];
    await opts.registry.save(map);
  }

  // (c) Existing-worktree scan: someone may already have the branch checked
  // out (the main tree, another worktree) — `git worktree add` REFUSES an
  // already-checked-out branch, so reuse is the only move (UC row 38).
  const listArgs = ['-C', opts.repoRoot, 'worktree', 'list', '--porcelain'];
  const list = await opts.run(listArgs);
  if (list.code !== 0) {
    throw gitFail('worktree list failed', list.code, list.stderr, listArgs);
  }
  const existing = parseWorktreeList(list.stdout).find((wt) => wt.branch === opts.headRefName);
  if (existing !== undefined) {
    map[key] = { path: existing.path, branch: opts.headRefName, createdAt: opts.nowMs };
    await opts.registry.save(map);
    return { path: existing.path, reused: true, branch: opts.headRefName };
  }

  // (d) Create: one directory per branch, sanitized to a single boring path
  // segment (see module doc); the root is created on demand. Nonzero add →
  // throw with stderr — nothing is registered for a tree that does not exist.
  await mkdir(worktreeRoot, { recursive: true });
  const wtPath = join(worktreeRoot, opts.headRefName.replace(SANITIZE_OK, '-'));
  const addArgs = ['-C', opts.repoRoot, 'worktree', 'add', wtPath, opts.headRefName];
  const add = await opts.run(addArgs);
  if (add.code !== 0) {
    throw gitFail(`worktree add ${wtPath} ${opts.headRefName} failed`, add.code, add.stderr, addArgs);
  }
  map[key] = { path: wtPath, branch: opts.headRefName, createdAt: opts.nowMs };
  await opts.registry.save(map);
  return { path: wtPath, reused: false, branch: opts.headRefName };
}

/**
 * Remove a PR worktree — the cleanup PRIMITIVE for callers whose flow must
 * guarantee removal: wrap the work in try/finally and call this in finally
 * (the executeMerges doctrine; this module provides the primitive, not the
 * policy). NO --force by default: review ops never silently destroys trees
 * — when git refuses (dirty, locked, …) the error is RETHROWN with git's
 * stderr and the caller decides (retry, force deliberately, or leave it).
 * The registry entry is pruned ONLY after git actually removed the tree.
 */
export async function removePrWorktree(opts: PrWorktreeOpts & { path: string }): Promise<void> {
  validateOpts(opts);
  const removeArgs = ['-C', opts.repoRoot, 'worktree', 'remove', opts.path];
  const result = await opts.run(removeArgs);
  if (result.code !== 0) {
    throw gitFail(
      `worktree remove ${opts.path} failed (dirty or locked trees are left in place — the caller decides)`,
      result.code,
      result.stderr,
      removeArgs,
    );
  }
  const map = await opts.registry.load();
  delete map[String(opts.pr)];
  await opts.registry.save(map);
}
