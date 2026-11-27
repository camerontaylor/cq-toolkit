/**
 * `CoverageEffects.select`: `backfill_runtime.select(c, queue, log, dry, only)`
 * (apps/crq-python/backfill_runtime.py:162) over the plain mutable queue.
 * Inactive: nothing routes it, and `LIVE_UNIT_COMMANDS` and `repairUnit.ts` are
 * untouched.
 *
 * Ported here: the early-outs, the pre-flush of a pending `refusal_state_event`,
 * both Python sort keys (tuple comparison with Python's `==` then `<` rules),
 * eligibility, the dry gate probe with `wait_reason` restoration, the
 * reconciliation digest and its short-circuit, the per-target coverage read with
 * the shared prefix-digest map, `dispatch_tier_importance`, the main loop
 * (COVERAGE_PENDING, MISSING_EVIDENCE, coverage-satisfied `done`, `available`,
 * the item-independent gate refusal), the dry-run admit log, the launch plan, the
 * reviewing/bind path, the refused-launch terminal path, the `launch-unknown`
 * handler and the closing refresh request / reconciliation record.
 *
 * Left injected, because each is a live effect ({@link SelectCollaborators}):
 * - `launch`: `live.launch(queue, item, plan)`, which spawns the reviewer process;
 * - `fetchLedger`: `services(c, config)` then `GitLedger.fetch()`, which builds
 *   the real ArtifactStore, Outbox, Spool and publisher over the clone;
 * - `loadCoverage` / `requestCoverage`: the file-backed snapshot reader and
 *   request writer (`backfill_coverage.load` / `request`); the policy functions
 *   behind them are ported separately and are not wired to the state directory;
 * - `publicationFailureExists`: `(STATE / "backfill/publication-failure.json").exists()`;
 * plus the gate collaborators ({@link Rank4Collaborators}) and the dispatch switch.
 *
 * Documented deviations from Python: a queue list may hold only string ids and
 * targets (Python also accepts other hashables); an `items`-sort comparison
 * between two non-scalar values (lists or dicts) raises TypeError unless they
 * are equal, where Python orders lists; a `scope` that is not a list raises
 * TypeError where Python would also iterate an empty dict or string; and which
 * pair of items a sort-time TypeError names is pinned only for two-item lists.
 * Floats survive the whole-queue write-back (a float `remaining` or counter stays a
 * float, so the usage gate refuses exactly as Python does), but the job policies
 * keep `attempt` and the item, family and scope `failures` counters as integers: a
 * float counter there raises TypeError where Python does float arithmetic.
 * Malformed scope rows raise the shared ledger helpers' IntegrityError where
 * Python raises ValueError or proceeds: an interval with three elements, and a
 * non-string blob.
 */
import { isDeepStrictEqual } from 'node:util';
import { eligible } from '../../policy/crq/backfillJobs.js';
import { terminalBackfill } from '../../policy/crq/backfillTerminal.js';
import type { CoverageLoad } from '../../policy/crq/coverageSnapshot.js';
import { pyTruthy } from '../../policy/crq/coverageUtilization.js';
import { JsonNumber, JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import {
  ledgerDigestOf,
  ledgerIntervals,
  ledgerPath,
  ledgerScope,
} from '../../policy/crq/ledger.js';
import { PyError } from '../../policy/crq/pyCompat.js';
import { compareCodePoints } from '../../policy/crq/pythonJson.js';
import { fromPlainJson } from '../../policy/crq/queueDoc.js';
import {
  pyPrefix,
  type CoverageEffects,
  type Item,
  type Queue,
} from '../../queue-runner/coverageUsage.js';
import { keepUnsafeFloats } from '../../queue-runner/startOneEffects.js';
import {
  bindBindRun,
  bindCancelBeforeVendor,
  bindRank4Gate,
  pull,
  toJson,
  type Rank4Collaborators,
} from './coverageBackfillSeams.js';

export const MISSING_EVIDENCE = 'missing retained evidence; reconcile before dispatch';
export const COVERAGE_PENDING = 'coverage snapshot pending off-lock refresh';

/** The live effects `select` reaches through `c`, `services` and `backfill_coverage`. */
export interface SelectCollaborators {
  /** `(c.STATE / "backfill/publication-failure.json").exists()`. */
  publicationFailureExists(): boolean;
  /** `services(c, config)` then `publisher.fetch()`: the ledger head and its events. */
  fetchLedger(): Promise<{ head: string; events: readonly unknown[] }>;
  /** `coverage.load(c.STATE, target, events, digests)`: null when absent or stale. */
  loadCoverage(
    target: string,
    events: readonly unknown[],
    digests: Map<number, string>,
  ): Promise<CoverageLoad | null>;
  /** `coverage.request(c.STATE, head, targets)`: the refresher's small write. */
  requestCoverage(head: string, targets: readonly string[]): Promise<void>;
  /** `live.launch(queue, item, plan)`: spawns the reviewer process and returns the run id. */
  launch(queue: Queue, item: Item, plan: Record<string, unknown>): Promise<string>;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof JsonNumber) &&
  !(v instanceof JsonObject);
const has = (o: Rec, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const jv = (v: unknown): JsonValue => fromPlainJson(keepUnsafeFloats(v));

function typeName(v: unknown): string {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'bigint') return 'int';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (v instanceof JsonNumber) return v.kind === 'int' ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  return Array.isArray(v) ? 'list' : 'dict';
}

/** `d.get(key)` on a record: AttributeError for anything else. */
function get(o: unknown, key: string): unknown {
  if (!isRec(o))
    throw new PyError('AttributeError', `'${typeName(o)}' object has no attribute 'get'`);
  return has(o, key) ? o[key] : undefined;
}

/** `d[key]`: KeyError when absent, TypeError for a non-container. */
function need(o: unknown, key: string): unknown {
  if (isRec(o)) {
    if (!has(o, key)) throw new PyError('KeyError', `'${key}'`);
    return o[key];
  }
  throw new PyError(
    'TypeError',
    o === null || o === undefined || Array.isArray(o) || typeof o === 'string'
      ? `${typeName(o)} indices must be integers or slices, not str`
      : `'${typeName(o)}' object is not subscriptable`,
  );
}

// ------------------------------------------------------------ Python ordering

type PyVal =
  | { k: 'num'; v: bigint | number }
  | { k: 'str'; v: string }
  | { k: 'none' }
  | { k: 'other'; v: unknown };

function pv(v: unknown): PyVal {
  if (v === null || v === undefined) return { k: 'none' };
  if (typeof v === 'boolean') return { k: 'num', v: v ? 1n : 0n };
  if (typeof v === 'bigint' || typeof v === 'number') return { k: 'num', v };
  if (v instanceof JsonNumber)
    return { k: 'num', v: v.kind === 'int' ? (v.integer as bigint) : (v.float as number) };
  if (typeof v === 'string') return { k: 'str', v };
  return { k: 'other', v };
}

const numEq = (x: bigint | number, y: bigint | number): boolean =>
  !(x < y) && !(x > y) && !Number.isNaN(Number(x)) && !Number.isNaN(Number(y));

function pyEq(a: PyVal, b: PyVal): boolean {
  if (a.k === 'num' && b.k === 'num') return numEq(a.v, b.v);
  if (a.k === 'str' && b.k === 'str') return a.v === b.v;
  if (a.k === 'none' && b.k === 'none') return true;
  if (a.k === 'other' && b.k === 'other') return isDeepStrictEqual(a.v, b.v);
  return false;
}

function nameOf(p: PyVal): string {
  return p.k === 'none' ? 'NoneType' : typeName(p.k === 'num' ? p.v : p.v);
}

function pyLt(a: PyVal, b: PyVal): boolean {
  if (a.k === 'num' && b.k === 'num') return a.v < b.v;
  if (a.k === 'str' && b.k === 'str') return compareCodePoints(a.v, b.v) < 0;
  throw new PyError(
    'TypeError',
    `'<' not supported between instances of '${nameOf(a)}' and '${nameOf(b)}'`,
  );
}

/** Python tuple `<`: the first position where `==` fails decides by `<`. */
function tupleLt(a: readonly PyVal[], b: readonly PyVal[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (pyEq(a[i] as PyVal, b[i] as PyVal)) continue;
    return pyLt(a[i] as PyVal, b[i] as PyVal);
  }
  return false;
}

function negate(v: unknown): PyVal {
  const p = pv(v);
  if (p.k === 'num') return { k: 'num', v: -p.v };
  throw new PyError('TypeError', `bad operand type for unary -: '${typeName(v)}'`);
}

/** The Python sort key of one item, evaluated left to right as Python does. */
function sortKey(j: Rec, tierField: string): PyVal[] {
  const tier = pv(need(j, tierField));
  const retry = pv(has(j, 'retry') ? j.retry : false);
  const kindValue = need(j, 'subject_kind');
  const kind = pv(kindValue);
  const third =
    kindValue === 'A' ? pv(pyTruthy(get(j, 'row')) ? get(j, 'row') : 0) : negate(need(j, 'score'));
  return [tier, retry, kind, third, pv(need(j, 'subject_id'))];
}

/** `items.sort(key=...)`: stable, with every key computed before any comparison. */
function sortItems(items: Rec[], tierField: string): void {
  const keyed = items.map((item) => ({ item, key: sortKey(item, tierField) }));
  keyed.sort((x, y) => (tupleLt(x.key, y.key) ? -1 : tupleLt(y.key, x.key) ? 1 : 0));
  keyed.forEach((entry, i) => {
    items[i] = entry.item;
  });
}

/** `min(values, default=...)`: the first minimal value under Python `<`. */
function pyMin(values: readonly unknown[], fallback: unknown): unknown {
  if (values.length === 0) return fallback;
  let current = values[0];
  for (const value of values.slice(1)) if (pyLt(pv(value), pv(current))) current = value;
  return current;
}

const idOf = (item: Rec): string => {
  const id = need(item, 'id');
  if (typeof id !== 'string') throw new PyError('TypeError', "'<' not supported for non-str ids");
  return id;
};

const targetOf = (item: Rec): string => {
  const target = need(item, 'target');
  if (typeof target !== 'string') throw new PyError('TypeError', 'unhashable or non-str target');
  return target;
};

const sortedIds = (list: readonly Rec[]): string[] => list.map(idOf).sort(compareCodePoints);

/** An OSError, Python's or a Node system error. */
function isOsError(error: unknown): boolean {
  if (error instanceof PyError) return error.pythonError === 'OSError';
  const e = error as { code?: unknown; syscall?: unknown };
  return error instanceof Error && typeof e.code === 'string' && typeof e.syscall === 'string';
}

/**
 * `ledger.scope(item["scope"])` with Python's per-row access order: `row["path"]`,
 * `path()`, then `row["blob"]` (a KeyError, which the shared `ledgerScope` reports
 * as an IntegrityError), then the duplicate and interval checks.
 */
function scopeOf(rows: unknown): ReturnType<typeof ledgerScope> {
  if (!Array.isArray(rows))
    throw new PyError('TypeError', `'${typeName(rows)}' object is not iterable`);
  const result: ReturnType<typeof ledgerScope> = new Map();
  for (const [position, row] of rows.entries()) {
    ledgerPath(jv(need(row, 'path')));
    need(row, 'blob');
    const one = ledgerScope(jv([row]));
    for (const [name, blobs] of one) {
      const merged = result.get(name);
      if (merged === undefined) result.set(name, blobs);
      else
        for (const [blob, lines] of blobs) {
          // The prefix up to this row repeats a path/blob: the shared check raises the IntegrityError.
          if (merged.has(blob)) ledgerScope(jv(rows.slice(0, position + 1)));
          merged.set(blob, lines);
        }
    }
  }
  return result;
}

/** `CoverageEffects.select` over the plain queue. */
export function bindSelect(
  r: Rank4Collaborators,
  live: SelectCollaborators,
  dispatchConfigured: () => boolean,
): CoverageEffects['select'] {
  const gate = bindRank4Gate(r);

  const eligibleOf = (queue: Queue, item: Item, at: string): boolean => {
    // `eligible` returns false for any non-pending state before it reads anything else.
    if (item.state !== 'pending') return false;
    const index = queue.items.indexOf(item);
    const json = toJson(queue);
    const row = (json.get('items') as JsonValue[])[index] as JsonObject;
    const result = eligible(json, row, at);
    pull(queue, result.queue);
    return result.eligible;
  };

  return async (queue, log, dry, only) => {
    if (
      pyTruthy(get(queue, 'backfill_halted')) ||
      pyTruthy(get(queue, 'backfill_publication_error')) ||
      live.publicationFailureExists()
    )
      return { started: null, available: false };
    if (!dispatchConfigured()) return { started: null, available: false };
    const items: Rec[] = [];
    for (const raw of queue.items) {
      if (get(raw, 'kind') !== 'backfill') continue;
      if (!pyTruthy(only) || pyEq(pv(only), pv(need(raw, 'id')))) items.push(raw);
    }
    // Terminal refusals cannot become eligible again merely to retry publication.
    for (const item of items) {
      const pendingEvent = get(item, 'refusal_state_event');
      if (pyTruthy(pendingEvent) && !dry) {
        await r.stateEvent(
          queue,
          item,
          need(pendingEvent, 'at') as string,
          need(pendingEvent, 'reason') as string,
        );
        delete item.refusal_state_event;
        await r.saveQueue(queue);
      }
    }
    sortItems(items, 'tier_importance');
    const pending: Rec[] = [];
    for (const j of items) if (eligibleOf(queue, j, r.iso())) pending.push(j);
    if (pending.length === 0) return { started: null, available: false };

    // Coverage costs minutes of CPU on a large queue: ask the gate first.
    let refused: unknown = null;
    const first = pending[0] as Rec;
    const before = get(first, 'wait_reason');
    if (!(await gate(queue, first, true)))
      refused = get(first, 'wait_reason') || 'rank4-gate-refused';
    first.wait_reason = before;
    if (before === undefined || before === null) delete first.wait_reason;
    const { head, events } = await live.fetchLedger();
    const reconciliation = (eligibleJobs: readonly Rec[]): string =>
      ledgerDigestOf(
        new JsonObject([
          ['head', head],
          ['jobs', sortedIds(items)],
          ['eligible', sortedIds(eligibleJobs)],
        ]),
      );
    const reconciled = reconciliation(pending);
    const last = get(queue, 'backfill_coverage_reconciled');
    if (pyTruthy(refused) && isRec(last) && last.digest === reconciled) {
      for (const item of pending)
        if (get(item, 'wait_reason') !== MISSING_EVIDENCE) item.wait_reason = refused;
      return { started: null, available: pyTruthy(get(last, 'available')) };
    }

    // Coverage is never computed here, under tick.lock: read the off-lock snapshot.
    const snapshots = new Map<string, CoverageLoad | null>();
    const stale = new Set<string>();
    const digests = new Map<number, string>();
    const requestStale = async (logOnly = false): Promise<void> => {
      if (stale.size > 0 && !dry) {
        try {
          await live.requestCoverage(head, [...stale].sort(compareCodePoints));
        } catch (error) {
          if (!logOnly || !isOsError(error)) throw error;
          // After a bound launch, never fail the pass for a hint: the next pass re-requests.
          log.push(
            'coverage refresh request not written: ' + pyPrefix((error as Error).message, 150),
          );
        }
      }
    };
    const coverageFor = async (target: string): Promise<CoverageLoad | null> => {
      if (!snapshots.has(target)) {
        const loaded = await live.loadCoverage(target, events, digests);
        snapshots.set(target, loaded);
        if (loaded === null) stale.add(target);
      }
      return snapshots.get(target) as CoverageLoad | null;
    };

    for (const item of items) {
      const covered = item.state === 'pending' ? await coverageFor(targetOf(item)) : null;
      if (covered === null) {
        const tier = need(item, 'tier_importance');
        if (!has(item, 'dispatch_tier_importance')) item.dispatch_tier_importance = tier;
        continue;
      }
      const scope = need(item, 'scope');
      if (!Array.isArray(scope))
        throw new PyError('TypeError', `'${typeName(scope)}' object is not iterable`);
      const remaining: unknown[] = [];
      for (const r of scope) {
        const lines = ledgerIntervals(jv(need(r, 'intervals')));
        const have = covered.covered.get(need(r, 'path') as string);
        if ([...lines].some((line) => !have?.has(line))) remaining.push(r);
      }
      const tier = need(item, 'tier_importance');
      const tiers: unknown[] = [];
      for (const r of remaining) {
        const pathTiers = has(item, 'path_tiers') ? item.path_tiers : {};
        // `.get` is looked up before its arguments are evaluated.
        get(pathTiers, '');
        const mapped = get(pathTiers, need(r, 'path') as string);
        tiers.push(mapped === undefined ? need(item, 'tier_importance') : mapped);
      }
      item.dispatch_tier_importance = pyMin(tiers, tier);
    }
    sortItems(items, 'dispatch_tier_importance');

    let available = false;
    const seen: Rec[] = [];
    for (const item of items) {
      if (!eligibleOf(queue, item, r.iso())) continue;
      seen.push(item);
      const target = targetOf(item);
      const loaded = await coverageFor(target);
      if (loaded === null) {
        item.wait_reason = COVERAGE_PENDING;
        continue;
      }
      if (loaded.gaps.length > 0) {
        // Gaps can be transient (unreadable artifact): ask the refresher to retry them.
        item.wait_reason = MISSING_EVIDENCE;
        stale.add(target);
        continue;
      }
      const desired = scopeOf(need(item, 'scope'));
      let covered = true;
      for (const [name, blobs] of desired)
        for (const lines of blobs.values()) {
          const have = loaded.covered.get(name);
          if ([...lines].some((line) => !have?.has(line))) covered = false;
        }
      if (covered) {
        item.state = 'done';
        item.coverage_satisfied_by = head;
        seen.pop();
        continue;
      }
      available = true;
      if (pyTruthy(refused)) {
        // Every admission refusal is item-independent: record it once in history.
        item.wait_reason = refused;
        continue;
      }
      if (!(await gate(queue, item, dry))) {
        refused = get(item, 'wait_reason') || 'rank4-gate-refused';
        continue;
      }
      if (dry) {
        log.push('DRY-RUN would admit ' + (need(item, 'id') as string));
        return { started: null, available: true };
      }
      const plan = {
        base: need(item, 'base'),
        head: need(item, 'head'),
        target: need(item, 'target'),
        cycle: null,
        branch: null,
        notes: [] as unknown[],
        label: 'pinned scoped backfill',
        range_policy: 'backfill-current-scoped-v1',
      };
      let runBound = false;
      let terminalRecorded = false;
      try {
        const runId = await live.launch(queue, item, plan);
        if (item.state === 'reviewing') {
          bindBindRun(queue, item, runId);
          runBound = true;
          await r.stateEvent(queue, item, r.iso(), 'vendor identity bound');
          await r.saveQueue(queue);
          await requestStale(true);
          return { started: runId, available: true };
        }
        if (!pyTruthy(item.run)) bindCancelBeforeVendor(queue, item);
        const reason = has(item, 'last_error') ? item.last_error : 'launch refused';
        const at = r.iso();
        const vendorTerminal = !pyTruthy(item.run);
        const json = toJson(queue);
        const result = terminalBackfill(
          json,
          queue.items.indexOf(item),
          at,
          'secret-scan',
          vendorTerminal,
          0,
          typeof reason === 'string' ? reason : '',
        );
        pull(queue, result.queue);
        // `reason or outcome` keeps a truthy non-string last_error as it is.
        if (vendorTerminal && typeof reason !== 'string' && pyTruthy(reason))
          item.last_error = reason;
        terminalRecorded = true;
        item.refusal_state_event = { at: r.iso(), reason: 'launch refused before vendor binding' };
        await r.saveQueue(queue);
        const event = item.refusal_state_event as { at: string; reason: string };
        await r.stateEvent(queue, item, event.at, event.reason);
        delete item.refusal_state_event;
        await r.saveQueue(queue);
      } catch (error) {
        if (!runBound && !terminalRecorded) {
          item.state = 'launch-unknown';
          item.vendor_state = 'unknown';
        }
        await r.saveQueue(queue);
        throw error;
      }
    }
    if (stale.size > 0) await requestStale();
    else if (!pyTruthy(only))
      queue.backfill_coverage_reconciled = { digest: reconciliation(seen), available };
    return { started: null, available };
  };
}
