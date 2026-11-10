// Shared fixtures for the review.fixFinding suites.
//
// Hermetic by construction: the DriverFactory seam is the same scripted fake
// the fixReviewItem suites use — no network, no spawned processes, no
// filesystem writes. The bound tests capture the ACTUAL invocation from the
// scripted driver and serialize it independently, so the measurement oracle
// is not the production measurement.
import type { WorkerResult } from '../../../src/driver/types.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import type {
  FixFindingBinding,
  FixFindingInput,
  FixFindingOp,
} from '../../../src/ops/review/fixFinding.js';
import { makeFixFinding } from '../../../src/ops/review/fixFinding.js';
import type { FixFindingReport, FixFindingResult } from '../../../src/ops/review/fixFinding.js';
import { baseInput, scriptedFactory } from './fixReviewItem.helpers.js';

/** A valid carried binding (the op echoes it, it does not verify it). */
export const BINDING: FixFindingBinding = {
  job: 'repair-job-1',
  sourceSha: 'a'.repeat(40),
  sourceBlobSha: 'b'.repeat(40),
  findingSha256: 'c'.repeat(64),
  repairBase: 'd'.repeat(40),
};

/** A minimal valid fixFinding input over the fixItem fixture. */
export const findingInput = (extra?: Partial<FixFindingInput>): FixFindingInput => ({
  ...baseInput(),
  binding: { ...BINDING },
  ...extra,
});

/** A scripted factory plus the fixFinding op built over it. */
export const scriptedFindingOp = (results: WorkerResult[], retainSessions?: boolean) => {
  const scripted = scriptedFactory(results);
  return {
    requests: scripted.requests,
    invocations: scripted.invocations,
    op: makeFixFinding({
      drivers: scripted.drivers,
      ...(retainSessions === undefined ? {} : { retainSessions }),
    }),
  };
};

/** Unwrap an ok result (or fail the test naming the actual status). */
export const expectOk = (result: Awaited<ReturnType<FixFindingOp>>): FixFindingResult => {
  if (result.status !== 'ok') {
    throw new Error(`expected status 'ok', got '${result.status}'`);
  }
  return result.value;
};

/** The strict report envelope on a non-ok result (fails loud when absent). */
export const reportOf = (result: Awaited<ReturnType<FixFindingOp>>): FixFindingReport => {
  if (!('report' in result) || result.report === undefined) {
    throw new Error(`expected a report envelope on '${result.status}'`);
  }
  return result.report as FixFindingReport;
};

/** A harness with the system-prompt cap raised so bound tests stay linear. */
export const roomyHarness = (): NonNullable<FixFindingInput['harness']> => {
  const harness = structuredClone(defaultHarnessConfig);
  harness.promptBudget.maxSystemPromptChars = 40_000;
  return harness;
};
