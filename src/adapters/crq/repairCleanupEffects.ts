/**
 * File- and Git-backed `cleanupHarvested` (`crq_repair.retain.cleanup_harvested`,
 * apps/crq-python/crq_repair/retain.py:20). Inactive: nothing imports this outside
 * tests.
 *
 * The eligibility decision is `decideRepairCleanup` (differentially pinned against
 * Python with scripted Git). This module supplies the real probes (path
 * resolution, `lstat`/`stat`, `git status`/`rev-parse`, the retained-snapshot
 * walk and SHA-256 digests) and Python's one write: `git worktree remove <wt>` in
 * the clone. Python returns whether that exit was 0; the harvest ignores it, so a
 * refused removal is silent here too.
 *
 * Deviations: Git runs through the hardened `runGitIn` (system config and ambient
 * `GIT_*` redirections are not read, a bounded timeout applies) where Python's
 * `command` inherits the environment with a 1200 s limit (this side times out
 * at 330 s). A Git call that never reports an exit status, such as a timed-out
 * `git status`, surfaces as `PyError('OSError', 'git status did not complete: ...')`,
 * which the harvest's `isCaught` accepts. Python raises `subprocess.TimeoutExpired`
 * there and its harvest catches that explicitly; the recorded message text differs.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { pyStrip } from '../../ops/crq/deploy/gitGuards.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import {
  decideRepairCleanup,
  type RepairCleanupProbes,
  type RetainedArchive,
  type RetentionRecord,
} from '../../queue-runner/repairCleanup.js';
import type { RepairHarvestEffects } from '../../queue-runner/repairHarvest.js';
import type { RunGit } from './ledgerGit.js';
import { answered, clip, pyStderr, pyText } from './publicationGitReads.js';
import { runGitIn } from './publishSource.js';
import { fileRepairHarvestReads } from './repairHarvestReads.js';

export interface FileRepairCleanupInput {
  /** `c.STATE`. */
  readonly stateRoot: string;
  /** `c.WT_ROOT`. */
  readonly worktreeRoot: string;
  /** `c.CLONE`: where `git worktree remove` runs. */
  readonly clone: string;
  /** One hardened runner per repository directory; defaults to the shared `runGitIn`. */
  readonly runGitFor?: (repo: string) => RunGit;
}

function osError(error: unknown): PyError {
  return new PyError('OSError', error instanceof Error ? error.message : String(error));
}

/** `hashlib.file_digest(open(path, 'rb'), 'sha256')`: streamed, a read failure is an `OSError`. */
async function fileDigest(path: Buffer): Promise<string> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  } catch (error) {
    throw osError(error);
  }
  return hash.digest('hex');
}

const SLASH = Buffer.from('/');
const child = (parent: Buffer, name: Buffer): Buffer => Buffer.concat([parent, SLASH, name]);
const RETAINED = Buffer.from('retained-');
const MANIFEST = Buffer.from('manifest.json');

async function isDirectoryFollowing(path: Buffer): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: Buffer): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `Path(directory).glob('**\/retained-*\/manifest.json')` on Python 3.14: `**`
 * walks `directory` and every real (non-symlink) subdirectory, `retained-*`
 * accepts any entry that is a directory once links are followed, and the
 * manifest must exist. Unreadable directories are skipped, as `glob` does.
 * Names are raw bytes so a non-UTF-8 directory is walked like Python's.
 */
async function retainedSnapshots(directory: string): Promise<RetentionRecord[]> {
  const found: RetentionRecord[] = [];
  const walk = async (dir: Buffer): Promise<void> => {
    let names: Buffer[];
    try {
      names = await readdir(dir, { encoding: 'buffer' });
    } catch {
      return;
    }
    for (const name of names) {
      const path = child(dir, name);
      if (
        name.subarray(0, RETAINED.length).equals(RETAINED) &&
        (await isDirectoryFollowing(path)) &&
        (await exists(child(path, MANIFEST)))
      ) {
        found.push({
          directoryName: name.toString('utf8'),
          readManifest: async () => {
            try {
              return new Uint8Array(await readFile(child(path, MANIFEST)));
            } catch (error) {
              throw osError(error);
            }
          },
          archiveDigest: (archive: RetainedArchive) =>
            fileDigest(child(path, Buffer.from(archive))),
        });
      }
    }
    for (const name of names) {
      const path = child(dir, name);
      let real = false;
      try {
        real = (await lstat(path)).isDirectory();
      } catch {
        real = false;
      }
      if (real) await walk(path);
    }
  };
  await walk(Buffer.from(directory));
  return found;
}

/** The production {@link RepairCleanupProbes} over the real filesystem and Git. */
export function fileRepairCleanupProbes(input: FileRepairCleanupInput): RepairCleanupProbes {
  const runGitFor = input.runGitFor ?? runGitIn;
  const reads = fileRepairHarvestReads({
    stateRoot: input.stateRoot,
    worktreeRoot: input.worktreeRoot,
  });
  return {
    resolve: (path) => reads.resolvePath(path),
    isSymlink: async (path) => {
      try {
        return (await lstat(path)).isSymbolicLink();
      } catch {
        return false; // `Path.is_symlink()` swallows OSError and ValueError.
      }
    },
    isDirectory: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    status: async (worktree) => {
      const call = await runGitFor(worktree)([
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignored',
      ]);
      const stdout = pyText(call); // text mode decodes before the exit status is read
      return { failed: answered(call) !== 0, stdout };
    },
    head: async (worktree) => {
      const call = await runGitFor(worktree)(['rev-parse', 'HEAD']);
      const stdout = pyText(call);
      if (answered(call) !== 0) {
        throw new PyError('RuntimeError', `git rev-parse failed: ${clip(pyStderr(call), 200)}`);
      }
      return pyStrip(stdout);
    },
    retainedManifests: (directory) => retainedSnapshots(directory),
  };
}

/** `cleanup_harvested(CLONE, WT_ROOT, STATE/repair/<job>, item, job, result, alternate=...)`. */
export function fileRepairCleanup(
  input: FileRepairCleanupInput,
): NonNullable<RepairHarvestEffects['cleanupHarvested']> {
  const runGitFor = input.runGitFor ?? runGitIn;
  const probes = fileRepairCleanupProbes(input);
  return async (itemId, jobId, result, alternate) => {
    const decision = await decideRepairCleanup(
      {
        worktreeRoot: input.worktreeRoot,
        directory: join(input.stateRoot, 'repair', jobId),
        itemId,
        jobId,
        result,
        alternate,
      },
      probes,
    );
    if (!decision.remove) return;
    // `command(['git', 'worktree', 'remove', wt], cwd=clone)`: a missing clone is an OSError.
    try {
      await stat(input.clone);
    } catch (error) {
      throw osError(error);
    }
    answered(await runGitFor(input.clone)(['worktree', 'remove', decision.worktree]));
  };
}
