/**
 * `crq.measure_merged` with `pr_commit_set`, `rename_map`, `path_exists`,
 * `is_doc` and `synth_paths` (apps/crq-python/crq.py:1008-1083): blame-based
 * survival of a merged PR's added lines at a target commit, plus the per-file
 * synthetic delta that decides which paths join a coverage review.
 *
 * The git/clone seam is injected ({@link MeasureGit}); the call order is the
 * Python order, which the differential test pins. Inactive: nothing routes it.
 *
 * Python semantics kept: `str.split("\t", 2)` unpack (ValueError on too few
 * fields), `int()` of the numstat count (ValueError), `splitlines()` line
 * boundaries, a strict `^[0-9a-f]{40} \d+ \d+` blame header with Unicode `\d`,
 * half-even `round(x, 3)`, and an IndexError for a name-status row with no tab.
 */
import {
  PyError,
  compareCodePoints,
  pyIndex,
  pyIntFromString,
  pyRound3,
  pySplitWhitespace,
  pySplitlines,
  pyStr,
} from '../policy/crq/pyCompat.js';

/** The clone and git runner the measurement reads through. */
export interface MeasureGit {
  /** `crq.git(*args, check=check)`: stdout, throwing a RuntimeError-class error on failure when `check`. */
  git(args: readonly string[], check?: boolean): Promise<string>;
  /** `path_exists(rev, path)`: `git cat-file -e rev:path` succeeded. */
  pathExists(rev: string, path: string): Promise<boolean>;
}

export interface MeasureMergedConfig {
  /** `DEFAULT_REF`, the ref `rev-parse` resolves when no target is given. */
  readonly defaultRef: string;
  /** `CONFIG.get("merged_min_file_focus", 0.25)`. */
  readonly minFileFocus: number;
  /** `crq.iso()`. */
  iso(): string;
}

export type MeasuredFile = {
  path: string;
  now: string | null;
  added: number;
  surviving: number;
  synthetic_added: number;
};

export type MergedMeasure = {
  measured_at: string;
  merge_queue: string;
  pr_commits: number;
  added: number;
  surviving: number;
  surviving_nondoc: number;
  survival: number | null;
  synthetic_paths: string[];
  excluded_paths: string[];
  synthetic_added: number;
  covered_surviving: number;
  focus: number | null;
  file_level_focus: number;
  docs_only: boolean;
  files: MeasuredFile[];
};

const BLAME_HEADER = /^([0-9a-f]{40}) \p{Nd}+ \p{Nd}+/u;

/** `line.split("\t", maxsplit)`: at most maxsplit+1 fields, the tail kept whole. */
function splitTab(line: string, maxsplit?: number): string[] {
  const parts = line.split('\t');
  if (maxsplit === undefined || parts.length <= maxsplit + 1) return parts;
  return [...parts.slice(0, maxsplit), parts.slice(maxsplit).join('\t')];
}

/** `a, b, c = line.split("\t", 2)`. */
function unpackThree(line: string): [string, string, string] {
  const parts = splitTab(line, 2);
  if (parts.length < 3) {
    throw new PyError(
      'ValueError',
      `not enough values to unpack (expected 3, got ${parts.length})`,
    );
  }
  return [parts[0] as string, parts[1] as string, parts[2] as string];
}

/** `is_doc`. */
export function isDoc(path: string): boolean {
  return (
    path.endsWith('.md') ||
    path.endsWith('.mdx') ||
    path.endsWith('.txt') ||
    path.startsWith('docs/')
  );
}

/** `pr_commit_set(merge)`. */
async function prCommitSet(io: MeasureGit, merge: string): Promise<Set<string>> {
  const listed = await io.git(['rev-list', `${merge}^1..${merge}^2`]);
  const set = new Set(pySplitWhitespace(listed));
  set.add(await io.git(['rev-parse', merge]));
  return set;
}

/** `rename_map(a, b)`. */
async function renameMap(io: MeasureGit, a: string, b: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const text = await io.git(['diff', '-M50%', '--name-status', '--diff-filter=R', a, b]);
  for (const line of pySplitlines(text)) {
    const parts = splitTab(line);
    if (parts.length === 3) out.set(parts[1] as string, parts[2] as string);
  }
  return out;
}

/** `synth_paths(merge, mq)`. */
async function synthPaths(io: MeasureGit, merge: string, mq: string): Promise<string[]> {
  const names = new Set<string>();
  const text = await io.git(['diff', '--name-status', '--no-renames', `${merge}^1`, merge]);
  for (const line of pySplitlines(text)) {
    const parts = splitTab(line, 1);
    if (parts.length < 2) throw new PyError('IndexError', 'list index out of range');
    names.add(parts[1] as string);
  }
  const renames = await renameMap(io, merge, mq);
  for (const p of [...names]) {
    const renamed = renames.get(p);
    if (renamed !== undefined) names.add(renamed);
  }
  return [...names].sort(compareCodePoints);
}

/** `crq.measure_merged(item, target)`. */
export async function measureMerged(
  io: MeasureGit,
  config: MeasureMergedConfig,
  item: unknown,
  target: string | null,
): Promise<MergedMeasure> {
  const merge = pyStr(pyIndex(item, 'merge_commit'));
  const mq = target !== null ? target : await io.git(['rev-parse', config.defaultRef]);
  const commits = await prCommitSet(io, merge);
  const renames = await renameMap(io, merge, mq);
  const files: MeasuredFile[] = [];
  let totAdd = 0;
  let totSurv = 0;
  let nondocSurv = 0;
  const numstat = await io.git(['diff', '--numstat', '--no-renames', `${merge}^1`, merge]);
  for (const line of pySplitlines(numstat)) {
    const [a, , path] = unpackThree(line);
    if (a === '-') continue;
    const added = pyIntFromString(a);
    if (added === 0) continue;
    const cur = (await io.pathExists(mq, path)) ? path : (renames.get(path) ?? null);
    let surv = 0;
    if (cur) {
      const blame = await io.git(['blame', '-w', '-M', '--line-porcelain', mq, '--', cur], false);
      for (const bl of pySplitlines(blame)) {
        const m = BLAME_HEADER.exec(bl);
        if (m && commits.has(m[1] as string)) surv += 1;
      }
    }
    surv = Math.min(surv, added);
    totAdd += added;
    totSurv += surv;
    if (!isDoc(path)) nondocSurv += surv;
    files.push({ path, now: cur, added, surviving: surv, synthetic_added: 0 });
  }
  const allPaths = await synthPaths(io, merge, mq);
  const synByPath = new Map<string, number>();
  if (allPaths.length > 0) {
    const diff = await io.git([
      'diff',
      '--numstat',
      '--no-renames',
      `${merge}^1`,
      mq,
      '--',
      ...allPaths,
    ]);
    for (const x of pySplitlines(diff)) {
      const [a2, , p2] = unpackThree(x);
      synByPath.set(p2, a2 === '-' ? 0 : pyIntFromString(a2));
    }
  }
  const include = new Set<string>();
  const excluded: string[] = [];
  for (const f of files) {
    const cur = f.now;
    const syn = synByPath.get(cur ?? '') ?? 0;
    f.synthetic_added = syn;
    if (cur && syn && f.surviving / syn >= config.minFileFocus) {
      include.add(f.path);
      include.add(cur);
    } else if (cur) {
      excluded.push(`${cur} (${f.surviving}/${syn})`);
    }
  }
  const synAdd = files
    .filter((f) => include.has(f.path))
    .reduce((sum, f) => sum + (synByPath.get(f.now ?? '') ?? 0), 0);
  const incSurv = files.filter((f) => include.has(f.path)).reduce((sum, f) => sum + f.surviving, 0);
  const synTotal = [...synByPath.values()].reduce((sum, n) => sum + n, 0);
  return {
    measured_at: config.iso(),
    merge_queue: mq,
    pr_commits: commits.size,
    added: totAdd,
    surviving: totSurv,
    surviving_nondoc: nondocSurv,
    survival: totAdd ? pyRound3(totSurv / totAdd) : null,
    synthetic_paths: [...include].sort(compareCodePoints),
    excluded_paths: excluded,
    synthetic_added: synAdd,
    covered_surviving: incSurv,
    focus: synAdd ? pyRound3(incSurv / synAdd) : null,
    file_level_focus: pyRound3(totSurv / Math.max(1, synTotal)),
    docs_only: nondocSurv === 0 && files.every((f) => isDoc(f.path)),
    files,
  };
}
