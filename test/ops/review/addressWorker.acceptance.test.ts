import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { finding, fixture } from './addressWorker.helpers.js';

test.each(['index', 'worker-snapshot', 'parent'] as const)(
  'engine-owned acceptance refuses concurrent tampering: %s',
  async (mode) => {
    let tamper: () => Promise<void> = async () => undefined;
    const f = await fixture(async (input) => {
      if (input.outputSchema?.name === 'review.address.closure/v1') {
        if (mode !== 'index') await tamper();
        return { closed: true, reason: 'candidate fixed' };
      }
      if (input.prompt.includes('initial finding')) {
        await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
        if (mode === 'index') await tamper();
      }
      return { disposition: 'fixed', reason: 'claim', evidence: [] };
    });
    tamper = async () => {
      if (mode === 'index') f.repo.git('add', 'src/a.ts');
      else if (mode === 'worker-snapshot')
        await f.repo.write('src/a.ts', 'LATE UNCHECKED CONTENT\n');
      else {
        await f.repo.write('README.md', 'external commit');
        f.repo.commitAll('outside engine');
      }
    };
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.commit).toBeUndefined();
      expect(fix.finding.status).toBe('deferred');
      expect(fix.reason).toMatch(
        mode === 'index'
          ? /index|staging/
          : mode === 'worker-snapshot'
            ? /worker file changed after candidate snapshot/
            : /unexpected HEAD movement|verified parent changed/,
      );
      const calls = f.calls();
      const sibling = await f.engine.fix(finding('src/b.ts'), 1);
      expect(sibling.commit).toBeUndefined();
      expect(f.calls()).toBe(calls);
      if (mode !== 'parent') expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
    } finally {
      await f.cleanup();
    }
  },
);

test.each([
  ':(exclude)never.ts',
  'src/café.ts',
  'src/space name.ts',
  'src/line\nbreak.ts',
  'src/quote"name.ts',
  'src/trailing\n',
] as const)('exact Git path %j can commit without poisoning sibling progress', async (file) => {
  const f = await fixture(async (input) => {
    if (input.outputSchema?.name === 'review.address.closure/v1')
      return { closed: true, reason: 'verified candidate' };
    if (!input.prompt.startsWith('related-check feedback')) {
      const selected = input.prompt.includes('Address only src/b.ts') ? 'src/b.ts' : file;
      await writeFile(join(input.workspace!.path, selected), 'GOOD\n');
    }
    return { disposition: 'fixed', reason: 'fixed exact file', evidence: [] };
  });
  try {
    await f.repo.write(file, 'BAD\n');
    f.repo.commitAll('unusual filename');
    const results = await Promise.all([
      f.engine.fix(finding(file), 1),
      f.engine.fix(finding('src/b.ts'), 1),
    ]);
    expect(results.map((result) => result.finding.status)).toEqual(['fixed', 'fixed']);
    for (const [index, path] of [file, 'src/b.ts'].entries()) {
      expect(results[index]!.commit).toBeDefined();
      expect(
        f.repo.git(
          'diff-tree',
          '--no-commit-id',
          '--name-only',
          '-r',
          '-z',
          results[index]!.commit!,
        ),
      ).toBe(path + '\0');
      expect(await readFile(join(f.repo.root, path), 'utf8')).toBe('GOOD\n');
    }
    expect(f.repo.git('diff', '--cached', '--name-only', '-z')).toBe('');
    expect(f.repo.git('diff', '--name-only', '-z', 'HEAD')).toBe('');
  } finally {
    await f.cleanup();
  }
});
