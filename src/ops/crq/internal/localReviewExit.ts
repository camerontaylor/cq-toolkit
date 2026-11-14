import { JsonNumber, JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { pyTruthy, withObjectKeys } from '../../../policy/crq/queueDoc.js';
import { parseIso, formatUtcMicros } from '../../../policy/crq/utc.js';
import type { RunLiveness } from '../../../policy/crq/runLiveness.js';
import { renderLocalReviewFindings } from './localReviewReport.js';

/** Caller holds tick.lock. Methods are ordered exactly as Python's local-review harvest. */
export interface LocalExitHarvestEffects {
  liveness(runId: string, run: JsonObject): Promise<RunLiveness>;
  readExit(runId: string): Promise<JsonObject>;
  writeNext(now: string): Promise<void>;
  readMeta(runId: string): Promise<JsonObject>;
  readStream(runId: string): Promise<Uint8Array | null>;
  classify(bytes: Uint8Array | null, exitCode: number | null): JsonObject;
  writeClassification(runId: string, classification: JsonObject): Promise<void>;
  writeFindings(runId: string, report: string): Promise<void>;
  event(kind: string, data: JsonObject): Promise<void>;
  complete(
    queue: JsonObject,
    item: JsonObject,
    runId: string,
    cls: JsonObject,
    endedAt: string,
    exitCode: number | null,
  ): Promise<JsonObject>;
  cleanup(item: JsonObject, meta: JsonObject): Promise<void>;
  nowIso(): string;
}
function object(v: JsonValue | undefined): JsonObject {
  if (!(v instanceof JsonObject)) throw new Error('expected object');
  return v;
}
function required(v: JsonObject, key: string): JsonValue {
  const found = v.get(key);
  if (found === undefined) throw new Error(`missing ${key}`);
  return found;
}
function string(v: JsonValue | undefined): string {
  if (typeof v !== 'string') throw new Error('expected string');
  return v;
}
function replaceItem(queue: JsonObject, old: JsonObject, item: JsonObject): JsonObject {
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new Error('missing queue items');
  const index = items.indexOf(old);
  if (index < 0) throw new Error('item not in queue');
  const next = [...items];
  next[index] = item;
  return withObjectKeys(queue, [['items', next]]);
}
function seconds(value: JsonValue | undefined): number | null {
  if (!(value instanceof JsonNumber)) return null;
  const n = value.integer === null ? value.float : Number(value.integer);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
function cooldown(
  queue: JsonObject,
  cls: JsonObject,
  exit: JsonObject,
  now: string,
  defaultMinutes: number,
): JsonObject {
  const configured = queue.get('rl_backoff_min');
  const wait = cls.get('wait_seconds');
  const hasWait = wait !== undefined && wait !== null;
  const delay = hasWait
    ? seconds(wait)
    : pyTruthy(configured)
      ? seconds(configured)
      : defaultMinutes;
  if (delay === null) throw new Error('invalid cooldown duration');
  const delaySeconds = hasWait ? delay : delay * 60;
  let ended;
  try {
    ended = parseIso(exit.get('ended_at')) ?? parseIso(now);
  } catch {
    ended = parseIso(now);
  }
  if (ended === null) throw new Error('invalid current time');
  const deadline = ended.epochMicros + BigInt(Math.round(delaySeconds * 1_000_000));
  const current = parseIso(queue.get('cooldown_until'));
  const result =
    current !== null && current.epochMicros > deadline ? current.epochMicros : deadline;
  return withObjectKeys(queue, [['cooldown_until', formatUtcMicros(result).slice(0, 19) + 'Z']]);
}
function cleanupFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'Error' || typeof (error as NodeJS.ErrnoException).code === 'string')
  );
}

/** Only local-review is supported; all other kinds remain with their own lifecycle. */
export async function harvestLocalReviewExit(
  queue: JsonObject,
  item: JsonObject,
  dry: boolean,
  defaultBackoffMinutes: number,
  effects: LocalExitHarvestEffects,
): Promise<{ queue: JsonObject; message: string | null }> {
  if (item.get('kind') !== 'local-review') throw new Error('not a local-review item');
  const run = object(item.get('run'));
  const runId = string(required(run, 'run_id'));
  const state = await effects.liveness(runId, run);
  if (state !== 'harvest') {
    if (state === 'ambiguous' && !dry)
      await effects.event(
        'review_ambiguous',
        new JsonObject([
          ['item', required(item, 'id')],
          ['run', runId],
        ]),
      );
    const reason =
      state === 'alive'
        ? 'detached review still alive'
        : 'run not releasable (unverifiable identity, missing exit, or incomplete legacy ownership) — capacity retained, owner disposition required';
    return {
      queue: replaceItem(queue, item, withObjectKeys(item, [['wait_reason', reason]])),
      message: null,
    };
  }
  const exit = await effects.readExit(runId);
  const exitValue = required(exit, 'exit');
  if (dry) return { queue, message: `would harvest ${runId}` };
  const exitCode = exitValue === null ? null : seconds(exitValue);
  if (
    exitValue !== null &&
    (!(exitValue instanceof JsonNumber) ||
      exitValue.kind !== 'int' ||
      exitCode === null ||
      !Number.isSafeInteger(exitCode))
  )
    throw new Error('unsupported exit code');
  await effects.writeNext(effects.nowIso());
  const meta = await effects.readMeta(runId);
  const stream = await effects.readStream(runId);
  const cls = effects.classify(stream, exitCode);
  await effects.writeClassification(runId, cls);
  await effects.writeFindings(runId, renderLocalReviewFindings(stream, meta, cls));
  await effects.event(
    'review_finished',
    new JsonObject([
      ['item', required(item, 'id')],
      ['run', runId],
      ['outcome', required(cls, 'outcome')],
      ['findings', required(cls, 'findings')],
      ['severity', required(cls, 'severity_counts')],
    ]),
  );
  const outcome = string(required(cls, 'outcome'));
  let next = queue;
  if (outcome === 'rate_limited')
    next = cooldown(next, cls, exit, effects.nowIso(), defaultBackoffMinutes);
  if (outcome === 'auth' || outcome === 'action_required')
    next = withObjectKeys(next, [
      ['paused', true],
      ['pause_reason', `${outcome} on ${runId}; owner action needed`],
    ]);
  const endedAt = string(required(exit, 'ended_at'));
  next = await effects.complete(next, item, runId, cls, endedAt, exitCode);
  try {
    await effects.cleanup(item, meta);
  } catch (error) {
    if (!cleanupFailure(error)) throw error;
    await effects.event(
      'local_review_cleanup_failed',
      new JsonObject([
        ['item', required(item, 'id')],
        [
          'reason',
          [...(error instanceof Error ? error.message : String(error))].slice(0, 300).join(''),
        ],
      ]),
    );
  }
  const items = next.get('items');
  if (!Array.isArray(items)) throw new Error('missing queue items');
  const id = item.get('id');
  const finished = items.find((value) => value instanceof JsonObject && value.get('id') === id);
  if (!(finished instanceof JsonObject)) throw new Error('completed item missing');
  return {
    queue: next,
    message: `${string(id)}: ${string(finished.get('state'))}; receipt ${string(finished.get('receipt_id'))}`,
  };
}
