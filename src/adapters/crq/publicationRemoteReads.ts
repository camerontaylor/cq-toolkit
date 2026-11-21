/**
 * Offline remote-branch READ binding for the repair publication seam: the one
 * `c.git('ls-remote', '--heads', 'origin', 'refs/heads/' + branch)` that
 * `repair_tick.recover_publication` makes before it decides whether a journaled
 * publication already landed. Inactive and standalone: nothing imports this from
 * a runtime entry point, and it names no type from the publication orchestration.
 * {@link PublicationRemoteReads} is a structural subset of
 * `PublicationRecoveryEffects` and `PublicationPublishEffects`; a test pins that.
 *
 * Bound here: `lsRemoteHeads(branch)`, a single read-only `git ls-remote --heads
 * origin refs/heads/<branch>` in the primary clone (`c.CLONE`), through the
 * hardened `runGitIn` runner (`publishSource.ts`: argv array, no shell, scrubbed
 * `GIT_DIR`-class redirections, no prompts, no replace objects).
 *
 * Left explicit, none of it implemented here: `push` is the leased remote write
 * (`src/adapters/git/leasedPush.ts`), `prInfo` and `listBranchPrs` are forge reads
 * (`publicationForgeReads.ts`), `isAncestor` is a local read
 * (`publicationGitReads.ts`), and nothing here wires into `tick`, a runtime, or a
 * deployment. No fetch, no ref write, no credential: `ls-remote` only lists.
 *
 * Failure classes, which `recoverPublication` branches on:
 * - An ABSENT branch is a successful answer: `ls-remote` exits 0 with no output
 *   for a pattern that matches nothing (no `--exit-code`), so this returns `''` and
 *   recovery pushes with an empty lease. Nothing here turns an absence into an error.
 * - A Git process that exits non-zero (an unreachable or unconfigured `origin`,
 *   an authentication refusal) is `RuntimeError('git ls-remote --heads origin
 *   refs/heads/<branch> … exit <n>: <stderr stripped, 400 code points>')`, as
 *   `crq.run` raises it. It must never read as an absent branch.
 * - A process that never produced an exit code (spawn failure, the time bound, the
 *   output bound or a signal) is NOT a miss: it throws `PyError('OSError')`, as
 *   Python's `FileNotFoundError` and `TimeoutExpired` are not `RuntimeError`. The
 *   check runs before the output is read, as `subprocess.run` raises before it
 *   returns anything.
 *
 * Text matches Python's `text=True` pipes: strict UTF-8 (`ValueError` on invalid
 * bytes, as `UnicodeDecodeError`), universal newlines and `str.strip()`. The
 * decode precedes the exit-status check, as in `subprocess.run`, so an invalid
 * listing is a `ValueError` even when Git also failed.
 *
 * Narrowings, where Python would run `git ls-remote` on any string:
 * - The branch passes `branchPathFault` (`src/shared/refname.ts`): a relative,
 *   path-safe refname with no glob metacharacter, no space and no control
 *   character. `ls-remote` arguments are GLOB patterns, so `ma*` or `[ab]` would
 *   otherwise list rows for branches other than the one journaled.
 * - The remote is the literal `origin` and is not a parameter, so a caller cannot
 *   aim the read at another URL. The operand `refs/heads/<branch>` is never
 *   option-shaped.
 * - Only rows for exactly `refs/heads/<branch>` are returned. `ls-remote` matches a
 *   pattern as a tail (`*` `/` `<pattern>`), so a remote branch named
 *   `a/refs/heads/<branch>` also matches, and sorts before the branch itself when it
 *   sorts lower. Python takes the first row's SHA (`remote.split()[0]`), so that
 *   decoy would be read as this branch's tip, and a decoy alone would read an absent
 *   branch as present. Here the decoy rows are dropped. The rows are compared before
 *   `strip()`, so a branch ending in Unicode whitespace (which `branchPathFault`
 *   accepts) still matches its own, unstripped, row; the kept rows are then stripped.
 * - The time bound is the runner's (330 seconds); Python's `crq.run` allows 600.
 */
import { pyStrip } from '../../ops/crq/deploy/gitGuards.js';
import { branchPathFault } from '../../shared/refname.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import type { RunGit } from './ledgerGit.js';
import { runGitIn } from './publishSource.js';
import { answered, clip, pyStderr, pyText } from './publicationGitReads.js';

/** The publication remote read seam, bound to one clone. */
export interface PublicationRemoteReads {
  /**
   * `c.git('ls-remote', '--heads', 'origin', 'refs/heads/' + branch)`, stripped;
   * `''` when the branch is absent.
   */
  lsRemoteHeads(branch: string): Promise<string>;
}

export interface PublicationRemoteReadsOptions {
  /** `c.CLONE`: the primary clone, whose `origin` remote is read. */
  readonly clone: string;
  /** One hardened runner per repository directory; defaults to the shared `runGitIn`. */
  readonly runGitFor?: (repo: string) => RunGit;
}

/** The only remote publication recovery reads. */
const REMOTE = 'origin';

export function gitPublicationRemoteReads(
  options: PublicationRemoteReadsOptions,
): PublicationRemoteReads {
  const runGitFor = options.runGitFor ?? runGitIn;

  return {
    async lsRemoteHeads(branch) {
      const fault = typeof branch === 'string' ? branchPathFault(branch) : 'branch is not a string';
      if (fault !== null) throw new PyError('ValueError', fault);
      const ref = `refs/heads/${branch}`;
      const args = ['ls-remote', '--heads', REMOTE, ref];
      const call = await runGitFor(options.clone)(args);
      const code = answered(call);
      const text = pyText(call);
      if (code !== 0) {
        throw new PyError(
          'RuntimeError',
          `git ${args.join(' ')} … exit ${code}: ${clip(pyStrip(pyStderr(call)), 400)}`,
        );
      }
      // Compare the refs on the unstripped rows: a branch may end in Unicode whitespace
      // (`branchPathFault` accepts U+00A0, U+3000, ...), which `str.strip()` would take off
      // the last row's ref. Python strips the whole listing; strip only what is kept.
      return pyStrip(
        text
          .split('\n')
          .filter((row) => row.split('\t', 2)[1] === ref)
          .join('\n'),
      );
    },
  };
}
