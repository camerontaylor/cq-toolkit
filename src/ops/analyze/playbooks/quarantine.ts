// Analyze lane G3 — the QUARANTINE lane: the fail-closed state machine that
// keeps a PROVEN-BAD playbook from ever being re-dispatched automatically.
// A playbook whose verifier FAILED has demonstrated, on observed evidence,
// that its remediation does not hold — a repeat dispatch would re-apply the
// same suspect edits after nothing but a reboot of the process. So the
// failed verdict writes a quarantine record, and EVERY dispatch consults
// the ledger BEFORE anything runs; lifting a quarantine is an EXPLICIT
// consumer action ({@link QuarantineLedger.unquarantine}) that NOTHING in
// this codebase calls automatically (no op, no plan, no dispatch path —
// verifiable by the absence of any caller; v1 deliberately exposes no op
// for it either, so the plan runner's autonomous path cannot lift a
// quarantine it cannot see).
//
// Pure decision core: an in-memory ledger, zero I/O, zero clocks.
//
// Determinism, and the v1 cuts it is built on (recorded in the family
// NOTES.md too):
//   - Records are keyed by playbook id (one live record per playbook — a
//     re-quarantine after an explicit release upserts, latest reason wins)
//     and `records()` always returns them sorted by id, so two ledgers that
//     saw the same quarantine events present byte-identical state in any
//     event order that yields the same live set.
//   - Records carry NO timestamp in v1: when a playbook entered (or left)
//     quarantine is not derivable from the ledger. Ordering/duration
//     evidence, where a consumer needs it, lives in the dispatch trace
//     records (playbooks/registry.ts) — adding wall-clock fields here would
//     break the ledger's determinism contract (the acceptance property of
//     this lane) for provenance the trace already carries.
//   - The ledger is PROCESS-SCOPED in v1 (the composition binds one
//     instance per process — the registry importers share one): durable,
//     file-backed quarantine state is a post-v1 cut, and the same is true
//     of the playbook registry it guards.
//
// Phase tagging: each record carries `phase: 'verifier-failed'` — in v1
// that is the ONLY entry path into quarantine (an observed numeric non-zero
// verifier exit at dispatch time), and the tag names it explicitly so a
// future entry path (a manual hold, an invalid-rule hold) cannot silently
// masquerade as a verifier failure.
/**
 * The only quarantine entry phase in v1: an observed verifier failure at
 * dispatch time. Exported so tests and consumers pin the tag instead of
 * restating it.
 */
export const QUARANTINE_PHASE = 'verifier-failed';

/** The phase tag carried by every quarantine record. */
export type QuarantinePhase = typeof QUARANTINE_PHASE;

/** One playbook's live quarantine record — plain data, no timestamps (module header). */
export interface QuarantineRecord {
  playbookId: string;
  phase: QuarantinePhase;
  /** The verifier failure that produced the quarantine (the dispatch's fail reason). */
  reason: string;
}

/** The quarantine ledger surface — the dispatch path's fail-closed oracle. */
export interface QuarantineLedger {
  /**
   * Quarantine a playbook with the given (verifier-failure) reason. Upserts
   * any live record for the id (a post-release re-quarantine replaces the
   * old reason). Throws on an empty id or reason — a quarantine without its
   * evidence is a hole in the ledger, not a record. Returns a SNAPSHOT
   * disjoint from the stored record (no mutation aliasing): a caller
   * retaining it cannot mutate the ledger's evidence.
   */
  quarantine(playbookId: string, reason: string): QuarantineRecord;
  /** True exactly when a live quarantine record exists for the playbook. */
  isQuarantined(playbookId: string): boolean;
  /** The live record's reason, or undefined when the playbook is not quarantined. */
  reasonOf(playbookId: string): string | undefined;
  /**
   * EXPLICIT consumer action: lift the quarantine by deleting the live
   * record. Returns true when a record existed. NOTHING in the codebase
   * calls this automatically, and v1 exposes no op for it (module header) —
   * a quarantine is lifted by a human decision, never by a retry.
   */
  unquarantine(playbookId: string): boolean;
  /** The live records, sorted by playbook id (deterministic presentation). */
  records(): QuarantineRecord[];
}

/**
 * Build a quarantine ledger, optionally seeded with existing records
 * (library consumers restoring state; seeds are upserted by id in order,
 * so the last seed for an id wins — the same latest-wins rule as
 * {@link QuarantineLedger.quarantine}). Throws on a seed with an empty id
 * or reason.
 */
export function makeQuarantineLedger(initial?: readonly QuarantineRecord[]): QuarantineLedger {
  const live = new Map<string, QuarantineRecord>();
  const upsert = (playbookId: string, reason: string, phase: QuarantinePhase): QuarantineRecord => {
    if (playbookId === '') {
      throw new RangeError('quarantine ledger: a record without a playbook id is not a record');
    }
    if (reason === '') {
      throw new RangeError(
        `quarantine ledger: refusing to quarantine '${playbookId}' without a reason — the reason IS the evidence`,
      );
    }
    const record: QuarantineRecord = { playbookId, phase, reason };
    live.set(playbookId, record);
    // SNAPSHOT DISCIPLINE (no mutation aliasing): the ledger hands out
    // COPIES, never the stored record — a caller retaining the returned
    // record (or one from records()) cannot mutate the evidence the
    // fail-closed dispatch consult consults.
    return { ...record };
  };
  for (const record of initial ?? []) {
    upsert(record.playbookId, record.reason, record.phase);
  }
  return {
    quarantine: (playbookId, reason) => upsert(playbookId, reason, QUARANTINE_PHASE),
    isQuarantined: (playbookId) => live.has(playbookId),
    reasonOf: (playbookId) => live.get(playbookId)?.reason,
    unquarantine: (playbookId) => live.delete(playbookId),
    records: () =>
      [...live.values()]
        .sort((a, b) => (a.playbookId < b.playbookId ? -1 : 1))
        .map((record) => ({ ...record })),
  };
}
