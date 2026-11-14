/**
 * The reconcile pass's per-run report (`repair_tick.reconcile_fix_prs`).
 *
 * Before this report existed a starved pass and a quiet pass were identical in
 * the tick log: six hours of non-projection on 2026-11-13 reported success. The
 * counters below make the difference visible and are deliberately REAL inputs,
 * never constants:
 *
 * - `examined` counts every entry the pass tried, receipt-lane items included;
 * - `projected` counts an advanced run;
 * - `starved` is `RefreshExhausted` (the shard budget ran out, recovers next
 *   tick); `deferred` is a real error that does not;
 * - `errors` retains at most the first five, as `item`/`run`/`error` triples.
 *
 * The log line and the `reconcile_incomplete` event are pure projections of the
 * same counters, so an operator cannot see one without the other being true.
 */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import { isJsonRecord, pyTruthy, recordGet, type JsonRecordLike } from './queueDoc.js';
import { RefreshExhausted } from './forgeBudget.js';

/** `repair_tick.reconcile_fix_prs`'s first-five error cap. */
export const RECONCILE_ERROR_CAP = 5;

export interface ReconcileErrorEntry {
  readonly item: string | null;
  readonly run: string;
  readonly error: string;
}

export interface ReconcileStats {
  examined: number;
  projected: number;
  starved: number;
  deferred: number;
  errors: ReconcileErrorEntry[];
}

export function newReconcileStats(): ReconcileStats {
  return { examined: 0, projected: 0, starved: 0, deferred: 0, errors: [] };
}

/** One entry the pass attempted; receipt items and eligible repair runs count. */
export function countExamined(stats: ReconcileStats): void {
  stats.examined += 1;
}

/** One run advanced to its merged state. */
export function countProjected(stats: ReconcileStats): void {
  stats.projected += 1;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `${typeof error}: ${String(error)}`;
}

function pushError(stats: ReconcileStats, item: string | null, run: string, error: string): void {
  if (stats.errors.length >= RECONCILE_ERROR_CAP) return;
  stats.errors.push({ item, run, error });
}

/**
 * `swallowed`: classify one thrown effect. Budget starvation is named
 * separately because it recovers by itself next tick while a real error does
 * not, and the first five errors survive into the event.
 */
export function recordSwallowed(
  stats: ReconcileStats,
  error: unknown,
  item: string | null,
  run: string,
): void {
  if (error instanceof RefreshExhausted) stats.starved += 1;
  else stats.deferred += 1;
  pushError(stats, item, run, errorText(error));
}

/** Python `int(value or 0)` for the lane's own counters. */
function countOf(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }
  return 0;
}

/**
 * Receipt-lane skips are counted by the lane itself: add its `starved` and
 * `deferred` totals and retain its first two messages within the global cap.
 */
export function recordLaneSkips(
  stats: ReconcileStats,
  skips: unknown,
  item: string | null,
  itemRun: string,
): void {
  if (!isJsonRecord(skips)) return;
  stats.starved += countOf(recordGet(skips, 'starved'));
  stats.deferred += countOf(recordGet(skips, 'deferred'));
  const messages = recordGet(skips, 'errors');
  if (!Array.isArray(messages)) return;
  for (const message of messages.slice(0, 2)) {
    pushError(stats, item, itemRun, typeof message === 'string' ? message : String(message));
  }
}

/** The tick log line; `null` when the pass examined nothing (a quiet tick). */
export function reconcileLogLine(stats: ReconcileStats): string | null {
  if (stats.examined === 0) return null;
  return (
    `reconcile: ${String(stats.examined)} examined, ` +
    `${String(stats.projected)} projected, ` +
    `${String(stats.starved)} starved, ` +
    `${String(stats.deferred)} deferred`
  );
}

/**
 * The `reconcile_incomplete` event body (the caller prepends `at` and appends
 * the line). `null` when the pass was neither starved nor deferred.
 */
export function reconcileIncompleteEvent(stats: ReconcileStats): JsonObject | null {
  if (stats.starved === 0 && stats.deferred === 0) return null;
  const errors: JsonValue[] = stats.errors.map(
    (entry) =>
      new JsonObject([
        ['item', entry.item],
        ['run', entry.run],
        ['error', entry.error],
      ]),
  );
  return new JsonObject([
    ['event', 'reconcile_incomplete'],
    ['examined', JsonNumber.int(stats.examined)],
    ['projected', JsonNumber.int(stats.projected)],
    ['starved', JsonNumber.int(stats.starved)],
    ['deferred', JsonNumber.int(stats.deferred)],
    ['errors', errors],
  ]);
}

/**
 * One tick's reconcile output: the log line it appends and the
 * `reconcile_incomplete` event it writes, both derived from the same counts.
 */
export function reconcileTickReport(
  stats: ReconcileStats,
  atIso: string,
): { readonly line: string | null; readonly event: JsonObject | null } {
  const body = reconcileIncompleteEvent(stats);
  return {
    line: reconcileLogLine(stats),
    event:
      body === null
        ? null
        : new JsonObject([
            ['at', atIso],
            ...body.entries.map(([key, value]) => [key, value] as const),
          ]),
  };
}

/** Materialise the counts for a caller that still expects a plain report. */
export function reconcileStatsObject(stats: ReconcileStats): JsonObject {
  const errors: JsonValue[] = stats.errors.map(
    (entry) =>
      new JsonObject([
        ['item', entry.item],
        ['run', entry.run],
        ['error', entry.error],
      ]),
  );
  return new JsonObject([
    ['examined', JsonNumber.int(stats.examined)],
    ['projected', JsonNumber.int(stats.projected)],
    ['starved', JsonNumber.int(stats.starved)],
    ['deferred', JsonNumber.int(stats.deferred)],
    ['errors', errors],
  ]);
}

/**
 * Read one item's `id` and item-level `run` exactly as `safe get` does, so an
 * unusual item never turns the report into an exception.
 */
export function itemIdentity(item: JsonRecordLike): {
  readonly id: string | null;
  readonly run: string;
} {
  const id = recordGet(item, 'id');
  const run = recordGet(item, 'run');
  return {
    id: typeof id === 'string' ? id : null,
    run: pyTruthy(run) && typeof run === 'string' ? run : '',
  };
}
