import { describe, expect, test } from 'vitest';
import {
  CONFIG_RELPATH,
  Refused,
  assertClean,
  codePointSorted,
  requireUnchangedUnitTemplates,
  splitlines,
  type GitGuardEffects,
  type GitStatusResult,
} from '../../../../src/ops/crq/deploy/gitGuards.js';

const status = (stdout: string, returncode = 0, stderr = ''): GitGuardEffects => ({
  statusPorcelain: async (): Promise<GitStatusResult> => ({ returncode, stdout, stderr }),
  git: async () => '',
});
const refusal = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(Refused);
  return (e as Refused).message;
};

describe('assertClean', () => {
  test.each([
    ['clean', ''],
    ['unstaged config', ` M ${CONFIG_RELPATH}\n`],
    ['staged config', `M  ${CONFIG_RELPATH}\n`],
    ['both', ` M ${CONFIG_RELPATH}\nM  ${CONFIG_RELPATH}\n`],
    ['blank lines', `\n  \n ${'　'}\n`],
  ])('accepts %s', async (_n, out) => {
    await assertClean(status(out));
  });

  test.each([
    ['untracked config', `?? ${CONFIG_RELPATH}`],
    ['both-column config', `MM ${CONFIG_RELPATH}`],
    ['deleted config', ` D ${CONFIG_RELPATH}`],
    ['other file', ' M src/a.ts'],
    ['stripped column', `M ${CONFIG_RELPATH}`],
  ])('refuses %s', async (_n, line) => {
    expect(await refusal(assertClean(status(line + '\n')))).toBe(
      `deployment checkout has changes other than the rendered config: ${line}`,
    );
  });

  test('lists at most five unexpected lines, skipping the allowed one', async () => {
    const lines = ['?? a', '?? b', ` M ${CONFIG_RELPATH}`, '?? c', '?? d', '?? e', '?? f', '?? g'];
    expect(await refusal(assertClean(status(lines.join('\n'))))).toBe(
      'deployment checkout has changes other than the rendered config: ?? a; ?? b; ?? c; ?? d; ?? e',
    );
  });

  test('CR and the Python line separators split lines', async () => {
    expect(await refusal(assertClean(status('?? a\r?? b\u2028?? c')))).toContain(
      '?? a; ?? b; ?? c',
    );
  });

  test('a failing status names its clipped, stripped stderr', async () => {
    expect(await refusal(assertClean(status('', 128, '  fatal: nope \n')))).toBe(
      'git status failed: fatal: nope',
    );
    const long = await refusal(assertClean(status('', 1, 'x'.repeat(250))));
    expect(long).toBe(`git status failed: ${'x'.repeat(200)}`);
    expect(await refusal(assertClean(status('', 1, '')))).toBe('git status failed: ');
  });

  test('the exit code is checked before the output', async () => {
    expect(await refusal(assertClean(status('', 2)))).toContain('git status failed');
    await expect(assertClean(status('?? x', 1))).rejects.toThrow('git status failed');
  });
});

const PRIOR = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const DIR = 'apps/crq-python/ops/systemd/';
function gitFixture(
  trees: Record<string, string[]>,
  blobs: Record<string, string>,
): { effects: GitGuardEffects; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    effects: {
      statusPorcelain: async () => ({ returncode: 0, stdout: '', stderr: '' }),
      git: async (...args) => {
        calls.push(args);
        if (args[0] === 'ls-tree') return (trees[args[3]!] ?? []).join('\n');
        if (args[0] === 'rev-parse') return blobs[args[1]!] ?? 'missing';
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    },
  };
}

describe('requireUnchangedUnitTemplates', () => {
  test('identical templates pass and only crq-* are read, sorted', async () => {
    const names = [`${DIR}crq-b.timer`, `${DIR}other.service`, `${DIR}crq-a.service`];
    const blobs: Record<string, string> = {};
    for (const sha of [PRIOR, TARGET]) for (const n of names) blobs[`${sha}:${n}`] = `blob-${n}`;
    const f = gitFixture({ [PRIOR]: names, [TARGET]: names }, blobs);
    await requireUnchangedUnitTemplates(f.effects, PRIOR, TARGET);
    expect(f.calls.filter((c) => c[0] === 'rev-parse').map((c) => c[1])).toEqual([
      `${PRIOR}:${DIR}crq-a.service`,
      `${PRIOR}:${DIR}crq-b.timer`,
      `${TARGET}:${DIR}crq-a.service`,
      `${TARGET}:${DIR}crq-b.timer`,
    ]);
    expect(f.calls[0]).toEqual(['ls-tree', '-r', '--name-only', PRIOR, DIR]);
  });

  test('non crq files may change freely', async () => {
    const f = gitFixture(
      { [PRIOR]: [`${DIR}other.service`], [TARGET]: [`${DIR}other.service`, `${DIR}notes.md`] },
      {},
    );
    await requireUnchangedUnitTemplates(f.effects, PRIOR, TARGET);
  });

  test('a prefix match must be on the basename, not the path', async () => {
    const f = gitFixture({ [PRIOR]: [], [TARGET]: [`${DIR}sub/crq-x.timer`, `${DIR}xcrq-y`] }, {});
    expect(await refusal(requireUnchangedUnitTemplates(f.effects, PRIOR, TARGET))).toContain(
      `${DIR}sub/crq-x.timer`,
    );
    const g = gitFixture(
      { [PRIOR]: [], [TARGET]: [`${DIR}xcrq-y`, `${DIR}crq/readme`, `${DIR}crqx.service`] },
      {},
    );
    await requireUnchangedUnitTemplates(g.effects, PRIOR, TARGET);
  });

  test.each([
    [
      'rewritten',
      [`${DIR}crq-a.timer`],
      [`${DIR}crq-a.timer`],
      { [`${PRIOR}:${DIR}crq-a.timer`]: 'x', [`${TARGET}:${DIR}crq-a.timer`]: 'y' },
    ],
    ['added', [], [`${DIR}crq-a.timer`], {}],
    ['removed', [`${DIR}crq-a.timer`], [], {}],
  ])('%s refuses naming the file and the 12-char target', async (_n, prior, next, blobs) => {
    const f = gitFixture({ [PRIOR]: prior, [TARGET]: next }, blobs);
    expect(await refusal(requireUnchangedUnitTemplates(f.effects, PRIOR, TARGET))).toBe(
      `target ${TARGET.slice(0, 12)} changes rendered unit templates this flow cannot reconcile: ` +
        'it installs no unit files, verifies none with the user manager, and rollback ' +
        'cannot restore the prior definitions. The owner must install and verify the ' +
        `changed unit definitions against this target first: ${DIR}crq-a.timer`,
    );
  });

  test('the changed list is code-point sorted and comma joined', async () => {
    const f = gitFixture(
      { [PRIOR]: [], [TARGET]: [`${DIR}crq-b`, `${DIR}crq-B`, `${DIR}crq-a`] },
      {},
    );
    expect(await refusal(requireUnchangedUnitTemplates(f.effects, PRIOR, TARGET))).toMatch(
      new RegExp(`${DIR}crq-B, ${DIR}crq-a, ${DIR}crq-b$`),
    );
  });

  test('a git failure surfaces unchanged', async () => {
    const effects: GitGuardEffects = {
      statusPorcelain: async () => ({ returncode: 0, stdout: '', stderr: '' }),
      git: async () => {
        throw new Refused('git ls-tree failed: bad object');
      },
    };
    await expect(requireUnchangedUnitTemplates(effects, PRIOR, TARGET)).rejects.toThrow(
      'git ls-tree failed: bad object',
    );
  });
});

describe('python string helpers', () => {
  test('splitlines drops one trailing empty element only', () => {
    expect(splitlines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitlines('a\n\n')).toEqual(['a', '']);
    expect(splitlines('')).toEqual([]);
    expect(splitlines('a\r\nb')).toEqual(['a', 'b']);
    expect(splitlines('a\x85b\x1cc\vd\fe\x1df\x1eg')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });
  test('code-point sort differs from UTF-16 order above the BMP', () => {
    expect(codePointSorted(['～', '\u{1F600}', 'a'])).toEqual(['a', '～', '\u{1F600}']);
    expect(codePointSorted(['ab', 'a'])).toEqual(['a', 'ab']);
  });
});
