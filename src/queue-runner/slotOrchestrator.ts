/**
 * The ordering of `crq.slot` and `crq.scheduled_slot` (crq.py:3316-3349) over
 * injected phases. Inactive: it owns sequencing only. `slot` is one locked
 * admission pass (collect, read usage, admit, save, refresh the deadline);
 * `scheduled_slot` probes quota outside tick.lock and commits only if no queue
 * state changed meanwhile. Python's `slot` neither writes status, heartbeat
 * nor the summary: those belong to `tick`. An error escaping a phase abandons
 * the rest, so nothing later runs and nothing is saved.
 */
import type { JsonObject } from '../policy/crq/jsonValue.js';

export const SLOT_RUNNER_DISABLED_LOG = 'runner disabled for host handover';
export const SLOT_QUEUE_CHANGED_LOG = 'queue changed during quota probe; retry next slot tick';

export interface SlotUsageObservation {
  readonly usage: unknown;
  readonly reserved: readonly unknown[];
}

export interface SlotAdmission {
  readonly queue: JsonObject;
  /** Lines `admit_available` appended to the log it was given. */
  readonly log: readonly string[];
  readonly globalGate: string | null;
  readonly remaining: unknown;
}

export interface SlotPhases {
  /** `(STATE / "runner-disabled").exists()` */
  runnerDisabled(): Promise<boolean>;
  loadQueue(): Promise<JsonObject>;
  /** `collect_finished(q, log)`: returns the updated queue and its log lines. */
  collectFinished(queue: JsonObject): Promise<{ queue: JsonObject; log: readonly string[] }>;
  readSlotUsage(queue: JsonObject): Promise<SlotUsageObservation>;
  /** `admit_available(..., reserved=reserved, capture_current=False)`. */
  admit(
    queue: JsonObject,
    request: { usage: unknown; reserved: readonly unknown[]; log: readonly string[] },
  ): Promise<SlotAdmission>;
  saveQueue(queue: JsonObject): Promise<void>;
  /** `refresh_slot_deadline(q, usage, remaining, gate, at=now())` */
  refreshSlotDeadline(
    queue: JsonObject,
    usage: unknown,
    remaining: unknown,
    globalGate: string | null,
    atMs: number,
  ): Promise<void>;
  nowMs(): number;
}

export interface SlotInput {
  /** `q`: a queue the caller already holds, else loaded. */
  readonly queue?: JsonObject | null;
  /** `observation`: a usage probe already taken, else read here. */
  readonly observation?: SlotUsageObservation | null;
}

/** `crq.slot(q, observation)`; the caller holds tick.lock. */
export async function runSlot(input: SlotInput, p: SlotPhases): Promise<string[]> {
  if (await p.runnerDisabled()) return [SLOT_RUNNER_DISABLED_LOG];
  let q = input.queue ?? (await p.loadQueue());
  const log: string[] = [];
  const collected = await p.collectFinished(q);
  q = collected.queue;
  log.push(...collected.log);
  const { usage, reserved } = input.observation ?? (await p.readSlotUsage(q));
  const admitted = await p.admit(q, { usage, reserved, log });
  q = admitted.queue;
  log.push(...admitted.log);
  await p.saveQueue(q);
  await p.refreshSlotDeadline(q, usage, admitted.remaining, admitted.globalGate, p.nowMs());
  return log;
}

export interface SlotLock {
  /** Runs `fn` under tick.lock without waiting; `ran: false` when busy. */
  withLock<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>;
}

export interface ScheduledSlotPhases extends SlotPhases {
  /** Python `!=` on the loaded queue dicts. */
  sameQueue(left: JsonObject, right: JsonObject): boolean;
}

/** `crq.scheduled_slot()`: probe outside the lock, commit only on an unchanged queue. */
export async function runScheduledSlot(lock: SlotLock, p: ScheduledSlotPhases): Promise<string[]> {
  if (await p.runnerDisabled()) return [SLOT_RUNNER_DISABLED_LOG];
  const first = await lock.withLock(() => p.loadQueue());
  if (!first.ran) return [];
  const snapshot = first.value;
  const observation = await p.readSlotUsage(snapshot);
  const committed = await lock.withLock(async () => {
    if (!p.sameQueue(await p.loadQueue(), snapshot)) return [SLOT_QUEUE_CHANGED_LOG];
    return runSlot({ queue: snapshot, observation }, p);
  });
  return committed.ran ? committed.value : [];
}
