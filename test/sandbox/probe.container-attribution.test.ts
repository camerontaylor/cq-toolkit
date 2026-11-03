// Split provenance: test/sandbox/probe.test.ts was split by subject into
// probe.{forgery,network-posture,required-mode,resolver,review-hardening,container-attribution}.test.ts
// plus probe.helpers.ts (shared fixtures). This file carries container
// exec-refusal attribution (crq delta review).
import { describe, expect, test, vi } from 'vitest';

import { probeBackend } from '../../experimental/sandbox-host/probe.js';
import type { SandboxBackendAdapter } from '../../src/sandbox/launcher.js';
import { fakeAdapter, result, seams, verdictOf } from './probe.helpers.js';

// Measured scheduling margin (final head, concurrent authorized testing):
// each probe runs its controls as REAL bare-host processes, and process
// spawn latency on the shared host reached ~9s per spawn at load ~104 on
// 6 cores — far past the 5s vitest default for control-heavy tests.  This
// file-scoped bound is test scheduling margin only; product launch and
// probe timeouts are untouched.
vi.setConfig({ testTimeout: 120_000 });

describe('container exec-refusal attribution (crq delta review)', () => {
  // A container-backed fake whose local-prefix exec fails the way the Docker
  // CLI relays an OCI runtime start failure; every other canary follows the
  // fs-only fake.  The earlier pattern required a word boundary right after a
  // colon, so no real Docker line could ever be attributed.
  const containerFake = (stderrFor: (target: string) => string): SandboxBackendAdapter => {
    const inner = fakeAdapter('fs-only');
    return {
      ...inner,
      backend: 'container',
      launch: (request) =>
        request.argv[0] === seams().localPrefixTarget
          ? Promise.resolve(result({ exitCode: 127, stderr: stderrFor(request.argv[0]) }))
          : inner.launch(request),
    };
  };

  test('a Docker-shaped OCI exec refusal naming the target is attributed', async () => {
    const record = await probeBackend(
      containerFake(
        (target) =>
          'Error response from daemon: failed to create task for container: failed to create shim task: ' +
          'OCI runtime create failed: runc create failed: unable to start container process: ' +
          `error during container init: exec: "${target}": stat ${target}: no such file or directory: unknown\n` +
          'Error: failed to start containers: 0000',
      ),
      { ...seams(), network: 'allow' },
    );
    expect(verdictOf(record, 'local-prefix-exec')).toBe('pass');
  });

  test('a Docker-shaped line naming a different target stays inconclusive', async () => {
    const record = await probeBackend(
      containerFake(
        () =>
          'Error response from daemon: OCI runtime create failed: unable to start container process: ' +
          'exec: "/usr/local/bin/other": permission denied: unknown',
      ),
      { ...seams(), network: 'allow' },
    );
    expect(verdictOf(record, 'local-prefix-exec')).toBe('inconclusive');
  });
});
