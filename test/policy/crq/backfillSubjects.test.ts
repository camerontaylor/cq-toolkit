import { describe, expect, test } from 'vitest';
import { JsonNumber } from '../../../src/policy/crq/jsonValue.js';
import { ledgerJsonDigest, ledgerJsonText } from '../../../src/policy/crq/pythonJson.js';
import {
  construct,
  type BackfillSubjectRepo,
  type SubjectInventoryRow,
  type SubjectMember,
  type SubjectProjection,
  type SubjectSynthetic,
} from '../../../src/policy/crq/backfillSubjects.js';

const POLICY = {
  max_files: 8,
  max_file_bytes: 262144,
  max_total_bytes: 2097152,
  reviewer: {
    verified: true,
    evidence: 'offline-fixture-only',
    max_files: 8,
    max_diff_bytes: 2097152,
  },
};

function row(path: string, overrides: Partial<SubjectInventoryRow> = {}): SubjectInventoryRow {
  return {
    path,
    blob: `blob-${path}`,
    mode: '100644',
    kind: 'blob',
    lines: 2,
    bytes: 4,
    disposition: 'included',
    reason: 'tracked regular UTF8 text',
    ...overrides,
  };
}

interface PinCall {
  readonly identity: string;
  readonly generation: unknown;
  readonly partition: unknown;
  readonly base: string;
  readonly head: string;
  readonly target: string;
}

interface CommitCall {
  readonly tree: string;
  readonly parent: string;
  readonly message: string;
}

/**
 * A scripted seam. It answers with deterministic commit ids and records every
 * write, so the partition arithmetic is exercised without Git; the adapter
 * suite is what proves the real commits and pins.
 */
class ScriptedRepo implements BackfillSubjectRepo {
  readonly pins: PinCall[] = [];
  readonly commits: CommitCall[] = [];
  private readonly changedByHead = new Map<string, Map<string, Set<number>>>();
  private readonly diffByHead = new Map<string, number>();

  constructor(
    private readonly rows: readonly SubjectInventoryRow[],
    private readonly projectionLines: (name: string) => number[] = () => [1],
    private readonly syntheticLines: (name: string) => number[] = () => [2],
    private readonly diff = 1,
  ) {}

  private changed(lines: (name: string) => number[]): Map<string, Set<number>> {
    const result = new Map<string, Set<number>>();
    for (const entry of this.rows) result.set(entry.path, new Set(lines(entry.path)));
    return result;
  }

  async resolve(value: string): Promise<string> {
    return value;
  }

  async tree(commit: string): Promise<string> {
    return `tree:${commit}`;
  }

  async inventory(): Promise<readonly SubjectInventoryRow[]> {
    return this.rows;
  }

  async projection(target: string, names: readonly string[]): Promise<SubjectProjection> {
    const key = names.join('\u0000');
    const base = `projection:${target}:${key}:base`;
    const head = `projection:${target}:${key}:head`;
    const changed = this.changed(this.projectionLines);
    // A context commit wraps the base, so its parent carries the same change
    // set as the projection head.
    this.changedByHead.set(base, changed);
    this.changedByHead.set(head, changed);
    this.diffByHead.set(head, this.diff);
    return { base, head };
  }

  async synthetic(
    target: string,
    names: readonly string[],
    _members: readonly SubjectMember[],
  ): Promise<SubjectSynthetic> {
    const key = names.join('\u0000');
    const base = `synthetic:${target}:${key}:base`;
    const head = `synthetic:${target}:${key}:head`;
    const changed = this.changed(this.syntheticLines);
    this.changedByHead.set(base, changed);
    this.changedByHead.set(head, changed);
    this.diffByHead.set(head, this.diff);
    const provenance: Record<string, Record<string, unknown>> = {};
    for (const name of names) {
      provenance[name] = {
        method: 'pre-merge',
        merge: 'merge',
        pre: 'pre',
        source_path: name,
        entry: { path: name, mode: '100644', kind: 'blob', blob: `blob-${name}` },
      };
    }
    return { base, head, provenance };
  }

  async pin(
    identity: string,
    generation: unknown,
    partition: unknown,
    base: string,
    head: string,
    target: string,
  ): Promise<string> {
    this.pins.push({ identity, generation, partition, base, head, target });
    return `refs/crq/backfill/${identity}/${String(generation)}/${String(partition)}`;
  }

  async commitTree(tree: string, parent: string, message: string): Promise<string> {
    this.commits.push({ tree, parent, message });
    const head = `context:${parent}`;
    this.changedByHead.set(head, this.changedByHead.get(parent) ?? new Map<string, Set<number>>());
    this.diffByHead.set(head, this.diffByHead.get(parent) ?? this.diff);
    return head;
  }

  async changedIntervals(
    _base: string,
    head: string,
  ): Promise<ReadonlyMap<string, ReadonlySet<number>>> {
    return this.changedByHead.get(head) ?? new Map();
  }

  async diffBytes(_base: string, head: string): Promise<number> {
    return this.diffByHead.get(head) ?? this.diff;
  }
}

function candidate(
  names: readonly string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    target: 't'.repeat(40),
    kind: 'B',
    scope: names.map((name) => ({
      path: name,
      blob: `blob-${name}`,
      intervals: [[1, 1]],
    })),
    subject_id: 'b'.repeat(64),
    generation: 0,
    prs: [1],
    tier: 'T1',
    family: 'family',
    partition: 0,
    ...overrides,
  };
}

describe('backfill subject construction', () => {
  test('tier dominates byte order and score/tier fold only over the scope', async () => {
    const repo = new ScriptedRepo([row('a'), row('z')]);
    const result = await construct(
      repo,
      candidate(['a', 'z'], { path_tiers: { z: 'T0' }, path_scores: { a: 3, z: 5 } }),
      POLICY,
    );

    expect(result.debt).toEqual([]);
    const partition = result.partitions[0] as Record<string, unknown>;
    expect(partition['scope']).toEqual([
      { path: 'z', blob: 'blob-z', intervals: [[1, 1]] },
      { path: 'a', blob: 'blob-a', intervals: [[1, 1]] },
    ]);
    expect(partition['tier']).toBe('T0');
    expect(partition['score']).toBe(8);
    expect(partition['inventory_subject_id']).toBe('b'.repeat(64));
    expect(partition['partition']).toBe(0);
    expect(partition['residual']).toBe(false);
    expect(partition['job_id']).toBe(`${String(partition['subject_id'])}:0`);
    expect(partition['scope_digest']).toBe(ledgerJsonDigest(partition['scope']));
    expect(partition['subject_id']).toBe(
      ledgerJsonDigest({
        parent: 'b'.repeat(64),
        scope: partition['scope'],
        partition: 0,
        residual: false,
      }),
    );
    expect(partition['paths']).toEqual([
      {
        path: 'z',
        blob: 'blob-z',
        mode: '100644',
        disposition: 'included',
        reason: 'bounded verified input',
        baseline: {
          method: 'projection',
          reason: 'path cluster',
        },
      },
      {
        path: 'a',
        blob: 'blob-a',
        mode: '100644',
        disposition: 'included',
        reason: 'bounded verified input',
        baseline: {
          method: 'projection',
          reason: 'path cluster',
        },
      },
    ]);
  });

  test('unexposed requested lines are re-cut as a residual projection', async () => {
    const repo = new ScriptedRepo([row('a')], () => [1, 2]);
    const result = await construct(
      repo,
      candidate(['a'], { kind: 'A', scope: [{ path: 'a', blob: 'blob-a', intervals: [[1, 2]] }] }),
      POLICY,
    );

    expect(result.debt).toEqual([]);
    expect(result.partitions).toHaveLength(2);
    const initial = result.partitions[0] as Record<string, unknown>;
    const residual = result.partitions[1] as Record<string, unknown>;
    expect(initial['scope']).toEqual([{ path: 'a', blob: 'blob-a', intervals: [[2, 2]] }]);
    expect(initial['residual']).toBe(false);
    const initialPaths = initial['paths'] as Array<{ baseline: Record<string, unknown> }>;
    expect(initialPaths[0]?.baseline['method']).toBe('pre-merge');
    expect(residual['scope']).toEqual([{ path: 'a', blob: 'blob-a', intervals: [[1, 2]] }]);
    expect(residual['residual']).toBe(true);
    const residualPaths = residual['paths'] as Array<{ baseline: Record<string, unknown> }>;
    expect(residualPaths[0]?.baseline).toEqual({
      method: 'projection',
      reason: 'residual uncovered lines',
    });
  });

  test('the residual projection repeats an unexposable kind-B scope as debt', async () => {
    const repo = new ScriptedRepo(
      [row('a')],
      () => [1],
      () => [1],
    );
    const result = await construct(
      repo,
      candidate(['a'], { scope: [{ path: 'a', blob: 'blob-a', intervals: [[1, 2]] }] }),
      POLICY,
    );

    expect(result.partitions).toHaveLength(2);
    expect(result.partitions[1]?.['residual']).toBe(true);
    expect(result.debt).toEqual([
      {
        path: 'a',
        disposition: 'unsupported',
        reason: 'projection cannot expose requested head intervals',
      },
    ]);
  });

  test('ineligible, missing and blob-mismatched paths become debt, never a partition', async () => {
    const repo = new ScriptedRepo([
      row('empty', {
        disposition: 'empty',
        reason: 'empty current blob',
        lines: 0,
        bytes: 0,
      }),
      row('regular'),
      row('stale'),
    ]);
    const result = await construct(
      repo,
      candidate(['empty', 'regular', 'missing', 'stale'], {
        scope: [
          { path: 'empty', blob: 'blob-empty', intervals: [[1, 1]] },
          { path: 'regular', blob: 'blob-regular', intervals: [[1, 1]] },
          { path: 'missing', blob: 'blob-missing', intervals: [[1, 1]] },
          { path: 'stale', blob: 'older-blob', intervals: [[1, 1]] },
        ],
      }),
      POLICY,
    );

    expect(result.debt).toEqual([
      { path: 'empty', reason: 'empty current blob', disposition: 'empty' },
      { path: 'missing', reason: 'missing target path', disposition: 'ambiguous' },
      { path: 'stale', reason: 'tracked regular UTF8 text', disposition: 'included' },
    ]);
    expect(result.partitions).toHaveLength(1);
    expect(result.partitions[0]?.['scope']).toEqual([
      { path: 'regular', blob: 'blob-regular', intervals: [[1, 1]] },
    ]);
  });

  test('file, total and diff limits split without truncation', async () => {
    const names = Array.from({ length: 11 }, (_, index) => `p/${String(index).padStart(2, '0')}`);
    const repo = new ScriptedRepo(names.map((name) => row(name)));
    const sized = await construct(repo, candidate(names), { ...POLICY, max_files: 3 });

    expect(sized.debt).toEqual([]);
    expect(
      sized.partitions.flatMap((part) => part['paths'] as Array<{ path: string }>),
    ).toHaveLength(11);
    for (const part of sized.partitions) {
      expect((part['paths'] as unknown[]).length).toBeLessThanOrEqual(3);
    }

    const tight = new ScriptedRepo(
      names.map((name) => row(name)),
      undefined,
      undefined,
      2,
    );
    const unsupported = await construct(tight, candidate(names), {
      ...POLICY,
      reviewer: { ...POLICY.reviewer, max_diff_bytes: 1 },
    });
    expect(unsupported.partitions).toEqual([]);
    expect(unsupported.debt).toHaveLength(11);
    for (const entry of unsupported.debt) {
      expect(entry['reason']).toBe('single-file diff exceeds verified reviewer byte limit');
    }

    const oversized = new ScriptedRepo([row('big', { bytes: 5 })]);
    const total = await construct(
      oversized,
      candidate(['big'], { scope: [{ path: 'big', blob: 'blob-big', intervals: [[1, 1]] }] }),
      { ...POLICY, max_total_bytes: 4 },
    );
    expect(total.partitions).toEqual([]);
    expect(total.debt).toEqual([
      {
        path: 'big',
        disposition: 'unsupported',
        reason: 'single file exceeds total content limit',
      },
    ]);
  });

  test('PR context is inert commit text and does not alter the tree', async () => {
    const repo = new ScriptedRepo([row('a')]);
    const members: SubjectMember[] = [
      {
        pr: 1,
        merge: 'm'.repeat(40),
        paths: [{ path: 'a', source_path: 'a', lineage_verified: true }],
        context: { title: 'untrusted', body: '$(touch must-not-exist)' },
      },
    ];
    const result = await construct(repo, candidate(['a']), POLICY, members);

    expect(result.partitions).toHaveLength(1);
    const partition = result.partitions[0] as Record<string, unknown>;
    expect(repo.commits).toHaveLength(1);
    const commit = repo.commits[0] as CommitCall;
    expect(commit.message).toBe(
      'crq pinned current subject\n\nBEGIN UNTRUSTED PR CONTEXT\n' +
        ledgerJsonText({
          trust: 'untrusted-data-only',
          prs: [1],
          sources: [
            {
              pr: 1,
              context: { title: 'untrusted', body: '$(touch must-not-exist)' },
            },
          ],
        }) +
        '\nEND UNTRUSTED PR CONTEXT',
    );
    expect(partition['head']).toBe(`context:${String(commit.parent)}`);
    expect(partition['head_tree']).toBe(`tree:context:${String(commit.parent)}`);
    expect(partition['context']).toEqual({
      trust: 'untrusted-data-only',
      prs: [1],
      sources: [
        {
          pr: 1,
          context: { title: 'untrusted', body: '$(touch must-not-exist)' },
        },
      ],
    });
  });

  test('an empty member list transports no context commit', async () => {
    const repo = new ScriptedRepo([row('a')]);
    const result = await construct(repo, candidate(['a']), POLICY);

    expect(result.partitions).toHaveLength(1);
    expect(repo.commits).toEqual([]);
    expect((result.partitions[0] as Record<string, unknown>)['context']).toEqual({
      trust: 'untrusted-data-only',
      prs: [1],
      sources: [],
    });
  });

  test('a captured float is refused by the canonical context domain', async () => {
    const repo = new ScriptedRepo([row('a')]);
    const members: SubjectMember[] = [
      {
        pr: 1,
        merge: 'm'.repeat(40),
        paths: [{ path: 'a', source_path: 'a', lineage_verified: true }],
        context: { score: JsonNumber.float(1.0) },
      },
    ];
    // `review_ledger.canonical` admits null, bool, int, str, list and dict only.
    await expect(construct(repo, candidate(['a']), POLICY, members)).rejects.toThrow(
      'unsupported canonical JSON value',
    );
    expect(repo.commits).toEqual([]);
  });

  test('replay is deterministic and preserves unknown candidate fields', async () => {
    const repo = new ScriptedRepo([row('café/文件.txt')]);
    const value = candidate(['café/文件.txt'], {
      unknown_field: { nested: [1, 'two'] },
    });
    const first = await construct(repo, value, POLICY);
    const replay = await construct(repo, value, POLICY);

    expect(replay).toEqual(first);
    expect(first.partitions[0]).toMatchObject({
      unknown_field: { nested: [1, 'two'] },
      family: 'family',
      prs: [1],
    });
  });

  test('the offline replay accepts an unverified deployment policy', async () => {
    const repo = new ScriptedRepo([row('a')]);
    const unverified = { ...POLICY, reviewer: { ...POLICY.reviewer, verified: false } };
    await expect(construct(repo, candidate(['a']), unverified)).rejects.toThrow(
      'deployed reviewer limits not verified; go-live blocked',
    );
    await expect(
      construct(repo, candidate(['a']), unverified, [], { offline: true }),
    ).resolves.toMatchObject({ debt: [] });
  });

  test('an invalid requested interval keeps the ledger refusal text', async () => {
    const repo = new ScriptedRepo([row('a')]);
    await expect(
      construct(
        repo,
        candidate([], {
          scope: [{ path: 'a', blob: 'blob-a', intervals: [[2, 1]] }],
        }),
        POLICY,
      ),
    ).rejects.toThrow('invalid or overlapping intervals');
  });
});
