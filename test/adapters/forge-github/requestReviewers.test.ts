import { expect, test } from 'vitest';
import { requestReviewers } from '../../../src/adapters/forge-github/requestReviewers.js';

test('clean-run re-request deduplicates identities and performs no empty request', async () => {
  const calls: string[][] = [];
  const input = {
    owner: 'octo',
    repo: 'widget',
    pr: 7,
    run: async (args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  await requestReviewers({ ...input, reviewers: [] });
  expect(calls).toEqual([]);
  await requestReviewers({ ...input, reviewers: ['alice', 'alice', 'bob'] });
  expect(calls).toEqual([
    [
      'api',
      '-X',
      'POST',
      'repos/octo/widget/pulls/7/requested_reviewers',
      '-f',
      'reviewers[]=alice',
      '-f',
      'reviewers[]=bob',
    ],
  ]);
});
test('unsafe identity and forge failures refuse instead of reporting a clean re-request', async () => {
  let calls = 0;
  const input = {
    owner: 'octo',
    repo: 'widget',
    pr: 7,
    reviewers: ['alice'],
    run: async () => {
      calls++;
      return { code: 1, stdout: '', stderr: 'refused' };
    },
  };
  for (const invalid of [
    { owner: '../escape' },
    { pr: 0 },
    { reviewers: ['-bot'] },
    { reviewers: ['x\nPOST'] },
    { reviewers: ['alice', 'reviewer[bot]'] },
  ])
    await expect(requestReviewers({ ...input, ...invalid })).rejects.toThrow('invalid');
  expect(calls).toBe(0);
  await expect(requestReviewers(input)).rejects.toThrow('re-request failed');
  expect(calls).toBe(1);
});
