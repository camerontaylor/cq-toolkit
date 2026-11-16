/** Non-launching portion of backfill_runtime.select. Caller holds tick.lock.
 * Effects read already-published ledger/snapshots, write refresh hints and may
 * durably reserve via the optional real gate. Gate effects must retain item
 * indices. The returned queue is a replacement and must be persisted by the caller.
 * A candidate alone is not authorization to launch.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import {
  LedgerTypeError,
  ledgerDigestOf,
  ledgerIntervals,
  ledgerScope,
} from '../../../policy/crq/ledger.js';
import { eligible } from '../../../policy/crq/backfillJobs.js';
import { pyTruthy, withObjectKeys, withoutObjectKey } from '../../../policy/crq/queueDoc.js';
import { compareCodePoints } from '../../../policy/crq/pythonJson.js';
import type { CoverageLoad } from '../../../policy/crq/coverageSnapshot.js';

export const COVERAGE_PENDING = 'coverage snapshot pending off-lock refresh';
export const MISSING_EVIDENCE = 'missing retained evidence; reconcile before dispatch';

export interface BackfillSelectionEffects {
  now(): string;
  /** Must perform rank4Gate with dry=true and return its replacement queue. */
  probeGate(
    queue: JsonObject,
    itemIndex: number,
  ): Promise<{ queue: JsonObject; admitted: boolean }>;
  /** Non-dry gate must persist the reservation before returning admitted. */
  admitGate?(
    queue: JsonObject,
    itemIndex: number,
  ): Promise<{ queue: JsonObject; admitted: boolean }>;
  fetchLedger(): Promise<{ head: string; events: readonly JsonValue[] }>;
  /** Must validate snapshot against events, returning null for stale or absent. */
  loadCoverage(target: string, events: readonly JsonValue[]): Promise<CoverageLoad | null>;
  /** Write a refresh hint only; actual coverage calculation is off-lock. */
  requestCoverage(head: string, targets: readonly string[]): Promise<void>;
}

function obj(value: JsonValue | undefined, label: string): JsonObject {
  if (!(value instanceof JsonObject)) throw new LedgerTypeError(`${label} must be an object`);
  return value;
}
function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string') throw new LedgerTypeError(`${label} must be a string`);
  return value;
}
function number(value: JsonValue | undefined, label: string): bigint | number {
  if (!(value instanceof JsonNumber)) throw new LedgerTypeError(`${label} must be a number`);
  return value.kind === 'int' ? value.integer! : value.float!;
}
function cmpNumber(a: bigint | number, b: bigint | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function cmpTier(a: JsonValue | undefined, b: JsonValue | undefined): number {
  if (typeof a === 'string' && typeof b === 'string') return compareCodePoints(a, b);
  if (a instanceof JsonNumber && b instanceof JsonNumber)
    return cmpNumber(number(a, 'tier'), number(b, 'tier'));
  throw new LedgerTypeError('tiers must be comparable strings or numbers');
}
function itemAt(queue: JsonObject, index: number): JsonObject {
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new LedgerTypeError('items must be an array');
  return obj(items[index], 'item');
}
function putItem(queue: JsonObject, index: number, item: JsonObject): JsonObject {
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new LedgerTypeError('items must be an array');
  return withObjectKeys(queue, [['items', items.map((value, i) => (i === index ? item : value))]]);
}
function compareItems(a: JsonObject, b: JsonObject, dispatch: boolean): number {
  const tier = dispatch ? 'dispatch_tier_importance' : 'tier_importance';
  const tierCmp = cmpTier(a.get(tier), b.get(tier));
  if (tierCmp) return tierCmp;
  const retryCmp = Number(pyTruthy(a.get('retry'))) - Number(pyTruthy(b.get('retry')));
  if (retryCmp) return retryCmp;
  const ak = text(a.get('subject_kind'), 'subject_kind');
  const bk = text(b.get('subject_kind'), 'subject_kind');
  const kindCmp = compareCodePoints(ak, bk);
  if (kindCmp) return kindCmp;
  const av =
    ak === 'A'
      ? pyTruthy(a.get('row'))
        ? number(a.get('row'), 'row')
        : 0
      : number(a.get('score'), 'score');
  const bv =
    bk === 'A'
      ? pyTruthy(b.get('row'))
        ? number(b.get('row'), 'row')
        : 0
      : number(b.get('score'), 'score');
  const scoreCmp = cmpNumber(av, bv) * (ak === 'A' ? 1 : -1);
  return (
    scoreCmp ||
    compareCodePoints(
      text(a.get('subject_id'), 'subject_id'),
      text(b.get('subject_id'), 'subject_id'),
    )
  );
}
function digest(
  head: string,
  queue: JsonObject,
  indices: readonly number[],
  eligibleIndices: readonly number[],
): string {
  const ids = (list: readonly number[]) =>
    list.map((i) => text(itemAt(queue, i).get('id'), 'id')).sort(compareCodePoints);
  return ledgerDigestOf(
    new JsonObject([
      ['head', head],
      ['jobs', ids(indices)],
      ['eligible', ids(eligibleIndices)],
    ]),
  );
}
function remaining(item: JsonObject, coverage: CoverageLoad): JsonObject[] {
  const scope = item.get('scope');
  if (!Array.isArray(scope)) throw new LedgerTypeError('scope must be an array');
  return scope
    .map((row) => obj(row, 'scope row'))
    .filter((row) => {
      const path = text(row.get('path'), 'path');
      const intervals = row.get('intervals');
      if (intervals === undefined) throw new LedgerTypeError('missing intervals');
      const covered = coverage.covered.get(path);
      return [...ledgerIntervals(intervals)].some((line) => !covered?.has(line));
    });
}

/** Selects without launching. A supplied non-dry gate may durably reserve.
 * Unpublished refusal events must be flushed by the caller before this pass.
 * A reserved candidate must be completed or recovered while retaining ownership.
 */
export async function reconcileBackfillSelection(
  initial: JsonObject,
  options: {
    halted: boolean;
    dispatchEnabled: boolean;
    dry: boolean;
    only?: string;
  },
  effects: BackfillSelectionEffects,
): Promise<{ queue: JsonObject; candidate: number | null; available: boolean; reserved: boolean }> {
  let queue = initial;
  if (
    options.halted ||
    pyTruthy(queue.get('backfill_halted')) ||
    pyTruthy(queue.get('backfill_publication_error')) ||
    !options.dispatchEnabled
  )
    return { queue, candidate: null, available: false, reserved: false };
  const raw = queue.get('items');
  if (!Array.isArray(raw)) throw new LedgerTypeError('items must be an array');
  const indices = raw
    .map((_, i) => i)
    .filter((i) => {
      const item = itemAt(queue, i);
      return item.get('kind') === 'backfill' && (!options.only || item.get('id') === options.only);
    });
  if (!options.dry && indices.some((i) => pyTruthy(itemAt(queue, i).get('refusal_state_event'))))
    throw new LedgerTypeError('pending refusal state events must be flushed before selection');
  indices.sort((a, b) => compareItems(itemAt(queue, a), itemAt(queue, b), false));
  const pending: number[] = [];
  for (const index of indices) {
    const result = eligible(queue, itemAt(queue, index), effects.now());
    queue = result.queue;
    if (result.eligible) pending.push(index);
  }
  if (!pending.length) return { queue, candidate: null, available: false, reserved: false };
  const first = pending[0]!;
  const before = itemAt(queue, first).get('wait_reason');
  const probe = await effects.probeGate(queue, first);
  queue = probe.queue;
  let refused = probe.admitted
    ? null
    : text(itemAt(queue, first).get('wait_reason') || 'rank4-gate-refused', 'wait_reason');
  let restored = itemAt(queue, first);
  restored =
    before === undefined
      ? withoutObjectKey(restored, 'wait_reason')
      : withObjectKeys(restored, [['wait_reason', before]]);
  queue = putItem(queue, first, restored);
  const { head, events } = await effects.fetchLedger();
  const last = queue.get('backfill_coverage_reconciled');
  if (
    refused &&
    last instanceof JsonObject &&
    last.get('digest') === digest(head, queue, indices, pending)
  ) {
    for (const index of pending) {
      const item = itemAt(queue, index);
      if (item.get('wait_reason') !== MISSING_EVIDENCE)
        queue = putItem(queue, index, withObjectKeys(item, [['wait_reason', refused]]));
    }
    return { queue, candidate: null, available: pyTruthy(last.get('available')), reserved: false };
  }
  const snapshots = new Map<string, CoverageLoad | null>();
  const stale = new Set<string>();
  let requestedCount = 0;
  const requestStale = async (): Promise<void> => {
    if (!options.dry && stale.size > requestedCount) {
      await effects.requestCoverage(head, [...stale].sort(compareCodePoints));
      requestedCount = stale.size;
    }
  };
  const load = async (target: string): Promise<CoverageLoad | null> => {
    if (!snapshots.has(target)) {
      const snapshot = await effects.loadCoverage(target, events);
      snapshots.set(target, snapshot);
      if (snapshot === null) stale.add(target);
    }
    return snapshots.get(target) ?? null;
  };
  for (const index of indices) {
    const item = itemAt(queue, index);
    const coverage =
      item.get('state') === 'pending' ? await load(text(item.get('target'), 'target')) : null;
    if (coverage === null) {
      if (!item.has('dispatch_tier_importance'))
        queue = putItem(
          queue,
          index,
          withObjectKeys(item, [['dispatch_tier_importance', item.get('tier_importance')!]]),
        );
      continue;
    }
    const tiers = item.get('path_tiers');
    const pathTiers = tiers === undefined ? new JsonObject([]) : obj(tiers, 'path_tiers');
    const candidates = remaining(item, coverage).map(
      (row) => pathTiers.get(text(row.get('path'), 'path')) ?? item.get('tier_importance')!,
    );
    let tier = item.get('tier_importance')!;
    if (candidates.length) tier = candidates.reduce((a, b) => (cmpTier(a, b) <= 0 ? a : b));
    queue = putItem(queue, index, withObjectKeys(item, [['dispatch_tier_importance', tier]]));
  }
  indices.sort((a, b) => compareItems(itemAt(queue, a), itemAt(queue, b), true));
  let available = false;
  const seen: number[] = [];
  let candidate: number | null = null;
  for (const index of indices) {
    const result = eligible(queue, itemAt(queue, index), effects.now());
    queue = result.queue;
    if (!result.eligible) continue;
    seen.push(index);
    const item = itemAt(queue, index);
    const target = text(item.get('target'), 'target');
    const coverage = await load(target);
    if (coverage === null) {
      queue = putItem(queue, index, withObjectKeys(item, [['wait_reason', COVERAGE_PENDING]]));
      continue;
    }
    if (coverage.gaps.length) {
      stale.add(target);
      queue = putItem(queue, index, withObjectKeys(item, [['wait_reason', MISSING_EVIDENCE]]));
      continue;
    }
    const scope = item.get('scope');
    if (scope === undefined) throw new LedgerTypeError('missing scope');
    const desired = ledgerScope(scope);
    const covered = [...desired].every(([path, blobs]) =>
      [...blobs.values()].every((lines) =>
        [...lines].every((line) => coverage.covered.get(path)?.has(line)),
      ),
    );
    if (covered) {
      queue = putItem(
        queue,
        index,
        withObjectKeys(item, [
          ['state', 'done'],
          ['coverage_satisfied_by', head],
        ]),
      );
      seen.pop();
      continue;
    }
    available = true;
    if (refused) {
      queue = putItem(queue, index, withObjectKeys(item, [['wait_reason', refused]]));
      continue;
    }
    if (!options.dry && effects.admitGate !== undefined) {
      // A failed refresh hint must not conceal a durable reservation.
      await requestStale();
      const admission = await effects.admitGate(queue, index);
      queue = admission.queue;
      if (!admission.admitted) {
        refused = text(
          itemAt(queue, index).get('wait_reason') || 'rank4-gate-refused',
          'wait_reason',
        );
        continue;
      }
      return { queue, candidate: index, available, reserved: true };
    }
    candidate = index;
    break;
  }
  await requestStale();
  if (candidate === null && !stale.size && !options.only)
    queue = withObjectKeys(queue, [
      [
        'backfill_coverage_reconciled',
        new JsonObject([
          ['digest', digest(head, queue, indices, seen)],
          ['available', available],
        ]),
      ],
    ]);
  return { queue, candidate, available, reserved: false };
}
