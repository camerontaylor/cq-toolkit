/** Inactive detached-review reservation transaction. Caller owns tick.lock. */
import { JsonNumber, JsonObject, type JsonValue } from '../policy/crq/jsonValue.js';
import { withObjectKeys } from '../policy/crq/queueDoc.js';
import {
  identityKind,
  runState,
  type RunLiveness,
  type RunLivenessProbes,
} from '../policy/crq/runLiveness.js';

/** Only an explicitly identified OS spawn failure is terminal for author/local-review. */
export class ReviewSpawnError extends Error {}
export interface ReviewLaunchInput {
  readonly itemIndex: number;
  readonly runId: string;
  readonly startedAt: string;
  readonly band: 'interactive' | 'background';
  /** Fully prepared metadata. Caller owns scan, worktree, author lease and unique run ID. */
  readonly meta: JsonObject;
}
export interface ReviewLaunchEffects {
  writeMeta(runId: string, meta: JsonObject): Promise<void>;
  /** Best effort, just like Python's append_work_record. */
  workStarted(meta: JsonObject): Promise<void>;
  saveQueue(queue: JsonObject): Promise<void>;
  /** A real binding must start the detached child exactly once, or throw ReviewSpawnError on OS failure. */
  spawn(runId: string): Promise<number>;
  event(kind: 'spawn_failed' | 'review_started', data: JsonObject): Promise<void>;
  nowIso(): string;
}
/** Python's `text[:n]` counts code points; a UTF-16 `slice` would cut astral characters short. */
function pythonPrefix(text: string, count: number): string {
  let end = 0;
  let seen = 0;
  while (end < text.length && seen < count) {
    end += (text.codePointAt(end) as number) > 0xffff ? 2 : 1;
    seen += 1;
  }
  return text.slice(0, end);
}
function itemAt(queue: JsonObject, index: number): { items: JsonValue[]; item: JsonObject } {
  const items = queue.get('items');
  if (
    !Array.isArray(items) ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !(items[index] instanceof JsonObject)
  )
    throw new Error('invalid launch item');
  return { items, item: items[index] };
}
function replace(queue: JsonObject, index: number, item: JsonObject): JsonObject {
  const { items } = itemAt(queue, index);
  const next = [...items];
  next[index] = item;
  return withObjectKeys(queue, [['items', next]]);
}
/**
 * scan, worktree creation, metadata construction and author grant are NOT bound here.
 * The caller must finish those checks under the same lock before calling. No tick,
 * slot, executable child wrapper, PID probe or live capability is installed.
 * On any post-reservation failure reload durable queue and recover, never retry spawn.
 */
export async function reserveAndSpawnReview(
  queue: JsonObject,
  input: ReviewLaunchInput,
  effects: ReviewLaunchEffects,
): Promise<{ queue: JsonObject; runId: string }> {
  const { item } = itemAt(queue, input.itemIndex);
  const itemId = item.get('id');
  const kind = item.get('kind');
  if (
    typeof itemId !== 'string' ||
    !itemId ||
    typeof kind !== 'string' ||
    item.get('state') !== 'pending' ||
    (item.get('run') !== undefined && item.get('run') !== null)
  )
    throw new Error('item is not launchable');
  if (
    !input.runId ||
    input.runId === '.' ||
    input.runId === '..' ||
    /[/\\\0]/.test(input.runId) ||
    !input.startedAt ||
    input.meta.get('run_id') !== input.runId ||
    input.meta.get('item_id') !== itemId ||
    input.meta.get('kind') !== kind ||
    input.meta.get('started_at') !== input.startedAt ||
    input.meta.get('band') !== input.band ||
    typeof input.meta.get('base') !== 'string' ||
    typeof input.meta.get('head') !== 'string' ||
    typeof input.meta.get('label') !== 'string'
  )
    throw new Error('invalid launch metadata');
  const starts = queue.get('starts');
  if (starts !== undefined && !Array.isArray(starts)) throw new Error('invalid starts');
  await effects.writeMeta(input.runId, input.meta);
  try {
    await effects.workStarted(input.meta);
  } catch {
    /* best effort */
  }
  let run = new JsonObject([
    ['run_id', input.runId],
    ['pid', null],
    ['started_at', input.startedAt],
    ['band', input.band],
    ['launch_pending', true],
  ]);
  let current = withObjectKeys(item, [
    ['state', 'reviewing'],
    ['run', run],
    ['wait_reason', null],
  ]);
  let next = withObjectKeys(replace(queue, input.itemIndex, current), [
    ['starts', [...(starts ?? []), input.startedAt]],
  ]);
  await effects.saveQueue(next);
  let pid: number;
  try {
    pid = await effects.spawn(input.runId);
  } catch (error) {
    if (!(error instanceof ReviewSpawnError) || (kind !== 'author' && kind !== 'local-review'))
      throw error;
    const message = pythonPrefix(error.message, 200);
    run = new JsonObject([
      ['run_id', input.runId],
      ['pid', null],
      ['started_at', input.startedAt],
      ['band', input.band],
      ['launch_pending', false],
      ['spawn_failed_at', effects.nowIso()],
      ['error', message],
    ]);
    current = withObjectKeys(current, [
      ['run', run],
      ['state', kind === 'author' ? 'author_failed' : 'failed'],
      ['last_error', pythonPrefix(`${kind} spawn failed (no retry): ${error.message}`, 300)],
    ]);
    next = replace(next, input.itemIndex, current);
    await effects.event(
      'spawn_failed',
      new JsonObject([
        ['item', itemId],
        ['run', input.runId],
        ['error', message],
      ]),
    );
    await effects.saveQueue(next);
    return { queue: next, runId: input.runId };
  }
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('spawn returned invalid pid; reservation retained');
  run = withObjectKeys(run, [
    ['pid', JsonNumber.int(pid)],
    ['launch_pending', false],
  ]);
  next = replace(next, input.itemIndex, withObjectKeys(current, [['run', run]]));
  await effects.saveQueue(next);
  await effects.event(
    'review_started',
    new JsonObject([
      ['item', itemId],
      ['run', input.runId],
      ['base', input.meta.get('base') ?? null],
      ['head', input.meta.get('head') ?? null],
      ['label', input.meta.get('label') ?? null],
    ]),
  );
  return { queue: next, runId: input.runId };
}

/** No spawn or release: ambiguous or alive ownership always retains the reservation. */
export function recoverReviewOwnership(
  runId: string,
  queuePid: unknown,
  pidfile: unknown,
  probes: Omit<RunLivenessProbes, 'identity'>,
): RunLiveness {
  return runState({ ...probes, identity: identityKind(pidfile, { runId, queuePid }) });
}
