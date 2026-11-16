import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileDiscoveryPhaseEffects } from '../../../src/adapters/crq/tickDiscoveryPhaseSource.js';
import type { PushRepository } from '../../../src/adapters/crq/pushDiscoverySource.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { runDiscoveryPhase } from '../../../src/queue-runner/tickDiscoveryPhase.js';

const tip = 'b'.repeat(40);
const repo: PushRepository = {
  repo: 'o/r',
  name: 'r',
  clone: '/fake/clone',
  defaultBranch: 'main',
  enabled: true,
  floor: '2025-01-01',
  quietMinutes: 10,
};
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tick-discovery-'));
  await writeFile(join(root, 'queue.json'), '{"items":[],"unknown":1.5}\n');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const queue = () => parseJsonValue('{"items":[],"unknown":1.5}') as JsonObject;
function build(mergedCalls: string[]) {
  return fileDiscoveryPhaseEffects({
    repo: 'o/r',
    stateRoot: root,
    now: () => new Date('2026-11-15T01:02:03.999Z'),
    merged: async (q) => {
      mergedCalls.push('merged');
      return { queue: q, log: ['merged ran'] };
    },
    push: {
      repos: [repo],
      event: async () => {},
      git: () => async (args) => ({
        args,
        code: 0,
        stdout: new TextEncoder().encode(args[0] === 'rev-parse' ? tip : ''),
        stderr: '',
      }),
    },
  });
}

describe('file discovery phase effects', () => {
  it('runs merged then push, persisting the push result and lossless numbers', async () => {
    const calls: string[] = [];
    const result = await runDiscoveryPhase(queue(), { dry: false, only: null }, build(calls));
    expect(calls).toEqual(['merged']);
    expect(result.log[0]).toBe('merged ran');
    const saved = await readFile(join(root, 'queue.json'), 'utf8');
    expect(saved).toContain(tip);
    expect(saved).toContain('1.5');
  });

  it('does nothing on a dry or restricted tick', async () => {
    const calls: string[] = [];
    const before = await readFile(join(root, 'queue.json'), 'utf8');
    for (const options of [
      { dry: true, only: null },
      { dry: false, only: 'x' },
    ])
      expect((await runDiscoveryPhase(queue(), options, build(calls))).log).toEqual([]);
    expect(calls).toEqual([]);
    expect(await readFile(join(root, 'queue.json'), 'utf8')).toBe(before);
  });

  it('treats a repo-less push item as the primary repository lane', async () => {
    const pinned = parseJsonValue(
      JSON.stringify({
        items: [{ kind: 'push-current', state: 'reviewing', id: 'p1' }],
        push_discovery: { 'o/r': { reviewed_tip: 'a'.repeat(40) } },
      }),
    ) as JsonObject;
    const result = await runDiscoveryPhase(pinned, { dry: false, only: null }, build([]));
    expect(result.log).toContain('push discovery o/r: captured push item pins the lane');
  });

  it('formats the clock as whole-second UTC', () => {
    expect(build([]).nowIso()).toBe('2026-11-15T01:02:03Z');
  });
});
