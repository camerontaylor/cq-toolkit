/**
 * `crq_review_receipt.prepare` and `refresh`: validate a saved scan's artifacts and
 * decide the receipt verdict at delivery, and refresh a prior whole-PR scan's verdict
 * after the author resolved its threads. Identity selection (`select_receipt_identity`)
 * is the caller's: both take the already-selected `gh` port and login.
 *
 * Artifact files and `gh` are injected; nothing here touches the filesystem or network.
 * Inactive: nothing imports this yet.
 */
import { classify } from './classification.js';
import { JsonNumber, JsonObject, parseJsonValue, type JsonValue } from './jsonValue.js';
import { ledgerPythonTypeName } from './ledger.js';
import {
  BLOCKING,
  PrReviewAttributeError,
  PrReviewRuntimeError,
  PrReviewValueError,
  callGh,
  okGh,
  postReview,
  prState,
  pythonStr,
  type GhPort,
} from './prReviewFindings.js';
import {
  PREFIX,
  ReceiptKeyError,
  binding,
  bindingMarker,
  bodyMajorAtHead,
  currentMergeBase,
  expectedInlineMajor,
  openMajor,
  reviews,
} from './receiptEvidence.js';
import { pythonEqual } from './receiptIdentity.js';
import { pythonStrip, pythonTruthy } from './repairBinding.js';

const REFRESH = '<!-- crq-verdict-refresh ';
const FULL_RANGE = 'full-range-once-v1';

/** `OSError` reading an artifact; `pythonError` is the exact subclass name. */
export class ReceiptOsError extends Error {
  override readonly name: string = 'ReceiptOsError';
  readonly pythonError: string;

  constructor(pythonError: string, message: string) {
    super(message);
    this.pythonError = pythonError;
  }
}

/** `json.loads`/`read_text` failure. Only the exception class is faithful, not Python's position text. */
export class ReceiptDecodeError extends Error {
  override readonly name: string = 'ReceiptDecodeError';
  readonly pythonError: string;

  constructor(pythonError: 'JSONDecodeError' | 'UnicodeDecodeError', message: string) {
    super(message);
    this.pythonError = pythonError;
  }
}

/** The run directory's artifact bytes; null when the file does not exist. */
export interface ReceiptFiles {
  readBytes(path: string): Uint8Array | null;
}

const pyRepr = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** `Path(p).parent` for a POSIX path string. */
export function pathParent(path: string): string {
  const root = path.startsWith('///')
    ? '/'
    : path.startsWith('//')
      ? '//'
      : path.startsWith('/')
        ? '/'
        : '';
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  parts.pop();
  const rest = parts.join('/');
  return root + rest === '' ? '.' : root + rest;
}

/** `str(Path(dir) / name)` for a name without separators. */
const joinName = (dir: string, name: string): string =>
  dir === '.' ? name : dir === '/' ? `/${name}` : `${dir}/${name}`;

function read(files: ReceiptFiles, path: string): string {
  const bytes = files.readBytes(path);
  if (bytes === null)
    throw new ReceiptOsError(
      'FileNotFoundError',
      `[Errno 2] No such file or directory: ${pyRepr(path)}`,
    );
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ReceiptDecodeError('UnicodeDecodeError', "'utf-8' codec can't decode artifact bytes");
  }
}

function loads(text: string): JsonValue {
  try {
    return parseJsonValue(text, { duplicates: 'last' });
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new ReceiptDecodeError('JSONDecodeError', error.message);
    throw error;
  }
}

function eq(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  const a = left ?? null;
  const b = right ?? null;
  if (a instanceof JsonObject || b instanceof JsonObject || Array.isArray(a) || Array.isArray(b))
    return JSON.stringify(toKey(a)) === JSON.stringify(toKey(b));
  return pythonEqual(a, b);
}

function toKey(value: JsonValue): unknown {
  if (value instanceof JsonObject)
    return [...value.entries]
      .map(([k, v]) => [k, toKey(v)])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  if (Array.isArray(value)) return value.map(toKey);
  if (value instanceof JsonNumber)
    return value.kind === 'int' ? `i${value.integer}` : `f${value.float}`;
  return value;
}

const required = (meta: JsonObject, key: string): JsonValue => {
  const value = meta.get(key);
  if (value === undefined) throw new ReceiptKeyError(key);
  return value;
};

const splitLines = (text: string): string[] =>
  // eslint-disable-next-line no-control-regex
  text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u);

/** `prepare`: the receipt fields to add to the delivery, or null when the scan is not countable. */
export function prepare(
  gh: GhPort,
  files: ReceiptFiles,
  repo: string,
  pr: number,
  meta: JsonObject,
  ndjson: string,
  findings: readonly JsonObject[],
  login: string,
): JsonObject | null {
  const rdir = pathParent(ndjson);
  const saved = loads(read(files, joinName(rdir, 'meta.json')));
  if (!(saved instanceof JsonObject)) throw new PrReviewValueError('invalid CRQ run artifact');
  for (const key of ['run_id', 'base', 'head'])
    if (!eq(saved.get(key), meta.get(key)))
      throw new PrReviewValueError('changed CRQ run artifact binding');
  const savedRepo = saved.has('repo') ? (saved.get('repo') as JsonValue) : repo;
  const savedPr = saved.has('pr') ? (saved.get('pr') as JsonValue) : JsonNumber.int(BigInt(pr));
  if (
    !eq(savedPr, JsonNumber.int(BigInt(pr))) ||
    typeof savedRepo !== 'string' ||
    savedRepo.toLowerCase() !== repo.toLowerCase()
  )
    throw new PrReviewValueError('changed CRQ PR/repository binding');
  const exitInfo = loads(read(files, joinName(rdir, 'exit.json')));
  if (!(exitInfo instanceof JsonObject)) throw new PrReviewValueError('invalid CRQ exit artifact');
  const exitValue = exitInfo.get('exit');
  const exitCode =
    exitValue instanceof JsonNumber && exitValue.kind === 'int' ? Number(exitValue.integer) : null;
  const cls = classify(files.readBytes(ndjson), exitCode);
  if (cls.get('outcome') !== 'completed' || !pythonTruthy(cls.get('counted') ?? null)) return null;
  for (const raw of splitLines(read(files, ndjson))) {
    if (pythonStrip(raw) === '') continue;
    const event = loads(raw);
    if (!(event instanceof JsonObject))
      throw new PrReviewAttributeError(
        `'${ledgerPythonTypeName(event)}' object has no attribute 'get'`,
      );
    if (event.get('partial') === true || event.get('truncated') === true) return null;
  }
  const state = prState(gh, repo, pr);
  const head = required(meta, 'head');
  if (!eq(state.head, head)) return null;
  const mergeBase = currentMergeBase(gh, repo, state.base ?? null, head);
  const whole = eq(saved.get('range_policy'), FULL_RANGE) && eq(mergeBase, required(meta, 'base'));
  let blocked = findings.some((finding) => {
    const severity = finding.get('severity');
    if (severity === undefined) throw new ReceiptKeyError('severity');
    if (typeof severity !== 'string')
      throw new PrReviewAttributeError(
        `'${ledgerPythonTypeName(severity)}' object has no attribute 'lower'`,
      );
    return BLOCKING.includes(severity.toLowerCase());
  });
  const rows = reviews(gh, repo, pr);
  const threadsBlock = openMajor(gh, repo, pr, login, expectedInlineMajor(rows, pr, login));
  blocked = bodyMajorAtHead(rows, pr, head, login) || threadsBlock || blocked;
  const verdict = whole && !blocked ? 'PASS' : 'ITERATE';
  return new JsonObject([
    ...meta.entries,
    [
      'receipt_header',
      `**Independent review (CodeRabbit CLI via crq): ${verdict} for \`${pythonStr(head)}\`**`,
    ],
    ['receipt_binding', bindingMarker(binding(meta, pr))],
    ['whole_pr_scan', whole],
    ['receipt_verdict', verdict],
  ]);
}

const VERDICT =
  /(?<![^\n])\*\*Independent review \(CodeRabbit CLI via crq\): (PASS|ITERATE) for `([0-9a-f]{40})`\*\*(?=\n|$)/;
const MICROS = 1_000_000n;

/** `datetime.fromisoformat(value).timestamp()` for an aware extended ISO 8601 stamp, in microseconds. */
function isoMicros(value: string): bigint {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?(?:([+-])(\d{2})(?::?(\d{2})(?::?(\d{2}))?)?)$/.exec(
      value,
    );
  if (m === null) throw new PrReviewValueError('invalid isoformat string');
  const [year, month, day, hour, minute = '0', second = '0'] = m
    .slice(1, 7)
    .map((x) => Number(x ?? '0')) as number[];
  const fraction = (m[7] ?? '').slice(0, 6).padEnd(6, '0');
  const stamp = Date.UTC(
    year as number,
    (month as number) - 1,
    day as number,
    hour as number,
    Number(minute),
    Number(second),
  );
  const probe = new Date(stamp);
  if (
    (month as number) < 1 ||
    (month as number) > 12 ||
    probe.getUTCDate() !== day ||
    (hour as number) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    throw new PrReviewValueError('invalid date');
  const sign = m[8] === '-' ? -1n : 1n;
  const offset =
    sign * (BigInt(m[9] ?? '0') * 3600n + BigInt(m[10] ?? '0') * 60n + BigInt(m[11] ?? '0'));
  if (offset <= -86400n || offset >= 86400n) throw new PrReviewValueError('offset out of range');
  return (BigInt(stamp) / 1000n - offset) * MICROS + BigInt(fraction);
}

interface Own {
  readonly row: JsonObject;
  readonly verdict: string;
}

function submitted(entry: Own): bigint {
  const at = entry.row.get('submitted_at');
  if (typeof at !== 'string')
    throw new PrReviewRuntimeError('missing CRQ review chronology; cannot refresh');
  try {
    return isoMicros(at.replace('Z', '+00:00'));
  } catch (error) {
    if (error instanceof PrReviewValueError)
      throw new PrReviewRuntimeError('missing CRQ review chronology; cannot refresh');
    throw error;
  }
}

/** `refresh`: re-issue a prior whole-PR scan's PASS verdict. `meta` and `login` are already identity-selected. */
export function refresh(
  gh: GhPort,
  repo: string,
  pr: number,
  meta: JsonObject,
  login: string,
): JsonObject {
  const result = (entries: Array<[string, JsonValue]>): JsonObject => new JsonObject(entries);
  const state = prState(gh, repo, pr);
  const head = required(meta, 'head');
  if (state.state !== 'open' || pythonTruthy(state.merged ?? null) || !eq(state.head, head))
    return result([['state', 'skipped-head']]);
  if (!eq(currentMergeBase(gh, repo, state.base ?? null, head), required(meta, 'base')))
    return result([['state', 'skipped-range']]);
  const rows = reviews(gh, repo, pr);
  if (bodyMajorAtHead(rows, pr, head, login)) return result([['state', 'body-major']]);
  const own: Own[] = [];
  for (const row of rows) {
    const body = row.get('body') as string;
    const verdict = VERDICT.exec(body);
    const user = row.get('user') as JsonObject;
    const author = user.get('login');
    if (
      verdict !== null &&
      verdict[2] === head &&
      (body.includes(PREFIX) || body.includes(REFRESH)) &&
      (author === login || author === 'cq-review[bot]')
    )
      own.push({ row, verdict: verdict[1] as string });
  }
  if (own.length === 0) return result([['state', 'no-receipt']]);
  const times = new Map(own.map((entry) => [entry, submitted(entry)] as const));
  own.sort((a, b) => {
    const left = times.get(a) as bigint;
    const right = times.get(b) as bigint;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const last = own[own.length - 1] as Own;
  const prior = own[own.length - 2];
  if (prior !== undefined && times.get(last) === times.get(prior) && last.verdict !== prior.verdict)
    throw new PrReviewRuntimeError('ambiguous CRQ review chronology; cannot refresh');
  const latest = last.row;
  if (last.verdict === 'PASS')
    return result([
      ['state', 'existing'],
      ['review_id', latest.get('id') as JsonValue],
      ['review_url', latest.get('html_url') ?? null],
    ]);
  const body = latest.get('body') as string;
  const runId = required(meta, 'run_id');
  const proof = `<!-- crq-review-scan run=${pythonStr(runId)} whole-pr-success -->`;
  if (body.includes(' body-major=1 -->')) return result([['state', 'body-major']]);
  if (!body.includes(bindingMarker(binding(meta, pr))) || !body.includes(proof))
    return result([['state', 'no-whole-pr-proof']]);
  if (openMajor(gh, repo, pr, login, expectedInlineMajor(rows, pr, login)))
    return result([['state', 'pending-threads']]);
  const wanted = `${REFRESH}head=${pythonStr(head)} scan-run=${pythonStr(runId)} -->`;
  for (const { row } of own)
    if ((row.get('body') as string).includes(wanted))
      return result([
        ['state', 'existing'],
        ['review_id', row.get('id') as JsonValue],
        ['review_url', row.get('html_url') ?? null],
      ]);
  const base = required(meta, 'base');
  const url = latest.get('html_url');
  const lines = [
    wanted,
    `**Independent review (CodeRabbit CLI via crq): PASS for \`${pythonStr(head)}\`**`,
  ];
  if (pythonTruthy(meta.get('unattested') ?? null))
    lines.push('Unattested: App identity unavailable; posted with the host account.');
  lines.push(
    `Refresh of scanned run \`${pythonStr(runId)}\`; reviewed range \`${pythonStr(base)}..${pythonStr(head)}\`.`,
    `Supersedes review ${pythonStr(pythonTruthy(url ?? null) ? (url as JsonValue) : (latest.get('id') as JsonValue))} after the author's thread resolution.`,
    'The prior complete whole-PR scan is reused; no scan or new findings were produced.',
    'Legacy body-only findings are not covered or claimed resolved by this receipt.',
  );
  const { argv, callResult } = postReview(
    gh,
    repo,
    pr,
    new JsonObject([
      ['event', 'COMMENT'],
      ['commit_id', head],
      ['body', lines.join('\n')],
      ['comments', []],
    ]),
  );
  const stdout = okGh(argv, callResult).stdout;
  const posted = loads(typeof stdout === 'string' ? stdout : '');
  if (!(posted instanceof JsonObject))
    throw new PrReviewAttributeError(
      `'${ledgerPythonTypeName(posted)}' object has no attribute 'get'`,
    );
  const id = posted.get('id');
  if (!(id instanceof JsonNumber) || id.kind !== 'int')
    throw new PrReviewRuntimeError(
      'refresh POST returned no review identity; reconcile before retry',
    );
  return result([
    ['state', 'created'],
    ['review_id', id],
    ['review_url', posted.get('html_url') ?? null],
    ['identity', login],
    ['attested', login === 'cq-review[bot]'],
    ['identity_reason', meta.get('identity_reason') ?? null],
    ['scanned_run', runId],
  ]);
}

void callGh;
