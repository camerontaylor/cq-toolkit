import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DevEffects } from '../effects.js';
import { withQueueLifetime } from '../../review/internal/queueClient.js';
import type {
  DeferredQueueClient,
  QueueLifetimeOptions,
} from '../../review/internal/queueProtocol.js';
import { QueueStatusSchema } from '../../review/internal/queueProtocol.js';
import { readQueueEvidence, type QueueEvidence } from '../../review/internal/queueEvidence.js';
import { verifiedCompletedDebt, type DeferredVendorDebt } from './deferredReview.js';

interface ReportClient extends DeferredQueueClient {
  report(
    reference: DeferredVendorDebt['reference'],
    evidenceDir: string,
    options?: QueueLifetimeOptions,
  ): Promise<QueueEvidence | null>;
}
function hasReport(client: DeferredQueueClient): client is ReportClient {
  return 'report' in client && typeof client.report === 'function';
}

/** Same sorted ASCII identity Q1 binds, including the entire resolved path manifest. */
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

/** Report delivery/acknowledgement is Q3-owned. A status or a locally invented
 * completion envelope is insufficient. Re-read the imported immutable bytes,
 * bind Q1's capture identity, and verify its target tree locally before settlement.
 * Missing local capture objects fail closed; this never fetches or dispatches.
 */
export async function consumeDeferredVendorReport(
  effects: DevEffects,
  client: DeferredQueueClient,
  debt: DeferredVendorDebt,
  signal?: AbortSignal,
  remainingMs?: () => number,
): Promise<DeferredVendorDebt> {
  return withQueueLifetime(
    { ...(signal ? { signal } : {}), ...(remainingMs ? { remainingMs } : {}) },
    async (lifetime) => {
      if (!hasReport(client))
        throw new Error('verified queue report capability is required for settlement');
      const command = async (args: string[]) => {
        const result = await lifetime.wait(() =>
          effects.runCommand('git', args, {
            timeoutMs: Math.max(1, Math.floor(Math.min(30_000, lifetime.remainingMs()))),
            signal: lifetime.options.signal!,
          }),
        );
        if (result.exitCode !== 0 || result.timedOut)
          throw new Error('cannot verify queue capture identity locally');
        return result.stdout.trim();
      };
      const root = await command(['rev-parse', '--show-toplevel']);
      const evidenceDir = join(root, '.cq', 'queue-evidence');
      const delivered = await lifetime.wait(() =>
        client.report(debt.reference, evidenceDir, lifetime.options),
      );
      if (!delivered) throw new Error('terminal queue status has no verified report');
      const evidence = await lifetime.wait(() =>
        readQueueEvidence(evidenceDir, delivered.receiptId),
      );
      if (!isDeepStrictEqual(delivered, evidence))
        throw new Error('queue report differs from imported bytes');
      const capture = evidence.document.capture;
      const identity = Object.fromEntries(
        [
          'target',
          'tree',
          'paths',
          'scope_digest',
          'policy',
          'projection',
          'reviewer',
          'reviewer_version',
        ].map((key) => [key, capture[key]]),
      );
      const equivalence = createHash('sha256').update(canonical(identity)).digest('hex');
      if (
        equivalence !== capture.equivalence ||
        (await command(['rev-parse', '--verify', `${capture.target}^{tree}`])) !== capture.tree
      )
        throw new Error('queue capture target/tree/equivalence mismatch');
      const queue = QueueStatusSchema.parse(
        await lifetime.wait(() => client.status(debt.reference, lifetime.options)),
      );
      const completed: DeferredVendorDebt = {
        reference: debt.reference,
        originAttempt: debt.originAttempt,
        deferral: debt.deferral,
        ...(debt.predecessor ? { predecessor: debt.predecessor } : {}),
        queue,
        vendor: 'vendor-completed',
        vendorCompleted: true,
        completion: evidence,
      };
      if (!verifiedCompletedDebt(completed))
        throw new Error('report does not prove genuine complete current vendor review');
      if (debt.vendorCompleted && !isDeepStrictEqual(debt.completion, evidence))
        throw new Error('settled vendor receipt changed');
      return completed;
    },
  );
}
