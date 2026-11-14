import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileCurrentRepairEffects } from '../../../src/adapters/crq/repairCurrentSource.js';
import {
  reconcileCurrentRepair,
  type CurrentRepairEffects,
} from '../../../src/ops/crq/reconcileCurrentRepair.js';
import { JsonObject, parseJsonValue, toPlainJson } from '../../../src/policy/crq/jsonValue.js';
import { reviewReceiptBytes, reviewReceiptDigest } from '../../../src/policy/crq/reviewReceipt.js';
import { RefreshExhausted } from '../../../src/policy/crq/forgeBudget.js';

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
  return { item, effects, data, receiptId, info };
}

describe('current repair reconciliation', () => {
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
    const { item, effects } = fixture();
    const corrupt = await reconcileCurrentRepair(item, {
      ...effects,
      readReceipt: async () => new Uint8Array([1]),
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
