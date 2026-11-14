/**
 * Advisory review history and predecessor classification (`review_history.py`).
 *
 * The projection is descriptive: every value names its source, and a missing
 * Git object, shallow history or binary line count is `null` (unknown), never
 * zero. Nothing here grants review credit or establishes exact reuse; the only
 * scheduling effect is the repeat class the runner consumes.
 */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import { pyTruthy } from './queueDoc.js';
import { receiptJsonDigest } from './pythonJson.js';

export const MAX_ENTRIES = 50;
export const DEFAULT_LIMIT = 20;

/** A Git object or operation needed for an observation is unavailable. */
export class GitUnavailable extends Error {
  override readonly name: string = 'GitUnavailable';
}

/** Resolve Git argv in one clone; bytes, and `GitUnavailable` when unreadable. */
export type GitFn = (...args: string[]) => Promise<Uint8Array>;

function asObject(value: unknown): JsonObject | null {
  return value instanceof JsonObject ? value : null;
}

function objectOrEmpty(value: unknown): JsonObject {
  return value instanceof JsonObject ? value : new JsonObject([]);
}

function arrayOrEmpty(value: unknown): JsonValue[] {
  return Array.isArray(value) ? (value as JsonValue[]) : [];
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

function stringField(value: JsonObject, key: string): string | null {
  const found = value.get(key);
  return typeof found === 'string' ? found : null;
}

function itemId(item: JsonObject): string {
  const found = item.get('id');
  return typeof found === 'string' ? found : '';
}

function sameRepo(left: unknown, right: unknown): boolean {
  return (
    typeof left === 'string' &&
    typeof right === 'string' &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function identity(item: JsonObject): JsonObject {
  return objectOrEmpty(item.get('identity_inputs'));
}

function headOf(item: JsonObject): string | null {
  return stringField(identity(item), 'head_commit');
}

function treeOf(item: JsonObject): string | null {
  return stringField(identity(item), 'head_tree');
}

async function present(git: GitFn, rev: string | null): Promise<boolean> {
  if (rev === null || rev.length === 0) return false;
  try {
    await git('cat-file', '-e', `${rev}^{commit}`);
    return true;
  } catch (error) {
    if (error instanceof GitUnavailable) return false;
    throw error;
  }
}

async function shallow(git: GitFn): Promise<boolean | null> {
  try {
    return text(await git('rev-parse', '--is-shallow-repository')).trim() === 'true';
  } catch (error) {
    if (error instanceof GitUnavailable) return null;
    throw error;
  }
}

/** `review_history._ancestry`: a server claim only with complete history. */
async function ancestry(
  git: GitFn,
  priorHead: string | null,
  head: string | null,
): Promise<readonly [string, bigint | null]> {
  if (priorHead === null || priorHead.length === 0 || head === null || head.length === 0) {
    return ['unknown', null];
  }
  if (!(await present(git, priorHead)) || !(await present(git, head))) return ['unknown', null];
  if (priorHead === head) return ['same', 0n];
  if ((await shallow(git)) !== false) return ['unknown', null];
  try {
    const ahead = BigInt(text(await git('rev-list', '--count', `${priorHead}..${head}`)).trim());
    const behind = BigInt(text(await git('rev-list', '--count', `${head}..${priorHead}`)).trim());
    if (behind === 0n && ahead > 0n) return ['ancestral', ahead];
    if (ahead > 0n && behind > 0n) return ['unrelated', null];
    if (ahead === 0n && behind > 0n) return ['unrelated', null];
    return ['unknown', null];
  } catch (error) {
    if (error instanceof GitUnavailable || error instanceof SyntaxError) return ['unknown', null];
    throw error;
  }
}

/** `review_history._delta`: tree comparison only, hence `partial` for binaries. */
async function treeDelta(
  git: GitFn,
  priorTree: string | null,
  headTree: string | null,
): Promise<JsonObject> {
  const base: Array<readonly [string, JsonValue]> = [
    ['method', 'tree'],
    ['files', null],
    ['insertions', null],
    ['deletions', null],
    ['binary_files', null],
    ['partial', true],
  ];
  if (priorTree === null || headTree === null || !priorTree || !headTree) {
    return new JsonObject(base);
  }
  let raw: string;
  try {
    for (const tree of [priorTree, headTree]) await git('cat-file', '-e', `${tree}^{tree}`);
    raw = text(await git('diff', '--numstat', priorTree, headTree));
  } catch (error) {
    if (error instanceof GitUnavailable) return new JsonObject(base);
    throw error;
  }
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  let binary = 0;
  for (const line of raw.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    files += 1;
    if (parts[0] === '-' || parts[1] === '-') {
      binary += 1;
      continue;
    }
    const left = Number(parts[0]);
    const right = Number(parts[1]);
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
      binary += 1;
      continue;
    }
    insertions += left;
    deletions += right;
  }
  const known = binary === 0;
  return new JsonObject([
    ['method', 'tree'],
    ['files', JsonNumber.int(files)],
    ['insertions', known ? JsonNumber.int(insertions) : null],
    ['deletions', known ? JsonNumber.int(deletions) : null],
    ['binary_files', JsonNumber.int(binary)],
    ['partial', binary > 0],
  ]);
}

interface LinkedRow {
  item: string;
  requestId: string | null;
  generation: bigint;
  state: string | null;
  createdAt: string | null;
  headCommit: string | null;
  headTree: string | null;
  task: string | null;
  branch: string | null;
  sameTask: boolean;
  sameBranch: boolean;
  relationship: 'ancestral' | 'possible' | 'unrelated';
  ancestry: 'server' | 'client' | null;
  commitsAhead: bigint | null;
  delta: JsonObject | null;
}

function rowObject(row: LinkedRow): JsonObject {
  return new JsonObject([
    ['item', row.item],
    ['request_id', row.requestId],
    ['generation', JsonNumber.int(row.generation)],
    ['state', row.state],
    ['created_at', row.createdAt],
    ['head_commit', row.headCommit],
    ['head_tree', row.headTree],
    ['task', row.task],
    ['branch', row.branch],
    ['same_task', row.sameTask],
    ['same_branch', row.sameBranch],
    ['relationship', row.relationship],
    ['ancestry', row.ancestry],
    ['commits_ahead', row.commitsAhead === null ? null : JsonNumber.int(row.commitsAhead)],
    ['delta', row.delta],
  ]);
}

function relationshipOf(relation: string): 'ancestral' | 'possible' | 'unrelated' {
  if (relation === 'ancestral' || relation === 'same') return 'ancestral';
  if (relation === 'unknown') return 'possible';
  return 'unrelated';
}

async function entriesFor(
  queue: JsonObject,
  query: {
    repo: string;
    target: string;
    task: string | null;
    branch: string | null;
    predecessor: string | null;
    head: string | null;
    headTree: string | null;
    excludeItem: string | null;
  },
  git: GitFn,
): Promise<LinkedRow[]> {
  const requests = objectOrEmpty(queue.get('review_requests'));
  const byItem = new Map<string, string>();
  for (const [requestId, bindingValue] of requests.entries) {
    const binding = asObject(bindingValue);
    const item = binding === null ? null : binding.get('item');
    if (typeof item === 'string' && !byItem.has(item)) byItem.set(item, requestId);
  }
  const linked: LinkedRow[] = [];
  for (const entry of arrayOrEmpty(queue.get('items'))) {
    const item = asObject(entry);
    if (item === null || item.get('kind') !== 'local-review') continue;
    if (query.excludeItem !== null && itemId(item) === query.excludeItem) continue;
    const inputs = identity(item);
    if (!sameRepo(inputs.get('repo'), query.repo)) continue;
    const explicit = query.predecessor !== null && byItem.get(itemId(item)) === query.predecessor;
    const itemTarget = item.get('target');
    if (itemTarget === null || itemTarget === undefined) {
      if (!explicit) continue;
    } else if (itemTarget !== query.target) continue;
    const priorHead = stringField(inputs, 'head_commit');
    const sameTask = explicit || (query.task !== null && item.get('task') === query.task);
    const sameBranch =
      explicit ||
      (query.branch !== null &&
        query.branch !== query.target &&
        item.get('branch') === query.branch);
    if (!(sameTask || sameBranch)) continue;
    const [relation, distance] = await ancestry(git, priorHead, query.head);
    const treeAvailable = treeOf(item) !== null && query.headTree !== null;
    linked.push({
      item: itemId(item),
      requestId: byItem.get(itemId(item)) ?? null,
      generation:
        item.get('generation') instanceof JsonNumber &&
        (item.get('generation') as JsonNumber).kind === 'int'
          ? ((item.get('generation') as JsonNumber).integer ?? 1n)
          : 1n,
      state: stringField(item, 'state'),
      createdAt: stringField(item, 'created_at'),
      headCommit: priorHead,
      headTree: treeOf(item),
      task: stringField(item, 'task'),
      branch: stringField(item, 'branch'),
      sameTask,
      sameBranch,
      relationship: relationshipOf(relation),
      ancestry: ['ancestral', 'same', 'unrelated'].includes(relation) ? 'server' : null,
      commitsAhead: distance,
      delta: treeAvailable ? await treeDelta(git, treeOf(item), query.headTree) : null,
    });
  }
  linked.sort((left, right) => {
    const a = `${left.createdAt ?? ''}\u0000${left.item}`;
    const b = `${right.createdAt ?? ''}\u0000${right.item}`;
    return a < b ? 1 : a > b ? -1 : 0;
  });
  return linked;
}

function summary(queue: JsonObject, linked: readonly LinkedRow[]): JsonObject {
  const itemIds = new Set(linked.map((row) => row.item));
  const requests = objectOrEmpty(queue.get('review_requests'));
  let requestCount = 0;
  for (const [, bindingValue] of requests.entries) {
    const binding = asObject(bindingValue);
    if (
      binding !== null &&
      typeof binding.get('item') === 'string' &&
      itemIds.has(binding.get('item') as string)
    ) {
      requestCount += 1;
    }
  }
  let invocations = 0;
  let completed = 0;
  let failed = 0;
  for (const entry of arrayOrEmpty(queue.get('items'))) {
    const item = asObject(entry);
    if (item === null || !itemIds.has(itemId(item))) continue;
    invocations += arrayOrEmpty(item.get('attempts')).length + (pyTruthy(item.get('run')) ? 1 : 0);
    if (
      item.get('state') === 'done' &&
      item.get('scope_adequate') === true &&
      typeof item.get('receipt_id') === 'string' &&
      item.get('receipt_id')
    ) {
      completed += 1;
    }
    const failures = item.get('failures');
    if (failures instanceof JsonNumber && failures.kind === 'int' && failures.integer !== null) {
      failed += Number(failures.integer);
    }
  }
  return new JsonObject([
    ['requests', JsonNumber.int(requestCount)],
    ['invocations', JsonNumber.int(invocations)],
    ['completed', JsonNumber.int(completed)],
    ['failed', JsonNumber.int(failed)],
  ]);
}

function cue(
  predecessor: LinkedRow | null,
  delta: JsonObject | null,
  totals: JsonObject,
  repeat: boolean,
): string | null {
  if (predecessor === null) return null;
  const head = (predecessor.headCommit ?? '').slice(0, 12);
  const completed =
    totals.get('completed') instanceof JsonNumber
      ? ((totals.get('completed') as JsonNumber).integer ?? 0n).toString()
      : '0';
  if (predecessor.relationship === 'possible') {
    return `Possible earlier review at ${head} (task/branch continuity, ancestry unverified). ${completed} CodeRabbit review(s) completed for this work.`;
  }
  const since: string[] = [];
  if (delta === null || delta.get('commits_ahead') === null) {
    since.push('commit distance unknown (shallow or missing history)');
  } else {
    const commits = (delta.get('commits_ahead') as JsonNumber).integer ?? 0n;
    since.push(
      `${commits.toString()} commit${commits === 1n ? '' : 's'} (${predecessor.ancestry}-verified)`,
    );
  }
  if (delta !== null && delta.get('files') !== null) {
    since.push(`${String((delta.get('files') as JsonNumber).integer)} files`);
  }
  if (delta !== null && delta.get('insertions') !== null) {
    since.push(
      `+${String((delta.get('insertions') as JsonNumber).integer)}/-${String((delta.get('deletions') as JsonNumber).integer)} (tree comparison)`,
    );
  } else if (delta !== null) {
    since.push('line counts unknown (binary or missing trees)');
  }
  let result = `Previously reviewed at ${head}. Since then: ${since.join(', ')}. ${completed} CodeRabbit review(s) completed for this work.`;
  if (repeat) {
    result += ' This request will wait behind first reviews. It is queued; keep working or wait.';
  }
  return result;
}

export interface HistoryProjectInput {
  readonly repo: string;
  readonly target: string;
  readonly headCommit: string | null;
  readonly headTree: string | null;
  readonly task: string | null;
  readonly branch: string | null;
  readonly predecessor: string | null;
  readonly observed: JsonObject | null;
  readonly limit: number;
  readonly cursor: number;
  readonly git: GitFn;
  readonly excludeItem: string | null;
}

function historyMaterial(
  relation: string,
  repeat: boolean,
  totals: JsonObject,
  delta: JsonObject | null,
  headline: LinkedRow | null,
): JsonValue {
  return new JsonObject([
    ['relation', relation],
    ['repeat', repeat],
    ['summary', totals],
    ['delta', delta],
    [
      'predecessor',
      headline === null
        ? null
        : new JsonObject([
            ['item', headline.item],
            ['head_commit', headline.headCommit],
            ['ancestry', headline.ancestry],
            ['relationship', headline.relationship],
            [
              'commits_ahead',
              headline.commitsAhead === null ? null : JsonNumber.int(headline.commitsAhead),
            ],
          ]),
    ],
  ]);
}

/** `review_history.project`: one advisory projection, no scheduling authority. */
export async function projectHistory(
  queue: JsonObject,
  input: HistoryProjectInput,
): Promise<JsonObject> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_ENTRIES) {
    throw new Error('history limit must be an integer from 1 to 50');
  }
  if (!Number.isInteger(input.cursor) || input.cursor < 0) {
    throw new Error('history cursor must be a non-negative integer');
  }
  let branch = input.branch;
  if (branch !== null && branch === input.target) branch = null;
  const linked = await entriesFor(
    queue,
    {
      repo: input.repo,
      target: input.target,
      task: input.task,
      branch,
      predecessor: input.predecessor,
      head: input.headCommit,
      headTree: input.headTree,
      excludeItem: input.excludeItem,
    },
    input.git,
  );
  if (input.predecessor !== null) {
    const requests = objectOrEmpty(queue.get('review_requests'));
    const binding = asObject(requests.get(input.predecessor));
    const wanted = binding === null ? null : binding.get('item');
    if (
      typeof wanted === 'string' &&
      wanted !== input.excludeItem &&
      !linked.some((row) => row.item === wanted)
    ) {
      for (const entry of arrayOrEmpty(queue.get('items'))) {
        const item = asObject(entry);
        if (item === null || itemId(item) !== wanted || item.get('kind') !== 'local-review')
          continue;
        const inputs = identity(item);
        if (!sameRepo(inputs.get('repo'), input.repo)) break;
        const itemTarget = item.get('target');
        if (itemTarget !== null && itemTarget !== undefined && itemTarget !== input.target) break;
        const [relation, distance] = await ancestry(input.git, headOf(item), input.headCommit);
        linked.push({
          item: wanted,
          requestId: input.predecessor,
          generation:
            item.get('generation') instanceof JsonNumber
              ? ((item.get('generation') as JsonNumber).integer ?? 1n)
              : 1n,
          state: stringField(item, 'state'),
          createdAt: stringField(item, 'created_at'),
          headCommit: headOf(item),
          headTree: treeOf(item),
          task: stringField(item, 'task'),
          branch: stringField(item, 'branch'),
          sameTask: true,
          sameBranch: true,
          relationship: relationshipOf(relation),
          ancestry: ['ancestral', 'same', 'unrelated'].includes(relation) ? 'server' : null,
          commitsAhead: distance,
          delta: await treeDelta(input.git, treeOf(item), input.headTree),
        });
        linked.sort((left, right) => {
          const a = `${left.createdAt ?? ''}\u0000${left.item}`;
          const b = `${right.createdAt ?? ''}\u0000${right.item}`;
          return a < b ? 1 : a > b ? -1 : 0;
        });
        break;
      }
    }
  }
  if (input.observed !== null && input.predecessor !== null) {
    const ancestor = input.observed.get('ancestor');
    const commits = input.observed.get('commits_ahead');
    for (const row of linked) {
      if (row.requestId !== input.predecessor || row.ancestry !== null) continue;
      if (ancestor === true) {
        row.relationship = 'ancestral';
        row.ancestry = 'client';
        row.commitsAhead =
          commits instanceof JsonNumber && commits.kind === 'int' ? commits.integer : null;
      } else if (ancestor === false) {
        row.relationship = 'unrelated';
        row.ancestry = 'client';
      }
    }
  }
  const ancestral = linked
    .filter((row) => row.relationship === 'ancestral')
    .sort((left, right) => {
      const a = left.commitsAhead === null ? 1 : 0;
      const b = right.commitsAhead === null ? 1 : 0;
      if (a !== b) return a - b;
      const av = left.commitsAhead ?? 0n;
      const bv = right.commitsAhead ?? 0n;
      if (av !== bv) return av < bv ? -1 : 1;
      const ac = left.createdAt ?? '';
      const bc = right.createdAt ?? '';
      return ac < bc ? -1 : ac > bc ? 1 : 0;
    });
  let headline =
    input.predecessor === null
      ? null
      : (linked.find(
          (row) => row.requestId === input.predecessor && row.relationship === 'ancestral',
        ) ?? null);
  headline = headline ?? ancestral[0] ?? null;
  if (headline === null) {
    headline = linked.find((row) => row.relationship === 'possible') ?? null;
  }
  const totals = summary(queue, linked);
  const repeat =
    headline !== null &&
    headline.relationship === 'ancestral' &&
    headline.commitsAhead !== 0n &&
    (headline.sameTask || (headline.sameBranch && headline.branch !== input.target));
  const relation =
    headline === null ? 'none' : headline.relationship === 'ancestral' ? 'ancestral' : 'possible';
  let delta = headline === null ? null : headline.delta;
  if (headline !== null && delta !== null && headline.commitsAhead !== null) {
    delta = withFields(delta, [
      ['commits_ahead', JsonNumber.int(headline.commitsAhead)],
      ['ancestry', headline.ancestry],
    ]);
  } else if (headline !== null) {
    delta = withFields(
      delta ??
        new JsonObject([
          ['method', 'tree'],
          ['files', null],
          ['insertions', null],
          ['deletions', null],
          ['binary_files', null],
          ['partial', true],
        ]),
      [
        ['commits_ahead', null],
        ['ancestry', headline.ancestry],
      ],
    );
  }
  const scope = input.task !== null ? 'task' : branch !== null ? 'branch' : 'none';
  const page = linked.slice(input.cursor, input.cursor + input.limit);
  const nextCursor = input.cursor + input.limit < linked.length ? input.cursor + input.limit : null;
  const material = historyMaterial(relation, repeat, totals, delta, headline);
  return new JsonObject([
    ['v', JsonNumber.int(1)],
    ['status', 'ok'],
    ['scope', scope],
    ['relation', relation],
    ['repeat', repeat],
    ['predecessor', headline === null ? null : predecessorObject(headline)],
    ['delta', delta],
    ['summary', totals],
    ['cue', cue(headline, delta, totals, repeat)],
    ['entries', page.map(rowObject)],
    ['cursor', JsonNumber.int(input.cursor)],
    ['next_cursor', nextCursor === null ? null : JsonNumber.int(nextCursor)],
    ['digest', receiptJsonDigest(material)],
  ]);
}

function predecessorObject(row: LinkedRow): JsonObject {
  return new JsonObject([
    ['request_id', row.requestId],
    ['item', row.item],
    ['generation', JsonNumber.int(row.generation)],
    ['state', row.state],
    ['created_at', row.createdAt],
    ['head_commit', row.headCommit],
    ['head_tree', row.headTree],
    ['same_task', row.sameTask],
    ['same_branch', row.sameBranch],
    ['relationship', row.relationship],
    ['ancestry', row.ancestry],
    ['commits_ahead', row.commitsAhead === null ? null : JsonNumber.int(row.commitsAhead)],
  ]);
}

function withFields(
  object: JsonObject,
  updates: ReadonlyArray<readonly [string, JsonValue]>,
): JsonObject {
  const map = new Map(updates);
  const entries = object.entries.map(
    ([key, value]) => [key, map.has(key) ? (map.get(key) as JsonValue) : value] as const,
  );
  for (const [key, value] of updates) if (!object.has(key)) entries.push([key, value] as const);
  return new JsonObject(entries);
}

/** `review_history.degraded`: advisory failure, exact reuse unaffected. */
export function degradedHistory(reason: string): JsonObject {
  return new JsonObject([
    ['v', JsonNumber.int(1)],
    ['status', 'degraded'],
    ['reason', reason],
    ['scope', 'none'],
    ['relation', 'none'],
    ['repeat', false],
    ['predecessor', null],
    ['delta', null],
    ['summary', null],
    ['cue', null],
    ['entries', []],
    ['cursor', JsonNumber.int(0)],
    ['next_cursor', null],
    [
      'digest',
      receiptJsonDigest(
        new JsonObject([
          ['status', 'degraded'],
          ['reason', reason],
        ]),
      ),
    ],
  ]);
}

/** `review_transport.history_cue`: the compact cue carried by submit/status. */
export function historyCue(projection: JsonObject): JsonObject {
  let result = new JsonObject([
    ['v', JsonNumber.int(1)],
    ['digest', projection.get('digest') ?? null],
    ['status', projection.get('status') ?? null],
  ]);
  for (const key of ['cue', 'reason']) {
    const value = projection.get(key);
    if (value !== null && value !== undefined) result = withFields(result, [[key, value]]);
  }
  return result;
}

/** `review_transport.history_query`: stored request/item facts only. */
export function historyQuery(
  queue: JsonObject,
  binding: JsonObject,
): {
  readonly repo: string;
  readonly target: string;
  readonly headCommit: string | null;
  readonly headTree: string | null;
  readonly task: string | null;
  readonly branch: string | null;
  readonly predecessor: string | null;
  readonly observed: JsonObject | null;
  readonly excludeItem: string;
} {
  const itemId = binding.get('item');
  const item =
    typeof itemId === 'string'
      ? (arrayOrEmpty(queue.get('items'))
          .map(asObject)
          .find((candidate) => candidate !== null && candidate.get('id') === itemId) ?? null)
      : null;
  if (item === null) throw new Error('unknown review item');
  const inputs = identity(item);
  const repo = inputs.get('repo');
  if (typeof repo !== 'string') throw new Error('review item has no repository');
  const target = item.get('target');
  const task = binding.get('task') ?? item.get('task');
  const branch = binding.get('branch') ?? item.get('branch');
  const predecessor = binding.get('predecessor');
  const observed = binding.get('observed');
  return {
    repo,
    target: typeof target === 'string' ? target : '',
    headCommit: stringField(inputs, 'head_commit'),
    headTree: stringField(inputs, 'head_tree'),
    task: typeof task === 'string' ? task : null,
    branch: typeof branch === 'string' ? branch : null,
    predecessor: typeof predecessor === 'string' ? predecessor : null,
    observed: observed instanceof JsonObject ? observed : null,
    excludeItem: itemId as string,
  };
}
