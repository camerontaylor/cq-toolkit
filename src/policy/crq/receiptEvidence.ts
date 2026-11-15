/**
 * The PR-evidence readers of `crq_review_receipt`: the receipt binding marker,
 * paginated review rows, ownership of a receipt, the inline-major proofs, the
 * paginated GraphQL thread inventory, the current merge base and `prior_receipt`.
 *
 * All reads go through the injected synchronous `gh` port (as Python's `prf._json`
 * does), so nothing here touches the network or the filesystem. Python's
 * `ThreadsNotVisible` is a RuntimeError subclass; a RuntimeError is
 * {@link PrReviewRuntimeError}. Inactive: nothing imports this yet.
 */
import { JsonNumber, JsonObject, parseJsonValue, type JsonValue } from './jsonValue.js';
import { ledgerPythonTypeName } from './ledger.js';
import {
  PrReviewAttributeError,
  PrReviewRuntimeError,
  PrReviewTypeError,
  PrReviewValueError,
  callGh,
  ghString,
  marker,
  okGh,
  parseGhJson,
  pythonRepr,
  pythonStr,
  type GhPort,
} from './prReviewFindings.js';
import { pythonEqual } from './receiptIdentity.js';
import { pythonJsonText } from './pythonJson.js';
import { pythonStrip, pythonTruthy } from './repairBinding.js';

export const PREFIX = '<!-- crq-review-output ';
export const INLINE_PREFIX = '<!-- crq-review-inline-major ';
const UNATTESTED = 'Unattested: App identity unavailable; posted with the host account.';
const ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

/** Expected receipt evidence has no visible thread yet; keep delivery pending. */
export class ThreadsNotVisible extends PrReviewRuntimeError {
  override readonly name: string = 'ThreadsNotVisible';
}

/** Python `KeyError`: a missing mapping key. */
export class ReceiptKeyError extends Error {
  override readonly name: string = 'ReceiptKeyError';
  readonly pythonError = 'KeyError';

  constructor(key: string) {
    super(`'${key}'`);
  }
}

const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
/** Python `$` also matches before one trailing newline. */
const THREAD =
  /\n<!-- crq-review-thread run=([A-Za-z0-9._-]+) head=([0-9a-f]{40}) finding=([0-9a-f]{64}) -->(?=\n?$)/;

// ------------------------------------------------------------ python shapes

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left instanceof JsonObject || right instanceof JsonObject) {
    if (!(left instanceof JsonObject) || !(right instanceof JsonObject)) return false;
    if (left.entries.length !== right.entries.length) return false;
    return left.entries.every(([key, value]) => {
      const other = right.get(key);
      return other !== undefined && jsonEqual(value, other);
    });
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonEqual(value, right[index] as JsonValue));
  }
  return pythonEqual(left, right);
}

/** `value in {…strings…}`: an unhashable value raises, anything else compares. */
function inSet(value: JsonValue | undefined, members: readonly string[]): boolean {
  if (Array.isArray(value) || value instanceof JsonObject)
    throw new PrReviewTypeError(`unhashable type: '${ledgerPythonTypeName(value)}'`);
  return typeof value === 'string' && members.includes(value);
}

function isPythonInt(value: JsonValue | undefined): boolean {
  return value instanceof JsonNumber && value.kind === 'int';
}

/** `value or {}` followed by `.get`: a truthy non-mapping has no `.get`. */
function mapping(value: JsonValue | undefined): JsonObject {
  if (!pythonTruthy(value)) return new JsonObject([]);
  if (value instanceof JsonObject) return value;
  throw new PrReviewAttributeError(
    `'${ledgerPythonTypeName(value as JsonValue)}' object has no attribute 'get'`,
  );
}

function text(value: JsonValue | undefined, method: string): string {
  if (typeof value === 'string') return value;
  throw new PrReviewAttributeError(
    `'${ledgerPythonTypeName((value ?? null) as JsonValue)}' object has no attribute '${method}'`,
  );
}

function required(meta: JsonObject, key: string): JsonValue {
  const value = meta.get(key);
  if (value === undefined) throw new ReceiptKeyError(key);
  return value;
}

/** `re.finditer(re.escape(prefix) + r'(.*?) -->', body)` (`.` excludes only `\n`). */
function* captures(body: string, prefix: string): Generator<string> {
  const pattern = new RegExp(`${escape(prefix)}([^\\n]*?) -->`, 'g');
  for (let found = pattern.exec(body); found !== null; found = pattern.exec(body)) {
    yield found[1] as string;
    if (found[0] === '') pattern.lastIndex += 1;
  }
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadJson(textValue: string): JsonValue {
  try {
    return parseJsonValue(textValue, { duplicates: 'last' });
  } catch (error) {
    if (error instanceof SyntaxError) throw new PrReviewValueError('invalid JSON');
    throw error;
  }
}

// ----------------------------------------------------------------- binding

/** `binding(meta, pr)`: the identity a receipt is bound to. */
export function binding(meta: JsonObject, pr: number): JsonObject {
  return new JsonObject([
    ['pr', JsonNumber.int(BigInt(pr))],
    ['run_id', required(meta, 'run_id')],
    ['base', required(meta, 'base')],
    ['head', required(meta, 'head')],
  ]);
}

/** `binding_marker(value)`. */
export function bindingMarker(value: JsonValue): string {
  return `${PREFIX}${pythonJsonText(value, { asciiOnly: true, sortKeys: true, keyOrder: 'code-point' })} -->`;
}

// ----------------------------------------------------------------- reviews

/** `reviews(prf, gh, repo, pr)`: every review row, paginated, with str body and dict user. */
export function reviews(gh: GhPort, repo: string, pr: number): JsonObject[] {
  const argv = [
    'gh',
    'api',
    '--paginate',
    '--slurp',
    `repos/${repo}/pulls/${pr}/reviews?per_page=100`,
  ];
  const pages = parseGhJson(argv, callGh(gh, argv, null));
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
    throw new PrReviewRuntimeError('incomplete PR review pagination');
  const rows: JsonObject[] = [];
  for (const page of pages as JsonValue[][]) {
    for (const row of page) {
      if (!(row instanceof JsonObject) || !isPythonInt(row.get('id')))
        throw new PrReviewRuntimeError('invalid PR review identity');
      const bodyRaw = row.get('body');
      const body = pythonTruthy(bodyRaw) ? (bodyRaw as JsonValue) : '';
      const userRaw = row.get('user');
      const user = pythonTruthy(userRaw) ? (userRaw as JsonValue) : new JsonObject([]);
      if (typeof body !== 'string' || !(user instanceof JsonObject))
        throw new PrReviewRuntimeError('invalid PR review metadata');
      rows.push(
        new JsonObject([
          ...row.entries.filter(([key]) => key !== 'body' && key !== 'user'),
          ['body', body],
          ['user', user],
        ]),
      );
    }
  }
  return rows;
}

/** `owned_receipt(row, login)`. */
export function ownedReceipt(row: JsonObject, login: string): boolean {
  const user = mapping(row.get('user'));
  const rawAuthor = user.get('login');
  const author = pythonTruthy(rawAuthor) ? (rawAuthor as JsonValue) : '';
  if (inSet(author, [login, 'cq-review[bot]'])) return true;
  const body = row.get('body') as string;
  if (!body.includes(UNATTESTED)) return false;
  if (!pythonTruthy(author)) return false;
  if (text(author, 'endswith').endsWith('[bot]')) return false;
  return inSet(row.get('author_association'), ASSOCIATIONS);
}

// ------------------------------------------------------ inline-major proofs

interface Source {
  readonly review_id: JsonValue;
  readonly url: JsonValue;
}

type ExpectedKey = readonly [string, string, string];
export type Expected = Map<string, { key: ExpectedKey; sources: Source[] }>;

const keyOf = (parts: ExpectedKey): string => JSON.stringify(parts);
const sourceRepr = (source: Source): string =>
  `{'review_id': ${pythonRepr(source.review_id)}, 'url': ${pythonRepr(source.url)}}`;
const sourceJson = (source: Source): JsonValue =>
  new JsonObject([
    ['review_id', source.review_id],
    ['url', source.url],
  ]);

/** `expected_inline_major`: all post-change scans of this PR, earlier heads included. */
export function expectedInlineMajor(rows: JsonObject[], pr: number, login: string): Expected {
  const expected: Expected = new Map();
  for (const row of rows) {
    if (!ownedReceipt(row, login)) continue;
    const body = row.get('body') as string;
    const source: Source = {
      review_id: row.get('id') as JsonValue,
      url: row.get('html_url') ?? null,
    };
    for (const raw of captures(body, PREFIX)) {
      try {
        const bound = loadJson(raw);
        if (!(bound instanceof JsonObject))
          throw new PrReviewAttributeError("object has no attribute 'get'");
        const prValue = bound.get('pr');
        if (prValue !== undefined && jsonEqual(prValue, JsonNumber.int(BigInt(pr)))) {
          const head = required(bound, 'head');
          if (typeof head !== 'string' || !SHA40.test(head)) throw new PrReviewValueError('head');
          const proof = [...captures(body, INLINE_PREFIX)][0];
          if (proof === undefined) {
            throw new ThreadsNotVisible(
              `CRQ inline-major receipt proof unavailable; source=${sourceRepr(source)} run=${pythonStr(bound.get('run_id') ?? null)} head=${head}; retry`,
            );
          }
          const value = loadJson(proof);
          if (!(value instanceof JsonObject)) throw new PrReviewAttributeError('get');
          const runId = required(bound, 'run_id');
          const findings = required(value, 'findings');
          if (
            !jsonEqual(required(value, 'run_id'), runId) ||
            !jsonEqual(required(value, 'head'), head) ||
            !Array.isArray(findings) ||
            findings.some((key) => typeof key !== 'string' || !SHA64.test(key))
          )
            throw new PrReviewValueError('proof');
          if (Array.isArray(runId) || runId instanceof JsonObject)
            throw new PrReviewTypeError('unhashable');
          for (const finding of findings as string[]) {
            const key: ExpectedKey = [
              typeof runId === 'string' ? runId : `\u0000${pythonRepr(runId)}`,
              head,
              finding,
            ];
            const slot = expected.get(keyOf(key)) ?? { key, sources: [] };
            slot.sources.push(source);
            expected.set(keyOf(key), slot);
          }
        }
      } catch (error) {
        if (error instanceof ThreadsNotVisible) throw error;
        throw new ThreadsNotVisible(
          `invalid CRQ inline-major receipt proof; source=${sourceRepr(source)}; investigate`,
        );
      }
    }
  }
  return expected;
}

/** `body_major_at_head`: only post-change CRQ receipt evidence holds a head across scans. */
export function bodyMajorAtHead(
  rows: JsonObject[],
  pr: number,
  head: JsonValue,
  login: string,
): boolean {
  for (const row of rows) {
    if (!ownedReceipt(row, login)) continue;
    const body = row.get('body') as string;
    for (const raw of captures(body, PREFIX)) {
      let found: JsonValue;
      try {
        found = loadJson(raw);
      } catch {
        throw new PrReviewValueError('malformed CRQ receipt binding');
      }
      if (!(found instanceof JsonObject))
        throw new PrReviewValueError('malformed CRQ receipt binding');
      const foundPr = found.get('pr');
      const foundHead = found.get('head');
      if (
        foundPr === undefined ||
        !jsonEqual(foundPr, JsonNumber.int(BigInt(pr))) ||
        foundHead === undefined ||
        !jsonEqual(foundHead, head)
      )
        continue;
      for (const scope of ['whole-pr-success', 'narrow-success']) {
        const run = found.get('run_id');
        if (
          body.includes(
            `<!-- crq-review-scan run=${pythonStr(run ?? null)} ${scope} body-major=1 -->`,
          )
        )
          return true;
      }
    }
  }
  return false;
}

// --------------------------------------------------------- prior receipt

/** `prior_receipt`: the run's earlier receipt review, or null. */
export function priorReceipt(
  gh: GhPort,
  repo: string,
  pr: number,
  meta: JsonObject,
  login: string,
): JsonObject | null {
  const wanted = binding(meta, pr);
  const runId = required(meta, 'run_id');
  const lead = `${marker(runId as string)}\n`;
  for (const row of reviews(gh, repo, pr)) {
    const body = row.get('body') as string;
    const user = row.get('user') as JsonObject;
    if (!inSet(user.get('login'), [login, 'cq-review[bot]'])) continue;
    const found = (): JsonObject =>
      new JsonObject([
        ['id', row.get('id') as JsonValue],
        ['url', row.get('html_url') ?? null],
        ['login', user.get('login') ?? null],
        ['body', body],
      ]);
    if (body.startsWith(lead) && !body.includes(PREFIX)) {
      if (
        !body.includes(`${pythonStr(required(meta, 'base'))}..${pythonStr(required(meta, 'head'))}`)
      )
        throw new PrReviewValueError('changed legacy CRQ review binding');
      return found();
    }
    for (const raw of captures(body, PREFIX)) {
      let bound: JsonValue;
      try {
        bound = loadJson(raw);
      } catch {
        throw new PrReviewValueError('malformed CRQ receipt binding');
      }
      if (!(bound instanceof JsonObject))
        throw new PrReviewValueError('malformed CRQ receipt binding');
      const boundRun = bound.get('run_id');
      if (boundRun !== undefined && !jsonEqual(boundRun, runId)) continue;
      if (boundRun === undefined && wanted.get('run_id') !== undefined && !(runId === null)) {
        // `found.get('run_id')` is None; None != wanted['run_id'] unless that is None too.
        continue;
      }
      if (!jsonEqual(bound, wanted)) throw new PrReviewValueError('changed CRQ receipt binding');
      if (!body.startsWith(`${lead}${bindingMarker(wanted)}`))
        throw new PrReviewValueError('misplaced CRQ receipt binding');
      return found();
    }
  }
  return null;
}

// ---------------------------------------------------------- thread inventory

function visibilityWait(
  expected: Expected,
  visible: Set<string>,
  repo: string,
  pr: number,
  reason: string,
): ThreadsNotVisible {
  const missing = [...expected.values()]
    .filter(({ key }) => !visible.has(keyOf(key)))
    .sort((a, b) => compareTuple(a.key, b.key))
    .map(
      ({ key, sources }) =>
        new JsonObject([
          ['run_id', key[0]],
          ['head', key[1]],
          ['finding', key[2]],
          ['receipts', sources.map(sourceJson)],
        ]),
    );
  const sources = [...expected.values()].flatMap(({ sources: list }) => list.map(sourceJson));
  const context = new JsonObject([
    ['repo', repo],
    ['pr', JsonNumber.int(BigInt(pr))],
    ['missing', missing],
    ['source_receipts', sources],
  ]);
  return new ThreadsNotVisible(`${reason}: ${compactSpaced(context)}`);
}

const compareTuple = (a: ExpectedKey, b: ExpectedKey): number => {
  for (let index = 0; index < 3; index += 1) {
    const left = Array.from(a[index] as string).map((c) => c.codePointAt(0) as number);
    const right = Array.from(b[index] as string).map((c) => c.codePointAt(0) as number);
    const length = Math.min(left.length, right.length);
    for (let at = 0; at < length; at += 1) {
      const diff = (left[at] as number) - (right[at] as number);
      if (diff !== 0) return diff;
    }
    if (left.length !== right.length) return left.length - right.length;
  }
  return 0;
};

function compactSpaced(value: JsonValue): string {
  return pythonJsonText(value, {
    asciiOnly: true,
    sortKeys: true,
    keyOrder: 'code-point',
    spacedSeparators: true,
  });
}

const QUERY = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String){
          repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100,after:$cursor){
            pageInfo{hasNextPage endCursor} nodes{id isResolved comments(first:1){nodes{body author{login __typename} pullRequestReview{body authorAssociation author{login __typename}}}}}
          }}}}`;

const OPEN_FINDING = /^\*\*crq finding F\p{Nd}+ \[(major|critical|blocker|fatal)\]\*\*/iu;

/** One thread's contribution: `visible`/`has_open` updates in Python's order. */
function inspectThread(
  thread: JsonValue,
  login: string,
  expected: Expected,
  visible: Set<string>,
): boolean {
  if (!(thread instanceof JsonObject)) throw new PrReviewTypeError('thread');
  const comments = mapping(thread.get('comments'));
  const nodes = comments.get('nodes');
  if (nodes === undefined) throw new ReceiptKeyError('nodes');
  if (!Array.isArray(nodes) || nodes.length === 0) throw new PrReviewValueError('no comment');
  const first = nodes[0] as JsonValue;
  if (!(first instanceof JsonObject)) throw new PrReviewAttributeError('first');
  const bodyValue = first.get('body');
  if (bodyValue === undefined) throw new ReceiptKeyError('body');
  const review = mapping(first.get('pullRequestReview'));
  const reviewBodyRaw = review.get('body');
  const reviewBodyAny: JsonValue = pythonTruthy(reviewBodyRaw) ? (reviewBodyRaw as JsonValue) : '';
  const reviewBody = text(reviewBodyAny, 'startswith');
  let legacy =
    reviewBody.startsWith('<!-- crq-findings run=') &&
    reviewBody.includes('### crq findings (CodeRabbit CLI, local run ');
  const trusted = [login, 'cq-review[bot]'];
  const authorObject = first.get('author');
  const authorLoginRaw = mapping(authorObject).get('login');
  const author = pythonTruthy(authorLoginRaw) ? (authorLoginRaw as JsonValue) : '';
  const reviewAuthorObject = review.get('author');
  const reviewAuthor = mapping(reviewAuthorObject).get('login');
  const reviewAssociation = review.get('authorAssociation');
  const fallback =
    pythonTruthy(author) &&
    !text(author, 'endswith').endsWith('[bot]') &&
    reviewAuthor !== undefined &&
    jsonEqual(author, reviewAuthor) &&
    inSet(reviewAssociation, ASSOCIATIONS) &&
    reviewBody.includes(UNATTESTED);
  const rootApp = author === 'cq-review' && mapping(authorObject).get('__typename') === 'Bot';
  const reviewApp =
    reviewAuthor === 'cq-review' && mapping(reviewAuthorObject).get('__typename') === 'Bot';
  const authored = inSet(author, trusted) || rootApp || fallback;
  legacy = legacy && (inSet(reviewAuthor, trusted) || reviewApp || fallback);
  const body = text(bodyValue, 'search');
  const found = THREAD.exec(body);
  const own = authored && (found !== null || legacy);
  const resolved = thread.get('isResolved');
  if (typeof resolved !== 'boolean') throw new PrReviewValueError('isResolved');
  let hasOpen = false;
  if (own && found !== null) {
    const key: ExpectedKey = [found[1] as string, found[2] as string, found[3] as string];
    visible.add(keyOf(key));
    if (expected.has(keyOf(key)) && !resolved) hasOpen = true;
  }
  if (own && !resolved && OPEN_FINDING.test(body)) hasOpen = true;
  return hasOpen;
}

/** `open_major`: paginate own namespaced threads; never resolve from absence in this run. */
export function openMajor(
  gh: GhPort,
  repo: string,
  pr: number,
  login: string,
  expected: Expected = new Map(),
): boolean {
  const [owner, name, ...rest] = repo.split('/');
  if (owner === undefined || name === undefined || rest.length > 0)
    throw new PrReviewValueError(
      rest.length > 0
        ? 'too many values to unpack (expected 2)'
        : `not enough values to unpack (expected 2, got ${repo.split('/').length})`,
    );
  let cursor: string | null = null;
  const seen = new Set<string>();
  const visible = new Set<string>();
  let hasOpen = false;
  for (;;) {
    const argv = [
      'gh',
      'api',
      'graphql',
      '-f',
      `query=${QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `pr=${pr}`,
      ...(cursor ? ['-f', `cursor=${cursor}`] : []),
    ];
    const data = parseGhJson(argv, callGh(gh, argv, null));
    try {
      const root = mapping(data);
      if (pythonTruthy(root.get('errors'))) throw new PrReviewValueError('errors');
      const walk = (value: JsonValue | undefined, key: string): JsonValue => {
        const next = mapping(value).get(key);
        if (next === undefined) throw new ReceiptKeyError(key);
        return next;
      };
      const connection = walk(
        walk(walk(walk(root, 'data'), 'repository'), 'pullRequest'),
        'reviewThreads',
      );
      const nodes = walk(connection, 'nodes');
      const page = walk(connection, 'pageInfo');
      const hasNext = walk(page, 'hasNextPage');
      if (!Array.isArray(nodes) || typeof hasNext !== 'boolean')
        throw new PrReviewValueError('shape');
      for (const thread of nodes) {
        if (inspectThread(thread, login, expected, visible)) hasOpen = true;
      }
      if (!hasNext) {
        if ([...expected.keys()].some((key) => !visible.has(key)))
          throw visibilityWait(
            expected,
            visible,
            repo,
            pr,
            'expected CRQ major thread not visible; retry',
          );
        return hasOpen;
      }
      const nextCursor = walk(page, 'endCursor');
      if (!pythonTruthy(nextCursor) || typeof nextCursor !== 'string' || seen.has(nextCursor))
        throw new PrReviewValueError('cursor');
      seen.add(nextCursor);
      cursor = nextCursor;
    } catch (error) {
      if (error instanceof ThreadsNotVisible) throw error;
      if (!(error instanceof Error) || error instanceof PrReviewRuntimeError) throw error;
      if (expected.size > 0)
        throw visibilityWait(
          expected,
          visible,
          repo,
          pr,
          `expected CRQ GraphQL thread inventory incomplete at cursor=${cursor === null ? 'None' : pythonRepr(cursor)}; retry`,
        );
      throw new PrReviewRuntimeError('incomplete PR review threads');
    }
  }
}

/** `current_merge_base`: gh's scalar `--jq` output is plain text, not a JSON string. */
export function currentMergeBase(
  gh: GhPort,
  repo: string,
  base: JsonValue,
  head: JsonValue,
): string {
  const argv = [
    'gh',
    'api',
    `repos/${repo}/compare/${pythonStr(base)}...${pythonStr(head)}`,
    '--jq',
    '.merge_base_commit.sha',
  ];
  const out = okGh(argv, callGh(gh, argv, null)).stdout;
  const value = pythonStrip(pythonTruthy(out) ? ghString(out) : '');
  if (!SHA40.test(value)) throw new PrReviewRuntimeError('invalid current PR merge base');
  return value;
}
