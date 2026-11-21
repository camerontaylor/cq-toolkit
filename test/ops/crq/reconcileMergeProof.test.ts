import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runGitIn } from '../../../src/adapters/crq/publishSource.js';
import { createMergeTreeRepo, type MergeTreeRepo } from '../../helpers/mergeTreeRepo.js';
import type { RunGit } from '../../../src/adapters/crq/ledgerGit.js';
import { findingDigest } from '../../../src/policy/crq/repairBinding.js';
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
    const result = await proveMerge(ctx, record(), info(actual), e, merge);
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
    await expect(proveMerge(ctx, record(), info(actual), e, merge)).rejects.toThrow(
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
    await expect(proveMerge(ctx, record(), info(actual), e, merge)).rejects.toThrow(
      'changed before',
    );
  });

  test('without a publication there is no merge-head proof and no journal read', async () => {
    const { e, events } = effects();
    const result = await proveMerge(ctx, record({ publication: undefined }), info(), e, merge);
    expect(result).toEqual({ proof: null, projected: false });
    expect(events).toEqual([]);
  });

  test('an unchanged head yields the trivial merge-head proof', async () => {
    const { e } = effects();
    const result = await proveMerge(ctx, record(), info(published), e, published);
    expect(result.projected).toBe(false);
    expect(result.proof?.get('published_head')).toBe(published);
    expect(result.proof?.get('actual_head')).toBe(published);
    expect(result.proof?.has('fixed_revalidation')).toBe(false);
  });

  test("the merge-head fallback rejects a FIXED job that is not this record's", async () => {
    const { e } = effects({
      evidence: {
        ...effects().e.evidence,
        readJob: async (id) =>
          obj({ job: id, item: ctx.itemId, run: ctx.run, finding: { path: 'src/a.ts' } }),
      },
    });
    await expect(
      proveMerge(ctx, record({ jobs: ['crq-j2'] }), info(published), e, merge),
    ).rejects.toThrow('identity mismatch');
    const other = effects({
      evidence: {
        ...effects().e.evidence,
        readJob: async (id) =>
          obj({ job: id, item: 'other', run: ctx.run, finding: { path: 'src/a.ts' } }),
      },
    });
    await expect(proveMerge(ctx, record(), info(published), other.e, merge)).rejects.toThrow(
      'identity mismatch',
    );
  });

  test('saved journal revalidation is validated, not merge-head evidence', async () => {
    const saved = obj({ ...publication, fixed_revalidation: { reason: 'r' } });
    const { e } = effects({ journal: saved });
    // The revalidation path runs validateFixedEvidence, which refuses a non-published record.
    await expect(proveMerge(ctx, record({ state: 'merged' }), info(), e, merge)).rejects.toThrow(
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
    await expect(proveMerge(ctx, record(), info(), e, merge)).rejects.toThrow(
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
    await expect(proveMerge(ctx, record(), info(), e, merge)).rejects.toThrow(
      'legacy repair job identity mismatch',
    );
  });

  test('a FIXED verdict whose job the record does not own is refused', async () => {
    const saved = obj({ ...publication, fixed_revalidation: { reason: 'r' } });
    const { e } = effects({ journal: saved });
    await expect(proveMerge(ctx, record({ jobs: ['crq-j2'] }), info(), e, merge)).rejects.toThrow(
      'legacy repair job identity mismatch',
    );
  });

  test('a journal without revalidation falls back to merge-head evidence', async () => {
    const saved = obj({ ...publication });
    const { e } = effects({ journal: saved });
    const result = await proveMerge(ctx, record(), info(published), e, published);
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

describe('canonical projection and explicit revalidation stay independent of the merge tree', () => {
  const unreachable = '9'.repeat(40);
  const noTreeReads = (): { git: RunGit; calls: string[][] } => {
    const calls: string[][] = [];
    return {
      calls,
      git: async (args) => {
        calls.push([...args]);
        throw new Error('merge-tree seam must not be read on this path');
      },
    };
  };
  test('a canonical projection is proven without reading the merge tree', async () => {
    const { git, calls } = noTreeReads();
    const { e } = effects({
      git,
      canonical: {
        readJob: async (id) => obj({ job: id, canonical_finding_id: fid }),
        triageExists: async () => true,
        currentFixedEvent: async () => 'ev-1',
        isAncestor: async () => true,
      },
    });
    const result = await proveMerge(ctx, record(), info(actual), e, unreachable);
    expect(result.projected).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('proveMerge verifies the forge merge commit tree', () => {
  let repo: MergeTreeRepo;
  beforeAll(async () => {
    repo = await createMergeTreeRepo();
  });
  afterAll(async () => {
    await repo.cleanup();
  });
  const prove = (merge: string) => {
    const { e } = effects({ git: runGitIn(repo.dir) });
    const pub = {
      ...publication,
      head: repo.published,
      commits: [repo.published],
    };
    const rec = record({ publication: pub });
    const pr = obj({
      number: 42,
      state: 'MERGED',
      headRefOid: repo.published,
      mergeCommit: { oid: merge },
    });
    return proveMerge(
      ctx,
      rec,
      pr,
      {
        ...e,
        evidence: {
          ...e.evidence,
          readJob: async (id) =>
            obj({ job: id, item: ctx.itemId, run: ctx.run, finding: { path: repo.path } }),
        },
      },
      merge,
    );
  };
  test.each([
    ['a plain merge that keeps the repair', 'kept', true],
    ['a squash merge', 'squashed', true],
    ['a merge that drops the repair', 'dropped', false],
    ['a merge commit whose tree reverted the repair', 'revertTip', false],
    ['a reachable commit with no repair', 'wrong', false],
    ['an unreachable merge', 'unreachable', false],
  ] as const)('%s', async (_name, shape, credited) => {
    const merge = repo[shape];
    if (credited) {
      const result = await prove(merge);
      expect(result.projected).toBe(false);
      expect(toPlainJson(result.proof ?? null)).toMatchObject({
        published_head: repo.published,
        actual_head: repo.published,
        match: 'containment',
      });
    } else await expect(prove(merge)).rejects.toThrow(/needs revalidation|evidence unavailable/);
  });
  test('an explicit saved revalidation is credited on its own evidence for a merge the tree check refuses', async () => {
    const merge = repo.dropped;
    // Counterfactual: the same merge, with no revalidation, is refused on its tree.
    await expect(prove(merge)).rejects.toThrow('needs revalidation');
    const finding = obj({ path: repo.path });
    const entry = (commit: string): string[] => [
      '100644',
      repo.git('rev-parse', `${commit}:${repo.path}`),
    ];
    const evidence = obj({
      job: 'crq-j1',
      item: ctx.itemId,
      run: ctx.run,
      finding_sha256: findingDigest(finding),
      pr: 42,
      published_head: repo.published,
      actual_head: repo.published,
      merge_commit: merge,
      source_sha: merge,
      sources: {
        [repo.path]: {
          published: entry(repo.published),
          actual: entry(repo.published),
          current: entry(merge),
        },
      },
      verdict: 'fixed',
      reviewer: 'human-reviewer',
      reason: 'the dropped line was re-implemented elsewhere',
    });
    const pub = { ...publication, head: repo.published, commits: [repo.published] };
    const treeReads: string[][] = [];
    const realGit = runGitIn(repo.dir);
    const { e } = effects({
      journal: obj({ ...pub, fixed_revalidation: toPlainJson(evidence) }),
      git: async (args, options) => {
        treeReads.push([...args]);
        return realGit(args, options);
      },
    });
    const result = await proveMerge(
      ctx,
      record({ publication: pub }),
      obj({
        number: 42,
        state: 'MERGED',
        headRefOid: repo.published,
        mergeCommit: { oid: merge },
      }),
      {
        ...e,
        evidence: {
          ...e.evidence,
          git: realGit,
          resolveTarget: async () => merge,
          readJob: async (id) =>
            obj({ job: id, item: ctx.itemId, run: ctx.run, finding: toPlainJson(finding) }),
        },
      },
      merge,
    );
    expect(result.projected).toBe(false);
    expect(toPlainJson(result.proof ?? null)).toEqual({
      fixed_revalidation: toPlainJson(evidence),
    });
    expect(treeReads).toEqual([]);
  });
  test('the merge commit reaches the git evidence calls, not only the PR head', async () => {
    const calls: string[][] = [];
    const real = runGitIn(repo.dir);
    const { e } = effects({
      git: async (args, options) => {
        calls.push([...args]);
        return real(args, options);
      },
    });
    await proveMerge(
      ctx,
      record({ publication: { ...publication, head: repo.published, commits: [repo.published] } }),
      obj({
        number: 42,
        state: 'MERGED',
        headRefOid: repo.published,
        mergeCommit: { oid: repo.kept },
      }),
      e,
      repo.kept,
    );
    expect(calls.some((a) => a[0] === 'ls-tree' && a[2] === repo.kept)).toBe(true);
  });
});
