import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeQueueClient } from '../../../src/ops/review/internal/queueClient.js';
import { sha256 } from '../../../src/ops/review/internal/queueEvidence.js';
import type {
  QueueReference,
  QueueTransport,
} from '../../../src/ops/review/internal/queueProtocol.js';

const reference: QueueReference = {
  requestId: 'alias-2',
  binding: {
    kind: 'deferred-author',
    repo: 'owner/repo',
    producer: 'cycle-1',
    head: 'a'.repeat(40),
    target: 'merge-queue',
    targetSelector: 'promoted-main',
  },
};
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'cq-alias-'));
  dirs.push(dir);
  return dir;
}
function fixture(original = 'original-1', withProof = true) {
  const source = {
    repo: 'owner/repo',
    pr: 12,
    merge_sha: 'b'.repeat(40),
    target_selector: 'promoted-main',
    policy: 'affected-current-additions-v1',
  };
  const paths = [
    { disposition: 'included', path: 'a.ts', resolution: 'same-path-current', source_path: 'a.ts' },
  ];
  const document = {
    version: 1,
    item_id: 'current-item',
    request_id: original,
    source,
    capture: {
      target: 'c'.repeat(40),
      tree: 'd'.repeat(40),
      paths,
      scope_digest: sha256(Buffer.from(JSON.stringify(paths))),
      equivalence: 'e'.repeat(64),
      policy: source.policy,
      projection: 'current-affected-files/full-file-addition-projection',
      reviewer: 'coderabbit-review-agent-committed-v1',
      reviewer_version: 'fixture',
      captured_at: '2026-10-28T00:00:00Z',
    },
    outcome: 'terminal-with-findings',
    counted: true,
    classification: { counted: true, outcome: 'completed' },
    findings: [{ severity: 'major', text: 'retained finding '.repeat(1200) }],
    run_id: 'run-1',
    started_at: '2026-10-28T00:00:00Z',
    artifacts: {},
    remediation: 'disabled/deferred',
    independent_acceptance: false,
    cli_functional_acceptance: 'pending-D1',
  };
  const bytes = Buffer.from(JSON.stringify(document));
  const receiptId = sha256(bytes);
  const mergedSource = {
    kind: 'merged-current',
    repo: source.repo,
    pr: source.pr,
    mergeSha: source.merge_sha,
    targetSelector: source.target_selector,
  };
  const proof = {
    v: 1,
    reference,
    originalRequestId: original,
    itemId: document.item_id,
    source: mergedSource,
    policy: source.policy,
    receiptId,
    receiptEquivalence: document.capture.equivalence,
  };
  const status: Record<string, unknown> = {
    state: document.outcome,
    pr: source.pr,
    mergeSha: source.merge_sha,
    itemId: document.item_id,
    receiptId,
    consumed: false,
    reviewed: true,
    fixed: false,
    receiptSource: mergedSource,
    receiptEquivalence: document.capture.equivalence,
    ...(withProof ? { requestAlias: proof } : {}),
  };
  const common = {
    version: 1,
    receipt_id: receiptId,
    sha256: receiptId,
    bytes: bytes.length,
    chunks: Math.ceil(bytes.length / 3072),
    encoding: 'base64-utf8-json',
  };
  const calls: string[] = [];
  function transport(
    mutate?: (value: Record<string, unknown>, op: string) => void,
  ): QueueTransport {
    return async (wire) => {
      const req = JSON.parse(wire) as { op: string; cursor?: string | null };
      calls.push(req.op);
      let result: Record<string, unknown> = { ...status, consumed: req.op === 'ack' };
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
                  next_cursor: index + 1 < common.chunks ? receiptId + ':' + (index + 1) : null,
                },
        };
      }
      mutate?.(result, req.op);
      return JSON.stringify({ v: 1, ...reference, result });
    };
  }
  return { proof, document, receiptId, status, transport, calls };
}

describe('authenticated same-item receipt aliases', () => {
  test('retains original immutable bytes/findings with explicit proof and idempotent replay', async () => {
    const f = fixture();
    const dir = await directory();
    const client = makeQueueClient(f.transport());
    const evidence = await client.report(reference, dir);
    expect(evidence?.document.request_id).toBe('original-1');
    expect(evidence?.document.findings).toEqual(f.document.findings);
    expect(evidence).toMatchObject({
      fullBranchReadiness: false,
      independentAcceptance: false,
      fixed: false,
    });
    expect(await client.report(reference, dir)).toEqual(evidence);
    expect(await readdir(dir)).toEqual([f.receiptId + '.json']);
    expect(f.calls.filter((op) => op === 'ack')).toHaveLength(2);
  });
  test('ordinary original request remains compatible without proof', async () => {
    const f = fixture(reference.requestId, false);
    expect(
      await makeQueueClient(f.transport()).report(reference, await directory()),
    ).not.toBeNull();
  });
  test('mismatched original without proof refuses before import or acknowledgement', async () => {
    const f = fixture('original-1', false);
    const dir = await directory();
    await expect(makeQueueClient(f.transport()).report(reference, dir)).rejects.toThrow();
    expect(f.calls).not.toContain('ack');
    expect(await readdir(dir)).toEqual([]);
  });
  test.each([
    { v: 2 },
    { extra: 'authority' },
    { originalRequestId: 'forged' },
    { itemId: 'other-item' },
    { receiptId: 'f'.repeat(64) },
    { receiptEquivalence: 'f'.repeat(64) },
    { policy: 'other-policy' },
    { reference: { ...reference, requestId: 'other-request' } },
    { reference: { ...reference, binding: { ...reference.binding, head: 'f'.repeat(40) } } },
    {
      source: {
        kind: 'merged-current',
        repo: 'other/repo',
        pr: 12,
        mergeSha: 'b'.repeat(40),
        targetSelector: 'promoted-main',
      },
    },
    {
      source: {
        kind: 'merged-current',
        repo: 'owner/repo',
        pr: 13,
        mergeSha: 'b'.repeat(40),
        targetSelector: 'promoted-main',
      },
    },
    {
      source: {
        kind: 'merged-current',
        repo: 'owner/repo',
        pr: 12,
        mergeSha: 'f'.repeat(40),
        targetSelector: 'promoted-main',
      },
    },
    {
      source: {
        kind: 'merged-current',
        repo: 'owner/repo',
        pr: 12,
        mergeSha: 'b'.repeat(40),
        targetSelector: 'merge-queue',
      },
    },
  ])('refuses forged, stale or malformed proof %# before import/ack', async (patch) => {
    const f = fixture();
    const dir = await directory();
    const transport = f.transport((value, op) => {
      if (op !== 'report') value['requestAlias'] = { ...f.proof, ...patch };
    });
    await expect(makeQueueClient(transport).report(reference, dir)).rejects.toThrow();
    expect(f.calls).not.toContain('ack');
    expect(await readdir(dir)).toEqual([]);
  });
  test('status proof is bound to full caller reference before fetching pages', async () => {
    const f = fixture();
    await expect(
      makeQueueClient(f.transport()).status({ ...reference, requestId: 'different' }),
    ).rejects.toThrow();
    expect(f.calls).toEqual(['status']);
  });
  test('alias cannot masquerade as cross-item reuse', async () => {
    const f = fixture();
    const dir = await directory();
    f.status['reusedFrom'] = 'another-item';
    await expect(makeQueueClient(f.transport()).report(reference, dir)).rejects.toThrow();
    expect(f.calls).not.toContain('ack');
    expect(await readdir(dir)).toEqual([]);
  });
  test('changed acknowledgement proof cannot return delivered evidence as completion', async () => {
    const f = fixture();
    await expect(
      makeQueueClient(
        f.transport((value, op) => {
          if (op === 'ack') value['requestAlias'] = { ...f.proof, originalRequestId: 'changed' };
        }),
      ).report(reference, await directory()),
    ).rejects.toThrow();
    expect(f.calls.filter((op) => op === 'ack')).toHaveLength(1);
  });
  test('interrupted page delivery never imports or acknowledges and replay is possible', async () => {
    const f = fixture();
    const dir = await directory();
    const base = f.transport();
    let pages = 0;
    const interrupted: QueueTransport = async (wire) => {
      if ((JSON.parse(wire) as { op: string }).op === 'report' && ++pages === 3)
        throw new Error('disconnect');
      return base(wire);
    };
    await expect(makeQueueClient(interrupted).report(reference, dir)).rejects.toThrow('disconnect');
    expect(f.calls).not.toContain('ack');
    expect(await readdir(dir)).toEqual([]);
    expect(await makeQueueClient(base).report(reference, dir)).not.toBeNull();
  });
});
