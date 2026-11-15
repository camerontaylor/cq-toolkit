/**
 * `crq.deliver_pending_review_refreshes`: the bounded PASS refresh after author
 * resolution. It never schedules a scan; it asks the receipt layer to refresh a
 * prior ITERATE whole-PR scan once the findings are resolved.
 *
 * The receipt refresh and the clock are injected. Python mutates the queue in
 * place; this returns a new queue. Not wired into a tick.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { compareCodePoints } from '../../../policy/crq/pythonJson.js';
import { pyTruthy, withObjectKeys } from '../../../policy/crq/queueDoc.js';
import {
  PR_REVIEWS_PER_TICK,
  PR_REVIEW_MAX_ATTEMPTS,
  DeliveryRuntimeError,
  DeliveryValueError,
  ThreadsNotVisibleError,
} from './deliverPending.js';

/** Python `KeyError` or `TypeError` from a refresh: unlike `ValueError`, not caught. */
export class DeliveryKeyTypeError extends DeliveryValueError {}

export interface RefreshEffects {
  /** `crq_review_receipt.refresh(pr_review_findings, repo, pr, meta)`. */
  refresh(input: {
    readonly repo: string;
    readonly pr: JsonValue;
    readonly runId: string;
    readonly base: string;
    readonly head: string;
    readonly postingIdentity: JsonValue;
    readonly identityReason: JsonValue;
    /** `_checkpoint_review_identity(q, request, login, reason)`. */
    readonly checkpoint: (login: string, reason: string) => Promise<void>;
  }): Promise<JsonObject>;
  now(): string;
  primaryRepo: string;
  /** Records a changed identity checkpoint against the request, then saves the queue. */
  checkpoint(itemId: JsonValue, login: string, reason: string): Promise<void>;
}

const SETTLED = ['created', 'existing', 'abandoned', 'skipped-head', 'skipped-range', 'body-major'];
const PREFIXES = ['pr_review', 'clean_review'] as const;
type Prefix = (typeof PREFIXES)[number];

const nonEmptyString = (v: JsonValue | undefined): v is string => typeof v === 'string' && v !== '';
const isInt = (v: JsonValue | undefined): boolean => v instanceof JsonNumber && v.kind === 'int';

function sortKey(item: JsonObject, key: string): string {
  const value = item.get(key);
  return pyTruthy(value) && typeof value === 'string' ? value : '';
}

export async function deliverPendingReviewRefreshes(
  queue: JsonObject,
  effects: RefreshEffects,
): Promise<{ readonly queue: JsonObject; readonly log: string[] }> {
  const raw = queue.get('items');
  if (!Array.isArray(raw)) throw new Error('queue items must be an array');
  const items: JsonValue[] = [...raw];
  const candidates: Array<{ index: number; prefix: Prefix; request: JsonObject }> = [];
  items.forEach((entry, index) => {
    if (!(entry instanceof JsonObject)) return;
    const kind = entry.get('kind');
    if (kind !== 'open' && kind !== 'delta') return;
    for (const prefix of PREFIXES) {
      const item = items[index] as JsonObject;
      const result = item.get(prefix);
      const request = item.get(`${prefix}_request`);
      if (!(result instanceof JsonObject) || !(request instanceof JsonObject)) continue;
      if (
        result.get('verdict') !== 'ITERATE' ||
        !pyTruthy(result.get('whole_pr_scan')) ||
        pyTruthy(result.get('body_major'))
      )
        continue;
      if (
        !['run_id', 'base', 'head'].every((k) => nonEmptyString(request.get(k))) ||
        !isInt(request.get('pr'))
      ) {
        items[index] = withObjectKeys(item, [
          [
            `${prefix}_refresh`,
            new JsonObject([
              ['state', 'abandoned'],
              ['error', 'malformed CRQ refresh request'],
            ]),
          ],
        ]);
        continue;
      }
      const previous = item.get(`${prefix}_refresh`) ?? new JsonObject([]);
      if (!(previous instanceof JsonObject)) throw new Error(`${prefix}_refresh must be an object`);
      const state = previous.get('state');
      if (
        previous.get('head') === request.get('head') &&
        previous.get('scan_run') === request.get('run_id') &&
        typeof state === 'string' &&
        SETTLED.includes(state)
      )
        continue;
      candidates.push({ index, prefix, request });
    }
  });
  candidates.sort((a, b) =>
    compareCodePoints(
      sortKey(items[a.index] as JsonObject, `${a.prefix}_refresh_attempt_at`),
      sortKey(items[b.index] as JsonObject, `${b.prefix}_refresh_attempt_at`),
    ),
  );
  const log: string[] = [];
  for (const { index, prefix, request } of candidates.slice(0, PR_REVIEWS_PER_TICK)) {
    let item = withObjectKeys(items[index] as JsonObject, [
      [`${prefix}_refresh_attempt_at`, effects.now()],
    ]);
    items[index] = item;
    const priorValue = item.get(`${prefix}_refresh`) ?? new JsonObject([]);
    const prior = priorValue as JsonObject;
    const runId = request.get('run_id') as string;
    const base = request.get('base') as string;
    const head = request.get('head') as string;
    let attempts = 0n;
    if (prior.get('head') === head && prior.get('scan_run') === runId) {
      const stored = prior.get('attempts');
      if (stored === undefined) attempts = 0n;
      else if (stored instanceof JsonNumber && stored.kind === 'int')
        attempts = stored.integer as bigint;
      else throw new Error('refresh attempts must be an integer');
    }
    const itemId = item.get('id') ?? null;
    const repoValue = item.get('repo');
    let result: JsonObject;
    try {
      result = await effects.refresh({
        repo:
          pyTruthy(repoValue) && typeof repoValue === 'string' ? repoValue : effects.primaryRepo,
        pr: request.get('pr') as JsonValue,
        runId,
        base,
        head,
        postingIdentity: request.get('posting_identity') ?? null,
        identityReason: request.get('identity_reason') ?? null,
        checkpoint: (login, reason) => effects.checkpoint(itemId, login, reason),
      });
    } catch (error) {
      if (error instanceof ThreadsNotVisibleError)
        result = new JsonObject([
          ['state', 'waiting-threads'],
          ['error', error.message],
        ]);
      else if (
        !(error instanceof DeliveryKeyTypeError) &&
        (error instanceof DeliveryRuntimeError || error instanceof DeliveryValueError)
      ) {
        attempts += 1n;
        result = new JsonObject([
          ['state', attempts >= BigInt(PR_REVIEW_MAX_ATTEMPTS) ? 'abandoned' : 'retry'],
          ['error', error.message.slice(0, 300)],
        ]);
      } else throw error;
    }
    const state = result.get('state');
    if (state === undefined) throw new Error("'state'");
    item = withObjectKeys(item, [
      [
        `${prefix}_refresh`,
        withObjectKeys(result, [
          ['head', head],
          ['scan_run', runId],
          ['attempts', JsonNumber.int(attempts)],
        ]),
      ],
    ]);
    items[index] = item;
    if (state === 'created')
      log.push(`PASS refresh on PR #${(request.get('pr') as JsonNumber).raw} (created)`);
  }
  return { queue: withObjectKeys(queue, [['items', items]]), log };
}
