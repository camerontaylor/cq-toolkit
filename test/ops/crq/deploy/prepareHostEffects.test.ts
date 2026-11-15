import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { CalledProcessError } from '../../../../src/ops/crq/deploy/deployOps.js';
import { ValueError } from '../../../../src/ops/crq/deploy/hostOverlay.js';
import {
  atomicBytes,
  BlockingIOError,
  calledProcessError,
  hostBundle,
  isoUtc,
  loadOverlay,
  main,
  parseArgs,
  pyResolve,
  pyStrRepr,
  realHostEnv,
  requireOutsideGit,
  runProcess,
  withTickLock,
  type HostEnv,
  type ProcessResult,
  type RunProcess,
} from '../../../../src/ops/crq/deploy/prepareHostEffects.js';

const scratch = mkdtempSync(join(tmpdir(), 'prep-effects-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const fresh = (): string => {
  const dir = join(scratch, `t${String(++counter)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const sh = (cwd: string, ...argv: string[]): string =>
  execFileSync(argv[0] as string, argv.slice(1), { cwd, encoding: 'utf8' });

const UNIT = '[Service]\nExecStart=@CRQ_ROOT@/run\n';
const PLIST =
  '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>com.crq.x</string>' +
  '<key>P</key><string>@CRQ_ROOT@|@OVERLAY@|@HOME@</string></dict></plist>';
const committed = {
  clone: '/old/clone',
  worktree_root: '/old/wt',
  timeout_bin: '/usr/bin/timeout',
  paseo_hosts: ['a:1'],
  repair: { enabled: false, cq_bin: '/old/cq', paseo_host: 'a:1' },
  alerts: { alert_agent_host: 'a:1' },
};
const overlayConfig = {
  clone: '/srv/review/clone',
  worktree_root: '/srv/review/wt',
  timeout_bin: '/usr/bin/timeout',
  paseo_hosts: ['a:1', 'b:2'],
  repair: { enabled: false, cq_bin: '/usr/bin/cq', paseo_host: 'a:1' },
  alerts: { alert_agent_host: 'a:1' },
};

interface Host {
  base: string;
  root: string;
  records: string;
  overlayPath: string;
  env: HostEnv;
  calls: string[][];
}
/** A detached full checkout, a 0600 overlay beside it, real git, faked systemd. */
function host(over: { run?: RunProcess } = {}): Host {
  const base = fresh();
  const root = join(base, 'deploy');
  mkdirSync(join(root, 'apps/crq-python/ops/systemd'), { recursive: true });
  writeFileSync(join(root, 'apps/crq-python/config.json'), JSON.stringify(committed));
  writeFileSync(join(root, 'apps/crq-python/ops/systemd/crq-tick.service'), UNIT);
  writeFileSync(join(root, 'apps/crq-python/ops/com.crq.x.plist'), PLIST);
  sh(root, 'git', 'init', '-q');
  sh(root, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
  sh(root, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c');
  sh(root, 'git', 'checkout', '-q', '--detach');
  const records = join(base, 'records');
  const overlayPath = join(base, 'overlay.json');
  writeFileSync(
    overlayPath,
    JSON.stringify({
      schema_version: 1,
      deploy_root: root,
      record_dir: records,
      config: overlayConfig,
      fleet_reader: { ssh_host: 'h1', source: '/srv/fleet' },
    }),
    { mode: 0o600 },
  );
  const calls: string[][] = [];
  const run: RunProcess =
    over.run ??
    (async (argv) => {
      calls.push([...argv]);
      if (argv[0] === 'systemctl' || argv[0] === 'systemd-analyze') return ok('');
      return runProcess(argv);
    });
  const env: HostEnv = { ...realHostEnv(), run, home: () => '/home/h' };
  return { base, root, records, overlayPath, env, calls };
}
const ok = (stdout: string, code = 0, stderr = ''): ProcessResult => ({
  code,
  stdout: Buffer.from(stdout),
  stderr: Buffer.from(stderr),
});

describe('python reprs', () => {
  test('pyStrRepr quotes the way Python does', () => {
    expect(pyStrRepr('a')).toBe("'a'");
    expect(pyStrRepr("it's")).toBe('"it\'s"');
    expect(pyStrRepr('it\'s "x"')).toBe("'it\\'s \"x\"'");
    expect(pyStrRepr('a\\b\n\t\r\u0001\u007f')).toBe("'a\\\\b\\n\\t\\r\\x01\\x7f'");
    expect(pyStrRepr('é😀')).toBe("'é😀'");
  });
  test('calledProcessError carries only argv', () => {
    const e = calledProcessError(['git', '-C', '/r'], 128, 'boom');
    expect(e).toBeInstanceOf(CalledProcessError);
    expect(e.message).toBe("Command ['git', '-C', '/r'] returned non-zero exit status 128.");
    expect(e.returncode).toBe(128);
    expect(e.stderr).toBe('boom');
  });
  test('isoUtc is datetime.isoformat with microseconds only when nonzero', () => {
    expect(isoUtc(new Date('2026-11-15T01:02:03.456Z'))).toBe('2026-11-15T01:02:03.456000+00:00');
    expect(isoUtc(new Date('2026-11-15T01:02:03.000Z'))).toBe('2026-11-15T01:02:03+00:00');
  });
});

describe('atomicBytes', () => {
  test('creates parents, writes 0600, replaces, leaves no temp file', async () => {
    const dir = fresh();
    const target = join(dir, 'a/b/c.json');
    await atomicBytes(target, Buffer.from('one'));
    expect(readFileSync(target, 'utf8')).toBe('one');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    await atomicBytes(target, Buffer.from('two'));
    expect(readFileSync(target, 'utf8')).toBe('two');
    expect(readdirSync(join(dir, 'a/b'))).toEqual(['c.json']);
  });
  test('a failed rename leaves the target intact and no temp file', async () => {
    const dir = fresh();
    mkdirSync(join(dir, 'target'));
    writeFileSync(join(dir, 'target/keep'), 'x');
    await expect(atomicBytes(join(dir, 'target'), Buffer.from('y'))).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['target']);
    expect(readFileSync(join(dir, 'target/keep'), 'utf8')).toBe('x');
  });
});

describe('pyResolve', () => {
  test('follows symlinks of the existing prefix and appends the rest', () => {
    const dir = pyResolve(fresh());
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(pyResolve(join(dir, 'link/missing/x'))).toBe(join(dir, 'real/missing/x'));
    expect(pyResolve(join(dir, 'real/../real'))).toBe(join(dir, 'real'));
  });
});

describe('requireOutsideGit', () => {
  test('refuses a checkout and a not-yet-created path inside it', async () => {
    const h = host();
    await expect(requireOutsideGit(h.root, h.env)).rejects.toThrow(ValueError);
    await expect(requireOutsideGit(join(h.root, 'new/deep/file'), h.env)).rejects.toThrow(
      'private host artifacts must be outside every Git checkout',
    );
  });
  test('accepts a path outside every checkout, existing or not', async () => {
    const h = host();
    await requireOutsideGit(h.records, h.env);
    await requireOutsideGit(h.overlayPath, h.env);
  });
  test('asks git about the nearest existing directory', async () => {
    const seen: string[][] = [];
    const run: RunProcess = async (argv) => {
      seen.push([...argv]);
      return ok('', 128);
    };
    const dir = pyResolve(fresh());
    await requireOutsideGit(join(dir, 'x/y'), { run });
    expect(seen).toEqual([['git', '-C', dir, 'rev-parse', '--show-toplevel']]);
  });
});

describe('loadOverlay', () => {
  test('returns the validated overlay and the exact raw bytes', async () => {
    const h = host();
    const loaded = await loadOverlay(h.overlayPath, h.env);
    expect(loaded.overlay.get('deploy_root')).toBe(h.root);
    expect(Buffer.from(loaded.raw).equals(readFileSync(h.overlayPath))).toBe(true);
  });
  test('refuses group/other readable, inside git, and invalid JSON', async () => {
    const h = host();
    chmodSync(h.overlayPath, 0o640);
    await expect(loadOverlay(h.overlayPath, h.env)).rejects.toThrow(
      'private overlay must have mode 0600',
    );
    chmodSync(h.overlayPath, 0o600);
    const inside = join(h.root, 'overlay.json');
    writeFileSync(inside, readFileSync(h.overlayPath), { mode: 0o600 });
    await expect(loadOverlay(inside, h.env)).rejects.toThrow('outside every Git checkout');
    const broken = join(h.base, 'broken.json');
    writeFileSync(broken, '{nope', { mode: 0o600 });
    await expect(loadOverlay(broken, h.env)).rejects.toThrow(ValueError);
    await expect(loadOverlay(join(h.base, 'absent.json'), h.env)).rejects.toThrow(/ENOENT/);
  });
  test('refuses an overlay that lives inside its deploy_root', async () => {
    const h = host();
    const nogit = fresh();
    const deploy = join(nogit, 'deploy');
    mkdirSync(deploy);
    const path = join(deploy, 'overlay.json');
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        deploy_root: deploy,
        record_dir: join(nogit, 'rec'),
        config: overlayConfig,
        fleet_reader: { ssh_host: 'h1', source: '/srv/fleet' },
      }),
      { mode: 0o600 },
    );
    await expect(loadOverlay(path, h.env)).rejects.toThrow('overlay must be outside the checkout');
  });
});

describe('withTickLock (real flock)', () => {
  test('creates the state dir, excludes a second holder, releases on return and on throw', async () => {
    const h = host();
    const state = join(h.root, 'apps/crq-python/state');
    expect(existsSync(state)).toBe(false);
    let nested: unknown;
    await withTickLock(h.env.lockFs, h.root, async () => {
      expect(existsSync(join(state, 'tick.lock'))).toBe(true);
      nested = await withTickLock(h.env.lockFs, h.root, async () => 'inner').catch(
        (e: unknown) => e,
      );
    });
    expect(nested).toBeInstanceOf(BlockingIOError);
    expect((nested as Error).message).toBe('[Errno 11] Resource temporarily unavailable');
    await expect(
      withTickLock(h.env.lockFs, h.root, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(withTickLock(h.env.lockFs, h.root, async () => 7)).resolves.toBe(7);
  });
  test('does not create missing parents of the state dir', async () => {
    const dir = fresh();
    await expect(withTickLock(realHostEnv().lockFs, dir, async () => 1)).rejects.toThrow(/ENOENT/);
  });
});

describe('parseArgs', () => {
  test('each operation, the --live-config alias, abbreviations and --opt=value', () => {
    expect(parseArgs(['--overlay', 'o', 'live-config']).operation).toBe('live-config');
    expect(parseArgs(['--overlay', 'o', '--live-config']).operation).toBe('live-config');
    expect(parseArgs(['--ov=o', 'live-config']).overlay).toBe('o');
    expect(parseArgs(['--overlay', 'o', 'prepare', '--units-o', 'u', '--tag=t'])).toMatchObject({
      unitsOutput: 'u',
      tag: 't',
    });
    expect(parseArgs(['--overlay', 'o', 'switch', '--sha', 's'])).toMatchObject({
      sha: 's',
      tag: null,
    });
    expect(parseArgs(['--overlay', 'o', 'preview', '--output', 'p']).output).toBe('p');
    expect(parseArgs(['--overlay', 'o', 'legacy-check', '--legacy-root', 'l']).legacyRoot).toBe(
      'l',
    );
  });
  test.each([
    [[], 'the following arguments are required: --overlay, operation'],
    [['--overlay', 'o'], 'the following arguments are required: operation'],
    [['live-config'], 'the following arguments are required: --overlay'],
    [['--overlay', 'o', 'nope'], "invalid choice: 'nope'"],
    [['--overlay', 'o', 'prepare', '--tag', 't'], 'required: --units-output'],
    [['--overlay', 'o', 'prepare', '--units-output'], 'expected one argument'],
    [['--overlay', 'o', 'prepare', '--units-output', '--tag'], 'expected one argument'],
    [['--overlay', 'o', 'live-config', 'extra'], 'unrecognized arguments: extra'],
    [['--overlay', 'o', 'preview', '--output', 'p', '--bogus'], 'unrecognized arguments: --bogus'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseArgs(argv as string[])).toThrow(message);
  });
});

describe('hostBundle wiring', () => {
  test('systemd-facing effects run the argv Python runs', async () => {
    const h = host();
    const loaded = await loadOverlay(h.overlayPath, h.env);
    const b = hostBundle(h.env, h.root, loaded.overlay, loaded.raw, {
      output: join(h.base, 'out'),
    });
    expect(await b.unitFiles()).toEqual(['crq-tick.service']);
    expect(await b.systemctl(['--user', 'show', 'x'])).toEqual({ code: 0, stdout: '', stderr: '' });
    await b.daemonReload();
    await b.verifyUnits(['/u/a.service', '/u/b.service']);
    expect(h.calls.filter((c) => c[0] !== 'git')).toEqual([
      ['systemctl', '--user', 'show', 'x'],
      ['systemctl', '--user', 'daemon-reload'],
      ['systemd-analyze', '--user', 'verify', '/u/a.service', '/u/b.service'],
    ]);
  });
  test('a failing verify or reload is a CalledProcessError naming only argv', async () => {
    const g = host();
    const l = await loadOverlay(g.overlayPath, g.env);
    const failing = hostBundle(
      { ...g.env, run: async () => ok('secret', 3, 'private stderr') },
      g.root,
      l.overlay,
      l.raw,
    );
    await expect(failing.verifyUnits(['/u/a'])).rejects.toThrow(
      "Command ['systemd-analyze', '--user', 'verify', '/u/a'] returned non-zero exit status 3.",
    );
    await expect(failing.git(['rev-parse', 'HEAD'])).rejects.toBeInstanceOf(CalledProcessError);
  });
  test('git runs with -C root and a missing unit directory lists nothing', async () => {
    const h = host();
    const l = await loadOverlay(h.overlayPath, h.env);
    const b = hostBundle(h.env, h.root, l.overlay, l.raw);
    expect(text(await b.git(['rev-parse', '--abbrev-ref', 'HEAD']))).toBe('HEAD\n');
    rmSync(join(h.root, 'apps/crq-python/ops/systemd'), { recursive: true });
    expect(await b.unitFiles()).toEqual([]);
  });
  test('prepare effects write below the output, the marker and the config', async () => {
    const h = host();
    const l = await loadOverlay(h.overlayPath, h.env);
    const out = join(h.base, 'out');
    const b = hostBundle(h.env, h.root, l.overlay, l.raw, { output: out });
    const sha = sh(h.root, 'git', 'rev-parse', 'HEAD').trim();
    await b.mkdirOutput();
    await b.writeOutput('crq-tick.service', Buffer.from('u'));
    await b.writeMarker(Buffer.from('m'));
    await b.writeConfig(Buffer.from('c'));
    expect(readFileSync(join(out, 'crq-tick.service'), 'utf8')).toBe('u');
    expect(readFileSync(join(h.root, 'apps/crq-python/state/runner-disabled'), 'utf8')).toBe('m');
    expect(readFileSync(await bPath(h), 'utf8')).toBe('c');
    expect(text(await b.readConfig())).toBe('c');
    const seen = await b.renderUnitsToTemp(sha, async (paths) => {
      expect(paths).toHaveLength(1);
      expect(paths[0]).toMatch(/crq-units-[^/]+\/crq-tick\.service$/);
      return [paths[0], text(await b.readFile(paths[0] as string))];
    });
    expect(seen[1]).toBe(`[Service]\nExecStart=${h.root}/apps/crq-python/run\n`);
    expect(existsSync(seen[0] as string)).toBe(false);
  });
});
const bPath = async (h: Host): Promise<string> => join(h.root, 'apps/crq-python/config.json');
const text = (d: Uint8Array): string => Buffer.from(d).toString('utf8');

describe('main', () => {
  const rendered = (): string =>
    JSON.stringify({ ...committed, ...overlayConfig, alerts: overlayConfig.alerts });

  test('live-config renders under the lock, records first, then writes', async () => {
    const h = host();
    const r = await main(['--overlay', h.overlayPath, '--live-config'], { env: h.env });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ operation: 'live-config', status: 'ok' });
    expect(r.stdout.endsWith('}\n')).toBe(true);
    expect(r.stderr).toBe('completed live-config; no units started\n');
    const live = JSON.parse(readFileSync(join(h.root, 'apps/crq-python/config.json'), 'utf8')) as {
      clone: string;
      paseo_hosts: string[];
    };
    expect(live.clone).toBe('/srv/review/clone');
    expect(live.paseo_hosts).toEqual(['a:1', 'b:2']);
    const files = readdirSync(h.records);
    expect(files).toHaveLength(1);
    const rec = JSON.parse(readFileSync(join(h.records, files[0] as string), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(rec).toMatchObject({
      schema_version: 1,
      operation: 'live-config',
      record_type: 'render-intent',
      sha: sh(h.root, 'git', 'rev-parse', 'HEAD').trim(),
    });
    expect(statSync(h.records).mode & 0o077).toBe(0);
    expect(rendered()).toContain('clone');
  });
  test('a held tick lock refuses live-config without writing', async () => {
    const h = host();
    let result: Awaited<ReturnType<typeof main>> | undefined;
    await withTickLock(h.env.lockFs, h.root, async () => {
      result = await main(['--overlay', h.overlayPath, 'live-config'], { env: h.env });
    });
    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: '[Errno 11] Resource temporarily unavailable\n',
    });
    expect(readFileSync(join(h.root, 'apps/crq-python/config.json'), 'utf8')).toBe(
      JSON.stringify(committed),
    );
    expect(existsSync(h.records)).toBe(false);
  });
  test('preview writes config, units and plists under the output and holds the lock', async () => {
    const h = host();
    const out = join(h.base, 'preview');
    const r = await main(['--overlay', h.overlayPath, 'preview', '--output', out], { env: h.env });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('completed preview; no units started\n');
    expect(JSON.parse(readFileSync(join(out, 'config.json'), 'utf8'))).toMatchObject({
      clone: '/srv/review/clone',
    });
    expect(readFileSync(join(out, 'systemd/crq-tick.service'), 'utf8')).toBe(
      `[Service]\nExecStart=${h.root}/apps/crq-python/run\n`,
    );
    const plist = readFileSync(join(out, 'launchd/com.crq.x.plist'), 'utf8');
    expect(plist).toContain(`${h.root}/apps/crq-python|${pyResolve(h.overlayPath)}|/home/h`);
    expect(
      JSON.parse(readFileSync(join(h.records, readdirSync(h.records)[0] as string), 'utf8')),
    ).toMatchObject({
      operation: 'preview',
    });
    // The live checkout is untouched by a preview.
    expect(readFileSync(join(h.root, 'apps/crq-python/config.json'), 'utf8')).toBe(
      JSON.stringify(committed),
    );
  });
  test('preview and prepare refuse an output inside the checkout or a Git checkout', async () => {
    const h = host();
    for (const [op, flag] of [
      ['preview', '--output'],
      ['prepare', '--units-output'],
    ] as const) {
      const args = (dir: string): string[] => [
        '--overlay',
        h.overlayPath,
        op,
        flag,
        dir,
        ...(op === 'prepare' ? ['--tag', 'x'] : []),
      ];
      const r = await main(args(join(h.root, 'out')), { env: h.env });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toBe('private host artifacts must be outside every Git checkout\n');
    }
    const nested = join(h.base, 'plain');
    mkdirSync(nested);
    expect(h.calls.length).toBeGreaterThan(0);
  });
  test('switch and prepare dispatch into their operations', async () => {
    const h = host();
    const sw = await main(['--overlay', h.overlayPath, 'switch', '--sha', 'abc'], { env: h.env });
    expect(sw).toEqual({ exitCode: 1, stdout: '', stderr: 'target must be a full commit SHA\n' });
    const pr = await main(
      ['--overlay', h.overlayPath, 'prepare', '--units-output', join(h.base, 'u'), '--tag', 'nope'],
      { env: h.env },
    );
    expect(pr.exitCode).toBe(1);
    expect(pr.stderr).toBe('refusing active or unknown unit: crq-tick.service\n');
    const lc = await main(['--overlay', h.overlayPath, 'legacy-check', '--legacy-root', h.root], {
      env: h.env,
    });
    expect(lc.stderr).toBe('legacy checkout HEAD must match the accepted baseline\n');
  });
  test('usage errors exit 2, a missing overlay is an OS error, other errors escape', async () => {
    const h = host();
    const usage = await main(['live-config'], { env: h.env });
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr).toBe(
      'prepare-host.py: error: the following arguments are required: --overlay\n',
    );
    const missing = await main(['--overlay', join(h.base, 'none.json'), 'live-config'], {
      env: h.env,
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toMatch(/ENOENT/);
    const boom = { ...h.env, run: async () => Promise.reject(new TypeError('not an OS error')) };
    await expect(main(['--overlay', h.overlayPath, 'live-config'], { env: boom })).rejects.toThrow(
      TypeError,
    );
  });
});
