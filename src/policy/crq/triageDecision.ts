/**
 * Offline port of the triage verdict arbiter: `crq_repair/triage.py`
 * `decision(repo, row, tip, report)` (lines 102-151).
 *
 * `decision` turns one judge report into the `(status, reason, extras)` tuple
 * the triage phase records. It is a pure function over injected Git facts:
 * every read goes through {@link TriageDecisionRepo}, in the order Python makes
 * it, and nothing here routes, writes or delivers anything.
 *
 * Failure honesty (`triagePlan.ts` precedent):
 *
 * - Python catches a fixed set of exception classes per verdict branch and
 *   turns them into a `needs-human` / `confirmed` evidence outcome. The repo
 *   seam throws {@link TriageGitFailure} carrying the Python class name; this
 *   module catches exactly the classes Python catches (including their
 *   subclasses, e.g. `UnicodeDecodeError` is a `ValueError`) and lets every
 *   other failure propagate, as Python does.
 * - Python raises uncaught `KeyError`/`AttributeError` when the report is not
 *   an object, or when a row lacks `target`, `finding` or `finding.path` on
 *   the fixed/superseded path. Each is a {@link TriageDecisionRefusal};
 *   nothing is decided.
 *
 * Residuals (documented; none changes a verdict for a ledger-valid row):
 *
 * 1. `row.finding.path` must be a string when it is read; Python is lenient
 *    about other types the ledger schema never produces and this port refuses
 *    instead. (A non-object `row` or `finding` matches Python's `TypeError`.)
 * 2. Git output is decoded with a fatal UTF-8 decoder that keeps a leading
 *    byte-order mark, matching Python's strict `bytes.decode()`.
 */
import { LedgerIntegrityError, ledgerIntervals } from './ledger.js';
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import { pythonStrip, pythonTruthy } from './repairBinding.js';
import { pythonSplitlines } from './repairGates.js';

/** Python would raise an uncaught `KeyError`/`AttributeError`. */
export class TriageDecisionRefusal extends Error {
  override readonly name = 'TriageDecisionRefusal';
}

/**
 * A Python exception from a Git read (`repo.resolve`, `repo.git`,
 * `repo.entries`, `repo.lineage`). `pythonType` is the exception class name.
 */
export class TriageGitFailure extends Error {
  override readonly name = 'TriageGitFailure';
  readonly pythonType: string;

  constructor(pythonType: string, message = pythonType) {
    super(message);
    this.pythonType = pythonType;
  }
}

/** The Git facts `decision` reads. Synchronous by contract, like `TriageRepo`. */
export interface TriageDecisionRepo {
  /**
   * `repo.resolve(value)`: a full immutable commit id. Receives the raw
   * report value, so a non-string throws `TypeError` and a non-hex or short
   * value throws `IntegrityError`.
   */
  resolve(value: JsonValue | undefined): string;
  /** `repo.git(...args)`: the raw stdout bytes. */
  git(...args: string[]): Uint8Array;
  /** `repo.lineage(target, tip, path)`: the mapped path, or null. */
  lineage(target: string, tip: string, path: string): string | null;
  /** `repo.entries(tip)[path]['blob']`; throws `KeyError`/`TypeError` as Python. */
  entryBlob(tip: string, path: JsonValue): string;
}

/** `(status, reason, extras)`. Extras keep Python's key order and `None` as null. */
export interface TriageDecision {
  readonly status: string;
  readonly reason: string;
  readonly extras: JsonObject;
}

const VALUE_ERRORS = ['ValueError', 'UnicodeError', 'UnicodeDecodeError', 'UnicodeEncodeError'];
const FIX_CAUGHT = ['TypeError', 'IntegrityError', 'CalledProcessError', ...VALUE_ERRORS] as const;
const VALID_CAUGHT = ['KeyError', 'TypeError', 'IntegrityError', ...VALUE_ERRORS] as const;

function caughtBy(error: unknown, classes: readonly string[]): boolean {
  if (error instanceof TriageGitFailure) return classes.includes(error.pythonType);
  // `ledger.IntegrityError` (and its KeyError/TypeError subclasses) from `ledger.intervals`.
  if (error instanceof LedgerIntegrityError) return true;
  return false;
}

function refuse(message: string): never {
  throw new TriageDecisionRefusal(message);
}

const extras = (entries: ReadonlyArray<readonly [string, JsonValue]>): JsonObject =>
  new JsonObject(entries);

const FIX_FAILED = extras([['failure_class', 'evidence']]);
const EXHAUSTED = extras([['failure_class', 'exhausted']]);

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Python `bytes.decode()`; a malformed sequence is a `UnicodeDecodeError`. */
function decodeStrict(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new TriageGitFailure('UnicodeDecodeError', 'invalid utf-8');
  }
}

/**
 * Python `row['key']`: a missing key is an uncaught `KeyError`; subscripting a
 * non-dict (list, string, number, null) is a `TypeError`.
 */
function rowField(row: JsonValue, key: string): JsonValue {
  if (!(row instanceof JsonObject)) {
    throw new TriageGitFailure('TypeError', 'row is not subscriptable by str');
  }
  const value = row.get(key);
  if (value === undefined) refuse(`row has no ${key} (KeyError)`);
  return value;
}

/** `row['target'] + '..' + tip`: a non-string target is a caught `TypeError`. */
function rangeOf(row: JsonValue, tip: string): string {
  const target = rowField(row, 'target');
  if (typeof target !== 'string') throw new TriageGitFailure('TypeError', 'target is not a string');
  return `${target}..${tip}`;
}

/** `row['finding']['path']`: a non-object finding is a caught `TypeError`. */
function findingPath(row: JsonValue): string {
  const finding = rowField(row, 'finding');
  if (!(finding instanceof JsonObject)) {
    throw new TriageGitFailure('TypeError', 'finding is not subscriptable by str');
  }
  const path = finding.get('path');
  if (path === undefined) refuse('finding has no path (KeyError)');
  if (typeof path !== 'string') refuse('finding path is not a string');
  return path;
}

function verifyFixingCommit(
  repo: TriageDecisionRepo,
  row: JsonValue,
  tip: string,
  report: JsonObject,
  verdict: 'fixed' | 'superseded',
): string {
  const commit = repo.resolve(report.get('fixing_commit'));
  const reachable = pythonSplitlines(decodeStrict(repo.git('rev-list', rangeOf(row, tip))));
  if (!reachable.includes(commit)) throw new TriageGitFailure('ValueError', 'commit not ancestor');
  const target = rowField(row, 'target') as string;
  const path = findingPath(row);
  const fixingPath = repo.lineage(target, commit, path) || path;
  if (verdict === 'fixed') {
    const touched = pythonSplitlines(
      decodeStrict(
        repo.git(
          'diff-tree',
          '--root',
          '--no-commit-id',
          '--name-only',
          '--first-parent',
          '-m',
          '-r',
          commit,
        ),
      ),
    );
    if (!touched.includes(fixingPath)) {
      throw new TriageGitFailure('ValueError', 'fix does not touch path');
    }
  }
  return commit;
}

/** `ledger.intervals(value)` where every failure Python raises is caught: null on failure. */
function selectedLines(value: JsonValue): Set<number> | null {
  // Python iterates any iterable: an empty string/object yields no pairs.
  if (value === '' || (value instanceof JsonObject && value.entries.length === 0)) {
    return new Set();
  }
  try {
    return ledgerIntervals(value);
  } catch (error) {
    if (error instanceof LedgerIntegrityError) return null;
    throw error;
  }
}

interface Anchor {
  readonly lines: JsonValue;
}

/** The verified `valid` anchor; throws a caught failure when Python's try body raises. */
function verifyAnchor(repo: TriageDecisionRepo, tip: string, report: JsonObject): Anchor {
  const path = report.get('current_path');
  if (path === undefined) throw new TriageGitFailure('KeyError', 'current_path');
  const currentLines = report.get('current_lines');
  if (currentLines === undefined) throw new TriageGitFailure('KeyError', 'current_lines');
  const selected = selectedLines(currentLines);
  if (selected === null) throw new TriageGitFailure('IntegrityError', 'invalid intervals');
  const blob = repo.entryBlob(tip, path);
  const text = pythonSplitlines(decodeStrict(repo.git('cat-file', 'blob', blob)));
  const quote = report.get('quoted_text');
  if (typeof quote !== 'string' || pythonStrip(quote) === '') {
    throw new TriageGitFailure('ValueError', 'quote missing');
  }
  const ordered = [...selected].sort((a, b) => a - b);
  const exact =
    ordered.length > 0 &&
    (ordered[0] as number) >= 1 &&
    (ordered[ordered.length - 1] as number) <= text.length &&
    ordered.map((line) => text[line - 1]).join('\n') === quote;
  if (exact) return { lines: currentLines };
  // Recover line-number drift only from an exact, unique whole-line match.
  const quoted = quote.split('\n');
  const matches: number[] = [];
  for (let index = 0; index <= text.length - quoted.length; index += 1) {
    if (quoted.every((line, offset) => text[index + offset] === line)) matches.push(index);
  }
  if (matches.length !== 1) throw new TriageGitFailure('ValueError', 'quote mismatch');
  const start = (matches[0] as number) + 1;
  return { lines: [[JsonNumber.int(start), JsonNumber.int(start + quoted.length - 1)]] };
}

/**
 * `triage.decision`: the status, reason and extras for one judge report.
 * Throws {@link TriageDecisionRefusal} where Python raises uncaught.
 */
export function triageDecision(
  repo: TriageDecisionRepo,
  row: JsonValue,
  tip: string,
  report: JsonValue,
): TriageDecision {
  if (!(report instanceof JsonObject)) refuse('judge report is not an object (AttributeError)');
  const reason = report.get('reason');
  if (typeof reason !== 'string' || pythonStrip(reason) === '') {
    return { status: 'needs-human', reason: 'judge supplied no reason', extras: EXHAUSTED };
  }
  const verdict = report.get('verdict');
  const investigate = (): TriageDecision => ({
    status: 'confirmed',
    reason: `fixer investigation: ${reason}`,
    extras: FIX_FAILED,
  });
  if (pythonTruthy(report.get('context_scan_refused'))) return investigate();
  // No typed owner-decision field exists; the fixer investigates and decides.
  if (verdict === 'unsure') return investigate();
  if (verdict === 'fixed' || verdict === 'superseded') {
    let commit: string;
    try {
      commit = verifyFixingCommit(repo, row, tip, report, verdict);
    } catch (error) {
      if (caughtBy(error, FIX_CAUGHT)) {
        return {
          status: 'needs-human',
          reason: `unverified fixing/superseding commit: ${reason}`,
          extras: FIX_FAILED,
        };
      }
      throw error;
    }
    return {
      status: verdict === 'fixed' ? 'already-fixed' : 'superseded',
      reason,
      extras: extras([['fixing_commit', commit]]),
    };
  }
  if (verdict === 'valid') {
    let anchor: Anchor;
    try {
      anchor = verifyAnchor(repo, tip, report);
    } catch (error) {
      if (caughtBy(error, VALID_CAUGHT)) {
        return {
          status: 'confirmed',
          reason: `fixer investigation: judge current anchor failed verification: ${reason}`,
          extras: FIX_FAILED,
        };
      }
      throw error;
    }
    return {
      status: 'confirmed',
      reason,
      extras: extras([
        ['current_path', report.get('current_path') ?? null],
        ['current_lines', anchor.lines],
        ['quoted_text', report.get('quoted_text') ?? null],
      ]),
    };
  }
  if (verdict === 'duplicate-of') {
    return {
      status: 'duplicate',
      reason,
      extras: extras([['canonical_id', report.get('canonical_of') ?? null]]),
    };
  }
  return { status: verdict === 'invalid' ? 'dismissed' : 'needs-human', reason, extras: EXHAUSTED };
}
