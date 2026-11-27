/**
 * Differential replay of the `recover_job` shell
 * (`src/queue-runner/repairRecoverJob.ts` vs `apps/crq-python/crq_repair.py:1395-1528`).
 *
 * `apps/crq-python/fixtures/crq-recover-job/cases.json` is emitted by
 * `repair_recover_job_vectors.py`, which runs the PRODUCTION `crq_repair.recover_job`
 * with only its effects injected (`crq.ran_locked`, `crq.load_queue`,
 * `crq.secret_scan_diff`, the inbox, `prepare_current_job`, `dispatch`, `blocked`,
 * `runner_disabled`, `narrate`, `publish_refusal` and `recovery.recover`, which is
 * replaced by a scripted driver that calls the three closures it is handed). Per
 * scenario it records the ordered seam trace, what each closure answered or raised,
 * and the value returned or the exception class that escaped.
 *
 * Each scenario is replayed here against the same scripted effects over an
 * in-memory filesystem; the trace, the closure outcomes and the final outcome must
 * all match.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { checkRepairJobId } from '../../src/adapters/crq/repairPreparation.js';
import {
  parseJsonValue,
  pythonNonFinite,
  toPlainJsonRetainingNumbers,
} from '../../src/policy/crq/jsonValue.js';
import { PyError, type PyErrorKind } from '../../src/queue-runner/pyErrors.js';
import {
  recoverJob,
  type RecoverClosures,
  type RecoverJobEffects,
} from '../../src/queue-runner/repairRecoverJob.js';

type Dict = Record<string, unknown>;

const FIXTURE = fileURLToPath(
  new URL('../../apps/crq-python/fixtures/crq-recover-job/cases.json', import.meta.url),
);
const MESSAGE_KINDS = new Set(['ValueError', 'KeyError', 'RuntimeError', 'OSError']);
/** Python subclasses the fixture records by class name, folded to the port's error kind. */
const KIND_OF: Readonly<Record<string, string>> = {
  FileNotFoundError: 'OSError',
  JSONDecodeError: 'ValueError',
  UnicodeDecodeError: 'ValueError',
};

interface Seams {
  readonly ran_locked: unknown[];
  readonly runner_disabled: unknown[];
  readonly blocked: unknown[];
  readonly dispatch: unknown[];
  readonly prepare: unknown[];
  readonly scan: unknown[];
}
interface Op extends Dict {
  readonly op: 'judge' | 'prepare' | 'scan';
}
interface Scenario {
  readonly name: string;
  readonly job_id: string;
  readonly config: unknown;
  readonly files: Readonly<Record<string, string>>;
  readonly queue: unknown;
  readonly retained: readonly unknown[];
  readonly seams: Seams;
  readonly script: readonly Op[];
  readonly recover_returns: unknown;
}
interface Case {
  readonly name: string;
  readonly scenario: Scenario;
  readonly expected: Dict;
}

const cases = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: Case[] }).cases;

const isRaise = (v: unknown): v is { raise: { kind: PyErrorKind; message: string } } =>
  typeof v === 'object' && v !== null && 'raise' in v && Object.keys(v).length === 1;

/** A file-read failure: Python raises a subclass (`FileNotFoundError`, `JSONDecodeError`) the oracle records by name only. */
class ReadFailure extends PyError {}

/** `json.loads(path.read_text())` over the scenario's in-memory files. */
function readFile(files: Scenario['files'], path: string): unknown {
  const text = files[path];
  if (text === undefined) throw new ReadFailure('OSError', `no such file: ${path}`);
  if (/[\udc80-\udcff]/.test(text)) throw new ReadFailure('ValueError', 'invalid utf-8');
  try {
    return toPlainJsonRetainingNumbers(parseJsonValue(text, { parseConstant: pythonNonFinite }));
  } catch (e) {
    throw new ReadFailure('ValueError', e instanceof Error ? e.message : String(e));
  }
}

function nameOf(e: unknown): { name: string; message?: string } {
  if (e instanceof ReadFailure) return { name: e.kind };
  if (e instanceof PyError) {
    return MESSAGE_KINDS.has(e.kind) ? { name: e.kind, message: e.message } : { name: e.kind };
  }
  if (e instanceof Error) return { name: e.constructor.name };
  throw e;
}

async function replay(scenario: Scenario): Promise<Dict> {
  const trace: unknown[] = [];
  const seams = structuredClone(scenario.seams);
  const queues =
    Array.isArray(scenario.queue) &&
    scenario.queue.length > 0 &&
    typeof scenario.queue[0] === 'object' &&
    scenario.queue[0] !== null &&
    'items' in (scenario.queue[0] as Dict)
      ? (structuredClone(scenario.queue) as unknown[])
      : undefined;
  const answer = (name: keyof Seams): unknown => {
    const items = seams[name];
    if (items.length === 0) throw new Error(`scenario ran out of ${name} answers`);
    const item = items.shift();
    if (isRaise(item)) throw new PyError(item.raise.kind, item.raise.message);
    return item;
  };
  const loadQueue = (): Promise<unknown> => {
    trace.push(['load_queue']);
    if (queues !== undefined)
      return Promise.resolve(queues.length > 1 ? queues.shift() : queues[0]);
    return Promise.resolve(structuredClone(scenario.queue));
  };
  const effects: RecoverJobEffects = {
    owner: {
      loadQueue,
      readTriageRow: (id) =>
        Promise.resolve().then(() =>
          readFile(scenario.files, `state/backfill/findings/triage/${id}.json`),
        ),
      retainedEvents: () => {
        trace.push(['finding_inbox'], ['retained']);
        return Promise.resolve(structuredClone(scenario.retained));
      },
      readJob: (id) => readJobFile(id),
    },
    readJob: (id) => readJobFile(id),
    ranLocked: async (fn) => {
      const result = answer('ran_locked');
      trace.push(['ran_locked', Boolean(result)]);
      if (result) await fn();
      return Boolean(result);
    },
    loadQueue,
    runnerDisabled: () => {
      trace.push(['runner_disabled']);
      return Promise.resolve(answer('runner_disabled'));
    },
    narrate: (message) => {
      trace.push(['narrate', message]);
      return Promise.resolve();
    },
    publishRefusal: () => {
      trace.push(['publish_refusal']);
      return Promise.resolve();
    },
    blocked: (repair) => {
      trace.push(['blocked', structuredClone(repair)]);
      return Promise.resolve(answer('blocked'));
    },
    dispatch: (role, request, clone, directory, judge) => {
      trace.push([
        'dispatch',
        structuredClone(role),
        structuredClone(request),
        clone,
        directory,
        judge,
      ]);
      return Promise.resolve(answer('dispatch'));
    },
    prepareCurrentJob: (queue, oldId, tip, evidence) => {
      trace.push([
        'prepare_current_job',
        structuredClone(queue),
        oldId,
        tip,
        structuredClone(evidence),
        true,
      ]);
      return Promise.resolve(answer('prepare'));
    },
    secretScanDiff: (diff, output) => {
      trace.push(['secret_scan_diff', diff, output]);
      return Promise.resolve(answer('scan'));
    },
    recover: async (jobId, closures: RecoverClosures) => {
      trace.push(['recover', '/T/root', jobId]);
      const outcomes: Dict[] = [];
      for (const op of scenario.script) {
        const entry: Dict = { op: op.op };
        try {
          if (op.op === 'judge') {
            entry.returned = await closures.judge(op.old, op.context, String(op.directory));
          } else if (op.op === 'prepare') {
            entry.returned = await closures.prepare(op.old_id, op.tip, op.evidence);
          } else {
            entry.returned = await closures.scan(op.context, String(op.output));
          }
        } catch (e) {
          const { name, message } = nameOf(e);
          entry.raises = name;
          if (message !== undefined) entry.message = message;
        }
        outcomes.push(entry);
      }
      trace.push(['recover-ops', outcomes]);
      return structuredClone(scenario.recover_returns);
    },
  };

  function readJobFile(id: string): Promise<unknown> {
    if (!checkRepairJobId(id)) {
      return Promise.reject(new PyError('ValueError', 'expected one exact CRQ job id'));
    }
    return Promise.resolve().then(() => readFile(scenario.files, `state/repair/inbox/${id}.json`));
  }

  try {
    const returned = await recoverJob(
      { config: structuredClone(scenario.config), jobId: scenario.job_id },
      effects,
    );
    return { trace, returned };
  } catch (e) {
    const { name, message } = nameOf(e);
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

describe('recover_job shell vs the Python oracle', () => {
  it('replays a populated fixture', () => {
    expect(cases.length).toBeGreaterThan(60);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    expect(await replay(c.scenario)).toEqual(fold(c.expected));
  });
});
