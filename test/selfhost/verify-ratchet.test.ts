// Readiness T2 — cq-verify's in-process ratchet verdict
// (src/selfhost/verify-ratchet.ts). The binding itself is the gate's
// (`bindQueueAuthorization`, covered with the gate's world in
// promote-gate.test.ts); this file pins the carrier: which subjects bind,
// that an evidence fault fails closed, that the evidence is journalled, and
// the strict argument and output contract cq-verify's judge relies on.
import { describe, expect, test } from 'vitest';
import type { OpResult } from '../../src/kernel/types.js';
import type { D11Authorization } from '../../src/ops/gates/d11Authorization.js';
import type {
  VerifyRatchetInput,
  VerifyRatchetOutcome,
} from '../../src/ops/ratchet/verifyRatchet.js';
import type { GhFn } from '../../src/adapters/forge-github/gh.js';
import type { GateGit } from '../../src/selfhost/promote-gate.js';
import {
  mainWith,
  parseVerifyArgs,
  verifyWithAuthorization,
  type VerifyArgs,
} from '../../src/selfhost/verify-ratchet.js';

const sha = (c: string): string => c.repeat(40);
const TRUST = sha('a');
const MAIN = sha('b');
const TIP = sha('c');

const ARGV = [
  '--repo=trust',
  '--repository=o/r',
  '--repositoryId=42',
  `--trustRef=${TRUST}`,
  `--subject=${TIP}`,
  '--subjectKind=push',
  '--base=refs/remotes/origin/main',
  '--measureConclusion=success',
  '--measurementPath=/tmp/m.json',
  '--typecheckCount=0',
];

const args = (over: Partial<VerifyArgs> = {}): VerifyArgs => ({
  ...parseVerifyArgs(ARGV),
  ...over,
});

const AUTH: D11Authorization = {
  attested: true,
  contributions: [],
  report: ['attestation: policy/attestations/c3.json valid at the trust ref — records honoured'],
};

/** No GitHub or git read may happen except through the injected binding. */
const gh: GhFn = () => Promise.reject(new Error('unexpected gh call'));
const git = {
  revParse: (_repo: string, rev: string) =>
    rev === 'refs/remotes/origin/main' ? Promise.resolve(MAIN) : Promise.reject(new Error(rev)),
} as unknown as GateGit;

function outcome(definitionChanges: string[]): OpResult<VerifyRatchetOutcome> {
  return {
    status: 'ok',
    value: {
      verdict: definitionChanges.length > 0 ? 'needs-human' : 'pass',
      trustRef: TRUST,
      subject: TIP,
      rangeBase: MAIN,
      definitionChanges,
      guard: { ok: true, violations: [], filesChecked: 0 },
      results: [],
      reasons: ['verifier reason'],
    },
  };
}

function harness(definitionChanges: string[] = ['tsconfig.json']) {
  const verified: VerifyRatchetInput[] = [];
  const bound: Array<{ main: string; subject: string; cfg: unknown }> = [];
  return {
    verified,
    bound,
    deps: {
      gh,
      git,
      bind: (_deps: unknown, cfg: unknown, main: string, subject: string, report: string[]) => {
        bound.push({ main, subject, cfg });
        report.push('closure: 1 commit(s)');
        return Promise.resolve(AUTH);
      },
      verify: (input: VerifyRatchetInput) => {
        verified.push(input);
        return Promise.resolve(outcome(definitionChanges));
      },
    },
  };
}

describe('verifyWithAuthorization', () => {
  test('a queue-tip subject binds the gate authorization over main..subject and forwards it', async () => {
    const h = harness();
    const result = await verifyWithAuthorization(h.deps, args());
    expect(h.bound).toEqual([
      {
        main: MAIN,
        subject: TIP,
        cfg: { repo: 'trust', owner: 'o', name: 'r', repositoryId: 42, trustRef: TRUST },
      },
    ]);
    expect(h.verified).toHaveLength(1);
    expect(h.verified[0]?.authorization).toBe(AUTH);
    // The verifier's own fields pass through unchanged.
    expect(h.verified[0]).toMatchObject({
      repo: 'trust',
      trustRef: TRUST,
      subject: TIP,
      subjectKind: 'push',
      base: 'refs/remotes/origin/main',
      measureConclusion: 'success',
      measurementPath: '/tmp/m.json',
      typecheckCount: 0,
    });
    // A definition change makes the evidence matter: it is journalled.
    expect(result.status === 'ok' && result.value.reasons).toEqual([
      'verifier reason',
      'closure: 1 commit(s)',
      ...AUTH.report,
    ]);
  });

  test('no definition change: the verdict is untouched (no evidence noise)', async () => {
    const h = harness([]);
    const result = await verifyWithAuthorization(h.deps, args());
    expect(result).toEqual(outcome([]));
  });

  test('a PR subject binds nothing: a definition change stays needs-human, as before', async () => {
    const h = harness();
    const result = await verifyWithAuthorization(h.deps, args({ subjectKind: 'pr' }));
    expect(h.bound).toEqual([]);
    expect(h.verified[0]?.authorization).toBeUndefined();
    expect(result.status === 'ok' && result.value.reasons.at(-1)).toBe(
      'd11: PR subject — no authorization is bound',
    );
  });

  test('an evidence fault binds nothing (fail closed) and says why', async () => {
    const h = harness();
    const result = await verifyWithAuthorization(
      { ...h.deps, bind: () => Promise.reject(new Error('gh exit 1: HTTP 502')) },
      args(),
    );
    expect(h.verified[0]?.authorization).toBeUndefined();
    expect(result.status === 'ok' && result.value.reasons.join('\n')).toMatch(
      /d11: evidence could not be bound \(gh exit 1: HTTP 502\) — no authorization/,
    );
  });

  test('an unresolvable base binds nothing (fail closed)', async () => {
    const h = harness();
    await verifyWithAuthorization(h.deps, args({ base: 'refs/remotes/origin/nope' }));
    expect(h.bound).toEqual([]);
    expect(h.verified[0]?.authorization).toBeUndefined();
  });
});

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

describe('mainWith', () => {
  test('writes exactly one JSON line with the OpResult (the shape cq-verify validates)', async () => {
    const lines: string[] = [];
    const h = harness();
    const code = await mainWith(ARGV, {
      makeGh: () => gh,
      git,
      write: (line) => lines.push(line),
      bind: h.deps.bind,
      verify: h.deps.verify,
    });
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(lines[0] ?? '') as OpResult<VerifyRatchetOutcome>;
    expect(parsed.status === 'ok' && parsed.value.verdict).toBe('needs-human');
  });

  test('bad arguments are a failed result, exit 1, still one JSON line', async () => {
    const lines: string[] = [];
    const code = await mainWith(['--bogus=1'], {
      makeGh: () => gh,
      git,
      write: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ status: 'failed' });
  });
});
