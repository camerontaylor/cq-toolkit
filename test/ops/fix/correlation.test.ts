// ADR-0008 T05 focused tests (measurement slice M5a): correlation UUID
// allocation and persistence against the merged strict schema. Fake/local
// inputs only — no live providers, network or credentials.
import { describe, expect, it } from 'vitest';
import { CorrelationRecordSchema } from '../../../src/kernel/schema.js';
import { resolveCorrelation } from '../../../src/ops/fix/correlation.js';

describe('T05 round-trip', () => {
  it('allocates a fresh UUID correlation that survives the strict persistence schema', () => {
    const first = resolveCorrelation({ branch: 'feat/demo' });
    const second = resolveCorrelation({ branch: 'feat/demo' });
    expect(first.workId).not.toBe(second.workId);
    expect(() => CorrelationRecordSchema.parse(first)).not.toThrow();
    expect(first.parentWorkId).toBeNull();
    expect(first.commitSha).toBeNull();
    expect(first.sessionId).toBeNull();
    expect(first.agentId).toBeNull();
  });

  it('records the supplied branch and never derives identity from it', () => {
    const a = resolveCorrelation({ branch: 'feat/one' });
    const b = resolveCorrelation({ branch: 'feat/two' });
    expect(a.branch).toBe('feat/one');
    expect(b.branch).toBe('feat/two');
    expect(a.workId).not.toBe(b.workId);
    // Different branches, still no shared or branch-derived identity.
    expect(a.workId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('restores an exact inbound record verbatim (R14 must see the same ids)', () => {
    const original = resolveCorrelation({ branch: 'feat/demo' });
    const restored = resolveCorrelation({ branch: 'feat/demo', restored: original });
    expect(restored).toEqual(original);
    expect(restored.workId).toBe(original.workId);
  });
});

describe('T05 unknown evidence', () => {
  it('leaves unobserved fields null, never zero-shaped guesses', () => {
    const correlation = resolveCorrelation({ branch: 'feat/demo' });
    expect(correlation.parentWorkId).toBeNull();
    expect(correlation.commitSha).toBeNull();
    expect(correlation.sessionId).toBeNull();
    expect(correlation.agentId).toBeNull();
  });

  it('keeps an explicit unknown parent null in a restored record', () => {
    const correlation = resolveCorrelation({
      branch: 'feat/demo',
      restored: {
        workId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        parentWorkId: null,
        branch: 'feat/demo',
        commitSha: null,
        sessionId: null,
        agentId: null,
      },
    });
    expect(CorrelationRecordSchema.parse(correlation)).toEqual(correlation);
  });
});

describe('T05 failure boundary', () => {
  it('refuses an invalid branch instead of persisting a malformed record', () => {
    // CorrelationRecordSchema branch is a plain string; the failure boundary
    // is a non-string caller input reaching the validated record.
    expect(() =>
      resolveCorrelation({
        branch: undefined as unknown as string,
      }),
    ).toThrow(/invalid correlation record/);
  });

  it('refuses a restored record with a non-UUID workId', () => {
    expect(() =>
      resolveCorrelation({
        branch: 'feat/demo',
        restored: {
          workId: 'not-a-uuid',
          parentWorkId: null,
          branch: 'feat/demo',
          commitSha: null,
          sessionId: null,
          agentId: null,
        },
      }),
    ).toThrow(/invalid correlation record/);
  });
});
