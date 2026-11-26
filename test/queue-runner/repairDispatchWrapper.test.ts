/**
 * Differential replay of the `dispatch()` wrapper
 * (`src/queue-runner/repairDispatchWrapper.ts` vs `apps/crq-python/crq_repair.py:329-461`).
 *
 * `apps/crq-python/fixtures/crq-dispatch-wrapper/cases.json` is emitted by
 * `repair_dispatch_wrapper_vectors.py`, which runs the PRODUCTION `crq_repair.dispatch`
 * with only its effects injected (the clock, git, the cooldown state, provider
 * readiness, the retention call, `blocked`, the scans, the snapshot reads and the four
 * driver entry points). Per scenario it records the ordered seam trace (each driver and
 * retention call with the CQ_* environment it ran under), the directories created, the
 * environment afterwards and the value returned or the exception class that escaped.
 *
 * Each scenario is replayed here against the same scripted effects; every one of those
 * must match.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  JsonNumber,
  parseJsonValue,
  toPlainJson,
  toPlainJsonRetainingNumbers,
} from '../../src/policy/crq/jsonValue.js';
import { PyError, type PyErrorKind } from '../../src/queue-runner/pyErrors.js';
import {
  dispatch,
  reviewDiffSections,
  type DispatchEffects,
} from '../../src/queue-runner/repairDispatchWrapper.js';

type Dict = Record<string, unknown>;

const FIXTURE = fileURLToPath(
  new URL('../../apps/crq-python/fixtures/crq-dispatch-wrapper/cases.json', import.meta.url),
);
const MESSAGE_KINDS = new Set(['ValueError', 'KeyError', 'RuntimeError', 'OSError']);
const ENV_KEYS = ['CQ_WORK_ID', 'CQ_RUN_ID', 'CQ_ROLE', 'CQ_TASK', 'CQ_PARENT_WORK_ID'] as const;
const ROOT = '/T';
const NOW_MICROS = BigInt(Date.parse('2026-01-01T00:00:00.500Z')) * 1000n;

interface Scenario {
  readonly name: string;
  readonly config: unknown;
  readonly role: unknown;
  readonly job: unknown;
  readonly judge: boolean;
  readonly seams: Record<string, unknown>;
}
interface Case {
  readonly name: string;
  readonly scenario: Scenario;
  readonly expected: Dict;
}

/**
 * The fixture is read twice. The retaining read keeps `7.0` a float, which only the job's
 * `run`, `job` and `review_diff` (rendered by Python `str()`) can observe; every other
 * number is the plain JavaScript value the production caller would hold.
 */
const fixtureText = readFileSync(FIXTURE, 'utf8');
const retained = toPlainJsonRetainingNumbers(parseJsonValue(fixtureText)) as { cases: Case[] };

/** Retained numbers become plain numbers, except under `keepFloats` where they stay `JsonNumber`. */
function plain(value: unknown, keep = false): unknown {
  if (value instanceof JsonNumber) return keep ? value : toPlainJson(value);
  if (Array.isArray(value)) return value.map((v) => plain(v, keep));
  if (isDictLoose(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v, keep)]));
  }
  return value;
}
function isDictLoose(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !(v instanceof JsonNumber);
}
/** `structuredClone` that keeps the immutable `JsonNumber` instances intact. */
function clone<T>(value: T): T {
  if (value instanceof JsonNumber) return value;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (isDictLoose(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T;
  }
  return value;
}
const IDENTITY_FIELDS = ['run', 'job', 'review_diff'];
function scenarioOf(raw: Scenario): Scenario {
  const job = isDict(raw.job)
    ? Object.fromEntries(
        Object.entries(raw.job).map(([k, v]) => [
          k,
          v instanceof JsonNumber && IDENTITY_FIELDS.includes(k) ? v : plain(v),
        ]),
      )
    : raw.job;
  return { ...(plain({ ...raw, job: null }) as Scenario), job };
}

const cases = retained.cases;

const isRaise = (v: unknown): v is { raise: { kind: PyErrorKind; message: string } } =>
  typeof v === 'object' && v !== null && Object.keys(v).length === 1 && 'raise' in v;

const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `budget()` helper the oracle traces: `config.repair.budget.wall_clock_min` or null. */
function budgetOf(config: unknown): unknown {
  const repair = isDict(config) ? config.repair : undefined;
  const section = isDict(repair) ? repair.budget : undefined;
  return isDict(section) ? (section.wall_clock_min ?? null) : null;
}

async function replay(scenario: Scenario): Promise<Dict> {
  const trace: unknown[] = [];
  const seams = plain(scenario.seams) as Record<string, unknown[]>;
  const env: Record<string, string | null> = Object.fromEntries(ENV_KEYS.map((k) => [k, null]));
  env.CQ_PARENT_WORK_ID = 'stale-parent';
  const before = { ...env };
  const dirs = new Set<string>();
  let tick = 0;

  const answer = (name: string, fallback?: unknown): unknown => {
    const items = seams[name];
    if (!Array.isArray(items) || items.length === 0) {
      if (fallback === undefined) throw new Error(`scenario ran out of ${name} answers`);
      return clone(fallback);
    }
    const item = items.shift();
    if (isRaise(item)) throw new PyError(item.raise.kind, item.raise.message);
    return item;
  };
  const driver =
    (name: string, judgeFlag: (judge: boolean) => unknown) =>
    (config: Dict, role: unknown, job: Dict, wt: string, directory: string, judge = false) => {
      trace.push([
        'driver',
        name,
        budgetOf(config),
        clone(role),
        clone(job),
        wt,
        directory,
        judgeFlag(judge),
        { ...env },
      ]);
      return Promise.resolve(answer('driver', { stop: 'ok' }));
    };

  const effects: DispatchEffects = {
    monotonic: () => {
      const scripted = seams.monotonic;
      tick =
        Array.isArray(scripted) && scripted.length > 0 ? (scripted.shift() as number) : tick + 1;
      trace.push(['monotonic', tick]);
      return tick;
    },
    utc: () => {
      trace.push(['utc']);
      return (seams.utc as unknown as string | undefined) ?? '2026-01-01T00:00:00Z';
    },
    nowMicros: () => NOW_MICROS,
    git: (wt, ...args) => {
      trace.push(['git', wt, ...args]);
      return Promise.resolve(
        answer('git', args[0] === 'rev-parse' ? 'b'.repeat(40) : '') as string,
      );
    },
    providerCooldowns: () => {
      trace.push(['cooldowns']);
      const state = answer('cooldowns', {}) as Record<string, string>;
      return Promise.resolve(new Map(Object.entries(state)));
    },
    providerReady: (role) => {
      trace.push(['ready', clone(role)]);
      return answer('ready', true);
    },
    rememberProviderLimit: (provider, report) => {
      trace.push(['remember', provider, clone(report)]);
      return Promise.resolve(answer('remember') as string);
    },
    blocked: (repair) => {
      trace.push(['blocked', clone(repair)]);
      return answer('blocked', false);
    },
    retainPreservingNested: (wt, base, directory) => {
      trace.push(['retain', wt, base, directory, { ...env }]);
      answer('retain', null);
      return Promise.resolve();
    },
    withCorrelation: async (values, fn) => {
      const saved = { ...env };
      env.CQ_PARENT_WORK_ID = null;
      Object.assign(env, values);
      try {
        return await fn();
      } finally {
        Object.assign(env, saved);
      }
    },
    mkdir: (directory) => {
      const parts = directory.slice(ROOT.length + 1).split('/');
      for (let i = 1; i <= parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
      return Promise.resolve();
    },
    requireCanonicalDelivery: (job) => {
      trace.push(['canonical', clone(job)]);
      answer('canonical', null);
      return Promise.resolve();
    },
    sourceSnapshot: (config, job) => {
      trace.push(['snapshot', clone(job), budgetOf(config)]);
      return Promise.resolve(answer('snapshot', { path: 'src/a.py', source: 'x' }));
    },
    triageContextSafe: (context, output) => {
      trace.push(['scan', clone(context), output]);
      return Promise.resolve(answer('scan', true));
    },
    atomicWrite: (path, value) => {
      trace.push(['atomic', path, clone(value)]);
      return Promise.resolve();
    },
    drivers: {
      cqJudge: driver('cq.judge', () => null),
      cqInvoke: driver('cq.invoke', () => null),
      codexInvoke: driver('codex.invoke', (judge) => judge),
      paseoInvoke: driver('paseo.invoke', () => null),
    },
  };
  const directory = typeof seams.directory === 'string' ? seams.directory : `${ROOT}/out`;

  let outcome: Dict;
  try {
    const returned = await dispatch(
      effects,
      plain(scenario.config),
      clone(scenario.role),
      clone(scenario.job),
      `${ROOT}/wt`,
      directory,
      scenario.judge,
    );
    outcome = { returned };
  } catch (e) {
    if (!(e instanceof PyError)) throw e;
    outcome = MESSAGE_KINDS.has(e.kind)
      ? { raises: e.kind, message: e.message }
      : { raises: e.kind };
  }
  return {
    trace,
    ...outcome,
    env_after: { ...env },
    env_restored: ENV_KEYS.every((k) => env[k] === before[k]),
    dirs: [...dirs].sort(),
  };
}

describe('dispatch() wrapper vs the Python oracle', () => {
  it('replays a populated fixture', () => {
    expect(cases.length).toBeGreaterThan(120);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    expect(plain(await replay(scenarioOf(c.scenario)))).toEqual(plain(c.expected));
  });
});

describe('reviewDiffSections', () => {
  it('splits per diff --git header and keeps text before the first header generic', () => {
    expect(reviewDiffSections('pre\ndiff --git a/x b/x\n+1\ndiff --git a/y b/y\r\n+2')).toEqual([
      ['review-diff.txt', 'pre'],
      ['x', 'diff --git a/x b/x\n+1'],
      ['y', 'diff --git a/y b/y\n+2'],
    ]);
  });
});
