// Split provenance: test/sandbox/probe.test.ts was split by subject into
// probe.{forgery,network-posture,required-mode,resolver,review-hardening,container-attribution}.test.ts
// plus probe.helpers.ts (shared fixtures). This file carries review hardening
// of the certification entry points: per-candidate isolation and the
// receipt-bound launch function.
import { describe, expect, test, vi } from 'vitest';

import { certifyBackends, launchCertified } from '../../experimental/sandbox-host/probe.js';
import type { SandboxBackendAdapter } from '../../src/sandbox/launcher.js';
import { fakeAdapter, result, seams } from './probe.helpers.js';

// Measured scheduling margin (final head, concurrent authorized testing):
// each probe runs its controls as REAL bare-host processes, and process
// spawn latency on the shared host reached ~9s per spawn at load ~104 on
// 6 cores — far past the 5s vitest default for control-heavy tests.  This
// file-scoped bound is test scheduling margin only; product launch and
// probe timeouts are untouched.
vi.setConfig({ testTimeout: 120_000 });

describe('review hardening of the certification entry points', () => {
  test('one candidate throwing does not hide the others, and the aggregate claims nothing', async () => {
    const throwing: SandboxBackendAdapter = {
      ...fakeAdapter('fs-only'),
      available: () => Promise.reject(new Error('available exploded')),
    };
    const certification = await certifyBackends({
      ...seams(),
      network: 'allow',
      adapters: [throwing, fakeAdapter('fs-only')],
    });
    expect(certification.records).toHaveLength(2);
    expect(certification.records[0]?.certified).toBe(false);
    expect(certification.records[0]?.blocker).toMatch(/probe failed: available exploded/);
    expect(certification.certified).toEqual(['bwrap']);

    const none = await certifyBackends({
      ...seams(),
      network: 'allow',
      adapters: [throwing],
    });
    expect(none.networkDemonstrated).toBe('none');
  });

  test('launchCertified invokes the receipt-bound function, not a re-read accessor', async () => {
    const adapter = fakeAdapter('fs-only');
    const certification = await certifyBackends({
      ...seams(),
      network: 'allow',
      adapters: [adapter],
    });
    const bound = adapter.launch;
    const grantAll = vi.fn(() => Promise.resolve(result({ ok: true, exitCode: 0 })));
    let reads = 0;
    Object.defineProperty(adapter, 'launch', {
      get: () => (++reads === 1 ? bound : grantAll),
    });
    await launchCertified(adapter, certification, {
      workspace: '/tmp',
      argv: ['/usr/bin/true'],
      network: 'allow',
    });
    expect(grantAll).not.toHaveBeenCalled();
  });

  test('the receipt binds the launch the canaries exercised, not a certify-time re-read', async () => {
    const adapter = fakeAdapter('fs-only');
    const exercised = adapter.launch;
    const grantAll = vi.fn(() => Promise.resolve(result({ ok: true, exitCode: 0 })));
    // The probe's own entry read yields the function the canaries ran; every
    // later read (receipt checks, launchCertified) yields the grant-all.
    // certifyBackends performs no read of its own outside the guarded probe
    // (Codex P2), so the probe's read is the first.  Binding the grant-all
    // would authorize a launch nobody probed.
    let reads = 0;
    Object.defineProperty(adapter, 'launch', {
      get: () => (++reads === 1 ? exercised : grantAll),
    });
    const certification = await certifyBackends({
      ...seams(),
      network: 'allow',
      adapters: [adapter],
    });
    expect(certification.certified).toEqual(['bwrap']);
    await expect(
      launchCertified(adapter, certification, {
        workspace: '/tmp',
        argv: ['/usr/bin/true'],
        network: 'allow',
      }),
    ).rejects.toThrow(/launch method changed after certification/);
    expect(grantAll).not.toHaveBeenCalled();
  });

  test('a throwing launch accessor becomes that candidate blocker, not a rejected certification', async () => {
    // Codex P2: the fallback launch read sat outside the per-candidate guard,
    // so a throwing accessor rejected certifyBackends before later candidates
    // were probed.
    const throwing = fakeAdapter('fs-only');
    Object.defineProperty(throwing, 'launch', {
      get: () => {
        throw new Error('launch accessor exploded');
      },
    });
    const certification = await certifyBackends({
      ...seams(),
      network: 'allow',
      adapters: [throwing, fakeAdapter('fs-only')],
    });
    expect(certification.records).toHaveLength(2);
    expect(certification.records[0]?.certified).toBe(false);
    expect(certification.records[0]?.blocker).toMatch(/probe failed: launch accessor exploded/);
    expect(certification.certified).toEqual(['bwrap']);
  });
});
