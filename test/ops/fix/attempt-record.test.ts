import { describe, expect, it } from 'vitest';
import {
  finishAttempt,
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

describe('sanitizeObservation', () => {
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

  it('passes numbers, booleans and null through structurally', () => {
    expect(sanitizeObservation({ a: 1, b: [true, null], c: { d: 2 } })).toEqual({
      a: 1,
      b: [true, null],
      c: { d: 2 },
    });
  });

  it('redact-before-strip kills a *_URL secret whose stripped host survives', () => {
    process.env.FAKE_HOOK_URL = 'https://tolk3n@hooks.example.test/wb';
    try {
      const out = sanitizeObservation('webhook https://tolk3n@hooks.example.test/wb fired');
      expect(out).not.toContain('tolk3n');
      expect(out).toContain('[redacted]');
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
      'base64 slash inside the secret',
      'https://user:YWJjZA==@host.example/x',
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
      'newline inside scheme userinfo',
      'https://u\nser:pw@host.example/x',
      'https://host.example/x',
    ],
    ['uppercase scheme', 'HTTPS://User:Tok@Host.Example/Path', 'HTTPS://Host.Example/Path'],
    [
      'SHA unchanged',
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ],
  ])('%s', (_name, input, expected) => {
    expect(strip(input)).toEqual(expected);
  });
});

describe('repoIdFromRemote (canonical host/path)', () => {
  const spellings = [
    'https://user:tok@GitHub.com/camerontaylor/cq-toolkit',
    'https://github.com/camerontaylor/cq-toolkit/',
    'ssh://git@github.com:22/camerontaylor/cq-toolkit.git',
    'git@github.com:camerontaylor/cq-toolkit.git',
  ];
  const ids = spellings.map((remote) => repoIdFromRemote(remote));

  it('https, scp, ssh://, .git, trailing slash and case give one digest', () => {
    expect(new Set(ids).size).toEqual(1);
    expect(ids[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('a credential never changes the digest and the raw remote never persists', () => {
    expect(repoIdFromRemote('https://github.com/camerontaylor/cq-toolkit')).toEqual(ids[0]);
    expect(ids[0]).not.toContain('github');
    expect(ids[0]).not.toContain('camerontaylor');
  });

  it('no remote gives null', () => {
    expect(repoIdFromRemote(null)).toEqual(null);
    expect(repoIdFromRemote(undefined)).toEqual(null);
    expect(repoIdFromRemote('   ')).toEqual(null);
  });
});

describe('finishAttempt', () => {
  it('classifies every STOP_CODE_CLASS row by table only', () => {
    for (const [code, expected] of STOP_CODE_CLASS) {
      const record = finishAttempt({ ...base, stopCode: code, stopReason: 'x' });
      expect(record.stopCode).toEqual(code);
      expect(record.class).toEqual(expected);
    }
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
});
