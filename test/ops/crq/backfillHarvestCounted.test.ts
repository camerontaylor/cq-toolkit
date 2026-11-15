import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { completionEvent, type BackfillRepo } from '../../../src/policy/crq/backfillCompletion.js';
import {
  harvestBackfillCounted,
  type BackfillCountedHarvestEffects,
} from '../../../src/ops/crq/internal/backfillHarvestCounted.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { ledgerDigestOf } from '../../../src/policy/crq/ledger.js';
import { withObjectKeys } from '../../../src/policy/crq/queueDoc.js';

const cases = parseJsonValue(
  readFileSync(
    new URL('../../fixtures/differential/completion_event.json', import.meta.url),
    'utf8',
  ),
) as JsonObject[];
const enc = new TextEncoder();
const ref = (bytes: Uint8Array): JsonValue => {
  const id = createHash('sha256').update(bytes).digest('hex');
  return new JsonObject([
    ['sha256', id],
    ['location', `/store/${id}`],
  ]);
};
const table = (v: JsonValue | undefined) =>
  new Map([...(v as JsonObject).entries].map(([k, b]) => [k, { blob: b as string }]));
const repoOf = (spec: JsonObject): BackfillRepo => {
  const f = (k: string) => spec.get(k) as JsonValue;
  return {
    entries: (rev) => table(rev === f('head') ? f('head_entries') : f('target_entries')),
    changedIntervals: () =>
      new Map(
        [...(f('changed') as JsonObject).entries].map(([k, l]) => [
          k,
          new Set((l as JsonNumber[]).map((n) => Number(n.integer))),
        ]),
      ),
    changedPaths: () => f('paths') as string[],
    retain: (target, revs) => {
      if (revs.some((r) => typeof r !== 'string'))
        throw Object.assign(new Error('unorderable'), { pythonError: 'TypeError' });
      return target.put(enc.encode(`bundle:${revs.join(' ')}`));
    },
    verifyReview: () => undefined,
  };
};
const sub = (c: JsonObject, k: string) => c.get(k) as JsonObject;
const rawOf = (c: JsonObject) => Buffer.from(c.get('raw_b64') as string, 'base64');

const harvestable = (c: JsonObject, head?: string): JsonObject =>
  withObjectKeys(sub(c, 'item'), [
    ['id', 'j'],
    ['kind', 'backfill'],
    ['state', 'reviewing'],
    ['vendor_state', 'live'],
    ['family', 'f'],
    ['attempt_id', 'a'],
    [
      'run',
      new JsonObject([
        ['run_id', 'r'],
        ['band', 'background'],
      ]),
    ],
    ...(head ? ([['head', head]] as [string, JsonValue][]) : []),
  ]);
const queueOf = (item: JsonObject) =>
  new JsonObject([
    ['items', [item]],
    [
      'backfill_reservations',
      new JsonObject([
        [
          'a',
          new JsonObject([
            ['item', 'j'],
            ['vendor_run_id', 'r'],
          ]),
        ],
      ]),
    ],
  ]);
const metaOf = (c: JsonObject): JsonObject =>
  withObjectKeys(sub(c, 'meta'), [
    ['run_id', 'r'],
    ['item_id', 'j'],
    ['backfill', new JsonObject([['attempt_id', 'a']])],
  ]);
const proof = { runId: 'r', exitCode: 0, terminalVerified: true } as const;
const counted = new JsonObject([
  ['counted', true],
  ['outcome', 'completed'],
]);

const outcomeOf = (c: JsonObject): string => {
  if (c.get('submission') !== null && c.has('submission')) return 'skip';
  try {
    completionEvent(
      repoOf(sub(c, 'repo')),
      { put: ref },
      harvestable(c),
      rawOf(c),
      c.get('exit_code') as JsonValue,
      metaOf(c),
      c.get('ended_at') as string,
      null,
    );
    return 'ok';
  } catch (error) {
    return String((error as { pythonError?: unknown }).pythonError);
  }
};
const good = cases.find((c) => outcomeOf(c) === 'ok') as JsonObject;
const bad = cases.find(
  (c) =>
    outcomeOf(c) === 'IntegrityError' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(String(c.get('ended_at'))),
) as JsonObject;

function fixture(c: JsonObject, submission: Uint8Array | null = null) {
  const log: string[] = [];
  const out: { event?: JsonObject; saved?: JsonObject; bytes?: Uint8Array } = {};
  const effects: BackfillCountedHarvestEffects = {
    readArtifacts: async () => ({
      meta: enc.encode(
        JSON.stringify(
          Object.fromEntries(
            metaOf(c).entries.map(([k, v]) => [
              k,
              v instanceof JsonObject ? Object.fromEntries(v.entries) : v,
            ]),
          ),
        ),
      ),
      exit: enc.encode(`{"exit":0,"ended_at":${JSON.stringify(c.get('ended_at'))}}`),
      review: rawOf(c),
      submission,
    }),
    put: (bytes) => {
      log.push('put');
      return ref(bytes);
    },
    repo: repoOf(sub(c, 'repo')),
    writeReviewEvent: async (_run, bytes) => {
      log.push('write');
      out.bytes = bytes;
    },
    spool: async (event) => {
      log.push('spool');
      out.event = event;
    },
    ingest: async () => {
      log.push('ingest');
    },
    stateEvent: async (q) => {
      log.push('state');
      return q;
    },
    saveQueue: async (q) => {
      log.push('save');
      out.saved = q;
    },
    cleanup: async () => {
      log.push('cleanup');
    },
  };
  return { effects, log, out };
}

describe('counted backfill harvest', () => {
  it('publishes a digest-bound review event, then completes the item', async () => {
    const { effects, log, out } = fixture(good);
    const result = await harvestBackfillCounted(
      queueOf(harvestable(good)),
      0,
      proof,
      effects,
      counted,
    );
    expect(result.status).toBe('completed');
    const event = out.event as JsonObject;
    const stripped = new JsonObject(event.entries.filter(([k]) => k !== 'id'));
    expect(event.get('id')).toBe(ledgerDigestOf(stripped));
    const refs = (event.get('payload') as JsonObject).get('artifacts') as JsonObject[];
    expect(refs[refs.length - 1]?.get('sha256')).toBe(
      createHash('sha256')
        .update(await effects.readArtifacts('r').then((a) => a.exit))
        .digest('hex'),
    );
    // Spool before the item turns publication-pending; ingest after; save last.
    expect(log.slice(log.indexOf('write'))).toEqual([
      'write',
      'spool',
      'ingest',
      'state',
      'save',
      'cleanup',
    ]);
    const item = (result.queue.get('items') as JsonObject[])[0] as JsonObject;
    expect(item.get('state')).toBe('publication-pending');
    expect(item.get('publication_event_id')).toBe(event.get('id'));
    const day = (good.get('ended_at') as string).slice(0, 10);
    const row = (result.queue.get('backfill_daily_capacity') as JsonObject).get(day) as JsonObject;
    expect(row.get('completed_partitions')).toEqual(JsonNumber.int(1));
    expect(result.queue.get('backfill_capacity_runs')).toEqual(['r']);
  });

  it('quarantines unverifiable scope as unsupported, publishing nothing', async () => {
    const { effects, log, out } = fixture(bad);
    const result = await harvestBackfillCounted(
      queueOf(harvestable(bad)),
      0,
      proof,
      effects,
      counted,
    );
    expect(result.status).toBe('unsupported');
    expect(out.event).toBeUndefined();
    expect(log).not.toContain('spool');
    expect(log).not.toContain('ingest');
    expect(log.slice(-3)).toEqual(['state', 'save', 'cleanup']);
    const item = (result.queue.get('items') as JsonObject[])[0] as JsonObject;
    expect(item.get('state')).toBe('quarantined');
    expect(result.queue.get('backfill_capacity_runs')).toBeUndefined();
  });

  it('lets a non-value error (TypeError) escape instead of quarantining', async () => {
    const { effects } = fixture(good);
    const broken: BackfillCountedHarvestEffects = {
      ...effects,
      repo: {
        ...effects.repo,
        retain: () => {
          throw Object.assign(new Error('unorderable'), { pythonError: 'TypeError' });
        },
      },
    };
    await expect(
      harvestBackfillCounted(queueOf(harvestable(good)), 0, proof, broken, counted),
    ).rejects.toThrow('unorderable');
  });

  it('refuses unowned terminal, a wrong exit code and an uncounted classification', async () => {
    const { effects } = fixture(good);
    const q = queueOf(harvestable(good));
    await expect(
      harvestBackfillCounted(q, 0, { ...proof, runId: 'x' }, effects, counted),
    ).rejects.toThrow('ownership not verified');
    await expect(
      harvestBackfillCounted(q, 0, { ...proof, exitCode: 1 }, effects, counted),
    ).rejects.toThrow('identity mismatch');
    await expect(
      harvestBackfillCounted(q, 0, proof, effects, withObjectKeys(counted, [['counted', false]])),
    ).rejects.toThrow('needs a counted');
  });
});
