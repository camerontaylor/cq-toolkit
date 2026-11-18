/** Port of `local_review_pr.associate`: link a pull request to the equivalent
 * local-review item and record the PR as an observer of it. Pure over the queue:
 * the two reads Python makes (`runtime.facts`, `runtime.retained`) are injected, and
 * the updated queue is returned instead of mutated in place.
 *
 * Divergence: Python's `operation.equivalent` re-validates the identity inputs of
 * each candidate; the TS comparison (`equivalentIdentityInputs`) only compares them,
 * so a malformed stored identity is "not equivalent" rather than an exception.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../policy/crq/jsonValue.js';
import { pyTruthy, withObjectKeys, withoutObjectKey } from '../policy/crq/queueDoc.js';
import {
  ACTIVE_STATES,
  equivalentIdentityInputs,
  LOCAL_REVIEW_KIND,
} from '../policy/crq/reviewAdmission.js';

export interface LocalReviewAssociateEffects {
  /** `runtime.facts`; null stands for Python's OSError/RuntimeError/ValueError/SubprocessError. */
  facts(repo: string, base: string, head: string): Promise<JsonObject | null>;
  /** `runtime.retained(c, item)`. */
  retained(item: JsonObject): Promise<boolean>;
}

export interface LocalReviewAssociation {
  readonly queue: JsonObject;
  readonly associated: boolean;
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error(`${label} must be an object`);
  return value;
}

/** Mark `repo#pr`'s recorded link stale when it names another head or base.
 * Returns `queue` itself when there is no link, or the link still matches. */
function markPreviousLinkStale(
  queue: JsonObject,
  repo: string,
  pr: number,
  base: string,
  head: string,
): JsonObject {
  const linksValue = queue.get('review_pr_links');
  const links =
    linksValue === undefined ? new JsonObject([]) : object(linksValue, 'review_pr_links');
  const key = `${repo}#${pr}`;
  const previousValue = links.get(key);
  const previous = pyTruthy(previousValue) ? object(previousValue, 'review_pr_link') : undefined;
  if (previous === undefined) return queue;
  if (previous.get('head') === head && previous.get('base') === base) return queue;
  return withObjectKeys(queue, [
    [
      'review_pr_links',
      withObjectKeys(links, [[key, withObjectKeys(previous, [['stale', true]])]]),
    ],
  ]);
}

export async function associateLocalReview(
  queue: JsonObject,
  repo: string,
  pr: number,
  base: string,
  head: string,
  dry: boolean,
  effects: LocalReviewAssociateEffects,
): Promise<LocalReviewAssociation> {
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new Error('queue items must be an array');
  const isLocal = (v: JsonValue): v is JsonObject =>
    v instanceof JsonObject && v.get('kind') === LOCAL_REVIEW_KIND;
  if (!items.some(isLocal)) {
    // No local item means no identity to resolve, but a link left by an older
    // head still goes stale — exactly as it does when nothing else matches.
    return {
      queue: dry ? queue : markPreviousLinkStale(queue, repo, pr, base, head),
      associated: false,
    };
  }
  const wanted = await effects.facts(repo, base, head);
  if (wanted === null) return { queue, associated: false };
  const candidates = items.filter(isLocal).filter((item) => {
    const inputs = item.get('identity_inputs');
    return inputs instanceof JsonObject && equivalentIdentityInputs(inputs, wanted);
  });
  let local: JsonObject | undefined;
  for (const item of [...candidates].reverse()) {
    if (await effects.retained(item)) {
      local = item;
      break;
    }
  }
  if (local === undefined) {
    local = [...candidates].reverse().find((item) => ACTIVE_STATES.has(String(item.get('state'))));
  }
  if (dry) return { queue, associated: local !== undefined };

  const key = `${repo}#${pr}`;
  const linksValue = queue.get('review_pr_links');
  let links = linksValue === undefined ? new JsonObject([]) : object(linksValue, 'review_pr_links');
  let next = queue;
  const previousValue = links.get(key);
  const previous = pyTruthy(previousValue) ? object(previousValue, 'review_pr_link') : undefined;
  let observed: JsonObject | undefined;
  if (local !== undefined) {
    let link: JsonObject;
    if (
      previous !== undefined &&
      previous.get('item') === local.get('id') &&
      previous.get('head') === head &&
      previous.get('base') === base
    ) {
      link = previous;
    } else {
      link = new JsonObject([
        ['repo', repo],
        ['pr', JsonNumber.int(pr)],
        ['item', local.get('id') ?? null],
        ['head', head],
        ['base', base],
      ]);
    }
    links = withObjectKeys(links, [[key, withoutObjectKey(link, 'stale')]]);
    const observers = local.get('pr_observers');
    const list = observers === undefined ? [] : observers;
    if (!Array.isArray(list)) throw new Error('pr_observers must be an array');
    observed = list.includes(key)
      ? withObjectKeys(local, [['pr_observers', list]])
      : withObjectKeys(local, [['pr_observers', [...list, key]]]);
  } else if (
    previous !== undefined &&
    (previous.get('head') !== head || previous.get('base') !== base)
  ) {
    links = withObjectKeys(links, [[key, withObjectKeys(previous, [['stale', true]])]]);
  }
  next = withObjectKeys(next, [['review_pr_links', links]]);
  if (observed !== undefined) {
    const target = local;
    next = withObjectKeys(next, [['items', items.map((v) => (v === target ? observed : v))]]);
  }
  return { queue: next, associated: local !== undefined };
}
