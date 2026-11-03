// Split provenance: test/sandbox/probe.test.ts was split by subject into
// probe.{forgery,network-posture,required-mode,resolver,review-hardening,container-attribution}.test.ts
// plus probe.helpers.ts (shared fixtures). This file carries the forgery
// invariant: neither a broken nor a promiscuous launcher can certify.
import { describe, expect, test, vi } from 'vitest';

import { probeBackend } from '../../experimental/sandbox-host/probe.js';
import { ALL_IDS, fakeAdapter, result, seams, verdictOf } from './probe.helpers.js';

// Measured scheduling margin (final head, concurrent authorized testing):
// each probe runs its controls as REAL bare-host processes, and process
// spawn latency on the shared host reached ~9s per spawn at load ~104 on
// 6 cores — far past the 5s vitest default for control-heavy tests.  This
// file-scoped bound is test scheduling margin only; product launch and
// probe timeouts are untouched.
vi.setConfig({ testTimeout: 120_000 });

describe('a probe can be forged by neither a broken nor a promiscuous launcher', () => {
  test('a launcher that blocks everything fails its control and stays uncertified', async () => {
    const record = await probeBackend(fakeAdapter('block-all'), seams());
    expect(record.runnable).toBe(false); // it claims availability but ran no child
    expect(verdictOf(record, 'workspace-control')).toBe('fail');
    expect(record.certified).toBe(false);
    expect(record.blocker).toMatch(/did not run a child in the workspace/);
  });

  test('a launcher that grants everything fails every denial canary', async () => {
    const record = await probeBackend(fakeAdapter('grant-all'), seams());
    for (const id of ALL_IDS) {
      expect(verdictOf(record, id)).toBe('fail');
    }
    if (process.platform === 'linux') expect(verdictOf(record, 'proc-link-escape')).toBe('fail');
    expect(verdictOf(record, 'network-loopback')).toBe('fail');
    expect(verdictOf(record, 'network-external')).toBe('fail');
    expect(record.certified).toBe(false);
    expect(record.blocker).toMatch(/read-escape/);
  });

  test('a canary binary absent from the boundary is inconclusive, never a denial', async () => {
    // bwrap on a host without FHS paths (NixOS without envfs): the host
    // control arms through PATH, but /bin/cat does not exist inside the
    // namespace, so bwrap exits 1 reporting ENOENT on the exec. That run never
    // reached the target; reading it as a denial would certify an unproven
    // boundary.
    const adapter = fakeAdapter('fs-only');
    const confined = adapter.launch;
    adapter.launch = (request) =>
      request.argv[0] === '/bin/cat'
        ? Promise.resolve(
            result({
              exitCode: 1,
              stderr: 'bwrap: execvp /bin/cat: No such file or directory',
            }),
          )
        : confined(request);
    const record = await probeBackend(adapter, seams());
    for (const id of ['read-escape', 'read-escape-sibling', 'symlink-escape', 'credential-file']) {
      expect(verdictOf(record, id)).toBe('inconclusive');
    }
    expect(record.canaries.find((c) => c.id === 'read-escape')?.detail).toMatch(
      /canary binary absent in the boundary/,
    );
    expect(record.certified).toBe(false);
  });

  test('a printenv canary absent from the boundary is inconclusive, never a pass', async () => {
    // Same shape as the /bin/cat case, on the credential-env branch: the
    // bare-host printenv control arms, the in-boundary binary is missing, and
    // bwrap exits 1 — the exit code this canary otherwise reads as "the secret
    // did not reach the child".
    const adapter = fakeAdapter('fs-only');
    const confined = adapter.launch;
    adapter.launch = (request) =>
      request.argv[0] === '/usr/bin/printenv'
        ? Promise.resolve(
            result({
              exitCode: 1,
              stderr: 'bwrap: execvp /usr/bin/printenv: No such file or directory',
            }),
          )
        : confined(request);
    const record = await probeBackend(adapter, seams());
    expect(verdictOf(record, 'credential-env')).toBe('inconclusive');
    expect(record.canaries.find((c) => c.id === 'credential-env')?.detail).toMatch(
      /printenv never ran/,
    );
    expect(record.certified).toBe(false);
  });

  test('a lowercase missing-canary diagnostic is inconclusive, never a pass', async () => {
    // Docker/OCI report the missing executable lowercase (the shape the
    // container suite models). With exit 1 the credential-env chain would
    // otherwise read "ran, secret scrubbed" — a certify of a boundary
    // printenv never entered — because executed() only excludes 126/127.
    const adapter = fakeAdapter('fs-only');
    const confined = adapter.launch;
    adapter.launch = (request) =>
      request.argv[0] === '/usr/bin/printenv'
        ? Promise.resolve(
            result({
              exitCode: 1,
              stderr: 'bwrap: execvp /usr/bin/printenv: no such file or directory',
            }),
          )
        : confined(request);
    const record = await probeBackend(adapter, seams());
    expect(verdictOf(record, 'credential-env')).toBe('inconclusive');
    expect(record.canaries.find((c) => c.id === 'credential-env')?.detail).toMatch(
      /printenv never ran/,
    );
    expect(record.certified).toBe(false);
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
      const record = await probeBackend(adapter, {
        ...seams(),
        network: 'allow',
      });
      expect(verdictOf(record, 'workspace-control')).toBe('pass');
      expect(verdictOf(record, 'read-escape')).toBe('pass');
      expect(verdictOf(record, 'read-escape-sibling')).toBe('pass');
      expect(verdictOf(record, 'proc-link-escape')).toBe('fail');
      expect(record.certified).toBe(false);
      expect(record.blocker).toMatch(/proc-link-escape fail/);
    },
  );

  test('an inconclusive canary refuses certification — doubt fails closed', async () => {
    const record = await probeBackend(fakeAdapter('env-fails'), seams());
    expect(verdictOf(record, 'credential-env')).toBe('inconclusive');
    expect(record.certified).toBe(false);
    expect(record.blocker).toMatch(/inconclusive/);
  });

  test('a backend that cannot run records its exact environmental blocker', async () => {
    const record = await probeBackend({
      backend: 'container',
      workspaceParent: () => '/tmp',
      available: async () => ({
        available: false,
        blocker: 'docker daemon unreachable',
      }),
      launch: async () => result({}),
    });
    expect(record.runnable).toBe(false);
    expect(record.certified).toBe(false);
    expect(record.blocker).toBe('docker daemon unreachable');
    expect(record.canaries).toEqual([]);
  });

  test('a proxy-composed posture is uncertifiable for a backend without composition', async () => {
    const record = await probeBackend(fakeAdapter('fs-only'), {
      ...seams(),
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
    const record = await probeBackend(fakeAdapter('broken-bash'), seams());
    expect(verdictOf(record, 'workspace-control')).toBe('pass');
    expect(verdictOf(record, 'nested-child-escape')).toBe('inconclusive');
    expect(verdictOf(record, 'network-loopback')).toBe('inconclusive');
    expect(verdictOf(record, 'network-external')).toBe('inconclusive');
    expect(record.certified).toBe(false);
    expect(record.blocker).toMatch(/inconclusive/);
  });
});
