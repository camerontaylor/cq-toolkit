import { describe, expect, test } from 'vitest';
import {
  HealthFailed,
  Interrupted,
  RecoveryRequired,
  Refused,
  newRunBodyState,
  runBody,
  runWithRecovery,
  type Health,
  type RunBodyArgs,
  type RunBodySteps,
  type RunHold,
} from '../../../../src/ops/crq/deploy/runBody.js';

const PRIOR = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);

interface Fixture {
  steps: RunBodySteps;
  log: string[];
  fail: Map<string, unknown>;
  heads: string[];
  states: Record<string, string>;
  health: { value: Health };
  hold: { owns: boolean };
  baseline: { compatible: boolean };
  outcome: { value: string };
  args: RunBodyArgs;
}

function fixture(): Fixture {
  const log: string[] = [];
  const fail = new Map<string, unknown>();
  const heads = [PRIOR, TARGET];
  const states: Record<string, string> = { 'crq-a.timer': 'active', 'crq-b.path': 'inactive' };
  const health = { value: { healthy: true } as Health };
  const holdState = { owns: true };
  const baseline = { compatible: true };
  const outcome = { value: 'rolled_back' };
  const step = async (name: string): Promise<void> => {
    log.push(name);
    if (fail.has(name)) throw fail.get(name);
  };
  const hold: RunHold = {
    acquire: async () => step('hold.acquire'),
    owns: async () => {
      log.push('hold.owns');
      return holdState.owns;
    },
    release: async () => step('hold.release'),
  };
  const steps: RunBodySteps = {
    lock: { acquire: () => step('lock.acquire'), release: () => step('lock.release') },
    headSha: async () => {
      await step('headSha');
      return heads.shift() ?? TARGET;
    },
    assertClean: () => step('assertClean'),
    resolveTarget: async () => {
      await step('resolveTarget');
      return TARGET;
    },
    claimRunDir: async () => {
      await step('claimRunDir');
      return '/run/1';
    },
    phase: async (name, extra) => step(`phase:${name}${extra ? ':' + JSON.stringify(extra) : ''}`),
    narrate: (m) => {
      log.push(`narrate:${m}`);
    },
    resolveModules: () => step('resolveModules'),
    loadOverlay: () => step('loadOverlay'),
    measureBaseline: async () => {
      await step('measureBaseline');
      return { compatible: baseline.compatible, reason: 'queue has author_x', cqBin: { p: 1 } };
    },
    inventoryTriggers: async () => {
      await step('inventory');
      return Object.keys(states);
    },
    unitState: async (u) => {
      await step(`unitState:${u}`);
      return states[u]!;
    },
    requireUnchangedUnitTemplates: () => step('templates'),
    persistRecoveryReceipt: () => step('receipt'),
    newHold: () => hold,
    stopTriggers: () => step('stopTriggers'),
    drainServices: () => step('drainServices'),
    drainQueue: () => step('drainQueue'),
    recheckBaseline: () => step('recheckBaseline'),
    switchCheckout: () => step('switch'),
    verifyAfterSwitch: () => step('verifyAfterSwitch'),
    restartTriggers: async () => {
      await step('restartTriggers');
      return { ...states };
    },
    checkHealth: async () => {
      await step('checkHealth');
      return health.value;
    },
    writeHealth: () => step('writeHealth'),
    complete: () => step('complete'),
    document: (o, reason) => ({ outcome: o, reason }),
    recover: async (exc) => {
      log.push(`recover:${exc instanceof Error ? exc.name + ':' + exc.message : String(exc)}`);
      if (fail.has('recover')) throw fail.get('recover');
      return outcome.value;
    },
  };
  return {
    steps,
    log,
    fail,
    heads,
    states,
    health,
    hold: holdState,
    baseline,
    outcome,
    args: { rootIsDir: true, overlayIsFile: true, tag: null },
  };
}

const HAPPY = [
  'lock.acquire',
  'headSha',
  'assertClean',
  'resolveTarget',
  'claimRunDir',
  'phase:resolved',
  'resolveModules',
  'loadOverlay',
  'measureBaseline',
  'inventory',
  'unitState:crq-a.timer',
  'unitState:crq-b.path',
  'phase:prepared:{"triggers":{"crq-a.timer":"active","crq-b.path":"inactive"},"cq_bin":{"p":1}}',
  'templates',
  'receipt',
  'hold.acquire',
  'phase:held',
  'narrate:hold acquired; stopping triggers',
  'hold.owns',
  'stopTriggers',
  'phase:stopped:{"triggers":{"crq-a.timer":"active","crq-b.path":"inactive"}}',
  'drainServices',
  'drainQueue',
  'recheckBaseline',
  'phase:drained',
  `narrate:switching to ${TARGET}`,
  'switch',
  'headSha',
  'phase:switched',
  'verifyAfterSwitch',
  'hold.owns',
  'hold.release',
  'phase:admission_released',
  'restartTriggers',
  'phase:restarted:{"triggers":{"crq-a.timer":"active","crq-b.path":"inactive"}}',
  'checkHealth',
  'writeHealth',
  'complete',
];

describe('runBody phase order', () => {
  test('happy path calls every phase once, in the Python order', async () => {
    const f = fixture();
    const state = newRunBodyState();
    expect(await runBody(f.args, f.steps, state)).toEqual({
      outcome: 'completed',
      reason: undefined,
    });
    expect(f.log).toEqual(HAPPY);
    expect(state).toMatchObject({
      priorSha: PRIOR,
      target: TARGET,
      runDir: '/run/1',
      switchAttempted: true,
      switched: true,
      released: true,
    });
    expect(state.finalTriggers).toEqual(f.states);
  });

  test('runBody alone never releases the lock; the wrapper does exactly once', async () => {
    const f = fixture();
    await runBody(f.args, f.steps, newRunBodyState());
    expect(f.log).not.toContain('lock.release');
    const g = fixture();
    await runWithRecovery(g.args, g.steps, newRunBodyState());
    expect(g.log.filter((l) => l === 'lock.release')).toEqual(['lock.release']);
    expect(g.log.at(-1)).toBe('lock.release');
  });
});

describe('preconditions refuse before any effect', () => {
  test.each([
    ['root', { rootIsDir: false }, '--root must name the deployment checkout'],
    ['overlay', { overlayIsFile: false }, '--overlay must name the private host overlay'],
  ])('%s', async (_n, patch, message) => {
    const f = fixture();
    await expect(runBody({ ...f.args, ...patch }, f.steps, newRunBodyState())).rejects.toThrow(
      message,
    );
    expect(f.log).toEqual([]);
  });

  test('a non-SHA live HEAD is refused with its repr, before assertClean', async () => {
    const f = fixture();
    f.heads[0] = "it's";
    await expect(runBody(f.args, f.steps, newRunBodyState())).rejects.toThrow(
      `live HEAD is not a full commit SHA: "it's"`,
    );
    expect(f.log).toEqual(['lock.acquire', 'headSha']);
  });

  test('uppercase or 41-char SHAs are not full SHAs', async () => {
    for (const bad of ['A'.repeat(40), 'a'.repeat(41), `${PRIOR}\n`]) {
      const f = fixture();
      f.heads[0] = bad;
      await expect(runBody(f.args, f.steps, newRunBodyState())).rejects.toBeInstanceOf(Refused);
    }
  });

  test('target equal to HEAD is refused before the run directory is claimed', async () => {
    const f = fixture();
    f.heads[0] = TARGET;
    await expect(runBody(f.args, f.steps, newRunBodyState())).rejects.toThrow(
      `target ${TARGET} is already the checked-out HEAD`,
    );
    expect(f.log).not.toContain('claimRunDir');
  });

  test.each([
    ['crq-runner/20261115-3', true],
    ['crq-runner/20261115-', false],
    ['crq-runner/2026111-3', false],
    ['crq-runner/20261115-3\n', false],
    ['xcrq-runner/20261115-3', false],
  ])('tag %j valid=%s', async (tag, valid) => {
    const f = fixture();
    const run = runBody({ ...f.args, tag }, f.steps, newRunBodyState());
    if (valid) await run;
    else await expect(run).rejects.toThrow('--tag must be crq-runner/YYYYMMDD-N');
    if (!valid) expect(f.log).not.toContain('claimRunDir');
  });

  test('an incompatible queue refuses with the reason and stops before inventory', async () => {
    const f = fixture();
    f.baseline.compatible = false;
    await expect(runBody(f.args, f.steps, newRunBodyState())).rejects.toThrow(
      'the live queue disables automatic rollback, so this deploy would have no fallback: queue has author_x. Drain or reconcile the queue with the owner first.',
    );
    expect(f.log).not.toContain('inventory');
  });

  test('an empty inventory is refused', async () => {
    const f = fixture();
    for (const k of Object.keys(f.states)) delete f.states[k];
    await expect(runBody(f.args, f.steps, newRunBodyState())).rejects.toThrow(
      'no installed crq-*.timer or crq-*.path units found; refusing to deploy against an empty inventory',
    );
  });

  test('unsettled trigger states are refused, listed sorted, and settled ones are accepted', async () => {
    const f = fixture();
    f.states['crq-b.path'] = 'activating';
    f.states['crq-a.timer'] = 'reloading';
    await expect(runBody(f.args, f.steps, newRunBodyState())).rejects.toThrow(
      'trigger state is unsettled; refusing to guess: {"crq-a.timer": "reloading", "crq-b.path": "activating"}',
    );
    expect(f.log).not.toContain('phase:prepared:{}');
    const g = fixture();
    g.states['crq-b.path'] = 'failed';
    await runBody(g.args, g.steps, newRunBodyState());
  });

  test('a lost hold stops before any trigger stop', async () => {
    const f = fixture();
    f.hold.owns = false;
    await expect(runBody(f.args, f.steps, newRunBodyState())).rejects.toThrow(
      'hold lost before trigger stop',
    );
    expect(f.log).not.toContain('stopTriggers');
  });

  test('HEAD that is not the target after the switch is refused after switched=true', async () => {
    const f = fixture();
    f.heads[1] = PRIOR;
    const state = newRunBodyState();
    await expect(runBody(f.args, f.steps, state)).rejects.toThrow(
      'helper returned but HEAD is not the target',
    );
    expect(state.switchAttempted && state.switched).toBe(true);
    expect(f.log).not.toContain('phase:switched');
  });

  test('a lost marker before the release is refused and leaves released false', async () => {
    const f = fixture();
    let calls = 0;
    f.steps.newHold = () => ({
      acquire: async () => {},
      owns: async () => ++calls === 1,
      release: async () => {
        f.log.push('hold.release');
      },
    });
    const state = newRunBodyState();
    await expect(runBody(f.args, f.steps, state)).rejects.toThrow(
      "cannot release admission: the marker is not this run's",
    );
    expect(state.released).toBe(false);
    expect(f.log).not.toContain('hold.release');
  });
});

describe('health outcome', () => {
  test.each([
    [{ healthy: false, reason: 'tick stalled' }, 'health check failed: tick stalled'],
    [{ healthy: false }, 'health check failed: not healthy'],
    [{ healthy: false, reason: '' }, 'health check failed: not healthy'],
    [{}, 'health check failed: not healthy'],
    [{ healthy: 0, reason: 'zero' }, 'health check failed: zero'],
  ])('%j', async (health, message) => {
    const f = fixture();
    f.health.value = health;
    await expect(runBody(f.args, f.steps, newRunBodyState())).rejects.toThrow(HealthFailed);
    const g = fixture();
    g.health.value = health;
    await expect(runBody(g.args, g.steps, newRunBodyState())).rejects.toThrow(message);
    expect(g.log).toContain('writeHealth');
    expect(g.log).not.toContain('complete');
  });

  test('a truthy non-boolean healthy value completes', async () => {
    const f = fixture();
    f.health.value = { healthy: 1 };
    expect(await runBody(f.args, f.steps, newRunBodyState())).toMatchObject({
      outcome: 'completed',
    });
  });
});

// Each step and the exception it throws; every row must reach recovery with
// the exact message and, when recovery rolls back, produce the rolled_back
// document. The lock is released in every row.
const STEP_NAMES = [
  'lock.acquire',
  'headSha',
  'assertClean',
  'resolveTarget',
  'claimRunDir',
  'phase:resolved',
  'resolveModules',
  'loadOverlay',
  'measureBaseline',
  'inventory',
  'unitState:crq-a.timer',
  'templates',
  'receipt',
  'hold.acquire',
  'phase:held',
  'stopTriggers',
  'phase:stopped:{"triggers":{"crq-a.timer":"active","crq-b.path":"inactive"}}',
  'drainServices',
  'drainQueue',
  'recheckBaseline',
  'phase:drained',
  'switch',
  'phase:switched',
  'verifyAfterSwitch',
  'hold.release',
  'phase:admission_released',
  'restartTriggers',
  'phase:restarted:{"triggers":{"crq-a.timer":"active","crq-b.path":"inactive"}}',
  'checkHealth',
  'writeHealth',
  'complete',
];

describe('per-phase throws table', () => {
  test('the table names every step the happy path performs', () => {
    for (const name of STEP_NAMES) expect(HAPPY).toContain(name);
  });

  test.each(STEP_NAMES)('%s throwing reaches recovery then releases the lock', async (name) => {
    const f = fixture();
    f.fail.set(name, new Error('boom'));
    const state = newRunBodyState();
    expect(await runWithRecovery(f.args, f.steps, state)).toEqual({
      outcome: 'rolled_back',
      reason: 'boom',
    });
    const at = f.log.indexOf(name);
    // Nothing past the throwing step ran, except recovery and the lock release.
    expect(f.log.slice(at + 1)).toEqual(['recover:Error:boom', 'lock.release']);
  });

  test.each(STEP_NAMES)(
    '%s throwing is a Refused when recovery does not roll back',
    async (name) => {
      const f = fixture();
      f.outcome.value = 'fail_stopped';
      const cause = new TypeError('bad');
      f.fail.set(name, cause);
      const error = await runWithRecovery(f.args, f.steps, newRunBodyState()).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Refused);
      expect((error as Refused).message).toBe('bad');
      expect((error as Refused).cause).toBe(cause);
      expect(f.log.slice(-2)).toEqual(['recover:TypeError:bad', 'lock.release']);
    },
  );

  test('state at recovery time reflects how far the run got', async () => {
    for (const [name, expected] of [
      ['hold.acquire', { attempted: false, switched: false, released: false }],
      ['switch', { attempted: true, switched: false, released: false }],
      ['verifyAfterSwitch', { attempted: true, switched: true, released: false }],
      ['restartTriggers', { attempted: true, switched: true, released: true }],
    ] as const) {
      const f = fixture();
      f.fail.set(name, new Error('x'));
      const state = newRunBodyState();
      let seen: unknown;
      const recover = f.steps.recover;
      f.steps.recover = async (exc) => {
        seen = {
          attempted: state.switchAttempted,
          switched: state.switched,
          released: state.released,
        };
        return recover(exc);
      };
      await runWithRecovery(f.args, f.steps, state);
      expect(seen).toEqual(expected);
    }
  });
});

describe('exception routing', () => {
  test('HealthFailed recovers then returns rolled_back regardless of the outcome', async () => {
    const f = fixture();
    f.health.value = { healthy: false, reason: 'r' };
    f.outcome.value = 'fail_stopped';
    expect(await runWithRecovery(f.args, f.steps, newRunBodyState())).toEqual({
      outcome: 'rolled_back',
      reason: 'health check failed: r',
    });
    expect(f.log.slice(-2)).toEqual([
      'recover:HealthFailed:health check failed: r',
      'lock.release',
    ]);
  });

  test('Refused with a non-rolled-back outcome is rethrown as Refused', async () => {
    const f = fixture();
    f.outcome.value = 'x';
    f.fail.set('assertClean', new Refused('dirty'));
    await expect(runWithRecovery(f.args, f.steps, newRunBodyState())).rejects.toThrow('dirty');
  });

  test('RecoveryRequired is routed like a Refused', async () => {
    const f = fixture();
    f.fail.set('drainQueue', new RecoveryRequired('stuck'));
    expect(await runWithRecovery(f.args, f.steps, newRunBodyState())).toEqual({
      outcome: 'rolled_back',
      reason: 'stuck',
    });
  });

  test('Interrupted recovers with a fresh Refused and re-throws the interrupt', async () => {
    const f = fixture();
    const interrupt = new Interrupted('^C');
    f.fail.set('checkHealth', interrupt);
    const error = await runWithRecovery(f.args, f.steps, newRunBodyState()).catch(
      (e: unknown) => e,
    );
    expect(error).toBe(interrupt);
    expect(f.log.slice(-2)).toEqual([
      'recover:Refused:interrupted by the operator',
      'lock.release',
    ]);
  });

  test('Interrupted discards the recovery outcome even when it rolled back', async () => {
    const f = fixture();
    f.fail.set('checkHealth', new Interrupted('^C'));
    f.outcome.value = 'rolled_back';
    await expect(runWithRecovery(f.args, f.steps, newRunBodyState())).rejects.toBeInstanceOf(
      Interrupted,
    );
  });

  test('the rolled_back reason is clipped to 400 code points', async () => {
    const f = fixture();
    f.fail.set('assertClean', new Error('é'.repeat(500) + '😀'));
    const doc = (await runWithRecovery(f.args, f.steps, newRunBodyState())) as {
      reason: string;
    };
    expect(Array.from(doc.reason)).toHaveLength(400);
    const g = fixture();
    g.health.value = { healthy: false, reason: 'r'.repeat(600) };
    const hd = (await runWithRecovery(g.args, g.steps, newRunBodyState())) as { reason: string };
    expect(Array.from(hd.reason)).toHaveLength(400);
  });

  test('a recovery that throws still releases the lock and surfaces its error', async () => {
    const f = fixture();
    f.fail.set('assertClean', new Error('first'));
    f.fail.set('recover', new RecoveryRequired('cannot recover'));
    await expect(runWithRecovery(f.args, f.steps, newRunBodyState())).rejects.toThrow(
      'cannot recover',
    );
    expect(f.log.at(-1)).toBe('lock.release');
  });

  test('a lock release failure on success surfaces after the body completes', async () => {
    const f = fixture();
    f.fail.set('lock.release', new Error('unlock'));
    await expect(runWithRecovery(f.args, f.steps, newRunBodyState())).rejects.toThrow('unlock');
    expect(f.log).toContain('complete');
  });

  test('success never calls recover', async () => {
    const f = fixture();
    expect(await runWithRecovery(f.args, f.steps, newRunBodyState())).toMatchObject({
      outcome: 'completed',
    });
    expect(f.log.some((l) => l.startsWith('recover'))).toBe(false);
  });
});
