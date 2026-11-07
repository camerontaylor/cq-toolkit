import { ReferenceSchema } from './internal/reviewOperation.js';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { headMessage, reviewOp } from './internal/localReview.js';
import { ReceiptSchema, reviewDigest } from './internal/reviewOperation.js';
import type { QueueTransport } from './internal/queueProtocol.js';
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export const makeResult = (transport?: QueueTransport) =>
  reviewOp(
    ReferenceSchema,
    async (i, getClient) => {
      const client = getClient();
      await client.capabilities();
      const buffers: Buffer[] = [];
      let first: { receipt_id: string; sha256: string; bytes: number; chunks: number } | undefined;
      for (let index = 0; ; index++) {
        const chunk = await client.request({ v: 1, op: 'result', request_id: i.requestId, index });
        if (!('index' in chunk)) {
          if (index === 0 && 'state' in chunk) return chunk;
          throw new Error('expected result chunk');
        }
        first ??= chunk;
        if (
          chunk.bytes > 64 * 1024 * 1024 ||
          chunk.chunks !== Math.max(1, Math.ceil(chunk.bytes / 3072)) ||
          chunk.index !== index ||
          chunk.chunks !== first.chunks ||
          chunk.bytes !== first.bytes ||
          chunk.sha256 !== first.sha256 ||
          chunk.receipt_id !== first.receipt_id ||
          chunk.sha256 !== chunk.receipt_id ||
          chunk.next_index !== (index + 1 === chunk.chunks ? null : index + 1)
        )
          throw new Error('inconsistent result manifest');
        const data = Buffer.from(chunk.data, 'base64');
        if (
          data.toString('base64') !== chunk.data ||
          data.length !== Math.min(3072, chunk.bytes - index * 3072) ||
          digest(data) !== chunk.chunk_sha256
        )
          throw new Error('result chunk integrity failure');
        buffers.push(data);
        if (chunk.next_index === null) break;
      }
      const data = Buffer.concat(buffers);
      if (data.length !== first.bytes || digest(data) !== first.sha256)
        throw new Error('whole result integrity failure');
      const receipt = ReceiptSchema.parse(JSON.parse(data.toString('utf8')));
      if (reviewDigest(receipt.identity_inputs) !== receipt.identity)
        throw new Error('receipt identity mismatch');
      const directory = join(i.cwd, '.cq/queue-evidence/results', first.receipt_id);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'receipt.json'), data, { mode: 0o600 });
      await writeFile(join(directory, 'report.md'), receipt.report, { mode: 0o600 });
      return {
        v: 1,
        action: 'observed',
        state: 'completed',
        request_id: i.requestId,
        receipt_id: first.receipt_id,
        reviewOutcome: receipt.outcome,
        scopeAdequate: receipt.scope_adequate,
        reviewedHead: receipt.identity_inputs.head_commit,
        message: await headMessage(i.cwd, receipt.identity_inputs.head_commit),
        directory,
      };
    },
    transport,
  );
