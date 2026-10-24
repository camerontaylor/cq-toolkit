// S0 — #386: numeric flag values whose raw text is not the canonical
// decimal form of their Number stay raw STRINGS, so hex cluster ids made
// only of digits and one 'e' (`1e000005`, `0e123456`, `123e4567`) — and
// leading-zero ids — round-trip through `analyze.fix --clusterId=…`
// (schema `z.string().min(1)`). Canonical = `String(Number(raw)) === raw`
// (exactly what JS's own number→string conversion prints back): '2' → 2,
// while '1e5' (prints '100000'), '2e5', leading zeros, '1.50', '+1',
// '0x10' and every non-finite text are kept as the token the user typed.
// Hermetic: the echo fixture family (test/fixtures/cli-ops) over the real
// dispatcher; no network, no provider, tmp dirs only.
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parseFlags, runCli } from '../../src/cli/main.js';
import type { CliIo } from '../../src/cli/output.js';

const fixtureOps = fileURLToPath(new URL('../fixtures/cli-ops/', import.meta.url));

/** The value parseFlags assigns one `--key=<raw>` token. */
function parsedValue(raw: string): unknown {
  const { flags } = parseFlags([`--key=${raw}`]);
  return flags['key'];
}

async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { stdout: (c) => out.push(c), stderr: (c) => err.push(c) };
  const code = await runCli(argv, io, { opsRoot: fixtureOps });
  return { code, out: out.join(''), err: err.join('') };
}

describe('canonical-decimal fast path: still numbers', () => {
  test.each([
    ['2', 2], // --maxUsd=2
    ['3', 3], // --concurrency=3
    ['0', 0],
    ['-2', -2],
    ['-2.5', -2.5],
    ['0.5', 0.5],
    ['10', 10],
    ['100000000', 100000000], // plain integer below 1e21
  ])('%s → number', (raw, expected) => {
    expect(parsedValue(raw)).toBe(expected);
  });

  test.each([
    ['true', true],
    ['false', false],
    ['null', null],
    ['"text"', 'text'], // an explicit JSON string parses as a string (the #386 workaround)
    ['["a"]', ['a']],
    ['{"k":1}', { k: 1 }],
  ])('%s → JSON value unchanged', (raw, expected) => {
    expect(parsedValue(raw)).toEqual(expected);
  });
});

describe('#386: non-canonical numeric-looking tokens stay raw strings', () => {
  test.each([
    // The hex-cluster-id family from the issue: digits + one 'e'.
    '1e000005',
    '0e123456',
    '123e4567',
    // Leading zeros (8-hex ids can start with 0).
    '01',
    '01234567',
    '007',
    // Exponent/point forms JS would renumber.
    '1e5', // → '100000'
    '2e5',
    '1E5',
    '1.50', // → '1.5'
    '1.', // → '1'
    '.5', // → '0.5'
    '+1', // Number() accepts a leading plus; String() does not print it
    '1000000000000000000000000', // > 1e21 → exponential string form
    'Infinity',
    '-Infinity',
    'NaN',
    '0x10', // hex literal text parses to 16, prints '16'
    '0b101', // binary literal text parses to 5, prints '5'
    '0o17', // octal literal text parses to 15, prints '15'
  ])('%s → kept as the raw string', (raw) => {
    expect(parsedValue(raw)).toBe(raw);
  });

  test('the issue shape end to end: analyze-style flag keeps the id verbatim through the CLI', async () => {
    // The echo op's schema is `z.object({ msg: z.string() }).strict()`: a
    // mangled number would fail the string check (exit 2, the pre-#386
    // behavior for `1e000005`); the raw string now validates.
    const { code, out, err } = await capture(['echo', '--msg=1e000005']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ status: 'ok', value: { echo: '1e000005' } });
    expect(err).toBe('');
  });

  test('a non-canonical id still fails a NUMBER-typed schema honestly (kept as string ≠ silent number)', async () => {
    // A strict-{} op receiving any value is a usage error either way; the
    // string form must not be re-mangled back into a number to sneak in.
    const { code, err } = await capture(['boom', '--anything=1e000005']);
    expect(code).toBe(2);
    expect(err).toMatch(/invalid input for 'boom'/);
  });
});

describe('parseFlags mechanics unchanged', () => {
  test('bare flags, verbatim keys, positionals, duplicates (i1 parity)', () => {
    expect(parseFlags(['--flag'])).toEqual({ flags: { flag: true }, unknown: [] });
    expect(parseFlags(['positional'])).toEqual({ flags: {}, unknown: ['positional'] });
    expect(() => parseFlags(['--a=1', '--a=2'])).toThrow(/duplicate flag/);
    expect(parseFlags(['--key='])).toEqual({ flags: { key: '' }, unknown: [] });
  });

  test('duplicate flag e2e stays a usage error', async () => {
    const { code, err } = await capture(['echo', '--msg=a', '--msg=b']);
    expect(code).toBe(2);
    expect(err).toMatch(/duplicate flag --msg/);
  });
});
