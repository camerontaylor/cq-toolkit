/**
 * Injected assembly of the `status_summary.publish` effect sections that are
 * pure reads (migration lane A1).
 *
 * Python's `status_summary.publish` builds the summary core with `summarize`,
 * refuses to publish when there is no completed tick, and then appends its
 * effect sections. Two of those sections are pure given the queue, the config,
 * one clock reading and a schedule probe: `utilization`
 * (`coverage.utilization_digest`) and `schedule`
 * (`{"id": config.get("schedule_id", "crq-tick.timer"),
 * "state": schedule.get("status") or "systemd"}`). This module ports exactly
 * that slice.
 *
 * It is an assembly helper, not a second full-summary implementation: the
 * caller passes the core document `readSummaryCore` produced from the same
 * queue/config/clock, so the existing core output contract is unchanged. The
 * reads (queue bytes, config bytes, schedule probe) are injected values; this
 * module never reads a file, the environment, the clock or a process.
 *
 * Python order is preserved because it is observable:
 *
 * 1. `data["last_tick"]` is read first and refused when falsy
 *    (`ValueError("no completed tick to publish")`), before titles, systemd,
 *    repair, triage or utilization.
 * 2. `queue.get("coverage") or coverage.new_ledger()` is evaluated before the
 *    keyword `max_starts_per_hour=data["starts_cap"]`, so a non-dict queue
 *    fails as an `AttributeError` before a missing cap does.
 * 3. `config.get("schedule_id", ...)` is evaluated before
 *    `schedule.get("status")`, and the section keeps `id` then `state`, with
 *    `error` only when the state is `"unknown"`.
 *
 * Losslessness is the caller's contract: pass the core document whose
 * `starts_cap` is a `JsonNumber` when the config carried a float or an integer
 * outside the safe range, and pass the lossless queue (at least `starts`,
 * `cooldown_until` and `coverage`) so `utilization` can keep Python's numeric
 * types. Serialise results with `pythonJson`, never `JSON.stringify`.
 */
import {
  CoverageUtilizationError,
  utilizationDigest,
  type CoverageUtilizationPythonError,
  type UtilizationDigest,
} from './coverageUtilization.js';
import { JsonNumber, JsonObject } from './jsonValue.js';

/** Python exception classes this projection can surface. */
export type SummarySectionsPythonError = CoverageUtilizationPythonError;

/** A refusal with the Python exception class the oracle would raise. */
export class SummarySectionsError extends Error {
  override readonly name: string = 'SummarySectionsError';
  readonly pythonError: SummarySectionsPythonError;

  constructor(message: string, pythonError: SummarySectionsPythonError = 'ValueError') {
    super(message);
    this.pythonError = pythonError;
  }
}

/** `{"id": …, "state": …[, "error": "schedule probe unavailable"]}`. */
export interface ScheduleSection {
  readonly id: unknown;
  readonly state: unknown;
  readonly error?: string;
}

export interface SummarySectionsInput {
  /**
   * The summary core from `readSummaryCore` (`{value}`), or an equivalent
   * document built by `status_summary.summarize` plus `schema_version` and
   * `generated_at`. A lossless {@link JsonObject} is accepted so `starts_cap`
   * keeps its source lexeme.
   */
  readonly core: unknown;
  /** The same queue document read for the core, ideally lossless. */
  readonly queue: unknown;
  /** The same config document read for the core. */
  readonly config: unknown;
  /** The `paseo schedule inspect` result, or `{}` when it was not probed. */
  readonly schedule: unknown;
  /** The one clock reading that produced the core's `generated_at`. */
  readonly now: unknown;
}

export interface SummarySections {
  /** The core with `utilization` then `schedule` appended, in publish order. */
  readonly value: Record<string, unknown>;
  readonly utilization: UtilizationDigest;
  readonly schedule: ScheduleSection;
}

/**
 * Assemble the pure `status_summary.publish` sections.
 *
 * Raises {@link SummarySectionsError} with the Python exception class and
 * message on every refusal the publisher or `coverage.utilization_digest`
 * would raise for the same inputs.
 */
export function assembleSummarySections(input: SummarySectionsInput): SummarySections {
  const lastTick = coreSubscript(input.core, 'last_tick');
  if (!pyTruthy(lastTick)) {
    throw new SummarySectionsError('no completed tick to publish', 'ValueError');
  }

  // Python evaluates the positional `queue.get("coverage")` before the
  // keyword `data["starts_cap"]`.
  const coverage = pyDictGet(input.queue, 'coverage', null);
  const ledger = pyTruthy(coverage) ? coverage : newLedger();
  const startsCap = coreSubscript(input.core, 'starts_cap');

  let utilization: UtilizationDigest;
  try {
    utilization = utilizationDigest(input.queue, ledger, {
      now: input.now,
      maxStartsPerHour: startsCap,
    });
  } catch (error) {
    if (error instanceof CoverageUtilizationError) {
      throw new SummarySectionsError(error.message, error.pythonError);
    }
    throw error;
  }

  const schedule = scheduleSection(input.config, input.schedule);
  return {
    value: { ...coreEntries(input.core), utilization, schedule },
    utilization,
    schedule,
  };
}

/** `coverage.new_ledger()`, in Python key order. */
function newLedger(): Record<string, unknown> {
  return { schema_version: 1, paths: {}, runs: {}, observations: {} };
}

function scheduleSection(config: unknown, schedule: unknown): ScheduleSection {
  // Python builds the dict left to right: `config.get` then `schedule.get`.
  const id = pyDictGet(config, 'schedule_id', 'crq-tick.timer');
  const rawState = pyDictGet(schedule, 'status', null);
  const state = pyTruthy(rawState) ? rawState : 'systemd';
  return state === 'unknown' ? { id, state, error: 'schedule probe unavailable' } : { id, state };
}

function coreSubscript(core: unknown, key: string): unknown {
  if (core instanceof JsonObject) {
    if (!core.has(key)) throw new SummarySectionsError(`'${key}'`, 'KeyError');
    return core.get(key);
  }
  if (isPlainRecord(core)) {
    if (!Object.prototype.hasOwnProperty.call(core, key)) {
      throw new SummarySectionsError(`'${key}'`, 'KeyError');
    }
    return nullish(core[key]);
  }
  throw new SummarySectionsError(subscriptMessage(core), 'TypeError');
}

/** `{**core}` with Python insertion order for both accepted core shapes. */
function coreEntries(core: unknown): Record<string, unknown> {
  if (core instanceof JsonObject) return Object.fromEntries(core.entries);
  if (isPlainRecord(core)) {
    return Object.fromEntries(Object.entries(core).map(([key, value]) => [key, nullish(value)]));
  }
  throw new SummarySectionsError(subscriptMessage(core), 'TypeError');
}

/** `container.get(key, default)` with Python's `AttributeError` on a non-dict. */
function pyDictGet(container: unknown, key: string, fallback: unknown): unknown {
  if (container instanceof JsonObject) {
    return container.has(key) ? container.get(key) : fallback;
  }
  if (isPlainRecord(container)) {
    return Object.prototype.hasOwnProperty.call(container, key)
      ? nullish(container[key])
      : fallback;
  }
  throw new SummarySectionsError(
    `'${pythonTypeName(container)}' object has no attribute 'get'`,
    'AttributeError',
  );
}

function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 || Number.isNaN(value);
  if (typeof value === 'bigint') return value !== 0n;
  if (typeof value === 'string') return value.length > 0;
  if (value instanceof JsonNumber) {
    return value.kind === 'int'
      ? (value.integer as bigint) !== 0n
      : (value.float as number) !== 0 || Number.isNaN(value.float as number);
  }
  if (value instanceof JsonObject) return value.entries.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function nullish(value: unknown): unknown {
  return value === undefined ? null : value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function subscriptMessage(value: unknown): string {
  if (value === null || value === undefined) return `'NoneType' object is not subscriptable`;
  if (Array.isArray(value)) return 'list indices must be integers or slices, not str';
  if (typeof value === 'string') return "string indices must be integers, not 'str'";
  return `'${pythonTypeName(value)}' object is not subscriptable`;
}

function pythonTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  if (value instanceof JsonNumber) return value.kind;
  return 'dict';
}
