import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileTickSeams } from '../../../src/adapters/crq/tickPhaseSeams.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tick-seams-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const cfg = (text: string) => parseJsonValue(text) as JsonObject;
const seams = (config = '{}') =>
  fileTickSeams({
    stateRoot: join(root, 'state'),
    config: cfg(config),
    now: () => Date.UTC(2026, 10, 15, 1, 2, 3, 999),
  });

describe('file tick seams', () => {
  it('reads the clock as whole-second UTC and parse_iso as epoch ms', () => {
    const s = seams();
    expect(s.nowIso()).toBe('2026-11-15T01:02:03Z');
    expect(s.nowMs()).toBe(Date.UTC(2026, 10, 15, 1, 2, 3, 999));
    expect(s.parseIso('2026-11-15T01:02:03.000Z')).toBe(Date.UTC(2026, 10, 15, 1, 2, 3));
    expect(s.parseIso(null)).toBeNull();
    expect(s.parseIso('')).toBeNull();
    expect(() => s.parseIso('garbage')).toThrow();
  });

  it('appends events.jsonl lines in Python json.dumps form', async () => {
    const s = seams();
    await s.event('tick_gap', { last_tick: 'é', gap_min: 3 });
    await s.event('x', {});
    const text = await readFile(join(root, 'state', 'events.jsonl'), 'utf8');
    expect(text).toBe(
      '{"at": "2026-11-15T01:02:03Z", "event": "tick_gap", "last_tick": "\\u00e9", "gap_min": 3}\n' +
        '{"at": "2026-11-15T01:02:03Z", "event": "x"}\n',
    );
  });

  it('enables merged discovery only for enabled === true', () => {
    expect(seams('{"merged_discovery":{"enabled":true}}').mergedDiscoveryEnabled()).toBe(true);
    expect(seams('{"merged_discovery":{"enabled":1}}').mergedDiscoveryEnabled()).toBe(false);
    expect(seams('{"merged_discovery":true}').mergedDiscoveryEnabled()).toBe(false);
    expect(seams('{}').mergedDiscoveryEnabled()).toBe(false);
  });

  it('round-trips the queue and honours the runner-disabled marker', async () => {
    const s = seams();
    await expect(s.loadQueue(true)).rejects.toThrow();
    await rm(join(root, 'state'), { recursive: true, force: true });
    await s.event('mk', {});
    await writeFile(join(root, 'state', 'queue.json'), '{"items":[]}');
    await s.saveQueue(await s.loadQueue(false));
    expect(await readFile(join(root, 'state', 'queue.json'), 'utf8')).toBe('{\n  "items": []\n}\n');
    expect(await s.runnerDisabled()).toBe(false);
    await writeFile(join(root, 'state', 'runner-disabled'), '');
    expect(await s.runnerDisabled()).toBe(true);
  });
});
