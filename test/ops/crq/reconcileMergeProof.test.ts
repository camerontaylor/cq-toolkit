import { describe, expect, test } from 'vitest';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  proveMerge,
  recheckRevalidation,
  type MergeProofEffects,
} from '../../../src/ops/crq/internal/reconcileMergeProof.js';

const fid = 'f'.repeat(64);
const published = 'b'.repeat(40);
const actual = 'c'.repeat(40);
const merge = 'a'.repeat(40);
const ctx = { itemId: 'item-1', run: 'run-1' };

function obj(value: unknown): JsonObject {
  const v = parseJsonValue(JSON.stringify(value));
  if (!(v instanceof JsonObject)) throw new Error('not object');
  return v;
}
const publication = {
  head: published,
  commits: [published],
  target: 't',
  branch: 'b',
  open_pr: 7,
  source_resolutions: ['crq-j1'],
};
function record(extra: Record<string, unknown> = {}): JsonObject {
  return obj({
    jobs: ['crq-j1'],
    state: 'published',
    fix_pr: { number: 42 },
    verdicts: [{ job: 'crq-j1', verdict: 'FIXED' }],
    publication,
    ...extra,
  });
}
const info = (head = published): JsonObject =>
  obj({ number: 42, state: 'MERGED', headRefOid: head, mergeCommit: { oid: merge } });

function effects(over: Partial<MergeProofEffects> & { journal?: JsonObject | null } = {}): {
  e: MergeProofEffects;
  events: string[];
} {
  const events: string[] = [];
  const { journal = null, ...rest } = over;
  const e: MergeProofEffects = {
    canonical: {
      readJob: async (id) => obj({ job: id, canonical_finding_id: fid }),
      triageExists: async () => false,
      currentFixedEvent: async () => 'ev-1',
      isAncestor: async () => true,
    },
    evidence: {
      git: async (args) => ({ args, code: 0, stdout: new Uint8Array(), stderr: '' }),
      readJob: async (id) =>
        obj({ job: id, item: ctx.itemId, run: ctx.run, finding: { path: 'src/a.ts' } }),
      readTriage: async () => null,
      resolveTarget: async () => 'd'.repeat(40),
      ensureCommit: async () => true,
    },
    git: async (args) => ({ args, code: 0, stdout: new Uint8Array(), stderr: '' }),
    readSavedJournal: async () => {
      events.push('journal');
      return journal;
    },
    prInfo: async (n) => {
      events.push(`pr:${JSON.stringify(toPlainJson(n ?? null))}`);
      return info();
    },
    ...rest,
  };
  return { e, events };
}

describe('proveMerge', () => {
  test('canonical terminal truth projects with the Python proof shape', async () => {
    const { e } = effects({
      canonical: {
        readJob: async (id) => obj({ job: id, canonical_finding_id: fid }),
        triageExists: async () => true,
        currentFixedEvent: async () => 'ev-1',
        isAncestor: async () => true,
      },
    });
    const result = await proveMerge(ctx, record(), info(actual), e);
    expect(result.projected).toBe(true);
    expect(result.proof?.entries.map(([k]) => k)).toEqual([
      'published_head',
      'actual_head',
      'canonical_fixed_events',
    ]);
    expect(result.proof?.get('actual_head')).toBe(actual);
  });

  test('a canonical row that moves between the two reads is refused', async () => {
    let n = 0;
    const { e } = effects({
      canonical: {
        readJob: async (id) => obj({ job: id, canonical_finding_id: fid }),
        triageExists: async () => true,
        currentFixedEvent: async () => `ev-${++n}`,
        isAncestor: async () => true,
      },
    });
    await expect(proveMerge(ctx, record(), info(actual), e)).rejects.toThrow(
      'canonical fixed finding changed before source feedback',
    );
  });

  test('the second canonical read going null is also a change', async () => {
    let n = 0;
    const { e } = effects({
      canonical: {
        readJob: async (id) => obj({ job: id, canonical_finding_id: fid }),
        triageExists: async () => true,
        currentFixedEvent: async () => (++n > 1 ? null : 'ev-1'),
        isAncestor: async () => true,
      },
    });
    await expect(proveMerge(ctx, record(), info(actual), e)).rejects.toThrow('changed before');
  });

  test('without a publication there is no merge-head proof and no journal read', async () => {
    const { e, events } = effects();
    const result = await proveMerge(ctx, record({ publication: undefined }), info(), e);
    expect(result).toEqual({ proof: null, projected: false });
    expect(events).toEqual([]);
  });

  test('an unchanged head yields the trivial merge-head proof', async () => {
    const { e } = effects();
    const result = await proveMerge(ctx, record(), info(published), e);
    expect(result.projected).toBe(false);
    expect(result.proof?.get('published_head')).toBe(published);
    expect(result.proof?.get('actual_head')).toBe(published);
    expect(result.proof?.has('fixed_revalidation')).toBe(false);
  });

  test('saved journal revalidation is validated, not merge-head evidence', async () => {
    const saved = obj({ ...publication, fixed_revalidation: { reason: 'r' } });
    const { e } = effects({ journal: saved });
    // The revalidation path runs validateFixedEvidence, which refuses a non-published record.
    await expect(proveMerge(ctx, record({ state: 'merged' }), info(), e)).rejects.toThrow(
      'expected one unresolved published FIXED job',
    );
  });

  test('saved journal revalidation must match the record identity', async () => {
    const saved = obj({
      ...publication,
      head: 'e'.repeat(40),
      fixed_revalidation: { reason: 'r' },
    });
    const { e } = effects({ journal: saved });
    await expect(proveMerge(ctx, record(), info(), e)).rejects.toThrow(
      'publication journal identity mismatch',
    );
  });

  test('a job bound to another run is refused before the evidence is checked', async () => {
    const saved = obj({ ...publication, fixed_revalidation: { reason: 'r' } });
    const { e } = effects({
      journal: saved,
      evidence: {
        ...effects().e.evidence,
        readJob: async (id) => obj({ job: id, item: ctx.itemId, run: 'other', finding: {} }),
      },
    });
    await expect(proveMerge(ctx, record(), info(), e)).rejects.toThrow(
      'legacy repair job identity mismatch',
    );
  });

  test('a FIXED verdict whose job the record does not own is refused', async () => {
    const saved = obj({ ...publication, fixed_revalidation: { reason: 'r' } });
    const { e } = effects({ journal: saved });
    await expect(proveMerge(ctx, record({ jobs: ['crq-j2'] }), info(), e)).rejects.toThrow(
      'legacy repair job identity mismatch',
    );
  });

  test('a journal without revalidation falls back to merge-head evidence', async () => {
    const saved = obj({ ...publication });
    const { e } = effects({ journal: saved });
    const result = await proveMerge(ctx, record(), info(published), e);
    expect(result.proof?.has('source_blobs')).toBe(true);
  });
});

describe('recheckRevalidation', () => {
  const evidence: JsonValue = obj({ reason: 'r' });
  const saved = (rev: unknown) => obj({ ...publication, fixed_revalidation: rev });

  test('a changed journal revalidation is refused before any forge read', async () => {
    const { e, events } = effects({ journal: saved({ reason: 'other' }) });
    await expect(recheckRevalidation(ctx, record(), evidence, e)).rejects.toThrow(
      'fixed revalidation changed',
    );
    expect(events).toEqual(['journal']);
  });

  test('re-reads the PR fresh by the fix PR number, then validates against it', async () => {
    const { e, events } = effects({ journal: saved({ reason: 'r' }) });
    await expect(
      recheckRevalidation(ctx, record({ state: 'merged' }), evidence, e),
    ).rejects.toThrow('expected one unresolved published FIXED job');
    expect(events).toEqual(['journal', 'pr:42']);
  });

  test('a missing journal is an error, not a pass', async () => {
    const { e } = effects();
    await expect(recheckRevalidation(ctx, record(), evidence, e)).rejects.toThrow(
      'publication journal missing',
    );
  });

  test('journal missing its revalidation is refused when the record carries one', async () => {
    const withRev = record({
      publication: { ...publication, fixed_revalidation: { reason: 'r' } },
    });
    const { e } = effects({ journal: obj({ ...publication }) });
    await expect(recheckRevalidation(ctx, withRev, evidence, e)).rejects.toThrow(
      'publication revalidation missing from journal',
    );
  });

  test('a resolution recorded on the record but absent from the journal is refused', async () => {
    const { e } = effects({
      journal: obj({ ...publication, source_resolutions: [], fixed_revalidation: { reason: 'r' } }),
    });
    await expect(recheckRevalidation(ctx, record(), evidence, e)).rejects.toThrow(
      'publication resolutions contradict journal',
    );
  });
});
