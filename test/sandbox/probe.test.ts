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
 * A fake whose verdicts follow one of six behaviors, keyed by what the
 * canaries ask the child to do:
 *   grant-all    — every child succeeds (a boundary that does not bound);
 *   block-all    — no child ever runs (a broken launcher, not confinement);
 *   env-fails    — children run except the env probe (an inconclusive canary);
 *   fs-only      — filesystem denials hold but the child may connect (an
 *                  `allow`-posture boundary, wrong for model-only);
 *   proxy-fs-only— fs denials hold and ONLY the declared proxy port passes —
 *                  the proxy-composed model-only boundary;
 *   broken-bash  — fs denials hold but bash cannot exec in-boundary, so
 *                  every bash -c canary must go INCONCLUSIVE, not "denied".
 */
function fakeAdapter(
  behavior: 'grant-all' | 'block-all' | 'env-fails' | 'fs-only' | 'proxy-fs-only' | 'broken-bash',
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
      if (behavior === 'broken-bash' && request.argv[0] === '/bin/bash') {
        return Promise.resolve(result({ spawnError: 'fake bash cannot exec inside the boundary' }));
      }
      const argText = request.argv.join(' ');
      const portMatch = argText.match(/dev\/tcp\/([^/]+)\/(\d+)/);
      const inWorkspace = request.argv[1]?.startsWith(request.workspace) === true;
      if (request.argv[0] === '/bin/bash') {
        if (behavior === 'grant-all') return Promise.resolve(result({ ok: true, exitCode: 0 }));
        // A plain in-boundary exec (the probe's shell control) works for every
        // behavior that executes children at all.
        const plainExec = argText.includes('/bin/true');
        // fs-only: any connect passes.  proxy-fs-only: only the declared
        // proxy loopback port passes — non-proxy ports and external hosts are
        // denied even when a proxyPort was granted.
        const allowed =
          behavior === 'fs-only' ||
          (behavior === 'env-fails' && plainExec) ||
          (behavior === 'proxy-fs-only' &&
            (plainExec ||
              (portMatch !== null &&
                portMatch[1] === '127.0.0.1' &&
                Number(portMatch[2]) === request.proxyPort)));
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
  'local-prefix-exec',
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
      if (id === 'local-prefix-exec') {
        // Host-dependent: armed (and failed) wherever /usr/local has content;
        // an empty local prefix records the explicit n/a pass.
        expect(['fail', 'pass']).toContain(verdictOf(record, id));
        continue;
      }
      expect(verdictOf(record, id)).toBe('fail');
    }
    if (process.platform === 'linux') expect(verdictOf(record, 'proc-link-escape')).toBe('fail');
    expect(verdictOf(record, 'network-loopback')).toBe('fail');
    expect(verdictOf(record, 'network-external')).toBe('fail');
    expect(record.certified).toBe(false);
    expect(record.blocker).toMatch(/read-escape/);
  });

  test.runIf(process.platform === 'linux')(
    'a proc-link leak fails despite ordinary filesystem denials',
    async () => {
      const adapter = fakeAdapter('fs-only');
      const confined = adapter.launch;
      adapter.launch = (request) =>
        request.argv[1]?.startsWith('/proc/')
          ? Promise.resolve(result({ ok: true, exitCode: 0 }))
          : confined(request);
      const record = await probeBackend(adapter, { network: 'allow' });
      expect(verdictOf(record, 'workspace-control')).toBe('pass');
      expect(verdictOf(record, 'read-escape')).toBe('pass');
      expect(verdictOf(record, 'read-escape-sibling')).toBe('pass');
      expect(verdictOf(record, 'proc-link-escape')).toBe('fail');
      expect(record.certified).toBe(false);
      expect(record.blocker).toMatch(/proc-link-escape fail/);
    },
  );

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

  test('a launcher whose bash cannot exec yields INCONCLUSIVE shell canaries, not denials', async () => {
    // Non-vacuity (Sol review): the workspace control passes without bash, so
    // a naive probe could read every bash -c refusal as a boundary.  With the
    // in-boundary shell control failed, the shell-dependent canaries must be
    // inconclusive and nothing certifies.
    const record = await probeBackend(fakeAdapter('broken-bash'));
    expect(verdictOf(record, 'workspace-control')).toBe('pass');
    expect(verdictOf(record, 'nested-child-escape')).toBe('inconclusive');
    expect(verdictOf(record, 'network-loopback')).toBe('inconclusive');
    expect(verdictOf(record, 'network-external')).toBe('inconclusive');
    expect(record.certified).toBe(false);
    expect(record.blocker).toMatch(/inconclusive/);
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

  test('a passing proxy stand-in remains diagnostic and cannot certify a production endpoint', async () => {
    const record = await probeBackend(fakeAdapter('proxy-fs-only'), {
      network: 'model-only',
      modelProxy: true,
    });
    expect(verdictOf(record, 'network-proxy')).toBe('pass');
    expect(record.certified).toBe(false);
    expect(record.blocker).toMatch(/production endpoint identity or upstream allowlist/);
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
    // A forged object yields nothing to the resolver bridge either.
    expect(certifiedBackendsOf(forged)).toEqual([]);
    await expect(
      launchCertified(fakeAdapter('fs-only'), forged, {
        workspace: '/tmp/ws',
        argv: ['/bin/true'],
        network: 'model-only',
      }),
    ).rejects.toThrow(/not produced by the RS-13 probe/);
  });

  test('launchCertified refuses a backend the probe did not certify', async () => {
    const adapter = fakeAdapter('block-all');
    const certification = await certifyBackends({ adapters: [adapter] });
    expect(certification.certified).toEqual([]);
    await expect(
      launchCertified(adapter, certification, {
        workspace: '/tmp/ws',
        argv: ['/bin/true'],
        network: 'model-only',
      }),
    ).rejects.toThrow(/not certified for required mode.*fail-closed/s);
  });

  test('a different launcher instance sharing the backend name inherits nothing', async () => {
    const certified = fakeAdapter('fs-only');
    const certification = await certifyBackends({
      adapters: [certified],
      network: 'allow',
    });
    expect(certification.certified).toEqual(['bwrap']);
    const impostor = fakeAdapter('grant-all'); // same backend string, new object
    await expect(
      launchCertified(impostor, certification, {
        workspace: '/tmp/ws',
        argv: ['/bin/true'],
        network: 'allow',
      }),
    ).rejects.toThrow(/launcher object was not probed by this certification/);
  });

  test('mutating the caller-visible fields cannot widen a launch or the handoff', async () => {
    const adapter = fakeAdapter('fs-only');
    const certification = await certifyBackends({
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
        argv: ['/bin/true'],
        network: 'model-only',
      }),
    ).rejects.toThrow(/certified under the 'allow' posture/);
    // The handoff still yields exactly what the probe earned.
    expect(certifiedBackendsOf(certification)).toEqual(['bwrap']);
    const launched = await launchCertified(adapter, certification, {
      workspace: '/tmp/ws',
      argv: ['/bin/true'],
      network: 'allow',
    });
    expect(launched.ok).toBe(true);
  });

  test('a launch method swapped in after certification is refused', async () => {
    const adapter = fakeAdapter('fs-only');
    const certification = await certifyBackends({
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
      argv: ['/bin/true'],
      network: 'allow',
    });
    expect(launched.ok).toBe(true);
  });

  test('launchCertified executes inside a genuinely probe-certified backend', async () => {
    const adapter = fakeAdapter('fs-only');
    const certification = await certifyBackends({
      adapters: [adapter],
      network: 'allow',
    });
    expect(certification.certified).toEqual(['bwrap']);
    const launched = await launchCertified(adapter, certification, {
      workspace: '/tmp/ws',
      argv: ['/bin/true'],
      network: 'allow',
    });
    expect(launched.ok).toBe(true);
  });

  test('certification does not transfer across postures', async () => {
    const adapter = fakeAdapter('fs-only');
    const certification = await certifyBackends({
      adapters: [adapter],
      network: 'allow',
    });
    await expect(
      launchCertified(adapter, certification, {
        workspace: '/tmp/ws',
        argv: ['/bin/true'],
        network: 'model-only',
      }),
    ).rejects.toThrow(/certified under the 'allow' posture.*'model-only'/s);
  });

  test('a proxy stand-in authorizes neither an arbitrary port nor a launch without a port', async () => {
    const adapter = fakeAdapter('proxy-fs-only');
    const certification = await certifyBackends({
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
          argv: ['/bin/true'],
          network: 'model-only',
          ...(proxyPort === undefined ? {} : { proxyPort }),
        }),
      ).rejects.toThrow(/not certified.*production endpoint identity or upstream allowlist/s);
    }
  });

  test('a non-proxy certification refuses a launch that carries a proxy port', async () => {
    const adapter = fakeAdapter('fs-only');
    const certification = await certifyBackends({
      adapters: [adapter],
      network: 'allow',
    });
    await expect(
      launchCertified(adapter, certification, {
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

  test('live proxy stand-in observations do not certify a production proxy', async () => {
    const adapter = seatbeltAdapter();
    const certification = await certifyBackends({
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
        argv: ['/bin/true'],
        network: 'model-only',
        proxyPort: 1,
      }),
    ).rejects.toThrow(/not certified for required mode/);
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
