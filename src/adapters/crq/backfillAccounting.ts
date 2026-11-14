/**
 * `backfill_accounting.Repository` and `backfill_cache.Cache` over the
 * hardened `RunGit` seam.
 *
 * Python parity, kept exactly:
 *
 * - `begin_invocation()` starts one immutable-object cache and forgets earlier
 *   verification outcomes, so a gap from a previous invocation is retried.
 * - Only immutable reads are memoised (`rev-list --first-parent <oid>`,
 *   `rev-parse <oid>^{commit|tree|\^1}`, `ls-tree -r -z <oid>` and the three
 *   pinned name-status diffs), and the cache clears whole rather than growing
 *   past 256 MiB or 100k entries.
 * - `entries` is a private, LRU-bounded per-commit tree shared by internal
 *   loops; public callers get copies. `inventory` reads each blob once per
 *   invocation and hands out copies, both on the computed and memo hit paths.
 * - `lineage` follows only first-parent ancestry and unique `R100` renames;
 *   any deletion, copy, non-exact rename or duplicate source blob ends the
 *   chain. `proven_deleted` recognises only an unambiguous deletion.
 * - `carry` maps surviving blame signatures; `coverage` is a union over
 *   independent creditable reviews and its cached hit re-verifies evidence
 *   before trusting the fold.
 * - The fact cache is a disposable, content-verified index: a corrupt index,
 *   tampered artifact, wrong-shape value or changed salt is a miss (never a
 *   raise) and the fact is recomputed. Failed acquisitions are never stored.
 *
 * The four-method `tree` / `lineage` / `provenDeleted` / `carry` surface is
 * structurally the `BackfillReportRepo` seam defined alongside the report
 * port, so the later route binding is a plain dependency injection.
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ACCOUNTING_BLAME_OPTIONS,
  ACCOUNTING_ENTRY_CACHE_BYTES,
  ACCOUNTING_ENTRY_CACHE_TREES,
  ACCOUNTING_FACT_CACHE_BYTES,
  ACCOUNTING_LINEAGE_CACHE_BYTES,
  ACCOUNTING_LINEAGE_RESULT_EPOCH,
  BackfillAccountingError,
  FACT_SHAPES,
  blameFact,
  blameFromFact,
  carryFact,
  carryFromFact,
  carryMatches,
  carrySelection,
  coverageFact,
  lineCount,
  parseBlame,
  parseChangedIntervals,
  parseLineageStep,
  splitNul,
  verifiedFact,
  type AccountingFactKind,
  type BlameRow,
  type LineageStep,
} from '../../policy/crq/backfillAccounting.js';
import type { BackfillCaptureRepo } from '../../policy/crq/backfillInventory.js';
import type { BackfillReportRepo } from '../../policy/crq/backfillReport.js';
import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import {
  ledgerCreditable,
  ledgerDigestOf,
  ledgerIntervals,
  ledgerLoads,
  ledgerPath,
  ledgerScope,
  ledgerTimestamp,
  ledgerValidate,
  ledgerValidateSequence,
} from '../../policy/crq/ledger.js';
import { ledgerJsonBytes, ledgerJsonDigest } from '../../policy/crq/pythonJson.js';
import { atomicWrite } from './atomic.js';
import type { ArtifactStore } from './findingStore.js';
import type { RunGit } from './ledgerGit.js';

/** `backfill_cache.VERSION`. Bump when the accounting meaning of facts changes. */
export const ACCOUNTING_FACT_CACHE_VERSION = 1;
/** `backfill_accounting.git`'s immutable-output cache bound (256 MiB). */
const GIT_CACHE_BYTES = 256 * 1024 * 1024;
const GIT_CACHE_ENTRIES = 100_000;
const OID = /^[0-9a-f]{40,64}$/;
const PYTHON_IDENTIFIER = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}_]*$/u;
const REGULAR_MODES = new Set(['100644', '100755']);

/** A Git invocation failure that a caller's retry/gap path may record. */
export class AccountingGitError extends Error {
  override readonly name: string = 'AccountingGitError';
  readonly code: number | null;
  readonly stderr: string;

  constructor(args: readonly string[], code: number | null, stderr: string) {
    super(`git ${args[0] ?? ''} failed: ${stderr.trim() || `exit ${code ?? 'signal'}`}`);
    this.code = code;
    this.stderr = stderr;
  }
}

/** `backfill_cache.Cache`'s namespace refusal (`ValueError`). */
export class BackfillCacheError extends Error {
  override readonly name: string = 'BackfillCacheError';
  readonly pythonError: string = 'ValueError';
}

/** One `ls-tree` entry: the same fields Python's private tree freezes. */
export interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly kind: string;
  readonly blob: string;
}

/** One inventory row; `lines`/`bytes` stay null for unreadable objects. */
export interface InventoryRow extends TreeEntry {
  readonly lines: number | null;
  readonly bytes: number | null;
  readonly disposition: 'included' | 'empty' | 'unsupported';
  readonly reason: string;
}

/** One gap: a review whose evidence could not be verified for a target. */
export interface CoverageGap {
  readonly review: string;
  readonly reason: string;
}

/** `Repository.coverage`'s result: covered lines, contributing ids and gaps. */
export interface CoverageFold {
  readonly covered: Map<string, Set<number>>;
  readonly evidence: Map<string, string[]>;
  readonly gaps: CoverageGap[];
}

interface GitOptions {
  readonly check?: boolean;
  readonly env?: Record<string, string>;
  readonly input?: Uint8Array;
}

interface VerifiedReference {
  readonly sha256: string;
  readonly location: string;
  readonly kind: string | undefined;
}

/**
 * `backfill_cache.Cache`: a disposable index over immutable Git-derived facts.
 *
 * The durable artifact store remains authoritative for bytes. The salt names
 * the tools and semantics facts depend on (`git --version` and
 * `LINEAGE_RESULT_EPOCH`), so upgrading either invalidates every fact.
 */
export class BackfillFactCache {
  private readonly root: string;
  private readonly store: ArtifactStore;
  private readonly salt: Readonly<Record<string, unknown>>;
  private readonly version: number;

  constructor(options: {
    readonly root: string;
    readonly store: ArtifactStore;
    readonly salt?: Record<string, unknown>;
    /** Override the index version (test seam for a semantics bump). */
    readonly version?: number;
  }) {
    this.root = options.root;
    this.store = options.store;
    this.salt = options.salt ?? {};
    this.version = options.version ?? ACCOUNTING_FACT_CACHE_VERSION;
  }

  /** `Cache._key`: a digest binding version, salt, namespace and identity. */
  key(kind: string, identity: unknown): string {
    if (!PYTHON_IDENTIFIER.test(kind)) {
      throw new BackfillCacheError('invalid inventory cache namespace');
    }
    return ledgerJsonDigest({
      version: this.version,
      salt: this.salt,
      kind,
      identity,
    });
  }

  /** `Cache.get`: every index, artifact and shape failure is a miss. */
  async get(kind: AccountingFactKind, identity: unknown): Promise<JsonValue | null> {
    const key = this.key(kind, identity);
    try {
      const reference = ledgerLoads(await readFile(join(this.root, 'facts', kind, `${key}.json`)));
      if (!(reference instanceof JsonObject)) return null;
      const sha256 = reference.get('sha256');
      const location = reference.get('location');
      if (typeof sha256 !== 'string' || typeof location !== 'string') return null;
      await this.store.verify({ sha256, location });
      const value = ledgerLoads(await readFile(location));
      if (value instanceof JsonObject && value.get('key') === key && value.has('value')) {
        return value.get('value') ?? null;
      }
    } catch {
      return null;
    }
    return null;
  }

  /** `Cache.put`: artifact volume failures are real; index write failures are not. */
  async put(kind: AccountingFactKind, identity: unknown, value: unknown): Promise<void> {
    const key = this.key(kind, identity);
    const reference = await this.store.put(ledgerJsonBytes({ key, value }));
    const filename = join(this.root, 'facts', kind, `${key}.json`);
    try {
      await mkdir(dirname(filename), { recursive: true });
      await atomicWrite(filename, ledgerJsonBytes(reference));
    } catch {
      // Read-only or removed index: the durable artifact remains authoritative.
    }
  }
}

/**
 * `backfill_runtime`'s fact-cache salt: the git version and the lineage
 * semantics epoch. Either changing invalidates every persisted fact.
 */
export function accountingFactSalt(gitVersion: string): Record<string, unknown> {
  return {
    git_version: gitVersion,
    lineage_epoch: ACCOUNTING_LINEAGE_RESULT_EPOCH,
  };
}

export interface GitAccountingOptions {
  /** The scheduler clone the accounting repository reads. */
  readonly repo: string;
  readonly runGit: RunGit;
  /** Cross-run fact index; absence disables every persisted fact. */
  readonly diskCache?: BackfillFactCache;
  /** Test seams mirroring the oracle's module constants. */
  readonly entryCacheTrees?: number;
  readonly entryCacheBytes?: number;
  readonly lineageCacheBytes?: number;
  readonly factCacheBytes?: number;
  readonly gitCacheBytes?: number;
  readonly gitCacheEntries?: number;
}

function integrity(message: string): BackfillAccountingError {
  return new BackfillAccountingError(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);
}

function decodeStrict(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function trim(bytes: Uint8Array): string {
  return decode(bytes).trim();
}

function bytesEqual(left: Uint8Array | undefined, right: string): boolean {
  if (left === undefined) return false;
  const expected = Buffer.from(right, 'utf8');
  return Buffer.from(left).equals(expected);
}

function startsWithByte(data: Uint8Array, byte: number): boolean {
  return data[0] === byte;
}

function pyTruthyArray(data: Uint8Array): boolean {
  return data.length > 0;
}

function regularMode(mode: string | undefined): boolean {
  return mode !== undefined && REGULAR_MODES.has(mode);
}

function payloadOf(value: JsonValue): JsonObject {
  const payload = value instanceof JsonObject ? value.get('payload') : undefined;
  if (!(payload instanceof JsonObject)) throw integrity('review payload is not an object');
  return payload;
}

function payloadText(payload: JsonObject, key: string): string {
  const value = payload.get(key);
  if (typeof value !== 'string') throw integrity(`review payload is missing ${key}`);
  return value;
}

function artifactsOf(payload: JsonObject): readonly JsonValue[] {
  const artifacts = payload.get('artifacts');
  return Array.isArray(artifacts) ? artifacts : [];
}

function reviewId(value: JsonValue): string {
  const id = value instanceof JsonObject ? value.get('id') : undefined;
  return typeof id === 'string' ? id : '';
}

function verifiedFromFact(value: JsonValue): Map<string, Set<number>> {
  if (!(value instanceof JsonObject)) throw integrity('verified review fact is not an object');
  const result = new Map<string, Set<number>>();
  for (const [name, rows] of value.entries) result.set(name, ledgerIntervals(rows));
  return result;
}

function coverageFromFact(value: JsonValue): {
  covered: Map<string, Set<number>>;
  evidence: Map<string, string[]>;
} {
  const coveredValue = value instanceof JsonObject ? value.get('covered') : undefined;
  const evidenceValue = value instanceof JsonObject ? value.get('evidence') : undefined;
  if (!(coveredValue instanceof JsonObject) || !(evidenceValue instanceof JsonObject)) {
    throw integrity('coverage fact is malformed');
  }
  const covered = new Map<string, Set<number>>();
  for (const [name, rows] of coveredValue.entries) covered.set(name, ledgerIntervals(rows));
  const evidence = new Map<string, string[]>();
  for (const [name, ids] of evidenceValue.entries) {
    evidence.set(
      name,
      Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
    );
  }
  return { covered, evidence };
}

/** `backfill_accounting.Repository` over one injected Git runner. */
export class GitAccountingRepository implements BackfillReportRepo, BackfillCaptureRepo {
  private readonly repo: string;
  private readonly runGit: RunGit;
  private readonly diskCache: BackfillFactCache | null;
  private readonly entryCacheTrees: number;
  private readonly entryCacheBytes: number;
  private readonly lineageCacheBytes: number;
  private readonly factCacheBytes: number;
  private readonly gitCacheBytes: number;
  private readonly gitCacheEntries: number;

  private immutableCache: Map<string, Uint8Array> | null = null;
  private immutableBytes = 0;
  private readonly entryCache = new Map<
    string,
    { readonly entries: Map<string, TreeEntry>; readonly size: number }
  >();
  private entryBytes = 0;
  private readonly lineageSteps = new Map<
    string,
    { readonly step: LineageStep; readonly size: number }
  >();
  private lineageBytes = 0;
  private readonly factMemo = new Map<string, { readonly value: unknown; readonly size: number }>();
  private factBytes = 0;
  private verified = new Map<string, Map<string, Set<number>> | Error>();
  private inventories = new Map<string, InventoryRow[]>();

  constructor(options: GitAccountingOptions) {
    this.repo = options.repo;
    this.runGit = options.runGit;
    this.diskCache = options.diskCache ?? null;
    this.entryCacheTrees = options.entryCacheTrees ?? ACCOUNTING_ENTRY_CACHE_TREES;
    this.entryCacheBytes = options.entryCacheBytes ?? ACCOUNTING_ENTRY_CACHE_BYTES;
    this.lineageCacheBytes = options.lineageCacheBytes ?? ACCOUNTING_LINEAGE_CACHE_BYTES;
    this.factCacheBytes = options.factCacheBytes ?? ACCOUNTING_FACT_CACHE_BYTES;
    this.gitCacheBytes = options.gitCacheBytes ?? GIT_CACHE_BYTES;
    this.gitCacheEntries = options.gitCacheEntries ?? GIT_CACHE_ENTRIES;
  }

  /** The repository root this instance reads (never the process environment). */
  get root(): string {
    return this.repo;
  }

  /** `Repository.begin_invocation`. */
  beginInvocation(): void {
    this.immutableCache = new Map();
    this.immutableBytes = 0;
    this.verified = new Map();
    this.inventories = new Map();
    this.lineageSteps.clear();
    this.lineageBytes = 0;
    this.factMemo.clear();
    this.factBytes = 0;
  }

  // ---------------------------------------------------------------- git seam

  private async call(
    args: readonly string[],
    options: GitOptions,
  ): Promise<{
    readonly code: number | null;
    readonly stdout: Uint8Array;
    readonly stderr: string;
  }> {
    const hasEnv = options.env !== undefined;
    const hasInput = options.input !== undefined;
    const runOptions: { env?: Record<string, string>; input?: Uint8Array } = {};
    if (hasEnv) runOptions.env = options.env;
    if (hasInput) runOptions.input = options.input;
    const call = await this.runGit(args, runOptions);
    return { code: call.code, stdout: call.stdout, stderr: call.stderr };
  }

  private async git(args: readonly string[], options: GitOptions = {}): Promise<Uint8Array> {
    const check = options.check !== false;
    const cacheable =
      this.immutableCache !== null &&
      check &&
      options.env === undefined &&
      options.input === undefined &&
      cacheableGitArgs(args);
    const key = args.join('\u0000');
    if (cacheable) {
      const hit = this.immutableCache?.get(key);
      if (hit !== undefined) return hit;
    }
    const call = await this.call(args, options);
    if (check && call.code !== 0) throw new AccountingGitError(args, call.code, call.stderr);
    if (cacheable) this.cacheGitOutput(key, call.stdout);
    return call.stdout;
  }

  private cacheGitOutput(key: string, stdout: Uint8Array): void {
    if (this.immutableCache === null || stdout.length > this.gitCacheBytes) return;
    if (
      this.immutableBytes + stdout.length > this.gitCacheBytes ||
      this.immutableCache.size >= this.gitCacheEntries
    ) {
      this.immutableCache.clear();
      this.immutableBytes = 0;
    }
    this.immutableCache.set(key, stdout);
    this.immutableBytes += stdout.length;
  }

  // ------------------------------------------------------------------ caches

  private memo(key: string): unknown {
    if (this.immutableCache === null) return undefined;
    const entry = this.factMemo.get(key);
    if (entry === undefined) return undefined;
    this.factMemo.delete(key);
    this.factMemo.set(key, entry);
    return entry.value;
  }

  private remember(key: string, value: unknown, size: number): void {
    if (this.immutableCache === null || size > this.factCacheBytes) return;
    const previous = this.factMemo.get(key);
    if (previous !== undefined) {
      this.factMemo.delete(key);
      this.factBytes -= previous.size;
    }
    while (this.factMemo.size > 0 && this.factBytes + size > this.factCacheBytes) {
      const oldest = this.factMemo.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.factMemo.get(oldest);
      this.factMemo.delete(oldest);
      this.factBytes -= evicted?.size ?? 0;
    }
    this.factMemo.set(key, { value, size });
    this.factBytes += size;
  }

  private async cached(kind: AccountingFactKind, identity: unknown): Promise<JsonValue | null> {
    if (this.diskCache === null) return null;
    const value = await this.diskCache.get(kind, identity);
    return value !== null && FACT_SHAPES[kind](value) ? value : null;
  }

  private async persist(
    kind: AccountingFactKind,
    identity: unknown,
    value: unknown,
  ): Promise<void> {
    if (this.diskCache === null) return;
    await this.diskCache.put(kind, identity, value);
  }

  // ------------------------------------------------------------- resolution

  /** `Repository.resolve`: only an immutable full object id. */
  async resolve(value: string): Promise<string> {
    if (!OID.test(value)) throw integrity('target must be an immutable full object ID');
    return trim(await this.git(['rev-parse', `${value}^{commit}`]));
  }

  /** `Repository.tree`: the tree object id of a resolved commit. */
  async tree(commit: string): Promise<string> {
    return trim(await this.git(['rev-parse', `${await this.resolve(commit)}^{tree}`]));
  }

  /** `repo.git("--version")`: one salt component of the fact cache. */
  async gitVersion(): Promise<string> {
    return trim(await this.git(['--version']));
  }

  /**
   * `Repository.entries`: a fresh map of copied rows. Internal loops use
   * {@link treeEntries}, whose map is shared for the invocation.
   */
  async entries(commit: string): Promise<Map<string, TreeEntry>> {
    const shared = await this.treeEntries(commit);
    const result = new Map<string, TreeEntry>();
    for (const [name, entry] of shared) result.set(name, { ...entry });
    return result;
  }

  private async treeEntries(commit: string): Promise<Map<string, TreeEntry>> {
    const resolved = await this.resolve(commit);
    const cached = this.entryCache.get(resolved);
    if (this.immutableCache !== null && cached !== undefined) {
      this.entryCache.delete(resolved);
      this.entryCache.set(resolved, cached);
      return cached.entries;
    }
    const raw = await this.git(['ls-tree', '-r', '-z', resolved]);
    const result = new Map<string, TreeEntry>();
    let size = 256 + resolved.length * 2;
    for (const segment of splitNul(raw)) {
      if (segment.length === 0) continue;
      const tab = segment.indexOf(0x09);
      if (tab < 0) throw integrity('malformed ls-tree entry');
      const meta = decode(segment.slice(0, tab)).split(' ');
      const mode = meta[0] ?? '';
      const kind = meta[1] ?? '';
      const blob = meta[2] ?? '';
      const nameBytes = segment.slice(tab + 1);
      let name: string;
      try {
        name = ledgerPath(decodeStrict(nameBytes) as JsonValue);
      } catch {
        name = `git-path-bytes:${Buffer.from(nameBytes).toString('hex')}`;
      }
      const entry: TreeEntry = { path: name, mode, kind, blob };
      result.set(name, entry);
      size += name.length * 2 + mode.length + kind.length + blob.length + 128;
    }
    if (this.immutableCache !== null && size <= this.entryCacheBytes) {
      while (
        this.entryCache.size > 0 &&
        (this.entryCache.size >= this.entryCacheTrees ||
          this.entryBytes + size > this.entryCacheBytes)
      ) {
        const oldest = this.entryCache.keys().next().value;
        if (oldest === undefined) break;
        const evicted = this.entryCache.get(oldest);
        this.entryCache.delete(oldest);
        this.entryBytes -= evicted?.size ?? 0;
      }
      this.entryCache.set(resolved, { entries: result, size });
      this.entryBytes += size;
    }
    return result;
  }

  // -------------------------------------------------------------- inventory

  /** `Repository.inventory`: rows for every object at `target`. */
  async inventory(target: string, maxFileBytes: number): Promise<InventoryRow[]> {
    const key = `${await this.resolve(target)}\u0000${maxFileBytes}`;
    if (this.immutableCache !== null) {
      const memo = this.inventories.get(key);
      if (memo !== undefined) return memo.map((row) => ({ ...row }));
    }
    const rows = await this.inventoryUncached(target, maxFileBytes);
    if (this.immutableCache !== null) {
      this.inventories = new Map([[key, rows.map((row) => ({ ...row }))]]);
    }
    return rows;
  }

  private async inventoryUncached(target: string, maxFileBytes: number): Promise<InventoryRow[]> {
    const entries = await this.treeEntries(target);
    const ordered = [...entries.entries()].sort((left, right) =>
      Buffer.compare(Buffer.from(left[0], 'utf8'), Buffer.from(right[0], 'utf8')),
    );
    const rows: InventoryRow[] = [];
    for (const [name, entry] of ordered) {
      const row: {
        path: string;
        mode: string;
        kind: string;
        blob: string;
        lines: number | null;
        bytes: number | null;
        disposition: 'included' | 'empty' | 'unsupported';
        reason: string;
      } = {
        ...entry,
        lines: null,
        bytes: null,
        disposition: 'unsupported',
        reason: 'non-regular object',
      };
      if (name.startsWith('git-path-bytes:')) {
        row.reason = 'non-canonical or non-UTF8 path';
      } else if (regularMode(entry.mode) && entry.kind === 'blob') {
        try {
          const data = await this.git(['cat-file', 'blob', entry.blob]);
          row.bytes = data.length;
          try {
            decodeStrict(data);
          } catch {
            row.reason = 'non-UTF8 blob';
            rows.push(row);
            continue;
          }
          if (data.includes(0)) {
            row.reason = 'binary blob';
          } else {
            row.lines = lineCount(data);
            if (data.length > maxFileBytes) {
              row.reason = 'current content exceeds per-file limit';
            } else if (data.length > 0) {
              row.disposition = 'included';
              row.reason = 'tracked regular UTF8 text';
            } else {
              row.disposition = 'empty';
              row.reason = 'empty current blob';
            }
          }
        } catch (error) {
          if (!(error instanceof AccountingGitError)) throw error;
          row.reason = 'unreadable blob';
        }
      }
      rows.push(row);
    }
    return rows;
  }

  // ---------------------------------------------------------------- changed

  /** `Repository.changed_intervals`: head-side credit intervals per path. */
  async changedIntervals(base: string, head: string): Promise<Map<string, Set<number>>> {
    const patch = await this.git([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--no-renames',
      '--unified=0',
      base,
      head,
    ]);
    return parseChangedIntervals(patch);
  }

  // ----------------------------------------------------------- verify review

  /** `Repository.verify_review`: the credited map for a creditable record. */
  async verifyReview(value: JsonValue): Promise<Map<string, Set<number>>> {
    ledgerValidate(value);
    if (!ledgerCreditable(value)) return new Map();
    const payload = payloadOf(value);
    const target = payloadText(payload, 'target');
    const head = payloadText(payload, 'head');
    const base = payloadText(payload, 'base');
    const targetTree = payloadText(payload, 'target_tree');
    const headTree = payloadText(payload, 'head_tree');
    if ((await this.tree(target)) !== targetTree || (await this.tree(head)) !== headTree) {
      throw integrity('review tree mismatch');
    }
    const targetEntries = await this.treeEntries(target);
    const headEntries = await this.treeEntries(head);
    const changed = await this.changedIntervals(base, head);
    const scopeValue = payload.get('reviewed_scope');
    if (scopeValue === undefined) throw integrity('review payload has no reviewed_scope');
    const result = new Map<string, Set<number>>();
    for (const [name, byBlob] of ledgerScope(scopeValue)) {
      for (const [blob, lines] of byBlob) {
        const targetEntry = targetEntries.get(name);
        const headEntry = headEntries.get(name);
        if (
          targetEntry === undefined ||
          headEntry === undefined ||
          targetEntry.blob !== blob ||
          headEntry.blob !== blob
        ) {
          throw integrity('synthetic head/target blob mismatch');
        }
        if (!regularMode(targetEntry.mode)) throw integrity('reviewed non-regular object');
        const maximum = lineCount(await this.git(['cat-file', 'blob', blob]));
        const allowed = changed.get(name) ?? new Set<number>();
        for (const number of lines) {
          if (number < 1 || number > maximum || !allowed.has(number)) {
            throw integrity('credit outside head-side changed intervals');
          }
        }
        result.set(name, new Set(lines));
      }
    }
    return result;
  }

  // ------------------------------------------------------------------ blame

  /** `Repository.blame`: one row per line, cached by immutable target. */
  async blame(target: string, name: string): Promise<BlameRow[]> {
    const path = ledgerPath(name);
    const cacheable = OID.test(target);
    const key = `blame\u0000${target}\u0000${path}`;
    const remembered = cacheable ? this.memo(key) : undefined;
    if (remembered !== undefined) return [...(remembered as BlameRow[])];
    const identity = { target, path, options: [...ACCOUNTING_BLAME_OPTIONS] };
    const cached = cacheable ? await this.cached('blame', identity) : null;
    if (cached !== null) {
      const rows = blameFromFact(cached);
      if (rows !== null) {
        this.rememberBlame(key, rows);
        return rows;
      }
    }
    const raw = await this.git(['blame', ...ACCOUNTING_BLAME_OPTIONS, target, '--', path]);
    const rows = parseBlame(raw);
    if (cacheable) {
      await this.persist('blame', identity, blameFact(rows));
      this.rememberBlame(key, rows);
    }
    return rows;
  }

  private rememberBlame(key: string, rows: readonly BlameRow[]): void {
    let size = 256 + rows.length * 96;
    for (const row of rows) size += (row.filename?.length ?? 0) + row.content.length;
    this.remember(key, [...rows], size);
  }

  // --------------------------------------------------------------- lineage

  /** `_lineage_step`: the parent and complete name-status changes of a commit. */
  private async lineageStep(commit: string): Promise<LineageStep> {
    const cached = this.lineageSteps.get(commit);
    if (this.immutableCache !== null && cached !== undefined) return cached.step;
    const identity = { commit };
    const fact = await this.cached('lineage_step', identity);
    let step: LineageStep;
    if (fact !== null) {
      const parent = fact instanceof JsonObject ? fact.get('parent') : undefined;
      const changes = fact instanceof JsonObject ? fact.get('changes') : undefined;
      if (typeof parent !== 'string' || !Array.isArray(changes)) {
        step = await this.computeLineageStep(commit, identity);
      } else {
        step = parseLineageStepFromFact(parent, changes);
      }
    } else if (this.diskCache !== null) {
      step = await this.computeLineageStep(commit, identity);
    } else {
      step = await this.computeLineageStep(commit, null);
    }
    let size = 256;
    for (const change of step.changes) {
      for (const field of change) if (field !== null) size += field.length * 4;
    }
    if (this.immutableCache !== null && size <= this.lineageCacheBytes) {
      if (this.lineageBytes + size > this.lineageCacheBytes) {
        this.lineageSteps.clear();
        this.lineageBytes = 0;
      }
      this.lineageSteps.set(commit, { step, size });
      this.lineageBytes += size;
    }
    return step;
  }

  private async computeLineageStep(
    commit: string,
    identity: { readonly commit: string } | null,
  ): Promise<LineageStep> {
    const parent = trim(await this.git(['rev-parse', `${commit}^1`]));
    const raw = await this.git([
      'diff',
      '--name-status',
      '-z',
      '--find-renames=100%',
      parent,
      commit,
    ]);
    const step = parseLineageStep(raw, parent);
    if (identity !== null) {
      await this.persist('lineage_step', identity, {
        parent: step.parent,
        changes: step.changes.map(([status, source, destination]) => [status, source, destination]),
      });
    }
    return step;
  }

  /** `Repository.lineage`: null unless a unique exact-rename chain survives. */
  async lineage(old: string, next: string, name: string): Promise<string | null> {
    if (this.diskCache === null || !OID.test(old) || !OID.test(next)) {
      return this.lineageUncached(old, next, name);
    }
    const key = `lineage\u0000${old}\u0000${next}\u0000${name}`;
    const remembered = this.memo(key);
    if (remembered !== undefined) return (remembered as [string | null])[0];
    const identity = { old, new: next, path: name };
    const cached = await this.cached('lineage', identity);
    let result: string | null;
    if (cached !== null && cached instanceof JsonObject && cached.has('path')) {
      const path = cached.get('path');
      result = typeof path === 'string' ? path : null;
    } else {
      result = await this.lineageUncached(old, next, name);
      await this.persist('lineage', identity, { path: result });
    }
    this.remember(key, [result], 256 + old.length + next.length + name.length + 32);
    return result;
  }

  private async lineageUncached(old: string, next: string, name: string): Promise<string | null> {
    if (!(await this.treeEntries(old)).has(name)) return null;
    const chain = decode(await this.git(['rev-list', '--first-parent', next])).split('\n');
    const position = chain.indexOf(old);
    if (position < 0) return null;
    let current: string | null = name;
    // One name-status diff cannot chain a path (a destination is absent from
    // the parent tree), so the oracle's in-order scan has one match per step.
    for (const commit of chain.slice(0, position).reverse()) {
      const step = await this.lineageStep(commit);
      for (const [status, source, destination] of step.changes) {
        if (source !== current) continue;
        if (status === 'D' || status.startsWith('C')) return null;
        if (!status.startsWith('R')) continue;
        const before = await this.treeEntries(step.parent);
        const after = await this.treeEntries(commit);
        const blob = current === null ? undefined : before.get(current)?.blob;
        if (
          status !== 'R100' ||
          blob === undefined ||
          countBlob(before, blob) !== 1 ||
          countBlob(after, blob) !== 1
        ) {
          return null;
        }
        current = destination;
      }
    }
    return current !== null && (await this.treeEntries(next)).has(current) ? current : null;
  }

  /** `Repository.proven_deleted`: only an unambiguous deletion is true. */
  async provenDeleted(old: string, next: string, name: string): Promise<boolean> {
    const oldEntries = await this.treeEntries(old);
    const newEntries = await this.treeEntries(next);
    if (!oldEntries.has(name) || newEntries.has(name)) return false;
    const chain = decode(await this.git(['rev-list', '--first-parent', next])).split('\n');
    if (!chain.includes(old)) return false;
    const blob = oldEntries.get(name)?.blob;
    if (
      blob === undefined ||
      countBlob(oldEntries, blob) !== 1 ||
      countBlob(newEntries, blob) > 0
    ) {
      return false;
    }
    const changes = splitNul(
      await this.git([
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--name-status',
        '-z',
        old,
        next,
      ]),
    );
    if (changes.length === 0 || pyTruthyArray(changes[changes.length - 1] as Uint8Array)) {
      return false;
    }
    if (changes.length % 2 !== 1) return false;
    let deleted = false;
    for (let index = 0; index + 1 < changes.length; index += 2) {
      if (bytesEqual(changes[index], 'D') && bytesEqual(changes[index + 1], name)) {
        deleted = true;
        break;
      }
    }
    if (!deleted) return false;
    const renamed = splitNul(
      await this.git([
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--find-renames',
        '-l0',
        '--name-status',
        '-z',
        old,
        next,
      ]),
    );
    for (let index = 0; index < renamed.length - 1; index += 1) {
      const part = renamed[index] as Uint8Array;
      if (
        (startsWithByte(part, 0x52) || startsWithByte(part, 0x43)) &&
        bytesEqual(renamed[index + 1], name)
      ) {
        return false;
      }
    }
    return true;
  }

  // ------------------------------------------------------------------ carry

  /** `Repository.carry`: surviving line numbers of `lines` in `next`. */
  async carry(
    old: string,
    next: string,
    name: string,
    lines: ReadonlySet<number>,
  ): Promise<{ readonly name: string | null; readonly mapped: ReadonlySet<number> }> {
    const cacheable = OID.test(old) && OID.test(next);
    const key = `carry\u0000${old}\u0000${next}\u0000${name}\u0000${ACCOUNTING_BLAME_OPTIONS.join(
      '\u0000',
    )}`;
    let outcome = cacheable
      ? (this.memo(key) as
          | { path: string | null; matches: Map<number, number>; oldLines: number }
          | undefined)
      : undefined;
    if (outcome === undefined) {
      const identity = {
        old,
        new: next,
        path: name,
        options: [...ACCOUNTING_BLAME_OPTIONS],
      };
      const cached = cacheable ? await this.cached('carry', identity) : null;
      const decoded = cached === null ? null : carryFromFact(cached);
      if (decoded !== null) {
        outcome = decoded;
      } else {
        const mapped = await this.lineage(old, next, name);
        let matches = new Map<number, number>();
        let maximum = 0;
        if (mapped !== null) {
          const oldBlame = await this.blame(old, name);
          const newBlame = await this.blame(next, mapped);
          ({ matches, maximum } = carryMatches(oldBlame, newBlame));
        }
        outcome = { path: mapped, matches, oldLines: maximum };
        if (cacheable) {
          await this.persist(
            'carry',
            identity,
            carryFact({
              path: mapped,
              matches: [...matches.entries()],
              oldLines: maximum,
            }),
          );
        }
      }
      if (cacheable) {
        this.remember(key, outcome, 512 + outcome.matches.size * 16);
      }
    }
    return carrySelection(outcome.path, outcome.matches, outcome.oldLines, lines);
  }

  // --------------------------------------------------------------- coverage

  /** `Repository.coverage`: the union fold of creditable review evidence. */
  async coverage(
    target: string,
    reviews: readonly JsonValue[],
    artifacts: ArtifactStore,
  ): Promise<CoverageFold> {
    ledgerValidateSequence(reviews);
    const creditable = reviews.filter((value) => ledgerCreditable(value));
    const identity = {
      target,
      reviews: creditable.map(reviewId),
      options: [...ACCOUNTING_BLAME_OPTIONS],
    };
    const cached = await this.cached('coverage', identity);
    if (cached !== null) {
      try {
        for (const value of creditable) {
          for (const reference of artifactsOf(payloadOf(value))) {
            await this.verifyReference(reference, artifacts);
          }
        }
        const { covered, evidence } = coverageFromFact(cached);
        return { covered, evidence, gaps: [] };
      } catch {
        // Missing evidence is retried below and becomes a gap.
      }
    }
    const covered = new Map<string, Set<number>>();
    const evidence = new Map<string, string[]>();
    const gaps: CoverageGap[] = [];
    await this.fold(target, reviews, artifacts, covered, evidence, gaps);
    if (gaps.length === 0)
      await this.persist('coverage', identity, coverageFact(covered, evidence));
    return { covered, evidence, gaps };
  }

  /**
   * `Repository.fold`: add each creditable review's credit at `target`,
   * carrying it through `lineage`/`carry` when the review target differs.
   */
  async fold(
    target: string,
    reviews: readonly JsonValue[],
    artifacts: ArtifactStore,
    covered: Map<string, Set<number>>,
    evidence: Map<string, string[]>,
    gaps: CoverageGap[],
  ): Promise<void> {
    for (const value of reviews) {
      if (!ledgerCreditable(value)) continue;
      const id = reviewId(value);
      try {
        const payload = payloadOf(value);
        const verified = await this.verifyOnce(value, artifacts);
        for (const [name, lines] of verified) {
          const carried =
            payload.get('target') === target
              ? { name, mapped: lines as ReadonlySet<number> }
              : await this.carry(payloadText(payload, 'target'), target, name, lines);
          if (carried.name === null || carried.mapped.size === 0) continue;
          let rows = covered.get(carried.name);
          if (rows === undefined) {
            rows = new Set<number>();
            covered.set(carried.name, rows);
          }
          for (const number of carried.mapped) rows.add(number);
          let ids = evidence.get(carried.name);
          if (ids === undefined) {
            ids = [];
            evidence.set(carried.name, ids);
          }
          ids.push(id);
        }
      } catch (error) {
        gaps.push({ review: id, reason: messageOf(error).slice(0, 200) });
      }
    }
  }

  /**
   * `Repository._verify_once`: evidence is verified once per immutable
   * invocation and the outcome is reused across targets. `beginInvocation`
   * clears this map, so a gap from an earlier invocation is retried; retained
   * objects are immutable for the duration of one invocation by contract.
   */
  private async verifyOnce(
    value: JsonValue,
    artifacts: ArtifactStore,
  ): Promise<Map<string, Set<number>>> {
    const key = this.immutableCache !== null ? ledgerDigestOf(value) : null;
    if (key !== null) {
      const outcome = this.verified.get(key);
      if (outcome instanceof Error) throw outcome;
      if (outcome !== undefined) return outcome;
    }
    try {
      const payload = payloadOf(value);
      const target = payloadText(payload, 'target');
      for (const reference of artifactsOf(payload)) {
        await this.verifyReference(reference, artifacts);
      }
      const identity = { review: key ?? ledgerDigestOf(value) };
      const cached = await this.cached('verified_review', identity);
      let outcome: Map<string, Set<number>> | null = null;
      if (cached !== null) {
        try {
          outcome = verifiedFromFact(cached);
        } catch {
          outcome = null;
        }
      }
      if (outcome !== null && !(await this.hasCommit(target))) {
        await this.restore(artifactsOf(payload), artifacts);
      }
      if (outcome === null) {
        await this.restore(artifactsOf(payload), artifacts);
        outcome = await this.verifyReview(value);
        await this.persist('verified_review', identity, verifiedFact(outcome));
      }
      if (key !== null) this.verified.set(key, outcome);
      return outcome;
    } catch (error) {
      if (key !== null) this.verified.set(key, asError(error));
      throw error;
    }
  }

  private async hasCommit(commit: string): Promise<boolean> {
    const call = await this.call(['cat-file', '-e', `${commit}^{commit}`], {});
    return call.code === 0;
  }

  // -------------------------------------------------------------- artifacts

  private async verifyReference(
    value: JsonValue,
    artifacts: ArtifactStore,
  ): Promise<VerifiedReference> {
    if (!(value instanceof JsonObject)) throw integrity('artifact reference is malformed');
    const sha256 = value.get('sha256');
    const location = value.get('location');
    if (typeof sha256 !== 'string' || typeof location !== 'string') {
      throw integrity('artifact reference is malformed');
    }
    await artifacts.verify({ sha256, location });
    const kind = value.get('kind');
    return {
      sha256,
      location,
      kind: typeof kind === 'string' ? kind : undefined,
    };
  }

  /** `Repository.restore`: verify every reference, unbundle git bundles. */
  async restore(artifacts: readonly JsonValue[], store: ArtifactStore): Promise<void> {
    for (const reference of artifacts) {
      const parsed = await this.verifyReference(reference, store);
      if (parsed.kind === 'git-bundle') {
        await this.git(['bundle', 'verify', parsed.location]);
        await this.git(['bundle', 'unbundle', parsed.location]);
      }
    }
  }

  /** `Repository.retain`: tie captured commits to durable bundle evidence. */
  async retain(
    store: ArtifactStore,
    commits: readonly string[],
  ): Promise<{ readonly sha256: string; readonly location: string; readonly kind: string }> {
    const refs: string[] = [];
    for (const commit of [...new Set(commits)].sort()) {
      await this.resolve(commit);
      const ref = `refs/crq/evidence/${commit}`;
      const existing = trim(
        await this.git(['rev-parse', '--verify', '--quiet', ref], { check: false }),
      );
      if (existing !== '' && existing !== commit) {
        throw integrity('retained object ref conflict');
      }
      if (existing === '') {
        const zeros = '0'.repeat(commit.length);
        const call = await this.call(['update-ref', ref, commit, zeros], {});
        if (call.code !== 0) {
          const current = trim(await this.git(['rev-parse', '--verify', ref], { check: false }));
          if (current !== commit)
            throw new AccountingGitError(['update-ref', ref], call.code, call.stderr);
        }
      }
      refs.push(ref);
    }
    const directory = await mkdtemp(join(tmpdir(), 'crq-evidence-'));
    try {
      const filename = join(directory, 'evidence.bundle');
      await this.git(['bundle', 'create', filename, ...refs]);
      const reference = await store.put(new Uint8Array(await readFile(filename)));
      return { ...reference, kind: 'git-bundle' };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ churn

  /** `Repository.churn`: first-parent commits touching each path in 30 days. */
  async churn(target: string, evaluatedAt: string): Promise<Map<string, number>> {
    const since = subtractDays(evaluatedAt, 30);
    const commits = decode(
      await this.git([
        'rev-list',
        '--first-parent',
        `--since=${since}`,
        `--until=${evaluatedAt}`,
        target,
      ]),
    )
      .split('\n')
      .filter((line) => line !== '');
    const counts = new Map<string, number>();
    for (const commit of commits) {
      const parents = decode(await this.git(['rev-list', '--parents', '-n', '1', commit]))
        .split(/\s+/)
        .filter((field) => field !== '')
        .slice(1);
      const args = ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z'];
      if (parents.length > 0) args.push(parents[0] as string, commit);
      else args.push(commit);
      const names = splitNul(await this.git(args))
        .map((name) => decode(name))
        .filter((name) => name !== '');
      for (const name of new Set(names)) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }
}

function countBlob(entries: ReadonlyMap<string, TreeEntry>, blob: string): number {
  let count = 0;
  for (const entry of entries.values()) if (entry.blob === blob) count += 1;
  return count;
}

function parseLineageStepFromFact(parent: string, changes: readonly JsonValue[]): LineageStep {
  const parsed: LineageStep['changes'] = [];
  for (const row of changes) {
    if (!Array.isArray(row) || row.length !== 3) {
      throw integrity('lineage step fact is malformed');
    }
    const [status, source, destination] = row;
    if (typeof status !== 'string' || typeof source !== 'string') {
      throw integrity('lineage step fact is malformed');
    }
    parsed.push([status, source, typeof destination === 'string' ? destination : null]);
  }
  return { parent, changes: parsed };
}

/** The oracle's cacheable git invocation shapes. */
function cacheableGitArgs(args: readonly string[]): boolean {
  if (args.length === 3 && args[0] === 'rev-list' && args[1] === '--first-parent') {
    return OID.test(args[2] as string);
  }
  if (args.length === 2 && args[0] === 'rev-parse') {
    return /^[0-9a-f]{40,64}(?:\^1|\^\{commit\}|\^\{tree\})$/.test(args[1] as string);
  }
  if (args.length === 4 && args[0] === 'ls-tree' && args[1] === '-r' && args[2] === '-z') {
    return OID.test(args[3] as string);
  }
  const prefixes: readonly (readonly string[])[] = [
    ['diff', '--name-status', '-z', '--find-renames=100%'],
    ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z'],
    ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '-l0', '--name-status', '-z'],
  ];
  const prefix = args.slice(0, -2);
  const matchesPrefix = prefixes.some(
    (candidate) =>
      candidate.length === prefix.length &&
      candidate.every((value, index) => prefix[index] === value),
  );
  return matchesPrefix && args.slice(-2).every((value) => OID.test(value));
}

function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(days: number): { year: number; month: number; day: number } {
  const shifted = days + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex + (monthIndex < 10 ? 3 : -9);
  return {
    year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0),
    month,
    day,
  };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** `evaluated_at - days`, formatted exactly `YYYY-MM-DDTHH:MM:SSZ`. */
function subtractDays(timestamp: string, days: number): string {
  const at = ledgerTimestamp(timestamp);
  const total =
    daysFromCivil(at.year, at.month, at.day) * 86_400 +
    at.hour * 3600 +
    at.minute * 60 +
    at.second -
    days * 86_400;
  const day = Math.floor(total / 86_400);
  const secondOfDay = total - day * 86_400;
  const date = civilFromDays(day);
  const hour = Math.floor(secondOfDay / 3600);
  const minute = Math.floor((secondOfDay - hour * 3600) / 60);
  const second = secondOfDay - hour * 3600 - minute * 60;
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}T${pad(
    hour,
    2,
  )}:${pad(minute, 2)}:${pad(second, 2)}Z`;
}

/** `backfill_accounting.FACT_SHAPES` re-exported for adapter-level callers. */
export { FACT_SHAPES };
