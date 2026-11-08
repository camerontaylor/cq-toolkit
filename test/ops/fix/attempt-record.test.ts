import { describe, expect, it } from 'vitest';
import {
  finishAttempt,
  MAX_SANITIZED_CHARS,
  repoIdFromRemote,
  sanitizeObservation,
  STOP_CODE_CLASS,
} from '../../../src/ops/fix/attemptRecord.js';

// Fake/local fixtures only: no repositories, providers or credentials.
const base = {
  tier: 'worker' as const,
  invocation: 'edit',
  model: { model: 'fake-model', provider: 'fake' },
};

/** Literal ADR-0008 stop-code table; STOP_CODE_CLASS must equal it exactly. */
const ADR_STOP_TABLE: ReadonlyArray<readonly [string, string]> = [
  ['spawn', 'infrastructure'],
  ['dns', 'infrastructure'],
  ['transport', 'infrastructure'],
  ['provider-outage', 'infrastructure'],
  ['unclassified', 'infrastructure'],
  ['wall-cap', 'budget'],
  ['token-cap', 'budget'],
  ['human-deferred', 'human'],
  ['approval-expired', 'human'],
  ['validation-failed', 'terminal'],
  ['model-output', 'terminal'],
  ['nochange', 'terminal'],
  ['completed', 'terminal'],
  ['provider-retryable', 'retriable'],
];

describe('sanitizeObservation', () => {
  it('pins the strict observation over-match for an at-sign in a URL path', () => {
    expect(sanitizeObservation('https://host/path@seg')).toBe('https://seg');
  });

  it('T12 round-trip', () => {
    process.env.FAKE_TEST_API_KEY = 'sup3rs3cretvalue';
    try {
      const sanitized = sanitizeObservation({
        stopReason: 'worker stopped: see https://user:tok@host.example/path?q=secret',
        reason: 'token sup3rs3cretvalue leaked',
        nested: { deep: ['git@github.com:camerontaylor/cq-toolkit.git'] },
        count: 3,
      });
      expect(sanitized).toEqual({
        stopReason: 'worker stopped: see https://host.example/path',
        reason: 'token [redacted] leaked',
        nested: { deep: ['github.com:camerontaylor/cq-toolkit.git'] },
        count: 3,
      });
    } finally {
      delete process.env.FAKE_TEST_API_KEY;
    }
  });

  it.each(['=aaaa', '=a@', '=a:b@', ';aaaa', 'a=b&', 'a'])(
    'bounds adversarial run %s',
    (pattern) => {
      const input = pattern.repeat(Math.ceil(200_000 / pattern.length));
      const start = Date.now();
      sanitizeObservation(input);
      expect(Date.now() - start).toBeLessThan(5000);
    },
  );

  it.each([
    ['https://h/p?fields=id,name&access_token=X', 'https://h/p'],
    ['https://h/p?q=x;sig=X', 'https://h/p'],
    ['https://h/p?q=[x]&token=X', 'https://h/p'],
    ['https://[::1]/p?token=X', 'https://[::1]/p'],
    ...[';', ',', "'", '(', '{', '<'].map((c) => [
      `https://u:prefix${c}secret@host/p`,
      'https://host/p',
    ]),
    ['fatal:user:tok@host', 'host'],
    [':u:p@host', 'host'],
    ['1https://u:p@host/p', 'host/p'],
    ['u:p@@host', 'host'],
    ['tok@[::1]:o/r', '[::1]:o/r'],
    ['https://user:p\nassword@host/p', 'https://\nhost/p'],
  ])('closes leak %s', (input, expected) => {
    expect(sanitizeObservation(input)).toEqual(expected);
  });

  it.each([
    ['{"auth":"user:tok@h","remote":"https://h/x"}', 'user:tok', 'https://h/x'],
    ['user:tok@host,https://example.com/x', 'user:tok', 'https://example.com/x'],
    ['token:SECRET@h;see=https://x.example/y', 'SECRET', 'https://x.example/y'],
    ['pass=hunter2@https://h/x', 'hunter2', 'https://h/x'],
  ])('sanitizes the prefix before a URL: %s', (input, secret, url) => {
    const out = sanitizeObservation(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(url);
  });

  it.each(['127.0.0.1:8080', 'localhost:3000', 'github.com:443', '[::1]:8080'])(
    'preserves host:port followed by whitespace: %s',
    (authority) => {
      const input = `http://${authority} retrying`;
      expect(sanitizeObservation(input)).toEqual(input);
    },
  );

  it.each([
    ['https://h/x?token=https://SECRET', 'https://h/x'],
    ['u:p@ host', ' host'],
    ['u:p@"host"', '"host"'],
    ['password hunter2@ end', 'password  end'],
    ['user:to\nken@host', '\nhost'],
    ['(u:p@host)', '(host)'],
    ['password hunter2@!x', 'password !x'],
    ['"https://h/x?q=1"user:tok@host', '"https://h/x"host'],
    ['"https://u:p@one/x?q=1"https://a:b@two/y?token=X', '"https://one/x"https://two/y'],
  ])('fails closed on split and unusual credential shapes: %s', (input, expected) => {
    expect(sanitizeObservation(input)).toEqual(expected);
  });

  it('bounds many adjacent URLs in a single run', () => {
    const start = Date.now();
    const out = sanitizeObservation('https://u:p@h/x?q=x"'.repeat(10_000));
    expect(out).not.toContain('u:p');
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it.each([
    ["https://h/x?q='SECRET'", 'https://h/x'],
    ['https://h/x?token="abc"', 'https://h/x'],
    ['"https://h/x?q=1", next', '"https://h/x", next'],
    ['<https://h/x?t=1>', '<https://h/x>'],
    ['https://us\ner:pw@host', 'https://\nhost'],
    ['at src/a.ts:10:5\nnext@thing', 'at src/a.ts:10:5\nthing'],
    ['k:v\nfoo@bar', 'k:v\nbar'],
  ])('uses the opening delimiter and preserves newline prose: %s', (input, expected) => {
    expect(sanitizeObservation(input)).toEqual(expected);
  });

  it.each(['https://a/?q=xhttps://b/y"user:SEC@h', '"https://a/?q=xhttps://b/y"user:SEC@h'])(
    'sanitizes the resumed query segment: %s',
    (input) => {
      expect(sanitizeObservation(input)).not.toContain('SEC');
    },
  );

  it.each([
    ["https://a/?q=xhttps://b/y'SEC", 'https://a/'],
    ['https://user:SEC38', 'https://'],
    ['https://[::1]/x', 'https://[::1]/x'],
    ['https://[::1]', 'https://[::1]'],
    ['Error: 12:34\nfoo@bar', 'Error: 12:34\nbar'],
    ['src/ab:cd\nx@y', 'src/ab:cd\ny'],
    ['us\ner:SEC@host', '\nhost'],
    ['user\n:SEC@host', '\nhost'],
    ['us\ner:SEC91@host,https://x', '\nhost,https://x'],
    ['abc\ner:SEC95@h/https://x', '\nh/https://x'],
    [String.raw`<https://h/x?q=\>SEC>`, '<https://h/x>SEC>'],
    ['https://h/x\nuser@host', 'https://h/x\nhost'],
  ])('pins accepted sanitizer edge case: %s', (input, expected) => {
    expect(sanitizeObservation(input)).toEqual(expected);
  });

  it.each([
    String.raw`{"url":"https://h/x?q=\"SEC38\""}`,
    String.raw`{"url":"https://a/?q=xhttps://b/y\"SEC38\""}`,
  ])('does not resume at an escaped query quote: %s', (input) => {
    expect(sanitizeObservation(input)).not.toContain('SEC38');
  });

  it.each(['connecting', 'Cloning into repo'])(
    'preserves prose before a newline URL: %s',
    (prose) => {
      expect(sanitizeObservation(`${prose}\nhttps://u:p@h/x`)).toEqual(`${prose}\nhttps://h/x`);
    },
  );

  it.each([
    String.raw`'https://h/x?q=\'SEC65\''`,
    String.raw`'https://a/?q=xhttps://b/y\'SEC65\''`,
  ])('skips escaped single query quotes: %s', (input) => {
    expect(sanitizeObservation(input)).not.toContain('SEC65');
  });

  it.each([
    [String.raw`{"url":"https://h/x?q=a\\","tok":"x"}`, '{"url":"https://h/x","tok":"x"}'],
    [String.raw`{"url":"https://a/?q=xhttps://b/y\\","tok":"x"}`, '{"url":"https://a/","tok":"x"}'],
    [String.raw`'https://h/x?q=a\\',next`, "'https://h/x',next"],
  ])('resumes after an even backslash run: %s', (input, expected) => {
    expect(sanitizeObservation(input)).toEqual(expected);
  });

  it('a *_URL value is not a secret: the credential-stripped URL stays visible', () => {
    process.env.ZZ_HOOK_URL = 'https://hooks.example/svc/p';
    try {
      expect(sanitizeObservation('https://u:p@hooks.example/svc/p')).toEqual(
        'https://hooks.example/svc/p',
      );
    } finally {
      delete process.env.ZZ_HOOK_URL;
    }
  });

  it('strips credentials spanning the output cap before truncation', () => {
    const input = 'https://u:' + 'p'.repeat(MAX_SANITIZED_CHARS) + '@host/p';
    expect(sanitizeObservation(input)).toEqual('https://host/p');
  });

  it('never cuts a surrogate pair at the cap', () => {
    const out = sanitizeObservation('a'.repeat(MAX_SANITIZED_CHARS - 1) + '😀tail');
    expect(out).toEqual('a'.repeat(MAX_SANITIZED_CHARS - 1) + ' …[truncated 6 chars]');
  });

  it('passes numbers, booleans and null through structurally', () => {
    expect(sanitizeObservation({ a: 1, b: [true, null], c: { d: 2 } })).toEqual({
      a: 1,
      b: [true, null],
      c: { d: 2 },
    });
  });

  it('a *_URL value with userinfo is shown through the shared redactor (userinfo gone)', () => {
    process.env.FAKE_HOOK_URL = 'https://tolk3n@hooks.example.test/wb';
    try {
      const out = sanitizeObservation('webhook https://tolk3n@hooks.example.test/wb fired');
      expect(out).not.toContain('tolk3n');
      expect(out).toContain('https://hooks.example.test/wb');
    } finally {
      delete process.env.FAKE_HOOK_URL;
    }
  });

  it('redact-before-strip kills a *_PASSWORD secret containing @ and :', () => {
    process.env.FAKE_DB_PASSWORD = 'pa@ss:word99';
    try {
      const out = sanitizeObservation('connect failed with pa@ss:word99');
      expect(out).not.toContain('word99');
      expect(out).not.toContain('pa@ss');
    } finally {
      delete process.env.FAKE_DB_PASSWORD;
    }
  });

  it('post-redaction pass kills a secret the stripping mangled (ZZ_TOKEN=ss@host…)', () => {
    process.env.ZZ_TOKEN = 'ss@host.example';
    try {
      const out = sanitizeObservation('https://u:p@ss@host.example/x');
      expect(out).toEqual('https://[redacted]/x');
    } finally {
      delete process.env.ZZ_TOKEN;
    }
  });

  it('prose ?, #123 and ## survive; only URL tokens are cut', () => {
    const out = sanitizeObservation(
      'What happened? The worker saw #123 and ## heading text. See https://u:tok@docs.example/g?x=1 for details.',
    );
    expect(out).toContain('What happened?');
    expect(out).toContain('#123');
    expect(out).toContain('## heading');
    expect(out).toContain('https://docs.example/g');
    expect(out).not.toContain('tok@');
    expect(out).not.toContain('?x=1');
  });

  it('both URLs in a multi-URL string are kept and stripped', () => {
    const out = sanitizeObservation(
      'compare https://a:1@one.example/p?x=1 with https://b:2@two.example/q#f',
    );
    expect(out).toContain('https://one.example/p');
    expect(out).toContain('https://two.example/q');
    expect(out).not.toContain('?x=1');
    expect(out).not.toContain('#f');
  });

  it('fragment-only credentials are stripped (https://h/cb#access_token=X)', () => {
    const out = sanitizeObservation('cb https://h.example/cb#access_token=X');
    expect(out).toEqual('cb https://h.example/cb');
    expect(out).not.toContain('access_token');
  });

  it('__proto__ keys pass through as data on null-prototype objects', () => {
    const input = JSON.parse('{"__proto__": {"stopReason": "safe"}}') as Record<string, unknown>;
    const out = sanitizeObservation(input) as Record<string, unknown>;
    expect(Object.keys(out)).toContain('__proto__');
    expect((out['__proto__'] as Record<string, unknown>).stopReason).toEqual('safe');
  });

  it('caps runaway strings with a truncation marker', () => {
    const out = sanitizeObservation('x'.repeat(MAX_SANITIZED_CHARS + 10));
    expect(out.length).toBeLessThan(MAX_SANITIZED_CHARS + 40);
    expect(out).toMatch(/…\[truncated 10 chars\]$/);
  });

  it('is linear on 200k-char adversarial input (well under a 5s bound)', () => {
    const adversarial = 'a://'.repeat(50_000);
    const start = Date.now();
    const out = sanitizeObservation(adversarial) as string;
    const elapsedMs = Date.now() - start;
    expect(out.length).toBeLessThanOrEqual(MAX_SANITIZED_CHARS + 40);
    expect(elapsedMs).toBeLessThan(5000);
  });
});

describe('credential stripping (critic table)', () => {
  const strip = (s: string): string => sanitizeObservation(s);

  it.each([
    [
      'userinfo to the last @ before the authority ends',
      'https://user:p@ss@host.example/x',
      'https://host.example/x',
    ],
    [
      'base64 with slashes inside the secret',
      'https://user:YWJjZA/+@host.example/x',
      'https://host.example/x',
    ],
    ['fragment stripped with query', 'https://host.example/x?a=1#frag', 'https://host.example/x'],
    [
      'query ends at a quote delimiter',
      'see "https://host.example/x?q=1" next',
      'see "https://host.example/x" next',
    ],
    [
      'user:token@host without trailing colon',
      'failed as user:token@host.example',
      'failed as host.example',
    ],
    [
      'x-access-token style prefix',
      'x-access-token:ghp_x@github.com:camerontaylor/cq.git',
      'github.com:camerontaylor/cq.git',
    ],
    ['equals-boundary prefix', 'export CFG=tok@host.example:', 'export host.example:'],
    ['plus-tagged user', 'user+tag@host.example:', 'host.example:'],
    [
      'newline inside scheme userinfo splits the token',
      'https://u\nser:pw@host.example/x',
      'https://\nhost.example/x',
    ],
    ['uppercase scheme', 'HTTPS://User:Tok@Host.Example/Path', 'HTTPS://Host.Example/Path'],
    [
      'AKIA-style secret with plus and equals',
      'https://AKIA:abc/def+xyz==@host.example/x',
      'https://host.example/x',
    ],
    ['fatal prefix', 'fatal: user:tok@host.example refused', 'fatal: host.example refused'],
    ['greedy to last @ in free text', 'log user:p@ss@host.example: done', 'log host.example: done'],
    [
      'SHA unchanged',
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ],
  ])('%s', (_name, input, expected) => {
    expect(strip(input)).toEqual(expected);
  });

  it('package-spec over-strip is documented over-matching (vitest@5.0.0)', () => {
    // Deliberate: `name@version:` is indistinguishable from user:token@host
    // in free text, and failing closed is preferred over leaking.
    expect(strip('run vitest@5.0.0:')).toEqual('run 5.0.0:');
  });
});

describe('repoIdFromRemote (canonical host/path)', () => {
  const spellings = [
    'https://user:tok@GitHub.com/camerontaylor/cq-toolkit',
    'https://github.com/camerontaylor/cq-toolkit/',
    'https://github.com//camerontaylor/cq-toolkit/',
    'ssh://git@github.com:22/camerontaylor/cq-toolkit.git',
    'git@github.com:camerontaylor/cq-toolkit.git',
  ];
  const ids = spellings.map((remote) => repoIdFromRemote(remote));

  it('https, scp, ssh://, .git, repeated/trailing slash and case give one digest', () => {
    expect(new Set(ids.map((r) => r.repoId)).size).toEqual(1);
    expect(ids[0]?.repoId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('a credential never changes the digest and the raw remote never persists', () => {
    expect(repoIdFromRemote('https://github.com/camerontaylor/cq-toolkit')).toEqual(ids[0]);
    expect(ids[0]?.repoId).not.toContain('github');
    expect(ids[0]?.repoId).not.toContain('camerontaylor');
  });

  it('normalizes repeated internal path separators', () => {
    expect(repoIdFromRemote('https://github.com/o//r')).toEqual(
      repoIdFromRemote('https://github.com/o/r'),
    );
  });

  it('no remote vs unparseable remote are distinguished', () => {
    expect(repoIdFromRemote(null)).toEqual({ repoId: null, reason: 'no-remote' });
    expect(repoIdFromRemote(undefined)).toEqual({ repoId: null, reason: 'no-remote' });
    expect(repoIdFromRemote('   ')).toEqual({ repoId: null, reason: 'no-remote' });
    expect(repoIdFromRemote('not a remote at all')).toEqual({
      repoId: null,
      reason: 'unparseable-remote',
    });
  });
});

describe('finishAttempt', () => {
  it('matches the literal ADR stop-code table exactly', () => {
    expect([...STOP_CODE_CLASS.entries()]).toEqual(ADR_STOP_TABLE);
  });

  it('classifies every ADR row by table only', () => {
    for (const [code, expected] of ADR_STOP_TABLE) {
      const record = finishAttempt({ ...base, stopCode: code, stopReason: 'x' });
      expect(record.stopCode).toEqual(code);
      expect(record.class).toEqual(expected);
    }
  });

  it('a bare write-denied code is unclassified, not the writeDenied variant', () => {
    const record = finishAttempt({ ...base, stopCode: 'write-denied', stopReason: 'x' });
    expect(record.stopCode).toEqual('unclassified');
    expect(record.class).toEqual('infrastructure');
    expect(record.error?.code).toEqual('write-denied');
  });

  it('fails closed for runtime completed plus bare write-denied', () => {
    const input = { ...base, completed: true, stopCode: 'write-denied' } as unknown as Parameters<
      typeof finishAttempt
    >[0];
    const record = finishAttempt(input);
    expect(record.class).toEqual('infrastructure');
    expect(record.stopCode).toEqual('unclassified');
  });

  it('T12 round-trip: sanitized full payload parses against the strict schema', () => {
    process.env.FAKE_ATTEMPT_SECRET = 'leaky-leaky';
    try {
      const record = finishAttempt({
        ...base,
        completed: true,
        stopReason: 'done; webhook https://bot:tok@host.example/h?x=1 and leaky-leaky',
        usageChannels: { input: 10, output: 5 },
        tokens: 15,
        wallMs: 1200,
      });
      expect(record.stopCode).toEqual('completed');
      expect(record.class).toEqual('terminal');
      expect(record.stopReason).not.toContain('tok@');
      expect(record.stopReason).not.toContain('leaky-leaky');
      expect(record.stopReason).toContain('host.example/h');
    } finally {
      delete process.env.FAKE_ATTEMPT_SECRET;
    }
  });

  it('T12 failure boundary: budget precedence, then write-denied gate classes', () => {
    const budget = finishAttempt({
      ...base,
      completed: true,
      budgetExpired: true,
      budgetStopCode: 'wall-cap',
      stopReason: 'wall budget exhausted mid-edit',
    });
    expect(budget.stopCode).toEqual('wall-cap');
    expect(budget.class).toEqual('budget');

    expect(finishAttempt({ ...base, writeDenied: 'fail' }).class).toEqual('terminal');
    expect(finishAttempt({ ...base, writeDenied: 'needs-human' }).class).toEqual('human');
    expect(finishAttempt({ ...base, writeDenied: 'escalated-to-human' }).class).toEqual('human');

    const unknown = finishAttempt({
      ...base,
      stopCode: 'mystery-code',
      stopReason: 'worker stopped: mystery-code',
      error: {
        type: 'EPIPE',
        code: 'mystery-code',
        providerFinishReason: null,
        source: 'worker',
        certainty: 'observed',
      },
    });
    expect(unknown.stopCode).toEqual('unclassified');
    expect(unknown.class).toEqual('infrastructure');
    expect(unknown.error?.certainty).toEqual('unknown');
    expect(unknown.error?.code).toEqual('mystery-code');
  });

  it('T12 unknown evidence: no invented prose, availability carries absence', () => {
    const record = finishAttempt({ ...base, stopCode: 'completed' });
    expect(record.stopCode).toEqual('completed');
    expect(record.stopReason).toEqual('');
    expect(record.availability['/stopReason']).toMatchObject({ state: 'not-collected' });
    expect(record.availability['/provider']).toMatchObject({ state: 'not-collected' });
    expect(record.availability['/budget']).toMatchObject({ state: 'not-collected' });
    expect(record.error).toEqual(null);
    expect(record.tokens).toEqual(null);
  });

  it('completed keeps an observed terminal stopCode instead of rewriting it', () => {
    const record = finishAttempt({ ...base, completed: true, stopCode: 'nochange' });
    expect(record.stopCode).toEqual('nochange');
    expect(record.class).toEqual('terminal');
  });

  it('bare unclassified code goes through the unknown-certainty branch', () => {
    const record = finishAttempt({ ...base, stopCode: 'unclassified' });
    expect(record.stopCode).toEqual('unclassified');
    expect(record.class).toEqual('infrastructure');
    expect(record.error?.certainty).toEqual('unknown');
  });

  it('keeps the unrecognized stop code when error.code is also set', () => {
    const record = finishAttempt({
      ...base,
      stopCode: 'mystery-code',
      error: {
        type: 'EPIPE',
        code: 'ECONNRESET',
        providerFinishReason: null,
        source: 'worker',
        certainty: 'observed',
      },
    });
    expect(record.stopCode).toEqual('unclassified');
    expect(record.error?.code).toEqual('mystery-code');
  });

  it('preserves @-versioned model identifiers through sanitization', () => {
    const record = finishAttempt({
      ...base,
      completed: true,
      invocation: 'edit@2',
      model: { model: 'claude-3-5-sonnet-v2@20241022', provider: 'vertex' },
      provider: 'vertex',
      requestedModel: 'claude-3-5-sonnet-v2@20241022',
      servedModel: 'claude-3-5-sonnet-v2@20241023',
      priceTableRevision: 'rev@7',
    });
    expect(record.invocation).toEqual('edit@2');
    expect(record.model?.model).toEqual('claude-3-5-sonnet-v2@20241022');
    expect(record.requestedModel).toEqual('claude-3-5-sonnet-v2@20241022');
    expect(record.servedModel).toEqual('claude-3-5-sonnet-v2@20241023');
    expect(record.priceTableRevision).toEqual('rev@7');
  });

  it.each([
    ['https://user:password-http:tail@host.test/path', 'https://[redacted]@host.test/path'],
    ['https://user:password-https:tail@host.test/path', 'https://[redacted]@host.test/path'],
    ['https://user:password-wss:tail@host.test/path', 'https://[redacted]@host.test/path'],
    ['https://user:password-ftp:tail@host.test/path', 'https://[redacted]@host.test/path'],
    [
      'https://host.test/?next=https://private:password@private.test/sensitive',
      'https://host.test/?[redacted]',
    ],
    ['https://host.test/#https://private.test/sensitive', 'https://host.test/#[redacted]'],
    ['https://host.test/?next=https://private.test/sensitive', 'https://host.test/?[redacted]'],
  ])('keeps embedded schemes redacted in persisted identifiers: %s', (value, expected) => {
    const record = finishAttempt({
      ...base,
      completed: true,
      invocation: value,
      requestedModel: value,
      servedModel: value,
    });
    for (const shown of [record.invocation, record.requestedModel, record.servedModel]) {
      expect(shown).toBe(expected);
      expect(shown).not.toContain('password');
      expect(shown).not.toContain('private.test');
    }
  });

  it('redacts URL-shaped attempt identifiers without relying on env values', () => {
    const value = 'https://u:IdentifierCanary@host/x?token=IdentifierCanary';
    const record = finishAttempt({
      ...base,
      completed: true,
      invocation: value,
      requestedModel: value,
      servedModel: value,
    });
    for (const shown of [record.invocation, record.requestedModel, record.servedModel]) {
      expect(shown).toBe('https://[redacted]@host/x?[redacted]');
      expect(shown).not.toContain('IdentifierCanary');
    }
  });
});
