/**
 * `crq.build_synthetic` (apps/crq-python/crq.py:1102-1118): the explicit,
 * immutable `T` current-projection subject for a merged item, with the
 * generation pins that replace mutable per-PR refs. Inactive: nothing routes it,
 * and `LIVE_UNIT_COMMANDS` and `repairUnit.ts` are untouched.
 *
 * Python-to-TS map:
 *
 * | Python                                            | TypeScript                                   |
 * | ------------------------------------------------- | -------------------------------------------- |
 * | `repo.resolve(target)` (:1105)                    | `accounting.resolve`                          |
 * | `item["merge_commit"]` (:1106)                    | `pyIndex(item, 'merge_commit')`               |
 * | `(item.get("measure") or {}).get("synthetic_paths")` (:1107) | `pyGet` after `pyTruthy`           |
 * | `synth_paths(merge, target)` (:1086)              | `synthPaths` (`measureMerged.ts`)             |
 * | `repo.entries(target)` and the `sorted(...)` filter (:1108-1109) | `accounting.entries`, `compareCodePoints` |
 * | `subjects.projection` (`backfill_subjects.py:19`) | `GitSubjectRepository.projection`             |
 * | `ledger.digest({item, target, paths})` (:1114)    | `ledgerJsonDigest`                            |
 * | `subjects.pin` (`backfill_subjects.py:83`)        | `GitSubjectRepository.pin`                    |
 *
 * Python semantics kept: the filter keeps duplicate entries of a caller-supplied
 * `synthetic_paths` (it sorts a list, not a set) and `paths` counts them; an
 * unhashable element is a `TypeError` raised before any object is written; a
 * non-dict truthy `measure` is an `AttributeError`; `item["id"]` is read only
 * after the projection commits are written, so an item without an id leaves the
 * (unreferenced) projection objects behind, as Python does.
 */
import { JsonNumber } from '../../policy/crq/jsonValue.js';
import { synthPaths, type MeasureGit } from '../../queue-runner/measureMerged.js';
import { pyTruthy } from '../../policy/crq/coverageUtilization.js';
import {
  compareCodePoints,
  pyGet,
  pyGetOr,
  pyTypeName,
  pyIndex,
  pyIter,
  PyError,
} from '../../policy/crq/pyCompat.js';
import { ledgerJsonDigest, type PythonJsonInput } from '../../policy/crq/pythonJson.js';
import type { GitAccountingRepository } from './backfillAccounting.js';
import type { GitSubjectRepository } from './backfillSubjects.js';

export interface BuildSyntheticDeps {
  /** `crq.git` over the primary clone, for `synth_paths`. */
  readonly git: MeasureGit;
  /** `backfill_runtime.accounting.Repository(CLONE)`: `resolve` and `entries`. */
  readonly accounting: Pick<GitAccountingRepository, 'resolve' | 'entries'>;
  /** The subject writer over the same clone: `projection` and `pin`. */
  readonly subjects: Pick<GitSubjectRepository, 'projection' | 'pin'>;
}

export type SyntheticSubject = { base: string; head: string; paths: number };

/** `merge = item["merge_commit"]`: Python's subscript message per container type. */
function subscript(item: unknown, key: string): unknown {
  if (Array.isArray(item)) {
    throw new PyError('TypeError', 'list indices must be integers or slices, not str');
  }
  if (typeof item === 'string') {
    throw new PyError('TypeError', "string indices must be integers, not 'str'");
  }
  return pyIndex(item, key);
}

/** `candidate in live`: a list or dict element is an unhashable dict-key probe. */
function probe(candidate: unknown): void {
  if (candidate instanceof JsonNumber) return;
  if (Array.isArray(candidate) || (typeof candidate === 'object' && candidate !== null)) {
    const name = pyTypeName(candidate);
    throw new PyError(
      'TypeError',
      `cannot use '${name}' as a dict key (unhashable type: '${name}')`,
    );
  }
}

/** `os.fsencode`-style argument check for the `git` argv: str only. */
function argvStr(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PyError(
      'TypeError',
      `expected str, bytes or os.PathLike object, not ${pyTypeName(value)}`,
    );
  }
  return value;
}

/** `build_synthetic(item, target)`. */
export async function buildSynthetic(
  deps: BuildSyntheticDeps,
  item: unknown,
  target: string,
): Promise<SyntheticSubject> {
  await deps.accounting.resolve(target);
  const merge = subscript(item, 'merge_commit');
  const measure = pyTruthy(pyGet(item, 'measure')) ? pyGet(item, 'measure') : {};
  const supplied = pyGet(measure, 'synthetic_paths');
  const candidates: unknown[] = pyTruthy(supplied)
    ? pyIter(supplied)
    : await synthPaths(deps.git, argvStr(merge), target);
  const live = await deps.accounting.entries(target);
  const paths: string[] = [];
  for (const candidate of candidates) {
    probe(candidate);
    if (typeof candidate === 'string' && live.has(candidate)) paths.push(candidate);
  }
  paths.sort(compareCodePoints);
  const projected = await deps.subjects.projection(target, paths);
  const identity = ledgerJsonDigest({
    item: pyIndex(item, 'id'),
    target,
    paths,
  } as PythonJsonInput);
  await deps.subjects.pin(
    identity,
    pyGetOr(item, 'generation', 0),
    0,
    projected.base,
    projected.head,
    target,
  );
  return { base: projected.base, head: projected.head, paths: paths.length };
}
