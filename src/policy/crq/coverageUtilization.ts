/**
 * Read-only coverage utilization digest (`coverage.utilization_digest`).
 *
 * This is the A1 publish-section port: the Python producer is
 * `apps/crq-python/coverage.py:483-519`. The function is pure. It reads no
 * clock, filesystem, environment or process; the caller supplies the queue,
 * the coverage ledger, one `now` reading and the configured
 * `max_starts_per_hour`.
 *
 * Numeric edges follow the Python oracle rather than JavaScript convenience:
 *
 * - `max_starts_per_hour` is Python's dynamic value. `bool` is an `int`
 *   (`True` is a cap of 1, `False` is refused), `JsonNumber` keeps the
 *   int/float lexeme, and an unsafe plain JavaScript integer is refused
 *   because a rounded double cannot faithfully represent a Python `int`.
 * - `24 * cap` stays an exact Python `int` when `cap` is an `int`, including
 *   values far beyond `Number.MAX_SAFE_INTEGER`; a `float` cap uses binary64
 *   arithmetic, including overflow to `Infinity`, exactly like Python.
 * - `nominal_utilization` and a positive `cooldown_minutes` are Python
 *   floats and are returned as `JsonNumber.float` so `pythonJson` emits
 *   `0.0`/`15.0` rather than `0`/`15`.
 * - epoch seconds are converted to UTC microseconds with IEEE-754
 *   round-half-even, matching `datetime.fromtimestamp`, not `Math.round`.
 * - ISO timestamps use the already-vector-tested `parseUtc` grammar, with
 *   `coverage._time`'s additional timezone requirement: a naive value is a
 *   `ValueError`, not UTC.
 */
import { JsonNumber, JsonObject } from './jsonValue.js';
import { civilFromDays, daysFromCivil, parseUtcUnchecked } from './utc.js';

const DAY_MICROS = 86_400n * 1_000_000n;
const MICROS_PER_SECOND = 1_000_000n;
const MIN_DATETIME_MICROS = BigInt(daysFromCivil(1, 1, 1)) * DAY_MICROS;
const INT64_MAX = (1n << 63n) - 1n;
const INT64_MIN = -(1n << 63n);
const INT32_MAX = 2_147_483_647;
const INT32_MIN = -2_147_483_648;

/** A Python exception class this projection can surface. */
export type CoverageUtilizationPythonError =
  | 'ValueError'
  | 'TypeError'
  | 'KeyError'
  | 'AttributeError'
  | 'OverflowError'
  | 'OSError';

/** A refusal with the Python exception class the oracle would raise. */
export class CoverageUtilizationError extends Error {
  override readonly name: string = 'CoverageUtilizationError';
  readonly pythonError: CoverageUtilizationPythonError;

  constructor(message: string, pythonError: CoverageUtilizationPythonError = 'ValueError') {
    super(message);
    this.pythonError = pythonError;
  }
}

/** `coverage.utilization_digest(queue, ledger, *, now, max_starts_per_hour)`. */
export interface UtilizationDigestOptions {
  /**
   * The clock reading. Python's `_time` accepts an epoch `int`/`float`, a
   * string parsed by `datetime.fromisoformat`, or a `bool` (an `int`).
   * Lossless JSON callers should pass the `JsonNumber` they parsed.
   */
  readonly now: unknown;
  /**
   * `config["max_starts_per_hour"]`. Pass the lossless `JsonNumber` when the
   * config bytes matter; plain safe integers are treated as Python `int`,
   * non-integral numbers as Python `float`, and unsafe plain integers refuse.
   */
  readonly maxStartsPerHour: unknown;
}

/** `coverage.utilization_digest` output in Python key order. */
export interface UtilizationDigest {
  readonly starts_24h: number;
  readonly nominal_cap_24h: number | JsonNumber;
  readonly nominal_utilization: JsonNumber;
  readonly cooldown_minutes: number | JsonNumber;
  readonly observed_ticks_24h: number;
  readonly available_start_opportunities_24h: number;
  readonly idle_while_pending_24h: number | JsonNumber | null;
  readonly idle_with_coverage_candidate_24h: number | JsonNumber | null;
  readonly coverage_reviewed_paths: number;
}

type NumericOperand =
  | { readonly kind: 'int'; readonly value: bigint }
  | { readonly kind: 'float'; readonly value: number };

type PythonSum =
  | { readonly kind: 'int'; readonly value: bigint }
  | { readonly kind: 'compensated'; readonly hi: number; readonly lo: number };

/**
 * `coverage.utilization_digest`.
 *
 * `queue` and `ledger` may be plain records or lossless {@link JsonObject}
 * values. The function validates the fields it reads and raises
 * {@link CoverageUtilizationError} with the Python exception class on a
 * refusal, so a differential test can compare the oracle's class and message.
 */
export function utilizationDigest(
  queue: unknown,
  ledger: unknown,
  options: UtilizationDigestOptions,
): UtilizationDigest {
  const cap = capOperand(options.maxStartsPerHour);
  assertPositiveCap(cap);

  const now = coverageTime(options.now);
  const cutoff = now - DAY_MICROS;
  if (cutoff < MIN_DATETIME_MICROS) {
    throw new CoverageUtilizationError('date value out of range', 'OverflowError');
  }
  const starts = queueGet(queue, 'starts', []);
  let starts24h = 0;
  for (const value of pythonIterable(starts)) {
    const at = coverageTime(value);
    if (cutoff < at && at <= now) starts24h += 1;
  }

  const observations = dictGet(ledger, 'observations');
  const windowed: unknown[] = [];
  for (const [key, value] of dictEntries(observations)) {
    const at = coverageTime(key);
    if (cutoff < at && at <= now) windowed.push(value);
  }
  const availableRows = windowed.filter((value) => !pyTruthy(dictGet(value, 'blocked_reason')));
  const idleRows = availableRows.filter((value) => !pyTruthy(dictGet(value, 'started')));
  const observed = windowed.length;
  const available = availableRows.length;

  const cap24 = multiplyBy24(cap);
  const nominalUtilization = JsonNumber.float(divideStarts(starts24h, cap24.operand));
  const cooldown = cooldownMinutes(queue, now);
  let idleWhilePending: PythonSum = { kind: 'int', value: 0n };
  let idleWithCandidate: PythonSum = { kind: 'int', value: 0n };
  if (observed > 0) {
    for (const value of idleRows) {
      idleWhilePending = pythonAdd(idleWhilePending, dictGet(value, 'pending'));
    }
    for (const value of idleRows) {
      idleWithCandidate = pythonAdd(idleWithCandidate, dictGet(value, 'candidate_exists'));
    }
  }

  return {
    starts_24h: starts24h,
    nominal_cap_24h: cap24.value,
    nominal_utilization: nominalUtilization,
    cooldown_minutes: cooldown,
    observed_ticks_24h: observed,
    available_start_opportunities_24h: available,
    idle_while_pending_24h: observed === 0 ? null : encodeSum(idleWhilePending),
    idle_with_coverage_candidate_24h: observed === 0 ? null : encodeSum(idleWithCandidate),
    coverage_reviewed_paths: pythonLen(dictGet(ledger, 'paths')),
  };
}

interface EncodedCap {
  readonly value: number | JsonNumber;
  readonly operand: NumericOperand;
}

function capOperand(value: unknown): NumericOperand {
  if (typeof value === 'boolean') return { kind: 'int', value: value ? 1n : 0n };
  if (typeof value === 'bigint') return { kind: 'int', value };
  if (value instanceof JsonNumber) {
    return value.kind === 'int'
      ? { kind: 'int', value: value.integer as bigint }
      : { kind: 'float', value: value.float as number };
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) {
        throw new CoverageUtilizationError(
          'unsafe integer max_starts_per_hour must be passed as a lossless JsonNumber or bigint',
          'TypeError',
        );
      }
      return { kind: 'int', value: BigInt(value) };
    }
    return { kind: 'float', value };
  }
  throw new CoverageUtilizationError(
    `'<=' not supported between instances of '${pythonTypeName(value)}' and 'int'`,
    'TypeError',
  );
}

function assertPositiveCap(cap: NumericOperand): void {
  // Python tests `max_starts_per_hour <= 0`; NaN compares false and is
  // accepted (then propagates through the arithmetic).
  const invalid = cap.kind === 'int' ? cap.value <= 0n : cap.value <= 0;
  if (invalid) {
    throw new CoverageUtilizationError('max_starts_per_hour must be positive');
  }
}

function multiplyBy24(cap: NumericOperand): EncodedCap {
  if (cap.kind === 'int') {
    const product = cap.value * 24n;
    return {
      value: Number.isSafeInteger(Number(product)) ? Number(product) : JsonNumber.int(product),
      operand: { kind: 'int', value: product },
    };
  }
  const product = cap.value * 24;
  return {
    value: JsonNumber.float(product),
    operand: { kind: 'float', value: product },
  };
}

function divideStarts(starts: number, denominator: NumericOperand): number {
  // Python's `int / int` is a correctly rounded true division. Converting a
  // 300-digit denominator to binary64 first would overflow to Infinity and
  // wrongly turn a representable subnormal quotient into 0.0.
  return denominator.kind === 'int'
    ? intRatioToDouble(BigInt(starts), denominator.value)
    : starts / denominator.value;
}

/** `n / d` for a nonnegative Python int numerator and positive int denominator. */
function intRatioToDouble(numerator: bigint, denominator: bigint): number {
  if (numerator === 0n) return 0;
  const exponent = floorLog2Ratio(numerator, denominator);
  if (exponent < -1022) {
    // Subnormal result: round the exact quotient onto the 2^-1074 grid.
    const scaled = numerator << 1074n;
    const quotient = scaled / denominator;
    const remainder = scaled % denominator;
    let significand = quotient;
    const twice = remainder * 2n;
    if (twice > denominator || (twice === denominator && (significand & 1n) === 1n)) {
      significand += 1n;
    }
    if (significand === 0n) return 0;
    if (significand >= 1n << 52n) return 2 ** -1022;
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(0, Number(significand >> 32n), false);
    view.setUint32(4, Number(significand & 0xffff_ffffn), false);
    return view.getFloat64(0, false);
  }

  // Normal result: produce a 53-bit significand and round half to even.
  let shift = 52 - exponent;
  let { quotient, remainder, divisor } = scaledDivide(numerator, denominator, shift);
  while (bitLength(quotient) < 53) {
    shift += 1;
    ({ quotient, remainder, divisor } = scaledDivide(numerator, denominator, shift));
  }
  let significand = quotient;
  let power = -shift;
  const twice = remainder * 2n;
  if (twice > divisor || (twice === divisor && (significand & 1n) === 1n)) {
    significand += 1n;
  }
  if (significand === 1n << 53n) {
    significand >>= 1n;
    power += 1;
  }
  return Number(significand) * 2 ** power;
}

function scaledDivide(
  numerator: bigint,
  denominator: bigint,
  shift: number,
): { quotient: bigint; remainder: bigint; divisor: bigint } {
  const scaledNumerator = shift >= 0 ? numerator << BigInt(shift) : numerator;
  const divisor = shift >= 0 ? denominator : denominator << BigInt(-shift);
  return {
    quotient: scaledNumerator / divisor,
    remainder: scaledNumerator % divisor,
    divisor,
  };
}

function floorLog2Ratio(numerator: bigint, denominator: bigint): number {
  let exponent = bitLength(numerator) - bitLength(denominator);
  if (exponent >= 0) {
    if (numerator < denominator << BigInt(exponent)) exponent -= 1;
  } else if (numerator << BigInt(-exponent) < denominator) {
    exponent -= 1;
  }
  return exponent;
}

function bitLength(value: bigint): number {
  return value.toString(2).length;
}

function cooldownMinutes(queue: unknown, now: bigint): number | JsonNumber {
  const raw = queueGet(queue, 'cooldown_until');
  if (!pyTruthy(raw)) return 0;
  const cooldown = coverageTime(raw);
  const delta = cooldown - now;
  if (delta <= 0n) return 0;
  const minutes = Number(delta) / Number(MICROS_PER_SECOND) / 60;
  return JsonNumber.float(minutes);
}

function coverageTime(value: unknown): bigint {
  if (typeof value === 'string') return coverageTimeFromString(value);
  if (typeof value === 'boolean') return int64Seconds(value ? 1n : 0n);
  if (typeof value === 'bigint') return int64Seconds(value);
  if (value instanceof JsonNumber) {
    return value.kind === 'int'
      ? int64Seconds(value.integer as bigint)
      : floatSeconds(value.float as number);
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) {
        throw new CoverageUtilizationError(
          'unsafe integer timestamp must be passed as a lossless JsonNumber or bigint',
        );
      }
      return int64Seconds(BigInt(value));
    }
    return floatSeconds(value);
  }
  throw new CoverageUtilizationError('invalid timestamp');
}

function coverageTimeFromString(value: string): bigint {
  const micros = parseUtcUnchecked(value);
  if (micros === null) {
    throw new CoverageUtilizationError(
      `Invalid isoformat string: '${value.replaceAll('Z', '+00:00')}'`,
    );
  }
  // `fromisoformat` accepts any single character between date and time, so
  // do not assume `T`/`t`/space here. A date-only value is still naive even
  // when a zone marker follows it.
  if (DATE_ONLY.test(value) || DATE_ONLY_WITH_ZONE.test(value) || !HAS_ZONE_SUFFIX.test(value)) {
    throw new CoverageUtilizationError('timestamps must have a timezone');
  }
  // `fromisoformat` parsed a valid local datetime; `astimezone(UTC)` overflows
  // when the offset carries it outside years 1..9999.
  const { year } = civilFromDays(Number(floorDivBig(micros, DAY_MICROS)));
  if (year < 1 || year > 9999) {
    throw new CoverageUtilizationError('date value out of range', 'OverflowError');
  }
  return micros;
}

const DATE_ONLY = /^(?:\d{4}-\d{2}-\d{2}|\d{4}\d{2}\d{2}|\d{4}-W\d{2}(?:-\d)?|\d{4}W\d{2}\d?)$/u;
const DATE_ONLY_WITH_ZONE =
  /^(?:\d{4}-\d{2}-\d{2}|\d{4}\d{2}\d{2}|\d{4}-W\d{2}(?:-\d)?|\d{4}W\d{2}\d?)(?:Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2}(?:[.,]\d+)?)?)$/u;
const HAS_ZONE_SUFFIX = /(?:Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2}(?:[.,]\d+)?)?)$/u;

function int64Seconds(seconds: bigint): bigint {
  if (seconds < INT64_MIN || seconds > INT64_MAX) {
    throw new CoverageUtilizationError(
      'timestamp out of range for platform time_t',
      'OverflowError',
    );
  }
  return checkDatetimeRange(seconds * MICROS_PER_SECOND);
}

function floatSeconds(seconds: number): bigint {
  if (Number.isNaN(seconds)) {
    throw new CoverageUtilizationError('Invalid value NaN (not a number)');
  }
  if (!Number.isFinite(seconds)) {
    throw new CoverageUtilizationError(
      'timestamp out of range for platform time_t',
      'OverflowError',
    );
  }
  // time_t is a signed 64-bit second count; 2^63 itself is already outside it.
  const limit = 9_223_372_036_854_775_808;
  if (seconds >= limit || seconds < -limit) {
    throw new CoverageUtilizationError(
      'timestamp out of range for platform time_t',
      'OverflowError',
    );
  }
  return checkDatetimeRange(roundHalfEvenMicros(seconds));
}

/** Exact IEEE-754 value -> UTC microseconds, round half to even. */
function roundHalfEvenMicros(value: number): bigint {
  if (value === 0) return 0n;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const high = view.getUint32(0, false);
  const low = view.getUint32(4, false);
  const sign = (high & 0x8000_0000) !== 0 ? -1n : 1n;
  const exponent = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0x000f_ffff) << 32n) | BigInt(low);
  const numerator = exponent === 0 ? fraction : (1n << 52n) | fraction;
  const normalized =
    exponent === 0
      ? { significand: numerator, power: -1074 }
      : exponent > 1075
        ? { significand: numerator << BigInt(exponent - 1075), power: 0 }
        : { significand: numerator, power: exponent - 1075 };
  const scaled = normalized.significand * MICROS_PER_SECOND;
  const denominator = 1n << BigInt(-normalized.power);
  let quotient = scaled / denominator;
  const remainder = scaled % denominator;
  const twice = remainder * 2n;
  if (twice > denominator || (twice === denominator && (quotient & 1n) !== 0n)) {
    quotient += 1n;
  }
  return sign * quotient;
}

function checkDatetimeRange(micros: bigint): bigint {
  const days = floorDivBig(micros, DAY_MICROS);
  const { year } = civilFromDays(Number(days));
  if (year < 1 || year > 9999) {
    if (year > INT32_MAX || year < INT32_MIN) {
      throw new CoverageUtilizationError(
        '[Errno 75] Value too large for defined data type',
        'OSError',
      );
    }
    throw new CoverageUtilizationError(`year must be in 1..9999, not ${String(year)}`);
  }
  return micros;
}

function floorDivBig(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value % divisor !== 0n && value < 0n !== divisor < 0n ? quotient - 1n : quotient;
}

function queueGet(queue: unknown, key: string, fallback?: unknown): unknown {
  if (queue instanceof JsonObject) {
    return queue.has(key) ? queue.get(key) : fallback;
  }
  if (isPlainRecord(queue)) {
    return Object.prototype.hasOwnProperty.call(queue, key) ? queue[key] : fallback;
  }
  throw new CoverageUtilizationError(
    `'${pythonTypeName(queue)}' object has no attribute 'get'`,
    'AttributeError',
  );
}

function dictGet(container: unknown, key: string): unknown {
  if (container instanceof JsonObject) {
    if (!container.has(key)) throw new CoverageUtilizationError(`'${key}'`, 'KeyError');
    return container.get(key);
  }
  if (isPlainRecord(container)) {
    if (!Object.prototype.hasOwnProperty.call(container, key)) {
      throw new CoverageUtilizationError(`'${key}'`, 'KeyError');
    }
    return container[key];
  }
  throw new CoverageUtilizationError(subscriptMessage(container), 'TypeError');
}

function dictEntries(container: unknown): ReadonlyArray<readonly [string, unknown]> {
  if (container instanceof JsonObject) return container.entries;
  if (isPlainRecord(container)) return Object.entries(container);
  throw new CoverageUtilizationError(
    `'${pythonTypeName(container)}' object has no attribute 'items'`,
    'AttributeError',
  );
}

function pythonIterable(value: unknown): Iterable<unknown> {
  if (Array.isArray(value)) return value as unknown[];
  if (typeof value === 'string') return [...value];
  if (value instanceof JsonObject) return value.entries.map(([key]) => key);
  if (isPlainRecord(value)) return Object.keys(value);
  throw new CoverageUtilizationError(
    `'${pythonTypeName(value)}' object is not iterable`,
    'TypeError',
  );
}

function pythonLen(value: unknown): number {
  if (value instanceof JsonObject) return value.entries.length;
  if (isPlainRecord(value)) return Object.keys(value).length;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return [...value].length;
  throw new CoverageUtilizationError(
    `object of type '${pythonTypeName(value)}' has no len()`,
    'TypeError',
  );
}

function pythonAdd(total: PythonSum, value: unknown): PythonSum {
  if (total.kind === 'int') {
    if (typeof value === 'boolean') {
      return { kind: 'int', value: total.value + (value ? 1n : 0n) };
    }
    if (typeof value === 'bigint') {
      return { kind: 'int', value: total.value + value };
    }
    if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        if (!Number.isSafeInteger(value)) {
          throw new CoverageUtilizationError(
            'unsafe integer observation value must be passed as a lossless JsonNumber or bigint',
            'TypeError',
          );
        }
        return { kind: 'int', value: total.value + BigInt(value) };
      }
      return compensatedFromInt(total.value, value);
    }
    if (value instanceof JsonNumber) {
      return value.kind === 'int'
        ? { kind: 'int', value: total.value + (value.integer as bigint) }
        : compensatedFromInt(total.value, value.float as number);
    }
    throw new CoverageUtilizationError(
      `unsupported operand type(s) for +: 'int' and '${pythonTypeName(value)}'`,
      'TypeError',
    );
  }
  if (typeof value === 'boolean') return compensatedAdd(total, value ? 1 : 0);
  if (typeof value === 'bigint') return compensatedAdd(total, pythonIntToDouble(value));
  if (typeof value === 'number') return compensatedAdd(total, value);
  if (value instanceof JsonNumber) {
    const addend =
      value.kind === 'int' ? pythonIntToDouble(value.integer as bigint) : (value.float as number);
    return compensatedAdd(total, addend);
  }
  throw new CoverageUtilizationError(
    `unsupported operand type(s) for +: 'float' and '${pythonTypeName(value)}'`,
    'TypeError',
  );
}

/**
 * CPython `sum()` switches to a compensated (Neumaier) float accumulator as
 * soon as the running result is a float; see `Python/bltinmodule.c`.
 */
function compensatedFromInt(total: bigint, value: number): PythonSum {
  return { kind: 'compensated', hi: pythonIntToDouble(total) + value, lo: 0 };
}

function compensatedAdd(
  total: { readonly hi: number; readonly lo: number },
  value: number,
): PythonSum {
  const next = total.hi + value;
  const lo =
    Math.abs(total.hi) >= Math.abs(value)
      ? total.lo + (total.hi - next + value)
      : total.lo + (value - next + total.hi);
  return { kind: 'compensated', hi: next, lo };
}

function compensatedToDouble(total: { readonly hi: number; readonly lo: number }): number {
  if (total.lo !== 0 && Number.isFinite(total.lo)) return total.hi + total.lo;
  return total.hi;
}

function pythonIntToDouble(value: bigint): number {
  const result = Number(value);
  if (!Number.isFinite(result)) {
    throw new CoverageUtilizationError('int too large to convert to float', 'OverflowError');
  }
  return result;
}

function encodeSum(sum: PythonSum): number | JsonNumber {
  if (sum.kind === 'int') {
    return Number.isSafeInteger(Number(sum.value)) ? Number(sum.value) : JsonNumber.int(sum.value);
  }
  return JsonNumber.float(compensatedToDouble(sum));
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
