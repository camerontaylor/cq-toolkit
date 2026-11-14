/**
 * Bounded current-tip subjects and immutable generation pins
 * (`backfill_subjects.construct`).
 *
 * A subject is the smallest partition of one ranked candidate a reviewer can
 * verify: the target tree with the requested paths removed (the projection
 * base), the target tree itself (the head), and only the requested line
 * intervals that actually changed between them. The commits are synthetic and
 * deterministic, so replaying the same candidate produces the same pinned refs.
 *
 * Parity with the Python producer is exact:
 *
 * - names sort by UTF-8 byte order, then stably by tier, so tier dominates and
 *   byte order breaks ties;
 * - splits recurse on the file and total-content limits and on the measured
 *   diff limit; a single oversize file becomes `unsupported` debt, never a
 *   truncated partition;
 * - a partition keeps only requested intervals the head actually changed;
 *   requested lines that cannot be exposed are re-cut with `residual` or
 *   recorded as debt with the oracle's reason strings;
 * - the subject identity is the ledger digest of
 *   `{parent, scope, partition, residual}`, and the scope digest is the digest
 *   of the emitted scope rows;
 * - synthetic kind "A" commits use the fixed `crq <crq@localhost>` identity and
 *   `2000-01-01T00:00:00Z`, and untrusted PR context travels only as inert text
 *   in a commit message.
 *
 * All Git work is injected as {@link BackfillSubjectRepo}. The adapter binding
 * it owns commits, refs and process execution; this module owns the partition
 * arithmetic, the digests and the debt.
 */
import { toPlainJsonDeep } from './jsonValue.js';
import { compareCodePoints, ledgerJsonDigest, ledgerJsonText } from './pythonJson.js';
import {
  effectiveLimits,
  intervalsOf,
  pythonInt,
  pythonNumber,
  rangesOf,
} from './backfillInventory.js';
import {
  isJsonRecord,
  recordEntries,
  recordGet,
  recordHas,
  type JsonRecordLike,
} from './queueDoc.js';

/** A partition-construction refusal (a malformed candidate or scope row). */
export class BackfillSubjectsError extends Error {
  override readonly name: string = 'BackfillSubjectsError';

  constructor(message: string) {
    super(message);
  }
}

function fail(message: string): never {
  throw new BackfillSubjectsError(message);
}

function asDoc(value: unknown, what: string): JsonRecordLike {
  if (!isJsonRecord(value)) fail(`${what} must be an object`);
  return value;
}

function need(document: JsonRecordLike, key: string, what: string): unknown {
  if (!recordHas(document, key)) fail(`${what} is missing ${key}`);
  return recordGet(document, key);
}

function opt(document: JsonRecordLike | null, key: string): unknown {
  return document === null ? undefined : recordGet(document, key);
}

function optionalDoc(
  document: JsonRecordLike | null,
  key: string,
  what: string,
): JsonRecordLike | null {
  const value = opt(document, key);
  return value === undefined || value === null ? null : asDoc(value, what);
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(`${what} must be a string`);
  return value;
}

function definePlain(object: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** A captured candidate copy: every field, in capture order, made plain. */
function copyRow(value: JsonRecordLike): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of recordEntries(value)) {
    definePlain(copy, key, toPlainJsonDeep(entry));
  }
  return copy;
}

/**
 * One inventory row the construction step consumes. The shape is the Stage 1
 * `InventoryRow` minus its cache internals: construction only reads these
 * fields and never rebuilds a row.
 */
export interface SubjectInventoryRow {
  readonly path: string;
  readonly blob: string;
  readonly mode: string;
  readonly kind: string;
  readonly lines: number | null;
  readonly bytes: number | null;
  readonly disposition: string;
  readonly reason: string;
}

/** One tree entry: the baseline record a synthetic partition carries. */
export interface SubjectTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly kind: string;
  readonly blob: string;
}

/** One retained PR member, as `synthetic` reads it. */
export type SubjectMember = JsonRecordLike;

/** Provenance for one path: pre-merge baseline or a projection fallback. */
export type SubjectProvenance = Record<string, unknown>;

/** A projection's two synthetic commits. */
export interface SubjectProjection {
  readonly base: string;
  readonly head: string;
}

/** A synthetic projection plus the baseline that produced each path. */
export interface SubjectSynthetic extends SubjectProjection {
  readonly provenance: Readonly<Record<string, SubjectProvenance>>;
}

/**
 * The Git seam construction reads. `resolve`, `tree`, `inventory` and
 * `changedIntervals` are the Stage 1 accounting repository's read surface; its
 * public `entries` and `lineage` are used by the adapter's synthetic baseline
 * builder. `projection`, `synthetic`, `commitTree`, `pin` and `diffBytes` are
 * the writes and process calls this stage binds in its own adapter.
 *
 * `pin` validates its own generation, partition and identity, because the
 * Python oracle does so inside the seam rather than in `construct`.
 */
export interface BackfillSubjectRepo {
  /** Resolve a full object id to a commit; anything else is refused. */
  resolve(value: string): Promise<string>;
  /** The tree object id of a resolved commit. */
  tree(commit: string): Promise<string>;
  /** Every regular/irregular object at the target, with its classification. */
  inventory(target: string, maxFileBytes: number): Promise<readonly SubjectInventoryRow[]>;
  /** The target tree minus `names`, committed deterministically. */
  projection(target: string, names: readonly string[]): Promise<SubjectProjection>;
  /** Kind "A": the earliest pre-merge baseline on a linear stack, or fallback. */
  synthetic(
    target: string,
    names: readonly string[],
    members: readonly SubjectMember[],
  ): Promise<SubjectSynthetic>;
  /** Create-only pins at `refs/crq/backfill/<identity>/<generation>/<partition>`. */
  pin(
    identity: string,
    generation: unknown,
    partition: unknown,
    base: string,
    head: string,
    target: string,
  ): Promise<string>;
  /** One fixed-identity commit `commit-tree` (synthetic context or projection). */
  commitTree(tree: string, parent: string, message: string): Promise<string>;
  /** Head-side changed line intervals, keyed by path. */
  changedIntervals(base: string, head: string): Promise<ReadonlyMap<string, ReadonlySet<number>>>;
  /** Raw `--binary` diff output length; the verified reviewer byte gate. */
  diffBytes(base: string, head: string): Promise<number>;
}

/** The construction result: pinned partitions plus unsupported debt. */
export interface ConstructResult {
  readonly partitions: Array<Record<string, unknown>>;
  readonly debt: Array<Record<string, unknown>>;
}

interface ObjectState {
  readonly row: SubjectInventoryRow;
  readonly tier: string;
}

function bytesOf(state: ObjectState | undefined, name: string): number {
  const bytes = state?.row.bytes;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes)) {
    fail(`bytes for ${name} must be an integer`);
  }
  return bytes;
}

function baselineOf(
  provenance: Readonly<Record<string, SubjectProvenance>>,
  name: string,
): SubjectProvenance {
  if (!Object.prototype.hasOwnProperty.call(provenance, name)) {
    fail(`synthetic provenance is missing ${name}`);
  }
  return provenance[name] as SubjectProvenance;
}

/**
 * `backfill_subjects.construct(repo, candidate, policy, members, offline)`.
 *
 * `policy` is the deployed construction-limits document (the same one
 * `backfill_inventory.effective_limits` reads), never the ranked manifest. The
 * returned partition rows are ready for the enqueue stage; this function never
 * touches the queue.
 *
 * `offline` relaxes only the reviewer-verification gate, exactly as the Python
 * keyword argument does: a replay may reproduce limits it cannot deploy.
 */
export async function construct(
  repo: BackfillSubjectRepo,
  candidateValue: unknown,
  policy: unknown,
  membersValue: readonly SubjectMember[] = [],
  options: { readonly offline?: boolean } = {},
): Promise<ConstructResult> {
  const limits = effectiveLimits(policy, { requireVerified: options.offline !== true });
  const candidate = asDoc(candidateValue, 'candidate');
  const targetValue = text(need(candidate, 'target', 'candidate'), 'candidate target');
  const kind = need(candidate, 'kind', 'candidate');
  const subjectId = need(candidate, 'subject_id', 'candidate');
  const generation = need(candidate, 'generation', 'candidate');
  const candidateTier = text(need(candidate, 'tier', 'candidate'), 'candidate tier');
  const pathTiers = optionalDoc(candidate, 'path_tiers', 'candidate path_tiers');
  const pathScores = optionalDoc(candidate, 'path_scores', 'candidate path_scores');
  if (!Array.isArray(membersValue)) fail('members must be an array');
  const scopeValue = need(candidate, 'scope', 'candidate');
  if (!Array.isArray(scopeValue)) fail('candidate scope must be an array');

  const target = await repo.resolve(targetValue);
  const objects = new Map<string, ObjectState>();
  for (const row of await repo.inventory(target, limits.perFile)) {
    const tierValue = pathTiers === null ? undefined : recordGet(pathTiers, row.path);
    const tier =
      tierValue === undefined ? candidateTier : text(tierValue, `path tier for ${row.path}`);
    objects.set(row.path, { row, tier });
  }

  const requested = new Map<string, JsonRecordLike>();
  for (const value of scopeValue as readonly unknown[]) {
    const row = asDoc(value, 'scope row');
    const path = text(need(row, 'path', 'scope row'), 'scope row path');
    requested.set(path, row);
  }

  // The context is canonicalised from its captured values, so `review_ledger`'s
  // integer-only domain sees exactly what the members captured. The partition
  // row carries the plain form, as every other emitted row does.
  const rawContext = {
    trust: 'untrusted-data-only',
    prs: need(candidate, 'prs', 'candidate'),
    sources: membersValue.map((value) => {
      const member = asDoc(value, 'subject member');
      return {
        // Python `m.get("pr")`: absence is `None`, a captured `null` stays null.
        pr: recordHas(member, 'pr') ? recordGet(member, 'pr') : null,
        // Python `m.get("context", {})`: absence is an empty object.
        context: recordHas(member, 'context') ? recordGet(member, 'context') : {},
      };
    }),
  };
  const context = toPlainJsonDeep(rawContext) as Record<string, unknown>;

  const debt: Array<Record<string, unknown>> = [];
  const partitions: Array<Record<string, unknown>> = [];
  const names = [...requested.keys()].sort(compareCodePoints);
  const tierOf = (name: string): string => objects.get(name)?.tier ?? candidateTier;
  // JavaScript's sort is stable, so this reproduces Python's two-pass sort:
  // tier first, byte order within a tier.
  names.sort((left, right) => compareCodePoints(tierOf(left), tierOf(right)));

  const eligible: string[] = [];
  for (const name of names) {
    const row = objects.get(name)?.row;
    if (row === undefined) {
      // Python's `row is None or ...` short-circuits before it reads the
      // requested blob, so a missing target path never requires one.
      debt.push({
        path: name,
        reason: 'missing target path',
        disposition: 'ambiguous',
      });
      continue;
    }
    const request = requested.get(name) as JsonRecordLike;
    const blob = text(need(request, 'blob', 'scope row'), 'scope row blob');
    if (row.disposition !== 'included' || row.blob !== blob) {
      debt.push({
        path: name,
        // Python `row.get(key, default)`: a present null stays null.
        reason: Object.prototype.hasOwnProperty.call(row, 'reason')
          ? row.reason
          : 'missing target path',
        disposition: Object.prototype.hasOwnProperty.call(row, 'disposition')
          ? row.disposition
          : 'ambiguous',
      });
      continue;
    }
    eligible.push(name);
  }

  const cut = async (nameset: readonly string[], residual = false): Promise<void> => {
    if (nameset.length === 0) return;
    const totalBytes = nameset.reduce((sum, name) => sum + bytesOf(objects.get(name), name), 0);
    if (nameset.length > limits.files || totalBytes > limits.total) {
      if (nameset.length === 1) {
        debt.push({
          path: nameset[0],
          disposition: 'unsupported',
          reason: 'single file exceeds total content limit',
        });
        return;
      }
      const midpoint = Math.floor(nameset.length / 2);
      await cut(nameset.slice(0, midpoint), residual);
      await cut(nameset.slice(midpoint), residual);
      return;
    }

    let provenance: Readonly<Record<string, SubjectProvenance>>;
    let base: string;
    let head: string;
    if (kind === 'A' && !residual) {
      ({ base, head, provenance } = await repo.synthetic(target, nameset, membersValue));
    } else {
      ({ base, head } = await repo.projection(target, nameset));
      const reason = residual ? 'residual uncovered lines' : 'path cluster';
      const projected: Record<string, SubjectProvenance> = {};
      for (const name of nameset) definePlain(projected, name, { method: 'projection', reason });
      provenance = projected;
    }

    // Context is transported in the synthetic input commit, as inert text. It
    // cannot change the target tree, Git argv, baseline or requested paths.
    if (rawContext.sources.length > 0) {
      const message =
        'crq pinned current subject\n\nBEGIN UNTRUSTED PR CONTEXT\n' +
        ledgerJsonText(rawContext) +
        '\nEND UNTRUSTED PR CONTEXT';
      head = await repo.commitTree(await repo.tree(target), base, message);
    }

    const diffBytes = await repo.diffBytes(base, head);
    if (limits.diff !== null && diffBytes > limits.diff) {
      if (nameset.length > 1) {
        const middle = Math.floor(nameset.length / 2);
        await cut(nameset.slice(0, middle), residual);
        await cut(nameset.slice(middle), residual);
      } else {
        debt.push({
          path: nameset[0],
          disposition: 'unsupported',
          reason: 'single-file diff exceeds verified reviewer byte limit',
        });
      }
      return;
    }

    const changed = await repo.changedIntervals(base, head);
    const scope: Array<Record<string, unknown>> = [];
    const remaining: string[] = [];
    for (const name of nameset) {
      const request = requested.get(name) as JsonRecordLike;
      // The default label keeps Python's exact refusal text:
      // `invalid or overlapping intervals`.
      const lines = intervalsOf(need(request, 'intervals', 'scope row'));
      const actual = changed.get(name) ?? new Set<number>();
      const seen = new Set<number>();
      let unexposed = false;
      for (const line of lines) {
        if (actual.has(line)) seen.add(line);
        else unexposed = true;
      }
      if (seen.size > 0) {
        scope.push({
          path: name,
          blob: (objects.get(name) as ObjectState).row.blob,
          intervals: rangesOf(seen),
        });
      }
      if (unexposed) remaining.push(name);
    }

    if (scope.length > 0) {
      const number = partitions.length;
      const identity = ledgerJsonDigest({
        parent: toPlainJsonDeep(subjectId),
        scope,
        partition: number,
        residual,
      });
      const refs = await repo.pin(identity, generation, number, base, head, target);
      let tier = text((objects.get(scope[0]?.path as string) as ObjectState).tier, 'path tier');
      let score = 0;
      // Python's tier/score fold covers the *scope* rows, not the whole
      // partition: a path cut into the residual partition must not lower the
      // tier or add its score to the initial partition.
      for (const row of scope) {
        const name = row['path'] as string;
        const state = objects.get(name) as ObjectState;
        if (compareCodePoints(state.tier, tier) < 0) tier = state.tier;
        const raw = pathScores === null ? undefined : recordGet(pathScores, name);
        score += raw === undefined ? 0 : pythonNumber(raw, `path score for ${name}`);
      }
      const paths = nameset.map((name) => {
        const state = objects.get(name) as ObjectState;
        return {
          path: name,
          blob: state.row.blob,
          mode: state.row.mode,
          disposition: 'included',
          reason: 'bounded verified input',
          baseline: baselineOf(provenance, name),
        };
      });
      const partition = copyRow(candidate);
      definePlain(partition, 'subject_id', identity);
      definePlain(partition, 'inventory_subject_id', toPlainJsonDeep(subjectId));
      definePlain(partition, 'tier', tier);
      definePlain(partition, 'score', score);
      definePlain(
        partition,
        'job_id',
        `${identity}:${String(pythonInt(generation, 'candidate generation'))}`,
      );
      definePlain(partition, 'partition', number);
      definePlain(partition, 'scope', scope);
      definePlain(partition, 'scope_digest', ledgerJsonDigest(scope));
      definePlain(partition, 'base', base);
      definePlain(partition, 'head', head);
      definePlain(partition, 'head_tree', await repo.tree(head));
      definePlain(partition, 'target_tree', await repo.tree(target));
      definePlain(partition, 'refs', refs);
      definePlain(partition, 'paths', paths);
      definePlain(partition, 'diff_bytes', diffBytes);
      definePlain(partition, 'residual', residual);
      definePlain(partition, 'context', context);
      partitions.push(partition);
    }

    if (remaining.length > 0) {
      if (residual) {
        for (const name of remaining) {
          debt.push({
            path: name,
            disposition: 'unsupported',
            reason: 'projection cannot expose requested head intervals',
          });
        }
      } else {
        await cut(remaining, true);
      }
    }
  };

  await cut(eligible);
  return { partitions, debt };
}
