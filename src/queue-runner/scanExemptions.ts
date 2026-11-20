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
  readonly rx: RegExp;
}

export interface LoadedExemptions {
  readonly entries: readonly ScanExemption[];
  readonly error: string | null;
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * `_glob_regex`. Python's `.` excludes only `\n` and its `$` also matches
 * before one trailing `\n`; both are reproduced.
 */
export function globRegex(pattern: string): RegExp {
  let count = 0;
  for (let at = pattern.indexOf('**'); at !== -1; at = pattern.indexOf('**', at + 2)) count += 1;
  if (count > MAX_GLOBSTARS)
    throw new Error(`path has more than ${String(MAX_GLOBSTARS)} '**': ${pattern}`);
  const chars = Array.from(pattern);
  const out: string[] = [];
  let i = 0;
  const startsWith = (token: string): boolean =>
    chars.slice(i, i + token.length).join('') === token;
  while (i < chars.length) {
    if (startsWith('**/')) {
      // Consecutive "**/" segments match the same paths as one.
      while (startsWith('**/')) i += 3;
      out.push('(?:[^\\n]*/)?');
    } else if (startsWith('**')) {
      out.push('[^\\n]*');
      i += 2;
    } else if (chars[i] === '*') {
      out.push('[^/]*');
      i += 1;
    } else if (chars[i] === '?') {
      out.push('[^/]');
      i += 1;
    } else {
      out.push(escapeRegex(chars[i] as string));
      i += 1;
    }
  }
  return new RegExp(`^${out.join('')}\\n?$`, 'u');
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

/** One string value and the text after it, or a thrown syntax error. */
function parseString(text: string): { value: string; rest: string } {
  const quote = text[0];
  if (quote === "'") {
    if (text.startsWith("'''")) throw new Error('multi-line strings are not supported');
    const end = text.indexOf("'", 1);
    if (end === -1) throw new Error('unterminated string');
    return { value: text.slice(1, end), rest: text.slice(end + 1) };
  }
  if (quote === '"') {
    if (text.startsWith('"""')) throw new Error('multi-line strings are not supported');
    let value = '';
    let at = 1;
    while (at < text.length) {
      const ch = text[at] as string;
      if (ch === '"') return { value, rest: text.slice(at + 1) };
      if (ch !== '\\') {
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

/** Entries are validated like Python: the first bad entry fails the file. */
export function parseScanExemptions(text: string): ScanExemption[] {
  const entries: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  let ignoring = false;
  for (const raw of text.split(/\r\n|\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const header = /^\[(\[)?\s*([A-Za-z0-9_-]+)\s*(\])?\](?:\s*#.*)?$/.exec(line);
      if (header === null || (header[1] === '[') !== (header[3] === ']'))
        throw new Error('invalid table header');
      if (header[1] === '[' && header[2] === 'exempt') {
        current = {};
        ignoring = false;
        entries.push(current);
      } else {
        // Python reads only doc["exempt"]; an unrelated table is ignored.
        if (header[2] === 'exempt') throw new Error('exempt is not an array of tables');
        current = null;
        ignoring = true;
      }
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (pair === null) throw new Error('invalid line');
    const { value, rest } = parseString((pair[2] as string).trim());
    const tail = rest.trim();
    if (tail !== '' && !tail.startsWith('#')) throw new Error('invalid value');
    if (ignoring) continue;
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
      rx: globRegex(path as string),
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
