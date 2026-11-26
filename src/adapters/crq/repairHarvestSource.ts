/** Inactive file binding of the repair harvest/outcome ledger seams
 * (`RepairHarvestEffects`: the findings lock + triage files and the publication
 * outbox). Python's `finding_inbox` needs a complete
 * `STATE/backfill-rollout.json` (`settings`), so the publication half reads it lazily on every call
 * and fails closed when the rollout is absent or invalid. Nothing imports it from a
 * runtime entry point.
 */
import { join } from 'node:path';
import type { RepairHarvestEffects } from '../../ops/crq/internal/repairHarvestExecution.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import type { FindingPublication } from '../../ops/review/internal/crq/findingInbox.js';
import { fileArtifactStore, fileFindingInbox, fileFindingPublication } from './findingStore.js';
import {
  LedgerIntegrityError,
  LedgerJsonDecodeError,
  LedgerUnicodeDecodeError,
} from '../../policy/crq/ledger.js';
import { readBackfillRollout } from './backfillRollout.js';
import { SpoolConfigError } from './publisherSpool.js';

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
  /**
   * `finding_inbox`: `backfill_runtime.settings(state)` (every prerequisite, so
   * an incomplete rollout is refused as Python refuses it), then the store at
   * its `durable_artifact_root`. Python's refusals (`IntegrityError`,
   * `JSONDecodeError`, a missing file) are all `ValueError`s, which
   * `repair_tick.harvest` catches by class.
   */
  const store = async (): Promise<FindingPublication> => {
    let rollout;
    try {
      rollout = await readBackfillRollout(stateRoot);
    } catch (error) {
      if (
        error instanceof LedgerIntegrityError ||
        error instanceof LedgerJsonDecodeError ||
        error instanceof LedgerUnicodeDecodeError ||
        error instanceof SpoolConfigError
      )
        throw new PyError('ValueError', error.message);
      throw error;
    }
    if (rollout === null)
      throw new PyError(
        'ValueError',
        'backfill repair write-back requires existing ledger configuration',
      );
    const root = rollout.get('durable_artifact_root');
    if (typeof root !== 'string')
      throw new PyError('TypeError', 'durable_artifact_root must be a string');
    return fileFindingPublication({
      root: roots.publication,
      artifacts: fileArtifactStore(root),
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
