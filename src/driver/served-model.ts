// Shared served-model assertion for driver construction.
//
// A driver reports the model it observed on the response; callers must not
// silently substitute the requested id when that observation is absent or
// differs. This wrapper is deliberately fail-closed and has no record mode:
// the only safe action is to return an error verdict.
import type { Driver, OpInvocation, WorkerResult } from './types.js';

export type ServedModelLane = 'default' | 'acp';

export interface ServedModelPolicy {
  /** ACP may omit an observation; all other lanes require one. */
  requireObserved?: boolean;
  /** Compare after stripping vendor provider prefixes (ACP uses `provider\\model`). */
  normalizeVendorPrefix?: boolean;
}

function normalizeModel(model: string, normalize: boolean): string {
  if (!normalize) return model;
  // ACP reports a vendor-qualified id (for example `vendor/model`), while
  // the invocation carries the model id. Remove only that one prefix; model
  // ids themselves may contain a slash and must not be collapsed to their
  // final segment.
  return model.replace(/^[^/\\]+[\\/]/, '');
}

/** Return a copy of the result that fails when the served model is untrusted. */
export function assertServedModel(
  invocation: OpInvocation,
  result: WorkerResult,
  lane: ServedModelLane = 'default',
  policy: ServedModelPolicy = {},
): WorkerResult {
  const requireObserved = policy.requireObserved ?? lane !== 'acp';
  const normalize = policy.normalizeVendorPrefix ?? lane === 'acp';
  if (result.model === undefined) {
    if (!requireObserved) return result;
    return {
      ...result,
      stopReason: 'error',
      error: 'served model assertion: no served model was observed',
    };
  }
  if (
    normalizeModel(result.model, normalize) !==
    normalizeModel(invocation.modelSpec.model, normalize)
  ) {
    return {
      ...result,
      stopReason: 'error',
      error: `served model assertion: requested '${invocation.modelSpec.model}' but observed '${result.model}'`,
    };
  }
  return result;
}

/** Wrap a concrete driver with the shared fail-closed served-model contract. */
export function withServedModelAssertion(
  driver: Driver,
  lane: ServedModelLane = 'default',
  policy: ServedModelPolicy = {},
): Driver {
  return {
    async run(invocation: OpInvocation): Promise<WorkerResult> {
      return assertServedModel(invocation, await driver.run(invocation), lane, policy);
    },
  };
}

/** Factory seam used by op wiring: the returned driver always passes through the wrapper. */
export function DriverFactory(
  driver: Driver,
  lane: ServedModelLane = 'default',
  policy: ServedModelPolicy = {},
): Driver {
  return withServedModelAssertion(driver, lane, policy);
}

export const createDriverFactory = DriverFactory;
