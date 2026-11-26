/**
 * `coverage._legacy_origins`, `legacy_retry_view`, `_legacy_retry_allowed` and
 * `coverage_candidate` (apps/crq-python/coverage.py:52, :107, :348, :381) over
 * plain mutable records, as the tick edits them. Inactive: nothing routes it.
 *
 * Every Python exception that can escape is a {@link PyError} of the same
 * class (`AttributeError` from `.get` on a non-dict, `TypeError` from a
 * non-iterable or unhashable member, `KeyError` from `[...]`, `ValueError`),
 * and each `except (...)` clause catches exactly the classes Python names.
 * Laziness is kept: `_time(at)` is evaluated only when the view needs it.
 */
import { createHash } from 'node:crypto';
import { pyTruthy } from './coverageUtilization.js';
import {
  PyError,
  compareCodePoints,
  isDict,
  isPyInt,
  pyCompare,
  pyCompareTuples,
  pyContains,
  pyEq,
  pyGet,
  pyGetOr,
  pyHashKey,
  pyIndex,
  pyIso,
  pyIter,
  pyNumber,
  pyParent,
  pyPath,
  pySet,
  pyStr,
  pyTime,
  type Dict,
  type PyErrorClass,
} from './pyCompat.js';
import { UtcInstant } from './utc.js';

const COVERAGE_RANK = 4;
const SECONDS_MICROS = 1_000_000n;

const hasClass = (error: unknown, ...classes: PyErrorClass[]): error is PyError =>
  error instanceof PyError && classes.includes(error.pythonError);

/** `backfill_jobs.is_execution_owner` over a plain item. */
export function isExecutionOwnerPlain(item: unknown): boolean {
  return (
    pyGet(item, 'vendor_state') === 'live' ||
    pyGet(item, 'vendor_state') === 'unknown' ||
    pyTruthy(pyGet(item, 'run')) ||
    pyGet(item, 'state') === 'reviewing' ||
    pyGet(item, 'state') === 'launch-unknown'
  );
}

const items = (queue: unknown): unknown[] => pyIter(pyGetOr(queue, 'items', []));
const isNone = (value: unknown): boolean => value === null || value === undefined;

/** `coverage._legacy_family`. */
function legacyFamily(pr: unknown, originalPath: unknown): string {
  return `legacy-coverage:${pyStr(pr)}:${pyPath(originalPath)}`;
}

export interface LegacyOrigins {
  readonly source: Dict;
  readonly origins: string[];
}

/** `coverage._legacy_origins(queue, item, reviewed_paths=None)`. */
export function legacyOrigins(queue: unknown, item: unknown, reviewed?: unknown): LegacyOrigins {
  let names = pySet(pyGetOr(item, 'coverage_paths', []));
  const measureOf = (owner: unknown): unknown => {
    const measure = pyGet(owner, 'measure');
    return pyTruthy(measure) ? measure : {};
  };
  const synthetic = pySet(pyGetOr(measureOf(item), 'synthetic_paths', []));
  const seen = new Set(names.map(pyHashKey));
  for (const name of synthetic) {
    if (!seen.has(pyHashKey(name))) {
      seen.add(pyHashKey(name));
      names.push(name);
    }
  }
  if (!isNone(reviewed)) {
    const keep = new Set(pySet(reviewed).map(pyHashKey));
    names = names.filter((name) => keep.has(pyHashKey(name)));
  }
  let source: unknown =
    items(queue).find((i) => pyEq(pyGet(i, 'id'), pyGet(item, 'coverage_source'))) ?? null;
  if (!pyTruthy(source) && !pyTruthy(pyGet(item, 'coverage_source')) && names.length > 0) {
    const possible = items(queue).filter((i) => {
      if (pyGet(i, 'kind') !== 'merged' || isNone(pyGet(i, 'pr'))) return false;
      for (const name of names) {
        const files = pyIter(pyGetOr(measureOf(i), 'files', []));
        const found = files.some((f) => {
          const hit = [pyGet(f, 'path'), pyGet(f, 'now')];
          return hit.some((candidate) => pyEq(name, candidate));
        });
        if (!found) return false;
      }
      return true;
    });
    if (possible.length === 1) source = possible[0];
  }
  if (!pyTruthy(source)) {
    throw new PyError('ValueError', 'legacy coverage source is required for retry identity');
  }
  const sourceRecord = source as Dict;
  const files = pyGetOr(measureOf(sourceRecord), 'files', []);
  const origins: string[] = [];
  for (const name of names) {
    const matches = new Set<string>();
    for (const f of pyIter(files)) {
      if (!pyTruthy(pyGet(f, 'path'))) continue;
      if (![pyGet(f, 'path'), pyGet(f, 'now')].some((candidate) => pyEq(name, candidate))) continue;
      matches.add(pyPath(pyIndex(f, 'path')));
    }
    if (matches.size !== 1) {
      throw new PyError('ValueError', 'legacy coverage path lacks unambiguous source lineage');
    }
    for (const match of matches) if (!origins.includes(match)) origins.push(match);
  }
  return { source: sourceRecord, origins };
}

interface RunRecord {
  readonly item: unknown;
  readonly outcome: unknown;
  readonly when: bigint;
}

export interface LegacyRetryView {
  allowed: boolean;
  failures: number;
  deadline: string | null;
  reasons: string[];
  runs: string[];
  run_proofs: Record<string, unknown[]>;
}

const ATTEMPT_OUTCOMES = [
  'error',
  'interrupted',
  'skipped',
  'too_large',
  'malformed',
  'completed',
  'rate_limited',
  'auth',
  'action_required',
];
const FAILURE_OUTCOMES = ['error', 'interrupted', 'skipped', 'too_large', 'malformed'];

const inOutcomes = (value: unknown, outcomes: readonly string[]): boolean =>
  outcomes.some((outcome) => pyEq(value, outcome));

/** Insertion-ordered dict keyed by hash identity (Python `dict`). */
class RunMap {
  private readonly entries = new Map<string, { key: unknown; value: RunRecord }>();
  has(key: unknown): boolean {
    return this.entries.has(pyHashKey(key));
  }
  get(key: unknown): RunRecord {
    return this.entries.get(pyHashKey(key))!.value;
  }
  set(key: unknown, value: RunRecord): void {
    const hash = pyHashKey(key);
    const existing = this.entries.get(hash);
    this.entries.set(hash, { key: existing ? existing.key : key, value });
  }
  keys(): unknown[] {
    return [...this.entries.values()].map((entry) => entry.key);
  }
  values(): RunRecord[] {
    return [...this.entries.values()].map((entry) => entry.value);
  }
  pairs(): Array<[unknown, RunRecord]> {
    return [...this.entries.values()].map((entry) => [entry.key, entry.value]);
  }
  without(drop: (key: unknown, value: RunRecord) => boolean): RunMap {
    const out = new RunMap();
    for (const [key, value] of this.pairs()) if (!drop(key, value)) out.set(key, value);
    return out;
  }
}

const maxMicros = (values: readonly bigint[]): bigint | null =>
  values.length === 0 ? null : values.reduce((a, b) => (b > a ? b : a));

function proofOf(record: RunRecord): unknown[] {
  return [record.item, record.outcome, pyIso(new UtcInstant(record.when))];
}

/** `dict.get(key)` on a dict-typed `container` (a missing or unhashable key is tolerated like Python). */
function dictLookup(container: unknown, key: unknown): unknown {
  if (!isDict(container)) {
    throw new PyError('AttributeError', "object has no attribute 'get'");
  }
  pyHashKey(key);
  return typeof key === 'string' && Object.hasOwn(container, key) ? container[key] : undefined;
}

/** `coverage.legacy_retry_view(queue, pr, original_path, at)`. */
export function legacyRetryView(
  queue: unknown,
  pr: unknown,
  originalPath: unknown,
  at: unknown,
): LegacyRetryView {
  const family = legacyFamily(pr, originalPath);
  const histories = [
    pyGet(pyGetOr(queue, 'backfill_families', {}), family) ?? {},
    pyGet(pyGetOr(queue, 'backfill_scope_failures', {}), family) ?? {},
  ];
  const reasons: string[] = [];
  let runs = new RunMap();
  const deadlines: bigint[] = [];
  const resets: bigint[] = [];
  const quotaReleases: Array<[unknown, unknown]> = [];
  for (const release of pyIter(pyGetOr(queue, 'legacy_coverage_quota_releases', []))) {
    if (!pyEq(pyGet(release, 'family'), family)) continue;
    const update = pyIndex(release, 'deadlines');
    const pairs: Array<[unknown, unknown]> = isDict(update)
      ? Object.entries(update)
      : pyIter(update).map((pair) => {
          const two = pyIter(pair);
          if (two.length !== 2) {
            throw new PyError('ValueError', 'dictionary update sequence element has wrong length');
          }
          return [two[0], two[1]];
        });
    for (const [key, value] of pairs) {
      pyHashKey(key);
      const at = quotaReleases.findIndex(([existing]) => pyEq(existing, key));
      if (at === -1) quotaReleases.push([key, value]);
      else quotaReleases[at] = [key, value];
    }
  }
  const quotaDeadline = (runId: unknown): unknown => {
    pyHashKey(runId);
    const found = quotaReleases.find(([key]) => pyEq(key, runId));
    if (!found) throw new PyError('KeyError', JSON.stringify(runId));
    return found[1];
  };
  const cooldown = pyGet(queue, 'cooldown_until');
  if (pyTruthy(cooldown)) {
    try {
      deadlines.push(pyTime(pyIndex(queue, 'cooldown_until')));
    } catch (error) {
      if (!hasClass(error, 'TypeError', 'ValueError')) throw error;
      reasons.push('invalid global deadline');
    }
  }
  for (const h of histories) {
    if (pyTruthy(pyGet(h, 'next_eligible_at'))) {
      try {
        deadlines.push(pyTime(pyIndex(h, 'next_eligible_at')));
      } catch (error) {
        if (!hasClass(error, 'TypeError', 'ValueError')) throw error;
        reasons.push('invalid persisted deadline');
      }
    }
  }
  const seen = pyGetOr(queue, 'legacy_coverage_failure_runs', {});
  const seenValues = (): unknown[] => {
    if (!isDict(seen)) throw new PyError('AttributeError', "object has no attribute 'values'");
    return Object.values(seen);
  };
  for (const item of items(queue)) {
    if (pyGet(item, 'kind') !== 'coverage') continue;
    let source: Dict;
    let origins: string[];
    try {
      ({ source, origins } = legacyOrigins(queue, item));
    } catch (error) {
      if (!hasClass(error, 'ValueError')) throw error;
      // Without lineage a same-PR item cannot be proven disjoint; a missing PR
      // identity is also potentially relevant to this scope.
      const itemPr = pyGet(item, 'pr');
      if (isNone(itemPr) || pyEq(itemPr, pr)) reasons.push('unresolved legacy source or lineage');
      continue;
    }
    if (!pyEq(pyGet(source, 'pr'), pr) || !origins.includes(originalPath as string)) continue;
    if (pyTruthy(pyGet(item, 'not_before'))) {
      try {
        deadlines.push(pyTime(pyIndex(item, 'not_before')));
      } catch (error) {
        if (!hasClass(error, 'TypeError', 'ValueError')) throw error;
        reasons.push('invalid item deadline');
      }
    }
    const attempts = (): unknown[] => pyIter(pyGetOr(item, 'attempts', []));
    if (attempts().some((a) => !inOutcomes(pyGet(a, 'outcome'), ATTEMPT_OUTCOMES))) {
      reasons.push('unknown attempt outcome');
    }
    for (const attempt of attempts()) {
      if (pyGet(attempt, 'outcome') !== 'rate_limited') continue;
      try {
        const own = pyGet(attempt, 'deadline');
        deadlines.push(pyTime(pyTruthy(own) ? own : quotaDeadline(pyIndex(attempt, 'run_id'))));
      } catch (error) {
        if (!hasClass(error, 'KeyError', 'TypeError', 'ValueError')) throw error;
        reasons.push('historical vendor deadline unavailable');
      }
    }
    const failures = attempts().filter((a) => inOutcomes(pyGet(a, 'outcome'), FAILURE_OUTCOMES));
    if (
      ['blocked', 'failed', 'quarantined'].includes(pyGet(item, 'state') as string) &&
      failures.length === 0 &&
      !seenValues().some((v) => pyEq(pyGet(v, 'item'), pyGet(item, 'id')))
    ) {
      reasons.push('terminal history missing');
    }
    const itemResets: bigint[] = [];
    for (const cycle of pyIter(pyGetOr(item, 'cycles', []))) {
      const runId = pyGet(cycle, 'run_id');
      const attempt = attempts().find((a) => pyEq(pyGet(a, 'run_id'), runId)) ?? null;
      const coverage = pyGet(queue, 'coverage');
      const creditRuns = pyGetOr(pyTruthy(coverage) ? coverage : {}, 'runs', {});
      const credit = dictLookup(creditRuns, runId);
      try {
        if (
          !pyTruthy(attempt) ||
          pyGet(attempt, 'outcome') !== 'completed' ||
          pyGet(attempt, 'counted') !== true ||
          !pyEq(pyGet(attempt, 'head'), pyGet(cycle, 'head')) ||
          !pyEq(pyGet(attempt, 'base'), pyGet(cycle, 'base')) ||
          !pyTruthy(credit) ||
          !pyTruthy(pyGet(credit, 'paths'))
        ) {
          throw new PyError('ValueError', 'unverified success');
        }
        const credited = legacyOrigins(queue, item, pyIndex(credit, 'paths')).origins;
        const completed = pyTime(pyIndex(cycle, 'completed_at'));
        if (credited.includes(originalPath as string)) {
          if (
            pyTime(pyIndex(attempt, 'at')) > completed ||
            pyTime(pyIndex(credit, 'completed_at')) !== completed
          ) {
            throw new PyError('ValueError', 'conflicting success chronology');
          }
          resets.push(completed);
          itemResets.push(completed);
        }
      } catch (error) {
        if (!hasClass(error, 'KeyError', 'TypeError', 'ValueError')) throw error;
        reasons.push('success scope or ordering unresolved');
      }
    }
    if (isExecutionOwnerPlain(item)) reasons.push('live or unknown legacy ownership');
    for (const attempt of failures) {
      const runId = pyGet(attempt, 'run_id');
      const timestamp = pyGet(attempt, 'at');
      if (
        !pyTruthy(runId) ||
        !pyTruthy(timestamp) ||
        pyGet(attempt, 'counted') !== false ||
        !pyTruthy(pyGet(attempt, 'head')) ||
        !pyTruthy(pyGet(attempt, 'base'))
      ) {
        reasons.push('incomplete guarded harvest attempt');
        continue;
      }
      let when: bigint;
      try {
        when = pyTime(timestamp);
      } catch (error) {
        if (!hasClass(error, 'TypeError', 'ValueError')) throw error;
        reasons.push('invalid attempt time');
        continue;
      }
      const record: RunRecord = {
        item: pyGet(item, 'id'),
        outcome: pyGet(attempt, 'outcome'),
        when,
      };
      if (runs.has(runId)) {
        const prior = runs.get(runId);
        if (
          !pyEq(prior.item, record.item) ||
          !pyEq(prior.outcome, record.outcome) ||
          prior.when !== record.when
        ) {
          reasons.push('conflicting run identity');
        }
      }
      runs.set(runId, record);
    }
    if (isPyInt(pyGet(item, 'failures'))) {
      try {
        const cutoff = maxMicros(itemResets);
        let expected = 0;
        for (const a of failures) {
          if (cutoff === null || pyTime(pyIndex(a, 'at')) > cutoff) expected += 1;
        }
        if (Number(pyGet(item, 'failures')) !== expected) {
          reasons.push('unexplained item failure aggregate');
        }
      } catch (error) {
        if (!hasClass(error, 'KeyError', 'TypeError', 'ValueError')) throw error;
        reasons.push('unexplained item failure aggregate');
      }
    }
  }
  if (!isDict(seen)) throw new PyError('AttributeError', "object has no attribute 'items'");
  for (const [runId, record] of Object.entries(seen)) {
    if (!pyContains(pyGetOr(record, 'origins', []), originalPath)) continue;
    const item = items(queue).find((i) => pyEq(pyGet(i, 'id'), pyGet(record, 'item'))) ?? null;
    if (!pyTruthy(item)) {
      reasons.push('orphan adapter run');
      continue;
    }
    let when: bigint;
    try {
      const { source, origins } = legacyOrigins(queue, item);
      if (!pyEq(pyGet(source, 'pr'), pr) || !origins.includes(originalPath as string)) continue;
      when = pyTime(pyIndex(record, 'at'));
    } catch (error) {
      if (!hasClass(error, 'ValueError', 'TypeError', 'KeyError')) throw error;
      reasons.push('incomplete adapter run');
      continue;
    }
    if (runs.has(runId)) {
      const prior = runs.get(runId);
      if (
        !pyEq(prior.item, pyGet(record, 'item')) ||
        !pyEq(prior.outcome, pyGet(record, 'outcome'))
      ) {
        reasons.push('conflicting run identity');
      }
    } else {
      runs.set(runId, { item: pyGet(record, 'item'), outcome: pyGet(record, 'outcome'), when });
    }
  }
  let baseline: unknown[] = [0, 0];
  let released = false;
  let lastRelease: bigint | null = null;
  for (const event of pyIter(pyGetOr(queue, 'legacy_coverage_releases', []))) {
    if (!pyEq(pyGet(event, 'family'), family)) continue;
    const proofsValue = pyGet(event, 'runs');
    const proofs = pyTruthy(proofsValue) ? proofsValue : {};
    if (!isDict(proofs)) throw new PyError('AttributeError', "object has no attribute 'items'");
    const proofEntries = Object.entries(proofs);
    if (
      proofEntries.length === 0 ||
      proofEntries.some(([key, value]) => !runs.has(key) || !pyEq(proofOf(runs.get(key)), value))
    ) {
      reasons.push('released history no longer matches');
      continue;
    }
    const floors = pyGet(event, 'floors');
    if (
      !Array.isArray(floors) ||
      floors.length !== histories.length ||
      floors.some((n) => !isPyInt(n) || Number(n) < 0)
    ) {
      reasons.push('invalid release accounting');
      continue;
    }
    let releaseAt: bigint;
    try {
      releaseAt = pyTime(pyIndex(event, 'at'));
      if (lastRelease !== null && releaseAt <= lastRelease) {
        throw new PyError('ValueError', 'release order');
      }
    } catch (error) {
      if (!hasClass(error, 'KeyError', 'TypeError', 'ValueError')) throw error;
      reasons.push('invalid release chronology');
      continue;
    }
    baseline = floors;
    runs = runs.without((key) => Object.hasOwn(proofs, key as string));
    released = true;
    lastRelease = releaseAt;
  }
  const reset = maxMicros(resets);
  const failuresOf = (h: unknown): unknown => pyGetOr(h, 'failures', 0);
  if (
    histories.some((h, index) => {
      const value = failuresOf(h);
      return !isPyInt(value) || Number(value) < Number(baseline[index]);
    })
  ) {
    reasons.push('released counter floor missing or reduced');
  }
  if (reset !== null) {
    if (runs.values().some((value) => value.when === reset)) {
      reasons.push('failure and success chronology ambiguous');
    }
    if (released) {
      if (runs.values().some((value) => value.when === lastRelease && value.when < reset)) {
        reasons.push('failure and release chronology ambiguous');
      }
      const consumed = runs
        .pairs()
        .filter(
          ([key, value]) =>
            pyContains(seen, key) && lastRelease! < value.when && value.when < reset,
        ).length;
      baseline = histories.map((h, index) => {
        const value = failuresOf(h);
        return isPyInt(value)
          ? Math.min(Number(value), Number(baseline[index]) + consumed)
          : baseline[index];
      });
    }
    runs = runs.without((_key, value) => !(value.when > reset));
  }
  if (lastRelease !== null && runs.values().some((value) => value.when <= lastRelease!)) {
    reasons.push('failure predates or coincides with release but lacks release proof');
  }
  const ordered = runs.values().sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : 0));
  ordered.forEach((record, position) => {
    const seconds = Math.min(86_400, 3600 * 2 ** Math.min(position, 5));
    deadlines.push(record.when + BigInt(seconds) * SECONDS_MICROS);
  });
  const count = ordered.length;
  if (
    histories.some((h, index) => {
      const value = failuresOf(h);
      const floor = Number(baseline[index]);
      return !isPyInt(value) || Number(value) < floor || Number(value) - floor > count;
    })
  ) {
    reasons.push('unreconciled family aggregate');
  }
  if (histories.some((h) => pyTruthy(pyGet(h, 'quarantined'))) && !released) {
    reasons.push('persisted quarantine');
  }
  if (count >= 6) reasons.push('family failure limit');
  const deadline = maxMicros(deadlines);
  const sortedKeys = runs.keys().sort(pyCompare);
  const proofsOut: Record<string, unknown[]> = {};
  for (const [key, value] of runs.pairs()) proofsOut[pyStr(key)] = proofOf(value);
  return {
    allowed: reasons.length === 0 && (deadline === null || deadline <= pyTime(at)),
    failures: count,
    deadline: deadline === null ? null : pyIso(new UtcInstant(deadline)),
    reasons,
    runs: sortedKeys.map(pyStr),
    run_proofs: proofsOut,
  };
}

/** `coverage._legacy_retry_allowed(queue, pr, original_path, at)`. */
export function legacyRetryAllowed(
  queue: unknown,
  pr: unknown,
  originalPath: unknown,
  at: unknown,
): boolean {
  return legacyRetryView(queue, pr, originalPath, at).allowed;
}

export interface CoverageCandidateParams {
  readonly mergeQueueSha: string;
  readonly ordinaryEligible: unknown;
  readonly now: unknown;
  readonly maxPaths?: unknown;
  readonly minAgeHours?: unknown;
  readonly excludedPaths?: unknown;
}

interface Choice {
  readonly score: unknown[];
  readonly id: string;
  readonly path: string;
  readonly item: Dict;
  readonly aliases: Map<string, string[]>;
}

/** `coverage.coverage_candidate(queue, ledger, ...)`: one pending coverage item, or null. */
export function coverageCandidate(
  queue: unknown,
  ledger: unknown,
  params: CoverageCandidateParams,
): Dict | null {
  const maxPaths = params.maxPaths === undefined ? 8 : params.maxPaths;
  const minAgeHours = params.minAgeHours === undefined ? 24 : params.minAgeHours;
  const excludedPaths = params.excludedPaths === undefined ? [] : params.excludedPaths;
  if (pyNumber(maxPaths) < 1 || pyNumber(minAgeHours) < 0) {
    throw new PyError('ValueError', 'invalid coverage bounds');
  }
  if (pyTruthy(params.ordinaryEligible)) return null;
  const at = pyTime(params.now);
  const excluded = new Set(pyIter(excludedPaths).map(pyPath));
  const outstanding = items(queue).filter(
    (i) =>
      pyGet(i, 'kind') === 'coverage' && !['done', 'skipped'].includes(pyGet(i, 'state') as string),
  );
  const repairDebt = outstanding.filter(
    (i) =>
      ['repairing', 'repair_failed'].includes(pyGet(i, 'state') as string) &&
      pyIter(pyGetOr(i, 'cycles', [])).some(
        (c) =>
          pyContains(pyIndex(ledger, 'runs'), pyGet(c, 'run_id')) &&
          pyTruthy(pyGet(c, 'completed_at')),
      ),
  );
  for (const item of repairDebt) {
    for (const p of pyIter(pyGetOr(item, 'coverage_paths', []))) excluded.add(pyPath(p));
    const measure = pyGet(item, 'measure');
    for (const p of pyIter(pyGetOr(pyTruthy(measure) ? measure : {}, 'synthetic_paths', []))) {
      excluded.add(pyPath(p));
    }
  }
  const active = outstanding.filter(
    (i) =>
      !repairDebt.some((debt) => pyEq(debt, i)) &&
      (!['blocked', 'failed', 'quarantined'].includes(pyGet(i, 'state') as string) ||
        isExecutionOwnerPlain(i)),
  );
  if (active.length > 0) return null;
  const choices: Choice[] = [];
  for (const item of items(queue)) {
    const measureValue = pyGet(item, 'measure');
    const measure = pyTruthy(measureValue) ? measureValue : {};
    if (
      pyGet(item, 'kind') !== 'merged' ||
      !pyTruthy(pyGet(item, 'merge_commit')) ||
      !pyEq(pyGet(measure, 'merge_queue'), params.mergeQueueSha)
    ) {
      continue;
    }
    const byCurrent = new Map<string, string[]>();
    for (const file of pyIter(pyGetOr(measure, 'files', []))) {
      if (!pyTruthy(pyGet(file, 'now')) || !pyTruthy(pyGet(file, 'synthetic_added'))) continue;
      const path = pyPath(pyIndex(file, 'now'));
      if (excluded.has(path) || excluded.has(pyPath(pyIndex(file, 'path')))) continue;
      const entry = pyGetOr(pyIndex(ledger, 'paths'), path, {});
      const last = pyGet(entry, 'last_reviewed_at');
      if (pyTruthy(last) && Number(at - pyTime(last)) / 1e6 < pyNumber(minAgeHours) * 3600) {
        continue;
      }
      if (
        !legacyRetryAllowed(queue, pyIndex(item, 'pr'), pyIndex(file, 'path'), new UtcInstant(at))
      ) {
        continue;
      }
      const score = [
        isNone(last) ? 0 : 1,
        pyTruthy(last) ? Number(pyTime(last)) / 1e6 : 0,
        pyGetOr(entry, 'review_count', 0),
        path,
      ];
      const aliasList = byCurrent.get(path) ?? [];
      aliasList.push(pyPath(pyIndex(file, 'path')));
      byCurrent.set(path, aliasList);
      choices.push({
        score,
        id: pyStr(pyIndex(item, 'id')),
        path,
        item: item as Dict,
        aliases: byCurrent,
      });
    }
  }
  if (choices.length === 0) return null;
  choices.sort((a, b) => pyCompareTuples(a.score, b.score) || compareCodePoints(a.id, b.id));
  const first = choices[0] as Choice;
  const source = first.item;
  const region = pyParent(first.path);
  const selected: string[] = [];
  for (const choice of choices) {
    if (
      pyEq(pyIndex(choice.item, 'id'), pyIndex(source, 'id')) &&
      pyParent(choice.path) === region &&
      !selected.includes(choice.path)
    ) {
      selected.push(choice.path);
      if (selected.length === pyNumber(maxPaths)) break;
    }
  }
  const syntheticSet = new Set(selected);
  for (const path of selected)
    for (const alias of first.aliases.get(path) ?? []) syntheticSet.add(alias);
  const synthetic = [...syntheticSet].sort(compareCodePoints);
  const sourceId = pyIndex(source, 'id');
  if (typeof sourceId !== 'string') {
    throw new PyError(
      'TypeError',
      'can only concatenate str (not "' + typeof sourceId + '") to str',
    );
  }
  const token = createHash('sha256')
    .update(`${params.mergeQueueSha}\0${sourceId}\0${selected.join('\0')}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  const stem = `coverage-${token}`;
  const existing = new Set(items(queue).map((i) => pyHashKey(pyIndex(i, 'id'))));
  let id = stem;
  let suffix = 1;
  while (existing.has(pyHashKey(id))) {
    id = `${stem}-${suffix}`;
    suffix += 1;
  }
  const orders = items(queue).map((i) => pyGetOr(i, 'order', 0));
  const maxOrder = orders.length === 0 ? 0 : orders.map(pyNumber).reduce((a, b) => (b > a ? b : a));
  return {
    id,
    pr: pyIndex(source, 'pr'),
    kind: 'coverage',
    tier: COVERAGE_RANK,
    order: maxOrder + 1,
    state: 'pending',
    cycles: [],
    attempts: [],
    notes: [],
    merge_commit: pyIndex(source, 'merge_commit'),
    coverage_source: sourceId,
    coverage_sha: params.mergeQueueSha,
    coverage_paths: selected,
    coverage_region: region,
    created_at: pyIso(params.now),
    measure: { merge_queue: params.mergeQueueSha, synthetic_paths: synthetic },
  };
}
