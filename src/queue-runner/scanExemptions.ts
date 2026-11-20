/**
 * Repo-owned scan exemptions (`crq.load_scan_exemptions`, `_glob_regex`,
 * `_exempt`): known-fake secret fixtures a repository lists in
 * `.crq/scan-exemptions.toml` on the BASE commit. Only the two generic shapes
 * are exemptible; every other denylist class and every provider-specific
 * gitleaks rule stays blocking.
 *
 * The file is read by a deliberately small TOML subset parser: `[[exempt]]`
 * tables whose values are basic or literal strings. Anything outside the
 * subset fails the whole file closed (no exemptions), which can only block
 * more than Python's full `tomllib`, never less.
 */
import { pythonUnicode16Space } from '../policy/crq/pythonUnicode16.js';

export const SCAN_EXEMPTIONS_PATH = '.crq/scan-exemptions.toml';
export const EXEMPTIBLE_RULES: ReadonlySet<string> = new Set([
  'class:inline-secret-assignments',
  'generic-api-key',
]);
/** Bounds regex backtracking; more fails the file closed. */
const MAX_GLOBSTARS = 2;

export interface ScanExemption {
  readonly path: string;
  readonly rule: string;
  readonly reason: string;
  readonly rx: GlobMatcher;
}

export interface LoadedExemptions {
  readonly entries: readonly ScanExemption[];
  readonly error: string | null;
}

/** One glob token; the same language `_glob_regex` builds as a regex. */
type GlobToken =
  | { readonly kind: 'lit'; readonly char: string }
  | { readonly kind: 'one' } // ?    -> [^/]
  | { readonly kind: 'star' } // *    -> [^/]*
  | { readonly kind: 'any' } // **   -> [^\n]*
  | { readonly kind: 'dirs' }; // **/  -> (?:[^\n]*/)?

export interface GlobMatcher {
  test(path: string): boolean;
}

/**
 * `_glob_regex`, as an NFA simulation instead of a backtracking regex: the
 * cost is bounded by pattern length times path length for every accepted
 * pattern, however many `*` it holds. The language is the regex
 * `^<tokens>\n?$` that Python builds, where `.` excludes only `\n` and `$`
 * also matches before one trailing `\n`.
 */
export function globMatcher(pattern: string): GlobMatcher {
  let count = 0;
  for (let at = pattern.indexOf('**'); at !== -1; at = pattern.indexOf('**', at + 2)) count += 1;
  if (count > MAX_GLOBSTARS)
    throw new Error(`path has more than ${String(MAX_GLOBSTARS)} '**': ${pattern}`);
  const chars = Array.from(pattern);
  const tokens: GlobToken[] = [];
  let i = 0;
  const startsWith = (token: string): boolean =>
    chars.slice(i, i + token.length).join('') === token;
  while (i < chars.length) {
    if (startsWith('**/')) {
      // Consecutive "**/" segments match the same paths as one.
      while (startsWith('**/')) i += 3;
      tokens.push({ kind: 'dirs' });
    } else if (startsWith('**')) {
      tokens.push({ kind: 'any' });
      i += 2;
    } else if (chars[i] === '*') {
      tokens.push({ kind: 'star' });
      i += 1;
    } else if (chars[i] === '?') {
      tokens.push({ kind: 'one' });
      i += 1;
    } else {
      tokens.push({ kind: 'lit', char: chars[i] as string });
      i += 1;
    }
  }
  const end = tokens.length;
  // pos[i]: about to read token i (end = all consumed, end + 1 = after the
  // optional trailing newline); loop[i]: inside the `[^\n]*` of a dirs token.
  const closure = (pos: Uint8Array, loop: Uint8Array): void => {
    for (let at = 0; at < end; at += 1) {
      if (pos[at] === 0) continue;
      const kind = (tokens[at] as GlobToken).kind;
      if (kind === 'star' || kind === 'any' || kind === 'dirs') pos[at + 1] = 1;
      if (kind === 'dirs') loop[at] = 1;
    }
  };
  return {
    test(path: string): boolean {
      let pos = new Uint8Array(end + 2);
      let loop = new Uint8Array(end + 1);
      pos[0] = 1;
      closure(pos, loop);
      for (const ch of path) {
        const nextPos = new Uint8Array(end + 2);
        const nextLoop = new Uint8Array(end + 1);
        for (let at = 0; at < end; at += 1) {
          const token = tokens[at] as GlobToken;
          if (pos[at] === 1) {
            if (token.kind === 'lit' && ch === token.char) nextPos[at + 1] = 1;
            else if (token.kind === 'one' && ch !== '/') nextPos[at + 1] = 1;
            else if (token.kind === 'star' && ch !== '/') nextPos[at] = 1;
            else if (token.kind === 'any' && ch !== '\n') nextPos[at] = 1;
          }
          if (loop[at] === 1 && ch !== '\n') {
            nextLoop[at] = 1;
            if (ch === '/') nextPos[at + 1] = 1;
          }
        }
        if (pos[end] === 1 && ch === '\n') nextPos[end + 1] = 1;
        closure(nextPos, nextLoop);
        pos = nextPos;
        loop = nextLoop;
      }
      return pos[end] === 1 || pos[end + 1] === 1;
    },
  };
}

function pyStripEmpty(value: string): boolean {
  for (let at = 0; at < value.length; at += 1)
    if (!pythonUnicode16Space(value.charCodeAt(at))) return false;
  return true;
}

const BASIC_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

/** TOML forbids every control character except tab in strings and comments; none is valid elsewhere. */
function hasForbiddenControl(value: string): boolean {
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    if (code <= 0x08 || (code >= 0x0a && code <= 0x1f) || code === 0x7f) return true;
  }
  return false;
}

/** One string value and the text after it, or a thrown syntax error. */
function parseString(text: string): { value: string; rest: string } {
  const quote = text[0];
  if (quote === "'") {
    if (text.startsWith("'''")) throw new Error('multi-line strings are not supported');
    const end = text.indexOf("'", 1);
    if (end === -1) throw new Error('unterminated string');
    const value = text.slice(1, end);
    if (hasForbiddenControl(value)) throw new Error('control character in string');
    return { value, rest: text.slice(end + 1) };
  }
  if (quote === '"') {
    if (text.startsWith('"""')) throw new Error('multi-line strings are not supported');
    let value = '';
    let at = 1;
    while (at < text.length) {
      const ch = text[at] as string;
      if (ch === '"') return { value, rest: text.slice(at + 1) };
      if (ch !== '\\') {
        if (hasForbiddenControl(ch)) throw new Error('control character in string');
        value += ch;
        at += 1;
        continue;
      }
      const next = text[at + 1];
      if (next !== undefined && BASIC_ESCAPES[next] !== undefined) {
        value += BASIC_ESCAPES[next];
        at += 2;
        continue;
      }
      const width = next === 'u' ? 4 : next === 'U' ? 8 : 0;
      const hex = width === 0 ? '' : text.slice(at + 2, at + 2 + width);
      if (width === 0 || !new RegExp(`^[0-9a-fA-F]{${String(width)}}$`).test(hex))
        throw new Error('invalid string escape');
      const code = parseInt(hex, 16);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        throw new Error('invalid string escape');
      value += String.fromCodePoint(code);
      at += 2 + width;
    }
    throw new Error('unterminated string');
  }
  throw new Error('value is not a string');
}

/**
 * TOML whitespace is space and tab only. JS `trim()` and `\s` also accept
 * U+00A0, U+FEFF and line separators that `tomllib` rejects, which would let a
 * malformed policy file suppress findings.
 */
function tomlTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === ' ' || value[start] === '\t')) start += 1;
  while (end > start && (value[end - 1] === ' ' || value[end - 1] === '\t')) end -= 1;
  return value.slice(start, end);
}

/** Entries are validated like Python: the first bad entry fails the file. */
export function parseScanExemptions(text: string): ScanExemption[] {
  const entries: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  let ignoring = false;
  // Unrelated tables are skipped, but a malformed one still voids the file (as
  // `tomllib` would): track header kinds and keys so duplicates fail closed.
  const headerKinds = new Map<string, 'table' | 'array'>();
  let ignoredKeys: Set<string> | null = null;
  for (const raw of text.split(/\r\n|\n/)) {
    // TOML 1.0: a raw control character other than tab is invalid anywhere in a
    // document (strings, comments, whitespace); a lone CR is one too, since
    // only LF and CRLF end a line.
    if (hasForbiddenControl(raw)) throw new Error('control character in document');
    const line = tomlTrim(raw);
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const header = /^\[(\[)?[ \t]*([A-Za-z0-9_-]+)[ \t]*(\])?\](?:[ \t]*#.*)?$/s.exec(line);
      if (header === null || (header[1] === '[') !== (header[3] === ']'))
        throw new Error('invalid table header');
      const name = header[2] as string;
      const kind = header[1] === '[' ? 'array' : 'table';
      const seen = headerKinds.get(name);
      if (seen !== undefined && (seen !== kind || kind === 'table'))
        throw new Error('duplicate table');
      headerKinds.set(name, kind);
      ignoredKeys = null;
      if (header[1] === '[' && header[2] === 'exempt') {
        current = {};
        ignoring = false;
        entries.push(current);
      } else {
        // Python reads only doc["exempt"]; an unrelated table is ignored.
        if (header[2] === 'exempt') throw new Error('exempt is not an array of tables');
        current = null;
        ignoring = true;
        ignoredKeys = new Set();
      }
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)[ \t]*=[ \t]*(.*)$/s.exec(line);
    if (pair === null) throw new Error('invalid line');
    const { value, rest } = parseString(tomlTrim(pair[2] as string));
    const tail = tomlTrim(rest);
    if (tail !== '' && !tail.startsWith('#')) throw new Error('invalid value');
    if (ignoring) {
      if (ignoredKeys?.has(pair[1] as string) === true) throw new Error('duplicate key');
      ignoredKeys?.add(pair[1] as string);
      continue;
    }
    if (current === null) throw new Error('key outside a table is not supported');
    if (Object.hasOwn(current, pair[1] as string)) throw new Error('duplicate key');
    current[pair[1] as string] = value;
  }
  const out: ScanExemption[] = [];
  for (const entry of entries) {
    const { path, rule, reason } = entry;
    if (
      [path, rule, reason].some(
        (value) => typeof value !== 'string' || value === '' || pyStripEmpty(value),
      )
    )
      throw new Error('entry needs non-empty string path, rule, reason');
    if (!EXEMPTIBLE_RULES.has(rule as string)) throw new Error(`rule is not exemptible: ${rule}`);
    out.push({
      path: path as string,
      rule: rule as string,
      reason: reason as string,
      rx: globMatcher(path as string),
    });
  }
  return out;
}

/** `load_scan_exemptions` over the already-read base blob; any failure fails closed. */
export function loadScanExemptions(text: string | null): LoadedExemptions {
  if (text === null) return { entries: [], error: null };
  try {
    return { entries: parseScanExemptions(text), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { entries: [], error: `${SCAN_EXEMPTIONS_PATH}: ${message}` };
  }
}

/** `_exempt`: the reason when `rule` on `path` is exempted, else null. */
export function exemptReason(
  exemptions: readonly ScanExemption[] | undefined,
  rule: string | null,
  path: string | undefined,
): string | null {
  if (rule === null || !EXEMPTIBLE_RULES.has(rule) || !path) return null;
  for (const entry of exemptions ?? [])
    if (entry.rule === rule && entry.rx.test(path)) return entry.reason;
  return null;
}
