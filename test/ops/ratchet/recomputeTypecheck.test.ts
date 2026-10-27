// W1.7: the trusted compiler counts errors in an attribute-free head tree.
// A local Git repo and the installed TypeScript package exercise the complete
// extraction + toolchain path without a network service or fake diagnostics.
import { execFile, execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  accessSync,
  chmodSync,
  constants,
  closeSync,
  openSync,
  readSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { isAlias, parseAllDocuments, stringify, visit } from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { recomputeTypecheck } from '../../../src/ops/ratchet/recomputeTypecheck.js';
import { extractTreeAttributeFree } from '../../../src/adapters/git/ratchetGit.js';

// All dependency preparation below is a test-only prototype, not a production path.
const DECLARATIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const LOCK_LIMIT = 4 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('incompatible-lockfile');
  }
  return value as Record<string, unknown>;
}

/** Bounded YAML 1.2 core, with no aliases, custom tags or duplicate keys. */
function documents(text: string): unknown[] {
  if (Buffer.byteLength(text) > LOCK_LIMIT) throw new Error('incompatible-lockfile: size');
  const docs = parseAllDocuments(text, { schema: 'core', uniqueKeys: true });
  if (docs.length < 1 || docs.length > 2) throw new Error('incompatible-lockfile: documents');
  let nodes = 0;
  return docs.map((doc) => {
    if (doc.errors.length || doc.warnings.length) throw new Error('incompatible-lockfile: YAML');
    visit(doc, (_key, node, path) => {
      if (++nodes > 100_000 || path.length > 40 || isAlias(node)) {
        throw new Error('incompatible-lockfile: complexity');
      }
      if (
        node !== null &&
        typeof node === 'object' &&
        (('tag' in node && node.tag !== undefined) ||
          ('anchor' in node && node.anchor !== undefined))
      ) {
        throw new Error('incompatible-lockfile: tags/anchors');
      }
    });
    return doc.toJS({ maxAliasCount: 0 }) as unknown;
  });
}

interface FixtureDependencyBoundary {
  /** Absolute provisioned pnpm executable or trusted Node for its JS entrypoint. */
  pnpm: string;
  pnpmPrefix: string[];
  /** Explicit offline store, never inferred from the ambient environment. */
  store: string;
}

/** Bind dependency declarations to the subject lock's exact root importer, without judging D11. */
function subjectDependencyPlan(
  manifestText: string,
  lockText: string,
): {
  manifest: string;
  lockfile: string;
} {
  if (Buffer.byteLength(manifestText) > 256 * 1024) throw new Error('incompatible-manifest');
  // JSON.parse establishes JSON syntax; YAML additionally refuses duplicate JSON keys.
  const manifest = record(JSON.parse(manifestText));
  documents(manifestText);
  const docs = documents(lockText).map(record);
  if (docs.length === 2) {
    // pnpm 12's separate package-manager document is not an install input.
    const manager = record(record(docs[0]?.['importers'])['.']);
    if (Object.keys(record(manager['configDependencies'])).length !== 0) {
      throw new Error('unsupported-lockfile: config dependencies');
    }
    if (Object.keys(record(docs[0]?.['importers'])).join() !== '.') {
      throw new Error('unsupported-lockfile: importers');
    }
  }
  const lock = docs.at(-1)!;
  const allowed = new Set(['lockfileVersion', 'settings', 'importers', 'packages', 'snapshots']);
  if (lock['lockfileVersion'] !== '9.0' || Object.keys(lock).some((key) => !allowed.has(key))) {
    throw new Error('incompatible-lockfile: shape');
  }
  const importers = record(lock['importers']);
  if (Object.keys(importers).join() !== '.') throw new Error('unsupported-lockfile: importers');
  const root = record(importers['.']);
  if (
    Object.keys(root).some((key) => !DECLARATIONS.includes(key as (typeof DECLARATIONS)[number]))
  ) {
    throw new Error('unsupported-lockfile: importer');
  }
  const sanitized: Record<string, unknown> = { name: 'cq-isolated-subject', version: '0.0.0' };
  for (const kind of DECLARATIONS) {
    const declared = record(manifest[kind] ?? {});
    const locked = record(root[kind] ?? {});
    if (Object.keys(declared).sort().join() !== Object.keys(locked).sort().join()) {
      throw new Error('incompatible-lockfile: declarations');
    }
    for (const [name, specifier] of Object.entries(declared)) {
      const entry = record(locked[name]);
      if (
        typeof specifier !== 'string' ||
        !/^[~^]?[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(specifier) ||
        entry['specifier'] !== specifier ||
        typeof entry['version'] !== 'string' ||
        !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+(][a-zA-Z0-9@/_.()+-]+)?$/.test(entry['version'])
      )
        throw new Error('unsupported-lockfile: dependency');
    }
    if (Object.keys(declared).length) sanitized[kind] = declared;
  }
  const packages = record(lock['packages'] ?? {});
  if (Object.keys(packages).length > 2000) throw new Error('incompatible-lockfile: packages');
  for (const [key, value] of Object.entries(packages)) {
    if (
      !/^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(key)
    ) {
      throw new Error('unsupported-lockfile: package');
    }
    const resolution = record(record(value)['resolution']);
    if (
      typeof resolution['integrity'] !== 'string' ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(resolution['integrity'])
    ) {
      throw new Error('unsupported-lockfile: missing-integrity');
    }
    if (Object.keys(resolution).some((field) => !['integrity', 'tarball'].includes(field))) {
      throw new Error('unsupported-lockfile: resolution');
    }
    if (resolution['tarball'] !== undefined) {
      const url = new URL(String(resolution['tarball']));
      if (
        url.origin !== 'https://registry.npmjs.org' ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      ) {
        throw new Error('unsupported-lockfile: origin');
      }
    }
  }
  return { manifest: JSON.stringify(sanitized), lockfile: stringify(lock) };
}

/** No ambient credential, proxy, resolver, pnpm, Node loader or user configuration survives. */
function dependencyChildEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    PATH: dirname(process.execPath),
    CI: 'true',
  };
}

/** Fixture prototype only: only its empty-cache failure is exercised below.
 * The separate successful consumer does not prove this helper succeeds.
 * --trust-lockfile bypasses resolution verifiers and is never production authority. */
async function prepareOfflineFixtureDependencies(
  tree: string,
  scratch: string,
  boundary: FixtureDependencyBoundary,
): Promise<void> {
  if (!isAbsolute(boundary.pnpm) || !isAbsolute(boundary.store))
    throw new Error('invalid-trusted-boundary');
  const manifest = await readFile(join(tree, 'package.json'), 'utf8');
  const lockfile = await readFile(join(tree, 'pnpm-lock.yaml'), 'utf8');
  const plan = subjectDependencyPlan(manifest, lockfile);
  const deps = join(scratch, 'dependencies');
  const home = join(scratch, 'empty-home');
  await mkdir(deps);
  await mkdir(home);
  await writeFile(join(deps, 'package.json'), plan.manifest);
  await writeFile(join(deps, 'pnpm-lock.yaml'), plan.lockfile);
  await writeFile(
    join(deps, 'pnpm-workspace.yaml'),
    'autoInstallPeers: false\nvirtualStoreType: project\nmanagePackageManagerVersions: false\n',
  );
  await new Promise<void>((ok, fail) => {
    execFile(
      boundary.pnpm,
      [
        ...boundary.pnpmPrefix,
        'install',
        '--offline',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--trust-lockfile',
        '--store-dir',
        boundary.store,
      ],
      { cwd: deps, env: dependencyChildEnv(home), timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        // Preserve only pnpm's fixed code, never subject-controlled log text.
        const code =
          `${stdout}\n${stderr}`.match(/\bERR_PNPM_[A-Z_]+\b/)?.[0] ?? 'INVOCATION_FAILED';
        if (error) fail(new Error(`offline-dependencies-unavailable: ${code}`));
        else ok();
      },
    );
  });
  await symlink(join(deps, 'node_modules'), join(tree, 'node_modules'), 'dir');
}

const fixtureGit = vi.hoisted(() => ({ executable: '' }));

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
        env: {
          PATH: '',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_REPLACE_OBJECTS: '1',
        },
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

const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

function verifiedExecutable(path: string): string {
  if (!isAbsolute(path)) throw new Error('fixture executable must be absolute');
  const executable = realpathSync(path);
  accessSync(executable, constants.X_OK);
  return executable;
}

// Discover only during trusted preflight, before subject configuration/canaries.
// No shell or SHELL is required, and no child executes a bare helper name.
function discoverHelper(name: string): string {
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    if (!existsSync(candidate)) continue;
    return verifiedExecutable(candidate);
  }
  throw new Error(`missing provisioned fixture helper: ${name}`);
}
const trustedGit = discoverHelper('git');
const trustedTar = discoverHelper('tar');
const trustedGzip = discoverHelper('gzip');
const trustedNode = verifiedExecutable(process.execPath);
// package.json has no engines; the checked-in ratchet workflow provisions Node24.
const repoManifest = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as {
  packageManager: string;
  engines?: unknown;
};
if (repoManifest.engines !== undefined)
  throw new Error('fixture Node engines contract needs review');
if (process.versions.node.split('.')[0] !== '24')
  throw new Error('fixture requires repository CI Node24');
const packageManager = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(repoManifest.packageManager);
if (!packageManager) throw new Error('unsupported repository packageManager contract');
const requiredPnpmVersion = packageManager[1]!;
// pnpm run/exec exports the provisioned entrypoint, avoiding mise/corepack shims.
const pnpmEntrypoint = verifiedExecutable(process.env['npm_execpath'] ?? '');
const header = Buffer.alloc(128);
const descriptor = openSync(pnpmEntrypoint, 'r');
try {
  readSync(descriptor, header, 0, header.length, 0);
} finally {
  closeSync(descriptor);
}
const isNativePnpm = header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
const isNodePnpm = /^#![^\n]*\bnode(?:\s|$)/.test(header.toString('utf8'));
if (!isNativePnpm && !isNodePnpm) throw new Error('unsupported provisioned pnpm launcher');
const nativePnpm = isNativePnpm ? pnpmEntrypoint : trustedNode;
const pnpmPrefix = isNativePnpm ? [] : [pnpmEntrypoint];
fixtureGit.executable = trustedGit;
console.info(
  'H1 preflight helpers:',
  JSON.stringify({
    git: trustedGit,
    tar: trustedTar,
    gzip: trustedGzip,
    node: trustedNode,
    nodeVersion: process.versions.node,
    pnpmEntrypoint,
    pnpmExecutable: nativePnpm,
    pnpmPrefix,
    requiredPnpmVersion,
    packageManager: repoManifest.packageManager,
  }),
);

function git(cwd: string, args: string[]): string {
  return execFileSync(trustedGit, args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

let tmp: string;
let repo: string;
let errorCommit: string;
let cleanCommit: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cq-ratchet-recompute-'));
  repo = join(tmp, 'trust');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.test']);
  git(repo, ['config', 'user.name', 'test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, '.gitattributes'), 'sample.ts export-ignore\n');
  writeFileSync(
    join(repo, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, types: [], skipLibCheck: true },
      files: ['sample.ts'],
    }),
  );
  writeFileSync(join(repo, 'sample.ts'), 'const amount: number = "wrong";\n');
  // The trusted compiler is outside the committed head tree. The recompute
  // links this install beside its extraction; it never installs head deps.
  symlinkSync(join(process.cwd(), 'node_modules'), join(repo, 'node_modules'), 'dir');
  git(repo, ['add', '.gitignore', '.gitattributes', 'tsconfig.json', 'sample.ts']);
  git(repo, ['commit', '-q', '-m', 'one type error']);
  errorCommit = git(repo, ['rev-parse', 'HEAD']);

  writeFileSync(join(repo, 'sample.ts'), 'const amount: number = 1;\n');
  git(repo, ['add', 'sample.ts']);
  git(repo, ['commit', '-q', '-m', 'fix type error']);
  cleanCommit = git(repo, ['rev-parse', 'HEAD']);
}, 60_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => vi.unstubAllEnvs());

describe('recomputeTypecheck', { timeout: 60_000 }, () => {
  test('counts a pinned head error despite export-ignore, then a clean commit', async () => {
    const scratchWithError = join(tmp, 'scratch-error');
    const bad = await recomputeTypecheck({
      repo,
      subject: errorCommit,
      scratch: scratchWithError,
    });
    expect(bad.status).toBe('ok');
    if (bad.status !== 'ok') throw new Error('expected a counted type error');
    expect(bad.value).toMatchObject({
      count: 1,
      subject: errorCommit,
      files: 4,
      skipped: 0,
    });
    expect(bad.value.exitCode).toBeGreaterThan(0);
    expect(readFileSync(join(scratchWithError, 'tree', 'sample.ts'), 'utf8')).toContain('"wrong"');
    expect(existsSync(join(scratchWithError, 'node_modules', 'typescript', 'bin', 'tsc'))).toBe(
      true,
    );

    const good = await recomputeTypecheck({
      repo,
      subject: cleanCommit,
      scratch: join(tmp, 'scratch-clean'),
    });
    expect(good.status).toBe('ok');
    if (good.status !== 'ok') throw new Error('expected a clean count');
    expect(good.value).toMatchObject({
      count: 0,
      subject: cleanCommit,
      files: 4,
      skipped: 0,
      exitCode: 0,
    });
  });

  test('refuses a non-empty scratch directory without replacing its contents', async () => {
    const scratch = join(tmp, 'scratch-occupied');
    mkdirSync(scratch);
    writeFileSync(join(scratch, 'marker'), 'keep');
    const result = await recomputeTypecheck({ repo, subject: cleanCommit, scratch });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failed result');
    expect(result.error).toMatch(/scratch .* is not empty/);
    expect(readFileSync(join(scratch, 'marker'), 'utf8')).toBe('keep');
    expect(existsSync(join(scratch, 'tree'))).toBe(false);
  });

  test('rejects an unsafe subject before creating scratch', async () => {
    const scratch = join(tmp, 'scratch-unsafe');
    const result = await recomputeTypecheck({ repo, subject: '--output=/tmp/x', scratch });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failed result');
    expect(result.error).toMatch(/refusing unsafe rev-parse revision/);
    expect(existsSync(scratch)).toBe(false);
  });
});

describe('offline subject dependency boundary', { timeout: 60_000 }, () => {
  test('real TS2307 is fixed by subject graph without executing scripts, hooks or compiler', async () => {
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
    const childEnv: unknown = JSON.parse(
      execFileSync(trustedNode, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
        cwd: tree,
        env: dependencyChildEnv(compilerHome),
        encoding: 'utf8',
      }),
    );
    expect(childEnv).not.toHaveProperty('CQ_BOUNDARY_SECRET');
    expect(childEnv).not.toHaveProperty('HTTPS_PROXY');
    expect(childEnv).not.toHaveProperty('npm_config_registry');
    expect(childEnv).not.toHaveProperty('NODE_OPTIONS');
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
