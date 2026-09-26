// W1.7: the trusted compiler counts errors in an attribute-free head tree.
// A local Git repo and the installed TypeScript package exercise the complete
// extraction + toolchain path without a network service or fake diagnostics.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { recomputeTypecheck } from '../../../src/ops/ratchet/recomputeTypecheck.js';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

let tmp: string;
let repo: string;
let errorCommit: string;
let cleanCommit: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cq-ratchet-recompute-'));
  repo = join(tmp, 'trust');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.test']);
  git(repo, ['config', 'user.name', 'test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, '.gitattributes'), 'sample.ts export-ignore\n');
  writeFileSync(
    join(repo, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, types: [], skipLibCheck: true },
      files: ['sample.ts'],
    }),
  );
  writeFileSync(join(repo, 'sample.ts'), 'const amount: number = "wrong";\n');
  // The trusted compiler is outside the committed head tree. The recompute
  // links this install beside its extraction; it never installs head deps.
  symlinkSync(join(process.cwd(), 'node_modules'), join(repo, 'node_modules'), 'dir');
  git(repo, ['add', '.gitignore', '.gitattributes', 'tsconfig.json', 'sample.ts']);
  git(repo, ['commit', '-q', '-m', 'one type error']);
  errorCommit = git(repo, ['rev-parse', 'HEAD']);

  writeFileSync(join(repo, 'sample.ts'), 'const amount: number = 1;\n');
  git(repo, ['add', 'sample.ts']);
  git(repo, ['commit', '-q', '-m', 'fix type error']);
  cleanCommit = git(repo, ['rev-parse', 'HEAD']);
}, 60_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('recomputeTypecheck', { timeout: 60_000 }, () => {
  test('counts a pinned head error despite export-ignore, then a clean commit', async () => {
    const scratchWithError = join(tmp, 'scratch-error');
    const bad = await recomputeTypecheck({
      repo,
      subject: errorCommit,
      scratch: scratchWithError,
    });
    expect(bad.status).toBe('ok');
    if (bad.status !== 'ok') throw new Error('expected a counted type error');
    expect(bad.value).toMatchObject({
      count: 1,
      subject: errorCommit,
      files: 4,
      skipped: 0,
    });
    expect(bad.value.exitCode).toBeGreaterThan(0);
    expect(readFileSync(join(scratchWithError, 'tree', 'sample.ts'), 'utf8')).toContain('"wrong"');
    expect(existsSync(join(scratchWithError, 'node_modules', 'typescript', 'bin', 'tsc'))).toBe(
      true,
    );

    const good = await recomputeTypecheck({
      repo,
      subject: cleanCommit,
      scratch: join(tmp, 'scratch-clean'),
    });
    expect(good.status).toBe('ok');
    if (good.status !== 'ok') throw new Error('expected a clean count');
    expect(good.value).toMatchObject({
      count: 0,
      subject: cleanCommit,
      files: 4,
      skipped: 0,
      exitCode: 0,
    });
  });

  test('refuses a non-empty scratch directory without replacing its contents', async () => {
    const scratch = join(tmp, 'scratch-occupied');
    mkdirSync(scratch);
    writeFileSync(join(scratch, 'marker'), 'keep');
    const result = await recomputeTypecheck({ repo, subject: cleanCommit, scratch });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failed result');
    expect(result.error).toMatch(/scratch .* is not empty/);
    expect(readFileSync(join(scratch, 'marker'), 'utf8')).toBe('keep');
    expect(existsSync(join(scratch, 'tree'))).toBe(false);
  });

  test('rejects an unsafe subject before creating scratch', async () => {
    const scratch = join(tmp, 'scratch-unsafe');
    const result = await recomputeTypecheck({ repo, subject: '--output=/tmp/x', scratch });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failed result');
    expect(result.error).toMatch(/refusing unsafe rev-parse revision/);
    expect(existsSync(scratch)).toBe(false);
  });
});
