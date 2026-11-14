import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonObject, parseJsonValue } from '../../policy/crq/jsonValue.js';
import { ledgerCanonicalBytes } from '../../policy/crq/ledger.js';
import { sha256Hex } from '../../policy/crq/pythonJson.js';
import { MAX_RECEIPT_BYTES } from '../../policy/crq/queueReceipt.js';
import { withoutObjectKey } from '../../policy/crq/queueDoc.js';
import type { LocalReviewPublishEffects } from '../../ops/crq/internal/localReviewPublish.js';
import { atomicWrite } from './atomic.js';
import { fileArtifactStore, fileFindingPublication } from './findingStore.js';

/** Caller provides validated rollout settings and persists queue under the existing tick.lock. */
export function fileLocalReviewPublishEffects(options: {
  stateRoot: string;
  rollout: () => Promise<{ durableArtifactRoot: string } | null>;
  saveQueue: (queue: JsonObject) => Promise<void>;
}): LocalReviewPublishEffects {
  let root: string | null = null;
  const publicationRoot = join(options.stateRoot, 'backfill', 'publication');
  function artifacts() {
    if (root === null) throw new Error('publication settings unavailable');
    return fileArtifactStore(root);
  }
  return {
    async enabled() {
      const settings = await options.rollout();
      root = settings?.durableArtifactRoot ?? null;
      return settings !== null;
    },
    async readReceipt(id) {
      if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('invalid receipt id');
      const bytes = await readFile(join(options.stateRoot, 'receipts', `${id}.json`));
      if (bytes.length > MAX_RECEIPT_BYTES)
        throw new Error('receipt exceeds supported client capacity');
      if (sha256Hex(bytes) !== id) throw new Error('receipt digest mismatch');
      const value = parseJsonValue(new TextDecoder('utf-8', { fatal: true }).decode(bytes), {
        duplicates: 'error',
      });
      if (!(value instanceof JsonObject)) throw new Error('invalid receipt');
      return value;
    },
    async putArtifact(bytes) {
      const ref = await artifacts().put(bytes);
      return new JsonObject([
        ['sha256', ref.sha256],
        ['location', ref.location],
      ]);
    },
    async spool(event) {
      await fileFindingPublication({ root: publicationRoot, artifacts: artifacts() }).spool(event);
    },
    async hasAck(id) {
      try {
        await stat(join(publicationRoot, 'ack', `${id}.json`));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    async requestPublish(queue) {
      const settings = await options.rollout();
      if (settings === null) return queue;
      const dir = join(options.stateRoot, 'backfill');
      await mkdir(dir, { recursive: true });
      await atomicWrite(
        join(dir, 'publish-request.json'),
        ledgerCanonicalBytes(new JsonObject([['request', randomUUID().replaceAll('-', '')]])),
      );
      return queue.get('backfill_halt_operation') === 'publication-request'
        ? withoutObjectKey(withoutObjectKey(queue, 'backfill_halted'), 'backfill_halt_operation')
        : queue;
    },
    saveQueue: options.saveQueue,
  };
}
