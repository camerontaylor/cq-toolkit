/**
 * The live-state measurements and post-quiesce / post-switch checks of the
 * deploy runbook, over injected fs/controller/unit seams.
 *
 * Ports `read_config`, `measure_cq_bin`, `compatibility_reason`,
 * `Run.recheck_baseline`, `Run.verify_after_switch`,
 * `Run.runtime_pointer_check` and `Run.restart_triggers` from
 * `apps/crq-python/ops/deploy-runbook.py`. Inactive and unimported: nothing
 * here touches the disk, a process or a unit; the caller supplies every effect.
 */
import { pythonJsonText } from '../../../policy/crq/pythonJson.js';

/** Python `Refused`: a precondition failed. */
export class Refused extends Error {
  override name = 'Refused';
}
/** Python `OSError`: what an injected fs read throws. */
export class OSError extends Error {
  override name = 'OSError';
}

export const CONFIG_RELPATH = 'apps/crq-python/config.json';
export const PLACEHOLDER = '@HOST_CQ_BIN@';

function require_(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Refused(message);
}

const codePointCompare = (a: string, b: string): number => {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
};
const sortedKeys = (o: object): string[] => Object.keys(o).sort(codePointCompare);

/** `json.dumps(value, sort_keys=True)`. */
function dumpsSorted(value: Record<string, unknown>): string {
  return pythonJsonText(value as never, {
    asciiOnly: true,
    sortKeys: true,
    keyOrder: 'code-point',
    spacedSeparators: true,
  });
}

/** Python `repr` of the JSON-shaped values these messages quote. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    let out = '';
    for (const ch of value) {
      const cp = ch.codePointAt(0)!;
      if (ch === quote || ch === '\\') out += `\\${ch}`;
      else if (cp === 9) out += '\\t';
      else if (cp === 10) out += '\\n';
      else if (cp === 13) out += '\\r';
      else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, '0')}`;
      else out += ch;
    }
    return `${quote}${out}${quote}`;
  }
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value as object)
      .map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`)
      .join(', ')}}`;
  return String(value);
}

/** Python `str(value)` for a `str | None`. */
const pyStr = (value: string | null): string => (value === null ? 'None' : value);

/** Python truthiness of a decoded JSON value. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '')
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

// ------------------------------------------------------------- live state

export interface LiveConfigEffects {
  /** `Path.read_bytes`; throws {@link OSError} when unreadable. */
  readFile(path: string): Promise<Uint8Array>;
  /** `Path.is_file`. */
  isFile(path: string): Promise<boolean>;
  /** `sha256_file`, lowercase hex. */
  sha256File(path: string): Promise<string>;
  /** `st_mode & 0o777` of the entry (symlinks followed). */
  modeBits(path: string): Promise<number>;
  /** `Path.resolve`. */
  resolve(path: string): Promise<string>;
}

export interface CqBinRecord {
  readonly pointer: string | null;
  readonly placeholder: boolean;
  readonly exists: boolean;
  readonly sha256: string | null;
  /** `oct(mode)`, e.g. `0o755`. */
  readonly mode: string | null;
  readonly resolved: string | null;
}

/** Python `read_config`: the live config bytes, or `Refused` when unreadable. */
export async function readConfig(effects: LiveConfigEffects, root: string): Promise<Uint8Array> {
  const path = `${root.endsWith('/') ? root : `${root}/`}${CONFIG_RELPATH}`;
  try {
    return await effects.readFile(path);
  } catch (error) {
    if (error instanceof OSError)
      throw new Refused(`cannot read live config ${path}: ${error.message}`);
    throw error;
  }
}

/**
 * Python `measure_cq_bin`: the live runtime pointer including the entry's own
 * bytes. A placeholder is recorded as such and not stat-ed.
 */
export async function measureCqBin(
  effects: LiveConfigEffects,
  configBytes: Uint8Array,
): Promise<CqBinRecord> {
  let config: unknown;
  try {
    config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes));
  } catch (error) {
    throw new Refused(`live config is not valid JSON: ${(error as Error).message}`);
  }
  // Python `config.get(...)` raises AttributeError on a non-dict: a crash, not a refusal.
  if (config === null || typeof config !== 'object' || Array.isArray(config))
    throw new TypeError('live config is not a JSON object');
  const repairRaw = (config as Record<string, unknown>)['repair'];
  const repair = truthy(repairRaw) ? repairRaw : {};
  if (repair === null || typeof repair !== 'object' || Array.isArray(repair))
    throw new TypeError('live config repair is not a JSON object');
  const pointer = (repair as Record<string, unknown>)['cq_bin'];
  const isString = typeof pointer === 'string';
  const placeholder = isString && pointer.includes(PLACEHOLDER);
  const base = {
    pointer: isString ? pointer : null,
    placeholder,
    exists: false,
    sha256: null,
    mode: null,
    resolved: null,
  };
  if (placeholder) return base;
  require_(
    isString && pointer !== '',
    'live config carries no repair.cq_bin pointer; the runtime this deploy would execute is unknown',
  );
  require_(
    pointer.startsWith('/'),
    `live repair.cq_bin is not an absolute path: ${pyRepr(pointer)}`,
  );
  if (!(await effects.isFile(pointer))) return base;
  return {
    ...base,
    exists: true,
    sha256: await effects.sha256File(pointer),
    mode: `0o${(await effects.modeBits(pointer)).toString(8)}`,
    resolved: await effects.resolve(pointer),
  };
}

const sameRecord = (a: CqBinRecord, b: CqBinRecord): boolean =>
  a.pointer === b.pointer &&
  a.placeholder === b.placeholder &&
  a.exists === b.exists &&
  a.sha256 === b.sha256 &&
  a.mode === b.mode &&
  a.resolved === b.resolved;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

// -------------------------------------------------------- controller seam

export type PreservedDigests = Readonly<Record<string, string | null>>;

/** The deploy-controller calls these steps make, with its effects already bound. */
export interface PostSwitchController {
  preservedDigests(): Promise<PreservedDigests>;
  compatibilityRecord(sha: string): Promise<unknown>;
  rollbackCompatible(record: unknown): boolean;
}

/** Python `compatibility_reason`: the evidence that denied automatic rollback. */
export function compatibilityReason(record: unknown): string {
  const rec =
    record !== null && typeof record === 'object' && !Array.isArray(record)
      ? (record as Record<string, unknown>)
      : null;
  if (rec === null || rec['checked'] !== true) return 'the compatibility record was not checked';
  if (rec['schema_marker_present'] !== false) {
    const schema = rec['queue_schema'];
    if (typeof schema === 'string' && schema.startsWith('unreadable: '))
      return `the state queue could not be read (${schema.slice('unreadable: '.length)})`;
    return `the queue carries an explicit schema marker (${pyRepr(schema)}) the prior target was never proven to read`;
  }
  const observed = rec['schema_observations'];
  if (truthy(observed))
    return (
      'the queue carries state keys the prior target was never proven to read: ' +
      (Array.isArray(observed) ? observed : Object.keys(observed as object))
        .map((v) => (typeof v === 'string' ? v : pyRepr(v)))
        .join(', ')
    );
  return 'the compatibility record is not the clean shape';
}

// ------------------------------------------------------------------ steps

export interface RecheckBaselineArgs {
  readonly effects: LiveConfigEffects;
  readonly controller: PostSwitchController;
  readonly root: string;
  readonly originalConfig: Uint8Array;
  readonly cqBin: CqBinRecord;
  readonly target: string;
  phase(name: string, extra: Record<string, unknown>): void;
}

/**
 * Python `Run.recheck_baseline`: re-measure the preserved state once the host
 * is quiescent and prove rollback permission again. Returns the new baseline.
 */
export async function recheckBaseline(args: RecheckBaselineArgs): Promise<PreservedDigests> {
  const live = await readConfig(args.effects, args.root);
  require_(
    sameBytes(live, args.originalConfig),
    'live config changed while admission was being held; nothing was switched',
  );
  require_(
    sameRecord(await measureCqBin(args.effects, live), args.cqBin),
    'the runtime pointer changed while admission was being held; nothing was switched',
  );
  const preserved = await args.controller.preservedDigests();
  const compatibility = await args.controller.compatibilityRecord(args.target);
  require_(
    args.controller.rollbackCompatible(compatibility),
    'the queue no longer grants automatic rollback after the drain: ' +
      `${compatibilityReason(compatibility)}; nothing was switched`,
  );
  args.phase('remeasured', { preserved: sortedKeys(preserved) });
  return preserved;
}

/** Python `Run.runtime_pointer_check`. */
export async function runtimePointerCheck(
  effects: LiveConfigEffects,
  root: string,
  cqBin: CqBinRecord,
): Promise<void> {
  const live = await measureCqBin(effects, await readConfig(effects, root));
  require_(
    live.pointer === cqBin.pointer,
    `the switch moved repair.cq_bin from ${pyRepr(cqBin.pointer)} to ${pyRepr(live.pointer)}; ` +
      'a runtime pointer move is a separate, measured decision',
  );
  if (!cqBin.placeholder)
    require_(
      live.exists && live.sha256 === cqBin.sha256,
      `the runtime at ${pyStr(live.pointer)} is not the measured entry (${pyStr(cqBin.sha256)}); ` +
        'refusing to restart against unverified bytes',
    );
}

export interface VerifyAfterSwitchArgs {
  readonly effects: LiveConfigEffects;
  readonly controller: PostSwitchController;
  readonly root: string;
  readonly cqBin: CqBinRecord;
  readonly preserved: PreservedDigests;
  readonly priorSha: string;
}
export interface VerifyAfterSwitchResult {
  readonly postCompatibility: unknown;
  /** Why rollback is no longer permitted, or `null` when it still is. */
  readonly rollbackDisabled: string | null;
}

/** Python `Run.verify_after_switch`: queue bytes, runtime pointer and rollback permission. */
export async function verifyAfterSwitch(
  args: VerifyAfterSwitchArgs,
): Promise<VerifyAfterSwitchResult> {
  await runtimePointerCheck(args.effects, args.root, args.cqBin);
  const observed = await args.controller.preservedDigests();
  const changed = sortedKeys(args.preserved).filter(
    (key) => (Object.hasOwn(observed, key) ? observed[key] : null) !== args.preserved[key],
  );
  require_(
    changed.length === 0,
    `shared queue state changed during the switch: ${changed.join(', ')}; this deploy is failed`,
  );
  const postCompatibility = await args.controller.compatibilityRecord(args.priorSha);
  return {
    postCompatibility,
    rollbackDisabled: args.controller.rollbackCompatible(postCompatibility)
      ? null
      : compatibilityReason(postCompatibility),
  };
}

export interface TriggerUnits {
  start(units: readonly string[]): Promise<void>;
  state(unit: string): Promise<string>;
}

const sameStates = (a: Record<string, string>, b: Readonly<Record<string, string>>): boolean => {
  const ka = Object.keys(a);
  return (
    ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
  );
};

/**
 * Python `Run.restart_triggers`: start the triggers that were active, then
 * read their states twice; both reads must equal the original. Returns the
 * verified states.
 */
export async function restartTriggers(
  units: TriggerUnits,
  triggers: readonly string[],
  original: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const active = Object.keys(original)
    .filter((unit) => original[unit] === 'active')
    .sort(codePointCompare);
  await units.start(active);
  const read = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const unit of triggers) out[unit] = await units.state(unit);
    return out;
  };
  const observed = await read();
  require_(
    sameStates(observed, original),
    `trigger restart mismatch: observed ${dumpsSorted(observed)} expected ${dumpsSorted({ ...original })}`,
  );
  const verified = await read();
  require_(
    sameStates(verified, original),
    `trigger restart verification mismatch: second read ${dumpsSorted(verified)}`,
  );
  return verified;
}
