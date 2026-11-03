// Split provenance: test/sandbox/backend.test.ts was split by subject into
// backend.seatbelt-profile.test.ts, backend.linux-container.test.ts,
// backend.adapter-snapshot.test.ts, backend.adapter-selection.test.ts,
// backend.seatbelt-execute.test.ts, backend.availability.test.ts and
// backend.launcher-hardening.test.ts (this file), with shared helpers in
// backend.helpers.ts. The `hostPerl` lookup is now the shared helper
// `hostPerl()`; its body and rationale comment are unchanged.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { landlockAdapter } from '../../src/sandbox/backend.js';
import { pathInsideWorkspace } from '../../src/sandbox/launcher.js';
import { hostPerl } from './backend.helpers.js';

describe('launcher hardening (PR review)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-sbx-harden-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('workspace containment respects path-segment boundaries', async () => {
    const workspace = join(dir, 'workspace');
    const dotPrefixedName = join(workspace, '..allowed');
    const sibling = join(dir, 'outside');
    await mkdir(workspace);
    await writeFile(dotPrefixedName, 'inside');
    await writeFile(sibling, 'outside');

    expect(pathInsideWorkspace(dotPrefixedName, workspace)).toBe(true);
    expect(pathInsideWorkspace(dir, workspace)).toBe(false);
    expect(pathInsideWorkspace(sibling, workspace)).toBe(false);
  });

  test('a launcher inside the workspace is refused, and loader hooks never reach it', async () => {
    const helper = join(dir, 'helper');
    await writeFile(helper, '#!/bin/sh\nenv\n', { mode: 0o755 });
    const inside = await landlockAdapter({ helperPath: helper }).launch({
      workspace: dir,
      argv: ['/usr/bin/true'],
      network: 'model-only',
    });
    expect(inside.ok).toBe(false);
    expect(inside.spawnError).toMatch(/inside the model-writable workspace/);

    const outsideDir = await mkdtemp(join(tmpdir(), 'cq-sbx-harden-out-'));
    try {
      const outside = join(outsideDir, 'helper');
      await writeFile(outside, '#!/bin/sh\nenv\n', { mode: 0o755 });
      const ran = await landlockAdapter({ helperPath: outside }).launch({
        workspace: dir,
        argv: ['/usr/bin/true'],
        network: 'model-only',
        parentEnv: { PATH: '/usr/bin:/bin', LD_PRELOAD: '/evil.so', KEEP: 'yes' },
        envPassthrough: ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'KEEP'],
      });
      expect(ran.ok).toBe(true);
      expect(ran.stdout).toContain('KEEP=yes');
      expect(ran.stdout).not.toMatch(/LD_PRELOAD|DYLD_/);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test('a descendant that escapes the group cannot hold the launch past its deadline', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'cq-sbx-harden-out-'));
    const pidFile = join(outsideDir, 'escaped.pid');
    try {
      const helper = join(outsideDir, 'helper');
      await writeFile(
        helper,
        '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
        {
          mode: 0o755,
        },
      );
      // The direct child exits 0 as soon as its grandchild has called
      // setsid() — leaving the swept process group — and the grandchild
      // keeps the stdio pipes open. The gate pipe orders the two: exiting
      // before setsid() let the exit-time group sweep kill the grandchild
      // first on a loaded runner, so nothing escaped (macos-venue).
      const started = Date.now();
      const result = await landlockAdapter({ helperPath: helper }).launch({
        workspace: dir,
        argv: [
          hostPerl(),
          '-e',
          `use POSIX; pipe(my $r, my $w) or die; if (fork) { close $w; <$r>; exit 0 } close $r; setsid(); open my $f, '>', '${pidFile}'; print $f $$; close $f; close $w; sleep 120`,
        ],
        network: 'model-only',
        timeoutMs: 3_000,
      });
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(60_000);
    } finally {
      const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      await rm(outsideDir, { recursive: true, force: true });
    }
    // Scheduling margin only, as for the snapshot tests above.
  }, 90_000);

  test('landlock refuses a proxyPort it cannot compose', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'cq-sbx-harden-out-'));
    try {
      const helper = join(outsideDir, 'helper');
      await writeFile(helper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const result = await landlockAdapter({ helperPath: helper }).launch({
        workspace: dir,
        argv: ['/usr/bin/true'],
        network: 'model-only',
        proxyPort: 8080,
      });
      expect(result.ok).toBe(false);
      expect(result.spawnError).toMatch(/proxyPort is unsupported/);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
