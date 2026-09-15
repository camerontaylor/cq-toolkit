// Ledger lane C4 — the ledger DECISION ops over an INJECTED store: record a
// recurring error signature (count-only recurrence) and query the
// suppression/escalation view dispatch consults. Zero I/O here — persistence
// is the injected {@link LedgerStore}; the shipped sync node:fs adapter is
// {@link pathLedgerStore} in ./store.js, bound by the registry importer.
//
// Invariants honored here:
//   - The escalation IS the needs-human emission (UC §1 row 8): a count
//     reaching escalateAt maps the record op onto the FROZEN `needs-human`
//     status with a reason naming signature, count, and threshold — the
//     signature now routes to a human, never to another auto-fix.
//   - knownNoise is the suppression view (WS-D's planner consults it):
//     signatures at or above suppressAt are known noise — dispatch skips
//     re-fixing them; needsHuman ⊆ knownNoise by construction
//     (suppressAt < escalateAt, validated wherever thresholds enter).
//   - No hidden state (I7-adjacent): no timestamps anywhere, no memoization
//     — every call loads through the injected store, recurrence is
//     count-only, so results are time-independent and deterministic.
//   - Store I/O failure is `failed` (the op ran and definitively failed to
//     read or persist), never a fabricated ok and never a thrown error
//     across the op seam.
import type { Op } from '../../kernel/types.js';
import type { LedgerEntry, LedgerFile } from './store.js';
import { sortEntries } from './store.js';

/**
 * Recurrence thresholds. The invariant suppressAt < escalateAt is validated
 * wherever thresholds enter (the op boundary here, the registry schema for
 * JSON dispatch), alongside suppressAt ≥ 1 and escalateAt ≥ 2.
 */
export interface LedgerThresholds {
  /** Count at which a signature becomes known noise — dispatch skips re-fixing it. Default 2. */
  suppressAt: number;
  /** Count at which a signature escalates to a human (`needs-human`). Default 3. */
  escalateAt: number;
}

/**
 * The shipped thresholds, frozen deep (every level frozen): suppress at the
 * second occurrence, escalate at the third. Library consumers may pass their
 * own per-call via the input's `thresholds` — these are never mutated.
 */
export const DEFAULT_THRESHOLD: Readonly<LedgerThresholds> = Object.freeze({
  suppressAt: 2,
  escalateAt: 3,
});

/**
 * Injected persistence seam — the ONE I/O point of the ledger lane. Sync
 * for v1 (one small JSON file; the ops are async at the Op boundary
 * regardless). Tests inject Map-backed fakes; production binds
 * {@link pathLedgerStore}. `load` returns the current committed file
 * (missing entries start empty); `save` persists the whole file. Every op
 * call loads fresh — no state is kept between calls.
 */
export interface LedgerStore {
  load(): LedgerFile;
  save(file: LedgerFile): void;
}

/**
 * Per-call threshold overrides; absent fields fall back to
 * {@link DEFAULT_THRESHOLD}. Validated as a RESOLVED pair (suppressAt ≥ 1,
 * escalateAt ≥ 2, escalateAt > suppressAt) — an override pair that only
 * makes sense with the defaults (e.g. suppressAt above the default
 * escalateAt) is rejected, not silently tolerated.
 */
export interface LedgerRecordInput {
  /** Path of the ledger file the registry-bound store reads and writes. */
  storePath: string;
  /** The error signature to record (1..500 chars). */
  signature: string;
  /** Owning component; backfilled onto the entry only when it has none. */
  component?: string;
  /** Free-form note; backfilled onto the entry only when it has none. */
  note?: string;
  /** Per-call threshold overrides (resolved pair validated). */
  thresholds?: { suppressAt?: number; escalateAt?: number };
}

/** The report of a successful record: the signature's new recurrence count. */
export interface LedgerRecordReport {
  signature: string;
  count: number;
  /** Always false on `ok` — a reached escalation maps the op to `needs-human` instead. */
  escalated: boolean;
}

/** The read-only query's input; thresholds resolve and validate as for record. */
export interface LedgerQueryInput {
  /** Path of the ledger file the registry-bound store reads. */
  storePath: string;
  /** Per-call threshold overrides (resolved pair validated). */
  thresholds?: { suppressAt?: number; escalateAt?: number };
}

/**
 * The dispatch-facing view of the ledger — plain JSON-serializable data:
 *   - `entries`    — every ledger entry, canonically sorted;
 *   - `knownNoise` — signatures with count ≥ suppressAt, sorted: EXACTLY
 *                    the list dispatch must skip re-fixing;
 *   - `needsHuman` — signatures with count ≥ escalateAt, sorted: each must
 *                    route to a human; always a subset of knownNoise.
 */
export interface LedgerView {
  entries: LedgerEntry[];
  knownNoise: string[];
  needsHuman: string[];
}

/** Library-level signature bound, mirroring the registry schema's bound. */
const SIGNATURE_MAX_CHARS = 500;

/**
 * Build the `ledger.record` op over an input-driven store selector. The
 * selector receives the op input and returns the store to use — the
 * registry binds `(input) => pathLedgerStore(input.storePath)` (the path
 * crosses the plain-JSON boundary; no store object ever does), while a
 * library consumer can pass a constant store: `() => myStore`.
 *
 * Per call: load (a missing ledger starts empty), find the signature —
 * new → count 1, inserted in canonical order; existing → count + 1, with
 * component/note backfilled only onto fields that are absent — then persist.
 * A record always changes the ledger (the count grows), so the op always
 * saves; there is no unchanged fast path to suppress. Result mapping:
 * count < escalateAt → `ok` with the new count; count ≥ escalateAt →
 * `needs-human` whose reason names signature, count, and threshold. An
 * invalid signature or resolved-threshold pair, or a store load/save
 * failure, is `failed` — never a throw across the op seam.
 */
export function makeLedgerRecord(
  storeFor: (input: LedgerRecordInput) => LedgerStore,
): Op<LedgerRecordInput, LedgerRecordReport> {
  return async (input) => {
    const thresholds = resolvedThresholdsOrFault(input.thresholds);
    if ('fault' in thresholds) return { status: 'failed', error: thresholds.fault };
    const { escalateAt } = thresholds.thresholds;
    const signatureFault = signatureFaultOf(input.signature);
    if (signatureFault !== null) return { status: 'failed', error: signatureFault };
    let store: LedgerStore;
    let file: LedgerFile;
    try {
      store = storeFor(input);
      file = store.load();
    } catch (err) {
      return { status: 'failed', error: `ledger: could not load the error ledger — ${messageOf(err)}` };
    }
    const entries = file.entries;
    const index = entries.findIndex((entry) => entry.signature === input.signature);
    let updated: LedgerEntry;
    let nextEntries: LedgerEntry[];
    if (index === -1) {
      updated = { signature: input.signature, count: 1 };
      if (input.component !== undefined) updated.component = input.component;
      if (input.note !== undefined) updated.note = input.note;
      nextEntries = sortEntries([...entries, updated]);
    } else {
      const existing = entries[index] as LedgerEntry;
      updated = { ...existing, count: existing.count + 1 };
      if (updated.component === undefined && input.component !== undefined) {
        updated.component = input.component;
      }
      if (updated.note === undefined && input.note !== undefined) updated.note = input.note;
      nextEntries = entries.map((entry, i) => (i === index ? updated : entry));
    }
    try {
      store.save({ version: 1, entries: nextEntries });
    } catch (err) {
      return { status: 'failed', error: `ledger: could not save the error ledger — ${messageOf(err)}` };
    }
    return updated.count >= escalateAt
      ? {
          status: 'needs-human',
          reason: `error signature exceeded escalation threshold: ${updated.signature} (count ${updated.count} ≥ ${escalateAt})`,
        }
      : { status: 'ok', value: { signature: updated.signature, count: updated.count, escalated: false } };
  };
}

/**
 * Build the `ledger.query` op over an input-driven store selector (same
 * binding rule as {@link makeLedgerRecord}). READ-ONLY: the op never saves
 * — persistence is record's business. Per call: resolve and validate the
 * threshold pair, load, and derive the view — entries canonically sorted,
 * knownNoise (count ≥ suppressAt) and needsHuman (count ≥ escalateAt) as
 * signature lists sorted in the same canonical order, needsHuman always a
 * subset of knownNoise. Same store state → deep-equal view, every time.
 * An invalid resolved-threshold pair or a load failure is `failed`.
 */
export function makeLedgerQuery(
  storeFor: (input: LedgerQueryInput) => LedgerStore,
): Op<LedgerQueryInput, LedgerView> {
  return async (input) => {
    const thresholds = resolvedThresholdsOrFault(input.thresholds);
    if ('fault' in thresholds) return { status: 'failed', error: thresholds.fault };
    let file: LedgerFile;
    try {
      file = storeFor(input).load();
    } catch (err) {
      return { status: 'failed', error: `ledger: could not load the error ledger — ${messageOf(err)}` };
    }
    const { suppressAt, escalateAt } = thresholds.thresholds;
    const entries = sortEntries(file.entries);
    const knownNoise: string[] = [];
    const needsHuman: string[] = [];
    for (const entry of entries) {
      if (entry.count >= escalateAt) needsHuman.push(entry.signature);
      if (entry.count >= suppressAt) knownNoise.push(entry.signature);
    }
    return { status: 'ok', value: { entries, knownNoise, needsHuman } };
  };
}

/**
 * Resolve per-call overrides against {@link DEFAULT_THRESHOLD} and validate
 * the RESOLVED pair (the registry schema only cross-checks fields both
 * present — this is where a lone suppressAt above the default escalateAt is
 * caught). Returns the fault message instead of throwing: thresholds enter
 * at the op boundary, and boundary violations are `failed` results.
 */
function resolvedThresholdsOrFault(
  overrides?: { suppressAt?: number; escalateAt?: number },
): { thresholds: LedgerThresholds } | { fault: string } {
  const suppressAt = overrides?.suppressAt ?? DEFAULT_THRESHOLD.suppressAt;
  const escalateAt = overrides?.escalateAt ?? DEFAULT_THRESHOLD.escalateAt;
  if (!Number.isInteger(suppressAt) || suppressAt < 1) {
    return { fault: `ledger: invalid thresholds — suppressAt (${String(suppressAt)}) must be an integer ≥ 1` };
  }
  if (!Number.isInteger(escalateAt) || escalateAt < 2) {
    return { fault: `ledger: invalid thresholds — escalateAt (${String(escalateAt)}) must be an integer ≥ 2` };
  }
  if (escalateAt <= suppressAt) {
    return {
      fault: `ledger: invalid thresholds — escalateAt (${String(escalateAt)}) must be greater than suppressAt (${String(suppressAt)})`,
    };
  }
  return { thresholds: { suppressAt, escalateAt } };
}

/** Boundary validation of a signature: a non-empty string, at most 500 chars. */
function signatureFaultOf(signature: string): string | null {
  if (typeof signature !== 'string' || signature.length < 1) {
    return 'ledger: signature must be a non-empty string';
  }
  if (signature.length > SIGNATURE_MAX_CHARS) {
    return `ledger: signature exceeds ${SIGNATURE_MAX_CHARS} characters (${String(signature.length)})`;
  }
  return null;
}

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
