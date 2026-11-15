/**
 * The deploy controller's unit transaction: `switch_unit` and `recover_unit`
 * over an injected host adapter and effects seam.
 *
 * Ports `switch_unit`, `recover_unit`, `_completion` and `RecoveryRequired`
 * from `apps/crq-python/ops/deploy-controller.py`. Inactive and unimported:
 * the host (systemd, the unit files, the journal directory, the lock) lives
 * behind {@link UnitAdapter} and {@link TransactionEffects}. This is the
 * `switch --unit <unit> --runtime node:<sha>` path.
 *
 * Adapter values (snapshot, fence, completion evidence) are opaque JSON: plain
 * objects/arrays/strings/booleans/null, with integers as bigint, safe-integer
 * numbers or `JsonNumber`s. A JavaScript `1.0` is indistinguishable from `1`;
 * adapters that must express a Python float use `JsonNumber`.
 */
import {
  JsonNumber,
  parseJsonValue,
  toPlainJsonRetainingNumbers,
} from '../../../policy/crq/jsonValue.js';
import {
  JOURNAL_SCHEMA,
  UNIT_RUNTIMES,
  RecordRefused,
  refuseUnfinishedTransactions,
  type RecordEntry,
} from './controllerRecords.js';
import {
  capturedState,
  preservationCheck,
  preservedSurfaces,
  queueDrainGate,
  type GuardEffects,
  type Liveness,
} from './unitGuards.js';

type Dict = Record<string, unknown>;

/** The trusted host adapter (Python `adapter`). Methods may throw. */
export interface UnitAdapter {
  preflight(unit: string, runtime: string): Promise<unknown> | unknown;
  snapshot(unit: string): Promise<unknown> | unknown;
  validateSnapshot(unit: string, snapshot: unknown): Promise<void> | void;
  stopAndDrain(unit: string): Promise<unknown> | unknown;
  install(unit: string, runtime: string): Promise<void> | void;
  sequence(unit: string): Promise<unknown> | unknown;
  start(unit: string): Promise<void> | void;
  completion(unit: string, runtime: string, previous: bigint): Promise<unknown> | unknown;
  restore(unit: string, snapshot: unknown): Promise<void> | void;
  restoreActivation(unit: string, snapshot: unknown): Promise<void> | void;
}

/** The controller's effects seam for the transaction. */
export interface TransactionEffects extends GuardEffects {
  controllerLock<T>(body: () => Promise<T>): Promise<T>;
  recordPreflight(): Promise<void> | void;
  /** Every entry of the record directory. */
  recordEntries(): Promise<readonly RecordEntry[]> | readonly RecordEntry[];
  /** False when `path.parent != record_dir or path.is_symlink()`. */
  recordPathAllowed(path: string): Promise<boolean> | boolean;
  /** The path as `refuseUnfinishedTransactions` compares it. */
  resolvedPath(path: string): Promise<string> | string;
  /** `path.read_text()`; throws on OSError. */
  readRecordText(path: string): Promise<string> | string;
  journalAppend(record: Dict): Promise<string> | string;
  journalReplace(path: string, record: Dict): Promise<void> | void;
  liveness: Liveness;
  uuidHex(): string;
  nowIso(): string;
}

/** Python `RecoveryRequired`: the helper was entered; owner recovery needed. */
export class RecoveryRequired extends Error {
  override name = 'RecoveryRequired';
  constructor(readonly recovery: Dict) {
    super(typeof recovery['reason'] === 'string' ? recovery['reason'] : 'unit recovery required');
  }
}

const clip = (error: unknown, n: number): string =>
  Array.from(error instanceof Error ? error.message : String(error))
    .slice(0, n)
    .join('');

/** Python `type(exc).__name__` as the adapter's error class names it. */
const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

function isDict(value: unknown): value is Dict {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof JsonNumber)
  );
}

/** `type(value) is int`, as a BigInt. */
function intOf(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (value instanceof JsonNumber && value.kind === 'int') return value.integer;
  return null;
}

/** `_unit_runtime`. */
export function unitRuntimeValid(value: unknown): value is string {
  return value === 'python' || (typeof value === 'string' && /^node:[0-9a-f]{40}$/.test(value));
}

const HEX64 = /^[0-9a-f]{64}$/;
const TX_ID = /^[0-9a-f]{32}$/;

function get(record: Dict, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : null;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a instanceof JsonNumber || b instanceof JsonNumber) return false;
  return a === b;
}

/** The record validation of `recover_unit`: true when the record is invalid. */
function recoveryRecordInvalid(record: unknown): boolean {
  if (!isDict(record)) return true;
  if (record['operation'] !== 'unit_switch') return true;
  if (record['outcome'] !== 'pending' && record['outcome'] !== 'recovery_required') return true;
  if (intOf(get(record, 'schema_version')) !== JOURNAL_SCHEMA) return true;
  const tx = get(record, 'transaction_id');
  if (typeof tx !== 'string' || !TX_ID.test(tx)) return true;
  const unit = get(record, 'unit');
  if (typeof unit !== 'string' || !UNIT_RUNTIMES.has(unit)) return true;
  const runtime = get(record, 'runtime');
  const prior = get(record, 'prior_runtime');
  if (!unitRuntimeValid(runtime) || !unitRuntimeValid(prior)) return true;
  if (runtime === prior) return true;
  const snapshot = get(record, 'snapshot');
  if (!isDict(snapshot)) return true;
  if (!jsonEqual(get(snapshot, 'runtime'), prior)) return true;
  if (!Object.hasOwn(record, 'state')) return true;
  const phase = get(record, 'phase');
  const state = get(record, 'state');
  if (
    phase !== 'snapshot' &&
    phase !== 'drained' &&
    phase !== 'activation_pending' &&
    phase !== 'restore_activation_pending'
  ) {
    return true;
  }
  if (phase === 'snapshot' && state !== null) return true;
  if ((phase === 'drained' || phase === 'activation_pending') && !isDict(state)) return true;
  if (phase === 'restore_activation_pending' && state !== null && !isDict(state)) return true;
  if (isDict(state)) {
    for (const rel of preservedSurfaces(unit)) {
      const key = `preserved/${rel}`;
      if (!Object.hasOwn(state, key)) return true;
      const digest = state[key];
      if (digest !== null && !(typeof digest === 'string' && HEX64.test(digest))) return true;
    }
  }
  return false;
}

/** `_completion`: the evidence must be a successful, advancing completion. */
async function completion(
  adapter: UnitAdapter,
  unit: string,
  runtime: string,
  previous: bigint,
): Promise<Dict> {
  const evidence = await adapter.completion(unit, runtime, previous);
  const sequence = isDict(evidence) ? intOf(evidence['sequence']) : null;
  if (
    !isDict(evidence) ||
    evidence['unit'] !== unit ||
    evidence['runtime'] !== runtime ||
    evidence['success'] !== true ||
    sequence === null ||
    sequence <= previous
  ) {
    const error = new Error('invalid or non-advancing unit completion evidence');
    error.name = 'ValueError';
    throw error;
  }
  return evidence;
}

/** Python `switch_unit`. */
export async function switchUnit(
  effects: TransactionEffects,
  adapter: UnitAdapter | null,
  unit: string,
  runtime: string,
): Promise<Dict> {
  if (!UNIT_RUNTIMES.has(unit) || !unitRuntimeValid(runtime)) {
    throw new RecordRefused('invalid unit or runtime');
  }
  if (adapter === null) {
    throw new RecordRefused('no runtime-bound completion evidence provider for unit');
  }
  return effects.controllerLock(async () => {
    await effects.recordPreflight();
    refuseUnfinishedTransactions(await effects.recordEntries());
    await queueDrainGate(effects, unit, effects.liveness);
    const prior = await adapter.preflight(unit, runtime);
    if (!isDict(prior) || !unitRuntimeValid(prior['runtime'])) {
      throw new RecordRefused('invalid prior runtime');
    }
    if (prior['runtime'] === runtime) {
      throw new RecordRefused('unit already selects requested runtime');
    }
    const snapshot = await adapter.snapshot(unit);
    await adapter.validateSnapshot(unit, snapshot);
    let identity: Dict = {
      schema_version: JOURNAL_SCHEMA,
      transaction_id: effects.uuidHex(),
      operation: 'unit_switch',
      unit,
      runtime,
      prior_runtime: prior['runtime'],
      outcome: 'pending',
      at: effects.nowIso(),
      snapshot,
      state: null,
      phase: 'snapshot',
    };
    const path = await effects.journalAppend(identity);
    let record: Dict | undefined;
    try {
      await adapter.stopAndDrain(unit);
      identity = { ...identity, state: await capturedState(effects, unit), phase: 'drained' };
      await effects.journalReplace(path, identity);
      const baseline = intOf(await adapter.sequence(unit));
      if (baseline === null || baseline < 0n) {
        const error = new Error('invalid completion baseline');
        error.name = 'ValueError';
        throw error;
      }
      await adapter.install(unit, runtime);
      await preservationCheck(effects, identity['state'] as Dict, preservedSurfaces(unit));
      identity = { ...identity, phase: 'activation_pending' };
      await effects.journalReplace(path, identity);
      await adapter.start(unit);
      const first = await completion(adapter, unit, runtime, baseline);
      const second = await completion(adapter, unit, runtime, intOf(first['sequence'])!);
      record = { ...identity, outcome: 'completed', completions: [first, second] };
      await effects.journalReplace(path, record);
      return record;
    } catch (exc) {
      try {
        const failedPhase = identity['phase'];
        const fence = await adapter.stopAndDrain(unit);
        await adapter.restore(unit, snapshot);
        if (identity['state'] !== null) {
          await preservationCheck(effects, identity['state'] as Dict, preservedSurfaces(unit));
        }
        identity = {
          ...identity,
          phase: 'restore_activation_pending',
          failed_phase: failedPhase,
          fence,
          reason: clip(exc, 400),
        };
        await effects.journalReplace(path, identity);
        await adapter.restoreActivation(unit, snapshot);
        record = { ...identity, outcome: 'rolled_back' };
        await effects.journalReplace(path, record);
      } catch (rollbackExc) {
        const recovery: Dict = {
          ...identity,
          outcome: 'recovery_required',
          record_path: path,
          reason: `${clip(exc, 200)}; rollback: ${clip(rollbackExc, 200)}`,
        };
        try {
          await effects.journalReplace(path, recovery);
        } catch {
          // The retained pending intent remains the recovery anchor.
        }
        throw new RecoveryRequired(recovery);
      }
      throw new RecoveryRequired({ ...record, record_path: path });
    }
  });
}

/** Python `recover_unit`. */
export async function recoverUnit(
  effects: TransactionEffects,
  adapter: UnitAdapter | null,
  path: string,
  adapterFactory?: (unit: string, priorRuntime: string) => UnitAdapter | null,
): Promise<Dict> {
  if (adapter === null && adapterFactory === undefined) {
    throw new RecordRefused('no unit recovery adapter');
  }
  return effects.controllerLock(async () => {
    await effects.recordPreflight();
    if (!(await effects.recordPathAllowed(path))) {
      throw new RecordRefused('invalid controller transaction record path');
    }
    refuseUnfinishedTransactions(await effects.recordEntries(), await effects.resolvedPath(path));
    let parsed: unknown;
    try {
      parsed = toPlainJsonRetainingNumbers(parseJsonValue(await effects.readRecordText(path)));
    } catch {
      throw new RecordRefused('unreadable unit recovery record');
    }
    if (recoveryRecordInvalid(parsed)) throw new RecordRefused('invalid unit recovery record');
    let record = parsed as Dict;
    const unit = record['unit'] as string;
    await queueDrainGate(effects, unit, effects.liveness);
    let active = adapter;
    if (adapterFactory !== undefined)
      active = adapterFactory(unit, record['prior_runtime'] as string);
    if (active === null) throw new RecordRefused('no unit recovery adapter');
    await active.validateSnapshot(unit, record['snapshot']);
    try {
      const failedPhase = Object.hasOwn(record, 'failed_phase')
        ? record['failed_phase']
        : record['phase'];
      const fence = await active.stopAndDrain(unit);
      await active.restore(unit, record['snapshot']);
      if (record['state'] !== null) {
        await preservationCheck(effects, record['state'] as Dict, preservedSurfaces(unit));
      }
      record = { ...record, phase: 'restore_activation_pending', failed_phase: failedPhase, fence };
      await effects.journalReplace(path, record);
      await active.restoreActivation(unit, record['snapshot']);
      const completed = { ...record, outcome: 'rolled_back' };
      await effects.journalReplace(path, completed);
      return completed;
    } catch (exc) {
      throw new RecoveryRequired({
        ...record,
        record_path: path,
        reason: `${errorName(exc)}: ${clip(exc, 400)}`,
      });
    }
  });
}
