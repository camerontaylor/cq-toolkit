/**
 * The crq tick scheduling pass (`crq.tick` up to the first launch).
 *
 * This is the executable half of the S6 slice: it reads real state through
 * {@link TickEffects}, normalizes the queue as `load_queue` does, decides every
 * detached review's liveness with the fail-closed three-state rule, computes
 * the reservation-aware admission gate and the start order, and returns one
 * plan document plus the queue mutations a live tick would make.
 *
 * It deliberately does NOT claim completeness. A live tick also performs
 * discovery, harvest effects, per-kind launch planning and spawn, repair
 * harvest, delivery passes, backfill/coverage bookkeeping and status,
 * heartbeat and summary publication. Those are listed in
 * {@link TICK_MISSING_EFFECTS}; the value reports `complete: false` with that
 * exact list so no shadow comparison treats a partial plan as parity.
 *
 * The plan's mutations are all `{operation: 'set', target: 'queue.json#/<pointer>',
 * value}`. The only normalized change they do not carry is `load_queue`'s
 * removal of the retired `boost` key; the value counts those in
 * `normalized.boostsDropped` until an executor owns removal.
 *
 * Pointers address the loaded document, `items/<i>` being the index into the
 * raw `queue.items` array, so a reader can apply them in order without a
 * second parse.
 */
import { join } from 'node:path';
import { fileTickEffects, type TickEffects } from '../adapters/crq/tickSource.js';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../policy/crq/jsonValue.js';
import { isRecord, type CrqRecord } from '../policy/crq/receiptIdentity.js';
import { identityKind, identPid, runState, type RunLiveness } from '../policy/crq/runLiveness.js';
import { parseCrqState } from '../policy/crq/state.js';
import {
  admissionDecision,
  heldReservations,
  scanReservations,
  type AdmissionConfig,
  type AdmissionDecision,
} from '../policy/crq/tickAdmission.js';
import {
  AUTHOR_KIND,
  backgroundTurn,
  liveItems,
  rank,
  retireSupersededOpen,
  repoRanks,
  sortItems,
  type ScheduleConfig,
  type ScheduleContext,
} from '../policy/crq/tickSchedule.js';
import { TickAdmissionError } from '../policy/crq/tickAdmission.js';
import type { VendorUsage } from '../policy/crq/usageSlots.js';
import { PlannerUsageError, type Mutation, type Plan } from './runner.js';

/**
 * Everything a live tick does that this planner does not. The value's reason
 * repeats this list verbatim, so a reader never has to guess which effects are
 * missing before a switch.
 */
export const TICK_MISSING_EFFECTS: readonly string[] = [
  'merged/push/PR-enrollment discovery',
  'harvest effects (classification, receipts, cycles, coverage and repair bookkeeping)',
  'per-kind launch planning and detached spawn',
  'repair harvest and findings/PR-review delivery passes',
  'backfill usage context and rank-4 admission',
  'coverage opportunity ledger, next-slot deadline, status/heartbeat/summary publication',
];

/** The `complete: false` reason a shadow plan carries. */
export function tickIncompleteReason(): string {
  return `tick effects not implemented: ${TICK_MISSING_EFFECTS.join('; ')}`;
}

/** Values read from `config.json` that the scheduling pass consumes. */
interface TickConfig {
  readonly schedule: ScheduleConfig;
  readonly admission: AdmissionConfig;
}

function configString(config: CrqRecord, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || value === '') {
    throw new TickAdmissionError(`config.${key} must be a non-empty string`);
  }
  return value;
}

function configInteger(config: CrqRecord, key: string, fallback: number): number {
  const value = config[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TickAdmissionError(`config.${key} must be an integer`);
  }
  return value;
}

/** `crq.CONFIG` bindings this pass needs, with Python's `.get` defaults. */
export function readTickConfig(config: CrqRecord): TickConfig {
  return {
    schedule: {
      primaryRepo: configString(config, 'repo'),
      repos: repoRanks(config),
      localReviewAgingMinutes: configInteger(config, 'local_review_aging_minutes', 60),
    },
    admission: {
      maxStartsPerHour: configInteger(config, 'max_starts_per_hour', 5),
      maxStartsPerTick: configInteger(config, 'max_starts_per_tick', 10),
      maxInflight: configInteger(config, 'max_inflight', 10),
    },
  };
}

/** One detached review's probe answers, resolved by the caller. */
export interface RunObservation {
  readonly itemIndex: number;
  readonly liveness: RunLiveness;
}

/** Everything the pure plan builder may read. */
export interface TickObservation {
  readonly queue: CrqRecord;
  readonly config: CrqRecord;
  readonly nowMicros: bigint;
  /** `usage_slots.read_usage`, or null when unavailable. */
  readonly usage: VendorUsage | null;
  /** Run ids whose review stream shows bounded positive vendor progress. */
  readonly observedRunIds: ReadonlySet<string>;
  /** Liveness for every `reviewing` item that records a run. */
  readonly runs: readonly RunObservation[];
}

/** The plan value. Field order is stable for the shadow record. */
export interface TickPlanValue {
  readonly complete: false;
  readonly reason: string;
  readonly admission: {
    readonly usage: VendorUsage | null;
    readonly reserved: readonly unknown[];
    readonly slots: number;
    readonly admissions: number;
    readonly gate: AdmissionDecision['gate'];
    readonly inflight: number;
    readonly startsLastHour: number;
    readonly log: readonly string[];
  };
  readonly harvest: {
    readonly alive: readonly string[];
    readonly ambiguous: readonly string[];
    readonly harvestable: readonly string[];
  };
  readonly normalized: {
    readonly retired: readonly string[];
    readonly boostsDropped: number;
  };
  readonly candidates: readonly {
    readonly id: string;
    readonly kind: unknown;
    readonly rank: number;
    readonly order: number;
    readonly operatorPriority: boolean;
  }[];
  readonly backgroundTurn: boolean;
}

const CANDIDATE_LIMIT = 50;

function itemPointer(index: number, field: string): string {
  return `queue.json#/items/${index}/${field}`;
}

/** Python's `iso()` for one microsecond reading: second precision, `Z`. */
export function isoSeconds(micros: bigint): string {
  const milliseconds = Number(micros / 1000n);
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Python's wait-reason text for a live or unreleasable detached review. */
function waitReasonFor(kind: unknown, liveness: RunLiveness): string {
  const author = kind === AUTHOR_KIND;
  if (liveness === 'alive') {
    return author ? 'author: run alive' : 'detached review still alive';
  }
  return author
    ? 'author: run not releasable (unverifiable identity, missing exit, or ' +
        'incomplete legacy ownership) — capacity retained, owner disposition required'
    : 'run not releasable (unverifiable identity, missing exit, or incomplete ' +
        'legacy ownership) — capacity retained, owner disposition required';
}

/**
 * Build the tick plan from observed state. Pure apart from mutating the queue
 * document it is given (`load_queue`'s in-memory normalization), which the
 * caller owns.
 */
export function buildTickPlan(observation: TickObservation): Plan {
  const config = readTickConfig(observation.config);
  const queue = observation.queue;
  const rawItems = queue.items;
  if (!Array.isArray(rawItems)) throw new TickAdmissionError('queue.items must be an array');
  const items: unknown[] = rawItems;
  const boostsDropped = items.filter(
    (item) => isRecord(item) && Object.hasOwn(item, 'boost'),
  ).length;
  const retired = retireSupersededOpen(queue);
  const context: ScheduleContext = {
    config: config.schedule,
    nowMicros: observation.nowMicros,
  };
  const mutations: Mutation[] = [];
  for (const entry of retired) {
    mutations.push(
      { operation: 'set', target: itemPointer(entry.index, 'state'), value: entry.state },
      { operation: 'set', target: itemPointer(entry.index, 'not_before'), value: null },
      { operation: 'set', target: itemPointer(entry.index, 'last_error'), value: null },
    );
  }

  const harvest = { alive: [] as string[], ambiguous: [] as string[], harvestable: [] as string[] };
  for (const run of observation.runs) {
    const item = items[run.itemIndex];
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id : '';
    if (run.liveness === 'harvest') {
      harvest.harvestable.push(id);
      continue;
    }
    harvest[run.liveness].push(id);
    mutations.push({
      operation: 'set',
      target: itemPointer(run.itemIndex, 'wait_reason'),
      value: waitReasonFor(item.kind, run.liveness),
    });
  }

  const scan = scanReservations(queue, (runId) => observation.observedRunIds.has(runId));
  const held = heldReservations(scan, observation.usage);
  const decision = admissionDecision({
    queue,
    usage: observation.usage,
    held,
    config: config.admission,
    nowMicros: observation.nowMicros,
  });
  mutations.push(
    { operation: 'set', target: 'queue.json#/usage', value: observation.usage },
    {
      operation: 'set',
      target: 'queue.json#/backfill_starts_at_observation',
      value: Array.isArray(queue.starts) ? queue.starts.length : 0,
    },
  );
  if (observation.usage !== null) {
    // Only a successful usage read proves the vendor counted these starts.
    for (const observed of scan.observed) {
      mutations.push({
        operation: 'set',
        target: `queue.json#/items/${observed.itemIndex}/run/vendor_observed`,
        value: true,
      });
    }
  }

  const pending = sortItems(
    liveItems(queue).filter((item) => item.state === 'pending'),
    context,
  );
  const candidates = pending.slice(0, CANDIDATE_LIMIT).map((item) => ({
    id: typeof item.id === 'string' ? item.id : '',
    kind: item.kind,
    rank: rank(item, context),
    order: typeof item.order === 'number' ? item.order : 999,
    operatorPriority: item.operator_priority === true,
  }));

  mutations.push({
    operation: 'set',
    target: 'queue.json#/last_tick',
    value: isoSeconds(observation.nowMicros),
  });

  const value: TickPlanValue = {
    complete: false,
    reason: tickIncompleteReason(),
    admission: {
      usage: observation.usage,
      reserved: held.map((hold) => hold.startedAt),
      slots: decision.slots,
      admissions: decision.admissions,
      gate: decision.gate,
      inflight: decision.inflight,
      startsLastHour: decision.startsLastHour,
      log: decision.log,
    },
    harvest,
    normalized: {
      retired: retired.map((entry) => entry.id),
      boostsDropped,
    },
    candidates,
    backgroundTurn: backgroundTurn(queue),
  };
  return { value, mutations };
}

/** `crq.proc_cmdline(pid).contains(text)` with Python's empty-string semantics. */
function commandNames(command: string, text: string): boolean {
  return command !== '' && command.includes(text);
}

/**
 * Resolve one detached review's probe answers from the recorded identity, the
 * exit artifact and the process probes, exactly as `crq.run_liveness` does.
 */
async function observeRun(
  item: CrqRecord,
  itemIndex: number,
  effects: TickEffects,
): Promise<RunObservation> {
  const run = isRecord(item.run) ? item.run : null;
  const runId = run === null ? undefined : run.run_id;
  if (typeof runId !== 'string' || runId === '') {
    throw new TickAdmissionError(
      `queue.items/${itemIndex}: a reviewing item must record run.run_id`,
    );
  }
  const pidfile = await effects.readPidfile(runId);
  const kind = identityKind(pidfile, { runId, queuePid: run?.pid });
  const pidfileRecord = pidfile instanceof JsonObject ? pidfile : null;
  const pidField = pidfileRecord === null ? undefined : pidfileRecord.get('pid');
  const cliField = pidfileRecord === null ? undefined : pidfileRecord.get('cli_pid');
  const pgidField = pidfileRecord === null ? undefined : pidfileRecord.get('pgid');
  const pid = identPid(pidField) ?? identPid(run?.pid);
  const cli = identPid(cliField);
  const runnerAlive =
    pid !== null && effects.pidAlive(pid) && commandNames(await effects.processCommand(pid), runId);
  const cliAlive =
    cli !== null &&
    effects.pidAlive(cli) &&
    commandNames(await effects.processCommand(cli), 'coderabbit');
  const pgid = identPid(pgidField);
  const runnerGroupAlive = pgid !== null && effects.groupAlive(pgid);
  const wrapperGroupAlive = kind === 'legacy' && cli !== null ? effects.groupAlive(cli) : null;
  const liveness = runState({
    hasExit: await effects.runExited(runId),
    identity: kind,
    runnerAlive,
    cliAlive,
    runnerGroupAlive,
    wrapperGroupAlive,
  });
  return { itemIndex, liveness };
}

/** Parse a JSON document that must be an object (queue, config). */
function parseObject(name: string, text: string): CrqRecord {
  let value: JsonValue;
  try {
    value = parseJsonValue(text, { duplicates: 'last' });
  } catch (error) {
    throw new TickAdmissionError(
      `${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!(value instanceof JsonObject)) throw new TickAdmissionError(`${name} is not an object`);
  const plain = toPlainJson(value);
  if (!isRecord(plain)) throw new TickAdmissionError(`${name} is not an object`);
  return plain;
}

/**
 * Plan one tick from real state. `effects` defaults to the file/process
 * binding for `root`; tests supply a temp-root binding.
 */
export async function planTick(
  root: string,
  command: string,
  args: string[],
  effects: TickEffects = fileTickEffects({
    runnerRoot: root,
    stateRoot: join(root, 'state'),
  }),
): Promise<Plan> {
  if (command !== 'tick') throw new Error(`${command} is not implemented`);
  if (args.length !== 0) throw new PlannerUsageError('tick does not accept these arguments');
  if (await effects.runnerDisabled()) {
    return {
      value: { complete: false, disabled: true, reason: 'runner disabled for host handover' },
      mutations: [],
    };
  }
  const config = parseObject('config.json', await effects.readConfig());
  const clone = configString(config, 'clone');
  const queueText = await effects.readQueue();
  const accepted = parseCrqState('queue.schema.json', queueText);
  if (!accepted.ok) {
    throw new TickAdmissionError(
      `queue.json rejected by policy/crq/queue.schema.json: ${accepted.issues.join('; ') || 'no detail'}`,
    );
  }
  if (!isRecord(accepted.value)) throw new TickAdmissionError('queue.json is not an object');
  const queue = accepted.value;

  const nowMicros = effects.nowMicros();
  const observedRunIds = new Set<string>();
  const runs: RunObservation[] = [];
  const rawItems = queue.items;
  if (!Array.isArray(rawItems)) throw new TickAdmissionError('queue.items must be an array');
  const items: unknown[] = rawItems;
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];
    if (!isRecord(item) || item.state !== 'reviewing' || !isRecord(item.run)) continue;
    runs.push(await observeRun(item, itemIndex, effects));
  }
  // Every reservation candidate, before the progress probe answers: a
  // predicate of `true` puts each unobserved reviewing run in `observed`, and
  // `buildTickPlan` re-scans with the real set.
  for (const candidate of scanReservations(queue, () => true).observed) {
    if (await effects.vendorProgress(candidate.runId)) observedRunIds.add(candidate.runId);
  }
  // Read usage only after the progress scan. A run that starts reporting
  // progress mid-pass then stays in the snapshot's blind spot: the snapshot
  // may not count its consumption, so releasing its hold would overstate
  // admission. The Python oracle uses this order (`read_slot_usage`).
  const usage = await effects.readUsage(clone);

  return buildTickPlan({ queue, config, nowMicros, usage, observedRunIds, runs });
}
