/**
 * The merged-interval inventory producer (`merged_reconcile.py`).
 *
 * This module is the pure half of the S2 reconcile boundary: it folds pages into
 * a schema-2 checkpoint, drives the bounded page loop, seals a checkpoint with
 * its summary and digest, plans Q1 enrollment and pins the all-number-slot forge
 * query. It performs no I/O: the page fetcher, checkpoint save and forge query
 * are typed callbacks, so the route adapter owns bytes, atomic rename/fsync and
 * the process boundary.
 *
 * Parity rules from the Python oracle:
 *
 * - a page is folded only after explicit completeness metadata is proven; a
 *   terminal cursor or exit 0 does not cure `errors`, `truncated` or
 *   `incomplete_results`;
 * - a checkpoint is persisted before the NEXT fetch, and a failed save
 *   propagates so persisted progress never advances behind a failed write;
 * - transient transport failures are counted, budget exhaustion is not (it
 *   recovers next tick on its own), and neither advances the watermark;
 * - dry runs fetch and inventory normally but never invoke the save callback.
 */
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from './jsonValue.js';
import { pythonJsonText } from './pythonJson.js';
import {
  isJsonBool,
  isJsonInt,
  isJsonRecord,
  jsonIntValue,
  jsonIntText,
  pyTruthy,
  pythonValueEqual,
  recordGet,
  recordHas,
  withObjectKeys,
  type JsonRecordLike,
} from './queueDoc.js';
import {
  DISCOVERY_SELECTOR,
  MAX_INVENTORY,
  MAX_PAGES,
  MAX_REPOSITORY_NUMBER,
  NUMBER_WINDOW,
  RECONCILE_VERSION,
  ReconcileRefused,
  checkpointDigest,
  isCursor,
  loadCheckpoint,
  newCheckpoint,
  normalizeInterval,
  normalizePageBudget,
  normalizeTimestamp,
  recordIdentity,
  summarize,
  type ReconcileInterval,
} from './reconcileCheckpoint.js';

/** `merged_reconcile.MAX_PAGE_RECORDS`. */
export const MAX_PAGE_RECORDS = 100;
/** `runtime_target.DEFAULT_BRANCH`. */
export const DEFAULT_BRANCH = 'main';
/** `runtime_target.DISCOVERY_BRANCHES`. */
export const DISCOVERY_BRANCHES: readonly string[] = ['main', 'merge-queue'];

/** `merged_reconcile.PageFailed`: retryable page read; the cursor is retained. */
export class PageFailed extends Error {
  override readonly name: string = 'PageFailed';
  readonly pythonError: string = 'PageFailed';
  readonly reason: string = 'transport-failure';

  constructor(message: string) {
    super(message);
  }
}

/** `merged_reconcile.BudgetExhausted`: the local allowance ended; not transport. */
export class BudgetExhausted extends PageFailed {
  override readonly name: string = 'BudgetExhausted';
  override readonly pythonError = 'BudgetExhausted';
  override readonly reason: string = 'budget-exhausted';

  constructor(message: string) {
    super(message);
  }
}

/** `merged_reconcile.InventoryCapExceeded`: a shorter interval can complete. */
export class InventoryCapExceeded extends ReconcileRefused {
  override readonly name: string = 'InventoryCapExceeded';

  constructor(message: string) {
    super(message);
  }
}

/** One forge query; the adapter binds this to `gh api graphql`. */
export type ForgeQuery = (query: string) => Promise<unknown>;
/** One page fetch keyed by the retained cursor (`null` on the first page). */
export type PageFetch = (cursor: string | null) => Promise<unknown>;
/** Persist one sealed checkpoint snapshot. */
export type CheckpointSave = (snapshot: JsonObject) => Promise<void> | void;

function copyJson(value: JsonValue): JsonValue {
  if (value instanceof JsonObject) {
    return new JsonObject(value.entries.map(([key, entry]) => [key, copyJson(entry)] as const));
  }
  if (Array.isArray(value)) return value.map(copyJson);
  return value;
}

function copyCheckpoint(checkpoint: JsonObject): JsonObject {
  return copyJson(checkpoint) as JsonObject;
}

function counter(checkpoint: JsonRecordLike, key: string): bigint {
  const value = recordGet(checkpoint, key);
  if (!isJsonInt(value) || jsonIntValue(value) < 0n) {
    throw new ReconcileRefused(`checkpoint counter malformed: ${key}`);
  }
  return jsonIntValue(value);
}

function arrayAt(checkpoint: JsonRecordLike, key: string): JsonValue[] {
  const value = recordGet(checkpoint, key);
  if (!Array.isArray(value)) throw new ReconcileRefused(`checkpoint state malformed: ${key}`);
  return value as JsonValue[];
}

function requireRecord(checkpoint: JsonRecordLike, key: string): JsonRecordLike {
  const value = recordGet(checkpoint, key);
  if (!isJsonRecord(value)) throw new ReconcileRefused(`checkpoint state malformed: ${key}`);
  return value;
}

/** `merged_reconcile._stable_page_sort`: strings then ints, stable. */
function stablePageSort(records: readonly JsonValue[]): JsonValue[] {
  return [...records].sort((left, right) => {
    const leftAt = isJsonRecord(left) ? recordGet(left, 'mergedAt') : undefined;
    const rightAt = isJsonRecord(right) ? recordGet(right, 'mergedAt') : undefined;
    const leftKey = typeof leftAt === 'string' ? leftAt : '';
    const rightKey = typeof rightAt === 'string' ? rightAt : '';
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    const leftPr = isJsonRecord(left) ? recordGet(left, 'number') : undefined;
    const rightPr = isJsonRecord(right) ? recordGet(right, 'number') : undefined;
    const leftNumber = isJsonInt(leftPr) ? Number(jsonIntValue(leftPr)) : 0;
    const rightNumber = isJsonInt(rightPr) ? Number(jsonIntValue(rightPr)) : 0;
    return leftNumber - rightNumber;
  });
}

/** `merged_reconcile.summarize`'s inventory sort key. */
function inventorySortKey(value: JsonValue): readonly [string, number, string] {
  if (!isJsonRecord(value)) return ['', 0, ''];
  const mergedAt = recordGet(value, 'merged_at');
  const pr = recordGet(value, 'pr');
  const reason = recordGet(value, 'reason');
  return [
    typeof mergedAt === 'string' ? mergedAt : '',
    isJsonInt(pr) ? Number(jsonIntValue(pr)) : 0,
    typeof reason === 'string' ? reason : '',
  ];
}

function compareInventory(left: JsonValue, right: JsonValue): number {
  const leftKey = inventorySortKey(left);
  const rightKey = inventorySortKey(right);
  if (leftKey[0] !== rightKey[0]) return leftKey[0] < rightKey[0] ? -1 : 1;
  if (leftKey[1] !== rightKey[1]) return leftKey[1] - rightKey[1];
  if (leftKey[2] !== rightKey[2]) return leftKey[2] < rightKey[2] ? -1 : 1;
  return 0;
}

/**
 * `merged_reconcile.reconcile_page`: fold one bounded page into a copy of the
 * checkpoint. Cursor validation and persistence belong to {@link reconcile}.
 */
export function reconcilePage(checkpoint: JsonObject, pageRecords: unknown): JsonObject {
  if (!Array.isArray(pageRecords) || pageRecords.length > MAX_PAGE_RECORDS) {
    throw new ReconcileRefused('a page must be a bounded list of PR records');
  }
  const updated = copyCheckpoint(checkpoint);
  const recordKeys = [...arrayAt(updated, 'record_keys')];
  const keys = new Set(recordKeys.map((key) => String(key)));
  const inventory = [...arrayAt(updated, 'inventory')];
  let seen = requireRecord(updated, 'seen') as JsonObject;
  const after = recordGet(updated, 'after');
  const before = recordGet(updated, 'before');
  if (typeof after !== 'string' || typeof before !== 'string') {
    throw new ReconcileRefused('checkpoint belongs to a different frozen interval');
  }
  let recordsRead = counter(updated, 'records_read');
  let outsideWindow = counter(updated, 'outside_window');
  let duplicatesSeen = counter(updated, 'duplicates_seen');
  let pagesRead = counter(updated, 'pages_read');

  for (const record of stablePageSort(pageRecords as JsonValue[])) {
    recordsRead += 1n;
    const rawMergedAt = isJsonRecord(record) ? recordGet(record, 'mergedAt') : undefined;
    let at: string | null = null;
    try {
      at = normalizeTimestamp('mergedAt', rawMergedAt);
    } catch {
      at = null;
    }
    if (at !== null && !(after < at && at <= before)) {
      outsideWindow += 1n;
      continue;
    }
    let identity = recordIdentity(record);
    // Valid source identity ignores incidental fields/head churn. Invalid
    // records dedupe by their canonical payload so distinct failures survive.
    const source =
      recordGet(identity, 'disposition') === 'intent'
        ? new JsonObject([
            ['pr', recordGet(identity, 'pr') as JsonValue],
            ['merge_sha', recordGet(identity, 'merge_sha') as JsonValue],
          ])
        : new JsonObject([['unsupported_record', record]]);
    let key: string;
    try {
      key = checkpointDigest(source);
    } catch {
      throw new ReconcileRefused('page record is not canonical JSON');
    }
    if (keys.has(key)) {
      duplicatesSeen += 1n;
      continue;
    }
    keys.add(key);
    recordKeys.push(key);
    if (recordGet(identity, 'disposition') === 'intent') {
      const pr = recordGet(identity, 'pr') as JsonNumber;
      const prText = jsonIntText(pr);
      const prior = seen.get(prText);
      if (pyTruthy(prior) && isJsonRecord(prior)) {
        if (!pythonValueEqual(recordGet(prior, 'merge_sha'), recordGet(identity, 'merge_sha'))) {
          identity = new JsonObject([
            ['disposition', 'unsupported'],
            ['pr', pr],
            ['reason', 'conflicting merge identity for one PR'],
            ['prior', prior],
            [
              'observed',
              new JsonObject([
                ['merge_sha', recordGet(identity, 'merge_sha') as JsonValue],
                ['merged_at', at],
              ]),
            ],
          ]);
        } else {
          seen = withObjectKeys(seen, [
            [
              prText,
              new JsonObject([
                ['merge_sha', recordGet(identity, 'merge_sha') as JsonValue],
                ['merged_at', at],
              ]),
            ],
          ]);
        }
      } else {
        seen = withObjectKeys(seen, [
          [
            prText,
            new JsonObject([
              ['merge_sha', recordGet(identity, 'merge_sha') as JsonValue],
              ['merged_at', at],
            ]),
          ],
        ]);
      }
    }
    if (inventory.length >= MAX_INVENTORY) {
      throw new InventoryCapExceeded('inventory cap reached; partition the interval');
    }
    inventory.push(identity);
  }
  inventory.sort(compareInventory);
  pagesRead += 1n;
  return withObjectKeys(updated, [
    ['seen', seen],
    ['inventory', inventory],
    ['record_keys', recordKeys],
    ['duplicates_seen', JsonNumber.int(duplicatesSeen)],
    ['outside_window', JsonNumber.int(outsideWindow)],
    ['records_read', JsonNumber.int(recordsRead)],
    ['pages_read', JsonNumber.int(pagesRead)],
  ]);
}

/** `merged_reconcile._seal`: a deep copy plus a fresh summary and digest. */
export function seal(checkpoint: JsonObject): JsonObject {
  const result = copyCheckpoint(checkpoint);
  const withSummary = withObjectKeys(result, [['summary', summarize(result)]]);
  return withObjectKeys(withSummary, [['digest', checkpointDigest(withSummary)]]);
}

/** `merged_reconcile._page`: validate completeness metadata and the cursor. */
export function parsePage(
  value: unknown,
  cursor: string | null,
  history: readonly string[],
): { readonly records: JsonValue[]; readonly nextCursor: string | null } {
  if (
    isJsonRecord(value) &&
    ((recordHas(value, 'incomplete_results') &&
      recordGet(value, 'incomplete_results') !== false) ||
      (recordHas(value, 'truncated') && recordGet(value, 'truncated') !== false) ||
      pyTruthy(recordGet(value, 'errors')))
  ) {
    throw new ReconcileRefused('incomplete, truncated or errored forge result');
  }
  if (
    !isJsonRecord(value) ||
    !Array.isArray(recordGet(value, 'records')) ||
    !isJsonBool(recordGet(value, 'has_next_page')) ||
    !recordHas(value, 'next_cursor') ||
    !isCursor(recordGet(value, 'next_cursor'))
  ) {
    throw new ReconcileRefused('page requires records, has_next_page and next_cursor');
  }
  const nextCursor = recordGet(value, 'next_cursor') as string | null;
  if (recordGet(value, 'has_next_page') !== (nextCursor !== null)) {
    throw new ReconcileRefused('inconsistent page completeness metadata');
  }
  if (nextCursor !== null && (nextCursor === cursor || history.includes(nextCursor))) {
    throw new ReconcileRefused('page cursor did not advance or cycled');
  }
  return { records: recordGet(value, 'records') as JsonValue[], nextCursor };
}

export interface ReconcileOptions {
  readonly repo: unknown;
  readonly after: unknown;
  readonly before: unknown;
  readonly pageBudget: unknown;
  readonly base?: unknown;
  /** `null`/absent starts a fresh checkpoint; a sealed snapshot resumes it. */
  readonly checkpointRaw?: unknown;
  readonly checkpointSave?: CheckpointSave;
  readonly dryRun?: unknown;
}

/**
 * `merged_reconcile.reconcile`: inventory up to `page_budget` reads over one
 * frozen interval. The initial snapshot is persisted before page one, each page
 * is persisted before the next fetch, and a save failure aborts the loop.
 */
export async function reconcile(
  pageFetch: PageFetch,
  options: ReconcileOptions,
): Promise<JsonObject> {
  const { repo, base } = validatedQuery(options.repo, options.base);
  const interval = normalizeInterval(options.after, options.before);
  const budget = normalizePageBudget(options.pageBudget);
  const dryRun = options.dryRun ?? false;
  if (!isJsonBool(dryRun) || (options.checkpointSave !== undefined && typeof options.checkpointSave !== 'function')) {
    throw new ReconcileRefused('invalid dry-run or checkpoint callback');
  }
  let checkpoint =
    options.checkpointRaw !== undefined && options.checkpointRaw !== null
      ? loadCheckpoint(options.checkpointRaw, interval, budget, repo, base)
      : newCheckpoint(interval, budget, repo, base);
  checkpoint = withObjectKeys(checkpoint, [
    ['dry_run', dryRun],
    ['steps', []],
  ]);

  const persist = async (): Promise<JsonObject> => {
    const snapshot = seal(checkpoint);
    if (options.checkpointSave !== undefined && !dryRun) {
      await options.checkpointSave(copyCheckpoint(snapshot));
    }
    return snapshot;
  };

  await persist();
  for (let index = 0; index < budget; index += 1) {
    if (counter(checkpoint, 'pages_read') >= BigInt(MAX_PAGES)) {
      throw new ReconcileRefused('page cap reached; restart with a smaller repository universe');
    }
    const cursorValue = recordGet(checkpoint, 'cursor');
    const cursor = cursorValue === null || cursorValue === undefined ? null : (cursorValue as string);
    let page: unknown;
    try {
      page = await pageFetch(cursor);
    } catch (error) {
      if (!(error instanceof PageFailed)) throw error;
      if (!(error instanceof BudgetExhausted)) {
        checkpoint = withObjectKeys(checkpoint, [
          [
            'transient_failures',
            JsonNumber.int(counter(checkpoint, 'transient_failures') + 1n),
          ],
        ]);
      }
      const steps = [...arrayAt(checkpoint, 'steps')];
      steps.push(
        new JsonObject([
          ['page', JsonNumber.int(counter(checkpoint, 'pages_read') + 1n)],
          ['outcome', error.reason],
          ['reason', error.message.slice(0, 200)],
          ['watermark_advanced', false],
        ]),
      );
      checkpoint = withObjectKeys(checkpoint, [['steps', steps]]);
      await persist();
      break;
    }
    const history = arrayAt(checkpoint, 'cursor_history').map((entry) => entry as string);
    const { records, nextCursor } = parsePage(page, cursor, history);
    checkpoint = reconcilePage(checkpoint, records);
    checkpoint = withObjectKeys(checkpoint, [
      ['cursor', nextCursor],
      ['complete', nextCursor === null],
    ]);
    if (nextCursor !== null) {
      const nextHistory = [...arrayAt(checkpoint, 'cursor_history'), nextCursor];
      checkpoint = withObjectKeys(checkpoint, [['cursor_history', nextHistory]]);
    }
    const steps = [...arrayAt(checkpoint, 'steps')];
    steps.push(
      new JsonObject([
        ['page', JsonNumber.int(counter(checkpoint, 'pages_read'))],
        ['records', JsonNumber.int(records.length)],
        ['outcome', 'read'],
        ['watermark_advanced', false],
      ]),
    );
    checkpoint = withObjectKeys(checkpoint, [['steps', steps]]);
    await persist();
    if (recordGet(checkpoint, 'complete') === true) break;
  }
  return seal(checkpoint);
}

/** `merged_reconcile.enrollment_plan`: deterministic Q1 bindings; no mutation. */
export function enrollmentPlan(
  result: unknown,
  options: {
    readonly repo: unknown;
    readonly existingRequests?: readonly unknown[];
    readonly dryRun?: unknown;
  },
): JsonObject {
  if (!isJsonRecord(result)) throw new ReconcileRefused('invalid inventory');
  const after = recordGet(result, 'after');
  const before = recordGet(result, 'before');
  const interval = normalizeInterval(after, before);
  const budget = normalizePageBudget(recordGet(result, 'page_budget'));
  const repo = options.repo;
  if (typeof repo !== 'string' || !REPOSITORY.test(repo)) {
    throw new ReconcileRefused('invalid repository or dry-run');
  }
  const baseValue = recordGet(result, 'base');
  if (typeof baseValue !== 'string') throw new ReconcileRefused('invalid inventory');
  const checkpoint = loadCheckpoint(result, interval, budget, repo, baseValue, true);
  if (recordGet(checkpoint, 'complete') !== true) {
    throw new ReconcileRefused(
      'incomplete inventory cannot authorize enrollment or watermark advancement',
    );
  }
  const dryRun = options.dryRun ?? true;
  if (!isJsonBool(dryRun)) throw new ReconcileRefused('invalid repository or dry-run');
  const inventory = arrayAt(checkpoint, 'inventory');
  if (
    inventory.some(
      (entry) =>
        isJsonRecord(entry) &&
        recordGet(entry, 'reason') === 'conflicting merge identity for one PR',
    )
  ) {
    throw new ReconcileRefused('conflicting source identity prevents enrollment');
  }
  const existing = options.existingRequests ?? [];
  const entries: JsonValue[] = [];
  for (const entry of inventory) {
    if (!isJsonRecord(entry)) throw new ReconcileRefused('checkpoint inventory malformed');
    if (recordGet(entry, 'disposition') !== 'intent') {
      entries.push(copyJson(entry as JsonValue));
      continue;
    }
    const subject = recordGet(entry, 'subject');
    if (!isJsonRecord(subject)) throw new ReconcileRefused('checkpoint intent malformed');
    const binding = withObjectKeys(subject as JsonObject, [['repo', repo]]);
    const requestId = `reconcile-${checkpointDigest(binding)}`.slice(0, 74);
    const already = existing.some((candidate) => pythonValueEqual(candidate, binding));
    entries.push(
      new JsonObject([
        ['disposition', already ? 'already-enrolled' : 'intent'],
        ['binding', binding],
        ['request_id', requestId],
      ]),
    );
  }
  return new JsonObject([
    ['version', JsonNumber.int(RECONCILE_VERSION)],
    ['dry_run', dryRun],
    ['after', interval.after],
    ['before', interval.before],
    ['inventory_digest', recordGet(checkpoint, 'digest') as JsonValue],
    ['entries', entries],
    ['reviewed', JsonNumber.int(0)],
  ]);
}

/** `merged_reconcile.freeze_source`: pin a finite all-state universe. */
export async function freezeSource(
  forge: ForgeQuery,
  options: { readonly repo: string; readonly base: string },
): Promise<JsonObject> {
  const body =
    'issues(last:1, states:[OPEN,CLOSED], orderBy:{field:CREATED_AT,direction:ASC}) ' +
    '{ totalCount nodes { number } } ' +
    'pullRequests(last:1, states:[OPEN,CLOSED,MERGED], orderBy:{field:CREATED_AT,direction:ASC}) ' +
    '{ totalCount nodes { number } }';
  const repository = repositoryOf(await forge(queryFor(options.repo, body)), options.repo);
  const numbers: bigint[] = [];
  let total = 0n;
  for (const field of ['issues', 'pullRequests']) {
    const connection = recordGet(repository, field);
    const nodes = isJsonRecord(connection) ? recordGet(connection, 'nodes') : undefined;
    const count = isJsonRecord(connection) ? recordGet(connection, 'totalCount') : undefined;
    if (!isJsonInt(count) || jsonIntValue(count) < 0n) {
      throw new ReconcileRefused('forge ceiling count missing');
    }
    const countValue = jsonIntValue(count);
    total += countValue;
    if (
      !Array.isArray(nodes) ||
      nodes.length > 1 ||
      (nodes.length > 0) !== (countValue > 0n)
    ) {
      throw new ReconcileRefused('forge ceiling connection incomplete');
    }
    for (const node of nodes) {
      const number = isJsonRecord(node) ? recordGet(node, 'number') : undefined;
      if (!isJsonInt(number) || jsonIntValue(number) <= 0n) {
        throw new ReconcileRefused('forge ceiling number malformed');
      }
      numbers.push(jsonIntValue(number));
    }
  }
  const ceiling = numbers.length === 0 ? 0n : numbers.reduce((max, value) => (value > max ? value : max));
  if (total !== ceiling) {
    throw new ReconcileRefused('ceiling/count mismatch; repository universe not proven');
  }
  if (ceiling > BigInt(MAX_REPOSITORY_NUMBER)) {
    throw new ReconcileRefused('repository number cap exceeded; operator partition required');
  }
  const repositoryId = recordGet(repository, 'id');
  return new JsonObject([
    ['version', JsonNumber.int(1)],
    ['method', 'all-number-slots-v1'],
    ['repo', options.repo],
    ['base', options.base],
    ['repository_id', repositoryId as JsonValue],
    ['ceiling', JsonNumber.int(ceiling)],
    ['window', JsonNumber.int(NUMBER_WINDOW)],
  ]);
}

/** `merged_reconcile.number_page`: validate every slot in one number window. */
export async function numberPage(
  forge: ForgeQuery,
  source: unknown,
  cursor: string | null,
  options: { readonly repo: string; readonly base: string },
): Promise<JsonObject> {
  if (
    !isJsonRecord(source) ||
    !pythonValueEqual(recordGet(source, 'version'), JsonNumber.int(1)) ||
    recordGet(source, 'method') !== 'all-number-slots-v1' ||
    recordGet(source, 'repo') !== options.repo ||
    recordGet(source, 'base') !== options.base ||
    !pythonValueEqual(recordGet(source, 'window'), JsonNumber.int(NUMBER_WINDOW)) ||
    typeof recordGet(source, 'repository_id') !== 'string' ||
    !isJsonInt(recordGet(source, 'ceiling')) ||
    jsonIntValue(recordGet(source, 'ceiling') as JsonNumber) < 0n ||
    jsonIntValue(recordGet(source, 'ceiling') as JsonNumber) > BigInt(MAX_REPOSITORY_NUMBER)
  ) {
    throw new ReconcileRefused('source query identity changed');
  }
  const ceiling = jsonIntValue(recordGet(source, 'ceiling') as JsonNumber);
  const digest = checkpointDigest(source);
  let start = 1n;
  if (cursor !== null) {
    try {
      const decoded = parseJsonValue(cursor);
      if (!(decoded instanceof JsonObject)) throw new Error('not an object');
      const next = decoded.get('next');
      if (!isJsonInt(next)) throw new Error('next is not an int');
      start = jsonIntValue(next);
      const expected = new JsonObject([
        ['source', digest],
        ['next', JsonNumber.int(start)],
      ]);
      if (
        !pythonValueEqual(decoded, expected) ||
        !(start > 1n && start <= ceiling) ||
        (start - 1n) % BigInt(NUMBER_WINDOW) !== 0n
      ) {
        throw new Error('cursor does not bind this source');
      }
    } catch {
      throw new ReconcileRefused('numeric cursor does not bind this source');
    }
  }
  const stop = ceiling < start + BigInt(NUMBER_WINDOW) - 1n ? ceiling : start + BigInt(NUMBER_WINDOW) - 1n;
  const fields: string[] = [];
  for (let number = start; number <= stop; number += 1n) {
    fields.push(
      `n${number.toString()}: issueOrPullRequest(number:${number.toString()}) ` +
        '{ __typename ... on Issue { number } ... on PullRequest ' +
        '{ number baseRefName mergedAt headRefOid mergeCommit { oid } } }',
    );
  }
  const repository = repositoryOf(await forge(queryFor(options.repo, fields.join(' '))), options.repo);
  if (recordGet(repository, 'id') !== recordGet(source, 'repository_id')) {
    throw new ReconcileRefused('repository was replaced');
  }
  const branches =
    options.base === DISCOVERY_SELECTOR ? DISCOVERY_BRANCHES : ([options.base] as const);
  const records: JsonValue[] = [];
  for (let number = start; number <= stop; number += 1n) {
    const node = recordGet(repository, `n${number.toString()}`);
    const nodeNumber = isJsonRecord(node) ? recordGet(node, 'number') : undefined;
    const typename = isJsonRecord(node) ? recordGet(node, '__typename') : undefined;
    if (
      !isJsonRecord(node) ||
      !isJsonInt(nodeNumber) ||
      jsonIntValue(nodeNumber) !== number ||
      (typename !== 'Issue' && typename !== 'PullRequest')
    ) {
      throw new ReconcileRefused('missing or mismatched numeric slot; completeness unavailable');
    }
    if (typename === 'PullRequest') {
      const baseRefName = recordGet(node, 'baseRefName');
      if (typeof baseRefName !== 'string' || !recordHas(node, 'mergedAt')) {
        throw new ReconcileRefused('PR state metadata incomplete');
      }
      const mergedAt = recordGet(node, 'mergedAt');
      if (mergedAt !== null && branches.includes(baseRefName)) records.push(node as JsonValue);
    }
  }
  const following = stop < ceiling ? stop + 1n : null;
  const nextCursor =
    following === null
      ? null
      : pythonJsonText(
          new JsonObject([
            ['source', digest],
            ['next', JsonNumber.int(following)],
          ]),
          {
            asciiOnly: true,
            sortKeys: true,
            keyOrder: 'code-point',
            indent: null,
            spacedSeparators: true,
          },
        );
  return new JsonObject([
    ['records', records],
    ['has_next_page', following !== null],
    ['next_cursor', nextCursor],
  ]);
}

const REPOSITORY = /^[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+$/u;
const BASE_QUERY = /^[A-Za-z0-9_.\/-]+$/;

/** `merged_reconcile.reconcile`'s repository/base validation. */
function validatedQuery(repo: unknown, base: unknown): { readonly repo: string; readonly base: string } {
  if (
    typeof repo !== 'string' ||
    !REPOSITORY.test(repo) ||
    typeof base !== 'string' ||
    !BASE_QUERY.test(base) ||
    base.length === 0 ||
    base.trim() !== base
  ) {
    throw new ReconcileRefused('invalid repository/base query');
  }
  return { repo, base };
}

function queryFor(repo: string, body: string): string {
  const slash = repo.indexOf('/');
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  const quoted = (value: string): string =>
    pythonJsonText(value, { asciiOnly: true, sortKeys: false, indent: null });
  return `query { repository(owner: ${quoted(owner)}, name: ${quoted(name)}) { id nameWithOwner ${body} } }`;
}

/** `merged_reconcile._repository`: fail-closed repository identity. */
function repositoryOf(
  response: unknown,
  repo: string,
): JsonRecordLike {
  if (
    !isJsonRecord(response) ||
    pyTruthy(recordGet(response, 'errors')) ||
    (recordHas(response, 'incomplete_results') &&
      recordGet(response, 'incomplete_results') !== false) ||
    (recordHas(response, 'truncated') && recordGet(response, 'truncated') !== false)
  ) {
    throw new ReconcileRefused('forge returned errors or incomplete data');
  }
  const data = recordGet(response, 'data');
  const repository = isJsonRecord(data) ? recordGet(data, 'repository') : undefined;
  const repositoryId = isJsonRecord(repository) ? recordGet(repository, 'id') : undefined;
  if (
    !isJsonRecord(repository) ||
    recordGet(repository, 'nameWithOwner') !== repo ||
    typeof repositoryId !== 'string' ||
    repositoryId.length === 0
  ) {
    throw new ReconcileRefused('forge repository identity missing or changed');
  }
  return repository;
}

/** Re-exported for tests that need the interval type without a second import. */
export type { ReconcileInterval };
