import { acquireSlot } from '../lock/slotLock.js';
import type { SlotWorktreeRegistry } from './slotWorktreeRegistry.js';
import {
  CheckoutWriterContext,
  checkoutWriterContext,
} from '../../shared/checkoutWriterContext.js';
// prWorktree — E3 slice 3 (goal E3; UC §2 row 38): resolve THE worktree for
// a PR — reuse the tree already checked out on the PR's review branch, else
// create one. The PR'S HEAD REF IS TRUTH: `refs/pull/<pr>/head` is fetched
// from origin before any resolution decision — it exists for EVERY PR, fork
// or same-repo alike — so every path below acts on what the remote actually
// has, not on local memory. The LOCAL BRANCH IS A LABEL WE OWN, keyed by PR
// (cq-review/pr-<n>): the PR's actual head lives at refs/pull/<n>/head and
// is never checked out directly, so two PRs sharing a headRefName (forks,
// stacked PRs) can never collide. One tree PER-PR, not per-batch — E4
// dispatches batches sequentially against this tree (I6 isolation is
// invocation-level, not tree-level).
//
// DOMAIN BOUNDARY (asserted, not incidental): this is the REVIEW-OPS
// worktree — keyed by PR, rooted at `<git-common-dir>/cq-review-worktrees`. It is
// NOT the package-keyed sweep worktree: `createOrReuseWorktree` in the sweep
// ops family is a different domain with different keys and a different
// lifetime, and review ops must never consult it (and vice versa). The test
// suite pins this rule by name.
//
// The persistent PR slot spans this entire walk, including fetch. Each existing
// target also holds its canonical checkout slot before reuse or removal.
// Resolution order (each step pinned by a test):
//   a. `git -C <repoRoot> fetch origin refs/pull/<pr>/head` — nonzero →
//      THROW: the PR head's truth is unavailable and nothing must be guessed.
//   b. Registry consult: an entry for the pr that still POINTS AT TRUTH
//      (directory exists AND is inside worktreeRoot AND `git -C <entryPath>
//      symbolic-ref HEAD` prints refs/heads/cq-review/pr-<n> AND
//      `git -C <entryPath> rev-parse HEAD` prints the fetched sha) → reuse
//      it. A STALE entry is left in place until a fresh resolution succeeds
//      — the prune happens only AFTER a successful create/register (the
//      overwrite), so a run that wedges mid-flight leaves the machine-
//      readable pointer intact for the next run instead of destroying it at
//      the first failed check.
//   c. Existing-worktree scan (`git worktree list --porcelain`, parsed
//      blocks). The OWNERSHIP RULE: reuse is eligible only for trees INSIDE
//      worktreeRoot carrying OUR LABEL at the fetched sha — a foreign tree
//      can never match, because it never carries our label (the foreign[]
//      surfacing is kept as defense-in-depth). Within the root, our label
//      at a STALE sha is this module's own leftovers — it is REMOVED
//      non-forced (`worktree remove`, no --force; a dirty tree refuses and
//      its stderr propagates as the throw — the safe outcome) so the create
//      below can converge onto the same spot; so is ANY tree squatting on
//      this PR's target path (a branch rename left it there). Foreign trees
//      are never removed.
//   d. Create: `git -C <repoRoot> worktree add -B cq-review/pr-<n>
//      <worktreeRoot>/pr-<pr>-<sanitized-branch> <expectedSha>` — the `-B`
//      (re)points OUR LABEL at the fetched truth and the new tree sits AT
//      the fetched sha, not at whatever the local ref remembered; register
//      (overwriting any stale entry — the post-success prune) and return it
//      as NOT reused. `add -B` refuses while ANY other tree holds the label
//      — the create fails with git's stderr naming the holder, and the
//      human must free the branch (remove/relocate the holder) or point
//      worktreeRoot at the existing tree.
//
// Upgrading from the old linked-checkout default: review trees may remain
// under `<main>/.git/worktrees/<id>/cq-review-worktrees`. They are now foreign
// and are deliberately never removed automatically. Before removing the
// parent linked checkout, preserve any dirty files and unpushed commits
// OUTSIDE that entire admin directory (including a durable rescue branch
// for commits). Then use `git worktree remove <legacy-review-tree>` without
// --force and retry resolution. Do not delete/prune the parent checkout
// while a legacy review tree still contains work you need.
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
// through the injected SlotWorktreeRegistry; the adapter validates canonical
// checkout identities before persisting bindings.
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve as pathResolve, sep } from 'node:path';
import type { GhFn } from '../forge-github/gh.js';

/**
 * The LOCAL branch label review ops owns: keyed by PR, never by the PR's
 * headRefName. The PR's actual head lives at refs/pull/<n>/head and is
 * never checked out directly — the label is ours to (re)point at the
 * fetched sha, which keeps two PRs sharing a headRefName (forks, stacked
 * PRs) from colliding: their labels — and therefore their trees — can
 * never match across PRs.
 */
export const reviewBranchFor = (pr: number): string => `cq-review/pr-${pr}`;

type ResolutionPhase = { checkoutMutation: boolean; metadataWrite: boolean };
const admissionRefusals = new WeakSet<Error>();
const incompleteRefusals = new WeakSet<Error>();
/** A resolver-proven, settled refusal; message text alone cannot forge this proof. */
export function isPrWorktreeAdmissionRefusal(error: unknown): error is Error {
  return error instanceof Error && admissionRefusals.has(error);
}
/** A settled refusal that must retain an unresolved legacy slot. */
export function isPrWorktreeIncompleteRefusal(error: unknown): error is Error {
  return error instanceof Error && incompleteRefusals.has(error);
}
async function withAdmission<T>(
  opts: PrWorktreeOpts,
  action: (phase: ResolutionPhase) => Promise<T>,
): Promise<T> {
  return withResolverContext(() =>
    opts.registry.withPrLock(opts.pr, async () => {
      const phase = { checkoutMutation: false, metadataWrite: false };
      const settled = checkoutWriterContext()!.admissionSettlement();
      try {
        return await action(phase);
      } catch (error) {
        // Owner ruling on D5.4: a closed fetch/check is not an unaccounted writer.
        // Add/remove/config/worker failures and incomplete metadata writes remain unsafe.
        // An unresolved legacy hint also cannot be certified: a later run would
        // otherwise bypass the hint after the unbound slot became complete.
        if (
          error instanceof Error &&
          !phase.checkoutMutation &&
          !phase.metadataWrite &&
          settled()
        ) {
          const refusal = new Error(error.message, { cause: error });
          if (opts.registry.legacyHint?.(opts.pr)) incompleteRefusals.add(refusal);
          else admissionRefusals.add(refusal);
          throw refusal;
        }
        // A refusal proof is for this attempt; replaying an older error after
        // a mutator must not turn that new failure into a settled admission.
        if (isPrWorktreeAdmissionRefusal(error) || isPrWorktreeIncompleteRefusal(error))
          throw new Error(error.message, { cause: error });
        throw error;
      }
    }),
  );
}

/** What resolvePrWorktree/removePrWorktree need — everything injected. */
export interface PrWorktreeOpts {
  /** The checked-out repository the PR branch belongs to (git -C target). */
  repoRoot: string;
  /** The PR number (the registry key, as a decimal string). */
  pr: number;
  /** The PR's head branch name (origin truth, fetched in step a). */
  headRefName: string;
  /** Admission-pinned head: refuse changed truth before registry or checkout mutation. */
  expectedHead?: string;
  /**
   * The generic command runner — the SAME GhFn shape as gh.ts, resolving
   * with the exit code instead of throwing. The spawned bin is the caller's
   * convention: `makeGhRunner({ bin: 'git' })` for the real thing, a fake
   * in tests. All git I/O rides it.
   */
  run: GhFn;
  /** The PR → worktree registry (persistence seam). */
  registry: SlotWorktreeRegistry;
  isBookkeepingPath?: (path: string, root: string) => Promise<boolean>;
  /** Caller clock retained for resolver API compatibility. */
  nowMs: number;
  /** Root for created worktrees; defaults to `<git-common-dir>/cq-review-worktrees`. */
  worktreeRoot?: string;
  /**
   * Invoked only when THIS call itself created the per-PR worktree (never on
   * reuse/restore), after the registry records it. The engine-verified
   * creation signal lets callers rotate per-checkout state that describes
   * the previous checkout instance; a callback failure fails the resolution.
   */
  onCreated?: (info: { path: string; branch: string; head: string }) => Promise<void> | void;
  /**
   * Invoked before the non-forced removal of a stale checkout at a new head,
   * with its verified branch/HEAD. Returning true means the caller has
   * cleared exactly the engine-owned obstructions it can attest (and nothing
   * else), so the removal may retry once; false or a throw keeps the strict
   * refusal. The resolver itself never deletes worktree content.
   */
  onStaleRefresh?: (info: {
    path: string;
    branch: string;
    head: string;
  }) => Promise<boolean> | boolean;
}

/** Branch-name characters allowed to survive into a directory name. */
const SANITIZE_OK = /[^A-Za-z0-9._-]/g;

/** GhError-shaped failure message for a git invocation (plain Error — the
 * runner here is git, not gh, so the message must not claim otherwise). */
const gitFail = (why: string, code: number, stderr: string, args: string[]): Error => {
  const argv = args.map((arg) => JSON.stringify(arg)).join(' ');
  const trimmed = stderr.trim();
  return new Error(
    `git ${why} (exit ${code}): git ${argv}${trimmed === '' ? '' : `\nstderr: ${trimmed}`}`,
  );
};

/** One parsed `worktree list --porcelain` block. */
interface PorcelainWorktree {
  path: string;
  head: string | null;
  prunable: boolean;
  /** refs/heads/ branch name, or null when detached/bare. */
  branch: string | null;
}

/**
 * Parse `git worktree list --porcelain` output: blank-line-separated
 * blocks of `worktree <path>` / `HEAD <sha>` / `branch refs/heads/<name>`
 * (or `detached`/`bare` — no branch). Only the path and the heads/-stripped
 * branch, HEAD and prunable status are read; blocks without a worktree line are ignored.
 */
const parseWorktreeList = (text: string): PorcelainWorktree[] => {
  const out: PorcelainWorktree[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;
    let path: string | null = null;
    let branch: string | null = null;
    let head: string | null = null;
    let prunable = false;
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length);
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        prunable = true;
      } else if (line.startsWith('branch refs/heads/')) {
        branch = line.slice('branch refs/heads/'.length);
      }
    }
    if (path !== null) {
      out.push({ path, branch, head, prunable });
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
  const [canonicalPath, canonicalRoot] = await Promise.all([
    canonicalize(path),
    canonicalize(trimmed),
  ]);
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
    throw new Error(
      `resolvePrWorktree: pr must be a positive safe integer — got ${JSON.stringify(opts.pr)}`,
    );
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
export async function resolvePrWorktree(opts: PrWorktreeOpts): Promise<{
  path: string;
  reused: boolean;
  branch: string;
  foreign: Array<{ path: string; branch: string }>;
}> {
  validateOpts(opts);
  return withAdmission(opts, (phase) => resolveLockedPrWorktree(opts, phase));
}

async function resolveLockedPrWorktree(opts: PrWorktreeOpts, phase: ResolutionPhase) {
  // ALL paths are resolved ABSOLUTE before use: mkdir() resolves from the
  // process cwd while `git -C <repoRoot> <relative-path>` resolves from
  // INSIDE repoRoot — a relative repoRoot would otherwise split the same
  // worktreeRoot across two real locations (one per resolver). Absolute
  // everywhere means one location, whichever cwd the caller runs from.
  const repoRoot = pathResolve(opts.repoRoot);
  // The default root lives under the COMMON git dir, not under repoRoot: a
  // linked worktree or submodule checkout has a .git FILE, and mkdir under a
  // file is ENOTDIR. `--absolute-git-dir` would name the PER-WORKTREE dir
  // (`<main>/.git/worktrees/<id>` for a linked checkout), so the root would
  // move with whichever checkout the caller runs from — a tree created from
  // the main checkout would then look FOREIGN here — and the review trees
  // would nest inside git's admin directory for that worktree, where
  // `git worktree remove <linked>`/`prune` deletes them recursively.
  // `--git-common-dir` is the stable dir in every layout (git ≥ 2.31 for
  // `--path-format`). Explicit worktreeRoot stays fully caller-controlled.
  const gitDirArgs = ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'];
  const gitDir = await opts.run(gitDirArgs);
  if (gitDir.code !== 0) {
    throw gitFail(
      'rev-parse --git-common-dir failed — repoRoot is not a git repository',
      gitDir.code,
      gitDir.stderr,
      gitDirArgs,
    );
  }
  const worktreeRoot =
    opts.worktreeRoot !== undefined
      ? pathResolve(opts.worktreeRoot)
      : join(gitDir.stdout.trim(), 'cq-review-worktrees');

  // (a) THE PR'S HEAD REF IS TRUTH — fetched from the BASE repo before any
  // decision: `refs/pull/<pr>/head` exists for EVERY PR, fork or same-repo
  // alike, so a forked PR's headRefName (which names a branch in the
  // contributor's fork) never triggers a base-repo fetch that would fail —
  // or silently grab an unrelated same-named base-repo branch. The fetched
  // commit is NAMED: `rev-parse refs/cq-review/pr-<pr>` yields the
  // expectedSha every
  // reuse candidate must sit at, and the local branch label is (re)pointed
  // at that sha downstream — the label follows the truth, never the other
  // way round. A fetch failure means the PR head's state is unknown:
  // throw, touch nothing.
  // The fetch lands in a PR-SPECIFIC local ref — FETCH_HEAD is repo-global
  // shared state, so two concurrent PR jobs would clobber each other's
  // fetch and the first job would resolve the second PR's commit (fixes
  // built against the wrong code). `+` allows non-fast-forward updates:
  // a force-pushed PR head must still refresh the ref.
  const prRef = `refs/cq-review/pr-${opts.pr}`;
  const fetchArgs = ['-C', repoRoot, 'fetch', 'origin', `+refs/pull/${opts.pr}/head:${prRef}`];
  const fetch = await opts.run(fetchArgs);
  if (fetch.code !== 0) {
    throw gitFail(
      `fetch origin refs/pull/${opts.pr}/head failed — the PR's head ref is truth and cannot be resolved`,
      fetch.code,
      fetch.stderr,
      fetchArgs,
    );
  }
  const fetchHeadArgs = ['-C', repoRoot, 'rev-parse', prRef];
  const fetchHead = await opts.run(fetchHeadArgs);
  if (fetchHead.code !== 0) {
    throw gitFail(
      `rev-parse ${prRef} failed — the fetched truth is unnameable`,
      fetchHead.code,
      fetchHead.stderr,
      fetchHeadArgs,
    );
  }

  if (
    opts.expectedHead !== undefined &&
    (!/^[a-f0-9]{40,64}$/.test(opts.expectedHead) || fetchHead.stdout.trim() !== opts.expectedHead)
  )
    throw new Error('PR fetched head changed since admission; checkout left untouched');

  // The same persistent PR slot held before fetch protects consult, scan,
  // targeted removal, creation and registration. Metadata updates require
  // that live context; no shared registry-map lock participates.
  {
    const expectedSha = fetchHead.stdout.trim();
    // The LOCAL branch label we own (keyed by PR) — see reviewBranchFor.
    const reviewBranch = reviewBranchFor(opts.pr);

    const metadata = await opts.registry.read(opts.pr);

    // (b) Registry consult — the entry must still POINT AT TRUTH: the
    // directory exists AND git says OUR LABEL (reviewBranch) is checked out
    // there AND that checkout sits AT the fetched sha (a round-1 tree at a
    // stale commit is exactly what this check exists to catch). A STALE entry is NOT pruned
    // here: the prune is the successful re-registration at the end (the
    // overwrite) — pruning up-front would destroy the machine-readable
    // pointer precisely when the run is about to wedge on a refused add.
    const legacy = metadata?.state === 'bound' ? undefined : opts.registry.legacyHint?.(opts.pr);
    if (
      legacy &&
      (legacy.branch !== reviewBranch || !(await isInsideRoot(legacy.path, worktreeRoot)))
    )
      throw new Error(`foreign legacy review registry hint: ${legacy.path}`);
    const entry = metadata?.state === 'bound' ? { path: metadata.checkoutPath } : legacy;
    if (entry !== undefined) {
      const valid =
        (await directoryExists(entry.path)) &&
        // OWNERSHIP applies to the registry too: an entry pointing outside
        // the CURRENT worktreeRoot describes a tree this module no longer
        // owns (the root moved, or the entry predates the boundary) — stale
        // by definition, resolution proceeds to (re)create inside the root.
        (await isInsideRoot(entry.path, worktreeRoot)) &&
        (await (async () => {
          const branchArgs = ['-C', entry.path, 'symbolic-ref', 'HEAD'];
          const branch = await opts.run(branchArgs);
          if (branch.code !== 0 || branch.stdout.trim() !== `refs/heads/${reviewBranch}`) {
            return false;
          }
          if (legacy) {
            const candidateCommon = await opts.run([
              '-C',
              entry.path,
              'rev-parse',
              '--path-format=absolute',
              '--git-common-dir',
            ]);
            if (
              candidateCommon.code !== 0 ||
              (await realpath(candidateCommon.stdout.trim())) !==
                (await realpath(gitDir.stdout.trim()))
            )
              throw new Error(`foreign legacy review checkout identity: ${entry.path}`);
          }
          // The first label read only rejects bad hints. Positive identity
          // and all safety probes must be observed under checkout exclusion.
          await bindCheckout(opts, entry.path, false, phase);
          const heldBranch = await opts.run(branchArgs);
          if (heldBranch.code !== 0 || heldBranch.stdout.trim() !== `refs/heads/${reviewBranch}`)
            return false;
          const headArgs = ['-C', entry.path, 'rev-parse', 'HEAD'];
          const head = await opts.run(headArgs);
          return head.code === 0 && head.stdout.trim() === expectedSha;
        })());
      if (valid) {
        await bindCheckout(opts, entry.path, true, phase);
        await assertCleanCheckout(opts, entry.path);
        return { path: entry.path, reused: true, branch: reviewBranch, foreign: [] };
      }
      if (legacy) {
        const existing = await lstat(legacy.path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (existing)
          throw new Error(`legacy review checkout identity or head mismatch: ${legacy.path}`);
      }
    }

    // (c) Existing-worktree scan — with the OWNERSHIP RULE and the refresh
    // rule. A candidate carrying OUR LABEL is probed for the fetched sha (a
    // foreign tree never carries the label, so it can never match):
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
    const listArgs = ['-C', repoRoot, 'worktree', 'list', '--porcelain'];
    const list = await opts.run(listArgs);
    if (list.code !== 0) {
      throw gitFail('worktree list failed', list.code, list.stderr, listArgs);
    }
    const targetPath = join(
      worktreeRoot,
      `pr-${opts.pr}-${opts.headRefName.replace(SANITIZE_OK, '-')}`,
    );
    const foreign: Array<{ path: string; branch: string }> = [];
    let existing: PorcelainWorktree | null = null;
    for (const candidate of parseWorktreeList(list.stdout)) {
      // RECLAIM RULE: a tree sitting at THIS PR key's target path is ours to
      // reclaim regardless of its checked-out branch (the path is the PR's
      // slot, not the branch's).
      const atTargetPath =
        (await canonicalize(candidate.path)) === (await canonicalize(targetPath));
      if (candidate.branch !== reviewBranch && !atTargetPath) {
        continue;
      }
      const headArgs = ['-C', candidate.path, 'rev-parse', 'HEAD'];
      if (!(await isInsideRoot(candidate.path, worktreeRoot))) {
        const head = await opts.run(headArgs);
        if (
          candidate.branch === reviewBranch &&
          head.code === 0 &&
          head.stdout.trim() === expectedSha
        )
          foreign.push({ path: candidate.path, branch: candidate.branch });
        continue;
      }
      if (candidate.prunable) {
        const absent = await lstat(candidate.path).then(
          () => false,
          (error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
            throw error;
          },
        );
        if (absent) {
          // The PR slot excludes competing resolvers. Remove only this missing
          // registration; a global prune could touch foreign worktrees. Its
          // branch may still hold unpushed commits even though its files vanished.
          if (!candidate.head || !/^[a-f0-9]{40,64}$/.test(candidate.head))
            throw new Error('missing worktree HEAD unavailable; registration preserved');
          const aheadArgs = [
            '-C',
            repoRoot,
            'rev-list',
            '--count',
            `${expectedSha}..${candidate.head}`,
          ];
          const ahead = await opts.run(aheadArgs);
          if (ahead.code !== 0 || !/^0\s*$/.test(ahead.stdout))
            throw gitFail(
              'missing worktree may hold unpushed work; registration preserved',
              ahead.code || 1,
              ahead.stderr,
              aheadArgs,
            );
          phase.checkoutMutation = true;
          checkoutWriterContext()!.markCheckoutMutation();
          const removeArgs = ['-C', repoRoot, 'worktree', 'remove', candidate.path];
          const remove = await opts.run(removeArgs);
          if (remove.code !== 0)
            throw gitFail(
              'missing worktree registration removal failed',
              remove.code,
              remove.stderr,
              removeArgs,
            );
          await checkoutWriterContext()!.removed(candidate.path);
          await opts.registry.update(opts.pr, { version: 1, state: 'unbound', incomplete: true });
          continue;
        }
      }
      await bindCheckout(opts, candidate.path, false, phase);
      const branch = await opts.run(['-C', candidate.path, 'symbolic-ref', 'HEAD']);
      const currentBranch =
        branch.code === 0 && branch.stdout.trim().startsWith('refs/heads/')
          ? branch.stdout.trim().slice('refs/heads/'.length)
          : null;
      if (currentBranch !== reviewBranch && !atTargetPath) continue;
      const head = await opts.run(headArgs);
      const atSha = head.code === 0 && head.stdout.trim() === expectedSha;
      if (currentBranch === reviewBranch && atSha) {
        existing = candidate;
        break;
      }
      // UNPUSHED-WORK GUARD: commits on HEAD that the fetched PR head does
      // not contain are fixer work a failed push left behind — removing the
      // tree would orphan them (the branch label is reset by the next add).
      // Refuse loudly with the count; a human resolves it by hand.
      const unpushedArgs = ['-C', candidate.path, 'rev-list', '--count', `${expectedSha}..HEAD`];
      const unpushed = await opts.run(unpushedArgs);
      if (unpushed.code !== 0) {
        throw gitFail(
          `rev-list --count on ${candidate.path} failed — the tree's relation to the fetched head is unknown`,
          unpushed.code,
          unpushed.stderr,
          unpushedArgs,
        );
      }
      if (Number.parseInt(unpushed.stdout.trim(), 10) > 0) {
        throw gitFail(
          `worktree remove ${candidate.path} withheld: HEAD carries ${unpushed.stdout.trim()} commit(s) not in the fetched PR head (unpushed fixer work would be orphaned) — resolve by hand`,
          1,
          `HEAD is ${unpushed.stdout.trim()} commit(s) ahead of ${expectedSha}`,
          unpushedArgs,
        );
      }
      const canonicalPath = await realpath(candidate.path);
      await bindCheckout(opts, canonicalPath, true, phase);
      phase.checkoutMutation = true;
      checkoutWriterContext()!.markCheckoutMutation();
      const removeArgs = ['-C', repoRoot, 'worktree', 'remove', candidate.path];
      let remove = await opts.run(removeArgs);
      if (remove.code !== 0 && opts.onStaleRefresh) {
        // One caller-attested cleanup chance before the strict refusal: the
        // callback decides, the resolver still verifies with a NON-forced
        // remove — never --force, never a widened deletable set. The info
        // names the refresh context this resolution verified: the fetched
        // head and the review branch the replacement checkout will sit at.
        const cleared = await opts.onStaleRefresh({
          path: candidate.path,
          branch: reviewBranch,
          head: expectedSha,
        });
        if (cleared === true) remove = await opts.run(removeArgs);
      }
      if (remove.code !== 0) {
        throw gitFail(
          `worktree remove ${candidate.path} failed (a dirty stale tree cannot be refreshed away — resolve it by hand)`,
          remove.code,
          remove.stderr,
          removeArgs,
        );
      }
      await checkoutWriterContext()!.removed(canonicalPath);
      await opts.registry.update(opts.pr, { version: 1, state: 'unbound', incomplete: true });
    }
    if (existing !== null) {
      await bindCheckout(opts, existing.path, true, phase);
      await assertCleanCheckout(opts, existing.path);
      return { path: existing.path, reused: true, branch: reviewBranch, foreign };
    }

    // (d) Create: one directory per PR, `pr-<pr>-<sanitized-branch>` (the PR
    // prefix disambiguates sanitize collisions like feat/x vs feat-x — see
    // the module doc), sanitized to a single boring path segment; the root is
    // created on demand. `-B <reviewBranch> … <expectedSha>` (re)points OUR
    // LABEL at the FETCHED COMMIT, so the new tree sits AT TRUTH rather than
    // at whatever the local ref last remembered (the label is pr-keyed — two
    // PRs sharing a headRefName can never collide). Nonzero add → throw with
    // stderr (git's refusal names any foreign branch-holder) — nothing is
    // registered for a tree that does not exist, and any stale registry
    // entry was never pruned, so the pointer survives for the next run.
    phase.checkoutMutation = true;
    checkoutWriterContext()!.markCheckoutMutation();
    await mkdir(worktreeRoot, { recursive: true });
    const wtPath = targetPath;
    const addArgs = ['-C', repoRoot, 'worktree', 'add', '-B', reviewBranch, wtPath, expectedSha];
    const add = await opts.run(addArgs);
    if (add.code !== 0) {
      throw gitFail(
        `worktree add -B ${reviewBranch} ${wtPath} ${expectedSha} failed. If an old linked-checkout review tree holds the branch, preserve its dirty files and unpushed commits outside the linked checkout's admin directory first (use a durable rescue branch for commits), then git worktree remove <legacy-review-tree> without --force and retry. Do not remove/prune the parent linked checkout before preserving that work`,
        add.code,
        add.stderr,
        addArgs,
      );
    }
    // Bind this PR's metadata to the verified new checkout. Other PRs own
    // separate files, so this cannot overwrite their pointers.
    await bindCheckout(opts, wtPath, true, phase);
    await opts.onCreated?.({ path: wtPath, branch: reviewBranch, head: expectedSha });
    return { path: wtPath, reused: false, branch: reviewBranch, foreign };
  }
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
 * The caller's path is RESOLVED FIRST (absolute, then canonical) and that
 * ONE location drives the boundary check, the git argv and the registry
 * compare: a relative spelling must not mean one tree to the check and
 * another to git (which resolves `-C <repoRoot> worktree remove <path>` from
 * inside repoRoot, with suffix matching) or to the prune.
 * The registry entry is pruned ONLY after git actually removed the tree,
 * and ONLY when it points at THE removed path — an entry pointing elsewhere
 * (a re-created tree at a new location, or another PR's path under a shared
 * opts mistake) describes a different tree and must survive.
 */
export async function removePrWorktree(opts: PrWorktreeOpts & { path: string }): Promise<void> {
  validateOpts(opts);
  return withAdmission(opts, (phase) => removeLockedPrWorktree(opts, phase));
}
async function removeLockedPrWorktree(
  opts: PrWorktreeOpts & { path: string },
  phase: ResolutionPhase,
): Promise<void> {
  // Absolute everywhere (see resolvePrWorktree): mkdir/`-C`/paths must not
  // straddle two resolvers.
  const repoRoot = pathResolve(opts.repoRoot);
  // Same derivation as resolvePrWorktree (the COMMON git dir, not the
  // per-worktree one — a linked worktree's .git is a file and its git dir is
  // `<main>/.git/worktrees/<id>`): the boundary check must agree with where
  // resolution actually creates trees.
  let worktreeRoot: string;
  if (opts.worktreeRoot !== undefined) {
    worktreeRoot = pathResolve(opts.worktreeRoot);
  } else {
    const gitDirArgs = ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'];
    const gitDir = await opts.run(gitDirArgs);
    if (gitDir.code !== 0) {
      throw gitFail(
        'rev-parse --git-common-dir failed — repoRoot is not a git repository',
        gitDir.code,
        gitDir.stderr,
        gitDirArgs,
      );
    }
    worktreeRoot = join(gitDir.stdout.trim(), 'cq-review-worktrees');
  }
  // ONE location, settled BEFORE the ownership check and the git call: a
  // relative opts.path is resolved against repoRoot — exactly where
  // `git -C <repoRoot> worktree remove <path>` resolves it — so the boundary
  // check can never pass for a location other than the one git acts on (git
  // additionally matches worktrees by path suffix, so the check must see the
  // final absolute location, not a spelling).
  const requestedPath = pathResolve(repoRoot, opts.path);
  if (!(await isInsideRoot(requestedPath, worktreeRoot))) {
    throw new Error(
      `removePrWorktree: refusing to remove ${JSON.stringify(opts.path)} — it is outside the review worktreeRoot ${JSON.stringify(worktreeRoot)}; review ops removes only trees it created under its own root`,
    );
  }
  const canonicalPath = await realpath(requestedPath);
  await bindCheckout(opts, canonicalPath, false, phase);
  // Read (and canonicalize) the registry entry BEFORE removal: an entry
  // spelled through a terminal symlink still names THIS tree, but git leaves
  // the out-of-tree symlink dangling, so comparing afterwards would miss it.
  // The UPDATE still happens only after git actually removed the tree.
  const metadata = await opts.registry.read(opts.pr);
  const entryPath = metadata?.state === 'bound' ? metadata.checkoutPath : undefined;
  const entryMatches = entryPath !== undefined && (await canonicalize(entryPath)) === canonicalPath;
  phase.checkoutMutation = true;
  checkoutWriterContext()!.markCheckoutMutation();
  const removeArgs = ['-C', repoRoot, 'worktree', 'remove', requestedPath];
  const result = await opts.run(removeArgs);
  if (result.code !== 0) {
    throw gitFail(
      `worktree remove ${requestedPath} failed (dirty or locked trees are left in place — the caller decides)`,
      result.code,
      result.stderr,
      removeArgs,
    );
  }
  await checkoutWriterContext()!.removed(canonicalPath);
  // Only an entry that named THE removed tree is pruned; an entry pointing
  // anywhere else describes a different tree and survives.
  if (entryMatches) {
    await opts.registry.update(opts.pr, { version: 1, state: 'unbound', incomplete: true });
  }
}

async function bindCheckout(
  opts: PrWorktreeOpts,
  path: string,
  register = true,
  phase?: ResolutionPhase,
): Promise<void> {
  const root = await realpath(path);
  const git = await opts.run(['-C', root, 'rev-parse', '--absolute-git-dir']);
  const common = await opts.run([
    '-C',
    root,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (git.code !== 0 || common.code !== 0) throw new Error('checkout Git identity unavailable');
  const checkoutGitDir = await realpath(git.stdout.trim());
  const context = checkoutWriterContext();
  if (!context) throw new Error('checkout lifetime missing');
  const slot = await context.acquire(await realpath(common.stdout.trim()), {
    checkoutGitDir,
    checkoutPath: root,
  });
  if (phase) phase.metadataWrite = true;
  await context.begin();
  const metadata = {
    version: 1 as const,
    state: 'bound' as const,
    incomplete: true,
    checkoutPath: root,
    checkoutGitDir,
  };
  await slot.writeMetadata(metadata);
  if (register) await opts.registry.update(opts.pr, metadata);
  if (phase) phase.metadataWrite = false;
}
async function assertCleanCheckout(opts: PrWorktreeOpts, path: string): Promise<void> {
  for (const args of [
    ['diff', '--quiet'],
    ['diff', '--cached', '--quiet'],
  ]) {
    const result = await opts.run(['-C', path, ...args]);
    if (result.code !== 0) throw new Error('dirty tracked/index checkout requires reconciliation');
  }
  const files = await opts.run(['-C', path, 'ls-files', '--others', '-z']);
  if (files.code !== 0) throw new Error('checkout untracked/ignored state unavailable');
  for (const file of files.stdout.split('\0').filter(Boolean)) {
    if (!(await opts.isBookkeepingPath?.(file, await realpath(path))))
      throw new Error(`unowned untracked/ignored checkout path: ${file}`);
  }
}

async function withResolverContext<T>(action: () => Promise<T>): Promise<T> {
  if (checkoutWriterContext()) return action();
  const context = new CheckoutWriterContext(acquireSlot);
  return context.run(async () => {
    try {
      const result = await action();
      await context.complete();
      return result;
    } catch (error) {
      if (isPrWorktreeAdmissionRefusal(error)) await context.complete();
      throw error;
    } finally {
      if (!context.pendingChildren) await context.close();
    }
  });
}
