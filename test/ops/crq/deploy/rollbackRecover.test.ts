import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import {
  FailStop,
  HealthFailed,
  Interrupted,
  OSError,
  RecoveryRequired,
  Refused,
  RunRecovery,
  compatibilityReason,
  pyRepr,
  type HoldLike,
  type RecoveryDeps,
  type Result,
  type RunState,
} from '../../../../src/ops/crq/deploy/rollbackRecover.js';

const PRIOR = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const CLEAN: Result = { checked: true, schema_marker_present: false, schema_observations: [] };

class FakeHold implements HoldLike {
  acquired: boolean;
  owned = true;
  constructor(
    acquired: boolean,
    private readonly log: string[],
    private readonly acquireError?: Error,
  ) {
    this.acquired = acquired;
  }
  acquire(): Promise<void> {
    this.log.push('hold.acquire');
    if (this.acquireError) return Promise.reject(this.acquireError);
    this.acquired = true;
    return Promise.resolve();
  }
  owns(): Promise<boolean> {
    return Promise.resolve(this.owned);
  }
  release(): Promise<void> {
    this.log.push('hold.release');
    this.acquired = false;
    return Promise.resolve();
  }
}

interface Fx {
  log: string[];
  writes: { name: string; value: Result }[];
  state: RunState;
  deps: RecoveryDeps<string>;
  unitStates: Record<string, string>;
  hold: FakeHold;
  cfg: { live: Uint8Array };
  head: { v: string };
  compat: { records: Result[]; calls: number };
  digests: { seq: Record<string, unknown>[]; calls: number };
  fail: { write?: Error; stop?: Error; switch?: Error; runtime?: Error };
  inner: { run: () => Promise<Result> };
}
function fixture(over: Partial<RunState> = {}): Fx {
  const log: string[] = [];
  const writes: { name: string; value: Result }[] = [];
  const unitStates: Record<string, string> = { 'a.timer': 'active', 'b.timer': 'inactive' };
  const hold = new FakeHold(true, log);
  const cfg = { live: enc('cfg-orig') };
  const head = { v: PRIOR };
  const compat = { records: [CLEAN], calls: 0 };
  const digests = { seq: [{ queue: 'q1', hb: 'h1' }], calls: 0 };
  const fail: Fx['fail'] = {};
  const inner = { run: (): Promise<Result> => Promise.resolve({ outcome: 'completed' }) };
  const state: RunState = {
    tag: 'T',
    runDir: '/run/1',
    target: TARGET,
    priorSha: PRIOR,
    original: { ...unitStates },
    originalConfig: enc('cfg-orig'),
    cqBin: { pointer: 'x' },
    preserved: { queue: 'q1', hb: 'h1' },
    triggers: ['b.timer', 'a.timer'],
    hold,
    switchAttempted: false,
    switched: false,
    released: false,
    finalTriggers: null,
    rollback: null,
    postCompatibility: null,
    moduleDigests: null,
    ...over,
  };
  const deps: RecoveryDeps<string> = {
    effects: 'fx',
    controller: {
      compatibilityRecord: (e, sha) => {
        log.push(`compat:${e}:${sha}`);
        const r = compat.records[Math.min(compat.calls++, compat.records.length - 1)]!;
        return Promise.resolve(r);
      },
      rollbackCompatible: (r) => r['checked'] === true && r['schema_marker_present'] === false,
      preservedDigests: () => {
        log.push('digests');
        return Promise.resolve(digests.seq[Math.min(digests.calls++, digests.seq.length - 1)]!);
      },
    },
    units: {
      stop: (u) => {
        log.push(`stop:${u.join(',')}`);
        if (fail.stop) return Promise.reject(fail.stop);
        for (const x of u) unitStates[x] = 'inactive';
        return Promise.resolve();
      },
      start: (u) => {
        log.push(`start:${u.join(',')}`);
        for (const x of u) unitStates[x] = 'active';
        return Promise.resolve();
      },
      state: (u) => Promise.resolve(unitStates[u]!),
    },
    newHold: () => hold,
    switchCheckout: (sha) => {
      log.push(`switch:${sha}`);
      if (fail.switch) return Promise.reject(fail.switch);
      head.v = sha;
      cfg.live = enc('cfg-orig');
      return Promise.resolve();
    },
    headSha: () => Promise.resolve(head.v),
    readConfig: () => Promise.resolve(cfg.live),
    runtimePointerCheck: () => {
      log.push('runtime');
      return fail.runtime ? Promise.reject(fail.runtime) : Promise.resolve();
    },
    drainServices: () => {
      log.push('drainServices');
      return Promise.resolve();
    },
    drainQueue: (n) => {
      log.push(`drainQueue:${n}`);
      return Promise.resolve();
    },
    durableWrite: (name, value) => {
      if (fail.write) return Promise.reject(fail.write);
      writes.push({ name, value });
      log.push(`write:${name}`);
      return Promise.resolve();
    },
    now: () => 'NOW',
    narrate: (m) => {
      log.push(`narrate:${m}`);
    },
    releaseLock: () => {
      log.push('lock.release');
    },
    innerRun: () => inner.run(),
  };
  return { log, writes, state, deps, unitStates, hold, cfg, head, compat, digests, fail, inner };
}
const rec = (f: Fx): RunRecovery<string> => new RunRecovery(f.state, f.deps);
async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('did not throw');
}

describe('compatibilityReason', () => {
  test.each([
    [null, 'the compatibility record was not checked'],
    [[], 'the compatibility record was not checked'],
    [{ checked: 'yes' }, 'the compatibility record was not checked'],
    [{ checked: false }, 'the compatibility record was not checked'],
    [
      { checked: true, queue_schema: 'unreadable: boom' },
      'the state queue could not be read (boom)',
    ],
    [
      { checked: true, queue_schema: 3 },
      'the queue carries an explicit schema marker (3) the prior target was never proven to read',
    ],
    [
      { checked: true, queue_schema: "it's" },
      `the queue carries an explicit schema marker ("it's") the prior target was never proven to read`,
    ],
    [
      { checked: true, queue_schema: 'v2' },
      "the queue carries an explicit schema marker ('v2') the prior target was never proven to read",
    ],
    [
      { checked: true, schema_marker_present: false, schema_observations: ['author_a', 7] },
      'the queue carries state keys the prior target was never proven to read: author_a, 7',
    ],
    [
      { checked: true, schema_marker_present: false, schema_observations: [] },
      'the compatibility record is not the clean shape',
    ],
  ])('%j', (record, expected) => {
    expect(compatibilityReason(record)).toBe(expected);
  });
  test('a missing marker key is not the clean shape', () => {
    expect(compatibilityReason({ checked: true })).toContain('explicit schema marker (None)');
  });
});

describe('pyRepr', () => {
  test('matches Python repr for JSON shapes', () => {
    expect(pyRepr({ a: [1, true, null, 'x\n'], b: 'q\'"' })).toBe(
      `{'a': [1, True, None, 'x\\n'], 'b': 'q\\'"'}`,
    );
  });
});

describe('document / writeRecord / phase', () => {
  test('document carries the run identity and extras', () => {
    const f = fixture();
    expect(rec(f).document('x', { reason: 'r' })).toEqual({
      operation: 'deploy',
      outcome: 'x',
      released: false,
      target: TARGET,
      prior_sha: PRIOR,
      tag: 'T',
      run_dir: '/run/1',
      cq_bin: { pointer: 'x' },
      original_triggers: { 'a.timer': 'active', 'b.timer': 'inactive' },
      final_triggers: null,
      rollback: null,
      reason: 'r',
    });
  });
  test('an empty run_dir is reported as null', () => {
    const f = fixture({ runDir: '' });
    expect(rec(f).document('x')['run_dir']).toBeNull();
  });
  test('writeRecord stamps written_at and module_digests into deploy.json', async () => {
    const f = fixture({ moduleDigests: { m: 'd' } });
    await rec(f).writeRecord('completed', { released: true });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.name).toBe('deploy.json');
    expect(f.writes[0]!.value).toMatchObject({
      outcome: 'completed',
      released: true,
      written_at: 'NOW',
      module_digests: { m: 'd' },
    });
  });
  test('phase writes phase.json', async () => {
    const f = fixture();
    await rec(f).phase('p', { x: 1 });
    expect(f.writes[0]).toEqual({
      name: 'phase.json',
      value: { operation: 'deploy', phase: 'p', at: 'NOW', target: TARGET, prior_sha: PRIOR, x: 1 },
    });
  });
});

describe('failStop', () => {
  test('stops sorted triggers, persists the receipt and throws RecoveryRequired', async () => {
    const f = fixture();
    const err = await caught(rec(f).failStop('r'.repeat(500)));
    expect(err).toBeInstanceOf(RecoveryRequired);
    expect(err.message).toBe('r'.repeat(500));
    expect((err as RecoveryRequired).record).toMatchObject({
      outcome: 'recovery_required',
      reason: 'r'.repeat(400),
      written_at: 'NOW',
    });
    expect(f.log.filter((l) => l.startsWith('stop:'))).toEqual(['stop:a.timer,b.timer']);
    expect(f.writes.map((w) => w.name)).toEqual(['deploy.json', 'phase.json']);
    expect(f.writes[1]!.value).toMatchObject({
      phase: 'recovery_required',
      triggers: { 'a.timer': 'active', 'b.timer': 'inactive' },
    });
  });
  test('does not stop triggers when the hold is not owned', async () => {
    const f = fixture();
    f.hold.owned = false;
    await caught(rec(f).failStop('r'));
    expect(f.log.some((l) => l.startsWith('stop:'))).toBe(false);
  });
  test('does not stop triggers without a hold', async () => {
    const f = fixture({ hold: null });
    await caught(rec(f).failStop('r'));
    expect(f.log.some((l) => l.startsWith('stop:'))).toBe(false);
  });
  test('a failed trigger stop is narrated and ignored', async () => {
    const f = fixture();
    f.fail.stop = new Error('nope');
    const err = await caught(rec(f).failStop('r'));
    expect(err).toBeInstanceOf(RecoveryRequired);
    expect(f.log).toContain("narrate:fail-stop could not stop triggers: Error('nope')");
    expect(f.writes.map((w) => w.name)).toEqual(['deploy.json', 'phase.json']);
  });
  test('null triggers fail inside the guarded stop, as in Python', async () => {
    const f = fixture({ triggers: null });
    const err = await caught(rec(f).failStop('r'));
    expect(err).toBeInstanceOf(RecoveryRequired);
    expect(f.log.some((l) => l.startsWith('narrate:fail-stop could not stop'))).toBe(true);
  });
  test('writes nothing without a run_dir', async () => {
    const f = fixture({ runDir: null });
    const err = await caught(rec(f).failStop('r'));
    expect(err).toBeInstanceOf(RecoveryRequired);
    expect(f.writes).toEqual([]);
  });
  test('an OSError is surfaced in the message and record', async () => {
    const f = fixture();
    f.fail.write = new OSError('disk full');
    const err = (await caught(rec(f).failStop('why'))) as RecoveryRequired;
    expect(err).toBeInstanceOf(RecoveryRequired);
    expect(err.message).toBe(
      "why; the recovery record could not be persisted (OSError('disk full'))",
    );
    expect(err.record['persistence_error']).toBe("OSError('disk full')");
  });
  test('a non-OSError write failure propagates unchanged', async () => {
    const f = fixture();
    f.fail.write = new TypeError('bug');
    expect(await caught(rec(f).failStop('why'))).toBe(f.fail.write);
  });
  test('stringifies a non-string reason', async () => {
    const f = fixture();
    expect((await caught(rec(f).failStop(3))).message).toBe('3');
  });
});

describe('restoreBeforeSwitch', () => {
  test('verifies, restarts the originally active triggers, releases and records refusal', async () => {
    const f = fixture();
    await rec(f).restoreBeforeSwitch('why');
    expect(f.log).toEqual([
      'digests',
      'runtime',
      'start:a.timer',
      'hold.release',
      'write:deploy.json',
      'write:phase.json',
    ]);
    expect(f.writes[0]!.value).toMatchObject({ outcome: 'refused', reason: 'why' });
    expect(f.writes[1]!.value).toMatchObject({ phase: 'refused', reason: 'why' });
  });
  test('returns without effects when the hold is not acquired or absent', async () => {
    const a = fixture();
    a.hold.acquired = false;
    await rec(a).restoreBeforeSwitch('why');
    expect(a.log).toEqual([]);
    const b = fixture({ hold: null });
    await rec(b).restoreBeforeSwitch('why');
    expect(b.log).toEqual([]);
  });
  test('does not release a hold it no longer owns', async () => {
    const f = fixture();
    f.hold.owned = false;
    await rec(f).restoreBeforeSwitch('why');
    expect(f.log).not.toContain('hold.release');
    expect(f.writes[0]!.value).toMatchObject({ outcome: 'refused' });
  });
  test('skips the restart when no original triggers were recorded', async () => {
    const f = fixture({ original: {} });
    await rec(f).restoreBeforeSwitch('why');
    expect(f.log.some((l) => l.startsWith('start:'))).toBe(false);
    expect(f.log).toContain('hold.release');
  });
  test('a changed config fail-stops with the hold retained', async () => {
    const f = fixture();
    f.cfg.live = enc('cfg-moved');
    const err = await caught(rec(f).restoreBeforeSwitch('why'));
    expect(err).toBeInstanceOf(RecoveryRequired);
    expect(err.message).toBe(
      "pre-switch restore failed after refusal (why): Refused('live config no longer matches the pre-switch measurement')",
    );
    expect(f.log).not.toContain('hold.release');
    expect(f.log.some((l) => l.startsWith('start:'))).toBe(false);
  });
  test('a config differing only in length fail-stops', async () => {
    const f = fixture();
    f.cfg.live = enc('cfg-orig-extra');
    expect(await caught(rec(f).restoreBeforeSwitch('why'))).toBeInstanceOf(RecoveryRequired);
  });
  test('a missing original config measurement fail-stops', async () => {
    const f = fixture({ originalConfig: null });
    expect(await caught(rec(f).restoreBeforeSwitch('why'))).toBeInstanceOf(RecoveryRequired);
  });
  test('changed preserved digests fail-stop', async () => {
    const f = fixture();
    f.digests.seq = [{ queue: 'q2', hb: 'h1' }];
    const err = await caught(rec(f).restoreBeforeSwitch('why'));
    expect(err.message).toContain('preserved queue identity no longer matches');
    expect(f.log).not.toContain('hold.release');
  });
  test('a failed runtime pointer check fail-stops before any restart', async () => {
    const f = fixture();
    f.fail.runtime = new Refused('moved');
    const err = await caught(rec(f).restoreBeforeSwitch('why'));
    expect(err.message).toContain("Refused('moved')");
    expect(f.log.some((l) => l.startsWith('start:'))).toBe(false);
  });
  test('a restart mismatch fail-stops and keeps the hold', async () => {
    const f = fixture();
    f.deps.units.start = () => Promise.resolve();
    f.unitStates['a.timer'] = 'inactive';
    const err = await caught(rec(f).restoreBeforeSwitch('why'));
    expect(err.message).toContain('pre-switch restore mismatch: observed');
    expect(f.log).not.toContain('hold.release');
  });
  test('an unrecordable refusal fail-stops after the host was restored', async () => {
    const f = fixture();
    f.fail.write = new OSError('ro');
    const err = await caught(rec(f).restoreBeforeSwitch('why'));
    expect(err).toBeInstanceOf(RecoveryRequired);
    expect(err.message).toContain(
      "the refused record could not be persisted (OSError('ro')) after: why",
    );
    expect(f.log).toContain('hold.release');
  });
  test('a non-OSError record failure propagates', async () => {
    const f = fixture();
    f.fail.write = new TypeError('bug');
    expect(await caught(rec(f).restoreBeforeSwitch('why'))).toBe(f.fail.write);
  });
  test('writes no record without a run_dir', async () => {
    const f = fixture({ runDir: null });
    await rec(f).restoreBeforeSwitch('why');
    expect(f.writes).toEqual([]);
    expect(f.log).toContain('hold.release');
  });
  test('an interrupt passes through without a fail-stop', async () => {
    const f = fixture();
    f.fail.runtime = new Interrupted('^C');
    expect(await caught(rec(f).restoreBeforeSwitch('why'))).toBe(f.fail.runtime);
    expect(f.writes).toEqual([]);
  });
});

describe('rollbackToPrior', () => {
  function switched(over: Partial<RunState> = {}): Fx {
    const f = fixture({ switched: true, switchAttempted: true, ...over });
    f.head.v = TARGET;
    f.cfg.live = enc('cfg-new');
    for (const u of Object.keys(f.unitStates)) f.unitStates[u] = 'active';
    return f;
  }
  test('runs the full rollback in order and records it', async () => {
    const f = switched();
    await rec(f).rollbackToPrior('boom');
    expect(f.log).toEqual([
      `compat:fx:${PRIOR}`,
      `compat:fx:${PRIOR}`,
      `narrate:rolling back to ${'a'.repeat(12)}: boom`,
      'stop:a.timer,b.timer',
      'drainServices',
      'drainQueue:rollback-drain.json',
      `compat:fx:${PRIOR}`,
      `switch:${PRIOR}`,
      'digests',
      'runtime',
      'start:a.timer',
      'hold.release',
      'write:deploy.json',
      'write:phase.json',
      `narrate:rolled back to ${'a'.repeat(12)}; triggers restored`,
    ]);
  });
  test('measures compatibility twice before touching units, then once after the drain', async () => {
    const f = switched();
    await rec(f).rollbackToPrior('boom');
    expect(f.compat.calls).toBe(3);
  });
  test('records the rollback evidence and state', async () => {
    const f = switched();
    await rec(f).rollbackToPrior('r'.repeat(500));
    expect(f.state.switched).toBe(false);
    expect(f.state.released).toBe(true);
    expect(f.state.finalTriggers).toEqual({ 'a.timer': 'active', 'b.timer': 'inactive' });
    expect(f.state.rollback).toEqual({
      permitted: true,
      to: PRIOR,
      reason: 'r'.repeat(400),
      cq_bin: { pointer: 'x' },
      restored_config_sha256: createHash('sha256').update('cfg-orig').digest('hex'),
    });
    expect(f.writes[0]!.value).toMatchObject({
      outcome: 'rolled_back',
      released: true,
      reason: 'r'.repeat(400),
    });
    expect(f.writes[1]!.value).toMatchObject({
      phase: 'rolled_back',
      triggers: { 'a.timer': 'active', 'b.timer': 'inactive' },
    });
  });
  test('uses the post-health compatibility record instead of re-measuring first', async () => {
    const f = switched({ postCompatibility: CLEAN });
    await rec(f).rollbackToPrior('boom');
    expect(f.compat.calls).toBe(2);
  });
  test('a bad cached compatibility record disables rollback without a re-measure', async () => {
    const f = switched({ postCompatibility: { checked: true, schema_marker_present: true } });
    const err = await caught(rec(f).rollbackToPrior('boom'));
    expect(err).toBeInstanceOf(RecoveryRequired);
    expect(err.message).toBe(
      'automatic rollback is disabled: the queue carries an explicit schema marker (None) the prior target was never proven to read; the hold is retained and the owner must recover (after: boom)',
    );
    expect(f.compat.calls).toBe(0);
    expect(f.log.some((l) => l.startsWith('switch:'))).toBe(false);
  });
  test('an unchecked cached record is not accepted', async () => {
    const f = switched({ postCompatibility: { checked: false } });
    const err = await caught(rec(f).rollbackToPrior('boom'));
    expect(err.message).toContain('the compatibility record was not checked');
  });
  test('the fresh measurement can disable rollback', async () => {
    const f = switched();
    f.compat.records = [
      CLEAN,
      { checked: true, schema_marker_present: false, schema_observations: ['author_x'] },
    ];
    f.compat.records[1]!['schema_marker_present'] = true;
    const err = await caught(rec(f).rollbackToPrior('boom'));
    expect(err.message).toContain("disabled by the queue's current shape");
    expect(err.message.endsWith('; the hold is retained (after: boom)')).toBe(true);
    expect(f.log.some((l) => l.startsWith('stop:a.timer,b.timer'))).toBe(true); // failStop stops triggers
    expect(f.log.some((l) => l.startsWith('switch:'))).toBe(false);
  });
  test('a queue shape changed by the rollback drain disables the switch', async () => {
    const f = switched();
    f.compat.records = [CLEAN, CLEAN, { checked: true, schema_marker_present: true }];
    const err = await caught(rec(f).rollbackToPrior('boom'));
    expect(err.message).toContain('disabled after the rollback drain');
    expect(f.log).toContain('drainQueue:rollback-drain.json');
    expect(f.log.some((l) => l.startsWith('switch:'))).toBe(false);
  });
  test('reacquires a released hold and fail-stops when it cannot', async () => {
    const f = switched({ released: true });
    f.hold.acquired = false;
    f.deps.newHold = () => new FakeHold(false, f.log, new Refused('marker taken'));
    const err = await caught(rec(f).rollbackToPrior('boom'));
    expect(err).toBeInstanceOf(RecoveryRequired);
    expect(err.message).toBe(
      'cannot reacquire admission for rollback: marker taken; the failed target is still installed and its triggers may be running (after: boom)',
    );
    expect(f.log.some((l) => l.startsWith('switch:'))).toBe(false);
  });
  test('a non-Refused reacquire error propagates', async () => {
    const f = switched({ released: true });
    f.hold.acquired = false;
    const boom = new TypeError('io');
    f.deps.newHold = () => new FakeHold(false, f.log, boom);
    expect(await caught(rec(f).rollbackToPrior('boom'))).toBe(boom);
  });
  test('reacquires admission when the hold was released, then rolls back', async () => {
    const f = switched({ released: true, hold: null });
    f.digests.seq = [{ queue: 'q-advanced', hb: 'h1' }];
    f.state.preserved = { queue: 'q1', hb: 'h1' };
    await rec(f).rollbackToPrior('boom');
    expect(f.log[0]).toBe('hold.acquire');
    expect(f.state.hold).toBe(f.hold);
    // released=true: baseline is re-measured (digests called for baseline and after)
    expect(f.digests.calls).toBe(2);
  });
  test('a lost hold refuses before any effect', async () => {
    const f = switched();
    f.hold.owned = false;
    const err = await caught(rec(f).rollbackToPrior('boom'));
    expect(err).toBeInstanceOf(Refused);
    expect(err.message).toBe('hold lost before rollback');
    expect(f.log).toEqual([]);
  });
  test('a trigger stop that does not settle refuses', async () => {
    const f = switched();
    f.deps.units.stop = () => Promise.resolve();
    const err = await caught(rec(f).rollbackToPrior('boom'));
    expect(err.message).toBe(
      'rollback trigger stop did not settle: {"a.timer": "active", "b.timer": "active"}',
    );
    expect(f.log).not.toContain('drainServices');
  });
  test('failed counts as a dead state', async () => {
    const f = switched({ original: { 'a.timer': 'active', 'b.timer': 'failed' } });
    f.deps.units.stop = () => {
      f.unitStates['a.timer'] = 'inactive';
      f.unitStates['b.timer'] = 'failed';
      return Promise.resolve();
    };
    await rec(f).rollbackToPrior('boom');
    expect(f.state.finalTriggers).toEqual({ 'a.timer': 'active', 'b.timer': 'failed' });
  });
  test('activating is not a dead state', async () => {
    const g = switched();
    g.deps.units.stop = () => {
      g.unitStates['a.timer'] = 'inactive';
      g.unitStates['b.timer'] = 'activating';
      return Promise.resolve();
    };
    expect((await caught(rec(g).rollbackToPrior('boom'))).message).toContain('did not settle');
  });
  test('a HEAD that is not the prior SHA after the switch refuses', async () => {
    const f = switched();
    f.deps.switchCheckout = () => Promise.resolve();
    const err = await caught(rec(f).rollbackToPrior('boom'));
    expect(err.message).toBe('helper returned but HEAD is not the prior SHA');
    expect(f.state.switched).toBe(false);
  });
  test('config bytes that differ after the switch refuse', async () => {
    const f = switched();
    f.deps.switchCheckout = () => {
      f.head.v = PRIOR;
      return Promise.resolve();
    };
    const err = await caught(rec(f).rollbackToPrior('boom'));
    expect(err.message).toContain('rolled-back config bytes differ');
  });
  test('shared queue state that moved during rollback refuses, naming sorted keys', async () => {
    const f = switched();
    f.digests.seq = [{ queue: 'q1', hb: 'h1', z: 'z', a: 'a' }];
    f.state.preserved = { queue: 'q1', hb: 'h1', z: 'z', a: 'a' };
    // after the switch the digests differ for z and a, not queue
    f.deps.controller.preservedDigests = () =>
      Promise.resolve({ queue: 'q1', hb: 'h1', z: 'Z', a: 'A' });
    const err = await caught(rec(f).rollbackToPrior('boom'));
    expect(err.message).toBe('shared queue state changed during rollback: a, z');
    expect(f.log.some((l) => l.startsWith('start:'))).toBe(false);
  });
  test('a baseline key missing after the switch counts as changed', async () => {
    const f = switched();
    f.deps.controller.preservedDigests = () => Promise.resolve({ hb: 'h1' });
    const err = await caught(rec(f).rollbackToPrior('boom'));
    expect(err.message).toBe('shared queue state changed during rollback: queue');
  });
  test('a failed runtime pointer check refuses before any restart', async () => {
    const f = switched();
    f.fail.runtime = new Refused('entry replaced');
    const err = await caught(rec(f).rollbackToPrior('boom'));
    expect(err.message).toBe('entry replaced');
    expect(f.log.some((l) => l.startsWith('start:'))).toBe(false);
  });
  test('a restart mismatch refuses and records nothing', async () => {
    const f = switched();
    f.deps.units.start = () => Promise.resolve();
    f.unitStates['a.timer'] = 'inactive';
    const err = await caught(rec(f).rollbackToPrior('boom'));
    expect(err.message).toContain('rollback trigger restart mismatch: observed');
    expect(err.message).toContain('expected {"a.timer": "active", "b.timer": "inactive"}');
    expect(f.writes).toEqual([]);
  });
  test('does not mark released when the hold is no longer acquired at the end', async () => {
    const f = switched();
    const release = f.hold.release.bind(f.hold);
    f.deps.units.start = (u) => {
      f.unitStates['a.timer'] = 'active';
      f.hold.acquired = false;
      void u;
      return Promise.resolve();
    };
    void release;
    await rec(f).rollbackToPrior('boom');
    expect(f.state.released).toBe(false);
    expect(f.log).not.toContain('hold.release');
    expect(f.writes[0]!.value).toMatchObject({ released: true });
  });
});

describe('recover', () => {
  test('rethrows RecoveryRequired untouched', async () => {
    const f = fixture();
    const e = new RecoveryRequired('x');
    expect(await caught(rec(f).recover(e))).toBe(e);
    expect(f.log).toEqual([]);
  });
  test('a FailStop before the switch keeps the hold and fail-stops', async () => {
    const f = fixture();
    const err = await caught(rec(f).recover(new FailStop('drain expired')));
    expect(err).toBeInstanceOf(RecoveryRequired);
    expect(err.message).toBe('drain expired');
    expect(f.log).not.toContain('hold.release');
    expect(f.log.some((l) => l.startsWith('start:'))).toBe(false);
  });
  test('a FailStop after the switch rolls back instead', async () => {
    const f = fixture({ switched: true });
    f.head.v = TARGET;
    f.cfg.live = enc('cfg-new');
    expect(await rec(f).recover(new FailStop('late'))).toBe('rolled_back');
  });
  test('uses the exception name when the message is empty', async () => {
    const f = fixture();
    const err = await caught(rec(f).recover(new FailStop('')));
    expect(err.message).toBe('FailStop');
  });
  test('a switched run rolls back', async () => {
    const f = fixture({ switched: true });
    f.head.v = TARGET;
    f.cfg.live = enc('cfg-new');
    expect(await rec(f).recover(new Refused('verify failed'))).toBe('rolled_back');
    expect(f.writes[0]!.value).toMatchObject({ outcome: 'rolled_back', reason: 'verify failed' });
  });
  test('a rollback failure becomes an automatic-rollback fail-stop', async () => {
    const f = fixture({ switched: true });
    f.fail.switch = new Error('helper died');
    const err = await caught(rec(f).recover(new Refused('x'.repeat(300))));
    expect(err).toBeInstanceOf(RecoveryRequired);
    expect(err.message).toBe(
      `automatic rollback failed (Error('helper died')) after: ${'x'.repeat(200)}`,
    );
  });
  test('a RecoveryRequired from the rollback propagates unwrapped', async () => {
    const f = fixture({ switched: true, postCompatibility: { checked: false } });
    const err = await caught(rec(f).recover(new Refused('x')));
    expect(err.message).toContain('automatic rollback is disabled');
    expect(err.message).not.toContain('automatic rollback failed');
  });
  test('an interrupt during rollback is not turned into a fail-stop', async () => {
    const f = fixture({ switched: true });
    f.fail.switch = new Interrupted('^C');
    expect(await caught(rec(f).recover(new Refused('x')))).toBe(f.fail.switch);
  });
  test('a switch that landed on the target rolls back', async () => {
    const f = fixture({ switchAttempted: true });
    f.head.v = TARGET;
    f.cfg.live = enc('cfg-new');
    expect(await rec(f).recover(new Refused('half'))).toBe('rolled_back');
    expect(f.log).toContain(`switch:${PRIOR}`);
  });
  test('a switch rollback failure there also becomes a fail-stop', async () => {
    const f = fixture({ switchAttempted: true });
    f.head.v = TARGET;
    f.fail.switch = new Error('x');
    const err = await caught(rec(f).recover(new Refused('half')));
    expect(err.message).toContain('automatic rollback failed');
  });
  test('a switch that landed elsewhere fail-stops', async () => {
    const f = fixture({ switchAttempted: true });
    f.head.v = 'c'.repeat(40);
    const err = await caught(rec(f).recover(new Refused('half')));
    expect(err.message).toBe(
      `switch failed and HEAD is neither the prior nor the target SHA (${'c'.repeat(40)}): half`,
    );
  });
  test('a switch that never moved HEAD restores before the switch', async () => {
    const f = fixture({ switchAttempted: true });
    expect(await rec(f).recover(new Refused('early'))).toBe('refused');
    expect(f.writes[0]!.value).toMatchObject({ outcome: 'refused', reason: 'early' });
    expect(f.log.some((l) => l.startsWith('switch:'))).toBe(false);
  });
  test('without a switch attempt HEAD is not consulted and the run is refused', async () => {
    const f = fixture();
    let heads = 0;
    f.deps.headSha = () => {
      heads++;
      return Promise.resolve(PRIOR);
    };
    expect(await rec(f).recover(new Refused('early'))).toBe('refused');
    expect(heads).toBe(0);
  });
  test('stringifies a non-Error failure', async () => {
    const f = fixture();
    expect(await rec(f).recover('plain')).toBe('refused');
    expect(f.writes[0]!.value).toMatchObject({ reason: 'plain' });
  });
});

describe('run', () => {
  test('returns the inner result and always releases the lock', async () => {
    const f = fixture();
    f.inner.run = () => Promise.resolve({ outcome: 'completed' });
    expect(await rec(f).run()).toEqual({ outcome: 'completed' });
    expect(f.log).toEqual(['lock.release']);
  });
  test('a health failure rolls back and returns the rolled_back document', async () => {
    const f = fixture({ switched: true });
    f.head.v = TARGET;
    f.cfg.live = enc('cfg-new');
    f.inner.run = () => Promise.reject(new HealthFailed('h'.repeat(500)));
    const doc = await rec(f).run();
    expect(doc).toMatchObject({
      outcome: 'rolled_back',
      reason: 'h'.repeat(400),
      released: true,
      target: TARGET,
    });
    expect(f.log.at(-1)).toBe('lock.release');
  });
  test('a health failure with nothing switched still reports rolled_back, as Python does', async () => {
    const f = fixture();
    f.inner.run = () => Promise.reject(new HealthFailed('h'));
    expect(await rec(f).run()).toMatchObject({ outcome: 'rolled_back', reason: 'h' });
  });
  test('a refusal before the switch is restored and re-raised as Refused', async () => {
    const f = fixture();
    const original = new Refused('preflight');
    f.inner.run = () => Promise.reject(original);
    const err = await caught(rec(f).run());
    expect(err).toBeInstanceOf(Refused);
    expect(err).not.toBe(original);
    expect(err.message).toBe('preflight');
    expect(err.cause).toBe(original);
    expect(f.writes[0]!.value).toMatchObject({ outcome: 'refused' });
    expect(f.log.at(-1)).toBe('lock.release');
  });
  test('a refusal after the switch rolls back and returns the document', async () => {
    const f = fixture({ switched: true });
    f.head.v = TARGET;
    f.cfg.live = enc('cfg-new');
    f.inner.run = () => Promise.reject(new Refused('verify'));
    expect(await rec(f).run()).toMatchObject({ outcome: 'rolled_back', reason: 'verify' });
  });
  test('an unexpected error is recovered before being reported', async () => {
    const f = fixture();
    f.inner.run = () => Promise.reject(new TypeError('bug'));
    const err = await caught(rec(f).run());
    expect(err).toBeInstanceOf(Refused);
    expect(err.message).toBe('bug');
    expect(f.writes[0]!.value).toMatchObject({ outcome: 'refused' });
  });
  test('an unexpected error after the switch rolls back', async () => {
    const f = fixture({ switched: true });
    f.head.v = TARGET;
    f.cfg.live = enc('cfg-new');
    f.inner.run = () => Promise.reject(new TypeError('bug'));
    expect(await rec(f).run()).toMatchObject({ outcome: 'rolled_back', reason: 'bug' });
  });
  test('RecoveryRequired from the inner run is re-raised as is and releases the lock', async () => {
    const f = fixture();
    const e = new RecoveryRequired('stuck');
    f.inner.run = () => Promise.reject(e);
    expect(await caught(rec(f).run())).toBe(e);
    expect(f.log).toEqual(['lock.release']);
  });
  test('a FailStop from the inner run keeps the hold and raises RecoveryRequired', async () => {
    const f = fixture();
    f.inner.run = () => Promise.reject(new FailStop('drain expired'));
    const err = await caught(rec(f).run());
    expect(err).toBeInstanceOf(RecoveryRequired);
    expect(f.log).not.toContain('hold.release');
    expect(f.log.at(-1)).toBe('lock.release');
  });
  test('an interrupt recovers then re-raises the interrupt', async () => {
    const f = fixture({ switched: true });
    f.head.v = TARGET;
    f.cfg.live = enc('cfg-new');
    const e = new Interrupted('^C');
    f.inner.run = () => Promise.reject(e);
    expect(await caught(rec(f).run())).toBe(e);
    expect(f.writes[0]!.value).toMatchObject({
      outcome: 'rolled_back',
      reason: 'interrupted by the operator',
    });
    expect(f.log.at(-1)).toBe('lock.release');
  });
  test('an interrupt before the switch restores and re-raises', async () => {
    const f = fixture();
    const e = new Interrupted('^C');
    f.inner.run = () => Promise.reject(e);
    expect(await caught(rec(f).run())).toBe(e);
    expect(f.writes[0]!.value).toMatchObject({ outcome: 'refused' });
  });
});

describe('reason clipping', () => {
  const long = 'x'.repeat(300);
  const tail = `(after: ${'x'.repeat(200)})`;
  test('rollback refusals clip the triggering reason to 200 code points', async () => {
    const a = fixture({ postCompatibility: { checked: false } });
    expect((await caught(rec(a).rollbackToPrior(long))).message.endsWith(tail)).toBe(true);
    const b = fixture();
    b.compat.records = [CLEAN, { checked: true, schema_marker_present: true }];
    expect((await caught(rec(b).rollbackToPrior(long))).message.endsWith(tail)).toBe(true);
    const c = fixture();
    c.compat.records = [CLEAN, CLEAN, { checked: true, schema_marker_present: true }];
    expect((await caught(rec(c).rollbackToPrior(long))).message.endsWith(tail)).toBe(true);
    const d = fixture({ hold: null });
    d.deps.newHold = () => new FakeHold(false, d.log, new Refused('taken'));
    expect((await caught(rec(d).rollbackToPrior(long))).message.endsWith(tail)).toBe(true);
  });
  test('restore failures clip the reason and the OSError repr', async () => {
    const a = fixture();
    a.cfg.live = enc('moved');
    expect(
      (await caught(rec(a).restoreBeforeSwitch(long))).message.startsWith(
        `pre-switch restore failed after refusal (${'x'.repeat(200)}):`,
      ),
    ).toBe(true);
    const b = fixture();
    b.fail.write = new OSError('e'.repeat(300));
    const msg = (await caught(rec(b).restoreBeforeSwitch(long))).message;
    // The fail-stop's own write also fails, so its persistence suffix follows the reason.
    expect(
      msg.startsWith(
        `the refused record could not be persisted (${`OSError('${'e'.repeat(300)}')`.slice(0, 200)}) after: ${'x'.repeat(200)}; the recovery`,
      ),
    ).toBe(true);
  });
  test('failStop clips the persistence error to 400 and its message copy to 200', async () => {
    const f = fixture();
    f.fail.write = new OSError('e'.repeat(600));
    const err = (await caught(rec(f).failStop('r'))) as RecoveryRequired;
    expect(String(err.record['persistence_error'])).toHaveLength(400);
    expect(err.message).toBe(
      `r; the recovery record could not be persisted (${`OSError('${'e'.repeat(600)}')`.slice(0, 200)})`,
    );
  });
  test('triggers are started in sorted order', async () => {
    const f = fixture({
      original: { 'b.timer': 'active', 'a.timer': 'active' },
      triggers: ['b.timer', 'a.timer'],
    });
    await rec(f).restoreBeforeSwitch('why');
    expect(f.log).toContain('start:a.timer,b.timer');
  });
});
