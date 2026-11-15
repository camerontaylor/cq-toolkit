/** Bounded backfill harvest: verified non-counted failures, vendor-only quota and
 * mixed-provenance quota (a hard failure). Caller holds tick.lock and supplies
 * independently verified terminal liveness. Counted completion is in
 * backfillHarvestCounted.ts.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import {
  ledgerLoads,
  ledgerTimestamp,
  LedgerIntegrityError,
  LedgerTypeError,
} from '../../../policy/crq/ledger.js';
import { classify } from '../../../policy/crq/classification.js';
import { terminalBackfill } from '../../../policy/crq/backfillTerminal.js';
import { deferTerminalQuota } from '../../../policy/crq/backfillJobs.js';
import { parseIso, formatUtcMicros } from '../../../policy/crq/utc.js';
import { pyTruthy, withObjectKeys } from '../../../policy/crq/queueDoc.js';

export interface BackfillRunArtifacts {
  readonly meta: Uint8Array;
  readonly exit: Uint8Array;
  readonly review: Uint8Array;
}
export interface BackfillFailureHarvestEffects {
  readArtifacts(runId: string): Promise<BackfillRunArtifacts>;
  retain(bytes: Uint8Array): Promise<void>;
  stateEvent(queue: JsonObject, item: JsonObject, at: string, reason: string): Promise<JsonObject>;
  saveQueue(queue: JsonObject): Promise<void>;
  cleanup(meta: JsonObject): Promise<void>;
}
function obj(value: JsonValue | undefined, label: string): JsonObject {
  if (!(value instanceof JsonObject)) throw new LedgerTypeError(`${label} must be an object`);
  return value;
}
function itemAt(queue: JsonObject, index: number): JsonObject {
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new LedgerTypeError('items must be an array');
  return obj(items[index], 'item');
}
function array(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new LedgerTypeError(`${label} must be an array`);
  return value;
}
function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !value)
    throw new LedgerTypeError(`${label} must be a nonempty string`);
  return value;
}
function exitInt(value: JsonValue | undefined): number {
  if (!(value instanceof JsonNumber) || value.kind !== 'int' || value.integer === null)
    throw new LedgerTypeError('exit code must be an integer');
  const result = Number(value.integer);
  if (!Number.isSafeInteger(result)) throw new LedgerTypeError('exit code must be safe');
  return result;
}

/** Real bytes are read and classified here. Terminal proof is supplied by the
 * caller's liveness check and bound to the exact run and exit code. Unhandled
 * outcomes leave queue and retained state unchanged. After any effect failure,
 * caller reloads durable queue and retries without launching another run.
 */
export async function harvestBackfillFailure(
  initial: JsonObject,
  index: number,
  proof: { readonly runId: string; readonly exitCode: number; readonly terminalVerified: true },
  effects: BackfillFailureHarvestEffects,
  defaultBackoffMinutes?: number,
): Promise<{ queue: JsonObject; status: 'handled' | 'unhandled'; classification: JsonObject }> {
  const item = itemAt(initial, index);
  const itemId = text(item.get('id'), 'item id');
  const run = obj(item.get('run'), 'run');
  const attempt = text(item.get('attempt_id'), 'attempt_id');
  const holds = obj(initial.get('backfill_reservations'), 'reservations');
  const hold = obj(holds.get(attempt), 'reservation');
  if (
    item.get('kind') !== 'backfill' ||
    item.get('state') !== 'reviewing' ||
    item.get('vendor_state') !== 'live' ||
    proof.terminalVerified !== true ||
    !proof.runId ||
    run.get('run_id') !== proof.runId ||
    hold.get('item') !== item.get('id') ||
    hold.get('vendor_run_id') !== proof.runId
  )
    throw new LedgerIntegrityError('backfill terminal ownership not verified');
  const artifacts = await effects.readArtifacts(proof.runId);
  const meta = obj(ledgerLoads(artifacts.meta), 'run metadata');
  const exit = obj(ledgerLoads(artifacts.exit), 'exit');
  const exitCode = exitInt(exit.get('exit'));
  if (
    meta.get('run_id') !== proof.runId ||
    meta.get('item_id') !== itemId ||
    obj(meta.get('backfill'), 'backfill metadata').get('attempt_id') !== attempt ||
    exitCode !== proof.exitCode
  )
    throw new LedgerIntegrityError('backfill terminal artifact identity mismatch');
  const endedAt = text(exit.get('ended_at'), 'ended_at');
  ledgerTimestamp(endedAt);
  const classification = classify(artifacts.review, exitCode);
  const outcome = text(classification.get('outcome'), 'outcome');
  const provenance = obj(classification.get('failure_provenance'), 'failure provenance');
  const causes = array(provenance.get('causes'), 'failure causes');
  const isVendorQuota = (v: JsonValue): boolean => {
    const cause = obj(v, 'cause');
    return cause.get('source') === 'vendor' && cause.get('category') === 'vendor-rate-limited';
  };
  const hasQuotaCause = causes.some(
    (v) => obj(v, 'cause').get('category') === 'vendor-rate-limited',
  );
  // Python: vendor quota mixed with any non-vendor cause is a hard failure, and a
  // rate-limit label without complete vendor-only provenance is an integrity failure.
  // Terminal ownership is already proven above, so Python's `known_terminal` holds.
  const mixed = hasQuotaCause && causes.some((v) => obj(v, 'cause').get('source') !== 'vendor');
  const authLike = outcome === 'auth' || outcome === 'action_required';
  const unprovenQuota =
    outcome === 'rate_limited' &&
    (provenance.get('complete') !== true || causes.length === 0 || !causes.every(isVendorQuota));
  const resolved = mixed
    ? authLike
      ? 'auth'
      : 'integrity'
    : unprovenQuota
      ? 'integrity'
      : outcome;
  const quota = resolved === 'rate_limited';
  if (
    classification.get('counted') !== false ||
    (!quota && !mixed && !unprovenQuota && hasQuotaCause)
  )
    return { queue: initial, status: 'unhandled', classification };
  const positiveInt = (value: JsonValue | undefined): number | null => {
    if (!(value instanceof JsonNumber) || value.kind !== 'int' || value.integer === null)
      return null;
    const n = Number(value.integer);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const configured = initial.get('rl_backoff_min');
  const fallback = pyTruthy(configured) ? positiveInt(configured) : defaultBackoffMinutes;
  const waitSeconds =
    positiveInt(classification.get('wait_seconds')) ??
    (typeof fallback === 'number' && Number.isSafeInteger(fallback) && fallback > 0
      ? fallback * 60
      : null);
  if (quota && (waitSeconds === null || !Number.isSafeInteger(waitSeconds)))
    return { queue: initial, status: 'unhandled', classification };
  await effects.retain(artifacts.review);
  await effects.retain(artifacts.exit);
  let queue = initial;
  let terminalOutcome = resolved;
  if (resolved === 'auth' || resolved === 'action_required') {
    queue = withObjectKeys(queue, [
      ['paused', true],
      ['pause_reason', 'backfill vendor authentication/action required; operator ruling needed'],
    ]);
    terminalOutcome = 'auth';
  }
  const wait = classification.get('wait_seconds');
  const retryAfter = !quota && pyTruthy(wait) ? exitInt(wait) : 0;
  const message = classification.get('message');
  const result = quota
    ? (() => {
        const ended = parseIso(endedAt);
        if (ended === null) throw new LedgerIntegrityError('invalid terminal timestamp');
        const deadline = ended.epochMicros + BigInt(waitSeconds!) * 1000000n;
        const current = parseIso(queue.get('cooldown_until'));
        const effective =
          current !== null && current.epochMicros > deadline ? current.epochMicros : deadline;
        queue = withObjectKeys(queue, [
          ['cooldown_until', formatUtcMicros(effective).slice(0, 19) + 'Z'],
        ]);
        return deferTerminalQuota(queue, index, endedAt, waitSeconds!);
      })()
    : terminalBackfill(
        queue,
        index,
        endedAt,
        terminalOutcome,
        true,
        retryAfter,
        typeof message === 'string' && message ? message : terminalOutcome,
      );
  queue = await finishHarvest(result, index, attempt, proof.runId, run, endedAt, outcome, effects);
  await effects.saveQueue(queue);
  await effects.cleanup(meta);
  return { queue, status: 'handled', classification };
}

/** Shared harvest tail: state event, one-time capacity row, one attempt record.
 * Python increments `completed_partitions` when the item reached publication-pending. */
export async function finishHarvest(
  result: { readonly queue: JsonObject; readonly item: JsonObject },
  index: number,
  attempt: string,
  runId: string,
  run: JsonObject,
  endedAt: string,
  outcome: string,
  effects: Pick<BackfillFailureHarvestEffects, 'stateEvent'>,
): Promise<JsonObject> {
  let queue = await effects.stateEvent(result.queue, result.item, endedAt, outcome);
  const capacityRuns =
    queue.get('backfill_capacity_runs') === undefined
      ? []
      : array(queue.get('backfill_capacity_runs'), 'capacity runs');
  if (!capacityRuns.includes(runId)) {
    const capacity =
      queue.get('backfill_daily_capacity') === undefined
        ? new JsonObject([])
        : obj(queue.get('backfill_daily_capacity'), 'daily capacity');
    const day = endedAt.slice(0, 10);
    const row =
      capacity.get(day) === undefined
        ? new JsonObject([
            ['spare_admissions', JsonNumber.int(0)],
            ['completed_partitions', JsonNumber.int(0)],
          ])
        : obj(capacity.get(day), 'daily capacity day');
    const done = row.get('completed_partitions');
    if (!(done instanceof JsonNumber) || done.kind !== 'int' || done.integer === null)
      throw new LedgerTypeError('completed_partitions must be an integer');
    const counted =
      result.item.get('state') === 'publication-pending'
        ? withObjectKeys(row, [['completed_partitions', JsonNumber.int(Number(done.integer) + 1)]])
        : row;
    queue = withObjectKeys(queue, [
      ['backfill_capacity_runs', [...capacityRuns, runId]],
      ['backfill_daily_capacity', withObjectKeys(capacity, [[day, counted]])],
    ]);
  }
  const current = itemAt(queue, index);
  if (current.get('id') !== result.item.get('id') || current.get('attempt_id') !== attempt)
    throw new LedgerIntegrityError('harvest event owner changed');
  const attempts =
    current.get('attempts') === undefined ? [] : array(current.get('attempts'), 'attempts');
  if (!attempts.some((v) => v instanceof JsonObject && v.get('run_id') === runId)) {
    const newAttempt = new JsonObject([
      ['run_id', runId],
      ['band', run.get('band') ?? 'background'],
      ['started_at', run.get('started_at') ?? null],
      ['outcome', outcome],
    ]);
    const items = array(queue.get('items'), 'items');
    queue = withObjectKeys(queue, [
      [
        'items',
        items.map((v, i) =>
          i === index ? withObjectKeys(current, [['attempts', [...attempts, newAttempt]]]) : v,
        ),
      ],
    ]);
  }
  return queue;
}
