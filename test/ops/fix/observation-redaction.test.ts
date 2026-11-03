import { afterEach, describe, expect, it } from 'vitest';
import {
  finishAttempt,
  repoIdFromRemote,
  sanitizeObservation,
} from '../../../src/ops/fix/attemptRecord.js';
import { AttemptFinishedPayloadSchema } from '../../../src/kernel/schema.js';

// Fake/local fixtures only: no repositories, providers or credentials.
const savedEnv: Record<string, string | undefined> = {};
function withFakeEnv(name: string, value: string): void {
  savedEnv[name] = process.env[name];
  process.env[name] = value;
}
afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('observation redaction (T12)', () => {
  it('redacts environment secret values in persisted text fields', () => {
    withFakeEnv('FAKE_OBSERVATION_SECRET', 'hushhushsecretvalue');
    const out = sanitizeObservation({
      stopReason: 'model said hushhushsecretvalue aloud',
      reason: 'env hushhushsecretvalue echoed by vendor SDK',
      nested: { error: { type: 'hushhushsecretvalue' } },
    });
    expect(out).toEqual({
      stopReason: 'model said [redacted] aloud',
      reason: 'env [redacted] echoed by vendor SDK',
      nested: { error: { type: '[redacted]' } },
    });
  });

  it('strips credential URLs in error and provenance strings', () => {
    const out = sanitizeObservation({
      error: 'fetch failed for https://ci-bot:hunter2@git.example.com/acme/repo?token=abc',
      provenance: 'cloned from https://deploy:s3cret@git.example.com/acme/repo',
    });
    expect(out.error).toEqual('fetch failed for https://git.example.com/acme/repo');
    expect(out.provenance).toEqual('cloned from https://git.example.com/acme/repo');
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('s3cret');
  });

  it('redacts stop text and preserves structure', () => {
    withFakeEnv('FAKE_STOP_TOKEN', 'leaky-leaky');
    const out = sanitizeObservation(['worker stopped: leaky-leaky', 'plain stop text survives']);
    expect(out).toEqual(['worker stopped: [redacted]', 'plain stop text survives']);
  });

  it('repo identifiers expose only the opaque digest', () => {
    const id = repoIdFromRemote('ssh://git@github.com/camerontaylor/cq-toolkit.git');
    expect(id.repoId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(id.repoId).not.toContain('camerontaylor');
    expect(id).toEqual(repoIdFromRemote('ssh://github.com/camerontaylor/cq-toolkit.git'));
    expect(repoIdFromRemote(undefined)).toEqual({ repoId: null, reason: 'no-remote' });
  });
});

describe('finishAttempt schema conformance (T12)', () => {
  const base = {
    tier: 'worker' as const,
    invocation: 'edit',
    model: { model: 'fake-model', provider: 'fake' },
  };

  it('completed payload parses strict', () => {
    const record = finishAttempt({
      ...base,
      completed: true,
      stopReason: 'task completed',
      tokens: 15,
      wallMs: 900,
    });
    expect(AttemptFinishedPayloadSchema.parse(record)).toEqual(record);
  });

  it('budget-expired payload parses strict with required budgetStopCode', () => {
    const record = finishAttempt({
      ...base,
      budgetExpired: true,
      budgetStopCode: 'token-cap',
      budget: {
        allowed: { tokens: 1000, wallMs: 60000 },
        spent: { tokens: 1000, wallMs: 40000 },
        remaining: { tokens: 0, wallMs: 20000 },
      },
    });
    expect(record.stopCode).toEqual('token-cap');
    expect(AttemptFinishedPayloadSchema.parse(record)).toEqual(record);
  });

  it('unclassified payload parses strict and preserves the raw code', () => {
    const record = finishAttempt({ ...base, stopCode: 'mystery', stopReason: 'boom' });
    expect(record.stopCode).toEqual('unclassified');
    expect(record.error?.code).toEqual('mystery');
    expect(AttemptFinishedPayloadSchema.parse(record)).toEqual(record);
  });

  it('minimal payload parses strict with availability for absent required fields', () => {
    const record = finishAttempt({ ...base, stopCode: 'completed' });
    expect(record.availability['/stopReason']).toMatchObject({ state: 'not-collected' });
    expect(record.availability['/provider']).toMatchObject({ state: 'not-collected' });
    expect(record.availability['/requestedModel']).toMatchObject({ state: 'not-collected' });
    expect(record.availability['/budget']).toMatchObject({ state: 'not-collected' });
    expect(AttemptFinishedPayloadSchema.parse(record)).toEqual(record);
  });
});
