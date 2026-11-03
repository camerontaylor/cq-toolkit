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
// Plain JavaScript (like scripts/demo-eval-axes.mjs): this offline tool is
// deliberately NOT imported into engine code — the engine must never read
// this artifact; the boundary stays one-directional. It loads the strict
// v3 schemas from the BUILT engine (../dist), the same self-host pattern
// as the eval-axes demo, so plain Node resolves them (no TS sources).
import { z } from 'zod';
import { CorrelationRecordSchema, ObservationStreamSchema } from '../dist/kernel/schema.js';

/** Availability helper: explicit absence with reason, never a guessed value. */
function availability(state, reason) {
  return { state, reason, source: null };
}

/** Strict schema for the committed index artifact (dual-reader ready). */
export const SessionIndexRowSchema = z
  .object({
    /** Archive-safe opaque remote digest; null when no remote exists. */
    repo: z.string().nullable(),
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
    availability: z.record(
      // Valid JSON Pointer relative to the row: the empty string (root)
      // or a leading-slash pointer — same discipline as the kernel
      // AvailabilityMapSchema.
      z.string().regex(/^$|^\//),
      z
        .object({
          state: z.enum(['known-zero', 'not-collected', 'unavailable', 'partial', 'n-a', 'known']),
          reason: z.string(),
          source: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const SessionIndexSchema = z
  .object({
    indexVersion: z.literal(1),
    sessions: z.array(SessionIndexRowSchema),
  })
  .strict()
  .superRefine((index, ctx) => {
    // Null-implies-availability discipline (mirrors T28's checkMetric):
    // a null nullable value MUST carry an availability entry at its
    // pointer; a non-null value must NOT be marked not-collected or
    // unavailable (a present value with an absence state contradicts
    // itself), and never known/known-zero/partial on a null (partial also
    // implies a known subtotal, which a null cannot carry).
    // parentWorkId is excluded: its null is a structural value (root work),
    // not missing evidence, and never carries an availability entry.
    const nullableFields = [
      'repo',
      'sessionId',
      'commitSha',
      'agentId',
      'model',
      'tokens',
      'wallMs',
    ];
    // Availability keys are JSON Pointers to a row field, so only the
    // nullable-field pointers and the '' root sentinel are meaningful: an
    // entry at any other pointer states an absence nothing can consume.
    const allowedPointers = new Set(nullableFields.map((field) => `/${field}`));
    index.sessions.forEach((row, i) => {
      for (const pointer of Object.keys(row.availability)) {
        if (pointer !== '' && !allowedPointers.has(pointer)) {
          ctx.addIssue({
            code: 'custom',
            message:
              `availability pointer '${pointer}' is not a nullable row field: ` +
              `use '' (root) or one of ${[...allowedPointers].join(', ')}`,
            path: ['sessions', i, 'availability'],
          });
        }
      }
      // The root sentinel marks a torn/incomplete stream, which the builder
      // only ever writes as 'partial'; a known root would claim completeness.
      const root = row.availability[''];
      if (root !== undefined && root.state !== 'partial') {
        ctx.addIssue({
          code: 'custom',
          message: `the root availability entry (torn/incomplete stream) must state 'partial', not '${root.state}'`,
          path: ['sessions', i, 'availability', ''],
        });
      }
      for (const field of nullableFields) {
        const pointer = `/${field}`;
        const entry = row.availability[pointer];
        if (row[field] === null && entry === undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `a null value at ${pointer} requires an availability entry`,
            path: ['sessions', i, 'availability'],
          });
        }
        if (row[field] !== null && entry !== undefined) {
          if (
            entry.state === 'not-collected' ||
            entry.state === 'unavailable' ||
            entry.state === 'n-a'
          ) {
            ctx.addIssue({
              code: 'custom',
              message: `a non-null value at ${pointer} cannot carry availability state '${entry.state}'`,
              path: ['sessions', i, 'availability', pointer],
            });
          }
        }
        if (row[field] === null && entry !== undefined) {
          if (
            entry.state === 'known' ||
            entry.state === 'known-zero' ||
            entry.state === 'partial'
          ) {
            ctx.addIssue({
              code: 'custom',
              message: `a null value at ${pointer} cannot carry availability state '${entry.state}'`,
              path: ['sessions', i, 'availability', pointer],
            });
          }
        }
      }
    });
  });

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

  // The stream is written under the correlation's workId directory; a
  // disagreement means the two artifacts are from different works — refuse
  // to join them rather than manufacturing a row from mismatched evidence.
  if (stream.workId !== correlation.record.workId) {
    throw new Error(
      `session-index: stream workId '${stream.workId}' does not match correlation ` +
        `workId '${correlation.record.workId}' — refusing to join mismatched evidence`,
    );
  }

  // Partial evidence is folded as partial, never silently as complete: the
  // artifact must carry the incompleteness so offline readers cannot mistake
  // a torn stream for full observation.
  const streamComplete = stream.complete === true;

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
  // Aggregate subtotals in ADR-0008 vocabulary: a plain numeric value with
  // an availability record at the field's pointer. Partial keeps the known
  // subtotal without claiming completeness; unknown stays null (never zero);
  // a genuinely observed zero over fully-known attempts is known-zero.
  function aggregateOf(field) {
    const known = attempts.filter((a) => a.payload[field] !== null);
    if (attempts.length === 0)
      return { value: null, state: 'n-a', reason: 'no attempts were recorded for this work' };
    if (known.length === 0) {
      return {
        value: null,
        state: 'not-collected',
        reason: `no attempt reported a ${field === 'tokens' ? 'token count' : 'wall time'}`,
      };
    }
    const subtotal = known.reduce((sum, a) => sum + a.payload[field], 0);
    if (known.length === attempts.length) {
      return {
        value: subtotal,
        state: subtotal === 0 ? 'known-zero' : 'known',
        reason:
          subtotal === 0
            ? `every attempt reported a known ${field === 'tokens' ? 'token count' : 'wall time'} and the observed sum is zero`
            : `every attempt reported a known ${field === 'tokens' ? 'token count' : 'wall time'}`,
      };
    }
    return {
      value: subtotal,
      state: 'partial',
      reason:
        `some attempts reported a known ${field === 'tokens' ? 'token count' : 'wall time'}; ` +
        'the value preserves the known subtotal without claiming a complete sum',
    };
  }
  const tokens = aggregateOf('tokens');
  const wallMs = aggregateOf('wallMs');

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
  // The repo join comes from the composition header provenance (the
  // archive-safe opaque remote digest). Two null cases stay distinct:
  // (a) header OBSERVED with repoId null — no remote exists
  //     (ADR-0008:223 "null/unavailable when no remote exists") → unavailable;
  // (b) header MISSING (torn stream lost the provenance) — never observed
  //     (ADR-0008:102) → not-collected.
  const header = stream.events.find((event) => event.type === 'composition-started');
  const provenanceObserved = header !== undefined;
  const provenanceRepo =
    provenanceObserved && header.payload.provenance.repoId !== undefined
      ? header.payload.provenance.repoId
      : null;

  if (!streamComplete) {
    // JSON Pointer root for the containing row is the empty string.
    availabilityEntries[''] = availability(
      'partial',
      'the observation stream is incomplete (torn final line or crash before close); ' +
        'this row folds partial evidence only',
    );
  }
  // Availability is written only where the state must be stated: unknown or
  // partial aggregates always; fully-known sums carry 'known'/'known-zero'
  // so a reader can distinguish a stated complete sum from an unstated one.
  availabilityEntries['/tokens'] = availability(tokens.state, tokens.reason);
  availabilityEntries['/wallMs'] = availability(wallMs.state, wallMs.reason);
  if (provenanceRepo === null) {
    availabilityEntries['/repo'] = availability(
      provenanceObserved ? 'unavailable' : 'not-collected',
      provenanceObserved
        ? 'the composition header was observed with repoId null: no remote exists for this repository'
        : 'the composition header was never observed (stream torn before it); no provenance exists',
    );
  }
  const row = {
    repo: provenanceRepo,
    sessionId: correlation.record.sessionId,
    workId: correlation.record.workId,
    parentWorkId: correlation.record.parentWorkId,
    branch: correlation.record.branch,
    commitSha,
    runId: stream.compositionRunId,
    agentId: correlation.record.agentId,
    model: models.length === 1 ? models[0] : null,
    attempts: attempts.length,
    tokens: tokens.value,
    wallMs: wallMs.value,
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
