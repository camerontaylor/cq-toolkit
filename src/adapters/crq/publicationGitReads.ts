/**
 * Offline local-Git READ bindings for the repair publication seam:
 * the reads `repair_tick.publish` makes through `c.git`, `c.is_ancestor` and
 * `wt_git` (`crq_repair.git`) before anything is journaled or pushed.
 * Inactive and standalone: nothing imports this from a runtime entry point,
 * and it names no type from the publication orchestration.
 * {@link PublicationGitReads} is a structural subset of what
 * `PublicationPublishEffects` (`src/queue-runner/publicationPublish.ts`)
 * declares; a test pins it.
 *
 * Bound here, every one a read-only `git` call:
 * - `revParseDefaultRef`: `c.git('rev-parse', DEFAULT_REF)` in the primary clone.
 * - `isAncestor`: `c.is_ancestor(a, b)` (`merge-base --is-ancestor`) in the primary clone.
 * - `revParseHead`, `verifyCherryPickHead`, `conflictedFiles`, `stagedFiles`,
 *   `revListSince`, `diffSince`: the matching `wt_git(wt, ...)` calls in the publish worktree.
 *
 * Left explicit, none of it implemented here: `cherryPick`, `makeWorktree`,
 * `removeWorktree` and `updateRef` mutate a worktree, branch or ref (bound
 * separately in `publicationWorktrees.ts`); `lsRemoteHeads`
 * and `push` talk to the remote; `prInfo` and `listBranchPrs` are forge reads;
 * `verify`, `hackDetector` and `secretScan` are scans; the patch, journal and queue
 * writes are `publicationFiles.ts`. No fetch, no network, no write.
 *
 * Failure classes, which `publishRepair` branches on:
 * - A Git process that exits non-zero is a semantic answer. `wt_git` raises
 *   `RuntimeError('git <cmd> failed: <stderr[:200]>')`, `c.git` raises
 *   `RuntimeError('git <argv> … exit <n>: <stderr[:400]>')`, and `is_ancestor` is
 *   `false` on any non-zero exit (Python compares the return code only).
 * - A process that never produced an exit code (spawn failure, the time bound, the
 *   output bound or a signal) is NOT a miss: it throws `PyError('OSError')`, as
 *   Python's `FileNotFoundError`/`TimeoutExpired` are not `RuntimeError`, so
 *   `verifyCherryPickHead` cannot be read as "no cherry-pick in progress" and
 *   `isAncestor` cannot mark a record stale.
 *
 * Text matches Python's `text=True` pipes: strict UTF-8 (`ValueError` on invalid
 * bytes, as `UnicodeDecodeError`), universal newlines (`\r\n` and `\r` become `\n`,
 * so a CRLF file's diff differs from the raw bytes) and `str.strip()`.
 *
 * Narrowings, all refusals where Python would run `git` on any string:
 * - A commit operand (`isAncestor`, `revListSince`, `diffSince`) must be a 40-hex
 *   object id, so no operand can be read as an option or a revision expression.
 * - A worktree must be an absolute path that is a direct child of `worktreeRoot`
 *   (`c.WT_ROOT / name`), so a read cannot be pointed at an arbitrary repository.
 * - The full diff adds `--no-ext-diff --no-textconv --no-color` and pins the `a/`
 *   `b/` prefixes. Under default config the bytes equal Python's plain `git diff`;
 *   an ambient `diff.external`, `diff.textconv`, `color.diff` or `diff.noprefix`
 *   no longer reshapes the patch that is written and scanned.
 */
import { isAbsolute, dirname, normalize } from 'node:path';
import { pyStrip, splitlines } from '../../ops/crq/deploy/gitGuards.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import type { GitCall, RunGit } from './ledgerGit.js';
import { runGitIn } from './publishSource.js';

/** `runtime_target.DEFAULT_REF`. */
const DEFAULT_REF = 'origin/main';
const OID = /^[0-9a-fA-F]{40}$/;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A publish worktree: `c.make_worktree(name, sha)`. */
export interface GitReadWorktree {
  readonly path: string;
}

/** The publication Git read seams, bound to one clone and one worktree root. */
export interface PublicationGitReads {
  /** `c.git('rev-parse', DEFAULT_REF)`. */
  revParseDefaultRef(): Promise<string>;
  /** `c.is_ancestor(older, newer)`. */
  isAncestor(older: string, newer: string): Promise<boolean>;
  /** `wt_git(wt, 'rev-parse', 'HEAD')`. */
  revParseHead(worktree: GitReadWorktree): Promise<string>;
  /** `wt_git(wt, 'rev-parse', '--verify', 'CHERRY_PICK_HEAD')`; absent is `PyError('RuntimeError')`. */
  verifyCherryPickHead(worktree: GitReadWorktree): Promise<void>;
  /** `wt_git(wt, 'diff', '--name-only', '--diff-filter=U')`, stripped. */
  conflictedFiles(worktree: GitReadWorktree): Promise<string>;
  /** `wt_git(wt, 'diff', '--cached', '--name-only')`, stripped. */
  stagedFiles(worktree: GitReadWorktree): Promise<string>;
  /** `wt_git(wt, 'rev-list', '--reverse', before + '..HEAD').splitlines()`. */
  revListSince(worktree: GitReadWorktree, before: string): Promise<readonly string[]>;
  /** `wt_git(wt, 'diff', target + '..HEAD')`, stripped. */
  diffSince(worktree: GitReadWorktree, target: string): Promise<string>;
}

export interface PublicationGitReadsOptions {
  /** `c.CLONE`: the primary clone, where `c.git` and `c.is_ancestor` run. */
  readonly clone: string;
  /** `c.WT_ROOT`: every publish worktree is a direct child of it. */
  readonly worktreeRoot: string;
  /** One hardened runner per repository directory; defaults to the shared `runGitIn`. */
  readonly runGitFor?: (repo: string) => RunGit;
}

/** `str[:n]` by code point. */
export function clip(text: string, n: number): string {
  const points = Array.from(text);
  return points.length <= n ? text : points.slice(0, n).join('');
}

/** Text-mode stderr: universal newlines, as `subprocess` text mode applies to both pipes. */
export function pyStderr(call: GitCall): string {
  return call.stderr.replace(/\r\n?/g, '\n');
}

/** `Path` spelling: no trailing separator, except for the filesystem root. */
export function canonicalDir(path: string): string {
  const normalized = normalize(path);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/** A call that never reported an exit code did not answer: it is not a miss. */
export function answered(call: GitCall): number {
  if (call.code === null) {
    throw new PyError(
      'OSError',
      `git ${call.args[0] ?? ''} did not complete: ${clip(pyStrip(pyStderr(call)), 200) || 'no exit status'}`,
    );
  }
  return call.code;
}

/** `subprocess` text mode: strict UTF-8, then universal newlines. */
export function pyText(call: GitCall): string {
  let text: string;
  try {
    text = strictUtf8.decode(call.stdout);
  } catch {
    throw new PyError('ValueError', "'utf-8' codec can't decode git output");
  }
  return text.replace(/\r\n?/g, '\n');
}

export function commit(value: string, what: string): string {
  if (!OID.test(value)) throw new PyError('ValueError', `${what} is not a 40-hex object id`);
  return value;
}

/** A publish worktree's Git runner: `wt_git` (stripped stdout) and a bare exit code. */
export interface PublicationWorktreeGit {
  /** `wt_git(wt, *args)`: stripped stdout; a non-zero exit is `RuntimeError`. */
  git(worktree: GitReadWorktree, args: readonly string[]): Promise<string>;
  /**
   * `command(['git', *args], cwd=wt).returncode`: the exit code, whatever it is.
   * A call that never produced one is `OSError`: `command` raises
   * `FileNotFoundError` (an `OSError`) or `TimeoutExpired` (a `SubprocessError`)
   * rather than returning, and this seam normalizes both to `OSError` on purpose,
   * so neither can be read as a non-zero exit such as "not an ancestor".
   */
  exitCode(worktree: GitReadWorktree, args: readonly string[]): Promise<number>;
}

/** Binds Git to the publish worktrees under one root; refuses any other directory. */
export function publicationWorktreeGit(
  options: Pick<PublicationGitReadsOptions, 'worktreeRoot' | 'runGitFor'>,
): PublicationWorktreeGit {
  const runGitFor = options.runGitFor ?? runGitIn;
  const root = canonicalDir(options.worktreeRoot);
  if (!isAbsolute(root)) throw new PyError('ValueError', 'worktree root must be absolute');

  const owned = (worktree: GitReadWorktree): string => {
    const path = canonicalDir(worktree.path);
    if (!isAbsolute(path) || dirname(path) !== root || path === root) {
      throw new PyError('ValueError', 'publish worktree is outside the worktree root');
    }
    return path;
  };

  return {
    async git(worktree, args) {
      const call = await runGitFor(owned(worktree))(args);
      // Exit code first: a bounded or killed process leaves partial (possibly cut
      // mid-UTF-8) output and no code, which is OSError, not a decode failure.
      const code = answered(call);
      const text = pyText(call);
      if (code !== 0) {
        throw new PyError('RuntimeError', `git ${args[0]} failed: ${clip(pyStderr(call), 200)}`);
      }
      return pyStrip(text);
    },
    async exitCode(worktree, args) {
      return answered(await runGitFor(owned(worktree))(args));
    },
  };
}

export function gitPublicationReads(options: PublicationGitReadsOptions): PublicationGitReads {
  const runGitFor = options.runGitFor ?? runGitIn;
  const wtGit = publicationWorktreeGit(options).git;

  return {
    async revParseDefaultRef() {
      const args = ['rev-parse', DEFAULT_REF];
      const call = await runGitFor(options.clone)(args);
      const text = pyText(call);
      const code = answered(call);
      if (code !== 0) {
        throw new PyError(
          'RuntimeError',
          `git ${args.join(' ')} … exit ${code}: ${clip(pyStrip(pyStderr(call)), 400)}`,
        );
      }
      return pyStrip(text);
    },

    async isAncestor(older, newer) {
      const call = await runGitFor(options.clone)([
        'merge-base',
        '--is-ancestor',
        commit(older, 'ancestor'),
        commit(newer, 'descendant'),
      ]);
      return answered(call) === 0;
    },

    revParseHead: (worktree) => wtGit(worktree, ['rev-parse', 'HEAD']),

    async verifyCherryPickHead(worktree) {
      await wtGit(worktree, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD']);
    },

    conflictedFiles: (worktree) => wtGit(worktree, ['diff', '--name-only', '--diff-filter=U']),

    stagedFiles: (worktree) => wtGit(worktree, ['diff', '--cached', '--name-only']),

    async revListSince(worktree, before) {
      return splitlines(
        await wtGit(worktree, ['rev-list', '--reverse', `${commit(before, 'before')}..HEAD`]),
      );
    },

    async diffSince(worktree, target) {
      return wtGit(worktree, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        `${commit(target, 'target')}..HEAD`,
      ]);
    },
  };
}
