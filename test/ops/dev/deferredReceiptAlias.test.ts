import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeferredVendorDebtSchema,
  deferredReceiptFindings,
  verifiedCompletedDebt,
  type DeferredVendorDebt,
} from '../../../src/ops/dev/internal/deferredReview.js';
import { makeQueueClient } from '../../../src/ops/review/internal/queueClient.js';
import {
  parseQueueReceipt,
  sha256,
  type QueueReceipt,
} from '../../../src/ops/review/internal/queueEvidence.js';
import type { QueueTransport } from '../../../src/ops/review/internal/queueProtocol.js';
type PathRow = QueueReceipt['capture']['paths'][number];
const positive: PathRow = {
  source_path: 'src/current.ts',
  path: 'src/current.ts',
  resolution: 'same-path-current',
  disposition: 'included',
  blob: 'a'.repeat(40),
  mode: '100644',
  bytes: 20,
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
    request_id: 'original-1',
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
  for (const root of dirs.splice(0)) await rm(root, { recursive: true, force: true });
});
async function delivery(original = false, major = false) {
  const debt = completed([positive]);
  if (original) {
    debt.reference.requestId = 'original-1';
    debt.deferral.id = 'original-1';
  }
  const document = debt.completion.document;
  if (major) {
    document.outcome = 'terminal-with-findings';
    document.findings = [
      {
        type: 'finding',
        severity: 'major',
        comment: 'Original substantive finding',
        codegenInstructions: 'Preserve the raw fix instructions',
        fileName: 'src/current.ts',
        customRaw: { retained: true },
      },
    ];
  }
  const bytes = Buffer.from(JSON.stringify(document));
  const receiptId = sha256(bytes);
  debt.completion.receiptId = receiptId;
  const source = {
    kind: 'merged-current' as const,
    repo: document.source.repo,
    pr: document.source.pr,
    mergeSha: document.source.merge_sha,
    targetSelector: document.source.target_selector,
  };
  debt.queue = {
    ...debt.queue,
    state: major ? 'terminal-with-findings' : 'terminal-clean',
    receiptId,
    consumed: false,
    receiptSource: source,
    receiptEquivalence: document.capture.equivalence,
    ...(!original
      ? {
          requestAlias: {
            v: 1 as const,
            reference: structuredClone(debt.reference),
            originalRequestId: 'original-1',
            itemId: document.item_id,
            source,
            policy: document.source.policy,
            receiptId,
            receiptEquivalence: document.capture.equivalence,
          },
        }
      : {}),
  };
  const calls: string[] = [];
  let acknowledged = false;
  const chunks = Math.ceil(bytes.length / 3072);
  const common = {
    version: 1,
    receipt_id: receiptId,
    sha256: receiptId,
    bytes: bytes.length,
    chunks,
    encoding: 'base64-utf8-json',
  };
  const transport: QueueTransport = async (wire) => {
    const req = JSON.parse(wire) as { op: string; cursor?: string | null };
    calls.push(req.op);
    if (req.op === 'ack') acknowledged = true;
    let result: unknown = { ...debt.queue, consumed: acknowledged };
    if (req.op === 'report') {
      const index = Number(req.cursor?.split(':')[1]);
      const chunk = bytes.subarray(index * 3072, (index + 1) * 3072);
      result = {
        page:
          req.cursor === null
            ? { ...common, kind: 'manifest', cursor: receiptId + ':0' }
            : {
                ...common,
                kind: 'chunk',
                index,
                chunk_sha256: sha256(chunk),
                data: chunk.toString('base64'),
                next_cursor: index + 1 < chunks ? receiptId + ':' + (index + 1) : null,
              },
      };
    }
    return JSON.stringify({ v: 1, ...debt.reference, result });
  };
  const client = makeQueueClient(transport);
  const root = await mkdtemp(join(tmpdir(), 'cq-consumer-alias-'));
  dirs.push(root);
  async function consume() {
    const evidence = await client.report(debt.reference, root);
    if (!evidence) throw new Error('fixture report missing');
    return DeferredVendorDebtSchema.parse({
      ...debt,
      completion: evidence,
      queue: await client.status(debt.reference),
    });
  }
  return { debt, calls, consume };
}

describe('authenticated alias completion consumer', () => {
  test.each([false, true])(
    'real report/import/ack accepts original=%s without changing provenance',
    async (original) => {
      const f = await delivery(original, true);
      const retained = await f.consume();
      expect(verifiedCompletedDebt(retained)).toBe(true);
      expect(f.calls).toEqual(['status', 'report', 'report', 'ack', 'status']);
      expect(retained.vendorCompleted).toBe(true);
      if (!retained.vendorCompleted) throw new Error('missing completion');
      expect(retained.completion.document).toEqual(f.debt.completion.document);
      expect(retained.completion.document.request_id).toBe('original-1');
      expect(
        retained.completion.fullBranchReadiness ||
          retained.completion.independentAcceptance ||
          retained.completion.fixed,
      ).toBe(false);
      expect(deferredReceiptFindings([retained])).toEqual([
        {
          id: `receipt-${retained.completion.receiptId}#f1`,
          source: 'coderabbit',
          severity: 'major',
          text: 'Preserve the raw fix instructions',
          file: 'src/current.ts',
          status: 'open',
          evidence: retained.completion.receiptId,
        },
      ]);
      expect(DeferredVendorDebtSchema.parse(retained)).toEqual(retained);
    },
  );
  test('clean genuine alias has no manufactured findings or full-branch credit', async () => {
    const retained = await (await delivery()).consume();
    expect(verifiedCompletedDebt(retained)).toBe(true);
    expect(deferredReceiptFindings([retained])).toEqual([]);
  });
  test('missing authenticated proof fails at the real client before acknowledgement', async () => {
    const f = await delivery();
    delete f.debt.queue.requestAlias;
    await expect(f.consume()).rejects.toThrow('receipt original request or alias');
    expect(f.calls).not.toContain('ack');
  });
  test.each([
    ['requestId', 'other-request'],
    ['repo', 'other/repo'],
    ['producer', 'other-author'],
    ['head', 'f'.repeat(40)],
    ['target', 'other-branch'],
    ['targetSelector', 'merge-queue'],
    ['kind', 'merged-current'],
  ])('changed proof reference %s cannot settle', async (field, value) => {
    const f = await delivery();
    const alias = f.debt.queue.requestAlias;
    if (!alias) throw new Error('missing fixture proof');
    if (field === 'requestId') alias.reference.requestId = value;
    else Object.assign(alias.reference.binding, { [field]: value });
    await expect(f.consume()).rejects.toThrow();
    expect(f.calls).not.toContain('ack');
    expect(verifiedCompletedDebt({ ...f.debt, queue: { ...f.debt.queue, consumed: true } })).toBe(
      false,
    );
  });
  test.each([
    ['v', 2],
    ['extra', 'untrusted'],
    ['originalRequestId', 'forged-original'],
    ['itemId', 'other-item'],
    ['receiptId', 'f'.repeat(64)],
    ['receiptEquivalence', 'f'.repeat(64)],
    ['policy', 'other-policy'],
  ])('malformed or mismatched proof %s cannot settle', async (field, value) => {
    const f = await delivery();
    Object.assign(f.debt.queue.requestAlias ?? {}, { [field]: value });
    await expect(f.consume()).rejects.toThrow();
    expect(f.calls).not.toContain('ack');
    expect(verifiedCompletedDebt({ ...f.debt, queue: { ...f.debt.queue, consumed: true } })).toBe(
      false,
    );
  });
  test.each([
    ['repo', 'other/repo'],
    ['pr', 99],
    ['mergeSha', 'f'.repeat(40)],
    ['targetSelector', 'merge-queue'],
  ])('proof source %s cannot differ from the immutable receipt', async (field, value) => {
    const f = await delivery();
    // Keep status/source internally correlated: the immutable document still disagrees.
    f.debt.queue.receiptSource = { ...f.debt.queue.receiptSource!, [field]: value };
    f.debt.queue.requestAlias = {
      ...f.debt.queue.requestAlias!,
      source: { ...f.debt.queue.receiptSource },
    };
    await expect(f.consume()).rejects.toThrow();
    expect(f.calls).not.toContain('ack');
    expect(verifiedCompletedDebt({ ...f.debt, queue: { ...f.debt.queue, consumed: true } })).toBe(
      false,
    );
  });
  test.each([
    'partial',
    'noncounted',
    'classification',
    'unconsumed',
    'unreviewed',
    'reason',
    'no-content',
    'unsupported',
  ])('proof alone cannot bypass %s completion guard', async (kind) => {
    const settled = await (await delivery()).consume();
    if (!settled.vendorCompleted) throw new Error('missing completion');
    expect(verifiedCompletedDebt(settled)).toBe(true);
    const altered = structuredClone(settled);
    const document = altered.completion.document;
    if (kind === 'partial') document.outcome = 'partial-scope';
    if (kind === 'noncounted') document.counted = false;
    if (kind === 'classification')
      document.classification = { counted: false, outcome: 'completed' };
    if (kind === 'unconsumed') altered.queue.consumed = false;
    if (kind === 'unreviewed') altered.queue.reviewed = false;
    if (kind === 'reason')
      altered.queue.reason = { source: 'queue', category: 'identity', code: 'forge-identity' };
    if (kind === 'no-content') document.capture.paths = [];
    if (kind === 'unsupported') document.capture.paths[0]!.disposition = 'unsupported';
    expect(verifiedCompletedDebt(altered)).toBe(false);
    expect(deferredReceiptFindings([altered])).toEqual([]);
  });
  test('cross-item reuse is independent and alias proof never authorizes cross-item identity', async () => {
    const settled = await (await delivery()).consume();
    if (!settled.vendorCompleted) throw new Error('missing completion');
    const reuse = structuredClone(settled);
    delete reuse.queue.requestAlias;
    reuse.queue.itemId = 'different-current-item';
    reuse.queue.state = 'reused';
    expect(verifiedCompletedDebt(reuse)).toBe(false);
    reuse.queue.reusedFrom = 'original-item';
    expect(verifiedCompletedDebt(reuse)).toBe(true);
    // With no explicit equivalent reuse, a same-item alias cannot bridge item drift.
    delete reuse.queue.reusedFrom;
    reuse.queue.requestAlias = settled.queue.requestAlias;
    expect(verifiedCompletedDebt(reuse)).toBe(false);
  });
});
