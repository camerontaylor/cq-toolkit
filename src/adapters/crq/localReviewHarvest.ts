import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonNumber, JsonObject, toPlainJson } from '../../policy/crq/jsonValue.js';
import { IdentitySchema, ReceiptSchema } from '../../ops/review/internal/reviewOperation.js';
import type { LocalHarvestEffects } from '../../ops/crq/localReviewHarvest.js';
import { writeLocalReviewReceipt } from './localReviewReceipt.js';

/** Python's integer schema rejects 1.0 even where a JS schema sees 1. */
function version(value: JsonObject): void {
  const v = value.get('v');
  if (!(v instanceof JsonNumber) || v.kind !== 'int' || v.integer !== 1n)
    throw new Error('invalid schema version');
}
export function validateLocalReviewIdentity(value: JsonObject): void {
  version(value);
  IdentitySchema.parse(toPlainJson(value));
}
export function validateLocalReviewReceipt(value: JsonObject): void {
  version(value);
  const identity = value.get('identity_inputs');
  if (!(identity instanceof JsonObject)) throw new Error('invalid identity');
  validateLocalReviewIdentity(identity);
  ReceiptSchema.parse(toPlainJson(value));
}

/** Bind receipt completion I/O. The caller supplies its queue persistence and republisher under tick.lock. */
export function fileLocalHarvestEffects(options: {
  stateRoot: string;
  saveQueue: (queue: JsonObject) => Promise<void>;
  republish: (queue: JsonObject, item: JsonObject) => Promise<JsonObject>;
}): LocalHarvestEffects {
  const runs = join(options.stateRoot, 'runs');
  function file(runId: string, name: string): string {
    if (!runId || runId === '.' || runId === '..' || /[/\\\0]/.test(runId))
      throw new Error('invalid run id');
    return join(runs, runId, name);
  }
  return {
    readReview: (runId) => readFile(file(runId, 'review.ndjson')),
    async readReport(runId) {
      try {
        return await readFile(file(runId, 'findings.md'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    validateReceipt: validateLocalReviewReceipt,
    writeReceipt: (document) =>
      writeLocalReviewReceipt(join(options.stateRoot, 'receipts'), document),
    saveQueue: options.saveQueue,
    republish: options.republish,
  };
}
