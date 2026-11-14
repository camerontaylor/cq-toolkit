/** Inactive ordinary PR review preparation. Caller holds tick.lock throughout. */
import { JsonObject, type JsonValue } from '../policy/crq/jsonValue.js';
import { pyTruthy } from '../policy/crq/queueDoc.js';
import { reserveAndSpawnReview, type ReviewLaunchEffects } from './reviewLaunch.js';

export interface ReviewPreparationEffects {
  /** Exclusively create the run directory, refusing collisions. */
  allocate(itemId: string): Promise<string>;
  /** Mandatory real scan boundary. Only literal true permits checkout. */
  scan(input: { runId: string; repo: string; base: string; head: string }): Promise<boolean>;
  /** Must never replace an existing path or branch. */
  checkout(input: {
    runId: string;
    repo: string;
    head: string;
  }): Promise<{ path: string; branch: string }>;
  nowIso(): string;
  launch: ReviewLaunchEffects;
}
function required(value: JsonValue | undefined, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid ${name}`);
  return value;
}
/**
 * Scan is deliberately injected and unbound: the repair-only scanner is not
 * review scan parity. Failed scans/refusals leave artifacts and no reservation.
 * The caller must reconcile orphaned directories/worktrees and never blindly retry.
 */
export async function prepareOrdinaryReview(
  queue: JsonObject,
  input: { itemIndex: number; plan: JsonObject; repo: string; band: 'interactive' | 'background' },
  effects: ReviewPreparationEffects,
): Promise<{ queue: JsonObject; runId: string }> {
  const items = queue.get('items');
  if (!Array.isArray(items) || !Number.isSafeInteger(input.itemIndex) || input.itemIndex < 0)
    throw new Error('invalid item');
  const item = items[input.itemIndex];
  if (!(item instanceof JsonObject)) throw new Error('invalid item');
  const kind = item.get('kind');
  if (kind !== 'open' && kind !== 'delta') throw new Error('unsupported preparation kind');
  const id = required(item.get('id'), 'item id');
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id)) throw new Error('invalid item id');
  if (
    item.get('state') !== 'pending' ||
    (item.get('run') !== undefined && item.get('run') !== null)
  )
    throw new Error('item is not launchable');
  const repo = required(input.repo, 'repository');
  const itemRepo = item.get('repo');
  if (
    itemRepo !== undefined &&
    itemRepo !== null &&
    (typeof itemRepo !== 'string' || itemRepo.toLowerCase() !== repo.toLowerCase())
  )
    throw new Error('repository mismatch');
  if (input.band !== 'interactive' && input.band !== 'background') throw new Error('invalid band');
  const base = required(input.plan.get('base'), 'base');
  const head = required(input.plan.get('head'), 'head');
  if (![base, head].every((oid) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)))
    throw new Error('invalid review commit identity');
  const label = required(input.plan.get('label'), 'label');
  const target = required(input.plan.get('target'), 'target');
  const pr = item.get('pr');
  if (
    pr === undefined ||
    input.plan.get('cycle') === undefined ||
    input.plan.get('branch') === undefined
  )
    throw new Error('incomplete review plan');
  const profile = input.plan.get('profile');
  let cmd: JsonValue[] = ['coderabbit', 'review', '--agent', '--deep'];
  if (pyTruthy(input.plan.get('range_policy'))) cmd.push('--committed');
  cmd.push('--base-commit', base);
  if (pyTruthy(profile)) {
    if (
      !(profile instanceof JsonObject) ||
      !Array.isArray(profile.get('flags')) ||
      !(profile.get('flags') as JsonValue[]).every((flag) => typeof flag === 'string') ||
      input.plan.get('config_digest') === undefined
    )
      throw new Error('invalid review profile');
    cmd = ['coderabbit', 'review', ...(profile.get('flags') as JsonValue[])];
  }
  const runId = await effects.allocate(id);
  if (!runId.startsWith(`${id}-`) || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(runId))
    throw new Error('invalid allocated run identity');
  if ((await effects.scan({ runId, repo, base, head })) !== true)
    throw new Error('review secret scan refused');
  const worktree = await effects.checkout({ runId, repo, head });
  const startedAt = effects.nowIso();
  const meta = new JsonObject([
    ['run_id', runId],
    ['item_id', id],
    ['pr', pr],
    ['kind', kind],
    ['repo', repo],
    ['workId', `crq:${runId}`],
    ['label', label],
    ['cycle', input.plan.get('cycle')!],
    ['base', base],
    ['head', head],
    ['pr_head', input.plan.get('pr_head') === undefined ? head : input.plan.get('pr_head')!],
    [
      'review_pin',
      input.plan.get('review_pin') === undefined ? base : input.plan.get('review_pin')!,
    ],
    ['target', target],
    ['pr_branch', input.plan.get('branch')!],
    ['worktree', worktree.path],
    ['wt_branch', worktree.branch],
    ['dirty_diff', 'clean tree'],
    ['range_policy', input.plan.get('range_policy') ?? null],
    ['band', input.band],
    ['started_at', startedAt],
    ['cmd', cmd],
    ...(profile instanceof JsonObject && pyTruthy(profile)
      ? ([
          ['profile', profile],
          ['config_digest', input.plan.get('config_digest')!],
        ] as const)
      : []),
  ]);
  return reserveAndSpawnReview(
    queue,
    { itemIndex: input.itemIndex, runId, startedAt, band: input.band, meta },
    effects.launch,
  );
}
