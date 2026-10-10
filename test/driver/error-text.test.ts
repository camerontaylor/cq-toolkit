// The driver diagnostic-text helpers — pins for the persisted-shape rules.
//
// WorkerResult.error is journaled, so the text that reaches it must be plain
// (message only, never a vendor class name — I10), bounded (a full model
// output must not bloat a record), and secret-redacted (a vendor SDK echoing
// an API key must not leak it). These are the helper-level pins; the drivers'
// own tests cover the wiring.
import { describe, expect, test } from 'vitest';
import { boundedErrorText, describeError } from '../../src/driver/error-text.js';

describe('driver error text — plain, bounded, secret-redacted', () => {
  test('describeError keeps the message only, never a vendor class name', () => {
    expect(describeError(new Error('plain message'))).toBe('plain message');
    expect(describeError('raw')).toBe('raw');
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

  // Issue #291 row 6b (owner decision): `_URL` is not a secret suffix, so a
  // plain URL-valued var is no longer blanket-redacted. A URL value that DOES
  // carry embedded credentials is still scrubbed — by VALUE, right here in
  // the text, independent of any env name; the config resolver's credential-
  // URL screen additionally refuses such values at the passthrough boundary.
  test('boundedErrorText no longer redacts a plain _URL-suffixed value', () => {
    const prior = process.env.CQ_TEST_URL;
    process.env.CQ_TEST_URL = 'https://example.test/api';
    try {
      expect(boundedErrorText('endpoint https://example.test/api failed')).toBe(
        'endpoint https://example.test/api failed',
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
    process.env.CQ_TEST_URL = 'https://example.test/api';
    try {
      expect(boundedErrorText('token-value-1234 at https://example.test/api')).toBe(
        '[redacted] at https://example.test/api',
      );
    } finally {
      if (priorKey === undefined) delete process.env.CQ_TEST_TOKEN;
      else process.env.CQ_TEST_TOKEN = priorKey;
      if (priorUrl === undefined) delete process.env.CQ_TEST_URL;
      else process.env.CQ_TEST_URL = priorUrl;
    }
  });

  // Review fix (PR #305): redaction is also VALUE-based for URLs — a URL
  // carrying embedded userinfo is scrubbed whole from the text no matter
  // which env name (if any) holds it.
  test('boundedErrorText redacts a URL with embedded userinfo, env-independent', () => {
    expect(boundedErrorText('GET https://user:pass@example.test/db failed')).toBe(
      'GET [redacted] failed',
    );
    // Username-only userinfo still embeds a credential (Sentry-style DSNs).
    expect(boundedErrorText('dsn https://abc@o1.ingest.example.test/2 rejected')).toBe(
      'dsn [redacted] rejected',
    );
  });

  test('boundedErrorText redacts a credential-bearing _URL env value echoed into text', () => {
    const prior = process.env.CQ_TEST_URL;
    process.env.CQ_TEST_URL = 'https://user:pass@example.test/db';
    try {
      // The name rule no longer covers `_URL`, so only the value-based scrub
      // can catch the echoed endpoint URL.
      expect(boundedErrorText('connect refused: https://user:pass@example.test/db')).toBe(
        'connect refused: [redacted]',
      );
    } finally {
      if (prior === undefined) delete process.env.CQ_TEST_URL;
      else process.env.CQ_TEST_URL = prior;
    }
  });

  // Delta review (PR #305 r2): a raw newline can split the userinfo before
  // redaction runs, and the first pattern (whitespace-free span) let the
  // credentials survive. The span now admits whitespace, capped, so the
  // wrapped URL is scrubbed whole but a distant stray `@` cannot drag a
  // large unrelated block into one match.
  test('boundedErrorText redacts a URL whose userinfo is split across a newline', () => {
    expect(boundedErrorText('connect failed:\nhttps://user:\npass@example.test/db')).toBe(
      'connect failed:\n[redacted]',
    );
    // Greedy span resolution: an `@` inside a wrapped password must not leave
    // a credential fragment behind.
    expect(boundedErrorText('GET https://user:\npa@ss@example.test/db failed')).toBe(
      'GET [redacted] failed',
    );
  });

  test('boundedErrorText does not swallow a large unrelated text block after the userinfo span cap', () => {
    // The stray `@` sits beyond the 200-char span cap, so nothing matches and
    // the block — credentials-free — stays verbatim.
    const far = `https://user:\n${'x'.repeat(300)}\n@host.example.test`;
    expect(boundedErrorText(far)).toBe(far);
  });

  // Delta review r3 (PR #305): the wrapped tier's cap must not also cap
  // CONTIGUOUS userinfo — a long tunnel/DSN token escaped a capped span. The
  // contiguous tier is unbounded and cannot swallow unrelated text: it stops
  // at the first whitespace or the `@`.
  test('boundedErrorText redacts a long contiguous userinfo token beyond any cap', () => {
    const longToken = 'x'.repeat(201);
    expect(boundedErrorText(`GET https://user:${longToken}@example.test/db refused`)).toBe(
      'GET [redacted] refused',
    );
  });

  // Delta review r4 (PR #305): alternation order matters. Contiguous-first
  // matched the inner `@` of a wrapped password (`user:pa@`), truncating the
  // redaction and leaving `word@example.test/db` visible. The wrapped tier
  // now resolves first — greedy, to the last `@` within the cap — and the
  // unbounded contiguous tier is only the fallback for userinfo longer than
  // the wrap cap.
  test('boundedErrorText fully redacts a wrapped password whose inner @ would tempt the contiguous tier', () => {
    expect(boundedErrorText('ERR https://user:pa@ss\nword@example.test/db')).toBe('ERR [redacted]');
  });

  test('boundedErrorText keeps credential-free URLs visible, even with @ in the path', () => {
    expect(boundedErrorText('see https://example.com/a@b for details')).toBe(
      'see https://example.com/a@b for details',
    );
  });
});
