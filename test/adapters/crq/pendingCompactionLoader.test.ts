/**
 * Differential replay of `crq.load_queue` / `crq.save_queue` pending admission-history
 * compaction (`crq.py:267-302`) against `apps/crq-python/fixtures/crq-pending-compaction`.
 *
 * Every case is a sequence of operations over one temporary `queue.json`. Python 3.14 recorded,
 * after each operation, the returned queue, the error class, the stderr text, the bytes on disk
 * and the size held by `_pending_admission_compaction`. The TS side shares one `QueueCompaction`
 * between `pendingCompactionLoader` and `fileRepairSaveQueue`, the same lifetime as the global,
 * and is fed production-shaped input: the queue keeps `JsonNumber`s end to end.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pendingCompactionLoader } from '../../../src/adapters/crq/pendingCompactionLoader.js';
import {
  fileRepairSaveQueue,
  QueueCompaction,
} from '../../../src/adapters/crq/repairHarvestForge.js';
import type { JsonObject } from '../../../src/policy/crq/jsonValue.js';
import { parseJsonValue, toPlainJsonRetainingNumbers } from '../../../src/policy/crq/jsonValue.js';
import { pythonJsonText } from '../../../src/policy/crq/pythonJson.js';
import { fromPlainJson } from '../../../src/policy/crq/queueDoc.js';
import { PyError } from '../../../src/queue-runner/pyErrors.js';
import { oraclePython } from '../../helpers/oraclePython.js';

type Rec = Record<string, unknown>;

interface Op {
  op: 'load' | 'save' | 'rewrite' | 'replace' | 'unlink';
  persist?: boolean | null;
  doc?: string | null;
  text_hex?: string;
}
interface Step {
  op: string;
  error: string | null;
  message?: string;
  queue?: string;
  stderr: string;
  queue_bytes: string | null;
  pending_size: number | null;
}
interface Case {
  name: string;
  scenario: { name: string; queue_hex: string; ops: Op[] };
  expected: { steps: Step[] };
}

const fixtureUrl = new URL(
  '../../../apps/crq-python/fixtures/crq-pending-compaction/cases.json',
  import.meta.url,
);
const document = JSON.parse(await readFile(fixtureUrl, 'utf8')) as { cases: Case[] };
const cases = document.cases;

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pending-compaction-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const hex = (path: string): Promise<string | null> =>
  readFile(path).then(
    (bytes) => bytes.toString('hex'),
    () => null,
  );

/** `json.dumps(q, sort_keys=True, ensure_ascii=True)`, compact separators. */
const dumps = (queue: JsonObject): string =>
  pythonJsonText(fromPlainJson(toPlainJsonRetainingNumbers(queue)), {
    asciiOnly: true,
    sortKeys: true,
    keyOrder: 'code-point',
    indent: null,
  });

const plain = (value: unknown): Rec => toPlainJsonRetainingNumbers(value as never) as Rec;

/** Replay one case; the result is shaped like the oracle's `steps`. */
async function replay(spec: Case['scenario']): Promise<Step[]> {
  const state = join(root, 'state');
  await mkdir(state);
  const queuePath = join(state, 'queue.json');
  await writeFile(queuePath, Buffer.from(spec.queue_hex, 'hex'));
  const compaction = new QueueCompaction();
  let stderr = '';
  const saveQueue = fileRepairSaveQueue({
    stateRoot: state,
    compaction,
    stderr: (text) => {
      stderr += text;
    },
  });
  const load = pendingCompactionLoader({
    queuePath,
    compaction,
    save: (queue) => saveQueue(plain(queue)),
  });
  let last: JsonObject | null = null;
  const steps: Step[] = [];
  for (const op of spec.ops) {
    stderr = '';
    const step: Step = {
      op: op.op,
      error: null,
      stderr: '',
      queue_bytes: null,
      pending_size: null,
    };
    try {
      if (op.op === 'load') {
        // A null persist omits the argument, as Python's `load_queue()` does.
        last = await (op.persist === null || op.persist === undefined
          ? load()
          : load({ persistCompaction: op.persist }));
        step.queue = dumps(last);
      } else if (op.op === 'save') {
        const source = op.doc === null || op.doc === undefined ? last! : parseJsonValue(op.doc);
        await saveQueue(plain(source));
      } else if (op.op === 'rewrite') {
        await writeFile(queuePath, Buffer.from(op.text_hex!, 'hex'));
      } else if (op.op === 'replace') {
        const next = join(state, 'queue.json.new');
        await writeFile(next, Buffer.from(op.text_hex!, 'hex'));
        await rename(next, queuePath);
      } else {
        await unlink(queuePath);
      }
    } catch (error) {
      step.error = error instanceof PyError ? error.kind : `unmapped:${String(error)}`;
      delete step.queue;
    }
    step.stderr = stderr.split(root).join('/T');
    step.queue_bytes = await hex(queuePath);
    step.pending_size = compaction.pending === null ? null : Number(compaction.pending.size);
    steps.push(step);
  }
  return steps;
}

describe('pending admission-history compaction against the Python oracle', () => {
  it('replays every case', () => {
    expect(cases.length).toBeGreaterThan(60);
  });

  for (const { name, scenario, expected } of cases) {
    it(name, async () => {
      const got = await replay(scenario);
      expect(got.length).toBe(expected.steps.length);
      for (const [index, want] of expected.steps.entries()) {
        const step = got[index]!;
        const where = `${name} step ${String(index)} (${want.op})`;
        expect(step.error, where).toBe(want.error);
        expect(step.queue, where).toBe(want.queue);
        expect(step.stderr, where).toBe(want.stderr);
        expect(step.queue_bytes, where).toBe(want.queue_bytes);
        expect(step.pending_size, where).toBe(want.pending_size);
      }
    });
  }

  it('shares one lifetime per tracker: a second tracker is a second process', async () => {
    const state = join(root, 'state');
    await mkdir(state);
    const queuePath = join(state, 'queue.json');
    await writeFile(queuePath, JSON.stringify({ items: [], backfill_admissions: [{ at: 'x' }] }));
    const first = new QueueCompaction();
    const second = new QueueCompaction();
    const load = pendingCompactionLoader({ queuePath, compaction: first, save: async () => {} });
    await load();
    expect(first.pending).not.toBeNull();
    expect(second.pending).toBeNull();
  });
});

describe('the oracle is Python 3.14', () => {
  it('runs the emitter check', () => {
    const run = spawnSync(
      oraclePython(),
      [
        fileURLToPath(
          new URL('../../../apps/crq-python/pending_compaction_vectors.py', import.meta.url),
        ),
        '--check',
      ],
      { encoding: 'utf8' },
    );
    expect(run.status, run.stderr).toBe(0);
  });
});
