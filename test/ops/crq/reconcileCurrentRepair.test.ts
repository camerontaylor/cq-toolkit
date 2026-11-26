import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileCurrentRepairEffects } from '../../../src/adapters/crq/repairCurrentSource.js';
import {
  reconcileCurrentRepair,
  type CurrentRepairEffects,
} from '../../../src/ops/crq/internal/reconcileCurrentRepair.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
} from '../../../src/policy/crq/jsonValue.js';
import { withObjectKeys } from '../../../src/policy/crq/queueDoc.js';
import { reviewReceiptBytes, reviewReceiptDigest } from '../../../src/policy/crq/reviewReceipt.js';
import { ForgeBudget, RefreshExhausted } from '../../../src/policy/crq/forgeBudget.js';
import { runGitIn } from '../../../src/adapters/crq/publishSource.js';
import { createMergeTreeRepo, type MergeTreeRepo } from '../../helpers/mergeTreeRepo.js';

const sha = (c: string): string => c.repeat(40);
function obj(value: unknown): JsonObject {
  const parsed = parseJsonValue(JSON.stringify(value));
  if (!(parsed instanceof JsonObject)) throw new Error('expected object');
  return parsed;
}
interface FixtureOptions {
  readonly path?: string;
  readonly captureTarget?: string;
  readonly publication?: Record<string, unknown>;
  readonly merge?: string;
}
function fixture(options: FixtureOptions = {}) {
  const subject = { target_selector: 'promoted-main', repo: 'owner/repo' };
  const capture = { target: options.captureTarget ?? sha('a') };
  const finding = { path: options.path ?? 'src/a.ts', line: 1 };
  const doc = {
    source: subject,
    capture,
    findings: [finding],
    outcome: 'terminal-with-findings',
    counted: true,
    classification: { outcome: 'completed', counted: true },
  };
  const { data, receiptId } = reviewReceiptBytes(doc);
  const record = {
    receipt_id: receiptId,
    state: 'published',
    jobs: ['job'],
    verdicts: [{ job: 'job', verdict: 'FIXED', finding }],
    repair_findings: [reviewReceiptDigest(finding)],
    receipt_findings: [reviewReceiptDigest(finding)],
    fix_pr: { number: 7 },
    publication: options.publication ?? { head: sha('b'), target: sha('c') },
    extra: 1.5,
  };
  const item = obj({
    receipt_id: receiptId,
    subject,
    capture,
    remediation_state: 'fixed',
    remediation: { old: true },
    repair_runs: { run: record },
    extra: { future: true },
  });
  const info = obj({
    number: 7,
    state: 'MERGED',
    headRefOid: sha('b'),
    baseRefName: 'main',
    mergeCommit: { oid: options.merge ?? sha('d') },
  });
  const effects: CurrentRepairEffects = {
    readReceipt: async () => data,
    prInfo: async () => info,
    targetRef: () => 'origin/main',
    resolveRef: async () => sha('e'),
    isAncestor: async () => true,
    proveMergeTree: async () => undefined,
  };
  return { item, effects, data, receiptId, info, record };
}

describe('current repair reconciliation', () => {
  test.each([
    [
      'verdict count',
      (r: ReturnType<typeof fixture>['record']) => ({
        ...r,
        verdicts: [...r.verdicts, ...r.verdicts],
        jobs: ['job', 'job'],
        repair_findings: [...r.repair_findings, ...r.repair_findings].sort(),
      }),
    ],
    [
      'receipt findings',
      (r: ReturnType<typeof fixture>['record']) => ({ ...r, receipt_findings: ['wrong'] }),
    ],
    [
      'repair findings',
      (r: ReturnType<typeof fixture>['record']) => ({ ...r, repair_findings: ['wrong'] }),
    ],
    ['job identity', (r: ReturnType<typeof fixture>['record']) => ({ ...r, jobs: ['other'] })],
    [
      'non-fixed verdict',
      (r: ReturnType<typeof fixture>['record']) => ({
        ...r,
        verdicts: [{ ...r.verdicts[0], verdict: 'FAILED' }],
      }),
    ],
    [
      'fresh not-fixed marker',
      (r: ReturnType<typeof fixture>['record']) => ({
        ...r,
        not_fixed: { reason: 'closed', at: `${new Date().toISOString().slice(0, 19)}Z` },
      }),
    ],
  ])('does not credit a record with invalid %s', async (_name, change) => {
    const { item, effects, record } = fixture();
    const changed = withObjectKeys(item, [['repair_runs', obj({ run: change(record) })]]);
    const result = await reconcileCurrentRepair(changed, effects);
    expect(result.item.get('remediation')).toBeUndefined();
    expect(result.item.get('remediation_state')).toBe('pending-merged-evidence');
  });
  test('rejects a different base branch and records CLOSED repairs', async () => {
    const { item, effects } = fixture();
    const wrongBase = await reconcileCurrentRepair(item, {
      ...effects,
      prInfo: async () =>
        obj({
          number: 7,
          state: 'MERGED',
          headRefOid: sha('b'),
          baseRefName: 'other',
          mergeCommit: { oid: sha('d') },
        }),
    });
    expect(wrongBase.item.get('remediation')).toBeUndefined();
    const closed = await reconcileCurrentRepair(item, {
      ...effects,
      prInfo: async () => obj({ number: 7, state: 'CLOSED', headRefOid: sha('b') }),
    });
    expect(toPlainJson(closed.item)).toMatchObject({
      repair_runs: { run: { not_fixed: { state: 'CLOSED' } } },
    });
    expect(closed.item.get('remediation')).toBeUndefined();
  });
  test('cached merged identity avoids forge reads but rechecks target ancestry', async () => {
    const { item, effects, record, info } = fixture();
    const cached = withObjectKeys(item, [
      ['repair_runs', obj({ run: { ...record, merged_fix: toPlainJson(info) } })],
    ]);
    let calls = 0;
    const result = await reconcileCurrentRepair(cached, {
      ...effects,
      prInfo: async () => {
        throw new Error('unexpected forge call');
      },
      isAncestor: async () => {
        calls += 1;
        return true;
      },
    });
    expect(result.item.get('remediation_state')).toBe('fixed');
    expect(calls).toBe(2);
  });
  test('ancestry failure is counted and a later valid record can still project', async () => {
    const { item, effects, record } = fixture();
    const two = withObjectKeys(item, [
      ['repair_runs', obj({ first: record, second: { ...record, fix_pr: { number: 8 } } })],
    ]);
    let ancestryCalls = 0;
    const seen: string[] = [];
    const result = await reconcileCurrentRepair(two, {
      ...effects,
      prInfo: async (number) => {
        seen.push(String(number instanceof JsonNumber ? number.integer : number));
        return obj({
          number: number instanceof JsonNumber ? Number(number.integer) : 0,
          state: 'MERGED',
          headRefOid: sha('b'),
          baseRefName: 'main',
          mergeCommit: { oid: sha('d') },
        });
      },
      isAncestor: async () => {
        ancestryCalls += 1;
        if (ancestryCalls === 1) throw new Error('git unavailable');
        return true;
      },
    });
    expect(seen).toEqual(['7', '8']);
    expect(result.deferred).toBe(1);
    expect(result.item.get('remediation_state')).toBe('fixed');
  });
  test('binding refuses exhausted budgets and treats only exit 1 as "not an ancestor"', async () => {
    let code: number | null = 1;
    const options = {
      stateRoot: '/unused',
      clone: '/unused',
      repo: 'owner/repo',
      gh: async () => {
        throw new Error('must not call forge');
      },
      runGit: async (args: readonly string[]) => ({
        args,
        code,
        stdout: Buffer.alloc(0),
        stderr: 'bad commit',
      }),
    };
    const effects = fileCurrentRepairEffects({
      ...options,
      budget: new ForgeBudget({ requests: 0 }),
    });
    await expect(effects.prInfo(JsonNumber.int(7))).rejects.toBeInstanceOf(RefreshExhausted);
    expect(await effects.isAncestor(sha('a'), sha('b'))).toBe(false);
    for (const failure of [128, null]) {
      code = failure;
      await expect(effects.isAncestor(sha('a'), sha('b'))).rejects.toThrow(
        'git merge-base --is-ancestor failed',
      );
    }
    code = 0;
    expect(await effects.isAncestor(sha('a'), sha('b'))).toBe(true);
  });
  test('production file binding reads the receipt and uses bounded forge and git seams', async () => {
    const { item, data, receiptId, info } = fixture({ merge: sha('b') });
    const root = await mkdtemp(join(tmpdir(), 'crq-current-repair-'));
    try {
      await mkdir(join(root, 'receipts'));
      await writeFile(join(root, 'receipts', `${receiptId}.json`), data);
      const calls: string[][] = [];
      const effects = fileCurrentRepairEffects({
        stateRoot: root,
        clone: root,
        repo: 'owner/repo',
        gh: async (args) => {
          calls.push(args);
          return { code: 0, stdout: JSON.stringify(toPlainJson(info)), stderr: '' };
        },
        runGit: async (args) => {
          calls.push([...args]);
          return {
            args,
            code: 0,
            stdout: Buffer.from(args[0] === 'rev-parse' ? `${sha('e')}\n` : ''),
            stderr: '',
          };
        },
      });
      const result = await reconcileCurrentRepair(item, effects);
      expect(result.item.get('remediation_state')).toBe('fixed');
      expect(calls[0]?.slice(0, 3)).toEqual(['pr', 'view', '7']);
      expect(calls.filter((args) => args[0] === 'merge-base')).toHaveLength(2);
      expect(await effects.readReceipt('../outside')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('projects only receipt-bound merged evidence at the observed target', async () => {
    const { item, effects } = fixture();
    const result = await reconcileCurrentRepair(item, effects);
    expect(toPlainJson(result.item)).toMatchObject({
      remediation_state: 'fixed',
      remediation: { merge: sha('d'), target: sha('e') },
      extra: { future: true },
      repair_runs: { run: { extra: 1.5, merged_fix: { state: 'MERGED' } } },
    });
    expect(result.starved).toBe(0);
  });
  test('revokes prior evidence when target ancestry is lost', async () => {
    const { item, effects } = fixture();
    const result = await reconcileCurrentRepair(item, {
      ...effects,
      isAncestor: async () => false,
    });
    expect(result.item.get('remediation')).toBeUndefined();
    expect(result.item.get('remediation_state')).toBe('pending-merged-evidence');
  });
  test('retains revoked evidence and reports target lookup failures', async () => {
    const { item, effects } = fixture();
    const result = await reconcileCurrentRepair(item, {
      ...effects,
      resolveRef: async () => {
        throw new Error('target unavailable');
      },
    });
    expect(result.item.get('remediation')).toBeUndefined();
    expect(result.item.get('remediation_state')).toBe('pending-merged-evidence');
    expect(result.item.get('repair_error')).toBe('target unavailable');
    expect(result.deferred).toBe(1);
  });
  test('records starvation instead of reporting a quiet pass', async () => {
    const { item, effects } = fixture();
    const result = await reconcileCurrentRepair(item, {
      ...effects,
      prInfo: async () => {
        throw new RefreshExhausted('budget');
      },
    });
    expect(result.starved).toBe(1);
    expect(result.errors).toEqual(['RefreshExhausted: budget']);
    expect(result.item.get('remediation')).toBeUndefined();
  });
  test('rejects corrupted receipt bytes and a merged head mismatch', async () => {
    const { item, effects, data } = fixture();
    const corrupt = await reconcileCurrentRepair(item, {
      ...effects,
      // Valid JSON with identical semantics but different retained bytes.
      readReceipt: async () => Buffer.concat([data, Buffer.from(' ')]),
    });
    expect(corrupt.item.get('remediation')).toBeUndefined();
    const mismatch = await reconcileCurrentRepair(item, {
      ...effects,
      prInfo: async () => obj({ number: 7, state: 'MERGED', headRefOid: sha('f') }),
    });
    expect(toPlainJson(mismatch.item)).toMatchObject({
      repair_runs: { run: { not_fixed: { reason: 'closed-or-head-mismatch' } } },
    });
  });
});

describe('receipt remediation requires the repair in the merge tree', () => {
  test('credits only after identity and ancestry, passing the head and merge commit', async () => {
    const { item, effects, record } = fixture();
    const seen: unknown[][] = [];
    const order: string[] = [];
    const result = await reconcileCurrentRepair(item, {
      ...effects,
      isAncestor: async () => {
        order.push('ancestry');
        return true;
      },
      proveMergeTree: async (...args) => {
        order.push('tree');
        seen.push(args.map((a) => (a instanceof JsonObject ? toPlainJson(a) : a)));
      },
    });
    expect(result.item.get('remediation_state')).toBe('fixed');
    expect(order).toEqual(['ancestry', 'ancestry', 'tree']);
    expect(seen).toHaveLength(1);
    const [passed, head, merge] = seen[0] as [Record<string, unknown>, string, string];
    expect([head, merge]).toEqual([sha('b'), sha('d')]);
    // The record carries the forge info the tree check was bound to.
    expect(passed).toMatchObject({
      jobs: (record as { jobs: unknown }).jobs,
      fix_pr: { number: 7 },
    });
    expect(passed.merged_fix).toMatchObject({ mergeCommit: { oid: sha('d') } });
  });
  test('does not read the tree when ancestry refuses', async () => {
    const { item, effects } = fixture();
    let reads = 0;
    const result = await reconcileCurrentRepair(item, {
      ...effects,
      isAncestor: async () => false,
      proveMergeTree: async () => {
        reads += 1;
      },
    });
    expect(reads).toBe(0);
    expect(result.item.get('remediation')).toBeUndefined();
  });
  test('a refused tree is not credited, is counted deferred and retries', async () => {
    const { item, effects } = fixture();
    const result = await reconcileCurrentRepair(item, {
      ...effects,
      proveMergeTree: async () => {
        throw new Error('merged repair source changed; needs revalidation: src/a.ts');
      },
    });
    expect(result.item.get('remediation')).toBeUndefined();
    expect(result.item.get('remediation_state')).toBe('pending-merged-evidence');
    expect(result.deferred).toBe(1);
    expect(result.errors).toEqual([
      'Error: merged repair source changed; needs revalidation: src/a.ts',
    ]);
  });
  test('a starved read is counted as starvation, not as a refusal', async () => {
    const { item, effects } = fixture();
    const result = await reconcileCurrentRepair(item, {
      ...effects,
      proveMergeTree: async () => {
        throw new RefreshExhausted('budget');
      },
    });
    expect(result.starved).toBe(1);
    expect(result.deferred).toBe(0);
    expect(result.item.get('remediation')).toBeUndefined();
  });
  test('a later valid record is still credited after an earlier refusal', async () => {
    const { item, effects, record } = fixture();
    const two = withObjectKeys(item, [
      ['repair_runs', obj({ first: record, second: { ...record, fix_pr: { number: 8 } } })],
    ]);
    let reads = 0;
    const result = await reconcileCurrentRepair(two, {
      ...effects,
      prInfo: async (number) =>
        obj({
          number: number instanceof JsonNumber ? Number(number.integer) : 0,
          state: 'MERGED',
          headRefOid: sha('b'),
          baseRefName: 'main',
          mergeCommit: { oid: sha('d') },
        }),
      proveMergeTree: async () => {
        reads += 1;
        if (reads === 1) throw new Error('dropped');
      },
    });
    expect(reads).toBe(2);
    expect(result.deferred).toBe(1);
    expect(result.item.get('remediation_state')).toBe('fixed');
  });
  test('a publication without a head is never credited, even when the PR head is also absent', async () => {
    const { item, effects } = fixture({ publication: { target: sha('c') } });
    let reads = 0;
    const result = await reconcileCurrentRepair(item, {
      ...effects,
      prInfo: async () =>
        obj({ number: 7, state: 'MERGED', baseRefName: 'main', mergeCommit: { oid: sha('d') } }),
      proveMergeTree: async () => {
        reads += 1;
      },
    });
    expect(reads).toBe(0);
    expect(result.item.get('remediation')).toBeUndefined();
  });
});

describe('receipt lane against local Git merge shapes', () => {
  let repo: MergeTreeRepo;
  let root: string;
  beforeAll(async () => {
    repo = await createMergeTreeRepo();
    root = await mkdtemp(join(tmpdir(), 'crq-current-merge-tree-'));
    await mkdir(join(root, 'receipts'));
    await mkdir(join(root, 'repair', 'inbox'), { recursive: true });
    await writeFile(
      join(root, 'repair', 'inbox', 'job.json'),
      JSON.stringify({ job: 'job', finding: { path: repo.path, line: 1 } }),
    );
  });
  afterAll(async () => {
    await repo.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  /** `tip` is the target tip the receipt lane observes; it defaults to the merge commit. */
  async function lane(merge: string, tip = merge) {
    const built = fixture({
      path: repo.path,
      captureTarget: repo.base,
      merge,
      publication: {
        head: repo.published,
        commits: [repo.published],
        target: repo.target,
      },
    });
    // The fixture PR head is the published head.
    const info = obj({
      number: 7,
      state: 'MERGED',
      headRefOid: repo.published,
      baseRefName: 'main',
      mergeCommit: { oid: merge },
    });
    await writeFile(join(root, 'receipts', `${built.receiptId}.json`), built.data);
    // An absent object cannot be a ref target: point the ref at a real, unrelated commit.
    repo.git(
      'update-ref',
      'refs/remotes/origin/main',
      tip === repo.unreachable ? repo.target : tip,
    );
    const effects = fileCurrentRepairEffects({
      stateRoot: root,
      clone: repo.dir,
      repo: 'owner/repo',
      gh: async () => ({ code: 0, stdout: JSON.stringify(toPlainJson(info)), stderr: '' }),
      runGit: runGitIn(repo.dir),
    });
    return reconcileCurrentRepair(built.item, effects);
  }
  test.each([
    ['keeps the repair', 'kept', true],
    ['squashes the repair', 'squashed', true],
    ['merges plainly with an identical tree', 'identical', true],
    ['only reformats the repaired line', 'reformatted', false],
    ['drops the repair with a -s ours merge', 'dropped', false],
    ['is a commit whose own tree reverted the repair', 'revertTip', false],
    ['is a commit that never carried the repair', 'wrong', false],
    ['is not in the repository', 'unreachable', false],
  ] as const)('a merge that %s', async (_name, shape, credited) => {
    const result = await lane(repo[shape]);
    expect(result.item.get('remediation_state') === 'fixed').toBe(credited);
    expect(result.item.get('remediation') !== undefined).toBe(credited);
    if (!credited) expect(result.deferred).toBe(1);
  });
  test('a later revert on the target leaves the kept merge tree credited', async () => {
    // The merge commit still carries the repair; only the target tip moved past it.
    expect(repo.git('rev-parse', `${repo.revertTip}~1`)).toBe(repo.kept);
    const result = await lane(repo.kept, repo.revertTip);
    expect(result.item.get('remediation_state')).toBe('fixed');
    expect(result.item.get('remediation') !== undefined).toBe(true);
  });
});
