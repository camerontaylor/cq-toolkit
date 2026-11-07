import { describe, expect, test } from 'vitest';
import { readCqEnv } from '../../src/config/env.js';
import { provenanceConfig } from '../../src/config/provenance.js';
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
  };
  const config = provenanceConfig(readCqEnv(env), env);

  test('records env-sourced values, secrets as set, no defaults or identity', () => {
    expect(config.env['CQ_SANDBOX']).toBe('off');
    expect(config.env['CQ_AUTOMATION_TOKEN']).toBe('set');
    expect(config.env['ZAI_API_KEY']).toBe('set');
    expect(config.env).not.toHaveProperty('ZAI_BASE_URL');
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

  test('an empty environment records nothing', () => {
    expect(provenanceConfig(readCqEnv({}), {})).toEqual({ env: {}, sources: {}, warnings: [] });
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
    expect(ProvenanceRecordSchema.safeParse({ ...base, config, extra: 1 }).success).toBe(false);
  });
});
