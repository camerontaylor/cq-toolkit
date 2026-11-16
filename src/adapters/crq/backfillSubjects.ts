/**
 * Git binding for `backfill_subjects`: deterministic projections, synthetic
 * pre-merge baselines, and create-only generation pins.
 *
 * The write half lives here because it commits objects and updates refs.
 * Accounting reads are delegated to the merged Stage 1
 * {@link GitAccountingRepository}: its public `entries`, `changedIntervals` and
 * `lineage` methods are the exact read surface this adapter uses, so no parser
 * or cache is reimplemented here. Ancestry probes, index rewrites,
 * `commit-tree` and ref updates run on the injected `RunGit` directly.
 *
 * Exact behaviours kept from the Python oracle:
 *
 * - projection and synthetic commits use the fixed `crq <crq@localhost>`
 *   identity and `2000-01-01T00:00:00Z`, so a replay produces the same object
 *   ids;
 * - projection removes requested paths through a throwaway index, keeping the
 *   target tree as the head;
 * - synthetic kind "A" ranks members by ancestry, refuses a nonlinear stack,
 *   and falls back to a full projection with the oracle's reason strings;
 * - a pre-merge baseline is only used when lineage is unique and verified, and
 *   only a regular 100644/100755 entry may be installed into the index;
 * - pins are create-only (`update-ref <ref> <sha> 0000…`); an existing ref with
 *   a different object id is the `immutable subject pin conflict` refusal;
 * - the diff byte gate is the raw length of the
 *   `--no-ext-diff --no-textconv --binary` patch, written to a temporary file
 *   so an oversized historical baseline is measured, not buffered.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pythonInt } from '../../policy/crq/backfillInventory.js';
import {
  BackfillSubjectsError,
  type BackfillSubjectRepo,
  type SubjectInventoryRow,
  type SubjectMember,
  type SubjectProjection,
  type SubjectProvenance,
  type SubjectSynthetic,
} from '../../policy/crq/backfillSubjects.js';
import { LedgerIntegrityError, ledgerPath } from '../../policy/crq/ledger.js';
import { compareCodePoints } from '../../policy/crq/pythonJson.js';
import {
  isJsonRecord,
  pyTruthy,
  recordGet,
  recordHas,
  type JsonRecordLike,
} from '../../policy/crq/queueDoc.js';
import type { GitAccountingRepository, TreeEntry } from './backfillAccounting.js';
import type { RunGit } from './ledgerGit.js';

/** A Git invocation the construction step cannot continue past. */
export class SubjectGitError extends Error {
  override readonly name: string = 'SubjectGitError';
  readonly code: number | null;
  readonly stderr: string;

  constructor(args: readonly string[], code: number | null, stderr: string) {
    super(`git ${args[0] ?? ''} failed: ${stderr.trim() || `exit ${code ?? 'signal'}`}`);
    this.code = code;
    this.stderr = stderr;
  }
}

export interface GitSubjectOptions {
  /** Hardened runner bound to the repository (`runGitIn(repo)`). */
  readonly runGit: RunGit;
  /** The merged Stage 1 accounting repository over the same clone. */
  readonly accounting: GitAccountingRepository;
}

interface ParsedMember {
  readonly merge: string;
  readonly paths: readonly JsonRecordLike[];
}

type SyntheticBaseline = {
  readonly method: 'pre-merge';
  readonly merge: string;
  readonly pre: string;
  readonly source_path: string;
  readonly entry: Record<string, string> | null;
};

/** Fixed committer for synthetic objects, exactly `backfill_subjects._commit`. */
const COMMITTER_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'crq',
  GIT_AUTHOR_EMAIL: 'crq@localhost',
  GIT_COMMITTER_NAME: 'crq',
  GIT_COMMITTER_EMAIL: 'crq@localhost',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

const NON_REGULAR: unique symbol = Symbol('non-regular baseline');

function fail(message: string): never {
  throw new BackfillSubjectsError(message);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function definePlain(object: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** `sorted(set(names), key=lambda n: n.encode())`. */
function sortedUnique(names: readonly string[]): string[] {
  return [...new Set(names)].sort(compareCodePoints);
}

/** The baseline entry shape Python's `Repository.entries` freezes. */
function plainEntry(entry: TreeEntry): Record<string, string> {
  return { path: entry.path, mode: entry.mode, kind: entry.kind, blob: entry.blob };
}

function parseMembers(members: readonly SubjectMember[]): ParsedMember[] {
  return members.map((value, index) => {
    if (!isJsonRecord(value)) fail(`subject member ${index} must be an object`);
    const merge = recordGet(value, 'merge');
    if (typeof merge !== 'string') fail(`subject member ${index} merge must be a string`);
    // Python `member.get("paths", [])`: an absent list has no candidates.
    const pathsValue = recordHas(value, 'paths') ? recordGet(value, 'paths') : [];
    if (!Array.isArray(pathsValue)) fail(`subject member ${index} paths must be an array`);
    const paths = pathsValue.map((row, pathIndex) => {
      if (!isJsonRecord(row)) fail(`subject member ${index} path ${pathIndex} must be an object`);
      if (typeof recordGet(row, 'path') !== 'string') {
        fail(`subject member ${index} path ${pathIndex} must name a path`);
      }
      return row;
    });
    return { merge, paths };
  });
}

/**
 * The Git-backed subject interleaving. One instance owns no mutable state, so
 * it can be shared across candidates; the accounting repository keeps its own
 * per-invocation caches.
 */
export class GitSubjectRepository implements BackfillSubjectRepo {
  private readonly runGit: RunGit;
  private readonly accounting: GitAccountingRepository;

  constructor(options: GitSubjectOptions) {
    this.runGit = options.runGit;
    this.accounting = options.accounting;
  }

  private async gitOk(
    args: readonly string[],
    options: { readonly env?: Record<string, string>; readonly input?: Uint8Array } = {},
  ): Promise<Uint8Array> {
    const call = await this.runGit(args, options);
    if (call.code !== 0) throw new SubjectGitError(args, call.code, call.stderr);
    return call.stdout;
  }

  /** One throwaway index for a tree rewrite, removed whatever happens. */
  private async withIndex<T>(run: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'cq-crq-subject-index-'));
    try {
      return await run({
        GIT_INDEX_FILE: join(directory, 'index'),
        GIT_LITERAL_PATHSPECS: '1',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    return (await this.runGit(['merge-base', '--is-ancestor', a, b])).code === 0;
  }

  /** One throwaway directory for a file-producing Git call. */
  private async withTemp<T>(run: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'cq-crq-subject-diff-'));
    try {
      return await run(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  resolve(value: string): Promise<string> {
    return this.accounting.resolve(value);
  }

  tree(commit: string): Promise<string> {
    return this.accounting.tree(commit);
  }

  inventory(target: string, maxFileBytes: number): Promise<readonly SubjectInventoryRow[]> {
    return this.accounting.inventory(target, maxFileBytes);
  }

  changedIntervals(base: string, head: string): Promise<ReadonlyMap<string, ReadonlySet<number>>> {
    return this.accounting.changedIntervals(base, head);
  }

  /** `backfill_subjects.projection`. */
  async projection(target: string, names: readonly string[]): Promise<SubjectProjection> {
    const resolved = await this.accounting.resolve(target);
    const tree = await this.withIndex(async (env) => {
      await this.gitOk(['read-tree', resolved], { env });
      for (const name of sortedUnique(names)) {
        ledgerPath(name);
        await this.gitOk(['update-index', '--force-remove', '--', name], { env });
      }
      return decode(await this.gitOk(['write-tree'], { env })).trim();
    });
    const base = await this.commitTree(tree, resolved, 'crq current projection base');
    const head = await this.commitTree(
      await this.accounting.tree(resolved),
      base,
      'crq current projection head',
    );
    return { base, head };
  }

  /** `backfill_subjects.synthetic`. */
  async synthetic(
    target: string,
    names: readonly string[],
    members: readonly SubjectMember[],
  ): Promise<SubjectSynthetic> {
    const resolved = await this.accounting.resolve(target);
    // Python sorts by merge string, validates every merge, then ranks by the
    // number of members that are ancestors of each member.
    const ordered = parseMembers(members).sort((left, right) =>
      compareCodePoints(left.merge, right.merge),
    );
    for (const member of ordered) await this.accounting.resolve(member.merge);
    // Python probes serially. An N² fan-out would launch every Git process at
    // once, so a large stack could exhaust the process or descriptor budget.
    const keyed: Array<{ readonly member: ParsedMember; readonly depth: number }> = [];
    for (const member of ordered) {
      let depth = 0;
      for (const other of ordered) {
        if (await this.isAncestor(other.merge, member.merge)) depth += 1;
      }
      keyed.push({ member, depth });
    }
    keyed.sort(
      (left, right) =>
        left.depth - right.depth || compareCodePoints(left.member.merge, right.member.merge),
    );
    const chain = keyed.map((entry) => entry.member);
    for (let index = 0; index + 1 < chain.length; index += 1) {
      const before = chain[index] as ParsedMember;
      const after = chain[index + 1] as ParsedMember;
      if (!(await this.isAncestor(before.merge, after.merge))) {
        return this.projectionFallback(resolved, names, 'nonlinear stack baselines');
      }
    }

    const baselines: Record<string, SyntheticBaseline> = {};
    for (const name of names) {
      for (const member of chain) {
        const matches = member.paths.filter((row) => recordGet(row, 'path') === name);
        if (matches.length === 0) continue;
        const row = matches[0] as JsonRecordLike;
        if (matches.length !== 1 || !pyTruthy(recordGet(row, 'lineage_verified'))) break;
        const original = ledgerPath(recordGet(row, 'source_path') as string | undefined);
        if ((await this.accounting.lineage(member.merge, resolved, original)) !== name) break;
        const pre = decode(await this.gitOk(['rev-parse', `${member.merge}^1`])).trim();
        const old = (await this.accounting.entries(pre)).get(original);
        definePlain(baselines, name, {
          method: 'pre-merge',
          merge: member.merge,
          pre,
          source_path: original,
          entry: old === undefined ? null : plainEntry(old),
        });
        break;
      }
    }
    if (Object.keys(baselines).length !== names.length) {
      return this.projectionFallback(resolved, names, 'missing/ambiguous baseline lineage');
    }

    const tree = await this.withIndex(async (env) => {
      await this.gitOk(['read-tree', resolved], { env });
      for (const [name, baseline] of Object.entries(baselines)) {
        const entry = baseline.entry;
        if (entry !== null && (entry['mode'] === '100644' || entry['mode'] === '100755')) {
          await this.gitOk(
            ['update-index', '--add', '--cacheinfo', `${entry['mode']},${entry['blob']},${name}`],
            { env },
          );
        } else if (entry !== null) {
          // Python returns the projection fallback without writing a tree.
          return NON_REGULAR;
        } else {
          await this.gitOk(['update-index', '--force-remove', '--', name], { env });
        }
      }
      return decode(await this.gitOk(['write-tree'], { env })).trim();
    });
    if (tree === NON_REGULAR) {
      return this.projectionFallback(resolved, names, 'non-regular baseline');
    }
    const base = await this.commitTree(tree, resolved, 'crq pinned synthetic base');
    const head = await this.commitTree(
      await this.accounting.tree(resolved),
      base,
      'crq pinned synthetic head',
    );
    return { base, head, provenance: baselines };
  }

  /** `backfill_subjects.pin`: create-only refs, immutable per generation. */
  async pin(
    identity: string,
    generation: unknown,
    partition: unknown,
    base: string,
    head: string,
    target: string,
  ): Promise<string> {
    let generationNumber: number;
    let partitionNumber: number;
    try {
      generationNumber = pythonInt(generation, 'pin generation');
      partitionNumber = pythonInt(partition, 'pin partition');
    } catch {
      throw new LedgerIntegrityError('invalid pin generation/partition');
    }
    if (generationNumber < 0 || partitionNumber < 0) {
      throw new LedgerIntegrityError('invalid pin generation/partition');
    }
    if (typeof identity !== 'string' || !/^[0-9a-f]{64}$/.test(identity)) {
      throw new LedgerIntegrityError('invalid subject identity');
    }
    const prefix = `refs/crq/backfill/${identity}/${String(generationNumber)}/${String(partitionNumber)}`;
    const pins: ReadonlyArray<readonly [string, string]> = [
      ['base', base],
      ['head', head],
      ['target', target],
    ];
    for (const [label, sha] of pins) {
      const ref = `${prefix}/${label}`;
      // Python's `check=False` read: an absent ref is empty output, never a
      // raised process error, so a missing ref starts the create-only path.
      const existing = decode(
        (await this.runGit(['rev-parse', '--verify', '--quiet', ref])).stdout,
      ).trim();
      if (existing !== '' && existing !== sha) {
        throw new LedgerIntegrityError('immutable subject pin conflict');
      }
      if (existing === '') {
        const swap = await this.runGit(['update-ref', ref, sha, '0'.repeat(sha.length)]);
        if (swap.code !== 0) {
          // A concurrent creator either wrote our object id (fine) or a
          // different one (the original failure stands).
          const verify = await this.runGit(['rev-parse', '--verify', ref]);
          if (verify.code !== 0 || decode(verify.stdout).trim() !== sha) {
            throw new SubjectGitError(['update-ref', ref], swap.code, swap.stderr);
          }
        }
      }
    }
    return prefix;
  }

  /** `backfill_subjects._commit`: fixed identity and date. */
  async commitTree(tree: string, parent: string, message: string): Promise<string> {
    // `-m` would put the whole context on argv; stdin keeps the same commit
    // bytes (`-F` reads the message verbatim) without an argv-size ceiling.
    // `-m` ensures one trailing newline, so a message that lacks one gets it.
    const input = new TextEncoder().encode(message.endsWith('\n') ? message : `${message}\n`);
    return decode(
      await this.gitOk(['commit-tree', tree, '-p', parent, '-F', '-'], {
        env: { ...COMMITTER_ENV },
        input,
      }),
    ).trim();
  }

  /** The raw `--binary` diff length; no repository config can reshape it. */
  async diffBytes(base: string, head: string): Promise<number> {
    // `--output` writes the patch to disk, so an oversized historical baseline
    // is measured instead of overflowing the runner's stdout buffer. The file
    // content is exactly the stdout bytes the oracle measured.
    return this.withTemp(async (directory) => {
      const output = join(directory, 'patch');
      await this.gitOk([
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--binary',
        `--output=${output}`,
        base,
        head,
      ]);
      try {
        return (await stat(output)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
    });
  }

  private async projectionFallback(
    target: string,
    names: readonly string[],
    reason: string,
  ): Promise<SubjectSynthetic> {
    const projected = await this.projection(target, names);
    const provenance: Record<string, SubjectProvenance> = {};
    for (const name of names) definePlain(provenance, name, { method: 'projection', reason });
    return { base: projected.base, head: projected.head, provenance };
  }
}

/** The repository binding the construction route injects. */
export function gitSubjectRepository(options: GitSubjectOptions): GitSubjectRepository {
  return new GitSubjectRepository(options);
}
