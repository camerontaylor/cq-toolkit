import { describe, expect, test } from 'vitest';
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

const sha = (c: string): string => c.repeat(40);
function obj(value: unknown): JsonObject {
  const parsed = parseJsonValue(JSON.stringify(value));
  if (!(parsed instanceof JsonObject)) throw new Error('expected object');
  return parsed;
}
function fixture() {
  const subject = { target_selector: 'promoted-main', repo: 'owner/repo' };
  const capture = { target: sha('a') };
  const finding = { path: 'src/a.ts', line: 1 };
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
    publication: { head: sha('b'), target: sha('c') },
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
    mergeCommit: { oid: sha('d') },
  });
  const effects: CurrentRepairEffects = {
    readReceipt: async () => data,
    prInfo: async () => info,
    targetRef: () => 'origin/main',
    resolveRef: async () => sha('e'),
    isAncestor: async () => true,
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
      'not-fixed marker',
      (r: ReturnType<typeof fixture>['record']) => ({ ...r, not_fixed: { reason: 'closed' } }),
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
  test('binding refuses exhausted budgets and treats all nonzero ancestry exits as false', async () => {
    const options = {
      stateRoot: '/unused',
      clone: '/unused',
      repo: 'owner/repo',
      gh: async () => {
        throw new Error('must not call forge');
      },
      runGit: async (args: readonly string[]) => ({
        args,
        code: 128,
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
  });
  test('production file binding reads the receipt and uses bounded forge and git seams', async () => {
    const { item, data, receiptId, info } = fixture();
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
