/**
 * Detached-run identity and liveness policy (`author_quota.identity_kind`,
 * `author_quota.run_state`, `crq.ident_pid`).
 *
 * The probes themselves (pid existence, process-group existence, `ps` command
 * lines) are effects and live in the adapter: this module only turns probe
 * answers into Python's three-state liveness decision. The direction of every
 * uncertainty is deliberate and fail-closed: no absence is asserted without
 * proof, so a missing exit artifact, a malformed identity or incomplete legacy
 * ownership evidence retains capacity and requires owner disposition rather
 * than releasing a possibly-live review.
 *
 * Identity rules (`identity_kind`):
 *
 * - `managed` — the MANAGED protocol: `group_owner` equals `foreground-v1`,
 *   the pidfile names the CURRENT run, and the detached-session shape
 *   `pid == pgid == sid` holds, all positive. A crash before the queue pid is
 *   persisted leaves `queue_pid` unknown and does not invalidate it.
 * - `legacy` — a valid pid+pgid with no marker (a pre-upgrade launch); when the
 *   persisted queue pid is known it must agree.
 * - `invalid` — absent/empty/malformed, an unknown marker, a foreign run
 *   binding, a managed pidfile without the session shape, or a legacy pidfile
 *   whose pid disagrees with the persisted pid.
 */
import { JsonNumber, JsonObject } from './jsonValue.js';
import { isRecord } from './receiptIdentity.js';

/** `author_quota.GROUP_OWNER_MARKER`: written by a `timeout --foreground` runner. */
export const GROUP_OWNER_MARKER = 'foreground-v1';

/** `author_quota.run_state` and `run_liveness` result triples. */
export type RunIdentity = 'managed' | 'legacy' | 'invalid';
export type RunLiveness = 'alive' | 'harvest' | 'ambiguous';

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * `crq.ident_pid`: a positive, non-bool Python `int` pid/pgid, or null.
 *
 * A lossless {@link JsonNumber} keeps Python's `int`/`float` distinction, so a
 * recorded `42.0` is refused exactly as `isinstance(value, int)` refuses it.
 * An integer beyond `Number.MAX_SAFE_INTEGER` is refused too: it cannot be a
 * real pid, and rounding it would invent an identity.
 */
export function identPid(value: unknown): number | null {
  if (value instanceof JsonNumber) {
    if (value.kind !== 'int' || value.integer === null) return null;
    if (value.integer <= 0n || value.integer > MAX_SAFE_INTEGER) return null;
    return Number(value.integer);
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** A pidfile record: the plain object a caller built or the lossless one it parsed. */
type Pidfile = Record<string, unknown> | JsonObject;

function recordOf(value: unknown): Pidfile | null {
  if (value instanceof JsonObject) return value;
  return isRecord(value) ? value : null;
}

function field(record: Pidfile, key: string): unknown {
  return record instanceof JsonObject ? record.get(key) : record[key];
}

/**
 * `author_quota.identity_kind`. `runId` and `queuePid` are the CURRENT item's
 * values; `null`/`undefined` mean Python's `None` (unknown, not a mismatch).
 */
export function identityKind(
  pidfile: unknown,
  options: { runId?: unknown; queuePid?: unknown } = {},
): RunIdentity {
  const record = recordOf(pidfile);
  const pid = record === null ? null : identPid(field(record, 'pid'));
  const pgid = record === null ? null : identPid(field(record, 'pgid'));
  if (record === null || pid === null || pgid === null) return 'invalid';
  const { runId, queuePid } = options;
  const knownRunId = runId !== undefined && runId !== null;
  const knownQueuePid = identPid(queuePid);
  const marker = field(record, 'group_owner');
  if (marker === undefined || marker === null) {
    // Legacy pidfiles carry no run_id/sid. A known queue pid must agree.
    if (knownQueuePid !== null && pid !== knownQueuePid) return 'invalid';
    return 'legacy';
  }
  if (marker !== GROUP_OWNER_MARKER) return 'invalid';
  if (knownRunId && field(record, 'run_id') !== runId) return 'invalid';
  const sid = identPid(field(record, 'sid'));
  if (!(sid !== null && pid === pgid && pid === sid)) return 'invalid';
  if (knownQueuePid !== null && pid !== knownQueuePid) return 'invalid';
  return 'managed';
}

/** Probe answers for one detached run. */
export interface RunLivenessProbes {
  /** A terminal `exit.json` exists. */
  readonly hasExit: boolean;
  readonly identity: RunIdentity;
  /** The recorded runner pid is alive AND its command line names this run id. */
  readonly runnerAlive: boolean;
  /** The recorded CLI pid is alive AND its command line names coderabbit. */
  readonly cliAlive: boolean;
  /** The recorded runner process group is not proved empty. */
  readonly runnerGroupAlive: boolean;
  /**
   * For a legacy launch with a recorded cli_pid: the wrapper's own process
   * group (GNU `timeout`'s default pgid), or `null` when unknown.
   */
  readonly wrapperGroupAlive: boolean | null;
}

/**
 * `author_quota.run_state`, used by both author and natural detached reviews:
 * `alive` when any matching process or probed group is live (checked even with
 * an exit artifact), `harvest` only with a terminal exit, a valid identity,
 * complete ownership evidence and nothing alive, `ambiguous` otherwise.
 */
export function runState(probes: RunLivenessProbes): RunLiveness {
  if (
    probes.runnerAlive ||
    probes.cliAlive ||
    probes.runnerGroupAlive ||
    probes.wrapperGroupAlive === true
  ) {
    return 'alive';
  }
  if (probes.identity === 'invalid') return 'ambiguous';
  if (!probes.hasExit) return 'ambiguous';
  if (probes.identity === 'legacy' && probes.wrapperGroupAlive === null) return 'ambiguous';
  return 'harvest';
}
