/**
 * Composition of the file-backed adapters into the tick's `TickPhases` and the
 * slot timer's entry. Inactive: no runtime entry point imports this module, and
 * nothing here enables a tick or slot unit.
 *
 * Bound here: the plain state seams (`fileTickSeams`), delivery
 * (`bindDeliveryPhases`), admission (`bindAdmit`), the single heartbeat and
 * slot-deadline seams (`writeHeartbeat` with `fileHeartbeatEffects`,
 * `refreshSlotDeadline` with `fileSlotDeadlineEffects`), and the S6-0 host
 * effects (`fetch`, `notifyOwner`, `readSlotUsage`, `recordCoverage`, from
 * `tickHostEffects.ts`). Every other phase is caller-injected through
 * `remaining`, so a missing port is a compile error rather than a silent no-op.
 */
import { join } from 'node:path';
import { JsonObject, parseJsonValue, toPlainJson } from '../../policy/crq/jsonValue.js';
import type { PhaseResult, TickPhases } from '../../queue-runner/tickOrchestrator.js';
import { scheduledSlot, slotPreflight } from '../../queue-runner/slot.js';
import {
  refreshSlotDeadline,
  writeHeartbeat,
  type Queue,
} from '../../queue-runner/slotDeadlineHeartbeat.js';
import { atomicWriteSync } from './atomic.js';
import { bindAdmit, type AdmitEnv } from './admitWiring.js';
import { bindDeliveryPhases, type DeliveryEnv } from './deliveryWiring.js';
import { queueBytes } from './queueEffects.js';
import { fileHeartbeatEffects, fileSlotDeadlineEffects } from './slotDeadlineSource.js';
import { fileSlotPreflightEffects } from './slotSource.js';
import { fileTickSeams } from './tickPhaseSeams.js';
import {
  fileReadSlotUsage,
  fileSlotUsageProbes,
  fileTickFetch,
  notifyOwnerFrom,
  recordCoverage,
} from './tickHostEffects.js';

/**
 * The phases this module cannot bind yet. Each one is a gap listed with its
 * Python source in docs/crq/tick-slot-missing-effects.md.
 */
export type RemainingPhaseNames =
  | 'backfillPublish'
  | 'backfillInventoryMode'
  | 'backfillInventory'
  | 'discovery'
  | 'resetFixPrBacklog'
  | 'refreshFixPrBacklog'
  | 'harvestItems'
  | 'reconcileCompleted'
  | 'repairBackfill'
  | 'archiveLegacy'
  | 'reconcile'
  | 'enrollPrimary'
  | 'enrollOthers'
  | 'writeStatus'
  | 'publishLocalReviewPr'
  | 'recordClientHealth';

export interface ComposeInput {
  readonly stateRoot: string;
  /** The parsed `config.json`. */
  readonly config: JsonObject;
  /** `crq.CLONE`: the primary clone (`config.clone`). */
  readonly clone: string;
  /** The vendor probes `readSlotUsage` uses; defaults to the file/process binding. */
  readonly usageProbes?: Parameters<typeof fileReadSlotUsage>[0]['probes'];
  /** `WATCHDOG_HOME`. */
  readonly watchdogHome: string;
  /** The heartbeat's `root` field (Python's `str(ROOT)`). */
  readonly root: string;
  readonly now?: () => number;
  /** Delivery effects minus what the seams already provide. */
  readonly delivery: Omit<DeliveryEnv, 'saveQueue' | 'now' | 'event'>;
  /** Admission effects: the pacing config, the clock and the per-kind `start_one`. */
  readonly admit: AdmitEnv;
  readonly remaining: Pick<TickPhases, RemainingPhaseNames>;
}

export function composeTickPhases(input: ComposeInput): TickPhases {
  const seams = fileTickSeams({
    stateRoot: input.stateRoot,
    config: input.config,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const plainConfig = toPlainJson(input.config) as Record<string, unknown>;
  const heartbeat = fileHeartbeatEffects({
    watchdogHome: input.watchdogHome,
    config: plainConfig,
    root: input.root,
    event: seams.event,
  });
  const deadline = fileSlotDeadlineEffects({
    stateRoot: input.stateRoot,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const delivery = bindDeliveryPhases({
    ...input.delivery,
    now: seams.nowIso,
    event: (kind, data) => seams.event(kind, data),
    // The receipt layer checkpoints synchronously; the tick's own saves stay async.
    saveQueue: (queue) => atomicWriteSync(join(input.stateRoot, 'queue.json'), queueBytes(queue)),
  });
  return {
    ...input.remaining,
    ...seams,
    ...delivery,
    fetch: fileTickFetch(input.clone),
    notifyOwner: notifyOwnerFrom(input.config),
    readSlotUsage: fileReadSlotUsage({
      clone: input.clone,
      probes: input.usageProbes ?? fileSlotUsageProbes(input.root, input.stateRoot),
    }),
    recordCoverage,
    admit: bindAdmit(input.admit),
    async refreshSlotDeadline(queue, usage, remaining, globalGate) {
      await refreshSlotDeadline(
        toPlainJson(queue) as Queue,
        usage as Record<string, unknown> | null,
        remaining as number,
        globalGate,
        undefined,
        deadline,
      );
      return queue;
    },
    writeHeartbeat: (queue) => writeHeartbeat(toPlainJson(queue) as Queue, heartbeat),
  };
}

export interface ComposeSlotInput {
  readonly stateRoot: string;
  readonly now?: () => number;
  readonly phases: TickPhases;
  /** `collect_finished(q, log)`: harvest finished runs before admission. */
  collectFinished(queue: JsonObject): Promise<PhaseResult>;
}

/** A lossless queue copy and equality, by the same bytes `save_queue` writes. */
const copyQueue = (queue: JsonObject): JsonObject =>
  parseJsonValue(queueBytes(queue)) as JsonObject;
const equalQueue = (a: JsonObject, b: JsonObject): boolean => queueBytes(a) === queueBytes(b);

/**
 * The slot timer entry: `slotPreflight` over `scheduledSlot`, with Python's
 * `slot()` as the locked admission body (collect, admit, save, refresh deadline).
 */
export function composeSlot(input: ComposeSlotInput): () => Promise<string[]> {
  const { phases } = input;
  const preflight = fileSlotPreflightEffects(input.stateRoot, () => run(), input.now ?? Date.now);
  const run = (): Promise<string[]> =>
    scheduledSlot<JsonObject, Awaited<ReturnType<TickPhases['readSlotUsage']>>>({
      disabled: () => phases.runnerDisabled(),
      withTickLock: (work) => preflight.withTickLock(work),
      loadQueue: () => phases.loadQueue(false),
      copyQueue,
      equalQueue,
      readUsage: (queue) => phases.readSlotUsage(queue),
      async admit(_copy, observation) {
        // Python's `slot(observed, observation)`: continue from the probed
        // queue, which carries the `vendor_observed` marks.
        const collected = await input.collectFinished(observation.queue);
        const admitted = await phases.admit(collected.queue, {
          usage: observation.usage,
          reserved: observation.reserved,
          log: collected.log,
          dry: false,
          only: null,
          ignoreQuiet: false,
        });
        await phases.saveQueue(admitted.queue);
        await phases.refreshSlotDeadline(
          admitted.queue,
          observation.usage,
          admitted.remaining,
          admitted.globalGate,
        );
        return [...collected.log, ...admitted.log];
      },
    });
  return () => slotPreflight(preflight);
}
