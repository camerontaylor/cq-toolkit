import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/queue-runner/runner.js';

describe('queue runner skeleton', () => {
  it('records planned mutations without writing their targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-shadow-'));
    const result = await run(['tick', '--dry-run'], {
      shadowRoot: root,
      tick: 'tick-1',
      planner: async () => ({
        value: 'planned',
        mutations: [{ operation: 'write', target: 'queue.json', value: { x: 1 } }],
      }),
    });
    expect(result).toEqual({ artifact: { status: 'ok', value: 'planned' }, exitCode: 0 });
    expect(JSON.parse(await readFile(join(root, 'shadow', 'tick-1.json'), 'utf8'))).toEqual({
      command: 'tick',
      mutations: [{ operation: 'write', target: 'queue.json', value: { x: 1 } }],
    });
    expect(await readdir(root)).toEqual(['shadow']);
    expect(
      (
        await run(['tick', '--dry-run'], {
          shadowRoot: root,
          tick: 'tick-1',
          planner: async () => ({ value: null, mutations: [] }),
        })
      ).exitCode,
    ).toBe(1);
  });
  it('refuses unknown commands, unported commands, and live execution', async () => {
    const options = { shadowRoot: '/unused', tick: 'x' };
    expect((await run(['missing'], options)).exitCode).toBe(2);
    expect((await run(['backfill'], options)).exitCode).toBe(2);
    expect((await run(['tick', '--dry-run'], options)).exitCode).toBe(1);
    expect(
      (
        await run(['tick'], {
          ...options,
          planner: async () => {
            throw new Error('must not execute');
          },
        })
      ).exitCode,
    ).toBe(1);
  });
});
