// Split provenance: test/ops/ratchet/recomputeTypecheck.test.ts was split by
// subject into recomputeTypecheck.core.test.ts, recomputeTypecheck.preflight.test.ts,
// recomputeTypecheck.dependency-boundary.test.ts and
// recomputeTypecheck.launcher.test.ts (shared fixtures:
// recomputeTypecheck.helpers.ts).
// W1.7: the trusted compiler counts errors in an attribute-free head tree.
// A local Git repo and the installed TypeScript package exercise the complete
// extraction + toolchain path without a network service or fake diagnostics.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  boundaryPreflight,
  createTempRoot,
  createTrustedRepo,
  trustedGit,
} from './recomputeTypecheck.helpers.js';

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
let dispose: () => void;

beforeAll(() => {
  ({ tmp, dispose } = createTempRoot());
  ({ repo } = createTrustedRepo(tmp));
}, 60_000);

afterAll(() => dispose());

afterEach(() => vi.unstubAllEnvs());

describe('fixture preflight and Git forwarding isolation', () => {
  test('rejects missing pnpm only when boundary preflight is invoked', () => {
    vi.stubEnv('npm_execpath', '');
    expect(() => boundaryPreflight()).toThrow('fixture executable must be absolute');
  });

  test('preserves supplied Git fields while forced isolation takes precedence', () => {
    vi.stubEnv('CQ_BOUNDARY_SECRET', 'fake-canary');
    const supplied = {
      CQ_GIT_FORWARD_CANARY: 'nonsecret-preserved',
      PATH: 'untrusted-path',
      GIT_CONFIG_GLOBAL: 'untrusted-global',
      GIT_CONFIG_SYSTEM: 'untrusted-system',
      GIT_CONFIG_NOSYSTEM: '0',
      GIT_TERMINAL_PROMPT: '1',
      GIT_OPTIONAL_LOCKS: '1',
      GIT_NO_REPLACE_OBJECTS: '0',
    };
    const env = fixtureGit.environment(supplied);
    expect(env['CQ_GIT_FORWARD_CANARY']).toBe('nonsecret-preserved');
    expect(env['PATH']).toBe('');
    expect(env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
    expect(env['GIT_CONFIG_SYSTEM']).toBe('/dev/null');
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['GIT_OPTIONAL_LOCKS']).toBe('0');
    expect(env['GIT_NO_REPLACE_OBJECTS']).toBe('1');
    expect(env['CQ_BOUNDARY_SECRET'] !== undefined).toBe(false);
    expect(fixtureGit.environment()['CQ_BOUNDARY_SECRET'] !== undefined).toBe(false);
    expect(supplied.PATH).toBe('untrusted-path');
  });

  test('forwards the supplied nonsecret Git identity to the real child', async () => {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        'git',
        ['var', 'GIT_AUTHOR_IDENT'],
        {
          cwd: repo,
          env: {
            GIT_AUTHOR_NAME: 'h1-forwarded',
            GIT_AUTHOR_EMAIL: 'fixture@example.test',
            GIT_CONFIG_GLOBAL: join(tmp, 'must-not-be-read.gitconfig'),
          },
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    expect(output).toMatch(/^h1-forwarded <fixture@example\.test>/);
  });
});
