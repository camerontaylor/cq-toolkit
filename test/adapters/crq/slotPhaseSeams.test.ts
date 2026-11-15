import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileSlotPhases, slotTickLock } from '../../../src/adapters/crq/slotPhaseSeams.js';
import { JsonNumber, JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  runScheduledSlot,
  runSlot,
  SLOT_QUEUE_CHANGED_LOG,
  SLOT_RUNNER_DISABLED_LOG,
} from '../../../src/queue-runner/slotOrchestrator.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'slot-seams-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const calls: string[] = [];
const heavy = {
  collectFinished: async (queue: JsonObject) => {
    calls.push('collect');
    return { queue, log: ['c'] };
  },
  readSlotUsage: async () => {
    calls.push('usage');
    return { usage: 1, reserved: [] };
  },
  admit: async (queue: JsonObject) => {
    calls.push('admit');
    return {
      queue: new JsonObject([...queue.entries, ['admitted', true]]),
      log: ['a'],
      globalGate: null,
      remaining: 0,
    };
  },
  refreshSlotDeadline: async () => {
    calls.push('refresh');
  },
};
const seed = (text = '{"items":[],"n":1}') => writeFile(join(root, 'queue.json'), text);

describe('file slot seams', () => {
  it('runs a locked slot over the real queue file and saves via the atomic writer', async () => {
    calls.length = 0;
    await seed();
    const phases = fileSlotPhases({ stateRoot: root, heavy, now: () => 5 });
    expect(await runSlot({}, phases)).toEqual(['c', 'a']);
    const saved = parseJsonValue(await readFile(join(root, 'queue.json'), 'utf8')) as JsonObject;
    expect(saved.get('admitted')).toBe(true);
    expect(await readFile(join(root, 'queue.json'), 'utf8')).toMatch(/\n$/);
    expect(calls).toEqual(['collect', 'usage', 'admit', 'refresh']);
  });

  it('refuses when runner-disabled exists and runs nothing', async () => {
    calls.length = 0;
    await seed();
    await writeFile(join(root, 'runner-disabled'), '');
    const phases = fileSlotPhases({ stateRoot: root, heavy });
    expect(await runSlot({}, phases)).toEqual([SLOT_RUNNER_DISABLED_LOG]);
    expect(calls).toEqual([]);
  });

  it('scheduled slot returns [] on a held tick.lock and commits on a free one', async () => {
    calls.length = 0;
    await seed();
    const phases = fileSlotPhases({ stateRoot: root, heavy });
    const lock = slotTickLock(root);
    let inner: string[] | undefined;
    const outer = await lock.withLock(async () => {
      inner = await runScheduledSlot(slotTickLock(root), phases);
    });
    expect(outer.ran).toBe(true);
    expect(inner).toEqual([]);
    expect(calls).toEqual([]);
    expect(await runScheduledSlot(lock, phases)).toEqual(['c', 'a']);
  });

  it('sameQueue is Python ==: key order and 1 == 1.0 are equal, a value change is not', () => {
    const { sameQueue } = fileSlotPhases({ stateRoot: root, heavy });
    const a = new JsonObject([
      ['x', JsonNumber.int(1)],
      ['y', true],
    ]);
    const b = new JsonObject([
      ['y', true],
      ['x', parseJsonValue('1.0')],
    ]);
    expect(sameQueue(a, b)).toBe(true);
    expect(
      sameQueue(
        a,
        new JsonObject([
          ['x', JsonNumber.int(2)],
          ['y', true],
        ]),
      ),
    ).toBe(false);
  });

  it('a queue changed during the probe is not committed', async () => {
    calls.length = 0;
    await seed();
    const phases = fileSlotPhases({
      stateRoot: root,
      heavy: {
        ...heavy,
        readSlotUsage: async () => {
          await seed('{"items":[],"n":2}');
          return { usage: 1, reserved: [] };
        },
      },
    });
    expect(await runScheduledSlot(slotTickLock(root), phases)).toEqual([SLOT_QUEUE_CHANGED_LOG]);
    expect(calls).toEqual([]);
  });

  it('fails closed when queue.json is missing', async () => {
    await mkdir(root, { recursive: true });
    await expect(runSlot({}, fileSlotPhases({ stateRoot: root, heavy }))).rejects.toThrow();
  });
});
