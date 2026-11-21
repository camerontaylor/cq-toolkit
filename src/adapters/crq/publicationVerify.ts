/**
 * Offline claimed-range verification for the repair publication seam:
 * `crq_repair.verify(wt, base, commits, job)`, the defensive check
 * `repair_tick.publish` runs over each replayed repair (and `harvest` runs over
 * each fixer's claim) before anything is scanned, journaled or pushed.
 * Inactive and standalone: nothing imports this from a runtime entry point,
 * and it names no type from the publication orchestration.
 * {@link PublicationVerify} is a structural subset of what
 * `PublicationPublishEffects` (`src/queue-runner/publicationPublish.ts`)
 * declares for `verify`; a test pins it.
 *
 * What it decides, in Python's order (each Git call is read-only):
 * 1. `commits` is non-empty and has no duplicate: else `ValueError`.
 * 2. `HEAD` is read (`rev-parse HEAD`), then for every claim, in order:
 *    - it is 40 hex digits (`ValueError`, before any Git call for it);
 *    - it resolves as a commit (`cat-file -e <sha>^{commit}`): a failure is
 *      `RuntimeError`, NOT `ValueError`, so an unreadable object is retried by a
 *      later tick instead of recorded as a terminal rejection;
 *    - it is not `base` and `base` is an ancestor of it (a strict descendant);
 *    - it is an ancestor of `HEAD`;
 *    - it changes at least one path (`diff-tree --root --name-only -r`; a merge
 *      commit lists nothing there and so counts as empty);
 *    - its message names `job` at a non-digit boundary.
 * 3. `rev-list <base>..HEAD` is exactly the claimed set (no unclaimed commit);
 * 4. `status --porcelain` is empty (a clean tree).
 *
 * Failure classes, which `publishRepair` and `harvest` branch on:
 * - Every verdict above is `PyError('ValueError')` with Python's text, so the
 *   caller records a terminal failure.
 * - A Git process that exits non-zero where Python calls `git()` is
 *   `PyError('RuntimeError')`, `git <cmd> failed: <stderr[:200]>`.
 * - A process that never produced an exit code (spawn failure, the time bound,
 *   the output bound) is `PyError('OSError')`: never read as "not an
 *   ancestor", so an outage cannot become a terminal rejection.
 *
 * Text matches Python's `text=True` pipes through the shared reads
 * (`publicationWorktreeGit`): strict UTF-8, universal newlines, Python
 * `strip()`/`splitlines()`.
 *
 * Parity points a reader should not "fix":
 * - The `base` comparison is a case-sensitive string compare, exactly as
 *   Python's `sha == base`; an upper-case spelling of `base` is therefore a
 *   descendant of itself. It is still rejected by step 3, whose set compare is
 *   case-sensitive too (`rev-list` prints lower case).
 * - The attribution is Python's `(?<!\d)<job>(?!\d)` with `\d` meaning any
 *   Unicode decimal digit, so an Arabic-Indic digit next to the id blocks it
 *   while a letter does not. The id is matched literally.
 * - Python returns the `HEAD` it read. Callers ignore it, so this returns
 *   nothing (the structural pin needs `Promise<void>`).
 *
 * Narrowings, refusals where Python would run `git` on any string:
 * - `base` must be a 40-hex object id (`ValueError`), so it cannot be read as an
 *   option or as a revision expression such as `HEAD~0`. It is checked where
 *   Python first uses it, after a claim's `cat-file`.
 * - A worktree must be an absolute path that is a direct child of
 *   `worktreeRoot` (`c.WT_ROOT / name`); see `publicationGitReads.ts`.
 * - A non-string claim, `base` or `job` is a `TypeError`, as Python's `re` and
 *   `Popen` raise for a non-str.
 *
 * Not here: the hack detector, the secret scan and `mechanical` (the content
 * scans), any worktree mutation, the remote and the forge.
 */
import { splitlines } from '../../ops/crq/deploy/gitGuards.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import {
  commit,
  publicationWorktreeGit,
  type GitReadWorktree,
  type PublicationGitReadsOptions,
} from './publicationGitReads.js';

const OID_FULL = /^[0-9a-fA-F]{40}$/;
/** The characters a `u`-flag pattern lets us escape (its syntax characters). */
const REGEX_SYNTAX = /[\\^$.*+?()[\]{}|/]/g;

export const REJECT_MISSING_OR_DUPLICATE = 'missing or duplicate claimed commits';
export const REJECT_NOT_40_HEX = 'claimed commit is not 40-hex';
export const REJECT_NOT_DESCENDANT = 'commit is not a strict descendant of base';
export const REJECT_NOT_ANCESTOR_OF_HEAD = 'commit is not an ancestor of HEAD';
export const REJECT_EMPTY_COMMIT = 'empty commit';
export const REJECT_MISSING_FINDING_ID = 'commit message missing finding id';
export const REJECT_UNCLAIMED_COMMITS = 'unclaimed commits in repair range';
export const REJECT_DIRTY_TREE = 'dirty repair tree';

/** The claimed-range verification seam, bound to one worktree root. */
export interface PublicationVerify {
  /**
   * `verify(wt, base, commits, job)`: resolves when the claimed range verifies;
   * a rejected range is `PyError('ValueError')`, an unreadable object is
   * `PyError('RuntimeError')`.
   */
  verify(
    worktree: GitReadWorktree,
    base: string,
    commits: readonly string[],
    job: unknown,
  ): Promise<void>;
}

export type PublicationVerifyOptions = Pick<
  PublicationGitReadsOptions,
  'worktreeRoot' | 'runGitFor'
>;

/** `re.search(r'(?<!\d)' + re.escape(job) + r'(?!\d)', message)`, `\d` being Unicode `Nd`. */
export function namesJob(message: string, job: string): boolean {
  const literal = job.replace(REGEX_SYNTAX, '\\$&');
  return new RegExp(`(?<!\\p{Nd})${literal}(?!\\p{Nd})`, 'u').test(message);
}

export function gitPublicationVerify(options: PublicationVerifyOptions): PublicationVerify {
  const wt = publicationWorktreeGit(options);

  return {
    async verify(worktree, base, commits, job) {
      if (commits.length === 0 || new Set(commits).size !== commits.length) {
        throw new PyError('ValueError', REJECT_MISSING_OR_DUPLICATE);
      }
      const head = await wt.git(worktree, ['rev-parse', 'HEAD']);
      for (const sha of commits) {
        if (typeof sha !== 'string') throw new TypeError('claimed commit must be a str');
        if (!OID_FULL.test(sha)) throw new PyError('ValueError', REJECT_NOT_40_HEX);
        await wt.git(worktree, ['cat-file', '-e', `${sha}^{commit}`]);
        if (typeof base !== 'string') throw new TypeError('base must be a str');
        if (
          sha === base ||
          (await wt.exitCode(worktree, [
            'merge-base',
            '--is-ancestor',
            commit(base, 'base'),
            sha,
          ])) !== 0
        ) {
          throw new PyError('ValueError', REJECT_NOT_DESCENDANT);
        }
        if ((await wt.exitCode(worktree, ['merge-base', '--is-ancestor', sha, head])) !== 0) {
          throw new PyError('ValueError', REJECT_NOT_ANCESTOR_OF_HEAD);
        }
        const changed = await wt.git(worktree, [
          'diff-tree',
          '--root',
          '--no-commit-id',
          '--name-only',
          '-r',
          sha,
        ]);
        if (changed === '') throw new PyError('ValueError', REJECT_EMPTY_COMMIT);
        const message = await wt.git(worktree, ['show', '-s', '--format=%B', sha]);
        if (typeof job !== 'string') throw new TypeError('finding id must be a str');
        if (!namesJob(message, job)) throw new PyError('ValueError', REJECT_MISSING_FINDING_ID);
      }
      const inRange = new Set(
        splitlines(await wt.git(worktree, ['rev-list', `${commit(base, 'base')}..HEAD`])),
      );
      const claimed = new Set(commits);
      if (inRange.size !== claimed.size || [...inRange].some((sha) => !claimed.has(sha))) {
        throw new PyError('ValueError', REJECT_UNCLAIMED_COMMITS);
      }
      if ((await wt.git(worktree, ['status', '--porcelain'])) !== '') {
        throw new PyError('ValueError', REJECT_DIRTY_TREE);
      }
    },
  };
}
