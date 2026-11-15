/**
 * Real file and clock bindings for the tick orchestrator's plain state seams
 * (`queue-runner/tickOrchestrator.ts`): the runner-disabled marker, `queue.json`
 * load and save, the clock and `parse_iso`, the `events.jsonl` append, the
 * watchdog heartbeat and the merged-discovery config flag. Every heavier phase
 * (discovery, harvest, delivery, admission, status) stays caller-injected.
 * Nothing here is imported by a runtime entry point.
 */
import { access, appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonNumber, JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
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
  | 'writeHeartbeat'
  | 'mergedDiscoveryEnabled';

const DEFAULT_STALE_ALARM_MIN = 36;

/** `json.dumps(value)`: Python's default separators, ASCII escaped, one line. */
const line = (value: unknown): string =>
  pythonJsonText(value, {
    asciiOnly: true,
    sortKeys: false,
    spacedSeparators: true,
    trailingNewline: true,
  });

/**
 * The tick seams that are plain state access. `config` is the parsed
 * `config.json`, `watchdogHome` is `$XDG_STATE_HOME/crq`, `root` is `crq.ROOT`.
 */
export function fileTickSeams(input: {
  stateRoot: string;
  watchdogHome: string;
  root: string;
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
    async writeHeartbeat(queue) {
      const alerts = input.config.get('alerts');
      const alert = (key: string): JsonValue =>
        alerts instanceof JsonObject ? (alerts.get(key) ?? null) : null;
      const body = line({
        last_tick: queue.get('last_tick'),
        stale_alarm_min:
          input.config.get('stale_alarm_min') ?? JsonNumber.int(DEFAULT_STALE_ALARM_MIN),
        schedule_id: input.config.get('schedule_id') ?? null,
        root: input.root,
        alert_agent_id: alert('alert_agent_id'),
        alert_agent_host: alert('alert_agent_host'),
      });
      try {
        await mkdir(input.watchdogHome, { recursive: true });
        const temporary = join(input.watchdogHome, '.heartbeat.json.tmp');
        await writeFile(temporary, body);
        await rename(temporary, join(input.watchdogHome, 'heartbeat.json'));
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error)) throw error;
        await event('heartbeat_failed', { error: error.message.slice(0, 200) });
      }
    },
    mergedDiscoveryEnabled() {
      const merged = input.config.get('merged_discovery');
      return merged instanceof JsonObject && merged.get('enabled') === true;
    },
  };
}
