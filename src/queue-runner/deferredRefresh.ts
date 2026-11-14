/** Inactive deferred-author recovery under the caller's existing tick.lock. */
import { JsonNumber, JsonObject, type JsonValue } from '../policy/crq/jsonValue.js';
import { isJsonInt, jsonIntValue, withObjectKeys } from '../policy/crq/queueDoc.js';
import { compareCodePoints } from '../policy/crq/pythonJson.js';
import {
  enrollMergedCurrent,
  QueueRefused,
  type QueueSelector,
} from '../policy/crq/queueReceipt.js';
import { RefreshExhausted } from '../policy/crq/forgeBudget.js';

/** Identity/ambiguity versus retryable transport failure are separate debts. */
export class DeferredIdentityError extends Error {}
export class DeferredUnavailableError extends Error {}

export interface DeferredRefreshEffects {
  verify(repo: string, pr: number): Promise<JsonObject>;
  find(
    repo: string,
    producer: string,
    head: string,
    target: string,
    limit: 2,
  ): Promise<readonly JsonObject[]>;
  mayContinue(): boolean;
}

function omit(object: JsonObject, ...keys: string[]): JsonObject {
  return new JsonObject(object.entries.filter(([key]) => !keys.includes(key)));
}
function requiredString(object: JsonObject, key: string): string {
  const value = object.get(key);
  if (typeof value !== 'string' || !value) throw new DeferredIdentityError('invalid binding');
  return value;
}
function verified(
  actual: JsonObject,
  binding: JsonObject,
  requested?: number,
): { pr: number; state: string; merge: string | null } {
  for (const key of ['repo', 'producer', 'head', 'target']) {
    if (actual.get(key) !== binding.get(key))
      throw new DeferredIdentityError('forge identity mismatch');
  }
  const raw = actual.get('pr');
  if (!isJsonInt(raw)) throw new DeferredIdentityError('forge PR mismatch');
  const integer = jsonIntValue(raw);
  if (integer <= 0n || integer > BigInt(Number.MAX_SAFE_INTEGER))
    throw new DeferredIdentityError('forge PR mismatch');
  const pr = Number(integer);
  const state = actual.get('state');
  if (
    (requested !== undefined && pr !== requested) ||
    (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED')
  )
    throw new DeferredIdentityError('forge PR mismatch');
  const merge = actual.get('mergeSha');
  if (state === 'MERGED' && (typeof merge !== 'string' || !/^[0-9a-f]{40}$/.test(merge)))
    throw new DeferredIdentityError('forge merge identity missing');
  return { pr, state, merge: typeof merge === 'string' ? merge : null };
}

/** Pure queue transitions with injected, bounded forge reads. Returns an independent queue. */
export async function refreshDeferred(
  original: JsonObject,
  at: string,
  effects: DeferredRefreshEffects,
  limit = 20,
): Promise<{ queue: JsonObject; refreshed: string[] }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new RangeError('refresh limit must be between 1 and 50');
  let queue = original;
  const entriesValue = queue.get('queue_client_requests');
  if (!(entriesValue instanceof JsonObject)) return { queue, refreshed: [] };
  const ids = entriesValue.entries
    .filter(([, entry]) => {
      if (!(entry instanceof JsonObject)) return false;
      const b = entry.get('binding');
      return (
        b instanceof JsonObject &&
        b.get('kind') === 'deferred-author' &&
        (entry.get('state') === 'awaiting-pr' || entry.get('state') === 'awaiting-merge')
      );
    })
    .map(([id]) => id)
    .sort(compareCodePoints);
  const cursor = queue.get('deferred_refresh_cursor');
  const pivot = typeof cursor === 'string' ? cursor : '';
  const ordered = [
    ...ids.filter((id) => compareCodePoints(id, pivot) > 0),
    ...ids.filter((id) => compareCodePoints(id, pivot) <= 0),
  ];
  const refreshed: string[] = [];
  for (const id of ordered.slice(0, limit)) {
    if (!effects.mayContinue()) break;
    const currentEntries = queue.get('queue_client_requests');
    if (!(currentEntries instanceof JsonObject))
      throw new Error('queue requests changed unexpectedly');
    let entry = currentEntries.get(id);
    if (!(entry instanceof JsonObject)) throw new Error('queue entry changed unexpectedly');
    const binding = entry.get('binding');
    if (!(binding instanceof JsonObject)) throw new Error('invalid deferred binding');
    try {
      const repo = requiredString(binding, 'repo');
      const producer = requiredString(binding, 'producer');
      const head = requiredString(binding, 'head');
      const target = requiredString(binding, 'target');
      const rawPr = entry.get('pr');
      let actual: JsonObject | undefined;
      let requested: number | undefined;
      if (rawPr === undefined || rawPr === null) {
        const matches: unknown = await effects.find(repo, producer, head, target, 2);
        if (
          !Array.isArray(matches) ||
          matches.length > 1 ||
          (matches.length === 1 && !(matches[0] instanceof JsonObject))
        )
          throw new DeferredIdentityError('ambiguous publication');
        actual = matches[0] instanceof JsonObject ? matches[0] : undefined;
        if (actual === undefined) {
          entry = omit(entry, 'refreshError');
        }
      } else {
        if (
          !isJsonInt(rawPr) ||
          jsonIntValue(rawPr) <= 0n ||
          jsonIntValue(rawPr) > BigInt(Number.MAX_SAFE_INTEGER)
        )
          throw new DeferredIdentityError('invalid PR');
        requested = Number(jsonIntValue(rawPr));
        actual = await effects.verify(repo, requested);
      }
      if (actual !== undefined) {
        const observed = verified(actual, binding, requested);
        entry = withObjectKeys(entry, [['pr', JsonNumber.int(observed.pr)]]);
        const changes: [string, JsonValue][] = [];
        if (observed.state === 'CLOSED')
          changes.push(
            ['state', 'cancelled'],
            ['cancellationReason', 'forge PR closed without merge'],
          );
        else if (observed.state === 'OPEN') changes.push(['state', 'awaiting-merge']);
        else {
          const selector = requiredString(binding, 'targetSelector') as QueueSelector;
          const items = queue.get('items');
          if (!Array.isArray(items) || observed.merge === null)
            throw new DeferredIdentityError('invalid enrollment');
          // enrollMergedCurrent appends in place: stage an independent array before calling it.
          const staged = withObjectKeys(queue, [['items', [...items]]]);
          queue = enrollMergedCurrent(staged, {
            repo,
            pr: observed.pr,
            mergeSha: observed.merge,
            requestId: id,
            at,
            targetSelector: selector,
          }).queue;
          changes.push(['state', 'ready-current'], ['mergeSha', observed.merge]);
        }
        entry = withObjectKeys(omit(entry, 'refreshError', 'reason'), changes);
      }
    } catch (error) {
      if (error instanceof RefreshExhausted) break;
      if (error instanceof DeferredIdentityError || error instanceof QueueRefused) {
        entry = withObjectKeys(entry, [
          [
            'reason',
            new JsonObject([
              ['source', 'queue'],
              ['category', 'identity'],
              ['code', 'forge-identity'],
            ]),
          ],
        ]);
      } else if (error instanceof DeferredUnavailableError) {
        entry = withObjectKeys(entry, [
          ['refreshError', 'forge refresh unavailable; debt retained'],
        ]);
      } else throw error;
    }
    entry = withObjectKeys(entry, [['refreshedAt', at]]);
    const latest = queue.get('queue_client_requests');
    if (!(latest instanceof JsonObject)) throw new Error('queue requests changed unexpectedly');
    queue = withObjectKeys(queue, [
      ['queue_client_requests', withObjectKeys(latest, [[id, entry]])],
      ['deferred_refresh_cursor', id],
    ]);
    refreshed.push(id);
  }
  return { queue, refreshed };
}

/** Save all progress before discovery or dispatch; never persist an empty pass. */
export async function runDeferredRefresh(
  at: string,
  effects: DeferredRefreshEffects & {
    loadQueue(): Promise<JsonObject>;
    saveQueue(queue: JsonObject): Promise<void>;
  },
): Promise<{ queue: JsonObject; refreshed: string[] }> {
  const result = await refreshDeferred(await effects.loadQueue(), at, effects);
  if (result.refreshed.length > 0) await effects.saveQueue(result.queue);
  return result;
}
