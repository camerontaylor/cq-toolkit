import { describe, expect, test } from 'vitest';
import { mainWith, parseVerifyArgs, verifySubject } from '../../src/selfhost/verify-ratchet.js';
import {
  createVerifyRatchet,
  type VerifyRatchetInput,
} from '../../src/ops/ratchet/verifyRatchet.js';
import type { ProtectedPathsConfig } from '../../src/ops/gates/policyConfig.js';
const TRUST = 'a'.repeat(40);
const TIP = 'c'.repeat(40);
const ARGV = [
  '--repo=trust',
  '--repository=o/r',
  '--repositoryId=42',
  `--trustRef=${TRUST}`,
  `--subject=${TIP}`,
  '--subjectKind=pr',
  '--base=refs/remotes/origin/main',
  '--measureConclusion=success',
  '--measurementPath=/tmp/m.json',
  '--typecheckCount=0',
];
describe('parseVerifyArgs', () => {
  test('accepts the cq-verify judge argv', () => {
    expect(parseVerifyArgs(ARGV)).toMatchObject({ repositoryId: 42, typecheckCount: 0 });
    const minimal = ARGV.filter((a) => !/^--(measurementPath|typecheckCount)=/.test(a));
    expect(parseVerifyArgs(minimal)).not.toHaveProperty('typecheckCount');
  });

  test.each([
    [[...ARGV, '--posture=diff-check'], /posture/],
    [[...ARGV, '--repo=x'], /--repo given more than once/],
    [[...ARGV.slice(1), '--repo='], /--repo needs a value/],
    [
      ARGV.map((a) => (a.startsWith('--repository=') ? '--repository=o/r/x' : a)),
      /<owner>\/<name>/,
    ],
    [ARGV.map((a) => (a.startsWith('--trustRef=') ? '--trustRef=main' : a)), /trustRef/],
    [ARGV.map((a) => (a.startsWith('--subjectKind=') ? '--subjectKind=tip' : a)), /subjectKind/],
    [['positional', ...ARGV], /unknown argument/],
  ])('refuses %j', (argv, error) => {
    expect(() => parseVerifyArgs(argv)).toThrow(error);
  });
});

describe('PR-only advisory verification', () => {
  test('forwards measurement inputs without authorization or evidence reads', async () => {
    let received: VerifyRatchetInput | undefined;
    const result = await verifySubject(
      {
        verify: async (input) => {
          received = input;
          return { status: 'failed', error: 'fixture result' };
        },
      },
      parseVerifyArgs(ARGV),
    );
    expect(received).toMatchObject({ subject: TIP, subjectKind: 'pr', typecheckCount: 0 });
    expect(received).not.toHaveProperty('authorization');
    expect(result).toMatchObject({ status: 'failed', error: 'fixture result' });
  });
  test('forwards an explicit recompute skip reason', async () => {
    let received: VerifyRatchetInput | undefined;
    await verifySubject(
      {
        verify: async (input) => {
          received = input;
          return { status: 'failed', error: 'fixture' };
        },
      },
      parseVerifyArgs([
        ...ARGV.filter((arg) => !arg.startsWith('--typecheckCount=')),
        '--typecheckSkipped=lockfile changed',
      ]),
    );
    expect(received?.typecheckSkipped).toBe('lockfile changed');
    expect(received).not.toHaveProperty('typecheckCount');
  });

  test('rejects retired push subjects', () => {
    expect(() =>
      parseVerifyArgs(ARGV.map((arg) => (arg === '--subjectKind=pr' ? '--subjectKind=push' : arg))),
    ).toThrow(/subjectKind/);
  });
  test('invalid usage still prints one JSON result and returns exit 2', async () => {
    const lines: string[] = [];
    expect(await mainWith(['--bogus=1'], { write: (line) => lines.push(line) })).toBe(2);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ status: 'failed' });
  });
});

describe('mainWith posture', () => {
  test('the entry snapshot, not a later read of the injected env, supplies the posture', async () => {
    const configs: ProtectedPathsConfig[] = [];
    let reads = 0;
    const env = Object.defineProperty({}, 'CQ_MERGE_PROTECTED_PATHS', {
      enumerable: true,
      configurable: true,
      get: () => (++reads === 1 ? 'diff-check' : 'advisory'),
    }) as Record<string, string | undefined>;
    const create: typeof createVerifyRatchet = (config) => {
      configs.push(config);
      return async () => ({ status: 'failed', error: 'fixture' });
    };
    const lines: string[] = [];
    expect(await mainWith(ARGV, { env, create, write: (line) => lines.push(line) })).toBe(1);
    expect(configs).toEqual([{ posture: 'diff-check', layer: 'env' }]);
    expect(reads).toBe(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ status: 'failed', error: 'fixture' });
  });

  test('an invalid injected posture is refused by the entry gate before verifying', async () => {
    const configs: ProtectedPathsConfig[] = [];
    const create: typeof createVerifyRatchet = (config) => {
      configs.push(config);
      return async () => ({ status: 'failed', error: 'fixture' });
    };
    const lines: string[] = [];
    const errs: string[] = [];
    expect(
      await mainWith(ARGV, {
        env: { CQ_MERGE_PROTECTED_PATHS: 'off' },
        create,
        write: (line) => lines.push(line),
        stderr: (text) => errs.push(text),
      }),
    ).toBe(2);
    expect(configs).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ status: 'failed' });
    expect(errs.join('')).toContain('CQ_MERGE_PROTECTED_PATHS');
  });
});
