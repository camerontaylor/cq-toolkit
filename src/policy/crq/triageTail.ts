/**
 * Offline port of the triage phase tail: `crq_repair/triage.py` `phase(...)`
 * from the candidate judgment loop to the report (lines ~236-322).
 *
 * What is ported, in Python's order:
 *
 * - the bounded candidate loop: `maximum`/deadline gates, context preparation
 *   with its caught-failure bookkeeping (`inbox.context_error`), the dry-run
 *   candidate listing, and the judge call with its three caught failure
 *   families (timeout, context-scan, `OSError`/`RuntimeError`);
 * - judge-report handling: a non-`ok` stop (including the `output-invalid`
 *   error that becomes a `needs-human` plan), `triage.decision`, and the
 *   invalid-canonical rewrite of a `duplicate-of` verdict;
 * - plan application through `inbox.triage` (actor naming, the
 *   `failure_class` default, the lost-race `None` skip, and the recorded
 *   event's action replacing the planned one);
 * - the delivery loop over the re-read `triage/*.json` rows, with
 *   `RepairRoundCeiling` demoted to `needs-human` and the
 *   `RuntimeError`/`OSError`/`ValueError` deferral;
 * - the report dict, field for field.
 *
 * What is NOT ported: the head of `phase` (recovery, age ordering, mechanical
 * plans, candidate selection; see `triagePlan.ts`, which supplies `plans` and
 * `candidates` here as plain inputs), `triage.context(...)` assembly, the
 * judge dispatch, `Inbox.deliver` and the transport (slice 4). Every one is an
 * injected seam; nothing here routes, writes or delivers anything.
 *
 * Failure honesty (`triageDecision.ts` precedent):
 *
 * - Seams signal a Python exception by throwing {@link TriageInjectedFailure}
 *   carrying the class name (or {@link TriageJudgeTimeout},
 *   {@link RepairRoundCeilingError}, `ContextScanError`). This module catches
 *   exactly the classes Python catches, subclasses included, and lets every
 *   other throw propagate, as Python does.
 * - Where Python would raise an uncaught `KeyError`/`AttributeError`/
 *   `TypeError` on a damaged row, report or event, this port throws a
 *   {@link TriageTailRefusal}. Effects already applied stay applied, exactly
 *   as in Python: plans are applied one at a time.
 *
 * Residuals (none changes an outcome for a ledger-valid row):
 *
 * 1. A recorded event's `payload.action` must be a string; Python would also
 *    accept another hashable scalar and `Counter` it. This port refuses.
 * 2. `counts` is an ordered entry list (Python `dict` insertion order).
 * 3. Non-string `row['_triage_model']` (a judge `model` that is not a string)
 *    raises `TypeError` in Python when the actor is built; so does this port,
 *    after the plans before it have been applied.
 */
import { JsonObject, type JsonValue } from './jsonValue.js';
import {
  LedgerIntegrityError,
  LedgerJsonDecodeError,
  LedgerTimestampError,
  LedgerUnicodeDecodeError,
} from './ledger.js';
import { ContextScanError, errorReason } from './triageContextScan.js';
import { triageDecision, type TriageDecisionRepo } from './triageDecision.js';

/** `finding_delivery.RepairRoundCeiling` (a `RuntimeError`). */
export class RepairRoundCeilingError extends Error {
  override readonly name = 'RepairRoundCeilingError';
}

/** `subprocess.TimeoutExpired` from the judge. */
export class TriageJudgeTimeout extends Error {
  override readonly name = 'TriageJudgeTimeout';
}

/** A Python exception raised by an injected seam; `pythonType` is its class. */
export class TriageInjectedFailure extends Error {
  override readonly name = 'TriageInjectedFailure';
  readonly pythonType: string;

  constructor(pythonType: string, message = '') {
    super(message);
    this.pythonType = pythonType;
  }
}

/** Python would raise an uncaught `KeyError`/`AttributeError`/`TypeError`. */
export class TriageTailRefusal extends Error {
  override readonly name = 'TriageTailRefusal';
}

const OS_ERRORS = [
  'OSError',
  'IOError',
  'EnvironmentError',
  'FileNotFoundError',
  'FileExistsError',
  'PermissionError',
  'IsADirectoryError',
  'NotADirectoryError',
  'TimeoutError',
  'ConnectionError',
  'BrokenPipeError',
  'ConnectionResetError',
  'ConnectionRefusedError',
  'ConnectionAbortedError',
  'InterruptedError',
  'ChildProcessError',
  'ProcessLookupError',
  'BlockingIOError',
];
const RUNTIME_ERRORS = [
  'RuntimeError',
  'NotImplementedError',
  'RecursionError',
  'RepairRoundCeiling',
  'ContextScanError',
];
const VALUE_ERRORS = [
  'ValueError',
  'UnicodeError',
  'UnicodeDecodeError',
  'UnicodeEncodeError',
  'IntegrityError',
  'JSONDecodeError',
];

function injectedIn(error: unknown, classes: readonly string[]): boolean {
  return error instanceof TriageInjectedFailure && classes.includes(error.pythonType);
}

/** A ledger error that is a Python `ValueError` subclass. */
function isLedgerValueError(error: unknown): boolean {
  return (
    error instanceof LedgerIntegrityError ||
    error instanceof LedgerJsonDecodeError ||
    error instanceof LedgerTimestampError ||
    error instanceof LedgerUnicodeDecodeError
  );
}

/** `except (OSError, RuntimeError)` around the judge call. */
function isJudgeFailure(error: unknown): boolean {
  return (
    error instanceof RepairRoundCeilingError || injectedIn(error, [...OS_ERRORS, ...RUNTIME_ERRORS])
  );
}

/** `except (OSError, ValueError, KeyError)` around `inbox.context_error`. */
function isContextErrorWriteFailure(error: unknown): boolean {
  return (
    isLedgerValueError(error) || injectedIn(error, [...OS_ERRORS, ...VALUE_ERRORS, 'KeyError'])
  );
}

/** `except (RuntimeError, OSError, ValueError)` around `inbox.deliver`. */
function isDeliveryFailure(error: unknown): boolean {
  return (
    isLedgerValueError(error) ||
    // `ContextScanError` is a Python `RuntimeError`, whether dedicated or injected.
    error instanceof ContextScanError ||
    injectedIn(error, [...OS_ERRORS, ...RUNTIME_ERRORS, ...VALUE_ERRORS])
  );
}

function refuse(message: string): never {
  throw new TriageTailRefusal(message);
}

/** A loaded triage row plus the flags `phase` attaches to it. */
export interface TriageTailRow {
  readonly row: JsonObject;
  /** Python's `row['_escalate']`. */
  readonly escalate: boolean;
}

/** One `(row, action, reason, kwargs)` plan, in Python's key order. */
export interface TriageTailPlan {
  readonly row: TriageTailRow;
  readonly action: string;
  readonly reason: string;
  readonly kwargs: JsonObject;
}

/** What `triage.context(...)` did for one candidate. */
export type TriageTailContext =
  | { readonly kind: 'ready'; readonly packed: JsonValue }
  /** A failure `phase` catches; any other failure must throw. */
  | { readonly kind: 'error'; readonly errorType: string };

export interface TriageTailJudgeRequest {
  readonly row: JsonObject;
  readonly packed: JsonValue;
  /** `deadline - time.monotonic()`, strictly positive. */
  readonly remaining: number;
  readonly escalate: boolean;
}

/** The `inbox` surface the tail uses; slices 3 and 4 supply the real one. */
export interface TriageTailInbox<TTransport> {
  /** `inbox.context_error(fid, expected_previous_event_id, error|None)`. */
  contextError(findingId: string, previousEventId: JsonValue, error: JsonValue): Promise<boolean>;
  /**
   * `inbox.triage(fid, repo, tip, action, actor, reason, at, **kwargs,
   * expected_previous_event_id=...)`. `kwargs` is Python's keyword dict in
   * order (the `failure_class` default already applied); null is `None`.
   */
  triage(call: {
    readonly findingId: string;
    readonly action: string;
    readonly actor: string;
    readonly reason: string;
    readonly at: string;
    readonly kwargs: JsonObject;
    readonly expectedPreviousEventId: JsonValue;
  }): Promise<JsonObject | null>;
  /**
   * `ledger.loads(path.read_bytes())` for each of `sorted((inbox.root / 'triage').glob('*.json'))`.
   * The sorted listing is taken once, but each file is read only when the
   * delivery loop reaches it, so earlier deliveries run (and may rewrite later
   * files) before a later unreadable file throws.
   */
  readTriageRows(): AsyncIterable<JsonValue>;
  /** `inbox.deliver(fid, transport, at)`. */
  deliver(findingId: string, transport: TTransport, at: string): Promise<unknown>;
}

export interface TriageTailInput<TTransport> {
  /** Every loaded row (`phase`'s `rows`): `total` and the canonical check. */
  readonly rows: readonly JsonObject[];
  /** The mechanical plans the head produced, in order. */
  readonly plans: readonly TriageTailPlan[];
  /** The sorted judgment candidates the head produced. */
  readonly candidates: readonly TriageTailRow[];
  readonly tip: string;
  readonly at: string;
  readonly maximum: number;
  /** `time.monotonic() + seconds`, fixed by the head. */
  readonly deadline: number;
  readonly clock: () => number;
  readonly dryRun: boolean;
  readonly inbox: TriageTailInbox<TTransport>;
  readonly transport: TTransport;
  readonly decisionRepo: TriageDecisionRepo;
  readonly prepareContext: (row: TriageTailRow) => Promise<TriageTailContext> | TriageTailContext;
  /** The judge; throws {@link TriageJudgeTimeout}, `ContextScanError` or an injected failure. */
  readonly judge: (request: TriageTailJudgeRequest) => Promise<JsonValue> | JsonValue;
}

export interface TriageTailContextError {
  readonly findingId: string;
  readonly type: string;
  readonly target: string;
}

export interface TriageTailOutcome {
  readonly findingId: string;
  readonly action: string;
  readonly reason: string;
}

/** `phase`'s result dict. */
export interface TriageTailReport {
  readonly total: number;
  readonly judged: number;
  readonly unjudged: number;
  readonly counts: ReadonlyArray<readonly [string, number]>;
  readonly delivered: number;
  readonly deliveryDeferred: number;
  readonly contextErrors: readonly TriageTailContextError[];
  /** The stop report dict: `{}`, a synthesized stop, or the judge's own report. */
  readonly stopReport: JsonValue;
  /** `stopped`: a string, or whatever `report.get('stop', 'error')` held. */
  readonly stopped: JsonValue;
  readonly dryRun: boolean;
  readonly judgmentCandidates: readonly string[];
  readonly outcomes: readonly TriageTailOutcome[];
}

/** `row['finding']['id']`. */
function findingId(row: JsonObject): string {
  const finding = row.get('finding');
  if (!(finding instanceof JsonObject)) refuse('row finding is not an object');
  const id = finding.get('id');
  if (typeof id !== 'string') refuse('row finding id is not a string');
  return id;
}

function rowKey(row: JsonObject, key: string): JsonValue {
  const value = row.get(key);
  if (value === undefined) refuse(`row has no ${key}`);
  return value;
}

function object(entries: ReadonlyArray<readonly [string, JsonValue]>): JsonObject {
  return new JsonObject(entries);
}

const EXHAUSTED = (): JsonObject => object([['failure_class', 'exhausted']]);
const EVIDENCE = (): JsonObject => object([['failure_class', 'evidence']]);

/** Python `dict.setdefault('failure_class', 'evidence')` followed by `**kwargs`. */
function withFailureDefault(kwargs: JsonObject): JsonObject {
  return kwargs.has('failure_class')
    ? kwargs
    : new JsonObject([...kwargs.entries, ['failure_class', 'evidence']]);
}

/**
 * The triage phase tail. Rejects with {@link TriageTailRefusal} where Python
 * raises uncaught on a damaged value; propagates every non-caught seam failure.
 */
export async function triagePhaseTail<TTransport>(
  input: TriageTailInput<TTransport>,
): Promise<TriageTailReport> {
  const { tip, at, deadline, clock, dryRun, inbox } = input;
  const plans: TriageTailPlan[] = [...input.plans];
  // `row['_triage_model']` lives on the row in Python; key it by row object.
  const models = new Map<JsonObject, JsonValue>();

  const investigationAdmissions = plans.filter((plan) =>
    plan.reason.startsWith('fixer investigation:'),
  ).length;
  let judged = 0;
  let stopped: JsonValue = null;
  let stopReport: JsonValue = object([]);
  const contextErrors: TriageTailContextError[] = [];
  const judgmentCandidates: string[] = [];

  for (const candidate of input.candidates) {
    const { row } = candidate;
    if (judged + investigationAdmissions >= input.maximum) break;
    if (clock() >= deadline) {
      stopped = 'deadline';
      break;
    }
    const id = findingId(row);
    const context = await input.prepareContext(candidate);
    if (context.kind === 'error') {
      // Leave this row pending; another row's context can still be valid.
      const error = object([
        ['type', [...context.errorType].slice(0, 80).join('')],
        ['target', tip],
      ]);
      contextErrors.push({
        findingId: id,
        type: [...context.errorType].slice(0, 80).join(''),
        target: tip,
      });
      // Python evaluates `row['previous_event_id']` inside the try: a missing
      // key is the caught KeyError, so the call is never made.
      const previous = row.get('previous_event_id');
      if (!dryRun && previous !== undefined) {
        try {
          await inbox.contextError(id, previous, error);
        } catch (failure) {
          if (!isContextErrorWriteFailure(failure)) throw failure;
        }
      }
      continue;
    }
    if (!dryRun) {
      const previous = row.get('previous_event_id');
      if (previous === undefined) continue;
      try {
        if (!(await inbox.contextError(id, previous, null))) continue;
      } catch (failure) {
        if (isContextErrorWriteFailure(failure)) continue;
        throw failure;
      }
    }
    if (dryRun) {
      if (clock() >= deadline) {
        stopped = 'deadline';
        break;
      }
      judgmentCandidates.push(id);
      judged += 1;
      continue;
    }
    let report: JsonValue;
    try {
      const remaining = deadline - clock();
      if (remaining <= 0) {
        stopped = 'deadline';
        break;
      }
      report = await input.judge({
        row,
        packed: context.packed,
        remaining,
        escalate: candidate.escalate,
      });
    } catch (failure) {
      if (failure instanceof TriageJudgeTimeout || injectedIn(failure, ['TimeoutExpired'])) {
        stopped = 'deferred';
        stopReport = object([
          ['stop', 'deferred'],
          ['errorClass', 'timeout'],
        ]);
        break;
      }
      if (failure instanceof ContextScanError || injectedIn(failure, ['ContextScanError'])) {
        stopped = 'deferred';
        stopReport = object([
          ['stop', 'deferred'],
          ['errorClass', 'context-scan'],
          // An injected failure carries the cause text; Python normalizes it in the constructor.
          [
            'reason',
            failure instanceof ContextScanError
              ? failure.reason
              : errorReason((failure as Error).message, 'str'),
          ],
        ]);
        break;
      }
      if (isJudgeFailure(failure)) {
        const error = failure as Error;
        const pythonType =
          failure instanceof TriageInjectedFailure ? failure.pythonType : 'RepairRoundCeiling';
        stopped = 'deferred';
        stopReport = object([
          ['stop', 'deferred'],
          ['errorClass', 'judge-error'],
          ['reason', errorReason(error.message, pythonType)],
        ]);
        break;
      }
      throw failure;
    }
    if (!(report instanceof JsonObject)) refuse('judge report is not an object (AttributeError)');
    const stop = report.get('stop');
    if (stop !== 'ok') {
      if (stop === 'error' && report.get('errorClass') === 'output-invalid') {
        models.set(row, modelOf(report));
        const stage = candidate.escalate ? 'escalation' : 'judge';
        plans.push({
          row: candidate,
          action: 'needs-human',
          reason: `${stage} returned invalid structured output`,
          kwargs: EXHAUSTED(),
        });
        judged += 1;
        continue;
      }
      stopped = report.has('stop') ? (stop as JsonValue) : 'error';
      stopReport = report;
      break;
    }
    models.set(row, modelOf(report));
    const decided = triageDecision(input.decisionRepo, row, tip, report);
    let action = decided.status;
    let reason = decided.reason;
    let kwargs = decided.extras;
    if (action === 'duplicate') {
      const canonical = kwargs.get('canonical_id');
      const valid =
        canonical !== id &&
        input.rows.some(
          (other) =>
            findingValue(other, 'id') === canonical && rowKey(other, 'status') !== 'duplicate',
        );
      if (!valid) {
        action = 'needs-human';
        reason = 'judge supplied invalid canonical finding';
        kwargs = EVIDENCE();
      }
    }
    plans.push({ row: candidate, action, reason, kwargs });
    judged += 1;
  }

  const outcomes: TriageTailOutcome[] = [];
  for (const plan of plans) {
    const id = findingId(plan.row.row);
    let action = plan.action;
    if (!dryRun) {
      const model = models.has(plan.row.row) ? models.get(plan.row.row) : 'deterministic';
      if (typeof model !== 'string') refuse('judge model is not a string (TypeError)');
      const actor = `crq-triage/${plan.row.escalate ? 'escalation/' : ''}${model}`;
      const kwargs = withFailureDefault(plan.kwargs);
      const event = await inbox.triage({
        findingId: id,
        action: plan.action,
        actor,
        reason: plan.reason,
        at,
        kwargs,
        expectedPreviousEventId: rowKey(plan.row.row, 'previous_event_id'),
      });
      if (event === null) continue; // Operator/recovery changed the row during model judgment.
      const payload = event.get('payload');
      if (!(payload instanceof JsonObject)) refuse('triage event has no payload');
      const recorded = payload.get('action');
      if (typeof recorded !== 'string') refuse('triage event action is not a string');
      action = recorded;
    }
    outcomes.push({ findingId: id, action, reason: plan.reason });
  }

  let delivered = 0;
  let deliveryDeferred = 0;
  if (!dryRun) {
    for await (const row of inbox.readTriageRows()) {
      // `ledger.loads` accepts any JSON value; `row['status']` on a non-object raises TypeError.
      if (!(row instanceof JsonObject)) refuse('triage row is not an object (TypeError)');
      if (
        rowKey(row, 'status') === 'confirmed' &&
        row.get('target_current') === tip &&
        // Python evaluates `row['finding']['severity']` for an eligible row, so
        // a missing or non-object finding raises instead of being skipped.
        ['critical', 'major', 'minor'].includes(severity(deliveryFinding(row)) as string)
      ) {
        const id = findingId(row);
        try {
          await inbox.deliver(id, input.transport, at);
          delivered += 1;
        } catch (failure) {
          if (isRepairRoundCeiling(failure)) {
            await inbox.triage({
              findingId: id,
              action: 'needs-human',
              actor: 'crq-triage/delivery',
              reason: failure.message,
              at,
              kwargs: object([['failure_class', 'exhausted']]),
              expectedPreviousEventId: rowKey(row, 'previous_event_id'),
            });
          } else if (isDeliveryFailure(failure)) {
            deliveryDeferred += 1;
          } else {
            throw failure;
          }
        }
      }
    }
  }

  const counts: Array<[string, number]> = [];
  for (const outcome of outcomes) {
    const entry = counts.find(([name]) => name === outcome.action);
    if (entry === undefined) counts.push([outcome.action, 1]);
    else entry[1] += 1;
  }
  return {
    total: input.rows.length,
    judged,
    unjudged: input.candidates.length - judged,
    counts,
    delivered,
    deliveryDeferred,
    contextErrors,
    stopReport,
    stopped,
    dryRun,
    judgmentCandidates,
    outcomes,
  };
}

/** Python `report.get('model', 'judge')`: a present null stays null. */
function modelOf(report: JsonObject): JsonValue {
  return report.has('model') ? (report.get('model') as JsonValue) : 'judge';
}

/** `row['finding']` for an eligible delivery row; KeyError/TypeError otherwise. */
function deliveryFinding(row: JsonObject): JsonObject {
  const finding = rowKey(row, 'finding');
  if (!(finding instanceof JsonObject)) refuse('row finding is not an object (TypeError)');
  return finding;
}

/** `finding_delivery.RepairRoundCeiling`, as the dedicated class or by class name. */
function isRepairRoundCeiling(error: unknown): error is Error {
  return error instanceof RepairRoundCeilingError || injectedIn(error, ['RepairRoundCeiling']);
}

function severity(finding: JsonObject): JsonValue {
  const value = finding.get('severity');
  if (value === undefined) refuse('finding has no severity');
  return value;
}

function findingValue(row: JsonObject, key: string): JsonValue {
  const finding = row.get('finding');
  if (!(finding instanceof JsonObject)) refuse('row finding is not an object');
  const value = finding.get(key);
  return value === undefined ? null : value;
}
