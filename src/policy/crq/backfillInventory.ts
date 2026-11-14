/**
 * Deterministic backfill inventory capture and ranking
 * (`backfill_inventory.capture` / `backfill_inventory.rank`).
 *
 * The Python producer is `apps/crq-python/backfill_inventory.py`. `rank` is the
 * replayable half of the inventory: it consumes only captured JSON (the
 * retained manifest plus its snapshots) and returns the ranked candidate list,
 * the per-path rows and the required-list progress. No clock, Git, queue
 * mutation or provider call can change a replay, so the capture step can be
 * repeated, shadowed or eventually replaced without changing the ranking.
 *
 * Ordering is exact, because the ranked output is admission evidence:
 *
 * - candidates sort by `(tier, retry, kind, row-or-negative-score, subject_id)`
 *   with the last component compared as UTF-8 bytes (identical to code point
 *   order, so `compareCodePoints` is that comparison);
 * - required evidence rows sort by `(tier, path)` and path clusters by
 *   `(-score, path)`;
 * - interval sets use the ledger's strict monotone grammar, so an inverted or
 *   overlapping pair is a refusal, never a silent union.
 *
 * Unknown fields survive: rows are copied entry by entry and no captured
 * snapshot is rewritten here.
 */
import { JsonNumber, JsonObject, toPlainJsonDeep, type JsonValue } from './jsonValue.js';
import {
  compareCodePoints,
  ledgerJsonBytes,
  ledgerJsonDigest,
  pythonFloatRepr,
  pythonJsonText,
  sha256Hex,
} from './pythonJson.js';
import { LEDGER_REPOSITORY, ledgerTimestamp, ledgerValidateSequence } from './ledger.js';
import { ACCOUNTING_BLAME_OPTIONS } from './backfillAccounting.js';
import {
  isJsonRecord,
  pyTruthy,
  recordEntries,
  recordGet,
  recordHas,
  type JsonRecordLike,
} from './queueDoc.js';

/** `backfill_inventory.VERSION`: the manifest version a replay accepts. */
export const BACKFILL_INVENTORY_VERSION = 'cq.backfill-inventory/v1';

/** `backfill_accounting.BLAME_OPTIONS`: the provenance a replay is bound to. */
export const BACKFILL_BLAME_OPTIONS: readonly string[] = ACCOUNTING_BLAME_OPTIONS;

/** The snapshot payload keys `backfill_inventory.capture` records. */
export const BACKFILL_SNAPSHOT_KEYS: readonly string[] = [
  'queue',
  'required',
  'tiers',
  'limits',
  'objects',
  'required_paths',
  'ledger',
  'required_members',
  'evidence_gaps',
  'protected_policy',
];

/** A refusal: the input cannot be replayed, or the manifest is not this policy. */
export class BackfillInventoryError extends Error {
  override readonly name: string = 'BackfillInventoryError';

  constructor(message: string) {
    super(message);
  }
}

function fail(message: string): never {
  throw new BackfillInventoryError(message);
}

function asDoc(value: unknown, what: string): JsonRecordLike {
  if (!isJsonRecord(value)) fail(`${what} must be an object`);
  return value;
}

/** A required entry, mirroring Python's `value[key]` (`KeyError` on absence). */
function need(document: JsonRecordLike, key: string, what: string): unknown {
  if (!recordHas(document, key)) fail(`${what} is missing ${key}`);
  return recordGet(document, key);
}

/** An optional entry: `undefined` for absence, a JSON `null` stays `null`. */
function opt(document: JsonRecordLike | null, key: string): unknown {
  return document === null ? undefined : recordGet(document, key);
}

function optionalDoc(
  document: JsonRecordLike | null,
  key: string,
  what: string,
): JsonRecordLike | null {
  const value = opt(document, key);
  return value === undefined || value === null ? null : asDoc(value, what);
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(`${what} must be a string`);
  return value;
}

/** A timestamp that a cooldown comparison may read. */
function timestamp(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(`${what} must be a timestamp string`);
  return value;
}

/** A Python `int` (`type(value) is int`): never a boolean or a float. */
export function pythonInt(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'object' && value !== null && 'kind' in value) {
    const candidate = value as { kind?: unknown; integer?: bigint | null };
    if (candidate.kind === 'int' && typeof candidate.integer === 'bigint') {
      if (
        candidate.integer > BigInt(Number.MAX_SAFE_INTEGER) ||
        candidate.integer < BigInt(Number.MIN_SAFE_INTEGER)
      ) {
        fail(`${what} is outside the exact integer range`);
      }
      return Number(candidate.integer);
    }
  }
  return fail(`${what} must be an integer`);
}

/** A Python number (int or float) as a JavaScript number. */
export function pythonNumber(value: unknown, what: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && 'kind' in value) {
    const candidate = value as { kind?: unknown; integer?: bigint | null; float?: number };
    if (candidate.kind === 'int') return pythonInt(value, what);
    if (candidate.kind === 'float' && typeof candidate.float === 'number') return candidate.float;
  }
  return fail(`${what} must be a number`);
}

/** `review_ledger.intervals`: strict, monotone, non-overlapping closed pairs. */
export function intervalsOf(rows: unknown, what = 'intervals'): Set<number> {
  if (!Array.isArray(rows)) fail(`${what} must be an array`);
  const result = new Set<number>();
  let last = 0;
  for (const pair of rows) {
    if (!Array.isArray(pair) || pair.length !== 2) fail(`invalid or overlapping ${what}`);
    const start = pythonInt(pair[0], what);
    const end = pythonInt(pair[1], what);
    if (
      start <= last ||
      end < start ||
      end > 1_000_000 ||
      result.size + end - start + 1 > 1_000_000
    ) {
      fail(`invalid or overlapping ${what}`);
    }
    for (let line = start; line <= end; line += 1) result.add(line);
    last = end;
  }
  return result;
}

/** Python's `int` view of one line number: `bool` is an `int` subclass there. */
function lineNumber(value: number | boolean): number {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

/**
 * `backfill_accounting.ranges`: coalesced ascending closed intervals.
 *
 * The oracle folds a *set* of lines, so duplicates collapse by numeric value
 * (`True` and `1` are the same line in Python) while the emitted interval keeps
 * the captured value, exactly as `list` construction does there. That is what
 * makes `[True, False, 2]` one `[false, 2]` interval rather than three rows.
 */
export function rangesOf(lines: Iterable<number | boolean>): Array<Array<number | boolean>> {
  const unique = new Map<number, number | boolean>();
  for (const line of lines) {
    const key = lineNumber(line);
    if (!unique.has(key)) unique.set(key, line);
  }
  const ordered = [...unique.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, value]) => value);
  const result: Array<[number | boolean, number | boolean]> = [];
  for (const line of ordered) {
    const tail = result[result.length - 1];
    if (tail !== undefined && lineNumber(tail[1]) === lineNumber(line) - 1) tail[1] = line;
    else result.push([line, line]);
  }
  return result;
}

function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort(compareCodePoints);
}

/** `backfill_inventory.effective_limits`. */
export interface EffectiveLimits {
  readonly files: number;
  readonly perFile: number;
  readonly total: number;
  readonly diff: number | null;
}

/**
 * Deployed construction limits, bounded by the hard construction caps.
 *
 * `requireVerified` is the enqueue gate: a reviewer limit without an integer
 * `max_diff_bytes` blocks live work, while a replay only needs the arithmetic
 * bounds to reproduce what the capture already decided.
 */
export function effectiveLimits(
  limits: unknown,
  options: { requireVerified: boolean },
): EffectiveLimits {
  const policy = asDoc(limits, 'construction limits');
  const reviewer = asDoc(need(policy, 'reviewer', 'construction limits'), 'reviewer limits');
  // Enqueue never proceeds on limits the reviewer did not verify: an unverified
  // deployment is a go-live refusal, not a smaller construction.
  if (options.requireVerified) {
    if (opt(reviewer, 'verified') !== true || !pyTruthy(opt(reviewer, 'evidence'))) {
      fail('deployed reviewer limits not verified; go-live blocked');
    }
  }
  const reviewerFiles = pyTruthy(opt(reviewer, 'max_files')) ? opt(reviewer, 'max_files') : 8;
  const files = Math.min(
    8,
    pythonNumber(need(policy, 'max_files', 'construction limits'), 'max_files'),
    pythonNumber(reviewerFiles, 'reviewer max_files'),
  );
  const perFile = Math.min(
    256 * 1024,
    pythonNumber(need(policy, 'max_file_bytes', 'construction limits'), 'max_file_bytes'),
  );
  const total = Math.min(
    2 * 1024 * 1024,
    pythonNumber(need(policy, 'max_total_bytes', 'construction limits'), 'max_total_bytes'),
  );
  // A deployment policy read from disk carries this limit as a lossless
  // `JsonNumber`, so it goes through the same Python-int view as every other
  // bound; anything else is not an int (`type(diff) is not int` in the oracle).
  const rawDiff = opt(reviewer, 'max_diff_bytes');
  let diff: number | null = null;
  if (rawDiff !== undefined && rawDiff !== null) {
    try {
      const parsed = pythonInt(rawDiff, 'reviewer max_diff_bytes');
      if (parsed >= 1) diff = parsed;
    } catch {
      diff = null;
    }
  }
  if (files < 1 || perFile < 1 || total < 1 || (options.requireVerified && diff === null)) {
    fail('invalid construction limits');
  }
  return { files, perFile, total, diff };
}

/** One required-list group: the PRs a bounded subject must cover together. */
export interface RequiredGroup {
  readonly prs: readonly number[];
  readonly row: number;
}

/** `backfill_inventory.required_groups`. */
export function requiredGroups(required: unknown): RequiredGroup[] {
  const document = asDoc(required, 'required list');
  const rawRows = need(document, 'rows', 'required list');
  if (!Array.isArray(rawRows)) fail('required rows must be an array');
  const byPr = new Map<number, { readonly index: number; readonly pr: number }>();
  const seenRows = new Set<number>();
  for (const value of rawRows) {
    const row = asDoc(value, 'required row');
    const pr = pythonInt(need(row, 'pr', 'required row'), 'required row pr');
    const index = pythonInt(need(row, 'row', 'required row'), 'required row index');
    if (byPr.has(pr) || seenRows.has(index)) fail('duplicate required-list row');
    byPr.set(pr, { index, pr });
    seenRows.add(index);
  }
  const unions = need(document, 'explicit_unions', 'required list');
  if (!Array.isArray(unions)) fail('explicit unions must be an array');
  const member = new Set<number>();
  const result: RequiredGroup[] = [];
  for (const value of unions) {
    if (!Array.isArray(value) || value.length === 0) fail('invalid explicit PR union');
    const prs = value.map((entry) => pythonInt(entry, 'explicit union PR'));
    if (prs.some((pr) => !byPr.has(pr)) || prs.some((pr) => member.has(pr))) {
      fail('invalid explicit PR union');
    }
    for (const pr of prs) member.add(pr);
    result.push({
      prs: [...prs].sort((left, right) => left - right),
      row: Math.min(...prs.map((pr) => (byPr.get(pr) as { index: number }).index)),
    });
  }
  for (const entry of byPr.values()) {
    if (member.has(entry.pr)) continue;
    result.push({ prs: [entry.pr], row: entry.index });
  }
  return result.sort((left, right) => left.row - right.row);
}

/** A ranked subject the construction step may pin. */
export interface RankedCandidate {
  readonly repo: unknown;
  readonly kind: 'A' | 'B';
  readonly prs: readonly number[];
  readonly paths: readonly string[];
  readonly target: string;
  readonly scope_digest: string;
  readonly construction_policy_digest: string;
  readonly partition: number;
  readonly subject_id: string;
  readonly family: string;
  readonly generation: number;
  readonly retry: boolean;
  readonly row: number | null;
  readonly tier: string;
  readonly score: number;
  readonly scope: ReadonlyArray<{ path: string; blob: string; intervals: number[][] }>;
  readonly job_id: string;
  readonly path_lineages: Record<string, string>;
  readonly path_tiers: Record<string, string>;
  readonly path_scores: Record<string, number>;
}

/** The `backfill_inventory.rank` result. */
export interface BackfillRanked {
  readonly manifest_id: string;
  readonly target: string;
  readonly evaluated_at: string;
  readonly candidates: readonly RankedCandidate[];
  readonly paths: ReadonlyArray<Record<string, unknown>>;
  readonly required: ReadonlyArray<Record<string, unknown>>;
  readonly evidence_gaps: unknown;
}

interface PathState {
  /** The captured row, copied entry by entry (unknown fields preserved). */
  readonly row: Record<string, unknown>;
  readonly uncovered: Set<number>;
  readonly eligible: Set<number>;
  readonly score: number;
}

function ownedKey(target: unknown, name: unknown, blob: unknown): string {
  return `${String(target)}\u0000${String(name)}\u0000${String(blob)}`;
}

/** `backfill_inventory._owned`: line ranges an active or mapped job already holds. */
function ownedLines(queue: JsonRecordLike): Map<string, Set<number>> {
  const owned = new Map<string, Set<number>>();
  const add = (target: unknown, row: JsonRecordLike, what: string): void => {
    const key = ownedKey(target, need(row, 'path', what), need(row, 'blob', what));
    const lines = intervalsOf(need(row, 'intervals', what), 'ownership intervals');
    const existing = owned.get(key);
    if (existing === undefined) owned.set(key, lines);
    else for (const line of lines) existing.add(line);
  };
  const mapped = opt(queue, 'backfill_mapped_ownership');
  if (mapped !== undefined && mapped !== null) {
    if (!Array.isArray(mapped)) fail('backfill_mapped_ownership must be an array');
    for (const value of mapped) {
      const row = asDoc(value, 'mapped ownership row');
      add(opt(row, 'target'), row, 'mapped ownership row');
    }
  }
  const items = opt(queue, 'items');
  if (items !== undefined && items !== null) {
    if (!Array.isArray(items)) fail('queue items must be an array');
    for (const value of items) {
      const job = asDoc(value, 'queue item');
      const state = opt(job, 'state');
      const vendor = opt(job, 'vendor_state');
      const active =
        state === 'pending' ||
        state === 'reviewing' ||
        state === 'launch-unknown' ||
        state === 'publication-pending' ||
        vendor === 'live' ||
        vendor === 'unknown';
      if (!active) continue;
      const scope = opt(job, 'scope');
      if (scope === undefined || scope === null) continue;
      if (!Array.isArray(scope)) fail('queue item scope must be an array');
      for (const row of scope) add(opt(job, 'target'), asDoc(row, 'scope row'), 'scope row');
    }
  }
  return owned;
}

function subtract(from: Set<number>, remove: Set<number>): Set<number> {
  const result = new Set<number>();
  for (const line of from) if (!remove.has(line)) result.add(line);
  return result;
}

/** A captured row as a plain object: every captured field, in capture order. */
function copyRow(value: unknown, what: string): Record<string, unknown> {
  const document = asDoc(value, what);
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of recordEntries(document)) copy[key] = toPlainJsonDeep(entry);
  return copy;
}

/**
 * `backfill_inventory.rank(manifest, inputs)`.
 *
 * `manifest` is a retained capture manifest (its `id` derivation is checked by
 * `replay`, not here) and `inputs` are the verified snapshot payloads keyed as
 * the manifest records them.
 */
export function rank(manifestValue: unknown, inputsValue: unknown): BackfillRanked {
  const manifest = asDoc(manifestValue, 'inventory manifest');
  if (opt(manifest, 'version') !== BACKFILL_INVENTORY_VERSION) fail('unsupported inventory policy');
  const options = opt(manifest, 'blame_options');
  if (
    !Array.isArray(options) ||
    options.length !== BACKFILL_BLAME_OPTIONS.length ||
    options.some((value, index) => value !== BACKFILL_BLAME_OPTIONS[index])
  ) {
    fail('unsupported inventory policy');
  }
  const inputs = asDoc(inputsValue, 'inventory inputs');
  const snapshots = asDoc(need(manifest, 'snapshots', 'inventory manifest'), 'snapshot references');
  for (const [key, value] of recordEntries(inputs)) {
    const reference = asDoc(need(snapshots, key, 'snapshot references'), `snapshot ${key}`);
    if (ledgerJsonDigest(value) !== need(reference, 'sha256', `snapshot ${key}`)) {
      fail('inventory snapshot digest mismatch');
    }
  }
  const limits = effectiveLimits(need(inputs, 'limits', 'inventory inputs'), {
    requireVerified: false,
  });
  const rawObjects = need(inputs, 'objects', 'inventory inputs');
  if (!Array.isArray(rawObjects)) fail('inventory objects must be an array');
  const states = new Map<string, PathState>();
  for (const value of rawObjects) {
    const row = copyRow(value, 'inventory object');
    const name = text(row['path'], 'inventory object path');
    const lines = row['lines'];
    const maximum =
      lines === null || lines === undefined ? 0 : pythonInt(lines, `lines for ${name}`);
    const covered = intervalsOf(row['covered'], `covered intervals for ${name}`);
    const all = new Set<number>();
    for (let line = 1; line <= maximum; line += 1) all.add(line);
    const uncovered = subtract(all, covered);
    const churn = pythonNumber(row['churn'], `churn for ${name}`);
    const findings = pythonNumber(row['findings'], `findings for ${name}`);
    // Python's mapping comprehension keeps the last row for a duplicate path.
    states.set(name, {
      row,
      uncovered,
      eligible: uncovered,
      score: uncovered.size * (1 + churn + findings),
    });
  }
  const queue = asDoc(need(inputs, 'queue', 'inventory inputs'), 'queue snapshot');
  const scopeFailures = optionalDoc(queue, 'backfill_scope_failures', 'backfill_scope_failures');
  const families = optionalDoc(queue, 'backfill_families', 'backfill_families');
  const pathLineages = optionalDoc(queue, 'backfill_path_lineages', 'backfill_path_lineages');
  const jobsValue = opt(queue, 'items');
  const jobs: JsonRecordLike[] = [];
  if (jobsValue !== undefined && jobsValue !== null) {
    if (!Array.isArray(jobsValue)) fail('queue items must be an array');
    for (const value of jobsValue) jobs.push(asDoc(value, 'queue item'));
  }
  const owned = ownedLines(queue);
  const target = text(need(manifest, 'target', 'inventory manifest'), 'manifest target');
  const evaluatedAt = timestamp(
    need(manifest, 'evaluated_at', 'inventory manifest'),
    'evaluated_at',
  );
  const constructionDigest = text(
    need(
      asDoc(need(snapshots, 'limits', 'snapshot references'), 'snapshot limits'),
      'sha256',
      'snapshot limits',
    ),
    'construction policy digest',
  );
  for (const [name, state] of states) {
    const blob = text(state.row['blob'], `blob for ${name}`);
    state.row['uncovered'] = rangesOf(state.uncovered);
    const eligible = subtract(
      state.uncovered,
      owned.get(ownedKey(target, name, blob)) ?? new Set(),
    );
    (state as { eligible: Set<number> }).eligible = eligible;
    state.row['eligible'] = rangesOf(eligible);
    state.row['score'] = state.score;
  }
  const candidates: RankedCandidate[] = [];
  const assigned = new Set<string>();
  const progress: Array<Record<string, unknown>> = [];

  const lineageOf = (name: string): string => {
    const value = opt(pathLineages, name);
    return value === undefined || value === null ? name : text(value, 'path lineage');
  };

  const cooled = (value: unknown, what: string): boolean =>
    pyTruthy(value) && timestamp(value, what) > evaluatedAt;

  const heldByCooldown = (name: string): boolean => {
    const unit = optionalDoc(scopeFailures, lineageOf(name), 'scope failures');
    return (
      pyTruthy(opt(unit, 'quarantined')) ||
      cooled(opt(unit, 'next_eligible_at'), 'next_eligible_at')
    );
  };

  const partitions = (
    kind: 'A' | 'B',
    names: readonly string[],
    prs: readonly number[],
    order: number | null,
  ): void => {
    const sortedPrs = [...prs].sort((left, right) => left - right);
    const source: Record<string, unknown> = { repo: opt(manifest, 'repo'), kind, prs: sortedPrs };
    if (kind === 'B') source['lineage'] = sortedStrings(names);
    const family = ledgerJsonDigest(source);
    const history = optionalDoc(families, family, `family ${family}`);
    if (
      pyTruthy(opt(history, 'quarantined')) ||
      cooled(opt(history, 'next_eligible_at'), 'family next_eligible_at')
    ) {
      return;
    }
    const groups: string[][] = [];
    let current: string[] = [];
    let size = 0;
    for (const name of names) {
      const state = states.get(name) as PathState;
      if (heldByCooldown(name)) continue;
      const disposition = state.row['disposition'];
      if ((disposition !== 'included' && disposition !== 'renamed') || state.eligible.size === 0) {
        continue;
      }
      const bytes = pythonInt(state.row['bytes'], `bytes for ${name}`);
      if (current.length > 0 && (current.length === limits.files || size + bytes > limits.total)) {
        groups.push(current);
        current = [];
        size = 0;
      }
      if (bytes > Math.min(limits.perFile, limits.total)) continue;
      current.push(name);
      size += bytes;
    }
    if (current.length > 0) groups.push(current);
    for (const [partition, nameset] of groups.entries()) {
      const scope = nameset.map((name) => {
        const state = states.get(name) as PathState;
        return {
          path: name,
          blob: text(state.row['blob'], `blob for ${name}`),
          intervals: rangesOf(state.eligible),
        };
      });
      const identity = {
        repo: opt(manifest, 'repo'),
        kind,
        prs: sortedPrs,
        paths: sortedStrings(nameset),
        target,
        scope_digest: ledgerJsonDigest(scope),
        construction_policy_digest: constructionDigest,
        partition,
      };
      const subject = ledgerJsonDigest(identity);
      const previous = jobs.filter((job) => {
        const identityValue = recordHas(job, 'inventory_subject_id')
          ? recordGet(job, 'inventory_subject_id')
          : opt(job, 'subject_id');
        return identityValue === subject;
      });
      const generations = previous.map((job) =>
        pythonInt(
          recordHas(job, 'generation') ? recordGet(job, 'generation') : 0,
          'job generation',
        ),
      );
      const generation = (generations.length === 0 ? -1 : Math.max(...generations)) + 1;
      const retry =
        pyTruthy(opt(history, 'failures')) ||
        previous.length > 0 ||
        nameset.some((name) => {
          const unit = optionalDoc(scopeFailures, lineageOf(name), 'scope failures');
          return pyTruthy(opt(unit, 'failures'));
        });
      const tiers = nameset.map((name) =>
        text((states.get(name) as PathState).row['tier'], `tier for ${name}`),
      );
      const scores = nameset.map((name) => (states.get(name) as PathState).score);
      candidates.push({
        ...identity,
        subject_id: subject,
        family,
        generation,
        retry,
        row: order,
        tier: sortedStrings(tiers)[0] as string,
        score: scores.reduce((total, value) => total + value, 0),
        scope,
        job_id: `${subject}:${generation}`,
        path_lineages: Object.fromEntries(nameset.map((name) => [name, lineageOf(name)])),
        path_tiers: Object.fromEntries(
          nameset.map((name, index) => [name, tiers[index] as string]),
        ),
        path_scores: Object.fromEntries(
          nameset.map((name, index) => [name, scores[index] as number]),
        ),
      } as RankedCandidate);
    }
  };

  const requiredPaths = asDoc(need(inputs, 'required_paths', 'inventory inputs'), 'required paths');
  for (const group of requiredGroups(need(inputs, 'required', 'inventory inputs'))) {
    const evidenceRows: Array<{ readonly row: JsonRecordLike; readonly name: string }> = [];
    for (const pr of group.prs) {
      const rowsForPr = opt(requiredPaths, String(pr));
      if (rowsForPr === undefined || rowsForPr === null) continue;
      if (!Array.isArray(rowsForPr)) fail(`required paths for ${pr} must be an array`);
      for (const value of rowsForPr) {
        const row = asDoc(value, 'required evidence row');
        evidenceRows.push({
          row,
          name: text(need(row, 'path', 'required evidence row'), 'evidence path'),
        });
      }
    }
    const names = [...new Set(evidenceRows.map((entry) => entry.name))]
      .filter((name) => states.has(name))
      .sort((left, right) => {
        const tierOrder = compareCodePoints(
          text((states.get(left) as PathState).row['tier'], `tier for ${left}`),
          text((states.get(right) as PathState).row['tier'], `tier for ${right}`),
        );
        return tierOrder !== 0 ? tierOrder : compareCodePoints(left, right);
      });
    const missing = group.prs.filter((pr) => !recordHas(requiredPaths, String(pr)));
    const outcomes: Array<Record<string, unknown>> = [];
    for (const { row, name } of evidenceRows) {
      if (opt(row, 'disposition') === 'ambiguous') {
        outcomes.push({
          path: name,
          outcome: 'accounted-with-exceptions',
          reason: 'ambiguous source lineage',
          evidence: toPlainJsonDeep(opt(row, 'source_evidence')),
        });
        continue;
      }
      const state = states.get(name);
      if (state !== undefined) {
        const disposition = state.row['disposition'];
        const outcome =
          disposition === 'unsupported' || disposition === 'ambiguous'
            ? 'accounted-with-exceptions'
            : state.uncovered.size > 0
              ? 'still-pending'
              : disposition === 'empty'
                ? 'no-current-code'
                : 'covered';
        outcomes.push({
          path: name,
          outcome,
          evidence: state.row['evidence'],
          reason: state.row['reason'],
        });
      } else if (opt(row, 'disposition') === 'deleted' && pyTruthy(opt(row, 'deletion_evidence'))) {
        outcomes.push({
          path: name,
          outcome: 'no-current-code',
          evidence: toPlainJsonDeep(opt(row, 'deletion_evidence')),
        });
      } else {
        outcomes.push({
          path: name,
          outcome: 'still-pending',
          reason: 'unverified lineage/deletion',
        });
      }
    }
    progress.push({
      prs: [...group.prs],
      row: toPlainJsonDeep(group.row),
      missing_source_evidence: missing,
      paths: outcomes,
    });
    const available = names.filter((name) => !assigned.has(name));
    // Including cooldown/quarantined A scope: B never bypasses a held path.
    for (const name of names) assigned.add(name);
    partitions('A', available, group.prs, group.row);
  }

  const clusters = new Map<
    string,
    { readonly dir: string; readonly tier: string; names: string[] }
  >();
  for (const [name, state] of states) {
    if (assigned.has(name)) continue;
    if (state.eligible.size === 0) continue;
    const tier = text(state.row['tier'], `tier for ${name}`);
    const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
    const key = `${dir}\u0000${tier}`;
    const cluster = clusters.get(key);
    if (cluster === undefined) clusters.set(key, { dir, tier, names: [name] });
    else cluster.names.push(name);
  }
  const orderedClusters = [...clusters.values()].sort((left, right) => {
    const dirOrder = compareCodePoints(left.dir, right.dir);
    return dirOrder !== 0 ? dirOrder : compareCodePoints(left.tier, right.tier);
  });
  for (const cluster of orderedClusters) {
    const names = [...cluster.names].sort((left, right) => {
      const leftScore = (states.get(left) as PathState).score;
      const rightScore = (states.get(right) as PathState).score;
      if (leftScore !== rightScore) return rightScore - leftScore;
      return compareCodePoints(left, right);
    });
    partitions('B', names, [], null);
  }

  candidates.sort((left, right) => {
    let order = compareCodePoints(left.tier, right.tier);
    if (order !== 0) return order;
    if (left.retry !== right.retry) return left.retry ? 1 : -1;
    order = compareCodePoints(left.kind, right.kind);
    if (order !== 0) return order;
    const leftKey = left.kind === 'A' ? (left.row as number) : -left.score;
    const rightKey = right.kind === 'A' ? (right.row as number) : -right.score;
    if (leftKey !== rightKey) return leftKey - rightKey;
    return compareCodePoints(left.subject_id, right.subject_id);
  });

  return {
    manifest_id: text(need(manifest, 'id', 'inventory manifest'), 'manifest id'),
    target,
    evaluated_at: evaluatedAt,
    candidates,
    paths: sortedStrings(states.keys()).map((name) => ({ ...(states.get(name) as PathState).row })),
    required: progress,
    evidence_gaps: toPlainJsonDeep(need(inputs, 'evidence_gaps', 'inventory inputs')),
  };
}

/** The artifact seam `replay` verifies and reads (bound by the adapter). */
export interface InventoryArtifacts {
  verify(reference: unknown): Promise<void>;
  read(reference: unknown): Promise<unknown>;
}

/**
 * `backfill_inventory.replay`: verify the manifest and its retained artifacts,
 * then rank. Artifact I/O is injected so this module owns no filesystem access.
 */
export async function replay(
  manifestValue: unknown,
  artifacts: InventoryArtifacts,
): Promise<BackfillRanked> {
  const manifest = asDoc(manifestValue, 'inventory manifest');
  const withoutId: Record<string, unknown> = {};
  for (const [key, value] of recordEntries(manifest)) if (key !== 'id') withoutId[key] = value;
  if (opt(manifest, 'id') !== ledgerJsonDigest(withoutId)) fail('inventory manifest mismatch');
  if (opt(manifest, 'version') !== BACKFILL_INVENTORY_VERSION) fail('inventory manifest mismatch');
  await artifacts.verify(need(manifest, 'git_bundle', 'inventory manifest'));
  await artifacts.verify(need(manifest, 'raw_queue', 'inventory manifest'));
  const snapshots = asDoc(need(manifest, 'snapshots', 'inventory manifest'), 'snapshot references');
  const inputs: Record<string, unknown> = {};
  for (const key of BACKFILL_SNAPSHOT_KEYS) {
    const reference = need(snapshots, key, 'snapshot references');
    await artifacts.verify(reference);
    inputs[key] = await artifacts.read(reference);
  }
  return rank(manifest, inputs);
}

// ------------------------------------------------------------------ capture

/** One object row `capture` enriches; the adapter's inventory is the same shape. */
export interface BackfillCaptureRow {
  readonly path: string;
  readonly blob: string;
  readonly mode: string;
  readonly kind: string;
  readonly lines: number | null;
  readonly bytes: number | null;
  readonly disposition: string;
  readonly reason: string;
}

/** One durable reference returned by the capture artifact seam. */
export interface BackfillCaptureReference {
  readonly sha256: string;
  readonly location: string;
}

/** The artifact seam `capture` (and its coverage fold) writes through. */
export interface BackfillCaptureArtifacts {
  put(data: Uint8Array): Promise<BackfillCaptureReference>;
  verify(reference: BackfillCaptureReference): Promise<void>;
}

/** `Repository.coverage`'s result, as `capture` records it. */
export interface BackfillCoverageFold {
  readonly covered: ReadonlyMap<string, ReadonlySet<number>>;
  readonly evidence: ReadonlyMap<string, readonly string[]>;
  readonly gaps: readonly unknown[];
}

/**
 * The Git seam `capture` reads. Method names match the Python `Repository`
 * class so the adapter binding is a direct delegation and the policy half
 * stays testable without Git.
 */
export interface BackfillCaptureRepo {
  resolve(target: string): Promise<string>;
  tree(commit: string): Promise<string>;
  gitVersion(): Promise<string>;
  inventory(target: string, maxFileBytes: number): Promise<readonly BackfillCaptureRow[]>;
  coverage(
    target: string,
    reviews: readonly JsonValue[],
    artifacts: BackfillCaptureArtifacts,
  ): Promise<BackfillCoverageFold>;
  churn(target: string, evaluatedAt: string): Promise<ReadonlyMap<string, number>>;
  lineage(old: string, next: string, path: string): Promise<string | null>;
  carry(
    old: string,
    next: string,
    path: string,
    lines: ReadonlySet<number>,
  ): Promise<{ readonly name: string | null; readonly mapped: ReadonlySet<number> }>;
  retain(
    artifacts: BackfillCaptureArtifacts,
    commits: readonly string[],
  ): Promise<BackfillCaptureReference & { readonly kind?: string }>;
}

export interface BackfillCaptureOptions {
  readonly repo: BackfillCaptureRepo;
  readonly target: string;
  readonly ledgerHead: string;
  readonly events: readonly JsonValue[];
  readonly artifacts: BackfillCaptureArtifacts;
  readonly queue: unknown;
  readonly required: unknown;
  readonly tiers: unknown;
  readonly limits: unknown;
  readonly evaluatedAt: string;
  readonly requiredPaths: unknown;
  readonly protectedBytes: Uint8Array;
  readonly members?: unknown;
}

function definePlain(object: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function plainRecordCopy(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (isJsonRecord(value)) {
    for (const [key, entry] of recordEntries(value)) definePlain(result, key, entry);
  }
  return result;
}

/** Python `min`/`max` over strings compare by code point. */
function codePointExtreme(values: readonly string[], maximum: boolean): string {
  return values.reduce((selected, value) => {
    const order = compareCodePoints(selected, value);
    return (maximum ? order <= 0 : order >= 0) ? value : selected;
  });
}

const FNMATCH_STAR: unique symbol = Symbol('fnmatch-star');
type FnmatchPart = string | typeof FNMATCH_STAR;

function escapeRegexCharacter(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

/**
 * `fnmatch._translate` and `_join_translated_parts` (CPython 3.14), emitted as
 * a JavaScript regex. Two JavaScript differences are normalised here: `\z`
 * becomes `(?![\s\S])`, and a leading `]` in a class is escaped because
 * JavaScript, unlike Python's `re`, does not allow it unescaped. Atomic
 * star groups are omitted; they change backtracking cost, not the language.
 */
function translateFnmatch(glob: string): string {
  const characters = Array.from(glob);
  const parts: FnmatchPart[] = [];
  const stars: number[] = [];
  let index = 0;
  while (index < characters.length) {
    const character = characters[index++] as string;
    if (character === '*') {
      stars.push(parts.length);
      parts.push(FNMATCH_STAR);
      while (index < characters.length && characters[index] === '*') index += 1;
      continue;
    }
    if (character === '?') {
      parts.push('.');
      continue;
    }
    if (character !== '[') {
      parts.push(escapeRegexCharacter(character));
      continue;
    }
    let close = index;
    if (characters[close] === '!') close += 1;
    if (characters[close] === ']') close += 1;
    while (close < characters.length && characters[close] !== ']') close += 1;
    if (close >= characters.length) {
      parts.push('\\[');
      continue;
    }
    let stuff = characters.slice(index, close).join('');
    if (!stuff.includes('-')) {
      stuff = stuff.replace(/\\/g, '\\\\');
    } else {
      const chunks: string[] = [];
      let chunkStart = index;
      let search = characters[index] === '!' ? index + 2 : index + 1;
      while (true) {
        let hyphen = -1;
        for (let cursor = search; cursor < close; cursor += 1) {
          if (characters[cursor] === '-') {
            hyphen = cursor;
            break;
          }
        }
        if (hyphen < 0) break;
        chunks.push(characters.slice(chunkStart, hyphen).join(''));
        chunkStart = hyphen + 1;
        search = hyphen + 3;
      }
      const tail = characters.slice(chunkStart, close).join('');
      if (tail !== '') chunks.push(tail);
      else if (chunks.length > 0) chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}-`;
      for (let cursor = chunks.length - 1; cursor > 0; cursor -= 1) {
        const previous = chunks[cursor - 1] as string;
        const current = chunks[cursor] as string;
        if (previous === '' || current === '') continue;
        if ((previous[previous.length - 1] as string) > (current[0] as string)) {
          chunks[cursor - 1] = previous.slice(0, -1) + current.slice(1);
          chunks.splice(cursor, 1);
        }
      }
      stuff = chunks.map((chunk) => chunk.replace(/\\/g, '\\\\').replace(/-/g, '\\-')).join('-');
    }
    index = close + 1;
    if (stuff === '') {
      parts.push('(?!)');
    } else if (stuff === '!') {
      parts.push('.');
    } else if (stuff[0] === '!') {
      stuff = `^${stuff.slice(1)}`;
      if (stuff[1] === ']') stuff = `^\\]${stuff.slice(2)}`;
      parts.push(`[${stuff}]`);
    } else {
      if (stuff[0] === '^' || stuff[0] === '[' || stuff[0] === ']') stuff = `\\${stuff}`;
      parts.push(`[${stuff}]`);
    }
  }
  if (stars.length === 0) return parts.join('');
  const joined: string[] = [];
  let cursor = 1;
  const first = stars[0] as number;
  joined.push(...(parts.slice(0, first) as string[]));
  let position = first + 1;
  while (cursor < stars.length) {
    const next = stars[cursor++] as number;
    joined.push('(?:.*?', ...(parts.slice(position, next) as string[]), ')');
    position = next + 1;
  }
  joined.push('.*', ...(parts.slice(position) as string[]));
  return joined.join('');
}

/** `fnmatch.fnmatchcase`: `*`, `?`, `[seq]` and `[!seq]`, never path-aware. */
export function fnmatchCase(name: string, glob: string): boolean {
  return new RegExp(`^(?:${translateFnmatch(glob)})(?![\\s\\S])`, 'su').test(name);
}

/** `backfill_inventory.tier`: protected pattern first, then T1..T4 globs. */
export function captureTier(name: string, tiers: unknown): 'T1' | 'T2' | 'T3' | 'T4' {
  const policy = asDoc(tiers, 'tier policy');
  const patterns = need(policy, 'protected_patterns', 'tier policy');
  if (!Array.isArray(patterns)) fail('protected patterns must be an array');
  for (const pattern of patterns) {
    if (new RegExp(text(pattern, 'protected pattern'), 'u').test(name)) return 'T1';
  }
  const groups = asDoc(need(policy, 'tiers', 'tier policy'), 'tier policy tiers');
  for (const importance of ['T1', 'T2', 'T3', 'T4'] as const) {
    const globs = need(groups, importance, 'tier policy tiers');
    if (!Array.isArray(globs)) fail(`${importance} patterns must be an array`);
    if (globs.some((glob) => fnmatchCase(name, text(glob, `${importance} glob`)))) {
      return importance;
    }
  }
  return fail('path has no importance tier');
}

const TRIAGE_ACTIONS = new Set([
  'confirmed',
  'fixed',
  'already-fixed',
  'dismissed',
  'needs-human',
  'superseded',
]);

/** `backfill_inventory.confirmed_counts`: confirmed findings per current path. */
export function confirmedCounts(events: readonly JsonValue[]): Map<string, number> {
  const status = new Map<string, string>();
  const paths = new Map<string, string>();
  const canonical = new Map<string, string>();
  for (const value of events) {
    const event = asDoc(value, 'ledger event');
    if (opt(event, 'event_type') === 'review') {
      const payload = asDoc(need(event, 'payload', 'review event'), 'review payload');
      const findings = need(payload, 'findings', 'review payload');
      if (!Array.isArray(findings)) fail('review findings must be an array');
      for (const findingValue of findings) {
        const finding = asDoc(findingValue, 'review finding');
        const id = text(need(finding, 'id', 'review finding'), 'finding id');
        status.set(id, 'untriaged');
        paths.set(id, text(need(finding, 'path', 'review finding'), 'finding path'));
        canonical.set(id, id);
      }
    } else if (opt(event, 'event_type') === 'finding-event') {
      const payload = asDoc(need(event, 'payload', 'finding event'), 'finding payload');
      const id = text(need(payload, 'finding_id', 'finding payload'), 'finding id');
      const action = opt(payload, 'action');
      if (action === 'duplicate') {
        const evidence = asDoc(need(payload, 'evidence', 'finding payload'), 'finding evidence');
        canonical.set(id, text(need(evidence, 'canonical_id', 'finding evidence'), 'canonical id'));
      } else if (typeof action === 'string' && TRIAGE_ACTIONS.has(action)) {
        status.set(id, action);
      }
    }
  }
  const counts = new Map<string, Set<string>>();
  for (const [id, state] of status) {
    if (state !== 'confirmed' && state !== 'fixed' && state !== 'already-fixed') continue;
    const name = paths.get(id);
    if (name === undefined) fail('review finding path is missing');
    let ids = counts.get(name);
    if (ids === undefined) {
      ids = new Set<string>();
      counts.set(name, ids);
    }
    ids.add(canonical.get(id) ?? id);
  }
  const result = new Map<string, number>();
  for (const [name, ids] of counts) result.set(name, ids.size);
  return result;
}

/**
 * `backfill_inventory.queue_snapshot`: tag legacy floating point diagnostics
 * so they never enter the integer-only replay domain. `1.0` stays a float.
 */
export function queueSnapshot(value: unknown): unknown {
  if (value instanceof JsonNumber) {
    if (value.kind === 'int') return value;
    const float = value.float as number;
    return Number.isFinite(float)
      ? { 'cq.legacy-number/v1': pythonFloatRepr(float) }
      : fail('non-finite queue diagnostic');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('non-finite queue diagnostic');
    return Number.isInteger(value) ? value : { 'cq.legacy-number/v1': pythonFloatRepr(value) };
  }
  if (Array.isArray(value)) return value.map(queueSnapshot);
  if (value instanceof JsonObject) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of value.entries) definePlain(result, key, queueSnapshot(entry));
    return result;
  }
  if (isJsonRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of recordEntries(value)) {
      definePlain(result, key, queueSnapshot(entry));
    }
    return result;
  }
  return value;
}

function setEntry(entries: Array<[string, unknown]>, key: string, value: unknown): void {
  const index = entries.findIndex(([name]) => name === key);
  if (index >= 0) entries[index] = [key, value];
  else entries.push([key, value]);
}

function isActiveJob(job: JsonRecordLike): boolean {
  const state = opt(job, 'state');
  const vendor = opt(job, 'vendor_state');
  return (
    state === 'pending' ||
    state === 'reviewing' ||
    state === 'launch-unknown' ||
    state === 'publication-pending' ||
    vendor === 'live' ||
    vendor === 'unknown'
  );
}

function queueItems(queue: JsonRecordLike): JsonRecordLike[] {
  const value = opt(queue, 'items');
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('queue items must be an array');
  return value.map((entry) => asDoc(entry, 'queue item'));
}

function scopeRows(job: JsonRecordLike): JsonRecordLike[] {
  const value = opt(job, 'scope');
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('queue item scope must be an array');
  return value.map((entry) => asDoc(entry, 'scope row'));
}

/**
 * `backfill_inventory.capture`: pin every external input before ranking.
 *
 * `required_paths` are retained forge/path-lineage evidence, never model
 * output. Every unknown field survives row by row; the manifest is returned
 * with its digest and the capture artifacts are written through the seam.
 */
export async function capture(options: BackfillCaptureOptions): Promise<Record<string, unknown>> {
  const { repo, target, ledgerHead, events, artifacts } = options;
  await repo.resolve(target);
  ledgerTimestamp(options.evaluatedAt);
  ledgerValidateSequence(events);
  const tiers = asDoc(options.tiers, 'tier policy');
  const limits = asDoc(options.limits, 'construction limits');
  if (sha256Hex(options.protectedBytes) !== need(tiers, 'protected_policy_sha256', 'tier policy')) {
    fail('tier policy does not match protected-path snapshot');
  }
  const bounds = effectiveLimits(limits, { requireVerified: false });
  const rows = await repo.inventory(target, bounds.perFile);
  const fold = await repo.coverage(target, events, artifacts);
  const churn = await repo.churn(target, options.evaluatedAt);
  const findings = confirmedCounts(events);

  const byName = new Map<string, Record<string, unknown>>();
  const objects: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const name = text(row.path, 'inventory object path');
    const copy = copyRow(row, 'inventory object');
    copy['tier'] = captureTier(name, tiers);
    copy['covered'] = rangesOf(fold.covered.get(name) ?? new Set<number>());
    copy['evidence'] = sortedStrings(fold.evidence.get(name) ?? []);
    copy['churn'] = churn.get(name) ?? 0;
    copy['findings'] = findings.get(name) ?? 0;
    byName.set(name, copy);
    objects.push(copy);
  }

  const rawQueueText = pythonJsonText(options.queue, {
    asciiOnly: true,
    sortKeys: true,
    keyOrder: 'code-point',
    indent: null,
  });
  const rawQueue = await artifacts.put(new Uint8Array(Buffer.from(rawQueueText, 'utf8')));

  const queue = asDoc(options.queue, 'queue');
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of recordEntries(queue)) entries.push([key, value]);
  const failuresPresent = recordHas(queue, 'backfill_scope_failures');
  const failures = failuresPresent ? plainRecordCopy(opt(queue, 'backfill_scope_failures')) : {};
  const lineageUnits = new Map<string, Set<string>>();
  for (const job of queueItems(queue)) {
    const jobTarget = opt(job, 'target');
    if (!pyTruthy(jobTarget)) continue;
    const jobLineages = optionalDoc(job, 'path_lineages', 'path_lineages');
    for (const scope of scopeRows(job)) {
      const scopePath = text(need(scope, 'path', 'scope row'), 'scope path');
      const declared = jobLineages === null ? undefined : opt(jobLineages, scopePath);
      const unit = declared === undefined ? scopePath : text(declared, 'path lineage');
      if (!Object.prototype.hasOwnProperty.call(failures, unit)) continue;
      const name = await repo.lineage(text(jobTarget, 'queue item target'), target, scopePath);
      if (name === null || !byName.has(name)) continue;
      let units = lineageUnits.get(name);
      if (units === undefined) {
        units = new Set<string>();
        lineageUnits.set(name, units);
      }
      units.add(unit);
    }
  }
  // A verified rename keeps its failure lineage. Multiple histories mapping to
  // one current path are conservatively joined, never reset by regrouping.
  const lineages: Record<string, unknown> = {};
  for (const [name, units] of lineageUnits) {
    const canonical = codePointExtreme([...units], false);
    const values = [...units].map((unit) => plainRecordCopy(recordGet(failures, unit)));
    const next = values
      .map((value) => recordGet(value, 'next_eligible_at'))
      .filter((value): value is string => typeof value === 'string');
    failures[canonical] = {
      failures: Math.max(
        ...values.map((value) => pythonInt(recordGet(value, 'failures'), 'family failures')),
      ),
      quarantined: values.some((value) => pyTruthy(recordGet(value, 'quarantined'))),
      next_eligible_at: next.length === 0 ? null : codePointExtreme(next, true),
    };
    definePlain(lineages, name, canonical);
  }
  if (failuresPresent) setEntry(entries, 'backfill_scope_failures', failures);
  setEntry(entries, 'backfill_path_lineages', lineages);

  const mappedOwnership: Array<Record<string, unknown>> = [];
  for (const job of queueItems(queue)) {
    if (!isActiveJob(job)) continue;
    const jobTarget = opt(job, 'target');
    for (const owned of scopeRows(job)) {
      if (jobTarget === target) continue;
      const ownedPath = text(need(owned, 'path', 'scope row'), 'scope path');
      const ownedLines = intervalsOf(need(owned, 'intervals', 'scope row'), 'ownership intervals');
      const carried = await repo.carry(
        text(jobTarget, 'queue item target'),
        target,
        ownedPath,
        ownedLines,
      );
      const current = carried.name === null ? undefined : byName.get(carried.name);
      if (carried.name !== null && current !== undefined && carried.mapped.size > 0) {
        mappedOwnership.push({
          target,
          path: carried.name,
          blob: current['blob'],
          intervals: rangesOf(carried.mapped),
        });
      } else if (byName.has(ownedPath)) {
        // Uncertain ownership mapping conservatively holds this path.
        const row = byName.get(ownedPath) as Record<string, unknown>;
        const lines = row['lines'];
        mappedOwnership.push({
          target,
          path: row['path'],
          blob: row['blob'],
          intervals: typeof lines === 'number' && lines > 0 ? [[1, lines]] : [],
        });
      }
    }
  }
  setEntry(entries, 'backfill_mapped_ownership', mappedOwnership);

  const updatedQueue: Record<string, unknown> = {};
  for (const [key, value] of entries) definePlain(updatedQueue, key, value);

  const snapshotValues: Record<string, unknown> = {
    queue: queueSnapshot(updatedQueue),
    required: options.required,
    tiers: options.tiers,
    limits: options.limits,
    objects,
    required_paths: options.requiredPaths,
    ledger: events,
    required_members: options.members ?? {},
    evidence_gaps: fold.gaps,
    protected_policy: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      options.protectedBytes,
    ),
  };
  const snapshots: Record<string, BackfillCaptureReference> = {};
  for (const key of BACKFILL_SNAPSHOT_KEYS) {
    snapshots[key] = await artifacts.put(ledgerJsonBytes(snapshotValues[key]));
  }

  const manifest: Record<string, unknown> = {
    version: BACKFILL_INVENTORY_VERSION,
    repo: LEDGER_REPOSITORY,
    target,
    tree: await repo.tree(target),
    ledger_head: ledgerHead,
    evaluated_at: options.evaluatedAt,
    snapshots,
    git_version: await repo.gitVersion(),
    blame_options: [...BACKFILL_BLAME_OPTIONS],
    construction_version: need(limits, 'construction_version', 'construction limits'),
    scoring_version: need(limits, 'scoring_version', 'construction limits'),
    limits_version: need(limits, 'version', 'construction limits'),
    tiers_version: need(tiers, 'version', 'tier policy'),
    git_bundle: await repo.retain(artifacts, [target]),
    raw_queue: rawQueue,
    queue_encoding: 'legacy-number-tag/v1',
  };
  manifest['id'] = ledgerJsonDigest(manifest);
  await artifacts.put(ledgerJsonBytes(manifest));
  return manifest;
}
