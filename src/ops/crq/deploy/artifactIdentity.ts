/**
 * Port of `prepare-host.py` `artifact_identity` and the `package-runner.py`
 * pieces it reuses (`inventory`, `content_digest`, `validate_manifest`,
 * `validate_provenance`, `staging_facts`). Read-only: it compares the observed
 * tree with the manifest inventory and never executes the runner. Inactive and
 * unimported until the deploy binding uses it.
 *
 * Divergences from Python (each documented in the PR):
 * - a manifest or capability declaration is decoded as UTF-8 (a UTF-8 BOM is
 *   accepted); `json.loads(bytes)` would also detect UTF-16/32;
 * - `str.isdigit` is approximated by Unicode `Nd`;
 * - the Python-only failures (`AttributeError` on a non-object `package.json`)
 *   surface as {@link PythonExceptionError}, never as `ValueError`.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../policy/crq/jsonValue.js';
import { ledgerValueEqual } from '../../../policy/crq/ledger.js';
import { compareCodePoints, receiptJsonText } from '../../../policy/crq/pythonJson.js';

/** Python `ValueError` raised by `artifact_identity` and `ArtifactError`. */
export class ArtifactIdentityError extends Error {
  override readonly name = 'ValueError';
}
/** A Python exception that is not a `ValueError`/`OSError`: it escapes callers' handlers. */
export class PythonExceptionError extends Error {
  readonly pyType: string;
  constructor(pyType: string, message: string) {
    super(message);
    this.pyType = pyType;
  }
}

const SCHEMA_VERSION = 2;
const PROVENANCE_VERSION = 1;
export const MANIFEST_NAME = 'artifact-manifest.json';
const FS_EXT_VERSION = '2.1.1';
const NODE_MAJOR = 24;
const PLATFORM = 'linux';
const ARCH = 'x64';
export const REQUIRED_ENTRIES = [
  'dist/queue-runner/crq.js',
  'package.json',
  'node_modules/fs-ext/package.json',
  'node_modules/fs-ext/build/Release/fs_ext.node',
] as const;
const CAPABILITY_NAME = 'dist/queue-runner/capabilities.json';
const CAPABILITY_SCHEMA_VERSION = 1;
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const NODE_VERSION_RE = /^v\p{Nd}+\.\p{Nd}+\.\p{Nd}+$/u;
const VERSION_RE = /^\p{Nd}+\.\p{Nd}+\.\p{Nd}+$/u;
const ELF = new JsonObject([
  ['class', JsonNumber.int(2)],
  ['data', JsonNumber.int(1)],
  ['machine', JsonNumber.int(62)],
]);

const fail = (message: string): never => {
  throw new ArtifactIdentityError(message);
};
const isObject = (value: unknown): value is JsonObject => value instanceof JsonObject;
const num = (n: number): JsonValue => JsonNumber.int(n);
/** Python `value == n`, so `True`, `1.0` and `1` all match. */
const equalsInt = (value: JsonValue | undefined, n: number): boolean =>
  value !== undefined && ledgerValueEqual(value, num(n));
const sameKeys = (object: JsonObject, keys: readonly string[]): boolean =>
  object.entries.length === keys.length && keys.every((key) => object.has(key));
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const sorted = (values: readonly string[]): string[] => [...values].sort(compareCodePoints);

/** Python `json.loads` of bytes or text; any failure is a `ValueError`. */
export function loadJson(raw: Uint8Array | string): JsonValue {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else {
    const bytes = Buffer.from(raw);
    const body =
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      return fail('invalid UTF-8');
    }
  }
  try {
    return parseJsonValue(text);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'invalid JSON');
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

type Kind = 'symlink' | 'directory' | 'file';
/** `Path.is_symlink`/`is_dir`/`is_file`, which swallow errors into false. */
async function entryKind(path: string): Promise<Kind | null> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return 'symlink';
  } catch {
    // is_symlink() is false when the path cannot be examined.
  }
  try {
    const info = await stat(path);
    if (info.isDirectory()) return 'directory';
    if (info.isFile()) return 'file';
  } catch {
    // Broken links and permission errors are not directories or files.
  }
  return null;
}
const isDir = async (path: string): Promise<boolean> =>
  (await stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  )) as boolean;
const isFile = async (path: string): Promise<boolean> =>
  (await stat(path).then(
    (s) => s.isFile(),
    () => false,
  )) as boolean;
const isSymlink = async (path: string): Promise<boolean> =>
  (await lstat(path).then(
    (s) => s.isSymbolicLink(),
    () => false,
  )) as boolean;

interface Walked {
  readonly path: string;
  readonly relative: string;
  readonly kind: Kind;
}
/** `os.walk(followlinks=False)`: a symlinked directory is an entry, never a subtree. */
async function walk(directory: string, prefix: string, out: Walked[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return; // os.walk ignores unreadable directories.
  }
  const dirs: string[] = [];
  const files: string[] = [];
  for (const name of names) ((await isDir(`${directory}/${name}`)) ? dirs : files).push(name);
  for (const name of [...sorted(dirs), ...sorted(files)]) {
    const path = `${directory}/${name}`;
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    const kind = await entryKind(path);
    if (kind === null) return fail(`unsupported staging entry: ${relative}`);
    out.push({ path, relative, kind });
  }
  for (const name of sorted(dirs)) {
    const path = `${directory}/${name}`;
    if (!(await isSymlink(path))) await walk(path, prefix === '' ? name : `${prefix}/${name}`, out);
  }
}

/** `package.inventory(root, exclude=...)`: entries sorted by code-point path. */
export async function inventory(
  rootInput: string,
  exclude: readonly string[] = [],
): Promise<JsonObject[]> {
  const root = await realpath(rootInput);
  if (!(await isDir(root))) return fail('staging root must be a directory');
  const walked: Walked[] = [];
  await walk(root, '', walked);
  const entries: JsonObject[] = [];
  for (const { path, relative, kind } of walked) {
    if (exclude.includes(relative)) continue;
    if (kind === 'symlink') {
      const target = await readlink(path);
      if (target.startsWith('/')) return fail(`absolute symlink: ${relative}`);
      try {
        const resolved = await realpath(path);
        if (resolved !== root && !resolved.startsWith(root === '/' ? '/' : `${root}/`))
          throw new Error('escape');
      } catch {
        return fail(`escaping or broken symlink: ${relative}`);
      }
      entries.push(
        new JsonObject([
          ['path', relative],
          ['type', 'symlink'],
          ['target', target],
        ]),
      );
    } else if (kind === 'file') {
      entries.push(
        new JsonObject([
          ['path', relative],
          ['type', 'file'],
          ['sha256', await sha256File(path)],
          ['mode', num((await stat(path)).mode & 0o777)],
        ]),
      );
    } else {
      entries.push(
        new JsonObject([
          ['path', relative],
          ['type', 'directory'],
          ['mode', num((await stat(path)).mode & 0o777)],
        ]),
      );
    }
  }
  return entries.sort((a, b) =>
    compareCodePoints(a.get('path') as string, b.get('path') as string),
  );
}

/** `package.content_digest`: sha256 of the canonical (sorted, compact, ASCII) JSON. */
export function contentDigest(entries: readonly JsonValue[]): string {
  const ordered = [...entries].sort((a, b) =>
    compareCodePoints(
      String((a as JsonObject).get('path') as string),
      String((b as JsonObject).get('path') as string),
    ),
  );
  return createHash('sha256').update(receiptJsonText(ordered)).digest('hex');
}

/** Python `str.isdigit` approximated by `Nd`; `int()` of such a run. */
function digitValue(char: string): number {
  let count = 0;
  let cp = char.codePointAt(0) as number;
  while (cp > 0 && /^\p{Nd}$/u.test(String.fromCodePoint(cp - 1))) {
    cp -= 1;
    count += 1;
  }
  return count % 10;
}
function pyInt(digits: string): number {
  let value = 0;
  for (const char of digits) value = value * 10 + digitValue(char);
  return value;
}

async function readText(path: string): Promise<JsonValue> {
  const raw = await readFile(path);
  try {
    return parseJsonValue(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'invalid JSON');
  }
}
const isOsError = (error: unknown): boolean =>
  error instanceof Error && typeof (error as { code?: unknown }).code === 'string';

async function fsExtFacts(rootInput: string): Promise<JsonObject> {
  const root = await realpath(rootInput);
  const packagePath = `${root}/node_modules/fs-ext/package.json`;
  const nativePath = `${root}/node_modules/fs-ext/build/Release/fs_ext.node`;
  let dependency: JsonValue;
  let header: Buffer;
  try {
    dependency = await readText(packagePath);
    const handle = await open(nativePath, 'r');
    try {
      header = Buffer.alloc(20);
      const { bytesRead } = await handle.read(header, 0, 20, 0);
      header = header.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ArtifactIdentityError || isOsError(error))
      return fail('staging tree lacks built fs-ext');
    throw error;
  }
  if (!isObject(dependency) || dependency.get('version') !== FS_EXT_VERSION)
    return fail(`staging tree must contain fs-ext ${FS_EXT_VERSION}`);
  if (
    header.length < 20 ||
    !header.subarray(0, 5).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02])) ||
    header[5] !== 1 ||
    header[18] !== 0x3e ||
    header[19] !== 0x00
  )
    return fail('fs-ext must be a little-endian linux-x64 ELF binary');
  return new JsonObject([
    ['version', FS_EXT_VERSION],
    ['native_sha256', await sha256File(nativePath)],
    ['elf', ELF],
  ]);
}

async function dependencyInventory(rootInput: string): Promise<JsonObject> {
  const nodeModules = `${await realpath(rootInput)}/node_modules`;
  if (!(await isDir(nodeModules))) return fail('staging tree lacks node_modules');
  const dependencies = new Map<string, string>();
  for (const name of sorted(await readdir(nodeModules))) {
    if (name.startsWith('.')) continue;
    const entry = `${nodeModules}/${name}`;
    const candidates =
      name.startsWith('@') && (await isDir(entry))
        ? sorted(await readdir(entry)).map((child) => `${entry}/${child}`)
        : [entry];
    for (const candidate of candidates) {
      const packagePath = `${candidate}/package.json`;
      if (!(await isFile(packagePath))) continue;
      let document: JsonValue;
      try {
        document = await readText(packagePath);
      } catch (error) {
        if (error instanceof ArtifactIdentityError || isOsError(error))
          return fail(`unreadable dependency metadata: ${packagePath}`);
        throw error;
      }
      if (!isObject(document))
        throw new PythonExceptionError('AttributeError', "object has no attribute 'get'");
      const dependencyName = document.get('name');
      const version = document.get('version');
      if (typeof dependencyName !== 'string' || typeof version !== 'string')
        return fail(`dependency metadata lacks name/version: ${packagePath}`);
      dependencies.set(dependencyName, version);
    }
  }
  if (dependencies.size === 0) return fail('staging tree has no production dependencies');
  return new JsonObject(
    sorted([...dependencies.keys()]).map((k) => [k, dependencies.get(k) as string]),
  );
}

/** `package.staging_facts`. */
export async function stagingFacts(
  root: string,
): Promise<{ dependencies: JsonObject; fsExt: JsonObject }> {
  const dependencies = await dependencyInventory(root);
  return { dependencies, fsExt: await fsExtFacts(root) };
}

const checkString = (value: JsonValue | undefined, label: string): string => {
  if (typeof value !== 'string' || value === '')
    return fail(`provenance ${label} must be a non-empty string`);
  return value;
};
const checkDigest = (value: JsonValue | undefined, label: string): string => {
  if (typeof value !== 'string' || !DIGEST_RE.test(value))
    return fail(`provenance ${label} must be a lowercase sha256`);
  return value;
};

/** `package.validate_provenance` without the staging comparison (see {@link provenanceMatchesStaging}). */
export function validateProvenance(
  provenance: JsonValue | undefined,
  sha: string | null,
): JsonObject {
  if (!isObject(provenance)) return fail('provenance must be an object');
  if (
    !sameKeys(provenance, [
      'schema_version',
      'source_sha',
      'lockfile_sha256',
      'runtime',
      'toolchain',
      'dependencies',
      'fs_ext',
    ])
  )
    return fail('provenance has unexpected fields');
  if (!equalsInt(provenance.get('schema_version'), PROVENANCE_VERSION))
    return fail(`provenance schema_version must be ${String(PROVENANCE_VERSION)}`);
  const sourceSha = checkString(provenance.get('source_sha'), 'source_sha');
  if (!SHA_RE.test(sourceSha)) return fail('provenance source_sha must be a full commit SHA');
  if (sha !== null && sourceSha !== sha)
    return fail('provenance source_sha does not match the requested source identity');
  checkDigest(provenance.get('lockfile_sha256'), 'lockfile_sha256');
  const runtime = provenance.get('runtime');
  if (!isObject(runtime)) return fail('provenance runtime must be an object');
  const nodeVersion = checkString(runtime.get('node_version'), 'runtime.node_version');
  if (!NODE_VERSION_RE.test(nodeVersion))
    return fail('provenance runtime.node_version must be a full Node version');
  if (!equalsInt(runtime.get('node_major'), NODE_MAJOR))
    return fail(`provenance runtime.node_major must be ${String(NODE_MAJOR)}`);
  if (!equalsInt(runtime.get('node_major'), pyInt(nodeVersion.slice(1).split('.')[0] as string)))
    return fail('provenance runtime.node_version and node_major disagree');
  const nodeAbi = checkString(runtime.get('node_abi'), 'runtime.node_abi');
  if (!/^\p{Nd}+$/u.test(nodeAbi)) return fail('provenance runtime.node_abi must be numeric');
  if (runtime.get('platform') !== PLATFORM || runtime.get('arch') !== ARCH)
    return fail(`provenance runtime must be ${PLATFORM}-${ARCH}`);
  const toolchain = provenance.get('toolchain');
  if (!isObject(toolchain)) return fail('provenance toolchain must be an object');
  const pnpm = checkString(toolchain.get('pnpm_version'), 'toolchain.pnpm_version');
  if (!VERSION_RE.test(pnpm))
    return fail('provenance toolchain.pnpm_version must be a full version');
  for (const key of ['install_command', 'build_command', 'deploy_command'])
    checkString(toolchain.get(key), `toolchain.${key}`);
  const dependencies = provenance.get('dependencies');
  if (!isObject(dependencies) || dependencies.entries.length === 0)
    return fail('provenance dependencies must be a non-empty object');
  for (const [name, version] of dependencies.entries)
    if (name === '' || typeof version !== 'string' || version === '')
      return fail('provenance dependencies must map names to versions');
  if (dependencies.get('fs-ext') !== FS_EXT_VERSION)
    return fail(`provenance dependencies must contain fs-ext ${FS_EXT_VERSION}`);
  const fsExt = provenance.get('fs_ext');
  if (!isObject(fsExt)) return fail('provenance fs_ext must be an object');
  if (fsExt.get('version') !== FS_EXT_VERSION)
    return fail(`provenance fs_ext.version must be ${FS_EXT_VERSION}`);
  checkDigest(fsExt.get('native_sha256'), 'fs_ext.native_sha256');
  const elf = fsExt.get('elf');
  if (elf === undefined || !ledgerValueEqual(elf, ELF))
    return fail('provenance fs_ext.elf must be little-endian linux-x64');
  return provenance;
}

/** The `staging` half of `validate_provenance`. */
export async function provenanceMatchesStaging(
  provenance: JsonObject,
  staging: string,
): Promise<void> {
  const facts = await stagingFacts(staging);
  if (!ledgerValueEqual(provenance.get('dependencies') as JsonValue, facts.dependencies))
    return fail('provenance dependencies do not match the staging tree');
  if (!ledgerValueEqual(provenance.get('fs_ext') as JsonValue, facts.fsExt))
    return fail('provenance fs_ext does not match the staging tree');
}

function validateEntry(entry: JsonValue): void {
  if (!isObject(entry)) return fail('manifest file entries must be objects');
  const path = entry.get('path');
  if (typeof path !== 'string' || path === '')
    return fail('manifest entry path must be a non-empty string');
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  if (path.startsWith('/') || parts.includes('..'))
    return fail(`manifest entry path is not relative: ${path}`);
  const kind = entry.get('type');
  if (kind === 'directory') {
    if (!sameKeys(entry, ['path', 'type', 'mode']))
      return fail(`directory entry has unexpected fields: ${path}`);
  } else if (kind === 'file') {
    if (!sameKeys(entry, ['path', 'type', 'sha256', 'mode']))
      return fail(`file entry has unexpected fields: ${path}`);
    const digest = entry.get('sha256');
    if (typeof digest !== 'string' || !DIGEST_RE.test(digest))
      return fail(`file entry digest is invalid: ${path}`);
  } else if (kind === 'symlink') {
    if (!sameKeys(entry, ['path', 'type', 'target']))
      return fail(`symlink entry has unexpected fields: ${path}`);
    const target = entry.get('target');
    if (typeof target !== 'string' || target === '' || target.startsWith('/'))
      return fail(`symlink target is not relative: ${path}`);
    const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
    const resolved = posix.normalize(`${parent}/${target}`).replace(/(?<=.)\/+$/, '');
    if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/'))
      return fail(`symlink target escapes the archive: ${path}`);
    return;
  } else return fail(`manifest entry type is unsupported: ${path}`);
  const mode = entry.get('mode');
  if (
    !(mode instanceof JsonNumber) ||
    mode.kind !== 'int' ||
    (mode.integer as bigint) < 0n ||
    (mode.integer as bigint) > 0o777n
  )
    return fail(`manifest entry mode is invalid: ${path}`);
}

/** `package.validate_manifest`. */
export function validateManifest(manifest: JsonValue): JsonObject {
  if (!isObject(manifest) || !equalsInt(manifest.get('schema_version'), SCHEMA_VERSION))
    return fail(`manifest schema_version must be ${String(SCHEMA_VERSION)}`);
  if (
    !sameKeys(manifest, ['schema_version', 'source_sha', 'content_sha256', 'provenance', 'files'])
  )
    return fail('manifest has unexpected fields');
  const sourceSha = checkString(manifest.get('source_sha'), 'source_sha');
  if (!SHA_RE.test(sourceSha)) return fail('manifest source_sha must be a full commit SHA');
  const provenance = validateProvenance(manifest.get('provenance'), sourceSha);
  if (provenance.get('source_sha') !== sourceSha)
    return fail('manifest source_sha and provenance disagree');
  const files = manifest.get('files');
  if (!Array.isArray(files) || files.length === 0)
    return fail('manifest files must be a non-empty list');
  const paths = new Set<string>();
  for (const entry of files) {
    validateEntry(entry);
    const path = (entry as JsonObject).get('path') as string;
    if (paths.has(path)) return fail(`manifest contains a duplicate path: ${path}`);
    paths.add(path);
  }
  if (manifest.get('content_sha256') !== contentDigest(files))
    return fail('manifest content_sha256 does not match its file inventory');
  return manifest;
}

/**
 * `artifact_identity(artifact_root, runtime)`. `unitCommands` is
 * `set(UNIT_COMMANDS.values())`, injected so this module stays independent of
 * the unit renderer.
 */
export async function artifactIdentity(
  artifactRoot: string,
  runtime: string,
  unitCommands: ReadonlySet<string>,
): Promise<JsonValue> {
  if (runtime === 'python') return null;
  if (!/^node:[0-9a-f]{40}$/.test(runtime))
    return fail('runtime must be python or node:<full SHA>');
  const root = artifactRoot;
  if ((await isSymlink(root)) || !(await isDir(root)))
    return fail('artifact root is not a regular directory');
  const manifestPath = `${root}/${MANIFEST_NAME}`;
  if ((await isSymlink(manifestPath)) || !(await isFile(manifestPath)))
    return fail('artifact manifest is unavailable');
  const manifestRaw = await readFile(manifestPath);
  let manifest: JsonObject;
  try {
    manifest = validateManifest(loadJson(manifestRaw));
  } catch (error) {
    if (error instanceof ArtifactIdentityError) return fail('artifact manifest is invalid');
    throw error;
  }
  if (manifest.get('source_sha') !== runtime.slice(5))
    return fail('artifact source SHA does not match the node pointer');
  for (const required of REQUIRED_ENTRIES)
    if (!(await isFile(`${root}/${required}`)))
      return fail(`artifact lacks required package entry: ${required}`);
  let observed: JsonObject[];
  try {
    observed = await inventory(root, [MANIFEST_NAME]);
  } catch (error) {
    if (error instanceof ArtifactIdentityError || isOsError(error))
      return fail('artifact inventory is invalid');
    throw error;
  }
  if (!ledgerValueEqual(observed, manifest.get('files') as JsonValue))
    return fail('artifact inventory does not match the manifest');
  const observedDigest = contentDigest(observed);
  if (observedDigest !== manifest.get('content_sha256'))
    return fail('artifact content digest does not match the manifest');
  const provenance = manifest.get('provenance') as JsonObject;
  try {
    await provenanceMatchesStaging(provenance, root);
  } catch (error) {
    if (error instanceof ArtifactIdentityError || isOsError(error))
      return fail('artifact provenance does not match the observed tree');
    throw error;
  }
  const entry = observed.find((item) => item.get('path') === 'dist/queue-runner/crq.js');
  if (entry === undefined || entry.get('type') !== 'file')
    return fail('artifact lacks the runner entry point');
  const capabilityEntry = observed.find((item) => item.get('path') === CAPABILITY_NAME);
  let capabilities: string[] = [];
  if (capabilityEntry !== undefined) {
    if (capabilityEntry.get('type') !== 'file')
      return fail('artifact capability declaration is not a regular file');
    let capabilityRaw: Buffer;
    try {
      capabilityRaw = await readFile(`${root}/${CAPABILITY_NAME}`);
    } catch (error) {
      if (isOsError(error)) return fail('artifact capability declaration is unreadable');
      throw error;
    }
    if (sha256(capabilityRaw) !== capabilityEntry.get('sha256'))
      return fail('artifact capability declaration changed after inventory');
    let declaration: JsonValue;
    try {
      declaration = loadJson(capabilityRaw);
    } catch {
      return fail('artifact capability declaration is invalid');
    }
    if (!isObject(declaration) || !sameKeys(declaration, ['schema_version', 'commands']))
      return fail('artifact capability declaration has unexpected fields');
    if (!equalsInt(declaration.get('schema_version'), CAPABILITY_SCHEMA_VERSION))
      return fail('artifact capability schema version is unsupported');
    const commands = declaration.get('commands');
    if (!Array.isArray(commands) || !commands.every((c) => typeof c === 'string'))
      return fail('artifact capability commands must be a list of strings');
    const names = commands as string[];
    if (new Set(names).size !== names.length)
      return fail('artifact capability commands contain duplicates');
    if (!names.every((name) => unitCommands.has(name)))
      return fail('artifact capability declares an unknown unit command');
    capabilities = sorted(names);
  }
  const facts = provenance.get('runtime') as JsonObject;
  return new JsonObject([
    ['kind', 'node'],
    ['runtime', runtime],
    ['source_sha', manifest.get('source_sha') as JsonValue],
    ['declared_content_sha256', manifest.get('content_sha256') as JsonValue],
    ['observed_content_sha256', observedDigest],
    ['manifest_sha256', sha256(manifestRaw)],
    ['node_version', facts.get('node_version') as JsonValue],
    ['node_major', facts.get('node_major') as JsonValue],
    ['node_abi', facts.get('node_abi') as JsonValue],
    ['platform', facts.get('platform') as JsonValue],
    ['arch', facts.get('arch') as JsonValue],
    ['crq_js_sha256', entry.get('sha256') as JsonValue],
    ['capabilities', capabilities],
    ['verification', 'whole-artifact-inventory-matched'],
    ['authenticity', 'not-established'],
  ]);
}
