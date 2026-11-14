/**
 * `backfill_accounting` pure half: Git fact parsers, cache shapes and line
 * mappings, with no process, filesystem or clock access.
 *
 * `apps/crq-python/backfill_accounting.py` is the oracle. This module owns the
 * bytes-to-facts half that the differential vectors pin:
 *
 * - `line_bytes` and `ranges` line maths (a blame row's line count is the same
 *   split rule, including a kept carriage return from CRLF content).
 * - The `_int` / `_opt_str` / `_rows` / `_hexstr` validators and every
 *   `FACT_SHAPES` entry. A digest-valid cache value of the wrong shape is a
 *   miss, never trusted, so the shape functions take the lossless
 *   {@link JsonValue} form where `1` and `1.0` stay distinct.
 * - The blame row state machine, `--name-status -z` lineage steps and the
 *   pinned plain-diff hunk state machine (`@@` header ranges are the credit;
 *   malformed, negative or truncated hunks refuse with the oracle's text).
 * - `carry`'s unique-line matching and its Python list-index semantics: `0`
 *   means the last line and an index that normalises below `1` raises.
 *
 * Adapter policy split: `src/adapters/crq/backfillAccounting.ts` owns Git
 * invocation, the invocation caches and the `backfill_cache.Cache` binding.
 * Nothing here reads the environment or the clock.
 */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import { LedgerIntegrityError } from './ledger.js';

/** `backfill_accounting.BLAME_OPTIONS`: the provenance a replay is bound to. */
export const ACCOUNTING_BLAME_OPTIONS: readonly string[] = ['--line-porcelain', '--encoding=UTF-8'];

/** `backfill_accounting.ENTRY_CACHE_TREES`. */
export const ACCOUNTING_ENTRY_CACHE_TREES = 1024;
/** `backfill_accounting.ENTRY_CACHE_BYTES` (256 MiB). */
export const ACCOUNTING_ENTRY_CACHE_BYTES = 256 * 1024 * 1024;
/** `backfill_accounting.LINEAGE_CACHE_BYTES` (32 MiB). */
export const ACCOUNTING_LINEAGE_CACHE_BYTES = 32 * 1024 * 1024;
/**
 * `backfill_accounting.LINEAGE_RESULT_EPOCH`. Bump when lineage or
 * `proven_deleted` result semantics change: persisted mappings written under an
 * older epoch must stop matching (the fact-cache salt includes this value).
 */
export const ACCOUNTING_LINEAGE_RESULT_EPOCH = 1;
/** `backfill_accounting.FACT_CACHE_BYTES` (64 MiB). */
export const ACCOUNTING_FACT_CACHE_BYTES = 64 * 1024 * 1024;

/** The Python exception class and text every parser refusal preserves. */
export class BackfillAccountingError extends LedgerIntegrityError {
  override readonly name: string = 'BackfillAccountingError';
  override readonly pythonError: string = 'IntegrityError';
}

/** `IndexError` from `carry`'s negative-index normalisation. */
export class BackfillAccountingIndexError extends Error {
  override readonly name: string = 'BackfillAccountingIndexError';
  readonly pythonError: string = 'IndexError';
}

/** One `git blame --line-porcelain` row: origin, original line, path, content. */
export interface BlameRow {
  readonly origin: string | null;
  readonly originalLine: number | null;
  readonly filename: Uint8Array | null;
  readonly content: Uint8Array;
}

/** One `--name-status -z` change: status, source path, rename/copy target. */
export type NameStatusChange = readonly [
  status: string,
  source: string,
  destination: string | null,
];

/** A git fact persisted by `backfill_cache`, one namespace per parser. */
export type AccountingFactKind =
  | 'blame'
  | 'lineage_step'
  | 'lineage'
  | 'carry'
  | 'coverage'
  | 'verified_review';

/** `backfill_accounting.line_bytes`: split on LF, dropping the final empty. */
export function lineBytes(data: Uint8Array): Uint8Array[] {
  if (data.length === 0) return [];
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] !== 0x0a) continue;
    lines.push(data.slice(start, index));
    start = index + 1;
  }
  if (start < data.length) lines.push(data.slice(start));
  return lines;
}

/** `len(backfill_accounting.line_bytes(data))` without materialising rows. */
export function lineCount(data: Uint8Array): number {
  if (data.length === 0) return 0;
  let count = 1;
  for (const byte of data) if (byte === 0x0a) count += 1;
  if (data[data.length - 1] === 0x0a) count -= 1;
  return count;
}

/** `backfill_accounting.ranges`: sorted, coalesced 1-based inclusive rows. */
export function lineRanges(lines: Iterable<number>): Array<[number, number]> {
  const ordered = [...new Set(lines)].sort((left, right) => left - right);
  const result: Array<[number, number]> = [];
  for (const number of ordered) {
    const last = result[result.length - 1];
    if (last !== undefined && last[1] === number - 1) {
      last[1] = number;
    } else {
      result.push([number, number]);
    }
  }
  return result;
}

/** `backfill_accounting._int`: a Python `int` (not bool/float) at least `low`. */
export function factInt(value: JsonValue | undefined, low = 0): boolean {
  return (
    value instanceof JsonNumber && value.kind === 'int' && (value.integer ?? 0n) >= BigInt(low)
  );
}

/** `backfill_accounting._opt_str`: null or a string. */
export function optionalString(value: JsonValue | undefined): boolean {
  return value === null || typeof value === 'string';
}

/** `backfill_accounting._rows`: `[[start, end], ...]` with both ends >= 1. */
export function intervalRows(value: JsonValue | undefined): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (row) => Array.isArray(row) && row.length === 2 && factInt(row[0], 1) && factInt(row[1], 1),
    )
  );
}

/** `backfill_accounting._hexstr`: lowercase, even-length, possibly empty. */
export function hexString(value: JsonValue | undefined): boolean {
  return typeof value === 'string' && /^(?:[0-9a-f]{2})*$/.test(value);
}

function exactKeys(value: JsonValue | undefined, names: readonly string[]): boolean {
  if (!(value instanceof JsonObject)) return false;
  const keys = value.entries.map(([key]) => key);
  if (keys.length !== names.length) return false;
  return names.every((name) => keys.includes(name));
}

function objectValue(value: JsonValue, key: string): JsonValue | undefined {
  return value instanceof JsonObject
    ? value.entries.find(([name]) => name === key)?.[1]
    : undefined;
}

function blameShape(value: JsonValue | undefined): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 4 &&
        typeof row[0] === 'string' &&
        factInt(row[1]) &&
        hexString(row[2]) &&
        hexString(row[3]),
    )
  );
}

function lineageStepShape(value: JsonValue | undefined): boolean {
  if (!exactKeys(value, ['parent', 'changes'])) return false;
  if (typeof objectValue(value as JsonValue, 'parent') !== 'string') return false;
  const changes = objectValue(value as JsonValue, 'changes');
  return (
    Array.isArray(changes) &&
    changes.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 3 &&
        typeof row[0] === 'string' &&
        typeof row[1] === 'string' &&
        optionalString(row[2]),
    )
  );
}

function lineageShape(value: JsonValue | undefined): boolean {
  return exactKeys(value, ['path']) && optionalString(objectValue(value as JsonValue, 'path'));
}

function carryShape(value: JsonValue | undefined): boolean {
  if (!exactKeys(value, ['path', 'matches', 'old_lines'])) return false;
  const document = value as JsonValue;
  if (!optionalString(objectValue(document, 'path'))) return false;
  const oldLines = objectValue(document, 'old_lines');
  if (!(oldLines instanceof JsonNumber) || oldLines.kind !== 'int') return false;
  const maximum = oldLines.integer ?? 0n;
  const matches = objectValue(document, 'matches');
  return (
    Array.isArray(matches) &&
    matches.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 2 &&
        factInt(row[0], 1) &&
        (row[0] as JsonNumber).integer !== null &&
        ((row[0] as JsonNumber).integer as bigint) <= maximum &&
        factInt(row[1], 1),
    )
  );
}

function coverageShape(value: JsonValue | undefined): boolean {
  if (!exactKeys(value, ['covered', 'evidence'])) return false;
  const document = value as JsonValue;
  const covered = objectValue(document, 'covered');
  const evidence = objectValue(document, 'evidence');
  return (
    covered instanceof JsonObject &&
    covered.entries.every(([, rows]) => intervalRows(rows)) &&
    evidence instanceof JsonObject &&
    evidence.entries.every(
      ([, ids]) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'),
    )
  );
}

function verifiedReviewShape(value: JsonValue | undefined): boolean {
  return value instanceof JsonObject && value.entries.every(([, rows]) => intervalRows(rows));
}

/**
 * `backfill_accounting.FACT_SHAPES`: the cache-trust gate. A digest-valid value
 * of the wrong shape is a miss and is recomputed; it never raises.
 */
export const FACT_SHAPES: Readonly<
  Record<AccountingFactKind, (value: JsonValue | undefined) => boolean>
> = {
  blame: blameShape,
  lineage_step: lineageStepShape,
  lineage: lineageShape,
  carry: carryShape,
  coverage: coverageShape,
  verified_review: verifiedReviewShape,
};

/** `bytes.splitlines()` for the ASCII line boundaries Python recognises. */
export function pythonSplitLines(data: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  let index = 0;
  while (index < data.length) {
    const byte = data[index];
    if (byte !== 0x0a && byte !== 0x0d) {
      index += 1;
      continue;
    }
    lines.push(data.slice(start, index));
    index += byte === 0x0d && data[index + 1] === 0x0a ? 2 : 1;
    start = index;
  }
  if (start < data.length) lines.push(data.slice(start));
  return lines;
}

/** `bytes.split(b"\0")`, keeping a trailing empty field. */
export function splitNul(data: Uint8Array): Uint8Array[] {
  const fields: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] !== 0x00) continue;
    fields.push(data.slice(start, index));
    start = index + 1;
  }
  fields.push(data.slice(start));
  return fields;
}

const BLAME_HEADER = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/;
const FILENAME_PREFIX = [0x66, 0x69, 0x6c, 0x65, 0x6e, 0x61, 0x6d, 0x65, 0x20];

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  if (data.length < prefix.length) return false;
  return prefix.every((byte, index) => data[index] === byte);
}

function decodeLossless(data: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(data);
}

/**
 * `Repository.blame`'s row parser. A header line sets origin and original
 * line, `filename ` sets the path, and a tab-prefixed line closes one row with
 * the content after the tab. Headerless or filename-less rows never appear in
 * real `--line-porcelain` output but keep the oracle's nullable fields.
 */
export function parseBlame(raw: Uint8Array): BlameRow[] {
  const rows: BlameRow[] = [];
  let origin: string | null = null;
  let originalLine: number | null = null;
  let filename: Uint8Array | null = null;
  for (const line of pythonSplitLines(raw)) {
    if (line[0] === 0x09) {
      rows.push({ origin, originalLine, filename, content: line.slice(1) });
      continue;
    }
    if (startsWith(line, FILENAME_PREFIX)) {
      filename = line.slice(FILENAME_PREFIX.length);
      continue;
    }
    const header = BLAME_HEADER.exec(decodeLossless(line));
    if (header !== null) {
      origin = header[1] ?? null;
      originalLine = Number(header[2]);
    }
  }
  return rows;
}

function decodeReplaced(data: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(data);
}

/**
 * `_lineage_step`'s `--name-status -z` parser. A rename or copy status consumes
 * the following destination field; the source and destination use Python's
 * replacement decode, so a non-UTF8 path still round-trips as a string.
 */
export function parseNameStatus(raw: Uint8Array): NameStatusChange[] {
  const fields = splitNul(raw);
  const changes: NameStatusChange[] = [];
  let index = 0;
  while (index < fields.length - 1) {
    const status = decodeLossless(fields[index] as Uint8Array);
    const source = decodeReplaced(fields[index + 1] as Uint8Array);
    index += 2;
    let destination: string | null = null;
    if (status.startsWith('R') || status.startsWith('C')) {
      destination = decodeReplaced(fields[index] as Uint8Array);
      index += 1;
    }
    changes.push([status, source, destination]);
  }
  return changes;
}

/** `_lineage_step`'s parsed result, persisted as one cache fact. */
export interface LineageStep {
  readonly parent: string;
  readonly changes: NameStatusChange[];
}

/** Parse one `--find-renames=100%` name-status stream around a known parent. */
export function parseLineageStep(raw: Uint8Array, parent: string): LineageStep {
  return { parent, changes: parseNameStatus(raw) };
}

/** A quoted or backslash path uses the whole-file residual fallback. */
function usableDiffName(name: string): boolean {
  return !name.startsWith('"') && !name.includes('\\');
}

/**
 * `Repository.changed_intervals`: head-side line intervals from the pinned
 * plain-diff form. The `@@` header range *is* the oracle's credit; context
 * lines are never credited. Malformed or truncated hunks refuse with the
 * oracle's exact text.
 */
export function parseChangedIntervals(patch: Uint8Array): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let current: string | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of decodeLossless(patch).split('\n')) {
    if (oldLeft !== 0 || newLeft !== 0) {
      if (line.startsWith(' ')) {
        oldLeft -= 1;
        newLeft -= 1;
      } else if (line.startsWith('-')) {
        oldLeft -= 1;
      } else if (line.startsWith('+')) {
        newLeft -= 1;
      } else if (line.startsWith('\\ No newline at end of file')) {
        continue;
      } else {
        throw new BackfillAccountingError('malformed diff hunk');
      }
      if (oldLeft < 0 || newLeft < 0) {
        throw new BackfillAccountingError('malformed diff hunk length');
      }
      continue;
    }
    if (line.startsWith('+++ b/')) {
      let name = line.slice(6);
      if (name.includes(' ') && name.endsWith('\t')) name = name.slice(0, -1);
      if (usableDiffName(name)) {
        current = name;
        if (!result.has(name)) result.set(name, new Set());
      } else {
        current = null;
      }
    } else if (line.startsWith('+++ ')) {
      current = null;
    } else if (line.startsWith('@@ ')) {
      const match = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match === null) throw new BackfillAccountingError('malformed diff hunk header');
      oldLeft = match[1] === undefined ? 1 : Number(match[1]);
      const start = Number(match[2]);
      newLeft = match[3] === undefined ? 1 : Number(match[3]);
      if (current !== null && current !== '') {
        const rows = result.get(current) as Set<number>;
        for (let number = start; number < start + newLeft; number += 1) rows.add(number);
      }
    }
  }
  if (oldLeft !== 0 || newLeft !== 0) {
    throw new BackfillAccountingError('truncated diff hunk');
  }
  return result;
}

function hexOf(data: Uint8Array | null): string {
  return data === null ? '' : Buffer.from(data).toString('hex');
}

function bytesFromHex(value: JsonValue | undefined): Uint8Array | null {
  return hexString(value) ? new Uint8Array(Buffer.from(value as string, 'hex')) : null;
}

/** The cache form of a blame result: four-field rows with hex byte leaves. */
export function blameFact(rows: readonly BlameRow[]): unknown[][] {
  return rows.map((row) => [row.origin, row.originalLine, hexOf(row.filename), hexOf(row.content)]);
}

/** Decode a cached blame fact; null when a row is not the persisted shape. */
export function blameFromFact(value: JsonValue | undefined): BlameRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: BlameRow[] = [];
  try {
    for (const row of value) {
      if (!Array.isArray(row) || row.length !== 4) return null;
      const [origin, line, filename, content] = row;
      if (typeof origin !== 'string' || !factInt(line)) return null;
      const decodedFilename = bytesFromHex(filename);
      const decodedContent = bytesFromHex(content);
      if (decodedFilename === null || decodedContent === null) return null;
      rows.push({
        origin,
        originalLine: Number((line as JsonNumber).integer ?? 0n),
        filename: decodedFilename,
        content: decodedContent,
      });
    }
  } catch {
    return null;
  }
  return rows;
}

function blameSignature(row: BlameRow): string {
  return `${row.origin ?? ''}\u0000${String(row.originalLine ?? '')}\u0000${hexOf(
    row.filename,
  )}\u0000${hexOf(row.content)}`;
}

/** `carry`'s unique blame-signature matching, with the oracle's old-line bound. */
export function carryMatches(
  oldBlame: readonly BlameRow[],
  newBlame: readonly BlameRow[],
): { matches: Map<number, number>; maximum: number } {
  const counts = new Map<string, number>();
  for (const row of newBlame) {
    const signature = blameSignature(row);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  const oldCounts = new Map<string, number>();
  for (const row of oldBlame) {
    const signature = blameSignature(row);
    oldCounts.set(signature, (oldCounts.get(signature) ?? 0) + 1);
  }
  const positions = new Map<string, number>();
  newBlame.forEach((row, index) => {
    const signature = blameSignature(row);
    if (counts.get(signature) === 1) positions.set(signature, index + 1);
  });
  const matches = new Map<number, number>();
  oldBlame.forEach((row, index) => {
    const signature = blameSignature(row);
    const position = positions.get(signature);
    if (oldCounts.get(signature) === 1 && position !== undefined) {
      matches.set(index + 1, position);
    }
  });
  return { matches, maximum: oldBlame.length };
}

/**
 * `carry`'s selection step. A requested line beyond `maximum` is ignored; `0`
 * selects the last old line and a negative line counts back from the end. An
 * index that normalises below `1` raises `IndexError`, exactly the oracle's
 * list-index failure.
 */
export function carrySelection(
  name: string | null,
  matches: ReadonlyMap<number, number>,
  maximum: number,
  lines: Iterable<number>,
): { name: string | null; mapped: Set<number> } {
  if (name === null) return { name: null, mapped: new Set() };
  const selected = new Set<number>();
  for (const number of lines) {
    if (number > maximum) continue;
    const normalized = number > 0 ? number : maximum + number;
    if (normalized < 1) throw new BackfillAccountingIndexError('list index out of range');
    const target = matches.get(normalized);
    if (target !== undefined) selected.add(target);
  }
  return { name, mapped: selected };
}

/** The persisted carry fact: mapped path, line pairs and the old-line bound. */
export interface CarryFact {
  readonly path: string | null;
  readonly matches: ReadonlyArray<readonly [number, number]>;
  readonly oldLines: number;
}

/** Encode one carry outcome for `backfill_cache` under `kind: "carry"`. */
export function carryFact(value: CarryFact): Record<string, unknown> {
  return {
    path: value.path,
    matches: value.matches.map(([oldLine, newLine]) => [oldLine, newLine]),
    old_lines: value.oldLines,
  };
}

/** Decode a cached carry fact; null when a persisted leaf is unusable. */
export function carryFromFact(
  value: JsonValue | undefined,
): { path: string | null; matches: Map<number, number>; oldLines: number } | null {
  if (!exactKeys(value, ['path', 'matches', 'old_lines'])) return null;
  const document = value as JsonValue;
  const path = objectValue(document, 'path');
  const oldLines = objectValue(document, 'old_lines');
  const matches = objectValue(document, 'matches');
  if (path !== null && typeof path !== 'string') return null;
  if (!(oldLines instanceof JsonNumber) || !factInt(oldLines)) return null;
  const oldLineCount = oldLines.integer ?? 0n;
  if (!Array.isArray(matches)) return null;
  const result = new Map<number, number>();
  for (const row of matches) {
    if (!Array.isArray(row) || row.length !== 2 || !factInt(row[0], 1) || !factInt(row[1], 1)) {
      return null;
    }
    const first = (row[0] as JsonNumber).integer;
    const second = (row[1] as JsonNumber).integer;
    if (first === null || second === null || first > oldLineCount) return null;
    result.set(Number(first), Number(second));
  }
  return {
    path,
    matches: result,
    oldLines: Number(oldLineCount),
  };
}

/** The cache form of a verified review: path -> coalesced intervals. */
export function verifiedFact(
  lines: ReadonlyMap<string, ReadonlySet<number>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, rows] of lines) definePlain(result, name, lineRanges(rows));
  return result;
}

/** The cache form of a coverage fold: covered rows and contributing ids. */
export function coverageFact(
  covered: ReadonlyMap<string, ReadonlySet<number>>,
  evidence: ReadonlyMap<string, readonly string[]>,
): Record<string, unknown> {
  const rows: Record<string, unknown> = {};
  const ids: Record<string, unknown> = {};
  for (const [name, lines] of covered) definePlain(rows, name, lineRanges(lines));
  for (const [name, values] of evidence) definePlain(ids, name, [...values]);
  return { covered: rows, evidence: ids };
}

/** A canonical repository path such as `__proto__` stays an own data property. */
function definePlain(object: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
