/**
 * `backfill_runtime.state_event`: spool one `job-state` event for a backfill
 * item into the publication outbox and remember its id on the queue so a retry
 * never duplicates it. The reason and instant come from the caller; the
 * operator inventory route passes `inventory enqueue` at `item.created_at`, the
 * tick's in-lock inventory also retires superseded jobs at the tick clock.
 */
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './atomic.js';
import { withLock } from './lock.js';
import { Outbox, type OutboxFiles } from '../../ops/review/internal/crq/outbox.js';
import { JsonNumber, JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import {
  ledgerDigestOf,
  ledgerEvent,
  ledgerSubscript,
  pythonTruthy,
  LedgerIntegrityError,
} from '../../policy/crq/ledger.js';
import { withObjectKeys } from '../../policy/crq/queueDoc.js';
import { readBackfillRollout, readOptionalFile } from './backfillRollout.js';

export function outboxFiles(root: string): OutboxFiles {
  const pending = join(root, 'pending');
  const ack = join(root, 'ack');
  return {
    async withLock(fn) {
      await mkdir(root, { recursive: true });
      return withLock(join(root, 'outbox.lock'), { wait: true }, fn);
    },
    async listPending() {
      let names: string[];
      try {
        names = await readdir(pending);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      return names
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -5))
        .sort();
    },
    readPending: (id) => readOptionalFile(join(pending, `${id}.json`)),
    async writePending(id, bytes) {
      await mkdir(pending, { recursive: true });
      await atomicWrite(join(pending, `${id}.json`), bytes);
    },
    async hasAck(id) {
      try {
        await stat(join(ack, `${id}.json`));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    async writeAck(id, bytes) {
      await mkdir(ack, { recursive: true });
      await atomicWrite(join(ack, `${id}.json`), bytes);
    },
  };
}

export type BackfillStateEvent = (
  queue: JsonObject,
  item: JsonObject,
  at: JsonValue,
  reason: string,
) => Promise<JsonObject>;

export function backfillStateEventWriter(
  stateRoot: string,
  { requireRollout = false } = {},
): BackfillStateEvent {
  const outbox = new Outbox(outboxFiles(join(stateRoot, 'backfill', 'publication')), {
    async verify() {
      throw new LedgerIntegrityError('unexpected state event artifact');
    },
  });
  return async (queue, item, at, reason) => {
    const config = await readBackfillRollout(stateRoot);
    if (config === null && requireRollout)
      throw new LedgerIntegrityError('operator rollout removed during inventory event write');
    if (config === null || item.get('kind') !== 'backfill') return queue;
    const job = ledgerSubscript(item, 'job_id');
    if (typeof job !== 'string') throw new LedgerIntegrityError('invalid job id');
    const payload = new JsonObject([
      ['family', ledgerSubscript(item, 'family')],
      ['subject_id', ledgerSubscript(item, 'subject_id')],
      ['job_id', job],
      ['generation', ledgerSubscript(item, 'generation')],
      [
        'attempt',
        item.get('attempt') === undefined ? JsonNumber.int(0) : ledgerSubscript(item, 'attempt'),
      ],
      ['state', ledgerSubscript(item, 'state')],
      [
        'failures',
        item.get('family_failures') === undefined
          ? JsonNumber.int(0)
          : ledgerSubscript(item, 'family_failures'),
      ],
      ['next_eligible_at', item.get('not_before') ?? null],
      ['reason', reason],
    ]);
    const key = `job:${job}:${ledgerDigestOf(payload)}`;
    const prior = queue.get('backfill_state_events');
    if (prior !== undefined && !(prior instanceof JsonObject))
      throw new LedgerIntegrityError('invalid backfill state events');
    const events = prior ?? new JsonObject([]);
    if (pythonTruthy(events.get(key))) return queue;
    let value = (await outbox.retained()).find(
      (v) => v instanceof JsonObject && v.get('source_key') === key,
    );
    if (value === undefined) {
      if (typeof at !== 'string') throw new LedgerIntegrityError('invalid created_at');
      value = ledgerEvent('job-state', key, at, payload);
    }
    await outbox.spool(value);
    const id = ledgerSubscript(value, 'id');
    return withObjectKeys(queue, [['backfill_state_events', withObjectKeys(events, [[key, id]])]]);
  };
}
