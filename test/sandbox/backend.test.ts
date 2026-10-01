// The RS-13 backend adapters (B14): boundary construction is data (assertable
// on any host), while boundary ENFORCEMENT is only claimed where it can
// actually execute (the darwin seatbelt legs skip elsewhere — certification
// evidence comes from probe.ts, never from these builders alone).
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  adaptersForPlatform,
  bwrapAdapter,
  bwrapArgv,
  containerAdapter,
  containerArgv,
  landlockAdapter,
  seatbeltAdapter,
  seatbeltProfile,
} from '../../src/sandbox/backend.js';

describe('seatbelt boundary construction', () => {
  test('the profile is deny-default with the bsd.sb startup closure', () => {
    const profile = seatbeltProfile('model-only');
    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(import "bsd.sb")');
  });

  test('model-only denies all network operations; allow does not', () => {
    expect(seatbeltProfile('model-only')).toContain('(deny network*)');
    expect(seatbeltProfile('allow')).not.toContain('(deny network*)');
  });

  test('the workspace arrives as the WS parameter, never as profile text', () => {
    const profile = seatbeltProfile('model-only');
    expect(profile).toContain('(allow file-read* file-write* (subpath (param "WS")))');
    for (const zone of ['/Users', '/Volumes', '/private/tmp', '/private/var/folders']) {
      expect(profile).toContain(`(deny file-read* (subpath "${zone}")`);
    }
    // A hostile workspace path cannot rewrite the profile: no caller-supplied
    // path is interpolated into profile text at all.
    expect(profile).not.toMatch(/\/private\/var\/tmp|cq-ws/);
  });
});

describe('linux and container boundary construction', () => {
  test('bwrap binds the root read-only, masks volatile paths, binds ws last', () => {
    const argv = bwrapArgv('/tmp/cq-ws', 'model-only', { PATH: '/bin', HOME: '/home/u' }, [
      '/bin/sh',
      '-c',
      'echo',
    ]);
    expect(argv.slice(0, 5)).toEqual(['bwrap', '--ro-bind', '/', '/', '--dev']);
    // /tmp and HOME are masked BEFORE the workspace bind, so a workspace
    // nested under either still shadows them.
    expect(argv.indexOf('--tmpfs')).toBeLessThan(argv.indexOf('--bind'));
    expect(argv).toContain('--tmpfs');
    expect(argv.join(' ')).toContain('--tmpfs /tmp');
    expect(argv.join(' ')).toContain('--tmpfs /home/u');
    const bindAt = argv.indexOf('--bind');
    expect(argv.slice(bindAt, bindAt + 3)).toEqual(['--bind', '/tmp/cq-ws', '/tmp/cq-ws']);
    expect(argv).toContain('--unshare-net');
    expect(argv).toContain('--clearenv');
    expect(argv).toContain('--die-with-parent');
    expect(argv.slice(argv.indexOf('--setenv'), argv.indexOf('--setenv') + 3)).toEqual([
      '--setenv',
      'PATH',
      '/bin',
    ]);
    expect(argv[argv.length - 4]).toBe('--');
    expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', 'echo']);
  });

  test('bwrap keeps the network for an allow posture', () => {
    expect(bwrapArgv('/ws', 'allow', {}, ['/bin/true'])).not.toContain('--unshare-net');
  });

  test('container runs no-network, read-only, no-new-privileges, workspace-mounted', () => {
    const argv = containerArgv({ image: 'cq-sandbox:latest' }, '/ws', 'model-only', {}, [
      '/bin/true',
    ]);
    expect(argv.slice(0, 2)).toEqual(['docker', 'run']);
    expect(argv.join(' ')).toContain('--network none');
    expect(argv).toContain('--read-only');
    expect(argv.join(' ')).toContain('--security-opt no-new-privileges');
    expect(argv.slice(argv.indexOf('--volume'), argv.indexOf('--volume') + 2)).toEqual([
      '--volume',
      '/ws:/ws',
    ]);
    expect(argv[argv.length - 2]).toBe('cq-sandbox:latest');
    expect(argv[argv.length - 1]).toBe('/bin/true');
  });

  test('an unprovisioned landlock backend names its blocker instead of passing', async () => {
    const adapter = landlockAdapter();
    const availability = await adapter.available();
    expect(availability.available).toBe(false);
    expect(availability.blocker).toMatch(/landlock helper/);
    const result = await adapter.launch({
      workspace: '/ws',
      argv: ['/bin/true'],
      network: 'model-only',
    });
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/not provisioned/);
  });

  test('a container CLI that cannot reach a daemon reports the exact blocker', async () => {
    const adapter = containerAdapter({ image: 'x', command: '/nonexistent/cq-docker' });
    const availability = await adapter.available();
    expect(availability.available).toBe(false);
    expect(availability.blocker).toMatch(/daemon unreachable/);
  });
});

describe('adapter selection per platform', () => {
  test('darwin auto order is seatbelt then container; linux adds landlock/bwrap', () => {
    expect(adaptersForPlatform('darwin').map((a) => a.backend)).toEqual(['seatbelt', 'container']);
    expect(adaptersForPlatform('linux').map((a) => a.backend)).toEqual([
      'landlock',
      'bwrap',
      'container',
    ]);
    expect(adaptersForPlatform('win32')).toEqual([]);
  });
});

describe.runIf(process.platform === 'darwin')('seatbelt executes inside the boundary', () => {
  const scratch: string[] = [];
  afterEach(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test('a child reads and writes the workspace and the profile is on disk', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-test-'));
    scratch.push(workspace);
    const result = await adapter.launch({
      workspace,
      argv: ['/bin/sh', '-c', 'echo in-boundary > proof.txt && cat proof.txt'],
      network: 'model-only',
    });
    expect(result.spawnError).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('in-boundary');
    const profile = await readFile(join(workspace, '.cq-seatbelt.sb'), 'utf8');
    expect(profile).toContain('(deny default)');
  });

  test('the launcher env scrub reaches the confined child, and TMPDIR moves inside', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-test-'));
    scratch.push(workspace);
    const result = await adapter.launch({
      workspace,
      argv: ['/usr/bin/env'],
      parentEnv: { ...process.env, CQ_PROBE_TEST_SECRET: 'leak-me-not' },
      envPassthrough: [],
      network: 'model-only',
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).not.toContain('leak-me-not');
    expect(result.stdout).toContain(`TMPDIR=${join(workspace, '.tmp')}`);
  }, 30_000);

  test('the confined child cannot read a real file outside the workspace', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-test-'));
    scratch.push(workspace);
    const outside = await mkdtemp(join(tmpdir(), 'cq-sbx-outside-'));
    scratch.push(outside);
    const outsidePath = join(outside, 'secret.txt');
    await writeFile(outsidePath, 'outside-secret-value');
    const result = await adapter.launch({
      workspace,
      argv: ['/bin/cat', outsidePath],
      network: 'model-only',
    });
    expect(result.ok).toBe(false);
    expect(result.stdout).not.toContain('outside-secret-value');
  }, 30_000);
});

describe.runIf(process.platform !== 'darwin')('seatbelt is darwin-only', () => {
  test('the adapter names the platform blocker', async () => {
    const availability = await seatbeltAdapter().available();
    expect(availability.available).toBe(false);
    expect(availability.blocker).toMatch(/darwin/);
  });
});

describe('a bubblewrap adapter can at least name its own availability', () => {
  test('availability returns a verdict, with a blocker when absent', async () => {
    const availability = await bwrapAdapter().available();
    expect(typeof availability.available).toBe('boolean');
    if (!availability.available) expect(availability.blocker).toMatch(/bubblewrap/);
  });
});
