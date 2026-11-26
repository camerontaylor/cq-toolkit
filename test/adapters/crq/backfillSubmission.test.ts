import { describe, expect, it } from 'vitest';
import {
  BackfillSubmissionRefused,
  backfillSubmissionProof,
  type BackfillSubmissionInput,
} from '../../../src/adapters/crq/backfillSubmission.js';
import { REVIEWER_FORMATS } from '../../../src/policy/crq/backfillVendorOutput.js';

const HEAD = 'a'.repeat(40);
const KNOWN = [...REVIEWER_FORMATS.keys()][0] as string;

function input(
  status: string,
  head: string,
  seen: string[][],
  version = KNOWN,
): BackfillSubmissionInput {
  const encode = (text: string) => ({ code: 0, stdout: new TextEncoder().encode(text) });
  return {
    runId: 'r',
    worktree: '/wt',
    cmd: ['coderabbit'],
    head: HEAD,
    base: 'b'.repeat(40),
    attemptId: 'attempt-1',
    env: {},
    version: () => Promise.resolve(version),
    runGit: (args) => {
      seen.push([...args]);
      return Promise.resolve(encode(args[0] === 'status' ? status : `${head}\n`)) as never;
    },
  };
}

describe('backfillSubmissionProof clean-head check', () => {
  it('lists untracked files regardless of a repo-local showUntrackedFiles=no', async () => {
    const seen: string[][] = [];
    await expect(backfillSubmissionProof(input('?? stray.txt\n', HEAD, seen))).rejects.toThrow(
      BackfillSubmissionRefused,
    );
    const status = seen.find((args) => args[0] === 'status');
    expect(status).toEqual(['status', '--porcelain', '--untracked-files=all']);
  });

  it('refuses a head that is not the pinned one', async () => {
    await expect(backfillSubmissionProof(input('', 'c'.repeat(40), []))).rejects.toThrow(
      'clean pinned head',
    );
  });

  it('refuses an unknown reviewer version before touching git', async () => {
    const seen: string[][] = [];
    await expect(backfillSubmissionProof(input('', HEAD, seen, '0.0.0-unknown'))).rejects.toThrow(
      'unknown CodeRabbit version',
    );
    expect(seen).toEqual([]);
  });
});
