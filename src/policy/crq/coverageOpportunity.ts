/**
 * The tick's coverage-opportunity record: `coverage.new_ledger` and
 * `coverage.record_opportunity` (apps/crq-python/coverage.py:43, :469), as the
 * tick applies them to `queue["coverage"]` (crq.py `tick`, after admission).
 *
 * Python semantics kept:
 * - `q.get("coverage") or new_ledger()`: a missing, null or otherwise falsy
 *   ledger starts fresh; any truthy value is used as-is.
 * - `record_opportunity` deep-copies the ledger and sets ONE observation keyed
 *   by `_iso(at)`, so a repeated timestamp replaces its entry (idempotent) and
 *   a new key is appended in insertion order.
 * - After inserting, observations at or before `at - 24h` are dropped (the
 *   window `utilization_digest` reads); an existing key that `_time` would
 *   reject (unparseable, or naive without a timezone) raises.
 * - A truthy ledger that is not an object, or whose `observations` is missing
 *   or not an object, raises (Python's TypeError/KeyError abandon the tick).
 */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import { withObjectKeys } from './queueDoc.js';
import { parseIso, parseUtc } from './utc.js';

/** One tick opportunity, as `runTick` observes it. */
export interface OpportunityObservation {
  readonly at: string;
  readonly started: boolean;
  readonly pending: boolean;
  readonly candidateExists: boolean;
  readonly blockedReason: string | null;
}

/** `coverage.new_ledger()`. */
export function newCoverageLedger(): JsonObject {
  return new JsonObject([
    ['schema_version', JsonNumber.int(1)],
    ['paths', new JsonObject([])],
    ['runs', new JsonObject([])],
    ['observations', new JsonObject([])],
  ]);
}

/** Python truthiness for a JSON value (`x or default`). */
function truthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 0;
  if (value instanceof JsonNumber) {
    return value.integer !== null ? value.integer !== 0n : value.float !== 0;
  }
  if (Array.isArray(value)) return value.length > 0;
  return value.entries.length > 0;
}

/**
 * `coverage._iso(at)` for the one form the tick passes: `crq.iso()`, whole
 * seconds with `Z`, which `fromisoformat` + `isoformat()` returns unchanged.
 * Any other spelling is refused instead of approximating `fromisoformat`.
 */
export function coverageIso(at: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(at)) {
    throw new Error(`invalid timestamp: ${at}`);
  }
  parseIso(at); // calendar validation; throws on an impossible date or time
  return at;
}

/** `coverage.record_opportunity(ledger, at=..., ...)`; the input is never mutated. */
export function recordOpportunity(
  ledger: JsonValue,
  observation: OpportunityObservation,
): JsonObject {
  if (!(ledger instanceof JsonObject)) {
    throw new TypeError('coverage ledger must be an object');
  }
  const observations = ledger.get('observations');
  if (!(observations instanceof JsonObject)) {
    throw new TypeError("coverage ledger 'observations' must be an object");
  }
  const entry = new JsonObject([
    ['started', observation.started],
    ['pending', observation.pending],
    ['candidate_exists', observation.candidateExists],
    ['blocked_reason', observation.blockedReason],
  ]);
  const at = coverageIso(observation.at);
  const cutoff = observationMicros(at) - DAY_MICROS;
  const inserted = withObjectKeys(observations, [[at, entry]]);
  const kept = inserted.entries.filter(([key]) => observationMicros(key) > cutoff);
  return withObjectKeys(ledger, [['observations', new JsonObject(kept)]]);
}

const DAY_MICROS = 86_400n * 1_000_000n;

/** Python `_time(key)` for an observation key: needs a timezone, else raises. */
function observationMicros(key: string): bigint {
  const parsed = /(Z|[+-]\d{2}(:?\d{2}(:?\d{2}(\.\d+)?)?)?)$/.test(key) ? parseUtc(key) : null;
  if (parsed === null) throw new Error(`invalid timestamp: ${key}`);
  return parsed.epochMicros;
}

/** The tick's `q["coverage"] = record_opportunity(q.get("coverage") or new_ledger(), ...)`. */
export function recordTickOpportunity(
  queue: JsonObject,
  observation: OpportunityObservation,
): JsonObject {
  const current = queue.get('coverage');
  const ledger = truthy(current) ? (current as JsonValue) : newCoverageLedger();
  return withObjectKeys(queue, [['coverage', recordOpportunity(ledger, observation)]]);
}
