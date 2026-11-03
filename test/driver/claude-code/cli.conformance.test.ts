// The claude-code lane's CLI transport — Phase 1.9 (from T1.5 slice 2).
//
// Two layers, mirroring test/driver/ai-sdk.test.ts:
//   1. THE CONFORMANCE SUITE (test/driver/conformance.ts, verbatim) run
//      against the real ClaudeCodeDriver spawning a FAKE agent CLI
//      (test/fixtures/fake-agent-cli.mjs) through the driver's `spawn`
//      override — no real `claude` binary, no network, no vendor SDK. The
//      suite's ModelDirective maps onto FAKE_AGENT_* env vars for the
//      fixture; the fixture's scripted tool_use is EXECUTED FOR REAL
//      against the invocation workspace (read/run/edit with harness-
//      matching denial reasons), which is what makes the I6 isolation pair
//      observable through a genuine filesystem.
//   2. DRIVER-SPECIFIC tests: THE REMAP TEST (an unknown model name on the
//      default routing table throws BEFORE any spawn — the spawn-hook
//      counter stays at zero), the SIGTERM→SIGKILL grace ladder (both rungs
//      observed in order against a real stubborn child), the graceful
//      single-rung abort, junk-line tolerance, --resume argv + sidecar
//      continuation, denial/structured/usage/cost mapping, and the
//      budget-usage + unknown-model-mode error paths.
//
// All runs ride the conformance routing table (a 'conformance' +
// 'conformance-priced' endpoint extension of the default table) so no test
// needs a real provider key; the remap test alone uses the DEFAULT table to
// pin the DeepSeek footgun to the shipped config.
import { describe, expect, test } from 'vitest';
import { makeDriver } from './cli.helpers.js';
import { runDriverConformance } from '../../../src/driver/conformance.js';
import { runGovernedAbortLeg } from '../conformance-kernel.js';

// ---------------------------------------------------------------------------
// 1. The conformance suite, fake-CLI-backed
// ---------------------------------------------------------------------------

runDriverConformance(
  makeDriver,
  { describe, test, expect },
  { label: 'claude-code driver, CLI transport (fake agent CLI)' },
);
runGovernedAbortLeg(makeDriver, { describe, test, expect });
