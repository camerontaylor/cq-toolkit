import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type {
  BackfillCountedArtifacts,
  BackfillCountedHarvestEffects,
} from '../../ops/crq/internal/backfillHarvestCounted.js';
import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { LedgerIntegrityError } from '../../policy/crq/ledger.js';
import { atomicWrite } from './atomic.js';
import { artifactLocation, type ArtifactStore } from './findingStore.js';

/** Existing run artifacts only. `submission.json` is optional; the rest must exist. */
export function backfillCountedArtifactReader(
  stateRoot: string,
): (runId: string) => Promise<BackfillCountedArtifacts> {
  return async (runId) => {
    if (!runId || runId === '.' || runId === '..' || /[/\\\0]/.test(runId))
      throw new LedgerIntegrityError('invalid run id');
    const root = await realpath(join(stateRoot, 'runs'));
    const dir = await realpath(join(root, runId));
    if (relative(root, dir) !== runId)
      throw new LedgerIntegrityError('run directory escapes its identity');
    const read = async (name: string, optional: boolean): Promise<Uint8Array | null> => {
      let path: string;
      try {
        path = await realpath(join(dir, name));
      } catch (error) {
        if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      const rel = relative(dir, path);
      if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || rel.includes(sep))
        throw new LedgerIntegrityError('run artifact escapes run directory');
      return new Uint8Array(await readFile(path));
    };
    return {
      meta: (await read('meta.json', false)) as Uint8Array,
      exit: (await read('exit.json', false)) as Uint8Array,
      review: (await read('review.ndjson', false)) as Uint8Array,
      submission: await read('submission.json', true),
    };
  };
}

/**
 * `completionEvent` is synchronous but the durable store is not. `put` returns
 * the reference the real store will give (digest and path are functions of the
 * bytes) and queues the write; `flush` performs the writes and refuses any
 * reference the store disagrees with.
 */
export function deferredArtifactStore(input: { durableRoot: string; store: ArtifactStore }) {
  let pending: Array<{ bytes: Uint8Array; sha256: string; location: string }> = [];
  return {
    put(bytes: Uint8Array): JsonValue {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const location = artifactLocation(input.durableRoot, sha256);
      pending.push({ bytes: new Uint8Array(bytes), sha256, location });
      return new JsonObject([
        ['sha256', sha256],
        ['location', location],
      ]);
    },
    async flush(): Promise<void> {
      const rows = pending;
      pending = [];
      for (const row of rows) {
        const stored = await input.store.put(row.bytes);
        if (stored.sha256 !== row.sha256 || stored.location !== row.location)
          throw new LedgerIntegrityError('artifact store reference differs from the event');
      }
    },
  };
}

/** Compose the counted-harvest effects from real file seams. Git stays injected. */
export function backfillCountedEffects(input: {
  stateRoot: string;
  durableRoot: string;
  store: ArtifactStore;
  repo: BackfillCountedHarvestEffects['repo'];
  publication: { spool(value: JsonValue): Promise<string> };
  inbox: { ingest(value: JsonValue): Promise<unknown> };
  stateEvent: BackfillCountedHarvestEffects['stateEvent'];
  saveQueue: BackfillCountedHarvestEffects['saveQueue'];
  cleanup: BackfillCountedHarvestEffects['cleanup'];
}): BackfillCountedHarvestEffects {
  const deferred = deferredArtifactStore(input);
  const readArtifacts = backfillCountedArtifactReader(input.stateRoot);
  return {
    readArtifacts,
    put: (bytes) => deferred.put(bytes),
    repo: input.repo,
    // Retained bytes must exist before anything verifies or names them.
    writeReviewEvent: async (runId, bytes) => {
      await deferred.flush();
      await readArtifacts(runId);
      await atomicWrite(join(input.stateRoot, 'runs', runId, 'review-event.json'), bytes);
    },
    spool: async (event) => {
      await input.publication.spool(event);
    },
    ingest: async (event) => {
      await input.inbox.ingest(event);
    },
    stateEvent: async (queue, item, at, reason) => {
      await deferred.flush();
      return input.stateEvent(queue, item, at, reason);
    },
    saveQueue: input.saveQueue,
    cleanup: input.cleanup,
  };
}
