// Child side of the worker boundary, in-process: the fd channel's bytes, its
// swallowed write errors, the payload decode and the entry's unbound effects.
// No process is spawned here (repairWorkerProcess.test.ts covers the real pipe).
import { closeSync, openSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { fdWorkerChannel, runWorkerChild } from '../../../src/adapters/crq/repairWorkerChild.js';
import {
  decodeWorkerPayload,
  runRepairWorkerMain,
  workerEffects,
} from '../../../src/adapters/crq/repairWorkerMain.js';
import type { RepairDrainEffects } from '../../../src/ops/crq/internal/repairDrain.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function sink(): Promise<{ fd: number; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'repair-child-'));
  dirs.push(dir);
  const path = join(dir, 'pipe');
  return { fd: openSync(path, 'w'), path };
}

function effects(over: Partial<RepairDrainEffects>): RepairDrainEffects {
  return {
    runnerDisabled: async () => false,
    narrate: () => undefined,
    dispatchPaused: async () => null,
    blocked: () => false,
    readQueue: async () => {
      throw new TypeError('bug');
    },
    inboxItem: async () => 'pr-1',
    ...over,
  } as unknown as RepairDrainEffects;
}

describe('fdWorkerChannel', () => {
  test('writes a for admitted and x for refused, in order', async () => {
    const { fd, path } = await sink();
    const channel = fdWorkerChannel(fd);
    channel.publish('admitted');
    channel.publish('refused');
    closeSync(fd);
    expect(readFileSync(path, 'utf8')).toBe('ax');
  });

  test('a write to a closed descriptor is swallowed', async () => {
    const { fd } = await sink();
    closeSync(fd);
    expect(() => fdWorkerChannel(fd).publish('admitted')).not.toThrow();
  });
});

describe('runWorkerChild', () => {
  test('a refused gate publishes x only and resolves exit 3', async () => {
    const { fd, path } = await sink();
    const code = await runWorkerChild(
      effects({ runnerDisabled: async () => true }),
      'pr-1',
      ['j1'],
      fdWorkerChannel(fd),
    );
    closeSync(fd);
    expect(code).toBe(3);
    expect(readFileSync(path, 'utf8')).toBe('x');
  });

  test('an exception after admission publishes a and resolves exit 1', async () => {
    const { fd, path } = await sink();
    const code = await runWorkerChild(effects({}), 'pr-1', ['j1'], fdWorkerChannel(fd));
    closeSync(fd);
    expect(code).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe('a');
  });

  test('a rate-limited item publishes a and resolves exit 2', async () => {
    const { fd, path } = await sink();
    const code = await runWorkerChild(
      effects({
        readQueue: async () => ({}) as never,
        classifyJob: async () => ({ status: 'run', job: null, reason: '' }) as never,
        dispatchPaused: async () => '2026-11-26T00:00:00Z',
      }),
      'pr-1',
      [],
      fdWorkerChannel(fd),
    );
    closeSync(fd);
    expect(readFileSync(path, 'utf8')).toBe('a');
    expect(code).toBe(2);
  });
});

describe('repairWorkerMain', () => {
  const payload = {
    stateRoot: '/nonexistent/state',
    clone: '/nonexistent/clone',
    configText: '{"repair": {}}',
    item: 'pr-1',
    jobIds: ['j1'],
  };

  test('decodes a well-formed payload and rejects a malformed one', () => {
    expect(decodeWorkerPayload(JSON.stringify(payload))).toEqual(payload);
    for (const bad of [undefined, 'not json', '{}', JSON.stringify({ ...payload, jobIds: [1] })]) {
      expect(() => decodeWorkerPayload(bad)).toThrow();
    }
  });

  test('the entry leaves processItem and triage unbound and forbids nested workers', async () => {
    const e = workerEffects(payload);
    await expect(e.processItem([], { publishRefusal: () => undefined })).rejects.toThrow(
      'repair processItem is not bound',
    );
    expect(await e.triage()).toBeNull();
    expect(() => e.startWorker('pr-2', [])).toThrow('nested workers');
  });

  test('the config reparse accepts NaN/Infinity and duplicate keys like the config reader', () => {
    const configText = '{"repair": {"a": NaN, "b": -Infinity, "c": Infinity}, "repair": {}}';
    expect(() => workerEffects({ ...payload, configText })).not.toThrow();
  });

  test('a bad payload exits 1 before touching the pipe', async () => {
    expect(await runRepairWorkerMain(['node', 'entry', 'garbage'])).toBe(1);
  });
});
