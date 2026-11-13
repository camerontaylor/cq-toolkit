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
      value: 'planned',
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

it('executes the built CLI dry-run against a queue without changing its bytes', async () => {
  const { spawnSync } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'crq-cli-'));
  const queue = '{"items":[],"last_tick":"old"}\n';
  await writeFile(join(root, 'queue.json'), queue);
  const cli = fileURLToPath(new URL('../../dist/queue-runner/crq.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'tick', '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  const output = JSON.parse(result.stdout) as { status: string };
  expect(output.status).toBe('indeterminate');
  const files = await readdir(join(root, 'shadow'));
  expect(files).toHaveLength(1);
  const shadow = JSON.parse(await readFile(join(root, 'shadow', files[0]!), 'utf8')) as {
    value: { complete: boolean };
    mutations: { operation: string; target: string; value: string }[];
  };
  expect(shadow.value.complete).toBe(false);
  expect(shadow.mutations).toHaveLength(1);
  expect(shadow.mutations[0]?.operation).toBe('set');
  expect(shadow.mutations[0]?.target).toBe('queue.json#/last_tick');
  expect(shadow.mutations[0]?.value).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  expect(await readFile(join(root, 'queue.json'), 'utf8')).toBe(queue);
});

describe('operator-live command seam (D1)', () => {
  it('keeps the operator-live set separate from the unit live set', async () => {
    const { LIVE_OPERATOR_COMMANDS } = await import('../../src/queue-runner/runner.js');
    const { LIVE_UNIT_COMMANDS } = await import('../../src/queue-runner/capabilities.js');
    expect([...LIVE_OPERATOR_COMMANDS]).toEqual(['repair-prepare']);
    for (const command of LIVE_OPERATOR_COMMANDS) {
      expect([...LIVE_UNIT_COMMANDS]).not.toContain(command);
    }
  });

  it('forwards argv to the operator handler and preserves its exit code', async () => {
    const seen: string[][] = [];
    const result = await run(
      ['repair-prepare', 'crq-historical-F1', '--source-sha', 'a'.repeat(40)],
      {
        shadowRoot: '/unused',
        tick: 'x',
        operatorLive: async (command, args) => {
          seen.push([command, ...args]);
          return { artifact: { status: 'failed', error: 'tick lock busy' }, exitCode: 3 };
        },
      },
    );
    expect(seen).toEqual([['repair-prepare', 'crq-historical-F1', '--source-sha', 'a'.repeat(40)]]);
    expect(result).toEqual({
      artifact: { status: 'failed', error: 'tick lock busy' },
      exitCode: 3,
    });
  });

  it('refuses an operator command without a handler', async () => {
    const result = await run(['repair-prepare', 'crq-historical-F1'], {
      shadowRoot: '/unused',
      tick: 'x',
    });
    expect(result.exitCode).toBe(1);
    expect(result.artifact).toEqual({
      status: 'failed',
      error: 'repair-prepare is not implemented',
    });
  });

  it('leaves unit live commands refusing arguments and mapping non-ok to 1', async () => {
    expect((await run(['watchdog', 'extra'], { shadowRoot: '/unused', tick: 'x' })).exitCode).toBe(
      2,
    );
    const failed = await run(['watchdog'], {
      shadowRoot: '/unused',
      tick: 'x',
      live: async () => ({ status: 'failed', error: 'alert failed' }),
    });
    expect(failed).toEqual({
      artifact: { status: 'failed', error: 'alert failed' },
      exitCode: 1,
    });
  });
});
