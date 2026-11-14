import { describe, expect, test } from 'vitest';
import { mergeHeadEvidence } from '../../../src/ops/crq/internal/mergeHeadEvidence.js';
import type { RunGit } from '../../../src/adapters/crq/ledgerGit.js';

const base = 'a'.repeat(40),
  published = 'b'.repeat(40),
  actual = 'c'.repeat(40);
const blob1 = 'd'.repeat(40),
  blob2 = 'e'.repeat(40);
function git(extraPatch = '+later\n', mode = '100644'): RunGit {
  return async (args) => {
    let output = '';
    if (args[0] === 'diff-tree' && args.includes('--name-only'))
      output = 'src/a.ts\0test/a.test.ts\0';
    else if (args[0] === 'rev-list')
      output = args.includes('--count') ? '1\n' : `${published} ${base}\n`;
    else if (args[0] === 'log') output = `${actual}\tlater\n`;
    else if (args[0] === 'ls-tree') {
      const head = args[2];
      output = `${head === actual ? mode : '100644'} blob ${head === actual ? blob2 : blob1}\tsrc/a.ts\0`;
    } else if (args[0] === 'diff')
      output = args.includes(base)
        ? 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+fixed  \n'
        : `diff --git a/src/a.ts b/src/a.ts\n@@ -2 +2 @@\n${extraPatch}`;
    return { args, code: 0, stdout: Buffer.from(output), stderr: '' };
  };
}
const input = { published, actual, commits: [published], anchors: ['src/a.ts'] };
describe('merge head containment proof', () => {
  test('preserves a fix through unrelated changes and records exact source mode', async () => {
    const proof = await mergeHeadEvidence(input, git());
    expect(proof?.compared_paths).toEqual(['src/a.ts']);
    expect(proof?.excluded_test_paths).toEqual(['test/a.test.ts']);
    expect(proof?.source_modes?.['src/a.ts']).toBe('100644');
    expect(proof?.containment?.['src/a.ts']).toMatchObject({
      status: 'contained',
      changed_added: 1,
      changed_removed: 1,
    });
  });
  test('rejects a later removal of the exact published line, including whitespace', async () => {
    await expect(mergeHeadEvidence(input, git('-fixed  \n'))).rejects.toThrow('source changed');
  });
  test('refuses oversized and invalid evidence before comparing sources', async () => {
    await expect(
      mergeHeadEvidence({ ...input, commits: Array(65).fill(published) as string[] }, git()),
    ).rejects.toThrow('bound');
    await expect(mergeHeadEvidence({ ...input, anchors: ['../escape'] }, git())).rejects.toThrow(
      'invalid repair source path',
    );
  });
  test('preserves legacy and exact-head behavior', async () => {
    expect(await mergeHeadEvidence({ ...input, published: undefined }, git())).toBeNull();
    expect(await mergeHeadEvidence({ ...input, actual: published }, git())).toEqual({
      published_head: published,
      actual_head: published,
      source_blobs: {},
    });
  });
});
