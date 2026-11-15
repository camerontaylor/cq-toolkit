/**
 * `crq.deliver_pending_pr_reviews` with `_deliver_pr_review` and `_settle_pr_review`:
 * the bounded post-harvest pass that posts each counted open/delta review's findings
 * on its PR. It first upgrades undelivered legacy issue debt into a PR-review request,
 * then delivers the two least-recently-attempted debts.
 *
 * The delivery itself (`pr_review_findings.deliver`, with its receipt and identity
 * checkpoint), the clock and the event log are injected. Python mutates the queue in
 * place; this returns a new queue. Not wired into a tick.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { ledgerPythonTypeName } from '../../../policy/crq/ledger.js';
import { compareCodePoints } from '../../../policy/crq/pythonJson.js';
import { pyTruthy, withObjectKeys } from '../../../policy/crq/queueDoc.js';
import { PROMOTION_KIND } from '../../../policy/crq/tickSchedule.js';
import {
  PR_REVIEWS_PER_TICK,
  PR_REVIEW_MAX_ATTEMPTS,
  DeliveryKeyTypeError,
  DeliveryRuntimeError,
  DeliveryValueError,
  ThreadsNotVisibleError,
  counter,
  pyStr,
} from './deliverPending.js';

export interface PrReviewEffects {
  /** `pr_review_findings.deliver(repo, pr, meta, Path(ndjson))`. */
  deliver(input: {
    readonly repo: string;
    readonly pr: JsonValue;
    readonly ndjson: string;
    readonly runId: JsonValue;
    readonly base: JsonValue;
    readonly head: JsonValue;
    readonly itemId: JsonValue;
    readonly postingIdentity: JsonValue;
    readonly identityReason: JsonValue;
    /** `_checkpoint_review_identity(q, request, login, reason)`. */
    readonly checkpoint: (login: string, reason: string) => Promise<void>;
  }): Promise<JsonObject>;
  now(): string;
  primaryRepo: string;
  /** Records a changed identity checkpoint against the request, then saves the queue. */
  checkpoint(itemId: JsonValue, login: string, reason: string): Promise<void>;
  event(
    kind: 'findings_review_delivered' | 'findings_review_abandoned',
    data: Record<string, JsonValue>,
  ): Promise<void>;
}

const KINDS = ['open', 'delta'];
const isLive = (item: JsonValue): item is JsonObject =>
  item instanceof JsonObject && item.get('kind') !== PROMOTION_KIND;
const isReviewKind = (item: JsonObject): boolean => KINDS.includes(item.get('kind') as string);
const sortKey = (item: JsonObject): string => {
  const value = item.get('pr_review_attempt_at');
  return pyTruthy(value) && typeof value === 'string' ? value : '';
};

/** `str(Path(findings_md).with_name('review.ndjson'))`; undefined where Python raises. */
export function reviewNdjsonBeside(findingsMd: JsonValue | undefined): string | undefined {
  if (typeof findingsMd !== 'string') return undefined;
  const root = findingsMd.startsWith('///')
    ? '/'
    : findingsMd.startsWith('//')
      ? '//'
      : findingsMd.startsWith('/')
        ? '/'
        : '';
  const parts = findingsMd.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0) return undefined; // empty name
  parts[parts.length - 1] = 'review.ndjson';
  return root + parts.join('/');
}

/** Upgrade undelivered open-PR issue debt from older runners into a PR-review request. */
function upgradeIssueDebt(items: JsonValue[]): void {
  items.forEach((entry, index) => {
    if (!isLive(entry) || !isReviewKind(entry) || !pyTruthy(entry.get('issue_pending'))) return;
    let item = entry;
    if (!pyTruthy(item.get('issue')) && !pyTruthy(item.get('pr_review_request'))) {
      const raw = item.get('issue_request');
      const request = raw instanceof JsonObject ? raw : new JsonObject([]);
      const ndjson = reviewNdjsonBeside(request.get('findings_md'));
      item = withObjectKeys(item, [
        [
          'pr_review_request',
          new JsonObject([
            ['run_id', request.get('run_id') ?? null],
            ['pr', item.get('pr') ?? null],
            ['base', request.get('base') ?? null],
            ['head', request.get('head') ?? null],
            ['ndjson', ndjson ?? null],
            ['severity_counts', request.get('severity_counts') ?? new JsonObject([])],
          ]),
        ],
        ['pr_review_pending', true],
        ['pr_review_attempts', JsonNumber.int(0n)],
      ]);
    }
    items[index] = withObjectKeys(item, [['issue_pending', false]]);
  });
}

/** `request[key]`: the value, or the Python exception text `{exc!r}` shows. */
function subscript(
  request: JsonValue,
  key: string,
): { readonly value: JsonValue } | { readonly repr: string } {
  if (request instanceof JsonObject) {
    const value = request.get(key);
    return value === undefined ? { repr: `KeyError('${key}')` } : { value };
  }
  if (typeof request === 'string')
    return { repr: `TypeError("string indices must be integers, not 'str'")` };
  if (Array.isArray(request))
    return { repr: "TypeError('list indices must be integers or slices, not str')" };
  return { repr: `TypeError("'${ledgerPythonTypeName(request)}' object is not subscriptable")` };
}

/** `_deliver_pr_review`: the next item (possibly unchanged) and the log line. */
async function deliverOne(
  start: JsonObject,
  effects: PrReviewEffects,
): Promise<{ readonly item: JsonObject; readonly message?: string }> {
  const request = start.get('pr_review_request');
  if (!pyTruthy(request) || !pyTruthy(start.get('pr_review_pending'))) return { item: start };
  let item = withObjectKeys(start, [
    ['pr_review_attempts', JsonNumber.int(counter(start, 'pr_review_attempts') + 1n)],
  ]);
  const attempts = (): bigint => counter(item, 'pr_review_attempts');
  const itemId = (): JsonValue => {
    const id = item.get('id');
    if (id === undefined) throw new Error("'id'");
    return id;
  };
  const settle = async (error: string): Promise<{ item: JsonObject; message: string }> => {
    const id = itemId();
    const text = error.slice(0, 300);
    item = withObjectKeys(item, [
      ['pr_review_error', text],
      ['pr_review_pending', false],
    ]);
    const asked = item.get('pr_review_request');
    const run = asked instanceof JsonObject ? (asked.get('run_id') ?? null) : null;
    await effects.event('findings_review_abandoned', {
      item: id,
      pr: item.get('pr') ?? null,
      run,
      attempts: item.get('pr_review_attempts') ?? null,
      error: text,
    });
    return {
      item,
      message: `findings review for PR #${pyStr(item.get('pr') ?? null)} abandoned: ${text}`,
    };
  };

  const req = request as JsonValue;
  const pr = subscript(req, 'pr');
  const path = 'value' in pr ? subscript(req, 'ndjson') : undefined;
  let bad: string | undefined = 'repr' in pr ? pr.repr : undefined;
  let ndjson = '';
  if (bad === undefined && path !== undefined) {
    if ('repr' in path) bad = path.repr;
    else if (typeof path.value !== 'string')
      bad = `TypeError("argument should be a str or an os.PathLike object where __fspath__ returns a str, not '${ledgerPythonTypeName(path.value)}'")`;
    else ndjson = path.value;
  }
  const ids = ['run_id', 'base', 'head'].map((key) => subscript(req, key));
  if (bad === undefined) {
    const missing = ids.find((r) => 'repr' in r);
    if (missing && 'repr' in missing) bad = missing.repr;
  }
  if (bad === undefined && item.get('id') === undefined) bad = "KeyError('id')";
  if (bad !== undefined) return settle(`malformed findings review request: ${bad}`);

  const prValue = (pr as { value: JsonValue }).value;
  const [runId, base, head] = ids.map((r) => (r as { value: JsonValue }).value) as [
    JsonValue,
    JsonValue,
    JsonValue,
  ];
  const asObject = req as JsonObject;
  const id = itemId();
  const repoValue = item.get('repo');
  let result: JsonObject;
  try {
    result = await effects.deliver({
      repo: pyTruthy(repoValue) && typeof repoValue === 'string' ? repoValue : effects.primaryRepo,
      pr: prValue,
      ndjson,
      runId,
      base,
      head,
      itemId: id,
      postingIdentity: asObject.get('posting_identity') ?? null,
      identityReason: asObject.get('identity_reason') ?? null,
      checkpoint: (login, reason) => effects.checkpoint(id, login, reason),
    });
  } catch (error) {
    if (error instanceof ThreadsNotVisibleError) {
      item = withObjectKeys(item, [
        ['pr_review_attempts', JsonNumber.int(attempts() - 1n)],
        ['pr_review_error', error.message],
      ]);
      return { item };
    }
    if (error instanceof DeliveryKeyTypeError) throw error;
    if (error instanceof DeliveryValueError) return settle(error.message);
    if (error instanceof DeliveryRuntimeError) {
      item = withObjectKeys(item, [['pr_review_error', error.message.slice(0, 300)]]);
      if (attempts() >= BigInt(PR_REVIEW_MAX_ATTEMPTS))
        return settle(`${attempts()} attempts failed; last: ${error.message}`);
      return { item };
    }
    throw error;
  }
  const state = result.get('state');
  if (state === undefined) throw new Error("'state'");
  item = withObjectKeys(item, [
    ['pr_review', result],
    ['pr_review_pending', false],
  ]);
  item = new JsonObject(item.entries.filter(([key]) => key !== 'pr_review_error'));
  await effects.event('findings_review_delivered', {
    item: id,
    pr: prValue,
    run: runId,
    review: result.get('review_id') ?? null,
    state,
    inline: result.get('inline') ?? null,
    body_only: result.get('body_only') ?? null,
  });
  return { item, message: `findings review on PR #${pyStr(prValue)} (${pyStr(state)})` };
}

export async function deliverPendingPrReviews(
  queue: JsonObject,
  effects: PrReviewEffects,
): Promise<{ readonly queue: JsonObject; readonly log: string[] }> {
  const raw = queue.get('items');
  if (!Array.isArray(raw)) throw new Error('queue items must be an array');
  const items: JsonValue[] = [...raw];
  upgradeIssueDebt(items);
  const candidates = items
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        isLive(entry) && pyTruthy(entry.get('pr_review_pending')) && isReviewKind(entry),
    )
    .sort((a, b) =>
      compareCodePoints(sortKey(a.entry as JsonObject), sortKey(b.entry as JsonObject)),
    );
  const log: string[] = [];
  for (const { index } of candidates.slice(0, PR_REVIEWS_PER_TICK)) {
    const stamped = withObjectKeys(items[index] as JsonObject, [
      ['pr_review_attempt_at', effects.now()],
    ]);
    items[index] = stamped;
    const done = await deliverOne(stamped, effects);
    items[index] = done.item;
    if (done.message) log.push(done.message);
  }
  return { queue: withObjectKeys(queue, [['items', items]]), log };
}
