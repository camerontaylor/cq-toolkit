// Real-filesystem tests for the bounded `review.ndjson` progress probe. The
// adapter promises "at most the first 64 KiB"; these pin both the prefix
// semantics and that the bound is enforced during the read, not after it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileTickEffects } from '../../../src/adapters/crq/tickSource.js';

const calls = vi.hoisted(() => ({ readFile: 0, open: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: ((...args: Parameters<typeof actual.readFile>) => {
      calls.readFile += 1;
      return actual.readFile(...args);
    }) as typeof actual.readFile,
    open: ((...args: Parameters<typeof actual.open>) => {
      calls.open += 1;
      return actual.open(...args);
    }) as typeof actual.open,
  };
});

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

const PROGRESS = `${JSON.stringify({ type: 'status', status: 'reviewing' })}\n`;
const PADDING = `${'x'.repeat(70_000)}\n`;

async function runRoot(body: string): Promise<ReturnType<typeof fileTickEffects>> {
  const root = await mkdtemp(join(tmpdir(), 'crq-tick-source-'));
  dirs.push(root);
  const runs = join(root, 'state', 'runs');
  await mkdir(join(runs, 'run-1'), { recursive: true });
  await writeFile(join(runs, 'run-1', 'review.ndjson'), body);
  return fileTickEffects({ runnerRoot: root, stateRoot: join(root, 'state') });
}

describe('vendorProgress bound', () => {
  it('reports progress found inside the first 64 KiB', async () => {
    const effects = await runRoot(PROGRESS + PADDING);
    expect(await effects.vendorProgress('run-1')).toBe(true);
  });

  it('ignores progress past the 64 KiB bound', async () => {
    const effects = await runRoot(PADDING + PROGRESS);
    expect(await effects.vendorProgress('run-1')).toBe(false);
  });

  it('reads through a file handle instead of allocating the whole stream', async () => {
    const effects = await runRoot(PROGRESS + PADDING);
    calls.readFile = 0;
    calls.open = 0;
    expect(await effects.vendorProgress('run-1')).toBe(true);
    expect(calls.open).toBe(1);
    expect(calls.readFile).toBe(0);
  });
});
