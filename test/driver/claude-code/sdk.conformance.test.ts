// The claude-code lane's SDK transport — the conformance layer (Phase 1.9,
// from T1.6 slice 1): the conformance suite (test/driver/conformance.ts) and
// the governed-abort kernel leg, run against the real ClaudeCodeDriver with
// a MOCK SDK module injected through the driver's `sdkLoader` seam — no
// @anthropic-ai/claude-agent-sdk dependency, no network, no real CLI.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import type { ConformanceSpec } from '../../../src/driver/conformance.js';
import { SESSIONS_DIR, runDriverConformance } from '../../../src/driver/conformance.js';
import { runGovernedAbortLeg } from '../conformance-kernel.js';
import {
  conformanceEndpointTable,
  conformanceHarnessConfig,
  mockSdkModule,
} from './sdk.helpers.js';

/** Fresh mock-backed ClaudeCodeDriver honoring the ConformanceSpec contract. */
function makeDriver(spec: ConformanceSpec): ClaudeCodeDriver {
  return new ClaudeCodeDriver({
    transport: 'sdk',
    sdkLoader: async () =>
      mockSdkModule({
        ...(spec.directive === undefined ? {} : { directive: spec.directive }),
        calls: [],
      }),
    routingTable: conformanceEndpointTable(),
    // The priced handle flows through the price lookup so the conformance
    // suite can assert a derived costUSD; everything else stays unpriced.
    ...(spec.pricedModel !== undefined
      ? {
          pricing: (modelSpec: { provider: string; model: string }) =>
            modelSpec.provider === spec.pricedModel?.provider
              ? { input: 3, output: 15 }
              : undefined,
        }
      : {}),
    sessionsDir: join(spec.scratchDir, SESSIONS_DIR),
    harnessConfig: conformanceHarnessConfig(spec.scratchDir),
  });
}

// ---------------------------------------------------------------------------
// 1. The conformance suite, mock-backed
// ---------------------------------------------------------------------------

runDriverConformance(
  makeDriver,
  { describe, test, expect },
  { label: 'claude-code driver, sdk transport (mock sdk)' },
);
runGovernedAbortLeg(makeDriver, { describe, test, expect });
