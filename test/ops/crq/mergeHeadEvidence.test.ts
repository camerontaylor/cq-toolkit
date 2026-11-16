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

// Override individual Git observations while retaining the ordinary fixture.
function override(rewrite: (args: readonly string[], value: string) => string): RunGit {
  const fallback = git();
  return async (args, options) => {
    const call = await fallback(args, options);
    return { ...call, stdout: Buffer.from(rewrite(args, Buffer.from(call.stdout).toString())) };
  };
}

describe('containment oracle bounds and edge cases', () => {
  test('rejects a change to a mode introduced by publication', async () => {
    const runner = override((args, value) =>
      args[0] === 'ls-tree' && (args[2] === base || args[2] === actual)
        ? value.replace('100644', '100755')
        : value,
    );
    await expect(mergeHeadEvidence(input, runner)).rejects.toThrow('needs revalidation');
  });
  test('rejects 129 compared paths', async () => {
    await expect(
      mergeHeadEvidence(
        { ...input, anchors: Array.from({ length: 129 }, (_, i) => `src/${i}.ts`) },
        git(),
      ),
    ).rejects.toThrow('paths exceed bound');
  });
  test('rejects an individual patch above 262144 bytes', async () => {
    const runner = override((args, value) =>
      args[0] === 'diff' && args.includes(base) ? value + 'x'.repeat(262145) : value,
    );
    await expect(mergeHeadEvidence(input, runner)).rejects.toThrow('too large');
  });
  test('rejects aggregate patches above 4000000 bytes', async () => {
    const paths = Array.from({ length: 17 }, (_, i) => `src/${i}.ts`);
    const runner = override((args, value) => {
      if (args[0] === 'diff-tree' && args.includes('--name-only')) return '';
      if (args[0] === 'ls-tree') return value.replace('src/a.ts', args.at(-1)!);
      if (args[0] === 'diff' && args.includes(base)) return value + 'x'.repeat(250000);
      return value;
    });
    await expect(mergeHeadEvidence({ ...input, anchors: paths }, runner)).rejects.toThrow(
      'too large',
    );
  });
  test('rejects binary published and descendant patches', async () => {
    for (const publishedPatch of [true, false]) {
      const runner = override((args, value) =>
        args[0] === 'diff' && args.includes(base) === publishedPatch
          ? 'Binary files a and b differ\n'
          : value,
      );
      await expect(mergeHeadEvidence(input, runner)).rejects.toThrow('source changed');
    }
  });
  test('rejects a binary published patch even when the published mode changed', async () => {
    const runner = override((args, value) => {
      if (args[0] === 'ls-tree' && args[2] === base) return value.replace('100644', '100755');
      if (args[0] === 'diff' && args.includes(base)) return 'Binary files a and b differ\n';
      return value;
    });
    await expect(mergeHeadEvidence(input, runner)).rejects.toThrow('source changed');
  });
  test('recognizes Python Unicode and form-feed line boundaries when checking undo', async () => {
    for (const separator of ['\u2028', '\f']) {
      const runner = override((args, value) => {
        if (args[0] === 'diff' && args.includes(base))
          return `diff --git a b\n@@ -1 +1 @@\n+fixed${separator}context\n`;
        if (args[0] === 'diff') return 'diff --git a b\n@@ -1 +1 @@\n-fixed\n';
        return value;
      });
      await expect(mergeHeadEvidence(input, runner)).rejects.toThrow('source changed');
    }
  });
  test('rejects deletion and recreation of compared source', async () => {
    for (const missing of [actual, published]) {
      const runner = override((args, value) =>
        args[0] === 'ls-tree' && args[2] === missing ? '' : value,
      );
      await expect(mergeHeadEvidence(input, runner)).rejects.toThrow('source changed');
    }
  });
  test('caps recorded extra commits at 32 and reports truncation', async () => {
    let logArgs: readonly string[] = [];
    const runner = override((args, value) => {
      if (args[0] === 'rev-list' && args.includes('--count')) return '33\n';
      if (args[0] === 'log') {
        logArgs = args;
        return Array(32).fill(`${actual}\tsubject`).join('\n');
      }
      return value;
    });
    const proof = await mergeHeadEvidence(input, runner);
    expect(logArgs).toContain('--max-count=32');
    expect(proof?.extra_commits).toHaveLength(32);
    expect(proof?.extra_commits_truncated).toBe(true);
  });
  test('uses Python universal newlines for hashes, excerpts and line splitting', async () => {
    const runner = override((args, value) =>
      args[0] === 'diff' && args.includes(base)
        ? 'diff --git a b\r\n@@ -1 +1 @@\r-old\r+fixed\r'
        : value,
    );
    const proof = await mergeHeadEvidence(input, runner);
    expect(proof?.containment?.['src/a.ts']).toMatchObject({
      patch: 'diff --git a b\n@@ -1 +1 @@\n-old\n+fixed\n',
      patch_sha256: '441c9724d99f07caa09a0383890f320addeea7a2a110210c8fdb7f4a36a3eee3',
      changed_added: 1,
      changed_removed: 1,
    });
    const undo = override((args, value) =>
      args[0] === 'diff' && args.includes(base)
        ? 'diff --git a b\n@@ -1 +1 @@\n+fixed\r'
        : args[0] === 'diff'
          ? 'diff --git a b\n@@ -1 +1 @@\n-fixed\n'
          : value,
    );
    await expect(mergeHeadEvidence(input, undo)).rejects.toThrow('source changed');
  });
});

describe('root publication with real Git', () => {
  test('compares the complete publication span against the empty tree', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const { runGitIn } = await import('../../../src/adapters/crq/publishSource.js');
    const dir = await mkdtemp(join(tmpdir(), 'merge-head-root-'));
    const run = (...args: string[]): string =>
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    const commit = async (content: string, message: string): Promise<string> => {
      await writeFile(join(dir, 'a.ts'), content);
      run('add', 'a.ts');
      run(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        message,
      );
      return run('rev-parse', 'HEAD');
    };
    try {
      run('init', '-q', '--object-format=sha1');
      const root = await commit('old\n', 'root');
      const fixed = await commit('fixed\n', 'fix');
      const retained = await commit('fixed\nextra\n', 'extra');
      const reverted = await commit('old\n', 'revert');
      const input = { published: fixed, commits: [root, fixed], anchors: ['a.ts'] };
      const git = runGitIn(dir);
      expect(
        (await mergeHeadEvidence({ ...input, actual: retained }, git))?.containment?.['a.ts'],
      ).toMatchObject({ status: 'contained' });
      await expect(mergeHeadEvidence({ ...input, actual: reverted }, git)).rejects.toThrow(
        'source changed',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
