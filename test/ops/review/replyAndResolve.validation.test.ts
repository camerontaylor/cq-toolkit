// Split provenance: test/ops/review/replyAndResolve.test.ts was split into
// subject files; this file carries pre-flight validation, which must fail
// before any I/O.
import { describe, expect, test } from 'vitest';
import { replyAndResolve } from '../../../src/ops/review/replyAndResolve.js';
import type { ReplyAndResolveOpts } from '../../../src/ops/review/replyAndResolve.js';
import {
  memLog,
  mkIssue,
  mkReply,
  mkResolve,
  NOW,
  pushRun,
  recordingGh,
  REPO,
  type GhCall,
} from './replyAndResolve.helpers.js';

// ---------------------------------------------------------------------------
// validation fails loud BEFORE any I/O
// ---------------------------------------------------------------------------

describe('pre-flight validation', () => {
  test.each([
    ['bad owner', { ...REPO, owner: '../evil' }, [mkReply('r1', 1201)]],
    ['bad repo', { ...REPO, repo: 'bad repo' }, [mkReply('r1', 1201)]],
    [
      'dot owner (dot segment into the request path)',
      { ...REPO, owner: '.' },
      [mkReply('r1', 1201)],
    ],
    [
      'dotdot repo (dot segment into the request path)',
      { ...REPO, repo: '..' },
      [mkReply('r1', 1201)],
    ],
    ['bad pr', { ...REPO, pr: 0 }, [mkReply('r1', 1201)]],
    ['empty actionId', REPO, [mkReply('', 1201)]],
    ['bad threadRootRestId', REPO, [mkReply('r1', 0)]],
    ['empty threadId', REPO, [mkResolve('s1', '')]],
    ['whitespace threadId', REPO, [mkResolve('s1', '   ')]],
    ['whitespace reply body', REPO, [mkReply('r1', 1201, '   ')]],
    ['empty issue-comment body', REPO, [mkIssue('i1', '')]],
  ])('%s throws before a single gh invocation or push', async (_label, optsPartial, actions) => {
    const calls: GhCall[] = [];
    const pushCalls: string[][] = [];
    const opts = {
      ...optsPartial,
      run: recordingGh(calls),
      push: { run: pushRun(pushCalls), args: ['push', 'origin', 'main'] },
      dispatchLog: memLog(),
      nowMs: NOW,
    } as ReplyAndResolveOpts;
    await expect(replyAndResolve(actions, opts)).rejects.toThrow(/replyAndResolve:/);
    expect(calls).toEqual([]);
    expect(pushCalls).toEqual([]);
  });
});
