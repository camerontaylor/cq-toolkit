/**
 * `crq_repair.mechanical(config, wt, base, commits, job, directory)`
 * (apps/crq-python/crq_repair.py:152), the content gate `repair_tick.harvest` runs
 * over a fixer's claimed commits before it publishes anything. Inactive: nothing
 * imports this from a runtime entry point.
 *
 * In Python's order:
 * 1. `verify(wt, base, commits, job)` (the claimed-range check; `publicationVerify.ts`);
 * 2. `diff = git(wt, 'diff', base + '..HEAD')`, stripped;
 * 3. `<directory>/repair.patch` is written with `diff + '\n'` (the evidence copy);
 * 4. `hack_detector` scans the stripped diff text (`repairHackDetector.ts`).
 * The record is `{verify: 'ok', hack: 'ok', tests: 'suspended'}`; the harvest seam
 * ignores it.
 *
 * Parity points a reader should not "fix":
 * - The patch holds the diff after Python's `strip()` plus one newline, so a diff
 *   ending in trailing whitespace (an added line `x   `) is written, and scanned,
 *   without it. A missing `directory` is `FileNotFoundError`, raised after the diff
 *   was read and before the detector runs, so no scan is attempted.
 * - A failed write leaves a partial or absent patch, never a detector call.
 *
 * Deviation: the diff comes from `diffSince` (`publicationGitReads.ts`), which adds
 * `--no-ext-diff --no-textconv --no-color` and pins the `a/` `b/` prefixes. Under
 * default config the bytes equal Python's plain `git diff`.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PyError } from '../../queue-runner/pyErrors.js';
import {
  gitPublicationReads,
  type GitReadWorktree,
  type PublicationGitReadsOptions,
} from './publicationGitReads.js';
import { runHackDetector, inProcessDetector, type DetectorRun } from './repairHackDetector.js';
import { gitPublicationVerify } from './publicationVerify.js';

/** What `mechanical` returns. */
export interface MechanicalRecord {
  readonly verify: 'ok';
  readonly hack: 'ok';
  readonly tests: 'suspended';
}

export interface RepairMechanicalOptions extends Pick<
  PublicationGitReadsOptions,
  'clone' | 'worktreeRoot' | 'runGitFor'
> {
  /** `Path(directory)` for a job: where `repair.patch` is written. */
  readonly repairDirectory: (jobId: string) => string;
  /** The detector process; defaults to the pure op in process. */
  readonly detector?: DetectorRun;
}

/** Python's `OSError` text for a failed `write_text`. */
function writeFailure(error: unknown, path: string): PyError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new PyError(
      code === 'ENOENT' ? 'FileNotFoundError' : 'OSError',
      `[Errno ${code === 'ENOENT' ? 2 : 20}] ${code === 'ENOENT' ? 'No such file or directory' : 'Not a directory'}: '${path}'`,
    );
  }
  return new PyError('OSError', error instanceof Error ? error.message : String(error));
}

export interface RepairMechanical {
  /** `mechanical(...)` with the job's repair directory from the options. */
  mechanical(
    worktree: GitReadWorktree,
    base: string,
    commits: readonly string[],
    job: string,
  ): Promise<MechanicalRecord>;
}

export function gitRepairMechanical(options: RepairMechanicalOptions): RepairMechanical {
  const reads = gitPublicationReads(options);
  const verifier = gitPublicationVerify(options);
  const detector = options.detector ?? inProcessDetector;
  return {
    async mechanical(worktree, base, commits, job) {
      await verifier.verify(worktree, base, commits, job);
      const diff = await reads.diffSince(worktree, base);
      const patch = join(options.repairDirectory(job), 'repair.patch');
      try {
        await writeFile(patch, `${diff}\n`, 'utf8');
      } catch (error) {
        throw writeFailure(error, patch);
      }
      await runHackDetector(diff, detector);
      return { verify: 'ok', hack: 'ok', tests: 'suspended' };
    },
  };
}
