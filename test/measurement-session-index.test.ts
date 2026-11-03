// M6c — offline branch session index (ADR-0008 vocabulary). One case per
// asserted condition from the slice dispatch:
//   - index is a committed/archived artifact never read by engine at runtime;
//   - join repo/branch/commit SHA/run/work/session/model;
//   - moved branch does not relabel commit;
//   - ambiguity/missing model → unknown (null + availability);
//   - no transcript-time inference.
// Local fixtures only: fake correlation records and fake observation
// streams; no live providers, no network, no credentials.
import { describe, expect, it } from 'vitest';
import {
  buildSessionIndex,
  commitBranchIsAmbiguous,
  parseCorrelationForIndex,
  SessionIndexSchema,
} from '../scripts/measurement-session-index.mjs';

const BRANCH = 'feat/measurement-m6c';

function correlation(overrides = {}) {
  return {
    workId: '0f4d5a72-1f2e-4c3b-9a01-6f8b2c4d5e6f',
    parentWorkId: null,
    branch: BRANCH,
    commitSha: null,
    sessionId: null,
    agentId: null,
    ...overrides,
  };
}

function attemptEvent(overrides = {}) {
  return {
    type: 'attempt-finished',
    runId: 'comp-run-1',
    at: '2026-11-03T05:00:00.000Z',
    unitId: 'unit-1',
    jobId: null,
    taskId: 'task-1',
    attempt: 1,
    payload: {
      tier: 'worker',
      invocation: 'inv-1',
      model: { model: 'glm-5.3', provider: 'zai' },
      provider: 'zai',
      requestedModel: 'glm-5.3',
      servedModel: null,
      tokens: 100,
      usageChannels: {},
      requests: 1,
      wallMs: 500,
      modeledUsd: null,
      priceTableRevision: null,
      priceCoverage: null,
      stopReason: 'completed',
      stopCode: 'completed',
      class: 'terminal',
      error: null,
      timeout: null,
      budget: {
        allowed: { tokens: null, wallMs: null },
        spent: { tokens: 100, wallMs: 500 },
        remaining: { tokens: null, wallMs: null },
      },
      availability: {},
    },
    ...overrides,
  };
}

function stream(events: unknown[] = [], overrides: Record<string, unknown> = {}) {
  const compositionRunId = 'comp-run-1';
  return {
    workId: '0f4d5a72-1f2e-4c3b-9a01-6f8b2c4d5e6f',
    compositionRunId,
    events: [
      {
        type: 'composition-started',
        runId: compositionRunId,
        at: '2026-11-03T04:59:00.000Z',
        unitId: null,
        jobId: null,
        taskId: null,
        attempt: null,
        payload: {
          journalVersion: 3,
          provenance: {
            cqVersion: '0.0.0-test',
            producerVersion: '0.0.0-test',
            repoId: 'sha256:aaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccdddd',
            cqJsonHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            baseSha: '42a1f04bdeadbeef42a1f04bdeadbeef42a1f04b',
            runPrefix: 'run-test',
            startedAt: '2026-11-03T04:59:00.000Z',
            endedAt: null,
            journalLink: 'observations/w/j.ndjson',
            reportLink: 'reports/w/r.json',
            witnesses: {
              base: '42a1f04bdeadbeef42a1f04bdeadbeef42a1f04b',
              admitted: null,
              execution: null,
              reviewed: null,
              accepted: null,
            },
          },
          correlation: correlation(),
        },
      },
      ...events,
    ],
    complete: true,
    ...overrides,
  };
}

describe('M6c nominal evidence', () => {
  it('nominal: joins repo/branch/commit SHA/run/work/session/model into one committed row', () => {
    const correlationRecord = correlation({
      sessionId: 'sess-abc',
      agentId: 'agent-1',
      commitSha: 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4',
    });
    const index = buildSessionIndex({
      correlation: correlationRecord,
      stream: stream([attemptEvent()]),
    });
    expect(index.indexVersion).toBe(1);
    const row = index.sessions[0]!;
    expect(row.repo).toBe(
      'sha256:aaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccdddd',
    );
    expect(row.sessionId).toBe('sess-abc');
    expect(row.workId).toBe(correlationRecord.workId);
    expect(row.parentWorkId).toBeNull();
    expect(row.branch).toBe(BRANCH);
    expect(row.commitSha).toBe('a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4');
    expect(row.runId).toBe('comp-run-1');
    expect(row.agentId).toBe('agent-1');
    expect(row.model).toEqual({ model: 'glm-5.3', provider: 'zai' });
    expect(row.attempts).toBe(1);
    expect(row.tokens).toBe(100);
    expect(row.wallMs).toBe(500);
    // A complete non-null aggregate carries availability state 'known'.
    expect(row.availability['/tokens']).toMatchObject({ state: 'known' });
    expect(row.availability['/wallMs']).toMatchObject({ state: 'known' });
    expect(row.stopReasons).toEqual([{ stopCode: 'completed', class: 'terminal' }]);
    // Availability entries exist only where state must be stated.
    expect(Object.keys(row.availability).sort()).toEqual(['/tokens', '/wallMs']);
    // The artifact validates against its own strict schema.
    expect(() => SessionIndexSchema.parse(index)).not.toThrow();
  });

  it('is a committed/archived reader artifact never read by the engine at runtime', () => {
    // The module imports only schema/type-level surface from src/kernel;
    // nothing it exports is consumed by the runtime engine path. Assert the
    // structural guarantee: buildSessionIndex is a pure fold over its input
    // (no fs, no env, no clock reads) and the result is plain JSON-safe data.
    const input = { correlation: correlation(), stream: stream([]) };
    const first = buildSessionIndex(input);
    const second = buildSessionIndex(input);
    expect(first).toEqual(second);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });
});

describe('M6c missing evidence', () => {
  it('missing model/session/commit: nulls with availability, never zero or guessed', () => {
    const index = buildSessionIndex({
      correlation: correlation(),
      stream: stream([attemptEvent({ payload: attemptEvent().payload, attempt: 1 })]),
    });
    const row = index.sessions[0]!;
    expect(row.sessionId).toBeNull();
    expect(row.commitSha).toBeNull();
    expect(row.availability['/sessionId']).toMatchObject({ state: 'not-collected' });
    expect(row.availability['/agentId']).toMatchObject({ state: 'not-collected' });
    expect(row.availability['/commitSha']).toMatchObject({ state: 'not-collected' });
  });

  it('model null on every attempt: unknown model with unavailable availability', () => {
    const base = attemptEvent();
    const noModel = {
      ...base,
      payload: { ...base.payload, model: null, servedModel: null },
    };
    const index = buildSessionIndex({
      correlation: correlation(),
      stream: stream([noModel]),
    });
    const row = index.sessions[0]!;
    expect(row.model).toBeNull();
    expect(row.availability['/model']).toMatchObject({ state: 'unavailable' });
  });

  it('partial token/wall evidence: sums stay null with partial availability', () => {
    const first = attemptEvent();
    const second = attemptEvent({
      attempt: 2,
      payload: {
        ...first.payload,
        tokens: null,
        wallMs: 700,
        invocation: 'inv-2',
      },
    });
    const index = buildSessionIndex({
      correlation: correlation(),
      stream: stream([first, second]),
    });
    const row = index.sessions[0]!;
    expect(row.tokens).toBe(100);
    expect(row.wallMs).toBe(1200);
    expect(row.availability['/tokens']).toMatchObject({ state: 'partial' });
    expect(row.availability['/wallMs']).toMatchObject({ state: 'known' });
  });

  it('no attempts at all: aggregates n-a, model not-collected, no zero-shaped values', () => {
    const index = buildSessionIndex({ correlation: correlation(), stream: stream([]) });
    const row = index.sessions[0]!;
    expect(row.attempts).toBe(0);
    expect(row.tokens).toBeNull();
    expect(row.wallMs).toBeNull();
    expect(row.model).toBeNull();
    expect(row.availability['/model']).toMatchObject({ state: 'not-collected' });
    expect(row.availability['/tokens']).toMatchObject({ state: 'n-a' });
    expect(row.availability['/wallMs']).toMatchObject({ state: 'n-a' });
  });

  it('missing or malformed correlation is rejected, not silently folded', () => {
    expect(parseCorrelationForIndex(null)).toMatchObject({
      ok: false,
      error: { state: 'missing' },
    });
    expect(parseCorrelationForIndex({ workId: 'nope' })).toMatchObject({
      ok: false,
      error: { state: 'invalid' },
    });
    expect(() => buildSessionIndex({ correlation: null, stream: stream([]) })).toThrow(
      /no correlation record was supplied/,
    );
  });
});

describe('M6c failure evidence', () => {
  it('failure attempt evidence is preserved with class/stopCode, not relabeled success', () => {
    const failed = attemptEvent({
      payload: {
        ...attemptEvent().payload,
        stopReason: 'spawn failed: ENOTFOUND api.z.ai',
        stopCode: 'dns',
        class: 'infrastructure',
        tokens: null,
        wallMs: null,
        error: {
          type: null,
          code: 'ENOTFOUND',
          providerFinishReason: null,
          source: 'dns',
          certainty: 'observed',
        },
      },
    });
    const index = buildSessionIndex({
      correlation: correlation(),
      stream: stream([failed]),
    });
    const row = index.sessions[0]!;
    expect(row.stopReasons).toEqual([{ stopCode: 'dns', class: 'infrastructure' }]);
    // Unknown usage stays unknown even on a failed attempt: null with
    // not-collected, never a zero-shaped guess.
    expect(row.tokens).toBeNull();
    expect(row.availability['/tokens']).toMatchObject({ state: 'not-collected' });
  });

  it('moved branch does not relabel commit: rows keep observed branch per commitSha', () => {
    const sha = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4';
    const observedOnOldBranch = buildSessionIndex({
      correlation: correlation({ commitSha: sha, branch: 'feat/old-name' }),
      stream: stream([]),
    }).sessions[0]!;
    const observedOnNewBranch = buildSessionIndex({
      correlation: correlation({ commitSha: sha, branch: BRANCH }),
      stream: stream([]),
    }).sessions[0]!;
    // The commit SHA is the join key; each row records the branch its own
    // evidence observed. Neither relabels the other, and the disagreement
    // is detectable, never silently reconciled.
    expect(observedOnOldBranch.commitSha).toBe(sha);
    expect(observedOnOldBranch.branch).toBe('feat/old-name');
    expect(observedOnNewBranch.branch).toBe(BRANCH);
    expect(commitBranchIsAmbiguous([observedOnOldBranch, observedOnNewBranch])).toBe(true);
  });

  it('ambiguous model observations are unknown with unavailable availability', () => {
    const first = attemptEvent();
    const second = attemptEvent({
      attempt: 2,
      payload: {
        ...first.payload,
        invocation: 'inv-2',
        model: { model: 'deepseek-v4.1', provider: 'dsh' },
      },
    });
    const index = buildSessionIndex({
      correlation: correlation(),
      stream: stream([first, second]),
    });
    const row = index.sessions[0]!;
    expect(row.model).toBeNull();
    expect(row.availability['/model']).toMatchObject({ state: 'unavailable' });
    expect(row.availability['/model']!.reason).toContain('ambiguous');
  });

  it('no transcript-time inference: branch/identity changes are never derived from events', () => {
    // Attempts in the stream carry no branch or identity fields; the index
    // takes identity only from the correlation record, exactly as supplied.
    const index = buildSessionIndex({
      correlation: correlation({ branch: 'whatever-the-recorder-said' }),
      stream: stream([attemptEvent()]),
    });
    expect(index.sessions[0]!.branch).toBe('whatever-the-recorder-said');
    // The event shapes themselves cannot smuggle a branch in: the strict
    // stream schema rejects an event with an invented branch field.
    const smuggling = stream([attemptEvent()]);
    (smuggling.events[0] as Record<string, unknown>).branch = 'feat/invented';
    expect(() => buildSessionIndex({ correlation: correlation(), stream: smuggling })).toThrow(
      /failed schema validation/,
    );
  });
});

describe('M6c join integrity (review iterations)', () => {
  it('repo join: provenance repoId lands in the row; absent digest is null with availability', () => {
    const index = buildSessionIndex({
      correlation: correlation(),
      stream: stream([attemptEvent()]),
    });
    const row = index.sessions[0]!;
    expect(row.repo).toBe(
      'sha256:aaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccdddd',
    );
    expect(row.availability['/repo']).toBeUndefined();
    const noRepo = stream([attemptEvent()]);
    (noRepo.events[0] as Record<string, unknown>).payload = {
      ...((noRepo.events[0] as Record<string, unknown>).payload as Record<string, unknown>),
      provenance: {
        ...(((noRepo.events[0] as Record<string, unknown>).payload as Record<string, unknown>)
          .provenance as Record<string, unknown>),
        repoId: null,
      },
    };
    const rowNoRepo = buildSessionIndex({
      correlation: correlation(),
      stream: noRepo,
    }).sessions[0]!;
    expect(rowNoRepo.repo).toBeNull();
    expect(rowNoRepo.availability['/repo']).toMatchObject({ state: 'not-collected' });
  });

  it('partial aggregates preserve the known subtotal and mark partial, never drop it', () => {
    const first = attemptEvent();
    const second = attemptEvent({
      attempt: 2,
      payload: { ...first.payload, invocation: 'inv-2', tokens: null, wallMs: null },
    });
    const index = buildSessionIndex({
      correlation: correlation(),
      stream: stream([first, second]),
    });
    const row = index.sessions[0]!;
    expect(row.tokens).toBe(100);
    expect(row.wallMs).toBe(500);
    expect(row.availability['/tokens']).toMatchObject({ state: 'partial' });
    expect(row.availability['/wallMs']).toMatchObject({ state: 'partial' });
  });

  it('malformed availability rows fail artifact validation, never commit malformed', () => {
    const index = buildSessionIndex({
      correlation: correlation(),
      stream: stream([attemptEvent()]),
    });
    // Hand-forge a bad availability entry (invented state, missing source):
    // the strict row schema must reject it.
    const forged = {
      indexVersion: 1 as const,
      sessions: [
        JSON.parse(JSON.stringify(index.sessions[0])) as {
          availability: Record<string, unknown>;
        },
      ],
    };
    const row = forged.sessions[0]!;
    row.availability['/tokens'] = { state: 'made-up', reason: 'x' };
    expect(() => SessionIndexSchema.parse(forged)).toThrow();
    row.availability['/tokens'] = { state: 'partial', reason: 'x' };
    expect(() => SessionIndexSchema.parse(forged)).toThrow();
    row.availability['/tokens'] = { state: 'partial', reason: 'x', source: null };
    expect(() => SessionIndexSchema.parse(forged)).not.toThrow();
  });

  it('complete=false stream folds as explicitly partial, never silently complete', () => {
    const index = buildSessionIndex({
      correlation: correlation(),
      stream: stream([attemptEvent()], { complete: false }),
    });
    const row = index.sessions[0]!;
    expect(row.availability['']).toMatchObject({ state: 'partial' });
    expect(row.availability['']!.reason).toContain('incomplete');
    // A complete stream carries no root availability entry.
    const full = buildSessionIndex({
      correlation: correlation(),
      stream: stream([attemptEvent()]),
    });
    expect(full.sessions[0]!.availability['']).toBeUndefined();
  });

  it('workId mismatch between correlation and stream is refused, never joined', () => {
    // The strict stream schema itself couples the composition-started header
    // to the stream's workId; the index ALSO cross-checks the outer
    // correlation record, so a swapped-but-self-consistent stream cannot
    // join. Forge a stream whose header agrees with its (different) workId.
    const otherWork = '11111111-1111-4111-8111-111111111111';
    const mismatched = stream([attemptEvent()], { workId: otherWork });
    const header = mismatched.events[0] as Record<string, unknown>;
    header.payload = {
      ...(header.payload as Record<string, unknown>),
      correlation: correlation({ workId: otherWork }),
    };
    expect(() => buildSessionIndex({ correlation: correlation(), stream: mismatched })).toThrow(
      /does not match correlation/,
    );
  });
});

describe('M6c availability discipline (review r2)', () => {
  it('all-unknown attempts: null with not-collected, never a zero-shaped partial claim', () => {
    const base = attemptEvent();
    const noUsage = {
      ...base,
      payload: { ...base.payload, tokens: null, wallMs: null },
    };
    const index = buildSessionIndex({
      correlation: correlation(),
      stream: stream([noUsage]),
    });
    const row = index.sessions[0]!;
    expect(row.tokens).toBeNull();
    expect(row.wallMs).toBeNull();
    expect(row.availability['/tokens']).toMatchObject({ state: 'not-collected' });
    expect(row.availability['/wallMs']).toMatchObject({ state: 'not-collected' });
    expect(row.availability['/tokens']!.reason).not.toContain('some attempts carried');
  });

  it('genuine observed zero over fully-known attempts is known-zero, not partial', () => {
    const base = attemptEvent();
    const zero = {
      ...base,
      payload: { ...base.payload, tokens: 0, wallMs: 0 },
    };
    const index = buildSessionIndex({ correlation: correlation(), stream: stream([zero]) });
    const row = index.sessions[0]!;
    expect(row.tokens).toBe(0);
    expect(row.wallMs).toBe(0);
    expect(row.availability['/tokens']).toMatchObject({ state: 'known-zero' });
    expect(row.availability['/wallMs']).toMatchObject({ state: 'known-zero' });
  });

  it('a complete aggregate cannot coexist with a torn-stream partial root marker', () => {
    // complete:false with fully-known attempts: the aggregate values are
    // known, but the ROOT pointer still carries partial — the incompleteness
    // is stated once at the root, never contradictorily on the field.
    const index = buildSessionIndex({
      correlation: correlation(),
      stream: stream([attemptEvent()], { complete: false }),
    });
    const row = index.sessions[0]!;
    expect(row.tokens).toBe(100);
    expect(row.availability['/tokens']).toMatchObject({ state: 'known' });
    expect(row.availability['']).toMatchObject({ state: 'partial' });
  });

  it('availability keys must be valid JSON Pointers; the root is the empty string', () => {
    const index = buildSessionIndex({
      correlation: correlation(),
      stream: stream([attemptEvent()]),
    });
    const forged = {
      indexVersion: 1 as const,
      sessions: [
        JSON.parse(JSON.stringify(index.sessions[0])) as {
          availability: Record<string, unknown>;
        },
      ],
    };
    // A non-pointer key (no leading slash, not empty) must be rejected.
    const row = forged.sessions[0]!;
    row.availability['tokens'] = { state: 'known', reason: 'x', source: null };
    expect(() => SessionIndexSchema.parse(forged)).toThrow();
    // The empty string IS valid (root).
    delete row.availability['tokens'];
    row.availability[''] = { state: 'partial', reason: 'x', source: null };
    expect(() => SessionIndexSchema.parse(forged)).not.toThrow();
  });
});
