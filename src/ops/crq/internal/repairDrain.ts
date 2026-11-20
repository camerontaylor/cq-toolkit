/**
 * Drain orchestration of the repair service (Python `crq_repair.drain`,
 * `hold_backfill_groups`, `drain_item`, `worker_limit`, `drain_items`,
 * `reap_*` and `refusal_published`, lines 961-1356).
 *
 * Everything the pass touches is injected: the runner-disabled marker, the
 * provider pause, the GLM blackout, the clone fetch, triage, the inbox, the
 * queue, the backlog file, job classification, result artifacts, the tick
 * lock and the worker. Nothing here forks, reads a file or calls a provider,
 * so the module is inert and every ordering is exercised offline.
 *
 * What it owns, in Python's order:
 * - pass admission: marker, `max_concurrent_items` validation, provider pause,
 *   fetch, a second marker sample before triage, triage (a throw defers triage,
 *   never the pass), a second pause sample, then the inbox grouped by item in
 *   the order of each item's oldest job;
 * - one queue read per pass. An unreadable queue yields one error artifact that
 *   keeps the triage report, because nothing was admitted yet;
 * - the backfill soft budget (`hold_backfill_groups`), then critical/major items
 *   before minor-only ones, classified against the queue so stale, completed
 *   and unreadable jobs cannot promote an item;
 * - `drain_item`: marker, blackout and pause per item, a fresh queue read, stale
 *   marking, run-wide holds on an unreadable `result.json`, and a failed item
 *   that never stops the others;
 * - `drain_items`: one coordinator admits, items run in isolated workers up to
 *   the limit, findings inside an item stay serial (`processItem`), admission
 *   is re-checked after any capacity wait and under the tick lock, a refusal
 *   published by a worker stops the next admission before its exit status
 *   arrives, and admitted workers are always reaped (never killed).
 *
 * Boundary: `processItem` (Python `process_item`, which owns the worktree and
 * `process`) and the worker isolation itself are bindings the repair execution
 * slice supplies; `runRepairWorker` is the body such a worker runs in its own
 * process. Runtime activation and dispatch stay out of this slice.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { parseUtcUnchecked, utcHasOffset } from '../../../policy/crq/utc.js';
import { admit, RUNNER_DISABLED_OUTCOME, type PassGateEffects } from './repairPassGates.js';

/** `BACKLOG_MAX_AGE_SECONDS`. */
export const BACKLOG_MAX_AGE_SECONDS = 3600;
/** The only `bounded.drain_job` reason a skipped job is not narrated for. */
export const NO_QUEUED_RUN_REASON = 'no queued tick-owned repair run';
/** Items named `backfill-finding-*` are the ones the backlog ceiling holds. */
export const BACKFILL_ITEM_PREFIX = 'backfill-finding-';

/** `bounded.drain_job`'s `(status, job, reason)`, with Python's prose reason. */
export interface DrainJobClass {
  readonly status: 'run' | 'stale' | 'skip';
  /** `null` only when the inbox file is unreadable or not a job object. */
  readonly job: JsonObject | null;
  readonly reason: string;
}

/** An `OSError`/`ValueError` reading `state/queue.json`; anything else propagates. */
export class RepairQueueUnreadableError extends Error {
  override readonly name = 'RepairQueueUnreadableError';
}

/** How a worker ended: `os.waitstatus_to_exitcode`, or an exit status lost to an interrupt. */
export type WorkerExit =
  | { readonly kind: 'exit'; readonly code: number }
  | { readonly kind: 'signal'; readonly signal: number }
  | { readonly kind: 'lost' };

/** The coordinator's view of one admitted worker (the parent end of Python's private pipe). */
export interface RepairWorkerHandle {
  /** The worker's item-gate verdict, published before it does any work. `false` also for a worker that died first. */
  readonly admitted: Promise<boolean>;
  /** True once, when the worker published a refusal after admission. Never blocks. */
  takeRefusal(): boolean;
  readonly exit: Promise<WorkerExit>;
}

/** The child end of the pipe: one byte per decision, never persisted. */
export interface WorkerChannel {
  publish(signal: 'admitted' | 'refused'): void;
}

export interface RepairProcessContext {
  /** Python `publish_refusal()`: a no-op outside a worker. */
  publishRefusal(): void;
}

export interface RepairDrainEffects extends PassGateEffects {
  /** `config['repair'].get('max_concurrent_items', 1)`: `undefined` when absent, else the parsed value. */
  maxConcurrentItems(): Promise<JsonValue | undefined>;
  /** `dispatch_paused(config)`: the pause text while a provider pause is live. */
  dispatchPaused(): Promise<string | null>;
  /** `blocked(config['repair'])`: the GLM peak blackout, or a dispatch that would reach it. */
  blocked(): boolean;
  /** `fetch_clone`: an error string skips the pass. */
  fetchClone(): Promise<string | null>;
  /** `triage_phase`: the report, or `null` when triage is not configured. A throw defers triage. */
  triage(): Promise<JsonValue | null>;
  /** `drain_order(ROOT)`: inbox job ids, oldest first. */
  inboxOrder(): Promise<readonly string[]>;
  /** The job file's `item`; `undefined` when the file is unreadable or not an object. */
  inboxItem(jobId: string): Promise<unknown>;
  /** `state/queue.json`, or `{items: []}` when absent. Throws `RepairQueueUnreadableError`. */
  readQueue(): Promise<JsonValue>;
  /** `state/repair/fix-pr-backlog.json`; `undefined` when missing or unreadable. */
  readBacklog(): Promise<JsonValue | undefined>;
  nowMs(): number;
  /** `bounded.drain_job` against the queue just read. */
  classifyJob(queue: JsonValue, jobId: string): Promise<DrainJobClass>;
  /** `unreadable_result`: a `result.json` that exists but cannot be classified. */
  unreadableResult(jobId: string): Promise<boolean>;
  /** `pending`: true unless the job has a terminal, non-deferred result. */
  pending(jobId: string): Promise<boolean>;
  /** `mark_stale`: the terminal, spend-free STALE result the tick harvests. */
  markStale(job: JsonObject, reason: string): Promise<void>;
  /** `process_item`: serial findings of one item; resolves with the admission outcome. */
  processItem(jobs: JsonObject[], context: RepairProcessContext): Promise<string | null>;
  /** `cooldown_write`: `state/tick.lock`, held only across one admission. */
  withAdmissionLock<T>(admission: () => Promise<T>): Promise<T>;
  /** Start `runRepairWorker(item, ids, ...)` in an isolated worker (Python's fork). */
  startWorker(item: string, jobIds: readonly string[]): RepairWorkerHandle;
}

export interface RepairDrainResult {
  status: 'drained' | 'error';
  triage?: JsonValue;
  error?: string;
}

const pyText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `worker_limit`: an integer 1..10, default 1; booleans, floats and null are refused. */
export function workerLimit(raw: JsonValue | undefined): number {
  if (raw === undefined) return 1;
  if (
    raw instanceof JsonNumber &&
    raw.kind === 'int' &&
    raw.integer !== null &&
    raw.integer >= 1n &&
    raw.integer <= 10n
  ) {
    return Number(raw.integer);
  }
  throw new Error('repair.max_concurrent_items must be an integer from 1 to 10');
}

type Groups = Map<string, string[]>;

/** The backlog numbers Python accepts, or `null` for a missing, unreadable, stale or future file. */
function backlogView(
  data: JsonValue | undefined,
  nowMs: number,
): { readonly open: bigint; readonly limit: bigint } | null {
  if (!(data instanceof JsonObject)) return null;
  const at = data.get('at');
  const open = data.get('open');
  const limit = data.get('limit');
  // `str(data['at'])`: only a string can parse; any other value raises ValueError.
  if (typeof at !== 'string') return null;
  const instant = parseUtcUnchecked(at);
  // A naive timestamp raises TypeError against an aware `now`.
  if (instant === null || !utcHasOffset(at)) return null;
  const ageMicros = BigInt(nowMs) * 1000n - instant;
  if (ageMicros < 0n || ageMicros > BigInt(BACKLOG_MAX_AGE_SECONDS) * 1_000_000n) return null;
  const isInt = (v: JsonValue | undefined): v is JsonNumber =>
    v instanceof JsonNumber && v.kind === 'int' && v.integer !== null;
  if (!isInt(open) || !isInt(limit)) return null;
  return { open: open.integer!, limit: limit.integer! };
}

/**
 * `hold_backfill_groups`: admit at most `limit - open` dispatchable backfill groups.
 *
 * The drain never calls GitHub, so it reads the file the tick wrote. A missing,
 * unreadable, stale or future-dated file, or `open >= limit`, holds every backfill
 * group. A group that cannot dispatch takes no slot and passes through unchanged.
 * Held jobs stay in the inbox: nothing is failed, marked stale or counted as a retry.
 */
export async function holdBackfillGroups(
  groups: Groups,
  backlog: JsonValue | undefined,
  nowMs: number,
  dispatchable: (item: string) => Promise<boolean>,
  narrate: (message: string) => void,
): Promise<Groups> {
  const held = [...groups.keys()].filter((item) => item.startsWith(BACKFILL_ITEM_PREFIX));
  if (held.length === 0) return groups;
  const view = backlogView(backlog, nowMs);
  let budget = view === null || view.limit <= view.open ? 0n : view.limit - view.open;
  const drop = new Set<string>();
  if (budget === 0n) {
    for (const item of held) drop.add(item);
  } else {
    for (const item of held) {
      if (!(await dispatchable(item))) continue;
      if (budget > 0n) budget -= 1n;
      else drop.add(item);
    }
  }
  if (drop.size > 0) {
    narrate(
      `backfill repair held: ${view === null ? 'unknown' : view.open} open fix PRs, limit ${
        view === null ? 'unknown' : view.limit
      }`,
    );
  }
  return new Map([...groups].filter(([item]) => !drop.has(item)));
}

/** Python's `drain_item(...) in ('rate-limit', RUNNER_DISABLED_OUTCOME)` stop test. */
const stopsPass = (outcome: string | null): boolean =>
  outcome === 'rate-limit' || outcome === RUNNER_DISABLED_OUTCOME;

/**
 * `drain_item`: gate, re-read the queue, classify this item's jobs, mark stale
 * ones, hold runs with an unreadable result, then hand the rest to `processItem`.
 * A marker that appeared during the pass stops the next admission; the item
 * already running is never interrupted.
 */
export async function drainItem(
  effects: RepairDrainEffects,
  item: string,
  jobIds: readonly string[],
  publishRefusal: () => void,
): Promise<string | null> {
  if (!(await admit({ stage: 'item-not-admitted', item }, effects))) {
    publishRefusal();
    return RUNNER_DISABLED_OUTCOME;
  }
  if (effects.blocked() || (await effects.dispatchPaused())) return 'rate-limit';
  // Re-read the queue per item: the tick may harvest or the tip may move while
  // an earlier item runs.
  let queue: JsonValue;
  try {
    queue = await effects.readQueue();
  } catch (error) {
    if (!(error instanceof RepairQueueUnreadableError)) throw error;
    // An external write between the pass's read and this one must not abort the
    // pass and lose the folded triage report: skip this item.
    effects.narrate(
      `repair item ${item} skipped: queue unreadable: ${pyText(error).slice(0, 300)}`,
    );
    return null;
  }
  const jobs: JsonObject[] = [];
  const heldRuns = new Set<string>();
  for (const jobId of jobIds) {
    const { status, job, reason } = await effects.classifyJob(queue, jobId);
    if (job === null || job.get('item') !== item) continue;
    if (status === 'stale') {
      await effects.markStale(job, reason);
      effects.narrate(`repair ${jobId}: stale, not dispatched: ${reason}`);
      // It stays in its run's chain; process returns the terminal result.
      jobs.push(job);
    } else if (status === 'run') {
      if (await effects.unreadableResult(jobId)) {
        // A malformed result.json is tick-owned evidence: it is excluded from
        // dispatch here and in the priority sort instead of crashing the drain.
        effects.narrate(
          `repair ${jobId}: skipped: unreadable result.json preserved for tick reconciliation`,
        );
        // Later jobs of the same run chain from this job's possible FIXED commit;
        // without its result they would start from a base that omits it.
        heldRuns.add(String(job.get('run')));
      } else {
        jobs.push(job);
      }
    } else if (reason !== NO_QUEUED_RUN_REASON) {
      effects.narrate(`repair ${jobId}: skipped: ${reason}`);
    }
  }
  if (heldRuns.size > 0) {
    for (const run of [...heldRuns].sort()) {
      effects.narrate(`repair run ${run}: held: a job has an unreadable result.json`);
    }
    for (let index = jobs.length - 1; index >= 0; index -= 1) {
      if (heldRuns.has(String(jobs[index]!.get('run')))) jobs.splice(index, 1);
    }
  }
  let anyPending = false;
  for (const job of jobs) {
    if (await effects.pending(String(job.get('job')))) {
      anyPending = true;
      break;
    }
  }
  if (!anyPending) return null;
  try {
    return await effects.processItem(jobs, { publishRefusal });
  } catch (error) {
    // A failed item must not stop other items.
    effects.narrate(`repair item ${item} failed: ${pyText(error).slice(0, 300)}`);
    return null;
  }
}

/** Worker exit code for an item outcome: 2 provider pause, 3 runner disabled, else 0. */
export function workerExitCode(outcome: string | null): number {
  return outcome === 'rate-limit' ? 2 : outcome === RUNNER_DISABLED_OUTCOME ? 3 : 0;
}

/**
 * The body of one isolated worker (Python's forked child). The item gate is
 * decided and published before any work, because the coordinator blocks on that
 * signal and a refusal must not be overtaken by its next admission. Resolves with
 * the process exit code; an exception is exit code 1.
 */
export async function runRepairWorker(
  effects: RepairDrainEffects,
  item: string,
  jobIds: readonly string[],
  channel: WorkerChannel,
): Promise<number> {
  try {
    if (!(await admit({ stage: 'item-not-admitted', item }, effects))) {
      channel.publish('refused');
      return 3;
    }
    channel.publish('admitted');
    return workerExitCode(await drainItem(effects, item, jobIds, () => channel.publish('refused')));
  } catch {
    return 1;
  }
}

/** An in-memory `WorkerChannel` plus the coordinator's read end. */
export function createWorkerChannel(): WorkerChannel &
  Pick<RepairWorkerHandle, 'admitted' | 'takeRefusal'> & { close(): void } {
  let settle: (admitted: boolean) => void = () => undefined;
  const admitted = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  let first = true;
  let pending = 0;
  return {
    admitted,
    publish(signal) {
      if (first) {
        first = false;
        settle(signal === 'admitted');
      } else if (signal === 'refused') {
        pending += 1;
      }
    },
    takeRefusal() {
      if (pending === 0) return false;
      pending = 0;
      return true;
    },
    /** A worker that exits before publishing reads as EOF: not admitted. */
    close() {
      if (first) {
        first = false;
        settle(false);
      }
    },
  };
}

interface ActiveWorker {
  readonly item: string;
  readonly handle: RepairWorkerHandle;
  /** Resolves once `state.exit` is recorded; never rejects. */
  readonly done: Promise<void>;
  readonly state: { exit: WorkerExit | null };
}

function exitMessage(exit: WorkerExit): string | null {
  if (exit.kind === 'lost') {
    return 'worker exit status lost to an interrupt; stopping new admission';
  }
  if (exit.kind === 'signal') return `worker terminated by signal ${exit.signal}`;
  if (exit.code === 0) return null;
  return exit.code === 2
    ? 'provider pause; stopping new admission'
    : exit.code === 3
      ? 'runner disabled; stopping new admission'
      : `worker exited with code ${exit.code}`;
}

/**
 * `drain_items`: one coordinator owns admission; workers run isolated up to the
 * limit, with serial findings inside each item. Never kills a paid worker: on an
 * abort or an admission failure, admitted workers are reaped before returning.
 */
export async function drainItems(
  effects: RepairDrainEffects,
  groups: Groups,
  order: readonly string[],
  limit: number,
): Promise<void> {
  const active = new Set<ActiveWorker>();
  let stopped = false;

  const reapCompleted = (): { failed: boolean; reaped: boolean } => {
    let failed = false;
    let reaped = false;
    for (const worker of [...active]) {
      const exit = worker.state.exit;
      if (exit === null) continue;
      active.delete(worker);
      reaped = true;
      const message = exitMessage(exit);
      if (message !== null) {
        effects.narrate(`repair item ${worker.item}: ${message}`);
        failed = true;
      }
    }
    return { failed, reaped };
  };
  const reapItem = async (): Promise<boolean> => {
    for (;;) {
      const { failed, reaped } = reapCompleted();
      if (reaped) return failed;
      await Promise.race([...active].map((worker) => worker.done));
    }
  };
  /** A refusal byte from any admitted worker; stops admission before its exit status arrives. */
  const refusalPublished = (): boolean => {
    for (const worker of active) if (worker.handle.takeRefusal()) return true;
    return false;
  };

  try {
    for (const item of order) {
      while (active.size >= limit) stopped = (await reapItem()) || stopped;
      stopped = reapCompleted().failed || stopped;
      stopped = refusalPublished() || stopped;
      // One coordinator admission check, after any capacity wait and before the
      // next item: it covers a marker present when the item's turn arrived and one
      // written while the pass waited at the cap. The serial path's and the
      // worker's own gates are the other two lines of defence.
      if (!(await admit({ stage: 'before-item', item }, effects))) break;
      if (stopped || effects.blocked() || (await effects.dispatchPaused())) break;
      const ids = groups.get(item)!;
      if (limit === 1) {
        if (stopsPass(await drainItem(effects, item, ids, () => undefined))) break;
        continue;
      }
      // Linearize admission against provider pause writes under the same lock.
      // Neither side retains it during work.
      const handle = await effects.withAdmissionLock(async () => {
        if (await effects.dispatchPaused()) return null;
        // The lock wait can outlast an admitted worker's refusal and a marker
        // write: re-sample both while admission is still ours.
        stopped = refusalPublished() || stopped;
        if (stopped) return null;
        if (!(await admit({ stage: 'before-item', item }, effects))) return null;
        return effects.startWorker(item, ids);
      });
      if (handle === null) break;
      // Register before the barrier: an abort landing in it must still find this
      // admitted worker in `active`, or the cleanup would return beneath it.
      const state: ActiveWorker['state'] = { exit: null };
      const done = handle.exit
        .catch((): WorkerExit => ({ kind: 'lost' }))
        .then((exit) => {
          state.exit = exit;
        });
      const worker: ActiveWorker = { item, handle, state, done };
      active.add(worker);
      // Barrier: the worker publishes its item-gate verdict before any work.
      // A refusal or a dead worker latches the coordinator stop.
      let admitted: boolean;
      try {
        admitted = await handle.admitted;
      } catch {
        admitted = false;
      }
      if (!admitted) stopped = true;
    }
  } finally {
    while (active.size > 0) await reapItem();
  }
}

/** `finding.get('severity') in ('critical', 'major')` of a job object. */
function criticalOrMajor(job: JsonObject): boolean {
  const finding = job.get('finding');
  if (!(finding instanceof JsonObject)) return false;
  const severity = finding.get('severity');
  return severity === 'critical' || severity === 'major';
}

/**
 * `drain`: the automatic inbox drain, minor-only items after critical/major
 * ones. Returns the pass's JSON result, or `null` for a narrated early exit
 * (the CLI reports that as `{status: 'drained'}`).
 */
export async function runRepairDrain(
  effects: RepairDrainEffects,
): Promise<RepairDrainResult | null> {
  // Admission before any fetch, triage or write: a handed-over host must cost
  // nothing and leave the queue and inbox exactly as they are.
  if (!(await admit({ stage: 'pass-start' }, effects))) return null;
  const limit = workerLimit(await effects.maxConcurrentItems()); // before triage or any provider spend
  const until = await effects.dispatchPaused();
  if (until) {
    effects.narrate(`repair drain paused: provider rate limit until ${until}`);
    return null;
  }
  // Stale checks read origin refs; refresh them first. A failed fetch skips this pass.
  const error = await effects.fetchClone();
  if (error !== null) {
    effects.narrate(`repair drain skipped: ${error.slice(0, 200)}`);
    return null;
  }
  // A marker written while the fetch ran must stop the pass before triage
  // spends: the guard at the top was sampled before the network work.
  if (!(await admit({ stage: 'before-triage' }, effects))) return null;
  let triage: JsonValue | null = null;
  try {
    triage = await effects.triage();
  } catch (failure) {
    // Backfill deferral must not starve existing repair jobs.
    effects.narrate(`backfill triage deferred: ${pyText(failure).slice(0, 300)}`);
  }
  // The triage report rides inside the drain's result, so a caller parsing
  // stdout reads exactly one JSON value even on a pass triage ran.
  const result: RepairDrainResult = { status: 'drained' };
  if (triage !== null) result.triage = triage;
  if (await effects.dispatchPaused()) return result;

  const groups: Groups = new Map(); // item -> job ids, items in order of their oldest job
  for (const jobId of await effects.inboxOrder()) {
    const item = await effects.inboxItem(jobId);
    if (typeof item !== 'string') continue;
    const ids = groups.get(item);
    if (ids === undefined) groups.set(item, [jobId]);
    else ids.push(jobId);
  }
  // Classify against the queue before sorting. Skipped, stale and completed jobs
  // cannot promote a minor-only item; the sort is stable, retaining inbox order.
  let queue: JsonValue;
  try {
    queue = await effects.readQueue();
  } catch (failure) {
    if (!(failure instanceof RepairQueueUnreadableError)) throw failure;
    // An unreadable queue must still yield one JSON artifact: keep the completed
    // triage report and let the CLI exit non-zero. Nothing was admitted yet, so
    // no spend or child is left behind.
    const message = `queue unreadable: ${pyText(failure).slice(0, 300)}`;
    effects.narrate(`repair drain failed: ${message}`);
    result.status = 'error';
    result.error = message;
    return result;
  }
  const runnable = async (item: string, jobId: string): Promise<JsonObject | null> => {
    const { status, job } = await effects.classifyJob(queue, jobId);
    if (
      status === 'run' &&
      job !== null &&
      job.get('item') === item &&
      !(await effects.unreadableResult(jobId)) &&
      (await effects.pending(jobId))
    ) {
      return job;
    }
    return null;
  };
  const held = await holdBackfillGroups(
    groups,
    await effects.readBacklog(),
    effects.nowMs(),
    async (item) => {
      for (const jobId of groups.get(item)!) {
        if ((await runnable(item, jobId)) !== null) return true;
      }
      return false;
    },
    effects.narrate,
  );
  const rank = new Map<string, number>();
  for (const [item, ids] of held) {
    let first = 1;
    for (const jobId of ids) {
      const job = await runnable(item, jobId);
      if (job !== null && criticalOrMajor(job)) {
        first = 0;
        break;
      }
    }
    rank.set(item, first);
  }
  const order = [...held.keys()].sort((left, right) => rank.get(left)! - rank.get(right)!);
  await drainItems(effects, held, order, limit);
  return result;
}

/** `run`'s tail: the one JSON artifact and the exit code for a drain result. */
export function drainOutcome(result: RepairDrainResult | null): {
  readonly exitCode: 0 | 1;
  readonly artifact: RepairDrainResult;
} {
  const artifact = result ?? { status: 'drained' as const };
  return { exitCode: artifact.status === 'error' ? 1 : 0, artifact };
}
