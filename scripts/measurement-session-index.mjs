// Offline branch session index — measurement slice M6c (ADR-0008 vocabulary).
//
// buildSessionIndex joins committed/archived evidence into one reader
// artifact: per session, the run/work/session/model identity from the
// composition header correlation, joined with attempt aggregates and the
// observed closure commit. It is written offline from already-durable
// evidence; the engine NEVER reads it at runtime (reader artifacts are not
// runtime engine inputs).
//
// Identity discipline (ADR-0008 correlation row): branches alone are never
// unique — the index records branch as a plain field and joins/labels by
// the persisted workId and commit SHA only. A moved branch never relabels a
// commit: rows are keyed by commitSha, the branch is whatever the evidence
// observed at that boundary, and no cross-row reconciliation is attempted.
// Unknown values are null (never zero); each null carries an availability
// record keyed by JSON Pointer relative to the row. No transcript-time
// inference: buildSessionIndex reads only the supplied v3 records and folds
// nothing the evidence does not state.
//
// Plain JavaScript (like scripts/api-report.mjs): this offline tool is
// deliberately NOT imported into typechecked engine code — no .mjs module
// may import TS sources under Vitest's transform, and the engine must never
// read this artifact, so the boundary stays one-directional (tests import
// this script; production code never does).
import { z } from 'zod';
import { CorrelationRecordSchema, ObservationStreamSchema } from '../src/kernel/schema.js';

/** Availability helper: explicit absence with reason, never a guessed value. */
function availability(state, reason) {
  return { state, reason, source: null };
}

/** Strict schema for the committed index artifact (dual-reader ready). */
export const SessionIndexRowSchema = z
  .object({
    sessionId: z.string().nullable(),
    workId: z.string(),
    parentWorkId: z.string().nullable(),
    branch: z.string(),
    commitSha: z.string().nullable(),
    runId: z.string(),
    agentId: z.string().nullable(),
    model: z.object({ model: z.string(), provider: z.string() }).strict().nullable(),
    attempts: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative().nullable(),
    wallMs: z.number().nonnegative().nullable(),
    stopReasons: z.array(
      z
        .object({
          stopCode: z.string(),
          class: z.enum(['retriable', 'terminal', 'infrastructure', 'budget', 'human']),
        })
        .strict(),
    ),
    availability: z.record(z.string(), z.any()),
  })
  .strict();

export const SessionIndexSchema = z
  .object({
    indexVersion: z.literal(1),
    sessions: z.array(SessionIndexRowSchema),
  })
  .strict();

/**
 * Validate the correlation input against the strict ADR-0008 schema.
 * Returns a discriminated error instead of throwing so a caller can record
 * the row as unknown rather than crashing the offline build.
 */
export function parseCorrelationForIndex(correlation) {
  if (correlation === undefined || correlation === null) {
    return {
      ok: false,
      error: { state: 'missing', reason: 'no correlation record was supplied for this run' },
    };
  }
  const parsed = CorrelationRecordSchema.safeParse(correlation);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        state: 'invalid',
        reason: `correlation record failed schema validation: ${parsed.error.message}`,
      },
    };
  }
  return { ok: true, record: parsed.data };
}

/** Ordered stop reasons as observed, preserving attempt order and multiplicity. */
export function stopReasonsOf(attempts) {
  return attempts.map((a) => ({ stopCode: a.payload.stopCode, class: a.payload.class }));
}

/**
 * Build the offline branch session index from one composition run's durable
 * evidence (ADR-0008 correlation/attempt/availability rows). Deterministic:
 * same evidence in, same artifact out, no clock or environment reads.
 *
 * The result is a committed/archived reader artifact. Nothing in the engine
 * reads it at runtime; a moved branch does not relabel commits (rows are
 * keyed by commitSha and never reconciled across rows); every unknown is
 * null with an availability entry; a work observed under two distinct model
 * identities has model null (ambiguous), never a guessed pick.
 */
export function buildSessionIndex(input) {
  const correlation = parseCorrelationForIndex(input.correlation);
  if (!correlation.ok) {
    throw new Error(`session-index: ${correlation.error.reason}`);
  }
  const streamParsed = ObservationStreamSchema.safeParse(input.stream);
  if (!streamParsed.success) {
    throw new Error(
      `session-index: observation stream failed schema validation: ${streamParsed.error.message}`,
    );
  }
  const stream = streamParsed.data;

  const attempts = stream.events.filter((event) => event.type === 'attempt-finished');

  // Model provenance: collect distinct {model, provider} across attempts in
  // observation order; a work with no attempts or an ambiguous set has
  // model null with an availability record.
  const models = [];
  for (const attempt of attempts) {
    const spec = attempt.payload.model;
    if (spec && !models.some((m) => m.model === spec.model && m.provider === spec.provider)) {
      models.push({ model: spec.model, provider: spec.provider });
    }
  }

  // Closure commit: the correlation record's observed SHA only — never
  // inferred from branches or transcript content.
  const commitSha = correlation.record.commitSha;
  const tokens =
    attempts.length > 0 && attempts.every((a) => a.payload.tokens !== null)
      ? attempts.reduce((sum, a) => sum + a.payload.tokens, 0)
      : null;
  const wallMs =
    attempts.length > 0 && attempts.every((a) => a.payload.wallMs !== null)
      ? attempts.reduce((sum, a) => sum + a.payload.wallMs, 0)
      : null;

  const availabilityEntries = {};
  if (correlation.record.sessionId === null) {
    availabilityEntries['/sessionId'] = availability(
      'not-collected',
      'no session id was observed at any correlation boundary',
    );
  }
  if (correlation.record.agentId === null) {
    availabilityEntries['/agentId'] = availability(
      'not-collected',
      'no agent id was observed at any correlation boundary',
    );
  }
  if (commitSha === null) {
    availabilityEntries['/commitSha'] = availability(
      'not-collected',
      'no commit SHA was observed for this work',
    );
  }
  if (attempts.length === 0) {
    availabilityEntries['/model'] = availability(
      'not-collected',
      'no attempts were recorded for this work',
    );
  } else if (models.length === 0) {
    availabilityEntries['/model'] = availability(
      'unavailable',
      'attempts recorded no model identity (model null on every attempt)',
    );
  } else if (models.length > 1) {
    availabilityEntries['/model'] = availability(
      'unavailable',
      `model is ambiguous: ${models.length} distinct model identities were observed across attempts`,
    );
  }
  if (tokens === null) {
    availabilityEntries['/tokens'] = attempts.some((a) => a.payload.tokens !== null)
      ? availability('partial', 'some attempts carried known token counts; the sum is unknown')
      : availability('not-collected', 'no attempt carried a token count');
  }
  if (wallMs === null) {
    availabilityEntries['/wallMs'] = attempts.some((a) => a.payload.wallMs !== null)
      ? availability('partial', 'some attempts carried known wall times; the sum is unknown')
      : availability('not-collected', 'no attempt carried a wall time');
  }

  const row = {
    sessionId: correlation.record.sessionId,
    workId: correlation.record.workId,
    parentWorkId: correlation.record.parentWorkId,
    branch: correlation.record.branch,
    commitSha,
    runId: stream.compositionRunId,
    agentId: correlation.record.agentId,
    model: models.length === 1 ? models[0] : null,
    attempts: attempts.length,
    tokens,
    wallMs,
    stopReasons: stopReasonsOf(attempts),
    availability: availabilityEntries,
  };

  const index = { indexVersion: 1, sessions: [row] };
  // Validate the final artifact so a malformed row can never be committed.
  SessionIndexSchema.parse(index);
  return index;
}

/** Ambiguity helper: a commit with more than one distinct branch observation is ambiguous. */
export function commitBranchIsAmbiguous(rows) {
  const byCommit = new Map();
  for (const row of rows) {
    if (row.commitSha === null) continue;
    const set = byCommit.get(row.commitSha) ?? new Set();
    set.add(row.branch);
    byCommit.set(row.commitSha, set);
  }
  return [...byCommit.values()].some((set) => set.size > 1);
}
