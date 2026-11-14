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
 * path-less rules. Materialized paths and symlink targets must fit the worktree
 * filesystem's `NAME_MAX`/`PATH_MAX`, exactly as the worker's eventual
 * `git worktree add` would require.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { JsonObject } from '../../policy/crq/jsonValue.js';
import {
  makeGitleaksDefaultsScanner,
  parseDenylistPatterns,
  scanText,
} from '../../ops/dev/denylist.js';
import { AuthorRefused } from '../../policy/crq/authorWire.js';
import { decodeSnapshot, type SnapshotObject } from '../../policy/crq/authorSnapshot.js';
import { GitPool, gitCall, gitOk, killProcessTree } from './gitExec.js';

const SNAPSHOT_REF_PREFIX = 'refs/crq/author-snapshots/v1/';
const MAX_WIRE_BYTES = 6 * 1024 * 1024;
const FALLBACK_NAME_MAX = 255;
const FALLBACK_PATH_MAX = 4096;
const execFileAsync = promisify(execFile);
// Python decodes materialized paths with `errors="strict"` and does not strip
// a leading U+FEFF, so `ignoreBOM` stays true here.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

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
  /** `runner.WT_ROOT`: the filesystem a later `git worktree add` must satisfy. */
  readonly worktreeRoot?: string;
  /** Injected limits; production probes the worktree root with `getconf`. */
  readonly limits?: { readonly nameMax: number; readonly pathMax: number };
  /** Trusted clone that supplies `policy/denylist/patterns.yml` (defaults to clone). */
  readonly scanClone?: string;
  /** Authoritative ref for the scan policy (defaults to `origin/main`). */
  readonly scanRef?: string;
  /** Denylist class ids to apply; omitted keeps the full primary rule set. */
  readonly scanClasses?: readonly string[];
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
  const limits = await snapshotLimits(input);
  const pathMax =
    limits === null || input.worktreeRoot === undefined
      ? null
      : limits.pathMax - Buffer.byteLength(input.worktreeRoot, 'utf8') - 256;
  const type = await gitCall(input.pool, clone, ['cat-file', '-t', input.binding.base]);
  if (type.code !== 0 || Buffer.from(type.stdout).toString('utf8').trim() !== 'commit') {
    throw new AuthorRefused('snapshot base must already be available');
  }
  const objectDir = Buffer.from(
    await gitOk(input.pool, clone, ['rev-parse', '--git-path', 'objects']),
  )
    .toString('utf8')
    .trim();
  const alternates = resolve(clone, objectDir);
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
        if (historyBytes > MAX_WIRE_BYTES) {
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
    const rules = await readRules(
      input.pool,
      input.scanClone ?? clone,
      input.scanRef ?? 'origin/main',
      input.scanClasses,
    );
    const diffText = Buffer.from(diff).toString('utf8');
    scanPatch(diffText, rules);
    const scanParts: string[] = [diffText];
    let scanBytes = diff.length;
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
        const part = `commit ${object.oid}\n${text}`;
        scanBytes += Buffer.byteLength(part) + 1;
        if (scanBytes > MAX_WIRE_BYTES) throw new AuthorRefused('snapshot scan exceeds bound');
        scanParts.push(part);
      }
    }
    for (const entry of entries) {
      const materialized = headSet.has(entryKey(entry));
      const path = materialized ? strictPath(entry.path) : Buffer.from(entry.path).toString('utf8');
      if (materialized && !safePath(path)) throw new AuthorRefused('unsafe snapshot path');
      const data = blobData.get(entry.oid);
      if (data === undefined) throw new AuthorRefused('snapshot entry blob is missing');
      if (
        materialized &&
        limits !== null &&
        pathMax !== null &&
        (entry.path.length > pathMax || longestComponent(entry.path) > limits.nameMax)
      ) {
        throw new AuthorRefused('snapshot path too long to check out');
      }
      if (materialized && entry.mode === '120000') {
        if (
          data.length === 0 ||
          data.includes(0) ||
          (limits !== null && data.length >= limits.pathMax)
        ) {
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
      const part = `${path}\n${contents}\n`;
      scanBytes += Buffer.byteLength(part) + 1;
      if (scanBytes > MAX_WIRE_BYTES) throw new AuthorRefused('snapshot scan exceeds bound');
      scanParts.push(part);
    }
    await gitleaksScan(scanParts, input.pool);
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
  pool: GitPool,
  clone: string,
  ref: string,
  classes: readonly string[] | undefined,
): Promise<ReturnType<typeof parseDenylistPatterns>['rules']> {
  let text: string;
  try {
    text = Buffer.from(
      await gitOk(pool, clone, ['show', `${ref}:policy/denylist/patterns.yml`]),
    ).toString('utf8');
  } catch {
    throw new AuthorRefused('snapshot scan policy is unavailable');
  }
  const rules = parseDenylistPatterns(text, 'policy/denylist/patterns.yml').rules;
  if (classes === undefined) return rules;
  const available = new Set(rules.map((rule) => rule.id));
  if (classes.some((id) => !available.has(id))) {
    throw new AuthorRefused('snapshot scan policy is missing required classes');
  }
  const filtered = rules.filter((rule) => classes.includes(rule.id));
  if (filtered.length === 0) {
    throw new AuthorRefused('snapshot scan policy filtered to zero rules');
  }
  return filtered;
}

/** Project-rule scan over the patch, including removed lines (`secret_scan_diff`). */
function scanPatch(diff: string, rules: ReturnType<typeof parseDenylistPatterns>['rules']): void {
  const compiled = rules.map((rule) => ({
    regex: new RegExp(rule.regex),
    path: rule.path === undefined ? null : new RegExp(rule.path),
  }));
  let path: string | null = null;
  let inHeader = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      path = match === null ? null : (match[2] ?? null);
      inHeader = true;
      continue;
    }
    if (line.startsWith('@@')) {
      inHeader = false;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('+++ ') || line.startsWith('--- ')) {
        const candidate = line.slice(4);
        if (candidate !== '/dev/null') {
          path =
            candidate.startsWith('a/') || candidate.startsWith('b/')
              ? candidate.slice(2)
              : candidate;
        }
      }
      continue;
    }
    if (line === '' || (line[0] !== '+' && line[0] !== '-') || path === null) continue;
    if (ALLOWLIST_PATHS.some((pattern) => pattern.test(path as string))) continue;
    const content = line.slice(1);
    for (const rule of compiled) {
      if (rule.path !== null && !rule.path.test(path)) continue;
      if (rule.regex.test(content)) throw new AuthorRefused('snapshot secret scan refused');
    }
  }
}

async function writeObjects(
  input: InstallSnapshotInput,
  cwd: string,
  objects: readonly SnapshotObject[],
  mismatch: string,
): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'cq-author-objects-'));
  try {
    for (const type of ['blob', 'tree', 'commit'] as const) {
      const group = objects.filter((object) => object.type === type);
      if (group.length === 0) continue;
      const paths: string[] = [];
      for (const [index, object] of group.entries()) {
        const path = join(temp, `${type}-${String(index)}`);
        await writeFile(path, object.data);
        paths.push(path);
      }
      const result = await gitCall(
        input.pool,
        cwd,
        ['hash-object', '-w', '--no-filters', '-t', type, '--stdin-paths'],
        { input: Buffer.from(`${paths.join('\n')}\n`, 'utf8') },
      );
      const written = Buffer.from(result.stdout).toString('utf8').trim().split('\n');
      if (
        result.code !== 0 ||
        written.length !== group.length ||
        written.some((oid, index) => oid !== group[index]?.oid)
      ) {
        throw new AuthorRefused(`snapshot object write refused: ${mismatch}`);
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
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

/** `raw_path.decode("utf-8", errors="strict")` for a materialized entry. */
function strictPath(path: Uint8Array): string {
  try {
    return strictUtf8.decode(path);
  } catch {
    throw new AuthorRefused('snapshot path is not valid UTF-8');
  }
}

/** `os.pathconf(WT_ROOT, PC_NAME_MAX/PC_PATH_MAX)`; fail closed to POSIX minima. */
async function snapshotLimits(
  input: InstallSnapshotInput,
): Promise<{ readonly nameMax: number; readonly pathMax: number } | null> {
  if (input.worktreeRoot === undefined || input.worktreeRoot.length === 0) return null;
  if (input.limits !== undefined) return input.limits;
  try {
    const [name, path] = await Promise.all([
      execFileAsync('getconf', ['NAME_MAX', input.worktreeRoot], { timeout: 5000 }),
      execFileAsync('getconf', ['PATH_MAX', input.worktreeRoot], { timeout: 5000 }),
    ]);
    const nameMax = Number.parseInt(name.stdout.trim(), 10);
    const pathMax = Number.parseInt(path.stdout.trim(), 10);
    if (
      Number.isSafeInteger(nameMax) &&
      nameMax > 0 &&
      Number.isSafeInteger(pathMax) &&
      pathMax > 0
    ) {
      return { nameMax, pathMax };
    }
  } catch {
    // `getconf` is unavailable: POSIX minima keep every accepted path legal.
  }
  return { nameMax: FALLBACK_NAME_MAX, pathMax: FALLBACK_PATH_MAX };
}

/** Length of the longest slash-delimited byte component. */
function longestComponent(path: Uint8Array): number {
  let longest = 0;
  let length = 0;
  for (const byte of path) {
    if (byte === 0x2f) {
      if (length > longest) longest = length;
      length = 0;
    } else {
      length += 1;
    }
  }
  return length > longest ? length : longest;
}

/**
 * Refuse on any gitleaks hit. Only a genuinely absent binary is skipped, as
 * Python's `secret_scan_diff` does; an installed scanner whose probe fails is
 * an operator fault and must refuse the snapshot rather than silently scan
 * with the project denylist alone.
 */
async function gitleaksScan(parts: readonly string[], pool: GitPool): Promise<void> {
  if (!(await gitleaksAvailable(pool))) return;
  const scanner = makeGitleaksDefaultsScanner({
    async runCommand(command, args, opts) {
      return new Promise((resolve) => {
        const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        pool.track(child);
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

function gitleaksAvailable(pool: GitPool): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn('gitleaks', ['version'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    pool.track(child);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      settle();
    };
    timer = setTimeout(() => {
      killProcessTree(child);
      finish(() =>
        reject(new AuthorRefused('snapshot secret scanner probe failed (timed out after 10000ms)')),
      );
    }, 10_000);
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        finish(() => resolve(false));
        return;
      }
      finish(() =>
        reject(
          new AuthorRefused(
            `snapshot secret scanner probe failed (${error.message || 'spawn failed'})`,
          ),
        ),
      );
    });
    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(() => resolve(true));
        return;
      }
      const detail = code === null ? `signal ${signal ?? 'unknown'}` : `exit ${String(code)}`;
      finish(() => reject(new AuthorRefused(`snapshot secret scanner probe failed (${detail})`)));
    });
  });
}
