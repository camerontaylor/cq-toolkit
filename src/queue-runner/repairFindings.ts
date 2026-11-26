/**
 * `crq_repair.findings(path, *, provenance=False)` (crq_repair/__init__.py:142):
 * the actionable (critical/major) findings of one run's `review.ndjson`, and
 * with `provenance` the source record `repair_tick.enqueue` pins on each repair
 * job. Pure over the file's bytes; the file read is the caller's.
 *
 * Python reads with `read_text(errors="replace")` (UTF-8, a BOM is kept, bad
 * bytes become U+FFFD) and `splitlines()`, skips lines that are not JSON, and
 * lets `AttributeError` escape for a line that is JSON but not an object
 * (`e.get`). A non-string body is a `TypeError` in `re.search`.
 */
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJsonRetainingNumbers,
} from '../policy/crq/jsonValue.js';
import type { JsonValue } from '../policy/crq/jsonValue.js';
import { pythonJsonText } from '../policy/crq/pythonJson.js';
import {
  decimalDigitValue,
  loadFindings,
  normalisedFinding,
} from '../policy/crq/prReviewFindings.js';
import { pythonTruthy } from '../policy/crq/repairBinding.js';
import { pySplitLines } from './fixPrBacklog.js';
import { PyError } from './pyErrors.js';
import type { SourcedFinding } from './repairBackfill.js';

const SOURCE_KEYS = ['id', 'source_id', 'review_id', 'thread_id', 'source_thread_id'] as const;

/** `str.__len__` limit of `int(str)` in CPython 3.12+. */
const MAX_INT_DIGITS = 4300;

/**
 * `(?:around lines?|at line)\s+(\d+)` under `re.I` (which also folds U+0130 and U+0131 to `i`, as JS `iu` does not). `\s` and `\d` are the
 * Unicode classes of `str` patterns: `\s` includes `\x1c-\x1f` and `\x85` but
 * not U+FEFF, `\d` is category Nd.
 */
const LINE_REF =
  // eslint-disable-next-line no-control-regex -- Python's `\s` includes \x1c-\x1f
  /(?:around l[iİı]nes?|at l[iİı]ne)[\t-\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+(\p{Nd}+)/iu;

/** `int(match[1])` for a run of Unicode decimal digits. */
function digitsToInt(digits: string): number | bigint {
  let value = 0n;
  let count = 0;
  for (const ch of digits) {
    value = value * 10n + BigInt(decimalDigitValue(ch.codePointAt(0) as number));
    count += 1;
  }
  if (count > MAX_INT_DIGITS) {
    throw new PyError(
      'ValueError',
      `Exceeds the limit (${MAX_INT_DIGITS} digits) for integer string conversion: value has ${count} digits; use sys.set_int_max_str_digits() to increase the limit`,
    );
  }
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function parseLine(line: string): JsonValue | undefined {
  try {
    return parseJsonValue(line, {
      duplicates: 'last',
      // Python json.loads accepts NaN/Infinity by default.
      parseConstant: (token) =>
        token === 'NaN'
          ? JsonNumber.float(Number.NaN, 'NaN')
          : JsonNumber.float(token === 'Infinity' ? Infinity : -Infinity, token),
    });
  } catch {
    return undefined;
  }
}

/** Python `Path.read_text(errors="replace")` over raw bytes: BOM kept, bad bytes U+FFFD. */
export function decodeReplace(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);
}

const plain = (value: JsonValue | undefined): unknown =>
  value === undefined ? undefined : toPlainJsonRetainingNumbers(value);

/**
 * `findings(path, provenance=...)` over the file's bytes. Without `provenance`
 * every `source` is `{}`; Python returns no `_source` then.
 */
export function parseRepairFindings(bytes: Uint8Array, provenance: boolean): SourcedFinding[] {
  const lines = pySplitLines(decodeReplace(bytes));
  // `pr_review_findings.load_findings` runs first and splits on `\n` only; the
  // lines are already Python line boundaries, so re-joining them is lossless.
  const published = provenance ? loadFindings(lines.join('\n')) : [];
  const result: SourcedFinding[] = [];
  for (const line of lines) {
    const e = parseLine(line);
    if (e === undefined) continue;
    // `e.get('type')`: a JSON line that is not an object has no `.get`.
    if (!(e instanceof JsonObject)) {
      throw new PyError(
        'AttributeError',
        `'${e === null ? 'NoneType' : Array.isArray(e) ? 'list' : e instanceof JsonNumber ? e.kind : typeof e === 'boolean' ? 'bool' : 'str'}' object has no attribute 'get'`,
      );
    }
    const severity = e.get('severity');
    if (
      e.get('type') !== 'finding' ||
      typeof severity !== 'string' ||
      (severity !== 'critical' && severity !== 'major')
    ) {
      continue;
    }
    const lead = e.get('codegenInstructions');
    const comment = e.get('comment');
    const body0: JsonValue = pythonTruthy(lead) ? (lead as JsonValue) : (comment ?? null);
    let body: JsonValue = pythonTruthy(body0) ? (body0 as JsonValue) : '';
    const suggestion = e.get('suggestions');
    if (pythonTruthy(suggestion)) {
      // `body += '\n' + ...`: only a str body concatenates; a list would `extend`
      // and still fail in `re.search`, every other type fails right here.
      if (Array.isArray(body)) throw nonStringBody(body);
      if (typeof body !== 'string') {
        throw new PyError(
          'TypeError',
          `unsupported operand type(s) for +=: '${bodyTypeName(body)}' and 'str'`,
        );
      }
      body +=
        '\n' +
        (typeof suggestion === 'string'
          ? suggestion
          : pythonJsonText(suggestion as JsonValue, {
              asciiOnly: true,
              sortKeys: false,
              indent: null,
              spacedSeparators: true,
            }));
    }
    if (typeof body !== 'string') throw nonStringBody(body);
    const match = LINE_REF.exec(body);
    const finding: Record<string, unknown> = {
      severity,
      path: plain(e.get('fileName')) ?? null,
      line: match ? digitsToInt(match[1] as string) : null,
      body,
    };
    const source: Record<string, unknown> = {};
    if (provenance) {
      for (const key of SOURCE_KEYS) {
        const value = e.get(key);
        if (value !== undefined && value !== null) source[key] = plain(value);
      }
      // The publisher's deduplicated ordinal, including lower severities.
      const row = normalisedFinding(e);
      const fileName = e.get('fileName');
      const matches: number[] = [];
      published.forEach((f, n) => {
        const samePath =
          fileName === undefined || fileName === null || typeof fileName === 'string'
            ? f.path === (fileName ?? null)
            : false;
        if (
          samePath &&
          sameJson(f.start, row.start) &&
          sameJson(f.end, row.end) &&
          f.title === row.title &&
          f.text === row.text
        ) {
          matches.push(n + 1);
        }
      });
      if (matches.length === 1) source.finding_number = matches[0];
    }
    result.push({ finding, source });
  }
  return result;
}

/** Equality of two normalised line values (null or a positive int). */
function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  const num = (v: JsonValue | undefined): bigint | null =>
    v instanceof JsonNumber && v.kind === 'int'
      ? (v.integer as bigint)
      : typeof v === 'number'
        ? BigInt(v)
        : null;
  return num(a) === num(b);
}

function bodyTypeName(body: JsonValue): string {
  if (body instanceof JsonNumber) return body.kind;
  if (Array.isArray(body)) return 'list';
  return typeof body === 'boolean' ? 'bool' : 'dict';
}

function nonStringBody(body: JsonValue): PyError {
  return new PyError(
    'TypeError',
    `expected string or bytes-like object, got '${bodyTypeName(body)}'`,
  );
}
