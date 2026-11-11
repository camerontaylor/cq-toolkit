/**
 * Execute a verified C1 repair-preparation plan through injected memory seams.
 *
 * Lifecycle position: after `prepareRepairGates` has read the historical job,
 * queue item, revalidation evidence, pin and triage row and returned the exact
 * mutation bytes; before dispatch-request construction, enqueue, harvest or any
 * caller-owned follow-up. This module ports the write half of
 * `repair_tick.prepare_current_job`:
 *
 *   write the prepared job -> canonical handoff -> write the queue
 *
 * It is deliberately not a blind serialization of `plan.mutations`. Python
 * calls `finding_inbox(c).handoff(...)` whenever the historical job carries a
 * canonical finding id, including the already-handed-off snapshot and the
 * idempotent path where no job or queue write occurs. A read-gate snapshot is
 * never ownership authority: the handoff's own `findings.lock` revalidation
 * decides, and its `recover` replays retained events. So the executor always
 * performs the canonical handoff at Python's position. The idempotent
 * non-canonical path performs no handoff and no write.
 *
 * Lock ownership. The caller supplies the EXISTING `tick.lock` implementation
 * (`withTickLock`), exactly as `crq.py repair-prepare` wraps the whole
 * preparation in `ran_locked`. The gate producer is awaited inside that scope,
 * so gate reads, scans, the exact plan bytes and every write share one critical
 * section. This module never opens, creates or invents a lock. `findings.lock`
 * and `outbox.lock` remain inside the existing `FindingInbox.handoff` seam and
 * its injected publication.
 *
 * Failure honesty. Python has no rollback and neither does this executor: a
 * later failure leaves the earlier durable writes in place. A port that
 * throws may have applied its effect before rejecting, so its step is reported
 * `unconfirmed`, never `failed` or "not written". No step is labelled complete
 * until the port resolves. There is no dispatch, enqueue or harvest claim, and
 * `remainingGates` never empties. Recovery is the caller re-running the same
 * preparation under `tick.lock`, which re-reads state and reconciles
 * idempotently.
 *
 * This module imports no subprocess, filesystem, clock or environment seam.
 */
import { JsonObject } from '../../../policy/crq/jsonValue.js';
import { atomicJsonText, sha256Hex } from '../../../policy/crq/pythonJson.js';
import type { RepairRefusal } from '../../../policy/crq/repairBinding.js';
import type {
  FindingHandoffResult,
  FindingInbox,
  FindingPublication,
} from '../../review/internal/crq/findingInbox.js';
import type {
  PrepareRepairGatesResult,
  RemainingPreparationGate,
  RepairMutation,
  VerifiedRepairPreparation,
} from './repairPrepareGates.js';

/** The caller's existing `tick.lock`, around the whole read-plan-write unit. */
export interface RepairPreparationLock {
  withTickLock<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Every external effect the executor performs. All are injected; the memory
 * implementation used by the tests is not part of this module.
 */
export interface RepairPreparationEffects extends RepairPreparationLock {
  /** Atomically write `state/repair/inbox/<jobId>.json` with the plan bytes. */
  persistJob(jobId: string, bytes: string): Promise<void>;
  /** Atomically write `state/queue.json` with the plan bytes. */
  persistQueue(bytes: string): Promise<void>;
  /** The existing finding-inbox seam; it holds `findings.lock` itself. */
  inbox: Pick<FindingInbox, 'handoff'>;
  /** The existing publication seam used by the handoff. */
  publication: FindingPublication;
  /** Python `c.iso()` at the handoff's position. */
  now(): string;
}

export type RepairPreparationStep = 'write-job' | 'handoff' | 'write-queue';

/**
 * `completed`: the port resolved. `refused`: the handoff returned a typed
 * refusal without applying its transition. `unconfirmed`: the port threw, so
 * its durable outcome is unknown (it may have applied before rejecting).
 */
export type RepairPreparationStepOutcome = 'completed' | 'refused' | 'unconfirmed';

export interface RepairPreparationStepEvidence {
  readonly step: RepairPreparationStep;
  readonly outcome: RepairPreparationStepOutcome;
  /** The persisted byte identity, never the content. */
  readonly sha256?: string;
  readonly byteLength?: number;
  readonly refusal?: RepairRefusal;
}

/** One applied effect, in execution order. Redacted: no state bytes. */
export type RepairPreparationEffect =
  | {
      readonly kind: 'write-job';
      readonly jobId: string;
      readonly sha256: string;
      readonly byteLength: number;
    }
  | {
      readonly kind: 'handoff';
      readonly findingId: string;
      readonly preparedJobId: string;
      readonly result: 'written' | 'already-handed-off';
    }
  | { readonly kind: 'write-queue'; readonly sha256: string; readonly byteLength: number };

/**
 * A completed preparation. `remainingGates` is never empty: dispatch request
 * construction, enqueue and harvest stay with the caller, and this result is
 * not a dispatch-ready artifact.
 */
export interface ExecutedRepairPreparation {
  readonly status: 'preparation-executed';
  readonly idempotent: boolean;
  readonly jobId: string;
  readonly run: string;
  readonly effects: readonly RepairPreparationEffect[];
  readonly handoff?: { readonly result: 'written' | 'already-handed-off' };
  readonly remainingGates: readonly RemainingPreparationGate[];
}

/**
 * A typed internal consistency diagnostic. It is never persisted, is not a
 * kernel failure class, and adds no status, gate or retry machinery. It only
 * prevents a write whose bytes or identity disagree with the plan.
 */
export type RepairPlanInconsistency =
  | 'mutation-order'
  | 'write-job-without-proposal'
  | 'write-job-identity'
  | 'write-job-bytes'
  | 'job-without-write'
  | 'write-queue-without-bytes'
  | 'write-queue-bytes'
  | 'queue-without-write'
  | 'idempotent-with-write'
  | 'handoff-without-plan'
  | 'handoff-identity'
  | 'handoff-without-job';

/** How far the read-gate producer ran inside the caller's lock. */
export type RepairPreparationReadGates = 'not-attempted' | 'attempted-under-tick-lock';

export type RepairPreparationExecutionResult =
  | { readonly ok: true; readonly value: ExecutedRepairPreparation }
  | {
      readonly ok: false;
      /** The read gates refused; no mutation was attempted. */
      readonly kind: 'refused';
      readonly refusal: RepairRefusal;
      readonly readGates: RepairPreparationReadGates;
      readonly effects: readonly [];
      readonly remainingGates: readonly RemainingPreparationGate[];
    }
  | {
      readonly ok: false;
      /** The gate producer threw before returning a plan. */
      readonly kind: 'plan-failed';
      readonly readGates: RepairPreparationReadGates;
      readonly steps: readonly [];
      readonly remainingGates: readonly RemainingPreparationGate[];
      readonly recovery: 're-run-preparation';
    }
  | {
      readonly ok: false;
      /** The lock scope itself rejected; no read and no write was attempted. */
      readonly kind: 'lock-unavailable';
      readonly readGates: RepairPreparationReadGates;
      readonly steps: readonly [];
      readonly remainingGates: readonly RemainingPreparationGate[];
      readonly recovery: 're-run-preparation';
    }
  | {
      readonly ok: false;
      readonly kind: 'plan-inconsistent';
      readonly detail: RepairPlanInconsistency;
      readonly readGates: RepairPreparationReadGates;
      readonly steps: readonly [];
      readonly remainingGates: readonly RemainingPreparationGate[];
    }
  | {
      readonly ok: false;
      /** An effect stopped the run; prior steps stay as recorded, no rollback. */
      readonly kind: 'effect-failed';
      readonly step: RepairPreparationStep;
      readonly steps: readonly RepairPreparationStepEvidence[];
      readonly refusal?: RepairRefusal;
      readonly effects: readonly RepairPreparationEffect[];
      readonly readGates: RepairPreparationReadGates;
      readonly remainingGates: readonly RemainingPreparationGate[];
      readonly recovery: 're-run-preparation';
    };

interface PlannedPhases {
  readonly job?: { readonly jobId: string; readonly bytes: string };
  readonly queue?: { readonly bytes: string };
  /** Present only when the historical job carries a canonical finding id. */
  readonly handoffJob?: JsonObject;
}

const ALL_GATES: readonly RemainingPreparationGate[] = [
  'state-write-execution',
  'canonical-handoff-execution',
  'dispatch-request-construction',
  'enqueue-dispatch',
  'harvest-disposition',
];

const CALLER_GATES: readonly RemainingPreparationGate[] = [
  'dispatch-request-construction',
  'enqueue-dispatch',
  'harvest-disposition',
];

const MUTATION_RANK: Record<RepairMutation['kind'], number> = {
  'write-job': 0,
  handoff: 1,
  'write-queue': 2,
};

function byteIdentity(bytes: string): { readonly sha256: string; readonly byteLength: number } {
  return {
    sha256: sha256Hex(Buffer.from(bytes, 'utf8')),
    byteLength: Buffer.byteLength(bytes, 'utf8'),
  };
}

/**
 * Validate only the plan consistency a wrong write would otherwise exploit:
 * mutation order, whether the job bytes are the job object handed off, and
 * whether a handoff mutation names the planned handoff. A plan that omits the
 * handoff mutation while carrying a handoff plan is valid: that is the
 * already-handed-off snapshot, which the executor still executes.
 */
function plannedPhases(plan: VerifiedRepairPreparation): PlannedPhases | RepairPlanInconsistency {
  let job: PlannedPhases['job'];
  let queue: PlannedPhases['queue'];
  let previousRank = -1;
  for (const mutation of plan.mutations) {
    const rank = MUTATION_RANK[mutation.kind];
    if (rank <= previousRank) return 'mutation-order';
    previousRank = rank;
    switch (mutation.kind) {
      case 'write-job': {
        if (plan.idempotent) return 'idempotent-with-write';
        const proposed = plan.proposal.job;
        if (proposed === undefined) return 'write-job-without-proposal';
        if (mutation.jobId !== plan.proposal.jobId) return 'write-job-identity';
        if (mutation.bytes !== atomicJsonText(proposed)) return 'write-job-bytes';
        job = { jobId: mutation.jobId, bytes: mutation.bytes };
        break;
      }
      case 'handoff': {
        if (plan.handoff === undefined) return 'handoff-without-plan';
        if (
          mutation.findingId !== plan.handoff.findingId ||
          mutation.previousTask !== plan.handoff.previousTask ||
          mutation.preparedJobId !== plan.handoff.preparedJobId
        ) {
          return 'handoff-identity';
        }
        break;
      }
      case 'write-queue': {
        if (plan.idempotent) return 'idempotent-with-write';
        if (plan.queue === undefined) return 'write-queue-without-bytes';
        if (plan.queue.bytes !== mutation.bytes) return 'write-queue-bytes';
        queue = { bytes: mutation.bytes };
        break;
      }
    }
  }

  let handoffJob: JsonObject | undefined;
  if (plan.handoff !== undefined) {
    const candidate = plan.idempotent ? plan.preparedJob : plan.proposal.job;
    if (!(candidate instanceof JsonObject)) return 'handoff-without-job';
    if (candidate.get('job') !== plan.handoff.preparedJobId) return 'handoff-identity';
    handoffJob = candidate;
  }
  // A non-idempotent preparation always persists both the job and the queue;
  // a plan that silently omits either is not executable.
  if (!plan.idempotent && job === undefined) return 'job-without-write';
  if (!plan.idempotent && queue === undefined) return 'queue-without-write';
  return {
    ...(job === undefined ? {} : { job }),
    ...(queue === undefined ? {} : { queue }),
    ...(handoffJob === undefined ? {} : { handoffJob }),
  };
}

function failed(
  step: RepairPreparationStep,
  steps: RepairPreparationStepEvidence[],
  effects: RepairPreparationEffect[],
  refusal?: RepairRefusal,
): RepairPreparationExecutionResult {
  return {
    ok: false,
    kind: 'effect-failed',
    step,
    steps: [...steps],
    ...(refusal === undefined ? {} : { refusal }),
    effects: [...effects],
    readGates: 'attempted-under-tick-lock',
    remainingGates: ALL_GATES,
    recovery: 're-run-preparation',
  };
}

async function runPreparation(
  produce: () => Promise<PrepareRepairGatesResult>,
  effects: RepairPreparationEffects,
): Promise<RepairPreparationExecutionResult> {
  let produced: PrepareRepairGatesResult;
  try {
    produced = await produce();
  } catch {
    return {
      ok: false,
      kind: 'plan-failed',
      readGates: 'attempted-under-tick-lock',
      steps: [],
      remainingGates: ALL_GATES,
      recovery: 're-run-preparation',
    };
  }
  if (!produced.ok) {
    return {
      ok: false,
      kind: 'refused',
      refusal: produced.refusal,
      readGates: 'attempted-under-tick-lock',
      effects: [],
      remainingGates: ALL_GATES,
    };
  }
  const plan = produced.value;
  const phases = plannedPhases(plan);
  if (typeof phases === 'string') {
    return {
      ok: false,
      kind: 'plan-inconsistent',
      detail: phases,
      readGates: 'attempted-under-tick-lock',
      steps: [],
      remainingGates: ALL_GATES,
    };
  }

  const steps: RepairPreparationStepEvidence[] = [];
  const applied: RepairPreparationEffect[] = [];

  if (phases.job !== undefined) {
    const identity = byteIdentity(phases.job.bytes);
    try {
      await effects.persistJob(phases.job.jobId, phases.job.bytes);
    } catch {
      steps.push({ step: 'write-job', outcome: 'unconfirmed' });
      return failed('write-job', steps, applied);
    }
    steps.push({ step: 'write-job', outcome: 'completed', ...identity });
    applied.push({ kind: 'write-job', jobId: phases.job.jobId, ...identity });
  }

  let handoffResult: 'written' | 'already-handed-off' | undefined;
  if (plan.handoff !== undefined && phases.handoffJob !== undefined) {
    let handoff: FindingHandoffResult;
    try {
      handoff = await effects.inbox.handoff(effects.publication, {
        findingId: plan.handoff.findingId,
        previousTask: plan.handoff.previousTask,
        preparedJobId: plan.handoff.preparedJobId,
        job: phases.handoffJob,
        at: effects.now(),
      });
    } catch {
      steps.push({ step: 'handoff', outcome: 'unconfirmed' });
      return failed('handoff', steps, applied);
    }
    if (handoff.kind === 'refused') {
      steps.push({ step: 'handoff', outcome: 'refused', refusal: handoff.refusal });
      return failed('handoff', steps, applied, handoff.refusal);
    }
    handoffResult = handoff.kind;
    steps.push({ step: 'handoff', outcome: 'completed' });
    applied.push({
      kind: 'handoff',
      findingId: plan.handoff.findingId,
      preparedJobId: plan.handoff.preparedJobId,
      result: handoff.kind,
    });
  }

  if (phases.queue !== undefined) {
    const identity = byteIdentity(phases.queue.bytes);
    try {
      await effects.persistQueue(phases.queue.bytes);
    } catch {
      steps.push({ step: 'write-queue', outcome: 'unconfirmed' });
      return failed('write-queue', steps, applied);
    }
    steps.push({ step: 'write-queue', outcome: 'completed', ...identity });
    applied.push({ kind: 'write-queue', ...identity });
  }

  return {
    ok: true,
    value: {
      status: 'preparation-executed',
      idempotent: plan.idempotent,
      jobId: plan.proposal.jobId,
      run: plan.proposal.run,
      effects: applied,
      ...(handoffResult === undefined ? {} : { handoff: { result: handoffResult } }),
      remainingGates: CALLER_GATES,
    },
  };
}

/**
 * Await the gate producer and execute its verified plan inside the caller's
 * existing `tick.lock`. A plan produced outside this scope is stale by
 * construction, which is why there is no plan-only entry point.
 */
export async function executeRepairPreparation(
  produce: () => Promise<PrepareRepairGatesResult>,
  effects: RepairPreparationEffects,
): Promise<RepairPreparationExecutionResult> {
  try {
    return await effects.withTickLock(() => runPreparation(produce, effects));
  } catch {
    return {
      ok: false,
      kind: 'lock-unavailable',
      readGates: 'not-attempted',
      steps: [],
      remainingGates: ALL_GATES,
      recovery: 're-run-preparation',
    };
  }
}
