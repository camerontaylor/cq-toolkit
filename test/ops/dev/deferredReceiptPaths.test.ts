import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  verifiedCompletedDebt,
  type DeferredVendorDebt,
} from '../../../src/ops/dev/internal/deferredReview.js';
import {
  importQueueEvidence,
  parseQueueReceipt,
  sha256,
  type QueueReceipt,
} from '../../../src/ops/review/internal/queueEvidence.js';
type PathRow = QueueReceipt['capture']['paths'][number];
// Producer shapes pinned to crq.py current_paths at 74750e49, confirmed by 80b.
const positive: PathRow = {
  source_path: 'src/current.ts',
  path: 'src/current.ts',
  resolution: 'same-path-current',
  disposition: 'included',
  blob: 'a'.repeat(40),
  mode: '100644',
  bytes: 20,
};
const deleted: PathRow = {
  source_path: 'src/gone.ts',
  path: 'src/gone.ts',
  resolution: 'same-path-current',
  disposition: 'deleted',
  reason: 'no current path or evidenced rename',
};
const empty: PathRow = {
  source_path: 'src/empty.ts',
  path: 'src/empty.ts',
  resolution: 'same-path-current',
  disposition: 'excluded-with-reason',
  reason: 'empty current file',
  blob: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
  mode: '100644',
  bytes: 0,
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function digest(value: unknown) {
  return sha256(Buffer.from(canonical(value)));
}
function completed(paths: PathRow[]): Extract<DeferredVendorDebt, { vendorCompleted: true }> {
  const identity = {
    target: 'c'.repeat(40),
    tree: 'd'.repeat(40),
    paths,
    scope_digest: digest(paths),
    policy: 'affected-current-additions-v1',
    projection: 'current-affected-files/full-file-addition-projection',
    reviewer: 'coderabbit-review-agent-committed-v1',
    reviewer_version: 'producer-v1',
  };
  const document = parseQueueReceipt({
    version: 1,
    item_id: 'item-1',
    request_id: 'request-1',
    source: {
      repo: 'owner/repo',
      pr: 12,
      merge_sha: 'b'.repeat(40),
      target_selector: 'promoted-main',
      policy: identity.policy,
    },
    capture: { ...identity, equivalence: digest(identity), captured_at: '2026-10-28T00:00:00Z' },
    outcome: 'terminal-clean',
    counted: true,
    classification: { outcome: 'completed', counted: true },
    findings: [],
    run_id: 'run-1',
    started_at: '2026-10-28T00:00:00Z',
    artifacts: {},
    remediation: 'disabled/deferred',
    independent_acceptance: false,
    cli_functional_acceptance: 'pending-D1',
  });
  const receiptId = sha256(Buffer.from(JSON.stringify(document)));
  return {
    reference: {
      requestId: 'request-1',
      binding: {
        kind: 'deferred-author',
        repo: 'owner/repo',
        producer: 'author',
        head: 'a'.repeat(40),
        target: 'merge-queue',
        targetSelector: 'promoted-main',
      },
    },
    queue: {
      state: 'terminal-clean',
      pr: 12,
      mergeSha: 'b'.repeat(40),
      itemId: 'item-1',
      receiptId,
      consumed: true,
      reviewed: true,
      fixed: false,
    },
    originAttempt: {
      cycleId: 'cycle-1',
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
      target: 'merge-queue',
      scope: 'full',
      dirtySha256: 'clean-tree',
      failure: { source: 'vendor', category: 'vendor-rate-limited', codes: ['rate_limited'] },
    },
    deferral: { id: 'request-1', base: 'b'.repeat(40), dirtySha256: 'clean-tree' },
    vendor: 'vendor-completed',
    vendorCompleted: true,
    completion: {
      schema: 'cq-queue-evidence',
      version: 1,
      receiptId,
      document,
      fullBranchReadiness: false,
      independentAcceptance: false,
      fixed: false,
    },
  };
}
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe('supported no-content receipt dispositions', () => {
  test.each([
    [positive, deleted],
    [positive, empty],
    [
      {
        ...positive,
        source_path: 'src/old.ts',
        disposition: 'renamed',
        resolution: 'git-rename-M50',
      },
      deleted,
      { ...empty, mode: '100755' },
    ],
  ] satisfies PathRow[][])(
    'mixed genuine reviewed content accepts exact producer rows: %j',
    async (...paths) => {
      const debt = completed(paths);
      const dir = await mkdtemp(join(tmpdir(), 'cq-receipt-paths-'));
      dirs.push(dir);
      const evidence = await importQueueEvidence(
        dir,
        debt.completion.receiptId,
        Buffer.from(JSON.stringify(debt.completion.document)),
      );
      expect(evidence).toEqual(debt.completion);
      expect(verifiedCompletedDebt({ ...debt, completion: evidence })).toBe(true);
      expect(evidence.fullBranchReadiness || evidence.independentAcceptance || evidence.fixed).toBe(
        false,
      );
      expect(evidence.document.capture.paths).toEqual(paths);
    },
  );
  test.each([
    { ...deleted, reason: 'other deletion' },
    { ...deleted, blob: 'a'.repeat(40) },
    { ...deleted, mode: '100644' },
    { ...deleted, bytes: 0 },
    { ...empty, reason: 'scope excluded' },
    { ...empty, bytes: 1 },
    { ...empty, bytes: '0' },
    { ...empty, blob: 'mutable-head' },
    { ...empty, mode: '120000' },
    { ...empty, mode: 100644 },
    { ...empty, disposition: 'unsupported' },
    { ...deleted, disposition: 'ambiguous' },
  ] satisfies PathRow[])('unknown/unsupported/malformed no-content rows stay hard: %j', (row) => {
    expect(verifiedCompletedDebt(completed([positive, row]))).toBe(false);
  });
  test.each([
    [],
    [deleted],
    [empty],
    [deleted, empty],
    [{ ...positive, bytes: 0 }, deleted],
  ] satisfies PathRow[][])(
    'no reviewed positive current content never completes: %j',
    (...paths) => {
      expect(verifiedCompletedDebt(completed(paths))).toBe(false);
    },
  );
  test('partial and non-counted outcomes remain blocked', () => {
    const debt = completed([positive, deleted, empty]);
    debt.completion.document.outcome = 'partial-scope';
    expect(verifiedCompletedDebt(debt)).toBe(false);
    debt.completion.document.outcome = 'terminal-clean';
    debt.completion.document.counted = false;
    expect(verifiedCompletedDebt(debt)).toBe(false);
    debt.completion.document.counted = true;
    debt.completion.document.classification!['counted'] = false;
    expect(verifiedCompletedDebt(debt)).toBe(false);
  });
  test('findings remain substantive and malformed findings never acquire completion', () => {
    const debt = completed([positive, deleted, empty]);
    debt.queue.state = 'terminal-with-findings';
    debt.completion.document.outcome = 'terminal-with-findings';
    debt.completion.document.findings = [{ severity: 'major', text: 'must remain visible' }];
    expect(verifiedCompletedDebt(debt)).toBe(true);
    debt.completion.document.findings[0]!['severity'] = 'unknown';
    expect(verifiedCompletedDebt(debt)).toBe(false);
  });
  test('alias/source/item/receipt identity still cannot be relaxed by supported omissions', () => {
    const base = completed([positive, deleted, empty]);
    for (const alter of [
      (debt: typeof base) => {
        debt.reference.requestId = 'unproven-alias';
      },
      (debt: typeof base) => {
        debt.queue.itemId = 'other-item';
      },
      (debt: typeof base) => {
        debt.queue.receiptId = 'f'.repeat(64);
      },
      (debt: typeof base) => {
        debt.completion.document.source.repo = 'other/repo';
      },
      (debt: typeof base) => {
        debt.queue.reviewed = false;
      },
    ]) {
      const debt = structuredClone(base);
      alter(debt);
      expect(verifiedCompletedDebt(debt)).toBe(false);
    }
  });
});
