import { describe, expect, test } from 'vitest';
import {
  compactUtc,
  parseIso,
  parseUtc,
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
  });
});
