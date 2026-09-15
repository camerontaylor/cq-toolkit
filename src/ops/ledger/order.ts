// Ledger lane C4 — the canonical signature order, shared by the store's
// serializer and the ledger's view building. A tiny PURE module: the
// decision ops (ledger.ts) must be able to sort WITHOUT a runtime import of
// ./store.js, whose optional node:fs adapter must never load into pure
// consumers (only a type-only import of the entry shape appears here and is
// erased at compile time).
import type { LedgerEntry } from './store.js';

/**
 * The canonical signature order: byte-wise ascending. Implemented as
 * code-point comparison, which is exactly UTF-8 byte order (a UTF-8
 * property), so the sort does not drift with locale collation and a
 * non-BMP signature orders by its true bytes, not its surrogate pair.
 * Non-mutating: returns a new array.
 */
export function sortEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => compareSignatures(a.signature, b.signature));
}

/**
 * Code-point (UTF-8 byte order) comparison of two signatures — exported
 * for the store's strict sortedness check, which must judge ADJACENT
 * entries with the exact comparator the sort uses.
 */
export function compareSignatures(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(i) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    if (ca > 0xffff) i++; // consumed a surrogate pair as one code point
  }
  return a.length - b.length;
}
