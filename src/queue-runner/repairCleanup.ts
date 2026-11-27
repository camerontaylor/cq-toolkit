/**
 * Eligibility decision for `crq_repair.retain.cleanup_harvested`
 * (apps/crq-python/crq_repair/retain.py:20-50), the post-terminal cleanup of a
 * harvested repair worktree.
 *
 * DECISION ONLY. The module never removes, writes or spawns anything: it asks
 * injected, read-only {@link RepairCleanupProbes} questions in Python's order
 * and answers with the worktree a caller MAY remove, or a typed refusal. The
 * caller owns `git worktree remove <worktree>` (cwd = CLONE) and, as in Python,
 * reports that command's exit status as the cleanup's outcome. Inactive:
 * nothing imports this outside tests. `fileRepairCleanup`
 * (src/adapters/crq/repairCleanupEffects.ts) binds `RepairHarvestEffects.cleanupHarvested`
 * over real probes, but it is not composed into the tick
 * (docs/crq/tick-slot-missing-effects.md).
 *
 * Policy mirrored from Python, including its quirks:
 *
 * - only `FIXED` and `NOT-FIXED` results are cleaned; a failed, stale or
 *   rejected result keeps its tree for recovery;
 * - the result's worktree is owned only as `crq-repair-<item>-<job>` or
 *   `crq-repair-<item>-<job>-A2` directly under the resolved `WT_ROOT`. The
 *   harvest validator (`repairHarvest.ts`) also accepts the legacy
 *   `crq-repair-<item>` name; cleanup does NOT, so a legacy tree is left alone;
 * - a symlinked raw worktree is refused before it is resolved;
 * - `alternate` retargets to the sibling: the `-A2` tree when the result names
 *   the base tree, the base tree when it names `-A2`. The test is a bare
 *   `endswith('-A2')`, so a job id that itself ends in `-A2` retargets to the
 *   same tree;
 * - `git status --porcelain --untracked-files=all --ignored` must exit 0 with
 *   no output, before HEAD is read;
 * - a retained snapshot (`**\/retained-*\/manifest.json` under the job
 *   directory) must carry the content-derived name `retained-<sha256 of the
 *   canonical manifest>`, the tree's HEAD, the result's `repair_base` (Python
 *   `==`, so `1` equals `1.0`) and a matching digest for each of the five
 *   archives. An unreadable or malformed snapshot is skipped, never fatal; any
 *   single valid snapshot is enough, so discovery order cannot change the
 *   answer.
 *
 * Numeric kind: `request.result.worktree` may be a `JsonNumber` (from
 * `toPlainJsonRetainingNumbers`) so an integral float such as `1.0` reports
 * `'float'` as Python does; a plain JS number reports `int` when integral.
 *
 * Failures Python lets escape `cleanup_harvested` (a non-string `worktree`, an
 * embedded NUL, a failed `git rev-parse`) propagate from here as `PyError`s so
 * the harvest's `except (OSError, ValueError, KeyError, TypeError,
 * RuntimeError, subprocess.TimeoutExpired)` records them as
 * `repair cleanup <job>: ...` messages. A timed-out `git status` is Python's
 * `TimeoutExpired` (1200 s) and this port's `PyError('OSError', 'git status did
 * not complete: ...')` (330 s); both are recorded, with different message text.
 */
import { posix } from 'node:path';

import {
  JsonNumber,
  JsonObject,
  type JsonValue,
  parseJsonValue,
  pythonNonFinite,
  toPlainJson,
} from '../policy/crq/jsonValue.js';
import { receiptJsonDigest } from '../policy/crq/pythonJson.js';
import { isPyError, PyError } from './pyErrors.js';
import { pyEq } from './repairBackfill.js';

type Rec = Record<string, unknown>;

/** The five archives `retain()` writes, in the order `cleanup_harvested` verifies them. */
export const RETAINED_ARCHIVES = [
  'staged.patch',
  'unstaged.patch',
  'committed.patch',
  'untracked.tar',
  'commits.bundle',
] as const;
export type RetainedArchive = (typeof RETAINED_ARCHIVES)[number];

/** One retained snapshot discovered under the job directory. */
export interface RetentionRecord {
  /** `manifest_path.parent.name`: `retained-<token>`. */
  readonly directoryName: string;
  /** `manifest.json` bytes; an unreadable file rejects with `PyError('OSError')`. */
  readManifest(): Promise<Uint8Array>;
  /** Hex SHA-256 of one sibling archive; an unreadable file rejects with `PyError('OSError')`. */
  archiveDigest(name: RetainedArchive): Promise<string>;
}

/** Read-only questions about the filesystem and Git, answered by a caller. */
export interface RepairCleanupProbes {
  /** `Path(path).resolve()` (non-strict). */
  resolve(path: string): Promise<string>;
  /** `Path(path).is_symlink()`. */
  isSymlink(path: string): Promise<boolean>;
  /** `Path(path).is_dir()` (follows symlinks). */
  isDirectory(path: string): Promise<boolean>;
  /**
   * `git status --porcelain --untracked-files=all --ignored` in `worktree`:
   * `failed` is a non-zero exit, `stdout` the captured text.
   */
  status(worktree: string): Promise<{ readonly failed: boolean; readonly stdout: string }>;
  /** `git rev-parse HEAD` in `worktree`, stripped; a failure is `PyError('RuntimeError')`. */
  head(worktree: string): Promise<string>;
  /** Every `<directory>/**\/retained-*\/manifest.json`, in any order. */
  retainedManifests(directory: string): Promise<readonly RetentionRecord[]>;
}

export interface RepairCleanupRequest {
  /** `c.WT_ROOT`. */
  readonly worktreeRoot: string;
  /** `c.STATE/repair/<job>`: where this job's retained snapshots live. */
  readonly directory: string;
  readonly itemId: string;
  readonly jobId: string;
  /** The harvest verdict (a result dict). */
  readonly result: Rec;
  readonly alternate: boolean;
}

export type RepairCleanupRefusal =
  /** The verdict is not `FIXED` or `NOT-FIXED`. */
  | 'verdict-not-cleanable'
  /** The raw worktree path is itself a symlink. */
  | 'worktree-symlink'
  /** The resolved worktree is not a job-owned tree directly under `WT_ROOT`. */
  | 'worktree-not-owned'
  /** The (possibly alternate) target is a symlink or not a directory. */
  | 'target-not-directory'
  /** `git status --ignored` failed or reported anything. */
  | 'worktree-dirty'
  /** No retained snapshot proves this exact HEAD and base are archived. */
  | 'no-matching-retention';

export type RepairCleanupDecision =
  | { readonly remove: true; readonly worktree: string }
  | { readonly remove: false; readonly reason: RepairCleanupRefusal };

const refuse = (reason: RepairCleanupRefusal): RepairCleanupDecision => ({ remove: false, reason });

/**
 * Python's name for the value's type, as used in `Path()`'s `TypeError`.
 *
 * A plain JS `number` cannot say whether it was `1` or `1.0` in the JSON, so an
 * integral one is reported as `int`. A caller that must distinguish them
 * (`1.0`, `1e21` are Python `float`) supplies the value as a `JsonNumber`, e.g.
 * via `toPlainJsonRetainingNumbers`, and its `kind` is used exactly.
 */
function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (value instanceof JsonNumber) return value.kind;
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'bigint') return 'int';
  if (Array.isArray(value)) return 'list';
  return 'dict';
}

/**
 * `PurePosixPath(text)` as a string: empty and `.` components and duplicate or
 * trailing slashes vanish, exactly two leading slashes are kept (POSIX
 * reserves `//`), and nothing left is `.`. Lets a probe `lstat` the same path
 * Python does, where `lstat('link/')` would follow the link.
 */
export function normalizePosixPath(text: string): string {
  const absolute = text.startsWith('/');
  const lead = absolute ? (text.startsWith('//') && !text.startsWith('///') ? '//' : '/') : '';
  const parts = text.split('/').filter((part) => part !== '' && part !== '.');
  return parts.length === 0 && !absolute ? '.' : lead + parts.join('/');
}

const MANIFEST_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** `except (OSError, ValueError, KeyError, TypeError)`: skip this snapshot, rethrow the rest. */
const skippable = (e: unknown): boolean =>
  isPyError(e, 'OSError', 'ValueError', 'KeyError', 'TypeError');

/** `json.loads(path.read_text())`: a decode or parse failure is a `ValueError`. */
function parseManifest(bytes: Uint8Array): JsonValue {
  try {
    return parseJsonValue(MANIFEST_DECODER.decode(bytes), { parseConstant: pythonNonFinite });
  } catch (e) {
    throw new PyError('ValueError', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Whether one retained snapshot proves `head` (on `repairBase`) is archived:
 * the per-candidate body of Python's loop, where every failure is `continue`.
 */
async function retentionProves(
  record: RetentionRecord,
  head: string,
  result: Rec,
): Promise<boolean> {
  try {
    const manifest = parseManifest(await record.readManifest());
    // `sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')))`
    // runs before any field is read, so it is computed even for a non-dict.
    const token = receiptJsonDigest(manifest);
    if (record.directoryName !== `retained-${token}`) return false;
    // A non-dict manifest fails the first subscript with a `TypeError`.
    if (!(manifest instanceof JsonObject)) return false;
    if (manifest.get('head') !== head) return false;
    const base = manifest.get('base');
    if (base === undefined || !Object.hasOwn(result, 'repair_base')) return false;
    if (!pyEq(toPlainJson(base, { bigints: true }), result.repair_base)) return false;
    const digests = manifest.get('sha256');
    if (!(digests instanceof JsonObject)) return false;
    for (const name of RETAINED_ARCHIVES) {
      const expected = digests.get(name);
      if (expected === undefined) return false;
      if ((await record.archiveDigest(name)) !== expected) return false;
    }
    return true;
  } catch (e) {
    if (skippable(e)) return false;
    throw e;
  }
}

/**
 * Decide whether `cleanup_harvested(...)` would run `git worktree remove` for
 * this verdict. Every probe is read-only; the order matches Python's, so a
 * refusal never asks a later (costlier) question.
 */
export async function decideRepairCleanup(
  request: RepairCleanupRequest,
  probes: RepairCleanupProbes,
): Promise<RepairCleanupDecision> {
  const { result } = request;
  const verdict = result.verdict;
  if (verdict !== 'FIXED' && verdict !== 'NOT-FIXED') return refuse('verdict-not-cleanable');
  const root = await probes.resolve(normalizePosixPath(request.worktreeRoot));
  const rawValue = Object.hasOwn(result, 'worktree') ? result.worktree : '';
  if (typeof rawValue !== 'string') {
    throw new PyError(
      'TypeError',
      'argument should be a str or an os.PathLike object where __fspath__ returns a str, ' +
        `not '${pyTypeName(rawValue)}'`,
    );
  }
  const raw = normalizePosixPath(rawValue);
  if (await probes.isSymlink(raw)) return refuse('worktree-symlink');
  let worktree = await probes.resolve(raw);
  const name = `crq-repair-${request.itemId}-${request.jobId}`;
  const leaf = posix.basename(worktree);
  if (posix.dirname(worktree) !== root || (leaf !== name && leaf !== `${name}-A2`)) {
    return refuse('worktree-not-owned');
  }
  if (request.alternate) {
    worktree = posix.join(root, leaf.endsWith('-A2') ? name : `${name}-A2`);
  }
  if ((await probes.isSymlink(worktree)) || !(await probes.isDirectory(worktree))) {
    return refuse('target-not-directory');
  }
  const status = await probes.status(worktree);
  if (status.failed || status.stdout !== '') return refuse('worktree-dirty');
  const head = await probes.head(worktree);
  for (const record of await probes.retainedManifests(request.directory)) {
    if (await retentionProves(record, head, result)) return { remove: true, worktree };
  }
  return refuse('no-matching-retention');
}
