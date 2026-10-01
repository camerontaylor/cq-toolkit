// The RS-13 certification probe (B14).  The invariants that make the
// certification unforgeable are tested with fakes on every host:
//   - a launcher that blocks EVERYTHING fails its workspace control and is
//     never certified (broken is not confined);
//   - a launcher that grants EVERYTHING fails every denial canary — including
//     the sibling, symlink, nested-child, and external legs — and is never
//     certified (granted is not a boundary);
//   - an inconclusive canary (its control could not fire) refuses
//     certification — doubt fails closed;
//   - a backend that cannot compose a proxy is UNCERTIFIABLE for a
//     proxy-composed posture and fails closed;
//   - `launchCertified` refuses a certification object the probe did not
//     produce (forged), a backend the probe did not certify, a mismatched
//     posture, and a proxy-port/promise mismatch.
// The real seatbelt certification runs only where seatbelt runs; everywhere
// else the same probe records the platform blocker instead.  LIVE STATUS: the
// narrow-allow profile has not yet executed on any host — live evidence at
// final head is a gate of the fresh protocol sequence, not this suite.
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  seatbeltAdapter,
  type SandboxBackendAdapter,
  type SandboxLaunchResult,
} from '../../src/sandbox/backend.js';
import { resolveSandboxConfig } from '../../src/sandbox/config.js';
import {
  certifiedBackendsOf,
  certifyBackends,
  launchCertified,
  probeBackend,
  type BackendProbeRecord,
  type SandboxCertification,
} from '../../src/sandbox/probe.js';

const result = (over: Partial<SandboxLaunchResult>): SandboxLaunchResult => ({
  ok: false,
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...over,
});

const denied = () => result({ exitCode: 1, stderr: 'fake boundary: Operation not permitted' });

/**
 * A fake whose verdicts follow one of five behaviors, keyed by what the
 * canaries ask the child to do:
 *   grant-all    — every child succeeds (a boundary that does not bound);
 *   block-all    — no child ever runs (a broken launcher, not confinement);
 *   env-fails    — children run except the env probe (an inconclusive canary);
 *   fs-only      — filesystem denials hold but the child may connect (an
 *                  `allow`-posture boundary, wrong for model-only);
 *   proxy-fs-only— fs denials hold and ONLY the declared proxy port passes —
 *                  the proxy-composed model-only boundary.
 */
function fakeAdapter(
  behavior: 'grant-all' | 'block-all' | 'env-fails' | 'fs-only' | 'proxy-fs-only',
): SandboxBackendAdapter {
  return {
    backend: 'bwrap',
    workspaceParent: () => '/tmp',
    ...(behavior === 'proxy-fs-only' ? { supportsProxyModelOnly: true as const } : {}),
    available: async () => ({ available: true }),
    launch: (request) => {
      if (behavior === 'block-all') {
        return Promise.resolve(result({ spawnError: 'fake launcher refuses everything' }));
      }
      const argText = request.argv.join(' ');
      const portMatch = argText.match(/dev\/tcp\/([^/]+)\/(\d+)/);
      const inWorkspace = request.argv[1]?.startsWith(request.workspace) === true;
      if (request.argv[0] === '/bin/bash') {
        if (behavior === 'grant-all') return Promise.resolve(result({ ok: true, exitCode: 0 }));
        // fs-only: any connect passes.  proxy-fs-only: only the declared
        // proxy loopback port passes — non-proxy ports and external hosts are
        // denied even when a proxyPort was granted.
        const allowed =
          behavior === 'fs-only' ||
          (behavior === 'proxy-fs-only' &&
            portMatch !== null &&
            portMatch[1] === '127.0.0.1' &&
            Number(portMatch[2]) === request.proxyPort);
        return allowed
          ? Promise.resolve(result({ ok: true, exitCode: 0 }))
          : Promise.resolve(denied());
      }
      if (request.argv[0] === '/usr/bin/printenv') {
        if (behavior === 'env-fails') return Promise.resolve(result({ exitCode: 7 }));
        if (behavior === 'grant-all') {
          return Promise.resolve(
            result({
              ok: true,
              exitCode: 0,
              stdout: request.parentEnv?.[request.argv[1] ?? ''] ?? '',
            }),
          );
        }
        return Promise.resolve(result({ exitCode: 1 }));
      }
      if (behavior === 'grant-all') return Promise.resolve(result({ ok: true, exitCode: 0 }));
      return inWorkspace
        ? Promise.resolve(result({ ok: true, exitCode: 0 }))
        : Promise.resolve(denied());
    },
  };
}

const verdictOf = (record: BackendProbeRecord | undefined, id: string) =>
  record?.canaries.find((canary) => canary.id === id)?.verdict;

const ALL_IDS = [
  'read-escape',
  'read-escape-sibling',
  'symlink-escape',
  'nested-child-escape',
  'write-escape',
  'credential-env',
  'credential-file',
] as const;

describe('a probe can be forged by neither a broken nor a promiscuous launcher', () => {
  test('a launcher that blocks everything fails its control and stays uncertified', async () => {
    const record = await probeBackend(fakeAdapter('block-all'));
    expect(record.runnable).toBe(false); // it claims availability but ran no child
    expect(verdictOf(record, 'workspace-control')).toBe('fail');
    expect(record.certified).toBe(false);
    expect(record.blocker).toMatch(/did not run a child in the workspace/);
  });

  test('a launcher that grants everything fails every denial canary', async () => {
    const record = await probeBackend(fakeAdapter('grant-all'));
    for (const id of ALL_IDS) {
      expect(verdictOf(record, id)).toBe('fail');
    }
    expect(verdictOf(record, 'network-loopback')).toBe('fail');
    expect(verdictOf(record, 'network-external')).toBe('fail');
    expect(record.certified).toBe(false);
    expect(record.blocker).toMatch(/read-escape/);
  });

  test('an inconclusive canary refuses certification — doubt fails closed', async () => {
    const record = await probeBackend(fakeAdapter('env-fails'));
    expect(verdictOf(record, 'credential-env')).toBe('inconclusive');
    expect(record.certified).toBe(false);
    expect(record.blocker).toMatch(/inconclusive/);
  });

  test('a backend that cannot run records its exact environmental blocker', async () => {
    const record = await probeBackend({
      backend: 'container',
      workspaceParent: () => '/tmp',
      available: async () => ({ available: false, blocker: 'docker daemon unreachable' }),
      launch: async () => result({}),
    });
    expect(record.runnable).toBe(false);
    expect(record.certified).toBe(false);
    expect(record.blocker).toBe('docker daemon unreachable');
    expect(record.canaries).toEqual([]);
  });

  test('a proxy-composed posture is uncertifiable for a backend without composition', async () => {
    const record = await probeBackend(fakeAdapter('fs-only'), {
      network: 'model-only',
      modelProxy: true,
    });
    expect(record.runnable).toBe(false);
    expect(record.certified).toBe(false);
    expect(record.blocker).toMatch(/cannot compose a loopback proxy/);
    expect(record.canaries).toEqual([]);
  });
});

describe('posture-aware network certification', () => {
  test('an allow-posture boundary certifies for allow, never for model-only', async () => {
    const allow = await probeBackend(fakeAdapter('fs-only'), { network: 'allow' });
    expect(verdictOf(allow, 'network-loopback')).toBe('pass');
    expect(verdictOf(allow, 'read-escape-sibling')).toBe('pass');
    expect(verdictOf(allow, 'symlink-escape')).toBe('pass');
    expect(verdictOf(allow, 'nested-child-escape')).toBe('pass');
    expect(allow.certified).toBe(true);
    expect(allow.networkDemonstrated).toBe('allow');
    const modelOnly = await probeBackend(fakeAdapter('fs-only'), { network: 'model-only' });
    expect(verdictOf(modelOnly, 'network-loopback')).toBe('fail');
    expect(modelOnly.certified).toBe(false);
  });

  test('a proxy-composed boundary passes only the proxy port and only for model-only', async () => {
    const record = await probeBackend(fakeAdapter('proxy-fs-only'), {
      network: 'model-only',
      modelProxy: true,
    });
    expect(verdictOf(record, 'network-proxy')).toBe('pass');
    expect(record.certified).toBe(true);
    expect(record.networkDemonstrated).toBe('proxy-loopback');
    // The same boundary probed WITHOUT the proxy demand must refuse the
    // loopback connect (the fake only opens the declared proxy port).
    const strict = await probeBackend(fakeAdapter('proxy-fs-only'), { network: 'model-only' });
    expect(verdictOf(strict, 'network-loopback')).toBe('fail');
    expect(strict.certified).toBe(false);
  });
});

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
    await expect(
      launchCertified(fakeAdapter('fs-only'), forged, {
        workspace: '/tmp/ws',
        argv: ['/bin/true'],
        network: 'model-only',
      }),
    ).rejects.toThrow(/not produced by the RS-13 probe/);
  });

  test('launchCertified refuses a backend the probe did not certify', async () => {
    const certification = await certifyBackends({ adapters: [fakeAdapter('block-all')] });
    expect(certification.certified).toEqual([]);
    await expect(
      launchCertified(fakeAdapter('block-all'), certification, {
        workspace: '/tmp/ws',
        argv: ['/bin/true'],
        network: 'model-only',
      }),
    ).rejects.toThrow(/not certified for required mode.*fail-closed/s);
  });

  test('launchCertified executes inside a genuinely probe-certified backend', async () => {
    const certification = await certifyBackends({
      adapters: [fakeAdapter('fs-only')],
      network: 'allow',
    });
    expect(certification.certified).toEqual(['bwrap']);
    const launched = await launchCertified(fakeAdapter('fs-only'), certification, {
      workspace: '/tmp/ws',
      argv: ['/bin/true'],
      network: 'allow',
    });
    expect(launched.ok).toBe(true);
  });

  test('certification does not transfer across postures', async () => {
    const certification = await certifyBackends({
      adapters: [fakeAdapter('fs-only')],
      network: 'allow',
    });
    await expect(
      launchCertified(fakeAdapter('fs-only'), certification, {
        workspace: '/tmp/ws',
        argv: ['/bin/true'],
        network: 'model-only',
      }),
    ).rejects.toThrow(/certified under the 'allow' posture.*'model-only'/s);
  });

  test('a proxy-composed certification requires the proxy port on every launch', async () => {
    const certification = await certifyBackends({
      adapters: [fakeAdapter('proxy-fs-only')],
      network: 'model-only',
      modelProxy: true,
    });
    expect(certification.networkDemonstrated).toBe('proxy-loopback');
    await expect(
      launchCertified(fakeAdapter('proxy-fs-only'), certification, {
        workspace: '/tmp/ws',
        argv: ['/bin/true'],
        network: 'model-only',
      }),
    ).rejects.toThrow(/a proxyPort is required on every launch/);
    const launched = await launchCertified(fakeAdapter('proxy-fs-only'), certification, {
      workspace: '/tmp/ws',
      argv: ['/bin/true'],
      network: 'model-only',
      proxyPort: 45454,
    });
    expect(launched.ok).toBe(true);
  });

  test('a non-proxy certification refuses a launch that carries a proxy port', async () => {
    const certification = await certifyBackends({
      adapters: [fakeAdapter('fs-only')],
      network: 'allow',
    });
    await expect(
      launchCertified(fakeAdapter('fs-only'), certification, {
        workspace: '/tmp/ws',
        argv: ['/bin/true'],
        network: 'allow',
        proxyPort: 45454,
      }),
    ).rejects.toThrow(/proxyPort is not permitted/);
  });

  test('the certified list is exactly what the probe earned', async () => {
    const certification = await certifyBackends({ adapters: [fakeAdapter('grant-all')] });
    expect(certifiedBackendsOf(certification)).toEqual([]);
  });
});

describe.runIf(process.platform === 'darwin')('the real seatbelt certification', () => {
  test('the live canaries certify seatbelt under model-only posture', async () => {
    const certification = await certifyBackends({ adapters: [seatbeltAdapter()] });
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

  test('the live canaries certify seatbelt with proxy-composed model-only', async () => {
    const certification = await certifyBackends({
      adapters: [seatbeltAdapter()],
      network: 'model-only',
      modelProxy: true,
    });
    const record = certification.records.find((r) => r.backend === 'seatbelt');
    expect(record?.certified).toBe(true);
    expect(verdictOf(record, 'network-proxy')).toBe('pass');
    expect(certification.networkDemonstrated).toBe('proxy-loopback');
    // The certified receipt authorizes a real launch — through a proxy port —
    // which the narrow-allow profile permits to that one loopback port.
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-live-'));
    try {
      const launched = await launchCertified(adapter, certification, {
        workspace,
        argv: ['/bin/true'],
        network: 'model-only',
        proxyPort: 1,
      });
      expect(launched.ok).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);
});

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
