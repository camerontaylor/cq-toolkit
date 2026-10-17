// Residual R1 — cq-policy's in-process PR-level policy check
// (src/selfhost/policy-diff.ts). The op itself is policyDiff.test.ts's; this
// file pins the carrier: the op's own schema over strict argv, the posture
// taken from the env exactly as the registry importer takes it, and the
// output contract cq-policy's judge step validates.
import { describe, expect, test } from 'vitest';
import type { OpResult } from '../../src/kernel/types.js';
import type { ProtectedPathsConfig } from '../../src/ops/gates/policyConfig.js';
import type { PolicyDiffInput, PolicyDiffOutcome } from '../../src/ops/gates/policyDiff.js';
import { PolicyDiffInputObject } from '../../src/ops/gates/policyDiffInput.js';
import { PolicyDiffInputSchema } from '../../src/ops/gates/registry.js';
import {
  mainWith,
  parsePolicyDiffArgs,
  PolicyDiffArgsSchema,
} from '../../src/selfhost/policy-diff.js';

const TRUST = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);

/** cq-policy's judge argv for a PR subject. */
const ARGV = [
  '--repo=trust',
  `--trustRef=${TRUST}`,
  `--subject=${HEAD}`,
  '--subjectKind=pr',
  '--base=refs/remotes/origin/merge-queue',
  '--pr=12',
  '--repository=o/r',
  '--ownerId=4242',
  '--labelEventsPath=/tmp/label-events.json',
  '--settleRef=refs/remotes/origin/cq-state',
];

const OUTCOME: PolicyDiffOutcome = {
  verdict: 'pass',
  posture: 'human',
  postureLayer: 'default',
  report: ['ok'],
} as unknown as PolicyDiffOutcome;

function harness(result: OpResult<PolicyDiffOutcome> = { status: 'ok', value: OUTCOME }) {
  const configs: ProtectedPathsConfig[] = [];
  const inputs: PolicyDiffInput[] = [];
  const lines: string[] = [];
  const create = (config: ProtectedPathsConfig) => {
    configs.push(config);
    return (input: PolicyDiffInput) => {
      inputs.push(input);
      return Promise.resolve(result);
    };
  };
  return { configs, inputs, lines, create, write: (line: string) => lines.push(line) };
}

describe('parsePolicyDiffArgs', () => {
  test('accepts the cq-policy judge argv; numeric ids become numbers', () => {
    expect(parsePolicyDiffArgs(ARGV)).toEqual({
      repo: 'trust',
      trustRef: TRUST,
      subject: HEAD,
      subjectKind: 'pr',
      base: 'refs/remotes/origin/merge-queue',
      pr: 12,
      repository: 'o/r',
      ownerId: 4242,
      labelEventsPath: '/tmp/label-events.json',
      settleRef: 'refs/remotes/origin/cq-state',
    });
    // A push subject carries the five required flags only.
    expect(parsePolicyDiffArgs(ARGV.slice(0, 5))).toMatchObject({ subjectKind: 'pr' });
  });

  test('a SHA that parses as a JSON number stays a string (the CLI would have coerced it)', () => {
    const digits = '1234567890'.repeat(4);
    expect(
      parsePolicyDiffArgs([...ARGV.slice(0, 1), `--trustRef=${digits}`, ...ARGV.slice(2)]),
    ).toMatchObject({ trustRef: digits });
  });

  test.each([
    ['--posture=diff-check'],
    ['--authorization={}'],
    ['--pr=0'],
    ['--pr=1e3'],
    ['--ownerId=-1'],
    ['--subjectKind=branch'],
  ])('%s is refused (no posture or authorization from argv)', (flag) => {
    const name = flag.slice(2, flag.indexOf('='));
    const argv = [...ARGV.filter((a) => !a.startsWith(`--${name}=`)), flag];
    expect(() => parsePolicyDiffArgs(argv)).toThrow();
  });

  test("the schema is the op's own: same keys as the registry's, which is the shared object", () => {
    expect(PolicyDiffInputSchema).toBe(PolicyDiffInputObject);
    expect(Object.keys(PolicyDiffArgsSchema.shape).sort()).toEqual(
      Object.keys(PolicyDiffInputObject.shape).sort(),
    );
  });
});

describe('mainWith', () => {
  test('unset env: the conservative human default, as the registry importer resolves it', async () => {
    const h = harness();
    expect(await mainWith(ARGV, { env: {}, create: h.create, write: h.write })).toBe(0);
    expect(h.configs).toEqual([{ posture: 'human', layer: 'default' }]);
    expect(h.inputs).toEqual([parsePolicyDiffArgs(ARGV)]);
    expect(h.lines).toHaveLength(1);
    expect(JSON.parse(h.lines[0] ?? '')).toEqual({ status: 'ok', value: OUTCOME });
  });

  test('the project env sets the posture', async () => {
    const h = harness();
    const env = { CQ_MERGE_PROTECTED_PATHS: 'diff-check' };
    await mainWith(ARGV, { env, create: h.create, write: h.write });
    expect(h.configs).toEqual([{ posture: 'diff-check', layer: 'env' }]);
  });

  test('an invalid posture is a failed result, exit 1, and nothing is judged', async () => {
    const h = harness();
    const env = { CQ_MERGE_PROTECTED_PATHS: 'off' };
    expect(await mainWith(ARGV, { env, create: h.create, write: h.write })).toBe(1);
    expect(h.configs).toEqual([]);
    expect(JSON.parse(h.lines[0] ?? '')).toMatchObject({ status: 'failed' });
  });

  test('a fail or needs-human verdict is still an ok result (the check run carries it)', async () => {
    const h = harness({ status: 'ok', value: { ...OUTCOME, verdict: 'needs-human' } });
    expect(await mainWith(ARGV, { env: {}, create: h.create, write: h.write })).toBe(0);
  });

  test('bad arguments are a failed result, exit 2 (I1), still one JSON line', async () => {
    const h = harness();
    expect(await mainWith(['--bogus=1'], { env: {}, create: h.create, write: h.write })).toBe(2);
    expect(h.lines).toHaveLength(1);
    expect(JSON.parse(h.lines[0] ?? '')).toMatchObject({ status: 'failed' });
    expect(h.configs).toEqual([]);
  });
});
