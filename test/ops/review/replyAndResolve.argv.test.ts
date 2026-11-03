// Split provenance: test/ops/review/replyAndResolve.test.ts was split into
// subject files; this file carries the gh argv shapes and the GraphQL
// variable-collision rule.
import { describe, expect, test } from 'vitest';
import { replyAndResolve } from '../../../src/ops/review/replyAndResolve.js';
import {
  baseOpts,
  flagValue,
  memLog,
  mkIssue,
  mkReply,
  mkResolve,
  recordingGh,
  type GhCall,
} from './replyAndResolve.helpers.js';

// ---------------------------------------------------------------------------
// argv shapes + the GraphQL collision rule
// ---------------------------------------------------------------------------

describe('argv shapes', () => {
  test('reply POSTs to pulls comments with -F in_reply_to and -f body; issue comment POSTs to the issues collection', async () => {
    const calls: GhCall[] = [];
    await replyAndResolve(
      [mkReply('r1', 1201, 'the fix landed in abc123'), mkIssue('i1', 'all threads addressed')],
      baseOpts(recordingGh(calls), memLog()),
    );
    expect(calls[0]?.args).toEqual([
      'api',
      '-X',
      'POST',
      'repos/octo/widget/pulls/7/comments',
      '-F',
      'in_reply_to=1201',
      '-f',
      'body=the fix landed in abc123',
    ]);
    expect(calls[1]?.args).toEqual([
      'api',
      '-X',
      'POST',
      'repos/octo/widget/issues/7/comments',
      '-f',
      'body=all threads addressed',
    ]);
  });

  test('the resolve mutation rides `-f query=` with NO GraphQL variable named `query` (the collision rule) and `-f threadId=`', async () => {
    const calls: GhCall[] = [];
    await replyAndResolve([mkResolve('s1', 'PRRT_1')], baseOpts(recordingGh(calls), memLog()));
    expect(calls).toHaveLength(1);
    const args = calls[0]?.args ?? [];
    expect(args[0]).toBe('api');
    expect(args[1]).toBe('graphql');
    // Every value rides a raw `-f` — no `-F` coercion anywhere.
    expect(args.some((a) => a === '-F')).toBe(false);
    const doc = flagValue(args, 'query');
    expect(doc).toContain('mutation ($threadId: ID!)');
    expect(doc).toContain('resolveReviewThread');
    // THE COLLISION RULE: the document must not declare a variable named
    // `query` — it rides the `-f query=` slot itself.
    expect(doc).not.toMatch(/\$query\b/);
    expect(flagValue(args, 'threadId')).toBe('PRRT_1');
    // Both flag values are preceded by the raw-string flag.
    for (let i = 0; i < args.length; i++) {
      if (/^(query|threadId)=/.test(args[i] ?? '')) {
        expect(args[i - 1]).toBe('-f');
      }
    }
  });
});
