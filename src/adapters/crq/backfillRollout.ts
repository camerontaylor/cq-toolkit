/**
 * `backfill_runtime.settings(state)` (the non-dispatch read): the operator's
 * `state/backfill-rollout.json`. Absent means backfill publication is not
 * provisioned (`null`); present but incomplete is an integrity refusal. Shared
 * by the operator transaction and the in-tick inventory binding.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonObject } from '../../policy/crq/jsonValue.js';
import { ledgerLoads, pythonTruthy, LedgerIntegrityError } from '../../policy/crq/ledger.js';
import { parsePublisherSpool } from './publisherSpool.js';

const REQUIRED = [
  'operational_ruling',
  'no_live_run_verification',
  'owner_branch_ruleset_evidence',
  'durable_artifact_root',
  'runner_identity',
  'publisher_spool',
] as const;

export async function readOptionalFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readBackfillRollout(stateRoot: string): Promise<JsonObject | null> {
  const bytes = await readOptionalFile(join(stateRoot, 'backfill-rollout.json'));
  if (bytes === null) return null;
  const value = ledgerLoads(bytes);
  if (
    !(value instanceof JsonObject) ||
    REQUIRED.some((key) => !pythonTruthy(value.get(key))) ||
    value.get('runner_identity') !== 'crq-runner-app'
  )
    throw new LedgerIntegrityError('backfill rollout prerequisites incomplete');
  parsePublisherSpool(value.get('publisher_spool'));
  return value;
}

/**
 * `TickPhases.backfillInventoryMode`: the rollout's `inventory_mode`, or null
 * when no rollout is provisioned. A malformed rollout throws, which the tick
 * records as an inventory halt exactly as Python's `settings` raise does.
 */
export async function backfillInventoryMode(stateRoot: string): Promise<string | null> {
  const mode = (await readBackfillRollout(stateRoot))?.get('inventory_mode');
  return typeof mode === 'string' ? mode : null;
}
