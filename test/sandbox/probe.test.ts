// The RS-13 certification probe (B14).  The invariants that make the
// certification unforgeable are tested with fakes on every host:
//   - a launcher that blocks EVERYTHING fails its workspace control and is
//     never certified (broken is not confined);
//   - a launcher that grants EVERYTHING fails its denial canaries and is
//     never certified (granted is not a boundary);
//   - an inconclusive canary (its control could not fire) refuses
//     certification — doubt fails closed;
//   - `launchCertified` refuses a backend the probe never certified.
// The real seatbelt certification runs only where seatbelt runs; everywhere
// else the same probe records the platform blocker instead.
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

/**
 * A fake whose verdicts follow one of three behaviors, keyed by what the
 * canaries ask the child to do:
 *   grant-all — every child succeeds (a boundary that does not bound);
 *   block-all — no child ever runs (a broken launcher, not confinement);
 *   env-fails — children run except the env probe (an inconclusive canary).
 */
function fakeAdapter(behavior: 'grant-all' | 'block-all' | 'env-fails'): SandboxBackendAdapter {
  return {
    backend: 'bwrap',
    workspaceParent: () => '/tmp',
    available: async () => ({ available: true }),
    launch: (request) => {
      if (behavior === 'block-all') {
        return Promise.resolve(result({ spawnError: 'fake launcher refuses everything' }));
      }
      if (behavior === 'env-fails' && request.argv[0] === '/usr/bin/env') {
        return Promise.resolve(result({ exitCode: 7 }));
      }
      return Promise.resolve(
        result({
          ok: true,
          exitCode: 0,
          stdout:
            request.argv[0] === '/usr/bin/env'
              ? Object.entries(request.parentEnv ?? {})
                  .map(([name, value]) => `${name}=${value}`)
                  .join('\n')
              : '',
        }),
      );
    },
  };
}

const verdictOf = (record: BackendProbeRecord, id: string) =>
  record.canaries.find((canary) => canary.id === id)?.verdict;

describe('a probe can be forged by neither a broken nor a promiscuous launcher', () => {
  test('a launcher that blocks everything fails its control and stays uncertified', async () => {
    const record = await probeBackend(fakeAdapter('block-all'));
    expect(record.runnable).toBe(true); // it claims availability…
    expect(verdictOf(record, 'workspace-control')).toBe('fail');
    expect(record.certified).toBe(false);
    expect(record.blocker).toMatch(/did not run a child in the workspace/);
  });

  test('a launcher that grants everything fails every denial canary', async () => {
    const record = await probeBackend(fakeAdapter('grant-all'));
    expect(verdictOf(record, 'read-escape')).toBe('fail');
    expect(verdictOf(record, 'write-escape')).toBe('fail');
    expect(verdictOf(record, 'credential-env')).toBe('fail');
    expect(verdictOf(record, 'credential-file')).toBe('fail');
    expect(verdictOf(record, 'network-loopback')).toBe('fail');
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
});

describe('required-mode execution is bounded by the certification', () => {
  test('launchCertified throws for a backend the probe did not certify', async () => {
    const certification = await certifyBackends({
      adapters: [fakeAdapter('block-all')],
    });
    expect(certification.certified).toEqual([]);
    await expect(
      launchCertified(fakeAdapter('block-all'), certification, {
        workspace: '/tmp/ws',
        argv: ['/bin/true'],
        network: 'model-only',
      }),
    ).rejects.toThrow(/not certified for required mode.*fail-closed/s);
  });

  test('launchCertified executes inside a certified backend', async () => {
    const adapter = fakeAdapter('grant-all');
    const certification = {
      platform: 'linux' as NodeJS.Platform,
      probedAt: new Date().toISOString(),
      network: 'model-only' as const,
      records: [],
      certified: ['bwrap'] as const,
    };
    const launched = await launchCertified(adapter, certification, {
      workspace: '/tmp/ws',
      argv: ['/bin/true'],
      network: 'model-only',
    });
    expect(launched.ok).toBe(true);
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
      'workspace-control',
      'read-escape',
      'write-escape',
      'credential-env',
      'credential-file',
      'network-loopback',
    ] as const) {
      expect(passed.has(id)).toBe(true);
    }
    expect(certifiedBackendsOf(certification)).toEqual(['seatbelt']);
  }, 120_000);
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
        records: [],
        certified: [],
      }),
    });
    expect(config.selectedBackend).toBeUndefined();
    expect(config.runTool).toBe('withheld');
  });
});
