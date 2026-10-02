// The RS-13 backend adapters (B14): boundary construction is data (assertable
// on any host), while boundary ENFORCEMENT is only claimed where it can
// actually execute (the darwin seatbelt legs skip elsewhere — certification
// evidence comes from probe.ts, never from these builders alone).  LIVE
// STATUS of the narrow-allow seatbelt profile is recorded in backend.ts: it
// replaces the audit-rejected broad-root read and has not yet executed on
// any host; live evidence at final head is a gate of the fresh protocol.
import { mkdtemp, readdir, rm, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  adaptersForPlatform,
  bwrapAdapter,
  bwrapArgv,
  containerAdapter,
  containerArgv,
  landlockAdapter,
  seatbeltAdapter,
  seatbeltProfile,
  type ContainerAdapterOptions,
  type LandlockAdapterOptions,
} from '../../src/sandbox/backend.js';

describe('seatbelt boundary construction', () => {
  test('the profile is deny-default with the bsd.sb startup closure', () => {
    const profile = seatbeltProfile('model-only');
    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(import "bsd.sb")');
  });

  test('reads use a narrow runtime allowlist — never a whole-volume grant', () => {
    const profile = seatbeltProfile('model-only');
    // The audit-rejected broad allow must be gone: no (subpath "/").
    expect(profile).not.toMatch(/\(subpath "\/"\)/);
    for (const runtime of [
      '"/bin"',
      '"/sbin"',
      '"/usr/bin"',
      '"/usr/lib"',
      '"/System"',
      '"/private/var/db/dyld"',
    ]) {
      expect(profile).toContain(`(subpath ${runtime})`);
    }
    // The delta review's local-prefix and /etc surfaces are NOT readable:
    // /usr/local/* and /private/etc are absent from the allowlist entirely.
    expect(profile).not.toContain('/usr/local');
    expect(profile).not.toContain('/private/etc');
    expect(profile).not.toContain('"/Users"');
    expect(profile).not.toContain('"/Volumes"');
    expect(profile).not.toContain('"/private/var/folders"');
  });

  test('process execution is narrowed to the accepted P7 trial trees', () => {
    const profile = seatbeltProfile('model-only');
    // The accepted P7 shape — no unrestricted exec, no /usr/local/bin (e.g.
    // /usr/local/bin/docker stays denied); the probe's local-prefix-exec
    // canary attacks exactly this surface live.
    expect(profile).toContain(
      '(allow process-exec* (subpath "/usr/bin") (subpath "/bin") (subpath "/sbin") (subpath "/usr/libexec"))',
    );
    expect(profile).not.toMatch(/\(allow process-exec\*\)/);
    expect(profile).not.toContain('/usr/local');
  });

  test('the workspace arrives as the WS parameter, never as profile text', () => {
    const profile = seatbeltProfile('model-only');
    expect(profile).toContain('(allow file-read* file-write* (subpath (param "WS")))');
    // A hostile workspace path cannot rewrite the profile: no caller-supplied
    // path is interpolated into profile text at all.
    expect(profile).not.toMatch(/\/private\/var\/tmp|cq-ws/);
  });

  test('model-only is deny-all by default; allow grants network', () => {
    expect(seatbeltProfile('model-only')).not.toContain('network-outbound');
    expect(seatbeltProfile('model-only')).not.toContain('(allow network*)');
    expect(seatbeltProfile('allow')).toContain('(allow network*)');
  });

  test('a proxy-composed model-only permits exactly the proxy loopback port', () => {
    const profile = seatbeltProfile('model-only', 9053);
    // `localhost`, not a numeric address: SBPL rejects the latter ("host must
    // be * or localhost in network address" — first live execution, final head).
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:9053"))');
    // No other egress rule may appear: one port, nothing else.
    expect(profile.match(/network-outbound/g)).toHaveLength(1);
    expect(profile).not.toContain('(allow network*)');
    // And without a proxy there is no port rule at all.
    expect(seatbeltProfile('model-only')).not.toContain('network-outbound');
  });

  test('a runtime proxyPort outside an integer 1-65535 is refused before any policy is built', () => {
    // TypeScript's `number` is not a runtime guard (Sol exact-head audit):
    // a string through an untyped boundary must not reach the SBPL text.
    for (const bad of [
      '45454',
      '45454)) (allow network*',
      0,
      -1,
      70000,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() => seatbeltProfile('model-only', bad as unknown as number)).toThrow(
        /proxyPort must be an integer/,
      );
    }
  });
});

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
      { image: 'cq-sandbox:latest' },
      '/ws',
      'model-only',
      { PATH: '/bin' },
      ['/usr/bin/true'],
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
    // --env NAME without a value: the CLI reads the scrubbed launcher env, so
    // no secret value lands in argv.
    const envAt = argv.indexOf('--env');
    expect(argv.slice(envAt, envAt + 2)).toEqual(['--env', 'PATH']);
    expect(argv.join(' ')).not.toContain('PATH=');
    expect(argv[argv.length - 2]).toBe('cq-sandbox:latest');
    expect(argv[argv.length - 1]).toBe('/usr/bin/true');
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
        containerArgv({ image: 'x', user: root }, '/ws', 'model-only', {}, ['/usr/bin/true']),
      ).toThrow(/non-root/);
    }
    for (const malformed of ['root', '65532:root', '-1']) {
      expect(() =>
        containerArgv({ image: 'x', user: malformed }, '/ws', 'model-only', {}, ['/usr/bin/true']),
      ).toThrow(/numeric/);
    }
    // Any other fixed numeric identity is accepted verbatim.
    const argv = containerArgv({ image: 'x', user: '1000:1000' }, '/ws', 'model-only', {}, [
      '/usr/bin/true',
    ]);
    const userAt = argv.indexOf('--user');
    expect(argv.slice(userAt, userAt + 2)).toEqual(['--user', '1000:1000']);
  });

  test('a container CLI that cannot reach a daemon reports the exact blocker', async () => {
    const adapter = containerAdapter({ image: 'x', command: '/nonexistent/cq-docker' });
    const availability = await adapter.available();
    expect(availability.available).toBe(false);
    expect(availability.blocker).toMatch(/daemon unreachable/);
  });
});

describe('adapter options are snapshotted at construction (Sol final-head review)', () => {
  let stubDir: string;
  let wsDir: string;
  const stubScript = async (name: string, marker: string): Promise<string> => {
    const path = join(stubDir, name);
    await writeFile(path, `#!/bin/sh\necho "${marker} $@"\n`, { mode: 0o755 });
    return path;
  };

  beforeEach(async () => {
    stubDir = await mkdtemp(join(tmpdir(), 'cq-sbx-stub-'));
    // Launchers must live OUTSIDE the workspace the adapter confines.
    wsDir = await mkdtemp(join(tmpdir(), 'cq-sbx-ws-'));
  });
  afterEach(async () => {
    if (stubDir !== undefined) await rm(stubDir, { recursive: true, force: true });
    if (wsDir !== undefined) await rm(wsDir, { recursive: true, force: true });
  });

  test('mutating container options after construction cannot change the boundary', async () => {
    const stubA = join(stubDir, 'docker-a');
    await writeFile(
      stubA,
      `#!/bin/sh
case "$1" in
  create) echo "$*" > '${stubDir}/created'; printf '%064d\n' 1 ;;
  start) echo STUB-A; cat '${stubDir}/created' ;;
  inspect) echo 'false 0' ;;
  rm) exit 0 ;;
esac
`,
      { mode: 0o700 },
    );
    const stubB = await stubScript('docker-b', 'STUB-B');
    const options: ContainerAdapterOptions = {
      image: 'orig:latest',
      command: stubA,
      user: '1000:1000',
    };
    const adapter = containerAdapter(options);
    // The caller mutates the SAME options object after construction — the
    // launch must still be exactly the boundary that was constructed.
    options.command = stubB;
    options.image = 'evil:latest';
    options.user = '0:0';
    const result = await adapter.launch({
      workspace: wsDir,
      argv: ['/usr/bin/true'],
      network: 'model-only',
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('STUB-A');
    expect(result.stdout).not.toContain('STUB-B');
    expect(result.stdout).toContain('--user 1000:1000');
    expect(result.stdout).toContain('orig:latest');
    expect(result.stdout).not.toContain('evil:latest');
    expect(result.stdout).not.toContain('0:0');
    // Bounded per-test margin, measured (final head, concurrent authorized
    // testing): process spawn latency on the shared host reached ~9s per
    // spawn at load ~104/6 cores; this test chains four sequential CLI
    // stub spawns.  The 60s bound is test scheduling margin only — product
    // launch timeouts are untouched.
  }, 60_000);

  test('mutating landlock helperPath after construction cannot swap the helper', async () => {
    const stubA = await stubScript('landlock-a', 'STUB-A');
    const stubB = await stubScript('landlock-b', 'STUB-B');
    const options: LandlockAdapterOptions = { helperPath: stubA };
    const adapter = landlockAdapter(options);
    options.helperPath = stubB;
    const result = await adapter.launch({
      workspace: wsDir,
      argv: ['/usr/bin/true'],
      network: 'model-only',
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('STUB-A');
    expect(result.stdout).not.toContain('STUB-B');
    // Availability reads the same snapshot: still the constructed helper.
    const availability = await adapter.available();
    expect(availability.available).toBe(true);
    // Same measured-margin rationale as the container snapshot test above.
  }, 60_000);
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

  test('only seatbelt declares loopback-proxy composition for model-only', () => {
    expect(seatbeltAdapter().supportsProxyModelOnly).toBe(true);
    expect(bwrapAdapter().supportsProxyModelOnly).toBeUndefined();
    expect(containerAdapter({ image: 'x' }).supportsProxyModelOnly).toBeUndefined();
    expect(landlockAdapter().supportsProxyModelOnly).toBeUndefined();
  });
});

describe.runIf(process.platform === 'darwin')('seatbelt executes inside the boundary', () => {
  const scratch: string[] = [];
  afterEach(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test('a child reads and writes the workspace; no policy file lands in it', async () => {
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
    // The policy is compiled from parent-PRIVATE storage (Sol review: the
    // workspace is model-writable, so a policy there is attacker-replaceable);
    // nothing policy-shaped is ever created in the workspace.
    const listing = await readdir(workspace);
    expect(listing).not.toContain('.cq-seatbelt.sb');
    expect(listing.filter((name) => name.endsWith('.sb'))).toEqual([]);
  }, 30_000);

  test('the launcher env scrub reaches the confined child, and TMPDIR moves inside', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-test-'));
    scratch.push(workspace);
    const result = await adapter.launch({
      workspace,
      argv: ['/usr/bin/printenv', 'TMPDIR'],
      parentEnv: { ...process.env, CQ_PROBE_TEST_SECRET: 'leak-me-not' },
      envPassthrough: [],
      network: 'model-only',
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(join(workspace, '.tmp'));
    expect(result.stdout).not.toContain('leak-me-not');
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

  test('a SIBLING directory beside the workspace is unreadable too', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-test-'));
    scratch.push(workspace);
    const sibling = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-sib-'));
    scratch.push(sibling);
    const siblingPath = join(sibling, 'secret.txt');
    await writeFile(siblingPath, 'sibling-secret-value');
    const result = await adapter.launch({
      workspace,
      argv: ['/bin/cat', siblingPath],
      network: 'model-only',
    });
    expect(result.ok).toBe(false);
    expect(result.stdout).not.toContain('sibling-secret-value');
  }, 30_000);

  test('a proxyPort launch compiles the single-port egress rule', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-test-'));
    scratch.push(workspace);
    const result = await adapter.launch({
      workspace,
      argv: ['/usr/bin/true'],
      network: 'model-only',
      proxyPort: 45454,
    });
    // The launch succeeding proves sandbox-exec compiled the proxy rule
    // (profile source is private per-launch storage, destroyed afterwards —
    // the rule content itself is construction-tested in seatbeltProfile).
    expect(result.ok).toBe(true);
    const listing = await readdir(workspace);
    expect(listing.filter((name) => name.endsWith('.sb'))).toEqual([]);
  }, 30_000);

  test('a pre-planted workspace policy cannot replace the boundary (attack path)', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-test-'));
    scratch.push(workspace);
    const outside = await mkdtemp(join(tmpdir(), 'cq-sbx-outside-'));
    scratch.push(outside);
    const outsidePath = join(outside, 'secret.txt');
    await writeFile(outsidePath, 'outside-secret-value');
    // The attacker plants a permissive profile at the OLD policy path — both
    // as a plain file overwrite target and as the classic symlink swap.
    const evilProfile = join(workspace, 'evil.sb');
    const evilText = '(version 1)\n(allow default)\n';
    await writeFile(evilProfile, evilText);
    await symlink(evilProfile, join(workspace, '.cq-seatbelt.sb'));
    const result = await adapter.launch({
      workspace,
      argv: ['/bin/cat', outsidePath],
      network: 'model-only',
    });
    // The planted profile is ignored: the compiled boundary still denies the
    // out-of-workspace read (under `(allow default)` it would have leaked).
    expect(result.ok).toBe(false);
    expect(result.stdout).not.toContain('outside-secret-value');
    // And the launcher never wrote through the planted path: the symlink
    // still carries exactly the attacker's content.
    expect(await readFile(evilProfile, 'utf8')).toBe(evilText);
  }, 30_000);

  test('a poisoned TMPDIR cannot move the compiled policy into the workspace', async () => {
    const adapter = seatbeltAdapter();
    const workspace = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-test-'));
    scratch.push(workspace);
    const outside = await mkdtemp(join(tmpdir(), 'cq-sbx-outside-'));
    scratch.push(outside);
    const outsidePath = join(outside, 'secret.txt');
    await writeFile(outsidePath, 'outside-secret-value');
    // An inherited TMPDIR pointing INSIDE the model-writable workspace would
    // defeat a 0700 policy directory — the confined child is the same uid —
    // so the policy parent must be canonical and env-independent.
    const priorTmp = process.env.TMPDIR;
    process.env.TMPDIR = join(workspace, 'injected-tmp');
    try {
      const result = await adapter.launch({
        workspace,
        argv: ['/bin/cat', outsidePath],
        network: 'model-only',
      });
      expect(result.ok).toBe(false);
      expect(result.stdout).not.toContain('outside-secret-value');
      const listing = await readdir(workspace, { recursive: true });
      expect(listing.filter((entry) => entry.endsWith('.sb'))).toEqual([]);
      expect(listing.some((entry) => entry.includes('cq-sb-prof-'))).toBe(false);
    } finally {
      if (priorTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = priorTmp;
    }
  }, 30_000);

  test('a workspace traversing a symlink onto the policy parent is refused', async () => {
    // The containment guard must canonicalize (realpath), not compare
    // lexically: a workspace path THROUGH a symlink that resolves onto the
    // trusted policy parent is physically inside it even when the lexical
    // relative() says otherwise (Sol exact-head audit).  Baseline-first: the
    // shared parent may hold unrelated preexisting entries — the assertion is
    // that the refused launch ADDS nothing policy-shaped.
    const adapter = seatbeltAdapter();
    const linkDir = await mkdtemp(join(tmpdir(), 'cq-sbx-link-'));
    scratch.push(linkDir);
    const workspaceThroughLink = join(linkDir, 'pvt');
    await symlink('/private/var/tmp', workspaceThroughLink);
    const before = new Set(await readdir('/private/var/tmp'));
    const result = await adapter.launch({
      workspace: workspaceThroughLink,
      argv: ['/usr/bin/true'],
      network: 'model-only',
    });
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/contains the trusted policy parent/);
    const added = (await readdir('/private/var/tmp')).filter((entry) => !before.has(entry));
    expect(added.filter((entry) => entry.includes('cq-sb-prof-'))).toEqual([]);
  }, 30_000);

  test('a static symlink onto the policy parent mutates nothing before refusal', async () => {
    // Sol recheck: the old order ran mkdir(<workspace>/.tmp) BEFORE the
    // containment guard, so this exact case already created
    // /private/var/tmp/.tmp.  The guard now precedes every mutation.
    // Baseline-first assertion: the trusted parent is shared host state, so
    // the test captures what exists BEFORE the launch and requires the
    // refused launch to add nothing — it never deletes or requires the
    // absence of preexisting entries.
    const adapter = seatbeltAdapter();
    const linkDir = await mkdtemp(join(tmpdir(), 'cq-sbx-link-'));
    scratch.push(linkDir);
    const workspaceThroughLink = join(linkDir, 'pvt');
    await symlink('/private/var/tmp', workspaceThroughLink);
    const before = new Set(await readdir('/private/var/tmp'));
    const result = await adapter.launch({
      workspace: workspaceThroughLink,
      argv: ['/usr/bin/true'],
      network: 'model-only',
    });
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/contains the trusted policy parent/);
    const added = (await readdir('/private/var/tmp')).filter((entry) => !before.has(entry));
    expect(added).toEqual([]);
  }, 30_000);

  // PRACTICAL LIMIT, stated per reviewer: the mid-flight retarget refusal
  // ("workspace retargeted during launch") cannot be triggered
  // deterministically from outside the launch — a symlink swap would have to
  // land inside the window between the probe's two realpath calls, which no
  // public seam exposes, and a timing-based swap makes the test flaky by
  // construction.  The recheck itself is the enforcement (backend.ts,
  // "workspace retargeted during launch; the certified canonical binding is
  // stale"); this suite proves the deterministic parts — the containment
  // guard precedes every mutation, and the child binds only the canonical
  // path.  The race-window leg belongs to the fresh protocol's adversarial
  // review (A11/A17-style), not to a timing test here.

  test('the confined child binds the CANONICAL workspace, not the lexical path', async () => {
    const adapter = seatbeltAdapter();
    const workspaceReal = await mkdtemp(join(adapter.workspaceParent(), 'cq-sbx-real-'));
    scratch.push(workspaceReal);
    const linkDir = await mkdtemp(join(tmpdir(), 'cq-sbx-link-'));
    scratch.push(linkDir);
    const workspaceLink = join(linkDir, 'ws');
    await symlink(workspaceReal, workspaceLink);
    // One canonical binding for cwd and child TMPDIR: through a symlinked
    // workspace path, the child observes only the resolved directory.
    const result = await adapter.launch({
      workspace: workspaceLink,
      argv: ['/bin/sh', '-c', 'pwd; /usr/bin/printenv TMPDIR'],
      network: 'model-only',
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(workspaceReal);
    expect(result.stdout).toContain(join(workspaceReal, '.tmp'));
    expect(result.stdout).not.toContain(workspaceLink);
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

describe('launcher hardening (PR review)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-sbx-harden-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
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
