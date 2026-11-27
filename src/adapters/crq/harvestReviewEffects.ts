/**
 * The file-backed half of `HarvestReviewEffects` that `harvestRunReads.ts`
 * leaves open: `findings.md`, `remove_worktree`, the receipt write and
 * `_request_pr_review`. Inactive: nothing imports this from a runtime entry
 * point, and it is not routed.
 *
 * Bound here (Python `crq.py`):
 * - `writeFindings`: `(rdir / "findings.md").write_text(findings_md(...))` (:2713).
 *   The text is rendered before the file is opened, so a render error leaves no
 *   file; an unencodable string (a lone surrogate from a JSON `\ud800`) fails
 *   at the write as `UnicodeEncodeError`, after `write_text` truncated the file.
 * - `removeWorktree`: `remove_worktree` (:351), shared with the launch effects.
 * - `writeReceipt`: `review_receipt.write_receipt(STATE / "receipts",
 *   current_document(item, outcome, meta=, cls=, rdir=))` (:1288, :2744).
 * - `requestPrReview`: `_request_pr_review` (:2486), a pure item mutation.
 *
 * Left injected, on purpose: `repairEnqueue` (bound in `tickComposition.ts` over
 * the repair-backfill effects, since it needs git and config),
 * `backfillHarvest` (bound separately, unrouted, by `backfillHarvestEffect.ts`), and the `coverage` seam
 * (start-one's `CoverageEffects`, a separate slice), plus the clock, event,
 * queue save and repo-registry effects.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { renderLocalReviewFindings } from '../../ops/crq/internal/localReviewReport.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import { fromPlainJson } from '../../policy/crq/queueDoc.js';
import { type HarvestReviewEffects, py } from '../../queue-runner/harvestReview.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import { GitPool, gitCall } from './gitExec.js';
import { writeLocalReviewReceipt } from './localReviewReceipt.js';

export type HarvestReviewFileEffects = Pick<
  HarvestReviewEffects,
  'writeFindings' | 'removeWorktree' | 'writeReceipt' | 'requestPrReview'
>;

/** `crq.remove_worktree` over the hardened Git runner: it raises nothing a caller sees. */
export function removeReviewWorktree(options: {
  readonly pool: GitPool;
  /** `crq.WT_PREFIX` */
  readonly worktreePrefix: string;
  /** The clone `git` runs in when the caller passes none (`cwd=None` is the process cwd). */
  readonly primaryClone: string;
}): (path: string, branch: string | null, clone: string | null) => Promise<void> {
  const exists = async (path: string): Promise<boolean> => {
    try {
      await stat(path);
      return true;
    } catch {
      return false; // Python `Path.exists()`: an inaccessible path is "not there".
    }
  };
  return async (path, branch, clone) => {
    const cwd = clone ?? options.primaryClone;
    if (await exists(path)) {
      await gitCall(options.pool, cwd, ['worktree', 'remove', '--force', path]);
      if ((await exists(path)) && basename(path).startsWith(options.worktreePrefix)) {
        try {
          // `shutil.rmtree` refuses a symlink or a plain file (OSError, swallowed by
          // `ignore_errors`): only a real directory is swept.
          if ((await lstat(path)).isDirectory()) await rm(path, { recursive: true, force: true });
        } catch {
          // `shutil.rmtree(ignore_errors=True)`.
        }
      }
    }
    await gitCall(options.pool, cwd, ['worktree', 'prune']);
    if (branch) await gitCall(options.pool, cwd, ['branch', '-D', branch]);
  };
}

function pyTypeName(value: unknown): string {
  if (typeof value === 'string') return 'str';
  if (value instanceof JsonNumber) return value.integer !== null ? 'int' : 'float';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (Array.isArray(value)) return 'list';
  return typeof value;
}

/** `Path.write_text`: a directory in the way is `IsADirectoryError`. */
async function writeText(path: string, text: string): Promise<void> {
  try {
    await writeFile(path, text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EISDIR')
      throw new PyError('IsADirectoryError', String(error));
    throw error;
  }
}

const keyError = (key: string): PyError => new PyError('KeyError', `'${key}'`);

function member(record: Record<string, unknown>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, key)) throw keyError(key);
  return record[key];
}

/** `str.encode()`: a lone surrogate has no UTF-8 form. */
function assertEncodable(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
    } else if (unit < 0xdc00 || unit > 0xdfff) continue;
    throw new PyError(
      'UnicodeEncodeError',
      `'utf-8' codec can't encode character '\\u${unit.toString(16)}': surrogates not allowed`,
    );
  }
}

async function readOptional(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EISDIR') throw new PyError('IsADirectoryError', String(error));
    if (code !== 'ENOENT') throw error;
    return null;
  }
}

/** `str.splitlines()` over text decoded as `read_text(errors="replace")`. */
function splitLines(text: string): string[] {
  const separators = new Set([10, 11, 12, 13, 28, 29, 30, 133, 0x2028, 0x2029]);
  const output: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!separators.has(text.charCodeAt(i))) continue;
    output.push(text.slice(start, i));
    if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10) i++;
    start = i + 1;
  }
  if (start < text.length) output.push(text.slice(start));
  return output;
}

const ARTIFACTS = ['meta.json', 'review.ndjson', 'exit.json', 'secret-scan.json'] as const;

/** `crq.current_document(item, outcome, meta=, cls=, rdir=)` for a harvested run. */
export async function currentDocument(
  rdir: string,
  item: Record<string, unknown>,
  outcome: string,
  meta: Record<string, unknown> | null,
  cls: Record<string, unknown> | null,
): Promise<JsonObject> {
  const artifacts: [string, JsonValue][] = [];
  for (const name of ARTIFACTS) {
    try {
      await stat(join(rdir, name));
    } catch {
      continue;
    }
    const bytes = await readOptional(join(rdir, name));
    if (bytes === null) continue;
    artifacts.push([name, createHash('sha256').update(bytes).digest('hex')]);
  }
  const stream = await readOptional(join(rdir, 'review.ndjson'));
  const findings: JsonValue[] = [];
  const text =
    stream === null
      ? ''
      : new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(stream);
  for (const line of splitLines(text)) {
    let value: JsonValue;
    try {
      value = parseJsonValue(line, {
        parseConstant: (raw) =>
          JsonNumber.float(raw === 'NaN' ? NaN : raw === 'Infinity' ? Infinity : -Infinity),
      });
    } catch {
      continue;
    }
    if (value instanceof JsonObject && value.get('type') === 'finding') findings.push(value);
  }
  const id = member(item, 'id');
  const source = member(item, 'subject');
  const capture = member(item, 'capture');
  const counted = cls !== null && py(cls) && py(member(cls, 'counted'));
  // `(meta or {}).get(...)`: a truthy value that is not a dict has no `.get`.
  if (
    meta !== null &&
    py(meta) &&
    (typeof meta !== 'object' || Array.isArray(meta) || meta instanceof JsonNumber)
  )
    throw new PyError('AttributeError', `'${pyTypeName(meta)}' object has no attribute 'get'`);
  return new JsonObject([
    ['version', JsonNumber.int(1)],
    ['item_id', fromPlainJson(id)],
    ['request_id', fromPlainJson(item.request_id ?? null)],
    ['source', fromPlainJson(source)],
    ['capture', fromPlainJson(capture)],
    ['outcome', outcome],
    ['classification', fromPlainJson(cls)],
    ['counted', counted],
    ['findings', findings],
    ['run_id', fromPlainJson(meta?.run_id ?? null)],
    ['started_at', fromPlainJson(meta?.started_at ?? null)],
    ['artifacts', new JsonObject(artifacts)],
    ['remediation', 'disabled/deferred'],
    ['independent_acceptance', false],
    ['cli_functional_acceptance', 'pending-D1'],
  ]);
}

export function fileHarvestReviewEffects(options: {
  readonly stateRoot: string;
  readonly pool: GitPool;
  /** `crq.WT_PREFIX` */
  readonly worktreePrefix: string;
  readonly primaryClone: string;
}): HarvestReviewFileEffects {
  const rdirOf = (runId: string): string => {
    if (!runId || runId === '.' || runId === '..' || /[/\\\0]/.test(runId))
      throw new Error('invalid run id');
    return join(options.stateRoot, 'runs', runId);
  };
  const remove = removeReviewWorktree(options);
  return {
    async writeFindings(runId, meta, cls) {
      const rdir = rdirOf(runId);
      const bytes = await readOptional(join(rdir, 'review.ndjson'));
      let markdown: string;
      try {
        markdown = renderLocalReviewFindings(
          bytes,
          fromPlainJson(meta) as JsonObject,
          fromPlainJson(cls) as JsonObject,
        );
      } catch (error) {
        // The renderer's `meta[key]` / `cls[key]` miss is Python's `KeyError`.
        const missing = /^missing (\w+)$/.exec(error instanceof Error ? error.message : '');
        throw missing ? keyError(missing[1]!) : error;
      }
      const path = join(rdir, 'findings.md');
      try {
        assertEncodable(markdown);
      } catch (error) {
        await writeText(path, ''); // `write_text` opened (truncated) the file before encoding
        throw error;
      }
      await writeText(path, markdown);
    },
    removeWorktree(worktree, branch, clone) {
      if (typeof worktree !== 'string') throw new PyError('TypeError', 'expected str path');
      if (branch !== null && branch !== undefined && typeof branch !== 'string' && py(branch))
        throw new PyError('TypeError', 'expected str branch');
      return remove(worktree, py(branch) ? (branch as string) : null, clone);
    },
    async writeReceipt(item, outcome, meta, cls, runId) {
      const document = await currentDocument(rdirOf(runId), item, outcome, meta, cls);
      return writeLocalReviewReceipt(join(options.stateRoot, 'receipts'), document);
    },
    async requestPrReview(item, runId, meta, cls) {
      const rdir = rdirOf(runId);
      item.pr_review_request = {
        run_id: runId,
        pr: member(item, 'pr'),
        base: member(meta, 'base'),
        head: member(meta, 'head'),
        ndjson: join(rdir, 'review.ndjson'),
        severity_counts: member(cls as Record<string, unknown>, 'severity_counts'),
      };
      item.pr_review_pending = true;
      item.pr_review_attempts = 0;
      if (py(item.issue_pending)) item.issue_pending = false;
      delete item.pr_review;
      delete item.pr_review_error;
    },
  };
}
