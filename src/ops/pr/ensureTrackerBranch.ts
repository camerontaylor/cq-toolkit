// PR lane (goal D3 follow-up, review-debt #173) — ensure the sweep fleet's
// TRACKER BRANCH exists on the remote before `pr.assemblePrs` opens the
// tracker PR. The assembler NAMES the tracker head (`<runPrefix>/tracker`)
// but the tracker-first `gh pr create` needs that head to exist on the forge;
// the per-unit branches are pushed by `sweep.unit`, so this op closes the
// tracker leg.
//
// The op is a decision core over an injected {@link TrackerBranchEffects}
// seam (zero child_process here — the production binding is
// {@link makeSubprocessTrackerBranchEffects}). Per call:
//   1. read the remote head — when the branch already exists there, REUSE it
//      and return (a re-invoke must tolerate an existing remote branch and
//      must never rewind a live tracker branch);
//   2. otherwise ensure a LOCAL branch: reuse one when present (a previous
//      push may have stranded), else create it from `base`'s tip with an
//      EMPTY commit (a PR head with no commit difference cannot be opened);
//   3. push the branch, then RE-READ the remote head and refuse to report
//      success unless the forge now carries exactly the pushed commit — a
//      tracker PR whose head does not exist would be a fabricated
//      deliverable.
//
// No throws across the op seam: every effects rejection folds into a `failed`
// result; every input contract violation is a `failed` result naming the
// field (the family's boundary style).
import type { Op } from '../../kernel/types.js';
import { makeGhRunner } from '../review/gh.js';
import type { GhResult } from '../review/gh.js';
import { prBranchFaultOf, runPrefixFault } from './assemblePrs.js';

/** The shipped git wall clock for the tracker-branch leg (ms). */
export const DEFAULT_TRACKER_BRANCH_TIMEOUT_MS = 30_000;

/** Disable git's detached auto-maintenance (the sweep family's env idiom). */
const GIT_NO_AUTO_MAINTENANCE_ENV = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'gc.auto',
  GIT_CONFIG_VALUE_0: '0',
  GIT_CONFIG_KEY_1: 'maintenance.auto',
  GIT_CONFIG_VALUE_1: 'false',
} as const;

/**
 * The injected git seam for the tracker-branch leg. All effects resolve on
 * success and REJECT with a message on fault (the op folds the rejection);
 * none of them throws for an expected "absent" (a missing remote or local
 * ref is `null`, not a fault).
 */
export interface TrackerBranchEffects {
  /** The remote's head sha for `branch`, or null when the remote has no such ref. */
  remoteHead(branch: string): Promise<string | null>;
  /** The local ref sha for `branch`, or null when the local repo has no such ref. */
  localHead(branch: string): Promise<string | null>;
  /** Create the local branch at `base`'s tip with an EMPTY commit; returns the new commit sha. */
  createBranch(branch: string, base: string): Promise<string>;
  /** Push `branch` to `origin`. */
  pushBranch(branch: string): Promise<void>;
}

/** JSON-serializable input of the `pr.ensureTrackerBranch` op. */
export interface EnsureTrackerBranchInput {
  /** Repository the branch is created in and pushed from (the effects bind `git -C` to it). */
  repoRoot: string;
  /** The run's reserved branch prefix — the tracker branch lives under it. */
  runPrefix: string;
  /** The commit the tracker branch is created from when absent (e.g. the PR base). */
  base: string;
  /** The tracker PR's head branch; must start `<runPrefix>/`. */
  branch: string;
  /**
   * Push the branch to `origin` (DEFAULT TRUE). `false` is the local-only
   * mode the sweep's `push:false` overlay selects: the local branch is still
   * ensured (so a fake-forge assembly can open the PR) but the remote is
   * never touched — a local-only run may have no origin at all.
   */
  push?: boolean;
}

/** The op's report: the branch, its head sha, and how it got there. */
export interface EnsureTrackerBranchReport {
  branch: string;
  /** The head sha now on the remote (equal to the pushed/local commit). */
  headSha: string;
  /** true when this call created the local branch (an empty commit on `base`). */
  created: boolean;
  /** true when this call pushed the branch (always false in `push:false` mode). */
  pushed: boolean;
  /** true when the remote already carried the branch — a re-invoke reuse. */
  reusedRemote: boolean;
}

/**
 * Build the `pr.ensureTrackerBranch` op over injected git effects. See the
 * module header for the per-call order and the remote re-verification.
 */
export function makeEnsureTrackerBranch(
  effects: TrackerBranchEffects,
): Op<EnsureTrackerBranchInput, EnsureTrackerBranchReport> {
  return async (input) => {
    const fault = inputFaultOf(input);
    if (fault !== null) return { status: 'failed', error: fault };
    try {
      // 0. LOCAL-ONLY mode (`push:false`): ensure the local branch exists but
      //    never touch the remote — a local-only fleet may have no origin.
      if (input.push === false) {
        let localSha = await effects.localHead(input.branch);
        let localCreated = false;
        if (localSha === null) {
          localSha = await effects.createBranch(input.branch, input.base);
          localCreated = true;
        }
        return {
          status: 'ok',
          value: {
            branch: input.branch,
            headSha: localSha,
            created: localCreated,
            pushed: false,
            reusedRemote: false,
          },
        };
      }
      // 1. The remote is authoritative for a re-invoke: an existing remote
      //    branch is reused verbatim, never rewound to a fresh empty commit.
      const remote = await effects.remoteHead(input.branch);
      if (remote !== null) {
        return {
          status: 'ok',
          value: {
            branch: input.branch,
            headSha: remote,
            created: false,
            pushed: false,
            reusedRemote: true,
          },
        };
      }
      // 2. Ensure a local branch (reuse a stranded one; else create the
      //    empty commit that gives the PR head a commit difference).
      let headSha = await effects.localHead(input.branch);
      let created = false;
      if (headSha === null) {
        headSha = await effects.createBranch(input.branch, input.base);
        created = true;
      }
      // 3. Push, then re-read the remote: success is the forge carrying
      //    EXACTLY the commit we pushed, not the push command's exit code.
      await effects.pushBranch(input.branch);
      const after = await effects.remoteHead(input.branch);
      if (after === null) {
        return {
          status: 'failed',
          error: `pr: pushed tracker branch '${input.branch}' but the remote reports no head — the tracker PR head would not exist on the forge`,
        };
      }
      if (after !== headSha) {
        return {
          status: 'failed',
          error: `pr: the remote head for '${input.branch}' (${after}) is not the pushed commit (${headSha}) — refusing to report a tracker branch the forge does not carry`,
        };
      }
      return {
        status: 'ok',
        value: {
          branch: input.branch,
          headSha: after,
          created,
          pushed: true,
          reusedRemote: false,
        },
      };
    } catch (err) {
      return {
        status: 'failed',
        error: `pr: could not ensure the tracker branch '${input.branch}' — ${messageOf(err)}`,
      };
    }
  };
}

/**
 * The production binding: {@link TrackerBranchEffects} over the REAL `git`
 * in `repoRoot`. Every git call is an execFile ARGS ARRAY (never a shell
 * string), bounded by {@link DEFAULT_TRACKER_BRANCH_TIMEOUT_MS}, with git's
 * detached auto-maintenance disabled. `createBranch` uses `commit-tree` +
 * `update-ref` (never a checkout): the repo's HEAD and working tree are
 * untouched, so a dirty sweep repo cannot be disturbed.
 */
export function makeSubprocessTrackerBranchEffects(
  repoRoot: string,
  opts?: { timeoutMs?: number },
): TrackerBranchEffects {
  const git = makeGhRunner({
    bin: 'git',
    timeoutMs: opts?.timeoutMs ?? DEFAULT_TRACKER_BRANCH_TIMEOUT_MS,
    env: { ...GIT_NO_AUTO_MAINTENANCE_ENV },
  });
  const run = (args: string[]): Promise<GhResult> => git(['-C', repoRoot, ...args]);
  const must = async (args: string[]): Promise<string> => {
    const result = await run(args);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
    }
    return result.stdout;
  };
  return {
    async remoteHead(branch) {
      const result = await run(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `git ls-remote --heads origin ${branch} failed`);
      }
      const line = result.stdout.split('\n').find((candidate) => candidate.trim() !== '');
      if (line === undefined) return null;
      const sha = line.trim().split(/\s+/)[0];
      return sha === undefined || sha === '' ? null : sha;
    },
    async localHead(branch) {
      const result = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      if (result.code === 0) {
        const sha = result.stdout.trim();
        return sha === '' ? null : sha;
      }
      // `--verify --quiet` exits nonzero with EMPTY streams for an absent
      // ref; any other nonzero (a runner timeout 124, a corrupt/blocked repo
      // 128, …) is a real fault, never "the branch is absent".
      if (result.stdout.trim() === '' && result.stderr.trim() === '') return null;
      throw new Error(
        result.stderr.trim() ||
          `git rev-parse --verify refs/heads/${branch} failed (exit ${String(result.code)})`,
      );
    },
    async createBranch(branch, base) {
      const baseSha = (await must(['rev-parse', '--verify', `${base}^{commit}`])).trim();
      const tree = (await must(['rev-parse', `${baseSha}^{tree}`])).trim();
      const newSha = (
        await must([
          'commit-tree',
          tree,
          '-p',
          baseSha,
          '-m',
          `chore(sweep): open tracker branch ${branch}`,
        ])
      ).trim();
      const updated = await run(['update-ref', `refs/heads/${branch}`, newSha]);
      if (updated.code !== 0) {
        throw new Error(
          updated.stderr.trim() || `git update-ref refs/heads/${branch} ${newSha} failed`,
        );
      }
      return newSha;
    },
    async pushBranch(branch) {
      const result = await run(['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
      if (result.code !== 0) {
        throw new Error(
          result.stderr.trim() ||
            `git push origin ${branch} failed (the tracker PR head must exist on the remote)`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Boundary validation — `failed` naming the field, before any git call
// ---------------------------------------------------------------------------

/** Control characters (Unicode Cc) — refused on every string fed to git. */
const CONTROL_CHARS_RE = /[\p{Cc}]/u;

/**
 * Library-level input contract (the registry schema mirrors the plain-JSON
 * shape): non-empty strings, the run-prefix rule on the branch (the tracker
 * lives under the run's namespace), a `base` that is a positional git
 * argument (never a flag), and control-char refusals.
 */
function inputFaultOf(input: EnsureTrackerBranchInput): string | null {
  if (input === null || typeof input !== 'object') {
    return 'pr: input must be an object (repoRoot, runPrefix, base, branch)';
  }
  for (const [field, value] of [
    ['repoRoot', input.repoRoot],
    ['runPrefix', input.runPrefix],
    ['base', input.base],
  ] as const) {
    if (typeof value !== 'string' || value === '') {
      return `pr: ${field} must be a non-empty string`;
    }
  }
  if (CONTROL_CHARS_RE.test(input.repoRoot)) {
    return 'pr: repoRoot must not contain control characters — the subprocess effects run git with it as the working directory';
  }
  if (CONTROL_CHARS_RE.test(input.runPrefix)) {
    return 'pr: runPrefix must not contain control characters — it feeds the tracker branch refname';
  }
  if (CONTROL_CHARS_RE.test(input.base)) {
    return 'pr: base must not contain control characters — it is a positional git argument';
  }
  if (input.base.startsWith('-')) {
    return `pr: base '${input.base}' must not start with '-' — it is a positional git argument, never a flag`;
  }
  const prefixFault = runPrefixFault(input.runPrefix);
  if (prefixFault !== null) return prefixFault;
  if (input.push !== undefined && typeof input.push !== 'boolean') {
    return `pr: push (${String(input.push)}) must be a boolean (absent means true)`;
  }
  return prBranchFaultOf(input.branch, input.runPrefix, 'branch');
}

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
