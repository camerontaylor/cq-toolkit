/**
 * Differential replay of the `process()` rung machine
 * (`src/queue-runner/repairRungMachine.ts` vs `apps/crq-python/crq_repair.py:486-789`).
 *
 * `apps/crq-python/fixtures/crq-rung-machine/cases.json` is emitted by
 * `repair_rung_machine_vectors.py`, which runs the PRODUCTION `crq_repair.process`
 * with only its effects injected (`dispatch`, `mechanical`, `retain`,
 * `retain_preserving_nested`, `blocked`, `rate_limit_pause`, `git`, the
 * `git cat-file` call, `random.random` and the clock) over a throwaway
 * directory. Per scenario it records the ordered seam trace, every file save as
 * text, and the value returned or the exception class that escaped.
 *
 * Each scenario is replayed here against the same scripted effects over an
 * in-memory filesystem; trace, saved texts and outcome must all match.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  JsonNumber,
  parseJsonValue,
  pythonNonFinite,
  toPlainJsonRetainingNumbers,
} from '../../src/policy/crq/jsonValue.js';
import { atomicJsonText } from '../../src/policy/crq/pythonJson.js';
import { isPyError, PyError, type PyErrorKind } from '../../src/queue-runner/pyErrors.js';
import { normalizePosixPath } from '../../src/queue-runner/repairCleanup.js';
import {
  runRepairProcess,
  type RepairRungEffects,
} from '../../src/queue-runner/repairRungMachine.js';

type Dict = Record<string, unknown>;

const FIXTURE = fileURLToPath(
  new URL('../../apps/crq-python/fixtures/crq-rung-machine/cases.json', import.meta.url),
);
const MESSAGE_KINDS = new Set([
  'ValueError',
  'KeyError',
  'RuntimeError',
  'OSError',
  'DetectorUnavailable',
]);
const ROOT = '/T/root';
const CWD = '/T/cwd';

interface Scenario {
  readonly name: string;
  readonly job: unknown;
  readonly config: unknown;
  readonly wt: string;
  readonly files: {
    readonly result: unknown;
    readonly progress: unknown;
    readonly progress_newer: boolean;
  };
  readonly trees: readonly string[];
  readonly plain_dirs: readonly string[];
  readonly git: Dict;
  readonly cat_file: Dict;
  readonly seams: Record<string, unknown[]>;
}

interface Expected {
  readonly trace: readonly unknown[];
  readonly writes: readonly { readonly path: string; readonly text: string }[];
  readonly returned?: unknown;
  readonly raises?: string;
  readonly message?: string;
  readonly is_value_error?: boolean;
}

interface Case {
  readonly name: string;
  readonly scenario: Scenario;
  readonly expected: Expected;
}

function loadCases(): readonly Case[] {
  const document = toPlainJsonRetainingNumbers(
    parseJsonValue(readFileSync(FIXTURE, 'utf8'), { parseConstant: pythonNonFinite }),
  ) as { readonly cases: readonly Case[] };
  return document.cases;
}

/** Deep copy that keeps `JsonNumber` instances (they are immutable). */
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value !== null && typeof value === 'object' && !(value instanceof JsonNumber)) {
    return Object.fromEntries(
      Object.entries(value as Dict).map(([key, entry]) => [key, clone(entry)]),
    ) as T;
  }
  return value;
}

/** A comparison form where int/float kinds and every key order are explicit. */
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
  const entries = Object.keys(item);
  if (entries.length !== 1 || entries[0] !== 'raise') return undefined;
  const info = (item as { raise: { kind: PyErrorKind; message: string } }).raise;
  return new PyError(info.kind, info.message);
}

function mtimes(scenario: Scenario): { result: bigint; progress: bigint } {
  const newer = scenario.files.progress_newer;
  return {
    result: newer ? 1_000_000_000n : 2_000_000_000n,
    progress: newer ? 2_000_000_000n : 1_000_000_000n,
  };
}

interface Run {
  readonly trace: unknown[];
  readonly writes: { path: string; text: string }[];
  readonly outcome: Dict;
}

async function replay(scenario: Scenario, nowStamp: string): Promise<Run> {
  const trace: unknown[] = [];
  const writes: { path: string; text: string }[] = [];
  const queues = new Map<string, unknown[]>(
    Object.entries(scenario.seams).map(([name, items]) => [name, clone(items)]),
  );
  const draws = (scenario.seams.random ?? []).map((draw) =>
    draw instanceof JsonNumber ? Number(draw.float ?? draw.integer) : Number(draw),
  );
  const next = (name: string): unknown => {
    const queue = queues.get(name) ?? [];
    if (queue.length === 0) throw new Exhausted(name);
    const item = queue.shift();
    const raised = raisingFrom(item);
    if (raised) throw raised;
    return item;
  };
  const scripted = (name: string): boolean => (queues.get(name) ?? []).length > 0;

  const exists = new Set<string>();
  const directories = new Set<string>();
  for (const tree of scenario.trees) {
    exists.add(tree);
    exists.add(`${tree}/.git`);
    directories.add(tree);
    directories.add(`${tree}/.git`);
  }
  for (const directory of scenario.plain_dirs) {
    exists.add(directory);
    directories.add(directory);
  }
  const stamps = mtimes(scenario);
  const nowMicros = BigInt(Date.parse(nowStamp)) * 1000n;
  const resultFile = scenario.files.result;
  const progressFile = scenario.files.progress;

  const effects: RepairRungEffects = {
    reads: {
      resultExists: async () => resultFile !== null,
      readResult: async () => clone(resultFile),
      progressExists: async () => progressFile !== null,
      resultMtimeNs: async () => stamps.result,
      progressMtimeNs: async () => stamps.progress,
      readProgress: async () => clone(progressFile),
      nowMicros: () => nowMicros,
      utc: () => nowStamp,
    },
    probes: {
      resolve: async (path) => normalizePosixPath(path.startsWith('/') ? path : `${CWD}/${path}`),
      isDirectory: async (path) => directories.has(path),
      exists: async (path) => exists.has(path),
    },
    ensureDirectory: async () => undefined,
    pathExists: async (path) => exists.has(path),
    writeJson: async (path, value) => {
      writes.push({ path, text: atomicJsonText(value as never) });
    },
    blocked: async () => {
      trace.push(['blocked']);
      return scripted('blocked') ? (next('blocked') as boolean) : false;
    },
    rateLimitPause: async (report, jobId) => {
      trace.push(['rate_limit_pause', snapshot(report), jobId]);
      return next('rate_limit_pause') as string;
    },
    retain: async (worktree, base, directory, options) => {
      trace.push(['retain', worktree, base, directory, options?.includeClean === true]);
      if (scripted('retain')) next('retain');
    },
    retainPreservingNested: async (worktree, base, directory) => {
      trace.push(['retain_preserving_nested', worktree, base, directory]);
      if (scripted('retain_preserving_nested')) next('retain_preserving_nested');
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
      const entry = scenario.cat_file[ref] as
        | { returncode: JsonNumber | number; stdout: string }
        | undefined;
      if (entry === undefined) return { returncode: 128, stdout: '' };
      return {
        returncode:
          entry.returncode instanceof JsonNumber
            ? Number(entry.returncode.integer)
            : entry.returncode,
        stdout: entry.stdout,
      };
    },
    dispatch: async (role, current, worktree, directory, judge) => {
      trace.push(['dispatch', snapshot(role), snapshot(current), worktree, directory, judge]);
      return next('dispatch');
    },
    mechanical: async (worktree, base, commits, jobId, directory) => {
      trace.push(['mechanical', worktree, base, snapshot(commits), jobId, directory]);
      return next('mechanical');
    },
    random: () => {
      trace.push(['random']);
      return draws.length > 0 ? (draws.shift() as number) : 0.99;
    },
  };

  let outcome: Dict;
  try {
    const returned = await runRepairProcess(
      {
        config: clone(scenario.config),
        job: clone(scenario.job),
        worktree: scenario.wt,
        root: ROOT,
      },
      effects,
    );
    outcome = { returned: snapshot(returned) };
  } catch (e) {
    if (!(e instanceof PyError)) throw e;
    outcome = { raises: e.kind };
    if (MESSAGE_KINDS.has(e.kind)) outcome.message = e.message;
    outcome.is_value_error = isPyError(e, 'ValueError');
  }
  return { trace, writes, outcome };
}

const cases = loadCases();
const NOW = '2026-11-26T12:00:00Z';

describe('repair rung machine vs the production process()', () => {
  it('replays the committed fixture (not an empty one)', () => {
    expect(cases.length).toBeGreaterThan(150);
    expect(new Set(cases.map((entry) => entry.name)).size).toBe(cases.length);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))('%s', async (_name, entry) => {
    const run = await replay(entry.scenario, NOW);
    const expected = entry.expected;
    expect(run.trace).toEqual(snapshot(expected.trace));
    expect(run.writes).toEqual(expected.writes);
    if (expected.raises !== undefined) {
      expect(run.outcome.raises).toBe(expected.raises);
      expect(run.outcome.is_value_error).toBe(expected.is_value_error);
      if (MESSAGE_KINDS.has(expected.raises)) expect(run.outcome.message).toBe(expected.message);
    } else {
      expect(run.outcome.raises).toBeUndefined();
      expect(run.outcome.returned).toEqual(snapshot(expected.returned));
    }
  });
});
