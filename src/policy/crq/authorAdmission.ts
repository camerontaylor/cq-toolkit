/**
 * Author-review admission and lease policy (`author_quota.py`, `author_lease.py`).
 *
 * Pure queue edits: enrollment creates one PENDING author item, the lease
 * arbitrates between the queue and the fallback reviewer, and an issuer
 * decision is permanent. The caller holds `tick.lock` and persists before any
 * response, so a lost response is never another dispatch permission.
 */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import { pyTruthy, withObjectKeys } from './queueDoc.js';
import { AuthorRefused, bindingOf, bindingsEqual, type AuthorBinding } from './authorWire.js';

export const AUTHOR_KIND = 'author';
export const AUTHOR_FAILED = 'author_failed';
const TS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

function asObject(value: unknown): JsonObject | null {
  return value instanceof JsonObject ? value : null;
}

function objectOrEmpty(value: unknown): JsonObject {
  return value instanceof JsonObject ? value : new JsonObject([]);
}

function arrayOrEmpty(value: unknown): JsonValue[] {
  return Array.isArray(value) ? (value as JsonValue[]) : [];
}

function stringField(value: JsonObject, key: string): string | null {
  const found = value.get(key);
  return typeof found === 'string' ? found : null;
}

/** `author_quota._timestamp`: an exact UTC timestamp, valid calendar date. */
export function authorTimestamp(name: string, value: unknown): Date {
  if (typeof value !== 'string' || !TS.test(value)) {
    throw new AuthorRefused(
      `${name} must be an exact ISO-8601 UTC timestamp YYYY-MM-DDTHH:MM:SSZ (no fractional seconds or offset)`,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AuthorRefused(`${name} is not a valid UTC timestamp`);
  }
  const [date, clock] = value.slice(0, -1).split('T');
  const [year, month, day] = date!.split('-').map(Number) as [number, number, number];
  const [hour, minute, second] = clock!.split(':').map(Number) as [number, number, number];
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second
  ) {
    throw new AuthorRefused(`${name} is not a valid UTC timestamp`);
  }
  return parsed;
}

/** `author_quota._iso`: whole seconds, UTC, trailing `Z`. */
export function authorIso(value: Date): string {
  return `${value.toISOString().slice(0, 19)}Z`;
}

/** `author_lease.new_lease`: the waiting lease bound to the operator policy. */
export function newLease(policy: JsonObject, reviewer: string, at: string): JsonObject {
  const review = policy.get('review');
  const timeout = review instanceof JsonObject ? review.get('reviewerTimeoutMin') : null;
  const minutes = timeout instanceof JsonNumber && timeout.kind === 'int' ? timeout.integer : null;
  if (minutes === null || minutes <= 0n) {
    throw new AuthorRefused('review.reviewerTimeoutMin must be a positive integer');
  }
  if (
    reviewer.length === 0 ||
    reviewer.trim().length === 0 ||
    reviewer.length > 256 ||
    [...reviewer].some((character) => character.codePointAt(0)! < 32)
  ) {
    throw new AuthorRefused('fallback reviewer must be configured explicitly');
  }
  const requested = authorTimestamp('requested_at', at);
  const deadlineMs = requested.getTime() + Number(minutes) * 60_000;
  if (!Number.isFinite(deadlineMs))
    throw new AuthorRefused('review.reviewerTimeoutMin is out of range');
  return new JsonObject([
    ['v', JsonNumber.int(1)],
    ['state', 'waiting'],
    ['requested_at', at],
    ['deadline_at', authorIso(new Date(deadlineMs))],
    ['reviewerTimeoutMin', JsonNumber.int(minutes)],
    ['reviewer', reviewer],
  ]);
}

/** `author_lease.read`: absent means legacy; malformed/unknown versions refuse. */
export function readLease(item: JsonObject): JsonObject | null {
  if (!item.has('author_lease')) return null;
  const lease = asObject(item.get('author_lease'));
  if (
    lease === null ||
    !(lease.get('v') instanceof JsonNumber) ||
    (lease.get('v') as JsonNumber).kind !== 'int' ||
    (lease.get('v') as JsonNumber).integer !== 1n
  ) {
    throw new AuthorRefused('unsupported author_lease version');
  }
  const timeout = lease.get('reviewerTimeoutMin');
  const reviewer = lease.get('reviewer');
  const expected = newLease(
    new JsonObject([['review', new JsonObject([['reviewerTimeoutMin', timeout ?? null]])]]),
    typeof reviewer === 'string' ? reviewer : '',
    typeof lease.get('requested_at') === 'string' ? (lease.get('requested_at') as string) : '',
  );
  if (lease.get('deadline_at') !== expected.get('deadline_at')) {
    throw new AuthorRefused('author_lease deadline does not match its policy');
  }
  const state = lease.get('state');
  if (state !== 'waiting' && state !== 'queue' && state !== 'agent') {
    throw new AuthorRefused('unknown author_lease state');
  }
  if (lease.has('secret_scan_blocked') && lease.get('secret_scan_blocked') !== true) {
    throw new AuthorRefused('invalid author_lease secret-scan marker');
  }
  if (state !== 'waiting') {
    const decided = authorTimestamp('decided_at', lease.get('decided_at'));
    const deadline = authorTimestamp('deadline_at', lease.get('deadline_at'));
    if (
      decided < authorTimestamp('requested_at', lease.get('requested_at')) ||
      (state === 'queue' && decided >= deadline) ||
      (state === 'agent' && decided < deadline)
    ) {
      throw new AuthorRefused('invalid author_lease decision time');
    }
  }
  return lease;
}

/** `author_lease.check_queue`: a queue grant is valid exactly once. */
export function checkQueue(item: JsonObject, at: string): void {
  const lease = readLease(item);
  if (lease === null) return;
  if (lease.get('secret_scan_blocked')) {
    throw new AuthorRefused('author lease permanently blocked by secret scan');
  }
  if (
    item.get('state') !== 'pending' ||
    pyTruthy(item.get('run')) ||
    pyTruthy(item.get('attempts'))
  ) {
    throw new AuthorRefused('author request is not an unstarted pending admission');
  }
  const current = authorTimestamp('at', at);
  if (current < authorTimestamp('requested_at', lease.get('requested_at'))) {
    throw new AuthorRefused('author lease clock moved backwards');
  }
  if (lease.get('state') !== 'waiting') {
    throw new AuthorRefused('author lease already assigned; no replay');
  }
  if (current >= authorTimestamp('deadline_at', lease.get('deadline_at'))) {
    throw new AuthorRefused('author lease deadline passed; queue grant refused');
  }
}

/** `author_lease.grant_queue`: persist the queue-issuer decision. */
export function grantQueue(item: JsonObject, at: string): JsonObject {
  checkQueue(item, at);
  if (!item.has('author_lease')) return item;
  const lease = asObject(item.get('author_lease'))!;
  return withObjectKeys(item, [
    [
      'author_lease',
      withObjectKeys(lease, [
        ['state', 'queue'],
        ['decided_at', at],
      ]),
    ],
  ]);
}

function itemFor(queue: JsonObject, itemId: unknown): JsonObject | null {
  if (typeof itemId !== 'string') return null;
  for (const entry of arrayOrEmpty(queue.get('items'))) {
    const item = asObject(entry);
    if (item !== null && item.get('id') === itemId) return item;
  }
  return null;
}

/** `author_lease.find`: the request and item agree, and the item has a lease. */
export function findAuthorRequest(queue: JsonObject, requestId: string): JsonObject {
  const requests = objectOrEmpty(queue.get('author_requests'));
  const entry = asObject(requests.get(requestId));
  if (entry === null) throw new AuthorRefused('unknown author request');
  const item = itemFor(queue, entry.get('item'));
  if (item === null || item.get('kind') !== AUTHOR_KIND) {
    throw new AuthorRefused('author request/item binding mismatch');
  }
  const author = asObject(item.get('author'));
  if (
    author === null ||
    author.get('request_id') !== requestId ||
    !bindingsEqual(bindingOf(author), bindingOf(entry))
  ) {
    throw new AuthorRefused('author request/item binding mismatch');
  }
  if (readLease(item) === null) throw new AuthorRefused('legacy author request has no lease');
  return item;
}

/** `author_lease.decision`: the issuer decision the worker reads. */
export function leaseDecision(item: JsonObject, dispatch = false): JsonObject {
  const lease = readLease(item);
  const author = asObject(item.get('author'));
  if (lease === null || author === null) throw new AuthorRefused('author request has no lease');
  const state = lease.get('state');
  return new JsonObject([
    ['v', JsonNumber.int(1)],
    ['request_id', author.get('request_id') ?? null],
    ['binding', bindingOf(author)],
    ['issuer', state ?? null],
    ['reviewer', state === 'agent' ? (lease.get('reviewer') ?? null) : null],
    ['deadline_at', lease.get('deadline_at') ?? null],
    ['decided_at', lease.get('decided_at') ?? null],
    ['dispatch', dispatch],
  ]);
}

/** `author_lease.fallback`: `dispatch` is true only for the first grant. */
export function fallbackDecision(
  queue: JsonObject,
  requestId: string,
  at: string,
): { readonly queue: JsonObject; readonly result: JsonObject } {
  let item = findAuthorRequest(queue, requestId);
  const lease = readLease(item);
  if (lease === null) throw new AuthorRefused('author request has no lease');
  if (lease.get('secret_scan_blocked')) {
    throw new AuthorRefused('author lease permanently blocked by secret scan');
  }
  if (lease.get('state') !== 'waiting') {
    return { queue, result: leaseDecision(item) };
  }
  if (authorTimestamp('at', at) < authorTimestamp('deadline_at', lease.get('deadline_at'))) {
    throw new AuthorRefused('author fallback before lease deadline');
  }
  if (
    item.get('state') !== 'pending' ||
    pyTruthy(item.get('run')) ||
    pyTruthy(item.get('attempts'))
  ) {
    throw new AuthorRefused('author request is not an unstarted pending admission');
  }
  item = withObjectKeys(item, [
    [
      'author_lease',
      withObjectKeys(lease, [
        ['state', 'agent'],
        ['decided_at', at],
      ]),
    ],
    ['state', 'skipped'],
  ]);
  const items = arrayOrEmpty(queue.get('items')).map((entry) => {
    const candidate = asObject(entry);
    return candidate !== null && candidate.get('id') === item.get('id') ? item : entry;
  });
  return {
    queue: withObjectKeys(queue, [['items', items]]),
    result: leaseDecision(item, true),
  };
}

export interface EnrollAuthorInput {
  readonly binding: AuthorBinding;
  readonly at: string;
  /** The operator review policy's lease, when enrollment opted in. */
  readonly lease: JsonObject | null;
}

/** `author_quota.enroll` + `crq.enroll_author`'s lease binding. */
export function enrollAuthor(
  queue: JsonObject,
  input: EnrollAuthorInput,
): {
  readonly queue: JsonObject;
  readonly item: JsonObject;
  readonly created: boolean;
  readonly message: string;
} {
  const binding = input.binding;
  const bindingJson = new JsonObject([
    ['request_id', binding.requestId],
    ['base', binding.base],
    ['head', binding.head],
    ['target', binding.target],
    ['cycle', JsonNumber.int(binding.cycle)],
  ]);
  const requestsValue = queue.get('author_requests');
  const requests = requestsValue === undefined ? new JsonObject([]) : asObject(requestsValue);
  if (requests === null) throw new AuthorRefused('author_requests is not an object');
  const seen = asObject(requests.get(binding.requestId));
  if (seen !== null) {
    if (!bindingsEqual(bindingOf(seen), bindingOf(bindingJson))) {
      throw new AuthorRefused(
        `request_id ${JSON.stringify(binding.requestId)} is already enrolled with a different binding; refusing to mutate an immutable request`,
      );
    }
    const item = itemFor(queue, seen.get('item'));
    if (item === null) {
      throw new AuthorRefused(
        `request_id ${JSON.stringify(binding.requestId)} is recorded but its item is missing; refusing`,
      );
    }
    return {
      queue,
      item,
      created: false,
      message: `author ${String(item.get('id'))}: idempotent (already enrolled cycle ${binding.cycle.toString()})`,
    };
  }
  let clash: JsonObject | null = null;
  for (const [, entryValue] of requests.entries) {
    const entry = asObject(entryValue);
    if (entry !== null && bindingsEqual(bindingOf(entry), bindingOf(bindingJson))) {
      clash = entry;
      break;
    }
  }
  if (clash !== null) {
    throw new AuthorRefused(
      `binding ${binding.base.slice(0, 10)}..${binding.head.slice(0, 10)} cycle ${binding.cycle.toString()} is already enrolled as ${String(clash.get('item'))} (request_id ${JSON.stringify(clash.get('request_id'))}); refusing a duplicate`,
    );
  }
  const itemId = `author-${binding.requestId}`;
  if (itemFor(queue, itemId) !== null) {
    throw new AuthorRefused(
      `item ${itemId} already exists without a matching request record; refusing`,
    );
  }
  let order = 0n;
  for (const entry of arrayOrEmpty(queue.get('items'))) {
    const candidate = asObject(entry);
    if (candidate === null) continue;
    const value = candidate.get('order');
    if (
      value instanceof JsonNumber &&
      value.kind === 'int' &&
      value.integer !== null &&
      value.integer > order
    ) {
      order = value.integer;
    }
  }
  const note = `${input.at} author-enrolled (request ${binding.requestId}): cycle ${binding.cycle.toString()}, ${binding.base.slice(0, 10)}..${binding.head.slice(0, 10)} → ${binding.target}`;
  let item = new JsonObject([
    ['id', itemId],
    ['pr', JsonNumber.int(0)],
    ['kind', AUTHOR_KIND],
    ['order', JsonNumber.int(order + 1n)],
    ['state', 'pending'],
    ['cycles', []],
    ['author_cycles', []],
    ['attempts', []],
    ['requested_at', input.at],
    ['author', bindingJson],
    ['notes', [note]],
  ]);
  if (input.lease !== null) {
    item = withObjectKeys(item, [['author_lease', input.lease]]);
  }
  const nextRequests = withObjectKeys(requests, [
    [
      binding.requestId,
      new JsonObject([
        ...bindingJson.entries,
        ['item', itemId],
        ['created_at', input.at],
        ['state', 'enrolled'],
      ]),
    ],
  ]);
  return {
    queue: withObjectKeys(queue, [
      ['items', [...arrayOrEmpty(queue.get('items')), item]],
      ['author_requests', nextRequests],
    ]),
    item,
    created: true,
    message: `author ${itemId}: enrolled cycle ${binding.cycle.toString()} (${binding.base.slice(0, 12)}..${binding.head.slice(0, 12)} → ${binding.target})`,
  };
}

/** `crq.enroll_author`'s lease replacement check for an existing item. */
export function assertLeaseReplacement(item: JsonObject, lease: JsonObject): void {
  const old = readLease(item);
  const previous = old?.get('reviewerTimeoutMin');
  const next = lease.get('reviewerTimeoutMin');
  if (
    old === null ||
    !(previous instanceof JsonNumber) ||
    !(next instanceof JsonNumber) ||
    previous.kind !== 'int' ||
    next.kind !== 'int' ||
    previous.integer !== next.integer ||
    old.get('reviewer') !== lease.get('reviewer')
  ) {
    throw new AuthorRefused("cannot replace an existing request's lease policy");
  }
}

/** `review_ledger.digest` of a lease field pair, exposed for the handler's audit line. */
export function leaseFields(lease: JsonObject): JsonObject {
  return new JsonObject([
    ['reviewerTimeoutMin', lease.get('reviewerTimeoutMin') ?? null],
    ['reviewer', lease.get('reviewer') ?? null],
  ]);
}

/** The stored lease, or `null`; public for the handler's preview check. */
export function leaseOf(item: JsonObject): JsonObject | null {
  return readLease(item);
}

export { stringField };
