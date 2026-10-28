import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  QueueBindSchema,
  QueueDigest,
  QueueReferenceSchema,
  QueueStatusSchema,
  QUEUE_WIRE_BYTES,
  type DeferredQueueClient,
  type QueueReference,
  type QueueTransport,
  type QueueBindInput,
} from './queueProtocol.js';
import {
  importQueueEvidence,
  parseQueueReceipt,
  sha256,
  type QueueEvidence,
} from './queueEvidence.js';

const CommonPage = z.object({
  version: z.literal(1),
  receipt_id: QueueDigest,
  sha256: QueueDigest,
  bytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  chunks: z.number().int().positive().max(21846),
  encoding: z.literal('base64-utf8-json'),
});
const ManifestSchema = CommonPage.extend({
  kind: z.literal('manifest'),
  cursor: z.string(),
}).strict();
const ChunkSchema = CommonPage.extend({
  kind: z.literal('chunk'),
  index: z.number().int().nonnegative(),
  chunk_sha256: QueueDigest,
  data: z.string().max(4096),
  next_cursor: z.string().nullable(),
}).strict();

export class QueueUnsupported extends Error {}
export class QueueConfigurationError extends Error {}

/** Production factory shared by Q6; configuration never rides caller JSON. */
export function makeConfiguredQueueClient() {
  const alias = process.env['CQ_QUEUE_SSH_ALIAS'];
  if (!alias)
    throw new QueueConfigurationError(
      'Configure CQ_QUEUE_SSH_ALIAS for reviewed D1C queue-v1 capability',
    );
  return makeQueueClient(sshQueueTransport(alias));
}

/** Fixed capability only; alias is operator configured, never a request field. */
export function sshQueueTransport(alias: string): QueueTransport {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(alias)) throw new Error('invalid queue SSH alias');
  return (request) =>
    new Promise((resolve, reject) => {
      if (Buffer.byteLength(request) > QUEUE_WIRE_BYTES) {
        reject(new Error('oversized queue request'));
        return;
      }
      const child = spawn(
        'ssh',
        [
          '-T',
          '-S',
          'none',
          '-o',
          'BatchMode=yes',
          '-o',
          'IdentitiesOnly=yes',
          '-o',
          'ConnectTimeout=15',
          '-o',
          'ConnectionAttempts=1',
          '-o',
          'ClearAllForwardings=yes',
          '-o',
          'RequestTTY=no',
          '--',
          alias,
          'queue-v1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('queue delivery unknown: timeout'));
      }, 45000);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > QUEUE_WIRE_BYTES) {
          child.kill('SIGKILL');
          reject(new Error('oversized queue response'));
        } else chunks.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on('error', () => undefined);
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error('queue transport unavailable'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && size <= QUEUE_WIRE_BYTES) resolve(Buffer.concat(chunks).toString('utf8'));
        else
          reject(
            new Error('queue delivery unknown: refused or interrupted; deployment may be required'),
          );
      });
      child.stdin.end(request);
    });
}

export function makeQueueClient(transport: QueueTransport): DeferredQueueClient & {
  report(
    input: QueueReference,
    evidenceDir: string,
    options?: {
      onEvidenceImported?: (evidence: { receiptId: string; path: string }) => Promise<void>;
    },
  ): Promise<QueueEvidence | null>;
} {
  async function request(
    op: string,
    input: QueueReference,
    extra: Record<string, unknown> = {},
  ): Promise<unknown> {
    const ref = QueueReferenceSchema.parse(input);
    const wire = JSON.stringify({ v: 1, op, ...ref, ...extra }) + '\n';
    if (Buffer.byteLength(wire) > QUEUE_WIRE_BYTES) throw new Error('oversized queue request');
    const raw = await transport(wire);
    if (Buffer.byteLength(raw) > QUEUE_WIRE_BYTES) throw new Error('oversized queue response');
    const envelope = z
      .object({
        v: z.literal(1),
        requestId: z.string(),
        binding: QueueReferenceSchema.shape.binding,
        result: z.unknown(),
      })
      .strict()
      .parse(JSON.parse(raw));
    if (envelope.requestId !== ref.requestId || !isDeepStrictEqual(envelope.binding, ref.binding))
      throw new Error('queue response binding mismatch');
    if (
      typeof envelope.result === 'object' &&
      envelope.result !== null &&
      'unsupported' in envelope.result
    )
      throw new QueueUnsupported(
        'Compatible Q1 runner and reviewed D1C queue-v1 deployment required',
      );
    return envelope.result;
  }
  function parseStatus(input: QueueReference, value: unknown) {
    const current = QueueStatusSchema.parse(value);
    const alias = current.requestAlias;
    if (
      alias &&
      (!isDeepStrictEqual(alias.reference, input) ||
        alias.originalRequestId === input.requestId ||
        current.reusedFrom ||
        alias.itemId !== current.itemId ||
        alias.receiptId !== current.receiptId ||
        alias.receiptEquivalence !== current.receiptEquivalence ||
        !isDeepStrictEqual(alias.source, current.receiptSource) ||
        alias.source.repo !== input.binding.repo ||
        alias.source.targetSelector !== input.binding.targetSelector ||
        alias.source.pr !== current.pr ||
        alias.source.mergeSha !== current.mergeSha ||
        (input.binding.kind === 'merged-current' &&
          !isDeepStrictEqual(alias.source, input.binding)))
    )
      throw new Error('queue alias status binding mismatch');
    return current;
  }
  const status = async (input: QueueReference) =>
    parseStatus(input, await request('status', input));
  return {
    enqueue: async (input) => parseStatus(input, await request('enqueue', input)),
    status,
    bind: async (input: QueueBindInput) => {
      const i = QueueBindSchema.parse(input);
      return parseStatus(
        { requestId: i.requestId, binding: i.binding },
        await request(
          'bind',
          { requestId: i.requestId, binding: i.binding },
          { pr: i.pr, mergeSha: i.mergeSha ?? null },
        ),
      );
    },
    cancel: async (input) => parseStatus(input, await request('cancel', input)),
    report: async (input, evidenceDir, options) => {
      const current = await status(input);
      if (!current.receiptId) return null;
      const receiptId = current.receiptId;
      const manifest = ManifestSchema.parse(
        z
          .object({ page: ManifestSchema })
          .strict()
          .parse(await request('report', input, { receiptId, cursor: null })).page,
      );
      if (
        manifest.receipt_id !== receiptId ||
        manifest.sha256 !== receiptId ||
        manifest.cursor !== receiptId + ':0' ||
        manifest.chunks !== Math.ceil(manifest.bytes / 3072)
      )
        throw new Error('invalid queue manifest');
      const chunks: Buffer[] = [];
      for (let index = 0; index < manifest.chunks; index++) {
        const page = z
          .object({ page: ChunkSchema })
          .strict()
          .parse(
            await request('report', input, { receiptId, cursor: receiptId + ':' + index }),
          ).page;
        if (
          page.receipt_id !== receiptId ||
          page.sha256 !== receiptId ||
          page.bytes !== manifest.bytes ||
          page.chunks !== manifest.chunks ||
          page.index !== index ||
          page.next_cursor !== (index + 1 < manifest.chunks ? receiptId + ':' + (index + 1) : null)
        )
          throw new Error('mixed or out-of-order queue page');
        const bytes = Buffer.from(page.data, 'base64');
        if (
          bytes.toString('base64') !== page.data ||
          bytes.length !== Math.min(3072, manifest.bytes - index * 3072) ||
          sha256(bytes) !== page.chunk_sha256
        )
          throw new Error('invalid queue chunk digest/size');
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== manifest.bytes || sha256(bytes) !== receiptId)
        throw new Error('queue receipt digest mismatch');
      const document = parseQueueReceipt(JSON.parse(bytes.toString('utf8')));
      const b = input.binding;
      const reused =
        current.reusedFrom &&
        current.receiptSource &&
        current.receiptEquivalence === document.capture.equivalence &&
        current.receiptSource.repo === document.source.repo &&
        current.receiptSource.pr === document.source.pr &&
        current.receiptSource.mergeSha === document.source.merge_sha &&
        current.receiptSource.targetSelector === document.source.target_selector;
      if (
        document.source.repo !== b.repo ||
        document.source.target_selector !== b.targetSelector ||
        (!reused &&
          (document.source.pr !== current.pr ||
            document.source.merge_sha !== current.mergeSha ||
            (b.kind === 'merged-current' &&
              (document.source.pr !== b.pr || document.source.merge_sha !== b.mergeSha))))
      )
        throw new Error('receipt source binding mismatch');
      const alias = current.requestAlias;
      if (
        !reused &&
        (document.item_id !== current.itemId ||
          (document.request_id !== input.requestId && !alias) ||
          (alias &&
            (alias.originalRequestId !== document.request_id ||
              alias.itemId !== document.item_id ||
              alias.receiptId !== receiptId ||
              alias.receiptEquivalence !== document.capture.equivalence ||
              alias.policy !== document.source.policy ||
              alias.source.repo !== document.source.repo ||
              alias.source.pr !== document.source.pr ||
              alias.source.mergeSha !== document.source.merge_sha ||
              alias.source.targetSelector !== document.source.target_selector)))
      )
        throw new Error('receipt original request or alias binding mismatch');
      const evidence = await importQueueEvidence(evidenceDir, receiptId, bytes);
      await options?.onEvidenceImported?.({
        receiptId,
        path: join(evidenceDir, receiptId + '.json'),
      });
      const ack = parseStatus(
        input,
        await request('ack', input, {
          receiptId,
          sha256: receiptId,
          chunks: manifest.chunks,
          bytes: manifest.bytes,
        }),
      );
      if (
        !ack.consumed ||
        ack.receiptId !== receiptId ||
        ack.itemId !== current.itemId ||
        !isDeepStrictEqual(ack.requestAlias ?? null, current.requestAlias ?? null)
      )
        throw new Error('queue acknowledgement mismatch');
      return evidence;
    },
  };
}
