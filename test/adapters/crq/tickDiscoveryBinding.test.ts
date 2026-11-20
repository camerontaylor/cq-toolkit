import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mergedDiscoveryBinding,
  mergedDiscoveryEnabled,
  tickDiscoveryBinding,
} from '../../../src/adapters/crq/tickDiscoveryBinding.js';
import { ForgeBudget } from '../../../src/policy/crq/forgeBudget.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import type { GhFn } from '../../../src/adapters/forge-github/gh.js';

const NOW = new Date('2026-11-14T12:00:00Z');
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tick-binding-'));
  await mkdir(join(root, 'reconcile'));
  await writeFile(join(root, 'queue.json'), '{"items":[],"from_disk":true}\n');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const json = (text: string): JsonObject => parseJsonValue(text) as JsonObject;
const diskQueue = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(root, 'queue.json'), 'utf8')) as Record<string, unknown>;
const emptyGh: GhFn = async () => ({ code: 0, stdout: '[]', stderr: '' });
const budget = () => new ForgeBudget({ requests: 8, seconds: 30, clock: () => 0 });

function merged(config: string, gh: GhFn = emptyGh) {
  return mergedDiscoveryBinding(json(config), {
    repo: 'acme/repo',
    stateRoot: root,
    now: () => NOW,
    gh,
  });
}

describe('merged discovery binding', () => {
  it('persists the threaded in-memory queue before discovery reloads from disk', async () => {
    const result = await merged(
      '{"merged_discovery":{"enabled":true,"after":"2026-11-01T00:00:00Z"}}',
    )(json('{"items":[],"in_memory_only":7}'), budget());
    expect(result.log[0]).toContain('merged discovery: complete=True');
    const saved = await diskQueue();
    expect(saved).toMatchObject({ in_memory_only: 7, merged_discovery: { complete: true } });
    expect(saved).not.toHaveProperty('from_disk');
    expect(result.queue.get('in_memory_only')).toBeDefined();
  });

  it('falls back on an invalid configured interval and persists nothing', async () => {
    let calls = 0;
    const result = await merged(
      '{"merged_discovery":{"enabled":true,"after":"bogus"}}',
      async () => {
        calls++;
        return { code: 0, stdout: '[]', stderr: '' };
      },
    )(json('{"items":[]}'), budget());
    expect(calls).toBe(0);
    expect(result.log).toEqual(['merged discovery disabled: invalid configured interval']);
    expect(result.queue.get('merged_discovery')).toEqual(json('{"complete":false}'));
    expect(await diskQueue()).toEqual({ items: [], from_disk: true });
  });

  it('is a no-op (no forge, no disk write) when disabled or absent', async () => {
    let calls = 0;
    const gh: GhFn = async () => {
      calls++;
      return { code: 0, stdout: '[]', stderr: '' };
    };
    for (const config of [
      '{}',
      '{"merged_discovery":{"enabled":false}}',
      '{"merged_discovery":1}',
    ]) {
      const queue = json('{"items":[],"unsaved":1}');
      const result = await merged(config, gh)(queue, budget());
      expect(result).toEqual({ queue, log: [] });
    }
    expect(calls).toBe(0);
    expect(await diskQueue()).toEqual({ items: [], from_disk: true });
  });

  it('treats an empty rolling interval as the invalid-interval fallback', async () => {
    // floor == the rolling upper bound (now - 1 s): Python refuses it the same way.
    const queue = json('{"items":[]}');
    const result = await merged(
      '{"merged_discovery":{"enabled":true,"after":"2026-11-14T11:59:59Z"}}',
    )(queue, budget());
    expect(result.log).toEqual(['merged discovery disabled: invalid configured interval']);
    expect(await diskQueue()).toEqual({ items: [], from_disk: true });
  });

  it('reports the enabled gate as Python does', () => {
    expect(mergedDiscoveryEnabled(json('{"merged_discovery":{"enabled":true}}'))).toBe(true);
    expect(mergedDiscoveryEnabled(json('{"merged_discovery":{"enabled":1}}'))).toBe(false);
    expect(mergedDiscoveryEnabled(json('{"merged_discovery":[]}'))).toBe(false);
    expect(mergedDiscoveryEnabled(json('{}'))).toBe(false);
  });
});

describe('tick discovery binding', () => {
  const config =
    '{"repo":"acme/repo","clone":"/srv/primary","quiet_minutes":10,' +
    '"repos":[{"repo":"acme/infra","clone":"/srv/infra","discovery":{"push":false,"pr":true}}]}';
  const options = (cfg: string) => ({
    repo: 'acme/repo',
    stateRoot: root,
    now: () => NOW,
    gh: emptyGh,
    config: json(cfg),
    push: { event: async () => {} },
    enroll: {
      localReview: {} as never,
      event: async () => {},
      ownRange: async () => [] as never,
    },
  });

  it('refuses a malformed repos config when built, before any phase runs', () => {
    expect(() =>
      tickDiscoveryBinding(options('{"repo":"acme/repo","clone":"/c","repos":{}}')),
    ).toThrow(/repos must be a list/);
  });

  it('exposes the merged-discovery gate for the client-health phase', () => {
    expect(tickDiscoveryBinding(options(config)).mergedDiscoveryEnabled()).toBe(false);
    expect(
      tickDiscoveryBinding(
        options(config.replace('"repos"', '"merged_discovery":{"enabled":true},"repos"')),
      ).mergedDiscoveryEnabled(),
    ).toBe(true);
  });

  it('runs the discovery phase: merged gate off and no pushing repos reads nothing', async () => {
    const binding = tickDiscoveryBinding(options(config));
    const queue = json('{"items":[],"from_disk":true}');
    const result = await binding.discovery(queue);
    expect(result.log).toEqual([]);
    expect(result.queue.get('from_disk')).toBe(true);
  });
});
