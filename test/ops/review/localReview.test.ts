import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { git } from '../../../src/ops/review/internal/localReview.js';

afterEach(() => vi.unstubAllEnvs());

test('git resolves the current PATH on each invocation and isolates its environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-review-path-'));
  for (const name of ['first', 'second']) {
    const dir = join(root, name);
    await mkdir(dir);
    const executable = join(dir, 'git');
    await writeFile(
      executable,
      `#!${process.execPath}\nconsole.log(JSON.stringify({name: '${name}', args: process.argv.slice(2), env: process.env}));\n`,
    );
    await chmod(executable, 0o755);
  }
  vi.stubEnv('GIT_DIR', '/hostile');
  vi.stubEnv('REVIEW_TEST_SECRET', 'secret');
  for (const name of ['first', 'second']) {
    vi.stubEnv('PATH', join(root, name));
    const result = JSON.parse(await git(root, 'status')) as {
      name: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(result.name).toBe(name);
    expect(result.args).toEqual(['--no-replace-objects', 'status']);
    expect(result.env).toEqual({
      PATH: join(root, name),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
  }
});

test.each([undefined, ''])(
  'unset or empty PATH does not search the default system path',
  async (path) => {
    const root = await mkdtemp(join(tmpdir(), 'cq-review-empty-path-'));
    vi.stubEnv('PATH', path);
    await expect(git(root, '--version')).rejects.toThrow();
  },
);

test('a real git executable is found through a custom PATH', async () => {
  const executable = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const root = await mkdtemp(join(tmpdir(), 'cq-review-real-git-'));
  await symlink(executable, join(root, 'git'));
  vi.stubEnv('PATH', root);
  expect(await git(root, '--version')).toMatch(/^git version /);
});
