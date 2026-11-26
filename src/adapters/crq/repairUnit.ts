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
 * - `runOptions` the registry view (`fileRepairRunOptions`);
 * - `drain`     the drain's config, pause, fetch, triage-gate and file-state seams
 *               ({@link RepairDrainBindings}); the config is the already loaded
 *               `config.json` passed to `crq_repair.drain(config)`.
 *
 * The reconcile half (`reconcileFixRun`, receipt lane, feedback publication) is
 * already bound by `fileReconcilePhaseEffects`; it is not rebuilt here.
 * Nothing imports this module from a runtime entry point, and constructing a
 * unit performs no I/O. `REPAIR_UNIT_MISSING_EFFECTS` lists what is still unbound.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpRegistryEntry } from '../../kernel/types.js';
import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import {
  runRepairDispatch,
  type RepairDispatchEffects,
  type RepairDispatchPlan,
  type RepairRunEffects,
  type RepairRunOptions,
  type RunRepairDispatchResult,
} from '../../ops/crq/internal/repairDispatch.js';
import type { RepairDrainEffects } from '../../ops/crq/internal/repairDrain.js';
import type { RepairHarvestEffects } from '../../ops/crq/internal/repairHarvestExecution.js';
import type { PassGateEffects } from '../../ops/crq/internal/repairPassGates.js';
import { readBackfillRollout } from './backfillRollout.js';
import type { RunGit } from './ledgerGit.js';
import { fileRepairDispatchEffects } from './repairDispatchSource.js';
import { fileRepairAdmissionLock, fileRepairFetchClone, type RunFetch } from './repairFetchLock.js';
import { fileRepairClassifyJob, type RunGitSync } from './repairClassifySource.js';
import { fileRepairHarvestEffects } from './repairHarvestSource.js';
import { blocked, fileRepairPauseEffects } from './repairPauseSource.js';
import { fileRepairRunOptions } from './repairRunSource.js';
import { fileRepairStateEffects, pathExists } from './repairStateSource.js';

export interface RepairUnitOptions {
  readonly stateRoot: string;
  readonly clone: string;
  readonly runGit?: RunGit;
  /** The line `crq_repair` prints for a refused gate. */
  readonly narrate: (message: string) => void;
  /**
   * The loaded `config.json` (Python's `config` argument to `drain`). Optional so a
   * unit built for dispatch alone needs none; the config-dependent drain effects
   * then reject, as Python's `config['repair']` would raise on a missing section.
   */
  readonly config?: JsonValue;
  /** Wall clock for the pause and blackout checks; defaults to `new Date()`. */
  readonly now?: () => Date;
  /** `os.environ` for provider readiness in `dispatch_paused`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** `crq_repair.utc()` for the stale-result stamps; defaults to the wall clock. */
  readonly utc?: () => string;
  /** Test seam for the bounded `git fetch`; defaults to the real one. */
  readonly runFetch?: RunFetch;
  /** Test seam for `classifyJob`'s five synchronous git reads; defaults to hardened git run with `cwd` set to the clone. */
  readonly runGitSync?: RunGitSync;
  /** Test seam for the registry; defaults to the central one. */
  readonly entries?: () => Promise<readonly OpRegistryEntry<unknown, unknown>[]>;
}

/** The drain effects this unit binds; the rest are listed in {@link REPAIR_UNIT_MISSING_EFFECTS}. */
export type RepairDrainBindings = Pick<
  RepairDrainEffects,
  | 'maxConcurrentItems'
  | 'dispatchPaused'
  | 'blocked'
  | 'fetchClone'
  | 'triage'
  | 'inboxOrder'
  | 'inboxItem'
  | 'readQueue'
  | 'readBacklog'
  | 'nowMs'
  | 'classifyJob'
  | 'unreadableResult'
  | 'pending'
  | 'markStale'
  | 'withAdmissionLock'
>;

export interface RepairUnit {
  readonly drain: RepairDrainBindings;
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
    drain: drainBindings(options),
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

/** `config['repair']`: a missing or non-object section raises where Python raises. */
function repairSection(config: JsonValue | undefined): JsonObject {
  const section = config instanceof JsonObject ? config.get('repair') : undefined;
  if (!(section instanceof JsonObject)) {
    throw new TypeError('repair config section is missing or not an object');
  }
  return section;
}

/**
 * `config.get('repair', {}).get('tick_lock_wait_s', ...)` of `fetch_clone`: unlike the other
 * drain reads this tolerates a missing `repair` key, and raises for a present non-dict.
 */
function fetchLockWait(config: JsonValue | undefined): JsonValue | undefined {
  if (!(config instanceof JsonObject)) throw new TypeError('repair unit has no config object');
  const section = config.get('repair');
  if (section === undefined) return undefined;
  if (!(section instanceof JsonObject))
    throw new TypeError('repair config section is not an object');
  return section.get('tick_lock_wait_s');
}

function drainBindings(options: RepairUnitOptions): RepairDrainBindings {
  const { stateRoot } = options;
  const state = fileRepairStateEffects({ stateRoot, ...(options.utc ? { utc: options.utc } : {}) });
  const pause = fileRepairPauseEffects({
    stateRoot,
    ...(options.now ? { now: options.now } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  const fetchClone = fileRepairFetchClone({
    stateRoot,
    clone: options.clone,
    tickLockWait: async () => fetchLockWait(options.config),
    ...(options.runFetch ? { runFetch: options.runFetch } : {}),
  });
  const classifyJob = fileRepairClassifyJob({
    stateRoot,
    clone: options.clone,
    ...(options.runGitSync ? { runGitSync: options.runGitSync } : {}),
  });
  return {
    maxConcurrentItems: async () => repairSection(options.config).get('max_concurrent_items'),
    dispatchPaused: async () => {
      if (options.config === undefined) throw new TypeError('repair unit has no config');
      return pause.dispatchPaused(options.config);
    },
    blocked: () => blocked(repairSection(options.config), (options.now ?? (() => new Date()))()),
    fetchClone,
    triage: async () => {
      // `triage_phase`: no triage directory, or no rollout, means triage is not configured.
      if (!(await pathExists(join(stateRoot, 'backfill', 'findings', 'triage')))) return null;
      if ((await readBackfillRollout(stateRoot)) === null) return null;
      // The judge, context scan and delivery transport are not ported. A throw defers
      // triage with a narrated reason (the drain's `except Exception` around triage).
      throw new Error('triage_phase judge dispatch is not bound in the TS repair unit');
    },
    inboxOrder: () => state.inboxOrder(),
    inboxItem: (jobId) => state.inboxItem(jobId),
    readQueue: () => state.readQueue(),
    readBacklog: () => state.readBacklog(),
    // `dt.datetime.now(dt.timezone.utc)` in `hold_backfill_groups`, on the same injectable
    // clock as `blocked`; the drain samples it only after reading the backlog file.
    nowMs: () => (options.now ?? (() => new Date()))().getTime(),
    classifyJob,
    unreadableResult: (jobId) => state.unreadableResult(jobId),
    pending: (jobId) => state.pending(jobId),
    markStale: (job, reason) => state.markStale(job, reason),
    withAdmissionLock: fileRepairAdmissionLock({ stateRoot }),
  };
}

/**
 * Effects of the repair unit that no source binds yet, by the Python function
 * that owns them. A future slice adds each as its own `file*` source.
 *
 * The drain orchestration (`runRepairDrain`, `drainItem`, `drainItems`,
 * `runRepairWorker`) is ported and tested over `RepairDrainEffects`; the
 * runner-disabled marker and `narrate` are the only two of its effects bound
 * here (`PassGateEffects`). Everything below is a binding to supply before the
 * drain can run for real; none activates anything by existing.
 *
 * Three effects remain, each for a stated reason:
 * - `triage`: only the "not configured" gates are bound; the judge, context scan and
 *   delivery transport are the cq-op path (D3), not this slice.
 * - `processItem`: `repairItemLoop.processRepairItem` ports the serial loop, but its
 *   `process` effect is Python's `process()`, which creates the worktree, runs the
 *   fixer and judge, and calls `resume_worktree` recovery (held on #2342). The loop
 *   cannot be bound without one of those, so it is left unbound rather than half-bound.
 * - `startWorker`: process isolation (fork, private pipe, reap, never kill).
 */
export const REPAIR_UNIT_MISSING_EFFECTS: readonly { name: string; python: string }[] = [
  {
    name: 'RepairDrainEffects.triage',
    python:
      'crq_repair.triage_phase (judge, context scan, delivery; only the null gates are bound)',
  },
  {
    name: 'RepairDrainEffects.processItem',
    python:
      'crq_repair.process_item (serial findings; its `process` runs the fixer/judge and resume_worktree recovery)',
  },
  {
    name: 'RepairDrainEffects.startWorker',
    python: 'crq_repair.drain_items (fork + private pipe; runs runRepairWorker)',
  },
];
