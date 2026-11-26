/**
 * The entry the coordinator executes as a worker process
 * (`node repairWorkerMain.js <payload>`, fd 3 = the private pipe).
 *
 * The payload is `{stateRoot, clone, configText, item, jobIds}`; the config is
 * re-parsed from its exact text because Python's fork inherits the loaded dict
 * and a parsed `JsonValue` cannot be re-serialized losslessly.
 *
 * `processItem` and the triage judge are deliberately unbound (recovery is held
 * on #2342): this entry's `processItem` rejects, which `drainItem` catches and
 * narrates, so a drain through it does no work and spends nothing.
 *
 * Importing this module has no effect; it runs only when it is the process entry.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseJsonValue } from '../../policy/crq/jsonValue.js';
import type { RepairDrainEffects } from '../../ops/crq/internal/repairDrain.js';
import { fdWorkerChannel, runWorkerChild } from './repairWorkerChild.js';
import { fileRepairUnit } from './repairUnit.js';

export interface WorkerPayload {
  readonly stateRoot: string;
  readonly clone: string;
  readonly configText: string;
  readonly item: string;
  readonly jobIds: readonly string[];
}

export function decodeWorkerPayload(text: string | undefined): WorkerPayload {
  const raw: unknown = JSON.parse(text ?? '');
  const p = raw as Record<string, unknown> | null;
  if (
    p === null ||
    typeof p !== 'object' ||
    typeof p['stateRoot'] !== 'string' ||
    typeof p['clone'] !== 'string' ||
    typeof p['configText'] !== 'string' ||
    typeof p['item'] !== 'string' ||
    !Array.isArray(p['jobIds']) ||
    !p['jobIds'].every((id) => typeof id === 'string')
  ) {
    throw new TypeError('malformed repair worker payload');
  }
  return p as unknown as WorkerPayload;
}

/** `narrate`: status lines go to stderr, one per line, stdout stays untouched. */
const narrateToStderr = (message: string): void => void process.stderr.write(`${message}\n`);

export function workerEffects(payload: WorkerPayload): RepairDrainEffects {
  const unit = fileRepairUnit({
    stateRoot: payload.stateRoot,
    clone: payload.clone,
    config: parseJsonValue(payload.configText),
    narrate: narrateToStderr,
  });
  return {
    ...unit.drain,
    ...unit.gates,
    processItem: () => Promise.reject(new Error('repair processItem is not bound')),
    triage: () => Promise.resolve(null),
    startWorker: () => {
      throw new Error('nested workers are not allowed');
    },
  };
}

/** Exit code of one worker process; an error before the body runs publishes nothing (EOF = not admitted). */
export async function runRepairWorkerMain(argv: readonly string[]): Promise<number> {
  try {
    const payload = decodeWorkerPayload(argv[2]);
    return await runWorkerChild(
      workerEffects(payload),
      payload.item,
      payload.jobIds,
      fdWorkerChannel(),
    );
  } catch {
    return 1;
  }
}

function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isProcessEntry()) {
  runRepairWorkerMain(process.argv)
    .then((code) => process.exit(code))
    .catch(() => process.exit(1));
}
