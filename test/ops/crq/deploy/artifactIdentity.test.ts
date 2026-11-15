import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../../src/policy/crq/jsonValue.js';
import {
  ArtifactIdentityError,
  PythonExceptionError,
  artifactIdentity,
  contentDigest,
  inventory,
  stagingFacts,
  loadJson,
  MANIFEST_NAME,
  validateManifest,
} from '../../../../src/ops/crq/deploy/artifactIdentity.js';

const SHA = 'a'.repeat(40);
const RUNTIME = `node:${SHA}`;
const UNITS = new Set(['tick', 'drain']);
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

const json = (value: unknown): JsonValue => parseJsonValue(JSON.stringify(value));
const put = async (root: string, path: string, data: Buffer | string, mode = 0o644) => {
  const full = join(root, path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, data);
  await chmod(full, mode);
};
const elf = (): Buffer => {
  const b = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(b);
  b[18] = 0x3e;
  return b;
};

type Doc = Record<string, unknown>;
const at = (doc: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>((node, key) => (node as Record<string | number, unknown>)[key], doc);
const setAt = (doc: unknown, path: (string | number)[], value: unknown): void => {
  (at(doc, ...path.slice(0, -1)) as Record<string | number, unknown>)[path[path.length - 1]!] =
    value;
};
interface Build {
  root: string;
  manifest: Doc;
}
const plain = (f: JsonObject): Record<string, unknown> =>
  Object.fromEntries(
    f.entries.map(([k, v]) => [
      k,
      typeof v === 'string' ? v : Number((v as { integer: bigint }).integer),
    ]),
  );
async function build(capabilities?: unknown): Promise<Build> {
  const root = await mkdtemp(join(tmpdir(), 'artid-'));
  roots.push(root);
  await put(root, 'dist/queue-runner/crq.js', 'console.log(1)\n');
  await put(root, 'package.json', '{"name":"crq"}');
  await put(root, 'node_modules/fs-ext/package.json', '{"name":"fs-ext","version":"2.1.1"}');
  await put(root, 'node_modules/fs-ext/build/Release/fs_ext.node', elf());
  if (capabilities !== undefined)
    await put(root, 'dist/queue-runner/capabilities.json', JSON.stringify(capabilities));
  const files = await inventory(root, [MANIFEST_NAME]);
  const native = files.find(
    (f) => f.get('path') === 'node_modules/fs-ext/build/Release/fs_ext.node',
  )!;
  const manifest = {
    schema_version: 2,
    source_sha: SHA,
    content_sha256: contentDigest(files),
    provenance: {
      schema_version: 1,
      source_sha: SHA,
      lockfile_sha256: 'b'.repeat(64),
      runtime: {
        node_version: 'v24.1.0',
        node_major: 24,
        node_abi: '137',
        platform: 'linux',
        arch: 'x64',
      },
      toolchain: {
        pnpm_version: '10.1.0',
        install_command: 'i',
        build_command: 'b',
        deploy_command: 'd',
      },
      dependencies: { 'fs-ext': '2.1.1' },
      fs_ext: {
        version: '2.1.1',
        native_sha256: native.get('sha256'),
        elf: { class: 2, data: 1, machine: 62 },
      },
    },
    files: files.map(plain),
  };
  await write(root, manifest);
  return { root, manifest };
}
const write = (root: string, manifest: unknown) =>
  writeFile(join(root, MANIFEST_NAME), JSON.stringify(manifest));
const rejects = (p: Promise<unknown>, message: string) =>
  expect(p).rejects.toThrow(new RegExp(message));

describe('artifactIdentity', () => {
  test('python runtime has no identity', async () => {
    expect(await artifactIdentity('/nonexistent', 'python', UNITS)).toBeNull();
  });
  test('rejects a malformed runtime pointer', async () => {
    await rejects(artifactIdentity('/x', 'node:abc', UNITS), 'runtime must be python or node');
  });
  test('verifies a whole artifact and reports its identity', async () => {
    const { root, manifest } = await build({ schema_version: 1, commands: ['tick', 'drain'] });
    const id = (await artifactIdentity(root, RUNTIME, UNITS)) as JsonObject;
    expect(id.get('kind')).toBe('node');
    expect(id.get('observed_content_sha256')).toBe(manifest.content_sha256);
    expect(id.get('node_version')).toBe('v24.1.0');
    expect(id.get('verification')).toBe('whole-artifact-inventory-matched');
    expect(id.get('capabilities')).toEqual(['drain', 'tick']);
  });
  test('no capability file means no capabilities', async () => {
    const { root } = await build();
    expect(
      ((await artifactIdentity(root, RUNTIME, UNITS)) as JsonObject).get('capabilities'),
    ).toEqual([]);
  });
  test('refuses a symlinked or missing root and manifest', async () => {
    const { root } = await build();
    const link = `${root}-link`;
    await symlink(root, link);
    roots.push(link);
    await rejects(artifactIdentity(link, RUNTIME, UNITS), 'not a regular directory');
    await rm(join(root, MANIFEST_NAME));
    await rejects(artifactIdentity(root, RUNTIME, UNITS), 'manifest is unavailable');
  });
  test('refuses a different node pointer', async () => {
    const { root } = await build();
    await rejects(
      artifactIdentity(root, `node:${'c'.repeat(40)}`, UNITS),
      'does not match the node pointer',
    );
  });
  test('refuses a changed file, an extra file and a changed mode', async () => {
    const a = await build();
    await put(a.root, 'dist/queue-runner/crq.js', 'tampered');
    await rejects(artifactIdentity(a.root, RUNTIME, UNITS), 'does not match the manifest');
    const b = await build();
    await put(b.root, 'extra.txt', 'x');
    await rejects(artifactIdentity(b.root, RUNTIME, UNITS), 'does not match the manifest');
    const c = await build();
    await chmod(join(c.root, 'package.json'), 0o600);
    await rejects(artifactIdentity(c.root, RUNTIME, UNITS), 'does not match the manifest');
  });
  test('refuses an absolute or escaping symlink', async () => {
    const a = await build();
    await symlink('/etc/passwd', join(a.root, 'abs'));
    await rejects(artifactIdentity(a.root, RUNTIME, UNITS), 'inventory is invalid');
    const b = await build();
    await symlink('../../outside', join(b.root, 'esc'));
    await rejects(artifactIdentity(b.root, RUNTIME, UNITS), 'inventory is invalid');
  });
  test('refuses unusable capability declarations', async () => {
    const cases: [unknown, string][] = [
      [{ schema_version: 1, commands: ['nope'] }, 'unknown unit command'],
      [{ schema_version: 1, commands: ['tick', 'tick'] }, 'duplicates'],
      [{ schema_version: 2, commands: [] }, 'schema version is unsupported'],
      [{ schema_version: 1, commands: [], extra: 1 }, 'unexpected fields'],
      [{ schema_version: 1, commands: [1] }, 'list of strings'],
      [[], 'unexpected fields'],
    ];
    for (const [declaration, message] of cases) {
      const { root } = await build(declaration);
      await rejects(artifactIdentity(root, RUNTIME, UNITS), message);
    }
  });
  test('refuses provenance that disagrees with the staged dependencies', async () => {
    const { root, manifest } = await build();
    setAt(manifest, ['provenance', 'dependencies'], { 'fs-ext': '2.1.1', other: '1.0.0' });
    await write(root, manifest);
    await rejects(
      artifactIdentity(root, RUNTIME, UNITS),
      'provenance does not match the observed tree',
    );
  });
  test('refuses a non-object dependency package.json as a Python crash', async () => {
    const { root, manifest } = await build();
    await put(root, 'node_modules/odd/package.json', '[]');
    const files = await inventory(root, [MANIFEST_NAME]);
    manifest.files = files.map(plain);
    manifest.content_sha256 = contentDigest(files);
    await write(root, manifest);
    await expect(artifactIdentity(root, RUNTIME, UNITS)).rejects.toBeInstanceOf(
      PythonExceptionError,
    );
  });
});

describe('validateManifest', () => {
  const base = async () => (await build()).manifest;
  test('accepts a well-formed manifest', async () => {
    expect(validateManifest(json(await base()))).toBeInstanceOf(JsonObject);
  });
  test('treats schema_version true/1.0 like Python 1 == True', async () => {
    const m = await base();
    expect(
      validateManifest(
        parseJsonValue(JSON.stringify(m).replace('"schema_version":1,', '"schema_version":1.0,')),
      ),
    ).toBeInstanceOf(JsonObject);
  });
  test.each([
    ['unexpected top-level field', ['extra'], 1, 'unexpected fields'],
    ['absolute entry path', ['files', 0, 'path'], '/abs', 'not relative'],
    ['dotdot entry path', ['files', 0, 'path'], 'a/../b', 'not relative'],
    ['bad digest', ['files', 2, 'sha256'], 'zz', 'digest is invalid'],
    ['mode out of range', ['files', 0, 'mode'], 0o1000, 'mode is invalid'],
    ['bad content sha', ['content_sha256'], 'c'.repeat(64), 'content_sha256 does not match'],
    ['wrong node major', ['provenance', 'runtime', 'node_major'], 22, 'node_major must be 24'],
    [
      'node version/major disagree',
      ['provenance', 'runtime', 'node_version'],
      'v23.1.0',
      'disagree',
    ],
    ['bad platform', ['provenance', 'runtime', 'platform'], 'darwin', 'linux-x64'],
    [
      'missing fs-ext dependency',
      ['provenance', 'dependencies'],
      { x: '1' },
      'must contain fs-ext',
    ],
    ['bad elf', ['provenance', 'fs_ext', 'elf', 'class'], 1, 'little-endian'],
    [
      'provenance source mismatch',
      ['provenance', 'source_sha'],
      'd'.repeat(40),
      'does not match the requested source',
    ],
  ] as [string, (string | number)[], unknown, string][])(
    'rejects %s',
    async (_name, path, value, message) => {
      const m = await base();
      setAt(m, path, value);
      expect(() => validateManifest(json(m))).toThrow(new RegExp(message));
    },
  );
  test('rejects a duplicate path', async () => {
    const m = await base();
    (m.files as unknown[]).push((m.files as unknown[])[0]);
    expect(() => validateManifest(json(m))).toThrow(/duplicate path/);
  });
  test('a symlink entry may not escape the archive', async () => {
    const m = await base();
    const files = m.files as unknown[];
    files.push({ path: 'a/b', type: 'symlink', target: '../../x' });
    expect(() => validateManifest(json(m))).toThrow(/escapes the archive/);
    files[files.length - 1] = { path: 'a/b', type: 'symlink', target: '../x' };
    m.content_sha256 = contentDigest(files.map(json));
    expect(validateManifest(json(m))).toBeInstanceOf(JsonObject);
  });
});

describe('loadJson', () => {
  test('strips a BOM, rejects invalid UTF-8 and malformed JSON as ValueError', () => {
    expect(
      loadJson(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')])),
    ).toBeInstanceOf(JsonObject);
    expect(() => loadJson(Buffer.from([0xff, 0xfe]))).toThrow(ArtifactIdentityError);
    expect(() => loadJson('{')).toThrow(ArtifactIdentityError);
  });
});

describe('inventory and staging facts', () => {
  test('inventory rejects an absolute symlink by name', async () => {
    const { root } = await build();
    await symlink('/etc/passwd', join(root, 'abs'));
    await rejects(inventory(root), 'absolute symlink: abs');
  });
  test('staging facts skip dot directories and scoped packages are read', async () => {
    const { root } = await build();
    await put(root, 'node_modules/.hidden/package.json', '{"name":"hidden","version":"1.0.0"}');
    await put(root, 'node_modules/@s/pkg/package.json', '{"name":"@s/pkg","version":"3.0.0"}');
    const { dependencies } = await stagingFacts(root);
    expect(dependencies.entries.map(([k]) => k)).toEqual(['@s/pkg', 'fs-ext']);
  });
  test('staging facts refuse a tree without production dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artid-'));
    roots.push(root);
    await mkdir(join(root, 'node_modules'));
    await rejects(stagingFacts(root), 'no production dependencies');
  });
});
