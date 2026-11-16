/**
 * `backfill_accounting.Repository`'s coverage surface over the hardened
 * `RunGit` seam: the fold that turns creditable reviews into per-target line
 * credit, plus the first-parent lineage/blame carry that maps a review's
 * target-side lines onto the coverage target.
 *
 * Python parity, kept exactly:
 *
 * - `fold` skips non-creditable records, verifies retained artifacts and
 *   `verify_review` inside one try, and records any failure as a gap
 *   `{"review": <id>, "reason": <message[:200]>}` for that review only.
 * - A review whose `payload.target` is the coverage target credits its
 *   `reviewed_scope` directly; otherwise `carry` maps each path forward.
 * - `carry`'s lineage is only first-parent ancestry plus unique exact renames
 *   (`R100`, one source blob and one destination blob). Any deletion, copy,
 *   non-exact rename or duplicate blob ends inherited credit.
 * - Line carry matches `git blame --line-porcelain` rows by (origin commit,
 *   original line, filename, content) tuples that are unique on both sides.
 * - One refresher invocation memoizes immutable git reads (trees, lineage
 *   steps, blame, and a review's verification outcome), so a failed artifact
 *   restore is retried once per invocation, not once per target.
 *
 * `Repository.verify_review` itself lives in `./reviewVerify.ts`; this module
 * adds only what the coverage fold needs.
 */
import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { LedgerIntegrityError, ledgerCreditable, ledgerDigestOf } from '../../policy/crq/ledger.js';
import type { RunGit } from './ledgerGit.js';
import { repositoryEntries, verifyReview } from './reviewVerify.js';

function integrity(message: string): LedgerIntegrityError {
  return new LedgerIntegrityError(message);
}

/** Python `BLAME_OPTIONS`. */
const BLAME_OPTIONS = ['--line-porcelain', '--encoding=UTF-8'] as const;

/** Python's `str(exc)[:200]` for a gap reason. */
const GAP_CHARS = 200;

/** A blame row: origin commit, original line, filename bytes, content bytes. */
type BlameRow = readonly [string, number, string, string];

/** One `--name-status` row from the lineage step. */
interface NameStatusRow {
  readonly status: string;
  readonly source: string;
  readonly destination: string | null;
}

type RepositoryEntries = Map<string, { mode: string; blob: string }>;

/** A memoized carry: the mapped path and the old->new line map. */
interface CarryResult {
  readonly path: string | null;
  readonly matches: ReadonlyMap<number, number>;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** Latin-1 keeps one character per byte, so signatures compare byte-exactly. */
function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

function truncated(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return [...text].slice(0, GAP_CHARS).join('');
}

/**
 * The coverage fold's repository. Every git read is memoized for one
 * `beginInvocation` (Python's immutable-object cache), and verification
 * outcomes are memoized too so one failing restore is retried once per pass.
 */
export class GitCoverageRepository {
  private readonly runGit: RunGit;
  private readonly entryCache = new Map<string, RepositoryEntries>();
  private readonly lineageStepCache = new Map<
    string,
    { readonly parent: string; readonly changes: readonly NameStatusRow[] }
  >();
  private readonly blameCache = new Map<string, readonly BlameRow[]>();
  private readonly lineageCache = new Map<string, string | null>();
  private readonly carryCache = new Map<string, CarryResult>();
  private readonly verified = new Map<string, Map<string, Set<number>> | Error>();

  constructor(runGit: RunGit) {
    this.runGit = runGit;
  }

  /** `Repository.begin_invocation`: forget prior verification outcomes. */
  beginInvocation(): void {
    this.entryCache.clear();
    this.lineageStepCache.clear();
    this.blameCache.clear();
    this.lineageCache.clear();
    this.carryCache.clear();
    this.verified.clear();
  }

  private async callGit(args: readonly string[]): Promise<Uint8Array> {
    const call = await this.runGit(args);
    if (call.code !== 0) {
      throw integrity(
        `git ${args[0] ?? ''} failed: ${call.stderr.slice(0, 200) || `exit ${call.code ?? 'signal'}`}`,
      );
    }
    return call.stdout;
  }

  private async resolve(commit: string): Promise<string> {
    return decode(await this.callGit(['rev-parse', `${commit}^{commit}`])).trim();
  }

  /** `Repository.entries`, memoized per invocation. */
  async entries(commit: string): Promise<RepositoryEntries> {
    const resolved = await this.resolve(commit);
    const cached = this.entryCache.get(resolved);
    if (cached !== undefined) return cached;
    const value = await repositoryEntries(this.runGit, resolved);
    this.entryCache.set(resolved, value);
    return value;
  }

  /** `Repository._lineage_step`: first parent plus its exact-rename diff. */
  private async lineageStep(
    commit: string,
  ): Promise<{ readonly parent: string; readonly changes: readonly NameStatusRow[] }> {
    const cached = this.lineageStepCache.get(commit);
    if (cached !== undefined) return cached;
    const parent = decode(await this.callGit(['rev-parse', `${commit}^1`])).trim();
    const raw = await this.callGit([
      'diff',
      '--name-status',
      '-z',
      '--find-renames=100%',
      parent,
      commit,
    ]);
    // Paths are UTF-8 (`_lineage_step` decodes them with `utf-8`); Latin-1 here
    // would mojibake a non-ASCII rename and the final tree lookup in
    // `computeLineage` would miss a name `entries()` spells correctly. Blame
    // signatures keep Latin-1: those compare bytes, never paths.
    const fields = decode(raw).split('\0');
    const changes: NameStatusRow[] = [];
    let index = 0;
    while (index < fields.length - 1) {
      const status = fields[index] as string;
      const source = fields[index + 1] as string;
      index += 2;
      let destination: string | null = null;
      if (status.startsWith('R') || status.startsWith('C')) {
        destination = fields[index] as string;
        index += 1;
      }
      changes.push({ status, source, destination });
    }
    const value = { parent, changes };
    this.lineageStepCache.set(commit, value);
    return value;
  }

  /** `Repository._lineage`: first-parent ancestry and unique exact renames. */
  async lineage(old: string, next: string, name: string): Promise<string | null> {
    const key = `${old}\u0000${next}\u0000${name}`;
    if (this.lineageCache.has(key)) return this.lineageCache.get(key) as string | null;
    const value = await this.computeLineage(old, next, name);
    this.lineageCache.set(key, value);
    return value;
  }

  private async computeLineage(old: string, next: string, name: string): Promise<string | null> {
    if (!(await this.entries(old)).has(name)) return null;
    const chain = decode(await this.callGit(['rev-list', '--first-parent', next]))
      .split('\n')
      .filter((line) => line !== '');
    const position = chain.indexOf(old);
    if (position < 0) return null;
    let current = name;
    for (const commit of chain.slice(0, position).reverse()) {
      const { parent, changes } = await this.lineageStep(commit);
      for (const change of changes) {
        if (change.source !== current) continue;
        if (change.status === 'D' || change.status.startsWith('C')) return null;
        if (change.status.startsWith('R')) {
          const before = await this.entries(parent);
          const after = await this.entries(commit);
          const blob = before.get(current)?.blob;
          if (
            change.status !== 'R100' ||
            blob === undefined ||
            countBlob(before, blob) !== 1 ||
            countBlob(after, blob) !== 1
          ) {
            return null;
          }
          current = change.destination ?? current;
        }
      }
    }
    return (await this.entries(next)).has(current) ? current : null;
  }

  /** `Repository.blame`: one row per line, in file order. */
  async blame(target: string, name: string): Promise<readonly BlameRow[]> {
    const key = `${target}\u0000${name}`;
    const cached = this.blameCache.get(key);
    if (cached !== undefined) return cached;
    const raw = await this.callGit(['blame', ...BLAME_OPTIONS, target, '--', name]);
    const rows: BlameRow[] = [];
    let origin: string | null = null;
    let originalLine = 0;
    let filename: string | null = null;
    for (const line of latin1(raw).split('\n')) {
      const header = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/.exec(line);
      if (header !== null) {
        origin = header[1] as string;
        originalLine = Number(header[2]);
        continue;
      }
      if (line.startsWith('filename ')) {
        filename = line.slice(9);
        continue;
      }
      if (line.startsWith('\t')) {
        if (origin === null || filename === null) throw integrity('malformed blame output');
        rows.push([origin, originalLine, filename, line.slice(1)]);
      }
    }
    this.blameCache.set(key, rows);
    return rows;
  }

  /**
   * `Repository.carry`: map each of `lines` at `old`/`name` onto `next`,
   * keeping only lines whose (origin, original line, filename, content)
   * signature is unique on both sides.
   */
  async carry(
    old: string,
    next: string,
    name: string,
    lines: ReadonlySet<number>,
  ): Promise<readonly [string | null, ReadonlySet<number>]> {
    const key = `${old}\u0000${next}\u0000${name}`;
    let result = this.carryCache.get(key);
    if (result === undefined) {
      result = await this.computeCarry(old, next, name);
      this.carryCache.set(key, result);
    }
    if (result.path === null) return [null, new Set<number>()];
    const selected = new Set<number>();
    for (const line of lines) {
      const target = result.matches.get(line);
      if (target !== undefined) selected.add(target);
    }
    return [result.path, selected];
  }

  private async computeCarry(old: string, next: string, name: string): Promise<CarryResult> {
    const mapped = await this.lineage(old, next, name);
    if (mapped === null) return { path: null, matches: new Map() };
    const oldBlame = await this.blame(old, name);
    const newBlame = await this.blame(next, mapped);
    const newCounts = new Map<string, number>();
    for (const row of newBlame) {
      const signature = blameKey(row);
      newCounts.set(signature, (newCounts.get(signature) ?? 0) + 1);
    }
    const positions = new Map<string, number>();
    newBlame.forEach((row, index) => {
      const signature = blameKey(row);
      if (newCounts.get(signature) === 1) positions.set(signature, index + 1);
    });
    const oldCounts = new Map<string, number>();
    for (const row of oldBlame) {
      const signature = blameKey(row);
      oldCounts.set(signature, (oldCounts.get(signature) ?? 0) + 1);
    }
    const matches = new Map<number, number>();
    oldBlame.forEach((row, index) => {
      const signature = blameKey(row);
      if (oldCounts.get(signature) === 1 && positions.has(signature)) {
        matches.set(index + 1, positions.get(signature) as number);
      }
    });
    return { path: mapped, matches };
  }

  /**
   * `Repository.fold`: add each creditable review's verified credit at
   * `target`. Failures are gaps for that review, never thrown.
   */
  async fold(
    target: string,
    reviews: readonly JsonValue[],
    verifyArtifact: (reference: {
      readonly sha256: string;
      readonly location: string;
    }) => Promise<void>,
    covered: Map<string, Set<number>>,
    gaps: JsonValue[],
  ): Promise<void> {
    for (const review of reviews) {
      if (!ledgerCreditable(review)) continue;
      const value = review as JsonObject;
      const id = value.get('id');
      if (typeof id !== 'string') throw integrity('review id must be a string');
      let verified: Map<string, Set<number>>;
      try {
        verified = await this.verifyOnce(value, verifyArtifact);
      } catch (error) {
        gaps.push(
          new JsonObject([
            ['review', id],
            ['reason', truncated(error)],
          ]),
        );
        continue;
      }
      const payload = value.get('payload');
      if (!(payload instanceof JsonObject)) throw integrity('review payload is not an object');
      const reviewTarget = payload.get('target');
      if (typeof reviewTarget !== 'string') throw integrity('review target must be a string');
      for (const [name, lines] of verified) {
        if (reviewTarget === target) {
          const credit = covered.get(name) ?? new Set<number>();
          for (const line of lines) credit.add(line);
          covered.set(name, credit);
          continue;
        }
        // A lineage/blame failure is a gap for this review, not a failed
        // refresh: Python folds carry inside the same try.
        let carried: readonly [string | null, ReadonlySet<number>];
        try {
          carried = await this.carry(reviewTarget, target, name, lines);
        } catch (error) {
          gaps.push(
            new JsonObject([
              ['review', id],
              ['reason', truncated(error)],
            ]),
          );
          break;
        }
        const [mapped, inherited] = carried;
        if (mapped === null || inherited.size === 0) continue;
        const credit = covered.get(mapped) ?? new Set<number>();
        for (const line of inherited) credit.add(line);
        covered.set(mapped, credit);
      }
    }
  }

  /** `Repository._verify_once`, memoized per invocation including failures. */
  private async verifyOnce(
    value: JsonObject,
    verifyArtifact: (reference: {
      readonly sha256: string;
      readonly location: string;
    }) => Promise<void>,
  ): Promise<Map<string, Set<number>>> {
    const key = ledgerDigestOf(value);
    const cached = this.verified.get(key);
    // Python stores the exception object itself, so a failing artifact restore
    // is attempted once per target pass, not once per target: the reuse is what
    // keeps a broken bundle from being restored for every coverage target.
    if (cached instanceof Error) throw cached;
    if (cached !== undefined) return cached;
    let result: Map<string, Set<number>>;
    try {
      result = await verifyReview(this.runGit, value, verifyArtifact);
    } catch (error) {
      this.verified.set(key, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    this.verified.set(key, result);
    return result;
  }
}

function blameKey(row: BlameRow): string {
  return `${row[0]}\u0000${row[1]}\u0000${row[2]}\u0000${row[3]}`;
}

function countBlob(entries: RepositoryEntries, blob: string): number {
  let total = 0;
  for (const entry of entries.values()) if (entry.blob === blob) total += 1;
  return total;
}

/** The scheduler clone's coverage repository, bound to one hardened runner. */
export function gitCoverageRepository(runGit: RunGit): GitCoverageRepository {
  return new GitCoverageRepository(runGit);
}
