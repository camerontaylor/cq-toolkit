import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../src/policy/crq/jsonValue.js';
import { atomicJsonText } from '../../src/policy/crq/pythonJson.js';
import { QueueCell, QueueEditError, type PathStep } from '../../src/queue-runner/queueCell.js';
import {
  ReviewSpawnError,
  type ReviewLaunchEffects,
  type ReviewLaunchInput,
} from '../../src/queue-runner/reviewLaunch.js';
import { pythonAvailable, runOracle } from '../helpers/pythonOracle.js';

const obj = (text: string): JsonObject => parseJsonValue(text) as JsonObject;
const dump = (cell: QueueCell): string => atomicJsonText(cell.queue);

/** One edit op from the fixture, applied through the cell the way crq.py applies it in place. */
function applyOp(cell: QueueCell, op: JsonObject): void {
  const name = op.get('op') as string;
  const path = op.get('path') as JsonValue[];
  const steps: PathStep[] = path.map((step) =>
    step instanceof JsonNumber ? Number(step.integer) : (step as string),
  );
  const key = op.get('key');
  const keyStep: PathStep = key instanceof JsonNumber ? Number(key.integer) : (key as string);
  const value = op.get('value') as JsonValue;
  if (name === 'set') cell.set(steps, keyStep, value);
  else if (name === 'setdefault') cell.setdefault(steps, keyStep as string, value);
  else if (name === 'append') cell.append(steps, value);
  else if (name === 'update')
    cell.update(
      steps,
      (op.get('entries') as JsonValue[][]).map(([k, v]) => [k as string, v as JsonValue] as const),
    );
  else if (name === 'delete') cell.delete(steps, keyStep);
  else if (name === 'pop') cell.pop(steps, keyStep as string);
  else throw new Error(`unknown op ${name}`);
}

const python = pythonAvailable();

describe.skipIf(!python)('differential: in-place edits, Python vs QueueCell', () => {
  const text = readFileSync(
    new URL('../fixtures/differential/edit_queue.json', import.meta.url),
    'utf8',
  );
  // The lossless parse keeps 1.0 / 2**70 / -0.0 lexemes; the oracle gets the same file text.
  const cases = parseJsonValue(text) as JsonObject[];
  const oracle = runOracle('edit_queue', text);

  it('every case yields the same saved text, or the same Python exception', () => {
    let ok = 0;
    let failed = 0;
    const kinds = new Set<string>();
    const wrong: unknown[] = [];
    cases.forEach((c, index) => {
      const cell = new QueueCell(c.get('queue') as JsonObject);
      let mine: { ok: true; value: string } | { ok: false; error: string };
      try {
        for (const op of c.get('ops') as JsonObject[]) applyOp(cell, op);
        mine = { ok: true, value: dump(cell) };
      } catch (error) {
        if (!(error instanceof QueueEditError)) throw error;
        mine = { ok: false, error: error.pythonError };
      }
      const theirs = oracle[index]!;
      if (JSON.stringify(mine) === JSON.stringify(theirs)) {
        if (mine.ok) ok += 1;
        else {
          failed += 1;
          kinds.add(mine.error);
        }
      } else wrong.push({ index, mine, theirs });
    });
    expect(wrong.slice(0, 3)).toEqual([]);
    expect(cases.length).toBeGreaterThan(400);
    expect(ok).toBeGreaterThan(150);
    // The error types are exercised, not just the happy path.
    expect(failed).toBeGreaterThan(100);
    expect([...kinds].sort()).toEqual(['AttributeError', 'IndexError', 'KeyError', 'TypeError']);
  });

  it('a failing edit changes nothing', () => {
    const cell = new QueueCell(obj('{"items":[{"id":"a"}],"starts":null}'));
    cell.set(['items', 0], 'state', 'pending');
    const before = dump(cell);
    expect(() => cell.append(['starts'], 'x')).toThrow(QueueEditError);
    expect(dump(cell)).toBe(before);
  });
});

describe('ItemRef reads through the cell like a Python item reference', () => {
  it('sees edits made through the cell or another handle, as one dict object would', () => {
    const cell = new QueueCell(obj('{"items":[{"id":"a","state":"pending"},{"id":"b"}]}'));
    const first = cell.item(0);
    const alias = cell.item(0);
    first.set('state', 'reviewing');
    expect(alias.get('state')).toBe('reviewing');
    cell.set(['items', 0], 'wait_reason', null);
    expect(first.has('wait_reason')).toBe(true);
    expect(first.get('wait_reason')).toBeNull();
    expect(cell.item(1).has('state')).toBe(false);
  });

  it('keeps Python key order: an existing key stays put, a new key appends', () => {
    const cell = new QueueCell(obj('{"items":[{"a":1,"b":2,"c":3}]}'));
    const item = cell.item(0);
    item.set('b', JsonNumber.int(9));
    item.set('z', JsonNumber.int(0));
    item.setdefault('a', 'ignored');
    item.setdefault('y', 'new');
    expect(item.value.entries.map(([k]) => k)).toEqual(['a', 'b', 'c', 'z', 'y']);
    expect(item.get('b')).toEqual(JsonNumber.int(9));
    expect(item.get('a')).toEqual(JsonNumber.int(1));
  });

  it('setdefault(key, []).append is one idiom: present null is not replaced (AttributeError)', () => {
    const cell = new QueueCell(obj('{"items":[{"id":"a","notes":null}]}'));
    expect(() => cell.item(0).appendTo('notes', 'n')).toThrow(QueueEditError);
    cell.item(0).appendTo('fresh', 'one');
    cell.item(0).appendTo('fresh', 'two');
    expect(cell.item(0).get('fresh')).toEqual(['one', 'two']);
  });

  it('an item that is not a dict is a TypeError, not a silent empty read', () => {
    const cell = new QueueCell(obj('{"items":[7]}'));
    expect(() => cell.item(0).get('state')).toThrow(QueueEditError);
    expect(() => cell.item(3).get('state')).toThrow(/index out of range/);
  });

  it('the original queue is never mutated', () => {
    const original = obj('{"items":[{"id":"a"}],"starts":[]}');
    const before = atomicJsonText(original);
    const cell = new QueueCell(original);
    cell.item(0).set('state', 'x');
    cell.append(['starts'], 'now');
    expect(atomicJsonText(original)).toBe(before);
    expect(dump(cell)).not.toBe(before);
  });
});

// ---- launch bridge ------------------------------------------------------

const runId = 'pr7-open-20261115T000000Z';
const startedAt = '2026-11-15T00:00:00Z';
const meta = (kind: string): JsonObject =>
  obj(
    JSON.stringify({
      run_id: runId,
      item_id: 'pr7-open',
      kind,
      started_at: startedAt,
      band: 'interactive',
      base: 'b'.repeat(40),
      head: 'h'.repeat(40),
      label: 'cycle 1',
    }),
  );
const launchInput = (kind: string): ReviewLaunchInput => ({
  itemIndex: 0,
  runId,
  startedAt,
  band: 'interactive',
  meta: meta(kind),
});
const fx = (over: Partial<ReviewLaunchEffects> = {}): ReviewLaunchEffects => ({
  writeMeta: async () => {},
  workStarted: async () => {},
  saveQueue: async () => {},
  spawn: async () => 4321,
  event: async () => {},
  nowIso: () => '2026-11-15T00:00:09Z',
  ...over,
});
const startQueues: Record<string, (kind: string) => string> = {
  'with starts and extra keys': (kind) =>
    `{"items":[{"id":"pr7-open","kind":"${kind}","wait_reason":"x","state":"pending","pr":7,"f":1.0,"big":${'9'.repeat(30)}}],"starts":["2026-11-14T23:00:00Z"],"keep":{"b":1,"a":2}}`,
  'no starts key, no wait_reason': (kind) =>
    `{"items":[{"id":"pr7-open","kind":"${kind}","state":"pending"}],"zz":null}`,
  'null run, key order': (kind) =>
    `{"items":[{"run":null,"state":"pending","kind":"${kind}","id":"pr7-open"}],"starts":[]}`,
};

describe.skipIf(!python)('differential: launch() reservation edits, Python vs the bridge', () => {
  const reserve = [
    { op: 'set', path: ['items', 0], key: 'state', value: 'reviewing' },
    {
      op: 'set',
      path: ['items', 0],
      key: 'run',
      value: {
        run_id: runId,
        pid: null,
        started_at: startedAt,
        band: 'interactive',
        launch_pending: true,
      },
    },
    { op: 'set', path: ['items', 0], key: 'wait_reason', value: null },
    { op: 'setdefault', path: [], key: 'starts', value: [] },
    { op: 'append', path: ['starts'], value: startedAt },
  ];
  const spawned = [
    {
      op: 'update',
      path: ['items', 0, 'run'],
      entries: [
        ['pid', 4321],
        ['launch_pending', false],
      ],
    },
  ];
  const failed = (state: string, message: string, kind: string) => [
    {
      op: 'set',
      path: ['items', 0],
      key: 'run',
      value: {
        run_id: runId,
        pid: null,
        started_at: startedAt,
        band: 'interactive',
        launch_pending: false,
        spawn_failed_at: '2026-11-15T00:00:09Z',
        error: message,
      },
    },
    { op: 'set', path: ['items', 0], key: 'state', value: state },
    {
      op: 'set',
      path: ['items', 0],
      key: 'last_error',
      value: `${kind} spawn failed (no retry): ${message}`,
    },
  ];

  function expectSameAsPython(queueText: string, ops: unknown[], cell: QueueCell): void {
    // Lossless text path: the queue text keeps its 1.0 / 30-digit lexemes on the way to Python.
    const lossless = `[{"queue":${queueText},"ops":${JSON.stringify(ops)}}]`;
    const [theirs] = runOracle('edit_queue', lossless);
    expect(theirs).toEqual({ ok: true, value: dump(cell) });
  }

  for (const kind of ['open', 'delta', 'author', 'local-review']) {
    for (const [label, build] of Object.entries(startQueues)) {
      it(`${kind} / ${label}: a successful launch ends in Python's queue`, async () => {
        const cell = new QueueCell(obj(build(kind)));
        const handle = cell.item(0);
        await cell.launch(launchInput(kind), fx());
        expectSameAsPython(build(kind), [...reserve, ...spawned], cell);
        // The handle taken before the launch observes it, as `item` does in start_one.
        expect(handle.get('state')).toBe('reviewing');
        expect((handle.get('run') as JsonObject).get('pid')).toEqual(JsonNumber.int(4321));
      });
    }
  }

  for (const kind of ['author', 'local-review']) {
    it(`${kind}: an identified spawn failure is consumed, as in Python`, async () => {
      const build = startQueues['with starts and extra keys']!;
      const cell = new QueueCell(obj(build(kind)));
      const handle = cell.item(0);
      await cell.launch(
        launchInput(kind),
        fx({
          spawn: async () => {
            throw new ReviewSpawnError('[Errno 2] No such file: python3');
          },
        }),
      );
      const state = kind === 'author' ? 'author_failed' : 'failed';
      expectSameAsPython(
        build(kind),
        [...reserve, ...failed(state, '[Errno 2] No such file: python3', kind)],
        cell,
      );
      expect(handle.get('state')).toBe(state);
    });
  }

  it('failure text is cut by code points like Python, not by UTF-16 units', async () => {
    const messages = [
      '',
      'short',
      'x'.repeat(199),
      'x'.repeat(200),
      'x'.repeat(201),
      'x'.repeat(400),
      '😀'.repeat(150),
      '😀'.repeat(250),
      `a${'😀'.repeat(199)}`,
      `${'é'.repeat(190)}${'😀'.repeat(20)}`,
    ];
    for (const kind of ['author', 'local-review']) {
      const want = runOracle(
        'spawn_failed_text',
        messages.map((message) => ({ kind, message })),
      );
      for (const [index, message] of messages.entries()) {
        const cell = new QueueCell(obj(startQueues['no starts key, no wait_reason']!(kind)));
        await cell.launch(
          launchInput(kind),
          fx({
            spawn: async () => {
              throw new ReviewSpawnError(message);
            },
          }),
        );
        const run = cell.item(0).get('run') as JsonObject;
        expect({ error: run.get('error'), last_error: cell.item(0).get('last_error') }).toEqual(
          (want[index] as { ok: true; value: unknown }).value,
        );
      }
    }
  });
});

describe('launch bridge: failure after the reservation was saved', () => {
  const build = startQueues['with starts and extra keys']!;

  it('an unidentified spawn error leaves the reserved (saved) queue in the cell, like Python memory', async () => {
    const saves: JsonObject[] = [];
    const cell = new QueueCell(obj(build('open')));
    await expect(
      cell.launch(
        launchInput('open'),
        fx({
          saveQueue: async (q) => {
            saves.push(q);
          },
          spawn: async () => {
            throw new Error('boom');
          },
        }),
      ),
    ).rejects.toThrow('boom');
    expect(saves).toHaveLength(1);
    expect(cell.queue).toBe(saves[0]);
    expect(cell.item(0).get('state')).toBe('reviewing');
    expect((cell.item(0).get('run') as JsonObject).get('launch_pending')).toBe(true);
  });

  it('a failing pre-reservation write leaves the cell untouched', async () => {
    const cell = new QueueCell(obj(build('open')));
    const before = dump(cell);
    await expect(
      cell.launch(
        launchInput('open'),
        fx({
          writeMeta: async () => {
            throw new Error('disk full');
          },
        }),
      ),
    ).rejects.toThrow('disk full');
    expect(dump(cell)).toBe(before);
    expect(cell.item(0).get('state')).toBe('pending');
  });

  it('a failing reservation save does not advance the cell past what was durably saved', async () => {
    const cell = new QueueCell(obj(build('open')));
    const before = dump(cell);
    await expect(
      cell.launch(
        launchInput('open'),
        fx({
          saveQueue: async () => {
            throw new Error('rename failed');
          },
        }),
      ),
    ).rejects.toThrow('rename failed');
    expect(dump(cell)).toBe(before);
  });

  it('a spawn that was refused as not launchable throws before touching the cell', async () => {
    const cell = new QueueCell(obj(build('open')));
    cell.item(0).set('state', 'reviewing');
    const before = dump(cell);
    await expect(cell.launch(launchInput('open'), fx())).rejects.toThrow('not launchable');
    expect(dump(cell)).toBe(before);
  });
});
