import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bindSelect, type SelectCollaborators } from '../../../src/adapters/crq/coverageSelect.js';
import { JsonNumber, pythonNumberText } from '../../../src/policy/crq/jsonValue.js';
import { PyError, type PyErrorClass } from '../../../src/policy/crq/pyCompat.js';
import type { Item, Queue } from '../../../src/queue-runner/coverageUsage.js';
import { oraclePython } from '../../helpers/oraclePython.js';

/**
 * Replays the Python 3.14 oracle (apps/crq-python/coverage_select_vectors.py): the
 * production `backfill_runtime.select` over the real `backfill_jobs`,
 * `review_ledger` and `rank4_gate`, with the live collaborators (rollout config,
 * ledger fetch, coverage snapshot reader/writer, the reviewer spawn) scripted
 * identically on both sides. The return value, the queue and log left behind, and
 * the ordered collaborator trace are compared; a raised exception compares by
 * Python class (messages are the port's own).
 *
 * The TS queue is production-shaped: unsafe integers are bigints and unsafe
 * floats are `JsonNumber` floats (the fixture tags them `$int` / `$float`).
 */
type Plain = Record<string, unknown>;
interface Spec {
  queue: Queue;
  now: string;
  dry: boolean;
  only: unknown;
  pubfail: boolean;
  dispatch: boolean;
  ordinary: boolean;
  head: string;
  events: unknown[];
  fetch_raises: string | null;
  coverage: Record<string, { covered: Record<string, number[]>; gaps: unknown[] } | null>;
  load_raises: Record<string, string>;
  request_raises: { cls: string; message: string } | null;
  launch: Plain | null;
  event_raises: string | null;
}
interface Case {
  name: string;
  spec: Spec;
  result: { ok?: Plain; raises?: string; queue: unknown; log: string[]; trace: unknown[] };
}

const FIXTURE = new URL(
  '../../../apps/crq-python/fixtures/crq-coverage-select/cases.json',
  import.meta.url,
);
const fixtureText = readFileSync(FIXTURE, 'utf8');
const fixture = JSON.parse(fixtureText) as { schema: string; cases: Case[] };

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Fixture JSON to production shape: `$int` is a bigint, `$float` a JsonNumber float. */
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (typeof value === 'object' && value !== null) {
    const rec = value as Plain;
    const keys = Object.keys(rec);
    if (keys.length === 1 && keys[0] === '$int') return BigInt(rec.$int as string);
    if (keys.length === 1 && keys[0] === '$float')
      return JsonNumber.float(Number(rec.$float), rec.$float as string);
    const out: Plain = {};
    for (const key of keys) out[key] = decode(rec[key]);
    return out;
  }
  return value;
}

/** Production shape back to the fixture's tagged JSON, as a snapshot (a deep copy). */
function encode(value: unknown): unknown {
  if (typeof value === 'bigint')
    return value > SAFE || value < -SAFE ? { $int: String(value) } : Number(value);
  if (value instanceof JsonNumber) {
    if (value.kind === 'int') return encode(value.integer);
    const num = value.float as number;
    return !Number.isFinite(num) || Number.isInteger(num) ? { $float: pythonNumberText(num) } : num;
  }
  if (typeof value === 'number')
    return !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))
      ? { $float: pythonNumberText(value) }
      : value;
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === 'object' && value !== null) {
    const out: Plain = {};
    for (const [key, inner] of Object.entries(value)) out[key] = encode(inner);
    return out;
  }
  return value;
}

const pyErrorOf = (cls: string, message: string): PyError => {
  const mapped = cls === 'FileNotFoundError' || cls === 'PermissionError' ? 'OSError' : cls;
  return new PyError(mapped as PyErrorClass, message);
};

interface Replayed {
  ok?: Plain;
  raises?: string;
  message?: string;
  queue: unknown;
  log: string[];
  trace: unknown[];
}

async function replay(spec: Spec): Promise<Replayed> {
  const queue = spec.queue as Queue;
  const log: string[] = [];
  const trace: unknown[] = [];
  const steps = spec.launch?.mode === 'sequence' ? [...(spec.launch.steps as Plain[])] : null;

  const live: SelectCollaborators = {
    publicationFailureExists: () => spec.pubfail,
    async fetchLedger() {
      trace.push(['fetch']);
      if (spec.fetch_raises) throw pyErrorOf(spec.fetch_raises, 'ledger fetch failed');
      return { head: spec.head, events: [...spec.events] };
    },
    async loadCoverage(target, events, digests) {
      trace.push(['load', target, events.length, [...digests.keys()].sort((a, b) => a - b)]);
      const raised = spec.load_raises[target];
      if (raised) throw pyErrorOf(raised, 'load failed');
      const entry = spec.coverage[target];
      if (entry === undefined || entry === null) return null;
      digests.set(events.length, 'digest-' + events.length);
      const covered = new Map<string, Set<number>>();
      for (const [path, lines] of Object.entries(entry.covered)) covered.set(path, new Set(lines));
      return { covered, gaps: entry.gaps as never[] };
    },
    async requestCoverage(head, targets) {
      trace.push(['request', head, [...targets]]);
      if (spec.request_raises)
        throw pyErrorOf(spec.request_raises.cls, spec.request_raises.message);
    },
    async launch(q, item: Item, plan) {
      trace.push(['launch', encode(item), encode(plan)]);
      const step = (steps ? steps.shift() : spec.launch) as Plain | null | undefined;
      if (!step) throw new Error('select launched but the spec scripted no launch');
      if (step.mode === 'raises') throw pyErrorOf(step.cls as string, step.message as string);
      if ('run' in step) item.run = structuredClone(step.run);
      if ('last_error' in step) item.last_error = step.last_error;
      if (step.mode === 'reviewing') {
        if ('hold_run' in step)
          ((q.backfill_reservations as Plain)[item.attempt_id as string] as Plain).vendor_run_id =
            step.hold_run;
        item.state = 'reviewing';
        item.run = { id: step.run_id };
      }
      return step.run_id as string;
    },
  };

  const select = bindSelect(
    {
      iso: () => spec.now,
      ordinaryEligible: () => spec.ordinary,
      async stateEvent(_q, item, at, reason) {
        trace.push(['state_event', item.id, at, reason, encode(item)]);
        if (spec.event_raises !== null && reason === spec.event_raises)
          throw new PyError('RuntimeError', 'state event failed');
      },
      async saveQueue(q) {
        trace.push(['save', encode(q)]);
      },
    },
    live,
    () => spec.dispatch,
  );

  let result: { ok?: Plain; raises?: string; message?: string };
  try {
    const out = await select(queue, log, spec.dry, spec.only as string | null);
    result = { ok: { started: out.started, available: out.available } };
  } catch (error) {
    const raises = (error as { pythonError?: string }).pythonError ?? (error as Error).name;
    result = { raises, message: (error as Error).message };
  }
  return { ...result, queue: encode(queue), log, trace };
}

/**
 * Documented deviation: Python's `jobs.eligible` creates the empty family, scope
 * failure and reservation tables in place before it can raise (a missing `family`,
 * a malformed scope row). The port's immutable `eligible` leaves the queue
 * untouched when it raises. A raising select never saves the queue, so the
 * in-memory initialisation is discarded. Only a case that raised before any
 * launch is compared without those three tables.
 */
function dropEligibleInit(side: { raises?: string; trace: unknown[] }, queue: unknown): unknown {
  const launched = side.trace.some((entry) => Array.isArray(entry) && entry[0] === 'launch');
  if (side.raises === undefined || launched) return queue;
  const copy = { ...(queue as Plain) };
  for (const key of ['backfill_families', 'backfill_scope_failures', 'backfill_reservations'])
    delete copy[key];
  return copy;
}

/**
 * Documented deviation, pinned both ways: the job and terminal policy ports keep
 * `attempt` and the family/scope/item `failures` counters as integers, so a float
 * counter raises TypeError where Python carries on with float arithmetic.
 */
const FLOAT_COUNTER_DEVIATIONS = new Set([
  'a float attempt launches',
  'a float job failures count survives a refused launch',
  'a float family failures count survives a refused launch',
]);

describe('coverage select against the Python oracle', () => {
  it('reads the fixture it was written for', () => {
    expect(fixture.schema).toBe('crq-coverage-select-oracle/1');
    expect(fixture.cases.length).toBeGreaterThan(150);
  });

  for (const c of fixture.cases) {
    it(c.name, async () => {
      const spec = decode(structuredClone(c.spec)) as Spec;
      const got = await replay(spec);
      const want = c.result;
      if (FLOAT_COUNTER_DEVIATIONS.has(c.name)) {
        expect(want.raises).toBeUndefined();
        expect(got.raises).toBe('TypeError');
        return;
      }
      if (want.raises !== undefined) {
        const expected =
          want.raises === 'FileNotFoundError' || want.raises === 'PermissionError'
            ? 'OSError'
            : want.raises;
        expect(got.raises).toBe(expected);
      } else {
        expect(got.raises).toBeUndefined();
        expect(JSON.parse(JSON.stringify(got.ok))).toEqual(want.ok);
      }
      expect(dropEligibleInit(got, JSON.parse(JSON.stringify(got.queue)))).toEqual(
        dropEligibleInit(want, want.queue),
      );
      expect(got.log).toEqual(want.log);
      expect(JSON.parse(JSON.stringify(got.trace))).toEqual(want.trace);
    });
  }
});

describe('the coverage select fixture', () => {
  it('is what the live Python 3.14 emitter produces', () => {
    const run = spawnSync(oraclePython(), ['coverage_select_vectors.py', '--stdout'], {
      cwd: new URL('../../../apps/crq-python/', import.meta.url),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONHASHSEED: '0' },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(fixtureText);
  });
});
