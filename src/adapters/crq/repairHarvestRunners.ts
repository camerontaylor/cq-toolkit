/**
 * The four local-Git runners `repair_tick.harvest` calls around a claimed FIXED range
 * (repair_tick.py:605-620), bound to {@link RepairHarvestEffects}. Inactive: nothing
 * imports this from a runtime entry point.
 *
 * - `makeWorktree` / `removeWorktree`: `c.make_worktree(name, commit)` and
 *   `c.remove_worktree(path, branch)` (`publicationWorktrees.ts`), with the positional
 *   `(path, branch)` shape the harvest seam declares;
 * - `verify`: `crq_repair.verify` (`publicationVerify.ts`);
 * - `mechanical`: `crq_repair.mechanical` (`repairMechanical.ts`), whose `directory`
 *   argument is Python's `path.parent` of `STATE/repair/<job>/result.json`, so it is
 *   `STATE/repair/<job>` here too.
 *
 * Nothing here adds behaviour: every ownership narrowing, error class and message is the
 * wrapped port's. The harvest seam hands a worktree as a bare path string; the wrapped
 * ports take the `{path}` handle, so the string is wrapped, nothing else.
 */
import { join } from 'node:path';
import type { RepairHarvestEffects } from '../../queue-runner/repairHarvest.js';
import { gitPublicationVerify } from './publicationVerify.js';
import {
  gitPublicationWorktrees,
  type PublicationWorktreesOptions,
} from './publicationWorktrees.js';
import type { DetectorRun } from './repairHackDetector.js';
import { gitRepairMechanical } from './repairMechanical.js';

export interface RepairHarvestRunnersOptions extends PublicationWorktreesOptions {
  /** `c.STATE`: the repair directory of a job is `<stateRoot>/repair/<job>`. */
  readonly stateRoot: string;
  /** The detector process; defaults to the pure op in process. */
  readonly detector?: DetectorRun;
}

export type RepairHarvestRunners = Pick<
  RepairHarvestEffects,
  'makeWorktree' | 'removeWorktree' | 'verify' | 'mechanical'
>;

export function repairHarvestRunners(options: RepairHarvestRunnersOptions): RepairHarvestRunners {
  const worktrees = gitPublicationWorktrees(options);
  const verifier = gitPublicationVerify(options);
  const gate = gitRepairMechanical({
    ...options,
    repairDirectory: (jobId) => join(options.stateRoot, 'repair', jobId),
    ...(options.detector === undefined ? {} : { detector: options.detector }),
  });
  return {
    makeWorktree: (name, commit) => worktrees.makeWorktree(name, commit),
    removeWorktree: (path, branch) => worktrees.removeWorktree({ path, branch }),
    verify: (worktree, predecessor, commits, jobId) =>
      verifier.verify({ path: worktree }, predecessor, commits, jobId),
    async mechanical(worktree, predecessor, commits, jobId) {
      await gate.mechanical({ path: worktree }, predecessor, commits, jobId);
    },
  };
}
