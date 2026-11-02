import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deferredReceiptFindings,
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
type CompletedDebt = Extract<DeferredVendorDebt, { vendorCompleted: true }>;
// Rows are the exact shapes crq.py current_paths records (crq.py L770-L828):
// reviewed content carries blob+mode+bytes, a deletion carries its reason and no
// content keys at all, and an empty current file keeps its regular descriptor at
// zero bytes.
const reviewed: PathRow = {
  source_path: 'src/current.ts',
  path: 'src/current.ts',
  resolution: 'same-path-current',
  disposition: 'included',
  blob: 'a'.repeat(40),
  mode: '100644',
  bytes: 20,
};
const renamed: PathRow = {
  source_path: 'src/old.ts',
  path: 'src/new.ts',
  resolution: 'git-rename-M50',
  disposition: 'renamed',
  blob: 'c'.repeat(40),
  mode: '100755',
  bytes: 12,
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
function mergedSource() {
  return {
    kind: 'merged-current',
    repo: 'owner/repo',
    pr: 12,
    mergeSha: 'b'.repeat(40),
    targetSelector: 'promoted-main',
  } as const;
}
function completed(paths: PathRow[]): CompletedDebt {
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
        target: 'main',
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
      target: 'main',
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
describe('producer no-content receipt rows beside reviewed content', () => {
  test.each([
    { label: 'reviewed content only', paths: [reviewed] },
    { label: 'reviewed content and a deletion', paths: [reviewed, deleted] },
    { label: 'reviewed content and an empty file', paths: [reviewed, empty] },
    { label: 'renamed content, deletion and empty file', paths: [renamed, deleted, empty] },
    { label: 'deletion and empty file after reviewed content', paths: [reviewed, deleted, empty] },
  ] satisfies { label: string; paths: PathRow[] }[])(
    'exact producer rows complete the debt: $label',
    ({ paths }) => {
      expect(verifiedCompletedDebt(completed(paths))).toBe(true);
    },
  );
  test('an authenticated byte import keeps the same mixed capture', async () => {
    const debt = completed([reviewed, deleted, empty]);
    const dir = await mkdtemp(join(tmpdir(), 'cq-receipt-paths-'));
    dirs.push(dir);
    const evidence = await importQueueEvidence(
      dir,
      debt.completion.receiptId,
      Buffer.from(JSON.stringify(debt.completion.document)),
    );
    expect(evidence).toEqual(debt.completion);
    expect(verifiedCompletedDebt({ ...debt, completion: evidence })).toBe(true);
    expect(evidence.document.capture.paths).toEqual([reviewed, deleted, empty]);
    expect(evidence.fullBranchReadiness || evidence.independentAcceptance || evidence.fixed).toBe(
      false,
    );
  });
  test('mixed rows keep terminal findings visible and imported', () => {
    const debt = completed([reviewed, deleted, empty]);
    debt.queue.state = 'terminal-with-findings';
    debt.completion.document.outcome = 'terminal-with-findings';
    debt.completion.document.findings = [{ severity: 'major', text: 'must stay visible' }];
    expect(verifiedCompletedDebt(debt)).toBe(true);
    const findings = deferredReceiptFindings([debt]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe(`receipt-${debt.completion.receiptId}#f1`);
    expect(findings[0]!.severity).toBe('major');
    expect(findings[0]!.text).toBe('must stay visible');
  });
  test.each([
    { label: 'deletion with an unknown reason', row: { ...deleted, reason: 'other deletion' } },
    { label: 'deletion carrying a blob', row: { ...deleted, blob: 'a'.repeat(40) } },
    { label: 'deletion carrying a mode', row: { ...deleted, mode: '100644' } },
    { label: 'deletion carrying zero bytes', row: { ...deleted, bytes: 0 } },
    { label: 'deletion relabelled ambiguous', row: { ...deleted, disposition: 'ambiguous' } },
    { label: 'deletion relabelled unsupported', row: { ...deleted, disposition: 'unsupported' } },
    { label: 'empty file with a scope reason', row: { ...empty, reason: 'scope excluded' } },
    { label: 'empty file claiming one byte', row: { ...empty, bytes: 1 } },
    { label: 'empty file claiming a negative length', row: { ...empty, bytes: -1 } },
    { label: 'empty file with a string length', row: { ...empty, bytes: '0' } },
    { label: 'empty file with an unproven blob', row: { ...empty, blob: 'mutable-head' } },
    { label: 'empty file with a symlink mode', row: { ...empty, mode: '120000' } },
    { label: 'empty file with a numeric mode', row: { ...empty, mode: 100644 } },
    { label: 'empty file relabelled unsupported', row: { ...empty, disposition: 'unsupported' } },
    { label: 'empty file relabelled included', row: { ...empty, disposition: 'included' } },
    { label: 'reviewed content with zero bytes', row: { ...reviewed, bytes: 0 } },
    { label: 'reviewed content with an unproven blob', row: { ...reviewed, blob: 'not-a-sha' } },
    { label: 'reviewed content with a symlink mode', row: { ...reviewed, mode: '120000' } },
    { label: 'reviewed content with a numeric mode', row: { ...reviewed, mode: 100644 } },
    {
      label: 'binary current content',
      row: {
        ...reviewed,
        disposition: 'unsupported',
        reason: 'binary or non-UTF8 current blob',
      },
    },
    {
      label: 'current content over the byte cap',
      row: {
        ...reviewed,
        disposition: 'unsupported',
        reason: 'current content exceeds scope byte cap',
        bytes: 262145,
      },
    },
    {
      label: 'non-regular current entry',
      row: { ...empty, disposition: 'unsupported', reason: 'non-regular file; never dereferenced' },
    },
    {
      label: 'ambiguous rename lineage',
      row: {
        source_path: 'src/old.ts',
        path: 'src/new.ts',
        resolution: 'git-rename-M50',
        disposition: 'ambiguous',
        reason: 'duplicate blobs make rename lineage ambiguous',
      },
    },
    {
      label: 'ambiguous current path',
      row: {
        source_path: 'src/multi.ts',
        path: 'src/multi.ts',
        resolution: 'same-path-current',
        disposition: 'ambiguous',
        reason: 'current path resolves to multiple entries',
      },
    },
  ] satisfies { label: string; row: PathRow }[])(
    'malformed or unsupported rows stay hard: $label',
    ({ row }) => {
      expect(verifiedCompletedDebt(completed([reviewed, row]))).toBe(false);
    },
  );
  test.each([
    { label: 'no rows at all', paths: [] },
    { label: 'a deletion only', paths: [deleted] },
    { label: 'an empty file only', paths: [empty] },
    { label: 'a deletion and an empty file', paths: [deleted, empty] },
    {
      label: 'a deletion beside a zero-byte included row',
      paths: [{ ...reviewed, bytes: 0 }, deleted],
    },
  ] satisfies { label: string; paths: PathRow[] }[])(
    'no reviewed current content never completes: $label',
    ({ paths }) => {
      expect(verifiedCompletedDebt(completed(paths))).toBe(false);
    },
  );
  test('alias bridging over mixed rows still needs the full authenticated relation', () => {
    const debt = completed([reviewed, deleted, empty]);
    debt.completion.document.request_id = 'original-1';
    const source = mergedSource();
    debt.queue.receiptSource = source;
    debt.queue.receiptEquivalence = debt.completion.document.capture.equivalence;
    debt.queue.requestAlias = {
      v: 1,
      reference: structuredClone(debt.reference),
      originalRequestId: 'original-1',
      itemId: 'item-1',
      source,
      policy: 'affected-current-additions-v1',
      receiptId: debt.completion.receiptId,
      receiptEquivalence: debt.completion.document.capture.equivalence,
    };
    expect(verifiedCompletedDebt(debt)).toBe(true);
    const alteredRequest = structuredClone(debt);
    alteredRequest.queue.requestAlias!.originalRequestId = 'other-request';
    expect(verifiedCompletedDebt(alteredRequest)).toBe(false);
    const alteredEquivalence = structuredClone(debt);
    alteredEquivalence.queue.requestAlias!.receiptEquivalence = 'f'.repeat(64);
    expect(verifiedCompletedDebt(alteredEquivalence)).toBe(false);
  });
  test('reused completion over mixed rows still needs matching receipt equivalence', () => {
    const debt = completed([reviewed, deleted, empty]);
    debt.queue.state = 'reused';
    debt.queue.itemId = 'different-current-item';
    debt.queue.reusedFrom = 'original-item';
    debt.queue.receiptSource = mergedSource();
    debt.queue.receiptEquivalence = debt.completion.document.capture.equivalence;
    expect(verifiedCompletedDebt(debt)).toBe(true);
    const drifted = structuredClone(debt);
    drifted.queue.receiptEquivalence = 'f'.repeat(64);
    expect(verifiedCompletedDebt(drifted)).toBe(false);
  });
  test('mixed rows never relax outcome, consumption or settlement gates', () => {
    const unclean = completed([reviewed, deleted, empty]);
    unclean.completion.document.findings = [{ severity: 'minor', text: 'unexpected' }];
    expect(verifiedCompletedDebt(unclean)).toBe(false);
    const unconsumed = completed([reviewed, deleted, empty]);
    unconsumed.queue.consumed = false;
    expect(verifiedCompletedDebt(unconsumed)).toBe(false);
    // An intentionally incomplete debt is not completion evidence of any shape.
    expect(verifiedCompletedDebt({ vendorCompleted: false } as DeferredVendorDebt)).toBe(false);
  });
});
