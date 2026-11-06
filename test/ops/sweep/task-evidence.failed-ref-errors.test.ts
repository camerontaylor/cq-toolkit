// Split provenance: test/ops/sweep/task-evidence.test.ts was split into
// task-evidence.{failed-refs,failed-ref-errors,ref-identity,m6a-trailers,m5b4-correlation,prompt-projection}.test.ts
// plus task-evidence.helpers.ts (shared fixtures). This file carries the git
// failure paths around failed-attempt commits.
import { expect, test } from 'vitest';
import { commitFailedAttempt } from '../../../src/ops/sweep/taskLoop.js';

test('failed-attempt tree failures stop before creating any refs', async () => {
  const calls: string[][] = [];
  await expect(
    commitFailedAttempt(
      async (args) => {
        calls.push(args);
        return '';
      },
      {
        runPrefix: 'run',
        kind: 'tests',
        slug: 'pkg',
        task: 'file.ts',
        parent: 'a'.repeat(40),
        firstAttempt: 1,
        tier: 'worker',
        model: { provider: 'fixture', model: 'scripted' },
        gate: 'none',
        outcome: 'unfixed',
        reason: 'failure',
        pushFailed: false,
      },
    ),
  ).rejects.toThrow('could not write failed-attempt tree');
  expect(calls).toEqual([['write-tree']]);
});

test('failed ref update errors propagate when verification cannot find a collision', async () => {
  const updateError = new Error('update-ref permission denied');
  const calls: string[][] = [];
  await expect(
    commitFailedAttempt(
      async (args) => {
        calls.push(args);
        if (args[0] === 'write-tree') return 'a'.repeat(40);
        if (args[0] === 'for-each-ref') return '';
        if (args.includes('commit-tree')) return 'b'.repeat(40);
        if (args[0] === 'update-ref') throw updateError;
        if (args[0] === 'rev-parse') throw new Error('branch does not exist');
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
      {
        runPrefix: 'run',
        kind: 'tests',
        slug: 'pkg',
        task: 'file.ts',
        parent: 'c'.repeat(40),
        firstAttempt: 1,
        tier: 'worker',
        model: { provider: 'fixture', model: 'scripted' },
        gate: 'related',
        outcome: 'unfixed',
        reason: 'related check rejected the edit',
        pushFailed: false,
      },
    ),
  ).rejects.toBe(updateError);
  expect(calls.map((args) => args[0])).toEqual([
    'write-tree',
    'for-each-ref',
    '-c',
    'update-ref',
    'rev-parse',
  ]);
});

test('a lost update-ref race with a matching identity consumes the next attempt number', async () => {
  const identity = Buffer.from(JSON.stringify(['tests', 'pkg', 'file.ts'])).toString('base64url');
  const calls: string[][] = [];
  let ref: string | undefined;
  let updateRefCalls = 0;
  let commitTreeCalls = 0;
  const result = await commitFailedAttempt(
    async (args) => {
      calls.push(args);
      if (args[0] === 'write-tree') return 'a'.repeat(40);
      if (args[0] === 'for-each-ref') return ref ?? '';
      if (args.includes('commit-tree')) {
        commitTreeCalls += 1;
        return (commitTreeCalls === 1 ? 'b' : 'd').repeat(40);
      }
      if (args[0] === 'update-ref') {
        updateRefCalls += 1;
        ref = args[1];
        // The concurrent writer wins this exact ref once; verification then
        // finds it and its matching identity advertises a1 as consumed.
        if (updateRefCalls === 1) throw new Error('update-ref rejected: ref moved');
        return '';
      }
      if (args[0] === 'rev-parse') return 'c'.repeat(40);
      if (args[0] === 'show') return `cq-failed(unfixed): file.ts\n\nCq-Ref-Identity: ${identity}`;
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    },
    {
      runPrefix: 'run',
      kind: 'tests',
      slug: 'pkg',
      task: 'file.ts',
      parent: 'c'.repeat(40),
      firstAttempt: 1,
      tier: 'worker',
      model: { provider: 'fixture', model: 'scripted' },
      gate: 'related',
      outcome: 'unfixed',
      reason: 'related check rejected the edit',
      pushFailed: false,
    },
  );
  expect(result.branch).toMatch(/\/a2$/);
  expect(result.sha).toBe('d'.repeat(40));
  expect(calls.map((args) => args[0])).toEqual([
    'write-tree',
    'for-each-ref',
    '-c',
    'update-ref',
    'rev-parse',
    'for-each-ref',
    'show',
    '-c',
    'update-ref',
  ]);
});
