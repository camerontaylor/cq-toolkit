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
function nowMicros(clock: () => number): bigint {
  return BigInt(Math.trunc(clock())) * 1000n;
}

/**
 * `parse_iso(s)` in epoch milliseconds, as `coverage_fallback` calls it on a
 * truthy `not_before`. A non-string reaches `str.replace` in Python
 * (AttributeError); a malformed string is `strptime`'s ValueError.
 */
function parseIsoMs(value: string): number {
  const raw = value as unknown as JsonValue;
  if (typeof raw !== 'string') {
    // Falsy non-strings are `parse_iso`'s None; the rest reach `str.replace`.
    if (!pyTruthy(raw)) throw noneComparison();
    throw new PyError(
      'AttributeError',
      `'${ledgerPythonTypeName(raw)}' object has no attribute 'replace'`,
    );
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

/** Python truthiness for a value that may be a plain record (an item field) or a JSON value. */
function pyTruthy(value: JsonValue): boolean {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof JsonNumber) &&
    !(value instanceof JsonObject)
  ) {
    return Object.keys(value).length > 0;
  }
  return pythonTruthy(value);
}

/** `None > now()`: what Python does with `parse_iso`'s None. */
function noneComparison(): PyError {
  return new PyError(
    'TypeError',
    "'>' not supported between instances of 'NoneType' and 'datetime.datetime'",
  );
}

export function bindTickSeams(input: TickSeamsInput): TickSeams {
  const context = () => ({ config: input.schedule, nowMicros: nowMicros(input.clock) });
  return {
    nowMs: () => input.clock(),
    parseIsoMs,
    liveItems: (q: Queue): Item[] => liveItems(q) as Item[],
    compareItems: (a: Item, b: Item): number => {
      const at = context();
      return compareSortKeys(sortKey(a, at), sortKey(b, at));
    },
    depsMet: (q: Queue, item: Item): boolean => depsMet(q, item),
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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
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
