import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from './runner.js';

/** The first ported tick effect. Other tick phases remain unimplemented. */
export async function planTick(root: string, command: string, args: string[]): Promise<Plan> {
  if (command !== 'tick') throw new Error(`${command} is not implemented`);
  if (args.length !== 0) throw new Error('tick does not accept these arguments');
  try {
    await stat(join(root, 'runner-disabled'));
    return { value: { complete: false, reason: 'runner disabled' }, mutations: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const queue: unknown = JSON.parse(await readFile(join(root, 'queue.json'), 'utf8'));
  if (
    typeof queue !== 'object' ||
    queue === null ||
    Array.isArray(queue) ||
    !Array.isArray((queue as Record<string, unknown>).items)
  ) {
    throw new Error('queue.json must be an object with an items array');
  }
  return {
    value: { complete: false, reason: 'discovery, harvest and admission are not implemented' },
    mutations: [
      {
        operation: 'set',
        target: 'queue.json#/last_tick',
        value: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      },
    ],
  };
}
