/**
 * Bounded at-least-once completion delivery (`review_notify.py`), queue half.
 *
 * The route only records the destination and enqueues one outbox row per
 * retained review event. Transport (the `paseo_send` call, retries and
 * backoff) is the publisher's drain; it is not reachable under `tick.lock`.
 */
import { JsonNumber, JsonObject } from './jsonValue.js';
import { withObjectKeys } from './queueDoc.js';
import { ledgerJsonDigest } from './pythonJson.js';
import { replaceRequest } from './reviewAdmission.js';

const UUID = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const HOST = /^[A-Za-z0-9_.:-]+$/;

function asObject(value: unknown): JsonObject | null {
  return value instanceof JsonObject ? value : null;
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * `review_notify.destination`: a destination the operator configured.
 *
 * The agent must be a UUID and the host must appear in `config.notify.hosts`;
 * anything else is not a destination and is never echoed back as accepted.
 */
export function notifyDestination(value: unknown, config: JsonObject): JsonObject | null {
  if (!(value instanceof JsonObject)) return null;
  if (value.entries.length !== 2 || !value.has('paseo_agent_id') || !value.has('paseo_host')) {
    return null;
  }
  const agent = value.get('paseo_agent_id');
  const host = value.get('paseo_host');
  const section = asObject(config.get('notify'));
  const hosts = section === null ? [] : section.get('hosts');
  if (!Array.isArray(hosts)) return null;
  if (typeof agent !== 'string' || !UUID.test(agent)) return null;
  if (host !== null) {
    if (typeof host !== 'string' || host.startsWith('-') || !HOST.test(host)) return null;
  }
  if (!hosts.some((entry) => entry === host)) return null;
  return new JsonObject(value.entries.map(([key, entry]) => [key, entry]));
}

/** `review_notify.validation`: the status a request reports for its destination. */
export function notifyValidation(
  value: unknown,
  config: JsonObject,
  required: boolean,
): JsonObject {
  if (notifyDestination(value, config) !== null) {
    return new JsonObject([['state', required ? 'pending' : 'not-required']]);
  }
  return new JsonObject([
    ['state', 'error'],
    ['reason', 'unsupported-destination'],
  ]);
}

function requestFor(queue: JsonObject, requestId: string): JsonObject | null {
  const requests = queue.get('review_requests');
  return requests instanceof JsonObject ? asObject(requests.get(requestId)) : null;
}

/** `review_notify.update`: replace one request's destination and its pending rows. */
export function updateNotify(
  queue: JsonObject,
  requestId: string,
  value: JsonObject | null,
  config: JsonObject,
): JsonObject {
  const request = requestFor(queue, requestId);
  if (request === null) throw new Error('unknown review request');
  const itemId = request.get('item');

  const outboxValue = queue.get('review_notify_outbox');
  const outbox = outboxValue instanceof JsonObject ? outboxValue : new JsonObject([]);
  const withdrawn = new JsonObject(
    outbox.entries.map(([key, rowValue]) => {
      const row = asObject(rowValue);
      if (row === null) return [key, rowValue] as const;
      if (row.get('request_id') === requestId && row.get('state') === 'pending') {
        return [key, withObjectKeys(row, [['state', 'withdrawn']])] as const;
      }
      return [key, rowValue] as const;
    }),
  );

  let nextRequest = withObjectKeys(
    new JsonObject(request.entries.filter(([key]) => key !== 'notify')),
    [
      [
        'notify_status',
        value === null
          ? new JsonObject([['state', 'withdrawn']])
          : notifyValidation(value, config, true),
      ],
    ],
  );

  const accepted = value === null ? null : notifyDestination(value, config);
  let nextOutbox = withdrawn;
  if (accepted !== null) {
    nextRequest = withObjectKeys(nextRequest, [['notify', accepted]]);
    let delivered = false;
    const eventsValue = queue.get('review_events');
    const events = eventsValue instanceof JsonObject ? eventsValue : new JsonObject([]);
    for (const [eventId, eventValue] of events.entries) {
      const event = asObject(eventValue);
      if (event === null || event.get('item') !== itemId) continue;
      const key = ledgerJsonDigest([requestId, eventId, accepted]);
      const existing = asObject(nextOutbox.get(key));
      if (existing !== null && existing.get('state') === 'sent') {
        delivered = true;
        continue;
      }
      const receiptId = event.get('receipt_id');
      nextOutbox = withObjectKeys(nextOutbox, [
        [
          key,
          new JsonObject([
            ['v', JsonNumber.int(1)],
            ['request_id', requestId],
            ['event_id', eventId],
            ['destination', accepted],
            ['state', 'pending'],
            ['receipt_id', receiptId ?? null],
          ]),
        ],
      ]);
    }
    const pending = nextOutbox.entries.some(([, rowValue]) => {
      const row = asObject(rowValue);
      return row !== null && row.get('request_id') === requestId && row.get('state') === 'pending';
    });
    if (!pending && delivered) {
      nextRequest = withObjectKeys(nextRequest, [
        ['notify_status', new JsonObject([['state', 'sent']])],
      ]);
    } else if (!pending) {
      const item = findItem(queue, typeof itemId === 'string' ? itemId : null);
      const observers = item === null ? [] : arrayOrEmpty(item.get('observers'));
      if (item !== null && !observers.includes(requestId)) {
        nextRequest = withObjectKeys(nextRequest, [
          ['notify_status', new JsonObject([['state', 'not-required']])],
        ]);
      }
    }
  }

  let next = replaceRequest(queue, requestId, nextRequest);
  next = withObjectKeys(next, [['review_notify_outbox', nextOutbox]]);
  return next;
}

function findItem(queue: JsonObject, itemId: string | null): JsonObject | null {
  if (itemId === null) return null;
  for (const entry of arrayOrEmpty(queue.get('items'))) {
    const item = asObject(entry);
    if (item !== null && item.get('id') === itemId) return item;
  }
  return null;
}

/** `review_notify.update(q, request_id, None, {})`, used by cancel. */
export function withdrawNotify(queue: JsonObject, requestId: string): JsonObject {
  const request = requestFor(queue, requestId);
  if (request === null) throw new Error('unknown review request');
  const outboxValue = queue.get('review_notify_outbox');
  const outbox = outboxValue instanceof JsonObject ? outboxValue : new JsonObject([]);
  const withdrawn = new JsonObject(
    outbox.entries.map(([key, rowValue]) => {
      const row = asObject(rowValue);
      if (row !== null && row.get('request_id') === requestId && row.get('state') === 'pending') {
        return [key, withObjectKeys(row, [['state', 'withdrawn']])] as const;
      }
      return [key, rowValue] as const;
    }),
  );
  const nextRequest = withObjectKeys(
    new JsonObject(request.entries.filter(([key]) => key !== 'notify')),
    [['notify_status', new JsonObject([['state', 'withdrawn']])]],
  );
  let next = replaceRequest(queue, requestId, nextRequest);
  next = withObjectKeys(next, [['review_notify_outbox', withdrawn]]);
  return next;
}
