/**
 * The glue between the item loop and the rung machine
 * (`src/queue-runner/repairProcess.ts`).
 *
 * The decisions are pinned elsewhere against Python: `process()` by the
 * differential fixture replayed in `repairRungMachine.test.ts`, `process_item`
 * by `test/ops/crq/repairItemLoop.test.ts`. This file covers what only the
 * composition owns: value-model conversion, and the FIXED-commit chain
 * reaching the next job's `repair_base` through the real rung machine.
 */
import { describe, expect, test } from 'vitest';

import { JsonNumber, JsonObject, type JsonValue } from '../../src/policy/crq/jsonValue.js';
import {
  bindRepairProcess,
  bindRepairProcessItem,
  toJsonValue,
} from '../../src/queue-runner/repairProcess.js';
import type { RepairRungEffects } from '../../src/queue-runner/repairRungMachine.js';

const ROOT = '/T/root';
const BASE = 'b'.repeat(40);
const obj = (...entries: [string, JsonValue][]): JsonObject => new JsonObject(entries);

const config = {
  clone: '/T/clone',
  worktree_root: '/T/wt',
  repair: {
    roles: {
      fixer: { driver: 'codex', model: 'm1' },
      fixer_escalation: { driver: 'codex', model: 'm2' },
      judge: { driver: 'codex', model: 'm3' },
      judge_critical: { driver: 'codex', model: 'm4' },
    },
  },
};

function job(id: string, run = 'r1'): JsonObject {
  return obj(
    ['job', id],
    ['item', 'pr1-merged'],
    ['run', run],
    ['repair_base', BASE],
    ['source_sha', 's'.repeat(40)],
    ['finding_sha256', 'f'.repeat(64)],
    ['finding', obj(['severity', 'major'])],
  );
}

function rig(
  options: {
    files?: Record<string, unknown>;
    stops?: unknown[];
    prior?: unknown;
  } = {},
) {
  const files = new Map<string, unknown>(Object.entries(options.files ?? {}));
  const writes: { path: string; value: unknown }[] = [];
  const dispatched: { job: string; base: unknown }[] = [];
  const reports = [...(options.stops ?? [])];
  const effects: RepairRungEffects = {
    reads: {
      resultExists: async () => options.prior !== undefined,
      readResult: async () => options.prior,
      progressExists: async () => false,
      resultMtimeNs: async () => 0n,
      progressMtimeNs: async () => 0n,
      readProgress: async () => undefined,
      nowMicros: () => 1_700_000_000_000_000n,
      utc: () => '2026-01-01T00:00:00Z',
    },
    probes: {
      resolve: async (path) => path,
      isDirectory: async () => false,
      exists: async () => false,
    },
    ensureDirectory: async () => undefined,
    pathExists: async (path) => files.has(path),
    writeJson: async (path, value) => {
      writes.push({
        path,
        value: JSON.parse(
          JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v)),
        ),
      });
    },
    blocked: async () => false,
    rateLimitPause: async () => '2026-01-01T00:30:00Z',
    retain: async () => undefined,
    retainPreservingNested: async () => undefined,
    git: async () => '',
    catFileBlob: async () => ({ returncode: 1, stdout: '' }),
    dispatch: async (_role, current) => {
      dispatched.push({ job: String(current.job), base: current.repair_base });
      return reports.shift();
    },
    mechanical: async () => ({}),
    random: () => 0.5,
  };
  return { effects, writes, dispatched };
}

const fixed = (commit: string): unknown => ({
  stop: 'ok',
  changed: true,
  commits: [commit],
  summary: 'fixed',
});

function itemEffects() {
  const narrated: string[] = [];
  return {
    narrated,
    effects: {
      runnerDisabled: async () => false,
      narrate: (message: string) => narrated.push(message),
      blocked: () => false,
      dispatchPaused: async () => null,
      readTriageRow: async () => undefined,
      pending: async () => true,
      worktreePath: (name: string) => `/T/wt/${name}`,
      worktreeExists: async () => true,
      addWorktree: async () => 0,
    },
  };
}

describe('toJsonValue', () => {
  test('keeps kinds, order and nesting', () => {
    const converted = toJsonValue({ b: 1n, a: [JsonNumber.float(1), 2, 1.5, null, 'x', true] });
    expect(converted).toBeInstanceOf(JsonObject);
    const out = converted as JsonObject;
    expect(out.entries.map(([key]) => key)).toEqual(['b', 'a']);
    const list = out.get('a') as JsonValue[];
    expect((list[0] as JsonNumber).kind).toBe('float');
    expect((list[1] as JsonNumber).kind).toBe('int');
    expect((list[2] as JsonNumber).kind).toBe('float');
    expect(list.slice(3)).toEqual([null, 'x', true]);
  });

  test('refuses a non-JSON value', () => {
    expect(() => toJsonValue(() => 1)).toThrow(TypeError);
  });
});

describe('bindRepairProcess', () => {
  test('returns the rung machine result as a JsonObject', async () => {
    const { effects, writes } = rig({ stops: [fixed('c1')] });
    const result = await bindRepairProcess({ config, root: ROOT, effects })(
      job('j-F1'),
      '/T/wt/w1',
    );
    expect(result.get('verdict')).toBe('FIXED');
    expect(result.get('commits')).toEqual(['c1']);
    expect(writes.at(-1)?.path).toBe(`${ROOT}/state/repair/j-F1/result.json`);
  });

  test('a prior terminal result is returned untouched', async () => {
    const prior = { job: 'j-F1', verdict: 'NOT-FIXED', commits: [] };
    const { effects, writes } = rig({ prior });
    const result = await bindRepairProcess({ config, root: ROOT, effects })(
      job('j-F1'),
      '/T/wt/w1',
    );
    expect(result.get('verdict')).toBe('NOT-FIXED');
    expect(writes).toEqual([]);
  });
});

describe('bindRepairProcessItem', () => {
  test('a FIXED job chains its tip into the next job of the run', async () => {
    const { effects, dispatched } = rig({ stops: [fixed('c1'), fixed('c2')] });
    const item = itemEffects();
    const run = bindRepairProcessItem({ config, root: ROOT, effects }, item.effects);
    const jobs = [job('j-F2'), job('j-F1')];
    const outcome = await run(jobs, { publishRefusal: () => undefined });
    expect(outcome).toBeNull();
    expect(dispatched).toEqual([
      { job: 'j-F1', base: BASE },
      { job: 'j-F2', base: 'c1' },
    ]);
    expect(jobs.map((entry) => entry.get('job'))).toEqual(['j-F1', 'j-F2']);
  });

  test('a deferred (rate-limited) job stops the item with no outcome', async () => {
    const { effects, dispatched } = rig({ stops: [{ stop: 'rate-limit', summary: 'slow' }] });
    const item = itemEffects();
    const run = bindRepairProcessItem({ config, root: ROOT, effects }, item.effects);
    const outcome = await run([job('j-F1'), job('j-F2')], { publishRefusal: () => undefined });
    expect(outcome).toBeNull();
    expect(dispatched.map((d) => d.job)).toEqual(['j-F1']);
  });
});
