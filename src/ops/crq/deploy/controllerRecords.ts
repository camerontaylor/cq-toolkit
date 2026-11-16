/**
 * Retained controller-record classification and the unfinished-transaction
 * guard of the deploy controller, over an injected record directory.
 *
 * Ports `_classify_record` (with every `*_shape` helper it uses) and
 * `refuse_unfinished_transactions` from
 * `apps/crq-python/ops/deploy-controller.py`. Inactive and unimported: this
 * module reads nothing from disk itself. The unit switch (`switch_unit`) and
 * recovery (`recover_unit`) call the guard before they touch a unit, so the
 * classifier is part of the live `switch --unit --runtime` path.
 *
 * Classification depends only on the retained record bytes, never on later host
 * state. Anything that is not a recognised producer shape refuses with a message
 * naming the record.
 */
import { compareCodePoints } from '../../../policy/crq/pythonJson.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../policy/crq/jsonValue.js';

/** Python `Refused`: a precondition failed. */
export class RecordRefused extends Error {
  override name = 'Refused';
}

/** `JOURNAL_SCHEMA`. */
export const JOURNAL_SCHEMA = 1n;

/** `UNIT_RUNTIMES`: the units a unit transaction may switch. */
export const UNIT_RUNTIMES: ReadonlySet<string> = new Set([
  'crq-tick.service',
  'crq-slot.service',
  'crq-repair.service',
  'crq-publisher.service',
  'crq-backfill.service',
  'crq-watchdog.service',
]);

const TAG_RE = /^crq-runner\/[0-9]{8}-[0-9]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const TX_RE = /^[0-9a-f]{32}$/;
const NODE_RUNTIME_RE = /^node:[0-9a-f]{40}$/;
const PHASES: readonly string[] = [
  'snapshot',
  'drained',
  'activation_pending',
  'restore_activation_pending',
];
const UNIT_TERMINAL_PHASES: Readonly<Record<string, string>> = {
  completed: 'activation_pending',
  rolled_back: 'restore_activation_pending',
};

/** One candidate file in the controller record directory. */
export interface RecordEntry {
  /** `path.name`. */
  readonly name: string;
  /** `path.is_symlink()`. */
  isSymlink(): boolean;
  /** `path.is_file()` (follows symlinks, false when missing). */
  isFile(): boolean;
  /** `path.read_text()`; throws (OSError or UnicodeDecodeError) when unreadable. */
  read(): string;
  /** `path.resolve()`, only asked for when an exclude path is given. */
  resolved(): string;
}

export type RecordStatus = 'finished' | 'unfinished';

export interface RecordClass {
  readonly status: RecordStatus;
  readonly operation: string;
}

const str = (value: JsonValue | undefined): value is string => typeof value === 'string';
const text = (value: JsonValue | undefined): boolean => typeof value === 'string' && value !== '';
const isObject = (value: JsonValue | undefined): value is JsonObject => value instanceof JsonObject;
const isInt = (value: JsonValue | undefined): value is JsonNumber =>
  value instanceof JsonNumber && value.kind === 'int';
const hex = (pattern: RegExp, value: JsonValue | undefined): boolean =>
  typeof value === 'string' && pattern.test(value);
const none = (value: JsonValue | undefined): boolean => value === null || value === undefined;

const txId = (value: JsonValue | undefined): boolean => hex(TX_RE, value);
const tag = (value: JsonValue | undefined): boolean => hex(TAG_RE, value);
const tagOrNone = (value: JsonValue | undefined): boolean => none(value) || tag(value);
const hex64OrNone = (value: JsonValue | undefined): boolean => none(value) || hex(HEX64_RE, value);

/** `_unit_runtime`: `"python"` or `node:<40 hex>`. */
export function unitRuntime(value: JsonValue | undefined): boolean {
  return value === 'python' || (typeof value === 'string' && NODE_RUNTIME_RE.test(value));
}

function planShape(value: JsonValue | undefined): boolean {
  return isObject(value) && isObject(value.get('preflight')) && Array.isArray(value.get('steps'));
}

function checkoutIdentity(record: JsonObject): boolean {
  const intended = record.get('intended_operation');
  return (
    txId(record.get('transaction_id')) &&
    text(record.get('at')) &&
    (intended === 'deploy' || intended === 'rollback') &&
    isObject(record.get('prior_state')) &&
    hex(SHA_RE, record.get('prior_head')) &&
    hex64OrNone(record.get('prior_config_sha256')) &&
    tagOrNone(record.get('prior_tag')) &&
    hex(SHA_RE, record.get('target')) &&
    tag(record.get('tag')) &&
    hex64OrNone(record.get('helper_sha256')) &&
    record.get('automatic_rollback_permitted') === false &&
    isObject(record.get('rollback_compatibility'))
  );
}

function checkoutRefusalShape(record: JsonObject): boolean {
  return (
    checkoutIdentity(record) &&
    text(record.get('failed_phase')) &&
    text(record.get('reason')) &&
    isObject(record.get('observations')) &&
    str(record.get('record_path')) &&
    typeof record.get('record_persisted') === 'boolean'
  );
}

function checkoutRecoveryShape(record: JsonObject): boolean {
  return (
    checkoutIdentity(record) &&
    text(record.get('failed_phase')) &&
    text(record.get('reason')) &&
    str(record.get('record_path')) &&
    typeof record.get('record_persisted') === 'boolean' &&
    (!record.has('observed_head') || hex(SHA_RE, record.get('observed_head'))) &&
    (!record.has('head_observation_error') || str(record.get('head_observation_error'))) &&
    (!record.has('record_write_error') || str(record.get('record_write_error')))
  );
}

function completedDeployShape(record: JsonObject): boolean {
  return (
    txId(record.get('transaction_id')) &&
    text(record.get('at')) &&
    hex(SHA_RE, record.get('prior_head')) &&
    hex64OrNone(record.get('prior_config_sha256')) &&
    tagOrNone(record.get('prior_tag')) &&
    hex(SHA_RE, record.get('target')) &&
    tag(record.get('tag')) &&
    hex64OrNone(record.get('helper_sha256')) &&
    isObject(record.get('rollback_compatibility')) &&
    typeof record.get('automatic_rollback_permitted') === 'boolean' &&
    planShape(record.get('plan'))
  );
}

const legacyCompletedDeployShape = (record: JsonObject): boolean =>
  text(record.get('at')) && planShape(record.get('plan'));

function completedRollbackShape(record: JsonObject): boolean {
  return (
    txId(record.get('transaction_id')) &&
    text(record.get('at')) &&
    hex(SHA_RE, record.get('to')) &&
    tag(record.get('tag')) &&
    hex64OrNone(record.get('helper_sha256'))
  );
}

const legacyCompletedRollbackShape = (record: JsonObject): boolean =>
  text(record.get('at')) && hex(SHA_RE, record.get('to')) && tag(record.get('tag'));

function completionShape(value: JsonValue | undefined): value is JsonObject {
  return (
    isObject(value) &&
    str(value.get('unit')) &&
    unitRuntime(value.get('runtime')) &&
    value.get('success') === true &&
    isInt(value.get('sequence'))
  );
}

function unitSwitchIdentity(record: JsonObject): boolean {
  const state = record.get('state');
  const phase = record.get('phase');
  const unit = record.get('unit');
  const runtime = record.get('runtime');
  const prior = record.get('prior_runtime');
  return (
    txId(record.get('transaction_id')) &&
    text(record.get('at')) &&
    typeof unit === 'string' &&
    UNIT_RUNTIMES.has(unit) &&
    unitRuntime(runtime) &&
    unitRuntime(prior) &&
    runtime !== prior &&
    record.has('snapshot') &&
    (none(state) || isObject(state)) &&
    typeof phase === 'string' &&
    PHASES.includes(phase) &&
    ((phase === 'snapshot' && none(state)) ||
      ((phase === 'drained' || phase === 'activation_pending') && isObject(state)) ||
      (phase === 'restore_activation_pending' && (none(state) || isObject(state))))
  );
}

function unitSwitchShape(record: JsonObject, outcome: string): boolean {
  if (!unitSwitchIdentity(record)) return false;
  const terminalPhase = UNIT_TERMINAL_PHASES[outcome];
  if (terminalPhase !== undefined && record.get('phase') !== terminalPhase) return false;
  if (outcome === 'pending') return true;
  if (outcome === 'completed') {
    const completions = record.get('completions');
    if (!Array.isArray(completions) || completions.length !== 2) return false;
    const [first, second] = completions;
    if (!completionShape(first) || !completionShape(second)) return false;
    for (const item of [first, second]) {
      if (item.get('unit') !== record.get('unit')) return false;
      if (item.get('runtime') !== record.get('runtime')) return false;
    }
    const a = (first.get('sequence') as JsonNumber).integer as bigint;
    const b = (second.get('sequence') as JsonNumber).integer as bigint;
    return a < b;
  }
  if (outcome === 'rolled_back') {
    // switch_unit's rollback path records a reason (possibly empty); recovery's
    // success path writes the same identity without one.
    return !record.has('reason') || str(record.get('reason'));
  }
  if (outcome === 'recovery_required') {
    return text(record.get('reason')) && str(record.get('record_path'));
  }
  return false;
}

/** Python `json.loads` accepts `NaN`, `Infinity` and `-Infinity` as floats. */
function pythonConstant(raw: string): JsonValue {
  const value = raw === 'NaN' ? Number.NaN : raw === '-Infinity' ? -Infinity : Infinity;
  return JsonNumber.float(value, raw);
}

/**
 * `_classify_record`: classify one retained controller record by its
 * producer-specific shape. Unreadable, malformed, unknown, unsupported-schema
 * and unsupported-legacy records refuse, naming the record.
 */
export function classifyRecord(entry: RecordEntry): RecordClass {
  const name = entry.name;
  if (entry.isSymlink() || !entry.isFile()) {
    throw new RecordRefused(`invalid controller journal entry: ${name}`);
  }
  let record: JsonValue;
  try {
    record = parseJsonValue(entry.read(), { parseConstant: pythonConstant });
  } catch {
    throw new RecordRefused(`unreadable controller journal entry: ${name}`);
  }
  if (!(record instanceof JsonObject)) {
    throw new RecordRefused(`invalid controller journal entry: ${name}`);
  }
  const schema = record.get('schema_version');
  if (!isInt(schema) || schema.integer !== JOURNAL_SCHEMA) {
    throw new RecordRefused(`unsupported controller journal schema: ${name}`);
  }
  const operation = record.get('operation');
  const outcome = record.get('outcome');
  if (operation === 'unit_switch') {
    if (
      outcome !== 'pending' &&
      outcome !== 'completed' &&
      outcome !== 'rolled_back' &&
      outcome !== 'recovery_required'
    ) {
      throw new RecordRefused(`invalid unit switch outcome: ${name}`);
    }
    if (!unitSwitchShape(record, outcome)) {
      throw new RecordRefused(`invalid unit switch journal: ${name}`);
    }
    const status =
      outcome === 'pending' || outcome === 'recovery_required' ? 'unfinished' : 'finished';
    return { status, operation };
  }
  if (operation === 'deploy') {
    if (none(outcome)) {
      if (!legacyCompletedDeployShape(record)) {
        throw new RecordRefused(`invalid completed checkout journal: ${name}`);
      }
      return { status: 'finished', operation };
    }
    if (outcome === 'completed') {
      if (!completedDeployShape(record)) {
        throw new RecordRefused(`invalid completed checkout journal: ${name}`);
      }
      return { status: 'finished', operation };
    }
    throw new RecordRefused(`invalid checkout journal outcome: ${name}`);
  }
  if (operation === 'rollback') {
    if (none(outcome)) {
      if (!legacyCompletedRollbackShape(record)) {
        throw new RecordRefused(`invalid completed checkout journal: ${name}`);
      }
      return { status: 'finished', operation };
    }
    if (outcome === 'completed') {
      if (!completedRollbackShape(record)) {
        throw new RecordRefused(`invalid completed checkout journal: ${name}`);
      }
      return { status: 'finished', operation };
    }
    throw new RecordRefused(`invalid checkout journal outcome: ${name}`);
  }
  if (operation === 'deploy_pending' || operation === 'rollback_pending') {
    if (outcome !== 'pending' || !checkoutIdentity(record)) {
      throw new RecordRefused(`invalid pending checkout journal: ${name}`);
    }
    return { status: 'unfinished', operation };
  }
  if (operation === 'deploy_refused' || operation === 'rollback_refused') {
    if (outcome !== 'refused_no_change' || !checkoutRefusalShape(record)) {
      throw new RecordRefused(`invalid refused checkout journal: ${name}`);
    }
    return { status: 'finished', operation };
  }
  if (operation === 'recovery_required') {
    if (outcome !== 'recovery_required') {
      throw new RecordRefused(`invalid checkout recovery journal: ${name}`);
    }
    if (!checkoutRecoveryShape(record)) {
      throw new RecordRefused(
        `unsupported legacy checkout recovery record (no verifiable producer identity): ${name}`,
      );
    }
    return { status: 'unfinished', operation };
  }
  throw new RecordRefused(`unknown controller journal operation: ${name}`);
}

/** `Path.glob("controller-*.json")` over a flat directory (`*` also spans newlines). */
const CONTROLLER_RECORD_NAME = /^controller-[\s\S]*\.json$/;

/**
 * `refuse_unfinished_transactions`: refuse while any retained controller record
 * is unfinished. `exclude` is the resolved path of the one record the caller is
 * about to recover, so a legitimate recovery does not block itself. Only reads.
 */
export function refuseUnfinishedTransactions(
  entries: readonly RecordEntry[],
  exclude?: string,
): void {
  const matching = entries
    .filter((entry) => CONTROLLER_RECORD_NAME.test(entry.name))
    .sort((a, b) => compareCodePoints(a.name, b.name));
  for (const entry of matching) {
    if (exclude !== undefined && entry.resolved() === exclude) continue;
    const { status, operation } = classifyRecord(entry);
    if (status === 'finished') continue;
    const name = entry.name;
    if (operation === 'unit_switch') {
      throw new RecordRefused(`unfinished unit switch requires recovery: ${name}`);
    }
    if (operation === 'deploy_pending' || operation === 'rollback_pending') {
      throw new RecordRefused(`unfinished checkout switch requires recovery: ${name}`);
    }
    if (operation === 'recovery_required') {
      throw new RecordRefused(
        `unresolved checkout recovery requires out-of-band reconciliation: ${name}`,
      );
    }
    throw new RecordRefused(`unfinished controller transaction: ${name}`);
  }
}
