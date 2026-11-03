// Split provenance: test/driver/strict-token-budget-guard.test.ts was split by subject;
// this file keeps the shared `assertStrictTokenBudgetSupported` helper contract.
// The suite-wide header, fixtures and lane gate narrative live in
// ./strict-token-budget-guard.helpers.ts.
import { describe, expect, test } from 'vitest';
import { assertStrictTokenBudgetSupported } from '../../src/driver/common/strict-budget.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';

// ---------------------------------------------------------------------------
// 1. The shared helper
// ---------------------------------------------------------------------------

describe('assertStrictTokenBudgetSupported', () => {
  test('refuses a strict budget on a non-ai-sdk lane as a config failure', () => {
    const err = (() => {
      try {
        assertStrictTokenBudgetSupported(
          { strictTokenBudget: { maxInputTokens: 1, reserveOutputTokens: 1 } },
          'claude-code',
        );
      } catch (caught) {
        return caught;
      }
      throw new Error('expected a refusal');
    })();
    expect(err).toBeInstanceOf(DispatchError);
    expect(errorClassOf(err)).toBe('config');
    expect((err as Error).message).toContain('strictTokenBudget');
    expect((err as Error).message).toContain('claude-code');
  });

  test('is a no-op for the ai-sdk lane and for a budget without a strict ceiling', () => {
    expect(() =>
      assertStrictTokenBudgetSupported(
        { strictTokenBudget: { maxInputTokens: 1, reserveOutputTokens: 1 } },
        'ai-sdk',
      ),
    ).not.toThrow();
    expect(() => assertStrictTokenBudgetSupported({ maxUsd: 5 }, 'claude-code')).not.toThrow();
    expect(() => assertStrictTokenBudgetSupported({}, 'claude-code')).not.toThrow();
  });
});
