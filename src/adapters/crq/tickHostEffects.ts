/**
 * Real bindings for four small tick/slot phases (S6-0): `fetch`, `notifyOwner`,
 * `readSlotUsage` and `recordCoverage`. Inactive: only `composeTick.ts` binds
 * them, and no runtime entry point imports that module yet.
 *
 * Python oracles (apps/crq-python/crq.py): `fetch` (:317, through `git`/`run`
 * at :124-134), `notify_owner`/`notify` (:1979-1997), `read_slot_usage`
 * (:3340) and the tick's `coverage.record_opportunity` call.
 */
import { execFile } from 'node:child_process';
import { recordTickOpportunity } from '../../policy/crq/coverageOpportunity.js';
import { JsonObject, toPlainJson, type JsonValue } from '../../policy/crq/jsonValue.js';
import { withObjectKeys } from '../../policy/crq/queueDoc.js';
import type { CrqRecord } from '../../policy/crq/receiptIdentity.js';
import {
  heldReservations,
  scanReservations,
  type ReservationHold,
} from '../../policy/crq/tickAdmission.js';
import type { VendorUsage } from '../../policy/crq/usageSlots.js';
import type { TickPhases } from '../../queue-runner/tickOrchestrator.js';
import { spawnNotifySend, type NotifySendResult } from './notifySource.js';
import { fileTickEffects, type TickEffects } from './tickSource.js';

/** Python `subprocess.run(..., timeout=600)` default of `crq.run`. */
const RUN_TIMEOUT_MS = 600_000;

/** Python's `str.strip()[:n]`, counted in code points. */
function stripPrefix(text: string, n: number): string {
  return Array.from(text.trim()).slice(0, n).join('');
}

/** One `git` call in `cwd`, unhardened like Python's `run(["git", ...])`. */
export type GitRunner = (
  cwd: string,
  args: readonly string[],
) => Promise<{ readonly code: number | null; readonly stderr: string }>;

const execGit: GitRunner = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stderr });
          return;
        }
        const code = (error as { code?: unknown }).code;
        // A spawn failure (ENOENT) or a timeout kill is Python's OSError /
        // TimeoutExpired: it propagates and abandons the tick.
        if (typeof code !== 'number') {
          reject(error);
          return;
        }
        resolve({ code, stderr });
      },
    );
  });

/**
 * `crq.fetch()` for the primary clone: `git fetch --prune --quiet origin`.
 * A non-zero exit raises with Python `run`'s message
 * (`' '.join(cmd[:6]) … exit N: stderr.strip()[:400]`), abandoning the tick.
 */
export function fileTickFetch(clone: string, git: GitRunner = execGit): TickPhases['fetch'] {
  return async () => {
    const argv = ['fetch', '--prune', '--quiet', 'origin'];
    const result = await git(clone, argv);
    if (result.code !== 0) {
      throw new Error(
        `${['git', ...argv].slice(0, 6).join(' ')} … exit ${String(result.code)}: ${stripPrefix(result.stderr, 400)}`,
      );
    }
  };
}

/** Python truthiness for a scalar config field (`if aid:`). */
function present(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof JsonObject) return value.entries.length > 0;
  if (typeof value === 'object') {
    return value.integer !== null ? value.integer !== 0n : value.float !== 0;
  }
  return true;
}

/**
 * `crq.notify_owner(text)`: `CONFIG.get("alerts", {})` names the destination.
 * Python raises (abandoning the tick) when `alerts` is not a dict, and when a
 * truthy agent id or host is not a string (`subprocess` rejects the argv);
 * a falsy agent id sends nothing. The send result is ignored, as in `tick`.
 */
export function notifyOwnerFrom(
  config: JsonObject,
  send: (destination: JsonObject, text: string) => Promise<NotifySendResult> = spawnNotifySend,
): TickPhases['notifyOwner'] {
  return async (message) => {
    const alerts = config.has('alerts') ? config.get('alerts') : new JsonObject([]);
    if (!(alerts instanceof JsonObject)) {
      throw new TypeError("config 'alerts' must be an object");
    }
    const agent = alerts.get('alert_agent_id');
    if (!present(agent)) return;
    const host = alerts.get('alert_agent_host');
    if (typeof agent !== 'string' || (present(host) && typeof host !== 'string')) {
      throw new TypeError('alert_agent_id and alert_agent_host must be strings');
    }
    await send(
      new JsonObject([
        ['paseo_agent_id', agent],
        ['paseo_host', present(host) ? (host as string) : null],
      ]),
      message,
    );
  };
}

/** The usage probe's result, carrying the queue with `vendor_observed` marks. */
export interface SlotUsageRead {
  readonly queue: JsonObject;
  readonly usage: VendorUsage | null;
  readonly reserved: readonly ReservationHold[];
}

/** Set `items[index].run.vendor_observed = true`, as Python's in-place write. */
function markObserved(queue: JsonObject, indices: ReadonlySet<number>): JsonObject {
  if (indices.size === 0) return queue;
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new TypeError('queue.items must be an array');
  const marked = items.map((item, index) => {
    if (!indices.has(index) || !(item instanceof JsonObject)) return item;
    const run = item.get('run');
    if (!(run instanceof JsonObject)) return item;
    return withObjectKeys(item, [['run', withObjectKeys(run, [['vendor_observed', true]])]]);
  });
  return withObjectKeys(queue, [['items', marked]]);
}

/**
 * `crq.read_slot_usage(q)`: subtract reservations lacking vendor evidence
 * before the usage snapshot. Vendor progress is probed for each candidate in
 * queue order, THEN usage is read (a run that starts reporting mid-pass stays
 * held). Only a successful usage read marks the observed runs
 * `vendor_observed`; an unavailable read folds them back into the held list.
 */
export function fileReadSlotUsage(input: {
  readonly clone: string;
  readonly probes: Pick<TickEffects, 'vendorProgress' | 'readUsage'>;
}): (queue: JsonObject) => Promise<SlotUsageRead> {
  return async (queue) => {
    const plain = toPlainJson(queue) as CrqRecord;
    const progressed = new Set<string>();
    // A `true` predicate lists every unobserved reviewing run with a run id,
    // in queue order: exactly the runs Python probes.
    for (const candidate of scanReservations(plain, () => true).observed) {
      if (await input.probes.vendorProgress(candidate.runId)) progressed.add(candidate.runId);
    }
    const scan = scanReservations(plain, (runId) => progressed.has(runId));
    const usage = await input.probes.readUsage(input.clone);
    const marked =
      usage === null ? queue : markObserved(queue, new Set(scan.observed.map((o) => o.itemIndex)));
    return { queue: marked, usage, reserved: heldReservations(scan, usage) };
  };
}

/** The file-backed probes for {@link fileReadSlotUsage}. */
export function fileSlotUsageProbes(
  runnerRoot: string,
  stateRoot: string,
): Pick<TickEffects, 'vendorProgress' | 'readUsage'> {
  const effects = fileTickEffects({ runnerRoot, stateRoot });
  return { vendorProgress: effects.vendorProgress, readUsage: effects.readUsage };
}

/** `q["coverage"] = coverage.record_opportunity(q.get("coverage") or new_ledger(), ...)`. */
export const recordCoverage: TickPhases['recordCoverage'] = (queue, observation) =>
  Promise.resolve(recordTickOpportunity(queue, observation));
