import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileTickMergedDiscoveryEffects } from '../../../src/adapters/crq/tickMergedDiscoverySource.js';
import { withLock } from '../../../src/adapters/crq/lock.js';
import { ForgeBudget } from '../../../src/policy/crq/forgeBudget.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { runMergedDiscoveryStep } from '../../../src/queue-runner/tickMergedDiscovery.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tick-merged-'));
  await mkdir(join(root, 'reconcile'));
  await writeFile(join(root, 'queue.json'), '{"items":[],"unknown":42}\n');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const NOW = new Date('2026-11-14T12:00:00Z');

function effects(
  gh: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
) {
  return fileTickMergedDiscoveryEffects({
    repo: 'acme/repo',
    stateRoot: root,
    now: () => NOW,
    budget: new ForgeBudget({ requests: 8, seconds: 30, clock: () => 0 }),
    gh,
  });
}

describe('tick merged discovery binding', () => {
  it('runs the gated step over a real empty rolling scan and persists the watermark', async () => {
    let calls = 0;
    const bound = effects(async () => {
      calls++;
      return { code: 0, stdout: '[]', stderr: '' };
    });
    const config = parseJsonValue('{"enabled":true,"after":"2026-11-01T00:00:00Z"}');
    const queue = parseJsonValue('{"items":[],"unknown":42}') as JsonObject;
    const result = await withLock(join(root, 'tick.lock'), { wait: false }, () =>
      runMergedDiscoveryStep(queue, config, bound),
    );
    expect(calls).toBeGreaterThan(0);
    expect(result.log[0]).toContain('merged discovery: complete=True');
    expect(JSON.parse(await readFile(join(root, 'queue.json'), 'utf8'))).toMatchObject({
      unknown: 42,
      merged_discovery: { complete: true },
    });
  });

  it('does not touch the forge or the queue when the config gate is off', async () => {
    let calls = 0;
    const bound = effects(async () => {
      calls++;
      return { code: 0, stdout: '[]', stderr: '' };
    });
    const queue = parseJsonValue('{"items":[]}') as JsonObject;
    const result = await runMergedDiscoveryStep(queue, parseJsonValue('{"enabled":false}'), bound);
    expect(calls).toBe(0);
    expect(result).toEqual({ queue, log: [] });
    expect(await readFile(join(root, 'queue.json'), 'utf8')).toBe('{"items":[],"unknown":42}\n');
  });

  it('reads the injected clock', () => {
    expect(effects(async () => ({ code: 0, stdout: '[]', stderr: '' })).now()).toBe(NOW);
  });
});
