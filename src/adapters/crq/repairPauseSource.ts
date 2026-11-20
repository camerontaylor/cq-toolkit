/**
 * Offline pause, cooldown and blackout bindings for the repair drain
 * (`crq_repair.py`: `paused`, `rate_limit_pause`, `blackout`, `blocked`,
 * `provider_cooldowns`, `dispatch_paused`, with `fallback_roles`,
 * `role_provider`, `provider_ready` and `valid_cooldown_stamp`).
 *
 * Inactive and standalone: nothing imports this from a runtime entry point and
 * it names no type from the drain orchestration. {@link RepairPauseEffects}
 * is the structural shape such an orchestration binds (`dispatchPaused()` /
 * `blocked()` of `RepairDrainEffects`, once the caller has fixed the config).
 * No git, network, provider call or process spawn happens here; every path is
 * derived from the injected `stateRoot` (Python's `ROOT / 'state'`).
 *
 * Clock: every wall-clock read goes through the injected `now`, in the same
 * order Python reads it (`rate_limit_pause` reads it for the end, again inside
 * the lock for `paused()`, again for the `at` stamp; `dispatch_paused` reads it
 * for `utc()` and again for `paused()`), so a test with a stepped clock pins
 * each read. Environment: `provider_ready` reads the injected `env`.
 *
 * The suspended GLM blackout is honoured exactly as configured: `blackout`
 * reads `repair.blackout` and returns false when `enabled` is the literal
 * `false`; nothing here adds or schedules a window.
 *
 * Failure honesty, matching Python 3.14 (the production minor):
 * - `Path.exists()` is `os.path.exists`: any failure to `stat` reads as missing.
 * - `paused` treats an unreadable or malformed marker as a default-length
 *   pause from the file's mtime, but a marker whose `until` parses as a naive
 *   datetime raises (`TypeError` comparing naive with aware) exactly as Python
 *   does.
 * - `providerCooldowns` fails closed with {@link CooldownStateError} on any
 *   corrupt state, and `dispatchPaused` turns that into
 *   {@link OPERATOR_RECOVERY_PAUSE}.
 * - A config or report whose shape makes Python raise (`KeyError`,
 *   `TypeError`, `AttributeError`, `OverflowError`) throws here too.
 *
 * Known residual: `ZoneInfo` keys are case-sensitive tzdata file names; the
 * blackout window resolves its zone through ICU, which also accepts other
 * spellings of a zone. Offset-style names (`+08:00`) are refused like Python.
 */
import { mkdir, stat } from 'node:fs/promises';
import { currentEntryEnv } from '../../config/run-env.js';
import { join } from 'node:path';
import { JsonNumber, JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { atomicJsonText, compareCodePoints } from '../../policy/crq/pythonJson.js';
import { pythonTruthy } from '../../policy/crq/repairBinding.js';
import {
  formatUtcMicros,
  parseUtc,
  parseUtcUnchecked,
  utcHasOffset,
} from '../../policy/crq/utc.js';
import { atomicWrite } from './atomic.js';
import { withLock } from './lock.js';
import {
  pathExists,
  pythonMtime,
  readJsonValue,
  StateFileUnreadable,
} from './repairStateSource.js';

/** `DEFAULT_RATE_LIMIT_PAUSE`: 30 minutes. */
export const DEFAULT_RATE_LIMIT_PAUSE_MICROS = 30n * 60n * 1_000_000n;
/** `MAX_RATE_LIMIT_PAUSE`: 24 hours. */
export const MAX_RATE_LIMIT_PAUSE_MICROS = 24n * 3_600n * 1_000_000n;
/** `OPERATOR_RECOVERY_PAUSE`: the fail-closed marker `dispatch_paused` returns. */
export const OPERATOR_RECOVERY_PAUSE =
  'operator recovery required (corrupt provider-cooldowns.json)';

/** Python's `str(exc)[:200]` bound on a surfaced read failure. */
const MAX_REASON = 200;
const MICROS_PER_SECOND = 1_000_000n;
/** `COOLDOWN_STAMP`: the only stamp shape `remember_provider_limit` persists. */
const COOLDOWN_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** `datetime.timedelta.max` in microseconds (999999999 days 23:59:59.999999). */
const TIMEDELTA_MAX_MICROS = 999_999_999n * 86_400n * MICROS_PER_SECOND + 86_399_999_999n;
/** `datetime.min` / `datetime.max` as UTC epoch microseconds (years 1 and 9999). */
const DATETIME_MIN_MICROS = -62_135_596_800n * MICROS_PER_SECOND;
const DATETIME_MAX_MICROS = 253_402_300_799n * MICROS_PER_SECOND + 999_999n;

/** Persisted provider-cooldown state is corrupt; operator recovery is required. */
export class CooldownStateError extends Error {
  override readonly name = 'CooldownStateError';
}

/** What Python raises (`KeyError`, `TypeError`, `AttributeError`, `OverflowError`) on a bad shape. */
export class RepairPauseShapeError extends Error {
  override readonly name = 'RepairPauseShapeError';
}

export interface RepairPauseEffects {
  /** `paused(now)`: the pause end while it is in the future, else `null`. */
  paused(now?: Date): Promise<string | null>;
  /** `provider_cooldowns()`; throws {@link CooldownStateError} on corrupt state. */
  providerCooldowns(): Promise<ReadonlyMap<string, string>>;
  /** `dispatch_paused(config)`: the pause text, or `null` when dispatch may proceed. */
  dispatchPaused(config: JsonValue): Promise<string | null>;
  /** `rate_limit_pause(report, job_id)`: record the pause and return its end. */
  rateLimitPause(report: JsonValue, jobId: JsonValue): Promise<string>;
}

export interface RepairPauseSourceOptions {
  /** `ROOT / 'state'`. */
  readonly stateRoot: string;
  /** The wall clock; every read is injected. */
  readonly now?: () => Date;
  /** `os.environ`, for `provider_ready`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * `cooldown_write`: run `fn` under the exclusive `state/tick.lock`. Defaults to
   * the real flock; a test injects a recorder to keep the lock out of scope.
   */
  readonly lock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

function shape(message: string): RepairPauseShapeError {
  return new RepairPauseShapeError(message);
}

/** A Python `dict` with `.get`, else the `AttributeError`/`TypeError` Python raises. */
function mapping(value: JsonValue | undefined, what: string): JsonObject {
  if (value instanceof JsonObject) return value;
  throw shape(`${what} is not an object`);
}

function microsOf(date: Date): bigint {
  return BigInt(date.getTime()) * 1000n;
}

/** `strftime('%Y-%m-%dT%H:%M:%SZ')`: whole seconds, microseconds dropped. */
function stampOf(micros: bigint): string {
  return formatUtcMicros(micros).replace(/\.\d{6}Z$/, 'Z');
}

function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * `timedelta(<unit>=value)` in microseconds, `unitMicros` being that unit's
 * microsecond size. Raises where Python raises: a non-number (`TypeError`),
 * NaN (`ValueError`) and anything beyond `timedelta.max` (`OverflowError`).
 */
function timedeltaMicros(value: JsonValue, unitMicros: number): bigint {
  let micros: bigint;
  if (typeof value === 'boolean') {
    micros = BigInt(value ? 1 : 0) * BigInt(unitMicros);
  } else if (value instanceof JsonNumber && value.kind === 'int' && value.integer !== null) {
    micros = value.integer * BigInt(unitMicros);
  } else if (value instanceof JsonNumber && value.float !== null) {
    if (Number.isNaN(value.float)) throw shape('cannot convert float NaN to a duration');
    if (!Number.isFinite(value.float)) throw shape('cannot convert float infinity to a duration');
    micros = BigInt(roundHalfEven(value.float * unitMicros));
  } else {
    throw shape('duration is not a number');
  }
  if (micros > TIMEDELTA_MAX_MICROS || micros < -TIMEDELTA_MAX_MICROS - 1n) {
    throw shape('duration out of range');
  }
  return micros;
}

/** `datetime.fromtimestamp(st_mtime, utc)` in epoch microseconds (Python's half-even round). */
function fromTimestampMicros(mtime: number): bigint {
  let whole = Math.trunc(mtime);
  let fraction = roundHalfEven((mtime - whole) * 1e6);
  if (fraction >= 1e6) {
    fraction -= 1e6;
    whole += 1;
  } else if (fraction < 0) {
    fraction += 1e6;
    whole -= 1;
  }
  return BigInt(whole) * MICROS_PER_SECOND + BigInt(fraction);
}

/** `valid_cooldown_stamp`: canonical UTC shape and a real date. */
export function validCooldownStamp(stamp: unknown): stamp is string {
  if (typeof stamp !== 'string' || !COOLDOWN_STAMP.test(stamp)) return false;
  return parseUtc(stamp) !== null;
}

// ---------------------------------------------------------------- blackout --

/** `t.isoweekday() in window['days']` over the JSON model (`1 == 1.0 == True`). */
function weekdayIn(days: JsonValue, weekday: number): boolean {
  if (Array.isArray(days)) {
    return days.some((entry) => {
      if (typeof entry === 'boolean') return weekday === (entry ? 1 : 0);
      if (!(entry instanceof JsonNumber)) return false;
      return entry.kind === 'int' ? entry.integer === BigInt(weekday) : entry.float === weekday;
    });
  }
  // A dict's keys are strings, so an int is never one; `in` on a str, number or null raises.
  if (days instanceof JsonObject) return false;
  throw shape('blackout days is not a container');
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** `now.astimezone(ZoneInfo(tz))` reduced to the two fields the window reads. */
function zonedParts(epochMicros: bigint, tz: string): { weekday: number; hhmm: string } {
  if (tz.startsWith('+') || tz.startsWith('-')) throw shape('unknown time zone key');
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw shape('unknown time zone key');
  }
  const ms = Number(epochMicros / 1000n - (epochMicros % 1000n < 0n ? 1n : 0n));
  const parts = formatter.formatToParts(new Date(ms));
  const field = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = WEEKDAYS[field('weekday')];
  if (weekday === undefined) throw shape('unreadable weekday');
  return { weekday, hhmm: `${field('hour')}:${field('minute')}` };
}

/** `blackout(repair, now)` at one instant; `repair.get('blackout')` is the window. */
function blackoutAt(repair: JsonObject, epochMicros: bigint): boolean {
  const window = repair.get('blackout');
  // `enabled: false` suspends the window; a missing flag keeps it in force.
  if (!pythonTruthy(window)) return false;
  const config = mapping(window, 'repair.blackout');
  if (config.get('enabled') === false) return false;
  const tz = config.get('tz');
  if (tz === undefined) throw shape('blackout window has no tz');
  if (typeof tz !== 'string') throw shape('blackout tz is not a string');
  const { weekday, hhmm } = zonedParts(epochMicros, tz);
  const days = config.get('days');
  if (days === undefined) throw shape('blackout window has no days');
  if (!weekdayIn(days, weekday)) return false;
  const start = config.get('start');
  if (start === undefined) throw shape('blackout window has no start');
  if (typeof start !== 'string') throw shape('blackout start is not a string');
  // `window['start'] <= hhmm < window['end']`: the chain stops before `end` on a miss.
  if (compareCodePoints(start, hhmm) > 0) return false;
  const end = config.get('end');
  if (end === undefined) throw shape('blackout window has no end');
  if (typeof end !== 'string') throw shape('blackout end is not a string');
  return compareCodePoints(hhmm, end) < 0;
}

/** `blackout(repair, now)`: GLM peak hours, no repair dispatch at all. */
export function blackout(repair: JsonValue, now: Date): boolean {
  return blackoutAt(mapping(repair, 'repair'), microsOf(now));
}

/**
 * `blocked(repair, now)`: no dispatch inside the blackout, nor one whose wall
 * clock would reach it. `reach` is computed before either window check, so a
 * malformed `budget` raises even while the first check would already answer.
 */
export function blocked(repair: JsonValue, now: Date): boolean {
  const section = mapping(repair, 'repair');
  const budget = section.has('budget') ? section.get('budget') : new JsonObject([]);
  const minutes = mapping(budget, 'repair.budget').get('wall_clock_min');
  const reach = timedeltaMicros(minutes === undefined ? JsonNumber.int(0) : minutes, 60_000_000);
  const at = microsOf(now);
  const later = at + reach;
  if (later < DATETIME_MIN_MICROS || later > DATETIME_MAX_MICROS) {
    throw shape('date value out of range');
  }
  return blackoutAt(section, at) || blackoutAt(section, later);
}

// ------------------------------------------------------------------ roles ---

/** A provider key; `null` is a hashable non-string that can match no state key. */
type ProviderKey = string | null;

const PROVIDER_ENV: Readonly<Record<string, readonly string[]>> = {
  zai: ['ZAI_API_KEY'],
  'opencode-go': ['OPENCODE_GO_API_KEY', 'OPENCODE_GO_BASE_URL'],
  deepseek: ['DEEPSEEK_API_KEY'],
};

function alias(name: string): string {
  // A Paseo 'codex/...' model and the codex driver are the same OpenAI account.
  return name === 'codex' ? 'openai' : name;
}

function roleField(role: JsonObject, name: string): JsonValue {
  const value = role.get(name);
  if (value === undefined) throw shape(`role has no ${name}`);
  return value;
}

/** `role_provider(role)`: the model's provider prefix, else the driver's. */
function roleProvider(role: JsonObject): ProviderKey {
  const model = roleField(role, 'model');
  if (typeof model !== 'string') throw shape('role model is not a string');
  const slash = model.indexOf('/');
  if (slash !== -1) return alias(model.slice(0, slash));
  const driver = roleField(role, 'driver');
  if (typeof driver === 'string') return alias(driver);
  if (Array.isArray(driver) || driver instanceof JsonObject)
    throw shape('role driver is unhashable');
  return null;
}

/** `fallback_models` as Python iterates it: a list, a string's characters or a dict's keys. */
function iterateModels(models: JsonValue): JsonValue[] {
  if (Array.isArray(models)) return models;
  if (typeof models === 'string') return Array.from(models);
  if (models instanceof JsonObject) return models.entries.map(([name]) => name);
  throw shape('repair.fallback_models is not iterable');
}

function fallbackRoles(role: JsonObject, models: JsonValue): JsonObject[] {
  const roles: JsonObject[] = [role];
  for (const model of iterateModels(models)) {
    if (roleField(role, 'driver') === 'cq' && model !== roleField(role, 'model')) {
      roles.push(
        new JsonObject([
          ...role.entries.filter(([name]) => name !== 'driver' && name !== 'model'),
          ['driver', 'cq'],
          ['model', model],
        ]),
      );
    }
  }
  return roles;
}

// ----------------------------------------------------------------- effects --

export function fileRepairPauseEffects(options: RepairPauseSourceOptions): RepairPauseEffects {
  const { stateRoot } = options;
  const clock = options.now ?? ((): Date => new Date());
  const env = options.env ?? currentEntryEnv();
  const pausePath = join(stateRoot, 'repair', 'rate-limited-until');
  const cooldownPath = join(stateRoot, 'repair', 'provider-cooldowns.json');
  const lock =
    options.lock ??
    (async <T>(fn: () => Promise<T>): Promise<T> => {
      await mkdir(stateRoot, { recursive: true });
      return withLock(join(stateRoot, 'tick.lock'), { wait: true }, fn);
    });

  const bound = (text: string): string => text.slice(0, MAX_REASON);

  async function paused(now?: Date): Promise<string | null> {
    if (!(await pathExists(pausePath))) return null;
    let until: string;
    let endMicros: bigint;
    try {
      const marker = await readJsonValue(pausePath);
      // `json.loads(...)['until']`: a non-object, a missing key or a non-string all raise
      // inside the try, so each falls through to the mtime window.
      const raw = marker instanceof JsonObject ? marker.get('until') : undefined;
      if (typeof raw !== 'string') throw new StateFileUnreadable('no usable until');
      const parsed = parseUtcUnchecked(raw);
      if (parsed === null) throw new StateFileUnreadable('malformed until');
      // A naive datetime raises on the aware comparison below, outside Python's try.
      if (!utcHasOffset(raw)) throw shape("can't compare offset-naive and offset-aware datetimes");
      until = raw;
      endMicros = parsed;
    } catch (error) {
      if (!(error instanceof StateFileUnreadable)) throw error;
      // Unreadable marker: fail closed for one default window from its mtime.
      const info = await stat(pausePath, { bigint: true });
      endMicros = fromTimestampMicros(pythonMtime(info.mtimeNs)) + DEFAULT_RATE_LIMIT_PAUSE_MICROS;
      until = stampOf(endMicros);
    }
    return endMicros > microsOf(now ?? clock()) ? until : null;
  }

  async function providerCooldowns(): Promise<ReadonlyMap<string, string>> {
    try {
      await stat(cooldownPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      // Path.exists() would read an unstatable file as absent, i.e. no cooldown.
      const code = (error as NodeJS.ErrnoException).code ?? 'OSError';
      throw new CooldownStateError(`provider-cooldowns.json cannot be inspected: ${code}`);
    }
    let state: JsonValue;
    try {
      state = await readJsonValue(cooldownPath);
    } catch (error) {
      if (error instanceof StateFileUnreadable) {
        const unreadable = /^[A-Z][A-Z0-9]+: /.test(error.message);
        throw new CooldownStateError(
          unreadable
            ? `provider-cooldowns.json is unreadable: ${bound(error.message)}`
            : `provider-cooldowns.json is not valid JSON: ${bound(error.message)}`,
        );
      }
      throw error;
    }
    const stamps = new Map<string, string>();
    if (!(state instanceof JsonObject)) {
      throw new CooldownStateError('provider-cooldowns.json holds an invalid cooldown timestamp');
    }
    for (const [provider, stamp] of state.entries) {
      if (!validCooldownStamp(stamp)) {
        throw new CooldownStateError('provider-cooldowns.json holds an invalid cooldown timestamp');
      }
      stamps.set(provider, stamp);
    }
    return stamps;
  }

  function providerReady(role: JsonObject): boolean {
    const provider = roleProvider(role);
    const keys = provider === null ? undefined : PROVIDER_ENV[provider];
    return (keys ?? []).every((key) => (env[key] ?? '') !== '');
  }

  async function dispatchPaused(config: JsonValue): Promise<string | null> {
    const repair = mapping(mapping(config, 'config').get('repair'), 'config.repair');
    const models = repair.get('fallback_models');
    if (pythonTruthy(models)) {
      let state: ReadonlyMap<string, string>;
      try {
        state = await providerCooldowns();
      } catch (error) {
        // Fail closed rather than reading a corrupt stamp as expired.
        if (error instanceof CooldownStateError) return OPERATOR_RECOVERY_PAUSE;
        throw error;
      }
      const now = stampOf(microsOf(clock()));
      const configured = mapping(repair.get('roles'), 'config.repair.roles');
      const candidates: JsonObject[] = [];
      for (const [, role] of configured.entries) {
        for (const candidate of fallbackRoles(mapping(role, 'repair role'), models as JsonValue)) {
          if (providerReady(candidate)) candidates.push(candidate);
        }
      }
      // `state.get(provider, '') <= now`: only a string provider can have a stamp.
      const ready = candidates.some((candidate) => {
        const provider = roleProvider(candidate);
        const stamp = provider === null ? '' : (state.get(provider) ?? '');
        return compareCodePoints(stamp, now) <= 0;
      });
      if (ready) return null;
    }
    return paused();
  }

  async function rateLimitPause(report: JsonValue, jobId: JsonValue): Promise<string> {
    const body = mapping(report, 'report');
    let retry = body.get('retry_after_ms');
    if (retry === undefined || retry === null) {
      const signals = body.get('providerSignals');
      retry = pythonTruthy(signals)
        ? mapping(signals, 'report.providerSignals').get('retryAfterMs')
        : undefined;
    }
    let wait = DEFAULT_RATE_LIMIT_PAUSE_MICROS;
    if (retry instanceof JsonNumber) {
      const positive =
        retry.kind === 'int' ? (retry.integer ?? 0n) > 0n : (retry.float ?? Number.NaN) > 0;
      if (positive) {
        const requested = timedeltaMicros(retry, 1000);
        wait = requested < MAX_RATE_LIMIT_PAUSE_MICROS ? requested : MAX_RATE_LIMIT_PAUSE_MICROS;
      }
    }
    let until = stampOf(microsOf(clock()) + wait);
    await lock(async () => {
      const current = await paused();
      if (current !== null && compareCodePoints(current, until) > 0) {
        until = current; // never shorten an existing pause
      }
      const record = new JsonObject([
        ['until', until],
        ['job', jobId],
        ['at', stampOf(microsOf(clock()))],
      ]);
      await mkdir(join(stateRoot, 'repair'), { recursive: true });
      await atomicWrite(pausePath, atomicJsonText(record));
    });
    return until;
  }

  return { paused, providerCooldowns, dispatchPaused, rateLimitPause };
}
