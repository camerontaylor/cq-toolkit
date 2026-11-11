/**
 * UTC parsing for the crq port.
 *
 * Two Python parsers exist and they are deliberately different:
 *
 * - `queue_time.parse_utc` uses `datetime.fromisoformat` (with every `Z`
 *   rewritten to `+00:00`), treats a naive value as UTC, and returns `None`
 *   for a missing, non-string or malformed value. It accepts extended and
 *   basic ISO dates, ISO week dates, `T`/`t`/space separators, comma or dot
 *   fractions, hour-only times, 24:00 rollover, and numeric offsets.
 * - `crq.parse_iso` is the older strict parser: strip every `.000`, take the
 *   first 20 characters, strip trailing `Z`, then `strptime` exactly
 *   `%Y-%m-%dT%H:%M:%SZ`. Its quirks are observable (non-padded components
 *   parse, non-zero fractions raise) and phase 0.3 pinned them.
 *
 * Microseconds survive both parsers, so the value is an exact `bigint`
 * microsecond count rather than a JavaScript `Date` (which is millisecond
 * precision and loses year 0-99 handling). `UtcInstant.iso` is the canonical
 * six-fraction-digit UTC spelling used by the Python vectors.
 */

export class UtcParseError extends Error {
  override readonly name = 'UtcParseError';
  readonly pythonError = 'ValueError';
}

export class UtcInstant {
  readonly epochMicros: bigint;
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ`, exactly six fraction digits. */
  readonly iso: string;

  constructor(epochMicros: bigint) {
    this.epochMicros = epochMicros;
    this.iso = formatUtcMicros(epochMicros);
  }

  /** Milliseconds since the epoch (floor), for scheduling comparisons. */
  epochMillis(): number {
    return Number(floorDiv(this.epochMicros, 1000n));
  }

  /** A JavaScript Date at millisecond precision; the sub-millisecond part is dropped. */
  toDate(): Date {
    return new Date(this.epochMillis());
  }
}

const MICROS_PER_SECOND = 1_000_000n;
const MICROS_PER_DAY = 86_400n * MICROS_PER_SECOND;
const MS_PER_DAY = 86_400_000;

/**
 * `queue_time.parse_utc`: ISO parsing with naive-means-UTC; malformed values
 * return null, never local time.
 */
export function parseUtc(value: unknown): UtcInstant | null {
  const micros = parseUtcUnchecked(value);
  if (micros === null) return null;
  const { year } = civilFromDays(Number(floorDiv(micros, MICROS_PER_DAY)));
  // Python datetime.astimezone() raises OverflowError outside years 1..9999,
  // which parse_utc catches and reports as None.
  if (year < 1 || year > 9999) return null;
  return new UtcInstant(micros);
}

/**
 * Parse-only companion to {@link parseUtc}: returns the UTC microsecond count
 * for a valid ISO-like string even when `astimezone(UTC)` would overflow the
 * datetime range. `parseUtc` deliberately collapses that overflow to null;
 * callers that must distinguish overflow from malformed input use this.
 */
export function parseUtcUnchecked(value: unknown): bigint | null {
  try {
    return parseUtcDetailed(value);
  } catch {
    return null;
  }
}

/**
 * Parse-only companion that preserves Python's component-validation messages.
 * Malformed syntax returns null; a structurally valid value with an invalid
 * calendar/time component or offset raises {@link UtcParseError} carrying the
 * message `datetime.fromisoformat` would raise.
 */
export function parseUtcDetailed(value: unknown): bigint | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return parseIsoLike(value.replaceAll('Z', '+00:00'));
}

/**
 * `crq.parse_iso`: the strict legacy parser. Missing/empty values are null;
 * malformed values raise, exactly as Python's `strptime` does.
 */
export function parseIso(value: unknown): UtcInstant | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new UtcParseError('timestamp is not a string');
  const transformed = value.replaceAll('.000', '').slice(0, 20).replace(/Z+$/, '') + 'Z';
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})Z$/.exec(transformed);
  if (match === null) throw new UtcParseError(`time data '${transformed}' does not match format`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    throw new UtcParseError(`time data '${transformed}' does not match format`);
  }
  return new UtcInstant(
    BigInt(daysFromCivil(year, month, day)) * MICROS_PER_DAY +
      BigInt(hour) * 3_600n * MICROS_PER_SECOND +
      BigInt(minute) * 60n * MICROS_PER_SECOND +
      BigInt(second) * MICROS_PER_SECOND,
  );
}

/** The canonical `YYYY-MM-DDTHH:MM:SS.ffffffZ` spelling of an exact instant. */
export function formatUtcMicros(epochMicros: bigint): string {
  const days = floorDiv(epochMicros, MICROS_PER_DAY);
  let remainder = epochMicros - days * MICROS_PER_DAY;
  const { year, month, day } = civilFromDays(Number(days));
  const hour = Number(remainder / (3_600n * MICROS_PER_SECOND));
  remainder %= 3_600n * MICROS_PER_SECOND;
  const minute = Number(remainder / (60n * MICROS_PER_SECOND));
  remainder %= 60n * MICROS_PER_SECOND;
  const second = Number(remainder / MICROS_PER_SECOND);
  const microsecond = Number(remainder % MICROS_PER_SECOND);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(microsecond, 6)}Z`;
}

/** `YYYYMMDDTHHMMSSZ`, the run-id suffix Python builds with strftime. */
export function compactUtc(instant: Pick<UtcInstant, 'epochMicros'>): string {
  const iso = formatUtcMicros(instant.epochMicros);
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/** A UTC instant from a millisecond epoch, for Date-based callers. */
export function utcFromMillis(milliseconds: number): UtcInstant {
  return new UtcInstant(BigInt(Math.trunc(milliseconds)) * 1000n);
}

function parseIsoLike(text: string): bigint | null {
  const separator = findDateTimeSeparator(text);
  const dateText = separator === -1 ? text : text.slice(0, separator);
  const timeText =
    separator === -1 ? '' : text.slice(separator + (text.codePointAt(separator)! > 0xffff ? 2 : 1));
  if (separator !== -1 && timeText.length === 0) return null;
  const date = parseDate(dateText);
  if (date === null) return null;
  const time = parseTime(timeText);
  if (time === null) return null;
  const localMicros =
    BigInt(date.days + time.dayOffset) * MICROS_PER_DAY +
    BigInt(time.hour) * 3_600n * MICROS_PER_SECOND +
    BigInt(time.minute) * 60n * MICROS_PER_SECOND +
    BigInt(time.second) * MICROS_PER_SECOND +
    BigInt(time.microsecond);
  return localMicros - time.offsetMicros;
}

function findDateTimeSeparator(text: string): number {
  if (parseDate(text) !== null) return -1;
  // A date can have several valid prefix lengths (especially week dates).
  // Prefer the longest valid form, then consume one Unicode separator.
  for (let index = text.length - 1; index > 0; index -= 1) {
    if (parseDate(text.slice(0, index)) !== null) return index;
  }
  return -1;
}

function parseDate(text: string): { days: number } | null {
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match !== null) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    assertValidDate(year, month, day);
    return { days: daysFromCivil(year, month, day) };
  }
  match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match !== null) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    assertValidDate(year, month, day);
    return { days: daysFromCivil(year, month, day) };
  }
  match = /^(\d{4})-W(\d{2})(?:-(\d))?$/.exec(text);
  if (match !== null) {
    return isoWeekDate(Number(match[1]), Number(match[2]), Number(match[3] ?? '1'));
  }
  match = /^(\d{4})W(\d{2})(\d)?$/.exec(text);
  if (match !== null) {
    return isoWeekDate(Number(match[1]), Number(match[2]), Number(match[3] ?? '1'));
  }
  return null;
}

function isoWeekDate(year: number, week: number, weekday: number): { days: number } | null {
  if (week < 1 || week > isoWeeksInYear(year) || weekday < 1 || weekday > 7) return null;
  const januaryFourth = daysFromCivil(year, 1, 4);
  const januaryFourthWeekday = isoWeekday(januaryFourth);
  const mondayOfWeekOne = januaryFourth - (januaryFourthWeekday - 1);
  const days = mondayOfWeekOne + (week - 1) * 7 + (weekday - 1);
  return { days };
}

/** Number of ISO weeks in an ISO week-year (52 or 53). */
function isoWeeksInYear(year: number): number {
  // An ISO year has 53 weeks when January 1 is a Thursday, or when it is a
  // leap year and January 1 is a Wednesday.
  const januaryFirst = isoWeekday(daysFromCivil(year, 1, 1));
  return januaryFirst === 4 || (isLeapYear(year) && januaryFirst === 3) ? 53 : 52;
}

function isoWeekday(days: number): number {
  // 1970-01-01 was a Thursday (4).
  return mod(days + 3, 7) + 1;
}

interface ParsedTime {
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
  dayOffset: number;
  offsetMicros: bigint;
}

function parseTime(text: string): ParsedTime | null {
  if (text === '') {
    return { hour: 0, minute: 0, second: 0, microsecond: 0, dayOffset: 0, offsetMicros: 0n };
  }
  const offsetStart = findOffsetStart(text);
  const clockText = offsetStart === -1 ? text : text.slice(0, offsetStart);
  const offsetText = offsetStart === -1 ? '' : text.slice(offsetStart);
  const clock = parseClock(clockText);
  if (clock === null) return null;
  const offset = parseOffset(offsetText);
  if (offset === null) return null;
  return { ...clock, offsetMicros: offset };
}

function findOffsetStart(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '+' || character === '-') return index;
  }
  return -1;
}

function parseClock(text: string): Omit<ParsedTime, 'offsetMicros'> | null {
  let match = /^(\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?$/.exec(text);
  if (match === null) match = /^(\d{2})(\d{2})(?:(\d{2})(?:[.,](\d+))?)?$/.exec(text);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  const second = Number(match[3] ?? '0');
  const microsecond = parseFraction(match[4]);
  if (hour === 24) {
    if (minute !== 0 || second !== 0 || microsecond !== 0) {
      throw new UtcParseError('minute, second, and microsecond must be 0 when hour is 24');
    }
    return { hour: 0, minute: 0, second: 0, microsecond: 0, dayOffset: 1 };
  }
  if (hour > 23) throw new UtcParseError(`hour must be in 0..23, not ${hour}`);
  if (minute > 59) throw new UtcParseError(`minute must be in 0..59, not ${minute}`);
  if (second > 59) throw new UtcParseError(`second must be in 0..59, not ${second}`);
  return { hour, minute, second, microsecond, dayOffset: 0 };
}

function parseOffset(text: string): bigint | null {
  if (text === '') return 0n;
  const match = /^([+-])(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?$/.exec(text);
  if (match === null) return null;
  const sign = match[1] === '-' ? -1n : 1n;
  const hours = BigInt(match[2] as string);
  const minutes = BigInt(match[3] ?? '0');
  const seconds = BigInt(match[4] ?? '0');
  const micros = BigInt(parseFraction(match[5]));
  const wholeSeconds = hours * 3_600n + minutes * 60n + seconds;
  // Python 3.14.10+ returns UTC only when both the whole-second offset and its
  // microseconds are zero; `+00:00:00.5` is a real 0.5-second offset.
  const total = wholeSeconds * MICROS_PER_SECOND + micros;
  // Python's timezone() requires strictly between -24h and +24h. It normalises
  // overflowing minutes/seconds (for example +10:60 -> +11:00).
  if (total >= 24n * 3_600n * MICROS_PER_SECOND) {
    throw new UtcParseError(
      'offset must be a timedelta strictly between -timedelta(hours=24) and ' +
        `timedelta(hours=24), not ${pythonTimedeltaRepr(sign * total)}`,
    );
  }
  return sign * total;
}

function pythonTimedeltaRepr(micros: bigint): string {
  const day = 86_400n * MICROS_PER_SECOND;
  const days = floorDiv(micros, day);
  const remainder = micros - days * day;
  const seconds = remainder / MICROS_PER_SECOND;
  const fraction = remainder % MICROS_PER_SECOND;
  const parts: string[] = [];
  if (days !== 0n) parts.push(`days=${days}`);
  if (seconds !== 0n) parts.push(`seconds=${seconds}`);
  if (fraction !== 0n) parts.push(`microseconds=${fraction}`);
  return parts.length === 0 ? 'datetime.timedelta(0)' : `datetime.timedelta(${parts.join(', ')})`;
}

function parseFraction(digits: string | undefined): number {
  if (digits === undefined) return 0;
  return Number((digits + '000000').slice(0, 6));
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function assertValidDate(year: number, month: number, day: number): void {
  if (year < 1 || year > 9999) {
    throw new UtcParseError(`year must be in 1..9999, not ${year}`);
  }
  if (month < 1 || month > 12) {
    throw new UtcParseError(`month must be in 1..12, not ${month}`);
  }
  const lastDay = daysInMonth(year, month);
  if (day < 1 || day > lastDay) {
    throw new UtcParseError(
      `day ${day} must be in range 1..${lastDay} for month ${month} in year ${year}`,
    );
  }
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Days since 1970-01-01 in the proleptic Gregorian calendar. */
export function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** Inverse of {@link daysFromCivil}. */
export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const shifted = days + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  return { year: year + (month <= 2 ? 1 : 0), month, day };
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value % divisor !== 0n && value < 0n !== divisor < 0n ? quotient - 1n : quotient;
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Milliseconds in a UTC day; exported for scheduling code in later phases. */
export { MS_PER_DAY };
