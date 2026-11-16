/** Inactive file binding of the repair harvest/outcome ledger seams
 * (`RepairHarvestEffects`: the findings lock + triage files and the publication
 * outbox). Python's `finding_inbox` needs the durable artifact root from
 * `STATE/backfill-rollout.json`, so the publication half reads it lazily on every call
 * and fails closed when the rollout is absent or invalid. Nothing imports it from a
 * runtime entry point.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepairHarvestEffects } from '../../ops/crq/internal/repairHarvestExecution.js';
import type { FindingPublication } from '../../ops/review/internal/crq/findingInbox.js';
import { fileArtifactStore, fileFindingInbox, fileFindingPublication } from './findingStore.js';
import { parseBackfillRollout } from './repairPreparation.js';

const text = new TextDecoder('utf-8', { fatal: true });

/** Roots under STATE: `backfill/findings` (triage + findings.lock) and
 * `backfill/publication` (pending + outbox.lock). */
export function findingLedgerRoots(stateRoot: string): { findings: string; publication: string } {
  return {
    findings: join(stateRoot, 'backfill', 'findings'),
    publication: join(stateRoot, 'backfill', 'publication'),
  };
}

export function fileRepairHarvestEffects(stateRoot: string): RepairHarvestEffects {
  const roots = findingLedgerRoots(stateRoot);
  const store = async (): Promise<FindingPublication> => {
    let raw = '';
    try {
      raw = text.decode(await readFile(join(stateRoot, 'backfill-rollout.json')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const rollout = parseBackfillRollout(raw);
    if (!rollout.ok)
      throw new Error('backfill repair write-back requires existing ledger configuration');
    return fileFindingPublication({
      root: roots.publication,
      artifacts: fileArtifactStore(rollout.durableArtifactRoot),
    });
  };
  return {
    files: fileFindingInbox(roots.findings),
    publication: {
      async retained() {
        return (await store()).retained();
      },
      async spool(value) {
        return (await store()).spool(value);
      },
    },
  };
}
