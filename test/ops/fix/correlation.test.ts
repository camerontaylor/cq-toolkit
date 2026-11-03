// ADR-0008 T05 focused tests (measurement slice M5a): correlation UUID
// allocation and schema validation against the merged strict schema. The
// writer/caller persistence seam (T04/T30/T31) is not on main yet, so these
// exercise the record's shape and semantics, not a persisted stream. Fake
// local inputs only — no live providers, network or credentials.
import { describe, expect, it } from 'vitest';
import { CorrelationRecordSchema } from '../../../src/kernel/schema.js';
import {
  resolveCorrelation,
  type ResolveCorrelationInput,
} from '../../../src/ops/fix/correlation.js';

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

  it('restores work IDs verbatim and keeps the caller branch (R14 must see the same ids)', () => {
    const original = resolveCorrelation({ branch: 'feat/demo' });
    const restored = resolveCorrelation({
      branch: 'feat/demo',
      restored: original,
    });
    expect(restored.workId).toBe(original.workId);
    expect(restored.parentWorkId).toBe(original.parentWorkId);
    expect(restored.branch).toBe('feat/demo');
  });

  it("rejects a restored record whose branch differs from this run's branch", () => {
    const original = resolveCorrelation({ branch: 'feat/one' });
    expect(() => resolveCorrelation({ branch: 'feat/two', restored: original })).toThrow(
      /does not match this run's branch/,
    );
  });

  it('re-nulls stale operational fields on restore (only work IDs survive)', () => {
    const stale = resolveCorrelation({
      branch: 'feat/demo',
      // A stored record carries operational fields too; the restore input's
      // Pick type excludes them, so the cast proves excess fields never leak
      // through the boundary type at compile time and re-null at runtime.
      restored: {
        workId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        parentWorkId: '0f9d8c7b-6a59-4837-a211-9f8e7d6c5b4a',
        branch: 'feat/demo',
        commitSha: 'a'.repeat(40),
        sessionId: 'stale-session',
        agentId: 'stale-agent',
      } as unknown as NonNullable<ResolveCorrelationInput['restored']>,
    });
    expect(stale.workId).toBe('7c9e6679-7425-40de-944b-e07fc1f90ae7');
    expect(stale.parentWorkId).toBe('0f9d8c7b-6a59-4837-a211-9f8e7d6c5b4a');
    expect(stale.commitSha).toBeNull();
    expect(stale.sessionId).toBeNull();
    expect(stale.agentId).toBeNull();
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

  it('keeps an explicit parent null in a restored record', () => {
    const correlation = resolveCorrelation({
      branch: 'feat/demo',
      restored: {
        workId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        parentWorkId: null,
        branch: 'feat/demo',
      },
    });
    expect(CorrelationRecordSchema.parse(correlation)).toEqual(correlation);
    expect(correlation.parentWorkId).toBeNull();
  });
});

describe('T05 failure boundary', () => {
  it('refuses a restored record with a non-UUID workId instead of persisting it', () => {
    expect(() =>
      resolveCorrelation({
        branch: 'feat/demo',
        restored: {
          workId: 'not-a-uuid',
          parentWorkId: null,
          branch: 'feat/demo',
        },
      }),
    ).toThrow(/invalid correlation record/);
  });

  it('refuses a restored record with a null parentWorkId only when the shape is invalid', () => {
    // A null parent is legal for a root work (T05 unknown evidence); the
    // boundary this pins is a structurally invalid restore, e.g. a
    // non-null parentWorkId that is not a UUID.
    expect(() =>
      resolveCorrelation({
        branch: 'feat/demo',
        restored: {
          workId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          parentWorkId: 'not-a-uuid-either',
          branch: 'feat/demo',
        },
      }),
    ).toThrow(/invalid correlation record/);
  });
});
