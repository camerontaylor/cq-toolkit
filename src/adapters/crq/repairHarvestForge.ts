/**
 * The three repair-harvest effects that were still injected, bound for the offline
 * differential and nothing else. Inactive: nothing imports this from a runtime entry point,
 * it is not composed into the tick and nothing routes to it.
 *
 * - {@link ghCreateRepairPr}: `c.run(['gh', 'pr', 'create', '--repo', REPO, '--base', BASE,
 *   '--head', branch, '--title', ..., '--body-file', path])` (`repair_tick.py:927`). `c.run`
 *   is `subprocess.run(..., text=True, timeout=600)` in the process cwd with the inherited
 *   environment, then `RuntimeError("<first six argv words> … exit N: <stderr stripped,
 *   400 code points>")` on a non-zero exit. A time bound is `OSError` (Python's
 *   `TimeoutExpired` and `FileNotFoundError` are not `RuntimeError`), so the backfill slot
 *   reserved before the create stays taken, exactly as in Python.
 * - {@link fileRepairNewItem}: `c.new_item(q, [], False, **fields)`, the in-memory enroll
 *   (`publicationEnroll.ts`) plus the `events.jsonl` line (`enrolledEvent.ts`), both read
 *   from one injected clock. Python reads the clock twice (the note, then the event).
 * - {@link fileRepairSaveQueue}: `c.save_queue(q)` with the admission-history compaction log
 *   (`crq.py:294-302`): after the atomic write, one `admission compaction v1: before_bytes=N
 *   after_bytes=M` line on stderr, only when a load recorded a pending compaction, the
 *   document carries the version marker, and the queue file is still the one that load saw.
 *
 * Still unbound, and said plainly: nothing here loads the queue. The TS loader refuses a
 * queue that needs compaction (`queueEffects.ts`), so no caller records a pending identity
 * today; {@link QueueCompaction.note} is the seam a future loader would call. The forge
 * reads stay in `publicationForgeReads.ts`.
 *
 * Not modelled, and pinned as such: on a retained-number queue a live item whose `order` is a
 * float (`3.0`, `1e2`) makes {@link fileRepairNewItem} throw the unmapped `unsupported item
 * order representation` (`publicationEnroll.ts`), where Python enrolls with a float `order`;
 * likewise a float `item.pr` on an `open_pr` publication throws `unsupported PR number
 * representation` (`publicationFinalize.ts`). Python's own writers only write integers, so
 * only a hand-edited queue reaches either; do not assume full parity there.
 */
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pyStrip } from '../../ops/crq/deploy/gitGuards.js';
import { pyRepr } from '../../ops/crq/deploy/rollbackRecover.js';
import { makeGhRunner, type GhFn } from '../forge-github/gh.js';
import { JsonNumber } from '../../policy/crq/jsonValue.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import { publicationNewItem } from '../../queue-runner/publicationEnroll.js';
import type { PublicationFinalizeEffects } from '../../queue-runner/publicationFinalize.js';
import { fileEnrolledEvent } from './enrolledEvent.js';
import { clip } from './publicationGitReads.js';
import { filePublicationEffects } from './publicationFiles.js';

type Rec = Record<string, unknown>;

/** `crq.run`'s default `timeout=600`. */
const RUN_TIMEOUT_MS = 600_000;
/** `admission_history.VERSION` and `MARKER`. */
const ADMISSION_VERSION = 1;
const ADMISSION_MARKER = 'backfill_admission_history_version';

export interface GhCreateRepairPrOptions {
  /** `c.REPO`, `owner/name`. */
  readonly repo: string;
  /** The runner; absent builds the real `gh` with `c.run`'s 600 s bound. */
  readonly gh?: GhFn;
}

/** The `gh pr create` binding: a non-zero exit is `RuntimeError`, a bound or missing binary `OSError`. */
export function ghCreateRepairPr(
  options: GhCreateRepairPrOptions,
): PublicationFinalizeEffects['createPr'] {
  const gh = options.gh ?? makeGhRunner({ timeoutMs: RUN_TIMEOUT_MS });
  return async (request) => {
    const args = [
      'pr',
      'create',
      '--repo',
      options.repo,
      '--base',
      request.base,
      '--head',
      request.head,
      '--title',
      request.title,
      '--body-file',
      request.bodyFile,
    ];
    const argv = ['gh', ...args];
    const result = await gh(args);
    if (result.code === 124 && result.stderr.endsWith(`gh timed out after ${RUN_TIMEOUT_MS}ms`)) {
      throw new PyError(
        'OSError',
        `Command '${pyRepr(argv)}' timed out after ${RUN_TIMEOUT_MS / 1000} seconds`,
      );
    }
    if (result.code === 127)
      throw new PyError('OSError', "[Errno 2] No such file or directory: 'gh'");
    if (result.code !== 0) {
      const stderr = pyStrip(result.stderr.replace(/\r\n?/g, '\n'));
      throw new PyError(
        'RuntimeError',
        `${argv.slice(0, 6).join(' ')} … exit ${String(result.code)}: ${clip(stderr, 400)}`,
      );
    }
  };
}

export interface FileRepairNewItemOptions {
  /** `c.STATE`. */
  readonly stateRoot: string;
  /** The clock; absent is the real one. */
  readonly now?: () => Date;
}

/** `c.new_item(q, [], False, **fields)` against `events.jsonl` under `stateRoot`. */
export function fileRepairNewItem(
  options: FileRepairNewItemOptions,
): PublicationFinalizeEffects['newItem'] {
  const now = options.now ?? (() => new Date());
  const event = fileEnrolledEvent({ stateRoot: options.stateRoot, now });
  return publicationNewItem({
    iso: () => `${now().toISOString().slice(0, 19)}Z`,
    event,
  });
}

/** `crq.queue_identity()`: the resolved path, device, inode, size and mtime in ns. */
export interface QueueIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

export async function queueIdentity(queuePath: string): Promise<QueueIdentity> {
  const info = await stat(queuePath, { bigint: true });
  return {
    path: resolve(queuePath),
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
  };
}

const sameIdentity = (a: QueueIdentity, b: QueueIdentity): boolean =>
  a.path === b.path &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs;

/** `crq._pending_admission_compaction`: one tracker per process, like the Python global. */
export class QueueCompaction {
  pending: QueueIdentity | null = null;

  /** `load_queue` found the document needed compaction: remember which file it read. */
  note(identity: QueueIdentity): void {
    this.pending = identity;
  }
}

/** CPython's `type(value).__name__` for a decoded JSON value. */
function pyTypeName(value: unknown): string {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'bigint') return 'int';
  if (value instanceof JsonNumber) return value.kind === 'int' ? 'int' : 'float';
  return typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float') : 'dict';
}

/** `q.get(MARKER) == VERSION`: Python's `1 == True == 1.0`, and an AttributeError off a dict. */
function markerMatches(q: unknown): boolean {
  if (typeof q !== 'object' || q === null || Array.isArray(q))
    throw new PyError('AttributeError', `'${pyTypeName(q)}' object has no attribute 'get'`);
  const value = (q as Rec)[ADMISSION_MARKER];
  if (value === true) return ADMISSION_VERSION === 1;
  if (typeof value === 'number') return value === ADMISSION_VERSION;
  if (typeof value === 'bigint') return value === BigInt(ADMISSION_VERSION);
  if (value instanceof JsonNumber)
    return value.kind === 'int'
      ? value.integer === BigInt(ADMISSION_VERSION)
      : value.float === ADMISSION_VERSION;
  return false;
}

export interface FileRepairSaveQueueOptions {
  /** `c.STATE`. */
  readonly stateRoot: string;
  readonly compaction: QueueCompaction;
  /** `sys.stderr`. */
  readonly stderr: (text: string) => void;
}

/** `c.save_queue(q)`. */
export function fileRepairSaveQueue(
  options: FileRepairSaveQueueOptions,
): (q: Rec) => Promise<void> {
  const files = filePublicationEffects({ stateRoot: options.stateRoot });
  const queuePath = resolve(options.stateRoot, 'queue.json');
  return async (q) => {
    const pending = options.compaction.pending;
    let log = false;
    if (pending !== null && markerMatches(q)) {
      const exists = await stat(queuePath).then(
        () => true,
        () => false,
      );
      log = exists && sameIdentity(await queueIdentity(queuePath), pending);
    }
    await files.saveQueue(q);
    options.compaction.pending = null;
    if (log) {
      const after = (await stat(queuePath, { bigint: true })).size;
      options.stderr(
        `admission compaction v${ADMISSION_VERSION}: before_bytes=${pending!.size} after_bytes=${after}\n`,
      );
    }
  };
}
