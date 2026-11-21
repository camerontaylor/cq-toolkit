/**
 * Offline port of `crq_repair.triage.context` and `source_excerpt`: the packed
 * evidence the inbox judge reads for one triage row.
 *
 * The assembler is pure over {@link TriageContextReads}, a recorded view of the
 * repository: carried lines, tree entries, blob bytes, `git grep` output and
 * `git log` output. It opens nothing, runs no Git, calls no judge and reads no
 * live data, so the order and arguments of every read are the differential
 * surface the Python oracle (`triage_context_vectors.py`) pins.
 *
 * Failure typing follows `triage.phase`, which records only these Python
 * classes from a failed `context()` and lets everything else propagate:
 * `KeyError`, `TypeError`, `ValueError`, `IntegrityError`, `CalledProcessError`,
 * `TimeoutExpired` and `OSError`. They are {@link TriageContextFailure}s here.
 * A condition Python would surface as an uncaught `AttributeError`, or one the
 * port is deliberately stricter about than Python, is a
 * {@link TriageContextRefusal} and is never converted into a recorded error.
 */
import {
  JsonObject,
  JsonNumber,
  type JsonValue,
  toPlainJsonRetainingNumbers,
} from './jsonValue.js';
import { decodeReplaced } from './backfillAccounting.js';
import { decimalDigitValue, scanDigits } from './prReviewFindings.js';
import { pythonIsSpace, pythonLength, pythonStrip, pythonTruthy } from './repairBinding.js';
import { pythonSplitlines } from './repairGates.js';
import type { TriageContextOutcome, TriageContextRequest } from './triagePlan.js';

/** Python's `CONTRACT_PATH`. */
export const TRIAGE_CONTRACT_PATH = 'docs/current-contract-and-backlog.md';
/** Python's `CONTRACT_MAX_CHARS`. */
export const TRIAGE_CONTRACT_MAX_CHARS = 24000;

const SEARCH_LIMIT = 16000;
const NEEDLE_LIMIT = 200;
const NEEDLE_MINIMUM = 12;
const HISTORY_LIMIT = 16000;
const EXCERPT_LIMIT = 8000;
const EXCERPT_REGION_LIMIT = 2000;
const EXCERPT_REGION_LINES = 41;
const EXCERPT_REGIONS = 4;
const EXTRA_SOURCES = 3;
const REGION_BEFORE = 41;
const REGION_AFTER = 40;
const MAX_INTERVAL_LINE = 1_000_000n;
/** CPython's `int()` refuses a digit string longer than this (3.11+). */
const INT_MAX_STR_DIGITS = 4300;

/** The Python exception classes `triage.phase` records from a failed `context()`. */
export type TriageContextFailureType =
  | 'KeyError'
  | 'TypeError'
  | 'ValueError'
  | 'IntegrityError'
  | 'CalledProcessError'
  | 'TimeoutExpired'
  | 'OSError';

/** A failure `triage.phase` catches and records by Python class name. */
export class TriageContextFailure extends Error {
  override readonly name = 'TriageContextFailure';
  readonly pythonType: TriageContextFailureType;

  constructor(pythonType: TriageContextFailureType, message?: string) {
    super(message ?? pythonType);
    this.pythonType = pythonType;
  }
}

/**
 * A condition `phase` does not catch (Python raises `AttributeError` and the
 * run aborts) or one the port refuses where Python is lenient. Never recorded
 * as a per-row context error.
 */
export class TriageContextRefusal extends Error {
  override readonly name = 'TriageContextRefusal';
}

/** One inclusive 1-based line range of a validated interval list. */
export type TriageLineRange = readonly [number, number];

export interface TriageCarryResult {
  /** The carried path, or null/empty when the lines were lost. */
  readonly path: string | null;
  readonly lines: ReadonlySet<number>;
}

/**
 * The repository reads `context()` makes. Each may throw a
 * {@link TriageContextFailure} for the failures Python's Git layer raises.
 */
export interface TriageContextReads {
  /** `repo.carry(target, tip, path, intervals)`. */
  carry(
    target: string,
    tip: string,
    path: string,
    lines: readonly TriageLineRange[],
  ): TriageCarryResult;
  /** `repo.entries(commit)`, reduced to path -> blob id. */
  entries(commit: string): ReadonlyMap<string, string>;
  /** `repo.git('cat-file', 'blob', oid)`. */
  blob(oid: string): Uint8Array;
  /** `repo.git('grep', '-n', '-F', '-e', needle, tip, '--', path, check=False)`. */
  grep(needle: string, tip: string, path: string): Uint8Array;
  /** `repo.git('log', '-n', '40', '--format=%H %s', range, '--', path)`. */
  history(range: string, path: string): Uint8Array;
}

export interface TriageContextContract {
  readonly path: string;
  readonly tip: string;
  readonly blob: string | null;
  readonly status: 'present' | 'absent';
  readonly text: string;
  readonly totalChars: number;
  readonly limitChars: number;
  readonly truncated: boolean;
}

export interface TriageExcerptRegion {
  readonly startLine: number;
  readonly text: string;
}

/** Python `source_excerpt`'s return value. */
export interface TriageSourceExcerpt {
  readonly text: string;
  readonly truncated: boolean;
  /** Present only when the excerpt is made of cited regions. */
  readonly regions?: readonly TriageExcerptRegion[];
}

export interface TriageAdditionalSource extends TriageSourceExcerpt {
  readonly path: string;
  readonly blob: string;
}

export interface TriageContext {
  readonly currentContract: TriageContextContract;
  readonly originalRegion: string;
  readonly contentSearch: string;
  readonly finding: JsonObject;
  readonly target: string;
  readonly tip: string;
  readonly currentPath: string;
  readonly additionalSources: readonly TriageAdditionalSource[];
  readonly region: readonly { readonly line: number; readonly text: string }[];
  readonly history: string;
}

// ---------------------------------------------------------------------------
// Python string helpers
// ---------------------------------------------------------------------------

/** `text[:limit]` by code point. */
function head(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let index = 0;
  let count = 0;
  while (index < text.length && count < limit) {
    index += (text.codePointAt(index) as number) > 0xffff ? 2 : 1;
    count += 1;
  }
  return text.slice(0, index);
}

/** The boundaries `str.splitlines` honours. */
function isLineBoundary(code: number): boolean {
  return (
    code === 0x0a ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x1c ||
    code === 0x1d ||
    code === 0x1e ||
    code === 0x85 ||
    code === 0x2028 ||
    code === 0x2029
  );
}

/** `str.splitlines(keepends=True)`. */
function splitlinesKeepends(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (!isLineBoundary(code)) continue;
    if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) index += 1;
    lines.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/**
 * `int(digits)` for a run of Unicode decimal digits, with CPython's digit limit.
 *
 * CPython refuses an over-long digit string before converting it, so the
 * count comes first and stops at the first digit past the limit: a hostile
 * run costs a bounded scan, never a quadratic `BigInt` accumulation.
 */
function pythonInt(digits: string): bigint {
  let count = 0;
  for (let index = 0; index < digits.length; index += 1) {
    const unit = digits.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) index += 1; // a surrogate pair is one digit
    count += 1;
    if (count > INT_MAX_STR_DIGITS) {
      throw new TriageContextFailure(
        'ValueError',
        'Exceeds the limit (4300 digits) for integer string conversion',
      );
    }
  }
  let value = 0n;
  for (const character of digits) {
    value = value * 10n + BigInt(decimalDigitValue(character.codePointAt(0) as number));
  }
  return value;
}

/** `re.findall(re.escape(path) + r':(\d+)', body)`. */
function pathCitations(body: string, path: string): string[] {
  const needle = `${path}:`;
  const found: string[] = [];
  let from = 0;
  while (from <= body.length) {
    const at = body.indexOf(needle, from);
    if (at < 0) break;
    const digits = at + needle.length;
    const end = scanDigits(body, digits);
    if (end > digits) {
      found.push(body.slice(digits, end));
      from = end;
    } else {
      from = at + 1;
    }
  }
  return found;
}

function matchesFolded(character: string, alternatives: readonly string[]): boolean {
  return alternatives.includes(character);
}

/** `re.findall(r'(?i)lines?\s+(\d+)', body)` under Python's Unicode `re.I`. */
function lineCitations(body: string): string[] {
  const found: string[] = [];
  let index = 0;
  while (index < body.length) {
    const end = matchLineWord(body, index);
    if (end < 0) {
      index += 1;
      continue;
    }
    const digits = scanDigits(body, end);
    if (digits > end) {
      found.push(body.slice(end, digits));
      index = digits;
    } else {
      index += 1;
    }
  }
  return found;
}

/**
 * Match `lines?\s+` at `index` and return the offset of the digits, or -1.
 * `re.I` folds `i` with U+0130/U+0131 and `s` with U+017F.
 */
function matchLineWord(body: string, index: number): number {
  let at = index;
  if (!matchesFolded(body.charAt(at), ['l', 'L'])) return -1;
  at += 1;
  if (!matchesFolded(body.charAt(at), ['i', 'I', 'İ', 'ı'])) return -1;
  at += 1;
  if (!matchesFolded(body.charAt(at), ['n', 'N'])) return -1;
  at += 1;
  if (!matchesFolded(body.charAt(at), ['e', 'E'])) return -1;
  at += 1;
  if (matchesFolded(body.charAt(at), ['s', 'S', 'ſ'])) at += 1;
  const spaceStart = at;
  while (at < body.length && pythonIsSpace(body.charCodeAt(at))) at += 1;
  return at > spaceStart ? at : -1;
}

/** Python `source_excerpt`: spend the 8k allowance on cited lines before a prefix. */
export function triageSourceExcerpt(
  content: string,
  path: string,
  body: string,
  primary = false,
): TriageSourceExcerpt {
  const citations = pathCitations(body, path);
  if (primary) citations.push(...lineCitations(body));
  const lines = splitlinesKeepends(content);
  const starts: bigint[] = [];
  for (const citation of citations) {
    const start = pythonInt(citation) - 21n;
    const clamped = start < 0n ? 0n : start;
    if (!starts.includes(clamped)) starts.push(clamped);
  }
  const chosen = starts.slice(0, EXCERPT_REGIONS);
  const length = pythonLength(content);
  if (chosen.length === 0 || length <= EXCERPT_LIMIT) {
    return { text: head(content, EXCERPT_LIMIT), truncated: length > EXCERPT_LIMIT };
  }
  const regions: TriageExcerptRegion[] = [];
  let remaining = EXCERPT_LIMIT;
  for (const start of chosen) {
    if (start >= BigInt(lines.length)) continue;
    const first = Number(start);
    const text = head(
      lines.slice(first, first + EXCERPT_REGION_LINES).join(''),
      Math.min(EXCERPT_REGION_LIMIT, remaining),
    );
    regions.push({ startLine: first + 1, text });
    remaining -= pythonLength(text);
  }
  if (regions.length === 0) return { text: head(content, EXCERPT_LIMIT), truncated: true };
  return { text: '', regions, truncated: true };
}

// ---------------------------------------------------------------------------
// review_ledger.intervals, with Python's sequential error typing
// ---------------------------------------------------------------------------

/** What `for x in value` yields for a JSON value; a non-iterable is a `TypeError`. */
function iterate(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return Array.from(value);
  if (value instanceof JsonObject) return value.entries.map(([key]) => key);
  throw new TriageContextFailure('TypeError', 'object is not iterable');
}

/**
 * `ledger.intervals(rows)`: unpacking a pair is a `ValueError` or `TypeError`
 * before the bound checks, which are an `IntegrityError`. Errors surface at the
 * first offending row, exactly as Python's loop does.
 */
function triageIntervals(rows: JsonValue): TriageLineRange[] {
  const ranges: TriageLineRange[] = [];
  let last = 0n;
  let total = 0n;
  for (const pair of iterate(rows)) {
    const parts = iterate(pair);
    if (parts.length !== 2) {
      throw new TriageContextFailure('ValueError', 'cannot unpack interval');
    }
    const [start, end] = parts;
    if (
      !(start instanceof JsonNumber) ||
      start.kind !== 'int' ||
      !(end instanceof JsonNumber) ||
      end.kind !== 'int'
    ) {
      throw new TriageContextFailure('IntegrityError', 'invalid or overlapping intervals');
    }
    const first = start.integer as bigint;
    const final = end.integer as bigint;
    if (
      first <= last ||
      final < first ||
      final > MAX_INTERVAL_LINE ||
      total + final - first + 1n > MAX_INTERVAL_LINE
    ) {
      throw new TriageContextFailure('IntegrityError', 'invalid or overlapping intervals');
    }
    total += final - first + 1n;
    ranges.push([Number(first), Number(final)]);
    last = final;
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// context()
// ---------------------------------------------------------------------------

function requireKey(object: JsonObject, key: string): JsonValue {
  const value = object.get(key);
  if (value === undefined) throw new TriageContextFailure('KeyError', `'${key}'`);
  return value;
}

function requireString(value: JsonValue, what: string): string {
  if (typeof value !== 'string') {
    throw new TriageContextRefusal(`${what} must be a string`);
  }
  return value;
}

/** `str(value or '')` for the two finding text fields. */
function textOrEmpty(finding: JsonObject, key: string): string {
  const value = finding.get(key);
  if (!pythonTruthy(value)) return '';
  return requireString(value as JsonValue, `finding ${key}`);
}

function blobText(reads: TriageContextReads, oid: string): string {
  return decodeReplaced(reads.blob(oid));
}

/** Python `entries[path]['blob']`: a missing entry is a `KeyError`. */
function blobOf(entries: ReadonlyMap<string, string>, path: string): string {
  const oid = entries.get(path);
  if (oid === undefined) throw new TriageContextFailure('KeyError', `'${path}'`);
  return oid;
}

const PATH_PATTERN = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g;

/** Python `context(repo, row, tip)`, reads in Python's order. */
export function assembleTriageContext(
  reads: TriageContextReads,
  request: TriageContextRequest,
): TriageContext {
  const { row, tip } = request;
  const finding = requireKey(row, 'finding');
  if (!(finding instanceof JsonObject)) {
    throw new TriageContextRefusal('triage row finding must be an object');
  }
  const anchor =
    request.recoveredAnchor !== null && pythonTruthy(request.recoveredAnchor)
      ? request.recoveredAnchor
      : finding;
  const anchored = pythonTruthy(anchor.get('intervals'));

  let carriedName: string | null = null;
  let lines: ReadonlySet<number> = new Set();
  let intervals: readonly TriageLineRange[] = [];
  if (anchored) {
    const anchoredTarget = requireKey(row, 'target');
    const anchorPath = requireKey(anchor, 'path');
    intervals = triageIntervals(requireKey(anchor, 'intervals'));
    if (typeof anchoredTarget !== 'string') {
      throw new TriageContextFailure('TypeError', 'expected string or bytes-like object');
    }
    const carried = reads.carry(
      anchoredTarget,
      tip,
      requireString(anchorPath, 'anchor path'),
      intervals,
    );
    carriedName = carried.path;
    lines = carried.lines;
  }
  const name =
    carriedName !== null && carriedName !== ''
      ? carriedName
      : requireString(requireKey(finding, 'path'), 'finding path');

  const entries = reads.entries(tip);
  const text = entries.has(name) ? pythonSplitlines(blobText(reads, blobOf(entries, name))) : [];
  let minimum = 1;
  let maximum = 1;
  if (lines.size > 0) {
    minimum = Infinity;
    maximum = -Infinity;
    for (const line of lines) {
      if (line < minimum) minimum = line;
      if (line > maximum) maximum = line;
    }
  }
  const start = Math.max(0, minimum - REGION_BEFORE);
  const end = Math.min(text.length, maximum + REGION_AFTER);

  let original = '';
  let search = '';
  if (anchored) {
    const oldEntries = reads.entries(row.get('target') as string);
    const oldPath = requireString(requireKey(finding, 'path'), 'finding path');
    const old = pythonSplitlines(blobText(reads, blobOf(oldEntries, oldPath)));
    const selected: string[] = [];
    for (const [first, final] of intervals) {
      const from = Math.max(first, 1);
      const to = Math.min(final, old.length);
      for (let index = from; index <= to; index += 1) selected.push(old[index - 1] as string);
    }
    original = head(selected.join('\n'), SEARCH_LIMIT);
    let needle = '';
    for (const line of pythonSplitlines(original)) {
      const stripped = pythonStrip(line);
      if (pythonLength(stripped) >= NEEDLE_MINIMUM) {
        needle = stripped;
        break;
      }
    }
    if (needle !== '' && lines.size === 0) {
      search = head(
        decodeReplaced(reads.grep(head(needle, NEEDLE_LIMIT), tip, name)),
        SEARCH_LIMIT,
      );
    }
  }

  const contractBlob = entries.get(TRIAGE_CONTRACT_PATH);
  const contractText = contractBlob === undefined ? '' : blobText(reads, contractBlob);
  const contractLength = pythonLength(contractText);
  const contract: TriageContextContract = {
    path: TRIAGE_CONTRACT_PATH,
    tip,
    blob: contractBlob ?? null,
    status: contractBlob === undefined ? 'absent' : 'present',
    text: head(contractText, TRIAGE_CONTRACT_MAX_CHARS),
    totalChars: contractLength,
    limitChars: TRIAGE_CONTRACT_MAX_CHARS,
    truncated: contractLength > TRIAGE_CONTRACT_MAX_CHARS,
  };

  const extra: TriageAdditionalSource[] = [];
  if (request.escalate) {
    const body = `${textOrEmpty(finding, 'title')} ${textOrEmpty(finding, 'body')}`;
    const cited = body.match(PATH_PATTERN) ?? [];
    const paths = [name, ...cited].map((path) =>
      entries.has(path) ? path : path.replace(/\.+$/, ''),
    );
    for (const path of new Set(paths)) {
      if (!entries.has(path) || extra.length >= EXTRA_SOURCES) continue;
      const oid = blobOf(entries, path);
      const content = blobText(reads, oid);
      extra.push({ path, blob: oid, ...triageSourceExcerpt(content, path, body, path === name) });
    }
  }

  const region: { line: number; text: string }[] = [];
  for (let index = start; index < end; index += 1) {
    region.push({ line: index + 1, text: text[index] as string });
  }
  const target = requireKey(row, 'target');
  if (typeof target !== 'string') {
    throw new TriageContextFailure('TypeError', 'can only concatenate str');
  }
  const historyPath = requireString(requireKey(finding, 'path'), 'finding path');
  const history = head(
    decodeReplaced(reads.history(`${target}..${tip}`, historyPath)),
    HISTORY_LIMIT,
  );
  return {
    currentContract: contract,
    originalRegion: original,
    contentSearch: search,
    finding,
    target,
    tip,
    currentPath: name,
    additionalSources: extra,
    region,
    history,
  };
}

/**
 * The planner seam: prepare a candidate's context, recording a caught Python
 * failure as `{kind: 'error'}` and letting every other failure propagate.
 */
export function triageContextPreparer(
  reads: TriageContextReads,
  onContext?: (context: TriageContext, request: TriageContextRequest) => void,
): (request: TriageContextRequest) => TriageContextOutcome {
  return (request) => {
    try {
      const context = assembleTriageContext(reads, request);
      onContext?.(context, request);
      return { kind: 'ready' };
    } catch (error) {
      if (error instanceof TriageContextFailure) {
        return { kind: 'error', errorType: error.pythonType };
      }
      throw error;
    }
  };
}

/**
 * Python's packed context shape (snake_case keys), for comparison and the judge pack.
 *
 * `finding` keeps its numbers as {@link JsonNumber} leaves, not JavaScript
 * numbers: an integer past 2**53 and a float's `1.0` spelling would otherwise
 * change on the way out. Serialise the result with `pythonJsonText`, which
 * writes a `JsonNumber` exactly; `JSON.stringify` cannot.
 */
export function triageContextToPlain(context: TriageContext): Record<string, unknown> {
  const contract = context.currentContract;
  return {
    current_contract: {
      path: contract.path,
      tip: contract.tip,
      blob: contract.blob,
      status: contract.status,
      text: contract.text,
      total_chars: contract.totalChars,
      limit_chars: contract.limitChars,
      truncated: contract.truncated,
    },
    original_region: context.originalRegion,
    content_search: context.contentSearch,
    finding: toPlainJsonRetainingNumbers(context.finding),
    target: context.target,
    tip: context.tip,
    current_path: context.currentPath,
    additional_sources: context.additionalSources.map((source) => ({
      path: source.path,
      blob: source.blob,
      text: source.text,
      ...(source.regions === undefined
        ? {}
        : { regions: source.regions.map((r) => ({ start_line: r.startLine, text: r.text })) }),
      truncated: source.truncated,
    })),
    region: context.region.map((entry) => ({ line: entry.line, text: entry.text })),
    history: context.history,
  };
}
