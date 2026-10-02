// The served-model assertion (ADR-0002 §2.6) — unit policy matrix.
//
// Covers the m-ii wrapper matrix: the observed-mismatch verdict rewrite
// (spend facts kept, payload dropped), lane-scoped alias admission, the
// unobserved branches, the acp namespace normalisation, the exported
// servedModelCheck record (the frozen via vocabulary — there is no
// narration wire field), and the RunOptions forwarding contract (a
// fewer-parameter wrapper would compile and silently drop the signal).
import { describe, expect, test, vi } from 'vitest';
import {
  LANE_IDS,
  normaliseModelId,
  servedModelCheck,
  withServedModelAssertion,
} from '../../src/driver/served-model.js';
import type { ServedModelPolicy } from '../../src/driver/served-model.js';
import type { Driver, OpInvocation, RunOptions, WorkerResult } from '../../src/driver/types.js';

const invocation = (model = 'model-a', provider = 'test'): OpInvocation => ({
  prompt: 'served-model test',
  modelSpec: { provider, model },
  toolPolicy: { allow: [], mode: 'none' },
  sandboxPolicy: { level: 'none' },
  budget: {},
});

const complete = (model: string | undefined): WorkerResult => ({
  ...(model === undefined ? {} : { model }),
  structuredOutput: { ok: true },
  usage: { input: 11, output: 7, cacheRead: 2, cacheWrite: 1 },
  costUSD: 0.5,
  costBasis: 'modeled',
  sessionId: 'ses-x',
  denials: [{ tool: 'run', reason: 'not allowed' }],
  providerSignals: { windows: [{ id: '5h', utilization: 0.25 }] },
  stopReason: 'complete',
});

const driverReturning = (value: WorkerResult): Driver => ({
  run: async () => value,
});

const lanes = ['ai-sdk', 'claude-agent', 'subprocess', 'acp'] as const;

describe('served-model assertion — the m-ii matrix', () => {
  test('an observed mismatch becomes error/served-model-mismatch: payload dropped, spend kept', async () => {
    const raw = complete('model-b');
    const wrapped = withServedModelAssertion(driverReturning(raw), { lane: 'subprocess' });
    const verdict = await wrapped.run(invocation());
    expect(verdict.stopReason).toBe('error');
    expect(verdict.errorClass).toBe('served-model-mismatch');
    expect(verdict.error).toBe("requested 'model-a', served 'model-b'");
    expect(verdict).not.toHaveProperty('structuredOutput');
    // The spend was real: every spend/observability fact is kept, and the
    // RAW observation survives on the rewritten verdict.
    expect(verdict.model).toBe('model-b');
    expect(verdict.usage).toEqual({ input: 11, output: 7, cacheRead: 2, cacheWrite: 1 });
    expect(verdict.costUSD).toBe(0.5);
    expect(verdict.costBasis).toBe('modeled');
    expect(verdict.sessionId).toBe('ses-x');
    expect(verdict.denials).toEqual([{ tool: 'run', reason: 'not allowed' }]);
    expect(verdict.providerSignals).toEqual({ windows: [{ id: '5h', utilization: 0.25 }] });
    // The inner result object is never mutated.
    expect(raw.stopReason).toBe('complete');
    expect(raw.structuredOutput).toEqual({ ok: true });
  });

  test.each(lanes)('lane %s: an exact observed id passes through untouched', async (lane) => {
    const raw = complete(lane === 'acp' ? 'model-a' : 'model-a');
    const verdict = await withServedModelAssertion(driverReturning(raw), { lane }).run(
      invocation(),
    );
    expect(verdict.stopReason).toBe('complete');
    expect(verdict).toBe(raw);
  });

  test('a lane-scoped alias admits the declared pair on its lane only', async () => {
    const policy: ServedModelPolicy = {
      aliases: { subprocess: { test: { 'model-a': ['model-b'] } } },
    };
    const raw = complete('model-b');
    const passed = await withServedModelAssertion(driverReturning(raw), {
      lane: 'subprocess',
      policy,
    }).run(invocation());
    expect(passed.stopReason).toBe('complete');
    expect(servedModelCheck(invocation(), raw, { lane: 'subprocess', policy })).toEqual({
      pass: true,
      via: 'alias',
    });
    // The SAME alias declared for ANOTHER lane (or none) is no admission here.
    const other = await withServedModelAssertion(driverReturning(complete('model-b')), {
      lane: 'ai-sdk',
      policy,
    }).run(invocation());
    expect(other.stopReason).toBe('error');
    expect(other.errorClass).toBe('served-model-mismatch');
    expect(
      servedModelCheck(invocation(), complete('model-b'), { lane: 'claude-agent', policy }),
    ).toEqual({ pass: false, reason: "requested 'model-a', served 'model-b'" });
  });

  test('an alias compares NORMALISED ids: acp namespace + case do not defeat the declaration', () => {
    const policy: ServedModelPolicy = {
      aliases: { acp: { test: { 'glm-5.3': ['glm-4-6'] } } },
    };
    const check = servedModelCheck(invocation('GLM-5.3'), complete('builtin:bigmodel\\GLM-4-6'), {
      lane: 'acp',
      policy,
    });
    expect(check).toEqual({ pass: true, via: 'alias' });
  });

  test('an unobserved id fails closed by default', async () => {
    const wrapped = withServedModelAssertion(driverReturning(complete(undefined)), {
      lane: 'ai-sdk',
    });
    const verdict = await wrapped.run(invocation());
    expect(verdict.stopReason).toBe('error');
    expect(verdict.errorClass).toBe('served-model-mismatch');
    expect(verdict.error).toBe("requested 'model-a', served unobserved");
    expect(verdict).not.toHaveProperty('structuredOutput');
    expect(verdict.usage.input).toBe(11);
    expect(verdict.sessionId).toBe('ses-x');
  });

  test('requireObserved[lane]=false admits an unobserved id on that lane only', async () => {
    const policy: ServedModelPolicy = { requireObserved: { subprocess: false } };
    const passed = await withServedModelAssertion(driverReturning(complete(undefined)), {
      lane: 'subprocess',
      policy,
    }).run(invocation());
    expect(passed.stopReason).toBe('complete');
    expect(passed.structuredOutput).toEqual({ ok: true });
    expect(
      servedModelCheck(invocation(), complete(undefined), { lane: 'subprocess', policy }),
    ).toEqual({ pass: true, via: 'unobserved-allowed' });
    // Lane-scoped: the same policy leaves every other lane fail-closed.
    const other = await withServedModelAssertion(driverReturning(complete(undefined)), {
      lane: 'claude-agent',
      policy,
    }).run(invocation());
    expect(other.stopReason).toBe('error');
  });

  test('an OBSERVED mismatching id is never admitted by requireObserved=false', async () => {
    const policy: ServedModelPolicy = { requireObserved: { subprocess: false } };
    const verdict = await withServedModelAssertion(driverReturning(complete('model-b')), {
      lane: 'subprocess',
      policy,
    }).run(invocation());
    expect(verdict.stopReason).toBe('error');
    expect(verdict.errorClass).toBe('served-model-mismatch');
    expect(verdict.error).toBe("requested 'model-a', served 'model-b'");
  });

  test('non-complete verdicts are forwarded unjudged', async () => {
    const failed: WorkerResult = {
      model: 'model-b',
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'error',
      error: 'provider blew up',
      errorClass: 'provider-error',
    };
    const verdict = await withServedModelAssertion(driverReturning(failed), {
      lane: 'subprocess',
    }).run(invocation());
    expect(verdict).toBe(failed);
  });
});

describe('the lane set (LANE_IDS — the runtime statement of the LaneId union)', () => {
  test('is exactly the closed four-lane set (PR #238 review round 2)', () => {
    // The factory's binding validation checks decoded/JS config against
    // this array — it must name exactly the four first-party lanes, never
    // drift from the union it mirrors.
    expect([...LANE_IDS].sort()).toEqual(['acp', 'ai-sdk', 'claude-agent', 'subprocess']);
  });
});

describe('acp normalisation (normaliseModelId)', () => {
  test('the non-acp lanes are identity — no case folding', () => {
    for (const lane of ['ai-sdk', 'claude-agent', 'subprocess'] as const) {
      expect(normaliseModelId(lane, 'GLM-5.3')).toBe('GLM-5.3');
      expect(normaliseModelId(lane, 'builtin:bigmodel\\GLM-5.3')).toBe('builtin:bigmodel\\GLM-5.3');
    }
  });

  test('acp strips EXACTLY ONE leading builtin:<provider> namespace and case-folds', () => {
    expect(normaliseModelId('acp', 'builtin:bigmodel\\GLM-5.3')).toBe('glm-5.3');
    expect(normaliseModelId('acp', 'GLM-5.3')).toBe('glm-5.3');
    expect(normaliseModelId('acp', 'vendor/model-a')).toBe('vendor/model-a');
    // One strip, never a loop: a second namespace is left in place.
    expect(normaliseModelId('acp', 'builtin:a\\builtin:b\\GLM')).toBe('builtin:b\\glm');
  });

  test('acp wrapper: builtin:bigmodel\\GLM-5.3 matches glm-5.3, not glm-5.3-flash', async () => {
    const served = complete('builtin:bigmodel\\GLM-5.3');
    const pass = await withServedModelAssertion(driverReturning(served), { lane: 'acp' }).run(
      invocation('glm-5.3'),
    );
    expect(pass.stopReason).toBe('complete');
    const fail = await withServedModelAssertion(driverReturning(served), { lane: 'acp' }).run(
      invocation('glm-5.3-flash'),
    );
    expect(fail.stopReason).toBe('error');
    expect(fail.errorClass).toBe('served-model-mismatch');
    expect(fail.error).toBe("requested 'glm-5.3-flash', served 'builtin:bigmodel\\GLM-5.3'");
  });
});

describe('servedModelCheck — the exported record (via vocabulary)', () => {
  test('exact / alias / unobserved-allowed passes and both fail reasons', () => {
    const policy: ServedModelPolicy = {
      aliases: { subprocess: { test: { 'model-a': ['model-b'] } } },
      requireObserved: { 'claude-agent': false },
    };
    expect(servedModelCheck(invocation(), complete('model-a'), { lane: 'subprocess' })).toEqual({
      pass: true,
      via: 'exact',
    });
    expect(
      servedModelCheck(invocation(), complete('model-b'), { lane: 'subprocess', policy }),
    ).toEqual({ pass: true, via: 'alias' });
    expect(
      servedModelCheck(invocation(), complete(undefined), { lane: 'claude-agent', policy }),
    ).toEqual({ pass: true, via: 'unobserved-allowed' });
    expect(servedModelCheck(invocation(), complete(undefined), { lane: 'subprocess' })).toEqual({
      pass: false,
      reason: "requested 'model-a', served unobserved",
    });
    expect(servedModelCheck(invocation(), complete('model-z'), { lane: 'subprocess' })).toEqual({
      pass: false,
      reason: "requested 'model-a', served 'model-z'",
    });
  });

  test('an alias is provider-scoped: another provider handle is not admitted', () => {
    const policy: ServedModelPolicy = {
      aliases: { subprocess: { test: { 'model-a': ['model-b'] } } },
    };
    expect(
      servedModelCheck(invocation('model-a', 'other'), complete('model-b'), {
        lane: 'subprocess',
        policy,
      }),
    ).toEqual({ pass: false, reason: "requested 'model-a', served 'model-b'" });
  });
});

describe('RunOptions forwarding through the wrapper', () => {
  test('the options second parameter reaches the inner driver unchanged — pass and fail paths', async () => {
    const controller = new AbortController();
    const options: RunOptions = { signal: controller.signal };
    const inner = vi.fn(async (): Promise<WorkerResult> => complete('model-a'));
    const wrapped = withServedModelAssertion({ run: inner }, { lane: 'subprocess' });
    await wrapped.run(invocation(), options);
    expect(inner).toHaveBeenCalledExactlyOnceWith(invocation(), options);

    const mismatching = withServedModelAssertion(driverReturning(complete('model-b')), {
      lane: 'subprocess',
    });
    const verdict = await mismatching.run(invocation(), options);
    expect(verdict.stopReason).toBe('error');
    expect(controller.signal.aborted).toBe(false);
  });
});
