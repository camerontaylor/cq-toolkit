/**
 * The ordering of `crq.tick` (crq.py:3352-3495) as one function over injected
 * phases. Inactive: it owns sequencing and the few decisions `tick` makes
 * itself (disabled, dry/only gating, backfill fail-closed halt, stale gap,
 * last_tick, start/pending bookkeeping, coverage/save order) and nothing else.
 * Every effect is a local function type so concrete phases bind later.
 *
 * Python semantics kept: a phase error that `tick` does not catch abandons the
 * rest of the tick (no later phase runs, nothing is saved by the orchestrator);
 * `tick.lock` is acquired by the caller of `tick`, not inside it, so
 * {@link runTickLocked} wraps {@link runTick} and a refused lock runs nothing.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../policy/crq/jsonValue.js';
import { withObjectKeys } from '../policy/crq/queueDoc.js';
import { PROMOTION_KIND } from '../policy/crq/tickSchedule.js';

export interface PhaseResult {
  readonly queue: JsonObject;
  readonly log: readonly string[];
}

export interface TickInput {
  readonly dry: boolean;
  /** `only`: Python `Optional[str]`; `not only` treats '' like None, `only is None` does not. */
  readonly only: string | null;
  readonly ignoreQuiet: boolean;
  /** `CONFIG.get("stale_alarm_min", 36)`. */
  readonly staleAlarmMin: number;
  /** `STATE / 'status.md'`, named in the outage notice. */
  readonly statusPath: string;
}

export interface AdmissionOutcome extends PhaseResult {
  readonly hasCoverage: boolean;
  readonly globalGate: string | null;
  readonly remaining: unknown;
}

export interface CoverageObservation {
  readonly at: string;
  readonly started: boolean;
  readonly pending: boolean;
  readonly candidateExists: boolean;
  readonly blockedReason: string | null;
}

export interface TickPhases {
  /** `(STATE / "runner-disabled").exists()` */
  runnerDisabled(): Promise<boolean>;
  /** `load_queue(persist_compaction=not dry)` */
  loadQueue(persistCompaction: boolean): Promise<JsonObject>;
  fetch(): Promise<void>;
  /** `backfill_runtime.publish`; may throw. */
  backfillPublish(queue: JsonObject): Promise<JsonObject>;
  /** `backfill_runtime.settings(STATE)?.inventory_mode`; null when no rollout. */
  backfillInventoryMode(): Promise<string | null>;
  /** `backfill_runtime.run_inventory`; may throw. */
  backfillInventory(queue: JsonObject): Promise<JsonObject>;
  /** Deferred refresh, merged and push discovery (live, unrestricted ticks only). */
  discovery(queue: JsonObject): Promise<PhaseResult>;
  /** Per live item: republish, harvest_review, legacy addressing, repair harvest. */
  harvestItems(queue: JsonObject, dry: boolean): Promise<PhaseResult>;
  reconcileCompleted(queue: JsonObject): Promise<JsonObject>;
  /** Up to two push findings-issue retries. */
  deliverIssues(queue: JsonObject): Promise<PhaseResult>;
  deliverPrReviews(queue: JsonObject): Promise<PhaseResult>;
  deliverCleanReviews(queue: JsonObject): Promise<PhaseResult>;
  deliverReviewRefreshes(queue: JsonObject): Promise<PhaseResult>;
  repairBackfill(queue: JsonObject): Promise<JsonObject>;
  archiveLegacy(queue: JsonObject): Promise<JsonObject>;
  /** The 80/60 reconcile window and its report. */
  reconcile(queue: JsonObject): Promise<PhaseResult>;
  /** `parse_iso` in epoch milliseconds; null when absent or unparseable. */
  parseIso(value: JsonValue | undefined): number | null;
  nowMs(): number;
  nowIso(): string;
  event(kind: string, data: Readonly<Record<string, unknown>>): Promise<void>;
  notifyOwner(message: string): Promise<void>;
  enrollPrimary(queue: JsonObject, dry: boolean): Promise<PhaseResult>;
  enrollOthers(queue: JsonObject, dry: boolean): Promise<PhaseResult>;
  readSlotUsage(queue: JsonObject): Promise<{ usage: unknown; reserved: readonly unknown[] }>;
  /** `admit_available`: reservation and launch under the gate. */
  admit(
    queue: JsonObject,
    request: {
      usage: unknown;
      reserved: readonly unknown[];
      log: readonly string[];
      dry: boolean;
      only: string | null;
      ignoreQuiet: boolean;
    },
  ): Promise<AdmissionOutcome>;
  recordCoverage(queue: JsonObject, observation: CoverageObservation): Promise<JsonObject>;
  saveQueue(queue: JsonObject): Promise<void>;
  refreshSlotDeadline(
    queue: JsonObject,
    usage: unknown,
    remaining: unknown,
    globalGate: string | null,
  ): Promise<JsonObject>;
  writeStatus(queue: JsonObject): Promise<void>;
  writeHeartbeat(queue: JsonObject): Promise<void>;
  /** `local_review_pr.publish` */
  publishLocalReviewPr(queue: JsonObject): Promise<JsonObject>;
  /** `client_health.record(..., discovery_enabled=...)` */
  recordClientHealth(queue: JsonObject, discoveryEnabled: boolean): Promise<PhaseResult>;
  /** `CONFIG["merged_discovery"]` is a dict with `enabled is True`. */
  mergedDiscoveryEnabled(): boolean;
}

/** First `n` Unicode code points, as Python `str[:n]`. */
function head(text: string, n: number): string {
  return Array.from(text).slice(0, n).join('');
}

function truthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 0;
  if (value instanceof JsonNumber)
    return value.integer !== null ? value.integer !== 0n : value.float !== 0;
  if (Array.isArray(value)) return value.length > 0;
  return value.entries.length > 0;
}

function startsCount(queue: JsonObject): number {
  const starts = queue.get('starts');
  return Array.isArray(starts) ? starts.length : 0;
}

function anyPending(queue: JsonObject): boolean {
  const items = queue.get('items');
  if (!Array.isArray(items)) {
    throw new TypeError('queue.items must be an array');
  }
  return items.some(
    (item) =>
      item instanceof JsonObject &&
      item.get('kind') !== PROMOTION_KIND &&
      item.get('state') === 'pending',
  );
}

const pyRound = (value: number): number => {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
};

export const RUNNER_DISABLED_LOG = 'runner disabled for host handover';

/** `crq.tick(dry, only, ignore_quiet)`; the caller holds tick.lock. */
export async function runTick(input: TickInput, p: TickPhases): Promise<string[]> {
  const { dry, only } = input;
  if (await p.runnerDisabled()) return [RUNNER_DISABLED_LOG];
  let q = await p.loadQueue(!dry);
  await p.fetch();
  const log: string[] = [];
  if (!dry) {
    let operation = 'publication-request';
    try {
      q = await p.backfillPublish(q);
      operation = 'inventory';
      const mode = await p.backfillInventoryMode();
      if (mode === 'integrated' && (only === null || only === '')) {
        q = await p.backfillInventory(q);
      }
    } catch (error) {
      // Fail closed for rank4 while retaining ordinary scheduler progress.
      const message = head(error instanceof Error ? error.message : String(error), 300);
      if (!truthy(q.get('backfill_halted')) || q.get('backfill_halt_operation') === operation) {
        q = withObjectKeys(q, [
          ['backfill_halted', message],
          ['backfill_halt_operation', operation],
        ]);
      }
      log.push(`backfill halted: ${message}`);
    }
    if (only === null) {
      const found = await p.discovery(q);
      q = found.queue;
      log.push(...found.log);
    }
  }
  const startsBefore = startsCount(q);
  const harvested = await p.harvestItems(q, dry);
  q = harvested.queue;
  log.push(...harvested.log);
  if (!dry) {
    q = await p.reconcileCompleted(q);
    const issues = await p.deliverIssues(q);
    q = issues.queue;
    log.push(...issues.log);
    const prReviews = await p.deliverPrReviews(q);
    q = prReviews.queue;
    log.push(...prReviews.log);
    const clean = await p.deliverCleanReviews(q);
    q = clean.queue;
    log.push(...clean.log);
    const refreshes = await p.deliverReviewRefreshes(q);
    q = refreshes.queue;
    log.push(...refreshes.log);
    q = await p.repairBackfill(q);
    q = await p.archiveLegacy(q);
    const reconciled = await p.reconcile(q);
    q = reconciled.queue;
    log.push(...reconciled.log);
  }
  const prev = p.parseIso(q.get('last_tick'));
  const staleMin = input.staleAlarmMin;
  if (prev !== null && !dry && (p.nowMs() - prev) / 60000 > staleMin) {
    const gap = (p.nowMs() - prev) / 60000;
    const lastTick = q.get('last_tick');
    await p.event('tick_gap', { last_tick: lastTick, gap_min: pyRound(gap) });
    log.push(
      `tick gap: previous tick was ${String(pyRound(gap))}m ago (> ${String(staleMin)}m) — chancellor alerted`,
    );
    await p.notifyOwner(
      `crq RECOVERED after an outage: the previous completed tick was ${String(lastTick)} ` +
        `(${String(pyRound(gap))}m ago, > ${String(staleMin)}m). Schedule runs may have reported 'succeeded' meanwhile. See ${input.statusPath}.`,
    );
  }
  const lastTick = p.nowIso();
  q = withObjectKeys(q, [['last_tick', lastTick]]);
  const primary = await p.enrollPrimary(q, dry);
  q = primary.queue;
  log.push(...primary.log);
  const others = await p.enrollOthers(q, dry);
  q = others.queue;
  log.push(...others.log);
  const pendingAtSelection = anyPending(q);
  const { usage, reserved } = await p.readSlotUsage(q);
  const admitted = await p.admit(q, {
    usage,
    reserved,
    log,
    dry,
    only,
    ignoreQuiet: input.ignoreQuiet,
  });
  q = admitted.queue;
  log.push(...admitted.log);
  if (!dry) {
    q = await p.recordCoverage(q, {
      at: lastTick,
      started: startsCount(q) > startsBefore,
      pending: pendingAtSelection,
      candidateExists: admitted.hasCoverage,
      blockedReason:
        (admitted.globalGate !== null && admitted.globalGate !== '' ? admitted.globalGate : null) ??
        (only !== null && only !== '' ? 'only' : null),
    });
    await p.saveQueue(q); // before the slow Paseo calls: a killed tick must not lose a launch
    q = await p.refreshSlotDeadline(q, usage, admitted.remaining, admitted.globalGate);
    await p.writeStatus(q);
    await p.writeHeartbeat(q);
    q = await p.publishLocalReviewPr(q);
    const health = await p.recordClientHealth(q, only === null && p.mergedDiscoveryEnabled());
    q = health.queue;
    log.push(...health.log);
    await p.saveQueue(q);
  }
  return log;
}

export interface TickLock {
  /** Runs `fn` under tick.lock; `ran: false` when the lock was busy. */
  withLock<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>;
}

/** `with_lock(tick)`: null when another tick holds the lock. */
export async function runTickLocked(
  lock: TickLock,
  input: TickInput,
  phases: TickPhases,
): Promise<string[] | null> {
  const outcome = await lock.withLock(() => runTick(input, phases));
  return outcome.ran ? outcome.value : null;
}
