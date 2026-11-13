import type { SlotWorktreeRegistry } from '../../../src/adapters/git/slotWorktreeRegistry.js';
import { mkdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach } from 'vitest';
import { realTmpDirSync } from '../../helpers/tmp-dir.js';
// Split provenance: test/ops/review/prWorktree.test.ts was split into
// prWorktree.helpers.ts (shared fixtures) and prWorktree.fetchFirst.test.ts,
// prWorktree.registryConsult.test.ts, prWorktree.scanReuse.test.ts,
// prWorktree.createPath.test.ts, prWorktree.ownership.test.ts,
// prWorktree.paths.test.ts, prWorktree.remove.test.ts,
// prWorktree.registryFile.test.ts.
//
// E3 slice 3 — shared fixtures for the prWorktree tests (src/ops/review/prWorktree.ts;
// UC §2 row 38).
//
// Pinned here:
//   1. THE PR'S HEAD REF IS TRUTH, BY SHA: the fetch of refs/pull/<n>/head
//      runs FIRST (a fetch failure
//      throws before the registry is even consulted — nothing touched,
//      nothing saved) and `rev-parse refs/cq-review/pr-<n>` NAMES the fetched commit (a PR-specific ref — FETCH_HEAD is repo-global shared state);
//      every reuse candidate must sit AT that sha.
//   2. Registry hit whose entry still points at truth (branch AND fetched
//      sha) → reused, and NO worktree list/add ever runs. A STALE entry is
//      NOT pruned up front — the prune is the successful re-registration
//      (the overwrite), so a run that wedges leaves the pointer intact.
//   3. REFRESH CONVERGENCE: a branch-matching tree at a STALE sha — ours,
//      inside worktreeRoot — is REMOVED non-forced (`worktree remove`, no
//      --force) and the tree is RE-CREATED at the fetched sha via
//      `add -B <branch> <path> <sha>` at that same spot; a DIRTY stale
//      tree refuses the remove, the throw carries git's stderr, and the
//      registry entry survives.
//   4. OWNERSHIP: reuse is eligible only INSIDE worktreeRoot; a
//      branch+sha-valid tree OUTSIDE the root is surfaced in the result's
//      `foreign` list (never claimed, never removed); a foreign tree
//      holding the branch refuses the create (git's double-checkout
//      refusal) and the throw names it — freeing it is the human's call.
//   5. The create path: `pr-<pr>-<sanitized-branch>` under worktreeRoot
//      (default `<git-common-dir>/cq-review-worktrees`), added with
//      `-B <branch> <path> <expectedSha>` so the new tree sits AT the
//      fetched sha, registered with the injected clock, reused=false; an
//      add FAILURE throws with git's stderr and leaves the registry (and
//      any stale entry) untouched.
//   6. Sanitization mapping: branch-name characters outside
//      [A-Za-z0-9._-] become '-' — `/` can never smuggle a directory hop;
//      the `pr-<pr>-` prefix disambiguates sanitize collisions
//      (feat/x vs feat-x land in different directories per PR).
//   7. removePrWorktree: success prunes the registry entry ONLY when it
//      points at the removed path; failure (dirty/locked) rethrows with
//      stderr and prunes NOTHING (review ops never silently destroys
//      trees; callers wrap work in try/finally — this is the primitive,
//      not the policy).
//   8. THE DOMAIN RULE, pinned behaviorally: review ops reuses ONLY an OWN
//      (in-root) tree matching the PR branch AND the fetched sha —
//      sweep-family trees on other branches neither block nor get claimed,
//      and a sweep tree HOLDING the branch blocks the create until a human
//      frees it (review ops never touches it).
//   9. fileWorktreeRegistry: missing file = empty registry; round-trip
//      save/load; a corrupt file throws a clear error.
//
// The git seam is INJECTED: a fake `run` implementing a small in-memory git
// model with a REAL sha notion (the fetched PR head per fetch, per-path branch+head
// rev-parse answers, `worktree add -B` moving the branch to the fetched PR head).
// No spawned process, no real clocks (nowMs injected).
import { dirname, join, sep } from 'node:path';
import type { GhFn, GhResult } from '../../../src/adapters/forge-github/gh.js';
import { reviewBranchFor } from '../../../src/adapters/git/prWorktree.js';
import type { PrWorktreeOpts } from '../../../src/adapters/git/prWorktree.js';
import type { RegistryMap } from './legacyRegistryTypes.js';

// ---------------------------------------------------------------------------
// Fixtures + the fake git model
// ---------------------------------------------------------------------------

export const REPO = realTmpDirSync('cq-resolver-model-');
afterEach(async () => {
  await rm(REPO, { recursive: true, force: true });
});
export const NOW = 1_750_000_000_000;
export const PR = 7;
export const BRANCH = 'pr-7-fix';
/** The PR-keyed review label resolvePrWorktree checks out (see reviewBranchFor). */
export const LABEL = reviewBranchFor(PR);
/** The STALE local sha — what an out-of-date tree has checked out. */
export const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** The origin truth — what the fetch lands in (the PR-specific ref's target). */
export const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
/** The main tree's sha (an unrelated branch's head). */
export const SHA_MAIN = 'cccccccccccccccccccccccccccccccccccccccc';

/** The in-memory git model the fake run implements. */
interface FakeGit {
  /** When set, `fetch origin <branch>` fails with this result. */
  fetchFails?: { code: number; stderr: string };
  /** When set, `rev-parse` of the fetched PR-specific ref fails with this result. */
  fetchHeadFails?: { code: number; stderr: string };
  /** What `rev-parse` of the fetched PR-specific ref prints — defaults to SHA_B (origin truth). */
  fetchHeadSha?: string;
  /** Current worktrees (porcelain list order); branch null = detached. */
  worktrees: Array<{ path: string; branch: string | null; head: string }>;
  /** When set, `worktree add` fails with this result. */
  addFails?: { code: number; stderr: string };
  /** When set, `worktree remove` fails with this result. */
  removeFails?: { code: number; stderr: string };
  /** Worktree path → what HEAD is checked out there (absent = not a repo). */
  headOf: Record<string, { branch: string | null; head: string }>;
}

/** Build a model: `trees` are both the porcelain list AND the rev-parse
 * view; `over.headOf` adds checkouts for paths NOT in the porcelain list
 * (stale trees git no longer lists but whose directories remain). */
export const mkModel = (
  trees: Array<{ path: string; branch: string | null; head: string }> = [],
  over: Partial<FakeGit> = {},
): FakeGit => ({
  fetchHeadSha: SHA_B,
  ...over,
  worktrees: trees,
  headOf: {
    ...Object.fromEntries(
      trees
        .filter((tree): tree is typeof tree & { branch: string } => tree.branch !== null)
        .map((tree) => [tree.path, { branch: tree.branch, head: tree.head }]),
    ),
    ...(over.headOf ?? {}),
  },
});

/** Build the injected run (GhFn shape, bin 'git' by convention). */
export const fakeGit = (
  model: FakeGit,
  calls?: string[][],
  options: { commonDir?: string } = {},
): GhFn => {
  let commonDir = options.commonDir;
  let firstCall = true;
  // Materialize only this harness's temporary checkouts before the resolver
  // verifies their identity. Foreign model paths remain virtual and untouched.
  for (const path of Object.keys(model.headOf))
    if (path.startsWith(dirname(REPO) + sep)) mkdirSync(path, { recursive: true });
  return async (args: string[]): Promise<GhResult> => {
    calls?.push(args);
    const initial = firstCall;
    firstCall = false;
    const sub = args[2];
    if (sub === 'diff' || sub === 'ls-files') return { code: 0, stdout: '', stderr: '' };
    if (sub === 'rev-parse' && args.includes('--git-common-dir')) {
      commonDir ??= initial ? join(args[1]!, '.git') : join(REPO, '.git');
      await mkdir(commonDir, { recursive: true });
      return { code: 0, stdout: commonDir, stderr: '' };
    }
    if (sub === 'symbolic-ref')
      return { code: 0, stdout: `refs/heads/${model.headOf[args[1]!]!.branch}`, stderr: '' };

    if (sub === 'fetch') {
      if (model.fetchFails !== undefined) {
        return { code: model.fetchFails.code, stdout: '', stderr: model.fetchFails.stderr };
      }
      // FORK WORLD: origin hosts the PR's pull ref (refs/pull/<n>/head),
      // NOT the contributor's branch — a bare branch-name fetch must fail
      // (it would miss, or grab an unrelated same-named base-repo branch).
      const refspec = (args[4] ?? '').replace(/^\+/, '');
      if (!refspec.startsWith('refs/pull/')) {
        return {
          code: 128,
          stdout: '',
          stderr: `fatal: couldn't find remote ref refs/heads/${refspec}`,
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    if (sub === 'rev-list') {
      // argv shape: ['-C', <path>, 'rev-list', '--count', '<range>'] —
      // commits on HEAD beyond the fetched head: a tree AT the fetched sha
      // has none (0); a stale tree carries some (1+).
      const at = args[1] ?? '';
      const listed = model.headOf[at];
      if (listed === undefined) {
        return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
      }
      // SHA_A models the PR's OLD head — an ancestor of the fetched truth
      // (the ordinary stale case: 0 commits beyond it). An unrecognized
      // head models unpushed fixer work (1+).
      const ancestor = listed.head === SHA_A || listed.head === (model.fetchHeadSha ?? SHA_B);
      const count = ancestor ? '0' : '1';
      return { code: 0, stdout: `${count}\n`, stderr: '' };
    }
    if (sub === 'rev-parse' && args[3] === '--absolute-git-dir') {
      await mkdir(join(args[1]!, '.git'), { recursive: true });
      // Real git resolves a linked-worktree .git FILE to the real dir; the
      // model answers <repoRoot>/.git like a plain checkout.
      return { code: 0, stdout: `${join(args[1] ?? '', '.git')}\n`, stderr: '' };
    }
    if (sub === 'rev-parse') {
      // argv shapes: ['-C', <path>, 'rev-parse', 'refs/cq-review/pr-7'],
      // ['-C', <path>, 'rev-parse', 'HEAD'],
      // ['-C', <path>, 'rev-parse', '--abbrev-ref', 'HEAD'].
      const at = args[1] ?? '';
      const target = args[3] ?? '';
      if (target === 'FETCH_HEAD' || target.startsWith('refs/cq-review/')) {
        if (model.fetchHeadFails !== undefined) {
          return {
            code: model.fetchHeadFails.code,
            stdout: '',
            stderr: model.fetchHeadFails.stderr,
          };
        }
        return { code: 0, stdout: `${model.fetchHeadSha ?? SHA_B}\n`, stderr: '' };
      }
      const checkout = model.headOf[at];
      if (checkout === undefined) {
        return {
          code: 128,
          stdout: '',
          stderr: 'fatal: not a git repository (or any of the parent directories): .git',
        };
      }
      if (target === 'HEAD') {
        if (at.startsWith(REPO)) await mkdir(at, { recursive: true });
        return { code: 0, stdout: `${checkout.head}\n`, stderr: '' };
      }
      if (target === '--abbrev-ref' && args[4] === 'HEAD') {
        return { code: 0, stdout: `${checkout.branch ?? 'HEAD'}\n`, stderr: '' };
      }
      return {
        code: 2,
        stdout: '',
        stderr: `fake git: unexpected rev-parse ${JSON.stringify(args)}`,
      };
    }
    if (sub === 'worktree') {
      const verb = args[3];
      if (verb === 'list') {
        const blocks = model.worktrees
          .map(
            (wt) =>
              `worktree ${wt.path}\nHEAD ${wt.head}${wt.branch === null ? '' : `\nbranch refs/heads/${wt.branch}`}`,
          )
          .join('\n\n');
        return { code: 0, stdout: blocks === '' ? '' : `${blocks}\n`, stderr: '' };
      }
      if (verb === 'add') {
        if (model.addFails !== undefined) {
          return { code: model.addFails.code, stdout: '', stderr: model.addFails.stderr };
        }
        // The ONLY add shape review ops uses: add -B <branch> <path> <sha>.
        if (args[4] !== '-B') {
          return {
            code: 2,
            stdout: '',
            stderr: `fake git: unexpected add argv ${JSON.stringify(args)}`,
          };
        }
        const branch = args[5] ?? '';
        const path = args[6] ?? '';
        const commitish = args[7] ?? '';
        // git's DOUBLE-CHECKOUT REFUSAL: `-B` does not bypass it — while
        // ANY other registered tree holds the branch, the add refuses with
        // git's message. `worktree remove` clears the hold.
        const holder = model.worktrees.find((wt) => wt.branch === branch && wt.path !== path);
        if (holder !== undefined) {
          return {
            code: 128,
            stdout: '',
            stderr: `fatal: '${branch}' is already checked out at '${holder.path}'`,
          };
        }
        if (model.worktrees.some((wt) => wt.path === path)) {
          return {
            code: 128,
            stdout: '',
            stderr: `fatal: '${path}' is already a registered worktree`,
          };
        }
        // `-B` (re)points the branch at the requested commit: the new
        // tree's HEAD lands at that sha (FETCH_HEAD resolves to the
        // fetched truth).
        const head =
          commitish === 'FETCH_HEAD' || commitish.startsWith('refs/cq-review/')
            ? (model.fetchHeadSha ?? SHA_B)
            : commitish;
        await mkdir(path, { recursive: true });
        model.worktrees.push({ path, branch, head });
        model.headOf[path] = { branch, head };
        return { code: 0, stdout: `Preparing worktree (checking out '${branch}')\n`, stderr: '' };
      }
      if (verb === 'remove') {
        if (model.removeFails !== undefined) {
          return { code: model.removeFails.code, stdout: '', stderr: model.removeFails.stderr };
        }
        const path = args[4] ?? '';
        model.worktrees = model.worktrees.filter((wt) => wt.path !== path);
        delete model.headOf[path];
        await rm(path, { recursive: true, force: true });
        return { code: 0, stdout: '', stderr: '' };
      }
    }
    return { code: 2, stdout: '', stderr: `fake git: unexpected argv ${JSON.stringify(args)}` };
  };
};

/** An in-memory WorktreeRegistry that records load/save/update calls in order. */
export const memRegistry = (
  initial: RegistryMap = {},
): SlotWorktreeRegistry & { calls: string[]; current: () => RegistryMap } => {
  const calls: string[] = [];
  let stored: RegistryMap = { ...initial };
  return {
    calls,
    read: async (pr) => {
      calls.push('load');
      const value = stored[String(pr)];
      return value
        ? {
            version: 1,
            state: 'bound',
            incomplete: false,
            checkoutPath: value.path,
            checkoutGitDir: join(value.path, '.git'),
          }
        : undefined;
    },
    withPrLock: async (_pr, action) => action(),
    update: async (key, value) => {
      const entry =
        value.state === 'bound'
          ? { path: value.checkoutPath, branch: reviewBranchFor(key), createdAt: NOW }
          : null;
      calls.push(entry === null ? `update:${key}:null` : `update:${key}`);
      if (entry === null) delete stored[key];
      else stored[key] = entry;
    },
    current: () => ({ ...stored }),
  };
};

/** Base opts over the fake model; repoRoot is a throwaway absolute path —
 * the fake git ignores -C (except through the model's own bookkeeping),
 * and only mkdir/stat touch the real fs. */
export const baseOpts = (
  model: FakeGit,
  registry: SlotWorktreeRegistry,
  over?: Partial<PrWorktreeOpts>,
): PrWorktreeOpts => ({
  repoRoot: REPO,
  pr: PR,
  headRefName: BRANCH,
  run: fakeGit(model),
  registry,
  nowMs: NOW,
  ...over,
});
