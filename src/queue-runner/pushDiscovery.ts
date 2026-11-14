/** Inactive first-parent push discovery. Caller owns the existing tick.lock. */
import { JsonNumber, JsonObject, type JsonValue } from '../policy/crq/jsonValue.js';
import { isJsonInt, jsonIntValue, withObjectKeys } from '../policy/crq/queueDoc.js';
import { QUEUE_RECEIPT_POLICY } from '../policy/crq/queueReceipt.js';

export interface PushDiscoveryRepo {
  readonly repo: string;
  readonly name: string;
  readonly floor: string | null;
  readonly quietMinutes: number;
  readonly enabled: boolean;
}
export interface PushDiscoveryEffects {
  /** Fetches the configured default branch using a forced tracking refspec. */
  fetchTip(repo: PushDiscoveryRepo): Promise<string>;
  floorBase(repo: PushDiscoveryRepo): Promise<string | null>;
  isAncestor(repo: PushDiscoveryRepo, base: string, tip: string): Promise<boolean>;
  commitTime(repo: PushDiscoveryRepo, tip: string): Promise<number>;
  nowSeconds(): number;
  nowIso(): string;
  event(kind: 'enrolled' | 'push_divergence', fields: JsonObject): Promise<void>;
}
const empty = () => new JsonObject([]);
function object(value: JsonValue | undefined): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error('invalid push discovery record');
  return value;
}
function itemsOf(queue: JsonObject): JsonObject[] {
  const items = queue.get('items');
  if (!Array.isArray(items) || items.some((item) => !(item instanceof JsonObject)))
    throw new Error('invalid queue items');
  return items as JsonObject[];
}
function truthy(value: JsonValue | undefined): boolean {
  if (value instanceof JsonNumber)
    return value.kind === 'int' ? value.integer !== 0n : value.float !== 0;
  return (
    value !== undefined &&
    value !== null &&
    value !== false &&
    value !== '' &&
    !(Array.isArray(value) && value.length === 0) &&
    !(value instanceof JsonObject && value.entries.length === 0)
  );
}
function recordOf(queue: JsonObject, repo: string): JsonObject {
  const state = queue.get('push_discovery');
  if (state === undefined) return empty();
  const rec = object(state).get(repo);
  return rec === undefined ? empty() : object(rec);
}
function replaceRecord(queue: JsonObject, repo: string, record: JsonObject): JsonObject {
  const state = queue.get('push_discovery');
  return withObjectKeys(queue, [
    [
      'push_discovery',
      withObjectKeys(state === undefined ? empty() : object(state), [[repo, record]]),
    ],
  ]);
}
function nextOrder(items: JsonObject[]): JsonNumber {
  let max: bigint | undefined;
  for (const item of items) {
    if (item.get('kind') === 'promotion') continue;
    const order = item.get('order');
    if (order !== undefined && !isJsonInt(order)) throw new Error('invalid item order');
    const n = order === undefined ? 0n : jsonIntValue(order);
    if (max === undefined || n > max) max = n;
  }
  return JsonNumber.int((max ?? 0n) + 1n);
}
function sha(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('invalid commit identity');
  return value;
}

/** No dispatch or receipt creation. A broken repo does not block the others. */
export async function discoverPush(
  original: JsonObject,
  repos: readonly PushDiscoveryRepo[],
  dry: boolean,
  primaryRepo: string,
  effects: PushDiscoveryEffects,
): Promise<{ queue: JsonObject; log: string[] }> {
  let queue = original;
  const log: string[] = [];
  for (const cfg of repos) {
    if (!cfg.enabled) continue;
    try {
      const tip = sha(await effects.fetchTip(cfg));
      const record = recordOf(queue, cfg.repo);
      const reviewed = record.get('reviewed_tip');
      if (!truthy(reviewed)) {
        const floor = cfg.floor ? await effects.floorBase(cfg) : null;
        const base = floor ? sha(floor) : tip;
        if (!dry)
          queue = replaceRecord(queue, cfg.repo, withObjectKeys(record, [['reviewed_tip', base]]));
        log.push(
          `${dry ? 'DRY-RUN would initialize' : 'push discovery initialized'} ${cfg.repo} reviewed tip ${base.slice(0, 10)}`,
        );
        continue;
      }
      if (typeof reviewed !== 'string') throw new Error('invalid reviewed tip');
      sha(reviewed);
      if (reviewed === tip) continue;
      if (!(await effects.isAncestor(cfg, reviewed, tip))) {
        if (!dry) {
          queue = replaceRecord(queue, cfg.repo, withObjectKeys(record, [['reviewed_tip', tip]]));
          await effects.event(
            'push_divergence',
            new JsonObject([
              ['repo', cfg.repo],
              ['reviewed_tip', reviewed],
              ['tip', tip],
            ]),
          );
        }
        log.push(`push discovery ${cfg.repo}: history rewritten`);
        continue;
      }
      const items = itemsOf(queue);
      const mine = items.filter(
        (item) =>
          item.get('kind') === 'push-current' && (item.get('repo') || primaryRepo) === cfg.repo,
      );
      const live = mine.filter((item) =>
        ['pending', 'reviewing', 'repairing', 'blocked'].includes(String(item.get('state'))),
      );
      if (
        live.some(
          (item) =>
            truthy(item.get('capture')) ||
            item.get('state') === 'reviewing' ||
            item.get('state') === 'repairing',
        )
      ) {
        log.push(`push discovery ${cfg.repo}: captured push item pins the lane`);
        continue;
      }
      const stamp = await effects.commitTime(cfg, tip);
      if (
        !Number.isFinite(stamp) ||
        !Number.isFinite(effects.nowSeconds()) ||
        !Number.isFinite(cfg.quietMinutes)
      )
        throw new Error('invalid quiet window');
      if ((effects.nowSeconds() - stamp) / 60 < cfg.quietMinutes) continue;
      const id = `push-${cfg.name}-${reviewed.slice(0, 10)}-${tip.slice(0, 10)}`;
      if (
        mine.some(
          (item) =>
            item.get('id') === id &&
            item.get('state') === 'pending' &&
            !truthy(item.get('capture')),
        )
      )
        continue;
      if (dry) {
        log.push(`DRY-RUN would enroll ${id}`);
        continue;
      }
      const now = effects.nowIso();
      const nextItems = items.map((item) => {
        const subject = item.get('subject');
        if (
          !mine.includes(item) ||
          item.get('state') !== 'pending' ||
          truthy(item.get('capture')) ||
          !(subject instanceof JsonObject) ||
          truthy(subject.get('paths_filter')) ||
          truthy(item.get('depends_on'))
        )
          return item;
        const notes = item.get('notes');
        if (notes !== undefined && !Array.isArray(notes)) throw new Error('invalid item notes');
        return withObjectKeys(item, [
          ['state', 'skipped'],
          ['notes', [...(notes ?? []), `${now} coalesced into ${id}`]],
        ]);
      });
      // IDs remain sticky, including already-terminal items.
      const duplicate = items.some(
        (item) => item.get('kind') !== 'promotion' && item.get('id') === id,
      );
      if (duplicate) {
        queue = withObjectKeys(queue, [['items', nextItems]]);
        continue;
      }
      const reason = `${now} auto-enrolled: push range ${reviewed.slice(0, 10)}..${tip.slice(0, 10)}`;
      const item = new JsonObject([
        ['id', id],
        ['repo', cfg.repo],
        ['kind', 'push-current'],
        ['pr', JsonNumber.int(0)],
        [
          'subject',
          new JsonObject([
            ['type', 'push-range'],
            ['repo', cfg.repo],
            ['base', reviewed],
            ['head', tip],
            ['policy', QUEUE_RECEIPT_POLICY],
          ]),
        ],
        ['state', 'pending'],
        ['created_at', now],
        ['order', nextOrder(items)],
        ['cycles', []],
        ['attempts', []],
        ['failures', JsonNumber.int(0)],
        ['notes', [reason]],
      ]);
      queue = withObjectKeys(queue, [['items', [...nextItems, item]]]);
      await effects.event(
        'enrolled',
        new JsonObject([
          ['item', id],
          ['reason', reason],
        ]),
      );
      log.push(`push discovery ${cfg.repo}: enrolled ${id}`);
    } catch {
      log.push(`push discovery skipped ${cfg.repo}`);
    }
  }
  return { queue, log };
}

/** Persist even an empty non-dry pass before harvest/admission, as Python does. */
export async function runPushDiscovery(
  repos: readonly PushDiscoveryRepo[],
  dry: boolean,
  primaryRepo: string,
  effects: PushDiscoveryEffects & {
    loadQueue(): Promise<JsonObject>;
    saveQueue(queue: JsonObject): Promise<void>;
  },
): Promise<{ queue: JsonObject; log: string[] }> {
  const result = await discoverPush(await effects.loadQueue(), repos, dry, primaryRepo, effects);
  if (!dry) await effects.saveQueue(result.queue);
  return result;
}
