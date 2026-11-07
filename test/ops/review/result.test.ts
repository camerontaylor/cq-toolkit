import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import vectors from '../../../apps/crq-python/fixtures/review-operation/vectors.json' with { type: 'json' };
import { makeResult } from '../../../src/ops/review/result.js';
import { makeStatus } from '../../../src/ops/review/status.js';
import {
  canonicalReview,
  ReceiptSchema,
  reviewDigest,
} from '../../../src/ops/review/internal/reviewOperation.js';
const caps = vectors.find((x) => x.name === 'capabilities-response')!.value;
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
for (const corrupt of ['none', 'chunk', 'whole', 'manifest'])
  test(`result verifies chunk and whole digests: ${corrupt}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cq-result-'));
    const receipt = ReceiptSchema.parse(
      vectors.find((x) => x.type === 'receipt' && x.valid)!.value,
    );
    receipt.identity = reviewDigest(receipt.identity_inputs);
    receipt.report = 'report '.repeat(1500);
    const bytes = Buffer.from(canonicalReview(receipt));
    const id = hash(bytes);
    const chunks = Math.ceil(bytes.length / 3072);
    const op = makeResult(async (raw) => {
      const req = JSON.parse(raw) as { op: string; index: number };
      if (req.op === 'capabilities') return JSON.stringify(caps);
      const data = bytes.subarray(req.index * 3072, (req.index + 1) * 3072);
      return JSON.stringify({
        v: 1,
        receipt_id: id,
        index: req.index,
        chunks,
        bytes: bytes.length,
        sha256: corrupt === 'whole' ? 'a'.repeat(64) : id,
        encoding: 'base64-utf8-json',
        data: data.toString('base64'),
        chunk_sha256: corrupt === 'chunk' ? 'b'.repeat(64) : hash(data),
        next_index:
          corrupt === 'manifest' ? req.index : req.index + 1 === chunks ? null : req.index + 1,
      });
    });
    const result = await op({ cwd, requestId: 'result-one' });
    const path = join(cwd, '.cq/queue-evidence/results', id, 'receipt.json');
    if (corrupt !== 'none') {
      expect(result.status).toBe('indeterminate');
      await expect(access(path)).rejects.toThrow();
    } else {
      expect(result.status).toBe('ok');
      // A detached checkout must not prevent verified evidence being saved.
      expect(await readFile(path, 'utf8')).toBe(bytes.toString());
      expect(await readFile(join(cwd, '.cq/queue-evidence/results', id, 'report.md'), 'utf8')).toBe(
        receipt.report,
      );
    }
  });
test('unsupported server is explicit and never falls back', async () => {
  const calls: string[] = [];
  const op = makeStatus(async (raw) => {
    calls.push(raw);
    return JSON.stringify({ v: 1, action: 'observed', state: 'unsupported' });
  });
  expect(await op({ requestId: 'unsupported' })).toMatchObject({
    status: 'ok',
    value: { state: 'unsupported' },
  });
  expect(calls).toHaveLength(1);
});

test('status refuses a valid response for the wrong request', async () => {
  const op = makeStatus(async (raw) => {
    const req = JSON.parse(raw) as { op: string };
    return JSON.stringify(
      req.op === 'capabilities'
        ? caps
        : { v: 1, action: 'observed', state: 'queued', request_id: 'someone-else' },
    );
  });
  expect((await op({ requestId: 'mine' })).status).toBe('indeterminate');
});
