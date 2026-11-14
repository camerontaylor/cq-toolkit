import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { atomicWrite } from './atomic.js';
import { withLock } from './lock.js';
import { queueBytes } from './queueEffects.js';
import { loadInventoryQueue } from './backfillQueueLoad.js';
import { parsePublisherSpool } from './publisherSpool.js';
import { SlotBusyError } from '../lock/slotLock.js';
import { Outbox, type OutboxFiles } from '../../ops/review/internal/crq/outbox.js';
import type {
  InventoryTransactionEffects,
  PreparedInventory,
} from '../../ops/crq/backfillTransaction.js';
import { JsonNumber, JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import {
  ledgerCanonicalBytes,
  ledgerDigestOf,
  ledgerEvent,
  ledgerLoads,
  ledgerSubscript,
  pythonTruthy,
  LedgerIntegrityError,
} from '../../policy/crq/ledger.js';
import { withObjectKeys } from '../../policy/crq/queueDoc.js';

async function optional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function outboxFiles(root: string): OutboxFiles {
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
    readPending: (id) => optional(join(pending, `${id}.json`)),
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

async function settings(stateRoot: string): Promise<JsonObject | null> {
  const bytes = await optional(join(stateRoot, 'backfill-rollout.json'));
  if (bytes === null) return null;
  const value = ledgerLoads(bytes);
  const required = [
    'operational_ruling',
    'no_live_run_verification',
    'owner_branch_ruleset_evidence',
    'durable_artifact_root',
    'runner_identity',
    'publisher_spool',
  ];
  if (
    !(value instanceof JsonObject) ||
    required.some((key) => !pythonTruthy(value.get(key))) ||
    value.get('runner_identity') !== 'crq-runner-app'
  )
    throw new LedgerIntegrityError('backfill rollout prerequisites incomplete');
  parsePublisherSpool(value.get('publisher_spool'));
  return value;
}

/** Live transaction effects. Preparation remains caller-owned and runs outside tick.lock. */
export function createBackfillTransactionEffects(options: {
  readonly stateRoot: string;
  readonly prepare: (queue: JsonObject, enqueue: boolean) => Promise<PreparedInventory>;
}): InventoryTransactionEffects {
  const root = options.stateRoot;
  const backfill = join(root, 'backfill');
  const outbox = new Outbox(outboxFiles(join(backfill, 'publication')), {
    async verify() {
      throw new LedgerIntegrityError('unexpected state event artifact');
    },
  });
  return {
    clock: () => performance.now() / 1000,
    async withLock(waitSeconds, action) {
      const deadline = performance.now() + waitSeconds * 1000;
      for (;;) {
        let entered = false;
        try {
          return await withLock(join(root, 'tick.lock'), { wait: false }, async () => {
            entered = true;
            return action();
          });
        } catch (error) {
          if (entered || !(error instanceof SlotBusyError)) throw error;
          const remaining = deadline - performance.now();
          if (remaining <= 0) return null;
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)));
        }
      }
    },
    loadQueue: () => loadInventoryQueue(join(root, 'queue.json')),
    settings: () => settings(root),
    prepare: options.prepare,
    async stateEvent(queue, item) {
      const at = ledgerSubscript(item, 'created_at');
      const config = await settings(root);
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
        ['reason', 'inventory enqueue'],
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
      return withObjectKeys(queue, [
        ['backfill_state_events', withObjectKeys(events, [[key, id]])],
      ]);
    },
    async writeRanked(value) {
      await mkdir(backfill, { recursive: true });
      await atomicWrite(
        join(backfill, 'latest-ranked.json'),
        ledgerCanonicalBytes(value as JsonValue),
      );
    },
    async writeReport(value) {
      await mkdir(backfill, { recursive: true });
      await atomicWrite(
        join(backfill, 'latest-report.json'),
        ledgerCanonicalBytes(value as JsonValue),
      );
    },
    clearHalt(queue) {
      return queue.get('backfill_halt_operation') === 'inventory'
        ? new JsonObject(
            queue.entries.filter(
              ([key]) => key !== 'backfill_halted' && key !== 'backfill_halt_operation',
            ),
          )
        : queue;
    },
    saveQueue: (queue) => atomicWrite(join(root, 'queue.json'), queueBytes(queue)),
  };
}
