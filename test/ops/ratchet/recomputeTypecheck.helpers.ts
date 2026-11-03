// Split provenance: test/ops/ratchet/recomputeTypecheck.test.ts was split by
// subject into recomputeTypecheck.core.test.ts, recomputeTypecheck.preflight.test.ts,
// recomputeTypecheck.dependency-boundary.test.ts and
// recomputeTypecheck.launcher.test.ts; this module holds their shared fixtures.
import { execFile, execFileSync } from 'node:child_process';
import {
  accessSync,
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

export interface FixtureDependencyBoundary {
  /** Absolute provisioned pnpm executable or trusted Node for its JS entrypoint. */
  pnpm: string;
  pnpmPrefix: string[];
  /** Explicit offline store, never inferred from the ambient environment. */
  store: string;
}

/** Bind dependency declarations to the subject lock's exact root importer, without judging D11. */
export function subjectDependencyPlan(
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
export function dependencyChildEnv(home: string): NodeJS.ProcessEnv {
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
export async function prepareOfflineFixtureDependencies(
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

// This classifies a trusted provisioned entrypoint, not arbitrary subject bytes.
// Darwin support is limited to the thin64LE shape in official pnpm12.8.1 artifacts.
export function pnpmLauncherKind(
  header: Buffer,
  platform: NodeJS.Platform,
  arch: string,
): 'native' | 'node' {
  const elf = header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  if (elf) return 'native'; // Preserve existing ELF recognition.
  const cpu = arch === 'arm64' ? 0x0100000c : arch === 'x64' ? 0x01000007 : null;
  if (
    platform === 'darwin' &&
    cpu !== null &&
    header.length >= 32 &&
    header.readUInt32LE(0) === 0xfeedfacf &&
    header.readUInt32LE(4) === cpu &&
    header.readUInt32LE(12) === 2
  )
    return 'native';
  if (/^#![^\n]*\bnode(?:\s|$)/.test(header.toString('utf8'))) return 'node';
  throw new Error('unsupported provisioned pnpm launcher');
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
export const trustedGit = discoverHelper('git');

// Called only by boundary setup; import/collection needs no Node/pnpm preflight.
export function boundaryPreflight() {
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
  let headerBytes: number;
  try {
    headerBytes = readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  const isNativePnpm =
    pnpmLauncherKind(header.subarray(0, headerBytes), process.platform, process.arch) === 'native';
  const nativePnpm = isNativePnpm ? pnpmEntrypoint : trustedNode;
  const pnpmPrefix = isNativePnpm ? [] : [pnpmEntrypoint];
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
  return {
    trustedTar,
    trustedGzip,
    trustedNode,
    nativePnpm,
    pnpmPrefix,
    requiredPnpmVersion,
    pnpmEntrypoint,
  };
}

export function git(cwd: string, args: string[]): string {
  return execFileSync(trustedGit, args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

/** Per-file temp root; the original module-level `tmp` fixture. */
export function createTempRoot(): { tmp: string; dispose: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), 'cq-ratchet-recompute-'));
  return { tmp, dispose: () => rmSync(tmp, { recursive: true, force: true }) };
}

/** Per-file trusted head tree; the original module-level `repo` fixture. */
export function createTrustedRepo(tmp: string): {
  repo: string;
  errorCommit: string;
  cleanCommit: string;
} {
  const repo = join(tmp, 'trust');
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
  const errorCommit = git(repo, ['rev-parse', 'HEAD']);

  writeFileSync(join(repo, 'sample.ts'), 'const amount: number = 1;\n');
  git(repo, ['add', 'sample.ts']);
  git(repo, ['commit', '-q', '-m', 'fix type error']);
  const cleanCommit = git(repo, ['rev-parse', 'HEAD']);
  return { repo, errorCommit, cleanCommit };
}
