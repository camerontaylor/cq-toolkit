import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backfillCountedArtifactReader,
  backfillCountedEffects,
  deferredArtifactStore,
} from '../../../src/adapters/crq/backfillCountedEffects.js';
import {
  fileArtifactStore,
  fileFindingPublication,
} from '../../../src/adapters/crq/findingStore.js';
import { harvestBackfillCounted } from '../../../src/ops/crq/internal/backfillHarvestCounted.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { completionEvent, type BackfillRepo } from '../../../src/policy/crq/backfillCompletion.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
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

const scratch = () => mkdtemp(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'counted-adapter-'));
const metaJson = (c: JsonObject) =>
  JSON.stringify({
    run_id: 'r',
    item_id: 'j',
    backfill: { attempt_id: 'a' },
    ...Object.fromEntries(
      sub(c, 'meta')
        .entries.filter(([k]) => !['run_id', 'item_id', 'backfill'].includes(k))
        .map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]),
    ),
  });

async function stage(c: JsonObject, root: string, submission?: string) {
  const dir = join(root, 'state', 'runs', 'r');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'meta.json'), metaJson(c));
  await writeFile(
    join(dir, 'exit.json'),
    `{"exit":0,"ended_at":${JSON.stringify(c.get('ended_at'))}}`,
  );
  await writeFile(join(dir, 'review.ndjson'), rawOf(c));
  if (submission !== undefined) await writeFile(join(dir, 'submission.json'), submission);
  return dir;
}

describe('counted backfill artifact reader', () => {
  it('reads run files, treats submission.json as optional and refuses escapes', async () => {
    const root = await scratch();
    try {
      const dir = await stage(good, root);
      const read = backfillCountedArtifactReader(join(root, 'state'));
      expect((await read('r')).submission).toBeNull();
      await writeFile(join(dir, 'submission.json'), '{}');
      expect(Buffer.from((await read('r')).submission as Uint8Array).toString()).toBe('{}');
      await expect(read('..')).rejects.toThrow('invalid run id');
      await mkdir(join(root, 'elsewhere'));
      await symlink(join(root, 'elsewhere'), join(root, 'state', 'runs', 'link'));
      await expect(read('link')).rejects.toThrow('escapes');
      await rm(join(dir, 'exit.json'));
      await expect(read('r')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('deferred artifact store', () => {
  it('returns the real store reference and writes only on flush', async () => {
    const root = await scratch();
    try {
      const store = fileArtifactStore(join(root, 'durable'));
      const deferred = deferredArtifactStore({ durableRoot: join(root, 'durable'), store });
      const bytes = enc.encode('hello');
      const reference = deferred.put(bytes) as JsonObject;
      await expect(readdir(join(root, 'durable', 'sha256'))).rejects.toThrow();
      await deferred.flush();
      await store.verify({
        sha256: reference.get('sha256') as string,
        location: reference.get('location') as string,
      });
      await deferred.flush();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a store whose reference differs from the one already given out', async () => {
    const root = await scratch();
    try {
      const real = fileArtifactStore(join(root, 'durable'));
      const lying = {
        ...real,
        put: async (b: Uint8Array) => ({ ...(await real.put(b)), location: '/else' }),
      };
      const deferred = deferredArtifactStore({ durableRoot: join(root, 'durable'), store: lying });
      deferred.put(enc.encode('x'));
      await expect(deferred.flush()).rejects.toThrow('differs');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('counted harvest over real file seams', () => {
  it('retains every artifact before the outbox verifies the event', async () => {
    const root = await scratch();
    try {
      await stage(good, root);
      const store = fileArtifactStore(join(root, 'durable'));
      const publication = fileFindingPublication({
        root: join(root, 'state', 'pub'),
        artifacts: store,
      });
      const ingested: JsonValue[] = [];
      const effects = backfillCountedEffects({
        stateRoot: join(root, 'state'),
        durableRoot: join(root, 'durable'),
        store,
        repo: repoOf(sub(good, 'repo')),
        publication,
        inbox: { ingest: async (v) => void ingested.push(v) },
        stateEvent: async (q) => q,
        saveQueue: async () => undefined,
        cleanup: async () => undefined,
      });
      const result = await harvestBackfillCounted(
        queueOf(harvestable(good)),
        0,
        proof,
        effects,
        counted,
      );
      expect(result.status).toBe('completed');
      const retained = (await publication.retained()) as JsonObject[];
      expect(retained).toHaveLength(1);
      expect(ingested).toHaveLength(1);
      expect((retained[0] as JsonObject).get('id')).toBe(
        (result.queue.get('items') as JsonObject[])[0]?.get('publication_event_id'),
      );
      const written = await readdir(join(root, 'state', 'runs', 'r'));
      expect(written).toContain('review-event.json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains the evidence even when scope is unverifiable', async () => {
    const root = await scratch();
    try {
      await stage(bad, root);
      const store = fileArtifactStore(join(root, 'durable'));
      const effects = backfillCountedEffects({
        stateRoot: join(root, 'state'),
        durableRoot: join(root, 'durable'),
        store,
        repo: repoOf(sub(bad, 'repo')),
        publication: { spool: async () => 'x' },
        inbox: { ingest: async () => undefined },
        stateEvent: async (q) => q,
        saveQueue: async () => undefined,
        cleanup: async () => undefined,
      });
      const result = await harvestBackfillCounted(
        queueOf(harvestable(bad)),
        0,
        proof,
        effects,
        counted,
      );
      expect(result.status).toBe('unsupported');
      expect((await readdir(join(root, 'durable', 'sha256'))).length).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
