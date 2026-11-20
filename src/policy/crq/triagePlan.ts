/**
 * Pure, injected dry-run candidate planning for the S5b inbox triage slice.
 *
 * This is the offline port of `crq_repair/triage.py`'s `phase(...,
 * dry_run=True)` up to, and excluding, the judge: it decides which triage
 * rows would be planned mechanically, which would need judgment, and what the
 * dry-run report says, from immutable inputs.
 *
 * What is ported, in Python's order:
 *
 * - age ordering: the retained event's `occurred_at`, else the target
 *   commit's committer date, then finding id, compared by code point;
 * - eligible status: pending (`untriaged`, `needs-retriage`), a stale
 *   `confirmed` row whose `target_current` is not the tip, and an
 *   `escalation` of a model-triaged `needs-human` row;
 * - the legacy missing-evidence admission into fixer investigation
 *   ({@link missingEvidence}, `triage.missing_evidence`);
 * - mechanical plans: a pathless finding, a path proven deleted at the tip,
 *   and an exact path/title/anchor duplicate of an earlier finding;
 * - the `maximum` plan limit and the wall-clock deadline, including every
 *   place Python reads the monotonic clock (the oracle pins the read count);
 * - candidate ordering (severity rank, age, id) and the bounded context
 *   preparation loop that fills `judgment_candidates` and `context_errors`.
 *
 * What is NOT ported (explicit later bindings, see "Residuals"):
 *
 * - the judge, `decision(...)`, the transport and delivery;
 * - `inbox.recover`, `inbox.triage`, `inbox.context_error`, `inbox.deliver`:
 *   no live ledger write exists in a dry run, and none exists here;
 * - `triage.context(...)` assembly (the packed prompt): it is an injected
 *   {@link TriageContextOutcome} seam;
 * - `inbox.recovered_anchor(...)`: an injected seam;
 * - reading `triage/*.json` and the retained reviews, and every Git read:
 *   all arrive as injected values or synchronous seams.
 *
 * Failure honesty (`repairSelection.ts` precedent):
 *
 * - Where Python raises an uncaught `KeyError`/`TypeError`/`AttributeError`
 *   on a structurally damaged row or retained event, this port throws a
 *   {@link TriagePlanRefusal}. Nothing is planned from a damaged inbox.
 * - Where Python is lenient about a type the ledger schema never produces
 *   (a non-string `severity`, `title`, `body`, `id`, `review_id`, `path` that
 *   is neither a string nor null), this port refuses instead. It never plans
 *   something Python would not.
 *
 * Residuals (documented, none changes a dry-run decision for a schema-valid
 * inbox):
 *
 * 1. `str.casefold()` is approximated by per-code-point upper-then-lower with
 *    the seven overrides that make the equality classes match CPython for
 *    every scalar value (`ı`, `ẞ`, Cherokee). It is only used to compare
 *    titles for the exact-duplicate key, never to emit text.
 * 2. The duplicate key compares the anchor blob and intervals by their Python
 *    JSON text rather than by Python value equality, which differs only for
 *    `1 == 1.0 == True`; the ledger refuses floats and non-int intervals.
 * 3. The set iteration order in which Python asks Git for target dates is
 *    arbitrary (string hashing); this port asks in row order. Results do not
 *    depend on it, and the oracle sorts that run.
 * 4. Non-dry-run behaviour (recovery, writes, escalation actor names, the
 *    judge and delivery loop) is intentionally absent; calling this is always
 *    a dry run and the report says `dryRun: true`.
 */
import { JsonObject, type JsonValue } from './jsonValue.js';
import { compareCodePoints, pythonJsonText } from './pythonJson.js';
import { pythonIsSpace, pythonStrip, pythonTruthy } from './repairBinding.js';

/** `triage.PENDING`. */
const PENDING: readonly string[] = ['untriaged', 'needs-retriage'];

/** Statuses that never become the canonical id of a later duplicate. */
const SETTLED: readonly string[] = ['already-fixed', 'fixed', 'dismissed', 'superseded'];

/** `phase`'s defaults. */
export const TRIAGE_DEFAULT_MAXIMUM = 6;
export const TRIAGE_DEFAULT_SECONDS = 600;

/** `phase` never reads more than this prefix of an exception class name. */
const ERROR_TYPE_LIMIT = 80;

const INVESTIGATION_PREFIX = 'fixer investigation: ';

/** A damaged row or retained event where Python would raise uncaught. */
export class TriagePlanRefusal extends Error {
  override readonly name = 'TriagePlanRefusal';
}

/** The Git facts the planner reads; synchronous by contract, like the drain's. */
export interface TriageRepo {
  /** `repo.begin_invocation()`. */
  beginInvocation(): void;
  /** `git show -s --format=%cI <target>`, as the caller read it. */
  commitDate(target: string): string;
  /** The paths of `repo.entries(tip)`; only membership is read. */
  entryPaths(tip: string): ReadonlySet<string>;
  /** `repo.lineage(target, tip, path)`: the mapped path, or null. */
  lineage(target: string, tip: string, path: string): string | null;
  /** `repo.proven_deleted(target, tip, path)`. */
  provenDeleted(target: string, tip: string, path: string): boolean;
  /** `git log -1 --format=%H --diff-filter=D <tip> -- <path>`, as the caller read it. */
  deletingCommit(tip: string, path: string): string;
}

/** What `triage.context(...)` did for one candidate row. */
export type TriageContextOutcome =
  | { readonly kind: 'ready' }
  /**
   * A failure `phase` catches (`KeyError`, `TypeError`, `ValueError`,
   * `IntegrityError`, `CalledProcessError`, `TimeoutExpired`, `OSError`); the
   * binding supplies the Python class name. Any other failure must throw.
   */
  | { readonly kind: 'error'; readonly errorType: string };

export interface TriageContextRequest {
  readonly row: JsonObject;
  readonly tip: string;
  /** Python's `row['_escalate']`. */
  readonly escalate: boolean;
  /** The recovered anchor `phase` attached to the row, if any. */
  readonly recoveredAnchor: JsonObject | null;
}

export interface TriagePlanInput {
  /** `ledger.loads` of `triage/*.json`, in `sorted(glob)` file-name order. */
  readonly rows: readonly JsonObject[];
  /** `inbox.publication.retained()`. */
  readonly reviews: readonly JsonValue[];
  readonly tip: string;
  /** `maximum`, default {@link TRIAGE_DEFAULT_MAXIMUM}. */
  readonly maximum?: number;
  /** `seconds`, default {@link TRIAGE_DEFAULT_SECONDS}. */
  readonly seconds?: number;
  /** `time.monotonic()`; every read Python makes is made here, in order. */
  readonly clock: () => number;
  readonly repo: TriageRepo;
  /**
   * `inbox.recovered_anchor(row, repo, reviews)`. Absent mirrors an inbox
   * without the attribute (Python's `hasattr` guard).
   */
  readonly recoverAnchor?: (
    row: JsonObject,
    reviews: readonly JsonValue[],
  ) => JsonObject | null | undefined;
  readonly prepareContext: (request: TriageContextRequest) => TriageContextOutcome;
}

/** The kwargs of Python's plan tuple, which a later non-dry-run slice consumes. */
export interface TriagePlanEvidence {
  readonly failureClass?: 'evidence';
  readonly fixingCommit?: string;
  readonly canonicalId?: string;
}

/** One `(row, action, reason, kwargs)` plan. */
export interface TriagePlan {
  readonly findingId: string;
  readonly action: 'confirmed' | 'needs-human' | 'superseded' | 'duplicate';
  readonly reason: string;
  readonly evidence: TriagePlanEvidence;
  readonly escalate: boolean;
}

export interface TriageContextError {
  readonly findingId: string;
  readonly type: string;
  readonly target: string;
}

/** The dry-run report, field for field `phase(..., dry_run=True)`'s result. */
export interface TriagePlanReport {
  readonly total: number;
  readonly judged: number;
  readonly unjudged: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly delivered: 0;
  readonly deliveryDeferred: 0;
  readonly contextErrors: readonly TriageContextError[];
  /** Always empty in a dry run: no judge ran. */
  readonly stopReport: Readonly<Record<string, never>>;
  readonly stopped: 'deadline' | null;
  readonly dryRun: true;
  readonly judgmentCandidates: readonly string[];
  readonly outcomes: readonly { findingId: string; action: string; reason: string }[];
}

export interface TriagePlanResult {
  readonly report: TriagePlanReport;
  readonly plans: readonly TriagePlan[];
}

function refuse(message: string): never {
  throw new TriagePlanRefusal(message);
}

function asObject(value: JsonValue | undefined, what: string): JsonObject {
  if (!(value instanceof JsonObject)) refuse(`${what} is not an object`);
  return value;
}

function requireString(object: JsonObject, key: string, what: string): string {
  const value = object.get(key);
  if (typeof value !== 'string') refuse(`${what} ${key} is not a string`);
  return value;
}

/** `triage.missing_evidence`'s three patterns; Python's `.` excludes only `\n`. */
const MISSING_EVIDENCE_EXCLUDED =
  /secret|scan|dispatch|invalid|budget|timeout|timed out|provider|rate[^\n]limit/iu;
const MISSING_EVIDENCE_WANTED =
  /(?:missing|insufficient|lack|need|unavailable|not provided)[^\n]*?(?:source|context|evidence)|(?:source|context|evidence)[^\n]*?(?:missing|insufficient|unavailable|not provided)/iu;

/** `triage.missing_evidence`: a legacy judgment that lacked source evidence. */
export function missingEvidence(reason: JsonValue | undefined): boolean {
  return (
    typeof reason === 'string' &&
    !reason.startsWith('fixer investigation:') &&
    !MISSING_EVIDENCE_EXCLUDED.test(reason) &&
    MISSING_EVIDENCE_WANTED.test(reason)
  );
}

/** `' '.join(text.split())`: Python whitespace splitting over code points. */
function collapseWhitespace(text: string): string {
  const words: string[] = [];
  let word = '';
  for (const character of text) {
    if (pythonIsSpace(character.codePointAt(0) as number)) {
      if (word !== '') words.push(word);
      word = '';
    } else {
      word += character;
    }
  }
  if (word !== '') words.push(word);
  return words.join(' ');
}

/**
 * `str.casefold()` as an equality-preserving fold. Upper-then-lower per code
 * point matches CPython except for the overrides below (verified over every
 * non-surrogate scalar value against CPython 3.15).
 */
function casefold(text: string): string {
  let folded = '';
  for (const character of text) {
    const code = character.codePointAt(0) as number;
    if (code === 0x131) folded += character;
    else if (code === 0x1e9e) folded += 'ss';
    else if (code >= 0x13a0 && code <= 0x13f5) folded += character;
    else if (code >= 0x13f8 && code <= 0x13fd) folded += String.fromCodePoint(code - 8);
    else if (code >= 0xab70 && code <= 0xabbf) {
      folded += String.fromCodePoint(code - 0xab70 + 0x13a0);
    } else folded += character.toUpperCase().toLowerCase();
  }
  return folded;
}

function jsonText(value: JsonValue | undefined): string {
  return pythonJsonText(value === undefined ? null : value, {
    asciiOnly: true,
    sortKeys: false,
    spacedSeparators: true,
  });
}

/** `row.get('recovered_anchor') or finding`; `recovered` is only ever truthy. */
function anchorOf(recovered: JsonObject | null, finding: JsonObject): JsonObject {
  return recovered ?? finding;
}

interface PlanRow {
  readonly raw: JsonObject;
  readonly finding: JsonObject;
  readonly id: string;
  readonly status: JsonValue | undefined;
  readonly severity: string;
  readonly reviewId: string;
  recovered: JsonObject | null;
  escalate: boolean;
  /** The age sort key, set after the retained dates are known. */
  age: string;
}

function planRow(raw: JsonObject): PlanRow {
  const finding = asObject(raw.get('finding'), 'row finding');
  if (!raw.has('status')) refuse('row has no status');
  return {
    raw,
    finding,
    id: requireString(finding, 'id', 'finding'),
    status: raw.get('status'),
    severity: requireString(finding, 'severity', 'finding'),
    reviewId: requireString(raw, 'review_id', 'row'),
    // A persisted row may already carry its recovered anchor; `phase` reads
    // `row.get('recovered_anchor') or finding` whether or not it recovers.
    recovered: pythonTruthy(raw.get('recovered_anchor'))
      ? asObject(raw.get('recovered_anchor'), 'row recovered_anchor')
      : null,
    escalate: false,
    age: '',
  };
}

function targetOf(row: PlanRow): string {
  return requireString(row.raw, 'target', 'row');
}

/** `prior.get(key)` where Python's `prior` must be a dict. */
function priorGet(prior: JsonValue | undefined, key: string): JsonValue | undefined {
  if (!(prior instanceof JsonObject)) refuse('retained event payload is not an object');
  return prior.get(key);
}

/** `str(prior.get('actor', '')).startswith(prefix)`; only a string can match. */
function actorStartsWith(prior: JsonValue | undefined, prefix: string): boolean {
  const actor = priorGet(prior, 'actor');
  return typeof actor === 'string' && actor.startsWith(prefix);
}

/** `prior.get('evidence', {})`, which Python then calls `.get` on. */
function evidenceOf(prior: JsonValue | undefined): JsonObject {
  const evidence = priorGet(prior, 'evidence');
  if (evidence === undefined) return new JsonObject([]);
  return asObject(evidence, 'retained event evidence');
}

/**
 * `triage.phase(inbox, repo, tip, judge, transport, at, dry_run=True)` without
 * the judge: candidate planning and the dry-run report.
 */
export function planTriageDryRun(input: TriagePlanInput): TriagePlanResult {
  const { repo, tip, clock } = input;
  const maximum = input.maximum ?? TRIAGE_DEFAULT_MAXIMUM;
  const seconds = input.seconds ?? TRIAGE_DEFAULT_SECONDS;
  const deadline = clock() + seconds;
  repo.beginInvocation();

  const rows = input.rows.map(planRow);
  const reviews = input.reviews;
  const events = new Map<string, JsonObject>();
  const dates = new Map<string, JsonValue | undefined>();
  for (const review of reviews) {
    const record = asObject(review, 'retained review');
    const id = requireString(record, 'id', 'retained review');
    if (record.get('event_type') === 'finding-event') events.set(id, record);
    dates.set(id, record.has('occurred_at') ? record.get('occurred_at') : '');
  }

  for (const row of rows) {
    if (
      clock() < deadline &&
      row.finding.get('anchor_status') !== 'verified' &&
      (PENDING.includes(row.status as string) || row.status === 'confirmed') &&
      input.recoverAnchor !== undefined
    ) {
      const recovered = input.recoverAnchor(row.raw, reviews);
      if (recovered !== null && recovered !== undefined && pythonTruthy(recovered)) {
        row.recovered = asObject(recovered, 'recovered anchor');
      }
    }
  }

  const retainedAge = (row: PlanRow): string | null => {
    const value = dates.get(row.reviewId);
    if (!pythonTruthy(value)) return null;
    if (typeof value !== 'string') refuse('retained review occurred_at is not a string');
    return value;
  };
  const targetDates = new Map<string, string>();
  for (const row of rows) {
    if (retainedAge(row) !== null) continue;
    const target = targetOf(row);
    if (!targetDates.has(target)) targetDates.set(target, pythonStrip(repo.commitDate(target)));
  }
  for (const row of rows) {
    row.age = retainedAge(row) ?? (targetDates.get(targetOf(row)) as string);
  }
  rows.sort((a, b) => compareCodePoints(a.age, b.age) || compareCodePoints(a.id, b.id));

  const entries = repo.entryPaths(tip);
  const seen = new Map<string, string>();
  const plans: TriagePlan[] = [];
  const candidates: PlanRow[] = [];

  for (const row of rows) {
    const finding = row.finding;
    const anchor = anchorOf(row.recovered, finding);
    const path = finding.get('path');
    if (path === undefined) refuse('finding has no path key');
    if (path !== null && typeof path !== 'string')
      refuse('finding path is neither a string nor null');
    const body = requireString(finding, 'body', 'finding');
    const title = requireString(finding, 'title', 'finding');
    // An empty/unknown anchor is never evidence for an exact duplicate.
    const anchored = pythonTruthy(anchor.get('intervals')) && pythonTruthy(anchor.get('blob'));
    const key = JSON.stringify([
      row.severity,
      path,
      jsonText(anchor.get('blob')),
      body,
      casefold(collapseWhitespace(title)),
      jsonText(anchor.get('intervals')),
    ]);
    const canonical = anchored ? seen.get(key) : undefined;
    if (row.status === 'duplicate') continue;
    if (anchored && !SETTLED.includes(row.status as string)) {
      if (!seen.has(key)) seen.set(key, row.id);
    }
    const previousEventId = row.raw.get('previous_event_id');
    if (Array.isArray(previousEventId) || previousEventId instanceof JsonObject) {
      refuse('row previous_event_id is not a scalar');
    }
    const prior: JsonValue | undefined =
      typeof previousEventId === 'string' && events.has(previousEventId)
        ? (events.get(previousEventId) as JsonObject).has('payload')
          ? (events.get(previousEventId) as JsonObject).get('payload')
          : new JsonObject([])
        : new JsonObject([]);

    const investigate =
      row.status === 'needs-human' &&
      actorStartsWith(prior, 'crq-triage/') &&
      !pythonTruthy(evidenceOf(prior).get('failure_class')) &&
      missingEvidence(evidenceOf(prior).get('reason'));
    if (investigate && (plans.length >= maximum || clock() >= deadline)) continue;
    if (investigate && plans.length < maximum && clock() < deadline) {
      plans.push({
        findingId: row.id,
        action: 'confirmed',
        reason: INVESTIGATION_PREFIX + (evidenceOf(prior).get('reason') as string),
        evidence: { failureClass: 'evidence' },
        escalate: row.escalate,
      });
      continue;
    }
    const escalation =
      row.status === 'needs-human' &&
      actorStartsWith(prior, 'crq-triage/') &&
      priorGet(prior, 'actor') !== 'crq-triage/delivery' &&
      !(priorGet(prior, 'actor') as string).startsWith('crq-triage/escalation/');
    if (
      !PENDING.includes(row.status as string) &&
      !escalation &&
      !(row.status === 'confirmed' && row.raw.get('target_current') !== tip)
    ) {
      continue;
    }
    if (escalation) row.escalate = true;
    if (typeof path !== 'string' || path === '') {
      plans.push({
        findingId: row.id,
        action: 'needs-human',
        reason: 'finding has no repository path',
        evidence: { failureClass: 'evidence' },
        escalate: row.escalate,
      });
      continue;
    }
    if (clock() >= deadline) {
      candidates.push(row);
      continue;
    }
    const target = targetOf(row);
    const mapped = repo.lineage(target, tip, path);
    if (mapped === null && !entries.has(path) && repo.provenDeleted(target, tip, path)) {
      const deletion = pythonStrip(repo.deletingCommit(tip, path));
      plans.push({
        findingId: row.id,
        action: 'superseded',
        reason: `path absent at promoted tip ${tip}; deleting commit ${deletion}`,
        evidence: deletion === '' ? {} : { fixingCommit: deletion },
        escalate: row.escalate,
      });
    } else if (canonical !== undefined && canonical !== '') {
      plans.push({
        findingId: row.id,
        action: 'duplicate',
        reason: 'exact path/title/anchor duplicate',
        evidence: { canonicalId: canonical },
        escalate: row.escalate,
      });
    } else {
      candidates.push(row);
    }
  }

  const severityRank = (row: PlanRow): number =>
    row.severity === 'critical' ? 0 : row.severity === 'major' ? 1 : 2;
  candidates.sort(
    (a, b) =>
      severityRank(a) - severityRank(b) ||
      compareCodePoints(a.age, b.age) ||
      compareCodePoints(a.id, b.id),
  );
  const investigationAdmissions = plans.filter((plan) =>
    plan.reason.startsWith(INVESTIGATION_PREFIX),
  ).length;

  let judged = 0;
  let stopped: 'deadline' | null = null;
  const contextErrors: TriageContextError[] = [];
  const judgmentCandidates: string[] = [];
  for (const row of candidates) {
    if (judged + investigationAdmissions >= maximum) break;
    if (clock() >= deadline) {
      stopped = 'deadline';
      break;
    }
    const outcome = input.prepareContext({
      row: row.raw,
      tip,
      escalate: row.escalate,
      recoveredAnchor: row.recovered,
    });
    if (outcome.kind === 'error') {
      // Leave this row pending; another row's context can still be valid.
      contextErrors.push({
        findingId: row.id,
        type: Array.from(outcome.errorType).slice(0, ERROR_TYPE_LIMIT).join(''),
        target: tip,
      });
      continue;
    }
    // A dry run reports the candidates that would need judgment; honour the
    // deadline after context preparation, as the live path does.
    if (clock() >= deadline) {
      stopped = 'deadline';
      break;
    }
    judgmentCandidates.push(row.id);
    judged += 1;
  }

  const counts: Record<string, number> = {};
  for (const plan of plans) counts[plan.action] = (counts[plan.action] ?? 0) + 1;
  return {
    plans,
    report: {
      total: rows.length,
      judged,
      unjudged: candidates.length - judged,
      counts,
      delivered: 0,
      deliveryDeferred: 0,
      contextErrors,
      stopReport: {},
      stopped,
      dryRun: true,
      judgmentCandidates,
      outcomes: plans.map((plan) => ({
        findingId: plan.findingId,
        action: plan.action,
        reason: plan.reason,
      })),
    },
  };
}
