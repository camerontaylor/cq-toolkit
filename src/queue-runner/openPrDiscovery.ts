/** Inactive open-PR enrollment after harvest/repair, before admission. */
import { JsonNumber, JsonObject, type JsonValue } from '../policy/crq/jsonValue.js';
import { isJsonInt, jsonIntValue, withObjectKeys } from '../policy/crq/queueDoc.js';
import { compareCodePoints } from '../policy/crq/pythonJson.js';
import { sameRepo } from '../policy/crq/tickSchedule.js';

export interface OpenPr {
  readonly number: number;
  readonly draft: boolean;
  readonly base: string;
  readonly headRef: string;
  readonly head: string;
}
export interface PrDiscoveryRepo {
  readonly repo: string;
  readonly name: string;
  readonly primary: boolean;
  readonly enabled: boolean;
  readonly defaultBranch: string;
  readonly branches: readonly string[];
}
export interface PrDiscoveryEffects {
  list(repo: PrDiscoveryRepo): Promise<readonly OpenPr[]>;
  /** Foreign clones must fetch their default branch before any range read. */
  fetchDefault(repo: PrDiscoveryRepo): Promise<void>;
  rangeBase(repo: PrDiscoveryRepo, pr: OpenPr): Promise<string | null>;
  /** Includes any immutable link/staleness updates, even when no association exists. */
  associate(
    queue: JsonObject,
    repo: PrDiscoveryRepo,
    pr: OpenPr,
    base: string,
    dry: boolean,
  ): Promise<{ queue: JsonObject; associated: boolean }>;
  /** Primary repair proof only. Failure must not suppress an owed review. */
  ownRange(queue: JsonObject, previousHead: string, head: string): Promise<boolean>;
  event(id: string, reason: string): Promise<void>;
  nowIso(): string;
}
function itemsOf(queue: JsonObject): JsonObject[] {
  const items = queue.get('items');
  if (!Array.isArray(items) || items.some((v) => !(v instanceof JsonObject)))
    throw new Error('invalid queue items');
  return items as JsonObject[];
}
function list(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}
function nextOrder(items: readonly JsonObject[]): JsonNumber {
  let max: bigint | undefined;
  for (const item of items) {
    if (item.get('kind') === 'promotion') continue;
    const value = item.get('order');
    if (value !== undefined && !isJsonInt(value)) throw new Error('invalid item order');
    const n = value === undefined ? 0n : jsonIntValue(value);
    if (max === undefined || n > max) max = n;
  }
  return JsonNumber.int((max ?? 0n) + 1n);
}
function valid(pr: OpenPr): boolean {
  return Number.isSafeInteger(pr.number) && pr.number > 0 && /^[0-9a-f]{40}$/.test(pr.head);
}
function chain(pr: OpenPr, opened: readonly OpenPr[], branches: readonly string[]): boolean {
  const byHead = new Map(opened.map((p) => [p.headRef, p]));
  let current: OpenPr | undefined = pr;
  for (let i = 0; i < 8 && current; i++) {
    if (branches.includes(current.base)) return true;
    current = byHead.get(current.base);
  }
  return false;
}
function numberEquals(value: JsonValue | undefined, n: number): boolean {
  return isJsonInt(value) && jsonIntValue(value) === BigInt(n);
}
function optional(item: JsonObject): boolean {
  return item.get('kind') === 'open' && list(item.get('cycles')).length > 0;
}
function equivalent(cycle: JsonValue, base: string, head: string): boolean {
  if (!(cycle instanceof JsonObject)) return false;
  const run = cycle.get('run_id');
  return (
    cycle.get('base') === base &&
    cycle.get('head') === head &&
    cycle.get('range_policy') === 'full-range-once-v1' &&
    typeof run === 'string' &&
    run.length > 0
  );
}
function newestHead(cycles: readonly JsonValue[]): string | null {
  const records = cycles.filter(
    (c): c is JsonObject => c instanceof JsonObject && typeof c.get('completed_at') === 'string',
  );
  records.sort((a, b) =>
    compareCodePoints(String(b.get('completed_at')), String(a.get('completed_at'))),
  );
  const last = records[0];
  if (!last) return null;
  const head = last.get('pr_head') || last.get('head');
  return typeof head === 'string' ? head : null;
}
/** Returns replacement queue, including association updates; never dispatches. */
export async function discoverOpenPrs(
  original: JsonObject,
  repos: readonly PrDiscoveryRepo[],
  dry: boolean,
  primaryRepo: string,
  effects: PrDiscoveryEffects,
): Promise<{ queue: JsonObject; log: string[] }> {
  let queue = original;
  const log: string[] = [];
  for (const repo of repos) {
    if (!repo.enabled) continue;
    let opened: readonly OpenPr[];
    try {
      opened = await effects.list(repo);
    } catch {
      log.push(`pr discovery skipped ${repo.repo}: forge listing unavailable`);
      continue;
    }
    if (!repo.primary) {
      try {
        await effects.fetchDefault(repo);
      } catch {
        log.push(`pr discovery ${repo.repo}: default branch fetch failed`);
        continue;
      }
    }
    for (const pr of [...opened].sort((a, b) => a.number - b.number)) {
      if (!valid(pr) || pr.draft) continue;
      if (repo.primary && !chain(pr, opened, repo.branches)) continue;
      if (!repo.primary && pr.base !== repo.defaultBranch) {
        log.push(
          `pr discovery ${repo.repo}: PR #${pr.number} targets ${pr.base.slice(0, 100)}, not ${repo.defaultBranch.slice(0, 100)}; skipped`,
        );
        continue;
      }
      let pin: string | null = null;
      try {
        pin = await effects.rangeBase(repo, pr);
      } catch {
        /* primary first enrollment may fall back */
      }
      if (pin !== null && !/^[0-9a-f]{40}$/.test(pin)) pin = null;
      if (!repo.primary && pin === null) {
        log.push(`pr discovery ${repo.repo}: PR #${pr.number} range unavailable`);
        continue;
      }
      if (pin !== null) {
        const linked = await effects.associate(queue, repo, pr, pin, dry);
        queue = linked.queue;
        if (linked.associated) continue;
      }
      const items = itemsOf(queue);
      const mine = items.filter(
        (item) =>
          item.get('kind') !== 'promotion' &&
          numberEquals(item.get('pr'), pr.number) &&
          (item.get('kind') === 'open' || item.get('kind') === 'delta') &&
          (repo.primary
            ? sameRepo(item.get('repo') || primaryRepo, repo.repo)
            : (item.get('repo') || primaryRepo) === repo.repo),
      );
      let id: string;
      let kind: 'open' | 'delta';
      let why: string;
      if (!mine.length) {
        id = `${repo.primary ? '' : `${repo.name}-`}pr${pr.number}`;
        kind = 'open';
        why = `open PR not yet enrolled${repo.primary && !repo.branches.includes(pr.base) ? `, stacked on ${pr.base}` : ''}`;
      } else {
        if (
          mine.some(
            (item) =>
              ['pending', 'reviewing', 'repairing', 'blocked'].includes(
                String(item.get('state')),
              ) && !optional(item),
          )
        )
          continue;
        if (pin === null) {
          log.push(`PR #${pr.number}: range identity unavailable; enrollment deferred`);
          continue;
        }
        const evidence = mine.flatMap((item) => list(item.get('cycles')));
        if (repo.primary) {
          const previous = newestHead(evidence);
          if (previous && previous !== pr.head) {
            try {
              if (await effects.ownRange(queue, previous, pr.head)) continue;
            } catch {
              /* without proof review remains owed */
            }
          }
        }
        if (evidence.some((cycle) => equivalent(cycle, pin!, pr.head))) continue;
        id = `${repo.primary ? '' : `${repo.name}-`}pr${pr.number}-range-${pin.slice(0, 10)}-${pr.head.slice(0, 10)}`;
        kind = 'delta';
        why =
          'current full range lacks equivalent captured evidence; retain earlier cycles/findings';
      }
      if (items.some((item) => item.get('kind') !== 'promotion' && item.get('id') === id)) continue;
      const reason = `${effects.nowIso()} auto-enrolled: ${why}`;
      const fields: [string, JsonValue][] = [
        ['order', nextOrder(items)],
        ['state', 'pending'],
        ['cycles', []],
        ['attempts', []],
        ['id', id],
      ];
      if (!repo.primary) fields.push(['repo', repo.repo]);
      fields.push(['pr', JsonNumber.int(pr.number)], ['kind', kind]);
      if (kind === 'open')
        fields.push(['tier', JsonNumber.int(1)], ['prior_cycles', JsonNumber.int(0)]);
      else fields.push(['followup', 'open']);
      fields.push(['notes', [reason]]);
      queue = withObjectKeys(queue, [['items', [...items, new JsonObject(fields)]]]);
      if (!dry) await effects.event(id, reason);
      log.push(`${dry ? 'DRY-RUN would enroll' : 'enrolled'} ${id}`);
    }
  }
  return { queue, log };
}
