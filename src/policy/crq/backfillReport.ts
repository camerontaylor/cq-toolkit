/**
 * Backfill baseline and debt reporting (`backfill_report`).
 *
 * Ports `backfill_report.baseline`, `summary` and `finding_triage`. The report
 * is the operator surface: it says how much of each importance tier is still
 * unreviewed, what a pinned T0 baseline still owes, and which findings need a
 * human. Two disciplines from the Python oracle matter here:
 *
 * - removals never mean reviewed. A baseline line that no longer exists is
 *   counted as removed or superseded only after an unambiguous deletion is
 *   proven, and an unverifiable lineage keeps the object visible as unresolved
 *   instead of silently shrinking the debt;
 * - a typed failure class is never inferred from prose. Only the explicit
 *   `owner-decision` class routes a finding to the owner; an absent or foreign
 *   class stays operator attention under its own honest bucket.
 *
 * Git work (lineage, proven deletion, interval carry) is injected as
 * {@link BackfillReportRepo}: `summary` never spawns Git itself, and the
 * adapter that binds it owns every repository read.
 */
import { civilFromDays, daysFromCivil } from './utc.js';
import { toPlainJsonDeep } from './jsonValue.js';
import { BackfillInventoryError, intervalsOf, pythonInt } from './backfillInventory.js';
import { ledgerJsonDigest } from './pythonJson.js';
import {
  isJsonRecord,
  pyTruthy,
  recordEntries,
  recordGet,
  recordHas,
  type JsonRecordLike,
} from './queueDoc.js';

/** The typed failure classes `repair_tick.mark_finding_outcome` accepts. */
export const BACKFILL_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'transient',
  'exhausted',
  'evidence',
  'protected-path',
  'owner-decision',
]);

/** The report's own refusal (a malformed baseline or an unknown tier). */
export class BackfillReportError extends Error {
  override readonly name: string = 'BackfillReportError';

  constructor(message: string) {
    super(message);
  }
}

function fail(message: string): never {
  throw new BackfillReportError(message);
}

function asDoc(value: unknown, what: string): JsonRecordLike {
  if (!isJsonRecord(value)) fail(`${what} must be an object`);
  return value;
}

function need(document: JsonRecordLike, key: string, what: string): unknown {
  if (!recordHas(document, key)) fail(`${what} is missing ${key}`);
  return recordGet(document, key);
}

function opt(document: JsonRecordLike | null, key: string): unknown {
  return document === null ? undefined : recordGet(document, key);
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(`${what} must be a string`);
  return value;
}

function amounts(value: unknown, what: string): Set<number> {
  try {
    return intervalsOf(value, what);
  } catch (error) {
    if (error instanceof BackfillInventoryError) fail(error.message);
    throw error;
  }
}

/** The Git provenance seam `summary` consumes. */
export interface BackfillReportRepo {
  /** `repo.tree(commit)`: the tree object id of a resolved commit. */
  tree(commit: string): Promise<string>;
  /** `repo.lineage(old, next, path)`: null when no unique exact-rename chain. */
  lineage(old: string, next: string, path: string): Promise<string | null>;
  /** `repo.proven_deleted(old, next, path)`: only an unambiguous deletion. */
  provenDeleted(old: string, next: string, path: string): Promise<boolean>;
  /** `repo.carry(old, next, path, lines)`: surviving line numbers in `next`. */
  carry(
    old: string,
    next: string,
    path: string,
    lines: ReadonlySet<number>,
  ): Promise<{ readonly name: string | null; readonly mapped: ReadonlySet<number> }>;
}

/** `backfill_report.baseline`: pin T0 once, with a digest over its own rows. */
export function baseline(options: {
  readonly ranked: unknown;
  readonly tree: string;
  readonly policyDigest: string;
  readonly ledgerHead: string;
  readonly at: string;
}): Record<string, unknown> {
  const ranked = asDoc(options.ranked, 'ranked inventory');
  const paths = need(ranked, 'paths', 'ranked inventory');
  if (!Array.isArray(paths)) fail('ranked paths must be an array');
  const candidates = need(ranked, 'candidates', 'ranked inventory');
  if (!Array.isArray(candidates)) fail('ranked candidates must be an array');
  const rows = paths.map((value) => {
    const row = asDoc(value, 'ranked path');
    // The oracle copies the ranked row into the pinned baseline, so a captured
    // value keeps its Python type and the id digests the same bytes.
    return toPlainJsonDeep({
      path: need(row, 'path', 'ranked path'),
      blob: need(row, 'blob', 'ranked path'),
      tier: need(row, 'tier', 'ranked path'),
      lines: need(row, 'lines', 'ranked path'),
      uncovered: need(row, 'uncovered', 'ranked path'),
      disposition: need(row, 'disposition', 'ranked path'),
      reason: need(row, 'reason', 'ranked path'),
    });
  });
  const value: Record<string, unknown> = {
    schema: 'cq.backfill-baseline/v1',
    target: need(ranked, 'target', 'ranked inventory'),
    tree: options.tree,
    manifest_id: need(ranked, 'manifest_id', 'ranked inventory'),
    ledger_head: options.ledgerHead,
    policy_digest: options.policyDigest,
    pinned_at: options.at,
    paths: rows,
    bounded_partitions: candidates.length,
  };
  value['id'] = ledgerJsonDigest(value);
  return value;
}

/** One atomic triage row, already read by the caller. */
export interface TriageRow {
  /** The file name (`<id>.json`), used only for the strict error message. */
  readonly file: string;
  /** The row as `review_ledger.loads` decoded it. */
  readonly value: unknown;
}

/**
 * `backfill_report.finding_triage(root, strict=True)` for the report's call.
 *
 * The row values arrive already decoded so this module keeps no file I/O; a
 * malformed row still raises (Python's strict mode), because the report is the
 * operator's evidence and a partial count would misstate the backlog.
 */
export function findingTriage(rows: readonly TriageRow[]): Record<string, unknown> {
  const counts = new Map<string, number>();
  const needsHuman: Array<Record<string, unknown>> = [];
  const ownerDecisions: Array<Record<string, unknown>> = [];
  const operatorAttention: Array<Record<string, unknown>> = [];
  const unknownFailure: Array<Record<string, unknown>> = [];
  let ownerCount = 0;
  let operatorCount = 0;
  let unknownFailureCount = 0;
  let humanCount = 0;
  let contextFailureCount = 0;
  const contextFailures: Array<Record<string, unknown>> = [];
  for (const { file, value } of [...rows].sort((left, right) =>
    left.file < right.file ? -1 : left.file > right.file ? 1 : 0,
  )) {
    let row: JsonRecordLike;
    let finding: JsonRecordLike;
    let status: string;
    try {
      row = asDoc(value, 'triage row');
      status = text(need(row, 'status', `triage row ${file}`), 'triage status');
      finding = asDoc(need(row, 'finding', `triage row ${file}`), 'triage finding');
      for (const required of [
        need(row, 'canonical_id', `triage row ${file}`),
        need(row, 'target', `triage row ${file}`),
        need(finding, 'id', `triage finding ${file}`),
        need(finding, 'title', `triage finding ${file}`),
        need(finding, 'severity', `triage finding ${file}`),
      ]) {
        if (typeof required !== 'string' || required === '') fail('invalid finding row');
      }
    } catch (error) {
      fail(
        `invalid finding row ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const detail: Record<string, unknown> = {
      id: opt(finding, 'id'),
      canonical_id: opt(row, 'canonical_id'),
      // Python's `.get()` yields `None` for an absent key, and the canonical
      // writer emits that as `null`: an absent optional field is never omitted.
      path: pyTruthy(opt(row, 'mapped_path'))
        ? opt(row, 'mapped_path')
        : (opt(finding, 'path') ?? null),
      title: opt(finding, 'title'),
      severity: opt(finding, 'severity'),
      target: recordHas(row, 'target_current') ? opt(row, 'target_current') : opt(row, 'target'),
      event_id: opt(row, 'previous_event_id') ?? null,
    };
    counts.set(status, (counts.get(status) ?? 0) + 1);
    const contextError = opt(row, 'context_error');
    if (isJsonRecord(contextError)) {
      contextFailureCount += 1;
      contextFailures.push({ ...detail, status, context_error: contextError });
    }
    if (status === 'needs-human') {
      humanCount += 1;
      const failureClass = opt(row, 'failure_class');
      const unknown = !(
        typeof failureClass === 'string' && BACKFILL_FAILURE_CLASSES.has(failureClass)
      );
      if (failureClass === 'owner-decision') {
        ownerCount += 1;
        ownerDecisions.push({ ...detail, failure_class: failureClass });
      } else if (!unknown) {
        operatorCount += 1;
        operatorAttention.push({ ...detail, failure_class: failureClass });
      } else {
        unknownFailureCount += 1;
        operatorCount += 1;
        unknownFailure.push({ ...detail, failure_class: failureClass ?? null });
      }
      needsHuman.push(detail);
    }
  }
  const result: Record<string, unknown> = {
    counts: Object.fromEntries(
      [...counts.entries()].sort((left, right) =>
        left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
      ),
    ),
    needs_human: needsHuman,
  };
  if (humanCount > 0) {
    result['owner_decisions'] = ownerDecisions;
    result['operator_attention'] = operatorAttention;
    result['owner_decisions_count'] = ownerCount;
    result['operator_attention_count'] = operatorCount;
    result['unknown_failure_class'] = unknownFailure;
    result['unknown_failure_class_count'] = unknownFailureCount;
    if (unknownFailureCount > 0) {
      result['unknown_failure_class_note'] =
        'rows with an absent or unrecognized failure_class (including ' +
        'non-string legacy values); treated as operator attention, not ' +
        'owner decisions (D7); unknown_failure_class_count is a subset ' +
        'of operator_attention_count';
    }
  }
  if (contextFailureCount > 0) {
    result['context_failures'] = contextFailures;
    result['context_failures_count'] = contextFailureCount;
    result['context_failures_omitted'] = 0;
  }
  return result;
}

const TIERS = ['T1', 'T2', 'T3', 'T4'] as const;

const OPERATIONAL_TARGET =
  'zero surviving baseline T1 debt within 14 days, conditional on spare included quota and no unresolved exclusions';

const CAPACITY_LIMIT =
  'eligible partitions only; missing daily observations prevent an estimate; ' +
  'held work and unresolved objects remain separately visible';

interface TierTotals {
  covered_lines: number;
  uncovered_lines: number;
  unresolved_objects: Array<Record<string, unknown>>;
  empty_files: number;
}

function dayNumber(value: unknown, what: string): number {
  if (typeof value !== 'string') fail(`${what} must be an exact UTC timestamp`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value);
  if (match === null) fail(`${what} must be an exact UTC timestamp`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return daysFromCivil(year, month, day);
}

function isoDay(dayNumberValue: number): string {
  // `daysFromCivil` is the inverse of `civilFromDays`; formatting through the
  // civil unit keeps the observed-window spelling identical to `date.isoformat`.
  const civil = civilFromDays(dayNumberValue);
  return `${String(civil.year).padStart(4, '0')}-${String(civil.month).padStart(2, '0')}-${String(civil.day).padStart(2, '0')}`;
}

function secondsWithinDay(value: unknown, what: string): number {
  if (typeof value !== 'string') fail(`${what} must be an exact UTC timestamp`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value);
  if (match === null) fail(`${what} must be an exact UTC timestamp`);
  return Number(match[4]) * 3600 + Number(match[5]) * 60 + Number(match[6]);
}

/** `backfill_report.summary`: tier debt, baseline accounting and operation counts. */
export async function summary(options: {
  readonly ranked: unknown;
  readonly queue: unknown;
  readonly original?: unknown;
  readonly repo: BackfillReportRepo;
  readonly triage?: unknown;
}): Promise<Record<string, unknown>> {
  const ranked = asDoc(options.ranked, 'ranked inventory');
  const queue = asDoc(options.queue, 'queue snapshot');
  const rawPaths = need(ranked, 'paths', 'ranked inventory');
  if (!Array.isArray(rawPaths)) fail('ranked paths must be an array');
  const totals = new Map<string, TierTotals>();
  for (const tier of TIERS) {
    totals.set(tier, {
      covered_lines: 0,
      uncovered_lines: 0,
      unresolved_objects: [],
      empty_files: 0,
    });
  }
  const current = new Map<string, JsonRecordLike>();
  for (const value of rawPaths) {
    const row = asDoc(value, 'ranked path');
    const name = text(need(row, 'path', 'ranked path'), 'ranked path name');
    current.set(name, row);
  }
  for (const [name, row] of current) {
    const tier = text(need(row, 'tier', `tier for ${name}`), `tier for ${name}`);
    const group = totals.get(tier);
    if (group === undefined) fail(`ranked path ${name} has an unknown tier`);
    const debt = amounts(need(row, 'uncovered', `uncovered for ${name}`), 'uncovered intervals');
    group.uncovered_lines += debt.size;
    const lines = opt(row, 'lines');
    const countable =
      lines === null || lines === undefined ? null : pythonInt(lines, `lines for ${name}`);
    group.covered_lines += Math.max(0, (countable ?? 0) - debt.size);
    const disposition = need(row, 'disposition', `disposition for ${name}`);
    if (disposition === 'unsupported' || disposition === 'ambiguous' || countable === null) {
      group.unresolved_objects.push({
        path: name,
        // The oracle indexes `row["reason"]` here, so a captured row that lost
        // it is a refusal rather than an unresolved object with no explanation.
        reason: need(row, 'reason', `reason for ${name}`),
        countable_lines: countable,
      });
    }
    if (disposition === 'empty') group.empty_files += 1;
  }
  let baselineResult: Record<string, unknown> | null = null;
  const original = options.original === undefined ? null : options.original;
  if (original !== null) {
    const pinned = asDoc(original, 'baseline');
    const withoutId: Record<string, unknown> = {};
    for (const [key, value] of recordEntries(pinned)) if (key !== 'id') withoutId[key] = value;
    if (opt(pinned, 'id') !== ledgerJsonDigest(withoutId)) fail('baseline hash mismatch');
    const originalTarget = text(need(pinned, 'target', 'baseline'), 'baseline target');
    const currentTarget = text(need(ranked, 'target', 'ranked inventory'), 'ranked target');
    const baselinePaths = need(pinned, 'paths', 'baseline');
    if (!Array.isArray(baselinePaths)) fail('baseline paths must be an array');
    const survivingAll = new Map<string, Set<number>>();
    baselineResult = {
      id: opt(pinned, 'id'),
      target: originalTarget,
      surviving_T1_debt: 0,
      baseline_T1_reviewed_since: 0,
      baseline_T1_removed_or_superseded: 0,
      new_T1_debt: 0,
      unresolved_baseline_objects: [],
    };
    const unresolved = baselineResult['unresolved_baseline_objects'] as Array<
      Record<string, unknown>
    >;
    for (const value of baselinePaths) {
      const row = asDoc(value, 'baseline path');
      if (need(row, 'tier', 'baseline path') !== 'T1') continue;
      const name = text(need(row, 'path', 'baseline path'), 'baseline path name');
      const oldDebt = amounts(
        need(row, 'uncovered', `baseline uncovered for ${name}`),
        'baseline uncovered',
      );
      const lines = opt(row, 'lines');
      const mapped = await options.repo.lineage(originalTarget, currentTarget, name);
      if (mapped === null) {
        if (await options.repo.provenDeleted(originalTarget, currentTarget, name)) {
          baselineResult['baseline_T1_removed_or_superseded'] =
            (baselineResult['baseline_T1_removed_or_superseded'] as number) + oldDebt.size;
        } else {
          const copy: Record<string, unknown> = {};
          for (const [key, entry] of recordEntries(row)) copy[key] = entry;
          unresolved.push({ ...copy, reason: 'unverified baseline lineage' });
        }
        continue;
      }
      const present = current.get(mapped) ?? null;
      const presentLines = present === null ? null : opt(present, 'lines');
      const presentDisposition = present === null ? null : opt(present, 'disposition');
      const unmeasurable =
        present === null ||
        presentLines === null ||
        presentLines === undefined ||
        presentDisposition === 'unsupported' ||
        presentDisposition === 'ambiguous';
      const unmeasuredBaseline =
        lines === null ||
        lines === undefined ||
        need(row, 'disposition', `baseline disposition for ${name}`) === 'unsupported' ||
        need(row, 'disposition', `baseline disposition for ${name}`) === 'ambiguous';
      const carryAll = pyTruthy(lines)
        ? (
            await options.repo.carry(
              originalTarget,
              currentTarget,
              name,
              allLines(pythonInt(lines, `lines for ${name}`)),
            )
          ).mapped
        : new Set<number>();
      const carryDebt =
        oldDebt.size > 0
          ? (await options.repo.carry(originalTarget, currentTarget, name, oldDebt)).mapped
          : new Set<number>();
      const surviving = survivingAll.get(mapped);
      if (surviving === undefined) survivingAll.set(mapped, new Set(carryAll));
      else for (const line of carryAll) surviving.add(line);
      if (unmeasurable) {
        if (unmeasuredBaseline || carryDebt.size > 0) {
          const copy: Record<string, unknown> = {};
          for (const [key, entry] of recordEntries(row)) copy[key] = entry;
          unresolved.push({ ...copy, reason: 'unmeasurable current object' });
        }
      } else {
        const presentUncovered = amounts(opt(present, 'uncovered'), 'current uncovered intervals');
        let remaining = 0;
        for (const line of carryDebt) if (presentUncovered.has(line)) remaining += 1;
        baselineResult['surviving_T1_debt'] =
          (baselineResult['surviving_T1_debt'] as number) + remaining;
        baselineResult['baseline_T1_reviewed_since'] =
          (baselineResult['baseline_T1_reviewed_since'] as number) + (carryDebt.size - remaining);
        if (unmeasuredBaseline && presentUncovered.size > 0) {
          const copy: Record<string, unknown> = {};
          for (const [key, entry] of recordEntries(row)) copy[key] = entry;
          unresolved.push(copy);
        }
      }
      baselineResult['baseline_T1_removed_or_superseded'] =
        (baselineResult['baseline_T1_removed_or_superseded'] as number) +
        (oldDebt.size - carryDebt.size);
    }
    for (const [name, row] of current) {
      if (need(row, 'tier', `tier for ${name}`) !== 'T1') continue;
      const uncovered = amounts(opt(row, 'uncovered'), `uncovered for ${name}`);
      let fresh = 0;
      const surviving = survivingAll.get(name) ?? new Set<number>();
      for (const line of uncovered) if (!surviving.has(line)) fresh += 1;
      baselineResult['new_T1_debt'] = (baselineResult['new_T1_debt'] as number) + fresh;
    }
    const daily = asDoc(opt(queue, 'backfill_daily_capacity') ?? {}, 'daily capacity');
    const pinnedAt = need(pinned, 'pinned_at', 'baseline');
    const evaluatedAt = recordHas(ranked, 'evaluated_at')
      ? recordGet(ranked, 'evaluated_at')
      : pinnedAt;
    const startDay = dayNumber(pinnedAt, 'pinned_at');
    const endDay = dayNumber(evaluatedAt, 'evaluated_at');
    const observedDays = Math.max(1, endDay - startDay + 1);
    const startIso = isoDay(startDay);
    const endIso = isoDay(endDay);
    const observed: Array<JsonRecordLike> = [];
    for (const [date, value] of recordEntries(daily)) {
      if (startIso <= date && date <= endIso) observed.push(asDoc(value, `daily capacity ${date}`));
    }
    let completed = 0;
    for (const day of observed) {
      const count = opt(day, 'completed_partitions');
      completed +=
        count === undefined || count === null ? 0 : pythonInt(count, 'completed_partitions');
    }
    const candidates = need(ranked, 'candidates', 'ranked inventory');
    if (!Array.isArray(candidates)) fail('ranked candidates must be an array');
    const remainingPartitions = candidates.filter(
      (value) => need(asDoc(value, 'ranked candidate'), 'tier', 'ranked candidate') === 'T1',
    ).length;
    baselineResult['remaining_eligible_T1_partitions'] = remainingPartitions;
    baselineResult['estimated_days_at_observed_capacity'] =
      completed > 0 && observed.length === observedDays
        ? Math.floor((remainingPartitions * observedDays + completed - 1) / completed)
        : null;
    baselineResult['capacity_estimate_limit'] = CAPACITY_LIMIT;
    const startSeconds =
      dayNumber(pinnedAt, 'pinned_at') * 86_400 + secondsWithinDay(pinnedAt, 'pinned_at');
    const endSeconds =
      dayNumber(evaluatedAt, 'evaluated_at') * 86_400 +
      secondsWithinDay(evaluatedAt, 'evaluated_at');
    const age = Math.floor((endSeconds - startSeconds) / 86_400);
    const pending = (baselineResult['surviving_T1_debt'] as number) > 0 || unresolved.length > 0;
    baselineResult['target_status'] =
      age >= 14 && pending
        ? 'missed-capacity-or-exclusions'
        : pending
          ? 'pending'
          : 'baseline-zero';
  }
  const triage = options.triage === undefined ? null : options.triage;
  const states = new Map<string, number>();
  const items = opt(queue, 'items');
  if (items !== undefined && items !== null) {
    if (!Array.isArray(items)) fail('queue items must be an array');
    for (const value of items) {
      const item = asDoc(value, 'queue item');
      const kind = opt(item, 'kind');
      if (kind !== 'backfill' && kind !== 'coverage') continue;
      const state = knowable(opt(item, 'state'));
      states.set(state, (states.get(state) ?? 0) + 1);
    }
  }
  const families = opt(queue, 'backfill_families');
  const quarantinedFamilies =
    families === undefined || families === null
      ? 0
      : isJsonRecord(families)
        ? recordEntries(families).filter(([, value]) =>
            pyTruthy(opt(asDoc(value, 'backfill family'), 'quarantined')),
          ).length
        : fail('backfill_families must be an object');
  const t1 = totals.get('T1') as TierTotals;
  // Everything below echoes captured rows (baseline paths, queue counters,
  // admission history), so the report is plain JSON like the oracle's dicts.
  return toPlainJsonDeep({
    manifest_id: need(ranked, 'manifest_id', 'ranked inventory'),
    target: need(ranked, 'target', 'ranked inventory'),
    tiers: Object.fromEntries(TIERS.map((tier) => [tier, totals.get(tier) as TierTotals])),
    baseline: baselineResult,
    required: need(ranked, 'required', 'ranked inventory'),
    states: Object.fromEntries(
      [...states.entries()].sort((left, right) =>
        left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
      ),
    ),
    publication_pending: states.get('publication-pending') ?? 0,
    quarantined_families: quarantinedFamilies,
    finding_triage: pyTruthy(triage) ? triage : { status: 'not-collected' },
    finding_delivery_backlog:
      triage === null
        ? (opt(queue, 'backfill_finding_backlog') ?? { status: 'not-collected' })
        : recordGet(asDoc(triage, 'triage'), 'counts'),
    spare_quota_admissions: opt(queue, 'backfill_admissions') ?? [],
    daily_capacity: opt(queue, 'backfill_daily_capacity') ?? {},
    idle_with_coverage_candidate: opt(queue, 'backfill_idle_with_candidate') ?? 0,
    strict_T1_zero:
      t1.uncovered_lines === 0 &&
      t1.unresolved_objects.length === 0 &&
      !pyTruthy(need(ranked, 'evidence_gaps', 'ranked inventory')),
    operational_target: OPERATIONAL_TARGET,
  }) as Record<string, unknown>;
}

function allLines(maximum: number): Set<number> {
  const result = new Set<number>();
  for (let line = 1; line <= maximum; line += 1) result.add(line);
  return result;
}

function knowable(value: unknown): string {
  return typeof value === 'string' ? value : 'unknown';
}
