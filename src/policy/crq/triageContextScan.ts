/**
 * Offline port of the triage-context secret scan: `crq_repair.py`
 * `triage_context_safe` / `triage_context_scan` (lines 868-892) and
 * `crq_repair/triage.py` `error_reason` / `ContextScanError` (lines 17-28).
 *
 * The triage judge's context is scanned BEFORE serialization or any model
 * upload. Python flattens every string value of the context into one text,
 * wraps it in a synthetic one-hunk diff attributed to the current path and
 * asks the shared secret scanner (`crq.secret_scan_diff`) for a verdict. This
 * module ports the pure half exactly: the flatten, the path choice and the
 * patch bytes ({@link triageContextScanPatch}); and the injected-effect half:
 * the scanner seam and the typed refusal on a scan-policy failure
 * ({@link triageContextScan}).
 *
 * Failure honesty (`triagePlan.ts` precedent):
 *
 * - Python raises uncaught `KeyError`/`TypeError`/`AttributeError` when the
 *   context is not an object, when it has no usable path (a falsy
 *   `current_path` and a missing or non-object `finding`), or when the chosen
 *   path is truthy but not a string (the `'diff --git a/' + path`
 *   concatenation). Each is a {@link TriageContextScanRefusal}; nothing is
 *   scanned and nothing is clean.
 * - Python catches only `OSError`/`RuntimeError` from the scanner and
 *   re-raises them as `ContextScanError`; any other exception propagates. The
 *   seam mirrors that: only a {@link TriageScanPolicyFailure} becomes a
 *   {@link ContextScanError}; every other throw propagates untouched.
 *
 * Residuals (documented, none changes a verdict for a schema-valid context):
 *
 * 1. Python recursion in `strings()` raises `RecursionError` on nesting beyond
 *    the interpreter limit; this port recurses too and fails with the
 *    engine's own stack error. JSON read by the production parser is
 *    depth-bounded well before either limit.
 * 2. The patch is byte-faithful, but the shared scanners parse it
 *    differently: Python `secret_scan_diff` uses `splitlines()` and the TS
 *    `makeRepairScan` splits on LF only. Content lines never differ (they are
 *    already `splitlines()` output), so only the path can. With a Python
 *    line-break character in the path, Python loses the path from the
 *    synthetic `diff --git` header and never flags the hunk. On the pinned
 *    `real` vectors the TS scanner agrees for LF, CR, CRLF, U+2028, U+2029 and a
 *    forged `+++ b/node_modules/...` header line, and is stricter (it flags the
 *    hunk) for VT, FF, FS, GS, RS and NEL; this is not a general claim for
 *    other paths. The stricter set is `TS_STRICTER` in the test. A schema-valid context path comes from the
 *    repository tree, never from the judge.
 */
import { JsonObject, type JsonValue } from './jsonValue.js';
import { pythonIsSpace, pythonTruthy } from './repairBinding.js';
import { pythonSplitlines } from './repairGates.js';

/** `triage.error_reason`'s default `limit`. */
const ERROR_REASON_LIMIT = 300;

const DEFAULT_PATH = 'triage-context.txt';

/** Python would raise uncaught on a structurally damaged context. */
export class TriageContextScanRefusal extends Error {
  override readonly name = 'TriageContextScanRefusal';
}

/**
 * `triage.ContextScanError`: the scan policy could not be read or parsed, so
 * the judge defers without losing its plans. `reason` is one bounded line that
 * names the cause and never the scanned content.
 */
export class ContextScanError extends Error {
  override readonly name = 'ContextScanError';
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * What the scanner seam throws for the Python `OSError`/`RuntimeError`
 * family (an unreadable or unparsable scan policy, a failed denylist read).
 * `pythonType` is the exception class name, used only when the message is
 * empty (`error_reason`'s fallback).
 */
export class TriageScanPolicyFailure extends Error {
  override readonly name = 'TriageScanPolicyFailure';
  readonly pythonType: string;

  constructor(pythonType: string, message: string) {
    super(message);
    this.pythonType = pythonType;
  }
}

/**
 * The scanner seam: `crq.secret_scan_diff(diff, output)[0]`. Returns whether
 * the patch is clean. Throws {@link TriageScanPolicyFailure} for the
 * `OSError`/`RuntimeError` family; any other throw propagates.
 */
export type TriageContextScanner = (patch: string) => Promise<boolean> | boolean;

/**
 * `triage.error_reason`: `' '.join(str(exc).split())[:limit] or
 * type(exc).__name__`, with Python's whitespace and code-point slicing.
 */
export function errorReason(
  message: string,
  pythonType: string,
  limit: number = ERROR_REASON_LIMIT,
): string {
  const words: string[] = [];
  let word = '';
  for (const character of message) {
    const codePoint = character.codePointAt(0) as number;
    if (pythonIsSpace(codePoint)) {
      if (word !== '') words.push(word);
      word = '';
    } else {
      word += character;
    }
  }
  if (word !== '') words.push(word);
  const joined = [...words.join(' ')].slice(0, limit).join('');
  return joined === '' ? pythonType : joined;
}

/** `triage_context_safe.strings`: every string value, in document order. */
function* strings(value: JsonValue): Generator<string> {
  if (typeof value === 'string') {
    yield value;
  } else if (value instanceof JsonObject) {
    for (const [, item] of value.entries) yield* strings(item);
  } else if (Array.isArray(value)) {
    for (const item of value) yield* strings(item);
  }
}

function contextPath(context: JsonObject): string {
  const current = context.get('current_path');
  if (pythonTruthy(current)) return pathText(current as JsonValue);
  if (!context.has('finding')) {
    throw new TriageContextScanRefusal("context has no 'finding' and no current_path (KeyError)");
  }
  const finding = context.get('finding');
  if (!(finding instanceof JsonObject)) {
    throw new TriageContextScanRefusal('context finding is not an object (AttributeError)');
  }
  const fromFinding = finding.get('path');
  if (pythonTruthy(fromFinding)) return pathText(fromFinding as JsonValue);
  return DEFAULT_PATH;
}

function pathText(value: JsonValue): string {
  if (typeof value !== 'string') {
    throw new TriageContextScanRefusal('context path is truthy but not a string (TypeError)');
  }
  return value;
}

/**
 * The synthetic patch `triage_context_safe` hands the scanner, byte for byte:
 * `diff --git a/P b/P`, one `@@ -0,0 +1 @@` hunk header (always `+1`, as
 * Python writes it; there is no `---`/`+++` pair), then every
 * `str.splitlines()` line of the `'\n'`-joined string values prefixed with
 * `+`, then a final newline.
 */
export function triageContextScanPatch(context: JsonValue): string {
  if (!(context instanceof JsonObject)) {
    throw new TriageContextScanRefusal('triage context is not an object (AttributeError)');
  }
  const content = [...strings(context)].join('\n');
  const path = contextPath(context);
  const lines = pythonSplitlines(content).map((line) => `+${line}`);
  return `diff --git a/${path} b/${path}\n@@ -0,0 +1 @@\n${lines.join('\n')}\n`;
}

/**
 * `triage_context_scan`: build the patch, ask the scanner, and return its
 * clean verdict. A {@link TriageScanPolicyFailure} becomes a typed
 * {@link ContextScanError} whose `reason` is `error_reason(cause)`; a damaged
 * context throws {@link TriageContextScanRefusal} before the scanner runs.
 */
export async function triageContextScan(
  context: JsonValue,
  scanner: TriageContextScanner,
): Promise<boolean> {
  const patch = triageContextScanPatch(context);
  try {
    return await scanner(patch);
  } catch (error) {
    if (error instanceof TriageScanPolicyFailure) {
      throw new ContextScanError(errorReason(error.message, error.pythonType));
    }
    throw error;
  }
}
