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
//      HEAD` prints headRefName AND `git -C <entryPath> rev-parse HEAD`
//      prints the fetched sha) → reuse it. A STALE entry is left in place
//      until a fresh resolution succeeds — the prune happens only AFTER a
//      successful create/register (the overwrite), so a run that wedges
//      mid-flight leaves the machine-readable pointer intact for the next
//      run instead of destroying it at the first failed check.
//   c. Existing-worktree scan (`git worktree list --porcelain`, parsed
//      blocks). The OWNERSHIP RULE: reuse is eligible only for trees INSIDE
//      worktreeRoot — branch+sha-valid trees OUTSIDE the root are never
//      claimed; they are surfaced in the result's `foreign` list (surface,
//      never claim). Within the root, a candidate must match the branch AND
//      sit at the fetched sha to be reused; a branch-matching tree at a
//      STALE sha is this module's own round-1 leftovers — it is REMOVED
//      non-forced (`worktree remove`, no --force; a dirty tree refuses and
//      its stderr propagates as the throw — the safe outcome) so the create
//      below can converge onto the same spot. Foreign trees are never
//      removed.
//   d. Create: `git -C <repoRoot> worktree add -B <headRefName>
//      <worktreeRoot>/pr-<pr>-<sanitized-branch> <expectedSha>` — the `-B`
//      (re)points the branch at the fetched truth and the new tree sits AT
//      the fetched sha, not at whatever the local ref remembered; register
//      (overwriting any stale entry — the post-success prune) and return it
//      as NOT reused. `add -B` refuses while ANY other tree holds the
//      branch — including a foreign at-sha tree: the scan cannot satisfy
//      reuse-in-root, the create fails with git's stderr naming the holder,
//      and the human must free the branch (remove/relocate the foreign
//      tree) or point worktreeRoot at the existing tree.
//
// The `[A-Za-z0-9._-]` sanitization: branch names are user data ("release/
// 1.0 +fix me") and the worktree directory name must stay one path segment —
// every character outside [A-Za-z0-9._-] becomes '-', so `/` cannot smuggle
// a directory hop and spaces/metacharacters cannot reach a shell (argv-only
// spawns anyway — this keeps the name boring, not the process safe). The
// directory is `pr-<pr>-<sanitized>` (not the bare sanitized branch): two
// DIFFERENT branches can sanitize to the same segment ("feat/x" vs
// "feat-x"), and the PR number prefix disambiguates the collision while
// keeping one review tree per PR in the name.
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
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
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
 * silently duplicate trees. `save` replaces the whole file ATOMICALLY: the
 * new content is written to `<path>.tmp` in the SAME directory and
 * `fs.rename`d over the target — an interrupted in-place rewrite would
 * leave PARTIAL JSON, and every later load would throw corrupt (the same
 * write-tmp-then-rename pattern as fileDispatchLog's record).
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
    // Write-tmp-then-rename, never a plain rewrite: rename(2) within one
    // directory is atomic, so a crash mid-write can only ever truncate the
    // throwaway tmp file — the registry on disk stays parseable JSON.
    const tmpPath = `${path}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    await rename(tmpPath, path);
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

/**
 * The OWNERSHIP boundary: a path is OURS only when it lives STRICTLY INSIDE
 * the review worktreeRoot (`<root>/<segment>…`). The root itself — and any
 * path outside it — is not a tree this module created or may claim/remove.
 */
const isInsideRoot = (path: string, root: string): boolean => path.startsWith(`${root}${sep}`);

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
 * Resolve THE worktree for a PR (UC row 38): fetch the origin branch (truth
 * first), reuse the registry entry when it still points at reality, reuse an
 * OWN (in-worktreeRoot) tree already checked out on the branch at the
 * fetched sha — refreshing (removing) our stale in-root tree and creating
 * afresh otherwise — else create one under worktreeRoot. Trees OUTSIDE
 * worktreeRoot are never claimed: branch+sha-valid ones surface in
 * `foreign`. See the module doc for the full ordered contract; every step
 * is pinned by a test. `reused` distinguishes an existing tree (true) from
 * one this call created (false).
 */
export async function resolvePrWorktree(
  opts: PrWorktreeOpts,
): Promise<{ path: string; reused: boolean; branch: string; foreign: Array<{ path: string; branch: string }> }> {
  validateOpts(opts);
  const worktreeRoot = opts.worktreeRoot ?? join(opts.repoRoot, '.cq-review-worktrees');
  const key = String(opts.pr);

  // (a) ORIGIN BRANCH IS TRUTH — fetched before any decision, and the
  // fetched commit is NAMED: `rev-parse FETCH_HEAD` yields the expectedSha
  // every reuse candidate must sit at. Gating on the fetch exit alone would
  // trust a LOCAL tree that lags origin — the exact stale-tree reuse the
  // fetch exists to prevent. A fetch failure means the branch's state is
  // unknown: throw, touch nothing.
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
  const fetchHeadArgs = ['-C', opts.repoRoot, 'rev-parse', 'FETCH_HEAD'];
  const fetchHead = await opts.run(fetchHeadArgs);
  if (fetchHead.code !== 0) {
    throw gitFail(
      'rev-parse FETCH_HEAD failed — the fetched truth is unnameable',
      fetchHead.code,
      fetchHead.stderr,
      fetchHeadArgs,
    );
  }
  const expectedSha = fetchHead.stdout.trim();

  const map = await opts.registry.load();

  // (b) Registry consult — the entry must still POINT AT TRUTH: the
  // directory exists AND git says headRefName is checked out there AND that
  // checkout sits AT the fetched sha (a round-1 tree at a stale commit is
  // exactly what this check exists to catch). A STALE entry is NOT pruned
  // here: the prune is the successful re-registration at the end (the
  // overwrite) — pruning up-front would destroy the machine-readable
  // pointer precisely when the run is about to wedge on a refused add.
  const entry = map[key];
  if (entry !== undefined) {
    const valid =
      (await directoryExists(entry.path)) &&
      (await (async () => {
        const branchArgs = ['-C', entry.path, 'rev-parse', '--abbrev-ref', 'HEAD'];
        const branch = await opts.run(branchArgs);
        if (branch.code !== 0 || branch.stdout.trim() !== opts.headRefName) {
          return false;
        }
        const headArgs = ['-C', entry.path, 'rev-parse', 'HEAD'];
        const head = await opts.run(headArgs);
        return head.code === 0 && head.stdout.trim() === expectedSha;
      })());
    if (valid) {
      return { path: entry.path, reused: true, branch: opts.headRefName, foreign: [] };
    }
  }

  // (c) Existing-worktree scan — with the OWNERSHIP RULE and the refresh
  // rule. A candidate on the PR branch is probed for the fetched sha:
  //   - INSIDE worktreeRoot + at sha  → OURS: reuse (register, return).
  //   - INSIDE worktreeRoot + stale   → OUR round-1 leftovers: remove them
  //     NON-FORCED so the create can converge onto the same spot (a dirty
  //     tree refuses; its stderr propagates as the throw — a human looks at
  //     it, never a silent --force).
  //   - OUTSIDE worktreeRoot + at sha → FOREIGN: never claimed, never
  //     removed — surfaced in `foreign`.
  //   - OUTSIDE worktreeRoot + stale  → not ours, not fresh: skipped
  //     entirely (it still holds the branch and will refuse the create;
  //     freeing it is the human's call — see the module doc).
  const listArgs = ['-C', opts.repoRoot, 'worktree', 'list', '--porcelain'];
  const list = await opts.run(listArgs);
  if (list.code !== 0) {
    throw gitFail('worktree list failed', list.code, list.stderr, listArgs);
  }
  const foreign: Array<{ path: string; branch: string }> = [];
  let existing: PorcelainWorktree | null = null;
  for (const candidate of parseWorktreeList(list.stdout)) {
    if (candidate.branch !== opts.headRefName) {
      continue;
    }
    const headArgs = ['-C', candidate.path, 'rev-parse', 'HEAD'];
    const head = await opts.run(headArgs);
    const atSha = head.code === 0 && head.stdout.trim() === expectedSha;
    if (!isInsideRoot(candidate.path, worktreeRoot)) {
      if (atSha) {
        foreign.push({ path: candidate.path, branch: candidate.branch });
      }
      continue;
    }
    if (atSha) {
      existing = candidate;
      break;
    }
    const removeArgs = ['-C', opts.repoRoot, 'worktree', 'remove', candidate.path];
    const remove = await opts.run(removeArgs);
    if (remove.code !== 0) {
      throw gitFail(
        `worktree remove ${candidate.path} failed (a dirty stale tree cannot be refreshed away — resolve it by hand)`,
        remove.code,
        remove.stderr,
        removeArgs,
      );
    }
  }
  if (existing !== null) {
    map[key] = { path: existing.path, branch: opts.headRefName, createdAt: opts.nowMs };
    await opts.registry.save(map);
    return { path: existing.path, reused: true, branch: opts.headRefName, foreign };
  }

  // (d) Create: one directory per PR, `pr-<pr>-<sanitized-branch>` (the PR
  // prefix disambiguates sanitize collisions like feat/x vs feat-x — see
  // the module doc), sanitized to a single boring path segment; the root is
  // created on demand. `-B <headRefName> … <expectedSha>` (re)points the
  // branch at the FETCHED COMMIT, so the new tree sits AT TRUTH rather than
  // at whatever the local ref last remembered. Nonzero add → throw with
  // stderr (git's refusal names any foreign branch-holder) — nothing is
  // registered for a tree that does not exist, and any stale registry
  // entry was never pruned, so the pointer survives for the next run.
  await mkdir(worktreeRoot, { recursive: true });
  const wtPath = join(worktreeRoot, `pr-${opts.pr}-${opts.headRefName.replace(SANITIZE_OK, '-')}`);
  const addArgs = ['-C', opts.repoRoot, 'worktree', 'add', '-B', opts.headRefName, wtPath, expectedSha];
  const add = await opts.run(addArgs);
  if (add.code !== 0) {
    throw gitFail(`worktree add -B ${opts.headRefName} ${wtPath} ${expectedSha} failed`, add.code, add.stderr, addArgs);
  }
  // The post-success prune: registering the fresh tree OVERWRITES any stale
  // entry — only now, with the new truth on disk, is the old pointer retired.
  map[key] = { path: wtPath, branch: opts.headRefName, createdAt: opts.nowMs };
  await opts.registry.save(map);
  return { path: wtPath, reused: false, branch: opts.headRefName, foreign };
}

/**
 * Remove a PR worktree — the cleanup PRIMITIVE for callers whose flow must
 * guarantee removal: wrap the work in try/finally and call this in finally
 * (the executeMerges doctrine; this module provides the primitive, not the
 * policy). NO --force by default: review ops never silently destroys trees
 * — when git refuses (dirty, locked, …) the error is RETHROWN with git's
 * stderr and the caller decides (retry, force deliberately, or leave it).
 * THE OWNERSHIP BOUNDARY: only trees STRICTLY INSIDE worktreeRoot may be
 * removed — a path outside the root is refused before git runs (review ops
 * removes only trees it created under its own root), registry untouched.
 * The registry entry is pruned ONLY after git actually removed the tree,
 * and ONLY when it points at THE removed path — an entry pointing elsewhere
 * (a re-created tree at a new location, or another PR's path under a shared
 * opts mistake) describes a different tree and must survive.
 */
export async function removePrWorktree(opts: PrWorktreeOpts & { path: string }): Promise<void> {
  validateOpts(opts);
  const worktreeRoot = opts.worktreeRoot ?? join(opts.repoRoot, '.cq-review-worktrees');
  if (!isInsideRoot(opts.path, worktreeRoot)) {
    throw new Error(
      `removePrWorktree: refusing to remove ${JSON.stringify(opts.path)} — it is outside the review worktreeRoot ${JSON.stringify(worktreeRoot)}; review ops removes only trees it created under its own root`,
    );
  }
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
  const key = String(opts.pr);
  const map = await opts.registry.load();
  if (map[key]?.path === opts.path) {
    delete map[key];
    await opts.registry.save(map);
  }
}
