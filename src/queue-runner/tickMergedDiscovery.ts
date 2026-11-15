/**
 * The merged-discovery step of `tick` (crq.py:3384-3392): the config gate, the
 * invalid-interval fallback and the log lines of `discover_merged`. Inactive:
 * the interval arithmetic (`rollingInterval`) and the transaction
 * (`discoverRolling`) already exist; this only sequences them. The forge
 * window/budget, deferred refresh, push and PR enrollment stay with the caller.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../policy/crq/jsonValue.js';
import { withObjectKeys } from '../policy/crq/queueDoc.js';
import { ReconcileRefused, type ReconcileInterval } from '../policy/crq/reconcileCheckpoint.js';
import { rollingInterval } from './discovery.js';

export interface TickMergedDiscoveryEffects {
  now(): Date;
  /** `discover_merged(q, budget, interval=…, recent=True)` via `discoverRolling`. */
  discover(
    interval: ReconcileInterval,
  ): Promise<{ queue: JsonObject; summary: JsonObject; pruned: number }>;
}

function pyBool(value: unknown): string {
  return value === true ? 'True' : 'False';
}

/** Python `ValueError`/`TypeError`/`ReconcileRefused` from the interval, nothing else. */
function isIntervalRefusal(error: unknown): boolean {
  return (
    error instanceof ReconcileRefused ||
    (error instanceof Error && error.message === 'invalid merged watermark')
  );
}

function represented(summary: JsonObject): string {
  const value = summary.get('represented');
  if (value instanceof JsonNumber && value.kind === 'int') return String(value.integer);
  throw new TypeError("discovery summary lacks an integer 'represented'");
}

/** Returns the queue to carry forward and the log lines; never persists the fallback. */
export async function runMergedDiscoveryStep(
  queue: JsonObject,
  config: unknown,
  effects: TickMergedDiscoveryEffects,
): Promise<{ queue: JsonObject; log: string[] }> {
  if (!(config instanceof JsonObject) || config.get('enabled') !== true) return { queue, log: [] };
  let interval: ReconcileInterval;
  try {
    interval = rollingInterval(queue, config.get('after'), effects.now());
  } catch (error) {
    if (!isIntervalRefusal(error)) throw error;
    // `q.setdefault("merged_discovery", {})["complete"] = False`
    const active = queue.get('merged_discovery');
    if (queue.has('merged_discovery') && !(active instanceof JsonObject)) {
      throw new TypeError('merged_discovery is not an object');
    }
    const next = withObjectKeys(active instanceof JsonObject ? active : new JsonObject([]), [
      ['complete', false],
    ]);
    return {
      queue: withObjectKeys(queue, [['merged_discovery', next]]),
      log: ['merged discovery disabled: invalid configured interval'],
    };
  }
  const result = await effects.discover(interval);
  const record = result.queue.get('merged_discovery');
  const complete = result.summary.get('complete');
  if (complete === false && record instanceof JsonObject && record.has('error')) {
    const error = String(record.get('error') as JsonValue);
    if (record.get('reason') === 'inventory-cap-partitioned') {
      return {
        queue: result.queue,
        log: [
          `merged discovery incomplete; inventory cap: partitioned to (${String(record.get('after'))}, ${String(record.get('before'))}]`,
        ],
      };
    }
    return {
      queue: result.queue,
      log: ['merged discovery incomplete; cursor/debt retained: ' + error],
    };
  }
  const reason = result.summary.get('reason');
  const log = [
    `merged discovery: complete=${pyBool(complete)} represented=${represented(result.summary)}` +
      (typeof reason === 'string' && reason !== '' ? ` reason=${reason}` : ''),
  ];
  if (result.pruned) {
    log.push(`pruned ${String(result.pruned)} completed rolling discovery checkpoint(s)`);
  }
  return { queue: result.queue, log };
}
