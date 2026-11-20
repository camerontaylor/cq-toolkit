/**
 * Port of `client_health.record` / `advisory` / `_partitioned`: the per-tick durable health
 * observation and the bounded, advisory "merged discovery incomplete" issue.
 *
 * Python mutates the queue (and its `client_health` dict) in place and calls `save_queue`
 * at three points of the issue-opening transaction. This port threads an immutable queue
 * through a small box so that every mutation made before a failure survives it, exactly as
 * the in-place Python mutation does, and calls the injected `saveQueue` at the same points.
 *
 * The forge, the clock, the checkout SHA and the config threshold are injected. The forge
 * effect receives the per-call timeout taken from the advisory's own `ForgeBudget(3, 10)`
 * window; a failed call throws an error whose `pythonError` is the Python exception class
 * name, because the tick log records that name (never the message, which may carry forge
 * text) and a `CalledProcessError` on the issue create is the one definite failure.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { ForgeBudget } from '../../policy/crq/forgeBudget.js';
import { pyTruthy, withObjectKeys } from '../../policy/crq/queueDoc.js';
import { pyStr } from './internal/deliverPending.js';

export const HEALTH_TITLE = 'crq: merged discovery incomplete';
export const HEALTH_MARKER = '<!-- crq-discovery-health-v1 -->';
/** `advisory`'s call cap and its separate forge window. */
export const ADVISORY_MAX_CALLS = 3;
export const ADVISORY_BUDGET_REQUESTS = 3;
export const ADVISORY_BUDGET_SECONDS = 10;
const STREAK_CAP = 1_000_000;
const DEFAULT_THRESHOLD = 3;

/** A Python exception raised by the advisory itself or by the forge effect. */
export class HealthAdvisoryError extends Error {
  override readonly name = 'HealthAdvisoryError';
  readonly pythonError: string;
  constructor(pythonError: string, message: string) {
    super(message);
    this.pythonError = pythonError;
  }
}

export interface ClientHealthEffects {
  /** `crq.save_queue`; durable before it returns. */
  saveQueue(queue: JsonObject): void | Promise<void>;
  /** `crq.iso()`. */
  iso(): string;
  /** `client_health.checkout_sha(RUNNER_ROOT)`. */
  checkoutSha(): string | null;
  /** `crq.REPO`. */
  repo: string;
  /** `CONFIG.get("discovery_incomplete_ticks", 3)`; undefined when the key is absent. */
  incompleteTicksThreshold: JsonValue | undefined;
  /**
   * `crq.gh_json` inside the advisory window: the parsed JSON, or a thrown error with a
   * Python `pythonError` (`CalledProcessError` for a nonzero exit, `TimeoutExpired`,
   * `JSONDecodeError`, `FileNotFoundError`, …). `timeoutSeconds` is the budget's take.
   */
  forgeJson(args: string[], options: { timeoutSeconds: number }): Promise<JsonValue>;
  /** A fresh `ForgeBudget(requests=3, seconds=10)`; injectable for a deterministic clock. */
  newBudget?(): ForgeBudget;
}

export interface ClientHealthResult {
  readonly queue: JsonObject;
  readonly log: string[];
}

/** The Python class name of a thrown value, for the log line. */
export function pythonErrorName(error: unknown): string {
  if (error instanceof Error) {
    const named = (error as { pythonError?: unknown }).pythonError;
    if (typeof named === 'string') return named;
    return error.name;
  }
  return 'Exception';
}

const typeError = (message: string): HealthAdvisoryError =>
  new HealthAdvisoryError('TypeError', message);

/** A Python number (`bool` is an `int`) as a JS number; anything else is a `TypeError`. */
function pyNumber(value: JsonValue | undefined): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof JsonNumber) return Number(value.integer ?? value.float);
  throw typeError('unsupported operand type for health arithmetic');
}

/** `_partitioned`: a positive-int `span` (a width hint of an unfinished drain). */
function partitioned(active: JsonObject): boolean {
  const span = active.get('span');
  return span instanceof JsonNumber && span.integer !== null && span.integer > 0n;
}

/** A mutable view of the queue so a failure keeps the mutations made before it. */
class QueueBox {
  queue: JsonObject;
  constructor(queue: JsonObject) {
    this.queue = queue;
  }
  health(): JsonObject {
    return this.queue.get('client_health') as JsonObject;
  }
  update(updates: ReadonlyArray<readonly [string, JsonValue]>): void {
    this.queue = withObjectKeys(this.queue, [
      ['client_health', withObjectKeys(this.health(), updates)],
    ]);
  }
}

/** `record`: update the durable health observation and run the bounded advisory. */
export async function recordClientHealth(
  start: JsonObject,
  discoveryEnabled: boolean,
  effects: ClientHealthEffects,
): Promise<ClientHealthResult> {
  const raw = start.get('client_health');
  if (raw !== undefined && !(raw instanceof JsonObject)) {
    throw new HealthAdvisoryError('AttributeError', 'client_health is not an object');
  }
  const box = new QueueBox(start);
  if (raw === undefined) box.queue = withObjectKeys(start, [['client_health', new JsonObject([])]]);
  const health = box.health();
  const merged = box.queue.get('merged_discovery');
  const active = pyTruthy(merged) ? merged : new JsonObject([]);
  if (!(active instanceof JsonObject)) {
    throw new HealthAdvisoryError('AttributeError', 'merged_discovery is not an object');
  }
  let complete: JsonValue | undefined = discoveryEnabled
    ? active.get('complete')
    : health.get('complete');
  if (discoveryEnabled && complete === true && partitioned(active)) complete = false;
  let streak: JsonValue = health.get('incomplete_ticks') ?? JsonNumber.int(0);
  if (discoveryEnabled && complete === false) {
    // `min(1000000, streak + 1)` keeps the int/float kind of the stored streak.
    const next = Math.min(STREAK_CAP, pyNumber(streak) + 1);
    streak =
      streak instanceof JsonNumber && streak.kind === 'float'
        ? JsonNumber.float(next)
        : JsonNumber.int(next);
  } else if (discoveryEnabled && complete === true) {
    streak = JsonNumber.int(0);
  }
  box.update([
    ['completed_at', effects.iso()],
    ['complete', complete ?? null],
    ['incomplete_ticks', streak],
    ['sha', effects.checkoutSha()],
  ]);
  // Skipped discovery retains the last observation without advancing history.
  if (!discoveryEnabled || complete === undefined || complete === null) {
    return { queue: box.queue, log: ['health advisory skipped: discovery not run'] };
  }
  const log: string[] = [];
  try {
    await advisory(box, effects, log);
  } catch (error) {
    // Never include forge responses or credential-bearing exception text.
    log.push(`health advisory skipped or failed: ${pythonErrorName(error)}`);
    const after = box.health();
    if (pyTruthy(after.get('opening')) && (after.get('issue_number') ?? null) === null) {
      log.push('health advisory: opening marker unresolved');
    }
  }
  return { queue: box.queue, log };
}

/** `advisory`: at most three calls in a separate fixed budget; settled transitions are quiet. */
async function advisory(box: QueueBox, effects: ClientHealthEffects, log: string[]): Promise<void> {
  const health = box.health();
  const configured = effects.incompleteTicksThreshold;
  const threshold =
    configured instanceof JsonNumber &&
    configured.integer !== null &&
    configured.integer >= 1n &&
    configured.integer <= 1_000_000n
      ? Number(configured.integer)
      : DEFAULT_THRESHOLD;
  const ticks = health.get('incomplete_ticks') as JsonValue;
  const issueOpen = pyTruthy(health.get('issue_open'));
  const desired = pyNumber(ticks) >= threshold || (issueOpen && health.get('complete') === false);
  const issueTicks = health.get('issue_ticks') ?? JsonNumber.int(0);
  const updateDue =
    desired &&
    Math.floor(pyNumber(ticks) / threshold) > Math.floor(pyNumber(issueTicks) / threshold);
  if (desired === issueOpen && !updateDue && !pyTruthy(health.get('opening'))) return;

  const budget =
    effects.newBudget?.() ??
    new ForgeBudget({
      requests: ADVISORY_BUDGET_REQUESTS,
      seconds: ADVISORY_BUDGET_SECONDS,
    });
  let calls = 0;
  const forge = async (args: string[]): Promise<JsonValue> => {
    if (calls >= ADVISORY_MAX_CALLS || !budget.available()) {
      throw new HealthAdvisoryError('RuntimeError', 'health advisory budget exhausted');
    }
    calls += 1;
    return effects.forgeJson(args, { timeoutSeconds: budget.take() });
  };
  const save = async (): Promise<void> => {
    await effects.saveQueue(box.queue);
  };
  const repo = effects.repo;

  let number: JsonValue = box.health().get('issue_number') ?? null;
  if (number === null) {
    const rows = await forge([
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'all',
      '--limit',
      '100',
      '--json',
      'number,title,body',
    ]);
    number = firstMarkedIssue(rows);
    if (pyTruthy(box.health().get('opening'))) {
      if (number === null) {
        log.push(
          'health advisory: opening marker unresolved; confirming list found no issue, marker cleared',
        );
      }
      box.update([
        ['opening', false],
        ['issue_number', number],
      ]);
      await save();
    }
  }
  const body = `${HEALTH_MARKER}\nDiscovery incomplete for ${pyStr(ticks)} ticks. Advisory only.`;
  if (desired) {
    if (number === null) {
      box.update([['opening', true]]);
      await save(); // persist intent before an ambiguous create response
      let result: JsonValue;
      try {
        result = await forge([
          'api',
          `repos/${repo}/issues`,
          '-f',
          `title=${HEALTH_TITLE}`,
          '-f',
          `body=${body}`,
        ]);
      } catch (error) {
        if (pythonErrorName(error) === 'CalledProcessError') {
          box.update([['opening', false]]);
          await save();
        }
        throw error;
      }
      number = subscriptNumber(result);
      box.update([['issue_number', number]]);
      await save();
    } else {
      await forge([
        'api',
        `repos/${repo}/issues/${pyStr(number)}`,
        '-X',
        'PATCH',
        '-f',
        'state=open',
        '-f',
        `body=${body}`,
      ]);
    }
    box.update([['recovery_commented', false]]);
  } else if (number !== null) {
    if (!pyTruthy(box.health().get('recovery_commented'))) {
      await forge([
        'api',
        `repos/${repo}/issues/${pyStr(number)}/comments`,
        '-f',
        `body=${HEALTH_MARKER}\nDiscovery complete again.`,
      ]);
      box.update([['recovery_commented', true]]);
    }
    await forge([
      'api',
      `repos/${repo}/issues/${pyStr(number)}`,
      '-X',
      'PATCH',
      '-f',
      'state=closed',
    ]);
  }
  box.update([
    ['issue_open', desired],
    ['issue_number', number],
    ['opening', false],
    ['issue_ticks', ticks],
  ]);
}

/** `matches[0]["number"]` over the `issue list` rows; `None` when no row is the advisory issue. */
function firstMarkedIssue(rows: JsonValue): JsonValue {
  const list: JsonValue[] = iterate(rows);
  for (const row of list) {
    if (!(row instanceof JsonObject)) {
      throw new HealthAdvisoryError('AttributeError', 'issue row is not an object');
    }
    if (row.get('title') !== HEALTH_TITLE) continue;
    const body = row.get('body');
    const text = pyTruthy(body) ? (body as JsonValue) : '';
    if (!contains(text, HEALTH_MARKER)) continue;
    const found = row.get('number');
    if (found === undefined) throw new HealthAdvisoryError('KeyError', "'number'");
    return found;
  }
  return null;
}

function iterate(rows: JsonValue): JsonValue[] {
  if (Array.isArray(rows)) return rows;
  if (rows instanceof JsonObject) return rows.entries.map(([key]) => key);
  if (typeof rows === 'string') return [...rows];
  throw typeError(`'${rows === null ? 'NoneType' : typeof rows}' object is not iterable`);
}

/** Python `needle in value` for the shapes a forge body can take. */
function contains(value: JsonValue, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.includes(needle);
  if (value instanceof JsonObject) return value.has(needle);
  throw typeError('argument of type is not iterable');
}

/** `result["number"]` for the create response. */
function subscriptNumber(result: JsonValue): JsonValue {
  if (result instanceof JsonObject) {
    const found = result.get('number');
    if (found === undefined) throw new HealthAdvisoryError('KeyError', "'number'");
    return found;
  }
  throw typeError('create response is not an object');
}
