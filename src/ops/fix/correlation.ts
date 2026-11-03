// Composition correlation persistence — ADR-0008 T05 (measurement slice M5a).
//
// `resolveCorrelation` allocates the run's CorrelationRecord once, before any
// dispatch: a fresh UUID workId (allocated exactly once per run; R14 resume
// must restore these exact ids — this slice has no resume loader, so an
// inbound record is adopted verbatim, never regenerated or merged), the
// caller-supplied branch (identity never inferred from the branch; it is a
// recorded field only), and null for everything not observed at this
// boundary (parent, commit, session, agent: null means unknown, never a
// guessed value). Every allocation returns a validated record; an invalid
// caller input (branch shape) is refused at the boundary instead of being
// persisted malformed.
//
// Out of scope here (unspecified seam upstream — reported, not improvised):
// RunOptions.correlation header handoff (T04) and the T30/T31 caller writer
// wiring are not yet on main, so no caller persists this record yet; the
// persistence acceptance is exercised through the round-trip test against
// the merged strict CorrelationRecordSchema.
import { randomUUID } from 'node:crypto';
import { CorrelationRecordSchema } from '../../kernel/schema.js';
import type { CorrelationRecord } from '../../kernel/types.js';

/** Inputs the composition supplies at the correlation boundary (ADR-0008). */
export interface ResolveCorrelationInput {
  /** Repository branch the composition runs on: recorded, never identity. */
  branch: string;
  /**
   * A record restored by a resume loader (R14) or supplied by an enclosing
   * composition: adopted verbatim. Absent → a fresh UUID workId is
   * allocated once.
   */
  restored?: CorrelationRecord;
}

/**
 * Allocate (or adopt) and validate this run's correlation record (ADR-0008
 * correlation row). The workId is a UUID allocated once and persisted; the
 * branch is a recorded field and never proves identity; unknown values are
 * null, never zero-shaped guesses.
 */
export function resolveCorrelation(input: ResolveCorrelationInput): CorrelationRecord {
  const correlation: CorrelationRecord = input.restored ?? {
    workId: randomUUID(),
    parentWorkId: null,
    branch: input.branch,
    commitSha: null,
    sessionId: null,
    agentId: null,
  };
  const parsed = CorrelationRecordSchema.safeParse(correlation);
  if (!parsed.success) {
    throw new Error(`correlation: invalid correlation record: ${parsed.error.message}`);
  }
  return parsed.data;
}
