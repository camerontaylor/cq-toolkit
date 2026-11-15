import { describe, expect, it } from 'vitest';
import { admitAvailable } from '../../src/queue-runner/admitAvailable.js';
import type { AdmissionDecision } from '../../src/policy/crq/tickAdmission.js';

function decision(over: Partial<AdmissionDecision> = {}): AdmissionDecision {
  return { slots: 3, admissions: 3, gate: null, inflight: 0, startsLastHour: 0, log: [], ...over };
}

/** A live queue model: each script entry is the number of starts one call journals. */
function world(script: number[], opts: { hasCoverage?: boolean[]; inflightBase?: number } = {}) {
  const state = { starts: 10, inflight: opts.inflightBase ?? 0, calls: 0 };
  return {
    state,
    effects: {
      startsCount: () => state.starts,
      inflightCount: () => state.inflight,
      startOne: async () => {
        const spend = script[state.calls] ?? 0;
        const coverage = opts.hasCoverage?.[state.calls] ?? false;
        state.calls += 1;
        state.starts += spend;
        state.inflight += spend;
        return { hasCoverage: coverage };
      },
    },
  };
}

describe('admitAvailable', () => {
  it('never calls startOne behind a closed gate and reports the gate line', async () => {
    const w = world([1]);
    const result = await admitAvailable(
      {
        decision: decision({ gate: 'paused', admissions: 0, slots: 0, log: ['queue paused: x'] }),
        maxInflight: 10,
        dry: false,
      },
      w.effects,
    );
    expect(w.state.calls).toBe(0);
    expect(result).toMatchObject({
      gate: 'paused',
      spent: 0,
      remaining: 0,
      log: ['queue paused: x'],
    });
  });

  it('loops until journaled starts reach the admission budget', async () => {
    const w = world([1, 1, 1, 1]);
    const result = await admitAvailable(
      { decision: decision(), maxInflight: 10, dry: false },
      w.effects,
    );
    expect(w.state.calls).toBe(3);
    expect(result).toMatchObject({ spent: 3, remaining: 0 });
  });

  it('counts real journal growth: one call that reserves two spends two slots', async () => {
    const w = world([2, 1]);
    const result = await admitAvailable(
      { decision: decision({ slots: 5, admissions: 3 }), maxInflight: 10, dry: false },
      w.effects,
    );
    expect(w.state.calls).toBe(2);
    expect(result).toMatchObject({ spent: 3, remaining: 2 });
  });

  it('stops on a call that reserves nothing, keeping remaining slots', async () => {
    const w = world([1, 0, 1]);
    const result = await admitAvailable(
      { decision: decision(), maxInflight: 10, dry: false },
      w.effects,
    );
    expect(w.state.calls).toBe(2);
    expect(result).toMatchObject({ spent: 1, remaining: 2 });
  });

  it('runs exactly once for a dry run or a selective start', async () => {
    const dry = world([1, 1]);
    await admitAvailable({ decision: decision(), maxInflight: 10, dry: true }, dry.effects);
    expect(dry.state.calls).toBe(1);
    const only = world([1, 1]);
    await admitAvailable(
      { decision: decision(), maxInflight: 10, dry: false, only: 'pr-1' },
      only.effects,
    );
    expect(only.state.calls).toBe(1);
    const emptyOnly = world([1, 1, 1]);
    await admitAvailable(
      { decision: decision(), maxInflight: 10, dry: false, only: '' },
      emptyOnly.effects,
    );
    expect(emptyOnly.state.calls).toBe(3);
  });

  it('stops at the in-flight cap even with budget left, before and after a start', async () => {
    const atCap = world([1], { inflightBase: 10 });
    expect(
      (await admitAvailable({ decision: decision(), maxInflight: 10, dry: false }, atCap.effects))
        .spent,
    ).toBe(0);
    expect(atCap.state.calls).toBe(0);
    const reaches = world([1, 1, 1], { inflightBase: 8 });
    const result = await admitAvailable(
      { decision: decision(), maxInflight: 10, dry: false },
      reaches.effects,
    );
    expect(reaches.state.calls).toBe(2);
    expect(result.spent).toBe(2);
  });

  it('ORs coverage across calls and clamps remaining at zero', async () => {
    const w = world([1, 1], { hasCoverage: [false, true] });
    const result = await admitAvailable(
      { decision: decision({ slots: 1, admissions: 2 }), maxInflight: 10, dry: false },
      w.effects,
    );
    expect(result).toMatchObject({ hasCoverage: true, spent: 2, remaining: 0 });
  });

  it('fails closed if the journal shrinks instead of spinning', async () => {
    const state = { starts: 5 };
    await expect(
      admitAvailable(
        { decision: decision(), maxInflight: 10, dry: false },
        {
          startsCount: () => state.starts,
          inflightCount: () => 0,
          startOne: async () => {
            state.starts -= 1;
            return { hasCoverage: false };
          },
        },
      ),
    ).rejects.toThrow('shrank');
  });
});
