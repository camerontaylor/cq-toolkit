import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  JsonNumber,
  JsonObject,
  JsonParseError,
  JsonValueError,
  comparePythonNumbers,
  parseJsonValue,
  pythonNumbersEqual,
  toPlainJson,
  toPlainJsonRetainingNumbers,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  atomicJsonText,
  compareCodePoints,
  encodePythonString,
  ledgerJsonDigest,
  ledgerJsonText,
  pythonFloatRepr,
  pythonJsonText,
  receiptJsonBytes,
  receiptJsonDigest,
  receiptJsonText,
} from '../../../src/policy/crq/pythonJson.js';

describe('lossless JSON values', () => {
  test('keeps int-vs-float and exact large integers from the source text', () => {
    const values = parseJsonValue('[1, 1.0, 1e2, -0, 9007199254740993]') as JsonValue[];
    expect(values[0]).toBeInstanceOf(JsonNumber);
    expect((values[0] as JsonNumber).kind).toBe('int');
    expect((values[1] as JsonNumber).kind).toBe('float');
    expect((values[2] as JsonNumber).kind).toBe('float');
    expect((values[3] as JsonNumber).integer).toBe(0n);
    expect((values[4] as JsonNumber).integer).toBe(9007199254740993n);
    expect(toPlainJson(values[4] as JsonNumber)).toBe(9007199254740992);
    expect(toPlainJson(values[4] as JsonNumber, { bigints: true })).toBe(9007199254740993n);
  });

  test('keeps object source order, including integer-like keys', () => {
    const object = parseJsonValue('{"10":1,"2":2,"a":3}') as JsonObject;
    expect(object.entries.map(([key]) => key)).toEqual(['10', '2', 'a']);
  });

  test('materialises containers without rounding or erasing Python numeric types', () => {
    const document = parseJsonValue(
      '{"a":1,"b":1.0,"c":9007199254740993,"d":[2,2.5],"e":{"f":-0.0}}',
    );
    const value = toPlainJsonRetainingNumbers(document) as {
      a: JsonNumber;
      b: JsonNumber;
      c: JsonNumber;
      d: [JsonNumber, JsonNumber];
      e: { f: JsonNumber };
    };
    expect(value.a.kind).toBe('int');
    expect(value.b.kind).toBe('float');
    expect(value.c.integer).toBe(9007199254740993n);
    expect(value.d[0].kind).toBe('int');
    expect(value.d[1].float).toBe(2.5);
    expect(Object.is(value.e.f.float, -0)).toBe(true);
    expect(toPlainJson(document)).toMatchObject({ c: 9007199254740992 });
  });

  test('retaining materialisation keeps __proto__ as an own property', () => {
    const document = parseJsonValue('{"__proto__":{"polluted":true},"x":1}');
    const value = toPlainJsonRetainingNumbers(document) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test('compares Python numbers exactly, including int-vs-float and adjacent bigints', () => {
    expect(pythonNumbersEqual(JsonNumber.int(1), JsonNumber.float(1))).toBe(true);
    expect(pythonNumbersEqual(true, JsonNumber.int(1))).toBe(true);
    expect(pythonNumbersEqual(false, JsonNumber.float(0))).toBe(true);
    expect(pythonNumbersEqual(JsonNumber.float(-0), JsonNumber.int(0))).toBe(true);
    expect(pythonNumbersEqual(JsonNumber.float(0.1), JsonNumber.float(0.1))).toBe(true);
    expect(
      pythonNumbersEqual(JsonNumber.int(9007199254740992n), JsonNumber.int(9007199254740993n)),
    ).toBe(false);
    expect(
      comparePythonNumbers(JsonNumber.int(9007199254740993n), JsonNumber.float(9007199254740992)),
    ).toBe(1);
    expect(
      comparePythonNumbers(JsonNumber.int(9007199254740992n), JsonNumber.float(9007199254740992)),
    ).toBe(0);
    expect(
      comparePythonNumbers(JsonNumber.float(Infinity), JsonNumber.int(9007199254740993n)),
    ).toBe(1);
    expect(
      comparePythonNumbers(JsonNumber.float(-Infinity), JsonNumber.int(-9007199254740993n)),
    ).toBe(-1);
    expect(pythonNumbersEqual(JsonNumber.float(Number.NaN), JsonNumber.float(Number.NaN))).toBe(
      false,
    );
    expect(comparePythonNumbers(JsonNumber.float(Number.NaN), JsonNumber.int(1))).toBe(0);
    expect(pythonNumbersEqual(JsonNumber.int(1), '1')).toBeNull();
    expect(comparePythonNumbers(JsonNumber.int(1), null)).toBeNull();
    expect(comparePythonNumbers(9007199254740993n, 9007199254740992)).toBe(1);
    expect(pythonNumbersEqual(JsonNumber.int(10n ** 21n), JsonNumber.float(1e21))).toBe(true);
    expect(pythonNumbersEqual(JsonNumber.int(10n ** 21n + 1n), JsonNumber.float(1e21))).toBe(false);
    expect(comparePythonNumbers(JsonNumber.int(2n ** 70n + 1n), JsonNumber.float(2 ** 70))).toBe(1);
  });

  test('duplicate keys follow json.loads (last value, first position) or refuse', () => {
    const last = parseJsonValue('{"a":1,"b":2,"a":3}') as JsonObject;
    expect(last.entries).toEqual([
      ['a', expect.any(JsonNumber)],
      ['b', expect.any(JsonNumber)],
    ]);
    expect((last.get('a') as JsonNumber).integer).toBe(3n);
    expect(() => parseJsonValue('{"a":1,"a":2}', { duplicates: 'error' })).toThrow(JsonParseError);
  });

  test('rejects non-JSON grammar and unescaped controls', () => {
    for (const source of [
      '{"a":1,}',
      '[01]',
      '01',
      '{"a":.5}',
      '{"a":1.}',
      '{"a":NaN}',
      '{"a":"\u0001"}',
      '{"a":"\\x"}',
      '{"a":1} trailing',
      '',
    ]) {
      expect(() => parseJsonValue(source), source).toThrow(JsonParseError);
    }
  });

  test('parses surrogate escapes without combining them', () => {
    const object = parseJsonValue('{"high":"\\ud800","pair":"\\ud83d\\ude00"}') as JsonObject;
    expect(object.get('high')).toBe('\ud800');
    expect(object.get('pair')).toBe('😀');
  });

  test('JsonNumber constructors refuse unsafe or malformed integers', () => {
    expect(() => JsonNumber.int(Number.MAX_SAFE_INTEGER + 1)).toThrow(JsonValueError);
    expect(() => JsonNumber.int('01')).toThrow(JsonValueError);
    expect(JsonNumber.int('9007199254740993').integer).toBe(9007199254740993n);
  });
});

describe('pythonFloatRepr', () => {
  test.each([
    [1, '1.0'],
    [0.1, '0.1'],
    [-0, '-0.0'],
    [1e20, '1e+20'],
    [1e16, '1e+16'],
    [1e15, '1000000000000000.0'],
    [1e-4, '0.0001'],
    [1e-5, '1e-05'],
    [5e-324, '5e-324'],
    [1.7976931348623157e308, '1.7976931348623157e+308'],
    [1.2345678901234568e17, '1.2345678901234568e+17'],
    [42, '42.0'],
    [NaN, 'NaN'],
    [Infinity, 'Infinity'],
    [-Infinity, '-Infinity'],
  ])('%s -> %s', (value, expected) => {
    expect(pythonFloatRepr(value)).toBe(expected);
  });
});

describe('pythonJson — receipt canonical (ASCII, code-point sort)', () => {
  test('sorts keys and writes scalars compactly', () => {
    const value = parseJsonValue('{"b":1,"a":[true,false,null],"c":{"z":"x","y":2}}');
    expect(receiptJsonText(value)).toBe('{"a":[true,false,null],"b":1,"c":{"y":2,"z":"x"}}');
    expect(receiptJsonDigest(value)).toBe(
      '9f8827db93e70a0bffa3ff231631ba670ad838f7f71cd4e4a5e0d3ceeaf2a363',
    );
  });

  test('escapes every non-ASCII code unit, including astral pairs and lone surrogates', () => {
    expect(receiptJsonText({ unicode: '雪', emoji: '😀' })).toBe(
      '{"emoji":"\\ud83d\\ude00","unicode":"\\u96ea"}',
    );
    expect(receiptJsonText({ value: '\ud800' })).toBe('{"value":"\\ud800"}');
    expect(receiptJsonText({ control: '\u007f' })).toBe('{"control":"\\u007f"}');
    expect(receiptJsonText({ text: 'quote" backslash\\ newline\n tab\t' })).toBe(
      '{"text":"quote\\" backslash\\\\ newline\\n tab\\t"}',
    );
  });

  test('sorts keys by Unicode code point, not UTF-16 code unit', () => {
    // U+FFFF (65535) sorts before U+10000 (65536), although the astral
    // character's first UTF-16 unit (0xD800) is numerically smaller.
    expect(receiptJsonText({ '\uffff': 1, '\u{10000}': 2, a: 3 })).toBe(
      '{"a":3,"\\uffff":1,"\\ud800\\udc00":2}',
    );
    expect(compareCodePoints('\u{10000}', '\uffff')).toBeGreaterThan(0);
  });

  test('writes Python ints in full and preserves float repr', () => {
    expect(
      receiptJsonText({ safe: 9007199254740991, unsafe: 9007199254740993n, wide: 2n ** 63n }),
    ).toBe('{"safe":9007199254740991,"unsafe":9007199254740993,"wide":9223372036854775808}');
    expect(
      receiptJsonText({ float: JsonNumber.float(1), small: 0.1, negative: JsonNumber.float(-0) }),
    ).toBe('{"float":1.0,"negative":-0.0,"small":0.1}');
  });

  test('does not silently round an unsafe plain JS number', () => {
    expect(() => receiptJsonText({ value: Number.MAX_SAFE_INTEGER + 2 })).toThrow(
      /unsafe JavaScript number/,
    );
    expect(receiptJsonText({ value: JsonNumber.int('9007199254740993') })).toBe(
      '{"value":9007199254740993}',
    );
  });
});

describe('pythonJson — ledger canonical (UTF-8, UTF-16BE key sort)', () => {
  test('stays UTF-8 and escapes controls', () => {
    expect(ledgerJsonText({ unicode: '雪', emoji: '😀', control: '\u0001' })).toBe(
      '{"control":"\\u0001","emoji":"😀","unicode":"雪"}',
    );
  });

  test('sorts keys by UTF-16BE bytes (astral before U+FFFF)', () => {
    expect(ledgerJsonText({ '\uffff': 1, '\u{10000}': 2, a: 3, é: 4 })).toBe(
      '{"a":3,"é":4,"𐀀":2,"\uffff":1}',
    );
  });

  test('refuses floats, out-of-range integers and non-scalar Unicode', () => {
    expect(() => ledgerJsonText({ bad: 1.5 })).toThrow(/unsupported canonical JSON value/);
    expect(() => ledgerJsonText({ bad: JsonNumber.float(1) })).toThrow(
      /unsupported canonical JSON value/,
    );
    expect(() => ledgerJsonText({ bad: 9007199254740992n })).toThrow(
      /integer outside interoperable JSON range/,
    );
    expect(() => ledgerJsonText({ bad: '\udfff' })).toThrow(/non-scalar Unicode/);
    expect(ledgerJsonText({ maximum: 9007199254740991n, minimum: -9007199254740991n })).toBe(
      '{"maximum":9007199254740991,"minimum":-9007199254740991}',
    );
  });

  test('digest matches the Python ledger oracle', () => {
    expect(ledgerJsonDigest({ b: 1, a: [true, false, null] })).toBe(
      '087e44ed138472a81a4a0f8ae84e8f358d0d957d27f51123952aa88c007b1f9f',
    );
  });
});

describe('pythonJson — atomic queue bytes', () => {
  test('matches json.dump(indent=2) plus one newline', () => {
    const text = atomicJsonText({ z: 1, a: 2, m: { b: 1, a: 2 } });
    expect(text).toBe('{\n  "z": 1,\n  "a": 2,\n  "m": {\n    "b": 1,\n    "a": 2\n  }\n}\n');
  });

  test('keeps Python insertion order for integer-like keys', () => {
    expect(atomicJsonText(parseJsonValue('{"10":1,"2":2}'))).toBe('{\n  "10": 1,\n  "2": 2\n}\n');
  });

  test('uses ASCII escaping and Python float/int text', () => {
    expect(atomicJsonText({ emoji: '😀', float: JsonNumber.float(1), wide: 2n ** 63n })).toBe(
      '{\n  "emoji": "\\ud83d\\ude00",\n  "float": 1.0,\n  "wide": 9223372036854775808\n}\n',
    );
    expect(atomicJsonText({})).toBe('{}\n');
  });

  test('round-trips its own text byte-for-byte through the lossless parser', () => {
    const value = parseJsonValue('{"a":1,"b":[2,3],"c":{"d":"雪"}}');
    const text = atomicJsonText(value);
    expect(atomicJsonText(parseJsonValue(text))).toBe(text);
  });
});

test('encodePythonString is shared by both canonical domains', () => {
  expect(encodePythonString('雪', true, false)).toBe('"\\u96ea"');
  expect(encodePythonString('雪', false, true)).toBe('"雪"');
  expect(() => encodePythonString('\ud800', false, true)).toThrow(/non-scalar/);
  expect(encodePythonString('\ud800', true, false)).toBe('"\\ud800"');
});

test('pythonJsonText generic options match the wrappers', () => {
  expect(
    pythonJsonText({ b: 1, a: 2 }, { asciiOnly: true, sortKeys: true, keyOrder: 'code-point' }),
  ).toBe('{"a":2,"b":1}');
  expect(receiptJsonBytes({ b: 1, a: 2 })).toEqual(Buffer.from('{"a":2,"b":1}', 'ascii'));
});

// The fixture directory is read-only; it proves the module does not depend on
// an in-memory reconstruction of the checked-in vectors.
test('the phase 0.3 queue-bytes oracle is readable without JSON.parse', () => {
  const raw = readFileSync(
    new URL('../../../apps/crq-python/fixtures/group-p/queue-bytes.json', import.meta.url),
    'utf8',
  );
  const family = parseJsonValue(raw) as JsonObject;
  expect(family.get('family') as string).toBe('queue-bytes');
});

test('rejects sparse arrays in every encoder and preserves float lexemes', () => {
  for (const encode of [receiptJsonText, ledgerJsonText, atomicJsonText]) {
    expect(() => encode(new Array(1))).toThrow('sparse arrays');
    const sparse = [1, 2, 3];
    delete sparse[1];
    expect(() => encode(sparse)).toThrow('sparse arrays');
  }
  for (const raw of ['1.2300e+02', '-0.00', '1E-3']) {
    expect((parseJsonValue(raw) as JsonNumber).raw).toBe(raw);
  }
});
