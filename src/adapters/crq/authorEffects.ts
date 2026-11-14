/**
 * Author capability effects: queue state, snapshot install, audit and status.
 *
 * Enrollment is the only durable write. The fallback decision persists before
 * the response; a status/status replay never writes. The status document is
 * regenerated through the existing writer adapter rather than re-derived here.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonObject } from '../../policy/crq/jsonValue.js';
import { parseJsonValue } from '../../policy/crq/jsonValue.js';
import { currentEntryEnv } from '../../config/run-env.js';
import { pythonJsonText } from '../../policy/crq/pythonJson.js';
import type { AuthorBinding } from '../../policy/crq/authorWire.js';
import type { AuthorCapabilityEffects } from '../../ops/crq/authorCapability.js';
import { loadQueueDocument, queueBytes, queueEffectPaths } from './queueEffects.js';
import { atomicWrite } from './atomic.js';
import { withLock } from './lock.js';
import { SlotBusyError } from '../lock/slotLock.js';
import { GitPool } from './gitExec.js';
import { installAuthorSnapshot } from './authorSnapshotInstall.js';
import { runStatusWriter } from './statusWriter.js';
import type { StatusStateRoots } from './statusSource.js';
import type { SummaryStateRoots } from './summarySource.js';

export interface AuthorEffectsOptions {
  readonly root: string;
  readonly config: JsonObject;
  readonly pool: GitPool;
  readonly now?: () => Date;
}

export interface AuthorEffectsBundle {
  readonly effects: AuthorCapabilityEffects;
  readonly terminate: () => void;
}

export function createAuthorEffects(options: AuthorEffectsOptions): AuthorEffectsBundle {
  const clock = options.now ?? (() => new Date());
  const paths = queueEffectPaths(options.root);
  const state = paths.stateRoot;
  const clone = options.config.get('clone');
  if (typeof clone !== 'string' || clone.length === 0) {
    throw new Error('runner clone is not configured');
  }
  const env = currentEntryEnv();
  const roots: StatusStateRoots & SummaryStateRoots = {
    runnerRoot: options.root,
    stateRoot: state,
    xdgStateHome: env['XDG_STATE_HOME'] ?? '',
    home: env['HOME'] ?? '',
  };
  const effects: AuthorCapabilityEffects = {
    nowIso: () => `${clock().toISOString().slice(0, 19)}Z`,
    loadQueue: () => loadQueueDocument(paths.queuePath),
    async saveQueue(queue) {
      await atomicWrite(paths.queuePath, queueBytes(queue));
    },
    async withQueueLock(work) {
      try {
        return await withLock(join(state, 'tick.lock'), { wait: false }, work);
      } catch (error) {
        if (error instanceof SlotBusyError) return null;
        throw error;
      }
    },
    async readPolicy(path) {
      const parsed = parseJsonValue(await readFile(path, 'utf8'), { duplicates: 'error' });
      if (!(parsed instanceof JsonObject)) throw new Error('review policy must be an object');
      return parsed;
    },
    async installSnapshot(binding: AuthorBinding, snapshot: JsonObject) {
      await installAuthorSnapshot({
        pool: options.pool,
        clone,
        snapshot,
        binding: { base: binding.base, head: binding.head },
        original: false,
      });
    },
    async audit(kind, data) {
      await mkdir(state, { recursive: true });
      const line = pythonJsonText(
        new JsonObject([
          ['at', `${clock().toISOString().slice(0, 19)}Z`],
          ['event', kind],
          ...data.entries,
        ]),
        {
          asciiOnly: true,
          sortKeys: false,
          spacedSeparators: true,
          trailingNewline: true,
        },
      );
      await appendFile(join(state, 'events.jsonl'), line);
    },
    async writeStatus() {
      const code = await runStatusWriter(
        roots,
        { write: () => undefined, error: () => undefined },
        () => clock().getTime() / 1000,
      );
      if (code !== 0) throw new Error('status write refused');
    },
  };
  return { effects, terminate: () => options.pool.killAll() };
}
