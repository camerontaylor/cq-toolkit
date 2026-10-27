import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, link, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { QueueDigest, QueueRepo, QueueSha, QueueTarget } from './queueProtocol.js';

/** Current-scope receipt is deliberately incompatible with findings.ts v1. */
export const QueueReceiptSchema = z.looseObject({
  version: z.literal(1),
  source: z.looseObject({
    repo: QueueRepo,
    pr: z.number().int().positive(),
    merge_sha: QueueSha,
    target_selector: QueueTarget,
    policy: z.literal('affected-current-additions-v1'),
  }),
  capture: z.looseObject({
    target: QueueSha,
    tree: QueueSha,
    scope_digest: QueueDigest,
    equivalence: QueueDigest,
    policy: z.literal('affected-current-additions-v1'),
    projection: z.literal('current-affected-files/full-file-addition-projection'),
    reviewer: z.literal('coderabbit-review-agent-committed-v1'),
    reviewer_version: z.string().min(1),
    captured_at: z.string().datetime(),
    paths: z.array(
      z.looseObject({
        source_path: z.string().min(1),
        path: z.string().min(1),
        resolution: z.enum(['same-path-current', 'git-rename-M50']),
        disposition: z.enum([
          'included',
          'renamed',
          'deleted',
          'unsupported',
          'ambiguous',
          'excluded-with-reason',
        ]),
      }),
    ),
  }),
  item_id: z.string().min(1),
  request_id: z.string().nullable(),
  outcome: z.string(),
  counted: z.boolean(),
  classification: z.record(z.string(), z.unknown()).nullable(),
  findings: z.array(z.record(z.string(), z.unknown())),
  run_id: z.string().nullable(),
  started_at: z.string().datetime().nullable(),
  artifacts: z.record(z.string(), QueueDigest),
  remediation: z.literal('disabled/deferred'),
  independent_acceptance: z.literal(false),
  cli_functional_acceptance: z.literal('pending-D1'),
});
export type QueueReceipt = z.infer<typeof QueueReceiptSchema>;
export const QueueEvidenceSchema = z
  .object({
    schema: z.literal('cq-queue-evidence'),
    version: z.literal(1),
    receiptId: QueueDigest,
    document: QueueReceiptSchema,
    fullBranchReadiness: z.literal(false),
    independentAcceptance: z.literal(false),
    fixed: z.literal(false),
  })
  .strict();
export type QueueEvidence = z.infer<typeof QueueEvidenceSchema>;
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Python's canonical sorted ASCII JSON for the path-manifest digest. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => canonical(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}
export function parseQueueReceipt(value: unknown): QueueReceipt {
  const document = QueueReceiptSchema.parse(value);
  if (sha256(Buffer.from(canonical(document.capture.paths))) !== document.capture.scope_digest)
    throw new Error('queue scope manifest digest mismatch');
  return document;
}

/** Store exact immutable receipt bytes, not reserialized JSON (Python canonicalization differs).
 * A replay uses create-only publication and verifies existing bytes. No findings ledger writes.
 */
export async function importQueueEvidence(
  root: string,
  receiptId: string,
  bytes: Buffer,
): Promise<QueueEvidence> {
  QueueDigest.parse(receiptId);
  if (sha256(bytes) !== receiptId) throw new Error('queue evidence digest mismatch');
  const document = parseQueueReceipt(JSON.parse(bytes.toString('utf8')));
  const evidence = QueueEvidenceSchema.parse({
    schema: 'cq-queue-evidence',
    version: 1,
    receiptId,
    document,
    fullBranchReadiness: false,
    independentAcceptance: false,
    fixed: false,
  });
  await mkdir(root, { recursive: true });
  const path = join(root, receiptId + '.json');
  const temp = join(root, '.' + randomUUID());
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temp, path);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (!(await readFile(path)).equals(bytes)) throw new Error('existing queue evidence corrupt');
    }
    const dir = await open(root, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  return evidence;
}
export async function readQueueEvidence(root: string, receiptId: string): Promise<QueueEvidence> {
  QueueDigest.parse(receiptId);
  const bytes = await readFile(join(root, receiptId + '.json'));
  if (sha256(bytes) !== receiptId) throw new Error('queue evidence digest mismatch');
  return QueueEvidenceSchema.parse({
    schema: 'cq-queue-evidence',
    version: 1,
    receiptId,
    document: parseQueueReceipt(JSON.parse(bytes.toString('utf8'))),
    fullBranchReadiness: false,
    independentAcceptance: false,
    fixed: false,
  });
}
