/**
 * File-backed reads for the repair harvest (repair_tick.py:422-578): the inbox
 * job, the result artifact and `Path.resolve()`. Inactive: nothing imports
 * this outside tests. Verification, worktrees, the finding ledger and
 * publication stay injected; they have no TS wiring yet.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { parseJsonValue, toPlainJson } from '../../policy/crq/jsonValue.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import type { RepairHarvestEffects } from '../../queue-runner/repairHarvest.js';

export interface FileRepairHarvestInput {
  /** `c.STATE`. */
  readonly stateRoot: string;
  /** `c.WT_ROOT`. */
  readonly worktreeRoot: string;
}

export type FileRepairHarvestReads = Pick<
  RepairHarvestEffects,
  'readJob' | 'resultExists' | 'readResult' | 'resolvePath' | 'worktreeRoot'
>;

const decoder = new TextDecoder('utf-8', { fatal: true });

/** A failed read is an `OSError`; a decode or parse failure is a `ValueError`. */
async function readJson(path: string): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (e) {
    throw new PyError('OSError', e instanceof Error ? e.message : String(e));
  }
  try {
    return toPlainJson(parseJsonValue(decoder.decode(bytes)), { bigints: true });
  } catch (e) {
    throw new PyError('ValueError', e instanceof Error ? e.message : String(e));
  }
}

export function fileRepairHarvestReads(input: FileRepairHarvestInput): FileRepairHarvestReads {
  const repair = (...parts: string[]): string => join(input.stateRoot, 'repair', ...parts);
  return {
    worktreeRoot: input.worktreeRoot,
    readJob: (jobId) => readJson(repair('inbox', `${jobId}.json`)),
    readResult: (jobId) => readJson(repair(jobId, 'result.json')),
    resultExists: (jobId) =>
      stat(repair(jobId, 'result.json')).then(
        () => true,
        () => false,
      ),
    /**
     * `Path.resolve()` (non-strict): symlinks resolve as far as the path exists,
     * the rest is kept. A `..` that follows a symlink resolves lexically.
     */
    async resolvePath(path) {
      if (path.includes('\0'))
        throw new PyError('ValueError', 'lstat: embedded null character in path');
      let head = resolve(path);
      const tail: string[] = [];
      for (;;) {
        try {
          return join(await realpath(head), ...tail.reverse());
        } catch {
          const slash = head.lastIndexOf('/');
          if (head === '/' || slash < 0) return resolve(path);
          tail.push(head.slice(slash + 1));
          head = slash === 0 ? '/' : head.slice(0, slash);
        }
      }
    },
  };
}
