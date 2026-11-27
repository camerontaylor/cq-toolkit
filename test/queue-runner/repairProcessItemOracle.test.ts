/**
 * Composed differential oracle for `bindRepairProcessItem`
 * (`src/queue-runner/repairProcess.ts`) against the production Python
 * `crq_repair.process_item` running the production `crq_repair.process`.
 *
 * `apps/crq-python/fixtures/crq-process-item/cases.json` is emitted by
 * `repair_process_item_vectors.py` over ordinary synthetic fixtures: a throwaway
 * directory, injected dispatch/mechanical/retain/git/clock seams, no network,
 * provider, credential or signer. Each scenario is replayed here through the
 * real item loop bound to the real rung machine over the same scripted seams;
 * return value, seam trace, every file save, the `state/repair` tree left behind,
 * the caller-visible job list (order and chained `repair_base`) and the escaping
 * error must all match.
 *
 * The rung machine's reads carry no job id, so the rig tracks the job being
 * processed through the `ensureDirectory(<root>/state/repair/<job>)` call that
 * opens every `process`.
 *
 * NON-DICT PRIOR `result.json` (list, string, number, float, null, bool). Observed,
 * not decided; no error semantics were changed in either language.
 *
 *   Python, real `pending`: AttributeError "'<type>' object has no attribute 'get'"
 *     raised by `pending()` (`prior.get('retry_after')`) BEFORE `process` runs.
 *     State left: the prior file untouched, no directory/file written, no worktree
 *     add, no dispatch; the item stops at that job and the error escapes (fails
 *     closed; the later jobs never start, bases unchanged).
 *   Python, `pending` stubbed true: the same AttributeError, now from `process`'s own
 *     `prior.get`; same (empty) state left behind.
 *   TS: the item loop's `pending` is an injected effect with no binding yet, so
 *     this test's `pending` mirrors Python's and throws the same PyError. With
 *     `pending` true the bound `process` rejects with the rung machine's PyError
 *     AttributeError, message identical to Python, and `bindRepairProcess`'s
 *     RepairItemShapeError is NOT reached (it only guards a non-object RETURN value,
 *     which no non-dict prior can produce). No divergence was observed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { RepairItemShapeError } from '../../src/ops/crq/internal/repairItemLoop.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  pythonNonFinite,
  toPlainJsonRetainingNumbers,
} from '../../src/policy/crq/jsonValue.js';
import { pythonTruthy } from '../../src/policy/crq/repairBinding.js';
import { atomicJsonText } from '../../src/policy/crq/pythonJson.js';
import { PyError, type PyErrorKind } from '../../src/queue-runner/pyErrors.js';
import { normalizePosixPath } from '../../src/queue-runner/repairCleanup.js';
import { bindRepairProcessItem, toJsonValue } from '../../src/queue-runner/repairProcess.js';
import { pyTypeName } from '../../src/queue-runner/repairProgressSelection.js';
import type { RepairRungEffects } from '../../src/queue-runner/repairRungMachine.js';

type Dict = Record<string, unknown>;

const FIXTURE = fileURLToPath(
  new URL('../../apps/crq-python/fixtures/crq-process-item/cases.json', import.meta.url),
);
const ROOT = '/T/root';
const STATE = `${ROOT}/state/repair/`;
const NOW = '2026-11-26T12:00:00Z';

interface Scenario {
  readonly name: string;
  readonly jobs: unknown[];
  readonly config: Dict & { worktree_root: string; clone: string };
  readonly files: Record<string, Dict>;
  readonly triage: Dict;
  readonly trees: readonly string[];
  readonly plain_dirs: readonly string[];
  readonly git: Dict;
  readonly pending: 'real' | 'true';
  readonly seams: Record<string, unknown[]>;
}

interface Expected {
  readonly trace: readonly unknown[];
  readonly writes: readonly { readonly path: string; readonly text: string }[];
  readonly jobs_after: readonly { job: unknown; repair_base: unknown }[];
  readonly state: readonly string[];
  readonly returned?: unknown;
  readonly raises?: string;
  readonly message?: string;
}

interface Case {
  readonly name: string;
  readonly scenario: Scenario;
  readonly expected: Expected;
}

const cases = (
  toPlainJsonRetainingNumbers(
    parseJsonValue(readFileSync(FIXTURE, 'utf8'), { parseConstant: pythonNonFinite }),
  ) as { cases: Case[] }
).cases;

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value !== null && typeof value === 'object' && !(value instanceof JsonNumber)) {
    return Object.fromEntries(
      Object.entries(value as Dict).map(([key, entry]) => [key, clone(entry)]),
    ) as T;
  }
  return value;
}

function canonical(value: unknown): unknown {
  if (value instanceof JsonNumber) {
    return value.kind === 'int' ? { int: String(value.integer) } : { float: String(value.float) };
  }
  if (typeof value === 'bigint') return { int: String(value) };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { int: String(value) } : { float: String(value) };
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Dict)[key])]),
    );
  }
  return value;
}
const snapshot = (value: unknown): unknown => JSON.parse(JSON.stringify(canonical(value)));

class Exhausted {
  constructor(readonly seam: string) {}
}

function raisingFrom(item: unknown): PyError | undefined {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined;
  if (Object.keys(item).join() !== 'raise') return undefined;
  const info = (item as { raise: { kind: PyErrorKind; message: string } }).raise;
  return new PyError(info.kind, info.message);
}

interface Observed {
  readonly trace: unknown[];
  readonly writes: { path: string; text: string }[];
  readonly jobsAfter: { job: unknown; repair_base: unknown }[];
  readonly state: string[];
  readonly returned?: string | null;
  readonly error?: unknown;
}

async function replay(scenario: Scenario): Promise<Observed> {
  const trace: unknown[] = [];
  const writes: { path: string; text: string }[] = [];
  const queues = new Map<string, unknown[]>(
    Object.entries(scenario.seams).map(([name, items]) => [name, clone(items)]),
  );
  const next = (name: string): unknown => {
    const queue = queues.get(name) ?? [];
    if (queue.length === 0) throw new Exhausted(name);
    const item = queue.shift();
    const raised = raisingFrom(item);
    if (raised) throw raised;
    return item;
  };
  const scripted = (name: string, fallback: unknown): unknown => {
    trace.push([name]);
    return (queues.get(name) ?? []).length > 0 ? next(name) : fallback;
  };

  const exists = new Set<string>();
  const directories = new Set<string>();
  for (const tree of scenario.trees) {
    for (const path of [tree, `${tree}/.git`]) {
      exists.add(path);
      directories.add(path);
    }
  }
  for (const directory of scenario.plain_dirs) {
    exists.add(directory);
    directories.add(directory);
  }
  const stateDirs = new Set<string>(Object.keys(scenario.files));
  const stateFiles = new Set<string>();
  for (const [jobId, entry] of Object.entries(scenario.files)) {
    for (const key of ['result', 'progress'])
      if (key in entry) stateFiles.add(`${jobId}/${key}.json`);
  }
  let current = '';
  const nowMicros = BigInt(Date.parse(NOW)) * 1000n;
  const fileOf = (key: 'result' | 'progress'): unknown =>
    clone(scenario.files[current]?.[key] as unknown);

  const effects: RepairRungEffects = {
    reads: {
      resultExists: async () => 'result' in (scenario.files[current] ?? {}),
      readResult: async () => fileOf('result'),
      progressExists: async () => 'progress' in (scenario.files[current] ?? {}),
      resultMtimeNs: async () => 1_000_000_000n,
      progressMtimeNs: async () => 2_000_000_000n,
      readProgress: async () => fileOf('progress'),
      nowMicros: () => nowMicros,
      utc: () => NOW,
    },
    probes: {
      resolve: async (path) => normalizePosixPath(path.startsWith('/') ? path : `/T/cwd/${path}`),
      isDirectory: async (path) => directories.has(path),
      exists: async (path) => exists.has(path),
    },
    ensureDirectory: async (path) => {
      current = path.slice(STATE.length);
      stateDirs.add(current);
    },
    pathExists: async (path) => exists.has(path),
    writeJson: async (path, value) => {
      writes.push({ path, text: atomicJsonText(value as never) });
      stateFiles.add(path.slice(STATE.length));
    },
    blocked: async () => scripted('blocked', false) as boolean,
    rateLimitPause: async (report, jobId) => {
      trace.push(['rate_limit_pause', snapshot(report), jobId]);
      return next('rate_limit_pause') as string;
    },
    retain: async (worktree, base, directory, options) => {
      trace.push(['retain', worktree, base, directory, options?.includeClean === true]);
    },
    retainPreservingNested: async (worktree, base, directory) => {
      trace.push(['retain_preserving_nested', worktree, base, directory]);
    },
    git: async (cwd, ...args) => {
      trace.push(['git', String(cwd), ...args]);
      const answer = scenario.git[args.join(' ')];
      if (answer === undefined) return '';
      const raised = raisingFrom(answer);
      if (raised) throw raised;
      return answer as string;
    },
    catFileBlob: async (cwd, ref) => {
      trace.push(['cat_file', cwd, ref]);
      return { returncode: 128, stdout: '' };
    },
    dispatch: async (role, job, worktree, directory, judge) => {
      trace.push(['dispatch', snapshot(role), snapshot(job), worktree, directory, judge]);
      return next('dispatch');
    },
    mechanical: async (worktree, base, commits, jobId, directory) => {
      trace.push(['mechanical', worktree, base, snapshot(commits), jobId, directory]);
      return next('mechanical');
    },
    random: () => {
      trace.push(['random']);
      return 0.99;
    },
  };

  const pending = async (jobId: string): Promise<boolean> => {
    if (scenario.pending === 'true') return true;
    const entry = scenario.files[jobId];
    if (entry === undefined || !('result' in entry)) return true;
    const prior = entry.result;
    if (
      prior === null ||
      typeof prior !== 'object' ||
      Array.isArray(prior) ||
      prior instanceof JsonNumber
    ) {
      throw new PyError('AttributeError', `'${pyTypeName(prior)}' object has no attribute 'get'`);
    }
    return pythonTruthy(toJsonValue((prior as Dict).retry_after));
  };

  const run = bindRepairProcessItem(
    { config: clone(scenario.config), root: ROOT, effects },
    {
      runnerDisabled: async () => scripted('runner_disabled', false) as boolean,
      narrate: (message) => {
        trace.push(['narrate', message]);
      },
      blocked: () => {
        trace.push(['blocked']);
        return (queues.get('blocked') ?? []).length > 0 ? (next('blocked') as boolean) : false;
      },
      dispatchPaused: async () => scripted('dispatch_paused', null) as string | null,
      readTriageRow: async (findingId) => {
        const row = scenario.triage[findingId];
        return row === undefined ? undefined : JSON.stringify(row);
      },
      pending,
      worktreePath: (name) => `${scenario.config.worktree_root}/${name}`,
      worktreeExists: async (path) => exists.has(path),
      addWorktree: async (path, base) => {
        trace.push(['worktree_add', path, base, scenario.config.clone]);
        return (queues.get('worktree_add') ?? []).length > 0 ? (next('worktree_add') as number) : 0;
      },
    },
  );
  const jobs = scenario.jobs.map((job) => toJsonValue(clone(job)) as JsonObject);
  let returned: string | null | undefined;
  let error: unknown;
  try {
    returned = await run(jobs, {
      publishRefusal: () => {
        trace.push(['publish_refusal']);
      },
    });
  } catch (e) {
    if (e instanceof Exhausted) throw new Error(`scenario ran out of ${e.seam}`);
    error = e;
  }
  const entries = [...stateDirs, ...stateFiles].map((path) => path.split('/'));
  entries.sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return (a[i] as string) < (b[i] as string) ? -1 : 1;
    }
    return a.length - b.length;
  });
  const state = entries.map((parts) => {
    const joined = parts.join('/');
    return stateDirs.has(joined) ? `${joined}/` : joined;
  });
  return {
    trace,
    writes,
    state,
    jobsAfter: jobs.map((job) => ({
      job: job.get('job') ?? null,
      repair_base: job.get('repair_base') ?? null,
    })),
    ...(error === undefined ? { returned: returned ?? null } : { error }),
  };
}

/** The kind and message Python would report for what escaped the TS composition. */
function describeError(error: unknown): { kind: string; message: string } {
  if (error instanceof PyError) return { kind: error.kind, message: error.message };
  if (error instanceof RepairItemShapeError) {
    const match = /^(\w+Error): ([\s\S]*)$/.exec(error.message);
    return match
      ? { kind: match[1] as string, message: match[2] as string }
      : { kind: 'RepairItemShapeError', message: error.message };
  }
  if (error instanceof Error && error.message === 'repair worktree creation failed') {
    return { kind: 'RuntimeError', message: error.message };
  }
  throw error;
}

const NON_DICT = /^non-dict prior (\w+): pending (real|true)$/;

describe('bindRepairProcessItem vs production process_item over process', () => {
  it('replays the committed fixture (not an empty one)', () => {
    expect(cases.length).toBeGreaterThan(30);
    expect(new Set(cases.map((entry) => entry.name)).size).toBe(cases.length);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))('%s', async (_name, entry) => {
    const observed = await replay(entry.scenario);
    const expected = entry.expected;
    expect(observed.trace).toEqual(snapshot(expected.trace));
    expect(observed.writes).toEqual(expected.writes);
    expect(observed.state).toEqual(expected.state);
    expect(observed.jobsAfter).toEqual(expected.jobs_after);
    if (expected.raises !== undefined) {
      const { kind, message } = describeError(observed.error);
      expect({ kind, message }).toEqual({ kind: expected.raises, message: expected.message });
    } else {
      expect(observed.error).toBeUndefined();
      expect(observed.returned).toEqual(expected.returned ?? null);
    }
  });

  // Pin both sides of the non-dict contract explicitly (see the file header).
  describe.each(
    cases.filter((entry) => NON_DICT.test(entry.name)).map((e) => [e.name, e] as const),
  )('%s contract', (name, entry) => {
    const [, label, mode] = NON_DICT.exec(name) as RegExpExecArray;
    const typeName = {
      list: 'list',
      string: 'str',
      number: 'int',
      float: 'float',
      null: 'NoneType',
      bool: 'bool',
    }[label as string];
    const message = `'${typeName}' object has no attribute 'get'`;

    it('Python: AttributeError, fails closed, state untouched', () => {
      expect(entry.expected.raises).toBe('AttributeError');
      expect(entry.expected.message).toBe(message);
      expect(entry.expected.writes).toEqual([]);
      expect(entry.expected.state).toEqual(['crq-R-F1/', 'crq-R-F1/result.json']);
      expect(entry.expected.trace.map((t) => (t as string[])[0])).toEqual([
        'runner_disabled',
        'blocked',
        'dispatch_paused',
      ]);
      expect(entry.expected.jobs_after.map((j) => j.repair_base)).toEqual([
        'a'.repeat(40),
        'a'.repeat(40),
      ]);
    });

    it(`TS: ${mode === 'true' ? 'rung machine PyError' : 'injected pending PyError'}, same kind and message`, async () => {
      const observed = await replay(entry.scenario);
      expect(observed.error).toBeInstanceOf(PyError);
      expect(observed.error).not.toBeInstanceOf(RepairItemShapeError);
      expect(describeError(observed.error)).toEqual({ kind: 'AttributeError', message });
      expect(observed.writes).toEqual([]);
    });
  });
});
