/**
 * `crq._deliver_push_findings` and the bounded retry loop that calls it: files the
 * findings issue for a counted push review. Idempotent and retried by later ticks while
 * `issue_pending` holds; a delivery failure records `issue_error` and never revisits the
 * review's terminal state.
 *
 * Repo lookup, the findings file read and `finding_issues.file_issue` are injected.
 * Python mutates the queue in place; this returns a new queue. Not wired into a tick.
 */
import { JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { ledgerPythonTypeName } from '../../../policy/crq/ledger.js';
import { compareCodePoints } from '../../../policy/crq/pythonJson.js';
import { pyTruthy, withObjectKeys, withoutObjectKey } from '../../../policy/crq/queueDoc.js';
import { PROMOTION_KIND } from '../../../policy/crq/tickSchedule.js';
import { DeliveryKeyTypeError, DeliveryRuntimeError, pyStr } from './deliverPending.js';

export const PUSH_KIND = 'push-current';
export const PUSH_FINDINGS_PER_TICK = 2;

export interface PushFindingsEffects {
  /** `repo_registry.by_repo` then `finding_issues.enabled`; null when the repo is unconfigured. */
  repoMode(repo: string): Promise<{ readonly enabled: boolean } | null>;
  /** `Path(p).read_text(errors="replace")`; an OSError is a `DeliveryRuntimeError` ("[Errno ..] .."). */
  readFindings(path: string): Promise<string>;
  /** `finding_issues.file_issue`; a RuntimeError is a `DeliveryRuntimeError`. */
  fileIssue(input: {
    readonly repo: string;
    readonly base: string;
    readonly head: string;
    readonly meta: JsonObject;
    readonly severityCounts: JsonValue;
    readonly findingsMd: string;
  }): Promise<JsonObject>;
  now(): string;
  primaryRepo: string;
  event(kind: 'findings_delivered', data: Record<string, JsonValue>): Promise<void>;
}

const isLive = (item: JsonValue): item is JsonObject =>
  item instanceof JsonObject && item.get('kind') !== PROMOTION_KIND;

const key = (name: string): DeliveryKeyTypeError => new DeliveryKeyTypeError(`'${name}'`);

/** `request[name]` for a request already known truthy. */
function subscript(request: JsonValue, name: string): JsonValue {
  if (request instanceof JsonObject) {
    const value = request.get(name);
    if (value === undefined) throw key(name);
    return value;
  }
  if (typeof request === 'string')
    throw new DeliveryKeyTypeError(`string indices must be integers, not 'str'`);
  if (Array.isArray(request))
    throw new DeliveryKeyTypeError('list indices must be integers or slices, not str');
  throw new DeliveryKeyTypeError(`'${ledgerPythonTypeName(request)}' object is not subscriptable`);
}

/** The next item (possibly unchanged) and the log line. */
export async function deliverPushFindings(
  start: JsonObject,
  effects: PushFindingsEffects,
): Promise<{ readonly item: JsonObject; readonly message?: string }> {
  const request = start.get('issue_request');
  if (!pyTruthy(request) || pyTruthy(start.get('issue')) || !pyTruthy(start.get('issue_pending')))
    return { item: start };
  const repoValue = start.get('repo');
  const repo =
    pyTruthy(repoValue) && typeof repoValue === 'string' ? repoValue : effects.primaryRepo;
  const mode = await effects.repoMode(repo);
  if (mode === null || !mode.enabled)
    return { item: withObjectKeys(start, [['issue_pending', false]]) };

  const path = subscript(request as JsonValue, 'findings_md');
  if (typeof path !== 'string')
    throw new DeliveryKeyTypeError(
      `argument should be a str or an os.PathLike object where __fspath__ returns a str, not '${ledgerPythonTypeName(path)}'`,
    );
  const fail = (text: string): { item: JsonObject } => ({
    item: withObjectKeys(start, [['issue_error', text.slice(0, 300)]]),
  });
  let markdown: string;
  try {
    markdown = await effects.readFindings(path);
  } catch (error) {
    if (error instanceof DeliveryRuntimeError)
      return fail(`findings markdown unavailable: ${error.message}`);
    throw error;
  }
  const rawSubject = start.get('subject');
  const subject = pyTruthy(rawSubject) ? rawSubject : new JsonObject([]);
  if (!(subject instanceof JsonObject))
    throw new DeliveryKeyTypeError(
      `'${ledgerPythonTypeName(subject as JsonValue)}' object has no attribute 'get'`,
    );
  const req = request as JsonObject;
  const pick = (name: string): JsonValue => {
    const own = req.get(name);
    return pyTruthy(own) ? (own as JsonValue) : (subject.get(name) ?? null);
  };
  const base = pick('base');
  const head = pick('head');
  if (!pyTruthy(base) || !pyTruthy(head)) return fail('findings request lacks a review range');
  const id = start.get('id');
  if (id === undefined) throw key('id');
  const runId = subscript(req, 'run_id');
  const severityCounts = subscript(req, 'severity_counts');
  if (typeof base !== 'string' || typeof head !== 'string')
    throw new DeliveryKeyTypeError('review range must be strings');
  const meta = new JsonObject([
    ['repo', repo],
    ['item_id', id],
    ['run_id', runId],
    ['base', base],
    ['head', head],
    ['receipt_id', start.get('receipt_id') ?? null],
  ]);
  let result: JsonObject;
  try {
    result = await effects.fileIssue({
      repo,
      base,
      head,
      meta,
      severityCounts,
      findingsMd: markdown,
    });
  } catch (error) {
    if (error instanceof DeliveryRuntimeError) return fail(error.message);
    throw error;
  }
  const number = result.get('issue_number');
  if (!pyTruthy(number))
    return {
      item: withObjectKeys(start, [
        ['issue_error', 'findings mode disabled for repository'],
        ['issue_pending', false],
      ]),
    };
  const item = withObjectKeys(withoutObjectKey(start, 'issue_error'), [
    ['issue', result],
    ['issue_pending', false],
  ]);
  const state = pyTruthy(result.get('created')) ? 'created' : 'existing';
  await effects.event('findings_delivered', { item: id, issue: number as JsonValue, state });
  return { item, message: `findings issue #${pyStr(number as JsonValue)} (${state})` };
}

/** The retry loop in `tick`: two least-recently-attempted pending push-review issues. */
export async function deliverPendingPushFindings(
  queue: JsonObject,
  effects: PushFindingsEffects,
): Promise<{ readonly queue: JsonObject; readonly log: string[] }> {
  const raw = queue.get('items');
  if (!Array.isArray(raw)) throw new Error('queue items must be an array');
  const items: JsonValue[] = [...raw];
  const stamp = (item: JsonObject): string => {
    const value = item.get('issue_attempt_at');
    return pyTruthy(value) && typeof value === 'string' ? value : '';
  };
  const candidates = items
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        isLive(entry) && pyTruthy(entry.get('issue_pending')) && entry.get('kind') === PUSH_KIND,
    )
    .sort((a, b) => compareCodePoints(stamp(a.entry as JsonObject), stamp(b.entry as JsonObject)));
  const log: string[] = [];
  for (const { index } of candidates.slice(0, PUSH_FINDINGS_PER_TICK)) {
    const stamped = withObjectKeys(items[index] as JsonObject, [
      ['issue_attempt_at', effects.now()],
    ]);
    items[index] = stamped;
    const done = await deliverPushFindings(stamped, effects);
    items[index] = done.item;
    if (done.message) log.push(done.message);
  }
  return { queue: withObjectKeys(queue, [['items', items]]), log };
}
