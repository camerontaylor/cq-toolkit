import { describe, expect, test } from 'vitest';
import { readCqEnv } from '../../src/config/env.js';
import { provenanceConfig } from '../../src/config/provenance.js';
import { CQ_ENV_ENTRIES } from '../../src/config/env-registry.js';
import { ProvenanceConfigSchema, ProvenanceRecordSchema } from '../../src/kernel/schema.js';

// Built at runtime: the denylist scans committed text for token shapes.
const fakeToken = ['tok', 'en', '-', 'abc123', 'xyz'].join('');
const fakeForeign = ['fo', 'reign', '-', 'secret', '-', '987'].join('');

describe('provenanceConfig', () => {
  const env = {
    CQ_SANDBOX: 'off',
    CQ_AUTOMATION_TOKEN: fakeToken,
    CQ_WORK_ID: '3f2b8c1e-1111-4222-8333-444455556666',
    CQ_SANBOX: 'x',
    ZAI_API_KEY: fakeForeign,
    ZAI_BASE_URL: 'https://example.invalid',
    GH_REPOSITORY: 'owner/repo',
    GITHUB_REPOSITORY: 'owner/repo',
  };
  const config = provenanceConfig(readCqEnv(env));

  test('records env-sourced values, secrets as set, no defaults or identity', () => {
    expect(config.env['CQ_SANDBOX']).toBe('off');
    expect(config.env['CQ_AUTOMATION_TOKEN']).toBe('set');
    expect(config.env['ZAI_API_KEY']).toBe('set');
    expect(config.env['ZAI_BASE_URL']).toBe('https://example.invalid/'); // _URL is not a secret suffix
    expect(config.env).not.toHaveProperty('GH_REPOSITORY');
    expect(config.env).not.toHaveProperty('GITHUB_REPOSITORY');
    expect(config.env).not.toHaveProperty('CQ_WORK_ID');
    expect(Object.keys(config.env).length).toBe(Object.keys(config.sources).length);
    expect(config.sources['CQ_SANDBOX']).toBe('env');
  });

  test('records warnings as text and never a secret value', () => {
    expect(config.warnings.some((w) => w.includes('CQ_SANBOX'))).toBe(true);
    const text = JSON.stringify(config);
    expect(text).not.toContain(fakeToken);
    expect(text).not.toContain(fakeForeign);
  });

  test('caps a long non-secret value with a marker and the original length', () => {
    const long = 'x'.repeat(500);
    const capped = provenanceConfig(readCqEnv({ CQ_GH_BIN: long })).env['CQ_GH_BIN'];
    expect(capped).toBe(`${'x'.repeat(200)}… (500 chars)`);
    const short = provenanceConfig(readCqEnv({ CQ_GH_BIN: 'gh' })).env['CQ_GH_BIN'];
    expect(short).toBe('gh');
  });

  test('an errored snapshot is refused, never recorded as absent', () => {
    expect(() => provenanceConfig(readCqEnv({ CQ_SANDBOX: 'of' }))).toThrow(/CQ_SANDBOX/);
  });

  test('an empty environment records nothing', () => {
    expect(provenanceConfig(readCqEnv({}))).toEqual({ env: {}, sources: {}, warnings: [] });
  });
});

describe('provenanceConfig is schema-valid for every registry entry', () => {
  const SAMPLES = [
    'off',
    'on',
    'required',
    'model-only',
    'bwrap',
    'zai/glm-5',
    '1',
    '123',
    '/tmp/x',
    'a,b',
    'alias',
    'APPROVED',
    'OWNER',
    'human',
    'refs/heads/main',
    'owner/repo',
    'x',
  ];
  test('every non-secret and secret entry, one at a time and all together', () => {
    const all: Record<string, string> = {};
    for (const entry of CQ_ENV_ENTRIES) {
      if (entry.status !== 'live') continue;
      const sample = SAMPLES.find((candidate) => {
        try {
          entry.parse(candidate);
          return true;
        } catch {
          return false;
        }
      });
      expect(sample, `${entry.name}: add a valid sample`).toBeDefined();
      all[entry.name] = sample as string;
      const one = provenanceConfig(readCqEnv({ [entry.name]: sample as string }));
      expect(ProvenanceConfigSchema.safeParse(one).success, entry.name).toBe(true);
      for (const value of Object.values(one.env)) expect(typeof value).toBe('string');
    }
    const combined = provenanceConfig(readCqEnv(all));
    expect(ProvenanceConfigSchema.safeParse(combined).success).toBe(true);
  });

  test('a model spec is recorded as provider/model text', () => {
    const rec = provenanceConfig(
      readCqEnv({ CQ_SELFHOST_DRIVER: 'zai/glm-5', CQ_SELFHOST_PEAK_DRIVER: 'a/b' }),
    );
    expect(rec.env['CQ_SELFHOST_DRIVER']).toBe('zai/glm-5');
    expect(rec.env['CQ_SELFHOST_PEAK_DRIVER']).toBe('a/b');
  });

  test('a list and a number are recorded as text', () => {
    const rec = provenanceConfig(
      readCqEnv({ CQ_MERGE_TRUSTED_BOTS: 'bot-a,bot-b', CQ_SELFHOST_NOW_MS: '1700000000000' }),
    );
    expect(typeof rec.env['CQ_MERGE_TRUSTED_BOTS']).toBe('string');
    expect(rec.env['CQ_SELFHOST_NOW_MS']).toBe('1700000000000');
  });

  test('resolve once: a later change to process.env does not alter the record', () => {
    const snapshot = readCqEnv({ CQ_SANDBOX: 'off' });
    const before = JSON.stringify(provenanceConfig(snapshot));
    const saved = process.env['ZAI_API_KEY'];
    const savedSandbox = process.env['CQ_SANDBOX'];
    process.env['ZAI_API_KEY'] = fakeForeign;
    process.env['CQ_SANDBOX'] = 'required';
    try {
      expect(JSON.stringify(provenanceConfig(snapshot))).toBe(before);
    } finally {
      if (savedSandbox === undefined) delete process.env['CQ_SANDBOX'];
      else process.env['CQ_SANDBOX'] = savedSandbox;
      if (saved === undefined) delete process.env['ZAI_API_KEY'];
      else process.env['ZAI_API_KEY'] = saved;
    }
  });

  test('the foreign-secret scan follows the env passed to readCqEnv, not ambient', () => {
    const rec = provenanceConfig(readCqEnv({ ZAI_API_KEY: fakeForeign }));
    expect(rec.env['ZAI_API_KEY']).toBe('set');
    expect(provenanceConfig(readCqEnv({})).env).not.toHaveProperty('ZAI_API_KEY');
  });
});

describe('provenance schema config', () => {
  const base = {
    cqVersion: '0.2.0',
    producerVersion: '0.2.0',
    repoId: null,
    cqJsonHash: `sha256:${'a'.repeat(64)}`,
    baseSha: 'b'.repeat(40),
    runPrefix: 'p',
    startedAt: '2026-01-03T04:05:06.789Z',
    endedAt: null,
    journalLink: 'unavailable',
    reportLink: 'unavailable',
    witnesses: {
      base: 'b'.repeat(40),
      admitted: null,
      execution: null,
      reviewed: null,
      accepted: null,
    },
  };
  const config = { env: { CQ_SANDBOX: 'off' }, sources: { CQ_SANDBOX: 'env' }, warnings: [] };

  test('accepts provenance with and without config', () => {
    expect(ProvenanceRecordSchema.safeParse(base).success).toBe(true);
    expect(ProvenanceRecordSchema.safeParse({ ...base, config }).success).toBe(true);
  });

  test('rejects unknown keys inside config and at the record', () => {
    expect(ProvenanceConfigSchema.safeParse({ ...config, extra: 1 }).success).toBe(false);
    expect(ProvenanceConfigSchema.safeParse({ ...config, env: { CQ_SANDBOX: 1 } }).success).toBe(
      false,
    );
    expect(ProvenanceRecordSchema.safeParse({ ...base, config, extra: 1 }).success).toBe(false);
  });
});
