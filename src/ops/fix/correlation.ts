// Composition correlation persistence — ADR-0008 T05 (measurement slice M5a).
//
// `resolveCorrelation` allocates the run's CorrelationRecord: a fresh UUID
// workId and null for everything not observed at this boundary (parent,
// commit, session, agent: null means unknown, never a guessed value), plus
// the caller-supplied branch (identity never inferred from the branch; it
// is a recorded field only). A resume path may restore the WORK IDs only
// (ADR-0008 registry: "work IDs UUIDs allocated once and persisted; R14
// restores them on resume"): workId and parentWorkId are adopted verbatim,
// the branch comes from the caller input and must match the restored
// record's branch (a mismatch is rejected, not silently adopted), and stale
// commitSha/sessionId/agentId never survive — they are re-nulled. No
// general record adoption: a caller-supplied record's operational fields
// are not evidence.
//
// Every allocation returns a validated record; invalid caller input is
// refused at the boundary instead of being persisted malformed. The
// once-per-run discipline is caller-enforced (ADR-0008 composition header
// row): this module allocates on each call and has no run cache.
//
// Out of scope here (unspecified seam upstream — reported, not improvised):
// RunOptions.correlation header handoff (T04) and the T30/T31 caller writer
// wiring are not yet on main, so no caller persists this record yet.
import { randomUUID } from 'node:crypto';
import { CorrelationRecordSchema } from '../../kernel/schema.js';
import type { CorrelationRecord } from '../../kernel/types.js';

/** Inputs the composition supplies at the correlation boundary (ADR-0008). */
export interface ResolveCorrelationInput {
  /** Repository branch the composition runs on: recorded, never identity. */
  branch: string;
  /**
   * A record a resume loader (R14) restores from: its work IDs (workId,
   * parentWorkId) are adopted verbatim; its branch must equal `branch`
   * (a mismatch is rejected); its operational fields (commitSha, sessionId,
   * agentId) are discarded and re-nulled. Absent → a fresh UUID workId is
   * allocated.
   */
  restored?: Pick<CorrelationRecord, 'workId' | 'parentWorkId' | 'branch'>;
}

/**
 * Allocate (or work-ID-restore) and validate this run's correlation record
 * (ADR-0008 correlation row). The workId is a UUID allocated once and
 * persisted (the once-per-run discipline is caller-enforced); the branch is
 * a recorded field and never proves identity; unknown values are null,
 * never zero-shaped guesses.
 */
export function resolveCorrelation(input: ResolveCorrelationInput): CorrelationRecord {
  const restored = input.restored;
  if (restored !== undefined && restored.branch !== input.branch) {
    throw new Error(
      `correlation: restored record branch '${restored.branch}' does not match ` +
        `this run's branch '${input.branch}'`,
    );
  }
  // A restore must carry both work IDs explicitly: an omitted parentWorkId
  // is an incomplete resume record, not a root — defaulting it to null here
  // would silently drop the persisted parent link (root parent is an
  // explicit null, which passes through untouched).
  if (
    restored !== undefined &&
    (restored.workId === undefined || restored.parentWorkId === undefined)
  ) {
    throw new Error(
      'correlation: restored record must carry an explicit workId and parentWorkId ' +
        '(null for a root work) — an omitted work ID is an incomplete resume record',
    );
  }
  const correlation: CorrelationRecord = {
    // Only the work IDs survive a restore, verbatim; everything else is
    // this run's fresh boundary state. A present restore's IDs are used
    // AS-IS — a null/invalid restored ID must fail schema validation, never
    // silently fall back to a freshly allocated identity.
    workId: restored === undefined ? randomUUID() : restored.workId,
    parentWorkId: restored === undefined ? null : restored.parentWorkId,
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
