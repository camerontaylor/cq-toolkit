// Split provenance: test/ops/ratchet/recomputeTypecheck.test.ts was split by
// subject into recomputeTypecheck.core.test.ts, recomputeTypecheck.preflight.test.ts,
// recomputeTypecheck.dependency-boundary.test.ts and
// recomputeTypecheck.launcher.test.ts (shared fixtures:
// recomputeTypecheck.helpers.ts).
// W1.7: the trusted compiler counts errors in an attribute-free head tree.
// A local Git repo and the installed TypeScript package exercise the complete
// extraction + toolchain path without a network service or fake diagnostics.
import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { stringify } from 'yaml';
import { extractTreeAttributeFree } from '../../../src/adapters/git/ratchetGit.js';
import {
  boundaryPreflight,
  createTempRoot,
  dependencyChildEnv,
  git,
  prepareOfflineFixtureDependencies,
  subjectDependencyPlan,
  trustedGit,
} from './recomputeTypecheck.helpers.js';

const fixtureGit = vi.hoisted(() => ({
  executable: '',
  environment: (supplied?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...supplied,
    PATH: '',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
  }),
}));

// Forward to REAL processes; bind the existing adapter's bare git calls without
// changing production code or consulting PATH during subject extraction.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const forward = (method: 'execFile' | 'spawn', command: string, args: unknown[]): unknown => {
    if (command !== 'git') return Reflect.apply(actual[method], actual, [command, ...args]);
    if (!fixtureGit.executable) throw new Error('Git fixture preflight was not completed');
    const bound = args.map((value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
      return {
        ...value,
        env: fixtureGit.environment((value as { env?: NodeJS.ProcessEnv }).env),
      };
    });
    return Reflect.apply(actual[method], actual, [fixtureGit.executable, ...bound]);
  };
  return {
    ...actual,
    execFile: ((command: string, ...args: unknown[]) =>
      forward('execFile', command, args)) as typeof actual.execFile,
    spawn: ((command: string, ...args: unknown[]) =>
      forward('spawn', command, args)) as typeof actual.spawn,
  };
});

fixtureGit.executable = trustedGit;

let tmp: string;
let dispose: () => void;

beforeAll(() => {
  ({ tmp, dispose } = createTempRoot());
}, 60_000);

afterAll(() => dispose());

afterEach(() => vi.unstubAllEnvs());

describe('offline subject dependency boundary', { timeout: 60_000 }, () => {
  let tools: ReturnType<typeof boundaryPreflight>;
  beforeAll(() => {
    tools = boundaryPreflight();
  });

  test('real TS2307 is fixed by subject graph without executing scripts, hooks or compiler', async () => {
    const {
      trustedTar,
      trustedGzip,
      trustedNode,
      nativePnpm,
      pnpmPrefix,
      requiredPnpmVersion,
      pnpmEntrypoint,
    } = tools;
    const tsc = realpathSync(join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'));
    accessSync(tsc, constants.R_OK);
    const base = join(tmp, 'boundary');
    const seed = join(base, 'seed');
    const store = join(base, 'store');
    const home = join(base, 'home');
    mkdirSync(seed, { recursive: true });
    mkdirSync(home);
    const sentinel = join(base, 'subject-code-ran');
    const malicious = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`;
    const fakeCompiler = `#!${trustedNode}\n${malicious}\n`;
    writeFileSync(join(base, 'evil.cjs'), malicious);
    vi.stubEnv('CQ_BOUNDARY_SECRET', 'fake-canary');
    vi.stubEnv('HTTPS_PROXY', 'https://rejected.invalid');
    vi.stubEnv('npm_config_registry', 'https://rejected.invalid');
    vi.stubEnv('NODE_OPTIONS', `--require=${join(base, 'evil.cjs')}`);
    expect(
      execFileSync(nativePnpm, [...pnpmPrefix, '--version'], {
        cwd: seed,
        env: dependencyChildEnv(home),
        encoding: 'utf8',
      }).trim(),
    ).toBe(requiredPnpmVersion);
    console.info('H1 verified pnpm version:', requiredPnpmVersion, 'entrypoint:', pnpmEntrypoint);
    writeFileSync(join(seed, 'package.json'), '{}');
    writeFileSync(join(seed, 'pnpm-workspace.yaml'), 'managePackageManagerVersions: false\n');
    const packages: Record<string, unknown> = {};
    for (const name of ['boundary-dep', 'typescript']) {
      const dir = join(seed, name);
      mkdirSync(join(dir, 'package', 'bin'), { recursive: true });
      writeFileSync(
        join(dir, 'package', 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          types: 'index.d.ts',
          ...(name === 'typescript' ? { bin: { tsc: 'bin/tsc' } } : {}),
          scripts: {
            preinstall: `${trustedNode} -e ${JSON.stringify(malicious)}`,
            postinstall: `${trustedNode} -e ${JSON.stringify(malicious)}`,
          },
        }),
      );
      writeFileSync(join(dir, 'package', 'index.d.ts'), 'export declare const amount: number;\n');
      writeFileSync(join(dir, 'package', 'bin', 'tsc'), fakeCompiler);
      chmodSync(join(dir, 'package', 'bin', 'tsc'), 0o755);
      const tarball = join(seed, `${name}.tgz`);
      execFileSync(
        trustedTar,
        [`--use-compress-program=${trustedGzip}`, '-cf', tarball, '-C', dir, 'package'],
        { env: dependencyChildEnv(home) },
      );
      const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
      packages[`${name}@1.0.0`] = { resolution: { integrity } };
    }
    // This trusted child has no fetch client, redirects or dynamic route mapping.
    // It must run separately because store add below blocks this test's event loop.
    const serverScript = join(base, 'registry.cjs');
    writeFileSync(
      serverScript,
      `const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const requests = [];
const routes = new Map();
const server = createServer((req, res) => {
  const allowed = req.method === 'GET' && routes.has(req.url) &&
    req.headers.host === '127.0.0.1:' + server.address().port &&
    !req.headers.authorization && !req.headers['proxy-authorization'];
  requests.push({ route: req.url, allowed });
  if (!allowed) { res.writeHead(403); res.end(); return; }
  const [contentType, body] = routes.get(req.url);
  res.writeHead(200, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
});
server.listen(0, '127.0.0.1', () => {
  const origin = 'http://127.0.0.1:' + server.address().port + '/';
  for (const name of ['boundary-dep', 'typescript']) {
    const bytes = readFileSync(join(process.argv[2], name + '.tgz'));
    const manifest = JSON.parse(readFileSync(join(process.argv[2], name, 'package', 'package.json')));
    const route = name + '/-/' + name + '-1.0.0.tgz';
    const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
    const packument = { name, 'dist-tags': { latest: '1.0.0' }, versions: {
      '1.0.0': { ...manifest, dist: { tarball: origin + route, integrity } }
    }, time: { '1.0.0': '2020-01-01T00:00:00.000Z' } };
    routes.set('/' + name, ['application/json', Buffer.from(JSON.stringify(packument))]);
    routes.set('/' + route, ['application/octet-stream', bytes]);
  }
  process.send({ origin });
});
process.on('message', message => {
  if (message !== 'stop') process.exit(2);
  server.close(() => { process.send({ requests }, () => process.exit(0)); });
});
setTimeout(() => process.exit(3), 30000).unref();
`,
    );
    const server = fork(serverScript, [seed], {
      execPath: trustedNode,
      execArgv: [],
      cwd: seed,
      env: dependencyChildEnv(home),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const serverExit = new Promise<number | null>((ok, fail) => {
      server.once('error', fail);
      server.once('exit', ok);
    });
    let registry: string;
    try {
      const [ready] = (await once(server, 'message')) as unknown[];
      registry = (ready as { origin: string }).origin;
      expect(registry).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      execFileSync(
        nativePnpm,
        [
          ...pnpmPrefix,
          'store',
          'add',
          'boundary-dep@1.0.0',
          'typescript@1.0.0',
          '--registry',
          registry,
          '--ignore-scripts',
          '--ignore-pnpmfile',
          '--trust-lockfile',
          '--store-dir',
          store,
        ],
        { cwd: seed, env: dependencyChildEnv(home), timeout: 30_000, stdio: 'pipe' },
      );
      expect(existsSync(sentinel)).toBe(false);
      console.info('H1 reached: registry-name seed and seed canary assertions');
      const stopped = once(server, 'message');
      server.send('stop');
      const [report] = (await stopped) as unknown[];
      expect(await serverExit).toBe(0);
      const requests = (report as { requests: { route: string; allowed: boolean }[] }).requests;
      expect(requests.every((request) => request.allowed)).toBe(true);
      expect(new Set(requests.map((request) => request.route))).toEqual(
        new Set([
          '/boundary-dep',
          '/typescript',
          '/boundary-dep/-/boundary-dep-1.0.0.tgz',
          '/typescript/-/typescript-1.0.0.tgz',
        ]),
      );
      console.info('H1 reached: server stopped/awaited and exact unauthenticated routes');
    } finally {
      if (server.exitCode === null) server.kill();
      await serverExit;
    }
    const lock = {
      lockfileVersion: '9.0',
      settings: { autoInstallPeers: false, excludeLinksFromLockfile: false },
      importers: {
        '.': {
          dependencies: {
            'boundary-dep': { specifier: '1.0.0', version: '1.0.0' },
            typescript: { specifier: '1.0.0', version: '1.0.0' },
          },
        },
      },
      packages,
      snapshots: { 'boundary-dep@1.0.0': {}, 'typescript@1.0.0': {} },
    };
    const manifest = JSON.stringify({
      dependencies: { 'boundary-dep': '1.0.0', typescript: '1.0.0' },
      packageManager: 'pnpm@0.0.0',
      devEngines: { packageManager: { name: 'evil', version: '0' } },
      pnpm: { pnpmfile: 'evil.cjs' },
      scripts: { preinstall: `${trustedNode} -e ${JSON.stringify(malicious)}` },
    });
    const lockfile = stringify(lock);
    const subjectRepo = join(base, 'subject');
    mkdirSync(subjectRepo);
    git(subjectRepo, ['init', '-q', '-b', 'main']);
    git(subjectRepo, ['config', 'user.email', 'test@example.test']);
    git(subjectRepo, ['config', 'user.name', 'test']);
    git(subjectRepo, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(subjectRepo, 'package.json'), manifest);
    writeFileSync(join(subjectRepo, 'pnpm-lock.yaml'), lockfile);
    writeFileSync(
      join(subjectRepo, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          types: [],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
        },
        files: ['sample.ts'],
      }),
    );
    writeFileSync(
      join(subjectRepo, 'sample.ts'),
      'import { amount } from "boundary-dep"; const n: number = amount;\n',
    );
    writeFileSync(join(subjectRepo, '.pnpmfile.cjs'), malicious);
    writeFileSync(join(subjectRepo, 'evil.cjs'), malicious);
    writeFileSync(join(subjectRepo, '.npmrc'), 'registry=https://rejected.invalid\n');
    writeFileSync(join(subjectRepo, 'pnpm-workspace.yaml'), 'virtualStoreType: global\n');
    git(subjectRepo, ['add', '.']);
    git(subjectRepo, ['commit', '-q', '-m', 'subject graph']);
    const scratch = join(base, 'scratch');
    const tree = join(scratch, 'tree');
    const compilerHome = join(base, 'compiler-home');
    mkdirSync(compilerHome);
    mkdirSync(scratch);
    await extractTreeAttributeFree(subjectRepo, git(subjectRepo, ['rev-parse', 'HEAD']), tree);
    const args = [tsc, '--noEmit', '--pretty', 'false', '-p', join(tree, 'tsconfig.json')];
    let red = '';
    try {
      execFileSync(trustedNode, args, {
        cwd: tree,
        env: dependencyChildEnv(compilerHome),
        stdio: 'pipe',
      });
    } catch (err) {
      red = String((err as { stdout: Buffer }).stdout);
    }
    expect(red).toContain('TS2307');
    expect(existsSync(sentinel)).toBe(false);
    console.info('H1 reached: trusted compiler TS2307 before install and canary assertion');
    const canaryPresence: unknown = JSON.parse(
      execFileSync(
        trustedNode,
        [
          '-e',
          `process.stdout.write(JSON.stringify({
        secretPresent: process.env['CQ_BOUNDARY_SECRET'] !== undefined,
        proxyPresent: process.env['HTTPS_PROXY'] !== undefined,
        registryPresent: process.env['npm_config_registry'] !== undefined,
        loaderPresent: process.env['NODE_OPTIONS'] !== undefined,
      }))`,
        ],
        {
          cwd: tree,
          env: dependencyChildEnv(compilerHome),
          encoding: 'utf8',
        },
      ),
    );
    expect(canaryPresence).toEqual({
      secretPresent: false,
      proxyPresent: false,
      registryPresent: false,
      loaderPresent: false,
    });
    console.info('H1 reached: scrubbed child environment assertions');
    const plan = subjectDependencyPlan(manifest, lockfile);
    expect(plan.lockfile).toBe(lockfile);
    // Fixture-only consumer: explicit internal registry config, never a subject
    // URL exception. Production helper input/config wiring is deliberately held.
    const installConsumer = (root: string, consumerStore: string, data = plan.manifest) => {
      const deps = join(root, 'dependencies');
      const consumerHome = join(root, 'empty-home');
      mkdirSync(deps, { recursive: true });
      mkdirSync(consumerHome);
      writeFileSync(join(deps, 'package.json'), data);
      writeFileSync(join(deps, 'pnpm-lock.yaml'), plan.lockfile);
      writeFileSync(
        join(deps, 'pnpm-workspace.yaml'),
        'autoInstallPeers: false\nvirtualStoreType: project\nmanagePackageManagerVersions: false\n',
      );
      try {
        execFileSync(
          nativePnpm,
          [
            ...pnpmPrefix,
            'install',
            '--offline',
            '--frozen-lockfile',
            '--ignore-scripts',
            '--ignore-pnpmfile',
            '--trust-lockfile',
            '--registry',
            registry,
            '--store-dir',
            consumerStore,
          ],
          { cwd: deps, env: dependencyChildEnv(consumerHome), timeout: 30_000, stdio: 'pipe' },
        );
      } catch (error) {
        const output = error as { stdout?: Buffer; stderr?: Buffer };
        const code = `${output.stdout}\n${output.stderr}`.match(/\bERR_PNPM_[A-Z_]+\b/)?.[0];
        throw new Error(`fixture-offline-install: ${code ?? 'INVOCATION_FAILED'}`);
      }
      return deps;
    };
    const deps = installConsumer(scratch, store);
    expect(existsSync(sentinel)).toBe(false);
    console.info('H1 reached: frozen offline consumer install and install canary assertion');
    symlinkSync(join(deps, 'node_modules'), join(tree, 'node_modules'), 'dir');
    expect(
      execFileSync(trustedNode, args, {
        cwd: tree,
        env: dependencyChildEnv(compilerHome),
        encoding: 'utf8',
      }),
    ).toBe('');
    expect(existsSync(sentinel)).toBe(false);
    expect(readFileSync(join(tree, 'node_modules', 'typescript', 'bin', 'tsc'), 'utf8')).toBe(
      fakeCompiler,
    );
    expect(existsSync(join(deps, 'node_modules', '.bin', 'tsc'))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(tree, 'node_modules', 'typescript', 'package.json'), 'utf8')),
    ).toMatchObject({ name: 'typescript', version: '1.0.0', bin: { tsc: 'bin/tsc' } });
    console.info(
      'H1 reached: trusted compiler green, canary and selectable fake compiler assertions',
    );
    writeFileSync(
      join(tree, 'sample.ts'),
      'import { amount } from "boundary-dep"; import { parse } from "yaml"; void parse; const n: string = amount;\n',
    );
    let realErrors = '';
    try {
      execFileSync(trustedNode, args, {
        cwd: tree,
        env: dependencyChildEnv(compilerHome),
        stdio: 'pipe',
      });
    } catch (error) {
      realErrors = String((error as { stdout: Buffer }).stdout);
    }
    expect(realErrors).toContain('TS2322');
    expect(realErrors).toContain('TS2307');
    expect(realErrors).toContain('yaml');
    expect(existsSync(sentinel)).toBe(false);
    console.info(
      'H1 reached: real TS2322, trusted-only dependency TS2307 and compiler canary assertions',
    );
    expect(dependencyChildEnv(home)).toEqual({
      HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: home,
      PATH: process.execPath.slice(0, process.execPath.lastIndexOf('/')),
      CI: 'true',
    });
    expect(JSON.parse(readFileSync(join(scratch, 'dependencies', 'package.json'), 'utf8'))).toEqual(
      {
        name: 'cq-isolated-subject',
        version: '0.0.0',
        dependencies: { 'boundary-dep': '1.0.0', typescript: '1.0.0' },
      },
    );

    const missing = join(base, 'missing');
    mkdirSync(join(missing, 'tree'), { recursive: true });
    writeFileSync(join(missing, 'tree', 'package.json'), manifest);
    writeFileSync(join(missing, 'tree', 'pnpm-lock.yaml'), lockfile);
    await expect(
      prepareOfflineFixtureDependencies(join(missing, 'tree'), missing, {
        pnpm: nativePnpm,
        pnpmPrefix,
        store: join(base, 'empty-store'),
      }),
    ).rejects.toThrow('offline-dependencies-unavailable');
    expect(existsSync(join(missing, 'tree', 'node_modules'))).toBe(false);
    expect(() =>
      installConsumer(join(base, 'missing-fixture'), join(base, 'empty-fixture-store')),
    ).toThrow('ERR_PNPM_NO_OFFLINE_TARBALL');
    expect(() =>
      installConsumer(
        join(base, 'mismatch'),
        store,
        JSON.stringify({ dependencies: { 'boundary-dep': '2.0.0', typescript: '1.0.0' } }),
      ),
    ).toThrow('ERR_PNPM_OUTDATED_LOCKFILE');
    console.info(
      'H1 reached: fixture-only helper empty-cache failure, consumer missing cache and frozen importer mismatch assertions',
    );
    expect(() =>
      subjectDependencyPlan(
        manifest,
        stringify({
          ...lock,
          packages: {
            'boundary-dep@1.0.0': {
              resolution: {
                integrity: `sha512-${'a'.repeat(86)}==`,
                tarball: 'https://rejected.invalid/dep.tgz',
              },
            },
          },
        }),
      ),
    ).toThrow('origin');
    expect(existsSync(sentinel)).toBe(false);
    console.info('H1 reached: rejected origin and final canary assertions');
  });
});
