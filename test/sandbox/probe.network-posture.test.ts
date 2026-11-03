// Split provenance: test/sandbox/probe.test.ts was split by subject into
// probe.{forgery,network-posture,required-mode,resolver,review-hardening,container-attribution}.test.ts
// plus probe.helpers.ts (shared fixtures). This file carries the posture-aware
// network certification legs (allow vs model-only vs proxy stand-in), both
// with fakes and with the real seatbelt backend (darwin only).
import { describe, expect, test, vi } from 'vitest';

import { seatbeltAdapter } from '../../experimental/sandbox-host/backend.js';
import {
  certifiedBackendsOf,
  certifyBackends,
  launchCertified,
  probeBackend,
} from '../../experimental/sandbox-host/probe.js';
import { ALL_IDS, fakeAdapter, seams, verdictOf } from './probe.helpers.js';

// Measured scheduling margin (final head, concurrent authorized testing):
// each probe runs its controls as REAL bare-host processes, and process
// spawn latency on the shared host reached ~9s per spawn at load ~104 on
// 6 cores — far past the 5s vitest default for control-heavy tests.  This
// file-scoped bound is test scheduling margin only; product launch and
// probe timeouts are untouched.
vi.setConfig({ testTimeout: 120_000 });

describe('posture-aware network certification', () => {
  test('modelProxy combined with network allow is rejected, not silently dropped', async () => {
    await expect(
      probeBackend(fakeAdapter('fs-only'), { ...seams(), network: 'allow', modelProxy: true }),
    ).rejects.toThrow(/modelProxy.*allow/);
  });

  test('the nested-child canary passes the sibling path as an argument, not shell source', async () => {
    const seen: string[][] = [];
    const adapter = fakeAdapter('fs-only');
    const inner = adapter.launch;
    adapter.launch = (request) => {
      seen.push([...request.argv]);
      return inner(request);
    };
    await probeBackend(adapter, { ...seams(), network: 'allow' });
    const nested = seen.find((argv) => argv[3] === 'cq-nested');
    expect(nested?.[2]).toBe('/bin/cat "$1"');
    expect(nested?.[4]).toContain('cq-');
  });

  test('an allow-posture boundary certifies for allow, never for model-only', async () => {
    const allow = await probeBackend(fakeAdapter('fs-only'), {
      ...seams(),
      network: 'allow',
    });
    expect(verdictOf(allow, 'network-loopback')).toBe('pass');
    expect(verdictOf(allow, 'read-escape-sibling')).toBe('pass');
    expect(verdictOf(allow, 'symlink-escape')).toBe('pass');
    expect(verdictOf(allow, 'nested-child-escape')).toBe('pass');
    expect(allow.certified).toBe(true);
    expect(allow.networkDemonstrated).toBe('allow');
    const modelOnly = await probeBackend(fakeAdapter('fs-only'), {
      ...seams(),
      network: 'model-only',
    });
    expect(verdictOf(modelOnly, 'network-loopback')).toBe('fail');
    expect(modelOnly.certified).toBe(false);
  });

  test('a passing proxy stand-in remains diagnostic and cannot certify a production endpoint', async () => {
    const record = await probeBackend(fakeAdapter('proxy-fs-only'), {
      ...seams(),
      network: 'model-only',
      modelProxy: true,
    });
    expect(verdictOf(record, 'network-proxy')).toBe('pass');
    expect(record.certified).toBe(false);
    expect(record.blocker).toMatch(/production endpoint identity or upstream allowlist/);
    expect(record.networkDemonstrated).toBe('proxy-loopback');
    // The same boundary probed WITHOUT the proxy demand refuses the loopback
    // connect (the fake only opens the declared proxy port).  The probe
    // classifies an honest, executed denial as a pass — so this stricter
    // boundary EARNS certification under plain model-only, exactly as a real
    // boundary of this shape would.
    const strict = await probeBackend(fakeAdapter('proxy-fs-only'), {
      ...seams(),
      network: 'model-only',
    });
    expect(verdictOf(strict, 'network-loopback')).toBe('pass');
    expect(strict.certified).toBe(true);
  });
});

describe.runIf(process.platform === 'darwin')('the real seatbelt certification', () => {
  test('the live canaries certify seatbelt under model-only posture', async () => {
    // Deterministic seams (crq delta review): outbound reachability of the
    // default external target and the host's /usr/local content must not
    // decide this verdict; the seam stub is still a real executable outside
    // the exec allowlist, attacked live.
    const certification = await certifyBackends({
      ...seams(),
      adapters: [seatbeltAdapter()],
    });
    const record = certification.records.find((r) => r.backend === 'seatbelt');
    expect(record?.certified).toBe(true);
    expect(record?.blocker).toBeUndefined();
    const passed = new Set(
      record?.canaries.filter((c) => c.verdict === 'pass').map((c) => c.id) ?? [],
    );
    for (const id of [
      ...ALL_IDS,
      'workspace-control',
      'network-loopback',
      'network-external',
    ] as const) {
      expect(passed.has(id)).toBe(true);
    }
    expect(certifiedBackendsOf(certification)).toEqual(['seatbelt']);
  }, 180_000);

  test('live proxy stand-in observations do not certify a production proxy', async () => {
    const adapter = seatbeltAdapter();
    const certification = await certifyBackends({
      ...seams(),
      adapters: [adapter],
      network: 'model-only',
      modelProxy: true,
    });
    const record = certification.records.find((r) => r.backend === 'seatbelt');
    expect(record?.certified).toBe(false);
    expect(record?.blocker).toMatch(/production endpoint identity or upstream allowlist/);
    expect(verdictOf(record, 'network-proxy')).toBe('pass');
    expect(certifiedBackendsOf(certification)).toEqual([]);
    await expect(
      launchCertified(adapter, certification, {
        workspace: '/tmp/ws',
        argv: ['/usr/bin/true'],
        network: 'model-only',
        proxyPort: 1,
      }),
    ).rejects.toThrow(/not certified for required mode/);
  }, 180_000);
});
