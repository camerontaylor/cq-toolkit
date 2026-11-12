/**
 * Pure port of `apps/crq-python/pr_review_findings.py`.
 *
 * Findings become ONE pull-request review (event COMMENT, `commit_id` = the
 * reviewed head): findings inside the PR diff as inline comments, the rest in
 * the body. Idempotent by the run marker. Effect entry points (`pr_state`,
 * `authenticated_login`, `existing_review`, `diff_hunks`, the POST and the
 * `main` CLI) are deferred: `deliver` takes the findings already read from the
 * ndjson stream plus an injected `gh` port that the replay scripts, so no
 * real `gh`, filesystem, clock or network runs here.
 *
 * The Python JSON model (`JsonValue`) and the string helpers keep Python's
 * semantics: `str()` truthiness and whitespace, code-point lengths and
 * slicing, Unicode-aware `\w`/`\d`, and `json.loads` behaviour including
 * duplicate keys (last wins) and NaN/Infinity constants.
 */
import { JsonObject, JsonNumber, parseJsonValue, type JsonValue } from './jsonValue.js';
import { ledgerPythonTypeName } from './ledger.js';
import { pythonFloatRepr, pythonJsonText, sha256Hex } from './pythonJson.js';
import { pythonLength, pythonStrip, pythonTruthy } from './repairBinding.js';

/** `pr_review_findings.GH_TIMEOUT`; a delivery makes at most five gh calls. */
export const GH_TIMEOUT = 60;
/** Inline threads per review; the rest go in the body. */
export const MAX_INLINE = 50;
/** Characters per inline comment (GitHub caps at 65536). */
export const MAX_COMMENT = 12000;
/** Characters per review body (GitHub caps at 65536). */
export const MAX_BODY = 60000;

const ZWJ = '‍';

// ----------------------------------------------------------- error classes

/** Python `ValueError` from the delivery identity checks. */
export class PrReviewValueError extends Error {
  override readonly name: string = 'PrReviewValueError';
  /** The Python exception class the differential compares. */
  readonly pythonError = 'ValueError';

  constructor(message: string) {
    super(message);
  }
}

/** Python `RuntimeError` from a failed gh call or unexpected gh output. */
export class PrReviewRuntimeError extends Error {
  override readonly name: string = 'PrReviewRuntimeError';
  /** The Python exception class the differential compares. */
  readonly pythonError = 'RuntimeError';

  constructor(message: string) {
    super(message);
  }
}

/** Python `AttributeError` from `.get`/`.splitlines` on the wrong shape. */
export class PrReviewAttributeError extends Error {
  override readonly name: string = 'PrReviewAttributeError';
  readonly pythonError = 'AttributeError';

  constructor(message: string) {
    super(message);
  }
}

/** Python `TypeError` raised by `json.dumps` on a non-serialisable value. */
export class PrReviewTypeError extends Error {
  override readonly name: string = 'PrReviewTypeError';
  readonly pythonError = 'TypeError';

  constructor(message: string) {
    super(message);
  }
}

/**
 * The injected `gh` port. Python's `Gh` is `Callable[..., Any]` returning a
 * completed process; the port returns the same three fields, and the timeout
 * and spawn failures arrive as thrown errors carrying Python's detail text.
 */
export interface GhResult {
  readonly returncode?: JsonValue;
  readonly stdout?: JsonValue;
  readonly stderr?: JsonValue;
}

export type GhPort = (
  argv: readonly string[],
  options: { readonly inputText: string | null },
) => GhResult;

/** Injected failure with Python's `TimeoutExpired` detail (class mapped by the caller). */
export class GhTimeoutError extends Error {
  override readonly name: string = 'GhTimeoutError';
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.detail = detail;
  }
}

/** Injected failure with Python's `OSError` detail. */
export class GhSpawnError extends Error {
  override readonly name: string = 'GhSpawnError';
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.detail = detail;
  }
}

// ------------------------------------------------------- regex equivalents

/** `[A-Za-z0-9][A-Za-z0-9._-]{0,200}` fullmatch over code points. */
export function isRunId(value: string): boolean {
  const characters = [...value];
  if (characters.length < 1 || characters.length > 201) return false;
  const head = characters[0]?.codePointAt(0) as number;
  if (!isAsciiAlphanumeric(head)) return false;
  return characters.slice(1).every((character) => {
    const codePoint = character.codePointAt(0) as number;
    return (
      isAsciiAlphanumeric(codePoint) ||
      codePoint === 0x2e ||
      codePoint === 0x5f ||
      codePoint === 0x2d
    );
  });
}

function isAsciiAlphanumeric(codePoint: number): boolean {
  return (
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a)
  );
}

/**
 * Python `\w` (regex word character): `str.isalnum()` or `_`, i.e. letters,
 * decimal/letter/other numbers and connector punctuation, approximated by
 * `\p{L}`, `\p{Nd}`, `\p{Nl}`, `\p{No}` and `\p{Pc}`. Repository names
 * additionally allow `.` and `-`, which are NOT `\w` characters.
 */
const WORD_CHARACTER = /[\p{L}\p{Nd}\p{Nl}\p{No}_]/u;

/** Repository-name character: Python `\w` plus `.` and `-`. */
function isWordCodePoint(codePoint: number): boolean {
  if (codePoint === 0x2e || codePoint === 0x2d) return true;
  return isRegexWordCodePoint(codePoint);
}

/** Python `\w`: used for regex classes, the mention lookbehind and `\b`. */
function isRegexWordCodePoint(codePoint: number): boolean {
  return WORD_CHARACTER.test(String.fromCodePoint(codePoint));
}

/** Python `REPO.fullmatch`: nonempty `\w.-` sides around exactly one slash. */
export function isRepo(value: string): boolean {
  const characters = [...value];
  const slash = characters.indexOf('/');
  if (slash <= 0 || slash === characters.length - 1) return false;
  if (characters.filter((character) => character === '/').length !== 1) return false;
  return characters.every(
    (character) => character === '/' || isWordCodePoint(character.codePointAt(0) as number),
  );
}

/** `[0-9a-f]{40}` fullmatch. */
export function isSha(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 40 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) as number;
      return (codePoint >= 0x30 && codePoint <= 0x39) || (codePoint >= 0x61 && codePoint <= 0x66);
    })
  );
}

/** `[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?` fullmatch. */
export function isLogin(value: string): boolean {
  const characters = [...value];
  if (characters.length < 1 || characters.length > 44) return false;
  if (!isAsciiAlphanumeric(characters[0]?.codePointAt(0) as number)) return false;
  const rest = characters.slice(1).join('');
  const suffix = rest.endsWith('[bot]');
  const core = suffix ? rest.slice(0, -5) : rest;
  return (
    core.length <= 38 &&
    [...core].every((character) => {
      const codePoint = character.codePointAt(0) as number;
      return isAsciiAlphanumeric(codePoint) || codePoint === 0x2d;
    })
  );
}

// ------------------------------------------------------ text neutralisation

/** The run marker: `<\!-- crq-findings run=... -->`. */
export function marker(runId: string): string {
  return `<!-- crq-findings run=${runId} -->`;
}

/**
 * Prose outside code: no live mention, no opening of an HTML comment.
 * Python `\w` before `@` is Unicode-aware, so `é@user` is not a mention.
 */
function neutraliseProse(segment: string): string {
  let out = '';
  let index = 0;
  while (index < segment.length) {
    if (segment.startsWith('<!--', index)) {
      out += '&lt;!--';
      index += 4;
      continue;
    }
    if (segment[index] === '@') {
      const previous = codePointBefore(segment, index);
      const next = segment.codePointAt(index + 1);
      // Python's lookbehind is `(?<![\w`@/.])`: `\w` (not repo punctuation)
      // plus backtick, `@`, `.` and `/` — `-` still allows a mention.
      const previousBlocks =
        previous !== null &&
        (isRegexWordCodePoint(previous) ||
          previous === 0x60 ||
          previous === 0x40 ||
          previous === 0x2f ||
          previous === 0x2e);
      if (!previousBlocks && next !== undefined && isAsciiAlphanumeric(next)) {
        out += `@${ZWJ}`;
        index += 1;
        continue;
      }
    }
    const codePoint = segment.codePointAt(index) as number;
    out += String.fromCodePoint(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return out;
}

function codePointBefore(text: string, index: number): number | null {
  if (index === 0) return null;
  const previous = text.codePointAt(index - 1) ?? null;
  // The code unit at `index - 1` may be the low half of a surrogate pair whose
  // high half sits at `index - 2`; combine them so Python's `\w` sees the
  // astral code point (e.g. the letter `\U0001d538`) rather than a lone low
  // surrogate. Unpaired halves keep their own code points, like Python.
  if (previous !== null && previous >= 0xdc00 && previous <= 0xdfff && index >= 2) {
    // `codePointAt` decodes, so read the raw UTF-16 code unit with
    // `charCodeAt`: the astral letter itself (0x1d538) is not in the high
    // surrogate range, but its leading code unit (0xd835) is.
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) {
      return 0x10000 + ((high - 0xd800) << 10) + (previous - 0xdc00);
    }
  }
  return previous;
}

/**
 * Inline code spans on one line: `(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)`. The
 * span content is excluded from prose neutralisation.
 */
function neutraliseInline(line: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const match = matchSpan(line, at);
    if (match === null) break;
    out += neutraliseProse(line.slice(at, match.start));
    out += line.slice(match.start, match.end);
    at = match.end;
  }
  return out + neutraliseProse(line.slice(at));
}

interface SpanMatch {
  readonly start: number;
  readonly end: number;
}

function matchSpan(line: string, from: number): SpanMatch | null {
  for (let start = from; start < line.length; start += 1) {
    if (line[start] !== '`') continue;
    if (start > 0 && line[start - 1] === '`') continue;
    let runEnd = start;
    while (line[runEnd] === '`') runEnd += 1;
    if (line[runEnd] === '`') continue; // (?!`) after the run
    const run = line.slice(start, runEnd);
    // (.+?)(?<!`)\1(?!`): shortest content not touching backticks, closed by
    // an equal-length run on the same line.
    const close = findClose(line, runEnd + 1, run);
    if (close === null) continue;
    return { start, end: close };
  }
  return null;
}

function findClose(line: string, from: number, run: string): number | null {
  const tick = run.length;
  for (let index = from; index <= line.length - tick; index += 1) {
    if (line[index] !== '`') continue;
    if (line[index - 1] === '`') continue;
    if (line.slice(index, index + tick) !== run) continue;
    if (line[index + tick] === '`') continue;
    return index + tick;
  }
  return null;
}

/**
 * Insert a zero-width joiner after every `@` that GitHub would treat as a
 * mention and escape any `<!--` in prose, outside code spans and line-start
 * fences. An open fence is closed so it cannot swallow the next finding.
 */
export function neutraliseMentions(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    if (fence !== null) {
      out.push(line);
      // Python `line.strip()` removes whitespace on BOTH sides (CR and tabs
      // included); the indent count stays spaces-only, on the raw line.
      const stripped = pythonStrip(line);
      let indent = 0;
      while (indent < line.length && line[indent] === ' ') indent += 1;
      if (
        indent <= 3 &&
        stripped.length > 0 &&
        [...stripped].every((character) => character === fence?.[0]) &&
        stripped.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    const opened = matchFenceOpen(line);
    if (opened !== null) {
      fence = opened;
      out.push(line);
      continue;
    }
    out.push(neutraliseInline(line));
  }
  if (fence !== null) out.push(fence);
  return out.join('\n');
}

/**
 * `^ {0,3}(`{3,}(?=[^`]*$)|~{3,})`: a backtick fence's info string holds no
 * further backtick; a tilde fence accepts any info string.
 */
function matchFenceOpen(line: string): string | null {
  let indent = 0;
  while (indent < line.length && line[indent] === ' ') indent += 1;
  if (indent > 3) return null;
  const rest = line.slice(indent);
  if (rest.length < 3) return null;
  const fenceCharacter = rest[0];
  if (fenceCharacter !== '`' && fenceCharacter !== '~') return null;
  let runEnd = 0;
  while (runEnd < rest.length && rest[runEnd] === fenceCharacter) runEnd += 1;
  if (runEnd < 3) return null;
  const info = rest.slice(runEnd);
  if (fenceCharacter === '`' && info.includes('`')) return null;
  return rest.slice(0, runEnd);
}

/**
 * A heading field (severity, title): one line, whitespace-collapsed like
 * Python `' '.join(text.split())`, HTML comments removed, then neutralised.
 */
export function oneLine(text: JsonValue): string {
  const collapsed = pythonSpaceSplit(pythonStr(text)).join(' ');
  const withoutComments = removeHtmlComments(collapsed);
  return neutraliseMentions(pythonSpaceSplit(withoutComments).join(' '));
}

/** Python `str.split()` with no argument: runs of `str.isspace()` code points. */
function pythonSpaceSplit(text: string): string[] {
  const out: string[] = [];
  let start = -1;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index) as number;
    const wide = codePoint > 0xffff;
    const isSpace = pythonIsSpace(codePoint);
    if (isSpace) {
      if (start !== -1) {
        out.push(text.slice(start, index));
        start = -1;
      }
    } else if (start === -1) {
      start = index;
    }
    index += wide ? 2 : 1;
  }
  if (start !== -1) out.push(text.slice(start));
  return out;
}

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

/** `<!--.*?-->` (DOTALL) removal over code points. */
function removeHtmlComments(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('<!--', index);
    if (open === -1) return out + text.slice(index);
    const close = text.indexOf('-->', open + 4);
    if (close === -1) return out + text.slice(index);
    out += text.slice(index, open);
    index = close + 3;
  }
  return out;
}

/** Python `str()` over the lossless JSON model. */
export function pythonStr(value: JsonValue): string {
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

function pythonRepr(value: JsonValue): string {
  return typeof value === 'string' ? pythonReprString(value) : pythonStr(value);
}

function pythonFloatStr(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  return pythonFloatNumberText(value);
}

/** The Python `repr(float)` text (`.0` kept, Python exponent form). */
function pythonFloatNumberText(value: number): string {
  return pythonFloatRepr(value);
}

/** Python `repr(str)`: quote choice, control escapes, CPython printable rule. */
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

/** `text` as one inline code span whatever backticks it holds. */
export function codeSpan(text: JsonValue): string {
  const collapsed = pythonSpaceSplit(pythonStr(text)).join(' ');
  const runs: number[] = [];
  let index = 0;
  while (index < collapsed.length) {
    if (collapsed[index] === '`') {
      let runEnd = index;
      while (collapsed[runEnd] === '`') runEnd += 1;
      runs.push(runEnd - index);
      index = runEnd;
    } else {
      index += (collapsed.codePointAt(index) as number) > 0xffff ? 2 : 1;
    }
  }
  const tick = '`'.repeat(runs.length > 0 ? Math.max(...runs) + 1 : 1);
  const pad = collapsed.startsWith('`') || collapsed.endsWith('`') ? ' ' : '';
  return `${tick}${pad}${collapsed}${pad}${tick}`;
}

/**
 * Finding prose without HTML comments and without a leading bold copy of the
 * title. Committable ```suggestion blocks become plain fences.
 */
export function cleanText(text: JsonValue, title: JsonValue = ''): string {
  if (typeof text !== 'string') {
    throw new PrReviewTypeError(
      `expected string or bytes-like object, got '${ledgerPythonTypeName(text)}'`,
    );
  }
  let body = pythonStrip(removeHtmlComments(text));
  const titleText = pythonStr(title);
  if (titleText && body.startsWith(`**${titleText}**`)) {
    body = body.slice(titleText.length + 4);
    body = pythonLstrip(body);
  }
  body = demoteSuggestions(body);
  return neutraliseMentions(body);
}

/** Python `str.lstrip()` (default whitespace). */
function pythonLstrip(text: string): string {
  let start = 0;
  while (start < text.length) {
    const codePoint = text.codePointAt(start) as number;
    if (!pythonIsSpace(codePoint)) break;
    start += codePoint > 0xffff ? 2 : 1;
  }
  return text.slice(start);
}

/**
 * `^( {0,3})```suggestion\b` → `` `$1```text` `` over code points, with
 * Python's `\b` semantics: the boundary holds when the code point after
 * `suggestion` is a word character XOR the last `n` is one.
 */
function demoteSuggestions(text: string): string {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    let indent = 0;
    while (indent < line.length && line[indent] === ' ') indent += 1;
    if (indent > 3) continue;
    const rest = line.slice(indent);
    if (!rest.startsWith('```suggestion')) continue;
    const after = rest.slice('```suggestion'.length);
    if (!isWordBoundary(after)) continue;
    lines[index] = `${' '.repeat(indent)}\`\`\`text${after}`;
  }
  return lines.join('\n');
}

/** Python `\b` after `suggestion`: word character XOR nothing (end of string). */
function isWordBoundary(after: string): boolean {
  if (after.length === 0) return true;
  const codePoint = after.codePointAt(0) as number;
  return !isRegexWordCodePoint(codePoint);
}

// ---------------------------------------------------------------- anchoring

export interface HunkRange {
  readonly lo: number;
  readonly hi: number;
}

/** Right-side line ranges covered by each hunk of a unified patch. */
export function rightRanges(patch: JsonValue): Array<HunkRange> {
  if (patch === null) return [];
  if (typeof patch !== 'string') {
    throw new PrReviewTypeError(
      `expected string or bytes-like object, got '${ledgerPythonTypeName(patch)}'`,
    );
  }
  const ranges: Array<HunkRange> = [];
  let index = 0;
  for (;;) {
    const at = patch.indexOf('@@', index);
    if (at === -1) break;
    const parsed = parseHunkHeader(patch, at);
    if (parsed !== null) {
      const [start, length, end] = parsed;
      if (length > 0) ranges.push({ lo: start, hi: start + length - 1 });
      index = end;
    } else {
      index = at + 2;
    }
  }
  return ranges;
}

/**
 * `^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@` at `at` (re.M: anchored to a
 * line start). `\d` is Unicode Nd.
 */
function parseHunkHeader(patch: string, at: number): readonly [number, number, number] | null {
  if (at > 0 && patch[at - 1] !== '\n') return null;
  let index = at + 2;
  if (!patch.startsWith(' -', index)) return null;
  index += 2;
  const left = scanDigits(patch, index);
  if (left === index) return null;
  index = left;
  if (patch[index] === ',') {
    index += 1;
    const more = scanDigits(patch, index);
    if (more === index) return null;
    index = more;
  }
  if (patch[index] !== ' ') return null;
  index += 1;
  if (patch[index] !== '+') return null;
  index += 1;
  const start = scanDigits(patch, index);
  if (start === index) return null;
  let startValue = 0n;
  for (let i = index; i < start; i += 1) {
    startValue = startValue * 10n + BigInt(decimalDigitValue(patch.codePointAt(i) as number));
  }
  if (startValue > Number.MAX_SAFE_INTEGER) return null;
  index = start;
  let lengthValue = 1n;
  if (patch[index] === ',') {
    index += 1;
    const length = scanDigits(patch, index);
    if (length === index) return null;
    lengthValue = 0n;
    for (let i = index; i < length; i += 1) {
      lengthValue = lengthValue * 10n + BigInt(decimalDigitValue(patch.codePointAt(i) as number));
    }
    if (lengthValue > Number.MAX_SAFE_INTEGER) return null;
    index = length;
  }
  if (!patch.startsWith(' @@', index)) return null;
  return [Number(startValue), Number(lengthValue), index + 3];
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

/** Unicode `Nd` code points occur in aligned runs of ten. */
function decimalDigitValue(codePoint: number): number {
  if (codePoint >= 0x30 && codePoint <= 0x39) return codePoint - 0x30;
  let start = codePoint;
  while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
  return (codePoint - start) % 10;
}

/** A finding dict in the pure port: insertion-ordered key/value pairs. */
export interface Finding {
  readonly severity: JsonValue;
  readonly path: JsonValue;
  readonly start: JsonValue;
  readonly end: JsonValue;
  readonly title: JsonValue;
  readonly text: JsonValue;
}

export interface HunkMap {
  readonly [path: string]: ReadonlyArray<HunkRange>;
}

/**
 * Inline position for a finding, or undefined when it must go in the body.
 * The first hunk overlapping the finding's lines anchors it, clamped to that
 * hunk.
 */
export function anchor(finding: Finding, hunks: HunkMap): Record<string, JsonValue> | undefined {
  const path = finding.path;
  const start = finding.start;
  if (!pythonTruthy(path) || !pythonTruthy(start) || typeof path !== 'string') {
    return undefined;
  }
  // Python dict lookup never sees inherited keys; guard the prototype chain
  // so a file named `constructor` or `toString` stays unanchored.
  const ranges = Object.hasOwn(hunks, path) ? hunks[path] : undefined;
  if (ranges === undefined) return undefined;
  const end = finding.end;
  // Python compares start/end against hunk bounds directly; a None end raises
  // TypeError here (the oracle keeps that failure).
  const startNumber = requireComparisonInt(start, 'start');
  const endNumber = requireComparisonInt(end, 'end');
  for (const { lo, hi } of ranges) {
    // Arbitrary-size ints stay exact via bigint so a 10^30 line still
    // compares (and never overlaps, landing in the body like Python).
    if (startNumber <= BigInt(hi) && endNumber >= BigInt(lo)) {
      const first = startNumber > BigInt(lo) ? startNumber : BigInt(lo);
      const last = endNumber < BigInt(hi) ? endNumber : BigInt(hi);
      const position: Record<string, JsonValue> = {
        path,
        line: JsonNumber.int(last),
        side: 'RIGHT',
      };
      if (first < last) {
        position.start_line = JsonNumber.int(first);
        position.start_side = 'RIGHT';
      }
      return position;
    }
  }
  return undefined;
}

/** A JSON integer as the lossless model value. */
function jsonInt(value: number): JsonValue {
  return Number.isSafeInteger(value)
    ? JsonNumber.int(BigInt(value))
    : JsonNumber.int(BigInt(value));
}

/** The finding's line values are Python ints (never floats or bools). */
/**
 * Python unboxes the JSON finding for `start <= hi and end >= lo`; a None or
 * non-int value raises TypeError against the int hunk bounds.
 */
function requireComparisonInt(value: JsonValue, field: string): bigint {
  if (value === null) {
    throw new PrReviewTypeError(`'>=' not supported between instances of 'NoneType' and 'int'`);
  }
  if (value instanceof JsonNumber && value.kind === 'int') {
    return value.integer as bigint;
  }
  const number = numberOrNone(value);
  if (number === null) {
    throw new PrReviewTypeError(
      `'${ledgerPythonTypeName(value)}' object cannot be interpreted as an integer (${field})`,
    );
  }
  return BigInt(number);
}

function numberOrNone(value: JsonValue): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (value instanceof JsonNumber && value.kind === 'int') {
    const converted = Number(value.integer);
    return Number.isSafeInteger(converted) ? converted : null;
  }
  return null;
}

function linesSuffix(finding: Finding): string {
  const start = finding.start;
  if (!pythonTruthy(start)) return '';
  const end = finding.end;
  if (!pythonTruthy(end)) return `lines ${pythonStr(start)}-${pythonStr(end)}`;
  // Python `start == end` over ints and floats; model ints compare exactly.
  const equal =
    start === end ||
    (start instanceof JsonNumber &&
      end instanceof JsonNumber &&
      (start.kind === 'int' ? (start.integer as bigint) : start.float) ===
        (end.kind === 'int' ? (end.integer as bigint) : end.float));
  if (equal) return `line ${pythonStr(start)}`;
  return `lines ${pythonStr(start)}-${pythonStr(end)}`;
}

function clip(text: string, limit: number): string {
  if (pythonLength(text) <= limit) return text;
  let cut = pythonSlice(text, 0, limit);
  cut = pythonRstrip(cut);
  // A clip can sever a code fence; close it so the trailer renders as
  // prose (same policy in the Python oracle). The closure is the full
  // opener run, matching what neutralisation appends, so a 4-backtick or
  // 5-tilde fence is genuinely closed.
  const fence = fenceState(cut.split('\n'));
  if (fence !== null) cut += `\n${fence}`;
  return `${cut}\n\n… (truncated; full text in the crq run artifacts)`;
}

/**
 * The open fence run after scanning lines with the module's own rules.
 * Openers are matchFenceOpen over the RAW line (spaces-only indent, so a
 * tab-indented delimiter never opens). Closers use the neutralise rule:
 * pythonStrip, so a tab-prefixed closer of the same character with at
 * least the opener's length does close, exactly as in neutraliseMentions.
 */
function fenceState(lines: readonly string[]): string | null {
  let fence: string | null = null;
  for (const line of lines) {
    const opened = matchFenceOpen(line);
    if (fence === null) {
      if (opened !== null) fence = opened;
      continue;
    }
    const stripped = pythonStrip(line);
    let indent = 0;
    while (indent < line.length && line[indent] === ' ') indent += 1;
    if (
      indent <= 3 &&
      stripped.length > 0 &&
      [...stripped].every((character) => character === fence?.[0]) &&
      stripped.length >= fence.length
    ) {
      fence = null;
    }
  }
  return fence;
}

/**
 * Cut `body` to `limit`, closing any open fence, so the WHOLE result
 * (prefix + closure + trailer) stays within `limit`.
 *
 * Shortening the prefix can re-open an earlier (longer) fence, so one
 * reservation is not enough; iterate: reserve the currently-scanned
 * closure from the budget, rescan, until the scan is stable (the
 * reservation already fits). Each round either stabilises or strictly
 * shrinks the budget toward the trailer-length floor, so it terminates;
 * a stable round satisfies prefix+closure+trailer == limit exactly.
 */
function bodyCap(body: string, limit: number): string {
  const trailer = '\n\n… (truncated; full text in the crq run artifacts)\n';
  let budget = limit;
  let best: { readonly length: number; readonly text: string } | null = null;
  while (true) {
    const prefix = pythonSlice(body, 0, budget);
    const fence = fenceState(prefix.split('\n'));
    const closure = fence === null ? '' : `\n${fence}`;
    const total = pythonLength(prefix) + pythonLength(closure) + pythonLength(trailer);
    if (total <= limit && (best === null || pythonLength(prefix) > best.length)) {
      best = { length: pythonLength(prefix), text: `${prefix}${closure}${trailer}` };
    }
    const reserved = limit - pythonLength(closure) - pythonLength(trailer);
    if (reserved >= budget) {
      return `${prefix}${closure}${trailer}`;
    }
    if (reserved <= 0) {
      break;
    }
    budget = reserved;
  }
  // Degenerate contents (a fence opener longer than any budget can
  // carry its closure): re-emit with the prefix cut BEFORE the first
  // fence opener line, so nothing opens and the output stays closed.
  // 59900/60000-tilde summaries land here (iteration oscillates or the
  // best emission leaves an open fence) and keep the marker + prose head
  // instead of losing everything to an unterminated run.
  const floor = limit - pythonLength(trailer);
  let offset = 0;
  for (const line of body.split('\n')) {
    if (offset > floor) {
      break;
    }
    if (matchFenceOpen(line) !== null) {
      const prefix = pythonSlice(body, 0, offset);
      if (prefix.length > 0) {
        return `${pythonRstrip(prefix)}${trailer}`;
      }
      return pythonStrip(trailer);
    }
    offset += [...line].length + 1;
  }
  if (best !== null) {
    return best.text;
  }
  return `${pythonSlice(body, 0, floor)}${trailer}`;
}

/** Python `str.rstrip()` (default whitespace) over a JavaScript string. */
function pythonRstrip(text: string): string {
  const characters = [...text];
  let end = characters.length;
  while (end > 0) {
    const codePoint = characters[end - 1]?.codePointAt(0);
    if (codePoint === undefined || !pythonIsSpace(codePoint)) break;
    end -= 1;
  }
  return characters.slice(0, end).join('');
}

/** Python `"\n".join(lines).rstrip()` before the final newline. */
function rstripTrailingNewlines(text: string): string {
  return pythonRstrip(text);
}

/** Python slicing counts code points, not UTF-16 units. */
function pythonSlice(value: string, start: number, end: number): string {
  return [...value].slice(start, end).join('');
}

export interface ReviewMeta {
  readonly [key: string]: JsonValue | undefined;
}

/** The review payload. `hunks === null` means no diff is known: body-only. */
export function buildReview(
  meta: JsonObject,
  findings: readonly Finding[],
  hunks: HunkMap | null,
): JsonObject {
  const hunkMap = hunks;
  const runId = metaOr(meta, 'run_id');
  const base = metaOr(meta, 'base');
  const head = metaOr(meta, 'head');
  const comments: Array<Record<string, JsonValue>> = [];
  const unanchored: Array<{
    readonly number: number;
    readonly finding: Finding;
    readonly heading: string;
    readonly text: string;
  }> = [];
  for (const [offset, finding] of findings.entries()) {
    const number = offset + 1;
    const position =
      hunkMap !== null && comments.length < MAX_INLINE ? anchor(finding, hunkMap) : undefined;
    let heading = `**crq finding F${number} [${oneLine(finding.severity)}]**`;
    if (pythonTruthy(finding.title)) {
      heading += ` ${oneLine(finding.title)}`;
    }
    const text = cleanText(finding.text, finding.title);
    if (position) {
      const where = linesSuffix(finding);
      const note = `

<sub>crq run \`${pythonStr(runId)}\`${where ? `, ${where}` : ''}</sub>`;
      const body =
        clip(
          `${heading}

${text}`,
          MAX_COMMENT,
        ) + note;
      comments.push({ ...position, body });
    } else {
      unanchored.push({ number, finding, heading, text });
    }
  }
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const severity = oneLine(finding.severity);
    counts.set(severity, (counts.get(severity) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .sort((left, right) => compareStrings(left[0], right[0]))
    .map(([severity, count]) => `${count} ${severity}`)
    .join(', ');
  const labelValue = pythonTruthy(meta.get('label'))
    ? meta.get('label')
    : `crq findings (CodeRabbit CLI, local run ${pythonStr(runId)}, ${pythonPrefix(pythonStr(base))}..${pythonPrefix(pythonStr(head))})`;
  const label = oneLine(labelValue as JsonValue);
  const itemField = meta.has('item_id') ? meta.get('item_id') : '';
  const lines = [
    marker(pythonStr(runId)),
    cleanText(meta.has('summary') ? (meta.get('summary') as JsonValue) : ''),
    `### ${label}`,
    '',
    `${findings.length} finding(s) (${summary}): ${comments.length} as inline threads, ` +
      `${unanchored.length} listed below.`,
    '',
    `Queue item \`${pythonStr(itemField as JsonValue)}\`, reviewed range \`${pythonStr(base)}..${pythonStr(head)}\`. ` +
      (pythonTruthy(meta.get('label'))
        ? `${label}. Reply on a thread or resolve it after an explicit disposition.`
        : 'Posted by crq, the local review queue that runs the CodeRabbit CLI on this host. ' +
          'This is not a CodeRabbit PR review. Reply on a thread or resolve it once addressed.'),
  ];
  if (unanchored.length > 0) {
    lines.push('', '#### Not anchored to the PR diff', '');
    for (const entry of unanchored) {
      const where = [
        pythonTruthy(entry.finding.path) ? codeSpan(entry.finding.path) : '',
        linesSuffix(entry.finding),
      ]
        .filter((part) => part !== '')
        .join(' ');
      lines.push(
        `${entry.heading}${where ? ` (${where})` : ''}`,
        '',
        clip(entry.text, MAX_COMMENT),
        '',
      );
    }
  }
  let body = `${rstripTrailingNewlines(lines.join('\n'))}\n`;
  if (pythonLength(body) > MAX_BODY) {
    body = bodyCap(body, MAX_BODY);
  }
  const review: Array<readonly [string, JsonValue]> = [
    ['event', 'COMMENT'],
    ['body', body],
    ['comments', comments.map((comment) => new JsonObject(Object.entries(comment)))],
  ];
  if (hunkMap !== null) {
    review.push(['commit_id', head as JsonValue]);
  }
  return new JsonObject(review);
}

/** Python `value[:10]` over a str. */
function pythonPrefix(value: string): string {
  return pythonSlice(value, 0, 10);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function metaOr(meta: JsonObject, key: string, fallback: JsonValue = ''): JsonValue {
  const value = meta.get(key);
  return value === undefined ? fallback : value;
}

/** Replace one key's value, preserving position and the remaining order. */
function withObject(object: JsonObject, key: string, value: JsonValue): JsonObject {
  const entries: Array<readonly [string, JsonValue]> = object.entries.map(([name, existing]) =>
    name === key ? [key, value] : [name, existing],
  );
  if (!object.has(key)) entries.push([key, value]);
  return new JsonObject(entries);
}

// ---------------------------------------------------------------- delivery

export interface DeliverInput {
  readonly repo: string;
  readonly pr: number;
  readonly meta: JsonObject;
  readonly findings: readonly Finding[];
  readonly gh: GhPort;
  readonly login?: string | null;
}

export interface DeliverResult {
  readonly state: 'created' | 'existing' | 'skipped-closed' | 'skipped-empty' | 'skipped-head';
  readonly review_id: JsonValue;
  readonly review_url: JsonValue;
  readonly inline: number;
  readonly body_only: number;
}

function result(overrides: Partial<DeliverResult> = {}): DeliverResult {
  // Python spreads `{**result, "state": ...}`: `state` is the LAST key.
  return {
    review_id: null,
    review_url: null,
    inline: 0,
    body_only: 0,
    state: 'created',
    ...overrides,
  };
}

function callGh(gh: GhPort, argv: readonly string[], inputText: string | null): GhResult {
  try {
    return gh(argv, { inputText });
  } catch (error) {
    if (error instanceof GhTimeoutError) {
      throw new PrReviewRuntimeError(
        `${argv.slice(0, 4).join(' ')} … timed out after ${GH_TIMEOUT}s`,
      );
    }
    if (error instanceof GhSpawnError) {
      throw new PrReviewRuntimeError(
        `${argv.slice(0, 4).join(' ')} … could not start: ${error.detail}`,
      );
    }
    throw error;
  }
}

/** Python `type(value) is int`: JsonNumber int, booleans excluded. */
function isPythonInt(value: JsonValue | undefined): value is JsonNumber {
  return value instanceof JsonNumber && value.kind === 'int';
}

/** The exit status a scripted gh answered with, as a plain number. */
function rawReturncode(callResult: GhResult): number | boolean | null {
  const raw = callResult.returncode ?? 0;
  if (raw instanceof JsonNumber) {
    return raw.kind === 'int' ? Number(raw.integer) : (raw.float as number);
  }
  return typeof raw === 'number' || typeof raw === 'boolean' ? raw : null;
}

function okGh(argv: readonly string[], callResult: GhResult): GhResult {
  const returncode = rawReturncode(callResult);
  if (returncode === null || (returncode !== 0 && returncode !== false)) {
    const stderr = pythonSlice(pythonStrip(ghString(callResult.stderr)), 0, 300);
    throw new PrReviewRuntimeError(
      `${argv.slice(0, 4).join(' ')} … exit ${String(returncode)}: ${stderr}`,
    );
  }
  return callResult;
}

function ghString(value: JsonValue | undefined): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    throw new PrReviewAttributeError(
      `'${ledgerPythonTypeName(value)}' object has no attribute 'strip'`,
    );
  }
  return value;
}

/** Python `json.loads` on stdout; '' or null becomes Python's `None`. */
function parseGhJson(argv: readonly string[], callResult: GhResult): JsonValue {
  const out = okGh(argv, callResult);
  const stdout = ghString(out.stdout);
  try {
    return parseJsonValue(stdout === '' ? 'null' : stdout, { duplicates: 'last' });
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new PrReviewRuntimeError(
        `${argv.slice(0, 4).join(' ')} … unparsable output: ${pythonSlice(pythonStrip(stdout), 0, 200)}`,
      );
    }
    throw error;
  }
}

interface PrState {
  readonly [key: string]: JsonValue;
}

function prState(gh: GhPort, repo: string, pr: number): PrState {
  const argv = [
    'gh',
    'api',
    `repos/${repo}/pulls/${pr}`,
    '--jq',
    '{state: .state, merged: .merged, base: .base.sha, head: .head.sha}',
  ];
  const data = parseGhJson(argv, callGh(gh, argv, null));
  if (!(data instanceof JsonObject)) {
    throw new PrReviewRuntimeError(`unexpected PR metadata for ${repo}#${pr}`);
  }
  const state = data.get('state');
  if (state !== 'open' && state !== 'closed') {
    throw new PrReviewRuntimeError(`unexpected PR metadata for ${repo}#${pr}`);
  }
  return {
    state,
    merged: data.has('merged') ? (data.get('merged') as JsonValue) : null,
    base: data.has('base') ? (data.get('base') as JsonValue) : null,
    head: data.has('head') ? (data.get('head') as JsonValue) : null,
  };
}

function authenticatedLogin(gh: GhPort): string {
  const argv = ['gh', 'api', 'user', '--jq', '.login'];
  const login = pythonStrip(ghString(okGh(argv, callGh(gh, argv, null)).stdout));
  if (!isLogin(login)) {
    throw new PrReviewRuntimeError(`gh api user returned no usable login: ${reprClamped(login)}`);
  }
  return login;
}

/** Python `{value[:80]!r}`: repr of the first 80 code points. */
function reprClamped(value: string): string {
  return pythonReprString(pythonSlice(value, 0, 80));
}

interface ExistingReview {
  readonly id: number;
  readonly url: JsonValue;
}

function existingReview(
  gh: GhPort,
  repo: string,
  pr: number,
  runId: string,
  login: string,
): ExistingReview | undefined {
  const wanted = pythonJsonText(marker(runId), { asciiOnly: true, sortKeys: false, indent: null });
  const jq =
    `.[] | select(.user.login == ${pythonJsonText(login, { asciiOnly: true, sortKeys: false, indent: null })} and ` +
    `((.body // "") | startswith(${wanted}))) | {id: .id, url: .html_url}`;
  const argv = [
    'gh',
    'api',
    '--paginate',
    `repos/${repo}/pulls/${pr}/reviews?per_page=100`,
    '--jq',
    jq,
  ];
  const out = okGh(argv, callGh(gh, argv, null));
  const stdout = ghString(out.stdout);
  // Python `splitlines()`: empty stdout is zero rows, not one empty row.
  for (const line of stdout === '' ? [] : stdout.replace(/\n$/, '').split('\n')) {
    let row: JsonValue;
    try {
      row = parseJsonValue(line === '' ? 'null' : line, { duplicates: 'last' });
    } catch {
      continue;
    }
    const id = row instanceof JsonObject ? row.get('id') : undefined;
    if (isPythonInt(id)) {
      return {
        id: Number(id.integer),
        url: row instanceof JsonObject && row.has('url') ? (row.get('url') as JsonValue) : null,
      };
    }
  }
  return undefined;
}

function diffHunks(gh: GhPort, repo: string, base: string, head: string): HunkMap {
  const argv = [
    'gh',
    'api',
    `repos/${repo}/compare/${base}...${head}`,
    '--jq',
    '[.files[]? | {filename, status, patch}]',
  ];
  const data = parseGhJson(argv, callGh(gh, argv, null));
  const hunks: Record<string, ReadonlyArray<HunkRange>> = Object.create(null) as Record<
    string,
    ReadonlyArray<HunkRange>
  >;
  if (Array.isArray(data)) {
    for (const row of data as readonly JsonValue[]) {
      if (!(row instanceof JsonObject)) continue;
      const filename = row.get('filename');
      const status = row.get('status');
      if (typeof filename !== 'string') continue;
      if (status === 'removed') continue;
      const patch = row.has('patch') ? row.get('patch') : null;
      const ranges = rightRanges(patch ?? null);
      if (ranges.length > 0) hunks[filename] = ranges;
    }
  }
  return hunks;
}

function postReview(
  gh: GhPort,
  repo: string,
  pr: number,
  review: JsonValue,
): { readonly argv: readonly string[]; readonly callResult: GhResult } {
  const argv = [
    'gh',
    'api',
    '--method',
    'POST',
    `repos/${repo}/pulls/${pr}/reviews`,
    '--input',
    '-',
  ];
  return { argv, callResult: callGh(gh, argv, pythonDumpsDefault(review)) };
}

/**
 * Post this run's findings review on the PR, at most once.
 *
 * The findings arrive already read from the ndjson stream (`loadFindings` in
 * the driver; the pure module keeps only the Python ordering semantics).
 */
export function deliver(input: DeliverInput): DeliverResult {
  const { repo, pr, meta, findings, gh } = input;
  const runIdValue = meta.has('run_id') ? meta.get('run_id') : undefined;
  const headValue = meta.has('head') ? meta.get('head') : undefined;
  if (
    !isRepo(repo) ||
    typeof pr !== 'number' ||
    !Number.isInteger(pr) ||
    pr <= 0 ||
    typeof runIdValue !== 'string' ||
    !isRunId(runIdValue) ||
    !isSha(headValue) ||
    typeof meta.get('base') !== 'string' ||
    !pythonTruthy(meta.get('base'))
  ) {
    throw new PrReviewValueError('invalid PR review delivery identity');
  }
  const runId: string = runIdValue;
  const head: string = headValue;
  const loginInput = input.login;
  if (loginInput !== null && loginInput !== undefined && !isLogin(loginInput)) {
    throw new PrReviewValueError('invalid posting login');
  }
  if (
    findings.length === 0 &&
    !pythonTruthy(meta.has('summary') ? (meta.get('summary') as JsonValue) : null) &&
    !pythonTruthy(meta.has('local_review') ? (meta.get('local_review') as JsonValue) : null)
  ) {
    return result({ state: 'skipped-empty' });
  }
  const state = prState(gh, repo, pr);
  if (state.state !== 'open' || pythonTruthy(state.merged)) {
    return result({ state: 'skipped-closed' });
  }
  if (
    pythonTruthy(meta.has('local_review') ? (meta.get('local_review') as JsonValue) : null) &&
    !ledgerValueEqualText(state.head, head)
  ) {
    return result({ state: 'skipped-head' });
  }
  if (
    findings.length === 0 &&
    !pythonTruthy(meta.has('summary') ? (meta.get('summary') as JsonValue) : null)
  ) {
    return result({ state: 'skipped-empty' });
  }
  const login = loginInput ?? authenticatedLogin(gh);
  let fingerprint: string | null = null;
  let wanted = '';
  if (!pythonTruthy(meta.has('summary') ? (meta.get('summary') as JsonValue) : null)) {
    // Python `json.dumps(f, sort_keys=True, ensure_ascii=True)` keeps its
    // DEFAULT separators (', ', ': '); the compact canonical writer here
    // emits (',', ':'), so the fingerprint input is assembled explicitly.
    const normalized = findings
      .map((finding) => pythonDumpsDefaultSortKeys(findingToJson(finding) as JsonObject))
      .sort(compareStrings);
    fingerprint = sha256Hex(
      new TextEncoder().encode(
        `[${normalized.map((item) => pythonJsonText(item, { asciiOnly: true, sortKeys: false, indent: null })).join(', ')}]`,
      ),
    );
    wanted = `<!-- crq-local-findings head=${head} set=${fingerprint} -->`;
    const jq = `.[] | select(.user.login == ${pythonJsonText(login, { asciiOnly: true, sortKeys: false, indent: null })} and ((.body // "") | contains(${pythonJsonText(wanted, { asciiOnly: true, sortKeys: false, indent: null })}))) | {id: .id, url: .html_url}`;
    const argv = [
      'gh',
      'api',
      '--paginate',
      `repos/${repo}/pulls/${pr}/reviews?per_page=100`,
      '--jq',
      jq,
    ];
    const out = okGh(argv, callGh(gh, argv, null));
    // Python iterates `(out.stdout or "").splitlines()`, so empty stdout means
    // zero rows; `split('\n')` would fabricate one empty row.
    const scanStdout = ghString(out.stdout);
    const rows = scanStdout === '' ? [] : scanStdout.replace(/\n$/, '').split('\n');
    for (const line of rows) {
      const row = parseJsonValue(line === '' ? 'null' : line, { duplicates: 'last' });
      if (!(row instanceof JsonObject)) {
        throw new PrReviewAttributeError(
          `'${ledgerPythonTypeName(row)}' object has no attribute 'get'`,
        );
      }
      const id = row.get('id');
      if (isPythonInt(id)) {
        return {
          review_id: jsonInt(Number(id.integer)),
          review_url: row.has('url') ? (row.get('url') as JsonValue) : null,
          inline: 0,
          body_only: 0,
          state: 'existing',
        } as DeliverResult;
      }
    }
  }
  const found = existingReview(gh, repo, pr, runId, login);
  if (found) {
    return {
      review_id: jsonInt(found.id),
      review_url: found.url,
      inline: 0,
      body_only: 0,
      state: 'existing',
    } as DeliverResult;
  }
  const hunks = diffHunks(gh, repo, meta.get('base') as string, head);
  let review = buildReview(meta, findings, hunks);
  if (fingerprint) {
    const body = `${pythonStr(review.has('body') ? (review.get('body') as JsonValue) : null)}
${wanted}`;
    review = withObject(review, 'body', body);
    if (
      pythonTruthy(meta.has('local_review') ? (meta.get('local_review') as JsonValue) : null) &&
      !ledgerValueEqualText(prState(gh, repo, pr).head, head)
    ) {
      return result({ state: 'skipped-head' });
    }
  }
  let { argv, callResult: posted } = postReview(gh, repo, pr, review);
  const stderr = ghString(posted.stderr);
  const returncode = rawReturncode(posted);
  if (
    returncode !== 0 &&
    stderr.includes('HTTP 422') &&
    ((review.get('comments') as JsonValue[]).length > 0 || review.has('commit_id'))
  ) {
    const fallback = buildReview(meta, findings, null);
    review = fallback;
    if (fingerprint) {
      if (
        pythonTruthy(meta.has('local_review') ? (meta.get('local_review') as JsonValue) : null) &&
        !ledgerValueEqualText(prState(gh, repo, pr).head, head)
      ) {
        return result({ state: 'skipped-head' });
      }
      const fallbackBody = `${pythonStr(fallback.has('body') ? (fallback.get('body') as JsonValue) : null)}
${wanted}`;
      review = withObject(fallback, 'body', fallbackBody);
    }
    const retry = postReview(gh, repo, pr, review);
    argv = retry.argv;
    posted = retry.callResult;
  }
  const final = okGh(argv, posted);
  let parsed: JsonValue = new JsonObject([]);
  try {
    parsed = parseJsonValue(ghString(final.stdout) === '' ? '{}' : ghString(final.stdout), {
      duplicates: 'last',
    });
  } catch {
    parsed = new JsonObject([]);
  }
  const reviewId =
    parsed instanceof JsonObject && parsed.has('id') ? (parsed.get('id') as JsonValue) : null;
  const reviewUrl =
    parsed instanceof JsonObject && parsed.has('html_url')
      ? (parsed.get('html_url') as JsonValue)
      : null;
  const inline = (review.get('comments') as JsonValue[]).length;
  // Python builds the created result as a fresh dict: state comes FIRST here
  // (unlike the spread branches, where it lands last).
  return {
    state: 'created',
    review_id: reviewId,
    review_url: reviewUrl,
    inline,
    body_only: findings.length - inline,
  } as DeliverResult;
}

/** Python `==` on the two text values (both str or both null). */
function ledgerValueEqualText(left: JsonValue | undefined, right: string): boolean {
  return left === right;
}

/** A replay finding arrives as a plain JSON object from the vector. */
/**
 * Python `json.dumps(value)`: DEFAULT separators (', ', ': '), insertion
 * order, ensure_ascii=True, recursively over objects and arrays.
 */
function pythonDumpsDefault(value: JsonValue): string {
  const encode = (item: JsonValue): string => {
    if (item === null) return 'null';
    if (item === true) return 'true';
    if (item === false) return 'false';
    if (item instanceof JsonNumber) {
      return pythonJsonText(item, { asciiOnly: true, sortKeys: false, indent: null });
    }
    if (typeof item === 'string') {
      return pythonJsonText(item, { asciiOnly: true, sortKeys: false, indent: null });
    }
    if (Array.isArray(item)) {
      return `[${item.map(encode).join(', ')}]`;
    }
    if (item instanceof JsonObject) {
      return `{${item.entries.map(([key, entry]) => `${pythonJsonText(key, { asciiOnly: true, sortKeys: false, indent: null })}: ${encode(entry)}`).join(', ')}}`;
    }
    return pythonJsonText(item, { asciiOnly: true, sortKeys: false, indent: null });
  };
  return encode(value);
}

/**
 * Python `json.dumps(value, sort_keys=True, ensure_ascii=True)` with the
 * DEFAULT separators for a flat dict of JSON scalars.
 */
function pythonDumpsDefaultSortKeys(value: JsonObject): string {
  const sorted = new JsonObject(
    [...value.entries].sort(([left], [right]) => compareStrings(left, right)),
  );
  return pythonDumpsDefault(sorted);
}

function findingToJson(finding: Finding): JsonValue {
  return new JsonObject([
    ['severity', finding.severity],
    ['path', finding.path],
    ['start', finding.start],
    ['end', finding.end],
    ['title', finding.title],
    ['text', finding.text],
  ]);
}

// -------------------------------------------------------------- loadFindings

/**
 * Finding events from one ndjson stream, exact duplicates dropped. The raw
 * text arrives already read with Python's `errors='replace'` semantics; the
 * pure module parses each line the way `json.loads` does.
 */
export function loadFindings(text: string): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    let event: JsonValue;
    try {
      event = parseJsonValue(line, {
        duplicates: 'last',
        // Python json.loads accepts NaN/Infinity by default.
        parseConstant: (token) =>
          token === 'NaN'
            ? JsonNumber.float(Number.NaN, 'NaN')
            : JsonNumber.float(token === 'Infinity' ? Infinity : -Infinity, token),
      });
    } catch {
      continue;
    }
    if (!(event instanceof JsonObject) || event.get('type') !== 'finding') continue;
    const fileName = event.has('fileName') ? event.get('fileName') : undefined;
    const finding: Record<string, JsonValue> = {
      severity: pythonStr(
        event.has('severity') && pythonTruthy(event.get('severity'))
          ? (event.get('severity') as JsonValue)
          : 'none',
      ),
      path: typeof fileName === 'string' ? fileName : null,
      start: lineValue(event.get('startLine')),
      end: lineValue(event.get('endLine')),
      // Python `str(event.get("title") or "")`: falsy values fall through.
      title: pythonStrip(
        pythonStr(
          event.has('title') && pythonTruthy(event.get('title'))
            ? (event.get('title') as JsonValue)
            : '',
        ),
      ),
      text: pythonStrip(
        pythonStr(
          event.has('comment') && pythonTruthy(event.get('comment'))
            ? (event.get('comment') as JsonValue)
            : event.has('title') && pythonTruthy(event.get('title'))
              ? (event.get('title') as JsonValue)
              : '',
        ),
      ),
    };
    const startValue: JsonValue = finding.start ?? null;
    const endValue: JsonValue = finding.end ?? null;
    // Python `_line` yields arbitrary-size positive ints; truthiness is
    // presence, not a 2^53-capped read.
    const start = lineValue(
      event.has('startLine') ? (event.get('startLine') as JsonValue) : undefined,
    );
    const end = lineValue(event.has('endLine') ? (event.get('endLine') as JsonValue) : undefined);
    const startPresent = start !== null;
    const endPresent = end !== null;
    if (startPresent && !endPresent) {
      finding.end = startValue;
    }
    if (endPresent && !startPresent) {
      finding.start = endValue;
    }
    if (startPresent && endPresent) {
      const startInt = (start as JsonNumber).integer as bigint;
      const endInt = (end as JsonNumber).integer as bigint;
      if (startInt > endInt) {
        finding.start = endValue;
        finding.end = startValue;
      }
    }
    const key = pythonJsonText(
      new JsonObject([
        ['path', finding.path ?? null],
        ['start', finding.start ?? null],
        ['end', finding.end ?? null],
        ['title', finding.title ?? null],
        ['text', finding.text ?? null],
      ]),
      { asciiOnly: true, sortKeys: true, indent: null },
    );
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding as unknown as Finding);
  }
  return out;
}

/** `type(value) is int and value > 0`: bools and floats stay None. */
function lineValue(value: JsonValue | undefined): JsonValue {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value > 0 ? jsonInt(value) : null;
  }
  if (value instanceof JsonNumber && value.kind === 'int') {
    return (value.integer as bigint) > 0n ? value : null;
  }
  return null;
}
