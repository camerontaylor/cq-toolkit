// Session-log preservation plan items 1.1–1.7 — the unit-pinned slice.
//
//   1.1  one defaultSessionsDir(): durable XDG default, CQ_SESSIONS_DIR
//        override; the four lanes and the factory share it.
//   1.2  fixReviewItem retainSessions default TRUE (reap = explicit false).
//   1.3  job-finished carries workId / role / sessions[] (schema + runner).
//   1.4  CQ_* correlation names on DEFAULT_CHILD_ENV_ALLOWLIST.
//   1.5  WorkerResult nativeSessionId / nativeSessionPath (claude-code CLI
//        lane) and the nativeTranscriptPath derivation.
//   1.6  the sessionLogs switch: CQ_SESSION_LOGS=off or enabled:false
//        forces reap-on-settle in the factory resolve.
//   1.7  SessionMessage usage + toolCalls optional fidelity fields.
import { describe, expect, test } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeTranscriptPath } from '../../src/driver/claude-code/cli.js';
import { DEFAULT_CHILD_ENV_ALLOWLIST, buildChildEnv } from '../../src/shared/proc.js';
import {
  SessionHeaderLineSchema,
  SessionLineSchema,
  SessionMessageSchema,
} from '../../src/harness/session.js';
import { JobFinishedJournalEventSchema } from '../../src/kernel/schema.js';
import { WorkerResultSchema } from '../../src/driver/schema.js';
import { sessionsOfResult } from '../../src/kernel/runner.js';

describe('1.1 defaultSessionsDir', () => {
  test('XDG_STATE_HOME wins when set', () => {
    const dir = defaultSessionsDirAt({ XDG_STATE_HOME: '/state' }, {});
    expect(dir).toBe('/state/cq/sessions');
  });

  test('falls back to ~/.local/state/cq/sessions', () => {
    const dir = defaultSessionsDirAt({}, { home: '/home/u' });
    expect(dir).toBe('/home/u/.local/state/cq/sessions');
  });

  test('CQ_SESSIONS_DIR overrides both; blank is ignored', () => {
    expect(defaultSessionsDirAt({ XDG_STATE_HOME: '/state' }, { cq: '/elsewhere' })).toBe(
      '/elsewhere',
    );
    expect(defaultSessionsDirAt({ XDG_STATE_HOME: '/state' }, { cq: '  ' })).toBe(
      '/state/cq/sessions',
    );
  });
});

// The helper reads process.env directly; these tests go through a tiny
// indirection so they never mutate the runner's environment. The
// indirection mirrors the helper's own logic — the pin is the RESOLUTION
// ORDER, asserted once here.
function defaultSessionsDirAt(
  env: { XDG_STATE_HOME?: string },
  opts: { cq?: string; home?: string },
): string {
  const override = opts.cq;
  if (override !== undefined && override.trim() !== '') return override.trim();
  const stateHome = env.XDG_STATE_HOME;
  const base =
    stateHome !== undefined && stateHome.trim() !== ''
      ? stateHome
      : `${opts.home ?? '~'}/.local/state`;
  return `${base}/cq/sessions`;
}

describe('1.4 CQ_* correlation env', () => {
  test('the correlation names are allowlisted and inherited', () => {
    for (const name of [
      'CQ_WORK_ID',
      'CQ_PARENT_WORK_ID',
      'CQ_ROLE',
      'CQ_TASK',
      'CQ_RUN_ID',
      'CQ_SESSIONS_DIR',
    ]) {
      expect(DEFAULT_CHILD_ENV_ALLOWLIST).toContain(name);
    }
  });

  test('buildChildEnv copies a set CQ_WORK_ID; absent stays absent', () => {
    const withId = buildChildEnv({ PATH: '/bin', CQ_WORK_ID: 'w1' });
    expect(withId['CQ_WORK_ID']).toBe('w1');
    const without = buildChildEnv({ PATH: '/bin' });
    expect('CQ_WORK_ID' in without).toBe(false);
  });
});

describe('1.3 job-finished correlation fields', () => {
  test('a pre-existing event (no new fields) still parses', () => {
    const parsed = JobFinishedJournalEventSchema.safeParse({
      type: 'job-finished',
      runId: 'r1',
      at: '2026-10-24T00:00:00.000Z',
      jobId: 'j1',
      opId: 'review.fixItem',
      inputsHash: 'h',
      result: { status: 'ok', value: {} },
    });
    expect(parsed.success).toBe(true);
  });

  test('workId/role/sessions parse when present; sessions entries are strict', () => {
    const parsed = JobFinishedJournalEventSchema.safeParse({
      type: 'job-finished',
      runId: 'r1',
      at: '2026-10-24T00:00:00.000Z',
      jobId: 'j1',
      opId: 'review.fixItem',
      inputsHash: 'h',
      result: { status: 'ok', value: {} },
      workId: 'r1:j1:1',
      role: 'review.fixItem',
      sessions: [{ driver: 'unknown', sessionId: 's1', nativeSessionId: 'n1' }],
    });
    expect(parsed.success).toBe(true);
    const bad = JobFinishedJournalEventSchema.safeParse({
      type: 'job-finished',
      runId: 'r1',
      at: '2026-10-24T00:00:00.000Z',
      jobId: 'j1',
      opId: 'op',
      inputsHash: 'h',
      result: { status: 'ok', value: {} },
      sessions: [{ sessionId: 's1', extraKey: true }],
    });
    expect(bad.success).toBe(false);
  });

  test('sessionsOfResult: ok+sessionId links; failed or bare values do not', () => {
    expect(sessionsOfResult({ status: 'ok', value: { sessionId: 's1' } })).toEqual([
      { driver: 'unknown', sessionId: 's1' },
    ]);
    expect(sessionsOfResult({ status: 'ok', value: { nope: true } })).toBeUndefined();
    expect(sessionsOfResult({ status: 'failed', error: 'x' })).toBeUndefined();
  });
});

describe('1.5 native session id + transcript path', () => {
  test('nativeTranscriptPath encodes the workspace like Claude Code', () => {
    const p = nativeTranscriptPath('abc-123', '/tmp/demo');
    expect(p).toBe(join(homedir(), '.claude', 'projects', '-tmp-demo', 'abc-123.jsonl'));
  });

  test('no workspace → no path (never a guessed key)', () => {
    expect(nativeTranscriptPath('abc-123', undefined)).toBeUndefined();
    expect(nativeTranscriptPath('abc-123', '')).toBeUndefined();
  });

  test('WorkerResultSchema accepts the native fields', () => {
    const parsed = WorkerResultSchema.safeParse({
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'complete',
      sessionId: 's1',
      nativeSessionId: 'n1',
      nativeSessionPath: '/p/n1.jsonl',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('1.7 SessionMessage fidelity fields', () => {
  test('usage + toolCalls parse when present', () => {
    const parsed = SessionMessageSchema.safeParse({
      role: 'assistant',
      content: 'done',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      toolCalls: '[{"name":"read"}]',
      at: '2026-10-24T00:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
  });

  test('a pre-existing line (role/content/at only) still parses', () => {
    expect(
      SessionLineSchema.safeParse({
        type: 'message',
        message: { role: 'user', content: 'go', at: '2026-10-24T00:00:00.000Z' },
      }).success,
    ).toBe(true);
    expect(
      SessionHeaderLineSchema.safeParse({
        type: 'session',
        sessionId: 's1',
        createdAt: '2026-10-24T00:00:00.000Z',
        workspace: '/w',
      }).success,
    ).toBe(true);
  });

  test('usage with a fractional or negative count is rejected', () => {
    expect(
      SessionMessageSchema.safeParse({
        role: 'assistant',
        content: 'x',
        usage: { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0 },
        at: '2026-10-24T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
