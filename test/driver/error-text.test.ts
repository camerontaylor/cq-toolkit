// The driver diagnostic-text helpers — pins for the persisted-shape rules.
//
// WorkerResult.error is journaled, so the text that reaches it must be plain
// (message only, never a vendor class name — I10), bounded (a full model
// output must not bloat a record), and secret-redacted (a vendor SDK echoing
// an API key must not leak it). These are the helper-level pins; the drivers'
// own tests cover the wiring.
import { describe, expect, test } from 'vitest';
import {
  boundedErrorText,
  describeError,
  redactSensitiveText,
} from '../../src/driver/error-text.js';

describe('driver error text — plain, bounded, secret-redacted', () => {
  test('describeError keeps the message only, never a vendor class name', () => {
    expect(describeError(new Error('plain message'))).toBe('plain message');
    expect(describeError('raw')).toBe('raw');
  });

  test.each([
    [
      'https://diagnostic-user:diagnostic-password@example.test/path',
      'https://[redacted]@example.test/path',
    ],
    [
      'postgres://diagnostic-user:p%40ss%3Aword@localhost:5432/db',
      'postgres://[redacted]@localhost:5432/db',
    ],
    ['//user:pass@example.test/path', '//[redacted]@example.test/path'],
    ['https:user:pass@example.test/path', 'https:[redacted]@example.test/path'],
    ['http:user:pass@example.test', 'http:[redacted]@example.test'],
    ['...https:user:pass@example.test', '...https:[redacted]@example.test'],
    ['xhttps:user:pass@example.test', 'xhttps:[redacted]@example.test'],
    ['prefixHTTP:user:pass@example.test', 'prefixHTTP:[redacted]@example.test'],
    ['xftp:user:pass@example.test', 'xftp:[redacted]@example.test'],
    ['xws:user:pass@example.test', 'xws:[redacted]@example.test'],
    ['xwss:user:pass@example.test', 'xwss:[redacted]@example.test'],
    ["https://user:p'ass@example.test/", 'https://[redacted]@example.test/'],
    [
      String.raw`https:\/\/user:pass@example.test/path`,
      String.raw`https:\/\/[redacted]@example.test/path`,
    ],
    [
      String.raw`https:\user:pass@example.test/path`,
      String.raw`https:\[redacted]@example.test/path`,
    ],
    ['HTTPS://user@example.test/', 'HTTPS://[redacted]@example.test/'],
    ['https://:password@[::1]:443/', 'https://[redacted]@[::1]:443/'],
    ['https://user:raw@password@example.test/', 'https://[redacted]@example.test/'],
  ])('redacts URL userinfo without an environment value: %s', (url, redacted) => {
    expect(boundedErrorText(`failed at ${url}`)).toBe(`failed at ${redacted}`);
  });

  test('handles long credential-free output without repeated scheme or authority scans', () => {
    const inputs = [
      'a'.repeat(40_000),
      JSON.stringify({ content: 'a'.repeat(80_000) }),
      'https:'.repeat(10_000),
      '//host/'.repeat(10_000),
      'xhttps:'.repeat(10_000),
      'x'.repeat(80_000) + 'https:host',
    ];
    const start = performance.now();
    for (const input of inputs) expect(redactSensitiveText(input)).toBe(input);
    // Deliberately generous: the former matcher took seconds on just 40 KB.
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test('preserves URLs without userinfo, including at-signs outside the authority', () => {
    const text =
      'https://example.test/user@host https://example.test?q=user@host https://example.test#user@host';
    expect(boundedErrorText(text)).toBe(text);
  });

  test('redacts multiple credential-bearing URLs before truncation', () => {
    const text = 'https://u:p@one.test/ and ftp://u:p@two.test/ ' + 'x'.repeat(600);
    expect(boundedErrorText(text)).toBe(
      ('https://[redacted]@one.test/ and ftp://[redacted]@two.test/ ' + 'x'.repeat(600)).slice(
        0,
        500,
      ) + '… [truncated]',
    );
  });

  test('boundedErrorText truncates an over-long diagnostic', () => {
    const marker = '… [truncated]';
    const bounded = boundedErrorText('x'.repeat(600));
    expect(bounded.length).toBeLessThanOrEqual(500 + marker.length);
    expect(bounded.endsWith('[truncated]')).toBe(true);
  });

  test('boundedErrorText redacts an environment secret value it echoes', () => {
    const prior = process.env.CQ_TEST_API_KEY;
    process.env.CQ_TEST_API_KEY = 'super-secret-value';
    try {
      expect(boundedErrorText('failed with super-secret-value')).toBe('failed with [redacted]');
    } finally {
      if (prior === undefined) delete process.env.CQ_TEST_API_KEY;
      else process.env.CQ_TEST_API_KEY = prior;
    }
  });

  test('boundedErrorText redacts whole tokens only, so a short value cannot shred a longer word', () => {
    const prior = process.env.CQ_TEST_KEY;
    process.env.CQ_TEST_KEY = 'abcd';
    try {
      expect(boundedErrorText('xabcdx abcd')).toBe('xabcdx [redacted]');
    } finally {
      if (prior === undefined) delete process.env.CQ_TEST_KEY;
      else process.env.CQ_TEST_KEY = prior;
    }
  });

  test('boundedErrorText keeps snake_case identifiers intact around a short value', () => {
    const prior = process.env.CQ_TEST_KEY;
    process.env.CQ_TEST_KEY = 'abcd';
    try {
      expect(boundedErrorText('my_abcd_var abcd')).toBe('my_abcd_var [redacted]');
    } finally {
      if (prior === undefined) delete process.env.CQ_TEST_KEY;
      else process.env.CQ_TEST_KEY = prior;
    }
  });

  // Issue #291 row 6b (owner ruling 2026-10-11, ADR N21): the suffix lists
  // DIVERGE deliberately. Config resolution, journaling and passthrough treat a
  // `_URL` name as non-secret only for a clean absolute http(s) URL, but
  // diagnostics redaction KEEPS `_URL` (case-insensitively) so a URL value can
  // never reach persisted error text. This pins the divergence on the exact
  // value config now accepts.
  test('boundedErrorText still redacts a _URL-suffixed value by name (deliberate divergence)', () => {
    const prior = process.env.CQ_TEST_URL;
    process.env.CQ_TEST_URL = 'https://example.test/metrics';
    try {
      expect(boundedErrorText('endpoint https://example.test/metrics failed')).toBe(
        'endpoint [redacted] failed',
      );
    } finally {
      if (prior === undefined) delete process.env.CQ_TEST_URL;
      else process.env.CQ_TEST_URL = prior;
    }
  });

  test('boundedErrorText still redacts a credential-suffixed var even when a _URL var is set', () => {
    const priorKey = process.env.CQ_TEST_TOKEN;
    const priorUrl = process.env.CQ_TEST_URL;
    process.env.CQ_TEST_TOKEN = 'token-value-1234';
    process.env.CQ_TEST_URL = 'https://example.test/metrics';
    try {
      expect(boundedErrorText('token-value-1234 at https://example.test/metrics')).toBe(
        '[redacted] at [redacted]',
      );
    } finally {
      if (priorKey === undefined) delete process.env.CQ_TEST_TOKEN;
      else process.env.CQ_TEST_TOKEN = priorKey;
      if (priorUrl === undefined) delete process.env.CQ_TEST_URL;
      else process.env.CQ_TEST_URL = priorUrl;
    }
  });

  // Round 3 (Codex P1 L0_a): classification is case-folded, so a lowercase or
  // win32-spelled `metrics_url` cannot dodge the redaction.
  test('boundedErrorText redacts a lowercase _URL-suffixed env name', () => {
    const prior = process.env.metrics_url;
    process.env.metrics_url = 'https://user:pass@example.test/x';
    try {
      expect(boundedErrorText('failed at https://user:pass@example.test/x')).toBe(
        'failed at [redacted]',
      );
    } finally {
      if (prior === undefined) delete process.env.metrics_url;
      else process.env.metrics_url = prior;
    }
  });
});
