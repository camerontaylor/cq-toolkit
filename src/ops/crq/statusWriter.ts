/**
 * `crq.write_status` for the TypeScript runner: status.md, status.json and the
 * fleet summary refresh, exactly as the Python operator command builds them.
 *
 * Python is the oracle (`apps/crq-python/crq.py`, `write_status` plus the
 * helpers it reads: `live_items`, `rank`, `sort_key`, `starts_last_hour`,
 * `inflight`, `repo_status_lines`, `item_repo`, `completed_open_cycles`,
 * `iso`). The composed document pieces are delegated, never re-derived:
 *
 * - the fleet summary is published through the injected
 *   {@link StatusWriterEffects.publishSummary} seam, which the adapter binds
 *   to `readSummaryCore` + `publishSummary` + the atomic writer (the exact
 *   `status_summary.publish` pipeline);
 * - `status.json` is the phase 0.2 `status.schema.json` projection, validated
 *   with `parseCrqState('status.schema.json', ...)` before the write so drift
 *   fails closed, and serialised with `json.dumps(indent=2)` plus a trailing
 *   newline;
 * - the status.md JSON blocks keep Python's *default* `json.dumps`
 *   separators (`", "` and `": "`) with `ensure_ascii` escaping. The encoder
 *   options here differ from the compact publish encoding by that space, so
 *   the shared `pythonJson` encoder takes one `spacedSeparators` flag.
 *
 * Effects are injected: this module reads no file, consults no environment,
 * spawns no process and reads no clock. The adapter in
 * `adapters/crq/statusWriter.js` binds real state. Errors carry the Python
 * exception class the oracle would raise for the same input.
 */
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import { pythonJsonText, type PythonJsonOptions } from '../../policy/crq/pythonJson.js';
import {
  PublishEffectsError,
  findingTriage,
  repairDigest,
  type RepairInboxState,
  type SystemdClock,
  type TriageRowFile,
} from '../../policy/crq/publishEffects.js';
import {
  MERGED_CURRENT_KIND,
  isRecord,
  pythonEqual,
  type CrqRecord,
} from '../../policy/crq/receiptIdentity.js';
import { parseCrqState } from '../../policy/crq/state.js';
import { utilizationDigest } from '../../policy/crq/coverageUtilization.js';
import { mergedCurrent, type MergedCurrentView } from '../../policy/crq/statusSummary.js';
import { parseIso, parseUtc, formatUtcMicros } from '../../policy/crq/utc.js';

/** Kind string Python resolves through `author_quota.AUTHOR_KIND`. */
const AUTHOR_KIND = 'author';
/** `author_quota.AUTHOR_RANK`. */
const AUTHOR_RANK = 4;
/** `coverage.COVERAGE_RANK`. */
const COVERAGE_RANK = 4;
/** `review_operation.KIND` (the local-review runtime's kind). */
const LOCAL_REVIEW_KIND = 'local-review';
/** `backfill_jobs.KIND`. */
const BACKFILL_KIND = 'backfill';
/** `repo_registry.DEFAULT_RANK`. */
const DEFAULT_REPO_RANK = 3;
/** `config.local_review_aging_minutes` fallback (Python `.get(..., 60)`). */
const DEFAULT_AGING_MINUTES = 60;
/** The strict `%Y-%m-%dT%H:%M:%SZ` shape `iso()` always emits. */
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Python exception classes `crq.write_status` lets escape as CLI failures. */
export type StatusWriterPythonError = PublishEffectsError['pythonError'] | 'OverflowError';

/** A refusal carrying the Python exception class the oracle would raise. */
export class StatusWriterError extends Error {
  override readonly name = 'StatusWriterError';
  readonly pythonError: StatusWriterPythonError;

  constructor(message: string, pythonError: StatusWriterPythonError) {
    super(message);
    this.pythonError = pythonError;
  }
}

/**
 * One publish-failure observation: the producer appends
 * `summary_failed error=<type(exc).__name__>` to events.jsonl and keeps the
 * last complete summary. The route returns the record; the adapter appends it.
 */
export interface PublishFailureEvent {
  readonly event: 'summary_failed';
  /** `type(exc).__name__`, the Python exception class name. */
  readonly error: string;
}

/**
 * The composer's local triage and repair seams: status.md embeds
 * `finding_triage` and `repair_tick.digest` from the effect snapshot the
 * adapter assembles, exactly as Python calls them inline.
 */
export interface StatusComposerSeams {
  /** The sorted `triage/*.json` rows as exact bytes (null bytes = row error). */
  readonly triageRows: readonly TriageRowFile[];
  /** The repair inbox state (`repair_tick.digest`'s seam). */
  readonly inbox: RepairInboxState;
}

/**
 * The write effects. Every path and value is resolved by the adapter; this
 * route never consults the environment or the clock directly. The summary
 * publish owns its own effect snapshot (previous-summary cache, repair inbox,
 * triage rows, systemd probe), so only the reads, writes, schedule probe,
 * event append and clock are bound here.
 */
export interface StatusWriterEffects {
  /** The status.md triage/repair snapshot, assembled at adapter time. */
  readonly composerSeams: StatusComposerSeams;
  /** `queue.json` text, strictly decoded UTF-8 by the adapter. */
  readQueue(): Promise<string>;
  /** `config.json` text. */
  readConfig(): Promise<string>;
  /** `state/events.jsonl` text, or '' when the file does not exist yet. */
  readEvents(): Promise<string>;
  /** Receipt bytes by validated id; null when unavailable (OSError catch). */
  readReceipt(receiptId: string): Promise<Uint8Array | null>;
  /**
   * The `paseo schedule inspect` port: resolve the exact stdout on exit 0,
   * or null on spawn failure / non-zero exit / timeout. A null result is the
   * producer's `except Exception: pass` empty schedule, never fatal.
   */
  probeSchedule(
    scheduleId: string,
  ): Promise<{ readonly stdout: string | null; readonly failure: string | null }>;
  /** One wall-clock reading for the whole invocation, epoch seconds. */
  now(): number;
  /** Write status.md text (the plain `Path.write_text` swap). */
  writeStatusMarkdown(text: string): Promise<void>;
  /** Write status.json bytes (the plain `Path.write_text` swap). */
  writeStatusJson(bytes: Uint8Array): Promise<void>;
  /** Append one event record (`crq.event`); only failures use it here. */
  appendEvent(event: PublishFailureEvent): Promise<void>;
  /**
   * The bound `status_summary.publish`: compose the summary from this exact
   * queue/config, write it atomically, and resolve its document. Throwing is
   * the producer's publish failure path (captured as `summary_failed`).
   */
  publishSummary(documents: CrqDocuments): Promise<Record<string, unknown>>;
}

/** The validated queue/config pair the route works from. */
export interface CrqDocuments {
  /** The exact lossless queue document. */
  readonly queue: CrqRecord;
  /** The exact lossless config document. */
  readonly config: CrqRecord;
  /**
   * The live `paseo schedule inspect` outcome this invocation probed (the
   * `schedule` dict Python passes to `status_summary.publish`). Undefined
   * for direct route callers that never probed; the adapter's publish seam
   * falls back to the producer's initial dict in that case.
   */
  readonly scheduleProbe?: ScheduleProbeOutcome;
}

/** The three write results plus the optional publish failure event. */
export interface StatusWriteResult {
  /** The status.md text that was written (and printed to stdout). */
  readonly markdown: string;
  /** The status.json document that was written. */
  readonly status: Record<string, unknown>;
  /** The published summary document. Null when `publish` failed. */
  readonly summary: Record<string, unknown> | null;
  /** Present only when the summary publish failed. */
  readonly publishFailure?: PublishFailureEvent;
}

/** Python `json.dumps` default separators with ASCII escaping. */
const DEFAULT_JSON: PythonJsonOptions = {
  asciiOnly: true,
  sortKeys: false,
  keyOrder: 'insertion',
  indent: null,
  spacedSeparators: true,
};

/** Python `json.dumps(value, sort_keys=True)` for `merged_current` and triage. */
const SORTED_JSON: PythonJsonOptions = { ...DEFAULT_JSON, sortKeys: true, keyOrder: 'code-point' };

/** Python `json.dumps(value, indent=2)` plus one trailing newline (status.json). */
const INDENTED_JSON: PythonJsonOptions = { ...DEFAULT_JSON, indent: 2, trailingNewline: true };

/**
 * `json.dumps` for the JSON blocks inside status.md: accept only the JSON
 * domain (scalars, records, arrays). A Map/Set/function reaching this line is
 * a programmer error, refused rather than rendered as a shape no Python
 * encoder can produce.
 */
export function jsonScalar(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    value instanceof JsonNumber
  ) {
    return value;
  }
  // Plain JS numbers (from JSON.parse'd triage rows and digest documents)
  // wrap into the lossless JsonNumber the encoder expects: an integer lexeme
  // stays an int, anything else a float, exactly Python's int/float split.
  if (typeof value === 'number') {
    return Number.isInteger(value) && Number.isSafeInteger(value)
      ? JsonNumber.int(value)
      : JsonNumber.float(value);
  }
  if (value instanceof JsonObject) {
    return new JsonObject(value.entries.map(([key, entry]) => [key, jsonScalar(entry)] as const));
  }
  if (Array.isArray(value)) return value.map((entry) => jsonScalar(entry));
  // `isRecord` is shape-only: a Map/Set instance would silently render its
  // enumerable members, which no Python encoder produces, so the prototype
  // is checked before the record path.
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return new JsonObject(Object.keys(value).map((key) => [key, jsonScalar(value[key])] as const));
  }
  throw new StatusWriterError('status.md JSON blocks serialise plain JSON data only', 'TypeError');
}

/**
 * Live queue items: retired promotion records stay on disk, outside the
 * active queue. Ceres still carries them, so this filter is load-bearing;
 * deleting it would make them live again in status rows and counts.
 */
export function liveItems(queue: CrqRecord): CrqRecord[] {
  return requireItems(queue).filter((item) => item['kind'] !== 'promotion');
}

function requireItems(queue: CrqRecord): CrqRecord[] {
  const list = queue['items'];
  if (!Array.isArray(list)) {
    throw new StatusWriterError('queue.items must be a list', 'TypeError');
  }
  return list.map((item) => {
    if (!isRecord(item)) {
      throw new StatusWriterError(
        `'${pythonTypeName(item)}' object is not subscriptable`,
        'TypeError',
      );
    }
    return item;
  });
}

/**
 * `item_repo`: legacy items without `repo` are primary-repo items. The
 * primary slug is a parameter because the route is pure.
 */
export function itemRepo(item: CrqRecord, primary: string): string {
  const repo = item['repo'];
  return nonEmptyText(repo) ?? primary;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** `crq.completed_open_cycles`: only recorded terminal cycles satisfy the head review. */
export function completedOpenCycles(item: CrqRecord): number {
  const cycles = item['cycles'];
  return Array.isArray(cycles) ? cycles.length : 0;
}

/** `crq.additional_cycle`: served open/author work parks at rank 5. */
export function additionalCycle(item: CrqRecord): boolean {
  return (
    (item['kind'] === 'open' && completedOpenCycles(item) >= 1) ||
    (item['kind'] === AUTHOR_KIND && authorCycleOf(item) > 1)
  );
}

function authorCycleOf(item: CrqRecord): number {
  const author = item['author'];
  if (!isRecord(author)) return 1;
  const cycle = author['cycle'];
  return pythonNumberIsInt(cycle) ? cycle : 1;
}

function pythonNumberIsInt(value: unknown): value is number {
  // A lossless bigint IS Python's int (gYDE): a document parsed from bytes
  // through a lossless path keeps exact integers as bigint, and Python
  // accepts both the plain int and the lossless int identically.
  if (typeof value === 'bigint') return true;
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * `crq.rank` with the config-sourced aging window and one clock reading:
 * required open 0, open delta 1, merged follow-ups/current 2, backlog 3,
 * author/coverage 4, optional additional cycles 5. Non-primary repos use
 * their configured `rank_tier` (default 3). A repeat local-review is rank 0
 * when its aging window has passed (created_at older than the window), rank 1
 * otherwise; an unparsable created_at never ages.
 */
export function crqRank(
  item: CrqRecord,
  primary: string,
  repos: readonly CrqRecord[],
  agingMinutes: number,
  now: number,
): number {
  if (additionalCycle(item)) return 5;
  const kind = item['kind'];
  if (kind === 'open') return 0;
  if (kind === 'delta' && item['followup'] !== 'merged') return 1;
  if (kind === LOCAL_REVIEW_KIND) {
    // First review unless generation, explicit repeat, or an ancestral
    // predecessor classifies it a repeat (S3a).
    if (
      pythonEqual(item['generation'] === undefined ? 1 : item['generation'], 1) &&
      item['repeat_requested'] !== true &&
      item['ancestry_repeat'] !== true
    ) {
      return 0;
    }
    const created = parseUtc(item['created_at']);
    if (created === null) return 1;
    return secondsOf(created) >= now - agingMinutes * 60 ? 1 : 0;
  }
  const repoRank = repoRankFor(item, primary, repos);
  if (repoRank !== null) return repoRank;
  if (kind === MERGED_CURRENT_KIND) return 2;
  if (kind === 'coverage' || kind === BACKFILL_KIND) return COVERAGE_RANK;
  if (kind === AUTHOR_KIND) return AUTHOR_RANK;
  if (kind === 'delta') return 2;
  return item['source'] === 'followup' ? 2 : 3;
}

/** `local_review_aging_minutes` from the config, default 60 (Python `.get`). */
export function localReviewAgingMinutes(config: CrqRecord): number {
  const value = config['local_review_aging_minutes'];
  if (value === undefined) return DEFAULT_AGING_MINUTES;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new StatusWriterError('local_review_aging_minutes must be a number', 'TypeError');
}

function secondsOf(instant: { readonly epochMicros: bigint }): number {
  return Number(instant.epochMicros) / 1_000_000;
}

/**
 * `repo_registry.rank_for`: a non-primary repo's configured tier; null keeps
 * the kind's own rank. Identity is case-insensitive (GitHub slugs are).
 */
export function repoRankFor(
  item: CrqRecord,
  primary: string,
  repos: readonly CrqRecord[],
): number | null {
  const slug = itemRepo(item, primary);
  if (repoIdentity(slug) === repoIdentity(primary)) return null;
  const configured = repos.find((entry) => repoIdentity(entry['repo']) === repoIdentity(slug));
  // `entry.get("rank_tier", DEFAULT_RANK)`: the default applies to an omitted
  // key on a configured repo, not only to an unconfigured repo.
  const tier =
    configured === undefined || configured['rank_tier'] === undefined
      ? DEFAULT_REPO_RANK
      : configured['rank_tier'];
  if (!pythonNumberIsInt(tier)) {
    throw new StatusWriterError('rank_tier must be an integer', 'TypeError');
  }
  return typeof tier === 'bigint' ? Number(tier) : tier;
}

function repoIdentity(slug: unknown): string {
  // Repository slugs are ASCII by grammar; `casefold` for them is lowercase.
  return typeof slug === 'string' ? slug.toLowerCase() : '';
}

function integerOf(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (pythonNumberIsInt(value)) return value;
  if (value instanceof JsonNumber && value.kind === 'int') {
    const integer = value.integer as bigint;
    if (integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(integer);
    }
  }
  return fallback;
}

/**
 * `crq.sort_key`: explicit operator priority precedes ordinary rank and
 * insertion order.
 */
export function sortKey(
  item: CrqRecord,
  primary: string,
  repos: readonly CrqRecord[],
  agingMinutes: number,
  now: number,
): readonly [number, number, number] {
  return [
    item['operator_priority'] === true ? 0 : 1,
    crqRank(item, primary, repos, agingMinutes, now),
    integerOf(item['order'], 999),
  ];
}

/**
 * `starts_last_hour`: each retained start through the strict `parse_iso`;
 * malformed values raise exactly like Python's `strptime` inside the sum.
 */
export function startsLastHour(queue: CrqRecord, nowSeconds: number): number {
  const starts = queue['starts'];
  const list = Array.isArray(starts) ? starts : [];
  let count = 0;
  for (const value of list) {
    const at = parseIso(value);
    if (at === null) continue;
    if (secondsOf(at) > nowSeconds - 3600) count += 1;
  }
  return count;
}

/** `backfill_jobs.is_execution_owner`. */
export function isExecutionOwner(item: CrqRecord): boolean {
  return (
    item['vendor_state'] === 'live' ||
    item['vendor_state'] === 'unknown' ||
    pyTruthy(item['run']) ||
    item['state'] === 'reviewing' ||
    item['state'] === 'launch-unknown'
  );
}

function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/** `inflight`: reviewing items plus executing coverage/backfill work. */
export function inflight(queue: CrqRecord): CrqRecord[] {
  return liveItems(queue).filter(
    (item) =>
      item['state'] === 'reviewing' ||
      ((item['kind'] === 'coverage' || item['kind'] === BACKFILL_KIND) && isExecutionOwner(item)),
  );
}

/**
 * One configured or push-discovered non-primary repo line
 * (`repo_status_lines` body). Null when the slug IS the primary repo.
 */
export function repoStatusLine(
  queue: CrqRecord,
  items: readonly CrqRecord[],
  slug: string,
  primary: string,
): string | null {
  if (repoIdentity(slug) === repoIdentity(primary)) return null;
  const mine = items.filter((item) => itemRepo(item, primary) === slug);
  const counts = { pending: 0, reviewing: 0, blocked: 0 };
  for (const item of mine) {
    const state = item['state'];
    if (state === 'pending' || state === 'reviewing' || state === 'blocked') {
      counts[state] += 1;
    }
  }
  const push = isRecord(queue['push_discovery']) ? queue['push_discovery'] : {};
  const entry = isRecord(push[slug]) ? push[slug] : {};
  const tipText = nonEmptyText(entry['reviewed_tip']) ?? 'uninitialized';
  return (
    `- repo ${pythonStrOrNone(slug)}: ${pythonStrOrNone(mine.length)} item(s) ` +
    `(${pythonStrOrNone(counts.pending)} pending, ${pythonStrOrNone(counts.reviewing)} reviewing, ` +
    `${pythonStrOrNone(counts.blocked)} blocked); ` +
    `push reviewed_tip ${tipText}`
  );
}

/** The historical `write_status` table row fields for one live item. */
export interface StatusRow {
  readonly id: unknown;
  readonly repo: string;
  readonly kind: string;
  readonly state: unknown;
  readonly cycles: string;
  readonly pinnedBase: string;
  readonly lastOutcome: string;
  readonly why: string;
  readonly extra: string;
  /** The markdown row exactly as Python interpolates it. */
  readonly markdown: string;
}

/** The markdown row for one live item (`write_status`'s row loop). */
export function statusRow(item: CrqRecord, primary: string): StatusRow {
  const kind = item['kind'];
  let cyc: string;
  let extra = '';
  if (kind === 'open') {
    cyc = `${completedOpenCycles(item)}/1`;
  } else if (kind === AUTHOR_KIND) {
    const author = isRecord(item['author']) ? item['author'] : {};
    const authorCycles = Array.isArray(item['author_cycles']) ? item['author_cycles'] : [];
    cyc = `${authorCycles.length}/1`;
    extra =
      `author cycle ${pythonStrOrNone(author['cycle'])}: ${strOrEmpty10(author['base'])}..` +
      `${strOrEmpty10(author['head'])} → ${pythonStrOrNone(author['target'])}`;
  } else {
    const cycles = item['cycles'];
    cyc = `${Array.isArray(cycles) ? cycles.length : 0}/1`;
  }
  if (kind === 'merged' && item['measure']) {
    const measure = isRecord(item['measure']) ? item['measure'] : {};
    extra =
      `survival ${pythonStrOrNone(measure['survival'])} ` +
      `(${pythonStrOrNone(measure['surviving'])}/${pythonStrOrNone(measure['added'])}), ` +
      `focus ${pythonStrOrNone(measure['focus'])}`;
  }
  const attempts = Array.isArray(item['attempts']) ? item['attempts'] : [];
  const lastIndex = attempts.length - 1;
  const last = isRecord(attempts[lastIndex]) ? attempts[lastIndex] : {};
  let why = item['state'] === 'pending' ? (item['wait_reason'] ?? '') : (item['last_error'] ?? '');
  const stalledAt = item['gate_stalled_at'];
  if (
    item['state'] === 'promoting' &&
    stalledAt !== undefined &&
    stalledAt !== null &&
    stalledAt !== false &&
    stalledAt !== 0 &&
    stalledAt !== ''
  ) {
    why = `Owner intervention required — gate stalled since ${pythonStrOrNone(stalledAt)}; ${why}`;
  }
  const kindColumn =
    `${pythonStrOrNone(kind)}` +
    (item['tier'] ? ` t${pythonStrOrNone(item['tier'])}` : '') +
    (item['source'] === 'followup' ? ' new' : '') +
    (item['followup'] === 'merged' ? ' post-merge' : '');
  const repo = itemRepo(item, primary);
  const outcome = last['outcome'];
  const whyBounded = boundedWhy(why);
  const pinnedBase = strOrEmpty10(item['pinned_base']);
  const markdown =
    `| ${pythonStrOrNone(item['id'])} | ${repo === primary ? '' : repo} | ${kindColumn} | ` +
    `${pythonStrOrNone(item['state'])} | ${cyc} | ${pinnedBase} | ` +
    // Python `last.get('outcome', '')`: a missing key is an empty cell, not
    // the string 'None' (only an explicit None value prints 'None').
    `${outcome === undefined ? '' : pythonStrOrNone(outcome)} | ${whyBounded} | ${extra} |`;
  return {
    id: item['id'],
    repo,
    kind: kindColumn,
    state: item['state'],
    cycles: cyc,
    pinnedBase,
    lastOutcome: outcome === undefined ? '' : pythonStrOrNone(outcome),
    why: whyBounded,
    extra,
    markdown,
  };
}

/** `(x or '')[:10]` on a possibly-null slug/SHA. */
function strOrEmpty10(value: unknown): string {
  const text = value === null || value === undefined ? '' : pythonStrOrNone(value);
  return text.length > 10 ? text.slice(0, 10) : text;
}

/** `(why or '')[:110]` on the why column (any scalar through Python `str`). */
function boundedWhy(value: unknown): string {
  const text = value === null || value === undefined ? '' : pythonStrOrNone(value);
  return text.length > 110 ? text.slice(0, 110) : text;
}

function pythonTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (value instanceof JsonNumber) return value.kind;
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  if (isRecord(value)) return 'dict';
  return typeof value;
}

/** The banner's `in flight` fragment: `run_id` when retained, else `signer <state>`. */
function inflightLabel(item: CrqRecord): string {
  const run = item['run'];
  const runId = isRecord(run) ? nonEmptyText(run['run_id']) : null;
  return `${pythonStrOrNone(item['id'])} (${runId ?? `signer ${pythonStrOrNone(item['state'])}`})`;
}

/** The legacy-addressing fragment: `agent_id[:8]` (missing key raises). */
function addressingAgentId(item: CrqRecord): string {
  const addressing = item['addressing'];
  if (!isRecord(addressing) || addressing['agent_id'] === undefined) {
    throw new StatusWriterError(
      isRecord(addressing)
        ? `KeyError: 'agent_id'`
        : `'${pythonTypeName(addressing)}' object is not subscriptable`,
      isRecord(addressing) ? 'KeyError' : 'TypeError',
    );
  }
  const agentId = pythonStrOrNone(addressing['agent_id']);
  return agentId.length > 8 ? agentId.slice(0, 8) : agentId;
}

/** The status.json item projection: row fields plus the raw queue item. */
export interface StatusRowWithRaw {
  readonly row: StatusRow;
  readonly raw: CrqRecord;
}

/**
 * The status.json projection: exactly the historical keys in the historical
 * order (the phase 0.2 `status.schema.json` shape), with `generated_at`
 * first as Python's literal orders them. `paused` passes through as the
 * queue's exact value (the schema allows `boolean | null`, and Python's
 * `q.get("paused")` publishes a missing key as null); `cooldown_until`
 * likewise passes through (null when absent).
 */
export function statusJsonDocument(
  documents: CrqDocuments,
  generatedAt: string,
  triage: Record<string, unknown>,
  rows: readonly { readonly row: StatusRow; readonly raw: CrqRecord }[],
): Record<string, unknown> {
  const queue = documents.queue;
  return {
    generated_at: generatedAt,
    paused: queue['paused'] === undefined ? null : queue['paused'],
    cooldown_until: queue['cooldown_until'] === undefined ? null : queue['cooldown_until'],
    finding_triage: triage,
    items: rows.map(({ row, raw }) => ({
      id: row.id,
      // Python copies `i.get("kind")` unchanged: the raw kind, never the
      // decorated Markdown column (`"open t1"`, `"delta new"`).
      kind: raw['kind'] === undefined ? null : raw['kind'],
      state: row.state,
      repo: row.repo,
      prior_cycles: memberOr(raw, 'prior_cycles'),
      cycles: memberOr(raw, 'cycles'),
      operator_priority: memberOr(raw, 'operator_priority'),
      optional_cycle: memberOr(raw, 'optional_cycle'),
      pinned_base: memberOr(raw, 'pinned_base'),
      last_error: memberOr(raw, 'last_error'),
      wait_reason: memberOr(raw, 'wait_reason'),
      gate_stalled_at: memberOr(raw, 'gate_stalled_at'),
    })),
  };
}

function memberOr(item: CrqRecord, key: string): unknown {
  const value = item[key];
  return value === undefined ? null : value;
}

/** The markdown inputs, already computed by {@link writeStatus}. */
export interface StatusMarkdownParts {
  readonly generatedAt: string;
  readonly paused: unknown;
  readonly pauseReason: unknown;
  readonly scheduleId: unknown;
  /** The resolved `next_run` fragment, possibly the bounded failure text. */
  readonly nextRun: string;
  readonly cooldownUntil: unknown;
  readonly usage: unknown;
  readonly starts60m: number;
  readonly inflight: readonly string[];
  readonly legacyAddressing: readonly string[];
  readonly owedOpen: number;
  readonly mergedCurrent: MergedCurrentView;
  readonly lastTick: unknown;
  readonly repoLines: readonly string[];
  readonly rows: readonly StatusRow[];
  readonly recentEvents: readonly string[];
  readonly triage: Record<string, unknown>;
  readonly repairUtilization: unknown;
}

/** The full markdown document (the `md` list Python joins with newlines). */
export function assembleStatusMarkdown(parts: StatusMarkdownParts): string {
  const banner: string[] = [];
  const paused = parts.paused === true;
  const inflightText = parts.inflight.length > 0 ? parts.inflight.join(', ') : 'none';
  const addressingText =
    parts.legacyAddressing.length > 0 ? parts.legacyAddressing.join(', ') : 'none';
  const lines: string[] = [
    `# CodeRabbit review queue — status (${parts.generatedAt})`,
    '',
    ...banner,
    ...(banner.length > 0 ? [''] : []),
    `- queue: ${paused ? `**PAUSED** — ${pythonStrOrNone(parts.pauseReason)}` : 'active'}`,
    `- schedule: \`${pythonStrOrNone(parts.scheduleId)}\` ${parts.nextRun}`,
    `- rate-limit cooldown until: ${pythonStrOrDash(parts.cooldownUntil)}`,
    `- included review usage: ${defaultJsonText(jsonScalar(parts.usage))}; ` +
      `local starts in last 60m: ${pythonStrOrNone(parts.starts60m)}; in flight: ${inflightText}`,
    `- legacy addressing: ${addressingText}`,
    `- open-PR CLI reviews still owed: ${pythonStrOrNone(parts.owedOpen)}`,
    '- merged-current discovery/receipt proof (retained capture T): ' +
      `${sortedJsonText(mergedCurrentJsonValue(parts.mergedCurrent))}`,
    `- last tick: ${pythonStrOrNone(parts.lastTick)}`,
    '',
    ...parts.repoLines,
    ...(parts.repoLines.length > 0 ? [''] : []),
    '| item | repo | kind | state | cycles | pinned base | last outcome | wait / last error | supersession |',
    '|---|---|---|---|---|---|---|---|---|',
    ...parts.rows.map((row) => row.markdown),
    '',
    '## Recent events',
    '',
    '```',
    ...parts.recentEvents,
    '```',
    '',
    '## Backfill finding triage',
    '',
    '```json',
    sortedJsonText(jsonScalar(parts.triage)),
    '```',
    '',
    '## Repair and utilization',
    '',
    '```json',
    indentedJsonText(jsonScalar(parts.repairUtilization)),
    '```',
    '',
  ];
  return lines.join('\n');
}

function defaultJsonText(value: JsonValue): string {
  return pythonJsonText(value, DEFAULT_JSON);
}

function sortedJsonText(value: JsonValue): string {
  return pythonJsonText(value, SORTED_JSON);
}

function indentedJsonText(value: JsonValue): string {
  return pythonJsonText(value, INDENTED_JSON);
}

/** Python f-string interpolation: `str(value)` (None renders as 'None'). */
function pythonStrOrNone(value: unknown): string {
  if (value === undefined) value = null;
  if (value === null) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (value instanceof JsonNumber) return pythonJsonText(value, DEFAULT_JSON);
  if (typeof value === 'number') {
    if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
      return String(value);
    }
    if (!Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf';
    return pythonJsonText(value, DEFAULT_JSON);
  }
  throw new StatusWriterError(
    `status.md interpolation accepts scalars, not ${pythonTypeName(value)}`,
    'TypeError',
  );
}

/** Python `str(x) or '—'`: the em-dash fallback on any falsy value. */
function pythonStrOrDash(value: unknown): string {
  const falsy =
    value === undefined ||
    value === null ||
    value === false ||
    value === 0 ||
    value === '' ||
    (value instanceof JsonNumber && value.integer === 0n) ||
    (value instanceof JsonNumber && value.kind === 'float' && value.float === 0);
  return falsy ? '—' : pythonStrOrNone(value);
}

/** The sorted JSON block over the receipt-aware merged-current view. */
function mergedCurrentJsonValue(view: MergedCurrentView): JsonValue {
  return jsonScalar({
    natural_discovery: view.natural_discovery,
    discovery: view.discovery,
    watermark: view.watermark,
    receipts: view.receipts,
    path_exclusions: view.path_exclusions,
    captured_targets: view.captured_targets,
    additional_captured_targets: view.additional_captured_targets,
    coverage_at_today_target: view.coverage_at_today_target,
    legacy_done_is_review_proof: view.legacy_done_is_review_proof,
  });
}

/** The realtime/monotonic pair captured with the systemd probe output. */
export type { SystemdClock };

/** The schedule probe seam: the parsed document or the bounded failure text. */
export interface ScheduleProbeOutcome {
  /** The parsed inspect document, or null when the probe failed. */
  readonly schedule: Record<string, unknown> | null;
  /** The bounded failure text, or null on success. */
  readonly failure: string | null;
}

/**
 * `paseo_json(["schedule", "inspect", sched])`: the probe raises on non-zero
 * exit or parse failure, which the caller bounds to 200 characters; a
 * missing/empty schedule_id never probes at all. The adapter resolves the
 * exact stdout and failure text; this helper classifies the outcome.
 */
export async function probeSchedule(
  effects: StatusWriterEffects,
  scheduleId: unknown,
): Promise<ScheduleProbeOutcome> {
  if (scheduleId === undefined || scheduleId === null || scheduleId === '') {
    return { schedule: null, failure: null };
  }
  if (typeof scheduleId !== 'string') {
    throw new StatusWriterError('schedule_id must be a string', 'TypeError');
  }
  const probe = await effects.probeSchedule(scheduleId);
  if (probe.failure !== null) {
    return { schedule: null, failure: probe.failure };
  }
  if (probe.stdout === null) {
    return { schedule: null, failure: '(schedule inspect failed)' };
  }
  try {
    const parsed: unknown = JSON.parse(probe.stdout);
    if (!isRecord(parsed)) throw new SyntaxError('not an object');
    return { schedule: parsed, failure: null };
  } catch {
    return { schedule: null, failure: '(schedule inspect failed)' };
  }
}

/** The schedule `next_run` fragment (empty default, bounded failure text). */
export function scheduleNextRun(probe: ScheduleProbeOutcome): string {
  if (probe.schedule === null) {
    return probe.failure === null ? '' : probe.failure.slice(0, 200);
  }
  const status = probe.schedule['status'];
  return (
    `${pythonStrOrNone(status)} · next run ${pythonStrOrNone(probe.schedule['nextRunAt'])} · ` +
    `last run ${pythonStrOrNone(probe.schedule['lastRunAt'])}`
  );
}

/** `iso()`: the exact `%Y-%m-%dT%H:%M:%SZ` stamp for one epoch reading. */
export function isoSeconds(nowSeconds: number): string {
  if (!Number.isFinite(nowSeconds)) {
    throw new StatusWriterError('invalid clock reading', 'OverflowError');
  }
  // Python's strftime truncates sub-second digits, so floor toward -inf
  // (a negative fractional second must not round up across a second).
  const micros = BigInt(Math.floor(nowSeconds)) * 1_000_000n;
  const stamp = formatUtcMicros(micros).replace(/\.\d{6}Z$/, 'Z');
  if (!ISO_SHAPE.test(stamp)) {
    throw new StatusWriterError('clock reading out of range', 'OverflowError');
  }
  return stamp;
}

/** Validate the queue text through the phase 0.2 queue schema. */
export function validateQueue(text: string): CrqRecord {
  const accepted = parseCrqState('queue.schema.json', text);
  if (!accepted.ok) {
    throw new StatusWriterError(
      `queue.json rejected by policy/crq/queue.schema.json: ${
        accepted.issues.join('; ') || 'no detail'
      }`,
      'ValueError',
    );
  }
  if (!isRecord(accepted.value)) {
    throw new StatusWriterError('queue.json is not an object', 'TypeError');
  }
  return accepted.value;
}

/**
 * The config object: `parseJsonValue` with duplicate-key-last semantics (the
 * producer's `json.loads`), then the plain-object gate. No schema exists for
 * config.json, so none is invented here.
 */
export function parseConfig(text: string): CrqRecord {
  let parsed: unknown;
  try {
    parsed = parseJsonValue(text, { duplicates: 'last' });
  } catch (error) {
    throw new StatusWriterError(messageOf(error), 'ValueError');
  }
  if (!(parsed instanceof JsonObject)) {
    throw new StatusWriterError('config.json is not an object', 'TypeError');
  }
  return toPlainRecord(parsed);
}

/** Materialise a lossless object into the plain record the route reads. */
function toPlainRecord(value: JsonObject): CrqRecord {
  const plain: Record<string, unknown> = {};
  for (const [key, entry] of value.entries) {
    plain[key] = plainJsonValue(entry);
  }
  return plain;
}

function plainJsonValue(value: JsonValue): unknown {
  if (value instanceof JsonObject) return toPlainRecord(value);
  if (Array.isArray(value)) return value.map(plainJsonValue);
  if (value instanceof JsonNumber) {
    // A safe integer parses to Python's int and JS's number identically
    // (both exact through 2^53-1), so it materialises as a plain number the
    // route's arithmetic accepts; only values beyond Number.MAX_SAFE_INTEGER
    // stay bigint, which no producer field reaches (the lossless
    // JsonNumber remains available wherever exactness matters).
    if (value.integer !== null) {
      const exact = value.integer as bigint;
      return exact >= BigInt(Number.MIN_SAFE_INTEGER) && exact <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(exact)
        : exact;
    }
    return value.float;
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The route's primary entry: `crq.write_status`. */
export async function writeStatus(effects: StatusWriterEffects): Promise<StatusWriteResult> {
  const queueText = await effects.readQueue();
  const configText = await effects.readConfig();
  const documents: CrqDocuments = {
    queue: validateQueue(queueText),
    config: parseConfig(configText),
  };
  return writeStatusForDocuments(effects, documents);
}

/** The route over already-validated documents (tests and adapter reuse). */
export async function writeStatusForDocuments(
  effects: StatusWriterEffects,
  documents: CrqDocuments,
): Promise<StatusWriteResult> {
  const { queue, config } = documents;
  const now = effects.now();
  const generatedAt = isoSeconds(now);
  const primary = requirePrimary(config);
  const repos = configuredRepos(config);
  const agingMinutes = localReviewAgingMinutes(config);
  const rankOf = (item: CrqRecord): number => crqRank(item, primary, repos, agingMinutes, now);
  const sorted = [...liveItems(queue)].sort((left, right) => {
    const leftPriority = left['operator_priority'] === true;
    const rightPriority = right['operator_priority'] === true;
    if (leftPriority !== rightPriority) return leftPriority ? -1 : 1;
    const leftRank = rankOf(left);
    const rightRank = rankOf(right);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return integerOf(left['order'], 999) - integerOf(right['order'], 999);
  });
  const owedOpen = sorted
    .filter((item) => item['kind'] === 'open' && item['state'] !== 'skipped')
    .reduce((sum, item) => sum + Math.max(0, 1 - completedOpenCycles(item)), 0);
  const rowsWithRaw: StatusRowWithRaw[] = sorted.map((item) => ({
    row: statusRow(item, primary),
    raw: item,
  }));
  const repoLines = repoLinesFor(queue, sorted, config, primary);

  const scheduleId = config['schedule_id'];
  const probe = await probeSchedule(effects, scheduleId);

  const recent = recentEventLines(await readEventsOrEmpty(effects));
  const triage = findingTriage(effects.composerSeams.triageRows);
  const mergedCurrentView = await mergedCurrentWithReceipts(queue, effects);
  const repair = repairDigest(queue, effects.composerSeams.inbox, now);
  const utilization = utilizationAtConfigCap(queue, config, now);
  const repairUtilization = { repair, utilization };

  const markdown = assembleStatusMarkdown({
    generatedAt,
    paused: queue['paused'],
    pauseReason: queue['pause_reason'],
    scheduleId,
    nextRun: scheduleNextRun(probe),
    cooldownUntil: queue['cooldown_until'],
    usage: queue['usage'] === undefined ? null : queue['usage'],
    starts60m: startsLastHour(queue, now),
    inflight: inflight(queue).map(inflightLabel),
    legacyAddressing: sorted
      .filter((item) => item['state'] === 'addressing')
      .map((item) => `${pythonStrOrNone(item['id'])} agent ${addressingAgentId(item)}`),
    owedOpen,
    mergedCurrent: mergedCurrentView,
    lastTick: queue['last_tick'],
    repoLines,
    rows: rowsWithRaw.map(({ row }) => row),
    recentEvents: recent,
    triage,
    repairUtilization,
  });

  const status = statusJsonDocument(documents, generatedAt, triage, rowsWithRaw);
  const statusText = indentedJsonText(jsonScalar(status));
  const statusAccepted = parseCrqState('status.schema.json', statusText);
  if (!statusAccepted.ok) {
    throw new StatusWriterError(
      `status.json rejected by policy/crq/status.schema.json: ${
        statusAccepted.issues.join('; ') || 'no detail'
      }`,
      'ValueError',
    );
  }
  await effects.writeStatusMarkdown(markdown);
  await effects.writeStatusJson(new TextEncoder().encode(statusText));

  let summary: Record<string, unknown> | null = null;
  let publishFailure: PublishFailureEvent | undefined;
  try {
    // Python passes the probe dict it built for the banner: on success the
    // parsed inspect document, on failure `None` (then `schedule.get("status")`
    // reads falsy and the composer keeps its systemd default + error arm).
    summary = await effects.publishSummary({
      ...documents,
      scheduleProbe: probe,
    });
  } catch (error) {
    publishFailure = { event: 'summary_failed', error: publishErrorName(error) };
    await effects.appendEvent(publishFailure);
  }
  return {
    markdown,
    status,
    summary,
    ...(publishFailure === undefined ? {} : { publishFailure }),
  };
}

/**
 * The `EVENTS.exists() ? read_text() : []` arm: only a missing file is the
 * empty default; every other read failure stays a refusal.
 */
async function readEventsOrEmpty(effects: StatusWriterEffects): Promise<string> {
  try {
    return await effects.readEvents();
  } catch (error) {
    // Python: `EVENTS.read_text()... if EVENTS.exists() else []`. Only a
    // missing file is the empty default; ENOTDIR (a non-directory `state`
    // parent), EACCES and decode failures stay refusals.
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') return '';
    throw error;
  }
}

/** The wrapper's first Python refusal class; anything else is a route bug. */
function publishErrorName(error: unknown): string {
  if (error instanceof PublishEffectsError) return error.pythonError;
  const typed = error as { pythonError?: unknown };
  if (
    error instanceof Error &&
    typeof typed.pythonError === 'string' &&
    typed.pythonError.length > 0
  ) {
    return typed.pythonError;
  }
  // Python's bare `except Exception` records the class name of anything the
  // composer raises; mirror that with the error's own name instead of
  // failing the command.
  return error instanceof Error ? error.name : 'Exception';
}

function requirePrimary(config: CrqRecord): string {
  const repo = config['repo'];
  if (typeof repo !== 'string' || repo === '') {
    throw new StatusWriterError('config.repo must be a nonempty string', 'ValueError');
  }
  return repo;
}

function configuredRepos(config: CrqRecord): CrqRecord[] {
  const entries = config['repos'];
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) {
    throw new StatusWriterError('repos must be a list of per-repo objects', 'ValueError');
  }
  return entries.map((entry) => {
    if (!isRecord(entry)) {
      throw new StatusWriterError('repos entry must be an object', 'TypeError');
    }
    return entry;
  });
}

function repoLinesFor(
  queue: CrqRecord,
  sorted: readonly CrqRecord[],
  config: CrqRecord,
  primary: string,
): string[] {
  const slugs: string[] = [];
  for (const entry of configuredRepos(config)) {
    const slug = entry['repo'];
    if (
      typeof slug === 'string' &&
      repoIdentity(slug) !== repoIdentity(primary) &&
      !slugs.some((known) => repoIdentity(known) === repoIdentity(slug))
    ) {
      slugs.push(slug);
    }
  }
  const push = isRecord(queue['push_discovery']) ? queue['push_discovery'] : {};
  for (const key of Object.keys(push)) {
    if (
      repoIdentity(key) !== repoIdentity(primary) &&
      !slugs.some((known) => repoIdentity(known) === repoIdentity(key))
    ) {
      slugs.push(key);
    }
  }
  return slugs
    .map((slug) => repoStatusLine(queue, sorted, slug, primary))
    .filter((line): line is string => line !== null);
}

/**
 * The last 15 events.jsonl lines, complete lines only, in file order.
 * Python's `EVENTS.read_text().splitlines()[-15:]` with universal newlines.
 */
export function recentEventLines(eventsText: string): string[] {
  const normalized = eventsText.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-15);
}

/**
 * The receipt-aware `merged_current` the banner embeds: the pure projection
 * over the lossless queue with the injected receipt reader, exactly
 * `status_summary.merged_current(q, STATE / "receipts")`.
 */
async function mergedCurrentWithReceipts(
  queue: CrqRecord,
  effects: StatusWriterEffects,
): Promise<MergedCurrentView> {
  // mergedCurrent is synchronous, so referenced receipt bytes are preloaded
  // first; a read failure becomes null, which the projection treats as
  // `unverified` (the producer's OSError catch).
  const receipts = await preloadReceipts(queue, effects);
  return mergedCurrent(queue, (receiptId) => receipts.get(receiptId) ?? null);
}

async function preloadReceipts(
  queue: CrqRecord,
  effects: StatusWriterEffects,
): Promise<Map<string, Uint8Array | null>> {
  const ids = referencedReceiptIdsOf(queue);
  const map = new Map<string, Uint8Array | null>();
  await Promise.all(
    [...ids].map(async (id) => {
      try {
        map.set(id, await effects.readReceipt(id));
      } catch {
        map.set(id, null);
      }
    }),
  );
  return map;
}

/** The terminal merged-current receipt ids the projection would open. */
function referencedReceiptIdsOf(queue: CrqRecord): Set<string> {
  const ids = new Set<string>();
  for (const item of liveItems(queue)) {
    if (item['kind'] !== MERGED_CURRENT_KIND) continue;
    const state = item['state'];
    if (state === 'pending' || state === 'reviewing' || state === 'blocked') continue;
    const receiptId = item['receipt_id'];
    if (typeof receiptId === 'string' && /^[0-9a-f]{64}$/.test(receiptId)) ids.add(receiptId);
  }
  return ids;
}

/**
 * `coverage.utilization_digest(q, coverage or new_ledger, now=..., cap)` at
 * the CONFIG cap, exactly the `## Repair and utilization` block's argument.
 * A missing `max_starts_per_hour` is Python's KeyError out of the digest.
 */
function utilizationAtConfigCap(queue: CrqRecord, config: CrqRecord, now: number): unknown {
  const ledger = queue['coverage'];
  const effective =
    ledger === undefined || ledger === null || ledger === false ? NEW_LEDGER : ledger;
  const cap = config['max_starts_per_hour'];
  if (cap === undefined) {
    throw new StatusWriterError("KeyError: 'max_starts_per_hour'", 'KeyError');
  }
  return utilizationDigest(queue, effective, { now, maxStartsPerHour: cap });
}

const NEW_LEDGER: Record<string, unknown> = {
  schema_version: 1,
  paths: {},
  runs: {},
  observations: {},
};
