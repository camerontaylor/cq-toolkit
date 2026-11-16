/**
 * File-system effects for the queue-v1 capability.
 *
 * Every path here is derived from the runner's own configuration, never from a
 * request. The adapter is deliberately dumb: it performs the exact byte-level
 * operations the capability asks for (`queueTransport`'s counterparts in Python)
 * and owns no policy of its own.
 */
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './atomic.js';
import { withLock } from './lock.js';
import { SlotBusyError } from '../lock/slotLock.js';
import {
  hasExit as hasExitFile,
  readPidfile as readPidfileFile,
  runLiveness as runLivenessFile,
} from '../process/liveness.js';
import { makeGhRunner, ghJson, type GhFn } from '../forge-github/gh.js';
import { JsonNumber, JsonObject, parseJsonValue } from '../../policy/crq/jsonValue.js';
import { pythonJsonText, receiptJsonText } from '../../policy/crq/pythonJson.js';
import type { QueueCapabilityEffects } from '../../ops/crq/queueCapability.js';

/** `queue_transport.READ_SLOTS`. */
const READ_SLOTS = 2;
/** `queue_transport.FORGE_CACHE_TTL` (seconds). */
const FORGE_CACHE_TTL = 300;
/** `queue_transport.FORGE_CACHE_LIMIT`. */
const FORGE_CACHE_LIMIT = 128;

export interface QueueEffectsOptions {
  /** `crq.REPO`: the only repository this runner serves. */
  readonly repo: string;
  /** `<root>/state/queue.json`. */
  readonly queuePath: string;
  /** `<root>/state`: reconcile wrappers live under `reconcile/`. */
  readonly stateRoot: string;
  /** `<root>/runs`: detached run directories. */
  readonly runsRoot: string;
  /** `crq.STATE / "receipts"`: receipts, delivery journals and read slots. */
  readonly receiptRoot: string;
  /** `CONFIG.queue.project_fixed`. */
  readonly projectFixed?: boolean;
  /** The forge transport; defaults to the real `gh` subprocess. */
  readonly gh?: GhFn;
  /** Wall clock override for tests. */
  readonly now?: () => Date;
}

function refuse(message: string): never {
  throw new Error(message);
}

/** `crq.iso(t)`: whole seconds, UTC, trailing `Z`. */
export function isoUtc(now: Date): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

/** Read at most `limit` bytes; a short file returns fewer. */
async function readBounded(path: string, limit: number): Promise<Uint8Array> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    let offset = 0;
    while (offset < limit) {
      const { bytesRead } = await file.read(buffer, offset, limit - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return new Uint8Array(buffer.subarray(0, offset));
  } finally {
    await file.close();
  }
}

async function readJsonObject(path: string): Promise<JsonObject> {
  const text = await readFile(path, 'utf8');
  const parsed = parseJsonValue(text, { duplicates: 'error' });
  if (!(parsed instanceof JsonObject)) refuse(`invalid JSON object: ${path}`);
  return parsed;
}

/** The queue document, refusing one that still needs Python's compaction pass. */
export async function loadQueueDocument(path: string): Promise<JsonObject> {
  const queue = await readJsonObject(path);
  const version = queue.get('backfill_admission_history_version');
  const hasHistory = queue.has('backfill_admissions');
  const current = version instanceof JsonNumber && version.kind === 'int' && version.integer === 1n;
  if (hasHistory && !current) {
    refuse('queue admission history requires the Python runner compaction pass');
  }
  return queue;
}

/** `crq_repair.atomic`: `json.dump(indent=2)` plus a newline, ASCII escaped. */
export function queueBytes(queue: JsonObject): string {
  return pythonJsonText(queue, {
    asciiOnly: true,
    sortKeys: false,
    indent: 2,
    trailingNewline: true,
  });
}

async function readCache(path: string, nowSeconds: number): Promise<Record<string, number>> {
  let parsed: JsonObject;
  try {
    parsed = await readJsonObject(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const cache: Record<string, number> = {};
  for (const [key, value] of parsed.entries) {
    if (!(value instanceof JsonNumber) || value.kind !== 'float') continue;
    const stamp = value.float as number;
    if (nowSeconds - stamp >= 0 && nowSeconds - stamp < FORGE_CACHE_TTL) cache[key] = stamp;
  }
  return cache;
}

/** `crq.verify_deferred_source`: trusted forge identity for one enrolled PR. */
export async function verifyDeferredSource(
  gh: GhFn,
  repo: string,
  pr: number,
): Promise<JsonObject> {
  const payload = await ghJson<unknown>(gh, ['api', `repos/${repo}/pulls/${String(pr)}`]);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    refuse('missing forge PR metadata');
  }
  const data = payload as Record<string, unknown>;
  const base = (data.base ?? {}) as Record<string, unknown>;
  const head = (data.head ?? {}) as Record<string, unknown>;
  const user = (data.user ?? {}) as Record<string, unknown>;
  const baseRepo = (base.repo ?? {}) as Record<string, unknown>;
  const sha = head.sha;
  const merged = data.merged;
  if (
    baseRepo.full_name !== repo ||
    data.number !== pr ||
    typeof user.login !== 'string' ||
    user.login.length === 0 ||
    typeof sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(sha) ||
    typeof base.ref !== 'string' ||
    base.ref.length === 0 ||
    typeof merged !== 'boolean' ||
    (data.state !== 'open' && data.state !== 'closed') ||
    (merged && data.state !== 'closed')
  ) {
    refuse('invalid forge PR identity');
  }
  const merge = merged ? data.merge_commit_sha : null;
  if (merged && (typeof merge !== 'string' || !/^[0-9a-f]{40}$/.test(merge))) {
    refuse('missing immutable forge merge identity');
  }
  return new JsonObject([
    ['repo', repo],
    ['pr', JsonNumber.int(pr)],
    ['producer', user.login],
    ['head', sha],
    ['target', base.ref],
    ['state', merged ? 'MERGED' : String(data.state).toUpperCase()],
    ['mergeSha', typeof merge === 'string' ? merge : null],
  ]);
}

/** Build the capability effects bound to one runner's state. */
export function createQueueEffects(options: QueueEffectsOptions): QueueCapabilityEffects {
  const gh = options.gh ?? makeGhRunner();
  const clock = options.now ?? (() => new Date());
  const receiptPath = (receiptId: string): string => join(options.receiptRoot, `${receiptId}.json`);
  const journalDir = join(options.receiptRoot, 'deliveries');

  return {
    projectFixed: options.projectFixed === true,
    nowIso: () => isoUtc(clock()),
    nowMicros: () => BigInt(clock().getTime()) * 1000n,
    async queueGeneration() {
      const info = await stat(options.queuePath, { bigint: true });
      return [
        JsonNumber.int(info.dev),
        JsonNumber.int(info.ino),
        JsonNumber.int(info.size),
        JsonNumber.int(info.mtimeNs),
      ];
    },
    loadQueue: () => loadQueueDocument(options.queuePath),
    async saveQueue(queue) {
      await atomicWrite(options.queuePath, queueBytes(queue));
    },
    async withQueueLock(work) {
      try {
        return await withLock(join(options.stateRoot, 'tick.lock'), { wait: false }, work);
      } catch (error) {
        if (error instanceof SlotBusyError) return null;
        throw error;
      }
    },
    async withReadSlot(work) {
      await mkdir(options.receiptRoot, { recursive: true });
      for (let index = 0; index < READ_SLOTS; index += 1) {
        try {
          return await withLock(
            join(options.receiptRoot, `read-slot-${String(index)}.lock`),
            { wait: false },
            work,
          );
        } catch (error) {
          if (error instanceof SlotBusyError) continue;
          throw error;
        }
      }
      return null;
    },
    readReceipt: (receiptId, maxBytes) => readBounded(receiptPath(receiptId), maxBytes + 1),
    async receiptSize(receiptId) {
      const info = await stat(receiptPath(receiptId));
      return info.size;
    },
    async readJournal(key) {
      try {
        return await readJsonObject(join(journalDir, `${key}.json`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async updateJournal(key, update) {
      await mkdir(journalDir, { recursive: true });
      await withLock(join(journalDir, 'delivery.lock'), { wait: true }, async () => {
        let previous: JsonObject | null = null;
        try {
          previous = await readJsonObject(join(journalDir, `${key}.json`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await atomicWrite(join(journalDir, `${key}.json`), receiptJsonText(update(previous)));
      });
    },
    async withForgeCache(key, check) {
      await mkdir(options.receiptRoot, { recursive: true });
      const cachePath = join(options.receiptRoot, 'read-forge-cache.json');
      const lockPath = join(options.receiptRoot, 'read-forge-cache.lock');
      const cached = await withLock(lockPath, { wait: true }, async () =>
        Object.hasOwn(await readCache(cachePath, clock().getTime() / 1000), key),
      );
      if (cached) return;
      // Network latency must not hold the cache lock; concurrent misses may
      // fetch the same binding, and only a successful check is inserted.
      await check();
      await withLock(lockPath, { wait: true }, async () => {
        const nowSeconds = clock().getTime() / 1000;
        const cache = await readCache(cachePath, nowSeconds);
        if (Object.hasOwn(cache, key)) return;
        const keys = Object.keys(cache);
        if (keys.length >= FORGE_CACHE_LIMIT) {
          const oldest = keys.reduce((left, right) =>
            (cache[left] as number) <= (cache[right] as number) ? left : right,
          );
          delete cache[oldest];
        }
        const next = { ...cache, [key]: nowSeconds };
        await atomicWrite(cachePath, receiptJsonText(next));
      });
    },
    reconcilePath: (key) => join(options.stateRoot, 'reconcile', `${key}.json`),
    readReconcileWrapperText: (path) => readFile(path, 'utf8'),
    verifySource: (repo, pr) => verifyDeferredSource(gh, repo, pr),
    runDir: (runId) => join(options.runsRoot, runId),
    hasExit: (runDir) => hasExitFile(runDir),
    readPidfile: (runDir) => readPidfileFile(runDir),
    runLiveness: async (runDir, recorded) =>
      runLivenessFile(runDir, recorded, await hasExitFile(runDir)),
  };
}

/** Re-exported so the entrypoint and tests share one path convention. */
export function queueEffectPaths(root: string): {
  queuePath: string;
  stateRoot: string;
  runsRoot: string;
  receiptRoot: string;
} {
  const stateRoot = join(root, 'state');
  return {
    queuePath: join(stateRoot, 'queue.json'),
    stateRoot,
    runsRoot: join(root, 'runs'),
    receiptRoot: join(stateRoot, 'receipts'),
  };
}
