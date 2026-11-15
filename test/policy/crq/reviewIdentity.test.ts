/**
 * Differential test of `reviewIdentity.ts` against live Python `crq_review_identity` and
 * `pr_review_findings.select_receipt_identity` via `oracle/review_identity_oracle.py`:
 * helper argv, timeouts, the child env, token redaction, expiry, reason codes and the
 * selected identity must all match. Skipped where python3 is absent.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
} from '../../../src/policy/crq/jsonValue.js';
import type { GhPort } from '../../../src/policy/crq/prReviewFindings.js';
import {
  IdentityUnavailable,
  ProcessLaunchError,
  authenticatedGh,
  selectReceiptIdentity,
  type IdentityDeps,
} from '../../../src/policy/crq/reviewIdentity.js';

const ORACLE = fileURLToPath(new URL('./oracle/review_identity_oracle.py', import.meta.url));
const HAVE_PYTHON = spawnSync('python3', ['--version']).status === 0;
const NOW = 1_800_000_000;

type Proc = string | { returncode?: number; stdout?: string; stderr?: string };
interface Scenario {
  name: string;
  fn: 'gh' | 'select';
  procs?: Proc[];
  env?: Record<string, string>;
  clock?: number;
  steps?: Array<{ argv: string[]; input?: string | null; clock?: number }>;
  meta?: Record<string, unknown>;
  login?: string | null;
  injected?: boolean;
  app?: string;
  host_login?: string;
  checkpoint?: boolean;
}
interface Outcome {
  ok?: unknown;
  err?: string;
  msg?: string;
  calls: unknown[];
}

const CAP = { stdout: '{"installation_token":"repo-scoped-v1"}' };
const TOKEN = (token: string, expires: string): Proc => ({
  stdout: `${token}\n`,
  stderr: JSON.stringify({ expires_at: expires }),
});
const FUTURE = '2099-01-01T00:00:00Z';
const READY: Proc[] = [CAP, TOKEN('tok-secret', FUTURE)];
const ENV = {
  GH_HOST: 'x.invalid',
  GH_ENTERPRISE_TOKEN: 'e',
  GITHUB_ENTERPRISE_TOKEN: 'e2',
  KEEP_ME: 'yes',
};
const sel = (name: string, over: Partial<Scenario>): Scenario => ({
  name,
  fn: 'select',
  meta: {},
  injected: false,
  ...over,
});

const SCENARIOS: Scenario[] = [
  {
    name: 'gh: probe, token, child env and redaction',
    fn: 'gh',
    procs: [...READY, { stdout: 'a tok-secret b', stderr: 'debug tok-secret', returncode: 1 }],
    env: ENV,
    steps: [{ argv: ['gh', 'api', 'x'], input: 'in' }],
  },
  {
    name: 'gh: expired at call time',
    fn: 'gh',
    procs: [...READY],
    steps: [{ argv: ['gh'], clock: 4_102_444_800 }],
  },
  {
    name: 'gh: within skew of expiry at call time',
    fn: 'gh',
    procs: [CAP, TOKEN('t', '2027-01-15T08:00:10Z')],
    steps: [{ argv: ['gh'] }],
  },
  { name: 'gh: helper missing', fn: 'gh', procs: ['missing'] },
  { name: 'gh: helper timeout', fn: 'gh', procs: ['timeout'] },
  { name: 'gh: helper os error', fn: 'gh', procs: ['other'] },
  { name: 'gh: capability probe nonzero', fn: 'gh', procs: [{ ...CAP, returncode: 2 }] },
  {
    name: 'gh: capability wrong value',
    fn: 'gh',
    procs: [{ stdout: '{"installation_token":"v0"}' }],
  },
  { name: 'gh: capability not an object', fn: 'gh', procs: [{ stdout: '[1]' }] },
  { name: 'gh: capability not json', fn: 'gh', procs: [{ stdout: 'nope' }] },
  { name: 'gh: token step nonzero', fn: 'gh', procs: [CAP, { stdout: 's', returncode: 1 }] },
  { name: 'gh: token step missing helper', fn: 'gh', procs: [CAP, 'missing'] },
  { name: 'gh: invalid expiry text', fn: 'gh', procs: [CAP, TOKEN('t', 'expired')] },
  { name: 'gh: stderr not json', fn: 'gh', procs: [CAP, { stdout: 't\n', stderr: 'plain' }] },
  { name: 'gh: stderr json list', fn: 'gh', procs: [CAP, { stdout: 't\n', stderr: '[1]' }] },
  {
    name: 'gh: expires_at not a string',
    fn: 'gh',
    procs: [CAP, { stdout: 't\n', stderr: '{"expires_at": 5}' }],
  },
  { name: 'gh: naive expiry', fn: 'gh', procs: [CAP, TOKEN('t', '2099-01-01T00:00:00')] },
  { name: 'gh: expiry in the past', fn: 'gh', procs: [CAP, TOKEN('t', '2001-01-01T00:00:00Z')] },
  { name: 'gh: expiry within skew', fn: 'gh', procs: [CAP, TOKEN('t', '2027-01-15T08:00:05Z')] },
  { name: 'gh: empty token', fn: 'gh', procs: [CAP, TOKEN('', FUTURE)] },
  { name: 'gh: token with inner space', fn: 'gh', procs: [CAP, TOKEN('a b', FUTURE)] },
  {
    name: 'gh: token with unicode space',
    fn: 'gh',
    procs: [CAP, { stdout: 'a b\n', stderr: JSON.stringify({ expires_at: FUTURE }) }],
  },
  {
    name: 'gh: offset expiry',
    fn: 'gh',
    procs: [CAP, TOKEN('t', '2099-01-01T05:30:00+05:30'), {}],
    steps: [{ argv: ['gh'] }],
  },
  {
    name: 'gh: fractional expiry',
    fn: 'gh',
    procs: [CAP, TOKEN('t', '2099-01-01T00:00:00.123456Z'), {}],
    steps: [{ argv: ['gh'] }],
  },
  {
    name: 'gh: space separator and basic format',
    fn: 'gh',
    procs: [CAP, TOKEN('t', '20990101 000000+0000'), {}],
    steps: [{ argv: ['gh'] }],
  },
  { name: 'gh: impossible date', fn: 'gh', procs: [CAP, TOKEN('t', '2099-02-30T00:00:00Z')] },
  {
    name: 'gh: hour 24 rolls to the next day',
    fn: 'gh',
    procs: [CAP, TOKEN('t', '2099-01-01T24:00:00Z'), {}],
    steps: [{ argv: ['gh'] }],
  },
  { name: 'gh: hour 24 with minutes', fn: 'gh', procs: [CAP, TOKEN('t', '2099-01-01T24:30:00Z')] },
  { name: 'gh: year 9999 rollover', fn: 'gh', procs: [CAP, TOKEN('t', '9999-12-31T24:00:00Z')] },
  {
    name: 'gh: hour-only time and short offset',
    fn: 'gh',
    procs: [CAP, TOKEN('t', '2099-01-01T00-00'), {}],
    steps: [{ argv: ['gh'] }],
  },
  {
    name: 'gh: comma fraction',
    fn: 'gh',
    procs: [CAP, TOKEN('t', '2099-01-01T00:00:00,5Z'), {}],
    steps: [{ argv: ['gh'] }],
  },
  {
    name: 'gh: offset with seconds',
    fn: 'gh',
    procs: [CAP, TOKEN('t', '2099-01-01T00:00:00+00:00:30'), {}],
    steps: [{ argv: ['gh'] }],
  },
  { name: 'gh: offset hour 24', fn: 'gh', procs: [CAP, TOKEN('t', '2099-01-01T00:00:00+24:00')] },
  sel('select: injected gh keeps the login and checkpoints', {
    injected: true,
    login: 'bob',
    checkpoint: true,
  }),
  sel('select: injected gh resolves the host login', { injected: true, login: null }),
  sel('select: injected with a different selection fails', {
    injected: true,
    login: 'bob',
    meta: { posting_identity: 'alice' },
  }),
  sel('select: App selected then helper ok', {
    app: 'ok',
    meta: { posting_identity: 'cq-review[bot]' },
    checkpoint: true,
  }),
  sel('select: no selection prefers the App', { app: 'ok', checkpoint: true }),
  sel('select: no selection falls back unattested', { app: 'helper-missing', checkpoint: true }),
  sel('select: fallback keeps an earlier identity_reason order', {
    app: 'helper-unavailable',
    meta: { identity_reason: 'old', a: 1 },
  }),
  sel('select: App selected never falls back', {
    app: 'helper-missing',
    meta: { posting_identity: 'cq-review[bot]' },
  }),
  sel('select: host identity selected and matching', {
    meta: { posting_identity: 'host-login' },
    checkpoint: true,
  }),
  sel('select: host identity selected but changed', { meta: { posting_identity: 'alice' } }),
  sel('select: falsy selection is no selection', { app: 'ok', meta: { posting_identity: '' } }),
  sel('select: non-string selection mismatches', { meta: { posting_identity: 5 } }),
  sel('select: empty login resolves the host login', { injected: true, login: '' }),
];

const toGh = (proc: Proc): ReturnType<IdentityDeps['run']> =>
  typeof proc === 'string'
    ? (() => {
        throw new ProcessLaunchError(proc === 'missing' ? 'missing' : 'other');
      })()
    : {
        returncode: JsonNumber.int(BigInt(proc.returncode ?? 0)),
        stdout: proc.stdout ?? '',
        stderr: proc.stderr ?? '',
      };

function runTs(sc: Scenario): Outcome {
  const calls: unknown[] = [];
  const procs = [...(sc.procs ?? [])];
  let clock = sc.clock ?? NOW;
  const deps: IdentityDeps = {
    now: () => clock,
    env: sc.env ?? {},
    run: (argv, options) => {
      calls.push({
        argv: [...argv],
        input: options.inputText,
        timeout: options.timeoutSec,
        env:
          options.env === null
            ? null
            : Object.fromEntries(Object.entries(options.env).sort(([a], [b]) => (a < b ? -1 : 1))),
      });
      return toGh(procs.shift() as Proc);
    },
  };
  try {
    if (sc.fn === 'gh') {
      const gh = authenticatedGh(deps, 'o/r');
      const results = (sc.steps ?? []).map((step) => {
        if (step.clock !== undefined) clock = step.clock;
        try {
          const r = gh(step.argv, { inputText: step.input ?? null });
          return { rc: Number(toPlainJson(r.returncode ?? null)), out: r.stdout, err: r.stderr };
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          return {
            err: (error as Error & { pythonError?: string }).pythonError ?? error.name,
            msg: error.message,
          };
        }
      });
      return { ok: results, calls };
    }
    const ghCalls: string[][] = [];
    const appGh: GhPort = () => ({
      returncode: JsonNumber.int(0n),
      stdout: 'app-login\n',
      stderr: '',
    });
    const hostGh: GhPort = (argv) => {
      ghCalls.push([...argv]);
      return {
        returncode: JsonNumber.int(0n),
        stdout: `${sc.host_login ?? 'host-login'}\n`,
        stderr: '',
      };
    };
    const checkpoints: unknown[] = [];
    const picked = selectReceiptIdentity({
      repo: 'o/r',
      meta: parseJsonValue(JSON.stringify(sc.meta ?? {})) as JsonObject,
      gh: hostGh,
      login: sc.login,
      injected: sc.injected ?? false,
      authenticate: () => {
        if (sc.app === 'ok') return appGh;
        throw new IdentityUnavailable(sc.app ?? 'helper-missing');
      },
      checkpoint: sc.checkpoint
        ? (login, reason) => checkpoints.push([login, toPlainJson(reason)])
        : null,
    });
    return {
      ok: {
        login: picked.login,
        meta: toPlainJson(picked.meta),
        app: picked.gh === appGh,
        gh_calls: ghCalls,
        checkpoints,
      },
      calls,
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return {
      err: (error as Error & { pythonError?: string }).pythonError ?? error.name,
      msg: error.message,
      calls,
    };
  }
}

const oracle = (): Outcome[] => {
  const result = spawnSync('python3', ['-I', ORACLE], {
    input: JSON.stringify(SCENARIOS),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`oracle failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Outcome[];
};

describe.skipIf(!HAVE_PYTHON)('review identity differential against crq_review_identity', () => {
  const expected = HAVE_PYTHON ? oracle() : [];
  test.each(SCENARIOS.map((sc, i) => [sc.name, sc, i] as const))('%s', (_name, sc, i) => {
    expect(runTs(sc)).toEqual(expected[i] as Outcome);
  });
});
