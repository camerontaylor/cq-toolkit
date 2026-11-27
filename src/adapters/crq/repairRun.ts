/**
 * The result lane of Python `crq_repair.run`/`drain`/`main` (S2), over injected
 * effects. Offline and unrouted: nothing here is bound to a unit command, and
 * `repairCli.ts` still ends at its admission stage.
 *
 * Ported (Python `apps/crq-python/crq_repair.py`):
 * - `run()` `--triage-dry-run` branch (:1601-1620): `state/repair` is created,
 *   `service.lock` is taken without blocking and a held lock is the
 *   `busy` result (exit 0); the triage report is the one artifact, and a
 *   `None` report is the explicit `no-triage` result ({@link runTriageDryRun});
 * - `run()` drain tail (:1650-1680): the lock-busy result and the
 *   drain result as returned, exit 1 only for status `error`
 *   ({@link finishDrain}, {@link lockedResult});
 * - `drain()` (:972-1073): the admission stops, the triage fold (a triage
 *   exception is narrated and the pass continues, `triage` rides inside the
 *   result), the unreadable-queue error result and the worker-failure error
 *   result ({@link drain});
 * - `main()` (:1685-1698): the second narration of the full traceback
 *   ({@link narrateMainFailure}).
 *
 * Deviations: the traceback frames are Node's (they differ by construction);
 * the banner and the final `Class: message` line, which the fixture pins, are
 * reproduced exactly, and a
 * triage-phase failure is caught only when it is an `Error` (Python's
 * `except Exception`).
 *
 * Not ported: the budget-launcher/Paseo/ZAI/blackout admission between the
 * dry-run branch and the lock, `--recover-job`, an explicit `--job`, and the
 * group, priority and worker-pool internals (injected through
 * {@link RepairDrainEffects}).
 */
import { gateMessage } from '../../ops/crq/internal/repairPassGates.js';
import { PyError, clip300, excText, isPyError } from '../../queue-runner/pyErrors.js';

export type Dict = Record<string, unknown>;

export interface RepairRunOutcome {
  readonly exitCode: number;
  /** The one JSON artifact; `null` is Python's `None` (nothing written). */
  readonly result: Dict | null;
}

export interface LockEffects {
  /** `(ROOT / 'state/repair').mkdir(parents=True, exist_ok=True)`. */
  readonly ensureStateDirectory: () => Promise<void>;
  /**
   * `open('state/repair/service.lock', 'a')` then a non-blocking `LOCK_EX`:
   * `held: false` is `BlockingIOError`; any other failure rejects. The lock
   * is released when `body` settles.
   */
  readonly withServiceLock: <T>(
    body: () => Promise<T>,
  ) => Promise<{ readonly held: true; readonly value: T } | { readonly held: false }>;
}

const BUSY: Dict = Object.freeze({
  status: 'busy',
  reason: 'service.lock held by another repair pass',
});

/** Python's per-call `{'status': 'busy', ...}` literal: a fresh dict each time. */
function busy(): Dict {
  return { ...BUSY };
}

/** The shared lock shape of `run()`: mkdir, non-blocking flock, busy result or `body`. */
export async function lockedResult(
  effects: LockEffects,
  body: () => Promise<RepairRunOutcome>,
): Promise<RepairRunOutcome> {
  await effects.ensureStateDirectory();
  const locked = await effects.withServiceLock(body);
  return locked.held ? locked.value : { exitCode: 0, result: busy() };
}

export interface TriageDryRunEffects extends LockEffects {
  /** `triage_phase(config, dry_run=True)`: the report, or `null` (`None`) having written nothing. */
  readonly triagePhase: (config: Dict, options: { readonly dryRun: true }) => Promise<Dict | null>;
}

/** `run()` with `args.triage_dry_run` (crq_repair.py:1601-1620). */
export function runTriageDryRun(
  config: Dict,
  effects: TriageDryRunEffects,
): Promise<RepairRunOutcome> {
  return lockedResult(effects, async () => {
    const report = await effects.triagePhase(config, { dryRun: true });
    if (report === null)
      return {
        exitCode: 0,
        result: {
          status: 'no-triage',
          reason: 'triage is not configured for this state directory',
        },
      };
    return { exitCode: 0, result: report };
  });
}

/** The end of `run()` (crq_repair.py:1679-1680): `drain` always returns a result; `error` exits 1. */
export function finishDrain(result: Dict): RepairRunOutcome {
  return { exitCode: result['status'] === 'error' ? 1 : 0, result };
}

export type GroupMap = Map<string, string[]>;

export interface RepairDrainEffects {
  readonly narrate: (line: string) => void;
  /** `runner_disabled()`. */
  readonly runnerDisabled: () => Promise<boolean>;
  /** `worker_limit(config)`: validation only; rejects on a bad limit. */
  readonly workerLimit: (config: Dict) => Promise<void>;
  /** `dispatch_paused(config)`: the `until` text, or `null`. Truthiness decides. */
  readonly dispatchPaused: (config: Dict) => Promise<string | null>;
  /** `fetch_clone(config)`: an error text, or `null` (an empty text is still an error). */
  readonly fetchClone: (config: Dict) => Promise<string | null>;
  /** `triage_phase(config)`. */
  readonly triagePhase: (config: Dict) => Promise<Dict | null>;
  /** `drain_order(ROOT)`. */
  readonly drainOrder: () => Promise<readonly string[]>;
  /**
   * `json.loads(inbox/<id>.json)`; rejects with an `OSError`/`ValueError`
   * `PyError` where Python's read or parse fails.
   */
  readonly readInboxJob: (jobId: string) => Promise<unknown>;
  /**
   * The queue: `{'items': []}` when `state/queue.json` is absent; rejects with
   * an `OSError`/`ValueError` `PyError` where the read or parse fails.
   */
  readonly readQueue: () => Promise<unknown>;
  /** `hold_backfill_groups(groups, dispatchable)`. */
  readonly holdBackfillGroups: (groups: GroupMap, queue: unknown) => Promise<GroupMap>;
  /** `drain_job(ROOT, config, queue, job_id)`: `(status, job)`. */
  readonly drainJob: (
    config: Dict,
    queue: unknown,
    jobId: string,
  ) => Promise<readonly [string, Dict | null]>;
  readonly unreadableResult: (jobId: string) => Promise<boolean>;
  readonly pending: (jobId: string) => Promise<boolean>;
  /** `drain_items(config, groups, order)`: the failed item ids. */
  readonly drainItems: (
    config: Dict,
    groups: GroupMap,
    order: readonly string[],
  ) => Promise<readonly string[]>;
}

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `except (OSError, ValueError)`. */
function isReadFailure(error: unknown): error is PyError {
  return isPyError(error, 'OSError', 'ValueError');
}

/** Python's `sorted(failed)` over `str`: by code point, not UTF-16 unit. */
function codePointSort(values: readonly string[]): string[] {
  return [...values].sort((a, b) => {
    const left = Array.from(a);
    const right = Array.from(b);
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const delta = (left[index] ?? '').codePointAt(0)! - (right[index] ?? '').codePointAt(0)!;
      if (delta !== 0) return delta;
    }
    return left.length - right.length;
  });
}

/** `str(...)[:300]` of a joined text. */
function clipJoined(text: string): string {
  return clip300(text);
}

async function priorityOf(
  config: Dict,
  queue: unknown,
  groups: GroupMap,
  item: string,
  effects: RepairDrainEffects,
): Promise<number> {
  for (const jobId of groups.get(item) ?? []) {
    const [status, job] = await effects.drainJob(config, queue, jobId);
    if (
      status === 'run' &&
      job !== null &&
      Object.keys(job).length > 0 &&
      job['item'] === item &&
      !(await effects.unreadableResult(jobId)) &&
      (await effects.pending(jobId))
    ) {
      // `job.get('finding', {}).get('severity')`: a present non-dict finding is AttributeError.
      const finding = Object.hasOwn(job, 'finding') ? job['finding'] : {};
      if (!isDict(finding))
        throw new PyError('AttributeError', `'${typeName(finding)}' object has no attribute 'get'`);
      const severity = finding['severity'];
      if (severity === 'critical' || severity === 'major') return 0;
    }
  }
  return 1;
}

function typeName(value: unknown): string {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'boolean') return 'bool';
  return typeof value === 'number' ? 'int' : 'object';
}

/**
 * Python `drain` (crq_repair.py:972-1073): the pass's JSON result; a narrated
 * early exit reports a `refused`, `paused` or `deferred` status, never `null`.
 */
export async function drain(config: Dict, effects: RepairDrainEffects): Promise<Dict> {
  if (await effects.runnerDisabled()) {
    effects.narrate(gateMessage({ stage: 'pass-start' }));
    return { status: 'refused', reason: 'runner-disabled' };
  }
  if (!Object.hasOwn(config, 'repair')) throw new PyError('KeyError', "'repair'");
  await effects.workerLimit(config);
  const until = await effects.dispatchPaused(config);
  if (until) {
    effects.narrate(`repair drain paused: provider rate limit until ${until}`);
    return { status: 'paused', reason: `provider rate limit until ${until}` };
  }
  const fetchError = await effects.fetchClone(config);
  if (fetchError !== null) {
    const reason = Array.from(fetchError).slice(0, 200).join('');
    effects.narrate(`repair drain skipped: ${reason}`);
    return { status: 'deferred', reason };
  }
  if (await effects.runnerDisabled()) {
    effects.narrate(gateMessage({ stage: 'before-triage' }));
    return { status: 'deferred', reason: 'runner-disabled' };
  }
  let triage: Dict | null = null;
  try {
    triage = await effects.triagePhase(config);
  } catch (error) {
    // `except Exception`: backfill deferral must not starve existing repair jobs.
    if (!(error instanceof Error)) throw error;
    effects.narrate(`backfill triage deferred: ${clip300(excText(error))}`);
  }
  const result: Dict = { status: 'drained' };
  if (triage !== null) result['triage'] = triage;
  if (await effects.dispatchPaused(config)) return result;
  let groups: GroupMap = new Map();
  for (const jobId of await effects.drainOrder()) {
    let item: unknown;
    try {
      const job = await effects.readInboxJob(jobId);
      // `job.get('item')`: any non-dict job is AttributeError, skipped like a bad read.
      if (!isDict(job)) continue;
      item = job['item'];
    } catch (error) {
      if (isReadFailure(error)) continue;
      throw error;
    }
    if (typeof item === 'string') {
      const ids = groups.get(item);
      if (ids === undefined) groups.set(item, [jobId]);
      else ids.push(jobId);
    }
  }
  let queue: unknown;
  try {
    queue = await effects.readQueue();
  } catch (error) {
    if (!isReadFailure(error)) throw error;
    const text = clipJoined(excText(error));
    effects.narrate(`repair drain failed: queue unreadable: ${text}`);
    result['status'] = 'error';
    result['error'] = `queue unreadable: ${text}`;
    return result;
  }
  groups = await effects.holdBackfillGroups(groups, queue);
  const keyed: { item: string; priority: number }[] = [];
  for (const item of groups.keys())
    keyed.push({ item, priority: await priorityOf(config, queue, groups, item, effects) });
  keyed.sort((a, b) => a.priority - b.priority);
  const failed = await effects.drainItems(
    config,
    groups,
    keyed.map((entry) => entry.item),
  );
  if (failed.length > 0) {
    result['status'] = 'error';
    result['error'] = `worker failures: ${clipJoined(codePointSort(failed).join(', '))}`;
  }
  return result;
}

/**
 * The shape of `traceback.format_exc()`: the banner, the frames, then the
 * `Class: message` header as the final line (the bare class when the message
 * is empty). The class is the Python kind of a `PyError`, else the error name.
 */
function traceback(error: unknown, message: string): string {
  const name = error instanceof Error ? error.name : 'Error';
  const frames =
    error instanceof Error && error.stack !== undefined
      ? error.stack
          .split('\n')
          .filter((line) => /^\s+at /.test(line))
          .join('\n')
      : '';
  const header = message === '' ? name : `${name}: ${message}`;
  return `Traceback (most recent call last):\n${frames === '' ? '' : `${frames}\n`}${header}\n`;
}

/**
 * `main()`'s failure lane (crq_repair.py:1688-1696): two narrations, the
 * message clipped to 300 and then the full traceback, and the `failed`
 * artifact (message clipped to 200). Exit code 1.
 */
export function narrateMainFailure(
  error: unknown,
  narrate: (line: string) => void,
): { readonly exitCode: 1; readonly artifact: Dict } {
  const message = excText(error);
  narrate(`repair dispatch failed: ${clip300(message)}`);
  narrate(traceback(error, message));
  return {
    exitCode: 1,
    artifact: {
      error: {
        kind: 'failed',
        subcommand: null,
        message: Array.from(message).slice(0, 200).join(''),
        exitCode: 1,
      },
    },
  };
}
