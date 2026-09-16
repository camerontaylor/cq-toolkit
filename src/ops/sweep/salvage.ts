// Sweep lane (WS-D, goal D2) — the salvage CLASSIFIER for interrupted sweep
// worktrees (UC §1 row 7; R2 D8): the caller scans the interrupted-trees
// inventory (discovery is the caller's business) and salvage classifies each
// entry into exactly one conservative class. The FACTORY is pure decision
// core over the injected {@link SalvageEffects} — the same
// factory-over-injected-effects idiom as worktreeFor; the module also ships
// the REAL effects binding ({@link makeSubprocessSalvageEffects}, the
// registry importer's input-driven binding); everything above the adapter is
// pure.
//
// Invariants honored here:
//   - R2 D8: a FAILED LIVENESS PROBE IS NOT DEATH — an effect fault (stat /
//     clean probe I/O) classifies the entry `indeterminate` with the fault
//     named, NEVER `discard`, never a silent skip, never a fabricated class.
//   - A dirty tree is `preserve`, period: salvage NEVER deletes and its seam
//     has NO mutating effects — `discard` exists only under the explicit
//     `discardDirty` flag, and even then it only MARKS discard-eligibility
//     (stash-first); deletion belongs to the cleanup op with --force.
//   - No throws across the op seam: every fault is a `failed` result or a
//     per-row classification — one entry's fault never fails the report.
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Op } from '../../kernel/types.js';
import { mapWorktreeGitFault } from './worktreeFor.js';

/**
 * One interrupted-tree inventory entry the CALLER scanned — plain JSON, as
 * `git worktree list --porcelain` and the run's journal reported it. Every
 * field beyond `path` is advisory metadata; classification reads the journal
 * shape and never trusts it beyond what a probe confirms.
 */
export interface SalvageEntry {
  /** The worktree checkout path (absolute, as the porcelain list reports it). */
  path: string;
  /** The branch checked out in the tree, when it is on one. */
  branch?: string;
  /** The reserved run prefix the tree belongs to, when the caller knows it. */
  runPrefix?: string;
  /** The run journal's tail, when the caller could read one. */
  journal?: SalvageJournal;
}

/** The journal tail of one interrupted run, as the caller scanned it. */
export interface SalvageJournal {
  /** The last journal step that reached a terminal outcome. */
  lastStep?: string;
  /** Total step count the plan declared, when known. */
  stepsTotal?: number;
  /** true when every job in the journal reached a terminal outcome. */
  allTerminal?: boolean;
}

/** JSON-serializable input of the `sweep.salvage` op. */
export interface SalvageInput {
  /** Repository the trees belong to (context; salvage itself runs no git mutation). */
  repoRoot: string;
  /** The interrupted-trees inventory — salvage CLASSIFIES, it does not discover. */
  entries: SalvageEntry[];
  /**
   * EXPLICIT discard intent: when true, DIRTY entries classify `discard`
   * (discard-ELIGIBLE, stash-first guidance in the reason) instead of
   * `preserve`. Even then salvage performs no deletion — the class only
   * marks eligibility; removal belongs to the cleanup op with --force.
   * Default (absent/false): dirty is `preserve`, period.
   */
  discardDirty?: boolean;
}

/**
 * The conservative classification of one entry (R2 D8). Exactly one of:
 *   - `reuse`         — exists, strictly clean, and the journal records
 *                       allTerminal true (the ONLY done evidence trusted):
 *                       a clean-done tree, safe to skip.
 *   - `resume`        — exists, strictly clean, and done-ness is NOT
 *                       proven: allTerminal EXPLICITLY false (with or
 *                       without a lastStep — an explicit non-terminal
 *                       marker is positive evidence of a pending step), a
 *                       lastStep present, or the journal tail ABSENT or
 *                       evidence-free (an interrupted-before-first-write
 *                       run carries no done evidence — re-running on a
 *                       clean tree is safe; concluding done-ness from no
 *                       evidence is not, I9).
 *   - `preserve`      — exists and DIRTY (default): never auto-cleaned.
 *   - `discard`       — exists and DIRTY and the input set `discardDirty`:
 *                       discard-ELIGIBLE only (stash-first); no deletion.
 *   - `absent`        — the path is not there: a report row, not an error.
 *   - `indeterminate` — a liveness probe FAILED: the entry is neither alive-
 *                       classified nor dead — never `discard`, never skipped.
 */
export type SalvageClass = 'reuse' | 'resume' | 'preserve' | 'discard' | 'absent' | 'indeterminate';

/** One classification row: the canonical path, the class, and why. */
export interface SalvageRow {
  /** The CANONICALIZED path (realpath; lexical fallback) — matches what the porcelain list reports. */
  path: string;
  /** The entry's branch, verbatim when the caller supplied one. */
  branch?: string;
  class: SalvageClass;
  reason: string;
}

/** The salvage plan: one row per entry plus honest per-class counts (zeros included). */
export interface SalvagePlan {
  rows: SalvageRow[];
  counts: Record<SalvageClass, number>;
}

/**
 * The injected-effects seam — the ONE place this module touches the world.
 * Deliberately READ-ONLY: there is NO remove/unlink/stash effect — salvage
 * classifies, it never deletes (pinned by test in salvage.test.ts).
 * `canonicalize` is the worktreeFor realpath idiom as an effect: realpath
 * with a lexical fallback, so an absent path canonicalizes to itself and the
 * seam cannot reject. `pathExists` follows the worktreeFor contract: false
 * ONLY for the absence class; any other fault THROWS — salvage maps the
 * throw to `indeterminate` (R2 D8: a failed liveness probe is not death).
 */
export interface SalvageEffects {
  pathExists(p: string): Promise<boolean>;
  /** STRICT clean: `git status --porcelain` EMPTY semantics — untracked files count as dirty. */
  isStrictClean(p: string): Promise<boolean>;
  canonicalize(p: string): Promise<string>;
}

/**
 * Control characters (the Unicode Cc category: C0, DEL, C1) —
 * newline/carriage-return above all: the porcelain lists these values are
 * compared against are LINE-oriented (the worktreeFor jCoNL treatment).
 */
const CONTROL_CHARS_RE = /[\p{Cc}]/u;

/**
 * A safe single path segment (the worktreeFor SEGMENT_RE): starts with a
 * letter/digit, then letters, digits, dots, dashes, underscores — no
 * separators, no leading dash (a run prefix must never be mistakable for a
 * git flag).
 */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A '..' run walks refs and a '.lock' suffix collides with the loose-ref lock file. */
function refnameUnsafeSegment(segment: string): boolean {
  return segment.includes('..') || segment.endsWith('.lock');
}

/**
 * Build the `sweep.salvage` op over injected effects. Per entry, in order:
 * canonicalize the path, probe liveness (`pathExists`), probe strict
 * cleanliness, then classify from the journal tail — see
 * {@link SalvageClass} for the exact table. A thrown probe fault yields an
 * `indeterminate` row naming the fault (R2 D8); every other input defect is
 * a single `failed` result naming the field. One entry's fault never fails
 * the whole report: the rows stay per-entry isolated, and the counts always
 * sum to the row count.
 */
export function makeSalvage(git: SalvageEffects): Op<SalvageInput, SalvagePlan> {
  return async (input) => {
    const fault = inputFaultOf(input);
    if (fault !== null) return { status: 'failed', error: fault };

    const rows: SalvageRow[] = [];
    for (const entry of input.entries) {
      // canonicalize is the realpath-with-lexical-fallback idiom and never
      // rejects BY CONTRACT; a rejecting canonicalize is a seam violation —
      // still classified indeterminate rather than failing the report, the
      // same liveness-not-death disposition as every other probe fault.
      let real: string;
      try {
        real = await git.canonicalize(entry.path);
      } catch (err) {
        rows.push(rowOf(entry, entry.path, 'indeterminate', faultReason('canonicalize', err)));
        continue;
      }
      let exists: boolean;
      try {
        exists = await git.pathExists(real);
      } catch (err) {
        // A FAILED LIVENESS PROBE IS NOT DEATH (R2 D8): the tree is neither
        // certified present nor read as absent — `indeterminate`, fault named.
        rows.push(rowOf(entry, real, 'indeterminate', faultReason('pathExists (liveness)', err)));
        continue;
      }
      if (!exists) {
        rows.push(
          rowOf(entry, real, 'absent', 'the path is not there — a report row, not an error'),
        );
        continue;
      }
      let clean: boolean;
      try {
        clean = await git.isStrictClean(real);
      } catch (err) {
        rows.push(
          rowOf(entry, real, 'indeterminate', faultReason('isStrictClean (clean probe)', err)),
        );
        continue;
      }
      if (clean) {
        const allTerminal = entry.journal?.allTerminal;
        const lastStep = entry.journal?.lastStep;
        if (allTerminal === true) {
          rows.push(
            rowOf(
              entry,
              real,
              'reuse',
              'strictly clean and the journal records all steps terminal — clean-done, safe to skip',
            ),
          );
        } else if (allTerminal === false) {
          // An EXPLICIT non-terminal marker is positive evidence of a
          // pending step — resume even when no lastStep is recorded, and
          // the reason names the lastStep only when one exists.
          const total = entry.journal?.stepsTotal;
          const ofTotal = total === undefined ? '' : ` of ${String(total)}`;
          const step =
            lastStep === undefined ? '' : ` — last terminal step '${lastStep}'${ofTotal}`;
          rows.push(
            rowOf(
              entry,
              real,
              'resume',
              `strictly clean with PARTIAL journal progress — the journal explicitly records steps NOT all terminal${step}`,
            ),
          );
        } else if (lastStep !== undefined) {
          const total = entry.journal?.stepsTotal;
          const ofTotal = total === undefined ? '' : ` of ${String(total)}`;
          rows.push(
            rowOf(
              entry,
              real,
              'resume',
              `strictly clean with PARTIAL journal progress — last terminal step '${lastStep}'${ofTotal}, allTerminal not recorded`,
            ),
          );
        } else {
          // NO positive evidence either way — the journal tail is ABSENT
          // (the run may have been interrupted before its first journal
          // write: zero steps ran) or records nothing at all. Conservative
          // per I9's no-fabrication rule: resume, naming the absent
          // evidence — re-running on a strictly clean tree is safe, and
          // concluding done-ness from NO evidence is not.
          rows.push(
            rowOf(
              entry,
              real,
              'resume',
              entry.journal === undefined
                ? 'strictly clean but the journal tail is ABSENT — the run may have been interrupted before its first journal write; re-running on a clean tree is safe, and concluding done-ness from no evidence is not (I9)'
                : 'strictly clean but the journal tail records neither a terminal marker nor a pending step — no positive evidence of done-ness; re-running on a clean tree is safe (I9)',
            ),
          );
        }
      } else if (input.discardDirty === true) {
        rows.push(
          rowOf(
            entry,
            real,
            'discard',
            'dirty tree marked discard-ELIGIBLE by the explicit discardDirty flag — stash uncommitted work before any removal; salvage itself performs no deletion',
          ),
        );
      } else {
        rows.push(
          rowOf(
            entry,
            real,
            'preserve',
            'dirty trees are never auto-classified for removal — explicit --force cleanup is the only removal path',
          ),
        );
      }
    }

    const counts = Object.fromEntries(
      (['reuse', 'resume', 'preserve', 'discard', 'absent', 'indeterminate'] as const).map(
        (cls) => [cls, 0],
      ),
    ) as Record<SalvageClass, number>;
    for (const row of rows) counts[row.class] += 1;
    return { status: 'ok', value: { rows, counts } };
  };
}

/** One row, carrying the entry's branch only when the caller supplied one (exactOptionalPropertyTypes). */
function rowOf(entry: SalvageEntry, path: string, klass: SalvageClass, reason: string): SalvageRow {
  return entry.branch === undefined
    ? { path, class: klass, reason }
    : { path, branch: entry.branch, class: klass, reason };
}

/** The `indeterminate` row's reason: what was being probed and what it threw. */
function faultReason(probe: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `the ${probe} probe FAILED — a failed liveness probe is not death (R2 D8): neither alive-classified nor read as absent — ${message}`;
}

/**
 * Library-level input contract (the worktreeFor boundary idiom): everything
 * checkable without an injected effect, each violation a `failed` message
 * naming the field. The registry schema mirrors these bounds for JSON
 * dispatch; the op-level check keeps the library contract loud without any
 * schema. Shape guards over typed fields: these values are reachable from an
 * untyped caller past any schema — a malformed input is a `failed` result,
 * never an escaping TypeError.
 */
function inputFaultOf(input: SalvageInput): string | null {
  // The WHOLE input is reachable null/undefined/primitive from an untyped
  // caller past any schema — guard the top level BEFORE the first field
  // read, or this boundary itself would throw the TypeError it exists to
  // prevent.
  if (input === null || typeof input !== 'object') {
    return 'sweep: input must be an object with a non-empty repoRoot and an entries array';
  }
  if (typeof input.repoRoot !== 'string' || input.repoRoot === '') {
    return 'sweep: repoRoot must be a non-empty string';
  }
  if (CONTROL_CHARS_RE.test(input.repoRoot)) {
    return 'sweep: repoRoot must not contain control characters (newline/carriage return) — the porcelain lists it anchors are line-oriented';
  }
  if (!Array.isArray(input.entries)) {
    return 'sweep: entries must be an array of interrupted-tree inventory entries';
  }
  for (const [index, entry] of input.entries.entries()) {
    // A null/garbage ELEMENT is reachable from an untyped caller too — the
    // fault names the index so the inventory defect is locatable.
    if (entry === null || typeof entry !== 'object') {
      return `sweep: entries[${String(index)}] must be an inventory entry with a non-empty path`;
    }
    if (typeof entry.path !== 'string' || entry.path === '') {
      return `sweep: entries[${String(index)}] must have a non-empty path`;
    }
    // The path feeds git-facing comparisons and is the cleanup op's removal
    // target: control characters corrupt line-oriented porcelain framing, a
    // backslash cannot be safely interpreted (posix literal vs win32
    // separator — the worktreeFor cache-path disposition), and a
    // dash-leading value would be parsed as an OPTION wherever it lands as
    // a positional git argument.
    if (CONTROL_CHARS_RE.test(entry.path)) {
      return `sweep: entries[${String(index)}] path must not contain control characters (newline/carriage return) — the porcelain lists it is compared against are line-oriented`;
    }
    if (entry.path.includes('\\')) {
      return `sweep: entries[${String(index)}] path '${entry.path}' must not contain a backslash — portable paths use posix separators; a backslash cannot be safely interpreted as a separator on posix or as a literal on win32`;
    }
    if (entry.path.startsWith('-')) {
      return `sweep: entries[${String(index)}] path '${entry.path}' must not start with '-' — it is a positional git argument wherever it feeds git, never a flag`;
    }
    // The field doc promises an ABSOLUTE worktree path (as the porcelain
    // list reports it): a RELATIVE path would canonicalize against the
    // process CWD and classify — and report — a tree the caller never
    // meant.
    if (!isAbsolute(entry.path)) {
      return `sweep: entries[${String(index)}] path '${entry.path}' must be an ABSOLUTE path — a relative path canonicalizes against the process CWD and would classify the wrong tree`;
    }
    if (entry.branch !== undefined) {
      if (typeof entry.branch !== 'string' || entry.branch === '') {
        return `sweep: entries[${String(index)}] branch must be a non-empty string when present`;
      }
      if (CONTROL_CHARS_RE.test(entry.branch) || entry.branch.includes('\\')) {
        return `sweep: entries[${String(index)}] branch must not contain control characters or backslashes — it is compared against git-reported refnames`;
      }
    }
    if (entry.runPrefix !== undefined) {
      if (typeof entry.runPrefix !== 'string' || entry.runPrefix === '') {
        return `sweep: entries[${String(index)}] runPrefix must be a non-empty string when present`;
      }
      for (const segment of entry.runPrefix.split('/')) {
        if (!SEGMENT_RE.test(segment) || refnameUnsafeSegment(segment)) {
          return `sweep: entries[${String(index)}] runPrefix '${entry.runPrefix}' must be '/'-joined safe segments (${SEGMENT_RE.source}) — the same reserved-prefix scheme worktreeFor enforces`;
        }
      }
    }
    if (entry.journal !== undefined) {
      if (entry.journal === null || typeof entry.journal !== 'object') {
        return `sweep: entries[${String(index)}] journal must be an object when present`;
      }
      const { journal } = entry;
      if (
        journal.lastStep !== undefined &&
        (typeof journal.lastStep !== 'string' || journal.lastStep === '')
      ) {
        return `sweep: entries[${String(index)}] journal.lastStep must be a non-empty string when present`;
      }
      if (
        journal.stepsTotal !== undefined &&
        (!Number.isInteger(journal.stepsTotal) || journal.stepsTotal < 0)
      ) {
        return `sweep: entries[${String(index)}] journal.stepsTotal (${String(journal.stepsTotal)}) must be an integer ≥ 0 when present`;
      }
      if (journal.allTerminal !== undefined && typeof journal.allTerminal !== 'boolean') {
        return `sweep: entries[${String(index)}] journal.allTerminal must be a boolean when present`;
      }
    }
  }
  if (input.discardDirty !== undefined && typeof input.discardDirty !== 'boolean') {
    return 'sweep: discardDirty must be a boolean when present';
  }
  return null;
}

/**
 * The ABSENCE class of node:fs faults — ENOENT and ENOTDIR (a path walking
 * through a file) both mean "nothing there". ANY OTHER stat fault
 * (EACCES-class) THROWS: the salvage op maps the throw to `indeterminate` —
 * reading a stat failure as "absent" would be the exact death-by-fault R2 D8
 * forbids.
 */
function isAbsence(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    ((err as { code?: unknown }).code === 'ENOENT' ||
      (err as { code?: unknown }).code === 'ENOTDIR')
  );
}

/**
 * CANONICALIZED path comparison support (the worktreeFor realpathOf idiom,
 * re-declared here so worktreeFor.ts stays untouched): porcelain reports
 * REALPATH'd paths (macOS /tmp → /private/tmp), so classifications and
 * reports name the canonical form; an ABSENT target falls back to the
 * lexical path.
 */
async function realpathOf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/**
 * Auto-maintenance suppression, copied VERBATIM from the worktreeFor
 * sibling's runGit (its GIT_NO_AUTO_MAINTENANCE const and prepend — the
 * proven treatment for the detached background `gc --auto` /
 * `maintenance run --auto` hang class that inherits our stdio pipes).
 */
const GIT_NO_AUTO_MAINTENANCE = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];

/** Generous capture ceiling; the salvage probes produce negligible output. */
const SALVAGE_GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** The default wall-clock cap for one git subprocess (the family's 600_000ms default). */
const SALVAGE_GIT_TIMEOUT_MS = 600_000;

/**
 * Run git with an execFile ARGS ARRAY — never a shell string (the repo's
 * tooling convention). A non-zero exit, a spawn failure, or a run exceeding
 * {@link timeoutMs} (SIGKILL) rejects with the captured stderr text.
 */
function runSalvageGit(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_NO_AUTO_MAINTENANCE, ...args],
      {
        cwd,
        maxBuffer: SALVAGE_GIT_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          // The SHARED family fault mapping (worktreeFor's): distinguishes
          // the maxBuffer-overflow class (which also sets `killed`) from a
          // timeout SIGKILL, and names the mechanism — a weakened local
          // branch would misreport an output limit as a timeout.
          reject(mapWorktreeGitFault(args, error, stderr, timeoutMs));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Per-call timeout options of {@link makeSubprocessSalvageEffects}; absent
 * fields fall back to the shipped default (10 minutes, the family default).
 */
export interface SubprocessSalvageEffectsOptions {
  timeoutMs?: number;
}

/**
 * The REAL effects binding of the salvage op (the registry importer's
 * input-driven binding; constructed fresh per dispatch): liveness is a stat
 * with the absence-class contract, strict-clean is `git status --porcelain`
 * EMPTY run against the TREE (its cwd, so it reads that worktree's status),
 * and canonicalize is the realpath-with-lexical-fallback idiom. Every effect
 * is a fresh lazy call — no git state is cached between calls — and the one
 * git call (the strict-clean probe) is bounded by
 * {@link SubprocessSalvageEffectsOptions.timeoutMs} (the shipped
 * {@link SALVAGE_GIT_TIMEOUT_MS} default when absent): a hung git is
 * SIGKILLed and reported, never awaited forever. A library consumer injects
 * fakes instead (every classification test does exactly that).
 */
export function makeSubprocessSalvageEffects(
  timeouts?: SubprocessSalvageEffectsOptions,
): SalvageEffects {
  const timeoutMs = timeouts?.timeoutMs ?? SALVAGE_GIT_TIMEOUT_MS;
  return {
    pathExists: async (p) => {
      try {
        await stat(p);
        return true;
      } catch (err) {
        // FALSE only for the absence class (ENOENT / ENOTDIR): any other
        // stat fault THROWS — the op maps the throw to `indeterminate`
        // (R2 D8: a failed liveness probe is never read as absence).
        if (isAbsence(err)) return false;
        throw err;
      }
    },
    isStrictClean: async (treePath) =>
      (await runSalvageGit(['status', '--porcelain'], treePath, timeoutMs)).trim() === '',
    canonicalize: realpathOf,
  };
}
