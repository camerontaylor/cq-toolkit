/**
 * Read-only crq status route for migration lane A1.
 *
 * The Python producers are the oracle: `status_summary.summarize` plus the
 * receipt-aware `status_summary.merged_current` for the summary core that
 * `status_summary.publish` writes before its effect sections, and
 * `client_health.snapshot` for the durable health view. This module owns only
 * the wiring Python keeps beside those pure functions: reading the state
 * documents, validating the queue with the phase 0.2 schema, splicing the
 * lossless `usage.limit` lexeme, pre-loading receipt bytes, preserving Python's
 * JSONL line semantics, ordering the publish-core keys, and serialising with
 * `pythonJson` (never `JSON.stringify`; `starts_cap` may be a lossless
 * `JsonNumber` and `aging_deadline` is a Python float).
 *
 * Effects are injected: this module never reads the environment, spawns a
 * process, touches the network or writes any file. The adapter in
 * `src/adapters/crq/statusSource.ts` binds real files and stdio.
 */
import {
  ClientHealthError,
  clientHealthSnapshot,
  type ClientHealthSnapshot,
} from '../../policy/crq/clientHealth.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import { pythonJsonText, type PythonJsonOptions } from '../../policy/crq/pythonJson.js';
import { MERGED_CURRENT_KIND, isRecord, type CrqRecord } from '../../policy/crq/receiptIdentity.js';
import { parseCrqState, stateValueWithNumbers } from '../../policy/crq/state.js';
import {
  StatusSummaryError,
  mergedCurrent,
  pythonIntValue,
  summarize,
  type StatusSummaryView,
  type SummaryInteger,
} from '../../policy/crq/statusSummary.js';

/** The only effects this read-only route may perform. */
export interface ReadOnlyStatusEffects {
  /** `state/queue.json` text. */
  readQueue(): Promise<string>;
  /** The runner's `config.json` text. */
  readConfig(): Promise<string>;
  /** `state/events.jsonl` text. */
  readEvents(): Promise<string>;
  /** Retained receipt bytes by id; `null` when unavailable (Python's OSError catch). */
  readReceipt(receiptId: string): Promise<Uint8Array | null>;
  /** One wall clock reading for the whole invocation, in epoch seconds. */
  now(): number;
}

export type StatusRouteErrorKind =
  | 'queue-invalid'
  | 'config-invalid'
  | 'events-invalid'
  | 'summary-failed'
  | 'health-failed';

/** A refusal with a stable class for CLI diagnostics. */
export class StatusRouteError extends Error {
  override readonly name = 'StatusRouteError';
  readonly kind: StatusRouteErrorKind;

  constructor(kind: StatusRouteErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The publish-core document plus the timestamp its `generated_at` carries. */
export interface SummaryCore {
  readonly value: Record<string, unknown>;
  readonly generatedAt: string;
}

const COMPACT_JSON: PythonJsonOptions = {
  asciiOnly: true,
  sortKeys: false,
  keyOrder: 'insertion',
  indent: null,
  trailingNewline: true,
};
const PRETTY_JSON: PythonJsonOptions = { ...COMPACT_JSON, indent: 2 };

const USAGE = 'usage: crq read-only-status <summary-core|health> [--pretty]\n';

/**
 * `datetime.fromtimestamp(value, utc).strftime("%Y-%m-%dT%H:%M:%SZ")`.
 *
 * `floor(seconds * 1000)` keeps Python's sub-second truncation instead of
 * letting `Date` round a fractional millisecond across a second boundary.
 */
export function utcIsoSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    throw new StatusRouteError('summary-failed', 'invalid clock reading');
  }
  const date = new Date(Math.floor(seconds * 1000));
  if (Number.isNaN(date.getTime())) {
    throw new StatusRouteError('summary-failed', 'clock reading out of range');
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The summary core `status_summary.publish` builds before it appends its
 * systemd/repair/triage/utilization/schedule sections.
 *
 * `status` and `heartbeat` are synthetic exactly as Python builds them:
 * `{"generated_at": generated}` and `{"last_tick": queue.last_tick}`. Title
 * enrichment and the effect sections are deliberately out of this slice.
 */
export async function readSummaryCore(effects: ReadOnlyStatusEffects): Promise<SummaryCore> {
  const now = effects.now();
  const generatedAt = utcIsoSeconds(now);
  const queue = await loadQueue(effects);
  const config = await loadConfig(effects);
  const events = await loadEvents(effects);
  const receipts = await loadReceipts(queue, effects);

  let view: StatusSummaryView;
  try {
    view = summarize(
      { generated_at: generatedAt },
      queue,
      { last_tick: queue.last_tick },
      config.value,
      events,
      now,
    );
  } catch (error) {
    throw asRouteError('summary-failed', error);
  }

  let merged;
  try {
    // Python publishes the receipt-aware view: `summarize` alone cannot read
    // receipt bytes, so its `merged_current` counts every terminal item as
    // unverified and `publish` overwrites it with this call.
    merged = mergedCurrent(queue, (receiptId) => receipts.get(receiptId) ?? null);
  } catch (error) {
    throw asRouteError('summary-failed', error);
  }

  return {
    value: coreDocument(view, merged, generatedAt, queue, config.lossless),
    generatedAt,
  };
}

/** `client_health.snapshot` over the same validated queue. */
export async function readClientHealth(
  effects: ReadOnlyStatusEffects,
): Promise<Record<string, unknown>> {
  const queue = await loadQueue(effects);
  // Python loads the queue first, then `snapshot` reads the wall clock.
  const now = effects.now();
  let snapshot: ClientHealthSnapshot;
  try {
    snapshot = clientHealthSnapshot(queue, now);
  } catch (error) {
    throw asRouteError('health-failed', error);
  }
  return {
    ...snapshot,
    // Python's `max(0, delta.total_seconds())` is the int 0 when the delta is
    // non-positive and a float otherwise, so only a positive age is a float.
    ageSeconds:
      snapshot.ageSeconds !== null && snapshot.ageSeconds > 0
        ? JsonNumber.float(snapshot.ageSeconds)
        : snapshot.ageSeconds,
  };
}

/**
 * The read-only CLI route. Errors are returned, never thrown, so the adapter
 * can write them to stdio without a process-level handler.
 */
export async function runReadOnlyStatus(
  argv: readonly string[],
  effects: ReadOnlyStatusEffects,
): Promise<CommandResult> {
  const [command, ...rest] = argv;
  if (command === undefined) return usageError('missing subcommand');
  if (command === 'help' || command === '--help' || command === '-h') {
    return { exitCode: 0, stdout: USAGE, stderr: '' };
  }
  let pretty = false;
  for (const argument of rest) {
    if (argument === '--pretty') {
      pretty = true;
      continue;
    }
    return usageError(`unknown option ${argument} for ${command}`);
  }
  if (command !== 'summary-core' && command !== 'health') {
    return usageError(`unknown subcommand ${command}`);
  }
  const failureKind: StatusRouteErrorKind =
    command === 'health' ? 'health-failed' : 'summary-failed';
  try {
    const value =
      command === 'summary-core'
        ? (await readSummaryCore(effects)).value
        : await readClientHealth(effects);
    return {
      exitCode: 0,
      stdout: pythonJsonText(value, pretty ? PRETTY_JSON : COMPACT_JSON),
      stderr: '',
    };
  } catch (error) {
    const route = asRouteError(failureKind, error);
    return { exitCode: 1, stdout: '', stderr: `${route.kind}: ${route.message}\n` };
  }
}

async function loadQueue(effects: ReadOnlyStatusEffects): Promise<CrqRecord> {
  let text: string;
  try {
    text = await effects.readQueue();
  } catch (error) {
    throw new StatusRouteError('queue-invalid', `queue.json unavailable: ${messageOf(error)}`);
  }
  const accepted = parseCrqState('queue.schema.json', text);
  if (!accepted.ok) {
    throw new StatusRouteError(
      'queue-invalid',
      `queue.json rejected by policy/crq/queue.schema.json: ${accepted.issues.join('; ') || 'no detail'}`,
    );
  }
  let value: unknown;
  try {
    // `toPlainJson` loses the `3` vs `3.0` lexeme; splice the exact
    // `JsonNumber` so `type(usage.limit) is int` keeps its Python meaning.
    value = stateValueWithNumbers(accepted, [['usage', 'limit']]);
  } catch (error) {
    throw new StatusRouteError('queue-invalid', messageOf(error));
  }
  if (!isRecord(value)) {
    throw new StatusRouteError('queue-invalid', 'queue.json is not an object');
  }
  return value;
}

interface LoadedConfig {
  readonly value: CrqRecord;
  readonly lossless: JsonValue;
}

async function loadConfig(effects: ReadOnlyStatusEffects): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await effects.readConfig();
  } catch (error) {
    throw new StatusRouteError('config-invalid', `config.json unavailable: ${messageOf(error)}`);
  }
  let lossless: JsonValue;
  try {
    lossless = parseJsonValue(text, { duplicates: 'last' });
  } catch (error) {
    throw new StatusRouteError('config-invalid', messageOf(error));
  }
  if (!(lossless instanceof JsonObject)) {
    throw new StatusRouteError('config-invalid', 'config.json is not an object');
  }
  const value = toPlainJson(lossless);
  if (!isRecord(value)) {
    throw new StatusRouteError('config-invalid', 'config.json materialised to a non-object');
  }
  return { value, lossless };
}

async function loadEvents(effects: ReadOnlyStatusEffects): Promise<unknown[]> {
  let text: string;
  try {
    text = await effects.readEvents();
  } catch (error) {
    throw new StatusRouteError('events-invalid', `events.jsonl unavailable: ${messageOf(error)}`);
  }
  const events: unknown[] = [];
  for (const { line, terminated, number } of pythonTextLines(text)) {
    try {
      events.push(eventValue(parseJsonValue(line, { duplicates: 'last' })));
    } catch (error) {
      // `status_summary.read_events`: a complete corrupt record is fatal; an
      // unterminated final fragment is ignored.
      if (terminated) {
        throw new StatusRouteError(
          'events-invalid',
          `events.jsonl line ${String(number)}: ${messageOf(error)}`,
        );
      }
    }
  }
  return events;
}

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Python's `finished[event.get("run")]` uses the int itself as a dict key, so
 * two run ids above 2^53 stay distinct. `toPlainJson` would round both to the
 * same double and silently collapse them into one outcome; keep only the
 * top-level `run` integer lossless as a BigInt, while every other field keeps
 * its materialised value so timestamp and outcome handling are unchanged.
 */
function eventValue(parsed: JsonValue): unknown {
  const plain = toPlainJson(parsed);
  if (!(parsed instanceof JsonObject) || !isRecord(plain)) return plain;
  const run = parsed.get('run');
  if (
    run instanceof JsonNumber &&
    run.kind === 'int' &&
    run.integer !== null &&
    (run.integer > MAX_SAFE_INTEGER || run.integer < MIN_SAFE_INTEGER)
  ) {
    return { ...plain, run: run.integer };
  }
  return plain;
}

interface TextLine {
  readonly line: string;
  readonly terminated: boolean;
  readonly number: number;
}

/**
 * Python text-mode iteration: universal newlines translate `\r\n` and `\r` to
 * `\n`, the final line is yielded without a terminator, and an empty file
 * yields nothing (while a file ending in a newline does not yield a trailing
 * empty line).
 */
function pythonTextLines(text: string): TextLine[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const parts = normalized.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((line, index) => ({
    line,
    terminated: index < parts.length - 1 || normalized.endsWith('\n'),
    number: index + 1,
  }));
}

/**
 * Receipt bytes for every terminal `merged-current` item that names a valid
 * receipt id. `merged_current` is synchronous, so reads happen first; a read
 * failure becomes `null`, which Python's outer `except OSError` also treats as
 * `unverified`.
 */
async function loadReceipts(
  queue: CrqRecord,
  effects: ReadOnlyStatusEffects,
): Promise<ReadonlyMap<string, Uint8Array | null>> {
  const items = Array.isArray(queue.items) ? queue.items : [];
  const ids = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.kind !== MERGED_CURRENT_KIND) continue;
    const state = item.state;
    if (state === 'pending' || state === 'reviewing' || state === 'blocked') continue;
    const receiptId = item.receipt_id;
    if (typeof receiptId === 'string' && /^[0-9a-f]{64}$/.test(receiptId)) ids.add(receiptId);
  }
  const entries = await Promise.all(
    [...ids].map(async (receiptId) => {
      try {
        return [receiptId, await effects.readReceipt(receiptId)] as const;
      } catch {
        return [receiptId, null] as const;
      }
    }),
  );
  return new Map(entries);
}

function coreDocument(
  view: StatusSummaryView,
  merged: ReturnType<typeof mergedCurrent>,
  generatedAt: string,
  queue: CrqRecord,
  configLossless: JsonValue,
): Record<string, unknown> {
  const pendingItems = view.pending_items.map((item) => ({
    ...item,
    // Python's `timestamp()` is a float, so an aging deadline is always a
    // Python float (or null). A plain `number` would serialise `3600` instead
    // of Python's `3600.0`.
    aging_deadline: item.aging_deadline === null ? null : JsonNumber.float(item.aging_deadline),
  }));
  // Key order matters for the byte diff: the core keeps `summarize`'s order,
  // `merged_current` keeps its existing position, and `schema_version` then
  // `generated_at` are appended (Python's `data.update(schema_version=2,
  // generated_at=generated)`).
  return {
    ...view,
    pending_items: pendingItems,
    merged_current: merged,
    starts_cap: exactStartsCap(view.starts_cap, queue, configLossless),
    schema_version: 2,
    generated_at: generatedAt,
  };
}

/**
 * When the cap falls back to `config.max_starts_per_hour`, keep the config's
 * lossless lexeme: a configured `5.0` is a Python float and serialises as
 * `5.0`, and an integer outside the safe range keeps its exact digits.
 */
function exactStartsCap(
  cap: SummaryInteger,
  queue: CrqRecord,
  configLossless: JsonValue,
): SummaryInteger {
  if (cap instanceof JsonNumber) return cap;
  const usage = queue.usage;
  const limit = isRecord(usage) ? pythonIntValue(usage.limit) : null;
  if (limit !== null && positiveInteger(limit)) return cap;
  if (configLossless instanceof JsonObject) {
    const configured = configLossless.get('max_starts_per_hour');
    if (configured instanceof JsonNumber) return configured;
  }
  return cap;
}

function positiveInteger(value: SummaryInteger): boolean {
  return value instanceof JsonNumber ? (value.integer as bigint) > 0n : value > 0;
}

function asRouteError(kind: StatusRouteErrorKind, error: unknown): StatusRouteError {
  if (error instanceof StatusRouteError) return error;
  // Preserve the Python exception class for diagnostics without leaking a
  // stack: `client_health` and `status_summary` name their analogue.
  if (error instanceof ClientHealthError || error instanceof StatusSummaryError) {
    return new StatusRouteError(kind, `${error.pythonError}: ${error.message}`);
  }
  return new StatusRouteError(kind, messageOf(error));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usageError(message: string): CommandResult {
  return { exitCode: 2, stdout: '', stderr: `${message}\n${USAGE}` };
}
