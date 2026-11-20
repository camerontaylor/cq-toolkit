// The S6-0 tick host effects: `fetch`, `notifyOwner`, `readSlotUsage`,
// `recordCoverage`. Python oracles: crq.py `fetch`/`run` (:124-134, :317),
// `notify_owner`/`notify` (:1979-1997) and `read_slot_usage` (:3340).
//
// Classification: `process` in test/suite-classes.json (real git fetch).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fileReadSlotUsage,
  fileTickFetch,
  notifyOwnerFrom,
} from '../../../src/adapters/crq/tickHostEffects.js';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';

const doc = (value: unknown): JsonObject => parseJsonValue(JSON.stringify(value)) as JsonObject;
const dir = (): string => mkdtempSync(join(tmpdir(), 'tick-host-'));
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('fileTickFetch', () => {
  it('fetches the primary clone from origin with --prune --quiet', async () => {
    const root = dir();
    const origin = join(root, 'origin.git');
    git(root, 'init', '--bare', '--quiet', origin);
    const seed = join(root, 'seed');
    git(root, 'clone', '--quiet', origin, seed);
    writeFileSync(join(seed, 'a.txt'), 'a\n');
    git(
      seed,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@e',
      'commit',
      '--quiet',
      '-m',
      'a',
      '--allow-empty',
    );
    git(seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
    const clone = join(root, 'clone');
    git(root, 'clone', '--quiet', origin, clone);
    git(
      seed,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@e',
      'commit',
      '--quiet',
      '-m',
      'b',
      '--allow-empty',
    );
    git(seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
    await fileTickFetch(clone)();
    expect(git(clone, 'rev-parse', 'origin/main')).toBe(git(seed, 'rev-parse', 'HEAD'));
  });

  it("raises Python run's message on a non-zero exit, abandoning the tick", async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const fetch = fileTickFetch('/clone', async (cwd, args) => {
      calls.push([cwd, args]);
      return { code: 128, stderr: '  fatal: no such remote\n' };
    });
    await expect(fetch()).rejects.toThrow(
      'git fetch --prune --quiet origin … exit 128: fatal: no such remote',
    );
    expect(calls).toEqual([['/clone', ['fetch', '--prune', '--quiet', 'origin']]]);
  });

  it('propagates a spawn failure (a missing clone directory) rather than succeeding', async () => {
    await expect(fileTickFetch(join(dir(), 'absent'))()).rejects.toThrow();
  });
});

describe('notifyOwnerFrom', () => {
  const capture = () => {
    const sent: Array<[unknown, string]> = [];
    const send = async (destination: JsonObject, text: string) => {
      sent.push([toPlainJson(destination), text]);
      return {};
    };
    return { sent, send };
  };

  it('sends to CONFIG.alerts agent and host', async () => {
    const { sent, send } = capture();
    const config = doc({ alerts: { alert_agent_id: 'agent-1', alert_agent_host: 'h1' } });
    await notifyOwnerFrom(config, send)('recovered');
    expect(sent).toEqual([[{ paseo_agent_id: 'agent-1', paseo_host: 'h1' }, 'recovered']]);
  });

  it('omits a falsy host and sends nothing without an agent id', async () => {
    const { sent, send } = capture();
    await notifyOwnerFrom(
      doc({ alerts: { alert_agent_id: 'a', alert_agent_host: '' } }),
      send,
    )('m');
    for (const config of [{}, { alerts: {} }, { alerts: { alert_agent_id: '' } }]) {
      await notifyOwnerFrom(doc(config), send)('m');
    }
    expect(sent).toEqual([[{ paseo_agent_id: 'a', paseo_host: null }, 'm']]);
  });

  it('raises where Python raises: non-dict alerts, non-string truthy id or host', async () => {
    const { send } = capture();
    const bad: JsonValue[] = [
      doc({ alerts: null }),
      doc({ alerts: ['x'] }),
      doc({ alerts: { alert_agent_id: 7 } }),
      doc({ alerts: { alert_agent_id: 'a', alert_agent_host: 3 } }),
    ];
    for (const config of bad) {
      await expect(notifyOwnerFrom(config as JsonObject, send)('m')).rejects.toThrow(TypeError);
    }
  });
});

describe('fileReadSlotUsage', () => {
  const reviewing = (id: string, run: Record<string, unknown> | null, kind = 'open') => ({
    id,
    kind,
    state: 'reviewing',
    run,
  });
  const QUEUE = {
    items: [
      { id: 'p', kind: 'open', state: 'pending' },
      reviewing('promo', { run_id: 'rp', started_at: 'sp' }, 'promotion'),
      reviewing('seen', { run_id: 'rs', started_at: 'ss', vendor_observed: true }),
      reviewing('progressed', { run_id: 'r1', started_at: 's1' }),
      reviewing('silent', { run_id: 'r2', started_at: 's2' }),
      reviewing('norun', null),
    ],
    starts: [],
  };

  function probes(usage: { remaining: number } | null, progressed: readonly string[]) {
    const order: string[] = [];
    return {
      order,
      probes: {
        vendorProgress: async (runId: string) => (
          order.push(`progress:${runId}`),
          progressed.includes(runId)
        ),
        readUsage: async (clone: string) => (order.push(`usage:${clone}`), usage),
      },
    };
  }

  it('probes progress in queue order, then usage, and marks observed runs on a usage read', async () => {
    const p = probes({ remaining: 4 }, ['r1']);
    const read = await fileReadSlotUsage({ clone: '/clone', probes: p.probes })(doc(QUEUE));
    expect(p.order).toEqual(['progress:r1', 'progress:r2', 'usage:/clone']);
    expect(read.usage).toEqual({ remaining: 4 });
    expect(read.reserved.map((hold) => hold.startedAt)).toEqual(['s2', undefined]);
    const items = (toPlainJson(read.queue) as { items: Array<{ run: unknown }> }).items;
    // Python appends the key to the run dict; nothing else changes.
    expect(items[3]!.run).toEqual({ run_id: 'r1', started_at: 's1', vendor_observed: true });
    expect(items.filter((_, i) => i !== 3)).toEqual(QUEUE.items.filter((_, i) => i !== 3));
  });

  it('folds observed runs back into the held list and marks nothing when usage is unavailable', async () => {
    const p = probes(null, ['r1']);
    const queue = doc(QUEUE);
    const read = await fileReadSlotUsage({ clone: '/clone', probes: p.probes })(queue);
    expect(read.usage).toBeNull();
    expect(read.reserved.map((hold) => hold.startedAt)).toEqual(['s2', undefined, 's1']);
    expect(read.queue).toBe(queue);
  });
});
