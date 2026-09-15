// Ledger lane C4 — the novel-error ledger's flat file format and its pure
// (de)serialization. The ledger prevents re-fixing known noise: every
// recurring error signature carries a recurrence COUNT — no timestamps —
// so recurrence is count-only and every derived view is time-independent.
// The file is committed evidence, which makes two properties load-bearing:
//   - serializeLedger is BYTE-DETERMINISTIC: entries sorted by signature
//     (byte-wise ascending), keys emitted in schema order (signature, count,
//     component, note), 2-space indent, exactly one trailing newline — the
//     same ledger state always renders to the same bytes, so git diffs of
//     the committed file are reviewable.
//   - parseLedger is STRICT: invalid JSON, a wrong version, a non-object
//     entry, a count < 1, a duplicate signature, or UNSORTED entries all
//     throw LedgerFormatError. The deterministic format is load-bearing, so
//     a hand-edited unsorted file is a format error — never silently
//     normalized. Normalization happens in the ledger ops, not here: the
//     store never collapses duplicates nor reorders anything on read.
//
// File I/O stays with the consumer: everything but the OPTIONAL
// {@link pathLedgerStore} is pure, and tests inject fakes. pathLedgerStore
// is the sync node:fs adapter the registry importer binds — the only
// node:fs touch in the lane's storage (sync for v1: ledger entries are one
// small JSON file, and the ops are async at the Op boundary regardless).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { LedgerStore } from './ledger.js';

/** One recurring error signature and its recurrence count (≥ 1). */
export interface LedgerEntry {
  /** The error signature — the stable identity of the recurring failure. */
  signature: string;
  /** How many times the signature was recorded; starts at 1, grows by 1. */
  count: number;
  /** Owning component (e.g. 'src/ops/ledger'); backfilled by the ledger op when first provided. */
  component?: string;
  /** Free-form human note; backfilled by the ledger op when first provided. */
  note?: string;
}

/** The persisted ledger file. Version 1 — the only version parseLedger accepts. */
export interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
}

/**
 * Thrown by {@link parseLedger} (and the write-side guards of
 * {@link serializeLedger}) on any violation of the committed format.
 */
export class LedgerFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerFormatError';
  }
}

/**
 * The canonical signature order: byte-wise ascending. Implemented as
 * code-point comparison, which is exactly UTF-8 byte order (a UTF-8
 * property), so the sort does not drift with locale collation and a
 * non-BMP signature orders by its true bytes, not its surrogate pair.
 */
export function sortEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => compareSignatures(a.signature, b.signature));
}

/** Code-point (UTF-8 byte order) comparison of two signatures. */
function compareSignatures(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(i) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    if (ca > 0xffff) i++; // consumed a surrogate pair as one code point
  }
  return a.length - b.length;
}

const LedgerEntrySchema: z.ZodType<LedgerEntry> = z
  .object({
    signature: z.string().min(1),
    count: z.number().int().min(1),
    component: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

const LedgerFileSchema: z.ZodType<LedgerFile> = z
  .object({
    version: z.literal(1),
    entries: z.array(LedgerEntrySchema),
  })
  .strict();

/**
 * Serialize a ledger deterministically: entries sorted by
 * {@link sortEntries}, keys in schema order (signature, count, component,
 * note), 2-space indent, exactly one trailing newline. Write-side guards
 * reject what the output's own parser would reject — a non-integer count
 * (JSON.stringify would render NaN to null) and duplicate signatures (the
 * store never collapses them; the ledger owns normalization) — so
 * `parseLedger(serializeLedger(file))` holds for every accepted file.
 */
export function serializeLedger(file: LedgerFile): string {
  const seen = new Set<string>();
  for (const entry of file.entries) {
    if (!Number.isSafeInteger(entry.count) || entry.count < 1) {
      throw new LedgerFormatError(
        `ledger: entry '${entry.signature}' has count ${String(entry.count)} — must be an integer ≥ 1`,
      );
    }
    if (seen.has(entry.signature)) {
      throw new LedgerFormatError(
        `ledger: duplicate signature '${entry.signature}' — the store never collapses duplicates`,
      );
    }
    seen.add(entry.signature);
  }
  const ordered = {
    version: file.version,
    entries: sortEntries(file.entries).map((entry) => ({
      signature: entry.signature,
      count: entry.count,
      component: entry.component,
      note: entry.note,
    })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Parse and validate ledger text; throws {@link LedgerFormatError} on any
 * schema violation, a duplicate signature, or entries out of canonical
 * order (adjacent equal signatures are already duplicates). Key order
 * WITHIN an entry is not enforced — canonical key order is a serialize
 * guarantee; content is what the format pins.
 */
export function parseLedger(text: string): LedgerFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new LedgerFormatError(`ledger: not valid JSON — ${(err as Error).message}`);
  }
  const parsed = LedgerFileSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new LedgerFormatError(`ledger: schema violation — ${issues}`);
  }
  const entries = parsed.data.entries;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.signature)) {
      throw new LedgerFormatError(`ledger: duplicate signature '${entry.signature}'`);
    }
    seen.add(entry.signature);
  }
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1] as LedgerEntry;
    const curr = entries[i] as LedgerEntry;
    if (compareSignatures(prev.signature, curr.signature) >= 0) {
      throw new LedgerFormatError(
        `ledger: entries not sorted — '${prev.signature}' must sort strictly before '${curr.signature}' (byte-wise ascending is the committed format)`,
      );
    }
  }
  return parsed.data;
}

/**
 * The OPTIONAL shipped store: a sync node:fs adapter over one JSON file at
 * `path`. Load of a missing file yields the empty ledger (missing entries
 * start empty — recording is the only writer); any other read fault, or a
 * corrupt committed file (via parseLedger), throws — the ops map that to
 * `failed`, the read-only query likewise. Save serializes through
 * {@link serializeLedger} (byte-deterministic) and mkdir -p's the parent.
 */
export function pathLedgerStore(path: string): LedgerStore {
  return {
    load: () => {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        if (isEnoent(err)) return { version: 1, entries: [] };
        throw err;
      }
      return parseLedger(text);
    },
    save: (file) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, serializeLedger(file), 'utf8');
    },
  };
}

/** True when a thrown value is a node:fs ENOENT (the missing-file case). */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT'
  );
}
