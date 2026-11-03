// Split provenance: test/driver/strict-token-budget-guard.test.ts was split by subject;
// this file keeps the factory resolved-driver guard over exact and wildcard
// bindings for all three unsupported lanes. Shared fixtures live in
// ./strict-token-budget-guard.helpers.ts.
import { rm } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import { createDriverFactory } from '../../src/driver/factory.js';
import { invocation, scratch } from './strict-token-budget-guard.helpers.js';

// ---------------------------------------------------------------------------
// 3. Factory resolved-driver guard — exact and wildcard bindings, all 3 lanes
// ---------------------------------------------------------------------------

describe('factory guard refuses a strict budget on unsupported lanes', () => {
  const lanes = ['claude-code', 'claude-code', 'acp'] as const;

  for (const lane of lanes) {
    for (const binding of ['exact', 'wildcard'] as const) {
      test(`${lane} (${binding} binding): config throw before dispatch`, async () => {
        const { root, sessionsDir } = await scratch();
        try {
          const factory = createDriverFactory({
            sessionsDir,
            bindings: { fixer: binding === 'exact' ? { probe: lane } : { '*': lane } },
          });
          const resolved = factory.resolve({
            role: 'fixer',
            modelSpec: { provider: 'probe', model: 'claude-test' },
          });
          expect(resolved.lane).toBe(lane);
          const err = await resolved.driver
            .run(invocation({ provider: 'probe', model: 'claude-test' }))
            .catch((e: unknown) => e);
          expect(err).toBeInstanceOf(DispatchError);
          expect(errorClassOf(err)).toBe('config');
          expect((err as Error).message).toContain('strictTokenBudget');
          expect((err as Error).message).toContain(lane);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }

  test('a non-strict budget on an unsupported lane is NOT refused by the guard', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const factory = createDriverFactory({
        sessionsDir,
        bindings: { fixer: { probe: 'claude-code' } },
      });
      const resolved = factory.resolve({
        role: 'fixer',
        modelSpec: { provider: 'probe', model: 'claude-test' },
      });
      const err = await resolved.driver
        .run(invocation({ provider: 'probe', model: 'claude-test' }, { maxUsd: 2 }))
        .catch((e: unknown) => e);
      // Not the strict-budget refusal (the lane's own unknown-provider route
      // check is a different config failure, allowed to fire).
      expect(String((err as Error).message)).not.toContain(
        'does not enforce a pre-request token ceiling',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
