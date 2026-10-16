// Real macOS certification gaps. Network controls require an explicit live
// opt-in; CI without outbound access still runs the local containment canaries.
import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { seatbeltAdapter } from '../../experimental/sandbox-host/backend.js';

const execFile = promisify(execFileCb);
const adapter = seatbeltAdapter();
const scratch: string[] = [];
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(adapter.workspaceParent(), 'cq-seatbelt-live-'));
  scratch.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe.runIf(process.platform === 'darwin')('seatbelt live certification', () => {
  test.each([
    ['host-temp', tmpdir()],
    ['var-alias', '/var/tmp'],
    ['worktree', process.cwd()],
    ...(process.env['LIVE_SEATBELT_VOLUME']
      ? [['external-volume', process.env['LIVE_SEATBELT_VOLUME']]]
      : []),
  ])('canonical workspace control works under %s', async (_name, parent) => {
    const dir = await mkdtemp(join(parent!, 'cq-seatbelt-path-'));
    scratch.push(dir);
    const result = await adapter.launch({
      workspace: dir,
      argv: ['/bin/sh', '-c', 'echo path-control > proof && cat proof'],
      network: 'model-only',
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.stdout.trim()).toBe('path-control');
  });

  test('clipboard lookup is denied after a successful bare-host pbpaste control', async () => {
    await execFile('/usr/bin/pbpaste', [], { timeout: 5_000 });
    const result = await adapter.launch({
      workspace: await workspace(),
      argv: ['/usr/bin/pbpaste'],
      network: 'allow',
      timeoutMs: 5_000,
    });
    expect(result.spawnError).toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toMatch(/execvp.*failed/);
  });

  test('a setsid descendant cannot hold seatbelt launch settlement past its deadline', async () => {
    const dir = await workspace();
    const pidFile = join(dir, 'escaped.pid');
    // Wait for setsid and the PID record before the leader exits. Otherwise
    // the exit sweep could kill the descendant before it leaves the group.
    const script = `use POSIX; pipe(my $r, my $w) or die; if (fork) { close $w; <$r>; exit 0 } close $r; setsid() >= 0 or die; open my $f, '>', $ARGV[0] or die; print $f $$; close $f; close $w; sleep 120`;
    try {
      const result = await adapter.launch({
        workspace: dir,
        argv: ['/usr/bin/perl', '-e', script, pidFile],
        network: 'model-only',
        timeoutMs: 3_000,
      });
      expect(result.spawnError).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(Number(await readFile(pidFile, 'utf8'))).toBeGreaterThan(0);
    } finally {
      const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already reaped. */
        }
      }
    }
  }, 15_000);

  test.each(['exit', 'timeout'] as const)(
    'the %s sweep kills a seatbelt descendant in the process group',
    async (mode) => {
      const dir = await workspace();
      const pidFile = join(dir, 'descendant.pid');
      // The pipe makes the parent wait until the grandchild is running and its
      // PID is recorded. Both processes retain the launcher's process group.
      const script = `pipe(my $r, my $w) or die; if (fork) { close $w; <$r>; ${mode === 'exit' ? 'exit 0' : 'sleep 120'} } close $r; open my $f, '>', $ARGV[0] or die; print $f $$; close $f; close $w; sleep 120`;
      let pid = 0;
      try {
        const result = await adapter.launch({
          workspace: dir,
          argv: ['/usr/bin/perl', '-e', script, pidFile],
          network: 'model-only',
          timeoutMs: 3_000,
        });
        pid = Number(await readFile(pidFile, 'utf8'));
        expect(pid).toBeGreaterThan(0);
        expect(result.spawnError).toBeUndefined();
        expect(result.ok, JSON.stringify(result)).toBe(mode === 'exit');
        expect(result.timedOut).toBe(mode === 'timeout');
        const status = await execFile('/bin/ps', ['-p', String(pid), '-o', 'stat=']).catch(
          (error: unknown) => {
            const failure = error as { code?: number; stdout?: string };
            if (failure.code === 1 && !failure.stdout?.trim()) return { stdout: '' };
            throw error;
          },
        );
        // A killed orphan may briefly remain a zombie pending init's reap.
        expect(status.stdout.trim()).toMatch(/^$|^Z/);
      } finally {
        if (pid > 0) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* Already reaped. */
          }
        }
      }
    },
    15_000,
  );
});

describe.runIf(process.platform === 'darwin' && process.env['LIVE_SEATBELT_NETWORK'] === '1')(
  'seatbelt network live certification',
  () => {
    test('allow mode resolves DNS and completes HTTPS; model-only denies both', async () => {
      // An explicit public DNS server forces a real query, bypassing the host
      // resolver's cache. nscurl uses macOS's native HTTPS stack, so it needs
      // no read grant for curl's host OpenSSL configuration or certificate files.
      const dir = await workspace();
      const dns = ['/usr/bin/dig', '+short', '+time=2', '+tries=1', '@1.1.1.1', 'example.com', 'A'];
      const https = ['/usr/bin/nscurl', '--max-time', '10', '--include', 'https://example.com/'];
      const hostDns = await execFile(dns[0]!, dns.slice(1), { timeout: 15_000 });
      expect(hostDns.stdout).toMatch(/^\d+\.\d+\.\d+\.\d+$/m);
      const hostHttps = await execFile(https[0]!, https.slice(1), { timeout: 15_000 });
      expect(hostHttps.stdout).toContain('Example Domain');
      for (const network of ['allow', 'model-only'] as const) {
        const resolved = await adapter.launch({
          workspace: dir,
          argv: dns,
          network,
          timeoutMs: 15_000,
        });
        const fetched = await adapter.launch({
          workspace: dir,
          argv: https,
          network,
          timeoutMs: 15_000,
        });
        expect(resolved.spawnError).toBeUndefined();
        expect(fetched.spawnError).toBeUndefined();
        if (network === 'allow') {
          expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
          expect(resolved.stdout).toMatch(/^\d+\.\d+\.\d+\.\d+$/m);
          expect(fetched.ok, JSON.stringify(fetched)).toBe(true);
          expect(fetched.stdout).toContain('Example Domain');
        } else {
          expect(resolved.ok, JSON.stringify(resolved)).toBe(false);
          expect(resolved.timedOut).toBe(false);
          expect(resolved.stdout).not.toMatch(/^\d+\.\d+\.\d+\.\d+$/m);
          // nscurl exits zero even for URL-loading errors: body/error evidence,
          // rather than its exit code, decides whether the request succeeded.
          expect(fetched.stdout, JSON.stringify(fetched)).not.toContain('Example Domain');
          expect(fetched.timedOut).toBe(false);
          expect(fetched.stderr + fetched.stdout, JSON.stringify(fetched)).toMatch(
            /failed|error|not permitted|denied/i,
          );
        }
      }
    }, 90_000);
  },
);
