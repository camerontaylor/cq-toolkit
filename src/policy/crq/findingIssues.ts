/**
 * GitHub-issue delivery policy for crq findings in non-primary repositories.
 *
 * Ports `apps/crq-python/finding_issues.py`: the enablement predicate, the
 * fixed issue title, the identity/findings/footer body with GitHub's body cap,
 * and the idempotent search-then-create orchestration. `gh` is an injected
 * port, so this module performs no spawn, filesystem, environment, network or
 * time read. A caller binds the real adapter; the tests bind a scripted fake.
 *
 * The Python oracle is exact for the supported input domain:
 *
 * - `str`/`repr` over the lossless JSON model (including containers, floats
 *   and non-printable code points) is reproduced locally, because `body` and
 *   `title` interpolate metadata with Python `str()`;
 * - slicing, length and `rstrip("\n")` count code points, not UTF-16 units;
 * - numeric counts use Python `int`/`float` addition (`bool` is an `int`);
 * - the issue-URL scan uses Python's Unicode `\s` set and `\d` decimal digits;
 * - `isinstance(number, int)` accepts a JSON boolean exactly as CPython does;
 * - `json.loads` on `gh` output keeps the last duplicate key and accepts the
 *   non-finite constants.
 *
 * Repository configuration is upstream-validated by `repo_registry.parse_entry`
 * (`repo` is an `owner/name` string and `findings` is `issue` or `none`), so
 * this port requires a string `repo` and does not reproduce `subprocess`'s
 * non-string argv refusal. No other input is narrowed.
 */
import { JsonNumber, JsonObject, parseJsonValue, type JsonValue } from './jsonValue.js';
import { ledgerPythonTypeName } from './ledger.js';
import { pythonFloatRepr } from './pythonJson.js';
import { pythonLength, pythonStrip, pythonTruthy } from './repairBinding.js';
import { pythonIntValue, type SummaryInteger } from './statusSummary.js';

/** Mirrors `repo_registry.DEFAULT_FINDINGS`. */
export const DEFAULT_FINDINGS = 'issue';
/** `finding_issues.GH_TIMEOUT`, seconds per `gh` call. */
export const GH_TIMEOUT = 10;
/** `finding_issues.FOOTER`, always the last prose in the body. */
export const FOOTER =
  'Auto-filed by crq (CodeRabbit review queue). No auto-fix runs for this repository; triage manually.';
/** GitHub's issue-body character cap. */
export const MAX_BODY = 65536;
/** `finding_issues.TRUNCATED`, appended when the findings section is cut. */
export const TRUNCATED =
  "\n\n_… findings truncated to fit GitHub's issue body limit; see the receipt for the full list._";

/** A Python exception class the differential compares. */
export class FindingIssueError extends Error {
  override readonly name: string = 'FindingIssueError';
  readonly pythonError: string;

  constructor(message: string, pythonError: string) {
    super(message);
    this.pythonError = pythonError;
  }
}

/** Python `AttributeError` from `.get`/`.rstrip` on a non-dict/non-string. */
export class FindingIssueAttributeError extends FindingIssueError {
  override readonly name: string = 'FindingIssueAttributeError';

  constructor(message: string) {
    super(message, 'AttributeError');
  }
}

/** Python `KeyError` for a missing repository key. */
export class FindingIssueKeyError extends FindingIssueError {
  override readonly name: string = 'FindingIssueKeyError';

  constructor(message: string) {
    super(message, 'KeyError');
  }
}

/** Python `TypeError`: unsupported arithmetic, subscription or regex subject. */
export class FindingIssueTypeError extends FindingIssueError {
  override readonly name: string = 'FindingIssueTypeError';

  constructor(message: string) {
    super(message, 'TypeError');
  }
}

/** Python `ValueError`, including the integer-string conversion limit. */
export class FindingIssueValueError extends FindingIssueError {
  override readonly name: string = 'FindingIssueValueError';

  constructor(message: string) {
    super(message, 'ValueError');
  }
}

/** Python `OverflowError` converting a huge int to float. */
export class FindingIssueOverflowError extends FindingIssueError {
  override readonly name: string = 'FindingIssueOverflowError';

  constructor(message: string) {
    super(message, 'OverflowError');
  }
}

/** The one error class `file_issue` callers catch: Python `RuntimeError`. */
export class FindingIssueRuntimeError extends FindingIssueError {
  override readonly name: string = 'FindingIssueRuntimeError';

  constructor(message: string) {
    super(message, 'RuntimeError');
  }
}

/** The injected `gh` port raised `subprocess.TimeoutExpired`. */
export class GhTimeoutError extends Error {
  override readonly name: string = 'GhTimeoutError';
  /** Python `str(TimeoutExpired)`, including the command list and timeout. */
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.detail = detail;
  }
}

/** The injected `gh` port raised `OSError` (for example, `gh` is missing). */
export class GhSpawnError extends Error {
  override readonly name: string = 'GhSpawnError';
  /** Python `str(OSError)`. */
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.detail = detail;
  }
}

/** The fields `_invoke` reads with `getattr`, so every one is optional. */
export interface GhResult {
  readonly returncode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/**
 * One `gh` call. Python always passes `input_text` as a keyword, with `None`
 * for the list call, so the port makes it explicit.
 */
export interface GhCallOptions {
  readonly inputText: string | null;
}

export type GhPort = (
  argv: readonly string[],
  options: GhCallOptions,
) => GhResult | Promise<GhResult>;

/** A Python `int` (safe JS number or lossless `JsonNumber`) or a reused bool. */
export type FindingIssueNumber = SummaryInteger | boolean;

/** The exact Python return dictionary, including a truthy non-string URL. */
export interface FindingIssueResult {
  readonly issue_url: JsonValue | null;
  readonly issue_number: FindingIssueNumber | null;
  readonly created: boolean;
}

export interface FileFindingIssueInput {
  /** A `repo_registry.parse_entry` result. */
  readonly repoConfig: JsonValue;
  readonly base: JsonValue;
  readonly head: JsonValue;
  readonly meta: JsonValue;
  readonly severityCounts: JsonValue;
  readonly findingsMarkdown: JsonValue;
  readonly gh: GhPort;
}

const NOOP_RESULT: FindingIssueResult = {
  issue_url: null,
  issue_number: null,
  created: false,
};

/**
 * `finding_issues.enabled`: true iff the repo files findings as issues.
 * An absent `findings` key takes the module default.
 */
export function findingIssuesEnabled(repoConfig: JsonValue): boolean {
  const config = requireGetObject(repoConfig);
  const findings = config.has('findings') ? config.get('findings') : DEFAULT_FINDINGS;
  return findings === 'issue';
}

/**
 * `finding_issues.title`: review identity, total findings, blocking count and
 * an optional split-part suffix. `base`/`head` are sliced like Python values.
 */
export function findingIssueTitle(
  base: JsonValue,
  head: JsonValue,
  severityCounts: JsonValue,
  itemId: JsonValue = '',
): string {
  const counts = requireGetObject(severityCounts);
  // Python evaluates the left operand of `critical + major` first, so a
  // non-numeric `critical` names itself in the error (`'list' and 'int'`).
  const blocking = pyAdd(
    pyAddend(counts.has('critical') ? counts.get('critical') : undefined),
    pyAddend(counts.has('major') ? counts.get('major') : undefined),
  );
  const suffix = pythonTruthy(itemId) ? ` [${pythonString(itemId)}]` : '';
  // Python evaluates the f-string left to right after `blocking` and `suffix`:
  // base, head, then `sum(severity_counts.values())`.
  const baseText = pythonPrefix(base);
  const headText = pythonPrefix(head);
  let total: PyAddend = INT_ZERO;
  for (const [, value] of counts.entries) total = pyAdd(total, pyAddend(value));
  return (
    `crq: ${baseText}..${headText} — ` +
    `${pyAddendTitle(total)} findings (${pyAddendTitle(blocking)} blocking)${suffix}`
  );
}

/**
 * `finding_issues.body`: identity block, findings markdown and fixed footer.
 * The findings section is truncated to the remaining `MAX_BODY` budget in
 * code points; the identity block and footer are always kept.
 */
export function findingIssueBody(meta: JsonValue, findingsMarkdown: JsonValue): string {
  const object = requireGetObject(meta);
  const lines = [
    '## Review identity',
    `- Repo: \`${pythonString(metaOr(object, 'repo', ''))}\``,
    `- Item: \`${pythonString(metaOr(object, 'item_id', ''))}\``,
    `- Run: \`${pythonString(metaOr(object, 'run_id', ''))}\``,
    `- Range: \`${pythonString(metaOr(object, 'base', ''))}..${pythonString(metaOr(object, 'head', ''))}\``,
  ];
  const receipt = object.get('receipt_id');
  if (pythonTruthy(receipt)) lines.push(`- Receipt: \`${pythonString(receipt ?? null)}\``);

  let findings = pythonRstripNewlines(findingsMarkdown);
  const budget =
    MAX_BODY -
    pythonLength(lines.join('\n')) -
    pythonLength('\n\n---\n\n') -
    pythonLength(`\n\n${FOOTER}\n`);
  if (pythonLength(findings) > budget) {
    const keep = Math.max(0, budget - pythonLength(TRUNCATED));
    findings = `${pythonSlice(findings, 0, keep)}${TRUNCATED}`;
  }
  return [...lines, '', '---', '', findings, '', FOOTER, ''].join('\n');
}

/**
 * `finding_issues.file_issue`: search for the exact title, then create, and
 * return the existing or created issue. A disabled repository is a no-effect
 * no-op. A nonzero `gh` exit, timeout or spawn failure is a
 * {@link FindingIssueRuntimeError}; a malformed list/create response is too.
 *
 * Effect order is Python's: enablement, repository key, title construction
 * (including `meta["item_id"]`), the list call, then body construction and the
 * create call. A body defect therefore cannot suppress the search, and an
 * existing issue never constructs a body.
 */
export async function fileFindingIssue(input: FileFindingIssueInput): Promise<FindingIssueResult> {
  if (!findingIssuesEnabled(input.repoConfig)) return NOOP_RESULT;

  const config = input.repoConfig as JsonObject;
  if (!config.has('repo')) throw new FindingIssueKeyError("'repo'");
  const repo = config.get('repo');
  if (typeof repo !== 'string') {
    // Upstream `repo_registry.parse_entry` validates this before crq can call
    // the module; a real `subprocess` would refuse it in the adapter.
    throw new FindingIssueTypeError(
      `expected str, bytes or os.PathLike object, not ${ledgerPythonTypeName(repo ?? null)}`,
    );
  }

  const meta = requireGetObject(input.meta);
  const itemId = meta.has('item_id') ? (meta.get('item_id') as JsonValue) : '';
  const wanted = findingIssueTitle(input.base, input.head, input.severityCounts, itemId);

  const existing = await existingIssue(input.gh, repo, wanted);
  if (existing !== undefined) {
    return {
      issue_url: existing.url,
      issue_number: issueNumberValue(existing.number),
      created: false,
    };
  }

  const body = findingIssueBody(meta, input.findingsMarkdown);
  const created = await invokeGh(
    input.gh,
    ['gh', 'issue', 'create', '--repo', repo, '--title', wanted, '--body-file', '-'],
    body,
  );
  const stdout = requireStdout(created);
  const match = findIssueUrl(stdout);
  if (match === undefined) {
    throw new FindingIssueRuntimeError(
      `gh issue create returned no issue URL: ${pythonSlice(pythonStrip(stdout), 0, 300)}`,
    );
  }
  return { issue_url: match.url, issue_number: issueNumberValue(match.number), created: true };
}

// ---------------------------------------------------------------- gh calls

type GhOutcome = { readonly number: JsonValue; readonly url: JsonValue };

/** `finding_issues._existing`: exact-title (case-sensitive) reuse. */
async function existingIssue(
  gh: GhPort,
  repo: string,
  wanted: string,
): Promise<GhOutcome | undefined> {
  const argv = [
    'gh',
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'all',
    '--limit',
    '20',
    '--json',
    'number,title,url',
    '--search',
    `in:title "${wanted}"`,
  ];
  const out = await invokeGh(gh, argv, null);
  const stdout = requireStdout(out);
  const source = pythonTruthy(stdout) ? stdout : '[]';
  let rows: JsonValue;
  try {
    rows = parseJsonValue(source, {
      duplicates: 'last',
      parseConstant: (raw) =>
        JsonNumber.float(raw === 'NaN' ? Number.NaN : raw === 'Infinity' ? Infinity : -Infinity),
    });
  } catch {
    throw new FindingIssueRuntimeError(
      `gh issue list returned unparsable output: ${pythonSlice(pythonStrip(source), 0, 300)}`,
    );
  }
  if (!Array.isArray(rows)) {
    throw new FindingIssueRuntimeError(
      `gh issue list returned unexpected output: ${pythonSlice(pythonStrip(source), 0, 300)}`,
    );
  }
  for (const row of rows) {
    if (!(row instanceof JsonObject)) continue;
    const title = row.get('title');
    const number = row.get('number');
    const url = row.get('url');
    if (
      title === wanted &&
      isPythonInt(number) &&
      pythonTruthy(url) &&
      number !== undefined &&
      url !== undefined
    ) {
      return { number, url };
    }
  }
  return undefined;
}

/**
 * `finding_issues._invoke`: one `gh` call. A timeout or spawn failure is a
 * `RuntimeError` with the first four argv words; a nonzero return is a
 * `RuntimeError` with the stripped stderr.
 */
async function invokeGh(
  gh: GhPort,
  argv: readonly string[],
  inputText: string | null,
): Promise<GhResult> {
  const prefix = argv.slice(0, 4).join(' ');
  let result: GhResult;
  try {
    result = await gh(argv, { inputText });
  } catch (error) {
    if (error instanceof GhTimeoutError) {
      throw new FindingIssueRuntimeError(
        `${prefix} … timed out after ${GH_TIMEOUT}s: ${error.detail}`,
      );
    }
    if (error instanceof GhSpawnError) {
      throw new FindingIssueRuntimeError(`${prefix} … could not start: ${error.detail}`);
    }
    throw error;
  }
  const returncode = result.returncode ?? 0;
  if (returncode !== 0) {
    const stderr = pythonSlice(pythonStrip(result.stderr ?? ''), 0, 300);
    throw new FindingIssueRuntimeError(`${prefix} … exit ${String(returncode)}: ${stderr}`);
  }
  return result;
}

function requireStdout(result: GhResult): string {
  if (result.stdout === undefined) {
    throw new FindingIssueAttributeError("'GhResult' object has no attribute 'stdout'");
  }
  if (typeof result.stdout !== 'string') {
    throw new FindingIssueTypeError(
      `expected string or bytes-like object, got '${ledgerPythonTypeName(result.stdout)}'`,
    );
  }
  return result.stdout;
}

/** `isinstance(value, int)`: CPython accepts booleans as integers. */
function isPythonInt(value: JsonValue | undefined): boolean {
  if (typeof value === 'boolean') return true;
  return value instanceof JsonNumber && value.kind === 'int';
}

/** Preserve a reused bool, a safe integer as a number, a large one losslessly. */
function issueNumberValue(value: JsonValue | number): FindingIssueNumber {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  const integer = pythonIntValue(value);
  if (integer === null) throw new FindingIssueTypeError('issue number is not a Python int');
  return integer;
}

// ------------------------------------------------------------- issue URLs

/**
 * Python `ISSUE_URL.search`, including `\d` as any Unicode decimal digit and
 * `\s` as Python's `str.isspace()` set (Unicode White_Space plus the four
 * ASCII information separators, and without ECMAScript's U+FEFF).
 */
export function findIssueUrl(
  text: string,
): { readonly url: string; readonly number: SummaryInteger } | undefined {
  const marker = 'https://github.com/';
  let from = 0;
  while (from <= text.length) {
    const start = text.indexOf(marker, from);
    if (start === -1) return undefined;
    let index = start + marker.length;
    const ownerStart = index;
    index = scanPathPart(text, index);
    if (index > ownerStart && text[index] === '/') {
      index += 1;
      const nameStart = index;
      index = scanPathPart(text, index);
      if (index > nameStart && text.startsWith('/issues/', index)) {
        index += '/issues/'.length;
        const digitsStart = index;
        index = scanDigits(text, index);
        if (index > digitsStart) {
          const digits = text.slice(digitsStart, index);
          return { url: text.slice(start, index), number: pythonInteger(digits) };
        }
      }
    }
    from = start + 1;
  }
  return undefined;
}

function scanPathPart(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const codePoint = text.codePointAt(index) as number;
    if (codePoint === 0x2f || pythonIsSpace(codePoint)) break;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return index;
}

function scanDigits(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const codePoint = text.codePointAt(index) as number;
    if (!isDecimalDigit(codePoint)) break;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return index;
}

const DECIMAL_DIGIT = /\p{Nd}/u;

function isDecimalDigit(codePoint: number): boolean {
  return DECIMAL_DIGIT.test(String.fromCodePoint(codePoint));
}

/** Python `int()` for a non-empty run of Unicode decimal digits. */
function pythonInteger(digits: string): SummaryInteger {
  const count = pythonLength(digits);
  if (count > 4300) {
    throw new FindingIssueValueError(
      `Exceeds the limit (4300 digits) for integer string conversion: value has ${count} digits; ` +
        'use sys.set_int_max_str_digits() to increase the limit',
    );
  }
  let value = 0n;
  for (const character of digits) {
    value = value * 10n + BigInt(decimalDigitValue(character));
  }
  return pythonIntValue(JsonNumber.int(value)) as SummaryInteger;
}

/** Unicode `Nd` code points occur in aligned runs of ten. */
function decimalDigitValue(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) throw new FindingIssueTypeError('empty digit run');
  if (codePoint >= 0x30 && codePoint <= 0x39) return codePoint - 0x30;
  let start = codePoint;
  while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
  return (codePoint - start) % 10;
}

/** Python `str.isspace()` for one code point. */
function pythonIsSpace(codePoint: number): boolean {
  return (
    (codePoint >= 0x09 && codePoint <= 0x0d) ||
    (codePoint >= 0x1c && codePoint <= 0x1f) ||
    codePoint === 0x20 ||
    codePoint === 0x85 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

// ------------------------------------------------------ Python value text

/**
 * One Python `+` operand. `typeName` is Python's own spelling (`bool` stays
 * `bool` in errors even though arithmetic treats it as an int); only the
 * arithmetic kinds can result from addition.
 */
type PyAddend =
  | { readonly kind: 'int'; readonly value: bigint; readonly typeName: 'int' | 'bool' }
  | { readonly kind: 'float'; readonly value: number; readonly typeName: 'float' }
  | { readonly kind: 'string'; readonly value: string; readonly typeName: 'str' }
  | { readonly kind: 'list'; readonly value: JsonValue[]; readonly typeName: 'list' }
  | { readonly kind: 'other'; readonly value: JsonValue; readonly typeName: string };

const INT_ZERO: PyAddend = { kind: 'int', value: 0n, typeName: 'int' };

/** Python `dict.get` on the JSON model, refusing a non-dict like Python. */
function requireGetObject(value: JsonValue): JsonObject {
  if (!(value instanceof JsonObject)) {
    throw new FindingIssueAttributeError(
      `'${ledgerPythonTypeName(value)}' object has no attribute 'get'`,
    );
  }
  return value;
}

/** `dict.get(key, default)` with Python's missing-key distinction. */
function metaOr(object: JsonObject, key: string, fallback: JsonValue): JsonValue {
  return object.has(key) ? (object.get(key) as JsonValue) : fallback;
}

/** Model one JSON value (or the int-0 default) as a Python `+` operand. */
function pyAddend(value: JsonValue | undefined): PyAddend {
  if (value === undefined) return INT_ZERO;
  if (typeof value === 'boolean') {
    return { kind: 'int', value: value ? 1n : 0n, typeName: 'bool' };
  }
  if (value instanceof JsonNumber) {
    return value.kind === 'int'
      ? { kind: 'int', value: value.integer as bigint, typeName: 'int' }
      : { kind: 'float', value: value.float as number, typeName: 'float' };
  }
  if (typeof value === 'string') return { kind: 'string', value, typeName: 'str' };
  if (Array.isArray(value)) return { kind: 'list', value, typeName: 'list' };
  return { kind: 'other', value, typeName: ledgerPythonTypeName(value) };
}

function pyTypeName(value: PyAddend): string {
  return value.typeName;
}

/** Python `+`: numeric addition, str/list concatenation, or a typed failure. */
function pyAdd(left: PyAddend, right: PyAddend): PyAddend {
  if (left.kind === 'int' && right.kind === 'int') {
    return { kind: 'int', value: left.value + right.value, typeName: 'int' };
  }
  if (
    (left.kind === 'int' || left.kind === 'float') &&
    (right.kind === 'int' || right.kind === 'float')
  ) {
    return { kind: 'float', value: pyToFloat(left) + pyToFloat(right), typeName: 'float' };
  }
  if (left.kind === 'string' && right.kind === 'string') {
    return { kind: 'string', value: left.value + right.value, typeName: 'str' };
  }
  if (left.kind === 'list' && right.kind === 'list') {
    return { kind: 'list', value: [...left.value, ...right.value], typeName: 'list' };
  }
  if (left.kind === 'string') {
    throw new FindingIssueTypeError(`can only concatenate str (not "${pyTypeName(right)}") to str`);
  }
  if (left.kind === 'list') {
    throw new FindingIssueTypeError(
      `can only concatenate list (not "${pyTypeName(right)}") to list`,
    );
  }
  throw new FindingIssueTypeError(
    `unsupported operand type(s) for +: '${pyTypeName(left)}' and '${pyTypeName(right)}'`,
  );
}

/** Python's int-to-float conversion: overflow raises `OverflowError`. */
function pyToFloat(value: PyAddend): number {
  if (value.kind === 'float') return value.value;
  if (value.kind !== 'int') throw new FindingIssueTypeError(`invalid numeric count: ${value.kind}`);
  const converted = Number(value.value);
  if (!Number.isFinite(converted)) {
    throw new FindingIssueOverflowError('int too large to convert to float');
  }
  return converted;
}

function pyAddendTitle(value: PyAddend): string {
  switch (value.kind) {
    case 'int':
      return value.value.toString();
    case 'float':
      return pythonFloatStr(value.value);
    case 'string':
      return value.value;
    case 'list':
      return pythonString(value.value);
    case 'other':
      return pythonString(value.value);
  }
}

/** Python `str()` over the lossless JSON model. */
function pythonString(value: JsonValue): string {
  if (value === null) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (value instanceof JsonNumber) {
    return value.kind === 'int'
      ? (value.integer as bigint).toString()
      : pythonFloatStr(value.float as number);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonRepr(item)).join(', ')}]`;
  }
  return `{${value.entries
    .map(([key, item]) => `${pythonReprString(key)}: ${pythonRepr(item)}`)
    .join(', ')}}`;
}

/** Python `repr()` over the lossless JSON model. */
function pythonRepr(value: JsonValue): string {
  return typeof value === 'string' ? pythonReprString(value) : pythonString(value);
}

function pythonFloatStr(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  return pythonFloatRepr(value);
}

/**
 * Python `repr(str)`: quote choice, control escapes and CPython's printable
 * rule (categories `C*`/`Z*` are non-printable, except U+0020).
 */
function pythonReprString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (character === quote || character === '\\') {
      out += `\\${character}`;
    } else if (codePoint === 0x09) {
      out += '\\t';
    } else if (codePoint === 0x0a) {
      out += '\\n';
    } else if (codePoint === 0x0d) {
      out += '\\r';
    } else if (codePoint < 0x20 || codePoint === 0x7f) {
      out += `\\x${hex(codePoint, 2)}`;
    } else if (codePoint < 0x7f) {
      out += character;
    } else if (pythonPrintable(codePoint)) {
      out += character;
    } else if (codePoint <= 0xff) {
      out += `\\x${hex(codePoint, 2)}`;
    } else if (codePoint <= 0xffff) {
      out += `\\u${hex(codePoint, 4)}`;
    } else {
      out += `\\U${hex(codePoint, 8)}`;
    }
  }
  return `${quote}${out}${quote}`;
}

const NON_PRINTABLE = /[\p{C}\p{Z}]/u;

function pythonPrintable(codePoint: number): boolean {
  return codePoint === 0x20 || !NON_PRINTABLE.test(String.fromCodePoint(codePoint));
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

/** Python slicing counts code points, not UTF-16 units. */
function pythonSlice(value: string, start: number, end: number): string {
  return [...value].slice(start, end).join('');
}

/** `base[:10]`: strings slice by code point, lists by element, others refuse. */
function pythonPrefix(value: JsonValue): string {
  if (typeof value === 'string') return pythonSlice(value, 0, 10);
  if (Array.isArray(value)) return pythonRepr(value.slice(0, 10));
  // CPython 3.12+ hashes slice objects, so a dict subscript misses with the
  // slice as the key: KeyError('slice(None, 10, None)').
  if (value instanceof JsonObject) throw new FindingIssueKeyError('slice(None, 10, None)');
  throw new FindingIssueTypeError(`'${ledgerPythonTypeName(value)}' object is not subscriptable`);
}

/** `findings_md.rstrip("\n")`: only `\n`, never other whitespace. */
function pythonRstripNewlines(value: JsonValue): string {
  if (typeof value !== 'string') {
    throw new FindingIssueAttributeError(
      `'${ledgerPythonTypeName(value)}' object has no attribute 'rstrip'`,
    );
  }
  let end = value.length;
  while (end > 0 && value[end - 1] === '\n') end -= 1;
  return value.slice(0, end);
}
