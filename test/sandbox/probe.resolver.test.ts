// Split provenance: test/sandbox/probe.test.ts was split by subject into
// probe.{forgery,network-posture,required-mode,resolver,review-hardening,container-attribution}.test.ts
// plus probe.helpers.ts (shared fixtures). This file carries the resolver
// bridge: certified backends feed configuration without inventing any.
import { describe, expect, test, vi } from 'vitest';

import { certifiedBackendsOf } from '../../experimental/sandbox-host/probe.js';
import { resolveSandboxConfig } from '../../src/sandbox/config.js';

// Measured scheduling margin (final head, concurrent authorized testing):
// each probe runs its controls as REAL bare-host processes, and process
// spawn latency on the shared host reached ~9s per spawn at load ~104 on
// 6 cores — far past the 5s vitest default for control-heavy tests.  This
// file-scoped bound is test scheduling margin only; product launch and
// probe timeouts are untouched.
vi.setConfig({ testTimeout: 120_000 });

describe('the certified list feeds the resolver without inventing backends', () => {
  test('required mode stays fail-closed today even with a certified backend', () => {
    // Current dd247ca contract: no certified launcher is wired yet, so
    // required withholds run even when a probe-earned backend exists.  When
    // the CFG/S handoff flips the seam, this row is the one to update —
    // deliberately, with the flip.
    const config = resolveSandboxConfig({
      env: { CQ_SANDBOX: 'required' },
      platform: 'darwin',
      certifiedBackends: ['seatbelt'],
    });
    expect(config.selectedBackend).toBe('seatbelt');
    expect(config.runTool).toBe('withheld');
    expect(config.configHint).toMatch(/fail-closed/);
  });

  test('a backend that earned nothing keeps required closed and auto empty', () => {
    const config = resolveSandboxConfig({
      env: { CQ_SANDBOX: 'required' },
      platform: 'darwin',
      certifiedBackends: certifiedBackendsOf({
        platform: 'darwin',
        probedAt: new Date().toISOString(),
        network: 'model-only',
        networkDemonstrated: 'none',
        records: [],
        certified: [],
      }),
    });
    expect(config.selectedBackend).toBeUndefined();
    expect(config.runTool).toBe('withheld');
  });
});
