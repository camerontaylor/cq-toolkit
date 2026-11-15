/**
 * Real file and clock bindings for the tick orchestrator's plain state seams
 * (`queue-runner/tickOrchestrator.ts`): the runner-disabled marker, `queue.json`
 * load and save, the clock and `parse_iso`, the `events.jsonl` append and the merged-discovery config flag. Every heavier phase
 * (discovery, harvest, delivery, admission, status) stays caller-injected.
 * Nothing here is imported by a runtime entry point.
 */
import { access, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonObject } from '../../policy/crq/jsonValue.js';
import { pythonJsonText } from '../../policy/crq/pythonJson.js';
import { parseIso } from '../../policy/crq/utc.js';
import type { TickPhases } from '../../queue-runner/tickOrchestrator.js';
import { atomicWrite } from './atomic.js';
import { isoUtc, loadQueueDocument, queueBytes } from './queueEffects.js';

export type TickSeamNames =
  | 'runnerDisabled'
  | 'loadQueue'
  | 'saveQueue'
  | 'parseIso'
  | 'nowMs'
  | 'nowIso'
  | 'event'
  | 'mergedDiscoveryEnabled';

/** `json.dumps(value)`: Python's default separators, ASCII escaped, one line. */
const line = (value: unknown): string =>
  pythonJsonText(value, {
    asciiOnly: true,
    sortKeys: false,
    spacedSeparators: true,
    trailingNewline: true,
  });

/**
 * The tick seams that are plain state access. `config` is the parsed `config.json`.
 * The watchdog heartbeat is not here: `fileHeartbeatEffects` (slotDeadlineSource.ts) with
 * `writeHeartbeat` (slotDeadlineHeartbeat.ts) is the single heartbeat seam.
 */
export function fileTickSeams(input: {
  stateRoot: string;
  config: JsonObject;
  now?: () => number;
}): Pick<TickPhases, TickSeamNames> {
  const queuePath = join(input.stateRoot, 'queue.json');
  const now = input.now ?? Date.now;
  const event: TickPhases['event'] = async (kind, data) => {
    await mkdir(input.stateRoot, { recursive: true });
    await appendFile(
      join(input.stateRoot, 'events.jsonl'),
      line({ at: isoUtc(new Date(now())), event: kind, ...data }),
    );
  };
  return {
    async runnerDisabled() {
      try {
        await access(join(input.stateRoot, 'runner-disabled'));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    // `persist_compaction` is Python's in-place migration; a queue that needs it
    // is refused (loadQueueDocument) rather than migrated by this adapter.
    loadQueue: () => loadQueueDocument(queuePath),
    saveQueue: (queue) => atomicWrite(queuePath, queueBytes(queue)),
    parseIso(value) {
      const parsed = parseIso(value);
      return parsed === null ? null : Number(parsed.epochMicros / 1000n);
    },
    nowMs: () => now(),
    nowIso: () => isoUtc(new Date(now())),
    event,
    mergedDiscoveryEnabled() {
      const merged = input.config.get('merged_discovery');
      return merged instanceof JsonObject && merged.get('enabled') === true;
    },
  };
}
