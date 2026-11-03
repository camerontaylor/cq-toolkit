// Split provenance: test/sandbox/backend.test.ts was split by subject into
// backend.seatbelt-profile.test.ts, backend.linux-container.test.ts (this
// file), backend.adapter-snapshot.test.ts, backend.adapter-selection.test.ts,
// backend.seatbelt-execute.test.ts, backend.availability.test.ts and
// backend.launcher-hardening.test.ts, with shared helpers in
// backend.helpers.ts.
import { describe, expect, test } from 'vitest';

import {
  containerAdapter,
  containerArgv,
  containerEnvFile,
  DEFAULT_SANDBOX_IMAGE,
  landlockAdapter,
} from '../../src/sandbox/backend.js';
import { bwrapArgv } from '../../experimental/sandbox-host/backend.js';

describe('linux and container boundary construction', () => {
  test('bwrap binds only runtime trees, masks volatile paths, binds ws last', () => {
    const argv = bwrapArgv('/tmp/cq-ws', 'model-only', { PATH: '/bin', HOME: '/home/u' }, [
      '/bin/sh',
      '-c',
      'echo',
    ]);
    // The host root is never bound (Sol audit, backend.ts:261): the only
    // unconditional read bind is /usr, the rest are -try.
    expect(argv.slice(0, 3)).toEqual(['bwrap', '--ro-bind', '/usr']);
    expect(argv.join(' ')).not.toContain('--ro-bind / /');
    // /usr/local lives UNDER /usr on Linux — it must be masked with an empty
    // tmpfs AFTER the /usr bind and BEFORE the workspace bind, so host files
    // created there after certification stay invisible (Sol final audit).
    expect(argv.join(' ')).toContain('--tmpfs /usr/local');
    expect(argv.indexOf('/usr/local')).toBeGreaterThan(argv.indexOf('--ro-bind'));
    expect(argv.indexOf('/usr/local')).toBeLessThan(argv.indexOf('--bind'));
    for (const tree of ['/bin', '/sbin', '/lib', '/lib64']) {
      const treeAt = argv.indexOf(tree);
      expect(treeAt).toBeGreaterThan(-1);
      expect(argv[treeAt - 1]).toBe('--ro-bind-try');
    }
    // Host /etc never enters the namespace (delta review): no bind of any kind.
    expect(argv).not.toContain('/etc');
    expect(argv.join(' ')).not.toContain('--ro-bind /etc');
    // /tmp and HOME are masked BEFORE the workspace bind, so a workspace
    // nested under either still shadows them.
    expect(argv.indexOf('--tmpfs')).toBeLessThan(argv.indexOf('--bind'));
    expect(argv.join(' ')).toContain('--tmpfs /tmp');
    expect(argv.join(' ')).toContain('--tmpfs /home/u');
    const bindAt = argv.indexOf('--bind');
    expect(argv.slice(bindAt, bindAt + 3)).toEqual(['--bind', '/tmp/cq-ws', '/tmp/cq-ws']);
    expect(argv).toContain('--unshare-net');
    expect(argv).toContain('--die-with-parent');
    expect(argv.indexOf('--unshare-pid')).toBeLessThan(argv.indexOf('--proc'));
    expect(argv).toContain('--unshare-pid');
    // The child inherits the launcher process env — env VALUES never appear
    // in argv, where any local user could read them.
    expect(argv).not.toContain('--clearenv');
    expect(argv).not.toContain('--setenv');
    expect(argv.join(' ')).not.toContain('PATH=');
    expect(argv[argv.length - 4]).toBe('--');
    expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', 'echo']);
  });

  test('bwrap keeps the network for an allow posture', () => {
    expect(bwrapArgv('/ws', 'allow', {}, ['/usr/bin/true'])).not.toContain('--unshare-net');
  });

  test('container drops all capabilities and runs as a fixed non-root UID', () => {
    const argv = containerArgv(
      { image: 'cq-sandbox:latest', allowUnpinnedImage: true },
      '/ws',
      'model-only',
      '/private/env/child.env',
      ['/usr/bin/true', '-x'],
    );
    expect(argv.slice(0, 2)).toEqual(['docker', 'run']);
    expect(argv.join(' ')).toContain('--network none');
    expect(argv).toContain('--read-only');
    // Part of the boundary, not optional hardening (Sol audit, backend.ts:344).
    expect(argv.join(' ')).toContain('--cap-drop ALL');
    const userAt = argv.indexOf('--user');
    expect(argv.slice(userAt, userAt + 2)).toEqual(['--user', '65532:65532']);
    expect(argv.join(' ')).toContain('--security-opt no-new-privileges');
    expect(argv.slice(argv.indexOf('--volume'), argv.indexOf('--volume') + 2)).toEqual([
      '--volume',
      '/ws:/ws',
    ]);
    // The child env rides in a private env file: no value lands in argv and
    // no per-name --env makes the CLI read the child env from its own.
    const envAt = argv.indexOf('--env-file');
    expect(argv.slice(envAt, envAt + 2)).toEqual(['--env-file', '/private/env/child.env']);
    expect(argv).not.toContain('--env');
    // argv[0] is the entrypoint (Codex P2): an image ENTRYPOINT can never
    // receive the request argv as its arguments instead of executing it.
    expect(argv.slice(-3)).toEqual(['--entrypoint=/usr/bin/true', 'cq-sandbox:latest', '-x']);
  });

  test('a container argv without a command head is refused', () => {
    for (const argv of [[], [''], ['-it']]) {
      expect(() =>
        containerArgv(
          { image: 'x', allowUnpinnedImage: true },
          '/ws',
          'model-only',
          '/private/env/child.env',
          argv,
        ),
      ).toThrow(/argv\[0\] must be a command/);
    }
  });

  test('the container env file round-trips names and values, refusing line breaks', () => {
    expect(containerEnvFile({})).toBe('');
    expect(containerEnvFile({ PATH: '/bin', KEEP: ' a=b c ' })).toBe('PATH=/bin\nKEEP= a=b c \n');
    for (const bad of ['a\nINJECTED=1', 'a\rb', 'a\0b']) {
      expect(containerEnvFile({ KEEP: bad })).toBeUndefined();
    }
  });

  test('an unprovisioned landlock backend names its blocker instead of passing', async () => {
    const adapter = landlockAdapter();
    const availability = await adapter.available();
    expect(availability.available).toBe(false);
    expect(availability.blocker).toMatch(/landlock helper/);
    const result = await adapter.launch({
      workspace: '/ws',
      argv: ['/usr/bin/true'],
      network: 'model-only',
    });
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/not provisioned/);
  });

  test('a container --user override naming root or a non-numeric identity is refused', () => {
    // Numeric ALIASES of zero are caught by parse, not string equality
    // (delta review): `00`, `000:1000` and `1000:00` are all root forms.
    for (const root of ['0', '0:0', '0:1000', '1000:0', '00', '000:1000', '1000:00']) {
      expect(() =>
        containerArgv(
          { image: 'x', allowUnpinnedImage: true, user: root },
          '/ws',
          'model-only',
          '/e',
          ['/usr/bin/true'],
        ),
      ).toThrow(/non-root/);
    }
    for (const malformed of ['root', '65532:root', '-1']) {
      expect(() =>
        containerArgv(
          { image: 'x', allowUnpinnedImage: true, user: malformed },
          '/ws',
          'model-only',
          '/e',
          ['/usr/bin/true'],
        ),
      ).toThrow(/numeric/);
    }
    // Any other fixed numeric identity is accepted verbatim.
    const argv = containerArgv(
      { image: 'x', allowUnpinnedImage: true, user: '1000:1000' },
      '/ws',
      'model-only',
      '/e',
      ['/usr/bin/true'],
    );
    const userAt = argv.indexOf('--user');
    expect(argv.slice(userAt, userAt + 2)).toEqual(['--user', '1000:1000']);
  });

  test('a container CLI that cannot reach a daemon reports the exact blocker', async () => {
    const adapter = containerAdapter({
      image: 'x',
      allowUnpinnedImage: true,
      command: '/nonexistent/cq-docker',
    });
    const availability = await adapter.available();
    expect(availability.available).toBe(false);
    expect(availability.blocker).toMatch(/daemon unreachable/);
  });
});

describe('default container image (Codex P2 on #244, owner ruling)', () => {
  test('the shipped default is the official node slim pinned by an index digest', () => {
    // The multi-arch INDEX digest: one immutable reference for linux/amd64
    // and linux/arm64, not a per-arch manifest digest.
    expect(DEFAULT_SANDBOX_IMAGE).toMatch(/^node:24-bookworm-slim@sha256:[a-f0-9]{64}$/);
  });

  test('an argv built without an image uses the default; an explicit override wins', () => {
    const defaultArgv = containerArgv({}, '/ws', 'model-only', '/private/env/child.env', [
      '/usr/bin/true',
    ]);
    expect(defaultArgv).toContain(DEFAULT_SANDBOX_IMAGE);
    const override = 'registry.example/cq-sandbox:v1@sha256:' + 'a'.repeat(64);
    const overridden = containerArgv(
      { image: override },
      '/ws',
      'model-only',
      '/private/env/child.env',
      ['/usr/bin/true'],
    );
    expect(overridden).toContain(override);
    expect(overridden).not.toContain(DEFAULT_SANDBOX_IMAGE);
  });

  test('an unpinned override is refused unless allowUnpinnedImage accepts it explicitly', () => {
    const argv: readonly string[] = ['/usr/bin/true'];
    for (const unpinned of ['cq-sandbox', 'cq-sandbox:latest', 'cq-sandbox@sha256:zz']) {
      expect(() => containerArgv({ image: unpinned }, '/ws', 'model-only', '/e', argv)).toThrow(
        /digest-pinned/,
      );
      expect(() =>
        containerArgv(
          { image: unpinned, allowUnpinnedImage: true },
          '/ws',
          'model-only',
          '/e',
          argv,
        ),
      ).not.toThrow();
    }
    // A reference that could ride as docker flags is refused even with the
    // escape hatch open: the image is a bare argv position, not a flag slot.
    for (const malformed of ['', '-p 80:80', 'a b', 'x\nEVIL=1', 'x\0y']) {
      expect(() =>
        containerArgv(
          { image: malformed, allowUnpinnedImage: true },
          '/ws',
          'model-only',
          '/e',
          argv,
        ),
      ).toThrow(/plain reference/);
    }
    expect(() =>
      containerArgv({ image: 'x@y@z', allowUnpinnedImage: true }, '/ws', 'model-only', '/e', argv),
    ).toThrow(/more than one '@'/);
  });
});
