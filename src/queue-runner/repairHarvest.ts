/**
 * The queue side of `repair_tick.harvest` (repair_tick.py:422-578), with
 * `record_terminal_failure` and `record_unpublished_siblings` (:339-421).
 * Inactive: nothing imports this outside tests.
 *
 * Items, queues and repair records are plain records edited in place. Every
 * read of the repair artifacts, the worktree, the verifier, the finding ledger
 * and publication is injected. `publish`, `verify`, `mechanical`,
 * `require_canonical_delivery`, `mark_finding_outcome`, `cleanup_harvested`
 * and the worktree calls have no queue-side TS wiring yet, so each stays an
 * effect the caller must bind: nothing here stubs one to success.
 *
 * Python classifies failures by exception class; an effect that mirrors a
 * Python raise throws a `PyError` (see `pyErrors.ts`).
 */
import { basename, dirname } from 'node:path';

import {
  dict,
  get,
  isRec,
  pyEq,
  REVIEW_RECEIPT_KIND,
  truthy,
  type Item,
  type Queue,
} from './repairBackfill.js';
import { clip300, excText, isPyError, PyError } from './pyErrors.js';

type Rec = Record<string, unknown>;

/** `crq_repair.bounded.JOB_ID`, full match. */
const JOB_ID = /^crq-[A-Za-z0-9._-]+$/;
const COMMIT = /^[0-9a-fA-F]{40}$/;
/** `FIXED_RUNGS`. */
const FIXED_RUNGS = ['A0', 'A1', 'A2'];
const TERMINAL = ['published', 'done', 'failed', 'stale'];
const OPEN = ['queued', 'ready', 'publish_failed'];
const NEEDS_HUMAN_REASON =
  'repair run failed before publication; the verified fix was not published';

export interface RepairHarvestEffects {
  /** `json.loads(STATE/repair/inbox/<job>.json)`; throws `OSError`/`ValueError`. */
  readJob(jobId: string): Promise<unknown>;
  /** `(STATE/repair/<job>/result.json).exists()`. */
  resultExists(jobId: string): Promise<boolean>;
  /**
   * `json.loads(STATE/repair/<job>/result.json)`. A decode or parse failure is
   * a `ValueError` (harvest terminalizes it); a read failure is an `OSError`.
   */
  readResult(jobId: string): Promise<unknown>;
  /** `require_canonical_delivery(STATE.parent, job)`; a stale selection is a `ValueError`. */
  requireCanonicalDelivery(job: Rec): Promise<void>;
  /** `Path(p).resolve()`: a non-string never reaches it; an embedded NUL is a `ValueError`. */
  resolvePath(path: string): Promise<string>;
  /** `c.WT_ROOT`, unresolved. */
  readonly worktreeRoot: string;
  /** `c.make_worktree(name, commit)`. */
  makeWorktree(name: string, commit: string): Promise<{ path: string; branch: string }>;
  /** `c.remove_worktree(path, branch)`. */
  removeWorktree(path: string, branch: string): Promise<void>;
  /** `crq_repair.verify(check_wt, predecessor, commits, job_id)`. */
  verify(worktree: string, predecessor: string, commits: string[], jobId: string): Promise<void>;
  /**
   * `module.mechanical(CONFIG, check_wt, predecessor, commits, job_id, <repair dir>)`.
   * A `DetectorUnavailable` means no verdict was rendered, so a later tick retries.
   */
  mechanical(
    worktree: string,
    predecessor: string,
    commits: string[],
    jobId: string,
  ): Promise<void>;
  /** `c.save_queue(q)`. */
  saveQueue(q: Queue): Promise<void>;
  /** `mark_finding_outcome(c, job, result)`, including its no-op on a job with no finding id. */
  markFindingOutcome(job: Rec, result: Rec): Promise<void>;
  /**
   * `finding_inbox(c).repair_outcome(fid, job, 'needs-human', <fixed reason>, c.iso(),
   * repair_base=..., failure_class='exhausted')`: a verified FIXED sibling of a run
   * that failed before publishing.
   */
  recordUnpublishedFixedSibling(
    findingId: unknown,
    jobId: string,
    reason: string,
    repairBase: unknown,
  ): Promise<void>;
  /**
   * `cleanup_harvested(CLONE, WT_ROOT, STATE/repair/<job>, item, job, result, alternate=...)`.
   * Absent when the config has no `WT_ROOT` or `CLONE`, as Python's `hasattr` checks.
   */
  readonly cleanupHarvested?:
    | ((itemId: string, jobId: string, result: Rec, alternate: boolean) => Promise<void>)
    | undefined;
  /** `publish(c, q, item, run, record, fixed)`: publish, recover and finalize. */
  publish(q: Queue, item: Item, run: string, record: Rec, fixed: Rec[]): Promise<void>;
}

/** `d[key]` raising `KeyError('key')`. */
function pyReq(o: Rec, key: string): unknown {
  if (!Object.hasOwn(o, key)) throw new PyError('KeyError', `'${key}'`);
  return o[key];
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'bigint') return 'int';
  if (typeof v === 'string') return 'str';
  return Array.isArray(v) ? 'list' : 'dict';
}

/** `Path(value)` argument check (CPython 3.12+ wording). */
function pathArg(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new PyError(
    'TypeError',
    `argument should be a str or an os.PathLike object where __fspath__ returns a str, not '${pyTypeName(value)}'`,
  );
}

const asList = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new TypeError(`${what} must be a list`);
  return v;
};

const inList = (list: readonly unknown[], v: unknown): boolean => list.some((e) => pyEq(e, v));

/** `except (OSError, ValueError, KeyError, TypeError, RuntimeError)` */
const isCaught = (e: unknown): e is PyError =>
  isPyError(e, 'OSError', 'ValueError', 'KeyError', 'TypeError', 'RuntimeError');

/**
 * `record_unpublished_siblings`: give every sibling of a dead run its own
 * explicit decision. Idempotent; the first failure is rethrown after the
 * healthy siblings were tried.
 */
export async function recordUnpublishedSiblings(
  fx: RepairHarvestEffects,
  record: Rec,
  handled: ReadonlySet<string>,
): Promise<void> {
  const failures: unknown[] = [];
  const jobs = get(record, 'jobs');
  for (const other of truthy(jobs) ? asList(jobs, 'jobs') : []) {
    if (typeof other !== 'string' || handled.has(other)) continue;
    let result: unknown;
    let job: unknown;
    try {
      result = await fx.readResult(other);
      job = await fx.readJob(other);
    } catch (e) {
      if (isPyError(e, 'OSError', 'ValueError')) continue;
      throw e;
    }
    if (!isRec(result) || !isRec(job)) continue;
    if (!truthy(get(job, 'canonical_finding_id'))) continue;
    try {
      const verdict = get(result, 'verdict');
      // Sibling results bypass harvest's validation: apply the same identity
      // and binding checks before any verdict — including FIXED — becomes an
      // outcome. A mismatching result is terminalized (like harvest's
      // record_terminal_failure): the failure outcome is recorded, the
      // attacker-controlled verdict is not, and the tick proceeds.
      let reason: string | null = null;
      if (!pyEq(get(result, 'job'), other) || !pyEq(get(result, 'item'), get(job, 'item'))) {
        reason = 'invalid repair result: sibling identity mismatch';
      } else if (
        truthy(get(job, 'source_sha')) &&
        ['source_sha', 'finding_sha256', 'origin_job'].some(
          (k) => !pyEq(get(result as Rec, k), get(job as Rec, k)),
        )
      ) {
        reason = 'invalid repair result: sibling source/evidence binding mismatch';
      }
      if (reason !== null) {
        await fx.markFindingOutcome(job, {
          job: other,
          item: get(job, 'item') ?? null,
          verdict: 'FAILED',
          reason,
          finding: get(job, 'finding') ?? null,
        });
      } else if (verdict === 'FIXED') {
        await fx.recordUnpublishedFixedSibling(
          pyReq(job, 'canonical_finding_id'),
          other,
          NEEDS_HUMAN_REASON,
          get(job, 'repair_base') ?? null,
        );
      } else if (verdict === 'FAILED' || verdict === 'NOT-FIXED' || verdict === 'STALE') {
        await fx.markFindingOutcome(job, result);
      }
    } catch (e) {
      if (!isCaught(e)) throw e;
      failures.push(e);
    }
  }
  if (failures.length > 0) throw failures[0];
}

/**
 * `record_terminal_failure`: a deterministic repair artifact defect can never
 * pass on a later tick, so record the failure rather than retrying forever.
 */
async function recordTerminalFailure(
  fx: RepairHarvestEffects,
  q: Queue,
  item: Item,
  record: Rec,
  verdicts: Rec[],
  expected: Rec,
  jobId: string,
  exc: unknown,
): Promise<void> {
  const text = clip300(excText(exc));
  const failure: Rec = {
    job: jobId,
    item: pyReq(item, 'id'),
    verdict: 'FAILED',
    reason: `invalid repair result: ${text}`,
    finding: pyReq(expected, 'finding'),
  };
  record.verdicts = [...verdicts, failure];
  record.state = 'failed';
  record.error = text;
  if (pyReq(item, 'kind') === REVIEW_RECEIPT_KIND) {
    item.state = 'done';
    item.repair_outcome = record.state;
    item.last_error = null;
  } else {
    item.state = 'repair_failed';
    item.last_error = 'repair_failed; needs human';
  }
  await fx.saveQueue(q); // terminal identity before authoritative write-back
  await fx.markFindingOutcome(expected, failure);
  await recordUnpublishedSiblings(fx, record, new Set([jobId]));
}

/** The terminal-state half of the harvest loop (published/done/failed/stale). */
async function reconcileTerminal(
  fx: RepairHarvestEffects,
  q: Queue,
  item: Item,
  record: Rec,
  dry: boolean,
  messages: string[],
): Promise<void> {
  if (!dry && record.state === 'failed') {
    // A terminal local failure can outlive a failed ledger write: replay the
    // retained FAILED outcomes through the ledger's idempotent event chain.
    const handled = new Set<string>();
    for (const result of asList(get(record, 'verdicts', []), 'verdicts')) {
      const r = dict(result, 'verdict');
      if (get(r, 'verdict') !== 'FAILED') continue;
      const reason = get(r, 'reason', '');
      if (typeof reason !== 'string') throw new TypeError('reason must be a str');
      if (!reason.startsWith('invalid repair result: ')) continue;
      if (
        !inList(asList(pyReq(record, 'jobs'), 'jobs'), get(r, 'job')) ||
        !pyEq(get(r, 'item'), pyReq(item, 'id'))
      ) {
        throw new PyError('ValueError', 'terminal repair outcome identity mismatch');
      }
      const jobId = pyReq(r, 'job');
      if (typeof jobId !== 'string') throw new TypeError('job must be a str');
      const expected = dict(await fx.readJob(jobId), 'inbox job');
      if (!pyEq(get(expected, 'job'), jobId) || !pyEq(get(expected, 'item'), pyReq(item, 'id'))) {
        throw new PyError('ValueError', 'terminal repair job identity mismatch');
      }
      handled.add(jobId);
      if (truthy(get(expected, 'canonical_finding_id'))) {
        await fx.saveQueue(q); // also retry any prior failed terminal save
        await fx.markFindingOutcome(expected, r);
      }
    }
    // A write-back that failed before the sibling decision is replayed here.
    await recordUnpublishedSiblings(fx, record, handled);
  }
  const verdicts = get(record, 'verdicts');
  if (!dry && truthy(verdicts) && fx.cleanupHarvested !== undefined) {
    for (const result of asList(verdicts, 'verdicts')) {
      if (!isRec(result)) continue;
      const jobId = get(result, 'job', '');
      if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) continue;
      try {
        for (const alternate of [false, true]) {
          await fx.cleanupHarvested(String(pyReq(item, 'id')), jobId, result, alternate);
        }
      } catch (e) {
        if (!isCaught(e)) throw e;
        messages.push(`repair cleanup ${jobId}: ${clip300(excText(e))}`);
      }
    }
  }
  // Reconcile an atomically persisted publication after a caller crash.
  if (pyReq(item, 'kind') === REVIEW_RECEIPT_KIND) {
    item.state = 'done';
    item.repair_outcome = record.state;
    item.last_error = null;
  } else if (get(item, 'state') === 'repairing') {
    item.state = record.state === 'failed' ? 'repair_failed' : 'done';
  }
}

/**
 * Validate one result artifact against its inbox job (the `try` block at
 * repair_tick.py:491-532). Throws a `PyError` for a defect harvest terminalizes.
 */
async function validateResult(
  fx: RepairHarvestEffects,
  item: Item,
  expected: Rec,
  result: unknown,
  jobId: string,
  predecessor: unknown,
): Promise<{ result: Rec; commits: string[] | null; retry: boolean }> {
  if (!isRec(result)) throw new PyError('ValueError', 'repair result must be an object');
  if (truthy(get(result, 'retry_after'))) return { result, commits: null, retry: true };
  if (!pyEq(get(result, 'job'), jobId) || !pyEq(get(result, 'item'), pyReq(item, 'id'))) {
    throw new PyError('ValueError', 'repair result identity mismatch');
  }
  if (
    truthy(get(expected, 'source_sha')) &&
    ['source_sha', 'finding_sha256', 'origin_job'].some(
      (k) => !pyEq(get(result, k), get(expected, k)),
    )
  ) {
    throw new PyError('ValueError', 'prepared repair result source/evidence binding mismatch');
  }
  const verdict = get(result, 'verdict');
  let commits: string[] | null = null;
  if (verdict === 'FIXED') {
    const claimed = get(result, 'commits');
    if (
      !Array.isArray(claimed) ||
      claimed.length === 0 ||
      !claimed.every((sha) => typeof sha === 'string' && COMMIT.test(sha))
    ) {
      throw new PyError('ValueError', 'repair result claims FIXED without valid commits');
    }
    commits = claimed as string[];
    const attempts = get(result, 'attempts');
    const final: unknown =
      Array.isArray(attempts) && attempts.length > 0
        ? (attempts[attempts.length - 1] as unknown)
        : null;
    if (!isRec(final) || !inList(FIXED_RUNGS, get(final, 'rung'))) {
      throw new PyError('ValueError', 'repair fixed result lacks a valid final attempt rung');
    }
    const wt = await fx.resolvePath(pathArg(pyReq(result, 'worktree')));
    const root = await fx.resolvePath(fx.worktreeRoot);
    const legacy = `crq-repair-${String(pyReq(item, 'id'))}`;
    const scoped = `${legacy}-${jobId}`;
    if (dirname(wt) !== root || ![legacy, scoped, `${scoped}-A2`].includes(basename(wt))) {
      throw new PyError('ValueError', 'repair result worktree outside owned path');
    }
    if (!pyEq(get(result, 'repair_base'), predecessor)) {
      throw new PyError('ValueError', 'repair predecessor mismatch');
    }
  } else if (verdict !== 'NOT-FIXED' && verdict !== 'FAILED' && verdict !== 'STALE') {
    throw new PyError('ValueError', 'unknown repair verdict');
  }
  // finalize_publication renders every verdict's reason into the fix PR body,
  // so a malformed reason must fail here, before a push makes it unrecoverable.
  if (typeof get(result, 'reason') !== 'string') {
    throw new PyError('ValueError', 'repair result lacks a string reason');
  }
  return { result, commits, retry: false };
}

/** `except (ValueError, IndexError, KeyError, TypeError)` around the validation. */
const isDefect = (e: unknown): boolean =>
  isPyError(e, 'ValueError', 'IndexError', 'KeyError', 'TypeError');

/**
 * `harvest(c, q, item, dry)`: walk an item's repair runs, validate each
 * finished job and either record a terminal outcome, hand the verified fixes
 * to `publish`, or leave the run open for a later tick. Returns the log lines.
 */
export async function repairHarvest(
  q: Queue,
  item: Item,
  fx: RepairHarvestEffects,
  dry = false,
): Promise<string[]> {
  const messages: string[] = [];
  const runs = get(item, 'repair_runs', {});
  if (!isRec(runs)) throw new TypeError('repair_runs must be a dict');
  for (const [run, rawRecord] of Object.entries(runs)) {
    const record = dict(rawRecord, 'repair record');
    const state = pyReq(record, 'state');
    if (typeof state === 'string' && TERMINAL.includes(state)) {
      await reconcileTerminal(fx, q, item, record, dry, messages);
      continue;
    }
    if (typeof state !== 'string' || !OPEN.includes(state)) continue;

    const verdicts: Rec[] = [];
    let predecessor: unknown = pyReq(record, 'base');
    const jobs = asList(pyReq(record, 'jobs'), 'jobs');
    for (const jobId of jobs) {
      if (typeof jobId !== 'string') throw new TypeError('job id must be a str');
      if (!(await fx.resultExists(jobId))) break;
      const expected = dict(await fx.readJob(jobId), 'inbox job');
      try {
        await fx.requireCanonicalDelivery(expected);
      } catch (e) {
        if (!isPyError(e, 'ValueError')) throw e;
        if (!dry) {
          record.state = 'stale';
          record.error = excText(e);
          item.state = 'done';
        }
        break; // Retain the result artifact without publishing an obsolete fix.
      }
      let checked: { result: Rec; commits: string[] | null; retry: boolean };
      try {
        checked = await validateResult(
          fx,
          item,
          expected,
          await fx.readResult(jobId),
          jobId,
          predecessor,
        );
      } catch (e) {
        if (!isDefect(e)) throw e;
        // A deterministic artifact defect can never pass on a later tick.
        if (!dry) await recordTerminalFailure(fx, q, item, record, verdicts, expected, jobId, e);
        break;
      }
      if (checked.retry) break;
      const { result, commits } = checked;
      if (result.verdict === 'FIXED' && !dry) {
        // Later findings move the shared HEAD; validate each immutable claimed
        // range through a separate detached verification worktree.
        const claimed = commits as string[];
        const { path: checkWt, branch } = await fx.makeWorktree(
          `verify-${jobId}`,
          claimed[claimed.length - 1] as string,
        );
        let terminal = false;
        try {
          await fx.verify(checkWt, predecessor as string, claimed, jobId);
          await fx.mechanical(checkWt, predecessor as string, claimed, jobId);
        } catch (e) {
          // The detector never rendered a verdict: stay on the retry path.
          if (isPyError(e, 'DetectorUnavailable') || !isPyError(e, 'ValueError')) throw e;
          // A rejected claimed range is deterministic, so terminalize it too.
          await recordTerminalFailure(fx, q, item, record, verdicts, expected, jobId, e);
          terminal = true;
        } finally {
          await fx.removeWorktree(checkWt, branch);
        }
        if (terminal) break;
        predecessor = claimed[claimed.length - 1];
      }
      if (!dry) await fx.markFindingOutcome(expected, result);
      verdicts.push({ ...result, finding: pyReq(expected, 'finding') });
    }
    if (verdicts.length !== jobs.length) continue;
    if (dry) {
      messages.push(`would harvest repair ${run}`);
      continue;
    }
    record.verdicts = verdicts;
    record.state = 'ready';
    const fixed = verdicts.filter((v) => v.verdict === 'FIXED');
    if (fixed.length === 0) {
      record.state = verdicts.some((v) => v.verdict === 'FAILED') ? 'failed' : 'done';
      item.last_error = record.state === 'failed' ? 'repair_failed; needs human' : null;
    } else {
      try {
        await fx.publish(q, item, run, record, fixed);
      } catch (e) {
        record.state = 'publish_failed';
        record.error = clip300(excText(e));
        item.last_error = `repair publish failed: ${record.error as string}`;
      }
    }
    if (pyReq(item, 'kind') === REVIEW_RECEIPT_KIND) {
      item.state = 'done';
      item.repair_outcome = record.state;
      item.last_error = null;
    } else {
      item.state =
        record.state === 'failed' || record.state === 'publish_failed' ? 'repair_failed' : 'done';
    }
    messages.push(`${String(pyReq(item, 'id'))}: repair ${String(record.state)}`);
  }
  return messages;
}
