// prWorktree — E3 slice 3 (goal E3; UC §2 row 38): resolve THE worktree for
// a PR — reuse the tree already checked out on the PR's branch, else create
// one. The PR'S HEAD REF IS TRUTH: `refs/pull/<pr>/head` is fetched from
// origin before any resolution decision — it exists for EVERY PR, fork or
// same-repo alike — so every path below acts on what the remote actually
// has, not on local memory, and the local branch label follows the fetched
// sha. One tree PER-PR, not per-batch — E4 dispatches batches sequentially
// against this tree (I6 isolation is invocation-level, not tree-level).
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
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { lock } from 'proper-lockfile';
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
  /**
   * MERGE-ON-SAVE for ONE key: load → set the key (null clears it) → save.
   * This NARROWS the whole-map-clobber window (a last writer erasing every
   * entry it never saw) — and the FILE-BACKED registry now ELIMINATES the
   * race for save/update by SERIALIZING them behind a lockfile beside the
   * target (`<path>.lock`, proper-lockfile, bounded retries: failure to
   * acquire within the bound throws loud). The in-memory registry is
   * unsynchronized (single-threaded tests). Single-flight registry access
   * remains an E4 dispatch requirement at the worker level.
   */
  update(key: string, entry: WorktreeRegistryEntry | null): Promise<void>;
}

/**
 * The unique per-save tmp name: pid + monotonic counter, so two saves can
 * never share one `.tmp` (a SHARED name let one concurrent rename remove
 * the other save's source file mid-write). Exposed pure for the
 * uniqueness pin.
 */
export const registryTmpPath = (path: string, nonce: string): string => `${path}.${nonce}.tmp`;
let registryTmpCounter = 0;
export const nextRegistryTmpNonce = (): string => `${process.pid}.${(registryTmpCounter += 1)}`;

/**
 * The file-backed WorktreeRegistry: one JSON object mapping decimal PR
 * number strings to entries. A MISSING file is an empty registry (first
 * run); a CORRUPT file (unparseable JSON, or not a plain object) throws a
 * clear error — resolving worktrees on top of an unreadable registry would
 * silently duplicate trees. WRITES ARE SERIALIZED AND ATOMIC: save and
 * update take a lockfile beside the target (`<path>.lock`, proper-lockfile,
 * bounded retries — a failure to acquire within the bound throws loud
 * naming the path), and the new content is written to a UNIQUE per-call tmp
 * file (`<path>.<pid>.<n>.tmp`) then `fs.rename`d over the target — an
 * interrupted write truncates only the throwaway tmp file, and concurrent
 * saves can never steal each other's source. The in-memory registry (the
 * tests' seam) is unsynchronized: single-threaded by construction.
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
  /**
   * proper-lockfile lstats the locked target to track staleness, so an
   * ABSENT registry is materialized as the valid empty map before locking
   * (load treats a missing file as empty anyway; `{}` is its on-disk form).
   */
  const ensureTarget = async (): Promise<void> => {
    try {
      await stat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await writeFile(path, `{}\n`, 'utf8');
        return;
      }
      throw err;
    }
  };

  /** Serialize every mutation behind the lockfile's bounded-retry acquire. */
  const withLock = async <T>(mutate: () => Promise<T>): Promise<T> => {
    await ensureTarget();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lock(path, {
        // A crashed holder's lock goes stale and may be broken after 10s.
        stale: 10_000,
        // Bounded acquire retries — a failure within the bound is LOUD
        // (thrown, naming the path), never an unserialized write.
        retries: { retries: 5, minTimeout: 25, maxTimeout: 200 },
      });
    } catch (err) {
      throw new Error(
        `fileWorktreeRegistry: could not acquire the registry lock ${JSON.stringify(`${path}.lock`)} within the retry bound — refusing to write unserialized; clear the stale lock and re-run`,
        { cause: err },
      );
    }
    if (release === undefined) {
      throw new Error(
        `fileWorktreeRegistry: could not acquire the registry lock ${JSON.stringify(`${path}.lock`)} within the retry bound — refusing to write unserialized; clear the stale lock and re-run`,
      );
    }
    try {
      return await mutate();
    } finally {
      await release();
    }
  };

  const saveUnlocked = async (map: RegistryMap): Promise<void> => {
    // Write-tmp-then-rename, never a plain rewrite: rename(2) within one
    // directory is atomic, so a crash mid-write can only ever truncate the
    // throwaway tmp file — the registry on disk stays parseable JSON. The
    // tmp name is UNIQUE per call (pid + counter): a shared `.tmp` name let
    // one rename remove the other save's source file mid-write.
    const tmpPath = registryTmpPath(path, nextRegistryTmpNonce());
    await writeFile(tmpPath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    await rename(tmpPath, path);
  };
  const save = (map: RegistryMap): Promise<void> => withLock(() => saveUnlocked(map));
  const update = (key: string, entry: WorktreeRegistryEntry | null): Promise<void> =>
    withLock(async () => {
      // Load-merge-save scoped to ONE key, SERIALIZED by the lockfile:
      // entries for other PRs are read fresh and written back intact.
      const map = await load();
      if (entry === null) {
        delete map[key];
      } else {
        map[key] = entry;
      }
      await saveUnlocked(map);
    });
  return { load, save, update };
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
 * Canonicalize a path for the ownership compare: `realpath` the LONGEST
 * EXISTING prefix, then re-join the not-yet-existing remainder (segments
 * under the resolved ancestor). This is total — a registry entry or a
 * caller-supplied path may not exist yet — and it is what makes the
 * boundary robust against SYMLINK DIVERGENCE: on macOS /tmp is a symlink
 * to /private/tmp (and tmpdir() hands out /var/... under /private/var), so
 * a raw string prefix compare would misclassify our own trees spelled
 * through the non-canonical alias as foreign. A path with NO existing
 * ancestor at all resolves to itself normalized and then simply fails the
 * prefix compare — treated as outside-root (the safe direction).
 */
const canonicalize = async (path: string): Promise<string> => {
  let probe = path;
  let remainder = '';
  for (;;) {
    try {
      const real = await realpath(probe);
      return remainder === '' ? real : join(real, remainder);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) {
        // Walked off the filesystem root without finding anything that
        // exists: the path is unresolvable — return it (normalized) and let
        // the prefix compare classify it outside-root.
        return path;
      }
      remainder = remainder === '' ? basename(probe) : join(basename(probe), remainder);
      probe = parent;
    }
  }
};

/**
 * The OWNERSHIP boundary: a path is OURS only when it lives STRICTLY INSIDE
 * the review worktreeRoot (`<root>/<segment>…`) — both sides CANONICALIZED
 * (see canonicalize: realpath semantics, symlink-proof), and a trailing
 * separator on the root is stripped before the compare (a caller spelling
 * `…/worktrees/` must not double the separator and miss every child). The
 * root itself — and any path outside it — is not a tree this module created
 * or may claim/remove.
 */
const isInsideRoot = async (path: string, root: string): Promise<boolean> => {
  let trimmed = root;
  while (trimmed.length > 1 && trimmed.endsWith(sep)) {
    trimmed = trimmed.slice(0, -1);
  }
  const [canonicalPath, canonicalRoot] = await Promise.all([canonicalize(path), canonicalize(trimmed)]);
  return canonicalPath.startsWith(`${canonicalRoot}${sep}`);
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

  // (a) THE PR'S HEAD REF IS TRUTH — fetched from the BASE repo before any
  // decision: `refs/pull/<pr>/head` exists for EVERY PR, fork or same-repo
  // alike, so a forked PR's headRefName (which names a branch in the
  // contributor's fork) never triggers a base-repo fetch that would fail —
  // or silently grab an unrelated same-named base-repo branch. The fetched
  // commit is NAMED: `rev-parse FETCH_HEAD` yields the expectedSha every
  // reuse candidate must sit at, and the local branch label is (re)pointed
  // at that sha downstream — the label follows the truth, never the other
  // way round. A fetch failure means the PR head's state is unknown:
  // throw, touch nothing.
  const fetchArgs = ['-C', opts.repoRoot, 'fetch', 'origin', `refs/pull/${opts.pr}/head`];
  const fetch = await opts.run(fetchArgs);
  if (fetch.code !== 0) {
    throw gitFail(
      `fetch origin refs/pull/${opts.pr}/head failed — the PR's head ref is truth and cannot be resolved`,
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
      // OWNERSHIP applies to the registry too: an entry pointing outside
      // the CURRENT worktreeRoot describes a tree this module no longer
      // owns (the root moved, or the entry predates the boundary) — stale
      // by definition, resolution proceeds to (re)create inside the root.
      (await isInsideRoot(entry.path, worktreeRoot)) &&
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
  //   - AT THIS PR's target path (pr-<pr>-<sanitized>), ANY branch →
  //     RECLAIMABLE: the path is the PR's slot, not the branch's — a tree
  //     left there by a branch rename is removed non-forced exactly like
  //     the stale-sha case, and the create lands in the freed slot.
  const listArgs = ['-C', opts.repoRoot, 'worktree', 'list', '--porcelain'];
  const list = await opts.run(listArgs);
  if (list.code !== 0) {
    throw gitFail('worktree list failed', list.code, list.stderr, listArgs);
  }
  const targetPath = join(worktreeRoot, `pr-${opts.pr}-${opts.headRefName.replace(SANITIZE_OK, '-')}`);
  const foreign: Array<{ path: string; branch: string }> = [];
  let existing: PorcelainWorktree | null = null;
  for (const candidate of parseWorktreeList(list.stdout)) {
    // RECLAIM RULE: a tree sitting at THIS PR key's target path is ours to
    // reclaim regardless of its checked-out branch (the path is the PR's
    // slot, not the branch's).
    const atTargetPath = candidate.path === targetPath;
    if (candidate.branch !== opts.headRefName && !atTargetPath) {
      continue;
    }
    const headArgs = ['-C', candidate.path, 'rev-parse', 'HEAD'];
    const head = await opts.run(headArgs);
    const atSha = head.code === 0 && head.stdout.trim() === expectedSha;
    if (!(await isInsideRoot(candidate.path, worktreeRoot))) {
      if (candidate.branch === opts.headRefName && atSha) {
        foreign.push({ path: candidate.path, branch: candidate.branch });
      }
      continue;
    }
    if (candidate.branch === opts.headRefName && atSha) {
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
    await opts.registry.update(key, { path: existing.path, branch: opts.headRefName, createdAt: opts.nowMs });
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
  const wtPath = targetPath;
  const addArgs = ['-C', opts.repoRoot, 'worktree', 'add', '-B', opts.headRefName, wtPath, expectedSha];
  const add = await opts.run(addArgs);
  if (add.code !== 0) {
    throw gitFail(`worktree add -B ${opts.headRefName} ${wtPath} ${expectedSha} failed`, add.code, add.stderr, addArgs);
  }
  // The post-success prune: registering the fresh tree OVERWRITES any stale
  // entry — only now, with the new truth on disk, is the old pointer retired
  // (the update is a per-key load-merge-save: concurrent resolves for other
  // PRs never lose their entries to this write).
  await opts.registry.update(key, { path: wtPath, branch: opts.headRefName, createdAt: opts.nowMs });
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
  if (!(await isInsideRoot(opts.path, worktreeRoot))) {
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
    // Per-key merge-on-write: other PRs' entries are re-read fresh and
    // preserved (a whole-map delete+save would drop them).
    await opts.registry.update(key, null);
  }
}
