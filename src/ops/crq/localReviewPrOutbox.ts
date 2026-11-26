/**
 * Port of `local_review_pr.observe` / `summary` / `write_summary` / `publish`: the
 * event-driven public presentation of a local review on its pull request.
 *
 * The queue transaction owns links and the outbox; the `gh` writes are replayable by
 * marker. Python mutates the queue in place and calls `save_queue` between steps; this
 * port threads an immutable queue and calls the injected `saveQueue` at the same
 * points (once after `observe`, before any external write, then after every row).
 *
 * `gh`, the clock, the receipt lookup and the findings read are injected, so the module
 * does no I/O of its own. Not wired into a tick here.
 */
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import { pythonJsonText } from '../../policy/crq/pythonJson.js';
import { pyTruthy, withObjectKeys } from '../../policy/crq/queueDoc.js';
import { pythonSplitlines } from '../../policy/crq/repairGates.js';
import { ACTIVE_STATES } from '../../policy/crq/reviewAdmission.js';
import {
  PrReviewKeyError,
  PrReviewRuntimeError,
  PrReviewValueError,
  authenticatedLogin,
  callGh,
  deliver,
  ghString,
  loadFindings,
  okGh,
  type DeliverResult,
  type GhPort,
} from '../../policy/crq/prReviewFindings.js';
import { ReceiptDecodeError, ReceiptOsError } from '../../policy/crq/receiptPrepare.js';
import { compareCodePoints } from '../../policy/crq/pythonJson.js';
import { pyStr } from './internal/deliverPending.js';

/** `local_review_pr.MARKER`: the idempotence key of the one summary comment per PR. */
export const SUMMARY_MARKER = '<!-- crq-local-review-summary-v1 -->';
/** Rows delivered per tick. */
export const OUTBOX_ROWS_PER_TICK = 2;
/** Attempts after which a row stays in the outbox but is no longer retried. */
export const OUTBOX_MAX_ATTEMPTS = 5;

/** Python `RuntimeError` raised by the outbox itself (`retained receipt unavailable`). */
export class OutboxRuntimeError extends Error {
  override readonly name = 'OutboxRuntimeError';
}

/** Python `KeyError` from a missing outbox, link or item key; its text is the key's repr. */
export class OutboxKeyError extends Error {
  override readonly name = 'OutboxKeyError';
  constructor(key: string) {
    super(`'${key}'`);
  }
}

/** Python `TypeError` from a malformed queue document: never caught by `publish`. */
export class OutboxTypeError extends Error {
  override readonly name = 'OutboxTypeError';
}

export interface OutboxEffects {
  /** `crq.save_queue`; durable before it returns. */
  saveQueue(queue: JsonObject): void | Promise<void>;
  /** `crq.iso()`. */
  iso(): string;
  /** `time.time()`, epoch seconds. */
  epochSeconds(): number;
  /** `runtime.retained`: the verified receipt document, or null. */
  retained(item: JsonObject): Promise<JsonObject | null>;
  /** `pr_review_findings._gh`, or the caller's gh. */
  gh: GhPort;
  /** `Path(RUNS) / run_id / "review.ndjson"`; the effect owns the runs root. */
  findingsPath(runId: string): string;
  /** `Path(p).read_text(errors="replace")`. */
  readText(path: string): string;
}

const object = (value: JsonValue | undefined, label: string): JsonObject => {
  if (!(value instanceof JsonObject)) throw new OutboxTypeError(`${label} must be an object`);
  return value;
};

const required = (record: JsonObject, key: string): JsonValue => {
  const value = record.get(key);
  if (value === undefined) throw new OutboxKeyError(key);
  return value;
};

function number(value: JsonValue | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (value instanceof JsonNumber)
    return value.kind === 'int' ? Number(value.integer) : (value.float as number);
  throw new OutboxTypeError(`${label} must be a number`);
}

const text = (value: JsonValue | undefined): string => (typeof value === 'string' ? value : '');

const queueItems = (queue: JsonObject): JsonObject[] => {
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new OutboxTypeError('queue items must be an array');
  return items.map((item) => object(item, 'queue item'));
};

const sameValue = (left: JsonValue | undefined, right: JsonValue | undefined): boolean => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left instanceof JsonNumber && right instanceof JsonNumber)
    return left.raw === right.raw && left.kind === right.kind;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((v, i) => sameValue(v, right[i]));
  if (left instanceof JsonObject && right instanceof JsonObject)
    return (
      left.entries.length === right.entries.length &&
      left.entries.every(([key, value]) => sameValue(value, right.get(key)))
    );
  return false;
};

/** True when another request records `item` as the one it supersedes. */
function superseded(queue: JsonObject, item: JsonObject): boolean {
  const requestsValue = queue.get('review_requests');
  if (requestsValue === undefined || requestsValue === null) return false;
  const requests = object(requestsValue, 'review_requests');
  return requests.entries.some(([, request]) => {
    const target = object(request, 'review request').get('supersedes');
    if (typeof target !== 'string') return false;
    const found = requests.get(target);
    return (
      found instanceof JsonObject &&
      found.get('item') === item.get('id') &&
      item.get('id') !== undefined
    );
  });
}

/**
 * `local_review_pr.observe`: persist one outbox row per association, terminal or stale
 * transition. Only a changed `[item, head, base, state, receipt_id]` version enqueues.
 */
export function observeOutbox(queue: JsonObject): JsonObject {
  const items = new Map<string, JsonObject>();
  for (const item of queueItems(queue)) items.set(pyStr(required(item, 'id')), item);
  const linksValue = queue.get('review_pr_links');
  if (linksValue === undefined || linksValue === null) return queue;
  const links = object(linksValue, 'review_pr_links');
  let nextLinks = links;
  let outbox: JsonObject | null = null;
  for (const [key, linkValue] of links.entries) {
    const link = object(linkValue, 'review_pr_link');
    const item = items.get(pyStr(required(link, 'item')));
    if (item === undefined || !pyTruthy(item)) continue;
    const itemState = required(item, 'state');
    let state: string = ACTIVE_STATES.has(pyStr(itemState)) ? 'in progress' : pyStr(itemState);
    if (pyTruthy(link.get('stale'))) state = 'stale; prior coverage only';
    else if (itemState === 'cancelled' && superseded(queue, item)) state = 'superseded';
    else if (pyTruthy(item.get('scope_adequate'))) state = 'completed';
    const version: JsonValue[] = [
      required(link, 'item'),
      required(link, 'head'),
      required(link, 'base'),
      state,
      item.get('receipt_id') ?? null,
    ];
    if (sameValue(link.get('version'), version)) continue;
    const updated = withObjectKeys(link, [
      ['version', version],
      ['state', state],
    ]);
    nextLinks = withObjectKeys(nextLinks, [[key, updated]]);
    const row = withObjectKeys(updated, [
      ['attempts', JsonNumber.int(0)],
      ['pending', true],
    ]);
    const existing = queue.get('review_pr_outbox');
    const base = outbox ?? (existing instanceof JsonObject ? existing : new JsonObject([]));
    outbox = withObjectKeys(base, [[key, row]]);
  }
  let next = queue;
  if (nextLinks !== links) next = withObjectKeys(next, [['review_pr_links', nextLinks]]);
  if (outbox !== null) next = withObjectKeys(next, [['review_pr_outbox', outbox]]);
  return next;
}

/** `local_review_pr.summary`: the comment body; only a URL this delivery generated is linked. */
export function outboxSummary(row: JsonObject, result: JsonObject): string {
  let body =
    `${SUMMARY_MARKER}\nCodeRabbit CLI via crq; not an independent PASS\n\n` +
    `Provider: coderabbit-cli. Reviewed head: \`${pyStr(required(row, 'head'))}\`.\n` +
    `Base: \`${pyStr(required(row, 'base'))}\`. State: ${pyStr(required(row, 'state'))}.\n`;
  const reviewUrl = result.get('review_url');
  const url = pyTruthy(reviewUrl) && typeof reviewUrl === 'string' ? reviewUrl : '';
  if (
    url.startsWith(
      `https://github.com/${pyStr(required(row, 'repo'))}/pull/${pyStr(required(row, 'pr'))}/`,
    )
  )
    body += `\n[Inline findings](${url})\n`;
  return body;
}

const dumps = (value: JsonValue): string =>
  pythonJsonText(value, { asciiOnly: true, sortKeys: false, indent: null, spacedSeparators: true });

/** `local_review_pr.write_summary`: edit this login's marker comment, else post a new one. */
export function writeOutboxSummary(row: JsonObject, body: string, gh: GhPort): void {
  const login = authenticatedLogin(gh);
  const repo = pyStr(required(row, 'repo'));
  const pr = pyStr(required(row, 'pr'));
  const endpoint = `repos/${repo}/issues/${pr}/comments`;
  const query =
    `.[] | select(.user.login == ${dumps(login)} and ` +
    `((.body // "") | startswith(${dumps(SUMMARY_MARKER)}))) | {id, body}`;
  const listArgv = ['gh', 'api', '--paginate', `${endpoint}?per_page=100`, '--jq', query];
  const out = okGh([], callGh(gh, listArgv, null));
  let found: JsonObject | null = null;
  for (const line of pythonSplitlines(ghString(out.stdout))) {
    const value = parseJsonValue(line, { duplicates: 'last' });
    const id = value instanceof JsonObject ? value.get('id') : undefined;
    if (value instanceof JsonObject && id instanceof JsonNumber && id.kind === 'int') {
      found = value;
      break;
    }
  }
  if (found !== null && found.get('body') === body) return;
  const target =
    found === null
      ? endpoint
      : `repos/${repo}/issues/comments/${String((found.get('id') as JsonNumber).raw)}`;
  const argv = ['gh', 'api', '--method', found === null ? 'POST' : 'PATCH', target, '--input', '-'];
  okGh(argv, callGh(gh, argv, dumps(new JsonObject([['body', body]]))));
}

/** The exception classes `publish` catches: OSError, RuntimeError, ValueError, KeyError. */
function expectedFailure(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return (
    error instanceof PrReviewRuntimeError ||
    error instanceof PrReviewValueError ||
    error instanceof PrReviewKeyError ||
    error instanceof OutboxRuntimeError ||
    error instanceof OutboxKeyError ||
    error instanceof ReceiptOsError ||
    error instanceof ReceiptDecodeError ||
    error instanceof SyntaxError ||
    typeof (error as { code?: unknown }).code === 'string'
  );
}

const resultObject = (result: DeliverResult): JsonObject =>
  new JsonObject(
    Object.entries(result)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]): [string, JsonValue] => [
        key,
        typeof value === 'number' ? JsonNumber.int(BigInt(value)) : (value as JsonValue),
      ]),
  );

/** Python mutates the row in place, so a failure part-way keeps every earlier update. */
interface RowBox {
  row: JsonObject;
}

async function deliverRow(
  box: RowBox,
  items: ReadonlyMap<string, JsonObject>,
  effects: OutboxEffects,
): Promise<void> {
  const row = box.row;
  const item = items.get(pyStr(required(row, 'item')));
  if (item === undefined) throw new OutboxKeyError(pyStr(required(row, 'item')));
  const reviewed = row.get('review');
  let result = reviewed === undefined ? new JsonObject([]) : object(reviewed, 'review');
  const state = required(row, 'state');
  if (
    pyTruthy(item.get('scope_adequate')) &&
    !pyTruthy(row.get('stale')) &&
    state !== 'cancelled' &&
    state !== 'superseded'
  ) {
    const doc = await effects.retained(item);
    if (doc === null) throw new OutboxRuntimeError('retained receipt unavailable');
    const runId = required(doc, 'run_id');
    box.row = withObjectKeys(box.row, [['state', required(doc, 'outcome')]]);
    const pr = required(row, 'pr');
    const delivered = deliver({
      repo: pyStr(required(row, 'repo')),
      pr: pr instanceof JsonNumber && pr.kind === 'int' ? Number(pr.integer) : Number.NaN,
      meta: new JsonObject([
        ['run_id', runId],
        ['base', required(row, 'base')],
        ['head', required(row, 'head')],
        ['local_review', true],
      ]),
      findings: loadFindings(effects.readText(effects.findingsPath(pyStr(runId)))),
      gh: effects.gh,
      login: null,
      injected: true,
    });
    result = resultObject(delivered);
    box.row = withObjectKeys(box.row, [['review', result]]);
    if (delivered.state === 'skipped-head')
      box.row = withObjectKeys(box.row, [['state', 'stale; prior coverage only']]);
  }
  writeOutboxSummary(box.row, outboxSummary(box.row, result), effects.gh);
  box.row = withObjectKeys(box.row, [
    ['pending', false],
    ['error', null],
  ]);
}

/**
 * `local_review_pr.publish`: observe, make the queue durable, then deliver at most two
 * pending rows. A row's expected failure is recorded with an exponential retry delay; any
 * other exception propagates exactly as Python's uncaught one would.
 */
export async function publishLocalReviewPr(
  queue: JsonObject,
  effects: OutboxEffects,
): Promise<JsonObject> {
  let current = observeOutbox(queue);
  await effects.saveQueue(current); // durable before any external write
  const items = new Map<string, JsonObject>();
  for (const item of queueItems(current)) items.set(pyStr(required(item, 'id')), item);
  const outboxValue = current.get('review_pr_outbox');
  const outbox =
    outboxValue === undefined || outboxValue === null
      ? new JsonObject([])
      : object(outboxValue, 'review_pr_outbox');
  const selected = outbox.entries
    .filter(([, rowValue]) => {
      const row = object(rowValue, 'outbox row');
      return (
        pyTruthy(required(row, 'pending')) &&
        number(required(row, 'attempts'), 0, 'attempts') < OUTBOX_MAX_ATTEMPTS &&
        number(row.get('retry_at'), 0, 'retry_at') <= effects.epochSeconds()
      );
    })
    .sort(([, a], [, b]) =>
      compareCodePoints(
        text((a as JsonObject).get('attempt_at')),
        text((b as JsonObject).get('attempt_at')),
      ),
    )
    .slice(0, OUTBOX_ROWS_PER_TICK);
  for (const [key] of selected) {
    const stored = object(
      object(current.get('review_pr_outbox'), 'review_pr_outbox').get(key),
      'outbox row',
    );
    const attempts = number(required(stored, 'attempts'), 0, 'attempts') + 1;
    const box: RowBox = {
      row: withObjectKeys(stored, [
        ['attempts', JsonNumber.int(attempts)],
        ['attempt_at', effects.iso()],
      ]),
    };
    try {
      await deliverRow(box, items, effects);
    } catch (error) {
      if (!expectedFailure(error)) throw error;
      box.row = withObjectKeys(box.row, [
        ['error', [...error.message].slice(0, 300).join('')],
        ['retry_at', JsonNumber.float(effects.epochSeconds() + Math.min(3600, 60 * 2 ** attempts))],
      ]);
    }
    const table = object(current.get('review_pr_outbox'), 'review_pr_outbox');
    current = withObjectKeys(current, [
      ['review_pr_outbox', withObjectKeys(table, [[key, box.row]])],
    ]);
    await effects.saveQueue(current);
  }
  return current;
}
