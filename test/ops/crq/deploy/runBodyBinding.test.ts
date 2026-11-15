import { beforeEach, describe, expect, test, vi } from 'vitest';
import { parseJsonValue, JsonObject } from '../../../../src/policy/crq/jsonValue.js';
import {
  bindRun,
  type BoundController,
  type RunConfig,
  type RunDeps,
  type RunUnits,
} from '../../../../src/ops/crq/deploy/runBodyBinding.js';
import { switchCheckout } from '../../../../src/ops/crq/deploy/deployOps.js';
import { FailStop as UnitFailStop } from '../../../../src/ops/crq/deploy/deployUnitSteps.js';
import { Refused as GuardRefused } from '../../../../src/ops/crq/deploy/gitGuards.js';
import {
  Interrupted,
  FailStop,
  RecoveryRequired,
  Refused,
  type HoldLike,
} from '../../../../src/ops/crq/deploy/rollbackRecover.js';

vi.mock('../../../../src/ops/crq/deploy/deployOps.js', () => ({ switchCheckout: vi.fn() }));

const PRIOR = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const TRIGGERS = ['crq-a.timer', 'crq-b.path'];
const CONFIG = new TextEncoder().encode('{"repair":{"cq_bin":"@HOST_CQ_BIN@"}}');

interface Effects {
  readonly tag: 'effects';
}
interface World {
  head: string;
  events: string[];
  writes: { path: string; value: Record<string, unknown> }[];
  narration: string[];
  states: Record<string, string>;
  markerHolder: number | null;
  nextHold: number;
  digests: string[];
  compatible: boolean[];
  drained: boolean;
  drainBlockedAfterSwitch: boolean;
  health: Record<string, unknown>;
  config: Uint8Array;
}

function fresh(): World {
  return {
    head: PRIOR,
    events: [],
    writes: [],
    narration: [],
    states: Object.fromEntries(TRIGGERS.map((u) => [u, 'active'])),
    markerHolder: null,
    nextHold: 1,
    digests: ['q1'],
    compatible: [],
    drained: true,
    drainBlockedAfterSwitch: false,
    health: { healthy: true },
    config: CONFIG,
  };
}

function build(w: World, patch: Partial<RunConfig> = {}) {
  const config: RunConfig = {
    root: '/live',
    rootIsDir: true,
    overlayIsFile: true,
    tag: null,
    targetSha: TARGET,
    noFetch: true,
    recordDir: '/rec',
    json: false,
    serviceDrainDeadlineS: 30,
    drainDeadlineS: 30,
    drainIntervalS: 1,
    healthTimeoutS: 5,
    healthIntervalS: 0,
    ...patch,
  };
  const units: RunUnits = {
    inventory: async () => ({ triggers: [...TRIGGERS], services: ['crq-a.service'] }),
    stop: async (list) => {
      w.events.push('units.stop');
      for (const u of list) w.states[u] = 'inactive';
    },
    start: async (list) => {
      w.events.push('units.start');
      for (const u of list) w.states[u] = 'active';
    },
    state: async (u) => w.states[u] ?? 'inactive',
  };
  const controller: BoundController<Effects> = {
    preservedDigests: async () => {
      const value = w.digests.length > 1 ? w.digests.shift()! : w.digests[0]!;
      w.events.push(`digests:${value}`);
      return { queue: value };
    },
    compatibilityRecord: async (_e, sha) => ({ for: sha }),
    rollbackCompatible: () => (w.compatible.length > 0 ? w.compatible.shift()! : true),
    runnerLiveness: async () => 'live',
    drainCheck: async () => ({
      drained: w.drained && !(w.drainBlockedAfterSwitch && w.head === TARGET),
      blocked: ['job-1'],
    }),
    waitForFirstTick: async () => 'tick',
    healthObservation: async () => 'obs',
    twoSlotHealth: async () => ({ ...w.health }),
  };
  const newHold = (): HoldLike => {
    const id = w.nextHold++;
    const hold = {
      acquired: false,
      acquire: async () => {
        w.events.push(`hold.acquire:${String(id)}`);
        if (w.markerHolder !== null) throw new Refused('admission is already held');
        w.markerHolder = id;
        hold.acquired = true;
      },
      owns: async () => w.markerHolder === id,
      release: async () => {
        w.events.push(`hold.release:${String(id)}`);
        w.markerHolder = null;
        hold.acquired = false;
      },
    };
    return hold;
  };
  const deps: RunDeps<Effects, object, BoundController<Effects>> = {
    config,
    lock: {
      acquire: async () => void w.events.push('lock.acquire'),
      release: async () => void w.events.push('lock.release'),
    },
    newHold,
    headSha: async () => w.head,
    guard: {
      statusPorcelain: async () => ({ returncode: 0, stdout: '', stderr: '' }),
      git: async () => '',
    },
    targetEffects: { git: async () => ({ code: 0, stdout: TARGET, stderr: '' }) },
    claim: {
      resolve: (p) => p,
      join: (a, b) => `${a}/${b}`,
      mkdirPrivateAll: () => undefined,
      mode: () => 0o700,
      mkdirPrivate: () => undefined,
      now: () => new Date(Date.UTC(2026, 10, 15, 1, 2, 3)),
      uuidHex: () => 'abcdef123456',
    },
    receipt: {
      exists: () => false,
      loadJson: () => {
        throw new Error('no receipt expected');
      },
      durableWrite: (path, value) => void w.writes.push({ path, value }),
      nowIso: () => 'T',
    },
    modules: {
      mkdirPrivateAll: () => undefined,
      gitShowBytes: async () => new Uint8Array([1]),
      writeExclusive: () => undefined,
      loadModule: async () => {
        throw new Error('modules are injected');
      },
      verifyTargetTag: () => 'defaulted',
    },
    loadOverlay: async () => ({
      overlay: parseJsonValue('{}') as JsonObject,
      effects: { tag: 'effects' },
    }),
    live: {
      readFile: async () => w.config,
      isFile: async () => false,
      sha256File: async () => '',
      modeBits: async () => 0,
      resolve: async (p) => p,
    },
    units,
    switchEffects: {} as never,
    helper: {},
    controller,
    durableWrite: async (path, value) => void w.writes.push({ path, value }),
    nowIso: () => 'T',
    clock: () => 0,
    sleep: async () => undefined,
    narrate: (m) => void w.narration.push(m),
  };
  return { bound: bindRun(deps), deps };
}

const phases = (w: World): string[] =>
  w.writes.filter((x) => x.path.endsWith('phase.json')).map((x) => x.value['phase'] as string);

beforeEach(() => {
  vi.mocked(switchCheckout).mockReset();
});

function switchTo(w: World): void {
  vi.mocked(switchCheckout).mockImplementation(async (_e, _root, _overlay, sha) => {
    w.events.push(`switch:${sha.slice(0, 1)}`);
    w.head = sha;
    return '';
  });
}

describe('binding: the forward path', () => {
  test('runs every phase in order, over one state, and releases the lock last', async () => {
    const w = fresh();
    switchTo(w);
    const { bound } = build(w);
    const result = (await bound.run()) as Record<string, unknown>;
    expect(result['outcome']).toBe('completed');
    expect(result['released']).toBe(true);
    expect(result['run_dir']).toBe('/rec/run-20261115T010203Z-abcdef');
    expect(phases(w)).toEqual([
      'resolved',
      'prepared',
      'held',
      'stopped',
      'remeasured',
      'drained',
      'switched',
      'admission_released',
      'restarted',
      'released',
    ]);
    expect(w.events[0]).toBe('lock.acquire');
    expect(w.events.at(-1)).toBe('lock.release');
    expect(w.events.filter((e) => e.startsWith('switch'))).toEqual(['switch:b']);
    const names = w.writes.map((x) => x.path.split('/').at(-1));
    expect(names).toContain('recovery-receipt.json');
    expect(names).toContain('health.json');
    expect(names.at(-1)).toBe('phase.json');
    expect(names.lastIndexOf('deploy.json')).toBeLessThan(names.lastIndexOf('phase.json'));
    expect(bound.state.target).toBe(TARGET);
    expect(bound.state.priorSha).toBe(PRIOR);
    expect(Object.keys(bound.state.original ?? {})).toEqual(TRIGGERS);
  });

  test('the switch gets the root, the target and the tag', async () => {
    const w = fresh();
    switchTo(w);
    await build(w, { tag: 'crq-runner/20261115-1' }).bound.run();
    const call = vi.mocked(switchCheckout).mock.calls[0]!;
    expect(call[1]).toBe('/live');
    expect(call[3]).toBe(TARGET);
    expect(call[4]).toBe('crq-runner/20261115-1');
  });

  test('the re-measured baseline replaces the pre-hold one', async () => {
    // measure: q1; recheck: q2; after the switch: q2. Keeping q1 would read as a change.
    const w = fresh();
    w.digests = ['q1', 'q2', 'q2'];
    switchTo(w);
    const { bound } = build(w);
    expect(((await bound.run()) as Record<string, unknown>)['outcome']).toBe('completed');
    expect(bound.state.preserved).toEqual({ queue: 'q2' });
  });

  test('--json silences narration', async () => {
    const quiet = fresh();
    switchTo(quiet);
    await build(quiet, { json: true }).bound.run();
    expect(quiet.narration).toEqual([]);
    const loud = fresh();
    switchTo(loud);
    await build(loud).bound.run();
    expect(loud.narration).toContain(`switching to ${TARGET}`);
  });
});

describe('binding: failures reach the right terminal state', () => {
  test('a failed health check rolls back to the prior checkout', async () => {
    const w = fresh();
    w.health = { healthy: false, reason: 'boom' };
    switchTo(w);
    const { bound } = build(w);
    const result = (await bound.run()) as Record<string, unknown>;
    expect(result['outcome']).toBe('rolled_back');
    expect(String(result['reason'])).toContain('health check failed: boom');
    expect(w.events.filter((e) => e.startsWith('switch'))).toEqual(['switch:b', 'switch:a']);
    expect(w.head).toBe(PRIOR);
    expect(w.events.at(-1)).toBe('lock.release');
  });

  test('an interrupt during the health window rolls back and re-raises the interrupt', async () => {
    const w = fresh();
    switchTo(w);
    const { bound, deps } = build(w);
    const interrupt = new Interrupted('^C');
    deps.controller!.twoSlotHealth = async () => {
      throw interrupt;
    };
    await expect(bound.run()).rejects.toBe(interrupt);
    expect(w.events.filter((e) => e.startsWith('switch'))).toEqual(['switch:b', 'switch:a']);
    expect(w.writes.some((x) => x.value['reason'] === 'interrupted by the operator')).toBe(true);
    expect(w.events.at(-1)).toBe('lock.release');
  });

  test('a drain that expires keeps the hold and fail-stops, never rolls back', async () => {
    const w = fresh();
    w.drained = false;
    switchTo(w);
    const { bound } = build(w, { drainDeadlineS: 0 });
    await expect(bound.run()).rejects.toBeInstanceOf(RecoveryRequired);
    expect(w.markerHolder).not.toBeNull();
    expect(w.events.filter((e) => e.startsWith('switch'))).toEqual([]);
    expect(w.events.at(-1)).toBe('lock.release');
  });

  test('a drain that expires during rollback fail-stops through recovery’s own drain', async () => {
    const w = fresh();
    w.health = { healthy: false, reason: 'boom' };
    w.drainBlockedAfterSwitch = true;
    switchTo(w);
    const { bound } = build(w, { drainDeadlineS: 0 });
    await expect(bound.run()).rejects.toBeInstanceOf(RecoveryRequired);
    expect(w.events.filter((e) => e.startsWith('switch'))).toEqual(['switch:b']);
    expect(w.events.at(-1)).toBe('lock.release');
  });

  test('a refusal after the hold restores the host and releases the marker', async () => {
    const w = fresh();
    // measure: compatible; recheck after the drain: not compatible.
    w.compatible = [true, false];
    switchTo(w);
    const { bound } = build(w);
    await expect(bound.run()).rejects.toThrow('queue no longer grants automatic rollback');
    expect(w.markerHolder).toBeNull();
    expect(w.events.filter((e) => e.startsWith('switch'))).toEqual([]);
    expect(w.states).toEqual({ 'crq-a.timer': 'active', 'crq-b.path': 'active' });
    expect(w.writes.some((x) => x.value['outcome'] === 'refused')).toBe(true);
    expect(w.events.at(-1)).toBe('lock.release');
  });

  test('a refusal before any state exists never touches units or the hold', async () => {
    const w = fresh();
    w.head = TARGET;
    const { bound } = build(w);
    await expect(bound.run()).rejects.toThrow('is already the checked-out HEAD');
    expect(w.events).toEqual(['lock.acquire', 'lock.release']);
    expect(bound.state.triggers).toBeNull();
    expect(bound.state.hold).toBeNull();
  });
});

describe('shared error classes', () => {
  test("another module's FailStop and Refused are recovery's own classes", () => {
    expect(UnitFailStop).toBe(FailStop);
    expect(GuardRefused).toBe(Refused);
    expect(new UnitFailStop('drain expired')).toBeInstanceOf(Refused);
  });
  test('RecoveryRequired keeps its record and defaults it to empty', () => {
    expect(new RecoveryRequired('stuck').record).toEqual({});
    expect(new RecoveryRequired('stuck', { a: 1 }).record).toEqual({ a: 1 });
  });
});
