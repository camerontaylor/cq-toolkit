/**
 * The tick clocks, queue helpers and dispatch switch of `CoverageEffects`:
 * `nowMs`, `parseIsoMs`, `liveItems`, `compareItems`, `depsMet` and
 * `backfillDispatchConfigured`. Inactive: nothing routes them, and
 * `LIVE_UNIT_COMMANDS` and `repairUnit.ts` are untouched.
 *
 * Bound over modules that already carry the Python rules:
 * - `liveItems`, `compareItems` (`crq.sort_key`) and `depsMet` over
 *   `src/policy/crq/tickSchedule.ts`; the scheduling config (primary repo, repo
 *   ranks, local-review aging) is supplied by the caller, as `crq.CONFIG` is;
 * - `parseIsoMs` over `utc.parseIso` (`crq.parse_iso`);
 * - `backfillDispatchConfigured` over `backfill_runtime.settings(STATE,
 *   dispatch=True)` (`backfill_runtime.py:37`).
 *
 * The clock is injected: `crq.now()` reads the wall clock, which is a real
 * effect, so the caller supplies it and a fake is identical on both sides.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveLimits } from '../../policy/crq/backfillInventory.js';
import { JsonNumber, JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { ledgerLoads, ledgerPythonTypeName, pythonTruthy } from '../../policy/crq/ledger.js';
import { PyError } from '../../policy/crq/pyCompat.js';
import {
  compareSortKeys,
  depsMet,
  liveItems,
  sortKey,
  type ScheduleConfig,
} from '../../policy/crq/tickSchedule.js';
import { parseIso, UtcParseError } from '../../policy/crq/utc.js';
import type { CoverageEffects, Item, Queue } from '../../queue-runner/coverageUsage.js';
import { checkBackfillRollout } from './backfillRollout.js';

export type TickSeams = Pick<
  CoverageEffects,
  'nowMs' | 'parseIsoMs' | 'liveItems' | 'compareItems' | 'depsMet'
>;

export interface TickSeamsInput {
  /** `crq.now()` in epoch milliseconds: the wall clock, injected. */
  readonly clock: () => number;
  /** `crq.REPO`, `crq.REPOS` and `CONFIG["local_review_aging_minutes"]`. */
  readonly schedule: ScheduleConfig;
}

/** `now()` as epoch microseconds for the scheduler, from the injected millisecond clock. */
function nowMicros(ms: number): bigint {
  return BigInt(Math.trunc(ms)) * 1000n;
}

/**
 * `parse_iso(s)` in epoch milliseconds, as `coverage_fallback` calls it on a
 * truthy `not_before`. A non-string reaches `str.replace` in Python
 * (AttributeError); a malformed string is `strptime`'s ValueError.
 */
function parseIsoMs(value: string): number {
  const raw: unknown = value;
  if (typeof raw !== 'string') {
    // Falsy non-strings are `parse_iso`'s None; the rest reach `str.replace`.
    if (!pyTruthy(raw)) throw noneComparison();
    throw new PyError('AttributeError', `'${pythonTypeOf(raw)}' object has no attribute 'replace'`);
  }
  try {
    const parsed = parseIso(raw);
    if (parsed === null) throw noneComparison(); // `parse_iso("")` is None
    return Number(parsed.epochMicros / 1000n);
  } catch (error) {
    if (error instanceof UtcParseError) throw new PyError('ValueError', error.message);
    throw error;
  }
}

/** Python truthiness for any value an item field can hold: a JS scalar, a plain record or a retained JSON node. */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof JsonNumber || value instanceof JsonObject) {
    return pythonTruthy(value as JsonValue);
  }
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** The Python type name of a JS scalar, plain record or retained JSON node. */
function pythonTypeOf(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (Array.isArray(value)) return 'list';
  if (value !== null && typeof value === 'object' && !(value instanceof JsonNumber)) {
    return 'dict';
  }
  return ledgerPythonTypeName(value as JsonValue);
}

/** `None > now()`: what Python does with `parse_iso`'s None. */
function noneComparison(): PyError {
  return new PyError(
    'TypeError',
    "'>' not supported between instances of 'NoneType' and 'datetime.datetime'",
  );
}

/**
 * `tickSchedule.ts` reads numbers with `typeof x === 'number'`, so a retained
 * `JsonNumber` (the shape `composeTick`'s `viaPlain` carries) would read as
 * absent: `order` 999, `author.cycle` not a cycle, `generation` never 1. The
 * seam therefore hands the scheduler a shallow shadow of each item whose
 * number-carrying fields are plain JS numbers, leaving `tickSchedule.ts`
 * unchanged for its other callers. The originals are never copied back or
 * mutated. A plain-number item passes through identically. An integer past
 * 2^53 rounds in the shadow where Python compares exactly (not a schema value).
 */
function plainNumber(value: unknown): unknown {
  if (!(value instanceof JsonNumber)) return value;
  return value.kind === 'int' ? Number(value.integer) : value.float;
}

function shadow(item: Item): Item {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    out[key] = plainNumber(value);
  }
  const author = out.author;
  if (author !== null && typeof author === 'object' && !Array.isArray(author)) {
    out.author = Object.fromEntries(
      Object.entries(author).map(([key, value]) => [key, plainNumber(value)]),
    );
  }
  return out as Item;
}

export function bindTickSeams(input: TickSeamsInput): TickSeams {
  // Call the clock on its owner, so a method that reads `this` keeps its receiver.
  const context = () => ({ config: input.schedule, nowMicros: nowMicros(input.clock()) });
  return {
    nowMs: () => input.clock(),
    parseIsoMs,
    liveItems: (q: Queue): Item[] => liveItems(q) as Item[],
    compareItems: (a: Item, b: Item): number => {
      const at = context();
      return compareSortKeys(sortKey(shadow(a), at), sortKey(shadow(b), at));
    },
    depsMet: (q: Queue, item: Item): boolean =>
      depsMet(
        { ...q, items: Array.isArray(q.items) ? q.items.map((i) => shadow(i as Item)) : q.items },
        shadow(item),
      ),
  };
}

export interface DispatchSettingsInput {
  /** `crq.STATE`: the directory holding `backfill-rollout.json`. */
  readonly stateRoot: string;
  /**
   * `backfill_runtime.policies()[1]`: the parsed `policy/review-limits.json`.
   * Python loads all three policy files first, so a caller that cannot read
   * one throws here exactly as `policies()` does.
   */
  readonly loadLimits: () => JsonValue;
}

/**
 * `backfill_runtime.settings(STATE, dispatch=True)` is truthy: false when no
 * rollout is provisioned or it is not `enabled is True`; an incomplete
 * rollout or unverified limits throw, as Python's `IntegrityError` does.
 */
export function bindBackfillDispatchConfigured(
  input: DispatchSettingsInput,
): CoverageEffects['backfillDispatchConfigured'] {
  return () => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(input.stateRoot, 'backfill-rollout.json'));
    } catch (error) {
      // `Path.exists()` is False for these (and for a NUL in the path), not an error.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'EBADF') {
        return false;
      }
      if (code === 'ERR_INVALID_ARG_VALUE') return false;
      throw error;
    }
    const value = ledgerLoads(bytes);
    // Python reads `.get("enabled")` before the prerequisite checks.
    if (!(value instanceof JsonObject)) {
      throw new PyError(
        'AttributeError',
        `'${ledgerPythonTypeName(value)}' object has no attribute 'get'`,
      );
    }
    if (value.get('enabled') !== true) return false;
    const config = checkBackfillRollout(value);
    effectiveLimits(input.loadLimits(), { requireVerified: true });
    return pythonTruthy(config);
  };
}
