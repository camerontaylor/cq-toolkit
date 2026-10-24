import type { FailureSet } from '../gates/checkRunner.js';
import { fingerprintPairs } from '../gates/fingerprint.js';

export interface EscalationPolicy {
  workerAttempts: number;
  rescueBase: number;
  rescuePerFixed: number;
  rescuePerPackageCap: number;
}
export interface EscalationDecision {
  tier: 'worker' | 'rescue' | 'human';
  attempt: number;
  reason: string;
}
export interface EscalationRequest {
  package: string;
  task: string;
  workerUsed: number;
  rescueUsed: number;
  canRescue: boolean;
  regression?: boolean;
  reason: string;
  stopReason?: string;
}
export interface EscalationState {
  initialFixedFailures: number;
  fixedFingerprints: string[];
  perRunUsed: number;
  perPackageUsed: Record<string, number>;
  events: Array<EscalationDecision & { package: string; task: string }>;
}

/** Fresh compositions have no historical fixes; this optional seed belongs only to the pure core. */
export function createEscalationState(initialFixedFailures = 0): EscalationState {
  if (!Number.isSafeInteger(initialFixedFailures) || initialFixedFailures < 0)
    throw new Error('initialFixedFailures must be a nonnegative safe integer');
  return {
    initialFixedFailures,
    fixedFingerprints: [],
    perRunUsed: 0,
    perPackageUsed: {},
    events: [],
  };
}

export function rescueAllocation(state: EscalationState, policy: EscalationPolicy): number {
  return (
    Math.max(policy.rescueBase, Math.floor(state.initialFixedFailures / policy.rescuePerFixed)) +
    Math.floor(state.fixedFingerprints.length / policy.rescuePerFixed)
  );
}

/** Call only after commit verification. Full occurrence keys avoid hash collisions and duplicate credit. */
export function recordFixedFailures(
  state: EscalationState,
  before: FailureSet,
  after: FailureSet,
): EscalationState {
  const remaining = new Set(fingerprintPairs(after).map((pair) => pair.key));
  return {
    ...state,
    fixedFingerprints: [
      ...new Set([
        ...state.fixedFingerprints,
        ...fingerprintPairs(before)
          .filter((pair) => !remaining.has(pair.key))
          .map((pair) => pair.key),
      ]),
    ],
  };
}

/** Pure transition. The composition replaces state synchronously, reserving before any awaited dispatch. */
export function nextEscalation(
  state: EscalationState,
  policy: EscalationPolicy,
  request: EscalationRequest,
): { state: EscalationState; decision: EscalationDecision } {
  const packageUsed = Object.hasOwn(state.perPackageUsed, request.package)
    ? state.perPackageUsed[request.package]!
    : 0;
  let decision: EscalationDecision;
  let next = state;
  if (request.stopReason) decision = { tier: 'human', attempt: 0, reason: request.stopReason };
  else if (
    !request.regression &&
    request.rescueUsed === 0 &&
    request.workerUsed < policy.workerAttempts
  )
    decision = {
      tier: 'worker',
      attempt: request.workerUsed + 1,
      reason: request.workerUsed === 0 ? 'initial task' : `worker retry: ${request.reason}`,
    };
  else if (!request.canRescue)
    decision = { tier: 'human', attempt: 0, reason: `rescue role unavailable: ${request.reason}` };
  else if (packageUsed >= policy.rescuePerPackageCap)
    decision = {
      tier: 'human',
      attempt: 0,
      reason: `per-package rescue cap exhausted: ${request.reason}`,
    };
  else if (state.perRunUsed >= rescueAllocation(state, policy))
    decision = {
      tier: 'human',
      attempt: 0,
      reason: `run rescue pool exhausted: ${request.reason}`,
    };
  else {
    decision = {
      tier: 'rescue',
      attempt: request.rescueUsed + 1,
      reason: `${request.regression ? 'broader regression; rescue' : 'rescue retry'}: ${request.reason}`,
    };
    next = {
      ...state,
      perRunUsed: state.perRunUsed + 1,
      perPackageUsed: { ...state.perPackageUsed, [request.package]: packageUsed + 1 },
    };
  }
  return {
    state: {
      ...next,
      events: [...next.events, { ...decision, package: request.package, task: request.task }],
    },
    decision,
  };
}
