// Split provenance: test/sandbox/probe.test.ts was split by subject into
// probe.{forgery,network-posture,required-mode,resolver,review-hardening,container-attribution}.test.ts
// plus probe.helpers.ts (shared fixtures). This file carries required-mode
// execution bounds: launchCertified authorizes only probe-earned receipt
// fields, postures and proxy ports.
import { describe, expect, test, vi } from 'vitest';

import {
  certifiedBackendsOf,
  certifyBackends,
  launchCertified,
  type SandboxCertification,
} from '../../experimental/sandbox-host/probe.js';
import { fakeAdapter, seams } from './probe.helpers.js';

// Measured scheduling margin (final head, concurrent authorized testing):
// each probe runs its controls as REAL bare-host processes, and process
// spawn latency on the shared host reached ~9s per spawn at load ~104 on
// 6 cores — far past the 5s vitest default for control-heavy tests.  This
// file-scoped bound is test scheduling margin only; product launch and
// probe timeouts are untouched.
vi.setConfig({ testTimeout: 120_000 });

describe('required-mode execution is bounded by probe-earned certifications', () => {
  test('launchCertified refuses a caller-forged certification object', async () => {
    const forged: SandboxCertification = {
      platform: 'linux',
      probedAt: new Date().toISOString(),
      network: 'model-only',
      networkDemonstrated: 'none',
      records: [],
      certified: ['bwrap'],
    };
    // A forged object yields nothing to the resolver bridge either.
    expect(certifiedBackendsOf(forged)).toEqual([]);
    await expect(
      launchCertified(fakeAdapter('fs-only'), forged, {
        workspace: '/tmp/ws',
        argv: ['/usr/bin/true'],
        network: 'model-only',
      }),
    ).rejects.toThrow(/not produced by the RS-13 probe/);
  });

  test('launchCertified refuses a backend the probe did not certify', async () => {
    const adapter = fakeAdapter('block-all');
    const certification = await certifyBackends({
      ...seams(),
      adapters: [adapter],
    });
    expect(certification.certified).toEqual([]);
    await expect(
      launchCertified(adapter, certification, {
        workspace: '/tmp/ws',
        argv: ['/usr/bin/true'],
        network: 'model-only',
      }),
    ).rejects.toThrow(/not certified for required mode.*fail-closed/s);
  });

  test('a different launcher instance sharing the backend name inherits nothing', async () => {
    const certified = fakeAdapter('fs-only');
    const certification = await certifyBackends({
      ...seams(),
      adapters: [certified],
      network: 'allow',
    });
    expect(certification.certified).toEqual(['bwrap']);
    const impostor = fakeAdapter('grant-all'); // same backend string, new object
    await expect(
      launchCertified(impostor, certification, {
        workspace: '/tmp/ws',
        argv: ['/usr/bin/true'],
        network: 'allow',
      }),
    ).rejects.toThrow(/launcher object was not probed by this certification/);
  });

  test('mutating the caller-visible fields cannot widen a launch or the handoff', async () => {
    const adapter = fakeAdapter('fs-only');
    const certification = await certifyBackends({
      ...seams(),
      adapters: [adapter],
      network: 'allow',
    });
    // The certified list is FROZEN at construction: the push itself is
    // refused (strict mode), so a forger cannot even widen the informational
    // copy — and the receipt is untouched either way.
    expect(() => (certification.certified as string[]).push('container')).toThrow();
    expect(certification.certified).toEqual(['bwrap']);
    // The intentionally-mutable caller-view fields cannot widen the gates:
    // the receipt still decides posture and egress flavor.
    (certification as { networkDemonstrated: string }).networkDemonstrated = 'proxy-loopback';
    (certification as { network: string }).network = 'model-only';
    await expect(
      launchCertified(adapter, certification, {
        workspace: '/tmp/ws',
        argv: ['/usr/bin/true'],
        network: 'model-only',
      }),
    ).rejects.toThrow(/certified under the 'allow' posture/);
    // The handoff still yields exactly what the probe earned.
    expect(certifiedBackendsOf(certification)).toEqual(['bwrap']);
    const launched = await launchCertified(adapter, certification, {
      workspace: '/tmp/ws',
      argv: ['/usr/bin/true'],
      network: 'allow',
    });
    expect(launched.ok).toBe(true);
  });

  test('a launch method swapped in after certification is refused', async () => {
    const adapter = fakeAdapter('fs-only');
    const certification = await certifyBackends({
      ...seams(),
      adapters: [adapter],
      network: 'allow',
    });
    const certifiedLaunch = adapter.launch;
    // Same object, same backend name — but the launch function is swapped for
    // a grant-all AFTER the canaries ran.  The receipt binds the exact
    // function reference, so the swap is detected, never inherited.
    adapter.launch = fakeAdapter('grant-all').launch;
    try {
      await expect(
        launchCertified(adapter, certification, {
          workspace: '/tmp/ws',
          argv: ['/bin/cat', '/etc/hostname'],
          network: 'allow',
        }),
      ).rejects.toThrow(/launch method changed after certification/);
    } finally {
      adapter.launch = certifiedLaunch;
    }
    // With the certified function restored, the same launch is authorized.
    const launched = await launchCertified(adapter, certification, {
      workspace: '/tmp/ws',
      argv: ['/usr/bin/true'],
      network: 'allow',
    });
    expect(launched.ok).toBe(true);
  });

  test('launchCertified executes inside a genuinely probe-certified backend', async () => {
    const adapter = fakeAdapter('fs-only');
    const certification = await certifyBackends({
      ...seams(),
      adapters: [adapter],
      network: 'allow',
    });
    expect(certification.certified).toEqual(['bwrap']);
    const launched = await launchCertified(adapter, certification, {
      workspace: '/tmp/ws',
      argv: ['/usr/bin/true'],
      network: 'allow',
    });
    expect(launched.ok).toBe(true);
  });

  test('certification does not transfer across postures', async () => {
    const adapter = fakeAdapter('fs-only');
    const certification = await certifyBackends({
      ...seams(),
      adapters: [adapter],
      network: 'allow',
    });
    await expect(
      launchCertified(adapter, certification, {
        workspace: '/tmp/ws',
        argv: ['/usr/bin/true'],
        network: 'model-only',
      }),
    ).rejects.toThrow(/certified under the 'allow' posture.*'model-only'/s);
  });

  test('a proxy stand-in authorizes neither an arbitrary port nor a launch without a port', async () => {
    const adapter = fakeAdapter('proxy-fs-only');
    const certification = await certifyBackends({
      ...seams(),
      adapters: [adapter],
      network: 'model-only',
      modelProxy: true,
    });
    expect(certifiedBackendsOf(certification)).toEqual([]);
    // Neither absence nor substitution of the port can inherit the transient
    // listener's observation after it has closed.
    for (const proxyPort of [undefined, 45454, 1]) {
      await expect(
        launchCertified(adapter, certification, {
          workspace: '/tmp/ws',
          argv: ['/usr/bin/true'],
          network: 'model-only',
          ...(proxyPort === undefined ? {} : { proxyPort }),
        }),
      ).rejects.toThrow(/not certified.*production endpoint identity or upstream allowlist/s);
    }
  });

  test('a non-proxy certification refuses a launch that carries a proxy port', async () => {
    const adapter = fakeAdapter('fs-only');
    const certification = await certifyBackends({
      ...seams(),
      adapters: [adapter],
      network: 'allow',
    });
    await expect(
      launchCertified(adapter, certification, {
        workspace: '/tmp/ws',
        argv: ['/usr/bin/true'],
        network: 'allow',
        proxyPort: 45454,
      }),
    ).rejects.toThrow(/proxyPort is not permitted/);
  });

  test('the certified list is exactly what the probe earned', async () => {
    const certification = await certifyBackends({
      ...seams(),
      adapters: [fakeAdapter('grant-all')],
    });
    expect(certifiedBackendsOf(certification)).toEqual([]);
  });
});
