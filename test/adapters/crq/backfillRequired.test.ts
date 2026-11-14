import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { GitAccountingRepository } from '../../../src/adapters/crq/backfillAccounting.js';
import { collectRequired } from '../../../src/adapters/crq/backfillRequired.js';
import { runGitIn } from '../../../src/adapters/crq/publishSource.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'required-pr-'));
  roots.push(root);
  const runGit = runGitIn(root);
  const git = async (...args: string[]) => {
    const result = await runGit(args);
    if (result.code !== 0) throw new Error(result.stderr);
    return Buffer.from(result.stdout).toString('utf8').trim();
  };
  await git('init', '-q');
  await git('config', 'user.name', 'test');
  await git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, 'removed-in-merge'), 'before\n');
  await writeFile(join(root, 'kept'), 'old\n');
  await git('add', '.');
  await git('commit', '-qm', 'base');
  await rm(join(root, 'removed-in-merge'));
  await writeFile(join(root, 'kept'), 'new\n');
  await writeFile(join(root, 'removed-after'), 'deleted later\n');
  await git('add', '-A');
  await git('commit', '-qm', 'merge');
  const merge = await git('rev-parse', 'HEAD');
  await rm(join(root, 'removed-after'));
  await git('mv', 'kept', 'renamed');
  await git('add', '-A');
  await git('commit', '-qm', 'later');
  const target = await git('rev-parse', 'HEAD');
  const repo = new GitAccountingRepository({ repo: root, runGit });
  repo.beginInvocation();
  return { root, git, merge, target, runGit, repo };
}

describe('required PR acquisition', () => {
  test('captures bytes and maps renamed and deleted paths, including merge deletions', async () => {
    const f = await fixture();
    const raw = Buffer.from(
      JSON.stringify({
        number: 7,
        merged: true,
        merge_commit_sha: f.merge,
        title: 'untrusted title',
        body: 'untrusted body',
      }),
    );
    const stored: Uint8Array[] = [];
    const reference = { sha256: 'a'.repeat(64), location: '/durable/a' };
    const result = await collectRequired({
      ...f,
      required: { rows: [{ pr: 7 }] },
      artifacts: {
        put: async (bytes) => {
          stored.push(bytes);
          return reference;
        },
      },
      fetchPr: async () => raw,
    });
    expect(stored).toEqual([raw]);
    expect(result.requiredPaths['7']).toEqual([
      { path: 'renamed', source_path: 'kept', source_evidence: reference },
      {
        path: 'removed-after',
        disposition: 'deleted',
        deletion_evidence: { target: f.target, merge: f.merge, source: reference },
      },
      {
        path: 'removed-in-merge',
        disposition: 'deleted',
        deletion_evidence: { target: f.target, merge: f.merge, source: reference },
      },
    ]);
    expect(result.members['7']).toEqual({
      merge: f.merge,
      pr: 7,
      paths: [{ path: 'renamed', source_path: 'kept', lineage_verified: true }],
      context: { trust: 'untrusted-data-only', title: 'untrusted title', body: 'untrusted body' },
    });
  });

  test('retains bad forge bytes before rejecting mismatched identity or malformed JSON', async () => {
    const f = await fixture();
    for (const raw of [
      Buffer.from('{'),
      Buffer.from(JSON.stringify({ number: 8, merged: true })),
    ]) {
      const stored: Uint8Array[] = [];
      await expect(
        collectRequired({
          ...f,
          required: { rows: [{ pr: 7 }] },
          artifacts: {
            put: async (bytes) => {
              stored.push(bytes);
              return { sha256: 'a', location: '/a' };
            },
          },
          fetchPr: async () => raw,
        }),
      ).rejects.toThrow();
      expect(stored).toEqual([raw]);
    }
  });

  test('preserves ambiguous evidence and refuses an unmerged response', async () => {
    const f = await fixture();
    const target = await f.git('rev-parse', `${f.merge}^1`);
    const reference = { sha256: 'b'.repeat(64), location: '/durable/b' };
    const artifacts = { put: async () => reference };
    const response = {
      number: 7,
      merged: true,
      merge_commit_sha: f.merge,
      title: null,
      body: null,
    };
    const fetchPr = async () => Buffer.from(JSON.stringify(response));
    const result = await collectRequired({
      ...f,
      target,
      required: { rows: [{ pr: 7 }] },
      artifacts,
      fetchPr,
    });
    expect(result.requiredPaths['7']).toContainEqual({
      path: 'kept',
      disposition: 'ambiguous',
      source_evidence: reference,
    });
    expect(result.members['7']).toMatchObject({ context: { title: null, body: '' } });
    await expect(
      collectRequired({
        ...f,
        required: { rows: [{ pr: 7 }] },
        artifacts,
        fetchPr: async () => Buffer.from(JSON.stringify({ ...response, merged: false })),
      }),
    ).rejects.toThrow('identity/merge mismatch');
  });
});
