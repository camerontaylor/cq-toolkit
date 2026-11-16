/**
 * Bounded post-harvest delivery passes of the tick (`crq.deliver_pending_*`).
 *
 * Port of `deliver_pending_clean_reviews`. The review delivery itself
 * (`pr_review_findings.deliver`, with its receipt and identity checkpoint) and the
 * clock are injected, so the pass is pure queue bookkeeping: it picks the
 * least-recently-attempted debts, counts attempts, and settles or retries them
 * exactly as Python does. Python mutates the queue in place; this returns a new
 * queue. Not wired into a tick.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { ledgerPythonTypeName } from '../../../policy/crq/ledger.js';
import { compareCodePoints } from '../../../policy/crq/pythonJson.js';
import { pyTruthy, withObjectKeys, withoutObjectKey } from '../../../policy/crq/queueDoc.js';
import { PROMOTION_KIND } from '../../../policy/crq/tickSchedule.js';

export const PR_REVIEWS_PER_TICK = 2;
export const PR_REVIEW_MAX_ATTEMPTS = 5;

/** `crq_review_receipt.ThreadsNotVisible`: the delivery is not at fault; retry free. */
export class ThreadsNotVisibleError extends Error {}
/** Python `ValueError`, `KeyError` or `TypeError` from a delivery: permanent. */
export class DeliveryValueError extends Error {}
/** Python `KeyError` or `TypeError` from a delivery. Callers that catch only `ValueError` let it propagate. */
export class DeliveryKeyTypeError extends DeliveryValueError {}
/** Python `RuntimeError` or `OSError` from a delivery: retried up to the attempt cap. */
export class DeliveryRuntimeError extends Error {}

export interface CleanReviewEffects {
  /** `pr_review_findings.deliver(repo, pr, meta, ndjson)`; `meta` carries the identity checkpoint. */
  deliver(input: {
    readonly repo: string;
    readonly pr: JsonValue;
    readonly ndjson: string;
    readonly runId: string;
    readonly base: string;
    readonly head: string;
    readonly itemId: JsonValue;
    readonly postingIdentity: JsonValue;
    readonly identityReason: JsonValue;
    /** `_checkpoint_review_identity(q, request, login, reason)`. */
    readonly checkpoint: (login: string, reason: string) => Promise<void>;
  }): Promise<JsonObject>;
  /** `crq.iso()`. */
  now(): string;
  /** `crq.REPO`, for items without a `repo`. */
  primaryRepo: string;
  /** Records a changed identity checkpoint against the request, then saves the queue. */
  checkpoint(itemId: JsonValue, login: string, reason: string): Promise<void>;
}

const text = (value: JsonValue | undefined): string => (typeof value === 'string' ? value : '');

/** `str(KeyError(key))`, or the TypeError of subscripting a non-dict request. */
function subscriptError(request: JsonValue | undefined, key: string): string {
  if (request instanceof JsonObject) return `'${key}'`;
  const name = request === undefined ? 'NoneType' : ledgerPythonTypeName(request);
  return `'${name}' object is not subscriptable`;
}

export function counter(item: JsonObject, key: string): bigint {
  const value = item.get(key);
  if (value === undefined) return 0n;
  if (value instanceof JsonNumber && value.kind === 'int') return value.integer as bigint;
  throw new Error(`${key} must be an integer`);
}

function liveIndexes(items: readonly JsonValue[]): number[] {
  const out: number[] = [];
  items.forEach((item, index) => {
    if (item instanceof JsonObject && item.get('kind') !== PROMOTION_KIND) out.push(index);
  });
  return out;
}

/** `deliver_pending_clean_reviews`: returns the next queue and the tick log lines. */
export async function deliverPendingCleanReviews(
  queue: JsonObject,
  effects: CleanReviewEffects,
): Promise<{ readonly queue: JsonObject; readonly log: string[] }> {
  const raw = queue.get('items');
  if (!Array.isArray(raw)) throw new Error('queue items must be an array');
  const items: JsonValue[] = [...raw];
  const candidates = liveIndexes(items)
    .filter((i) => {
      const item = items[i] as JsonObject;
      const kind = item.get('kind');
      return (kind === 'open' || kind === 'delta') && pyTruthy(item.get('clean_review_pending'));
    })
    .sort((a, b) =>
      compareCodePoints(
        pyOr(items[a] as JsonObject, 'clean_review_attempt_at'),
        pyOr(items[b] as JsonObject, 'clean_review_attempt_at'),
      ),
    );
  const log: string[] = [];
  for (const index of candidates.slice(0, PR_REVIEWS_PER_TICK)) {
    let item = items[index] as JsonObject;
    const attempts = counter(item, 'clean_review_attempts') + 1n;
    item = withObjectKeys(item, [
      ['clean_review_attempt_at', effects.now()],
      ['clean_review_attempts', JsonNumber.int(attempts)],
    ]);
    items[index] = item;
    const settle = (error: string, pending: boolean): void => {
      let next = withObjectKeys(item, [['clean_review_error', error.slice(0, 300)]]);
      if (!pending) next = withObjectKeys(next, [['clean_review_pending', false]]);
      item = next;
      items[index] = item;
    };
    try {
      const request = item.get('clean_review_request');
      if (request === undefined) throw new DeliveryValueError("'clean_review_request'");
      const field = (key: string): string => {
        const value = request instanceof JsonObject ? request.get(key) : undefined;
        if (!(request instanceof JsonObject) || value === undefined)
          throw new DeliveryValueError(subscriptError(request, key));
        return typeof value === 'string' ? value : '';
      };
      const runId = field('run_id');
      const base = field('base');
      const head = field('head');
      const itemId = item.get('id');
      if (itemId === undefined) throw new DeliveryValueError("'id'");
      const req = request as JsonObject;
      const pr = req.get('pr');
      if (pr === undefined) throw new DeliveryValueError("'pr'");
      const ndjson = req.get('ndjson');
      if (ndjson === undefined) throw new DeliveryValueError("'ndjson'");
      if (typeof ndjson !== 'string')
        throw new DeliveryValueError(
          `argument should be a str or an os.PathLike object where __fspath__ returns a str, not '${ledgerPythonTypeName(ndjson)}'`,
        );
      const repoValue = item.get('repo');
      const result = await effects.deliver({
        repo: pyTruthy(repoValue) ? text(repoValue) : effects.primaryRepo,
        pr,
        ndjson,
        runId,
        base,
        head,
        itemId,
        postingIdentity: req.get('posting_identity') ?? null,
        identityReason: req.get('identity_reason') ?? null,
        checkpoint: (login, reason) => effects.checkpoint(itemId, login, reason),
      });
      item = withoutObjectKey(
        withObjectKeys(item, [
          ['clean_review', result],
          ['clean_review_pending', false],
        ]),
        'clean_review_error',
      );
      items[index] = item;
      const state = result.get('state');
      log.push(
        `clean review on PR #${pyStr(pr)} (${typeof state === 'string' ? state : pyStr(state ?? null)})`,
      );
    } catch (error) {
      if (error instanceof ThreadsNotVisibleError) {
        item = withObjectKeys(item, [
          ['clean_review_attempts', JsonNumber.int(attempts - 1n)],
          ['clean_review_error', error.message],
        ]);
        items[index] = item;
      } else if (error instanceof DeliveryValueError) settle(error.message, false);
      else if (error instanceof DeliveryRuntimeError)
        settle(error.message, attempts < BigInt(PR_REVIEW_MAX_ATTEMPTS));
      else throw error;
    }
  }
  return { queue: withObjectKeys(queue, [['items', items]]), log };
}

function pyOr(item: JsonObject, key: string): string {
  const value = item.get(key);
  return pyTruthy(value) && typeof value === 'string' ? value : '';
}

export function pyStr(value: JsonValue): string {
  if (value === null) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (value instanceof JsonNumber) return value.raw;
  return JSON.stringify(value);
}
