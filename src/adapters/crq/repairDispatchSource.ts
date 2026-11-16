/** Inactive file/git binding of the repair dispatch and harvest read seams
 * (`RepairDispatchEffects` / `RepairHarvestEffects` of `repairDispatch`): the git
 * reads that re-observe the source (`rev-parse origin/main`, `rev-parse <sha>:<path>`,
 * `show <ref>`) and the prepared job file `STATE/repair/inbox/<job>.json`.
 *
 * Reads fail closed: a non-zero git exit or an undecodable byte sequence throws a
 * message with no git prose, and the bridge turns a throw into its typed refusal.
 * `show` output is strictly decoded and newline-translated like Python's
 * `text=True` subprocess. Nothing imports this from a runtime entry point.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  RepairDispatchEffects,
  RepairDispatchGit,
} from '../../ops/crq/internal/repairDispatch.js';
import type { RunGit } from './ledgerGit.js';
import { runGitIn } from './publishSource.js';
import { checkRepairJobId, pythonUniversalNewlines } from './repairPreparation.js';

export interface RepairDispatchSourceOptions {
  readonly stateRoot: string;
  readonly clone: string;
  readonly runGit?: RunGit;
}

const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function fileRepairDispatchEffects(
  options: RepairDispatchSourceOptions,
): RepairDispatchEffects {
  const git = options.runGit ?? runGitIn(options.clone);
  const read = async (args: string[]): Promise<string> => {
    const call = await git(args);
    if (call.code !== 0) throw new Error('git read failed');
    return text.decode(call.stdout);
  };
  const dispatchGit: RepairDispatchGit = {
    currentTip: async () => (await read(['rev-parse', 'origin/main'])).trim(),
    blobOid: async (sourceSha, path) => (await read(['rev-parse', `${sourceSha}:${path}`])).trim(),
    showFile: async (ref) => pythonUniversalNewlines(await read(['show', ref])),
  };
  return {
    git: dispatchGit,
    async readPreparedJob(jobId) {
      if (!checkRepairJobId(jobId)) throw new Error('invalid repair job id');
      return text.decode(
        await readFile(join(options.stateRoot, 'repair', 'inbox', `${jobId}.json`)),
      );
    },
  };
}
