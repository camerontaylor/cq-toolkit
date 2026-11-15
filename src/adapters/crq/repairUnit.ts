/**
 * Inactive composition of the ported repair unit over its file/git effects.
 *
 * Each S5 repair piece takes its own injected effects object; the S6 `file*`
 * sources bind the pieces whose seams are files and git. This module is the one
 * place that builds all of them from a single `stateRoot` + `clone`, so a future
 * entry point constructs one `RepairUnit` instead of re-deriving the pairings:
 *
 * - `dispatch`  plan/harvest read seams (`fileRepairDispatchEffects`), passed by the
 *               caller to `planRepairDispatch` / `harvestRepairRunArtifact`;
 * - `harvest`   finding-ledger seams for `executeRepairHarvest`
 *               (`fileRepairHarvestEffects`: note `repairDispatch.RepairHarvestEffects`
 *               and `repairHarvestExecution.RepairHarvestEffects` are different types);
 * - `run`       `dispatch` plus the `state/runner-disabled` admission marker;
 * - `gates`     the same marker plus an injected narration line;
 * - `runOptions` the registry view (`fileRepairRunOptions`).
 *
 * The reconcile half (`reconcileFixRun`, receipt lane, feedback publication) is
 * already bound by `fileReconcilePhaseEffects`; it is not rebuilt here.
 * Nothing imports this module from a runtime entry point, and constructing a
 * unit performs no I/O. `REPAIR_UNIT_MISSING_EFFECTS` lists what is still unbound.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpRegistryEntry } from '../../kernel/types.js';
import {
  runRepairDispatch,
  type RepairDispatchEffects,
  type RepairDispatchPlan,
  type RepairRunEffects,
  type RepairRunOptions,
  type RunRepairDispatchResult,
} from '../../ops/crq/internal/repairDispatch.js';
import type { RepairHarvestEffects } from '../../ops/crq/internal/repairHarvestExecution.js';
import type { PassGateEffects } from '../../ops/crq/internal/repairPassGates.js';
import type { RunGit } from './ledgerGit.js';
import { fileRepairDispatchEffects } from './repairDispatchSource.js';
import { fileRepairHarvestEffects } from './repairHarvestSource.js';
import { fileRepairRunOptions } from './repairRunSource.js';

export interface RepairUnitOptions {
  readonly stateRoot: string;
  readonly clone: string;
  readonly runGit?: RunGit;
  /** The line `crq_repair` prints for a refused gate. */
  readonly narrate: (message: string) => void;
  /** Test seam for the registry; defaults to the central one. */
  readonly entries?: () => Promise<readonly OpRegistryEntry<unknown, unknown>[]>;
}

export interface RepairUnit {
  readonly dispatch: RepairDispatchEffects;
  readonly harvest: RepairHarvestEffects;
  readonly run: RepairRunEffects;
  readonly gates: PassGateEffects;
  runOptions(resume: boolean): Promise<RepairRunOptions>;
  /** `runRepairDispatch`; `resume` is taken from the plan so the two cannot disagree. */
  runJob(plan: RepairDispatchPlan): Promise<RunRepairDispatchResult>;
}

/** `(STATE / "runner-disabled").exists()`: only a missing file is "enabled". */
async function markerExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function fileRepairUnit(options: RepairUnitOptions): RepairUnit {
  const dispatch = fileRepairDispatchEffects({
    stateRoot: options.stateRoot,
    clone: options.clone,
    ...(options.runGit ? { runGit: options.runGit } : {}),
  });
  const marker = join(options.stateRoot, 'runner-disabled');
  const runnerDisabled = (): Promise<boolean> => markerExists(marker);
  const run: RepairRunEffects = { ...dispatch, runnerDisabled };
  return {
    dispatch,
    harvest: fileRepairHarvestEffects(options.stateRoot),
    run,
    gates: { runnerDisabled, narrate: options.narrate },
    runOptions: (resume) => runOptionsFor(resume),
    runJob: async (plan) => runRepairDispatch(plan, await runOptionsFor(plan.resume), run),
  };

  function runOptionsFor(resume: boolean): Promise<RepairRunOptions> {
    return fileRepairRunOptions({
      resume,
      ...(options.entries ? { entries: options.entries } : {}),
    });
  }
}

/**
 * Effects of the repair unit that no source binds yet, by the Python function
 * that owns them. A future slice adds each as its own `file*` source.
 */
export const REPAIR_UNIT_MISSING_EFFECTS: readonly { name: string; python: string }[] = [
  { name: 'DrainPassEffects.fetchClone', python: 'crq_repair.fetch_clone' },
  { name: 'DrainPassEffects.triage', python: 'crq_repair.triage_phase' },
  { name: 'DrainPassEffects.items', python: 'crq_repair.drain / drain_items ordering' },
  { name: 'DrainPassEffects.halted', python: 'crq_repair.paused / blackout' },
  {
    name: 'DrainPassEffects.drainItem',
    python: 'crq_repair.drain_item (plan, run, harvest per job)',
  },
];
