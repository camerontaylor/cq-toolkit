import { describe, expect, it } from 'vitest';
import {
  finishAttempt,
  repoIdFromRemote,
  sanitizeObservation,
} from '../../../src/ops/fix/attemptRecord.js';

// Fake/local fixtures only: no repositories, providers or credentials.
const completed = {
  tier: 'worker' as const,
  attempt: 1,
  invocation: 'edit' as const,
  model: 'fake-model',
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
});

describe('repoIdFromRemote', () => {
  it('hashes the normalized credential-free remote, never the raw remote', () => {
    const id = repoIdFromRemote('https://user:token@github.com/camerontaylor/cq-toolkit');
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(id).not.toContain('github');
    expect(id).toEqual(repoIdFromRemote('https://github.com/camerontaylor/cq-toolkit'));
  });

  it('normalizes scp-style remotes to the same digest and handles no remote', () => {
    const scp = repoIdFromRemote('git@github.com:camerontaylor/cq-toolkit.git');
    expect(scp).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(scp).not.toContain('github.com');
    expect(repoIdFromRemote(null)).toEqual(null);
    expect(repoIdFromRemote('   ')).toEqual(null);
  });
});

describe('finishAttempt', () => {
  it('classifies a successful terminal attempt as terminal/completed', () => {
    const record = finishAttempt({ ...completed, completed: true });
    expect(record.stopCode).toEqual('completed');
    expect(record.class).toEqual('terminal');
  });

  it('T12 failure boundary', () => {
    // Budget expiry takes precedence over observed completion per ADR-0008.
    const budget = finishAttempt({
      ...completed,
      completed: true,
      budgetExpired: true,
      budgetStopCode: 'wall-cap',
      stopReason: 'wall budget exhausted mid-edit',
    });
    expect(budget.stopCode).toEqual('wall-cap');
    expect(budget.class).toEqual('budget');
    expect(budget.stopReason).toEqual('wall budget exhausted mid-edit');

    // Unrecognized stop code is infrastructure / unclassified, not candidate failure.
    const unknown = finishAttempt({
      ...completed,
      stopCode: 'mystery-code',
      stopReason: 'worker stopped: mystery-code',
    });
    expect(unknown.stopCode).toEqual('unclassified');
    expect(unknown.class).toEqual('infrastructure');
  });

  it('T12 unknown evidence', () => {
    const record = finishAttempt({ ...completed });
    expect(record.stopCode).toEqual(null);
    expect(record.stopReason).toEqual(null);
    expect(record.class).toEqual(null);
    expect(record.error).toEqual(null);
    expect(record.timeout).toEqual(null);
    expect(record.budget).toEqual(null);
    expect(record.provider).toEqual(null);
    expect(record.tokens).toEqual(null);
  });
});
