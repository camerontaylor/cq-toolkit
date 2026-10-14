// Strict-budget lane gate — the shared boundary that keeps
// `Budget.strictTokenBudget` honest on lanes that do not enforce it.
//
// The strict pre-request token ceiling is implemented ONLY by the in-process
// ai-sdk lane, and only with an operator-injected trusted capability. Every
// other lane accepts the same frozen `Budget` but has no pre-request ceiling,
// so a strict request routed to it would otherwise be SILENTLY IGNORED — the
// shared Budget promise would be dishonest. This helper is the ONE place that
// decides, called by the factory's resolved-driver wrapper and by each
// unsupported lane's `run()` entry BEFORE any session, credential read or
// spawn. It keys on the RESOLVED lane id (never a driver-declared capability
// flag) and leaves `maxUsd` untouched — that stays advisory where it was.
import { DispatchError } from '../errors.js';
import type { Budget } from '../types.js';

/**
 * Refuse a strict pre-request token budget on a lane that does not enforce it,
 * as a pre-dispatch `config` failure. A no-op when the budget carries no strict
 * ceiling, or when the lane is the one lane that enforces it (`ai-sdk`).
 */
export function assertStrictTokenBudgetSupported(budget: Budget, lane: string): void {
  if (budget.strictTokenBudget === undefined || lane === 'ai-sdk') return;
  throw new DispatchError(
    'config',
    `driver: Budget.strictTokenBudget is set but lane '${lane}' does not enforce a pre-request token ceiling — refusing before dispatch (only the 'ai-sdk' lane enforces it, and only with an injected trusted capability)`,
  );
}
