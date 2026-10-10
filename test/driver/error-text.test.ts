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
  // plain URL-valued var is no longer blanket-redacted. A URL value carrying
  // embedded credentials is handled by the credential-URL screen at the env
  // boundary (src/config/resolve.ts), not by this redaction.
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
});
