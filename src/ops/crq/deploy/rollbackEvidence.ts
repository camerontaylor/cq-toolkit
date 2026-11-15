/** Rollback evidence from `apps/crq-python/ops/deploy-runbook.py`: the measured runtime
 * pointer (`measure_cq_bin`) and the denial reason for automatic rollback
 * (`compatibility_reason`). Pure of I/O: the file inspection is injected, and nothing
 * here switches, restarts or deploys.
 */
import { JsonNumber, JsonObject, parseJsonValue } from '../../../policy/crq/jsonValue.js';
import { pythonFloatRepr } from '../../../policy/crq/pythonJson.js';
import { pyTruthy } from '../../../policy/crq/queueDoc.js';

/** Where the overlay has not rendered a runtime yet. */
export const PLACEHOLDER = '@HOST_CQ_BIN@';

export class Refused extends Error {
  override readonly name = 'Refused';
}

export interface CqBinRecord {
  readonly pointer: string | null;
  readonly placeholder: boolean;
  readonly exists: boolean;
  readonly sha256: string | null;
  /** Python `oct(st_mode & 0o777)`, e.g. `0o755`. */
  readonly mode: string | null;
  readonly resolved: string | null;
}
export interface CqBinEffects {
  /** `Path.is_file()` plus the entry's bytes digest, mode and `resolve()`; null if not a file. */
  inspectFile(path: string): Promise<{
    readonly sha256: string;
    readonly mode: number;
    readonly resolved: string;
  } | null>;
}

const require = (condition: boolean, message: string): void => {
  if (!condition) throw new Refused(message);
};

/** The live runtime pointer, measured including the entry's own bytes. */
export async function measureCqBin(
  configBytes: Uint8Array,
  effects: CqBinEffects,
): Promise<CqBinRecord> {
  let config;
  try {
    config = parseJsonValue(new TextDecoder('utf-8', { fatal: true }).decode(configBytes));
  } catch (error) {
    throw new Refused(
      `live config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const repair = config instanceof JsonObject ? config.get('repair') : undefined;
  const pointerValue = repair instanceof JsonObject ? repair.get('cq_bin') : undefined;
  const pointer = typeof pointerValue === 'string' ? pointerValue : null;
  const placeholder = pointer !== null && pointer.includes(PLACEHOLDER);
  const base: CqBinRecord = {
    pointer,
    placeholder,
    exists: false,
    sha256: null,
    mode: null,
    resolved: null,
  };
  if (placeholder) return base;
  require(pointer !== null &&
    pointer !==
      '', 'live config carries no repair.cq_bin pointer; the runtime this deploy would execute is unknown');
  require(pointer!.startsWith(
    '/',
  ), `live repair.cq_bin is not an absolute path: ${pyRepr(pointer)}`);
  const file = await effects.inspectFile(pointer!);
  if (file === null) return base;
  return {
    ...base,
    exists: true,
    sha256: file.sha256,
    mode: `0o${(file.mode & 0o777).toString(8)}`,
    resolved: file.resolved,
  };
}

/** Python `repr` for the JSON scalars a queue schema marker can be. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (value instanceof JsonNumber)
    return value.kind === 'int' ? value.raw : pythonFloatRepr(value.float!);
  if (typeof value === 'string') {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const body = value
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .split(quote)
      .join('\\' + quote);
    return quote + body + quote;
  }
  return JSON.stringify(value);
}

/** Name the evidence that denied automatic rollback, without paraphrase. */
export function compatibilityReason(record: unknown): string {
  if (!(record instanceof JsonObject) || record.get('checked') !== true)
    return 'the compatibility record was not checked';
  if (record.get('schema_marker_present') !== false) {
    const schema = record.get('queue_schema');
    if (typeof schema === 'string' && schema.startsWith('unreadable: '))
      return `the state queue could not be read (${schema.slice('unreadable: '.length)})`;
    return `the queue carries an explicit schema marker (${pyRepr(schema ?? null)}) the prior target was never proven to read`;
  }
  const observed = record.get('schema_observations');
  if (pyTruthy(observed))
    return `the queue carries state keys the prior target was never proven to read: ${(Array.isArray(observed) ? observed : [observed]).map(String).join(', ')}`;
  return 'the compatibility record is not the clean shape';
}
