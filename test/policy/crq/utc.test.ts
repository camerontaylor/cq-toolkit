import { describe, expect, test } from 'vitest';
import {
  compactUtc,
  parseIso,
  parseUtc,
  parseUtcDetailed,
  parseUtcUnchecked,
  UtcParseError,
  utcFromMillis,
} from '../../../src/policy/crq/utc.js';

describe('parseUtc — queue_time.parse_utc parity', () => {
  test.each([
    ['2026-11-08T00:00:00Z', '2026-11-08T00:00:00.000000Z'],
    ['2026-11-08T00:00:00.500Z', '2026-11-08T00:00:00.500000Z'],
    ['2026-11-08T10:00:00.500+10:00', '2026-11-08T00:00:00.500000Z'],
    ['2026-11-08T00:00:00.500', '2026-11-08T00:00:00.500000Z'],
    ['20261108T000000.500Z', '2026-11-08T00:00:00.500000Z'],
    ['2026-11-07T19:00:00-05:00', '2026-11-08T00:00:00.000000Z'],
    ['2026-11-08T00:00:00.123456Z', '2026-11-08T00:00:00.123456Z'],
    ['2026-11-08T00:00:00.1234567Z', '2026-11-08T00:00:00.123456Z'],
    ['2026-11-08T00:00:00,5Z', '2026-11-08T00:00:00.500000Z'],
    ['2026-11-08T00', '2026-11-08T00:00:00.000000Z'],
    ['2026-11-08T00:00', '2026-11-08T00:00:00.000000Z'],
    ['2026-11-08T0000', '2026-11-08T00:00:00.000000Z'],
    ['2026-11-08 00:00:00Z', '2026-11-08T00:00:00.000000Z'],
    ['2026-11-08t00:00:00Z', '2026-11-08T00:00:00.000000Z'],
    ['20261108', '2026-11-08T00:00:00.000000Z'],
    ['2026-W45-1', '2026-11-02T00:00:00.000000Z'],
    ['2026W451', '2026-11-02T00:00:00.000000Z'],
    ['2026-W01-1', '2025-12-29T00:00:00.000000Z'],
    ['2026-11-08T24:00:00Z', '2026-11-09T00:00:00.000000Z'],
    ['2026-11-08T00:00:00+10:00:30', '2026-11-07T13:59:30.000000Z'],
    ['2026-11-08T00:00:00+10:60', '2026-11-07T13:00:00.000000Z'],
    ['2026-11-08T00:00:00-00:00', '2026-11-08T00:00:00.000000Z'],
  ])('%s -> %s', (value, expected) => {
    expect(parseUtc(value)?.iso).toBe(expected);
  });

  test.each([
    123,
    '',
    'garbage',
    '2026-13-08T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-11-08T23:59:60Z',
    '2026-11-08T00:00:00z',
    ' 2026-11-08T00:00:00Z',
    '2026-11-08T00:00:00Z ',
    '0001-01-01T00:00:00+10:00',
    '9999-12-31T23:59:59-10:00',
    '2026-11-08T00:00:00+24:00',
    '2026-W00-1',
    '2026-W45-8',
    '2025-W53-1',
  ])('refuses %s', (value) => {
    expect(parseUtc(value)).toBeNull();
  });

  test('24:00 with a fraction or non-zero minute is refused', () => {
    expect(parseUtc('2026-11-08T24:00:00.5Z')).toBeNull();
    expect(parseUtc('2026-11-08T24:00:01Z')).toBeNull();
  });

  test('ISO week 53 is accepted only when that week exists', () => {
    expect(parseUtc('2026-W53-1')?.iso).toBe('2026-12-28T00:00:00.000000Z');
    expect(parseUtc('2026-W53-7')?.iso).toBe('2027-01-03T00:00:00.000000Z');
    expect(parseUtc('2025-W53-1')).toBeNull();
  });
});

describe('parseIso — crq.parse_iso quirks', () => {
  test.each([
    ['2026-11-08T00:00:00Z', '2026-11-08T00:00:00.000000Z'],
    ['2026-11-08T00:00:00.000Z', '2026-11-08T00:00:00.000000Z'],
    ['2026-1-8T0:0:0Z', '2026-01-08T00:00:00.000000Z'],
    ['2026-01-08T00:00:00ZZ', '2026-01-08T00:00:00.000000Z'],
    ['2026-01-08T00:00:00Zextra', '2026-01-08T00:00:00.000000Z'],
    ['2026-11-15t12:00:00Z', '2026-11-15T12:00:00.000000Z'],
    ['2026-01-08T00:00:00.000Zextra', '2026-01-08T00:00:00.000000Z'],
  ])('%s -> %s', (value, expected) => {
    expect(parseIso(value)?.iso).toBe(expected);
  });

  test.each([
    '2026-11-08T00:00:00.500Z',
    '2026-11-08T00:00:00.000000Z',
    '2026-11-08T10:00:00+10:00',
    '2026-11-08',
    '26-01-08T00:00:00Z',
    '02026-01-08T00:00:00Z',
    ' 2026-01-08T00:00:00Z',
    '2026-01-08T00:00:00z',
  ])('raises for %s', (value) => {
    expect(() => parseIso(value)).toThrow(UtcParseError);
  });

  test('null and empty mean null; non-string raises', () => {
    expect(parseIso(null)).toBeNull();
    expect(parseIso('')).toBeNull();
    expect(() => parseIso(123)).toThrow(UtcParseError);
  });
});

describe('formatting and ids', () => {
  test('compactUtc drops microseconds, like strftime("%Y%m%dT%H%M%SZ")', () => {
    expect(compactUtc(parseUtc('2026-11-08T12:34:56.987654Z')!)).toBe('20261108T123456Z');
  });

  test('millisecond conversion floors negative epochs', () => {
    expect(utcFromMillis(-1).iso).toBe('1969-12-31T23:59:59.999000Z');
    expect(parseUtc('1969-12-31T23:59:59.999Z')?.epochMillis()).toBe(-1);
  });

  test('date round trip keeps microseconds and UTC text', () => {
    const instant = parseUtc('2026-11-08T00:00:00.123456Z')!;
    expect(instant.epochMillis()).toBe(Date.UTC(2026, 10, 8, 0, 0, 0, 123));
    expect(instant.toDate().toISOString()).toBe('2026-11-08T00:00:00.123Z');
  });
});

test('accepts arbitrary single separators but refuses a missing time', () => {
  for (const value of ['2026-11-08X12:34:56', '20261108X123456', '2026-W45-7X12:34:56']) {
    expect(parseUtc(value)?.iso).toBe('2026-11-08T12:34:56.000000Z');
  }
  expect(parseUtc('2026-11-08T')).toBeNull();
  expect(parseUtc('2026-11-08')?.iso).toBe('2026-11-08T00:00:00.000000Z');
});

describe('parseUtcUnchecked — parse-only companion', () => {
  test('keeps a valid UTC instant', () => {
    expect(parseUtcUnchecked('2026-11-08T00:00:00Z')).toBe(
      parseUtc('2026-11-08T00:00:00Z')?.epochMicros,
    );
  });

  test('exposes the instant that parseUtc collapses to null on overflow', () => {
    expect(parseUtc('9999-12-31T23:00:00-05:00')).toBeNull();
    expect(parseUtcUnchecked('9999-12-31T23:00:00-05:00')).not.toBeNull();
    expect(parseUtc('0001-01-01T00:00:00+01:00')).toBeNull();
    expect(parseUtcUnchecked('0001-01-01T00:00:00+01:00')).not.toBeNull();
  });

  test('still returns null for malformed or empty input', () => {
    expect(parseUtcUnchecked('junk')).toBeNull();
    expect(parseUtcUnchecked('')).toBeNull();
    expect(parseUtcUnchecked(123)).toBeNull();
    expect(parseUtcUnchecked('2026-13-01T00:00:00Z')).toBeNull();
  });
});

describe('parseUtcDetailed — component-validation messages', () => {
  test('applies a zero-second fractional offset', () => {
    const base = parseUtc('2026-11-08T00:00:00Z')?.epochMicros;
    expect(parseUtcDetailed('2026-11-08T00:00:00+00:00:00.5')).toBe((base as bigint) - 500_000n);
    expect(parseUtcDetailed('2026-11-08T00:00:00-00:00:00.5')).toBe((base as bigint) + 500_000n);
  });

  test('keeps Python calendar and clock messages', () => {
    expect(() => parseUtcDetailed('2026-13-01T00:00:00Z')).toThrow(
      'month must be in 1..12, not 13',
    );
    expect(() => parseUtcDetailed('2026-02-30T00:00:00Z')).toThrow(
      'day 30 must be in range 1..28 for month 2 in year 2026',
    );
    expect(() => parseUtcDetailed('2026-01-01T25:00:00Z')).toThrow('hour must be in 0..23, not 25');
    expect(() => parseUtcDetailed('2026-01-01T00:60:00Z')).toThrow(
      'minute must be in 0..59, not 60',
    );
    expect(() => parseUtcDetailed('2026-01-01T00:00:60Z')).toThrow(
      'second must be in 0..59, not 60',
    );
    expect(() => parseUtcDetailed('0000-01-01T00:00:00Z')).toThrow(
      'year must be in 1..9999, not 0',
    );
  });

  test('keeps the offset-range message', () => {
    expect(() => parseUtcDetailed('2026-01-01T00:00:00+25:00')).toThrow(
      'offset must be a timedelta strictly between -timedelta(hours=24) and ' +
        'timedelta(hours=24), not datetime.timedelta(days=1, seconds=3600)',
    );
  });

  test('returns null for malformed syntax', () => {
    expect(parseUtcDetailed('junk')).toBeNull();
    expect(parseUtcDetailed('')).toBeNull();
    expect(parseUtcDetailed(123)).toBeNull();
  });

  test.each([
    ['2025-W01-12:00', '2024-12-30T12:00:00.000000Z'],
    ['2020-W01-123000', '2019-12-30T12:30:00.000000Z'],
    ['2020W01123', '2019-12-30T23:00:00.000000Z'],
    ['2020-W01-1T12', '2019-12-30T12:00:00.000000Z'],
    ['2020W01T12', '2019-12-30T12:00:00.000000Z'],
  ])("week-date separator follows CPython's fixed-position rule: %s", (value, expected) => {
    expect(parseUtc(value)?.iso).toBe(expected);
  });
});

describe('year-10000 rollover and mixed-separator offsets (CPython 3.14 pinned)', () => {
  // Verified against python3.14 and python3.15 `datetime.fromisoformat`.
  const YEAR_10000 = 'year must be in 1..9999, not 10000';

  test.each([
    '9999-12-31T24:00:00+00:00',
    '9999-12-31T24:00:00Z',
    '9999-12-31T24:00:00',
    '9999-12-31T24:00:00-23:59',
    '9999-12-31T24Z',
    '9999-12-31T2400Z',
    '99991231T240000Z',
    '9999-W52-5T24:00:00Z',
    '9999-W52-6T00:00:00Z',
  ])('%s is a ValueError, not an overflow, in every wrapper', (value) => {
    expect(() => parseUtcDetailed(value)).toThrow(YEAR_10000);
    expect(parseUtc(value)).toBeNull();
    expect(parseUtcUnchecked(value)).toBeNull();
  });

  test('the year error follows offset and 24:00 validation, as in CPython', () => {
    expect(() => parseUtcDetailed('9999-12-31T24:00:00+25:00')).toThrow('offset must be');
    expect(() => parseUtcDetailed('9999-12-31T24:00:01+00:00')).toThrow(
      'minute, second, and microsecond must be 0 when hour is 24',
    );
    expect(parseUtcDetailed('9999-12-31T24:00:00+01:0203')).toBeNull();
  });

  test('the last representable instants and the 24:00 on the day before still parse', () => {
    expect(parseUtcDetailed('9999-12-31T23:59:59Z')).toBe(253402300799000000n);
    expect(parseUtcDetailed('9999-12-31T23:59:59.999999Z')).toBe(253402300799999999n);
    expect(parseUtcDetailed('9999-12-30T24:00:00Z')).toBe(253402214400000000n);
    expect(parseUtc('9999-12-30T24:00:00Z')?.iso).toBe('9999-12-31T00:00:00.000000Z');
  });

  test.each([
    '2026-01-01T00:00:00+01:0203',
    '2026-01-01T00:00:00+0102:03',
    '2026-01-01T00:00:00-01:0203',
    '2026-01-01T00:00:00-0102:03',
    '2026-01-01T00:00:00+01:0203.5',
    '2026-01-01T00:00:00+0102:03.5',
    '2026-01-01T00:00:00+0102:03,5',
    '2026-01-01T00:00:00+0102:0',
  ])('mixed-separator offset %s is malformed (null), never an instant', (value) => {
    expect(parseUtcDetailed(value)).toBeNull();
    expect(parseUtc(value)).toBeNull();
    expect(parseUtcUnchecked(value)).toBeNull();
  });

  test.each([
    ['2026-01-01T00:00:00+01:02:03', 1767221877000000n],
    ['2026-01-01T00:00:00+010203', 1767221877000000n],
    ['2026-01-01T00:00:00+01:02', 1767221880000000n],
    ['2026-01-01T00:00:00+0102', 1767221880000000n],
    ['2026-01-01T00:00:00+01', 1767222000000000n],
    ['2026-01-01T00:00:00-01:02:03.5', 1767229323500000n],
  ])('consistent-separator offset %s still parses', (value, micros) => {
    expect(parseUtcDetailed(value)).toBe(micros);
  });
});

describe('compact bare fractions (CPython 3.14 pinned)', () => {
  // `parse_hh_mm_ss_ff` reads digits after compact `hhmmss` as microseconds with no
  // `.`/`,`. Expected values are `datetime.fromisoformat` on python3.14. Offsets use
  // non-zero whole seconds, where 3.14.4 and >= 3.14.7 agree.
  test.each([
    ['2026-01-01T00:00:00+000003123456', 1767225596876544n],
    ['2026-01-01T00:00:00-000003123456', 1767225603123456n],
    ['2026-01-01T00:00:00+0000123456', 1767225587654400n],
    ['2026-01-01T00:00:00+00:00:03.123456', 1767225596876544n],
    ['2026-01-01T12345678Z', 1767270896780000n],
    ['2026-01-01T123456789Z', 1767270896789000n],
    ['2026-01-01T12345678', 1767270896780000n],
    ['2026-01-01T120000123456789+01:00', 1767265200123456n],
    ['20260101T12000050Z', 1767268800500000n],
  ])('%s parses with the bare fraction as microseconds', (value, micros) => {
    expect(parseUtcDetailed(value)).toBe(micros);
    expect(parseUtcUnchecked(value)).toBe(micros);
    expect(parseUtc(value)?.epochMicros).toBe(micros);
  });

  test.each([
    // A single digit after hhmmss is not a fraction (naive clocks and offsets).
    '2026-01-01T1200005',
    '2026-01-01T00:00:00+0000035',
    '2026-01-01T00:00:00-0000035',
    // The colon style is fixed at the first component, so no bare fraction follows it.
    '2026-01-01T00:00:00+00:00:0312',
    '2026-01-01T12:00:0050',
    // Mixed separators from #2330 stay malformed.
    '2026-01-01T00:00:00+01:0203',
    '2026-01-01T00:00:00+0102:03',
    // A fraction needs hhmmss first.
    '2026-01-01T1200123',
  ])('%s stays malformed (null)', (value) => {
    expect(parseUtcDetailed(value)).toBeNull();
    expect(parseUtc(value)).toBeNull();
    expect(parseUtcUnchecked(value)).toBeNull();
  });

  test('component validation still wins over a bare fraction', () => {
    expect(() => parseUtcDetailed('2026-01-01T12009900Z')).toThrow('second must be in 0..59');
    expect(() => parseUtcDetailed('2026-01-01T00:00:00+240000123456')).toThrow('offset must be');
  });
});
