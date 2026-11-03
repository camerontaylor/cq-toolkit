// Split provenance: test/driver/factory.test.ts was split by subject; this
// file keeps the resolved wrapper-stack subject — the served-model assertion
// applied to every driver and RunOptions.signal forwarding through it. The
// suite-wide header and shared fixtures live in ./factory.helpers.ts.
import { describe, expect, test } from 'vitest';
import { createDriverFactory } from '../../src/driver/factory.js';
import { invocation, scratch, stubKey, subprocessConfig } from './factory.helpers.js';

describe('driver factory — wrapping', () => {
  test('every resolved driver carries the served-model assertion (mismatch → served-model-mismatch)', async () => {
    stubKey();
    const dir = await scratch();
    // TREATMENT: the fake CLI serves a remapped id.
    const factory = createDriverFactory(
      subprocessConfig(dir, ['FAKE_AGENT_SERVED_MODEL=remapped']),
    );
    const resolved = factory.resolve({
      role: 'fixer',
      modelSpec: { provider: 'construction', model: 'construction-model' },
    });
    const verdict = await resolved.driver.run(invocation());
    expect(verdict.stopReason).toBe('error');
    expect(verdict.errorClass).toBe('served-model-mismatch');
    expect(verdict.error).toContain("requested 'construction-model', served 'remapped'");

    // CONTROL: an honest CLI completes on the same factory.
    const honest = createDriverFactory(subprocessConfig(await scratch(), []));
    const ok = await honest
      .resolve({
        role: 'fixer',
        modelSpec: { provider: 'construction', model: 'construction-model' },
      })
      .driver.run(invocation());
    expect(ok.stopReason).toBe('complete');
    expect(ok.model).toBe('construction-model');
  });

  test("b-v (factory half): the resolved wrapper stack forwards RunOptions.signal — a PRE-aborted 'reap-on-settle' resolution never dispatches", async () => {
    stubKey();
    const dir = await scratch();
    const dead = new AbortController();
    dead.abort();
    // Conformance leg b-v's factory half (ADR-0002 §2.1): the signal must
    // cross the reap-on-settle wrapper AND the outermost served-model
    // assertion and reach the lane. A fewer-parameter wrapper would compile
    // and silently drop it; the zero-usage 'aborted' verdict with NO session
    // proves the CLI child never spawned (a spawn would leave a record).
    const verdict = await createDriverFactory(subprocessConfig(dir, []))
      .resolve({
        role: 'fixer',
        modelSpec: { provider: 'construction', model: 'construction-model' },
        sessionRetention: 'reap-on-settle',
      })
      .driver.run(invocation(), { signal: dead.signal });
    expect(verdict.stopReason).toBe('aborted');
    expect(verdict.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(verdict.sessionId).toBeUndefined();
  });
});
