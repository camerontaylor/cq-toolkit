/** `read_queue`, `drain_check` and the tick-health functions from
 * `apps/crq-python/ops/deploy-controller.py`. The filesystem, the runner liveness
 * probe, the heartbeat reader and the receipt samplers are injected through
 * `DrainEffects` / `HealthEffects`; nothing here touches the disk, a process or
 * systemd, and nothing imports this module yet.
 */

export class Refused extends Error {
  override readonly name: string = 'Refused';
}
/** Python `ValueError` (includes `json.JSONDecodeError`): readJson failures to be refused. */
export class ValueError extends Error {
  override readonly name = 'ValueError';
}
/** Python `OSError`: an unreadable file; refused like `ValueError`. */
export class OSError extends Error {
  override readonly name = 'OSError';
}

export type Result = Record<string, unknown>;
const isRecord = (v: unknown): v is Result =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o: Result, k: string): boolean => Object.hasOwn(o, k);
const get = (o: Result, k: string): unknown => (has(o, k) ? o[k] : null);
/** Python `str[:n]` (code points). */
const clip = (s: string, n: number): string => Array.from(s).slice(0, n).join('');
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Python `dict[key]` on a result that must carry the key. */
function req(o: Result, key: string): unknown {
  if (!has(o, key)) throw new Error(`KeyError: '${key}'`);
  return o[key];
}
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}
function pyTypeName(v: unknown): string {
  if (v === null) return 'NoneType';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  return 'dict';
}
/** Python `repr` of a JSON-shaped value (printable-ASCII approximation for strings). */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    let out = q;
    for (const ch of v) {
      const c = ch.codePointAt(0)!;
      if (ch === q || ch === '\\') out += `\\${ch}`;
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`;
      else out += ch;
    }
    return out + q;
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  return `{${Object.entries(v as Result)
    .map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`)
    .join(', ')}}`;
}

// ------------------------------------------------------------------ drain

const RUN_ID_RE = /^(?:[0-9a-f-]{8,64}|[A-Za-z0-9][A-Za-z0-9._+-]*-[0-9]{8}T[0-9]{6}Z)$/;

export interface DrainEffects {
  /** `effects.state_dir()` */
  stateDir(): string;
  /** `effects.read_json(rel)`: rejects with `ValueError`/`OSError` on unreadable input. */
  readJson(rel: string): Promise<unknown>;
  /** `Path(path).exists()` */
  exists(path: string): Promise<boolean>;
}
/** The runner's fail-closed probe (`crq.run_liveness`): 'alive' | 'ambiguous' | 'harvest' | .. */
export type Liveness = (
  rdir: string,
  item: Result,
  run: Result,
  hasExit: boolean,
) => Promise<string>;

/** The queue ledger's object root, or `ValueError`/`OSError`. */
export async function readQueue(effects: DrainEffects): Promise<Result> {
  const queue = await effects.readJson('queue.json');
  if (!isRecord(queue))
    throw new ValueError(`queue.json root is ${pyTypeName(queue)}, not a JSON object`);
  if (has(queue, 'items') && !Array.isArray(queue['items']))
    throw new ValueError('queue.json items is not a JSON array');
  return queue;
}

/** Exact owned-PID drain observation: observes liveness, never signals anything. */
export async function drainCheck(effects: DrainEffects, liveness: Liveness): Promise<Result> {
  let queue: Result;
  try {
    queue = await readQueue(effects);
  } catch (exc) {
    if (exc instanceof ValueError || exc instanceof OSError)
      throw new Refused(
        `queue unreadable, refusing to reason about drain: ${clip(exc.message, 160)}`,
      );
    throw exc;
  }
  const runs = `${effects.stateDir()}/runs`;
  const blocked: Result[] = [];
  const items = (has(queue, 'items') ? queue['items'] : []) as unknown[];
  for (const item of items) {
    if (!isRecord(item)) {
      blocked.push({ item: null, state: 'ambiguous', reason: 'malformed queue item' });
      continue;
    }
    if (!has(item, 'run')) continue; // genuinely unstarted
    const r = item['run'];
    if (r === null) continue; // the runner's own terminal/consumed marker
    if (!isRecord(r)) {
      blocked.push({
        item: get(item, 'id'),
        state: 'ambiguous',
        reason: 'malformed recorded run metadata',
      });
      continue;
    }
    const runId = get(r, 'run_id');
    if (typeof runId !== 'string' || Array.from(runId).length > 255 || !RUN_ID_RE.test(runId)) {
      blocked.push({ item: get(item, 'id'), state: 'ambiguous', reason: 'malformed run id' });
      continue;
    }
    const rdir = `${runs}/${runId}`;
    const hasExit = await effects.exists(`${rdir}/exit.json`);
    let state: string;
    try {
      state = await liveness(rdir, item, r, hasExit);
    } catch (exc) {
      blocked.push({
        item: get(item, 'id'),
        state: 'ambiguous',
        reason: `liveness probe failed: ${clip(messageOf(exc), 120)}`,
      });
      continue;
    }
    if (state === 'alive' || state === 'ambiguous')
      blocked.push({ item: get(item, 'id'), state, run: runId });
  }
  return { blocked, drained: blocked.length === 0 };
}

// ----------------------------------------------------------------- health

const TICK_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const STRPTIME_RE =
  /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})T([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2})Z$/;

/** `dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")`: calendar-real or `ValueError`. */
export function parseIso(value: string): Date {
  const m = STRPTIME_RE.exec(value);
  if (!m) throw new ValueError(`time data ${pyRepr(value)} does not match format`);
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, 0);
  if (y < 1 || mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59 || date.getUTCDate() !== d)
    throw new ValueError(`unconverted or out-of-range time data ${pyRepr(value)}`);
  return date;
}

/** Producer-shaped AND calendar-real. */
export function strictTick(value: string): boolean {
  if (!TICK_RE.test(value)) return false;
  try {
    parseIso(value);
  } catch (e) {
    if (e instanceof ValueError) return false;
    throw e;
  }
  return true;
}

export interface HealthEffects {
  /** `effects.root` (the checkout); the runner directory is `<root>/apps/crq-python`. */
  root: string;
  /** The completion heartbeat object, or null when none exists yet. */
  readCompletionHeartbeat(): Promise<Result | null>;
  /** `run_metadata_sample(effects)` (not ported; injected). */
  runMetadataSample(): Promise<Result | null>;
  /** `receipt_validation(effects)` (not ported; injected). */
  receiptValidation(): Promise<Result | null>;
}

/** The last COMPLETED tick, read only from the completion heartbeat. */
export async function tickValue(effects: HealthEffects): Promise<string> {
  const heartbeat = await effects.readCompletionHeartbeat();
  if (heartbeat === null)
    throw new Refused(
      "no completion heartbeat observed under the runner's WATCHDOG_HOME; cannot assess health",
    );
  const expectedRoot = `${effects.root}/apps/crq-python`;
  const root = get(heartbeat, 'root');
  if (root !== expectedRoot)
    throw new Refused(
      `completion heartbeat root ${clip(pyRepr(root), 80)} is not this checkout's runner directory ${pyRepr(expectedRoot)}`,
    );
  const value = get(heartbeat, 'last_tick');
  if (typeof value !== 'string' || !strictTick(value))
    throw new Refused(
      `completion heartbeat last_tick ${clip(pyRepr(value), 80)} is not a strict UTC YYYY-MM-DDTHH:MM:SSZ timestamp`,
    );
  return value;
}

/** One health observation against the requested prior tick (lexicographic advancement). */
export async function healthObservation(
  effects: HealthEffects,
  priorTick: string,
): Promise<Result> {
  parseIso(priorTick);
  const current = await tickValue(effects);
  parseIso(current);
  const advanced = current > priorTick;
  const sample = await effects.runMetadataSample();
  const validation = await effects.receiptValidation();
  return {
    observed_tick: current,
    advanced,
    receipts: sample,
    receipts_readable:
      sample && truthy(req(sample, 'sampled')) ? !truthy(req(sample, 'unreadable')) : null,
    receipt_validation: validation,
    receipts_valid: validation && truthy(validation) ? req(validation, 'valid') : null,
  };
}

/** Bounded polling for a completed tick; no deployment mutations. */
export async function waitForFirstTick(
  effects: HealthEffects,
  priorTick: string,
  timeout: number,
  clocks: { sleep(seconds: number): Promise<void>; clock(): number },
): Promise<Result> {
  const deadline = clocks.clock() + timeout;
  for (;;) {
    const observation = await healthObservation(effects, priorTick);
    const remaining = deadline - clocks.clock();
    if (truthy(observation['advanced']) || remaining <= 0) return observation;
    await clocks.sleep(Math.min(5, remaining));
  }
}

/** False if any observation failed, null if none observed, else true. */
function verdict(values: unknown[]): boolean | null {
  const seen = values.filter((v) => v !== null && v !== undefined);
  if (seen.length === 0) return null;
  return seen.every((v) => v === true);
}
function receiptVerdicts(observations: Result[]): Result {
  return {
    receipts_readable: verdict(observations.map((o) => get(o, 'receipts_readable'))),
    receipts_valid: verdict(observations.map((o) => get(o, 'receipts_valid'))),
  };
}

/** Two strictly advancing observations via the injected `observe`. */
export async function twoSlotHealth(
  effects: HealthEffects,
  observe: (priorTick: string) => Promise<Result>,
): Promise<Result> {
  const firstTick = await tickValue(effects);
  const first = await observe(firstTick);
  if (!truthy(get(first, 'advanced')))
    return {
      healthy: false,
      reason: `first observation did not advance past ${firstTick}`,
      observations: [first],
      ...receiptVerdicts([first]),
    };
  const secondTick = req(first, 'observed_tick') as string;
  const second = await observe(secondTick);
  if (!truthy(get(second, 'advanced')))
    return {
      healthy: false,
      reason: `second observation did not advance past ${secondTick}`,
      observations: [first, second],
      ...receiptVerdicts([first, second]),
    };
  return { healthy: true, observations: [first, second], ...receiptVerdicts([first, second]) };
}
