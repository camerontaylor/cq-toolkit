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

  // Delta review (PR #305 r2) + fresh-review round 4: WHATWG strips
  // tab/newline/CR from the whole input before parsing, so a newline inside a
  // candidate is TRANSPARENT. A newline-split userinfo is no longer split at
  // all: the whole token is one candidate and redacts however long it is.
  test('boundedErrorText redacts a URL whose userinfo is split across a newline', () => {
    // Parser-transparency reaches further than the URL: `failed:` plus the
    // newline plus the URL is ONE opaque candidate (WHATWG strips the newline,
    // leaving `failed:https://…`), so the prose word is swallowed too — the
    // accepted over-redaction direction, and config-consistent (that opaque
    // value has an empty host, which the config screen refuses).
    expect(boundedErrorText('connect failed:\nhttps://user:\npass@example.test/db')).toBe(
      'connect [redacted]',
    );
    // An `@` inside the (formerly wrapped) password must not leave a fragment.
    expect(boundedErrorText('GET https://user:\npa@ss@example.test/db failed')).toBe(
      'GET [redacted] failed',
    );
  });

  test('redactSensitiveText redacts a newline-wrapped credential of any length', () => {
    // Under parser-transparency this IS one URL with a 300-code-unit userinfo,
    // so redacting it whole is correct; the old wrapped-window residual applied
    // only to the newline split, which no longer splits anything.
    const far = `https://user:\n${'x'.repeat(300)}\n@host.example.test`;
    expect(redactSensitiveText(far)).toBe('[redacted]');
    expect(boundedErrorText(far)).toBe('[redacted]');
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

  // The scanner's lexical edges, pinned directly: WHATWG-ignored tab/newline/CR
  // are TRANSPARENT inside a candidate while every other ECMAScript whitespace
  // ends it, `+`/`-`/`.` are scheme characters, an opaque body starts parameter
  // names at its `:`/`&`/`;` delimiters, and a backslash counts as a slash.
  test('redactSensitiveText skips WHATWG-ignored tab/newline/CR inside a candidate', () => {
    // The whitespace is neither name data nor a token end, so a key split by
    // one still reads as its literal form to any consumer.
    for (const ignored of ['\t', '\n', '\r']) {
      expect(
        redactSensitiveText(`fetch https://example.test/?to${ignored}ken=hunter2 failed`),
      ).toBe('fetch [redacted] failed');
      // The URL token continues past it, so the separator is inside the span.
      expect(redactSensitiveText(`fetch https://user:pass@example.test/x${ignored}failed`)).toBe(
        'fetch [redacted]',
      );
    }
    // A tab inside the scheme reassembles it, so the whole value redacts.
    expect(redactSensitiveText('ht\ttps://user:pass@example.test/x')).toBe('[redacted]');
  });

  test('redactSensitiveText ends a candidate at every other ECMAScript whitespace', () => {
    for (const space of [
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

  test('redactSensitiveText bounds a SPACE-split wrap probe at 200 code units', () => {
    // A newline is transparent (WHATWG), so the 200-code-unit window now only
    // bounds a space split, where it is effectively vestigial but harmless: a
    // 250-code-unit authority does not register a probe and stays visible.
    const far = `https://${'x'.repeat(250)} @host.example.test`;
    expect(redactSensitiveText(far)).toBe(far);
    // A probe that never sees an eligible `@` redacts nothing, and a run longer
    // than the longest listed key word can never match.
    for (const text of [
      'https://a:b\n',
      'https://a:b\n/path',
      'see https://example.test/api?abcdefghijklmnop=1 for details',
      'see /metrics for details',
    ]) {
      expect(redactSensitiveText(text)).toBe(text);
    }
  });

  // Fresh-review round 2 (KiBl): a run of slashes at the authority start is
  // WHATWG's slash-run form, not a path, so the credential still scrubs.
  test('redactSensitiveText redacts a slash-run authority', () => {
    expect(redactSensitiveText('///user:pass@example.test/x')).toBe('[redacted]');
    expect(redactSensitiveText('////user:pass@h/x')).toBe('[redacted]');
    expect(redactSensitiveText('GET ///user:pass@example.test/x failed')).toBe(
      'GET [redacted] failed',
    );
  });

  // Fresh-review round 2 (KiBk): a nested `scheme://` or `//` credential URL
  // inside a path segment or a parameter VALUE redacts the whole outer
  // candidate — over-redaction of the outer prefix is the accepted direction.
  test('redactSensitiveText redacts a nested credential URL inside a path or value', () => {
    for (const url of [
      'https://proxy.test/?target=https://user:pass@example.test/x',
      'https://proxy.test/fwd?to=//user:pass@private.test/y',
      'https://h/https://user:pass@x/z',
      'https://h/p#t=https://user:pass@x/z',
    ]) {
      expect(redactSensitiveText(`fetch ${url} failed`)).toBe('fetch [redacted] failed');
    }
  });

  test('redactSensitiveText keeps credential-free nested paths and values visible', () => {
    for (const text of [
      'https://example.test?email=user@host',
      'https://example.test/api?page=2',
      'https://h/a@b',
      'https://example.test/api?sort=key',
      'https://example.test?redirect=//example.test/path',
      'https://example.test/api?a=b/c',
    ]) {
      expect(redactSensitiveText(text)).toBe(text);
    }
  });

  // Fresh-review round 3: a slash RUN at the NESTED authority start is skipped
  // exactly like the outer machine's, so the third slash no longer sends the
  // inner state back to `none` before the credential's `@`.
  test('redactSensitiveText redacts a slash run at a nested authority start', () => {
    for (const url of [
      'https://proxy.test/?target=///user:pass@example.test/x',
      'https://proxy.test/?t=////u@x/y',
      'https://proxy.test/?t=https:///user@x',
    ]) {
      expect(redactSensitiveText(`fetch ${url} failed`)).toBe('fetch [redacted] failed');
    }
    // The covered nested forms and a credential-free nested slash run are
    // unchanged.
    expect(redactSensitiveText('fetch https://proxy.test/?t=https://user:pass@x failed')).toBe(
      'fetch [redacted] failed',
    );
    expect(redactSensitiveText('https://proxy.test/?redirect=///example.test/path')).toBe(
      'https://proxy.test/?redirect=///example.test/path',
    );
  });

  // Fresh-review round 4 (KzpE): tab/newline/CR are transparent inside a
  // candidate, so an opaque `@` after a newline now redacts from the SCHEME
  // word. A real space still ends the candidate, so the space-separated prose
  // variant is unchanged. Accepted over-redaction, config-consistent: the same
  // string parses as an opaque scheme value, which the config screen refuses.
  test('redactSensitiveText redacts an opaque @ reached across a newline', () => {
    expect(redactSensitiveText('Error:\ncontact@user.example.test for access')).toBe(
      '[redacted] for access',
    );
    for (const text of [
      'Error:\ncontact user@example.test for access',
      'Error: contact user@example.test for access',
    ]) {
      expect(redactSensitiveText(text)).toBe(text);
    }
  });

  // Fresh-review round 4 (KzpG): a camelCase compound matches like its
  // snake_case twin — the literal run is split at lower/digit -> Upper
  // transitions and each piece is classified (`accessToken` -> `token`).
  test('redactSensitiveText classifies camelCase secret-key compounds', () => {
    for (const url of [
      'https://example.test/?accessToken=hunter2',
      'https://example.test/?authToken=hunter2',
      'https://example.test/?sessionKey=1',
    ]) {
      expect(redactSensitiveText(`fetch ${url} failed`)).toBe('fetch [redacted] failed');
    }
    for (const text of [
      'https://example.test/?monkeyCamel=1',
      'https://example.test/api?monkey=banana',
    ]) {
      expect(redactSensitiveText(text)).toBe(text);
    }
  });

  // Fresh-review round 4 (KzpD): WHATWG reads a backslash as a slash in
  // special-URL context, so a backslash slash-run is a credential URL too;
  // a credential-free UNC path is not.
  test('redactSensitiveText redacts backslash slash-run forms', () => {
    expect(redactSensitiveText('\\\\user:pass@example.test/x')).toBe('[redacted]');
    expect(redactSensitiveText('/\\/user:pass@example.test/x')).toBe('[redacted]');
    expect(redactSensitiveText('fetch \\\\user:pass@example.test/x failed')).toBe(
      'fetch [redacted] failed',
    );
    expect(redactSensitiveText('\\\\server\\share')).toBe('\\\\server\\share');
  });

  // Fresh-review round 4 (K6bB): the nested URL's own `?` hands the shared
  // parameter-name machinery the nested query, so a secret-KEYED nested query
  // redacts the whole outer candidate, while an email in a nested VALUE does
  // not (a query `@` is not an authority).
  test('redactSensitiveText classifies a nested credential query', () => {
    for (const url of [
      'https://proxy.test/?target=https://api.test/path?token=hunter2',
      'https://proxy.test/?t=https://x/p#access_token=z',
    ]) {
      expect(redactSensitiveText(`fetch ${url} failed`)).toBe('fetch [redacted] failed');
    }
    expect(redactSensitiveText('https://proxy.test/?t=https://x/p?mail=user@example.test')).toBe(
      'https://proxy.test/?t=https://x/p?mail=user@example.test',
    );
  });
});
