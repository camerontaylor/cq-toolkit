import { describe, expect, test } from 'vitest';
import {
  RUNNER_DISABLED,
  admit,
  gatedJudge,
  runDrainPass,
  runItemJobs,
  type DrainPassEffects,
} from '../../../src/ops/crq/internal/repairPassGates.js';

function drain(disabled: boolean[], items = ['a', 'b']) {
  const calls: string[] = [];
  const said: string[] = [];
  let reads = 0;
  const effects: DrainPassEffects = {
    runnerDisabled: async () => disabled[Math.min(reads++, disabled.length - 1)]!,
    narrate: (m) => void said.push(m),
    fetchClone: async () => (calls.push('fetch'), null),
    triage: async () => void calls.push('triage'),
    items: async () => items,
    halted: async () => false,
    drainItem: async (i) => (calls.push('item:' + i), null),
  };
  return { effects, calls, said };
}
describe('pass-level runner-disabled gates', () => {
  test('a disabled runner refuses the pass before any fetch, triage or item', async () => {
    const d = drain([true]);
    expect(await runDrainPass(d.effects)).toEqual({
      status: 'refused',
      stage: 'pass-start',
      admitted: [],
    });
    expect(d.calls).toEqual([]);
    expect(d.said).toEqual([`${RUNNER_DISABLED}: pass not started`]);
  });
  test('an enabled runner proceeds through fetch, triage and every item', async () => {
    const d = drain([false]);
    expect(await runDrainPass(d.effects)).toEqual({ status: 'done', admitted: ['a', 'b'] });
    expect(d.calls).toEqual(['fetch', 'triage', 'item:a', 'item:b']);
    expect(d.said).toEqual([]);
  });
  test('a marker written during the fetch stops the pass before triage', async () => {
    const d = drain([false, true]);
    expect(await runDrainPass(d.effects)).toMatchObject({
      status: 'refused',
      stage: 'before-triage',
    });
    expect(d.calls).toEqual(['fetch']);
  });
  test('a marker written while an item runs stops the next item, never the running one', async () => {
    const d = drain([false, false, false, true]);
    expect(await runDrainPass(d.effects)).toEqual({
      status: 'refused',
      stage: 'before-item',
      admitted: ['a'],
    });
    expect(d.calls).toEqual(['fetch', 'triage', 'item:a']);
    expect(d.said).toEqual([`${RUNNER_DISABLED}: pass stopped before b`]);
  });
  test('an item outcome of runner-disabled ends the pass', async () => {
    const d = drain([false]);
    d.effects.drainItem = async (i) => (d.calls.push('item:' + i), 'runner-disabled');
    expect(await runDrainPass(d.effects)).toEqual({ status: 'done', admitted: ['a'] });
  });
  test('serial jobs: the in-flight job finishes and the next does not start', async () => {
    const ran: string[] = [];
    let reads = 0;
    const result = await runItemJobs([{ job: 'j1' }, { job: 'j2' }], {
      runnerDisabled: async () => reads++ > 0,
      narrate: () => undefined,
      runJob: async (j) => void ran.push(j.job),
    });
    expect(ran).toEqual(['j1']);
    expect(result).toEqual({ ran: ['j1'], outcome: 'runner-disabled' });
  });
  test('judges: disabled defers with no model call, enabled runs', async () => {
    let called = 0;
    const judge = async () => (called++, 'verdict');
    const off = { runnerDisabled: async () => true, narrate: () => undefined };
    expect(await gatedJudge('triage', off, judge)).toMatchObject({
      stop: 'deferred',
      errorClass: 'runner-disabled',
    });
    expect(await gatedJudge('recovery', off, judge)).toMatchObject({ stop: 'configuration' });
    expect(called).toBe(0);
    expect(await gatedJudge('triage', { ...off, runnerDisabled: async () => false }, judge)).toBe(
      'verdict',
    );
  });
  test('the CLI and recover-after-fetch stages narrate their own line', async () => {
    const said: string[] = [];
    const on = { runnerDisabled: async () => true, narrate: (m: string) => void said.push(m) };
    expect(await admit({ stage: 'cli-dispatch' }, on)).toBe(false);
    expect(await admit({ stage: 'recover-after-fetch', job: 'crq-1' }, on)).toBe(false);
    expect(said).toEqual([
      `${RUNNER_DISABLED}: dispatch refused`,
      `${RUNNER_DISABLED}: recovery deferred for crq-1`,
    ]);
  });
});
