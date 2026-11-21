/**
 * Offline local-Git WRITE bindings for the repair publication seam: the four
 * local effects `repair_tick.publish` runs that are not reads, and none of
 * them touches a remote.
 * Inactive and standalone: nothing imports this from a runtime entry point,
 * and it names no type from the publication orchestration.
 * {@link PublicationWorktrees} is a structural subset of what
 * `PublicationPublishEffects` (`src/queue-runner/publicationPublish.ts`)
 * declares; a test pins it. The reads live in `publicationGitReads.ts`.
 *
 * Bound here:
 * - `makeWorktree`: `c.make_worktree('publish-' + run, target)`. Pre-clean the
 *   path and branch, then `git -c filter.lfs.smudge= -c filter.lfs.process=
 *   worktree add --quiet -B crq/<name> <path> <sha>` in the primary clone with
 *   `GIT_LFS_SKIP_SMUDGE=1` (owner decision #347). A Git failure (or a call
 *   that never finished) cleans up again and re-raises the original error, so
 *   a retry starts from nothing.
 * - `removeWorktree`: `c.remove_worktree(wt, branch)`, run on every exit of
 *   `publishRepair`. `git worktree remove --force`, then, if the path survives,
 *   a recursive delete that ignores errors, then `git worktree prune` and
 *   `git branch -D`. None of the three Git calls is checked, as in Python.
 * - `cherryPick`: `wt_git(wt, 'cherry-pick', sha)`; a non-zero exit is
 *   `RuntimeError('git cherry-pick failed: <stderr[:200]>')`, which is what
 *   `publishRepair` inspects to tell a deterministic replay failure from a
 *   retryable one.
 * - `updateRef`: `c.git('update-ref', 'refs/crq/publication/' + run, head)` in
 *   the primary clone. Like Python it overwrites an existing ref, so a retried
 *   run re-points its own publication ref.
 *
 * Left explicit: `lsRemoteHeads` and `push` talk to the remote; `prInfo` and
 * `listBranchPrs` are forge reads; `verify`, `hackDetector` and `secretScan`
 * are scans; the patch, journal and queue writes are `publicationFiles.ts`.
 * No fetch, no network, no forge call.
 *
 * Failure classes match `publicationGitReads.ts`: a Git exit is a semantic
 * answer (`RuntimeError`, text as Python formats it); a process that never
 * produced an exit code is `PyError('OSError')`, never a miss; output decodes
 * as Python text mode does (strict UTF-8, universal newlines).
 *
 * Narrowings, all refusals where Python would run `git` or delete on any string:
 * - A worktree name is one path component of `[A-Za-z0-9._-]` that is also a valid
 *   branch component (no `..`, no trailing `.` or `.lock`), so no name can climb
 *   out of the root, name a nested path, or be read as an option.
 * - A worktree is owned only when its path is `<worktreeRoot>/<prefix><name>`
 *   and its branch is `crq/<name>`. `removeWorktree` and `cherryPick` refuse
 *   anything else before any Git call or delete, so a mis-built handle cannot
 *   delete a directory or branch this module did not create.
 * - The recursive delete never follows or removes a symlink or a non-directory
 *   at the path (`shutil.rmtree` refuses a symlink; `ignore_errors` hides it).
 * - A commit operand must be a 40-hex object id; the ref must be
 *   `refs/crq/publication/<name>`.
 * - A worktree directory that is absent when `cherryPick` starts is
 *   `PyError('OSError')`, as Python's `Popen(cwd=...)` is `FileNotFoundError`.
 * - Git runs through the hardened argv-array runner with a scrubbed
 *   environment, bounded by its own time limit; the time bound and the
 *   spawn-failure case are one failure class here, and both clean up after a
 *   failed `makeWorktree` (the cleanup is idempotent).
 */
import { lstat, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pyStrip } from '../../ops/crq/deploy/gitGuards.js';
import { isPyError, PyError } from '../../queue-runner/pyErrors.js';
import type { GitCall, RunGit } from './ledgerGit.js';
import { runGitIn } from './publishSource.js';
import { answered, canonicalDir, clip, commit, pyStderr, pyText } from './publicationGitReads.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PUBLICATION_REF = /^refs\/crq\/publication\/(.+)$/;
/** `make_worktree` suppresses LFS smudging so a broken LFS filter never blocks a checkout. */
const LFS_OFF = ['-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process='] as const;

/** A publish worktree: the `(path, branch)` pair `c.make_worktree` returns. */
export interface PublicationWorktree {
  readonly path: string;
  readonly branch: string;
}

/** The publication local Git write seams, bound to one clone and one worktree root. */
export interface PublicationWorktrees {
  /** `c.make_worktree(name, sha)`. */
  makeWorktree(name: string, sha: string): Promise<PublicationWorktree>;
  /** `c.remove_worktree(wt, branch)`. */
  removeWorktree(worktree: PublicationWorktree): Promise<void>;
  /** `wt_git(wt, 'cherry-pick', sha)`; a Git failure is `PyError('RuntimeError')`. */
  cherryPick(worktree: PublicationWorktree, sha: string): Promise<void>;
  /** `c.git('update-ref', ref, sha)`. */
  updateRef(ref: string, sha: string): Promise<void>;
}

export interface PublicationWorktreesOptions {
  /** `c.CLONE`: the primary clone, where worktrees, branches and refs are written. */
  readonly clone: string;
  /** `c.WT_ROOT`: every publish worktree is a direct child of it. */
  readonly worktreeRoot: string;
  /** `c.WT_PREFIX` (`config.json` `worktree_prefix`). */
  readonly worktreePrefix: string;
  /** One hardened runner per repository directory; defaults to the shared `runGitIn`. */
  readonly runGitFor?: (repo: string) => RunGit;
}

/** One path component that is also a valid branch and ref component. */
function component(value: string, what: string): string {
  if (!NAME.test(value) || value.includes('..') || value.endsWith('.') || value.endsWith('.lock'))
    throw new PyError('ValueError', `${what} is not a safe name`);
  return value;
}

/** `Path.exists()` on Python 3.14: follows symlinks, and an error reads as absent. */
async function pyExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `shutil.rmtree(path, ignore_errors=True)`: a real directory is removed
 * recursively; a symlink or any other file is left alone (rmtree refuses it and
 * the refusal is ignored); every error is swallowed.
 */
async function pyRmtree(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isDirectory()) return;
    await rm(path, { recursive: true, force: true });
  } catch {
    // ignore_errors=True
  }
}

/** `' '.join(cmd[:6])` of `crq.run`'s failure text, where `cmd` is `['git', *args]`. */
function runFailure(args: readonly string[], code: number, call: GitCall): PyError {
  return new PyError(
    'RuntimeError',
    `${['git', ...args].slice(0, 6).join(' ')} … exit ${code}: ${clip(pyStrip(pyStderr(call)), 400)}`,
  );
}

export function gitPublicationWorktrees(
  options: PublicationWorktreesOptions,
): PublicationWorktrees {
  const runGitFor = options.runGitFor ?? runGitIn;
  const root = canonicalDir(options.worktreeRoot);
  if (!isAbsolute(root)) throw new PyError('ValueError', 'worktree root must be absolute');
  const prefix = options.worktreePrefix;
  if (prefix === '' || /[/\\\0]/.test(prefix) || prefix === '.' || prefix === '..')
    throw new PyError('ValueError', 'worktree prefix is not a safe name');

  /** `c.git(*args)` / `c.run(...)` in the primary clone: the raw call, decoded as text mode does. */
  const inClone = async (
    args: readonly string[],
    env?: Record<string, string>,
  ): Promise<{ readonly code: number; readonly call: GitCall }> => {
    const call = await runGitFor(options.clone)(args, env === undefined ? undefined : { env });
    const code = answered(call);
    pyText(call);
    return { code, call };
  };

  /** `c.git(*args)` with `check=True`. */
  const checked = async (args: readonly string[], env?: Record<string, string>): Promise<void> => {
    const { code, call } = await inClone(args, env);
    if (code !== 0) throw runFailure(args, code, call);
  };

  /** The owned `(path, name)` of a handle, or a refusal before any Git call or delete. */
  const owned = (worktree: PublicationWorktree): { path: string; name: string } => {
    const path = canonicalDir(worktree.path);
    const base = basename(path);
    if (!isAbsolute(path) || dirname(path) !== root || !base.startsWith(prefix))
      throw new PyError('ValueError', 'publish worktree is not owned by the worktree root');
    const name = component(base.slice(prefix.length), 'publish worktree');
    if (worktree.branch !== `crq/${name}`)
      throw new PyError('ValueError', 'publish worktree branch does not match its path');
    return { path, name };
  };

  /** `c.remove_worktree(path, branch)` on an already owned pair; no Git call is checked. */
  const remove = async (path: string, branch: string): Promise<void> => {
    if (await pyExists(path)) {
      await inClone(['worktree', 'remove', '--force', path]);
      if (await pyExists(path)) await pyRmtree(path);
    }
    await inClone(['worktree', 'prune']);
    await inClone(['branch', '-D', branch]);
  };

  return {
    async makeWorktree(name, sha) {
      const safe = component(name, 'worktree name');
      const oid = commit(sha, 'worktree commit');
      const path = join(root, `${prefix}${safe}`);
      const branch = `crq/${safe}`;
      await remove(path, branch);
      try {
        await checked([...LFS_OFF, 'worktree', 'add', '--quiet', '-B', branch, path, oid], {
          GIT_LFS_SKIP_SMUDGE: '1',
        });
      } catch (error) {
        // `except (RuntimeError, subprocess.TimeoutExpired)`: a decode failure is not caught.
        if (isPyError(error, 'RuntimeError', 'OSError')) await remove(path, branch);
        throw error;
      }
      return { path, branch };
    },

    async removeWorktree(worktree) {
      const { path } = owned(worktree);
      await remove(path, worktree.branch);
    },

    async cherryPick(worktree, sha) {
      const { path } = owned(worktree);
      const oid = commit(sha, 'cherry-pick commit');
      try {
        if (!(await stat(path)).isDirectory()) throw new Error('not a directory');
      } catch {
        throw new PyError('OSError', `publish worktree directory is not available: ${path}`);
      }
      const call = await runGitFor(path)(['cherry-pick', oid]);
      const code = answered(call);
      pyText(call);
      if (code !== 0)
        throw new PyError('RuntimeError', `git cherry-pick failed: ${clip(pyStderr(call), 200)}`);
    },

    async updateRef(ref, sha) {
      const match = PUBLICATION_REF.exec(ref);
      if (match === null) throw new PyError('ValueError', 'ref is not a publication ref');
      component(match[1]!, 'publication ref');
      await checked(['update-ref', ref, commit(sha, 'ref target')]);
    },
  };
}
