/**
 * Read-only crq status projection (`status_summary.summarize`, `merged_current`,
 * `repos_summary`) for the TypeScript port (migration lane A1).
 *
 * The Python producer is the oracle: this module renders the same bounded,
 * allow-listed view of queue state and must never launch a review, fetch from a
 * forge, read the environment or spawn a process. Filesystem effects
 * (`publish`, systemd probes, `finding_triage`) stay in the adapter layer and a
 * later A1 slice; receipt bytes and commit subjects arrive as injected
 * callbacks so the projection itself stays deterministic.
 *
 * One deliberate extension is additive only (#1420): `pending_items[]` may
 * carry `repair_origin` and a bounded one-line `label`. The summary schema
 * stays 2 and readers ignore unknown keys; Python is NOT patched.
 */
import {
  JsonNumber,
  JsonObject,
  comparePythonNumbers,
  parseJsonValue,
  toPlainJsonRetainingNumbers,
} from './jsonValue.js';
import { compareCodePoints, sha256Hex } from './pythonJson.js';
import {
  MERGED_CURRENT_KIND,
  currentEquivalence,
  isRecord,
  pythonEqual,
  reusableCurrent,
  type CrqRecord,
} from './receiptIdentity.js';
import { parseUtc } from './utc.js';

/** `status_summary.LABEL`-style bound: maximum label length in UTF-16 units. */
export const LABEL_MAX_UNITS = 120;

/** Receipt bytes by id; `null` when the bytes are unavailable. */
export type ReceiptReader = (receiptId: string) => Uint8Array | null;

/** Commit subjects by sha for PR-less items; supplied by a later adapter. */
export type CommitSubjects = ReadonlyMap<string, string>;

/** Python-compatible exception classes surfaced by this projection. */
export class StatusSummaryError extends Error {
  override readonly name: string = 'StatusSummaryError';
  readonly pythonError: 'ValueError' | 'TypeError' | 'KeyError';

  constructor(
    message: string,
    pythonError: 'ValueError' | 'TypeError' | 'KeyError' = 'ValueError',
  ) {
    super(message);
    this.pythonError = pythonError;
  }
}

export interface MergedCurrentView {
  readonly natural_discovery: Readonly<Record<string, unknown>>;
  readonly discovery: Readonly<Record<string, unknown>>;
  readonly watermark: unknown;
  readonly receipts: Readonly<Record<ReceiptState, number>>;
  readonly path_exclusions: Readonly<Record<string, number>>;
  readonly captured_targets: readonly string[];
  readonly additional_captured_targets: number;
  readonly coverage_at_today_target: 'unverified';
  readonly legacy_done_is_review_proof: false;
}

type ReceiptState =
  | 'pending'
  | 'reviewing'
  | 'blocked'
  | 'unverified'
  | 'proven_terminal'
  | 'no_current_code'
  | 'partial_scope'
  | 'unsupported';

/** Build-time shape for {@link reposSummary}; unknown states are counted in `other`. */
interface MutableRepoSummary {
  pending: number;
  reviewing: number;
  blocked: number;
  other: number;
  reviewed_tip?: unknown;
  [state: string]: unknown;
}

export interface RepoSummaryView {
  readonly pending: number;
  readonly reviewing: number;
  readonly blocked: number;
  readonly other: number;
  readonly reviewed_tip?: unknown;
}

export interface PendingItemView {
  readonly repo: unknown;
  readonly pr: unknown;
  readonly title: unknown;
  readonly kind: unknown;
  readonly band: 'interactive' | 'background';
  readonly generation: unknown;
  readonly aging_deadline: number | JsonNumber | null;
  readonly reason: unknown;
  readonly approximate_position: number;
  /** Additive (#1420): the repair run this fix PR was published for. */
  readonly repair_origin?: string;
  /** Additive (#1420): bounded one-line description from queue/repair text. */
  readonly label?: string;
}

/**
 * A summary integer rendered exactly like Python. Values inside JavaScript's
 * safe integer range (`-(2^53-1)` to `2^53-1`) stay numbers; any Python int
 * outside that range keeps the lossless {@link JsonNumber}, including `2^53`
 * which a double happens to hold exactly, so a writer using `pythonJson`
 * emits the exact digits.
 */
export type SummaryInteger = number | JsonNumber;

export interface StatusSummaryView {
  readonly backfill_reserved_slots: 1;
  readonly completed_24h_by_work: Readonly<
    Record<'open' | 'recent_merge' | 'backfill' | 'other', number>
  >;
  readonly pending_items: readonly PendingItemView[];
  readonly merged_current: MergedCurrentView;
  readonly last_tick: unknown;
  readonly status_as_of: unknown;
  readonly paused: boolean;
  readonly cooldown_until: unknown;
  readonly starts_60m: number;
  readonly starts_cap: SummaryInteger;
  readonly in_flight: number;
  readonly outcomes_24h: Readonly<Record<'completed' | 'interrupted' | 'error', number>>;
  readonly other_outcomes_24h: number;
  readonly backlog: Readonly<
    Record<'open' | 'delta' | 'merged' | 'coverage' | 'merged-current' | 'backfill', number>
  >;
  readonly repos: Readonly<Record<string, RepoSummaryView>>;
}

export interface SummarizeOptions {
  /**
   * Commit subjects by sha for PR-less pending items (merged-current, backfill,
   * coverage). #1420 asks for the target commit's subject; deriving it needs
   * git, so the adapter supplies this map and the projection stays pure.
   */
  readonly commitSubjects?: CommitSubjects;
}

const DISCOVERY_FIELDS = [
  'after',
  'before',
  'complete',
  'complete_through',
  'next_cursor',
  'represented',
  'intents',
  'unsupported',
  'duplicates_seen',
  'records_read',
  'inventory_digest',
  'reason',
  'pages_read',
  'transient_failures',
] as const;
const NATURAL_DISCOVERY_FIELDS = ['after', 'before', 'complete', 'error', 'reason'] as const;
const PR_LESS_KINDS = new Set(['merged-current', 'backfill', 'coverage']);
const DAY_SECONDS = 86_400;
const DEFAULT_AGING_MINUTES = 60;
const DEFAULT_RANK = 3;
const DEFAULT_ORDER = 999;

/** `status_summary.timestamp`: epoch seconds, or null for a missing/invalid value. */
export function epochSeconds(value: unknown): number | null {
  const instant = parseUtc(value);
  return instant === null ? null : Number(instant.epochMicros) / 1_000_000;
}

/**
 * `status_summary.summarize`. `now` is epoch seconds, matching the Python
 * signature and the shared vectors.
 */
export function summarize(
  status: CrqRecord,
  queue: CrqRecord,
  heartbeat: CrqRecord,
  config: CrqRecord,
  events: readonly unknown[],
  now: number,
  options: SummarizeOptions = {},
): StatusSummaryView {
  const primary = get(config, 'repo');
  const items = requireArray(get(queue, 'items'), 'queue.items').filter(
    (item) => get(requireRecord(item, 'queue item'), 'kind') !== 'promotion',
  );
  const primaryItems = items.filter((item) =>
    pythonEqual(firstTruthy([get(requireRecord(item, 'queue item'), 'repo'), primary]), primary),
  );

  const backlog = {
    open: backlogCount(primaryItems, 'open'),
    delta: backlogCount(primaryItems, 'delta'),
    merged: backlogCount(primaryItems, 'merged'),
    coverage: backlogCount(primaryItems, 'coverage'),
    'merged-current': backlogCount(primaryItems, MERGED_CURRENT_KIND),
    backfill: backlogCount(primaryItems, 'backfill'),
  };

  const outcomes = { completed: 0, interrupted: 0, error: 0 };
  const completed = { open: 0, recent_merge: 0, backfill: 0, other: 0 };
  const byId = new Map<unknown, CrqRecord>();
  for (const item of items) {
    const record = requireRecord(item, 'queue item');
    const id = get(record, 'id');
    if (pyTruthy(id)) byId.set(id, record);
  }
  const categoryOf = (item: CrqRecord): 'open' | 'recent_merge' | 'backfill' | 'other' =>
    itemCategory(item);

  let other = 0;
  // A run can be harvested more than once (crash recovery re-harvests; a
  // backfill harvest that retains run ownership is retried every slot pass),
  // so count each run id once, by its latest outcome. Events without a run id
  // count individually.
  const finished = new Map<string, CrqRecord>();
  events.forEach((raw, index) => {
    const event = requireRecord(raw, 'event');
    const at = epochSeconds(get(event, 'at'));
    // A completed record with an unparsable `at` must fail visibly instead of
    // silently counting as zero outcomes; a missing or empty `at` stays accepted.
    if (get(event, 'event') === 'review_finished' && pyTruthy(get(event, 'at')) && at === null) {
      throw new StatusSummaryError('invalid review_finished timestamp');
    }
    if (
      get(event, 'event') === 'review_finished' &&
      at !== null &&
      now - DAY_SECONDS <= at &&
      at <= now
    ) {
      const run = get(event, 'run');
      finished.set(pyTruthy(run) ? runKey(run) : `\u0000anonymous:${String(index)}`, event);
    }
  });
  for (const event of finished.values()) {
    const outcome = get(event, 'outcome');
    if (outcome === 'completed' || outcome === 'interrupted' || outcome === 'error') {
      outcomes[outcome] += 1;
      if (outcome === 'completed') {
        const item = byId.get(get(event, 'item'));
        completed[categoryOf(item ?? event)] += 1;
      }
    } else {
      other += 1;
    }
  }

  const lastTick = firstTruthy([get(heartbeat, 'last_tick'), get(queue, 'last_tick')]);
  // Freshness must follow completed ticks, never status-file writes or probes.
  if (lastTick !== null && lastTick !== undefined && epochSeconds(lastTick) === null) {
    throw new StatusSummaryError('invalid last_tick');
  }

  const usage = firstTruthy([get(queue, 'usage'), {}]);
  const limit = pythonIntValue(usageLimit(usage));
  // The configured cap is a conservative scheduler fallback, not an account quota.
  const startsCap =
    limit !== null && positiveInteger(limit)
      ? limit
      : requireNumber(get(config, 'max_starts_per_hour'), 'max_starts_per_hour');

  const ranks = requireArray(get(config, 'repos', []), 'config.repos').map((entry) => {
    const record = requireRecord(entry, 'config.repos entry');
    return {
      ...record,
      rank_tier: requireNumber(get(record, 'rank_tier', DEFAULT_RANK), 'rank_tier'),
    };
  });
  const agingDeadline = (item: CrqRecord): number | null => itemAgingDeadline(item, config);
  const pendingKey = (item: CrqRecord): PendingKey => {
    const category = categoryOf(item);
    let rank =
      category === 'open' ? 0 : category === 'recent_merge' ? 2 : category === 'backfill' ? 3 : 4;
    const kind = get(item, 'kind');
    if (kind === 'coverage' || kind === 'backfill') {
      rank = 4;
    } else if (kind === 'delta' && category === 'open') {
      rank = 1;
    }
    if (kind === 'local-review') {
      const deadline = agingDeadline(item);
      rank =
        (pythonEqual(itemGeneration(item), 1) && get(item, 'repeat_requested') !== true) ||
        (deadline !== null && now >= deadline)
          ? 0
          : 1;
    }
    const repoRank = rankFor(item, primary, ranks);
    // Open PRs/deltas now outrank repository tiers across all repos (#1177).
    if (repoRank !== null && category !== 'open' && kind !== 'local-review') rank = repoRank;
    return {
      priority: pyTruthy(get(item, 'operator_priority', false)),
      rank,
      order: get(item, 'order', DEFAULT_ORDER),
    };
  };
  const pending = items
    .map((item) => requireRecord(item, 'queue item'))
    .filter(
      (item) =>
        get(item, 'state') === 'pending' &&
        !(get(item, 'kind') === 'open' && pyTruthy(get(item, 'cycles'))),
    );
  const sorted = [...pending].sort(comparePendingKeys(pendingKey));
  const repairIndex = repairRecordIndex(items);
  const commitSubjects = options.commitSubjects;
  const pendingItems = sorted.slice(0, 10).map((item, index) => {
    const key = pendingKey(item);
    const repairOrigin = nonEmptyString(get(item, 'repair_origin'));
    const label = labelForItem(item, repairIndex, commitSubjects);
    const deadline = agingDeadline(item);
    return {
      repo: nullish(repoValue(item, primary)),
      pr: nullish(prValue(item)),
      title: nullish(get(item, 'title')),
      kind: nullish(get(item, 'kind')),
      band: key.rank < 2 ? ('interactive' as const) : ('background' as const),
      generation: nullish(get(item, 'generation')),
      // Python's `timestamp()` is a float, so a present deadline keeps the
      // float lexeme through the exact writer (`3600.0`, not `3600`).
      aging_deadline: deadline === null ? null : JsonNumber.float(deadline),
      reason: nullish(firstTruthy([get(item, 'wait_reason'), get(item, 'last_error')])),
      approximate_position: index + 1,
      ...(repairOrigin === null ? {} : { repair_origin: repairOrigin }),
      ...(label === null ? {} : { label }),
    };
  });

  const starts = requireArray(get(queue, 'starts', []), 'queue.starts');
  return {
    backfill_reserved_slots: 1,
    completed_24h_by_work: completed,
    pending_items: pendingItems,
    merged_current: mergedCurrent(queue),
    last_tick: nullish(lastTick),
    status_as_of: require(status, 'generated_at'),
    paused: pyTruthy(get(queue, 'paused')),
    cooldown_until: nullish(get(queue, 'cooldown_until')),
    starts_60m: starts.filter((value) => {
      const at = epochSeconds(value);
      return at !== null && now - 3600 <= at && at <= now;
    }).length,
    starts_cap: startsCap,
    in_flight: items.filter(
      (item) => require(requireRecord(item, 'queue item'), 'state') === 'reviewing',
    ).length,
    outcomes_24h: outcomes,
    other_outcomes_24h: other,
    backlog,
    // Additive multi-repo block: schema stays 2; readers ignore unknown keys.
    repos: reposSummary(queue, primary, requireArray(get(config, 'repos', []), 'config.repos')),
  };
}

/**
 * `status_summary.merged_current`.
 *
 * `readReceipt` supplies the exact retained bytes for a receipt id; omit it and
 * every terminal item is `unverified`, which is what `summarize` does (the
 * publisher re-runs this with the receipt root). The callback must not be a
 * filesystem read in policy code; the adapter binds it.
 */
export function mergedCurrent(queue: CrqRecord, readReceipt?: ReceiptReader): MergedCurrentView {
  const counts: Record<ReceiptState, number> = {
    pending: 0,
    reviewing: 0,
    blocked: 0,
    unverified: 0,
    proven_terminal: 0,
    no_current_code: 0,
    partial_scope: 0,
    unsupported: 0,
  };
  const exclusions: Record<string, number> = {};
  // Python's `targets` is a set: duplicate captures collapse before the bound.
  const targets = new Set<string>();
  const items = requireArray(get(queue, 'items'), 'queue.items').map((item) =>
    requireRecord(item, 'queue item'),
  );
  for (const item of items) {
    if (require(item, 'kind') !== MERGED_CURRENT_KIND) continue;
    const state = require(item, 'state');
    if (state === 'pending' || state === 'reviewing' || state === 'blocked') {
      counts[state] += 1;
      continue;
    }
    try {
      const receiptId = require(item, 'receipt_id');
      if (typeof receiptId !== 'string' || !/^[0-9a-f]{64}$/.test(receiptId)) {
        throw new StatusSummaryError('invalid receipt id');
      }
      if (readReceipt === undefined) throw new StatusSummaryError('receipt bytes unavailable');
      const bytes = readReceipt(receiptId);
      if (bytes === null) throw new StatusSummaryError('receipt bytes unavailable');
      if (sha256Hex(bytes) !== receiptId) throw new StatusSummaryError('receipt digest mismatch');
      const document = toPlainJsonRetainingNumbers(
        parseJsonValue(new TextDecoder('utf-8', { fatal: true }).decode(bytes), {
          duplicates: 'last',
        }),
      );
      const receipt = requireRecord(document, 'receipt document');
      const capture = require(receipt, 'capture');
      // Follow only retained queue lineage with matching receipt/state;
      // reject dangling/cyclic links and verify the original source binding.
      let origin: CrqRecord = item;
      const visited = new Set<string>();
      let reusedFrom = get(origin, 'reused_from');
      while (pyTruthy(reusedFrom)) {
        // Python uses `parent_id in visited`, so numeric keys compare by
        // value (1 == 1.0 == True) while adjacent big ints stay distinct.
        const lineageKey = dictKey(reusedFrom, 'reused_from');
        if (visited.has(lineageKey)) {
          throw new StatusSummaryError('receipt reuse lineage cycles');
        }
        visited.add(lineageKey);
        const matches = items.filter((candidate) => pythonEqual(get(candidate, 'id'), reusedFrom));
        if (matches.length !== 1) {
          throw new StatusSummaryError('receipt reuse lineage missing or ambiguous');
        }
        const parent = matches[0] as CrqRecord;
        if (
          get(parent, 'kind') !== MERGED_CURRENT_KIND ||
          !pythonEqual(get(parent, 'receipt_id'), receiptId) ||
          !pythonEqual(get(parent, 'state'), state)
        ) {
          throw new StatusSummaryError('receipt reuse lineage mismatch');
        }
        origin = parent;
        reusedFrom = get(origin, 'reused_from');
      }
      if (
        !pythonEqual(get(receipt, 'source'), get(origin, 'subject')) ||
        !pythonEqual(capture, get(origin, 'capture')) ||
        !pythonEqual(
          get(requireRecord(capture, 'capture'), 'equivalence'),
          currentEquivalence(capture),
        ) ||
        currentEquivalence(get(item, 'capture')) !== currentEquivalence(capture)
      ) {
        throw new StatusSummaryError('receipt binding mismatch');
      }
      const outcome = require(receipt, 'outcome');
      let category: ReceiptState;
      if (state === 'done' && reusableCurrent(document, capture)) {
        category = outcome === 'partial-scope' ? 'partial_scope' : 'proven_terminal';
      } else if (
        state === 'no-current-code' &&
        outcome === 'no-current-code' &&
        allPathsTerminal(capture)
      ) {
        category = 'no_current_code';
      } else if (state === 'unsupported' && outcome === 'unsupported') {
        category = 'unsupported';
      } else {
        throw new StatusSummaryError('terminal state lacks proof');
      }
      counts[category] += 1;
      targets.add(requireString(require(requireRecord(capture, 'capture'), 'target'), 'target'));
      for (const path of requireArray(get(requireRecord(capture, 'capture'), 'paths'), 'paths')) {
        const row = requireRecord(path, 'capture path');
        const disposition = Object.prototype.hasOwnProperty.call(row, 'disposition')
          ? row.disposition
          : 'unknown';
        if (typeof disposition !== 'string') {
          throw new StatusSummaryError('unhashable path disposition');
        }
        if (disposition !== 'included' && disposition !== 'renamed') {
          exclusions[disposition] = (exclusions[disposition] ?? 0) + 1;
        }
      }
    } catch {
      counts.unverified += 1;
    }
  }
  const discovery = firstTruthy([get(queue, 'merged_reconcile'), {}]);
  const natural = firstTruthy([get(queue, 'merged_discovery'), {}]);
  const discoveryView: Record<string, unknown> = {};
  if (isRecord(discovery)) {
    for (const field of DISCOVERY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(discovery, field))
        discoveryView[field] = discovery[field];
    }
  }
  const naturalView: Record<string, unknown> = {};
  if (isRecord(natural)) {
    for (const field of NATURAL_DISCOVERY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(natural, field)) naturalView[field] = natural[field];
    }
  }
  const sortedTargets = [...targets].sort(compareCodePoints);
  return {
    natural_discovery: naturalView,
    discovery: discoveryView,
    watermark: nullish(get(queue, 'merged_watermark')),
    receipts: counts,
    path_exclusions: exclusions,
    captured_targets: sortedTargets.slice(0, 32),
    additional_captured_targets: Math.max(0, targets.size - 32),
    coverage_at_today_target: 'unverified',
    legacy_done_is_review_proof: false,
  };
}

/**
 * The receipt ids `merged_current` would open: one per non-pending/reviewing/
 * blocked review-receipt item (Python subscript `item["receipt_id"]` inside
 * its per-row try). Best-effort and never throwing: the digest itself raises
 * the producer's refusal for a defective queue; this selector only tells the
 * filesystem layer which receipt files the producer would touch, so
 * unreferenced receipt files are never opened (audit iO_W).
 */
export function referencedReceiptIds(queue: CrqRecord): ReadonlySet<string> {
  const ids = new Set<string>();
  try {
    const items = requireArray(get(queue, 'items'), 'queue.items');
    for (const item of items) {
      if (!isRecord(item)) continue;
      if (get(item, 'kind') !== MERGED_CURRENT_KIND) continue;
      const state = get(item, 'state');
      if (state === 'pending' || state === 'reviewing' || state === 'blocked') continue;
      const receiptId = get(item, 'receipt_id');
      if (typeof receiptId === 'string' && /^[0-9a-f]{64}$/.test(receiptId)) {
        ids.add(receiptId);
      }
    }
  } catch {
    // mergedCurrent raises the producer's refusal; no selection is safer.
    return new Set<string>();
  }
  return ids;
}

/**
 * `status_summary.repos_summary`: additive per-repo counts for non-primary
 * repos (`docs/multi-repo.md`).
 */
export function reposSummary(
  queue: CrqRecord,
  primary: unknown,
  configured: readonly unknown[] = [],
): Record<string, RepoSummaryView> {
  const out = new Map<string, MutableRepoSummary>();
  const zero = (): MutableRepoSummary => ({
    pending: 0,
    reviewing: 0,
    blocked: 0,
    other: 0,
  });
  const pushDiscovery = firstTruthy([get(queue, 'push_discovery'), {}]);
  const pushSlugs = isRecord(pushDiscovery) ? Object.keys(pushDiscovery) : [];
  // Every configured repo stays visible before its first item or push state:
  // the deploy checklist reads this block to confirm what is enrolled.
  for (const entry of configured) {
    const slug = isRecord(entry) ? get(entry, 'repo') : entry;
    if (typeof slug === 'string' && slug !== primary) {
      if (!out.has(slug)) out.set(slug, zero());
    }
  }
  // Repos with push state but no queued item stay visible (idle is not absent).
  for (const slug of pushSlugs) {
    if (slug !== primary && !out.has(slug)) out.set(slug, zero());
  }
  for (const raw of requireArray(get(queue, 'items'), 'queue.items')) {
    const item = requireRecord(raw, 'queue item');
    const slug = firstTruthy([get(item, 'repo'), primary]);
    if (pythonEqual(slug, primary)) continue;
    if (typeof slug !== 'string') {
      throw new StatusSummaryError('item repo is not a string', 'TypeError');
    }
    const entry = out.get(slug) ?? zero();
    out.set(slug, entry);
    const state = get(item, 'state');
    if (typeof state === 'string' && Object.prototype.hasOwnProperty.call(entry, state)) {
      entry[state] = requireNumber(entry[state], state) + 1;
    } else {
      entry.other = requireNumber(entry.other, 'other') + 1;
    }
  }
  if (isRecord(pushDiscovery)) {
    for (const [slug, state] of Object.entries(pushDiscovery)) {
      const entry = out.get(slug);
      if (entry !== undefined) {
        entry.reviewed_tip = nullish(get(requireRecord(state, 'push state'), 'reviewed_tip'));
      }
    }
  }
  return Object.fromEntries(out);
}

/**
 * The additive `label` for a pending item (#1420).
 *
 * Sources are limited to text already in the queue/repair records: the fix
 * PR's first verdict path and reason (or finding title/body), the item title,
 * the latest cycle label, and an adapter-supplied commit subject for PR-less
 * items. No transcript, no forge call. Returns null when nothing is available.
 */
export function labelForItem(
  item: CrqRecord,
  repairRecords: ReadonlyMap<string, CrqRecord>,
  commitSubjects?: CommitSubjects,
): string | null {
  const origin = nonEmptyString(get(item, 'repair_origin'));
  if (origin !== null) {
    const record = repairRecords.get(origin);
    const label = record === undefined ? null : repairLabel(record);
    if (label !== null) return label;
  }
  const kind = get(item, 'kind');
  if (typeof kind === 'string' && PR_LESS_KINDS.has(kind)) {
    const subject = commitSubject(item, commitSubjects);
    if (subject !== null) return boundLabel(oneLine(subject));
  }
  const title = nonEmptyString(get(item, 'title'));
  if (title !== null) return boundLabel(oneLine(title));
  const cycles = get(item, 'cycles');
  if (Array.isArray(cycles) && cycles.length > 0) {
    const last: unknown = cycles[cycles.length - 1];
    if (isRecord(last)) {
      const label = nonEmptyString(get(last, 'label'));
      if (label !== null) return boundLabel(oneLine(label));
    }
  }
  return null;
}

/** One line, bounded to {@link LABEL_MAX_UNITS} UTF-16 units. */
export function boundLabel(text: string): string {
  if (text.length <= LABEL_MAX_UNITS) return text;
  let cut = LABEL_MAX_UNITS - 1;
  // Never split a surrogate pair: a lone surrogate is not valid JSON text.
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut).trimEnd()}…`;
}

function repairLabel(record: CrqRecord): string | null {
  const verdicts = Array.isArray(get(record, 'verdicts')) ? (record.verdicts as unknown[]) : [];
  let finding: CrqRecord | null = null;
  let reason: string | null = null;
  for (const raw of verdicts) {
    if (!isRecord(raw)) continue;
    if (finding === null) {
      const candidate = get(raw, 'finding');
      if (isRecord(candidate)) {
        finding = candidate;
        reason = nonEmptyString(get(raw, 'reason'));
      }
    }
  }
  const path = finding === null ? null : nonEmptyString(get(finding, 'path'));
  const detail =
    reason ??
    (finding === null
      ? null
      : (nonEmptyString(get(finding, 'title')) ?? nonEmptyString(get(finding, 'body'))));
  if (path === null && detail === null) return null;
  let label = path !== null && detail !== null ? `${path}: ${detail}` : (path ?? detail ?? '');
  const extras = verdicts.length - 1;
  if (extras > 0) label += ` (+${String(extras)})`;
  return boundLabel(oneLine(label));
}

function commitSubject(item: CrqRecord, subjects?: CommitSubjects): string | null {
  if (subjects === undefined) return null;
  const subject = get(item, 'subject');
  const capture = get(item, 'capture');
  const candidates = [
    get(item, 'merge_commit'),
    isRecord(subject) ? get(subject, 'merge_sha') : undefined,
    get(item, 'target'),
    isRecord(capture) ? get(capture, 'target') : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const text = subjects.get(candidate);
    if (text !== undefined && text.trim() !== '') return text;
  }
  return null;
}

/** Index of `repair_runs[run]` records for `labelForItem`; first queue item wins. */
export function repairRecordIndex(items: readonly unknown[]): Map<string, CrqRecord> {
  const index = new Map<string, CrqRecord>();
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const runs = get(raw, 'repair_runs');
    if (!isRecord(runs)) continue;
    for (const [run, record] of Object.entries(runs)) {
      if (isRecord(record) && !index.has(run)) index.set(run, record);
    }
  }
  return index;
}

function itemCategory(item: CrqRecord): 'open' | 'recent_merge' | 'backfill' | 'other' {
  const kind = firstTruthy([get(item, 'kind'), get(item, 'work_kind')]);
  if (kind === 'open' || (kind === 'delta' && get(item, 'followup') !== 'merged')) return 'open';
  if (
    kind === 'merged-current' ||
    (kind === 'delta' && get(item, 'followup') === 'merged') ||
    get(item, 'source') === 'followup'
  ) {
    return 'recent_merge';
  }
  return kind === 'merged' || kind === 'coverage' || kind === 'backfill' ? 'backfill' : 'other';
}

function backlogCount(items: readonly unknown[], kind: string): number {
  let count = 0;
  for (const raw of items) {
    const item = requireRecord(raw, 'queue item');
    if (require(item, 'kind') !== kind) continue;
    if (require(item, 'state') !== 'pending') continue;
    if (kind === 'open' && pyTruthy(get(item, 'cycles'))) continue;
    count += 1;
  }
  return count;
}

interface PendingKey {
  readonly priority: boolean;
  readonly rank: number;
  readonly order: unknown;
}

function comparePendingKeys(keyOf: (item: CrqRecord) => PendingKey) {
  return (left: CrqRecord, right: CrqRecord): number => {
    const a = keyOf(left);
    const b = keyOf(right);
    // Python sorts on `not operator_priority`, so priority items come first.
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return comparePythonValues(a.order, b.order);
  };
}

function comparePythonValues(left: unknown, right: unknown): number {
  const numbers = comparePythonNumbers(left, right);
  if (numbers !== null) return numbers;
  if (typeof left === 'string' && typeof right === 'string') return compareCodePoints(left, right);
  throw new StatusSummaryError(
    `'<' not supported between instances of '${typeName(left)}' and '${typeName(right)}'`,
    'TypeError',
  );
}

function itemAgingDeadline(item: CrqRecord, config: CrqRecord): number | null {
  if (get(item, 'kind') !== 'local-review') return null;
  const generation = get(item, 'generation', 1);
  if (
    !(generation instanceof JsonNumber) &&
    typeof generation !== 'number' &&
    typeof generation !== 'boolean'
  ) {
    throw new StatusSummaryError('generation is not a number', 'TypeError');
  }
  const superseding =
    (generation instanceof JsonNumber
      ? generation.kind === 'int'
        ? (generation.integer as bigint) > 1n
        : (generation.float as number) > 1
      : Number(generation) > 1) || get(item, 'repeat_requested') === true;
  if (!superseding) return null;
  const created = get(item, 'created_at');
  if (!pyTruthy(created)) return null;
  const at = epochSeconds(created);
  if (at === null) return null;
  const minutes = requireNumber(
    get(config, 'local_review_aging_minutes', DEFAULT_AGING_MINUTES),
    'local_review_aging_minutes',
  );
  return at + minutes * 60;
}

function itemGeneration(item: CrqRecord): unknown {
  return get(item, 'generation', 1);
}

function rankFor(item: CrqRecord, primary: unknown, ranks: readonly CrqRecord[]): number | null {
  const slug = firstTruthy([get(item, 'repo'), primary]);
  if (repoIdentity(slug) === repoIdentity(primary)) return null;
  const config = ranks.find((entry) => repoIdentity(get(entry, 'repo')) === repoIdentity(slug));
  return config === undefined ? DEFAULT_RANK : requireNumber(get(config, 'rank_tier'), 'rank_tier');
}

function repoIdentity(slug: unknown): string {
  // Repository slugs are ASCII by grammar; `casefold` for them is `toLowerCase`.
  return typeof slug === 'string' ? slug.toLowerCase() : '';
}

function allPathsTerminal(capture: unknown): boolean {
  const paths = requireArray(get(requireRecord(capture, 'capture'), 'paths'), 'paths');
  return paths.every((raw) => {
    const path = requireRecord(raw, 'capture path');
    const disposition = get(path, 'disposition');
    return (
      disposition === 'deleted' ||
      (disposition === 'excluded-with-reason' && get(path, 'reason') === 'empty current file')
    );
  });
}

function repoValue(item: CrqRecord, primary: unknown): unknown {
  const subject = get(item, 'subject');
  return firstTruthy([
    get(item, 'repo'),
    isRecord(subject) ? get(subject, 'repo') : undefined,
    primary,
  ]);
}

function prValue(item: CrqRecord): unknown {
  const subject = get(item, 'subject');
  return firstTruthy([get(item, 'pr'), isRecord(subject) ? get(subject, 'pr') : undefined]);
}

/**
 * Python `a or b` chain: the first truthy value, otherwise the final value.
 * Not `??`, because `""`, `0` and `false` fall through in Python too.
 */
function firstTruthy(values: readonly unknown[]): unknown {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (pyTruthy(value)) return value;
  }
  return values[values.length - 1];
}

function pyTruthy(value: unknown): boolean {
  if (value instanceof JsonNumber) {
    return value.kind === 'int' ? (value.integer as bigint) !== 0n : (value.float as number) !== 0;
  }
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function get(record: CrqRecord, key: string, fallback?: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : fallback;
}

function require(record: CrqRecord, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    throw new StatusSummaryError(`'${key}'`, 'KeyError');
  }
  return record[key];
}

function requireRecord(value: unknown, what: string): CrqRecord {
  if (!isRecord(value)) throw new StatusSummaryError(`${what} is not an object`, 'TypeError');
  return value;
}

function requireArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new StatusSummaryError(`${what} is not a list`, 'TypeError');
  return value;
}

function requireNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new StatusSummaryError(`${what} is not a number`, 'TypeError');
  }
  return value;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string')
    throw new StatusSummaryError(`${what} is not a string`, 'TypeError');
  return value;
}

/**
 * Python's `type(value) is int` for a materialised value, or for a
 * {@link JsonNumber} kept lossless by a caller that parsed queue bytes itself.
 * Bools, floats and numeric strings are refused; `null` means "not a Python
 * int". An integer outside the safe integer range is returned as its lossless
 * {@link JsonNumber}, because JSON writers refuse unsafe plain numbers.
 */
export function pythonIntValue(value: unknown): SummaryInteger | null {
  if (value instanceof JsonNumber) {
    if (value.kind !== 'int' || value.integer === null) return null;
    // JSON writers refuse unsafe plain numbers, so any integer outside the
    // safe range stays lossless even when this particular double is exact.
    return value.integer > MAX_SAFE_INTEGER || value.integer < MIN_SAFE_INTEGER
      ? value
      : Number(value.integer);
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return Number.isSafeInteger(value) ? value : JsonNumber.int(BigInt(value));
  }
  return null;
}

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER);

function positiveInteger(value: SummaryInteger): boolean {
  return value instanceof JsonNumber ? (value.integer as bigint) > 0n : value > 0;
}

/**
 * The `usage.limit` field, accepting either a materialised object or the
 * lossless {@link JsonObject} a caller gets from `parseJsonValue`.
 *
 * `JSON.parse` erases the difference between `3` and `3.0`, and Python's
 * `type(limit) is int` depends on it. Callers that read queue bytes must keep
 * `usage` lossless (and materialise the rest) rather than pass a plain
 * `JSON.parse` result, whose `3.0` is already indistinguishable from `3`.
 */
function usageLimit(usage: unknown): unknown {
  if (usage instanceof JsonObject) return usage.get('limit');
  return isRecord(usage) ? get(usage, 'limit') : undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function nullish(value: unknown): unknown {
  return value === undefined ? null : value;
}

/**
 * Python dict-key identity for `finished[event.get("run")]`.
 *
 * Shared with receipt reuse lineage, where Python's `visited` set uses the
 * same hash/equality rules.
 *
 * Python equates `int`, `float` and `bool` keys numerically (`1 == 1.0 == True`,
 * `2^53 == 9007199254740992.0`) and hashes them alike, while strings never
 * compare equal to numbers. Map every finite integral value to an exact BigInt
 * string first, so an int above 2^53 keeps its exact identity and an equal
 * float collapses onto it; non-integral floats keep their value tag. NaN is
 * outside the JSON parser domain (the parser refuses the literal), so it is a
 * fail-loud malformed key rather than a silent collision. Truthy lists and
 * objects are unhashable in Python and raise instead of becoming a key.
 */
function runKey(value: unknown): string {
  return dictKey(value, 'run id');
}

function dictKey(value: unknown, label: string): string {
  if (value instanceof JsonNumber) {
    if (value.kind === 'int') return integerRunKey(value.integer as bigint);
    const float = value.float as number;
    if (Number.isNaN(float)) {
      throw new StatusSummaryError(`NaN ${label} is outside the JSON parser domain`);
    }
    if (!Number.isFinite(float)) return `float:${float === Infinity ? 'inf' : '-inf'}`;
    if (Number.isInteger(float)) return integerRunKey(BigInt(float));
    return `float:${String(float)}`;
  }
  if (typeof value === 'boolean') return integerRunKey(value ? 1n : 0n);
  if (typeof value === 'bigint') return integerRunKey(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      throw new StatusSummaryError(`NaN ${label} is outside the JSON parser domain`);
    }
    if (!Number.isFinite(value)) return `float:${value === Infinity ? 'inf' : '-inf'}`;
    if (Number.isInteger(value)) return integerRunKey(BigInt(value));
    return `float:${String(value)}`;
  }
  if (typeof value === 'string') return `string:${value}`;
  throw new StatusSummaryError(`unhashable ${label} (${typeName(value)})`, 'TypeError');
}

function integerRunKey(value: bigint): string {
  return `int:${value.toString()}`;
}

function typeName(value: unknown): string {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (value instanceof JsonNumber) return value.kind;
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'string') return 'str';
  return typeof value;
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
