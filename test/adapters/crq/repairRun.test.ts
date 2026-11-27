/**
 * Differential replay of the `run` result lane
 * (`src/adapters/crq/repairRun.ts` vs `apps/crq-python/crq_repair.py:972-1073,
 * 1558-1698`).
 *
 * `apps/crq-python/fixtures/crq-run-lane/cases.json` is emitted by
 * `repair_run_vectors.py`, which runs the PRODUCTION `run`, `drain` and `main`
 * with only their effects injected, and records per scenario the ordered seam
 * trace and the value (or exception class) that came out. Each scenario is
 * replayed here against the same scripted effects; the trace and the outcome
 * must match. The inbox and queue reads are replayed from the outcomes the
 * oracle probed with Python's own `json.loads(path.read_text())`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  drain,
  finishDrain,
  lockedResult,
  narrateMainFailure,
  runTriageDryRun,
  type Dict,
  type GroupMap,
  type RepairDrainEffects,
  type RepairRunOutcome,
} from '../../../src/adapters/crq/repairRun.js';
import { PyError, type PyErrorKind } from '../../../src/queue-runner/pyErrors.js';

const FIXTURE = fileURLToPath(
  new URL('../../../apps/crq-python/fixtures/crq-run-lane/cases.json', import.meta.url),
);
const MESSAGE_KINDS = new Set([
  'ValueError',
  'KeyError',
  'RuntimeError',
  'OSError',
  'AttributeError',
  'TypeError',
]);
/** Python subclasses the fixture records by class name, folded to the port's error kind. */
const KIND_OF: Readonly<Record<string, string>> = {
  FileExistsError: 'OSError',
  FileNotFoundError: 'OSError',
  IsADirectoryError: 'OSError',
  JSONDecodeError: 'ValueError',
  UnicodeDecodeError: 'ValueError',
};

type Read = { ok: unknown } | { raise: { kind: string; message: string } };
interface Scenario {
  readonly name: string;
  readonly kind: 'drain' | 'run' | 'main';
  readonly config: Dict;
  readonly argv: string[];
  readonly answers: Record<string, unknown>;
  readonly lock: 'free' | 'held';
  readonly state_dir_blocked: boolean;
  readonly relock?: boolean;
  readonly reads?: Record<string, Read>;
}
interface Case {
  readonly name: string;
  readonly scenario: Scenario;
  readonly expected: Dict;
}

const cases = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: Case[] }).cases;

const isRaise = (v: unknown): v is { raise: { kind: PyErrorKind; message: string } } =>
  typeof v === 'object' && v !== null && 'raise' in v && Object.keys(v).length === 1;

/** Python's `str(exc)`: a `KeyError` carries the repr of its key. */
function pyError(kind: string, message: string): PyError {
  const text = kind === 'KeyError' ? `'${message}'` : message;
  return new PyError((KIND_OF[kind] ?? kind) as PyErrorKind, text);
}

/** The oracle records a message only for the base classes; subclasses are recorded by name alone. */
function nameOf(e: unknown, withMessage: boolean): { name: string; message?: string } {
  if (e instanceof PyError)
    return withMessage && MESSAGE_KINDS.has(e.kind)
      ? { name: e.kind, message: e.message }
      : { name: e.kind };
  throw e;
}

async function replay(scenario: Scenario, expected: Dict): Promise<Dict> {
  const trace: unknown[] = [];
  const answers = structuredClone(scenario.answers) as Record<string, unknown>;
  const answer = (seam: string): unknown => {
    const list = answers[seam] as unknown[] | undefined;
    if (list === undefined && seam === 'worker_limit') return null;
    if (list === undefined && seam === 'drain_items') return [];
    if (list === undefined || list.length === 0) throw new Error(`scenario ran out of ${seam}`);
    const item = list.shift();
    if (isRaise(item)) throw pyError(item.raise.kind, item.raise.message);
    return item;
  };
  const config = structuredClone(scenario.config);
  const unreadable = new Set(answers['unreadable'] as string[] | undefined);
  const pending = new Set(answers['pending'] as string[] | undefined);
  const read = (path: string): unknown => {
    const outcome = scenario.reads?.[path];
    if (outcome === undefined) throw new PyError('OSError', `no such file: ${path}`);
    if ('raise' in outcome) throw pyError(outcome.raise.kind, outcome.raise.message);
    return structuredClone(outcome.ok);
  };
  let held = scenario.lock === 'held';
  const lock = {
    ensureStateDirectory: (): Promise<void> => {
      if (scenario.state_dir_blocked)
        return Promise.reject(new PyError('OSError', 'state/repair is not a directory'));
      return Promise.resolve();
    },
    withServiceLock: async <T>(body: () => Promise<T>) => {
      if (held) return { held: false } as const;
      held = true;
      try {
        return { held: true, value: await body() } as const;
      } finally {
        held = false;
      }
    },
  };
  const effects: RepairDrainEffects = {
    narrate: (line) => {
      trace.push(['narrate', line]);
    },
    runnerDisabled: () => {
      trace.push(['runner_disabled']);
      return Promise.resolve(answer('runner_disabled') as boolean);
    },
    workerLimit: (c) => {
      trace.push(['worker_limit', structuredClone(c)]);
      answer('worker_limit');
      return Promise.resolve();
    },
    dispatchPaused: (c) => {
      trace.push(['dispatch_paused', structuredClone(c)]);
      return Promise.resolve(answer('dispatch_paused') as string | null);
    },
    fetchClone: (c) => {
      trace.push(['fetch_clone', structuredClone(c)]);
      return Promise.resolve(answer('fetch_clone') as string | null);
    },
    triagePhase: (c) => {
      trace.push(['triage_phase', structuredClone(c), false]);
      return Promise.resolve(answer('triage_phase') as Dict | null);
    },
    drainOrder: () => {
      trace.push(['drain_order']);
      return Promise.resolve(answer('drain_order') as string[]);
    },
    readInboxJob: (id) => Promise.resolve().then(() => read(`state/repair/inbox/${id}.json`)),
    readQueue: () =>
      Promise.resolve().then(() =>
        scenario.reads?.['state/queue.json'] === undefined
          ? { items: [] }
          : read('state/queue.json'),
      ),
    holdBackfillGroups: (groups) => {
      trace.push(['hold_backfill_groups', [...groups].map(([k, v]) => [k, [...v]])]);
      const dropped = new Set(answers['hold'] as string[] | undefined);
      return Promise.resolve(
        new Map([...groups].filter(([item]) => !dropped.has(item))) as GroupMap,
      );
    },
    drainJob: (_config, queue, id) => {
      trace.push(['drain_job', id, structuredClone(queue)]);
      const table = (answers['drain_job'] ?? {}) as Record<string, [string, Dict | null]>;
      return Promise.resolve(structuredClone(table[id] ?? ['skip', null]));
    },
    unreadableResult: (id) => Promise.resolve(unreadable.has(id)),
    pending: (id) => Promise.resolve(pending.has(id)),
    drainItems: (_config, groups, order) => {
      trace.push(['drain_items', [...groups].map(([k, v]) => [k, [...v]]), [...order]]);
      return Promise.resolve(answer('drain_items') as string[]);
    },
  };
  try {
    if (scenario.kind === 'drain') {
      const returned = await drain(config, effects);
      return { trace, returned };
    }
    if (scenario.kind === 'run') {
      const dry = scenario.argv.includes('--triage-dry-run');
      const outcome: RepairRunOutcome = dry
        ? await runTriageDryRun(config, {
            ...lock,
            triagePhase: (c, options) => {
              trace.push(['triage_phase', structuredClone(c), options.dryRun]);
              return Promise.resolve(answer('triage_phase') as Dict | null);
            },
          })
        : await lockedResult(lock, () => {
            trace.push(['drain']);
            return Promise.resolve(finishDrain(answer('drain') as Dict));
          });
      return {
        trace,
        returned: [outcome.exitCode, outcome.result],
        ...(scenario.relock === true ? { relocked: !held } : {}),
      };
    }
    // main(): one artifact per path; a failure narrates twice and exits 1.
    try {
      trace.push(['run', scenario.argv]);
      const [code, result] = answer('run') as [number, Dict | null];
      if (result !== null) trace.push(['write_result', result]);
      return { trace, returned: code };
    } catch (e) {
      let narrations = 0;
      const failed = narrateMainFailure(e, (line) => {
        narrations += 1;
        if (narrations === 1) trace.push(['narrate', line]);
        else {
          // Python narrates `traceback.format_exc()`; the frames are not portable, so
          // the oracle pins the final line (`Class: message`, or the bare class).
          expect(line.startsWith('Traceback (most recent call last):\n')).toBe(true);
          expect(line.endsWith('\n')).toBe(true);
          const parts = line.split('\n');
          trace.push(['narrate', { traceback_ends_with: `${parts[parts.length - 2]}\n` }]);
        }
      });
      trace.push(['write_result', failed.artifact]);
      return { trace, returned: failed.exitCode };
    }
  } catch (e) {
    const { name, message } = nameOf(e, 'message' in expected);
    return { trace, raises: name, ...(message === undefined ? {} : { message }) };
  }
}

/** The fixture's expected outcome with Python's subclass names folded to the port's kinds. */
function fold(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fold);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === 'raises' && typeof v === 'string' ? (KIND_OF[v] ?? v) : fold(v),
      ]),
    );
  }
  return value;
}

describe('run result lane vs the Python oracle', () => {
  it('replays a populated fixture', () => {
    expect(cases.length).toBeGreaterThan(60);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const expected = { ...c.expected };
    delete expected['reads'];
    expect(await replay(c.scenario, expected)).toEqual(fold(expected));
  });
});
