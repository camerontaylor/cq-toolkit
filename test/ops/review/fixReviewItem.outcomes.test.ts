// Split provenance: test/ops/review/fixReviewItem.test.ts was split into the
// fixReviewItem.*.test.ts siblings in this directory; the shared fixtures live
// in fixReviewItem.helpers.ts and the original suite header sits there.
import { describe, expect, test } from 'vitest';
import { currentJobContext, runLadder } from '../../../src/kernel/governor.js';
import { makeFixReviewItem } from '../../../src/ops/review/fixReviewItem.js';
import {
  baseInput,
  completeWorker,
  expectOk,
  NO_CHANGE,
  scriptedFactory,
  scriptedOp,
  UNCHANGED,
} from './fixReviewItem.helpers.js';

// ---------------------------------------------------------------------------
// 5. Structured output parsing
// ---------------------------------------------------------------------------

describe('fixReviewItem structured output', () => {
  test('a one-line JSON STRING parses into the contract', async () => {
    const { op } = scriptedOp([completeWorker(JSON.stringify(UNCHANGED))]);
    const value = expectOk(await op(baseInput()));
    expect(value).toEqual({
      disposition: 'unchanged_with_reason',
      changed: false,
      summary: NO_CHANGE,
      commits: [],
      evidence: [{ path: 'src/a.ts', line: 3 }],
      denials: [],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
  });

  test.each([
    ['missing output', undefined],
    ['unparseable string', 'not json at all'],
    ['non-object JSON', '[1,2,3]'],
    ['wrong shape', { changed: 'yes', summary: NO_CHANGE, commits: [] }],
    ['extra key', { changed: true, summary: 's', commits: [], session: 'x' }],
    ['non-string commit sha', { changed: true, summary: 's', commits: [42] }],
    ['missing commits key', { changed: true, summary: 's' }],
    // The legacy changed↔commits tie, both directions (Codex P2).
    ['changed true with empty commits', { changed: true, summary: 's', commits: [] }],
    ['changed false with commits', { changed: false, summary: 's', commits: ['abc'] }],
  ])('%s → failed', async (_name, structuredOutput) => {
    const { op } = scriptedOp([completeWorker(structuredOutput)]);
    const result = await op(baseInput());
    expect(result.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 6. Stop-reason mapping
// ---------------------------------------------------------------------------

describe('fixReviewItem stop reasons', () => {
  test('budget → budget-exhausted', async () => {
    const { op } = scriptedOp([completeWorker(undefined, { stopReason: 'budget' })]);
    const result = await op(baseInput());
    expect(result).toEqual({ status: 'budget-exhausted' });
  });

  test('error → failed, with errorClass=<x> named in the text for humans (ADR-0002 §2.9)', async () => {
    const { op } = scriptedOp([
      completeWorker(undefined, {
        stopReason: 'error',
        errorClass: 'output-invalid',
        sessionId: 'sess-1',
        error: 'the reply was not valid JSON',
      }),
    ]);
    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('sess-1');
      expect(result.error).toContain('errorClass=output-invalid');
      expect(result.error).toContain('the reply was not valid JSON');
    }
  });

  test('error without a class → failed, no errorClass fragment', async () => {
    const { op } = scriptedOp([
      completeWorker(undefined, { stopReason: 'error', sessionId: 'sess-2' }),
    ]);
    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('sess-2');
      expect(result.error).not.toContain('errorClass=');
    }
  });

  test('aborted → indeterminate', async () => {
    const { op } = scriptedOp([completeWorker(undefined, { stopReason: 'aborted' })]);
    const result = await op(baseInput());
    expect(result.status).toBe('indeterminate');
  });

  test('a resolved driver that rejects on run → needs-human (no verdict on partial work; #186)', async () => {
    const scripted = scriptedFactory([]);
    const op = makeFixReviewItem({ drivers: scripted.drivers });
    const result = await op(baseInput());
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('driver could not dispatch the worker');
      expect(result.reason).toContain('no scripted result left');
    }
  });

  test('a factory.resolve() throw → needs-human (a pre-dispatch misconfiguration is the human’s to arrange)', async () => {
    const op = makeFixReviewItem({
      drivers: {
        resolve: () => {
          throw new Error('no lane binding for role fixer');
        },
      },
    });
    const result = await op(baseInput());
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('the fix worker could not dispatch');
      expect(result.reason).toContain('no lane binding for role fixer');
    }
  });

  test("the driver's usage + cost are reported to the job context in ONE fold (#185)", async () => {
    const usage = { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 };
    const { op } = scriptedOp([
      completeWorker(
        { changed: true, summary: 'fixed', commits: ['a'.repeat(40)] },
        { usage, costUSD: 0.07 },
      ),
    ]);
    const reported: Array<{ usage?: unknown; costUSD?: number }> = [];
    const outcome = await runLadder(
      () => op(baseInput()),
      {},
      { op: 'review.fixItem', jobKey: 'j1', attempt: 1 },
      { onResult: (result) => reported.push(result) },
    );
    expect(outcome.outcome).toBe('completed');
    // The mapped op returns its OWN value shape, so the governor's
    // WorkerResult fold would see nothing — the job-context report is the
    // spend evidence (usage and cost together, once).
    expect(reported).toEqual([{ usage, costUSD: 0.07 }]);
  });

  test('the worker session is reported to the job context and the correlation forwarded (session-log 1.3/1.5)', async () => {
    const { op, invocations } = scriptedOp([
      completeWorker(
        { changed: true, summary: 'fixed', commits: ['a'.repeat(40)] },
        { sessionId: 'store-1', nativeSessionId: 'native-1' },
      ),
    ]);
    const sessions: unknown[] = [];
    const outcome = await runLadder(
      () => op(baseInput()),
      {},
      {
        op: 'review.fixItem',
        jobKey: 'j1',
        attempt: 1,
        correlation: { workId: 'run:j1:1', runId: 'run', role: 'review.fixItem' },
      },
      { onSession: (link) => sessions.push(link) },
    );
    expect(outcome.outcome).toBe('completed');
    // The mapped value drops sessionId, so the job-context report is the link.
    expect(sessions).toEqual([
      { driver: 'ai-sdk', sessionId: 'store-1', nativeSessionId: 'native-1' },
    ]);
    expect(invocations[0]?.correlation).toEqual({
      workId: 'run:j1:1',
      runId: 'run',
      role: 'review.fixItem',
    });
  });

  test('a driver throw with the governed signal aborted → indeterminate (the ladder cancellation, #191 r2)', async () => {
    const scripted = scriptedFactory([]);
    const op = makeFixReviewItem({ drivers: scripted.drivers });
    const outcome = await runLadder(
      async () => {
        const signal = currentJobContext()?.signal;
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return op(baseInput());
      },
      { wallClockMs: 5, abortGraceMs: 60_000, killGraceMs: 60_000 },
      { op: 'review.fixItem', jobKey: 'fix-abort', attempt: 1 },
    );
    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome === 'completed') {
      // The throw happened AFTER the rung-1 signal aborted, so it is the
      // governed cancellation (I8) → indeterminate, NOT needs-human (which
      // would terminate the run as guard-human-intervened).
      expect(outcome.value.status).toBe('indeterminate');
      if (outcome.value.status === 'indeterminate') {
        expect(outcome.value.detail).toContain('driver crashed');
        expect(outcome.value.detail).toContain('no scripted result left');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. usage + denials passthrough
// ---------------------------------------------------------------------------

describe('fixReviewItem worker evidence passthrough', () => {
  test('usage (reasoning included) and denials ride the ok result verbatim', async () => {
    const denials = [{ tool: 'run', reason: 'denied by policy' }];
    const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 };
    const { op } = scriptedOp([
      completeWorker(
        { changed: true, summary: 's', commits: ['ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12'] },
        { denials, usage },
      ),
    ]);
    const value = expectOk(await op(baseInput()));
    expect(value.usage).toEqual(usage);
    expect(value.denials).toEqual(denials);
  });
});
