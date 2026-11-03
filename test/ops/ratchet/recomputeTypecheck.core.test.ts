// Split provenance: test/ops/ratchet/recomputeTypecheck.test.ts was split by
// subject into recomputeTypecheck.core.test.ts, recomputeTypecheck.preflight.test.ts,
// recomputeTypecheck.dependency-boundary.test.ts and
// recomputeTypecheck.launcher.test.ts (shared fixtures:
// recomputeTypecheck.helpers.ts).
// W1.7: the trusted compiler counts errors in an attribute-free head tree.
// A local Git repo and the installed TypeScript package exercise the complete
// extraction + toolchain path without a network service or fake diagnostics.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { recomputeTypecheck } from '../../../src/ops/ratchet/recomputeTypecheck.js';
import { createTempRoot, createTrustedRepo, trustedGit } from './recomputeTypecheck.helpers.js';

const fixtureGit = vi.hoisted(() => ({
  executable: '',
  environment: (supplied?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...supplied,
    PATH: '',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
  }),
}));

// Forward to REAL processes; bind the existing adapter's bare git calls without
// changing production code or consulting PATH during subject extraction.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const forward = (method: 'execFile' | 'spawn', command: string, args: unknown[]): unknown => {
    if (command !== 'git') return Reflect.apply(actual[method], actual, [command, ...args]);
    if (!fixtureGit.executable) throw new Error('Git fixture preflight was not completed');
    const bound = args.map((value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
      return {
        ...value,
        env: fixtureGit.environment((value as { env?: NodeJS.ProcessEnv }).env),
      };
    });
    return Reflect.apply(actual[method], actual, [fixtureGit.executable, ...bound]);
  };
  return {
    ...actual,
    execFile: ((command: string, ...args: unknown[]) =>
      forward('execFile', command, args)) as typeof actual.execFile,
    spawn: ((command: string, ...args: unknown[]) =>
      forward('spawn', command, args)) as typeof actual.spawn,
  };
});

fixtureGit.executable = trustedGit;

let tmp: string;
let repo: string;
let errorCommit: string;
let cleanCommit: string;
let dispose: () => void;

beforeAll(() => {
  ({ tmp, dispose } = createTempRoot());
  ({ repo, errorCommit, cleanCommit } = createTrustedRepo(tmp));
}, 60_000);

afterAll(() => dispose());

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
