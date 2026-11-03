// Split provenance: test/ops/review/replyAndResolve.test.ts was split into
// subject files; this file carries the non-conforming gh outcome cases.
import { describe, expect, test } from 'vitest';
import { replyAndResolve } from '../../../src/ops/review/replyAndResolve.js';
import type { GhFn } from '../../../src/adapters/forge-github/gh.js';
import {
  baseOpts,
  memLog,
  mkIssue,
  mkReply,
  mkResolve,
  NOW,
  recordingGh,
  type GhCall,
} from './replyAndResolve.helpers.js';

// ---------------------------------------------------------------------------
// outcome-parsing gaps — every non-conforming gh outcome is isolated+unrecorded
// ---------------------------------------------------------------------------

describe('non-conforming gh outcomes', () => {
  test('a resolve printing NON-JSON stdout lands in failed and is NOT recorded (outcome unknown → retry)', async () => {
    const calls: GhCall[] = [];
    const log = memLog();
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkResolve('s1', 'PRRT_1')],
      baseOpts(
        recordingGh(calls, undefined, (label) =>
          label === 'resolve:PRRT_1'
            ? { code: 0, stdout: 'gh: rendered an error page, not JSON', stderr: '' }
            : undefined,
        ),
        log,
      ),
    );
    // The reply sibling was unaffected.
    expect(result.posted.map((r) => r.actionId)).toEqual(['r1']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.action.actionId).toBe('s1');
    expect(result.failed[0]?.error).toContain('non-JSON');
    // NOT recorded — the next run retries it (recording an unknown outcome
    // could swallow a mutation that never landed).
    expect(await log.load()).toEqual([
      { actionId: 'r1', kind: 'review_reply', resultRef: '8001', at: NOW },
    ]);
  });

  test.each([
    ['an EMPTY response object', {}],
    ['a null data payload', { data: null }],
    [
      'an isResolved:false thread',
      { data: { resolveReviewThread: { thread: { id: 'PRRT_1', isResolved: false } } } },
    ],
    ['a response with no thread', { data: { resolveReviewThread: {} } }],
  ])(
    'a resolve confirmed by NOTHING (%s) → failed with "resolve mutation did not land", unrecorded',
    async (_label, stdoutBody) => {
      const calls: GhCall[] = [];
      const log = memLog();
      const result = await replyAndResolve(
        [mkReply('r1', 1201), mkResolve('s1', 'PRRT_1')],
        baseOpts(
          recordingGh(calls, undefined, (label) =>
            label === 'resolve:PRRT_1'
              ? { code: 0, stdout: JSON.stringify(stdoutBody), stderr: '' }
              : undefined,
          ),
          log,
        ),
      );
      // Exit 0 + no errors is not proof: the response must CONFIRM the
      // resolve. The reply sibling was unaffected.
      expect(result.posted.map((r) => r.actionId)).toEqual(['r1']);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.action.actionId).toBe('s1');
      expect(result.failed[0]?.error).toContain('resolve mutation did not land');
      // NOT recorded — the next run retries it.
      expect(await log.load()).toEqual([
        { actionId: 'r1', kind: 'review_reply', resultRef: '8001', at: NOW },
      ]);
    },
  );

  test('a resolve the response CONFIRMS (isResolved true) is recorded exactly like a landed success', async () => {
    const calls: GhCall[] = [];
    const log = memLog();
    const result = await replyAndResolve(
      [mkResolve('s1', 'PRRT_1')],
      baseOpts(
        recordingGh(calls, undefined, (label) =>
          label === 'resolve:PRRT_1'
            ? {
                code: 0,
                stdout: JSON.stringify({
                  data: { resolveReviewThread: { thread: { id: 'PRRT_1', isResolved: true } } },
                }),
                stderr: '',
              }
            : undefined,
        ),
        log,
      ),
    );
    expect(result.failed).toEqual([]);
    expect(result.posted).toEqual([
      { actionId: 's1', kind: 'resolve_thread', resultRef: 'PRRT_1', at: NOW },
    ]);
    expect(await log.load()).toEqual([
      { actionId: 's1', kind: 'resolve_thread', resultRef: 'PRRT_1', at: NOW },
    ]);
  });

  test('a THROWN main-run gh seam failure fails just that action with the throw message — siblings proceed', async () => {
    const calls: GhCall[] = [];
    const base = recordingGh(calls);
    const log = memLog();
    const throwingRun: GhFn = async (args) => {
      if (args.some((a) => a.includes('in_reply_to=1202'))) {
        throw new Error('spawn gh ENOMEM');
      }
      return base(args);
    };
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkReply('rmid', 1202), mkIssue('i1')],
      baseOpts(throwingRun, log),
    );
    expect(result.pushed).toBe(true);
    // The thrown seam failure became that ONE action's failure, message
    // carrying the throw string; siblings ran and were recorded.
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.action.actionId).toBe('rmid');
    expect(result.failed[0]?.error).toContain('spawn gh ENOMEM');
    expect(result.posted.map((r) => r.actionId)).toEqual(['r1', 'i1']);
    // The throwing invocation never even reached the recorder — the seam
    // threw before delegating — but the SIBLINGS all ran, in order.
    expect(calls.map((c) => c.label)).toEqual(['reply:1201', 'issue-comment']);
    expect((await log.load()).map((r) => r.actionId)).toEqual(['r1', 'i1']);
  });

  test("a success whose body cannot be mined records resultRef 'unknown' — recording is never blocked by an unparseable body", async () => {
    const calls: GhCall[] = [];
    const log = memLog();
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkIssue('i1')],
      baseOpts(
        recordingGh(calls, undefined, (label) => {
          if (label === 'reply:1201')
            return { code: 0, stdout: '<html>gateway garbage</html>', stderr: '' };
          if (label === 'issue-comment')
            return { code: 0, stdout: JSON.stringify({ id: 'not-a-number' }), stderr: '' };
          return undefined;
        }),
        log,
      ),
    );
    // Both posts SUCCEEDED (exit 0): recorded with the best-effort ref.
    expect(result.failed).toEqual([]);
    expect(result.posted.map((r) => r.resultRef)).toEqual(['unknown', 'unknown']);
    expect((await log.load()).map((r) => r.resultRef)).toEqual(['unknown', 'unknown']);
  });
});
