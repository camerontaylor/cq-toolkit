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

  // Owner ruling (b) keeps that tier's last-`@` behavior: a hit closes its tail
  // at the next whitespace, but the probe keeps watching, so a later eligible
  // `@` inside the same window merges into ONE span across lines and spaces.
  test('redactSensitiveText extends a wrap hit to a later eligible @', () => {
    expect(redactSensitiveText('https://user:\npa@ss word@x')).toBe('[redacted]');
    expect(redactSensitiveText('ERR https://user:\npa@ss\nword@example.test/db')).toBe(
      'ERR [redacted]',
    );
  });

  test('boundedErrorText keeps credential-free URLs visible, even with @ in the path', () => {
    expect(boundedErrorText('see https://example.com/a@b for details')).toBe(
      'see https://example.com/a@b for details',
    );
  });

  // Structural scrub (PR #305): every URL-standard userinfo form `new URL()`
  // accepts is scrubbed by VALUE — slashless, single-slash, protocol-relative,
  // non-special-scheme, over-long, and opaque forms alike.
  test('boundedErrorText redacts all URL-standard userinfo forms', () => {
    for (const url of [
      'https:user:pass@example.test/x',
      'https:/user:pass@example.test/x',
      '//user:pass@example.test/path',
      'postgres://u:p@h/d',
      'jdbc:oracle:thin:scott/tiger@//db.example.test/service',
      `https://user:${'x'.repeat(201)}@example.test/db`,
    ]) {
      expect(boundedErrorText(`fetch ${url} failed`)).toBe('fetch [redacted] failed');
    }
  });

  // Structural scrub (PR #305): a URL-like span whose query/fragment carries
  // a secret-looking KEY sitting at a parameter-name boundary is scrubbed
  // whole; a non-secret query stays visible.
  test('boundedErrorText redacts secret-keyed query/fragment spans only', () => {
    for (const url of [
      'https://example.test/api?token=secret',
      'https://example.test/api#access_token=xyz',
      'https://example.test/api?a=1&token=secret',
    ]) {
      expect(boundedErrorText(`fetch ${url} failed`)).toBe('fetch [redacted] failed');
    }
  });

  test('boundedErrorText keeps non-secret query URLs, plain URLs, and bare emails visible', () => {
    expect(boundedErrorText('see https://example.test/api?page=2 for details')).toBe(
      'see https://example.test/api?page=2 for details',
    );
    expect(boundedErrorText('see https://example.test/api?monkey=banana for details')).toBe(
      'see https://example.test/api?monkey=banana for details',
    );
    expect(boundedErrorText('see https://example.test/api?sessionid=1 for details')).toBe(
      'see https://example.test/api?sessionid=1 for details',
    );
    expect(boundedErrorText('see https://example.test/api for details')).toBe(
      'see https://example.test/api for details',
    );
    expect(boundedErrorText('contact user@example.test for access')).toBe(
      'contact user@example.test for access',
    );
  });

  // Round-3 fix (PR #305): every pre-`@` span stops at `?`/`#` (RFC 3986 —
  // the authority ends there), so an email inside a query is not misread as
  // userinfo and the whole URL stays visible.
  test('boundedErrorText keeps an email inside a query string visible', () => {
    expect(boundedErrorText('fetch https://example.test?email=user@example.test failed')).toBe(
      'fetch https://example.test?email=user@example.test failed',
    );
  });

  // Round-2 fix (PR #305): the opaque `scheme:` form is whitespace-free, so a
  // prose label before a bare email is not mistaken for an opaque scheme.
  // Only a contiguous `scheme:user@host` matches the opaque form.
  test('boundedErrorText keeps a prose label before a bare email visible', () => {
    expect(boundedErrorText('Error: contact user@example.test for access')).toBe(
      'Error: contact user@example.test for access',
    );
  });

  // Owner ruling (b): the scanner reads the full text, so the credential URL
  // and its whitespace-free 6000-character tail are ONE whole-span match; the
  // persisted output is then bounded, keeping the truncation marker whenever
  // either the raw or the redacted length outgrows the bound.
  test('boundedErrorText redacts a URL in the head of an over-long diagnostic', () => {
    const bounded = boundedErrorText('https://user:pass@example.test/x' + 'y'.repeat(6000));
    expect(bounded.startsWith('[redacted]')).toBe(true);
    expect(bounded).not.toContain('user:pass@example.test');
    expect(bounded.endsWith('[truncated]')).toBe(true);
  });

  // Owner ruling (b) — the single-pass scanner. Thread input J4Hq: a
  // semicolon-delimited SQL Server DSN has no authority the old screen could
  // inspect, and its `password=` parameter is a raw credential in the value;
  // the scanner decodes the parameter names and classifies them.
  test('redactSensitiveText scrubs a semicolon-delimited SQL Server DSN', () => {
    const dsn = 'jdbc:sqlserver://localhost;user=sa;password=hunter2;';
    expect(redactSensitiveText(dsn)).toBe('[redacted]');
    expect(redactSensitiveText(`connect failed: ${dsn} retrying`)).toBe(
      'connect failed: [redacted] retrying',
    );
  });

  // Thread input J4Hs: contiguous authority userinfo has NO length cap, so a
  // 4001-character (and a 1 MiB) credential cannot escape by length.
  test('redactSensitiveText has no cap on contiguous authority userinfo', () => {
    for (const size of [4001, 1024 * 1024]) {
      const token = 'z'.repeat(size);
      const out = redactSensitiveText(`GET https://user:${token}@example.test/db refused`);
      expect(out).toBe('GET [redacted] refused');
      expect(out).not.toContain('user:');
      expect(out).not.toContain(token);
    }
  });

  test('boundedErrorText redacts a long contiguous userinfo with no leaked head', () => {
    const token = 'z'.repeat(4001);
    const out = boundedErrorText(`GET https://user:${token}@example.test/db refused`);
    expect(out.startsWith('GET [redacted] refused')).toBe(true);
    expect(out).not.toContain('user:');
    expect(out).not.toContain(token);
    expect(out.length).toBeLessThanOrEqual(500 + '… [truncated]'.length);
  });

  // Thread input J4Hz: WHATWG accepts punctuation in userinfo that the old
  // pre-`@` span treated as a match boundary, so `pa"ss` leaked.
  test('redactSensitiveText redacts userinfo punctuation WHATWG accepts', () => {
    for (const userinfo of ['user:pa"ss', "user:pa'ss", 'user:pa`ss', 'user:pa<ss', 'user:pa>ss']) {
      expect(redactSensitiveText(`fetch https://${userinfo}@example.test/ failed`)).toBe(
        'fetch [redacted] failed',
      );
    }
  });

  // Thread input J4H1: a query of repeated `?` markers is ordinary data, never
  // a reason to retry an earlier start. Linearity follows from the scanner's
  // per-code-unit constant-work construction (design §4) — this pin asserts
  // correctness only, deliberately without any timing assertion.
  test('redactSensitiveText keeps long ?-dense query lines visible', () => {
    const line = `GET https://x?${'a?'.repeat(3000)} HTTP/1.1`;
    const text = [line, line, line].join('\n');
    expect(redactSensitiveText(text)).toBe(text);
    expect(boundedErrorText(line).startsWith('GET https://x?a?a')).toBe(true);
  });

  // Thread input J9M_: parameter names are percent-decoded exactly once
  // before classification, and `;`/`#` start a name, so an encoded secret key
  // in a query, fragment or semicolon list no longer leaks.
  test('redactSensitiveText decodes secret-looking parameter keys exactly once', () => {
    for (const url of [
      'https://example.test/api?access%5Ftoken=secret',
      'https://example.test/api?%74oken=secret',
      'https://example.test/api?a=1&%61ccesskey=secret',
      'https://example.test/?credential=secret',
      'https://example.test/?credentials=secret',
      'https://example.test/api#access%5Ftoken=secret',
      'https://example.test/api;a=1;token=secret',
      'https://example.test/api?a=1;token=secret',
    ]) {
      expect(redactSensitiveText(`fetch ${url} failed`)).toBe('fetch [redacted] failed');
    }
  });

  // Thread input J9NE: the scan cap is gone, so a credential URL positioned
  // after the old 4000-character window is redacted too (unit pin only).
  test('redactSensitiveText scans past offset 4000 in a multi-megabyte diagnostic', () => {
    const padding = 'a'.repeat(5000);
    const url = 'https://user:pass@example.test/x';
    const text = `${padding} ${url} ${'b'.repeat(1024 * 1024)}`;
    const out = redactSensitiveText(text);
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('user:pass@example.test');
    // Exactly one span replaced, so the untouched 1 MiB tail is byte-identical.
    expect(out.length).toBe(text.length - url.length + '[redacted]'.length);
  });

  // Design §5 "Additional safety" rows for the structural scanner.
  test('redactSensitiveText never classifies a parameter VALUE', () => {
    for (const text of [
      'see https://example.test/api?sort=key for details',
      // An encoded separator is decoded once as DATA, never as a delimiter.
      'see https://example.test/api?a%3Db=1 for details',
    ]) {
      expect(redactSensitiveText(text)).toBe(text);
    }
  });

  test('redactSensitiveText fails closed on a malformed percent escape in a key', () => {
    for (const url of ['https://example.test/api?tok%ZZen=1', 'https://example.test/api?%GG=1']) {
      expect(redactSensitiveText(`fetch ${url} failed`)).toBe('fetch [redacted] failed');
    }
  });

  test('redactSensitiveText redacts IPv6 and multi-@ userinfo forms', () => {
    for (const url of [
      'https://user:p@ss@[2001:db8::1]:8080/x',
      'https://user:pa@ss@example.test/x',
      'https://[2001:db8::1]@example.test/x',
    ]) {
      expect(redactSensitiveText(`fetch ${url} failed`)).toBe('fetch [redacted] failed');
    }
  });

  test('redactSensitiveText still scans an unrelated URL during a wrap probe', () => {
    // The wrap probe's tail merges the first URL whole; the interleaved second
    // URL is found by the main state machine and redacted separately.
    expect(redactSensitiveText('https://a:b\nc@h https://user:pass@x')).toBe(
      '[redacted] [redacted]',
    );
  });

  test('redactSensitiveText keeps a credential-free scheme-shaped value visible', () => {
    expect(redactSensitiveText('see urn:isbn:0451450523 for details')).toBe(
      'see urn:isbn:0451450523 for details',
    );
  });

  // The scanner's lexical edges, pinned directly: ECMAScript whitespace ends a
  // candidate, `+`/`-`/`.` are scheme characters, an opaque body starts
  // parameter names at its `:`/`&`/`;` delimiters, and a special scheme skips
  // a backslash run before the authority.
  test('redactSensitiveText treats every ECMAScript whitespace as a token end', () => {
    for (const space of [
      '\t',
      '\r',
      '\u00a0',
      '\u1680',
      '\u2003',
      '\u2028',
      '\u2029',
      '\u202f',
      '\u205f',
      '\u3000',
      '\ufeff',
    ]) {
      expect(redactSensitiveText(`fetch https://user:pass@example.test/x${space}failed`)).toBe(
        `fetch [redacted]${space}failed`,
      );
    }
  });

  test('redactSensitiveText accepts RFC 3986 scheme characters and special-scheme backslashes', () => {
    for (const url of [
      'foo+bar://u:p@h/x',
      'x.y+z://u:p@h/x',
      'https:\\\\user:pass@example.test/x',
    ]) {
      expect(redactSensitiveText(`fetch ${url} failed`)).toBe('fetch [redacted] failed');
    }
  });

  test('redactSensitiveText starts a parameter name in an opaque body', () => {
    for (const text of [
      'fetch jdbc:foo?token=secret failed',
      'fetch jdbc:foo#token=secret failed',
      'fetch jdbc:foo&token=secret failed',
      'fetch jdbc:foo;token=secret failed',
      'fetch jdbc:/x@y failed',
    ]) {
      expect(redactSensitiveText(text)).toBe('fetch [redacted] failed');
    }
  });

  test('redactSensitiveText bounds wrapped-authority recognition at 200 code units', () => {
    const far = `https://${'x'.repeat(250)}\n@host.example.test`;
    expect(redactSensitiveText(far)).toBe(far);
    // A wrap probe that never sees an eligible `@` redacts nothing, and a run
    // longer than the longest listed key word can never match.
    for (const text of [
      'https://a:b\n',
      'https://a:b\n/path',
      'see https://example.test/api?abcdefghijklmnop=1 for details',
      'see /metrics for details',
    ]) {
      expect(redactSensitiveText(text)).toBe(text);
    }
  });
});
