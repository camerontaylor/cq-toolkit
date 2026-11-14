/**
 * Version-2 snapshot installation (`author_snapshot.install`).
 *
 * The snapshot is validated entirely inside a throwaway bare repository whose
 * object store alternates to the review clone. Only after the closure, diff,
 * entry modes, object types, path safety and secret scan all pass are the
 * objects written to the clone and pinned under `refs/crq/author-snapshots/v1`.
 * A refused snapshot leaves no objects in the review clone.
 *
 * The scan is path-aware and byte-complete over the incoming closure: every
 * head entry's blob goes through the project denylist rules and, when
 * available, gitleaks. The original commit metadata is scanned with the
 * path-less rules. Path-length representability checks are left to the worker's
 * eventual `git worktree add`; they are the one decode-time check this port
 * does not reproduce.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '../../policy/crq/jsonValue.js';
import {
  makeGitleaksDefaultsScanner,
  parseDenylistPatterns,
  scanText,
} from '../../ops/dev/denylist.js';
import { AuthorRefused } from '../../policy/crq/authorWire.js';
import { decodeSnapshot, type SnapshotObject } from '../../policy/crq/authorSnapshot.js';
import { GitPool, gitCall, gitOk } from './gitExec.js';

const SNAPSHOT_REF_PREFIX = 'refs/crq/author-snapshots/v1/';

/** `crq.ALLOWLIST_PATHS`, verbatim (kept local so the scan policy is explicit). */
const ALLOWLIST_PATHS: readonly RegExp[] = [
  /(^|\/)\.git\//,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)\.gjc\//,
  /(^|\/)\.DS_Store$/,
  /^policy\/denylist\/patterns\.yml$/,
];

const SUPPORTED_MODES = new Set(['100644', '100755', '120000']);

export interface InstallSnapshotInput {
  readonly pool: GitPool;
  readonly clone: string;
  readonly snapshot: JsonObject;
  readonly binding: { readonly base: string; readonly head: string };
  readonly original: boolean;
}

interface Entry {
  readonly mode: string;
  readonly oid: string;
  readonly path: Uint8Array;
}

/** Decode, validate and install one snapshot into the review clone. */
export async function installAuthorSnapshot(input: InstallSnapshotInput): Promise<void> {
  const decoded = decodeSnapshot(input.snapshot, input.binding, input.original);
  const clone = input.clone;
  const type = await gitCall(input.pool, clone, ['cat-file', '-t', input.binding.base]);
  if (type.code !== 0 || Buffer.from(type.stdout).toString('utf8').trim() !== 'commit') {
    throw new AuthorRefused('snapshot base must already be available');
  }
  const objectDir = Buffer.from(
    await gitOk(input.pool, clone, ['rev-parse', '--git-path', 'objects']),
  )
    .toString('utf8')
    .trim();
  const alternates = join(clone, objectDir);
  const quarantine = await mkdtemp(join(tmpdir(), 'cq-author-snapshot-'));
  try {
    await gitOk(input.pool, quarantine, ['init', '--bare', '--template=', '-q']);
    await mkdir(join(quarantine, 'objects', 'info'), { recursive: true });
    await writeFile(join(quarantine, 'objects', 'info', 'alternates'), `${alternates}\n`);
    await writeObjects(input, quarantine, decoded.objects, 'snapshot import identity mismatch');
    const closureRaw = Buffer.from(
      await gitOk(input.pool, quarantine, [
        'rev-list',
        '--objects',
        '--no-object-names',
        input.binding.head,
        `^${input.binding.base}`,
      ]),
    )
      .toString('utf8')
      .split(/\s+/)
      .filter((oid) => oid.length > 0);
    const expected = new Set(decoded.objects.map((object) => object.oid));
    if (closureRaw.length !== expected.size || closureRaw.some((oid) => !expected.has(oid))) {
      throw new AuthorRefused('snapshot contains missing or unrelated objects');
    }
    const headEntries = entriesFrom(
      await gitOk(input.pool, quarantine, [
        'diff-tree',
        '-r',
        '-z',
        '--no-renames',
        input.binding.base,
        input.binding.head,
      ]),
    );
    const historyEntries: Entry[] = [];
    if (input.original) {
      let historyBytes = headEntries.reduce((sum, entry) => sum + entry.path.length + 1, 0);
      for (const object of decoded.objects) {
        if (object.type !== 'commit') continue;
        const history = entriesFrom(
          await gitOk(input.pool, quarantine, [
            'diff-tree',
            '-r',
            '-m',
            '-z',
            '--no-renames',
            '--no-commit-id',
            '--root',
            object.oid,
          ]),
        ).filter((entry) => entry.mode !== '160000');
        historyBytes += history.reduce((sum, entry) => sum + entry.path.length + 1, 0);
        if (historyBytes > 12 * 1024 * 1024) {
          throw new AuthorRefused('snapshot history scan exceeds bound; reduce the commit range');
        }
        historyEntries.push(...history);
      }
    }
    if (headEntries.some((entry) => !SUPPORTED_MODES.has(entry.mode))) {
      throw new AuthorRefused('snapshot gitlinks or unsupported modes refused');
    }
    const entries = uniqueEntries(
      input.original ? [...headEntries, ...historyEntries] : headEntries,
    );
    const headSet = new Set(headEntries.map((entry) => entryKey(entry)));
    await verifyBlobTypes(input.pool, quarantine, entries);
    const diff = Buffer.from(
      await gitOk(input.pool, quarantine, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--unified=0',
        input.binding.base,
        input.binding.head,
      ]),
    );
    if (diff.length === 0 && !input.original) throw new AuthorRefused('empty snapshot diff');
    const blobData = new Map<string, Uint8Array>();
    for (const object of decoded.objects) {
      if (object.type === 'blob') blobData.set(object.oid, object.data);
    }
    for (const [oid, data] of await readBlobs(
      input.pool,
      quarantine,
      entries.filter((entry) => !blobData.has(entry.oid)).map((entry) => entry.oid),
    )) {
      blobData.set(oid, data);
    }
    const rules = await readRules(clone);
    const scanParts: string[] = [Buffer.from(diff).toString('utf8')];
    if (input.original) {
      for (const object of decoded.objects) {
        if (object.type !== 'commit') continue;
        const text = Buffer.from(object.data).toString('utf8');
        for (const rule of rules) {
          if (rule.path !== undefined) continue;
          const hits = scanText(text, [rule], undefined);
          if (hits.length > 0)
            throw new AuthorRefused('snapshot commit metadata secret scan refused');
        }
        scanParts.push(`commit ${object.oid}\n${text}`);
      }
    }
    for (const entry of entries) {
      const path = Buffer.from(entry.path).toString('utf8');
      const materialized = headSet.has(entryKey(entry));
      if (materialized && !safePath(path)) throw new AuthorRefused('unsafe snapshot path');
      const data = blobData.get(entry.oid);
      if (data === undefined) throw new AuthorRefused('snapshot entry blob is missing');
      if (materialized && entry.mode === '120000') {
        if (data.length === 0 || data.includes(0)) {
          throw new AuthorRefused('snapshot symlink target is not representable');
        }
      }
      const contents = Buffer.from(data).toString('utf8');
      if (!ALLOWLIST_PATHS.some((pattern) => pattern.test(path))) {
        for (const rule of rules) {
          if (rule.path !== undefined && !new RegExp(rule.path).test(path)) continue;
          if (
            scanText(path, [rule], path).length > 0 ||
            scanText(contents, [rule], path).length > 0
          ) {
            throw new AuthorRefused('snapshot secret scan refused');
          }
        }
      }
      scanParts.push(`${path}\n${contents}\n`);
    }
    await gitleaksScan(scanParts);
    await writeObjects(input, clone, decoded.objects, 'snapshot installation mismatch');
    await gitOk(input.pool, clone, [
      'update-ref',
      `${SNAPSHOT_REF_PREFIX}${input.binding.head}`,
      input.binding.head,
    ]);
  } finally {
    await rm(quarantine, { recursive: true, force: true });
  }
}

async function readRules(
  clone: string,
): Promise<ReturnType<typeof parseDenylistPatterns>['rules']> {
  let text: string;
  try {
    text = await readFile(join(clone, 'policy/denylist/patterns.yml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AuthorRefused('denylist policy is not present in the review clone');
    }
    throw error;
  }
  return parseDenylistPatterns(text, 'policy/denylist/patterns.yml').rules;
}

async function writeObjects(
  input: InstallSnapshotInput,
  cwd: string,
  objects: readonly SnapshotObject[],
  mismatch: string,
): Promise<void> {
  for (const object of objects) {
    const result = await gitCall(
      input.pool,
      cwd,
      ['hash-object', '-w', '-t', object.type, '--stdin'],
      {
        input: object.data,
      },
    );
    if (result.code !== 0) throw new AuthorRefused(`snapshot object write refused: ${mismatch}`);
    if (Buffer.from(result.stdout).toString('utf8').trim() !== object.oid) {
      throw new AuthorRefused(mismatch);
    }
  }
}

function entriesFrom(raw: Uint8Array): Entry[] {
  const parts = Buffer.from(raw).toString('latin1').split('\0');
  const entries: Entry[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const meta = parts[index] ?? '';
    const path = parts[index + 1] ?? '';
    const fields = meta.replace(/^:/, '').split(' ');
    if (fields.length < 5) continue;
    const mode = fields[1] ?? '';
    const oid = fields[3] ?? '';
    if (mode === '000000') continue;
    entries.push({ mode, oid, path: Buffer.from(path, 'latin1') });
  }
  return entries;
}

function entryKey(entry: Entry): string {
  return `${entry.mode}\0${entry.oid}\0${Buffer.from(entry.path).toString('base64')}`;
}

function uniqueEntries(entries: readonly Entry[]): Entry[] {
  const seen = new Set<string>();
  const result: Entry[] = [];
  const ordered = [...entries].sort((left, right) => entryKey(left).localeCompare(entryKey(right)));
  for (const entry of ordered) {
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

async function verifyBlobTypes(
  pool: GitPool,
  cwd: string,
  entries: readonly Entry[],
): Promise<void> {
  if (entries.length === 0) return;
  const input = Buffer.from(entries.map((entry) => `${entry.oid}\n`).join(''), 'utf8');
  const result = await gitCall(pool, cwd, ['cat-file', '--batch-check=%(objecttype)'], { input });
  const kinds = Buffer.from(result.stdout).toString('utf8').trim().split('\n');
  if (
    result.code !== 0 ||
    kinds.length !== entries.length ||
    kinds.some((kind) => kind !== 'blob')
  ) {
    throw new AuthorRefused('snapshot entry mode disagrees with object type');
  }
}

async function readBlobs(
  pool: GitPool,
  cwd: string,
  oids: readonly string[],
): Promise<Map<string, Uint8Array>> {
  const blobs = new Map<string, Uint8Array>();
  if (oids.length === 0) return blobs;
  const input = Buffer.from(oids.map((oid) => `${oid}\n`).join(''), 'utf8');
  const result = await gitCall(pool, cwd, ['cat-file', '--batch'], { input });
  if (result.code !== 0) throw new AuthorRefused('snapshot blob read refused');
  const raw = Buffer.from(result.stdout);
  let offset = 0;
  while (offset < raw.length) {
    const newline = raw.indexOf(0x0a, offset);
    if (newline < 0) throw new AuthorRefused('snapshot blob read refused');
    const header = raw.subarray(offset, newline).toString('latin1').split(' ');
    offset = newline + 1;
    if (header[1] === 'missing') throw new AuthorRefused('snapshot entry blob is missing');
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > raw.length) {
      throw new AuthorRefused('snapshot blob read refused');
    }
    blobs.set(header[0] as string, new Uint8Array(raw.subarray(offset, offset + size)));
    offset += size + 1;
  }
  return blobs;
}

function safePath(path: string): boolean {
  if (path.length === 0) return false;
  for (const character of path) {
    const code = character.codePointAt(0) as number;
    if (code < 32 || code === 127) return false;
  }
  return !path
    .split('/')
    .some((part) => part === '.' || part === '..' || part.toLowerCase() === '.git');
}

/** Refuse on any gitleaks hit; an unavailable binary is skipped like Python. */
async function gitleaksScan(parts: readonly string[]): Promise<void> {
  if (!(await gitleaksAvailable())) return;
  const scanner = makeGitleaksDefaultsScanner({
    async runCommand(command, args, opts) {
      return new Promise((resolve) => {
        const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', () => {
          clearTimeout(timer);
          resolve({ exitCode: null, stdout, stderr: 'spawn failed', timedOut });
        });
        child.on('close', (exitCode) => {
          clearTimeout(timer);
          resolve({ exitCode, stdout, stderr, timedOut });
        });
      });
    },
    makeScratchDir: (prefix) => mkdtemp(join(tmpdir(), `${prefix}-`)),
    removeScratchDir: (path) => rm(path, { recursive: true, force: true }),
  });
  const components = parts.map((text, index) => ({
    component: `snapshot-${String(index)}`,
    text,
    path: 'snapshot',
  }));
  let scans;
  try {
    scans = await scanner(components);
  } catch (error) {
    throw new AuthorRefused(
      `snapshot secret scanner unavailable on the runner: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (scans.some((scan) => scan.hits.length > 0)) {
    throw new AuthorRefused('snapshot secret scan refused');
  }
}

function gitleaksAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('gitleaks', ['version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}
