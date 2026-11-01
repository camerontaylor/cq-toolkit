import { describe, expect, test } from 'vitest';
import { mainWith, parseVerifyArgs, verifySubject } from '../../src/selfhost/verify-ratchet.js';
import type { VerifyRatchetInput } from '../../src/ops/ratchet/verifyRatchet.js';
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
